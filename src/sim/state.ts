/**
 * Game state construction: new games, citizens, buildings, settlement helpers,
 * cache rebuilding for save/load.
 */
import type {
  Building,
  Citizen,
  Content,
  GameSettings,
  GameState,
  ResourceId,
  Settlement,
  SimCache,
  Tile,
  WorldState,
} from './types';
import { DAYS_PER_YEAR } from './types';
import { RULES, LIMITS, DEFAULT_SETTINGS, DIFFICULTIES, STARTING_SETTLEMENT_NAME, STARTING_CITIZEN_NAMES, GAME_VERSION, WORLDGEN } from './config';
import { generateWorld, WORLD_DEFAULTS } from './world/worldgen';
import { Rng, seedFromString, randInt, gaussian, pick } from './rng';
import {
  addChronicle,
  buildingDef,
  capitalOf,
  claimableTile,
  collectGlobalModifiers,
  dateLabel,
  foodDaysOf,
  nextId,
  pushNotification,
  seasonOf,
  setFlag,
  stockSnapshot,
  tileAt,
  tileIndex,
  inBounds,
  waterDaysOf,
  yearOf,
} from './core';
import { initMetrics } from './metrics';

export interface NewGameOptions {
  seed?: string;
  difficulty?: GameState['difficulty'];
  width?: number;
  height?: number;
}

function emptyCache(): SimCache {
  return {
    globalMods: {},
    settlementMods: {},
    radiusMap: new Map(),
    roadAccess: {},
    neighborResourceCache: {},
    lastRoadUpdate: -1,
    breakdown: {},
  };
}

