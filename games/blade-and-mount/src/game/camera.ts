import * as THREE from 'three';
import type { Arena, Settings } from '../core/types';
import { clamp, damp } from '../core/utils';

const _pivot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _test = new THREE.Vector3();
let _blockers: THREE.Vector3[] = [];

export class GameCamera {
  yaw = Math.PI;
  pitch = 0.08;
  distance: number;
  targetDistance: number;
  fov: number;
  private baseFov: number;
  private arena: Arena;
  private shake = 0;
  private time = 0;
  private currentPos = new THREE.Vector3();
  private currentLook = new THREE.Vector3();
  private finalPos = new THREE.Vector3();
  private finalLook = new THREE.Vector3();
  private initialized = false;
  private orbitAngle = 0;
  private mode: 'follow' | 'orbit' | 'fixed' | 'dead' = 'follow';
  private orbitCenter = new THREE.Vector3();
  private fixedPos = new THREE.Vector3();
  private fixedLook = new THREE.Vector3();
  private sprintBlend = 0;
  private collisionDistance = 3.8;

  constructor(arena: Arena, settings: Settings) {
    this.arena = arena;
    this.baseFov = settings.fov;
    this.fov = settings.fov;
    this.distance = 3.8;
    this.targetDistance = 3.8;
    this.yaw = Math.PI;
  }

  applySettings(settings: Settings): void {
    this.baseFov = settings.fov;
  }

  look(dx: number, dy: number, sensitivity: number, invertY: boolean): void {
    const s = 0.0023 * sensitivity;
    this.yaw -= dx * s;
    this.pitch += (invertY ? dy : -dy) * s;
    this.pitch = clamp(this.pitch, -0.92, 0.66);
  }

  zoom(delta: number): void {
    this.targetDistance = clamp(this.targetDistance + delta * 0.45, 1.8, 5.6);
  }

  addShake(amount: number): void {
    this.shake = Math.min(1.2, this.shake + amount);
  }

  setFollow(): void {
    this.mode = 'follow';
  }

  setOrbit(center: THREE.Vector3, angle = 0): void {
    this.mode = 'orbit';
    this.orbitCenter.copy(center);
    this.orbitAngle = angle;
  }

  setFixed(pos: THREE.Vector3, look: THREE.Vector3): void {
    this.mode = 'fixed';
    this.fixedPos.copy(pos);
    this.fixedLook.copy(look);
  }

  setDead(): void {
    this.mode = 'dead';
    this.orbitAngle = 0;
  }

  private collide(distance: number, pivot: THREE.Vector3, lookDir: THREE.Vector3, right: THREE.Vector3): number {
    const shoulder = 0.62;
    for (let i = 0; i < 14; i++) {
      const d = distance * (1 - i / 14);
      _test.copy(pivot).addScaledVector(lookDir, -d).addScaledVector(right, shoulder);
      if (this.validCamera(_test) && !this.segmentBlocked(pivot, _test)) return d;
    }
    return -1;
  }

  /** True when the line from the player to the camera passes through a rock/prop. */
  private segmentBlocked(from: THREE.Vector3, to: THREE.Vector3): boolean {
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const a = dx * dx + dz * dz;
    if (a < 1e-6) return false;
    for (const o of this.arena.obstacles) {
      const r = o.r + 0.32;
      const fx = from.x - o.x;
      const fz = from.z - o.z;
      const b = 2 * (fx * dx + fz * dz);
      const c = fx * fx + fz * fz - r * r;
      if (c <= 0) return true;
      const disc = b * b - 4 * a * c;
      if (disc < 0) continue;
      const t = (-b - Math.sqrt(disc)) / (2 * a);
      if (t > 0.02 && t < 0.98) return true;
    }
    return false;
  }

  private blockedByFighter(p: THREE.Vector3): boolean {
    for (const b of _blockers) {
      const dx = p.x - b.x;
      const dz = p.z - b.z;
      if (dx * dx + dz * dz < 0.8 * 0.8 && p.y < b.y + 1.05) return true;
    }
    return false;
  }

  private validCamera(p: THREE.Vector3): boolean {
    const b = this.arena.bounds;
    const m = 0.45;
    if (p.x < b.minX + m || p.x > b.maxX - m || p.z < b.minZ + m || p.z > b.maxZ - m) return false;
    for (const o of this.arena.obstacles) {
      const dx = p.x - o.x;
      const dz = p.z - o.z;
      if (dx * dx + dz * dz < (o.r + 0.45) * (o.r + 0.45)) return false;
    }
    return p.y > 0.35;
  }

  update(dt: number, targetPos: THREE.Vector3, opts: { sprint?: boolean; moving?: boolean; blockers?: THREE.Vector3[] } = {}): void {
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.4);
    this.distance = damp(this.distance, this.targetDistance, 8, dt);
    this.sprintBlend = damp(this.sprintBlend, opts.sprint ? 1 : 0, 6, dt);
    const targetFov = this.baseFov + this.sprintBlend * 5;

