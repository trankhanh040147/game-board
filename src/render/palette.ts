/**
 * FIRST HEARTH — palette & atmosphere
 * -----------------------------------
 * Turns the content pack's biome colours plus world weather/season/time into the
 * renderer's colour language: painterly ground tones, cliff/earth faces, water,
 * snow, overlays, day-night ambient and settlement accents.
 *
 * Everything returns packed 0xRRGGBB integers so blending is cheap.
 */
import type { BiomeDef, Content, SeasonId, Tile, WorldState } from '../sim/types';
import {
  ELEV_PX,
  SEA_LEVEL,
  clamp01,
  clamp,
  cssColor,
  fbm2,
  hash2,
  hexColor,
  hslColor,
  lerp,
  lightenColor,
  mixColor,
  saturateColor,
  shadeColor,
  smoothstep,
  darkenColor,
} from './utils';

export type TreeSpecies = 'oak' | 'pine' | 'willow' | 'acacia' | 'palm' | 'reed' | 'bush' | 'snag';

export interface BiomeStyle {
  id: string;
  def: BiomeDef | null;
  base: number;
  alt: number;
  water: number;
  isWaterBiome: boolean;
  hasForest: boolean;
  isCold: boolean;
  isArid: boolean;
  /** Resolved colours after the current season/snow pass. */
  ground: number;
  groundAlt: number;
  groundWet: number;
  waterResolved: number;
}

interface DayKey {
  t: number;
  color: number;
  alpha: number;
}

/** Warm dawn -> pale noon -> ember dusk -> deep blue night.
 *  Daylight (07:00-18:00) is essentially untinted so the world reads bright. */
const DAY_KEYS: DayKey[] = [
  { t: 0.0, color: 0x1b2a4a, alpha: 0.3 },
  { t: 0.14, color: 0x22304c, alpha: 0.24 },
  { t: 0.21, color: 0xd98a5a, alpha: 0.12 },
  { t: 0.27, color: 0xffcf9a, alpha: 0.045 },
  { t: 0.34, color: 0xfff3d6, alpha: 0.0 },
  { t: 0.66, color: 0xfff0cf, alpha: 0.0 },
  { t: 0.74, color: 0xffbe84, alpha: 0.055 },
  { t: 0.8, color: 0xe2703c, alpha: 0.14 },
  { t: 0.88, color: 0x2e3358, alpha: 0.24 },
  { t: 1.0, color: 0x1b2a4a, alpha: 0.3 },
];

const SEASON_INDEX: Record<SeasonId, number> = { spring: 0, summer: 1, autumn: 2, winter: 3 };

/** Overlay ramp definitions: [value, colour] control points. */
interface RampDef {
  label: string;
  stops: { v: number; c: number }[];
}

const RAMP_DEFS: Record<string, RampDef> = {
  fertility: {
    label: 'Soil fertility',
    stops: [
      { v: 0, c: 0x6b5638 },
      { v: 0.28, c: 0x8a7440 },
      { v: 0.55, c: 0x8fa04a },
      { v: 0.8, c: 0x5f9a3f },
      { v: 1, c: 0x2f7a35 },
    ],
  },
  forest: {
    label: 'Forest cover',
    stops: [
      { v: 0, c: 0xcbb98d },
      { v: 0.3, c: 0x9aa860 },
      { v: 0.6, c: 0x4f7f3c },
      { v: 0.85, c: 0x2e5f2c },
      { v: 1, c: 0x1c4524 },
    ],
  },
  water: {
    label: 'Fresh water',
    stops: [
      { v: 0, c: 0xcbb98d },
      { v: 0.25, c: 0x9fbfa4 },
      { v: 0.5, c: 0x5f9fb5 },
      { v: 0.78, c: 0x3f7fa8 },
      { v: 1, c: 0x2a5f92 },
    ],
  },
  pollution: {
    label: 'Pollution',
    stops: [
      { v: 0, c: 0x6f9a5a },
      { v: 0.25, c: 0xb9a24a },
      { v: 0.5, c: 0xc07a3f },
      { v: 0.78, c: 0x9e4a5e },
      { v: 1, c: 0x6f2f70 },
    ],
  },
  beauty: {
    label: 'Natural beauty',
    stops: [
      { v: 0, c: 0x5a5248 },
      { v: 0.3, c: 0x8f8168 },
      { v: 0.6, c: 0xc9a55b },
      { v: 0.85, c: 0xe6c47e },
      { v: 1, c: 0xf0d9a0 },
    ],
  },
};

