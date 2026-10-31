import * as THREE from 'three';

/** Deterministic 32-bit PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hash a string into a 32-bit seed. */
export function hashString(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInOutCubic = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};
export const damp = (current: number, target: number, lambda: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-lambda * dt));
export const randRange = (rng: () => number, min: number, max: number): number => min + (max - min) * rng();
export const pick = <T>(rng: () => number, arr: readonly T[]): T => arr[Math.floor(rng() * arr.length) % arr.length];

export function normalizeAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

/** Shortest signed difference from angle a to angle b. */
export function angleDelta(a: number, b: number): number {
  return normalizeAngle(b - a);
}

export function dampAngle(current: number, target: number, lambda: number, dt: number): number {
  return current + angleDelta(current, target) * (1 - Math.exp(-lambda * dt));
}

export function turnToward(current: number, target: number, maxStep: number): number {
  const d = angleDelta(current, target);
  if (Math.abs(d) <= maxStep) return target;
  return current + Math.sign(d) * maxStep;
}

/** World-space forward vector for a yaw where local +Z is forward. */
export function forwardFromYaw(yaw: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(yaw), 0, Math.cos(yaw));
}

/** Yaw for a direction where local +Z is forward. */
export function yawFromDirection(x: number, z: number): number {
  return Math.atan2(x, z);
}

export function yawTo(from: { x: number; z: number }, to: { x: number; z: number }): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

export function distance2D(a: { x: number; z: number }, b: { x: number; z: number }): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Signed angle offset (radians) of `to` relative to a forward yaw. Positive = left. */
export function bearingFromYaw(origin: THREE.Vector3, yaw: number, to: THREE.Vector3): number {
  const fwd = forwardFromYaw(yaw);
  const dx = to.x - origin.x;
  const dz = to.z - origin.z;
  const len = Math.hypot(dx, dz) || 1e-6;
  const fx = fwd.x;
  const fz = fwd.z;
  const dot = (dx * fx + dz * fz) / len;
  const cross = fx * dz - fz * dx;
  return Math.atan2(-cross, dot);
}

/** Direction to guard (left/right/overhead/thrust) from an attack direction vector. */
export function guardDirFromAttack(dir: AttackDir): GuardDir {
  return dir;
}

/** Convert a mouse/input flick into an attack direction. */
export function dirFromVector(x: number, y: number): AttackDir {
  if (Math.abs(x) > Math.abs(y)) return x < 0 ? 'left' : 'right';
  return y < 0 ? 'overhead' : 'thrust';
}

/** Format a damage number like Warband's log. */
export function fmt(n: number): string {
  return String(Math.max(0, Math.round(n)));
}

/** Colour constants. */
export const COLORS = {
  blood: 0x7d1414,
  bloodDark: 0x4d0b0b,
  spark: 0xffd9a0,
  dust: 0xcbb58f,
  gold: 0xc9a24a,
  bronze: 0xb08d57,
};

/** Read-only shared temp vectors (never store references to these). */
export const tmpV1 = new THREE.Vector3();
export const tmpV2 = new THREE.Vector3();
export const tmpV3 = new THREE.Vector3();
export const tmpQ1 = new THREE.Quaternion();

/** Convert hex to css. */
export function hexCss(hex: number): string {
  return '#' + hex.toString(16).padStart(6, '0');
}

export function seededShuffle<T>(rng: () => number, arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function formatNumber(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}
