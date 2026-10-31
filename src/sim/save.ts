/**
 * Save / load. The save format is versioned JSON.
 *
 * The world's static layer (elevation, climate, biomes, deposits, sites, regions)
 * is regenerated from the seed on load; only the dynamic per-tile layer and entity
 * state are stored. This keeps saves small (≈1MB) while remaining byte-exact for
 * determinism: dynamic floats are stored as Float64 base64, not quantised.
 */
import type { Content, GameState, Site, Tile, WorldState } from './types';
import { SAVE_VERSION, RULES } from './config';
import { rebuildCache } from './state';
import { initMetrics } from './metrics';
import { generateWorld } from './world/worldgen';

export const SAVE_KEY = 'first-hearth.save.v1';
export const AUTOSAVE_KEY = 'first-hearth.autosave.v1';

const WORLDGEN_VERSION = 1;

// ---------------------------------------------------------------------------
// Base64 helpers (browser + node)
// ---------------------------------------------------------------------------

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

function packFloat64(values: number[]): string {
  return bytesToBase64(new Uint8Array(new Float64Array(values).buffer));
}

function unpackFloat64(b64: string, length: number): number[] {
  const bytes = base64ToBytes(b64);
  const floats = new Float64Array(bytes.buffer, bytes.byteOffset, Math.min(length, Math.floor(bytes.byteLength / 8)));
  const out: number[] = new Array(length);
  for (let i = 0; i < length; i++) out[i] = floats[i] ?? 0;
  return out;
}

function packInt32(values: number[]): string {
  return bytesToBase64(new Uint8Array(new Int32Array(values).buffer));
}

function unpackInt32(b64: string, length: number): number[] {
  const bytes = base64ToBytes(b64);
  const ints = new Int32Array(bytes.buffer, bytes.byteOffset, Math.min(length, Math.floor(bytes.byteLength / 4)));
  const out: number[] = new Array(length);
  for (let i = 0; i < length; i++) out[i] = ints[i] ?? -1;
  return out;
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

interface DynamicTileLayer {
  forest: string;
  fertility: string;
  forage: string;
  wildlife: string;
  water: string;
  pollution: string;
  beauty: string;
  road: string;
  moisture: string;
  buildingId: string;
  settlementId: string;
  depositAmounts: [number, number][]; // [tileIndex, amount]
}

interface SavedWorld extends Omit<WorldState, 'explored' | 'sites'> {
  explored: string;
  sites: Pick<Site, 'discovered' | 'visited' | 'discoveredTick'>[];
  dynamic: DynamicTileLayer;
}

interface SaveEnvelope {
  version: number;
  worldgenVersion: number;
  savedAtTick: number;
  seed: string;
  size: { width: number; height: number };
  payload: Record<string, unknown>;
}

export function serializeState(state: GameState): string {
  const w = state.world;
  const n = w.tiles.length;
  const forest: number[] = new Array(n);
  const fertility: number[] = new Array(n);
  const forage: number[] = new Array(n);
  const wildlife: number[] = new Array(n);
  const water: number[] = new Array(n);
  const pollution: number[] = new Array(n);
  const beauty: number[] = new Array(n);
  const road: number[] = new Array(n);
  const moisture: number[] = new Array(n);
  const buildingId: number[] = new Array(n);
  const settlementId: number[] = new Array(n);
  const depositAmounts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = w.tiles[i];
    forest[i] = t.forest;
    fertility[i] = t.fertility;
    forage[i] = t.forage;
    wildlife[i] = t.wildlife;
    water[i] = t.water;
    pollution[i] = t.pollution;
    beauty[i] = t.beauty;
    road[i] = t.road;
    moisture[i] = t.moisture;
    buildingId[i] = t.buildingId;
    settlementId[i] = t.settlementId;
    if (t.deposit) depositAmounts.push([i, t.deposit.amount]);
  }
  const savedWorld: SavedWorld = {
    ...w,
    tiles: [],
    explored: bytesToBase64(w.explored),
    sites: w.sites.map((s) => ({ discovered: s.discovered, visited: s.visited, discoveredTick: s.discoveredTick })),
    dynamic: {
      forest: packFloat64(forest),
      fertility: packFloat64(fertility),
      forage: packFloat64(forage),
      wildlife: packFloat64(wildlife),
      water: packFloat64(water),
      pollution: packFloat64(pollution),
      beauty: packFloat64(beauty),
      road: packFloat64(road),
      moisture: packFloat64(moisture),
      buildingId: packInt32(buildingId),
      settlementId: packInt32(settlementId),
      depositAmounts,
    },
  };
  const { cache, world, ...rest } = state;
  const envelope: SaveEnvelope = {
    version: SAVE_VERSION,
    worldgenVersion: WORLDGEN_VERSION,
    savedAtTick: state.tick,
    seed: state.seed,
    size: { width: w.width, height: w.height },
    payload: { ...rest, world: savedWorld },
  };
  return JSON.stringify(envelope);
}

