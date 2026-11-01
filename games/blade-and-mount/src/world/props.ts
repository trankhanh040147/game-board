import * as THREE from 'three';
import { addBox, addCyl, cylGeo, GeoBatch, mergedMesh, paintVertexColors } from './geo';
import type { ArenaLayout } from './layout';
import type { ArenaTextureBank } from './textures';
import { TILE } from './textures';
import { clamp, mulberry32 } from '../core/utils';

/**
 * Arena dressing: the big weathered boulder, barrels, crates, hay, a weapon
 * rack, a cart, braziers with flickering flames, pebbles, blood decals, the
 * trees beyond the walls and the drifting dust motes in the air.
 */

export interface PropsSystem {
  group: THREE.Group;
  update(dt: number, time: number): void;
  dispose(): void;
}

function hash3(x: number, y: number, z: number, seed: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed * 43.1) * 43758.5453;
  return n - Math.floor(n);
}

/* ------------------------------------------------------------------ */
/* Boulders                                                            */
/* ------------------------------------------------------------------ */

function boulderGeometry(seed: number, radius: number, squash: number, detail: number): THREE.BufferGeometry {
  const geo = new THREE.IcosahedronGeometry(1, detail);
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * 2.4, uv.getY(i) * 2.4);
  geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n1 = hash3(Math.round(v.x * 2.3), Math.round(v.y * 2.3), Math.round(v.z * 2.3), seed);
    const n2 = hash3(Math.round(v.x * 5.1) + 7, Math.round(v.y * 5.1) + 3, Math.round(v.z * 5.1) + 1, seed + 5);
    const noise = (n1 - 0.5) * 0.3 + (n2 - 0.5) * 0.11;
    const len = v.length() || 1;
    v.multiplyScalar((1 + noise) / len);
    v.multiplyScalar(radius);
    v.y *= squash;
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  // Weathered colouring: warm top, mossy damp base, dark crevices.
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  const warm = new THREE.Color('#f0e6d2');
  const cool = new THREE.Color('#d8d0c0');
  const moss = new THREE.Color('#c0c69a');
  const dark = new THREE.Color('#c4bba8');
  const nrm = geo.getAttribute('normal');
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const up = clamp(nrm.getY(i) * 0.5 + 0.5, 0, 1);
    const h = clamp((y / Math.max(0.2, radius * squash)) * 0.5 + 0.5, 0, 1);
    c.copy(dark).lerp(warm, 0.35 + up * 0.4 + h * 0.25);
    c.lerp(cool, 0.25);
    if (h < 0.35) c.lerp(moss, (0.35 - h) * 1.1);
    const speck = 0.9 + hash3(pos.getX(i), pos.getY(i), pos.getZ(i), seed + 11) * 0.2;
    colors[i * 3] = c.r * speck;
    colors[i * 3 + 1] = c.g * speck;
    colors[i * 3 + 2] = c.b * speck;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geo;
}

function buildBoulders(group: THREE.Group, material: THREE.Material, seed: number): void {
  const rng = mulberry32(seed);
  const placements = [
    { x: 11.4, y: 0.58, z: -0.4, r: 3.3, squash: 0.52, detail: 5, ry: 0.6 },
    { x: 13.1, y: 0.12, z: 2.8, r: 1.15, squash: 0.5, detail: 3, ry: 2.1 },
    { x: -14.0, y: 0.22, z: 9.0, r: 1.5, squash: 0.55, detail: 3, ry: 1.2 },
    { x: -21.0, y: 0.18, z: -13.2, r: 0.95, squash: 0.5, detail: 2, ry: 0.2 },
  ];
  const geos: THREE.BufferGeometry[] = [];
  for (const p of placements) {
    const geo = boulderGeometry(seed + p.x * 7.3 + p.z * 2.1 + rng() * 10, p.r, p.squash, p.detail);
    geo.rotateY(p.ry);
    geo.translate(p.x, p.y, p.z);
    geos.push(geo);
  }
  const mesh = mergedMesh(geos, material, 'boulders', true, true);
  if (mesh) group.add(mesh);
}

/* ------------------------------------------------------------------ */
/* Static props (batched)                                              */
/* ------------------------------------------------------------------ */

function buildCrates(batch: GeoBatch, rng: () => number, x: number, z: number): void {
  const crates = [
    { x: x, z: z, s: 1.15, ry: 0.15, y: 0.575 },
    { x: x + 1.28, z: z + 0.35, s: 0.92, ry: -0.4, y: 0.46 },
    { x: x + 0.55, z: z + 1.15, s: 0.8, ry: 0.6, y: 0.4 },
    { x: x + 0.15, z: z + 0.15, s: 0.78, ry: 0.9, y: 1.54 },
  ];
  for (const c of crates) {
    addBox(batch, 'wood', [c.s, c.s, c.s], [c.x, c.y, c.z], {
      tile: TILE.wood, ry: c.ry, color: new THREE.Color(0.92, 0.88, 0.82), aoBase: 0, aoTop: 1.4, minShade: 0.6,
    });
    // Corner battens.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addBox(batch, 'wood', [0.1, c.s + 0.02, 0.1], [c.x + sx * c.s * 0.46, c.y, c.z + sz * c.s * 0.46], {
          tile: TILE.wood, ry: c.ry, color: new THREE.Color(0.62, 0.56, 0.48),
        });
      }
    }
    addBox(batch, 'wood', [c.s + 0.03, 0.08, 0.1], [c.x, c.y + c.s * 0.32, c.z], {
      tile: TILE.wood, ry: c.ry, color: new THREE.Color(0.66, 0.6, 0.5),
    });
    if (rng() > 0.4) {
      addBox(batch, 'wood', [c.s * 0.6, 0.12, c.s * 0.6], [c.x - 0.3, c.y + c.s / 2 + 0.05, c.z], {
        tile: TILE.wood, ry: c.ry + 0.5, color: new THREE.Color(0.72, 0.66, 0.56),
      });
    }
  }
}

