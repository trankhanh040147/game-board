/**
 * FIRST HEARTH — procedural isometric building art
 * ------------------------------------------------
 * Every building is drawn from its `BuildingDef.visual` (wall/roof/accent
 * colours, shape family, height) plus its era, category and condition. The
 * result is baked once into a sprite canvas anchored at the footprint's north
 * lattice point, so drawing a building per frame is one drawImage.
 *
 * Shapes: house, tower, hall, works, farm, mine, well, temple, wall, dock,
 * engine, camp (camp/fire-pit are farm-shaped in content but read as camps).
 */
import type { BuildingDef, SeasonId } from '../sim/types';
import {
  HALF_H,
  HALF_W,
  TILE_H,
  clamp,
  clamp01,
  cssColor,
  cssColorAlpha,
  darkenColor,
  hash2,
  hashInt,
  lightenColor,
  mixColor,
  polygonPath,
  saturateColor,
} from './utils';

export interface BuildingArt {
  lights: number[];
  smoke: number[];
  flag: number[];
}

export interface ArtOptions {
  scale: number;
  condition: number;
  season: SeasonId;
  snow: number;
}

interface Col {
  wall: number;
  wallLit: number;
  wallShade: number;
  roof: number;
  roofLit: number;
  roofShade: number;
  accent: number;
  trim: number;
  stone: number;
  stoneLit: number;
  wood: number;
  woodLit: number;
  dark: number;
  glass: number;
}

function paletteFor(def: BuildingDef, opts: ArtOptions): Col {
  const v = def.visual;
  const wall = mixColorSafe(v.wall, 0x8a7a62);
  let roof = mixColorSafe(v.roof, 0x8a5a3a);
  const accent = mixColorSafe(v.accent ?? '#c9a55b', 0xc9a55b);
  const snow = clamp01(opts.snow);
  const winter = opts.season === 'winter';
  let wallS = mixColor(glaze(wall, winter), 0xe8eef2, snow * 0.22);
  let roofS = mixColor(glaze(roof, winter), 0xe8eef2, snow * 0.5);
  // Roofs and walls often share a similar value in the content pack: push them
  // apart so the silhouette reads at strategy-game zoom.
  const luma = (c: number): number => ((c >>> 16) & 0xff) * 0.299 + ((c >>> 8) & 0xff) * 0.587 + (c & 0xff) * 0.114;
  const diff = luma(roofS) - luma(wallS);
  if (Math.abs(diff) < 26) {
    if (diff >= 0) {
      roofS = darkenColor(roofS, 0.2);
      wallS = lightenColor(wallS, 0.08);
    } else {
      roofS = lightenColor(roofS, 0.12);
      wallS = darkenColor(wallS, 0.06);
    }
  }
  return {
    wall: wallS,
    wallLit: lightenColor(wallS, 0.16),
    wallShade: darkenColor(wallS, 0.2),
    roof: roofS,
    roofLit: lightenColor(roofS, 0.2),
    roofShade: darkenColor(roofS, 0.26),
    accent,
    trim: mixColor(wallS, 0xf0e4c8, 0.5),
    stone: mixColor(0x8d857a, wallS, 0.2),
    stoneLit: mixColor(0xa9a196, wallS, 0.16),
    wood: mixColor(0x6b4a2f, wallS, 0.16),
    woodLit: mixColor(0x8a6440, wallS, 0.15),
    dark: darkenColor(wallS, 0.5),
    glass: mixColor(0x3a3020, 0x9fc4d8, 0.3),
  };
}

function mixColorSafe(hex: string | undefined, fallback: number): number {
  if (!hex) return fallback;
  const t = hex.trim();
  if (!t) return fallback;
  let h = t.startsWith('#') ? t.slice(1) : t;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h.slice(0, 6), 16);
  return Number.isFinite(n) ? n >>> 0 : fallback;
}

function glaze(c: number, winter: boolean): number {
  return winter ? saturateColor(c, 0.82) : c;
}

// ---------------------------------------------------------------------------
// Geometry helpers (all coordinates are map pixels, origin = footprint north
// lattice corner, y grows down; buildings rise toward -y).
// ---------------------------------------------------------------------------

function blockQuad(size: number, inset: number): number[] {
  const l = (lx: number, ly: number): [number, number] => [(lx - ly) * HALF_W, (lx + ly) * HALF_H];
  const [ax, ay] = l(inset, inset);
  const [bx, by] = l(size - inset, inset);
  const [cx, cy] = l(size - inset, size - inset);
  const [dx, dy] = l(inset, size - inset);
  return [ax, ay, bx, by, cx, cy, dx, dy];
}

const qx = (q: number[], i: number): number => q[(i % 4) * 2];
const qy = (q: number[], i: number): number => q[(i % 4) * 2 + 1];

function shift(q: number[], dy: number): number[] {
  const out = new Array<number>(q.length);
  for (let i = 0; i < q.length; i += 2) {
    out[i] = q[i];
    out[i + 1] = q[i + 1] + dy;
  }
  return out;
}

function expand(q: number[], f: number): number[] {
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4;
  const cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  const out = new Array<number>(q.length);
  for (let i = 0; i < q.length; i += 2) {
    out[i] = cx + (q[i] - cx) * f;
    out[i + 1] = cy + (q[i + 1] - cy) * f;
  }
  return out;
}

function mid(a: number, b: number, c: number, d: number): [number, number] {
  return [(a + c) / 2, (b + d) / 2];
}

function poly(ctx: CanvasRenderingContext2D, pts: number[], color: number, alpha = 1): void {
  polygonPath(ctx, pts);
  ctx.fillStyle = alpha >= 1 ? cssColor(color) : cssColorAlpha(color, alpha);
  ctx.fill();
}

function stroke(ctx: CanvasRenderingContext2D, pts: number[], color: number, width: number, alpha = 1): void {
  polygonPath(ctx, pts);
  ctx.strokeStyle = alpha >= 1 ? cssColor(color) : cssColorAlpha(color, alpha);
  ctx.lineWidth = width;
  ctx.stroke();
}

function line2(ctx: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number, color: number, width = 1, alpha = 1): void {
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.strokeStyle = alpha >= 1 ? cssColor(color) : cssColorAlpha(color, alpha);
  ctx.lineWidth = width;
  ctx.stroke();
}

/** Point on a wall: u along the base edge, v up (0 = base, 1 = top). */
function wallPoint(ax: number, ay: number, bx: number, by: number, h: number, u: number, v: number): [number, number] {
  return [ax + (bx - ax) * u, ay + (by - ay) * u - h * v];
}

/** Filled quad patch on a wall (windows, doors, beams). */
function wallPatch(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  h: number,
  u0: number,
  u1: number,
  v0: number,
  v1: number,
  color: number,
  alpha = 1,
): void {
  const p0 = wallPoint(ax, ay, bx, by, h, u0, v0);
  const p1 = wallPoint(ax, ay, bx, by, h, u1, v0);
  const p2 = wallPoint(ax, ay, bx, by, h, u1, v1);
  const p3 = wallPoint(ax, ay, bx, by, h, u0, v1);
  poly(ctx, [p0[0], p0[1], p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]], color, alpha);
}

/** Draw a box with two visible wall faces and a flat top; returns the top quad. */
function drawBox(
  ctx: CanvasRenderingContext2D,
  base: number[],
  h: number,
  col: Col,
  opts: { topColor?: number; wallA?: number; wallB?: number; topAlpha?: number } = {},
): number[] {
  const c1x = qx(base, 1);
  const c1y = qy(base, 1);
  const c2x = qx(base, 2);
  const c2y = qy(base, 2);
  const c3x = qx(base, 3);
  const c3y = qy(base, 3);
  const top = shift(base, -h);
  // +x wall (right, catches the light)
  poly(ctx, [c1x, c1y, c2x, c2y, c2x, c2y - h, c1x, c1y - h], opts.wallA ?? col.wallLit);
  // +y wall (left, in shade)
  poly(ctx, [c2x, c2y, c3x, c3y, c3x, c3y - h, c2x, c2y - h], opts.wallB ?? col.wallShade);
  // top
  poly(ctx, top, opts.topColor ?? col.stone, opts.topAlpha ?? 1);
  return top;
}

