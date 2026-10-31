/**
 * Animation Lab — baked KayKit animation retargeted onto the procedural fighter rig.
 *
 * Purpose: prove out whether high-quality baked clips (CC0 KayKit Knight) look
 * materially better than the current procedural CharacterAnimator on our rig,
 * and let the Lead inspect / iterate on retarget parameters before integration.
 *
 * URL params (all optional):
 *   ?clip=Run            initial clip key (see dropdown)
 *   ?phase=0.35          freeze at this normalized phase
 *   ?freeze=1            start frozen
 *   ?side=0              start without the procedural side-by-side row
 *   ?view=wide|front|side|close|hero
 *   ?hipY=1.3&hipXZ=0.6&deathY=2.8&speed=1
 *
 * Programmatic API for deterministic screenshots (`window.__lab`):
 *   setClip(name), setPhase(p), setFreeze(bool), setSide(bool),
 *   setProfile({hipY, hipXZ, deathHipY}), setSpeed(v), view(name), info()
 *
 * Nothing here is wired into the game; the intact production path is untouched.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createCharacterRig, type CharacterRigDebug } from '../characters/rig';
import { CharacterAnimator } from '../characters/animation';
import { createAppearance } from '../characters/appearance';
import { ARMORS, HELMETS, SHIELDS, TEAM_PALETTE, WEAPONS } from '../core/config';
import type { AttackDir, GuardDir, Loadout, RigAction, ShieldDef } from '../core/types';
import { SKELETON, type RigPose } from '../characters/skeleton';
import {
  BakedCharacterAnimator,
  DEFAULT_RETARGET_PROFILE,
  loadBakedAnimatorLibrary,
  type BakedClipLibrary,
  type RetargetProfile,
} from '../characters/bakedAnimator';

/* ------------------------------------------------------------------ */
/* Lab-local types                                                     */
/* ------------------------------------------------------------------ */

type AnimSet = '1H' | '2H';
const ATTACK_CLIP: Record<AttackDir, Record<AnimSet, string>> = {
  right: { '1H': 'AttackR', '2H': 'AttackR2H' },
  left: { '1H': 'AttackL', '2H': 'AttackL2H' },
  overhead: { '1H': 'AttackO', '2H': 'AttackO2H' },
  thrust: { '1H': 'AttackT', '2H': 'AttackT2H' },
};
/** Lab retarget profile = production profile + playback time scale. */
interface LabProfile extends RetargetProfile {
  speed: number;
}
const DEFAULT_PROFILE: LabProfile = { ...DEFAULT_RETARGET_PROFILE, speed: 1 };

/* ------------------------------------------------------------------ */
/* Procedural comparison animator (existing CharacterAnimator)          */
/* ------------------------------------------------------------------ */

/** Intent implied by a lab clip key, so the procedural row plays the same action. */
interface Intent {
  motion?: { speed: number; strafe: number; forward: number };
  guard?: GuardDir | null;
  attack?: AttackDir;
  action?: RigAction;
  die?: boolean;
  /** Total duration used when simulating a frozen frame. */
  dur: number;
}

function intentForClip(clip: string): Intent {
  switch (clip) {
    case 'Idle': return { motion: { speed: 0, strafe: 0, forward: 0 }, dur: 1.07 };
    case 'Idle2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, dur: 1.07 };
    case 'Walk': return { motion: { speed: 1.7, strafe: 0, forward: 1.7 }, dur: 1.07 };
    case 'WalkB': return { motion: { speed: 1.5, strafe: 0.7, forward: 1.4 }, dur: 1.07 };
    case 'Run': return { motion: { speed: 4.6, strafe: 0, forward: 4.6 }, dur: 0.8 };
    case 'RunB': return { motion: { speed: 4.4, strafe: 0, forward: 4.4 }, dur: 1.07 };
    case 'StrafeL': return { motion: { speed: 2.4, strafe: -2.4, forward: 0 }, dur: 0.8 };
    case 'StrafeR': return { motion: { speed: 2.4, strafe: 2.4, forward: 0 }, dur: 0.8 };
    case 'Back': return { motion: { speed: 1.4, strafe: 0, forward: -1.4 }, dur: 1.07 };
    case 'Guard': return { motion: { speed: 0, strafe: 0, forward: 0 }, guard: 'right', dur: 1.07 };
    case 'Guard2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, guard: 'right', dur: 1.07 };
    case 'GuardHit': return { motion: { speed: 0, strafe: 0, forward: 0 }, guard: 'right', action: 'bash', dur: 0.7 };
    case 'AttackR': case 'AttackR2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, attack: 'right', dur: 0.9 };
    case 'AttackL': case 'AttackL2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, attack: 'left', dur: 0.9 };
    case 'AttackO': case 'AttackO2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, attack: 'overhead', dur: 0.9 };
    case 'AttackT': case 'AttackT2H': return { motion: { speed: 0, strafe: 0, forward: 0 }, attack: 'thrust', dur: 0.9 };
    case 'Hit': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'hit', dur: 0.5 };
    case 'Stagger': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'stagger', dur: 1.0 };
    case 'Kick': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'kick', dur: 0.75 };
    case 'DodgeL': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'dodge', dur: 0.5 };
    case 'DodgeR': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'dodge', dur: 0.5 };
    case 'DodgeB': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'dodge', dur: 0.5 };
    case 'DodgeF': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'dodge', dur: 0.5 };
    case 'DeathA': case 'DeathB': return { dur: 2.2, die: true };
    case 'Cheer': return { motion: { speed: 0, strafe: 0, forward: 0 }, action: 'victory', dur: 1.8 };
    default: return { motion: { speed: 0, strafe: 0, forward: 0 }, dur: 1 };
  }
}

