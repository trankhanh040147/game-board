/**
 * civ.production — Recipes, extraction and per-building throughput.
 *
 * For every complete, enabled building this system:
 *   1. resolves its recipe (b.recipeId, falling back to the definition's first recipe),
 *   2. computes efficiency from crew, skill, morale, condition, road access,
 *      weather and work/craft modifiers,
 *   3. consumes water / power from the settlement stock,
 *   4. resolves an environment gathering source (forest, forage, wildlife, water,
 *      deposit, fertility, beauty) and depletes it on the world tile,
 *   5. consumes recipe inputs (never below zero; partial runs scale down),
 *   6. adds outputs back to settlement stock, capped by storage capacity (waste
 *      beyond the cap is discarded and occasionally reported).
 *
 * Gathering is the primary yield for extraction recipes; outputs are incidental
 * byproducts and `outputs` may legitimately be empty for pure gathering.
 *
 * Determinism: no Math.random / Date.now. Randomness only via ctx.rng.
 */
import type {
  Building,
  BuildingDef,
  Content,
  GameState,
  GatherSpec,
  ModifierKey,
  RecipeDef,
  ResourceId,
  Settlement,
  SimContext,
  SimSystem,
  Tile,
} from '../../types';
import {
  addStock,
  clamp,
  clamp01,
  hasTech,
  modOf,
  radiusIndices,
  removeStock,
  round1,
  round2,
  stockOf,
  stockTotal,
} from '../../core';
import {
  avgWorkerSkill,
  freeStorageSpace,
  waterBufferTarget,
  countJobSlots,
  energyResourceId,
  isOutdoorBuilding,
  roadAccessOf,
  waterResourceId,
} from './buildings';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

export const PRODUCTION_TUNING = {
  skillFloor: 0.8,
  skillSpan: 0.4,
  moraleFloor: 0.85,
  moraleSpan: 0.3,
  conditionFloor: 0.6,
  conditionSpan: 0.4,
  roadFloor: 0.85,
  roadSpan: 0.3,
  /** Extracted amount multiplier from local source strength (0..1). */
  sourceFloor: 0.6,
  sourceSpan: 0.4,
  minQuality: 0.15,
  maxQuality: 1.9,
  /** Below this fraction of the local source, extraction cannot run. */
  minGatherStrength: 0.04,
  /** Fraction of power need below which the building stops. */
  powerFloorFraction: 0.15,
  /** Fraction of water need below which the building stops. */
  waterFloorFraction: 0.1,
  /** Seasonal penalties for outdoor work. */
  winterOutdoorFactor: 0.65,
  winterFarmFactor: 0.22,
  stormFactor: 0.85,
  droughtFarmFactor: 0.7,
  /** Storage-full notification pacing. */
  wasteNotifyInterval: 25,
  wasteNotifyAmount: 2,
} as const;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const productionSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  const bySettlement = new Map<number, Building[]>();
  for (const b of s.buildings) {
    const arr = bySettlement.get(b.settlementId);
    if (arr) arr.push(b);
    else bySettlement.set(b.settlementId, [b]);
  }
  for (const st of s.settlements) {
    const list = bySettlement.get(st.id);
    if (!list || list.length === 0) continue;
    for (const b of list) runBuilding(ctx, st, b);
  }
};

// ---------------------------------------------------------------------------
// Per-building run
// ---------------------------------------------------------------------------

/**
 * The governor stops over-hoarding raw materials: a pure-extraction building
 * idles once its resource is comfortably stocked, so stone/fiber/ore can never
 * pack the storehouse and starve the timber and food trades of space.
 */
function extractionSurplusCap(ctx: SimContext, st: Settlement, resource: ResourceId): number {
  const cap = Math.max(20, st.storageCap);
  const reserve = Math.max(0, st.governor.reserveMaterials);
  if (resource === 'wood') return Math.max(15, Math.min(cap * 0.5, reserve * 3));
  return Math.max(8, Math.min(cap * 0.3, reserve * 2.5));
}

