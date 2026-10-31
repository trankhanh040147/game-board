/**
 * Skeleton definition shared by the model builder and the animator.
 *
 * All values are in metres for a 1.80 m fighter (7.3 heads) before the
 * appearance `build` scale is applied to the root. Character faces +Z.
 * Joint offsets are local to the parent joint.
 */

export const SKELETON = {
  hips: [0, 0.99, 0],
  spine: [0, 0.105, 0],
  chest: [0, 0.205, 0],
  neck: [0, 0.215, -0.005],
  head: [0, 0.075, 0],

  shoulderR: [0.185, 0.17, 0],
  elbowR: [0, -0.285, 0],
  handR: [0, -0.255, 0],

  shoulderL: [-0.185, 0.17, 0],
  elbowL: [0, -0.285, 0],
  handL: [0, -0.255, 0],

  thighR: [0.105, -0.035, 0],
  kneeR: [0, -0.44, 0],
  footR: [0, -0.425, 0],

  thighL: [-0.105, -0.035, 0],
  kneeL: [0, -0.44, 0],
  footL: [0, -0.425, 0],

  cape: [0, 0.155, -0.135],
} as const;

export type JointName = keyof typeof SKELETON;

export const BODY_HEIGHT = 1.8;
/** Head height used for the 7.3-head proportion. */
export const HEAD_HEIGHT = BODY_HEIGHT / 7.3;

/** Order used to reset / apply poses (parents before children is not required here). */
export const POSE_JOINTS = [
  'spine', 'chest', 'neck', 'head',
  'shoulderR', 'elbowR', 'handR',
  'shoulderL', 'elbowL', 'handL',
  'thighR', 'kneeR', 'footR',
  'thighL', 'kneeL', 'footL',
  'cape',
] as const;

export type PoseJoint = (typeof POSE_JOINTS)[number];

export interface Vec3 {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return {
    x, y, z,
    set(px: number, py: number, pz: number): void {
      this.x = px;
      this.y = py;
      this.z = pz;
    },
  };
}

export type JointRotations = Record<PoseJoint, Vec3>;

/**
 * Rotation state for every joint. Joint rotations are available both as
 * `pose.rot.spine` and as the shorthand `pose.spine` (same object references).
 */
export interface RigPose extends JointRotations {
  /** Euler rotations (radians) per joint. */
  rot: JointRotations;
  /** Extra offsets applied to the hips joint in body space. */
  hipsOffset: Vec3;
  /** Whole-body tilt (used for death, dodges, roll). */
  bodyRot: Vec3;
  bodyPos: Vec3;
  /** Shield position relative to the chest bone. */
  shieldPos: Vec3;
  /** Shield orientation relative to the chest bone. */
  shieldRot: Vec3;
}

export function createPose(): RigPose {
  const rot = {} as JointRotations;
  for (const k of POSE_JOINTS) rot[k] = vec3();
  const pose = {
    rot,
    ...rot,
    hipsOffset: vec3(),
    bodyRot: vec3(),
    bodyPos: vec3(),
    shieldPos: vec3(),
    shieldRot: vec3(),
  } as unknown as RigPose;
  return pose;
}

export function resetPose(p: RigPose): void {
  for (const k of POSE_JOINTS) {
    const r = p.rot[k];
    r.x = 0;
    r.y = 0;
    r.z = 0;
  }
  p.hipsOffset.x = 0;
  p.hipsOffset.y = 0;
  p.hipsOffset.z = 0;
  p.bodyRot.x = 0;
  p.bodyRot.y = 0;
  p.bodyRot.z = 0;
  p.bodyPos.x = 0;
  p.bodyPos.y = 0;
  p.bodyPos.z = 0;
  p.shieldPos.x = 0;
  p.shieldPos.y = 0;
  p.shieldPos.z = 0;
  p.shieldRot.x = 0;
  p.shieldRot.y = 0;
  p.shieldRot.z = 0;
}

export function copyPose(dst: RigPose, src: RigPose): void {
  for (const k of POSE_JOINTS) {
    const d = dst.rot[k];
    const s = src.rot[k];
    d.x = s.x;
    d.y = s.y;
    d.z = s.z;
  }
  dst.hipsOffset.x = src.hipsOffset.x;
  dst.hipsOffset.y = src.hipsOffset.y;
  dst.hipsOffset.z = src.hipsOffset.z;
  dst.bodyRot.x = src.bodyRot.x;
  dst.bodyRot.y = src.bodyRot.y;
  dst.bodyRot.z = src.bodyRot.z;
  dst.bodyPos.x = src.bodyPos.x;
  dst.bodyPos.y = src.bodyPos.y;
  dst.bodyPos.z = src.bodyPos.z;
  dst.shieldPos.x = src.shieldPos.x;
  dst.shieldPos.y = src.shieldPos.y;
  dst.shieldPos.z = src.shieldPos.z;
  dst.shieldRot.x = src.shieldRot.x;
  dst.shieldRot.y = src.shieldRot.y;
  dst.shieldRot.z = src.shieldRot.z;
}

