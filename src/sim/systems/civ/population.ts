/**
 * civil.population — the people themselves.
 * ----------------------------------------
 * One tick = one day of eating, drinking, working, learning, loving, ageing and
 * dying. Everything here is per-settlement and then per-citizen.
 *
 * Responsibilities
 *  - Consumption of food and water from settlement stores, subject to rations,
 *    the foodConsumption/waterConsumption modifiers, and a small wild-subsistence
 *    trickle so a lone settler beside a river does not die in the first week.
 *  - Needs satisfaction, health, morale, starvation/dehydration damage.
 *  - Homes: assign households into completed housing; track capacity/quality.
 *  - Education: children in schools, adults in libraries.
 *  - Marriage, pregnancy, birth, ageing, natural death.
 *  - Immigration and emigration driven by morale, food, housing and policy.
 *  - Level-of-detail folding: beyond `rules.detailedCitizenCap` the least
 *    important adults become aggregated cohorts that still eat and still work.
 *  - Settlement caches: population, morale, housing, foodDays, waterDays, stats.
 *
 * Determinism: only ctx.rng() (directly, or via a seeded Rng for citizen
 * creation). Never Math.random/Date.now.
 */
import type {
  Building,
  BuildingDef,
  Citizen,
  Cohort,
  Content,
  GameRules,
  GameState,
  Settlement,
  SimContext,
  SimSystem,
} from '../../types';
import { DAYS_PER_YEAR } from '../../types';
import { LIMITS } from '../../config';
import {
  buildingDef,
  clamp,
  foodDaysOf,
  foodUnits,
  isFood,
  modOf,
  professionClass,
  pushNotification,
  removeStock,
  totalPopulation,
  waterDaysOf,
} from '../../core';
import { createCitizen, removeCitizen } from '../../state';
import { Rng, seedFromString } from '../../rng';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const PREGNANCY_DAYS = 48; // ~9 months of 4-day-ish weeks; 64-day years
const RATION_MULT: Record<'meager' | 'normal' | 'generous', number> = { meager: 0.78, normal: 1, generous: 1.22 };
const RATION_MORALE: Record<'meager' | 'normal' | 'generous', number> = { meager: -7, normal: 0, generous: 5 };

/** Fraction of daily water demand that can be drunk from a nearby river/lake. */
const WILD_WATER_SHARE = 0.55;
/** Base wild food trickle per citizen per day, thinned by crowding. */
const WILD_FOOD_BASE = 0.36;

interface ServiceTotals {
  health: number;
  education: number;
  culture: number;
  faith: number;
  safety: number;
  water: number;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function getBuildingMap(s: GameState): Map<number, Building> {
  const map = new Map<number, Building>();
  for (const b of s.buildings) map.set(b.id, b);
  return map;
}

function hasTrait(c: Citizen, trait: string): boolean {
  return c.traits.includes(trait);
}

function skillSum(c: Citizen): number {
  let total = 0;
  for (const k in c.skills) total += c.skills[k as keyof Citizen['skills']] ?? 0;
  return total;
}

/** Completed buildings that render a given service for a settlement. */
function serviceTotals(ctx: SimContext, st: Settlement): ServiceTotals {
  const out: ServiceTotals = { health: 0, education: 0, culture: 0, faith: 0, safety: 0, water: 0 };
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== st.id || b.progress < 1 || !b.enabled || b.condition < 0.25) continue;
    const def = buildingDef(ctx.c, b);
    if (!def?.service) continue;
    const kind = def.service.kind;
    const conditionFactor = 0.5 + 0.5 * b.condition;
    // Passive infrastructure (wells/aqueducts, temple and shrine auras) works
    // without a keeper; staffing only matters for health, education, culture and
    // safety services. (buildings.ts also folds coverage into settlement mods,
    // so applying a worker factor here would double-penalise the same service.)
    const passive = kind === 'water' || kind === 'faith';
    const staffFactor = passive
      ? 1
      : 0.4 + 0.6 * clamp(b.workers / Math.max(1, def.jobs.reduce((n, j) => n + j.count, 0)), 0, 1);
    const amount = def.service.amount * conditionFactor * staffFactor;
    if (kind in out) out[kind as keyof ServiceTotals] += amount;
  }
  return out;
}

/** Wild food and water a settlement can live off its immediate surroundings. */
function subsistence(ctx: SimContext, st: Settlement, population: number): { food: number; water: number } {
  const w = ctx.s.world;
  const cx = Math.round(st.x);
  const cy = Math.round(st.y);
  let forage = 0;
  let n = 0;
  let maxWater = 0;
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      if (dx * dx + dy * dy > 16) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
      const t = w.tiles[y * w.width + x];
      if (!t) continue;
      n++;
      // Foraging is a short walk; water is a bucket trip and a longer one.
      if (dx * dx + dy * dy <= 9) {
        forage += Math.max(0, t.forage) * 0.6 + Math.max(0, t.forest) * 0.25;
      }
      if (t.water > maxWater) maxWater = t.water;
    }
  }
  if (n === 0) return { food: 0, water: 0 };
  const wildFoodPerHead = Math.min(
    0.45,
    WILD_FOOD_BASE * (forage / Math.max(1, n * 0.6)) * (1 + modOf(ctx, st.id, 'forageYield')) * (1 / (1 + population / 40)),
  );
  // Fresh water within four tiles means nobody dies of thirst: people walk to
  // it with buckets. The carry gets thin as the settlement grows, so larger
  // populations need a well (or aqueduct) for full satisfaction.
  const nearWater = maxWater >= 0.25;
  const carryPenalty = 1 / (1 + Math.max(0, population - 10) / 40);
  const wildWaterPerHead = nearWater
    ? ctx.rules.waterPerCitizen * (0.98 - Math.max(0, 0.25 - maxWater) * 0.8) * carryPenalty
    : ctx.rules.waterPerCitizen * 0.18 * maxWater;
  return {
    food: Math.max(0, wildFoodPerHead) * population,
    water: Math.max(0, Math.min(ctx.rules.waterPerCitizen, wildWaterPerHead)) * population,
  };
}

