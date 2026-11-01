/**
 * Baked animation for the procedural fighter rig.
 *
 * This module retargets the CC0 KayKit Knight clip set (baked offline by
 * `src/dev/bake-knight-anim.mjs` into `public/assets/knight-anim.json`) onto our
 * rigid-part 7.3-head fighter skeleton, and drives the *existing* `RigPose`
 * surface (`src/characters/rig.ts` — every bone local rotation as Euler angles,
 * plus hipsOffset/bodyRot/shield trims). It is a drop-in replacement for
 * `CharacterAnimator` behind a flag:
 *
 *   const lib  = await loadBakedAnimatorLibrary('/assets/knight-anim.json');
 *   const anim = lib ? new BakedCharacterAnimator(lib, { loadout }) : new CharacterAnimator({ loadout, seed });
 *
 * Rig contract notes:
 *  - Our bones all have identity rest rotations (geometry is authored in bone
 *    local space), so a baked local quaternion can be written straight into
 *    `pose.rot[bone]` as Euler XYZ, and the pelvis rotation goes through
 *    `pose.bodyRot` (the rig's `body` joint) because RigPose has no hips channel.
 *  - `pose.hipsOffset` is solved so the pelvis world position matches the
 *    source hip translation (scaled), regardless of the body rotation.
 *  - Source `root` node animation (turn-in-place / dodge root motion) is ignored;
 *    the game moves the root. Toes are ignored.
 *
 * Retarget maths (per frame, computed offline):
 *   D_b(t) = W_b(t) * W_b(ref)^-1        world-space delta from the reference
 *   local  = D_parent^-1 * D_b            for our identity-rest hierarchy
 * where W is the source bone's world orientation (own rest hierarchy, root
 * ignored) and `ref` is the source `Idle` at t=0 (our bind stance). This keeps
 * our authored silhouette and applies the source's motion delta on top, so no
 * T-pose remap is needed.
 */
import * as THREE from 'three';
import { attackTiming, type AttackTiming } from '../core/config';
import type { AttackDir, GuardDir, Loadout, RigAction } from '../core/types';
import { clamp, damp, smoothstep } from '../core/utils';
import { SKELETON, createPose, type RigPose } from './skeleton';

/* ------------------------------------------------------------------ */
/* Baked library                                                       */
/* ------------------------------------------------------------------ */

/** Target bones baked by the offline retarget, in hierarchy-friendly order. */
export const BAKED_BONES = [
  'hips', 'spine', 'chest', 'head',
  'shoulderR', 'elbowR', 'handR',
  'shoulderL', 'elbowL', 'handL',
  'thighR', 'kneeR', 'footR',
  'thighL', 'kneeL', 'footL',
] as const;
export type BakedBone = (typeof BAKED_BONES)[number];

export interface BakedClip {
  /** Source clip name (for debugging / provenance). */
  src: string;
  /** Playback duration in seconds. */
  dur: number;
  loop: boolean;
  clamp: boolean;
  frames: number;
  /** Per-frame hip translation delta from the reference pose (raw source metres). */
  hips: number[];
  /** Per-frame local quaternions (x,y,z,w) per bone, flattened. */
  tracks: Record<string, number[]>;
}

export interface BakedClipLibrary {
  source: string;
  fps: number;
  reference: string;
  bones: string[];
  clips: Record<string, BakedClip>;
}

/** Validate/normalise the JSON produced by `bake-knight-anim.mjs`. */
export function parseBakedLibrary(raw: unknown): BakedClipLibrary {
  const data = raw as BakedClipLibrary;
  if (!data || typeof data !== 'object' || typeof data.fps !== 'number' || !data.clips) {
    throw new Error('baked animator: invalid clip library');
  }
  for (const [name, clip] of Object.entries(data.clips)) {
    if (!clip || typeof clip.dur !== 'number' || !Array.isArray(clip.hips)) {
      throw new Error(`baked animator: invalid clip "${name}"`);
    }
    for (const bone of BAKED_BONES) {
      if (!Array.isArray(clip.tracks[bone])) {
        throw new Error(`baked animator: clip "${name}" missing bone "${bone}"`);
      }
    }
  }
  return data;
}

/** Fetch + parse the baked clip JSON (call once, share the result). */
export async function loadBakedAnimatorLibrary(url: string): Promise<BakedClipLibrary> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`baked animator: HTTP ${res.status} for ${url}`);
  return parseBakedLibrary(await res.json());
}