/** Copy/add helper for additive layers. */
export function addPose(dst: RigPose, src: RigPose, weight = 1): void {
  for (const k of POSE_JOINTS) {
    const d = dst.rot[k];
    const s = src.rot[k];
    d.x += s.x * weight;
    d.y += s.y * weight;
    d.z += s.z * weight;
  }
  dst.hipsOffset.x += src.hipsOffset.x * weight;
  dst.hipsOffset.y += src.hipsOffset.y * weight;
  dst.hipsOffset.z += src.hipsOffset.z * weight;
  dst.bodyRot.x += src.bodyRot.x * weight;
  dst.bodyRot.y += src.bodyRot.y * weight;
  dst.bodyRot.z += src.bodyRot.z * weight;
  dst.bodyPos.x += src.bodyPos.x * weight;
  dst.bodyPos.y += src.bodyPos.y * weight;
  dst.bodyPos.z += src.bodyPos.z * weight;
  dst.shieldPos.x += src.shieldPos.x * weight;
  dst.shieldPos.y += src.shieldPos.y * weight;
  dst.shieldPos.z += src.shieldPos.z * weight;
  dst.shieldRot.x += src.shieldRot.x * weight;
  dst.shieldRot.y += src.shieldRot.y * weight;
  dst.shieldRot.z += src.shieldRot.z * weight;
}

/** Blend `src` into `dst` for the given joints. */
export function blendJoints(dst: RigPose, src: RigPose, weight: number, joints: readonly PoseJoint[]): void {
  if (weight <= 0) return;
  const w = Math.min(1, weight);
  for (const k of joints) {
    const d = dst.rot[k];
    const s = src.rot[k];
    d.x += (s.x - d.x) * w;
    d.y += (s.y - d.y) * w;
    d.z += (s.z - d.z) * w;
  }
}

/** Blend the whole pose (including root offsets). */
export function lerpPose(dst: RigPose, a: RigPose, b: RigPose, t: number): void {
  const k = Math.min(1, Math.max(0, t));
  for (const j of POSE_JOINTS) {
    const d = dst.rot[j];
    const p = a.rot[j];
    const q = b.rot[j];
    d.x = p.x + (q.x - p.x) * k;
    d.y = p.y + (q.y - p.y) * k;
    d.z = p.z + (q.z - p.z) * k;
  }
  dst.hipsOffset.x = a.hipsOffset.x + (b.hipsOffset.x - a.hipsOffset.x) * k;
  dst.hipsOffset.y = a.hipsOffset.y + (b.hipsOffset.y - a.hipsOffset.y) * k;
  dst.hipsOffset.z = a.hipsOffset.z + (b.hipsOffset.z - a.hipsOffset.z) * k;
  dst.bodyRot.x = a.bodyRot.x + (b.bodyRot.x - a.bodyRot.x) * k;
  dst.bodyRot.y = a.bodyRot.y + (b.bodyRot.y - a.bodyRot.y) * k;
  dst.bodyRot.z = a.bodyRot.z + (b.bodyRot.z - a.bodyRot.z) * k;
  dst.bodyPos.x = a.bodyPos.x + (b.bodyPos.x - a.bodyPos.x) * k;
  dst.bodyPos.y = a.bodyPos.y + (b.bodyPos.y - a.bodyPos.y) * k;
  dst.bodyPos.z = a.bodyPos.z + (b.bodyPos.z - a.bodyPos.z) * k;
  dst.shieldPos.x = a.shieldPos.x + (b.shieldPos.x - a.shieldPos.x) * k;
  dst.shieldPos.y = a.shieldPos.y + (b.shieldPos.y - a.shieldPos.y) * k;
  dst.shieldPos.z = a.shieldPos.z + (b.shieldPos.z - a.shieldPos.z) * k;
  dst.shieldRot.x = a.shieldRot.x + (b.shieldRot.x - a.shieldRot.x) * k;
  dst.shieldRot.y = a.shieldRot.y + (b.shieldRot.y - a.shieldRot.y) * k;
  dst.shieldRot.z = a.shieldRot.z + (b.shieldRot.z - a.shieldRot.z) * k;
}
