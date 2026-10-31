import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type {
  AIContext,
  AIProfile,
  Arena,
  AttackDir,
  FighterInfo,
  GuardDir,
  Intent,
} from '../src/core/types';
import { ATTACK_DIRS } from '../src/core/types';
import { AI_PROFILES, ARMORS, WEAPONS, attackTiming } from '../src/core/config';
import {
  chooseAttackDir,
  computeSeparation,
  createAIController,
  isHostile,
  sanitizeIntent,
  selectTarget,
  tuningFor,
} from '../src/game/ai';
import type { AITuning } from '../src/game/ai';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeFighter(id: number, overrides: Partial<FighterInfo> = {}): FighterInfo {
  return {
    id,
    name: `Fighter ${id}`,
    team: 0,
    isPlayer: false,
    position: new THREE.Vector3(0, 0, 0),
    velocity: new THREE.Vector3(),
    facing: 0,
    hp: 100,
    maxHp: 100,
    stamina: 100,
    maxStamina: 100,
    state: 'idle',
    attackDir: null,
    windupRemaining: 0,
    guardDir: null,
    alive: true,
    weapon: WEAPONS.arming_sword,
    shield: null,
    armor: ARMORS.gambeson,
    kills: 0,
    targeted: false,
    ...overrides,
  };
}

function makeArena(overrides: Partial<Arena> = {}): Arena {
  return {
    root: new THREE.Group(),
    bounds: { minX: -23.5, maxX: 23.5, minZ: -22.5, maxZ: 22.5 },
    obstacles: [{ x: 9, z: 0, r: 3.6 }],
    spawns: [],
    teamSpawns: [],
    playerSpawn: { position: new THREE.Vector3(0, 0, 12), yaw: Math.PI },
    update: () => undefined,
    setExcitement: () => undefined,
    cheer: () => undefined,
    clampPosition: () => undefined,
    dispose: () => undefined,
    ...overrides,
  };
}

function makeCtx(
  self: FighterInfo,
  fighters: FighterInfo[],
  time = 0,
  dt = 1 / 60,
  playerId = -1,
): AIContext {
  return { self, fighters, arena: makeArena(), time, dt, playerId };
}

function expectSanitized(intent: Intent): void {
  expect(Number.isFinite(intent.moveX)).toBe(true);
  expect(Number.isFinite(intent.moveZ)).toBe(true);
  const len = Math.hypot(intent.moveX, intent.moveZ);
  expect(len === 0 || Math.abs(len - 1) < 1e-9).toBe(true);
  expect(typeof intent.sprint).toBe('boolean');
  if (intent.attack !== undefined) expect(ATTACK_DIRS).toContain(intent.attack);
  if (intent.block !== undefined && intent.block !== null) expect(ATTACK_DIRS).toContain(intent.block);
  if (intent.kick !== undefined) expect(typeof intent.kick).toBe('boolean');
  if (intent.dodge) {
    expect(Number.isFinite(intent.dodge.x)).toBe(true);
    expect(Number.isFinite(intent.dodge.z)).toBe(true);
    expect(Math.abs(Math.hypot(intent.dodge.x, intent.dodge.z) - 1)).toBeLessThan(1e-9);
  }
  if (intent.faceYaw !== undefined) expect(Number.isFinite(intent.faceYaw)).toBe(true);
  if (intent.lockTargetId !== undefined && intent.lockTargetId !== null) {
    expect(Number.isFinite(intent.lockTargetId)).toBe(true);
  }
}

