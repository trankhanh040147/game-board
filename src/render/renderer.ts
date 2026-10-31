/**
 * FIRST HEARTH — isometric world renderer
 * =======================================
 * The only class the app touches (`new WorldRenderer(app, canvas)`).
 *
 * Rendering strategy
 * ------------------
 *  • Static terrain is baked into 8x8-tile offscreen chunk canvases at a
 *    zoom-matched resolution (see terrain.ts) — a frame costs a handful of
 *    drawImage calls.
 *  • Everything that moves (water shimmer, trees, buildings, citizens, props)
 *    is drawn per frame in strict isometric depth order from a pre-built
 *    "deco index" bucketed by diagonal (x+y), so only real objects are visited
 *    and nothing is sorted at runtime.
 *  • Buildings, trees, actors and props are cached procedural sprites
 *    (sprites.ts / buildingSprite.ts); no external assets are used.
 *  • Atmosphere (day-night tint, weather, smoke, fireflies, grade) lives in fx.ts.
 *  • Fog of war is a blurred low-resolution mask rebuilt only when the explored
 *    set actually changes.
 *  • The renderer never mutates GameState. It only writes app.view.hoverTile.
 */
import type { GameApp } from '../app';
import type {
  Building,
  BuildingDef,
  Content,
  GameState,
  OverlayMode,
  SiteKind,
  Tile,
  WorldState,
} from '../sim/types';
import { seasonOf } from '../sim/core';
import { Camera, mapToTileF } from './camera';
import { Palette, type TreeSpecies } from './palette';
import { Terrain } from './terrain';
import { SpriteBank, type BuildingSprite, type Sprite } from './sprites';
import { drawScaffold } from './buildingSprite';
import { Fx, type SmokeEmitter } from './fx';
import { Minimap } from './minimap';
import {
  CHUNK_TILES,
  HALF_H,
  HALF_W,
  TILE_H,
  clamp,
  clamp01,
  cssColor,
  cssColorAlpha,
  diamondPath,
  fbm2,
  hash2,
  hashInt,
  lightenColor,
  makeCanvas,
  mixColor,
  pointInDiamond,
} from './utils';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DECO_TREE = 0;
const DECO_STUMP = 1;
const DECO_WATER = 2;
const DECO_DEPOSIT = 3;
const DECO_SITE = 4;
const DECO_BUILDING = 5;

const SPECIES: TreeSpecies[] = ['oak', 'pine', 'willow', 'acacia', 'palm', 'reed', 'bush', 'snag'];
const SPECIES_KEYS: Record<string, number> = {};
for (let i = 0; i < SPECIES.length; i++) SPECIES_KEYS[SPECIES[i]] = i;

const SITE_KINDS: SiteKind[] = ['ruin', 'shrine', 'grove', 'spring', 'cave', 'crater', 'wreck', 'observatory', 'wonder'];

const MAX_ACTORS = 92;
const FOG_SCALE = 1 / 6;
const OVERLAY_STEPS = 12;

interface DecoEntry {
  x: number;
  y: number;
  mx: number;
  my: number;
  kind: number;
  sub: number;
  imp: number;
  phase: number;
  color: number;
  ref: number;
}

interface Actor {
  id: number;
  cls: string;
  sex: 'm' | 'f';
  hx: number;
  hy: number;
  wx: number;
  wy: number;
  phase: number;
  speed: number;
  seed: number;
}

interface Critter {
  kind: 'deer';
  x: number;
  y: number;
  tx: number;
  ty: number;
  phase: number;
  speed: number;
  variant: number;
  timer: number;
}

interface WildBird {
  x: number;
  y: number;
  cx: number;
  cy: number;
  radius: number;
  angle: number;
  speed: number;
  frame: number;
  timer: number;
}

interface Label {
  mx: number;
  my: number;
  text: string;
  color: string;
  sub?: string;
  scale: number;
}

interface FogMask {
  canvas: HTMLCanvasElement;
  temp: HTMLCanvasElement;
  mapX: number;
  mapY: number;
  mapW: number;
  mapH: number;
  hash: number;
}

interface RenderStats {
  frames: number;
  frameMs: number;
  fps: number;
  decos: number;
  chunks: number;
  bakeCount: number;
  actors: number;
  particles: number;
  zoom: number;
}

interface DragState {
  active: boolean;
  button: number;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  moved: boolean;
  pointerId: number;
}

const FOOTPRINT_2: [number, number][] = [
  [0, 0],
  [1, 0],
  [0, 1],
  [1, 1],
];

// ---------------------------------------------------------------------------
// WorldRenderer
// ---------------------------------------------------------------------------

export class WorldRenderer {
  readonly app: GameApp;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;

  private cam = new Camera();
  private palette: Palette;
  private terrain: Terrain;
  private bank: SpriteBank;
  private fx: Fx;
  private minimap: Minimap;

  private dpr = 1;
  private viewW = 1;
  private viewH = 1;
  private rect = { left: 0, top: 0, width: 1, height: 1 };

  private overlay: OverlayMode = 'none';
  private lastState: GameState | null = null;
  private lastWorld: WorldState | null = null;
  private lastTime = 0;
  private frameMsAvg = 16;
  private frameCount = 0;
  private warned = false;

  // deco index
  private decoByS: DecoEntry[][] = [];
  private decoTotal = 0;
  private decoDirty = true;
  private decoTimer = 0;
  private decoHash = 0;
  private roadsHash = 0;
  private lastBakedRoadsHash = -1;
  private quality = 1;

  // buildings lookup
  private buildingMap = new Map<number, Building>();
  private buildingKey = '';

  // actors
  private actors: Actor[] = [];
  private actorTimer = 0;
  private critters: Critter[] = [];
  private critterTimer = 0;
  private birds: WildBird[] = [];

  // effect emitters
  private emitters: SmokeEmitter[] = [];
  private labels: Label[] = [];

  // fog
  private fog: FogMask | null = null;
  private fogHash = 0;
  private fogTimer = 0;

  // input
  private drag: DragState = { active: false, button: 0, startX: 0, startY: 0, lastX: 0, lastY: 0, moved: false, pointerId: -1 };
  private keys = new Set<string>();
  private pinchDist = 0;
  private hoverPx = -1;
  private hoverPy = -1;
  private pointerInside = false;

  // debug
  /** Debug toggles used by QA/screenshots. */
  fogEnabled = true;
  cloudsEnabled = true;
  private dayPhaseOverride: number | null = null;
  private stats: RenderStats = {
    frames: 0,
    frameMs: 0,
    fps: 60,
    decos: 0,
    chunks: 0,
    bakeCount: 0,
    actors: 0,
    particles: 0,
    zoom: 1,
  };
  private resizeObserver: ResizeObserver | null = null;