function buildBarrels(batch: GeoBatch, rng: () => number, x: number, z: number): void {
  const spots = [
    { dx: 0, dz: 0, s: 1 },
    { dx: 0.95, dz: 0.25, s: 0.9 },
    { dx: 0.3, dz: 0.95, s: 0.95 },
    { dx: 1.05, dz: 1.05, s: 0.85 },
  ];
  for (const s of spots) {
    const px = x + s.dx;
    const pz = z + s.dz;
    const h = 0.9 * s.s;
    const r = 0.34 * s.s;
    addCyl(batch, 'wood', r * 0.86, r * 0.86, h, [px, h / 2, pz], { tile: TILE.wood, seg: 10, color: new THREE.Color(0.95, 0.88, 0.76) });
    addCyl(batch, 'wood', r, r, h * 0.7, [px, h / 2, pz], { tile: TILE.wood, seg: 10, color: new THREE.Color(0.95, 0.88, 0.76) });
    for (const hy of [0.18, 0.72]) {
      addCyl(batch, 'metal', r * 1.02, r * 1.02, 0.06, [px, h * hy, pz], { tile: TILE.metal, seg: 10 });
    }
    // Lid.
    addCyl(batch, 'wood', r * 0.8, r * 0.8, 0.05, [px, h + 0.02, pz], { tile: TILE.wood, seg: 10, color: new THREE.Color(0.8, 0.72, 0.6) });
    if (rng() > 0.6) {
      addBox(batch, 'wood', [0.28, 0.16, 0.28], [px + 0.05, h + 0.1, pz - 0.05], { tile: TILE.wood, ry: rng(), color: new THREE.Color(0.66, 0.6, 0.5) });
    }
  }
}

function buildHay(batch: GeoBatch, rng: () => number): void {
  const bales = [
    { x: 7.3, z: 20.0, s: 1.35, y: 0.42, ry: 0.1 },
    { x: 8.6, z: 20.15, s: 1.2, y: 0.38, ry: -0.25 },
    { x: 7.85, z: 19.8, s: 1.05, y: 1.16, ry: 0.5 },
    { x: -10.7, z: 20.2, s: 1.1, y: 0.35, ry: 0.4 },
  ];
  for (const b of bales) {
    addBox(batch, 'hay', [b.s * 1.5, b.s * 0.68, b.s], [b.x, b.y, b.z], {
      tile: TILE.hay, ry: b.ry, color: new THREE.Color(1, 1, 1), aoBase: 0, aoTop: 1.0, minShade: 0.62,
    });
    for (const t of [-0.35, 0.35]) {
      addBox(batch, 'wood', [b.s * 1.52, 0.035, 0.035], [b.x, b.y + b.s * 0.2, b.z + t * b.s], {
        tile: 1, ry: b.ry, color: new THREE.Color(0.42, 0.34, 0.22),
      });
    }
  }
  // Loose straw heaps on the sand.
  for (let i = 0; i < 6; i++) {
    addBox(batch, 'hay', [0.6 + rng() * 1.1, 0.08 + rng() * 0.1, 0.5 + rng() * 0.6], [
      6.0 + rng() * 4.5, 0.05, 18.4 + rng() * 3.4,
    ], { tile: TILE.hay, ry: rng() * 3, color: new THREE.Color(0.92, 0.86, 0.74), minShade: 0.7 });
  }
}