/* ------------------------------------------------------------------ */
/* Animation mode selection (module-level; used by rig.ts + main.ts)   */
/* ------------------------------------------------------------------ */

export type AnimationMode = 'auto' | 'baked' | 'procedural';

let bakedLibrary: BakedClipLibrary | null = null;
let animationMode: AnimationMode = 'auto';

/** Register the clip library loaded once at boot (null = unavailable). */
export function setBakedAnimationLibrary(lib: BakedClipLibrary | null): void {
  bakedLibrary = lib;
}

export function getBakedAnimationLibrary(): BakedClipLibrary | null {
  return bakedLibrary;
}

/** `auto` = baked when a library is registered, else procedural. */
export function setAnimationMode(mode: AnimationMode): void {
  animationMode = mode;
}

export function getAnimationMode(): AnimationMode {
  return animationMode;
}

/** True when newly created fighters should use baked clips. */
export function isBakedAnimationActive(): boolean {
  return animationMode !== 'procedural' && bakedLibrary !== null;
}

/* ------------------------------------------------------------------ */
/* Retarget profile                                                    */
/* ------------------------------------------------------------------ */

export interface RetargetProfile {
  /** Vertical hip translation scale applied to every clip (bob / crouch). */
  hipY: number;
  /** Horizontal hip translation scale (weight shift / lunge). */
  hipXZ: number;
  /** Extra vertical collapse scale for death clips. */
  deathHipY: number;
  /** Ground distance covered by one full walk cycle (2 steps), metres. */
  strideWalk: number;
  /** Ground distance covered by one full run cycle (2 steps), metres. */
  strideRun: number;
  /** Ground distance covered by one full backpedal cycle, metres. */
  strideBack: number;
  /** Ground distance covered by one full strafe cycle, metres. */
  strideStrafe: number;
}

export const DEFAULT_RETARGET_PROFILE: RetargetProfile = {
  hipY: 1.3,
  hipXZ: 0.6,
  deathHipY: 2.8,
  // Our fighter's legs are ~2x the source chibi's, so a given leg-angle cycle
  // covers more ground; these are the "no skating" knobs, tune in gameplay.
  strideWalk: 1.30,
  strideRun: 3.10,
  strideBack: 1.15,
  strideStrafe: 2.40,
};

/* ------------------------------------------------------------------ */
/* Clip names                                                          */
/* ------------------------------------------------------------------ */

type AnimSet = '1H' | '2H';

const IDLE_CLIP: Record<AnimSet, string> = { '1H': 'Idle', '2H': 'Idle2H' };
const GUARD_CLIP: Record<AnimSet, string> = { '1H': 'Guard', '2H': 'Guard2H' };
const ATTACK_CLIP: Record<AttackDir, Record<AnimSet, string>> = {
  right: { '1H': 'AttackR', '2H': 'AttackR2H' },
  left: { '1H': 'AttackL', '2H': 'AttackL2H' },
  overhead: { '1H': 'AttackO', '2H': 'AttackO2H' },
  thrust: { '1H': 'AttackT', '2H': 'AttackT2H' },
};
const ACTION_CLIP: Record<string, string> = {
  hit: 'Hit', stagger: 'Stagger', kick: 'Kick', bash: 'GuardHit',
  victory: 'Cheer', taunt: 'Cheer', spawn: 'Idle',
};
const DEATH_CLIP = 'DeathA';
const DEATH_DURATION = 1.15;
const DODGE_CLIP: Record<string, string> = { left: 'DodgeL', right: 'DodgeR', backward: 'DodgeB', forward: 'DodgeF' };

/**
 * Extra grip rotation (radians, hand-local X) per weapon kind. The rig's weapon
 * joint was authored for the procedural ready pose; baked hand orientations
 * come from the source and need a constant wrist correction so blades/hafts
 * read naturally (tip down at idle, edge leading in swings). Applied to the
 * hand's local rotation so rig.ts's weapon joint stays untouched.
 */
const WEAPON_GRIP_X: Record<string, number> = {
  sword: 0.48, saber: 0.42, greatsword: 0.55, axe: 0.35, mace: 0.35, spear: 0, staff: 0,
};

/** Action durations used by the game's state machine (mirrors animation.ts). */
function actionDuration(action: RigAction): number {
  switch (action) {
    case 'hit': return 0.42;
    case 'stagger': return 0.95;
    case 'kick': return 0.7;
    case 'dodge': return 0.46;
    case 'victory': return 1.7;
    case 'taunt': return 1.0;
    case 'spawn': return 0.95;
    case 'bash': return 0.52;
    case 'die': return 1.0;
    default: return 0.6;
  }
}

