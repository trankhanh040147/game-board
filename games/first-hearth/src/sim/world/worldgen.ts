/**
 * Procedural world generation.
 *
 * One deterministic pass produces the whole physical world from the seed string:
 *   elevation (domain-warped fBm + ridged mountain belts + continental falloff)
 *   -> sea level from a quantile (stable land/ocean ratio between seeds)
 *   -> D8 flow accumulation -> rivers traced upstream from their coastal mouths, carving valleys
 *   -> endorheic basins become lakes
 *   -> latitude/elevation temperature, moisture with rain shadow + latitude bands
 *   -> biome classification from the content BiomeDef bands
 *   -> per-tile fertility/forest/forage/wildlife/water/beauty from biome + hashed noise
 *   -> deposits from biome deposit tables
 *   -> sites at interesting locations, regions by biome-connected flood fill
 *   -> start site scoring (river + fertile + forest + flat + central-ish)
 *   -> initial weather + climate state.
 *
 * Determinism: only integer hashing / mulberry32 from `noise.ts`. No Math.random, no Date.
 * Performance target: 112x112 in well under 100 ms (one-off at new game / load).
 */
import type {
  BiomeDef,
  ClimateState,
  Deposit,
  RegionInfo,
  RiverPath,
  Site,
  SiteKind,
  Tile,
  WeatherState,
  WorldState,
} from '../types';
import { BIOMES } from '../content/biomes';
import { SITES } from '../content/sites';
import { WORLDGEN } from '../config';
import { clamp } from '../core';
import { fbm2, hash2, hashString, mulberry32, ridged2, shuffled } from './noise';
import {
  annualMeanTemp,
  dayInSeasonForTick,
  forecastText,
  latitudeFactor,
  seasonAmplitude,
  seasonalTempTarget,
  seasonForTick,
} from './climate';
import { REGION_ADJECTIVES, REGION_NOUNS } from './names';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const WORLD_DEFAULTS = { width: 112, height: 112 };

export interface WorldGenOptions {
  width?: number;
  height?: number;
  /** Annual mean temperature at the equator in °C (default 15). */
  startTemp?: number;
}

/**
 * Generate a complete, deterministic world for `seed`.
 * The same seed + options always produce the same WorldState.
 */