  constructor(app: GameApp, canvas: HTMLCanvasElement) {
    this.app = app;
    this.canvas = canvas;
    this.palette = new Palette(app.content);
    this.bank = new SpriteBank(this.palette);
    this.terrain = new Terrain(this.palette);
    this.fx = new Fx(this.palette, this.bank);
    this.minimap = new Minimap(this.palette, (x, y) => this.centerOnTile(x, y));

    this.ctx = canvas.getContext('2d', { alpha: false });
    this.resize();

    const cap = app.state.settlements.find((s) => s.isCapital) ?? app.state.settlements[0];
    const cx = cap?.x ?? app.state.world.startX;
    const cy = cap?.y ?? app.state.world.startY;
    this.cam.setWorld(app.state.world.width, app.state.world.height);
    this.cam.centerOnTile(cx, cy, 0.92);
    this.cam.snap();

    this.attachInput();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(canvas);
    }
  }

  // ==================================================================
  // Public API (contract with app.ts)
  // ==================================================================

  /** Spec-compliant `camera` accessor. */
  get camera(): { x: number; y: number; zoom: number } {
    return { x: this.cam.x, y: this.cam.y, zoom: this.cam.zoom };
  }

  get debugStats(): RenderStats {
    return this.stats;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const cssW = Math.max(1, Math.round(rect.width));
    const cssH = Math.max(1, Math.round(rect.height));
    this.rect = { left: rect.left, top: rect.top, width: cssW, height: cssH };
    this.dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    this.viewW = cssW;
    this.viewH = cssH;
    const pxW = Math.max(1, Math.round(cssW * this.dpr));
    const pxH = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== pxW || this.canvas.height !== pxH) {
      this.canvas.width = pxW;
      this.canvas.height = pxH;
    }
    this.cam.setViewport(cssW, cssH, this.dpr);
  }

  screenToTile(px: number, py: number): { x: number; y: number } | null {
    const state = this.app.state;
    if (!state) return null;
    return this.pickGroundTile(px, py);
  }

  tileToScreen(x: number, y: number): { x: number; y: number } {
    const t = this.tileAt(x, y);
    const h = t ? this.palette.heightPx(t) : 0;
    return {
      x: this.cam.mapToScreenX((x - y) * HALF_W),
      y: this.cam.mapToScreenY((x + y) * HALF_H + HALF_H - h),
    };
  }

  centerOnTile(x: number, y: number, zoom?: number): void {
    this.cam.centerOnTile(x, y, zoom);
  }

  zoomAt(px: number, py: number, delta: number): void {
    this.cam.zoomAtScreen(px, py, delta);
  }

  pan(dx: number, dy: number): void {
    this.cam.panScreen(dx, dy);
  }

  invalidateTerrain(tiles?: number[]): void {
    if (!tiles || !tiles.length) {
      this.terrain.clear();
      this.decoDirty = true;
      return;
    }
    this.terrain.invalidateTiles(tiles);
    this.decoDirty = true;
  }

  setOverlay(mode: OverlayMode): void {
    this.overlay = mode;
  }

  /** Legend data for the UI (optional convenience; UI may render its own). */
  getOverlayLegend(): { mode: OverlayMode; label: string; steps: { label: string; color: string; hint: string }[] } | null {
    const label = this.palette.overlayLabel(this.overlay);
    if (!label) return null;
    const steps = this.palette.overlayLegend(this.overlay);
    if (!steps) return null;
    return { mode: this.overlay, label, steps };
  }

  /** Debug hook for screenshots: pin the sky to a fixed time of day (0..1). */
  setDayPhaseOverride(phase: number | null): void {
    this.dayPhaseOverride = phase;
  }

  destroy(): void {
    this.detachInput();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.minimap.destroy();
    this.terrain.clear();
    this.fog = null;
    this.bank.reset();
    this.ctx = null;
  }

  // ==================================================================
  // Main loop
  // ==================================================================

  render(timeMs: number): void {
    const ctx = this.ctx;
    const app = this.app;
    const state = app?.state;
    if (!ctx || !state || !state.world) return;
    try {
      this.renderFrame(ctx, state, timeMs);
    } catch (err) {
      if (!this.warned) {
        this.warned = true;
        console.warn('[render] frame failed', err);
      }
    }
  }

  private renderFrame(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const dtMs = this.lastTime ? Math.min(120, Math.max(0, timeMs - this.lastTime)) : 16.7;
    this.lastTime = timeMs;
    const dt = dtMs / 1000;
    this.frameMsAvg = this.frameMsAvg * 0.92 + dtMs * 0.08;
    this.frameCount++;
    this.stats.frameMs = Math.round(this.frameMsAvg * 10) / 10;
    this.stats.fps = Math.round(1000 / Math.max(1, this.frameMsAvg));
    // adaptive detail: back off tree density / particles if we are slow
    const targetQuality = this.frameMsAvg > 26 ? 0.55 : this.frameMsAvg > 20 ? 0.78 : 1;
    this.quality += (targetQuality - this.quality) * 0.05;

    const world = state.world;
    if (state !== this.lastState) {
      this.lastState = state;
      this.onStateSwapped(state);
    }
    if (world !== this.lastWorld) {
      this.lastWorld = world;
      this.terrain.setWorld(world);
      this.cam.setWorld(world.width, world.height);
      this.decoDirty = true;
      this.fog = null;
      this.fogHash = 0;
      this.actors.length = 0;
      this.decoHash = 0;
      this.lastBakedRoadsHash = -1;
    }

    // -- season / weather resolve ----------------------------------------
    const season = seasonOf(state.tick) ?? (world.weather?.season ?? 'summer');
    const weather = world.weather;
    const changed = this.palette.setConditions(
      season,
      weather?.snow ?? 0,
      weather?.temperature ?? 14,
      weather?.rainfall ?? 0,
      weather?.storm ?? 0,
    );
    if (changed) {
      this.terrain.clear();
      this.bank.setSeason(season, weather?.snow ?? 0);
      this.decoDirty = true;
      this.fog = null;
    }

    // -- camera ------------------------------------------------------------
    this.applyKeyboardPan(dt);
    this.cam.update(dt);
    this.stats.zoom = Math.round(this.cam.zoom * 100) / 100;

    const texel = clamp(this.cam.zoom * this.dpr, 0.5, 2.4);
    this.terrain.setBucket(pickBucket(texel));
    this.terrain.setShowGrid(!!this.app.view?.showGrid);
    this.bank.setBuildingScale(Math.round(clamp(this.cam.zoom * this.dpr, 1, 2.6) * 4) / 4);
    this.bank.setSeason(season, weather?.snow ?? 0);

    // -- indexes -----------------------------------------------------------
    this.refreshBuildingMap(state);
    this.decoTimer -= dt;
    if (this.decoDirty || this.decoTimer <= 0) {
      this.rebuildDeco(state, world);
      this.decoDirty = false;
      this.decoTimer = 2.2;
    }
    this.actorTimer -= dt;
    if (this.actorTimer <= 0) {
      this.actorTimer = 1.8;
      this.rebuildActors(state);
    }
    this.critterTimer -= dt;
    if (this.critterTimer <= 0) {
      this.critterTimer = 4.5;
      this.rebuildCritters(state);
    }
    this.fx.setSettings(state.settings);

    // -- drawing -----------------------------------------------------------
    const W = this.viewW;
    const H = this.viewH;
    const dpr = this.dpr;
    this.drawBackground(ctx, W, H);

    // world transform: map pixels -> device pixels
    const z = this.cam.zoom;
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W * 0.5 - this.cam.x * z), dpr * (H * 0.5 - this.cam.y * z));
    ctx.imageSmoothingEnabled = true;
    ctx.lineJoin = 'round';

    this.drawWorldSlab(ctx, world);
    this.terrain.draw(ctx, this.cam, 6, { showGrid: !!this.app.view?.showGrid });

    if (this.overlay !== 'none') this.drawOverlay(ctx, state, world);

    // dynamic world objects in strict depth order
    this.labels.length = 0;
    this.emitters.length = 0;
    this.drawDeco(ctx, state, world, timeMs, dt);

    // entities that move between tiles
    this.drawCritters(ctx, state, timeMs, dt);
    this.drawActors(ctx, state, timeMs, dt);
    this.drawCaravans(ctx, state, timeMs);
    this.drawExpeditions(ctx, state, timeMs);
    this.drawMarkers(ctx, state, timeMs);

    // ambient tint + lights
    const phase = this.dayPhaseOverride ?? this.palette.dayPhase(timeMs);
    const amb = this.palette.ambient(phase);

    // advance the atmosphere (smoke plumes now know where the chimneys are)
    this.fx.update(dt, world, weather, this.cam, timeMs, this.emitters);
    if (this.cloudsEnabled) this.fx.drawClouds(ctx, world, amb, timeMs);

    // fog of war
    this.updateFog(state, world, dtMs);
    if (this.fogEnabled && this.fog) this.drawFogLayer(ctx, world);

    // sky / grade
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fx.drawAmbient(ctx, W, H, phase);

    // glowing things cut through the darkness
    ctx.setTransform(dpr * z, 0, 0, dpr * z, dpr * (W * 0.5 - this.cam.x * z), dpr * (H * 0.5 - this.cam.y * z));
    this.drawNightLights(ctx, state, timeMs, amb.nightness);
    this.fx.drawSmoke(ctx);
    this.fx.drawFireflies(ctx, amb.nightness, timeMs);

    // selection / build ghost / claim boundaries sit above the tint
    this.drawSelection(ctx, state, timeMs);
    this.drawBuildGhost(ctx, state, timeMs);

    // screen-space finishes
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.fx.drawWeather(ctx, W, H, timeMs);
    this.fx.drawGrade(ctx, W, H, dpr);
    this.drawScreenLabels(ctx, state);

    // minimap (throttled internally)
    this.minimap.sync(state, this.cam, timeMs);

    this.stats.decos = this.decoTotal;
    this.stats.chunks = this.terrain.chunkCount;
    this.stats.bakeCount = this.terrain.bakeCount;
    this.stats.actors = this.actors.length;
    this.stats.particles = this.fx.particleCount;
    (this as unknown as { _quality?: number })._quality = this.quality;
  }

  // ==================================================================
  // State lifecycle
  // ==================================================================

  private onStateSwapped(state: GameState): void {
    this.terrain.setWorld(state.world);
    this.cam.setWorld(state.world.width, state.world.height);
    this.decoDirty = true;
    this.decoHash = 0;
    this.lastBakedRoadsHash = -1;
    this.fog = null;
    this.fogHash = 0;
    this.actors.length = 0;
    this.critters.length = 0;
    this.buildingKey = '';
    this.buildingMap.clear();
    this.fx.reset();
    this.lastWorld = state.world;
    const cap = state.settlements.find((s) => s.isCapital) ?? state.settlements[0];
    if (cap) this.cam.centerOnTile(cap.x, cap.y, this.cam.tzoom);
    else this.cam.centerOnTile(state.world.startX, state.world.startY, 1);
  }

  // ==================================================================
  // Indexing
  // ==================================================================

  private tileAt(x: number, y: number): Tile | null {
    const w = this.lastWorld ?? this.app.state?.world;
    if (!w) return null;
    if (x < 0 || y < 0 || x >= w.width || y >= w.height) return null;
    return w.tiles[y * w.width + x] ?? null;
  }

  private refreshBuildingMap(state: GameState): void {
    let key = String(state.buildings.length) + ':';
    for (let i = 0; i < state.buildings.length; i += 1) key += state.buildings[i].id.toString(36) + (i % 7 === 0 ? ',' : '');
    if (key === this.buildingKey) return;
    this.buildingKey = key;
    this.buildingMap.clear();
    for (const b of state.buildings) this.buildingMap.set(b.id, b);
  }

  private rebuildDeco(state: GameState, world: WorldState): void {
    const n = world.width + world.height;
    if (this.decoByS.length !== n) {
      this.decoByS = new Array(n);
      for (let i = 0; i < n; i++) this.decoByS[i] = [];
    } else {
      for (let i = 0; i < n; i++) this.decoByS[i].length = 0;
    }
    let total = 0;
    let roadsHash = 0;
    let exploredCount = 0;
    const explored = world.explored;
    const tiles = world.tiles;
    const w = world.width;
    const h = world.height;
    const pal = this.palette;

    // Tiles within one step of a building become a clearing: this is what makes
    // a settlement readable inside a forest.
    const clearing = new Uint8Array(tiles.length);
    for (const b of state.buildings) {
      const def = this.app.content.buildings[b.typeId];
      const size = def?.size ?? 1;
      for (let dy = -1; dy <= size; dy++) {
        for (let dx = -1; dx <= size; dx++) {
          const xx = b.x + dx;
          const yy = b.y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          clearing[yy * w + xx] = 1;
        }
      }
    }

    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const idx = row + x;
        const t = tiles[idx];
        if (!t) continue;
        if (explored[idx]) exploredCount++;
        roadsHash = (roadsHash * 31 + (t.road > 0 ? 1 : 0)) | 0;
        const s = x + y;
        const bucket = this.decoByS[s];
        const water = pal.isWaterSurface(t);
        const river = pal.isRiver(t);
        const hgt = pal.heightPx(t);
        const mx = (x - y) * HALF_W;
        const my = (x + y) * HALF_H + HALF_H - hgt;
        const seen = explored[idx] === 1;

        if (water || river) {
          // water entries drive the animated shimmer / sparkle pass
          if (seen) {
            bucket.push({ x, y, mx, my, kind: DECO_WATER, sub: water ? 1 : 0, imp: 0.9, phase: hash2(x, y, 401), color: 0, ref: -1 });
            total++;
          }
        } else if (seen) {
          const forest = t.forest ?? 0;
          // clump the canopy with low-frequency noise so forests have thickets,
          // glades and edges instead of an even tree carpet
          const clump = fbm2(x * 0.085 + 13, y * 0.085 + 29, 311);
          const thicket = clamp01(forest * (0.32 + 1.35 * clump));
          const cleared = clearing[idx] === 1 || t.buildingId >= 0 || t.road > 0;
          if (thicket > 0.22 && !cleared) {
            const species = pal.treeSpecies(t);
            const speciesIdx = SPECIES_KEYS[species] ?? 0;
            let count = 1;
            if (thicket > 0.8) count = 3;
            else if (thicket > 0.5) count = 2;
            const imp = clamp01(thicket);
            for (let k = 0; k < count; k++) {
              const hv = hash2(x * 7 + k * 13, y * 5 + k * 3, 97);
              const ox = (hv - 0.5) * 20;
              const oy = (hash2(x * 3 + k, y * 11 + k * 5, 53) - 0.5) * 11;
              const sizeClass = hv > 0.72 ? 2 : hv > 0.3 ? 1 : 0;
              const variant = Math.floor(hash2(x + k, y - k, 71) * 3);
              bucket.push({
                x,
                y,
                mx: mx + ox,
                my: my + oy,
                kind: DECO_TREE,
                sub: speciesIdx * 9 + variant * 3 + sizeClass,
                imp,
                phase: hash2(x * 5 + k, y * 3 + k, 19),
                color: 0,
                ref: -1,
              });
              total++;
            }
          } else if (forest <= 0.09 && (pal.style(t).def?.forest ?? 0) > 0.45 && !cleared && hash2(x, y, 211) > 0.45) {
            // depleted forest: stumps & brash
            const speciesIdx = SPECIES_KEYS[pal.treeSpecies(t)] ?? 0;
            bucket.push({ x, y, mx, my, kind: DECO_STUMP, sub: speciesIdx, imp: 0.5, phase: hash2(x, y, 29), color: 0, ref: -1 });
            total++;
          }
          // deposits / outcrops
          if (t.deposit && t.buildingId < 0) {
            const res = this.app.content.resources[t.deposit.resource];
            const color = res ? hexLike(res.color) : 0xc9a55b;
            const richness = clamp01((t.deposit.amount ?? 1) / Math.max(1, t.deposit.initial ?? 1));
            const sizeClass = richness > 0.6 ? 2 : richness > 0.3 ? 1 : 0;
            bucket.push({ x, y, mx, my, kind: DECO_DEPOSIT, sub: sizeClass, imp: 0.8, phase: hash2(x, y, 7), color, ref: -1 });
            total++;
          }
          // sites
          if (t.siteIndex >= 0) {
            const site = world.sites[t.siteIndex];
            if (site && site.discovered) {
              const def = this.app.content.sites[site.defId];
              const kindIdx = SITE_KINDS.indexOf((def?.kind ?? 'ruin') as SiteKind);
              const color = def ? hexLike(def.color) : 0xe6c47e;
              bucket.push({
                x,
                y,
                mx,
                my,
                kind: DECO_SITE,
                sub: kindIdx >= 0 ? kindIdx : 0,
                imp: 1,
                phase: hash2(x, y, 13),
                color,
                ref: site.visited ? 1 : 0,
              });
              total++;
            }
          }
        }
      }
    }

    // buildings are anchored on their own tile for depth ordering
    for (const b of state.buildings) {
      if (b.x < 0 || b.y < 0 || b.x >= w || b.y >= h) continue;
      const def = this.app.content.buildings[b.typeId];
      if (!def) continue;
      const idx = b.y * w + b.x;
      if (!explored[idx]) continue;
      const t = tiles[idx];
      if (!t) continue;
      const hgt = this.buildingBaseHeight(state, b, def);
      const s = clamp(b.x + b.y, 0, n - 1);
      this.decoByS[s].push({
        x: b.x,
        y: b.y,
        mx: (b.x - b.y) * HALF_W,
        my: (b.x + b.y) * HALF_H - hgt,
        kind: DECO_BUILDING,
        sub: 0,
        imp: 1,
        phase: hash2(b.x, b.y, 17),
        color: 0,
        ref: b.id,
      });
      total++;
    }

    for (let i = 0; i < n; i++) this.decoByS[i].sort((a, b) => a.x - b.x || a.kind - b.kind);
    this.decoTotal = total;
    this.decoHash = exploredCount * 2654435761 + roadsHash;
    if (roadsHash !== this.lastBakedRoadsHash) {
      this.lastBakedRoadsHash = roadsHash;
      this.terrain.clear();
    }
  }

  private buildingBaseHeight(state: GameState, b: Building, def: BuildingDef): number {
    const world = state.world;
    let best = 0;
    const size = def.size ?? 1;
    for (let dy = 0; dy < size; dy++) {
      for (let dx = 0; dx < size; dx++) {
        const t = this.tileAt(b.x + dx, b.y + dy);
        if (!t) continue;
        const h = this.palette.heightPx(t);
        if (h > best) best = h;
      }
    }
    return best;
  }

  private rebuildActors(state: GameState): void {
    this.actors.length = 0;
    const citizens = state.citizens;
    if (!citizens.length) return;
    const step = Math.max(1, Math.floor(citizens.length / 260));
    const start = citizens.length > 0 ? hashInt(state.tick + 7) * citizens.length : 0;
    for (let i = 0; i < citizens.length && this.actors.length < MAX_ACTORS; i++) {
      const c = citizens[((Math.floor(start) + i * step) % citizens.length + citizens.length) % citizens.length];
      if (!c || !c.alive) continue;
      const home = this.buildingMap.get(c.homeBuildingId);
      const work = this.buildingMap.get(c.jobBuildingId);
      const st = state.settlements.find((s) => s.id === c.settlementId);
      if (!st) continue;
      const prof = this.app.content.professions[c.profession as string];
      const cls = prof?.class ?? (c.profession === 'child' || c.profession === 'student' ? 'child' : 'laborer');
      const classId = c.profession === 'child' ? 'child' : cls;
      const homeX = home ? home.x + 0.5 : st.x + (hash2(c.id, 3, 5) - 0.5) * 1.6;
      const homeY = home ? home.y + 0.6 : st.y + (hash2(c.id, 7, 9) - 0.5) * 1.6;
      const workX = work ? work.x + 0.5 : st.x + (hash2(c.id, 11, 13) - 0.5) * 3;
      const workY = work ? work.y + 0.6 : st.y + (hash2(c.id, 17, 19) - 0.5) * 3;
      this.actors.push({
        id: c.id,
        cls: classId,
        sex: c.sex,
        hx: homeX,
        hy: homeY,
        wx: workX,
        wy: workY,
        phase: hash2(c.id, 23, 29),
        speed: 0.045 + hash2(c.id, 31, 37) * 0.05,
        seed: c.id,
      });
    }
  }

  private rebuildCritters(state: GameState): void {
    this.critters.length = 0;
    this.birds.length = 0;
    const world = state.world;
    const vm = this.cam.visibleMap();
    const tf0 = mapToTileF(vm.left - 300, vm.top - 300);
    const tf1 = mapToTileF(vm.right + 300, vm.bottom + 300);
    const x0 = clamp(Math.floor(Math.min(tf0.x, tf1.x)), 0, world.width - 1);
    const x1 = clamp(Math.ceil(Math.max(tf0.x, tf1.x)), 0, world.width - 1);
    const y0 = clamp(Math.floor(Math.min(tf0.y, tf1.y)), 0, world.height - 1);
    const y1 = clamp(Math.ceil(Math.max(tf0.y, tf1.y)), 0, world.height - 1);
    let tries = 0;
    while (this.critters.length < 7 && tries < 90) {
      tries++;
      const x = x0 + Math.floor(hash2(tries, this.frameCount, 3) * (x1 - x0 + 1));
      const y = y0 + Math.floor(hash2(tries, this.frameCount, 11) * (y1 - y0 + 1));
      const idx = y * world.width + x;
      const t = world.tiles[idx];
      if (!t || !world.explored[idx]) continue;
      if (this.palette.hasWater(t) || t.buildingId >= 0) continue;
      if (t.wildlife < 0.35) continue;
      this.critters.push({
        kind: 'deer',
        x: x + 0.5,
        y: y + 0.5,
        tx: x + 0.5 + (hash2(tries, 7, 3) - 0.5) * 3,
        ty: y + 0.5 + (hash2(tries, 13, 5) - 0.5) * 3,
        phase: hash2(tries, 17, 7),
        speed: 0.08 + hash2(tries, 19, 9) * 0.1,
        variant: Math.floor(hash2(tries, 23, 11) * 4),
        timer: hash2(tries, 29, 13) * 4,
      });
    }
    const birdCount = 2;
    for (let f = 0; f < birdCount; f++) {
      const cx = (vm.left + vm.right) * 0.5 + (hash2(f, 3, 17) - 0.5) * 600;
      const cy = (vm.top + vm.bottom) * 0.5 + (hash2(f, 5, 19) - 0.5) * 300;
      for (let i = 0; i < 5; i++) {
        this.birds.push({
          x: cx,
          y: cy,
          cx,
          cy,
          radius: 70 + i * 22,
          angle: (i / 5) * Math.PI * 2 + f,
          speed: 0.35 + f * 0.12,
          frame: i % 4,
          timer: 0,
        });
      }
    }
  }

  // ==================================================================
  // Drawing helpers
  // ==================================================================

  private drawBackground(ctx: CanvasRenderingContext2D, W: number, H: number): void {
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = '#0d0b08';
    ctx.fillRect(0, 0, W, H);
    const cx = W * 0.5;
    const cy = H * 0.42;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.72);
    g.addColorStop(0, '#241d14');
    g.addColorStop(0.55, '#191309');
    g.addColorStop(1, '#0d0a07');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  private drawWorldSlab(ctx: CanvasRenderingContext2D, world: WorldState): void {
    const w = world.width;
    const h = world.height;
    // the map sits on a dark slab so the world edge reads like a table map
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(w * HALF_W, w * HALF_H);
    ctx.lineTo((w - h) * HALF_W, (w + h) * HALF_H);
    ctx.lineTo(-h * HALF_W, h * HALF_H);
    ctx.closePath();
    ctx.fillStyle = cssColorAlpha(0x0a0806, 0.9);
    ctx.fill();
    ctx.strokeStyle = cssColorAlpha(0xc9a55b, 0.09);
    ctx.lineWidth = 2;
    ctx.stroke();
    // outer glow ring
    ctx.strokeStyle = cssColorAlpha(0x8a6a3a, 0.12);
    ctx.lineWidth = 10;
    ctx.stroke();
  }

  // -- deco pass -----------------------------------------------------------

  private drawDeco(ctx: CanvasRenderingContext2D, state: GameState, world: WorldState, timeMs: number, dt: number): void {
    const z = this.cam.zoom;
    const vm = this.cam.visibleMap();
    const mLeft = vm.left - 160;
    const mRight = vm.right + 160;
    const mTop = vm.top - 280;
    const mBottom = vm.bottom + 80;
    const sMin = clamp(Math.floor((vm.top - 320) / HALF_H), 0, this.decoByS.length - 1);
    const sMax = clamp(Math.ceil((vm.bottom + 100) / HALF_H), 0, this.decoByS.length - 1);
    const season = this.palette.season;
    const reducedMotion = !!state.settings?.reducedMotion;
    const quality = this.quality;
    const waterLod = z >= 0.7;
    let drawn = 0;

    for (let s = sMin; s <= sMax; s++) {
      const bucket = this.decoByS[s];
      if (!bucket || !bucket.length) continue;
      for (let i = 0; i < bucket.length; i++) {
        const e = bucket[i];
        if (e.mx < mLeft || e.mx > mRight || e.my < mTop || e.my > mBottom) continue;
        switch (e.kind) {
          case DECO_WATER: {
            if (!waterLod) break;
            this.drawWaterSparkle(ctx, e, timeMs, reducedMotion);
            drawn++;
            break;
          }
          case DECO_TREE: {
            if (e.imp * quality < 0.16) break;
            const speciesIdx = (e.sub / 9) | 0;
            const rest = e.sub - speciesIdx * 9;
            const variant = (rest / 3) | 0;
            const sizeClass = rest - variant * 3;
            const spr = this.bank.tree(SPECIES[speciesIdx] ?? 'oak', variant, sizeClass, season);
            if (!spr) break;
            const anchorX = e.mx;
            const anchorY = e.my;
            if (!reducedMotion && z > 1.0) {
              const sway = Math.sin(timeMs * 0.0011 + e.phase * 6.283) * 0.02;
              ctx.save();
              ctx.translate(anchorX, anchorY);
              ctx.rotate(sway);
              ctx.drawImage(spr.canvas, spr.x0, spr.y0, spr.mapW, spr.mapH);
              ctx.restore();
            } else {
              ctx.drawImage(spr.canvas, anchorX + spr.x0, anchorY + spr.y0, spr.mapW, spr.mapH);
            }
            drawn++;
            break;
          }
          case DECO_STUMP: {
            const spr = this.bank.stump(SPECIES[e.sub] ?? 'oak', season);
            ctx.drawImage(spr.canvas, e.mx + spr.x0, e.my + spr.y0, spr.mapW, spr.mapH);
            drawn++;
            break;
          }
          case DECO_DEPOSIT: {
            const spr = this.bank.deposit(e.color, e.sub);
            ctx.drawImage(spr.canvas, e.mx + spr.x0, e.my + spr.y0, spr.mapW, spr.mapH);
            drawn++;
            break;
          }
          case DECO_SITE: {
            const kind = SITE_KINDS[e.sub] ?? 'ruin';
            const spr = this.bank.site(kind, e.color);
            const pulse = 0.5 + 0.5 * Math.sin(timeMs * 0.0016 + e.phase * 6.283);
            // soft aura for unvisited sites
            if (e.ref === 0) {
              const glow = this.bank.glow(e.color);
              const gsize = 46;
              ctx.globalAlpha = 0.1 + pulse * 0.1;
              ctx.drawImage(glow.canvas, e.mx - gsize / 2, e.my - gsize * 0.4, gsize, gsize);
              ctx.globalAlpha = 1;
            }
            ctx.drawImage(spr.canvas, e.mx + spr.x0, e.my + spr.y0, spr.mapW, spr.mapH);
            drawn++;
            break;
          }
          case DECO_BUILDING: {
            const b = this.buildingMap.get(e.ref);
            if (!b) break;
            const def = this.app.content.buildings[b.typeId];
            if (!def) break;
            this.drawBuilding(ctx, state, b, def, e, timeMs, dt, reducedMotion);
            drawn++;
            break;
          }
          default:
            break;
        }
      }
    }
    this.stats.decos = drawn;
  }

  private drawWaterSparkle(ctx: CanvasRenderingContext2D, e: DecoEntry, timeMs: number, reducedMotion: boolean): void {
    if (reducedMotion) return;
    const t = timeMs * 0.001;
    const a = t * 0.8 + e.phase * 6.283;
    const s1 = Math.sin(a);
    const s2 = Math.sin(a * 1.7 + 2.1);
    const alpha = 0.09 + 0.13 * (s1 * 0.5 + 0.5);
    if (alpha <= 0.02) return;
    const wobX = Math.cos(a * 0.7) * 7;
    const wobY = Math.sin(a * 1.3) * 2.4;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = cssColorAlpha(0xeaf6fa, 1);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(e.mx - 9 + wobX, e.my + wobY);
    ctx.quadraticCurveTo(e.mx + wobX, e.my - 2.2 + wobY, e.mx + 9 + wobX, e.my + wobY);
    ctx.stroke();
    if (s2 > 0.55) {
      ctx.globalAlpha = alpha * 0.8;
      ctx.beginPath();
      ctx.moveTo(e.mx - 4 - wobX * 0.5, e.my + 5 + wobY);
      ctx.quadraticCurveTo(e.mx - wobX * 0.4, e.my + 3 + wobY, e.mx + 5 - wobX * 0.5, e.my + 5.4 + wobY);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  private drawBuilding(
    ctx: CanvasRenderingContext2D,
    state: GameState,
    b: Building,
    def: BuildingDef,
    e: DecoEntry,
    timeMs: number,
    dt: number,
    reducedMotion: boolean,
  ): void {
    const spr = this.bank.building(def, b.condition ?? 1);
    const anchorX = e.mx;
    const anchorY = e.my;
    const progress = clamp01(b.progress ?? 1);
    const complete = progress >= 0.999;
    const construction = !complete;

    let alpha = 1;
    let yOff = 0;
    if (construction) {
      alpha = 0.28 + progress * 0.62;
      yOff = (1 - progress) * 14;
    }
    ctx.globalAlpha = alpha;
    ctx.drawImage(spr.canvas, anchorX + spr.x0, anchorY + spr.y0 + yOff, spr.mapW, spr.mapH);
    ctx.globalAlpha = 1;

    if (construction) {
      drawScaffold(ctx, def.size ?? 1, 9 + (def.visual?.height ?? 1) * 22, progress, hexLike(def.visual?.wall ?? '#8a6440'));
      // progress pip above the scaffold
      const pipY = anchorY - 26 - (def.visual?.height ?? 1) * 14;
      const w = 22;
      ctx.fillStyle = cssColorAlpha(0x14100c, 0.75);
      ctx.fillRect(anchorX - w / 2, pipY, w, 3.4);
      ctx.fillStyle = cssColor(0xc9a55b);
      ctx.fillRect(anchorX - w / 2, pipY, w * progress, 3.4);
    }

    // disabled / paused buildings read as cold and grey
    if (!b.enabled) {
      const size = def.size ?? 1;
      ctx.beginPath();
      ctx.moveTo(anchorX, anchorY - size * HALF_H * 2);
      ctx.lineTo(anchorX + size * HALF_W, anchorY - size * HALF_H);
      ctx.lineTo(anchorX, anchorY);
      ctx.lineTo(anchorX - size * HALF_W, anchorY - size * HALF_H);
      ctx.closePath();
      ctx.fillStyle = cssColorAlpha(0x1a2633, 0.38);
      ctx.fill();
    } else if (b.status && b.status.startsWith('No input')) {
      this.drawStatusDot(ctx, anchorX, anchorY - 30 - (def.visual?.height ?? 1) * 12, 0xd9a84e, timeMs, e.phase);
    } else if (b.status && b.status === 'Awaiting workers') {
      this.drawStatusDot(ctx, anchorX, anchorY - 30 - (def.visual?.height ?? 1) * 12, 0x8fa0b0, timeMs, e.phase);
    }

    // farm crops drawn per frame so growth stages read clearly
    if (complete && def.visual?.shape === 'farm' && def.category === 'food') {
      this.drawCrops(ctx, b, def, anchorX, anchorY);
    }

    // banners
    if (def.visual?.flag && spr.art.flag.length >= 2) {
      this.drawFlag(ctx, anchorX + spr.art.flag[0], anchorY + spr.art.flag[1], def, timeMs, e.phase);
    }

    // smoke + fire glow emitters (drawn later in world space)
    if (!construction && (def.visual?.smoke || def.visual?.glow)) {
      const active = b.enabled && (b.workers > 0 || def.visual?.glow);
      if (active) {
        const smoke = spr.art.smoke;
        if (smoke.length >= 2) {
          const sx = anchorX + smoke[0];
          const sy = anchorY + smoke[1];
          this.emitters.push({ x: sx, y: sy, strength: 0.5 + (b.efficiency ?? 0.5) * 0.6 });
        } else {
          this.emitters.push({ x: anchorX, y: anchorY - 20, strength: 0.4 });
        }
      }
    }
    // campfires / forges pulse warm light at night in drawNightLights
    if (def.visual?.glow || def.id === 'fire_pit') {
      const fired = complete && b.enabled;
      if (fired) this.emitters.push({ x: anchorX, y: anchorY - 8, strength: 0.35 });
    }
    void reducedMotion;
    void dt;
    void state;
  }

  private drawStatusDot(ctx: CanvasRenderingContext2D, x: number, y: number, color: number, timeMs: number, phase: number): void {
    const pulse = 0.65 + 0.35 * Math.sin(timeMs * 0.004 + phase * 6.283);
    ctx.beginPath();
    ctx.arc(x, y, 2.6, 0, Math.PI * 2);
    ctx.fillStyle = cssColorAlpha(color, 0.85 * pulse);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, 4.6, 0, Math.PI * 2);
    ctx.fillStyle = cssColorAlpha(color, 0.15 * pulse);
    ctx.fill();
  }

  private drawCrops(ctx: CanvasRenderingContext2D, b: Building, def: BuildingDef, anchorX: number, anchorY: number): void {
    const size = def.size ?? 1;
    const season = this.palette.season;
    const strength = clamp01(b.sourceStrength ?? 0.6);
    let growth = season === 'spring' ? 0.35 : season === 'summer' ? 0.85 : season === 'autumn' ? 1 : 0.12;
    growth *= 0.55 + strength * 0.45;
    if (def.id === 'pasture') return;
    const green = mixColor(0x4f7f34, 0xd9b04a, clamp01(1 - growth * 0.8));
    const gold = mixColor(green, 0xe0c060, clamp01(growth * 0.8));
    const rows = size >= 2 ? 6 : 4;
    const inset = 0.2;
    const cx = anchorX;
    const cy = anchorY + size * HALF_H;
    const halfW = size * HALF_W * (1 - inset) * 0.86;
    const halfH = size * HALF_H * (1 - inset) * 0.86;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = cssColorAlpha(growth > 0.7 ? gold : green, 0.75);
    if (growth < 0.2) {
      // stubble
      ctx.strokeStyle = cssColorAlpha(0x9a8a62, 0.5);
    }
    ctx.beginPath();
    for (let i = 1; i <= rows; i++) {
      const u = i / (rows + 1);
      const y = cy - halfH + u * halfH * 2;
      const w = halfW * (1 - Math.abs(u - 0.5) * 0.5);
      ctx.moveTo(cx - w * 0.9, y - halfH * 0.16);
      ctx.lineTo(cx + w * 0.9, y - halfH * 0.16);
      // small crop tufts
      if (growth > 0.25) {
        for (let k = 0; k < 4; k++) {
          const px = cx - w * 0.8 + (k / 3) * w * 1.6;
          ctx.moveTo(px, y - halfH * 0.16);
          ctx.lineTo(px + 1.1, y - halfH * 0.16 - 1.4 - growth * 2.6);
        }
      }
    }
    ctx.stroke();
    if (def.id === 'pasture') {
      ctx.strokeStyle = cssColorAlpha(0x8a6a3a, 0.5);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - halfW, cy);
      ctx.lineTo(cx + halfW, cy);
      ctx.stroke();
    }
  }

  private drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, def: BuildingDef, timeMs: number, phase: number): void {
    const accent = hexLike(def.visual?.accent ?? '#c9a55b');
    const wob = Math.sin(timeMs * 0.003 + phase * 6.283);
    const len = 10 + wob * 1.4;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.quadraticCurveTo(x + len * 0.5, y + 1 + wob * 1.2, x + len, y + 2.5 + wob * 2);
    ctx.lineTo(x + len * 0.92, y + 6 + wob * 1.4);
    ctx.quadraticCurveTo(x + len * 0.4, y + 5 + wob * 0.8, x, y + 5.6);
    ctx.closePath();
    ctx.fillStyle = cssColor(accent);
    ctx.fill();
    ctx.fillStyle = cssColorAlpha(0xffffff, 0.16);
    ctx.fillRect(x, y + 0.4, len * 0.9, 1.2);
  }

  // -- entities ------------------------------------------------------------

  private drawActors(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number, dt: number): void {
    if (!this.actors.length) return;
    const world = state.world;
    const explored = world.explored;
    const w = world.width;
    const z = this.cam.zoom;
    const reduced = !!state.settings?.reducedMotion;
    const t = timeMs * 0.001;
    for (let i = 0; i < this.actors.length; i++) {
      const a = this.actors[i];
      const cycle = ((t * a.speed + a.phase) % 1 + 1) % 1;
      let tx: number;
      let ty: number;
      let walking: boolean;
      if (cycle < 0.44) {
        const u = cycle / 0.44;
        tx = a.hx + (a.wx - a.hx) * u;
        ty = a.hy + (a.wy - a.hy) * u;
        walking = true;
      } else if (cycle < 0.52) {
        tx = a.wx;
        ty = a.wy;
        walking = false;
      } else if (cycle < 0.94) {
        const u = (cycle - 0.52) / 0.42;
        tx = a.wx + (a.hx - a.wx) * u;
        ty = a.wy + (a.hy - a.wy) * u;
        walking = true;
      } else {
        tx = a.hx;
        ty = a.hy;
        walking = false;
      }
      const cx = Math.floor(clamp(tx, 0, w - 1));
      const cy = Math.floor(clamp(ty, 0, world.height - 1));
      const idx = cy * w + cx;
      if (!explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (tx - ty) * HALF_W;
      const my = (tx + ty) * HALF_H + HALF_H - hgt;
      // cheap screen cull
      const sx = this.cam.mapToScreenX(mx);
      const sy = this.cam.mapToScreenY(my);
      if (sx < -40 || sy < -40 || sx > this.viewW + 40 || sy > this.viewH + 40) continue;
      const frame = walking ? (Math.floor(t * 7 + a.seed) % 4 === 0 ? 1 : 3) : 0;
      const spr = this.bank.citizen(a.cls, a.sex, frame, a.seed);
      const bob = walking && !reduced ? Math.sin(t * 8 + a.seed) * 0.7 : 0;
      ctx.drawImage(spr.canvas, mx + spr.x0, my + spr.y0 + bob, spr.mapW, spr.mapH);
      if (this.app.view?.selectedCitizenId === a.id) {
        ctx.beginPath();
        ctx.ellipse(mx, my, 7, 3.2, 0, 0, Math.PI * 2);
        ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.85);
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }
      void z;
    }
  }

  private drawCritters(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number, dt: number): void {
    const world = state.world;
    const explored = world.explored;
    const w = world.width;
    const t = timeMs * 0.001;
    for (const c of this.critters) {
      c.timer -= dt;
      const dx = c.tx - c.x;
      const dy = c.ty - c.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.2 || c.timer <= 0) {
        c.timer = 3 + hash2(c.variant, Math.floor(t), 3) * 5;
        const nx = clamp(c.x + (hash2(Math.floor(t), c.variant, 7) - 0.5) * 5, 0.5, w - 0.5);
        const ny = clamp(c.y + (hash2(Math.floor(t), c.variant, 11) - 0.5) * 5, 0.5, world.height - 0.5);
        c.tx = nx;
        c.ty = ny;
      } else {
        c.x += (dx / d) * c.speed * dt * 30;
        c.y += (dy / d) * c.speed * dt * 30;
      }
      const tx = clamp(c.x, 0, w - 1);
      const ty = clamp(c.y, 0, world.height - 1);
      const idx = Math.floor(ty) * w + Math.floor(tx);
      if (!explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (tx - ty) * HALF_W;
      const my = (tx + ty) * HALF_H + HALF_H - hgt;
      const sx = this.cam.mapToScreenX(mx);
      const sy = this.cam.mapToScreenY(my);
      if (sx < -60 || sy < -60 || sx > this.viewW + 60 || sy > this.viewH + 60) continue;
      const spr = this.bank.deer(Math.floor(t * 3 + c.variant) % 4, c.variant);
      ctx.drawImage(spr.canvas, mx + spr.x0, my + spr.y0, spr.mapW, spr.mapH);
    }
    // birds
    for (const bird of this.birds) {
      bird.angle += bird.speed * dt;
      bird.timer += dt;
      const mx = bird.cx + Math.cos(bird.angle) * bird.radius;
      const my = bird.cy + Math.sin(bird.angle) * bird.radius * 0.6 - 40;
      const spr = this.bank.bird(Math.floor(bird.timer * 6 + bird.angle) % 4);
      const sx = this.cam.mapToScreenX(mx);
      const sy = this.cam.mapToScreenY(my);
      if (sx < -30 || sy < -30 || sx > this.viewW + 30 || sy > this.viewH + 30) continue;
      ctx.drawImage(spr.canvas, mx + spr.x0, my + spr.y0, spr.mapW, spr.mapH);
    }
  }

  private drawCaravans(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const caravans = state.market?.caravans;
    if (!caravans || !caravans.length) return;
    const world = state.world;
    for (const c of caravans) {
      const path = c.path;
      let px = c.x;
      let py = c.y;
      if (path && path.length >= 2) {
        const u = clamp01(c.progress ?? 0);
        const seg = (path.length - 1) * u;
        const i0 = Math.floor(seg);
        const i1 = Math.min(path.length - 1, i0 + 1);
        const f = seg - i0;
        px = path[i0].x + (path[i1].x - path[i0].x) * f;
        py = path[i0].y + (path[i1].y - path[i0].y) * f;
      }
      const tx = clamp(px, 0, world.width - 1);
      const ty = clamp(py, 0, world.height - 1);
      const idx = Math.floor(ty) * world.width + Math.floor(tx);
      if (!world.explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (tx - ty) * HALF_W;
      const my = (tx + ty) * HALF_H + HALF_H - hgt;
      const spr = this.bank.cart(hashInt(c.id));
      ctx.drawImage(spr.canvas, mx + spr.x0, my + spr.y0, spr.mapW, spr.mapH);
      if (c.label && this.cam.zoom > 1.15) {
        this.labels.push({ mx, my: my - 22, text: c.label, color: '#e6c47e', scale: 0.9 });
      }
      void timeMs;
    }
  }

  private drawExpeditions(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const list = state.exploration?.expeditions;
    if (!list || !list.length) return;
    const world = state.world;
    for (const e of list) {
      const u = clamp01(e.progress ?? 0);
      const tx = clamp(e.x + (e.tx - e.x) * u, 0, world.width - 1);
      const ty = clamp(e.y + (e.ty - e.y) * u, 0, world.height - 1);
      const idx = Math.floor(ty) * world.width + Math.floor(tx);
      if (!world.explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (tx - ty) * HALF_W;
      const my = (tx + ty) * HALF_H + HALF_H - hgt;
      const spr = this.bank.expedition(hashInt(e.id));
      ctx.drawImage(spr.canvas, mx + spr.x0, my + spr.y0, spr.mapW, spr.mapH);
      const pulse = 1 + 0.1 * Math.sin(timeMs * 0.004 + e.id);
      ctx.beginPath();
      ctx.ellipse(mx, my + 1, 13 * pulse, 6 * pulse, 0, 0, Math.PI * 2);
      ctx.strokeStyle = cssColorAlpha(0xb48ad6, 0.5);
      ctx.lineWidth = 1.2;
      ctx.stroke();
      if (this.cam.zoom > 1.05) {
        const names: Record<string, string> = { scout: 'Scouts', survey: 'Surveyors', settle: 'Settlers' };
        this.labels.push({ mx, my: my - 26, text: names[e.kind] ?? 'Expedition', color: '#c9a8e0', sub: e.label, scale: 1 });
      }
    }
  }

  private drawMarkers(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const markers = state.world.markers;
    if (!markers || !markers.length) return;
    const world = state.world;
    for (const m of markers) {
      const tx = clamp(m.x, 0, world.width - 1);
      const ty = clamp(m.y, 0, world.height - 1);
      const idx = Math.floor(ty) * world.width + Math.floor(tx);
      if (!world.explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (tx - ty) * HALF_W;
      const my = (tx + ty) * HALF_H + HALF_H - hgt;
      const color = hexLike(m.color || '#e6c47e');
      // banner
      ctx.beginPath();
      ctx.moveTo(mx, my);
      ctx.lineTo(mx, my - 20);
      ctx.strokeStyle = cssColor(0x4a3a2c);
      ctx.lineWidth = 1.4;
      ctx.stroke();
      const wave = Math.sin(timeMs * 0.004 + hashInt(m.id) * 6) * 1.6;
      ctx.beginPath();
      ctx.moveTo(mx, my - 20);
      ctx.lineTo(mx + 11, my - 18 + wave);
      ctx.lineTo(mx, my - 14);
      ctx.closePath();
      ctx.fillStyle = cssColor(color);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(mx, my + 1, 6, 2.6, 0, 0, Math.PI * 2);
      ctx.fillStyle = cssColorAlpha(color, 0.25);
      ctx.fill();
      if (m.label && this.cam.zoom > 1.2) {
        this.labels.push({ mx, my: my - 26, text: m.label, color: '#e8d9be', scale: 0.9 });
      }
    }
  }

  // -- night lights --------------------------------------------------------

  private drawNightLights(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number, nightness: number): void {
    if (nightness < 0.12) return;
    const world = state.world;
    const explored = world.explored;
    const w = world.width;
    const glows: { x: number; y: number; r: number; c: number; a: number }[] = [];
    // settlement warm cores
    for (const st of state.settlements) {
      const idx = st.y * w + st.x;
      if (!explored[idx]) continue;
      const tile = world.tiles[idx];
      if (!tile) continue;
      const hgt = this.palette.heightPx(tile);
      const mx = (st.x - st.y) * HALF_W;
      const my = (st.x + st.y) * HALF_H + HALF_H - hgt;
      glows.push({ x: mx, y: my - 6, r: 62, c: 0xffb066, a: 0.14 * nightness });
    }
    for (const b of state.buildings) {
      if (b.x < 0 || b.y < 0 || b.x >= w || b.y >= world.height) continue;
      const idx = b.y * w + b.x;
      if (!explored[idx]) continue;
      const def = this.app.content.buildings[b.typeId];
      if (!def) continue;
      const size = def.size ?? 1;
      const hgt = this.buildingBaseHeight(state, b, def);
      const anchorX = (b.x - b.y) * HALF_W;
      const anchorY = (b.x + b.y) * HALF_H - hgt;
      const complete = (b.progress ?? 1) >= 0.999;
      const housing = def.category === 'housing' || def.housing != null;
      const civic = !!def.visual?.glow || def.category === 'society' || def.service != null;
      if (!complete || !b.enabled) continue;
      const dark = b.workers === 0 && !housing && !civic;
      if (dark) continue;
      if (this.isOnScreen(anchorX, anchorY)) {
        const spr = this.bank.building(def, b.condition ?? 1);
        const lights = spr.art.lights;
        const alphaBase = (housing ? 0.5 : civic ? 0.62 : 0.35) * nightness;
        for (let i = 0; i + 1 < lights.length; i += 2) {
          const lx = anchorX + lights[i];
          const ly = anchorY + lights[i + 1];
          const flicker = 0.86 + 0.14 * Math.sin(timeMs * 0.006 + i * 2.1 + b.id);
          glows.push({ x: lx, y: ly, r: 9 + size * 3, c: def.visual?.glow ? 0xffc46a : 0xffb066, a: alphaBase * flicker });
        }
        if (def.visual?.glow) {
          glows.push({ x: anchorX, y: anchorY - 10 - (def.visual.height ?? 1) * 8, r: 30, c: 0xffa04d, a: 0.16 * nightness });
        }
        // campfire / forge: ground pool of light
        if (def.visual?.glow || def.id === 'fire_pit') {
          glows.push({ x: anchorX, y: anchorY + size * HALF_H * 0.4, r: 26, c: 0xff8a3a, a: 0.2 * nightness });
        }
      }
    }
    for (const g of glows) {
      const gr = this.bank.glow(g.c);
      ctx.globalAlpha = clamp01(g.a);
      ctx.drawImage(gr.canvas, g.x - g.r, g.y - g.r, g.r * 2, g.r * 2);
    }
    ctx.globalAlpha = 1;
  }

  private isOnScreen(mx: number, my: number): boolean {
    const sx = this.cam.mapToScreenX(mx);
    const sy = this.cam.mapToScreenY(my);
    return sx > -240 && sy > -300 && sx < this.viewW + 240 && sy < this.viewH + 120;
  }

  // -- fog of war ----------------------------------------------------------

  private updateFog(state: GameState, world: WorldState, dtMs: number): void {
    this.fogTimer -= dtMs;
    if (this.fog && this.fogTimer > 0) return;
    this.fogTimer = 220;
    const explored = world.explored;
    // cheap rolling hash of the explored mask
    let hash = 0;
    for (let i = 0; i < explored.length; i += 3) hash = (Math.imul(hash, 31) + explored[i]) | 0;
    hash = (hash * 31 + explored.length) | 0;
    if (this.fog && hash === this.fogHash) return;
    this.fogHash = hash;
    this.bakeFog(world);
    void state;
  }

  private bakeFog(world: WorldState): void {
    const w = world.width;
    const h = world.height;
    const mapX = -(h - 1) * HALF_W - HALF_W;
    const mapY = -118;
    const mapW = (w + h) * HALF_W;
    const mapH = (w + h) * HALF_H + 220;
    const cw = Math.max(1, Math.ceil(mapW * FOG_SCALE));
    const ch = Math.max(1, Math.ceil(mapH * FOG_SCALE));
    if (!this.fog) {
      this.fog = {
        canvas: makeCanvas(cw, ch),
        temp: makeCanvas(cw, ch),
        mapX,
        mapY,
        mapW,
        mapH,
        hash: this.fogHash,
      };
    }
    const fog = this.fog;
    if (fog.canvas.width !== cw || fog.canvas.height !== ch) {
      fog.canvas.width = cw;
      fog.canvas.height = ch;
      fog.temp.width = cw;
      fog.temp.height = ch;
    }
    fog.mapX = mapX;
    fog.mapY = mapY;
    fog.mapW = mapW;
    fog.mapH = mapH;
    const tctx = fog.temp.getContext('2d');
    const fctx = fog.canvas.getContext('2d');
    if (!tctx || !fctx) return;
    tctx.setTransform(1, 0, 0, 1, 0, 0);
    tctx.clearRect(0, 0, cw, ch);
    const s = FOG_SCALE;
    const ox = -mapX * s;
    const oy = -mapY * s;
    const explored = world.explored;
    const tiles = world.tiles;
    tctx.beginPath();
    const hw = HALF_W * s;
    const hh = HALF_H * s;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        if (explored[row + x]) continue;
        const t = tiles[row + x];
        if (!t) continue;
        const e = this.palette.heightPx(t) * s;
        const nx = ox + (x - y) * hw;
        const ny = oy + (x + y) * hh - e;
        tctx.moveTo(nx, ny);
        tctx.lineTo(nx + hw, ny + hh);
        tctx.lineTo(nx, ny + 2 * hh);
        tctx.lineTo(nx - hw, ny + hh);
        tctx.closePath();
      }
    }
    tctx.fillStyle = 'rgba(19,16,12,1)';
    tctx.fill();
    // soft cloud edge: a tight feather plus a wide halo
    fctx.setTransform(1, 0, 0, 1, 0, 0);
    fctx.clearRect(0, 0, cw, ch);
    const canFilter = typeof (fctx as CanvasRenderingContext2D & { filter?: string }).filter === 'string';
    if (canFilter) {
      fctx.filter = 'blur(4px)';
      fctx.globalAlpha = 0.97;
      fctx.drawImage(fog.temp, 0, 0);
      fctx.filter = 'blur(14px)';
      fctx.globalAlpha = 0.4;
      fctx.drawImage(fog.temp, 0, 0);
      fctx.filter = 'none';
      fctx.globalAlpha = 1;
    } else {
      fctx.drawImage(fog.temp, 0, 0);
    }
    // faint warm ink wash inside the fog so it reads as vellum, not void
    fctx.globalCompositeOperation = 'source-atop';
    fctx.fillStyle = 'rgba(76,60,38,0.16)';
    fctx.fillRect(0, 0, cw, ch);
    const paper = makeCanvas(96, 96);
    const pctx = paper.getContext('2d');
    if (pctx) {
      for (let i = 0; i < 220; i++) {
        const px = hash2(i, 3, 5) * 96;
        const py = hash2(i, 7, 9) * 96;
        const r = 0.6 + hash2(i, 11, 13) * 2.4;
        pctx.beginPath();
        pctx.arc(px, py, r, 0, Math.PI * 2);
        pctx.fillStyle = cssColorAlpha(0x2a2116, 0.05 + hash2(i, 17, 19) * 0.08);
        pctx.fill();
      }
    }
    const pat = fctx.createPattern(paper, 'repeat');
    if (pat) {
      fctx.fillStyle = pat;
      fctx.fillRect(0, 0, cw, ch);
    }
    fctx.globalCompositeOperation = 'source-over';
  }

  private drawFogLayer(ctx: CanvasRenderingContext2D, world: WorldState): void {
    const fog = this.fog;
    if (!fog) return;
    ctx.drawImage(fog.canvas, fog.mapX, fog.mapY, fog.mapW, fog.mapH);
    void world;
  }

  // -- overlays ------------------------------------------------------------

  private overlayCache = new Map<string, string[]>();

  private rampCss(mode: string): string[] {
    const hit = this.overlayCache.get(mode);
    if (hit) return hit;
    const out: string[] = [];
    for (let i = 0; i < OVERLAY_STEPS; i++) {
      out.push(cssColorAlpha(this.palette.overlayColor(mode, i / (OVERLAY_STEPS - 1)), 0.5));
    }
    this.overlayCache.set(mode, out);
    return out;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, state: GameState, world: WorldState): void {
    const mode = this.overlay;
    if (mode === 'none') return;
    const w = world.width;
    const h = world.height;
    const explored = world.explored;
    const tiles = world.tiles;
    const vt = this.terrain.visibleTiles(this.cam, 0);
    const rampModes = ['fertility', 'forest', 'water', 'pollution', 'beauty'];
    const isRamp = rampModes.includes(mode);
    const ramp = isRamp ? this.rampCss(mode) : null;
    const z = this.cam.zoom;

    if (isRamp && ramp) {
      for (let y = vt.y0; y <= vt.y1; y++) {
        const row = y * w;
        for (let x = vt.x0; x <= vt.x1; x++) {
          const idx = row + x;
          if (!explored[idx]) continue;
          const t = tiles[idx];
          if (!t) continue;
          const v = clamp01(this.palette.overlayValue(mode, t));
          const step = Math.min(OVERLAY_STEPS - 1, Math.floor(v * OVERLAY_STEPS));
          const hgt = this.palette.heightPx(t);
          const nx = (x - y) * HALF_W;
          const ny = (x + y) * HALF_H - hgt;
          ctx.fillStyle = ramp[step];
          diamondPath(ctx, nx, ny);
          ctx.fill();
        }
      }
    } else if (mode === 'roads') {
      for (let y = vt.y0; y <= vt.y1; y++) {
        const row = y * w;
        for (let x = vt.x0; x <= vt.x1; x++) {
          const idx = row + x;
          const t = tiles[idx];
          if (!t || t.road <= 0) continue;
          const hgt = this.palette.heightPx(t);
          ctx.fillStyle = cssColorAlpha(0xe0b45e, 0.5);
          diamondPath(ctx, (x - y) * HALF_W, (x + y) * HALF_H - hgt);
          ctx.fill();
        }
      }
    } else if (mode === 'deposits' || mode === 'resources') {
      // dim veil then ore outcrops + resource colour
      for (let y = vt.y0; y <= vt.y1; y++) {
        const row = y * w;
        for (let x = vt.x0; x <= vt.x1; x++) {
          const idx = row + x;
          if (!explored[idx]) continue;
          const t = tiles[idx];
          if (!t) continue;
          const hgt = this.palette.heightPx(t);
          const nx = (x - y) * HALF_W;
          const ny = (x + y) * HALF_H - hgt;
          if (t.deposit) {
            const res = this.app.content.resources[t.deposit.resource];
            const color = res ? hexLike(res.color) : 0xe6c47e;
            const richness = clamp01((t.deposit.amount ?? 1) / Math.max(1, t.deposit.initial ?? 1));
            ctx.fillStyle = cssColorAlpha(color, 0.28 + richness * 0.4);
          } else {
            ctx.fillStyle = cssColorAlpha(0x0d0b07, 0.28);
          }
          diamondPath(ctx, nx, ny);
          ctx.fill();
        }
      }
      // site glow dots on the resources overlay
      if (mode === 'resources') {
        for (const site of world.sites) {
          if (!site.discovered) continue;
          const def = this.app.content.sites[site.defId];
          const color = def ? hexLike(def.color) : 0xe6c47e;
          const hgt = this.palette.heightPx(world.tiles[site.y * w + site.x] ?? tiles[0]);
          const mx = (site.x - site.y) * HALF_W;
          const my = (site.x + site.y) * HALF_H - hgt;
          ctx.beginPath();
          ctx.moveTo(mx, my - 12);
          ctx.lineTo(mx + 4, my - 6);
          ctx.lineTo(mx, my);
          ctx.lineTo(mx - 4, my - 6);
          ctx.closePath();
          ctx.fillStyle = cssColor(color);
          ctx.fill();
        }
      }
    } else if (mode === 'population') {
      // settlement territory tint + housing density
      for (const st of state.settlements) {
        const color = this.palette.settlementColor(st.id);
        const claimed = st.claimedTiles ?? [];
        for (let i = 0; i < claimed.length; i++) {
          const idx = claimed[i];
          if (idx < 0 || idx >= tiles.length) continue;
          const x = idx % w;
          const y = (idx / w) | 0;
          const t = tiles[idx];
          if (!t) continue;
          const hgt = this.palette.heightPx(t);
          ctx.fillStyle = cssColorAlpha(color, 0.16);
          diamondPath(ctx, (x - y) * HALF_W, (x + y) * HALF_H - hgt);
          ctx.fill();
        }
        const hgt = this.palette.heightPx(tiles[st.y * w + st.x] ?? tiles[0]);
        const mx = (st.x - st.y) * HALF_W;
        const my = (st.x + st.y) * HALF_H - hgt;
        ctx.beginPath();
        ctx.ellipse(mx, my + HALF_H, 26 * Math.sqrt(Math.max(1, st.population)) * 0.32, 13 * Math.sqrt(Math.max(1, st.population)) * 0.32, 0, 0, Math.PI * 2);
        ctx.fillStyle = cssColorAlpha(color, 0.18);
        ctx.fill();
      }
      // citizens as bright dots
      for (const c of state.citizens) {
        if (!c.alive) continue;
        const home = this.buildingMap.get(c.homeBuildingId);
        if (!home) continue;
        const t = tiles[home.y * w + home.x];
        if (!t) continue;
        const hgt = this.palette.heightPx(t);
        const mx = (home.x - home.y) * HALF_W + 4;
        const my = (home.x + home.y) * HALF_H - hgt + 2;
        ctx.fillStyle = cssColorAlpha(0xffe0a0, 0.6);
        ctx.fillRect(mx, my, 1.6, 1.6);
      }
    } else if (mode === 'supply') {
      for (const b of state.buildings) {
        const def = this.app.content.buildings[b.typeId];
        if (!def) continue;
        const idx = b.y * w + b.x;
        if (!explored[idx]) continue;
        const hgt = this.buildingBaseHeight(state, b, def);
        const mx = (b.x - b.y) * HALF_W;
        const my = (b.x + b.y) * HALF_H - hgt;
        const status = b.status ?? '';
        let color: number;
        if (!b.enabled) color = 0x8a8478;
        else if (!b.active) color = 0x9a8a6a;
        else if (b.workers === 0 && (def.jobs?.length ?? 0) > 0) color = 0xd9a84e;
        else if (status.startsWith('No input')) color = 0xcf8a49;
        else if (status === 'Working' || (b.efficiency ?? 0) > 0.25) color = 0x7fb069;
        else color = 0xd9a84e;
        const px = mx;
        const py = my - 18 - (def.visual?.height ?? 1) * 16;
        ctx.beginPath();
        ctx.arc(px, py, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = cssColor(color);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, 5.6, 0, Math.PI * 2);
        ctx.fillStyle = cssColorAlpha(color, 0.2);
        ctx.fill();
      }
    }
    void z;
  }

  // -- selection / ghost ---------------------------------------------------

  private drawSelection(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const view = this.app.view;
    if (!view) return;
    const world = state.world;
    const tiles = world.tiles;
    const pulse = 0.6 + 0.4 * Math.sin(timeMs * 0.004);

    // hover tile
    if (view.hoverTile >= 0 && view.hoverTile < tiles.length) {
      const x = view.hoverTile % world.width;
      const y = (view.hoverTile / world.width) | 0;
      const t = tiles[view.hoverTile];
      if (t) {
        const hgt = this.palette.heightPx(t);
        const nx = (x - y) * HALF_W;
        const ny = (x + y) * HALF_H - hgt;
        ctx.strokeStyle = cssColorAlpha(0xf0e4c8, 0.55);
        ctx.lineWidth = 1.4 / this.cam.zoom + 0.4;
        diamondPath(ctx, nx, ny);
        ctx.stroke();
        // corner ticks
        ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.9);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(nx, ny + 4);
        ctx.lineTo(nx, ny);
        ctx.lineTo(nx + HALF_W * 0.25, ny + HALF_H * 0.25);
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx - HALF_W * 0.25, ny + HALF_H * 0.25);
        ctx.stroke();
      }
    }

    // selected tile / building
    if (view.selectedTile >= 0 && view.selectedTile < tiles.length) {
      const x = view.selectedTile % world.width;
      const y = (view.selectedTile / world.width) | 0;
      const t = tiles[view.selectedTile];
      if (t) {
        const hgt = this.palette.heightPx(t);
        const nx = (x - y) * HALF_W;
        const ny = (x + y) * HALF_H - hgt;
        ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.5 + pulse * 0.35);
        ctx.lineWidth = 1.8 / this.cam.zoom + 0.5;
        diamondPath(ctx, nx, ny);
        ctx.stroke();
        const b = t.buildingId >= 0 ? this.buildingMap.get(t.buildingId) : undefined;
        if (b) {
          const inner = this.app.content.buildings[b.typeId];
          const size = inner?.size ?? 1;
          ctx.beginPath();
          for (let dy = 0; dy < size; dy++) {
            for (let dx = 0; dx < size; dx++) {
              const xx = b.x + dx;
              const yy = b.y + dy;
              const bt = tiles[yy * world.width + xx];
              if (!bt) continue;
              const bh = this.palette.heightPx(bt);
              diamondPath(ctx, (xx - yy) * HALF_W, (xx + yy) * HALF_H - bh);
            }
          }
          ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.4 + pulse * 0.35);
          ctx.lineWidth = 1.6 / this.cam.zoom + 0.4;
          ctx.stroke();
        }
      }
    }

    // claim boundary + range ring for the selected settlement
    if (view.showRange) {
      const st = state.settlements.find((s) => s.id === view.selectedSettlementId) ?? state.settlements[0];
      if (st) {
        const claimed = new Set<number>(st.claimedTiles ?? []);
        if (claimed.size) {
          ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.35);
          ctx.lineWidth = 1.2 / this.cam.zoom + 0.3;
          ctx.beginPath();
          let drawn = 0;
          for (const idx of claimed) {
            if (drawn++ > 900) break;
            const x = idx % world.width;
            const y = (idx / world.width) | 0;
            const hgt = this.palette.heightPx(tiles[idx] ?? tiles[0]);
            const nx = (x - y) * HALF_W;
            const ny = (x + y) * HALF_H - hgt;
            // draw the edges that face unclaimed land
            const north = y * world.width + x - world.width;
            const south = y * world.width + x + world.width;
            if (!claimed.has(north)) {
              ctx.moveTo(nx - HALF_W, ny + HALF_H);
              ctx.lineTo(nx, ny);
            }
            if (!claimed.has(south)) {
              ctx.moveTo(nx, ny + TILE_H);
              ctx.lineTo(nx + HALF_W, ny + HALF_H);
            }
          }
          ctx.stroke();
        }
        const stT = tiles[st.y * world.width + st.x];
        if (stT) {
          const hgt = this.palette.heightPx(stT);
          const mx = (st.x - st.y) * HALF_W;
          const my = (st.x + st.y) * HALF_H + HALF_H - hgt;
          ctx.setLineDash([10 / this.cam.zoom, 8 / this.cam.zoom]);
          ctx.beginPath();
          ctx.ellipse(mx, my, 9 * HALF_W * 0.95, 9 * HALF_H * 0.95, 0, 0, Math.PI * 2);
          ctx.strokeStyle = cssColorAlpha(0xe6c47e, 0.16 + pulse * 0.1);
          ctx.lineWidth = 1.4 / this.cam.zoom + 0.3;
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }
  }

  private drawBuildGhost(ctx: CanvasRenderingContext2D, state: GameState, timeMs: number): void {
    const view = this.app.view;
    if (!view || !view.buildMode) return;
    const tile = this.hoverTile();
    if (!tile) return;
    const mode = view.buildMode as string;
    const world = state.world;
    const x = tile.x;
    const y = tile.y;

    const drawFootprint = (ox: number, oy: number, ok: boolean, size: number): void => {
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const xx = ox + dx;
          const yy = oy + dy;
          if (xx < 0 || yy < 0 || xx >= world.width || yy >= world.height) continue;
          const t = world.tiles[yy * world.width + xx];
          if (!t) continue;
          const hgt = this.palette.heightPx(t);
          diamondPath(ctx, (xx - yy) * HALF_W, (xx + yy) * HALF_H - hgt);
          ctx.fillStyle = ok ? 'rgba(127,176,105,0.3)' : 'rgba(207,92,73,0.28)';
          ctx.fill();
          ctx.strokeStyle = ok ? 'rgba(169,201,143,0.85)' : 'rgba(224,138,122,0.8)';
          ctx.lineWidth = 1.2 / this.cam.zoom + 0.3;
          ctx.stroke();
        }
      }
    };

    if (mode === '__road__') {
      const check = this.app.roadCheck ? this.app.roadCheck(x, y) : { ok: true };
      drawFootprint(x, y, !!check.ok, 1);
      return;
    }
    if (mode === '__plant') {
      drawFootprint(x, y, true, 1);
      const t = world.tiles[y * world.width + x];
      if (t) {
        const hgt = this.palette.heightPx(t);
        const spr = this.bank.tree('oak', 0, 1, this.palette.season);
        ctx.globalAlpha = 0.55 + 0.15 * Math.sin(timeMs * 0.004);
        ctx.drawImage(spr.canvas, (x - y) * HALF_W + spr.x0, (x + y) * HALF_H + HALF_H - hgt + spr.y0, spr.mapW, spr.mapH);
        ctx.globalAlpha = 1;
      }
      return;
    }
    const def = this.app.content.buildings[mode];
    if (!def) return;
    const check = this.app.canPlaceBuilding(mode, x, y);
    const ok = !!check?.ok;
    drawFootprint(x, y, ok, def.size ?? 1);
    const spr = this.bank.building(def, 1);
    const hgt = this.buildingBaseHeight(state, { x, y } as Building, def);
    const anchorX = (x - y) * HALF_W;
    const anchorY = (x + y) * HALF_H - hgt;
    ctx.globalAlpha = 0.6;
    ctx.drawImage(spr.canvas, anchorX + spr.x0, anchorY + spr.y0, spr.mapW, spr.mapH);
    ctx.globalAlpha = 1;
  }

  // -- screen labels -------------------------------------------------------

  private drawScreenLabels(ctx: CanvasRenderingContext2D, state: GameState): void {
    const z = this.cam.zoom;
    if (z < 0.7) return;
    const labels = this.labels;
    if (labels.length) {
      ctx.textAlign = 'center';
      for (const l of labels) {
        const sx = this.cam.mapToScreenX(l.mx);
        const sy = this.cam.mapToScreenY(l.my);
        if (sx < -60 || sy < -40 || sx > this.viewW + 60 || sy > this.viewH + 40) continue;
        ctx.font = `600 ${Math.round(10 * l.scale)}px Cinzel, Georgia, serif`;
        ctx.fillStyle = 'rgba(10,8,6,0.75)';
        ctx.fillText(l.text, sx + 1, sy + 1);
        ctx.fillStyle = l.color;
        ctx.fillText(l.text, sx, sy);
        if (l.sub) {
          ctx.font = '10px Inter, sans-serif';
          ctx.fillStyle = 'rgba(200,184,158,0.75)';
          ctx.fillText(l.sub, sx, sy + 12);
        }
      }
    }
    // settlement nameplates
    if (z >= 0.82) {
      ctx.textAlign = 'center';
      for (const st of state.settlements) {
        const t = this.tileAt(st.x, st.y);
        if (!t) continue;
        const hgt = this.palette.heightPx(t);
        const mx = (st.x - st.y) * HALF_W;
        const my = (st.x + st.y) * HALF_H - hgt - 20;
        const sx = this.cam.mapToScreenX(mx);
        const sy = this.cam.mapToScreenY(my);
        if (sx < -100 || sy < -60 || sx > this.viewW + 100 || sy > this.viewH + 60) continue;
        const name = st.name.toUpperCase();
        ctx.font = '600 12px Cinzel, Georgia, serif';
        ctx.fillStyle = 'rgba(8,6,4,0.7)';
        ctx.fillText(name, sx + 1, sy + 1);
        ctx.fillStyle = 'rgba(232,217,190,0.88)';
        ctx.fillText(name, sx, sy);
        ctx.font = '10px Inter, sans-serif';
        ctx.fillStyle = 'rgba(201,165,91,0.85)';
        ctx.fillText(`${st.population} souls`, sx, sy + 12);
      }
    }
  }

  // ==================================================================
  // Picking
  // ==================================================================

  private pickGroundTile(px: number, py: number): { x: number; y: number } | null {
    const state = this.app.state;
    if (!state) return null;
    const world = state.world;
    const mx = this.cam.screenToMapX(px);
    const my = this.cam.screenToMapY(py);
    const f = mapToTileF(mx, my);
    const bx = Math.floor(f.x);
    const by = Math.floor(f.y);
    let bestX = -1;
    let bestY = -1;
    let bestS = -1;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = bx + dx;
        const y = by + dy;
        if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
        const t = world.tiles[y * world.width + x];
        if (!t) continue;
        const h = this.palette.heightPx(t);
        const cx = (x - y) * HALF_W;
        const cy = (x + y) * HALF_H + HALF_H - h;
        if (pointInDiamond(mx, my, cx, cy)) {
          const s = x + y;
          if (s > bestS) {
            bestS = s;
            bestX = x;
            bestY = y;
          }
        }
      }
    }
    if (bestX >= 0) return { x: bestX, y: bestY };
    // fallback: flat ground projection (keeps hover stable over empty space)
    if (bx >= 0 && by >= 0 && bx < world.width && by < world.height) return { x: bx, y: by };
    return null;
  }

  private pickBuildingTile(px: number, py: number): { x: number; y: number } | null {
    const state = this.app.state;
    if (!state) return null;
    const mx = this.cam.screenToMapX(px);
    const my = this.cam.screenToMapY(py);
    const ground = this.pickGroundTile(px, py);
    if (!ground) return null;
    let hit: Building | null = null;
    let bestS = -1;
    for (const b of state.buildings) {
      if (Math.abs(b.x - ground.x) > 3 || Math.abs(b.y - ground.y) > 3) continue;
      const def = this.app.content.buildings[b.typeId];
      if (!def) continue;
      const size = def.size ?? 1;
      if (mx >= b.x && mx <= b.x + size && my >= b.y && my <= b.y + size) {
        // inside the footprint lattice — always a hit
        const s = b.x + b.y + 2;
        if (s > bestS) {
          bestS = s;
          hit = b;
        }
        continue;
      }
      const hgt = this.buildingBaseHeight(state, b, def);
      const spr = this.bank.building(def, b.condition ?? 1);
      const ax = (b.x - b.y) * HALF_W + spr.x0;
      const ay = (b.x + b.y) * HALF_H - hgt + spr.y0;
      if (mx >= ax && mx <= ax + spr.mapW && my >= ay && my <= ay + spr.mapH) {
        const cx = (b.x - b.y) * HALF_W;
        const cy = (b.x + b.y) * HALF_H - hgt + spr.mapH * 0.55;
        // only count as a hit when close to the building mass
        if (pointInDiamond(mx, my, cx, cy, spr.mapW * 0.55, spr.mapH * 0.5)) {
          const s = b.x + b.y + 1;
          if (s > bestS) {
            bestS = s;
            hit = b;
          }
        }
      }
    }
    return hit ? { x: hit.x, y: hit.y } : ground;
  }

  private hoverTile(): { x: number; y: number } | null {
    const state = this.app.state;
    if (!state) return null;
    const view = this.app.view;
    if (!view || view.hoverTile < 0) return null;
    const x = view.hoverTile % state.world.width;
    const y = (view.hoverTile / state.world.width) | 0;
    return { x, y };
  }

  // ==================================================================
  // Input
  // ==================================================================

  private attachInput(): void {
    const c = this.canvas;
    c.addEventListener('pointerdown', this.onPointerDown);
    c.addEventListener('pointermove', this.onPointerMove);
    c.addEventListener('pointerup', this.onPointerUp);
    c.addEventListener('pointercancel', this.onPointerUp);
    c.addEventListener('pointerleave', this.onPointerLeave);
    c.addEventListener('wheel', this.onWheel, { passive: false });
    c.addEventListener('contextmenu', this.onContextMenu);
    c.addEventListener('dblclick', this.onDoubleClick);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
  }

  private detachInput(): void {
    const c = this.canvas;
    c.removeEventListener('pointerdown', this.onPointerDown);
    c.removeEventListener('pointermove', this.onPointerMove);
    c.removeEventListener('pointerup', this.onPointerUp);
    c.removeEventListener('pointercancel', this.onPointerUp);
    c.removeEventListener('pointerleave', this.onPointerLeave);
    c.removeEventListener('wheel', this.onWheel);
    c.removeEventListener('contextmenu', this.onContextMenu);
    c.removeEventListener('dblclick', this.onDoubleClick);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
  }

  private localPoint(ev: PointerEvent | MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    this.rect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }

  private readonly onPointerDown = (ev: PointerEvent): void => {
    const app = this.app;
    if (ev.button === 2) {
      // right click cancels build mode
      if (app.view?.buildMode) app.setBuildMode(null);
      ev.preventDefault();
      return;
    }
    if (ev.button === 1) ev.preventDefault();
    const p = this.localPoint(ev);
    this.drag = {
      active: true,
      button: ev.button,
      startX: p.x,
      startY: p.y,
      lastX: p.x,
      lastY: p.y,
      moved: false,
      pointerId: ev.pointerId,
    };
    if (ev.button === 0 || ev.button === 1) {
      try {
        this.canvas.setPointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
    }
    this.pointerInside = true;
    this.canvas.style.cursor = 'grabbing';
    this.updateHover(p.x, p.y);
    if (ev.pointerType === 'touch') this.pinchDist = 0;
  };

  private readonly onPointerMove = (ev: PointerEvent): void => {
    const p = this.localPoint(ev);
    if (this.pointerTrack && this.pointerTrack.size >= 1) {
      // pinch handling for two-finger gestures
      const prev = this.pointerTrack.get(ev.pointerId);
      this.pointerTrack.set(ev.pointerId, p);
      if (this.pointerTrack.size === 2) {
        const pts = [...this.pointerTrack.values()];
        const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        if (this.pinchDist > 0) {
          const delta = (dist - this.pinchDist) * 0.02;
          const midX = (pts[0].x + pts[1].x) / 2;
          const midY = (pts[0].y + pts[1].y) / 2;
          this.cam.zoomAtScreen(midX, midY, delta);
        }
        this.pinchDist = dist;
        if (prev) this.drag.moved = true;
        return;
      }
    } else {
      this.pointerTrack = new Map();
    }
    this.pointerTrack.set(ev.pointerId, p);
    if (this.pointerTrack.size === 1) this.pinchDist = 0;

    if (this.drag.active && (ev.buttons & 1 || ev.buttons & 4)) {
      const dx = p.x - this.drag.lastX;
      const dy = p.y - this.drag.lastY;
      const total = Math.hypot(p.x - this.drag.startX, p.y - this.drag.startY);
      if (total > 4) this.drag.moved = true;
      if (this.drag.moved) {
        this.cam.panScreen(dx, dy);
        this.canvas.style.cursor = 'grabbing';
      }
      this.drag.lastX = p.x;
      this.drag.lastY = p.y;
    }
    this.updateHover(p.x, p.y);
    if (this.drag.active) this.pointerInside = true;
  };

  private pointerTrack: Map<number, { x: number; y: number }> | null = null;

  private readonly onPointerUp = (ev: PointerEvent): void => {
    if (this.pointerTrack) this.pointerTrack.delete(ev.pointerId);
    if (!this.drag.active) {
      this.canvas.style.cursor = this.defaultCursor();
      return;
    }
    const wasClick = !this.drag.moved && this.drag.button === 0 && ev.button !== 2;
    this.drag.active = false;
    try {
      this.canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    this.canvas.style.cursor = this.defaultCursor();
    if (wasClick) {
      const p = this.localPoint(ev);
      this.handleClick(p.x, p.y);
    }
    this.pointerTrack = null;
    this.pinchDist = 0;
  };

  private readonly onPointerLeave = (): void => {
    if (this.drag.active) return;
    this.pointerInside = false;
    this.app.view.hoverTile = -1;
    this.canvas.style.cursor = this.defaultCursor();
  };

  private readonly onWheel = (ev: WheelEvent): void => {
    ev.preventDefault();
    const p = this.localPoint(ev);
    const d = ev.deltaMode === 1 ? ev.deltaY * 16 : ev.deltaMode === 2 ? ev.deltaY * 100 : ev.deltaY;
    const delta = clamp(-d / 110, -3, 3);
    if (Math.abs(delta) < 0.01) return;
    this.cam.zoomAtScreen(p.x, p.y, delta);
    this.updateHover(p.x, p.y);
  };

  private readonly onContextMenu = (ev: MouseEvent): void => {
    ev.preventDefault();
    if (this.app.view?.buildMode) this.app.setBuildMode(null);
  };

  private readonly onDoubleClick = (ev: MouseEvent): void => {
    const p = this.localPoint(ev);
    const tile = this.pickGroundTile(p.x, p.y);
    if (tile) this.cam.centerOnTile(tile.x, tile.y, this.cam.tzoom);
  };

  private readonly onKeyDown = (ev: KeyboardEvent): void => {
    const target = ev.target as HTMLElement | null;
    if (target) {
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
    }
    const key = ev.key.toLowerCase();
    if (key === 'escape') {
      if (this.app.view?.buildMode) this.app.setBuildMode(null);
      return;
    }
    if (key === 'w' || key === 'a' || key === 's' || key === 'd' || key.startsWith('arrow')) {
      this.keys.add(key);
      if (key.startsWith('arrow')) ev.preventDefault();
    }
    if (key === 'shift') this.keys.add('shift');
  };

  private readonly onKeyUp = (ev: KeyboardEvent): void => {
    const key = ev.key.toLowerCase();
    this.keys.delete(key);
    if (key === 'shift') this.keys.delete('shift');
  };

  private readonly onBlur = (): void => {
    this.keys.clear();
    this.drag.active = false;
    this.pointerTrack = null;
  };

  private defaultCursor(): string {
    if (this.app.view?.buildMode) return 'crosshair';
    return 'default';
  }

  private applyKeyboardPan(dt: number): void {
    if (!this.keys.size) return;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('w') || this.keys.has('arrowup')) dy -= 1;
    if (this.keys.has('s') || this.keys.has('arrowdown')) dy += 1;
    if (this.keys.has('a') || this.keys.has('arrowleft')) dx -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) dx += 1;
    if (!dx && !dy) return;
    const speed = (this.keys.has('shift') ? 1500 : 780) * dt;
    const len = Math.hypot(dx, dy) || 1;
    this.cam.panSmooth((dx / len) * speed, (dy / len) * speed);
  }

  private updateHover(px: number, py: number): void {
    const state = this.app.state;
    if (!state || !state.world) return;
    const tile = this.pickGroundTile(px, py);
    const v = this.app.view;
    if (tile) {
      v.hoverTile = tile.y * state.world.width + tile.x;
    } else {
      v.hoverTile = -1;
    }
    this.hoverPx = px;
    this.hoverPy = py;
    this.pointerInside = true;
    if (!this.drag.active) this.canvas.style.cursor = this.defaultCursor();
  }

  private handleClick(px: number, py: number): void {
    const state = this.app.state;
    if (!state) return;
    const view = this.app.view;
    const tile = view?.buildMode ? this.pickGroundTile(px, py) : this.pickBuildingTile(px, py);
    if (!tile) return;
    if (view?.buildMode) {
      const mode = view.buildMode as string;
      let result;
      if (mode === '__road__') result = this.app.placeRoad(tile.x, tile.y);
      else if (mode === '__plant') result = this.app.plantForest(tile.x, tile.y);
      else result = this.app.placeBuilding(mode, tile.x, tile.y);
      if (result && result.ok) {
        this.invalidateTerrain([tile.y * state.world.width + tile.x]);
      }
      return;
    }
    // selection: building first, then tile
    const t = state.world.tiles[tile.y * state.world.width + tile.x];
    if (t && t.buildingId >= 0) {
      const b = this.buildingMap.get(t.buildingId);
      if (b) {
        this.app.selectTile(tile.x, tile.y);
        return;
      }
    }
    this.app.selectTile(tile.x, tile.y);
  }

  /** Refresh hover after camera moves (keeps the build ghost under the cursor). */
  private refreshHoverFromPointer(): void {
    if (!this.pointerInside) return;
    this.updateHover(this.hoverPx, this.hoverPy);
  }
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

function hexLike(hex: string): number {
  const h = hex.trim();
  if (!h) return 0x808080;
  let s = h.startsWith('#') ? h.slice(1) : h;
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s.slice(0, 6), 16);
  return Number.isFinite(n) ? n >>> 0 : 0x808080;
}

function pickBucket(desired: number): number {
  const buckets = [0.5, 0.65, 0.8, 1.0, 1.25, 1.55, 1.9, 2.4];
  let best = buckets[0];
  let bestD = Infinity;
  const d = clamp(desired, 0.5, 2.4);
  for (const b of buckets) {
    const delta = Math.abs(b - d);
    if (delta < bestD) {
      bestD = delta;
      best = b;
    }
  }
  return best;
}

/** small helper so other modules can inspect tile anchor math */
export function tileAnchor(tx: number, ty: number, heightPx = 0): { x: number; y: number } {
  return { x: (tx - ty) * HALF_W, y: (tx + ty) * HALF_H + HALF_H - heightPx };
}

export { CHUNK_TILES };
