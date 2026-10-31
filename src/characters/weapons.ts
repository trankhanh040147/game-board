import * as THREE from 'three';
import type { Loadout, ShieldDef } from '../core/types';
import type { PartCollector, CharacterDetail } from './shared';
import { trs, shade } from './shared';
import type { CharacterLook } from './palette';
import { shieldFaceGeometry, shieldTexture, shieldTextureKey } from './heraldry';

export interface WeaponBuild {
  /** Local tip position relative to the weapon joint (grip at origin). */
  tip: THREE.Vector3;
  /** Local blade base (near the hand). */
  base: THREE.Vector3;
  /** Extra left-hand grip target for two-handed weapons (weapon-joint space). */
  grip2: THREE.Vector3;
  twoHanded: boolean;
  /** Whether the weapon has a blade edge (used by trail colour). */
  metalTip: boolean;
}

/**
 * Build the weapon for the loadout into the `weapon` joint.
 * Local space: grip at the origin, blade/haft pointing up +Y, flats facing ±Z.
 */
export function buildWeapon(
  pc: PartCollector,
  loadout: Loadout,
  look: CharacterLook,
  detail: CharacterDetail,
): WeaponBuild {
  const w = loadout.weapon;
  const L = w.length;
  const steel = look.steel;
  const darkSteel = shade(look.steel, 0.62);
  const wood = look.wood;
  const grip = look.grip;
  const seg = detail.seg;
  const J = 'weapon';
  const tip = new THREE.Vector3(0, 1, 0);
  const base = new THREE.Vector3(0, 0.1, 0);
  const grip2 = new THREE.Vector3(0, 0.02, 0);
  let twoHanded = w.twoHanded;
  let metalTip = true;

  switch (w.kind) {
    case 'sword': {
      const bladeLen = L;
      const bladeW = 0.058;
      // Blade: extruded tapered profile with a fuller ridge.
      const bg = bladeProfile(bladeLen, bladeW, 0.014, 0.6);
      pc.addRaw(J, 'metal', steel, bg, trs(0, 0.085, 0));
      bg.dispose();
      // Ridge / fuller highlight.
      if (detail.extra) {
        pc.box(J, 'metal', shade(steel, 1.06), 0.008, bladeLen * 0.72, 0.004, 0, 0.085 + bladeLen * 0.46, 0.008);
      }
      // Crossguard with downward-swept quillons.
      pc.box(J, 'metal', darkSteel, 0.21, 0.022, 0.032, 0, 0.075, 0);
      pc.box(J, 'metal', darkSteel, 0.035, 0.038, 0.026, 0.095, 0.063, 0, 0, 0, -0.35);
      pc.box(J, 'metal', darkSteel, 0.035, 0.038, 0.026, -0.095, 0.063, 0, 0, 0, 0.35);
      // Grip + risers.
      pc.cyl(J, 'leather', grip, 0.019, 0.022, 0.15, seg, 0, 0.0, 0);
      if (detail.extra) {
        for (let i = 0; i < 4; i++) {
          pc.cyl(J, 'leather', shade(grip, 0.7), 0.0225, 0.0225, 0.012, seg, 0, -0.055 + i * 0.038, 0);
        }
      }
      // Pommel disc.
      pc.sphere(J, 'metal', look.bronze, 0.026, 8, 6, 0, -0.085, 0, 1, 0.7, 1);
      tip.set(0, 0.085 + bladeLen, 0);
      base.set(0, 0.1, 0);
      grip2.set(0, -0.03, 0);
      twoHanded = false;
      break;
    }
    case 'saber': {
      const bladeLen = L;
      const bg = curvedBlade(bladeLen, 0.075, 0.014, 0.045);
      pc.addRaw(J, 'metal', steel, bg, trs(0, 0.085, 0));
      bg.dispose();
      // Back edge spine.
      pc.box(J, 'metal', shade(steel, 0.8), 0.012, bladeLen * 0.8, 0.01, -0.026 + 0.012, 0.085 + bladeLen * 0.42, 0, 0, 0, -0.045);
      // Simple guard + grip.
      pc.box(J, 'metal', darkSteel, 0.17, 0.02, 0.03, 0, 0.075, 0);
      pc.cyl(J, 'leather', grip, 0.018, 0.021, 0.14, seg, 0, 0.0, 0);
      pc.sphere(J, 'metal', look.bronze, 0.023, 8, 6, 0, -0.08, 0, 1, 0.8, 1);
      tip.set(0.034, 0.085 + bladeLen, 0);
      base.set(0, 0.1, 0);
      twoHanded = false;
      break;
    }
    case 'axe': {
      const shaftLen = Math.max(0.58, L * 0.78);
      // Haft.
      pc.cyl(J, 'wood', wood, 0.019, 0.023, shaftLen + 0.16, seg, 0, (shaftLen - 0.16) / 2 - 0.02, 0);
      // Butt cap.
      pc.cyl(J, 'metal', darkSteel, 0.026, 0.024, 0.035, seg, 0, -0.15, 0);
      // Axe head: socket + blade + bearded lower horn.
      const hy = shaftLen - 0.09;
      pc.cyl(J, 'metal', darkSteel, 0.034, 0.034, 0.1, seg, 0, hy, 0);
      const head = axeHead(0.17, 0.19, 0.014);
      pc.addRaw(J, 'metal', steel, head, trs(0.045, hy - 0.015, 0, 0, 0, 0));
      head.dispose();
      pc.box(J, 'metal', darkSteel, 0.03, 0.035, 0.05, -0.045, hy, 0);
      tip.set(0.14, hy, 0);
      base.set(0, 0.05, 0);
      grip2.set(0, hy - 0.22, 0);
      twoHanded = false;
      break;
    }
    case 'mace': {
      const shaftLen = Math.max(0.5, L * 0.72);
      pc.cyl(J, 'wood', wood, 0.02, 0.024, shaftLen + 0.14, seg, 0, (shaftLen - 0.14) / 2 - 0.02, 0);
      pc.cyl(J, 'leather', grip, 0.024, 0.025, 0.1, seg, 0, -0.02, 0);
      // Flanged head.
      const hy = shaftLen - 0.04;
      pc.cyl(J, 'metal', steel, 0.042, 0.03, 0.055, seg, 0, hy - 0.055, 0);
      pc.cyl(J, 'metal', steel, 0.05, 0.05, 0.11, 8, 0, hy, 0);
      pc.cyl(J, 'metal', shade(steel, 0.8), 0.028, 0.05, 0.045, 8, 0, hy + 0.075, 0);
      pc.sphere(J, 'metal', steel, 0.028, 8, 6, 0, hy + 0.105, 0);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        pc.box(J, 'metal', shade(steel, 0.92), 0.026, 0.115, 0.05, Math.sin(a) * 0.055, hy, Math.cos(a) * 0.055, 0, a, 0);
      }
      tip.set(0, hy + 0.14, 0);
      base.set(0, 0.05, 0);
      twoHanded = false;
      break;
    }
    case 'greatsword': {
      const bladeLen = L;
      const bg = bladeProfile(bladeLen, 0.075, 0.016, 0.5);
      pc.addRaw(J, 'metal', steel, bg, trs(0, 0.11, 0));
      bg.dispose();
      if (detail.extra) {
        pc.box(J, 'metal', shade(steel, 1.05), 0.01, bladeLen * 0.68, 0.005, 0, 0.11 + bladeLen * 0.47, 0.009);
      }
      // Long crossguard.
      pc.box(J, 'metal', darkSteel, 0.33, 0.028, 0.038, 0, 0.1, 0);
      pc.box(J, 'metal', darkSteel, 0.045, 0.05, 0.032, 0.155, 0.088, 0, 0, 0, -0.4);
      pc.box(J, 'metal', darkSteel, 0.045, 0.05, 0.032, -0.155, 0.088, 0, 0, 0, 0.4);
      // Long two-handed grip.
      pc.cyl(J, 'leather', grip, 0.02, 0.022, 0.3, seg, 0, -0.07, 0);
      pc.cyl(J, 'leather', shade(grip, 0.75), 0.0225, 0.0225, 0.014, seg, 0, 0.01, 0);
      pc.cyl(J, 'leather', shade(grip, 0.75), 0.0225, 0.0225, 0.014, seg, 0, -0.14, 0);
      pc.sphere(J, 'metal', look.bronze, 0.03, 8, 6, 0, -0.225, 0, 1, 0.8, 1);
      tip.set(0, 0.11 + bladeLen, 0);
      base.set(0, 0.13, 0);
      grip2.set(0, -0.1, 0);
      twoHanded = true;
      break;
    }
    case 'spear': {
      const shaftLen = L;
      const half = shaftLen / 2;
      pc.cyl(J, 'wood', wood, 0.018, 0.021, shaftLen, seg, 0, 0.04, 0);
      // Butt ferrule + grip wraps.
      pc.cyl(J, 'metal', darkSteel, 0.023, 0.02, 0.06, seg, 0, 0.04 - half, 0);
      for (let i = 0; i < 3; i++) pc.cyl(J, 'leather', grip, 0.024, 0.024, 0.024, seg, 0, -0.1 + i * 0.06, 0);
      // Leaf spearhead.
      const headBase = 0.04 + half - 0.01;
      pc.cyl(J, 'metal', darkSteel, 0.024, 0.022, 0.07, seg, 0, headBase + 0.01, 0);
      const head = spearHead(0.24, 0.055, 0.012);
      pc.addRaw(J, 'metal', steel, head, trs(0, headBase + 0.03, 0));
      head.dispose();
      tip.set(0, headBase + 0.27, 0);
      base.set(0, headBase - 0.12, 0);
      grip2.set(0, -0.16, 0);
      twoHanded = false;
      break;
    }
    case 'staff': {
      const shaftLen = L;
      const half = shaftLen / 2;
      pc.cyl(J, 'wood', wood, 0.019, 0.021, shaftLen, seg, 0, 0, 0);
      pc.cyl(J, 'metal', darkSteel, 0.022, 0.022, 0.045, seg, 0, half - 0.01, 0);
      pc.cyl(J, 'metal', darkSteel, 0.022, 0.022, 0.045, seg, 0, -half + 0.01, 0);
      for (let i = 0; i < 3; i++) pc.cyl(J, 'leather', grip, 0.0235, 0.0235, 0.028, seg, 0, -0.09 + i * 0.06, 0);
      tip.set(0, half, 0);
      base.set(0, -half * 0.35, 0);
      grip2.set(0, -0.2, 0);
      twoHanded = true;
      metalTip = false;
      break;
    }
    default: {
      // Fallback: simple arming sword.
      pc.cyl(J, 'wood', wood, 0.02, 0.02, 0.9, seg, 0, 0.4, 0);
      tip.set(0, 0.9, 0);
      twoHanded = false;
    }
  }

  // Grip wrap at the hand for all weapons.
  if (w.kind !== 'spear' && w.kind !== 'staff' && w.kind !== 'greatsword') {
    pc.cyl(J, 'leather', shade(grip, 0.85), 0.0235, 0.0235, 0.03, seg, 0, 0.0, 0);
  }

  return { tip, base, grip2, twoHanded, metalTip };
}