/** Remove `units` edible food from a settlement, preferring to spread the load. */
function consumeFoodUnits(ctx: SimContext, st: Settlement, units: number): number {
  if (units <= 0) return 0;
  let remaining = units;
  let consumed = 0;
  // Work on a stable list largest-first so one bountiful store is not drained
  // while six others rot.
  const foods: { res: string; edible: number; stock: number; perishable: boolean }[] = [];
  for (const res in st.stock) {
    const def = ctx.c.resources[res];
    if (!def?.edible) continue;
    const stock = st.stock[res] ?? 0;
    if (stock <= 0) continue;
    foods.push({ res, edible: def.edible, stock, perishable: !!def.perishable });
  }
  foods.sort((a, b) => b.stock * b.edible - a.stock * a.edible);
  for (const f of foods) {
    if (remaining <= 0) break;
    const takeUnits = Math.min(remaining, f.stock * f.edible);
    const takeItems = takeUnits / f.edible;
    const removed = removeStock(st, f.res, takeItems);
    const got = removed * f.edible;
    consumed += got;
    remaining -= got;
  }
  return consumed;
}

function foodVariety(ctx: SimContext, st: Settlement): number {
  let variety = 0;
  for (const res in st.stock) {
    if ((st.stock[res] ?? 0) > 0.5 && isFood(ctx.c, res)) variety++;
  }
  return variety;
}

// ---------------------------------------------------------------------------
// Housing
// ---------------------------------------------------------------------------

interface House {
  building: Building;
  capacity: number;
  quality: number;
  occupants: number;
}

function recomputeHousing(ctx: SimContext, st: Settlement, citizens: Citizen[]): void {
  const s = ctx.s;
  const houses: House[] = [];
  for (const b of s.buildings) {
    if (b.settlementId !== st.id || b.progress < 1 || !b.enabled) continue;
    const def = buildingDef(ctx.c, b);
    if (!def?.housing) continue;
    const damage = 0.4 + 0.6 * clamp(b.condition, 0, 1);
    houses.push({
      building: b,
      capacity: Math.max(1, Math.round(def.housing.capacity * (0.55 + 0.45 * damage))),
      quality: def.housing.quality * damage,
      occupants: 0,
    });
  }
  houses.sort((a, b) => b.quality - a.quality);
  const byId = new Map<number, House>();
  for (const h of houses) byId.set(h.building.id, h);

  // Drop invalid homes first.
  for (const c of citizens) {
    if (!c.alive) continue;
    if (c.homeBuildingId >= 0 && !byId.has(c.homeBuildingId)) c.homeBuildingId = -1;
  }
  // Keep existing occupants, highest quality first so evictions are fair.
  const citizensById = new Map<number, Citizen>();
  for (const c of citizens) citizensById.set(c.id, c);
  for (const c of citizens) {
    if (!c.alive || c.homeBuildingId < 0) continue;
    const house = byId.get(c.homeBuildingId);
    if (!house) {
      c.homeBuildingId = -1;
      continue;
    }
    if (house.occupants < house.capacity) house.occupants++;
    else {
      house.occupants = house.capacity; // others will be reassigned below
      c.homeBuildingId = -1;
    }
  }
  // Assign the homeless: keep spouses together where possible, then best house.
  const homeless = citizens.filter((c) => c.alive && c.homeBuildingId < 0);
  homeless.sort((a, b) => Number(b.age < 12) - Number(a.age < 12) || a.id - b.id);
  for (const c of homeless) {
    if (c.spouseId >= 0) {
      const spouse = citizensById.get(c.spouseId);
      if (spouse) {
        if (spouse.homeBuildingId >= 0) {
          const spouseHouse = byId.get(spouse.homeBuildingId);
          if (spouseHouse && spouseHouse.occupants < spouseHouse.capacity) {
            spouseHouse.occupants++;
            c.homeBuildingId = spouseHouse.building.id;
            continue;
          }
        } else if (spouse.alive && spouse.homeBuildingId < 0) {
          continue; // spouse will be assigned just after; handled below
        }
      }
    }
    let best: House | null = null;
    for (const house of houses) {
      if (house.occupants >= house.capacity) continue;
      if (!best || house.quality > best.quality) best = house;
    }
    if (best) {
      best.occupants++;
      c.homeBuildingId = best.building.id;
    }
  }
  // Second pass: couples where one still lacks a home keep looking together.
  for (const c of citizens) {
    if (!c.alive || c.homeBuildingId >= 0 || c.spouseId < 0) continue;
    const spouse = citizensById.get(c.spouseId);
    if (!spouse || spouse.homeBuildingId < 0) continue;
    const house = byId.get(spouse.homeBuildingId);
    if (house && house.occupants < house.capacity) {
      house.occupants++;
      c.homeBuildingId = house.building.id;
    }
  }

  let capacity = 0;
  let qualitySum = 0;
  let qualityWeight = 0;
  for (const h of houses) {
    capacity += h.capacity;
    qualitySum += h.quality * h.capacity;
    qualityWeight += h.capacity;
  }
  st.housing.capacity = capacity;
  st.housing.occupied = houses.reduce((n, h) => n + Math.min(h.occupants, h.capacity), 0);
  st.housing.quality = qualityWeight > 0 ? Math.round((qualitySum / qualityWeight) * 10) / 10 : 0;
  let homelessCount = 0;
  for (const c of citizens) if (c.alive && c.homeBuildingId < 0) homelessCount++;
  for (const co of s.cohorts) if (co.settlementId === st.id && co.count > 0) homelessCount += Math.round(co.count * 0.15);
  st.homeless = homelessCount;
  st.housingDays = Math.max(0, capacity - st.population);
  void modOf(ctx, st.id, 'housingQuality');
}

// ---------------------------------------------------------------------------
// Death & departure
// ---------------------------------------------------------------------------

function ageMortality(age: number): number {
  if (age < 45) return 0.000015;
  if (age < 55) return 0.00012;
  if (age < 60) return 0.0004;
  if (age < 65) return 0.0011;
  if (age < 70) return 0.0026;
  if (age < 75) return 0.0055;
  if (age < 80) return 0.011;
  if (age < 85) return 0.022;
  return 0.05;
}

function bereave(ctx: SimContext, dead: Citizen, cause: string, byBuilding: Map<number, Building>): void {
  const s = ctx.s;
  const spouse = dead.spouseId >= 0 ? s.citizens.find((c) => c.id === dead.spouseId) : null;
  if (spouse && spouse.alive) {
    spouse.morale = clamp(spouse.morale - 20, 0, 100);
    spouse.thoughts.unshift(`I lost ${dead.name}. The house is too quiet.`);
    if (spouse.thoughts.length > 6) spouse.thoughts.length = 6;
  }
  for (const id of dead.childIds) {
    const child = s.citizens.find((c) => c.id === id);
    if (child?.alive) {
      child.morale = clamp(child.morale - 12, 0, 100);
      child.thoughts.unshift(`I miss ${dead.name}.`);
      if (child.thoughts.length > 6) child.thoughts.length = 6;
    }
  }
  for (const id of dead.friendIds) {
    const friend = s.citizens.find((c) => c.id === id);
    if (friend?.alive) friend.morale = clamp(friend.morale - 5, 0, 100);
  }
  // Households lose the income earner's home slot naturally on next assignment.
  void byBuilding;
  if (dead.notable) {
    ctx.chronicle(
      `${dead.name} ${dead.surname} dies`,
      `${dead.name} ${dead.surname}, ${Math.floor(dead.age)} winters old, ${cause === 'old age' ? 'closed their eyes by their own hearth' : `died of ${cause}`}. ${spouse?.alive ? `${spouse.name} keeps the fire.` : 'The house keeps its quiet.'}`,
      'society',
      2,
    );
  }
}

