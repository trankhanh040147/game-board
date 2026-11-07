/**
 * Apex Drift — 2D canvas race HUD.
 *
 * Draws the whole in-race overlay onto the transparent `#hud` canvas that sits
 * above the WebGL view: speedometer (dial + digital + gear), segmented nitro
 * bar, drift meter, race panel, standings, minimap, centre countdown, toasts and
 * a light speed-line layer.
 *
 * Presentation only — the HUD never mutates simulation state and never throws on
 * partial input. The module has no DOM access at import time, so it can be
 * imported by Node tooling/tests.
 *
 * Crispness: `resize()` sizes the backing store from CSS pixels × dpr and
 * installs `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`; all drawing below is in CSS
 * pixels. Static geometry (dial ring + ticks + redline arc, minimap outline) is
 * cached as a `Path2D`. Where `Path2D` is unavailable (bare Node harness) the
 * same builder records commands and replays them, so nothing is duplicated.
 *
 * @module app/hud
 * @typedef {{
 *   speedKph?: number|null, gear?: number|null, rpm01?: number|null,
 *   nitro01?: number|null, boosting?: boolean|null, drift01?: number|null,
 *   raceState?: string|null, countdown?: number|null,
 *   lap?: number|null, laps?: number|null, position?: number|null,
 *   totalCars?: number|null, lapTime?: number|null, lastLap?: number|null,
 *   bestLap?: number|null, delta?: number|null, progress?: number|null,
 *   standings?: Array<{name?: string|null, position?: number|null, gap?: number|null, isPlayer?: boolean}>|null,
 *   minimap?: {outline?: Array<[number, number]>|null, cars?: Array<{x:number,z:number,isPlayer?:boolean}>|null, start?: [number,number]|null}|null,
 *   speedLines?: number|null, fps?: number|null, quality?: string|null,
 *   toast?: {text?: string|null, until?: number|null}|null,
 *   bestRecord?: number|null,
 * }|null} HudState
 */

/* -------------------------------------------------------------- constants -- */

const TAU = Math.PI * 2;

/** Speedometer sweep: 135° → 405°，i.e. a 270° dial with the gap at the bottom. */
const DIAL_START = Math.PI * 0.75;
const DIAL_SWEEP = Math.PI * 1.5;
const SPEED_MAX = 320;
const RPM_REDLINE = 0.86;
const MAX_STANDINGS = 6;
const NITRO_SEGMENTS = 10;
const STREAK_COUNT = 44;
const TOAST_FADE_MS = 220;

/** Neon palette (mirrors docs/CONTRACT.md — cyan/red/amber on night base). */
const COL = {
  cyan: '#2fd6c8',
  cyanBright: '#7af6ea',
  cyanSoft: 'rgba(47, 214, 200, 0.42)',
  cyanFaint: 'rgba(47, 214, 200, 0.16)',
  red: '#ff2d4d',
  amber: '#ffd166',
  magenta: '#c04dff',
  white: '#f2fbff',
  text: '#c6d7e6',
  muted: '#7488a0',
  green: '#6ef2b0',
  panel: 'rgba(4, 9, 16, 0.62)',
  panelDeep: 'rgba(3, 7, 13, 0.78)',
  edge: 'rgba(140, 195, 225, 0.20)',
  edgeSoft: 'rgba(140, 195, 225, 0.10)',
  ink: 'rgba(2, 5, 10, 0.78)',
};

/* Font stacks are deliberately local/system only — the page loads no web fonts. */
const FONT_DISPLAY = '"Rajdhani", "Chakra Petch", "Barlow Condensed", system-ui, sans-serif';
const FONT_MONO = 'ui-monospace, "SFMono-Regular", "JetBrains Mono", "Roboto Mono", monospace';

/* ----------------------------------------------------------------- utils -- */

const nowMs =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? () => performance.now()
    : () => Date.now();

/** @returns {number} value clamped to [lo, hi]. */
function clamp(value, lo, hi) {
  return value < lo ? lo : value > hi ? hi : value;
}

/** @returns {number} value clamped to [0, 1]. */
function clamp01(value) {
  return clamp(value, 0, 1);
}

