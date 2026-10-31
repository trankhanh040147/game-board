import * as THREE from 'three';
import { attackTiming } from '../core/config';
import type { AttackDir, GuardDir, Loadout, RigAction } from '../core/types';
import type { AttackTiming } from '../core/config';
import { clamp, damp, easeInOutCubic, easeOutCubic, normalizeAngle, smoothstep } from '../core/utils';
import {
  POSE_JOINTS,
  blendJoints,
  copyPose,
  createPose,
  lerpPose,
  resetPose,
  type PoseJoint,
  type RigPose,
} from './skeleton';
import { Spring } from './shared';

const ALL_JOINTS: readonly PoseJoint[] = POSE_JOINTS;

const UPPER: readonly PoseJoint[] = ['spine', 'chest', 'neck', 'head', 'shoulderR', 'elbowR', 'handR', 'shoulderL', 'elbowL', 'handL'];

export interface MotionInput {
  speed: number;
  strafe: number;
  forward: number;
}

type AttackDef = { windup: RigPose; strike: RigPose };

export interface AnimatorOptions {
  loadout: Loadout;
  /** Small per-fighter phase/idle offset so a crowd does not move in lockstep. */
  seed: number;
}

/**
 * Procedural, layered animation for a rigid-part fighter.
 *
 * Layers (in order): combat-ready base → idle breathing/sway → locomotion →
 * directional guard → attack/action overlay → death → head look-at → cape springs.
 * Attack timing is driven directly by `attackTiming()` so the visual swing lands
 * inside the authoritative active window.
 */
export class CharacterAnimator {
  readonly pose: RigPose = createPose();

  private loco = createPose();
  private overlay = createPose();
  private ready = createPose();
  private tmpA = createPose();
  private tmpB = createPose();
  private deathPose = createPose();

  private readonly attacks: Record<AttackDir, AttackDef>;
  private readonly seedPhase: number;
  private readonly twoHanded: boolean;
  private readonly weaponKind: string;
  private readonly arms: ArmSet;

  private time = 0;
  private motion: MotionInput = { speed: 0, strafe: 0, forward: 0 };
  private smoothSpeed = 0;
  private smoothStrafe = 0;
  private walkPhase = 0;

  private speedSpring = new Spring();
  private guardSpring = new Spring();
  private guardDir: GuardDir | null = null;

  private attackDir: AttackDir | null = null;
  private attackElapsed = 0;
  private attackTiming: AttackTiming = { windup: 0.3, active: 0.1, recover: 0.3, total: 0.7 };
  private attackWeight = 0;

  private action: RigAction | null = null;
  private actionElapsed = 0;
  private actionDuration = 0.6;
  private actionLocal = { x: 0, z: 1 };
  private actionVariant = 0;
  private actionWeight = 0;

  private dead = false;
  private deathElapsed = 0;
  private deathDone = false;

  private lookActive = false;
  private lookTarget = new THREE.Vector3();
  private lookYawSpring = new Spring();
  private lookPitchSpring = new Spring();
  private lookYaw = 0;
  private lookPitch = 0;

  private capeSpringX = new Spring(0.04);
  private capeSpringY = new Spring();
  private breatheSpring = new Spring(1);
  private swaySpring = new Spring(0);
  private eyeShiftSpring = new Spring();

  constructor(opts: AnimatorOptions) {
    const { loadout, seed } = opts;
    this.twoHanded = loadout.weapon.twoHanded;
    this.weaponKind = loadout.weapon.kind;
    this.seedPhase = ((seed >>> 0) % 1000) / 1000 * Math.PI * 2;
    const pole = loadout.weapon.kind === 'spear' || loadout.weapon.kind === 'staff';
    this.arms = pole ? POLE_ARMS : this.twoHanded ? TWO_HAND_ARMS : ONE_HAND_ARMS;
    this.ready = buildReadyPose(this.arms, !!loadout.shield);
    this.attacks = {
      right: { windup: buildRightWindup(this.ready, this.arms), strike: buildRightStrike(this.ready, this.arms) },
      left: { windup: buildLeftWindup(this.ready, this.arms), strike: buildLeftStrike(this.ready, this.arms) },
      overhead: { windup: buildOverheadWindup(this.ready, this.arms), strike: buildOverheadStrike(this.ready, this.arms) },
      thrust: { windup: buildThrustWindup(this.ready, this.arms), strike: buildThrustStrike(this.ready, this.arms) },
    };
    copyPose(this.pose, this.ready);
    this.speedSpring.reset(0);
    this.guardSpring.reset(0);
  }

  /* ---------------------------------------------------------------- */
  /* Public controls                                                   */
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

  playAttack(dir: AttackDir, speedMul: number, weapon: Loadout['weapon']): void {
    if (this.dead) return;
    const mul = Number.isFinite(speedMul) ? clamp(speedMul, 0.4, 2.2) : 1;
    this.attackDir = dir;
    this.attackElapsed = 0;
    this.attackTiming = attackTiming(weapon, mul);
    this.attackWeight = Math.max(this.attackWeight, 0.35);
    // An attack interrupts a guard / recovery action.
    if (this.action && this.action !== 'spawn') {
      this.action = null;
      this.actionWeight = 0;
    }
  }

  playAction(
    action: RigAction,
    opts?: { dir?: THREE.Vector3; variant?: number },
    rootYaw = 0,
  ): void {
    if (this.dead && action !== 'die') return;
    this.action = action;
    this.actionElapsed = 0;
    this.actionVariant = opts?.variant ?? 0;
    if (action === 'die') {
      this.dead = true;
      this.deathElapsed = 0;
      this.deathDone = false;
      this.attackDir = null;
      this.guardDir = null;
      this.action = null;
      return;
    }
    if (action === 'dodge' && opts?.dir) {
      // Convert world direction to local (root yaw) so the lean is correct.
      const c = Math.cos(-rootYaw);
      const s = Math.sin(-rootYaw);
      const dx = opts.dir.x;
      const dz = opts.dir.z;
      this.actionLocal.x = dx * c - dz * s;
      this.actionLocal.z = dx * s + dz * c;
      const len = Math.hypot(this.actionLocal.x, this.actionLocal.z) || 1;
      this.actionLocal.x /= len;
      this.actionLocal.z /= len;
    } else {
      this.actionLocal.x = 0;
      this.actionLocal.z = 1;
    }
    this.actionDuration = actionDuration(action);
    this.actionWeight = Math.max(this.actionWeight, action === 'spawn' ? 1 : 0.5);
  }

  setLookTarget(v: THREE.Vector3 | null): void {
    this.lookActive = !!v;
    if (v) this.lookTarget.copy(v);
  }

