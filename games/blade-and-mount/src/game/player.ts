import * as THREE from 'three';
import type { AttackDir, GuardDir, Intent, Settings, TargetView } from '../core/types';
import { COMBAT } from '../core/config';
import type { Input } from '../core/input';
import type { Fighter } from './fighter';
import type { GameCamera } from './camera';
import type { CombatOverlay } from './overlay';
import { angleDelta, dirFromVector, forwardFromYaw, yawTo } from '../core/utils';

const _to = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();

export class PlayerController {
  private input: Input;
  private camera: GameCamera;
  private overlay: CombatOverlay;
  private getSettings: () => Settings;
  lockedId: number | null = null;
  private attackHeld = false;
  private blockHeld = false;
  private attackDir: AttackDir = 'right';
  private blockDir: GuardDir = 'overhead';
  private gestureX = 0;
  private gestureY = 0;
  private lastAttackDir: AttackDir = 'right';
  private lastBlockDir: GuardDir = 'overhead';
  private damageFlash = 0;

  constructor(input: Input, camera: GameCamera, overlay: CombatOverlay, getSettings: () => Settings) {
    this.input = input;
    this.camera = camera;
    this.overlay = overlay;
    this.getSettings = getSettings;
  }

  reset(): void {
    this.attackHeld = false;
    this.blockHeld = false;
    this.gestureX = 0;
    this.gestureY = 0;
    this.lockedId = null;
    this.overlay.setStance('idle', null);
    this.overlay.setLocked(false);
  }

  get lockedTarget(): number | null {
    return this.lockedId;
  }