function departCitizen(ctx: SimContext, st: Settlement, c: Citizen, reason: string): void {
  const s = ctx.s;
  c.alive = false;
  c.deathTick = ctx.tick;
  c.deathCause = reason;
  if (c.spouseId >= 0) {
    const spouse = s.citizens.find((x) => x.id === c.spouseId);
    if (spouse) {
      spouse.spouseId = -1;
      spouse.morale = clamp(spouse.morale - 10, 0, 100);
      spouse.thoughts.unshift(`${c.name} left for another valley.`);
      if (spouse.thoughts.length > 6) spouse.thoughts.length = 6;
    }
  }
  const idx = s.citizens.indexOf(c);
  if (idx >= 0) s.citizens.splice(idx, 1);
  st.stats.departures++;
  if (c.notable) {
    ctx.notify(`${c.name} ${c.surname} has left ${st.name}.`, 'bad', 'homesick');
  }
}

// ---------------------------------------------------------------------------
// Couples, pregnancy, birth
// ---------------------------------------------------------------------------

function isFertile(c: Citizen): boolean {
  return (
    c.alive &&
    c.sex === 'f' &&
    c.age >= LIMITS.fertileMinAge &&
    c.age <= LIMITS.fertileMaxAge &&
    c.health > 45 &&
    c.hunger < 78 &&
    !c.pregnant
  );
}

function makeSpawnRng(ctx: SimContext, salt: string): Rng {
  // Advance the sacred stream so the world moves on regardless of how many
  // citizens we create, then derive a salt-unique sub-stream.
  ctx.rng();
  const s = ctx.s;
  const label = `${s.seed}:${salt}:${s.tick}:${s.nextIds.citizen}:${s.rng[0].toString(36)}:${s.rng[1].toString(36)}`;
  return new Rng(seedFromString(label));
}

function birth(ctx: SimContext, st: Settlement, mother: Citizen, byId: Map<number, Building>): void {
  const s = ctx.s;
  const father = mother.pregnant && mother.pregnant.fatherId >= 0 ? s.citizens.find((c) => c.id === mother.pregnant!.fatherId) : null;
  const rng = makeSpawnRng(ctx, 'birth');
  const child = createCitizen(s, ctx.c, rng, {
    settlementId: st.id,
    age: 0,
    surname: father?.surname ?? mother.surname,
    family: { parentIds: [mother.id, ...(father ? [father.id] : [])] },
  });
  child.origin = 'born';
  child.health = 84;
  child.morale = 78;
  child.homeBuildingId = mother.homeBuildingId;
  mother.pregnant = null;
  mother.health = clamp(mother.health - 4, 0, 100);
  mother.childIds.push(child.id);
  mother.morale = clamp(mother.morale + 12, 0, 100);
  mother.needs.purpose = clamp(mother.needs.purpose + 10, 0, 100);
  if (father) {
    father.childIds.push(child.id);
    father.morale = clamp(father.morale + 10, 0, 100);
  }
  st.stats.births++;
  const small = st.population < 24;
  if (small || s.stats.citizensBorn % 6 === 0) {
    ctx.notify(
      `A child is born to ${mother.name}${father ? ` and ${father.name}` : ''}: ${child.name} ${child.surname}.`,
      'good',
      'heart',
    );
  }
  void byId;
}

// ---------------------------------------------------------------------------
// Main per-citizen pass
// ---------------------------------------------------------------------------

interface SettlementDay {
  st: Settlement;
  citizens: Citizen[];
  foodSat: number; // 0..100
  waterSat: number;
  service: ServiceTotals;
  variety: number;
  unemploymentRate: number;
  avgMorale: number;
  avgHealth: number;
}

