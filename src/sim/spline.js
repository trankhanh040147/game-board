/**
 * Closed Catmull-Rom track spline.
 *
 * Control points are hand-authored per track. The spline is sampled finely,
 * resampled to a uniform arc-length spacing, then each sample is decorated with
 * a 3D tangent, a horizontal "right" vector and a signed curvature. The result is
 * the geometric backbone for the road mesh, the physics surface queries and the
 * AI racing line.
 */

import { TAU, catmullRom, clamp, wrap, wrapAngle } from '../core/math.js';

export { catmullRom };

/**
 * @typedef {{
 *   x:number, y:number, z:number,
 *   tx:number, ty:number, tz:number,
 *   rx:number, rz:number,
 *   curvature:number,
 *   s:number,
 * }} Sample
 */

/** Catmull-Rom interpolation of a 3D control point set at `t` in [0,1). */
export function splinePoint(p0, p1, p2, p3, t) {
  return {
    x: catmullRom(p0.x, p1.x, p2.x, p3.x, t),
    y: catmullRom(p0.y, p1.y, p2.y, p3.y, t),
    z: catmullRom(p0.z, p1.z, p2.z, p3.z, t),
  };
}

/** Sample the dense polyline before uniform resampling. */
function sampleDense(points, samplesPerSegment) {
  const count = points.length;
  const dense = [];
  for (let i = 0; i < count; i += 1) {
    const p0 = points[(i - 1 + count) % count];
    const p1 = points[i];
    const p2 = points[(i + 1) % count];
    const p3 = points[(i + 2) % count];
    for (let step = 0; step < samplesPerSegment; step += 1) {
      dense.push(splinePoint(p0, p1, p2, p3, step / samplesPerSegment));
    }
  }
  return dense;
}

function dedupe(points, epsilon = 0.25) {
  const result = [];
  for (const point of points) {
    const last = result[result.length - 1];
    if (!last || Math.hypot(point.x - last.x, point.y - last.y, point.z - last.z) > epsilon) {
      result.push(point);
    }
  }
  return result;
}

/** Decorate a resampled polyline with tangents, right vectors and curvature. */
function decorate(rows) {
  const count = rows.length;
  const samples = new Array(count);
  let s = 0;

  for (let i = 0; i < count; i += 1) {
    const previous = rows[(i - 1 + count) % count];
    const current = rows[i];
    const next = rows[(i + 1) % count];

    let tx = next.x - previous.x;
    let ty = next.y - previous.y;
    let tz = next.z - previous.z;
    const tlen = Math.hypot(tx, ty, tz) || 1;
    tx /= tlen;
    ty /= tlen;
    tz /= tlen;

    const horizontal = Math.hypot(tx, tz) || 1;
    // right = normalize(cross(up, tangent)) with up = +Y, kept horizontal.
    const rx = tz / horizontal;
    const rz = -tx / horizontal;

    samples[i] = {
      x: current.x,
      y: current.y,
      z: current.z,
      tx,
      ty,
      tz,
      rx,
      rz,
      curvature: 0,
      s,
    };

    s += Math.hypot(next.x - current.x, next.y - current.y, next.z - current.z);
  }

  for (let i = 0; i < count; i += 1) {
    const previous = samples[(i - 1 + count) % count];
    const next = samples[(i + 1) % count];
    const spacingForward = Math.hypot(next.x - samples[i].x, next.z - samples[i].z) || 1;
    const headingForward = Math.atan2(next.x - samples[i].x, next.z - samples[i].z);
    const headingBack = Math.atan2(samples[i].x - previous.x, samples[i].z - previous.z);
    const delta = wrapAngle(headingForward - headingBack);
    const distance = Math.max(spacingForward, 1e-3);
    // Change of heading over the distance travelled across this sample.
    samples[i].curvature = delta / distance;
  }

  // Smooth curvature so the road mesh and AI do not react to sampling jitter.
  const smoothed = samples.map((sample, i) => {
    const a = samples[(i - 2 + count) % count].curvature;
    const b = samples[(i - 1 + count) % count].curvature;
    const c = samples[i].curvature;
    const d = samples[(i + 1) % count].curvature;
    const e = samples[(i + 2) % count].curvature;
    return (a + 2 * b + 3 * c + 2 * d + e) / 9;
  });
  for (let i = 0; i < count; i += 1) samples[i].curvature = smoothed[i];

  return samples;
}

/**
 * Resample a closed polyline to a uniform arc-length spacing.
 * @param {{x:number,y:number,z:number}[]} points
 * @param {number} spacing metres between samples
 */