function runFrames(
  ai: ReturnType<typeof createAIController>,
  ctx: AIContext,
  frames: number,
  onFrame?: (intent: Intent, i: number) => void,
): Intent[] {
  const out: Intent[] = [];
  for (let i = 0; i < frames; i++) {
    ctx.time = i / 60;
    ctx.dt = 1 / 60;
    const intent = ai.update(ctx);
    expectSanitized(intent);
    out.push(intent);
    onFrame?.(intent, i);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Profile tuning                                                      */
/* ------------------------------------------------------------------ */

describe('profile tuning', () => {
  it('builds finite, in-range tuning for every authored profile', () => {
    for (const profile of Object.values(AI_PROFILES)) {
      const t = tuningFor(profile);
      const numeric: number[] = [
        t.skill, t.aggression, t.defense, t.footwork, t.mobility, t.reaction,
        t.decisionMin, t.decisionMax, t.attackGapMin, t.attackGapMax,
        t.blockSkill, t.dodgeChance, t.strafeStrength, t.idealRangeOffset,
        t.rushDistance, t.comboMax, t.kickChance, t.feintChance, t.hesitation,
        t.retreatHpFrac, t.retreatOutnumbered, t.staminaReserve, t.targetStick, t.openingDelay,
        t.churn, t.playerBias, t.weakestBias, t.helpBias, t.dogpileAvoid,
      ];
      for (const value of numeric) expect(Number.isFinite(value)).toBe(true);
      expect(t.reaction).toBeGreaterThan(0);
      expect(t.blockSkill).toBeGreaterThanOrEqual(0);
      expect(t.blockSkill).toBeLessThanOrEqual(0.97);
      expect(t.dodgeChance).toBeGreaterThanOrEqual(0);
      expect(t.dodgeChance).toBeLessThanOrEqual(0.85);
      expect(t.comboMax).toBeGreaterThanOrEqual(1);
      expect(t.attackGapMax).toBeGreaterThanOrEqual(t.attackGapMin);
      expect(t.dirWeights.left).toBeGreaterThan(0);
      expect(t.dirWeights.right).toBeGreaterThan(0);
      expect(t.dirWeights.overhead).toBeGreaterThan(0);
      expect(t.dirWeights.thrust).toBeGreaterThan(0);
    }
  });

  it('sanitizes malformed authored profiles instead of producing NaN', () => {
    const broken: AIProfile = {
      ...AI_PROFILES.recruit,
      skill: Number.NaN,
      aggression: 9,
      defense: -4,
      reaction: -2,
      mobility: Number.NaN,
      footwork: Number.POSITIVE_INFINITY,
      favorite: 'sideways' as AttackDir,
    };
    const t = tuningFor(broken);
    expect(Number.isFinite(t.reaction)).toBe(true);
    expect(t.reaction).toBeGreaterThan(0);
    expect(t.blockSkill).toBeGreaterThanOrEqual(0);
    expect(t.blockSkill).toBeLessThanOrEqual(1);
    expect(t.strafeStrength).toBeGreaterThan(0);
    for (const dir of ATTACK_DIRS) expect(Number.isFinite(t.dirWeights[dir])).toBe(true);
    expect(t.dirWeights.right).toBeGreaterThan(0.05); // favorite is the fallback
  });

  it('keeps the six archetypes tactically distinct', () => {
    const recruit = tuningFor(AI_PROFILES.recruit);
    const fighter = tuningFor(AI_PROFILES.fighter);
    const champion = tuningFor(AI_PROFILES.champion);
    const brute = tuningFor(AI_PROFILES.brute);
    const duelist = tuningFor(AI_PROFILES.duelist);

    // Recruits react slowly, hesitate and cannot parry like champions.
    expect(recruit.reaction).toBeGreaterThan(champion.reaction);
    expect(recruit.blockSkill).toBeLessThan(champion.blockSkill);
    expect(recruit.hesitation).toBeGreaterThan(0);
    expect(recruit.dodgeChance).toBeLessThan(champion.dodgeChance);
    expect(recruit.openingDelay).toBeGreaterThan(champion.openingDelay);

    // Champions are the best defenders; duelists are evasive.
    expect(champion.blockSkill).toBeGreaterThan(fighter.blockSkill);
    expect(duelist.strafeStrength).toBeGreaterThan(brute.strafeStrength);
    expect(duelist.dodgeChance).toBeGreaterThan(brute.dodgeChance);

    // Brutes spam overhead and will not disengage; duelists are thrust fencers.
    expect(brute.dirWeights.overhead).toBeGreaterThan(brute.dirWeights.thrust);
    expect(brute.dirWeights.overhead).toBeGreaterThan(fighter.dirWeights.overhead);
    expect(brute.retreatHpFrac).toBeLessThan(fighter.retreatHpFrac);
    expect(duelist.dirWeights.thrust).toBeGreaterThan(duelist.dirWeights.overhead);
  });

  it('is deterministic for a profile', () => {
    expect(tuningFor(AI_PROFILES.veteran)).toEqual(tuningFor(AI_PROFILES.veteran));
  });
});

/* ------------------------------------------------------------------ */
/* Team awareness                                                      */
/* ------------------------------------------------------------------ */

describe('hostility', () => {
  it('treats teammates as friendly and other teams as hostile', () => {
    const a = makeFighter(1, { team: 0 });
    const teammate = makeFighter(2, { team: 0 });
    const enemy = makeFighter(3, { team: 1 });
    expect(isHostile(a, teammate)).toBe(false);
    expect(isHostile(a, enemy)).toBe(true);
    expect(isHostile(a, a)).toBe(false);
  });

  it('treats every other fighter as hostile in free-for-all', () => {
    const a = makeFighter(1, { team: -1 });
    const b = makeFighter(2, { team: -1 });
    const c = makeFighter(3, { team: 2 });
    expect(isHostile(a, b)).toBe(true);
    expect(isHostile(a, c)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Target selection                                                    */
/* ------------------------------------------------------------------ */

describe('target selection', () => {
  const opts = { currentTargetId: null, rng: () => 0.5, duel: true, ffa: false };

  it('ignores closer teammates and selects the enemy', () => {
    const self = makeFighter(1, { team: 0 });
    const ally = makeFighter(2, { team: 0, position: new THREE.Vector3(0.8, 0, 0.4) });
    const enemy = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 4) });
    const ctx = makeCtx(self, [self, ally, enemy]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), opts);
    expect(target?.id).toBe(3);
  });

  it('returns null when there is no living hostile fighter', () => {
    const self = makeFighter(1, { team: 0 });
    const ally = makeFighter(2, { team: 0 });
    const deadEnemy = makeFighter(3, { team: 1, alive: false });
    const ctx = makeCtx(self, [self, ally, deadEnemy]);
    expect(selectTarget(ctx, tuningFor(AI_PROFILES.fighter), opts)).toBeNull();
  });

  it('prefers the player over an equally distant enemy', () => {
    const self = makeFighter(1, { team: 0 });
    const player = makeFighter(2, { team: 1, isPlayer: true, position: new THREE.Vector3(0, 0, 4) });
    const other = makeFighter(3, { team: 1, position: new THREE.Vector3(4, 0, 0) });
    const ctx = makeCtx(self, [self, player, other], 0, 1 / 60, 2);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), opts);
    expect(target?.id).toBe(2);
  });

  it('prefers a wounded enemy at similar range', () => {
    const self = makeFighter(1, { team: 0 });
    const healthy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 4) });
    const wounded = makeFighter(3, { team: 1, hp: 18, position: new THREE.Vector3(4.2, 0, 0) });
    const ctx = makeCtx(self, [self, healthy, wounded]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), opts);
    expect(target?.id).toBe(3);
  });

  it('avoids dogpiling a target two allies are already engaging', () => {
    const self = makeFighter(1, { team: 0 });
    const allyA = makeFighter(2, { team: 0, position: new THREE.Vector3(0.5, 0, 3.8) });
    const allyB = makeFighter(3, { team: 0, position: new THREE.Vector3(-0.8, 0, 4.2) });
    // Engaged target is much closer but has two allies already on it.
    const dogpile = makeFighter(4, { team: 1, position: new THREE.Vector3(0, 0, 4) });
    const lonely = makeFighter(5, { team: 1, position: new THREE.Vector3(8, 0, 4) });
    const ctx = makeCtx(self, [self, allyA, allyB, dogpile, lonely]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), opts);
    expect(target?.id).toBe(5);
  });

  it('pays attention to the fighter that just hit us', () => {
    const self = makeFighter(1, { team: 0 });
    const near = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 4) });
    const attacker = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 5) });
    const ctx = makeCtx(self, [self, near, attacker]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), {
      ...opts,
      recentAttackerId: 3,
    });
    expect(target?.id).toBe(3);
  });

  it('in free-for-all prefers the nearest hostile', () => {
    const self = makeFighter(1, { team: -1 });
    const close = makeFighter(2, { team: -1, position: new THREE.Vector3(0, 0, 4) });
    const far = makeFighter(3, { team: -1, position: new THREE.Vector3(0, 0, 8) });
    const ctx = makeCtx(self, [self, close, far]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), {
      ...opts,
      ffa: true,
      duel: false,
    });
    expect(target?.id).toBe(2);
  });

  it('churns free-for-all targets over time instead of sticking forever', () => {
    const self = makeFighter(1, { team: -1 });
    const enemies = [
      makeFighter(2, { team: -1, position: new THREE.Vector3(0, 0, 6) }),
      makeFighter(3, { team: -1, position: new THREE.Vector3(0, 0, -6) }),
      makeFighter(4, { team: -1, position: new THREE.Vector3(6, 0, 0) }),
    ];
    const ctx = makeCtx(self, [self, ...enemies]);
    const ai = createAIController(AI_PROFILES.fighter, 2024);
    const seen = new Set<number>();
    for (let i = 0; i < 900; i++) {
      ctx.time = i / 60;
      const intent = ai.update(ctx);
      if (intent.lockTargetId != null) seen.add(intent.lockTargetId);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

/* ------------------------------------------------------------------ */
/* Attack-direction personality                                        */
/* ------------------------------------------------------------------ */

describe('attack direction choice', () => {
  it('always returns a legal direction for every profile and roll', () => {
    for (const profile of Object.values(AI_PROFILES)) {
      const t = tuningFor(profile);
      for (let i = 0; i < 40; i++) {
        const dir = chooseAttackDir(t, null, () => i / 40, 2.4);
        expect(ATTACK_DIRS).toContain(dir);
      }
    }
  });

  it('favours the archetype signature attack', () => {
    const brute = tuningFor(AI_PROFILES.brute);
    expect(chooseAttackDir(brute, null, () => 0.5)).toBe('overhead');
    const duelist = tuningFor(AI_PROFILES.duelist);
    expect(chooseAttackDir(duelist, null, () => 0.5)).toBe('thrust');
  });

  it('avoids swinging into a raised guard', () => {
    const t = tuningFor(AI_PROFILES.veteran);
    const target = makeFighter(2, { state: 'block', guardDir: 'overhead', hp: 100 });
    expect(chooseAttackDir(t, target, () => 0.5, 2.3)).not.toBe('overhead');
    // A recruit is far more likely to swing straight into the guard.
    const recruit = tuningFor(AI_PROFILES.recruit);
    const blocked: AttackDir[] = [];
    for (let i = 0; i < 60; i++) {
      blocked.push(chooseAttackDir(recruit, target, () => i / 60, 2.3));
    }
    expect(blocked.filter((d) => d === 'overhead').length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/* Intent sanitization                                                 */
/* ------------------------------------------------------------------ */

describe('intent sanitization', () => {
  it('repairs NaN / infinite / illegal intent fields', () => {
    const dirty = {
      moveX: Number.NaN,
      moveZ: Number.POSITIVE_INFINITY,
      sprint: false,
      attack: 'sideways' as AttackDir,
      block: 'bogus' as GuardDir,
      dodge: { x: Number.NaN, z: 0 },
      faceYaw: Number.POSITIVE_INFINITY,
      lockTargetId: Number.NaN,
    } as Intent;
    const clean = sanitizeIntent(dirty);
    expect(clean.moveX).toBe(0);
    expect(clean.moveZ).toBe(0);
    expect(clean.attack).toBeUndefined();
    expect(clean.block).toBeNull();
    expect(clean.dodge).toBeUndefined();
    expect(clean.faceYaw).toBeUndefined();
    expect(clean.lockTargetId).toBeNull();
  });

  it('normalizes a non-unit movement vector', () => {
    const clean = sanitizeIntent({ moveX: 3, moveZ: 4, sprint: true, block: null });
    expect(clean.moveX).toBeCloseTo(0.6, 9);
    expect(clean.moveZ).toBeCloseTo(0.8, 9);
    expect(clean.block).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Separation steering                                                 */
/* ------------------------------------------------------------------ */

describe('separation steering', () => {
  it('pushes exactly overlapping fighters apart deterministically', () => {
    const a = makeFighter(1);
    const b = makeFighter(2);
    const outA = { x: 0, z: 0 };
    const outB = { x: 0, z: 0 };
    computeSeparation(a, [a, b], outA);
    computeSeparation(b, [a, b], outB);
    expect(Number.isFinite(outA.x)).toBe(true);
    expect(Number.isFinite(outA.z)).toBe(true);
    const magA = Math.hypot(outA.x, outA.z);
    expect(magA).toBeGreaterThan(0.5);
    // Both fighters push in opposite directions.
    expect(outA.x * outB.x + outA.z * outB.z).toBeLessThan(0);
  });

  it('does nothing when fighters are far apart', () => {
    const a = makeFighter(1);
    const b = makeFighter(2, { position: new THREE.Vector3(0, 0, 8) });
    const out = { x: 0, z: 0 };
    computeSeparation(a, [a, b], out);
    expect(out.x).toBe(0);
    expect(out.z).toBe(0);
  });

  it('pushes teammates harder than enemies (never run through friends)', () => {
    const self = makeFighter(1, { team: 0 });
    const ally = makeFighter(2, { team: 0, position: new THREE.Vector3(0, 0, 1.2) });
    const enemy = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 1.2) });
    const allyOut = { x: 0, z: 0 };
    const enemyOut = { x: 0, z: 0 };
    computeSeparation(self, [self, ally], allyOut);
    computeSeparation(self, [self, enemy], enemyOut);
    expect(Math.hypot(allyOut.x, allyOut.z)).toBeGreaterThan(Math.hypot(enemyOut.x, enemyOut.z));
  });

  it('never produces NaN for arbitrary crowd layouts', () => {
    const self = makeFighter(1);
    const crowd: FighterInfo[] = [];
    let seed = 7;
    const rng = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let i = 0; i < 24; i++) {
      crowd.push(
        makeFighter(100 + i, {
          team: i % 3,
          position: new THREE.Vector3((rng() - 0.5) * 4, 0, (rng() - 0.5) * 4),
        }),
      );
    }
    const out = { x: 0, z: 0 };
    computeSeparation(self, [self, ...crowd], out);
    expect(Number.isFinite(out.x)).toBe(true);
    expect(Number.isFinite(out.z)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Controller behaviour                                                */
/* ------------------------------------------------------------------ */

describe('AIController', () => {
  it('is team-aware: it targets the enemy, never the closer ally', () => {
    const self = makeFighter(1, { team: 0 });
    const ally = makeFighter(2, { team: 0, position: new THREE.Vector3(0.7, 0, 0.7) });
    const enemy = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 4), facing: Math.PI });
    const ctx = makeCtx(self, [self, ally, enemy]);
    const ai = createAIController(AI_PROFILES.fighter, 11);
    const intent = ai.update(ctx);
    expect(intent.lockTargetId).toBe(3);
  });

  it('switches to a new target when the current one dies', () => {
    const self = makeFighter(1, { team: 0 });
    const first = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.4), facing: Math.PI });
    const second = makeFighter(3, { team: 1, position: new THREE.Vector3(6, 0, 2.4), facing: Math.PI });
    const ctx = makeCtx(self, [self, first, second]);
    const ai = createAIController(AI_PROFILES.fighter, 12);
    expect(ai.update(ctx).lockTargetId).toBe(2);
    first.alive = false;
    first.state = 'dead';
    ctx.time = 1 / 60;
    const next = ai.update(ctx);
    expect(next.lockTargetId).toBe(3);
  });

  it('returns a safe intent when it has no target at all', () => {
    const self = makeFighter(1, { team: 0 });
    const ctx = makeCtx(self, [self]);
    const ai = createAIController(AI_PROFILES.recruit, 1);
    const intent = runFrames(ai, ctx, 120)[119];
    expect(intent.lockTargetId).toBeNull();
    expect(intent.attack).toBeUndefined();
    expect(intent.block).toBeNull();
  });

  it('produces finite, legal intents in a crowded brawl for every profile', () => {
    const self = makeFighter(1, { team: 0, position: new THREE.Vector3(0, 0, 0) });
    const fighters: FighterInfo[] = [self];
    const states = ['idle', 'move', 'attack', 'block', 'stagger', 'dodge', 'dead'] as const;
    for (let i = 0; i < 11; i++) {
      const team = i % 2 === 0 ? 0 : 1;
      fighters.push(
        makeFighter(10 + i, {
          team,
          position: new THREE.Vector3(-8 + i * 1.4, 0, 2 + (i % 3)),
          state: states[i % states.length],
          alive: states[i % states.length] !== 'dead',
          attackDir: i % 4 === 0 ? 'left' : null,
          windupRemaining: i % 4 === 0 ? 0.2 : 0,
          guardDir: i % 3 === 0 ? 'right' : null,
        }),
      );
    }
    const ctx = makeCtx(self, fighters);
    for (const profile of Object.values(AI_PROFILES)) {
      const ai = createAIController(profile, 100 + profile.name.length);
      runFrames(ai, ctx, 120);
    }
  });

  it('does not mutate the fighter snapshots it reads', () => {
    const self = makeFighter(1, { team: 0 });
    const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.2), facing: Math.PI });
    const ctx = makeCtx(self, [self, enemy]);
    const before = {
      selfPos: self.position.clone(),
      enemyPos: enemy.position.clone(),
      selfHp: self.hp,
      enemyHp: enemy.hp,
      selfFacing: self.facing,
      enemyState: enemy.state,
    };
    const ai = createAIController(AI_PROFILES.veteran, 321);
    runFrames(ai, ctx, 180);
    expect(self.position.equals(before.selfPos)).toBe(true);
    expect(enemy.position.equals(before.enemyPos)).toBe(true);
    expect(self.hp).toBe(before.selfHp);
    expect(enemy.hp).toBe(before.enemyHp);
    expect(self.facing).toBe(before.selfFacing);
    expect(enemy.state).toBe(before.enemyState);
  });

  it('is deterministic for a given seed and diverges for a different seed', () => {
    const run = (seed: number): string[] => {
      const self = makeFighter(1, { team: 0 });
      const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0.6, 0, 2.3), facing: Math.PI });
      const ctx = makeCtx(self, [self, enemy]);
      const ai = createAIController(AI_PROFILES.fighter, seed);
      const frames: string[] = [];
      for (let i = 0; i < 300; i++) {
        ctx.time = i / 60;
        ctx.dt = 1 / 60;
        frames.push(JSON.stringify(ai.update(ctx)));
      }
      return frames;
    };
    const a = run(42);
    const b = run(42);
    const c = run(43);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it('will not spam attacks while exhausted', () => {
    const self = makeFighter(1, { team: 0, stamina: 4 });
    const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.1), facing: Math.PI });
    const ctx = makeCtx(self, [self, enemy]);
    const ai = createAIController(AI_PROFILES.champion, 8);
    const frames = runFrames(ai, ctx, 180);
    expect(frames.some((intent) => intent.attack)).toBe(false);
  });

  it('attacks when in reach against an idle opponent (all profiles)', () => {
    for (const profile of Object.values(AI_PROFILES)) {
      const self = makeFighter(1, { team: 0 });
      const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.1), facing: Math.PI });
      const ctx = makeCtx(self, [self, enemy]);
      const ai = createAIController(profile, 55);
      let attacked = false;
      runFrames(ai, ctx, 240, (intent) => {
        if (intent.attack) attacked = true;
      });
      expect(attacked, `${profile.id} should eventually attack`).toBe(true);
    }
  });

  it('reads an incoming windup and blocks it (champion) — recruits are too slow', () => {
    const blockedFrames = (profile: AIProfile, dir: AttackDir): number => {
      const self = makeFighter(1, { team: 0 });
      const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.2), facing: Math.PI });
      const ctx = makeCtx(self, [self, enemy]);
      const ai = createAIController(profile, 7);
      const windup = attackTiming(enemy.weapon).windup;
      let frames = 0;
      for (let i = 0; i < 40; i++) {
        enemy.state = 'attack';
        enemy.attackDir = dir;
        enemy.windupRemaining = windup;
        ctx.time = i / 60;
        const intent = ai.update(ctx);
        expectSanitized(intent);
        if (intent.block === dir) frames++;
      }
      return frames;
    };

    expect(blockedFrames(AI_PROFILES.champion, 'left')).toBeGreaterThan(4);
    expect(blockedFrames(AI_PROFILES.recruit, 'left')).toBe(0);
  });

  it('dodges incoming attacks when footwork is high', () => {
    const self = makeFighter(1, { team: 0 });
    const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.4), facing: Math.PI });
    const ctx = makeCtx(self, [self, enemy]);
    const ai = createAIController(AI_PROFILES.champion, 3);
    const windup = attackTiming(enemy.weapon).windup;
    let dodges = 0;
    for (let i = 0; i < 240; i++) {
      enemy.state = 'attack';
      enemy.attackDir = 'overhead';
      enemy.windupRemaining = windup;
      ctx.time = i / 60;
      if (ai.update(ctx).dodge) dodges++;
    }
    expect(dodges).toBeGreaterThan(0);
  });

  it('kicks a turtling opponent to open their guard', () => {
    const self = makeFighter(1, { team: 0 });
    const turtle = makeFighter(2, {
      team: 1,
      position: new THREE.Vector3(0, 0, 2.1),
      facing: Math.PI,
      state: 'block',
      guardDir: 'right',
    });
    const ctx = makeCtx(self, [self, turtle]);
    const ai = createAIController(AI_PROFILES.champion, 3);
    let kicks = 0;
    runFrames(ai, ctx, 240, (intent) => {
      turtle.state = 'block';
      turtle.guardDir = 'right';
      if (intent.kick) kicks++;
    });
    expect(kicks).toBeGreaterThan(0);
  });

  it('retreats from a losing multi-fighter brawl when badly wounded', () => {
    const self = makeFighter(1, { team: 0, hp: 12 });
    const enemies = [
      makeFighter(2, { team: 1, position: new THREE.Vector3(2, 0, 0), facing: Math.PI }),
      makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 2), facing: Math.PI }),
      makeFighter(4, { team: 1, position: new THREE.Vector3(-2, 0, 0), facing: Math.PI }),
    ];
    const ctx = makeCtx(self, [self, ...enemies]);
    const ai = createAIController(AI_PROFILES.recruit, 99);
    let fled = false;
    runFrames(ai, ctx, 180, (intent) => {
      // Enemy centroid is roughly +Z; fleeing means moving toward -Z.
      if (intent.moveZ < -0.25) fled = true;
    });
    expect(fled).toBe(true);
  });

  it('keeps a bruiser in the fight instead of fleeing', () => {
    const self = makeFighter(1, { team: 0, hp: 20 });
    const enemies = [
      makeFighter(2, { team: 1, position: new THREE.Vector3(2, 0, 0), facing: Math.PI }),
      makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 2), facing: Math.PI }),
      makeFighter(4, { team: 1, position: new THREE.Vector3(-2, 0, 0), facing: Math.PI }),
    ];
    const ctx = makeCtx(self, [self, ...enemies]);
    const ai = createAIController(AI_PROFILES.brute, 4);
    let attacks = 0;
    let fled = false;
    runFrames(ai, ctx, 240, (intent) => {
      // Emulate the game turning the AI toward its requested facing.
      if (intent.faceYaw !== undefined) self.facing = intent.faceYaw;
      if (intent.attack) attacks++;
      if (intent.sprint && intent.moveZ < -0.5) fled = true;
    });
    expect(attacks).toBeGreaterThan(0);
    expect(fled).toBe(false);
  });

  it('switches into a flanking approach when allies already hold the target', () => {
    const self = makeFighter(1, { team: 0, position: new THREE.Vector3(-5, 0, 0) });
    const ally = makeFighter(2, { team: 0, position: new THREE.Vector3(0, 0, 3.1) });
    const enemy = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 2.4), facing: Math.PI });
    const ctx = makeCtx(self, [self, ally, enemy]);
    const ai = createAIController(AI_PROFILES.fighter, 16);
    const frames = runFrames(ai, ctx, 90);
    // Approach direction should not be a straight line at the enemy the whole way.
    const straight = frames.every(
      (intent) =>
        Math.abs(intent.moveX) < 1e-6 ||
        intent.moveX * 1 + intent.moveZ * 0 > 0.999,
    );
    expect(straight).toBe(false);
  });

  it('separates two allies so they do not stand inside each other', () => {
    const a = makeFighter(1, { team: 0, position: new THREE.Vector3(0, 0, 0) });
    const b = makeFighter(2, { team: 0, position: new THREE.Vector3(0.15, 0, 0.1) });
    const enemy = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 9), facing: Math.PI });
    const fighters = [a, b, enemy];
    const ctx = makeCtx(a, fighters);
    const aiA = createAIController(AI_PROFILES.fighter, 31);
    const aiB = createAIController(AI_PROFILES.fighter, 32);
    const speed = 3.9;
    const dt = 1 / 60;
    for (let i = 0; i < 240; i++) {
      ctx.time = i / 60;
      ctx.self = a;
      const ia = aiA.update(ctx);
      ctx.self = b;
      const ib = aiB.update(ctx);
      a.position.x += ia.moveX * speed * dt;
      a.position.z += ia.moveZ * speed * dt;
      b.position.x += ib.moveX * speed * dt;
      b.position.z += ib.moveZ * speed * dt;
      // Emulate the game facing AI fighters toward their target (the enemy).
      a.facing = Math.atan2(enemy.position.x - a.position.x, enemy.position.z - a.position.z);
      b.facing = Math.atan2(enemy.position.x - b.position.x, enemy.position.z - b.position.z);
    }
    const gap = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
    expect(Number.isFinite(gap)).toBe(true);
    expect(gap).toBeGreaterThan(0.8);
  });

  it('handles malformed / missing context without NaN or throwing', () => {
    const ai = createAIController(AI_PROFILES.veteran, 11);
    const self = makeFighter(1, { team: 0 });
    expectSanitized(ai.update(makeCtx(self, [self], Number.NaN, Number.NaN)));

    const dead = ai.update({
      self: makeFighter(2, { alive: false }),
      fighters: [],
      arena: makeArena(),
      time: 1,
      dt: 1 / 60,
      playerId: -1,
    });
    expect(dead.moveX).toBe(0);
    expect(dead.moveZ).toBe(0);
    expect(dead.attack).toBeUndefined();

    const weird = makeCtx(self, [
      self,
      makeFighter(2, { team: 1, position: new THREE.Vector3(Number.NaN, 0, 2) }),
      makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 3), hp: Number.NaN, weapon: WEAPONS.spear }),
    ]);
    for (let i = 0; i < 60; i++) {
      weird.time = i / 60;
      expectSanitized(ai.update(weird));
    }
  });

  it('notifyDamaged biases the next target selection', () => {
    const self = makeFighter(1, { team: 0 });
    const near = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 3.5), facing: Math.PI });
    const attacker = makeFighter(3, { team: 1, position: new THREE.Vector3(0, 0, 5), facing: Math.PI });
    const ctx = makeCtx(self, [self, near, attacker]);
    const ai = createAIController(AI_PROFILES.fighter, 17);
    ai.update(ctx);
    ai.notifyDamaged?.(3, 'overhead');
    ctx.time = 1 / 60;
    expect(ai.update(ctx).lockTargetId).toBe(3);
  });

  it('hesitates before its opening swing; recruits dither longer than champions', () => {
    const firstAttackTime = (profile: AIProfile): number => {
      const self = makeFighter(1, { team: 0 });
      const enemy = makeFighter(2, { team: 1, position: new THREE.Vector3(0, 0, 2.1), facing: Math.PI });
      const ctx = makeCtx(self, [self, enemy]);
      const ai = createAIController(profile, 77);
      for (let i = 0; i < 300; i++) {
        ctx.time = i / 60;
        if (ai.update(ctx).attack) return i / 60;
      }
      return Infinity;
    };
    const recruit = firstAttackTime(AI_PROFILES.recruit);
    const fighter = firstAttackTime(AI_PROFILES.fighter);
    const champion = firstAttackTime(AI_PROFILES.champion);
    expect(recruit).toBeGreaterThan(0.8);
    expect(recruit).toBeLessThan(2.5);
    expect(fighter).toBeGreaterThan(0.6);
    expect(champion).toBeLessThan(recruit);
  });

  it('spreads off the player when two allies already converge on them', () => {
    const self = makeFighter(1, { team: 1, position: new THREE.Vector3(0, 0, 8) });
    const player = makeFighter(2, { team: 0, isPlayer: true });
    const allyA = makeFighter(3, {
      team: 1,
      position: new THREE.Vector3(0, 0, 1.6),
      facing: Math.PI,
    });
    const allyB = makeFighter(4, {
      team: 1,
      position: new THREE.Vector3(1.4, 0, 0.9),
      facing: Math.atan2(-1.4, -0.9),
    });
    const other = makeFighter(5, { team: 0, position: new THREE.Vector3(9, 0, 6) });
    const ctx = makeCtx(self, [self, player, allyA, allyB, other]);
    const target = selectTarget(ctx, tuningFor(AI_PROFILES.fighter), {
      currentTargetId: null,
      rng: () => 0.5,
      duel: false,
      ffa: false,
    });
    expect(target?.id).toBe(5);
  });

  it('circles and holds back when two allies are already swarming the player', () => {
    const player = makeFighter(1, { team: 0, isPlayer: true });
    const self = makeFighter(2, {
      team: 1,
      position: new THREE.Vector3(0, 0, 2.7),
      facing: Math.PI,
    });
    const allyA = makeFighter(3, {
      team: 1,
      position: new THREE.Vector3(0.5, 0, 1.1),
      facing: Math.PI,
    });
    const allyB = makeFighter(4, {
      team: 1,
      position: new THREE.Vector3(-0.5, 0, 1.2),
      facing: Math.PI,
    });
    const ctx = makeCtx(self, [player, self, allyA, allyB]);
    const ai = createAIController(AI_PROFILES.champion, 6);
    const frames = runFrames(ai, ctx, 300);
    expect(frames.some((intent) => intent.attack)).toBe(false);
  });

  it('stops after a single extra hit on an already-staggered player', () => {
    const player = makeFighter(1, {
      team: 0,
      isPlayer: true,
      position: new THREE.Vector3(0, 0, 2.2),
      facing: Math.PI,
      state: 'stagger',
    });
    const self = makeFighter(2, { team: 1 });
    const ctx = makeCtx(self, [player, self]);
    const ai = createAIController(AI_PROFILES.veteran, 33);
    let attacks = 0;
    for (let i = 0; i < 300; i++) {
      player.state = 'stagger';
      player.hp = 100;
      ctx.time = i / 60;
      if (ai.update(ctx).attack) attacks++;
    }
    expect(attacks).toBe(1);
  });

  it('never attacks or chases opponents who are still spawning', () => {
    const self = makeFighter(1, { team: 0 });
    const spawning = makeFighter(2, {
      team: 1,
      state: 'spawn',
      position: new THREE.Vector3(0, 0, 2.1),
      facing: Math.PI,
    });
    const ctx = makeCtx(self, [self, spawning]);
    const ai = createAIController(AI_PROFILES.fighter, 9);
    const frames = runFrames(ai, ctx, 180);
    expect(frames.some((intent) => intent.attack)).toBe(false);
    expect(frames.every((intent) => intent.lockTargetId == null)).toBe(true);
  });

  it('stays inside the performance budget (<= 0.05 ms per fighter-frame)', () => {
    const fighters: FighterInfo[] = [];
    const controllers: ReturnType<typeof createAIController>[] = [];
    for (let i = 0; i < 16; i++) {
      const team = i < 8 ? 0 : 1;
      const f = makeFighter(i + 1, {
        team,
        position: new THREE.Vector3((i % 8) * 2 - 7, 0, team === 0 ? -5 - (i % 4) : 5 + (i % 4)),
      });
      fighters.push(f);
      const profile = Object.values(AI_PROFILES)[i % Object.keys(AI_PROFILES).length];
      controllers.push(createAIController(profile, 900 + i));
    }
    const ctx = makeCtx(fighters[0], fighters);

    // Warm up.
    for (let i = 0; i < 60; i++) {
      ctx.time = i / 60;
      for (let c = 0; c < controllers.length; c++) {
        ctx.self = fighters[c];
        controllers[c].update(ctx);
      }
    }
    const frames = 300;
    const start = performance.now();
    for (let i = 0; i < frames; i++) {
      ctx.time = (60 + i) / 60;
      for (let c = 0; c < controllers.length; c++) {
        ctx.self = fighters[c];
        controllers[c].update(ctx);
      }
    }
    const elapsed = performance.now() - start;
    const perFighterFrame = elapsed / (frames * controllers.length);
    expect(perFighterFrame).toBeLessThan(0.05);
  });
});
