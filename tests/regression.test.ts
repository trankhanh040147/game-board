/**
 * Regression guards requested by the Lead / found during the first QA passes.
 * Each test pins a specific bug so it cannot silently return.
 */
import { describe, expect, it } from 'vitest';
import { RULES, LIMITS } from '../src/sim/config';
import { capitalOf, totalPopulation, stockOf, techsAvailable } from '../src/sim/core';
import { createCitizen } from '../src/sim/state';
import { tick } from '../src/sim/tick';
import { placeBuilding, startExpedition, foundSettlementAt } from '../src/sim/actions';
import { Rng } from '../src/sim/rng';
import { Autoplay } from '../tools/autoplay';
import { makeContent, nanPaths, newGame, runAutoplay, runIdle, stockEntries } from './helpers';
import type { ActionContext } from '../src/sim/actions';
import type { GameState } from '../src/sim/types';

const content = makeContent();
const ctx = (state: GameState): ActionContext => ({ state, content, rules: RULES });

function placeCompleted(state: GameState, id: string): boolean {
  const cap = capitalOf(state)!;
  const def = content.buildings[id];
  if (!def) return false;
  for (const res of Object.keys(def.cost)) cap.stock[res] = Math.max(cap.stock[res] ?? 0, (def.cost[res] ?? 0) + 40);
  const ap = new Autoplay();
  const pos = ap.findPlacement(ctx(state), def, cap);
  if (!pos) return false;
  const res = placeBuilding(ctx(state), id, pos.x, pos.y, cap.id);
  if (!res.ok) return false;
  const b = state.buildings.find((x) => x.typeId === id);
  if (!b) return false;
  b.progress = 1;
  b.builtTick = state.tick;
  return true;
}

describe('regression: starting economy', () => {
  it('starting stock is not destroyed on day 1 (new game is playable)', () => {
    const state = newGame('reg-start');
    runIdle(state, 1);
    const cap = capitalOf(state)!;
    // RULES.startingResources = berries 16, wood 24, stone 10, fiber 5.
    expect(stockOf(cap, 'wood'), 'starting wood destroyed on day 1').toBeGreaterThanOrEqual(20);
    expect(stockOf(cap, 'stone'), 'starting stone destroyed on day 1').toBeGreaterThanOrEqual(9);
    expect(stockOf(cap, 'berries'), 'starting food destroyed on day 1').toBeGreaterThanOrEqual(13);
    expect(stockOf(cap, 'fiber')).toBeGreaterThanOrEqual(4);
    expect(cap.storageCap, 'base storage must fit starting resources').toBeGreaterThanOrEqual(55);
  });

  it('with one building placed, enough starting wood remains for the next step', () => {
    const state = newGame('reg-start-2');
    const ap = new Autoplay();
    for (let i = 0; i < 2; i++) {
      ap.run(state, content);
      tick(state, content, RULES);
    }
    const cap = capitalOf(state)!;
    expect(stockOf(cap, 'wood'), `wood=${stockOf(cap, 'wood')} after ${ap.stats.placed.length} building(s)`).toBeGreaterThanOrEqual(15);
  });

  it('storage overflow is a slow bleed (<= 15% of stock per day)', () => {
    const state = newGame('reg-overflow');
    const cap = capitalOf(state)!;
    cap.stock.wood = 500; // 8x over the base cap
    runIdle(state, 1);
    const lost = 500 - stockOf(cap, 'wood');
    expect(lost / 500, `lost ${lost.toFixed(1)} of 500 wood in one day`).toBeLessThanOrEqual(0.15);
  });

  it('no negative stocks after 120 autoplay days', () => {
    const state = newGame('reg-negative');
    runAutoplay(state, 120);
    const bad = stockEntries(state).filter((e) => e.amount < -1e-6);
    expect(bad.slice(0, 10)).toEqual([]);
    expect(nanPaths(state)).toEqual([]);
  });
});

describe('regression: research gating', () => {
  it('no tech completes automatically unless flags.auto_research === 1', () => {
    const state = newGame('reg-research');
    runIdle(state, 20);
    expect(Object.keys(state.research.completed), 'techs auto-completed without the auto_research flag').toEqual([]);
    // Even when insight is plentiful.
    state.research.insight = 500;
    runIdle(state, 20);
    expect(Object.keys(state.research.completed), 'techs auto-completed with insight but no flag').toEqual([]);
  });

  it('auto_research=1 lets the scholars study available techs', () => {
    const state = newGame('reg-research-2');
    state.flags.auto_research = 1;
    state.research.insight = 500;
    runIdle(state, 40);
    expect(Object.keys(state.research.completed).length, 'no tech studied even with auto_research=1').toBeGreaterThan(0);
  });

  it('the tech tree is reachable from the start (era-0 techs available)', () => {
    const state = newGame('reg-tech-tree');
    const available = techsAvailable(state, content);
    expect(available.length, 'no techs available at game start').toBeGreaterThan(0);
    expect(available.some((t) => t.era === 0)).toBe(true);
  });
});

