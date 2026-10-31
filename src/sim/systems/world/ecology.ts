/**
 * Ecology system — the slow living layer under the tile map.
 *
 * - Forest / forage / wildlife regrow toward their biome potential, slowed by winter,
 *   dryness and pollution. Timber depletion is *not* applied here: production extracts
 *   from tiles (GatherSpec.depletion), so ecology only regrows to avoid double-dipping.
 * - Soil fertility regenerates under fallow and forest; farms that do not gather from
 *   tiles (recipe-only farms) slowly draw it down — the only place ecology depletes soil.
 * - Pollution is emitted by the buildings system (BUILDINGS_TUNING.pollutionPerPoint); ecology
 *   only disperses and decays it and folds it into beauty + biodiversity pressure.
 * - Beauty is recomputed cheaply from biome + forest + water - pollution.
 * - Global climate drift: deforestation -> CO2 -> warming -> sea level rise, plus a
 *   biodiversity index, all derived from cumulative player impact on tiles.
 *
 * Performance: near-settlement tiles every day + a 1/4 rotating slice of the map, so a
 * 112x112 world stays comfortably inside the per-tick budget.
 */
import type { Building, Content, SimSystem, Tile, WorldState } from '../../types';
import { clamp, lerp, modOf } from '../../core';
import { isWaterTile } from '../../world/terrain';

// 1/6 of the map per day: a full tile sweep every 6 days, plenty for slow ecology dynamics
// while keeping ecology inside ~0.6-0.9 ms/tick on a 112x112 map.
const SLICES = 6;
/*
 * Buildings own pollution emission (`emitPollution` in systems/civ/buildings.ts): ecology never
 * emits, it only spreads, decays and turns existing pollution into beauty/health pressure.
 */
/** Tiles updated every tick around settlements/buildings. */
const HOT_TILE_CAP = 1300;

interface Pressure {
  soil: number;
}

