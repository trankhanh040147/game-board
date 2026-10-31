import * as THREE from 'three';
import type {
  Appearance, AttackDir, CharacterRig, GuardDir, Loadout, Quality, RigAction,
} from '../core/types';

/**
 * TEMPORARY character rig stub — character-artist replaces this file.
 * A blocky humanoid with a sword and shield so integration can proceed.
 */
export function createCharacterRig(opts: {
  loadout: Loadout;
  appearance: Appearance;
  quality: Quality;
}): CharacterRig {
  const { loadout, appearance } = opts;
  const root = new THREE.Group();
  root.name = 'character';

  const scale = appearance.build;
  const skin = new THREE.MeshStandardMaterial({ color: appearance.skinTone, roughness: 0.85 });
  const cloth = new THREE.MeshStandardMaterial({ color: loadout.color1, roughness: 0.9 });
  const cloth2 = new THREE.MeshStandardMaterial({ color: loadout.color2, roughness: 0.9 });
  const steel = new THREE.MeshStandardMaterial({ color: loadout.weapon.bladeColor, roughness: 0.35, metalness: 0.8 });
  const darkSteel = new THREE.MeshStandardMaterial({ color: loadout.armor.color, roughness: 0.6, metalness: 0.5 });

  const hips = new THREE.Group();
  hips.position.y = 0.92;
  root.add(hips);

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.62, 0.28), darkSteel);
  torso.position.y = 0.3;
  torso.castShadow = true;
  hips.add(torso);

  const tabard = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.7, 0.05), cloth);
  tabard.position.set(0, 0.12, 0.17);
  tabard.castShadow = true;
  hips.add(tabard);

  const neck = new THREE.Group();
  neck.position.y = 0.62;
  hips.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 10), skin);
  head.position.y = 0.12;
  head.castShadow = true;
  neck.add(head);

  if (loadout.helmet.style !== 'none') {
    const helm = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.62), darkSteel);
    helm.position.y = 0.14;
    helm.castShadow = true;
    neck.add(helm);
  }

  const mkArm = (side: 1 | -1) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(0.29 * side, 0.55, 0);
    hips.add(shoulder);
    const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.26, 4, 8), cloth);
    upper.position.y = -0.16;
    upper.castShadow = true;
    shoulder.add(upper);
    const elbow = new THREE.Group();
    elbow.position.y = -0.3;
    shoulder.add(elbow);
    const lower = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.24, 4, 8), skin);
    lower.position.y = -0.14;
    lower.castShadow = true;
    elbow.add(lower);
    const hand = new THREE.Group();
    hand.position.y = -0.3;
    elbow.add(hand);
    return { shoulder, elbow, hand };
  };
  const armR = mkArm(1);
  const armL = mkArm(-1);

  const mkLeg = (side: 1 | -1) => {
    const hip = new THREE.Group();
    hip.position.set(0.13 * side, 0, 0);
    hips.add(hip);
    const thigh = new THREE.Mesh(new THREE.CapsuleGeometry(0.08, 0.3, 4, 8), darkSteel);
    thigh.position.y = -0.2;
    thigh.castShadow = true;
    hip.add(thigh);
    const knee = new THREE.Group();
    knee.position.y = -0.4;
    hip.add(knee);
    const shin = new THREE.Mesh(new THREE.CapsuleGeometry(0.065, 0.3, 4, 8), darkSteel);
    shin.position.y = -0.18;
    shin.castShadow = true;
    knee.add(shin);
    return { hip, knee };
  };
  const legR = mkLeg(1);
  const legL = mkLeg(-1);

  // weapon
  const weaponGroup = new THREE.Group();
  weaponGroup.position.set(0, -0.06, 0.03);
  armR.hand.add(weaponGroup);
  const blade = new THREE.Mesh(new THREE.BoxGeometry(0.05, loadout.weapon.length, 0.012), steel);
  blade.position.y = loadout.weapon.length / 2;
  blade.castShadow = true;
  weaponGroup.add(blade);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.03, 0.04), cloth2);
  weaponGroup.add(guard);

  // shield
  let shieldMesh: THREE.Mesh | null = null;
  if (loadout.shield) {
    shieldMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(0.32, 0.32, 0.05, 16),
      new THREE.MeshStandardMaterial({ color: loadout.shield.color, roughness: 0.8 }),
    );
    shieldMesh.rotation.z = Math.PI / 2;
    shieldMesh.position.set(-0.05, -0.24, 0.1);
    shieldMesh.castShadow = true;
    armL.elbow.add(shieldMesh);
  }

  root.scale.setScalar(scale);

  const tip = new THREE.Vector3();
  const base = new THREE.Vector3();
  let dead = false;
  let opacity = 1;

  return {
    root,
    height: 1.8 * scale,
    update: (dt: number) => {
      if (dead) return;
      const t = performance.now() * 0.001;
      torso.rotation.x = Math.sin(t * 1.6) * 0.01;
    },
    setMotion: (speed: number) => {
      if (dead) return;
      const s = Math.min(1, speed / 4);
      const t = performance.now() * 0.001;
      legR.hip.rotation.x = Math.sin(t * 8) * 0.5 * s;
      legL.hip.rotation.x = -Math.sin(t * 8) * 0.5 * s;
      armL.shoulder.rotation.x = -Math.sin(t * 8) * 0.4 * s;
    },
    setGuard: (dir: GuardDir | null) => {
      if (dead) return;
      if (dir) {
        armR.shoulder.rotation.x = -0.8;
        armR.elbow.rotation.x = -1.1;
      } else {
        armR.shoulder.rotation.x = 0;
        armR.elbow.rotation.x = 0;
      }
    },
    playAttack: (dir: AttackDir) => {
      if (dead) return;
      const s = dir === 'left' ? -1 : 1;
      armR.shoulder.rotation.x = -2.4;
      armR.shoulder.rotation.z = s * 0.8;
      setTimeout(() => {
        if (dead) return;
        armR.shoulder.rotation.x = 0.5;
        armR.shoulder.rotation.z = 0;
      }, 160);
    },
    playAction: (action: RigAction) => {
      if (action === 'die') {
        dead = true;
        root.rotation.z = Math.PI / 2;
        root.position.y = 0.2;
      }
      if (action === 'victory') {
        armR.shoulder.rotation.x = -2.8;
        armL.shoulder.rotation.x = -2.8;
      }
      if (action === 'stagger') {
        hips.rotation.x = -0.35;
        setTimeout(() => { hips.rotation.x = 0; }, 450);
      }
    },
    setLookTarget: () => undefined,
    getWeaponTip: (out: THREE.Vector3) => {
      weaponGroup.updateWorldMatrix(true, true);
      tip.set(0, loadout.weapon.length, 0);
      weaponGroup.localToWorld(tip);
      return out.copy(tip);
    },
    getWeaponBase: (out: THREE.Vector3) => {
      weaponGroup.updateWorldMatrix(true, true);
      base.set(0, 0.1, 0);
      weaponGroup.localToWorld(base);
      return out.copy(base);
    },
    getAnchor: (kind, out) => {
      if (kind === 'head') head.getWorldPosition(out);
      else if (kind === 'chest') torso.getWorldPosition(out);
      else root.getWorldPosition(out);
      return out;
    },
    setOpacity: (v: number) => {
      opacity = v;
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          const m = o.material as THREE.MeshStandardMaterial;
          if (!m.transparent && v < 1) {
            m.transparent = true;
            m.depthWrite = false;
          }
          m.opacity = opacity;
        }
      });
    },
    setDead: (d: boolean) => { dead = d; },
    dispose: () => {
      root.removeFromParent();
      root.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const m = o.material;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m.dispose();
        }
      });
    },
  };
}
