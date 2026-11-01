/**
 * Unit tests for the procedural audio engine's pure/inert surface.
 *
 * WebAudio itself needs a browser, so these tests cover the parts that must be
 * correct without a running AudioContext:
 *  - every frozen SfxName has a recipe and every MusicTrack a definition
 *    (the real guarantee against silent sounds is the Record<SfxName, ...>
 *    type, verified again at runtime by the audio lab);
 *  - spatial attenuation/pan maths is finite, bounded and directional;
 *  - the engine is silent, non-throwing and disposable before unlock;
 *  - slider/rate inputs are clamped.
 *
 * Runtime proof (AudioContext 'running', non-zero analyser level, 200-sound
 * stress) lives in audio-lab.html / window.__audioLab and is exercised by the
 * headless Chrome probe documented in the task report.
 */

import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { audio, AudioEngine } from '../src/audio/audio';
import { RECIPES, SFX_NAMES } from '../src/audio/sfx';
import { MUSIC_TRACKS } from '../src/audio/music';
import {
  clamp01,
  distanceGain,
  IDENTITY_LISTENER,
  MAX_SFX_VOICES,
  MIN_RATE,
  MAX_RATE,
  panFor,
  safeRate,
  spatialMix,
  THROTTLE_MS,
} from '../src/audio/dsp';
import type { MusicTrack, SfxName } from '../src/core/types';

/** The frozen union from src/core/types.ts, duplicated here on purpose: if a
 * name is added there, this literal must be updated, which forces the test to
 * fail until a recipe exists. */
const EXPECTED_SFX: SfxName[] = [
  'swing',
  'swing-heavy',
  'hit-flesh',
  'hit-armor',
  'hit-shield',
  'block-weapon',
  'guard-break',
  'kick',
  'death',
  'footstep',
  'dodge',
  'spawn',
  'gong',
  'horn',
  'crowd-cheer',
  'ui-click',
  'ui-hover',
  'bet',
  'victory',
  'defeat',
  'round-start',
  'bet-win',
  'bet-lose',
];

const EXPECTED_TRACKS: MusicTrack[] = ['menu', 'tournament', 'melee', 'victory', 'defeat'];

describe('sound catalog', () => {
  it('has a recipe for every frozen SfxName', () => {
    expect(new Set(SFX_NAMES)).toEqual(new Set(EXPECTED_SFX));
    expect(SFX_NAMES).toHaveLength(EXPECTED_SFX.length);
    for (const name of EXPECTED_SFX) expect(typeof RECIPES[name]).toBe('function');
  });

  it('has a definition for every MusicTrack', () => {
    expect(new Set(MUSIC_TRACKS)).toEqual(new Set(EXPECTED_TRACKS));
    expect(MUSIC_TRACKS).toHaveLength(EXPECTED_TRACKS.length);
  });

  it('keeps the mix budget within the intended arena limits', () => {
    expect(MAX_SFX_VOICES).toBe(24);
    expect(THROTTLE_MS).toBe(30);
  });
});

describe('spatial maths', () => {
  it('is full volume on top of the listener and decays with distance', () => {
    expect(distanceGain(0)).toBe(1);
    let previous = distanceGain(0);
    for (const distance of [1, 2, 4, 8, 16, 32, 64]) {
      const gain = distanceGain(distance);
      expect(Number.isFinite(gain)).toBe(true);
      expect(gain).toBeLessThan(previous);
      expect(gain).toBeGreaterThanOrEqual(0.035);
      previous = gain;
    }
    expect(distanceGain(-3)).toBe(1);
    expect(distanceGain(Number.NaN)).toBe(1);
  });

  it('pans a source to the side it is on, and never out of range', () => {
    expect(panFor(0, 0)).toBe(0);
    expect(panFor(3, 0)).toBeGreaterThan(0.3);
    expect(panFor(-3, 0)).toBeLessThan(-0.3);
    for (const [x, z] of [
      [100, 0],
      [-100, 5],
      [0.001, -0.001],
      [0, 100],
    ]) {
      const pan = panFor(x, z);
      expect(Number.isFinite(pan)).toBe(true);
      expect(Math.abs(pan)).toBeLessThanOrEqual(0.92);
    }
  });

  it('uses the listener right vector so camera facing decides left/right', () => {
    // Camera at origin looking down -Z: its right vector is +X.
    const listener = { ...IDENTITY_LISTENER, x: 0, y: 0, z: 0, rx: 1, rz: 0 };
    const right = spatialMix({ x: 3, y: 1, z: -2 }, listener);
    const left = spatialMix({ x: -3, y: 1, z: -2 }, listener);
    expect(right.pan).toBeGreaterThan(0.2);
    expect(left.pan).toBeLessThan(-0.2);

    // Rotate 180°: right/left invert.
    const turned = { ...IDENTITY_LISTENER, rx: -1, rz: 0 };
    expect(spatialMix({ x: 3, y: 1, z: -2 }, turned).pan).toBeLessThan(-0.2);
    expect(spatialMix({ x: -3, y: 1, z: -2 }, turned).pan).toBeGreaterThan(0.2);
  });

  it('attenuates distant sources much more than close ones', () => {
    const close = spatialMix({ x: 1, y: 0, z: 0 }, IDENTITY_LISTENER);
    const far = spatialMix({ x: 0, y: 0, z: 45 }, IDENTITY_LISTENER);
    expect(close.gain).toBeGreaterThan(0.8);
    expect(far.gain).toBeLessThan(0.12);
    expect(far.pan).toBeCloseTo(0, 5);
  });
});

