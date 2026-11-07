/**
 * Procedural low-poly car bodies and wheels.
 *
 * The game ships no assets, so every car is generated from code: a handful of
 * flat-shaded boxes lofted with custom wedge faces. The art direction is
 * deliberately boxy (90s arcade racer), which keeps the triangle budget tiny and
 * the silhouette readable at 200 km/h.
 *
 * Conventions:
 *  - The car faces **+Z** (same as the sim's heading convention: forward =
 *    `(sin(h), 0, cos(h))`), +Y is up and the origin sits on the ground between
 *    the wheels.
 *  - Car-local **+X is the car's right-hand side** (matching the track's `right`
 *    vector and the sim's positive yaw), so `WHEEL_OFFSETS[].left` is true for
 *    the x = -0.83 wheels.
 *  - Faces must be wound counter-clockwise seen from outside: the renderer culls
 *    back faces, so a flipped quad would read as a hole.
 *  - Colours come straight from the car palette in `src/sim/config.js`; the
 *    alpha channel of the vertex colour is used as emissive (lights glow).
 *
 * Geometry budget: body <= 1500 triangles, wheel <= 400 triangles.
 *
 * Key heights (metres, ground = 0): tyre top 0.72, belt line 0.70, roof 1.15,
 * rear wing 1.13. The greenhouse deliberately pokes 0.25 m above the rear deck
 * so the car still reads as a car from the chase camera.
 */

import { createMeshBuilder } from '../core/mesh.js';
import { cross3, hexToRgb, normalize3, scaleRgb } from '../core/math.js';

/** Wheel radius in metres (the sim also uses this for ride height). */
export const WHEEL_RADIUS = 0.36;
/** Tyre width in metres, measured along the wheel's X axis. */
export const WHEEL_WIDTH = 0.29;
/** Half track width: wheel centre offset along car-local X. */
export const WHEEL_TRACK = 0.83;
/** Front/rear axle distance from the car origin along Z. */
export const WHEEL_BASE = 1.32;

/**
 * Wheel attachment points in car-local space.
 * `y` is the wheel centre height (the wheel stands on y = 0).
 * `left` follows the sim convention where +X is the car's right.
 * @type {Array<{x:number, y:number, z:number, front:boolean, left:boolean}>}
 */
export const WHEEL_OFFSETS = [
  { x: WHEEL_TRACK, y: WHEEL_RADIUS, z: WHEEL_BASE, front: true, left: false },
  { x: -WHEEL_TRACK, y: WHEEL_RADIUS, z: WHEEL_BASE, front: true, left: true },
  { x: WHEEL_TRACK, y: WHEEL_RADIUS, z: -WHEEL_BASE, front: false, left: false },
  { x: -WHEEL_TRACK, y: WHEEL_RADIUS, z: -WHEEL_BASE, front: false, left: true },
];

/* ------------------------------------------------------------- utilities -- */

/** Accept either `[r,g,b]` (config palette) or a `#rrggbb` string. */
function colorOf(value, fallback) {
  if (Array.isArray(value) && value.length >= 3 && Number.isFinite(value[0])) {
    return [value[0], value[1], value[2]];
  }
  if (typeof value === 'string') return hexToRgb(value);
  return fallback;
}

/** Darker/lighter copy of an RGB triple. */
function shade(color, factor) {
  return scaleRgb(color, factor);
}

function point(x, y, z) {
  return { x, y, z };
}

function normalOf(a, b, c) {
  return normalize3(cross3([b.x - a.x, b.y - a.y, b.z - a.z], [c.x - a.x, c.y - a.y, c.z - a.z]));
}

function centroidOf(points) {
  let x = 0;
  let y = 0;
  let z = 0;
  for (const item of points) {
    x += item.x;
    y += item.y;
    z += item.z;
  }
  return { x: x / points.length, y: y / points.length, z: z / points.length };
}

