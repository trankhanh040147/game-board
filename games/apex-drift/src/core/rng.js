/**
 * Deterministic PRNG helpers.
 *
 * The whole simulation runs on `mulberry32`, so a race can be reproduced exactly
 * from its seed — important for tests and for keeping opponents consistent when
 * the page is paused/resumed.
 */

/** Fast 32-bit seeded PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seeded generator with a few convenience samplers. */
export function createRng(seed = 1) {
  const next = mulberry32(seed);
  return {
    next,
    /** Float in [min, max). */
    range(min, max) {
      return min + (max - min) * next();
    },
    /** Integer in [min, max]. */
    int(min, max) {
      return Math.floor(min + (max - min + 1) * next());
    },
    /** True with probability `p`. */
    chance(p) {
      return next() < p;
    },
    /** Random element of a non-empty array. */
    pick(items) {
      return items[Math.floor(next() * items.length) % items.length];
    },
    /** Signed float in [-amount, amount). */
    sym(amount) {
      return (next() * 2 - 1) * amount;
    },
  };
}

/** Stable 32-bit hash of a string, handy for deriving a seed from a track id. */
export function hashString(text) {
  let hash = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash >>> 0;
}