function processCitizen(ctx: SimContext, day: SettlementDay, c: Citizen, byId: Map<number, Building>): void {
  const s = ctx.s;
  const { st, service } = day;
  const rations = s.society.rations;
  const mods = ctx.mods;

  // ---- needs: food & water -------------------------------------------------
  c.needs.food = clamp(c.needs.food + (day.foodSat - c.needs.food) * 0.45, 0, 100);
  c.needs.water = clamp(c.needs.water + (day.waterSat - c.needs.water) * 0.55, 0, 100);
  if (day.foodSat >= 92) {
    c.hunger = clamp(c.hunger - 14, 0, 100);
    c.lastMealTick = ctx.tick;
  } else {
    c.hunger = clamp(c.hunger + (100 - day.foodSat) * 0.42, 0, 100);
  }
  if (day.waterSat >= 92) c.thirst = clamp(c.thirst - 22, 0, 100);
  else c.thirst = clamp(c.thirst + (100 - day.waterSat) * 0.5, 0, 100);

  // ---- needs: shelter & warmth --------------------------------------------
  const home = c.homeBuildingId >= 0 ? byId.get(c.homeBuildingId) : null;
  const homeDef: BuildingDef | undefined = home ? buildingDef(ctx.c, home) : undefined;
  const homeQuality = homeDef?.housing?.quality ?? 0;
  c.needs.shelter = clamp((home ? 42 + homeQuality * 12 : 14) + (home ? 0 : st.housing.capacity > 0 ? 8 : 0), 0, 100);
  const temp = s.world.weather.temperature;
  const warmthBase = temp >= 16 ? 78 : temp >= 8 ? 64 : temp >= 0 ? 46 : 30;
  c.needs.warmth = clamp(warmthBase + homeQuality * 7 + (home ? 6 : 0) + service.water * 0.05, 0, 100);
  c.needs.social = clamp(
    48 + (c.spouseId >= 0 ? 12 : 0) + c.childIds.length * 4 + c.friendIds.length * 3 + (s.society.festivals.length ? 6 : 0) - (c.traits.includes('wanderer') ? 6 : 0),
    0,
    100,
  );
  const employed = c.jobBuildingId >= 0;
  c.needs.purpose = clamp((employed ? 58 : c.age < 12 ? 40 : 30) + c.education * 0.12 + (c.traits.includes('ambitious') ? 8 : 0), 0, 100);
  const tile = s.world.tiles[Math.floor(st.y) * s.world.width + Math.floor(st.x)];
  c.needs.comfort = clamp(20 + homeQuality * 9 + (tile ? tile.beauty * 20 : 0) + service.culture * 0.1 + service.faith * 0.06, 0, 100);

  // ---- health --------------------------------------------------------------
  const pollution = Math.max(0, (tile?.pollution ?? 0) * 100);
  let healthTarget =
    30 +
    c.needs.food * 0.13 +
    c.needs.water * 0.12 +
    c.needs.shelter * 0.16 +
    c.needs.warmth * 0.1 +
    service.health * 0.35 +
    modOf(ctx, st.id, 'healthRate') * 60 -
    c.hunger * 0.22 -
    c.thirst * 0.3 -
    pollution * 0.1 -
    s.society.crime * 0.05;
  if (c.age < 12) healthTarget += 4;
  if (c.age > 60) healthTarget -= (c.age - 60) * 0.85;
  if (c.pregnant) healthTarget -= 5;
  healthTarget = clamp(healthTarget, 0, 100);
  const healthRate = clamp(1 + modOf(ctx, st.id, 'healthRate'), 0.4, 1.8);
  c.health = clamp(c.health + (healthTarget - c.health) * 0.055 * healthRate, 0, 100);

  // Starvation and thirst are lethal, but only in a real famine: a settlement
  // that is merely short rations gets hungry and weak, while one with almost
  // nothing left loses people. (Lead's fairness rule: no deaths until supply is
  // below ~a third of demand, so warnings always arrive before the funerals.)
  const frail = c.age < 6 || c.age > 65 ? 1.3 : 1;
  // Damage worsens as the body weakens, so decline is a slope rather than a
  // plateau: a starving settlement loses people within a couple of weeks.
  const weakFactor = 1 + Math.max(0, 60 - c.health) / 60;
  const trueFamine = day.foodSat < 32;
  const trueDrought = day.waterSat < 32 && (c.thirst > 90 || !day.foodSat);
  if (trueFamine && c.hunger > 75) {
    const severity = (c.hunger - 75) / 25;
    const damage =
      LIMITS.starvationHealthLoss * severity * (1 + severity * 1.6) * frail * weakFactor * (1 + Math.max(0, mods.deathRate ?? 0));
    c.health = clamp(c.health - damage, 0, 100);
  }
  if (trueDrought && c.thirst > 70) {
    const severity = (c.thirst - 70) / 30;
    const damage = LIMITS.dehydrationHealthLoss * severity * (1 + severity * 1.4) * frail * weakFactor;
    c.health = clamp(c.health - damage, 0, 100);
  }
  if (c.needs.warmth < 25 && temp < 0) {
    c.health = clamp(c.health - (25 - c.needs.warmth) * 0.045, 0, 100);
  }
  c.needs.health = c.health;

  // ---- morale -------------------------------------------------------------
  let moraleTarget = 32;
  moraleTarget += c.needs.food * 0.15 + c.needs.water * 0.09 + c.needs.shelter * 0.08 + c.needs.warmth * 0.04;
  moraleTarget += c.needs.social * 0.07 + c.needs.purpose * 0.06 + c.needs.comfort * 0.05;
  moraleTarget += day.unemploymentRate * -10;
  moraleTarget += (s.society.approval - 50) * 0.14;
  moraleTarget += (s.society.stability - 60) * 0.05;
  moraleTarget -= s.society.crime * 0.1;
  moraleTarget -= Math.max(0, pollution) * 0.18;
  moraleTarget += Math.min(12, service.faith * 0.12 + service.culture * 0.1 + service.health * 0.05);
  moraleTarget += RATION_MORALE[rations];
  moraleTarget += (limitWorkHoursOffset(s)) ;
  moraleTarget -= s.society.taxRate * 40;
  moraleTarget += modOf(ctx, st.id, 'moraleFlat');
  if (c.age < 12) moraleTarget += 4;
  if (c.age > 65) moraleTarget -= 2;
  if (hasTrait(c, 'stoic')) moraleTarget += 7;
  if (hasTrait(c, 'dreamer')) moraleTarget += 3;
  if (hasTrait(c, 'haunted')) moraleTarget -= 9;
  if (hasTrait(c, 'gentle')) moraleTarget += 2;
  if (hasTrait(c, 'ambitious') && !employed) moraleTarget -= 6;
  if (c.spouseId >= 0) {
    const spouse = s.citizens.find((x) => x.id === c.spouseId);
    if (spouse && !spouse.alive) moraleTarget -= 14;
    else if (spouse) moraleTarget += 4;
  }
  if (s.society.festivals.length > 0) moraleTarget += 2;
  if (s.research.doctrine === 'hearthkeepers') moraleTarget += 3;
  if (s.research.doctrine === 'chroniclers') moraleTarget += 1;
  // A perfect 100 should be earned with festivals, faith and culture, not just
  // a full belly on a mild day.
  const moraleCeiling = 90 + Math.min(10, service.faith * 0.15 + service.culture * 0.12 + (s.society.festivals.length > 0 ? 3 : 0));
  moraleTarget = clamp(moraleTarget, 0, moraleCeiling);
  const moraleRate = 1 + modOf(ctx, st.id, 'moraleRate');
  c.morale = clamp(c.morale + (moraleTarget - c.morale) * 0.075 * moraleRate, 0, 100);

  // ---- a little wealth accumulates from wages, so classes have substance ----
  const wage = employed ? Math.max(0.05, c.income || 0.35) : 0;
  c.wealth = clamp(c.wealth + wage * 0.06 - 0.015, 0, 5000);

  // ---- ageing --------------------------------------------------------------
  const prevAge = c.age;
  c.age += 1 / DAYS_PER_YEAR;
  if (prevAge < 12 && c.age >= 12) {
    c.thoughts.unshift('I am old enough to help now.');
    c.morale = clamp(c.morale + 3, 0, 100);
  }
  if (prevAge < 16 && c.age >= 16 && c.profession === 'child') c.profession = 'idle';
  if (prevAge < 18 && c.age >= 18) {
    // Adulthood: pair up with an available partner in the settlement.
    void byId;
  }
}

function limitWorkHoursOffset(s: GameState): number {
  if (s.society.workHours >= 12) return -6;
  if (s.society.workHours <= 8) return 4;
  return 0;
}