/* ------------------------------------------------------------------ */
/* Weapon sub-geometry                                                 */
/* ------------------------------------------------------------------ */

function bladeProfile(length: number, width: number, thickness: number, taper: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.lineTo(hw * 0.9, length * 0.72);
  shape.lineTo(hw * taper, length * 0.94);
  shape.lineTo(0, length);
  shape.lineTo(-hw * taper, length * 0.94);
  shape.lineTo(-hw * 0.9, length * 0.72);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.45,
    bevelSize: hw * 0.24,
    bevelSegments: 1,
    curveSegments: 1,
  });
  g.translate(0, 0, -thickness / 2);
  g.computeVertexNormals();
  return g;
}

function curvedBlade(length: number, width: number, thickness: number, curve: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(-hw, 0);
  shape.lineTo(hw, 0);
  shape.quadraticCurveTo(hw * 0.85 + curve, length * 0.62, curve * 1.9, length * 0.95);
  shape.lineTo(curve * 1.3, length);
  shape.quadraticCurveTo(-hw * 0.55 + curve, length * 0.6, -hw, 0);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.4,
    bevelSize: hw * 0.2,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -thickness / 2);
  g.computeVertexNormals();
  return g;
}

function axeHead(height: number, width: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hh = height / 2;
  shape.moveTo(0, hh);
  shape.lineTo(width * 0.55, hh * 0.62);
  shape.quadraticCurveTo(width, hh * 1.05, width * 0.92, -hh * 0.15);
  shape.quadraticCurveTo(width * 0.8, -hh * 0.9, width * 0.32, -hh * 1.18);
  shape.lineTo(0, -hh * 0.85);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.4,
    bevelSize: 0.003,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -thickness / 2);
  g.computeVertexNormals();
  return g;
}

