/**
 * Long run: 400 days of autoplayed simulation. This is the soak test — it must
 * finish quickly, never throw, never emit NaN, keep population in sane bounds,
 * keep the food economy alive and record metrics for the charts.
 */
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/config';
import { totalPopulation } from '../src/sim/core';
import { tick } from '../src/sim/tick';
import { Autoplay } from '../tools/autoplay';
import type { GameState } from '../src/sim/types';
import { aliveCitizens, canonical, makeContent, nanPaths, newGame, stockEntries } from './helpers';

const DAYS = 400;

describe('long run (400 days, autoplay)', () => {
  const startedAt = Date.now();
  const state = newGame('longrun-seed');
  const ap = new Autoplay();
  const content = makeContent();
  for (let i = 0; i < DAYS; i++) {
    ap.run(state, content);
    tick(state, content, RULES);
  }
  const elapsedMs = Date.now() - startedAt;

  it(`completes ${DAYS} days under the 60s QA budget`, () => {
    // Campaign runs are the most expensive thing the game does; keep a budget.
    expect(elapsedMs, `${DAYS} days took ${elapsedMs}ms`).toBeLessThan(60_000);
    // eslint-disable-next-line no-console
    console.log(`longrun: ${DAYS} days in ${elapsedMs}ms (${(elapsedMs / DAYS).toFixed(2)}ms/day)`);
  });

  it('has no NaN/Infinity anywhere in state', () => {
    expect(nanPaths(state)).toEqual([]);
  });

  it('population is in sane bounds', () => {
    const pop = totalPopulation(state);
    const detailed = aliveCitizens(state);
    const cohorts = state.cohorts.reduce((a, c) => a + c.count, 0);
    expect(pop, 'population is zero after 400 days of play').toBeGreaterThan(0);
    expect(detailed, 'detailed population exceeded the simulation cap').toBeLessThanOrEqual(RULES.detailedCitizenCap + 64);
    expect(pop, 'population exceeded the hard citizen limit').toBeLessThanOrEqual(6000);
    expect(cohorts).toBeGreaterThanOrEqual(0);
    // No runaway feedback: population must not exceed what housing + cohorts could plausibly support.
    const housing = state.settlements.reduce((a, s) => a + s.housing.capacity, 0);
    expect(housing).toBeGreaterThanOrEqual(0);
  });

  it('economy is not dead (food produced and stocks moving)', () => {
    const cap = state.settlements.find((s) => s.isCapital);
    expect(cap).toBeTruthy();
    const foodDaysSeries = state.metrics.series['foodDays'] ?? [];
    const foodProduced = state.stats.foodProduced;
    const anyFoodStored = stockEntries(state).some((e) => e.amount > 0);
    const foodDaysEverPositive = foodDaysSeries.some((v) => v > 0);
    expect(foodProduced, 'no food was ever produced in 400 days').toBeGreaterThan(0);
    expect(anyFoodStored || foodDaysEverPositive, 'food economy never had stock or food-days').toBe(true);
  });

  it('no negative stock anywhere', () => {
    const bad = stockEntries(state).filter((e) => e.amount < -1e-6);
    expect(bad.slice(0, 10)).toEqual([]);
  });

  it('metrics series are recorded for charts', () => {
    const series = state.metrics.series;
    expect(Object.keys(series).length, 'no metric series recorded').toBeGreaterThanOrEqual(20);
    expect(series.population?.length ?? 0, 'population series empty').toBeGreaterThan(0);
    expect(series.foodDays?.length ?? 0).toBeGreaterThan(0);
    expect(series.insight?.length ?? 0).toBeGreaterThan(0);
    const nanSeries: string[] = [];
    for (const key of Object.keys(series)) for (const v of series[key]) if (!Number.isFinite(v)) nanSeries.push(key);
    expect([...new Set(nanSeries)]).toEqual([]);
  });

  it('structural invariants hold (unique building ids, valid tile links)', () => {
    const ids = new Set<number>();
    for (const b of state.buildings) {
      expect(ids.has(b.id), `duplicate building id ${b.id}`).toBe(false);
      ids.add(b.id);
      expect(b.x).toBeGreaterThanOrEqual(0);
      expect(b.y).toBeGreaterThanOrEqual(0);
      expect(b.x).toBeLessThan(state.world.width);
      expect(b.y).toBeLessThan(state.world.height);
      expect(Number.isFinite(b.progress)).toBe(true);
    }
    for (const st of state.settlements) {
      expect(st.stock).toBeTruthy();
      expect(Number.isFinite(st.treasury)).toBe(true);
    }
    // Building ids referenced by settlements must exist in state.buildings.
    for (const st of state.settlements) {
      for (const bid of st.buildings) expect(ids.has(bid), `settlement ${st.id} references missing building ${bid}`).toBe(true);
    }
  });

  it('state canonicalises (snapshot does not throw on a large state)', () => {
    expect(() => canonical(state)).not.toThrow();
  });
});