/* ------------------------------------------------------------------ */
/* Scene                                                               */
/* ------------------------------------------------------------------ */

const rootEl = document.getElementById('lab-root') as HTMLElement;
const errorEl = document.getElementById('lab-error') as HTMLElement;
const statusEl = document.getElementById('status') as HTMLElement;
const hudEl = document.getElementById('hud') as HTMLElement;
const clipSelect = document.getElementById('clip') as HTMLSelectElement;

function showError(msg: string): void {
  errorEl.style.display = 'block';
  errorEl.textContent = msg;
}
window.addEventListener('error', (e) => showError(String(e.message)));
window.addEventListener('unhandledrejection', (e) => showError(String(e.reason)));

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
renderer.outputColorSpace = THREE.SRGBColorSpace;
rootEl.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.05, 120);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.target.set(0, 0.95, 0);
controls.minDistance = 1.6;
controls.maxDistance = 14;
controls.maxPolarAngle = Math.PI * 0.52;

const VIEWS: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
  wide: { pos: [-0.42, 2.05, 8.3], target: [-0.42, 1.0, 0] },
  front: { pos: [0, 1.45, 5.6], target: [0, 1.0, 0] },
  side: { pos: [5.8, 1.55, 0.7], target: [0, 1.0, 0] },
  close: { pos: [1.5, 1.5, 3.1], target: [0.15, 1.02, 0.2] },
  hero: { pos: [3.1, 1.8, 4.6], target: [0, 1.0, 0] },
  compare: { pos: [-1.64, 1.55, 5.55], target: [-1.64, 0.95, 0] },
  game: { pos: [-1.55, 1.72, 3.5], target: [-2.2, 1.05, 0.0] },
};
function setView(name: string): void {
  const v = VIEWS[name] ?? VIEWS.wide;
  camera.position.set(...v.pos);
  controls.target.set(...v.target);
  controls.update();
}

/* sky gradient */
{
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    const g = ctx.createLinearGradient(0, 0, 0, 256);
    g.addColorStop(0, '#8fa3ab');
    g.addColorStop(0.45, '#b9c2c1');
    g.addColorStop(0.62, '#ddd5c0');
    g.addColorStop(0.68, '#cfc5ab');
    g.addColorStop(1, '#a08c6c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 4, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    scene.background = tex;
  }
}

/* lights */
scene.add(new THREE.HemisphereLight(0xd6e2e8, 0x6d5a40, 1.35));
const key = new THREE.DirectionalLight(0xfff2da, 2.7);
key.position.set(5.5, 9.5, 6.5);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.camera.near = 1;
key.shadow.camera.far = 32;
key.shadow.camera.left = -9;
key.shadow.camera.right = 9;
key.shadow.camera.top = 8;
key.shadow.camera.bottom = -4;
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key);
scene.add(key.target);
const rim = new THREE.DirectionalLight(0xffd3a2, 1.5);
rim.position.set(-5, 5.5, -7);
scene.add(rim);
const fill = new THREE.DirectionalLight(0x9db6c9, 0.5);
fill.position.set(-7, 3, 5);
scene.add(fill);