export function generateWorld(seed: string, opts: WorldGenOptions = {}): WorldState {
  const width = Math.max(48, Math.floor(opts.width ?? WORLD_DEFAULTS.width));
  const height = Math.max(48, Math.floor(opts.height ?? WORLD_DEFAULTS.height));
  const startTemp = opts.startTemp ?? 23;
  const N = width * height;
  const rand = mulberry32(hashString(seed + '::first-hearth'));

  // ---- content tables (never crash if a pack is empty) --------------------
  const biomeDefs: BiomeDef[] = BIOMES.length > 0 ? BIOMES : EMERGENCY_BIOMES;
  const siteDefs = SITES;
  const biomeMap: Record<string, BiomeDef> = Object.create(null);
  for (const b of biomeDefs) biomeMap[b.id] = b;

  const isWaterDef = (b: BiomeDef): boolean =>
    b.walkCost >= 50 || (b.tags?.includes('water') ?? false);
  const waterDefs = biomeDefs.filter(isWaterDef);
  const landDefs = biomeDefs.filter((b) => !isWaterDef(b));
  const oceanDef: BiomeDef =
    waterDefs.find((b) => /ocean/i.test(b.id)) ?? waterDefs[0] ?? biomeDefs[0];
  const waterBiomeId = oceanDef.id;
  const riverDef = landDefs.find((b) => /river/i.test(b.id));
  const coastDef = landDefs.find((b) => /coast/i.test(b.id));
  // River valleys and coasts are corridor/edge biomes: never generic band matches,
  // they are assigned to actual river tiles and to the thin shore strip respectively.
  // Era-gated biomes (unlockedByDefault false) only appear through content/unlocks, not worldgen.
  const bandLandDefs = landDefs.filter(
    (b) =>
      (!riverDef || b.id !== riverDef.id) &&
      (!coastDef || b.id !== coastDef.id) &&
      b.unlockedByDefault !== false,
  );

  // Content may author band ranges 0..1 (canonical) or 0..100. Detect and scale.
  const elevScale = biomeDefs.some((b) => b.elevationRange[1] > 2) ? 0.01 : 1;
  const moistScale = biomeDefs.some((b) => b.moistureRange[1] > 2) ? 0.01 : 1;
  const tempIsNormalized = biomeDefs.every(
    (b) => b.tempRange[0] >= -2 && b.tempRange[1] <= 2,
  );
  // Some packs author elevation bands against world elevation (0 = abyss, 0.36 = coast),
  // others against "land elevation" (0 = shore, 1 = summit). Detect which and adapt.
  const landElevMins = landDefs.map((b) => b.elevationRange[0]).sort((a, b) => a - b);
  const medianElevMin = landElevMins.length
    ? landElevMins[Math.floor(landElevMins.length / 2)]
    : 0;
  const elevIsRaw = medianElevMin > 0.15;

  // ---- 1. elevation field ------------------------------------------------
  const seeds = {
    elev: hashString(seed + ':elev'),
    cont: hashString(seed + ':cont'),
    ridge: hashString(seed + ':ridge'),
    belt: hashString(seed + ':belt'),
    warp: hashString(seed + ':warp'),
    temp: hashString(seed + ':temp'),
    moist: hashString(seed + ':moist'),
    detail: hashString(seed + ':detail'),
    deposit: hashString(seed + ':deposit'),
    site: hashString(seed + ':site'),
    region: hashString(seed + ':region'),
  };

  const elev = new Float32Array(N);
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const nx = x / width;
      // domain warp keeps coastlines organic instead of blobby
      const wx = fbm2(seeds.warp, nx * 2.4 + 13.7, ny * 2.4 + 7.3, 3) - 0.5;
      const wy = fbm2(seeds.warp + 37, nx * 2.4 + 41.1, ny * 2.4 + 19.9, 3) - 0.5;
      const px = x + wx * 15;
      const py = y + wy * 15;

      let e = fbm2(seeds.elev, px * 0.017, py * 0.017, 6, 2.0, 0.5);
      const cont = fbm2(seeds.cont, nx * 2.6 + 5.5, ny * 2.6 + 2.2, 3);
      e = e * 0.68 + cont * 0.32;

      // mountain belts: ridged noise only where a low-frequency mask permits
      const belt = edgeSmooth(0.48, 0.78, fbm2(seeds.belt, nx * 3.2 + 21.4, ny * 3.2 + 9.8, 3));
      const ridge = ridged2(seeds.ridge, px * 0.024 + 3.1, py * 0.024 + 8.6, 5, 2.1, 0.5);
      e += belt * ridge * 0.38;

      // continental falloff: skewed ellipse + noise wobble so the coast is irregular
      const dx = (nx - 0.5) * 2.06;
      const dy = (ny - 0.5) * 1.96;
      const wobble = 0.86 + 0.34 * fbm2(seeds.cont + 71, nx * 3.4 + 2.7, ny * 3.4 + 5.1, 2);
      const d = Math.sqrt(dx * dx + dy * dy) * wobble;
      const fall = 1 - edgeSmooth(0.74, 1.04, d);
      e = e * (0.3 + 0.7 * fall) + (1 - fall) * 0.18;
      elev[i] = e;
    }
  }

  // Normalise 0..1, then pick sea level from a quantile for a stable land/ocean ratio.
  let minE = Infinity;
  let maxE = -Infinity;
  for (let i = 0; i < N; i++) {
    const e = elev[i];
    if (e < minE) minE = e;
    if (e > maxE) maxE = e;
  }
  const span = Math.max(1e-6, maxE - minE);
  for (let i = 0; i < N; i++) elev[i] = (elev[i] - minE) / span;
  // Sea level is the quantile at WORLDGEN.seaLevel: 0.36 => 36% ocean / 64% land on every seed.
  const sortedElev = Float32Array.from(elev).sort();
  const oceanFraction = clamp(WORLDGEN.seaLevel, 0.15, 0.6);
  const seaLevel = sortedElev[Math.min(N - 1, Math.floor(N * oceanFraction))];

  // ---- 2. D8 flow routing ------------------------------------------------
  const NB8: ReadonlyArray<readonly [number, number]> = [
    [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1],
  ];
  const down = new Int32Array(N).fill(-1);
  const flow = new Float32Array(N).fill(1);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const e = elev[i];
      if (e <= seaLevel) {
        flow[i] = 0;
        continue;
      }
      let best = -1;
      let bestE = e;
      for (let k = 0; k < 8; k++) {
        const nx = x + NB8[k][0];
        const ny = y + NB8[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (elev[j] < bestE - 1e-7) {
          bestE = elev[j];
          best = j;
        }
      }
      down[i] = best;
    }
  }
  const order = Array.from({ length: N }, (_, i) => i);
  order.sort((a, b) => elev[b] - elev[a] || a - b);
  for (const i of order) {
    const d = down[i];
    if (d >= 0) flow[d] += flow[i];
  }
  for (let i = 0; i < N; i++) if (elev[i] <= seaLevel) flow[i] = 0;

  const isOcean = (i: number): boolean => elev[i] <= seaLevel;
  const hasOceanNeighbor = (x: number, y: number): boolean => {
    for (let k = 0; k < 8; k++) {
      const nx = x + NB8[k][0];
      const ny = y + NB8[k][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (isOcean(ny * width + nx)) return true;
    }
    return false;
  };

  // ---- 3. rivers: trace upstream from coastal mouths ----------------------
  const isRiver = new Uint8Array(N);
  const rivers: RiverPath[] = [];
  const mouthCandidates: number[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (isOcean(i)) continue;
      if (flow[i] < WORLDGEN.riverMinFlow * 0.55) continue;
      if (hasOceanNeighbor(x, y)) mouthCandidates.push(i);
    }
  }
  mouthCandidates.sort((a, b) => flow[b] - flow[a] || a - b);

  const mouths: number[] = [];
  const squareDist = (a: number, b: number): number => {
    const ax = a % width;
    const ay = (a / width) | 0;
    const bx = b % width;
    const by = (b / width) | 0;
    return (ax - bx) * (ax - bx) + (ay - by) * (ay - by);
  };
  for (const m of mouthCandidates) {
    if (mouths.length >= 14) break;
    // avoid two rivers entering the sea at nearly the same spot
    if (mouths.some((mm) => squareDist(mm, m) < 11 * 11)) continue;
    mouths.push(m);
  }

  const existingRiver = new Set<number>();
  for (const mouth of mouths) {
    const path: number[] = [];
    let cur = mouth;
    let guard = 0;
    while (cur >= 0 && guard++ < 500) {
      path.push(cur);
      if (flow[cur] < 2) break;
      // follow the biggest tributary uphill
      let parent = -1;
      let bestF = -1;
      const cx = cur % width;
      const cy = (cur / width) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB8[k][0];
        const ny = cy + NB8[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (down[j] !== cur) continue;
        if (flow[j] > bestF) {
          bestF = flow[j];
          parent = j;
        }
      }
      if (parent < 0) break;
      cur = parent;
    }
    if (path.length < 9) continue;
    path.reverse();
    // skip rivers that mostly reuse an already-carved stem
    let reuse = 0;
    for (const t of path) if (existingRiver.has(t)) reuse++;
    if (reuse / path.length > 0.6) continue;
    for (const t of path) {
      isRiver[t] = 1;
      existingRiver.add(t);
      elev[t] = Math.max(seaLevel + 0.005, elev[t] - 0.014);
    }
    rivers.push({
      points: path.map((i) => ({ x: i % width, y: (i / width) | 0 })),
      width: Math.min(2.8, 1 + path.length / 55),
    });
  }

  // ---- 4. lakes from endorheic basins ------------------------------------
  const isLake = new Uint8Array(N);
  const lakeTiles: number[] = [];
  const sinks: number[] = [];
  for (let i = 0; i < N; i++) if (!isOcean(i) && down[i] < 0) sinks.push(i);
  sinks.sort((a, b) => flow[b] - flow[a] || a - b);
  let lakeCount = 0;
  for (const sink of sinks) {
    if (lakeCount >= 6) break;
    if (flow[sink] < 12) continue;
    if (isLake[sink]) continue;
    const basin: number[] = [];
    const stack: number[] = [sink];
    const basinLimit = elev[sink] + 0.008;
    while (stack.length > 0 && basin.length < 35) {
      const cur = stack.pop() as number;
      if (isLake[cur] || isOcean(cur) || elev[cur] > basinLimit) continue;
      isLake[cur] = 1;
      basin.push(cur);
      const cx = cur % width;
      const cy = (cur / width) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = cx + NB8[k][0];
        const ny = cy + NB8[k][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        stack.push(ny * width + nx);
      }
    }
    if (basin.length < 2) {
      isLake[sink] = 0;
      continue;
    }
    lakeCount++;
    for (const t of basin) lakeTiles.push(t);
  }

  // ---- 5. slope + land fraction -----------------------------------------
  const slope = new Float32Array(N);
  const land01 = new Float32Array(N);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const e = elev[i];
      let maxD = 0;
      for (let k = 0; k < 4; k++) {
        const nx = x + NB8[k * 2][0];
        const ny = y + NB8[k * 2][1];
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const d = Math.abs(elev[ny * width + nx] - e);
        if (d > maxD) maxD = d;
      }
      slope[i] = clamp(maxD / 0.05, 0, 1);
      land01[i] = e <= seaLevel ? 0 : clamp((e - seaLevel) / (1 - seaLevel + 1e-6), 0, 1);
    }
  }

  // Distance to the sea (multi-source BFS) drives continentality: inland air is drier.
  const coastDist = new Float32Array(N).fill(1);
  const bfs: number[] = [];
  for (let i = 0; i < N; i++) {
    if (elev[i] <= seaLevel) {
      coastDist[i] = 0;
      bfs.push(i);
    }
  }
  for (let head = 0; head < bfs.length; head++) {
    const cur = bfs[head];
    const cx = cur % width;
    const cy = (cur / width) | 0;
    const nd = coastDist[cur] + 1;
    for (let k = 0; k < 4; k++) {
      const nx = cx + NB8[k * 2][0];
      const ny = cy + NB8[k * 2][1];
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (coastDist[j] > nd) {
        coastDist[j] = nd;
        bfs.push(j);
      }
    }
  }
  let maxCoastDist = 1;
  for (let i = 0; i < N; i++) maxCoastDist = Math.max(maxCoastDist, coastDist[i]);

  // ---- 6. temperature + moisture ----------------------------------------
  const temp = new Float32Array(N);
  const moist = new Float32Array(N);
  for (let y = 0; y < height; y++) {
    const lat = latitudeFactor(y, height);
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const annual = annualMeanTemp(lat, land01[i], startTemp);
      const n = fbm2(seeds.temp, x * 0.05 + 11.3, y * 0.05 + 3.1, 2) - 0.5;
      temp[i] = annual + n * 2.4;
    }
  }
  // Rain shadow: sweep each row west -> east. Air loses moisture climbing, gains it over water.
  const moistSeedB = seeds.moist + 13;
  const drySeed = seeds.moist + 37;
  for (let y = 0; y < height; y++) {
    let carried = 0.5 + fbm2(seeds.moist, y * 0.11 + 3.7, 7.1, 2) * 0.45;
    let prevElev = seaLevel;
    const lat = latitudeFactor(y, height);
    const latWet =
      0.16 * Math.exp(-Math.pow((lat - 0.05) / 0.18, 2)) +
      0.1 * Math.exp(-Math.pow((lat - 0.72) / 0.25, 2)) -
      0.14 * Math.exp(-Math.pow((lat - 0.34) / 0.13, 2));
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const e = elev[i];
      const base = fbm2(moistSeedB, x * 0.045 + 5.9, y * 0.045 + 1.7, 4) - 0.5;
      if (e <= seaLevel) {
        carried = Math.min(1, carried + 0.05);
        moist[i] = 0.98;
        prevElev = e;
        continue;
      }
      const rise = Math.max(0, e - prevElev);
      const drop = Math.max(0, prevElev - e);
      const orographic = Math.min(carried, carried * rise * 3.8);
      // broad wet/dry climate belts + continentality (inland is drier)
      const regional = 0.32 + 1.25 * fbm2(drySeed, x * 0.012 + 7.7, y * 0.012 + 2.3, 3);
      const inland = clamp(coastDist[i] / Math.max(24, maxCoastDist), 0, 1) * 0.22;
      const raw =
        carried * 0.55 + orographic * 1.15 + base * 0.75 + latWet * 0.9 + 0.14;
      // discrete arid belts: where the dry-climate noise peaks, rainfall falls away sharply
      const aridBelt = edgeSmooth(
        0.44,
        0.74,
        fbm2(drySeed + 53, x * 0.016 + 3.3, y * 0.016 + 9.1, 3),
      );
      moist[i] = clamp((raw - inland - aridBelt * 0.32) * regional, 0.02, 1);
      carried = clamp(carried - orographic * 0.72 + drop * 0.09 + 0.014, 0.03, 1);
      prevElev = e;
    }
  }

  // ---- 7. biomes + per-tile dynamics ------------------------------------
  const tiles: Tile[] = new Array(N);
  const isLand = new Uint8Array(N);
  let forestSum = 0;
  let forageSum = 0;
  let wildlifeSum = 0;
  let landCount = 0;
  let bioScore = 0;
  let bioParts = 0;

  const tempAxis = (t: number): number =>
    tempIsNormalized ? clamp((t + 18) / 48, 0, 1) : t;

  const bandDist = (v: number, lo: number, hi: number): number =>
    v < lo ? lo - v : v > hi ? v - hi : 0;
  const centreDist = (v: number, lo: number, hi: number): number => {
    const half = Math.max(1e-6, (hi - lo) / 2);
    return Math.min(1, Math.abs(v - (lo + hi) / 2) / half);
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const e = elev[i];
      const oceanTile = e <= seaLevel;
      const lakeTile = isLake[i] === 1;
      const riverTile = isRiver[i] === 1;
      const adjOcean = !oceanTile && hasOceanNeighbor(x, y);

      let biomeId: string = waterBiomeId;
      if (!oceanTile && !lakeTile) {
        const e01 = elevIsRaw ? elev[i] : land01[i];
        const tA = tempAxis(temp[i]);
        const m = clamp(moist[i] + (hash2(seeds.detail + 3, x, y) - 0.5) * 0.03, 0, 1);
        let bestScore = Infinity;
        let bestId = bandLandDefs[0]?.id ?? waterBiomeId;
        for (const b of bandLandDefs) {
          const dElev =
            bandDist(e01, b.elevationRange[0] * elevScale, b.elevationRange[1] * elevScale) *
            2.3;
          const dTemp = bandDist(tA, b.tempRange[0], b.tempRange[1]) * (tempIsNormalized ? 1.4 : 0.055);
          const dMoist =
            bandDist(m, b.moistureRange[0] * moistScale, b.moistureRange[1] * moistScale) * 1.5;
          let s = dElev * dElev + dTemp * dTemp + dMoist * dMoist;
          // Mild preference for the band whose centre is closest: keeps broad "generic"
          // biomes from swallowing everything when authored ranges overlap.
          s += centreDist(e01, b.elevationRange[0] * elevScale, b.elevationRange[1] * elevScale) * 0.06;
          s += centreDist(tA, b.tempRange[0], b.tempRange[1]) * 0.03;
          s += centreDist(m, b.moistureRange[0] * moistScale, b.moistureRange[1] * moistScale) * 0.05;
          if (riverDef && riverTile && b.id === riverDef.id) s -= 0.03;
          if (coastDef && adjOcean && b.id === coastDef.id) s -= 0.06;
          if (s < bestScore) {
            bestScore = s;
            bestId = b.id;
          }
        }
        biomeId = bestId;
        if (riverDef && riverTile) biomeId = riverDef.id;
        else if (coastDef && adjOcean && e - seaLevel < 0.018) biomeId = coastDef.id;
      }
      const b = biomeMap[biomeId] ?? oceanDef;

      let fertility = 0;
      let forest = 0;
      let forage = 0;
      let wildlife = 0;
      let water = 1;
      let beauty = clamp(b.beauty * 0.6, 0, 1);
      if (oceanTile) {
        wildlife = 0.06;
      } else if (lakeTile) {
        fertility = 0.05;
        wildlife = 0.15;
        water = 1;
      } else {
        const m = moist[i];
        const n1 = hash2(seeds.detail, x * 13 + 1, y * 7 + 3);
        const n2 = hash2(seeds.detail + 7, x * 5 + 2, y * 11 + 5);
        const n3 = hash2(seeds.detail + 13, x * 3 + 4, y * 9 + 1);
        fertility = clamp(
          b.fertility *
            (0.72 + 0.55 * n1) *
            (1 - slope[i] * 0.35) *
            (riverTile ? 1.18 : 1) *
            (0.62 + 0.62 * m),
          0,
          1,
        );
        forest = clamp(
          b.forest * (0.55 + 0.85 * n2) * (1 - slope[i] * 0.22) * (0.6 + 0.6 * m),
          0,
          1,
        );
        forage = clamp(
          b.forage * (0.6 + 0.8 * n3) * (0.65 + 0.55 * m) * (1 - slope[i] * 0.15),
          0,
          1,
        );
        wildlife = clamp(
          b.wildlife *
            (0.55 + 0.9 * n1) *
            (0.55 + 0.7 * forest) *
            (riverTile || adjOcean ? 1.15 : 1),
          0,
          1,
        );
        beauty = clamp(
          b.beauty * (0.75 + 0.5 * n2) + forest * 0.1 + (riverTile ? 0.1 : 0),
          0,
          1,
        );
        water = clamp(
          (riverTile ? 0.95 : 0) +
            (adjOcean || lakeTile ? 0.25 : 0) +
            m * 0.45 +
            0.05,
          0,
          1,
        );
        isLand[i] = 1;
        landCount++;
        forestSum += forest;
        forageSum += forage;
        wildlifeSum += wildlife;
        // normalised biodiversity: how close each community is to its biome potential
        let part = 0;
        let n = 0;
        if (b.forest > 0.02) { part += clamp(forest / b.forest, 0, 1); n++; }
        if (b.forage > 0.02) { part += clamp(forage / b.forage, 0, 1); n++; }
        if (b.wildlife > 0.02) { part += clamp(wildlife / b.wildlife, 0, 1); n++; }
        if (n > 0) { bioScore += part / n; bioParts++; }
      }

      tiles[i] = {
        elev: r3(elev[i]),
        moisture: r3(clamp(0.12 + moist[i] * 0.8, 0.05, 0.95)),
        temp: r1(temp[i]),
        biome: biomeId,
        fertility: r3(fertility),
        forest: r3(forest),
        forage: r3(forage),
        wildlife: r3(wildlife),
        water: r3(water),
        pollution: 0,
        beauty: r3(beauty),
        road: 0,
        buildingId: -1,
        settlementId: -1,
        deposit: lakeTile ? null : rollDeposit(b, x, y, seeds.deposit),
        siteIndex: -1,
      };
    }
  }

  // ---- 8. start site -----------------------------------------------------
  const startIndex = chooseStartIndex(
    width,
    height,
    tiles,
    isLand,
    isRiver,
    isLake,
    slope,
    riverDef?.id,
  );
  const startX = startIndex % width;
  const startY = (startIndex / width) | 0;

  // ---- 9. sites ----------------------------------------------------------
  const sites: Site[] = [];
  if (siteDefs.length > 0) {
    const targetSites = Math.min(
      siteDefs.length,
      Math.max(8, Math.min(WORLDGEN.siteCount, siteDefs.length)),
    );
    const chosen = shuffled(rand, siteDefs).slice(0, targetSites);
    const legendary = siteDefs.find((d) => d.rarity === 'legendary');
    if (legendary && !chosen.some((d) => d.id === legendary.id) && chosen.length > 0) {
      chosen[chosen.length - 1] = legendary;
    }
    const used = new Set<number>();
    const candidates: number[] = [];
    for (let i = 0; i < N; i += 2) {
      if (isLand[i] && !isLake[i] && !isRiver[i]) candidates.push(i);
    }
    const cx = width / 2;
    const cy = height / 2;
    const maxR = Math.hypot(cx, cy);
    for (const def of chosen) {
      let best = -1;
      let bestScore = -Infinity;
      // The first two sites are seeded within a short expedition of the start so the player
      // has somewhere to point a scout in year one; the rest spread across the map.
      const wantNear = sites.length < 2;
      for (const i of candidates) {
        if (used.has(i)) continue;
        const x = i % width;
        const y = (i / width) | 0;
        const dStart = Math.hypot(x - startX, y - startY);
        if (dStart < 6) continue;
        let tooClose = false;
        for (const s of sites) {
          const dx = s.x - x;
          const dy = s.y - y;
          if (dx * dx + dy * dy < 30) {
            tooClose = true;
            break;
          }
        }
        if (tooClose) continue;
        const tile = tiles[i];
        const dCenter = Math.hypot(x - cx, y - cy) / maxR;
        const jitter = hash2(seeds.site, x, y) * 0.8;
        let score =
          siteKindScore(def.kind, tile, slope[i], land01[i], hasOceanNeighbor(x, y)) + jitter;
        if (def.rarity === 'legendary') {
          score += dCenter * 1.6;
        } else {
          score += 0.7 - Math.abs(dCenter - 0.55) * 1.2;
        }
        if (wantNear) score += 1.4 - Math.abs(dStart - 12) * 0.14;
        else score += Math.min(dStart, 40) * 0.02;
        if (x < 6 || y < 6 || x > width - 7 || y > height - 7) score -= 1.2;
        if (score > bestScore) {
          bestScore = score;
          best = i;
        }
      }
      if (best < 0) continue;
      used.add(best);
      const siteIndex = sites.length;
      tiles[best].siteIndex = siteIndex;
      sites.push({
        id: def.id,
        defId: def.id,
        x: best % width,
        y: (best / width) | 0,
        discovered: false,
        visited: false,
        name: def.name,
        discoveredTick: -1,
      });
    }
  }

  // ---- 10. regions (biome-connected flood fill) --------------------------
  const regions = buildRegions(width, height, tiles, isLand, startIndex, rand);

  // ---- 11. weather + climate --------------------------------------------
  const startTile = tiles[startIndex];
  const latitude = latitudeFactor(startY, height);
  const amp = seasonAmplitude(latitude);
  const nowTemp = r1(seasonalTempTarget(startTile.temp, amp, 0));
  const weather: WeatherState = {
    season: seasonForTick(0),
    dayInSeason: dayInSeasonForTick(0),
    year: 1,
    temperature: nowTemp,
    rainfall: 0.18,
    drought: 0,
    soilMoisture: 0.55,
    storm: 0,
    wind: 0.3,
    snow: nowTemp < 2 ? 0.25 : 0,
    forecast: '',
  };
  weather.forecast = forecastText(weather, 0.3, 1);

  const biodiversity = bioParts > 0 ? clamp(bioScore / bioParts, 0.2, 0.98) : 0.5;
  const climate: ClimateState = {
    warming: 0,
    deforestation: 0,
    biodiversity: r3(biodiversity),
    pollution: 0,
    co2: 280,
    seaLevelRise: 0,
  };

  const explored = new Uint8Array(N); // fog is closed; state.ts reveals the starting valley

  return {
    width,
    height,
    tiles,
    explored,
    rivers,
    lakes: lakeTiles.sort((a, b) => a - b),
    regions,
    sites,
    weather,
    climate,
    startX,
    startY,
    seedLabel: seed,
    markers: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}