function buildWeaponRack(batch: GeoBatch, rng: () => number, x: number, z: number): void {
  const yaw = 0.18;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const place = (lx: number, lz: number): [number, number] => [x + lx * c - lz * s, z + lx * s + lz * c];
  // A-frame legs at both ends.
  for (const side of [-1, 1]) {
    for (const lean of [-1, 1]) {
      const [px, pz] = place(side * 1.2, lean * 0.32);
      addBox(batch, 'wood', [0.12, 2.1, 0.12], [px, 1.02, pz], { tile: TILE.wood, rz: lean * 0.2, ry: yaw, color: new THREE.Color(0.74, 0.66, 0.54) });
    }
  }
  const [cx, cz] = place(0, 0);
  addBox(batch, 'wood', [2.7, 0.14, 0.16], [cx, 1.62, cz], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.8, 0.72, 0.6) });
  addBox(batch, 'wood', [2.7, 0.12, 0.14], [cx, 0.72, cz], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.7, 0.62, 0.5) });
  // Spears leaning on the rack.
  for (let i = 0; i < 4; i++) {
    const lx = -0.95 + i * 0.62;
    const [px, pz] = place(lx, 0.16);
    addCyl(batch, 'wood', 0.028, 0.032, 2.55, [px, 1.25, pz], {
      tile: 1.2, seg: 5, rz: 0.16, ry: yaw, color: new THREE.Color(0.86, 0.78, 0.62),
    });
    addBox(batch, 'metal', [0.06, 0.34, 0.1], [px - 0.2, 2.5, pz], { tile: TILE.metal, rz: 0.16, ry: yaw });
  }
  // Practice swords resting on the lower bar.
  for (let i = 0; i < 3; i++) {
    const lx = -0.7 + i * 0.7;
    const [px, pz] = place(lx, -0.1);
    addBox(batch, 'metal', [0.035, 0.9, 0.09], [px, 1.2, pz], { tile: TILE.metal, rz: 0.3, ry: yaw });
    addBox(batch, 'wood', [0.2, 0.06, 0.09], [px - 0.14, 0.78, pz], { tile: TILE.wood, rz: 0.3, ry: yaw, color: new THREE.Color(0.6, 0.5, 0.38) });
  }
  // A shield leaning against the rack (house colours).
  const [sx, sz] = place(1.55, -0.1);
  addBox(batch, 'wood', [0.7, 0.9, 0.07], [sx, 0.45, sz], { tile: TILE.wood, ry: yaw + 0.5, rz: 0.14, color: new THREE.Color(0.55, 0.2, 0.18) });
  addBox(batch, 'metal', [0.12, 0.12, 0.05], [sx - 0.05, 0.45, sz + 0.05], { tile: TILE.metal, ry: yaw + 0.5 });
  void rng;
}

function buildDebris(batch: GeoBatch, rng: () => number): void {
  const tint = (lo = 0.72, hi = 0.98): THREE.Color => {
    const v = lo + rng() * (hi - lo);
    return new THREE.Color(v, v, v);
  };
  // Fallen planks scattered across the lists.
  const plankSpots: [number, number, number][] = [
    [-3.1, 3.4, 0.35],
    [-2.4, 4.1, -0.6],
    [2.6, 1.4, 0.8],
    [5.4, -3.1, 0.2],
    [-6.1, -2.2, 1.1],
  ];
  for (const [x, z, ry] of plankSpots) {
    const len = 1.1 + rng() * 1.0;
    addBox(batch, 'wood', [len, 0.07, 0.24], [x, 0.035, z], {
      tile: TILE.wood, ry, color: tint(0.45, 0.66), minShade: 0.68,
    });
  }
  // A dropped shield face-up, house colours.
  for (const [x, z, ry, col] of [
    [2.2, 2.3, 1.1, new THREE.Color(0.34, 0.12, 0.1)],
    [-4.2, 5.6, -0.4, new THREE.Color(0.12, 0.17, 0.3)],
  ] as [number, number, number, THREE.Color][]) {
    addBox(batch, 'wood', [0.58, 0.05, 0.8], [x, 0.03, z], { tile: TILE.wood, ry, color: col, minShade: 0.8 });
    addBox(batch, 'metal', [0.12, 0.05, 0.12], [x, 0.06, z], { tile: TILE.metal, ry });
  }
  // Spears left standing in the sand.
  for (const [x, z, rz] of [
    [6.2, -2.2, 0.32],
    [-7.6, 6.8, -0.28],
    [1.4, -6.4, 0.2],
  ] as [number, number, number][]) {
    addCyl(batch, 'wood', 0.026, 0.03, 2.35, [x, 1.12, z], { tile: 1.2, seg: 5, rz, ry: rng() * 3, color: tint(0.75, 0.95) });
    addBox(batch, 'metal', [0.06, 0.3, 0.1], [x - Math.sin(rz) * 1.15, 2.26, z], { tile: TILE.metal, rz });
  }
  // Tipped sack and a broken cart wheel.
  addCyl(batch, 'hay', 0.26, 0.34, 0.52, [-5.4, 0.24, -5.2], { tile: TILE.hay, seg: 8, rx: 1.2, ry: 0.4, color: new THREE.Color(0.74, 0.7, 0.62) });
  addCyl(batch, 'wood', 0.46, 0.46, 0.1, [4.6, 0.05, 6.1], { tile: TILE.wood, seg: 12, rx: Math.PI / 2, ry: 0.8, color: tint(0.66, 0.86) });
  addCyl(batch, 'metal', 0.5, 0.5, 0.04, [4.6, 0.05, 6.1], { tile: TILE.metal, seg: 12, rx: Math.PI / 2, ry: 0.8 });
  // Loose straw piles.
  for (let i = 0; i < 6; i++) {
    addBox(batch, 'hay', [0.4 + rng() * 0.7, 0.05 + rng() * 0.05, 0.32 + rng() * 0.5], [
      -8 + rng() * 16, 0.025, -7 + rng() * 14,
    ], { tile: TILE.hay, ry: rng() * 3, color: new THREE.Color(0.7, 0.66, 0.58), minShade: 0.72 });
  }
}

