import * as THREE from 'three';
import type { Appearance, Loadout } from '../core/types';
import { mulberry32, clamp } from '../core/utils';
import type { CharacterDetail, PartCollector } from './shared';
import { loftCached, taperedBoxCached, trs, shade, mixHex } from './shared';
import type { CharacterLook } from './palette';
import { tabardTexture, tabardTextureKey, type Emblem } from './heraldry';

const EMBLEMS: Emblem[] = ['cross', 'chevron', 'lion', 'star', 'bars', 'sun'];

export interface BodyBuildResult {
  tabardKey: string | null;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

export function buildCharacter(
  pc: PartCollector,
  loadout: Loadout,
  appearance: Appearance,
  look: CharacterLook,
  detail: CharacterDetail,
): BodyBuildResult {
  const style = loadout.armor.style;
  const rng = mulberry32((appearance.seed ^ 0x9e3779b9) >>> 0);
  const seg = detail.seg;

  buildHead(pc, loadout, appearance, look, detail);
  buildTorsoBase(pc, style, look, detail);
  buildArm(pc, 1, style, look, detail);
  buildArm(pc, -1, style, look, detail);
  buildLeg(pc, 1, style, look, detail);
  buildLeg(pc, -1, style, look, detail);
  buildPelvis(pc, style, loadout, look, detail, rng);

  // ---- Heraldic tabard / surcoat --------------------------------
  const heraldry = clamp(Math.floor(appearance.heraldry), 0, 2);
  const shieldEmblem = loadout.shield ? loadout.shield.emblem : EMBLEMS[(appearance.seed >>> 5) % EMBLEMS.length];
  const tabardTex = tabardTexture(loadout.color1, loadout.color2, heraldry, shieldEmblem);
  const tabardKey = tabardTex ? tabardTextureKey(loadout.color1, loadout.color2, heraldry, shieldEmblem) : null;
  const depth = styleDepth(style);
  const skirtCol = mixHex(loadout.color1, loadout.color2, 0.1);
  const skirtDark = shade(skirtCol, 0.78);
  // Heraldic surcoat chest panel in team colours, with geometric heraldry so
  // the team reads instantly at gameplay distance.
  const chestCover = style === 'plate' || style === 'mail' || style === 'scale' ? 0.24 : 0.34;
  const chestTop = style === 'plate' || style === 'mail' || style === 'scale' ? -0.02 : 0.015;
  pc.box('chest', 'cloth', skirtCol, 0.15, chestCover, 0.016, 0, chestTop, depth + 0.02, 0.02);
  pc.box('chest', 'cloth', shade(skirtCol, 0.9), 0.13, chestCover, 0.016, 0.12, chestTop, depth + 0.004, 0.02, -0.45, 0);
  pc.box('chest', 'cloth', shade(skirtCol, 0.9), 0.13, chestCover, 0.016, -0.12, chestTop, depth + 0.004, 0.02, 0.45, 0);
  pc.box('chest', 'cloth', skirtDark, 0.25, chestCover, 0.016, 0, chestTop, -(depth + 0.01), -0.02);
  pc.box('chest', 'cloth', loadout.color2, 0.016, chestCover, 0.018, 0.083, chestTop, depth + 0.024, 0.02);
  pc.box('chest', 'cloth', loadout.color2, 0.016, chestCover, 0.018, -0.083, chestTop, depth + 0.024, 0.02);
  // Emblem in the secondary colour, drawn with cloth strips.
  const em = appearance.seed % 4;
  const ez = depth + 0.034;
  const emY = chestTop - 0.02;
  const emCol = loadout.color2;
  if (em === 0) {
    pc.box('chest', 'cloth', emCol, 0.04, 0.15, 0.01, 0, emY + 0.01, ez);
    pc.box('chest', 'cloth', emCol, 0.11, 0.038, 0.01, 0, emY + 0.04, ez);
  } else if (em === 1) {
    pc.box('chest', 'cloth', emCol, 0.11, 0.03, 0.01, 0, emY - 0.02, ez, 0, 0, -0.5);
    pc.box('chest', 'cloth', emCol, 0.11, 0.03, 0.01, 0, emY - 0.02, ez, 0, 0, 0.5);
  } else if (em === 2) {
    for (let i = 0; i < 3; i++) pc.box('chest', 'cloth', emCol, 0.105, 0.026, 0.01, 0, emY + 0.06 - i * 0.05, ez);
  } else {
    pc.box('chest', 'cloth', emCol, 0.062, 0.085, 0.01, 0.033, emY + 0.04, ez);
    pc.box('chest', 'cloth', emCol, 0.062, 0.085, 0.01, -0.033, emY - 0.02, ez);
  }
  pc.box('chest', 'cloth', emCol, 0.185, 0.022, 0.012, 0, 0.172, depth + 0.018);
  // Cloth skirt of the surcoat below the chest panel (front + back).
  pc.box('spine', 'cloth', skirtCol, 0.3, 0.42, 0.018, 0, -0.09, 0.142, 0.015);
  pc.box('spine', 'cloth', skirtDark, 0.3, 0.42, 0.018, 0, -0.09, -0.132, -0.015);
  // Angled side panels wrap the cloth around the torso.
  pc.box('chest', 'cloth', shade(skirtCol, 0.94), 0.115, 0.34, 0.016, 0.12, 0.015, depth - 0.04, 0.02, -0.55, 0);
  pc.box('chest', 'cloth', shade(skirtCol, 0.94), 0.115, 0.34, 0.016, -0.12, 0.015, depth - 0.04, 0.02, 0.55, 0);
  pc.box('spine', 'cloth', shade(skirtCol, 0.95), 0.13, 0.42, 0.018, 0.125, -0.09, 0.11, 0.02, -0.55, 0);
  pc.box('spine', 'cloth', shade(skirtCol, 0.95), 0.13, 0.42, 0.018, -0.125, -0.09, 0.11, 0.02, 0.55, 0);
  // Hem trim + hem shadow.
  pc.box('spine', 'cloth', loadout.color2, 0.33, 0.032, 0.014, 0, -0.292, 0.144, 0.015);
  pc.box('spine', 'cloth', loadout.color2, 0.33, 0.032, 0.014, 0, -0.292, -0.134, -0.015);
  pc.box('spine', 'cloth', skirtDark, 0.26, 0.012, 0.016, 0, -0.27, 0.141, 0.015);
  // Shoulder straps.
  pc.box('chest', 'cloth', mixHex(loadout.color2, 0x1a140e, 0.2), 0.05, 0.16, 0.016, 0.09, 0.06, depth + 0.012, 0.12, 0, -0.16);
  pc.box('chest', 'cloth', mixHex(loadout.color2, 0x1a140e, 0.2), 0.05, 0.16, 0.016, -0.09, 0.06, depth + 0.012, 0.12, 0, 0.16);

  // Belt worn over the surcoat.
  pc.cyl('hips', 'leather', look.leatherDark, 0.176, 0.179, 0.06, detail.seg, 0, 0.045, 0,
    0, 0, 0, 1.02, 1, 0.94);
  pc.box('hips', 'metal', look.bronze, 0.056, 0.054, 0.022, 0, 0.045, 0.172);
  pc.box('hips', 'metal', shade(look.bronze, 0.78), 0.032, 0.032, 0.012, 0, 0.045, 0.184);

  if (appearance.cape) buildCape(pc, loadout, look, detail);

  // Baldric across the chest for one-handed weapon harnesses.
  if (style !== 'plate') {
    pc.box('chest', 'leather', look.leather, 0.04, 0.44, 0.012, 0.0, -0.04, depth + 0.006, 0.05, 0, 0.66);
    pc.box('chest', 'metal', look.bronze, 0.035, 0.035, 0.012, 0.09, 0.06, depth + 0.012, 0.05, 0, 0.66);
  }

  // Tassets hanging over the thighs: two layers give the hips a flared,
  // armoured silhouette and hide the skirt/thigh seam.
  const tassMat: 'cloth' | 'leather' | 'metal' = style === 'plate' ? 'metal' : style === 'leather' ? 'leather' : 'cloth';
  const tassCol = style === 'plate'
    ? mixHex(look.armor, 0xaab1b8, 0.4)
    : style === 'leather'
      ? look.armor
      : mixHex(look.cloth, look.clothDark, 0.25);
  for (const sdir of [1, -1]) {
    pc.taper('hips', tassMat, tassCol, 0.11, 0.028, 0.13, 0.03, 0.24, sdir * 0.13, -0.2, 0.065, 0.1, 0, sdir * 0.16);
    pc.taper('hips', tassMat, shade(tassCol, 0.88), 0.1, 0.024, 0.115, 0.026, 0.2, sdir * 0.15, -0.3, 0.075, 0.06, 0, sdir * 0.2);
  }
  // Weapon belt hanger + scabbard on the left hip.
  if (loadout.weapon.kind === 'sword' || loadout.weapon.kind === 'saber' || loadout.weapon.kind === 'greatsword') {
    const len = loadout.weapon.kind === 'greatsword' ? 0.9 : 0.7;
    pc.box('hips', 'leather', look.leatherDark, 0.055, len, 0.035, -0.16, -0.16, -0.04, 0.16, 0, 0.18);
    pc.box('hips', 'metal', look.bronze, 0.06, 0.035, 0.04, -0.155, 0.02, -0.02, 0.16, 0, 0.18);
  }

  return { tabardKey };
}

function styleDepth(style: Loadout['armor']['style']): number {
  switch (style) {
    case 'plate': return 0.135;
    case 'mail': return 0.128;
    case 'scale': return 0.126;
    case 'leather': return 0.118;
    default: return 0.122;
  }
}

/* ------------------------------------------------------------------ */
/* Head, face, hair, beard, helmets                                    */
/* ------------------------------------------------------------------ */

function buildHead(
  pc: PartCollector,
  loadout: Loadout,
  appearance: Appearance,
  look: CharacterLook,
  detail: CharacterDetail,
): void {
  const J = 'head';
  const sw = detail.sphereW;
  const sh = detail.sphereH;
  const seg = detail.seg;
  const rng = mulberry32((appearance.seed ^ 0x51ed) >>> 0);
  const skin = look.skin;
  const shadeSkin = look.skinShade;

  // Neck + nape (neck joint sits below the head joint).
  pc.cyl('neck', 'skin', skin, 0.052, 0.062, 0.11, seg, 0, 0.032, -0.004);
  pc.taper('neck', 'skin', shadeSkin, 0.11, 0.09, 0.09, 0.08, 0.05, 0, 0.02, 0.012);

  // Cranium.
  pc.sphere(J, 'skin', skin, 0.101, sw, sh, 0, 0.05, 0.004, 1.0, 1.1, 1.02);
  // Jaw / chin mass.
  pc.taper(J, 'skin', skin, 0.068, 0.078, 0.113, 0.112, 0.078, 0, -0.038, 0.012);
  pc.sphere(J, 'skin', shade(skin, 1.02), 0.036, 8, 6, 0, -0.072, 0.048, 1.25, 0.8, 1.0);
  // Cheekbones.
  pc.sphere(J, 'skin', shade(skin, 1.03), 0.03, 8, 6, 0.057, -0.008, 0.052, 0.85, 0.8, 0.75);
  pc.sphere(J, 'skin', shade(skin, 1.03), 0.03, 8, 6, -0.057, -0.008, 0.052, 0.85, 0.8, 0.75);
  // Brow ridge.
  pc.taper(J, 'skin', shadeSkin, 0.145, 0.03, 0.16, 0.026, 0.016, 0, 0.062, 0.078, 0.12);
  // Eye sockets (dark almonds) + tiny catchlights.
  for (const sx of [-1, 1]) {
    pc.sphere(J, 'dark', 0x241a15, 0.018, 8, 6, sx * 0.037, 0.036, 0.079, 1.45, 0.8, 0.35);
    pc.sphere(J, 'dark', 0x0f0c0a, 0.009, 6, 4, sx * 0.039, 0.036, 0.086, 1.1, 0.9, 0.4);
    pc.sphere(J, 'cloth', 0xd8d0bd, 0.0032, 5, 4, sx * 0.043, 0.039, 0.0895);
    // Upper eyelid, angled for a stern look.
    pc.box(J, 'skin', shadeSkin, 0.042, 0.011, 0.014, sx * 0.037, 0.05, 0.082, 0.1, 0, sx * -0.12);
  }
  // Nose: bridge + tip + nostrils.
  pc.taper(J, 'skin', shade(skin, 1.04), 0.028, 0.03, 0.04, 0.044, 0.07, 0, 0.014, 0.094, 0.16);
  pc.sphere(J, 'skin', shade(skin, 1.05), 0.017, 8, 6, 0, 0.002, 0.103, 1.1, 0.9, 0.9);
  pc.sphere(J, 'skin', shadeSkin, 0.012, 6, 4, 0.017, -0.012, 0.098, 0.9, 0.7, 0.6);
  pc.sphere(J, 'skin', shadeSkin, 0.012, 6, 4, -0.017, -0.012, 0.098, 0.9, 0.7, 0.6);
  // Mouth + lower lip.
  pc.box(J, 'dark', 0x3d211c, 0.038, 0.007, 0.012, 0, -0.043, 0.09);
  pc.box(J, 'skin', shade(skin, 1.06), 0.03, 0.009, 0.012, 0, -0.051, 0.09);
  // Ears.
  pc.sphere(J, 'skin', shadeSkin, 0.02, 8, 6, 0.098, 0.028, -0.004, 0.45, 1.1, 0.85);
  pc.sphere(J, 'skin', shadeSkin, 0.02, 8, 6, -0.098, 0.028, -0.004, 0.45, 1.1, 0.85);

  const covered = loadout.helmet.style !== 'none';
  if (!covered) {
    buildHair(pc, appearance, look, detail, rng);
    buildBeard(pc, appearance, look);
  } else {
    // Hair visible around the helmet: nape + sideburns.
    const hs = hairStyleFor(appearance);
    pc.taper(J, 'hair', mixHex(look.hair, 0x120e0a, 0.2), 0.16, 0.075, 0.115, 0.06, 0.09, 0, -0.005, -0.085, 0.1);
    if (hs >= 2) pc.taper(J, 'hair', mixHex(look.hair, 0x120e0a, 0.25), 0.13, 0.06, 0.08, 0.05, 0.15, 0, -0.085, -0.09, 0.16);
    pc.sphere(J, 'hair', mixHex(look.hair, 0x120e0a, 0.2), 0.022, 8, 6, 0.09, 0.02, 0.02, 1.0, 1.5, 0.9);
    pc.sphere(J, 'hair', mixHex(look.hair, 0x120e0a, 0.2), 0.022, 8, 6, -0.09, 0.02, 0.02, 1.0, 1.5, 0.9);
    if (appearance.beard >= 2 && loadout.helmet.style !== 'great' && loadout.helmet.style !== 'barbute') {
      buildBeard(pc, appearance, look);
    }
  }

  buildHelmet(pc, loadout.helmet.style, loadout.helmet.color, look, detail);
}

function hairStyleFor(appearance: Appearance): number {
  const r = (appearance.seed >>> 3) % 10;
  if (r < 1) return 1; // close-cropped
  if (r < 5) return 1; // short
  if (r < 9) return 2; // medium
  return 3; // long
}

function buildHair(
  pc: PartCollector,
  appearance: Appearance,
  look: CharacterLook,
  detail: CharacterDetail,
  rng: () => number,
): void {
  const J = 'head';
  const style = hairStyleFor(appearance);
  const hair = mixHex(look.hair, 0x1c1712, 0.12);
  // Cap always slightly larger than the skull so it never z-fights / disappears.
  pc.sphere(J, 'hair', hair, 0.101, detail.sphereW, detail.sphereH, 0, 0.047, -0.006, 1.03, 1.09, 1.03);
  // Hairline / fringe.
  if (style >= 1) {
    pc.taper(J, 'hair', shade(hair, 1.04), 0.165, 0.04, 0.14, 0.026, 0.052, 0, 0.086, 0.068, -0.32);
  }
  // Sideburns.
  pc.sphere(J, 'hair', shade(hair, 0.96), 0.026, 8, 6, 0.088, 0.02, 0.038, 0.9, 1.7, 0.9);
  pc.sphere(J, 'hair', shade(hair, 0.96), 0.026, 8, 6, -0.088, 0.02, 0.038, 0.9, 1.7, 0.9);
  if (style >= 2) {
    // Nape hair.
    pc.taper(J, 'hair', shade(hair, 0.92), 0.15, 0.08, 0.1, 0.05, 0.13, 0, -0.005, -0.088, 0.12);
    for (let i = 0; i < 4; i++) {
      const x = -0.08 + (i / 3) * 0.16;
      pc.taper(J, 'hair', shade(hair, 0.92 + rng() * 0.16), 0.05, 0.03, 0.03, 0.02, 0.085 + rng() * 0.04,
        x, 0.02, 0.064, 0.24, 0, (rng() - 0.5) * 0.18);
    }
  }
  if (style === 3) {
    pc.taper(J, 'hair', shade(hair, 0.9), 0.19, 0.09, 0.14, 0.07, 0.24, 0, -0.07, -0.095, -0.06);
  }
}

function buildBeard(pc: PartCollector, appearance: Appearance, look: CharacterLook): void {
  const J = 'head';
  const beard = clamp(Math.floor(appearance.beard), 0, 3);
  if (beard <= 0) return;
  const col = mixHex(look.hair, 0x2a1c12, 0.08);
  // Moustache.
  pc.taper(J, 'hair', col, 0.075, 0.03, 0.055, 0.024, 0.02, 0, -0.028, 0.096, 0.1);
  if (beard === 1) return;
  if (beard === 2) {
    pc.taper(J, 'hair', col, 0.095, 0.06, 0.062, 0.04, 0.062, 0, -0.095, 0.06, -0.12);
    pc.sphere(J, 'hair', shade(col, 0.95), 0.032, 8, 6, 0.058, -0.05, 0.055, 0.55, 1.15, 0.65);
    pc.sphere(J, 'hair', shade(col, 0.95), 0.032, 8, 6, -0.058, -0.05, 0.055, 0.55, 1.15, 0.65);
    return;
  }
  pc.taper(J, 'hair', col, 0.115, 0.09, 0.07, 0.04, 0.12, 0, -0.13, 0.05, -0.14);
  pc.sphere(J, 'hair', shade(col, 0.94), 0.04, 8, 6, 0.064, -0.06, 0.05, 0.62, 1.35, 0.7);
  pc.sphere(J, 'hair', shade(col, 0.94), 0.04, 8, 6, -0.064, -0.06, 0.05, 0.62, 1.35, 0.7);
  pc.taper(J, 'hair', shade(col, 0.9), 0.1, 0.045, 0.045, 0.028, 0.08, 0, -0.21, 0.038, -0.1);
}

export function buildHelmet(
  pc: PartCollector,
  style: Loadout['helmet']['style'],
  color: number,
  look: CharacterLook,
  detail: CharacterDetail,
): void {
  if (style === 'none') return;
  const J = 'head';
  const seg = detail.seg;
  const sw = detail.sphereW;
  const sh = detail.sphereH;
  const steel = color || look.darkSteel;
  const dark = shade(steel, 0.48);

  if (style === 'skullcap') {
    pc.sphere(J, 'metal', steel, 0.118, sw, sh, 0, 0.048, -0.006, 1.06, 1.06, 1.07);
    pc.cyl(J, 'metal', dark, 0.12, 0.121, 0.026, seg, 0, 0.028, -0.006, 0, 0, 0, 1.03, 1, 1.04);
    pc.cyl('head', 'leather', look.leatherDark, 0.112, 0.11, 0.016, seg, 0, 0.014, -0.006, 0, 0, 0, 1.02, 1, 1.03);
    if (detail.extra) {
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + 0.4;
        pc.sphere(J, 'metal', look.bronze, 0.007, 6, 4, Math.sin(a) * 0.105, 0.06, Math.cos(a) * 0.105 - 0.004);
      }
    }
    return;
  }

