import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { ArenaLayout } from './layout';
import type { ArenaTextureBank } from './textures';
import { ARENA_STRUCT } from './structures';
import { addCyl, GeoBatch } from './geo';
import { clamp, mulberry32 } from '../core/utils';
import { TEAM_PALETTE } from '../core/config';

/**
 * Cloth: large heraldic banners hanging from the gatehouse, stand fascias and
 * walls, plus a swarm of instanced pennants on every pole. Both animate in the
 * vertex shader (cheap, no per-frame CPU work).
 */

export interface BannerSystem {
  group: THREE.Group;
  update(time: number, excitement: number): void;
  dispose(): void;
}

interface BannerAnchor {
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  yaw: number;
  tex: number;
  phase: number;
}

interface PennantPole {
  x: number;
  y: number;
  z: number;
  height: number;
  tint: number;
  scale?: number;
}

const CLOTH_PARS = /* glsl */ `
  attribute float aCloth;
  attribute float aPhase;
  attribute vec3 aOut;
  uniform float uTime;
  uniform float uExcite;
`;

const CLOTH_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  float k = aCloth;
  float sway = sin(uTime * 2.15 + aPhase + k * 3.2) * (0.10 + uExcite * 0.10);
  float ripple = sin(uTime * 3.9 + aPhase * 1.7 + k * 6.4) * 0.035;
  transformed += aOut * (sway + ripple) * k * k;
  transformed.y += sin(uTime * 1.6 + aPhase * 0.9) * 0.018 * k;
`;

const PENNANT_PARS = /* glsl */ `
  attribute float aPhase;
  uniform float uTime;
  uniform float uExcite;
`;

const PENNANT_BEGIN = /* glsl */ `
  vec3 transformed = vec3(position);
  float tip = clamp(position.x / 1.55, 0.0, 1.0);
  transformed.z += sin(uTime * 3.0 + aPhase + position.x * 2.6) * (0.16 + uExcite * 0.10) * tip;
  transformed.z += sin(uTime * 5.3 + aPhase * 2.1 + position.x * 4.2) * 0.045 * tip;
  transformed.y += sin(uTime * 2.2 + aPhase * 1.3 + position.x * 1.9) * 0.05 * tip;
`;

function patchCloth(
  material: THREE.Material,
  uniforms: Record<string, THREE.IUniform>,
  pars: string,
  begin: string,
  cacheKey: string,
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uExcite = uniforms.uExcite;
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>\n${pars}`);
    shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', begin);
  };
  material.customProgramCacheKey = () => cacheKey;
}

/* ------------------------------------------------------------------ */
/* Anchors                                                             */
/* ------------------------------------------------------------------ */