/* ------------------------------------------------------------------ */
/* Sampling                                                            */
/* ------------------------------------------------------------------ */

const IDENTITY = new THREE.Quaternion();
const tempA = new THREE.Quaternion();
const tempB = new THREE.Quaternion();

/** Sample a clip at absolute seconds into `outQ` (local quats) + `outHips`. */
export function sampleBakedClip(
  clip: BakedClip,
  fps: number,
  time: number,
  outQ: THREE.Quaternion[],
  outHips: THREE.Vector3,
): void {
  const n = clip.frames;
  let f = time * fps;
  if (clip.loop) f = ((f % n) + n) % n;
  else f = Math.min(Math.max(f, 0), n - 1);
  const i0 = Math.floor(f);
  const frac = f - i0;
  const i1 = clip.loop ? (i0 + 1) % n : Math.min(i0 + 1, n - 1);
  for (let b = 0; b < BAKED_BONES.length; b++) {
    const tr = clip.tracks[BAKED_BONES[b]];
    const o0 = i0 * 4;
    const o1 = i1 * 4;
    tempA.set(tr[o0], tr[o0 + 1], tr[o0 + 2], tr[o0 + 3]);
    if (frac > 0.0001) {
      tempB.set(tr[o1], tr[o1 + 1], tr[o1 + 2], tr[o1 + 3]);
      outQ[b].copy(tempA).slerp(tempB, frac);
    } else {
      outQ[b].copy(tempA);
    }
  }
  const h0 = i0 * 3;
  const h1 = i1 * 3;
  outHips.set(
    clip.hips[h0] + (clip.hips[h1] - clip.hips[h0]) * frac,
    clip.hips[h0 + 1] + (clip.hips[h1 + 1] - clip.hips[h0 + 1]) * frac,
    clip.hips[h0 + 2] + (clip.hips[h1 + 2] - clip.hips[h0 + 2]) * frac,
  );
}

/* ------------------------------------------------------------------ */
/* Animator                                                            */
/* ------------------------------------------------------------------ */

export interface BakedAnimatorOptions {
  loadout: Loadout;
  /** Small per-fighter phase offset so crowds don't move in lockstep. */
  seed?: number;
  profile?: Partial<RetargetProfile>;
}

interface AttackState {
  dir: AttackDir;
  elapsed: number;
  timing: AttackTiming;
}

interface ActionState {
  action: RigAction;
  elapsed: number;
  duration: number;
  localX: number;
  localZ: number;
  variant: number;
  weight: number;
}

/**
 * Drop-in replacement for `CharacterAnimator` driven by baked clips.
 * Public API mirrors the procedural animator 1:1, plus `debug*` helpers for labs.
 */
export class BakedCharacterAnimator {
  readonly pose: RigPose = createPose();
  profile: RetargetProfile;

  private readonly lib: BakedClipLibrary;
  private readonly loadout: Loadout;
  private readonly animSet: AnimSet;
  private readonly seedPhase: number;
  private readonly gripQuat = new THREE.Quaternion();
  private readonly gripEuler = new THREE.Euler();

  private time = 0;
  private motion = { speed: 0, strafe: 0, forward: 0 };
  private speedSpring = 0;
  private smoothStrafe = 0;
  private guardDir: GuardDir | null = null;
  private guardW = 0;

  /** Normalised gait phase 0..1 shared by walk/run/strafe/back so fades line up. */
  private gaitPhase = 0;
  private guardPhase = 0;

  private attack: AttackState | null = null;
  private attackW = 0;
  private action: ActionState | null = null;
  private actionW = 0;

  private dead = false;
  private deathElapsed = 0;
  private deathStartQ: THREE.Quaternion[] | null = null;

  private lookActive = false;
  private lookTarget = new THREE.Vector3();
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawSmooth = 0;
  private lookPitchSmooth = 0;

  // scratch
  private q = BAKED_BONES.map(() => new THREE.Quaternion());
  private scratchQ = BAKED_BONES.map(() => new THREE.Quaternion());
  private hipsDelta = new THREE.Vector3();
  private scratchHips = new THREE.Vector3();
  private blendWeightSum = 0;
  private bodyEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private boneEuler = new THREE.Euler(0, 0, 0, 'XYZ');
  private hipsWorld = new THREE.Vector3();
  private hipsLocal = new THREE.Vector3();
  private capeTime = 0;