/**
 * Add a quad from four corners given in any cyclic order, using `normal` as the
 * wanted outward direction (the winding is fixed up automatically).
 * @param {object} builder mesh builder
 * @param {Array<{x:number,y:number,z:number}>} corners four corners
 * @param {number[]} normal outward normal (normalised internally)
 * @param {number[]} color rgb
 * @param {number} [emissive]
 */
function quadFacing(builder, corners, normal, color, emissive = 0) {
  const [a, b, c, d] = corners;
  const unit = normalize3(normal);
  const projected = normalOf(a, b, c);
  const facing = projected[0] * unit[0] + projected[1] * unit[1] + projected[2] * unit[2] >= 0;
  const ordered = facing ? corners : [a, d, c, b];
  builder.flatQuad(ordered[0], ordered[1], ordered[2], ordered[3], unit, color, emissive);
}

/**
 * Add a closed quad whose winding is corrected to point away from `center`.
 * Used for convex lofts (cabin, nose, wing) where the outward direction is
 * simply "away from the middle of the volume".
 */
function quadOutward(builder, corners, center, color, emissive = 0) {
  const normal = normalOf(corners[0], corners[1], corners[2]);
  const middle = centroidOf(corners);
  const away = [middle.x - center.x, middle.y - center.y, middle.z - center.z];
  const dot = normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2];
  if (dot >= 0) {
    builder.flatQuad(corners[0], corners[1], corners[2], corners[3], normal, color, emissive);
  } else {
    const flipped = [-normal[0], -normal[1], -normal[2]];
    builder.flatQuad(corners[3], corners[2], corners[1], corners[0], flipped, color, emissive);
  }
}

/* ------------------------------------------------------------ car body -- */

/**
 * Build the body shell of a car.
 *
 * @param {{paint?:number[]|string, accent?:number[]|string, stripe?:number[]|string,
 *   glass?:number[]|string, rim?:number[]|string, tyre?:number[]|string,
 *   headlight?:number[]|string, taillight?:number[]|string}} palette
 * @returns {import('../core/mesh.js').Mesh}
 */