/** Defensive number coercion — anything non-finite becomes `fallback`. */
function num(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/** `M:SS.mmm`, or an em dash when a time is unset/invalid. */
function formatTime(seconds) {
  if (!isFiniteNumber(seconds) || seconds < 0) return '—';
  const totalMs = Math.round(seconds * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${minutes}:${secs < 10 ? '0' : ''}${secs}.${String(ms).padStart(3, '0')}`;
}

/** Signed gap string (`+1.24` / `−0.40`), `LEAD` for the leader. */
function formatGap(gap, position) {
  if (position === 1) return 'LEAD';
  if (typeof gap === 'string' && gap.length > 0) return gap.slice(0, 7);
  const value = num(gap, 0);
  const sign = value >= 0 ? '+' : '−';
  const abs = Math.abs(value);
  if (abs >= 60) {
    const minutes = Math.floor(abs / 60);
    return `${sign}${minutes}:${(abs - minutes * 60).toFixed(1).padStart(4, '0')}`;
  }
  return `${sign}${abs.toFixed(2)}`;
}

function label(value, maxChars) {
  const text = String(value == null || value === '' ? '—' : value).toUpperCase();
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}

function pad2(value) {
  return value < 10 ? `0${value}` : String(value);
}

/** Cheap read of an `[x, z]`-style point; returns null when unusable. */
function readXZ(point) {
  if (!point) return null;
  if (Array.isArray(point)) {
    const x = num(point[0], NaN);
    const z = num(point[1], NaN);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }
  if (typeof point === 'object') {
    const x = num(point.x, NaN);
    const z = num(point.z, NaN);
    return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
  }
  return null;
}

/**
 * Chamfered (clipped-corner) rectangle, arcade-panel style.
 * @param {CanvasRenderingContext2D|{moveTo:Function,lineTo:Function,closePath:Function}} path
 */
function chamferRectPath(path, x, y, w, h, cut) {
  path.moveTo(x + cut, y);
  path.lineTo(x + w, y);
  path.lineTo(x + w, y + h - cut);
  path.lineTo(x + w - cut, y + h);
  path.lineTo(x, y + h);
  path.lineTo(x, y + cut);
  path.closePath();
}

/** Plain rounded rectangle path (used by the minimap panel and chips). */
function roundRectPath(path, x, y, w, h, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(w, h) * 0.5));
  path.moveTo(x + r, y);
  path.lineTo(x + w - r, y);
  path.quadraticCurveTo(x + w, y, x + w, y + r);
  path.lineTo(x + w, y + h - r);
  path.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  path.lineTo(x + r, y + h);
  path.quadraticCurveTo(x, y + h, x, y + h - r);
  path.lineTo(x, y + r);
  path.quadraticCurveTo(x, y, x + r, y);
  path.closePath();
}

/* ------------------------------------------------------------ path cache -- */

/**
 * Records a path once, painting it through a real `Path2D` when the platform
 * provides one. Without `Path2D` the command list is replayed into the live
 * context at stroke/fill time — only relevant for the Node test harness.
 */
class PathBuild {
  constructor() {
    this.path = null;
    this.ops = null;
    try {
      if (typeof Path2D === 'function') this.path = new Path2D();
    } catch {
      this.path = null;
    }
    if (!this.path) this.ops = [];
  }

  _record(name, args) {
    if (this.path) return;
    this.ops.push(name, args);
  }

  moveTo(x, y) {
    if (this.path) this.path.moveTo(x, y);
    else this._record('moveTo', [x, y]);
  }

  lineTo(x, y) {
    if (this.path) this.path.lineTo(x, y);
    else this._record('lineTo', [x, y]);
  }

  quadraticCurveTo(cx, cy, x, y) {
    if (this.path) this.path.quadraticCurveTo(cx, cy, x, y);
    else this._record('quadraticCurveTo', [cx, cy, x, y]);
  }

  arc(x, y, radius, start, end, ccw) {
    if (this.path) this.path.arc(x, y, radius, start, end, Boolean(ccw));
    else this._record('arc', [x, y, radius, start, end, Boolean(ccw)]);
  }

  closePath() {
    if (this.path) this.path.closePath();
    else this._record('closePath', []);
  }

  /** Replays recorded commands onto a live context (no-op for a real Path2D). */
  replay(ctx) {
    const ops = this.ops;
    if (!ops) return;
    for (let i = 0; i < ops.length; i += 2) {
      const fn = ctx[ops[i]];
      if (typeof fn === 'function') fn.apply(ctx, ops[i + 1]);
    }
  }
}

function strokeBuild(ctx, build) {
  if (!build) return;
  if (build.path) {
    ctx.stroke(build.path);
    return;
  }
  build.replay(ctx);
  ctx.stroke();
}

function fillBuild(ctx, build) {
  if (!build) return;
  if (build.path) {
    ctx.fill(build.path);
    return;
  }
  build.replay(ctx);
  ctx.fill();
}

/* ------------------------------------------------------------------ class -- */

class Hud {
  /** @param {HTMLCanvasElement|null} canvas @param {CanvasRenderingContext2D|null} ctx */
  constructor(canvas, ctx) {
    this.canvas = canvas;
    this.ctx = ctx;

    /* Layout (all in CSS pixels, rebuilt by resize()). */
    this.w = 1280;
    this.h = 720;
    this.dpr = 1;
    this.s = 1;
    this.margin = 22;
    this.speedo = { cx: 1000, cy: 560, r: 96 };
    this.race = { x: 22, y: 22, w: 252, h: 152 };
    this.standings = { x: 1020, y: 22, w: 238, h: 158 };
    this.minimap = { x: 22, y: 548, w: 180, h: 150 };
    this.nitro = { x: 0, y: 0, w: 26, h: 132 };
    this.drift = { x: 0, y: 0, w: 158, h: 22 };
    this.micro = { x: 1258, y: 707 };

    /* Frame bookkeeping. */
    this._fontKey = null;
    this._lastNow = 0;
    this._now = 0;
    this._dt = 1 / 60;

    /* Smoothed presentation values so needles/bars don't jitter. */
    this._smooth = { speed: 0, rpm: 0, nitro: 0, drift: 0 };

    /* Cached static paths. */
    this._dialRing = null;
    this._dialTicks = null;
    this._dialRedline = null;
    this._rpmRing = null;

    /* Minimap projection cache. */
    this._outlineRef = null;
    this._outlineFingerprint = null;
    this._minimapBuild = null;
    this._map = { ok: false, scale: 1, cx: 0, cz: 0, ox: 0, oy: 0 };

    /* Centre overlay animation state. */
    this._cdValue = null;
    this._cdSince = 0;

    /* Toast bookkeeping (the app may or may not supply `until`). */
    this._toastText = null;
    this._toastSince = 0;
    this._toastLastSeen = 0;

    /* Static radial streak directions for the speed-line vignette. */
    this._streaks = new Float32Array(STREAK_COUNT * 2);
    for (let i = 0; i < STREAK_COUNT; i += 1) {
      const angle = (i / STREAK_COUNT) * TAU + Math.sin(i * 12.9898) * 0.09;
      this._streaks[i * 2] = Math.cos(angle);
      this._streaks[i * 2 + 1] = Math.sin(angle);
    }
  }

  /* ------------------------------------------------------------- public -- */

  /**
   * Size the backing store for a CSS-pixel viewport and rebuild cached paths.
   * @param {number} width  CSS pixels
   * @param {number} height CSS pixels
   * @param {number} [dpr]  device pixel ratio (defaults to the previous value)
   */
  resize(width, height, dpr) {
    const w = Math.max(1, num(width, this.w));
    const h = Math.max(1, num(height, this.h));
    const ratio = clamp(num(dpr, this.dpr), 0.5, 3);
    this.w = w;
    this.h = h;
    this.dpr = ratio;

    const canvas = this.canvas;
    if (canvas) {
      try {
        const backingW = Math.max(1, Math.round(w * ratio));
        const backingH = Math.max(1, Math.round(h * ratio));
        if (canvas.width !== backingW) canvas.width = backingW;
        if (canvas.height !== backingH) canvas.height = backingH;
        if (canvas.style) {
          const cssW = `${w}px`;
          const cssH = `${h}px`;
          if (canvas.style.width !== cssW) canvas.style.width = cssW;
          if (canvas.style.height !== cssH) canvas.style.height = cssH;
        }
      } catch {
        /* Hostile/stub canvas: layout still works, drawing just won't happen. */
      }
    }

    const ctx = this.ctx;
    if (ctx) {
      try {
        ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
        ctx.imageSmoothingEnabled = true;
      } catch {
        /* ignore */
      }
    }

    this._layout();
    this._buildStaticPaths();
    this._outlineRef = null;
    this._outlineFingerprint = null;
    this._minimapBuild = null;
    this._fontKey = null;
  }

  /**
   * Full redraw. Safe with `null`, `{}` or partially populated state.
   * @param {HudState} state
   */
  draw(state) {
    const ctx = this.ctx;
    if (!ctx) return;

    const now = nowMs();
    let dt = this._lastNow > 0 ? (now - this._lastNow) / 1000 : 1 / 60;
    this._lastNow = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = clamp(dt, 0.001, 0.1);
    this._dt = dt;
    this._now = now;

    try {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.clearRect(0, 0, this.w, this.h);
    } catch {
      /* keep going — a broken clear must not break the rest of the frame */
    }

    const st = state && typeof state === 'object' ? state : null;
    if (!st) {
      this._fontKey = null;
      return;
    }

    const mode = typeof st.raceState === 'string' ? st.raceState : 'running';

    /* Menu/loading screens own the screen: keep the overlay blank. */
    if (mode === 'title' || mode === 'garage' || mode === 'loading') {
      this._cdValue = null;
      this._fontKey = null;
      return;
    }

    const paused = mode === 'paused';
    const results = mode === 'results';
    if (!paused) this._updateSmoothing(st, dt);

    const dim = paused ? 0.34 : results ? 0.5 : 1;

    ctx.save();
    if (dim !== 1) ctx.globalAlpha = dim;
    this._drawSpeedLines(ctx, st);
    this._drawRacePanel(ctx, st);
    this._drawStandings(ctx, st);
    this._drawMinimap(ctx, st);
    this._drawSpeedo(ctx, st);
    this._drawNitro(ctx, st);
    this._drawDrift(ctx, st);
    this._drawMicro(ctx, st);
    ctx.restore();
    this._fontKey = null;

    if (paused || results) return;

    this._drawCountdown(ctx, st, now);
    this._drawToast(ctx, st, now);
    this._fontKey = null;
  }

  /** Drop transient animation state (call when a race restarts / scene changes). */
  reset() {
    this._smooth.speed = 0;
    this._smooth.rpm = 0;
    this._smooth.nitro = 0;
    this._smooth.drift = 0;
    this._lastNow = 0;
    this._cdValue = null;
    this._cdSince = 0;
    this._toastText = null;
    this._toastSince = 0;
    this._toastLastSeen = 0;
    this._outlineRef = null;
    this._outlineFingerprint = null;
    this._minimapBuild = null;
    this._fontKey = null;
    const ctx = this.ctx;
    if (ctx) {
      try {
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.w, this.h);
      } catch {
        /* ignore */
      }
    }
  }

  /* -------------------------------------------------------------- layout -- */

  _layout() {
    const { w, h } = this;
    const s = clamp(Math.min(w / 1280, h / 720), 0.62, 1.8);
    this.s = s;

    const margin = Math.round(clamp(22 * s, 10, 44));
    this.margin = margin;

    const r = Math.round(clamp(96 * s, 54, 200));
    const cx = Math.round(w - margin - r - 10 * s);
    const cy = Math.round(h - margin - r - 26 * s);
    this.speedo = { cx, cy, r };

    this.race = { x: margin, y: margin, w: Math.round(252 * s), h: Math.round(152 * s) };
    this.standings = {
      x: w - margin - Math.round(238 * s),
      y: margin,
      w: Math.round(238 * s),
      h: Math.round((32 + 21 * MAX_STANDINGS) * s),
    };
    this.minimap = {
      x: margin,
      y: Math.round(h - margin - 150 * s),
      w: Math.round(180 * s),
      h: Math.round(150 * s),
    };

    const nitroW = Math.round(26 * s);
    const nitroH = Math.round(132 * s);
    this.nitro = {
      x: Math.round(cx - r - 44 * s),
      y: Math.round(cy - nitroH * 0.55),
      w: nitroW,
      h: nitroH,
    };

    const driftW = Math.round(158 * s);
    const driftH = Math.round(22 * s);
    this.drift = {
      x: Math.round(cx - r - 44 * s - 12 * s - driftW),
      y: Math.round(cy - r - 50 * s),
      w: driftW,
      h: driftH,
    };

    this.micro = { x: w - margin, y: Math.round(h - margin * 0.6) };
  }

  /* ------------------------------------------------------- static caches -- */

  _buildStaticPaths() {
    const s = this.s;
    const { cx, cy, r } = this.speedo;
    const ringRadius = Math.max(4, r - 3 * s);

    const ring = new PathBuild();
    ring.arc(cx, cy, ringRadius, DIAL_START, DIAL_START + DIAL_SWEEP);
    this._dialRing = ring;

    const ticks = new PathBuild();
    const tickStep = 10;
    for (let kph = 0; kph <= SPEED_MAX; kph += tickStep) {
      const t = kph / SPEED_MAX;
      const a = DIAL_START + t * DIAL_SWEEP;
      const major = kph % 40 === 0;
      const inner = r - (major ? 20 : 13) * s;
      const outer = r - 7 * s;
      ticks.moveTo(cx + Math.cos(a) * inner, cy + Math.sin(a) * inner);
      ticks.lineTo(cx + Math.cos(a) * outer, cy + Math.sin(a) * outer);
    }
    this._dialTicks = ticks;

    const redline = new PathBuild();
    redline.arc(
      cx,
      cy,
      ringRadius,
      DIAL_START + 0.75 * DIAL_SWEEP,
      DIAL_START + DIAL_SWEEP,
    );
    this._dialRedline = redline;

    const rpmRing = new PathBuild();
    rpmRing.arc(cx, cy, Math.max(6, r - 32 * s), DIAL_START, DIAL_START + DIAL_SWEEP);
    this._rpmRing = rpmRing;
  }

  /* -------------------------------------------------------------- frame -- */

  _updateSmoothing(st, dt) {
    const speed = clamp(num(st.speedKph, 0), 0, SPEED_MAX * 1.2);
    const rpm = clamp01(num(st.rpm01, 0));
    const nitro = clamp01(num(st.nitro01, 0));
    const drift = clamp01(num(st.drift01, 0));

    /* Exponential smoothing, frame-rate independent. */
    const kFast = 1 - Math.exp(-dt * 16);
    const kMid = 1 - Math.exp(-dt * 10);
    const kSlow = 1 - Math.exp(-dt * 8);

    this._smooth.speed += (speed - this._smooth.speed) * kFast;
    this._smooth.rpm += (rpm - this._smooth.rpm) * kMid;
    this._smooth.nitro += (nitro - this._smooth.nitro) * kSlow;
    this._smooth.drift += (drift - this._smooth.drift) * kMid;
  }

  /** Choose and cache the canvas font; resets itself when the context changes. */
  _font(ctx, sizePx, weight, mono) {
    const px = Math.max(6, Math.round(sizePx * 10) / 10);
    const key = `${mono ? 'm' : 'd'}${weight}${px}`;
    if (this._fontKey !== key) {
      this._fontKey = key;
      ctx.font = `${weight} ${px}px ${mono ? FONT_MONO : FONT_DISPLAY}`;
    }
  }

  /* ------------------------------------------------------------- panels -- */

  /** Shared arcade panel: translucency, hairline border, cyan top accent. */
  _panel(ctx, rect, opts = {}) {
    const s = this.s;
    const cut = (opts.cut ?? 12) * s;
    const fill = opts.fill ?? COL.panel;
    const edge = opts.edge ?? COL.edge;

    ctx.beginPath();
    chamferRectPath(ctx, rect.x, rect.y, rect.w, rect.h, cut);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = edge;
    ctx.stroke();

    /* Accent sliver along the top-left edge. */
    const len = Math.min(rect.w * 0.42, 96 * s);
    ctx.beginPath();
    ctx.moveTo(rect.x + cut, rect.y);
    ctx.lineTo(rect.x + len, rect.y);
    ctx.strokeStyle = opts.accent ?? 'rgba(47, 214, 200, 0.55)';
    ctx.lineWidth = Math.max(1, 1.4 * s);
    ctx.stroke();
  }

  _drawRacePanel(ctx, st) {
    const s = this.s;
    const p = this.race;
    this._panel(ctx, p);

    const x = p.x + 14 * s;
    const right = p.x + p.w - 14 * s;

    this._font(ctx, 9.5 * s, 700, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.muted;
    ctx.fillText('RACE CONTROL', x, p.y + 19 * s);

    const laps = Math.round(num(st.laps, 0));
    const lap = Math.round(num(st.lap, 0));
    const position = Math.round(num(st.position, 0));
    const totalCars = Math.round(num(st.totalCars, 0));

    this._font(ctx, 15 * s, 700, true);
    ctx.fillStyle = COL.white;
    ctx.textAlign = 'left';
    ctx.fillText(laps > 0 && lap > 0 ? `LAP ${lap}/${laps}` : 'LAP —', x, p.y + 44 * s);

    ctx.textAlign = 'right';
    ctx.fillStyle = COL.cyan;
    ctx.fillText(
      position > 0 && totalCars > 0 ? `POS ${position}/${totalCars}` : 'POS —',
      right,
      p.y + 44 * s,
    );

    /* Current lap clock. */
    this._font(ctx, 26 * s, 700, true);
    ctx.textAlign = 'left';
    ctx.fillStyle = COL.white;
    ctx.shadowColor = 'rgba(47, 214, 200, 0.35)';
    ctx.shadowBlur = 8 * s;
    ctx.fillText(formatTime(st.lapTime), x, p.y + 78 * s);
    ctx.shadowBlur = 0;

    /* Last / best lap. */
    const best = st.bestLap;
    this._font(ctx, 9 * s, 600, true);
    ctx.fillStyle = COL.muted;
    ctx.fillText('LAST', x, p.y + 100 * s);
    ctx.fillText('BEST', x + 106 * s, p.y + 100 * s);

    this._font(ctx, 11.5 * s, 600, true);
    ctx.fillStyle = COL.text;
    ctx.fillText(formatTime(st.lastLap), x + 36 * s, p.y + 100 * s);
    ctx.fillStyle = COL.amber;
    ctx.fillText(formatTime(best), x + 142 * s, p.y + 100 * s);

    /* Delta vs. best lap, or the session record when there is no delta yet. */
    const delta = st.delta;
    if (isFiniteNumber(delta)) {
      const faster = delta <= 0;
      this._font(ctx, 11 * s, 700, true);
      ctx.fillStyle = faster ? COL.green : COL.red;
      ctx.fillText(
        `${faster ? '−' : '+'}${Math.abs(delta).toFixed(3)}`,
        x,
        p.y + 123 * s,
      );
      this._font(ctx, 8.5 * s, 600, true);
      ctx.fillStyle = COL.muted;
      ctx.fillText(faster ? 'DELTA / FASTER' : 'DELTA / SLOWER', x + 62 * s, p.y + 123 * s);
    } else {
      const record = st.bestRecord;
      this._font(ctx, 9 * s, 600, true);
      ctx.fillStyle = COL.muted;
      ctx.fillText(
        isFiniteNumber(record) && record > 0 ? `SESSION REC ${formatTime(record)}` : 'CLEAN LINE · NO CONTACT',
        x,
        p.y + 123 * s,
      );
    }

    /* Lap progress hairline. */
    const progress = clamp01(num(st.progress, 0));
    const barY = p.y + p.h - 8 * s;
    const barW = p.w - 28 * s;
    ctx.beginPath();
    ctx.moveTo(x, barY);
    ctx.lineTo(x + barW, barY);
    ctx.strokeStyle = COL.edgeSoft;
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.stroke();
    if (progress > 0.002) {
      ctx.beginPath();
      ctx.moveTo(x, barY);
      ctx.lineTo(x + barW * progress, barY);
      ctx.strokeStyle = COL.cyan;
      ctx.stroke();
    }
  }

  _drawStandings(ctx, st) {
    const s = this.s;
    const p = this.standings;
    this._panel(ctx, p, { cut: 10 });

    const x = p.x + 12 * s;
    const right = p.x + p.w - 12 * s;

    this._font(ctx, 9.5 * s, 700, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.muted;
    ctx.fillText('STANDINGS', x, p.y + 18 * s);

    const list = Array.isArray(st.standings) ? st.standings : null;
    const rowH = 21 * s;
    const firstY = p.y + 32 * s;

    if (!list || list.length === 0) {
      this._font(ctx, 10 * s, 500, true);
      ctx.fillStyle = COL.muted;
      ctx.fillText('AWAITING GRID…', x, firstY + 12 * s);
      return;
    }

    const count = Math.min(list.length, MAX_STANDINGS);
    for (let i = 0; i < count; i += 1) {
      const entry = list[i];
      if (!entry || typeof entry !== 'object') continue;
      const rowY = firstY + i * rowH;
      const isPlayer = Boolean(entry.isPlayer);
      const pos = Math.round(num(entry.position, i + 1));

      if (isPlayer) {
        ctx.beginPath();
        ctx.moveTo(p.x + 2 * s, rowY);
        ctx.lineTo(p.x + p.w - 2 * s, rowY);
        ctx.lineTo(p.x + p.w - 2 * s, rowY + rowH);
        ctx.lineTo(p.x + 2 * s, rowY + rowH);
        ctx.closePath();
        ctx.fillStyle = 'rgba(47, 214, 200, 0.13)';
        ctx.fill();
        ctx.beginPath();
        ctx.moveTo(p.x + 2 * s, rowY);
        ctx.lineTo(p.x + 2 * s, rowY + rowH);
        ctx.strokeStyle = COL.cyan;
        ctx.lineWidth = Math.max(1, 2 * s);
        ctx.stroke();
      }

      const midY = rowY + rowH * 0.68;
      this._font(ctx, 10.5 * s, 700, true);
      ctx.textAlign = 'left';
      ctx.fillStyle = isPlayer ? COL.cyan : COL.muted;
      ctx.fillText(pad2(pos), x, midY);

      this._font(ctx, 12 * s, 600, false);
      ctx.fillStyle = isPlayer ? COL.white : COL.text;
      ctx.fillText(label(entry.name, 11), x + 26 * s, midY);

      this._font(ctx, 9.5 * s, 600, true);
      ctx.textAlign = 'right';
      ctx.fillStyle = isPlayer ? COL.amber : COL.muted;
      ctx.fillText(formatGap(entry.gap, pos), right, midY);
      ctx.textAlign = 'left';
    }
  }

  /* ------------------------------------------------------------ minimap -- */

  /**
   * Fit the world-space minimap outline into the panel once, then cache the
   * projected path. Rebuilds only when the outline identity/fingerprint changes.
   */
  _prepareMinimap(state) {
    const mm = state && typeof state.minimap === 'object' ? state.minimap : null;
    const outline = mm && Array.isArray(mm.outline) ? mm.outline : null;
    if (!outline || outline.length < 2) {
      this._outlineRef = null;
      this._minimapBuild = null;
      this._map.ok = false;
      return;
    }

    /* The app normally reuses the same outline array every frame — bail out on
     * identity. When a new array arrives we fingerprint it so a rebuild only
     * happens when the geometry really changed. */
    if (this._outlineRef === outline && this._minimapBuild) return;
    const first = readXZ(outline[0]);
    const last = readXZ(outline[outline.length - 1]);
    const fingerprint = `${outline.length}|${first ? first.x : 0},${first ? first.z : 0}|${
      last ? last.x : 0
    },${last ? last.z : 0}`;
    if (this._outlineFingerprint === fingerprint && this._minimapBuild) return;

    const p = this.minimap;
    const s = this.s;
    const pad = 11 * s;
    const top = p.y + 22 * s;
    const innerX = p.x + pad;
    const innerY = top + 4 * s;
    const innerW = Math.max(10, p.w - pad * 2);
    const innerH = Math.max(10, p.y + p.h - pad - innerY);

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < outline.length; i += 1) {
      const point = readXZ(outline[i]);
      if (!point) continue;
      if (point.x < minX) minX = point.x;
      if (point.x > maxX) maxX = point.x;
      if (point.z < minZ) minZ = point.z;
      if (point.z > maxZ) maxZ = point.z;
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minZ)) {
      this._minimapBuild = null;
      this._map.ok = false;
      return;
    }

    const spanX = Math.max(1, maxX - minX);
    const spanZ = Math.max(1, maxZ - minZ);
    const scale = Math.min(innerW / spanX, innerH / spanZ);
    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;

    const project = (x, z) => [
      innerX + innerW * 0.5 + (x - centerX) * scale,
      innerY + innerH * 0.5 + (z - centerZ) * scale,
    ];

    const build = new PathBuild();
    let started = false;
    for (let i = 0; i < outline.length; i += 1) {
      const point = readXZ(outline[i]);
      if (!point) continue;
      const [px, py] = project(point.x, point.z);
      if (!started) {
        build.moveTo(px, py);
        started = true;
      } else {
        build.lineTo(px, py);
      }
    }
    build.closePath();

    this._minimapBuild = build;
    this._outlineRef = outline;
    this._outlineFingerprint = fingerprint;
    this._map.ok = true;
    this._map.scale = scale;
    this._map.cx = centerX;
    this._map.cz = centerZ;
    this._map.innerX = innerX;
    this._map.innerY = innerY;
    this._map.innerW = innerW;
    this._map.innerH = innerH;
  }

  _mapPoint(x, z) {
    const map = this._map;
    if (!map.ok) return null;
    return [
      map.innerX + map.innerW * 0.5 + (x - map.cx) * map.scale,
      map.innerY + map.innerH * 0.5 + (z - map.cz) * map.scale,
    ];
  }

  _drawMinimap(ctx, st) {
    const s = this.s;
    const p = this.minimap;
    this._prepareMinimap(st);

    ctx.beginPath();
    roundRectPath(ctx, p.x, p.y, p.w, p.h, 6 * s);
    ctx.fillStyle = COL.panelDeep;
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = COL.edge;
    ctx.stroke();

    this._font(ctx, 9 * s, 700, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.muted;
    ctx.fillText('MAP', p.x + 11 * s, p.y + 16 * s);

    if (this._minimapBuild) {
      ctx.save();
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(176, 240, 255, 0.78)';
      ctx.lineWidth = Math.max(1, 1.9 * s);
      ctx.shadowColor = 'rgba(47, 214, 200, 0.55)';
      ctx.shadowBlur = 8 * s;
      strokeBuild(ctx, this._minimapBuild);
      ctx.restore();
      this._fontKey = null;
    } else {
      this._font(ctx, 9.5 * s, 500, true);
      ctx.textAlign = 'center';
      ctx.fillStyle = COL.muted;
      ctx.fillText('NO ROUTE DATA', p.x + p.w * 0.5, p.y + p.h * 0.55);
      ctx.textAlign = 'left';
    }

    if (!this._map.ok) return;

    /* Start/finish marker. */
    const start = readXZ(st.minimap && st.minimap.start);
    if (start) {
      const mapped = this._mapPoint(start.x, start.z);
      if (mapped) {
        const [sx, sy] = mapped;
        const size = 7 * s;
        ctx.fillStyle = COL.white;
        ctx.fillRect(sx - size * 0.5, sy - size * 0.5, size * 0.5, size * 0.5);
        ctx.fillRect(sx, sy, size * 0.5, size * 0.5);
        ctx.fillStyle = 'rgba(255, 209, 102, 0.9)';
        ctx.fillRect(sx, sy - size * 0.5, size * 0.5, size * 0.5);
        ctx.fillRect(sx - size * 0.5, sy, size * 0.5, size * 0.5);
      }
    }

    /* Cars — AI first so the player dot sits on top. */
    const cars = st.minimap && Array.isArray(st.minimap.cars) ? st.minimap.cars : null;
    if (!cars) return;
    for (let pass = 0; pass < 2; pass += 1) {
      for (let i = 0; i < cars.length; i += 1) {
        const car = cars[i];
        if (!car || typeof car !== 'object') continue;
        const isPlayer = Boolean(car.isPlayer);
        if ((pass === 0) === isPlayer) continue;
        const x = num(car.x, NaN);
        const z = num(car.z, NaN);
        if (!Number.isFinite(x) || !Number.isFinite(z)) continue;
        const mapped = this._mapPoint(x, z);
        if (!mapped) continue;
        const [mx, my] = mapped;
        if (isPlayer) {
          ctx.beginPath();
          ctx.arc(mx, my, 4.6 * s, 0, TAU);
          ctx.fillStyle = COL.cyan;
          ctx.shadowColor = 'rgba(47, 214, 200, 0.9)';
          ctx.shadowBlur = 10 * s;
          ctx.fill();
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.arc(mx, my, 6.6 * s, 0, TAU);
          ctx.strokeStyle = 'rgba(47, 214, 200, 0.5)';
          ctx.lineWidth = Math.max(1, 1.2 * s);
          ctx.stroke();
        } else {
          ctx.beginPath();
          ctx.arc(mx, my, 2.8 * s, 0, TAU);
          ctx.fillStyle = 'rgba(255, 209, 102, 0.85)';
          ctx.fill();
        }
      }
    }
  }

  /* --------------------------------------------------------- speedometer -- */

  _drawSpeedo(ctx, st) {
    const s = this.s;
    const { cx, cy, r } = this.speedo;
    const softRpm = this._smooth.rpm;
    const tSpeed = clamp01(this._smooth.speed / SPEED_MAX);

    /* Backing disc + outer neon rim. */
    ctx.beginPath();
    ctx.arc(cx, cy, r + 7 * s, 0, TAU);
    ctx.fillStyle = 'rgba(3, 8, 14, 0.68)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = 'rgba(47, 214, 200, 0.28)';
    ctx.stroke();

    /* Dial ring + ticks + redline segment (cached paths). */
    ctx.lineWidth = Math.max(1, 1.2 * s);
    ctx.strokeStyle = 'rgba(150, 190, 215, 0.28)';
    strokeBuild(ctx, this._dialRing);

    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.strokeStyle = 'rgba(170, 205, 225, 0.52)';
    strokeBuild(ctx, this._dialTicks);

    ctx.lineWidth = Math.max(1, 2.4 * s);
    ctx.strokeStyle = 'rgba(255, 45, 77, 0.62)';
    strokeBuild(ctx, this._dialRedline);

    /* Speed sweep. */
    if (tSpeed > 0.004) {
      const hot = tSpeed >= 0.82;
      ctx.beginPath();
      ctx.arc(cx, cy, r - 3 * s, DIAL_START, DIAL_START + tSpeed * DIAL_SWEEP);
      ctx.lineWidth = Math.max(2, 6 * s);
      ctx.lineCap = 'round';
      ctx.strokeStyle = hot ? COL.red : COL.cyan;
      ctx.shadowColor = hot ? 'rgba(255, 45, 77, 0.8)' : 'rgba(47, 214, 200, 0.75)';
      ctx.shadowBlur = 10 * s;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    /* RPM ring inside the dial. */
    ctx.lineWidth = Math.max(1, 1.4 * s);
    ctx.strokeStyle = 'rgba(150, 190, 215, 0.14)';
    strokeBuild(ctx, this._rpmRing);
    if (softRpm > 0.004) {
      const rpmHot = softRpm >= RPM_REDLINE;
      let rpmColor = COL.cyan;
      if (rpmHot) {
        const pulse = 0.62 + 0.38 * (0.5 + 0.5 * Math.sin(this._now * 0.028));
        rpmColor = `rgba(255, 45, 77, ${pulse.toFixed(2)})`;
      } else if (softRpm >= 0.62) {
        rpmColor = COL.amber;
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r - 32 * s, DIAL_START, DIAL_START + softRpm * DIAL_SWEEP);
      ctx.lineWidth = Math.max(1.5, 4 * s);
      ctx.lineCap = 'round';
      ctx.strokeStyle = rpmColor;
      ctx.stroke();
    }

    /* Needle. */
    const angle = DIAL_START + tSpeed * DIAL_SWEEP;
    const nx = Math.cos(angle);
    const ny = Math.sin(angle);
    ctx.beginPath();
    ctx.moveTo(cx + nx * 12 * s, cy + ny * 12 * s);
    ctx.lineTo(cx + nx * (r - 22 * s), cy + ny * (r - 22 * s));
    ctx.lineWidth = Math.max(1.5, 2.6 * s);
    ctx.lineCap = 'round';
    ctx.strokeStyle = COL.amber;
    ctx.shadowColor = 'rgba(255, 209, 102, 0.8)';
    ctx.shadowBlur = 7 * s;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(cx, cy, 5.4 * s, 0, TAU);
    ctx.fillStyle = 'rgba(4, 9, 16, 0.95)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, 1.6 * s);
    ctx.strokeStyle = COL.amber;
    ctx.stroke();

    /* Digital readout. */
    const speedValue = Math.round(this._smooth.speed);
    this._font(ctx, 44 * s, 700, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COL.white;
    ctx.shadowColor = 'rgba(47, 214, 200, 0.42)';
    ctx.shadowBlur = 12 * s;
    ctx.fillText(String(speedValue), cx, cy - 2 * s);
    ctx.shadowBlur = 0;

    this._font(ctx, 9.5 * s, 600, true);
    ctx.fillStyle = COL.muted;
    ctx.fillText('KM/H', cx, cy + 27 * s);

    /* Gear box. */
    const gearRaw = st.gear;
    const gear = isFiniteNumber(gearRaw) ? Math.round(gearRaw) : 1;
    const gearText = gear <= 0 ? 'N' : String(Math.min(9, gear));
    const boxW = 34 * s;
    const boxH = 25 * s;
    const boxX = cx - boxW * 0.5;
    const boxY = cy + r * 0.53;

    ctx.beginPath();
    chamferRectPath(ctx, boxX, boxY, boxW, boxH, 4 * s);
    ctx.fillStyle = 'rgba(4, 9, 16, 0.9)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
    ctx.stroke();

    this._font(ctx, 15 * s, 700, true);
    ctx.fillStyle = COL.amber;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(gearText, cx, boxY + boxH * 0.54);

    this._font(ctx, 7.5 * s, 700, true);
    ctx.fillStyle = COL.muted;
    ctx.fillText('GEAR', cx, boxY - 5 * s);
  }

  /* --------------------------------------------------------------- nitro -- */

  _drawNitro(ctx, st) {
    const s = this.s;
    const bar = this.nitro;
    const boosting = Boolean(st.boosting);
    const level = clamp01(this._smooth.nitro);

    const pad = 4 * s;
    ctx.beginPath();
    chamferRectPath(
      ctx,
      bar.x - pad,
      bar.y - pad,
      bar.w + pad * 2,
      bar.h + pad * 2,
      5 * s,
    );
    ctx.fillStyle = 'rgba(4, 9, 16, 0.55)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = boosting ? 'rgba(47, 214, 200, 0.75)' : COL.edgeSoft;
    ctx.stroke();

    this._font(ctx, 8.5 * s, 700, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = boosting ? COL.cyanBright : COL.muted;
    ctx.fillText('NOS', bar.x + bar.w * 0.5, bar.y - 9 * s);

    const gap = 3 * s;
    const segH = Math.max(2, (bar.h - gap * (NITRO_SEGMENTS - 1)) / NITRO_SEGMENTS);
    const filled = level * NITRO_SEGMENTS;
    const flicker = boosting ? 0.72 + 0.28 * (0.5 + 0.5 * Math.sin(this._now * 0.02)) : 1;

    for (let i = 0; i < NITRO_SEGMENTS; i += 1) {
      const segY = bar.y + bar.h - (i + 1) * segH - i * gap;
      const amount = clamp01(filled - i);
      if (amount <= 0) {
        ctx.beginPath();
        ctx.rect(bar.x, segY, bar.w, segH);
        ctx.fillStyle = 'rgba(120, 160, 190, 0.10)';
        ctx.fill();
        continue;
      }
      const segHeight = segH * amount;
      ctx.beginPath();
      ctx.rect(bar.x, segY + (segH - segHeight), bar.w, segHeight);
      if (boosting) {
        ctx.fillStyle = `rgba(122, 246, 234, ${(0.72 * flicker).toFixed(3)})`;
        ctx.shadowColor = 'rgba(47, 214, 200, 0.9)';
        ctx.shadowBlur = 9 * s;
      } else {
        ctx.fillStyle = COL.cyan;
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  /* --------------------------------------------------------------- drift -- */

  _drawDrift(ctx, st) {
    const amount = clamp01(this._smooth.drift);
    if (amount <= 0.15) return;

    const s = this.s;
    const p = this.drift;
    const heat = clamp01((amount - 0.15) / 0.85);

    ctx.beginPath();
    chamferRectPath(ctx, p.x, p.y, p.w, p.h, 5 * s);
    ctx.fillStyle = 'rgba(4, 9, 16, 0.6)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = heat > 0.7 ? 'rgba(255, 209, 102, 0.7)' : COL.edge;
    ctx.stroke();

    this._font(ctx, 9.5 * s, 700, true);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = heat > 0.7 ? COL.amber : COL.cyan;
    ctx.fillText(heat > 0.7 ? 'DRIFT!' : 'DRIFT', p.x + 8 * s, p.y + p.h * 0.55);

    const barX = p.x + 58 * s;
    const barW = Math.max(10, p.w - 58 * s - 9 * s);
    const barY = p.y + p.h * 0.55 - 2 * s;
    ctx.beginPath();
    ctx.rect(barX, barY, barW, 4 * s);
    ctx.fillStyle = 'rgba(120, 160, 190, 0.16)';
    ctx.fill();
    ctx.beginPath();
    ctx.rect(barX, barY, barW * amount, 4 * s);
    ctx.fillStyle = heat > 0.7 ? COL.amber : COL.cyan;
    if (heat > 0.7) {
      ctx.shadowColor = 'rgba(255, 209, 102, 0.85)';
      ctx.shadowBlur = 8 * s;
    }
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  /* --------------------------------------------------------- micro stats -- */

  _drawMicro(ctx, st) {
    const s = this.s;
    const fps = Math.round(num(st.fps, 0));
    const quality = typeof st.quality === 'string' ? st.quality.toUpperCase() : '—';

    this._font(ctx, 9.5 * s, 600, true);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = fps > 0 && fps < 45 ? COL.amber : COL.muted;
    ctx.fillText(`FPS ${fps > 0 ? fps : '—'} · ${quality}`, this.micro.x, this.micro.y);
    ctx.textAlign = 'left';
  }

  /* ---------------------------------------------------------- speedlines -- */

  _drawSpeedLines(ctx, st) {
    const amount = clamp01(num(st.speedLines, 0));
    if (amount <= 0.04) return;

    const { w, h } = this;
    const s = this.s;
    const cx = w * 0.5;
    const cy = h * 0.52;
    const inner = Math.min(w, h) * 0.33;
    const outer = Math.hypot(w, h) * 0.56;
    const boosting = Boolean(st.boosting);
    /* Keep this subtle: the CSS layer already carries the main speed-line read,
     * so the canvas only adds a faint radial streak vignette. */
    const alpha = (0.022 + amount * 0.082) * (boosting ? 1.45 : 1);

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = `rgba(158, 226, 255, ${Math.min(0.3, alpha).toFixed(3)})`;
    ctx.lineWidth = Math.max(1, s);
    ctx.beginPath();
    const streaks = this._streaks;
    for (let i = 0; i < streaks.length; i += 2) {
      const dx = streaks[i];
      const dy = streaks[i + 1];
      ctx.moveTo(cx + dx * inner, cy + dy * inner);
      ctx.lineTo(cx + dx * outer, cy + dy * outer);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ------------------------------------------------------------ overlays -- */

  _drawCountdown(ctx, st, now) {
    if (st.raceState !== 'countdown') {
      this._cdValue = null;
      return;
    }

    const s = this.s;
    const raw = num(st.countdown, 0);
    const value = Math.max(0, Math.round(raw));
    if (value !== this._cdValue) {
      this._cdValue = value;
      this._cdSince = now;
    }

    const isGo = value === 0;
    const text = isGo ? 'GO' : String(value);
    const t = Math.max(0, (now - this._cdSince) / 1000);
    const pop = Math.max(0, 1 - t / 0.45);
    const scale = 1 + pop * 1.15;
    const alpha = isGo
      ? clamp01(t < 0.04 ? t / 0.04 : 1 - Math.max(0, t - 0.28) / 0.5)
      : clamp01(t < 0.04 ? t / 0.04 : 1 - Math.max(0, t - 0.6) / 0.45);
    if (alpha <= 0.01) return;

    const { w, h } = this;
    const baseY = h * 0.42;

    /* Keep this label well clear of the giant digit's pop scale. */
    this._font(ctx, 11 * s, 700, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = COL.muted;
    ctx.globalAlpha = alpha * 0.9;
    ctx.fillText(isGo ? 'GO GO GO' : 'GET READY', w * 0.5, baseY - 152 * s);
    ctx.globalAlpha = 1;

    ctx.save();
    ctx.translate(w * 0.5, baseY);
    ctx.scale(scale, scale);
    ctx.globalAlpha = alpha;
    this._font(ctx, (isGo ? 104 : 112) * s, 700, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = 'rgba(192, 77, 255, 0.48)';
    ctx.fillText(text, -4 * s, 0);
    ctx.fillStyle = 'rgba(47, 214, 200, 0.55)';
    ctx.fillText(text, 4 * s, 0);

    ctx.shadowColor = isGo ? 'rgba(47, 214, 200, 0.9)' : 'rgba(47, 214, 200, 0.6)';
    ctx.shadowBlur = 40 * s;
    ctx.fillStyle = isGo ? COL.cyanBright : COL.white;
    ctx.fillText(text, 0, 0);
    ctx.shadowBlur = 0;
    ctx.restore();

    this._fontKey = null;
  }

  _drawToast(ctx, st, now) {
    const toast = st && st.toast;
    const hasText =
      toast &&
      typeof toast === 'object' &&
      typeof toast.text === 'string' &&
      toast.text.trim().length > 0;

    let alpha = 0;
    if (hasText) {
      if (this._toastText !== toast.text) {
        this._toastText = toast.text;
        this._toastSince = now;
      }
      this._toastLastSeen = now;
      /* The contract also allows an absolute `until` — honour it when it looks
       * like a timestamp ahead of us; otherwise let the driver null the toast. */
      const until = num(toast.until, NaN);
      if (Number.isFinite(until) && until > now) {
        alpha = clamp01((until - now) / 240);
      } else {
        alpha = clamp01((now - this._toastSince) / 120);
      }
    } else if (this._toastText) {
      const gone = now - this._toastLastSeen;
      if (gone > TOAST_FADE_MS) {
        this._toastText = null;
        return;
      }
      alpha = clamp01(1 - gone / TOAST_FADE_MS);
    }
    if (!this._toastText || alpha <= 0.01) return;

    const s = this.s;
    const { w, h } = this;
    const text = String(this._toastText).toUpperCase();

    this._font(ctx, 12 * s, 700, true);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let textWidth = 160 * s;
    try {
      const measured = ctx.measureText(text);
      if (measured && Number.isFinite(measured.width)) textWidth = measured.width;
    } catch {
      /* stub contexts may not measure — fall back to a sane pill width */
    }
    const padX = 18 * s;
    const boxW = Math.min(w - 32 * s, textWidth + padX * 2);
    const boxH = 30 * s;
    const boxX = w * 0.5 - boxW * 0.5;
    const boxY = this.margin + 6 * s;

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    chamferRectPath(ctx, boxX, boxY, boxW, boxH, 6 * s);
    ctx.fillStyle = 'rgba(3, 8, 14, 0.86)';
    ctx.fill();
    ctx.lineWidth = Math.max(1, s);
    ctx.strokeStyle = 'rgba(47, 214, 200, 0.5)';
    ctx.stroke();

    ctx.fillStyle = COL.white;
    ctx.fillText(text, w * 0.5, boxY + boxH * 0.54);
    ctx.globalAlpha = 1;
  }
}

/* ---------------------------------------------------------------- factory -- */

/**
 * Create the HUD overlay controller.
 *
 * @param {{canvas: HTMLCanvasElement, width?: number, height?: number, dpr?: number}} options
 * @returns {{resize: (width:number, height:number, dpr?:number)=>void,
 *            draw: (state: HudState)=>void,
 *            reset: ()=>void}}
 */
export function createHud(options = {}) {
  const canvas = options && options.canvas ? options.canvas : null;
  let ctx = null;
  if (canvas && typeof canvas.getContext === 'function') {
    try {
      ctx = canvas.getContext('2d');
    } catch {
      ctx = null;
    }
  }

  const hud = new Hud(canvas, ctx);
  hud.resize(num(options.width, 1280), num(options.height, 720), num(options.dpr, 1));
  return hud;
}

export default createHud;
