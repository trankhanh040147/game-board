/**
 * FIRST HEARTH — minimap
 * ----------------------
 * Draws a small top-down world map into a `<canvas id="minimap">` owned by the
 * UI (created after boot). Terrain is baked once per world/season into an
 * offscreen tile-per-pixel canvas, then composited with fog, roads, settlement
 * dots, markers and the camera viewport. Clicking (or dragging) recentres the
 * world camera.
 */
import type { GameState } from '../sim/types';
import type { Camera } from './camera';
import { mapToTileF } from './camera';
import type { Palette } from './palette';
import { clamp, cssColor, cssColorAlpha, makeCanvas } from './utils';

const REFRESH_MS = 420;

export class Minimap {
  private palette: Palette;
  private onPick: (x: number, y: number) => void;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private lastLookup = 0;
  private lastDraw = 0;
  private lastBake = 0;
  private terrain: HTMLCanvasElement | null = null;
  private terrainKey = '';
  private pointerDown = false;
  private listenerCanvas: HTMLCanvasElement | null = null;
  private frame = 0;

  constructor(palette: Palette, onPick: (x: number, y: number) => void) {
    this.palette = palette;
    this.onPick = onPick;
  }

  private readonly handlePointerDown = (ev: PointerEvent): void => {
    this.pointerDown = true;
    this.pick(ev);
  };
  private readonly handlePointerMove = (ev: PointerEvent): void => {
    if (!this.pointerDown) return;
    this.pick(ev);
  };
  private readonly handlePointerUp = (): void => {
    this.pointerDown = false;
  };

  private attach(canvas: HTMLCanvasElement): void {
    this.detach();
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.listenerCanvas = canvas;
    canvas.addEventListener('pointerdown', this.handlePointerDown);
    canvas.addEventListener('pointermove', this.handlePointerMove);
    window.addEventListener('pointerup', this.handlePointerUp);
    canvas.style.cursor = 'pointer';
    this.lastDraw = 0;
  }

  private detach(): void {
    if (this.listenerCanvas) {
      this.listenerCanvas.removeEventListener('pointerdown', this.handlePointerDown);
      this.listenerCanvas.removeEventListener('pointermove', this.handlePointerMove);
      window.removeEventListener('pointerup', this.handlePointerUp);
    }
    this.listenerCanvas = null;
    this.canvas = null;
    this.ctx = null;
    this.pointerDown = false;
  }

  destroy(): void {
    this.detach();
    this.terrain = null;
  }

  private pick(ev: PointerEvent): void {
    const canvas = this.canvas;
    const state = this.stateRef;
    if (!canvas || !state) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const mx = (ev.clientX - rect.left) / rect.width;
    const my = (ev.clientY - rect.top) / rect.height;
    const w = state.world.width;
    const h = state.world.height;
    // preserve aspect: square-ish fit
    const size = Math.min(rect.width, rect.height);
    const ox = (rect.width - size) / 2;
    const oy = (rect.height - size) / 2;
    const px = (ev.clientX - rect.left - ox) / size;
    const py = (ev.clientY - rect.top - oy) / size;
    if (px < 0 || py < 0 || px > 1 || py > 1) return;
    const tx = clamp(Math.floor(px * w), 0, w - 1);
    const ty = clamp(Math.floor(py * h), 0, h - 1);
    void mx;
    void my;
    this.onPick(tx, ty);
  }

  private stateRef: GameState | null = null;

  /** Call from the render loop; throttled internally. */
  sync(state: GameState, camera: Camera, timeMs: number): void {
    this.stateRef = state;
    if (timeMs - this.lastLookup > 1000) {
      this.lastLookup = timeMs;
      const el = document.getElementById('minimap');
      if (el instanceof HTMLCanvasElement) {
        if (el !== this.canvas) this.attach(el);
      } else if (this.canvas) {
        this.detach();
      }
    }
    if (!this.canvas || !this.ctx) return;
    if (timeMs - this.lastDraw < REFRESH_MS) return;
    this.lastDraw = timeMs;
    this.frame++;
    this.draw(state, camera, timeMs);
  }

  private draw(state: GameState, camera: Camera, timeMs: number): void {
    const canvas = this.canvas;
    const ctx = this.ctx;
    if (!canvas || !ctx) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = canvas.clientWidth || canvas.width || 180;
    const cssH = canvas.clientHeight || canvas.height || 180;
    if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
    }
    const w = state.world.width;
    const h = state.world.height;
    const size = Math.min(cssW, cssH);
    const ox = (cssW - size) / 2;
    const oy = (cssH - size) / 2;

    // -- bake terrain -------------------------------------------------------
    const snowBucket = Math.round(this.palette.snow * 10);
    const key = `${w}x${h}|${this.palette.season}|${snowBucket}|${this.palette.temperature > 0}`;
    if (key !== this.terrainKey || timeMs - this.lastBake > 8000) {
      this.terrainKey = key;
      this.lastBake = timeMs;
      this.bakeTerrain(state);
    }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    // frame
    ctx.fillStyle = '#100d0a';
    ctx.fillRect(ox, oy, size, size);

