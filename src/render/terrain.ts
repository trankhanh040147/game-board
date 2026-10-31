/**
 * FIRST HEARTH — baked isometric terrain
 * --------------------------------------
 * Static terrain is baked into offscreen chunk canvases (8x8 tiles) at a
 * resolution matching the current zoom so the per-frame cost is a handful of
 * drawImage calls. Chunks carry elevation shading, cliff faces, coast foam,
 * roads and a very subtle tile grid.
 *
 * Water animation, trees, buildings, fields and citizens are drawn per frame by
 * the renderer on top of these chunks.
 */
import type { Tile, WorldState } from '../sim/types';
import type { Camera } from './camera';
import { mapToTileF } from './camera';
import { Palette } from './palette';
import {
  CHUNK_TILES,
  HALF_H,
  HALF_W,
  TILE_H,
  clamp,
  cssColor,
  cssColorAlpha,
  darkenColor,
  hash2,
  makeCanvas,
} from './utils';

interface Chunk {
  key: string;
  cx: number;
  cy: number;
  bucket: number;
  canvas: HTMLCanvasElement;
  scale: number;
  x0: number;
  y0: number;
  mapW: number;
  mapH: number;
  bytes: number;
  lastUsed: number;
}

export interface TerrainDrawOptions {
  showGrid: boolean;
  /** Called when a chunk is baked (debug/perf counters). */
  onBake?: () => void;
}

const MAX_CHUNK_BYTES = 74 * 1024 * 1024;

export class Terrain {
  private palette: Palette;
  private world: WorldState | null = null;
  private chunks = new Map<string, Chunk>();
  private bucket = 1;
  private bytes = 0;
  private frame = 0;
  bakeCount = 0;
  drawnChunks = 0;
  private pending: { cx: number; cy: number; d: number }[] = [];
  private showGrid = true;

  constructor(palette: Palette) {
    this.palette = palette;
  }

  setWorld(world: WorldState | null): void {
    this.world = world;
    this.clear();
  }

  clear(): void {
    this.chunks.clear();
    this.bytes = 0;
    this.pending.length = 0;
  }

  get chunkCount(): number {
    return this.chunks.size;
  }

  get byteCount(): number {
    return this.bytes;
  }

  setBucket(bucket: number): void {
    this.bucket = bucket;
  }

  setShowGrid(show: boolean): void {
    if (show === this.showGrid) return;
    this.showGrid = show;
    this.clear();
  }

  /** Invalidate the chunks that contain any of the given tile indices. */
  invalidateTiles(tiles: number[]): void {
    const w = this.world;
    if (!w) {
      this.clear();
      return;
    }
    const touched = new Set<string>();
    for (const idx of tiles) {
      const x = idx % w.width;
      const y = (idx / w.width) | 0;
      const cx = Math.floor(x / CHUNK_TILES);
      const cy = Math.floor(y / CHUNK_TILES);
      touched.add(`${cx}:${cy}`);
    }
    if (!touched.size) return;
    for (const key of [...this.chunks.keys()]) {
      const ch = this.chunks.get(key);
      if (!ch) continue;
      if (touched.has(`${ch.cx}:${ch.cy}`)) {
        this.bytes -= ch.bytes;
        this.chunks.delete(key);
      }
    }
  }

  /** Visible tile bounds (with margin) for the current camera. */
  visibleTiles(camera: Camera, margin = 2): { x0: number; y0: number; x1: number; y1: number } {
    const w = this.world;
    if (!w) return { x0: 0, y0: 0, x1: 0, y1: 0 };
    const m = camera.visibleMap();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    const sample = (mx: number, my: number): void => {
      const f = mapToTileF(mx, my);
      if (f.x < minX) minX = f.x;
      if (f.x > maxX) maxX = f.x;
      if (f.y < minY) minY = f.y;
      if (f.y > maxY) maxY = f.y;
    };
    sample(m.left, m.top);
    sample(m.right, m.top);
    sample(m.left, m.bottom);
    sample(m.right, m.bottom);
    return {
      x0: clamp(Math.floor(minX) - margin, 0, w.width - 1),
      y0: clamp(Math.floor(minY) - margin, 0, w.height - 1),
      x1: clamp(Math.ceil(maxX) + margin, 0, w.width - 1),
      y1: clamp(Math.ceil(maxY) + margin, 0, w.height - 1),
    };
  }

