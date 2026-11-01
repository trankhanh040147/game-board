/**
 * civ.buildings — Construction, structural condition, upkeep, settlement caches,
 * service coverage, pollution emission and road access.
 *
 * Runs first among the civ systems (see tick.ts SYSTEM_ORDER) so that every later
 * system (jobs, production, population, economy...) sees fresh settlement caches:
 *   - settlement.storageCap / storageUsed
 *   - settlement.housing.{capacity,quality}
 *   - settlement.mods (passive building effects + service coverage)
 *   - s.cache.roadAccess[buildingId] and settlement.roadAccess
 *   - fresh water supplied by `service.kind:'water'` buildings
 *   - pollution emitted into nearby tiles for the ecology system to disperse
 *
 * This module owns `settlement.mods`; no other system should write it.
 *
 * Determinism: all randomness via ctx.rng. No Math.random / Date.now.
 */
import type {
  Alert,
  Building,
  BuildingDef,
  Citizen,
  Content,
  GameState,
  ModifierDelta,
  ModifierKey,
  ResourceId,
  Settlement,
  SimContext,
  SkillId,
} from '../../types';
import { LIMITS } from '../../config';
import {
  addStock,
  clamp,
  clamp01,
  canAfford,
  foodDaysOf,
  modOf,
  radiusIndices,
  removeStock,
  round2,
  scaleCost,
  payCost,
  stockOf,
  stockTotal,
  tileAt,
} from '../../core';
import { destroyBuilding } from '../../state';

// ---------------------------------------------------------------------------
// Tuning knobs (single place for QA / balance work)
// ---------------------------------------------------------------------------

export const BUILDINGS_TUNING = {
  /** Structural decay per day at zero stress for an idle but complete building. */
  conditionDecayPerDay: LIMITS.buildingDurabilityDecay,
  /** Pollution on the building's own tile multiplies decay by up to this factor. */
  pollutionDecayStress: 2.5,
  /** Extra decay per day when upkeep cannot be paid (scaled by unpaid fraction). */
  unpaidUpkeepDecay: 0.0022,
  /** Condition recovered per day as a fraction of the missing condition gap. */
  repairGain: LIMITS.repairRate,
  /** Share of the original build cost charged to repair from condition x to x+dx. */
  repairCostFraction: 0.16,
  /** Repair only cares about meaningful damage. */
  repairThreshold: 0.995,
  /** Days a ruined *collapsible* shell stands before it collapses (industry only). */
  ruinCollapseDays: 60,
  /** Critical civic buildings never collapse from neglect; they stop at this condition. */
  ruinedCriticalFloor: 0.02,
  /** A building at/below this condition counts as a repairable ruin. */
  ruinConditionThreshold: 0.1,
  /** Fraction of build cost to restore a ruin straight back to working order. */
  restorationCostFraction: 0.3,
  /** Condition a restored ruin comes back at. */
  restorationCondition: 0.6,
  /** Minimum construction progress per day with no workers at all. */
  noWorkerConstructionRate: 0.055,
  /** Pollution emitted per def.pollution point, per tile per day. */
  pollutionPerPoint: 0.004,
  /** Service coverage needed per citizen for each service kind. */
  serviceNeedPerCitizen: {
    health: 0.25,
    education: 0.2,
    culture: 0.2,
    safety: 0.15,
    trade: 0.3,
    faith: 0.15,
    water: 0.15,
  } as Record<string, number>,
  /** Modifier contributions at full coverage (fractions, except flat keys). */
  serviceEffects: {
    health: { healthRate: 0.05, deathRate: -0.01 },
    education: { educationRate: 0.06, researchRate: 0.02 },
    culture: { cultureRate: 0.07, moraleFlat: 1.2 },
    safety: { crimeRate: -0.07, stability: 0.02 },
    trade: { tradeSellPrice: 0.02, taxEfficiency: 0.04 },
    faith: { moraleFlat: 1.0, stability: 0.02 },
    water: { waterAvailability: 0.04 },
  } as Record<string, ModifierDelta>,
  /** Max alerts kept per settlement (UI space). */
  maxAlerts: 12,
  /** Road access at the settlement centre with no roads. */
  roadAccessCentreBase: 0.6,
  /** Road access falls to zero this many tiles from the centre. */
  roadAccessReach: 30,
};

