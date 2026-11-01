import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createCharacterRig } from '../src/characters/rig';
import { createAppearance } from '../src/characters/appearance';
import { ARMORS, HELMETS, SHIELDS, TEAM_PALETTE, WEAPONS, attackTiming } from '../src/core/config';
import { ATTACK_DIRS as CORE_ATTACK_DIRS } from '../src/core/types';
import type { AttackDir, Loadout, Quality } from '../src/core/types';

function makeLoadout(weaponId = 'arming_sword', styleId = 'hauberk', helmetId = 'nasal', shieldId: string | null = 'kite'): Loadout {
  const team = TEAM_PALETTE[0];
  const shield = shieldId ? { ...SHIELDS[shieldId], color: team.color, color2: team.secondary } : null;
  return {
    weapon: { ...WEAPONS[weaponId] },
    shield,
    armor: { ...ARMORS[styleId] },
    helmet: { ...HELMETS[helmetId] },
    color1: team.color,
    color2: team.secondary,
    title: 'Test',
  };
}

function makeRig(overrides: Partial<{ weapon: string; armor: string; helmet: string; shield: string | null; seed: number; quality: Quality }> = {}) {
  const loadout = makeLoadout(overrides.weapon, overrides.armor, overrides.helmet, overrides.shield ?? 'kite');
  const appearance = createAppearance(overrides.seed ?? 1234, loadout, loadout.color1, loadout.color2);
  return createCharacterRig({ loadout, appearance, quality: overrides.quality ?? 'high' });
}

function step(rig: ReturnType<typeof createCharacterRig>, seconds: number, dt = 1 / 60): void {
  const n = Math.max(1, Math.round(seconds / dt));
  for (let i = 0; i < n; i++) rig.update(dt);
}

function finite(v: THREE.Vector3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

describe('createAppearance', () => {
  it('is deterministic and produces valid ranges', () => {
    const loadout = makeLoadout();
    const a = createAppearance(42, loadout, loadout.color1, loadout.color2);
    const b = createAppearance(42, loadout, loadout.color1, loadout.color2);
    expect(a).toEqual(b);
    expect(a.build).toBeGreaterThanOrEqual(0.9);
    expect(a.build).toBeLessThanOrEqual(1.1);
    expect(a.beard).toBeGreaterThanOrEqual(0);
    expect(a.beard).toBeLessThanOrEqual(3);
    expect(a.heraldry).toBeGreaterThanOrEqual(0);
    expect(a.heraldry).toBeLessThanOrEqual(2);
    expect(Number.isFinite(a.skinTone)).toBe(true);
    expect(Number.isFinite(a.hairColor)).toBe(true);
  });

  it('varies with the seed', () => {
    const loadout = makeLoadout();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const keys = seeds.map((s) => {
      const a = createAppearance(s, loadout, loadout.color1, loadout.color2);
      return `${a.skinTone}:${a.hairColor}:${a.beard}:${a.build.toFixed(3)}`;
    });
    expect(new Set(keys).size).toBeGreaterThan(3);
  });
});

describe('createCharacterRig — contract', () => {
  it('exposes the CharacterRig surface and sensible anchors', () => {
    const rig = makeRig();
    expect(rig.root).toBeInstanceOf(THREE.Group);
    expect(rig.height).toBeGreaterThan(1.6);
    expect(rig.height).toBeLessThan(2.05);
    const head = rig.getAnchor('head', new THREE.Vector3());
    const chest = rig.getAnchor('chest', new THREE.Vector3());
    const root = rig.getAnchor('root', new THREE.Vector3());
    expect(head.y).toBeGreaterThan(chest.y);
    expect(chest.y).toBeGreaterThan(root.y);
    expect(finite(head) && finite(chest)).toBe(true);
    const tip = rig.getWeaponTip(new THREE.Vector3());
    const base = rig.getWeaponBase(new THREE.Vector3());
    expect(finite(tip) && finite(base)).toBe(true);
    expect(tip.distanceTo(base)).toBeGreaterThan(0.5);
    rig.dispose();
  });

  it('builds few skinned meshes per fighter (draw-call budget)', () => {
    const rig = makeRig();
    let skinned = 0;
    let meshes = 0;
    rig.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) {
        meshes++;
        if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned++;
      }
    });
    expect(skinned).toBeGreaterThan(4);
    expect(skinned).toBeLessThanOrEqual(14);
    expect(meshes).toBeLessThanOrEqual(18);
    rig.dispose();
  });

  it('builds every weapon and armour style without throwing', () => {
    for (const weaponId of Object.keys(WEAPONS)) {
      for (const armorId of Object.keys(ARMORS)) {
        const rig = makeRig({ weapon: weaponId, armor: armorId, helmet: 'great', shield: null });
        step(rig, 0.2);
        expect(rig.height).toBeGreaterThan(1.6);
        rig.dispose();
      }
    }
  });
});

