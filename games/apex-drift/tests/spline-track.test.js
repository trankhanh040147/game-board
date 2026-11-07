import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TAU } from '../src/core/math.js';
import {
  catmullRom,
  loopLength,
  rebaseArcLength,
  resampleUniform,
  rotateToStraightest,
  sampleAt,
  sampleClosedSpline,
} from '../src/sim/spline.js';
import { buildTrack, deltaS, gridSlot } from '../src/sim/track.js';
import { TRACK_DEFS, TRACK_ORDER } from '../src/sim/config.js';

const TRACKS = TRACK_ORDER.map((id) => ({ def: TRACK_DEFS[id], track: buildTrack(TRACK_DEFS[id]) }));

function assertFinite(value, message) {
  assert.ok(Number.isFinite(value), `${message}: expected a finite number, got ${value}`);
}

test('catmullRom is re-exported from spline.js and hits control points', () => {
  assert.equal(typeof catmullRom, 'function', 'spline.js must re-export catmullRom');
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 0) - 1) < 1e-9, 'catmullRom t=0 returns p1');
  assert.ok(Math.abs(catmullRom(0, 1, 2, 3, 1) - 2) < 1e-9, 'catmullRom t=1 returns p2');
});

test('sampleClosedSpline rejects fewer than four control points', () => {
  assert.throws(
    () => sampleClosedSpline([{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }]),
    /at least 4/i,
    'sampleClosedSpline should throw a descriptive error for 3 points',
  );
});

test('closed spline samples are uniformly spaced and close the loop', () => {
  const points = [];
  const radius = 60;
  for (let i = 0; i < 12; i += 1) {
    const a = (i / 12) * TAU;
    points.push({ x: Math.cos(a) * radius, y: 0, z: Math.sin(a) * radius });
  }
  const requested = 4;
  const samples = sampleClosedSpline(points, { spacing: requested });
  assert.ok(samples.length > 50, `expected a dense loop, got ${samples.length} samples`);

  const length = loopLength(samples);
  const spacing = length / samples.length;
  assert.ok(
    Math.abs(spacing - requested) < requested * 0.02,
    `actual spacing ${spacing.toFixed(4)} m should be within 2% of requested ${requested} m`,
  );

  for (let i = 0; i < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    const distance = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    assert.ok(
      Math.abs(distance - spacing) < spacing * 0.05,
      `segment ${i} length ${distance.toFixed(3)} m deviates from spacing ${spacing.toFixed(3)} m`,
    );
  }
});

test('resampleUniform keeps closed-loop arc length and rejects degenerate input', () => {
  const square = [
    { x: 0, y: 0, z: 0 },
    { x: 40, y: 0, z: 0 },
    { x: 40, y: 0, z: 40 },
    { x: 0, y: 0, z: 40 },
  ];
  const resampled = resampleUniform(square, 4);
  assert.ok(resampled.length >= 40, `expected ~40 samples, got ${resampled.length}`);
  const length = loopLength(resampled);
  assert.ok(Math.abs(length - 160) < 3, `resampled square length should be ~160 m, got ${length}`);

  assert.deepEqual(resampleUniform(square, 1000), [], 'a loop shorter than 3 * spacing returns no samples');
  assert.deepEqual(resampleUniform([], 4), [], 'empty input returns no samples');
});

test('rotateToStraightest moves the given index onto the straightest stretch', () => {
  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    samples.push({
      x: i,
      y: 0,
      z: 0,
      tx: 1,
      ty: 0,
      tz: 0,
      rx: 0,
      rz: -1,
      curvature: Math.abs(i - 17) <= 2 ? 0.0001 : 0.05,
      s: i,
    });
  }
  const rotated = rotateToStraightest(samples, 2);
  assert.equal(rotated[0].x, 17, `expected sample 17 first, got ${rotated[0].x}`);
  assert.equal(rotated.length, samples.length, 'rotateToStraightest preserves sample count');
  // The rotation keeps the circular order.
  for (let i = 0; i < rotated.length; i += 1) {
    assert.equal(rotated[i].x, (17 + i) % 40, `rotated sample ${i} out of order`);
  }
});

