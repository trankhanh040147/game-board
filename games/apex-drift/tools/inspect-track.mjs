#!/usr/bin/env node
/**
 * Track inspector: prints shape statistics and an ASCII minimap for every track.
 *
 *   node tools/inspect-track.mjs
 *   node tools/inspect-track.mjs neon-bay
 *
 * Useful when hand-tuning control points: it catches self-intersections, tight
 * corners and overly long straights before they show up in the game.
 */

import { TRACK_DEFS, TRACK_ORDER } from '../src/sim/config.js';
import { buildTrack } from '../src/sim/track.js';

const requested = process.argv.slice(2);
const ids = requested.length ? requested : TRACK_ORDER;

function diamonds(minCurvatureRadius) {
  return Math.max(0, Math.round(60 / minCurvatureRadius));
}

function asciiMap(track, width = 96, height = 40) {
  const { samples } = track;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const sample of samples) {
    minX = Math.min(minX, sample.x);
    maxX = Math.max(maxX, sample.x);
    minZ = Math.min(minZ, sample.z);
    maxZ = Math.max(maxZ, sample.z);
  }
  const pad = 12;
  minX -= pad;
  maxX += pad;
  minZ -= pad;
  maxZ += pad;
  const grid = Array.from({ length: height }, () => new Array(width).fill(' '));
  const toCell = (x, z) => {
    const cx = Math.round(((x - minX) / (maxX - minX)) * (width - 1));
    const cy = Math.round(((z - minZ) / (maxZ - minZ)) * (height - 1));
    return [Math.min(width - 1, Math.max(0, cx)), Math.min(height - 1, Math.max(0, cy))];
  };
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i];
    const [cx, cy] = toCell(sample.x, sample.z);
    const sharp = Math.abs(sample.curvature) > 1 / 45;
    grid[cy][cx] = sharp ? '#' : '.';
  }
  // Start/finish marker.
  const [sx, sy] = toCell(track.startLine.x, track.startLine.z);
  grid[sy][sx] = 'S';
  return grid.map((row) => row.join('')).join('\n');
}

for (const id of ids) {
  const def = TRACK_DEFS[id];
  if (!def) {
    console.error(`unknown track: ${id}`);
    process.exitCode = 1;
    continue;
  }
  const track = buildTrack(def);
  let minRadius = Infinity;
  let minRadiusAt = 0;
  let tightCorners = 0;
  let elevationMin = Infinity;
  let elevationMax = -Infinity;
  for (let i = 0; i < track.samples.length; i += 1) {
    const sample = track.samples[i];
    elevationMin = Math.min(elevationMin, sample.y);
    elevationMax = Math.max(elevationMax, sample.y);
    const curvature = Math.abs(sample.curvature);
    if (curvature > 1e-4) {
      const radius = 1 / curvature;
      if (radius < minRadius) {
        minRadius = radius;
        minRadiusAt = sample.s;
      }
      if (radius < 40) tightCorners += 1;
    }
  }

  // Minimum clearance between non-neighbouring parts of the loop.
  let minClearance = Infinity;
  let clearanceIndex = [0, 0];
  const stride = 2;
  for (let i = 0; i < track.samples.length; i += stride) {
    for (let j = i + stride; j < track.samples.length; j += stride) {
      const gap = Math.min(
        Math.abs(i - j),
        track.samples.length - Math.abs(i - j),
      );
      if (gap * track.spacing < 90) continue;
      const a = track.samples[i];
      const b = track.samples[j];
      const distance = Math.hypot(a.x - b.x, a.z - b.z);
      if (distance < minClearance) {
        minClearance = distance;
        clearanceIndex = [i, j];
      }
    }
  }

  console.log(`\n=== ${track.name} (${id}) ===`);
  console.log(`length          ${track.length.toFixed(1)} m`);
  console.log(`samples         ${track.sampleCount} @ ${track.spacing.toFixed(2)} m`);
  console.log(`width           ${track.width} m (boundary ${track.boundary.toFixed(1)} m)`);
  console.log(`elevation       ${elevationMin.toFixed(1)} .. ${elevationMax.toFixed(1)} m`);
  console.log(`tightest radius ${minRadius.toFixed(1)} m at s=${minRadiusAt.toFixed(0)}`);
  console.log(`corner samples  ${tightCorners} (<40 m radius)`);
  console.log(`min clearance   ${minClearance.toFixed(1)} m between sample ${clearanceIndex[0]} and ${clearanceIndex[1]}`);
  if (minClearance < track.boundary * 2 + 8) {
    console.log('!! WARNING: parts of the track are too close together');
  }
  console.log(asciiMap(track));
}