function runBuilding(ctx: SimContext, st: Settlement, b: Building): void {
  const c = ctx.c;
  const s = ctx.s;
  const def = c.buildings[b.typeId];
  if (!def) {
    b.status = 'Unknown building';
    b.efficiency = 0;
    b.shortages = {};
    return;
  }
  if (b.progress < 1) {
    // Construction is buildings.ts's job.
    b.efficiency = 0;
    return;
  }

  if (!b.enabled) {
    b.status = 'Paused';
    b.efficiency = 0;
    b.shortages = {};
    b.sourceStrength = 0;
    return;
  }
  if (b.condition <= 0.05) {
    b.status = 'Ruined';
    b.efficiency = 0;
    return;
  }

  // Sanity: recipe references survive content edits.
  if (b.recipeId && !c.recipes[b.recipeId]) {
    b.recipeId = def.recipes[0] ?? null;
  }
  const recipe = resolveRecipe(ctx, b, def);
  if (!recipe) {
    // Housing, storage, service and decoration buildings have no recipe.
    b.status = 'Working';
    b.efficiency = 0;
    b.shortages = {};
    b.sourceStrength = 0;
    return;
  }

  if (!recipeUnlocked(s, c, recipe)) {
    b.status = 'Locked';
    b.efficiency = 0;
    b.shortages = {};
    b.sourceStrength = 0;
    return;
  }

  const crew = Math.max(1, recipe.workers > 0 ? recipe.workers : countJobSlots(c, def));
  const workers = Math.max(0, b.workers);
  const crewRatio = clamp01(workers / crew);
  if (crewRatio <= 0.001) {
    b.status = 'Awaiting workers';
    b.efficiency = 0;
    b.shortages = {};
    b.sourceStrength = 0;
    return;
  }

  // -------------------------------------------------------------------
  // Efficiency factors
  // -------------------------------------------------------------------
  const skill = avgWorkerSkill(c, s, b, recipe.skill, 40);
  const skillFactor = PRODUCTION_TUNING.skillFloor + PRODUCTION_TUNING.skillSpan * (skill / 100);
  const moraleFactor =
    PRODUCTION_TUNING.moraleFloor + PRODUCTION_TUNING.moraleSpan * (clamp(st.morale ?? 60, 0, 100) / 100);
  const conditionFactor = PRODUCTION_TUNING.conditionFloor + PRODUCTION_TUNING.conditionSpan * b.condition;
  const roadFactor = PRODUCTION_TUNING.roadFloor + PRODUCTION_TUNING.roadSpan * roadAccessOf(s, b);
  const speedMod = 1 + modOf(ctx, st.id, recipe.gather ? 'workSpeed' : 'craftSpeed');
  const weatherFactor = weatherFactorFor(ctx, st, def);
  let quality = clamp(
    skillFactor * moraleFactor * conditionFactor * roadFactor * speedMod * weatherFactor,
    PRODUCTION_TUNING.minQuality,
    PRODUCTION_TUNING.maxQuality,
  );

  // -------------------------------------------------------------------
  // Environment source (resolve before spending anything)
  // -------------------------------------------------------------------
  let gatherTarget: GatherTarget | null = null;
  if (recipe.gather) {
    gatherTarget = findGatherTarget(ctx, st, b, recipe.gather);
    let minStrength = recipe.gather.minSource ?? PRODUCTION_TUNING.minGatherStrength;
    // A surface fallback is a deliberate last resort: let it work even if the
    // authored threshold would reject its modest strength.
    if (gatherTarget?.poor) minStrength = Math.min(minStrength, PRODUCTION_TUNING.minGatherStrength);
    const strength = gatherTarget ? gatherTarget.strength : 0;
    b.sourceStrength = round2(clamp01(strength));
    if (!gatherTarget || strength < minStrength) {
      b.sourceStrength = round2(clamp01(strength));
      b.status = 'Source depleted';
      b.efficiency = 0;
      b.shortages = {};
      return;
    }
    b.status = gatherTarget.poor ? 'Source poor' : b.status;
    quality *= PRODUCTION_TUNING.sourceFloor + PRODUCTION_TUNING.sourceSpan * clamp01(strength);

    // Pure extraction idles once its raw material is comfortably stocked.
    if (Object.keys(recipe.inputs).length === 0) {
      const produce = recipe.gather.resource;
      const resDef = c.resources[produce];
      if (resDef && !resDef.edible && produce !== waterResourceId(c)) {
        const capAmount = extractionSurplusCap(ctx, st, produce);
        if (stockOf(st, produce) >= capAmount) {
          b.status = 'Surplus';
          b.efficiency = 0;
          b.shortages = {};
          return;
        }
      }
    }
  } else {
    b.sourceStrength = 0;
  }

  // -------------------------------------------------------------------
  // Power
  // -------------------------------------------------------------------
  const energyId = energyResourceId(c);
  const powerNeed = (recipe.power ?? 0) + (def.energyUse ?? 0) * 0.5;
  if (powerNeed > 0 && energyId) {
    const need = powerNeed * crewRatio;
    if (need > 0) {
      const available = stockOf(st, energyId);
      const fraction = clamp01(available / need);
      if (fraction < PRODUCTION_TUNING.powerFloorFraction) {
        b.status = 'No power';
        b.efficiency = 0;
        b.shortages = {};
        return;
      }
      removeStock(st, energyId, need * fraction);
      quality *= 0.3 + 0.7 * fraction;
    }
  }

  // -------------------------------------------------------------------
  // Water
  // -------------------------------------------------------------------
  const waterId = waterResourceId(c);
  let waterShort = false;
  if ((def.waterUse ?? 0) > 0 && waterId) {
    const need = def.waterUse * crewRatio;
    if (need > 0) {
      const available = stockOf(st, waterId);
      const fraction = clamp01(available / need);
      removeStock(st, waterId, need * fraction);
      if (fraction < PRODUCTION_TUNING.waterFloorFraction) {
        // A dry workshop is miserable, not dead: it crawls on stored dregs.
        quality *= 0.45;
        waterShort = true;
      } else {
        quality *= 0.4 + 0.6 * fraction;
        waterShort = fraction < 0.75;
      }
    }
  }

  // -------------------------------------------------------------------
  // Inputs — partial runs scale the whole output
  // -------------------------------------------------------------------
  const productionScale = crewRatio * quality;
  const shortages: Record<ResourceId, number> = {};
  let inputFraction = 1;
  const inputMod = clamp(modOf(ctx, st.id, 'inputEfficiency'), -0.5, 1);
  const inputFactor = 1 / Math.max(0.6, 1 + inputMod);
  const inputNeed: Record<ResourceId, number> = {};
  for (const res in recipe.inputs) {
    const base = (recipe.inputs[res] ?? 0) * productionScale * inputFactor;
    if (base <= 0) continue;
    inputNeed[res] = base;
    const have = stockOf(st, res);
    if (have < base) {
      shortcomings(shortages, res, base - have);
      inputFraction = Math.min(inputFraction, have / base);
    }
  }
  if (inputFraction <= 0.001) {
    const first = Object.keys(shortages)[0];
    b.status = first ? `No input: ${resourceName(c, first)}` : 'Idle';
    b.efficiency = 0;
    b.shortages = shortages;
    return;
  }
  const actualScale = productionScale * inputFraction;
  for (const res in inputNeed) {
    removeStock(st, res, inputNeed[res] * inputFraction);
  }

  // -------------------------------------------------------------------
  // Plan the day's yields, then fit them into remaining storage.
  // Extraction is the primary gather yield; outputs are incidental byproducts.
  // -------------------------------------------------------------------
  const yieldMod = recipe.gather ? gatherYieldMod(c, recipe.gather) : null;
  const yieldMult = yieldMod ? Math.max(0, 1 + modOf(ctx, st.id, yieldMod)) : 1;
  const byproductMod = modOf(ctx, st.id, 'byproductYield');
  const byproductMult = recipe.gather ? Math.max(0, 1 + byproductMod) : Math.max(0, 1 + byproductMod * 0.5);

  const plannedGather = recipe.gather && gatherTarget ? Math.max(0, recipe.gather.rate) * workers * quality * inputFraction * yieldMult : 0;
  const plannedOutputs: Record<ResourceId, number> = {};
  for (const res in recipe.outputs) {
    const amount = (recipe.outputs[res] ?? 0) * actualScale * byproductMult;
    if (amount > 0) plannedOutputs[res] = amount;
  }
  let plannedUnits = plannedGather;
  for (const res in plannedOutputs) plannedUnits += plannedOutputs[res];

  // Storage constrains only the NET volume added. A craft that consumes as much
  // (or more) than it produces — sawing planks, milling grain, baking bread —
  // keeps running even at capacity because it frees space as it works.
  let inputUnits = 0;
  for (const res in inputNeed) inputUnits += inputNeed[res] * inputFraction;
  const netAdded = plannedUnits - inputUnits;

  let space = Math.max(0, st.storageCap - stockTotal(st));
  // Staple food is never refused: evict dry goods to make room for it.
  if (recipe.gather && gatherTarget && plannedGather > space) {
    const staple = c.resources[recipe.gather.resource]?.edible;
    if (staple) {
      freeStorageSpace(ctx, st, plannedGather - space, recipe.gather.resource);
      space = Math.max(0, st.storageCap - stockTotal(st));
    }
  }
  // A full store never halts a building: outputs that cannot fit are lost (and
  // reported), while conversions continue to consume inputs and free space.
  const storeFraction = 1;
  const gatherAmount = plannedGather * storeFraction;
  const outputScale = actualScale * storeFraction;

  // Consume the inputs that the reduced run actually needs.
  for (const res in inputNeed) {
    removeStock(st, res, inputNeed[res] * inputFraction * storeFraction);
  }
  // Consuming inputs frees store space: a craft can complete even when the
  // granary was over capacity when the day began.
  space = Math.max(0, st.storageCap - stockTotal(st));

  let wasted = 0;
  let addedTotal = 0;
  let foodUnits = 0;
  let goods = 0;

  if (recipe.gather && gatherTarget && gatherAmount > 0) {
    const g = recipe.gather;
    applyDepletion(g, gatherTarget, gatherAmount);
    const res = g.resource;
    const added = addCapped(ctx, st, res, gatherAmount, space);
    space = Math.max(0, space - added);
    wasted += gatherAmount - added;
    addedTotal += added;
    const resDef = c.resources[res];
    if (resDef?.edible) foodUnits += added * resDef.edible;
    s.stats.resourcesGathered += gatherAmount;
  }

  for (const res in plannedOutputs) {
    const amount = plannedOutputs[res] * storeFraction;
    if (amount <= 0) continue;
    const added = addCapped(ctx, st, res, amount, space);
    space = Math.max(0, space - added);
    wasted += amount - added;
    addedTotal += added;
    const resDef = c.resources[res];
    if (resDef?.edible) foodUnits += added * resDef.edible;
    else goods += added;
  }

  // -------------------------------------------------------------------
  // Stats, status, cache fields
  // -------------------------------------------------------------------
  if (foodUnits > 0) {
    st.stats.foodProduced += foodUnits;
    s.stats.foodProduced += foodUnits;
  }
  if (goods > 0) s.stats.goodsCrafted += goods;

  b.efficiency = round2(clamp(crewRatio * quality, 0, 1.5));
  b.shortages = shortages;

  if (Object.keys(shortages).length > 0) {
    const first = Object.keys(shortages)[0];
    b.status = `No input: ${resourceName(c, first)}`;
  } else if (wasted > 0.05) {
    b.status = 'Storage full';
  } else if (waterShort) {
    b.status = 'No water';
  } else if (gatherTarget?.poor) {
    b.status = 'Source poor';
  } else {
    b.status = 'Working';
  }

  if (wasted >= PRODUCTION_TUNING.wasteNotifyAmount) {
    const flag = `waste_notify_${st.id}`;
    if (ctx.tick - (s.flags[flag] ?? -999) > PRODUCTION_TUNING.wasteNotifyInterval) {
      s.flags[flag] = ctx.tick;
      ctx.notify(`Storage full at ${st.name}: ${round1(wasted)} goods were lost.`, 'warn', 'storehouse');
    }
  }
}