/** Gable roof over a top quad. Returns ridge endpoints. */
function drawGableRoof(
  ctx: CanvasRenderingContext2D,
  top: number[],
  roofH: number,
  col: Col,
  opts: { overhang?: number; roofA?: number; roofB?: number; gable?: number; shingle?: boolean } = {},
): { r1: [number, number]; r2: [number, number]; eave: number[]; peakY: number } {
  const eave = expand(top, opts.overhang ?? 1.1);
  const t0: [number, number] = [qx(eave, 0), qy(eave, 0)];
  const t1: [number, number] = [qx(eave, 1), qy(eave, 1)];
  const t2: [number, number] = [qx(eave, 2), qy(eave, 2)];
  const t3: [number, number] = [qx(eave, 3), qy(eave, 3)];
  const gable = opts.gable ?? col.trim;
  // hidden NW gable (drawn first, mostly occluded)
  poly(ctx, [t0[0], t0[1], t3[0], t3[1], t3[0] - 0, t3[1] - roofH * 0.5], col.wallShade);
  const m1 = mid(t3[0], t3[1], t0[0], t0[1]);
  const m2 = mid(t1[0], t1[1], t2[0], t2[1]);
  const r1: [number, number] = [m1[0], m1[1] - roofH];
  const r2: [number, number] = [m2[0], m2[1] - roofH];
  // far slope (faces away, still catching sky)
  poly(ctx, [t0[0], t0[1], t1[0], t1[1], r2[0], r2[1], r1[0], r1[1]], opts.roofA ?? col.roofLit);
  // near-facing gable triangle at the east end
  poly(ctx, [t1[0], t1[1], t2[0], t2[1], r2[0], r2[1]], opts.gable ?? gable);
  // gable timber detail
  if (opts.shingle !== false) {
    line2(ctx, t1[0], t1[1], r2[0], r2[1], darkenColor(gable, 0.25), 1.4, 0.5);
    line2(ctx, t2[0], t2[1], r2[0], r2[1], darkenColor(gable, 0.3), 1.2, 0.4);
  }
  // near slope
  poly(ctx, [t3[0], t3[1], t2[0], t2[1], r2[0], r2[1], r1[0], r1[1]], opts.roofB ?? col.roof);
  // roof silhouette outline (keeps the shape crisp against trees)
  stroke(ctx, [t3[0], t3[1], t2[0], t2[1], r2[0], r2[1], r1[0], r1[1]], darkenColor(col.roof, 0.5), 1.2, 0.45);
  // eave shadow band
  poly(ctx, [t3[0], t3[1], t2[0], t2[1], t2[0] - 0.5, t2[1] - 3.2, t3[0] + 0.5, t3[1] - 3.2], darkenColor(col.roof, 0.5), 0.5);
  // ridge highlight
  line2(ctx, r1[0], r1[1], r2[0], r2[1], lightenColor(col.roof, 0.32), 2, 0.85);
  line2(ctx, r1[0], r1[1], r2[0], r2[1], 0xfff0d0, 0.9, 0.3);
  // shingle / thatch strokes
  if (opts.shingle !== false) {
    const strokes = 5;
    for (let i = 1; i <= strokes; i++) {
      const u = i / (strokes + 1);
      const ax = t3[0] + (t2[0] - t3[0]) * u;
      const ay = t3[1] + (t2[1] - t3[1]) * u;
      const bx = r1[0] + (r2[0] - r1[0]) * u;
      const by = r1[1] + (r2[1] - r1[1]) * u;
      line2(ctx, ax, ay, bx, by, darkenColor(col.roof, 0.34), 1, 0.34);
    }
    // warm light on the near slope
    poly(ctx, [t3[0], t3[1], t2[0], t2[1], r2[0], r2[1], r1[0], r1[1]], 0xffffff, 0.03);
  }
  return { r1, r2, eave, peakY: r2[1] };
}

/** Pyramid / hip roof; returns peak. */
function drawHipRoof(ctx: CanvasRenderingContext2D, top: number[], roofH: number, col: Col, overhang = 1.12): [number, number] {
  const eave = expand(top, overhang);
  const t1: [number, number] = [qx(eave, 1), qy(eave, 1)];
  const t2: [number, number] = [qx(eave, 2), qy(eave, 2)];
  const t3: [number, number] = [qx(eave, 3), qy(eave, 3)];
  const cx = (eave[0] + eave[2] + eave[4] + eave[6]) / 4;
  const cy = (eave[1] + eave[3] + eave[5] + eave[7]) / 4 - roofH;
  poly(ctx, [t1[0], t1[1], t2[0], t2[1], cx, cy], col.roofLit);
  poly(ctx, [t2[0], t2[1], t3[0], t3[1], cx, cy], col.roof);
  line2(ctx, cx, cy, t2[0], t2[1], lightenColor(col.roof, 0.2), 1.2, 0.6);
  return [cx, cy];
}

/** Stone / timber foundation slab that also hides slopes. */
function drawFoundation(ctx: CanvasRenderingContext2D, base: number[], col: Col, depth: number): void {
  const top = shift(base, -4);
  // walls dropping below the ground line (buried on slopes)
  poly(ctx, [qx(base, 1), qy(base, 1), qx(base, 2), qy(base, 2), qx(base, 2), qy(base, 2) + depth, qx(base, 1), qy(base, 1) + depth], darkenColor(col.stone, 0.3));
  poly(ctx, [qx(base, 2), qy(base, 2), qx(base, 3), qy(base, 3), qx(base, 3), qy(base, 3) + depth, qx(base, 2), qy(base, 2) + depth], darkenColor(col.stone, 0.4));
  poly(ctx, top, col.stone);
  stroke(ctx, top, darkenColor(col.stone, 0.25), 1, 0.6);
  // dark base band so buildings sit visually on the ground
  poly(ctx, [qx(base, 1), qy(base, 1), qx(base, 2), qy(base, 2), qx(base, 2), qy(base, 2), qx(base, 1), qy(base, 1)], darkenColor(col.stone, 0.3), 0.6);
}

function drawShadow(ctx: CanvasRenderingContext2D, size: number, alpha = 0.24): void {
  const cx = 0;
  const cy = size * HALF_H;
  ctx.beginPath();
  ctx.ellipse(cx + 5, cy + 3, size * 30 + 4, size * 13 + 3, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x0a0806, alpha);
  ctx.fill();
}

function drawTuft(ctx: CanvasRenderingContext2D, x: number, y: number, col: number, scale = 1): void {
  ctx.strokeStyle = cssColor(col);
  ctx.lineWidth = 1.1;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - 2.5 * scale, y - 3.5 * scale);
  ctx.moveTo(x, y);
  ctx.lineTo(x + 0.5 * scale, y - 4.5 * scale);
  ctx.moveTo(x, y);
  ctx.lineTo(x + 2.8 * scale, y - 3 * scale);
  ctx.stroke();
}

