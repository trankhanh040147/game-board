/**
 * FIRST HEARTH — scripted autoplay driver ("a competent player").
 *
 * Used by tools/simrun.ts (balance runs) and by the QA test-suite so regression
 * tests and balance numbers exercise the same deterministic action script. The
 * driver only calls public actions from src/sim/actions.ts (plus the documented
 * auto_research flag), never sim internals.
 *
 * Strategy (deterministic, content-driven):
 *   1. Set sane sliders (tax 12%, normal rations, 10h days) and let the
 *      research system auto-study once affordable (flags.auto_research = 1).
 *   2. Adopt the first offered doctrine; buy affordable techs the scholars
 *      haven't queued yet.
 *   3. Resolve pending event decisions with the first affordable choice.
 *   4. Build a scaling settlement — gatherers/water/housing first, then storage,
 *      farms, industry and science — one structure per 1-2 days.
 *   5. Lay roads every ~15 days when wood allows.
 */
import {
  chooseTech,
  chooseDoctrine,
  placeBuilding,
  placementCheck,
  resolveDecision,
  placeRoad,
  roadCheck,
  setTaxRate,
  setRations,
  setWorkHours,
  setBuildingRecipe,
} from '../src/sim/actions';
import type { ActionContext } from '../src/sim/actions';
import { RULES } from '../src/sim/config';
import { capitalOf, canAfford, techsAvailable } from '../src/sim/core';
import type { BuildingDef, BuildingId, Content, GameState, ResourceId, Settlement, TechDef } from '../src/sim/types';

export interface AutoplayStats {
  placed: { typeId: BuildingId; day: number; x: number; y: number }[];
  roads: number;
  techsChosen: number;
  decisionsResolved: number;
  doctrines: number;
  failedPlacements: number;
  failedReasons: Record<string, number>;
  slidersSet: number;
}

const CATEGORY_SCORE: Record<string, number> = {
  food: 100,
  gathering: 100,
  water: 95,
  housing: 85,
  storage: 75,
  science: 65,
  industry: 65,
  energy: 50,
  logistics: 45,
  society: 40,
  beauty: 30,
  defence: 25,
  special: 30,
};

/**
 * Opening plan: the order a competent player establishes a working economy.
 * The first unsatisfied step gets a huge score bonus, so the driver secures
 * wood/food/stone income before it spends materials on water and housing.
 */
interface OpeningStep {
  label: string;
  defs: BuildingId[];
  satisfied: (state: GameState, cap: Settlement, counts: Record<string, number>) => boolean;
}

const countOf = (counts: Record<string, number>, ids: string[]): number => ids.reduce((a, id) => a + (counts[id] ?? 0), 0);

const OPENING: OpeningStep[] = [
  { label: 'first beds', defs: ['lean_to', 'hut'], satisfied: (_s, _c, n) => countOf(n, ['lean_to', 'hut']) >= 1 },
  { label: 'food income', defs: ['foragers_camp', 'hunting_blind', 'fishing_dock'], satisfied: (_s, _c, n) => countOf(n, ['foragers_camp', 'hunting_blind', 'fishing_dock']) >= 1 },
  { label: 'wood income', defs: ['woodcutter_camp'], satisfied: (_s, _c, n) => countOf(n, ['woodcutter_camp']) >= 1 },
  { label: 'water supply', defs: ['well'], satisfied: (_s, c, n) => countOf(n, ['well']) >= 1 || c.waterDays > 0 },
  { label: 'stone income', defs: ['stone_pit'], satisfied: (_s, _c, n) => countOf(n, ['stone_pit']) >= 1 },
  { label: 'granary', defs: ['granary'], satisfied: (_s, _c, n) => countOf(n, ['granary']) >= 1 },
  {
    label: 'first farm',
    defs: ['farm'],
    satisfied: (s, _c, n) => countOf(n, ['farm']) >= 1 || !s.research.completed['cultivation'],
  },
  { label: 'growth beds', defs: ['hut', 'lean_to'], satisfied: (_s, c) => c.housing.capacity - c.housing.occupied >= 3 },
  { label: 'second foragers', defs: ['foragers_camp', 'hunting_blind', 'fishing_dock'], satisfied: (_s, _c, n) => countOf(n, ['foragers_camp', 'hunting_blind', 'fishing_dock']) >= 2 },
  { label: 'second woodcutter', defs: ['woodcutter_camp'], satisfied: (_s, _c, n) => countOf(n, ['woodcutter_camp']) >= 2 },
  { label: 'second well', defs: ['well'], satisfied: (_s, c, n) => countOf(n, ['well']) >= 2 || c.waterDays > 10 },
  { label: 'workshop tier', defs: ['sawmill', 'workshop', 'smelter', 'brickworks'], satisfied: (_s, _c, n) => countOf(n, ['sawmill', 'workshop', 'smelter', 'brickworks']) >= 1 },
];