  if (style === 'nasal') {
    const rings: [number, number, number, number, number][] = [
      [-0.015, 0.112, 0.118, 0, -0.004],
      [0.05, 0.111, 0.116, 0, -0.004],
      [0.105, 0.095, 0.1, 0, -0.002],
      [0.155, 0.055, 0.058, 0, 0.0],
      [0.178, 0.02, 0.022, 0, 0.0],
    ];
    pc.addRaw(J, 'metal', steel, loftCached('helm-nasal2', rings, seg, false, true));
    pc.cyl(J, 'metal', dark, 0.116, 0.117, 0.028, seg, 0, 0.028, -0.004, 0, 0, 0, 1.02, 1, 1.02);
    pc.taper(J, 'leather', look.leatherDark, 0.19, 0.03, 0.16, 0.02, 0.06, 0, -0.045, -0.088, 0.1);
    // Nasal bar.
    pc.taper(J, 'metal', shade(steel, 1.04), 0.026, 0.02, 0.017, 0.016, 0.1, 0, -0.005, 0.112, 0.06);
    pc.box(J, 'metal', dark, 0.034, 0.012, 0.022, 0, 0.036, 0.12);
    if (detail.extra) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        pc.sphere(J, 'metal', look.bronze, 0.0075, 6, 4, Math.sin(a) * 0.111, 0.04, Math.cos(a) * 0.113 - 0.004);
      }
    }
    return;
  }

  if (style === 'spangen') {
    const rings: [number, number, number, number, number][] = [
      [-0.02, 0.113, 0.119, 0, -0.004],
      [0.045, 0.112, 0.118, 0, -0.004],
      [0.105, 0.097, 0.102, 0, -0.002],
      [0.15, 0.06, 0.063, 0, 0.0],
      [0.172, 0.022, 0.024, 0, 0.0],
    ];
    pc.addRaw(J, 'metal', steel, loftCached('helm-spangen2', rings, seg, false, true));
    pc.cyl(J, 'metal', dark, 0.117, 0.118, 0.03, seg, 0, 0.026, -0.004, 0, 0, 0, 1.02, 1, 1.02);
    pc.taper(J, 'leather', look.leatherDark, 0.19, 0.03, 0.16, 0.02, 0.06, 0, -0.05, -0.088, 0.1);
    // Four bands from the apex.
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      pc.box(J, 'metal', shade(steel, 0.92), 0.024, 0.16, 0.016, Math.sin(a) * 0.05, 0.09, Math.cos(a) * 0.05 - 0.003,
        Math.cos(a) * 0.5, a, Math.sin(a) * 0.5);
    }
    // Cheek guards.
    pc.box(J, 'metal', shade(steel, 0.88), 0.028, 0.095, 0.07, 0.084, -0.035, 0.02, 0.06, 0.1, 0.1);
    pc.box(J, 'metal', shade(steel, 0.88), 0.028, 0.095, 0.07, -0.084, -0.035, 0.02, 0.06, -0.1, -0.1);
    // Nasal.
    pc.taper(J, 'metal', steel, 0.026, 0.018, 0.015, 0.014, 0.065, 0, 0.01, 0.112, 0.05);
    if (detail.extra) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        pc.sphere(J, 'metal', look.bronze, 0.007, 6, 4, Math.sin(a) * 0.11, 0.075, Math.cos(a) * 0.112 - 0.003);
      }
    }
    return;
  }

  if (style === 'great') {
    const rings: [number, number, number, number, number][] = [
      [-0.085, 0.104, 0.12, 0, 0.006],
      [-0.02, 0.109, 0.126, 0, 0.006],
      [0.05, 0.108, 0.124, 0, 0.005],
      [0.12, 0.097, 0.108, 0, 0.004],
      [0.155, 0.062, 0.066, 0, 0.002],
    ];
    pc.addRaw(J, 'metal', steel, loftCached('helm-great2', rings, seg, false, false));
    // Flat top plate.
    pc.cyl(J, 'metal', shade(steel, 1.02), 0.07, 0.075, 0.018, seg, 0, 0.163, 0.002);
    // Cross reinforcement + brow band.
    pc.box(J, 'metal', dark, 0.024, 0.24, 0.018, 0, 0.06, 0.126, 0.03);
    pc.box(J, 'metal', dark, 0.2, 0.026, 0.016, 0, 0.108, 0.126);
    // Eye slit.
    pc.box(J, 'dark', 0x080605, 0.17, 0.02, 0.02, 0, 0.08, 0.128);
    pc.box(J, 'metal', shade(steel, 1.06), 0.022, 0.02, 0.024, 0, 0.08, 0.134);
    // Breathing holes.
    for (let i = 0; i < 3; i++) {
      pc.box(J, 'dark', 0x080605, 0.011, 0.011, 0.012, 0.04 - i * 0.04, 0.012 + (i % 2) * 0.014, 0.128);
    }
    // Flared lower rim + mail neck guard.
    pc.cyl(J, 'metal', dark, 0.115, 0.117, 0.022, seg, 0, -0.094, 0.005, 0, 0, 0, 1.03, 1, 1.03);
    pc.taper(J, 'mail', shade(look.mail, 0.72), 0.2, 0.1, 0.16, 0.08, 0.1, 0, -0.145, -0.06, 0.16);
    return;
  }

  // Barbute: rounded helm with a T-opening.
  const rings: [number, number, number, number, number][] = [
    [-0.095, 0.1, 0.116, 0, 0.005],
    [-0.03, 0.11, 0.124, 0, 0.005],
    [0.045, 0.108, 0.12, 0, 0.003],
    [0.115, 0.086, 0.094, 0, 0.001],
    [0.158, 0.03, 0.032, 0, 0.0],
  ];
  pc.addRaw(J, 'metal', steel, loftCached('helm-barbute2', rings, seg, false, true));
  // Cheek plates leaving a T opening at the front.
  pc.box(J, 'metal', shade(steel, 0.95), 0.05, 0.15, 0.028, 0.072, -0.025, 0.108, 0.03, 0.08, 0.12);
  pc.box(J, 'metal', shade(steel, 0.95), 0.05, 0.15, 0.028, -0.072, -0.025, 0.108, 0.03, -0.08, -0.12);
  pc.box(J, 'metal', shade(steel, 1.0), 0.19, 0.036, 0.05, 0, -0.062, 0.108, 0.12);
  // Dark void behind the opening.
  pc.box(J, 'dark', 0x080605, 0.16, 0.14, 0.02, 0, 0.0, 0.098);
  // Brow reinforcement.
  pc.box(J, 'metal', shade(steel, 1.04), 0.2, 0.022, 0.026, 0, 0.078, 0.114, 0.1);
  if (detail.extra) {
    pc.box(J, 'metal', look.bronze, 0.022, 0.045, 0.012, 0, 0.125, 0.118);
  }
  pc.taper(J, 'mail', shade(look.mail, 0.72), 0.2, 0.09, 0.15, 0.07, 0.1, 0, -0.14, -0.06, 0.16);
}