function drawPebble(ctx: CanvasRenderingContext2D, x: number, y: number, col: number, r = 2): void {
  ctx.beginPath();
  ctx.ellipse(x, y, r, r * 0.65, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Windows / doors / details
// ---------------------------------------------------------------------------

interface DetailCtx {
  lights: number[];
  smoke: number[];
  flag: number[];
}

function addWindow(
  ctx: CanvasRenderingContext2D,
  d: DetailCtx,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  h: number,
  u: number,
  v: number,
  w: number,
  hh: number,
  col: Col,
  lit: boolean,
): void {
  const u0 = clamp01(u - w / 2);
  const u1 = clamp01(u + w / 2);
  const v0 = clamp01(v - hh / 2);
  const v1 = clamp01(v + hh / 2);
  wallPatch(ctx, ax, ay, bx, by, h, u0, u1, v0, v1, darkenColor(col.dark, 0.3), 0.9);
  wallPatch(ctx, ax, ay, bx, by, h, u0 + (u1 - u0) * 0.12, u1 - (u1 - u0) * 0.12, v0 + (v1 - v0) * 0.12, v1 - (v1 - v0) * 0.06, col.glass);
  if (lit) {
    const p = wallPoint(ax, ay, bx, by, h, u, v);
    d.lights.push(p[0], p[1]);
  }
  // shutter cross
  wallPatch(ctx, ax, ay, bx, by, h, u0, u1, v1 - (v1 - v0) * 0.35, v1, darkenColor(col.wood, 0.1), 0.85);
}

function drawDoor(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  h: number,
  u: number,
  col: Col,
  width = 0.18,
  height = 0.42,
): void {
  wallPatch(ctx, ax, ay, bx, by, h, u - width / 2 - 0.012, u + width / 2 + 0.012, 0, height + 0.02, darkenColor(col.wood, 0.45));
  wallPatch(ctx, ax, ay, bx, by, h, u - width / 2, u + width / 2, 0, height, col.wood);
  wallPatch(ctx, ax, ay, bx, by, h, u - width / 2, u - width / 2 + width * 0.28, 0, height, col.woodLit);
  // handle
  const hx = u + width / 2 - 0.012;
  const hy = height * 0.52;
  const hp = wallPoint(ax, ay, bx, by, h, hx, hy);
  ctx.beginPath();
  ctx.arc(hp[0], hp[1], 0.9, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.accent);
  ctx.fill();
}

function drawTimberFrame(
  ctx: CanvasRenderingContext2D,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  h: number,
  col: Col,
  posts: number,
  beams: number,
): void {
  for (let i = 0; i <= posts; i++) {
    const u = i / posts;
    wallPatch(ctx, ax, ay, bx, by, h, clamp01(u - 0.014), clamp01(u + 0.014), 0, 1, darkenColor(col.wood, 0.12), 0.75);
  }
  for (let i = 0; i <= beams; i++) {
    const v = i / beams;
    wallPatch(ctx, ax, ay, bx, by, h, 0, 1, clamp01(v - 0.018), clamp01(v + 0.018), darkenColor(col.wood, 0.05), 0.6);
  }
}

function drawCracks(ctx: CanvasRenderingContext2D, ax: number, ay: number, bx: number, by: number, h: number, seed: number, count: number, col: number): void {
  for (let i = 0; i < count; i++) {
    const u = 0.12 + hashInt(seed + i * 37) * 0.7;
    const v = 0.2 + hashInt(seed + i * 91 + 5) * 0.6;
    const p0 = wallPoint(ax, ay, bx, by, h, u, v);
    const p1 = wallPoint(ax, ay, bx, by, h, u + 0.06, v - 0.16);
    const p2 = wallPoint(ax, ay, bx, by, h, u - 0.02, v - 0.3);
    ctx.beginPath();
    ctx.moveTo(p0[0], p0[1]);
    ctx.lineTo(p1[0], p1[1]);
    ctx.lineTo(p2[0], p2[1]);
    ctx.strokeStyle = cssColorAlpha(col, 0.7);
    ctx.lineWidth = 0.9;
    ctx.stroke();
  }
}

// ---------------------------------------------------------------------------
// Shape families
// ---------------------------------------------------------------------------

function drawHouse(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number, seed: number, era: number): void {
  const base = blockQuad(size, size >= 2 ? 0.24 : 0.15);
  drawFoundation(ctx, base, col, 16);
  const top = drawBox(ctx, base, H, col);
  const roofH = clamp(H * 0.54, 11, 26);
  const { r2 } = drawGableRoof(ctx, top, roofH, col, { overhang: 1.12 });

  // walls: right face +x (C1->C2), left face +y (C2->C3)
  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);

  if (era <= 1) {
    drawTimberFrame(ctx, ax, ay, bx, by, H, col, 2, 2);
    drawTimberFrame(ctx, bx, by, cx, cy, H, col, 3, 2);
  } else {
    // stone courses
    for (let i = 1; i < 4; i++) {
      wallPatch(ctx, ax, ay, bx, by, H, 0, 1, (i / 4) * 0.92, (i / 4) * 0.92 + 0.012, darkenColor(col.wall, 0.14), 0.4);
      wallPatch(ctx, bx, by, cx, cy, H, 0, 1, (i / 4) * 0.92, (i / 4) * 0.92 + 0.012, darkenColor(col.wall, 0.2), 0.35);
    }
  }

  // left (+y) wall: door + window
  drawDoor(ctx, bx, by, cx, cy, H, 0.42, col, 0.22, 0.44);
  addWindow(ctx, d, bx, by, cx, cy, H, 0.7, 0.6, 0.14, 0.18, col, true);
  // right (+x) wall: windows
  addWindow(ctx, d, ax, ay, bx, by, H, 0.3, 0.62, 0.15, 0.2, col, true);
  addWindow(ctx, d, ax, ay, bx, by, H, 0.68, 0.62, 0.15, 0.2, col, true);

  // chimney (back of the roof, reads as depth)
  const ccx = qx(top, 0) + 6;
  const ccy = qy(top, 0) - H * 0.1;
  drawChimney(ctx, ccx, ccy, H, roofH, col, d);

  if (def.visual.flag) {
    drawFlagPole(ctx, r2[0] + 2, r2[1], col, d);
  }
  if (def.category === 'housing') {
    // flower box / small bench dressing
    drawTuft(ctx, cx - 8, cy + 4, mixColor(col.roof, 0x6f9a4a, 0.6), 1.1);
    drawPebble(ctx, cx + 6, cy + 7, col.stone, 2.4);
  }
}

function drawChimney(ctx: CanvasRenderingContext2D, x: number, y: number, H: number, roofH: number, col: Col, d: DetailCtx): void {
  const cw = 5;
  const baseY = y - H * 0.55;
  const topY = baseY - 13;
  // body
  poly(ctx, [x - cw, baseY, x + cw * 0.2, baseY + 2.6, x + cw * 0.2, topY, x - cw, topY], col.stone);
  poly(ctx, [x + cw * 0.2, baseY + 2.6, x + cw * 1.5, baseY - 1, x + cw * 1.5, topY + 3, x + cw * 0.2, topY], darkenColor(col.stone, 0.22));
  poly(ctx, [x - cw, topY, x + cw * 0.2, topY, x + cw * 1.5, topY + 3, x + cw * 0.3, topY + 5], darkenColor(col.stone, 0.4));
  // smoke mouth
  d.smoke.push(x + cw * 0.1, topY - 2);
  // soot / warm rim
  ctx.beginPath();
  ctx.ellipse(x + cw * 0.2, topY + 2, cw * 0.9, 2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x1a1410, 0.55);
  ctx.fill();
  void roofH;
}

function drawFlagPole(ctx: CanvasRenderingContext2D, x: number, y: number, col: Col, d: DetailCtx): void {
  line2(ctx, x, y, x, y - 22, darkenColor(col.wood, 0.2), 1.4);
  // little finial
  ctx.beginPath();
  ctx.arc(x, y - 23, 1.6, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.accent);
  ctx.fill();
  d.flag.push(x, y - 22);
}

function drawTower(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number, era: number): void {
  const base = blockQuad(size, size >= 2 ? 0.26 : 0.17);
  drawFoundation(ctx, base, col, 18);
  const hh = H * 1.35;
  const top = drawBox(ctx, base, hh, col);
  const roofH = clamp(hh * 0.45, 12, 26);
  const peak = drawHipRoof(ctx, top, roofH, col, 1.14);

  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);
  // narrow arrow-slit windows
  addWindow(ctx, d, ax, ay, bx, by, hh, 0.5, 0.72, 0.08, 0.14, col, true);
  addWindow(ctx, d, ax, ay, bx, by, hh, 0.5, 0.42, 0.08, 0.14, col, true);
  addWindow(ctx, d, bx, by, cx, cy, hh, 0.5, 0.58, 0.08, 0.14, col, true);
  // crenellation notch shadow under roof
  if (era >= 2) {
    for (let i = 0; i < 3; i++) {
      const u = 0.2 + i * 0.3;
      wallPatch(ctx, ax, ay, bx, by, hh, u, u + 0.1, 0.94, 1, darkenColor(col.stone, 0.18), 0.6);
    }
  }
  // banner
  if (def.visual.flag !== false) drawFlagPole(ctx, peak[0] + 1, peak[1], col, d);
  // door
  drawDoor(ctx, bx, by, cx, cy, hh, 0.5, col, 0.2, 0.26);
  drawPebble(ctx, cx + 12, cy + 6, col.stone, 3);
  void def;
}

