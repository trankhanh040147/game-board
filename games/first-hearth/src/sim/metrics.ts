/**
 * Metrics: a single place that turns the game state into flat numbers used by
 * event conditions, milestones, achievements, objectives and the graphs.
 *
 * Keys are documented in docs/CONTENT-AUTHORING.md. Anything prefixed with
 * `capital.` resolves against the capital settlement; without a prefix the
 * value is empire-wide (or the capital when the metric is settlement-scoped).
 */
import type { Content, GameRules, GameState, Settlement } from './types';
import { DAYS_PER_YEAR } from './types';
import {
  addChronicle,
  capitalOf,
  foodDaysOf,
  modOfState,
  seasonIndexOf,
  totalPopulation,
  waterDaysOf,
  yearOf,
} from './core';
import { RULES } from './config';

function capital(s: GameState): Settlement | null {
  return capitalOf(s);
}

function avgCitizens(
  s: GameState,
  sel: (c: { morale: number; health: number; hunger: number; thirst: number }) => number,
  cohortSel?: (co: { morale: number; health: number }) => number,
): number {
  let sum = 0;
  let n = 0;
  for (const c of s.citizens) {
    if (!c.alive) continue;
    sum += sel(c);
    n++;
  }
  if (cohortSel) {
    for (const co of s.cohorts) {
      if (co.count <= 0) continue;
      sum += cohortSel(co) * co.count;
      n += co.count;
    }
  }
  return n ? sum / n : 0;
}

function countCitizens(s: GameState, predicate: (c: { age: number; hunger: number; thirst: number; homeBuildingId: number; jobBuildingId: number; profession: string; health: number }) => boolean): number {
  let n = 0;
  for (const c of s.citizens) if (c.alive && predicate(c)) n++;
  return n;
}

