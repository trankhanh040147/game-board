/**
 * FIRST HEARTH — atmosphere & particle effects
 * --------------------------------------------
 * Smoke plumes, fireflies, drifting cloud shadows, rain / snow / storm
 * particles, the day-night ambient tint and the final film-grain + vignette
 * grade. All cosmetic; the simulation never sees any of it.
 */
import type { GameSettings, WeatherState, WorldState } from '../sim/types';
import type { Camera } from './camera';
import { Palette } from './palette';
import { SpriteBank } from './sprites';
import { clamp01, cssColor, cssColorAlpha, mixColor, mod, smoothstep } from './utils';

interface Puff {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  tone: number;
}

interface Firefly {
  x: number;
  y: number;
  phase: number;
  speed: number;
  size: number;
  drift: number;
}

interface WeatherBit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  len: number;
  alpha: number;
}

interface Cloud {
  x: number;
  y: number;
  scale: number;
  speed: number;
  alpha: number;
}

export interface SmokeEmitter {
  x: number;
  y: number;
  strength: number;
}

export class Fx {
  private palette: Palette;
  private bank: SpriteBank;

  private puffs: Puff[] = [];
  private fireflies: Firefly[] = [];
  private rain: WeatherBit[] = [];
  private snow: WeatherBit[] = [];
  private clouds: Cloud[] = [];
  private spawnAcc = 0;
  private rainAcc = 0;
  private snowAcc = 0;
  private frames = 0;
  private reducedMotion = false;
  private density = 0.7;
  private lightnings: { x: number; life: number; width: number; seed: number }[] = [];
  private lightningTimer = 4;
  private pattern: CanvasPattern | null = null;
  private patternCtx: CanvasRenderingContext2D | null = null;
  private vignetteSize = '';
  private vignetteSprite: { canvas: HTMLCanvasElement } | null = null;

  particleCount = 0;

  constructor(palette: Palette, bank: SpriteBank) {
    this.palette = palette;
    this.bank = bank;
    this.resetClouds();
  }

  setSettings(settings: GameSettings | undefined): void {
    if (!settings) return;
    this.reducedMotion = !!settings.reducedMotion;
    this.density = clamp01(settings.particleDensity ?? 0.7);
  }

  reset(): void {
    this.puffs.length = 0;
    this.fireflies.length = 0;
    this.rain.length = 0;
    this.snow.length = 0;
    this.resetClouds();
  }

  private resetClouds(): void {
    this.clouds = [
      { x: -300, y: 240, scale: 4.6, speed: 9, alpha: 0.9 },
      { x: 900, y: 700, scale: 6.2, speed: 6, alpha: 0.7 },
      { x: 1600, y: -200, scale: 3.8, speed: 12, alpha: 0.8 },
    ];
  }

