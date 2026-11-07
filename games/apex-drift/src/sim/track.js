/**
 * Track geometry + the surface query the car simulation leans on.
 *
 * `buildTrack` turns a hand-authored control-point loop into uniformly spaced
 * samples (position, tangent, right vector, curvature) and wraps them in a
 * `query(x, z, hint)` helper that answers "where am I on the road?" in constant
 * time. Cars call it several times per physics step, so the query uses the
 * previous sample index as a hint and only falls back to a full scan when the
 * car teleports.
 */

import { clamp, wrap } from '../core/math.js';
import {
  loopLength,
  rebaseArcLength,
  rotateToStraightest,
  sampleAt as splineSampleAt,
  sampleClosedSpline,
} from './spline.js';

/** Default ring width used for the start/finish gantry and checkpoints. */
const SURFACE_EPSILON = 1e-6;

/**
 * @typedef {{
 *   id:string, name:string,
 *   width:number, halfWidth:number, shoulderWidth:number, kerbWidth:number,
 *   boundary:number, length:number, sampleCount:number,
 *   samples: import('./spline.js').Sample[],
 *   startLine: {s:number,x:number,y:number,z:number,tx:number,tz:number,heading:number},
 *   trackDef: object,
 *   query: (x:number, z:number, hintIndex?:number) => TrackQuery,
 *   sampleAt: (s:number) => object,
 *   pointAt: (s:number) => {x:number,y:number,z:number,tx:number,tz:number,rx:number,rz:number},
 * }} Track
 */

/**
 * @typedef {{
 *   index:number, t:number, s:number, lateral:number,
 *   x:number, y:number, z:number,
 *   tx:number, ty:number, tz:number, rx:number, rz:number,
 *   curvature:number, surface:'road'|'kerb'|'grass',
 *   onTrack:boolean, onShoulder:boolean, distance:number,
 * }} TrackQuery
 */

function projectOnSegment(a, b, x, z) {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const lengthSquared = abx * abx + abz * abz;
  const t = lengthSquared > SURFACE_EPSILON
    ? clamp(((x - a.x) * abx + (z - a.z) * abz) / lengthSquared, 0, 1)
    : 0;
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  const dx = x - px;
  const dz = z - pz;
  return {
    t,
    px,
    pz,
    py: a.y + (b.y - a.y) * t,
    rx: a.rx + (b.rx - a.rx) * t,
    rz: a.rz + (b.rz - a.rz) * t,
    tx: a.tx + (b.tx - a.tx) * t,
    ty: a.ty + (b.ty - a.ty) * t,
    tz: a.tz + (b.tz - a.tz) * t,
    curvature: a.curvature + (b.curvature - a.curvature) * t,
    distanceSquared: dx * dx + dz * dz,
    startS: a.s,
    // Arc length uses the full 3D segment so `s` stays in sync with the spline
    // samples on elevation changes (the canyon climbs 24 m).
    segmentLength: Math.hypot(abx, b.y - a.y, abz),
  };
}

/** Choose the straightest stretch for the start/finish line and rebuild arc length. */
function prepareSamples(def) {
  const spacing = def.sampleSpacing ?? 3.5;
  const samples = sampleClosedSpline(def.points, { spacing });
  const rotated = rotateToStraightest(samples, 8);
  rebaseArcLength(rotated);
  return rotated;
}

/**
 * Build a track from its definition.
 * @param {{id:string, name:string, width:number, points:{x:number,y:number,z:number}[],
 *          shoulderWidth?:number, kerbWidth?:number}} def
 * @returns {Track}
 */