  setDead(dead: boolean): void {
    if (dead && !this.dead) {
      this.dead = true;
      this.deathElapsed = 0;
      this.deathDone = false;
      this.attackDir = null;
      this.action = null;
      this.guardDir = null;
    } else if (!dead) {
      this.dead = false;
      this.deathElapsed = 0;
      this.deathDone = false;
    }
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** True while the swing is in (or near) its active window, for weapon trails. */
  get trailActive(): boolean {
    if (!this.attackDir || this.dead) return false;
    const { windup, active } = this.attackTiming;
    return this.attackElapsed >= windup - 0.04 && this.attackElapsed <= windup + active + 0.08;
  }

  get attacking(): boolean {
    return this.attackDir !== null;
  }

  /* ---------------------------------------------------------------- */
  /* Update                                                            */
  /* ---------------------------------------------------------------- */

  update(dt: number, rootYaw: number, rootPos: THREE.Vector3): void {
    this.time += dt;
    const step = Math.min(dt, 0.05);

    if (this.dead) {
      this.deathElapsed += step;
      this.updateDeath(step);
      this.applyLook(step, rootYaw, rootPos);
      return;
    }

    // Smooth speed for gait blending (springy, never snaps).
    this.speedSpring.target = this.motion.speed;
    this.smoothSpeed = this.speedSpring.update(step, 9, 0.9);
    this.smoothStrafe = damp(this.smoothStrafe, this.motion.strafe, 10, step);
    const speed01 = clamp(this.smoothSpeed / 3.9, 0, 1);
    const run01 = clamp((this.smoothSpeed - 3.9) / (6.15 - 3.9), 0, 1);
    const anyMove = clamp(this.smoothSpeed / 1.1, 0, 1);
    this.walkPhase += step * Math.PI * 2 * (0.9 + this.smoothSpeed * 0.32);

    // Reset to ready and layer idle.
    copyPose(this.loco, this.ready);
    this.applyIdle(this.loco, step, anyMove);
    this.applyLocomotion(this.loco, speed01, run01, anyMove);

    // Guard.
    const guardTarget = this.guardDir ? 1 : 0;
    this.guardSpring.target = guardTarget;
    const guardW = clamp(this.guardSpring.update(step, 16, 0.95), 0, 1);
    if (this.guardDir && guardW > 0.001) {
      buildGuardPose(this.guardDir, this.tmpA);
      blendJoints(this.loco, this.tmpA, guardW, UPPER);
      this.loco.spine.x += this.tmpA.spine.x * 0;
    }
    // Slight body shield-brace when guarding.
    if (guardW > 0.001) {
      this.loco.hipsOffset.y -= 0.02 * guardW;
    }

    // Attack overlay.
    let overlayW = 0;
    if (this.attackDir) {
      this.attackElapsed += step;
      const T = this.attackTiming;
      const t = this.attackElapsed;
      const def = this.attacks[this.attackDir];
      // Weight ramps in fast, out over the recover.
      const rampIn = smoothstep(clamp(t / 0.075, 0, 1));
      let rampOut = 1;
      if (t > T.windup + T.active) {
        const rk = clamp((t - T.windup - T.active) / Math.max(0.0001, T.recover), 0, 1);
        rampOut = 1 - smoothstep(clamp((rk - 0.62) / 0.38, 0, 1));
      }
      overlayW = rampIn * rampOut;
      if (t < T.windup) {
        const k = easeInOutCubic(clamp(t / T.windup, 0, 1));
        lerpPose(this.overlay, this.ready, def.windup, k);
      } else if (t < T.windup + T.active) {
        const k = easeInOutCubic(clamp((t - T.windup) / T.active, 0, 1));
        lerpPose(this.overlay, def.windup, def.strike, k);
      } else {
        const rk = clamp((t - T.windup - T.active) / Math.max(0.0001, T.recover), 0, 1);
        lerpPose(this.overlay, def.strike, this.ready, easeOutCubic(rk));
      }
      // Attack footwork: coil backwards, then explode into a forward lunge that
      // carries the whole body (and the weapon) into the target.
      const dirScale = this.attackDir === 'thrust' ? 0.8 : this.attackDir === 'overhead' ? 0.9 : 1;
      const LUNGE = 0.23 * dirScale;
      let lunge = 0;
      if (t < T.windup) {
        lunge = -0.06 * smoothstep(clamp(t / T.windup, 0, 1));
      } else if (t < T.windup + T.active) {
        lunge = LUNGE * easeOutCubic(clamp((t - T.windup) / T.active, 0, 1));
      } else {
        const rk = clamp((t - T.windup - T.active) / Math.max(0.0001, T.recover), 0, 1);
        lunge = LUNGE * (1 - easeInOutCubic(clamp(rk * 1.25, 0, 1)));
      }
      const lw = clamp(lunge / LUNGE, 0, 1);
      this.overlay.bodyPos.z += lunge;
      this.overlay.hipsOffset.z += lunge * 0.25;
      this.overlay.hipsOffset.y -= 0.015 * overlayW;
      // Step the feet with the lunge so it reads as a committed step.
      this.overlay.thighL.x -= 0.3 * lw;
      this.overlay.kneeL.x += 0.16 * lw;
      this.overlay.footL.x += 0.14 * lw;
      this.overlay.thighR.x += 0.22 * lw;
      this.overlay.kneeR.x += 0.12 * lw;
      this.overlay.footR.x -= 0.34 * lw;
      if (this.overlay.spine.x < 0.1) this.overlay.spine.x += 0.05 * lw;
      if (t >= T.total) {
        this.attackDir = null;
      }
    }
    this.attackWeight = damp(this.attackWeight, overlayW, 30, step);

    // Action overlay.
    let actionW = 0;
    if (this.action) {
      this.actionElapsed += step;
      const k = clamp(this.actionElapsed / this.actionDuration, 0, 1);
      if (this.action === 'spawn') {
        actionW = 1;
        this.computeReadyRisePose(k, this.tmpB);
        copyPose(this.overlay, this.tmpB);
        if (k >= 1) this.action = null;
      } else {
        this.computeActionPose(k, this.tmpB);
        copyPose(this.overlay, this.tmpB);
        actionW = actionWeightCurve(k, this.action);
        if (k >= 1) {
          this.action = null;
          this.actionWeight = 0;
        }
      }
    }
    this.actionWeight = damp(this.actionWeight, actionW, this.action ? 14 : 9, step);

    // Compose: locomotion/base + overlay.
    copyPose(this.pose, this.loco);
    const blend = Math.max(this.attackWeight, this.actionWeight);
    if (blend > 0.002) {
      blendJoints(this.pose, this.overlay, Math.min(1, blend), ALL_JOINTS);
      this.pose.hipsOffset.x += (this.overlay.hipsOffset.x - this.pose.hipsOffset.x) * blend;
      this.pose.hipsOffset.y += (this.overlay.hipsOffset.y - this.pose.hipsOffset.y) * blend;
      this.pose.hipsOffset.z += (this.overlay.hipsOffset.z - this.pose.hipsOffset.z) * blend;
      this.pose.bodyRot.x += (this.overlay.bodyRot.x - this.pose.bodyRot.x) * blend;
      this.pose.bodyRot.y += (this.overlay.bodyRot.y - this.pose.bodyRot.y) * blend;
      this.pose.bodyRot.z += (this.overlay.bodyRot.z - this.pose.bodyRot.z) * blend;
      this.pose.bodyPos.x += (this.overlay.bodyPos.x - this.pose.bodyPos.x) * blend;
      this.pose.bodyPos.y += (this.overlay.bodyPos.y - this.pose.bodyPos.y) * blend;
      this.pose.bodyPos.z += (this.overlay.bodyPos.z - this.pose.bodyPos.z) * blend;
      this.pose.shieldPos.x += (this.overlay.shieldPos.x - this.pose.shieldPos.x) * blend;
      this.pose.shieldPos.y += (this.overlay.shieldPos.y - this.pose.shieldPos.y) * blend;
      this.pose.shieldPos.z += (this.overlay.shieldPos.z - this.pose.shieldPos.z) * blend;
      this.pose.shieldRot.x += (this.overlay.shieldRot.x - this.pose.shieldRot.x) * blend;
      this.pose.shieldRot.y += (this.overlay.shieldRot.y - this.pose.shieldRot.y) * blend;
      this.pose.shieldRot.z += (this.overlay.shieldRot.z - this.pose.shieldRot.z) * blend;
    }

    this.applyLook(step, rootYaw, rootPos);
    this.applySecondary(step);
  }

  /* ---------------------------------------------------------------- */
  /* Idle                                                              */
  /* ---------------------------------------------------------------- */

  private applyIdle(p: RigPose, dt: number, moving: number): void {
    const t = this.time + this.seedPhase;
    // Breathing: spring-driven so it never looks mechanical.
    this.breatheSpring.target = 1;
    const breath = this.breatheSpring.update(dt, 5, 0.8);
    const br = Math.sin(t * 1.55) * 0.011 * (1 - moving * 0.7) * breath;
    const breath2 = Math.sin(t * 1.55 - 0.6) * 0.006 * (1 - moving * 0.7);
    p.chest.x += br;
    p.chest.y += breath2 * 0.5;
    p.spine.x += br * 0.6;
    p.neck.x -= br * 0.5;
    p.hipsOffset.y += Math.sin(t * 1.55) * 0.004 * (1 - moving);

    // Slow weight shift / sway.
    const swayTarget = Math.sin(t * 0.42);
    this.swaySpring.target = swayTarget;
    const sway = this.swaySpring.update(dt, 2.2, 0.7);
    const idle = 1 - clamp(moving, 0, 1);
    p.hipsOffset.x += sway * 0.018 * idle;
    p.spine.z += -sway * 0.026 * idle;
    p.chest.z += -sway * 0.012 * idle;
    p.head.z += sway * 0.012 * idle;
    p.thighR.z += -sway * 0.012 * idle;
    p.thighL.z += -sway * 0.012 * idle;
    // Counter-rotate the head to keep it level.
    p.head.y += Math.sin(t * 0.31) * 0.05 * idle;
    p.neck.y += Math.sin(t * 0.31 + 0.4) * 0.03 * idle;

    // Weapon / shield life.
    const wb = Math.sin(t * 1.55 + 0.9) * 0.018 * idle;
    p.shoulderR.x += wb;
    p.elbowR.x += wb * 0.9;
    p.handR.x += wb * 0.6;
    p.shoulderL.x += Math.sin(t * 1.55 + 2.1) * 0.014 * idle;
    p.elbowL.x += Math.sin(t * 1.55 + 2.4) * 0.02 * idle;

    // A small idle eye/head dart.
    this.eyeShiftSpring.target = Math.sin(t * 0.23 + 1.3) * 0.02;
    p.head.y += this.eyeShiftSpring.update(dt, 1.6, 0.6) * idle;
  }

  /* ---------------------------------------------------------------- */
  /* Locomotion                                                        */
  /* ---------------------------------------------------------------- */

  private applyLocomotion(p: RigPose, speed01: number, run01: number, moving: number): void {
    if (moving < 0.001) {
      // Feet ankle compensation for the ready stance.
      p.footR.x += -(p.thighR.x + p.kneeR.x);
      p.footL.x += -(p.thighL.x + p.kneeL.x);
      return;
    }
    const phase = this.walkPhase;
    const s = Math.sin(phase);
    const c = Math.cos(phase);
    const back = clamp(-this.motion.forward / 3.5, -1, 1);
    const strafe01 = clamp(this.smoothStrafe / 3.2, -1, 1);
    const strafeMix = Math.abs(strafe01);

    // Stride amplitude sized so the planted foot travels backwards at the
    // character's actual ground speed (no skating).
    const amp = (0.5 * speed01 + 0.14 * run01) * (1 - 0.28 * strafeMix) * (back > 0.1 ? 0.82 : 1);

    // Positive hip lift only — never push the body down into the sand.
    p.hipsOffset.y += 0.004 + Math.abs(s) * (0.012 * speed01 + 0.014 * run01);
    p.hipsOffset.x += s * (0.014 * speed01 + 0.005 * run01) + strafe01 * 0.02;
    p.spine.y += -s * (0.06 * speed01 + 0.04 * run01);
    p.chest.y += s * (0.08 * speed01 + 0.06 * run01);
    p.neck.y += -s * 0.03 * speed01;

    // Lean forward with speed; backpedal leans back.
    const lean = (0.075 * speed01 + 0.12 * run01) * (back > 0.1 ? -0.55 : 1);
    p.spine.x += lean;
    p.chest.x += lean * 0.32;
    p.neck.x += -lean * 0.5;

    // Legs: alternating thigh swing. +x = leg back.
    p.thighR.x += s * amp;
    p.thighL.x += -s * amp;

    // Swing phase = leg travelling forward: knee lifts hard so the foot clears
    // the sand (8-12 cm at mid-swing), plus knee drive on the run.
    const swingR = Math.max(0, -c);
    const swingL = Math.max(0, c);
    // Faster lift right after toe-off (swing^0.7) so the foot clearly clears.
    const kneeLift = (0.45 * speed01 + 0.08 * run01) * (back > 0.05 ? 1.15 : 1) * (1 + 0.12 * strafeMix);
    const liftR = Math.pow(swingR, 0.7);
    const liftL = Math.pow(swingL, 0.7);
    p.kneeR.x += liftR * kneeLift + 0.05 * speed01;
    p.kneeL.x += liftL * kneeLift + 0.05 * speed01;
    p.kneeR.x += Math.max(0, s) * 0.16 * run01;
    p.kneeL.x += Math.max(0, -s) * 0.16 * run01;

    // Heel-to-toe roll: toes drop for toe-off at the end of stance, toes lift
    // during the swing for clearance. Then keep the sole roughly level.
    const toeOffR = Math.max(0, c) * Math.max(0, -s) * (0.32 * speed01 + 0.2 * run01);
    const toeOffL = Math.max(0, c) * Math.max(0, -s) * (0.32 * speed01 + 0.2 * run01);
    const heelLiftR = liftR * 0.3;
    const heelLiftL = liftL * 0.3;
    p.footR.x += -(p.thighR.x + p.kneeR.x) * 0.9 + toeOffR - heelLiftR;
    p.footL.x += -(p.thighL.x + p.kneeL.x) * 0.9 + toeOffL - heelLiftL;

    // Side-step for strafing: alternating lateral swing with knee lift, so the
    // leading foot visibly lifts and plants instead of skating.
    const sideR = railSide(phase, strafe01);
    const sideL = railSide(phase + Math.PI, strafe01);
    p.thighR.z += 0.02 * speed01 + sideR * 0.22 + strafe01 * 0.06;
    p.thighL.z += -0.02 * speed01 + sideL * 0.22 + strafe01 * 0.06;
    p.kneeR.x += Math.max(0, sideR) * 0.3 * strafeMix;
    p.kneeL.x += Math.max(0, sideL) * 0.3 * strafeMix;
    p.footR.x -= Math.max(0, sideR) * 0.2 * strafeMix;
    p.footL.x -= Math.max(0, sideL) * 0.2 * strafeMix;
    p.hipsOffset.x += (sideR + sideL) * 0.012 * strafeMix;
    p.spine.z += -strafe01 * 0.1;
    p.chest.z += -strafe01 * 0.05;
    p.head.z += strafe01 * 0.045;

    // Arm swing (left arm swings freely, weapon arm stays controlled).
    p.shoulderL.x += -s * (0.46 * speed01 + 0.32 * run01);
    p.elbowL.x += -Math.max(0, s) * 0.3 * speed01;
    p.shoulderR.x += s * (0.09 * speed01 + 0.1 * run01);
    p.elbowR.x += -0.05 * speed01 + Math.max(0, s) * 0.05 * run01;

    // Backpedal: shorter strides, deeper knees.
    if (back > 0.05) {
      p.spine.x += 0.07 * back;
      p.kneeR.x += 0.1 * back;
      p.kneeL.x += 0.1 * back;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Look-at                                                           */
  /* ---------------------------------------------------------------- */

  private applyLook(dt: number, rootYaw: number, rootPos: THREE.Vector3): void {
    let targetYaw = 0;
    let targetPitch = 0;
    if (this.lookActive) {
      const dx = this.lookTarget.x - rootPos.x;
      const dz = this.lookTarget.z - rootPos.z;
      const dist = Math.hypot(dx, dz);
      const worldYaw = Math.atan2(dx, dz);
      targetYaw = clamp(normalizeAngle(worldYaw - rootYaw), -1.25, 1.25);
      const headY = rootPos.y + 1.58;
      const dy = this.lookTarget.y - headY;
      targetPitch = clamp(Math.atan2(dy, Math.max(0.4, dist)), -0.55, 0.5);
      // If the target is basically behind us, don't twist the neck off.
      if (Math.abs(normalizeAngle(worldYaw - rootYaw)) > 1.7) {
        targetYaw *= 0.25;
        targetPitch *= 0.4;
      }
    }
    this.lookYawSpring.target = targetYaw;
    this.lookPitchSpring.target = targetPitch;
    const yaw = this.lookYawSpring.update(dt, 7, 0.9);
    const pitch = this.lookPitchSpring.update(dt, 8, 0.9);
    this.lookYaw = yaw;
    this.lookPitch = pitch;
    // Apply after all other layers so the head always tracks.
    this.pose.neck.y += yaw * 0.32;
    this.pose.head.y += yaw * 0.55;
    this.pose.neck.x += pitch * 0.18;
    this.pose.head.x += -pitch * 0.55;
    // Slight neck counter-lean to keep the head upright.
    this.pose.head.z += clamp(-this.pose.spine.z * 0.5, -0.2, 0.2);
  }

  /* ---------------------------------------------------------------- */
  /* Secondary: cape + cloth                                           */
  /* ---------------------------------------------------------------- */

  private applySecondary(dt: number): void {
    const fwdSpeed = this.motion.forward;
    const target = 0.08 + clamp(fwdSpeed * 0.045, -0.12, 0.5) + Math.sin(this.walkPhase) * 0.02 * clamp(this.smoothSpeed / 4, 0, 1);
    this.capeSpringX.target = target;
    this.capeSpringY.target = -this.motion.strafe * 0.035 + Math.sin(this.time * 1.7) * 0.02;
    const cx = this.capeSpringX.update(dt, 6, 0.55);
    const cy = this.capeSpringY.update(dt, 5, 0.5);
    this.pose.rot.cape.x += cx;
    this.pose.rot.cape.y += cy;
    this.pose.rot.cape.z += Math.sin(this.time * 1.9 + this.seedPhase) * 0.02;
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                           */
  /* ---------------------------------------------------------------- */

  private computeActionPose(k: number, out: RigPose): void {
    copyPose(out, this.ready);
    const action = this.action;
    const t = k * this.actionDuration;
    switch (action) {
      case 'hit': {
        // Sharp flinch + springy settle.
        const impact = k < 0.28 ? easeOutCubic(k / 0.28) : 1 - smoothstep((k - 0.28) / 0.72);
        const wobble = Math.sin(t * 32) * Math.exp(-t * 7) * 0.5;
        out.spine.x += -0.32 * impact + wobble * 0.1;
        out.spine.y += (this.actionVariant % 2 === 0 ? 1 : -1) * 0.12 * impact;
        out.chest.x += -0.2 * impact;
        out.neck.x += -0.18 * impact;
        out.head.x += -0.22 * impact;
        out.head.y += (this.actionVariant % 2 === 0 ? -1 : 1) * 0.15 * impact;
        out.shoulderR.x += -0.25 * impact;
        out.shoulderR.z += 0.25 * impact;
        out.elbowR.x += -0.2 * impact;
        out.shoulderL.x += -0.35 * impact;
        out.shoulderL.z += -0.2 * impact;
        out.kneeR.x += 0.15 * impact;
        out.kneeL.x += 0.1 * impact;
        out.hipsOffset.y += -0.04 * impact;
        out.hipsOffset.z += -0.06 * impact;
        out.shieldPos.x += 0.03 * impact;
        out.shieldPos.y += 0.05 * impact;
        out.shieldRot.x += -0.12 * impact;
        break;
      }
      case 'stagger': {
        const rise = smoothstep(clamp(k / 0.22, 0, 1));
        const fall = 1 - smoothstep(clamp((k - 0.55) / 0.45, 0, 1));
        const off = Math.sin(k * Math.PI) * 0.5;
        out.spine.x += -0.36 * rise * fall;
        out.spine.z += off * 0.16;
        out.chest.x += -0.28 * rise * fall;
        out.neck.x += -0.25 * rise * fall;
        out.head.x += -0.2 * rise * fall;
        out.shoulderR.x += -0.8 * rise * fall;
        out.shoulderR.z += 0.9 * rise * fall;
        out.elbowR.x += 0.5 * rise * fall;
        out.shoulderL.x += -1.1 * rise * fall;
        out.shoulderL.z += -0.7 * rise * fall;
        out.thighR.x += 0.4 * rise * fall;
        out.kneeR.x += 0.55 * rise * fall;
        out.thighL.x += -0.25 * rise * fall;
        out.kneeL.x += 0.3 * rise * fall;
        out.hipsOffset.y += -0.09 * off;
        out.hipsOffset.z += -0.16 * off;
        out.bodyRot.x += -0.12 * off;
        out.shieldPos.x += -0.18 * off;
        out.shieldPos.y += 0.08 * off;
        out.shieldRot.z += -0.3 * off;
        break;
      }
      case 'kick': {
        const raise = k < 0.18 ? smoothstep(k / 0.18) : 1;
        const extend = smoothstep(clamp((k - 0.16) / 0.22, 0, 1));
        const retract = 1 - smoothstep(clamp((k - 0.6) / 0.4, 0, 1));
        const amt = raise * retract;
        out.thighR.x += -1.15 * amt;
        out.kneeR.x += 1.25 * amt * (1 - extend * 0.8);
        out.footR.x += 0.35 * amt;
        out.spine.x += -0.16 * amt;
        out.spine.y += 0.12 * amt;
        out.chest.x += -0.1 * amt;
        out.shoulderR.x += 0.35 * amt;
        out.shoulderR.z += 0.4 * amt;
        out.shoulderL.x += -0.4 * amt;
        out.shoulderL.z += -0.3 * amt;
        out.hipsOffset.y += -0.03 * amt;
        out.bodyPos.z += 0.08 * amt * extend;
        out.shieldPos.z += 0.03 * amt;
        out.shieldRot.z += 0.1 * amt;
        break;
      }
      case 'dodge': {
        const speedIn = smoothstep(clamp(k / 0.3, 0, 1));
        const out2 = 1 - smoothstep(clamp((k - 0.6) / 0.4, 0, 1));
        const amt = speedIn * out2;
        const dx = this.actionLocal.x;
        const dz = this.actionLocal.z;
        out.hipsOffset.y += -0.16 * amt;
        out.spine.x += 0.28 * amt;
        out.chest.x += 0.15 * amt;
        out.neck.x += -0.2 * amt;
        out.bodyRot.z += -dx * 0.45 * amt;
        out.bodyRot.x += dz * 0.35 * amt;
        out.bodyPos.x += dx * 0.1 * amt;
        out.bodyPos.z += dz * 0.08 * amt;
        out.kneeR.x += 0.7 * amt;
        out.kneeL.x += 0.6 * amt;
        out.thighR.x += -0.35 * amt;
        out.thighL.x += 0.15 * amt;
        out.shoulderR.x += 0.45 * amt;
        out.shoulderL.x += 0.35 * amt;
        out.shieldPos.z += 0.05 * amt;
        out.shieldPos.y += 0.04 * amt;
        out.shieldRot.x += 0.18 * amt;
        break;
      }
      case 'victory': {
        const raise = smoothstep(clamp(k / 0.25, 0, 1));
        const hold = 1 - smoothstep(clamp((k - 0.78) / 0.22, 0, 1));
        const amt = raise * hold;
        const bounce = Math.abs(Math.sin(t * 5.2)) * 0.03 * amt;
        out.shoulderR.x += -2.25 * amt;
        out.shoulderR.z += 0.45 * amt;
        out.elbowR.x += 0.55 * amt;
        out.handR.x += 0.3 * amt;
        out.shoulderL.x += -2.05 * amt;
        out.shoulderL.z += -0.55 * amt;
        out.elbowL.x += 0.75 * amt;
        out.spine.x += -0.12 * amt;
        out.chest.x += -0.1 * amt;
        out.neck.x += -0.12 * amt;
        out.head.x += -0.2 * amt;
        out.hipsOffset.y += bounce;
        out.thighR.z += 0.05 * amt;
        out.thighL.z += -0.05 * amt;
        out.shieldPos.y += -0.14 * amt;
        out.shieldPos.x += -0.04 * amt;
        out.shieldRot.x += 0.22 * amt;
        break;
      }
      case 'taunt': {
        const raise = smoothstep(clamp(k / 0.2, 0, 1)) * (1 - smoothstep(clamp((k - 0.75) / 0.25, 0, 1)));
        out.shoulderR.x += -1.85 * raise;
        out.shoulderR.z += 0.55 * raise;
        out.elbowR.x += 0.9 * raise;
        out.handR.x += Math.sin(t * 14) * 0.3 * raise;
        out.shoulderL.x += -0.5 * raise;
        out.elbowL.x += -0.4 * raise;
        out.chest.x += -0.06 * raise;
        out.head.x += -0.14 * raise;
        out.hipsOffset.y += Math.sin(t * 6.2) * 0.02 * raise;
        out.shieldPos.y += 0.08 * raise;
        out.shieldRot.x += -0.15 * raise;
        break;
      }
      case 'bash': {
        const push = k < 0.3 ? smoothstep(k / 0.3) : 1 - smoothstep(clamp((k - 0.45) / 0.55, 0, 1));
        out.shoulderL.x += -1.15 * push;
        out.shoulderL.z += 0.3 * push;
        out.elbowL.x += 0.65 * push;
        out.handL.x += 0.3 * push;
        out.spine.y += -0.28 * push;
        out.chest.y += -0.2 * push;
        out.spine.x += 0.18 * push;
        out.bodyPos.z += 0.12 * push;
        out.kneeR.x += 0.15 * push;
        out.shieldPos.z += 0.14 * push;
        out.shieldPos.y += 0.03 * push;
        out.shieldRot.x += -0.2 * push;
        out.shieldRot.y += 0.14 * push;
        break;
      }
      default:
        break;
    }
    // Keep feet grounded for upper-body actions.
    if (action !== 'kick' && action !== 'dodge') {
      out.footR.x += -(out.thighR.x + out.kneeR.x);
      out.footL.x += -(out.thighL.x + out.kneeL.x);
    }
    void POSE_JOINTS;
  }

  private computeReadyRisePose(k: number, out: RigPose): void {
    // Spawn: rise from one knee with the weapon coming up.
    const crouch = createPose();
    copyPose(crouch, this.ready);
    crouch.spine.x += 0.4;
    crouch.chest.x += 0.2;
    crouch.head.x += -0.2;
    crouch.thighR.x += -1.15;
    crouch.kneeR.x += 1.5;
    crouch.footR.x += 0.35;
    crouch.thighL.x += 0.35;
    crouch.kneeL.x += 1.2;
    crouch.hipsOffset.y += -0.42;
    crouch.hipsOffset.z += -0.06;
    crouch.shoulderR.x += 0.7;
    crouch.elbowR.x += 0.4;
    crouch.shoulderL.x += 0.3;
    crouch.shieldPos.y += -0.14;
    crouch.shieldPos.z += 0.02;
    crouch.shieldRot.x += 0.2;
    const t = easeOutCubic(clamp(k, 0, 1));
    lerpPose(out, crouch, this.ready, t);
    out.hipsOffset.y += Math.sin(k * Math.PI) * 0.03;
  }

  /* ---------------------------------------------------------------- */
  /* Death                                                             */
  /* ---------------------------------------------------------------- */

  private updateDeath(dt: number): void {
    const t = this.deathElapsed;
    const p = this.deathPose;
    copyPose(p, this.ready);

    if (t < 0.3) {
      const k = smoothstep(t / 0.3);
      p.spine.x += -0.25 * k;
      p.chest.x += -0.2 * k;
      p.head.x += -0.3 * k;
      p.kneeR.x += 0.7 * k;
      p.kneeL.x += 0.5 * k;
      p.hipsOffset.y += -0.14 * k;
      p.shoulderR.x += -0.5 * k;
      p.shoulderR.z += 0.5 * k;
      p.shoulderL.x += -0.7 * k;
      p.shoulderL.z += -0.5 * k;
      p.bodyRot.x += -0.12 * k;
      p.shieldPos.y += -0.12 * k;
      p.shieldPos.z += -0.03 * k;
      p.shieldRot.x += 0.25 * k;
      p.shieldRot.z += -0.15 * k;
    } else if (t < 0.85) {
      const k = easeInOutCubic((t - 0.3) / 0.55);
      p.spine.x += -0.25 + 0.1 * k;
      p.chest.x += -0.2 + 0.15 * k;
      p.head.x += -0.3 + 0.25 * k;
      p.kneeR.x += 0.7 + 0.5 * k;
      p.kneeL.x += 0.5 + 0.35 * k;
      p.hipsOffset.y += -0.14 + 0.1 * k;
      p.shoulderR.x += -0.5 + 0.9 * k;
      p.shoulderR.z += 0.5 + 0.2 * k;
      p.shoulderL.x += -0.7 + 1.0 * k;
      p.shoulderL.z += -0.5 - 0.2 * k;
      p.bodyRot.x += -0.12 - 1.36 * k;
      p.bodyPos.y += 0.16 * k;
      p.bodyPos.z += 0.06 * k;
      p.thighR.x += -0.3 * k;
      p.thighL.x += -0.15 * k;
      p.shieldPos.y += -0.26;
      p.shieldPos.z += -0.08;
      p.shieldRot.x += 0.5;
      p.shieldRot.z += -0.2;
    } else {
      // Settle: a small bounce, limbs slacken, corpse rests on the ground.
      const k = smoothstep(clamp((t - 0.85) / 0.45, 0, 1));
      const bounce = Math.sin(clamp((t - 0.85) / 0.45, 0, 1) * Math.PI) * 0.03;
      p.spine.x += -0.15;
      p.chest.x += -0.05;
      p.head.x += -0.05 + this.settleTilt(t);
      p.kneeR.x += 1.25 - 0.35 * k;
      p.kneeL.x += 0.9 - 0.15 * k;
      p.hipsOffset.y += -0.04;
      p.shoulderR.x += 0.4;
      p.shoulderR.z += 0.7 + 0.1 * k;
      p.shoulderL.x += 0.3;
      p.shoulderL.z += -0.7 - 0.1 * k;
      p.bodyRot.x += -1.48 - 0.04 * k;
      p.bodyRot.z += 0.1 * k;
      p.bodyPos.y += 0.15 + bounce;
      p.bodyPos.z += 0.06;
      p.thighR.x += -0.42;
      p.thighL.x += -0.2;
      p.thighR.z += 0.12;
      p.shieldPos.y += -0.12;
      p.shieldRot.x += 0.3;
      p.shieldRot.z += -0.2;
    }
    p.footR.x += -(p.thighR.x + p.kneeR.x) * 0.7;
    p.footL.x += -(p.thighL.x + p.kneeL.x) * 0.7;

    this.deathPose = p;
    copyPose(this.pose, p);
    this.deathPose = p;
    if (t > 2.2) this.deathDone = true;
    void dt;
  }

  private settleTilt(t: number): number {
    return Math.sin(t * 0.9) * 0.02;
  }
}

/* -------------------------------------------------------------------- */
/* Pose construction                                                    */
/* -------------------------------------------------------------------- */

type ArmAngles = readonly [number, number, number, number, number, number, number, number];

interface ArmSet {
  readyR: ArmAngles; readyL: ArmAngles;
  rWindR: ArmAngles; rWindL: ArmAngles;
  rStrikeR: ArmAngles; rStrikeL: ArmAngles;
  lWindR: ArmAngles; lWindL: ArmAngles;
  lStrikeR: ArmAngles; lStrikeL: ArmAngles;
  oWindR: ArmAngles; oWindL: ArmAngles;
  oStrikeR: ArmAngles; oStrikeL: ArmAngles;
  tWindR: ArmAngles; tWindL: ArmAngles;
  tStrikeR: ArmAngles; tStrikeL: ArmAngles;
}

/** Shoulder/elbow/wrist angles solved offline for natural weapon placement. */
const ONE_HAND_ARMS: ArmSet = {
  readyR: [0.06, 0.71, -0.06, -0.57, -0.63, -0.12, 0.37, -0.5],
  readyL: [0.02, 0.0, -0.04, -0.32, 0.0, 0.12, 0.08, 0.08],
  rWindR: [-0.47, 0.44, 0.4, -1.89, 0.69, 0.47, -0.07, 0.61],
  rWindL: [-0.6, 0.1, -0.5, -1.3, 0, 0.15, 0.1, 0.2],
  rStrikeR: [-1.4, -0.25, 0.65, 0.09, -0.29, 1.0, 0.13, 0.5],
  rStrikeL: [-0.45, 0.1, -0.5, -1.0, 0, 0.15, 0.1, 0.2],
  lWindR: [0.0, -0.37, 1.31, -1.73, -0.32, 0.69, 0.89, -1.6],
  lWindL: [-0.55, -0.1, 0.25, -0.9, 0, 0.1, 0.1, 0.1],
  lStrikeR: [-1.56, 0.13, -0.32, 0.0, -0.34, 1.29, 0.09, -0.36],
  lStrikeL: [-0.75, -0.1, 0.25, -1.0, 0, 0.1, 0.1, 0.1],
  oWindR: [-2.12, -0.15, 1.15, -2.39, -0.83, 0.52, -1.33, -0.98],
  oWindL: [-1.9, 0.0, -0.5, -1.3, 0, 0.1, 0, 0],
  oStrikeR: [-1.7, 1.02, -0.44, -0.43, 0.29, 1.89, 0.22, -0.23],
  oStrikeL: [-0.6, 0.0, -0.4, -0.6, 0, 0.2, 0, 0],
  tWindR: [0.57, 0.43, 0.01, -1.78, -1.01, 0.32, -0.03, 0.01],
  tWindL: [-0.8, 0.0, -0.3, -1.2, 0, 0.1, 0, 0],
  tStrikeR: [-1.6, 0.42, 0.32, -0.46, 0.18, 1.6, -0.08, -0.24],
  tStrikeL: [-0.4, 0.0, -0.4, -0.6, 0, 0.1, 0, 0],
};

/** Long-hafted weapons: shaft runs along the arm axis (thrust-friendly). */
const POLE_ARMS: ArmSet = {
  readyR: [0.09, 0.55, -0.01, -0.27, 0.6, -1.76, -1.81, 0.93],
  readyL: [-0.24, -0.25, 0.19, -0.45, 0.24, -0.9, -1.21, 0.32],
  rWindR: [0.41, 0.27, -0.41, -1.16, 0.05, -1.13, -1.37, 0.98],
  rWindL: [-0.5, 0.1, -0.4, -1.1, 0, 0.1, 0, 0.1],
  rStrikeR: [0.0, 0.65, 0.94, -0.92, -0.18, -1.19, 1.02, -0.38],
  rStrikeL: [-0.45, 0.1, -0.5, -0.9, 0, 0.15, 0.1, 0.2],
  lWindR: [-0.02, -0.27, -0.34, -0.98, -0.01, -1.29, -1.45, 0.4],
  lWindL: [-0.5, -0.1, 0.25, -1.0, 0, 0.1, 0.1, 0.1],
  lStrikeR: [-0.08, -0.15, -1.29, -0.47, -0.11, -0.95, -1.14, 0.52],
  lStrikeL: [-0.7, -0.1, 0.25, -1.0, 0, 0.1, 0.1, 0.1],
  oWindR: [0.61, 0.01, 0.12, -2.03, -0.32, -0.71, -0.93, 0.86],
  oWindL: [-1.6, 0.0, -0.4, -1.3, 0, 0.1, 0, 0],
  oStrikeR: [-1.12, 0.4, -0.28, -1.32, -0.48, -0.19, -1.29, -1.24],
  oStrikeL: [-0.6, 0.0, -0.4, -0.6, 0, 0.2, 0, 0],
  tWindR: [0.18, 0.53, 0.31, -1.22, -0.98, -0.97, -1.46, 0.57],
  tWindL: [-0.8, 0.0, -0.3, -1.2, 0, 0.1, 0, 0],
  tStrikeR: [-1.87, 0.33, 0.39, -0.08, -0.2, -0.21, -1.6, -0.2],
  tStrikeL: [-0.4, 0.0, -0.4, -0.6, 0, 0.1, 0, 0],
};

/** Two-handed weapons: right hand high on the grip, left hand supporting. */
const TWO_HAND_ARMS: ArmSet = {
  ...ONE_HAND_ARMS,
  readyR: [-0.38, 0.08, 0.23, -0.14, -0.33, -1.24, -0.01, -0.2],
  readyL: [-0.72, 0.42, 0.43, 0.0, -0.23, 0.51, 0.41, -0.43],
  rWindL: [-1.2, 0.2, -0.4, -1.5, 0, 0.3, 0.2, 0.2],
  rStrikeL: [-0.8, 0.2, -0.3, -0.9, 0, 0.3, 0.1, 0.1],
  lWindL: [-0.9, -0.3, 0.4, -1.4, 0, 0.2, 0.1, 0.1],
  lStrikeL: [-0.4, 0.1, 0.5, -1.1, 0, 0.2, 0.1, 0.1],
  oWindL: [-2.2, 0.0, -0.4, -1.4, 0, 0.1, 0, 0],
  oStrikeL: [-0.7, 0.0, -0.4, -0.8, 0, 0.15, 0, 0],
  tWindL: [-1.1, 0.2, 0.3, -1.6, 0, 0.2, 0, 0],
  tStrikeL: [-0.5, 0.0, -0.3, -0.5, 0, 0.1, 0, 0],
};

function applyArm(p: RigPose, side: 'R' | 'L', a: ArmAngles): void {
  const S = side === 'R' ? p.rot.shoulderR : p.rot.shoulderL;
  const E = side === 'R' ? p.rot.elbowR : p.rot.elbowL;
  const H = side === 'R' ? p.rot.handR : p.rot.handL;
  S.set(a[0], a[1], a[2]);
  E.set(a[3], a[4], 0);
  H.set(a[5], a[6], a[7]);
}

/** Neutral combat-ready stance: weapon in the right hand, shield on the left. */
function buildReadyPose(arms: ArmSet, hasShield: boolean): RigPose {
  const p = createPose();
  p.spine.x = 0.03;
  p.spine.y = 0.02;
  p.chest.x = 0.02;
  p.chest.y = -0.03;
  p.neck.x = 0.015;
  p.head.x = -0.01;

  applyArm(p, 'R', arms.readyR);
  applyArm(p, 'L', hasShield ? arms.readyL : [-0.3, 0.05, -0.28, -0.6, 0, 0.1, 0, 0.1]);

  // Shield strapped to the left forearm; only local trim adjustments here.
  p.shieldPos.x = 0;
  p.shieldPos.y = 0;
  p.shieldPos.z = 0;
  p.shieldRot.x = -0.12;
  p.shieldRot.y = 0.62;
  p.shieldRot.z = 0.12;

  // Feet: a slight staggered stance, right foot back.
  p.rot.thighR.x = -0.02;
  p.rot.thighR.z = 0.055;
  p.rot.kneeR.x = 0.14;
  p.rot.footR.x = -(p.rot.thighR.x + p.rot.kneeR.x);
  p.rot.thighL.x = -0.08;
  p.rot.thighL.z = -0.055;
  p.rot.kneeL.x = 0.18;
  p.rot.footL.x = -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function baseAttackPose(base: RigPose, arms: ArmSet, which: keyof ArmSet): RigPose {
  const p = createPose();
  copyPose(p, base);
  applyArm(p, 'R', arms[which]);
  const lKey = which.replace(/R$/, 'L') as keyof ArmSet;
  applyArm(p, 'L', arms[lKey]);
  return p;
}

function buildRightWindup(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'rWindR');
  p.spine.y = 0.3;
  p.spine.x = -0.02;
  p.chest.y = 0.36;
  p.chest.x = -0.04;
  p.neck.y = -0.42;
  p.head.y = -0.32;
  p.rot.thighR.x += 0.18;
  p.rot.kneeR.x += 0.12;
  p.rot.thighL.x += -0.06;
  p.hipsOffset.z += -0.04;
  p.hipsOffset.y += -0.02;
  p.shieldPos.x += -0.04;
  p.shieldPos.y += 0.03;
  p.shieldPos.z += 0.02;
  p.shieldRot.z += -0.08;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildRightStrike(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'rStrikeR');
  p.spine.y = -0.34;
  p.spine.x = 0.22;
  p.chest.y = -0.34;
  p.chest.x = 0.12;
  p.neck.y = 0.4;
  p.head.y = 0.28;
  p.head.x = 0.08;
  p.rot.thighR.x += -0.22;
  p.rot.kneeR.x += 0.24;
  p.rot.thighL.x += 0.16;
  p.rot.kneeL.x += 0.08;
  p.hipsOffset.z += 0.07;
  p.hipsOffset.y += -0.04;
  p.shieldPos.x += -0.2;
  p.shieldPos.y += -0.02;
  p.shieldRot.z += -0.28;
  p.shieldRot.y += -0.12;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildLeftWindup(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'lWindR');
  p.spine.y = -0.3;
  p.spine.x = 0.02;
  p.chest.y = -0.4;
  p.neck.y = 0.42;
  p.head.y = 0.3;
  p.rot.thighR.x += -0.1;
  p.rot.thighL.x += 0.14;
  p.rot.kneeL.x += 0.12;
  p.hipsOffset.z += -0.03;
  p.shieldPos.x += -0.22;
  p.shieldPos.y += 0.06;
  p.shieldRot.z += 0.26;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildLeftStrike(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'lStrikeR');
  p.spine.y = 0.12;
  p.spine.x = 0.22;
  p.chest.y = 0.15;
  p.neck.y = -0.1;
  p.head.y = -0.1;
  p.head.x = 0.06;
  p.rot.thighR.x += 0.16;
  p.rot.kneeR.x += 0.1;
  p.rot.thighL.x += -0.2;
  p.rot.kneeL.x += 0.18;
  p.hipsOffset.z += 0.07;
  p.hipsOffset.y += -0.04;
  p.shieldPos.x += -0.05;
  p.shieldPos.z += 0.02;
  p.shieldRot.z += 0.06;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildOverheadWindup(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'oWindR');
  p.spine.x = -0.14;
  p.spine.y = 0.05;
  p.chest.x = -0.08;
  p.neck.x = 0.08;
  p.head.x = 0.12;
  p.rot.thighR.x += 0.12;
  p.rot.kneeR.x += 0.2;
  p.rot.thighL.x += 0.1;
  p.rot.kneeL.x += 0.16;
  p.hipsOffset.y += -0.05;
  p.shieldPos.y += 0.2;
  p.shieldPos.x += 0.02;
  p.shieldRot.x += 0.15;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildOverheadStrike(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'oStrikeR');
  p.spine.x = 0.34;
  p.spine.y = 0.02;
  p.chest.x = 0.2;
  p.neck.x = -0.15;
  p.head.x = 0.1;
  p.rot.thighR.x += -0.24;
  p.rot.kneeR.x += 0.3;
  p.rot.thighL.x += 0.2;
  p.rot.kneeL.x += 0.12;
  p.hipsOffset.z += 0.1;
  p.hipsOffset.y += -0.06;
  p.shieldPos.y += -0.06;
  p.shieldPos.z += 0.04;
  p.shieldRot.x += 0.1;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildThrustWindup(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'tWindR');
  p.spine.y = 0.4;
  p.spine.x = 0.05;
  p.chest.y = 0.3;
  p.neck.y = -0.5;
  p.head.y = -0.3;
  p.rot.thighR.x += 0.16;
  p.rot.kneeR.x += 0.16;
  p.rot.thighL.x += -0.12;
  p.rot.kneeL.x += 0.08;
  p.hipsOffset.z += -0.05;
  p.shieldPos.z += 0.04;
  p.shieldPos.x += -0.06;
  p.shieldRot.y += -0.1;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildThrustStrike(base: RigPose, arms: ArmSet): RigPose {
  const p = baseAttackPose(base, arms, 'tStrikeR');
  p.spine.y = -0.25;
  p.spine.x = 0.22;
  p.chest.y = -0.2;
  p.chest.x = 0.1;
  p.neck.y = 0.3;
  p.head.y = 0.2;
  p.rot.thighR.x += -0.32;
  p.rot.kneeR.x += 0.2;
  p.rot.thighL.x += 0.22;
  p.rot.kneeL.x += 0.16;
  p.hipsOffset.z += 0.06;
  p.hipsOffset.y += -0.05;
  p.shieldPos.x += -0.2;
  p.shieldPos.z += -0.03;
  p.shieldRot.y += 0.15;
  p.footR.x += -(p.rot.thighR.x + p.rot.kneeR.x);
  p.footL.x += -(p.rot.thighL.x + p.rot.kneeL.x);
  return p;
}

function buildGuardPose(dir: GuardDir, out: RigPose): void {
  copyPose(out, createScratchGuard());
  const p = out;
  if (dir === 'right') {
    p.shieldPos.x = 0;
    p.shieldPos.y = 0;
    p.shieldPos.z = 0;
    p.shieldRot.x = -0.6;
    p.shieldRot.y = 0.45;
    p.shieldRot.z = -0.2;
    p.spine.y = 0.26;
    p.chest.y = 0.2;
    p.neck.y = -0.3;
    p.head.y = -0.16;
    p.shoulderR.set(-1.05, 0.1, 0.6);
    p.elbowR.set(-1.3, 0, 0);
    p.handR.set(0.8, 0, -0.25);
    p.shoulderL.set(-1.15, 0.35, 0.55);
    p.elbowL.set(-1.5, 0, 0.1);
    p.handL.set(0.2, 0, 0.35);
    p.thighR.set(-0.04, 0, 0);
    p.kneeR.x = 0.18;
    p.thighL.x = -0.06;
    p.kneeL.x = 0.16;
  } else if (dir === 'left') {
    p.shieldPos.x = 0;
    p.shieldPos.y = 0;
    p.shieldPos.z = 0;
    p.shieldRot.x = -0.6;
    p.shieldRot.y = 0.15;
    p.shieldRot.z = 0.18;
    p.spine.y = -0.28;
    p.chest.y = -0.22;
    p.neck.y = 0.32;
    p.head.y = 0.16;
    p.shoulderR.set(-0.85, -0.15, 0.72);
    p.elbowR.set(-1.05, 0, 0);
    p.handR.set(0.7, 0, 0.15);
    p.shoulderL.set(-1.3, -0.35, -0.35);
    p.elbowL.set(-1.25, 0, 0.05);
    p.handL.set(0.2, 0, 0.1);
    p.thighR.x = -0.06;
    p.kneeR.x = 0.16;
    p.thighL.x = -0.04;
    p.kneeL.x = 0.18;
  } else if (dir === 'overhead') {
    p.shieldPos.x = 0;
    p.shieldPos.y = 0;
    p.shieldPos.z = 0;
    p.shieldRot.x = -0.95;
    p.shieldRot.y = 0.1;
    p.shieldRot.z = -0.05;
    p.spine.x = -0.06;
    p.spine.y = 0.04;
    p.chest.x = -0.04;
    p.neck.x = 0.06;
    p.head.x = 0.1;
    p.shoulderR.set(-2.05, 0, 0.4);
    p.elbowR.set(-1.45, 0, 0);
    p.handR.set(0.5, 0, -0.2);
    p.shoulderL.set(-2.3, 0, -0.15);
    p.elbowL.set(-1.55, 0, 0);
    p.handL.set(-0.25, 0, 0);
    p.thighR.x = -0.05;
    p.kneeR.x = 0.2;
    p.thighL.x = -0.05;
    p.kneeL.x = 0.2;
    p.hipsOffset.y = -0.03;
  } else {
    p.shieldPos.x = 0;
    p.shieldPos.y = 0;
    p.shieldPos.z = 0;
    p.shieldRot.x = -0.7;
    p.shieldRot.y = 0.2;
    p.shieldRot.z = 0.05;
    p.spine.y = 0.12;
    p.chest.y = 0.06;
    p.neck.y = -0.16;
    p.shoulderR.set(-0.9, 0, 0.32);
    p.elbowR.set(-1.35, 0, 0);
    p.handR.set(0.55, 0, -0.1);
    p.shoulderL.set(-1.25, 0.15, -0.1);
    p.elbowL.set(-1.05, 0, 0.08);
    p.handL.set(0.15, 0, 0.1);
    p.thighR.x = -0.08;
    p.kneeR.x = 0.18;
    p.thighL.x = -0.02;
    p.kneeL.x = 0.14;
    p.hipsOffset.y = -0.02;
  }
  p.spine.x += 0.05;
  p.chest.x += 0.03;
}

let guardScratch: RigPose | null = null;
function createScratchGuard(): RigPose {
  if (!guardScratch) {
    guardScratch = createPose();
    guardScratch.spine.x = 0.04;
    guardScratch.chest.x = 0.02;
  }
  return guardScratch;
}

/** How strongly an action pose overrides locomotion across its lifetime. */
function actionWeightCurve(k: number, action: RigAction): number {
  switch (action) {
    case 'hit':
      return 1;
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

/** Lateral leg swing for strafing (positive = leg lifts outward) . */
function railSide(phase: number, strafe01: number): number {
  const dir = Math.sign(strafe01) || 1;
  const sinp = Math.sin(phase);
  return (dir > 0 ? sinp : -sinp) > 0 ? Math.max(0, (dir > 0 ? sinp : -sinp)) : 0;
}
