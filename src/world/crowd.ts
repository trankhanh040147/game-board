import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quality } from '../core/types';
import { clamp, damp, mulberry32 } from '../core/utils';
import { ARENA_LAYOUT, type ArenaLayout, type StandDef } from './layout';

/**
 * The crowd: 150–220 low-poly spectators in a handful of instanced draws.
 *
 * Animation happens entirely in the vertex shader: each instance carries a
 * phase, and the shared uniforms drive idle sway, an excitement-driven bounce
 * with raised arms, and a travelling cheer wave that spreads through the stands.
 * The arms are separate vertex groups (aPart) rotated around their shoulder
 * pivots, so the silhouette genuinely changes when the crowd roars.
 */

export interface CrowdSystem {
  group: THREE.Group;
  count: number;
  update(dt: number, time: number): void;
  setExcitement(level01: number): void;
  cheer(strength01?: number): void;
  dispose(): void;
}

const TUNICS = [
  '#8d5a3c', '#6f7060', '#8a4d46', '#547078', '#8a7440', '#6d5573', '#537a48', '#8f6644',
  '#a37e52', '#6b5140', '#9a8668', '#5c5048', '#7d6a8a', '#7a6a3e', '#48627a', '#95705a',
];
const PANTS = ['#5a4732', '#4a443c', '#6a5540', '#54503f', '#655132', '#3f3a32'];
const SKINS = ['#d3a67c', '#c29a70', '#b1845c', '#dcb28a', '#9a7350', '#c9996d'];
const HAIRS = ['#46331f', '#6a4729', '#8a673d', '#332820', '#7d7364', '#573e26', '#9a8a72'];
const HATS = ['#7a6742', '#57452f', '#8a5438', '#454a3c', '#8a7854', '#5d4a6a'];

type Rng = () => number;

interface PartSpec {
  geo: THREE.BufferGeometry;
  color: THREE.Color;
  part: number;
  x: number;
  y: number;
  z: number;
  sx?: number;
  sy?: number;
  sz?: number;
}

function addPart(specs: PartSpec[], rng: Rng, geo: THREE.BufferGeometry): void {
  void rng;
  void geo;
}

function part(specs: PartSpec[], geo: THREE.BufferGeometry, color: string, partId: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): void {
  specs.push({ geo, color: new THREE.Color(color), part: partId, x, y, z, sx, sy, sz });
}

function buildSpectatorGeometry(rng: Rng, variant: number): THREE.BufferGeometry {
  const specs: PartSpec[] = [];
  const tunic = TUNICS[Math.floor(rng() * TUNICS.length)];
  const tunicDark = new THREE.Color(tunic).multiplyScalar(0.78).getStyle();
  const pants = PANTS[Math.floor(rng() * PANTS.length)];
  const skin = SKINS[Math.floor(rng() * SKINS.length)];
  const hair = HAIRS[Math.floor(rng() * HAIRS.length)];

  // Legs + boots.
  for (const s of [-1, 1]) {
    part(specs, new THREE.BoxGeometry(0.16, 0.13, 0.28), '#3d2d20', 0, s * 0.1, 0.065, 0.02);
    part(specs, new THREE.BoxGeometry(0.155, 0.56, 0.19), pants, 0, s * 0.1, 0.41, 0);
  }
  // Torso: narrower at the shoulders so the arms read in silhouette.
  part(specs, new THREE.CylinderGeometry(0.165, 0.225, 0.6, 7), tunic, 0, 0, 1.02, 0);
  // Longer tunic skirt below the belt.
  part(specs, new THREE.CylinderGeometry(0.225, 0.255, 0.26, 7), variant === 1 ? tunicDark : tunic, 0, 0, 0.62, 0);
  part(specs, new THREE.CylinderGeometry(0.218, 0.218, 0.075, 7), '#43321f', 0, 0, 0.755, 0);
  // Mantle / shoulder cape.
  part(specs, new THREE.CylinderGeometry(0.235, 0.185, 0.18, 7), variant === 2 ? tunicDark : tunic, 0, 0, 1.275, 0);
  // Collar / neck + head.
  part(specs, new THREE.CylinderGeometry(0.062, 0.075, 0.1, 6), skin, 0, 0, 1.415, 0);
  part(specs, new THREE.IcosahedronGeometry(0.126, 1), skin, 0, 0, 1.55, 0, 1, 1.08, 1.02);
  // Hair / hat.
  if (variant === 1) {
    part(specs, new THREE.CylinderGeometry(0.06, 0.095, 0.17, 6), HATS[Math.floor(rng() * HATS.length)], 0, 0, 1.71, 0);
    part(specs, new THREE.CylinderGeometry(0.16, 0.17, 0.03, 8), HATS[Math.floor(rng() * HATS.length)], 0, 0, 1.64, 0);
  } else if (variant === 2) {
    // Hood.
    part(specs, new THREE.SphereGeometry(0.148, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.62), tunicDark, 0, 0, 1.55, -0.012, 1.02, 1.06, 1.05);
  } else {
    part(specs, new THREE.SphereGeometry(0.132, 8, 5, 0, Math.PI * 2, 0, Math.PI * 0.54), hair, 0, 0, 1.555, -0.014, 1.02, 1.0, 1.05);
  }

  // Arms: geometry is built in shoulder-pivot-local space and offset in the shader.
  for (const side of [-1, 1] as const) {
    const partId = side < 0 ? 1 : 2;
    part(specs, new THREE.BoxGeometry(0.13, 0.32, 0.15), variant === 1 ? tunicDark : tunic, partId, 0, -0.16, 0);
    part(specs, new THREE.BoxGeometry(0.105, 0.14, 0.125), variant === 1 ? tunicDark : tunic, partId, 0, -0.34, 0);
    part(specs, new THREE.BoxGeometry(0.085, 0.11, 0.1), skin, partId, 0, -0.45, 0.01);
  }

  const geos: THREE.BufferGeometry[] = [];
  for (const spec of specs) {
    const g = spec.geo.index ? spec.geo.toNonIndexed() : spec.geo.clone();
    g.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(spec.x, spec.y, spec.z),
      new THREE.Quaternion(),
      new THREE.Vector3(spec.sx ?? 1, spec.sy ?? 1, spec.sz ?? 1),
    ));
    const count = g.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      colors[i * 3] = spec.color.r;
      colors[i * 3 + 1] = spec.color.g;
      colors[i * 3 + 2] = spec.color.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const parts = new Float32Array(count);
    parts.fill(spec.part);
    g.setAttribute('aPart', new THREE.BufferAttribute(parts, 1));
    geos.push(g);
    spec.geo.dispose();
  }
  const merged = mergeGeometries(geos, false);
  geos.forEach((g) => g.dispose());
  if (!merged) throw new Error('crowd geometry merge failed');
  return merged;
}