export function buildTrack(def) {
  const width = def.width ?? 15;
  const halfWidth = width / 2;
  const shoulderWidth = def.shoulderWidth ?? 2.5;
  const kerbWidth = def.kerbWidth ?? 1.4;
  const boundary = halfWidth + kerbWidth + shoulderWidth;
  const samples = prepareSamples(def);
  const length = loopLength(samples);
  const count = samples.length;
  const spacing = length / count;

  const first = samples[0];
  const startLine = {
    s: 0,
    x: first.x,
    y: first.y,
    z: first.z,
    tx: first.tx,
    tz: first.tz,
    heading: Math.atan2(first.tx, first.tz),
  };

  function globalScan(x, z) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i += 1) {
      const sample = samples[i];
      const dx = x - sample.x;
      const dz = z - sample.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    return { index: bestIndex, distance: Math.sqrt(bestDistance) };
  }

  /**
   * Nearest sample search.
   *
   * A hint window alone is not enough: on a paperclip layout two legs can pass
   * within 300 m of each other, so a local window can latch onto the wrong leg
   * when the car is teleported. We scan a decimated set of every third sample
   * (cheap), then refine around the winner with a window wider than the
   * decimation step. `hintIndex` is accepted for API compatibility and used as a
   * tie-break-free fast path only when it is already the decimated winner.
   */
  function nearestIndex(x, z, hintIndex) {
    const stride = 3;
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < count; i += stride) {
      const sample = samples[i];
      const dx = x - sample.x;
      const dz = z - sample.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = i;
      }
    }
    if (Number.isInteger(hintIndex) && hintIndex >= 0 && hintIndex < count) {
      const sample = samples[hintIndex];
      const dx = x - sample.x;
      const dz = z - sample.z;
      const distance = dx * dx + dz * dz;
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = hintIndex;
      }
    }
    const refine = 6;
    let refinedIndex = bestIndex;
    let refinedDistance = Infinity;
    for (let k = -refine; k <= refine; k += 1) {
      const i = (bestIndex + k + count) % count;
      const sample = samples[i];
      const dx = x - sample.x;
      const dz = z - sample.z;
      const distance = dx * dx + dz * dz;
      if (distance < refinedDistance) {
        refinedDistance = distance;
        refinedIndex = i;
      }
    }
    return { index: refinedIndex, distance: Math.sqrt(refinedDistance) };
  }

  function query(x, z, hintIndex) {
    const nearest = nearestIndex(x, z, hintIndex);
    const previousIndex = (nearest.index - 1 + count) % count;
    const nextIndex = nearest.index;
    const candidates = [
      { ...projectOnSegment(samples[previousIndex], samples[nextIndex], x, z), startIndex: previousIndex },
      {
        ...projectOnSegment(samples[nextIndex], samples[(nextIndex + 1) % count], x, z),
        startIndex: nextIndex,
      },
    ];
    let best = candidates[0];
    if (candidates[1].distanceSquared < best.distanceSquared) best = candidates[1];

    const dx = x - best.px;
    const dz = z - best.pz;
    const lateral = dx * best.rx + dz * best.rz;
    const absoluteLateral = Math.abs(lateral);
    let surface = 'road';
    let onTrack = true;
    if (absoluteLateral > halfWidth + kerbWidth + shoulderWidth) {
      surface = 'grass';
      onTrack = false;
    } else if (absoluteLateral > halfWidth + kerbWidth) {
      surface = 'grass';
      onTrack = false;
    } else if (absoluteLateral > halfWidth) {
      surface = 'kerb';
    }

    let s = best.startS + best.t * best.segmentLength;
    if (s >= length) s -= length;

    return {
      index: best.startIndex,
      t: best.t,
      s,
      lateral,
      x: best.px,
      y: best.py,
      z: best.pz,
      tx: best.tx,
      ty: best.ty,
      tz: best.tz,
      rx: best.rx,
      rz: best.rz,
      curvature: best.curvature,
      surface,
      onTrack,
      onShoulder: absoluteLateral <= boundary,
      distance: Math.sqrt(best.distanceSquared),
    };
  }

  function pointAt(s) {
    const sample = splineSampleAt(samples, s);
    return {
      x: sample.x,
      y: sample.y,
      z: sample.z,
      tx: sample.tx,
      ty: sample.ty,
      tz: sample.tz,
      rx: sample.rx,
      rz: sample.rz,
      curvature: sample.curvature,
      heading: Math.atan2(sample.tx, sample.tz),
    };
  }

  function sampleAt(s) {
    return splineSampleAt(samples, s);
  }

  /** World transform for a grid slot behind the start line. */
  function gridTransform(back, lateral) {
    const s = wrap(0 - back, 0, length);
    const point = pointAt(s);
    return {
      x: point.x + point.rx * lateral,
      y: point.y,
      z: point.z + point.rz * lateral,
      heading: point.heading,
      s,
    };
  }

  /** Interpolated curvature over the next `metres` of road (AI corner braking). */
  function curvatureAhead(s, metres) {
    const total = Math.max(0, metres);
    const steps = Math.max(1, Math.round(total / spacing));
    let worst = 0;
    for (let i = 0; i <= steps; i += 1) {
      const sample = sampleAt(s + (i * total) / steps);
      if (Math.abs(sample.curvature) > Math.abs(worst)) worst = sample.curvature;
    }
    return worst;
  }

  const track = {
    id: def.id,
    name: def.name,
    width,
    halfWidth,
    shoulderWidth,
    kerbWidth,
    boundary,
    length,
    spacing,
    sampleCount: count,
    samples,
    startLine,
    trackDef: def,
    palette: def.palette,
    theme: def.theme ?? 'city',
    gridTransform,
    curvatureAhead,
    pointAt,
    query,
    sampleAt,
  };
  return track;
}

/** Convenience: distance around the loop between two arc-length positions. */
export function deltaS(track, fromS, toS) {
  const length = track.length;
  return (((toS - fromS) % length) + length) % length;
}

/** Grid slot for a car index, given the road width. */
export function gridSlot(track, index, rowGap = 9, laneOffsetRatio = 0.18) {
  const row = Math.floor(index / 2);
  const side = index % 2 === 0 ? -1 : 1;
  return track.gridTransform(6 + row * rowGap, side * track.width * laneOffsetRatio);
}
