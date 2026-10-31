import * as THREE from 'three';
import {
  COMBAT,
  attackStaminaCost,
  attackTiming,
  maxHpForLevel,
  damageScaleForLevel,
} from '../core/config';
import type {
  AIProfile,
  AIController,
  Arena,
  AttackDir,
  CharacterRig,
  FighterInfo,
  FighterState,
  GuardDir,
  HitInfo,
  Intent,
  Loadout,
  Quality,
  RigAction,
} from '../core/types';
import type { AttackTiming } from '../core/config';
import { createCharacterRig } from '../characters/rig';
import { createAppearance } from '../characters/appearance';
import type { Effects } from '../combat/effects';
import type { AudioAPI } from '../core/types';
import {
  angleDelta,
  clamp,
  damp,
  dampAngle,
  forwardFromYaw,
  turnToward,
  yawFromDirection,
} from '../core/utils';

export interface CombatEvent {
  type:
    | 'attack-start'
    | 'attack-swing'
    | 'hit'
    | 'block'
    | 'guard-break'
    | 'kill'
    | 'death'
    | 'kick'
    | 'dodge'
    | 'footstep'
    | 'spawn'
    | 'low-health';
  attacker: Fighter | null;
  defender: Fighter | null;
  info?: HitInfo;
  text?: string;
}

export interface FighterWorld {
  scene: THREE.Scene;
  arena: Arena;
  effects: Effects;
  audio: AudioAPI;
  rng: () => number;
  time: number;
  emit(event: CombatEvent): void;
}

export interface FighterConfig {
  id: number;
  name: string;
  team: number;
  isPlayer: boolean;
  loadout: Loadout;
  appearanceSeed: number;
  quality: Quality;
  aiProfile?: AIProfile;
  level?: number;
  maxHp?: number;
  damageScale?: number;
  spawn: { position: THREE.Vector3; yaw: number };
}

const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _local = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _box = new THREE.Vector3();

export class Fighter {
  readonly id: number;
  readonly name: string;
  readonly team: number;
  readonly isPlayer: boolean;
  readonly loadout: Loadout;
  readonly rig: CharacterRig;
  readonly position: THREE.Vector3;
  readonly velocity = new THREE.Vector3();
  yaw: number;
  hp: number;
  maxHp: number;
  stamina: number;
  maxStamina: number;
  alive = true;
  state: FighterState = 'spawn';
  stateTimer = 0.35;
  attackDir: AttackDir | null = null;
  attackTimer = 0;
  attackTiming: AttackTiming = { windup: 0.2, active: 0.1, recover: 0.3, total: 0.6 };
  guardDir: GuardDir | null = null;
  dodgeDir = new THREE.Vector3();
  dodgeElapsed = 0;
  swingPlayed = false;
  hitConsumed = false;
  wantsKick = false;
  kickCooldown = 0;
  dodgeCooldown = 0;
  actionLock = 0;
  lungeTimer = 0;
  lungeDir = new THREE.Vector3();
  staminaDelay = 0;
  ai: AIController | null = null;
  aiProfile: AIProfile | null = null;
  level = 1;
  damageScale = 1;
  radius = 0.42;
  kills = 0;
  damageDealt = 0;
  damageTaken = 0;
  blocks = 0;
  headshots = 0;
  lastDamageTime = -99;
  lastActionTime = -99;
  deadTime = 0;
  targeted = false;
  inCombat = false;
  private recentAttackers = new Map<number, number>();
  /** True while the fighter is inside a valid camera frame / active match. */
  active = true;
  private appearanceSeed: number;
  private footstepDist = 0;
  private pendingAttack: { dir: AttackDir; ttl: number } | null = null;
  private blockHeld = false;
  private dodgeInvulnerable = 0;
  private deathVariant = 0;
  private disposed = false;

