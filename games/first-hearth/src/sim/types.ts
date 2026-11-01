/**
 * FIRST HEARTH — Core Simulation Types
 * ------------------------------------
 * Everything persisted in a save game lives in `GameState` and is composed only of
 * plain JSON-serialisable values (numbers, strings, booleans, arrays, records) plus
 * `Uint8Array` for the explored mask (handled specially by save.ts).
 *
 * Nothing in this file may import from rendering or UI. The simulation is pure,
 * deterministic and headless-testable.
 *
 * CONVENTIONS
 *  - Content identifiers (resources, buildings, techs, ...) are plain strings.
 *  - World tiles are stored row-major: index = y * width + x.
 *  - Time: 1 tick = 1 day. 16 days/season, 4 seasons, 64 days/year.
 *  - All modifier deltas are additive fractions: 0.1 = +10%, -0.05 = -5%.
 *  - Water/food/reagents are quantities in abstract "units".
 *  - `-1` means "none" for numeric entity references.
 */

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export const DAYS_PER_SEASON = 16;
export const SEASONS_PER_YEAR = 4;
export const DAYS_PER_YEAR = DAYS_PER_SEASON * SEASONS_PER_YEAR;

export type SeasonId = 'spring' | 'summer' | 'autumn' | 'winter';
export const SEASONS: SeasonId[] = ['spring', 'summer', 'autumn', 'winter'];

// ---------------------------------------------------------------------------
// Content identifiers
// ---------------------------------------------------------------------------

export type ResourceId = string;
export type BuildingId = string;
export type RecipeId = string;
export type TechId = string;
export type BranchId = string;
export type BiomeId = string;
export type SiteDefId = string;
export type EventId = string;
export type PolicyId = string;
export type DoctrineId = string;
export type MegaprojectId = string;
export type EraId = string;
export type AchievementId = string;
export type MilestoneId = string;
export type ProfessionId = string;
export type SkillId = string;
export type TraitId = string;
export type ClassId = 'laborer' | 'artisan' | 'scholar' | 'merchant';
export type SiteKind = 'ruin' | 'shrine' | 'grove' | 'spring' | 'cave' | 'crater' | 'wreck' | 'observatory' | 'wonder';

// ---------------------------------------------------------------------------
// Modifiers — aggregated numeric levers that content can pull.
// Every value is an additive fraction (0.1 => +10%) unless noted in MODIFIER_META.
// ---------------------------------------------------------------------------

export type ModifierKey =
  // labour & production
  | 'workSpeed'
  | 'buildSpeed'
  | 'craftSpeed'
  | 'farmYield'
  | 'orchardYield'
  | 'pastureYield'
  | 'forageYield'
  | 'huntYield'
  | 'fishYield'
  | 'lumberYield'
  | 'mineYield'
  | 'quarryYield'
  | 'inputEfficiency'
  | 'byproductYield'
  // land & ecology
  | 'soilRegen'
  | 'forestRegrow'
  | 'wildlifeRegen'
  | 'pollutionRate'
  | 'pollutionDecay'
  | 'beauty'
  | 'waterAvailability'
  | 'disasterResist'
  | 'disasterChance'
  // people
  | 'foodConsumption'
  | 'waterConsumption'
  | 'healthRate'
  | 'moraleRate'
  | 'moraleFlat'
  | 'birthRate'
  | 'deathRate'
  | 'migrationRate'
  | 'educationRate'
  | 'housingQuality'
  | 'crimeRate'
  // society & economy
  | 'researchRate'
  | 'insightFlat'
  | 'cultureRate'
  | 'stability'
  | 'taxEfficiency'
  | 'upkeepCost'
  | 'constructionCost'
  | 'storageCap'
  | 'spoilageRate'
  | 'tradeBuyPrice'
  | 'tradeSellPrice'
  | 'transportCapacity'
  | 'diplomacy'
  | 'combatStrength'
  // logistics & reach
  | 'roadSpeed'
  | 'expeditionSpeed'
  | 'gatherRadius'
  | 'storageTransferRate';