/** Modifier keys whose values are flat units, not fractions. */
export const FLAT_MODIFIER_KEYS = new Set<ModifierKey>(['moraleFlat', 'insightFlat']);

/**
 * Civic categories a settlement cannot lose to neglect: if they fall into ruin
 * they remain repairable shells forever. Losing a well/granary/house to a bad
 * harvest turns a survivable famine into an extinction event.
 */
const CRITICAL_CATEGORIES = new Set<string>(['housing', 'food', 'gathering', 'water', 'storage', 'society', 'science']);

/** Only heavy works with no survival function may collapse from long neglect. */
const COLLAPSIBLE_CATEGORIES = new Set<string>(['industry', 'beauty', 'energy', 'defence']);

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// Small shared helpers (also used by production / logistics / economy)
// ---------------------------------------------------------------------------

export function countJobSlots(c: Content, def: BuildingDef | undefined): number {
  if (!def) return 1;
  let n = 0;
  for (const j of def.jobs) n += j.count;
  return Math.max(1, n);
}

/** Skill an assigned worker crew brings to a job, 0..100. */
export function avgWorkerSkill(c: Content, s: GameState, b: Building, skill: SkillId, fallback = 40): number {
  if (!b.workerIds.length) return b.workers > 0 ? fallback : 0;
  const map = citizensById(s);
  let total = 0;
  let n = 0;
  for (const id of b.workerIds) {
    const citizen = map.get(id);
    if (!citizen || !citizen.alive) continue;
    total += citizen.skills[skill] ?? fallback;
    n++;
  }
  if (n === 0) return b.workers > 0 ? fallback : 0;
  return total / n;
}

/**
 * Cached citizen id -> citizen index, rebuilt at most once per tick. Systems run
 * over hundreds of buildings and thousands of citizens; find() per worker would
 * be O(buildings x citizens).
 */
let citizenIndexState: GameState | null = null;
let citizenIndexTick = -1;
let citizenIndexMap: Map<number, Citizen> = new Map();

export function citizensById(s: GameState): Map<number, Citizen> {
  if (s !== citizenIndexState || s.tick !== citizenIndexTick) {
    citizenIndexMap = new Map();
    for (const c of s.citizens) citizenIndexMap.set(c.id, c);
    citizenIndexState = s;
    citizenIndexTick = s.tick;
  }
  return citizenIndexMap;
}

/** Cached resource-id lookups (content is immutable at runtime). */
let cachedContent: Content | null = null;
let cachedWaterId: ResourceId | null = null;
let cachedEnergyId: ResourceId | null = null;

export function waterResourceId(c: Content): ResourceId | null {
  if (c !== cachedContent) {
    cachedWaterId = null;
    cachedEnergyId = null;
    cachedContent = c;
  }
  if (cachedWaterId === null) {
    cachedWaterId = '';
    if (c.resources['water']) cachedWaterId = 'water';
    else {
      for (const id in c.resources) {
        const tags = c.resources[id]?.tags ?? [];
        if (tags.includes('utility') || tags.includes('well')) {
          cachedWaterId = id;
          break;
        }
      }
    }
  }
  return cachedWaterId || null;
}

export function energyResourceId(c: Content): ResourceId | null {
  if (c !== cachedContent) {
    cachedWaterId = null;
    cachedEnergyId = null;
    cachedContent = c;
  }
  if (cachedEnergyId === null) {
    cachedEnergyId = '';
    for (const id in c.resources) {
      const def = c.resources[id];
      if (!def) continue;
      if (def.category === 'energy' || def.tags?.includes('power')) {
        cachedEnergyId = id;
        break;
      }
    }
  }
  return cachedEnergyId || null;
}

/**
 * How much water a settlement keeps in its cistern. Water must never crowd out
 * food and timber: it is a small survival buffer, topped up by wells/waterworks
 * a little at a time, since population also draws from rivers and rain.
 */
export function waterBufferTarget(ctx: SimContext, st: Settlement): number {
  // A useful cistern: 2-3 wells should fill a reservoir worth days of drinking,
  // not saturate after one bucket. Capped as a share of total storage so water
  // can never crowd out food and timber.
  const base = Math.max(40, st.population * 2 + 20);
  return Math.max(8, Math.min(st.storageCap * waterCapacityShare(ctx, st.id), base));
}