  /**
   * Draw all visible chunks; bake at most `budget` missing chunks this frame.
   * Missing chunks fall back to flat colour so nothing pops as empty space.
   */
  draw(ctx: CanvasRenderingContext2D, camera: Camera, budget: number, opts: TerrainDrawOptions): void {
    const w = this.world;
    this.frame++;
    this.drawnChunks = 0;
    if (!w) return;
    const vt = this.visibleTiles(camera, 1);
    const cx0 = Math.floor(vt.x0 / CHUNK_TILES);
    const cx1 = Math.floor(vt.x1 / CHUNK_TILES);
    const cy0 = Math.floor(vt.y0 / CHUNK_TILES);
    const cy1 = Math.floor(vt.y1 / CHUNK_TILES);
    this.pending.length = 0;

    const centerCx = (vt.x0 + vt.x1) * 0.5;
    const centerCy = (vt.y0 + vt.y1) * 0.5;

    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const key = `${this.bucket}|${cx}|${cy}`;
        const ch = this.chunks.get(key);
        if (ch) {
          ch.lastUsed = this.frame;
          this.drawChunk(ctx, camera, ch);
          this.drawnChunks++;
        } else {
          const dx = (cx + 0.5) * CHUNK_TILES - centerCx;
          const dy = (cy + 0.5) * CHUNK_TILES - centerCy;
          this.pending.push({ cx, cy, d: dx * dx + dy * dy });
        }
      }
    }

    // bake nearest chunks first, up to the per-frame budget
    if (this.pending.length && budget > 0) {
      this.pending.sort((a, b) => a.d - b.d);
      const n = Math.min(budget, this.pending.length);
      for (let i = 0; i < n; i++) {
        const p = this.pending[i];
        const ch = this.bake(p.cx, p.cy);
        if (ch) {
          this.chunks.set(ch.key, ch);
          this.bytes += ch.bytes;
          this.drawChunk(ctx, camera, ch);
          this.drawnChunks++;
          this.bakeCount++;
          opts.onBake?.();
        }
      }
      this.evict();
      // cursed but effective: any still-missing chunk gets a flat fallback
      for (let i = n; i < this.pending.length; i++) {
        const p = this.pending[i];
        this.drawFlatChunk(ctx, p.cx, p.cy);
      }
    } else {
      for (const p of this.pending) this.drawFlatChunk(ctx, p.cx, p.cy);
    }
  }

  private evict(): void {
    if (this.bytes <= MAX_CHUNK_BYTES) return;
    const entries = [...this.chunks.values()].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const ch of entries) {
      if (this.bytes <= MAX_CHUNK_BYTES) break;
      this.chunks.delete(ch.key);
      this.bytes -= ch.bytes;
    }
  }

  private drawChunk(ctx: CanvasRenderingContext2D, camera: Camera, ch: Chunk): void {
    const z = camera.zoom;
    // 0.35 map-px of overlap hides seams from bilinear filtering / fractional zoom
    const pad = 0.4 / z;
    ctx.drawImage(
      ch.canvas,
      ch.x0 - pad,
      ch.y0 - pad,
      ch.mapW + pad * 2,
      ch.mapH + pad * 2,
    );
  }

  /** Fast low-detail fill for chunks that are not baked yet. */
  private drawFlatChunk(ctx: CanvasRenderingContext2D, cx: number, cy: number): void {
    const w = this.world;
    if (!w) return;
    const pal = this.palette;
    const x0 = cx * CHUNK_TILES;
    const y0 = cy * CHUNK_TILES;
    const x1 = Math.min(w.width - 1, x0 + CHUNK_TILES - 1);
    const y1 = Math.min(w.height - 1, y0 + CHUNK_TILES - 1);
    if (x0 > w.width - 1 || y0 > w.height - 1) return;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = w.tiles[y * w.width + x];
        if (!t) continue;
        const h = pal.heightPx(t);
        const mx = (x - y) * HALF_W;
        const ny = (x + y) * HALF_H - h;
        ctx.beginPath();
        ctx.moveTo(mx, ny);
        ctx.lineTo(mx + HALF_W, ny + HALF_H);
        ctx.lineTo(mx, ny + TILE_H);
        ctx.lineTo(mx - HALF_W, ny + HALF_H);
        ctx.closePath();
        ctx.fillStyle = cssColor(pal.hasWater(t) ? pal.waterColor(t, x, y) : pal.groundColor(t, x, y));
        ctx.fill();
      }
    }
  }

  private bake(cx: number, cy: number): Chunk | null {
    const w = this.world;
    if (!w) return null;
    const x0 = cx * CHUNK_TILES;
    const y0 = cy * CHUNK_TILES;
    const x1 = Math.min(w.width - 1, x0 + CHUNK_TILES - 1);
    const y1 = Math.min(w.height - 1, y0 + CHUNK_TILES - 1);
    if (x0 > w.width - 1 || y0 > w.height - 1) return null;

    const pal = this.palette;
    const scale = this.bucket;

    let top = Infinity;
    let bottom = -Infinity;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = w.tiles[y * w.width + x];
        if (!t) continue;
        const h = pal.heightPx(t);
        const ny = (x + y) * HALF_H - h;
        if (ny < top) top = ny;
        const b = (x + y) * HALF_H + TILE_H;
        if (b > bottom) bottom = b;
      }
    }
    if (!Number.isFinite(top)) return null;

    const left = (x0 - y1 - 1) * HALF_W - 6;
    const right = (x1 + 1 - y0) * HALF_W + 6;
    top -= 6;
    bottom += 8;

    const mapW = right - left;
    const mapH = bottom - top;
    const canvas = makeCanvas(mapW * scale, mapH * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(scale, 0, 0, scale, -left * scale, -top * scale);
    ctx.imageSmoothingEnabled = true;

    const lowDetail = scale < 0.7;

    for (let s = x0 + y0; s <= x1 + y1; s++) {
      const xs = Math.max(x0, s - y1);
      const xe = Math.min(x1, s - y0);
      for (let x = xs; x <= xe; x++) {
        const y = s - x;
        const t = w.tiles[y * w.width + x];
        if (!t) continue;
        this.drawTile(ctx, w, t, x, y, lowDetail);
      }
    }

    const bytes = canvas.width * canvas.height * 4;
    return {
      key: `${this.bucket}|${cx}|${cy}`,
      cx,
      cy,
      bucket: this.bucket,
      canvas,
      scale,
      x0: left,
      y0: top,
      mapW,
      mapH,
      bytes,
      lastUsed: this.frame,
    };
  }

  private drawTile(
    ctx: CanvasRenderingContext2D,
    w: WorldState,
    t: Tile,
    x: number,
    y: number,
    lowDetail: boolean,
  ): void {
    const pal = this.palette;
    const width = w.width;
    const height = w.height;
    const water = pal.isWaterSurface(t);
    const river = pal.isRiver(t);
    const h = pal.heightPx(t);
    const mx = (x - y) * HALF_W;
    const ny = (x + y) * HALF_H - h;
    const nx = mx;
    const ex = mx + HALF_W;
    const ey = ny + HALF_H;
    const sy = ny + TILE_H;
    const wx = mx - HALF_W;
    const wy = ny + HALF_H;

    // -- neighbours ---------------------------------------------------------
    const nE = x + 1 < width ? w.tiles[y * width + x + 1] : null; // +x, shares E-S
    const nS = y + 1 < height ? w.tiles[(y + 1) * width + x] : null; // +y, shares W-S
    const nW = x - 1 >= 0 ? w.tiles[y * width + x - 1] : null; // -x, shares N-E
    const nN = y - 1 >= 0 ? w.tiles[(y - 1) * width + x] : null; // -y, shares N-W

    const hE = nE ? pal.heightPx(nE) : -38;
    const hS = nS ? pal.heightPx(nS) : -38;

    const sideCol = pal.sideColor(t, x, y, 0);
    const sideCol2 = pal.sideColor(t, x, y, 1);

    // -- south / east cliff faces ------------------------------------------
    const dE = water && nE && pal.hasWater(nE) ? 0 : h - hE;
    if (dE > 0.6) {
      this.drawWall(ctx, ex, ey, nx, sy, dE, sideCol, lowDetail);
    }
    const dS = water && nS && pal.hasWater(nS) ? 0 : h - hS;
    if (dS > 0.6) {
      this.drawWall(ctx, nx, sy, wx, wy, dS, sideCol2, lowDetail);
    }

    // -- top face -----------------------------------------------------------
    if (water) {
      if (river) {
        // river: ground first, then an inset water ribbon leaving muddy banks
        ctx.fillStyle = cssColor(pal.groundColor(t, x, y));
        diamond(ctx, nx, ny);
        ctx.fill();
        const inset = 6;
        ctx.fillStyle = cssColor(pal.waterColor(t, x, y));
        ctx.beginPath();
        ctx.moveTo(nx, ny + inset);
        ctx.lineTo(nx + HALF_W - inset * 0.9, ny + HALF_H);
        ctx.lineTo(nx, ny + TILE_H - inset);
        ctx.lineTo(nx - HALF_W + inset * 0.9, ny + HALF_H);
        ctx.closePath();
        ctx.fill();
      } else {
        ctx.fillStyle = cssColor(pal.waterColor(t, x, y));
        diamond(ctx, nx, ny);
        ctx.fill();
      }
      // depth: a darker band just under the surface edge (fake refraction)
      if (!lowDetail) {
        ctx.strokeStyle = cssColorAlpha(0x0a2030, 0.16);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(nx + HALF_W * 0.55, ny + HALF_H * 1.5);
        ctx.lineTo(nx, ny + TILE_H - 4);
        ctx.lineTo(nx - HALF_W * 0.55, ny + HALF_H * 1.5);
        ctx.stroke();
      }
      // coast foam along edges shared with land
      const foam = pal.foamColor();
      const edges: [number, number, number, number, Tile | null][] = [
        [nx, ny, ex, ey, nW],
        [ex, ey, nx, sy, nE],
        [nx, sy, wx, wy, nS],
        [wx, wy, nx, ny, nN],
      ];
      for (let i = 0; i < 4; i++) {
        const nb = edges[i][4];
        if (!nb || pal.hasWater(nb)) continue;
        const a = 0.34 + hash2(x * 3 + i, y * 5 + i, 71) * 0.34;
        ctx.strokeStyle = cssColorAlpha(foam, a);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(edges[i][0], edges[i][1]);
        ctx.lineTo(edges[i][2], edges[i][3]);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = cssColor(pal.groundColor(t, x, y));
      diamond(ctx, nx, ny);
      ctx.fill();

      // sun rim on the upper edges (subtle painterly light)
      if (!lowDetail) {
        ctx.strokeStyle = cssColorAlpha(0xf5ead0, 0.055);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(nx, ny);
        ctx.lineTo(ex, ey);
        ctx.stroke();
        // contact shadow along the lower edges keeps tiles readable
        ctx.strokeStyle = cssColorAlpha(0x000000, 0.05);
        ctx.beginPath();
        ctx.moveTo(wx, wy);
        ctx.lineTo(nx, sy);
        ctx.lineTo(ex, ey);
        ctx.stroke();
      }

      // wet sand ring where land meets water
      const wetEdges: [number, number, number, number, Tile | null][] = [
        [nx, ny, ex, ey, nW],
        [ex, ey, nx, sy, nE],
        [nx, sy, wx, wy, nS],
        [wx, wy, nx, ny, nN],
      ];
      for (let i = 0; i < 4; i++) {
        const nb = wetEdges[i][4];
        if (!nb || !pal.hasWater(nb)) continue;
        ctx.strokeStyle = cssColorAlpha(0xcbb890, 0.3);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(wetEdges[i][0] - 1, wetEdges[i][1]);
        ctx.lineTo(wetEdges[i][2], wetEdges[i][3] - 1);
        ctx.stroke();
      }

      // fields / worked soil under farm buildings are painted by the sprite layer

      // roads
      if (t.road > 0) this.drawRoad(ctx, t, x, y, nx, ny, w);

      // cliffs: grass lip draped over the top of the wall
      if (!lowDetail) {
        if (dE > 2.5) {
          ctx.fillStyle = cssColor(darkenColor(pal.groundColor(t, x, y), 0.28));
          ctx.beginPath();
          ctx.moveTo(nx, sy);
          ctx.lineTo(ex, ey);
          ctx.lineTo(ex, ey + 3.2);
          ctx.lineTo(nx, sy + 3.2);
          ctx.closePath();
          ctx.fill();
        }
        if (dS > 2.5) {
          ctx.fillStyle = cssColor(darkenColor(pal.groundColor(t, x, y), 0.36));
          ctx.beginPath();
          ctx.moveTo(wx, wy);
          ctx.lineTo(nx, sy);
          ctx.lineTo(nx, sy + 3.2);
          ctx.lineTo(wx, wy + 3.2);
          ctx.closePath();
          ctx.fill();
        }
      }
    }

    // -- subtle tile grid ---------------------------------------------------
    if (this.showGrid && !lowDetail && !water) {
      ctx.strokeStyle = cssColorAlpha(0x2a2418, 0.075);
      ctx.lineWidth = 1;
      diamond(ctx, nx, ny);
      ctx.stroke();
    }
  }

  /** Draw the visible south wall of a tile. */
  private drawWall(
    ctx: CanvasRenderingContext2D,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    depth: number,
    color: number,
    lowDetail: boolean,
  ): void {
    const d = Math.min(depth, 220);
    // main face
    ctx.fillStyle = cssColor(color);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2, y2 + d);
    ctx.lineTo(x1, y1 + d);
    ctx.closePath();
    ctx.fill();
    if (lowDetail) return;
    // upper lit band + strata line gives the cliff volume
    const midY = d * 0.52;
    ctx.fillStyle = cssColorAlpha(0xffffff, 0.06);
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x2, y2 + midY);
    ctx.lineTo(x1, y1 + midY);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = cssColorAlpha(0x000000, 0.16);
    ctx.beginPath();
    ctx.moveTo(x1, y1 + d - Math.min(6, d * 0.25));
    ctx.lineTo(x2, y2 + d - Math.min(6, d * 0.25));
    ctx.lineTo(x2, y2 + d);
    ctx.lineTo(x1, y1 + d);
    ctx.closePath();
    ctx.fill();
  }

  private drawRoad(
    ctx: CanvasRenderingContext2D,
    t: Tile,
    x: number,
    y: number,
    nx: number,
    ny: number,
    w: WorldState,
  ): void {
    const pal = this.palette;
    const grade = clamp(t.road, 0, 1);
    const base = pal.groundColor(t, x, y);
    const roadCol = mixHex(darkenColor(base, 0.18), 0xb09a72, 0.55 + grade * 0.2);
    const width = w.width;
    const height = w.height;
    const has = (dx: number, dy: number): boolean => {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= width || yy >= height) return false;
      const nb = w.tiles[yy * width + xx];
      return !!nb && nb.road > 0;
    };
    const eastRoad = has(1, 0);
    const southRoad = has(0, 1);
    const westRoad = has(-1, 0);
    const northRoad = has(0, -1);

    // inner diamond (the road surface)
    ctx.fillStyle = cssColor(roadCol);
    ctx.beginPath();
    const inset = 9;
    ctx.moveTo(nx, ny + inset);
    ctx.lineTo(nx + HALF_W - inset, ny + HALF_H);
    ctx.lineTo(nx, ny + TILE_H - inset);
    ctx.lineTo(nx - HALF_W + inset, ny + HALF_H);
    ctx.closePath();
    ctx.fill();

    // stubs to connected neighbours
    ctx.strokeStyle = cssColor(roadCol);
    ctx.lineWidth = 9;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    if (eastRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx + HALF_W, ny + HALF_H + HALF_H);
    }
    if (southRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx, ny + HALF_H + HALF_H);
    }
    if (westRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx - HALF_W, ny + HALF_H + HALF_H);
    }
    if (northRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx, ny + HALF_H - HALF_H);
    }
    ctx.stroke();
    // worn centre line
    ctx.strokeStyle = cssColorAlpha(0xe8dcc0, 0.16);
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    if (eastRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx + HALF_W * 0.7, ny + HALF_H + HALF_H * 0.7);
    }
    if (southRoad) {
      ctx.moveTo(nx, ny + HALF_H);
      ctx.lineTo(nx, ny + HALF_H + TILE_H * 0.35);
    }
    ctx.stroke();
  }
}

function diamond(ctx: CanvasRenderingContext2D, nx: number, ny: number): void {
  ctx.beginPath();
  ctx.moveTo(nx, ny);
  ctx.lineTo(nx + HALF_W, ny + HALF_H);
  ctx.lineTo(nx, ny + TILE_H);
  ctx.lineTo(nx - HALF_W, ny + HALF_H);
  ctx.closePath();
}

function mixHex(a: number, b: number, t: number): number {
  const u = clamp(t, 0, 1);
  const ar = (a >>> 16) & 0xff;
  const ag = (a >>> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >>> 16) & 0xff;
  const bg = (b >>> 8) & 0xff;
  const bb = b & 0xff;
  return (((ar + (br - ar) * u) | 0) << 16) | (((ag + (bg - ag) * u) | 0) << 8) | ((ab + (bb - ab) * u) | 0);
}
