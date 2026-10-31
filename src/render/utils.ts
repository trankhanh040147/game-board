/**
 * FIRST HEARTH — renderer low-level utilities
 * -------------------------------------------
 * Isometric geometry constants, deterministic hash noise, packed-colour helpers
 * and small canvas helpers. Everything here is cosmetic: the simulation never
 * imports this module.
 *
 * Isometric basis (2:1 diamonds, 64x32 tile):
 *   mapX = (x - y) * 32
 *   mapY = (x + y) * 16          <- this is the NORTH vertex of tile (x, y)
 * The top face of a tile is the diamond
 *   N=(mx, my-h) E=(mx+32, my+16-h) S=(mx, my+32-h) W=(mx-32, my+16-h)
 * where h is the tile's elevation height in map pixels.
 */

// ---------------------------------------------------------------------------
// Geometry constants
// ---------------------------------------------------------------------------

export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

/** Maximum vertical displacement (map px) between the lowest and highest tile. */
export const ELEV_PX = 118;
/** Elevation value treated as the water plane. */
export const SEA_LEVEL = 0.3;
/** Terrain chunk size in tiles (square). */
export const CHUNK_TILES = 8;

// ---------------------------------------------------------------------------
// Scalar math
// ---------------------------------------------------------------------------

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const invLerp = (a: number, b: number, v: number): number => (b === a ? 0 : clamp01((v - a) / (b - a)));

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-9));
  return t * t * (3 - 2 * t);
}

/** Frame-rate independent exponential approach factor. */
export function approach(rate: number, dtSeconds: number): number {
  return 1 - Math.exp(-rate * dtSeconds);
}

export function easeOutCubic(t: number): number {
  const u = 1 - clamp01(t);
  return 1 - u * u * u;
}

export function fract(v: number): number {
  return v - Math.floor(v);
}

export function mod(v: number, m: number): number {
  return ((v % m) + m) % m;
}

// ---------------------------------------------------------------------------
// Deterministic hash noise (stable across frames; used for procedural variants)
// ---------------------------------------------------------------------------

/** 32-bit integer avalanche -> [0,1). */
export function hashInt(n: number): number {
  let h = n | 0;
  h = Math.imul(h ^ (h >>> 16), 0x21f0aaad);
  h = Math.imul(h ^ (h >>> 15), 0x735a2d97);
  h = h ^ (h >>> 15);
  return (h >>> 0) / 4294967296;
}

export function hash2(x: number, y: number, seed = 0): number {
  return hashInt(Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041));
}

export function hash3(x: number, y: number, z: number, seed = 0): number {
  return hashInt(
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519) ^ Math.imul(seed | 0, 1442695041),
  );
}

/** Value noise in [0,1) built from hashed lattice points with smooth interpolation. */
export function valueNoise(x: number, y: number, seed = 0): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const sx = xf * xf * (3 - 2 * xf);
  const sy = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** 2-octave value noise in [0,1). */
export function fbm2(x: number, y: number, seed = 0): number {
  return valueNoise(x, y, seed) * 0.62 + valueNoise(x * 2.13, y * 2.13, seed + 17) * 0.38;
}

// ---------------------------------------------------------------------------
// Packed colours: 0xRRGGBB integers (fast to blend, cheap to cache as CSS)
// ---------------------------------------------------------------------------

export function rgb(r: number, g: number, b: number): number {
  return ((clamp(r | 0, 0, 255) << 16) | (clamp(g | 0, 0, 255) << 8) | clamp(b | 0, 0, 255)) >>> 0;
}

export const redOf = (c: number): number => (c >>> 16) & 0xff;
export const greenOf = (c: number): number => (c >>> 8) & 0xff;
export const blueOf = (c: number): number => c & 0xff;

export function hexColor(hex: string): number {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? n >>> 0 : 0x808080;
}

export function mixColor(a: number, b: number, t: number): number {
  const u = clamp01(t);
  if (u <= 0) return a;
  if (u >= 1) return b;
  const r = (redOf(a) * (1 - u) + redOf(b) * u) | 0;
  const g = (greenOf(a) * (1 - u) + greenOf(b) * u) | 0;
  const bl = (blueOf(a) * (1 - u) + blueOf(b) * u) | 0;
  return ((r << 16) | (g << 8) | bl) >>> 0;
}

/** Multiply brightness (f > 1 lifts, f < 1 darkens). */
export function shadeColor(c: number, f: number): number {
  return rgb(redOf(c) * f, greenOf(c) * f, blueOf(c) * f);
}

