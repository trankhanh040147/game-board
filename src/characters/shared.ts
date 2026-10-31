import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Quality } from '../core/types';
import { mulberry32 } from '../core/utils';

/* ------------------------------------------------------------------ */
/* Detail levels                                                       */
/* ------------------------------------------------------------------ */

export interface CharacterDetail {
  quality: Quality;
  /** Main radial segment count for limbs / cylinders. */
  seg: number;
  /** Sphere width segments. */
  sphereW: number;
  sphereH: number;
  /** Extra greebles: rivets, lames, belt studs, trail. */
  extra: boolean;
  /** Weathered textures. */
  weather: boolean;
}

export function detailFor(quality: Quality): CharacterDetail {
  if (quality === 'low') return { quality, seg: 6, sphereW: 8, sphereH: 6, extra: false, weather: false };
  if (quality === 'medium') return { quality, seg: 8, sphereW: 10, sphereH: 7, extra: true, weather: false };
  return { quality, seg: 10, sphereW: 12, sphereH: 9, extra: true, weather: true };
}

/* ------------------------------------------------------------------ */
/* Colour helpers                                                      */
/* ------------------------------------------------------------------ */

export function shade(hex: number, factor: number): number {
  const r = Math.min(255, Math.max(0, Math.round(((hex >> 16) & 255) * factor)));
  const g = Math.min(255, Math.max(0, Math.round(((hex >> 8) & 255) * factor)));
  const b = Math.min(255, Math.max(0, Math.round((hex & 255) * factor)));
  return (r << 16) | (g << 8) | b;
}

export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

export function hueShift(hex: number, deg: number, satMul = 1): number {
  const c = new THREE.Color(hex);
  const hsl = { h: 0, s: 0, l: 0 };
  c.getHSL(hsl);
  c.setHSL((hsl.h + deg / 360 + 1) % 1, Math.min(1, hsl.s * satMul), hsl.l);
  return c.getHex();
}

export function cssColor(hex: number): string {
  return '#' + (hex >>> 0).toString(16).padStart(6, '0');
}

/* ------------------------------------------------------------------ */
/* Canvas textures                                                     */
/* ------------------------------------------------------------------ */

const hasDOM = (): boolean => typeof document !== 'undefined' && typeof document.createElement === 'function';

function makeCanvas(w: number, h: number): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (!hasDOM()) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  return { canvas, ctx };
}

function finalizeTex(
  canvas: HTMLCanvasElement,
  repeatX: number,
  repeatY: number,
  srgb = true,
): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function noiseOverlay(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  rng: () => number,
  alpha: number,
  grey = true,
): void {
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = (rng() - 0.5) * 255;
    if (grey) {
      d[i] = Math.min(255, Math.max(0, d[i] + n));
      d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n));
      d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n));
    }
    d[i + 3] = d[i + 3] * (1 - alpha) + 255 * alpha;
  }
  ctx.putImageData(img, 0, 0);
}

interface TexSet {
  env?: THREE.Texture;
  cloth?: THREE.Texture;
  quilt?: THREE.Texture;
  leather?: THREE.Texture;
  mail?: THREE.Texture;
  scale?: THREE.Texture;
  metal?: THREE.Texture;
  wood?: THREE.Texture;
  hair?: THREE.Texture;
}

let texSet: TexSet | null = null;

