/**
 * Early game: a scripted player must be able to build a working settlement in
 * the first ~4 months, and the simulation must survive degenerate inputs
 * (zero population, tiny world, idle player) without throwing or emitting NaN.
 */
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/config';
import { totalPopulation } from '../src/sim/core';
import { createNewGame } from '../src/sim/state';
import { tick } from '../src/sim/tick';
import { Autoplay } from '../tools/autoplay';
import { aliveCitizens, makeContent, nanPaths, newGame, runAutoplay, runIdle, stockEntries } from './helpers';

describe('early game (scripted player)', () => {
  const state = newGame('early-seed');
  const ap = runAutoplay(state, 120);

  it('survives 120 days with no exceptions and no NaN', () => {
    expect(nanPaths(state)).toEqual([]);
  });

  it('population grows past the single founder', () => {
    const pop = totalPopulation(state);
    expect(pop, `population did not grow (autoplay placed ${ap.stats.placed.length} buildings)`).toBeGreaterThan(1);
    expect(aliveCitizens(state)).toBeGreaterThan(1);
  });

  it('player can build and research (actions actually took effect)', () => {
    const completed = state.buildings.filter((b) => b.progress >= 1).length;
    expect(ap.stats.placed.length, 'autoplay could not place a single building').toBeGreaterThan(3);
    expect(completed, 'no completed buildings after 120 days').toBeGreaterThan(2);
    expect(Object.keys(state.research.completed).length, 'no tech researched in 120 days').toBeGreaterThan(0);
    expect(ap.stats.techsChosen).toBeGreaterThan(0);
  });

  it('food economy is alive (some food produced or stored)', () => {
    const cap = state.settlements.find((s) => s.isCapital);
    expect(cap).toBeTruthy();
    const stored = stockEntries(state);
    expect(stored.length).toBeGreaterThan(0);
    const foodProduced = state.stats.foodProduced;
    const edibleStored = stored.some((e) => e.amount > 0);
    expect(foodProduced > 0 || edibleStored, `foodProduced=${foodProduced}, no edible stock`).toBe(true);
  });

  it('numeric ranges are sane: health/morale 0..100, stock non-negative', () => {
    const bad: string[] = [];
    for (const c of state.citizens) {
      if (!c.alive) continue;
      if (c.health < 0 || c.health > 100) bad.push(`citizen ${c.id} health=${c.health}`);
      if (c.morale < 0 || c.morale > 100) bad.push(`citizen ${c.id} morale=${c.morale}`);
      if (c.hunger < -1 || c.hunger > 101) bad.push(`citizen ${c.id} hunger=${c.hunger}`);
    }
    for (const e of stockEntries(state)) if (e.amount < -1e-6) bad.push(`stock ${e.resource}=${e.amount}`);
    for (const st of state.settlements) {
      if (st.population < 0) bad.push(`settlement ${st.id} population=${st.population}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
});

describe('degenerate inputs', () => {
  it('idle player (no actions) survives 60 days', () => {
    const state = newGame('idle-seed');
    runIdle(state, 60);
    expect(nanPaths(state)).toEqual([]);
    expect(totalPopulation(state)).toBeGreaterThanOrEqual(0);
  });

  it('zero population does not crash or NaN the state', () => {
    const state = newGame('dead-seed');
    for (const c of state.citizens) c.alive = false;
    runIdle(state, 40);
    expect(nanPaths(state)).toEqual([]);
    expect(totalPopulation(state)).toBe(0);
  });

  it('tiny world (48x48) survives 60 days of autoplay', () => {
    const content = makeContent();
    const state = createNewGame(content, { seed: 'tiny-seed', width: 48, height: 48 });
    const ap = new Autoplay();
    for (let i = 0; i < 60; i++) {
      ap.run(state, content);
      tick(state, content, RULES);
    }
    expect(nanPaths(state)).toEqual([]);
    expect(totalPopulation(state)).toBeGreaterThanOrEqual(0);
  });
});
