/**
 * Procedural scenery: the city blocks of Neon Bay and the rock walls of Sunset
 * Canyon.
 *
 * Both generators are pure functions of `(track, palette, seed)`: they sample the
 * track's centreline frames, place props in *road-local* coordinates (lateral
 * offset along the track right vector, `along` offset along the tangent) and emit
 * one merged mesh plus a list of additive glow billboards.
 *
 * Rules baked into the placement helpers:
 *  - Nothing is placed on the drivable surface. Buildings, rocks and trees start
 *    at `|lateral| >= track.boundary + 2` (with extra clearance on curves so a
 *    yawed box can never swing onto the racing line); street lamps, guard posts
 *    and rails sit on the boundary line, and the start/finish gantry spans the
 *    road *above* the cars (8 m clearance).
 *  - No tall props within ~45 m of the start line: the title screen orbits the
 *    start line at 32 m radius and would otherwise fly through a building.
 *  - Every box gets a baked vertical gradient (fake AO): rock and prop bases
 *    darken towards the ground while city blocks take a little street-level
 *    bounce light at the bottom. Two vertex rows per face is enough to stop the
 *    scenery reading as flat cardboard.
 *  - Deterministic: all randomness comes from `createRng(seed)`; there is no
 *    `Math.random` and the module is safe to import from Node.
 */

import { createMeshBuilder } from '../core/mesh.js';
import { clamp, hexToRgb, lerp } from '../core/math.js';
import { createRng } from '../core/rng.js';

/* --------------------------------------------------------------- colours -- */

/** Accept `[r,g,b]` (config palette) or a `#rrggbb` string. */
function rgbOf(value, fallback) {
  if (Array.isArray(value) && value.length >= 3 && Number.isFinite(value[0])) {
    return [value[0], value[1], value[2]];
  }
  if (typeof value === 'string') return hexToRgb(value);
  return fallback;
}

/** Normalise a config palette into the handful of colours scenery needs. */
function sceneryColors(palette = {}) {
  const props = palette.props ?? {};
  const road = palette.road ?? {};
  return {
    buildingBase: rgbOf(props.buildingBase, [0.07, 0.075, 0.1]),
    buildingAlt: rgbOf(props.buildingAlt, [0.09, 0.1, 0.13]),
    window: rgbOf(props.window, [0.55, 0.75, 1]),
    windowWarm: rgbOf(props.windowWarm, [1, 0.78, 0.42]),
    neonA: rgbOf(props.neonA, [0.15, 0.95, 1]),
    neonB: rgbOf(props.neonB, [1, 0.2, 0.7]),
    neonC: rgbOf(props.neonC, [1, 0.85, 0.25]),
    barrier: rgbOf(props.barrier, [0.12, 0.13, 0.16]),
    rail: rgbOf(props.rail, [0.42, 0.46, 0.52]),
    plantA: rgbOf(props.plantA, [0.07, 0.12, 0.1]),
    plantB: rgbOf(props.plantB, [0.05, 0.09, 0.08]),
    rockA: rgbOf(props.rockA, [0.11, 0.1, 0.11]),
    rockB: rgbOf(props.rockB, [0.08, 0.08, 0.09]),
    pillar: rgbOf(props.pillar, [0.14, 0.15, 0.18]),
    lamp: rgbOf(palette.lamps?.color, [1, 0.8, 0.5]),
    ground: rgbOf(palette.ground, [0.05, 0.05, 0.06]),
    shoulder: rgbOf(road.shoulder, [0.06, 0.06, 0.07]),
  };
}

/* ----------------------------------------------------------- mesh helpers -- */