function bannerAnchors(): BannerAnchor[] {
  const g = ARENA_STRUCT.gate;
  const anchors: BannerAnchor[] = [
    // Gatehouse piers, flanking the arch.
    { x: -4.9, y: 6.35, z: g.frontZ + 0.14, width: 1.2, height: 2.5, yaw: 0, tex: 0, phase: 0.4 },
    { x: 4.9, y: 6.35, z: g.frontZ + 0.14, width: 1.2, height: 2.5, yaw: 0, tex: 1, phase: 1.7 },
    // Jettied storey front.
    { x: -6.55, y: 9.65, z: g.storeyFrontZ + 0.06, width: 1.0, height: 2.05, yaw: 0, tex: 2, phase: 2.6 },
    { x: 6.55, y: 9.65, z: g.storeyFrontZ + 0.06, width: 1.0, height: 2.05, yaw: 0, tex: 3, phase: 3.4 },
    // West stand railing.
    { x: -26.1, y: 5.72, z: -14.6, width: 1.0, height: 1.5, yaw: Math.PI / 2, tex: 0, phase: 1.1 },
    { x: -26.1, y: 5.72, z: -7.3, width: 1.0, height: 1.5, yaw: Math.PI / 2, tex: 2, phase: 2.2 },
    { x: -26.1, y: 5.72, z: 0, width: 1.0, height: 1.5, yaw: Math.PI / 2, tex: 1, phase: 3.3 },
    { x: -26.1, y: 5.72, z: 7.3, width: 1.0, height: 1.5, yaw: Math.PI / 2, tex: 3, phase: 4.4 },
    { x: -26.1, y: 5.72, z: 14.6, width: 1.0, height: 1.5, yaw: Math.PI / 2, tex: 4, phase: 5.5 },
    // North stands flanking the gatehouse.
    { x: -21.4, y: 5.7, z: -26.05, width: 1.0, height: 1.45, yaw: 0, tex: 1, phase: 0.9 },
    { x: -15.2, y: 5.7, z: -26.05, width: 1.0, height: 1.45, yaw: 0, tex: 3, phase: 2.0 },
    { x: 15.2, y: 5.7, z: -26.05, width: 1.0, height: 1.45, yaw: 0, tex: 2, phase: 3.1 },
    { x: 21.4, y: 5.7, z: -26.05, width: 1.0, height: 1.45, yaw: 0, tex: 0, phase: 4.2 },
    // East and south walls (the quieter sides of the arena).
    { x: 24.09, y: 3.62, z: -8.5, width: 1.05, height: 2.0, yaw: -Math.PI / 2, tex: 3, phase: 1.4 },
    { x: 24.09, y: 3.62, z: 8.5, width: 1.05, height: 2.0, yaw: -Math.PI / 2, tex: 5, phase: 2.8 },
    { x: -8.5, y: 3.62, z: 23.09, width: 1.05, height: 2.0, yaw: Math.PI, tex: 4, phase: 0.6 },
    { x: 8.5, y: 3.62, z: 23.09, width: 1.05, height: 2.0, yaw: Math.PI, tex: 2, phase: 4.9 },
  ];
  return anchors;
}

