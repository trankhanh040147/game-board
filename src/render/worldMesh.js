/**
 * Track surface + world geometry assembly.
 *
 * Everything static is baked into three big meshes so the renderer only issues
 * three draw calls for the whole world:
 *
 *   road     — asphalt ribbon, kerbs, painted lines, start/finish chequer
 *   terrain  — verge, ground apron, cliff skirt, boundary lip, base plane
 *   scenery  — city blocks / canyon rock walls (from `props.js`), merged as-is
 *
 * The road follows the track samples exactly (position + height + right vector),
 * which means the simulation surface and the visible surface can never drift
 * apart. Paint sits 2 cm above the asphalt and kerbs 1 cm above it, so nothing
 * z-fights at grazing angles.
 *
 * Units are metres, +Y is up. Every quad is wound counter-clockwise from
 * outside; `quadFacing()` fixes the winding from an explicit normal so a curved
 * ribbon can never end up inside-out.
 */

import { createMeshBuilder } from '../core/mesh.js';
import { clamp, hexToRgb, mixRgb } from '../core/math.js';
import { createRng } from '../core/rng.js';
import { createCanyonScenery, createCityScenery } from './props.js';

/** Height of the paint above the asphalt (metres). */
const PAINT_LIFT = 0.02;
/** Height of the kerb above the asphalt (metres). */
const KERB_LIFT = 0.012;
/** Curvature above which a sample counts as "in a corner" (radius < 120 m). */
const CORNER_CURVATURE = 1 / 120;
/** Lateral width of the ground apron either side of the boundary. */
const APRON_WIDTH = 11;
/** Width of the raised verge between the boundary and the apron. */
const VERGE_WIDTH = 2.4;

/* --------------------------------------------------------------- colours -- */

function rgbOf(value, fallback) {
  if (Array.isArray(value) && value.length >= 3 && Number.isFinite(value[0])) {
    return [value[0], value[1], value[2]];
  }
  if (typeof value === 'string') return hexToRgb(value);
  return fallback;
}

/**
 * Palette colours are authored for the final look, but the night city asphalt is
 * almost black once the hemi ambient has been applied; a small lift keeps the
 * road surface readable without changing its hue. Kept as a single constant so
 * it is easy to tune.
 */
const ROAD_LIFT = 1.55;

/** Multiply an rgb triple, clamping to 0..1. */
function boostRgb(color, factor) {
  return [
    clamp(color[0] * factor, 0, 1),
    clamp(color[1] * factor, 0, 1),
    clamp(color[2] * factor, 0, 1),
  ];
}

function roadColors(palette = {}) {
  const road = palette.road ?? {};
  const lift = (rgb) => [
    clamp(rgb[0] * ROAD_LIFT, 0, 1),
    clamp(rgb[1] * ROAD_LIFT, 0, 1),
    clamp(rgb[2] * ROAD_LIFT, 0, 1),
  ];
  return {
    asphalt: lift(rgbOf(road.asphalt, [0.09, 0.09, 0.1])),
    asphaltAlt: lift(rgbOf(road.asphaltAlt, [0.11, 0.11, 0.12])),
    shoulder: lift(rgbOf(road.shoulder, [0.06, 0.06, 0.07])),
    line: rgbOf(road.line, [0.85, 0.86, 0.9]),
    kerbA: rgbOf(road.kerbA, [0.7, 0.12, 0.14]),
    kerbB: rgbOf(road.kerbB, [0.86, 0.88, 0.9]),
    paintEmissive: clamp(road.paintEmissive ?? 0.05, 0, 1),
    ground: rgbOf(palette.ground, [0.05, 0.05, 0.06]),
    groundAlt: rgbOf(palette.groundAlt, [0.07, 0.07, 0.08]),
    barrier: rgbOf(palette.props?.barrier, [0.12, 0.13, 0.16]),
  };
}

/* ----------------------------------------------------------- quad helpers -- */

function quadFacing(builder, corners, normal, color, emissive = 0) {
  const [a, b, c, d] = corners;
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const dot = nx * normal[0] + ny * normal[1] + nz * normal[2];
  const ordered = dot >= 0 ? corners : [a, d, c, b];
  builder.flatQuad(ordered[0], ordered[1], ordered[2], ordered[3], normal, color, emissive);
}

/** World position `lateral` metres from the centreline of a sample, lifted. */
function offsetPoint(sample, lateral, lift) {
  return {
    x: sample.x + sample.rx * lateral,
    y: sample.y + lift,
    z: sample.z + sample.rz * lateral,
  };
}