export function createNewGame(content: Content, opts: NewGameOptions = {}): GameState {
  const seed = (opts.seed ?? 'first-hearth').trim() || 'first-hearth';
  const difficulty: GameState['difficulty'] = opts.difficulty ?? 'balanced';
  const world = generateWorld(seed, {
    width: opts.width ?? WORLD_DEFAULTS.width,
    height: opts.height ?? WORLD_DEFAULTS.height,
  });

  const state: GameState = {
    version: GAME_VERSION,
    seed,
    rng: seedFromString(seed),
    tick: 0,
    world,
    settlements: [],
    citizens: [],
    cohorts: [],
    buildings: [],
    research: {
      insight: LIMITS.insightStart,
      totalInsight: LIMITS.insightStart,
      completed: {},
      current: null,
      queue: [],
      era: 0,
      affinity: {},
      discoveries: [],
      doctrine: null,
      doctrineChoices: [],
      nextDoctrineEra: 1,
    },
    society: {
      policies: {},
      taxRate: 0.12,
      rations: 'normal',
      workHours: 10,
      approval: 62,
      stability: 68,
      crime: 4,
      culturePoints: 0,
      traditions: [],
      festivals: [],
      classes: {
        laborer: { count: 0, wealth: 0, satisfaction: 62, approval: 0 },
        artisan: { count: 0, wealth: 0, satisfaction: 62, approval: 0 },
        scholar: { count: 0, wealth: 0, satisfaction: 62, approval: 0 },
        merchant: { count: 0, wealth: 0, satisfaction: 62, approval: 0 },
      },
      policyHistory: [],
      mods: {},
      lastElectionTick: -1,
      nextFestivalTick: -1,
    },
    market: {
      prices: {},
      tariff: 0.04,
      tradeBalance: 0,
      lastUpdateTick: 0,
      routes: [],
      caravans: [],
      nextRouteId: 1,
    },
    events: {
      active: [],
      history: [],
      cooldowns: {},
      seen: {},
      pending: [],
      nextDecisionId: 1,
      warnings: [],
      scheduled: [],
      tension: 0.12,
      lastEventTick: 0,
      quietDays: 0,
    },
    neighbors: { civs: [], nextId: 1 },
    exploration: {
      expeditions: [],
      nextId: 1,
      revealedTiles: 0,
      totalTiles: world.tiles.length,
      sitesFound: 0,
      sitesVisited: 0,
      mapReveal: 0,
      legendaryFound: [],
    },
    chronicle: [],
    milestones: { completed: {}, era: 0, eraProgress: 0 },
    objectives: { completed: {}, current: null },
    metrics: {
      series: {},
      sampledEvery: 1,
      lastSampleTick: -1,
      maxPoints: 420,
      lifetime: {},
      snapshots: [],
      lastSnapshotYear: 0,
    },
    megaprojects: {},
    notifications: [],
    settings: { ...DEFAULT_SETTINGS } as GameSettings,
    tutorial: { step: 0, milestonesSeen: [], hintsDismissed: {}, active: true, completed: false },
    flags: {},
    stats: {
      foundedTick: 0,
      populationPeak: 1,
      citizensBorn: 0,
      citizensDied: 0,
      citizensStarved: 0,
      migrantsArrived: 0,
      buildingsBuilt: 0,
      buildingsLost: 0,
      techsResearched: 0,
      eventsSurvived: 0,
      disasters: 0,
      resourcesGathered: 0,
      goodsCrafted: 0,
      sitesDiscovered: 0,
      neighborsMet: 0,
      caravansSent: 0,
      foodProduced: 0,
      insightEarned: 0,
      cultureEarned: 0,
      treesPlanted: 0,
      landRestored: 0,
      playDays: 0,
    },
    difficulty,
    gameOver: null,
    nextIds: {
      citizen: 1,
      building: 1,
      settlement: 1,
      event: 1,
      decision: 1,
      expedition: 1,
      caravan: 1,
      route: 1,
      chronicle: 1,
      notification: 1,
      marker: 1,
    },
    cache: emptyCache(),
  };

  // ---------------------------------------------------------------------
  // Market: every tradable resource starts at its base price.
  // ---------------------------------------------------------------------
  for (const id of content.resourceOrder) {
    const def = content.resources[id];
    if (!def) continue;
    state.market.prices[id] = {
      price: def.basePrice,
      base: def.basePrice,
      supply: 0,
      demand: 0,
      trend: 0,
      history: [def.basePrice],
    };
  }

  // ---------------------------------------------------------------------
  // Megaprojects start locked.
  // ---------------------------------------------------------------------
  for (const id of content.megaprojectOrder) {
    state.megaprojects[id] = { status: 'locked', progress: 0, startedTick: -1, invested: {} };
  }
  for (const b of content.buildingOrder) {
    const def = content.buildings[b];
    if (def?.tags?.includes('megaproject')) {
      // anchors are special buildings; nothing to initialise beyond meta
    }
  }

  // ---------------------------------------------------------------------
  // Capital settlement + first hearth.
  // ---------------------------------------------------------------------
  const startX = Math.round(world.startX);
  const startY = Math.round(world.startY);
  const capital = createSettlement(state, content, startX, startY, true);
  state.settlements.push(capital);

  // Starting stockpile (difficulty adjusted).
  const bonus = DIFFICULTIES[difficulty]?.startBonus ?? {};
  for (const res in RULES.startingResources) {
    if (content.resources[res]) capital.stock[res] = RULES.startingResources[res];
  }
  for (const res in bonus) {
    if (content.resources[res]) capital.stock[res] = (capital.stock[res] ?? 0) + bonus[res];
  }

  // Free hearth in the centre of the clearing.
  if (content.buildings['fire_pit']) {
    createBuilding(state, content, 'fire_pit', startX, startY, capital.id, { completed: true, free: true });
  }

  // Reveal the starting valley.
  revealArea(state, startX, startY, WORLDGEN.startRevealRadius, content);

  // The first settler.
  const founderRng = new Rng(state.rng);
  const founder = createCitizen(state, content, founderRng, {
    settlementId: capital.id,
    age: 26,
    sex: 'm',
    founder: true,
  });
  founder.name = STARTING_CITIZEN_NAMES[0].name;
  founder.surname = 'Ashfall';
  founder.notable = true;
  founder.skills.farming = 18;
  founder.skills.woodcraft = 22;
  founder.skills.building = 20;
  founder.traits = ['industrious', 'curious'];
  founder.profession = 'idle';

  // Founding doctrine options.
  const era0 = content.eras[0];
  if (era0?.doctrines?.length) {
    state.research.doctrineChoices = era0.doctrines.slice(0, 3);
  } else {
    const candidates = content.doctrineOrder
      .map((id) => content.doctrines[id])
      .filter((d) => d && d.era <= 0)
      .slice(0, 3)
      .map((d) => d.id);
    state.research.doctrineChoices = candidates;
  }

  // Initial systems caches.
  state.cache.globalMods = collectGlobalModifiers(state, content, RULES);
  recomputeSettlementCaches(state, content, capital);
  initMetrics(state);
  capital.treasury = LIMITS.treasuryStart;
  capital.influence = LIMITS.influenceStart;
  capital.morale = 64;
  capital.stability = 68;

  addChronicle(
    state,
    'The First Hearth Is Lit',
    `A single wanderer, ${founder.name} ${founder.surname}, drives a stake into the soil of an unnamed valley. By the water and the trees, a hearth is lit. Everything that follows begins here.`,
    'founding',
    3,
  );
  pushNotification(state, 'A hearth has been lit. Your people are one.', 'good', 'flame');
  setFlag(state, 'founders', 1);
  setFlag(state, 'year_founded', 1);

  return state;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export function createSettlement(state: GameState, content: Content, x: number, y: number, isCapital: boolean): Settlement {
  const id = nextId(state, 'settlement');
  const name = isCapital ? STARTING_SETTLEMENT_NAME : generateSettlementName(state, content);
  const st: Settlement = {
    id,
    name,
    x,
    y,
    foundedTick: state.tick,
    isCapital,
    stock: {},
    storageCap: LIMITS.storageBaseCapacity,
    storageUsed: 0,
    buildings: [],
    population: 1,
    workforce: 0,
    unemployed: 0,
    homeless: 0,
    housing: { capacity: 0, occupied: 0, quality: 0 },
    morale: 65,
    stability: 68,
    foodDays: 0,
    waterDays: 0,
    housingDays: 0,
    treasury: 0,
    insight: 0,
    culture: 0,
    influence: 0,
    taxesCollected: 0,
    upkeepPaid: 0,
    tradeBalance: 0,
    roadAccess: 0,
    connectivity: { [id]: 0 },
    landClaimed: 0,
    claimedTiles: [],
    alerts: [],
    specialization: null,
    lastCaravanTick: -999,
    mods: {},
    governor: {
      autoAssign: true,
      autoRepair: true,
      autoBuild: false,
      autoTrade: true,
      importUrgency: 0.5,
      reserveFoodDays: 12,
      reserveMaterials: 20,
    },
    autoBuildQueue: [],
    stats: {
      founded: state.tick,
      buildingsBuilt: 0,
      peakPopulation: 1,
      births: 0,
      deaths: 0,
      arrivals: 0,
      departures: 0,
      foodProduced: 0,
      foodConsumed: 0,
      daysStarving: 0,
      disastersSurvived: 0,
    },
  };
  claimAround(state, content, st, 3);
  return st;
}

/** Generate a procedural settlement name from the content name pools. */
export function generateSettlementName(state: GameState, content: Content): string {
  const rng = new Rng([...state.rng] as [number, number, number, number]);
  const prefix = content.names?.settlementPrefix?.length ? rng.pick(content.names.settlementPrefix) : 'New';
  const suffix = content.names?.settlementSuffix?.length ? rng.pick(content.names.settlementSuffix) : 'Hearth';
  return `${prefix}${suffix}`;
}

/** Claim walkable land tiles around a settlement centre. */
export function claimAround(state: GameState, content: Content, st: Settlement, radius: number): void {
  const w = state.world;
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = st.x + dx;
      const y = st.y + dy;
      if (!claimableTile(w, content, x, y)) continue;
      const idx = tileIndex(w, x, y);
      const tile = w.tiles[idx];
      if (!tile) continue;
      if (tile.settlementId >= 0 && tile.settlementId !== st.id) continue;
      if (tile.buildingId >= 0) continue;
      tile.settlementId = st.id;
      if (!st.claimedTiles.includes(idx)) st.claimedTiles.push(idx);
    }
  }
  st.claimedTiles.sort((a, b) => a - b);
  st.landClaimed = st.claimedTiles.length;
}