function r3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function edgeSmooth(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

const DEPOSIT_TILE_RATE = 0.14; // fraction of land tiles that carry any deposit at all

function rollDeposit(biome: BiomeDef, x: number, y: number, depositSeed: number): Deposit | null {
  const list = biome.deposits;
  if (!list || list.length === 0) return null;
  if (hash2(depositSeed, x, y) > DEPOSIT_TILE_RATE) return null;
  // pick which deposit, weighted by the authored chance
  let total = 0;
  for (const d of list) total += Math.max(0, d.chance);
  if (total <= 0) return null;
  let roll = hash2(depositSeed + 1013, x, y) * total;
  let chosen = list[0];
  for (const d of list) {
    roll -= Math.max(0, d.chance);
    if (roll <= 0) {
      chosen = d;
      break;
    }
  }
  const v = hash2(depositSeed + 104729, x * 2 + 1, y * 3 + 5);
  const richness = Math.max(0.2, chosen.richness);
  const amount = Math.max(10, Math.round((30 + 150 * v) * richness));
  return {
    resource: chosen.resource,
    amount,
    initial: amount,
    quality: r3(0.4 + 0.55 * hash2(depositSeed + 7919, x, y)),
    kind: chosen.kind,
  };
}

function siteKindScore(
  kind: SiteKind,
  t: Tile,
  slopeVal: number,
  elev01: number,
  coastal: boolean,
): number {
  switch (kind) {
    case 'grove':
      return t.forest * 2.4 + t.beauty * 1.1 + t.forage * 0.7;
    case 'spring':
      return t.water * 2.0 + t.beauty * 0.8 + (elev01 > 0.1 && elev01 < 0.6 ? 0.4 : 0) - slopeVal * 0.4;
    case 'cave':
      return elev01 * 2.2 + slopeVal * 0.8 - t.forest * 0.3;
    case 'crater':
      return (1 - Math.abs(elev01 - 0.35)) * 1.2 + t.beauty * 0.8;
    case 'wreck':
      return coastal ? 2.2 : -0.8;
    case 'observatory':
      return elev01 * 2.4 + (1 - t.forest) * 0.6 - slopeVal * 0.3;
    case 'ruin':
      return t.fertility * 1.2 + t.beauty * 1.0 + (1 - t.forest) * 0.3;
    case 'shrine':
      return t.beauty * 2.0 + t.water * 0.6;
    case 'wonder':
      return t.beauty * 1.8 + elev01 * 1.2;
    default:
      return t.beauty;
  }
}

/**
 * Choose the founding site.
 *
 * Hard guarantees (checked within radius 6 of the candidate) so every seed is fair:
 *   a) >= 6 tiles with forest >= 0.35      (early wood)
 *   b) >= 1 tile with forage >= 0.30       (early berries)
 *   c) freshwater: tile.water >= 0.35, or a river/lake within 4 tiles
 *   d) >= 1 mineable deposit within 5      (stone/copper/iron/clay/sand/coal)
 *   e) >= 70% of the radius-5 tiles are walkable land
 *   f) not on a site tile (siteIndex >= 0)
 *
 * Candidates are scored for fertility/forest/freshwater/flatness/centrality. If no tile on a
 * rough map satisfies the full set (small maps, hostile seeds) the requirements relax in tiers
 * instead of failing, so generateWorld always returns a playable world.
 */
const START_MINEABLE: ReadonlySet<string> = new Set([
  'stone',
  'copper_ore',
  'iron_ore',
  'clay',
  'sand',
  'coal',
]);

interface StartGuarantees {
  forest6: boolean;
  forage: boolean;
  freshwater: boolean;
  deposit: boolean;
  walkable: boolean;
}

function checkStartGuarantees(
  width: number,
  height: number,
  tiles: Tile[],
  isLand: Uint8Array,
  isRiver: Uint8Array,
  isLake: Uint8Array,
  x: number,
  y: number,
  relax: number,
): StartGuarantees {
  const forestNeed = relax >= 2 ? 3 : 6;
  const mineralRadius = relax >= 2 ? 8 : 5;
  const walkNeed = relax >= 2 ? 0.55 : 0.7;
  let forest6 = 0;
  let forage = 0;
  let freshwater = false;
  for (let dy = -6; dy <= 6; dy++) {
    for (let dx = -6; dx <= 6; dx++) {
      if (dx * dx + dy * dy > 36) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (!isLand[j]) continue;
      const t = tiles[j];
      if (t.forest >= 0.35) forest6++;
      if (t.forage >= 0.3) forage++;
      if (t.water >= 0.35) freshwater = true;
    }
  }
  // river or lake within 4 tiles
  if (!freshwater) {
    const r = 4;
    outer: for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (isRiver[j] || isLake[j]) {
          freshwater = true;
          break outer;
        }
      }
    }
  }
  // at least one mineable deposit within 5 tiles
  let deposit = false;
  let anyDeposit = false;
  const mr = mineralRadius;
  outer2: for (let dy = -mr; dy <= mr; dy++) {
    for (let dx = -mr; dx <= mr; dx++) {
      if (dx * dx + dy * dy > mr * mr) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const dep = tiles[ny * width + nx].deposit;
      if (!dep) continue;
      anyDeposit = true;
      if (START_MINEABLE.has(dep.resource)) {
        deposit = true;
        break outer2;
      }
    }
  }
  // allow any surface deposit as a fallback (content-agnostic, e.g. custom mineral packs)
  const hasDeposit = deposit || (relax >= 1 && anyDeposit);
  // walkable land fraction in radius 5
  let land = 0;
  let total = 0;
  for (let dy = -5; dy <= 5; dy++) {
    for (let dx = -5; dx <= 5; dx++) {
      if (dx * dx + dy * dy > 25) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      total++;
      if (isLand[ny * width + nx]) land++;
    }
  }
  return {
    forest6: forest6 >= forestNeed,
    forage: forage >= 1,
    freshwater,
    deposit: hasDeposit,
    walkable: total > 0 && land / total >= walkNeed,
  };
}