function buildCart(batch: GeoBatch, x: number, z: number, yaw: number): void {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const place = (lx: number, lz: number): [number, number] => [x + lx * c - lz * s, z + lx * s + lz * c];
  // Bed.
  const [bx, bz] = place(0, 0);
  addBox(batch, 'wood', [2.1, 0.16, 1.15], [bx, 0.92, bz], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.84, 0.76, 0.62) });
  for (const side of [-1, 1]) {
    const [px, pz] = place(0, side * 0.56);
    addBox(batch, 'wood', [2.1, 0.38, 0.09], [px, 1.2, pz], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.72, 0.64, 0.5) });
  }
  // Draw pole.
  const [dx, dz] = place(1.4, 0);
  addBox(batch, 'wood', [1.4, 0.1, 0.12], [dx + 0.55, 1.08, dz], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.68, 0.6, 0.46) });
  // Wheels.
  for (const side of [-1, 1]) {
    for (const end of [-0.7, 0.7]) {
      const [wx, wz] = place(end, side * 0.72);
      addCyl(batch, 'wood', 0.42, 0.42, 0.1, [wx, 0.44, wz], {
        tile: TILE.wood, seg: 12, rx: Math.PI / 2, ry: yaw, color: new THREE.Color(0.7, 0.62, 0.48),
      });
      addCyl(batch, 'metal', 0.45, 0.45, 0.045, [wx, 0.44, wz], { tile: TILE.metal, seg: 12, rx: Math.PI / 2, ry: yaw });
      addCyl(batch, 'wood', 0.08, 0.08, 0.16, [wx, 0.44, wz], { tile: TILE.wood, seg: 6, rx: Math.PI / 2, ry: yaw, color: new THREE.Color(0.5, 0.44, 0.34) });
    }
  }
  // A little hay load.
  addBox(batch, 'hay', [1.6, 0.5, 0.9], [bx - 0.1, 1.25, bz], { tile: TILE.hay, ry: yaw, color: new THREE.Color(0.96, 0.9, 0.78) });
}

/* ------------------------------------------------------------------ */
/* Pebbles + blood decals                                             */
/* ------------------------------------------------------------------ */