// ---------------------------------------------------------------------------
// Citizens
// ---------------------------------------------------------------------------

export interface CreateCitizenOptions {
  settlementId: number;
  age?: number;
  sex?: 'm' | 'f';
  name?: string;
  surname?: string;
  founder?: boolean;
  profession?: Citizen['profession'];
  education?: number;
  family?: { parentIds?: number[]; spouseId?: number };
  skills?: Partial<Citizen['skills']>;
}

const SKILL_IDS = ['farming', 'woodcraft', 'mining', 'building', 'crafting', 'scholarship', 'medicine', 'trade', 'leadership', 'combat', 'artistry', 'husbandry'];

export function createCitizen(state: GameState, content: Content, rng: Rng, opts: CreateCitizenOptions): Citizen {
  const sex = opts.sex ?? (rng.chance(0.5) ? 'm' : 'f');
  const names = content.names;
  const male = names?.male?.length ? names.male : ['Aren', 'Bram', 'Cael', 'Dorn', 'Ewan'];
  const female = names?.female?.length ? names.female : ['Ada', 'Bryn', 'Cara', 'Dara', 'Elowen'];
  const surnames = names?.surnames?.length ? names.surnames : ['Ashfall', 'Moor', 'Reed', 'Stone', 'Hollow'];
  const name = opts.name ?? (sex === 'm' ? rng.pick(male) : rng.pick(female));
  const surname = opts.surname ?? rng.pick(surnames);
  const age = opts.age ?? Math.max(16, Math.min(52, Math.round(gaussian(() => rng.next(), 27, 8))));
  const skills: Record<string, number> = {};
  for (const skill of SKILL_IDS) {
    let base = 4 + rng.range(0, 14);
    if (opts.profession && content.professions[opts.profession]?.skill === skill) base += 14;
    if (opts.skills?.[skill] !== undefined) base = opts.skills[skill] as number;
    skills[skill] = Math.round(Math.min(88, base));
  }
  const traitPool = content.traits ? Object.keys(content.traits) : [];
  const traits: string[] = [];
  const traitCount = rng.chance(0.55) ? 2 : 1;
  for (let i = 0; i < traitCount && traitPool.length; i++) {
    const t = rng.pick(traitPool);
    if (!traits.includes(t)) traits.push(t);
  }
  const education = opts.education ?? Math.round(2 + rng.range(0, 14) + (age > 18 ? rng.range(0, 10) : 0));
  const citizen: Citizen = {
    id: nextId(state, 'citizen'),
    name,
    surname,
    sex,
    age,
    alive: true,
    settlementId: opts.settlementId,
    origin: opts.founder ? 'founder' : 'born',
    bornTick: state.tick - Math.round(age * DAYS_PER_YEAR),
    deathTick: -1,
    deathCause: '',
    health: Math.round(86 + rng.range(0, 12)),
    morale: Math.round(64 + rng.range(0, 20)),
    hunger: 0,
    thirst: 0,
    needs: { food: 82, water: 82, shelter: 34, warmth: 68, health: 82, social: 62, purpose: 48, comfort: 38 },
    skills: skills as Citizen['skills'],
    traits,
    profession: opts.profession ?? (age < 12 ? 'child' : 'idle'),
    jobBuildingId: -1,
    homeBuildingId: -1,
    spouseId: opts.family?.spouseId ?? -1,
    parentIds: opts.family?.parentIds ?? [],
    childIds: [],
    friendIds: [],
    education,
    wealth: 0,
    income: 0,
    notable: false,
    pregnant: null,
    thoughts: [],
    lastMealTick: state.tick,
  };
  state.citizens.push(citizen);
  if (!opts.founder) {
    state.stats.citizensBorn++;
  }
  return citizen;
}

