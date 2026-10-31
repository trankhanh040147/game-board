import type { Appearance, Loadout } from '../core/types';
import { mulberry32 } from '../core/utils';

/**
 * TEMPORARY appearance generator — character-artist replaces this.
 * Derives a stable cosmetic seed + palette from a loadout and team colour.
 */
export function createAppearance(seed: number, loadout: Loadout, color1: number, _color2: number): Appearance {
  const rng = mulberry32(seed >>> 0);
  const skins = [0xd9a97f, 0xc8956c, 0xa97452, 0x8b5c3e, 0xe0b58d, 0xb98560];
  const hairs = [0x2b211a, 0x4a3324, 0x6b4c31, 0x8a6a45, 0x1e1a17, 0xa07a4c];
  return {
    seed,
    skinTone: skins[Math.floor(rng() * skins.length)],
    hairColor: hairs[Math.floor(rng() * hairs.length)],
    beard: Math.floor(rng() * 4),
    build: 0.92 + rng() * 0.16,
    heraldry: Math.floor(rng() * 3),
    cape: rng() > 0.72,
    bracers: rng() > 0.3,
    tint: (color1 ^ 0x3a2b1c) + Math.floor(rng() * 12),
  };
}