    if (this.terrain) {
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(this.terrain, ox, oy, size, size);
    }

    // -- fog ---------------------------------------------------------------
    const tiles = state.world.tiles;
    const explored = state.world.explored;
    const px = size / w;
    const py = size / h;
    ctx.fillStyle = 'rgba(10,9,8,0.82)';
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (!explored[row + x]) ctx.fillRect(ox + x * px, oy + y * py, px + 0.6, py + 0.6);
      }
    }

    // -- roads -------------------------------------------------------------
    ctx.fillStyle = 'rgba(201,165,91,0.55)';
    for (let i = 0; i < tiles.length; i++) {
      if (tiles[i].road <= 0) continue;
      const x = i % w;
      const y = (i / w) | 0;
      ctx.fillRect(ox + x * px, oy + y * py, Math.max(1, px), Math.max(1, py));
    }

    // -- settlements -------------------------------------------------------
    for (const st of state.settlements) {
      const color = cssColor(this.palette.settlementColor(st.id));
      const sx = ox + (st.x + 0.5) * px;
      const sy = oy + (st.y + 0.5) * py;
      ctx.beginPath();
      ctx.moveTo(sx, sy - 4.5);
      ctx.lineTo(sx + 4.5, sy);
      ctx.lineTo(sx, sy + 4.5);
      ctx.lineTo(sx - 4.5, sy);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,16,12,0.9)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // -- world markers / expeditions --------------------------------------
    for (const m of state.world.markers) {
      const sx = ox + (m.x + 0.5) * px;
      const sy = oy + (m.y + 0.5) * py;
      ctx.beginPath();
      ctx.arc(sx, sy, 2, 0, Math.PI * 2);
      ctx.fillStyle = m.color || '#e6c47e';
      ctx.fill();
    }
    for (const e of state.exploration.expeditions) {
      const sx = ox + (e.x + 0.5) * px;
      const sy = oy + (e.y + 0.5) * py;
      ctx.beginPath();
      ctx.arc(sx, sy, 2.4, 0, Math.PI * 2);
      ctx.fillStyle = '#b48ad6';
      ctx.fill();
    }

    // -- sites -------------------------------------------------------------
    for (const site of state.world.sites) {
      if (!site.discovered) continue;
      const sx = ox + (site.x + 0.5) * px;
      const sy = oy + (site.y + 0.5) * py;
      ctx.fillStyle = 'rgba(230,196,126,0.85)';
      ctx.fillRect(sx - 1, sy - 1, 2, 2);
    }

    // -- camera viewport ---------------------------------------------------
    const vm = camera.visibleMap();
    const corners: [number, number][] = [
      [vm.left, vm.top],
      [vm.right, vm.top],
      [vm.right, vm.bottom],
      [vm.left, vm.bottom],
    ];
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const tf = mapToTileF(corners[i][0], corners[i][1]);
      const sx = ox + clamp(tf.x, -2, w + 2) * px;
      const sy = oy + clamp(tf.y, -2, h + 2) * py;
      if (i === 0) ctx.moveTo(sx, sy);
      else ctx.lineTo(sx, sy);
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(232,217,190,0.55)';
    ctx.lineWidth = 1.1;
    ctx.stroke();

    // border
    ctx.strokeStyle = 'rgba(201,165,91,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox + 0.5, oy + 0.5, size - 1, size - 1);

    // compass glyph N
    ctx.fillStyle = 'rgba(232,217,190,0.5)';
    ctx.font = '9px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('N', ox + size / 2, oy + 10);
    void this.frame;
  }

  private bakeTerrain(state: GameState): void {
    const w = state.world.width;
    const h = state.world.height;
    const tiles = state.world.tiles;
    if (!this.terrain) this.terrain = makeCanvas(w, h);
    const canvas = this.terrain;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const t = tiles[y * w + x];
        if (!t) continue;
        let c = this.palette.hasWater(t) ? this.palette.waterColor(t, x, y) : this.palette.groundColor(t, x, y);
        // simple shading so relief reads at minimap scale
        c = this.palette.shadeAt(state.world, x, y) > 1.02 ? c : c;
        ctx.fillStyle = cssColor(c);
        ctx.fillRect(x, y, 1, 1);
        if (t.deposit && this.palette.snow < 0.6) {
          ctx.fillStyle = cssColorAlpha(0xe6c47e, 0.35);
          ctx.fillRect(x, y, 1, 1);
        }
      }
    }
    // settlement halo
    for (const st of state.settlements) {
      ctx.fillStyle = cssColorAlpha(this.palette.settlementColor(st.id), 0.5);
      ctx.fillRect(st.x - 1, st.y - 1, 3, 3);
    }
  }
}