function buildPebbles(group: THREE.Group, layout: ArenaLayout, quality: 'low' | 'medium' | 'high', seed: number): void {
  const rng = mulberry32((seed ^ 0x2c1b3c6d) >>> 0);
  const count = quality === 'high' ? 180 : quality === 'medium' ? 120 : 60;
  const geo = new THREE.DodecahedronGeometry(1, 0);
  const mat = new THREE.MeshStandardMaterial({ color: 0x9a8f76, roughness: 0.98, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'pebbles';
  mesh.castShadow = false;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    p.set((rng() - 0.5) * layout.bounds.maxX * 1.9, 0.02, (rng() - 0.5) * layout.bounds.maxZ * 1.9);
    const sc = 0.024 + rng() * 0.065;
    s.set(sc * (0.8 + rng() * 0.8), sc * 0.55, sc * (0.8 + rng() * 0.8));
    q.setFromEuler(new THREE.Euler(rng() * 0.6, rng() * Math.PI * 2, rng() * 0.6));
    m.compose(p, q, s);
    mesh.setMatrixAt(i, m);
    const v = 0.75 + rng() * 0.4;
    col.setRGB(v, v * 0.95, v * 0.86);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
}

function buildBloodDecals(group: THREE.Group, layout: ArenaLayout, textures: ArenaTextureBank, seed: number): void {
  const rng = mulberry32((seed ^ 0x63b91f7d) >>> 0);
  const spots: [number, number, number][] = [
    [-2.4, -4.2, 1.5],
    [4.6, 3.4, 1.2],
    [-7.5, 1.8, 1.1],
    [8.9, -8.2, 1.3],
    [-11.5, 12.2, 1.0],
    [13.6, 9.4, 1.1],
    [-4.2, 16.4, 0.9],
    [7.2, 14.8, 1.2],
  ];
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < spots.length; i++) {
    const [x, z, scale] = spots[i];
    const geo = new THREE.PlaneGeometry(scale * (0.8 + rng() * 0.7), scale * (0.7 + rng() * 0.6));
    geo.rotateX(-Math.PI / 2);
    geo.rotateY(rng() * Math.PI * 2);
    geo.translate(x + (rng() - 0.5) * 1.2, 0.012 + i * 0.0008, z + (rng() - 0.5) * 1.2);
    geos.push(geo);
  }
  const mat = new THREE.MeshStandardMaterial({
    map: textures.blood,
    transparent: true,
    opacity: 0.15,
    color: 0x4a0f0c,
    roughness: 0.75,
    metalness: 0,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });
  const mesh = mergedMesh(geos, mat, 'blood-decals', false, false);
  if (mesh) {
    mesh.renderOrder = 2;
    group.add(mesh);
  }
  void layout;
}

/* ------------------------------------------------------------------ */
/* Trees beyond the walls                                              */
/* ------------------------------------------------------------------ */

function buildTrees(group: THREE.Group, seed: number): void {
  const rng = mulberry32((seed ^ 0x4e6f7a11) >>> 0);
  const geos: THREE.BufferGeometry[] = [];
  const trunkColor = new THREE.Color('#4a3a29');
  const leafPalettes = [
    ['#3a4c2a', '#455a32', '#52673a', '#2e3f22'],
    ['#455231', '#50603a', '#5b6b42', '#39472a'],
    ['#3d5133', '#48603c', '#546c46', '#2f4028'],
  ];

  const addTree = (x: number, z: number, h: number, detail: number, distant: boolean): void => {
    const trunkH = h * (0.46 + rng() * 0.12);
    const trunkR = (0.16 + rng() * 0.16) * (distant ? 1.4 : 1);
    const trunk = cylGeo(trunkR * 0.62, trunkR, trunkH + 0.4, 6, 2);
    trunk.translate(x, (trunkH + 0.4) / 2 - 0.2, z);
    paintVertexColors(trunk, trunkColor, 0, 4, 0.62);
    geos.push(trunk);

    const palette = leafPalettes[Math.floor(rng() * leafPalettes.length)];
    const lumps = 4 + Math.floor(rng() * 3);
    const spread = h * (0.16 + rng() * 0.09);
    for (let l = 0; l < lumps; l++) {
      const r = spread * (0.72 + rng() * 0.6);
      const lump = new THREE.IcosahedronGeometry(r, detail);
      const pos = lump.getAttribute('position');
      for (let v = 0; v < pos.count; v++) {
        const jitter = 1 + (hash3(pos.getX(v) * 0.5, pos.getY(v) * 0.5, pos.getZ(v) * 0.5, seed + l) - 0.5) * 0.3;
        pos.setXYZ(v, pos.getX(v) * jitter, pos.getY(v) * jitter * 0.9, pos.getZ(v) * jitter);
      }
      lump.computeVertexNormals();
      const angle = (l / lumps) * Math.PI * 2 + rng() * 0.7;
      const lx = Math.cos(angle) * spread * (0.35 + rng() * 0.5);
      const lz = Math.sin(angle) * spread * (0.35 + rng() * 0.5);
      const ly = trunkH + (l / lumps) * h * 0.3 + rng() * spread * 0.4;
      lump.translate(x + lx, ly, z + lz);
      const col = new THREE.Color(palette[Math.floor(rng() * palette.length)]);
      col.multiplyScalar(0.86 + rng() * 0.26);
      paintVertexColors(lump, col, 0, 4, 0.55);
      geos.push(lump);
    }
    // A couple of lower branches for a fuller silhouette.
    for (let b = 0; b < 2; b++) {
      const r = spread * (0.5 + rng() * 0.3);
      const lump = new THREE.IcosahedronGeometry(r, detail === 1 ? 0 : detail);
      lump.translate(x + (rng() - 0.5) * spread * 1.5, trunkH * (0.62 + rng() * 0.2), z + (rng() - 0.5) * spread * 1.5);
      const col = new THREE.Color(palette[Math.floor(rng() * palette.length)]).multiplyScalar(0.74);
      paintVertexColors(lump, col, 0, 4, 0.5);
      geos.push(lump);
    }
  };

  // Trees just beyond the walls.
  const nearCount = 46;
  for (let i = 0; i < nearCount; i++) {
    const angle = (i / nearCount) * Math.PI * 2 + (rng() - 0.5) * 0.26;
    const dist = 42 + Math.pow(rng(), 0.7) * 74;
    addTree(Math.cos(angle) * dist, Math.sin(angle) * dist, 4.6 + rng() * 3.6, 1, false);
  }
  // A darker tree line further out for the horizon.
  const farCount = 70;
  for (let i = 0; i < farCount; i++) {
    const angle = (i / farCount) * Math.PI * 2 + (rng() - 0.5) * 0.2;
    const dist = 112 + rng() * 64;
    addTree(Math.cos(angle) * dist, Math.sin(angle) * dist, 6.5 + rng() * 5, 0, true);
  }

  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, flatShading: true });
  const mesh = mergedMesh(geos, mat, 'trees', false, false);
  if (mesh) group.add(mesh);
}

/* ------------------------------------------------------------------ */
/* Dry grass tufts + training dummies                                  */
/* ------------------------------------------------------------------ */