test('every track build is 1.5-2.2 km with a closed, uniformly spaced loop', () => {
  for (const { def, track } of TRACKS) {
    assert.ok(
      track.length >= 1500 && track.length <= 2200,
      `${track.name}: length ${track.length.toFixed(1)} m outside 1500-2200 m`,
    );
    assert.ok(track.sampleCount > 100, `${track.name}: expected a dense sample loop, got ${track.sampleCount}`);
    assert.ok(track.sampleCount === track.samples.length, `${track.name}: sampleCount mismatch`);
    assert.ok(Number.isFinite(track.spacing), `${track.name}: spacing must be finite`);
    assert.ok(
      Math.abs(track.spacing - 3.5) < 0.05,
      `${track.name}: default sample spacing should be ~3.5 m, got ${track.spacing}`,
    );

    let sum = 0;
    for (let i = 0; i < track.samples.length; i += 1) {
      const a = track.samples[i];
      const b = track.samples[(i + 1) % track.samples.length];
      const segment = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      assert.ok(
        segment > 0 && segment < track.spacing * 1.1,
        `${track.name}: segment ${i} is ${segment.toFixed(3)} m (spacing ${track.spacing.toFixed(3)})`,
      );
      sum += segment;
    }
    assert.ok(
      Math.abs(sum - track.length) < 1e-6,
      `${track.name}: length ${track.length} != summed segments ${sum}`,
    );
  }
});

test('track samples carry unit tangents and perpendicular horizontal right vectors', () => {
  for (const { track } of TRACKS) {
    for (let i = 0; i < track.samples.length; i += 7) {
      const sample = track.samples[i];
      const tangentLength = Math.hypot(sample.tx, sample.ty, sample.tz);
      assert.ok(
        Math.abs(tangentLength - 1) < 1e-5,
        `${track.name} sample ${i}: tangent length ${tangentLength} should be 1`,
      );
      const rightLength = Math.hypot(sample.rx, sample.rz);
      assert.ok(
        Math.abs(rightLength - 1) < 1e-5,
        `${track.name} sample ${i}: right vector length ${rightLength} should be 1`,
      );
      const dot = sample.rx * sample.tx + sample.rz * sample.tz;
      assert.ok(
        Math.abs(dot) < 1e-5,
        `${track.name} sample ${i}: right vector is not perpendicular to tangent (dot ${dot})`,
      );
      assertFinite(sample.curvature, `${track.name} sample ${i} curvature`);
      assertFinite(sample.s, `${track.name} sample ${i} arc length`);
    }
  }
});

test('the start line sits on a straight stretch after rotation', () => {
  for (const { track } of TRACKS) {
    const window = 10;
    let startCurvature = 0;
    for (let i = 0; i < window; i += 1) startCurvature += Math.abs(track.samples[i].curvature);
    startCurvature /= window;

    let total = 0;
    let peak = 0;
    for (const sample of track.samples) {
      const absolute = Math.abs(sample.curvature);
      total += absolute;
      peak = Math.max(peak, absolute);
    }
    const average = total / track.samples.length;
    assert.ok(
      startCurvature < Math.max(average * 2.5, 0.002),
      `${track.name}: start-line curvature ${startCurvature.toFixed(5)} is not low (avg ${average.toFixed(5)}, peak ${peak.toFixed(5)})`,
    );
    assert.ok(
      startCurvature < peak * 0.25,
      `${track.name}: start-line curvature ${startCurvature.toFixed(5)} should be far below the tightest corner ${peak.toFixed(5)}`,
    );
  }
});

test('track.startLine agrees with sample 0', () => {
  for (const { track } of TRACKS) {
    const first = track.samples[0];
    assert.equal(track.startLine.s, 0, `${track.name}: start line s should be 0`);
    assert.ok(Math.hypot(track.startLine.x - first.x, track.startLine.z - first.z) < 1e-9, `${track.name}: start line position`);
    assert.ok(Math.abs(track.startLine.heading - Math.atan2(first.tx, first.tz)) < 1e-9, `${track.name}: start line heading`);
  }
});

test('query on the centreline reports road with ~zero lateral offset', () => {
  for (const { track } of TRACKS) {
    for (const index of [0, 17, 101, 250, track.sampleCount - 1]) {
      const sample = track.samples[index % track.sampleCount];
      const result = track.query(sample.x, sample.z);
      assert.ok(
        Math.abs(result.lateral) < 0.01,
        `${track.name} sample ${index}: lateral ${result.lateral} should be ~0 on the centreline`,
      );
      assert.equal(result.surface, 'road', `${track.name} sample ${index}: centreline must be road`);
      assert.equal(result.onTrack, true, `${track.name} sample ${index}: centreline must be on track`);
      assert.ok(
        Math.hypot(result.x - sample.x, result.z - sample.z) < 0.05,
        `${track.name} sample ${index}: nearest point is ${Math.hypot(result.x - sample.x, result.z - sample.z).toFixed(3)} m away`,
      );
      assertFinite(result.s, `${track.name} sample ${index} query s`);
      assert.ok(
        result.s >= 0 && result.s < track.length,
        `${track.name} sample ${index}: query s ${result.s} outside 0..${track.length}`,
      );
    }
  }
});

