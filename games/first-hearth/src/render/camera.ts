/**
 * FIRST HEARTH — isometric camera
 * -------------------------------
 * Owns the pan/zoom transform between map space (isometric "world pixels") and
 * CSS pixel screen space. The renderer sets a single canvas transform from this
 * camera and then draws in map coordinates, which keeps hot paths allocation
 * free.
 *
 * Map space: 1 tile = 64 x 32 px diamond; mapX = (x-y)*32, mapY = (x+y)*16.
 */
import { HALF_H, HALF_W, TILE_H, ELEV_PX, clamp, approach } from './utils';

export const MIN_ZOOM = 0.55;
export const MAX_ZOOM = 2.6;

export class Camera {
  /** Map-space point shown at the centre of the viewport. */
  x = 0;
  y = 0;
  /** Current (eased) zoom. */
  zoom = 1;
  /** Target values used for smooth easing. */
  tx = 0;
  ty = 0;
  tzoom = 1;

  viewW = 1;
  viewH = 1;
  dpr = 1;

  worldW = 1;
  worldH = 1;

  /** Extra margin allowed when clamping so the map edge can rest slightly inside. */
  margin = 96;

  minZoom = MIN_ZOOM;
  maxZoom = MAX_ZOOM;

  setViewport(w: number, h: number, dpr: number): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.dpr = Math.max(1, dpr);
    this.clampTarget();
    this.x = this.tx;
    this.y = this.ty;
  }

  setWorld(w: number, h: number): void {
    this.worldW = Math.max(1, w);
    this.worldH = Math.max(1, h);
    this.clampTarget();
    this.clampCurrent();
  }

  // -- bounds ---------------------------------------------------------------

  private get bounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const w = this.worldW;
    const h = this.worldH;
    const minX = -(h - 1) * HALF_W - HALF_W - this.margin;
    const maxX = (w - 1) * HALF_W + HALF_W + this.margin;
    const minY = -ELEV_PX - this.margin;
    const maxY = (w - 1 + h - 1) * HALF_H + TILE_H + ELEV_PX * 0.4 + this.margin;
    return { minX, maxX, minY, maxY };
  }

  private clampTarget(): void {
    const b = this.bounds;
    this.tzoom = clamp(this.tzoom, this.minZoom, this.maxZoom);
    this.tx = clamp(this.tx, b.minX, b.maxX);
    this.ty = clamp(this.ty, b.minY, b.maxY);
  }

  private clampCurrent(): void {
    const b = this.bounds;
    this.zoom = clamp(this.zoom, this.minZoom, this.maxZoom);
    this.x = clamp(this.x, b.minX, b.maxX);
    this.y = clamp(this.y, b.minY, b.maxY);
  }

  // -- conversions ----------------------------------------------------------

  mapToScreenX(mx: number): number {
    return (mx - this.x) * this.zoom + this.viewW * 0.5;
  }
  mapToScreenY(my: number): number {
    return (my - this.y) * this.zoom + this.viewH * 0.5;
  }
  screenToMapX(sx: number): number {
    return (sx - this.viewW * 0.5) / this.zoom + this.x;
  }
  screenToMapY(sy: number): number {
    return (sy - this.viewH * 0.5) / this.zoom + this.y;
  }

  /** Screen-space position of a tile's flat top-face centre. */
  tileToScreen(x: number, y: number): { x: number; y: number } {
    return {
      x: this.mapToScreenX((x - y) * HALF_W),
      y: this.mapToScreenY((x + y) * HALF_H + HALF_H),
    };
  }

  /** Axis-aligned map-space rectangle currently visible. */
  visibleMap(): { left: number; right: number; top: number; bottom: number } {
    const hw = this.viewW * 0.5 / this.zoom;
    const hh = this.viewH * 0.5 / this.zoom;
    return { left: this.x - hw, right: this.x + hw, top: this.y - hh, bottom: this.y + hh };
  }

  // -- movement -------------------------------------------------------------

  /** Immediate pan by screen pixels (pointer drag). */
  panScreen(dxPx: number, dyPx: number): void {
    this.x -= dxPx / this.zoom;
    this.y -= dyPx / this.zoom;
    this.clampCurrent();
    this.tx = this.x;
    this.ty = this.y;
  }

  /** Eased pan (keyboard), in screen pixels per call. */
  panSmooth(dxPx: number, dyPx: number): void {
    this.tx -= dxPx / this.zoom;
    this.ty -= dyPx / this.zoom;
    this.clampTarget();
    // small keyboard nudges should feel immediate
    this.x = this.tx;
    this.y = this.ty;
  }

  /** Set the camera target straight to map coordinates (used by minimap / debug). */
  moveToMap(mx: number, my: number): void {
    this.tx = mx;
    this.ty = my;
    this.clampTarget();
  }

  /** Centre on a tile. */
  centerOnTile(x: number, y: number, zoom?: number): void {
    this.tx = (x - y) * HALF_W;
    this.ty = (x + y) * HALF_H + HALF_H;
    if (zoom !== undefined && Number.isFinite(zoom)) this.tzoom = clamp(zoom, this.minZoom, this.maxZoom);
    this.clampTarget();
  }

  /** Zoom about a screen point. delta is in wheel "notches" (positive = closer). */
  zoomAtScreen(px: number, py: number, delta: number): void {
    const factor = Math.pow(1.16, clamp(delta, -6, 6));
    const next = clamp(this.tzoom * factor, this.minZoom, this.maxZoom);
    if (Math.abs(next - this.tzoom) < 1e-4) return;
    const mapX = this.screenToMapX(px);
    const mapY = this.screenToMapY(py);
    this.tzoom = next;
    this.tx = mapX - (px - this.viewW * 0.5) / next;
    this.ty = mapY - (py - this.viewH * 0.5) / next;
    this.clampTarget();
  }

  /** Advance easing. dt in seconds. */
  update(dt: number): void {
    if (!(dt > 0)) dt = 1 / 60;
    const k = approach(15, Math.min(0.1, dt));
    this.zoom += (this.tzoom - this.zoom) * k;
    this.x += (this.tx - this.x) * k;
    this.y += (this.ty - this.y) * k;
    if (Math.abs(this.tzoom - this.zoom) < 1e-4) this.zoom = this.tzoom;
    if (Math.abs(this.tx - this.x) < 0.02) this.x = this.tx;
    if (Math.abs(this.ty - this.y) < 0.02) this.y = this.ty;
    this.clampCurrent();
  }

  /** Instantly finish any easing (resize / new game). */
  snap(): void {
    this.x = this.tx;
    this.y = this.ty;
    this.zoom = this.tzoom;
    this.clampCurrent();
  }
}

/**
 * Convert a map-space point to fractional tile coordinates.
 * Returns values where integer bounds are tile edges, matching screenToTile.
 */
export function mapToTileF(mx: number, my: number): { x: number; y: number } {
  const a = mx / HALF_W; // x - y
  const b = (my - HALF_H) / HALF_H; // x + y
  return { x: (a + b) / 2, y: (b - a) / 2 };
}