/* ------------------------------------------------------------------ */
/* Torso                                                               */
/* ------------------------------------------------------------------ */

function buildTorsoBase(pc: PartCollector, style: Loadout['armor']['style'], look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const under = style === 'plate' ? shade(look.clothDark, 0.95) : look.cloth;
  const lowerRings: [number, number, number, number, number][] = [
    [-0.16, 0.146, 0.102, 0, 0.004],
    [-0.06, 0.152, 0.106, 0, 0.003],
    [0.06, 0.165, 0.111, 0, 0.002],
    [0.155, 0.175, 0.114, 0, 0.0],
  ];
  pc.addRaw('spine', 'cloth', under, loftCached('torso-lower2', lowerRings, seg, false, false));
  const upperRings: [number, number, number, number, number][] = [
    [-0.12, 0.172, 0.113, 0, 0.001],
    [0.0, 0.183, 0.118, 0, 0.001],
    [0.09, 0.194, 0.121, 0, 0.0],
    [0.165, 0.2, 0.117, 0, -0.004],
    [0.205, 0.148, 0.099, 0, -0.012],
  ];
  pc.addRaw('chest', 'cloth', under, loftCached('torso-upper2', upperRings, seg, false, true));
  // Collar.
  pc.cyl('chest', 'cloth', shade(under, 0.9), 0.095, 0.118, 0.06, seg, 0, 0.2, -0.002);
  // Shoulder yoke: a soft slope from neck to the shoulder joints.
  pc.taper('chest', 'cloth', shade(under, 0.98), 0.13, 0.115, 0.36, 0.125, 0.12, 0, 0.155, -0.002);
  // Trapezius (neck-to-shoulder slope).
  pc.taper('chest', 'cloth', shade(under, 0.96), 0.1, 0.1, 0.3, 0.11, 0.065, 0, 0.193, -0.004);
  // Pectoral shaping for soft armours.
  if (style === 'gambeson' || style === 'leather') {
    pc.sphere('chest', style === 'gambeson' ? 'quilt' : 'leather', shade(look.armor, 1.02), 0.06, 8, 6, 0.07, 0.07, 0.09, 1.15, 0.95, 0.6);
    pc.sphere('chest', style === 'gambeson' ? 'quilt' : 'leather', shade(look.armor, 1.02), 0.06, 8, 6, -0.07, 0.07, 0.09, 1.15, 0.95, 0.6);
  }

  switch (style) {
    case 'gambeson': buildGambeson(pc, look, detail); break;
    case 'leather': buildLeatherArmor(pc, look, detail); break;
    case 'mail': buildMailArmor(pc, look, detail); break;
    case 'scale': buildScaleArmor(pc, look, detail); break;
    case 'plate': buildPlateArmor(pc, look, detail); break;
  }
}