  constructor(cfg: FighterConfig, world: FighterWorld) {
    this.id = cfg.id;
    this.name = cfg.name;
    this.team = cfg.team;
    this.isPlayer = cfg.isPlayer;
    this.loadout = cfg.loadout;
    this.appearanceSeed = cfg.appearanceSeed;
    this.level = cfg.level ?? 1;
    this.maxHp = cfg.maxHp ?? (cfg.isPlayer ? maxHpForLevel(this.level) : 82 + (cfg.aiProfile?.skill ?? 0.4) * 56);
    this.hp = this.maxHp;
    this.maxStamina = COMBAT.stamina;
    this.stamina = this.maxStamina;
    this.damageScale = cfg.damageScale ?? (cfg.isPlayer ? damageScaleForLevel(this.level) : 0.55 + (cfg.aiProfile?.skill ?? 0.4) * 0.22);
    this.yaw = cfg.spawn.yaw;
    this.state = 'spawn';
    this.stateTimer = 0.45;

    const appearance = createAppearance(cfg.appearanceSeed, cfg.loadout, cfg.loadout.color1, cfg.loadout.color2);
    this.rig = createCharacterRig({ loadout: cfg.loadout, appearance, quality: cfg.quality });
    this.rig.root.position.copy(cfg.spawn.position);
    this.rig.root.position.y = 0;
    this.rig.root.rotation.y = this.yaw;
    this.position = this.rig.root.position;
    world.scene.add(this.rig.root);

    if (cfg.aiProfile) {
      this.aiProfile = cfg.aiProfile;
      void cfg.aiProfile;
    }
  }

  attachAI(controller: AIController | null): void {
    this.ai = controller;
  }

  get armorBody(): number { return this.loadout.armor.body; }
  get armorHead(): number { return this.loadout.armor.head + this.loadout.helmet.armor; }
  get armorLegs(): number { return this.loadout.armor.legs; }

  canAct(): boolean {
    return this.alive && this.state !== 'attack' && this.state !== 'dodge' && this.state !== 'stagger' && this.actionLock <= 0;
  }

  canStartAttack(): boolean {
    return this.canAct() && this.state !== 'block' && this.stamina >= attackStaminaCost(this.loadout.weapon) * 0.5;
  }

  isInvulnerable(): boolean {
    return this.state === 'dodge' && this.dodgeInvulnerable > 0;
  }

  isAttackInHitWindow(): boolean {
    if (this.state !== 'attack' || this.hitConsumed) return false;
    const t = this.attackTimer;
    const start = this.attackTiming.windup + this.attackTiming.active * COMBAT.attack.hitWindowStart;
    const end = this.attackTiming.windup + this.attackTiming.active * COMBAT.attack.hitWindowEnd;
    return t >= start && t <= end;
  }

  markHitConsumed(): void {
    this.hitConsumed = true;
  }

  requestAttack(dir: AttackDir): void {
    if (!this.alive) return;
    if (!this.canAct()) {
      this.pendingAttack = { dir, ttl: 0.24 };
      return;
    }
    this.startAttack(dir);
  }

  private startAttack(dir: AttackDir): void {
    this.attackDir = dir;
    this.attackTimer = 0;
    this.attackTiming = attackTiming(this.loadout.weapon);
    this.swingPlayed = false;
    this.hitConsumed = false;
    this.state = 'attack';
    this.guardDir = null;
    this.blockHeld = false;
    this.pendingAttack = null;
    this.staminaDelay = COMBAT.staminaRegenDelay;
    this.stamina = Math.max(0, this.stamina - attackStaminaCost(this.loadout.weapon));
    this.velocity.multiplyScalar(0.35);
    this.rig.playAttack(dir, 1);
  }

