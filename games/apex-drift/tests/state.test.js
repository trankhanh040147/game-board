import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLoop } from '../src/app/loop.js';
import {
  createMemoryStorage,
  createRecordStore,
  getDefaultStorage,
} from '../src/app/storage.js';
import { createInput } from '../src/app/input.js';
import { formatGap, formatLapTime } from '../src/app/ui.js';
import { STORAGE_KEY } from '../src/sim/config.js';

/* ------------------------------------------------------------------ loop -- */

test('createLoop advances a fixed 1/120 s step regardless of frame rate', () => {
  const steps = [];
  const renders = [];
  const loop = createLoop({
    step: 1 / 120,
    maxSubsteps: 8,
    maxFrameDt: 0.1,
    onStep: (dt) => steps.push(dt),
    onRender: (dt) => renders.push(dt),
  });

  assert.equal(loop.advance(0), 0, 'the first frame only primes the clock');

  const frameMs = 1000 / 120;
  for (let frame = 1; frame <= 120; frame += 1) {
    loop.advance(frame * frameMs);
  }

  assert.ok(
    Math.abs(steps.length - 120) <= 2,
    `one second at 120 Hz should run ~120 fixed steps, got ${steps.length}`,
  );
  for (const dt of steps) assert.equal(dt, 1 / 120, 'every simulation step must use the fixed step');
  assert.equal(renders.length, 120, `expected one render per frame, got ${renders.length}`);
  assert.ok(loop.interpolation >= 0 && loop.interpolation <= 1, 'interpolation must stay in 0..1');
});

test('createLoop runs 60 steps for one simulated second at 60 Hz', () => {
  let steps = 0;
  const loop = createLoop({
    step: 1 / 60,
    onStep: () => { steps += 1; },
    onRender: () => {},
  });
  loop.advance(0);
  for (let frame = 1; frame <= 60; frame += 1) loop.advance((frame * 1000) / 60);
  assert.ok(Math.abs(steps - 60) <= 1, `60 frames at 60 Hz should run 60 steps, got ${steps}`);
});

test('createLoop clamps a huge frame gap to maxFrameDt and drops the backlog', () => {
  const stepDts = [];
  const renderDts = [];
  const loop = createLoop({
    step: 1 / 120,
    maxSubsteps: 8,
    maxFrameDt: 0.1,
    onStep: (dt) => stepDts.push(dt),
    onRender: (dt) => renderDts.push(dt),
  });

  loop.advance(0);
  loop.advance(5000); // the tab was asleep for five seconds

  assert.equal(renderDts.length, 1, 'one render for the huge frame');
  assert.equal(renderDts[0], 0.1, `frame dt must clamp to maxFrameDt, got ${renderDts[0]}`);
  assert.equal(stepDts.length, 8, `the step budget must cap catch-up at maxSubsteps, got ${stepDts.length}`);
  assert.ok(stepDts.every((dt) => dt === 1 / 120), 'clamped catch-up still uses the fixed step');
  assert.ok(loop.interpolation >= 0 && loop.interpolation <= 1, 'interpolation stays bounded after a stall');

  // The backlog must be dropped, not spread over the following frames.
  stepDts.length = 0;
  loop.advance(5000 + 1000 / 60);
  assert.ok(stepDts.length <= 3, `the backlog should be dropped, but ${stepDts.length} steps ran next frame`);
});

test('reset clears the accumulator and clock', () => {
  let steps = 0;
  const loop = createLoop({
    step: 1 / 120,
    onStep: () => { steps += 1; },
    onRender: () => {},
  });
  loop.advance(0);
  loop.advance(100);
  const stepsBeforeReset = steps;
  assert.ok(stepsBeforeReset > 0, 'expected steps before reset');
  loop.reset();
  const afterReset = loop.advance(1000);
  assert.equal(afterReset, 0, 'the first frame after reset only primes the clock again');
  assert.equal(steps, stepsBeforeReset, 'reset itself must not run simulation steps');
});