describe('input clamping', () => {
  it('clamps sliders to 0..1 and handles NaN', () => {
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(0.42)).toBeCloseTo(0.42, 6);
  });

  it('clamps playback rates to the safe band', () => {
    expect(safeRate(undefined)).toBe(1);
    expect(safeRate(0.1)).toBe(MIN_RATE);
    expect(safeRate(9)).toBe(MAX_RATE);
    expect(safeRate(Number.NaN)).toBe(1);
  });
});

describe('engine before unlock (locked context safety)', () => {
  it('never throws when playing, updating or disposing while locked', () => {
    const engine = new AudioEngine();
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(2, 1.5, -3);
    camera.updateMatrixWorld(true);

    expect(engine.isReady).toBe(false);
    expect(engine.state).toBeNull();
    expect(engine.getDiagnostics().state).toBeNull();

    // Locked/silent engine must swallow everything (used by menu before gesture).
    expect(() => engine.play('gong')).not.toThrow();
    expect(() => engine.play('hit-flesh', { pos: new Vector3(1, 1, 1), volume: 2, rate: 9 })).not.toThrow();
    expect(() => engine.setCrowd(0.8)).not.toThrow();
    expect(() => engine.cheer(1)).not.toThrow();
    expect(() => engine.gong()).not.toThrow();
    expect(() => engine.startMusic('melee')).not.toThrow();
    expect(() => engine.stopMusic()).not.toThrow();
    expect(() => engine.update(camera, 0.016)).not.toThrow();

    // Listener still follows the camera even before audio unlocks.
    const listener = engine.getDiagnostics().listener;
    expect(listener.x).toBeCloseTo(2, 5);
    expect(listener.y).toBeCloseTo(1.5, 5);
    expect(listener.z).toBeCloseTo(-3, 5);

    expect(() => engine.dispose()).not.toThrow();
    expect(engine.isReady).toBe(false);
    expect(() => engine.play('swing')).not.toThrow();
  });

  it('clamps volume state and reports it back', () => {
    const engine = new AudioEngine();
    engine.setVolumes(4, -2, 0.5);
    expect(engine.getVolumes()).toEqual({ master: 1, music: 0, sfx: 0.5 });
    engine.dispose();
  });

  it('exposes a debug spatial probe without a live context', () => {
    const engine = new AudioEngine();
    const camera = new PerspectiveCamera(60, 16 / 9, 0.1, 100);
    camera.position.set(0, 1.7, 0);
    camera.lookAt(0, 1.7, -10);
    camera.updateMatrixWorld(true);
    engine.update(camera, 0.016);
    const probe = engine.debugSpatial({ x: 5, y: 1, z: -2 });
    expect(Number.isFinite(probe.gain)).toBe(true);
    expect(Number.isFinite(probe.pan)).toBe(true);
    expect(probe.pan).toBeGreaterThan(0);
    engine.dispose();
  });
});

describe('singleton contract', () => {
  it('exports an AudioAPI-compatible singleton', () => {
    for (const method of [
      'unlock',
      'play',
      'update',
      'setVolumes',
      'startMusic',
      'stopMusic',
      'setCrowd',
      'cheer',
      'gong',
      'dispose',
    ] as const) {
      expect(typeof audio[method]).toBe('function');
    }
    expect(audio.currentMusic).toBeNull();
    expect(audio.activeVoices).toBe(0);
  });
});