export function computeMetric(s: GameState, c: Content, metric: string): number {
  if (metric.startsWith('capital.')) {
    const st = capital(s);
    return st ? computeSettlementMetric(s, c, st, metric.slice(8)) : 0;
  }
  switch (metric) {
    case 'population':
      return totalPopulation(s);
    case 'adults':
      return countCitizens(s, (x) => x.age >= 16);
    case 'children':
      return countCitizens(s, (x) => x.age < 16);
    case 'elders':
      return countCitizens(s, (x) => x.age >= 62);
    case 'workforce':
      return s.settlements.reduce((a, st) => a + st.workforce, 0);
    case 'unemployed':
      return s.settlements.reduce((a, st) => a + st.unemployed, 0);
    case 'homeless':
      return s.settlements.reduce((a, st) => a + st.homeless, 0);
    case 'housingCapacity':
      return s.settlements.reduce((a, st) => a + st.housing.capacity, 0);
    case 'housingQuality':
      return s.settlements.length ? s.settlements.reduce((a, st) => a + st.housing.quality, 0) / s.settlements.length : 0;
    case 'food': {
      let total = 0;
      for (const st of s.settlements) for (const res in st.stock) if (c.resources[res]?.edible) total += (st.stock[res] ?? 0) * (c.resources[res]?.edible ?? 0);
      return total;
    }
    case 'foodDays': {
      const st = capital(s);
      return st ? foodDaysOf(s, c, st) : 0;
    }
    case 'water': {
      return s.settlements.reduce((a, st) => a + (st.stock.water ?? 0), 0);
    }
    case 'waterDays': {
      const st = capital(s);
      return st ? waterDaysOf(s, st) : 0;
    }
    case 'morale':
      return avgCitizens(s, (x) => x.morale, (co) => co.morale);
    case 'health':
      return avgCitizens(s, (x) => x.health, (co) => co.health);
    case 'hunger':
      return avgCitizens(s, (x) => x.hunger);
    case 'thirst':
      return avgCitizens(s, (x) => x.thirst);
    case 'approval':
      return s.society.approval;
    case 'stability':
      return s.society.stability;
    case 'crime':
      return s.society.crime;
    case 'treasury':
      return s.settlements.reduce((a, st) => a + st.treasury, 0);
    case 'insight':
      return s.research.insight;
    case 'culture':
      return s.society.culturePoints;
    case 'influence':
      return s.settlements.reduce((a, st) => a + st.influence, 0);
    case 'era':
      return s.research.era;
    case 'techs':
      return Object.keys(s.research.completed).length;
    case 'buildings':
      return s.buildings.filter((b) => b.progress >= 1).length;
    case 'buildings.industrial':
      return s.buildings.filter((b) => b.progress >= 1 && c.buildings[b.typeId]?.category === 'industry').length;
    case 'pollution': {
      let sum = 0;
      let n = 0;
      for (const t of s.world.tiles) {
        if (t.settlementId < 0) continue;
        sum += t.pollution;
        n++;
      }
      return n ? sum / n : 0;
    }
    case 'biodiversity':
      return s.world.climate.biodiversity;
    case 'forest': {
      let sum = 0;
      let n = 0;
      for (const t of s.world.tiles) {
        if (t.elev < 0.36) continue;
        sum += t.forest;
        n++;
      }
      return n ? sum / n : 0;
    }
    case 'fertility': {
      let sum = 0;
      let n = 0;
      for (const t of s.world.tiles) {
        if (t.settlementId < 0) continue;
        sum += t.fertility;
        n++;
      }
      return n ? sum / n : 0;
    }
    case 'wildlife': {
      let sum = 0;
      let n = 0;
      for (const t of s.world.tiles) {
        sum += t.wildlife;
        n++;
      }
      return n ? sum / n : 0;
    }
    case 'beauty': {
      let sum = 0;
      let n = 0;
      for (const t of s.world.tiles) {
        if (t.settlementId < 0) continue;
        sum += t.beauty;
        n++;
      }
      return n ? sum / n : 0;
    }
    case 'drought':
      return s.world.weather.drought;
    case 'temperature':
      return s.world.weather.temperature;
    case 'rain':
      return s.world.weather.rainfall;
    case 'tradeBalance':
      return s.market.tradeBalance;
    case 'neighborsMet':
      return s.neighbors.civs.filter((n) => n.discovered).length;
    case 'explored':
      return s.exploration.totalTiles ? s.exploration.revealedTiles / s.exploration.totalTiles : 0;
    case 'sitesFound':
      return s.exploration.sitesFound;
    case 'settlements':
      return s.settlements.length;
    case 'taxRate':
      return s.society.taxRate;
    case 'rations':
      return s.society.rations === 'meager' ? 0 : s.society.rations === 'normal' ? 1 : 2;
    case 'workHours':
      return s.society.workHours;
    case 'policies':
      return Object.keys(s.society.policies).filter((p) => s.society.policies[p]).length;
    case 'births':
      return s.stats.citizensBorn;
    case 'deaths':
      return s.stats.citizensDied;
    case 'immigrants':
      return s.stats.migrantsArrived;
    case 'foodProduced':
      return s.stats.foodProduced;
    case 'year':
      return yearOf(s.tick);
    case 'day':
      return Math.floor(s.tick % DAYS_PER_YEAR) + 1;
    case 'season':
      return seasonIndexOf(s.tick);
    case 'megaprojects':
      return Object.keys(s.megaprojects).filter((k) => s.megaprojects[k].status === 'done').length;
    case 'roads':
      return s.world.tiles.filter((t) => t.road > 0).length;
    default: {
      const st = capital(s);
      if (st) return computeSettlementMetric(s, c, st, metric);
      return 0;
    }
  }
}