function buildGambeson(pc: PartCollector, look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const quilt = look.armor;
  const dark = shade(quilt, 0.8);
  const lowerRings: [number, number, number, number, number][] = [
    [-0.165, 0.158, 0.11, 0, 0.004],
    [-0.06, 0.164, 0.113, 0, 0.003],
    [0.06, 0.177, 0.119, 0, 0.002],
    [0.155, 0.186, 0.121, 0, 0.0],
  ];
  pc.addRaw('spine', 'quilt', quilt, loftCached('gamb-lower2', lowerRings, seg, false, false));
  const upperRings: [number, number, number, number, number][] = [
    [-0.12, 0.184, 0.12, 0, 0.001],
    [0.0, 0.194, 0.125, 0, 0.001],
    [0.09, 0.206, 0.128, 0, 0.0],
    [0.165, 0.211, 0.124, 0, -0.004],
    [0.205, 0.156, 0.104, 0, -0.012],
  ];
  pc.addRaw('chest', 'quilt', quilt, loftCached('gamb-upper2', upperRings, seg, false, true));
  // Vertical quilt channels.
  for (let i = 0; i < 4; i++) {
    const x = -0.105 + i * 0.07;
    pc.box('chest', 'quilt', dark, 0.014, 0.3, 0.012, x, 0.02, 0.117, 0.04, 0, 0);
    pc.box('spine', 'quilt', dark, 0.014, 0.19, 0.012, x * 0.92, -0.02, 0.108, 0.04, 0, 0);
  }
  // Standing collar.
  pc.cyl('chest', 'quilt', dark, 0.092, 0.112, 0.07, seg, 0, 0.21, -0.002);
  // Padded shoulder rolls.
  for (const [J, s] of [['shoulderR', 1], ['shoulderL', -1]] as [string, number][]) {
    pc.addRaw(J, 'quilt', quilt, loftCached('cap-gamb', scaleRings(SHOULDER_CAP_RINGS, 0.96), 8, true, true));
    pc.addRaw(J, 'quilt', dark, loftCached('cap-gamb-lame', scaleRings(SHOULDER_CAP_RINGS, 0.88), 8, true, false),
      trs(0, -0.085, 0, 0, 0, 0, 1.05, 0.5, 1.05));
  }
  // Hemp rope belt.
  pc.cyl('hips', 'leather', dark, 0.155, 0.16, 0.04, seg, 0, 0.075, 0, 0, 0, 0, 1, 1, 0.74);
  // Cuffs.
  pc.cyl('elbowR', 'quilt', look.cloth2, 0.05, 0.047, 0.035, seg, 0, -0.235, 0);
  pc.cyl('elbowL', 'quilt', look.cloth2, 0.05, 0.047, 0.035, seg, 0, -0.235, 0);
}