function spearHead(length: number, width: number, thickness: number): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  const hw = width / 2;
  shape.moveTo(-hw * 0.4, 0);
  shape.lineTo(hw * 0.4, 0);
  shape.quadraticCurveTo(hw, length * 0.35, 0, length);
  shape.quadraticCurveTo(-hw, length * 0.35, -hw * 0.4, 0);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness,
    bevelEnabled: true,
    bevelThickness: thickness * 0.5,
    bevelSize: hw * 0.3,
    bevelSegments: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -thickness / 2);
  g.computeVertexNormals();
  return g;
}

/* ------------------------------------------------------------------ */
/* Shield                                                              */
/* ------------------------------------------------------------------ */

/** Build a shield into the `shield` joint. Local space: face toward +Z. */
export function buildShield(
  pc: PartCollector,
  shield: ShieldDef,
  look: CharacterLook,
  detail: CharacterDetail,
): void {
  const J = 'shield';
  const w = shield.width;
  const h = shield.height;
  const face = shieldFaceGeometry(shield);
  const tex = shieldTexture(shield);
  if (tex) {
    pc.addPainted(J, shieldTextureKey(shield), tex, 0xffffff, face, trs(0, 0, 0.018));
  } else {
    pc.addRaw(J, 'cloth', shield.color, face, trs(0, 0, 0.018));
  }
  face.dispose();

  // Dark leather back + rim thickness.
  const back = shieldFaceGeometry(shield);
  pc.addRaw(J, 'leather', shade(look.leather, 0.55), back, trs(0, 0, -0.012, 0, 0, 0, 1.015, 1.015, 1));
  back.dispose();

  // Rim: a slightly inset band is painted, but add a physical metal rim on the
  // larger shields for silhouette definition.
  if (detail.extra && shield.id !== 'round') {
    const rimGeo = new THREE.ExtrudeGeometry(shieldShapeOutline(shield), {
      depth: 0.05,
      bevelEnabled: false,
      curveSegments: 8,
    });
    rimGeo.translate(0, 0, -0.025);
    // Keep only the outer edge by drawing a dark thin lip slightly behind the face.
    pc.addRaw(J, 'metal', shade(look.trim, 0.72), rimGeo, trs(0, 0, 0.0, 0, 0, 0, 0.985, 0.985, 1));
    rimGeo.dispose();
  }

  // Grip straps + boss (drawn in paint, plus real metal boss on round shields).
  if (shield.id === 'round') {
    pc.sphere(J, 'metal', look.steel, Math.min(w, h) * 0.15, detail.sphereW, detail.sphereH, 0, 0, 0.03, 1, 1, 0.55);
    pc.cyl(J, 'leather', look.leatherDark, 0.02, 0.02, h * 0.42, 6, 0, 0.06, -0.045, Math.PI / 2, 0, 0);
  } else {
    pc.box(J, 'leather', look.leatherDark, w * 0.16, 0.09, 0.02, 0, -h * 0.06, -0.05);
    pc.box(J, 'leather', look.leatherDark, w * 0.7, 0.035, 0.02, 0, h * 0.08, -0.048);
  }
}

function shieldShapeOutline(shield: ShieldDef): THREE.Shape {
  const w = shield.width * 0.47;
  const h = shield.height * 0.47;
  const s = new THREE.Shape();
  if (shield.id === 'tower') {
    s.moveTo(-w, h);
    s.lineTo(w, h);
    s.lineTo(w, -h);
    s.lineTo(-w, -h);
    s.closePath();
  } else {
    s.moveTo(-w, h);
    s.quadraticCurveTo(0, h + h * 0.1, w, h);
    s.quadraticCurveTo(w * 0.9, -h * 0.2, 0, -h);
    s.quadraticCurveTo(-w * 0.9, -h * 0.2, -w, h);
    s.closePath();
  }
  return s;
}
