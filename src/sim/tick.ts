/**
 * Tick orchestrator. 1 tick = 1 in-world day.
 *
 * Systems are ordered so that each day flows naturally:
 * weather -> ecology -> disasters -> buildings -> jobs -> production -> logistics
 * -> population -> society -> research -> economy -> events -> exploration ->
 * neighbours -> objectives -> metrics.
 *
 * Determinism: the only randomness available is ctx.rng(), backed by the
 * seeded state.rng tuple. Systems may not use Math.random or real time.
 */
import type { Content, GameRules, GameState, SimContext, SimSystem } from './types';
import { collectGlobalModifiers, deepClone, pushNotification, addChronicle } from './core';
import { makeRng } from './rng';
import { weatherSystem } from './systems/world/weather';
import { ecologySystem } from './systems/world/ecology';
import { disastersSystem } from './systems/world/disasters';
import { explorationSystem } from './systems/world/exploration';
import { neighborsSystem } from './systems/world/neighbors';
import { buildingsSystem } from './systems/civ/buildings';
import { jobsSystem } from './systems/civ/jobs';
import { productionSystem } from './systems/civ/production';
import { logisticsSystem } from './systems/civ/logistics';
import { populationSystem } from './systems/civ/population';
import { societySystem } from './systems/civ/society';
import { researchSystem } from './systems/civ/research';
import { economySystem } from './systems/civ/economy';
import { eventsSystem } from './systems/civ/events';
import { objectivesSystem } from './systems/civ/objectives';
import { metricsSystem } from './metrics';

export const SYSTEM_ORDER: SimSystem[] = [
  weatherSystem,
  ecologySystem,
  disastersSystem,
  buildingsSystem,
  jobsSystem,
  productionSystem,
  logisticsSystem,
  populationSystem,
  societySystem,
  researchSystem,
  economySystem,
  eventsSystem,
  explorationSystem,
  neighborsSystem,
  objectivesSystem,
  metricsSystem,
];

/** Developer/debug log of the latest ticks (transient, never saved). */
export const simDebugLog: string[] = [];

export function debugLog(message: string): void {
  simDebugLog.push(message);
  if (simDebugLog.length > 600) simDebugLog.splice(0, simDebugLog.length - 600);
}

export function createSimContext(state: GameState, content: Content, rules: GameRules): SimContext {
  const rng = makeRng(state.rng);
  const ctx: SimContext = {
    s: state,
    c: content,
    rules,
    tick: state.tick,
    rng,
    mods: state.cache.globalMods,
    notify: (text, severity = 'info', icon = 'bell') => {
      pushNotification(state, text, severity, icon);
    },
    chronicle: (title, body, kind, importance = 2) => {
      addChronicle(state, title, body, kind, importance);
    },
    log: (message) => {
      if (import.meta.env?.DEV) debugLog(message);
    },
    discover: (text) => {
      state.research.discoveries.push(text);
      if (state.research.discoveries.length > 120) state.research.discoveries.shift();
      pushNotification(state, text, 'discovery', 'star');
    },
  };
  return ctx;
}

/** Simulate a single day in place. */
export function tick(state: GameState, content: Content, rules: GameRules): void {
  // Aggregate tech/policy/doctrine/difficulty/event modifiers once per day.
  state.cache.globalMods = collectGlobalModifiers(state, content, rules);
  const ctx = createSimContext(state, content, rules);
  ctx.tick = state.tick;
  ctx.mods = state.cache.globalMods;

  for (const system of SYSTEM_ORDER) {
    system(ctx);
  }

  state.stats.playDays = state.tick + 1;
  state.tick += 1;
}

/** Simulate N days (headless testing / fast-forward). */
export function runDays(state: GameState, content: Content, rules: GameRules, days: number, onDay?: (s: GameState) => void): void {
  for (let i = 0; i < days; i++) {
    tick(state, content, rules);
    if (onDay) onDay(state);
  }
}

/** Snapshot used by tests and save/load comparisons. */
export function snapshot(state: GameState): string {
  const copy = deepClone(state);
  copy.cache = {
    globalMods: {},
    settlementMods: {},
    radiusMap: new Map(),
    roadAccess: {},
    neighborResourceCache: {},
    lastRoadUpdate: -1,
    breakdown: {},
  };
  return JSON.stringify(copy);
}
