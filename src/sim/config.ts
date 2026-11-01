/**
 * Central balance and rules configuration. All systems read from here so that
 * QA and designers can retune the game in one place.
 */
import type { GameRules, ModifierDelta, ResourceId } from './types';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from './types';

export const GAME_VERSION = 1;
export const SAVE_VERSION = 1;

export const RULES: GameRules = {
  detailedCitizenCap: 1400,
  daysPerSeason: DAYS_PER_SEASON,
  daysPerYear: DAYS_PER_YEAR,
  foodPerCitizen: 0.6,
  waterPerCitizen: 0.75,
  insightPerScholar: 1.15,
  laborFraction: 0.62,
  birthChance: 0.0115,
  startYear: 1,
  maxNotifications: 180,
  metricsMaxPoints: 420,
  startingResources: {
    berries: 18,
    wood: 42,
    stone: 14,
    fiber: 10,
  },
};

export type Difficulty = 'gentle' | 'balanced' | 'harsh';

export const DIFFICULTIES: Record<Difficulty, { label: string; desc: string; mods: ModifierDelta; startBonus: Record<ResourceId, number> }> = {
  gentle: {
    label: 'Hearthlight',
    desc: 'A forgiving land. Disasters are rarer, people are hardier. For learning the systems.',
    mods: { moraleFlat: 0.06, healthRate: 0.1, birthRate: 0.12, disasterResist: 0.25, deathRate: 0.05 },
    startBonus: { berries: 10, wood: 8, stone: 4 },
  },
  balanced: {
    label: 'The Living World',
    desc: 'The intended experience. A world that pushes back but always leaves a path forward.',
    mods: {},
    startBonus: {},
  },
  harsh: {
    label: 'Iron Winter',
    desc: 'A hungry, unforgiving world. Every oversight has weight. For veterans of the hearth.',
    mods: { moraleFlat: -0.05, healthRate: -0.08, birthRate: -0.12, disasterResist: -0.2, disasterChance: 0.35, foodConsumption: 0.08 } as ModifierDelta,
    startBonus: { berries: -4, wood: -2 },
  },
};

/** Soft caps and pacing constants shared across systems. */
export const LIMITS = {
  maxSettlements: 6,
  maxBuildingsPerSettlement: 180,
  maxCitizens: 6000,
  maxCohorts: 400,
  maxNotifications: 180,
  maxChronicle: 400,
  maxActiveEvents: 6,
  maxPendingDecisions: 1,
  maxExpeditions: 4,
  maxTradeRoutes: 24,
  maxNeighbors: 5,
  roadAccessRadius: 3,
  storageBaseCapacity: 180,
  storagePerHouse: 0,
  buildingDurabilityDecay: 0.00035,
  repairRate: 0.09,
  starvationHealthLoss: 1.15,
  dehydrationHealthLoss: 2.4,
  minWorkAge: 12,
  maxWorkAge: 68,
  elderAge: 62,
  fertileMinAge: 17,
  fertileMaxAge: 45,
  baseLifeExpectancy: 68,
  buildingDamageFromDisaster: 0.22,
  taxBase: 0.12,
  treasuryStart: 0,
  insightStart: 14,
  cultureStart: 0,
  influenceStart: 6,
  trainingRate: 0.35,
  jobSwitchPenalty: 0.55,
  autosaveIntervalDays: 45,
  tutorialPopGoal: 12,
};

/** Speed presets: simulated days per real second. */
export const SPEEDS = [0, 0.66, 1.6, 4, 10];

export const DEFAULT_SETTINGS = {
  speed: 2,
  autosave: true,
  autoAssign: true,
  showHints: true,
  reducedMotion: false,
  particleDensity: 0.7,
  uiScale: 1,
  tooltips: true,
  colorblind: false,
};

export const SEASON_AMBIENT: Record<string, { temp: number; rain: number; growth: number }> = {
  spring: { temp: 11, rain: 0.55, growth: 1.1 },
  summer: { temp: 21, rain: 0.3, growth: 1.25 },
  autumn: { temp: 12, rain: 0.45, growth: 0.9 },
  winter: { temp: -1, rain: 0.3, growth: 0.2 },
};

export const WORLDGEN = {
  width: 112,
  height: 112,
  /** Fraction of the map that is ocean (quantile-based, stable across seeds). */
  seaLevel: 0.36,
  mountainLevel: 0.74,
  riverMinFlow: 22,
  startRevealRadius: 8,
  siteCount: 12,
  regionCount: 10,
};

export const STARTING_SETTLEMENT_NAME = 'First Hearth';
export const STARTING_CITIZEN_NAMES: { name: string; surname: string; sex: 'm' | 'f' }[] = [
  { name: 'Aren', surname: 'Ashfall', sex: 'm' },
];
export const WANDERER_EVENT_FLAG = 'wanderer_arrived';