function buildLeatherArmor(pc: PartCollector, look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const leather = look.armor;
  const dark = shade(leather, 0.68);
  // Jerkin shell.
  const lowerRings: [number, number, number, number, number][] = [
    [-0.165, 0.159, 0.111, 0, 0.004],
    [-0.06, 0.165, 0.114, 0, 0.003],
    [0.06, 0.178, 0.12, 0, 0.002],
    [0.155, 0.186, 0.122, 0, 0.0],
  ];
  pc.addRaw('spine', 'leather', leather, loftCached('leath-lower', lowerRings, seg, false, false));
  const upperRings: [number, number, number, number, number][] = [
    [-0.12, 0.183, 0.12, 0, 0.001],
    [0.0, 0.193, 0.125, 0, 0.001],
    [0.09, 0.204, 0.128, 0, 0.0],
    [0.165, 0.208, 0.123, 0, -0.004],
    [0.202, 0.153, 0.103, 0, -0.012],
  ];
  pc.addRaw('chest', 'leather', leather, loftCached('leath-upper', upperRings, seg, false, true));
  // Front opening seam + lacing.
  pc.box('chest', 'leather', dark, 0.02, 0.36, 0.014, 0.0, 0.01, 0.12, 0.02);
  for (let i = 0; i < 5; i++) {
    pc.box('chest', 'leather', shade(dark, 1.2), 0.09, 0.012, 0.012, 0, 0.12 - i * 0.06, 0.122);
  }
  // Hardened shoulder lames.
  for (const [J, s] of [['shoulderR', 1], ['shoulderL', -1]] as [string, number][]) {
    pc.addRaw(J, 'leather', leather, loftCached('cap-leather', scaleRings(SHOULDER_CAP_RINGS, 0.96), 8, true, true));
    pc.addRaw(J, 'leather', dark, loftCached('cap-leather-lame', scaleRings(SHOULDER_CAP_RINGS, 0.9), 8, true, false),
      trs(0, -0.085, 0, 0, 0, 0, 1.04, 0.55, 1.04));
    pc.box(J, 'leather', shade(dark, 0.85), 0.11, 0.016, 0.03, s * 0.012, -0.02, 0.06);
  }
  // High collar.
  pc.cyl('chest', 'leather', dark, 0.094, 0.115, 0.075, seg, 0, 0.21, -0.002);
  // Rivets.
  if (detail.extra) {
    for (let i = 0; i < 5; i++) {
      pc.sphere('chest', 'metal', look.bronze, 0.0075, 6, 4, -0.09 + i * 0.045, 0.11, 0.124);
    }
  }
}

function buildMailArmor(pc: PartCollector, look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const mail = mixHex(look.mail, look.armor, 0.4);
  const lowerRings: [number, number, number, number, number][] = [
    [-0.22, 0.167, 0.12, 0, 0.003],
    [-0.06, 0.168, 0.118, 0, 0.002],
    [0.06, 0.181, 0.123, 0, 0.001],
    [0.155, 0.188, 0.124, 0, 0],
  ];
  pc.addRaw('spine', 'mail', mail, loftCached('mail-lower2', lowerRings, seg, false, false));
  const upperRings: [number, number, number, number, number][] = [
    [-0.12, 0.188, 0.124, 0, 0.001],
    [0.0, 0.198, 0.129, 0, 0.001],
    [0.09, 0.211, 0.132, 0, 0.0],
    [0.165, 0.215, 0.127, 0, -0.004],
    [0.205, 0.163, 0.107, 0, -0.012],
  ];
  pc.addRaw('chest', 'mail', mail, loftCached('mail-upper2', upperRings, seg, false, true));
  // Mail coif around the neck and under the chin.
  pc.cyl('chest', 'mail', shade(mail, 0.9), 0.098, 0.12, 0.075, seg, 0, 0.21, -0.002);
  pc.sphere('head', 'mail', shade(mail, 0.86), 0.104, detail.sphereW, detail.sphereH, 0, 0.028, -0.02, 1.02, 1.0, 1.0);
  // Mail skirt.
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    pc.box('hips', 'mail', shade(mail, 0.92), 0.07, 0.23, 0.028,
      Math.sin(a) * 0.145, -0.17, Math.cos(a) * 0.108, Math.cos(a) * 0.12, a, -Math.sin(a) * 0.12);
  }
  // Metal spaudlers.
  for (const [J, s] of [['shoulderR', 1], ['shoulderL', -1]] as [string, number][]) {
    pc.sphere(J, 'metal', look.darkSteel, 0.078, 8, 6, s * 0.012, -0.005, 0, 1.4, 0.72, 1.26);
    pc.box(J, 'metal', shade(look.darkSteel, 0.84), 0.11, 0.02, 0.115, s * 0.016, -0.058, 0, 0, 0, s * 0.12);
  }
  // Surcoat belt.
  pc.cyl('hips', 'leather', look.leatherDark, 0.157, 0.162, 0.05, seg, 0, 0.075, 0, 0, 0, 0, 1, 1, 0.72);
}

function buildScaleArmor(pc: PartCollector, look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const scale = mixHex(look.armor, look.mail, 0.2);
  const lowerRings: [number, number, number, number, number][] = [
    [-0.19, 0.162, 0.115, 0, 0.003],
    [-0.06, 0.164, 0.114, 0, 0.002],
    [0.06, 0.177, 0.119, 0, 0.001],
    [0.155, 0.184, 0.121, 0, 0],
  ];
  pc.addRaw('spine', 'scale', scale, loftCached('scale-lower2', lowerRings, seg, false, false));
  const upperRings: [number, number, number, number, number][] = [
    [-0.12, 0.184, 0.12, 0, 0.001],
    [0.0, 0.194, 0.125, 0, 0.001],
    [0.09, 0.206, 0.128, 0, 0.0],
    [0.165, 0.211, 0.123, 0, -0.004],
    [0.205, 0.158, 0.104, 0, -0.012],
  ];
  pc.addRaw('chest', 'scale', scale, loftCached('scale-upper2', upperRings, seg, false, true));
  // Scale skirt rows.
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2;
      pc.box('hips', 'scale', shade(scale, row % 2 === 0 ? 1 : 0.88), 0.08, 0.08, 0.024,
        Math.sin(a) * (0.14 + row * 0.006), -0.03 - row * 0.072, Math.cos(a) * (0.103 + row * 0.004),
        Math.cos(a) * 0.15, a, -Math.sin(a) * 0.15);
    }
  }
  // Plate shoulders with lames.
  for (const [J, s] of [['shoulderR', 1], ['shoulderL', -1]] as [string, number][]) {
    pc.addRaw(J, 'metal', mixHex(look.armor, 0xa8aeb5, 0.4), loftCached('cap-scale', scaleRings(SHOULDER_CAP_RINGS, 0.98), 8, true, true));
    pc.addRaw(J, 'metal', mixHex(look.armor, 0xb6bcc3, 0.5), loftCached('cap-scale-lame', scaleRings(SHOULDER_CAP_RINGS, 0.92), 8, true, false),
      trs(0, -0.085, 0, 0, 0, 0, 1.05, 0.55, 1.05));
    pc.addRaw(J, 'metal', shade(look.armor, 0.92), loftCached('cap-scale-lame2', scaleRings(SHOULDER_CAP_RINGS, 0.84), 8, true, false),
      trs(0, -0.15, 0, 0, 0, 0, 1.05, 0.5, 1.05));
  }
  // Gorget.
  pc.cyl('chest', 'metal', mixHex(look.armor, 0x9aa0a8, 0.4), 0.098, 0.116, 0.05, seg, 0, 0.212, -0.002);
  pc.cyl('hips', 'leather', look.leatherDark, 0.158, 0.163, 0.05, seg, 0, 0.075, 0, 0, 0, 0, 1, 1, 0.72);
}