  requestDodge(x: number, z: number): void {
    if (!this.alive || !this.canAct()) return;
    if (this.dodgeCooldown > 0 || this.stamina < COMBAT.dodge.stamina) return;
    if (this.state === 'attack') return;
    const len = Math.hypot(x, z);
    if (len < 1e-4) {
      forwardFromYaw(this.yaw, _fwd);
      this.dodgeDir.set(-_fwd.x, 0, -_fwd.z);
    } else {
      this.dodgeDir.set(x / len, 0, z / len);
    }
    this.state = 'dodge';
    this.stateTimer = COMBAT.dodge.duration;
    this.dodgeElapsed = 0;
    this.dodgeInvulnerable = COMBAT.dodge.iframes;
    this.dodgeCooldown = COMBAT.dodge.cooldown;
    this.stamina = Math.max(0, this.stamina - COMBAT.dodge.stamina);
    this.staminaDelay = COMBAT.staminaRegenDelay;
    this.attackDir = null;
    this.guardDir = null;
    this.rig.playAction('dodge', { dir: this.dodgeDir });
  }

  requestKick(): void {
    if (!this.alive || !this.canAct() || this.kickCooldown > 0 || this.stamina < COMBAT.kick.stamina) return;
    this.stamina = Math.max(0, this.stamina - COMBAT.kick.stamina);
    this.staminaDelay = COMBAT.staminaRegenDelay;
    this.kickCooldown = COMBAT.kick.cooldown;
    this.actionLock = 0.42;
    this.wantsKick = true;
    this.rig.playAction('kick');
  }

  setBlock(dir: GuardDir | null): void {
    if (!this.alive || !this.canAct()) {
      if (this.state === 'block' && this.stateTimer > 0) return;
      return;
    }
    if (dir) {
      if (this.state !== 'block') {
        this.state = 'block';
          }
      this.guardDir = dir;
      this.blockHeld = true;
    } else {
      this.blockHeld = false;
      if (this.state === 'block') this.state = 'idle';
      this.guardDir = null;
    }
  }

  /** Applies a resolved, unblocked hit. Returns true when this kills the fighter. */
  receiveHit(hit: HitInfo, world: FighterWorld): boolean {
    if (!this.alive) return false;
    this.hp = Math.max(0, this.hp - hit.damage);
    this.damageTaken += hit.damage;
    this.lastDamageTime = world.time;
    this.ai?.notifyDamaged?.(hit.attackerId, hit.attackDir);
    this.velocity.x += hit.direction.x * Math.min(4.2, 1.2 + hit.damage * 0.045);
    this.velocity.z += hit.direction.z * Math.min(4.2, 1.2 + hit.damage * 0.045);
    this.state = 'stagger';
    this.stateTimer = hit.zone === 'head' ? 0.52 : hit.damage > COMBAT.heavyHitThreshold ? 0.44 : 0.3;
    this.attackDir = null;
    this.attackTimer = 0;
    this.guardDir = null;
    this.dodgeInvulnerable = 0;
    this.rig.playAction('stagger', { dir: hit.direction });
    world.effects.bloodBurst(hit.point, hit.direction, hit.zone === 'head' ? 24 : 14);
    if (this.loadout.armor.body > 25) {
      world.effects.sparkBurst(hit.point, hit.direction, 3);
    }
    world.audio.play('hit-flesh', { pos: hit.point, volume: 0.8 });
    if (this.loadout.armor.body > 20) world.audio.play('hit-armor', { pos: hit.point, volume: 0.5 });

    if (this.hp <= 0) {
      this.die(hit, world);
      return true;
    }
    if (this.hp < this.maxHp * 0.28) {
      world.emit({ type: 'low-health', attacker: null, defender: this });
    }
    return false;
  }

  die(hit: HitInfo | null, world: FighterWorld): void {
    if (!this.alive) return;
    this.alive = false;
    this.state = 'dead';
    this.hp = 0;
    this.deadTime = 0;
    this.deathVariant = Math.floor(world.rng() * 3);
    this.attackDir = null;
    this.guardDir = null;
    this.rig.playAction('die', { variant: this.deathVariant, dir: hit?.direction });
    this.rig.setDead(true);
    if (hit) {
      world.effects.bloodBurst(hit.point, hit.direction, 26);
      world.effects.bloodDecal(this.position, 0.9 + world.rng() * 0.4);
    }
    world.audio.play('death', { pos: this.position, volume: 0.85 });
  }