function rampColor(stops: { v: number; c: number }[], t: number): number {
  const v = clamp01(t);
  if (v <= stops[0].v) return stops[0].c;
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i].v) {
      const a = stops[i - 1];
      const b = stops[i];
      const u = (v - a.v) / Math.max(1e-6, b.v - a.v);
      return mixColor(a.c, b.c, u);
    }
  }
  return stops[stops.length - 1].c;
}

export class Palette {
  content: Content;
  season: SeasonId = 'summer';
  seasonIndex = 1;
  snow = 0;
  temperature = 14;
  rainfall = 0;
  storm = 0;
  private styles = new Map<string, BiomeStyle>();
  private sortedBiomes: string[] = [];

  constructor(content: Content) {
    this.content = content;
    for (const id of content.biomeOrder) {
      const def = content.biomes[id];
      if (def) this.addBiome(def);
    }
    for (const id of Object.keys(content.biomes)) {
      if (!this.styles.has(id)) this.addBiome(content.biomes[id]);
    }
    this.sortedBiomes = [...this.styles.keys()];
    this.applySeason();
  }

  private addBiome(def: BiomeDef): void {
    const tags = def.tags ?? [];
    this.styles.set(def.id, {
      id: def.id,
      def,
      base: hexColor(def.color),
      alt: hexColor(def.colorAlt),
      water: hexColor(def.waterColor),
      isWaterBiome: tags.includes('water') || (def.walkCost ?? 0) >= 50,
      hasForest: (def.forest ?? 0) >= 0.4 || tags.includes('timber') || tags.includes('forest'),
      isCold: (def.tempRange?.[1] ?? 20) <= 16 || tags.includes('cold') || tags.includes('taiga'),
      isArid: (def.rain ?? 0.4) < 0.2 || tags.includes('desert') || tags.includes('dry'),
      ground: hexColor(def.color),
      groundAlt: hexColor(def.colorAlt),
      groundWet: hexColor(def.color),
      waterResolved: hexColor(def.waterColor),
    });
  }

  /** Update the seasonal / weather-driven colour resolve. Returns true if anything changed. */
  /**
   * Update weather inputs. Returns true only when the *terrain palette* actually
   * needs rebuilding. Rain, storm and small temperature changes are applied to
   * the ambient/atmosphere inputs every frame without invalidating the baked
   * terrain (rebuilding all chunks for a 3 °C change was the main source of
   * frame hitches). Terrain is rebuilt only on season change, a snow-band
   * change or crossing the freezing line.
   */
  setConditions(season: SeasonId, snow: number, temperature: number, rainfall: number, storm: number): boolean {
    const nextSnow = Math.round(clamp01(snow) * 10) / 10;
    const nextTemp = Math.round(temperature);
    const nextRain = Math.round(clamp01(rainfall) * 8) / 8;
    const nextStorm = Math.round(clamp01(storm) * 8) / 8;
    const snowBand = Math.round(clamp01(snow) * 5);
    const tempSign = temperature < 0 ? -1 : 1;
    const changed =
      season !== this.season ||
      snowBand !== Math.round(clamp01(this.snow) * 5) ||
      tempSign !== (this.temperature < 0 ? -1 : 1);
    this.season = season;
    this.seasonIndex = SEASON_INDEX[season] ?? 1;
    this.snow = nextSnow;
    this.temperature = nextTemp;
    this.rainfall = nextRain;
    this.storm = nextStorm;
    if (changed) this.applySeason();
    return changed;
  }

