import * as THREE from 'three';
import { addBox, addCyl, GeoBatch, xform } from './geo';
import type { ArenaLayout, StandDef } from './layout';
import { TILE } from './textures';
import { mulberry32 } from '../core/utils';

/**
 * Procured stonework and timber: the limestone curtain wall with crenellations,
 * the north gatehouse (arch, timber upper storey, gabled shingle roof, flanking
 * towers) and the tiered wooden spectator stands. Everything is merged into the
 * shared material buckets.
 */

/** Dimensions other modules (banners, crowd, props) need to reference. */
export const ARENA_STRUCT = {
  wallHeight: 3.9,
  wallCapY: 4.65,
  gate: {
    frontZ: -23.2,
    storeyFrontZ: -22.9,
    stoneTopY: 6.6,
    storeyTopY: 9.8,
    ridgeY: 11.5,
    towerX: 9.2,
    towerZ: -25.3,
    towerTopY: 8.3,
    towerPoleY: 11.3,
    archHalf: 2.6,
    archSpringY: 3.0,
    archApexY: 5.6,
    gateHalfWidth: 7.0,
  },
  cornerTower: { x: 26.4, z: 25.4, topY: 6.9, poleY: 9.9 },
  railTopY: 5.75,
  seats: {
    west: { topRail: 5.75, fasciaY: 4.6 },
  },
};

interface Tint {
  v: number;
}

function pickTint(rng: () => number, lo = 0.86, hi = 1.06): THREE.Color {
  const v = lo + rng() * (hi - lo);
  return new THREE.Color(v, v, v);
}

/* ------------------------------------------------------------------ */
/* Triangular prism (gatehouse gable)                                  */
/* ------------------------------------------------------------------ */