/** Share of storage a settlement will ever dedicate to water (towers unlock more). */
function waterCapacityShare(ctx: SimContext, settlementId: number): number {
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== settlementId || b.progress < 1) continue;
    const def = ctx.c.buildings[b.typeId];
    if (!def) continue;
    if (b.typeId === 'water_tower' || def.tags?.includes('water_tower') || def.tags?.includes('tower')) return 0.3;
  }
  return 0.22;
}

/** True when the building's work is exposed to the sky (winter / storms hurt). */
export function isOutdoorBuilding(c: Content, def: BuildingDef | undefined): boolean {
  if (!def) return false;
  if (def.category === 'gathering') return true;
  const tags = def.tags ?? [];
  const outdoorTags = ['farm', 'forest', 'fish', 'hunt', 'water', 'quarry', 'mine', 'orchard', 'pasture', 'gather', 'timber', 'ore'];
  for (const t of tags) if (outdoorTags.includes(t)) return true;
  return false;
}

/** Activity level 0..1.5 used for pollution, upkeep and decay. */
export function activityOf(c: Content, b: Building): number {
  if (b.progress < 1 || !b.enabled || b.condition <= 0.05) return 0;
  if (b.efficiency > 0.02) return clamp(b.efficiency, 0.1, 1.5);
  // Passive / not-yet-produced buildings still burn a little upkeep.
  return b.workers > 0 ? 0.6 : 0.2;
}

export function roadAccessOf(s: GameState, b: Building): number {
  const v = s.cache.roadAccess[b.id];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0.5;
}

/** Add or refresh a settlement alert (same kind + title = one alert). */
export function setSettlementAlert(st: Settlement, alert: Alert): void {
  const existing = st.alerts.find((a) => a.kind === alert.kind && a.title === alert.title);
  if (existing) {
    existing.detail = alert.detail;
    existing.severity = alert.severity;
    return;
  }
  st.alerts.push(alert);
  if (st.alerts.length > BUILDINGS_TUNING.maxAlerts) {
    // Drop the oldest low-severity alert first.
    const idx = st.alerts.findIndex((a) => a.severity < 3);
    st.alerts.splice(idx >= 0 ? idx : 0, 1);
  }
}

export function clearSettlementAlert(st: Settlement, kind: Alert['kind'], title: string): void {
  st.alerts = st.alerts.filter((a) => !(a.kind === kind && a.title === title));
}

/**
 * True while a settlement is in an active crisis (famine, or literally nothing
 * left in the store to maintain anything). In that state nobody repairs and
 * buildings stop decaying: "the people are starving; the walls remain".
 */
export function settlementInCrisis(ctx: SimContext, st: Settlement): boolean {
  if (foodDaysOf(ctx.s, ctx.c, st) < 2) return true;
  if (stockTotal(st) < 0.5) return true;
  return false;
}

/**
 * Evict non-food surplus to make room for something the settlement cannot do
 * without (food, water). Returns the amount actually freed.
 */
export function freeStorageSpace(ctx: SimContext, st: Settlement, needed: number, protect?: ResourceId): number {
  if (needed <= 0) return 0;
  const c = ctx.c;
  const entries = Object.keys(st.stock)
    .map((id) => ({ id, amount: st.stock[id] ?? 0 }))
    .filter((e) => e.amount > 0 && e.id !== protect && e.id !== 'water' && !c.resources[e.id]?.edible)
    .sort((a, b) => b.amount - a.amount);
  let freed = 0;
  for (const entry of entries) {
    if (freed >= needed) break;
    const take = Math.min(entry.amount, needed - freed);
    removeStock(st, entry.id, take);
    freed += take;
  }
  return freed;
}