  private applySeason(): void {
    const si = this.seasonIndex;
    for (const st of this.styles.values()) {
      let g = st.base;
      let a = st.alt;
      let w = st.water;
      const tags = st.def?.tags ?? [];
      const foresty = st.hasForest || tags.includes('timber');
      switch (si) {
        case 0: // spring — fresh, a little chalky, blossom in the air
          g = saturateColor(mixColor(g, 0x9ecf6a, foresty ? 0.2 : 0.12), 1.06);
          a = saturateColor(mixColor(a, 0xb6dc82, 0.16), 1.05);
          w = mixColor(w, 0x7fc4d6, 0.12);
          break;
        case 1: // summer — lush, warm
          g = saturateColor(mixColor(g, 0xc9a03a, 0.04), 1.08);
          a = saturateColor(mixColor(a, 0xd3b052, 0.05), 1.06);
          w = mixColor(w, 0x3f9fc4, 0.06);
          break;
        case 2: // autumn — gold and rust
          g = mixColor(g, foresty ? 0xc08a3a : 0xc9a95e, foresty ? 0.3 : 0.2);
          a = mixColor(a, foresty ? 0xd9a44a : 0xd4b878, foresty ? 0.32 : 0.22);
          g = saturateColor(g, 1.08);
          w = mixColor(w, 0x6f9fa8, 0.1);
          break;
        default: {
          // winter — cold, desaturated
          g = saturateColor(mixColor(g, 0xa9b8c6, 0.3), 0.62);
          a = saturateColor(mixColor(a, 0xbcc9d2, 0.32), 0.6);
          w = mixColor(w, 0x93b4c6, 0.3);
          break;
        }
      }
      // climate tint: dry land bleaches, wet land deepens
      if (st.isArid) g = mixColor(g, 0xd8c896, 0.1);
      st.ground = g;
      st.groundAlt = a;
      st.groundWet = mixColor(g, 0x3f6a4a, 0.22);
      st.waterResolved = w;
    }
  }

  styleById(id: string): BiomeStyle {
    return (
      this.styles.get(id) ?? {
        id,
        def: null,
        base: 0x6f8f4a,
        alt: 0x87a45c,
        water: 0x4aa0c0,
        isWaterBiome: false,
        hasForest: false,
        isCold: false,
        isArid: false,
        ground: 0x6f8f4a,
        groundAlt: 0x87a45c,
        groundWet: 0x55714a,
        waterResolved: 0x4aa0c0,
      }
    );
  }

  style(t: Tile): BiomeStyle {
    return this.styleById(t.biome);
  }

  // -- tile classification --------------------------------------------------

  /** Open water surface (ocean or lake). */
  isWaterSurface(t: Tile): boolean {
    return this.style(t).isWaterBiome || t.water >= 0.985;
  }

  isRiver(t: Tile): boolean {
    return !this.isWaterSurface(t) && t.water >= 0.72;
  }

  hasWater(t: Tile): boolean {
    return this.isWaterSurface(t) || this.isRiver(t);
  }

  /** Land that can carry trees / buildings. */
  isLand(t: Tile): boolean {
    return !this.isWaterSurface(t);
  }

  /** Map-space elevation height in pixels. Water sits on a flat plane. */
  heightPx(t: Tile): number {
    if (this.isWaterSurface(t)) {
      // ocean is a single plane; lakes/rivers sit just below their banks
      if (t.elev <= SEA_LEVEL + 0.02) return 2;
      return clamp((t.elev - SEA_LEVEL) * ELEV_PX * 0.82 - 3, 2, ELEV_PX);
    }
    if (this.isRiver(t)) return clamp((t.elev - SEA_LEVEL) * ELEV_PX * 1.06 - 4, 0, ELEV_PX);
    return clamp((t.elev - SEA_LEVEL) * ELEV_PX * 1.06, 0, ELEV_PX * 1.1);
  }