export const MODIFIER_META: Record<ModifierKey, { label: string; domain: string; good: 1 | -1 }> = {
  workSpeed: { label: 'Work speed', domain: 'Labour', good: 1 },
  buildSpeed: { label: 'Construction speed', domain: 'Labour', good: 1 },
  craftSpeed: { label: 'Crafting speed', domain: 'Industry', good: 1 },
  farmYield: { label: 'Farm yield', domain: 'Agriculture', good: 1 },
  orchardYield: { label: 'Orchard yield', domain: 'Agriculture', good: 1 },
  pastureYield: { label: 'Pasture yield', domain: 'Agriculture', good: 1 },
  forageYield: { label: 'Foraging yield', domain: 'Gathering', good: 1 },
  huntYield: { label: 'Hunting yield', domain: 'Gathering', good: 1 },
  fishYield: { label: 'Fishing yield', domain: 'Gathering', good: 1 },
  lumberYield: { label: 'Lumber yield', domain: 'Forestry', good: 1 },
  mineYield: { label: 'Mining yield', domain: 'Mining', good: 1 },
  quarryYield: { label: 'Quarry yield', domain: 'Mining', good: 1 },
  inputEfficiency: { label: 'Input efficiency', domain: 'Industry', good: 1 },
  byproductYield: { label: 'Byproduct yield', domain: 'Industry', good: 1 },
  soilRegen: { label: 'Soil regeneration', domain: 'Ecology', good: 1 },
  forestRegrow: { label: 'Forest regrowth', domain: 'Ecology', good: 1 },
  wildlifeRegen: { label: 'Wildlife regrowth', domain: 'Ecology', good: 1 },
  pollutionRate: { label: 'Pollution output', domain: 'Ecology', good: -1 },
  pollutionDecay: { label: 'Pollution dispersal', domain: 'Ecology', good: 1 },
  beauty: { label: 'Beauty', domain: 'Ecology', good: 1 },
  waterAvailability: { label: 'Water access', domain: 'Ecology', good: 1 },
  disasterResist: { label: 'Disaster resistance', domain: 'Ecology', good: 1 },
  disasterChance: { label: 'Disaster frequency', domain: 'Ecology', good: -1 },
  foodConsumption: { label: 'Food consumption', domain: 'People', good: -1 },
  waterConsumption: { label: 'Water consumption', domain: 'People', good: -1 },
  healthRate: { label: 'Health', domain: 'People', good: 1 },
  moraleRate: { label: 'Morale', domain: 'People', good: 1 },
  moraleFlat: { label: 'Morale (flat)', domain: 'People', good: 1 },
  birthRate: { label: 'Birth rate', domain: 'People', good: 1 },
  deathRate: { label: 'Death rate', domain: 'People', good: -1 },
  migrationRate: { label: 'Migration', domain: 'People', good: 1 },
  educationRate: { label: 'Education', domain: 'People', good: 1 },
  housingQuality: { label: 'Housing quality', domain: 'People', good: 1 },
  crimeRate: { label: 'Crime', domain: 'Society', good: -1 },
  researchRate: { label: 'Insight rate', domain: 'Science', good: 1 },
  insightFlat: { label: 'Insight (flat/day)', domain: 'Science', good: 1 },
  cultureRate: { label: 'Culture rate', domain: 'Society', good: 1 },
  stability: { label: 'Stability', domain: 'Society', good: 1 },
  taxEfficiency: { label: 'Tax efficiency', domain: 'Economy', good: 1 },
  upkeepCost: { label: 'Upkeep cost', domain: 'Economy', good: -1 },
  constructionCost: { label: 'Construction cost', domain: 'Economy', good: -1 },
  storageCap: { label: 'Storage capacity', domain: 'Economy', good: 1 },
  spoilageRate: { label: 'Spoilage', domain: 'Economy', good: -1 },
  tradeBuyPrice: { label: 'Import price', domain: 'Trade', good: -1 },
  tradeSellPrice: { label: 'Export price', domain: 'Trade', good: 1 },
  transportCapacity: { label: 'Transport capacity', domain: 'Trade', good: 1 },
  diplomacy: { label: 'Diplomacy', domain: 'Trade', good: 1 },
  combatStrength: { label: 'Combat strength', domain: 'Defence', good: 1 },
  roadSpeed: { label: 'Road speed', domain: 'Logistics', good: 1 },
  expeditionSpeed: { label: 'Expedition speed', domain: 'Exploration', good: 1 },
  gatherRadius: { label: 'Gathering radius', domain: 'Gathering', good: 1 },
  storageTransferRate: { label: 'Transfer rate', domain: 'Logistics', good: 1 },
};

export type ModifierDelta = Partial<Record<ModifierKey, number>>;

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------

export interface Deposit {
  resource: ResourceId;
  amount: number;
  initial: number;
  quality: number; // 0..1
  kind: 'surface' | 'underground' | 'aquifer';
}

export interface Tile {
  elev: number; // 0..1
  moisture: number; // 0..1 residual soil moisture (dynamic)
  temp: number; // baseline mean °C
  biome: BiomeId;
  fertility: number; // 0..1
  forest: number; // 0..1 tree cover
  forage: number; // 0..1 wild forage abundance
  wildlife: number; // 0..1 game density
  water: number; // 0..1 freshwater availability (river/lake/aquifer)
  pollution: number; // 0..1
  beauty: number; // 0..1 natural beauty
  road: number; // 0..1 road grade
  buildingId: number; // -1 if empty
  settlementId: number; // -1 if unclaimed
  deposit: Deposit | null;
  siteIndex: number; // index into world.sites, -1 if none
}

export interface Site {
  id: SiteDefId;
  x: number;
  y: number;
  discovered: boolean;
  visited: boolean;
  defId: SiteDefId;
  name: string;
  discoveredTick: number;
}

export interface RiverPath {
  points: { x: number; y: number }[];
  width: number;
}

export interface RegionInfo {
  id: number;
  name: string;
  biome: BiomeId;
  centroidX: number;
  centroidY: number;
  area: number;
  explored: boolean;
}

export interface WeatherState {
  season: SeasonId;
  dayInSeason: number;
  year: number;
  temperature: number; // current °C
  rainfall: number; // 0..1 today's rain intensity
  drought: number; // 0..1 accumulated drought severity
  soilMoisture: number; // 0..1 regional soil moisture
  storm: number; // 0..1 active storm severity
  wind: number; // 0..1
  snow: number; // 0..1 snow cover
  forecast: string; // human readable
}