/* ------------------------------------------------------------------ */
/* Shader patch                                                        */
/* ------------------------------------------------------------------ */

const CROWD_VERTEX_PARS = /* glsl */ `
  attribute float aPart;
  attribute float aPhase;
  uniform float uTime;
  uniform float uExcite;
  uniform float uCheerTime;
  uniform float uCheerStrength;
`;

const CROWD_BEGIN_VERTEX = /* glsl */ `
  vec3 transformed = vec3(position);

  float ph = aPhase;
  float exc = uExcite;

  // Cheer wave travels out from the gate end of the stands.
  vec2 instPos = instanceMatrix[3].xz;
  float cheerDelay = clamp(length(instPos - vec2(0.0, -20.0)) / 42.0, 0.0, 1.0);
  float ct = uCheerTime - cheerDelay * 0.7;
  float cheerEnv = smoothstep(0.0, 0.2, ct) * (1.0 - smoothstep(0.9, 1.7, ct));
  float cheer = cheerEnv * uCheerStrength;

  float bob = sin(uTime * 2.0 + ph * 3.1) * 0.012 * (0.35 + exc);
  transformed.y += bob + cheer * (0.05 + 0.1 * max(0.0, sin(ct * 9.0 + ph * 0.7)));

  if (aPart > 0.5) {
    float side = aPart > 1.5 ? 1.0 : -1.0;
    float raise = 0.12 + exc * 1.92 + cheer * 0.55;
    float wave = sin(uTime * (2.6 + exc * 5.0) + ph * 2.3) * (0.07 + exc * 0.26 + cheer * 0.6);
    float ang = side * (raise + wave * 0.55);
    float ca = cos(ang);
    float sa = sin(ang);
    vec2 pivot = vec2(0.285 * side, 1.3);
    vec2 rel = transformed.xy - pivot;
    transformed.xy = pivot + vec2(rel.x * ca - rel.y * sa, rel.x * sa + rel.y * ca);
    transformed.z += sin(uTime * 3.4 + ph * 1.7) * 0.02 * (exc + cheer);
  } else {
    transformed.x += sin(uTime * 1.05 + ph) * 0.01 * (0.25 + exc);
    transformed.z += cos(uTime * 0.8 + ph * 1.3) * 0.008 * (0.2 + exc);
  }
`;