  knockOut(world: FighterWorld): void {
    if (!this.alive) return;
    this.hp = 0;
    this.die(null, world);
  }

  spendStamina(amount: number): boolean {
    if (this.stamina < amount) {
      this.stamina = 0;
      return false;
    }
    this.stamina -= amount;
    return true;
  }

  breakGuard(): void {
    this.guardDir = null;
    this.blockHeld = false;
    this.state = 'stagger';
    this.stateTimer = COMBAT.guardBreakStagger;
    this.stamina = 0;
    this.rig.playAction('stagger', { variant: 1 });
  }

  /** Main per-frame simulation. `intent` may be from the player controller or the AI. */
  update(dt: number, intent: Intent, world: FighterWorld, separationForce?: THREE.Vector3): void {
    this.rig.root.position.y = 0;
    if (!this.alive) {
      this.deadTime += dt;
      this.velocity.multiplyScalar(Math.max(0, 1 - dt * 6));
      this.position.addScaledVector(this.velocity, dt * 0.3);
      this.rig.update(dt);
      return;
    }

    this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.actionLock = Math.max(0, this.actionLock - dt);
    this.staminaDelay = Math.max(0, this.staminaDelay - dt);
    if (this.pendingAttack) {
      this.pendingAttack.ttl -= dt;
      if (this.pendingAttack.ttl <= 0) this.pendingAttack = null;
    }

    if (this.staminaDelay <= 0 && this.state !== 'attack' && this.state !== 'dodge') {
      this.stamina = Math.min(this.maxStamina, this.stamina + COMBAT.staminaRegen * dt);
    }

    // Timers / states
    if (this.state === 'spawn') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        this.state = 'idle';
        this.rig.playAction('spawn');
      }
    } else if (this.state === 'stagger') {
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) this.state = 'idle';
    } else if (this.state === 'dodge') {
      this.stateTimer -= dt;
      this.dodgeElapsed += dt;
      this.dodgeInvulnerable = Math.max(0, this.dodgeInvulnerable - dt);
      if (this.stateTimer <= 0) this.state = 'idle';
    } else if (this.state === 'attack') {
      this.attackTimer += dt;
      if (!this.swingPlayed && this.attackTimer >= this.attackTiming.windup) {
        this.swingPlayed = true;
        forwardFromYaw(this.yaw, _fwd);
        this.velocity.x += _fwd.x * 0.45;
        this.velocity.z += _fwd.z * 0.45;
        this.lungeDir.copy(_fwd);
        this.lungeTimer = COMBAT.attack.lungeTime;
        world.audio.play(this.loadout.weapon.weight > 1.8 ? 'swing-heavy' : 'swing', {
          pos: this.position, volume: 0.55,
        });
        world.emit({ type: 'attack-swing', attacker: this, defender: null });
      }
      if (this.attackTimer >= this.attackTiming.total) {
        this.state = 'idle';
        this.attackDir = null;
        if (this.pendingAttack) {
          const dir = this.pendingAttack.dir;
          this.pendingAttack = null;
          if (this.canStartAttack()) this.startAttack(dir);
        }
      }
    }

    // Buffered request fire
    if (this.pendingAttack && this.canStartAttack()) {
      const dir = this.pendingAttack.dir;
      this.pendingAttack = null;
      this.startAttack(dir);
    }

    const canControl = this.state !== 'stagger' && this.state !== 'dodge' && this.actionLock <= 0;

    // Guarding: hold state from intent
    if (canControl && this.state !== 'attack') {
      if (intent.block) {
        if (this.state !== 'block') {
          this.state = 'block';
          this.staminaDelay = COMBAT.staminaRegenDelay;
        }
        this.guardDir = intent.block;
        this.blockHeld = true;
      } else if (this.state === 'block') {
        this.state = 'idle';
        this.guardDir = null;
        this.blockHeld = false;
      }
    }

    if (canControl && intent.attack) {
      this.requestAttack(intent.attack);
    }
    if (canControl && intent.kick) {
      this.requestKick();
    }
    if (canControl && intent.dodge) {
      this.requestDodge(intent.dodge.x, intent.dodge.z);
    }

    // Movement
    const moveLen = Math.hypot(intent.moveX, intent.moveZ);
    let desiredSpeed = 0;
    if (moveLen > 1e-3 && canControl) {
      const armorPenalty = 1 - clamp(this.loadout.armor.weight * 0.011, 0, 0.16);
      const weaponPenalty = 1 - clamp((this.loadout.weapon.weight - 1) * 0.025, 0, 0.1);
      const profileSpeed = this.aiProfile ? this.aiProfile.mobility : 1;
      const sprintMul = intent.sprint && this.stamina > 4 ? COMBAT.movement.sprint / COMBAT.movement.walk : 1;
      desiredSpeed = COMBAT.movement.walk * armorPenalty * weaponPenalty * profileSpeed * sprintMul;
      const moveX = intent.moveX / moveLen;
      const moveZ = intent.moveZ / moveLen;
      _desired.set(moveX * desiredSpeed, 0, moveZ * desiredSpeed);
    } else {
      _desired.set(0, 0, 0);
    }

    if (intent.sprint && moveLen > 0.1 && this.stamina > 0) {
      this.stamina = Math.max(0, this.stamina - COMBAT.sprintDrain * dt);
      this.staminaDelay = COMBAT.staminaRegenDelay;
    }

    if (this.state === 'dodge') {
      const speed = COMBAT.dodge.distance / COMBAT.dodge.duration;
      _desired.copy(this.dodgeDir).multiplyScalar(speed);
      this.velocity.copy(_desired);
    } else {
      let mult = 1;
      if (this.state === 'attack') mult = 0.28;
      else if (this.state === 'block') mult = 0.52;
      else if (this.state === 'stagger') mult = 0.0;
      const accel = COMBAT.movement.accel * dt;
      this.velocity.x = damp(this.velocity.x, _desired.x * mult, this.state === 'stagger' ? 9 : 12, dt);
      this.velocity.z = damp(this.velocity.z, _desired.z * mult, this.state === 'stagger' ? 9 : 12, dt);
      if (this.velocity.lengthSq() < 0.0004) this.velocity.set(0, 0, 0);
      void accel;
      // Strafe / backpedal modifiers
      if (moveLen > 1e-3 && canControl) {
        forwardFromYaw(this.yaw, _fwd);
        const along = (intent.moveX / moveLen) * _fwd.x + (intent.moveZ / moveLen) * _fwd.z;
        if (along < -0.2) this.velocity.multiplyScalar(COMBAT.movement.backFactor);
        else if (Math.abs(along) < 0.4) this.velocity.multiplyScalar(COMBAT.movement.strafeFactor);
      }
    }

    if (this.state === 'dodge') {
      this.position.addScaledVector(this.velocity, dt);
    } else {
      this.position.addScaledVector(this.velocity, dt);
    }

    if (this.state === 'attack' && this.lungeTimer > 0) {
      this.lungeTimer -= dt;
      this.position.addScaledVector(this.lungeDir, COMBAT.attack.lungeSpeed * dt);
    }
    if (separationForce) {
      this.position.addScaledVector(separationForce, dt);
    }
    this.position.y = 0;
    world.arena.clampPosition(this.position, this.radius);

    // Facing
    let desiredYaw = this.yaw;
    if (this.isPlayer) {
      desiredYaw = intent.faceYaw ?? this.yaw;
    } else if (intent.faceYaw !== undefined) {
      desiredYaw = intent.faceYaw;
    } else if (moveLen > 0.1 && !intent.block) {
      desiredYaw = yawFromDirection(intent.moveX, intent.moveZ);
    }
    const turnRate = this.state === 'attack' ? COMBAT.movement.turnRate * 0.6 : COMBAT.movement.turnRate;
    if (this.state !== 'stagger') {
      this.yaw = turnToward(this.yaw, desiredYaw, turnRate * dt);
    }
    this.rig.root.rotation.y = this.yaw;

    // Footstep dust + audio
    if (this.velocity.lengthSq() > 0.4 && this.state !== 'dodge') {
      const speed = this.velocity.length();
      this.footstepDist += speed * dt;
      if (this.footstepDist > (speed > 5.5 ? 1.65 : 2.0)) {
        this.footstepDist = 0;
        world.effects.dustPuff(_box.copy(this.position).setY(0.04), 2, 0.6);
        world.audio.play('footstep', { pos: this.position, volume: 0.28 });
      }
    }
    this.inCombat = this.lastDamageTime > world.time - 8;

    // Rig animation
    forwardFromYaw(this.yaw, _fwd);
    _right.set(_fwd.z, 0, -_fwd.x);
    const localStrafe = this.velocity.dot(_right);
    const localForward = this.velocity.dot(_fwd);
    this.rig.setMotion(this.velocity.length(), localStrafe, localForward);
    this.rig.setGuard(this.state === 'block' ? this.guardDir : null);
    this.rig.update(dt);
  }

  toInfo(out?: FighterInfo): FighterInfo {
    const info: FighterInfo = out ?? {
      id: 0, name: '', team: -1, isPlayer: false, position: new THREE.Vector3(),
      velocity: new THREE.Vector3(), facing: 0, hp: 0, maxHp: 0, stamina: 0, maxStamina: 0,
      state: 'idle', attackDir: null, windupRemaining: 0, guardDir: null, alive: true,
      weapon: this.loadout.weapon, shield: this.loadout.shield, armor: this.loadout.armor,
      kills: 0, targeted: false,
    };
    info.id = this.id;
    info.name = this.name;
    info.team = this.team;
    info.isPlayer = this.isPlayer;
    info.position.copy(this.position);
    info.velocity.copy(this.velocity);
    info.facing = this.yaw;
    info.hp = this.hp;
    info.maxHp = this.maxHp;
    info.stamina = this.stamina;
    info.maxStamina = this.maxStamina;
    info.state = this.state;
    info.attackDir = this.attackDir;
    info.windupRemaining = this.state === 'attack' ? Math.max(0, this.attackTiming.windup - this.attackTimer) : 0;
    info.guardDir = this.guardDir;
    info.alive = this.alive;
    info.weapon = this.loadout.weapon;
    info.shield = this.loadout.shield;
    info.armor = this.loadout.armor;
    info.kills = this.kills;
    info.targeted = this.targeted;
    return info;
  }

  getChestPosition(out: THREE.Vector3): THREE.Vector3 {
    out.copy(this.position);
    out.y += 1.25;
    return out;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rig.dispose();
  }

  playVictory(world: FighterWorld): void {
    if (!this.alive) return;
    this.rig.playAction('victory');
    void world;
  }

  wasDamagedRecentlyBy(id: number, within: number, now: number): boolean {
    const t = this.recentAttackers.get(id);
    return t !== undefined && now - t <= within;
  }

  setOpacity(v: number): void {
    this.rig.setOpacity(v);
  }

  /** Pick the attack direction an AI/player has chosen from a bearing. */
  facingTo(target: THREE.Vector3): number {
    _toTarget.copy(target).sub(this.position);
    return yawFromDirection(_toTarget.x, _toTarget.z);
  }

  /** Test a target against this fighter's attack cone/reach. */
  canReach(targetPos: THREE.Vector3, extraReach = 0.12): boolean {
    const dx = targetPos.x - this.position.x;
    const dz = targetPos.z - this.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > this.loadout.weapon.reach + extraReach) return false;
    forwardFromYaw(this.yaw, _fwd);
    const dot = (dx * _fwd.x + dz * _fwd.z) / Math.max(dist, 0.001);
    return dot > 0.22;
  }

  aimErrorTo(targetPos: THREE.Vector3): number {
    return Math.abs(angleDelta(this.yaw, this.facingTo(targetPos)));
  }

  action(name: RigAction, opts?: { dir?: THREE.Vector3; variant?: number }): void {
    this.rig.playAction(name, opts);
  }
}
