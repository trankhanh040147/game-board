import * as THREE from 'three';
import { COMBAT } from '../core/config';
import type { AttackDir, FighterInfo, HitInfo } from '../core/types';
import { angleDelta, clamp, forwardFromYaw, yawTo } from '../core/utils';
import type { Fighter, FighterWorld } from '../game/fighter';

const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();
const _point = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _push = new THREE.Vector3();

export class CombatSystem {
  private world: FighterWorld;
  private rng: () => number;

  constructor(world: FighterWorld) {
    this.world = world;
    this.rng = world.rng;
  }

  update(dt: number, fighters: Fighter[]): void {
    this.separate(fighters, dt);
    this.resolveAttacks(fighters);
    this.resolveKicks(fighters);
  }

  private separate(fighters: Fighter[], dt: number): void {
    const alive = fighters.filter((f) => f.alive);
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        if (a.state === 'dodge' || b.state === 'dodge') continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const minD = a.radius + b.radius;
        const d2 = dx * dx + dz * dz;
        if (d2 > minD * minD || d2 < 1e-8) continue;
        const d = Math.sqrt(d2);
        const overlap = (minD - d) * 0.5;
        const nx = dx / d;
        const nz = dz / d;
        // Deathmatch shoving: heavier / attacking fighters push harder.
        const aMass = 1 + a.loadout.armor.weight * 0.05 + (a.state === 'attack' ? 0.35 : 0);
        const bMass = 1 + b.loadout.armor.weight * 0.05 + (b.state === 'attack' ? 0.35 : 0);
        const total = aMass + bMass;
        a.position.x -= nx * overlap * (bMass / total) * 2;
        a.position.z -= nz * overlap * (bMass / total) * 2;
        b.position.x += nx * overlap * (aMass / total) * 2;
        b.position.z += nz * overlap * (aMass / total) * 2;
        // Tiny velocity exchange so crowds feel physical.
        const rel = (b.velocity.x - a.velocity.x) * nx + (b.velocity.z - a.velocity.z) * nz;
        if (rel < 0) {
          const imp = rel * 0.08;
          a.velocity.x -= nx * imp;
          a.velocity.z -= nz * imp;
          b.velocity.x += nx * imp;
          b.velocity.z += nz * imp;
        }
      }
    }
    void dt;
  }

  private resolveAttacks(fighters: Fighter[]): void {
    for (const attacker of fighters) {
      if (!attacker.alive || !attacker.isAttackInHitWindow()) continue;
      const target = this.findTarget(attacker, fighters);
      if (!target) continue;
      attacker.markHitConsumed();
      this.resolveHit(attacker, target);
    }
  }

  private findTarget(attacker: Fighter, fighters: Fighter[]): Fighter | null {
    let best: Fighter | null = null;
    let bestScore = Infinity;
    forwardFromYaw(attacker.yaw, _tmp);
    for (const f of fighters) {
      if (f === attacker || !f.alive || f.isInvulnerable()) continue;
      const dx = f.position.x - attacker.position.x;
      const dz = f.position.z - attacker.position.z;
      const dist = Math.hypot(dx, dz);
      if (dist > attacker.loadout.weapon.reach + 0.32) continue;
      if (dist < 0.24) continue;
      const dot = (dx * _tmp.x + dz * _tmp.z) / dist;
      if (dot < 0.2) continue;
      const ang = Math.acos(clamp(dot, -1, 1));
      const friendlyPenalty = attacker.team >= 0 && f.team === attacker.team ? 0.9 : 0;
      const score = ang * 1.6 + dist + friendlyPenalty;
      if (score < bestScore) {
        bestScore = score;
        best = f;
      }
    }
    return best;
  }

  private resolveHit(attacker: Fighter, defender: Fighter): void {
    const world = this.world;
    const weapon = attacker.loadout.weapon;
    const teamFire = attacker.team >= 0 && defender.team === attacker.team;

    // Attack zone.
    const zone = this.pickZone(attacker.attackDir ?? 'right', weapon.headBias);
    const zoneMult = COMBAT.zone[zone];

    // Block test.
    let blocked = false;
    let guardBroken = false;
    let shieldBlock = false;
    if (defender.state === 'block' && defender.guardDir) {
      const bearing = Math.abs(angleDelta(defender.yaw, yawTo(defender.position, attacker.position)));
      const dirMatch = defender.guardDir === (attacker.attackDir ?? 'right');
      const shieldCoverage = defender.loadout.shield ? 0.45 : 0.0;
      const inArc = bearing < COMBAT.blockArc / 2 + shieldCoverage;
      if (dirMatch && inArc) blocked = true;
      shieldBlock = blocked && !!defender.loadout.shield;
    }

    // Speed bonus: closing distance plus weapon heft.
    _to.copy(defender.position).sub(attacker.position).setY(0).normalize();
    const closing = Math.max(0, attacker.velocity.dot(_to));
    const heft = 0.035 + weapon.weight * 0.014;
    const speedBonus = clamp(closing * COMBAT.speedBonusMove + heft + (this.rng() - 0.5) * 0.04, 0, COMBAT.speedBonusMax);

    const variance = 0.93 + this.rng() * 0.14;
    let raw = weapon.damage * zoneMult * variance * (1 + speedBonus) * attacker.damageScale;
    if (teamFire) raw *= COMBAT.friendlyFireMultiplier;

    const armor = zone === 'head' ? defender.armorHead : zone === 'legs' ? defender.armorLegs : defender.armorBody;
    const effectiveArmor = armor * (1 - weapon.armorPen);
    const reduction = clamp(effectiveArmor * COMBAT.armorFactor, 0, 0.76);
    let damage = Math.max(COMBAT.minDamage, raw * (1 - reduction));

    _point.copy(defender.position);
    _point.y += zone === 'head' ? 1.55 : zone === 'legs' ? 0.85 : 1.25;
    _dir.copy(_to);

    let guardBrokenThisHit = false;
    let chip = damage;
    if (blocked) {
      const staminaCost = shieldBlock
        ? damage * COMBAT.blockStaminaShield + COMBAT.blockImpactExtra
        : damage * COMBAT.blockStaminaWeapon + COMBAT.blockImpactExtra;
      if (defender.stamina < staminaCost) {
        // Guard broken — the blow lands partially and the defender is opened up.
        defender.spendStamina(staminaCost);
        defender.breakGuard();
        guardBrokenThisHit = true;
        blocked = false;
        chip = damage * 0.45;
        damage = chip;
        world.effects.sparkBurst(_point, _dir, 16);
        world.audio.play('guard-break', { pos: _point, volume: 1 });
        world.emit({ type: 'guard-break', attacker, defender });
      } else {
        defender.spendStamina(staminaCost);
        defender.staminaDelay = COMBAT.staminaRegenDelay;
        defender.blocks++;
        const absorb = shieldBlock ? 1 : COMBAT.weaponBlockAbsorb;
        chip = damage * (1 - absorb);
        damage = chip;
        defender.velocity.x -= _dir.x * 0.7;
        defender.velocity.z -= _dir.z * 0.7;
        world.effects.sparkBurst(_point, _dir, shieldBlock ? 8 : 14);
        world.audio.play(shieldBlock ? 'hit-shield' : 'block-weapon', { pos: _point, volume: 0.95 });
        _push.copy(defender.position).addScaledVector(_dir, 0.1);
        const info: HitInfo = {
          attackerId: attacker.id, defenderId: defender.id, attackDir: attacker.attackDir ?? 'right',
          damage, rawDamage: raw, zone, speedBonus, blocked: true, guardBroken: false,
          killed: false, friendlyFire: teamFire, point: _point.clone(), direction: _dir.clone(),
        };
        world.emit({ type: 'block', attacker, defender, info });
        if (chip > 0.5) {
          this.applyChipDamage(defender, chip, attacker);
        }
        return;
      }
    }

    // Unblocked landing.
    const info: HitInfo = {
      attackerId: attacker.id, defenderId: defender.id, attackDir: attacker.attackDir ?? 'right',
      damage, rawDamage: raw, zone, speedBonus, blocked: false, guardBroken: guardBrokenThisHit,
      killed: false, friendlyFire: teamFire, point: _point.clone(), direction: _dir.clone(),
    };
    defender.receiveHit(info, world);
    const killed = !defender.alive;
    info.killed = killed;
    attacker.damageDealt += damage;
    if (zone === 'head') attacker.headshots++;
    if (!teamFire && killed) {
      attacker.kills++;
      if (attacker.isPlayer) {
        world.effects.bloodDecal(defender.position, 0.8);
      }
    }
    if (teamFire) {
      world.audio.play('hit-flesh', { pos: _point, volume: 0.5 });
    }
    world.effects.bloodDecal(defender.position, 0.7 + this.rng() * 0.8);
    world.emit({ type: 'hit', attacker, defender, info });
    if (killed) {
      world.emit({ type: 'kill', attacker, defender, info });
    }
  }

  private applyChipDamage(defender: Fighter, chip: number, attacker: Fighter): void {
    defender.hp = Math.max(0, defender.hp - chip);
    defender.damageTaken += chip;
    if (defender.hp <= 0) {
      const info: HitInfo = {
        attackerId: attacker.id, defenderId: defender.id, attackDir: attacker.attackDir ?? 'right',
        damage: chip, rawDamage: chip, zone: 'torso', speedBonus: 0, blocked: false,
        guardBroken: false, killed: true, friendlyFire: false,
        point: defender.position.clone().setY(1.3), direction: new THREE.Vector3(),
      };
      defender.die(info, this.world);
      if (attacker.team !== defender.team) attacker.kills++;
      this.world.emit({ type: 'kill', attacker, defender, info });
    }
  }

  private resolveKicks(fighters: Fighter[]): void {
    for (const attacker of fighters) {
      if (!attacker.wantsKick) continue;
      attacker.wantsKick = false;
      if (!attacker.alive) continue;
      forwardFromYaw(attacker.yaw, _tmp);
      let hitAny = false;
      for (const f of fighters) {
        if (f === attacker || !f.alive) continue;
        const dx = f.position.x - attacker.position.x;
        const dz = f.position.z - attacker.position.z;
        const dist = Math.hypot(dx, dz);
        if (dist > COMBAT.kick.range + 0.35) continue;
        const dot = (dx * _tmp.x + dz * _tmp.z) / Math.max(dist, 0.001);
        if (dot < Math.cos(COMBAT.kick.arc / 2)) continue;
        hitAny = true;
        const wasBlocking = f.state === 'block';
        f.guardDir = null;
        f.state = 'stagger';
        f.stateTimer = COMBAT.kick.stagger + (wasBlocking ? 0.15 : 0);
        if (wasBlocking) f.stamina = Math.max(0, f.stamina - 22);
        f.attackDir = null;
        f.velocity.x += (dx / Math.max(dist, 0.001)) * 3.4;
        f.velocity.z += (dz / Math.max(dist, 0.001)) * 3.4;
        f.rig.playAction('stagger', { variant: 2 });
        this.world.effects.dustPuff(f.position, 4, 0.8);
        this.world.audio.play('kick', { pos: f.position, volume: 0.9 });
        this.world.emit({ type: 'kick', attacker, defender: f });
      }
      if (hitAny) {
        attacker.staminaDelay = COMBAT.staminaRegenDelay;
      }
    }
  }

  private pickZone(dir: AttackDir, headBias: number): 'head' | 'torso' | 'legs' {
    const r = this.rng();
    if (dir === 'overhead') {
      if (r < 0.62 + headBias * 0.25) return 'head';
      if (r < 0.9) return 'torso';
      return 'legs';
    }
    if (dir === 'thrust') {
      if (r < 0.06 + headBias * 0.1) return 'head';
      if (r < 0.92) return 'torso';
      return 'legs';
    }
    // side slashes
    if (r < 0.06 + headBias * 0.18) return 'head';
    if (r < 0.8) return 'torso';
    return 'legs';
  }
}

/** Helper used by the game to build a synthetic info for logs. */
export function makeHitInfo(info: FighterInfo): HitInfo {
  return {
    attackerId: info.id, defenderId: -1, attackDir: info.attackDir ?? 'right', damage: 0,
    rawDamage: 0, zone: 'torso', speedBonus: 0, blocked: false, guardBroken: false, killed: false,
    friendlyFire: false, point: info.position.clone(), direction: new THREE.Vector3(),
  };
}

void _push;
void _to;