function makeCrowdMaterial(uniforms: Record<string, THREE.IUniform>): THREE.MeshStandardMaterial {
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.96,
    metalness: 0,
    side: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.uniforms.uCheerTime = uniforms.uCheerTime;
    shader.uniforms.uCheerStrength = uniforms.uCheerStrength;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${CROWD_VERTEX_PARS}`,
    );
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', CROWD_BEGIN_VERTEX);
  };
  mat.customProgramCacheKey = () => 'arena-crowd-v1';
  return mat;
}

/* ------------------------------------------------------------------ */
/* Placement                                                           */
/* ------------------------------------------------------------------ */

interface SeatPlan {
  positions: THREE.Vector3[];
  yaws: number[];
  scales: number[];
  phases: number[];
}

function planSeats(stand: StandDef, layout: ArenaLayout, seatsPerRow: number, rng: Rng): { x: number; z: number; y: number; yaw: number; scale: number; phase: number }[] {
  const out: { x: number; z: number; y: number; yaw: number; scale: number; phase: number }[] = [];
  const span = stand.max - stand.min;
  for (let r = 0; r < stand.rows; r++) {
    const spine = stand.frontSpine - r * stand.rowDepth;
    const y = stand.baseY + r * stand.rowRise;
    for (let s = 0; s < seatsPerRow; s++) {
      const t = (s + 0.5) / seatsPerRow;
      const along = stand.min + 0.55 + t * (span - 1.1) + (rng() - 0.5) * 0.5;
      const x = stand.axis === 'z' ? spine + (rng() - 0.5) * 0.16 : along;
      const z = stand.axis === 'z' ? along : spine + (rng() - 0.5) * 0.16;
      const lookYaw = Math.atan2(-x, -z);
      const yaw = lookYaw + (rng() - 0.5) * 0.45;
      const kid = rng() < 0.05;
      const scale = (kid ? 0.72 : 0.93 + rng() * 0.14) * (stand.axis === 'z' ? 1 : 0.98);
      out.push({ x, z, y: y - 0.03, yaw, scale, phase: rng() * Math.PI * 2 });
    }
  }
  void layout;
  return out;
}

/* ------------------------------------------------------------------ */
/* Public                                                             */
/* ------------------------------------------------------------------ */

export function createCrowd(_scene: THREE.Scene, layout: ArenaLayout, quality: Quality, seed: number): CrowdSystem {
  const group = new THREE.Group();
  group.name = 'crowd';
  const rng = mulberry32((seed ^ 0xa53c9e1d) >>> 0);

  const density = quality === 'high'
    ? { west: 30, north: 8 }
    : quality === 'medium'
      ? { west: 24, north: 6 }
      : { west: 16, north: 5 };

  const seatsByVariant: SeatPlan[] = [
    { positions: [], yaws: [], scales: [], phases: [] },
    { positions: [], yaws: [], scales: [], phases: [] },
    { positions: [], yaws: [], scales: [], phases: [] },
  ];

  let instanceIndex = 0;
  for (const stand of layout.stands) {
    const perRow = stand.id === 'west' ? density.west : density.north;
    const seats = planSeats(stand, layout, perRow, rng);
    for (const seat of seats) {
      const v = instanceIndex % 3;
      instanceIndex++;
      const plan = seatsByVariant[v];
      plan.positions.push(new THREE.Vector3(seat.x, seat.y, seat.z));
      plan.yaws.push(seat.yaw);
      plan.scales.push(seat.scale);
      plan.phases.push(seat.phase);
    }
  }

  const uniforms = {
    uTime: { value: 0 },
    uExcite: { value: 0.28 },
    uCheerTime: { value: 99 },
    uCheerStrength: { value: 0 },
  };
  const material = makeCrowdMaterial(uniforms);

  const meshes: THREE.InstancedMesh[] = [];
  const geometries: THREE.BufferGeometry[] = [];

  for (let v = 0; v < 3; v++) {
    const plan = seatsByVariant[v];
    if (plan.positions.length === 0) continue;
    const geo = buildSpectatorGeometry(rng, v);
    const phases = new Float32Array(plan.phases);
    geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
    geometries.push(geo);

    const mesh = new THREE.InstancedMesh(geo, material, plan.positions.length);
    mesh.name = `crowd-${v}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const pos = new THREE.Vector3();
    const scl = new THREE.Vector3();
    const tint = new THREE.Color();
    for (let i = 0; i < plan.positions.length; i++) {
      pos.copy(plan.positions[i]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), plan.yaws[i]);
      const s = plan.scales[i];
      scl.set(s, s, s);
      m.compose(pos, q, scl);
      mesh.setMatrixAt(i, m);
      const v2 = 0.96 + rng() * 0.24;
      tint.setRGB(v2, v2, v2);
      mesh.setColorAt(i, tint);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    meshes.push(mesh);
    group.add(mesh);
  }

  let targetExcite = 0.28;
  let excite = 0.28;
  let cheerTime = 99;
  let cheerStrength = 0;

  return {
    group,
    count: instanceIndex,
    update: (dt: number, time: number) => {
      excite = damp(excite, targetExcite, 2.2, Math.max(0.0001, dt));
      cheerTime += dt;
      if (cheerStrength > 0 && cheerTime > 2.4) cheerStrength = 0;
      uniforms.uTime.value = time;
      uniforms.uExcite.value = excite;
      uniforms.uCheerTime.value = cheerTime;
      uniforms.uCheerStrength.value = cheerStrength;
    },
    setExcitement: (level01: number) => {
      targetExcite = clamp(level01, 0, 1);
    },
    cheer: (strength01 = 1) => {
      cheerTime = 0;
      cheerStrength = clamp(strength01, 0.15, 1);
      targetExcite = Math.min(1, targetExcite + 0.25);
    },
    dispose: () => {
      for (const g of geometries) g.dispose();
      material.dispose();
    },
  };
}

export const CROWD_DEFAULT_EXCITEMENT = 0.28;