/** Counts include structures under construction (materials already committed). */
function buildingCounts(state: GameState, cap: Settlement): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const b of state.buildings) if (b.settlementId === cap.id) counts[b.typeId] = (counts[b.typeId] ?? 0) + 1;
  return counts;
}

/** Resources the settlement's *completed* buildings already produce/gather. */
function totalCost(def: BuildingDef): number {
  let t = 0;
  for (const k in def.cost) t += def.cost[k];
  return t;
}

/** Resources produced/gathered by the settlement's completed buildings. */
function producedResources(state: GameState, content: Content, cap: Settlement): Set<string> {
  const out = new Set<string>();
  for (const b of state.buildings) {
    if (b.settlementId !== cap.id || b.progress < 1) continue;
    const def = content.buildings[b.typeId];
    if (!def) continue;
    for (const rid of def.recipes) {
      const recipe = content.recipes[rid];
      if (!recipe) continue;
      if (recipe.gather) out.add(recipe.gather.resource);
      for (const res of Object.keys(recipe.outputs)) out.add(res);
    }
    if (def.housing) out.add('__housing');
    if (def.storage) out.add('__storage');
  }
  return out;
}

/** Buildings that currently produce food (gathered or crafted edible output). */
function foodProducerCount(state: GameState, content: Content, cap: Settlement): number {
  let n = 0;
  for (const b of state.buildings) {
    if (b.settlementId !== cap.id) continue;
    const def = content.buildings[b.typeId];
    if (!def) continue;
    const producesFood = def.recipes.some((rid) => {
      const r = content.recipes[rid];
      if (!r) return false;
      if (r.gather && (content.resources[r.gather.resource]?.edible ?? 0) > 0) return true;
      return Object.keys(r.outputs).some((res) => (content.resources[res]?.edible ?? 0) > 0);
    });
    if (producesFood || def.category === 'food' || def.category === 'gathering') n++;
  }
  return n;
}

/** Bonus for a gathering building that supplies something we still lack. */
function gatherBonus(def: BuildingDef, content: Content, produced: Set<string>): number {
  let bonus = 0;
  for (const rid of def.recipes) {
    const recipe = content.recipes[rid];
    const gather = recipe?.gather;
    if (!gather || produced.has(gather.resource)) continue;
    const res = content.resources[gather.resource];
    if (gather.resource === 'wood') bonus = Math.max(bonus, 70);
    else if (res?.edible) bonus = Math.max(bonus, 60);
    else if (gather.resource === 'stone') bonus = Math.max(bonus, 40);
    else if (res?.category === 'raw') bonus = Math.max(bonus, 30);
  }
  return bonus;
}

export class Autoplay {
  stats: AutoplayStats = {
    placed: [],
    roads: 0,
    techsChosen: 0,
    decisionsResolved: 0,
    doctrines: 0,
    failedPlacements: 0,
    failedReasons: {},
    slidersSet: 0,
  };
  private positionsCache = new Map<string, { x: number; y: number }[]>();
  private logs: string[] = [];
  /** Consecutive days spent waiting for the next opening step to be affordable. */
  private waitDays = 0;

