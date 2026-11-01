/**
 * civil.jobs — work assignment.
 * -----------------------------
 * Every day the settlement's governor matches living, able adults to the job
 * slots of its buildings and to its construction sites.
 *
 * Rules of the house:
 *  - Work is assigned by settlement, highest priority building first, then
 *    category importance (water > food > shelter > industry > everything else).
 *  - A slot is filled by the best available citizen: skill for the slot, their
 *    trade, continuity with yesterday's job, health/morale and walk from home.
 *  - Construction sites are always crewed before ordinary production when
 *    `governor.autoAssign` is on; if it is off the roster is frozen and only
 *    construction (the player's explicit intent) is crewed.
 *  - Cohorts (LOD population) contribute abstract labour, filling slots that no
 *    detailed citizen can take.
 *  - Work slowly grows the governing skill; education and Industrious speed it.
 *
 * The system writes `citizen.profession`, `citizen.jobBuildingId`,
 * `building.workers`, `building.workerIds` and the settlement workforce caches.
 * Production reads those values; it must never write them.
 */
import type {
  Building,
  BuildingDef,
  Citizen,
  ProfessionId,
  Settlement,
  SimContext,
  SimSystem,
  SkillId,
} from '../../types';
import { LIMITS, RULES } from '../../config';
import { buildingDef, citizensOf, clamp, isWorkingAge, professionClass } from '../../core';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Category priority when the player has not set a building priority. */
const CATEGORY_WEIGHT: Record<string, number> = {
  // Food and gathering first: a settlement can live without a well-keeper but
  // not without a forager. Water infrastructure is passive (buildings.ts adds
  // service water) so its job slots must never outrank the food supply.
  food: 8,
  gathering: 7,
  storage: 4,
  industry: 4,
  energy: 4,
  science: 4,
  society: 3,
  logistics: 3,
  water: 3,
  defence: 2,
  housing: 1,
  beauty: 1,
  special: 2,
};

/** How many candidates we look at per slot. Keeps the system O(slots). */
const CANDIDATE_WINDOW = 28;

const INDUSTRIOUS_TRAITS = new Set(['industrious', 'quick', 'keen_eyed', 'ambitious', 'loyal']);
const FRAIL_TRAITS = new Set(['frail', 'haunted', 'stubborn']);

interface WorkSlot {
  profession: ProfessionId;
  skill: SkillId;
  count: number;
}

interface SlotOrder {
  building: Building;
  def: BuildingDef;
  priority: number;
  construction: boolean;
  slots: WorkSlot[];
}

interface Candidate {
  citizen: Citizen;
  best: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workingEligible(c: Citizen): boolean {
  // People work through hardship: a hungry settlement needs hands in the field,
  // not a workforce that all quits at once. Only the truly dying are excused.
  return c.alive && isWorkingAge(c.age) && c.health > 18 && c.hunger < 92 && c.thirst < 95;
}

function traitsBonus(c: Citizen): number {
  let bonus = 0;
  for (const t of c.traits) {
    if (INDUSTRIOUS_TRAITS.has(t)) bonus += 4;
    else if (FRAIL_TRAITS.has(t)) bonus -= 4;
  }
  return bonus;
}

/** Construction crew a site wants — more for bigger, longer builds. */
export function constructionCrew(def: BuildingDef): number {
  return clamp(Math.ceil(def.buildTicks / 2), 1, 4);
}

function buildingJobSlots(def: BuildingDef): WorkSlot[] {
  const out: WorkSlot[] = [];
  for (const job of def.jobs) {
    if (job.count > 0) out.push({ profession: job.profession, skill: job.skill, count: job.count });
  }
  return out;
}

/** Does the settlement have any education service? (children in school) */
function hasEducationService(ctx: SimContext, settlementId: number): boolean {
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== settlementId || b.progress < 1 || !b.enabled) continue;
    const def = buildingDef(ctx.c, b);
    if (def?.service?.kind === 'education') return true;
  }
  return false;
}

function setProfessionForIdle(c: Citizen, hasSchool: boolean): void {
  if (c.age < 12) {
    c.profession = 'child';
  } else if (c.age < 17 && hasSchool) {
    c.profession = 'student';
  } else {
    c.profession = 'idle';
  }
}

