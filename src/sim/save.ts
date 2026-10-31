/**
 * Save / load. The save format is versioned JSON with the explored mask encoded
 * as base64. Transient caches are rebuilt on load.
 */
import type { Content, GameState } from './types';
import { SAVE_VERSION, RULES } from './config';
import { rebuildCache } from './state';
import { initMetrics } from './metrics';

export const SAVE_KEY = 'first-hearth.save.v1';
export const AUTOSAVE_KEY = 'first-hearth.autosave.v1';

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  if (typeof btoa === 'function') return btoa(binary);
  const B = (globalThis as unknown as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string } } }).Buffer;
  if (B) return B.from(binary, 'binary').toString('base64');
  return '';
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const B = (globalThis as unknown as { Buffer?: { from: (s: string, enc: string) => { toString: (enc: string) => string; length: number; [i: number]: number } } }).Buffer;
  if (B) return new Uint8Array(B.from(b64, 'base64') as unknown as ArrayLike<number>);
  return new Uint8Array();
}

export function serializeState(state: GameState): string {
  const copy = {
    ...state,
    cache: null,
    world: {
      ...state.world,
      explored: bytesToBase64(state.world.explored),
    },
  };
  return JSON.stringify({ version: SAVE_VERSION, savedAtTick: state.tick, payload: copy });
}

export function deserializeState(json: string, content: Content): GameState {
  const parsed = JSON.parse(json) as { version?: number; payload?: Record<string, unknown> };
  if (!parsed || typeof parsed !== 'object' || !parsed.payload) throw new Error('Not a First Hearth save file');
  const raw = parsed.payload as unknown as GameState & { world: GameState['world'] & { explored: string | Uint8Array } };
  const world = raw.world;
  const explored =
    typeof world.explored === 'string' ? base64ToBytes(world.explored) : new Uint8Array(world.explored ?? []);
  const state = {
    ...raw,
    world: { ...world, explored },
    cache: null,
  } as unknown as GameState;

  // Defensive defaults for older/partial saves.
  state.settlements ??= [];
  state.citizens ??= [];
  state.cohorts ??= [];
  state.buildings ??= [];
  state.chronicle ??= [];
  state.notifications ??= [];
  state.events ??= {
    active: [],
    history: [],
    cooldowns: {},
    seen: {},
    pending: [],
    nextDecisionId: 1,
    warnings: [],
    scheduled: [],
    tension: 0,
    lastEventTick: 0,
    quietDays: 0,
  };
  state.events.pending ??= [];
  state.events.warnings ??= [];
  state.market ??= { prices: {}, tariff: 0.04, tradeBalance: 0, lastUpdateTick: 0, routes: [], caravans: [], nextRouteId: 1 };
  state.market.caravans ??= [];
  state.market.routes ??= [];
  state.exploration ??= { expeditions: [], nextId: 1, revealedTiles: 0, totalTiles: state.world.tiles.length, sitesFound: 0, sitesVisited: 0, mapReveal: 0, legendaryFound: [] };
  state.exploration.expeditions ??= [];
  state.neighbors ??= { civs: [], nextId: 1 };
  state.neighbors.civs ??= [];
  state.society.policies ??= {};
  state.society.mods ??= {};
  state.research.completed ??= {};
  state.research.doctrineChoices ??= [];
  state.milestones ??= { completed: {}, era: 0, eraProgress: 0 };
  state.objectives ??= { completed: {}, current: null };
  state.megaprojects ??= {};
  state.metrics ??= { series: {}, sampledEvery: 1, lastSampleTick: -1, maxPoints: 420, lifetime: {}, snapshots: [], lastSnapshotYear: 0 };
  state.settings ??= { speed: 1, autosave: true, autoAssign: true, showHints: true, reducedMotion: false, particleDensity: 0.7, uiScale: 1, tooltips: true, colorblind: false };
  state.tutorial ??= { step: 0, milestonesSeen: [], hintsDismissed: {}, active: true, completed: false };
  state.flags ??= {};
  state.stats ??= {} as GameState['stats'];
  state.world.markers ??= [];
  state.world.rivers ??= [];
  state.world.regions ??= [];
  state.world.sites ??= [];
  state.world.lakes ??= [];
  state.nextIds ??= {
    citizen: 1, building: 1, settlement: 1, event: 1, decision: 1, expedition: 1, caravan: 1, route: 1, chronicle: 1, notification: 1, marker: 1,
  };

  rebuildCache(state, content, RULES);
  initMetrics(state);
  return state;
}

// ---------------------------------------------------------------------------
// localStorage helpers (browser only; graceful no-op in node)
// ---------------------------------------------------------------------------

function hasStorage(): boolean {
  try {
    return typeof localStorage !== 'undefined';
  } catch {
    return false;
  }
}

export function saveToStorage(state: GameState, slot: string = SAVE_KEY): boolean {
  if (!hasStorage()) return false;
  try {
    localStorage.setItem(slot, serializeState(state));
    return true;
  } catch {
    return false;
  }
}

export function loadFromStorage(content: Content, slot: string = SAVE_KEY): GameState | null {
  if (!hasStorage()) return null;
  try {
    const raw = localStorage.getItem(slot);
    if (!raw) return null;
    return deserializeState(raw, content);
  } catch {
    return null;
  }
}

export function hasSave(slot: string = SAVE_KEY): boolean {
  if (!hasStorage()) return false;
  try {
    return !!localStorage.getItem(slot);
  } catch {
    return false;
  }
}

export function clearSave(slot: string = SAVE_KEY): void {
  if (!hasStorage()) return;
  try {
    localStorage.removeItem(slot);
  } catch {
    /* ignore */
  }
}

export function downloadSave(state: GameState, filename = 'first-hearth-save.json'): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([serializeState(state)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