/** Scale a ModifierDelta, leaving flat-unit keys as written in content. */
function scaledEffects(out: ModifierDelta, effects: ModifierDelta, scale: number): void {
  for (const key in effects) {
    const k = key as ModifierKey;
    const v = effects[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = (out[k] ?? 0) + v * scale;
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export function buildingsSystem(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;

  const bySettlement = new Map<number, Building[]>();
  for (const b of s.buildings) {
    const arr = bySettlement.get(b.settlementId);
    if (arr) arr.push(b);
    else bySettlement.set(b.settlementId, [b]);
  }

  for (const st of s.settlements) {
    const list = bySettlement.get(st.id);
    if (!list || list.length === 0) {
      // Still keep the caches coherent (a settlement can lose every building).
      st.storageCap = Math.max(5, LIMITS.storageBaseCapacity * (1 + modOf(ctx, st.id, 'storageCap')));
      st.storageUsed = round2(stockTotal(st));
      st.housing.capacity = 0;
      st.housing.quality = 0;
      st.roadAccess = 0;
      continue;
    }

    let storageBonus = 0;
    let housingCap = 0;
    let housingQualityWeighted = 0;
    let housingWeight = 0;
    const mods: ModifierDelta = {};
    const serviceCap: Record<string, number> = {};
    const upkeepNeed: Record<ResourceId, number> = {};
    const waterId = waterResourceId(c);
    // In a famine (or with literally nothing left to maintain anything) decay
    // halts entirely: starving people do not repair, but the walls remain.
    const crisis = settlementInCrisis(ctx, st);

    // -----------------------------------------------------------------
    // Pass 1 — construction progress, decay, aggregates
    // -----------------------------------------------------------------
    for (const b of list) {
      const def = c.buildings[b.typeId];
      if (!def) {
        b.active = false;
        b.efficiency = 0;
        b.status = 'Unknown building';
        continue;
      }

      if (b.progress < 1) {
        progressConstruction(ctx, st, b, def);
        continue;
      }

      b.active = b.enabled && b.condition > 0.05;
      if (!b.recipeId && def.recipes.length > 0) b.recipeId = def.recipes[0] ?? null;

      const activity = activityOf(c, b);
      const tile = tileAt(s.world, b.x, b.y);
      const pollutionStress = clamp01(tile?.pollution ?? 0);
      const critical = CRITICAL_CATEGORIES.has(def.category);
      if (!crisis) {
        const decay =
          BUILDINGS_TUNING.conditionDecayPerDay *
          (0.4 + 0.6 * activity) *
          (1 + pollutionStress * BUILDINGS_TUNING.pollutionDecayStress);
        let next = b.condition - decay;
        if (critical && next < BUILDINGS_TUNING.ruinedCriticalFloor) next = BUILDINGS_TUNING.ruinedCriticalFloor;
        b.condition = Math.max(0, next);
      }

      const condFactor = 0.3 + 0.7 * b.condition;

      // Material upkeep accumulates across the whole settlement.
      const upkeepFactor = b.enabled ? 1 : 0.3;
      for (const res in def.upkeep) {
        const amount = (def.upkeep[res] ?? 0) * upkeepFactor;
        if (amount > 0) upkeepNeed[res] = (upkeepNeed[res] ?? 0) + amount;
      }

      if (def.storage && b.enabled) storageBonus += def.storage * condFactor;

      if (def.housing && b.enabled && b.condition > 0.05) {
        const cap = def.housing.capacity * condFactor;
        housingCap += cap;
        housingQualityWeighted += def.housing.quality * cap;
        housingWeight += cap;
      }

      if (b.enabled && b.condition > 0.05 && def.effects) scaledEffects(mods, def.effects, condFactor);

      if (def.service && b.enabled && b.condition > 0.05) {
        const kind = def.service.kind;
        serviceCap[kind] = (serviceCap[kind] ?? 0) + def.service.amount * condFactor;
      }

      if (!b.enabled) b.status = 'Paused';
      else if (b.condition <= 0.05) {
        b.status = 'Ruined';
        b.active = false;
      }
    }

    // -----------------------------------------------------------------
    // Pass 2 — pay material upkeep, then decay unpaid buildings / repair
    // -----------------------------------------------------------------
    let paidRatio = 1;
    let upkeepValuePaid = 0;
    for (const res in upkeepNeed) {
      const need = upkeepNeed[res];
      if (need <= EPS) continue;
      const have = stockOf(st, res);
      const take = Math.min(have, need);
      if (take > 0) removeStock(st, res, take);
      upkeepValuePaid += take;
      paidRatio = Math.min(paidRatio, have >= need - EPS ? 1 : take / need);
    }
    st.upkeepPaid = round2((st.upkeepPaid ?? 0) + upkeepValuePaid);

    if (paidRatio < 0.999) {
      const unpaidFraction = 1 - paidRatio;
      if (!crisis) {
        for (const b of list) {
          if (b.progress < 1) continue;
          const def = c.buildings[b.typeId];
          if (!def) continue;
          const critical = CRITICAL_CATEGORIES.has(def.category);
          let next = b.condition - BUILDINGS_TUNING.unpaidUpkeepDecay * unpaidFraction;
          if (critical && next < BUILDINGS_TUNING.ruinedCriticalFloor) next = BUILDINGS_TUNING.ruinedCriticalFloor;
          b.condition = Math.max(0, next);
        }
      }
      setSettlementAlert(st, {
        id: `upkeep_unpaid_${st.id}`,
        kind: 'economy',
        severity: paidRatio < 0.35 ? 3 : 2,
        title: 'Upkeep unpaid',
        detail: 'Materials for maintenance are short; buildings are decaying faster.',
        sinceTick: ctx.tick,
      });
    } else {
      clearSettlementAlert(st, 'economy', 'Upkeep unpaid');
    }

    if (st.governor.autoRepair) {
      const costMod = 1 + modOf(ctx, st.id, 'constructionCost');
      for (const b of list) {
        if (b.progress < 1 || b.condition >= BUILDINGS_TUNING.repairThreshold) continue;
        const def = c.buildings[b.typeId];
        if (!def) continue;

        if (b.condition <= BUILDINGS_TUNING.ruinConditionThreshold) {
          // Repairable ruin: pay a lump sum of materials to bring it back to
          // working order. Nothing is ever lost silently.
          const restore = scaleCost(def.cost, BUILDINGS_TUNING.restorationCostFraction * costMod);
          if (!canAfford(st, restore)) continue;
          if (!payCost(st, restore)) continue;
          b.condition = BUILDINGS_TUNING.restorationCondition;
          b.active = b.enabled;
          b.status = b.enabled ? 'Working' : 'Paused';
          delete s.flags[`ruin_days_${b.id}`];
          continue;
        }

        const damage = 1 - b.condition;
        const cost = scaleCost(def.cost, damage * BUILDINGS_TUNING.repairCostFraction * costMod);
        if (!canAfford(st, cost)) continue;
        if (!payCost(st, cost)) continue;
        b.condition = Math.min(1, b.condition + BUILDINGS_TUNING.repairGain * damage);
      }
    }

    // Ruins: critical civic buildings become permanent repairable shells; only
    // collapsible industry may eventually be lost to long neglect, and never
    // while the settlement is in crisis.
    let anyRuin = false;
    const noticeKey = `ruin_notice_${st.id}`;
    for (const b of list) {
      if (b.progress < 1) continue;
      const def = c.buildings[b.typeId];
      if (!def) continue;
      const key = `ruin_days_${b.id}`;
      const critical = CRITICAL_CATEGORIES.has(def.category);
      const atRuin = b.condition <= BUILDINGS_TUNING.ruinConditionThreshold;

      if (atRuin) {
        anyRuin = true;
        if (!s.flags[noticeKey]) {
          s.flags[noticeKey] = 1;
          ctx.notify(
            `Buildings are falling into ruin at ${st.name} — materials are needed for repairs.`,
            'warn',
            'hammer',
          );
        }
        setSettlementAlert(st, {
          id: `ruin_${st.id}`,
          kind: 'economy',
          severity: 2,
          title: 'Buildings in ruin',
          detail: 'Roofs are giving way for want of maintenance. Restore materials to repair them.',
          sinceTick: ctx.tick,
        });
      }

      if (b.condition <= 0.05) {
        b.active = false;
        b.status = 'Ruined';
      }

      const mayCollapse =
        COLLAPSIBLE_CATEGORIES.has(def.category) && !critical && !crisis && st.population > 0 && stockTotal(st) > 0.5;
      if (atRuin && mayCollapse) {
        const days = (s.flags[key] ?? 0) + 1;
        s.flags[key] = days;
        if (days > BUILDINGS_TUNING.ruinCollapseDays) {
          delete s.flags[key];
          destroyBuilding(s, c, b, 'long neglect');
          ctx.notify(`The ruined ${def.name} has finally collapsed.`, 'bad', 'skull');
        }
      } else if (s.flags[key] !== undefined) {
        delete s.flags[key];
      }
    }
    if (!anyRuin) {
      clearSettlementAlert(st, 'economy', 'Buildings in ruin');
      if (s.flags[noticeKey] !== undefined) delete s.flags[noticeKey];
    }

    // -----------------------------------------------------------------
    // Pass 3 — settlement caches (storage, housing, services, water)
    // -----------------------------------------------------------------
    const storageMod = modOf(ctx, st.id, 'storageCap');
    st.storageCap = Math.max(5, (LIMITS.storageBaseCapacity + storageBonus) * (1 + storageMod));

    st.housing.capacity = Math.round(housingCap * 10) / 10;
    st.housing.quality = housingWeight > 0 ? round2(housingQualityWeighted / housingWeight) : 0;

    const population = Math.max(1, st.population);
    for (const kind in serviceCap) {
      if (kind === 'water') continue;
      const need = (BUILDINGS_TUNING.serviceNeedPerCitizen[kind] ?? 0.2) * population;
      const coverage = clamp01(need > 0 ? (serviceCap[kind] ?? 0) / need : 0);
      if (coverage <= 0.01) continue;
      const effects = BUILDINGS_TUNING.serviceEffects[kind];
      if (!effects) continue;
      scaledEffects(mods, effects, coverage);
    }

    // Wells, aqueducts and water towers actually fill the settlement's barrels.
    // Water is kept in its own buffer: it must never crowd out food/wood just
    // because a well keeps running through an empty storeroom.
    if (waterId) {
      const waterService = serviceCap['water'] ?? 0;
      if (waterService > 0) {
        const mult = 1 + modOf(ctx, st.id, 'waterAvailability');
        const gross = waterService * Math.max(0, mult);
        const currentWater = stockOf(st, waterId);
        const bufferTarget = waterBufferTarget(ctx, st);
        const targetRoom = Math.max(0, bufferTarget - currentWater);
        let globalRoom = Math.max(0, st.storageCap - stockTotal(st));
        let wanted = Math.min(gross, targetRoom);
        if (wanted > globalRoom) {
          // A packed store must never mean a thirsty town: evict dry goods.
          freeStorageSpace(ctx, st, wanted - globalRoom, waterId);
          globalRoom = Math.max(0, st.storageCap - stockTotal(st));
        }
        const allowed = Math.max(0, Math.min(wanted, globalRoom));
        const added = allowed > 0 ? addStock(st, waterId, allowed) : 0;
        if (added < gross - EPS && gross - added > 2) {
          const flag = `water_spill_notify_${st.id}`;
          if (ctx.tick - (s.flags[flag] ?? -999) > 40) {
            s.flags[flag] = ctx.tick;
            ctx.notify(`Water is spilling at ${st.name}: the cistern is full.`, 'info', 'water');
          }
        }
      }
    }

    st.mods = mods;
    st.storageUsed = round2(stockTotal(st));

    updateRoadAccess(ctx, st, list);

    // Air quality: operating buildings foul the tiles around them. The ecology
    // system disperses this every day; we only emit.
    for (const b of list) {
      if (b.progress < 1) continue;
      emitForBuilding(ctx, st, b);
    }
  }

  s.cache.lastRoadUpdate = ctx.tick;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

function progressConstruction(ctx: SimContext, st: Settlement, b: Building, def: BuildingDef): void {
  const s = ctx.s;
  const crew = countJobSlots(ctx.c, def);
  const workers = Math.max(0, b.workers);
  const skill = avgWorkerSkill(ctx.c, s, b, 'building', 40);
  const ratio = clamp01(workers / crew);
  const skillFactor = 0.7 + 0.6 * (skill / 100);
  const perDay = workers > 0 ? (0.35 + 0.65 * ratio) * skillFactor : BUILDINGS_TUNING.noWorkerConstructionRate;
  const buildSpeed = 1 + modOf(ctx, st.id, 'buildSpeed');
  const rate = (perDay * buildSpeed) / Math.max(1, def.buildTicks);

  b.progress = clamp01(b.progress + Math.max(0, rate));
  b.active = false;
  b.efficiency = 0;
  b.sourceStrength = 0;
  b.status = workers > 0 ? 'Under construction' : 'Awaiting workers';

  if (b.progress >= 1) {
    b.progress = 1;
    b.active = b.enabled && b.condition > 0.05;
    b.builtTick = ctx.tick;
    b.status = b.enabled ? 'Working' : 'Paused';
    if (!b.recipeId && def.recipes.length > 0) b.recipeId = def.recipes[0] ?? null;
    st.stats.buildingsBuilt++;
    s.stats.buildingsBuilt++;
    ctx.notify(`${def.name} completed at ${st.name}.`, 'good', 'hammer');

    const firstKey = `first_built_${def.id}`;
    if (!s.flags[firstKey]) {
      s.flags[firstKey] = 1;
      const notable = def.era >= 2 || def.tags?.includes('wonder') || def.tags?.includes('unique') || def.category === 'special';
      ctx.chronicle(
        `The ${def.name} Is Raised`,
        `In ${st.name}, the ${def.name.toLowerCase()} is finished. ${def.flavor ?? def.desc}`,
        'growth',
        notable ? 2 : 1,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Road access (cheap: nearest road tile + distance to the settlement centre)
// ---------------------------------------------------------------------------

function updateRoadAccess(ctx: SimContext, st: Settlement, list: Building[]): void {
  const s = ctx.s;
  const w = s.world;
  const roads: { x: number; y: number }[] = [];
  for (const idx of st.claimedTiles) {
    const t = w.tiles[idx];
    if (t && t.road > 0) roads.push({ x: idx % w.width, y: Math.floor(idx / w.width) });
  }

  let complete = 0;
  let connected = 0;
  for (const b of list) {
    if (b.progress < 1) continue;
    complete++;
    const centreDist = Math.hypot(b.x - st.x, b.y - st.y);
    let access = clamp01(BUILDINGS_TUNING.roadAccessCentreBase - centreDist / BUILDINGS_TUNING.roadAccessReach);
    let best = Infinity;
    for (const r of roads) {
      const d = Math.hypot(b.x - r.x, b.y - r.y);
      if (d < best) best = d;
    }
    if (best <= 1.5) access = Math.max(access, 1);
    else if (best <= 3) access = Math.max(access, 0.8);
    else if (best <= 5) access = Math.max(access, 0.55);
    access = clamp01(access);
    s.cache.roadAccess[b.id] = round2(access);
    if (access >= 0.7) connected++;
  }
  st.roadAccess = complete > 0 ? round2(connected / complete) : 0;
}

// ---------------------------------------------------------------------------
// Pollution emission — called from the buildings pass (kept separate for clarity)
// ---------------------------------------------------------------------------

export function emitPollution(ctx: SimContext, st: Settlement, b: Building, def: BuildingDef): void {
  if (!def.pollution || def.pollution <= 0) return;
  const activity = activityOf(ctx.c, b);
  if (activity <= 0) return;
  const mult = 1 + modOf(ctx, st.id, 'pollutionRate');
  const amount = def.pollution * BUILDINGS_TUNING.pollutionPerPoint * activity * Math.max(0, mult);
  if (amount <= EPS) return;

  const w = ctx.s.world;
  const idx = b.y * w.width + b.x;
  const radius = 1 + def.size;
  const tiles = radiusIndices(ctx.s, idx, radius);
  const centre = w.tiles[idx];
  if (centre) centre.pollution = clamp01(centre.pollution + amount);
  for (const i of tiles) {
    const t = w.tiles[i];
    if (!t) continue;
    t.pollution = clamp01(t.pollution + amount * 0.6);
  }
}

// ---------------------------------------------------------------------------
// Pollution is emitted from the main settlement pass through this hook.
// ---------------------------------------------------------------------------

/** Internal: called once per complete building per tick from the settlement loop. */
function emitForBuilding(ctx: SimContext, st: Settlement, b: Building): void {
  const def = ctx.c.buildings[b.typeId];
  if (!def) return;
  emitPollution(ctx, st, b, def);
}