  update(dt: number, player: Fighter, fighters: Fighter[]): Intent {
    const settings = this.getSettings();
    const intent: Intent = { moveX: 0, moveZ: 0, sprint: false, block: null };
    if (!player.alive) return intent;

    if (this.input.locked) {
      this.camera.look(this.input.lookX, this.input.lookY, settings.sensitivity, settings.invertY);
    }
    this.camera.zoom(this.input.zoomDelta);

    // Movement relative to camera yaw.
    const yaw = this.camera.yaw;
    forwardFromYaw(yaw, _fwd);
    _right.set(-Math.cos(yaw), 0, Math.sin(yaw));
    const mx = this.input.moveX;
    const mz = this.input.moveZ;
    let moveX = _right.x * mx + _fwd.x * mz;
    let moveZ = _right.z * mx + _fwd.z * mz;
    const len = Math.hypot(moveX, moveZ);
    if (len > 1) {
      moveX /= len;
      moveZ /= len;
    }
    intent.moveX = moveX;
    intent.moveZ = moveZ;
    intent.sprint = this.input.isDown('ShiftLeft') || this.input.isDown('ShiftRight');

    // Target lock.
    this.validateLock(fighters);
    if (this.input.locked && (this.input.wasPressed('KeyQ') || this.input.mmbClicked)) {
      this.toggleLock(player, fighters);
    }

    const locked = this.lockedId != null ? fighters.find((f) => f.id === this.lockedId && f.alive) ?? null : null;

    // Attack / block selection only when pointer is captured and game input is live.
    if (this.input.locked) {
      if (this.input.lmbClicked && !this.blockHeld) this.beginAttack();
      if (this.attackHeld) {
        this.gestureX += this.input.lookX;
        this.gestureY += this.input.lookY;
        const gestureMag = Math.hypot(this.gestureX, this.gestureY);
        if (gestureMag > 7) {
          this.attackDir = dirFromVector(this.gestureX, this.gestureY);
          this.gestureX = 0;
          this.gestureY = 0;
        }
        if (this.input.wasPressed('KeyA')) this.attackDir = 'left';
        if (this.input.wasPressed('KeyD')) this.attackDir = 'right';
        if (this.input.wasPressed('KeyW')) this.attackDir = 'overhead';
        if (this.input.wasPressed('KeyS')) this.attackDir = 'thrust';
        if (this.input.lmbReleasedThisFrame || !this.input.lmb) this.releaseAttack(intent);
        else if (this.input.lmb) {
          this.overlay.setStance('attack', this.attackDir);
        }
      }

      if (this.input.rmbClicked) this.beginBlock();
      if (this.blockHeld) {
        this.gestureX += this.input.lookX;
        this.gestureY += this.input.lookY;
        if (Math.hypot(this.gestureX, this.gestureY) > 7) {
          this.blockDir = dirFromVector(this.gestureX, this.gestureY);
          this.gestureX = 0;
          this.gestureY = 0;
        }
        if (this.input.wasPressed('KeyA')) this.blockDir = 'left';
        if (this.input.wasPressed('KeyD')) this.blockDir = 'right';
        if (this.input.wasPressed('KeyW')) this.blockDir = 'overhead';
        if (this.input.wasPressed('KeyS')) this.blockDir = 'thrust';
        if (this.input.rmbReleasedThisFrame || !this.input.rmb) {
          this.blockHeld = false;
          this.lastBlockDir = this.blockDir;
          this.overlay.setStance('idle', null);
        } else {
          intent.block = this.blockDir;
          this.overlay.setStance('block', this.blockDir);
        }
      }

      if (this.input.wasPressed('KeyF')) intent.kick = true;
      if (this.input.wasPressed('Space')) {
        const dodgeLen = Math.hypot(moveX, moveZ);
        if (dodgeLen > 0.1) intent.dodge = { x: moveX / dodgeLen, z: moveZ / dodgeLen };
        else intent.dodge = { x: -_fwd.x, z: -_fwd.z };
      }
    } else {
      this.attackHeld = false;
      this.blockHeld = false;
      this.overlay.setStance('idle', null);
    }

    // Face camera direction, or the locked/aim-assisted target.
    let faceYaw = yaw;
    if (locked) {
      faceYaw = yawTo(player.position, locked.position);
    } else {
      const assist = this.findAimAssist(player, fighters, yaw);
      if (assist) faceYaw = yawTo(player.position, assist.position);
    }
    intent.faceYaw = faceYaw;

    // Locked marker state.
    this.overlay.setLocked(this.lockedId !== null);

    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 2);
    void _to;
    return intent;
  }

  private beginAttack(): void {
    this.attackHeld = true;
    this.gestureX = 0;
    this.gestureY = 0;
    this.attackDir = this.lastAttackDir;
    this.overlay.setStance('attack', this.attackDir);
  }

  private releaseAttack(intent: Intent): void {
    this.attackHeld = false;
    this.lastAttackDir = this.attackDir;
    intent.attack = this.attackDir;
    this.overlay.setStance('idle', null);
  }

  private beginBlock(): void {
    this.blockHeld = true;
    this.attackHeld = false;
    this.blockDir = this.lastBlockDir;
    this.gestureX = 0;
    this.gestureY = 0;
    this.overlay.setStance('block', this.blockDir);
  }

  private validateLock(fighters: Fighter[]): void {
    if (this.lockedId == null) return;
    const target = fighters.find((f) => f.id === this.lockedId);
    if (!target || !target.alive) {
      this.lockedId = null;
      return;
    }
  }

  private toggleLock(player: Fighter, fighters: Fighter[]): void {
    if (this.lockedId != null) {
      this.lockedId = null;
      return;
    }
    const yaw = this.camera.yaw;
    let best: Fighter | null = null;
    let bestScore = Infinity;
    for (const f of fighters) {
      if (!f.alive || f === player) continue;
      if (f.team >= 0 && f.team === player.team) continue;
      const dx = f.position.x - player.position.x;
      const dz = f.position.z - player.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > COMBAT.lockOn.range) continue;
      const bearing = Math.abs(angleDelta(yaw, Math.atan2(dx, dz)));
      if (bearing > COMBAT.lockOn.cone) continue;
      const score = bearing * 4 + dist * 0.12;
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    this.lockedId = best?.id ?? null;
    if (best) this.camera.yaw = yawTo(player.position, best.position);
  }

  private findAimAssist(player: Fighter, fighters: Fighter[], yaw: number): Fighter | null {
    let best: Fighter | null = null;
    let bestScore = Infinity;
    for (const f of fighters) {
      if (!f.alive || f === player) continue;
      if (f.team >= 0 && f.team === player.team) continue;
      const dx = f.position.x - player.position.x;
      const dz = f.position.z - player.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > player.loadout.weapon.reach + 1.5) continue;
      const bearing = Math.abs(angleDelta(yaw, Math.atan2(dx, dz)));
      if (bearing > 0.32) continue;
      const score = bearing * 5 + dist * 0.1;
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  /** Screen-space target info for the UI nameplate. */
  getTargetView(
    fighters: Fighter[],
    player: Fighter,
    engineCamera: THREE.PerspectiveCamera,
    teamColorOf: (team: number) => string,
  ): TargetView | null {
    let selected: Fighter | null = null;
    let selectedScore = Infinity;
    const w = window.innerWidth;
    const h = window.innerHeight;
    for (const f of fighters) {
      if (!f.alive || f === player) continue;
      const enemy = f.team < 0 || f.team !== player.team;
      if (!enemy) continue;
      const dist = Math.hypot(f.position.x - player.position.x, f.position.z - player.position.z);
      if (dist > 20) continue;
      const pos = f.getChestPosition(new THREE.Vector3());
      pos.project(engineCamera);
      if (pos.z > 1 || pos.z < -1) continue;
      const sx = (pos.x * 0.5 + 0.5) * w;
      const sy = (-pos.y * 0.5 + 0.5) * h;
      if (sx < 0 || sx > w || sy < 0 || sy > h) continue;
      const centerDist = Math.hypot(sx - w / 2, sy - h / 2);
      const isLocked = this.lockedId === f.id;
      const score = isLocked ? -5000 : centerDist + dist * 2;
      if (score < selectedScore) {
        selectedScore = score;
        selected = f;
      }
    }
    if (!selected) return null;
    const chest = selected.getChestPosition(new THREE.Vector3());
    const head = selected.rig.getAnchor('head', new THREE.Vector3());
    head.project(engineCamera);
    const sx = (head.x * 0.5 + 0.5) * w;
    const sy = (-head.y * 0.5 + 0.5) * h;
    const centerDist = Math.hypot(sx - w / 2, sy - h / 2);
    const dist = Math.hypot(selected.position.x - player.position.x, selected.position.z - player.position.z);
    return {
      name: selected.name,
      hp: selected.hp,
      maxHp: selected.maxHp,
      distance: dist,
      screenX: sx,
      screenY: sy - 46,
      visible: sx > 20 && sx < w - 20 && sy > 20 && sy < h - 20,
      teamColor: selected.team >= 0 ? teamColorOf(selected.team) : '#d8c9a8',
      isLocked: this.lockedId === selected.id,
      isPlayerTeam: selected.team >= 0 && selected.team === player.team,
    };
  }
}
