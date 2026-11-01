/**
 * Deterministic hashing, PRNG and value-noise / fBm primitives used by world generation.
 *
 * Everything here is pure integer maths (Math.imul only) so that a given seed produces
 * byte-identical worlds on every machine and every run. Simulation files must never import
 * Math.random; use these helpers instead.
 */

/** FNV-1a + avalanche hash of a seed string -> uint32. */
export function hashString(seed: string): number {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/** Mulberry32 PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = t;
    r = Math.imul(r ^ (r >>> 15), r | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic hash of a 2D integer lattice point -> float in [0, 1). */
export function hash2(seed: number, x: number, y: number): number {
  let h = (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x846ca68b) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Deterministic integer hash -> uint32 (used for picks / jitter). */
export function hashInt(seed: number, x: number, y: number): number {
  return (hash2(seed, x, y) * 4294967296) >>> 0;
}

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Smooth 2D value noise in [0, 1). */
export function noise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = fade(x - xi);
  const fy = fade(y - yi);
  const a = hash2(seed, xi, yi);
  const b = hash2(seed, xi + 1, yi);
  const c = hash2(seed, xi, yi + 1);
  const d = hash2(seed, xi + 1, yi + 1);
  const top = a + (b - a) * fx;
  const bottom = c + (d - c) * fx;
  return top + (bottom - top) * fy;
}

/** Fractal Brownian motion in [0, 1). */
export function fbm2(
  seed: number,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise2((seed + o * 1013) | 0, x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Ridged multifractal in [0, 1) — sharp crests, good for mountain spines.
 * `sharpness` > 1 narrows the ridges.
 */
export function ridged2(
  seed: number,
  x: number,
  y: number,
  octaves = 5,
  lacunarity = 2.1,
  gain = 0.5,
): number {
  let amp = 0.5;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    const n = noise2((seed + o * 7919) | 0, x * freq, y * freq);
    const ridge = 1 - Math.abs(n * 2 - 1);
    sum += amp * ridge * ridge;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/** Signed fBm in [-1, 1). */
export function fbmSigned(seed: number, x: number, y: number, octaves = 5): number {
  return fbm2(seed, x, y, octaves) * 2 - 1;
}

/** Deterministic pick from an array. */
export function pick<T>(rand: () => number, arr: readonly T[]): T {
  return arr[Math.min(arr.length - 1, Math.floor(rand() * arr.length))];
}

/** Deterministically shuffle a copy of an array. */
export function shuffled<T>(rand: () => number, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}