test('start/stop drive the loop through the injected raf', () => {
  const scheduled = [];
  const cancelled = [];
  let lastHandle = 0;
  const loop = createLoop({
    step: 1 / 120,
    raf: (callback) => {
      scheduled.push(callback);
      lastHandle += 1;
      return lastHandle;
    },
    cancelRaf: (handle) => cancelled.push(handle),
    onStep: () => {},
    onRender: () => {},
  });

  loop.start();
  assert.equal(loop.running, true, 'start() should mark the loop running');
  assert.equal(scheduled.length, 1, 'start() should schedule exactly one frame');

  scheduled.shift()(0); // prime
  assert.equal(scheduled.length, 1, 'the loop should re-schedule itself');
  scheduled.shift()(1000 / 120);
  scheduled.shift()(2000 / 120);

  loop.stop();
  assert.equal(loop.running, false, 'stop() should mark the loop stopped');
  assert.equal(cancelled.length, 1, `stop() should cancel exactly one pending raf, got ${cancelled.length}`);
  assert.equal(cancelled[0], lastHandle, 'stop() cancels the handle of the pending frame');
  assert.equal(scheduled.length, 1, 'the final frame is left in the fake queue but must not be invoked');
  scheduled.length = 0;
});

/* --------------------------------------------------------------- storage -- */

test('record store keeps a best lap per track and persists across instances', () => {
  const storage = createMemoryStorage();
  const store = createRecordStore({ storage });

  assert.equal(store.bestLap('neon-bay'), null, 'no record initially');
  assert.equal(store.submitLap('neon-bay', 61.2), true, 'first lap is always a record');
  assert.equal(store.bestLap('neon-bay'), 61.2, 'stored lap readback');

  assert.equal(store.submitLap('neon-bay', 62.9), false, 'a slower lap must not replace the record');
  assert.equal(store.bestLap('neon-bay'), 61.2, 'slow lap left the record alone');

  assert.equal(store.submitLap('neon-bay', 60.05), true, 'a faster lap improves the record');
  assert.equal(store.bestLap('neon-bay'), 60.05, 'improved record readback');

  const reopened = createRecordStore({ storage });
  assert.equal(reopened.bestLap('neon-bay'), 60.05, 'records survive a new store over the same storage');
  assert.equal(reopened.get('car'), 'vanko', 'defaults are restored');
});

test('submitLap rejects NaN, Infinity and implausibly small times', () => {
  const store = createRecordStore({ storage: createMemoryStorage() });
  for (const value of [NaN, Infinity, -Infinity, 0, -5, 1, 5, undefined, null, '61.2']) {
    assert.equal(
      store.submitLap('neon-bay', value),
      false,
      `submitLap should reject ${String(value)}`,
    );
  }
  assert.equal(store.bestLap('neon-bay'), null, 'rejected values must not be stored');
});

test('submitTotal stores total race times', () => {
  const store = createRecordStore({ storage: createMemoryStorage() });
  assert.equal(store.submitTotal('neon-bay', 185.4), true, 'first total time is stored');
  assert.equal(store.get('bestTotal')['neon-bay'], 185.4, 'total time readback');
  assert.equal(store.submitTotal('neon-bay', NaN), false, 'NaN total time rejected');
});

test('incrementRaces counts races and wins', () => {
  const store = createRecordStore({ storage: createMemoryStorage() });
  assert.equal(store.incrementRaces(false), 1, 'first race count');
  assert.equal(store.incrementRaces(true), 2, 'second race count');
  assert.equal(store.incrementRaces(false), 3, 'third race count');
  assert.equal(store.get('races'), 3, 'races stored');
  assert.equal(store.get('wins'), 1, 'wins stored');
});

test('records survive corrupted JSON and malformed values', () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, '{not valid json');
  const store = createRecordStore({ storage });
  assert.equal(store.bestLap('neon-bay'), null, 'corrupted payload falls back to defaults');
  assert.equal(store.get('car'), 'vanko', 'corrupted payload keeps default car');
  assert.equal(store.submitLap('neon-bay', 70), true, 'the store still works after corruption');

  const malformed = createMemoryStorage();
  malformed.setItem(
    STORAGE_KEY,
    JSON.stringify({
      bestLaps: { 'neon-bay': 'fast', 'sunset-canyon': 4000 },
      bestTotal: { 'neon-bay': -3 },
      car: 42,
      races: -10,
      wins: 'many',
      muted: 'yes',
    }),
  );
  const sanitised = createRecordStore({ storage: malformed });
  assert.equal(sanitised.bestLap('neon-bay'), null, 'non-numeric lap times are discarded');
  assert.equal(sanitised.bestLap('sunset-canyon'), null, 'out-of-range lap times are discarded');
  assert.equal(sanitised.get('car'), 'vanko', 'non-string car falls back to the default');
  assert.equal(sanitised.get('races'), 0, 'negative race counts clamp to zero');
  assert.equal(sanitised.get('wins'), 0, 'non-numeric win counts clamp to zero');
  assert.equal(sanitised.get('muted'), true, 'truthy muted is preserved as a boolean');
});