function drawHall(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number, seed: number, era: number): void {
  const base = blockQuad(size, size >= 2 ? 0.22 : 0.15);
  drawFoundation(ctx, base, col, 18);
  const top = drawBox(ctx, base, H, col);
  const roofH = clamp(H * 0.44, 12, 24);
  const { r2 } = drawGableRoof(ctx, top, roofH, col, { overhang: 1.16, gable: mixColor(col.trim, col.accent, 0.15) });

  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);
  // columns along the two visible walls
  const cols = size >= 2 ? 4 : 3;
  for (let i = 0; i <= cols; i++) {
    const u = 0.06 + (i / cols) * 0.88;
    wallPatch(ctx, ax, ay, bx, by, H, u - 0.028, u + 0.028, 0, 1, col.trim, 0.95);
    wallPatch(ctx, ax, ay, bx, by, H, u + 0.028, u + 0.05, 0, 1, darkenColor(col.trim, 0.2), 0.5);
  }
  for (let i = 0; i <= cols; i++) {
    const u = 0.08 + (i / cols) * 0.84;
    wallPatch(ctx, bx, by, cx, cy, H, u - 0.028, u + 0.028, 0, 1, darkenColor(col.trim, 0.12), 0.85);
  }
  // tall windows between columns
  for (let i = 0; i < cols; i++) {
    const u = 0.12 + ((i + 0.5) / cols) * 0.8;
    addWindow(ctx, d, bx, by, cx, cy, H, u, 0.56, 0.1, 0.3, col, true);
  }
  // door centred
  drawDoor(ctx, bx, by, cx, cy, H, 0.5, col, 0.16, 0.4);
  // pediment crest
  poly(ctx, [r2[0] - 5, r2[1] + 3, r2[0] + 5, r2[1] + 3, r2[0], r2[1] - 5], col.accent);
  drawFlagPole(ctx, r2[0] + 1, r2[1] - 4, col, d);
  if (era >= 3) {
    // banners flanking the door
    wallPatch(ctx, bx, by, cx, cy, H, 0.28, 0.34, 0.55, 0.92, col.accent, 0.85);
    wallPatch(ctx, bx, by, cx, cy, H, 0.66, 0.72, 0.55, 0.92, col.accent, 0.85);
  }
  void def;
  void seed;
}

function drawWorks(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number, seed: number): void {
  const base = blockQuad(size, size >= 2 ? 0.2 : 0.14);
  drawFoundation(ctx, base, col, 16);
  const hh = H * 0.9;
  const top = drawBox(ctx, base, hh, col, { topColor: darkenColor(col.roof, 0.22) });
  // flat roof with parapet
  const eave = expand(top, 1.1);
  poly(ctx, eave, col.roof);
  stroke(ctx, eave, darkenColor(col.roof, 0.3), 1.2, 0.7);
  // raised vent boxes on the roof
  const vx = qx(eave, 1) * 0.35;
  const vy = qy(eave, 0) - hh - 4;
  drawRoofBox(ctx, vx, vy, 7, 5, 4, col.stone, col.stoneLit);
  drawRoofBox(ctx, vx - 8, vy + 5, 5, 3.6, 3, darkenColor(col.stone, 0.12), col.stoneLit);

  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);
  // big workshop door + small windows
  drawDoor(ctx, bx, by, cx, cy, hh, 0.35, col, 0.3, 0.5);
  addWindow(ctx, d, ax, ay, bx, by, hh, 0.35, 0.66, 0.14, 0.2, col, true);
  addWindow(ctx, d, ax, ay, bx, by, hh, 0.72, 0.66, 0.14, 0.2, col, true);
  // lean-to shed against the right wall
  const shed = blockQuad(size, 0.18);
  void shed;
  // crates / barrels outside
  drawCrates(ctx, qx(base, 1) + 10, qy(base, 1) - 4, col);
  // chimney for smoke defs
  if (def.visual.smoke) {
    drawChimney(ctx, qx(eave, 1) * 0.5 - 6, qy(eave, 0) - hh - 1, hh, 8, col, d);
  }
  if (def.visual.glow) {
    d.lights.push(qx(base, 2) - 2, qy(base, 2) - hh * 0.45);
  }
  if (def.visual.flag) drawFlagPole(ctx, qx(eave, 3) + 6, qy(eave, 3) - hh * 0.2, col, d);
  // ground clutter
  drawPebble(ctx, cx + 10, cy + 8, col.stone, 2.6);
  drawTuft(ctx, cx - 6, cy + 10, mixColor(col.roof, 0x6f9a4a, 0.5), 0.9);
  void seed;
}

function drawRoofBox(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, dpt: number, h: number, col: number, lit: number): void {
  poly(ctx, [x, y, x + w, y + h, x, y + 2 * h, x - w, y + h], col);
  poly(ctx, [x + w, y + h, x, y + 2 * h, x, y + 2 * h + dpt, x + w, y + h + dpt], darkenColor(col, 0.2));
  poly(ctx, [x, y + 2 * h, x - w, y + h, x - w, y + h + dpt, x, y + 2 * h + dpt], darkenColor(col, 0.3));
  poly(ctx, [x, y - h, x + w, y, x, y + h, x - w, y], lit);
}

function drawCrates(ctx: CanvasRenderingContext2D, x: number, y: number, col: Col): void {
  drawRoofBox(ctx, x, y, 5, 6, 2.5, col.wood, col.woodLit);
  drawRoofBox(ctx, x + 8, y + 3, 4, 5, 2, darkenColor(col.wood, 0.1), col.woodLit);
  ctx.beginPath();
  ctx.ellipse(x - 8, y + 2, 3.4, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.woodLit);
  ctx.fill();
  line2(ctx, x - 11, y + 2, x - 5, y + 2, darkenColor(col.wood, 0.25), 0.8);
}

function drawEngine(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base = blockQuad(size, 0.14);
  drawFoundation(ctx, base, col, 20);
  const hh = H * 1.05;
  const top = drawBox(ctx, base, hh, col, { topColor: darkenColor(col.roof, 0.28) });
  // sawtooth roof: three slanted teeth
  const eave = expand(top, 1.08);
  poly(ctx, eave, darkenColor(col.roof, 0.1));
  for (let i = 0; i < 3; i++) {
    const u0 = 0.1 + i * 0.28;
    const u1 = u0 + 0.2;
    const ax = qx(eave, 0) + (qx(eave, 1) - qx(eave, 0)) * u0;
    const ay = qy(eave, 0) + (qy(eave, 1) - qy(eave, 0)) * u0;
    const bx = qx(eave, 0) + (qx(eave, 1) - qx(eave, 0)) * u1;
    const by = qy(eave, 0) + (qy(eave, 1) - qy(eave, 0)) * u1;
    poly(ctx, [ax, ay, bx, by, bx, by - 9, ax, ay - 9], mixColor(col.roof, col.glass, 0.35));
    poly(ctx, [ax, ay - 9, bx, by - 9, bx + 2, by - 7, ax + 2, ay - 7], lightenColor(col.roof, 0.14));
  }
  // two tall chimneys
  drawChimney(ctx, qx(eave, 1) * 0.36, qy(eave, 0) - 2, hh, 10, col, d);
  drawChimney(ctx, qx(eave, 1) * 0.62, qy(eave, 0) + 2, hh, 10, col, d);
  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);
  // industrial windows
  for (let i = 0; i < 3; i++) {
    addWindow(ctx, d, ax, ay, bx, by, hh, 0.2 + i * 0.28, 0.62, 0.13, 0.2, col, true);
  }
  drawDoor(ctx, bx, by, cx, cy, hh, 0.5, col, 0.26, 0.42);
  // pipes / tank
  drawRoofBox(ctx, cx + 12, cy + 2, 4, 10, 3, darkenColor(col.stone, 0.15), col.stoneLit);
  drawFlagPole(ctx, qx(eave, 3) + 8, qy(eave, 3) - 2, col, d);
  void def;
}