export function resampleUniform(points, spacing = 4) {
  const cleaned = dedupe(points);
  if (cleaned.length < 3) return [];

  const lengths = [0];
  let total = 0;
  for (let i = 1; i <= cleaned.length; i += 1) {
    const a = cleaned[i - 1];
    const b = cleaned[i % cleaned.length];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
    lengths.push(total);
  }
  if (total < spacing * 3) return [];

  const targetCount = Math.max(12, Math.round(total / spacing));
  const step = total / targetCount;
  const result = new Array(targetCount);

  let segment = 0;
  for (let i = 0; i < targetCount; i += 1) {
    const target = i * step;
    while (segment < lengths.length - 2 && lengths[segment + 1] < target) segment += 1;
    const segmentStart = lengths[segment];
    const segmentLength = lengths[segment + 1] - segmentStart || 1;
    const t = clamp((target - segmentStart) / segmentLength, 0, 1);
    const a = cleaned[segment % cleaned.length];
    const b = cleaned[(segment + 1) % cleaned.length];
    result[i] = {
      x: a.x + (b.x - a.x) * t,
      y: a.y + (b.y - a.y) * t,
      z: a.z + (b.z - a.z) * t,
    };
  }
  return result;
}

/**
 * Sample a closed Catmull-Rom spline into uniformly spaced decorated samples.
 * @param {{x:number,y:number,z:number}[]} points at least 4 control points
 * @param {{spacing?:number, samplesPerSegment?:number}} [options]
 * @returns {Sample[]}
 */
export function sampleClosedSpline(points, options = {}) {
  if (!points || points.length < 4) {
    throw new Error('sampleClosedSpline needs at least 4 control points');
  }
  const spacing = options.spacing ?? 4;
  const samplesPerSegment = options.samplesPerSegment ?? Math.max(8, Math.ceil(spacing ? 8 : 8));
  const dense = sampleDense(points, samplesPerSegment);
  const uniform = resampleUniform(dense, spacing);
  return decorate(uniform);
}

/** Total length of a closed sample loop. */
export function loopLength(samples) {
  if (!samples || samples.length === 0) return 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const a = samples[i];
    const b = samples[(i + 1) % samples.length];
    total += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  }
  return total;
}

/** Sample a closed loop's decorated samples at arc length `s` (wraps). */
export function sampleAt(samples, s) {
  const count = samples.length;
  if (count === 0) return null;
  // O(1) total length: `s` is cumulative, so the last sample plus the closing
  // segment is the loop length. (Calling loopLength here was O(n) per lookup and
  // dominated the physics step once every AI/physics query used it.)
  const last = samples[count - 1];
  const first = samples[0];
  const total = count === 1
    ? 0
    : last.s + Math.hypot(first.x - last.x, first.y - last.y, first.z - last.z);
  const wrapped = wrap(s, 0, total);
  const spacing = total / count;
  const rawIndex = wrapped / spacing;
  const index = Math.min(count - 1, Math.max(0, Math.floor(rawIndex + 1e-9)) % count);
  const t = rawIndex - Math.floor(rawIndex + 1e-9);
  const a = samples[index];
  const b = samples[(index + 1) % count];
  return {
    index,
    t,
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    ty: a.ty + (b.ty - a.ty) * t,
    tz: a.tz + (b.tz - a.tz) * t,
    rx: a.rx + (b.rx - a.rx) * t,
    rz: a.rz + (b.rz - a.rz) * t,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
  };
}

/**
 * Rotate the sample list so index 0 lands on the straightest stretch of track.
 * That keeps the start/finish line on a straight no matter how the control
 * points were authored.
 */
export function rotateToStraightest(samples, lookahead = 10) {
  const count = samples.length;
  if (count === 0) return samples;
  let bestIndex = 0;
  let bestScore = Infinity;
  for (let i = 0; i < count; i += 1) {
    let score = 0;
    for (let k = -lookahead; k <= lookahead; k += 1) {
      const sample = samples[(i + k + count * 2) % count];
      score += Math.abs(sample.curvature) * (lookahead - Math.abs(k) + 1);
    }
    if (score < bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }
  return samples.slice(bestIndex).concat(samples.slice(0, bestIndex));
}

/** Heading (yaw) of a tangent in the car convention: forward = (sin(h), 0, cos(h)). */
export function headingOf(tx, tz) {
  return Math.atan2(tx, tz);
}

export { TAU };

/** Recompute `s` from zero after the sample list was rotated. */
export function rebaseArcLength(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i += 1) {
    samples[i].s = s;
    const next = samples[(i + 1) % samples.length];
    s += Math.hypot(next.x - samples[i].x, next.y - samples[i].y, next.z - samples[i].z);
  }
  return s;
}