  /** Advance the scripted player by one action phase (call before tick). */
  run(state: GameState, content: Content): void {
    const a: ActionContext = { state, content, rules: RULES };
    const cap = capitalOf(state);
    if (!cap) return;

    // 0. Player policy: sane sliders + let the scholars auto-study affordable techs.
    if (state.flags.auto_research !== 1) state.flags.auto_research = 1;
    if (this.stats.slidersSet < 3) {
      setTaxRate(a, 0.12);
      setWorkHours(a, 10);
      this.stats.slidersSet = 3;
    }
    // Adapt rations to the larder (roughly once a week).
    if (state.tick % 7 === 0) {
      if (cap.foodDays > 20) setRations(a, 'generous');
      else if (cap.foodDays < 4) setRations(a, 'meager');
      else setRations(a, 'normal');
    }

    // 1. Resolve pending decisions so the sim does not stall on modals.
    for (const decision of [...state.events.pending]) {
      const affordable = decision.choices.find(
        (ch) => !ch.cost || Object.keys(ch.cost).length === 0 || canAfford(cap, ch.cost as Record<ResourceId, number>),
      );
      const choice = affordable ?? decision.choices[0];
      if (!choice) continue;
      const res = resolveDecision(a, decision.id, choice.id);
      if (res.ok) this.stats.decisionsResolved++;
    }

    // 2. Adopt the first offered doctrine.
    if (!state.research.doctrine && state.research.doctrineChoices.length) {
      const res = chooseDoctrine(a, state.research.doctrineChoices[0]);
      if (res.ok) this.stats.doctrines++;
    }

    // 3. Research: buy the cheapest available tech the auto-study queue has not
    //    covered (the research system then studies `current` day by day).
    //    Cultivation is force-bought: farms are the backbone of the food economy.
    {
      const forced = ['cultivation', 'agriculture'].find((id) => {
        const t = content.techs[id];
        return t && techsAvailable(state, content).some((x) => x.id === id) && state.research.insight >= t.cost;
      });
      if (forced) {
        const res = chooseTech(a, forced);
        if (res.ok) this.stats.techsChosen++;
      }
    }
    if (!state.research.current) {
      const era = state.research.era;
      const TECH_PRIORITY = ['cultivation', 'foraging_lore', 'sheltercraft', 'well_digging', 'agriculture', 'irrigation', 'masonry', 'craft'];
      const priorityOf = (t: TechDef): number => {
        const idx = TECH_PRIORITY.indexOf(t.id);
        if (idx >= 0) return idx;
        // Techs that unlock a food or gathering building are valuable early.
        if (t.unlocksBuildings?.some((b) => {
          const bt = content.buildings[b]?.category;
          return bt === 'food' || bt === 'gathering';
        })) return TECH_PRIORITY.length + 1;
        return TECH_PRIORITY.length + 2;
      };
      const available = techsAvailable(state, content)
        .filter((t: TechDef) => state.research.insight >= t.cost)
        .sort((x: TechDef, y: TechDef) => (x.era > era ? 1 : 0) - (y.era > era ? 1 : 0) || priorityOf(x) - priorityOf(y) || x.cost - y.cost || x.id.localeCompare(y.id));
      // Keep a little insight for the auto-studying project: only buy when flush.
      const buffered = available.length && state.research.insight >= available[0].cost * 1.5 ? available[0] : null;
      if (buffered) {
        const res = chooseTech(a, buffered.id);
        if (res.ok) this.stats.techsChosen++;
      }
    }

    // 3b. Recipe management: a settlement needs fibre (ropes, huts, granaries)
    //     and one foragers' camp can be switched to gather it. Without this a
    //     competent-looking settlement stalls with 1 fibre forever.
    this.manageRecipes(state, content, cap);

    // 4. Construction: one attempt per cadence, like a player watching costs.
    const cadence = cap.population < 8 ? 1 : 2;
    if (state.tick % cadence === 0 && this.canStartSite(state, cap)) {
      const build = (def: BuildingDef): boolean => {
        const pos = this.findPlacement(a, def, cap);
        if (!pos) return false;
        const res = placeBuilding(a, def.id, pos.x, pos.y, cap.id);
        if (res.ok) {
          this.stats.placed.push({ typeId: def.id, day: state.tick, x: pos.x, y: pos.y });
          this.logs.push(`day ${state.tick}: built ${def.name} at (${pos.x},${pos.y})`);
        } else {
          this.stats.failedPlacements++;
          this.noteFailure(`${def.id}: ${res.message ?? 'unknown'}`);
        }
        return true;
      };

      // Opening ladder first: if its next step is affordable, build exactly
      // that; if it is unaffordable but the missing materials are produced
      // locally, wait instead of spending them on a lower-priority structure.
      const opening = this.nextOpeningDef(state, content, cap);
      if (opening) {
        if (this.cheapAffordable(opening, cap)) {
          this.waitDays = 0;
          build(opening);
        } else {
          const canWait =
            this.waitDays < 18 &&
            cap.foodDays >= 2 &&
            cap.waterDays >= 1 &&
            this.missingCostCoveredByProducers(state, content, cap, [opening]);
          if (canWait) {
            this.waitDays++;
            return;
          }
          // Emergency / stalled: fall through to the best ranked structure.
          for (const candidate of this.rankBuildings(state, content, cap)) {
            if (!this.cheapAffordable(candidate.def, cap)) continue;
            if (build(candidate.def)) return;
          }
        }
        return;
      }

      // Ladder complete: try ranked candidates until one is placeable.
      for (const candidate of this.rankBuildings(state, content, cap)) {
        if (!this.cheapAffordable(candidate.def, cap)) continue;
        if (build(candidate.def)) return;
      }
    }

    // 5. Roads: connect the settlement outward.
    if (state.tick > 0 && state.tick % 15 === 0 && (cap.stock.wood ?? 0) >= 3 && cap.buildings.length >= 3) {
      const spot = this.findRoadSpot(a, cap);
      if (spot) {
        const res = placeRoad(a, spot.x, spot.y, cap.id);
        if (res.ok) this.stats.roads++;
      }
    }
  }