function chooseStartIndex(
  width: number,
  height: number,
  tiles: Tile[],
  isLand: Uint8Array,
  isRiver: Uint8Array,
  isLake: Uint8Array,
  slope: Float32Array,
  riverBiomeId?: string,
): number {
  const N = width * height;
  const cx = width / 2;
  const cy = height / 2;
  const maxR = Math.hypot(cx, cy);

  const scoreFor = (x: number, y: number, i: number): number => {
    let fert = 0;
    let forest = 0;
    let count = 0;
    let riverNear = 0;
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (!isLand[j]) continue;
        fert += tiles[j].fertility;
        forest += tiles[j].forest;
        count++;
        if (isRiver[j]) riverNear = 1;
      }
    }
    if (count < 14) return -Infinity;
    fert /= count;
    forest /= count;
    const tile = tiles[i];
    const dCenter = Math.hypot(x - cx, y - cy) / maxR;
    const centrality = 1 - dCenter * 0.55;
    const flat = 1 - slope[i];
    const climateBonus =
      tile.temp >= 7 && tile.temp <= 24 ? 0.55 : tile.temp >= 2 && tile.temp <= 28 ? 0.1 : -1.2;
    const biomeBonus = riverBiomeId && tile.biome === riverBiomeId ? 0.7 : 0;
    return (
      fert * 2.6 +
      forest * 0.9 +
      riverNear * 1.7 +
      tile.water * 0.9 +
      flat * 1.1 +
      centrality * 1.0 +
      climateBonus +
      biomeBonus
    );
  };

  const landCandidates: number[] = [];
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (!isLand[i]) continue;
      const tile = tiles[i];
      if (tile.siteIndex >= 0) continue;
      if (tile.water > 0.92) continue;
      if (x < 7 || y < 7 || x > width - 8 || y > height - 8) continue;
      landCandidates.push(i);
    }
  }

  // Tier 0: full guarantees. Tier 1: any deposit counts. Tier 2: relaxed numbers.
  for (let relax = 0; relax <= 2; relax++) {
    let best = -1;
    let bestScore = -Infinity;
    for (const i of landCandidates) {
      const x = i % width;
      const y = (i / width) | 0;
      const g = checkStartGuarantees(width, height, tiles, isLand, isRiver, isLake, x, y, relax);
      if (!g.forest6 || !g.forage || !g.freshwater || !g.deposit || !g.walkable) continue;
      const score = scoreFor(x, y, i);
      if (score > bestScore) {
        bestScore = score;
        best = i;
      }
    }
    if (best >= 0) return best;
  }
  // Last resort: best score on any eligible land (never fail generateWorld).
  let fallback = -1;
  let fallbackScore = -Infinity;
  for (const i of landCandidates) {
    const x = i % width;
    const y = (i / width) | 0;
    const score = scoreFor(x, y, i);
    if (score > fallbackScore) {
      fallbackScore = score;
      fallback = i;
    }
  }
  if (fallback >= 0) return fallback;
  for (let i = 0; i < N; i++) if (isLand[i]) return i;
  return 0;
}