  /** Smoother water level (average of nearby water tiles) to avoid stepped rivers. */
  smoothHeightPx(w: WorldState, x: number, y: number): number {
    const t = w.tiles[y * w.width + x];
    if (!t) return 0;
    if (!this.hasWater(t)) return this.heightPx(t);
    let sum = 0;
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= w.width || yy >= w.height) continue;
        const nb = w.tiles[yy * w.width + xx];
        if (!nb || !this.hasWater(nb)) continue;
        sum += this.isWaterSurface(nb) ? (nb.elev <= SEA_LEVEL + 0.02 ? 2 : clamp((nb.elev - SEA_LEVEL) * ELEV_PX * 0.82 - 3, 2, ELEV_PX)) : clamp((nb.elev - SEA_LEVEL) * ELEV_PX * 1.06 - 4, 0, ELEV_PX);
        n++;
      }
    }
    return n ? sum / n : this.heightPx(t);
  }

  // -- lighting -------------------------------------------------------------

  /** Directional sun shading from neighbouring elevation (light from upper-left). */
  shadeAt(w: WorldState, x: number, y: number): number {
    const w0 = w.width;
    const h0 = w.height;
    const idx = y * w0 + x;
    const tiles = w.tiles;
    const t = tiles[idx];
    if (!t) return 1;
    const e = t.elev;
    let ex = 0;
    let ey = 0;
    if (x > 0) ex += tiles[idx - 1].elev;
    if (x < w0 - 1) ex -= tiles[idx + 1].elev;
    if (y > 0) ey += tiles[idx - w0].elev;
    if (y < h0 - 1) ey -= tiles[idx + w0].elev;
    // gradient points down-right => faces the upper-left sun => brighter
    const lit = ex * 0.75 + ey * 0.42;
    let s = 1 + lit * 3.0;
    // higher ground catches more light, valleys are cooler & darker
    s += (t.elev - 0.45) * 0.26;
    if (this.isWaterSurface(t)) s = 1;
    return clamp(s, 0.72, 1.26);
  }

  /** Local depth cue: concave ground gets a soft occlusion. */
  occlusionAt(w: WorldState, x: number, y: number): number {
    const w0 = w.width;
    const h0 = w.height;
    const idx = y * w0 + x;
    const tiles = w.tiles;
    const t = tiles[idx];
    if (!t) return 1;
    let sum = 0;
    let n = 0;
    if (x > 0) {
      sum += tiles[idx - 1].elev;
      n++;
    }
    if (x < w0 - 1) {
      sum += tiles[idx + 1].elev;
      n++;
    }
    if (y > 0) {
      sum += tiles[idx - w0].elev;
      n++;
    }
    if (y < h0 - 1) {
      sum += tiles[idx + w0].elev;
      n++;
    }
    if (!n) return 1;
    const avg = sum / n;
    return clamp(1 + (t.elev - avg) * 1.1, 0.82, 1.12);
  }

  // -- colours --------------------------------------------------------------

  private snowAmount(t: Tile, x: number, y: number): number {
    if (this.snow <= 0.02) return 0;
    // cold places keep more snow; elevation adds; noise breaks up the blanket
    const cold = clamp01((6 - (t.temp ?? 10)) / 16) * 0.7 + 0.3;
    const elevBoost = clamp01((t.elev - 0.55) / 0.4) * 0.5;
    const n = fbm2(x * 0.22 + 3, y * 0.22 + 7, 91) * 0.5 + 0.5;
    const amt = clamp01((this.snow * 1.35 - 0.12) * (cold + elevBoost) * (0.7 + n * 0.6));
    return amt;
  }

  /** Top-face ground colour (without directional shading). */
  groundColor(t: Tile, x: number, y: number): number {
    const st = this.style(t);
    const n1 = hash2(x, y, 11);
    const n2 = fbm2(x * 0.17, y * 0.17, 23);
    const n3 = hash2(x * 3 + 7, y * 5 + 3, 41);
    // large-scale clumps (meadows / patches) keep large fields from looking flat
    const clump = fbm2(x * 0.052 + 31, y * 0.052 + 17, 61);
    const clump2 = fbm2(x * 0.11 + 5, y * 0.11 + 9, 83);
    let c = mixColor(st.ground, st.groundAlt, clamp01(n2 * 0.55 + clump * 0.45));
    // painterly lift + depth: mid greens stay readable but not washed out
    c = lightenColor(c, 0.035 + clump * 0.035);
    c = saturateColor(c, 1.12);
    c = mixColor(c, 0x2c4422, 0.1);
    // moisture: wetter soil is deeper & greener
    const wet = clamp01((t.moisture ?? 0.4) * 0.62 + (t.water ?? 0) * 0.5);
    c = mixColor(c, st.groundWet, wet * 0.22);
    // altitude: rocky/bright shoulder high, cool moss low
    const high = smoothstep(0.45, 0.92, t.elev);
    c = mixColor(c, 0xc9c3b2, high * 0.18);
    if (t.elev > 0.9) c = mixColor(c, 0xb9bcc0, 0.22);
    // sunlit meadow wash
    c = mixColor(c, 0xe8d9a0, clamp01(clump2 - 0.58) * 0.08);
    // fertility warms worked/fertile soil
    if ((t.fertility ?? 0) > 0.6) c = mixColor(c, 0x93a84e, 0.09);
    // per-tile grain
    c = shadeColor(c, 0.96 + n1 * 0.07 + n3 * 0.03);
    // snow blanket
    const snow = this.snowAmount(t, x, y);
    if (snow > 0.01) {
      c = mixColor(c, mixColor(0xe7eef4, 0xd0dde8, n3), clamp01(snow));
    }
    return c;
  }

  /** Rock / earth colour for the visible south-facing cliff walls. */
  sideColor(t: Tile, x: number, y: number, side: 0 | 1): number {
    const st = this.style(t);
    if (this.hasWater(t)) {
      // water walls read as deep water shadow
      return mixColor(st.waterResolved, 0x0e2634, side === 0 ? 0.42 : 0.56);
    }
    const n = hash2(x * 5 + 1, y * 7 + 2, 67);
    let rock = mixColor(darkenColor(st.ground, 0.32), 0x6b5a44, 0.35 + n * 0.2);
    if (t.elev > 0.68) rock = mixColor(rock, 0x8a8a86, 0.42);
    if (this.snowAmount(t, x, y) > 0.3) rock = mixColor(rock, 0xd6e2ea, 0.4);
    const strata = 0.94 + hash2(x, y, 113) * 0.1;
    return shadeColor(rock, (side === 0 ? 0.92 : 1.0) * strata);
  }

  waterColor(t: Tile, x: number, y: number): number {
    const st = this.style(t);
    const depth = clamp01((SEA_LEVEL + 0.08 - t.elev) / 0.34);
    let c = mixColor(st.waterResolved, 0x143f5a, depth * 0.55);
    const ripple = fbm2(x * 0.3, y * 0.3, 301);
    c = shadeColor(c, 0.95 + ripple * 0.12);
    // shallow edges are warmer / clearer
    c = mixColor(c, lightenColor(st.waterResolved, 0.16), (1 - depth) * 0.4);
    if (this.season === 'winter') c = mixColor(c, 0xa9c9d8, 0.22 + this.snow * 0.18);
    if (this.temperature < 0) c = mixColor(c, 0xc4dbe6, 0.24);
    return c;
  }

  foamColor(): number {
    return mixColor(0xf2f0e2, 0x9fc9d6, this.season === 'winter' ? 0.35 : 0.1);
  }

  /** Deep-water highlight used by the animated shimmer pass. */
  shimmerColor(t: Tile): number {
    return mixColor(this.style(t).waterResolved, 0xffffff, 0.45);
  }

  // -- trees ----------------------------------------------------------------

  treeSpecies(t: Tile): TreeSpecies {
    const st = this.style(t);
    const id = t.biome;
    const tags = st.def?.tags ?? [];
    if (/boreal|taiga|pine|cold/.test(id) || tags.includes('taiga') || tags.includes('cold')) return 'pine';
    if (/volcanic|ash/.test(id) || tags.includes('volcanic')) return 'snag';
    if (/desert|dune|sand/.test(id)) return 'palm';
    if (/semi_arid|steppe|dry|scrub/.test(id) || tags.includes('steppe')) return 'acacia';
    if (/wetland|marsh|reed|swamp/.test(id) || tags.includes('marsh')) return 'reed';
    if (/river|valley/.test(id) || tags.includes('freshwater')) return 'willow';
    if (/mountain|hills|rock|highland/.test(id) || tags.includes('highland')) return 'pine';
    if (/forest|wood/.test(id) || tags.includes('timber') || tags.includes('forest')) return 'oak';
    if (st.isArid) return 'bush';
    if (st.isCold) return 'pine';
    return 'oak';
  }

  // -- day night ------------------------------------------------------------

  dayPhase(timeMs: number, dayLengthSeconds = 360): number {
    // start at ~09:00 so the first impression is a bright morning (0.5 = noon)
    return (((timeMs / 1000) / dayLengthSeconds) + 0.34) % 1;
  }

  /** Ambient tint overlay for a given day phase. */
  ambient(phase: number): { color: number; alpha: number; nightness: number; warm: number } {
    const p = ((phase % 1) + 1) % 1;
    let a = DAY_KEYS[0];
    let b = DAY_KEYS[DAY_KEYS.length - 1];
    for (let i = 1; i < DAY_KEYS.length; i++) {
      if (p <= DAY_KEYS[i].t) {
        a = DAY_KEYS[i - 1];
        b = DAY_KEYS[i];
        break;
      }
    }
    const span = Math.max(1e-6, b.t - a.t);
    const u = clamp01((p - a.t) / span);
    const color = mixColor(a.color, b.color, u);
    let alpha = lerp(a.alpha, b.alpha, u);
    // weather: storms and heavy rain flatten and cool the light
    alpha = clamp01(alpha + this.storm * 0.14 + Math.max(0, this.rainfall - 0.42) * 0.1);
    const nightness = clamp01((alpha - 0.05) / 0.45);
    const warm = clamp01(1 - Math.abs(p - 0.25) / 0.12) * 0.8 + clamp01(1 - Math.abs(p - 0.76) / 0.1) * 0.9;
    return { color, alpha, nightness, warm };
  }

  // -- overlays -------------------------------------------------------------

  overlayLabel(mode: string): string | null {
    return RAMP_DEFS[mode]?.label ?? null;
  }

  overlayValue(mode: string, t: Tile): number {
    switch (mode) {
      case 'fertility':
        return t.fertility;
      case 'forest':
        return t.forest;
      case 'water':
        return t.water;
      case 'pollution':
        return t.pollution;
      case 'beauty':
        return t.beauty;
      case 'roads':
        return t.road > 0 ? 1 : -1;
      default:
        return -1;
    }
  }

  overlayColor(mode: string, value: number): number {
    const ramp = RAMP_DEFS[mode];
    if (!ramp) return 0x808080;
    return rampColor(ramp.stops, value);
  }

  overlayRampCss(mode: string, steps = 5): string[] {
    const ramp = RAMP_DEFS[mode];
    if (!ramp) return [];
    const out: string[] = [];
    for (let i = 0; i < steps; i++) out.push(cssColor(rampColor(ramp.stops, i / (steps - 1))));
    return out;
  }

  overlayLegend(mode: string): { label: string; color: string; hint: string }[] | null {
    const ramp = RAMP_DEFS[mode];
    if (!ramp) return null;
    const steps = 5;
    const out: { label: string; color: string; hint: string }[] = [];
    const hints: Record<string, string[]> = {
      fertility: ['Barren', 'Thin', 'Workable', 'Good', 'Rich'],
      forest: ['Cleared', 'Scrub', 'Open wood', 'Dense', 'Old growth'],
      water: ['Dry', 'Damp', 'Wet', 'Stream', 'Water'],
      pollution: ['Clean', 'Light', 'Noticeable', 'Heavy', 'Toxic'],
      beauty: ['Blighted', 'Plain', 'Pleasant', 'Lovely', 'Sublime'],
    };
    const hint = hints[mode] ?? [];
    for (let i = 0; i < steps; i++) {
      out.push({ label: hint[i] ?? '', color: cssColor(rampColor(ramp.stops, i / (steps - 1))), hint: `${Math.round((i / (steps - 1)) * 100)}%` });
    }
    return out;
  }

  // -- settlement accents ---------------------------------------------------

  settlementColor(id: number): number {
    const palette = [0xc9a55b, 0xb96a4a, 0x6f9d6a, 0x8a6fa8, 0x5f8fb0, 0xb08a3a, 0x9e6b8a];
    if (id < 0) return 0xc9a55b;
    return palette[Math.abs(id) % palette.length];
  }

  /** Soft parchment tone used for the map edge / fog. */
  parchment(): number {
    return 0x14100c;
  }

  /** Colour of unexplored fog. */
  fogColor(): number {
    return mixColor(0x0e0c0a, 0x241f18, 0.5);
  }

  /** Convenience: current season display colour. */
  seasonAccent(): number {
    switch (this.season) {
      case 'spring':
        return 0x9ecf6a;
      case 'summer':
        return 0xc9a03a;
      case 'autumn':
        return 0xc07a3f;
      default:
        return 0x9fc0d6;
    }
  }

  /** Debug string. */
  summary(): string {
    return `season=${this.season} snow=${this.snow.toFixed(2)} temp=${this.temperature} rain=${this.rainfall}`;
  }

  static hslTint(color: number, hueShift: number, satMul: number, lightAdd: number): number {
    const [h, s, l] = (() => {
      const r = ((color >>> 16) & 0xff) / 255;
      const g = ((color >>> 8) & 0xff) / 255;
      const b = (color & 0xff) / 255;
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const ll = (max + min) / 2;
      if (max === min) return [0, 0, ll] as [number, number, number];
      const d = max - min;
      const ss = ll > 0.5 ? d / (2 - max - min) : d / (max + min);
      let hh: number;
      if (max === r) hh = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (max === g) hh = ((b - r) / d + 2) / 6;
      else hh = ((r - g) / d + 4) / 6;
      return [hh * 360, ss, ll] as [number, number, number];
    })();
    return hslColor(h + hueShift, clamp01(s * satMul), clamp01(l + lightAdd));
  }
}