/** Box faces as corner triples in local space, counter-clockwise from outside. */
const BOX_FACES = [
  { n: [1, 0, 0], c: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { n: [-1, 0, 0], c: [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]] },
  { n: [0, 1, 0], c: [[-1, 1, -1], [-1, 1, 1], [1, 1, 1], [1, 1, -1]] },
  { n: [0, -1, 0], c: [[-1, -1, 1], [-1, -1, -1], [1, -1, -1], [1, -1, 1]] },
  { n: [0, 0, 1], c: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
  { n: [0, 0, -1], c: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];

function rotateY(x, z, yaw) {
  if (!yaw) return [x, z];
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  return [c * x + s * z, -s * x + c * z];
}

/**
 * Yaw-aligned box with a baked vertical shading gradient (cheap fake AO).
 * `sx` runs along the road's right vector, `sz` along its tangent.
 *
 * @param {object} builder mesh builder
 * @param {number} cx @param {number} cy centre height @param {number} cz
 * @param {number} sx @param {number} sy @param {number} sz
 * @param {number} yaw yaw that aligns local +X with the road right vector
 * @param {number[]} color base rgb
 * @param {{bottomShade?:number, topShade?:number, emissive?:number,
 *   emissiveTop?:number, topColor?:number[]}} [opts]
 */
function addShadedBox(builder, cx, cy, cz, sx, sy, sz, yaw, color, opts = {}) {
  const bottomShade = opts.bottomShade ?? 0.5;
  const topShade = opts.topShade ?? 1.05;
  const emissive = opts.emissive ?? 0;
  const topColor = opts.topColor ?? null;
  const topEmissive = opts.emissiveTop ?? emissive;
  const hx = sx / 2;
  const hy = sy / 2;
  const hz = sz / 2;
  const cos = Math.cos(yaw);
  const sin = Math.sin(yaw);

  for (const face of BOX_FACES) {
    const isTop = face.n[1] === 1;
    const [fnx0, fnz0] = rotateY(face.n[0], face.n[2], yaw);
    const indices = [];
    for (const corner of face.c) {
      const lx = corner[0] * hx;
      const ly = corner[1] * hy;
      const lz = corner[2] * hz;
      const wx = cx + cos * lx + sin * lz;
      const wy = cy + ly;
      const wz = cz - sin * lx + cos * lz;
      const heightT = (corner[1] + 1) * 0.5;
      const shade = lerp(bottomShade, isTop ? topShade : 1, heightT);
      const base = isTop && topColor ? topColor : color;
      const e = isTop ? topEmissive : emissive;
      indices.push(
        builder.pushVertex(
          wx, wy, wz, fnx0, face.n[1], fnz0,
          clamp(base[0] * shade, 0, 1),
          clamp(base[1] * shade, 0, 1),
          clamp(base[2] * shade, 0, 1),
          e,
        ),
      );
    }
    builder.quad(indices[0], indices[1], indices[2], indices[3]);
  }
  return builder;
}

/** Cross-product normal of a triangle, normalised. */
function faceNormal(a, b, c) {
  const ux = b.x - a.x;
  const uy = b.y - a.y;
  const uz = b.z - a.z;
  const vx = c.x - a.x;
  const vy = c.y - a.y;
  const vz = c.z - a.z;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

/**
 * Quad from four corners in any cyclic order; winding is flipped when needed so
 * the face points along `normal`.
 */
function quadFacing(builder, corners, normal, color, emissive = 0) {
  const [a, b, c, d] = corners;
  const n = faceNormal(a, b, c);
  const dot = n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2];
  const ordered = dot >= 0 ? corners : [a, d, c, b];
  builder.flatQuad(ordered[0], ordered[1], ordered[2], ordered[3], normal, color, emissive);
}

/* ------------------------------------------------------------- road frames -- */

/**
 * Build a road-local placement frame from one spline sample.
 * @param {object} sample entry of `track.samples`
 */
function frameOf(sample) {
  return {
    x: sample.x,
    y: sample.y,
    z: sample.z,
    rx: sample.rx,
    rz: sample.rz,
    tx: sample.tx,
    tz: sample.tz,
    heading: Math.atan2(sample.tx, sample.tz),
    curvature: sample.curvature,
    s: sample.s,
  };
}

/** World position `lateral` metres right of the centreline and `along` metres ahead. */
function place(frame, lateral, along = 0, lift = 0) {
  return {
    x: frame.x + frame.rx * lateral + frame.tx * along,
    y: frame.y + lift,
    z: frame.z + frame.rz * lateral + frame.tz * along,
  };
}

/** Unit XZ normal pointing from `lateral` back towards the road. */
function inwardNormal(frame, side) {
  return [-side * frame.rx, 0, -side * frame.rz];
}

/**
 * Flat quad lying in the plane `along = const`, spanning `lateral` and `y`.
 * Used for the faces of the start/finish banner that span the road.
 */
function bannerQuad(builder, frame, along, lat0, lat1, y0, y1, normal, color, emissive = 0) {
  const p = (lateral, y) => ({
    x: frame.x + frame.rx * lateral + frame.tx * along,
    y,
    z: frame.z + frame.rz * lateral + frame.tz * along,
  });
  quadFacing(
    builder,
    [p(lat0, y0), p(lat1, y0), p(lat1, y1), p(lat0, y1)],
    normal,
    color,
    emissive,
  );
}

/**
 * Flat quad lying in the plane `lateral = const`, spanning `along` and `y`.
 */
function facadeQuad(builder, frame, lateral, along0, along1, y0, y1, normal, color, emissive = 0) {
  const p = (along, y) => ({
    x: frame.x + frame.rx * lateral + frame.tx * along,
    y,
    z: frame.z + frame.rz * lateral + frame.tz * along,
  });
  quadFacing(
    builder,
    [p(along0, y0), p(along1, y0), p(along1, y1), p(along0, y1)],
    normal,
    color,
    emissive,
  );
}

/* ------------------------------------------------------------------- city -- */

/** Scale an rgb triple (keeps palette hue, lifts the very dark city greys). */
function boost(color, factor) {
  return [clamp(color[0] * factor, 0, 1), clamp(color[1] * factor, 0, 1), clamp(color[2] * factor, 0, 1)];
}

/** Emissive window band wrapping all four faces of a building block. */
function addWindowBand(builder, centre, yaw, sx, sz, y, color, emissive) {
  addShadedBox(builder, centre.x, y, centre.z, sx + 0.16, 0.72, sz + 0.16, yaw, color, {
    bottomShade: 0.95,
    topShade: 0.7,
    emissive,
    emissiveTop: 0,
    topColor: [0.03, 0.03, 0.04],
  });
}

/** One city building: body, lit window bands, roof details and maybe a neon sign. */
function addCityBuilding(builder, lamps, frame, side, rng, colors, options = {}) {
  const boundary = options.boundary ?? 11;
  const setback = boundary + 3.0 + (options.setback ?? rng.range(0, 5));
  const width = rng.range(9, 16);
  const depth = rng.range(8, 16);
  const tall = options.tall ?? false;
  const simple = options.simple ?? false;
  const height = tall ? rng.range(34, 74) : rng.range(6, 24) * (rng.chance(0.16) ? 1.8 : 1);
  const baseY = frame.y - (options.rootDepth ?? 4);
  // On a curve a wide box oriented to the tangent swings towards the road; push
  // it out by the chord sagitta so nothing ever intrudes on the racing line.
  // Chord sagitta + a safety margin: a yawed box on a tight curve swings its
  // near corners towards the road.
  const sagitta = (width * width * Math.abs(frame.curvature)) / 5;
  const clearance = setback + sagitta + depth / 2;
  const centreLateral = side * clearance;
  const centre = place(frame, centreLateral);
  const cy = baseY + height / 2;
  const color = boost(rng.chance(0.5) ? colors.buildingBase : colors.buildingAlt, 2.0);

  addShadedBox(builder, centre.x, cy, centre.z, depth, height, width, frame.heading, color, {
    bottomShade: 1.5,
    topShade: 0.5,
  });

  const facadeLateral = side * (setback + sagitta - 0.06);
  const along0 = -width / 2;
  const along1 = width / 2;
  const topY = baseY + height;
  const bandColor = rng.chance(0.42) ? colors.windowWarm : colors.window;

  if (simple) {
    const floors = clamp(Math.floor((height - 3) / 3.6), 2, 7);
    const spacing = (height - 5) / floors;
    for (let floor = 0; floor < floors; floor += 1) {
      if (rng.chance(0.22)) continue;
      addWindowBand(
        builder, centre, frame.heading, depth, width,
        baseY + 3.5 + floor * spacing, bandColor, rng.range(0.4, 0.8),
      );
    }
  } else if (tall) {
    // Skyscraper: dense stack of lit floors plus a glowing crown.
    const bands = clamp(Math.floor(height / 3.6), 8, 20);
    for (let band = 0; band < bands; band += 1) {
      if (rng.chance(0.18)) continue;
      const y = baseY + 3 + (band + 0.5) * ((height - 5) / bands);
      const tint = rng.chance(0.3) ? colors.windowWarm : bandColor;
      addWindowBand(builder, centre, frame.heading, depth, width, y, tint, rng.range(0.45, 0.85));
    }
    addShadedBox(
      builder, centre.x, topY + 0.5, centre.z, depth * 0.9, 1, width * 0.9,
      frame.heading, colors.window, { emissive: 0.8, bottomShade: 0.9, topShade: 1 },
    );
    // Antenna mast with a red aviation beacon.
    builder.addCylinder(centre.x, topY + 1, centre.z, 0.12, 0.05, 5.5, {
      color: colors.pillar,
      segments: 5,
    });
    lamps.push({
      x: centre.x, y: topY + 6.6, z: centre.z,
      color: [1, 0.12, 0.16], size: 1.1,
    });
  } else {
    // Low block: a few lit floors, a shop front, a parapet and rooftop clutter.
    const floors = clamp(Math.floor((height - 3) / 3.4), 1, 6);
    const spacing = (height - 4.5) / Math.max(1, floors);
    for (let floor = 0; floor < floors; floor += 1) {
      if (rng.chance(0.16)) continue;
      const y = baseY + 3.1 + floor * spacing;
      const tint = rng.chance(0.35) ? colors.windowWarm : bandColor;
      addWindowBand(builder, centre, frame.heading, depth, width, y, tint, rng.range(0.45, 0.9));
    }
    // Street-level shop front glow on the road-facing facade.
    const shopColor = rng.chance(0.5) ? colors.windowWarm : colors.window;
    facadeQuad(
      builder, frame, facadeLateral,
      along0 + 1.2, along0 + 1.2 + rng.range(3, Math.max(3.5, width - 2.4)),
      baseY + 0.8, baseY + 2.2,
      inwardNormal(frame, side), shopColor, rng.range(0.4, 0.75),
    );
    // Cornice light ring, parapet lip, AC box and a lit roof edge.
    addShadedBox(
      builder, centre.x, topY - 0.15, centre.z, depth + 0.14, 0.26, width + 0.14,
      frame.heading, bandColor,
      { emissive: 0.3, bottomShade: 1, topShade: 0.6, emissiveTop: 0, topColor: [0.03, 0.03, 0.04] },
    );
    addShadedBox(
      builder, centre.x, topY + 0.35, centre.z, depth * 0.96, 0.7, width * 0.96,
      frame.heading, colors.barrier, { bottomShade: 0.8, topShade: 1 },
    );
    addShadedBox(
      builder,
      centre.x + frame.rx * rng.sym(1.5),
      topY + 1.2,
      centre.z + frame.rz * rng.sym(1.5),
      depth * rng.range(0.2, 0.4),
      1.4,
      width * rng.range(0.2, 0.4),
      frame.heading,
      colors.barrier,
      { bottomShade: 0.7, topShade: 1 },
    );
    facadeQuad(
      builder, frame, facadeLateral,
      along0 + 0.6, along1 - 0.6, topY - 0.7, topY - 0.2,
      inwardNormal(frame, side), colors.window, 0.3,
    );
  }

  // Neon sign slab hanging over the pavement.
  if (!tall && rng.chance(0.3)) {
    const signColor = rng.pick([colors.neonA, colors.neonB, colors.neonC]);
    const signH = rng.range(2.2, 5.5);
    const signW = rng.range(0.9, 2.2);
    const signY = baseY + rng.range(4, Math.max(6, height - 3));
    const signLateral = side * (setback + sagitta - 0.45);
    const along = rng.range(along0 + signW, along1 - signW);
    const signPos = place(frame, signLateral, along);
    addShadedBox(
      builder, signPos.x, signY, signPos.z, 0.5, signH, signW,
      frame.heading, signColor, { emissive: 0.95, bottomShade: 0.85, topShade: 1 },
    );
    const glow = place(frame, side * (setback + sagitta - 1.1), along);
    lamps.push({ x: glow.x, y: signY, z: glow.z, color: signColor, size: rng.range(2.2, 3.6) });
  }

  return { height, topY };
}

/** Street lamp with post, arm and emissive head; also registers its glow. */
function addStreetLamp(builder, lamps, frame, side, colors, opts = {}) {
  const boundary = opts.boundary ?? 11;
  const baseY = frame.y;
  const postHeight = opts.height ?? 8.4;
  const lateral = side * (boundary + 0.16);
  const post = place(frame, lateral);
  addShadedBox(
    builder, post.x, baseY + postHeight / 2, post.z,
    0.3, postHeight, 0.3, frame.heading, boost(colors.pillar, 1.7),
    { bottomShade: 1.1, topShade: 0.7 },
  );
  // Arm reaching over the road.
  const armLateral = side * (boundary - postHeight * 0.11);
  const arm = place(frame, armLateral);
  addShadedBox(
    builder, arm.x, baseY + postHeight - 0.18, arm.z,
    postHeight * 0.3, 0.16, 0.24, frame.heading, boost(colors.pillar, 1.7),
    { bottomShade: 1.05, topShade: 0.8 },
  );
  // Emissive head.
  const headLateral = side * (boundary - postHeight * 0.2);
  const head = place(frame, headLateral);
  const headY = baseY + postHeight - 0.34;
  addShadedBox(
    builder, head.x, headY, head.z,
    0.95, 0.2, 0.44, frame.heading, colors.lamp,
    { emissive: 1, bottomShade: 1, topShade: 1 },
  );
  lamps.push({
    x: head.x,
    y: headY - 0.1,
    z: head.z,
    color: colors.lamp,
    size: opts.glowSize ?? 1.7,
  });
}

/** Planter + tree on the pavement. */
function addPlanterTree(builder, frame, side, rng, colors, opts = {}) {
  const boundary = opts.boundary ?? 11;
  const lateral = side * (boundary + 2.1);
  const base = place(frame, lateral);
  addShadedBox(
    builder, base.x, frame.y + 0.24, base.z, 1.2, 0.48, 1.2,
    frame.heading, colors.barrier, { bottomShade: 0.6, topShade: 1 },
  );
  builder.addCylinder(base.x, frame.y + 0.34, base.z, 0.14, 0.1, 1.4, {
    color: boost(colors.plantB, 1.4),
    segments: 5,
  });
  const foliage = boost(
    opts.foliageColor ?? (rng.chance(0.5) ? colors.plantA : colors.plantB),
    1.7,
  );
  builder.addSphere(base.x, frame.y + 1.95, base.z, rng.range(0.95, 1.4), {
    color: foliage,
    segments: 6,
    rings: 3,
  });
}

/** Guardrail run: posts plus a single beam, on the far side of the boundary. */
function addGuardrail(builder, frame, side, colors, opts = {}) {
  const boundary = opts.boundary ?? 11;
  const lateral = side * (boundary + 0.95);
  const base = place(frame, lateral);
  const baseY = frame.y;
  addShadedBox(
    builder, base.x, baseY + 0.36, base.z, 0.12, 0.72, 0.12,
    frame.heading, colors.barrier, { bottomShade: 0.5, topShade: 1 },
  );
  const length = opts.length ?? 6;
  addShadedBox(
    builder, base.x, baseY + 0.62, base.z, 0.08, 0.24, length,
    frame.heading, colors.rail, { bottomShade: 0.7, topShade: 1.08 },
  );
}

/** Start/finish gantry with a chequered banner over the road. */
function addStartGantry(builder, lamps, frame, track, colors, opts = {}) {
  const neon = opts.neon ?? true;
  const boundary = track.boundary;
  const halfSpan = boundary + 0.9;
  const postHeight = 8.0;
  const baseY = frame.y;
  const bannerWhite = [0.93, 0.95, 0.97];
  const bannerDark = [0.03, 0.035, 0.045];

  for (const side of [-1, 1]) {
    const post = place(frame, side * halfSpan);
    addShadedBox(
      builder, post.x, baseY + postHeight / 2, post.z,
      0.8, postHeight, 0.8, frame.heading, boost(colors.pillar, 1.8),
      { bottomShade: 1.2, topShade: 0.7 },
    );
    if (neon) {
      // Emissive stripe up each leg.
      const stripePos = place(frame, side * (halfSpan - 0.34));
      addShadedBox(
        builder, stripePos.x, baseY + postHeight / 2, stripePos.z,
        0.06, postHeight * 0.86, 0.1, frame.heading, colors.neonA,
        { emissive: 0.8, bottomShade: 1, topShade: 1 },
      );
    }
  }

  // Horizontal beam.
  const beam = place(frame, 0);
  addShadedBox(
    builder, beam.x, baseY + postHeight - 0.55, beam.z,
    halfSpan * 2 + 0.8, 1.5, 0.7, frame.heading, boost(colors.pillar, 1.8),
    { bottomShade: 1.2, topShade: 0.7 },
  );

  // Chequered banner: 2 rows of 16 squares on both faces of the beam.
  const squares = 16;
  const squareWidth = (halfSpan * 2) / squares;
  const bannerTop = baseY + postHeight - 0.05;
  const squareHeight = 0.56;
  for (const face of [-1, 1]) {
    const along = face * 0.42;
    const normal = [face * frame.tx, 0, face * frame.tz];
    for (let col = 0; col < squares; col += 1) {
      for (let row = 0; row < 2; row += 1) {
        const lat0 = -halfSpan + col * squareWidth;
        const lat1 = lat0 + squareWidth;
        const y1 = bannerTop - row * squareHeight;
        const y0 = y1 - squareHeight;
        const color = (col + row) % 2 === 0 ? bannerWhite : bannerDark;
        bannerQuad(
          builder, frame, along, lat0 + 0.02, lat1 - 0.02, y0 + 0.02, y1 - 0.02,
          normal, color, color === bannerWhite ? 0.65 : 0.05,
        );
      }
    }
  }

  // Floodlights on top of the gantry.
  for (const side of [-1, 1]) {
    const glowPos = place(frame, side * (halfSpan - 0.4));
    lamps.push({
      x: glowPos.x,
      y: baseY + postHeight + 0.4,
      z: glowPos.z,
      color: colors.lamp,
      size: 2.4,
    });
  }
}

/**
 * Build the Neon Bay city scenery.
 *
 * @param {{track: object, palette?: object, seed?: number}} params
 * @returns {{mesh: object, lamps: Array<{x:number,y:number,z:number,color:number[],size:number}>}}
 */
export function createCityScenery({ track, palette, seed = 1 } = {}) {
  const rng = createRng((seed ^ 0x1f2e3d4c) >>> 0);
  const colors = sceneryColors(palette ?? track?.palette);
  const builder = createMeshBuilder();
  const lamps = [];
  const samples = track.samples;
  const count = samples.length;
  const spacing = track.length / count;
  const boundary = track.boundary;
  const stepMetres = 22;
  const step = Math.max(1, Math.round(stepMetres / spacing));
  // Nothing tall within this arc distance of the start line: the title screen
  // orbits the line at ~32 m radius and would otherwise clip through a block.
  const START_CLEAR = 46;
  const arcFromStart = (sample) => Math.min(sample.s, track.length - sample.s);

  /* ---- building blocks along both sides ---- */
  for (let i = 0; i < count; i += step) {
    const frame = frameOf(samples[i]);
    const clear = arcFromStart(samples[i]) < START_CLEAR;
    for (const side of [-1, 1]) {
      if (rng.chance(0.14)) continue;
      if (clear) continue;
      addCityBuilding(builder, lamps, frame, side, rng, colors, { track, boundary });
    }
  }

  /* ---- mid-rise back row: fills the gaps behind the street wall ---- */
  const backStep = Math.max(1, Math.round(34 / spacing));
  for (let i = 0; i < count; i += backStep) {
    const sample = samples[(i + Math.floor(backStep / 2)) % count];
    if (arcFromStart(sample) < START_CLEAR + 12) continue;
    const frame = frameOf(sample);
    for (const side of [-1, 1]) {
      if (rng.chance(0.25)) continue;
      addCityBuilding(builder, lamps, frame, side, rng, colors, {
        track,
        boundary,
        simple: true,
        setback: rng.range(14, 40),
        rootDepth: 9,
      });
    }
  }

  /* ---- distant skyline towers ---- */
  const towerStep = Math.max(1, Math.round(115 / spacing));
  let towerSide = -1;
  for (let i = 0; i < count; i += towerStep) {
    towerSide = -towerSide;
    const sample = samples[(i + Math.floor(towerStep / 2)) % count];
    if (arcFromStart(sample) < START_CLEAR + 20) continue;
    const frame = frameOf(sample);
    addCityBuilding(builder, lamps, frame, towerSide, rng, colors, {
      track,
      boundary,
      tall: true,
      setback: rng.range(17, 44),
      rootDepth: 12,
    });
  }

  /* ---- street lamps, trees, guardrails ---- */
  const paletteResolved = palette ?? track.palette ?? {};
  const lampSpacing = track.trackDef?.lampSpacing ?? paletteResolved.lamps?.spacing ?? 44;
  const lampStep = Math.max(1, Math.round(lampSpacing / spacing));
  for (let i = 0; i < count; i += lampStep) {
    const side = (i / lampStep) % 2 === 0 ? 1 : -1;
    const frame = frameOf(samples[i]);
    addStreetLamp(builder, lamps, frame, side, colors, {
      boundary,
      height: paletteResolved.lamps?.height ?? 8.4,
      glowSize: 1.75,
    });
  }

  const railStep = Math.max(1, Math.round(6 / spacing));
  const treeStep = Math.max(1, Math.round(17 / spacing));
  for (let i = 0; i < count; i += railStep) {
    const frame = frameOf(samples[i]);
    const railLength = spacing * railStep + 0.1;
    for (const side of [-1, 1]) {
      addGuardrail(builder, frame, side, colors, { boundary, length: railLength });
    }
  }
  for (let i = 0; i < count; i += treeStep) {
    const frame = frameOf(samples[i]);
    for (const side of [-1, 1]) {
      if (rng.chance(0.3)) continue;
      addPlanterTree(builder, frame, side, rng, colors, { boundary });
    }
  }

  /* ---- start/finish gantry ---- */
  addStartGantry(builder, lamps, frameOf(samples[0]), track, colors, { neon: true });

  return { mesh: builder.build(), lamps };
}

/* ----------------------------------------------------------------- canyon -- */

/** Layered butte: stacked slabs of rock with strata bands. */
function addRockFormation(builder, frame, side, rng, colors, opts = {}) {
  const boundary = opts.boundary ?? 13;
  const setback = rng.range(2.5, 9);
  const depth = rng.range(12, 24);
  const width = rng.range(14, 30);
  const height = rng.range(8, 30) * (rng.chance(0.18) ? 1.6 : 1);
  const sagitta = (width * width * Math.abs(frame.curvature)) / 8;
  // The slabs are also yawed randomly (+/- 0.25 rad + heading drift), which swings
  // their near corners towards the road: budget for that as well.
  const yawSwing = Math.sin(0.4) * (width * 0.5) + 0.8;
  const centreLateral = side * (boundary + setback + sagitta + yawSwing + depth / 2);
  const centre = place(frame, centreLateral);
  const baseY = frame.y - 5;
  const baseColor = rng.chance(0.5) ? colors.rockA : colors.rockB;
  const yaw = frame.heading + rng.sym(0.25);

  // Three stacked slabs, each smaller and rotated a little, reading as strata.
  let sy = height * 0.55;
  let cy = baseY + sy / 2;
  let sx = depth;
  let sz = width;
  for (let layer = 0; layer < 3; layer += 1) {
    const layerColor = layer % 2 === 0 ? baseColor : boost(baseColor, 0.72);
    addShadedBox(builder, centre.x, cy, centre.z, sx, sy, sz, yaw + rng.sym(0.12), layerColor, {
      bottomShade: 0.38,
      topShade: 1.08,
    });
    // Strata band: a thin, slightly wider slab in a contrasting rock colour.
    const bandColor = layer % 2 === 0 ? boost(colors.rockB, 1.28) : boost(colors.rockA, 0.8);
    addShadedBox(
      builder, centre.x, cy + sy * 0.16, centre.z,
      sx * 1.04, sy * 0.14, sz * 1.04, yaw, bandColor,
      { bottomShade: 0.8, topShade: 1.05 },
    );
    cy += sy * 0.92;
    sy *= rng.range(0.52, 0.72);
    sx *= rng.range(0.62, 0.82);
    sz *= rng.range(0.62, 0.82);
  }

  return height;
}

/** Free-standing boulder. */
function addBoulder(builder, frame, side, rng, colors, opts = {}) {
  const boundary = opts.boundary ?? 13;
  const radius = rng.range(0.7, 2.6);
  const lateral = side * (boundary + radius + 2.0 + rng.range(0, 7));
  const base = place(frame, lateral, rng.sym(2));
  builder.addSphere(base.x, frame.y + radius * 0.55, base.z, radius, {
    color: rng.chance(0.5) ? colors.rockA : colors.rockB,
    segments: rng.int(5, 7),
    rings: 3,
  });
}

/** Dry scrub cluster: a few tiny cones. */
function addScrub(builder, frame, side, rng, colors, opts = {}) {
  const boundary = opts.boundary ?? 13;
  const lateral = side * (boundary + 2.0 + rng.range(0, 5));
  const base = place(frame, lateral, rng.sym(3));
  const color = rng.chance(0.5) ? colors.plantA : colors.plantB;
  const clumps = rng.int(2, 4);
  for (let i = 0; i < clumps; i += 1) {
    const radius = rng.range(0.22, 0.55);
    builder.addCylinder(
      base.x + rng.sym(0.7), frame.y, base.z + rng.sym(0.7),
      radius, 0.02, rng.range(0.5, 1.1),
      { color, segments: 5 },
    );
  }
}

/** Wooden guard posts with two rails. */
function addWoodGuardrail(builder, frame, side, colors, opts = {}) {
  const boundary = opts.boundary ?? 13;
  const lateral = side * (boundary + 0.9);
  const base = place(frame, lateral);
  const baseY = frame.y;
  const wood = [0.24, 0.16, 0.1];
  addShadedBox(
    builder, base.x, baseY + 0.5, base.z, 0.16, 1.0, 0.16,
    frame.heading, wood, { bottomShade: 0.45, topShade: 1.15 },
  );
  const length = opts.length ?? 7;
  for (const [railY, railH] of [[0.78, 0.16], [0.44, 0.14]]) {
    addShadedBox(
      builder, base.x, baseY + railY, base.z, 0.1, railH, length,
      frame.heading, colors.rail, { bottomShade: 0.55, topShade: 1.12 },
    );
  }
}

/** Floodlight tower. */
function addFloodlight(builder, lamps, frame, side, colors, opts = {}) {
  const boundary = opts.boundary ?? 13;
  const lateral = side * (boundary + 3.5);
  const base = place(frame, lateral);
  const baseY = frame.y;
  const height = opts.height ?? 14;
  addShadedBox(
    builder, base.x, baseY + height / 2, base.z, 0.34, height, 0.34,
    frame.heading, colors.pillar, { bottomShade: 0.4, topShade: 1.1 },
  );
  addShadedBox(
    builder, base.x, baseY + height, base.z, 0.36, 0.4, 1.9,
    frame.heading, colors.pillar, { bottomShade: 0.8, topShade: 1 },
  );
  const headLateral = side * (boundary + 2.6);
  for (const along of [-0.6, 0.6]) {
    const head = place(frame, headLateral, along);
    addShadedBox(
      builder, head.x, baseY + height + 0.1, head.z, 0.5, 0.55, 0.42,
      frame.heading, colors.lamp, { emissive: 1, bottomShade: 1, topShade: 1 },
    );
    lamps.push({
      x: head.x,
      y: baseY + height + 0.1,
      z: head.z,
      color: colors.lamp,
      size: 3.4,
    });
  }
}

/**
 * Build the Sunset Canyon scenery.
 *
 * @param {{track: object, palette?: object, seed?: number}} params
 * @returns {{mesh: object, lamps: Array<{x:number,y:number,z:number,color:number[],size:number}>}}
 */
export function createCanyonScenery({ track, palette, seed = 1 } = {}) {
  const rng = createRng((seed ^ 0x2b7c9e11) >>> 0);
  const colors = sceneryColors(palette ?? track?.palette);
  const builder = createMeshBuilder();
  const lamps = [];
  const samples = track.samples;
  const count = samples.length;
  const spacing = track.length / count;
  const boundary = track.boundary;

  /* ---- rock walls on both sides ---- */
  const rockStep = Math.max(1, Math.round(13 / spacing));
  const START_CLEAR = 44;
  const arcFromStart = (sample) => Math.min(sample.s, track.length - sample.s);
  for (let i = 0; i < count; i += rockStep) {
    const frame = frameOf(samples[i]);
    const clear = arcFromStart(samples[i]) < START_CLEAR;
    for (const side of [-1, 1]) {
      if (rng.chance(0.1)) continue;
      if (clear) continue;
      addRockFormation(builder, frame, side, rng, colors, { boundary });
    }
  }

  /* ---- boulders and scrub ---- */
  const boulderStep = Math.max(1, Math.round(11 / spacing));
  for (let i = 0; i < count; i += boulderStep) {
    const frame = frameOf(samples[i]);
    for (const side of [-1, 1]) {
      if (rng.chance(0.25)) continue;
      addBoulder(builder, frame, side, rng, colors, { boundary });
    }
  }
  const scrubStep = Math.max(1, Math.round(9 / spacing));
  for (let i = 0; i < count; i += scrubStep) {
    const frame = frameOf(samples[i]);
    for (const side of [-1, 1]) {
      if (rng.chance(0.3)) continue;
      addScrub(builder, frame, side, rng, colors, { boundary });
    }
  }

  /* ---- wooden guardrail ---- */
  const railStep = Math.max(1, Math.round(7 / spacing));
  for (let i = 0; i < count; i += railStep) {
    const frame = frameOf(samples[i]);
    const length = spacing * railStep + 0.15;
    for (const side of [-1, 1]) {
      addWoodGuardrail(builder, frame, side, colors, { boundary, length });
    }
  }

  /* ---- floodlight towers ---- */
  const floodStep = Math.max(1, Math.round(240 / spacing));
  let floodSide = 1;
  for (let i = 0; i < count; i += floodStep) {
    floodSide = -floodSide;
    const frame = frameOf(samples[i]);
    addFloodlight(builder, lamps, frame, floodSide, colors, {
      boundary,
      height: rng.range(11, 17),
    });
  }

  /* ---- finish gantry: same frame, plain (no neon) ---- */
  addStartGantry(builder, lamps, frameOf(samples[0]), track, colors, { neon: false });

  return { mesh: builder.build(), lamps };
}