/** Ordered list of buildings a settlement wants crewed today. */
function collectSlotOrders(ctx: SimContext, st: Settlement): SlotOrder[] {
  const out: SlotOrder[] = [];
  // The governor reads the stores: when food or water is nearly gone, feeding
  // and watering the settlement outranks everything else in the roster.
  const hungry = st.foodDays < 7;
  const thirsty = st.waterDays < 5;
  const urgentPriority = (category: string): number => {
    let bump = 0;
    if (hungry && (category === 'food' || category === 'gathering')) bump += 90;
    if (thirsty && category === 'water') bump += 55;
    if (hungry && category === 'storage') bump += 25;
    return bump;
  };
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== st.id || !b.enabled || b.locked) continue;
    const def = buildingDef(ctx.c, b);
    if (!def) continue;
    if (b.progress < 1) {
      out.push({
        building: b,
        def,
        priority: 1000 + b.priority * 10,
        construction: true,
        slots: [{ profession: 'builder', skill: 'building', count: constructionCrew(def) }],
      });
      continue;
    }
    const slots = buildingJobSlots(def);
    if (slots.length === 0) continue;
    const catWeight = CATEGORY_WEIGHT[def.category] ?? 2;
    out.push({
      building: b,
      def,
      priority: b.priority * 10 + catWeight + urgentPriority(def.category),
      construction: false,
      slots,
    });
  }
  out.sort((a, b) => b.priority - a.priority || a.building.id - b.building.id);
  return out;
}

