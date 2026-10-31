import type { AIContext, AIController, AIProfile, AttackDir, Intent } from '../core/types';
import type { FighterInfo } from '../core/types';
import { angleDelta, distance2D, forwardFromYaw, yawTo } from '../core/utils';
import * as THREE from 'three';

const _fwd = new THREE.Vector3();
const _to = new THREE.Vector3();

/**
 * TEMPORARY AI stub — combat-ai replaces this with the real tactical controller.
 * Simple seek / attack / occasional block behaviour.
 */
export function createAIController(profile: AIProfile, seed: number): AIController {
  let decisionTimer = 0;
  let targetId: number | null = null;
  let attackDir: AttackDir | null = null;
  let blockDir: AttackDir | null = null;
  let rngState = seed >>> 0 || 1;
  const rand = () => {
    rngState ^= rngState << 13; rngState ^= rngState >>> 17; rngState ^= rngState << 5;
    return (rngState >>> 0) / 4294967296;
  };

  const chooseTarget = (ctx: AIContext): FighterInfo | null => {
    const enemies = ctx.fighters.filter((f) => f.alive && f.id !== ctx.self.id && (f.team === -1 || f.team !== ctx.self.team));
    if (enemies.length === 0) return null;
    let best: FighterInfo | null = null;
    let bestScore = -Infinity;
    for (const f of enemies) {
      const d = distance2D(ctx.self.position, f.position);
      const score = -d + (f.isPlayer ? 4 : 0) + (f.hp < 40 ? 2 : 0);
      if (score > bestScore) { bestScore = score; best = f; }
    }
    return best;
  };

  return {
    update(ctx: AIContext): Intent {
      const self = ctx.self;
      decisionTimer -= ctx.dt;
      const current = targetId != null ? ctx.fighters.find((f) => f.id === targetId && f.alive) : null;
      if (!current || decisionTimer <= 0) {
        targetId = chooseTarget(ctx)?.id ?? null;
        decisionTimer = 0.3 + rand() * 0.4;
      }
      const target = targetId != null ? ctx.fighters.find((f) => f.id === targetId && f.alive) ?? null : null;
      if (!target) {
        return { moveX: 0, moveZ: 0, sprint: false, block: null };
      }
      _to.copy(target.position).sub(self.position);
      _to.y = 0;
      const dist = _to.length();
      _to.normalize();
      forwardFromYaw(self.facing, _fwd);
      const facingErr = angleDelta(self.facing, yawTo(self.position, target.position));
      if (Math.abs(facingErr) > 0.5) attackDir = null;

      if (dist > target.weapon.reach + 0.6) {
        return { moveX: _to.x, moveZ: _to.z, sprint: dist > 6, block: null };
      }
      if (attackDir == null && dist < self.weapon.reach + 0.5 && rand() < 0.03 + profile.aggression * 0.05) {
        const dirs: AttackDir[] = ['left', 'right', 'overhead', 'thrust'];
        attackDir = dirs[Math.floor(rand() * dirs.length)];
      }
      if (target.state === 'attack' && target.windupRemaining > 0 && target.attackDir && rand() < profile.defense * 0.35) {
        blockDir = target.attackDir;
      } else {
        blockDir = null;
      }
      const strafeSign = Math.sin(ctx.time * 0.8 + contextSeed(seed)) > 0 ? 1 : -1;
      const strafe = Math.abs(dist - (self.weapon.reach - 0.15)) > 0.5 ? 0 : strafeSign;
      const moveX = _to.x * Math.min(1, dist - self.weapon.reach + 0.4) - _to.z * strafe * 0.4;
      const moveZ = _to.z * Math.min(1, dist - self.weapon.reach + 0.4) + _to.x * strafe * 0.4;
      const intent: Intent = {
        moveX,
        moveZ,
        sprint: false,
        attack: attackDir ?? undefined,
        block: blockDir,
      };
      attackDir = null;
      return intent;
    },
  };
}

function contextSeed(seed: number): number {
  return (seed % 1000) / 100;
}

void _to;