function triPrism(halfW: number, y0: number, y1: number, depth: number, zCenter: number, tile: number): THREE.BufferGeometry {
  const zf = zCenter + depth / 2;
  const zb = zCenter - depth / 2;
  const verts = [
    // front
    [-halfW, y0, zf],
    [halfW, y0, zf],
    [0, y1, zf],
    // back
    [-halfW, y0, zb],
    [halfW, y0, zb],
    [0, y1, zb],
  ];
  const idx = [
    0, 1, 2, // front
    5, 4, 3, // back
    3, 4, 1, 3, 1, 0, // bottom
    0, 2, 5, 0, 5, 3, // left slope
    1, 4, 5, 1, 5, 2, // right slope
  ];
  const geo = new THREE.BufferGeometry();
  const positions: number[] = [];
  const uvs: number[] = [];
  for (const i of idx) {
    const [x, y, z] = verts[i];
    positions.push(x, y, z);
    uvs.push(x / tile, y / tile);
  }
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Crenellations                                                       */
/* ------------------------------------------------------------------ */

function crenellations(
  batch: GeoBatch,
  rng: () => number,
  opts: {
    axis: 'x' | 'z';
    fixed: number;
    from: number;
    to: number;
    y: number;
    depth: number;
    merlon?: number;
    gap?: number;
    height?: number;
  },
): void {
  const merlon = opts.merlon ?? 0.95;
  const gap = opts.gap ?? 0.8;
  const h = opts.height ?? 0.8;
  const step = merlon + gap;
  for (let a = opts.from + merlon / 2; a < opts.to; a += step) {
    // A few weathered merlons are stumped or missing altogether.
    const roll = rng();
    if (roll > 0.93) continue;
    const mw = merlon * (0.86 + rng() * 0.24);
    const mh = h * (roll > 0.84 ? 0.55 + rng() * 0.2 : 0.94 + rng() * 0.12);
    const size: [number, number, number] = opts.axis === 'x' ? [mw, mh, opts.depth] : [opts.depth, mh, mw];
    const pos: [number, number, number] = opts.axis === 'x' ? [a, opts.y + mh / 2, opts.fixed] : [opts.fixed, opts.y + mh / 2, a];
    addBox(batch, 'stone', size, pos, {
      tile: TILE.stone,
      color: pickTint(rng, 0.84, 1.02),
      aoBase: opts.y - h,
      aoTop: opts.y + h,
      minShade: 0.82,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Curtain wall                                                        */
/* ------------------------------------------------------------------ */

function buildCurtainWall(batch: GeoBatch, layout: ArenaLayout, rng: () => number): void {
  const H = layout.wallHeight;
  const t = layout.wallThickness;
  const ix = layout.wallInner.x;
  const iz = layout.wallInner.z;
  const cx = layout.wallOuter.x - t / 2; // wall centre in x
  const cz = layout.wallOuter.z - t / 2;
  const gateTowerOuter = ARENA_STRUCT.gate.towerX + 2.0;
  const tint = (lo = 0.9, hi = 1.05): THREE.Color => pickTint(rng, lo, hi);

  // Four curtain walls (north is split around the gatehouse). Each run is built
  // from ~6 m chunks with slightly different stone tint + height so the tiled
  // texture never reads as one repeating strip.
  const CHUNK = 6;
  const wallRun = (
    axis: 'x' | 'z',
    fixed: number,
    from: number,
    to: number,
  ): void => {
    const span = to - from;
    const chunks = Math.max(1, Math.round(span / CHUNK));
    const step = span / chunks;
    for (let i = 0; i < chunks; i++) {
      const mid = from + step * (i + 0.5);
      const h = H + (rng() - 0.5) * 0.05;
      const size: [number, number, number] = axis === 'x' ? [step + 0.12, h, t] : [t, h, step + 0.12];
      const pos: [number, number, number] = axis === 'x' ? [mid, h / 2, fixed] : [fixed, h / 2, mid];
      addBox(batch, 'stone', size, pos, {
        tile: TILE.stone,
        color: tint(0.86, 1.08),
        aoBase: 0,
        aoTop: 3.4,
        minShade: 0.58,
      });
    }
    // Coping course along the top breaks up the vertical face.
    const copeSize: [number, number, number] = axis === 'x' ? [span, 0.2, t + 0.22] : [t + 0.22, 0.2, span];
    const copePos: [number, number, number] = axis === 'x' ? [(from + to) / 2, H - 0.12, fixed] : [fixed, H - 0.12, (from + to) / 2];
    addBox(batch, 'stone', copeSize, copePos, { tile: TILE.stone, color: tint(1.02, 1.14), minShade: 0.9 });
  };

  wallRun('z', -cx, -cz, cz);
  wallRun('z', cx, -cz, cz);
  wallRun('x', cz, -ix, ix);
  const northSegLen = ix - gateTowerOuter;
  wallRun('x', -cz, -gateTowerOuter, -ix);
  wallRun('x', -cz, gateTowerOuter, ix);
  void northSegLen;

  // Plinth (slightly proud of the wall face) and a string course.
  const plinthH = 0.62;
  const plinthT = t + 0.34;
  addBox(batch, 'stone', [plinthT, plinthH, cz * 2 + 0.34], [-cx, plinthH / 2, 0], {
    tile: TILE.stone, color: pickTint(rng, 0.68, 0.88), minShade: 0.72,
  });
  addBox(batch, 'stone', [plinthT, plinthH, cz * 2 + 0.34], [cx, plinthH / 2, 0], {
    tile: TILE.stone, color: pickTint(rng, 0.68, 0.88), minShade: 0.72,
  });
  addBox(batch, 'stone', [ix * 2 + 0.34, plinthH, plinthT], [0, plinthH / 2, cz], {
    tile: TILE.stone, color: pickTint(rng, 0.68, 0.88), minShade: 0.72,
  });
  const courseY = 2.7;
  addBox(batch, 'stone', [t + 0.2, 0.18, cz * 2], [-cx, courseY, 0], { tile: TILE.stone, color: pickTint(rng, 0.98, 1.08) });
  addBox(batch, 'stone', [t + 0.2, 0.18, cz * 2], [cx, courseY, 0], { tile: TILE.stone, color: pickTint(rng, 0.98, 1.08) });
  addBox(batch, 'stone', [ix * 2, 0.18, t + 0.2], [0, courseY, cz], { tile: TILE.stone, color: pickTint(rng, 0.98, 1.08) });

  // Crenellations along the top edges.
  crenellations(batch, rng, { axis: 'z', fixed: -cx, from: -cz, to: cz, y: H, depth: t * 0.72 });
  crenellations(batch, rng, { axis: 'z', fixed: cx, from: -cz, to: cz, y: H, depth: t * 0.72 });
  crenellations(batch, rng, { axis: 'x', fixed: cz, from: -ix, to: ix, y: H, depth: t * 0.72 });
  crenellations(batch, rng, { axis: 'x', fixed: -cz, from: -ix, to: -gateTowerOuter, y: H, depth: t * 0.72 });
  crenellations(batch, rng, { axis: 'x', fixed: -cz, from: gateTowerOuter, to: ix, y: H, depth: t * 0.72 });

  // Stone relief: protruding blocks and a few dark missing-stone recesses so the
  // wall has real depth at gameplay distance rather than pure texture.
  const reliefRun = (count: number, place: (t: number) => [number, number, number], size: [number, number, number], facing: 'x' | 'z'): void => {
    for (let i = 0; i < count; i++) {
      const t = rng();
      const [px, py, pz] = place(t);
      const w = 0.28 + rng() * 0.5;
      const h = 0.14 + rng() * 0.26;
      const dims: [number, number, number] = facing === 'x' ? [0.13, h, w] : [w, h, 0.13];
      if (rng() > 0.82) {
        // Recessed, shadowed block (a lost stone).
        addBox(batch, 'stone', [dims[0] * 0.8, dims[1] * 0.9, dims[2] * 0.8], [px, py, pz], {
          tile: TILE.stone,
          color: new THREE.Color(0.24, 0.22, 0.19),
          minShade: 1,
        });
      } else {
        addBox(batch, 'stone', dims, [px, py, pz], {
          tile: TILE.stone,
          color: pickTint(rng, 0.72, 1.2),
          aoBase: py - 0.6,
          aoTop: py + 0.6,
          minShade: 0.82,
        });
      }
      void size;
    }
  };
  reliefRun(80, (t) => [ix - 0.06, 0.8 + t * 2.5, -cz + rng() * cz * 2], [1, 1, 1], 'x');
  reliefRun(80, (t) => [rng() * ix * 2 - ix, 0.8 + t * 2.5, iz - 0.06], [1, 1, 1], 'z');
  reliefRun(28, (t) => [rng() * (ix - gateTowerOuter) + gateTowerOuter, 0.8 + t * 2.5, -cz + 0.06], [1, 1, 1], 'z');
  reliefRun(28, (t) => [-rng() * (ix - gateTowerOuter) - gateTowerOuter, 0.8 + t * 2.5, -cz + 0.06], [1, 1, 1], 'z');

  // Pilasters on the arena-facing side of the east and south walls.
  for (let a = -cz + 4; a < cz - 2; a += 8.4) {
    addBox(batch, 'stone', [0.5, H - 0.7, 0.9], [ix - 0.22, (H - 0.7) / 2, a], {
      tile: TILE.stone, color: pickTint(rng, 0.86, 1.0), aoBase: 0, aoTop: 2.6, minShade: 0.6,
    });
  }
  for (let a = -ix + 4; a < ix - 2; a += 8.4) {
    addBox(batch, 'stone', [0.9, H - 0.7, 0.5], [a, (H - 0.7) / 2, iz - 0.22], {
      tile: TILE.stone, color: pickTint(rng, 0.86, 1.0), aoBase: 0, aoTop: 2.6, minShade: 0.6,
    });
  }

  // Arrow loops (dark recesses) on the south + east inner faces.
  for (let a = -cz + 6; a < cz - 4; a += 11) {
    addBox(batch, 'stone', [0.16, 1.1, 0.26], [ix - 0.03, 2.05, a], { tile: TILE.stone, color: new THREE.Color(0.16, 0.15, 0.13) });
  }
  for (let a = -ix + 6; a < ix - 4; a += 11) {
    addBox(batch, 'stone', [0.26, 1.1, 0.16], [a, 2.05, iz - 0.03], { tile: TILE.stone, color: new THREE.Color(0.16, 0.15, 0.13) });
  }

  // Corner towers.
  const ct = ARENA_STRUCT.cornerTower;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const x = ct.x * sx;
      const z = ct.z * sz;
      addBox(batch, 'stone', [5.2, ct.topY, 5.2], [x, ct.topY / 2, z], {
        tile: TILE.stone, color: pickTint(rng, 0.88, 1.02), aoBase: 0, aoTop: 3.2, minShade: 0.55,
      });
      addBox(batch, 'stone', [5.7, 0.3, 5.7], [x, ct.topY - 0.1, z], {
        tile: TILE.stone, color: pickTint(rng, 0.95, 1.09),
      });
      // Crenellations on the two arena-facing sides.
      const innerX = x - sx * 2.35;
      const innerZ = z - sz * 2.35;
      crenellations(batch, rng, { axis: 'z', fixed: innerX, from: z - 2.3, to: z + 2.3, y: ct.topY + 0.08, depth: 0.7, merlon: 0.72, gap: 0.52, height: 0.72 });
      crenellations(batch, rng, { axis: 'x', fixed: innerZ, from: x - 2.3, to: x + 2.3, y: ct.topY + 0.08, depth: 0.7, merlon: 0.72, gap: 0.52, height: 0.72 });
      // Arrow slit facing the arena.
      addBox(batch, 'stone', [0.18, 1.0, 0.3], [x - sx * 2.58, 3.1, z], { tile: TILE.stone, color: new THREE.Color(0.15, 0.14, 0.12) });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Gatehouse                                                           */
/* ------------------------------------------------------------------ */

function buildGatehouse(batch: GeoBatch, layout: ArenaLayout, rng: () => number): void {
  const g = ARENA_STRUCT.gate;
  const frontZ = g.frontZ;
  const depth = 5.4;
  const centerZ = frontZ - depth / 2;
  const stoneTop = g.stoneTopY;
  const tint = (lo = 0.88, hi = 1.04): THREE.Color => pickTint(rng, lo, hi);
  const archHalf = g.archHalf;
  const spring = g.archSpringY;

  // Piers either side of the arch.
  const pierW = g.gateHalfWidth - archHalf;
  for (const s of [-1, 1]) {
    addBox(batch, 'stone', [pierW, stoneTop, depth], [s * (archHalf + pierW / 2), stoneTop / 2, centerZ], {
      tile: TILE.stone, color: tint(), aoBase: 0, aoTop: 3.4, minShade: 0.55,
    });
  }

  // Spandrel above the arch, approximated with narrow stone columns that follow
  // the curve (reads as voussoir courses from the arena).
  const colW = 0.4;
  for (let x = -archHalf + colW / 2; x < archHalf; x += colW) {
    const inside = archHalf * archHalf - x * x;
    const archY = spring + Math.sqrt(Math.max(0, inside));
    const h = stoneTop - archY;
    if (h <= 0.02) continue;
    addBox(batch, 'stone', [colW + 0.02, h, depth], [x, archY + h / 2, centerZ], {
      tile: TILE.stone, color: tint(0.84, 1.0), aoBase: archY, aoTop: archY + 1.4, minShade: 0.72,
    });
  }

  // Arch ring voussoirs on the arena-facing front face.
  const ringR = archHalf + 0.22;
  for (let k = 0; k < 15; k++) {
    const a = Math.PI - ((k + 0.5) / 15) * Math.PI;
    const vx = Math.cos(a) * ringR;
    const vy = spring + Math.sin(a) * ringR;
    addBox(batch, 'stone', [0.34, 0.56, 0.34], [vx, vy, frontZ + 0.06], {
      tile: TILE.stone,
      rz: a - Math.PI / 2,
      color: tint(0.96, 1.1),
      aoBase: spring - 0.4,
      aoTop: spring + 1.6,
      minShade: 0.8,
    });
  }
  // Keystone.
  addBox(batch, 'stone', [0.44, 0.66, 0.38], [0, spring + ringR + 0.16, frontZ + 0.08], {
    tile: TILE.stone, color: tint(1.02, 1.12),
  });

  // Threshold step.
  addBox(batch, 'stone', [archHalf * 2 + 0.8, 0.14, 2.4], [0, 0.07, frontZ - 1.0], {
    tile: TILE.stone, color: tint(0.8, 0.95), minShade: 0.7,
  });

  // Dark tunnel interior so the arch reads deep.
  addBox(batch, 'stone', [archHalf * 2 + 0.2, 5.4, 0.18], [0, 2.7, frontZ - depth + 0.2], {
    tile: TILE.stone, color: new THREE.Color(0.09, 0.08, 0.07), minShade: 1,
  });
  for (const s of [-1, 1]) {
    addBox(batch, 'stone', [0.18, 4.6, depth - 0.4], [s * (archHalf - 0.02), 2.3, centerZ], {
      tile: TILE.stone, color: new THREE.Color(0.14, 0.12, 0.1), minShade: 1,
    });
  }

  // Opening timber doors (pushed back into the tunnel).
  for (const s of [-1, 1]) {
    addBox(batch, 'wood', [0.16, 4.3, 2.5], [s * (archHalf - 1.0), 2.15, frontZ - depth + 1.35], {
      tile: TILE.wood,
      ry: s * 0.95,
      color: pickTint(rng, 0.72, 0.9),
      aoBase: 0,
      aoTop: 2.2,
      minShade: 0.7,
    });
  }

  // Raised iron portcullis.
  for (let x = -archHalf + 0.35; x <= archHalf - 0.3; x += 0.42) {
    addCyl(batch, 'metal', 0.045, 0.045, 1.35, [x, 4.35, frontZ - 1.25], { tile: TILE.metal, seg: 6 });
  }
  addBox(batch, 'metal', [archHalf * 2 - 0.5, 0.12, 0.12], [0, 3.85, frontZ - 1.25], { tile: TILE.metal });
  addBox(batch, 'metal', [archHalf * 2 - 0.5, 0.12, 0.12], [0, 4.75, frontZ - 1.25], { tile: TILE.metal });

  // Flanking towers.
  for (const s of [-1, 1]) {
    const tx = s * g.towerX;
    addBox(batch, 'stone', [4.0, g.towerTopY, 4.6], [tx, g.towerTopY / 2, g.towerZ], {
      tile: TILE.stone, color: tint(0.88, 1.02), aoBase: 0, aoTop: 3.2, minShade: 0.55,
    });
    addBox(batch, 'stone', [4.4, 0.28, 5.0], [tx, g.towerTopY - 0.1, g.towerZ], {
      tile: TILE.stone, color: tint(0.95, 1.09),
    });
    crenellations(batch, rng, {
      axis: 'x', fixed: g.towerZ - 2.1, from: tx - 1.9, to: tx + 1.9, y: g.towerTopY + 0.05, depth: 0.66, merlon: 0.68, gap: 0.5, height: 0.8,
    });
    crenellations(batch, rng, {
      axis: 'z', fixed: tx - s * 1.8, from: g.towerZ - 2.0, to: g.towerZ + 2.0, y: g.towerTopY + 0.05, depth: 0.62, merlon: 0.68, gap: 0.5, height: 0.8,
    });
    // Arrow slit.
    addBox(batch, 'stone', [0.2, 1.0, 0.3], [tx, 3.6, g.towerZ + 2.32], { tile: TILE.stone, color: new THREE.Color(0.15, 0.14, 0.12) });
    // Wooden corner brackets where the storey oversails.
    addBox(batch, 'wood', [0.3, 0.36, 0.7], [tx - s * 1.1, stoneTop - 0.18, frontZ - 0.25], { tile: TILE.wood, color: pickTint(rng, 0.8, 1.0) });
  }

  // Jettied plaster upper storey.
  const storeyH = g.storeyTopY - stoneTop;
  const storeyW = g.gateHalfWidth * 2 + 1.6;
  const storeyD = 5.8;
  const storeyCz = frontZ + 0.2 - storeyD / 2;
  addBox(batch, 'plaster', [storeyW, storeyH, storeyD], [0, stoneTop + storeyH / 2, storeyCz], {
    tile: TILE.plaster, color: pickTint(rng, 0.94, 1.04), minShade: 1,
  });

  // Timber frame: sill, plates, corner posts, studs, braces.
  const frameZ = frontZ + 0.32;
  const sillY = stoneTop + 0.28;
  const plateY = g.storeyTopY - 0.2;
  addBox(batch, 'wood', [storeyW + 0.3, 0.34, 0.26], [0, sillY, frameZ], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.88) });
  addBox(batch, 'wood', [storeyW + 0.5, 0.3, 0.28], [0, plateY, frameZ], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.88) });
  for (const s of [-1, 1]) {
    addBox(batch, 'wood', [0.3, storeyH, 0.28], [s * (storeyW / 2 - 0.12), stoneTop + storeyH / 2, frameZ], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.9) });
  }
  const studXs = [-7.0, -5.3, -1.5, 1.5, 5.3, 7.0];
  for (const sx of studXs) {
    addBox(batch, 'wood', [0.2, storeyH - 0.6, 0.24], [sx, stoneTop + storeyH / 2 + 0.05, frameZ], {
      tile: TILE.wood, color: pickTint(rng, 0.75, 0.92), aoBase: stoneTop, aoTop: stoneTop + 2.4, minShade: 0.8,
    });
  }
  // Diagonal braces near the corners.
  for (const s of [-1, 1]) {
    addBox(batch, 'wood', [0.2, 1.5, 0.22], [s * 5.7, stoneTop + 1.0, frameZ], { tile: TILE.wood, rz: s * 0.6, color: pickTint(rng, 0.72, 0.88) });
    addBox(batch, 'wood', [0.2, 1.5, 0.22], [s * 5.7, g.storeyTopY - 1.0, frameZ], { tile: TILE.wood, rz: -s * 0.6, color: pickTint(rng, 0.72, 0.88) });
  }
  // Windows with dark recess and open shutters.
  for (const wx of [-3.4, 0, 3.4]) {
    addBox(batch, 'stone', [1.05, 1.2, 0.14], [wx, stoneTop + 1.68, frameZ + 0.02], {
      tile: TILE.stone, color: new THREE.Color(0.07, 0.065, 0.055), minShade: 1, aoBase: 0, aoTop: 0.01,
    });
    for (const s of [-1, 1]) {
      addBox(batch, 'wood', [0.52, 1.2, 0.08], [wx + s * 0.82, stoneTop + 1.68, frameZ + 0.24], {
        tile: TILE.wood, ry: s * 0.62, color: pickTint(rng, 0.7, 0.86),
      });
    }
    addBox(batch, 'wood', [1.24, 0.12, 0.3], [wx, stoneTop + 1.05, frameZ + 0.14], { tile: TILE.wood, color: pickTint(rng, 0.78, 0.94) });
  }

  // Side timber framing (simplified).
  for (const s of [-1, 1]) {
    const sideX = s * (storeyW / 2 + 0.14);
    addBox(batch, 'wood', [0.24, storeyH, 0.26], [sideX, stoneTop + storeyH / 2, frameZ], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.9) });
    addBox(batch, 'wood', [0.24, 0.26, storeyD], [sideX, sillY, storeyCz], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.88) });
    addBox(batch, 'wood', [0.24, 0.26, storeyD], [sideX, plateY, storeyCz], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.88) });
  }

  // Gable roof.
  const ridgeY = g.ridgeY;
  const eaveY = g.storeyTopY;
  const halfRoof = storeyW / 2 + 0.6;
  const roofDepth = 7.4;
  const rise = ridgeY - eaveY;
  const slopeLen = Math.hypot(halfRoof, rise) + 0.5;
  const angle = Math.atan2(rise, halfRoof);
  const roofCz = storeyCz;
  for (const s of [-1, 1]) {
    addBox(batch, 'shingle', [slopeLen, 0.2, roofDepth], [s * (halfRoof / 2 - 0.15), eaveY + rise / 2, roofCz], {
      tile: TILE.shingle,
      rz: -s * angle,
      color: pickTint(rng, 0.92, 1.05),
    });
    // Rafters / fascia along the eave.
    addBox(batch, 'wood', [0.22, 0.24, roofDepth + 0.2], [s * (halfRoof - 0.1), eaveY - 0.12, roofCz], { tile: TILE.wood, color: pickTint(rng, 0.72, 0.88) });
    // Purlin under the roof.
    addBox(batch, 'wood', [0.18, 0.2, roofDepth + 0.1], [s * 4.0, eaveY + rise * 0.5 - 0.16, roofCz], { tile: TILE.wood, color: pickTint(rng, 0.7, 0.86) });
  }
  addBox(batch, 'wood', [0.3, 0.3, roofDepth + 0.4], [0, ridgeY + 0.02, roofCz], { tile: TILE.wood, color: pickTint(rng, 0.7, 0.86) });
  // Ridge finials.
  for (const s of [-1, 1]) {
    addCyl(batch, 'wood', 0.02, 0.09, 0.8, [0, ridgeY + 0.42, roofCz + s * (roofDepth / 2 - 0.1)], { tile: TILE.wood, seg: 6 });
  }

  // Gable triangles front and back with timber framing.
  const gableZ = frontZ + 0.24;
  batch.add('plaster', triPrism(halfRoof - 0.1, eaveY, ridgeY, 0.5, gableZ - 0.34, TILE.plaster), {
    color: pickTint(rng, 0.96, 1.05),
    aoBase: eaveY,
    aoTop: ridgeY,
    minShade: 0.92,
  });
  // Timber on the gable: tie beam, king post, rafter edges.
  addBox(batch, 'wood', [halfRoof * 2 - 0.2, 0.26, 0.3], [0, eaveY + 0.12, gableZ - 0.15], { tile: TILE.wood, color: pickTint(rng, 0.7, 0.88) });
  addBox(batch, 'wood', [0.22, rise + 0.1, 0.28], [0, eaveY + rise / 2, gableZ - 0.15], { tile: TILE.wood, color: pickTint(rng, 0.7, 0.88) });
  for (const s of [-1, 1]) {
    addBox(batch, 'wood', [slopeLen - 0.6, 0.2, 0.26], [s * (halfRoof / 2 - 0.2), eaveY + rise / 2 + 0.1, gableZ - 0.15], {
      tile: TILE.wood, rz: -s * angle, color: pickTint(rng, 0.7, 0.88),
    });
    addBox(batch, 'wood', [0.16, 0.9, 0.24], [s * 3.2, eaveY + rise * 0.45, gableZ - 0.15], { tile: TILE.wood, color: pickTint(rng, 0.7, 0.88) });
  }
}