function drawWall(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base = blockQuad(size, 0.12);
  drawFoundation(ctx, base, col, 12);
  const hh = clamp(H * 0.55, 12, 26);
  const top = drawBox(ctx, base, hh, col, { topColor: darkenColor(col.stone, 0.05) });
  // stone texture
  for (let i = 1; i < 4; i++) {
    const v = i / 4;
    wallPatch(ctx, qx(base, 1), qy(base, 1), qx(base, 2), qy(base, 2), hh, 0, 1, v - 0.01, v + 0.01, darkenColor(col.stone, 0.2), 0.5);
    wallPatch(ctx, qx(base, 2), qy(base, 2), qx(base, 3), qy(base, 3), hh, 0, 1, v - 0.01, v + 0.01, darkenColor(col.stone, 0.28), 0.45);
  }
  // battlements along both visible top edges
  for (let i = 0; i <= 3; i++) {
    const u = 0.08 + (i / 3) * 0.84;
    const p = wallPoint(qx(top, 1), qy(top, 1), qx(top, 2), qy(top, 2), 0, u, 0);
    drawRoofBox(ctx, p[0], p[1] - 7, 3.4, 3.4, 3, col.stoneLit, lightenColor(col.stone, 0.12));
  }
  for (let i = 0; i <= 3; i++) {
    const u = 0.08 + (i / 3) * 0.84;
    const p = wallPoint(qx(top, 2), qy(top, 2), qx(top, 3), qy(top, 3), 0, u, 0);
    drawRoofBox(ctx, p[0], p[1] - 5, 3.2, 3.2, 3, darkenColor(col.stone, 0.08), col.stoneLit);
  }
  if (def.visual.flag) drawFlagPole(ctx, qx(top, 1) - 2, qy(top, 2) - hh + 2, col, d);
  drawTuft(ctx, qx(base, 3) - 4, qy(base, 3) + 3, mixColor(col.stone, 0x6f9a4a, 0.55), 1);
}

function drawWell(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base = blockQuad(size, 0.2);
  drawFoundation(ctx, base, col, 10);
  const cx = 0;
  const cy = size * HALF_H + 4;
  // stone rim
  ctx.beginPath();
  ctx.ellipse(cx, cy, 20, 10.5, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.stone);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 2.5, 18.5, 9, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.stoneLit);
  ctx.fill();
  // water inside
  ctx.beginPath();
  ctx.ellipse(cx, cy - 2.5, 12, 5.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.accent, 0x123c55, 0.55));
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx - 3, cy - 3.6, 4.5, 1.8, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0xd9f0f6, 0.35);
  ctx.fill();
  // rim stones
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2;
    drawPebble(ctx, cx + Math.cos(a) * 20, cy + Math.sin(a) * 10.5, i % 2 ? col.stoneLit : darkenColor(col.stone, 0.1), 2.6);
  }
  // posts + little roof
  const postH = 20;
  line2(ctx, cx - 15, cy, cx - 15, cy - postH, col.wood, 2.2);
  line2(ctx, cx + 15, cy + 1, cx + 15, cy + 1 - postH, col.wood, 2.2);
  line2(ctx, cx - 15, cy - postH, cx + 15, cy + 1 - postH, col.woodLit, 1.6);
  poly(ctx, [cx - 22, cy - postH, cx, cy - postH - 9, cx + 22, cy - postH + 1, cx, cy - postH + 5], col.roof);
  poly(ctx, [cx - 22, cy - postH, cx, cy - postH + 5, cx, cy - postH + 7, cx - 22, cy - postH + 2], col.roofShade);
  line2(ctx, cx, cy - postH + 2, cx, cy - 4, darkenColor(col.wood, 0.2), 0.9);
  // bucket
  drawRoofBox(ctx, cx, cy - 3, 2.6, 3, 2, col.wood, col.woodLit);
  d.lights.push(cx, cy - postH * 0.6);
  void def;
  void H;
}