/**
 * Horizontal strip between two samples, spanning `inner`..`outer` metres from
 * the centreline on one side (`side` = -1 left, +1 right).
 */
function stripQuad(builder, a, b, side, inner, outer, lift, color, emissive = 0) {
  quadFacing(
    builder,
    [
      offsetPoint(a, side * inner, lift),
      offsetPoint(b, side * inner, lift),
      offsetPoint(b, side * outer, lift),
      offsetPoint(a, side * outer, lift),
    ],
    [0, 1, 0],
    color,
    emissive,
  );
}

/** Rows for `addRibbon` at a lateral offset band on one side of the road. */
function ribbonRows(samples, side, inner, outer, lift, step) {
  const rows = [];
  for (let i = 0; i < samples.length; i += step) {
    const sample = samples[i];
    const middle = side * (inner + outer) * 0.5;
    rows.push({
      x: sample.x + sample.rx * middle,
      y: sample.y + lift,
      z: sample.z + sample.rz * middle,
      rx: sample.rx,
      rz: sample.rz,
      halfWidth: (outer - inner) * 0.5,
    });
  }
  const first = rows[0];
  rows.push({ ...first });
  return rows;
}

/* ------------------------------------------------------------------- road -- */

/** Per-row asphalt colours, alternating in 24-40 m bands. */
function asphaltRowColors(samples, rng, colors) {
  const rowColors = [];
  let band = 0;
  let bandEnd = rng.range(24, 40);
  for (const sample of samples) {
    if (sample.s > bandEnd) {
      band += 1;
      bandEnd += rng.range(24, 40);
    }
    rowColors.push(band % 2 === 0 ? colors.asphalt : colors.asphaltAlt);
  }
  rowColors.push(rowColors[0]);
  return rowColors;
}

/** Road surface, kerbs, painted lines and the start/finish chequer strip. */
function buildRoadBatch(track, colors, rng) {
  const builder = createMeshBuilder();
  const samples = track.samples;
  const count = samples.length;
  const halfWidth = track.halfWidth;
  const kerbWidth = track.kerbWidth;

  /* --- asphalt --- */
  const roadRows = samples.map((sample) => ({
    x: sample.x,
    y: sample.y,
    z: sample.z,
    rx: sample.rx,
    rz: sample.rz,
    halfWidth,
  }));
  roadRows.push({ ...roadRows[0] });
  builder.addRibbon(roadRows, {
    color: colors.asphalt,
    rowColors: asphaltRowColors(samples, rng, colors),
  });

  /* --- kerbs (corners) / verge strip (straights) --- */
  for (let i = 0; i < count; i += 1) {
    const a = samples[i];
    const b = samples[(i + 1) % count];
    const inCorner =
      Math.abs(a.curvature) > CORNER_CURVATURE || Math.abs(b.curvature) > CORNER_CURVATURE;
    const stripe = Math.floor((a.s + b.s) * 0.5 / 3) % 2 === 0;
    const color = inCorner ? (stripe ? colors.kerbA : colors.kerbB) : colors.shoulder;
    const emissive = inCorner ? 0.04 : 0;
    for (const side of [-1, 1]) {
      stripQuad(
        builder, a, b, side,
        halfWidth, halfWidth + kerbWidth,
        KERB_LIFT, color, emissive,
      );
    }
  }

  /* --- white edge lines just inside the asphalt edge --- */
  for (let i = 0; i < count; i += 1) {
    const a = samples[i];
    const b = samples[(i + 1) % count];
    for (const side of [-1, 1]) {
      stripQuad(
        builder, a, b, side,
        halfWidth - 0.44, halfWidth - 0.26,
        PAINT_LIFT, colors.line, colors.paintEmissive,
      );
    }
  }

  /* --- dashed centre line: 3 m dash, 6 m gap --- */
  const dashLength = 3;
  const dashPeriod = 9;
  const centreWidth = 0.16;
  for (let s = 0; s < track.length; s += dashPeriod) {
    const start = track.pointAt(s);
    const end = track.pointAt(s + dashLength);
    const mx = (start.x + end.x) * 0.5;
    const mz = (start.z + end.z) * 0.5;
    const my = (start.y + end.y) * 0.5 + PAINT_LIFT;
    let fx = end.x - start.x;
    let fz = end.z - start.z;
    const length = Math.hypot(fx, fz) || dashLength;
    fx /= length;
    fz /= length;
    builder.addQuad(mx, my, mz, fz, -fx, fx, fz, centreWidth, length, {
      color: colors.line,
      emissive: colors.paintEmissive,
    });
  }

  /* --- chequered start/finish strip across the road --- */
  const start = track.pointAt(0);
  const squares = 16;
  const squareWidth = track.width / squares;
  const squareLength = 0.75;
  for (let row = 0; row < 2; row += 1) {
    for (let col = 0; col < squares; col += 1) {
      const lateral = -track.width * 0.5 + (col + 0.5) * squareWidth;
      const along = (row - 0.5) * squareLength;
      const x = start.x + start.rx * lateral + start.tx * along;
      const z = start.z + start.rz * lateral + start.tz * along;
      const light = (row + col) % 2 === 0;
      builder.addQuad(
        x, start.y + PAINT_LIFT, z,
        start.rx, start.rz, start.tx, start.tz,
        squareWidth, squareLength,
        {
          color: light ? [0.92, 0.93, 0.95] : [0.04, 0.04, 0.05],
          emissive: light ? 0.08 : 0,
        },
      );
    }
  }

  return builder.build();
}