  /** Advance all cosmetic systems. */
  update(
    dt: number,
    world: WorldState | null,
    weather: WeatherState | null,
    camera: Camera,
    timeMs: number,
    emitters: SmokeEmitter[],
  ): void {
    this.frames++;
    const step = Math.min(0.05, Math.max(0, dt));
    const density = this.density;
    const motion = this.reducedMotion ? 0.25 : 1;

    // -- cloud drift --------------------------------------------------------
    if (world) {
      const wind = weather?.wind ?? 0.4;
      const span = (world.width + world.height) * 24;
      for (const c of this.clouds) {
        c.x += c.speed * (0.4 + wind) * step * motion;
        c.x = mod(c.x + 2600, span + 1200) - 800;
      }
    }

    // -- smoke --------------------------------------------------------------
    if (!this.reducedMotion) {
      this.spawnAcc += step;
      const spawnInterval = 0.16;
      let budget = 26;
      while (this.spawnAcc > spawnInterval && budget-- > 0) {
        this.spawnAcc -= spawnInterval;
        for (const e of emitters) {
          if (this.puffs.length >= 240) break;
          if (Math.random() > e.strength * 0.6) continue;
          const tone = 0.45 + Math.random() * 0.4;
          this.puffs.push({
            x: e.x + (Math.random() - 0.5) * 4,
            y: e.y + (Math.random() - 0.5) * 3,
            vx: (Math.random() - 0.5) * 3,
            vy: -5 - Math.random() * 4,
            life: 0,
            maxLife: 2.6 + Math.random() * 2.4,
            size: 4 + Math.random() * 6,
            tone,
          });
        }
      }
    }
    for (let i = this.puffs.length - 1; i >= 0; i--) {
      const p = this.puffs[i];
      p.life += step;
      if (p.life >= p.maxLife) {
        this.puffs.splice(i, 1);
        continue;
      }
      p.x += (p.vx + Math.sin(p.life * 1.6 + p.y) * 1.6) * step * motion;
      p.y += p.vy * step * motion;
      p.size += step * 3.4 * motion;
    }

    // -- fireflies ----------------------------------------------------------
    const phase = this.palette.dayPhase(timeMs);
    const amb = this.palette.ambient(phase);
    const night = amb.nightness;
    const visible = camera.visibleMap();
    const targetFireflies = Math.round(night * 26 * density + (this.palette.season === 'summer' ? 8 : 0));
    while (this.fireflies.length < targetFireflies) {
      this.fireflies.push({
        x: visible.left + Math.random() * (visible.right - visible.left),
        y: visible.top + Math.random() * (visible.bottom - visible.top),
        phase: Math.random() * Math.PI * 2,
        speed: 0.5 + Math.random() * 1.2,
        size: 1.2 + Math.random() * 1.4,
        drift: 18 + Math.random() * 30,
      });
    }
    if (this.fireflies.length > targetFireflies) this.fireflies.length = targetFireflies;
    for (const f of this.fireflies) {
      f.x += Math.sin(this.frames * 0.01 * f.speed + f.phase) * f.drift * step * motion * 0.1;
      f.y += Math.cos(this.frames * 0.008 * f.speed + f.phase) * f.drift * step * motion * 0.06;
      if (f.x < visible.left - 80) f.x = visible.right + 60;
      if (f.x > visible.right + 80) f.x = visible.left - 60;
      if (f.y < visible.top - 80) f.y = visible.bottom + 60;
      if (f.y > visible.bottom + 80) f.y = visible.top - 60;
    }

    // -- weather particles (screen space) ----------------------------------
    const rainAmt = clamp01((weather?.rainfall ?? 0) * 1.1 + (weather?.storm ?? 0) * 1.3 - 0.15);
    const snowAmt = this.palette.season === 'winter' ? clamp01((weather?.snow ?? 0) * 1.2 - 0.05) : 0;
    const wind = weather?.wind ?? 0.3;
    const targetRain = Math.round(rainAmt * 340 * density);
    const targetSnow = Math.round(snowAmt * 220 * density + (this.palette.season === 'winter' ? 30 * density : 0));
    this.rainAcc += targetRain * step * 1.6;
    while (this.rain.length < targetRain && this.rain.length < 420) {
      this.rain.push({
        x: Math.random() * (camera.viewW + 300) - 150,
        y: Math.random() * camera.viewH - camera.viewH,
        vx: (30 + wind * 130) * (0.8 + Math.random() * 0.5),
        vy: 420 + Math.random() * 240,
        len: 8 + Math.random() * 12,
        alpha: 0.1 + Math.random() * 0.2,
      });
    }
    if (this.rain.length > targetRain) this.rain.length = targetRain;
    if (!this.reducedMotion) {
      for (const r of this.rain) {
        r.x += r.vx * step;
        r.y += r.vy * step;
        if (r.y > camera.viewH + 20) {
          r.y = -20 - Math.random() * 60;
          r.x = Math.random() * (camera.viewW + 300) - 150;
        }
        if (r.x > camera.viewW + 20) r.x -= camera.viewW + 300;
      }
    }
    this.snowAcc += targetSnow * step * 1.2;
    while (this.snow.length < targetSnow && this.snow.length < 360) {
      this.snow.push({
        x: Math.random() * (camera.viewW + 200) - 100,
        y: Math.random() * camera.viewH - camera.viewH,
        vx: (wind - 0.5) * 40 + (Math.random() - 0.5) * 16,
        vy: 18 + Math.random() * 26,
        len: 1.2 + Math.random() * 2,
        alpha: 0.3 + Math.random() * 0.4,
      });
    }
    if (this.snow.length > targetSnow) this.snow.length = targetSnow;
    if (!this.reducedMotion) {
      for (const s of this.snow) {
        s.x += (s.vx * step + Math.sin(this.frames * 0.02 + s.y * 0.02) * 8 * step);
        s.y += s.vy * step;
        if (s.y > camera.viewH + 10) {
          s.y = -10;
          s.x = Math.random() * (camera.viewW + 200) - 100;
        }
      }
    }

    // -- lightning ---------------------------------------------------------
    if ((weather?.storm ?? 0) > 0.35 && !this.reducedMotion) {
      this.lightningTimer -= step;
      if (this.lightningTimer <= 0) {
        this.lightningTimer = 5 + Math.random() * 9;
        this.lightnings.push({ x: Math.random() * camera.viewW, life: 0.22, width: 1.4 + Math.random() * 1.6, seed: Math.random() * 1000 });
      }
    }
    for (let i = this.lightnings.length - 1; i >= 0; i--) {
      this.lightnings[i].life -= step;
      if (this.lightnings[i].life <= 0) this.lightnings.splice(i, 1);
    }

    this.particleCount = this.puffs.length + this.fireflies.length + this.rain.length + this.snow.length;
  }