export function createCarBodyMesh(palette = {}) {
  const paint = colorOf(palette.paint, [0.85, 0.86, 0.9]);
  const accent = colorOf(palette.accent, [0.07, 0.08, 0.1]);
  const stripe = colorOf(palette.stripe, [0.96, 0.97, 1]);
  const glass = colorOf(palette.glass, [0.05, 0.07, 0.09]);
  const headlight = colorOf(palette.headlight, [0.95, 0.98, 1]);
  const taillight = colorOf(palette.taillight, [1, 0.18, 0.28]);
  const darkTrim = shade(accent, 0.55);
  const paintDark = shade(paint, 0.6);
  const b = createMeshBuilder();

  /* --- lower body ------------------------------------------------------- */

  // Flat floor pan, visible under the sills and from low camera angles.
  b.addBox(0, 0.2, 0.0, 1.42, 0.16, 3.4, { color: darkTrim });
  // Main tub: the narrow centre section the fenders bolt onto.
  b.addBox(0, 0.47, 0.05, 1.58, 0.38, 3.5, { color: paint });
  // Bonnet plate, slightly under the fender crown.
  b.addBox(0, 0.685, 1.28, 1.4, 0.07, 1.02, { color: paint });
  // Sills / side skirts.
  b.addBox(0.78, 0.28, 0.05, 0.12, 0.14, 1.9, { color: accent });
  b.addBox(-0.78, 0.28, 0.05, 0.12, 0.14, 1.9, { color: accent });

  /* --- fenders and haunches -------------------------------------------- */

  // Front wheel arches: sit exactly on top of the tyre so the wheel reads clean.
  b.addBox(0.82, 0.82, 1.28, 0.34, 0.2, 1.0, { color: paint });
  b.addBox(-0.82, 0.82, 1.28, 0.34, 0.2, 1.0, { color: paint });
  // Rear haunches: a wide lower flank with a narrower shoulder on top, so the
  // hip reads as a curve instead of one flat shelf.
  b.addBox(0.8, 0.78, -1.28, 0.4, 0.16, 1.72, { color: paint });
  b.addBox(-0.8, 0.78, -1.28, 0.4, 0.16, 1.72, { color: paint });
  b.addBox(0.78, 0.9, -1.28, 0.34, 0.12, 1.5, { color: paint });
  b.addBox(-0.78, 0.9, -1.28, 0.34, 0.12, 1.5, { color: paint });
  // Rear deck between the haunches, recessed a little for a duck-tail read.
  b.addBox(0, 0.79, -1.6, 1.24, 0.18, 1.06, { color: paint });
  // Rear bumper / tail panel, tapered towards the diffuser.
  b.addBox(0, 0.59, -2.05, 1.88, 0.26, 0.3, { color: paint });
  b.addBox(0, 0.42, -2.03, 1.6, 0.14, 0.26, { color: paint });
  // Diffuser with vertical fins.
  b.addBox(0, 0.3, -2.04, 1.4, 0.14, 0.26, { color: darkTrim });
  for (const finX of [-0.44, 0, 0.44]) {
    b.addBox(finX, 0.3, -2.12, 0.05, 0.2, 0.2, { color: darkTrim });
  }
  // Front splitter.
  b.addBox(0, 0.28, 2.02, 1.58, 0.1, 0.44, { color: accent });

  /* --- nose wedge ------------------------------------------------------- */

  // Two rings lofted together: a wide rear face blended into a low, narrow tip.
  const nose = {
    r0: point(-0.86, 0.29, 1.8),
    r1: point(0.86, 0.29, 1.8),
    r2: point(0.86, 0.72, 1.8),
    r3: point(-0.86, 0.72, 1.8),
    f0: point(-0.76, 0.27, 2.2),
    f1: point(0.76, 0.27, 2.2),
    f2: point(0.76, 0.56, 2.2),
    f3: point(-0.76, 0.56, 2.2),
  };
  const noseCenter = point(0, 0.48, 2.0);
  quadOutward(b, [nose.r3, nose.r2, nose.f2, nose.f3], noseCenter, paint); // top
  quadOutward(b, [nose.r0, nose.r1, nose.f1, nose.f0], noseCenter, darkTrim); // underside
  quadOutward(b, [nose.r0, nose.r3, nose.f3, nose.f0], noseCenter, paint); // left flank
  quadOutward(b, [nose.r1, nose.r2, nose.f2, nose.f1], noseCenter, paint); // right flank
  quadOutward(b, [nose.f0, nose.f1, nose.f2, nose.f3], noseCenter, paint); // front fascia

  // Headlights on the front fascia.
  const hlZ = 2.206;
  for (const side of [-1, 1]) {
    const inner = side * 0.2;
    const outer = side * 0.62;
    quadFacing(b, [
      point(inner, 0.36, hlZ),
      point(outer, 0.36, hlZ),
      point(outer, 0.5, hlZ),
      point(inner, 0.5, hlZ),
    ], [0, 0, 1], headlight, 1);
  }
  // DRL strips along the sloped bonnet edge.
  const noseTopY = (z) => 0.72 - (0.16 * (z - 1.8)) / 0.4;
  for (const side of [-1, 1]) {
    const x0 = side * 0.28;
    const x1 = side * 0.66;
    const z0 = 1.94;
    const z1 = 2.13;
    quadFacing(b, [
      point(x0, noseTopY(z0) + 0.012, z0),
      point(x1, noseTopY(z0) + 0.012, z0),
      point(x1, noseTopY(z1) + 0.012, z1),
      point(x0, noseTopY(z1) + 0.012, z1),
    ], [0, 0.45, 0.9], headlight, 0.85);
  }
  // Thin grille slot between the headlights.
  b.addBox(0, 0.36, 2.185, 0.56, 0.07, 0.05, { color: darkTrim });

  /* --- cabin ------------------------------------------------------------ */

  // Lofted greenhouse: wide at the belt line, narrower and shorter at the roof,
  // which gives the raked windscreen and fastback rear glass for free.
  const cab = {
    b0: point(-0.69, 0.7, 0.86),
    b1: point(0.69, 0.7, 0.86),
    b2: point(0.69, 0.7, -1.34),
    b3: point(-0.69, 0.7, -1.34),
    t0: point(-0.55, 1.15, 0.3),
    t1: point(0.55, 1.15, 0.3),
    t2: point(0.57, 1.15, -0.98),
    t3: point(-0.57, 1.15, -0.98),
  };
  const cabCenter = point(0, 0.92, -0.26);
  quadOutward(b, [cab.b0, cab.b1, cab.t1, cab.t0], cabCenter, glass); // windscreen
  quadOutward(b, [cab.b3, cab.b2, cab.t2, cab.t3], cabCenter, glass); // rear screen
  quadOutward(b, [cab.b1, cab.b2, cab.t2, cab.t1], cabCenter, glass); // right glass
  quadOutward(b, [cab.b3, cab.b0, cab.t0, cab.t3], cabCenter, glass); // left glass
  quadOutward(b, [cab.t0, cab.t1, cab.t2, cab.t3], cabCenter, paint); // roof

  // Painted belt-line trim hiding the bottom edge of the glass.
  b.addBox(0.686, 0.715, -0.26, 0.07, 0.05, 2.14, { color: paint });
  b.addBox(-0.686, 0.715, -0.26, 0.07, 0.05, 2.14, { color: paint });

  // C-pillar: a painted sail panel over the rear quarter of the side glass,
  // which turns the greenhouse into a fastback instead of a glass bubble.
  for (const side of [-1, 1]) {
    const cOff = side * 0.014;
    quadFacing(b, [
      point(side * 0.69 + cOff, 0.704, -1.34),
      point(side * 0.69 + cOff, 0.704, -0.58),
      point(side * 0.58 + cOff, 1.148, -0.36),
      point(side * 0.585 + cOff, 1.148, -0.98),
    ], [side, 0.12, 0], paint);
  }

  // A- and B-pillars so the cabin does not read as one glass blob.
  for (const side of [-1, 1]) {
    // Side plane runs from x = 0.69 at y = 0.70 to x ≈ 0.56 at y = 1.15.
    const xAt = (t) => side * (0.69 - 0.12 * t) + side * 0.016;
    const pillar = (zBottom, zTop, halfWidth) => {
      quadFacing(b, [
        point(xAt(0), 0.702, zBottom + halfWidth),
        point(xAt(0), 0.702, zBottom - halfWidth),
        point(xAt(1), 1.148, zTop - halfWidth * 0.7),
        point(xAt(1), 1.148, zTop + halfWidth * 0.7),
      ], [side, 0.3, 0], paint);
    };
    pillar(0.78, 0.32, 0.07); // A-pillar
    pillar(-0.3, -0.6, 0.055); // B-pillar
  }

  /* --- rear end -------------------------------------------------------- */

  // Full-width tail light bar plus taller corner blocks (the main rear read).
  b.addBox(0, 0.66, -2.215, 1.7, 0.1, 0.05, { color: taillight, emissive: 0.95 });
  b.addBox(0.71, 0.7, -2.19, 0.26, 0.2, 0.06, { color: taillight, emissive: 0.9 });
  b.addBox(-0.71, 0.7, -2.19, 0.26, 0.2, 0.06, { color: taillight, emissive: 0.9 });
  // Third brake light in the spoiler.
  b.addBox(0, 1.02, -2.16, 0.48, 0.04, 0.05, { color: taillight, emissive: 1 });

  // Exhaust tips: dark bores with a bright rim.
  for (const side of [-1, 1]) {
    b.addCylinder(side * 0.45, 0.31, -2.24, 0.075, 0.075, 0.14, {
      axis: 'z',
      color: colorOf(palette.rim, [0.8, 0.82, 0.86]),
      capColor: darkTrim,
      segments: 8,
    });
  }

  /* --- spoiler --------------------------------------------------------- */

  // Two uprights and a lofted free-standing wing with a slight angle of attack.
  b.addBox(0.58, 0.94, -1.94, 0.09, 0.14, 0.22, { color: accent });
  b.addBox(-0.58, 0.94, -1.94, 0.09, 0.14, 0.22, { color: accent });
  const wing = {
    a0: point(-0.84, 0.99, -1.82),
    a1: point(0.84, 0.99, -1.82),
    a2: point(0.84, 1.05, -1.82),
    a3: point(-0.84, 1.05, -1.82),
    b0: point(-0.84, 1.03, -2.14),
    b1: point(0.84, 1.03, -2.14),
    b2: point(0.84, 1.09, -2.14),
    b3: point(-0.84, 1.09, -2.14),
  };
  const wingCenter = point(0, 1.04, -1.98);
  quadOutward(b, [wing.a3, wing.a2, wing.b2, wing.b3], wingCenter, paint); // top
  quadOutward(b, [wing.a0, wing.a1, wing.b1, wing.b0], wingCenter, darkTrim); // bottom
  quadOutward(b, [wing.a0, wing.a3, wing.b3, wing.b0], wingCenter, paint); // left edge
  quadOutward(b, [wing.a1, wing.a2, wing.b2, wing.b1], wingCenter, paint); // right edge
  quadOutward(b, [wing.b0, wing.b1, wing.b2, wing.b3], wingCenter, accent); // trailing
  quadOutward(b, [wing.a0, wing.a1, wing.a2, wing.a3], wingCenter, accent); // leading
  // Wing end plates.
  b.addBox(0.86, 0.97, -1.98, 0.03, 0.16, 0.34, { color: accent });
  b.addBox(-0.86, 0.97, -1.98, 0.03, 0.16, 0.34, { color: accent });

  /* --- trim, stripes and details --------------------------------------- */

  // Mirrors.
  b.addBox(0.79, 0.94, 0.62, 0.2, 0.09, 0.11, { color: paint });
  b.addBox(-0.79, 0.94, 0.62, 0.2, 0.09, 0.11, { color: paint });
  // Racing stripes over the bonnet, roof and deck.
  b.addBox(0.15, 0.727, 1.3, 0.15, 0.018, 0.95, { color: stripe });
  b.addBox(-0.15, 0.727, 1.3, 0.15, 0.018, 0.95, { color: stripe });
  b.addBox(0.15, 1.157, -0.34, 0.15, 0.016, 1.2, { color: stripe });
  b.addBox(-0.15, 1.157, -0.34, 0.15, 0.016, 1.2, { color: stripe });
  b.addBox(0.18, 0.887, -1.72, 0.18, 0.016, 0.78, { color: stripe });
  b.addBox(-0.18, 0.887, -1.72, 0.18, 0.016, 0.78, { color: stripe });
  // Bonnet vents.
  b.addBox(0.37, 0.727, 1.44, 0.2, 0.012, 0.34, { color: paintDark });
  b.addBox(-0.37, 0.727, 1.44, 0.2, 0.012, 0.34, { color: paintDark });
  // Deck vents.
  b.addBox(0.37, 0.887, -1.3, 0.18, 0.012, 0.5, { color: paintDark });
  b.addBox(-0.37, 0.887, -1.3, 0.18, 0.012, 0.5, { color: paintDark });
  // Body crease down the flank plus a gill vent behind each front wheel.
  b.addBox(0.8, 0.585, 0.02, 0.03, 0.035, 3.1, { color: paintDark });
  b.addBox(-0.8, 0.585, 0.02, 0.03, 0.035, 3.1, { color: paintDark });
  for (const side of [-1, 1]) {
    for (let slot = 0; slot < 3; slot += 1) {
      b.addBox(side * 0.802, 0.57 - slot * 0.055, 0.7, 0.03, 0.028, 0.2, { color: accent });
    }
    // Front bumper brake duct.
    b.addBox(side * 0.56, 0.36, 2.19, 0.22, 0.1, 0.06, { color: darkTrim });
  }
  // Door handles.
  b.addBox(0.802, 0.61, 0.42, 0.03, 0.05, 0.22, { color: accent });
  b.addBox(-0.802, 0.61, 0.42, 0.03, 0.05, 0.22, { color: accent });

  return b.build();
}