function pennantPoles(): PennantPole[] {
  const g = ARENA_STRUCT.gate;
  const ct = ARENA_STRUCT.cornerTower;
  const teal = TEAM_PALETTE[0].color;
  const azure = TEAM_PALETTE[1].color;
  const verdant = TEAM_PALETTE[2].color;
  const gold = TEAM_PALETTE[3].color;
  const cream = 0xd9c9a3;
  const poles: PennantPole[] = [
    // Gatehouse tower roofs.
    { x: -g.towerX, y: g.towerTopY, z: g.towerZ - 0.1, height: 2.7, tint: teal },
    { x: g.towerX, y: g.towerTopY, z: g.towerZ - 0.1, height: 2.7, tint: azure },
    // Gate roof ridge ends.
    { x: 0, y: g.ridgeY + 0.25, z: g.storeyFrontZ + 0.1, height: 1.25, tint: gold, scale: 0.9 },
    { x: 0, y: g.ridgeY + 0.25, z: g.storeyFrontZ - 6.3, height: 1.25, tint: cream, scale: 0.9 },
    // West stand roof corners.
    { x: -26.2, y: 8.82, z: -19.4, height: 1.6, tint: verdant },
    { x: -26.2, y: 8.82, z: 19.4, height: 1.6, tint: teal },
    // North stand roof inner ends.
    { x: -11.2, y: 8.45, z: -26.0, height: 1.6, tint: gold },
    { x: 11.2, y: 8.45, z: -26.0, height: 1.6, tint: azure },
    // Corner towers.
    { x: -ct.x, y: ct.topY, z: -ct.z, height: 2.9, tint: azure },
    { x: ct.x, y: ct.topY, z: -ct.z, height: 2.9, tint: verdant },
    { x: -ct.x, y: ct.topY, z: ct.z, height: 2.9, tint: gold },
    { x: ct.x, y: ct.topY, z: ct.z, height: 2.9, tint: teal },
    // Merlon poles on the east and south walls.
    { x: 25.05, y: ARENA_STRUCT.wallCapY, z: -11.5, height: 1.9, tint: cream, scale: 0.85 },
    { x: 25.05, y: ARENA_STRUCT.wallCapY, z: 11.5, height: 1.9, tint: teal, scale: 0.85 },
    { x: -11.5, y: ARENA_STRUCT.wallCapY, z: 24.05, height: 1.9, tint: cream, scale: 0.85 },
    { x: 11.5, y: ARENA_STRUCT.wallCapY, z: 24.05, height: 1.9, tint: gold, scale: 0.85 },
    // Arena-side poles either side of the gate passage.
    { x: -10.9, y: ARENA_STRUCT.wallCapY, z: -24.1, height: 2.2, tint: teal },
    { x: 10.9, y: ARENA_STRUCT.wallCapY, z: -24.1, height: 2.2, tint: azure },
  ];
  return poles;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

function bannerPlane(anchor: BannerAnchor): THREE.BufferGeometry {
  const geo = new THREE.PlaneGeometry(anchor.width, anchor.height, 6, 8);
  // Shift so the top edge hangs from the anchor, then place it in the world.
  geo.translate(0, -anchor.height / 2, 0);
  geo.applyMatrix4(new THREE.Matrix4().compose(
    new THREE.Vector3(anchor.x, anchor.y, anchor.z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), anchor.yaw),
    new THREE.Vector3(1, 1, 1),
  ));
  const nonIndexed = geo.toNonIndexed();
  geo.dispose();
  const source = nonIndexed.getAttribute('position');
  const count = source.count;
  const cloth = new Float32Array(count);
  const phase = new Float32Array(count);
  const out = new Float32Array(count * 3);
  const outDir = new THREE.Vector3(Math.sin(anchor.yaw), 0, Math.cos(anchor.yaw));
  for (let i = 0; i < count; i++) {
    cloth[i] = clamp(-(source.getY(i) - anchor.y) / anchor.height, 0, 1);
    phase[i] = anchor.phase;
    out[i * 3] = outDir.x;
    out[i * 3 + 1] = outDir.y;
    out[i * 3 + 2] = outDir.z;
  }
  nonIndexed.setAttribute('aCloth', new THREE.BufferAttribute(cloth, 1));
  nonIndexed.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  nonIndexed.setAttribute('aOut', new THREE.BufferAttribute(out, 3));
  return nonIndexed;
}