function buildRegions(
  width: number,
  height: number,
  tiles: Tile[],
  isLand: Uint8Array,
  startIndex: number,
  rand: () => number,
): RegionInfo[] {
  const N = width * height;
  const visited = new Uint8Array(N);
  const components: { biome: string; tiles: number[] }[] = [];
  const stack: number[] = [];
  for (let seed = 0; seed < N; seed++) {
    if (visited[seed] || !isLand[seed]) continue;
    const biome = tiles[seed].biome;
    const list: number[] = [];
    stack.push(seed);
    visited[seed] = 1;
    while (stack.length > 0) {
      const cur = stack.pop() as number;
      list.push(cur);
      const x = cur % width;
      const y = (cur / width) | 0;
      const neigh = [
        y > 0 ? cur - width : -1,
        y < height - 1 ? cur + width : -1,
        x > 0 ? cur - 1 : -1,
        x < width - 1 ? cur + 1 : -1,
      ];
      for (const j of neigh) {
        if (j < 0 || visited[j] || !isLand[j]) continue;
        if (tiles[j].biome !== biome) continue;
        visited[j] = 1;
        stack.push(j);
      }
    }
    if (list.length >= 12) components.push({ biome, tiles: list });
  }
  // A single connected biome on a continent-sized blob would be one giant "region".
  // Split big blobs into human-scale chunks (~3% of the map) so 8-12 named regions read well.
  const maxRegionArea = Math.max(160, Math.floor(N / 32));
  const split: { biome: string; tiles: number[] }[] = [];
  for (const comp of components) {
    if (comp.tiles.length <= maxRegionArea) {
      split.push(comp);
      continue;
    }
    const remaining = new Set<number>(comp.tiles);
    while (remaining.size > 0) {
      const seedTile = remaining.values().next().value as number;
      const chunk: number[] = [];
      const queue: number[] = [seedTile];
      remaining.delete(seedTile);
      while (queue.length > 0 && chunk.length < maxRegionArea) {
        const cur = queue.shift() as number;
        chunk.push(cur);
        const cx = cur % width;
        const cy = (cur / width) | 0;
        const neigh = [
          cy > 0 ? cur - width : -1,
          cy < height - 1 ? cur + width : -1,
          cx > 0 ? cur - 1 : -1,
          cx < width - 1 ? cur + 1 : -1,
        ];
        for (const j of neigh) {
          if (j < 0 || !remaining.has(j)) continue;
          remaining.delete(j);
          queue.push(j);
        }
      }
      split.push({ biome: comp.biome, tiles: chunk });
    }
  }
  components.length = 0;
  components.push(...split);

  components.sort((a, b) => b.tiles.length - a.tiles.length);
  const wanted = Math.max(4, Math.min(WORLDGEN.regionCount, components.length));
  const names = new Set<string>();
  const regions: RegionInfo[] = [];
  for (let k = 0; k < wanted; k++) {
    const comp = components[k];
    if (!comp) break;
    let sx = 0;
    let sy = 0;
    let explored = false;
    for (const i of comp.tiles) {
      sx += i % width;
      sy += (i / width) | 0;
      if (i === startIndex) explored = true;
    }
    const region: RegionInfo = {
      id: k,
      name: makeRegionName(rand, names),
      biome: comp.biome,
      centroidX: Math.round(sx / comp.tiles.length),
      centroidY: Math.round(sy / comp.tiles.length),
      area: comp.tiles.length,
      explored,
    };
    regions.push(region);
  }
  // Guarantee the starting region reads as charted.
  if (regions.length > 0 && !regions.some((r) => r.explored)) regions[0].explored = true;
  return regions;
}