/* ------------------------------------------------------------------ */
/* Wooden spectator stands                                             */
/* ------------------------------------------------------------------ */

function buildStand(batch: GeoBatch, layout: ArenaLayout, stand: StandDef, rng: () => number): void {
  const len = stand.max - stand.min;
  const along = (stand.min + stand.max) / 2;
  const woodKey = 'wood';
  const woodTint = (lo = 0.78, hi = 1.0): THREE.Color => pickTint(rng, lo, hi);
  const boxAlong = (
    key: string,
    thickness: number,
    height: number,
    length: number,
    spine: number,
    y: number,
    alongPos: number,
    opts: { color?: THREE.Color | number; aoBase?: number; aoTop?: number; minShade?: number } = {},
  ): void => {
    const size: [number, number, number] = stand.axis === 'z' ? [thickness, height, length] : [length, height, thickness];
    const pos: [number, number, number] = stand.axis === 'z' ? [spine, y, alongPos] : [alongPos, y, spine];
    addBox(batch, key, size, pos, { tile: TILE.wood, color: opts.color ?? woodTint(), ...opts });
  };

  /* Under-structure & facade */
  boxAlong(woodKey, 0.3, 4.0, len, stand.fasciaSpine - 0.2, 2.0, along, { color: woodTint(0.72, 0.9), aoBase: 0, aoTop: 2.2, minShade: 0.6 });
  // Front fascia board above the wall.
  boxAlong(woodKey, 0.16, 1.85, len, stand.fasciaSpine, 4.55, along, { color: woodTint(0.74, 0.9), aoBase: 3.6, aoTop: 5.4, minShade: 0.86 });
  // Bench rows.
  for (let r = 0; r < stand.rows; r++) {
    const spine = stand.frontSpine - r * stand.rowDepth;
    const y = stand.baseY + r * stand.rowRise;
    // Deck.
    boxAlong(woodKey, stand.rowDepth - 0.04, 0.1, len, spine, y - 0.14, along, { color: woodTint(0.7, 0.86), aoBase: y - 1.5, aoTop: y, minShade: 0.7 });
    // Bench plank.
    boxAlong(woodKey, 0.42, 0.09, len, spine, y, along, { color: woodTint(0.82, 1.0), aoBase: y - 1.2, aoTop: y, minShade: 0.78 });
    // Riser board at the front of each tier.
    boxAlong(woodKey, 0.08, stand.rowRise + 0.14, len, spine + stand.rowDepth / 2, y - stand.rowRise / 2 - 0.02, along, {
      color: woodTint(0.66, 0.82), aoBase: y - 1.2, aoTop: y, minShade: 0.7,
    });
    // Support posts under the deck.
    for (let a = stand.min + 1.4; a < stand.max; a += 3.7) {
      boxAlong(woodKey, 0.16, Math.max(0.4, y - 0.2), 0.16, spine, (y - 0.2) / 2, a, {
        color: woodTint(0.82, 1.0), aoBase: 0, aoTop: 2.4, minShade: 0.66,
      });
    }
  }
  // Front railing.
  for (let a = stand.min; a <= stand.max + 0.01; a += 2.6) {
    boxAlong(woodKey, 0.12, 1.5, 0.14, stand.railSpine, stand.baseY + 0.82, a, { color: woodTint(0.72, 0.9) });
  }
  boxAlong(woodKey, 0.13, 0.13, len, stand.railSpine, ARENA_STRUCT.railTopY, along, { color: woodTint(0.84, 1.0) });
  boxAlong(woodKey, 0.1, 0.1, len, stand.railSpine, ARENA_STRUCT.railTopY - 0.42, along, { color: woodTint(0.72, 0.88) });

  // Roof support posts (back row) and front posts.
  for (let a = stand.min + 0.4; a <= stand.max; a += 4.8) {
    boxAlong(woodKey, 0.26, stand.roofFrontY - stand.baseY + 0.5, 0.26, stand.fasciaSpine - 0.55, (stand.roofFrontY + stand.baseY - 0.5) / 2, a, {
      color: woodTint(0.7, 0.86), aoBase: 3.4, aoTop: 6, minShade: 0.8,
    });
    boxAlong(woodKey, 0.26, stand.roofBackY - 0.2, 0.26, stand.backWallSpine + 0.35, (stand.roofBackY - 0.2) / 2, a, {
      color: woodTint(0.82, 1.0), aoBase: 0, aoTop: 3, minShade: 0.62,
    });
    // Diagonal brace at the front post.
    const braceH = 1.6;
    const braceSize: [number, number, number] = stand.axis === 'z' ? [0.16, braceH, 0.16] : [0.16, braceH, 0.16];
    const bracePos: [number, number, number] =
      stand.axis === 'z'
        ? [stand.fasciaSpine - 0.55, stand.roofFrontY - 1.0, a]
        : [a, stand.roofFrontY - 1.0, stand.fasciaSpine - 0.55];
    addBox(batch, woodKey, braceSize, bracePos, {
      tile: TILE.wood,
      color: woodTint(0.68, 0.84),
      ...(stand.axis === 'z' ? { rz: 0.42 } : { rx: -0.42 }),
    });
  }

  /* Back and side walls (planked). */
  boxAlong(woodKey, 0.2, stand.roofBackY + 0.1, len, stand.backWallSpine, (stand.roofBackY + 0.1) / 2, along, {
    color: woodTint(0.86, 1.06), aoBase: 0, aoTop: 3, minShade: 0.68,
  });
  for (const a of [stand.min - 0.08, stand.max + 0.08]) {
    const size: [number, number, number] = stand.axis === 'z' ? [Math.abs(stand.backWallSpine - stand.fasciaSpine) + 0.4, stand.roofBackY + 0.1, 0.18] : [0.18, stand.roofBackY + 0.1, Math.abs(stand.backWallSpine - stand.fasciaSpine) + 0.4];
    const spineMid = (stand.backWallSpine + stand.fasciaSpine) / 2;
    const pos: [number, number, number] = stand.axis === 'z' ? [spineMid, (stand.roofBackY + 0.1) / 2, a] : [a, (stand.roofBackY + 0.1) / 2, spineMid];
    addBox(batch, woodKey, size, pos, { tile: TILE.wood, color: woodTint(1.0, 1.22), aoBase: 0, aoTop: 3, minShade: 0.82 });
  }

  /* Roof */
  const dz = stand.roofFrontSpine - stand.roofBackSpine;
  const dy = stand.roofBackY - stand.roofFrontY;
  const slopeLen = Math.hypot(dz, dy) + 0.7;
  const midSpine = (stand.roofFrontSpine + stand.roofBackSpine) / 2;
  const midY = (stand.roofFrontY + stand.roofBackY) / 2;
  if (stand.axis === 'z') {
    // West stand: slope runs along x, rotate about z.
    const angleZ = Math.atan2(-dy, Math.abs(dz));
    addBox(batch, 'shingle', [slopeLen, 0.2, len + 1.2], [midSpine, midY, along], {
      tile: TILE.shingle, rz: angleZ, color: pickTint(rng, 0.9, 1.04),
    });
    addBox(batch, 'wood', [0.24, 0.26, len + 1.1], [stand.roofFrontSpine - 0.1, stand.roofFrontY - 0.15, along], { tile: TILE.wood, color: woodTint(0.72, 0.88) });
    // Purlins under the roof.
    for (const f of [0.32, 0.68]) {
      const spine = stand.roofFrontSpine + (stand.roofBackSpine - stand.roofFrontSpine) * f;
      const y = stand.roofFrontY + (stand.roofBackY - stand.roofFrontY) * f - 0.18;
      addBox(batch, 'wood', [0.18, 0.2, len + 0.4], [spine, y, along], { tile: TILE.wood, color: woodTint(0.68, 0.84) });
    }
    // Rafters every 4.8 m, sitting under the shingles.
    for (let a = stand.min + 0.6; a <= stand.max; a += 4.8) {
      addBox(batch, 'wood', [slopeLen - 0.5, 0.2, 0.18], [midSpine, midY - 0.22, a], {
        tile: TILE.wood, rz: angleZ, color: woodTint(0.68, 0.84),
      });
    }
  } else {
    // North stands: slope runs along z, rotate about x.
    const angleX = Math.atan2(-dy, Math.abs(dz));
    addBox(batch, 'shingle', [len + 1.2, 0.2, slopeLen], [along, midY, midSpine], {
      tile: TILE.shingle, rx: angleX, color: pickTint(rng, 0.9, 1.04),
    });
    addBox(batch, 'wood', [len + 1.1, 0.26, 0.24], [along, stand.roofFrontY - 0.15, stand.roofFrontSpine - 0.1], { tile: TILE.wood, color: woodTint(0.72, 0.88) });
    for (const f of [0.32, 0.68]) {
      const spine = stand.roofFrontSpine + (stand.roofBackSpine - stand.roofFrontSpine) * f;
      const y = stand.roofFrontY + (stand.roofBackY - stand.roofFrontY) * f - 0.18;
      addBox(batch, 'wood', [len + 0.4, 0.2, 0.18], [along, y, spine], { tile: TILE.wood, color: woodTint(0.68, 0.84) });
    }
    for (let a = stand.min + 0.6; a <= stand.max; a += 4.8) {
      addBox(batch, 'wood', [0.18, 0.2, slopeLen - 0.5], [a, midY - 0.22, midSpine], {
        tile: TILE.wood, rx: angleX, color: woodTint(0.68, 0.84),
      });
    }
  }
  void layout;
}

