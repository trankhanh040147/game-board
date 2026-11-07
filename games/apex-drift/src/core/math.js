/**
 * Small, dependency-free maths for the simulation and the renderer.
 *
 * Conventions
 * -----------
 * - 3D: right-handed, +Y up, metres.
 * - Matrices are 4x4, column-major `Float32Array(16)`, the layout WebGL wants.
 * - Angles are radians. `wrapAngle` normalises to (-PI, PI].
 *
 * Everything here is pure and DOM-free, so `node --test` can import it directly.
 */

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

export function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function invLerp(a, b, value) {
  return b === a ? 0 : (value - a) / (b - a);
}

/** Framerate-independent exponential smoothing towards `target`. */
export function damp(current, target, lambda, dt) {
  return target + (current - target) * Math.exp(-lambda * dt);
}

export function smoothstep(edge0, edge1, x) {
  const t = clamp01(invLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function sign(value) {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}

/** Move `current` towards `target` by at most `maxDelta`. */
export function moveTowards(current, target, maxDelta) {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/** Wrap into [min, max). */
export function wrap(value, min, max) {
  const range = max - min;
  if (range <= 0) return min;
  return min + ((((value - min) % range) + range) % range);
}

/** Wrap an angle into (-PI, PI]. */
export function wrapAngle(angle) {
  let a = angle % TAU;
  if (a <= -Math.PI) a += TAU;
  else if (a > Math.PI) a -= TAU;
  return a;
}

/** Shortest-path angle interpolation; `t` is not clamped. */
export function lerpAngle(a, b, t) {
  return a + wrapAngle(b - a) * t;
}

export function dampAngle(current, target, lambda, dt) {
  return current + wrapAngle(target - current) * (1 - Math.exp(-lambda * dt));
}

/** Cubic Hermite interpolation used by the track spline. */
export function hermite(p0, p1, m0, m1, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
}

/** Scalar Catmull-Rom, the same curve the closed track spline uses. */
export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    0.5 *
    (2 * p1 +
      (-p0 + p2) * t +
      (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
      (-p0 + 3 * p1 - 3 * p2 + p3) * t3)
  );
}

/* ------------------------------------------------------------------ vec3 -- */

export function vec3(x = 0, y = 0, z = 0) {
  return [x, y, z];
}

export function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(a, s) {
  return [a[0] * s, a[1] * s, a[2] * s];
}

export function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length3(a) {
  return Math.hypot(a[0], a[1], a[2]);
}

export function normalize3(a) {
  const len = length3(a);
  return len > 1e-9 ? [a[0] / len, a[1] / len, a[2] / len] : [0, 0, 0];
}

export function lerp3(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

export function distanceXZ(ax, az, bx, bz) {
  return Math.hypot(ax - bx, az - bz);
}

export function transformPoint3(m, x, y, z) {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  const iw = w !== 0 ? 1 / w : 1;
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw,
  ];
}

/* ------------------------------------------------------------------ mat4 -- */

export function mat4() {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

export function identity4(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

export function copy4(out, src) {
  out.set(src);
  return out;
}

/** `out = a * b` (column-major, so `b` is applied first). */
export function multiply4(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a00 * b0 + a10 * b1 + a20 * b2 + a30 * b3;
    out[col * 4 + 1] = a01 * b0 + a11 * b1 + a21 * b2 + a31 * b3;
    out[col * 4 + 2] = a02 * b0 + a12 * b1 + a22 * b2 + a32 * b3;
    out[col * 4 + 3] = a03 * b0 + a13 * b1 + a23 * b2 + a33 * b3;
  }
  return out;
}

export function translation4(x, y, z, out = new Float32Array(16)) {
  identity4(out);
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

export function rotationX(angle, out = new Float32Array(16)) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  identity4(out);
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}

export function rotationY(angle, out = new Float32Array(16)) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  identity4(out);
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

export function rotationZ(angle, out = new Float32Array(16)) {
  const s = Math.sin(angle);
  const c = Math.cos(angle);
  identity4(out);
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

export function scaling4(x, y, z, out = new Float32Array(16)) {
  identity4(out);
  out[0] = x;
  out[5] = y;
  out[10] = z;
  return out;
}

/** Compose translate * rotateY * scale. */
export function compose4(x, y, z, yaw, sx = 1, sy = 1, sz = 1, out = new Float32Array(16)) {
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  out[0] = c * sx;
  out[1] = 0;
  out[2] = -s * sx;
  out[3] = 0;
  out[4] = 0;
  out[5] = sy;
  out[6] = 0;
  out[7] = 0;
  out[8] = s * sz;
  out[9] = 0;
  out[10] = c * sz;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

/** Perspective projection for WebGL clip space (z in [-1, 1]). */
export function perspective(fovY, aspect, near, far, out = new Float32Array(16)) {
  const f = 1 / Math.tan(fovY / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[11] = -1;
  const nf = 1 / (near - far);
  out[10] = (far + near) * nf;
  out[14] = 2 * far * near * nf;
  return out;
}

/** Right-handed look-at view matrix. */
export function lookAt(eye, target, up = [0, 1, 0], out = new Float32Array(16)) {
  let zx = eye[0] - target[0];
  let zy = eye[1] - target[1];
  let zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len < 1e-6) {
    zx = 0;
    zy = 0;
    zz = 1;
    len = 1;
  }
  zx /= len;
  zy /= len;
  zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len < 1e-6) {
    xx = 1;
    xy = 0;
    xz = 0;
  } else {
    xx /= len;
    xy /= len;
    xz /= len;
  }

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx;
  out[1] = yx;
  out[2] = zx;
  out[3] = 0;
  out[4] = xy;
  out[5] = yy;
  out[6] = zy;
  out[7] = 0;
  out[8] = xz;
  out[9] = yz;
  out[10] = zz;
  out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/** General 4x4 inverse; returns `out` identity when the matrix is singular. */
export function invert4(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) return identity4(out);
  det = 1 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** Upper-left 3x3 of the inverse-transpose, for transforming normals. */
export function normalMatrix3(m, out = new Float32Array(9)) {
  const inv = invert4(new Float32Array(16), m);
  out[0] = inv[0];
  out[1] = inv[4];
  out[2] = inv[8];
  out[3] = inv[1];
  out[4] = inv[5];
  out[5] = inv[9];
  out[6] = inv[2];
  out[7] = inv[6];
  out[8] = inv[10];
  return out;
}

/**
 * Convert a hex string (`#rrggbb`) to an RGB triple in 0..1.
 *
 * The renderer shades in display space (no linear->sRGB conversion), so these
 * components are used directly as the values you see on screen.
 */
export function hexToRgb(hex) {
  const value = Number.parseInt(String(hex).replace('#', ''), 16);
  if (!Number.isFinite(value)) return [1, 0, 1];
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

export function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function linearToSrgb(c) {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** Scale an RGB triple, clamped to 0..1. */
export function scaleRgb(rgb, factor) {
  return [clamp01(rgb[0] * factor), clamp01(rgb[1] * factor), clamp01(rgb[2] * factor)];
}

export function mixRgb(a, b, t) {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

/** Remove small numerical drift from a velocity vector without killing direction. */
export function dampVectorXZ(vx, vz, lambda, dt) {
  const factor = Math.exp(-lambda * dt);
  return [vx * factor, vz * factor];
}