  // debug / lab clip player
  private debugClip: string | null = null;
  private debugPlayhead = 0;
  private debugFrozen = false;

  constructor(lib: BakedClipLibrary, opts: BakedAnimatorOptions) {
    this.lib = lib;
    this.loadout = opts.loadout;
    const want2H = opts.loadout.weapon.twoHanded;
    this.animSet = want2H && lib.clips[IDLE_CLIP['2H']] ? '2H' : '1H';
    this.profile = { ...DEFAULT_RETARGET_PROFILE, ...opts.profile };
    this.seedPhase = ((opts.seed ?? 1) >>> 0) % 1000 / 1000 * Math.PI * 2;
    this.gripQuat.setFromEuler(
      this.gripEuler.set(WEAPON_GRIP_X[opts.loadout.weapon.kind] ?? 0, 0, 0, 'XYZ'),
    );
    this.applyPose();
  }

  /* ---------------------------------------------------------------- */
  /* Public controls (same surface as CharacterAnimator)              */
  /* ---------------------------------------------------------------- */

  setMotion(speed: number, strafe: number, forward: number): void {
    if (!Number.isFinite(speed)) speed = 0;
    if (!Number.isFinite(strafe)) strafe = 0;
    if (!Number.isFinite(forward)) forward = 0;
    this.motion.speed = Math.max(0, speed);
    this.motion.strafe = clamp(strafe, -9, 9);
    this.motion.forward = clamp(forward, -9, 9);
  }

  setGuard(dir: GuardDir | null): void {
    this.guardDir = dir;
  }

  playAttack(dir: AttackDir, speedMul: number, _weapon?: Loadout['weapon']): void {
    void _weapon;
    if (this.dead) return;
    const mul = Number.isFinite(speedMul) ? clamp(speedMul, 0.4, 2.2) : 1;
    this.attack = { dir, elapsed: 0, timing: attackTiming(this.loadout.weapon, mul) };
    this.attackW = Math.max(this.attackW, 0.4);
    // Attack interrupts a recovery action / guard pose.
    if (this.action && this.action.action !== 'spawn') {
      this.action = null;
      this.actionW = 0;
    }
  }

  playAction(
    action: RigAction,
    opts?: { dir?: THREE.Vector3; variant?: number },
    rootYaw = 0,
  ): void {
    if (action === 'die') {
      this.setDead(true);
      return;
    }
    if (this.dead) return;
    this.action = {
      action,
      elapsed: 0,
      duration: actionDuration(action),
      localX: 0,
      localZ: 1,
      variant: (opts?.variant ?? 0) % 2,
      weight: 0,
    };
    if (action === 'dodge' && opts?.dir) {
      const c = Math.cos(-rootYaw);
      const s = Math.sin(-rootYaw);
      const dx = opts.dir.x;
      const dz = opts.dir.z;
      const lx = dx * c - dz * s;
      const lz = dx * s + dz * c;
      const len = Math.hypot(lx, lz) || 1;
      this.action.localX = lx / len;
      this.action.localZ = lz / len;
    }
    this.actionW = Math.max(this.actionW, action === 'spawn' ? 1 : 0.55);
  }

  setLookTarget(v: THREE.Vector3 | null): void {
    this.lookActive = !!v;
    if (v) this.lookTarget.copy(v);
  }

  setDead(dead: boolean): void {
    if (dead && !this.dead) {
      this.dead = true;
      this.deathElapsed = 0;
      this.deathStartQ = this.q.map((q) => q.clone());
      this.attack = null;
      this.action = null;
      this.guardDir = null;
    } else if (!dead) {
      this.dead = false;
      this.deathElapsed = 0;
      this.deathStartQ = null;
    }
  }

  get isDead(): boolean {
    return this.dead;
  }

  get attacking(): boolean {
    return this.attack !== null;
  }

  /** True while the swing is inside (or just before) the authoritative active window. */
  get trailActive(): boolean {
    if (!this.attack || this.dead) return false;
    const { windup, active } = this.attack.timing;
    return this.attack.elapsed >= windup - 0.04 && this.attack.elapsed <= windup + active + 0.08;
  }

  /* ---------------------------------------------------------------- */
  /* Debug helpers (labs only — not used by gameplay)                 */
  /* ---------------------------------------------------------------- */