function buildPlateArmor(pc: PartCollector, look: CharacterLook, detail: CharacterDetail): void {
  const seg = detail.seg;
  const steel = mixHex(look.armor, 0xa6adb5, 0.5);
  const trim = look.bronze;
  // Cuirass shell.
  const upperRings: [number, number, number, number, number][] = [
    [-0.13, 0.188, 0.125, 0, 0.004],
    [-0.05, 0.197, 0.132, 0, 0.004],
    [0.05, 0.208, 0.135, 0, 0.002],
    [0.14, 0.214, 0.13, 0, -0.002],
    [0.2, 0.164, 0.108, 0, -0.012],
  ];
  pc.addRaw('chest', 'metal', steel, loftCached('plate-upper2', upperRings, seg, false, true));
  const lowerRings: [number, number, number, number, number][] = [
    [-0.1, 0.171, 0.115, 0, 0.002],
    [-0.02, 0.179, 0.121, 0, 0.004],
    [0.08, 0.188, 0.124, 0, 0.002],
    [0.155, 0.187, 0.121, 0, 0.001],
  ];
  pc.addRaw('spine', 'metal', shade(steel, 0.92), loftCached('plate-lower2', lowerRings, seg, false, false));
  // Plackart + central ridge.
  pc.box('chest', 'metal', shade(steel, 1.02), 0.22, 0.14, 0.018, 0, -0.08, 0.117, 0.04);
  pc.taper('chest', 'metal', shade(steel, 1.06), 0.03, 0.04, 0.018, 0.026, 0.22, 0, -0.005, 0.128, 0.03);
  // Edge turning / gold trim.
  pc.box('chest', 'metal', trim, 0.24, 0.016, 0.012, 0, 0.177, 0.108, 0.1);
  // Gorget.
  pc.cyl('chest', 'metal', trim, 0.098, 0.12, 0.06, seg, 0, 0.212, -0.002);
  pc.cyl('chest', 'metal', shade(steel, 0.9), 0.108, 0.128, 0.028, seg, 0, 0.184, -0.002);
  // Faulds around the hips.
  for (let row = 0; row < 3; row++) {
    pc.cyl('hips', 'metal', shade(steel, 0.94 - row * 0.035), 0.158 + row * 0.011, 0.162 + row * 0.011, 0.07, seg,
      0, 0.03 - row * 0.068, 0, 0, 0, 0, 1, 1, 0.74);
  }
  // Tassets.
  for (const s of [1, -1]) {
    pc.taper('hips', 'metal', shade(steel, 0.9), 0.12, 0.03, 0.1, 0.026, 0.15, s * 0.11, -0.19, 0.065, 0.06, 0, s * 0.12);
  }
  // Arming-coat skirt peeking below the faulds.
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + 0.2;
    pc.box('hips', 'cloth', mixHex(look.cloth, 0x1a1410, 0.35), 0.075, 0.2, 0.02,
      Math.sin(a) * 0.13, -0.28, Math.cos(a) * 0.095, Math.cos(a) * 0.2, a, -Math.sin(a) * 0.2);
  }
  // Pauldrons with lames.
  for (const [J, s] of [['shoulderR', 1], ['shoulderL', -1]] as [string, number][]) {
    pc.addRaw(J, 'metal', steel, loftCached('cap-plate', scaleRings(SHOULDER_CAP_RINGS, 1.02), 8, true, true));
    pc.addRaw(J, 'metal', shade(steel, 1.04), loftCached('cap-plate-lame', scaleRings(SHOULDER_CAP_RINGS, 0.98), 8, true, false),
      trs(0, -0.085, 0, 0, 0, 0, 1.06, 0.52, 1.06));
    pc.addRaw(J, 'metal', shade(steel, 0.96), loftCached('cap-plate-lame2', scaleRings(SHOULDER_CAP_RINGS, 0.9), 8, true, false),
      trs(0, -0.15, 0, 0, 0, 0, 1.06, 0.48, 1.06));
    pc.sphere(J, 'metal', trim, 0.016, 6, 5, s * 0.07, -0.02, 0.055);
  }
  // Rivets.
  if (detail.extra) {
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      pc.sphere('chest', 'metal', trim, 0.009, 6, 4, Math.sin(a) * 0.185, 0.12, Math.cos(a) * 0.115 + 0.01);
    }
  }
  // Belt over the faulds.
  pc.cyl('hips', 'leather', look.leather, 0.168, 0.171, 0.05, seg, 0, 0.105, 0, 0, 0, 0, 1, 1, 0.76);
  pc.box('hips', 'metal', trim, 0.055, 0.055, 0.02, 0, 0.105, 0.13);
}

/* ------------------------------------------------------------------ */
/* Arms                                                               */
/* ------------------------------------------------------------------ */

const SHOULDER_CAP_RINGS: [number, number, number, number, number][] = [
  [-0.13, 0.062, 0.066, 0, 0.002],
  [-0.09, 0.08, 0.085, 0, 0.002],
  [-0.04, 0.092, 0.097, 0, 0.001],
  [0.015, 0.082, 0.087, 0, 0],
  [0.045, 0.05, 0.054, 0, 0],
];
const ARM_UPPER_RINGS: [number, number, number, number, number][] = [
  [-0.285, 0.046, 0.049, 0, 0],
  [-0.23, 0.051, 0.054, 0, 0],
  [-0.15, 0.059, 0.062, 0, 0.002],
  [-0.07, 0.066, 0.07, 0, 0.003],
  [-0.005, 0.06, 0.064, 0, 0],
];
const ARM_FORE_RINGS: [number, number, number, number, number][] = [
  [-0.255, 0.035, 0.038, 0, 0],
  [-0.21, 0.039, 0.042, 0, 0],
  [-0.14, 0.047, 0.05, 0, 0],
  [-0.06, 0.054, 0.057, 0, 0],
  [0.0, 0.049, 0.052, 0, 0],
];
const THIGH_RINGS: [number, number, number, number, number][] = [
  [-0.44, 0.061, 0.065, 0, 0],
  [-0.33, 0.069, 0.073, 0, 0],
  [-0.2, 0.085, 0.09, 0, 0.002],
  [-0.09, 0.097, 0.102, 0, 0.002],
  [-0.005, 0.088, 0.093, 0, 0],
];
const SHIN_RINGS: [number, number, number, number, number][] = [
  [-0.425, 0.056, 0.059, 0, 0],
  [-0.3, 0.062, 0.066, 0, 0],
  [-0.16, 0.074, 0.078, 0, 0.002],
  [-0.07, 0.086, 0.091, 0, 0.005],
  [-0.005, 0.08, 0.084, 0, 0],
];