/* ---------------------------------------------------------------- wheel -- */

/** Five-spoke plate on one face of the wheel. */
function addSpokes(builder, faceX, direction, rimColor) {
  const normal = [direction, 0, 0];
  const face = direction * faceX;
  const innerRadius = 0.075;
  const outerRadius = 0.225;
  const innerHalfWidth = 0.032;
  const outerHalfWidth = 0.055;
  for (let spoke = 0; spoke < 5; spoke += 1) {
    const angle = (spoke / 5) * Math.PI * 2 + Math.PI / 10;
    const uy = Math.cos(angle);
    const uz = Math.sin(angle);
    const wy = -Math.sin(angle);
    const wz = Math.cos(angle);
    const corner = (radius, halfWidth, sign) => point(
      face,
      uy * radius + wy * halfWidth * sign,
      uz * radius + wz * halfWidth * sign,
    );
    quadFacing(builder, [
      corner(innerRadius, innerHalfWidth, -1),
      corner(outerRadius, outerHalfWidth, -1),
      corner(outerRadius, outerHalfWidth, 1),
      corner(innerRadius, innerHalfWidth, 1),
    ], normal, rimColor);
  }
}

/**
 * Build a wheel.
 *
 * Cylinder axis is **X**, origin at the wheel centre, tyre standing on y = 0.
 * Both faces get a rim, five spokes and a hub so the wheel reads from either
 * side of the car (the sim never mirrors wheel meshes).
 *
 * @param {{tyre?:number[]|string, rim?:number[]|string}} [palette]
 * @returns {import('../core/mesh.js').Mesh}
 */