/* ------------------------------------------------------------------ */
/* Public                                                              */
/* ------------------------------------------------------------------ */

export function buildStructures(batch: GeoBatch, layout: ArenaLayout, seed: number): void {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  buildCurtainWall(batch, layout, rng);
  buildGatehouse(batch, layout, rng);
  for (const stand of layout.stands) {
    buildStand(batch, layout, stand, rng);
    // Stone end piers ground the timber stands against the curtain wall.
    const depth = Math.abs(stand.backWallSpine - stand.fasciaSpine) + 0.9;
    for (const a of [stand.min, stand.max]) {
      const size: [number, number, number] =
        stand.axis === 'z' ? [depth, stand.roofFrontY - 0.4, 1.05] : [1.05, stand.roofFrontY - 0.4, depth];
      const spineMid = (stand.backWallSpine + stand.fasciaSpine) / 2 + 0.2;
      const pos: [number, number, number] =
        stand.axis === 'z' ? [spineMid, (stand.roofFrontY - 0.4) / 2, a] : [a, (stand.roofFrontY - 0.4) / 2, spineMid];
      addBox(batch, 'stone', size, pos, {
        tile: TILE.stone,
        color: pickTint(rng, 0.88, 1.04),
        aoBase: 0,
        aoTop: 3.6,
        minShade: 0.66,
      });
    }
  }
}