/** Size of the abstract LOD labour pool available to the settlement. */
function cohortLabour(ctx: SimContext, settlementId: number): number {
  let labour = 0;
  for (const co of ctx.s.cohorts) {
    if (co.settlementId !== settlementId || co.count <= 0) continue;
    if (co.ageBand === 'child') continue;
    const ageFactor = co.ageBand === 'elder' ? 0.25 : co.ageBand === 'young' ? 0.7 : 1;
    labour += co.count * ageFactor * RULES.laborFraction * (co.health > 40 ? 1 : 0.5);
  }
  return Math.max(0, labour);
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

function assignSettlement(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  const citizens = citizensOf(s, st.id);
  const auto = st.governor.autoAssign;
  const buildingById = new Map<number, Building>();
  for (const b of s.buildings) buildingById.set(b.id, b);

  // 1) Reset assignment caches; remember yesterday's work for continuity.
  const previous = new Map<number, number>();
  for (const c of citizens) {
    if (c.jobBuildingId >= 0) previous.set(c.id, c.jobBuildingId);
    c.jobBuildingId = -1;
  }
  for (const b of s.buildings) {
    if (b.settlementId !== st.id) continue;
    b.workers = 0;
    b.workerIds.length = 0;
  }

  // 2) Who could work today?
  const order = collectSlotOrders(ctx, st);
  const eligible: Citizen[] = [];
  for (const c of citizens) {
    if (!c.alive) continue;
    if (workingEligible(c)) eligible.push(c);
  }
  const assigned = new Set<number>();
  const hasSchool = hasEducationService(ctx, st.id);

  // Frozen roster: keep yesterday's workers where they were valid.
  const frozen = new Map<number, number[]>();
  if (!auto) {
    for (const c of eligible) {
      const prevId = previous.get(c.id);
      if (prevId === undefined) continue;
      const b = buildingById.get(prevId);
      if (!b || !b.enabled) continue;
      const arr = frozen.get(b.id) ?? [];
      const def = buildingDef(ctx.c, b);
      if (!def) continue;
      const cap = b.progress < 1 ? constructionCrew(def) : def.jobs.reduce((n, j) => n + Math.max(0, j.count), 0);
      if (arr.length >= cap) continue;
      arr.push(c.id);
      frozen.set(b.id, arr);
      assigned.add(c.id);
    }
  }

  // 3) Order candidates by best skill so window scans are meaningful.
  const pool: Candidate[] = [];
  for (const c of eligible) {
    if (assigned.has(c.id)) continue;
    let best = 0;
    for (const k in c.skills) {
      const v = c.skills[k as SkillId] ?? 0;
      if (v > best) best = v;
    }
    pool.push({ citizen: c, best: best + (traitsBonus(c) > 0 ? 4 : 0) + c.health * 0.03 });
  }
  pool.sort((a, b) => b.best - a.best);
  let cursor = 0;
  const advanceCursor = (): void => {
    while (cursor < pool.length) {
      const e = pool[cursor];
      if (!e || assigned.has(e.citizen.id)) cursor++;
      else break;
    }
  };
  advanceCursor();

  const scoreFor = (c: Citizen, slot: WorkSlot, b: Building): number => {
    let score = c.skills[slot.skill] ?? 0;
    if (c.profession === slot.profession) score += 20;
    else if (c.profession === 'idle' || c.profession === 'student' || c.profession === 'child') score += 2;
    if (previous.get(c.id) === b.id) score += 12;
    score += traitsBonus(c);
    score += c.health * 0.04;
    score += c.morale * 0.02;
    score += clamp(c.education, 0, 100) * 0.04;
    if (c.pregnant) score -= 6;
    const home = c.homeBuildingId >= 0 ? buildingById.get(c.homeBuildingId) : null;
    score -= (home ? Math.hypot(home.x - b.x, home.y - b.y) : 1.5) * 1.1;
    if (c.hunger > 55) score -= 12;
    if (c.thirst > 55) score -= 12;
    return score;
  };

  /** Fill `need` slots of one building from the candidate pool; returns hands placed. */
  const fillSlots = (b: Building, slot: WorkSlot, startCount: number, totalNeed: number): number => {
    let placed = 0;
    while (placed < totalNeed) {
      let bestIdx = -1;
      let bestScore = -Infinity;
      let scanned = 0;
      for (let i = cursor; i < pool.length && scanned < CANDIDATE_WINDOW; i++) {
        const entry = pool[i];
        if (!entry || assigned.has(entry.citizen.id)) continue;
        scanned++;
        const score = scoreFor(entry.citizen, slot, b);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        advanceCursor();
        for (let i = cursor; i < pool.length; i++) {
          const e = pool[i];
          if (e && !assigned.has(e.citizen.id)) {
            bestIdx = i;
            break;
          }
        }
      }
      if (bestIdx < 0) break;
      const c = pool[bestIdx]!.citizen;
      assigned.add(c.id);
      b.workerIds.push(c.id);
      b.workers = b.workerIds.length;
      c.jobBuildingId = b.id;
      c.profession = slot.profession;
      c.income = 0.4 + Math.min(2, (c.skills[slot.skill] ?? 0) * 0.02);
      placed++;
      advanceCursor();
    }
    void startCount;
    return placed;
  };

  // 4) Assign one hand at a time, cycling through buildings in priority order.
  //    This keeps every building minimally staffed instead of letting the first
  //    camp absorb the entire workforce (which starved early settlements of
  //    wood, water and housing in testing).
  const unitsByEntry: WorkSlot[][] = order.map((entry) => {
    const units: WorkSlot[] = [];
    for (const slot of entry.slots) for (let i = 0; i < slot.count; i++) units.push({ profession: slot.profession, skill: slot.skill, count: 1 });
    return units;
  });
  const needs: number[] = [];
  for (let i = 0; i < order.length; i++) {
    const entry = order[i]!;
    const b = entry.building;
    const existingIds = frozen.get(b.id) ?? [];
    if (existingIds.length) {
      b.workerIds.push(...existingIds);
      b.workers = b.workerIds.length;
      for (const id of existingIds) {
        const c = ctx.s.citizens.find((x) => x.id === id);
        if (c) {
          c.jobBuildingId = b.id;
          if (entry.construction) c.profession = 'builder';
        }
      }
    }
    const wanted = unitsByEntry[i]!.length;
    const want = !auto && !entry.construction && b.priority < 3 ? b.workers : wanted;
    needs.push(Math.max(0, want - b.workers));
  }
  let assignedCount = assigned.size;
  const totalPool = pool.length;
  let assignedAny = true;
  while (assignedAny && assignedCount < totalPool) {
    assignedAny = false;
    for (let i = 0; i < order.length; i++) {
      if (needs[i]! <= 0 || assignedCount >= totalPool) continue;
      const entry = order[i]!;
      const units = unitsByEntry[i]!;
      const unit = units[units.length - needs[i]!];
      if (!unit) {
        needs[i] = 0;
        continue;
      }
      let bestIdx = -1;
      let bestScore = -Infinity;
      let scanned = 0;
      for (let k = cursor; k < pool.length && scanned < CANDIDATE_WINDOW; k++) {
        const cand = pool[k];
        if (!cand || assigned.has(cand.citizen.id)) continue;
        scanned++;
        const score = scoreFor(cand.citizen, unit, entry.building);
        if (score > bestScore) {
          bestScore = score;
          bestIdx = k;
        }
      }
      if (bestIdx < 0) {
        advanceCursor();
        for (let k = cursor; k < pool.length; k++) {
          const cand = pool[k];
          if (cand && !assigned.has(cand.citizen.id)) {
            bestIdx = k;
            break;
          }
        }
      }
      if (bestIdx < 0) {
        needs[i] = 0;
        continue;
      }
      const c = pool[bestIdx]!.citizen;
      assigned.add(c.id);
      assignedCount++;
      const b = entry.building;
      b.workerIds.push(c.id);
      b.workers = b.workerIds.length;
      c.jobBuildingId = b.id;
      c.profession = unit.profession;
      c.income = 0.4 + Math.min(2, (c.skills[unit.skill] ?? 0) * 0.02);
      needs[i] = needs[i]! - 1;
      assignedAny = true;
      advanceCursor();
    }
  }
  const unfilledConstruction: Building[] = [];
  for (let i = 0; i < order.length; i++) {
    if (order[i]!.construction && needs[i]! > 0) unfilledConstruction.push(order[i]!.building);
  }

  // 4b) Critical work: when the larder is nearly empty, at least one food or
  // gathering building must be staffed even if that means pulling a hand off a
  // workshop. A settlement can postpone pottery; it cannot postpone eating.
  if (st.foodDays < 5) {
    const foodEntries = order.filter((e) => !e.construction && (e.def.category === 'food' || e.def.category === 'gathering'));
    const unstaffedFood = foodEntries.find((e) => e.building.workers === 0);
    if (unstaffedFood) {
      const nonCritical = order
        .filter((e) => !e.construction && e.def.category !== 'food' && e.def.category !== 'gathering' && e.building.workerIds.length > 0)
        .sort((a, b) => a.priority - b.priority)[0];
      if (nonCritical) {
        const stolen = nonCritical.building.workerIds.pop();
        if (stolen !== undefined) {
          nonCritical.building.workers = nonCritical.building.workerIds.length;
          const c = ctx.s.citizens.find((x) => x.id === stolen);
          const targetUnit = unitsByEntry[order.indexOf(unstaffedFood)]?.[unstaffedFood.building.workerIds.length];
          unstaffedFood.building.workerIds.push(stolen);
          unstaffedFood.building.workers = unstaffedFood.building.workerIds.length;
          if (c) {
            c.jobBuildingId = unstaffedFood.building.id;
            if (targetUnit) c.profession = targetUnit.profession;
          }
        }
      }
    }
  }

  // 5) LOD cohorts: abstract hands fill what detailed citizens could not.
  const cohortGiven = new Map<number, number>();
  let detailedWorkers = 0;
  for (const b of s.buildings) if (b.settlementId === st.id) detailedWorkers += b.workers;
  let cohortHands = 0;
  let labour = cohortLabour(ctx, st.id);
  for (let i = 0; i < order.length && labour > 0; i++) {
    const entry = order[i]!;
    const b = entry.building;
    if (!auto && !entry.construction && b.priority < 3) continue;
    const want = entry.construction ? constructionCrew(entry.def) : entry.slots.reduce((n, x) => n + x.count, 0);
    const open = Math.max(0, want - b.workers);
    if (open <= 0) continue;
    const give = Math.min(open, labour);
    b.workers += give;
    cohortGiven.set(b.id, (cohortGiven.get(b.id) ?? 0) + give);
    labour -= give;
    cohortHands += give;
  }

  // 5b) Normalise caches: b.workers is exactly the roster, workerIds are unique
  // and every assigned citizen points at the building that pays them.
  for (const b of s.buildings) {
    if (b.settlementId !== st.id) continue;
    const seen = new Set<number>();
    const unique: number[] = [];
    for (const id of b.workerIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      unique.push(id);
    }
    b.workerIds = unique;
    b.workers = b.workerIds.length + (cohortGiven.get(b.id) ?? 0);
    for (const id of b.workerIds) {
      const c = ctx.s.citizens.find((x) => x.id === id);
      if (c && c.jobBuildingId !== b.id) c.jobBuildingId = b.id;
    }
  }

  // 6) Idle citizens get their social role back and a little grievance.
  for (const c of citizens) {
    if (!c.alive) continue;
    if (c.jobBuildingId < 0) {
      setProfessionForIdle(c, hasSchool);
      if (previous.has(c.id) && workingEligible(c)) {
        c.morale = clamp(c.morale - 1.6, 0, 100);
        c.thoughts.unshift('I have no work today.');
        if (c.thoughts.length > 5) c.thoughts.length = 5;
      }
    }
  }

  // 7) A day of honest work: small skill growth, tiny health/morale texture.
  const workHoursFactor = s.society.workHours >= 12 ? 1.15 : s.society.workHours <= 8 ? 0.85 : 1;
  const eduFactor = 1 + clamp(st.housing.quality, 0, 5) * 0.02;
  const buildingTypeDefs = new Map<BuildingDef, WorkSlot[]>();
  for (const c of citizens) {
    if (!c.alive || c.jobBuildingId < 0) continue;
    const b = buildingById.get(c.jobBuildingId);
    if (!b) continue;
    const def = buildingDef(ctx.c, b);
    if (!def) continue;
    let slotsForBuilding = buildingTypeDefs.get(def);
    if (!slotsForBuilding) {
      slotsForBuilding = buildingJobSlots(def);
      buildingTypeDefs.set(def, slotsForBuilding);
    }
    let skill: SkillId = 'building';
    for (const slot of slotsForBuilding) {
      if (slot.profession === c.profession) {
        skill = slot.skill;
        break;
      }
    }
    const growth =
      LIMITS.trainingRate * 0.09 * (0.6 + c.education / 120) * (traitsBonus(c) > 0 ? 1.2 : 1) * workHoursFactor * eduFactor;
    c.skills[skill] = Math.round(clamp((c.skills[skill] ?? 0) + growth, 0, 100) * 10) / 10;
    if (s.society.workHours >= 12) c.health = clamp(c.health - 0.03, 0, 100);
    c.needs.purpose = clamp(c.needs.purpose + (s.society.workHours <= 8 ? 0.8 : 0.3), 0, 100);
  }

  // 8) Workforce caches: able adults, detailed and abstract.
  let workforce = 0;
  for (const c of citizens) if (c.alive && workingEligible(c)) workforce++;
  let cohortAdults = 0;
  for (const co of ctx.s.cohorts) {
    if (co.settlementId !== st.id || co.count <= 0 || co.ageBand === 'child') continue;
    cohortAdults += co.count;
  }
  workforce += Math.floor(cohortAdults * RULES.laborFraction);
  const workers = detailedWorkers + cohortHands;
  st.workforce = Math.floor(workforce);
  st.unemployed = Math.max(0, Math.floor(workforce) - workers);

  // 9) Unemployment is depressing; full employment gives a little dignity back.
  const unemploymentRate = st.workforce > 0 ? st.unemployed / st.workforce : 0;
  if (unemploymentRate > 0.35 && citizens.length > 2) {
    for (const c of citizens) {
      if (c.alive) c.morale = clamp(c.morale - 0.35 * unemploymentRate, 0, 100);
    }
    if (ctx.tick % 12 === 9) {
      ctx.notify(
        `${Math.round(unemploymentRate * 100)}% of ${st.name} has no work. Idle hands make restless nights.`,
        'warn',
        'jobs',
      );
    }
  }
  void unfilledConstruction;
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const jobsSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (s.settlements.length === 0) return;
  if (s.citizens.length === 0 && s.cohorts.length === 0) {
    for (const st of s.settlements) {
      st.workforce = 0;
      st.unemployed = 0;
    }
    return;
  }
  for (const st of s.settlements) {
    try {
      assignSettlement(ctx, st);
    } catch (err) {
      ctx.log(`jobs: settlement ${st.id} failed: ${(err as Error).message}`);
    }
  }
};

/** Used by tests/UI: the settlement's current job roster summary. */
export function jobSummary(ctx: SimContext, settlementId: number): { slots: number; filled: number; idle: number } {
  let slots = 0;
  let filled = 0;
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== settlementId) continue;
    const def = buildingDef(ctx.c, b);
    if (!def) continue;
    const want = b.progress < 1 ? constructionCrew(def) : def.jobs.reduce((n, j) => n + j.count, 0);
    slots += want;
    filled += b.workers;
  }
  let idle = 0;
  for (const c of ctx.s.citizens) {
    if (c.alive && c.settlementId === settlementId && isWorkingAge(c.age) && c.health > 30 && c.jobBuildingId < 0) idle++;
  }
  return { slots, filled, idle };
}

// Silence unused-import lint for cross-module contracts kept on purpose.
void professionClass;