function pennantGeometry(): THREE.BufferGeometry {
  const length = 1.55;
  const segs = 6;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const x = t * length;
    const top = -t * 0.08;
    const bottom = -(0.46 - t * 0.3);
    positions.push(x, top, 0);
    positions.push(x, bottom, 0);
    uvs.push(t, 1);
    uvs.push(t, 0);
  }
  for (let i = 0; i < segs; i++) {
    const a = i * 2;
    indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

/* ------------------------------------------------------------------ */
/* Public                                                             */
/* ------------------------------------------------------------------ */

/** Banner cloth anchor points (for camera/spawn clearance tests). */
export const BANNER_ANCHOR_DATA: readonly BannerAnchor[] = bannerAnchors();
/** Pennant poles (for camera/spawn clearance tests). */
export const PENNANT_POLE_DATA: readonly PennantPole[] = pennantPoles();

export function createBanners(opts: {
  layout: ArenaLayout;
  textures: ArenaTextureBank;
  batch: GeoBatch;
  seed: number;
}): BannerSystem {
  const { textures, batch, seed } = opts;
  const rng = mulberry32((seed ^ 0x7f4a7c15) >>> 0);
  const group = new THREE.Group();
  group.name = 'banners';

  const uniforms = {
    uTime: { value: 0 },
    uExcite: { value: 0.3 },
  };

  // Poles for the pennants.
  const poles = pennantPoles();
  for (const pole of poles) {
    addCyl(batch, 'wood', 0.045, 0.07, pole.height, [pole.x, pole.y + pole.height / 2, pole.z], {
      tile: 1.2,
      seg: 6,
      color: new THREE.Color(0.72, 0.68, 0.62),
      aoBase: pole.y - 2,
      aoTop: pole.y + 2,
      minShade: 0.85,
    });
    // Small finial ball.
    addCyl(batch, 'wood', 0.02, 0.08, 0.16, [pole.x, pole.y + pole.height + 0.06, pole.z], { tile: 1.2, seg: 6 });
  }

  // Banner meshes grouped by texture so all cloth shares a handful of draws.
  const anchors = bannerAnchors();
  const byTexture = new Map<number, THREE.BufferGeometry[]>();
  for (const anchor of anchors) {
    const geo = bannerPlane(anchor);
    let list = byTexture.get(anchor.tex);
    if (!list) {
      list = [];
      byTexture.set(anchor.tex, list);
    }
    list.push(geo);
  }
  const materials: THREE.MeshStandardMaterial[] = [];
  for (const [texIndex, geos] of byTexture) {
    const tex = textures.banners[texIndex % textures.banners.length];
    const mat = new THREE.MeshStandardMaterial({
      map: tex,
      side: THREE.DoubleSide,
      roughness: 0.94,
      metalness: 0,
      alphaTest: 0.35,
      transparent: false,
    });
    patchCloth(mat, uniforms, CLOTH_PARS, CLOTH_BEGIN, `arena-banner-${texIndex}`);
    materials.push(mat);
    const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
    geos.forEach((g) => g.dispose());
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.name = `banners-${texIndex}`;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    group.add(mesh);
  }

  // Instanced pennants.
  const penGeo = pennantGeometry();
  const phases = new Float32Array(poles.length);
  for (let i = 0; i < poles.length; i++) phases[i] = rng() * Math.PI * 2;
  penGeo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phases, 1));
  const penMat = new THREE.MeshStandardMaterial({
    map: textures.pennant,
    side: THREE.DoubleSide,
    roughness: 0.95,
    metalness: 0,
  });
  patchCloth(penMat, uniforms, PENNANT_PARS, PENNANT_BEGIN, 'arena-pennant-1');
  const penMesh = new THREE.InstancedMesh(penGeo, penMat, poles.length);
  penMesh.name = 'pennants';
  penMesh.frustumCulled = false;
  penMesh.castShadow = false;
  penMesh.receiveShadow = false;
  const windYaw = Math.atan2(-0.5, 0.86) + (rng() - 0.5) * 0.1;
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const col = new THREE.Color();
  for (let i = 0; i < poles.length; i++) {
    const pole = poles[i];
    p.set(pole.x, pole.y + pole.height - 0.02, pole.z);
    e.set(0, windYaw + (rng() - 0.5) * 0.35, 0);
    q.setFromEuler(e);
    const sc = (pole.scale ?? 1) * (0.9 + rng() * 0.2);
    s.set(sc, sc, sc);
    m.compose(p, q, s);
    penMesh.setMatrixAt(i, m);
    col.set(pole.tint);
    // Slightly desaturate / vary.
    col.multiplyScalar(0.9 + rng() * 0.2);
    penMesh.setColorAt(i, col);
  }
  penMesh.instanceMatrix.needsUpdate = true;
  if (penMesh.instanceColor) penMesh.instanceColor.needsUpdate = true;
  group.add(penMesh);

  return {
    group,
    update: (time: number, excitement: number) => {
      uniforms.uTime.value = time;
      uniforms.uExcite.value = clamp(excitement, 0, 1);
    },
    dispose: () => {
      for (const child of group.children) {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          const mat = child.material as THREE.Material | THREE.Material[];
          if (Array.isArray(mat)) mat.forEach((mm) => mm.dispose());
          else mat.dispose();
        }
      }
      for (const mat of materials) mat.dispose();
      penMat.dispose();
    },
  };
}