// ---------------------------------------------------------------------------
// Recipe helpers
// ---------------------------------------------------------------------------

function resolveRecipe(ctx: SimContext, b: Building, def: BuildingDef): RecipeDef | undefined {
  const c = ctx.c;
  if (b.recipeId) {
    const recipe = c.recipes[b.recipeId];
    if (recipe) return recipe;
  }
  for (const id of def.recipes) {
    const recipe = c.recipes[id];
    if (recipe) return recipe;
  }
  return undefined;
}

function recipeUnlocked(s: GameState, c: Content, recipe: RecipeDef): boolean {
  if (!recipe.requiresTech || recipe.requiresTech.length === 0) return true;
  for (const tech of recipe.requiresTech) {
    // Unknown tech ids are treated as satisfied (content may lag the systems).
    if (!c.techs[tech]) continue;
    if (!hasTech(s, tech)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Gathering sources
// ---------------------------------------------------------------------------

interface GatherTarget {
  tile: Tile;
  strength: number;
  idx: number;
  /** True when the yield comes from a generic surface fallback, not a real source. */
  poor?: boolean;
}

function findGatherTarget(ctx: SimContext, st: Settlement, b: Building, gather: GatherSpec): GatherTarget | null {
  const w = ctx.s.world;
  const idx = b.y * w.width + b.x;
  const gatherRadiusMod = clamp(modOf(ctx, st.id, 'gatherRadius'), -0.6, 2);
  const radius = Math.max(1, gather.radius * (1 + gatherRadiusMod));
  const tiles = radiusIndices(ctx.s, idx, radius);

  let best: GatherTarget | null = null;
  const consider = (i: number, tile: Tile, strength: number): void => {
    if (!Number.isFinite(strength) || strength <= 0) return;
    if (!best || strength > best.strength) best = { tile, strength, idx: i };
  };

  for (const i of tiles) {
    const t = w.tiles[i];
    if (!t) continue;
    switch (gather.source) {
      case 'forest':
        consider(i, t, t.forest);
        break;
      case 'forage':
        consider(i, t, t.forage);
        break;
      case 'wildlife':
        consider(i, t, t.wildlife);
        break;
      case 'water':
        consider(i, t, t.water);
        break;
      case 'fertility':
        consider(i, t, t.fertility);
        break;
      case 'beauty':
        consider(i, t, t.beauty);
        break;
      case 'deposit': {
        const dep = t.deposit;
        if (!dep || dep.amount <= 0) break;
        if (dep.resource !== gather.resource) break;
        consider(i, t, clamp01(dep.amount / Math.max(1, dep.initial)));
        break;
      }
      default:
        break;
    }
  }

  // The building's own tile can be the source too (e.g. a dock on the water).
  if (!best) {
    const own = w.tiles[idx];
    if (own) {
      switch (gather.source) {
        case 'water':
          if (own.water > 0) consider(idx, own, own.water);
          break;
        case 'forest':
          if (own.forest > 0) consider(idx, own, own.forest);
          break;
        case 'forage':
          if (own.forage > 0) consider(idx, own, own.forage);
          break;
        case 'fertility':
          if (own.fertility > 0) consider(idx, own, own.fertility);
          break;
        case 'deposit': {
          const dep = own.deposit;
          if (dep && dep.resource === gather.resource && dep.amount > 0) {
            consider(idx, own, clamp01(dep.amount / Math.max(1, dep.initial)));
          }
          break;
        }
        default:
          break;
      }
    }
  }

  // Scrub-and-deadfall fallback: when the trees within reach have been felled,
  // woodcutters still gather fallen branches and scrub for a floor-level trickle
  // of wood until the ecology system regrows the wood. Keeps timber from
  // becoming a permanent dead end around the capital.
  const SURFACE_FLOORS: Partial<Record<GatherSpec['source'], number>> = {
    forest: 0.18,
    forage: 0.16,
    wildlife: 0.12,
  };
  const floorStrength = SURFACE_FLOORS[gather.source];
  const currentBest = best as GatherTarget | null;
  if (floorStrength !== undefined && (currentBest === null || currentStrengthOf(currentBest) < floorStrength)) {
    const own = w.tiles[idx];
    if (own) best = { tile: own, strength: floorStrength, idx, poor: true };
  }

  // Surface-worked fallback: a stone pit can always scratch stone out of the
  // ground, and clay/sand are dug from any soil — just slowly. Ores truly need
  // a deposit. This keeps era-0 extraction alive on deposit-poor maps.
  if (gather.source === 'deposit') {
    const own = w.tiles[idx];
    const floor = surfaceDepositFloor(ctx.c, gather.resource, own);
    const current = best as GatherTarget | null;
    if (floor > 0 && own && (current === null || current.strength < floor)) {
      best = { tile: own, strength: floor, idx, poor: true };
    }
  }
  return best;
}

/** Slow surface yield for deposit gatherers with no matching deposit in reach. */
function currentStrengthOf(target: GatherTarget): number {
  return target.strength;
}

function surfaceDepositFloor(c: Content, resource: ResourceId, tile: Tile | undefined): number {
  const def = c.resources[resource];
  const tags = def?.tags ?? [];
  if (tags.includes('ore') || resource.includes('ore') || resource === 'coal' || resource === 'oil') return 0;
  const biomeTags = tile ? c.biomes[tile.biome]?.tags ?? [] : [];
  const highland = biomeTags.includes('highland') || biomeTags.includes('ore') || biomeTags.includes('stone');
  if (resource === 'stone') return highland ? 0.22 : 0.12;
  if (resource === 'clay' || resource === 'sand' || resource === 'salt') return 0.1;
  return 0;
}

/** Soil can only be worn so far in one day; the ecology system regenerates it. */
const MAX_FERTILITY_DEPLETION_PER_DAY = 0.012;

function applyDepletion(gather: GatherSpec, target: GatherTarget, amount: number): void {
  const t = target.tile;
  let depletion = Math.max(0, gather.depletion);
  if (gather.source === 'fertility') {
    depletion = Math.min(depletion, MAX_FERTILITY_DEPLETION_PER_DAY / Math.max(0.001, amount));
  }
  switch (gather.source) {
    case 'forest':
      t.forest = clamp01(t.forest - amount * depletion);
      break;
    case 'forage':
      t.forage = clamp01(t.forage - amount * depletion);
      break;
    case 'wildlife':
      t.wildlife = clamp01(t.wildlife - amount * depletion);
      break;
    case 'water':
      // Fishing takes a little from the water body's productivity.
      t.water = clamp01(t.water - amount * depletion * 0.25);
      break;
    case 'fertility':
      t.fertility = clamp01(t.fertility - amount * depletion);
      break;
    case 'beauty':
      t.beauty = clamp01(t.beauty - amount * depletion * 0.2);
      break;
    case 'deposit':
      if (t.deposit) t.deposit.amount = Math.max(0, t.deposit.amount - amount);
      break;
    default:
      break;
  }
}

function gatherYieldMod(c: Content, gather: GatherSpec): ModifierKey {
  const resDef = c.resources[gather.resource];
  const tags = resDef?.tags ?? [];
  if (gather.source === 'fertility') {
    if (tags.includes('orchard') || tags.includes('fruit')) return 'orchardYield';
    if (tags.includes('herd') || tags.includes('pasture') || tags.includes('wool') || tags.includes('hides') || tags.includes('meat')) {
      return 'pastureYield';
    }
    return 'farmYield';
  }
  if (gather.source === 'deposit') {
    if (tags.includes('quarry') || tags.includes('stone') || tags.includes('clay') || tags.includes('sand') || tags.includes('earth')) {
      return 'quarryYield';
    }
    return 'mineYield';
  }
  switch (gather.source) {
    case 'forest':
      return 'lumberYield';
    case 'forage':
      return 'forageYield';
    case 'wildlife':
      return 'huntYield';
    case 'water':
      return 'fishYield';
    default:
      return 'byproductYield';
  }
}

// ---------------------------------------------------------------------------
// Weather
// ---------------------------------------------------------------------------

function weatherFactorFor(ctx: SimContext, st: Settlement, def: BuildingDef): number {
  const weather = ctx.s.world.weather;
  let factor = 1;
  const outdoor = isOutdoorBuilding(ctx.c, def);
  const tags = def.tags ?? [];
  const isFarm = tags.includes('farm') || def.category === 'food';
  if (outdoor) {
    if (weather.season === 'winter') factor *= isFarm ? PRODUCTION_TUNING.winterFarmFactor : PRODUCTION_TUNING.winterOutdoorFactor;
    if (weather.storm > 0.25) factor *= PRODUCTION_TUNING.stormFactor;
    if (weather.drought > 0.35 && isFarm) factor *= PRODUCTION_TUNING.droughtFarmFactor;
    if (weather.snow > 0.5 && !isFarm) factor *= 0.9;
  } else if (weather.storm > 0.6) {
    factor *= 0.95;
  }
  void st;
  return clamp(factor, 0.08, 1.15);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Add stock without exceeding the settlement's remaining storage space. */
function addCapped(ctx: SimContext, st: Settlement, res: ResourceId, amount: number, space: number): number {
  if (amount <= 0) return 0;
  let allowed = Math.min(amount, Math.max(0, space));
  // Water has its own small cistern buffer: a productive well must never fill
  // the storehouse and crowd out food.
  if (res === waterResourceId(ctx.c)) {
    allowed = Math.min(allowed, Math.max(0, waterBufferTarget(st) - stockOf(st, res)));
  }
  if (allowed <= 0) return 0;
  return addStock(st, res, allowed);
}

function shortcomings(target: Record<ResourceId, number>, res: ResourceId, amount: number): void {
  target[res] = (target[res] ?? 0) + amount;
}

function resourceName(c: Content, id: ResourceId): string {
  return c.resources[id]?.name ?? id;
}