  // ------------------------------------------------------------------
  // World-space layers (drawn with the map transform active)
  // ------------------------------------------------------------------

  drawClouds(ctx: CanvasRenderingContext2D, world: WorldState | null, ambient: { alpha: number; nightness: number }, timeMs: number): void {
    if (!world || this.reducedMotion) return;
    const sprite = this.bank.cloud();
    const day = 1 - ambient.nightness;
    for (let i = 0; i < this.clouds.length; i++) {
      const c = this.clouds[i];
      const sx = c.x;
      const sy = c.y + Math.sin(timeMs * 0.00006 + i * 2.1) * 60;
      const w = sprite.mapW * c.scale * 0.7;
      ctx.globalAlpha = clamp01(c.alpha * day * 0.14);
      ctx.drawImage(sprite.canvas, sx - w / 2, sy - w / 2, w, w);
    }
    ctx.globalAlpha = 1;
  }

  drawSmoke(ctx: CanvasRenderingContext2D): void {
    if (!this.puffs.length) return;
    const sprite = this.bank.smokePuff();
    for (const p of this.puffs) {
      const u = p.life / p.maxLife;
      const alpha = (1 - u) * 0.42 * (0.5 + p.tone * 0.5) * smoothstep(0, 0.18, u);
      if (alpha <= 0.005) continue;
      const size = sprite.mapW * (p.size / 16);
      ctx.globalAlpha = alpha;
      ctx.drawImage(sprite.canvas, p.x - size / 2, p.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  drawFireflies(ctx: CanvasRenderingContext2D, nightness: number, timeMs: number): void {
    if (nightness < 0.08 || !this.fireflies.length) return;
    const sprite = this.bank.glow(0xffd27a);
    for (const f of this.fireflies) {
      const pulse = 0.45 + 0.55 * Math.sin(timeMs * 0.0022 + f.phase) ** 2;
      const size = sprite.mapW * (f.size / 6) * 1.4;
      ctx.globalAlpha = clamp01(nightness * pulse * 0.75);
      ctx.drawImage(sprite.canvas, f.x - size / 2, f.y - size / 2, size, size);
    }
    ctx.globalAlpha = 1;
  }

  // ------------------------------------------------------------------
  // Screen-space layers
  // ------------------------------------------------------------------

  /** Day/night ambient tint + storm gloom. */
  drawAmbient(ctx: CanvasRenderingContext2D, w: number, h: number, phase: number): void {
    const amb = this.palette.ambient(phase);
    if (amb.alpha <= 0.004) {
      // even at noon a faint warm wash keeps the painterly unity
      ctx.fillStyle = cssColorAlpha(0xfff0d0, 0.015);
      ctx.fillRect(0, 0, w, h);
      return;
    }
    ctx.fillStyle = cssColorAlpha(amb.color, amb.alpha);
    ctx.fillRect(0, 0, w, h);
    // warm horizon glow at dawn/dusk
    if (amb.warm > 0.05) {
      const g = ctx.createLinearGradient(0, 0, 0, h * 0.55);
      const warm = mixColor(0xff9d4d, 0xffd9a0, 0.4);
      g.addColorStop(0, cssColorAlpha(warm, 0.18 * amb.warm));
      g.addColorStop(1, cssColorAlpha(warm, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h * 0.55);
    }
    // storm: cold grey veil
    if (this.palette.storm > 0.1) {
      ctx.fillStyle = cssColorAlpha(0x39424c, 0.16 * this.palette.storm);
      ctx.fillRect(0, 0, w, h);
    }
  }

  /** Screen-space weather: rain streaks, snowflakes, lightning. */
  drawWeather(ctx: CanvasRenderingContext2D, w: number, h: number, timeMs: number): void {
    if (this.rain.length) {
      ctx.strokeStyle = cssColorAlpha(0xd6e2ea, 0.3);
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of this.rain) {
        ctx.globalAlpha = r.alpha;
        ctx.moveTo(r.x, r.y);
        ctx.lineTo(r.x - r.vx * 0.02, r.y - r.len);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    if (this.snow.length) {
      ctx.fillStyle = '#e8f0f6';
      for (const s of this.snow) {
        ctx.globalAlpha = s.alpha * 0.8;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.len, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
    for (const l of this.lightnings) {
      if (l.life <= 0) continue;
      const alpha = (l.life / 0.22) * 0.8;
      ctx.fillStyle = cssColorAlpha(0xe8f0ff, alpha * 0.3);
      ctx.fillRect(0, 0, w, h);
      // jagged bolt
      ctx.strokeStyle = cssColorAlpha(0xffffff, alpha);
      ctx.lineWidth = l.width;
      ctx.beginPath();
      let bx = l.x;
      let by = 0;
      ctx.moveTo(bx, by);
      let seed = l.seed;
      while (by < h * 0.8) {
        seed = mod(seed * 16807, 2147483647);
        const r = (seed / 2147483647) * 2 - 1;
        bx += r * 70;
        by += h * 0.16;
        ctx.lineTo(bx, by);
      }
      ctx.stroke();
    }
    void timeMs;
  }

  /** Final grade: vignette + paper grain + warm candle edge. */
  drawGrade(ctx: CanvasRenderingContext2D, w: number, h: number, dpr: number): void {
    const key = `${w}x${h}@${Math.round(dpr * 10)}`;
    if (key !== this.vignetteSize) {
      this.vignetteSize = key;
      this.vignetteSprite = { canvas: this.bank.vignette(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), key).canvas };
    }
    if (this.vignetteSprite) {
      ctx.globalAlpha = 0.66;
      ctx.drawImage(this.vignetteSprite.canvas, 0, 0, w, h);
      ctx.globalAlpha = 1;
    }
    // grain
    if (!this.pattern && !this.patternCtx) {
      const grain = this.bank.grain();
      const pctx = grain.canvas.getContext('2d');
      if (pctx) {
        this.patternCtx = ctx;
        this.pattern = ctx.createPattern(grain.canvas, 'repeat');
      }
    }
    if (this.pattern && ctx === this.patternCtx) {
      ctx.save();
      ctx.globalCompositeOperation = 'overlay';
      ctx.globalAlpha = 0.026;
      ctx.fillStyle = this.pattern;
      ctx.fillRect(0, 0, w, h);
      ctx.restore();
    }
  }

  /** Small additive glow (window lights, campfires). */
  drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: number, alpha: number): void {
    const sprite = this.bank.glow(color);
    ctx.globalAlpha = clamp01(alpha);
    ctx.drawImage(sprite.canvas, x - radius, y - radius, radius * 2, radius * 2);
    ctx.globalAlpha = 1;
  }

  /** Lightning flash used by screenshots to show storms. */
  triggerLightning(): void {
    this.lightnings.push({ x: Math.random() * 800, life: 0.3, width: 2, seed: Math.random() * 1000 });
  }
}
