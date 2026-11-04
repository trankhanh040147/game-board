import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAudio } from '../src/app/audio.js';
import { createHud } from '../src/app/hud.js';

const TAU = Math.PI * 2;

/* ------------------------------------------------------------- 2D stubs -- */

/**
 * A canvas 2D context that accepts any call. `measureText` is the only method
 * whose return value the HUD reads, so it is the only one implemented.
 */
function createStub2dContext() {
  const calls = [];
  const target = {
    measureText: (text) => ({ width: String(text ?? '').length * 7.4, height: 14 }),
  };
  const context = new Proxy(target, {
    get(object, property) {
      if (property in object) return object[property];
      if (typeof property === 'symbol') return undefined;
      return (...args) => {
        calls.push({ method: String(property), args: args.length });
        return undefined;
      };
    },
    set(object, property, value) {
      object[property] = value;
      return true;
    },
  });
  return { context, calls };
}

function createStubCanvas() {
  const { context, calls } = createStub2dContext();
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext(type) {
      assert.equal(type, '2d', 'the HUD must ask for a 2D context');
      return context;
    },
  };
  return { canvas, calls };
}

/* ------------------------------------------------------------------ HUD -- */

test('hud.js imports cleanly in Node (no DOM access at module scope)', () => {
  assert.equal(typeof createHud, 'function', 'createHud should be exported');
  assert.equal(typeof window, 'undefined', 'these tests should run without a browser window');
});

test('createHud draws a full realistic race state without throwing', () => {
  const { canvas, calls } = createStubCanvas();
  const hud = createHud({ canvas, width: 1280, height: 720, dpr: 1 });
  assert.ok(canvas.width > 0 && canvas.height > 0, 'the HUD should size its canvas backing store');

  const outline = [];
  for (let i = 0; i < 96; i += 1) {
    const angle = (i / 96) * TAU;
    outline.push([Math.cos(angle) * 180, Math.sin(angle) * 140]);
  }
  const state = {
    speedKph: 214.4,
    gear: 4,
    rpm01: 0.78,
    nitro01: 0.62,
    boosting: true,
    drift01: 0.31,
    raceState: 'running',
    countdown: 0,
    lap: 2,
    laps: 3,
    position: 3,
    totalCars: 6,
    lapTime: 42.318,
    lastLap: 61.24,
    bestLap: 60.05,
    delta: -0.42,
    progress: 0.37,
    standings: [
      { name: 'VEGA', position: 1, gap: 0, isPlayer: false },
      { name: 'NOVA', position: 2, gap: 1.24, isPlayer: false },
      { name: 'YOU', position: 3, gap: 2.02, isPlayer: true },
      { name: 'DIESEL', position: 4, gap: 4.88, isPlayer: false },
      { name: 'SPECTRE', position: 5, gap: 6.31, isPlayer: false },
      { name: 'BRICK', position: 6, gap: 9.75, isPlayer: false },
    ],
    minimap: {
      outline,
      cars: [
        { x: 0, z: 0, isPlayer: true },
        { x: 12, z: -40, isPlayer: false },
        { x: -30, z: 20, isPlayer: false },
      ],
      start: [0, 0],
    },
    speedLines: 0.6,
    fps: 60,
    quality: 'MEDIUM',
    toast: { text: 'LAP 2 — 1:01.240', until: Number.POSITIVE_INFINITY },
    bestRecord: 60.05,
  };

  const before = calls.length;
  hud.draw(state);
  assert.ok(calls.length > before + 20, `expected the HUD to issue draw calls, got ${calls.length - before}`);
});

test('createHud tolerates empty, null and partial states', () => {
  const { canvas } = createStubCanvas();
  const hud = createHud({ canvas, width: 800, height: 600, dpr: 2 });

  hud.draw(null);
  hud.draw({});
  hud.draw({ raceState: 'title' });
  hud.draw({ raceState: 'countdown', countdown: 2 });
  hud.draw({ raceState: 'finished', position: 1, totalCars: 6 });
  hud.draw({ raceState: 'paused' });
  hud.draw({ speedKph: Number.NaN, gear: 99, rpm01: -5, nitro01: 12, standings: [], minimap: {} });
  hud.draw({ minimap: { outline: [[0, 0]], cars: [], start: [0, 0] }, standings: null });
  hud.reset();
  hud.draw({ raceState: 'running', lap: 1, laps: 3, position: 1, totalCars: 6 });
});

test('hud.resize and createHud without a canvas are safe', () => {
  const { canvas } = createStubCanvas();
  const hud = createHud({ canvas, width: 1280, height: 720, dpr: 1 });
  hud.resize(1920, 1080, 2);
  assert.equal(canvas.width, 3840, 'backing store should be CSS pixels * dpr');
  assert.equal(canvas.height, 2160, 'backing store height should be CSS pixels * dpr');
  hud.resize(0, -5, 99); // hostile values must not throw
  hud.draw({ raceState: 'running', speedKph: 100 });

  const headless = createHud({});
  headless.draw({ speedKph: 120, raceState: 'running' });
  headless.resize(640, 480, 1);
  headless.reset();
});

/* ---------------------------------------------------------------- audio -- */

test('audio.js imports cleanly in Node and createAudio is an inert no-op', () => {
  assert.equal(typeof createAudio, 'function', 'createAudio should be exported');
  const audio = createAudio();

  for (const method of ['resume', 'suspend', 'dispose', 'setMuted', 'setVolume', 'update', 'event']) {
    assert.equal(typeof audio[method], 'function', `audio.${method}() must exist`);
  }
  assert.equal(typeof audio.muted, 'boolean', 'audio.muted must be a boolean');
  assert.equal(audio.muted, false, 'audio starts unmuted');

  // None of this is allowed to throw without WebAudio/DOM.
  audio.resume();
  audio.update({
    rpm01: 0.55,
    throttle: 0.8,
    speed: 41,
    slip: 0.2,
    boosting: false,
    surface: 'road',
    parked: false,
    raceState: 'racing',
  });
  audio.update();
  audio.event('countdown');
  audio.event('go');
  audio.event('lap');
  audio.event('best');
  audio.event('finish');
  audio.event('scrape');
  audio.event('nitro');
  audio.event('shift');
  audio.event('click');
  audio.event('crash');
  audio.event('not-a-real-event');
  audio.setVolume(0.4);
  audio.setMuted(true);
  assert.equal(audio.muted, true, 'setMuted(true) should be reflected by .muted');
  audio.setMuted(false);
  assert.equal(audio.muted, false, 'setMuted(false) should be reflected by .muted');
  audio.suspend();
  audio.dispose();

  // Calls after dispose must stay inert.
  audio.update({ rpm01: 0.1 });
  audio.event('go');
  audio.setMuted(true);
  audio.resume();
  audio.dispose();
});