function buildArm(
  pc: PartCollector,
  side: 1 | -1,
  style: Loadout['armor']['style'],
  look: CharacterLook,
  detail: CharacterDetail,
): void {
  const J = side === 1 ? 'shoulderR' : 'shoulderL';
  const E = side === 1 ? 'elbowR' : 'elbowL';
  const H = side === 1 ? 'handR' : 'handL';
  const seg = detail.seg;
  const s = side;

  const sleeveMat = style === 'mail' ? 'mail' : style === 'scale' ? 'scale' : style === 'gambeson' ? 'quilt' : 'cloth';
  const sleeveCol = style === 'mail'
    ? mixHex(look.mail, look.armor, 0.45)
    : style === 'scale'
      ? mixHex(look.armor, look.mail, 0.25)
      : style === 'gambeson'
        ? look.armor
        : look.cloth;

  // Shoulder fill (hides the gap between torso and upper arm).
  pc.sphere(J, sleeveMat, sleeveCol, 0.066, 8, 6, 0, 0.004, 0, 1.0, 0.95, 1.0);
  // Upper arm: tapered muscle shape.
  pc.addRaw(J, sleeveMat, sleeveCol, loftCached('arm-upper-limb', ARM_UPPER_RINGS, seg, true, true));

  if (style === 'plate') {
    pc.addRaw(J, 'metal', mixHex(look.armor, 0xb2b8bf, 0.55), loftCached('arm-upper-plate', scaleRings(ARM_UPPER_RINGS, 1.1), seg, true, true));
    pc.sphere(J, 'metal', look.bronze, 0.011, 6, 4, s * 0.045, -0.12, 0.03);
  } else if (style === 'leather') {
    pc.addRaw(J, 'leather', look.armor, loftCached('arm-upper-leather', scaleRings(ARM_UPPER_RINGS, 1.07), seg, true, true));
    pc.box(J, 'leather', look.leatherDark, 0.018, 0.11, 0.01, s * 0.05, -0.16, 0.02);
  } else if (style === 'scale') {
    pc.addRaw(J, 'metal', look.darkSteel, loftCached('arm-upper-scale', scaleRings(ARM_UPPER_RINGS, 1.06), seg, true, true));
  } else if (style === 'gambeson') {
    // Quilted ridges around the sleeve.
    for (const y of [-0.09, -0.17, -0.24]) {
      pc.cyl(J, 'quilt', shade(look.armor, 0.82), 0.066, 0.066, 0.018, seg, 0, y, 0.002);
    }
  }

  // Elbow: fill the joint, then a plate cap on the outside.
  pc.sphere(E, sleeveMat, shade(sleeveCol, 0.82), 0.05, 8, 6, 0, 0.004, 0);
  if (style === 'plate' || style === 'scale') {
    pc.sphere(E, 'metal', mixHex(look.armor, 0xb6bcc3, 0.5), 0.053, 8, 6, 0, 0.008, 0.012, 1.0, 0.78, 0.7);
  } else {
    pc.sphere(E, 'leather', look.leatherDark, 0.047, 8, 6, 0, 0.006, 0.018, 1.0, 0.82, 0.62);
  }
  // Forearm.
  const foreMat = style === 'mail' ? 'mail' : style === 'plate' ? 'metal' : 'leather';
  const foreCol = style === 'mail'
    ? mixHex(look.mail, look.armor, 0.45)
    : style === 'plate'
      ? mixHex(look.armor, 0xb2b8bf, 0.55)
      : look.leather;
  pc.addRaw(E, foreMat, foreCol, loftCached('arm-fore-limb', ARM_FORE_RINGS, seg, true, true));
  if (style === 'plate') {
    pc.addRaw(E, 'metal', mixHex(look.armor, 0xb8bec5, 0.55), loftCached('arm-fore-plate', scaleRings(ARM_FORE_RINGS, 1.09), seg, true, true));
    pc.sphere(E, 'metal', look.bronze, 0.01, 6, 4, s * 0.04, -0.1, 0.026);
  } else {
    // Bracer wrapping the forearm.
    pc.addRaw(E, 'leather', look.leatherDark, loftCached('arm-fore-bracer', scaleRings(ARM_FORE_RINGS, 1.08), seg, false, true));
    pc.cyl(E, 'leather', shade(look.leatherDark, 1.15), 0.047, 0.043, 0.014, seg, 0, -0.07, 0);
    pc.cyl(E, 'leather', shade(look.leatherDark, 1.15), 0.04, 0.037, 0.014, seg, 0, -0.225, 0);
  }
  // Hand: compact fist with a knuckle plate.
  const handMat: 'metal' | 'leather' = style === 'plate' ? 'metal' : 'leather';
  const handCol = style === 'plate' ? look.darkSteel : look.leatherDark;
  pc.sphere(H, handMat, handCol, 0.043, 8, 6, 0, -0.028, 0.004, 1.0, 1.1, 1.15);
  pc.taper(H, handMat, handCol, 0.07, 0.082, 0.056, 0.066, 0.055, 0, -0.062, 0.008);
  pc.box(H, handMat, shade(handCol, 1.12), 0.056, 0.02, 0.044, 0, -0.05, 0.03);
  pc.capsule(H, 'leather', shade(handCol, 0.9), 0.014, 0.03, 6, s * -0.026, -0.036, 0.028, 0.55, 0, s * 0.6);
  if (style === 'plate') {
    pc.cyl(H, 'metal', look.darkSteel, 0.043, 0.048, 0.032, seg, 0, 0.008, 0);
  }
}

function buildLeg(
  pc: PartCollector,
  side: 1 | -1,
  style: Loadout['armor']['style'],
  look: CharacterLook,
  detail: CharacterDetail,
): void {
  const T = side === 1 ? 'thighR' : 'thighL';
  const K = side === 1 ? 'kneeR' : 'kneeL';
  const F = side === 1 ? 'footR' : 'footL';
  const seg = detail.seg;
  const s = side;

  const legMat = style === 'plate' ? 'metal' : style === 'mail' ? 'mail' : 'cloth';
  const legCol = style === 'plate'
    ? mixHex(look.armor, 0xaab1b8, 0.5)
    : style === 'mail'
      ? mixHex(look.mail, look.armor, 0.4)
      : mixHex(look.clothDark, look.leather, 0.45);

  // Thigh: tapered.
  pc.addRaw(T, legMat, legCol, loftCached('thigh-limb', THIGH_RINGS, seg, true, true));
  if (style === 'plate') {
    // Cuisse: a front plate hugging the thigh.
    pc.sphere(T, 'metal', mixHex(look.armor, 0xb6bcc3, 0.5), 0.084, 8, 6, 0, -0.17, 0.02, 1.0, 1.8, 0.74);
    pc.box(T, 'metal', look.bronze, 0.01, 0.01, 0.01, s * 0.05, -0.09, 0.045);
  } else {
    // Thigh strap + hose tie under the knee.
    pc.cyl(T, 'leather', look.leatherDark, 0.092, 0.088, 0.03, seg, 0, -0.24, 0.002);
    pc.cyl(T, 'leather', look.leatherDark, 0.06, 0.054, 0.03, seg, 0, -0.4, 0);
    if (style === 'mail') {
      pc.addRaw(T, 'mail', shade(legCol, 0.92), loftCached('thigh-mail', scaleRings(THIGH_RINGS, 1.05), seg, true, true));
    }
  }
  // Knee: fill the joint, then a poleyn plate on the front.
  pc.sphere(K, legMat, shade(legCol, 0.82), 0.058, 8, 6, 0, 0.0, 0.0);
  const copMat: 'metal' | 'leather' = style === 'plate' || style === 'scale' || style === 'mail' ? 'metal' : 'leather';
  const copCol = copMat === 'metal' ? mixHex(look.armor, 0xb2b8bf, 0.45) : look.leatherDark;
  pc.taper(K, copMat, copCol, 0.1, 0.03, 0.085, 0.024, 0.1, 0, -0.03, 0.05, 0.05);
  pc.box(K, copMat, shade(copCol, 0.85), 0.1, 0.014, 0.012, 0, -0.085, 0.06);
  pc.cyl(K, 'leather', shade(look.boot, 0.8), 0.075, 0.07, 0.02, seg, 0, -0.12, 0.004, 0, 0, 0, 1, 1, 1.05);
  if (style === 'plate') {
    pc.sphere(K, 'metal', mixHex(look.armor, 0xbac0c7, 0.55), 0.062, 8, 6, 0, -0.005, 0.04, 1.18, 0.88, 0.58);
    pc.box(K, 'metal', shade(look.armor, 0.98), 0.02, 0.03, 0.02, s * 0.05, -0.005, 0.03, 0, 0, s * 0.3);
  } else if (style === 'scale') {
    pc.sphere(K, 'metal', look.darkSteel, 0.053, 8, 6, 0, -0.002, 0.035, 1.12, 0.82, 0.62);
  } else {
    pc.sphere(K, 'leather', look.leatherDark, 0.051, 8, 6, 0, -0.002, 0.032, 1.08, 0.88, 0.62);
  }
  // Shin.
  const shinMat = style === 'plate' ? 'metal' : 'leather';
  const shinCol = style === 'plate' ? mixHex(look.armor, 0xb2b8bf, 0.5) : look.boot;
  pc.addRaw(K, shinMat, shinCol, loftCached('shin-limb', SHIN_RINGS, seg, true, true));
  // Greave / shin guard plate for readable leg armour at distance.
  if (style === 'plate' || style === 'scale' || style === 'mail') {
    pc.taper(K, 'metal', mixHex(look.armor, 0xb6bcc3, 0.5), 0.1, 0.03, 0.08, 0.028, 0.3, 0, -0.22, 0.045, 0.03);
    pc.box(K, 'metal', look.bronze, 0.012, 0.012, 0.012, 0, -0.1, 0.078);
  } else {
    pc.taper(K, 'leather', look.leatherDark, 0.095, 0.028, 0.075, 0.024, 0.24, 0, -0.24, 0.05, 0.03);
    pc.box(K, 'leather', shade(look.leatherDark, 0.8), 0.014, 0.09, 0.012, 0.04, -0.18, 0.052, 0, 0, 0.06);
  }
  // Boot straps.
  pc.cyl(K, 'leather', shade(look.boot, 0.7), 0.07, 0.066, 0.022, seg, 0, -0.34, 0.004, 0, 0, 0, 1, 1, 1.04);
  pc.cyl(K, 'leather', shade(look.boot, 0.7), 0.088, 0.082, 0.024, seg, 0, -0.12, 0.004, 0, 0, 0, 1, 1, 1.04);
  if (style === 'plate') {
    pc.addRaw(K, 'metal', mixHex(look.armor, 0xbcc2c9, 0.55), loftCached('shin-plate', scaleRings(SHIN_RINGS, 1.08), seg, false, true));
    pc.box(K, 'metal', look.bronze, 0.008, 0.008, 0.008, s * 0.04, -0.12, 0.028);
  } else {
    // Boot shaft overlapping the ankle.
    pc.addRaw(K, 'leather', look.boot, loftCached('boot-shaft', BOOT_SHAFT_RINGS, seg, true, true));
    pc.cyl(K, 'leather', shade(look.boot, 1.22), 0.06, 0.052, 0.026, seg, 0, -0.11, 0.002);
    pc.box(K, 'leather', shade(look.boot, 0.8), 0.014, 0.08, 0.012, s * 0.045, -0.26, 0.035);
  }
  // Foot: heel + instep + tapered toe + sole.
  const footMat: 'metal' | 'leather' = style === 'plate' ? 'metal' : 'leather';
  const footCol = style === 'plate' ? mixHex(look.armor, 0xaab1b8, 0.45) : look.boot;
  // Ankle fill so the boot never separates from the shin.
  pc.sphere(F, footMat, shade(footCol, 0.9), 0.052, 8, 6, 0, 0.012, 0.0);
  // Ankle/heel block.
  pc.taper(F, footMat, footCol, 0.094, 0.115, 0.086, 0.125, 0.09, 0, -0.042, -0.005, 0, 0, 0, 0.015);
  // Instep sloping down to the toes.
  pc.taper(F, footMat, footCol, 0.092, 0.12, 0.09, 0.13, 0.06, 0, -0.052, 0.08, 0, 0, 0, 0.045);
  // Toe box.
  pc.taper(F, footMat, shade(footCol, 1.06), 0.09, 0.12, 0.076, 0.1, 0.05, 0, -0.06, 0.155, 0, 0, 0, 0.02);
  pc.sphere(F, footMat, shade(footCol, 1.08), 0.05, 8, 6, 0, -0.058, 0.185, 1.1, 0.62, 0.9);
  // Heel.
  pc.sphere(F, footMat, shade(footCol, 0.95), 0.046, 8, 6, 0, -0.055, -0.045, 1.0, 0.7, 0.8);
  // Sole.
  pc.taper(F, 'leather', shade(look.boot, 0.45), 0.096, 0.13, 0.084, 0.25, 0.024, 0, -0.077, 0.07, 0, 0, 0, 0.01);
  if (style === 'plate') {
    pc.taper(F, 'metal', mixHex(look.armor, 0xb4bac1, 0.45), 0.084, 0.11, 0.072, 0.16, 0.04, 0, -0.052, 0.09, 0, 0, 0, 0.03);
  }
}

