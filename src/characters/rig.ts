import * as THREE from 'three';
import type {
  Appearance,
  AttackDir,
  CharacterRig,
  GuardDir,
  Loadout,
  Quality,
  RigAction,
} from '../core/types';
import { BODY_HEIGHT, SKELETON } from './skeleton';
import { detailFor, getMaterials, PartCollector, TMP_V1, TMP_V2 } from './shared';
import { makeLook } from './palette';
import { buildCharacter } from './model';
import { buildShield, buildWeapon } from './weapons';
import { CharacterAnimator } from './animation';

const TRAIL_SAMPLES = 10;

/** Extra dev-only readouts for the character lab (not used by the game). */
export interface CharacterRigDebug extends CharacterRig {
  /** Current sole heights (metres above the character's ground plane). */
  debugFeet(out: { left: number; right: number }): void;
  /** Weapon tip in root-local space (x right, y up, z forward). */
  debugTip(out: THREE.Vector3): void;
}

/**
 * A procedural, rigid-part medieval fighter.
 *
 * Geometry is built from shared primitives + canvas textures and merged into a
 * handful of rigid-weighted SkinnedMeshes (one per material class, ~10 draw
 * calls per fighter). Animation is a layered procedural system driven by a bone
 * hierarchy — see `CharacterAnimator`.
 */
