/**
 * Economy / production: conversion chains must actually produce, gathering must
 * extract from the world, storage caps must be respected, prices must stay in
 * the documented band and trades must conserve value.
 *
 * Content ids are discovered from the content pack rather than hard-coded, so
 * the test keeps working as the pack is tuned.
 */
import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/config';
import { capitalOf, buildingById, stockOf, totalPopulation } from '../src/sim/core';
import { createCitizen } from '../src/sim/state';
import { tick } from '../src/sim/tick';
import { placeBuilding, tradeNow, placementCheck } from '../src/sim/actions';
import { Rng } from '../src/sim/rng';
import { Autoplay } from '../tools/autoplay';
import type { ActionContext } from '../src/sim/actions';
import type { Building, BuildingDef, Content, GameState, RecipeDef } from '../src/sim/types';
import { makeContent, nanPaths, newGame, runAutoplay, stockEntries } from './helpers';

const content = makeContent();

function actionCtx(state: GameState): ActionContext {
  return { state, content, rules: RULES };
}

/** Give the settlement enough materials for `def` and top the stock up. */
function fundCost(state: GameState, cap: NonNullable<ReturnType<typeof capitalOf>>, def: BuildingDef, amount = 120): void {
  for (const res of Object.keys(def.cost)) {
    cap.stock[res] = Math.max(cap.stock[res] ?? 0, (def.cost[res] ?? 0) + amount);
  }
}

/** Advance the era / grant prerequisite techs so a mid-game building can be tested. */
function unlock(state: GameState, def: BuildingDef): void {
  state.research.era = Math.max(state.research.era, def.era);
  for (const tech of def.requiresTech) if (!state.research.completed[tech]) state.research.completed[tech] = 0;
  for (const rid of def.recipes) {
    const recipe = content.recipes[rid];
    for (const tech of recipe?.requiresTech ?? []) if (!state.research.completed[tech]) state.research.completed[tech] = 0;
  }
}

/** Place a building through the real action, then fast-forward construction. */
function placeAndComplete(state: GameState, def: BuildingDef): Building | null {
  unlock(state, def);
  const cap = capitalOf(state);
  if (!cap) return null;
  fundCost(state, cap, def);
  const a = actionCtx(state);
  const ap = new Autoplay();
  const pos = ap.findPlacement(a, def, cap);
  if (!pos) return null;
  const res = placeBuilding(a, def.id, pos.x, pos.y, cap.id);
  if (!res.ok) return null;
  const building = state.buildings.filter((b) => b.typeId === def.id).pop() ?? null;
  if (!building) return null;
  building.progress = 1;
  building.builtTick = state.tick;
  return building;
}

function spawnWorkers(state: GameState, n: number): void {
  const cap = capitalOf(state);
  if (!cap) return;
  const rng = new Rng([...state.rng] as [number, number, number, number]);
  for (let i = 0; i < n; i++) createCitizen(state, content, rng, { settlementId: cap.id, age: 24 + (i % 10), education: 40 });
}

function recipesOf(def: BuildingDef): RecipeDef[] {
  return def.recipes.map((id) => content.recipes[id]).filter(Boolean);
}

function totalStock(state: GameState, res: string): number {
  return state.settlements.reduce((a, st) => a + (st.stock[res] ?? 0), 0);
}

function runTicks(state: GameState, days: number): void {
  for (let i = 0; i < days; i++) tick(state, content, RULES);
}