    if (this.mode === 'fixed') {
      _camPos.copy(this.fixedPos);
      _look.copy(this.fixedLook);
      this.currentPos.lerp(_camPos, this.initialized ? 1 - Math.exp(-9 * dt) : 1);
      this.currentLook.lerp(_look, this.initialized ? 1 - Math.exp(-10 * dt) : 1);
    } else if (this.mode === 'orbit' || this.mode === 'dead') {
      this.orbitAngle += dt * (this.mode === 'dead' ? 0.18 : 0.1);
      const radius = this.mode === 'dead' ? 10.5 : 13;
      const height = this.mode === 'dead' ? 4.6 : 7.5;
      const center = this.mode === 'dead' ? targetPos : this.orbitCenter;
      _camPos.set(
        center.x + Math.sin(this.orbitAngle) * radius,
        height,
        center.z + Math.cos(this.orbitAngle) * radius,
      );
      _look.set(center.x, this.mode === 'dead' ? 0.6 : 2.4, center.z);
      this.currentPos.lerp(_camPos, this.initialized ? 1 - Math.exp(-3.4 * dt) : 1);
      this.currentLook.lerp(_look, this.initialized ? 1 - Math.exp(-4 * dt) : 1);
    } else {
      const cp = Math.cos(this.pitch);
      _dir.set(Math.sin(this.yaw) * cp, Math.sin(this.pitch), Math.cos(this.yaw) * cp);
      _right.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      _pivot.copy(targetPos);
      _pivot.y += 1.58;
      _blockers = opts.blockers ?? [];
      let dist = this.collide(this.distance, _pivot, _dir, _right);
      let overhead = dist < 0;
      if (dist < 0) dist = 1.15;
      // Asymmetric smoothing avoids camera pops near walls while still pulling in quickly.
      const smoothK = dist < this.collisionDistance ? 30 : 8;
      this.collisionDistance = damp(this.collisionDistance, dist, smoothK, dt);
      dist = this.collisionDistance;
      _camPos.copy(_pivot).addScaledVector(_dir, -dist).addScaledVector(_right, 0.62);
      _camPos.y = Math.max(0.4, _camPos.y + 0.2);
      _look.copy(_pivot).addScaledVector(_dir, 5.2).addScaledVector(_right, 0.18);
      _look.y += 0.28;
      // Last-resort fallback: if the shoulder camera would sit inside a rock/wall,
      // lift it above the player instead of showing the inside of geometry.
      if (!overhead && !this.validCamera(_camPos)) overhead = true;
      if (overhead) {
        _camPos.copy(_pivot).addScaledVector(_right, 0.45);
        _camPos.y = _pivot.y + 3.4;
        _camPos.addScaledVector(_dir, -0.9);
        _look.copy(_pivot);
        _look.y += 0.15;
      }
      if (this.initialized) {
        const lambda = 20;
        this.currentPos.lerp(_camPos, 1 - Math.exp(-lambda * dt));
        this.currentLook.lerp(_look, 1 - Math.exp(-lambda * dt));
      } else {
        this.currentPos.copy(_camPos);
        this.currentLook.copy(_look);
        this.initialized = true;
      }
    }

    // Shake offset
    const s = this.shake * this.shake;
    const t = this.time * 38;
    const sx = Math.sin(t * 1.13) * 0.055 * s;
    const sy = Math.sin(t * 1.71 + 1.3) * 0.045 * s;
    const sz = Math.sin(t * 0.97 + 2.2) * 0.05 * s;

    this.finalPos.set(
      this.currentPos.x + _right.x * sx,
      this.currentPos.y + sy,
      this.currentPos.z + _right.z * sx + sz,
    );
    this.finalLook.copy(this.currentLook);
    this.finalLook.x += sx * 0.8;
    this.finalLook.y += sy * 0.8;

    this.fov = damp(this.fov, targetFov, 7, dt);
  }

  /** Push the final transform into the engine camera. */
  applyTo(camera: THREE.PerspectiveCamera): void {
    camera.position.copy(this.finalPos);
    camera.lookAt(this.finalLook);
    if (Math.abs(camera.fov - this.fov) > 0.01) {
      camera.fov = this.fov;
      camera.updateProjectionMatrix();
    }
    // small roll on impact
    camera.rotation.z += Math.sin(this.time * 24) * this.shake * 0.014;
  }

  get position(): THREE.Vector3 { return this.finalPos; }
  get lookTarget(): THREE.Vector3 { return this.currentLook; }

  /** For the menu / cinematics: direct camera control. */
  setCinematic(pos: THREE.Vector3, look: THREE.Vector3): void {
    this.currentPos.copy(pos);
    this.currentLook.copy(look);
    this.finalPos.copy(pos);
    this.finalLook.copy(look);
    this.initialized = true;
  }
}