// ---------------------------------------------------------------------------
// Per-settlement pass
// ---------------------------------------------------------------------------

function processSettlement(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  const rules: GameRules = ctx.rules;
  if (st.population < 0) st.population = 0;

  let citizens = s.citizens.filter((c) => c.alive && c.settlementId === st.id);
  const byId = getBuildingMap(s);

  // Cohorts belonging to this settlement.
  let cohortCount = 0;
  for (const co of s.cohorts) if (co.settlementId === st.id && co.count > 0) cohortCount += co.count;
  const totalPop = citizens.length + cohortCount;
  if (totalPop === 0) {
    st.population = 0;
    st.morale = Math.max(0, st.morale - 1);
    st.housing.occupied = 0;
    st.homeless = 0;
    st.foodDays = foodDaysOf(s, ctx.c, st);
    st.waterDays = waterDaysOf(s, st);
    return;
  }

  recomputeHousing(ctx, st, citizens);

  // ---- consumption ---------------------------------------------------------
  const rations = s.society.rations;
  const foodMod = 1 + modOf(ctx, st.id, 'foodConsumption');
  const waterMod = 1 + modOf(ctx, st.id, 'waterConsumption');
  const demandFood = totalPop * rules.foodPerCitizen * RATION_MULT[rations] * Math.max(0.2, foodMod);
  const demandWater = totalPop * rules.waterPerCitizen * Math.max(0.2, waterMod);
  const wild = subsistence(ctx, st, totalPop);
  const foodFromStock = consumeFoodUnits(ctx, st, Math.max(0, demandFood - wild.food));
  const foodSupplied = Math.min(demandFood, wild.food + foodFromStock);
  let waterFromStock = 0;
  if (demandWater > wild.water) waterFromStock = removeStock(st, 'water', demandWater - wild.water);
  const waterSupplied = Math.min(demandWater, wild.water + waterFromStock);
  if (foodSupplied > 0) st.stats.foodConsumed += foodSupplied;
  const foodSat = clamp((foodSupplied / Math.max(0.001, demandFood)) * 100, 0, 100);
  const waterSat = clamp((waterSupplied / Math.max(0.001, demandWater)) * 100, 0, 100);

  // Average state for morale/health targets.
  let moraleSum = 0;
  let healthSum = 0;
  let workingAdults = 0;
  let employedAdults = 0;
  for (const c of citizens) {
    moraleSum += c.morale;
    healthSum += c.health;
    if (c.age >= 16) {
      workingAdults++;
      if (c.jobBuildingId >= 0) employedAdults++;
    }
  }
  for (const co of s.cohorts) {
    if (co.settlementId !== st.id || co.count <= 0) continue;
    moraleSum += co.morale * co.count;
    healthSum += co.health * co.count;
  }
  const avgMorale = moraleSum / Math.max(1, totalPop);
  const avgHealth = healthSum / Math.max(1, totalPop);

  const day: SettlementDay = {
    st,
    citizens,
    foodSat,
    waterSat,
    service: serviceTotals(ctx, st),
    variety: foodVariety(ctx, st),
    unemploymentRate: st.workforce > 0 ? st.unemployed / st.workforce : 0,
    avgMorale,
    avgHealth,
  };

  // ---- per-citizen ---------------------------------------------------------
  for (const c of citizens) processCitizen(ctx, day, c, byId);

  // ---- births --------------------------------------------------------------
  const housingSpare = st.housing.capacity - st.housing.occupied;
  if (housingSpare > 0 && foodSat > 45 && st.foodDays > 5 && avgMorale > 30) {
    for (const c of citizens) {
      if (!isFertile(c)) continue;
      if (c.homeBuildingId < 0) continue; // a couple needs a roof before a cradle
      if (c.spouseId < 0) continue;
      const spouse = s.citizens.find((x) => x.id === c.spouseId);
      if (!spouse || !spouse.alive) continue;
      if (spouse.homeBuildingId < 0) continue;
      if (st.foodDays < 5) continue; // no cradles in a thin larder
      let chance = rules.birthChance;
      chance *= 1 + modOf(ctx, st.id, 'birthRate');
      chance *= 1 + (c.age >= 20 && c.age <= 34 ? 0.25 : 0);
      chance *= (avgMorale / 60) * (avgHealth / 70);
      chance *= st.foodDays > 12 ? 1.15 : 0.85;
      chance *= rations === 'generous' ? 1.2 : rations === 'meager' ? 0.75 : 1;
      if (hasTrait(c, 'gentle') || hasTrait(c, 'loyal')) chance *= 1.08;
      if (hasTrait(c, 'frail')) chance *= 0.8;
      chance *= clamp(housingSpare / 3, 0.4, 1.4);
      if (ctx.rng() < chance) {
        c.pregnant = { fatherId: spouse.id, dueTick: ctx.tick + PREGNANCY_DAYS };
        c.health = clamp(c.health - 1.5, 0, 100);
        c.thoughts.unshift('There is a new life coming.');
        if (c.thoughts.length > 6) c.thoughts.length = 6;
      }
    }
  }
  for (const c of citizens) {
    if (!c.pregnant) continue;
    if (ctx.tick >= c.pregnant.dueTick) birth(ctx, st, c, byId);
  }

  // ---- marriage ------------------------------------------------------------
  if (ctx.tick % 4 === 0 && totalPop < 400) {
    const singles = citizens.filter(
      (c) => c.alive && c.spouseId < 0 && c.age >= 18 && c.age <= 45 && !c.pregnant,
    );
    for (const c of singles) {
      if (c.spouseId >= 0) continue;
      let best: Citizen | null = null;
      let bestScore = -Infinity;
      for (const other of singles) {
        if (other.id === c.id || other.spouseId >= 0 || other.sex === c.sex) continue;
        if (other.settlementId !== c.settlementId) continue;
        const score = 20 - Math.abs(c.age - other.age) + (other.id < c.id ? 4 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = other;
        }
      }
      if (best && ctx.rng() < 0.38) {
        c.spouseId = best.id;
        best.spouseId = c.id;
        c.morale = clamp(c.morale + 8, 0, 100);
        best.morale = clamp(best.morale + 8, 0, 100);
        c.thoughts.unshift(`I have found someone: ${best.name}.`);
        if (ctx.rng() < 0.4) {
          ctx.notify(`${c.name} and ${best.name} were wed before the hearth.`, 'good', 'heart');
        }
      }
    }
    // friendships
    if (citizens.length < 120) {
      for (const c of citizens) {
        if (c.friendIds.length >= 3) continue;
        if (ctx.rng() < 0.08) {
          const other = citizens[Math.floor(ctx.rng() * citizens.length)];
          if (other && other.id !== c.id && !c.friendIds.includes(other.id)) {
            c.friendIds.push(other.id);
            other.friendIds.push(c.id);
            if (c.friendIds.length > 6) c.friendIds.length = 6;
            if (other.friendIds.length > 6) other.friendIds.length = 6;
          }
        }
      }
    }
  }

  // ---- education -----------------------------------------------------------
  const educationRate = 1 + modOf(ctx, st.id, 'educationRate');
  const children = citizens.filter((c) => c.alive && c.age >= 6 && c.age < 17);
  const schoolCapacity = Math.max(1, day.service.education);
  for (const c of children) {
    const coverage = clamp(schoolCapacity / Math.max(1, children.length), 0, 1);
    if (coverage > 0.15) {
      c.education = clamp(c.education + 0.35 * coverage * educationRate, 0, 100);
      if (c.age >= 12 && c.age < 17) c.profession = 'student';
    }
  }
  if (day.service.culture > 0 || day.service.education > 12) {
    for (const c of citizens) {
      if (c.alive && c.age >= 17 && ctx.rng() < 0.02 * educationRate) {
        c.education = clamp(c.education + 0.15, 0, 100);
      }
    }
  }

  // ---- famine exodus: families leave before the dying starts -----------------
  // Emigration is the safety valve: people would rather walk to a cousin's
  // hearth than starve in yours. This happens *before* death rolls so a doomed
  // winter sheds people instead of corpses, and it is visible in the chronicle.
  let famineExodusToday = 0;
  if (st.foodDays < 2 && avgMorale < 45 && citizens.length > 2) {
    const doomed = st.foodDays < 0.5 && avgMorale < 20;
    const foodAvailable = foodUnits(ctx.c, st) > 1;
    const rate = 0.01 + clamp((45 - avgMorale) / 100, 0, 0.02); // 1-3% of adults/day
    const leavers = citizens.filter((c) => c.alive && !c.notable && c.age >= 16 && c.childIds.length === 0 && !c.pregnant);
    for (const leaver of leavers) {
      if (!doomed && citizens.length - famineExodusToday <= 2) break;
      if (foodAvailable && citizens.length - famineExodusToday <= 2) break;
      if (ctx.rng() >= rate) continue;
      departCitizen(ctx, st, leaver, 'left for a better larder');
      famineExodusToday++;
    }
    if (famineExodusToday > 0) {
      ctx.notify(
        `Families are leaving ${st.name}. The stores are empty and people would rather walk than starve.`,
        'bad',
        'homesick',
      );
      st.morale = clamp(st.morale - 2, 0, 100);
    }
  }

  // ---- natural death -------------------------------------------------------
  const deathRate = 1 + Math.max(0, modOf(ctx, st.id, 'deathRate'));
  let starvedToday = 0;
  for (const c of citizens) {
    if (!c.alive) continue;
    let p = ageMortality(c.age);
    if (c.health < 55) p *= 1 + ((55 - c.health) / 55) * 2.5;
    if (c.hunger > 75) p *= 1.6;
    if (c.thirst > 75) p *= 1.8;
    if (s.world.weather.season === 'winter' && c.needs.warmth < 35) p *= 1.4;
    if (c.health <= 0.5) p = 1;
    p *= deathRate;
    if (ctx.rng() < p) {
      const cause = c.hunger > 70 ? 'starvation' : c.thirst > 70 ? 'thirst' : c.health < 30 ? 'illness' : 'old age';
      if (cause === 'starvation' || cause === 'thirst') starvedToday++;
      const spouseAlive = c.spouseId >= 0;
      const children = c.childIds.filter((id) => s.citizens.some((x) => x.id === id && x.alive));
      removeCitizen(s, c, cause);
      st.stats.deaths++;
      if (cause === 'starvation' || cause === 'thirst') {
        // removeCitizen already counts starvation in citizensStarved.
        if (cause === 'thirst') s.stats.citizensStarved++;
        ctx.notify(`${c.name} ${c.surname} died of ${cause}. The stores were not enough.`, 'bad', 'hunger');
      }
      if (children.length || spouseAlive || c.notable || st.population < 30) {
        bereave(ctx, c, cause, byId);
      }
    }
  }
  if (starvedToday > 0) st.stats.daysStarving++;

  // ---- immigration & emigration --------------------------------------------
  citizens = s.citizens.filter((c) => c.alive && c.settlementId === st.id);
  const migrationMod = 1 + modOf(ctx, st.id, 'migrationRate');
  const openBorders = !!s.society.policies['open_borders'];
  const closedBorders = !!s.society.policies['closed_borders'];
  const spareBeds = Math.max(0, st.housing.capacity - st.housing.occupied);
  const foodStockUnits = foodUnits(ctx.c, st);
  const winter = s.world.weather.season === 'winter';
  // Nobody joins a settlement that cannot feed the people it already has. This
  // is the main guard against immigration-driven overshoot into a famine.
  const foodSurplus = st.foodDays > 5 && foodStockUnits >= totalPop * 2;
  const canTakeOne = foodSurplus && st.foodDays > (winter ? 8 : 6);
  const canTakeTwo = foodSurplus && st.foodDays > (winter ? 12 : 10);
  const foodFactor = clamp(st.foodDays / 10, 0.15, 1.15);
  let moraleFactor = clamp(avgMorale / 60, 0.25, 1.3);
  if (openBorders) moraleFactor *= 1.2;
  if (closedBorders) moraleFactor *= 0.7;
  if (s.society.approval < 30) moraleFactor *= 0.6;

  const spawnImmigrants = (count: number, source: string): number => {
    if (count <= 0) return 0;
    const rng = makeSpawnRng(ctx, source);
    let made = 0;
    // Balance the sexes so wandering men and women both find partners.
    let men = 0;
    let women = 0;
    for (const c of s.citizens) {
      if (!c.alive || c.settlementId !== st.id || c.age < 16 || c.age > 45) continue;
      if (c.sex === 'm') men++;
      else women++;
    }
    for (let i = 0; i < count; i++) {
      if (totalPopulation(s) >= LIMITS.maxCitizens) break;
      const sex: 'm' | 'f' = men <= women ? (ctx.rng() < 0.7 ? 'm' : 'f') : ctx.rng() < 0.7 ? 'f' : 'm';
      if (sex === 'm') men++;
      else women++;
      const migrant = createCitizen(s, ctx.c, rng, {
        settlementId: st.id,
        age: Math.round(16 + ctx.rng() * 19),
        sex,
        profession: 'idle',
      });
      migrant.origin = 'migrant';
      migrant.health = clamp(62 + ctx.rng() * 28, 0, 100);
      migrant.morale = clamp(48 + ctx.rng() * 24, 0, 100);
      s.stats.migrantsArrived++;
      st.stats.arrivals++;
      st.population += 1;
      made++;
    }
    if (made > 0) {
      ctx.notify(
        made > 1
          ? `A family of ${made} arrives at ${st.name} asking for a place by the fire.`
          : `A traveller arrives at ${st.name} asking for a place by the fire.`,
        'good',
        'footsteps',
      );
    }
    return made;
  };

  // The first companion: guaranteed by day 5 as soon as there is a spare bed.
  if (st.population <= 2 && spareBeds > 0 && st.foodDays > 3 && ctx.tick >= 4) {
    spawnImmigrants(Math.min(1, spareBeds), 'first-wanderer');
  } else if (ctx.tick >= 6 && ctx.tick % 3 === 0 && spareBeds > 0 && canTakeOne) {
    // Word of a growing hearth travels with pedlars and herdsmen. Spare beds and
    // a full larder are both binding: no roof or no surplus, no newcomer.
    const foodSurplusBonus = st.foodDays > 10 ? 0.15 : st.foodDays > 5 ? 0.06 : 0;
    const moraleBonus = avgMorale > 65 ? 0.08 : 0;
    let chance = clamp(0.12 + 0.22 * spareBeds + foodSurplusBonus + moraleBonus, 0, 0.8);
    chance *= Math.max(0.2, migrationMod);
    if (openBorders) chance *= 1.1;
    if (closedBorders) chance *= 0.75;
    if (s.difficulty === 'harsh') chance *= 0.8;
    if (ctx.rng() < chance) {
      // Families only travel when there is enough to eat; singles when merely tight.
      const wantsTwo = canTakeTwo && chance > 0.5 && ctx.rng() < 0.4;
      const wanted = Math.min(spareBeds, wantsTwo ? 2 : 1);
      spawnImmigrants(Math.max(1, wanted), 'immigrant');
    }
  }

  // Anti-stall telemetry: a settlement with beds and food that stops growing is
  // a balance bug, not a design feature. Log it so QA can find it.
  const lastPopKey = `pop_last:${st.id}`;
  const lastPopTickKey = `pop_flat_since:${st.id}`;
  const lastPop = s.flags[lastPopKey] ?? -1;
  if (lastPop !== st.population) {
    s.flags[lastPopKey] = st.population;
    s.flags[lastPopTickKey] = ctx.tick;
  } else if (st.population > 1 && spareBeds >= 2 && st.foodDays > 6) {
    const since = s.flags[lastPopTickKey] ?? ctx.tick;
    if (ctx.tick - since >= 20) {
      s.flags[lastPopTickKey] = ctx.tick; // don't spam
      ctx.log(
        `population: ${st.name} has been flat at ${st.population} for ${ctx.tick - since}+ days with ${spareBeds} spare beds and ${st.foodDays.toFixed(1)} food days`,
      );
    }
  }

  // Emigration: the miserable vote with their feet (not twice in one day).
  const hopeless = famineExodusToday === 0 && (avgMorale < 26 || (st.foodDays < 1 && citizens.length > 2));
  if (hopeless && citizens.length > 1 && ctx.rng() < 0.018 + (30 - avgMorale) * 0.0008) {
    const leavers = citizens.filter((c) => !c.notable && c.age >= 16 && c.childIds.length === 0);
    if (leavers.length > 0) {
      const leaver = leavers[Math.floor(ctx.rng() * leavers.length)];
      if (leaver) {
        ctx.notify(`${leaver.name} ${leaver.surname} has given up on ${st.name} and gone.`, 'bad', 'homesick');
        departCitizen(ctx, st, leaver, 'emigrated');
      }
    }
  }

  // ---- cohorts (LOD) -------------------------------------------------------
  processCohorts(ctx, st, avgMorale, avgHealth);

  // ---- fold the least important adults ----
  foldPopulation(ctx, st);

  // ---- thoughts & notables -------------------------------------------------
  if (ctx.tick % 2 === 0) {
    for (const c of s.citizens) {
      if (!c.alive || c.settlementId !== st.id) continue;
      if ((ctx.tick + c.id) % 3 !== 0) continue;
      c.thoughts = makeThoughts(ctx, st, c, day);
      c.notable = detectNotable(c);
    }
  }

  // ---- settlement caches ---------------------------------------------------
  let population = 0;
  let moraleAll = 0;
  let healthAll = 0;
  for (const c of s.citizens) {
    if (c.alive && c.settlementId === st.id) {
      population++;
      moraleAll += c.morale;
      healthAll += c.health;
    }
  }
  for (const co of s.cohorts) {
    if (co.settlementId !== st.id || co.count <= 0) continue;
    population += co.count;
    moraleAll += co.morale * co.count;
    healthAll += co.health * co.count;
  }
  st.population = population;
  st.morale = population > 0 ? Math.round((moraleAll / population) * 10) / 10 : 0;
  st.stats.peakPopulation = Math.max(st.stats.peakPopulation, population);
  st.foodDays = Math.round(foodDaysOf(s, ctx.c, st) * 10) / 10;
  st.waterDays = Math.round(waterDaysOf(s, st) * 10) / 10;
  st.housing.occupied = Math.min(st.housing.capacity, st.housing.occupied);

  const avgHealthNow = population > 0 ? healthAll / population : 0;
  if (population > 10 && avgHealthNow < 30) {
    if (ctx.tick % 10 === 3) {
      ctx.notify(`Sickness spreads through ${st.name}. ${Math.round(avgHealthNow)} average health.`, 'bad', 'sick');
    }
  }
  if (population > 0 && st.foodDays < 0.5) {
    if (ctx.tick % 8 === 2) {
      ctx.notify(`The stores of ${st.name} are empty. People are going hungry.`, 'bad', 'hunger');
    }
  }
}

