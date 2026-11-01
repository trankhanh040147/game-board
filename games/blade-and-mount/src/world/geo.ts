import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, smoothstep } from '../core/utils';

/**
 * Shared procedural geometry helpers for the arena.
 *
 * Everything static is merged into a handful of material buckets so the whole
 * environment stays around 30 draw calls. Helper factories bake sensible UV
 * scaling (texel density is constant in world metres) and a cheap vertex-colour
 * ambient-occlusion term (darker near the ground) into each piece.
 */

export interface BatchMaterialSpec {
  material: THREE.Material;
  castShadow?: boolean;
  receiveShadow?: boolean;
  renderOrder?: number;
}

export interface AddOptions {
  /** Arbitrary transform, applied to the geometry. */
  matrix?: THREE.Matrix4;
  /** Base vertex colour (multiplied into the map). */
  color?: THREE.ColorRepresentation;
  /** Ambient occlusion: fully dark below aoBase, full brightness above aoTop. */
  aoBase?: number;
  aoTop?: number;
  minShade?: number;
}

const _c = new THREE.Color();
const _m = new THREE.Matrix4();

export class GeoBatch {
  private parts = new Map<string, THREE.BufferGeometry[]>();

  /** Add an already-positioned geometry. Takes ownership of `geo`. */
  add(key: string, geo: THREE.BufferGeometry, opts: AddOptions = {}): void {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (opts.matrix) g.applyMatrix4(opts.matrix);
    if (!g.getAttribute('uv')) {
      const n = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
    }
    // Drop everything except the attributes the shared materials consume.
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    const pos = g.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    _c.set(opts.color ?? 0xffffff);
    const aoBase = opts.aoBase ?? 0;
    const aoTop = opts.aoTop ?? 2.4;
    const minShade = opts.minShade ?? 0.6;
    for (let i = 0; i < pos.count; i++) {
      const t = clamp((pos.getY(i) - aoBase) / Math.max(0.0001, aoTop - aoBase), 0, 1);
      const shade = minShade + (1 - minShade) * smoothstep(t);
      colors[i * 3] = _c.r * shade;
      colors[i * 3 + 1] = _c.g * shade;
      colors[i * 3 + 2] = _c.b * shade;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    let list = this.parts.get(key);
    if (!list) {
      list = [];
      this.parts.set(key, list);
    }
    list.push(g);
  }

  /** Merge every bucket into one mesh per material key. */
  build(specs: Record<string, BatchMaterialSpec>): THREE.Group {
    const group = new THREE.Group();
    group.name = 'arena-batches';
    for (const [key, geos] of this.parts) {
      const spec = specs[key];
      if (!spec) {
        geos.forEach((g) => g.dispose());
        continue;
      }
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (!merged) {
        geos.forEach((g) => g.dispose());
        continue;
      }
      if (geos.length > 1) geos.forEach((g) => g.dispose());
      const mesh = new THREE.Mesh(merged, spec.material);
      mesh.name = `batch:${key}`;
      mesh.castShadow = spec.castShadow ?? true;
      mesh.receiveShadow = spec.receiveShadow ?? true;
      if (spec.renderOrder !== undefined) mesh.renderOrder = spec.renderOrder;
      group.add(mesh);
    }
    this.parts.clear();
    return group;
  }
}

/* ------------------------------------------------------------------ */
/* Geometry factories with texel-density-correct UVs                   */
/* ------------------------------------------------------------------ */

/** Box whose UVs are scaled so a texture tiling `tile` metres repeats evenly. */
export function boxGeo(w: number, h: number, d: number, tile = 2): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const faces: [number, number][] = [
    [d, h], [d, h], // +x, -x
    [w, d], [w, d], // +y, -y
    [w, h], [w, h], // +z, -z
  ];
  for (let f = 0; f < 6; f++) {
    const [su, sv] = faces[f];
    for (let i = 0; i < 4; i++) {
      const idx = f * 4 + i;
      uv.setXY(idx, (uv.getX(idx) * su) / tile, (uv.getY(idx) * sv) / tile);
    }
  }
  return g;
}

export function planeGeo(w: number, h: number, tile = 2, segX = 1, segY = 1): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, segX, segY);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * w) / tile, (uv.getY(i) * h) / tile);
  }
  return g;
}

export function cylGeo(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  radialSegments = 8,
  tile = 2,
  openEnded = false,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments, 1, openEnded);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const circ = Math.PI * 2 * Math.max(radiusTop, radiusBottom, 0.01);
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * circ) / tile, (uv.getY(i) * height) / tile);
  }
  return g;
}

export function coneGeo(radius: number, height: number, radialSegments = 8, tile = 2): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(radius, height, radialSegments, 1);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  const circ = Math.PI * 2 * radius;
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, (uv.getX(i) * circ) / tile, (uv.getY(i) * height) / tile);
  }
  return g;
}

