import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEG,
  TAU,
  clamp,
  clamp01,
  catmullRom,
  damp,
  dampAngle,
  distance3,
  hexToRgb,
  identity4,
  invert4,
  lerp,
  lerpAngle,
  lookAt,
  mat4,
  multiply4,
  normalMatrix3,
  normalize3,
  perspective,
  rotationY,
  scaling4,
  transformPoint3,
  translation4,
  wrap,
  wrapAngle,
  compose4,
} from '../src/core/math.js';

const EPS = 1e-6;

function assertClose(actual, expected, epsilon = EPS, message = '') {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${message || 'value'}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`,
  );
}

function assertMatrixClose(actual, expected, epsilon = 1e-5, message = 'matrix') {
  for (let i = 0; i < 16; i += 1) {
    assert.ok(
      Math.abs(actual[i] - expected[i]) <= epsilon,
      `${message} index ${i}: expected ${expected[i]}, got ${actual[i]}`,
    );
  }
}

test('mat4 starts as identity and identity4 fills an arbitrary buffer', () => {
  const m = mat4();
  assert.deepEqual(Array.from(m), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

  const target = new Float32Array(16).fill(7);
  identity4(target);
  assert.deepEqual(Array.from(target), Array.from(m), 'identity4 must overwrite every element');

  const another = mat4();
  another[3] = 0.25;
  assert.notDeepEqual(Array.from(another), Array.from(m), 'each mat4() call returns a fresh array');
});

test('multiply4 applies the right-hand matrix first and matches the identity', () => {
  const id = identity4();
  const rotation = rotationY(Math.PI / 2);
  const translated = translation4(1, 2, 3);

  // (T * R) * p  ==  T * (R * p)
  const combined = multiply4(new Float32Array(16), translated, rotation);
  const point = transformPoint3(combined, 1, 0, 0);
  // R rotates (1,0,0) to (0,0,-1); T shifts it to (1,2,2).
  assertClose(point[0], 1, 1e-6, 'combined x');
  assertClose(point[1], 2, 1e-6, 'combined y');
  assertClose(point[2], 2, 1e-6, 'combined z');

  assertMatrixClose(multiply4(new Float32Array(16), combined, id), combined, 1e-6, 'M * I');
  assertMatrixClose(multiply4(new Float32Array(16), id, combined), combined, 1e-6, 'I * M');
});

test('compose4 matches translate * rotateY * scale', () => {
  const yaw = 0.63;
  const composed = compose4(4, -2, 7, yaw, 2, 3, 1.5);
  const expected = multiply4(
    new Float32Array(16),
    translation4(4, -2, 7),
    multiply4(new Float32Array(16), rotationY(yaw), scaling4(2, 3, 1.5)),
  );
  assertMatrixClose(composed, expected, 1e-6, 'compose4');
});

test('invert4 round-trips a composed matrix back to the identity', () => {
  const matrix = compose4(3, -4, 5, 0.7, 2, 0.5, 1.5);
  const inverse = invert4(new Float32Array(16), matrix);
  const product = multiply4(new Float32Array(16), matrix, inverse);
  assertMatrixClose(product, identity4(), 1e-5, 'M * inv(M)');

  const productOtherWay = multiply4(new Float32Array(16), inverse, matrix);
  assertMatrixClose(productOtherWay, identity4(), 1e-5, 'inv(M) * M');
});

test('invert4 returns the identity for a singular matrix instead of NaN', () => {
  const singular = new Float32Array(16); // all zeroes: determinant 0
  const inverse = invert4(new Float32Array(16), singular);
  assertMatrixClose(inverse, identity4(), 0, 'singular inverse');
  for (let i = 0; i < 16; i += 1) {
    assert.ok(Number.isFinite(inverse[i]), `singular inverse element ${i} must be finite`);
  }
});

test('perspective maps the near plane to NDC z=-1 and the far plane to z=+1', () => {
  const near = 0.3;
  const far = 1600;
  const projection = perspective(0.95, 16 / 9, near, far);

  const onNear = transformPoint3(projection, 0, 0, -near);
  const onFar = transformPoint3(projection, 0, 0, -far);
  assertClose(onNear[2], -1, 1e-5, 'near plane NDC z');
  assertClose(onFar[2], 1, 1e-5, 'far plane NDC z');

  // The centre of the viewport stays at x = y = 0 regardless of depth.
  assertClose(onNear[0], 0, 1e-6, 'near plane NDC x');
  assertClose(onNear[1], 0, 1e-6, 'near plane NDC y');
  assert.ok(Array.from(projection).every(Number.isFinite), 'perspective produces finite values');
});

test('lookAt puts the eye at the origin and looks down -Z', () => {
  const eye = [0, 0, 5];
  const target = [0, 0, 0];
  const view = lookAt(eye, target);
  const transformedEye = transformPoint3(view, ...eye);
  const transformedTarget = transformPoint3(view, ...target);

  assertClose(transformedEye[0], 0, 1e-6, 'eye x');
  assertClose(transformedEye[1], 0, 1e-6, 'eye y');
  assertClose(transformedEye[2], 0, 1e-6, 'eye z');
  assertClose(transformedTarget[2], -5, 1e-6, 'target z (in front of the camera)');
  assertClose(transformedTarget[0], 0, 1e-6, 'target x');
});

test('lookAt handles a degenerate eye/target pair without NaN', () => {
  const view = lookAt([1, 1, 1], [1, 1, 1]);
  assert.ok(Array.from(view).every(Number.isFinite), 'degenerate lookAt must stay finite');
});

test('normalMatrix3 transforms a rotation without stretching normals', () => {
  const rotation = rotationY(0.4);
  const normalMatrix = normalMatrix3(rotation);
  const normal = normalize3([0.3, 0.5, -0.8]);
  const transformed = [
    normalMatrix[0] * normal[0] + normalMatrix[3] * normal[1] + normalMatrix[6] * normal[2],
    normalMatrix[1] * normal[0] + normalMatrix[4] * normal[1] + normalMatrix[7] * normal[2],
    normalMatrix[2] * normal[0] + normalMatrix[5] * normal[1] + normalMatrix[8] * normal[2],
  ];
  assertClose(Math.hypot(...transformed), 1, 1e-5, 'rotated normal length');
  // A rotation about Y keeps the Y component intact.
  assertClose(transformed[1], normal[1], 1e-5, 'rotated normal y');
});

test('wrapAngle keeps angles in (-PI, PI] and removes whole turns', () => {
  assertClose(wrapAngle(0.5), 0.5, 1e-9, 'wrapAngle(0.5)');
  assertClose(wrapAngle(TAU + 0.25), 0.25, 1e-9, 'wrapAngle(TAU + 0.25)');
  assertClose(wrapAngle(-TAU - 0.25), -0.25, 1e-9, 'wrapAngle(-TAU - 0.25)');
  assertClose(Math.abs(wrapAngle(Math.PI)), Math.PI, 1e-9, 'wrapAngle(PI) is the +/-PI seam');

  for (const angle of [1e3, -1e3, 7.5, -7.5, TAU * 1000 + 0.1]) {
    const wrapped = wrapAngle(angle);
    assert.ok(
      wrapped > -Math.PI - 1e-9 && wrapped <= Math.PI + 1e-9,
      `wrapAngle(${angle}) = ${wrapped} outside (-PI, PI]`,
    );
    assertClose(angle - wrapped, TAU * Math.round((angle - wrapped) / TAU), 1e-6, `wrapAngle(${angle}) congruence`);
  }
});

test('lerpAngle and dampAngle take the shortest path', () => {
  const start = Math.PI - 0.1;
  const end = -Math.PI + 0.1;
  const halfway = lerpAngle(start, end, 0.5);
  assert.ok(
    Math.abs(wrapAngle(halfway - Math.PI)) < 0.02,
    `expected interpolation across the seam near PI, got ${halfway}`,
  );
  const damped = dampAngle(start, end, 100, 1);
  assert.ok(
    Math.abs(wrapAngle(damped - end)) < 0.01,
    `dampAngle should close the gap on the short side, got ${damped}`,
  );
});

test('clamp, clamp01 and damp behave at their boundaries', () => {
  assert.equal(clamp(-5, 0, 10), 0, 'clamp low');
  assert.equal(clamp(50, 0, 10), 10, 'clamp high');
  assert.equal(clamp(0.5, 0, 10), 0.5, 'clamp inside');

  assert.equal(clamp01(-0.2), 0, 'clamp01 low');
  assert.equal(clamp01(1.2), 1, 'clamp01 high');

  assert.equal(damp(0, 10, 10, 0), 0, 'damp with zero dt does not move');
  assertClose(damp(0, 10, 10, 1), 10, 1e-3, 'damp with a large dt reaches target');
  const halfwayDamp = damp(0, 10, 1, 0.5);
  assert.ok(halfwayDamp > 0 && halfwayDamp < 10, `damp halfway should be between endpoints, got ${halfwayDamp}`);
});

test('catmullRom hits its control points at t=0 and t=1', () => {
  const p0 = -3;
  const p1 = 2;
  const p2 = 7;
  const p3 = 1;
  assertClose(catmullRom(p0, p1, p2, p3, 0), p1, 1e-9, 'catmullRom t=0');
  assertClose(catmullRom(p0, p1, p2, p3, 1), p2, 1e-9, 'catmullRom t=1');

  // A straight line (equally spaced control points) stays a straight line.
  assertClose(catmullRom(0, 1, 2, 3, 0.5), 1.5, 1e-9, 'catmullRom midpoint of a straight line');
});

test('hexToRgb parses hex colors and never returns NaN', () => {
  assert.deepEqual(hexToRgb('#ff8000'), [1, 128 / 255, 0], 'hexToRgb #ff8000');
  assert.deepEqual(hexToRgb('00ff00'), [0, 1, 0], 'hexToRgb without hash');
  const invalid = hexToRgb('not-a-color');
  assert.deepEqual(invalid, [1, 0, 1], 'invalid hex falls back to magenta');
  assert.ok(invalid.every(Number.isFinite), 'invalid hex must not produce NaN');
});

test('misc scalar helpers: wrap, lerp, distance3, normalize3', () => {
  assertClose(wrap(7, 0, 5), 2, 1e-9, 'wrap(7,0,5)');
  assertClose(wrap(-1, 0, 5), 4, 1e-9, 'wrap(-1,0,5)');
  assert.equal(lerp(2, 4, 0.25), 2.5, 'lerp');
  assertClose(distance3([1, 2, 3], [1, 2, 8]), 5, 1e-9, 'distance3');
  assert.deepEqual(normalize3([0, 0, 0]), [0, 0, 0], 'normalize3 of a zero vector');
  assertClose(Math.hypot(...normalize3([3, 4, 0])), 1, 1e-9, 'normalize3 unit length');
});

test('DEG is one degree in radians', () => {
  assertClose(DEG * 180, Math.PI, 1e-12, '180 degrees = PI');
});