// ---------------------------------------------------------------------------
// Cohorts
// ---------------------------------------------------------------------------

function processCohorts(ctx: SimContext, st: Settlement, avgMorale: number, avgHealth: number): void {
  const s = ctx.s;
  const keep: Cohort[] = [];
  for (const co of s.cohorts) {
    if (co.settlementId !== st.id) {
      keep.push(co);
      continue;
    }
    if (co.count <= 0) continue;
    co.morale = clamp(co.morale + (avgMorale - co.morale) * 0.12, 0, 100);
    co.health = clamp(co.health + (avgHealth - co.health) * 0.12, 0, 100);
    // Abstract deaths from age/illness.
    let die = 0;
    const deathChance = co.ageBand === 'elder' ? 0.0022 : co.ageBand === 'child' ? 0.00015 : 0.00012;
    for (let i = 0; i < co.count; i++) {
      if (ctx.rng() < deathChance * (co.health < 40 ? 2.6 : 1)) die++;
    }
    if (die > 0 && co.count > 0) {
      co.count -= Math.min(die, co.count);
      s.stats.citizensDied += Math.min(die, co.count);
    }
    // Abstract births.
    if (co.ageBand === 'adult' && co.health > 50 && co.morale > 45 && ctx.rng() < 0.0022 * co.count) {
      co.count += 1;
      s.stats.citizensBorn += 1;
    }
    if (co.count > 0 && co.count < 900) keep.push(co);
  }
  s.cohorts = keep;
  void st;
}