describe('createCharacterRig — animation', () => {
  it('plays all four attacks with distinct weapon arcs', () => {
    const arcs: number[][] = [];
    for (const dir of CORE_ATTACK_DIRS as AttackDir[]) {
      const rig = makeRig({ weapon: 'arming_sword' });
      step(rig, 0.2);
      rig.playAttack(dir, 1);
      const tip = new THREE.Vector3();
      const samples: number[] = [];
      for (let i = 0; i < 30; i++) {
        rig.update(1 / 60);
        rig.getWeaponTip(tip);
        samples.push(tip.x, tip.y, tip.z);
      }
      expect(samples.every((v) => Number.isFinite(v))).toBe(true);
      // The tip must actually travel during the swing.
      const start = new THREE.Vector3(samples[0], samples[1], samples[2]);
      let maxTravel = 0;
      for (let i = 0; i < samples.length; i += 3) {
        maxTravel = Math.max(maxTravel, start.distanceTo(new THREE.Vector3(samples[i], samples[i + 1], samples[i + 2])));
      }
      expect(maxTravel).toBeGreaterThan(0.35);
      arcs.push(samples);
      rig.dispose();
    }
    // Different directions must produce different tip paths.
    const diffs = new Set<string>();
    for (const a of arcs) diffs.add(a.map((v) => v.toFixed(2)).join(','));
    expect(diffs.size).toBe(4);
  });

  it('times attack movement inside attackTiming()', () => {
    const rig = makeRig({ weapon: 'arming_sword' });
    step(rig, 0.2);
    const timing = attackTiming(WEAPONS.arming_sword, 1);
    rig.playAttack('overhead', 1);
    const tip = new THREE.Vector3();
    const positions: THREE.Vector3[] = [];
    const dt = 1 / 240;
    for (let t = 0; t < Math.min(1.2, timing.total + 0.3); t += dt) {
      rig.update(dt);
      rig.getWeaponTip(tip);
      positions.push(tip.clone());
    }
    const activeStart = Math.floor(timing.windup / dt);
    const activeEnd = Math.min(positions.length - 1, Math.floor((timing.windup + timing.active) / dt));
    let windupTravel = 0;
    let activeTravel = 0;
    for (let i = 1; i < positions.length; i++) {
      const d = positions[i].distanceTo(positions[i - 1]);
      if (i <= activeStart) windupTravel += d;
      else if (i <= activeEnd) activeTravel += d;
    }
    expect(windupTravel).toBeGreaterThan(0.1);
    expect(activeTravel).toBeGreaterThan(0.1);
    rig.dispose();
  });

  it('supports motion, guards, look-at and all actions without NaNs', () => {
    const rig = makeRig({ weapon: 'greatsword', armor: 'plate' });
    rig.setLookTarget(new THREE.Vector3(0, 1.5, 5));
    rig.setMotion(3.9, 0, 3.9);
    step(rig, 1.5);
    rig.setGuard('overhead');
    step(rig, 0.5);
    rig.setGuard(null);
    for (const action of ['hit', 'stagger', 'kick', 'dodge', 'bash', 'victory', 'taunt', 'spawn'] as const) {
      rig.playAction(action, { dir: new THREE.Vector3(0, 0, 1), variant: 1 });
      step(rig, 0.6);
      const tip = rig.getWeaponTip(new THREE.Vector3());
      expect(finite(tip)).toBe(true);
    }
    rig.setDead(false);
    rig.dispose();
  });

  it('collapses to the ground cleanly on death', () => {
    const rig = makeRig();
    step(rig, 0.2);
    rig.playAction('die');
    step(rig, 2.4);
    const head = rig.getAnchor('head', new THREE.Vector3());
    expect(finite(head)).toBe(true);
    expect(head.y).toBeLessThan(0.9);
    // Character must not sink through the floor.
    expect(head.y).toBeGreaterThan(-0.2);
    rig.setDead(true);
    step(rig, 0.2);
    rig.setDead(false);
    step(rig, 0.1);
    rig.dispose();
  });

  it('fades opacity and restores shared materials', () => {
    const rig = makeRig();
    const mesh = rig.root.children.find((c) => (c as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh;
    const original = mesh.material as THREE.Material;
    rig.setOpacity(0.35);
    expect(mesh.material).not.toBe(original);
    expect((mesh.material as THREE.MeshStandardMaterial).opacity).toBeCloseTo(0.35, 3);
    rig.setOpacity(1);
    expect((mesh.material as THREE.MeshStandardMaterial).opacity).toBe(1);
    rig.dispose();
  });

  it('disposes without leaking the scene graph', () => {
    const parent = new THREE.Group();
    const rig = makeRig();
    parent.add(rig.root);
    expect(parent.children.length).toBe(1);
    rig.dispose();
    expect(parent.children.length).toBe(0);
    // Double dispose must be safe.
    rig.dispose();
  });

  it('matches the documented 8 attacks dirs and rig height proportions', () => {
    expect(CORE_ATTACK_DIRS.length).toBe(4);
    for (const dir of CORE_ATTACK_DIRS) {
      expect(['left', 'right', 'overhead', 'thrust']).toContain(dir);
    }
    const rig = makeRig();
    const head = rig.getAnchor('head', new THREE.Vector3());
    const feet = rig.getAnchor('root', new THREE.Vector3());
    const voxelHead = (head.y - feet.y) / (rig.height / 7.3);
    expect(voxelHead).toBeGreaterThan(6.6);
    expect(voxelHead).toBeLessThan(7.8);
    rig.dispose();
  });
});

describe('locomotion + attack contact (P1 follow-up)', () => {
  it('lifts each foot clearly without ground penetration (walk/run/strafe/back)', () => {
    for (const [speed, strafe, forward, minLift] of [
      [3.9, 0, 3.9, 0.1],
      [6.15, 0, 6.15, 0.14],
      [2.8, -2.8, 0, 0.08],
      [2.6, 0, -2.6, 0.07],
    ] as [number, number, number, number][]) {
      const rig = makeRig({ weapon: 'arming_sword', armor: 'hauberk' });
      rig.setMotion(speed, strafe, forward);
      let maxL = 0;
      let maxR = 0;
      let minSole = 1;
      const feet = { left: 0, right: 0 };
      for (let i = 0; i < 480; i++) {
        rig.update(1 / 120);
        rig.debugFeet(feet);
        maxL = Math.max(maxL, feet.left);
        maxR = Math.max(maxR, feet.right);
        minSole = Math.min(minSole, feet.left, feet.right);
      }
      expect(minSole).toBeGreaterThan(-0.01);
      expect(maxL).toBeGreaterThan(minLift);
      expect(maxR).toBeGreaterThan(minLift);
      rig.dispose();
    }
  });

  it('attack tips reach the 2.1 m target plane for all four directions', () => {
    for (const dir of CORE_ATTACK_DIRS as AttackDir[]) {
      const rig = makeRig({ weapon: 'arming_sword', armor: 'hauberk' });
      step(rig, 0.2);
      rig.playAttack(dir, 1);
      const timing = attackTiming(WEAPONS.arming_sword, 1);
      const contact = timing.windup + timing.active * 0.65;
      const dt = 1 / 240;
      const tip = new THREE.Vector3();
      let best = Infinity;
      let bestTip = new THREE.Vector3();
      for (let t = 0; t < contact; t += dt) {
        rig.update(dt);
        rig.debugTip(tip);
        const d = Math.hypot(tip.x, tip.z - 2.1);
        if (d < best) { best = d; bestTip = tip.clone(); }
      }
      expect(Number.isFinite(best)).toBe(true);
      expect(best).toBeLessThan(0.66);
      expect(bestTip.z).toBeGreaterThan(1.5);
      rig.dispose();
    }
  });
});