export interface ClimateState {
  // long-run drift caused by deforestation / emissions
  warming: number; // °C above baseline
  deforestation: number; // 0..1 global forest loss fraction
  biodiversity: number; // 0..1
  pollution: number; // 0..1 global
  co2: number; // abstract
  seaLevelRise: number; // 0..1
}

export interface WorldState {
  width: number;
  height: number;
  tiles: Tile[];
  explored: Uint8Array; // 0 = unknown, 1 = explored (charted)
  rivers: RiverPath[];
  lakes: number[]; // tile indices
  regions: RegionInfo[];
  sites: Site[];
  weather: WeatherState;
  climate: ClimateState;
  startX: number;
  startY: number;
  seedLabel: string;
  /** Cosmetic expedition markers, driven by exploration system. */
  markers: WorldMarker[];
}

export interface WorldMarker {
  id: number;
  kind: 'expedition' | 'caravan' | 'raider' | 'scout';
  x: number;
  y: number;
  tx: number;
  ty: number;
  label: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export interface JobSlot {
  profession: ProfessionId;
  count: number;
  skill: SkillId;
}

export interface GatherSpec {
  /** What is harvested. */
  resource: ResourceId;
  source: 'forest' | 'forage' | 'wildlife' | 'water' | 'deposit' | 'fertility' | 'beauty';
  /** Units per worker-day at 100% efficiency. */
  rate: number;
  /** Radius in tiles searched for the source. */
  radius: number;
  /** Fraction of the local source consumed per unit harvested (0 = renewable flux). */
  depletion: number;
  /** Minimum source strength needed to work the building. */
  minSource?: number;
}

export interface RecipeDef {
  id: RecipeId;
  name: string;
  buildingId?: BuildingId;
  inputs: Record<ResourceId, number>; // per full crew-day
  outputs: Record<ResourceId, number>;
  /** Workforces needed for the full rate. Defaults to building job total. */
  workers: number;
  /** Skill that governs efficiency. */
  skill: SkillId;
  /** Optional environment-driven extraction performed alongside the recipe. */
  gather?: GatherSpec;
  /** Building must be powered (consumes `energy` from stock) to run. */
  power?: number;
  requiresTech?: TechId[];
  tags?: string[];
  /** Alternative recipes shown as selectable modes. */
  desc?: string;
}

export interface BuildingDef {
  id: BuildingId;
  name: string;
  category: BuildingCategory;
  desc: string;
  flavor?: string;
  era: number;
  cost: Record<ResourceId, number>;
  upkeep: Record<ResourceId, number>; // per day at full activity
  buildTicks: number;
  size: 1 | 2;
  jobs: JobSlot[];
  recipes: RecipeId[];
  housing?: { capacity: number; quality: number };
  storage?: number; // bonus storage units
  /** Passive modifiers granted while the building operates in its settlement. */
  effects?: ModifierDelta;
  pollution: number; // 0..100 per day
  beauty: number; // -10..+10 local aura
  waterUse: number; // units/day
  energyUse: number; // units/day
  /** Buildings that need water adjacent (well, mill, dock). */
  placement: {
    biomes?: BiomeId[];
    needWater?: boolean;
    needForest?: boolean;
    needDeposit?: ResourceId;
    needFlat?: boolean;
    avoidCenter?: boolean;
    unique?: boolean;
    maxPerSettlement?: number;
    requiresRoad?: boolean;
  };
  requiresTech: TechId[];
  upgradeTo?: BuildingId;
  tags?: string[];
  /** Culture/health/education services rendered once per day. */
  service?: { kind: 'water' | 'health' | 'education' | 'culture' | 'safety' | 'trade' | 'faith'; amount: number; radius: number };
  /** Visual hints for the renderer. */
  visual: BuildingVisual;
}

export type BuildingCategory =
  | 'housing'
  | 'food'
  | 'gathering'
  | 'industry'
  | 'energy'
  | 'water'
  | 'storage'
  | 'logistics'
  | 'science'
  | 'society'
  | 'defence'
  | 'beauty'
  | 'special';

export interface BuildingVisual {
  icon: string; // icon key understood by the UI icon set
  roof: string; // hex colour
  wall: string;
  accent?: string;
  shape?: 'house' | 'tower' | 'hall' | 'works' | 'farm' | 'mine' | 'well' | 'temple' | 'wall' | 'dock' | 'engine';
  height?: number; // 0.5 .. 3
  smoke?: boolean;
  glow?: boolean;
  flag?: boolean;
}

export interface Building {
  id: number;
  typeId: BuildingId;
  settlementId: number;
  x: number;
  y: number;
  /** 0..1 construction progress; 1 = complete. */
  progress: number;
  active: boolean;
  enabled: boolean;
  condition: number; // 0..1 structural health
  workers: number; // headcount assigned
  workerIds: number[];
  recipeId: RecipeId | null;
  upgradeLevel: number;
  priority: number; // 0 low, 1 normal, 2 high, 3 critical
  builtTick: number;
  /** Cached production efficiency 0..1.5 for UI. */
  efficiency: number;
  /** Cached input shortages for UI. */
  shortages: Record<ResourceId, number>;
  /** Cached status reason for UI ("Awaiting workers", "No input: timber"). */
  status: string;
  /** Cached gather source strength (0..1). */
  sourceStrength: number;
  /** Construction material delivered flag (cost is paid upfront). */
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Population
// ---------------------------------------------------------------------------

export interface Needs {
  food: number; // 0..100 satisfaction
  water: number;
  shelter: number;
  warmth: number;
  health: number;
  social: number;
  purpose: number;
  comfort: number;
}

export interface Citizen {
  id: number;
  name: string;
  surname: string;
  sex: 'm' | 'f';
  age: number; // years, fractional
  alive: boolean;
  settlementId: number;
  origin: 'founder' | 'born' | 'migrant' | 'cohort';
  bornTick: number;
  deathTick: number;
  deathCause: string;
  health: number; // 0..100
  morale: number; // 0..100
  hunger: number; // 0..100 (100 = starving)
  thirst: number; // 0..100
  needs: Needs;
  skills: Record<SkillId, number>; // 0..100
  traits: TraitId[];
  profession: ProfessionId | 'child' | 'student' | 'idle';
  jobBuildingId: number;
  homeBuildingId: number;
  spouseId: number;
  parentIds: number[];
  childIds: number[];
  friendIds: number[];
  education: number; // 0..100
  wealth: number;
  income: number;
  notable: boolean;
  pregnant: { fatherId: number; dueTick: number } | null;
  thoughts: string[];
  lastMealTick: number;
  moodHistory?: number;
}

/** Aggregated population bucket used when the settlement exceeds detailed-sim capacity. */
export interface Cohort {
  id: number;
  settlementId: number;
  profession: ProfessionId | 'child';
  ageBand: 'child' | 'young' | 'adult' | 'elder';
  count: number;
  health: number;
  morale: number;
  education: number;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export interface Stockpile {
  [resource: ResourceId]: number;
}

export interface HousingStats {
  capacity: number;
  occupied: number;
  quality: number; // weighted average 0..5
}

export interface Alert {
  id: string;
  kind: 'food' | 'water' | 'housing' | 'jobs' | 'pollution' | 'health' | 'security' | 'economy' | 'ecology' | 'event';
  severity: 1 | 2 | 3;
  title: string;
  detail: string;
  sinceTick: number;
}

export interface Settlement {
  id: number;
  name: string;
  x: number;
  y: number;
  foundedTick: number;
  isCapital: boolean;
  stock: Stockpile;
  storageCap: number;
  storageUsed: number;
  buildings: number[];
  population: number;
  workforce: number;
  unemployed: number;
  homeless: number;
  housing: HousingStats;
  morale: number;
  stability: number;
  foodDays: number;
  waterDays: number;
  housingDays: number;
  treasury: number;
  insight: number;
  culture: number;
  influence: number;
  taxesCollected: number;
  upkeepPaid: number;
  tradeBalance: number;
  roadAccess: number; // 0..1 fraction of buildings with road access
  connectivity: Record<number, number>; // settlementId -> road path length (days), 0 = self
  landClaimed: number;
  claimedTiles: number[];
  alerts: Alert[];
  specialization: string | null;
  lastCaravanTick: number;
  /** Cached per-settlement modifiers from buildings. */
  mods: ModifierDelta;
  governor: GovernorSettings;
  autoBuildQueue: BuildingId[];
  stats: SettlementStats;
}

export interface SettlementStats {
  founded: number;
  buildingsBuilt: number;
  peakPopulation: number;
  births: number;
  deaths: number;
  arrivals: number;
  departures: number;
  foodProduced: number;
  foodConsumed: number;
  daysStarving: number;
  disastersSurvived: number;
}

export interface GovernorSettings {
  autoAssign: boolean;
  autoRepair: boolean;
  autoBuild: boolean;
  autoTrade: boolean;
  /** 0 = stockpile everything, 1 = aggressive import */
  importUrgency: number;
  reserveFoodDays: number;
  reserveMaterials: number;
}

// ---------------------------------------------------------------------------
// Research, society, economy
// ---------------------------------------------------------------------------

export interface ResearchState {
  insight: number;
  totalInsight: number;
  completed: Record<TechId, number>; // tech id -> tick completed
  current: TechId | null;
  queue: TechId[];
  era: number;
  affinity: Record<BranchId, number>;
  discoveries: string[]; // flavor log of discoveries
  doctrine: DoctrineId | null;
  doctrineChoices: DoctrineId[];
  nextDoctrineEra: number;
}

export interface ClassState {
  count: number;
  wealth: number;
  satisfaction: number; // 0..100
  approval: number; // -100..100
}

export interface SocietyState {
  policies: Record<PolicyId, boolean>;
  taxRate: number; // 0..0.45
  rations: 'meager' | 'normal' | 'generous';
  workHours: number; // 8, 10, 12
  approval: number; // 0..100
  stability: number; // 0..100
  crime: number; // 0..100
  culturePoints: number;
  traditions: string[];
  festivals: string[];
  classes: Record<ClassId, ClassState>;
  policyHistory: { policy: PolicyId; tick: number; on: boolean }[];
  /** Temporary modifiers from policies/doctrines/events. */
  mods: ModifierDelta;
  lastElectionTick: number;
  nextFestivalTick: number;
}

export interface PriceInfo {
  price: number;
  base: number;
  supply: number;
  demand: number;
  trend: number;
  history: number[];
}

export interface TradeRoute {
  id: number;
  fromSettlement: number;
  toKind: 'neighbor' | 'settlement';
  toId: number;
  resource: ResourceId;
  amountPerDay: number; // + import / - export? use direction
  direction: 'import' | 'export';
  active: boolean;
  establishedTick: number;
}

export interface MarketState {
  prices: Record<ResourceId, PriceInfo>;
  tariff: number;
  tradeBalance: number;
  lastUpdateTick: number;
  routes: TradeRoute[];
  caravans: Caravan[];
  nextRouteId: number;
}

export interface Caravan {
  id: number;
  routeId: number;
  kind: 'player' | 'neighbor';
  x: number;
  y: number;
  tx: number;
  ty: number;
  path: { x: number; y: number }[];
  progress: number; // 0..1
  cargo: Stockpile;
  label: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Events & decisions
// ---------------------------------------------------------------------------

export type Condition =
  | { kind: 'metric'; metric: string; op: '>' | '<' | '>=' | '<=' | '==' | '!='; value: number }
  | { kind: 'all'; conditions: Condition[] }
  | { kind: 'any'; conditions: Condition[] }
  | { kind: 'not'; condition: Condition }
  | { kind: 'flag'; flag: string; op: '==' | '!=' | '>' | '<'; value: number | string | boolean }
  | { kind: 'hasTech'; tech: TechId }
  | { kind: 'hasPolicy'; policy: PolicyId }
  | { kind: 'era'; op: '>=' | '<=' | '=='; value: number }
  | { kind: 'random'; chance: number };

export type EventEffect =
  | { kind: 'stock'; settlement: 'capital' | 'all' | 'poorest' | 'richest'; resource: ResourceId; amount: number; mode?: 'add' | 'mul' }
  | { kind: 'stockFraction'; settlement: 'capital' | 'all'; resource: ResourceId; fraction: number }
  | { kind: 'morale'; settlement: 'capital' | 'all'; amount: number }
  | { kind: 'health'; settlement: 'capital' | 'all'; amount: number }
  | { kind: 'kill'; settlement: 'capital' | 'all'; fraction: number; cause: string }
  | { kind: 'migrate'; settlement: 'capital' | 'all'; count: number; profession?: ProfessionId }
  | { kind: 'tempoModifier'; key: ModifierKey; value: number; days: number }
  | { kind: 'settlementModifier'; key: ModifierKey; value: number; days: number }
  | { kind: 'tileDeposit'; resource: ResourceId; amount: number; radius: number }
  | { kind: 'forest'; amount: number; radius: number }
  | { kind: 'fertility'; amount: number; radius: number }
  | { kind: 'pollution'; amount: number; radius: number }
  | { kind: 'discoverSite'; siteId?: SiteDefId; radius: number }
  | { kind: 'reveal'; radius: number }
  | { kind: 'relation'; neighborId: number; amount: number }
  | { kind: 'treasury'; settlement: 'capital' | 'all'; amount: number }
  | { kind: 'insight'; amount: number }
  | { kind: 'culture'; amount: number }
  | { kind: 'unlockBuilding'; buildingId: BuildingId }
  | { kind: 'grantTech'; tech: TechId }
  | { kind: 'flag'; flag: string; value: number | boolean }
  | { kind: 'chronicle'; title: string; body: string; importance: 1 | 2 | 3 }
  | { kind: 'notification'; text: string; severity: 'info' | 'good' | 'warn' | 'bad' | 'discovery' }
  | { kind: 'scheduleEvent'; eventId: EventId; delayDays: number }
  | { kind: 'unlockPolicy'; policy: PolicyId }
  | { kind: 'destroyBuildings'; count: number }
  | { kind: 'raid'; strength: number }
  | { kind: 'spawnRefugees'; count: number }
  | { kind: 'inspiration'; amount: number; branch?: BranchId };

export interface EventChoice {
  id: string;
  label: string;
  tooltip: string;
  cost?: Record<ResourceId, number>;
  effects: EventEffect[];
  requires?: Condition;
}

export interface EventDef {
  id: EventId;
  title: string;
  category: 'nature' | 'economy' | 'society' | 'science' | 'migration' | 'conflict' | 'discovery' | 'omen' | 'boom' | 'crisis';
  icon: string;
  severity: 1 | 2 | 3;
  weight: number;
  minEra: number;
  maxEra?: number;
  cooldownDays: number;
  once?: boolean;
  condition: Condition;
  /** Days of advanced warning (0 = sudden). */
  telegraphDays: number;
  /** Text shown in warning. */
  warningText?: string;
  /** Body text when it fires. */
  text: string;
  /** Causes shown to the player ("Drought: moisture has fallen below 20% for 12 days"). */
  causeHints?: string[];
  choices?: EventChoice[];
  autoEffects?: EventEffect[];
  chain?: { eventId: EventId; delayDays: number }[];
  /** Event can fire only if this flag is false. */
  requiresFlag?: string;
}

export interface PendingDecision {
  id: number;
  eventId: EventId;
  title: string;
  text: string;
  choices: EventChoice[];
  createdTick: number;
  severity: 1 | 2 | 3;
  category: EventDef['category'];
  icon: string;
  causes: string[];
}

export interface ActiveEvent {
  id: number;
  eventId: EventId;
  startTick: number;
  endTick: number;
  title: string;
  modifier: ModifierDelta;
  settlementId: number; // -1 = global
  kind: 'tempo' | 'persistent';
}

export interface Warning {
  id: string;
  severity: 1 | 2 | 3;
  title: string;
  detail: string;
  cause: string;
  metric?: number;
  threshold?: number;
  daysUntil?: number;
  actionsHint?: string;
}

export interface EventDirectorState {
  active: ActiveEvent[];
  history: { eventId: EventId; tick: number; choiceId?: string }[];
  cooldowns: Record<EventId, number>; // tick when available again
  seen: Record<EventId, number>;
  pending: PendingDecision[];
  nextDecisionId: number;
  warnings: Warning[];
  scheduled: { eventId: EventId; fireTick: number }[];
  tension: number; // 0..1 drama pressure
  lastEventTick: number;
  quietDays: number;
}

// ---------------------------------------------------------------------------
// Neighbours, diplomacy, exploration
// ---------------------------------------------------------------------------

export type NeighborArchetype = 'agrarian' | 'mercantile' | 'martial' | 'scholarly' | 'nomadic';

export interface NeighborCiv {
  id: number;
  name: string;
  archetype: NeighborArchetype;
  color: string;
  capital: { x: number; y: number };
  discovered: boolean;
  discoveredTick: number;
  attitude: number; // -100..100
  relation: 'unknown' | 'neutral' | 'trade' | 'alliance' | 'war';
  wealth: number;
  military: number;
  techLevel: number;
  population: number;
  exports: ResourceId[];
  imports: ResourceId[];
  lastContactTick: number;
  offers: { kind: 'trade' | 'gift' | 'demand' | 'alliance' | 'war'; resource?: ResourceId; amount?: number; text: string; expiresTick: number }[];
  raidCooldown: number;
}

export interface NeighborState {
  civs: NeighborCiv[];
  nextId: number;
}

export interface Expedition {
  id: number;
  kind: 'scout' | 'settle' | 'survey';
  settlementId: number;
  x: number;
  y: number;
  tx: number;
  ty: number;
  progress: number; // 0..1
  party: number;
  label: string;
  /** Tile indices revealed so far (for incremental fog). */
  revealed: number[];
  speed: number;
  supplies: number;
  returnTick: number;
}

export interface ExplorationState {
  expeditions: Expedition[];
  nextId: number;
  revealedTiles: number;
  totalTiles: number;
  sitesFound: number;
  sitesVisited: number;
  mapReveal: number; // 0..1
  legendaryFound: string[];
}

// ---------------------------------------------------------------------------
// History, objectives, metrics
// ---------------------------------------------------------------------------

export interface ChronicleEntry {
  id: number;
  tick: number;
  year: number;
  season: SeasonId;
  title: string;
  body: string;
  kind: 'founding' | 'growth' | 'disaster' | 'discovery' | 'society' | 'conflict' | 'trade' | 'nature' | 'milestone' | 'legend';
  importance: 1 | 2 | 3;
}

export interface MilestoneState {
  completed: Record<MilestoneId, number>;
  era: number;
  eraProgress: number; // 0..1
}

export interface ObjectiveState {
  completed: Record<string, number>;
  current: string | null;
}

export interface MetricPoint {
  tick: number;
  values: Record<string, number>;
}

export interface MetricsState {
  series: Record<string, number[]>; // sampled daily, capped ring
  sampledEvery: number;
  lastSampleTick: number;
  maxPoints: number;
  lifetime: Record<string, number>; // counters
  snapshots: MetricPoint[]; // yearly snapshots for charts
  lastSnapshotYear: number;
}

export interface GameSettings {
  speed: number; // 0 paus, 1..4
  autosave: boolean;
  autoAssign: boolean;
  showHints: boolean;
  reducedMotion: boolean;
  particleDensity: number; // 0..1
  uiScale: number;
  tooltips: boolean;
  colorblind: boolean;
  masterVolume?: number;
}

export interface TutorialState {
  step: number;
  milestonesSeen: string[];
  hintsDismissed: Record<string, boolean>;
  active: boolean;
  completed: boolean;
}

export interface MegaprojectState {
  status: 'locked' | 'available' | 'building' | 'done';
  progress: number;
  startedTick: number;
  invested: Stockpile;
}

export interface Notification {
  id: number;
  tick: number;
  text: string;
  severity: 'info' | 'good' | 'warn' | 'bad' | 'discovery' | 'milestone';
  icon: string;
  read: boolean;
}

// ---------------------------------------------------------------------------
// Transient cache (NOT serialised; rebuilt on load)
// ---------------------------------------------------------------------------

export interface SimCache {
  globalMods: ModifierDelta;
  settlementMods: Record<number, ModifierDelta>;
  radiusMap: Map<number, number[]>; // tile index -> nearby tile indices (cached per radius)
  roadAccess: Record<number, number>; // building id -> access 0..1
  neighborResourceCache: Record<string, number>;
  lastRoadUpdate: number;
  breakdown: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------

export interface NextIds {
  citizen: number;
  building: number;
  settlement: number;
  event: number;
  decision: number;
  expedition: number;
  caravan: number;
  route: number;
  chronicle: number;
  notification: number;
  marker: number;
}

export interface GameState {
  version: number;
  seed: string;
  rng: [number, number, number, number];
  tick: number; // days elapsed
  world: WorldState;
  settlements: Settlement[];
  citizens: Citizen[];
  cohorts: Cohort[];
  buildings: Building[];
  research: ResearchState;
  society: SocietyState;
  market: MarketState;
  events: EventDirectorState;
  neighbors: NeighborState;
  exploration: ExplorationState;
  chronicle: ChronicleEntry[];
  milestones: MilestoneState;
  objectives: ObjectiveState;
  metrics: MetricsState;
  megaprojects: Record<MegaprojectId, MegaprojectState>;
  notifications: Notification[];
  settings: GameSettings;
  tutorial: TutorialState;
  flags: Record<string, number>; // numeric counters / mechanic flags
  stats: LifetimeStats;
  difficulty: 'gentle' | 'balanced' | 'harsh';
  gameOver: { tick: number; cause: string } | null;
  nextIds: NextIds;
  /** Transient: not saved. */
  cache: SimCache;
}

export interface LifetimeStats {
  foundedTick: number;
  populationPeak: number;
  citizensBorn: number;
  citizensDied: number;
  citizensStarved: number;
  migrantsArrived: number;
  buildingsBuilt: number;
  buildingsLost: number;
  techsResearched: number;
  eventsSurvived: number;
  disasters: number;
  resourcesGathered: number;
  goodsCrafted: number;
  sitesDiscovered: number;
  neighborsMet: number;
  caravansSent: number;
  foodProduced: number;
  insightEarned: number;
  cultureEarned: number;
  treesPlanted: number;
  landRestored: number;
  playDays: number;
}

// ---------------------------------------------------------------------------
// Content definitions
// ---------------------------------------------------------------------------

export type ResourceCategory =
  | 'food'
  | 'raw'
  | 'refined'
  | 'component'
  | 'luxury'
  | 'science'
  | 'energy'
  | 'abstract';

export interface ResourceDef {
  id: ResourceId;
  name: string;
  category: ResourceCategory;
  tier: number; // 0 raw .. 4 advanced
  color: string;
  icon: string;
  desc: string;
  basePrice: number;
  edible?: number; // food units provided per unit (0 for non-food)
  perishable?: boolean;
  tags?: string[];
  /** Shown in the HUD resource bar. */
  core?: boolean;
  /** Can be sold at market. */
  tradable?: boolean;
}

export interface BiomeDef {
  id: BiomeId;
  name: string;
  desc: string;
  color: string;
  colorAlt: string;
  waterColor: string;
  elevationRange: [number, number];
  tempRange: [number, number];
  moistureRange: [number, number];
  fertility: number;
  forage: number;
  forest: number;
  wildlife: number;
  beauty: number;
  walkCost: number;
  deposits: { resource: ResourceId; chance: number; richness: number; kind: 'surface' | 'underground' }[];
  rain: number; // 0..1 base
  tempOffset: number;
  tags?: string[];
  unlockedByDefault: boolean;
  unlockEra?: number;
  landmark?: string;
}

export interface BranchDef {
  id: BranchId;
  name: string;
  desc: string;
  color: string;
  icon: string;
}

export interface TechDef {
  id: TechId;
  name: string;
  branch: BranchId;
  era: number;
  cost: number; // insight
  requires: TechId[];
  desc: string;
  flavor?: string;
  effects?: ModifierDelta;
  unlocksBuildings?: BuildingId[];
  unlocksPolicies?: PolicyId[];
  unlocksMechanics?: string[];
  /** Mutually exclusive alternative discoveries. */
  excludes?: TechId[];
  /** Extra one-time benefit. */
  bonus?: { insight?: number; culture?: number; revealRadius?: number; stock?: Record<ResourceId, number>; flag?: string };
  quote?: string;
}

export interface PolicyDef {
  id: PolicyId;
  name: string;
  desc: string;
  era: number;
  cost: number; // influence
  requiresTech: TechId[];
  effects: ModifierDelta;
  /** Approval contribution per class (-1..1). */
  classSupport: Partial<Record<ClassId, number>>;
  upkeep: { insight?: number; influence?: number; treasury?: number };
  conflicts?: PolicyId[];
  flavor?: string;
}

export interface DoctrineDef {
  id: DoctrineId;
  name: string;
  motto: string;
  desc: string;
  era: number;
  color: string;
  icon: string;
  effects: ModifierDelta;
  playstyle: string;
  uniqueBuilding?: BuildingId;
  bonusText: string[];
}

export interface EraDef {
  id: EraId;
  name: string;
  index: number;
  desc: string;
  requirement: { techs: number; population: number; buildings?: number; insight?: number; culture?: number };
  doctrines: DoctrineId[];
  unlocksText: string;
}

export interface SiteDef {
  id: SiteDefId;
  name: string;
  kind: SiteKind;
  desc: string;
  icon: string;
  color: string;
  /** One-time effects when visited. */
  effects: EventEffect[];
  requiresExpedition: boolean;
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary';
  chronicleTitle?: string;
  chronicleBody?: string;
}

export interface AchievementDef {
  id: AchievementId;
  name: string;
  desc: string;
  icon: string;
  hidden?: boolean;
  condition: Condition;
  reward?: { insight?: number; culture?: number; morale?: number };
}

export interface MilestoneDef {
  id: MilestoneId;
  name: string;
  desc: string;
  icon: string;
  condition: Condition;
  era?: number;
  chronicleTitle?: string;
  chronicleBody?: string;
  reward?: { insight?: number; culture?: number; treasury?: number };
  kind: 'objective' | 'achievement' | 'era';
}

export interface MegaprojectDef {
  id: MegaprojectId;
  name: string;
  desc: string;
  era: number;
  icon: string;
  cost: Record<ResourceId, number>;
  insightCost: number;
  durationDays: number;
  requiresTech: TechId[];
  effects: ModifierDelta;
  completionChronicle: { title: string; body: string };
  bonus: EventEffect[];
  stages: { name: string; effectText: string }[];
}

export interface TutorialTipDef {
  id: string;
  title: string;
  body: string;
  condition: Condition;
  anchor?: string;
  step: number;
}

export interface NamePools {
  male: string[];
  female: string[];
  surnames: string[];
  settlementPrefix: string[];
  settlementSuffix: string[];
  neighborNames: string[];
  neighborTitles: string[];
  traitFlavor: Record<TraitId, string>;
}

export interface TraitDef {
  id: TraitId;
  name: string;
  desc: string;
  icon: string;
  effects: Partial<Record<'workSpeed' | 'morale' | 'health' | 'learning' | 'sociality' | 'fertility', number>>;
}

export interface Content {
  version: string;
  resources: Record<ResourceId, ResourceDef>;
  resourceOrder: ResourceId[];
  buildings: Record<BuildingId, BuildingDef>;
  buildingOrder: BuildingId[];
  recipes: Record<RecipeId, RecipeDef>;
  techs: Record<TechId, TechDef>;
  techOrder: TechId[];
  branches: Record<BranchId, BranchDef>;
  biomes: Record<BiomeId, BiomeDef>;
  biomeOrder: BiomeId[];
  sites: Record<SiteDefId, SiteDef>;
  siteOrder: SiteDefId[];
  events: Record<EventId, EventDef>;
  eventOrder: EventId[];
  policies: Record<PolicyId, PolicyDef>;
  policyOrder: PolicyId[];
  doctrines: Record<DoctrineId, DoctrineDef>;
  doctrineOrder: DoctrineId[];
  eras: EraDef[];
  achievements: AchievementDef[];
  milestones: MilestoneDef[];
  megaprojects: Record<MegaprojectId, MegaprojectDef>;
  megaprojectOrder: MegaprojectId[];
  names: NamePools;
  traits: Record<TraitId, TraitDef>;
  tutorial: TutorialTipDef[];
  skills: Record<SkillId, { name: string; icon: string; color: string; desc: string }>;
  professions: Record<ProfessionId, { name: string; icon: string; skill: SkillId; class: ClassId }>;
}

// ---------------------------------------------------------------------------
// Simulation plumbing
// ---------------------------------------------------------------------------

export interface GameRules {
  /** Population beyond which detailed citizens are folded into cohorts. */
  detailedCitizenCap: number;
  daysPerSeason: number;
  daysPerYear: number;
  /** Base consumption per citizen per day. */
  foodPerCitizen: number;
  waterPerCitizen: number;
  /** Base insight per scholar-day. */
  insightPerScholar: number;
  /** Fraction of adults that can work. */
  laborFraction: number;
  /** Birth chance per fertile couple per day. */
  birthChance: number;
  startingResources: Record<ResourceId, number>;
  startYear: number;
  maxNotifications: number;
  metricsMaxPoints: number;
}

export interface SimContext {
  s: GameState;
  c: Content;
  rules: GameRules;
  tick: number;
  rng: () => number;
  /** Global modifiers including active events. */
  mods: ModifierDelta;
  /** Log a notification to the player. */
  notify: (text: string, severity?: Notification['severity'], icon?: string) => void;
  /** Log a chronicle entry. */
  chronicle: (title: string, body: string, kind: ChronicleEntry['kind'], importance?: 1 | 2 | 3) => void;
  /** Developer/simulation log line (debug scan). */
  log: (message: string) => void;
  /** Add an insight discovery flavor line. */
  discover: (text: string) => void;
}

/** System functions mutate state. Order is defined in tick.ts. */
export type SimSystem = (ctx: SimContext) => void;

export interface ActionResult {
  ok: boolean;
  message?: string;
  cost?: Record<ResourceId, number>;
}

/** Runtime UI/application contract — see src/app.ts. */
export interface ViewState {
  tileX: number;
  tileY: number;
  zoom: number;
  offsetX: number;
  offsetY: number;
  hoverTile: number;
  selectedTile: number;
  selectedBuildingId: number;
  selectedCitizenId: number;
  selectedSettlementId: number;
  buildMode: BuildingId | null;
  overlay: OverlayMode;
  showGrid: boolean;
  showRange: boolean;
  paused: boolean;
}

export type OverlayMode =
  | 'none'
  | 'fertility'
  | 'forest'
  | 'water'
  | 'pollution'
  | 'beauty'
  | 'deposits'
  | 'roads'
  | 'population'
  | 'supply'
  | 'resources';