function drawTemple(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base1 = blockQuad(size, 0.08);
  drawFoundation(ctx, base1, col, 18);
  const p1 = drawBox(ctx, base1, 6, col, { topColor: col.stoneLit });
  const base2 = blockQuad(size, 0.22);
  const top2 = shift(base2, -6);
  poly(ctx, expand(top2, 1.02), col.stone);
  const H2 = H * 0.78;
  const top = drawBox(ctx, base2, H2 + 6, col, { wallA: lightenColor(col.wallLit, 0.06), wallB: col.wallShade, topColor: col.trim });
  // colonnade on the two visible faces
  const ax = qx(base2, 1);
  const ay = qy(base2, 1);
  const bx = qx(base2, 2);
  const by = qy(base2, 2);
  const cx = qx(base2, 3);
  const cy = qy(base2, 3);
  const cols = size >= 2 ? 5 : 4;
  for (let i = 0; i <= cols; i++) {
    const u = 0.04 + (i / cols) * 0.92;
    wallPatch(ctx, ax, ay, bx, by, H2 + 6, u - 0.024, u + 0.024, 0, 0.94, lightenColor(col.trim, 0.04), 0.95);
    wallPatch(ctx, ax, ay, bx, by, H2 + 6, u + 0.024, u + 0.05, 0, 0.94, darkenColor(col.trim, 0.18), 0.6);
  }
  for (let i = 0; i <= cols; i++) {
    const u = 0.06 + (i / cols) * 0.88;
    wallPatch(ctx, bx, by, cx, cy, H2 + 6, u - 0.024, u + 0.024, 0, 0.94, darkenColor(col.trim, 0.08), 0.9);
  }
  // glowing inner wall
  wallPatch(ctx, bx, by, cx, cy, H2 + 6, 0.36, 0.64, 0.06, 0.66, mixColor(col.accent, 0xffe0a0, 0.3), 0.55);
  const roofH = clamp(H * 0.36, 10, 22);
  const { r2 } = drawGableRoof(ctx, top, roofH, col, { overhang: 1.22, gable: lightenColor(col.trim, 0.05) });
  // gold pediment
  poly(ctx, [qx(top, 1) + 1, qy(top, 1) - H2 * 0.1, qx(top, 2) - 1, qy(top, 2) - H2 * 0.1, r2[0], r2[1] + 2], mixColor(col.accent, 0xf0d9a0, 0.35), 0.85);
  // spire
  const sx = r2[0];
  const sy = r2[1];
  line2(ctx, sx, sy, sx, sy - 16, col.accent, 1.6);
  poly(ctx, [sx - 3.4, sy - 16, sx, sy - 24, sx + 3.4, sy - 16], lightenColor(col.accent, 0.18));
  ctx.beginPath();
  ctx.arc(sx, sy - 24, 1.8, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(0xfff0c0);
  ctx.fill();
  d.lights.push(sx, sy - 12);
  d.flag.push(sx, sy - 16);
  void p1;
  void def;
}

function drawDock(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base = blockQuad(size, 0.1);
  // water shadow beneath
  ctx.beginPath();
  ctx.ellipse(0, size * HALF_H, size * 32, size * 16, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x123c55, 0.35);
  ctx.fill();
  // posts
  for (const [px, py] of [
    [qx(base, 0), qy(base, 0)],
    [qx(base, 1), qy(base, 1)],
    [qx(base, 2), qy(base, 2)],
    [qx(base, 3), qy(base, 3)],
  ]) {
    line2(ctx, px, py - 2, px, py + 10, darkenColor(col.wood, 0.35), 2.4);
  }
  // platform
  const plat = expand(base, 0.98);
  poly(ctx, plat, col.wood);
  stroke(ctx, plat, darkenColor(col.wood, 0.3), 1.2, 0.8);
  // plank lines
  for (let i = 1; i < 6; i++) {
    const u = i / 6;
    const p = wallPoint(qx(plat, 3), qy(plat, 3), qx(plat, 2), qy(plat, 2), 0, u, 0);
    const q = wallPoint(qx(plat, 0), qy(plat, 0), qx(plat, 1), qy(plat, 1), 0, u, 0);
    line2(ctx, p[0], p[1], q[0], q[1], darkenColor(col.wood, 0.22), 0.8, 0.6);
  }
  // small warehouse on the platform
  const shed = blockQuad(size, 0.42);
  const sh = H * 0.62;
  const stop = drawBox(ctx, shed, sh, { ...col, wall: col.woodLit, wallLit: lightenColor(col.woodLit, 0.1), wallShade: darkenColor(col.wood, 0.05) });
  drawGableRoof(ctx, stop, clamp(sh * 0.56, 8, 16), col, { overhang: 1.12 });
  drawCrates(ctx, qx(shed, 1) + 4, qy(shed, 1) + 6, col);
  // boat alongside
  const bx2 = -size * 24;
  const by2 = size * HALF_H + 6;
  ctx.beginPath();
  ctx.moveTo(bx2 - 16, by2);
  ctx.quadraticCurveTo(bx2, by2 + 9, bx2 + 16, by2);
  ctx.quadraticCurveTo(bx2, by2 - 3, bx2 - 16, by2);
  ctx.fillStyle = cssColor(darkenColor(col.wood, 0.05));
  ctx.fill();
  line2(ctx, bx2, by2 - 1, bx2, by2 - 18, col.wood, 1.3);
  poly(ctx, [bx2, by2 - 18, bx2 + 9, by2 - 12, bx2, by2 - 6], mixColor(col.trim, 0xf0e4c8, 0.3));
  d.lights.push(qx(shed, 2), qy(shed, 2) - sh * 0.5);
  d.smoke.push(qx(shed, 1) + 8, qy(shed, 0) - sh - 8);
  void def;
}

function drawMine(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  const base = blockQuad(size, 0.12);
  drawFoundation(ctx, base, col, 12);
  const cx = 0;
  const cy = size * HALF_H + 4;
  // spoil heap / mound
  ctx.beginPath();
  ctx.ellipse(cx, cy - 2, size * 26, size * 13, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.stone, 0x5a4a3a, 0.3));
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 6, size * 20, size * 9, 0, Math.PI, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.stoneLit, 0x6b5a44, 0.25));
  ctx.fill();
  // entrance adit
  const ex = cx;
  const ey = cy - 2;
  const w = 16;
  const hh = clamp(H * 0.7, 16, 30);
  ctx.beginPath();
  ctx.moveTo(ex - w, ey);
  ctx.lineTo(ex - w, ey - hh * 0.55);
  ctx.quadraticCurveTo(ex, ey - hh * 1.1, ex + w, ey - hh * 0.55);
  ctx.lineTo(ex + w, ey);
  ctx.closePath();
  ctx.fillStyle = cssColor(0x14100c);
  ctx.fill();
  // timber portal
  line2(ctx, ex - w - 1, ey, ex - w - 1, ey - hh * 0.5, col.woodLit, 2.6);
  line2(ctx, ex + w + 1, ey, ex + w + 1, ey - hh * 0.5, col.wood, 2.6);
  line2(ctx, ex - w - 3, ey - hh * 0.52, ex + w + 3, ey - hh * 0.52, col.woodLit, 2.4);
  line2(ctx, ex, ey - hh * 0.52, ex, ey - hh * 0.92, col.wood, 1.6);
  // rails
  line2(ctx, ex - 7, ey + 1, ex - 26, ey + 12, darkenColor(col.wood, 0.2), 1.2);
  line2(ctx, ex + 7, ey + 1, ex + 26, ey + 12, darkenColor(col.wood, 0.2), 1.2);
  // ore cart
  drawRoofBox(ctx, ex + 24, ey + 10, 5, 6, 2.6, col.stone, col.stoneLit);
  ctx.beginPath();
  ctx.arc(ex + 20, ey + 14, 2, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.wood);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex + 29, ey + 15, 2, 0, Math.PI * 2);
  ctx.fill();
  // glowing ore
  const glint = mixColor(mixColorSafe(def.visual.accent, 0xc9b98a), 0xd9b04a, 0.5);
  drawPebble(ctx, ex - 18, ey + 6, glint, 2.2);
  drawPebble(ctx, ex + 12, ey - 5, glint, 1.8);
  drawPebble(ctx, ex - 9, ey - 9, mixColor(glint, 0xffffff, 0.3), 1.6);
  d.lights.push(ex, ey - hh * 0.35);
  if (def.visual.smoke) d.smoke.push(cx + 10, cy - hh - 4);
}

function drawCampfire(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number): void {
  const cx = 0;
  const cy = size * HALF_H + 4;
  // trampled ground
  ctx.beginPath();
  ctx.ellipse(cx, cy, size * 22, size * 10, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0x4a3a28, 0.38);
  ctx.fill();
  // stone ring
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    drawPebble(ctx, cx + Math.cos(a) * 13, cy + Math.sin(a) * 6.5, i % 2 ? col.stoneLit : col.stone, 2.4);
  }
  // logs
  line2(ctx, cx - 9, cy + 1, cx + 8, cy - 3, col.wood, 2.6);
  line2(ctx, cx - 7, cy - 3, cx + 8, cy + 2, col.woodLit, 2.4);
  // embers + flame glow
  ctx.beginPath();
  ctx.ellipse(cx, cy - 1, 6.5, 3.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0xe0832f, 0.85);
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(cx, cy - 3, 3.8, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0xffd07a, 0.9);
  ctx.fill();
  // little tripod
  line2(ctx, cx - 10, cy + 2, cx - 4, cy - 13, col.wood, 1.2);
  line2(ctx, cx + 10, cy + 2, cx + 4, cy - 13, col.wood, 1.2);
  line2(ctx, cx - 4, cy - 13, cx + 4, cy - 13, col.woodLit, 1.2);
  line2(ctx, cx, cy - 13, cx, cy - 9, darkenColor(col.wood, 0.2), 0.8);
  ctx.beginPath();
  ctx.arc(cx, cy - 8, 2.2, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(darkenColor(col.stone, 0.3));
  ctx.fill();
  d.lights.push(cx, cy - 2);
  d.lights.push(cx - 3, cy - 5);
  d.smoke.push(cx, cy - 14);
  // fire ring stones outside
  drawPebble(ctx, cx + 20, cy + 6, col.stone, 2);
  drawTuft(ctx, cx - 19, cy + 7, mixColor(col.roof, 0x6f9a4a, 0.6), 1);
  void def;
}