export function deserializeState(json: string, content: Content): GameState {
  const parsed = JSON.parse(json) as Partial<SaveEnvelope> & { payload?: Record<string, unknown> };
  if (!parsed || typeof parsed !== 'object' || !parsed.payload) throw new Error('Not a First Hearth save file');
  if ((parsed.version ?? 0) > SAVE_VERSION) throw new Error('This save was made by a newer version of First Hearth');
  const raw = parsed.payload as unknown as GameState & {
    world: SavedWorld & { tiles?: Tile[]; explored: string | Uint8Array; dynamic?: DynamicTileLayer };
  };
  const savedWorld = raw.world;
  let world: WorldState;

  const canRegenerate = !!savedWorld.dynamic && !!parsed.size && (parsed.worldgenVersion ?? WORLDGEN_VERSION) === WORLDGEN_VERSION;
  if (canRegenerate) {
    const base = generateWorld(parsed.seed ?? raw.seed ?? 'unknown', {
      width: parsed.size!.width,
      height: parsed.size!.height,
    });
    const dyn = savedWorld.dynamic!;
    const n = base.tiles.length;
    const f = {
      forest: unpackFloat64(dyn.forest, n),
      fertility: unpackFloat64(dyn.fertility, n),
      forage: unpackFloat64(dyn.forage, n),
      wildlife: unpackFloat64(dyn.wildlife, n),
      water: unpackFloat64(dyn.water, n),
      pollution: unpackFloat64(dyn.pollution, n),
      beauty: unpackFloat64(dyn.beauty, n),
      road: unpackFloat64(dyn.road, n),
      moisture: unpackFloat64(dyn.moisture, n),
      buildingId: unpackInt32(dyn.buildingId, n),
      settlementId: unpackInt32(dyn.settlementId, n),
    };
    for (let i = 0; i < n; i++) {
      const t = base.tiles[i];
      t.forest = f.forest[i];
      t.fertility = f.fertility[i];
      t.forage = f.forage[i];
      t.wildlife = f.wildlife[i];
      t.water = f.water[i];
      t.pollution = f.pollution[i];
      t.beauty = f.beauty[i];
      t.road = f.road[i];
      t.moisture = f.moisture[i];
      t.buildingId = f.buildingId[i];
      t.settlementId = f.settlementId[i];
    }
    for (const [idx, amount] of dyn.depositAmounts ?? []) {
      const t = base.tiles[idx];
      if (t?.deposit) t.deposit.amount = amount;
    }
    // Dynamic world fields that are not regenerated.
    base.explored = base64ToBytes(savedWorld.explored as string);
    base.markers = savedWorld.markers ?? [];
    base.weather = savedWorld.weather ?? base.weather;
    base.climate = savedWorld.climate ?? base.climate;
    base.startX = savedWorld.startX ?? base.startX;
    base.startY = savedWorld.startY ?? base.startY;
    base.seedLabel = savedWorld.seedLabel ?? base.seedLabel;
    for (let i = 0; i < base.sites.length; i++) {
      const saved = savedWorld.sites?.[i];
      if (saved) {
        base.sites[i].discovered = saved.discovered;
        base.sites[i].visited = saved.visited;
        base.sites[i].discoveredTick = saved.discoveredTick;
      }
    }
    world = base;
  } else {
    // Legacy/full-tile saves.
    world = {
      ...(savedWorld as unknown as WorldState),
      explored: typeof savedWorld.explored === 'string' ? base64ToBytes(savedWorld.explored) : new Uint8Array(savedWorld.explored ?? []),
    };
    world.tiles = (savedWorld.tiles ?? []).map((t) => ({
      ...t,
      deposit: t.deposit ? { ...t.deposit } : null,
    }));
    world.sites = (savedWorld.sites ?? []) as Site[];
  }

  const state = {
    ...raw,
    world,
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
  state.exploration ??= {
    expeditions: [],
    nextId: 1,
    revealedTiles: 0,
    totalTiles: world.tiles.length,
    sitesFound: 0,
    sitesVisited: 0,
    mapReveal: 0,
    legendaryFound: [],
  };
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
  state.settings ??= {
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
  state.tutorial ??= { step: 0, milestonesSeen: [], hintsDismissed: {}, active: true, completed: false };
  state.flags ??= {};
  state.stats ??= {} as GameState['stats'];
  state.world.markers ??= [];
  state.world.rivers ??= [];
  state.world.regions ??= [];
  state.world.sites ??= [];
  state.world.lakes ??= [];
  state.nextIds ??= {
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
