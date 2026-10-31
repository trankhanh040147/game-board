import type { Appearance, Loadout } from '../core/types';
import { mixHex, shade, hueShift } from './shared';

/** Derived colour palette for one fighter. */
export interface CharacterLook {
  skin: number;
  skinShade: number;
  hair: number;
  /** Team primary cloth. */
  cloth: number;
  clothDark: number;
  /** Team secondary cloth (trim / accents). */
  cloth2: number;
  /** Body armour base colour. */
  armor: number;
  armorDark: number;
  trim: number;
  leather: number;
  leatherDark: number;
  boot: number;
  /** Bright weapon steel. */
  steel: number;
  darkSteel: number;
  bronze: number;
  mail: number;
  wood: number;
  grip: number;
}

export function makeLook(loadout: Loadout, appearance: Appearance): CharacterLook {
  const a = loadout.armor;
  // `tint` is the cosmetic hue jitter (a small integer) supplied by createAppearance.
  const tintDeg = ((appearance.tint % 19) - 9) * 0.85;
  const tintMix = (appearance.tint % 11) / 11;
  const armor = mixHex(hueShift(a.color, tintDeg * 0.4, 0.95), a.trim, tintMix * 0.12);
  const cloth = mixHex(hueShift(loadout.color1, tintDeg, 1.14), shade(a.color, 1.1), 0.02 + tintMix * 0.04);
  const cloth2 = mixHex(hueShift(loadout.color2, tintDeg * 0.5, 1.05), a.trim, 0.05);
  const leather = mixHex(mixHex(0x6a4b2d, a.trim, 0.3), 0x3a2a1a, tintMix * 0.18);
  const skin = appearance.skinTone;
  const hair = appearance.hairColor;
  return {
    skin,
    skinShade: shade(skin, 0.68),
    hair,
    cloth: shade(cloth, 1.12),
    clothDark: shade(cloth, 0.82),
    cloth2,
    armor,
    armorDark: shade(armor, 0.64),
    trim: mixHex(a.trim, cloth2, 0.35),
    leather,
    leatherDark: shade(leather, 0.58),
    boot: mixHex(0x4f3a26, leather, 0.45),
    steel: mixHex(loadout.weapon.bladeColor, 0xc4ccd3, 0.28),
    darkSteel: shade(mixHex(loadout.helmet.color || 0x8b8f95, armor, 0.35), 0.58),
    bronze: mixHex(0xb08d57, cloth2, 0.25),
    mail: mixHex(a.style === 'mail' ? a.color : 0x8b8c88, 0xd8d6cf, 0.16),
    wood: mixHex(0xa06f42, 0x6b4726, tintMix * 0.2),
    grip: mixHex(loadout.weapon.hiltColor, 0x2a1d12, 0.4),
  };
}