export function computeSettlementMetric(s: GameState, c: Content, st: Settlement, metric: string): number {
  switch (metric) {
    case 'population':
      return st.population;
    case 'workforce':
      return st.workforce;
    case 'unemployed':
      return st.unemployed;
    case 'homeless':
      return st.homeless;
    case 'foodDays':
      return foodDaysOf(s, c, st);
    case 'waterDays':
      return waterDaysOf(s, st);
    case 'food': {
      let total = 0;
      for (const res in st.stock) {
        const d = c.resources[res];
        if (d?.edible) total += (st.stock[res] ?? 0) * d.edible;
      }
      return total;
    }
    case 'water':
      return st.stock.water ?? 0;
    case 'morale':
      return st.morale;
    case 'stability':
      return st.stability;
    case 'housingCapacity':
      return st.housing.capacity;
    case 'baseline':
      return st.id;
    case 'treasury':
      return st.treasury;
    case 'insight':
      return s.research.insight;
    case 'culture':
      return st.culture;
    case 'beauty':
      return s.world.tiles
        .filter((t) => t.settlementId === st.id)
        .reduce((a, t) => a + t.beauty, 0);
    case 'pollution':
      return s.world.tiles.filter((t) => t.settlementId === st.id).reduce((a, t) => a + t.pollution, 0);
    case 'buildings':
      return st.buildings.length;
    default:
      return computeMetric(s, c, `capital.${metric}`);
  }
}

// ---------------------------------------------------------------------------
// Daily sampling
// ---------------------------------------------------------------------------

const TRACKED_METRICS = [
  'population',
  'adults',
  'children',
  'workforce',
  'unemployed',
  'homeless',
  'housingCapacity',
  'food',
  'foodDays',
  'waterDays',
  'morale',
  'health',
  'hunger',
  'thirst',
  'approval',
  'stability',
  'crime',
  'treasury',
  'insight',
  'culture',
  'era',
  'techs',
  'buildings',
  'pollution',
  'biodiversity',
  'forest',
  'fertility',
  'wildlife',
  'beauty',
  'drought',
  'temperature',
  'tradeBalance',
  'neighborsMet',
  'explored',
  'sitesFound',
  'settlements',
  'capital.population',
  'capital.foodDays',
  'capital.morale',
];

/** Initialize the metrics series so charts have a stable schema. */
export function initMetrics(s: GameState): void {
  for (const key of TRACKED_METRICS) {
    if (!s.metrics.series[key]) s.metrics.series[key] = [];
  }
}

export function sampleMetrics(s: GameState, c: Content): void {
  const values: Record<string, number> = {};
  for (const key of TRACKED_METRICS) {
    const v = computeMetric(s, c, key);
    values[key] = Math.round(v * 1000) / 1000;
    let arr = s.metrics.series[key];
    if (!arr) arr = s.metrics.series[key] = [];
    arr.push(values[key]);
    if (arr.length > s.metrics.maxPoints) arr.splice(0, arr.length - s.metrics.maxPoints);
  }
  s.metrics.lastSampleTick = s.tick;

  // Yearly snapshot for the almanac.
  const year = yearOf(s.tick);
  if (year > s.metrics.lastSnapshotYear) {
    s.metrics.lastSnapshotYear = year;
    s.metrics.snapshots.push({ tick: s.tick, values });
    if (s.metrics.snapshots.length > 60) s.metrics.snapshots.shift();
    addChronicle(
      s,
      `The Almanac of Year ${year}`,
      `Our people number ${Math.round(values.population ?? 0)}. Food stores hold ${Math.round(values.food ?? 0)} measures. The realm's spirit stands at ${Math.round(values.morale ?? 0)}.`,
      'milestone',
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

import type { SimContext } from './types';

export function metricsSystem(ctx: SimContext): void {
  const s = ctx.s;
  initMetrics(s);
  if (s.tick % 1 === 0) sampleMetrics(s, ctx.c);
  // trim notifications occasionally
  if (s.notifications.length > 180) {
    s.notifications.splice(0, s.notifications.length - 180);
  }
  // track peaks
  const pop = totalPopulation(s);
  if (pop > s.stats.populationPeak) s.stats.populationPeak = pop;
}

export const METRICS_RULES: GameRules = RULES;
