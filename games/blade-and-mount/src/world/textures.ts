import * as THREE from 'three';
import { clamp, hexCss, lerp, mulberry32 } from '../core/utils';
import { TEAM_PALETTE } from '../core/config';

/**
 * Canvas-generated textures for the arena. No external assets, fully
 * deterministic (seeded). Colour maps live in sRGB; normal/roughness maps are
 * linear. Each texture is sized by the quality preset.
 */

export interface SurfaceTexture {
  map: THREE.CanvasTexture;
  normalMap?: THREE.CanvasTexture;
  roughnessMap?: THREE.CanvasTexture;
}

export interface ArenaTextureBank {
  sand: SurfaceTexture;
  outer: SurfaceTexture;
  stone: SurfaceTexture;
  wood: SurfaceTexture;
  shingle: SurfaceTexture;
  plaster: SurfaceTexture;
  metal: SurfaceTexture;
  hay: SurfaceTexture;
  rock: SurfaceTexture;
  banners: THREE.CanvasTexture[];
  pennant: THREE.CanvasTexture;
  blood: THREE.CanvasTexture;
  dust: THREE.CanvasTexture;
  flame: THREE.CanvasTexture;
  blob: THREE.CanvasTexture;
  aoStrip: THREE.CanvasTexture;
  tuft: THREE.CanvasTexture;
  dispose(): void;
}

export const TILE = {
  stone: 5,
  wood: 2.2,
  shingle: 3.2,
  plaster: 2.2,
  metal: 1.2,
  hay: 1.2,
} as const;

type Ctx = CanvasRenderingContext2D;
type Rng = () => number;

function canvasOf(w: number, h: number): { canvas: HTMLCanvasElement; ctx: Ctx } {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  return { canvas, ctx };
}

function textureFrom(canvas: HTMLCanvasElement, srgb: boolean, aniso: number, repeat = false): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.wrapS = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  tex.anisotropy = aniso;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */
/* Small noise utilities                                               */
/* ------------------------------------------------------------------ */

function valueNoiseLayer(rng: Rng, grid: number): Float32Array {
  const g = new Float32Array((grid + 1) * (grid + 1));
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function sampleNoise(g: Float32Array, grid: number, x: number, y: number): number {
  const fx = x * grid;
  const fy = y * grid;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const w = grid + 1;
  const x1 = (x0 + 1) % grid;
  const y1 = (y0 + 1) % grid;
  const a = g[y0 * w + (x0 % grid)];
  const b = g[y0 * w + x1];
  const c = g[y1 * w + (x0 % grid)];
  const d = g[y1 * w + x1];
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sy);
}

/** Tileable fractal noise in [0,1]. */
function fbmField(rng: Rng, size: number, octaves: number): Float32Array {
  const out = new Float32Array(size * size);
  let amp = 0.5;
  let total = 0;
  let grid = 4;
  for (let o = 0; o < octaves; o++) {
    const layer = valueNoiseLayer(rng, grid);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        out[y * size + x] += sampleNoise(layer, grid, x / size, y / size) * amp;
      }
    }
    total += amp;
    amp *= 0.55;
    grid = Math.min(256, grid * 2);
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

function normalFromHeights(size: number, heights: Float32Array, strength: number): THREE.CanvasTexture {
  const { canvas, ctx } = canvasOf(size, size);
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size;
    const yp = ((y + 1) % size) * size;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size;
      const xp = (x + 1) % size;
      const hl = heights[row + xm];
      const hr = heights[row + xp];
      const hu = heights[ym + x];
      const hd = heights[yp + x];
      let nx = (hl - hr) * strength;
      let ny = (hd - hu) * strength;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      const i = (row + x) * 4;
      d[i] = (nx * 0.5 + 0.5) * 255;
      d[i + 1] = (ny * 0.5 + 0.5) * 255;
      d[i + 2] = (nz / len) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return textureFrom(canvas, false, 1, true);
}

function normalFromCanvas(src: HTMLCanvasElement, strength: number): THREE.CanvasTexture {
  const w = src.width;
  const h = src.height;
  const ctx = src.getContext('2d');
  if (!ctx) throw new Error('no ctx');
  const data = ctx.getImageData(0, 0, w, h).data;
  const heights = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) heights[i] = data[i * 4] / 255;
  return normalFromHeights(w, heights, strength);
}

function grain(ctx: Ctx, rng: Rng, w: number, h: number, count: number, alpha: number, palette: string[]): void {
  for (let i = 0; i < count; i++) {
    const x = rng() * w;
    const y = rng() * h;
    const s = 0.5 + rng() * 1.8;
    ctx.globalAlpha = alpha * (0.35 + rng() * 0.65);
    ctx.fillStyle = palette[Math.floor(rng() * palette.length)];
    ctx.fillRect(x, y, s, s);
  }
  ctx.globalAlpha = 1;
}

/** Split `total` into block widths that sum exactly to it (seamless rows). */
function blockWidths(rng: Rng, total: number, min: number, max: number, step: number): number[] {
  const widths: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    let w = Math.round((min + rng() * (max - min)) / step) * step;
    if (remaining - w < min) w = remaining;
    if (w > remaining) w = remaining;
    widths.push(w);
    remaining -= w;
  }
  return widths;
}

/* ------------------------------------------------------------------ */
/* Sand floor                                                          */
/* ------------------------------------------------------------------ */