function foldPopulation(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  const cap = Math.max(40, ctx.rules.detailedCitizenCap);
  const living = s.citizens.reduce((n, c) => n + (c.alive ? 1 : 0), 0);
  if (living <= cap) return;
  const target = Math.floor(cap * 0.9);
  let excess = living - target;
  if (excess <= 0) return;
  const candidates = s.citizens
    .filter(
      (c) =>
        c.alive &&
        !c.notable &&
        c.age >= 16 &&
        !c.pregnant &&
        c.spouseId < 0 &&
        c.childIds.length === 0 &&
        c.parentIds.every((id) => !s.citizens.some((x) => x.id === id && x.alive)),
    )
    .sort((a, b) => skillSum(a) - skillSum(b));
  for (const c of candidates) {
    if (excess <= 0) break;
    const ageBand: Cohort['ageBand'] = c.age < 25 ? 'young' : c.age < 62 ? 'adult' : 'elder';
    const profession: Cohort['profession'] =
      c.profession === 'child' ? 'child' : ctx.c.professions[c.profession] ? (c.profession as Cohort['profession']) : 'forager';
    let co = s.cohorts.find((x) => x.settlementId === c.settlementId && x.ageBand === ageBand && x.profession === profession);
    if (!co) {
      co = {
        id: s.nextIds.citizen++,
        settlementId: c.settlementId,
        profession,
        ageBand,
        count: 0,
        health: c.health,
        morale: c.morale,
        education: c.education,
      };
      s.cohorts.push(co);
    }
    const n = co.count;
    co.health = (co.health * n + c.health) / (n + 1);
    co.morale = (co.morale * n + c.morale) / (n + 1);
    co.education = (co.education * n + c.education) / (n + 1);
    co.count += 1;
    c.alive = false;
    c.deathTick = ctx.tick;
    c.deathCause = 'folded into the census';
    const idx = s.citizens.indexOf(c);
    if (idx >= 0) s.citizens.splice(idx, 1);
    excess--;
  }
  if (living > cap) ctx.log(`population: folded ${living - s.citizens.length} citizens into cohorts at ${st.name}`);
}