const BOOT_SHAFT_RINGS: [number, number, number, number, number][] = [
  [-0.44, 0.07, 0.074, 0, 0.004],
  [-0.36, 0.077, 0.082, 0, 0.003],
  [-0.26, 0.089, 0.095, 0, 0.004],
  [-0.16, 0.093, 0.099, 0, 0.003],
  [-0.1, 0.08, 0.085, 0, 0],
];

function scaleRings(
  rings: [number, number, number, number, number][],
  k: number,
): [number, number, number, number, number][] {
  return rings.map((r) => [r[0], r[1] * k, r[2] * k, r[3], r[4]]);
}

/* ------------------------------------------------------------------ */
/* Pelvis, belt, skirt                                                */
/* ------------------------------------------------------------------ */

function buildPelvis(
  pc: PartCollector,
  style: Loadout['armor']['style'],
  loadout: Loadout,
  look: CharacterLook,
  detail: CharacterDetail,
  rng: () => number,
): void {
  const seg = detail.seg;
  const hipMat = style === 'plate' ? 'metal' : style === 'mail' ? 'mail' : 'cloth';
  const hipCol = style === 'plate'
    ? mixHex(look.armor, 0xaab1b8, 0.4)
    : style === 'mail'
      ? mixHex(look.mail, look.armor, 0.4)
      : mixHex(look.clothDark, look.leather, 0.35);

  const rings: [number, number, number, number, number][] = [
    [-0.15, 0.152, 0.107, 0, 0.002],
    [-0.05, 0.162, 0.113, 0, 0.002],
    [0.05, 0.17, 0.116, 0, 0.001],
    [0.115, 0.164, 0.113, 0, 0],
  ];
  pc.addRaw('hips', hipMat, hipCol, loftCached('pelvis2', rings, seg, false, true));

  // Cloth skirt panels for soft armours.
  if (style === 'gambeson' || style === 'leather') {
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = ((i + 0.5) / n) * Math.PI * 2;
      const mat: 'cloth' | 'leather' = style === 'leather' ? 'leather' : 'cloth';
      const col = style === 'leather'
        ? look.armor
        : mixHex(look.cloth, look.clothDark, 0.3);
      pc.box('hips', mat, col, 0.082, 0.19, 0.02,
        Math.sin(a) * 0.135, -0.19, Math.cos(a) * 0.1,
        Math.cos(a) * 0.2, a, -Math.sin(a) * 0.2);
    }
  }
  if (style === 'mail' || style === 'scale') {
    const n = 5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      pc.box('hips', 'cloth', mixHex(look.cloth, look.clothDark, 0.25), 0.1, 0.22, 0.016,
        Math.sin(a) * 0.14, -0.18, Math.cos(a) * 0.105,
        Math.cos(a) * 0.18, a, -Math.sin(a) * 0.18);
    }
  }
  // Belt pouch + dagger.
  if (detail.extra) {
    pc.box('hips', 'leather', look.leather, 0.08, 0.085, 0.045, -0.115, 0.03, 0.09, 0, 0.3, 0);
    pc.box('hips', 'leather', shade(look.leather, 0.78), 0.08, 0.028, 0.045, -0.115, 0.074, 0.09, 0, 0.3, 0);
    pc.cyl('hips', 'leather', look.grip, 0.013, 0.016, 0.1, 6, -0.155, 0.02, 0.05, 0, 0, 0.5);
    pc.box('hips', 'metal', look.steel, 0.022, 0.012, 0.01, -0.155, 0.062, 0.05, 0, 0, 0.5);
  }
  void loadout;
  void rng;
}

/* ------------------------------------------------------------------ */
/* Cape                                                               */
/* ------------------------------------------------------------------ */

function buildCape(pc: PartCollector, loadout: Loadout, look: CharacterLook, detail: CharacterDetail): void {
  const cloth = mixHex(loadout.color1, loadout.color2, 0.16);
  const trim = look.cloth2;
  // Main cape: two slightly flared panels for a soft silhouette.
  pc.taper('cape', 'cloth', mixHex(cloth, 0x000000, 0.1), 0.36, 0.018, 0.54, 0.028, 0.9, 0, -0.43, -0.035, -0.05);
  pc.taper('cape', 'cloth', shade(trim, 0.85), 0.31, 0.012, 0.47, 0.018, 0.84, 0, -0.42, -0.048, -0.05);
  // Shoulder mantle over the cape.
  pc.taper('cape', 'cloth', cloth, 0.46, 0.18, 0.34, 0.24, 0.16, 0, 0.015, -0.02, 0, 0, 0, 0.02);
  // Clasp.
  pc.sphere('chest', 'metal', look.bronze, 0.028, 8, 6, 0.1, 0.115, 0.115, 1, 1, 0.5);
  pc.sphere('chest', 'metal', look.bronze, 0.024, 8, 6, -0.1, 0.115, 0.115, 1, 1, 0.5);
  void detail;
}