/* --------------------------------------------------------- ground/terrain -- */

/**
 * Per-row outer edge of the ground apron.
 *
 * The apron is an offset curve of the centreline: on the inside of a tight
 * corner (Neon Bay has a 15.7 m radius hairpin) an offset wider than the radius
 * folds back over itself and produces inside-out, z-fighting quads. Clamping the
 * outer edge to a fraction of the local radius keeps the profile fold-free; the
 * result is smoothed so the apron edge does not visibly jump.
 */
function apronProfile(track, inner, apronEdge) {
  const samples = track.samples;
  const count = samples.length;
  const hard = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const curvature = Math.abs(samples[i].curvature);
    const radius = curvature > 1e-6 ? 1 / curvature : 1e6;
    hard[i] = clamp(radius * 0.85, inner + 0.6, apronEdge);
  }
  const limited = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let minimum = Infinity;
    for (let k = -3; k <= 3; k += 1) minimum = Math.min(minimum, hard[(i + k + count) % count]);
    limited[i] = minimum;
  }
  const smoothed = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    let sum = 0;
    for (let k = -4; k <= 4; k += 1) sum += limited[(i + k + count) % count];
    smoothed[i] = Math.min(sum / 9, limited[i]);
  }
  return smoothed;
}

/** Verge, ground apron, cliff skirt, boundary lip and the far base plane. */
function buildTerrainBatch(track, colors, planeY) {
  const builder = createMeshBuilder();
  // Night asphalt/pavement disappears once the hemi ambient is applied, so the
  // city ground gets a lift; the dusk canyon already has bright ground colours.
  const lift = track.theme === 'canyon' ? 1 : 2.2;
  const groundColor = boostRgb(colors.ground, lift * 1.15);
  const vergeColor = boostRgb(colors.groundAlt, lift);
  const basePlaneColor = boostRgb(mixRgb(colors.ground, colors.barrier, 0.25), lift);
  const samples = track.samples;
  const count = samples.length;
  const boundary = track.boundary;
  const step = 2; // 7 m rows are plenty for the terrain
  const apronEdge = boundary + APRON_WIDTH;
  const profile = apronProfile(track, boundary + VERGE_WIDTH, apronEdge);

  /* --- raised verge between the boundary and the apron --- */
  for (const side of [-1, 1]) {
    const rows = ribbonRows(samples, side, boundary, boundary + VERGE_WIDTH, 0.05, step);
    builder.addRibbon(rows, { color: vergeColor });
  }

  /* --- wide ground apron (outer edge follows the fold-free profile) --- */
  for (const side of [-1, 1]) {
    const inner = boundary + VERGE_WIDTH;
    const rows = [];
    for (let i = 0; i < count; i += step) {
      const sample = samples[i];
      const outer = Math.max(inner + 0.6, profile[i]);
      const middle = side * (inner + outer) * 0.5;
      rows.push({
        x: sample.x + sample.rx * middle,
        y: sample.y - 0.04,
        z: sample.z + sample.rz * middle,
        rx: sample.rx,
        rz: sample.rz,
        halfWidth: (outer - inner) * 0.5,
      });
    }
    rows.push({ ...rows[0] });
    builder.addRibbon(rows, { color: groundColor });
  }

  /* --- cliff skirt dropping from the apron edge to the base plane --- */
  for (const side of [-1, 1]) {
    const inner = boundary + VERGE_WIDTH;
    for (let i = 0; i < count; i += step) {
      const a = samples[i];
      const b = samples[(i + step) % count];
      const outerA = side * Math.max(inner + 0.6, profile[i]);
      const outerB = side * Math.max(inner + 0.6, profile[(i + step) % count]);
      quadFacing(
        builder,
        [
          { x: a.x + a.rx * outerA, y: a.y - 0.04, z: a.z + a.rz * outerA },
          { x: b.x + b.rx * outerB, y: b.y - 0.04, z: b.z + b.rz * outerB },
          { x: b.x + b.rx * outerB, y: planeY, z: b.z + b.rz * outerB },
          { x: a.x + a.rx * outerA, y: planeY, z: a.z + a.rz * outerA },
        ],
        [side * a.rx, 0, side * a.rz],
        groundColor,
        0,
      );
    }
  }

  /* --- low concrete lip right on the boundary line --- */
  const lipWidth = 0.24;
  const lipHeight = 0.24;
  for (let i = 0; i < count; i += 1) {
    const a = samples[i];
    const b = samples[(i + 1) % count];
    for (const side of [-1, 1]) {
      // Top surface.
      stripQuad(
        builder, a, b, side,
        boundary - lipWidth, boundary + lipWidth,
        lipHeight, colors.barrier, 0,
      );
      // Face pointing back at the road.
      quadFacing(
        builder,
        [
          offsetPoint(a, side * (boundary - lipWidth), 0),
          offsetPoint(b, side * (boundary - lipWidth), 0),
          offsetPoint(b, side * (boundary - lipWidth), lipHeight),
          offsetPoint(a, side * (boundary - lipWidth), lipHeight),
        ],
        [-side * a.rx, 0, -side * a.rz],
        colors.barrier,
        0,
      );
    }
  }

  /* --- base plane far below everything (kills any hole in the silhouette) --- */
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
  const cx = (minX + maxX) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  const size = Math.max(maxX - minX, maxZ - minZ) + 900;
  builder.addQuad(cx, planeY, cz, 1, 0, 0, 1, size, size, {
    color: basePlaneColor,
    emissive: 0,
  });

  return builder.build();
}