/** Small decorative extras that belong to the timber batch. */
export function buildTimberFences(batch: GeoBatch, seed: number): void {
  const rng = mulberry32((seed ^ 0x51ed270b) >>> 0);
  const tint = (): THREE.Color => pickTint(rng, 0.7, 0.92);
  // Fence run by the north-west corner, a pen for the melee gates.
  const run = (x0: number, z0: number, x1: number, z1: number): void => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const yaw = Math.atan2(x1 - x0, z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    addBox(batch, 'wood', [0.12, 1.0, len], [cx, 0.5, cz], { tile: TILE.wood, ry: yaw, color: tint(), aoBase: 0, aoTop: 1.4, minShade: 0.6 });
    addBox(batch, 'wood', [0.1, 0.12, len], [cx, 0.86, cz], { tile: TILE.wood, ry: yaw, color: tint() });
    addBox(batch, 'wood', [0.1, 0.12, len], [cx - 0.0, 0.46, cz], { tile: TILE.wood, ry: yaw, color: tint() });
    const posts = Math.max(2, Math.round(len / 2.2));
    for (let i = 0; i <= posts; i++) {
      const t = i / posts;
      addBox(batch, 'wood', [0.16, 1.15, 0.16], [x0 + (x1 - x0) * t, 0.57, z0 + (z1 - z0) * t], {
        tile: TILE.wood, color: tint(), aoBase: 0, aoTop: 1.2, minShade: 0.6,
      });
    }
  };
  run(-21.6, -21.2, -14.2, -21.2);
  run(-21.6, 18.4, -16.0, 18.4);
  run(14.4, 19.6, 21.8, 19.6);
}