test('set(), reset() and the all getter round-trip', () => {
  const storage = createMemoryStorage();
  const store = createRecordStore({ storage });
  store.set('car', 'kira');
  store.set('quality', 'high');
  assert.equal(store.get('car'), 'kira', 'set/get car');
  assert.equal(store.get('quality'), 'high', 'set/get quality');

  const reopened = createRecordStore({ storage });
  assert.equal(reopened.get('quality'), 'high', 'quality persists');

  reopened.reset();
  assert.equal(reopened.get('car'), 'vanko', 'reset restores the default car');
  assert.equal(reopened.bestLap('neon-bay'), null, 'reset clears records');
  assert.deepEqual(reopened.all.bestLaps, {}, 'reset clears the best-lap table');
});

test('getDefaultStorage always exposes a usable Storage interface', () => {
  const storage = getDefaultStorage();
  for (const method of ['getItem', 'setItem', 'removeItem']) {
    assert.equal(typeof storage[method], 'function', `default storage is missing ${method}()`);
  }
  storage.setItem('__apex_qa__', '42');
  assert.equal(storage.getItem('__apex_qa__'), '42', 'default storage round-trips a value');
  storage.removeItem('__apex_qa__');
  assert.equal(storage.getItem('__apex_qa__'), null, 'default storage removes a value');
});

/* ----------------------------------------------------------------- input -- */

function createStubTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    dispatch(type, event) {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function keyEvent(code, options = {}) {
  let prevented = false;
  return {
    code,
    repeat: Boolean(options.repeat),
    preventDefault() { prevented = true; },
    get defaultPrevented() { return prevented; },
  };
}

test('keyboard input maps throttle, steering, handbrake and nitro', () => {
  const target = createStubTarget();
  const input = createInput({ target, gamepad: false });
  const pressed = (code) => target.dispatch('keydown', keyEvent(code));
  const released = (code) => target.dispatch('keyup', keyEvent(code));

  assert.deepEqual(input.sample(), { throttle: 0, steer: 0, handbrake: false, nitro: false }, 'idle sample');

  pressed('KeyW');
  assert.equal(input.sample().throttle, 1, 'KeyW is full throttle');
  pressed('KeyS');
  assert.equal(input.sample().throttle, 0, 'W and S cancel out');
  released('KeyW');
  assert.equal(input.sample().throttle, -1, 'S alone is brake/reverse');

  pressed('KeyD');
  assert.equal(input.sample().steer, 1, 'KeyD steers right');
  pressed('KeyA');
  assert.equal(input.sample().steer, 0, 'A and D both held resolve to +1 and -1, which cancel out');
  released('KeyA');
  assert.equal(input.sample().steer, 1, 'D alone steers right');

  pressed('Space');
  assert.equal(input.sample().handbrake, true, 'Space engages the handbrake');
  pressed('ShiftLeft');
  assert.equal(input.sample().nitro, true, 'Shift fires nitro');

  released('Space');
  released('ShiftLeft');
  const idle = input.sample();
  assert.equal(idle.handbrake, false, 'releasing Space clears the handbrake');
  assert.equal(idle.nitro, false, 'releasing Shift clears nitro');
  input.dispose();
});

test('arrow keys mirror WASD and blur clears all input', () => {
  const target = createStubTarget();
  const input = createInput({ target, gamepad: false });
  target.dispatch('keydown', keyEvent('ArrowUp'));
  target.dispatch('keydown', keyEvent('ArrowRight'));
  target.dispatch('keydown', keyEvent('Space'));
  let sample = input.sample();
  assert.equal(sample.throttle, 1, 'ArrowUp is throttle');
  assert.equal(sample.steer, 1, 'ArrowRight steers right');
  assert.equal(sample.handbrake, true, 'Space handbrake');

  target.dispatch('blur', {});
  sample = input.sample();
  assert.deepEqual(sample, { throttle: 0, steer: 0, handbrake: false, nitro: false }, 'blur clears the input state');
  input.dispose();
});

test('commands fire once per press and ignore held-key repeats', () => {
  const target = createStubTarget();
  const commands = [];
  const input = createInput({ target, gamepad: false, onCommand: (command) => commands.push(command) });

  target.dispatch('keydown', keyEvent('KeyC'));
  target.dispatch('keydown', keyEvent('KeyC', { repeat: true }));
  target.dispatch('keydown', keyEvent('KeyC', { repeat: true }));
  assert.deepEqual(commands, ['camera'], 'camera command must fire once, not on repeats');

  target.dispatch('keydown', keyEvent('Escape'));
  target.dispatch('keydown', keyEvent('KeyP'));
  target.dispatch('keydown', keyEvent('Enter'));
  target.dispatch('keydown', keyEvent('KeyR'));
  target.dispatch('keydown', keyEvent('KeyM'));
  assert.deepEqual(
    commands,
    ['camera', 'pause', 'pause', 'confirm', 'restart', 'mute'],
    `unexpected command stream: ${commands.join(', ')}`,
  );
  input.dispose();
});

test('setEnabled(false) zeroes the analogue sample but still lets the shell wake up', () => {
  const target = createStubTarget();
  const commands = [];
  const input = createInput({ target, gamepad: false, onCommand: (command) => commands.push(command) });

  target.dispatch('keydown', keyEvent('KeyW'));
  assert.equal(input.sample().throttle, 1, 'enabled input reads keys');
  input.setEnabled(false);

  assert.deepEqual(input.sample(), { throttle: 0, steer: 0, handbrake: false, nitro: false }, 'disabled input reads zero');
  target.dispatch('keydown', keyEvent('KeyW'));
  assert.equal(input.sample().throttle, 0, 'keys are ignored while disabled');

  target.dispatch('keydown', keyEvent('Escape'));
  assert.deepEqual(commands, ['pause'], 'pause/confirm still reach the shell while disabled');
  input.setEnabled(true);
  input.dispose();
});

test('dispose detaches every listener', () => {
  const target = createStubTarget();
  const input = createInput({ target, gamepad: false });
  assert.ok(target.count('keydown') > 0, 'input attaches a keydown listener');
  input.dispose();
  assert.equal(target.count('keydown'), 0, 'dispose removes keydown');
  assert.equal(target.count('keyup'), 0, 'dispose removes keyup');
  assert.equal(target.count('blur'), 0, 'dispose removes blur');
});

test('createInput works without any target (Node safety)', () => {
  const input = createInput({ gamepad: false });
  assert.deepEqual(input.sample(), { throttle: 0, steer: 0, handbrake: false, nitro: false }, 'no-target input is inert');
  input.setEnabled(true);
  input.dispose();
});

/* ------------------------------------------------------------- formatting -- */

test('formatLapTime renders m:ss.mmm', () => {
  assert.equal(formatLapTime(62.5), '1:02.500', '62.5 s');
  assert.equal(formatLapTime(9.5), '0:09.500', '9.5 s');
  assert.equal(formatLapTime(600), '10:00.000', '10 minutes');
  assert.equal(formatLapTime(0.0001), '0:00.000', 'tiny positive time');
  for (const invalid of [null, undefined, NaN, Infinity, 0, -5, 'fast']) {
    assert.equal(formatLapTime(invalid), '--:--.---', `formatLapTime(${String(invalid)}) should be the empty placeholder`);
  }
});

test('formatGap renders a signed gap', () => {
  assert.equal(formatGap(1.234), '+1.23', 'positive gap');
  assert.equal(formatGap(-1.5), '-1.50', 'negative gap');
  assert.equal(formatGap(0), '+0.00', 'zero gap');
  assert.equal(formatGap(75.5), '+1:15.5', 'gap over a minute');
  assert.equal(formatGap(-75.5), '-1:15.5', 'negative gap over a minute');
  assert.equal(formatGap(NaN), '—', 'missing gap placeholder');
  assert.equal(formatGap(Infinity), '—', 'infinite gap placeholder');
});