// ---------------------------------------------------------------------------
// Flavour
// ---------------------------------------------------------------------------

function makeThoughts(ctx: SimContext, st: Settlement, c: Citizen, day: SettlementDay): string[] {
  const s = ctx.s;
  const out: string[] = [];
  if (c.hunger > 70) out.push('My stomach has been empty for days.');
  else if (day.foodSat < 70) out.push('They are stretching the food again.');
  if (c.thirst > 65) out.push('There is never enough water.');
  if (c.homeBuildingId < 0) out.push('I sleep where the wind finds me.');
  if (c.health < 35) out.push('I am not well. My hands shake.');
  if (c.morale > 75) out.push('Life is good, for now.');
  else if (c.morale < 25) out.push('I wonder if there is a better valley.');
  if (c.jobBuildingId < 0 && c.age >= 16) out.push('I have no work to go to.');
  if (s.society.rations === 'meager') out.push('Meager rations. Again.');
  if (s.society.workHours >= 12) out.push('Long days. My back aches.');
  if (s.society.crime > 30) out.push('Things go missing at night.');
  if (c.pregnant) out.push('I am carrying a child. I hope they see spring.');
  if (c.spouseId >= 0) {
    const sp = s.citizens.find((x) => x.id === c.spouseId);
    if (sp?.alive) out.push(`It is easier with ${sp.name}.`);
  }
  if (c.age >= 62) out.push('My generation built this hearth. Let the young keep it.');
  if (c.skills.scholarship >= 50) out.push('There is a question I cannot put down.');
  if (st.foodDays > 20) out.push('The granary is full. We will see spring.');
  if (ctx.tick % 32 < 3) out.push(`Another ${s.world.weather.season} in ${st.name}.`);
  if (out.length === 0) out.push('A quiet day.');
  return out.slice(0, 3);
}

function detectNotable(c: Citizen): boolean {
  if (!c.alive) return false;
  if (c.notable) return true;
  let best = 0;
  for (const k in c.skills) {
    const v = c.skills[k as keyof Citizen['skills']] ?? 0;
    if (v > best) best = v;
  }
  return best >= 62 || c.education >= 68 || (c.age >= 72 && c.health > 40) || c.pregnant !== null;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const populationSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (s.settlements.length === 0) return;
  // Rebuild the full citizen list once; it can change while we run.
  for (const st of s.settlements) {
    try {
      const hasDetailed = s.citizens.some((c) => c.alive && c.settlementId === st.id);
      const hasCohorts = s.cohorts.some((co) => co.settlementId === st.id && co.count > 0);
      if (!hasDetailed && !hasCohorts) {
        // Truly empty: keep the caches honest without doing needless work.
        st.population = 0;
        st.foodDays = foodDaysOf(s, ctx.c, st);
        st.waterDays = waterDaysOf(s, st);
        continue;
      }
      processSettlement(ctx, st);
    } catch (err) {
      ctx.log(`population: settlement ${st.id} failed: ${(err as Error).message}`);
      pushNotification(s, 'The people are unsettled by strange reports (simulation recovered).', 'warn', 'warning');
    }
  }
  // Global lifetime bookkeeping.
  let living = 0;
  for (const c of s.citizens) if (c.alive) living++;
  for (const co of s.cohorts) living += co.count;
  if (living > s.stats.populationPeak) s.stats.populationPeak = living;
  s.society.lastElectionTick = s.society.lastElectionTick;
  void professionClass;
};