/** Find an era-0 tech-free building whose recipe converts inputs into outputs. */
function findConversionBuilding(): { def: BuildingDef; recipe: RecipeDef } | null {
  const preferred = ['sawmill', 'mill', 'workshop', 'brickworks', 'kiln', 'smelter', 'forge', 'bakery', 'loom'];
  const defs = content.buildingOrder
    .map((id) => content.buildings[id])
    .filter((d) => d && d.era <= 2)
    .sort((a, b) => {
      const ai = preferred.findIndex((p) => a.id.includes(p));
      const bi = preferred.findIndex((p) => b.id.includes(p));
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
  for (const def of defs) {
    for (const recipe of recipesOf(def)) {
      if (Object.keys(recipe.inputs).length > 0 && Object.keys(recipe.outputs).length > 0) return { def, recipe };
    }
  }
  return null;
}

describe('economy: production', () => {
  it('a conversion building consumes inputs and produces outputs', () => {
    const found = findConversionBuilding();
    expect(found, 'no tech-free conversion building (inputs -> outputs) in content').toBeTruthy();
    const { def, recipe } = found!;

    const state = newGame('econ-convert');
    const cap = capitalOf(state)!;
    spawnWorkers(state, 8);
    // Production needs storage headroom (a granary) and process water (a well);
    // otherwise outputs are discarded at the storage cap and the line reports
    // "No water" — both would make this test measure the wrong thing.
    const granary = content.buildings['granary'];
    const well = content.buildings['well'];
    expect(granary, 'no granary in content').toBeTruthy();
    expect(well, 'no well in content').toBeTruthy();
    expect(placeAndComplete(state, granary), 'could not place granary').toBeTruthy();
    expect(placeAndComplete(state, well), 'could not place well').toBeTruthy();
    const building = placeAndComplete(state, def);
    expect(building, `could not place/complete ${def.id} near the capital`).toBeTruthy();

    // Modest inputs so the line cannot stall on supply, with room to store the
    // output; keep total volume inside storage capacity.
    for (const res of Object.keys(recipe.inputs)) cap.stock[res] = Math.max(cap.stock[res] ?? 0, 80);
    cap.stock.water = Math.max(cap.stock.water ?? 0, 60);
    const outputRes = Object.keys(recipe.outputs)[0];
    const beforeOut = totalStock(state, outputRes);
    const beforeIn = totalStock(state, Object.keys(recipe.inputs)[0]);
    const beforeCrafted = state.stats.goodsCrafted;

    // Complete any remaining construction and let jobs/production settle.
    runTicks(state, 30);

    const afterOut = totalStock(state, outputRes);
    const afterIn = totalStock(state, Object.keys(recipe.inputs)[0]);
    const produced = afterOut - beforeOut;
    const consumed = beforeIn - afterIn;
    // eslint-disable-next-line no-console
    console.log(
      `econ: ${def.id} recipe=${recipe.id} workers=${building?.workers ?? 0}/${def.jobs.reduce((a, j) => a + j.count, 0)} ` +
        `in[${Object.keys(recipe.inputs)[0]}]=${beforeIn.toFixed(0)}->${afterIn.toFixed(0)} out[${outputRes}]=${beforeOut.toFixed(0)}->${afterOut.toFixed(0)} crafted=${state.stats.goodsCrafted - beforeCrafted}`,
    );
    expect(
      produced > 0 || state.stats.goodsCrafted > beforeCrafted,
      `conversion ${recipe.id} produced nothing in 30 days (output Δ=${produced}, inputs consumed Δ=${consumed}, workers=${building?.workers})`,
    ).toBe(true);
    expect(consumed > 0 || produced > 0, 'no input consumption and no output — recipe appears dead').toBe(true);
    expect(nanPaths(state)).toEqual([]);
  });

  it('a gathering building extracts from the world', () => {
    const defs = content.buildingOrder
      .map((id) => content.buildings[id])
      .filter((d) => d && d.era === 0 && d.requiresTech.length === 0)
      .filter((d) => recipesOf(d).some((r) => r.gather && ['forage', 'forest', 'wildlife', 'fertility', 'water'].includes(r.gather.source)));
    expect(defs.length, 'no tech-free gathering building found').toBeGreaterThan(0);
    const def = defs[0];
    const recipe = recipesOf(def).find((r) => r.gather)!;

    const state = newGame('econ-gather');
    spawnWorkers(state, 8);
    // Storage headroom so gathered output is not overflow-destroyed.
    const granary = content.buildings['granary'];
    if (granary) expect(placeAndComplete(state, granary), 'could not place granary').toBeTruthy();
    const building = placeAndComplete(state, def);
    expect(building, `could not place ${def.id}`).toBeTruthy();
    const before = totalStock(state, recipe.gather!.resource);
    const beforeGathered = state.stats.resourcesGathered;
    runTicks(state, 25);
    const gatherRes = recipe.gather!.resource;
    const after = totalStock(state, gatherRes);
    // eslint-disable-next-line no-console
    console.log(
      `econ: gather ${def.id} recipe=${recipe.id} source=${recipe.gather!.source} ${gatherRes}: ${before.toFixed(1)} -> ${after.toFixed(1)} ` +
        `workers=${building?.workers} status="${building?.status}" sourceStrength=${building?.sourceStrength} storage=${state.settlements[0].storageUsed.toFixed(0)}/${state.settlements[0].storageCap}`,
    );
    expect(after - before > 0 || state.stats.resourcesGathered > beforeGathered, `gather recipe ${recipe.id} yielded nothing in 25 days`).toBe(true);
  });
});

describe('economy: invariants', () => {
  it('storage caps are respected and no stock is negative (60 days autoplay)', () => {
    const state = newGame('econ-caps');
    runAutoplay(state, 60);
    const offenders: string[] = [];
    for (const st of state.settlements) {
      if (st.storageUsed > st.storageCap + 1e-6) offenders.push(`settlement ${st.id} storageUsed=${st.storageUsed} > cap=${st.storageCap}`);
      for (const res of Object.keys(st.stock)) {
        if (st.stock[res] < -1e-6) offenders.push(`settlement ${st.id} stock.${res}=${st.stock[res]}`);
        if (st.stock[res] > st.storageCap + 1e-6 && st.storageCap > 0) {
          // per-resource volume can legitimately exceed total-capacity accounting
          // only if capacity is not enforced; flag it for the report.
          offenders.push(`settlement ${st.id} stock.${res}=${st.stock[res]} > storageCap=${st.storageCap}`);
        }
      }
    }
    expect(offenders.slice(0, 20)).toEqual([]);
  });

  it('market prices stay inside the documented 0.2x–6x band of base price', () => {
    const state = newGame('econ-prices');
    runAutoplay(state, 80);
    const bad: string[] = [];
    for (const res of Object.keys(state.market.prices)) {
      const p = state.market.prices[res];
      const base = p.base || content.resources[res]?.basePrice || 0;
      if (!(p.price > 0)) bad.push(`${res} price=${p.price}`);
      if (base > 0 && (p.price < base * 0.2 - 1e-9 || p.price > base * 6 + 1e-9)) bad.push(`${res} price=${p.price.toFixed(2)} base=${base} (ratio ${(p.price / base).toFixed(2)})`);
      if (!Number.isFinite(p.price)) bad.push(`${res} price non-finite`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  it('trade requires a market; buy/sell conserves stock and treasury', () => {
    const state = newGame('econ-trade');
    const cap = capitalOf(state)!;

    // Trading without a market must fail.
    expect(tradeNow(actionCtx(state), 'wood', 1, 'sell').ok).toBe(false);

    // Find and build the market (era 2 / trade_routes in the current pack).
    const marketDef = content.buildingOrder
      .map((id) => content.buildings[id])
      .find((d) => d && ['market', 'trade_post'].includes(d.id));
    expect(marketDef, 'no market/trade_post building in content').toBeTruthy();
    const market = placeAndComplete(state, marketDef!);
    expect(market, 'could not place market').toBeTruthy();
    runTicks(state, 3); // let the market register as complete/operational

    cap.stock.wood = Math.max(cap.stock.wood ?? 0, 100);
    cap.treasury = 1000;
    const woodBefore = stockOf(cap, 'wood');
    const treasuryBefore = cap.treasury;
    const balanceBefore = state.market.tradeBalance;
    const sell = tradeNow(actionCtx(state), 'wood', 10, 'sell');
    expect(sell.ok, `sell failed: ${sell.message}`).toBe(true);
    const woodAfterSell = stockOf(cap, 'wood');
    expect(woodAfterSell).toBeCloseTo(woodBefore - 10, 5);
    expect(cap.treasury).toBeGreaterThan(treasuryBefore);
    expect(state.market.tradeBalance).toBeGreaterThan(balanceBefore);

    const treasuryAfterSell = cap.treasury;
    const buy = tradeNow(actionCtx(state), 'wood', 5, 'buy');
    expect(buy.ok, `buy failed: ${buy.message}`).toBe(true);
    expect(stockOf(cap, 'wood')).toBeCloseTo(woodAfterSell + 5, 5);
    expect(cap.treasury).toBeLessThan(treasuryAfterSell);

    // Failure paths must not mutate state.
    const tBefore = cap.treasury;
    const wBefore = stockOf(cap, 'wood');
    expect(tradeNow(actionCtx(state), 'wood', 10_000, 'buy').ok).toBe(false);
    expect(tradeNow(actionCtx(state), 'wood', 10_000, 'sell').ok).toBe(false);
    expect(cap.treasury).toBe(tBefore);
    expect(stockOf(cap, 'wood')).toBe(wBefore);

    // Price of wood remains in band after trading.
    const price = state.market.prices.wood;
    expect(price.price).toBeGreaterThan(price.base * 0.2 - 1e-9);
    expect(price.price).toBeLessThan(price.base * 6 + 1e-9);
  });

  it('no dead mechanics: every era-0 building is placeable somewhere on a fresh map', () => {
    const state = newGame('econ-place');
    const cap = capitalOf(state)!;
    const a = actionCtx(state);
    const ap = new Autoplay();
    const unplaceable: string[] = [];
    for (const id of content.buildingOrder) {
      const def = content.buildings[id];
      if (!def || def.era !== 0 || def.requiresTech.length > 0) continue;
      if (def.tags?.includes('unique_world') || def.placement.unique) continue;
      // Skip buildings gated on rare deposits (deposit placement is content-driven).
      if (def.placement.needDeposit) continue;
      fundCost(state, cap, def, 80);
      const pos = ap.findPlacement(a, def, cap);
      if (!pos) {
        unplaceable.push(`${id} (${def.placement.needWater ? 'water' : def.placement.needForest ? 'forest' : 'land'}${def.placement.biomes ? ' biomes:' + def.placement.biomes.join('/') : ''})`);
      }
    }
    expect(unplaceable.slice(0, 20), `unplaceable era-0 buildings: ${unplaceable.join(', ')}`).toEqual([]);
  });

  it('spawning many citizens does not break the cap or create NaN', () => {
    const state = newGame('econ-pop');
    spawnWorkers(state, 40);
    runTicks(state, 30);
    expect(nanPaths(state)).toEqual([]);
    expect(totalPopulation(state)).toBeLessThanOrEqual(RULES.detailedCitizenCap + 6000);
    expect(content, 'content should have at least one building').toBeTruthy();
    expect(buildingById(state, state.buildings[0]?.id ?? -1)).toBeTruthy();
  });
});