/** Mix toward white. */
export function lightenColor(c: number, t: number): number {
  return mixColor(c, 0xffffff, t);
}

/** Mix toward black. */
export function darkenColor(c: number, t: number): number {
  return mixColor(c, 0x000000, t);
}

/** Push saturation: s=0 grey, s=1 unchanged, s>1 more saturated. */
export function saturateColor(c: number, s: number): number {
  const r = redOf(c);
  const g = greenOf(c);
  const b = blueOf(c);
  const l = r * 0.299 + g * 0.587 + b * 0.114;
  return rgb(l + (r - l) * s, l + (g - l) * s, l + (b - l) * s);
}

/** Warm the colour (pull toward a candle/brass tone). */
export function warm(c: number, t: number): number {
  return mixColor(c, 0xd9a86a, t);
}

/** Cool the colour (pull toward a night blue). */
export function cool(c: number, t: number): number {
  return mixColor(c, 0x7f9ab4, t);
}

// CSS string cache (colour -> css). Hot paths favour packed ints, strings are
// only materialised when actually handed to the canvas.
const cssCache = new Map<number, string>();
const cssAlphaCache = new Map<number, string>();

export function cssColor(c: number): string {
  const hit = cssCache.get(c);
  if (hit !== undefined) return hit;
  const s = `rgb(${redOf(c)},${greenOf(c)},${blueOf(c)})`;
  cssCache.set(c, s);
  return s;
}

export function cssColorAlpha(c: number, alpha: number): string {
  const a = clamp01(alpha);
  if (a >= 1) return cssColor(c);
  const qa = Math.round(a * 100);
  const key = c * 101 + qa;
  const hit = cssAlphaCache.get(key);
  if (hit !== undefined) return hit;
  const s = `rgba(${redOf(c)},${greenOf(c)},${blueOf(c)},${qa / 100})`;
  cssAlphaCache.set(key, s);
  return s;
}

/** hsl-ish tint helper used by overlays. */
export function hslColor(h: number, s: number, l: number): number {
  const hh = mod(h, 360) / 360;
  const ss = clamp01(s);
  const ll = clamp01(l);
  const hue2rgb = (p: number, q: number, t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
  const p = 2 * ll - q;
  return rgb(hue2rgb(p, q, hh + 1 / 3) * 255, hue2rgb(p, q, hh) * 255, hue2rgb(p, q, hh - 1 / 3) * 255);
}

/** Parse a #rrggbb colour to [h,s,l] (0..360, 0..1, 0..1). */
export function toHsl(c: number): [number, number, number] {
  const r = redOf(c) / 255;
  const g = greenOf(c) / 255;
  const b = blueOf(c) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return [h * 360, s, l];
}

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(width));
  c.height = Math.max(1, Math.ceil(height));
  return c;
}

export function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return ctx;
}

/** Point-in-diamond test in map space. N=(cx,cy-TILE_H/2)... here cx,cy is the diamond centre. */
export function pointInDiamond(px: number, py: number, cx: number, cy: number, hw = HALF_W, hh = HALF_H): boolean {
  const dx = Math.abs(px - cx) / hw;
  const dy = Math.abs(py - cy) / hh;
  return dx + dy <= 1;
}

/** Trace a diamond path whose north vertex is (nx, ny). */
export function diamondPath(ctx: CanvasRenderingContext2D, nx: number, ny: number, scale = 1): void {
  const hw = HALF_W * scale;
  const hh = HALF_H * scale;
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx + hw, ny + hh);
  ctx.lineTo(nx, ny + 2 * hh);
  ctx.lineTo(nx - hw, ny + hh);
  ctx.closePath();
}

/** Trace a polygon from a flat [x0,y0,x1,y1,...] array. */
export function polygonPath(ctx: CanvasRenderingContext2D, pts: number[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0], pts[1]);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
  ctx.closePath();
}

export function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Convert a tile coordinate to its map-space NORTH vertex. */
export function tileMapX(x: number): number {
  // only valid together with tileMapY; provided for readability at call sites
  return x * HALF_W;
}
export const tileMapNX = (x: number, y: number): number => (x - y) * HALF_W;
export const tileMapNY = (x: number, y: number): number => (x + y) * HALF_H;
/** Map-space centre of a tile's flat top face (no elevation). */
export const tileMapCX = (x: number, y: number): number => (x - y) * HALF_W;
export const tileMapCY = (x: number, y: number): number => (x + y) * HALF_H + HALF_H;

/** Linear interpolation of packed colours without per-channel clamps (fast path). */
export function tintColor(c: number, tint: number, t: number): number {
  return mixColor(c, tint, t);
}