function drawCamp(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number, H: number): void {
  drawShadow(ctx, size, 0.18);
  const cx = 0;
  const cy = size * HALF_H + 2;
  // two tents / lean-to
  const tents = size >= 2 ? 2 : 1;
  for (let i = 0; i < tents; i++) {
    const tx = cx - 14 + i * 26;
    const ty = cy - 4 + i * 5;
    const tw = 11;
    poly(ctx, [tx - tw, ty, tx, ty - 14 - H * 0.12, tx + tw, ty], mixColor(col.trim, col.roof, 0.3));
    poly(ctx, [tx, ty - 14 - H * 0.12, tx + tw, ty, tx + tw, ty + 2, tx, ty - 11], darkenColor(col.roof, 0.15));
    line2(ctx, tx, ty - 14 - H * 0.12, tx, ty, darkenColor(col.wood, 0.2), 1.2);
    // entrance
    poly(ctx, [tx - 3, ty - 1, tx, ty - 6, tx + 3, ty - 1], 0x241c14, 0.9);
  }
  // d drying rack
  line2(ctx, cx + 20, cy + 4, cx + 20, cy - 12, col.wood, 1.4);
  line2(ctx, cx + 30, cy + 5, cx + 30, cy - 10, col.wood, 1.4);
  line2(ctx, cx + 18, cy - 10, cx + 32, cy - 8, col.woodLit, 1.1);
  for (let i = 0; i < 3; i++) {
    const x = cx + 20 + i * 4;
    poly(ctx, [x, cy - 9, x + 2.6, cy - 9, x + 2.2, cy - 3, x + 0.4, cy - 3], mixColor(col.accent, 0x9e5a3a, 0.5), 0.85);
  }
  // basket / log pile
  ctx.beginPath();
  ctx.ellipse(cx - 26, cy + 6, 3.6, 2.2, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(col.woodLit);
  ctx.fill();
  drawRoofBox(ctx, cx + 8, cy + 9, 4, 5, 2, col.wood, col.woodLit);
  drawTuft(ctx, cx - 6, cy + 9, mixColor(col.roof, 0x7fae5a, 0.5), 1);
  if (def.visual.smoke || def.visual.glow) d.smoke.push(cx, cy - 10);
  d.lights.push(cx, cy - 3);
}

// -- farm / fields ----------------------------------------------------------

function drawField(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number): void {
  const base = blockQuad(size, 0.08);
  const inner = expand(base, 1.0);
  const cx = 0;
  const cy = size * HALF_H;
  // tilled earth body
  poly(ctx, expand(base, 0.98), mixColor(0x6b5638, col.wall, 0.22));
  // rows along the x axis
  const rows = size >= 2 ? 7 : 5;
  const rowCol = mixColor(0x8a6a3a, col.roof, 0.35);
  for (let i = 1; i <= rows; i++) {
    const u = i / (rows + 1);
    const p0 = [qx(inner, 3) + (qx(inner, 2) - qx(inner, 3)) * u, qy(inner, 3) + (qy(inner, 2) - qy(inner, 3)) * u];
    const p1 = [qx(inner, 0) + (qx(inner, 1) - qx(inner, 0)) * u, qy(inner, 0) + (qy(inner, 1) - qy(inner, 0)) * u];
    line2(ctx, p0[0], p0[1], p1[0], p1[1], darkenColor(rowCol, 0.18), 1.4, 0.75);
    line2(ctx, p0[0], p0[1] - 1.2, p1[0], p1[1] - 1.2, lightenColor(rowCol, 0.16), 1, 0.5);
  }
  // furrow lines across
  for (let i = 1; i < 3; i++) {
    const u = i / 3;
    const p0 = [qx(inner, 1) + (qx(inner, 2) - qx(inner, 1)) * u, qy(inner, 1) + (qy(inner, 2) - qy(inner, 1)) * u];
    const p1 = [qx(inner, 0) + (qx(inner, 3) - qx(inner, 0)) * u, qy(inner, 0) + (qy(inner, 3) - qy(inner, 0)) * u];
    line2(ctx, p0[0], p0[1], p1[0], p1[1], darkenColor(rowCol, 0.3), 1, 0.4);
  }
  // boundary ditch / ridge
  stroke(ctx, expand(base, 0.98), darkenColor(rowCol, 0.35), 1.4, 0.6);
  // fence posts around the two near edges
  const posts = 4;
  for (let i = 0; i <= posts; i++) {
    const u = i / posts;
    const p = wallPoint(qx(base, 1), qy(base, 1), qx(base, 2), qy(base, 2), 0, u, 0);
    line2(ctx, p[0], p[1], p[0], p[1] - 6.5, col.wood, 1.3);
    const p2 = wallPoint(qx(base, 2), qy(base, 2), qx(base, 3), qy(base, 3), 0, u, 0);
    line2(ctx, p2[0], p2[1], p2[0], p2[1] - 6.5, col.wood, 1.3);
  }
  line2(ctx, qx(base, 1), qy(base, 1) - 5, qx(base, 2), qy(base, 2) - 5, col.woodLit, 1, 0.85);
  line2(ctx, qx(base, 2), qy(base, 2) - 5, qx(base, 3), qy(base, 3) - 5, col.woodLit, 1, 0.85);
  // scarecrow
  if (def.category === 'food') {
    const sx = cx + 13;
    const sy = cy + 6;
    line2(ctx, sx, sy, sx, sy - 12, col.wood, 1.4);
    line2(ctx, sx - 5, sy - 9, sx + 5, sy - 9, col.wood, 1.2);
    ctx.beginPath();
    ctx.arc(sx, sy - 13, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(mixColor(col.accent, 0xd9c8a0, 0.4));
    ctx.fill();
  }
  // a haystack in the corner
  ctx.beginPath();
  ctx.ellipse(cx - 14, cy + 7, 6, 4.6, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.roof, 0xc9a55b, 0.4));
  ctx.fill();
  line2(ctx, cx - 20, cy + 8, cx - 8, cy + 8, darkenColor(col.roof, 0.25), 1, 0.5);
}

function drawOrchard(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number): void {
  const base = blockQuad(size, 0.06);
  poly(ctx, expand(base, 0.98), mixColor(0x6b5638, col.wall, 0.3));
  stroke(ctx, expand(base, 0.98), darkenColor(col.wall, 0.3), 1.2, 0.5);
  // rows of small trees
  const spots = size >= 2
    ? [
        [-18, -4],
        [0, 2],
        [18, 8],
        [-8, 14],
        [10, 18],
      ]
    : [
        [-8, 2],
        [7, 8],
      ];
  for (const [sx, sy] of spots) {
    drawMiniTree(ctx, sx, sy + size * HALF_H, col, def.visual.accent);
  }
  // beehives
  for (let i = 0; i < 2; i++) {
    const hx = 20 - i * 6;
    const hy = size * HALF_H - 6 + i * 8;
    poly(ctx, [hx - 3, hy, hx + 3, hy, hx + 3, hy - 5, hx, hy - 7, hx - 3, hy - 5], mixColor(col.roof, 0xd8c58a, 0.5));
  }
  d.lights.push(0, size * HALF_H - 6);
  void def;
}

function drawMiniTree(ctx: CanvasRenderingContext2D, x: number, y: number, col: Col, accent: string | undefined): void {
  line2(ctx, x, y, x, y - 10, col.wood, 1.8);
  ctx.beginPath();
  ctx.ellipse(x, y - 14, 8, 7, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.roof, 0x4f7f38, 0.55));
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x - 2.5, y - 16, 4.6, 4, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColor(mixColor(col.roof, 0x7fae5a, 0.55));
  ctx.fill();
  // fruit
  const fruit = mixColorSafe(accent ?? '#9e2b4e', 0xc0392b);
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(x - 4 + i * 4, y - 13 + (i % 2) * 3, 1.1, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(fruit);
    ctx.fill();
  }
}