  /** Play one baked clip directly, bypassing the state machine (lab inspection). */
  debugPlayClip(name: string): void {
    if (!this.lib.clips[name]) return;
    this.debugClip = name;
    this.debugFrozen = false;
    this.debugPlayhead = 0;
    this.applyPose();
  }

  /** Freeze a baked clip at a normalised phase (deterministic screenshots). */
  debugFreezeClip(name: string, phase: number): void {
    const clip = this.lib.clips[name];
    if (!clip) return;
    this.debugClip = name;
    this.debugFrozen = true;
    this.debugPlayhead = clamp(phase, 0, 0.9999) * clip.dur;
    this.applyPose();
  }

  debugStop(): void {
    this.debugClip = null;
    this.debugFrozen = false;
    this.applyPose();
  }

  get debugClipName(): string | null {
    return this.debugClip;
  }

  /** Current playhead of the debug clip, seconds. */
  get debugTime(): number {
    return this.debugPlayhead;
  }

  /* ---------------------------------------------------------------- */
  /* Update                                                           */
  /* ---------------------------------------------------------------- */

  update(dt: number, rootYaw: number, rootPos: THREE.Vector3): void {
    const step = Math.min(Math.max(dt, 0), 0.05);
    this.time += step;
    this.capeTime += step;

    if (this.debugClip) {
      const clip = this.lib.clips[this.debugClip];
      if (!this.debugFrozen) {
        this.debugPlayhead += step;
        if (clip.loop) this.debugPlayhead %= clip.dur;
        else this.debugPlayhead = Math.min(this.debugPlayhead, clip.dur);
      }
      this.sampleDebug();
      this.finishPose();
      return;
    }

    if (this.dead) {
      this.updateDeath(step);
      this.finishPose();
      return;
    }

    // Smooth inputs so blends never snap.
    this.speedSpring = damp(this.speedSpring, this.motion.speed, 9, step);
    this.smoothStrafe = damp(this.smoothStrafe, this.motion.strafe, 10, step);
    const speed = this.speedSpring;
    const strafe = this.smoothStrafe;
    const forward = this.motion.forward;
    const moving = speed > 0.12 || Math.abs(strafe) > 0.12 || Math.abs(forward) > 0.12;

    // Advance the shared gait phase at the rate that keeps the planted foot
    // travelling at ground speed (no skating).
    const lateral = clamp(strafe / 3.2, -1, 1);
    const back = clamp(-forward / 3.0, 0, 1);
    const stride = speed > 2.9 ? this.profile.strideRun
      : back > 0.4 ? this.profile.strideBack
        : Math.abs(lateral) > 0.45 ? this.profile.strideStrafe
          : this.profile.strideWalk;
    if (moving) this.gaitPhase += step * Math.max(0.25, speed) / Math.max(0.4, stride);
    this.gaitPhase %= 1;
    this.guardPhase += step;

    this.blendWeightSum = 0;
    this.hipsDelta.set(0, 0, 0);

    /* --- locomotion base ------------------------------------------ */
    if (!moving) {
      this.blendClip(IDLE_CLIP[this.animSet], this.gaitPhase * this.lib.clips[IDLE_CLIP[this.animSet]].dur, 1);
    } else {
      const runMix = clamp((speed - 2.5) / 1.8, 0, 1);
      const strafeMix = clamp(Math.abs(lateral), 0, 1);
      const backMix = clamp(back * 1.15, 0, 1) * (1 - strafeMix);
      const fwdMix = Math.max(0, 1 - strafeMix - backMix);
      const total = fwdMix + strafeMix + backMix;
      const norm = total > 0.0001 ? 1 / total : 1;
      const gaitT = this.gaitPhase;
      if (fwdMix > 0.001) {
        if (runMix < 0.999) {
          this.blendClip('Walk', gaitT * this.lib.clips.Walk.dur, fwdMix * (1 - runMix) * norm);
        }
        if (runMix > 0.001) {
          this.blendClip('Run', gaitT * this.lib.clips.Run.dur, fwdMix * runMix * norm);
        }
      }
      if (strafeMix > 0.001) {
        const clip = lateral < 0 ? 'StrafeL' : 'StrafeR';
        this.blendClip(clip, gaitT * this.lib.clips[clip].dur, strafeMix * norm);
      }
      if (backMix > 0.001) {
        this.blendClip('Back', gaitT * this.lib.clips.Back.dur, backMix * norm);
      }
    }

    /* --- guard ---------------------------------------------------- */
    const guardTarget = this.guardDir ? 1 : 0;
    this.guardW = damp(this.guardW, guardTarget, 14, step);
    if (this.guardW > 0.002) {
      const clip = GUARD_CLIP[this.animSet];
      this.slerpTowardClip(clip, (this.guardPhase * this.lib.clips[clip].dur) % this.lib.clips[clip].dur, this.guardW);
      this.hipsDelta.y -= 0.02 * this.guardW;
    }

    /* --- attack overlay ------------------------------------------- */
    let overlayW = 0;
    let overlayClip: string | null = null;
    if (this.attack) {
      this.attack.elapsed += step;
      const T = this.attack.timing;
      const t = this.attack.elapsed;
      const rampIn = smoothstep(clamp(t / 0.06, 0, 1));
      let rampOut = 1;
      if (t > T.windup + T.active) {
        const rk = clamp((t - T.windup - T.active) / Math.max(0.0001, T.recover), 0, 1);
        rampOut = 1 - smoothstep(clamp((rk - 0.6) / 0.4, 0, 1));
      }
      overlayW = rampIn * rampOut;
      overlayClip = ATTACK_CLIP[this.attack.dir][this.animSet];
      if (t >= T.total) this.attack = null;
    }
    this.attackW = damp(this.attackW, overlayW, 26, step);

    /* --- action overlay ------------------------------------------- */
    let actionW = 0;
    let actionClip: string | null = null;
    if (this.action) {
      this.action.elapsed += step;
      const k = clamp(this.action.elapsed / this.action.duration, 0, 1);
      if (this.action.action === 'dodge') {
        const dx = this.action.localX;
        const dz = this.action.localZ;
        const dirName = dx < -0.45 ? 'left' : dx > 0.45 ? 'right' : dz < -0.45 ? 'backward' : 'forward';
        actionClip = DODGE_CLIP[dirName];
      } else {
        actionClip = ACTION_CLIP[this.action.action] ?? 'Idle';
      }
      actionW = actionWeightCurve(k, this.action.action);
      if (k >= 1) {
        this.action = null;
        this.actionW = 0;
      }
    }
    this.actionW = damp(this.actionW, actionW, 16, step);

    // Compose lofted overlays: locomotion → guard already applied, then action,
    // then attack (attack wins).
    if (this.action && actionClip && this.actionW > 0.002) {
      const clip = this.lib.clips[actionClip];
      this.slerpTowardClip(actionClip, (this.action.elapsed / this.action.duration) * clip.dur, this.actionW);
    }
    if (this.attack && overlayClip && this.attackW > 0.002) {
      const clip = this.lib.clips[overlayClip];
      const T = this.attack.timing;
      const phase = clamp(this.attack.elapsed / Math.max(0.0001, T.total), 0, 1);
      this.slerpTowardClip(overlayClip, phase * clip.dur, this.attackW);
    }

    this.applyLook(step, rootYaw, rootPos);
    this.finishPose();
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                        */
  /* ---------------------------------------------------------------- */

  private blendClip(name: string, time: number, weight: number): void {
    if (weight <= 0.0005) return;
    const clip = this.lib.clips[name];
    if (!clip) return;
    sampleBakedClip(clip, this.lib.fps, time, this.scratchQ, this.scratchHips);
    this.scratchHips.set(
      this.scratchHips.x * this.profile.hipXZ,
      this.scratchHips.y * this.profile.hipY,
      this.scratchHips.z * this.profile.hipXZ,
    );
    const w = weight / (this.blendWeightSum + weight);
    if (this.blendWeightSum <= 0.0001) {
      for (let i = 0; i < BAKED_BONES.length; i++) this.q[i].copy(this.scratchQ[i]);
      this.hipsDelta.copy(this.scratchHips);
    } else {
      for (let i = 0; i < BAKED_BONES.length; i++) this.q[i].slerp(this.scratchQ[i], w);
      this.hipsDelta.lerp(this.scratchHips, w);
    }
    this.blendWeightSum += weight;
  }

  private slerpTowardClip(name: string, time: number, weight: number): void {
    if (weight <= 0.0005) return;
    const clip = this.lib.clips[name];
    if (!clip) return;
    sampleBakedClip(clip, this.lib.fps, time, this.scratchQ, this.scratchHips);
    this.scratchHips.set(
      this.scratchHips.x * this.profile.hipXZ,
      this.scratchHips.y * this.profile.hipY,
      this.scratchHips.z * this.profile.hipXZ,
    );
    const w = clamp(weight, 0, 1);
    for (let i = 0; i < BAKED_BONES.length; i++) this.q[i].slerp(this.scratchQ[i], w);
    this.hipsDelta.lerp(this.scratchHips, w);
  }

  private sampleDebug(): void {
    const clip = this.lib.clips[this.debugClip as string];
    sampleBakedClip(clip, this.lib.fps, this.debugPlayhead, this.q, this.hipsDelta);
    const death = this.debugClip === DEATH_CLIP || this.debugClip === 'DeathB';
    const sy = death ? this.profile.deathHipY : this.profile.hipY;
    this.hipsDelta.set(
      this.hipsDelta.x * this.profile.hipXZ,
      this.hipsDelta.y * sy,
      this.hipsDelta.z * this.profile.hipXZ,
    );
  }

  private updateDeath(step: number): void {
    this.deathElapsed += step;
    const clip = this.lib.clips[DEATH_CLIP];
    const t = Math.min(this.deathElapsed / DEATH_DURATION, 1) * clip.dur;
    sampleBakedClip(clip, this.lib.fps, t, this.scratchQ, this.scratchHips);
    this.hipsDelta.set(
      this.scratchHips.x * this.profile.hipXZ,
      this.scratchHips.y * this.profile.deathHipY,
      this.scratchHips.z * this.profile.hipXZ,
    );
    const blend = clamp(this.deathElapsed / 0.14, 0, 1);
    if (this.deathStartQ) {
      for (let i = 0; i < BAKED_BONES.length; i++) {
        this.q[i].copy(this.deathStartQ[i]).slerp(this.scratchQ[i], blend);
      }
    } else {
      for (let i = 0; i < BAKED_BONES.length; i++) this.q[i].copy(this.scratchQ[i]);
    }
    // Clamp: hold the final lying pose (source Death_A ends on the ground).
  }

  private applyLook(step: number, rootYaw: number, rootPos: THREE.Vector3): void {
    let targetYaw = 0;
    let targetPitch = 0;
    if (this.lookActive) {
      const dx = this.lookTarget.x - rootPos.x;
      const dz = this.lookTarget.z - rootPos.z;
      const dist = Math.hypot(dx, dz);
      const worldYaw = Math.atan2(dx, dz);
      let rel = worldYaw - rootYaw;
      rel = Math.atan2(Math.sin(rel), Math.cos(rel));
      targetYaw = clamp(rel, -1.25, 1.25);
      targetPitch = clamp(Math.atan2(this.lookTarget.y - (rootPos.y + 1.58), Math.max(0.4, dist)), -0.55, 0.5);
      if (Math.abs(rel) > 1.7) {
        targetYaw *= 0.25;
        targetPitch *= 0.4;
      }
    }
    this.lookYawSmooth = damp(this.lookYawSmooth, targetYaw, 7, step);
    this.lookPitchSmooth = damp(this.lookPitchSmooth, targetPitch, 8, step);
    this.lookYaw = this.lookYawSmooth;
    this.lookPitch = this.lookPitchSmooth;
  }

  /**
   * Write the local quaternions into `pose`: pelvis rotation on bodyRot with an
   * exact hips-position solve, neck/head split, procedural cape, shield trim.
   */
  private finishPose(): void {
    const hipsQ = this.q[0];
    this.bodyEuler.setFromQuaternion(hipsQ, 'XYZ');
    this.pose.bodyRot.x = this.bodyEuler.x;
    this.pose.bodyRot.y = this.bodyEuler.y;
    this.pose.bodyRot.z = this.bodyEuler.z;

    this.hipsWorld.set(
      SKELETON.hips[0] + this.hipsDelta.x,
      SKELETON.hips[1] + this.hipsDelta.y,
      SKELETON.hips[2] + this.hipsDelta.z,
    );
    this.hipsLocal.copy(this.hipsWorld).applyQuaternion(tempA.copy(hipsQ).invert());
    this.pose.hipsOffset.x = this.hipsLocal.x - SKELETON.hips[0];
    this.pose.hipsOffset.y = this.hipsLocal.y - SKELETON.hips[1];
    this.pose.hipsOffset.z = this.hipsLocal.z - SKELETON.hips[2];

    for (let b = 1; b < BAKED_BONES.length; b++) {
      const name = BAKED_BONES[b];
      let q = this.q[b];
      if (name === 'handR' || name === 'handL') {
        // Weapon grip correction rides on the weapon hand only.
        if (name === 'handR') {
          if (this.loadout.weapon.kind in WEAPON_GRIP_X) {
            tempA.copy(q).multiply(this.gripQuat);
            q = tempA;
          }
        }
      }
      if (name === 'head') {
        // Source has no neck: split chest->head rotation across our neck.
        tempA.copy(IDENTITY).slerp(q, 0.3);
        this.boneEuler.setFromQuaternion(tempA, 'XYZ');
        const neck = this.pose.rot.neck;
        neck.x = this.boneEuler.x;
        neck.y = this.boneEuler.y;
        neck.z = this.boneEuler.z;
        tempB.copy(tempA).invert().multiply(q);
        this.boneEuler.setFromQuaternion(tempB, 'XYZ');
        const head = this.pose.rot.head;
        head.x = this.boneEuler.x;
        head.y = this.boneEuler.y;
        head.z = this.boneEuler.z;
        continue;
      }
      this.boneEuler.setFromQuaternion(q, 'XYZ');
      const e = this.pose.rot[name as keyof RigPose['rot']];
      e.x = this.boneEuler.x;
      e.y = this.boneEuler.y;
      e.z = this.boneEuler.z;
    }

    // Head look-at layered on top of the baked head, like the procedural rig.
    this.pose.rot.neck.y += this.lookYaw * 0.32;
    this.pose.rot.head.y += this.lookYaw * 0.55;
    this.pose.rot.neck.x += this.lookPitch * 0.18;
    this.pose.rot.head.x += -this.lookPitch * 0.55;

    // Cape: procedural secondary motion (source has no cape bone).
    const sp = this.motion.speed;
    const strafe = this.motion.strafe;
    const cape = this.pose.rot.cape;
    cape.x = 0.1 + clamp(sp * 0.035, 0, 0.35) + Math.sin(this.capeTime * 1.7 + this.seedPhase) * 0.02;
    cape.y = -strafe * 0.03 + Math.sin(this.capeTime * 1.3 + this.seedPhase) * 0.015;
    cape.z = Math.sin(this.capeTime * 1.9 + this.seedPhase) * 0.012;

    // Shield trim: keeps the shield face aligned to the torso (rig neutralises
    // the left-arm chain); the arm pose still carries the shield spatially.
    const sr = this.pose.shieldRot;
    sr.x = -0.12;
    sr.y = 0.62;
    sr.z = 0.12;
    this.pose.shieldPos.x = 0;
    this.pose.shieldPos.y = 0;
    this.pose.shieldPos.z = 0;
  }

  private applyPose(): void {
    // Initial pose (before the first update) is the neutral idle at t=0.
    const clip = this.lib.clips[IDLE_CLIP[this.animSet]];
    sampleBakedClip(clip, this.lib.fps, 0, this.q, this.hipsDelta);
    this.hipsDelta.set(
      this.hipsDelta.x * this.profile.hipXZ,
      this.hipsDelta.y * this.profile.hipY,
      this.hipsDelta.z * this.profile.hipXZ,
    );
    this.finishPose();
  }
}

/** Overlay weight curve per action (mirrors animation.ts). */
function actionWeightCurve(k: number, action: RigAction): number {
  switch (action) {
    case 'hit': return 1;
    case 'stagger':
      return k < 0.15 ? smoothstep(k / 0.15) : 1 - smoothstep(clamp((k - 0.6) / 0.4, 0, 1));
    case 'kick':
      return k < 0.12 ? smoothstep(k / 0.12) : 1 - smoothstep(clamp((k - 0.7) / 0.3, 0, 1));
    case 'dodge':
      return k < 0.1 ? smoothstep(k / 0.1) : 1 - smoothstep(clamp((k - 0.6) / 0.4, 0, 1));
    case 'victory':
      return k < 0.15 ? smoothstep(k / 0.15) : 1 - smoothstep(clamp((k - 0.85) / 0.15, 0, 1));
    case 'taunt':
      return k < 0.15 ? smoothstep(k / 0.15) : 1 - smoothstep(clamp((k - 0.8) / 0.2, 0, 1));
    case 'bash':
      return k < 0.1 ? smoothstep(k / 0.1) : 1 - smoothstep(clamp((k - 0.6) / 0.4, 0, 1));
    case 'spawn':
      return 1;
    default:
      return 1;
  }
}