/** Generate the small library of procedural grayscale material maps (once). */
export function getCharacterTextures(): TexSet {
  if (texSet) return texSet;
  const out: TexSet = {};

  // Tiny equirectangular gradient used as a cheap environment reflection for
  // metal armour. Keeps steel readable without a global scene.environment.
  {
    const c = makeCanvas(64, 32);
    if (c) {
      const { canvas, ctx } = c;
      const grad = ctx.createLinearGradient(0, 0, 0, 32);
      grad.addColorStop(0, '#cfd8dd');
      grad.addColorStop(0.42, '#e8e2d2');
      grad.addColorStop(0.5, '#f6ecd6');
      grad.addColorStop(0.56, '#a8926d');
      grad.addColorStop(0.8, '#5d4c36');
      grad.addColorStop(1, '#2b241a');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 64, 32);
      // A bright sun streak for specular interest.
      const sun = ctx.createRadialGradient(18, 10, 0, 18, 10, 12);
      sun.addColorStop(0, 'rgba(255,248,225,1)');
      sun.addColorStop(1, 'rgba(255,248,225,0)');
      ctx.fillStyle = sun;
      ctx.fillRect(0, 0, 64, 32);
      const tex = new THREE.CanvasTexture(canvas);
      tex.mapping = THREE.EquirectangularReflectionMapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      out.env = tex;
    }
  }

  // Cloth weave: fine cross-hatch with slubs.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x11a2);
      ctx.fillStyle = '#cfcfcf';
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 260; i++) {
        const x = rng() * 128;
        const y = rng() * 128;
        const l = 4 + rng() * 22;
        const dark = rng() > 0.5;
        ctx.strokeStyle = dark ? `rgba(90,90,90,${0.05 + rng() * 0.1})` : `rgba(245,245,245,${0.05 + rng() * 0.1})`;
        ctx.lineWidth = 0.7 + rng() * 1.1;
        if (rng() > 0.5) {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + l, y);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x, y + l);
          ctx.stroke();
        }
      }
      noiseOverlay(ctx, 128, 128, mulberry32(0x11a3), 0.16);
      out.cloth = finalizeTex(canvas, 2.4, 2.4);
    }
  }

  // Quilted gambeson: diamond lattice with stitch shadow.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x22b1);
      ctx.fillStyle = '#c9c9c9';
      ctx.fillRect(0, 0, 128, 128);
      const step = 32;
      for (let y = -128; y < 256; y += step) {
        for (let x = -128; x < 256; x += step) {
          ctx.strokeStyle = 'rgba(60,60,60,0.55)';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + step, y + step);
          ctx.moveTo(x + step, y);
          ctx.lineTo(x, y + step);
          ctx.stroke();
          ctx.fillStyle = 'rgba(255,255,255,0.10)';
          ctx.beginPath();
          ctx.arc(x + step * 0.5, y + step * 0.5, step * 0.32, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      noiseOverlay(ctx, 128, 128, rng, 0.2);
      out.quilt = finalizeTex(canvas, 2.6, 2.6);
    }
  }

  // Leather: pebbled grain with creases.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x33c4);
      ctx.fillStyle = '#b9b9b9';
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 900; i++) {
        const x = rng() * 128;
        const y = rng() * 128;
        const r = 0.6 + rng() * 2.4;
        const v = 60 + Math.floor(rng() * 170);
        ctx.fillStyle = `rgba(${v},${v},${v},${0.12 + rng() * 0.2})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      for (let i = 0; i < 16; i++) {
        ctx.strokeStyle = `rgba(50,50,50,${0.1 + rng() * 0.2})`;
        ctx.lineWidth = 0.8;
        ctx.beginPath();
        const x = rng() * 128;
        const y = rng() * 128;
        ctx.moveTo(x, y);
        ctx.bezierCurveTo(x + 20, y + rng() * 14 - 7, x + 34, y + rng() * 20 - 10, x + 54, y + rng() * 16 - 8);
        ctx.stroke();
      }
      noiseOverlay(ctx, 128, 128, rng, 0.2);
      out.leather = finalizeTex(canvas, 2.2, 2.2);
    }
  }

  // Mail: tight ring rows.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      ctx.fillStyle = '#7d7d7d';
      ctx.fillRect(0, 0, 128, 128);
      const r = 5;
      for (let row = 0; row < 16; row++) {
        const y = row * 8 + 4;
        const off = row % 2 === 0 ? 0 : r;
        for (let col = -1; col < 16; col++) {
          const x = col * r * 2 + off;
          ctx.strokeStyle = 'rgba(235,235,235,0.85)';
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(x, y, r * 0.92, 0, Math.PI * 2);
          ctx.stroke();
          ctx.strokeStyle = 'rgba(20,20,20,0.7)';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(x, y - 0.6, r * 0.72, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      noiseOverlay(ctx, 128, 128, mulberry32(0x44d5), 0.12);
      out.mail = finalizeTex(canvas, 4.2, 4.2);
    }
  }

  // Scale: overlapping lames.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      ctx.fillStyle = '#8c8c8c';
      ctx.fillRect(0, 0, 128, 128);
      const sw = 14;
      const sh = 12;
      for (let row = -1; row < 12; row++) {
        const y = row * sh;
        const off = (row % 2) * (sw / 2);
        for (let col = -1; col < 12; col++) {
          const x = col * sw + off;
          const grad = ctx.createLinearGradient(x, y, x, y + sh);
          grad.addColorStop(0, 'rgba(240,240,240,0.95)');
          grad.addColorStop(0.55, 'rgba(160,160,160,0.95)');
          grad.addColorStop(1, 'rgba(70,70,70,0.95)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x + sw, y);
          ctx.lineTo(x + sw, y + sh * 0.55);
          ctx.quadraticCurveTo(x + sw / 2, y + sh * 1.15, x, y + sh * 0.55);
          ctx.closePath();
          ctx.fill();
          ctx.strokeStyle = 'rgba(25,25,25,0.65)';
          ctx.lineWidth = 0.9;
          ctx.stroke();
        }
      }
      noiseOverlay(ctx, 128, 128, mulberry32(0x55e6), 0.1);
      out.scale = finalizeTex(canvas, 3.4, 3.4);
    }
  }

  // Steel: brushed streaks + subtle pitting.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x66f7);
      ctx.fillStyle = '#cfcfcf';
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 260; i++) {
        const y = rng() * 128;
        const x = rng() * 128;
        const len = 8 + rng() * 60;
        const bright = rng() > 0.5;
        ctx.strokeStyle = bright
          ? `rgba(255,255,255,${0.03 + rng() * 0.09})`
          : `rgba(80,80,80,${0.03 + rng() * 0.09})`;
        ctx.lineWidth = 0.6 + rng();
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + len, y + (rng() - 0.5) * 1.2);
        ctx.stroke();
      }
      for (let i = 0; i < 70; i++) {
        const x = rng() * 128;
        const y = rng() * 128;
        const r = 0.5 + rng() * 1.4;
        ctx.fillStyle = `rgba(60,60,60,${0.15 + rng() * 0.25})`;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      out.metal = finalizeTex(canvas, 2.0, 2.0);
    }
  }

  // Wood: grain.
  {
    const c = makeCanvas(128, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x7708);
      ctx.fillStyle = '#c4c4c4';
      ctx.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 44; i++) {
        const x = rng() * 128;
        ctx.strokeStyle = `rgba(60,60,60,${0.08 + rng() * 0.2})`;
        ctx.lineWidth = 0.6 + rng() * 2;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.bezierCurveTo(x + 8, 40, x - 8, 90, x + 4, 128);
        ctx.stroke();
      }
      noiseOverlay(ctx, 128, 128, rng, 0.14);
      out.wood = finalizeTex(canvas, 1.6, 2.8);
    }
  }

  // Hair: directional strands.
  {
    const c = makeCanvas(64, 128);
    if (c) {
      const { canvas, ctx } = c;
      const rng = mulberry32(0x8819);
      ctx.fillStyle = '#bdbdbd';
      ctx.fillRect(0, 0, 64, 128);
      for (let i = 0; i < 220; i++) {
        const x = rng() * 64;
        const y = rng() * 128;
        const len = 10 + rng() * 40;
        ctx.strokeStyle = `rgba(40,40,40,${0.12 + rng() * 0.3})`;
        ctx.lineWidth = 0.5 + rng() * 1.1;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + (rng() - 0.5) * 8, y + len * 0.5, x + (rng() - 0.5) * 12, y + len);
        ctx.stroke();
      }
      out.hair = finalizeTex(canvas, 1.4, 2.2);
    }
  }

  texSet = out;
  return out;
}

/* ------------------------------------------------------------------ */
/* Material library                                                    */
/* ------------------------------------------------------------------ */

export type MatClass =
  | 'cloth'
  | 'quilt'
  | 'leather'
  | 'skin'
  | 'hair'
  | 'metal'
  | 'mail'
  | 'scale'
  | 'dark'
  | 'wood';

export interface MaterialLibrary {
  cloth: THREE.MeshStandardMaterial;
  quilt: THREE.MeshStandardMaterial;
  leather: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  hair: THREE.MeshStandardMaterial;
  metal: THREE.MeshStandardMaterial;
  mail: THREE.MeshStandardMaterial;
  scale: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  wood: THREE.MeshStandardMaterial;
  /** Materials created for heraldic surfaces, keyed by cache key. */
  painted(key: string, tex: THREE.Texture): THREE.MeshStandardMaterial;
}

let matLib: MaterialLibrary | null = null;
const paintedMats = new Map<string, THREE.MeshStandardMaterial>();

export function getMaterials(): MaterialLibrary {
  if (matLib) return matLib;
  const t = getCharacterTextures();
  const vc = (opts: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial =>
    new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xffffff, ...opts });

  matLib = {
    cloth: vc({ map: t.cloth ?? null, roughness: 0.94, metalness: 0.0 }),
    quilt: vc({ map: t.quilt ?? null, roughness: 0.97, metalness: 0.0 }),
    leather: vc({ map: t.leather ?? null, roughness: 0.72, metalness: 0.03 }),
    skin: vc({ roughness: 0.66, metalness: 0.0 }),
    hair: vc({ map: t.hair ?? null, roughness: 0.9, metalness: 0.0 }),
    metal: vc({ map: t.metal ?? null, roughness: 0.32, metalness: 0.62, envMap: t.env ?? null, envMapIntensity: 0.6 }),
    mail: vc({ map: t.mail ?? null, roughness: 0.64, metalness: 0.5, envMap: t.env ?? null, envMapIntensity: 0.26 }),
    scale: vc({ map: t.scale ?? null, roughness: 0.46, metalness: 0.55, envMap: t.env ?? null, envMapIntensity: 0.42 }),
    dark: vc({ roughness: 0.85, metalness: 0.1 }),
    wood: vc({ map: t.wood ?? null, roughness: 0.82, metalness: 0.0 }),
    painted(key: string, tex: THREE.Texture): THREE.MeshStandardMaterial {
      const hit = paintedMats.get(key);
      if (hit) return hit;
      const m = new THREE.MeshStandardMaterial({ map: tex, color: 0xffffff, roughness: 0.82, metalness: 0.04 });
      paintedMats.set(key, m);
      return m;
    },
  };
  return matLib;
}

/* ------------------------------------------------------------------ */
/* Geometry helpers                                                    */
/* ------------------------------------------------------------------ */

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpS = new THREE.Vector3(1, 1, 1);
const tmpP = new THREE.Vector3();

export function trs(
  x: number, y: number, z: number,
  rx = 0, ry = 0, rz = 0,
  sx = 1, sy = 1, sz = 1,
): THREE.Matrix4 {
  tmpE.set(rx, ry, rz, 'XYZ');
  tmpQ.setFromEuler(tmpE);
  tmpP.set(x, y, z);
  tmpS.set(sx, sy, sz);
  return new THREE.Matrix4().compose(tmpP, tmpQ, tmpS);
}

/**
 * Tapered box with flat normals + per-face UVs.
 * Bottom face is `wB` × `dB` at y = -h/2, top is `wT` × `dT` at +h/2.
 */
export function taperedBox(
  wB: number, dB: number, wT: number, dT: number, h: number,
  shiftTopZ = 0, shiftTopX = 0,
): THREE.BufferGeometry {
  const hwB = wB / 2;
  const hdB = dB / 2;
  const hwT = wT / 2;
  const hdT = dT / 2;
  const hy = h / 2;
  // 8 corners: bottom (0..3) ccw from front-left, top (4..7)
  const b0 = [-hwB, -hy, hdB];
  const b1 = [hwB, -hy, hdB];
  const b2 = [hwB, -hy, -hdB];
  const b3 = [-hwB, -hy, -hdB];
  const t0 = [-hwT + shiftTopX, hy, hdT + shiftTopZ];
  const t1 = [hwT + shiftTopX, hy, hdT + shiftTopZ];
  const t2 = [hwT + shiftTopX, hy, -hdT + shiftTopZ];
  const t3 = [-hwT + shiftTopX, hy, -hdT + shiftTopZ];
  const faces: number[][][] = [
    [b0, b1, t1, t0], // +Z front
    [b1, b2, t2, t1], // +X right
    [b2, b3, t3, t2], // -Z back
    [b3, b0, t0, t3], // -X left
    [t0, t1, t2, t3], // top
    [b3, b2, b1, b0], // bottom
  ];
  const uv: number[][] = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const position: number[] = [];
  const normal: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

/**
 * Lofted tube: a stack of rings defined by [y, rx, rz, offsetX, offsetZ].
 * Flat indexed geometry with smooth normals.
 */
export function loft(
  rings: [number, number, number, number, number][],
  seg: number,
  capBottom = true,
  capTop = true,
): THREE.BufferGeometry {
  const position: number[] = [];
  const uvs: number[] = [];
  const index: number[] = [];
  for (let r = 0; r < rings.length; r++) {
    const [y, rx, rz, ox, oz] = rings[r];
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      // Start at front (+Z) so UV seams sit at the back.
      const sx = Math.sin(a) * rx + ox;
      const sz = Math.cos(a) * rz + oz;
      position.push(sx, y, sz);
      uvs.push(i / seg, r / (rings.length - 1));
    }
  }
  const rowLen = seg + 1;
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < seg; i++) {
      const a = r * rowLen + i;
      const b = a + 1;
      const c = a + rowLen;
      const d = c + 1;
      index.push(a, b, c, b, d, c);
    }
  }
  const cap = (ring: [number, number, number, number, number], flip: boolean): void => {
    const [y, rx, rz, ox, oz] = ring;
    const center = position.length / 3;
    position.push(ox, y, oz);
    uvs.push(0.5, 0.5);
    const start = position.length / 3;
    for (let i = 0; i <= seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      position.push(Math.sin(a) * rx + ox, y, Math.cos(a) * rz + oz);
      uvs.push(0.5 + Math.sin(a) * 0.5, 0.5 + Math.cos(a) * 0.5);
    }
    for (let i = 0; i < seg; i++) {
      if (flip) index.push(center, start + i + 1, start + i);
      else index.push(center, start + i, start + i + 1);
    }
  };
  if (capBottom) cap(rings[0], true);
  if (capTop) cap(rings[rings.length - 1], false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Flattened, rounded blade profile extruded on Z. */
export function bladeGeometry(length: number, width: number, thickness: number, taper = 0.55, curve = 0): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw * 0.92 + curve, length * 0.82);
  shape.lineTo(0 + curve * 1.4, length);
  shape.lineTo(-hw * 0.92 + curve, length * 0.82);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.4,
    bevelSize: Math.max(0.001, hw * 0.18 * taper),
    bevelSegments: 1,
    curveSegments: 2,
  });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/* ------------------------------------------------------------------ */
/* Part collection + merging                                           */
/* ------------------------------------------------------------------ */

interface PartEntry {
  geo: THREE.BufferGeometry;
  cls: MatClass;
}

const linColor = new THREE.Color();

/** Collects per-joint, per-material-class geometry and merges it into few meshes. */
export class PartCollector {
  private parts = new Map<string, Map<MatClass, PartEntry[]>>();
  /** Extra painted styles: keyed by material key; merged separately. */
  private painted = new Map<string, Map<string, THREE.BufferGeometry[]>>();
  private paintedTex = new Map<string, THREE.Texture>();

  addRaw(
    joint: string,
    cls: MatClass,
    color: number,
    geo: THREE.BufferGeometry,
    matrix?: THREE.Matrix4,
  ): void {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    // Bake linear vertex colour.
    linColor.setHex(color >>> 0, THREE.SRGBColorSpace);
    const count = g.getAttribute('position').count;
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = linColor.r;
      col[i * 3 + 1] = linColor.g;
      col[i * 3 + 2] = linColor.b;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    let byClass = this.parts.get(joint);
    if (!byClass) {
      byClass = new Map();
      this.parts.set(joint, byClass);
    }
    let arr = byClass.get(cls);
    if (!arr) {
      arr = [];
      byClass.set(cls, arr);
    }
    arr.push({ geo: g, cls });
  }

  /** Flat coloured plane (e.g. heraldry) with its own texture. */
  addPainted(
    joint: string,
    key: string,
    tex: THREE.Texture,
    color: number,
    geo: THREE.BufferGeometry,
    matrix?: THREE.Matrix4,
  ): void {
    let g = geo.index ? geo.toNonIndexed() : geo.clone();
    if (matrix) g.applyMatrix4(matrix);
    if (!g.getAttribute('normal')) g.computeVertexNormals();
    if (!g.getAttribute('uv')) {
      const count = g.getAttribute('position').count;
      g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
    }
    const count = g.getAttribute('position').count;
    linColor.setHex(color >>> 0, THREE.SRGBColorSpace);
    const col = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      col[i * 3] = linColor.r;
      col[i * 3 + 1] = linColor.g;
      col[i * 3 + 2] = linColor.b;
    }
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    let m = this.painted.get(key);
    if (!m) {
      m = new Map();
      this.painted.set(key, m);
    }
    let arr = m.get(joint);
    if (!arr) {
      arr = [];
      m.set(joint, arr);
    }
    arr.push(g);
    this.paintedTex.set(key, tex);
  }

  box(
    joint: string, cls: MatClass, color: number,
    w: number, h: number, d: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
  ): void {
    const geo = new THREE.BoxGeometry(w, h, d);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz));
    geo.dispose();
  }

  taper(
    joint: string, cls: MatClass, color: number,
    wB: number, dB: number, wT: number, dT: number, h: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0, shiftTopZ = 0,
  ): void {
    const geo = taperedBox(wB, dB, wT, dT, h, shiftTopZ);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz));
    geo.dispose();
  }

  cyl(
    joint: string, cls: MatClass, color: number,
    rTop: number, rBottom: number, h: number, seg: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
    sx = 1, sy = 1, sz = 1,
  ): void {
    const geo = new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, false);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz, sx, sy, sz));
    geo.dispose();
  }

  sphere(
    joint: string, cls: MatClass, color: number,
    r: number, sw: number, sh: number,
    x: number, y: number, z: number,
    sx = 1, sy = 1, sz = 1,
    rx = 0, ry = 0, rz = 0,
  ): void {
    const geo = new THREE.SphereGeometry(r, sw, sh);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz, sx, sy, sz));
    geo.dispose();
  }

  capsule(
    joint: string, cls: MatClass, color: number,
    r: number, len: number, seg: number,
    x: number, y: number, z: number,
    rx = 0, ry = 0, rz = 0,
    sx = 1, sz = 1,
  ): void {
    const geo = new THREE.CapsuleGeometry(r, len, 3, seg);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz, sx, 1, sz));
    geo.dispose();
  }

  hemisphere(
    joint: string, cls: MatClass, color: number,
    r: number, sw: number, sh: number,
    x: number, y: number, z: number,
    sx = 1, sy = 1, sz = 1,
    rx = 0, ry = 0, rz = 0,
    phiLength = Math.PI * 2,
  ): void {
    const geo = new THREE.SphereGeometry(r, sw, sh, 0, phiLength, 0, Math.PI / 2);
    this.addRaw(joint, cls, color, geo, trs(x, y, z, rx, ry, rz, sx, sy, sz));
    geo.dispose();
  }

  /**
   * Merge all parts into one SkinnedMesh per material class.
   *
   * Every vertex is rigidly weighted to exactly one bone (rigid-part rig), so a
   * whole fighter costs ~10 draw calls instead of ~40, with identical animation
   * behaviour (the skeleton is the same joint hierarchy).
   */
  buildSkinned(
    boneList: THREE.Bone[],
    bonesByName: Map<string, THREE.Bone>,
    root: THREE.Object3D,
    materials: MaterialLibrary,
    opts: { castShadow?: boolean; receiveShadow?: boolean } = {},
  ): { meshes: THREE.SkinnedMesh[]; skeleton: THREE.Skeleton } {
    const meshes: THREE.SkinnedMesh[] = [];
    const cast = opts.castShadow !== false;
    const receive = opts.receiveShadow !== false;

    // Bind pose: root must be at identity so bone world matrices are root-local.
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(boneList);
    const boneIndex = new Map<THREE.Bone, number>();
    boneList.forEach((b, i) => boneIndex.set(b, i));
    const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const boneWorld = new THREE.Matrix4();

    const prep = (jointName: string, geo: THREE.BufferGeometry): boolean => {
      const bone = bonesByName.get(jointName);
      if (!bone) return false;
      const idx = boneIndex.get(bone);
      if (idx === undefined) return false;
      boneWorld.multiplyMatrices(rootInverse, bone.matrixWorld);
      geo.applyMatrix4(boneWorld);
      const count = geo.getAttribute('position').count;
      // Baked shading variation: subtle vertical ambient occlusion (lower body
      // darker, as if lit from above) + per-part colour jitter, so large flat
      // armour surfaces read hand-painted rather than plastic.
      const colorAttr = geo.getAttribute('color') as THREE.BufferAttribute | undefined;
      if (colorAttr) {
        geo.computeBoundingBox();
        const bb = geo.boundingBox;
        const cy = bb ? (bb.min.y + bb.max.y) * 0.5 : 1;
        const ao = 0.9 + 0.13 * Math.min(1, Math.max(0, (cy + 0.05) / 1.7));
        const pos = geo.getAttribute('position');
        for (let i = 0; i < count; i++) {
          const px = pos.getX(i);
          const py = pos.getY(i);
          const pz = pos.getZ(i);
          const h = Math.sin(px * 91.7 + py * 43.1 + pz * 77.3) * 0.5 + 0.5;
          const jitter = 0.94 + h * 0.12;
          colorAttr.setXYZ(
            i,
            colorAttr.getX(i) * ao * jitter,
            colorAttr.getY(i) * ao * jitter,
            colorAttr.getZ(i) * ao * jitter,
          );
        }
        colorAttr.needsUpdate = true;
      }
      const skinIndex = new Uint16Array(count * 4);
      const skinWeight = new Float32Array(count * 4);
      for (let i = 0; i < count; i++) {
        skinIndex[i * 4] = idx;
        skinWeight[i * 4] = 1;
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
      return true;
    };

    const byClass = new Map<MatClass, THREE.BufferGeometry[]>();
    const byPaint = new Map<string, THREE.BufferGeometry[]>();
    for (const [jointName, classMap] of this.parts) {
      for (const [cls, entries] of classMap) {
        for (const e of entries) {
          if (!prep(jointName, e.geo)) continue;
          let arr = byClass.get(cls);
          if (!arr) {
            arr = [];
            byClass.set(cls, arr);
          }
          arr.push(e.geo);
        }
      }
    }
    this.parts.clear();
    for (const [key, byJoint] of this.painted) {
      for (const [jointName, geos] of byJoint) {
        for (const g of geos) {
          if (!prep(jointName, g)) continue;
          let arr = byPaint.get(key);
          if (!arr) {
            arr = [];
            byPaint.set(key, arr);
          }
          arr.push(g);
        }
      }
    }
    this.painted.clear();

    const makeSkinned = (geos: THREE.BufferGeometry[], material: THREE.Material, name: string): void => {
      const merged = geos.length === 1 ? geos[0] : mergeGeometries(geos, false);
      if (geos.length !== 1) for (const g of geos) g.dispose();
      if (!merged) return;
      merged.computeBoundingSphere();
      const mesh = new THREE.SkinnedMesh(merged, material);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      root.add(mesh);
      mesh.updateMatrixWorld(true);
      mesh.bind(skeleton);
      meshes.push(mesh);
    };

    for (const [cls, geos] of byClass) {
      makeSkinned(geos, materials[cls], `body:${cls}`);
    }
    for (const [key, geos] of byPaint) {
      const tex = this.paintedTex.get(key);
      const mat = tex ? materials.painted(key, tex) : materials.cloth;
      makeSkinned(geos, mat, `painted:${key}`);
    }
    this.paintedTex.clear();

    return { meshes, skeleton };
  }
}

/* ------------------------------------------------------------------ */
/* Spring                                                              */
/* ------------------------------------------------------------------ */

/** Critically-damped-ish spring for a scalar channel. */
export class Spring {
  value = 0;
  target = 0;
  private vel = 0;

  constructor(value = 0) {
    this.value = value;
    this.target = value;
  }

  reset(v: number): void {
    this.value = v;
    this.target = v;
    this.vel = 0;
  }

  update(dt: number, stiffness: number, dampingRatio = 0.85): number {
    if (dt <= 0) return this.value;
    // Semi-implicit damped spring.
    const omega = stiffness;
    const accel = omega * omega * (this.target - this.value) - 2 * dampingRatio * omega * this.vel;
    this.vel += accel * dt;
    this.value += this.vel * dt;
    if (!Number.isFinite(this.value)) {
      this.value = this.target;
      this.vel = 0;
    }
    return this.value;
  }
}

export const TMP_V1 = new THREE.Vector3();
export const TMP_V2 = new THREE.Vector3();
export const TMP_V3 = new THREE.Vector3();
export const TMP_V4 = new THREE.Vector3();
export const TMP_M1 = new THREE.Matrix4();

/* ------------------------------------------------------------------ */
/* Cached primitive geometry (shared across fighters)                  */
/* ------------------------------------------------------------------ */

const loftCache = new Map<string, THREE.BufferGeometry>();
const taperCache = new Map<string, THREE.BufferGeometry>();

/** Memoised `loft` so 16 fighters share identical torso shells. */
export function loftCached(
  key: string,
  rings: [number, number, number, number, number][],
  seg: number,
  capBottom = true,
  capTop = true,
): THREE.BufferGeometry {
  const cacheKey = `${key}:${seg}:${capBottom ? 1 : 0}${capTop ? 1 : 0}`;
  const hit = loftCache.get(cacheKey);
  if (hit) return hit;
  const g = loft(rings, seg, capBottom, capTop);
  loftCache.set(cacheKey, g);
  return g;
}

/** Memoised tapered box. */
export function taperedBoxCached(
  wB: number, dB: number, wT: number, dT: number, h: number,
  shiftTopZ = 0, shiftTopX = 0,
): THREE.BufferGeometry {
  const cacheKey = `tb:${wB}:${dB}:${wT}:${dT}:${h}:${shiftTopZ}:${shiftTopX}`;
  const hit = taperCache.get(cacheKey);
  if (hit) return hit;
  const g = taperedBox(wB, dB, wT, dT, h, shiftTopZ, shiftTopX);
  taperCache.set(cacheKey, g);
  return g;
}