function buildTufts(group: THREE.Group, layout: ArenaLayout, textures: ArenaTextureBank, seed: number): void {
  const rng = mulberry32((seed ^ 0x3f1e2d4c) >>> 0);
  const count = 64;
  const planeA = new THREE.PlaneGeometry(0.62, 0.44);
  planeA.translate(0, 0.22, 0);
  const planeB = planeA.clone();
  planeB.rotateY(Math.PI / 2);
  const merged = mergedMesh([planeA, planeB], new THREE.MeshBasicMaterial(), 'tuft-tmp', false, false);
  if (!merged) return;
  const geo = merged.geometry;
  const mat = new THREE.MeshStandardMaterial({
    map: textures.tuft,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  mesh.name = 'straw-tufts';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < count; i++) {
    // Only by the walls and corners: the centre stays swept.
    const side = Math.floor(rng() * 4);
    let x = 0;
    let z = 0;
    {
      const t = (rng() * 2 - 1) * 0.94;
      if (side === 0) { x = t * layout.bounds.maxX; z = -layout.bounds.maxZ + 0.4 + rng() * 2.4; }
      else if (side === 1) { x = t * layout.bounds.maxX; z = layout.bounds.maxZ - 0.4 - rng() * 2.4; }
      else if (side === 2) { x = -layout.bounds.maxX + 0.4 + rng() * 2.4; z = t * layout.bounds.maxZ; }
      else { x = layout.bounds.maxX - 0.4 - rng() * 2.4; z = t * layout.bounds.maxZ; }
    }
    p.set(x, 0, z);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
    const s = 0.5 + rng() * 0.55;
    sc.set(s, s * (0.8 + rng() * 0.4), s);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    const v = 0.45 + rng() * 0.25;
    col.setRGB(v * 0.9, v * 0.95, v * 0.7);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
}

function buildDummy(batch: GeoBatch, x: number, z: number, yaw: number): void {
  // Post + crossbar + straw torso, a classic training pell.
  addCyl(batch, 'wood', 0.11, 0.14, 1.9, [x, 0.95, z], { tile: TILE.wood, seg: 7, color: new THREE.Color(0.78, 0.7, 0.56) });
  addBox(batch, 'wood', [1.5, 0.1, 0.12], [x, 1.52, z], { tile: TILE.wood, ry: yaw, color: new THREE.Color(0.72, 0.64, 0.5) });
  addCyl(batch, 'hay', 0.24, 0.3, 0.85, [x, 1.1, z], { tile: TILE.hay, seg: 8, ry: yaw, color: new THREE.Color(1, 0.98, 0.94) });
  addCyl(batch, 'wood', 0.26, 0.26, 0.05, [x, 0.68, z], { tile: TILE.wood, seg: 8, color: new THREE.Color(0.55, 0.48, 0.36) });
  // A battered shield propped at the base.
  addBox(batch, 'wood', [0.55, 0.72, 0.06], [x + 0.38, 0.37, z + 0.22], {
    tile: TILE.wood, ry: yaw + 0.4, rz: 0.12, color: new THREE.Color(0.52, 0.22, 0.2),
  });
  addBox(batch, 'metal', [0.1, 0.1, 0.05], [x + 0.36, 0.38, z + 0.25], { tile: TILE.metal, ry: yaw + 0.4 });
}

/* ------------------------------------------------------------------ */
/* Heraldic shield trophies on the walls                               */
/* ------------------------------------------------------------------ */

function shieldGeometry(): THREE.BufferGeometry {
  const geo = new THREE.CircleGeometry(0.58, 18);
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, 0.34 + uv.getX(i) * 0.32, 0.36 + uv.getY(i) * 0.3);
  }
  geo.scale(0.92, 1.05, 1);
  return geo;
}

function buildMoss(group: THREE.Group, layout: ArenaLayout, textures: ArenaTextureBank, seed: number): void {
  const rng = mulberry32((seed ^ 0x6d3b1f2e) >>> 0);
  const planeA = new THREE.PlaneGeometry(0.75, 0.4);
  planeA.translate(0, 0.18, 0);
  const planeB = planeA.clone();
  planeB.rotateY(Math.PI / 2);
  const tmp = mergedMesh([planeA, planeB], new THREE.MeshBasicMaterial(), 'moss-tmp', false, false);
  if (!tmp) return;
  const mat = new THREE.MeshStandardMaterial({
    map: textures.tuft,
    alphaTest: 0.4,
    side: THREE.DoubleSide,
    roughness: 1,
    metalness: 0,
    color: 0x6d7a4e,
  });
  const count = 150;
  const mesh = new THREE.InstancedMesh(tmp.geometry, mat, count);
  mesh.name = 'wall-moss';
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const col = new THREE.Color();
  const ix = layout.wallInner.x - 0.25;
  const iz = layout.wallInner.z - 0.25;
  for (let i = 0; i < count; i++) {
    const side = Math.floor(rng() * 4);
    const t = rng() * 2 - 1;
    if (side === 0) p.set(t * ix, 0, -iz);
    else if (side === 1) p.set(t * ix, 0, iz);
    else if (side === 2) p.set(-ix, 0, t * iz);
    else p.set(ix, 0, t * iz);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2);
    const s = 0.6 + rng() * 0.9;
    sc.set(s, s * (0.7 + rng() * 0.5), s);
    m.compose(p, q, sc);
    mesh.setMatrixAt(i, m);
    const v = 0.55 + rng() * 0.35;
    col.setRGB(v * 0.9, v, v * 0.72);
    mesh.setColorAt(i, col);
  }
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  group.add(mesh);
}

function buildShields(group: THREE.Group, textures: ArenaTextureBank, batch: GeoBatch): void {
  const geo = shieldGeometry();
  const entries: { x: number; y: number; z: number; yaw: number; tex: number }[] = [
    { x: 24.14, y: 2.55, z: -16, yaw: -Math.PI / 2, tex: 0 },
    { x: 24.14, y: 2.55, z: -6, yaw: -Math.PI / 2, tex: 2 },
    { x: 24.14, y: 2.55, z: 4, yaw: -Math.PI / 2, tex: 1 },
    { x: 24.14, y: 2.55, z: 14, yaw: -Math.PI / 2, tex: 3 },
    { x: -14, y: 2.55, z: 23.14, yaw: Math.PI, tex: 3 },
    { x: -4, y: 2.55, z: 23.14, yaw: Math.PI, tex: 0 },
    { x: 6, y: 2.55, z: 23.14, yaw: Math.PI, tex: 1 },
    { x: 16, y: 2.55, z: 23.14, yaw: Math.PI, tex: 2 },
    { x: -9.2, y: 4.5, z: -22.9, yaw: 0, tex: 1 },
    { x: 9.2, y: 4.5, z: -22.9, yaw: 0, tex: 0 },
  ];
  const byTex = new Map<number, THREE.BufferGeometry[]>();
  const m = new THREE.Matrix4();
  for (const e of entries) {
    const g = geo.clone();
    g.applyMatrix4(m.compose(
      new THREE.Vector3(e.x, e.y, e.z),
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), e.yaw),
      new THREE.Vector3(1, 1, 1),
    ));
    let arr = byTex.get(e.tex);
    if (!arr) { arr = []; byTex.set(e.tex, arr); }
    arr.push(g);
    // Iron boss.
    addCyl(batch, 'metal', 0.09, 0.11, 0.07, [
      e.x + Math.sin(e.yaw) * 0.03,
      e.y,
      e.z + Math.cos(e.yaw) * 0.03,
    ], { tile: TILE.metal, seg: 8, rx: Math.PI / 2, ry: e.yaw });
  }
  geo.dispose();
  for (const [texIndex, geos] of byTex) {
    const mat = new THREE.MeshStandardMaterial({
      map: textures.banners[texIndex % textures.banners.length],
      roughness: 0.8,
      metalness: 0.05,
      alphaTest: 0.35,
    });
    const mesh = mergedMesh(geos, mat, `shields-${texIndex}`, false, false);
    if (mesh) group.add(mesh);
  }
}