  /**
   * Assign gathering recipes to cover material bottlenecks. The first
   * foragers' camp gathers berries; when fibre runs low (housing, granary and
   * rope all need it) one camp is switched to flax/fibre gathering.
   */
  manageRecipes(state: GameState, content: Content, cap: Settlement): void {
    const camps = state.buildings
      .filter((b) => b.settlementId === cap.id && b.typeId === 'foragers_camp' && b.progress >= 1)
      .sort((x, y) => x.id - y.id);
    if (!camps.length) return;
    const fiberRecipes = content.buildings['foragers_camp']?.recipes.filter((rid) => content.recipes[rid]?.gather?.resource === 'fiber') ?? [];
    const berryRecipe = content.buildings['foragers_camp']?.recipes.find((rid) => content.recipes[rid]?.gather?.resource === 'berries') ?? null;
    if (!fiberRecipes.length) return;
    const fiber = cap.stock.fiber ?? 0;
    const a: ActionContext = { state, content, rules: RULES };
    const onFiber = camps.filter((b) => fiberRecipes.includes(b.recipeId ?? ''));
    const berryCamps = camps.filter((b) => berryRecipe && b.recipeId === berryRecipe);
    // Huts and granaries need fibre, and the only early fibre source is a
    // foragers' camp switched to flax/forage fibre. Spend a few days of food
    // buffer on it when the larder can afford it; keep one camp on fibre while
    // the settlement is still building its housing.
    const needFiber = fiber < 4;
    const canSpareFood = camps.length > 1 || cap.foodDays >= 1.5;
    const keepFiberCamp = camps.length >= 2 && fiber < 8;
    if (needFiber && canSpareFood && berryCamps.length > 0) {
      const camp = berryCamps[0];
      if (camp) setBuildingRecipe(a, camp.id, fiberRecipes[0]);
    } else if (keepFiberCamp && onFiber.length < 1) {
      const camp = berryCamps[berryCamps.length - 1];
      if (camp) setBuildingRecipe(a, camp.id, fiberRecipes[0]);
    } else if (!needFiber && !keepFiberCamp && onFiber.length > 0 && berryRecipe && cap.foodDays < 12) {
      // Fibre is healthy again and the larder is thin: back to berries.
      setBuildingRecipe(a, onFiber[0].id, berryRecipe);
    }
  }