describe('regression: market gates', () => {
  it('autoTrade does nothing without a completed market or trade post', () => {
    const state = newGame('reg-market');
    runIdle(state, 3);
    const cap = capitalOf(state)!;
    expect(state.market.tradeBalance, 'market traded without a market building').toBe(0);
    expect(stockOf(cap, 'stone'), 'stone was auto-sold without a market').toBeGreaterThanOrEqual(9);
    expect(stockOf(cap, 'wood'), 'wood was auto-sold without a market').toBeGreaterThanOrEqual(20);
  });
});

describe('regression: water service', () => {
  it('a completed well fills the water store (~6/day service, not worker-scaled)', () => {
    const state = newGame('reg-well');
    const cap = capitalOf(state)!;
    expect(placeCompleted(state, 'well'), 'could not place a well near the capital').toBe(true);
    // The well takes a few days to come online; then it fills stores at roughly
    // its 6/day service rate until demand is covered and the store tops out.
    runIdle(state, 7);
    const water = stockOf(cap, 'water');
    const expected = content.buildings['well']?.service?.amount ?? 6;
    expect(water, `well produced only ${water.toFixed(1)} water in 7 days (service ${expected}/day)`).toBeGreaterThanOrEqual(expected * 1.5);
    expect(cap.waterDays, 'well exists but waterDays is still ~0').toBeGreaterThan(3);
  });
});

describe('regression: growth + era targets (balance budget)', () => {
  it('population > 2 by day 60 under competent autoplay', () => {
    const state = newGame('reg-growth');
    runAutoplay(state, 60);
    expect(totalPopulation(state), 'population never grew past the founder + companion under competent play').toBeGreaterThan(2);
  });

  it('era 1 reached by day 100 under competent autoplay', () => {
    const state = newGame('reg-era');
    runAutoplay(state, 100);
    expect(state.research.era, `era reached by day 100: ${state.research.era} (era1 needs population 20)`).toBeGreaterThanOrEqual(1);
  });

  it('no starvation deaths in the first 60 days under competent autoplay', () => {
    const state = newGame('reg-starve');
    runAutoplay(state, 60);
    expect(state.stats.citizensStarved, 'citizens starved in the first 60 days').toBe(0);
  });
});

describe('regression: settlement founding via settle expedition', () => {
  it('a settle party that arrives sets ready flags; founding the site creates a second settlement', () => {
    const state = newGame('reg-settle');
    const cap = capitalOf(state)!;
    const rng = new Rng([...state.rng] as [number, number, number, number]);
    for (let i = 0; i < 14; i++) createCitizen(state, content, rng, { settlementId: cap.id, age: 20 + (i % 12) });
    // Population is recounted by the simulation each day; let it settle before
    // the expedition check (which requires >= 10 people).
    runIdle(state, 1);
    cap.stock.berries = 200;
    cap.stock.preserved_food = 100;
    cap.stock.wood = 200;
    cap.stock.stone = 100;
    // Pick a flat, claimable target ~7 tiles from the capital.
    let target: { x: number; y: number } | null = null;
    for (let dy = -8; dy <= 8 && !target; dy++) {
      for (let dx = -8; dx <= 8 && !target; dx++) {
        if (Math.hypot(dx, dy) < 5 || Math.hypot(dx, dy) > 8) continue;
        const t = state.world.tiles[(cap.y + dy) * state.world.width + (cap.x + dx)];
        const biome = t ? content.biomes[t.biome] : null;
        if (t && t.buildingId < 0 && biome && biome.walkCost < 20 && t.water < 0.4) target = { x: cap.x + dx, y: cap.y + dy };
      }
    }
    expect(target, 'no valid settle target near capital').toBeTruthy();
    const res = startExpedition(ctx(state), 'settle', target!.x, target!.y);
    expect(res.ok, `startExpedition failed: ${res.message}`).toBe(true);

    let days = 0;
    while (state.flags['exploration.settleReadyX'] === undefined && days < 90) {
      tick(state, content, RULES);
      days++;
    }
    expect(state.flags['exploration.settleReadyX'], 'settle party never arrived').toBeDefined();
    const rx = Math.round(state.flags['exploration.settleReadyX']);
    const ry = Math.round(state.flags['exploration.settleReadyY']);
    // This mirrors src/app.ts: consume the flags and found the settlement.
    delete state.flags['exploration.settleReadyX'];
    delete state.flags['exploration.settleReadyY'];
    delete state.flags['exploration.settleReadyTick'];
    const founded = foundSettlementAt(ctx(state), rx, ry, cap.id);
    expect(founded, 'foundSettlementAt refused a site the settlement party prepared').toBeTruthy();
    expect(state.settlements.length).toBeGreaterThanOrEqual(2);
    expect(nanPaths(state)).toEqual([]);
  });
});

describe('regression: invariants', () => {
  it('population never exceeds the detailed-simulation cap plus cohorts', () => {
    const state = newGame('reg-cap');
    runAutoplay(state, 120);
    const detailed = state.citizens.filter((c) => c.alive).length;
    const cohortCount = state.cohorts.reduce((a, c) => a + c.count, 0);
    expect(detailed).toBeLessThanOrEqual(RULES.detailedCitizenCap + 32);
    expect(totalPopulation(state)).toBeLessThanOrEqual(6000);
    expect(cohortCount).toBeGreaterThanOrEqual(0);
    expect(LIMITS.maxCitizens).toBeGreaterThan(0);
  });
});