/* --------------------------------------------------------------- minimap -- */

/** ~96 centreline points for the HUD minimap. */
function buildMinimap(track) {
  const samples = track.samples;
  const count = samples.length;
  const points = clamp(Math.round(count / Math.max(1, Math.round(count / 96))), 48, 120);
  const stride = Math.max(1, Math.floor(count / points));
  const outline = [];
  for (let i = 0; i < count; i += stride) {
    outline.push([samples[i].x, samples[i].z]);
  }
  return outline;
}

/* ------------------------------------------------------------------ main -- */

/**
 * Build all static geometry for one track.
 *
 * @param {{track: object, palette?: object, seed?: number}} params
 * @returns {{
 *   batches: Array<{mesh: object, name: string}>,
 *   lamps: Array<{x:number,y:number,z:number,color:number[],size:number}>,
 *   minimap: Array<[number, number]>,
 *   triangles: number,
 * }}
 */
export function buildTrackMeshes({ track, palette, seed = 1 } = {}) {
  const resolvedPalette = palette ?? track.palette ?? {};
  const colors = roadColors(resolvedPalette);
  const rng = createRng((seed ^ 0x6d2b79f5) >>> 0);

  const roadMesh = buildRoadBatch(track, colors, rng);

  let planeY = Infinity;
  for (const sample of track.samples) planeY = Math.min(planeY, sample.y);
  planeY -= track.theme === 'canyon' ? 10 : 1.2;

  const terrainMesh = buildTerrainBatch(track, colors, planeY);

  const scenery = track.theme === 'canyon'
    ? createCanyonScenery({ track, palette: resolvedPalette, seed })
    : createCityScenery({ track, palette: resolvedPalette, seed });

  const batches = [
    { mesh: roadMesh, name: 'road' },
    { mesh: terrainMesh, name: 'terrain' },
    { mesh: scenery.mesh, name: 'scenery' },
  ];
  const triangles = batches.reduce((total, batch) => total + batch.mesh.triangleCount, 0);

  return {
    batches,
    lamps: scenery.lamps,
    minimap: buildMinimap(track),
    triangles,
  };
}