  /**
   * A settlement only works on so many sites at once. Only *staffed* sites
   * count: a freshly placed site with no crew yet must not freeze all building.
   */
  private canStartSite(state: GameState, cap: Settlement): boolean {
    const staffed = state.buildings.filter((b) => b.settlementId === cap.id && b.progress < 1 && b.workers > 0).length;
    const allowed = cap.population <= 6 ? 1 : Math.max(2, Math.floor(cap.population / 4));
    return staffed < allowed;
  }

  /** The next unmet opening-ladder building definition, if buildable at all. */
  private nextOpeningDef(state: GameState, content: Content, cap: Settlement): BuildingDef | null {
    const id = this.nextOpeningId(state, content, cap);
    return id ? content.buildings[id] ?? null : null;
  }

  /** The next unmet opening-ladder building id, if it is currently buildable. */
  private nextOpeningId(state: GameState, content: Content, cap: Settlement): BuildingId | null {
    const counts = buildingCounts(state, cap);
    const step = OPENING.find((st) => !st.satisfied(state, cap, counts));
    if (!step) return null;
    for (const id of step.defs) {
      const def = content.buildings[id];
      if (!def) continue;
      if (def.era > state.research.era) continue;
      if (def.requiresTech.some((t) => !state.research.completed[t])) continue;
      return id;
    }
    return null;
  }

  /** Choose the next most valuable underbuilt structure. */
  pickBuilding(state: GameState, content: Content, cap: Settlement): BuildingDef | null {
    if (!this.canStartSite(state, cap)) return null;

    // Opening plan first: secure the next missing rung of the economic ladder.
    const counts = buildingCounts(state, cap);
    const nextStep = OPENING.find((step) => !step.satisfied(state, cap, counts));
    if (nextStep) {
      const buildable: BuildingDef[] = [];
      for (const id of nextStep.defs) {
        const def = content.buildings[id];
        if (!def || def.era > state.research.era || def.requiresTech.some((t) => !state.research.completed[t])) continue;
        buildable.push(def);
      }
      const affordable = buildable.find((def) => this.cheapAffordable(def, cap));
      if (affordable) {
        this.waitDays = 0;
        return affordable;
      }
      // Not affordable yet. If the missing materials can still be produced
      // locally, wait for them (a human does not spend the wood the hut needs
      // on a second stone pit). Do not wait forever: after ~18 days, or when
      // the larder/well is failing, build whatever helps most immediately.
      const canWait =
        this.waitDays < 18 && cap.foodDays >= 2 && cap.waterDays >= 1 && this.missingCostCoveredByProducers(state, content, cap, buildable);
      if (canWait) {
        this.waitDays++;
        return null;
      }
    }

    const ranked = this.rankBuildings(state, content, cap);
    for (const candidate of ranked) {
      if (this.cheapAffordable(candidate.def, cap)) return candidate.def;
    }
    return null;
  }

  /** True if the missing resources of an opening step have a real local producer. */
  private missingCostCoveredByProducers(state: GameState, content: Content, cap: Settlement, defs: BuildingDef[]): boolean {
    const produced = producedResources(state, content, cap);
    const counts = buildingCounts(state, cap);
    const switchableFiber = state.buildings.some(
      (b) => b.settlementId === cap.id && b.typeId === 'foragers_camp' && content.buildings[b.typeId]?.recipes.some((rid) => content.recipes[rid]?.gather?.resource === 'fiber'),
    );
    const covered = (res: string): boolean => {
      if (produced.has(res)) return true;
      if (res === 'fiber') return switchableFiber || (counts['farm'] ?? 0) > 0;
      if (res === 'wood') return (counts['woodcutter_camp'] ?? 0) > 0;
      if (res === 'stone' || res === 'clay' || res === 'sand' || res === 'salt') return (counts['stone_pit'] ?? 0) > 0;
      return false;
    };
    for (const def of defs) {
      const missing = Object.keys(def.cost).filter((res) => (cap.stock[res] ?? 0) < def.cost[res]);
      if (!missing.length) return false;
      if (missing.every(covered)) return true;
    }
    return false;
  }