function buildGateLantern(group: THREE.Group, batch: GeoBatch, textures: ArenaTextureBank): void {
  // Warm lantern under the gate vault, so the arch reads deep and inviting.
  addCyl(batch, 'metal', 0.16, 0.13, 0.34, [0, 4.15, -23.9], { tile: TILE.metal, seg: 8 });
  addCyl(batch, 'metal', 0.03, 0.03, 0.5, [0, 4.55, -23.9], { tile: TILE.metal, seg: 4 });
  const glowMat = new THREE.SpriteMaterial({
    map: textures.flame,
    color: 0xffb46a,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.5,
  });
  const glow = new THREE.Sprite(glowMat);
  glow.position.set(0, 4.12, -23.85);
  glow.scale.set(1.4, 1.6, 1);
  group.add(glow);
  const light = new THREE.PointLight(0xffaa5e, 3.2, 7.5, 2);
  light.position.set(0, 3.9, -24.2);
  group.add(light);
}

/* ------------------------------------------------------------------ */
/* Braziers                                                            */
/* ------------------------------------------------------------------ */

interface Flame {
  sprite: THREE.Sprite;
  baseScale: number;
  phase: number;
}

function buildBraziers(
  group: THREE.Group,
  batch: GeoBatch,
  textures: ArenaTextureBank,
  seed: number,
): { flames: Flame[]; lights: THREE.PointLight[] } {
  const rng = mulberry32((seed ^ 0x1f2e3d4c) >>> 0);
  const flames: Flame[] = [];
  const lights: THREE.PointLight[] = [];
  const flameMat = new THREE.SpriteMaterial({
    map: textures.flame,
    color: 0xffd9a0,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.95,
  });
  const glowMat = new THREE.SpriteMaterial({
    map: textures.flame,
    color: 0xff9a4a,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    opacity: 0.4,
  });
  const positions: [number, number][] = [
    [-4.15, -21.9],
    [4.15, -21.9],
    [-22.7, 16.4],
    [22.7, -16.2],
  ];
  for (const [x, z] of positions) {
    // Iron tripod.
    for (let leg = 0; leg < 3; leg++) {
      const a = (leg / 3) * Math.PI * 2;
      addCyl(batch, 'metal', 0.035, 0.045, 1.0, [x + Math.cos(a) * 0.3, 0.5, z + Math.sin(a) * 0.3], {
        tile: TILE.metal, seg: 5, rx: Math.sin(a) * 0.28, rz: -Math.cos(a) * 0.28,
      });
    }
    addCyl(batch, 'metal', 0.44, 0.26, 0.38, [x, 1.02, z], { tile: TILE.metal, seg: 10, open: true });
    addCyl(batch, 'metal', 0.46, 0.46, 0.05, [x, 1.2, z], { tile: TILE.metal, seg: 10 });
    addCyl(batch, 'metal', 0.1, 0.1, 0.16, [x, 1.22, z], { tile: TILE.metal, seg: 6 });
    // Burning coals.
    const coal = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.26, 0),
      new THREE.MeshStandardMaterial({ color: 0x2a1208, emissive: 0xff5a18, emissiveIntensity: 1.4, roughness: 0.9 }),
    );
    coal.position.set(x, 1.18, z);
    coal.scale.y = 0.5;
    group.add(coal);
    // Flame + glow sprites.
    const flame = new THREE.Sprite(flameMat);
    flame.position.set(x, 1.62, z);
    flame.scale.set(0.55, 0.95, 1);
    group.add(flame);
    flames.push({ sprite: flame, baseScale: 0.95, phase: rng() * 8 });
    const glow = new THREE.Sprite(glowMat);
    glow.position.set(x, 1.5, z);
    glow.scale.set(1.6, 1.6, 1);
    group.add(glow);
    flames.push({ sprite: glow, baseScale: 1.6, phase: rng() * 8 + 3 });
    const light = new THREE.PointLight(0xffa25a, 6, 10, 2);
    light.position.set(x, 1.7, z);
    group.add(light);
    lights.push(light);
  }
  return { flames, lights };
}