test('query far outside the loop returns grass and off-track', () => {
  for (const { track } of TRACKS) {
    const result = track.query(track.startLine.x + 5000, track.startLine.z - 5000);
    assert.equal(result.surface, 'grass', `${track.name}: far query must be grass`);
    assert.equal(result.onTrack, false, `${track.name}: far query must be off track`);
    assert.equal(result.onShoulder, false, `${track.name}: far query must not be on the shoulder`);
    assertFinite(result.lateral, `${track.name}: far query lateral`);
  }
});

test('query surfaces span road, kerb and grass by lateral offset', () => {
  for (const { track } of TRACKS) {
    const start = track.samples[0];
    const offset = (lateral) => ({
      x: start.x + start.rx * lateral,
      z: start.z + start.rz * lateral,
    });

    const onRoad = track.query(offset(track.halfWidth - 1).x, offset(track.halfWidth - 1).z);
    assert.equal(onRoad.surface, 'road', `${track.name}: inside half width must be road`);

    const onKerb = track.query(offset(track.halfWidth + track.kerbWidth * 0.5).x, offset(track.halfWidth + track.kerbWidth * 0.5).z);
    assert.equal(onKerb.surface, 'kerb', `${track.name}: kerb strip must report kerb`);

    const onGrass = track.query(offset(track.boundary + 3).x, offset(track.boundary + 3).z);
    assert.equal(onGrass.surface, 'grass', `${track.name}: beyond the boundary must be grass`);
    assert.equal(onGrass.onTrack, false, `${track.name}: beyond the boundary must be off track`);
  }
});

test('query accepts a valid hint and matches a fresh scan', () => {
  for (const { track } of TRACKS) {
    const index = 200 % track.sampleCount;
    const sample = track.samples[index];
    const fresh = track.query(sample.x, sample.z);
    const hinted = track.query(sample.x, sample.z, index);
    assert.ok(Math.abs(fresh.lateral - hinted.lateral) < 1e-9, `${track.name}: hinted lateral differs from fresh scan`);
    assert.ok(Math.abs(fresh.s - hinted.s) < 1e-9, `${track.name}: hinted s differs from fresh scan`);

    // A nearby stale hint must converge on the same local minimum.
    const staleHint = (index + 40) % track.sampleCount;
    const stale = track.query(sample.x, sample.z, staleHint);
    assert.ok(
      Math.hypot(stale.x - fresh.x, stale.z - fresh.z) < 1,
      `${track.name}: a stale-but-nearby hint returned a different road point`,
    );
  }
});

test('gridTransform places slots behind the start line with a lateral offset', () => {
  for (const { track } of TRACKS) {
    const slot = track.gridTransform(12, 3);
    assert.ok(
      Math.abs(slot.s - (track.length - 12)) < 1e-6,
      `${track.name}: grid slot s ${slot.s} should be length-12 (${track.length - 12})`,
    );
    assert.ok(
      Math.abs(slot.heading - track.pointAt(slot.s).heading) < 1e-9,
      `${track.name}: grid slot heading should follow the road at its arc length`,
    );
    assert.ok(
      Math.abs(slot.heading - track.startLine.heading) < 0.1,
      `${track.name}: grid slot heading ${slot.heading} strays from the start-line heading ${track.startLine.heading}`,
    );
    const query = track.query(slot.x, slot.z);
    assert.ok(Math.abs(query.lateral - 3) < 0.05, `${track.name}: grid slot lateral ${query.lateral} should be 3`);
    assert.equal(query.surface, 'road', `${track.name}: grid slot should be on the road`);

    const delta = deltaS(track, slot.s, 0);
    assert.ok(Math.abs(delta - 12) < 1e-6, `${track.name}: distance from grid slot to the line ${delta} should be 12 m`);
  }
});

test('gridSlot keeps six grid positions distinct', () => {
  for (const { track } of TRACKS) {
    const slots = [];
    for (let i = 0; i < 6; i += 1) slots.push(gridSlot(track, i));
    for (let i = 0; i < slots.length; i += 1) {
      for (let j = i + 1; j < slots.length; j += 1) {
        const distance = Math.hypot(slots[i].x - slots[j].x, slots[i].z - slots[j].z);
        assert.ok(distance > 2, `${track.name}: grid slots ${i} and ${j} are ${distance.toFixed(2)} m apart`);
      }
    }
  }
});