  /** Ranked build candidates (exposed for QA diagnostics and balance work). */
  rankBuildings(state: GameState, content: Content, cap: Settlement): { def: BuildingDef; score: number }[] {
    const counts: Record<string, number> = {};
    for (const b of state.buildings) if (b.settlementId === cap.id) counts[b.typeId] = (counts[b.typeId] ?? 0) + 1;
    const produced = producedResources(state, content, cap);
    const producers = state.buildings.filter((b) => {
      if (b.settlementId !== cap.id) return false;
      const d = content.buildings[b.typeId];
      if (!d) return false;
      if (d.category === 'gathering' || d.category === 'food') return true;
      return d.recipes.some((rid) => content.recipes[rid]?.gather);
    }).length;

    const candidates: { def: BuildingDef; score: number }[] = [];
    for (const id of content.buildingOrder) {
      const def = content.buildings[id];
      if (!def) continue;
      if (def.era > state.research.era) continue;
      if (def.requiresTech.some((t) => !state.research.completed[t])) continue;
      const built = counts[id] ?? 0;
      if (def.placement.unique && built >= 1) continue;
      if (def.placement.maxPerSettlement && built >= def.placement.maxPerSettlement) continue;
      if (def.tags?.includes('unique_world') && state.buildings.some((b) => b.typeId === id)) continue;

      let score = CATEGORY_SCORE[def.category] ?? 40;
      if (producers < 3 && (def.category === 'gathering' || def.category === 'food')) score += 25;
      if (def.category === 'housing') {
        const spareBeds = cap.housing.capacity - cap.housing.occupied;
        // No spare bed blocks *all* growth (births and immigration both need
        // one), so it is the single most urgent thing in a young settlement —
        // but never more than two spare beds ahead of the population.
        const thinLarder = cap.foodDays < 6;
        if (spareBeds <= 0) score += thinLarder ? 70 : 160;
        else if (spareBeds <= 1) score += thinLarder ? 30 : 90;
        else if (spareBeds <= 2) score += 10;
        else score -= 90;
      } else if (def.category === 'water') {
        // Thirst is the fastest death in the game: a settlement with no water
        // service must build a well before it builds anything comfortable.
        if (cap.waterDays <= 0) score += 160;
        else if (cap.waterDays < 4) score += 85;
        else if (cap.waterDays < 12) score += 40;
        else score -= 30;
      } else if (def.category === 'storage') {
        if (cap.storageUsed > cap.storageCap * 0.7) score += 50;
        else score -= 25;
      } else if (def.category === 'gathering' || def.category === 'food') {
        // Priority rule: when the larder is thin, food comes before wood,
        // housing, stone and water.
        if (cap.foodDays < 3) score += 140;
        else if (cap.foodDays < 10) score += 60;
        else if (cap.foodDays < 20) score += 15;
      }
      // ---- population scaling -------------------------------------------------
      const isFoodBuilding = def.category === 'food' || def.category === 'gathering';
      const foodProducers = foodProducerCount(state, content, cap);
      const popPerFoodProducer = cap.population / Math.max(1, foodProducers);
      if (isFoodBuilding) {
        // A growing town must keep building food capacity, not just housing:
        // aim for at least one food building per ~10 people.
        if (cap.foodDays < 12 || popPerFoodProducer > 10) score += 100;
        else if (popPerFoodProducer > 6) score += 35;
        if (def.era >= 1 && content.recipes && def.recipes.some((rid) => {
          const r = content.recipes[rid];
          return r && (Object.keys(r.outputs).some((res) => (content.resources[res]?.edible ?? 0) > 0) || (r.gather && (content.resources[r.gather.resource]?.edible ?? 0) > 0));
        })) score += 35;
      }
      // Housing must never run far ahead of the food base.
      if (def.category === 'housing' && foodProducers > 0 && cap.population / Math.max(1, foodProducers) > 10) score -= 70;
      // Era-2 utilities: water towers/aqueducts and a market as the town grows.
      if (def.category === 'water' && cap.population > 25) score += 35;
      if (def.id === 'market' && state.research.era >= 2 && cap.population > 18) score += 70;
      if ((def.id === 'aqueduct' || def.id === 'water_tower') && state.research.era >= 2) score += 60;
      score += gatherBonus(def, content, produced);
      // Do not over-mine stone: a small stock is all the early buildings need.
      if (def.category === 'gathering' && def.recipes.some((rid) => content.recipes[rid]?.gather?.resource === 'stone') && (cap.stock.stone ?? 0) > 18) {
        score -= 45;
      }
      if (def.service?.kind === 'water') score += 10;
      if (def.service?.kind === 'health') score += 12;
      if (def.upkeep && Object.keys(def.upkeep).length > 0) score -= 4;
      score -= totalCost(def) * 0.01;
      score -= built * 8;
      score -= def.era * 2;

      if (!def.housing && !def.storage && def.jobs.length === 0 && !def.service && !def.recipes.length && !def.effects) {
        score -= 20; // decorative-only structures are a low priority while growing
      }
      if (score <= 0) continue;
      candidates.push({ def, score });
    }
    candidates.sort((x, y) => y.score - x.score || x.def.id.localeCompare(y.def.id));
    return candidates;
  }

