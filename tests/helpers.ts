/**
 * Shared QA test helpers. Keeps content building and simulation scripting in
 * one place so every test exercises the real public API (no sim internals are
 * patched to make tests pass).
 */
import { buildContent } from '../src/sim/content/index';
import { createNewGame } from '../src/sim/state';
import { tick, snapshot } from '../src/sim/tick';
import { RULES } from '../src/sim/config';
import { Autoplay } from '../tools/autoplay';
import type { Content, GameState, Settlement } from '../src/sim/types';

let cached: Content | null = null;

export function makeContent(): Content {
  if (!cached) cached = buildContent();
  return cached;
}

export function newGame(seed = 'qa-seed', difficulty: GameState['difficulty'] = 'balanced'): GameState {
  return createNewGame(makeContent(), { seed, difficulty });
}

/** Advance `days` days with the scripted autoplay driver (the QA standard script). */
export function runAutoplay(state: GameState, days: number, ap: Autoplay = new Autoplay()): Autoplay {
  const content = makeContent();
  for (let i = 0; i < days; i++) {
    ap.run(state, content);
    tick(state, content, RULES);
  }
  return ap;
}

/** Advance `days` days with no player actions at all. */
export function runIdle(state: GameState, days: number): void {
  const content = makeContent();
  for (let i = 0; i < days; i++) tick(state, content, RULES);
}

/** Recursively key-sorted stringify: JSON object key order is not meaningful. */
export function stableStringify(value: unknown): string {
  const seen = new Set<unknown>();
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object') return x;
    if (seen.has(x)) return '[cycle]';
    seen.add(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x instanceof Map) return { __map: Array.from(x.entries()) };
    if (x instanceof Uint8Array) return { __u8: Array.from(x) };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(x as Record<string, unknown>).sort()) {
      out[key] = walk((x as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(walk(value));
}

/**
 * Canonical state string for equality checks: cache stripped (transient by
 * contract), object keys sorted (JSON key order is an implementation detail).
 */
export function canonical(state: GameState): string {
  const parsed = JSON.parse(snapshot(state)) as Record<string, unknown>;
  delete parsed.cache;
  return stableStringify(parsed);
}

/** FNV-1a hash of the canonical state snapshot. */
export function hashState(state: GameState): string {
  const str = canonical(state);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Deep scan for NaN/Infinity in every numeric state field.
 * Returns human-readable paths (empty = clean). Transient `cache` is skipped.
 */
export function nanPaths(state: GameState): string[] {
  const paths: string[] = [];
  const seen = new Set<unknown>();
  const walk = (value: unknown, path: string, depth: number): void => {
    if (paths.length >= 25 || depth > 14) return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) paths.push(`${path}=${String(value)}`);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) walk(value[i], `${path}[${i}]`, depth + 1);
      return;
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (depth === 0 && key === 'cache') continue;
      walk((value as Record<string, unknown>)[key], path ? `${path}.${key}` : key, depth + 1);
    }
  };
  walk(state, '', 0);
  return paths;
}

export interface StockEntry {
  settlementId: number;
  resource: string;
  amount: number;
}

export function stockEntries(state: GameState): StockEntry[] {
  const out: StockEntry[] = [];
  for (const st of state.settlements) {
    for (const res of Object.keys(st.stock)) out.push({ settlementId: st.id, resource: res, amount: st.stock[res] });
  }
  return out;
}

export function settlementStorage(state: GameState, st: Settlement): number {
  return st.storageUsed;
}

export function aliveCitizens(state: GameState): number {
  return state.citizens.filter((c) => c.alive).length;
}

/** Run ticks; returns the first thrown error (if any) instead of swallowing it. */
export function tryRunIdle(state: GameState, days: number): Error | null {
  try {
    runIdle(state, days);
    return null;
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

// ---------------------------------------------------------------------------
// State diffing (save/load verification)
// ---------------------------------------------------------------------------

export interface StateDiff {
  path: string;
  a: unknown;
  b: unknown;
}

/**
 * Structural diff between two game states, ignoring the transient cache.
 * Returns a list of differing paths (values included for diagnostics).
 */
export function stateDiff(x: GameState, y: GameState): StateDiff[] {
  const a = JSON.parse(snapshot(x)) as Record<string, unknown>;
  const b = JSON.parse(snapshot(y)) as Record<string, unknown>;
  delete a.cache;
  delete b.cache;
  const out: StateDiff[] = [];
  const walk = (va: unknown, vb: unknown, path: string): void => {
    if (out.length >= 200) return;
    if (va === vb) return;
    const ta = typeof va;
    const tb = typeof vb;
    if (ta !== tb) {
      out.push({ path, a: va, b: vb });
      return;
    }
    if (ta !== 'object' || va === null || vb === null) {
      out.push({ path, a: va, b: vb });
      return;
    }
    const aa = va as Record<string, unknown>;
    const bb = vb as Record<string, unknown>;
    const keys = new Set([...Object.keys(aa), ...Object.keys(bb)]);
    for (const key of keys) {
      if (out.length >= 200) return;
      if (!(key in aa) || !(key in bb)) {
        out.push({ path: path ? `${path}.${key}` : key, a: aa[key], b: bb[key] });
        continue;
      }
      walk(aa[key], bb[key], path ? `${path}.${key}` : key);
    }
  };
  walk(a, b, '');
  return out;
}

/**
 * Fields that are derived/cached from other state and are recomputed by
 * `rebuildCache` with full precision on load (systems round them while
 * writing). Differences here are cosmetic; anything else is real data loss.
 */
export function isDerivedSettlementField(path: string): boolean {
  return /^settlements(\.|\[)\d+\]?\.(storageUsed|foodDays|waterDays|housingDays|roadAccess)$/.test(path);
}