export function removeCitizen(state: GameState, citizen: Citizen, cause: string): void {
  if (!citizen.alive) return;
  citizen.alive = false;
  citizen.deathTick = state.tick;
  citizen.deathCause = cause;
  state.stats.citizensDied++;
  if (cause === 'starvation') state.stats.citizensStarved++;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface CreateBuildingOptions {
  completed?: boolean;
  free?: boolean;
}

/** Footprint tiles for a building at (x,y). */
export function footprint(defSize: number, x: number, y: number): { x: number; y: number }[] {
  if (defSize >= 2) {
    return [
      { x, y },
      { x: x + 1, y },
      { x, y: y + 1 },
      { x: x + 1, y: y + 1 },
    ];
  }
  return [{ x, y }];
}

export function createBuilding(
  state: GameState,
  content: Content,
  typeId: string,
  x: number,
  y: number,
  settlementId: number,
  opts: CreateBuildingOptions = {},
): Building | null {
  const def = content.buildings[typeId];
  if (!def) return null;
  const w = state.world;
  const tiles: Tile[] = [];
  for (const f of footprint(def.size, x, y)) {
    const t = tileAt(w, f.x, f.y);
    if (!t) return null;
    if (t.buildingId >= 0) return null;
    tiles.push(t);
  }
  const id = nextId(state, 'building');
  const b: Building = {
    id,
    typeId,
    settlementId,
    x,
    y,
    progress: opts.completed ? 1 : 0,
    active: true,
    enabled: true,
    condition: 1,
    workers: 0,
    workerIds: [],
    recipeId: def.recipes[0] ?? null,
    upgradeLevel: 0,
    priority: 1,
    builtTick: state.tick,
    efficiency: 0,
    shortages: {},
    status: opts.completed ? '' : 'Under construction',
    sourceStrength: 0,
    locked: false,
  };
  state.buildings.push(b);
  for (const t of tiles) t.buildingId = id;
  const st = state.settlements.find((s) => s.id === settlementId);
  if (st) {
    st.buildings.push(id);
    if (opts.completed) {
      st.stats.buildingsBuilt++;
      state.stats.buildingsBuilt++;
    }
  }
  return b;
}

export function destroyBuilding(state: GameState, content: Content, building: Building, cause: string): void {
  const def = buildingDef(content, building);
  for (const f of footprint(def?.size ?? 1, building.x, building.y)) {
    const t = tileAt(state.world, f.x, f.y);
    if (t && t.buildingId === building.id) t.buildingId = -1;
  }
  const st = state.settlements.find((s) => s.id === building.settlementId);
  if (st) {
    st.buildings = st.buildings.filter((id) => id !== building.id);
    st.stats.buildingsBuilt = Math.max(0, st.stats.buildingsBuilt - 1);
  }
  state.buildings = state.buildings.filter((b) => b.id !== building.id);
  state.stats.buildingsLost++;
  if (cause) pushNotification(state, `${def?.name ?? 'A building'} was lost to ${cause}.`, 'bad', 'skull');
}

// ---------------------------------------------------------------------------
// Fog of war
// ---------------------------------------------------------------------------

export function revealArea(state: GameState, cx: number, cy: number, radius: number, content: Content): number {
  const w = state.world;
  let revealed = 0;
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (!inBounds(w, x, y)) continue;
      const idx = tileIndex(w, x, y);
      if (w.explored[idx] === 1) continue;
      w.explored[idx] = 1;
      revealed++;
      const t = w.tiles[idx];
      if (t && t.siteIndex >= 0) {
        const site = w.sites[t.siteIndex];
        if (site && !site.discovered) {
          site.discovered = true;
          site.discoveredTick = state.tick;
          state.exploration.sitesFound++;
          const siteDef = content.sites[site.defId];
          if (siteDef) {
            pushNotification(state, `Discovered: ${siteDef.name} — ${siteDef.desc}`, 'discovery', 'eye');
          }
        }
      }
    }
  }
  state.exploration.revealedTiles = countExplored(w);
  state.exploration.mapReveal = state.exploration.totalTiles ? state.exploration.revealedTiles / state.exploration.totalTiles : 0;
  return revealed;
}

export function countExplored(w: WorldState): number {
  let n = 0;
  for (let i = 0; i < w.explored.length; i++) if (w.explored[i] === 1) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

export function recomputeSettlementCaches(state: GameState, content: Content, st: Settlement): void {
  st.population = 0;
  for (const c of state.citizens) if (c.alive && c.settlementId === st.id) st.population++;
  for (const co of state.cohorts) if (co.settlementId === st.id) st.population += co.count;
  st.foodDays = foodDaysOf(state, content, st);
  st.waterDays = waterDaysOf(state, st);
  st.storageUsed = Math.round(Object.values(st.stock).reduce((a, b) => a + b, 0) * 100) / 100;
}

export function rebuildCache(state: GameState, content: Content, rules = RULES): void {
  state.cache = emptyCache();
  state.cache.globalMods = collectGlobalModifiers(state, content, rules);
  for (const st of state.settlements) recomputeSettlementCaches(state, content, st);
  initMetrics(state);
}

export function initialSeasonLabel(state: GameState): string {
  return dateLabel(state.tick);
}
