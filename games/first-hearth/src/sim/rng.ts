/**
 * Deterministic pseudo-random number generation.
 *
 * The whole simulation draws from a serialisable sfc32 stream stored in
 * `GameState.rng`. Never use Math.random() in simulation code.
 */

export type RngState = [number, number, number, number];

/** xmur3 string hash -> 32-bit seed. */
export function hashString(str: string): number {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  return (h ^= h >>> 16) >>> 0;
}

/** Create a deterministic 4-word seed tuple from a label. */
export function seedFromString(label: string): RngState {
  const a = hashString(label + '::a');
  const b = hashString(label + '::b');
  const c = hashString(label + '::c');
  const d = hashString(label + '::d');
  return [a, b, c, d];
}

/** Advance the sfc32 state in place, returning next float in [0,1). */
export function sfc32(state: RngState): number {
  let [a, b, c, d] = state;
  a >>>= 0;
  b >>>= 0;
  c >>>= 0;
  d >>>= 0;
  const t = (a + b) | 0;
  a = b ^ (b >>> 9);
  b = (c + (c << 3)) | 0;
  c = (c << 21) | (c >>> 11);
  d = (d + 1) | 0;
  const r = (t + d) | 0;
  c = (c + r) | 0;
  state[0] = a;
  state[1] = b;
  state[2] = c;
  state[3] = d;
  return (r >>> 0) / 4294967296;
}

/** Closure-based generator that mutates the state tuple in place. */
export function makeRng(state: RngState): () => number {
  return () => sfc32(state);
}

/** A standalone PRNG (useful inside worldgen with a local seed). */
export class Rng {
  private state: RngState;
  constructor(label: string | RngState) {
    this.state = typeof label === 'string' ? seedFromString(label) : [...label] as RngState;
  }
  next(): number {
    return sfc32(this.state);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  int(min: number, maxInclusive: number): number {
    return min + Math.floor(this.next() * (maxInclusive - min + 1));
  }
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }
  pick<T>(arr: T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }
  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }
  /** Approximate standard normal via Box-Muller. */
  normal(mean = 0, sd = 1): number {
    const u = Math.max(1e-9, this.next());
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  getState(): RngState {
    return [...this.state] as RngState;
  }
}

// -------------------- convenience helpers on a raw generator ----------------

export function randInt(rng: () => number, min: number, maxInclusive: number): number {
  return min + Math.floor(rng() * (maxInclusive - min + 1));
}

export function randRange(rng: () => number, min: number, max: number): number {
  return min + rng() * (max - min);
}

export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}

export function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

export function weightedPick<T>(rng: () => number, items: readonly { item: T; weight: number }[]): T | null {
  let total = 0;
  for (const it of items) total += Math.max(0, it.weight);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const it of items) {
    roll -= Math.max(0, it.weight);
    if (roll <= 0) return it.item;
  }
  return items.length ? items[items.length - 1].item : null;
}

export function shuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

/** Pick a key from a weight record. */
export function weightedKey(rng: () => number, weights: Record<string, number>): string | null {
  let total = 0;
  for (const k in weights) total += Math.max(0, weights[k]);
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const k in weights) {
    roll -= Math.max(0, weights[k]);
    if (roll <= 0) return k;
  }
  return Object.keys(weights)[0] ?? null;
}

/** Approximate normal distribution from a plain generator. */
export function gaussian(rng: () => number, mean = 0, sd = 1): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