/* ------------------------------------------------------------------ */
/* Matrix helper                                                       */
/* ------------------------------------------------------------------ */

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

export interface XForm {
  rx?: number;
  ry?: number;
  rz?: number;
  /** Euler order, default XYZ. */
  order?: THREE.EulerOrder;
  sx?: number;
  sy?: number;
  sz?: number;
}

export function xform(x: number, y: number, z: number, t: XForm = {}): THREE.Matrix4 {
  _p.set(x, y, z);
  _e.set(t.rx ?? 0, t.ry ?? 0, t.rz ?? 0, t.order ?? 'XYZ');
  _q.setFromEuler(_e);
  _s.set(t.sx ?? 1, t.sy ?? 1, t.sz ?? 1);
  return new THREE.Matrix4().compose(_p, _q, _s);
}

/** Convenience: add a box in world position with optional rotation/scale. */
export function addBox(
  batch: GeoBatch,
  key: string,
  size: [number, number, number],
  pos: [number, number, number],
  opts: AddOptions & XForm & { tile?: number } = {},
): void {
  const geo = boxGeo(size[0], size[1], size[2], opts.tile ?? 2);
  batch.add(key, geo, { ...opts, matrix: xform(pos[0], pos[1], pos[2], opts) });
}

export function addCyl(
  batch: GeoBatch,
  key: string,
  radiusTop: number,
  radiusBottom: number,
  height: number,
  pos: [number, number, number],
  opts: AddOptions & XForm & { tile?: number; seg?: number; open?: boolean } = {},
): void {
  const geo = cylGeo(radiusTop, radiusBottom, height, opts.seg ?? 8, opts.tile ?? 2, opts.open ?? false);
  batch.add(key, geo, { ...opts, matrix: xform(pos[0], pos[1], pos[2], opts) });
}

/* ------------------------------------------------------------------ */
/* Standalone geometry helpers (rocks, trees, crowd parts)             */
/* ------------------------------------------------------------------ */

/**
 * Paint a colour attribute onto a geometry, optionally with a vertical AO ramp.
 * The geometry keeps its other attributes untouched.
 */
export function paintVertexColors(
  geo: THREE.BufferGeometry,
  color: THREE.ColorRepresentation | THREE.Color,
  aoBase = -1000,
  aoTop = 1000,
  minShade = 1,
): void {
  const pos = geo.getAttribute('position');
  const colors = new Float32Array(pos.count * 3);
  const c = color instanceof THREE.Color ? color : new THREE.Color(color);
  for (let i = 0; i < pos.count; i++) {
    const t = clamp((pos.getY(i) - aoBase) / Math.max(0.0001, aoTop - aoBase), 0, 1);
    const shade = minShade + (1 - minShade) * smoothstep(t);
    colors[i * 3] = c.r * shade;
    colors[i * 3 + 1] = c.g * shade;
    colors[i * 3 + 2] = c.b * shade;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Merge a list of positioned geometries into one mesh. */
export function mergedMesh(
  geos: THREE.BufferGeometry[],
  material: THREE.Material,
  name: string,
  castShadow = true,
  receiveShadow = true,
): THREE.Mesh | null {
  // Normalise index state so mixed primitive geometries can be merged.
  const normalized = geos.map((g) => {
    if (!g.index) return g;
    const nonIndexed = g.toNonIndexed();
    g.dispose();
    return nonIndexed;
  });
  const merged = normalized.length === 1 ? normalized[0] : mergeGeometries(normalized, false);
  if (!merged) {
    normalized.forEach((g) => g.dispose());
    return null;
  }
  if (normalized.length > 1) normalized.forEach((g) => g.dispose());
  const mesh = new THREE.Mesh(merged, material);
  mesh.name = name;
  mesh.castShadow = castShadow;
  mesh.receiveShadow = receiveShadow;
  return mesh;
}

/** Dispose all geometry/material/texture resources below an object. */
export function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) {
      mat.forEach((m) => disposeMaterial(m));
    } else if (mat) {
      disposeMaterial(mat);
    }
  });
}

export function disposeMaterial(material: THREE.Material): void {
  const rec = material as unknown as Record<string, unknown>;
  for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'bumpMap', 'alphaMap', 'emissiveMap']) {
    const tex = rec[key] as THREE.Texture | null | undefined;
    if (tex && typeof tex.dispose === 'function') tex.dispose();
  }
  material.dispose();
}

/** True for objects whose material is shared elsewhere (so dispose skips it). */
export function markShared<T extends THREE.Object3D>(obj: T): T {
  obj.userData.shared = true;
  return obj;
}