/* sand ground */
{
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#b9a47f';
    ctx.fillRect(0, 0, 256, 256);
    let seed = 12345;
    const rnd = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < 2600; i++) {
      const x = rnd() * 256;
      const y = rnd() * 256;
      const r = 0.4 + rnd() * 2.6;
      const v = rnd() > 0.5 ? 255 : 60;
      ctx.fillStyle = `rgba(${v},${v * 0.94},${v * 0.8},${0.025 + rnd() * 0.09})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(10, 10);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(46, 64),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xcdbb98, roughness: 0.97, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    scene.add(ground);
  }
}

/** Floating label sprite (so screenshots are unambiguous). */
function makeLabel(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 96;
  const ctx = c.getContext('2d');
  if (ctx) {
    ctx.font = '600 46px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 12;
    ctx.fillText(text, 256, 50);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(1.24, 0.2325, 1);
  return sprite;
}

/* ------------------------------------------------------------------ */
/* Fighter roster                                                      */
/* ------------------------------------------------------------------ */

interface RosterEntry { weapon: string; shield: string | null; armor: string; helmet: string; team: number; seed: number }

const ROSTER: RosterEntry[] = [
  { weapon: 'arming_sword', shield: 'heater', armor: 'hauberk', helmet: 'barbute', team: 0, seed: 1013 },
  { weapon: 'greatsword', shield: null, armor: 'plate', helmet: 'great', team: 1, seed: 2027 },
  { weapon: 'war_axe', shield: 'round', armor: 'gambeson', helmet: 'nasal', team: 2, seed: 3041 },
  { weapon: 'quarterstaff', shield: null, armor: 'jerkin', helmet: 'none', team: 3, seed: 4057 },
];

function buildLoadout(entry: RosterEntry): Loadout {
  const team = TEAM_PALETTE[entry.team % TEAM_PALETTE.length];
  const color1 = team.color;
  const color2 = team.secondary;
  const shieldBase: ShieldDef | undefined = entry.shield ? SHIELDS[entry.shield] : undefined;
  const shield = shieldBase ? { ...shieldBase, color: color1, color2 } : null;
  return {
    weapon: { ...WEAPONS[entry.weapon] },
    shield,
    armor: { ...ARMORS[entry.armor] },
    helmet: { ...HELMETS[entry.helmet] },
    color1,
    color2,
    title: 'Animation Lab',
  };
}

interface LabFighter {
  rig: CharacterRigDebug;
  loadout: Loadout;
  animSet: AnimSet;
  mode: 'baked' | 'proc';
  bones: Map<string, THREE.Bone>;
  baked: BakedCharacterAnimator | null;
  proc: CharacterAnimator | null;
  slot: number;
  seed: number;
}

const fighters: LabFighter[] = [];
let animData: BakedClipLibrary | null = null;
let state = {
  clip: 'Idle',
  freeze: false,
  phase: 0.35,
  side: true,
  profile: { ...DEFAULT_PROFILE },
};
let procSeed = 1;

const scratchSoleL = new THREE.Vector3();
const scratchSoleR = new THREE.Vector3();
const SOLE_LOCAL = new THREE.Vector3(0, -0.089, 0.055);

/**
 * Extra grip rotation applied to the rig's weapon joint, because the rig's grip
 * was authored for the procedural ready pose. Positive X tips the blade
 * forward-down at idle. Values are per weapon kind (degrees in X).
 */
const WEAPON_GRIP_X: Record<string, number> = {
  sword: 0.48,
  saber: 0.42,
  greatsword: 0.55,
  axe: 0.35,
  mace: 0.35,
  spear: 0.0,
  staff: 0.0,
};
const gripQuat = new THREE.Quaternion();
const gripEuler = new THREE.Euler();
const scratchRootWorld = new THREE.Vector3();
const scratchChain = new THREE.Quaternion();
const scratchTilt = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchQ1 = new THREE.Quaternion();
const scratchQ2 = new THREE.Quaternion();

function collectBones(rig: CharacterRigDebug): Map<string, THREE.Bone> {
  const map = new Map<string, THREE.Bone>();
  rig.root.traverse((o) => {
    if ((o as THREE.Bone).isBone && o.name) map.set(o.name, o as THREE.Bone);
  });
  return map;
}

function spawnFighter(slot: number, entry: RosterEntry, mode: 'baked' | 'proc'): LabFighter {
  const loadout = buildLoadout(entry);
  const appearance = createAppearance(entry.seed, loadout, loadout.color1, loadout.color2);
  const rig = createCharacterRig({ loadout, appearance, quality: 'high' });
  rig.root.name = `lab-fighter-${slot}`;
  rig.root.position.set(0, 0, 0);
  scene.add(rig.root);
  const f: LabFighter = {
    rig,
    loadout,
    animSet: loadout.weapon.twoHanded ? '2H' : '1H',
    mode,
    bones: collectBones(rig),
    baked: null,
    proc: null,
    slot,
    seed: entry.seed + slot * 131,
  };
  const weaponBone = f.bones.get('weapon');
  if (weaponBone) weaponBone.userData.baseQuat = weaponBone.quaternion.clone();
  fighters.push(f);
  return f;
}

/* ------------------------------------------------------------------ */
/* Pose application (same maths as rig.ts applyPose + shield + feet)    */
/* ------------------------------------------------------------------ */

const shieldBase = new THREE.Vector3(0.02, -0.28, 0.1);

function applyPose(f: LabFighter, pose: RigPose): void {
  const bones = f.bones;
  const body = bones.get('body');
  if (body) {
    body.rotation.set(pose.bodyRot.x, pose.bodyRot.y, pose.bodyRot.z);
    body.position.set(pose.bodyPos.x, pose.bodyPos.y, pose.bodyPos.z);
  }
  const hips = bones.get('hips');
  if (hips) {
    hips.position.set(
      SKELETON.hips[0] + pose.hipsOffset.x,
      SKELETON.hips[1] + pose.hipsOffset.y,
      SKELETON.hips[2] + pose.hipsOffset.z,
    );
  }
  for (const name of [
    'spine', 'chest', 'neck', 'head',
    'shoulderR', 'elbowR', 'handR',
    'shoulderL', 'elbowL', 'handL',
    'thighR', 'kneeR', 'footR',
    'thighL', 'kneeL', 'footL',
    'cape',
  ]) {
    const b = bones.get(name);
    if (!b) continue;
    const r = pose.rot[name as keyof typeof pose.rot];
    b.rotation.set(r.x, r.y, r.z);
  }
  // Shield: same formula as rig.updateShieldTransform (keeps the face aligned
  // to the torso instead of twisting with the forearm).
  const shield = bones.get('shield');
  if (shield) {
    const r = pose.rot;
    scratchQ1.setFromEuler(scratchEuler.set(r.spine.x, r.spine.y, r.spine.z, 'XYZ'));
    scratchQ2.setFromEuler(scratchEuler.set(r.chest.x, r.chest.y, r.chest.z, 'XYZ'));
    scratchChain.copy(scratchQ1).multiply(scratchQ2);
    scratchQ1.setFromEuler(scratchEuler.set(r.shoulderL.x, r.shoulderL.y, r.shoulderL.z, 'XYZ'));
    scratchChain.multiply(scratchQ1);
    scratchQ1.setFromEuler(scratchEuler.set(r.elbowL.x, r.elbowL.y, r.elbowL.z, 'XYZ'));
    scratchChain.multiply(scratchQ1).invert();
    scratchTilt.setFromEuler(scratchEuler.set(pose.shieldRot.x, pose.shieldRot.y, pose.shieldRot.z, 'XYZ'));
    shield.quaternion.copy(scratchChain).multiply(scratchTilt);
    shield.position.set(
      shieldBase.x + pose.shieldPos.x,
      shieldBase.y + pose.shieldPos.y,
      shieldBase.z + pose.shieldPos.z,
    );
  }
  const weapon = bones.get('weapon');
  if (weapon) {
    const gx = WEAPON_GRIP_X[f.loadout.weapon.kind] ?? 0;
    gripQuat.setFromEuler(gripEuler.set(gx, 0, 0, 'XYZ'));
    weapon.quaternion.multiplyQuaternions(gripQuat, weapon.userData.baseQuat as THREE.Quaternion);
  }
  f.rig.root.updateMatrixWorld(true);
}

/** Pin the lower sole to the sand — same grounding trick as the live rig. */
function pinFeet(f: LabFighter, pose: RigPose): void {
  const footL = f.bones.get('footL');
  const footR = f.bones.get('footR');
  if (!footL || !footR) return;
  f.rig.root.getWorldPosition(scratchRootWorld);
  footL.localToWorld(scratchSoleL.copy(SOLE_LOCAL));
  footR.localToWorld(scratchSoleR.copy(SOLE_LOCAL));
  const minSole = Math.min(scratchSoleL.y, scratchSoleR.y) - scratchRootWorld.y;
  const delta = 0.004 - minSole;
  if (Math.abs(delta) > 0.0008) {
    pose.hipsOffset.y += delta / f.rig.root.scale.x;
    applyPose(f, pose);
  }
}

/** Apply a CharacterAnimator pose + shield (procedural comparison row). */
function applyProc(f: LabFighter, dt: number): void {
  const a = f.proc;
  if (!a) return;
  a.update(dt, f.rig.root.rotation.y, f.rig.root.position);
  applyPose(f, a.pose);
  if (!a.isDead) pinFeet(f, a.pose);
}

/* ------------------------------------------------------------------ */
/* Clip → per-fighter state                                            */
/* ------------------------------------------------------------------ */

function ensureBaked(f: LabFighter): BakedCharacterAnimator {
  if (!f.baked) {
    f.baked = new BakedCharacterAnimator(animData as BakedClipLibrary, {
      loadout: f.loadout,
      seed: f.seed,
      profile: state.profile,
    });
  }
  return f.baked;
}

/** Drive the production animator with the intent implied by the selected clip. */
function applyLiveIntent(a: BakedCharacterAnimator, clip: string): void {
  const intent = intentForClip(clip);
  a.debugStop();
  a.setDead(false);
  const motion = intent.motion ?? { speed: 0, strafe: 0, forward: 0 };
  a.setMotion(motion.speed, motion.strafe, motion.forward);
  a.setGuard(intent.guard ?? null);
  if (intent.attack) {
    a.playAttack(intent.attack, 1);
  } else if (intent.action) {
    const dir = clip === 'DodgeL' ? new THREE.Vector3(-1, 0, 0)
      : clip === 'DodgeR' ? new THREE.Vector3(1, 0, 0)
        : clip === 'DodgeB' ? new THREE.Vector3(0, 0, -1)
          : new THREE.Vector3(0, 0, 1);
    a.playAction(intent.action, { dir, variant: 0 });
  } else if (intent.die) {
    a.setDead(true);
  }
}

function ensureProc(f: LabFighter): CharacterAnimator {
  if (!f.proc) {
    f.proc = new CharacterAnimator({ loadout: f.loadout, seed: f.seed + procSeed * 17 });
  }
  return f.proc;
}

function resetFighter(f: LabFighter, clip: string): void {
  if (f.mode === 'baked') {
    const a = ensureBaked(f);
    if (state.freeze) {
      a.debugFreezeClip(clip, state.phase);
      applyPose(f, a.pose);
      const deadClip = clip === 'DeathA' || clip === 'DeathB';
      if (!deadClip) pinFeet(f, a.pose);
    } else {
      applyLiveIntent(a, clip);
      a.update(0, f.rig.root.rotation.y, f.rig.root.position);
      applyPose(f, a.pose);
      if (!a.isDead) pinFeet(f, a.pose);
    }
  } else {
    // Rebuild the procedural animator at a known state, then fast-forward for
    // deterministic frozen comparisons.
    f.proc = new CharacterAnimator({ loadout: f.loadout, seed: f.seed + procSeed * 17 });
    const intent = intentForClip(clip);
    const motion = intent.motion ?? { speed: 0, strafe: 0, forward: 0 };
    const proc = f.proc;
    proc.setMotion(motion.speed, motion.strafe, motion.forward);
    if (intent.guard) proc.setGuard(intent.guard);
    if (intent.die) {
      proc.playAction('die');
    } else if (intent.attack) {
      proc.playAttack(intent.attack, 1, f.loadout.weapon);
    } else if (intent.action) {
      const dir = clip === 'DodgeL' ? new THREE.Vector3(-1, 0, 0)
        : clip === 'DodgeR' ? new THREE.Vector3(1, 0, 0)
          : clip === 'DodgeB' ? new THREE.Vector3(0, 0, -1)
            : new THREE.Vector3(0, 0, 1);
      proc.playAction(intent.action, { dir, variant: f.slot });
    }
    if (state.freeze) {
      const target = intent.dur * state.phase;
      const step = 1 / 120;
      const steps = Math.max(0, Math.round(target / step));
      for (let s = 0; s < steps; s++) {
        proc.setMotion(motion.speed, motion.strafe, motion.forward);
        proc.update(step, f.rig.root.rotation.y, f.rig.root.position);
      }
      applyPose(f, proc.pose);
      if (!proc.isDead) pinFeet(f, proc.pose);
    } else {
      applyPose(f, proc.pose);
    }
  }
}

function layout(): void {
  const xs = [-2.28, -0.76, 0.76, 2.28];
  for (const f of fighters) {
    f.rig.root.position.set(xs[f.slot], 0, 0);
    f.rig.root.rotation.y = 0;
  }
  bakedLabel.visible = true;
  bakedLabel.position.set(-1.52, 2.5, 0);
  procLabel.visible = state.side;
  procLabel.position.set(1.52, 2.5, 0);
}

const bakedLabel = makeLabel('BAKED  ·  RETARGET', '#e7c777');
const procLabel = makeLabel('CURRENT  ·  PROCEDURAL', '#8fb0d3');
scene.add(bakedLabel, procLabel);

function rebuildFighters(): void {
  for (const f of fighters) {
    f.rig.dispose();
  }
  fighters.length = 0;
  const modes: Array<'baked' | 'proc'> = state.side
    ? ['baked', 'baked', 'proc', 'proc']
    : ['baked', 'baked', 'baked', 'baked'];
  for (let i = 0; i < 4; i++) {
    // In side-by-side mode the procedural pair mirrors the baked pair exactly,
    // so a comparison is loadout-for-loadout fair.
    const entry = state.side ? ROSTER[i % 2] : ROSTER[i % ROSTER.length];
    spawnFighter(i, entry, modes[i]);
  }
  layout();
  for (const f of fighters) resetFighter(f, state.clip);
}

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */

const LOCO_BUTTONS: Array<[string, string]> = [
  ['idle', 'Idle'], ['walk', 'Walk'], ['run', 'Run'],
  ['strafe-l', 'Strafe L'], ['strafe-r', 'Strafe R'], ['back', 'Back'], ['guard', 'Guard'],
];
const ATTACK_BUTTONS: Array<[string, string]> = [
  ['right', 'Slash R'], ['left', 'Slash L'], ['overhead', 'Overhead'], ['thrust', 'Thrust'],
];
const ACTION_BUTTONS: Array<[string, string]> = [
  ['hit', 'Hit'], ['stagger', 'Stagger'], ['kick', 'Kick'],
  ['dodge-l', 'Dodge L'], ['dodge-r', 'Dodge R'], ['dodge-b', 'Dodge B'],
  ['death', 'Death'], ['cheer', 'Cheer'],
];
const CAMERA_BUTTONS: Array<[string, string]> = [
  ['wide', 'Wide'], ['front', 'Front'], ['side', 'Side'], ['close', 'Close'], ['hero', 'Hero'],
  ['compare', 'Compare'], ['game', 'Game cam'],
];

function setClip(clip: string, reset = true): void {
  state.clip = clip;
  clipSelect.value = clip;
  markActiveButtons();
  liveClipTimer = 0;
  if (reset) {
    for (const f of fighters) resetFighter(f, clip);
  }
  updateHud();
}

function markActiveButtons(): void {
  const map: Record<string, string> = {
    Idle: 'idle', Walk: 'walk', Run: 'run', 'Strafe L': 'strafe-l', 'Strafe R': 'strafe-r',
    Back: 'back', Guard: 'guard', Guard2H: 'guard',
    AttackR: 'right', AttackR2H: 'right', AttackL: 'left', AttackL2H: 'left',
    AttackO: 'overhead', AttackO2H: 'overhead', AttackT: 'thrust', AttackT2H: 'thrust',
    Hit: 'hit', Stagger: 'stagger', Kick: 'kick', DeathA: 'death', DeathB: 'death', Cheer: 'cheer',
    DodgeL: 'dodge-l', DodgeR: 'dodge-r', DodgeB: 'dodge-b',
  };
  const active = map[state.clip];
  document.querySelectorAll('[data-buttons] button').forEach((b) => {
    const key = (b as HTMLElement).dataset.key;
    b.classList.toggle('active', key === active);
  });
}

function buildButtons(target: string, items: Array<[string, string]>, onClick: (key: string) => void): void {
  const host = document.querySelector(`[data-buttons="${target}"]`) as HTMLElement;
  for (const [key, label] of items) {
    const b = document.createElement('button');
    b.textContent = label;
    b.dataset.key = key;
    b.onclick = () => onClick(key);
    host.appendChild(b);
  }
}

buildButtons('loco', LOCO_BUTTONS, (key) => {
  if (key === 'idle') setClip('Idle');
  else if (key === 'walk') setClip('Walk');
  else if (key === 'run') setClip('Run');
  else if (key === 'strafe-l') setClip('StrafeL');
  else if (key === 'strafe-r') setClip('StrafeR');
  else if (key === 'back') setClip('Back');
  else if (key === 'guard') setClip(fighters[0]?.animSet === '2H' ? 'Guard2H' : 'Guard');
});
buildButtons('attacks', ATTACK_BUTTONS, (key) => {
  const dir = key as AttackDir;
  const twoH = fighters[0]?.animSet === '2H';
  const set = ATTACK_CLIP[dir];
  setClip(twoH ? set['2H'] : set['1H']);
});
buildButtons('actions', ACTION_BUTTONS, (key) => {
  if (key === 'death') setClip('DeathA');
  else if (key === 'cheer') setClip('Cheer');
  else if (key === 'hit') setClip('Hit');
  else if (key === 'stagger') setClip('Stagger');
  else if (key === 'kick') setClip('Kick');
  else if (key === 'dodge-l') setClip('DodgeL');
  else if (key === 'dodge-r') setClip('DodgeR');
  else if (key === 'dodge-b') setClip('DodgeB');
});
buildButtons('camera', CAMERA_BUTTONS, (key) => setView(key));

// clip dropdown
const CLIP_LABELS: Record<string, string> = {
  Idle: 'Idle', Idle2H: 'Idle · two-handed', Walk: 'Walk (A)', WalkB: 'Walk (B)', Run: 'Run (A)',
  RunB: 'Run (B)', StrafeL: 'Strafe → left', StrafeR: 'Strafe → right', Back: 'Walk backwards',
  Guard: 'Block / guard (shield)', Guard2H: 'Block (two-handed)', GuardHit: 'Block hit',
  AttackR: 'Attack: slash right (1H)', AttackL: 'Attack: slash left (1H)',
  AttackO: 'Attack: overhead chop (1H)', AttackT: 'Attack: thrust (1H)',
  AttackR2H: 'Attack: slash right (2H)', AttackL2H: 'Attack: slash left (2H)',
  AttackO2H: 'Attack: overhead (2H)', AttackT2H: 'Attack: thrust (2H)',
  Hit: 'Hit reaction', Stagger: 'Stagger (heavy hit)', Kick: 'Kick',
  DodgeL: 'Dodge left', DodgeR: 'Dodge right', DodgeB: 'Dodge back', DodgeF: 'Dodge forward',
  DeathA: 'Death A (fall back)', DeathB: 'Death B', Cheer: 'Cheer / victory', UnarmedIdle: 'Unarmed idle',
};

function fillClipSelect(): void {
  clipSelect.innerHTML = '';
  if (!animData) return;
  for (const name of Object.keys(animData.clips)) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = CLIP_LABELS[name] ?? name;
    clipSelect.appendChild(opt);
  }
}
clipSelect.onchange = () => setClip(clipSelect.value);

const phaseInput = document.getElementById('phase') as HTMLInputElement;
const phaseOut = document.getElementById('phaseOut') as HTMLOutputElement;
const freezeInput = document.getElementById('freeze') as HTMLInputElement;
const sideInput = document.getElementById('side') as HTMLInputElement;
const loopInput = document.getElementById('loop') as HTMLInputElement;

function syncPhaseUi(): void {
  phaseInput.value = String(Math.round(state.phase * 1000));
  phaseOut.textContent = state.phase.toFixed(2);
}
phaseInput.oninput = () => {
  state.phase = Number(phaseInput.value) / 1000;
  phaseOut.textContent = state.phase.toFixed(2);
  if (state.freeze) setClip(state.clip, true);
};
freezeInput.onchange = () => {
  state.freeze = freezeInput.checked;
  for (const f of fighters) resetFighter(f, state.clip);
  updateHud();
};
sideInput.onchange = () => {
  state.side = sideInput.checked;
  rebuildFighters();
  updateHud();
};
void loopInput;

function bindSlider(id: string, key: keyof LabProfile, fmt: (v: number) => number): void {
  const input = document.getElementById(id) as HTMLInputElement;
  const out = document.getElementById(`${id}Out`) as HTMLOutputElement;
  const apply = (): void => {
    const v = Number(input.value) / 100;
    state.profile[key] = v;
    out.textContent = v.toFixed(2);
    for (const f of fighters) {
      if (f.baked) f.baked.profile = state.profile;
    }
    if (state.freeze) for (const f of fighters) resetFighter(f, state.clip);
  };
  input.oninput = apply;
  void fmt;
}
bindSlider('hipY', 'hipY', (v) => v);
bindSlider('hipXZ', 'hipXZ', (v) => v);
bindSlider('deathY', 'deathHipY', (v) => v);
bindSlider('speed', 'speed', (v) => v);
syncPhaseUi();

/* ------------------------------------------------------------------ */
/* HUD + render loop                                                   */
/* ------------------------------------------------------------------ */

let liveClipTimer = 0;
let fpsSmooth = 60;
let lastHud = 0;
function updateHud(): void {
  const baked = fighters.filter((f) => f.mode === 'baked' && f.baked);
  const times = baked
    .map((f) => (f.baked && f.baked.debugClipName === state.clip ? f.baked.debugTime : 0))
    .sort((a, b) => b - a);
  const clip = animData?.clips[state.clip];
  const t = times[0] ?? 0;
  const mode = state.freeze ? 'FROZEN CLIP' : 'LIVE';
  const timeline = state.freeze || t > 0
    ? `clip ${t.toFixed(2)}s / ${clip ? clip.dur.toFixed(2) : '–'}s (${(clip ? t / clip.dur : 0).toFixed(2)})`
    : 'state machine · real API';
  hudEl.innerHTML = [
    `<b>${state.clip}</b> <span class="k">${mode}</span>`,
    `<span class="k">anim</span> ${timeline}`,
    `<span class="k">fps</span> ${fpsSmooth.toFixed(0)}  <span class="k">rigs</span> ${fighters.length} (${baked.length} baked)`,
    `<span class="k">profile</span> Y ${state.profile.hipY.toFixed(2)} · XZ ${state.profile.hipXZ.toFixed(2)} · death ${state.profile.deathHipY.toFixed(2)}`,
  ].join('<br>');
}

const clock = new THREE.Clock();
function frame(): void {
  requestAnimationFrame(frame);
  const raw = clock.getDelta();
  const dt = Math.min(0.05, raw);
  if (dt > 0) fpsSmooth = fpsSmooth * 0.92 + (1 / Math.max(0.004, raw)) * 0.08;

  const selectedClip = animData?.clips[state.clip];
  if (!state.freeze && loopInput.checked && selectedClip && !selectedClip.loop) {
    liveClipTimer += dt;
    if (liveClipTimer >= selectedClip.dur) {
      liveClipTimer = 0;
      for (const f of fighters) resetFighter(f, state.clip);
    }
  }

  for (const f of fighters) {
    if (f.mode === 'baked') {
      const a = f.baked;
      if (!a) continue;
      a.update(state.freeze ? 0 : dt * state.profile.speed, f.rig.root.rotation.y, f.rig.root.position);
      applyPose(f, a.pose);
      if (!a.isDead) pinFeet(f, a.pose);
    } else {
      if (f.proc) {
        const intent = intentForClip(state.clip);
        if (!state.freeze) {
          const motion = intent.motion ?? { speed: 0, strafe: 0, forward: 0 };
          f.proc.setMotion(motion.speed, motion.strafe, motion.forward);
          f.proc.setGuard(intent.guard ?? null);
        }
        applyProc(f, state.freeze ? 0 : dt);
      }
    }
  }

  controls.update();
  renderer.render(scene, camera);

  const now = performance.now();
  if (now - lastHud > 120) {
    lastHud = now;
    updateHud();
  }
}
frame();

addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

const params = new URLSearchParams(location.search);
function numParam(key: string, fallback: number): number {
  const v = params.get(key);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
if (params.has('phase')) state.phase = Math.min(1, Math.max(0, numParam('phase', 0.35)));
if (params.has('freeze')) state.freeze = params.get('freeze') !== '0';
if (params.has('side')) state.side = params.get('side') !== '0';
state.profile.hipY = numParam('hipY', state.profile.hipY);
state.profile.hipXZ = numParam('hipXZ', state.profile.hipXZ);
state.profile.deathHipY = numParam('deathY', state.profile.deathHipY);
state.profile.speed = numParam('speed', state.profile.speed);
syncPhaseUi();
freezeInput.checked = state.freeze;
sideInput.checked = state.side;
(document.getElementById('hipY') as HTMLInputElement).value = String(Math.round(state.profile.hipY * 100));
(document.getElementById('hipXZ') as HTMLInputElement).value = String(Math.round(state.profile.hipXZ * 100));
(document.getElementById('deathY') as HTMLInputElement).value = String(Math.round(state.profile.deathHipY * 100));
(document.getElementById('speed') as HTMLInputElement).value = String(Math.round(state.profile.speed * 100));

loadBakedAnimatorLibrary('/assets/knight-anim.json')
  .then((data) => {
    animData = data;
    fillClipSelect();
    const wanted = params.get('clip');
    state.clip = wanted && data.clips[wanted] ? wanted : 'Idle';
    rebuildFighters();
    setClip(state.clip, true);
    setView(params.get('view') ?? 'wide');
    statusEl.textContent = `${Object.keys(data.clips).length} clips · ${data.source} · ${data.fps} fps bake`;
    updateHud();
    (window as unknown as { __ready: boolean }).__ready = true;
  })
  .catch((err) => {
    statusEl.textContent = 'failed to load baked clips';
    showError(String(err));
  });

/* Programmatic API for screenshots / the Lead. */
(window as unknown as { __lab: unknown }).__lab = {
  setClip: (name: string): void => setClip(name),
  setPhase: (p: number): void => {
    state.phase = Math.min(1, Math.max(0, p));
    syncPhaseUi();
    if (state.freeze) setClip(state.clip, true);
  },
  setFreeze: (on: boolean): void => {
    state.freeze = on;
    freezeInput.checked = on;
    for (const f of fighters) resetFighter(f, state.clip);
    updateHud();
  },
  setSide: (on: boolean): void => {
    state.side = on;
    sideInput.checked = on;
    rebuildFighters();
    updateHud();
  },
  setProfile: (p: Partial<LabProfile>): void => {
    state.profile = { ...state.profile, ...p };
    for (const f of fighters) if (f.baked) f.baked.profile = state.profile;
    if (state.freeze) for (const f of fighters) resetFighter(f, state.clip);
    updateHud();
  },
  setSpeed: (v: number): void => {
    state.profile.speed = v;
    for (const f of fighters) if (f.baked) f.baked.profile = state.profile;
  },
  view: (name: string): void => setView(name),
  focus: (slot: number, solo = true): void => {
    const f = fighters[slot];
    if (!f) return;
    for (const other of fighters) other.rig.root.visible = !solo || other.rig.root === f.rig.root;
    const x = f.rig.root.position.x;
    camera.position.set(x + 2.3, 1.62, 4.15);
    controls.target.set(x, 0.9, 0.05);
    controls.update();
    if (solo) {
      bakedLabel.visible = f.mode === 'baked';
      bakedLabel.position.set(x, 2.45, 0.0);
      procLabel.visible = f.mode === 'proc';
      procLabel.position.set(x, 2.45, 0.0);
    }
  },
  setCamera: (px: number, py: number, pz: number, tx: number, ty: number, tz: number): void => {
    camera.position.set(px, py, pz);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
  compare: (): void => {
    state.side = true;
    sideInput.checked = true;
    rebuildFighters();
    for (const f of fighters) f.rig.root.visible = f.slot === 0 || f.slot === 2;
    bakedLabel.visible = true;
    bakedLabel.position.set(-2.28, 2.42, 0);
    procLabel.visible = true;
    procLabel.position.set(0.76, 2.42, 0);
    setView('compare');
  },
  showAll: (): void => {
    for (const other of fighters) other.rig.root.visible = true;
    layout();
  },
  info: (): unknown => ({
    clip: state.clip,
    freeze: state.freeze,
    phase: state.phase,
    side: state.side,
    profile: state.profile,
    fighters: fighters.map((f) => ({ slot: f.slot, mode: f.mode, animSet: f.animSet, clip: f.baked?.debugClipName ?? state.clip })),
  }),
};