function makeRegionName(rand: () => number, used: Set<string>): string {
  for (let attempt = 0; attempt < 10; attempt++) {
    const adj = REGION_ADJECTIVES[Math.floor(rand() * REGION_ADJECTIVES.length)];
    const noun = REGION_NOUNS[Math.floor(rand() * REGION_NOUNS.length)];
    const name = `${adj} ${noun}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }
  const fallback = `Region ${used.size + 1}`;
  used.add(fallback);
  return fallback;
}

// ---------------------------------------------------------------------------
// Fog-of-war helpers (also used by the exploration system)
// ---------------------------------------------------------------------------

/** Reveal a circular area of the map; returns the number of newly revealed tiles. */
export function revealCircle(
  world: WorldState,
  cx: number,
  cy: number,
  radius: number,
): number {
  let revealed = 0;
  const r = Math.max(0, Math.ceil(radius));
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= world.width || y >= world.height) continue;
      const idx = y * world.width + x;
      if (world.explored[idx] === 1) continue;
      world.explored[idx] = 1;
      revealed++;
    }
  }
  return revealed;
}

export function countExploredTiles(world: WorldState): number {
  let n = 0;
  for (let i = 0; i < world.explored.length; i++) if (world.explored[i] === 1) n++;
  return n;
}

export function exploredFraction(world: WorldState): number {
  return world.tiles.length ? countExploredTiles(world) / world.tiles.length : 0;
}

/** Debug/QA summary: biome distribution, rivers, sites, start tile. */
export function summarizeWorld(world: WorldState): string {
  const counts: Record<string, number> = {};
  let land = 0;
  for (const t of world.tiles) {
    counts[t.biome] = (counts[t.biome] ?? 0) + 1;
    if (t.water < 0.9) land++;
  }
  const biomes = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => `${id}:${n}`)
    .join(' ');
  const st = world.tiles[world.startY * world.width + world.startX];
  return [
    `world ${world.width}x${world.height} seed="${world.seedLabel}"`,
    `land=${land} ocean=${world.tiles.length - land} rivers=${world.rivers.length} lakes=${world.lakes.length}`,
    `biomes: ${biomes}`,
    `sites=${world.sites.length} regions=${world.regions.length}`,
    `start=(${world.startX},${world.startY}) biome=${st?.biome} fert=${st?.fertility} forest=${st?.forest} water=${st?.water} temp=${st?.temp}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Emergency fallback content — only used if the content pack fails to provide BIOMES.
// Real content always wins; this exists so a broken pack produces a plain world instead
// of a crash in generateWorld.
// ---------------------------------------------------------------------------

const EMERGENCY_BIOMES: BiomeDef[] = [
  {
    id: 'ocean',
    name: 'Ocean',
    desc: 'Open water.',
    color: '#1d3a57',
    colorAlt: '#24486a',
    waterColor: '#16324e',
    elevationRange: [0, 0.36],
    tempRange: [-5, 30],
    moistureRange: [0.8, 1],
    fertility: 0,
    forage: 0,
    forest: 0,
    wildlife: 0.1,
    beauty: 0.5,
    walkCost: 99,
    deposits: [],
    rain: 0.5,
    tempOffset: 0,
    tags: ['water'],
    unlockedByDefault: true,
  },
  {
    id: 'grassland',
    name: 'Grassland',
    desc: 'Open grassy country.',
    color: '#7d9a58',
    colorAlt: '#8fa867',
    waterColor: '#3d6d86',
    elevationRange: [0.36, 0.72],
    tempRange: [-5, 30],
    moistureRange: [0.3, 0.7],
    fertility: 0.6,
    forage: 0.6,
    forest: 0.2,
    wildlife: 0.5,
    beauty: 0.5,
    walkCost: 1,
    deposits: [],
    rain: 0.4,
    tempOffset: 0,
    unlockedByDefault: true,
  },
];