export const ecologySystem: SimSystem = (ctx) => {
  const s = ctx.s;
  const c = ctx.c;
  const w: WorldState = s.world;
  const weather = w.weather;
  const tick = ctx.tick;
  const N = w.width * w.height;
  const forestRegrow = modOf(ctx, -1, 'forestRegrow');
  const wildlifeRegen = modOf(ctx, -1, 'wildlifeRegen');
  const soilRegen = modOf(ctx, -1, 'soilRegen');
  const pollutionDecay = modOf(ctx, -1, 'pollutionDecay');

  // ---- 1. per-building pressure map (soil draw from tile-less farms) ----
  const pressure = new Map<number, Pressure>();
  const addP = (idx: number, soil: number): void => {
    let p = pressure.get(idx);
    if (!p) {
      p = { soil: 0 };
      pressure.set(idx, p);
    }
    p.soil += soil;
  };

  for (const b of s.buildings) {
    if (b.progress < 0.999 || !b.active || !b.enabled) continue;
    const def = c.buildings[b.typeId];
    if (!def) continue;
    const workerFactor = clamp(0.25 + (b.workers > 0 ? 0.75 : 0), 0.25, 1);
    const isFarmWithoutTile = def.category === 'food' && !hasTileGather(c, b);
    if (!isFarmWithoutTile) continue;
    const r = 2;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = b.x + dx;
        const y = b.y + dy;
        if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
        const idx = y * w.width + x;
        const weighted = 1 - (Math.abs(dx) + Math.abs(dy)) / (r * 2 + 1);
        addP(idx, 0.0007 * workerFactor * weighted);
      }
    }
  }

  // ---- 2. hot tiles: around settlements + every pressure tile ------------
  const hot = new Set<number>();
  for (const st of s.settlements) {
    for (let dy = -6; dy <= 6; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        const x = st.x + dx;
        const y = st.y + dy;
        if (x < 0 || y < 0 || x >= w.width || y >= w.height) continue;
        hot.add(y * w.width + x);
      }
    }
  }
  for (const idx of pressure.keys()) hot.add(idx);
  for (const b of s.buildings) {
    if (b.x < 0 || b.y < 0 || b.x >= w.width || b.y >= w.height) continue;
    hot.add(b.y * w.width + b.x);
  }

  // deterministic rotation so large maps stay bounded
  const hotList = Array.from(hot);
  let hotTiles = hotList;
  if (hotList.length > HOT_TILE_CAP) {
    const offset = (tick * 379) % hotList.length;
    hotTiles = [];
    for (let i = 0; i < HOT_TILE_CAP; i++) hotTiles.push(hotList[(offset + i) % hotList.length]);
  }

  // ---- 3. rotating map slice --------------------------------------------
  const sliceSize = Math.ceil(N / SLICES);
  const sliceStart = (tick % SLICES) * sliceSize;
  const sliceEnd = Math.min(N, sliceStart + sliceSize);

  const cold = clamp((8 - weather.temperature) / 20, 0, 1);
  const drought = weather.drought;
  const soilMoisture = weather.soilMoisture;

  const updateTile = (idx: number, tile: Tile, hotTile: boolean): void => {
    const b = c.biomes[tile.biome];
    if (!b) return;
    const p = pressure.get(idx);
    const moist = tile.moisture;
    const water = tile.water;

    // moisture tracks the regional weather, modulated by local water and canopy
    const localTarget = clamp(
      soilMoisture * (0.9 + water * 0.2) + (tile.forest - 0.4) * 0.06,
      0.03,
      0.98,
    );
    tile.moisture = round3(lerp(moist, localTarget, hotTile ? 0.12 : 0.05));

    if (isWaterTile(c, tile)) {
      // water tiles: pollution dispersal only
      if (tile.pollution > 0.001) {
        tile.pollution = round3(tile.pollution * (1 - 0.08 - pollutionDecay * 0.04));
      }
      return;
    }

    const canopy = clamp(tile.forest / Math.max(0.08, b.forest), 0, 1.4);
    const growth = clamp(0.35 + tile.moisture * 0.9, 0.1, 1.25) * (1 - cold * 0.72) * (1 - drought * 0.35);

    // ---- forest: regrow toward biome potential (production depletes) ----
    if (b.forest > 0.01) {
      const rate = 0.012 * growth * (1 + forestRegrow) * (1 - 0.25 * canopy);
      tile.forest = round3(clamp(tile.forest + (b.forest - tile.forest) * rate, 0, 1));
    } else if (tile.forest > 0) {
      tile.forest = round3(clamp(tile.forest - 0.0015 * cold, 0, 1));
    }

    // ---- forage / wildlife ---------------------------------------------
    const canopyFactor = 0.5 + 0.5 * canopy;
    if (b.forage > 0.01) {
      const target = b.forage * canopyFactor * (0.6 + tile.moisture * 0.5);
      tile.forage = round3(
        clamp(tile.forage + (target - tile.forage) * 0.0085 * growth, 0, 1),
      );
    }
    if (b.wildlife > 0.01) {
      const target = b.wildlife * canopyFactor * (0.6 + tile.moisture * 0.4) * (1 - cold * 0.25);
      tile.wildlife = round3(
        clamp(tile.wildlife + (target - tile.wildlife) * 0.005 * (1 + wildlifeRegen), 0, 1),
      );
    }

    // ---- soil fertility ------------------------------------------------
    const fertTarget = b.fertility * (0.8 + 0.2 * canopy) * (0.85 + tile.moisture * 0.2);
    let fert = tile.fertility;
    if (fert < fertTarget) {
      fert += (fertTarget - fert) * 0.0016 * (0.4 + tile.moisture) * (1 + soilRegen) * (1 - cold * 0.5);
    }
    if (p && p.soil > 0) fert -= p.soil;
    tile.fertility = round3(clamp(fert, 0, 1));

    // ---- water table recharge -----------------------------------------
    const waterTarget = clamp(
      0.08 + tile.moisture * 0.5 + (b.tags?.includes('freshwater') ? 0.25 : 0) +
        (tile.deposit?.kind === 'aquifer' ? 0.35 : 0),
      0,
      1,
    );
    tile.water = round3(lerp(water, Math.max(water, waterTarget), 0.02));

    // ---- pollution dispersal (buildings emit; ecology spreads and decays) ----
    let poll = tile.pollution;
    poll *= 1 - (0.1 + pollutionDecay * 0.05);
    if (!hotTile && poll > 0.01) {
      // gentle diffusion to neighbours in the rotating slice
      poll = lerp(poll, neighbourPollution(w, idx), 0.06);
    }
    tile.pollution = round3(clamp(poll, 0, 1));

    // ---- beauty --------------------------------------------------------
    const beautyTarget = clamp(
      b.beauty * 0.62 + tile.forest * 0.16 + tile.water * 0.14 - tile.pollution * 0.6 + tile.road * 0.04,
      0,
      1,
    );
    tile.beauty = round3(lerp(tile.beauty, beautyTarget, hotTile ? 0.07 : 0.025));
  };

  for (const idx of hotTiles) {
    const tile = w.tiles[idx];
    if (tile) updateTile(idx, tile, true);
  }
  for (let idx = sliceStart; idx < sliceEnd; idx++) {
    if (hot.has(idx)) continue; // already updated above
    const tile = w.tiles[idx];
    if (tile) updateTile(idx, tile, false);
  }

  // ---- 4. biodiversity index (rotating sample, cheap) -------------------
  // Normalised against the biome's own potential, so 1.0 = pristine land and a fall
  // means real impoverishment (deforestation, hunting, pollution), not seed variance.
  const sampleCount = 220;
  const sampleStart = ((tick * 61) % Math.max(1, N - sampleCount)) | 0;
  let diversity = 0;
  let sampled = 0;
  for (let i = 0; i < sampleCount; i++) {
    const tile = w.tiles[(sampleStart + i) % N];
    if (!tile) continue;
    const b = c.biomes[tile.biome];
    if (!b || isWaterTile(c, tile)) continue;
    let score = 0;
    let parts = 0;
    if (b.forest > 0.02) { score += clamp(tile.forest / b.forest, 0, 1); parts++; }
    if (b.forage > 0.02) { score += clamp(tile.forage / b.forage, 0, 1); parts++; }
    if (b.wildlife > 0.02) { score += clamp(tile.wildlife / b.wildlife, 0, 1); parts++; }
    diversity += (parts > 0 ? score / parts : 1) * (1 - tile.pollution * 0.7);
    sampled++;
  }
  if (sampled > 0) {
    const target = clamp(diversity / sampled, 0, 1);
    w.climate.biodiversity = round3(lerp(w.climate.biodiversity, target, 0.02));
  }

  // ---- 5. climate drift (every 4th day, full scan) ----------------------
  if (tick % 4 === 0) {
    let forestSum = 0;
    let pollutionSum = 0;
    let landTiles = 0;
    for (let i = 0; i < N; i++) {
      const tile = w.tiles[i];
      if (!tile) continue;
      pollutionSum += tile.pollution;
      if (isWaterTile(c, tile)) continue;
      landTiles++;
      forestSum += tile.forest;
    }
    // Baseline is the world's own forest on the first ecology scan: deforestation is
    // measured against what the valley started with, not against perfect biome potential.
    let initialForest = s.flags['world.initialForestSum'] ?? 0;
    if (initialForest <= 0) {
      initialForest = Math.max(1, forestSum);
      s.flags['world.initialForestSum'] = initialForest;
    }
    const deforestation = clamp(1 - forestSum / initialForest, 0, 0.95);
    // Global pollution is dominated by where people actually live.
    let settledPollution = 0;
    let settledTiles = 0;
    for (const st of s.settlements) {
      for (let dy = -14; dy <= 14; dy++) {
        for (let dx = -14; dx <= 14; dx++) {
          const t = w.tiles[(st.y + dy) * w.width + (st.x + dx)];
          if (!t) continue;
          settledPollution += t.pollution;
          settledTiles++;
        }
      }
    }
    const avgPollution = settledTiles > 0 ? settledPollution / settledTiles : landTiles > 0 ? pollutionSum / N : 0;
    const climate = w.climate;
    climate.deforestation = round3(lerp(climate.deforestation, deforestation, 0.4));
    climate.pollution = round3(lerp(climate.pollution, avgPollution, 0.3));
    climate.co2 = round1(lerp(climate.co2, 280 + climate.deforestation * 240 + avgPollution * 90, 0.2));
    climate.warming = round2(lerp(climate.warming, climate.deforestation * 2.2 + avgPollution * 1.6, 0.12));
    climate.seaLevelRise = round3(clamp(climate.warming * 0.05, 0, 0.25));

    // expose numeric flags (metrics/events/objectives read these)
    s.flags['world.deforestation01'] = Math.round(climate.deforestation * 100);
    s.flags['world.biodiversity01'] = Math.round(climate.biodiversity * 100);
    s.flags['world.pollution01'] = Math.round(climate.pollution * 100);
    s.flags['world.warming01'] = Math.round(climate.warming * 100);
    s.flags['world.forestPct'] = Math.min(100, Math.round((forestSum / Math.max(1, initialForest)) * 100));

    // player-facing telegraphing, once per threshold crossing
    if (climate.deforestation > 0.18 && s.flags['eco.deforestationWarn'] !== 1) {
      s.flags['eco.deforestationWarn'] = 1;
      ctx.notify(
        'The woods are thinning around the valley. Game is moving on, and the soil washes away faster each spring.',
        'warn',
        'tree',
      );
      ctx.chronicle(
        'The Wood Retreats',
        'The tree line drew back from the fields that year. Hunters walked further for less, and the eldest said the land remembered what we had taken.',
        'nature',
        2,
      );
    }
    if (climate.biodiversity < 0.55 && s.flags['eco.biodiversityWarn'] !== 1) {
      s.flags['eco.biodiversityWarn'] = 1;
      ctx.notify(
        'Biodiversity is falling. Fewer birds, fewer bees, fewer fish — the fields will notice within a generation.',
        'warn',
        'leaf',
      );
    }
    // Smog is local before it is global: warn on the worst tile near a settlement.
    let localPeak = 0;
    for (const st of s.settlements) {
      for (let dy = -10; dy <= 10; dy++) {
        for (let dx = -10; dx <= 10; dx++) {
          const t = w.tiles[(st.y + dy) * w.width + (st.x + dx)];
          if (t && t.pollution > localPeak) localPeak = t.pollution;
        }
      }
    }
    if (
      (climate.pollution > 0.12 || localPeak > 0.32) &&
      tick - (s.flags['eco.pollutionWarn'] ?? -999) > 120
    ) {
      s.flags['eco.pollutionWarn'] = tick;
      ctx.notify(
        'Smoke hangs over the settlement. The water tastes of ash and the children cough at night — parks, filters or cleaner workshops would help.',
        'warn',
        'smoke',
      );
      ctx.chronicle(
        'The Air Turns',
        'Fires were never banked that year. What the workshops put into the sky, the wind laid down on the gardens and the wells.',
        'nature',
        2,
      );
    }
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasTileGather(c: Content, b: Building): boolean {
  if (b.recipeId) {
    const r = c.recipes[b.recipeId];
    if (r?.gather) return true;
  }
  const def = c.buildings[b.typeId];
  if (!def) return false;
  for (const rid of def.recipes) {
    if (c.recipes[rid]?.gather) return true;
  }
  return false;
}

function neighbourPollution(w: WorldState, idx: number): number {
  const x = idx % w.width;
  const y = (idx / w.width) | 0;
  let sum = 0;
  let n = 0;
  if (x > 0) {
    const t = w.tiles[idx - 1];
    if (t) { sum += t.pollution; n++; }
  }
  if (x < w.width - 1) {
    const t = w.tiles[idx + 1];
    if (t) { sum += t.pollution; n++; }
  }
  if (y > 0) {
    const t = w.tiles[idx - w.width];
    if (t) { sum += t.pollution; n++; }
  }
  if (y < w.height - 1) {
    const t = w.tiles[idx + w.width];
    if (t) { sum += t.pollution; n++; }
  }
  return n > 0 ? sum / n : 0;
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
