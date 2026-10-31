import type { Appearance, Loadout } from '../core/types';
import { mulberry32 } from '../core/utils';

const SKIN_TONES = [
  0xe0b58d, 0xd9a97f, 0xcf9a72, 0xc8956c, 0xbb8662, 0xa97452, 0x9a6849, 0x8b5c3e,
  0x7d5238, 0xe6c1a0, 0xd2a27c, 0xb98560,
];

const HAIR_COLORS = [
  0x2b211a, 0x3a2a1e, 0x4a3324, 0x5c412c, 0x6b4c31, 0x7d5b3a, 0x8a6a45,
  0x1e1a17, 0xa07a4c, 0xb08e60, 0x54402c, 0x2f2a24,
];

/**
 * Derive a stable, varied appearance from a seed + loadout.
 * Deterministic: the same seed always yields the same fighter.
 */
export function createAppearance(seed: number, loadout: Loadout, color1: number, _color2: number): Appearance {
  const rng = mulberry32((seed >>> 0) ^ 0x2545f491);
  const skinTone = SKIN_TONES[Math.floor(rng() * SKIN_TONES.length) % SKIN_TONES.length];
  const hairColor = HAIR_COLORS[Math.floor(rng() * HAIR_COLORS.length) % HAIR_COLORS.length];
  const helmet = loadout.helmet.style;
  const r = rng();
  // Beard is more likely on bare-headed/short-helmet fighters.
  let beard: number;
  if (helmet === 'great' || helmet === 'barbute') beard = r < 0.72 ? 0 : 2;
  else if (r < 0.28) beard = 0;
  else if (r < 0.46) beard = 1;
  else if (r < 0.76) beard = 2;
  else beard = 3;
  const build = 0.925 + rng() * 0.145;
  const heraldry = Math.floor(rng() * 3);
  const cape = rng() > 0.7;
  const bracers = rng() > 0.24;
  // Small hue-variation integer used by the palette generator.
  const tint = Math.floor(rng() * 23) - 11;
  void color1;
  return {
    seed: seed >>> 0,
    skinTone,
    hairColor,
    beard,
    build,
    heraldry,
    cape,
    bracers,
    tint,
  };
}
