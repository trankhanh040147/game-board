/**
 * Small terrain utilities shared by the world systems (weather, ecology, disasters,
 * exploration, neighbours). Kept content-agnostic: everything is derived from BiomeDef
 * fields and Tile state, never from hard-coded world content ids.
 */
import type { BiomeDef, Content, Tile, WorldState } from '../types';

export function biomeOf(c: Content, tile: Tile | null | undefined): BiomeDef | undefined {
  if (!tile) return undefined;
  return c.biomes[tile.biome];
}

/** Water here means "no one builds or walks" — ocean/lake tiles. */
export function isWaterTile(c: Content, tile: Tile): boolean {
  const b = c.biomes[tile.biome];
  if (!b) return tile.water > 0.95;
  return b.walkCost >= 20 || (b.tags?.includes('impassable') ?? false);
}

export function walkCost(c: Content, tile: Tile): number {
  return c.biomes[tile.biome]?.walkCost ?? 1.5;
}

export function tileSafe(world: WorldState, x: number, y: number): Tile | null {
  if (x < 0 || y < 0 || x >= world.width || y >= world.height) return null;
  return world.tiles[y * world.width + x] ?? null;
}

export function indexOf(world: WorldState, x: number, y: number): number {
  return y * world.width + x;
}

export function xyOf(world: WorldState, idx: number): { x: number; y: number } {
  return { x: idx % world.width, y: (idx / world.width) | 0 };
}

/**
 * Average a per-tile value in a square radius (integer tiles, includes centre).
 * Used by start scoring style heuristics and ecology pressure.
 */
export function avgRadius(
  world: WorldState,
  cx: number,
  cy: number,
  radius: number,
  get: (t: Tile) => number,
  predicate?: (t: Tile) => boolean,
): number {
  let sum = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const t = tileSafe(world, cx + dx, cy + dy);
      if (!t) continue;
      if (predicate && !predicate(t)) continue;
      sum += get(t);
      n++;
    }
  }
  return n > 0 ? sum / n : 0;
}

/** Number of river/lake/ocean tiles within `radius` (Chebyshev) of a tile. */
export function waterNeighbourCount(
  world: WorldState,
  cx: number,
  cy: number,
  radius: number,
): number {
  let count = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      const t = tileSafe(world, cx + dx, cy + dy);
      if (!t) continue;
      if (t.water > 0.9) count++;
    }
  }
  return count;
}

/** Cheap deterministic terrain noise for local variation (mean 0, range ±amp). */
export function tileJitter(world: WorldState, idx: number, salt: number): number {
  // xorshift-style mix; purely cosmetic variation for ecology regrowth speeds.
  let h = (idx ^ (salt * 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h / 4294967296) * 2 - 1;
}