  private cheapAffordable(def: BuildingDef, cap: Settlement): boolean {
    for (const res in def.cost) {
      if ((cap.stock[res] ?? 0) < def.cost[res]) return false;
    }
    return true;
  }

  private positions(state: GameState, cap: Settlement): { x: number; y: number }[] {
    const key = `${state.world.width}:${state.world.height}:${cap.x},${cap.y}`;
    let pos = this.positionsCache.get(key);
    if (pos) return pos;
    pos = [];
    for (let dy = -9; dy <= 9; dy++) {
      for (let dx = -9; dx <= 9; dx++) {
        const d = Math.hypot(dx, dy);
        if (d > 9 || d < 0.9) continue;
        pos.push({ x: cap.x + dx, y: cap.y + dy });
      }
    }
    pos.sort((p, q) => Math.hypot(p.x - cap.x, p.y - cap.y) - Math.hypot(q.x - cap.x, q.y - cap.y) || p.y - q.y || p.x - q.x);
    this.positionsCache.set(key, pos);
    return pos;
  }

  findPlacement(a: ActionContext, def: BuildingDef, cap: Settlement): { x: number; y: number } | null {
    const positions = this.positions(a.state, cap);
    const w = a.state.world;
    let lastReason = 'no candidate tile';
    for (const p of positions) {
      const t = w.tiles[p.y * w.width + p.x];
      if (!t || t.buildingId >= 0) continue;
      const check = placementCheck(a, def.id, p.x, p.y, cap.id);
      if (check.ok) return p;
      lastReason = check.reason ?? lastReason;
    }
    this.noteFailure(`${def.id}: ${lastReason}`);
    return null;
  }

  private findRoadSpot(a: ActionContext, cap: Settlement): { x: number; y: number } | null {
    const positions = this.positions(a.state, cap);
    const w = a.state.world;
    for (const p of positions) {
      const t = w.tiles[p.y * w.width + p.x];
      if (!t || t.road > 0 || t.buildingId >= 0) continue;
      const check = roadCheck(a, p.x, p.y, cap.id);
      if (check.ok) return p;
    }
    return null;
  }

  private noteFailure(reason: string): void {
    this.stats.failedReasons[reason] = (this.stats.failedReasons[reason] ?? 0) + 1;
  }

  takeLogs(): string[] {
    const out = this.logs;
    this.logs = [];
    return out;
  }

  /** Top failure reasons, for surfacing content/economy bugs from balance runs. */
  topFailures(n = 5): string[] {
    return Object.entries(this.stats.failedReasons)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([reason, count]) => `${count}x ${reason}`);
  }
}