/* ------------------------------------------------------------------ */
/* Dust motes                                                          */
/* ------------------------------------------------------------------ */

const DUST_VERT = /* glsl */ `
  attribute float aPhase;
  uniform float uTime;
  uniform float uSize;
  uniform float uOpacity;
  varying float vAlpha;
  void main() {
    vec3 p = position;
    float t = uTime;
    p.x += sin(t * 0.17 + aPhase * 6.283) * 1.15;
    p.z += cos(t * 0.13 + aPhase * 4.1) * 0.95;
    p.y += sin(t * 0.21 + aPhase * 2.3) * 0.4 + mod(t * 0.035 + aPhase, 1.0) * 0.55;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float depth = max(0.4, -mv.z);
    gl_PointSize = clamp(uSize * (320.0 / depth), 0.8, 4.5);
    gl_Position = projectionMatrix * mv;
    // Fade the very closest motes so they never read as floating bubbles.
    vAlpha = uOpacity * (0.35 + 0.65 * (0.5 + 0.5 * sin(t * 1.05 + aPhase * 5.0))) * smoothstep(1.2, 5.0, depth);
  }
`;

const DUST_FRAG = /* glsl */ `
  uniform vec3 uColor;
  varying float vAlpha;
  void main() {
    float d = length(gl_PointCoord - vec2(0.5));
    float a = smoothstep(0.5, 0.08, d) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

function buildDust(group: THREE.Group, layout: ArenaLayout, quality: 'low' | 'medium' | 'high', seed: number): { material: THREE.ShaderMaterial; geometry: THREE.BufferGeometry } {
  const rng = mulberry32((seed ^ 0x77a1b3c5) >>> 0);
  const count = quality === 'high' ? 460 : quality === 'medium' ? 300 : 170;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    positions[i * 3] = (rng() - 0.5) * layout.bounds.maxX * 2.1;
    positions[i * 3 + 1] = 0.2 + rng() * 3.6;
    positions[i * 3 + 2] = (rng() - 0.5) * layout.bounds.maxZ * 2.05;
    phases[i] = rng();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uSize: { value: quality === 'high' ? 0.075 : 0.085 },
      uOpacity: { value: 0.16 },
      uColor: { value: new THREE.Color('#ffe8bb') },
    },
    vertexShader: DUST_VERT,
    fragmentShader: DUST_FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const points = new THREE.Points(geo, material);
  points.name = 'dust-motes';
  points.frustumCulled = false;
  points.renderOrder = 3;
  group.add(points);
  return { material, geometry: geo };
}

/* ------------------------------------------------------------------ */
/* Public                                                             */
/* ------------------------------------------------------------------ */

export function createProps(opts: {
  layout: ArenaLayout;
  textures: ArenaTextureBank;
  batch: GeoBatch;
  quality: 'low' | 'medium' | 'high';
  seed: number;
}): PropsSystem {
  const { layout, textures, batch, quality, seed } = opts;
  const rng = mulberry32((seed ^ 0xb4c5d6e7) >>> 0);
  const group = new THREE.Group();
  group.name = 'props';

  const boulderMat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    map: textures.rock.map,
    roughness: 0.97,
    metalness: 0,
  });
  buildBoulders(group, boulderMat, seed);

  buildCrates(batch, rng, -20.2, 10.8);
  buildBarrels(batch, rng, 20.4, -7.6);
  buildHay(batch, rng);
  buildWeaponRack(batch, rng, -8.1, -19.9);
  buildDebris(batch, rng);
  buildCart(batch, -17.6, -18.6, 0.5);
  buildDummy(batch, -12.4, -20.2, 0.6);
  buildDummy(batch, 15.0, 20.0, -0.5);
  buildTrees(group, seed);
  buildTufts(group, layout, textures, seed);
  buildMoss(group, layout, textures, seed);

  if (quality !== 'low') buildPebbles(group, layout, quality, seed);
  buildBloodDecals(group, layout, textures, seed);

  buildShields(group, textures, batch);
  buildGateLantern(group, batch, textures);
  const { flames, lights } = buildBraziers(group, batch, textures, seed);
  const dust = buildDust(group, layout, quality, seed);

  const disposables: THREE.Object3D[] = [group];

  return {
    group,
    update: (dt: number, time: number) => {
      dust.material.uniforms.uTime.value = time;
      for (let i = 0; i < flames.length; i++) {
        const f = flames[i];
        const flicker = 0.82 + Math.sin(time * 7.3 + f.phase) * 0.09 + Math.sin(time * 13.1 + f.phase * 2.1) * 0.05;
        f.sprite.scale.set(f.baseScale * 0.62 * flicker, f.baseScale * flicker, 1);
        if (f.sprite.material instanceof THREE.SpriteMaterial) {
          f.sprite.material.opacity = (i % 2 === 0 ? 0.9 : 0.36) * flicker;
        }
      }
      for (let i = 0; i < lights.length; i++) {
        lights[i].intensity = 6 * (0.86 + Math.sin(time * 8.7 + i * 2.3) * 0.1 + Math.sin(time * 3.1 + i) * 0.06);
      }
      void dt;
    },
    dispose: () => {
      for (const obj of disposables) {
        obj.traverse((node) => {
          const mesh = node as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
      }
    },
  };
}