function drawGarden(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, d: DetailCtx, size: number): void {
  const base = blockQuad(size, 0.05);
  // grass and beds
  poly(ctx, expand(base, 0.98), mixColor(0x6f8f4a, col.wall, 0.45));
  // pathways
  const cx = 0;
  const cy = size * HALF_H;
  line2(ctx, cx - 22, cy + 11, cx + 22, cy - 11, mixColor(0x9a8a6a, 0xa9a08a, 0.4), 3.4, 0.85);
  // flower beds (four colour blocks)
  const bedCols = [0xc9697a, 0xd9a84e, 0x8a6fb0, 0xe8d9be];
  const beds: [number, number, number, number][] = [
    [-15, 2, 5, 3],
    [-2, 6, 5, 3],
    [10, 9, 5, 3],
    [-9, -1, 4.5, 3],
  ];
  for (let i = 0; i < beds.length; i++) {
    const [bx, by, bw, bh] = beds[i];
    ctx.beginPath();
    ctx.ellipse(bx, by + size * HALF_H * 0.4, bw, bh, 0, 0, Math.PI * 2);
    ctx.fillStyle = cssColor(mixColor(0x5a4a2a, bedCols[i], 0.55));
    ctx.fill();
    for (let k = 0; k < 5; k++) {
      const a = hash2(i * 5 + k, 7, 33);
      const r = hash2(i * 3 + k, 11, 47);
      ctx.beginPath();
      ctx.arc(bx + (a - 0.5) * bw * 1.3, by + size * HALF_H * 0.4 + (r - 0.5) * bh * 1.2, 1.1, 0, Math.PI * 2);
      ctx.fillStyle = cssColor(lightenColor(bedCols[(i + k) % 4], 0.25));
      ctx.fill();
    }
  }
  // pear tree + bench
  drawMiniTree(ctx, -14, size * HALF_H - 4, col, '#7fae5a');
  line2(ctx, 16, size * HALF_H + 12, 22, size * HALF_H + 12, col.wood, 1.6);
  d.lights.push(0, size * HALF_H - 4);
  void def;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Sprite rectangle (map-space) needed to bake a building, anchored at the
 * footprint's north lattice corner on its elevation plane.
 */
export function buildingSpriteRect(def: BuildingDef): { x0: number; y0: number; mapW: number; mapH: number } {
  const size = def.size ?? 1;
  const v = def.visual ?? ({} as BuildingDef['visual']);
  const H = 14 + (v.height ?? 1) * 28;
  const shape = v.shape ?? 'house';
  const topExtra = shape === 'temple' || shape === 'engine' ? 54 : shape === 'tower' ? 48 : 40;
  const x0 = -size * HALF_W - 12;
  const y0 = -H - topExtra - size * 8;
  const mapW = size * HALF_W * 2 + 24;
  const mapH = -y0 + size * TILE_H + 14;
  return { x0, y0, mapW, mapH };
}

/**
 * Bake one building sprite. `ctx` must be pre-transformed so that the footprint's
 * north lattice corner is the origin and 1 unit == 1 map pixel * scale.
 * Returns the artwork metadata plus the sprite rectangle in map space.
 */
export function drawBuildingArt(
  ctx: CanvasRenderingContext2D,
  def: BuildingDef,
  opts: ArtOptions,
): { art: BuildingArt; rect: { x0: number; y0: number; mapW: number; mapH: number } } {
  const size = def.size ?? 1;
  const v = def.visual ?? ({} as BuildingDef['visual']);
  const col = paletteFor(def, opts);
  const H = 14 + (v.height ?? 1) * 28;
  const era = def.era ?? 0;
  const seed = hashInt(hashStringSeed(def.id));
  const d: DetailCtx = { lights: [], smoke: [], flag: [] };

  const shape = v.shape ?? 'house';
  const isCampLike = def.id === 'fire_pit' || (shape === 'farm' && (def.tags?.includes('gather') ?? false));
  const isField = shape === 'farm' && !isCampLike && def.id !== 'orchard' && def.id !== 'garden';

  drawShadow(ctx, size, 0.28);
  switch (shape) {
    case 'house':
      drawHouse(ctx, def, col, d, size, H, seed, era);
      break;
    case 'tower':
      drawTower(ctx, def, col, d, size, H, era);
      break;
    case 'hall':
      drawHall(ctx, def, col, d, size, H, seed, era);
      break;
    case 'works':
      drawWorks(ctx, def, col, d, size, H, seed);
      break;
    case 'engine':
      drawEngine(ctx, def, col, d, size, H);
      break;
    case 'well':
      drawWell(ctx, def, col, d, size, H);
      break;
    case 'temple':
      drawTemple(ctx, def, col, d, size, H);
      break;
    case 'dock':
      drawDock(ctx, def, col, d, size, H);
      break;
    case 'mine':
      drawMine(ctx, def, col, d, size, H);
      break;
    case 'wall':
      drawWall(ctx, def, col, d, size, H);
      break;
    case 'farm':
    default:
      if (def.id === 'fire_pit') drawCampfire(ctx, def, col, d, size);
      else if (def.id === 'orchard') drawOrchard(ctx, def, col, d, size);
      else if (def.id === 'garden') drawGarden(ctx, def, col, d, size);
      else if (isField) drawField(ctx, def, col, d, size);
      else drawCamp(ctx, def, col, d, size, H);
      break;
  }

  // condition damage
  if (opts.condition < 0.62) {
    const wear = 1 - clamp01(opts.condition / 0.62);
    damageOverlay(ctx, def, col, size, H, seed, wear);
  }

  return { art: d, rect: buildingSpriteRect(def) };
}

function damageOverlay(ctx: CanvasRenderingContext2D, def: BuildingDef, col: Col, size: number, H: number, seed: number, wear: number): void {
  const base = blockQuad(size, size >= 2 ? 0.26 : 0.2);
  const ax = qx(base, 1);
  const ay = qy(base, 1);
  const bx = qx(base, 2);
  const by = qy(base, 2);
  const cx = qx(base, 3);
  const cy = qy(base, 3);
  const hh = H * 0.85;
  drawCracks(ctx, ax, ay, bx, by, hh, seed + 7, Math.round(2 + wear * 3), 0x241c14);
  drawCracks(ctx, bx, by, cx, cy, hh, seed + 31, Math.round(1 + wear * 3), 0x241c14);
  if (wear > 0.5) {
    // gaping roof hole / missing wall patch
    const hol = blockQuad(size, 0.34);
    poly(ctx, hol, 0x1c1610, 0.55);
    poly(ctx, [qx(hol, 1), qy(hol, 1) - hh * 0.4, qx(hol, 2), qy(hol, 2) - hh * 0.2, qx(hol, 2) - 4, qy(hol, 2) - hh * 0.1, qx(hol, 1) - 3, qy(hol, 1) - hh * 0.3], 0x2a2018, 0.7);
  }
  // rubble at the base
  for (let i = 0; i < 5; i++) {
    const a = hash2(i * 3, seed, 77);
    const b = hash2(i * 7, seed, 91);
    drawPebble(ctx, (a - 0.5) * size * 42, size * HALF_H + 4 + b * 10, mixColor(col.stone, col.wood, 0.3), 2 + wear * 3);
  }
  void def;
}

function hashStringSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * Scaffolding overlay for buildings under construction. Drawn per frame by the
 * renderer (cheap lines), not baked.
 */
export function drawScaffold(
  ctx: CanvasRenderingContext2D,
  size: number,
  height: number,
  progress: number,
  wood: number = 0x8a6440,
  rope: number = 0xc9b98a,
): void {
  const p = clamp01(progress);
  const base = blockQuad(size, size >= 2 ? 0.24 : 0.18);
  const hh = Math.max(10, height * 0.7) * clamp(0.45 + p * 0.8, 0.45, 1.15);
  const corners: [number, number][] = [
    [qx(base, 0), qy(base, 0)],
    [qx(base, 1), qy(base, 1)],
    [qx(base, 2), qy(base, 2)],
    [qx(base, 3), qy(base, 3)],
  ];
  for (const [x, y] of corners) {
    line2(ctx, x, y, x, y - hh, darkenColor(wood, 0.15), 1.5, 0.9);
  }
  // horizontal braces on the two visible faces
  const levels = 3;
  for (let i = 1; i <= levels; i++) {
    const v = i / (levels + 1);
    for (let k = 0; k < 4; k++) {
      const [x1, y1] = corners[k];
      const [x2, y2] = corners[(k + 1) % 4];
      line2(ctx, x1 + (x2 - x1) * 0.04, y1 + (y2 - y1) * 0.04 - hh * v, x1 + (x2 - x1) * 0.96, y1 + (y2 - y1) * 0.96 - hh * v, wood, 1.1, 0.75);
    }
  }
  // diagonal braces on the visible walls
  for (let i = 0; i < 3; i++) {
    const [x1, y1] = corners[i];
    const [x2, y2] = corners[i + 1];
    line2(ctx, x1, y1, x2, y2 - hh, rope, 0.9, 0.55);
  }
  // dangling rope + plank
  line2(ctx, qx(base, 1) - 4, qy(base, 1) - hh * 0.8, qx(base, 1) + 6, qy(base, 1) - hh * 0.8 - 3, rope, 0.9, 0.5);
  // progress fill glow at the base
  ctx.beginPath();
  ctx.ellipse(0, size * HALF_H, size * 26 * p, size * 12 * p, 0, 0, Math.PI * 2);
  ctx.fillStyle = cssColorAlpha(0xe6c47e, 0.13);
  ctx.fill();
}
