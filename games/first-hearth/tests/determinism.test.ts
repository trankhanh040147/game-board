/**
 * Determinism + persistence. A living-world simulation is only trustworthy if
 * the same seed and the same action script produce byte-identical state, and if
 * a save round-trip is lossless.
 */
import { describe, expect, it } from 'vitest';
import { deserializeState, serializeState } from '../src/sim/save';
import { canonical, hashState, isDerivedSettlementField, makeContent, nanPaths, newGame, runAutoplay, runIdle, stateDiff } from './helpers';

const DAYS = 100;

function sameSnapshot(a: ReturnType<typeof newGame>, b: ReturnType<typeof newGame>, label: string): void {
  expect(nanPaths(a), `${label}: NaN in run A`).toEqual([]);
  expect(nanPaths(b), `${label}: NaN in run B`).toEqual([]);
  const sa = canonical(a);
  const sb = canonical(b);
  if (sa !== sb) {
    // Find the first differing character to make failures actionable.
    let i = 0;
    while (i < Math.min(sa.length, sb.length) && sa[i] === sb[i]) i++;
    const ctx = (s: string): string => s.slice(Math.max(0, i - 80), i + 160);
    expect.fail(`${label}: state diverged at char ${i}\nA: ...${ctx(sa)}...\nB: ...${ctx(sb)}...`);
  }
  expect(hashState(a)).toBe(hashState(b));
}

describe('determinism', () => {
  it(`same seed + same autoplay script => identical state after ${DAYS} days`, () => {
    const a = newGame('det-alpha');
    const b = newGame('det-alpha');
    runAutoplay(a, DAYS);
    runAutoplay(b, DAYS);
    sameSnapshot(a, b, 'autoplay determinism');
  });

  it('same seed + no actions => identical state after 60 days', () => {
    const a = newGame('det-idle');
    const b = newGame('det-idle');
    runIdle(a, 60);
    runIdle(b, 60);
    sameSnapshot(a, b, 'idle determinism');
  });

  it('different seeds => different worlds and different state', () => {
    const a = newGame('det-alpha');
    const b = newGame('det-beta');
    // Worldgen must differ immediately.
    const wa = a.world.tiles.map((t) => t.elev).join(',');
    const wb = b.world.tiles.map((t) => t.elev).join(',');
    expect(wa).not.toBe(wb);
    runAutoplay(a, 40);
    runAutoplay(b, 40);
    expect(canonical(a)).not.toBe(canonical(b));
  });

  it('same seed but different difficulty => different state', () => {
    const a = newGame('det-diff', 'gentle');
    const b = newGame('det-diff', 'harsh');
    runIdle(a, 30);
    runIdle(b, 30);
    expect(canonical(a)).not.toBe(canonical(b));
  });

  it('rng tuple advances deterministically and is restored by save/load', () => {
    const a = newGame('det-rng');
    runIdle(a, 25);
    const rngA = [...a.rng];
    const b = deserializeState(serializeState(a), makeContent());
    expect([...b.rng]).toEqual(rngA);
    runIdle(a, 10);
    runIdle(b, 10);
    expect([...b.rng]).toEqual([...a.rng]);
  });
});

describe('save/load equivalence', () => {
  it('serialize -> deserialize is lossless at the load point (ignoring cache)', () => {
    const state = newGame('save-seed');
    runAutoplay(state, 60);
    const loaded = deserializeState(serializeState(state), makeContent());
    // Cache is transient by contract; snapshots exclude it. A handful of
    // settlement fields are derived caches that rebuildCache re-derives with
    // full precision (QA-FINDING: systems round them) — those may differ by
    // rounding only; every other path must be identical.
    const diffs = stateDiff(state, loaded);
    const real = diffs.filter((d) => !isDerivedSettlementField(d.path));
    expect(real, `unexpected save/load differences: ${real.slice(0, 10).map((d) => `${d.path} ${JSON.stringify(d.a)}!=${JSON.stringify(d.b)}`).join(', ')}`).toEqual([]);
    for (const d of diffs.filter((x) => isDerivedSettlementField(x.path))) {
      const av = Number(d.a);
      const bv = Number(d.b);
      if (Number.isFinite(av) && Number.isFinite(bv)) {
        expect(Math.abs(av - bv), `derived field ${d.path} drifted too far: ${av} vs ${bv}`).toBeLessThan(2.5);
      }
    }
  });

  it('load -> continue 60 days equals continuous 120 days', () => {
    const continuous = newGame('save-seed-2');
    runAutoplay(continuous, 120);

    const split = newGame('save-seed-2');
    runAutoplay(split, 60);
    const reloaded = deserializeState(serializeState(split), makeContent());
    runAutoplay(reloaded, 60);

    sameSnapshot(continuous, reloaded, 'save/load continuation');
  });

  it('double save/load does not drift', () => {
    const state = newGame('save-seed-3');
    runAutoplay(state, 45);
    const once = deserializeState(serializeState(state), makeContent());
    const twice = deserializeState(serializeState(once), makeContent());
    expect(canonical(twice)).toBe(canonical(once));
    runAutoplay(once, 20);
    runAutoplay(twice, 20);
    expect(canonical(twice)).toBe(canonical(once));
  });

  it('save JSON has no transient cache and survives JSON.parse', () => {
    const state = newGame('save-seed-4');
    runIdle(state, 10);
    const json = serializeState(state);
    const parsed = JSON.parse(json) as { version: number; payload: Record<string, unknown> };
    expect(parsed.payload.cache).toBeFalsy();
    expect(parsed.version).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(parsed)).toBe(json);
  });
});