export function createWheelMesh(palette = {}) {
  const tyre = colorOf(palette.tyre, [0.07, 0.07, 0.08]);
  const rim = colorOf(palette.rim, [0.8, 0.82, 0.86]);
  const rimDark = shade(rim, 0.35);
  const brake = [0.16, 0.15, 0.15];
  const b = createMeshBuilder();
  const halfWidth = WHEEL_WIDTH / 2;
  const outerFace = halfWidth + 0.007;

  // Tyre (its caps are the sidewalls).
  b.addCylinder(-halfWidth, 0, 0, WHEEL_RADIUS, WHEEL_RADIUS, WHEEL_WIDTH, {
    axis: 'x',
    color: tyre,
    capColor: shade(tyre, 0.8),
    segments: 18,
  });

  for (const direction of [-1, 1]) {
    // Dark recess behind the spokes (reads as the wheel barrel).
    b.addCylinder(direction * halfWidth, 0, 0, 0.235, 0.235, 0.008, {
      axis: 'x',
      color: rimDark,
      segments: 12,
    });
    // Brake disc hint, just proud of the recess.
    b.addCylinder(direction * (halfWidth + 0.008), 0, 0, 0.19, 0.19, 0.006, {
      axis: 'x',
      color: brake,
      segments: 10,
    });
    addSpokes(b, outerFace, direction, rim);
    // Hub cap.
    b.addCylinder(direction * outerFace, 0, 0, 0.075, 0.06, 0.022, {
      axis: 'x',
      color: rim,
      segments: 8,
    });
  }

  return b.build();
}