test('pointAt wraps around the loop and sampleAt interpolates', () => {
  for (const { track } of TRACKS) {
    const start = track.pointAt(0);
    const atLength = track.pointAt(track.length);
    const beforeStart = track.pointAt(-1);
    const nearEnd = track.pointAt(track.length - 1);

    assert.ok(Math.hypot(atLength.x - start.x, atLength.z - start.z) < 0.2, `${track.name}: pointAt(length) should wrap to the start`);
    assert.ok(Math.hypot(beforeStart.x - nearEnd.x, beforeStart.z - nearEnd.z) < 0.2, `${track.name}: pointAt(-1) should equal pointAt(length-1)`);

    const sampled = track.sampleAt(track.length * 0.37);
    const pointed = track.pointAt(track.length * 0.37);
    assert.ok(Math.hypot(sampled.x - pointed.x, sampled.z - pointed.z) < 1e-9, `${track.name}: sampleAt and pointAt disagree`);
    assertFinite(pointed.heading, `${track.name}: pointAt heading`);
    assert.ok(Math.abs(Math.hypot(pointed.rx, pointed.rz) - 1) < 1e-4, `${track.name}: pointAt right vector not unit length`);
  }
});

test('curvature is signed, finite and curvatureAhead returns the worst corner ahead', () => {
  for (const { track } of TRACKS) {
    let hasLeft = false;
    let hasRight = false;
    for (const sample of track.samples) {
      assertFinite(sample.curvature, `${track.name}: curvature`);
      if (sample.curvature > 0.004) hasLeft = true;
      if (sample.curvature < -0.004) hasRight = true;
    }
    assert.ok(hasLeft, `${track.name}: track should have at least one left-hand bend (positive curvature)`);
    assert.ok(hasRight, `${track.name}: track should have at least one right-hand bend (negative curvature)`);

    // curvatureAhead must match the signed curvature with the largest magnitude in the window.
    for (const fraction of [0, 0.23, 0.51, 0.77]) {
      const s = track.length * fraction;
      const ahead = track.curvatureAhead(s, 60);
      assertFinite(ahead, `${track.name}: curvatureAhead(${s.toFixed(0)})`);

      const steps = Math.max(1, Math.round(60 / track.spacing));
      let expected = 0;
      for (let i = 0; i <= steps; i += 1) {
        const curvature = track.sampleAt(s + (i * 60) / steps).curvature;
        if (Math.abs(curvature) > Math.abs(expected)) expected = curvature;
      }
      assert.ok(
        Math.abs(ahead - expected) < 1e-6,
        `${track.name}: curvatureAhead ${ahead} should equal manual scan ${expected}`,
      );
    }
  }
});

test('track self-clearance exceeds twice the road boundary (road never crosses itself)', () => {
  for (const { track } of TRACKS) {
    const stride = 2;
    let minClearance = Infinity;
    let pair = [0, 0];
    for (let i = 0; i < track.samples.length; i += stride) {
      for (let j = i + stride; j < track.samples.length; j += stride) {
        const gap = Math.min(Math.abs(i - j), track.samples.length - Math.abs(i - j));
        if (gap * track.spacing < 90) continue;
        const a = track.samples[i];
        const b = track.samples[j];
        const distance = Math.hypot(a.x - b.x, a.z - b.z);
        if (distance < minClearance) {
          minClearance = distance;
          pair = [i, j];
        }
      }
    }
    assert.ok(
      minClearance > track.boundary * 2,
      `${track.name}: non-neighbouring parts of the loop are only ${minClearance.toFixed(1)} m apart (samples ${pair[0]}/${pair[1]}), boundary ${track.boundary} m`,
    );
  }
});

test('rebaseArcLength restarts arc length at zero and returns the total', () => {
  const points = TRACK_DEFS['neon-bay'].points;
  const samples = sampleClosedSpline(points, { spacing: 8 });
  for (const sample of samples) sample.s += 100;
  const total = rebaseArcLength(samples);
  assert.equal(samples[0].s, 0, 'first sample s should be 0 after rebase');
  assert.ok(total > 1000, `rebaseArcLength should return the loop length, got ${total}`);
  for (let i = 1; i < samples.length; i += 1) {
    assert.ok(samples[i].s > samples[i - 1].s, `arc length must increase at index ${i}`);
  }
  assert.ok(
    Math.abs(loopLength(samples) - total) < 1e-6,
    `rebaseArcLength total ${total} should equal loopLength ${loopLength(samples)}`,
  );
});

test('sampleAt on a decorated loop returns the sample at its own arc length', () => {
  const samples = sampleClosedSpline(TRACK_DEFS['neon-bay'].points, { spacing: 8 });
  for (const index of [0, 1, 2, 5, 11]) {
    const expected = samples[index];
    const actual = sampleAt(samples, expected.s);
    assert.ok(actual, 'sampleAt should return a sample');
    const distance = Math.hypot(actual.x - expected.x, actual.z - expected.z);
    assert.ok(
      distance < 0.1,
      `sampleAt(sample ${index}.s = ${expected.s.toFixed(2)}) is ${distance.toFixed(3)} m away from the sample`,
    );
  }
});