function createSand(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  const s = size / 2048;

  ctx.fillStyle = '#b99e6e';
  ctx.fillRect(0, 0, size, size);

  // Broad, low-contrast tonal variation.
  const tones = ['#d8c094', '#bda175', '#d0b98b', '#b0966c', '#dfc99c', '#c4a97c', '#a98f66', '#cbb283'];
  for (let i = 0; i < 620; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (70 + rng() * 480) * s;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.02 + rng() * 0.042;
    g.addColorStop(0, tones[Math.floor(rng() * tones.length)]);
    g.addColorStop(1, 'rgba(203,178,134,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;

  // Sun-bleached, scuffed centre where the melee happens.
  const centre = ctx.createRadialGradient(size * 0.5, size * 0.52, 0, size * 0.5, size * 0.52, size * 0.38);
  centre.addColorStop(0, 'rgba(228,211,173,0.12)');
  centre.addColorStop(0.6, 'rgba(220,201,161,0.06)');
  centre.addColorStop(1, 'rgba(203,178,134,0)');
  ctx.fillStyle = centre;
  ctx.fillRect(0, 0, size, size);

  // Worn approach paths from the four gates, softly brushed in.
  const path = (x0: number, y0: number, x1: number, y1: number, width: number, alpha: number): void => {
    ctx.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      ctx.strokeStyle = `rgba(206,185,146,${alpha})`;
      ctx.lineWidth = width * (0.6 + rng() * 0.8);
      ctx.beginPath();
      ctx.moveTo(x0 + (rng() - 0.5) * width * 0.8, y0);
      ctx.quadraticCurveTo((x0 + x1) / 2 + (rng() - 0.5) * width, (y0 + y1) / 2, x1 + (rng() - 0.5) * width * 0.6, y1);
      ctx.stroke();
    }
  };
  path(size * 0.5, size * 0.02, size * 0.5, size * 0.5, size * 0.1, 0.05);
  path(size * 0.5, size * 0.98, size * 0.5, size * 0.5, size * 0.08, 0.045);
  path(size * 0.01, size * 0.5, size * 0.5, size * 0.5, size * 0.08, 0.04);
  path(size * 0.99, size * 0.5, size * 0.5, size * 0.5, size * 0.08, 0.04);

  // Faint old cart ruts, mostly near the gate.
  for (let i = 0; i < 8; i++) {
    const off = (rng() - 0.5) * size * 0.09;
    ctx.strokeStyle = rng() > 0.5 ? 'rgba(148,126,94,0.055)' : 'rgba(224,206,168,0.06)';
    ctx.lineWidth = (2 + rng() * 5) * s;
    ctx.beginPath();
    ctx.moveTo(size * 0.5 + off, size * 0.05);
    ctx.bezierCurveTo(size * 0.5 + off, size * 0.18, size * 0.5 + off * 3.2, size * 0.3, size * 0.5 + off * 4.6, size * 0.44);
    ctx.stroke();
  }

  // Pebbles with contact shadows.
  for (let i = 0; i < 1800; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (0.9 + rng() * 3.6) * s;
    ctx.globalAlpha = 0.13 + rng() * 0.24;
    ctx.fillStyle = 'rgba(92,79,58,0.5)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.55, y + r * 0.5, r * 1.15, r * 0.75, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.2 + rng() * 0.4;
    ctx.fillStyle = ['#ab966e', '#bba67d', '#917f5d', '#cdb88f', '#c3ae85'][Math.floor(rng() * 5)];
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.75, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Boot scuffs in the paths.
  for (let i = 0; i < 620; i++) {
    const x = size * 0.5 + (rng() - 0.5) * size * 0.62;
    const y = size * (0.15 + rng() * 0.7);
    ctx.globalAlpha = 0.025 + rng() * 0.05;
    ctx.fillStyle = rng() > 0.5 ? '#9a8460' : '#dcc8a0';
    ctx.beginPath();
    ctx.ellipse(x, y, (1.2 + rng() * 3.4) * s, (2.4 + rng() * 5) * s, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Straw and chaff.
  ctx.lineWidth = Math.max(1, 1.1 * s);
  for (let i = 0; i < 1100; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = (4 + rng() * 18) * s;
    const a = rng() * Math.PI * 2;
    ctx.strokeStyle = rng() > 0.45 ? 'rgba(212,190,138,0.22)' : 'rgba(152,128,88,0.2)';
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }

  // A few old, dark stains (kept subtle and brown-red, not muddy).
  for (let i = 0; i < 14; i++) {
    const cx = size * (0.28 + rng() * 0.44);
    const cy = size * (0.25 + rng() * 0.5);
    const rr = (5 + rng() * 16) * s;
    const blobs = 3 + Math.floor(rng() * 5);
    for (let b = 0; b < blobs; b++) {
      const a = rng() * Math.PI * 2;
      const d = rng() * rr * 2.0;
      const rx = rr * (0.3 + rng() * 0.5);
      ctx.globalAlpha = 0.035 + rng() * 0.09;
      ctx.fillStyle = rng() > 0.4 ? '#6a3222' : '#7d4530';
      ctx.beginPath();
      ctx.ellipse(cx + Math.cos(a) * d, cy + Math.sin(a) * d, rx, rx * (0.5 + rng() * 0.5), rng() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;

  // Faint raked arcs across the fighting floor.
  ctx.strokeStyle = 'rgba(138,116,84,0.05)';
  for (let i = 0; i < 22; i++) {
    const cx = size * (0.3 + rng() * 0.4);
    const cy = size * (0.3 + rng() * 0.4);
    const r = size * (0.05 + rng() * 0.25);
    ctx.lineWidth = (1 + rng() * 3) * s;
    ctx.beginPath();
    ctx.arc(cx, cy, r, rng() * 6.28, rng() * 6.28 + 0.6 + rng() * 2);
    ctx.stroke();
  }
  // Small stones, kept soft so the floor reads as raked sand.
  for (let i = 0; i < 170; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (2.2 + rng() * 4.6) * s;
    ctx.globalAlpha = 0.07 + rng() * 0.14;
    ctx.fillStyle = 'rgba(82,71,52,0.4)';
    ctx.beginPath();
    ctx.ellipse(x + r * 0.6, y + r * 0.55, r * 1.15, r * 0.65, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.1 + rng() * 0.18;
    ctx.fillStyle = ['#ad9770', '#bca67f', '#97835f', '#c6b089'][Math.floor(rng() * 4)];
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * 0.68, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Footprints trampled around the middle of the lists.
  for (let i = 0; i < 420; i++) {
    const angle = rng() * Math.PI * 2;
    const dist = Math.pow(rng(), 0.7) * size * 0.3;
    const x = size * 0.5 + Math.cos(angle) * dist;
    const y = size * 0.5 + Math.sin(angle) * dist * 0.9;
    const w = (2.6 + rng() * 2.6) * s;
    const h = (5 + rng() * 4) * s;
    const rot = rng() * Math.PI;
    ctx.globalAlpha = 0.05 + rng() * 0.045;
    ctx.fillStyle = 'rgba(94,80,58,0.8)';
    ctx.beginPath();
    ctx.ellipse(x, y, w, h, rot, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 0.06 + rng() * 0.05;
    ctx.fillStyle = 'rgba(228,212,178,0.8)';
    ctx.beginPath();
    ctx.ellipse(x - Math.sin(rot) * h * 0.25, y - Math.cos(rot) * h * 0.25, w * 0.66, h * 0.6, rot, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Fine grit.
  grain(ctx, rng, size, size, Math.round(30000 * s * s), 0.16, ['#96815f', '#e6d6b4', '#ad986f', '#c4af86']);

  // Grime creeping in from the walls.
  const edge = ctx.createLinearGradient(0, 0, 0, size);
  edge.addColorStop(0, 'rgba(88,74,54,0.16)');
  edge.addColorStop(0.055, 'rgba(88,74,54,0)');
  edge.addColorStop(0.945, 'rgba(88,74,54,0)');
  edge.addColorStop(1, 'rgba(88,74,54,0.16)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);
  const edgeX = ctx.createLinearGradient(0, 0, size, 0);
  edgeX.addColorStop(0, 'rgba(88,74,54,0.16)');
  edgeX.addColorStop(0.055, 'rgba(88,74,54,0)');
  edgeX.addColorStop(0.945, 'rgba(88,74,54,0)');
  edgeX.addColorStop(1, 'rgba(88,74,54,0.16)');
  ctx.fillStyle = edgeX;
  ctx.fillRect(0, 0, size, size);

  const map = textureFrom(canvas, true, aniso);

  // Fine ripple + pebble normal map.
  const heightSize = Math.max(256, Math.round(size / 2));
  const heights = fbmField(rng, heightSize, 4);
  const bumps = fbmField(rng, heightSize, 2);
  for (let i = 0; i < heights.length; i++) {
    heights[i] = heights[i] * 0.72 + Math.pow(bumps[i], 4) * 0.28;
  }
  const normalMap = normalFromHeights(heightSize, heights, 0.85);

  // Roughness: dry sand with slightly smoother worn paths.
  const rs = Math.max(256, Math.round(size / 2));
  const { canvas: roughCanvas, ctx: rctx } = canvasOf(rs, rs);
  rctx.fillStyle = '#ececec';
  rctx.fillRect(0, 0, rs, rs);
  for (let i = 0; i < 420; i++) {
    const x = rng() * rs;
    const y = rng() * rs;
    const r = (20 + rng() * 150) * (rs / 2048);
    const g = rctx.createRadialGradient(x, y, 0, x, y, r);
    const v = Math.round(200 + rng() * 46);
    g.addColorStop(0, `rgba(${v},${v},${v},0.45)`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    rctx.fillStyle = g;
    rctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  grain(rctx, rng, rs, rs, Math.round(7000 * (rs / 1024) ** 2), 0.25, ['#ffffff', '#cdcdcd']);
  const roughnessMap = textureFrom(roughCanvas, false, aniso);

  return { map, normalMap, roughnessMap };
}

/* ------------------------------------------------------------------ */
/* Limestone ashlar                                                   */
/* ------------------------------------------------------------------ */

function drawStoneRows(
  ctx: Ctx,
  rng: Rng,
  size: number,
  mode: 'color' | 'height',
): void {
  const rows = 9;
  // Uneven course heights (normalised to the tile) stop the wall reading as a grid.
  const weights: number[] = [];
  let weightSum = 0;
  for (let r = 0; r < rows; r++) {
    const w = 0.7 + rng() * 0.75;
    weights.push(w);
    weightSum += w;
  }
  const rowHeights = weights.map((w) => (w / weightSum) * size);
  const cols = ['#a8977c', '#b8a78c', '#9c8c74', '#c2b196', '#95866f', '#ae9e84', '#8a7b66', '#c7b79c', '#a5957d', '#b5a48a', '#97876f', '#cbbba0'];
  if (mode === 'color') {
    ctx.fillStyle = '#8e8371';
  } else {
    ctx.fillStyle = '#5a5a5a';
  }
  ctx.fillRect(0, 0, size, size);
  const gap = Math.max(0.8, size / 1200);
  let rowY = 0;
  for (let r = 0; r < rows; r++) {
    const rowH = rowHeights[r];
    const y = rowY;
    rowY += rowH;
    const widths = blockWidths(rng, size, size / 5.2, size / 2.4, size / 32);
    let x = -Math.floor(rng() * size * 0.4);
    for (const w of widths) {
      for (const ox of [0, size, -size]) {
        const bx = x + ox;
        if (bx > size || bx + w < 0) continue;
        if (mode === 'color') {
          const base = cols[Math.floor(rng() * cols.length)];
          ctx.fillStyle = base;
          ctx.globalAlpha = 0.62 + rng() * 0.6;
          ctx.fillRect(bx + gap, y + gap, w - gap * 2, rowH - gap * 2);
          ctx.globalAlpha = 1;
          ctx.fillRect(bx + gap, y + gap, w - gap * 2, rowH - gap * 2);
          // Soft top-light and bottom grime per block.
          const g = ctx.createLinearGradient(0, y, 0, y + rowH);
          g.addColorStop(0, 'rgba(255,248,226,0.14)');
          g.addColorStop(0.35, 'rgba(255,255,255,0)');
          g.addColorStop(0.85, 'rgba(48,42,32,0.06)');
          g.addColorStop(1, 'rgba(42,36,26,0.2)');
          ctx.fillStyle = g;
          ctx.fillRect(bx + gap, y + gap, w - gap * 2, rowH - gap * 2);
          // Bevel: lit top/left edges, shadowed bottom/right.
          const bevel = Math.max(1.2, size / 700);
          ctx.fillStyle = 'rgba(255,249,230,0.12)';
          ctx.fillRect(bx + gap, y + gap, w - gap * 2, bevel);
          ctx.fillRect(bx + gap, y + gap, bevel, rowH - gap * 2);
          ctx.fillStyle = 'rgba(38,32,24,0.13)';
          ctx.fillRect(bx + gap, y + rowH - gap - bevel, w - gap * 2, bevel);
          ctx.fillRect(bx + w - gap - bevel, y + gap, bevel, rowH - gap * 2);
          // Pits, grain and pocks.
          for (let i = 0; i < w / 3; i++) {
            ctx.globalAlpha = 0.035 + rng() * 0.09;
            ctx.fillStyle = rng() > 0.45 ? '#453f31' : '#e5dabf';
            const px = bx + gap + rng() * (w - gap * 2);
            const py = y + gap + rng() * (rowH - gap * 2);
            ctx.fillRect(px, py, 0.8 + rng() * 2.2, 0.8 + rng() * 1.8);
          }
          ctx.globalAlpha = 1;
          // Rain streaks running down from the course above.
          if (rng() > 0.62) {
            const sx = bx + rng() * w;
            const grad = ctx.createLinearGradient(0, y - rowH * 0.6, 0, y + rowH);
            grad.addColorStop(0, 'rgba(58,51,39,0.16)');
            grad.addColorStop(0.7, 'rgba(58,51,39,0.06)');
            grad.addColorStop(1, 'rgba(58,51,39,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(sx, y - rowH * 0.6, Math.max(1, 1 + rng() * 6 * (size / 1024)), rowH * 1.6);
          }
          // Chipped corner / eroded edge.
          if (rng() > 0.78) {
            ctx.fillStyle = 'rgba(66,58,44,0.42)';
            ctx.beginPath();
            const cxp = bx + (rng() > 0.5 ? w : 0);
            const cyp = y + (rng() > 0.5 ? rowH : 0);
            ctx.moveTo(cxp, cyp);
            ctx.lineTo(cxp + (rng() - 0.5) * 20 * (size / 1024), cyp + (rng() - 0.5) * 14 * (size / 1024));
            ctx.lineTo(cxp + (rng() - 0.5) * 26 * (size / 1024), cyp + (rng() - 0.5) * 18 * (size / 1024));
            ctx.closePath();
            ctx.fill();
          }
          // Hairline crack.
          if (rng() > 0.84) {
            ctx.strokeStyle = 'rgba(52,46,35,0.35)';
            ctx.lineWidth = 0.8 + rng() * 0.9;
            ctx.beginPath();
            let cxp = bx + rng() * w;
            let cyp = y + rng() * rowH;
            ctx.moveTo(cxp, cyp);
            for (let seg = 0; seg < 3; seg++) {
              cxp += (rng() - 0.5) * 24;
              cyp += rng() * 18;
              ctx.lineTo(cxp, cyp);
            }
            ctx.stroke();
          }
        } else {
          const v = 170 + Math.floor(rng() * 55);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(bx + gap, y + gap, w - gap * 2, rowH - gap * 2);
          for (let i = 0; i < w / 10; i++) {
            const gv = Math.floor(v - 45 + rng() * 80);
            ctx.fillStyle = `rgb(${gv},${gv},${gv})`;
            ctx.fillRect(bx + rng() * w, y + rng() * rowH, 1 + rng() * 3, 1 + rng() * 3);
          }
        }
      }
      x += w;
      if (x > size) break;
    }
  }
  if (mode === 'color') {
    // Broad dirty washes break up the tiling rhythm.
    for (let i = 0; i < 26; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const rx = 80 + rng() * 320;
      const ry = 60 + rng() * 260;
      const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
      ctx.globalAlpha = 0.05 + rng() * 0.08;
      g.addColorStop(0, rng() > 0.45 ? '#6d6453' : '#cfc4a9');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - rx, y - ry, rx * 2, ry * 2);
    }
    ctx.globalAlpha = 1;
    // Long rain streaks down the entire face.
    for (let i = 0; i < 30; i++) {
      const x = rng() * size;
      const w = 3 + rng() * 26;
      const y0 = rng() * size * 0.5;
      const h2 = size * (0.3 + rng() * 0.7);
      const g = ctx.createLinearGradient(0, y0, 0, y0 + h2);
      g.addColorStop(0, 'rgba(52,46,36,0.22)');
      g.addColorStop(0.6, 'rgba(52,46,36,0.08)');
      g.addColorStop(1, 'rgba(52,46,36,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y0, w, h2);
    }
    // Baked weathering: lichen, soot, damp patches.
    for (let i = 0; i < 260; i++) {
      ctx.globalAlpha = 0.035 + rng() * 0.09;
      ctx.fillStyle = rng() > 0.5 ? '#7d8262' : '#8d8a63';
      const x = rng() * size;
      const y = rng() * size;
      ctx.beginPath();
      ctx.ellipse(x, y, 1 + rng() * 6, 1 + rng() * 5, rng() * 3, 0, Math.PI * 2);
      ctx.fill();
    }
    for (let i = 0; i < 90; i++) {
      const x = rng() * size;
      const y = rng() * size;
      const r = 20 + rng() * 120;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      ctx.globalAlpha = 0.03 + rng() * 0.05;
      g.addColorStop(0, rng() > 0.5 ? '#5a5240' : '#d9cfb4');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    ctx.globalAlpha = 1;
  }
}

function createStone(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  drawStoneRows(ctx, rng, size, 'color');
  const map = textureFrom(canvas, true, aniso, true);
  // Derive relief from the painted wall itself so joints and chips line up.
  const normalMap = normalFromCanvas(canvas, 1.15);
  return { map, normalMap };
}

/* ------------------------------------------------------------------ */
/* Oak planks                                                          */
/* ------------------------------------------------------------------ */

function createWood(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  const planks = 9;
  const ph = size / planks;
  const cols = ['#67533d', '#725d45', '#594734', '#7c664c', '#6a5540', '#604c38', '#806a50'];
  ctx.fillStyle = '#33261a';
  ctx.fillRect(0, 0, size, size);
  for (let p = 0; p < planks; p++) {
    const y = p * ph;
    const col = cols[Math.floor(rng() * cols.length)];
    ctx.fillStyle = col;
    ctx.fillRect(0, y + 2, size, ph - 4);
    // Grain: long wavy strokes.
    for (let l = 0; l < 22; l++) {
      ctx.strokeStyle = rng() > 0.5 ? 'rgba(38,26,16,0.22)' : 'rgba(206,174,128,0.16)';
      ctx.lineWidth = 0.7 + rng() * 2.4;
      const baseY = y + 4 + rng() * (ph - 8);
      ctx.beginPath();
      ctx.moveTo(-20, baseY);
      for (let x = 0; x <= size + 20; x += 40) {
        ctx.lineTo(x, baseY + Math.sin((x / size) * Math.PI * (2 + rng() * 3) + l) * (1.5 + rng() * 4));
      }
      ctx.stroke();
    }
    // Knots.
    if (rng() > 0.5) {
      const kx = rng() * size;
      const ky = y + ph * (0.3 + rng() * 0.4);
      for (let k = 0; k < 4; k++) {
        ctx.strokeStyle = `rgba(42,29,17,${0.4 - k * 0.07})`;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.ellipse(kx, ky, 3 + k * 4.5, 2 + k * 3.5, 0.3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Edge shadow / bevel between planks.
    const g = ctx.createLinearGradient(0, y, 0, y + ph);
    g.addColorStop(0, 'rgba(255,236,198,0.16)');
    g.addColorStop(0.1, 'rgba(255,255,255,0)');
    g.addColorStop(0.9, 'rgba(22,15,9,0.18)');
    g.addColorStop(1, 'rgba(22,15,9,0.55)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y, size, ph);
    // Nail heads.
    for (const nx of [6 + rng() * 20, size - 6 - rng() * 20]) {
      ctx.fillStyle = 'rgba(32,30,28,0.7)';
      ctx.beginPath();
      ctx.arc(nx, y + ph * 0.5, 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(206,196,176,0.4)';
      ctx.beginPath();
      ctx.arc(nx - 0.7, y + ph * 0.5 - 0.7, 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // Dirt, sun bleaching, axe marks.
  for (let i = 0; i < 200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 10 + rng() * 110;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.03 + rng() * 0.08;
    g.addColorStop(0, rng() > 0.45 ? '#241a10' : '#c4a97c');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 500; i++) {
    ctx.strokeStyle = rng() > 0.5 ? 'rgba(40,28,18,0.14)' : 'rgba(210,180,132,0.1)';
    ctx.lineWidth = 0.6 + rng();
    const x = rng() * size;
    const y = rng() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * 30, y + (rng() - 0.5) * 4);
    ctx.stroke();
  }
  grain(ctx, rng, size, size, Math.round(9000 * (size / 1024) ** 2), 0.14, ['#2e2115', '#b39468']);

  const { canvas: hCanvas, ctx: hCtx } = canvasOf(size / 2, size / 2);
  const hs = size / 2;
  hCtx.fillStyle = '#3a3a3a';
  hCtx.fillRect(0, 0, hs, hs);
  for (let p = 0; p < planks; p++) {
    const y = (p * hs) / planks;
    hCtx.fillStyle = '#bcbcbc';
    hCtx.fillRect(0, y + 2, hs, hs / planks - 4);
  }
  grain(hCtx, rng, hs, hs, 6000, 0.35, ['#828282', '#dadada']);
  return { map: textureFrom(canvas, true, aniso, true), normalMap: normalFromCanvas(hCanvas, 0.85) };
}

/* ------------------------------------------------------------------ */
/* Shingle roof                                                        */
/* ------------------------------------------------------------------ */

function createShingle(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  const rows = 14;
  const rowH = size / rows;
  const cols = ['#94866e', '#a09178', '#877a65', '#a89a82', '#7d7160', '#ad9e86'];
  ctx.fillStyle = '#3a332b';
  ctx.fillRect(0, 0, size, size);
  for (let r = 0; r < rows; r++) {
    const y = r * rowH;
    const shift = (r % 2) * (size / 28);
    let x = -shift;
    while (x < size) {
      const w = size / 13 + (rng() - 0.5) * (size / 40);
      for (const ox of [0, size, -size]) {
        const bx = x + ox;
        if (bx > size || bx + w < 0) continue;
        ctx.fillStyle = cols[Math.floor(rng() * cols.length)];
        ctx.fillRect(bx + 1, y + 2, w - 2, rowH - 2);
        const g = ctx.createLinearGradient(0, y, 0, y + rowH);
        g.addColorStop(0, 'rgba(255,248,228,0.16)');
        g.addColorStop(0.45, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(16,12,8,0.5)');
        ctx.fillStyle = g;
        ctx.fillRect(bx + 1, y + 2, w - 2, rowH - 2);
        // Weathering and moss between shingles.
        if (rng() > 0.68) {
          ctx.globalAlpha = 0.09 + rng() * 0.14;
          ctx.fillStyle = rng() > 0.5 ? '#6f7852' : '#4a443a';
          ctx.beginPath();
          ctx.ellipse(bx + rng() * w, y + rng() * rowH, 2 + rng() * 8, 1 + rng() * 5, rng() * 3, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      }
      x += w;
    }
  }
  grain(ctx, rng, size, size, Math.round(12000 * (size / 1024) ** 2), 0.12, ['#211c16', '#b1a48f']);
  for (let i = 0; i < 110; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = 20 + rng() * 130;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.04 + rng() * 0.07;
    g.addColorStop(0, rng() > 0.5 ? '#707a58' : '#39332b');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;

  const { canvas: hCanvas, ctx: hCtx } = canvasOf(size / 2, size / 2);
  const hs = size / 2;
  hCtx.fillStyle = '#908f8f';
  hCtx.fillRect(0, 0, hs, hs);
  for (let r = 0; r < rows; r++) {
    const y = (r * hs) / rows;
    hCtx.fillStyle = '#d0d0d0';
    hCtx.fillRect(0, y + 1, hs, hs / rows - 2);
    hCtx.fillStyle = '#333333';
    hCtx.fillRect(0, y + hs / rows - 3, hs, 3);
  }
  grain(hCtx, rng, hs, hs, 5000, 0.38, ['#7a7a7a', '#e4e4e4']);
  return { map: textureFrom(canvas, true, aniso, true), normalMap: normalFromCanvas(hCanvas, 1.4) };
}

/* ------------------------------------------------------------------ */
/* Lime plaster                                                        */
/* ------------------------------------------------------------------ */

function createPlaster(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = '#d9c9a3';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 420; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (10 + rng() * 90) * (size / 512);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.04 + rng() * 0.09;
    g.addColorStop(0, rng() > 0.5 ? '#c3b08b' : '#e9dcc0');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Cracks and grime.
  for (let i = 0; i < 16; i++) {
    ctx.strokeStyle = 'rgba(96,84,66,0.3)';
    ctx.lineWidth = 0.8 + rng() * 1.4;
    let x = rng() * size;
    let y = rng() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += (rng() - 0.5) * 50;
      y += (rng() - 0.5) * 50;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  grain(ctx, rng, size, size, Math.round(6000 * (size / 512) ** 2), 0.14, ['#b6a37e', '#f0e6cd']);
  return { map: textureFrom(canvas, true, aniso, true) };
}

/* ------------------------------------------------------------------ */
/* Iron                                                                */
/* ------------------------------------------------------------------ */

function createMetal(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = '#3b3b3c';
  ctx.fillRect(0, 0, size, size);
  for (let i = 0; i < 180; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (2 + rng() * 26) * (size / 256);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.12 + rng() * 0.3;
    g.addColorStop(0, rng() > 0.55 ? '#6e4a2c' : '#232426');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  for (let i = 0; i < 60; i++) {
    ctx.strokeStyle = rng() > 0.5 ? 'rgba(190,190,195,0.12)' : 'rgba(20,20,22,0.2)';
    ctx.lineWidth = 0.8;
    const y = rng() * size;
    ctx.beginPath();
    ctx.moveTo(rng() * size, y);
    ctx.lineTo(rng() * size, y + (rng() - 0.5) * 8);
    ctx.stroke();
  }
  return { map: textureFrom(canvas, true, aniso, true) };
}

/* ------------------------------------------------------------------ */
/* Hay                                                                 */
/* ------------------------------------------------------------------ */

function createHay(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = '#b08b47';
  ctx.fillRect(0, 0, size, size);
  const straws = ['#d8b869', '#c9a656', '#e0c580', '#a78542', '#bd9a4c', '#8f6f36'];
  for (let i = 0; i < 4200; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = (3 + rng() * 26) * (size / 512);
    const a = rng() * Math.PI * 2;
    ctx.strokeStyle = straws[Math.floor(rng() * straws.length)];
    ctx.globalAlpha = 0.3 + rng() * 0.55;
    ctx.lineWidth = 0.6 + rng() * 1.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Twine bands.
  for (const ty of [0.3, 0.7]) {
    for (let i = 0; i < size / 6; i++) {
      ctx.strokeStyle = 'rgba(74,54,30,0.55)';
      ctx.lineWidth = 1.6;
      const x = rng() * size;
      ctx.beginPath();
      ctx.moveTo(x, size * ty + (rng() - 0.5) * 8);
      ctx.lineTo(x + 8, size * ty + (rng() - 0.5) * 8);
      ctx.stroke();
    }
  }
  return { map: textureFrom(canvas, true, aniso, true) };
}

/* ------------------------------------------------------------------ */
/* Outer terrain                                                       */
/* ------------------------------------------------------------------ */

function createOuter(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = '#9c9470';
  ctx.fillRect(0, 0, size, size);
  const cols = ['#8f8a63', '#a79b74', '#7c8055', '#b0a17a', '#87835c', '#6f754c', '#a89065'];
  for (let i = 0; i < 2600; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (3 + rng() * 90) * (size / 1024);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.06 + rng() * 0.16;
    g.addColorStop(0, cols[Math.floor(rng() * cols.length)]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  // Grass tufts.
  for (let i = 0; i < 2400; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = (2 + rng() * 9) * (size / 1024);
    ctx.strokeStyle = rng() > 0.4 ? 'rgba(96,110,64,0.5)' : 'rgba(158,150,104,0.5)';
    ctx.lineWidth = 0.8 + rng();
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (rng() - 0.5) * len, y - len);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  grain(ctx, rng, size, size, Math.round(14000 * (size / 1024) ** 2), 0.2, ['#5d5c40', '#c2b68c']);
  return { map: textureFrom(canvas, true, aniso, true) };
}

/* ------------------------------------------------------------------ */
/* Heraldic banners                                                    */
/* ------------------------------------------------------------------ */

type Emblem = 'cross' | 'chevron' | 'lion' | 'star' | 'bars' | 'sun';
const EMBLEMS: Emblem[] = ['cross', 'chevron', 'lion', 'star'];

function drawEmblem(ctx: Ctx, emblem: Emblem, cx: number, cy: number, r: number, color: string, accent: string): void {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.fillStyle = color;
  ctx.strokeStyle = accent;
  ctx.lineWidth = r * 0.06;
  switch (emblem) {
    case 'cross': {
      const arm = r * 0.22;
      ctx.fillRect(-arm, -r * 0.9, arm * 2, r * 1.8);
      ctx.fillRect(-r * 0.68, -arm, r * 1.36, arm * 2);
      ctx.globalAlpha = 0.5;
      ctx.strokeRect(-arm, -r * 0.9, arm * 2, r * 1.8);
      ctx.strokeRect(-r * 0.68, -arm, r * 1.36, arm * 2);
      break;
    }
    case 'chevron': {
      ctx.beginPath();
      ctx.moveTo(-r * 0.72, r * 0.55);
      ctx.lineTo(0, -r * 0.62);
      ctx.lineTo(r * 0.72, r * 0.55);
      ctx.lineTo(r * 0.72, r * 0.18);
      ctx.lineTo(0, -r * 0.98);
      ctx.lineTo(-r * 0.72, r * 0.18);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      break;
    }
    case 'star': {
      ctx.beginPath();
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
        const rr = i % 2 === 0 ? r * 0.82 : r * 0.34;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      break;
    }
    case 'lion': {
      // Stylised rampant beast: body arc, raised foreleg, tail.
      ctx.beginPath();
      ctx.moveTo(-r * 0.55, r * 0.72);
      ctx.quadraticCurveTo(-r * 0.1, r * 0.25, r * 0.1, -r * 0.2);
      ctx.quadraticCurveTo(r * 0.25, -r * 0.55, r * 0.62, -r * 0.52);
      ctx.quadraticCurveTo(r * 0.4, -r * 0.75, r * 0.05, -r * 0.62);
      ctx.quadraticCurveTo(-r * 0.35, -r * 0.5, -r * 0.3, r * 0.1);
      ctx.quadraticCurveTo(-r * 0.62, r * 0.3, -r * 0.55, r * 0.72);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.arc(r * 0.5, -r * 0.62, r * 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.5;
      ctx.stroke();
      break;
    }
    default: {
      const bars = 3;
      for (let i = 0; i < bars; i++) {
        ctx.fillRect(-r * 0.7, -r * 0.65 + i * r * 0.5, r * 1.4, r * 0.22);
      }
      break;
    }
  }
  ctx.restore();
}

function createBannerTexture(rng: Rng, base: number, secondary: number, emblem: Emblem, aniso: number): THREE.CanvasTexture {
  const w = 512;
  const h = 768;
  const clothH = 690;
  const { canvas, ctx } = canvasOf(w, h);
  ctx.clearRect(0, 0, w, h);

  // Cloth body with a slightly ragged / shaped bottom edge.
  const baseCol = new THREE.Color(base).offsetHSL(0, 0.1, 0.035);
  const secCol = new THREE.Color(secondary).offsetHSL(0, 0.06, 0.02);
  ctx.fillStyle = baseCol.getStyle();
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(w, 0);
  ctx.lineTo(w, clothH - 16);
  ctx.lineTo(w * 0.82, clothH);
  ctx.lineTo(w * 0.72, clothH - 14);
  ctx.lineTo(w * 0.52, clothH - 2);
  ctx.lineTo(w * 0.34, clothH - 16);
  ctx.lineTo(w * 0.18, clothH - 2);
  ctx.lineTo(0, clothH - 14);
  ctx.closePath();
  ctx.fill();

  // Cloth folds and weave.
  for (let i = 0; i < 7; i++) {
    const x = (i + 0.5) * (w / 7) + (rng() - 0.5) * 20;
    const g = ctx.createLinearGradient(x - 40, 0, x + 40, 0);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.5, i % 2 === 0 ? 'rgba(0,0,0,0.18)' : 'rgba(255,240,210,0.10)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - 40, 0, 80, clothH);
  }
  for (let i = 0; i < 2400; i++) {
    ctx.globalAlpha = 0.02 + rng() * 0.042;
    ctx.fillStyle = rng() > 0.5 ? '#000000' : '#fff4d8';
    ctx.fillRect(rng() * w, rng() * clothH, 1 + rng() * 2, 1 + rng() * 2);
  }
  ctx.globalAlpha = 1;

  // Pole sleeve at the top.
  ctx.fillStyle = 'rgba(24,18,12,0.65)';
  ctx.fillRect(0, 0, w, 34);
  ctx.fillStyle = 'rgba(201,162,74,0.5)';
  ctx.fillRect(0, 34, w, 3);

  // Border.
  ctx.strokeStyle = secCol.getStyle();
  ctx.lineWidth = 16;
  ctx.strokeRect(26, 54, w - 52, clothH - 96);
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(201,162,74,0.75)';
  ctx.strokeRect(42, 70, w - 84, clothH - 128);

  // Emblem.
  drawEmblem(ctx, emblem, w * 0.5, clothH * 0.44, w * 0.28, secCol.getStyle(), 'rgba(201,162,74,0.85)');
  // Small repeated emblems lower down.
  for (const ex of [0.3, 0.7]) {
    drawEmblem(ctx, emblem, w * ex, clothH * 0.72, w * 0.075, secCol.getStyle(), 'rgba(201,162,74,0.6)');
  }

  // Fringe tassels.
  const fringeY = clothH - 6;
  ctx.fillStyle = secCol.getStyle();
  for (let i = 0; i < 16; i++) {
    const x = 8 + i * ((w - 16) / 16);
    ctx.beginPath();
    ctx.moveTo(x, fringeY);
    ctx.lineTo(x + (w - 16) / 32, fringeY);
    ctx.lineTo(x + (w - 16) / 64, h - 8);
    ctx.closePath();
    ctx.fill();
  }

  // Weathering: grime at the bottom, a couple of tears and stains.
  const grime = ctx.createLinearGradient(0, clothH * 0.6, 0, clothH);
  grime.addColorStop(0, 'rgba(52,38,20,0)');
  grime.addColorStop(1, 'rgba(52,38,20,0.34)');
  ctx.fillStyle = grime;
  ctx.fillRect(0, clothH * 0.6, w, clothH * 0.4);
  for (let i = 0; i < 10; i++) {
    const x = rng() * w;
    const y = clothH * (0.45 + rng() * 0.5);
    const r = 12 + rng() * 46;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.08 + rng() * 0.14;
    g.addColorStop(0, '#2b1b10');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 3; i++) {
    const x = rng() * w;
    const y = clothH * (0.55 + rng() * 0.4);
    ctx.beginPath();
    ctx.ellipse(x, y, 4 + rng() * 9, 10 + rng() * 26, rng() * 2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';

  const tex = textureFrom(canvas, true, aniso);
  return tex;
}

/* ------------------------------------------------------------------ */
/* Pennant (instanced, tinted per house)                               */
/* ------------------------------------------------------------------ */

function createPennant(rng: Rng, aniso: number): THREE.CanvasTexture {
  const w = 256;
  const h = 96;
  const { canvas, ctx } = canvasOf(w, h);
  ctx.fillStyle = '#e6ddc4';
  ctx.fillRect(0, 0, w, h);
  // Vertical stripes near the hoist and a darker fly band.
  ctx.fillStyle = 'rgba(90,74,52,0.55)';
  ctx.fillRect(w * 0.16, 0, w * 0.05, h);
  ctx.fillRect(w * 0.3, 0, w * 0.05, h);
  ctx.fillStyle = 'rgba(60,48,34,0.35)';
  ctx.fillRect(0, h * 0.16, w, h * 0.04);
  ctx.fillRect(0, h * 0.8, w, h * 0.04);
  for (let i = 0; i < 1400; i++) {
    ctx.globalAlpha = 0.05 + rng() * 0.07;
    ctx.fillStyle = rng() > 0.5 ? '#000000' : '#fff8e8';
    ctx.fillRect(rng() * w, rng() * h, 1 + rng() * 2, 1 + rng() * 2);
  }
  ctx.globalAlpha = 1;
  // Stitching near the hoist.
  ctx.strokeStyle = 'rgba(40,30,20,0.5)';
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.beginPath();
  ctx.moveTo(w * 0.06, 0);
  ctx.lineTo(w * 0.06, h);
  ctx.stroke();
  ctx.setLineDash([]);
  return textureFrom(canvas, true, aniso);
}

/* ------------------------------------------------------------------ */
/* Decal + particle helpers                                            */
/* ------------------------------------------------------------------ */

function createBlood(rng: Rng, aniso: number): THREE.CanvasTexture {
  const size = 256;
  const { canvas, ctx } = canvasOf(size, size);
  ctx.clearRect(0, 0, size, size);
  const blob = (x: number, y: number, r: number, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(74,10,8,${alpha})`);
    g.addColorStop(0.55, `rgba(92,16,12,${alpha * 0.7})`);
    g.addColorStop(1, 'rgba(92,16,12,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  };
  blob(size / 2, size / 2, size * 0.4, 0.6);
  for (let i = 0; i < 26; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.pow(rng(), 0.6) * size * 0.42;
    blob(size / 2 + Math.cos(a) * d, size / 2 + Math.sin(a) * d, size * (0.04 + rng() * 0.16), 0.3 + rng() * 0.4);
  }
  for (let i = 0; i < 40; i++) {
    const a = rng() * Math.PI * 2;
    const d = size * (0.2 + rng() * 0.32);
    ctx.fillStyle = `rgba(70,9,7,${0.3 + rng() * 0.5})`;
    ctx.beginPath();
    ctx.ellipse(
      size / 2 + Math.cos(a) * d,
      size / 2 + Math.sin(a) * d,
      1 + rng() * 4,
      1 + rng() * 3,
      rng() * 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  return textureFrom(canvas, true, aniso);
}

function createDust(rng: Rng): THREE.CanvasTexture {
  const size = 64;
  const { canvas, ctx } = canvasOf(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,246,222,1)');
  g.addColorStop(0.35, 'rgba(255,240,205,0.75)');
  g.addColorStop(1, 'rgba(255,238,200,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // A little irregularity so motes are not perfect circles.
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath();
    ctx.arc(rng() * size, rng() * size, rng() * 5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  return textureFrom(canvas, true, 1);
}

function createFlame(rng: Rng): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = canvasOf(size, size);
  const g = ctx.createRadialGradient(size / 2, size * 0.62, 0, size / 2, size * 0.62, size * 0.46);
  g.addColorStop(0, 'rgba(255,252,224,1)');
  g.addColorStop(0.28, 'rgba(255,214,120,0.95)');
  g.addColorStop(0.62, 'rgba(255,140,44,0.55)');
  g.addColorStop(1, 'rgba(214,80,20,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(size / 2, size * 0.58, size * 0.4, size * 0.46, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 12; i++) {
    ctx.globalAlpha = 0.12 + rng() * 0.16;
    ctx.fillStyle = '#ffd88a';
    ctx.beginPath();
    ctx.ellipse(size / 2 + (rng() - 0.5) * 40, size * 0.5 + (rng() - 0.5) * 45, 4 + rng() * 12, 8 + rng() * 22, rng() * 0.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  return textureFrom(canvas, true, 1);
}

function createBlob(rng: Rng): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = canvasOf(size, size);
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(size / 2, size / 2, size * 0.48, size * 0.4, rng() * 0.4, 0, Math.PI * 2);
  ctx.fill();
  return textureFrom(canvas, true, 1);
}

/* ------------------------------------------------------------------ */
/* Rock face                                                           */
/* ------------------------------------------------------------------ */

function createRock(rng: Rng, size: number, aniso: number): SurfaceTexture {
  const { canvas, ctx } = canvasOf(size, size);
  ctx.fillStyle = '#b3a996';
  ctx.fillRect(0, 0, size, size);
  const cols = ['#bcb2a0', '#a89e8d', '#c8bda9', '#9a907f', '#b3a996', '#a29886'];
  for (let i = 0; i < 320; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = (8 + rng() * 80) * (size / 512);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    ctx.globalAlpha = 0.1 + rng() * 0.25;
    g.addColorStop(0, cols[Math.floor(rng() * cols.length)]);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  ctx.globalAlpha = 1;
  // Fractures and strata.
  for (let i = 0; i < 90; i++) {
    ctx.strokeStyle = rng() > 0.5 ? 'rgba(60,55,45,0.28)' : 'rgba(210,200,178,0.22)';
    ctx.lineWidth = 0.8 + rng() * 2.6;
    let x = rng() * size;
    let y = rng() * size;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let seg = 0; seg < 4; seg++) {
      x += (rng() - 0.5) * 70;
      y += (rng() - 0.5) * 26;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // Lichen patches.
  for (let i = 0; i < 120; i++) {
    ctx.globalAlpha = 0.06 + rng() * 0.14;
    ctx.fillStyle = rng() > 0.5 ? '#78805a' : '#8e8b62';
    const x = rng() * size;
    const y = rng() * size;
    ctx.beginPath();
    ctx.ellipse(x, y, 2 + rng() * 12, 2 + rng() * 9, rng() * 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  grain(ctx, rng, size, size, Math.round(14000 * (size / 512) ** 2), 0.18, ['#4b463b', '#cfc4ab']);

  const { canvas: hCanvas, ctx: hCtx } = canvasOf(size / 2, size / 2);
  const hs = size / 2;
  hCtx.fillStyle = '#808080';
  hCtx.fillRect(0, 0, hs, hs);
  grain(hCtx, rng, hs, hs, 14000, 0.6, ['#404040', '#d0d0d0']);
  for (let i = 0; i < 40; i++) {
    hCtx.strokeStyle = 'rgba(30,30,30,0.8)';
    hCtx.lineWidth = 1 + rng() * 2;
    hCtx.beginPath();
    hCtx.moveTo(rng() * hs, rng() * hs);
    hCtx.lineTo(rng() * hs, rng() * hs);
    hCtx.stroke();
  }
  return { map: textureFrom(canvas, true, aniso, true), normalMap: normalFromCanvas(hCanvas, 1.15) };
}

/* ------------------------------------------------------------------ */
/* Wall-base ambient occlusion strip + dry grass tuft                  */
/* ------------------------------------------------------------------ */

function createAoStrip(): THREE.CanvasTexture {
  const { canvas, ctx } = canvasOf(16, 128);
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, 'rgba(30,25,18,0)');
  g.addColorStop(0.55, 'rgba(30,25,18,0.08)');
  g.addColorStop(1, 'rgba(30,25,18,0.3)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 16, 128);
  return textureFrom(canvas, true, 1, true);
}

function createTuft(rng: Rng, aniso: number): THREE.CanvasTexture {
  const size = 128;
  const { canvas, ctx } = canvasOf(size, size);
  ctx.clearRect(0, 0, size, size);
  const straws = ['#c9a85c', '#b99449', '#d8bd74', '#a0803c', '#c2a055'];
  for (let i = 0; i < 60; i++) {
    const baseX = size * 0.5 + (rng() - 0.5) * size * 0.36;
    const baseY = size * 0.96;
    const tipX = baseX + (rng() - 0.5) * size * 0.7;
    const tipY = size * (0.1 + rng() * 0.5);
    ctx.strokeStyle = straws[Math.floor(rng() * straws.length)];
    ctx.globalAlpha = 0.55 + rng() * 0.45;
    ctx.lineWidth = 0.8 + rng() * 2.2;
    ctx.beginPath();
    ctx.moveTo(baseX, baseY);
    ctx.quadraticCurveTo(baseX + (tipX - baseX) * 0.4, baseY - (baseY - tipY) * 0.55, tipX, tipY);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return textureFrom(canvas, true, aniso);
}

/* ------------------------------------------------------------------ */
/* Public bank                                                         */
/* ------------------------------------------------------------------ */

export interface TextureQuality {
  quality: 'low' | 'medium' | 'high';
  seed: number;
  anisotropy: number;
}

export function createArenaTextures(opts: TextureQuality): ArenaTextureBank {
  const { quality, seed, anisotropy } = opts;
  const hi = quality === 'high';
  const med = quality !== 'low';
  const rand = (salt: number): Rng => mulberry32((seed ^ (salt * 2654435761)) >>> 0);

  const sand = createSand(rand(11), hi ? 2048 : 1024, anisotropy);
  const outer = createOuter(rand(13), med ? 1024 : 512, anisotropy);
  const stone = createStone(rand(17), hi ? 1024 : 512, anisotropy);
  const wood = createWood(rand(19), hi ? 1024 : 512, anisotropy);
  const shingle = createShingle(rand(23), hi ? 1024 : 512, anisotropy);
  const plaster = createPlaster(rand(29), med ? 512 : 256, anisotropy);
  const metal = createMetal(rand(31), 256, anisotropy);
  const hay = createHay(rand(37), med ? 512 : 256, anisotropy);
  const rock = createRock(rand(67), med ? 512 : 256, anisotropy);
  const aoStrip = createAoStrip();
  const tuft = createTuft(rand(71), anisotropy);

  const banners = TEAM_PALETTE.map((pal, i) =>
    createBannerTexture(
      rand(41 + i * 7),
      pal.color,
      pal.secondary,
      EMBLEMS[i % EMBLEMS.length],
      anisotropy,
    ),
  );
  // Neutral spectator pennants / town colours.
  banners.push(createBannerTexture(rand(97), 0x7a5a2e, 0xd9c9a3, 'star', anisotropy));
  banners.push(createBannerTexture(rand(101), 0x765a3a, 0xcec197, 'bars', anisotropy));

  const pennant = createPennant(rand(43), anisotropy);
  const blood = createBlood(rand(47), anisotropy);
  const dust = createDust(rand(53));
  const flame = createFlame(rand(59));
  const blob = createBlob(rand(61));

  const all: THREE.Texture[] = [
    sand.map, sand.normalMap, sand.roughnessMap,
    outer.map, stone.map, stone.normalMap, wood.map, wood.normalMap,
    shingle.map, shingle.normalMap, plaster.map, metal.map, hay.map,
    rock.map, rock.normalMap, aoStrip, tuft,
    ...banners, pennant, blood, dust, flame, blob,
  ].filter(Boolean) as THREE.Texture[];

  return {
    sand,
    outer,
    stone,
    wood,
    shingle,
    plaster,
    metal,
    hay,
    rock,
    banners,
    pennant,
    blood,
    dust,
    flame,
    blob,
    aoStrip,
    tuft,
    dispose: () => {
      for (const t of all) t.dispose();
    },
  };
}