export function createCharacterRig(opts: {
  loadout: Loadout;
  appearance: Appearance;
  quality: Quality;
}): CharacterRigDebug {
  const { loadout, appearance, quality } = opts;
  const detail = detailFor(quality);
  const materials = getMaterials();
  const look = makeLook(loadout, appearance);

  const root = new THREE.Group();
  root.name = 'character';
  const body = new THREE.Bone();
  body.name = 'body';
  root.add(body);

  const bones = new Map<string, THREE.Bone>();
  const boneList: THREE.Bone[] = [];
  const bone = (name: string, parent: THREE.Object3D, offset?: readonly [number, number, number]): THREE.Bone => {
    const b = new THREE.Bone();
    b.name = name;
    if (offset) b.position.set(offset[0], offset[1], offset[2]);
    parent.add(b);
    bones.set(name, b);
    boneList.push(b);
    return b;
  };

  const hips = bone('hips', body, SKELETON.hips);
  const spine = bone('spine', hips, SKELETON.spine);
  const chest = bone('chest', spine, SKELETON.chest);
  const neck = bone('neck', chest, SKELETON.neck);
  const head = bone('head', neck, SKELETON.head);
  const shoulderR = bone('shoulderR', chest, SKELETON.shoulderR);
  const elbowR = bone('elbowR', shoulderR, SKELETON.elbowR);
  const handR = bone('handR', elbowR, SKELETON.handR);
  const shoulderL = bone('shoulderL', chest, SKELETON.shoulderL);
  const elbowL = bone('elbowL', shoulderL, SKELETON.elbowL);
  const handL = bone('handL', elbowL, SKELETON.handL);
  const thighR = bone('thighR', hips, SKELETON.thighR);
  const kneeR = bone('kneeR', thighR, SKELETON.kneeR);
  const footR = bone('footR', kneeR, SKELETON.footR);
  const thighL = bone('thighL', hips, SKELETON.thighL);
  const kneeL = bone('kneeL', thighL, SKELETON.kneeL);
  const footL = bone('footL', kneeL, SKELETON.footL);
  const cape = bone('cape', chest, SKELETON.cape);

  // Weapon grip (skinned to the right hand). Swords/axes are held with the
  // blade perpendicular to the forearm (out of the thumb side); long-hafted
  // weapons run along the arm axis instead.
  const weapon = bone('weapon', handR, [0, -0.03, 0.02]);
  const wk = loadout.weapon.kind;
  if (wk === 'spear' || wk === 'staff') weapon.rotation.set(Math.PI, 0, 0);
  else if (wk === 'axe' || wk === 'mace') weapon.rotation.set(Math.PI / 2, Math.PI / 2, 0);
  else weapon.rotation.set(Math.PI / 2, 0, 0);
  // Shield: a dedicated bone driven by its own pose channel (positioned in
  // chest space, so the left arm can pose naturally behind it).
  const shield = bone('shield', elbowL, [0.02, -0.28, 0.1]);
  shield.scale.setScalar(0.84);

  // Build the body + equipment, then merge into skinned meshes.
  const pc = new PartCollector();
  buildCharacter(pc, loadout, appearance, look, detail);
  const weaponBuild = buildWeapon(pc, loadout, look, detail);
  if (loadout.shield) buildShield(pc, loadout.shield, look, detail);
  const { meshes, skeleton } = pc.buildSkinned(boneList, bones, root, materials, {
    castShadow: true,
    receiveShadow: true,
  });

  // Contact shadow blob (cheap grounding cue that works without shadow maps).
  const shadowGeo = new THREE.CircleGeometry(0.34, 18);
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x241a10,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const shadowBlob = new THREE.Mesh(shadowGeo, shadowMat);
  shadowBlob.name = 'contact-shadow';
  shadowBlob.rotation.x = -Math.PI / 2;
  shadowBlob.position.y = 0.012;
  shadowBlob.renderOrder = 1;
  root.add(shadowBlob);

  const build = appearance.build;

  const animator = new CharacterAnimator({ loadout, seed: appearance.seed + 0x9e37 });

  // ---- Weapon trail -------------------------------------------------
  const useTrail = detail.extra;
  let trail: THREE.Mesh | null = null;
  const trailPos = new Float32Array(TRAIL_SAMPLES * 2 * 3);
  const trailCol = new Float32Array(TRAIL_SAMPLES * 2 * 3);
  const trailBase = new Float32Array(TRAIL_SAMPLES * 3);
  const trailTip = new Float32Array(TRAIL_SAMPLES * 3);
  let trailCount = 0;
  const trailIndexData: number[] = [];
  for (let i = 0; i < TRAIL_SAMPLES - 1; i++) {
    const a = i * 2;
    trailIndexData.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }

  if (useTrail) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(trailPos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(trailCol, 3));
    g.setIndex(trailIndexData);
    g.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    trail = new THREE.Mesh(g, mat);
    trail.name = 'weapon-trail';
    trail.frustumCulled = false;
    trail.renderOrder = 3;
    root.add(trail);
  }

  const worldTip = new THREE.Vector3();
  const worldBase = new THREE.Vector3();
  const rawTip = new THREE.Vector3();
  const rawBase = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const steelColor = new THREE.Color(weaponBuild.metalTip ? 0xfff0d2 : 0xd9c9a3);

  let dead = false;
  let opacity = 1;
  let ownMaterials: Map<THREE.Material, THREE.Material> | null = null;
  const ownedMaterials: THREE.Material[] = [];
  let disposed = false;

  function applyPose(): void {
    const p = animator.pose;
    body.rotation.set(p.bodyRot.x, p.bodyRot.y, p.bodyRot.z);
    body.position.set(p.bodyPos.x, p.bodyPos.y, p.bodyPos.z);
    hips.position.set(
      SKELETON.hips[0] + p.hipsOffset.x,
      SKELETON.hips[1] + p.hipsOffset.y,
      SKELETON.hips[2] + p.hipsOffset.z,
    );
    const rot = p.rot;
    spine.rotation.set(rot.spine.x, rot.spine.y, rot.spine.z);
    chest.rotation.set(rot.chest.x, rot.chest.y, rot.chest.z);
    neck.rotation.set(rot.neck.x, rot.neck.y, rot.neck.z);
    head.rotation.set(rot.head.x, rot.head.y, rot.head.z);
    shoulderR.rotation.set(rot.shoulderR.x, rot.shoulderR.y, rot.shoulderR.z);
    elbowR.rotation.set(rot.elbowR.x, rot.elbowR.y, rot.elbowR.z);
    handR.rotation.set(rot.handR.x, rot.handR.y, rot.handR.z);
    shoulderL.rotation.set(rot.shoulderL.x, rot.shoulderL.y, rot.shoulderL.z);
    elbowL.rotation.set(rot.elbowL.x, rot.elbowL.y, rot.elbowL.z);
    handL.rotation.set(rot.handL.x, rot.handL.y, rot.handL.z);
    thighR.rotation.set(rot.thighR.x, rot.thighR.y, rot.thighR.z);
    kneeR.rotation.set(rot.kneeR.x, rot.kneeR.y, rot.kneeR.z);
    footR.rotation.set(rot.footR.x, rot.footR.y, rot.footR.z);
    thighL.rotation.set(rot.thighL.x, rot.thighL.y, rot.thighL.z);
    kneeL.rotation.set(rot.kneeL.x, rot.kneeL.y, rot.kneeL.z);
    footL.rotation.set(rot.footL.x, rot.footL.y, rot.footL.z);
    cape.rotation.set(rot.cape.x, rot.cape.y, rot.cape.z);
  }

  function weaponTipWorld(): THREE.Vector3 {
    return rawTip.copy(weaponBuild.tip).applyMatrix4(weapon.matrixWorld);
  }
  function weaponBaseWorld(): THREE.Vector3 {
    return rawBase.copy(weaponBuild.base).applyMatrix4(weapon.matrixWorld);
  }

  function sampleTrail(): void {
    for (let i = TRAIL_SAMPLES - 1; i > 0; i--) {
      const o = i * 3;
      const po = (i - 1) * 3;
      trailBase[o] = trailBase[po];
      trailBase[o + 1] = trailBase[po + 1];
      trailBase[o + 2] = trailBase[po + 2];
      trailTip[o] = trailTip[po];
      trailTip[o + 1] = trailTip[po + 1];
      trailTip[o + 2] = trailTip[po + 2];
    }
    root.worldToLocal(worldBase.copy(weaponBaseWorld()));
    root.worldToLocal(worldTip.copy(weaponTipWorld()));
    trailBase[0] = worldBase.x;
    trailBase[1] = worldBase.y;
    trailBase[2] = worldBase.z;
    trailTip[0] = worldTip.x;
    trailTip[1] = worldTip.y;
    trailTip[2] = worldTip.z;

    if (!trail) return;
    const active = animator.trailActive;
    if (active) trailCount = Math.min(TRAIL_SAMPLES, trailCount + 1);
    else if (trailCount > 0) trailCount = Math.max(0, trailCount - 4);
    if (trailCount < 2) {
      trail.visible = false;
      return;
    }
    let vi = 0;
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const o = i * 3;
      trailPos[vi++] = trailBase[o];
      trailPos[vi++] = trailBase[o + 1];
      trailPos[vi++] = trailBase[o + 2];
      trailPos[vi++] = trailTip[o];
      trailPos[vi++] = trailTip[o + 1];
      trailPos[vi++] = trailTip[o + 2];
    }
    for (let i = 0; i < TRAIL_SAMPLES; i++) {
      const age = i / Math.max(1, trailCount - 1);
      const k = Math.max(0, 1 - age);
      const a = k * k * (active ? 0.62 : 0.18);
      const o = i * 6;
      tmpColor.copy(steelColor).multiplyScalar(a * 0.55);
      trailCol[o] = tmpColor.r;
      trailCol[o + 1] = tmpColor.g;
      trailCol[o + 2] = tmpColor.b;
      trailCol[o + 3] = tmpColor.r * 0.3;
      trailCol[o + 4] = tmpColor.g * 0.3;
      trailCol[o + 5] = tmpColor.b * 0.3;
    }
    const geo = trail.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    geo.setDrawRange(0, Math.max(0, trailCount - 1) * 6);
    trail.visible = true;
  }

  const headAnchor = new THREE.Vector3();
  const soleLocal = new THREE.Vector3(0, -0.089, 0.055);
  const soleL = new THREE.Vector3();
  const soleR = new THREE.Vector3();
  const rootWorld = new THREE.Vector3();
  const feetDbg = { left: 0, right: 0 };
  const tipDbg = new THREE.Vector3();
  const qSpine = new THREE.Quaternion();
  const qChest = new THREE.Quaternion();
  const qShoulder = new THREE.Quaternion();
  const qElbow = new THREE.Quaternion();
  const qShieldChain = new THREE.Quaternion();
  const qShieldTilt = new THREE.Quaternion();
  const eShield = new THREE.Euler();
  const shieldBase = new THREE.Vector3(0.02, -0.28, 0.1);

  /** Keep the shield face aligned to the body, riding on the left forearm. */
  function updateShieldTransform(): void {
    const r = animator.pose.rot;
    qSpine.setFromEuler(eShield.set(r.spine.x, r.spine.y, r.spine.z, 'XYZ'));
    qChest.setFromEuler(eShield.set(r.chest.x, r.chest.y, r.chest.z, 'XYZ'));
    qShoulder.setFromEuler(eShield.set(r.shoulderL.x, r.shoulderL.y, r.shoulderL.z, 'XYZ'));
    qElbow.setFromEuler(eShield.set(r.elbowL.x, r.elbowL.y, r.elbowL.z, 'XYZ'));
    qShieldChain.copy(qSpine).multiply(qChest).multiply(qShoulder).multiply(qElbow).invert();
    qShieldTilt.setFromEuler(eShield.set(
      animator.pose.shieldRot.x, animator.pose.shieldRot.y, animator.pose.shieldRot.z, 'XYZ'));
    shield.quaternion.copy(qShieldChain).multiply(qShieldTilt);
    shield.position.set(
      shieldBase.x + animator.pose.shieldPos.x,
      shieldBase.y + animator.pose.shieldPos.y,
      shieldBase.z + animator.pose.shieldPos.z,
    );
  }

  // Bind while the root is at identity, then apply the build scale.
  root.scale.setScalar(build);
  root.updateMatrixWorld(true);

  return {
    root,
    height: BODY_HEIGHT * build,

    update(dt: number): void {
      if (disposed) return;
      const step = Math.min(Math.max(dt, 0), 0.1);
      root.getWorldPosition(TMP_V1);
      animator.update(step, root.rotation.y, TMP_V1);
      applyPose();
      if (loadout.shield) updateShieldTransform();
      root.updateMatrixWorld(true);
      // Pin the lower foot to the sand each frame: the body height is derived
      // from the leg pose, so no foot can sink and no stance foot floats.
      if (!animator.isDead) {
        root.getWorldPosition(rootWorld);
        footL.localToWorld(soleL.copy(soleLocal));
        footR.localToWorld(soleR.copy(soleLocal));
        const minSole = Math.min(soleL.y, soleR.y) - rootWorld.y;
        const delta = 0.004 - minSole;
        if (Math.abs(delta) > 0.0008) {
          animator.pose.hipsOffset.y += delta / build;
          applyPose();
          root.updateMatrixWorld(true);
          footL.localToWorld(soleL.copy(soleLocal));
          footR.localToWorld(soleR.copy(soleLocal));
        }
        feetDbg.left = soleL.y - rootWorld.y;
        feetDbg.right = soleR.y - rootWorld.y;
      } else {
        feetDbg.left = soleL.y - rootWorld.y;
        feetDbg.right = soleR.y - rootWorld.y;
      }
      if (trail && (animator.trailActive || trailCount > 0)) {
        sampleTrail();
      }
      shadowMat.opacity = 0.32 * opacity;
      void skeleton;
    },

    setMotion(speed: number, strafe: number, forward: number): void {
      animator.setMotion(speed, strafe, forward);
    },

    setGuard(dir: GuardDir | null): void {
      animator.setGuard(dir);
    },

    playAttack(dir: AttackDir, speedMul: number): void {
      animator.playAttack(dir, speedMul, loadout.weapon);
    },

    playAction(action: RigAction, actionOpts?: { dir?: THREE.Vector3; variant?: number }): void {
      if (dead && action !== 'die') return;
      animator.playAction(action, actionOpts, root.rotation.y);
    },

    setLookTarget(v: THREE.Vector3 | null): void {
      animator.setLookTarget(v);
    },

    getWeaponTip(out: THREE.Vector3): THREE.Vector3 {
      weapon.updateWorldMatrix(true, false);
      return out.copy(weaponBuild.tip).applyMatrix4(weapon.matrixWorld);
    },

    getWeaponBase(out: THREE.Vector3): THREE.Vector3 {
      weapon.updateWorldMatrix(true, false);
      return out.copy(weaponBuild.base).applyMatrix4(weapon.matrixWorld);
    },

    debugFeet(out: { left: number; right: number }): void {
      out.left = feetDbg.left;
      out.right = feetDbg.right;
    },

    debugTip(out: THREE.Vector3): void {
      weapon.updateWorldMatrix(true, false);
      out.copy(weaponBuild.tip).applyMatrix4(weapon.matrixWorld);
      root.worldToLocal(out);
    },

    getAnchor(kind: 'head' | 'chest' | 'root', out: THREE.Vector3): THREE.Vector3 {
      if (kind === 'head') {
        head.updateWorldMatrix(true, false);
        head.getWorldPosition(headAnchor);
        return out.copy(headAnchor).setY(headAnchor.y + 0.09);
      }
      if (kind === 'chest') {
        chest.updateWorldMatrix(true, false);
        return chest.getWorldPosition(out);
      }
      return root.getWorldPosition(out);
    },

    setOpacity(v: number): void {
      const clamped = Math.max(0, Math.min(1, v));
      opacity = clamped;
      if (clamped >= 0.999) {
        if (ownMaterials) {
          for (const mesh of meshes) {
            const own = mesh.material as THREE.Material;
            for (const [orig, cloned] of ownMaterials) {
              if (cloned === own) {
                mesh.material = orig;
                break;
              }
            }
          }
          for (const m of ownedMaterials) m.dispose();
          ownedMaterials.length = 0;
          ownMaterials = null;
        }
        shadowMat.opacity = 0.32;
        return;
      }
      if (!ownMaterials) {
        ownMaterials = new Map();
        for (const mesh of meshes) {
          const orig = mesh.material as THREE.Material;
          let own = ownMaterials.get(orig);
          if (!own) {
            own = orig.clone();
            (own as THREE.MeshStandardMaterial).transparent = true;
            own.depthWrite = false;
            ownMaterials.set(orig, own);
            ownedMaterials.push(own);
          }
          mesh.material = own;
        }
      }
      for (const m of ownedMaterials) {
        (m as THREE.MeshStandardMaterial).opacity = clamped;
      }
      shadowMat.opacity = 0.32 * clamped;
    },

    setDead(value: boolean): void {
      dead = value;
      animator.setDead(value);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      root.removeFromParent();
      for (const mesh of meshes) {
        mesh.geometry.dispose();
      }
      skeleton.dispose();
      shadowGeo.dispose();
      shadowMat.dispose();
      if (trail) {
        trail.geometry.dispose();
        (trail.material as THREE.Material).dispose();
      }
      for (const m of ownedMaterials) m.dispose();
      ownedMaterials.length = 0;
      ownMaterials = null;
    },
  };
}
