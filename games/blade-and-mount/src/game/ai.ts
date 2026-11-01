/**
 * BLADE & MOUNT — tactical melee AI.
 *
 * `createAIController(profile, seed)` returns a deterministic, stateful controller that emits one
 * `Intent` per frame. It never touches rigs or fighter objects; it only reads `FighterInfo`
 * snapshots and returns movement / attack / guard / dodge / kick / facing requests.
 *
 * Integration contract (what the Lead's fighter/game loop should do with the intent):
 *  - `moveX/moveZ` is a normalized world-space direction (or zero). Apply fighter movement speed
 *    (walk / sprint) toward it; strafing/backpedal naturally emerge from the direction.
 *  - `attack` is a single-frame pulse: start a swing only on the frame it appears (ignore while
 *    already attacking). The controller will not re-request before its own swing locks out.
 *  - `block` is a held guard direction: keep the guard pose for as long as it is non-null, release
 *    when null. AI raises guards before an enemy's blow lands based on `profile.reaction`.
 *  - `dodge` is a single-frame pulse with a world-space direction.
 *  - `kick` is a single-frame pulse.
 *  - `faceYaw` is the direction the AI wants to face this frame (its target, or a threat it is
 *    guarding against). If the game faces AI fighters toward their `lockTargetId` instead, that
 *    works too: `lockTargetId` is always the currently tracked target.
 *
 * All randomness is a seeded mulberry32 stream (no Math.random), so a controller with the same
 * seed and the same input sequence produces the same intents. All emitted numbers are finite.
 */

import type {
  AIContext,
  AIController,
  AIProfile,
  AttackDir,
  FighterInfo,
  GuardDir,
  Intent,
} from '../core/types';
import { ATTACK_DIRS } from '../core/types';
import { COMBAT, attackStaminaCost, attackTiming } from '../core/config';
import { angleDelta, clamp, distance2D, mulberry32, normalizeAngle } from '../core/utils';

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Approximate fighter capsule radius, used for spacing / obstacle clearance. */
const BODY_RADIUS = 0.42;
/** Distance under which other fighters push each other apart. */
const SEP_RADIUS = 1.6;
/** How far from the arena wall the AI starts steering inward. */
const EDGE_MARGIN = 1.5;
/** Hard ceiling for target acquisition (the arena is ~48m wide). */
const MAX_TARGET_DIST = 40;
/** Enemies winding up within this range are considered threats. */
const THREAT_RANGE = 4.8;
/** Radius used to decide whether an ally is already engaged with a target (anti-dogpile). */
const ENGAGED_RADIUS = 3.8;

/* ------------------------------------------------------------------ */
/* Small numeric helpers                                               */
/* ------------------------------------------------------------------ */

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function numPos(v: { x?: unknown; z?: unknown } | null | undefined): { x: number; z: number } {
  if (!v) return { x: 0, z: 0 };
  return { x: num(v.x), z: num(v.z) };
}

function yawBetween(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(bx - ax, bz - az);
}

/** Teams: `-1` means free-for-all, where everyone else is hostile. */
export function isHostile(a: FighterInfo, b: FighterInfo): boolean {
  if (!a || !b || a.id === b.id) return false;
  if (a.team === -1 || b.team === -1) return true;
  return a.team !== b.team;
}

export function isAlly(a: FighterInfo, b: FighterInfo): boolean {
  if (!a || !b || a.id === b.id) return false;
  if (a.team === -1 || b.team === -1) return false;
  return a.team === b.team;
}

/* ------------------------------------------------------------------ */
/* Profile tuning                                                      */
/* ------------------------------------------------------------------ */

/**
 * Every decision-reading knob the AI uses, derived deterministically from an `AIProfile`.
 * Values are sanitized/clamped so an out-of-range authored profile can never produce NaN.
 */
export interface AITuning {
  archetype: AIProfile['archetype'];
  skill: number;
  aggression: number;
  defense: number;
  footwork: number;
  mobility: number;

  /** Seconds of reaction time before a defensive response begins. */
  reaction: number;
  /** Idle/hesitation cadence bounds (recruits dither). */
  decisionMin: number;
  decisionMax: number;
  /** Extra pause after a completed swing before seeking another attack. */
  attackGapMin: number;
  attackGapMax: number;
  /** 0..1 chance to correctly read and block an incoming attack in time. */
  blockSkill: number;
  /** 0..1 chance to prefer a dodge over a block when a threat appears. */
  dodgeChance: number;
  /** 0..1 lateral movement preference while in range. */
  strafeStrength: number;
  /** Metres added to weapon reach for the preferred standing distance. */
  idealRangeOffset: number;
  /** Start sprinting to close distance beyond this range (metres). */
  rushDistance: number;
  /** Maximum consecutive pressure swings before slowing down. */
  comboMax: number;
  /** 0..1 chance to kick a turtling opponent. */
  kickChance: number;
  /** 0..1 chance to probe/bait before committing a swing against a turtle. */
  feintChance: number;
  /** 0..1 chance to hesitate instead of advancing when out of contact. */
  hesitation: number;
  /** Seconds after acquiring a target before the first swing (readable opening hesitation). */
  openingDelay: number;
  /** Retreat when HP fraction drops below this. */
  retreatHpFrac: number;
  /** Minimum close-range enemies before outnumbered retreat logic can trigger. */
  retreatOutnumbered: number;
  /** Stamina kept in reserve beyond the next swing's cost. */
  staminaReserve: number;
  /** How strongly the AI sticks to its current target. */
  targetStick: number;
  /** Extra target-switch jitter for free-for-all churn. */
  churn: number;
  playerBias: number;
  weakestBias: number;
  helpBias: number;
  dogpileAvoid: number;
  /** Relative weights for attack direction choice. */
  dirWeights: Record<AttackDir, number>;
}

/**
 * Derive tuning for a profile. Pure and deterministic (safe to call in tests / at spawn time).
 * Archetypes are distinct on purpose: recruits hesitate and cannot read attacks in time,
 * champions parry/dodge almost everything, brutes smash overhead and never disengage, duelists
 * fence at the edge of reach with thrusts.
 */
export function tuningFor(profile: AIProfile): AITuning {
  const skill = clamp(num(profile?.skill, 0.5), 0, 1);
  const aggression = clamp(num(profile?.aggression, 0.5), 0, 1);
  const defense = clamp(num(profile?.defense, 0.5), 0, 1);
  const footwork = clamp(num(profile?.footwork, 0.3), 0, 1);
  const mobility = clamp(num(profile?.mobility, 1), 0.5, 1.6);
  const favorite: AttackDir = profile && ATTACK_DIRS.includes(profile.favorite) ? profile.favorite : 'right';

  const dirWeights: Record<AttackDir, number> = { left: 1, right: 1, overhead: 1, thrust: 1 };
  dirWeights[favorite] *= 2.4;

  const tuning: AITuning = {
    archetype: profile?.archetype ?? 'fighter',
    skill,
    aggression,
    defense,
    footwork,
    mobility,
    reaction: Math.max(0.06, num(profile?.reaction, 0.4)),
    decisionMin: 0.55,
    decisionMax: 1.25,
    attackGapMin: 0.28,
    attackGapMax: 0.95,
    blockSkill: clamp(skill * 0.9 + defense * 0.14, 0, 1),
    dodgeChance: clamp(footwork * (0.25 + 0.45 * skill), 0, 1),
    strafeStrength: clamp(0.35 + footwork * 0.5 + skill * 0.12, 0, 1.3),
    idealRangeOffset: 0,
    rushDistance: 5.2,
    comboMax: 1 + Math.round(aggression * 2),
    kickChance: 0.12 + defense * 0.25,
    feintChance: 0,
    hesitation: 0,
    openingDelay: clamp(1.5 - skill * 1.25, 0.15, 1.5),
    retreatHpFrac: 0.3,
    retreatOutnumbered: 2,
    staminaReserve: 9 + (1 - aggression) * 14,
    targetStick: 0.9,
    churn: 0,
    playerBias: 0.7 + aggression * 0.9,
    weakestBias: 0.35 + aggression * 0.55,
    helpBias: 0.5 + defense * 0.8,
    dogpileAvoid: 1.2 + (1 - aggression) * 1.0,
    dirWeights,
  };

  switch (tuning.archetype) {
    case 'recruit':
      tuning.reaction *= 1.2;
      tuning.blockSkill *= 0.55;
      tuning.dodgeChance *= 0.2;
      tuning.strafeStrength *= 0.65;
      tuning.decisionMin *= 1.4;
      tuning.decisionMax *= 1.5;
      tuning.attackGapMin += 0.28;
      tuning.attackGapMax += 0.5;
      tuning.hesitation = 0.15;
      tuning.openingDelay *= 1.15;
      tuning.comboMax = 1;
      tuning.retreatHpFrac = 0.5;
      tuning.kickChance = 0;
      tuning.targetStick = 0.7;
      tuning.dogpileAvoid *= 1.25;
      tuning.weakestBias *= 0.7;
      tuning.playerBias *= 0.8;
      tuning.idealRangeOffset = 0.12;
      tuning.rushDistance -= 0.9;
      break;

    case 'fighter':
      tuning.comboMax = 2;
      tuning.hesitation = 0.03;
      tuning.openingDelay *= 1.0;
      tuning.attackGapMin *= 1.2;
      tuning.attackGapMax *= 1.1;
      tuning.retreatHpFrac = 0.32;
      break;

    case 'veteran':
      tuning.blockSkill = clamp(tuning.blockSkill * 1.18, 0, 0.97);
      tuning.reaction *= 0.86;
      tuning.comboMax = 3;
      tuning.kickChance += 0.18;
      tuning.feintChance = 0.25;
      tuning.openingDelay *= 0.9;
      tuning.retreatHpFrac = 0.27;
      tuning.targetStick = 1.2;
      tuning.attackGapMin *= 0.8;
      tuning.attackGapMax *= 0.8;
      tuning.dirWeights.left += 0.9;
      tuning.dirWeights.thrust += 0.3;
      break;

    case 'champion':
      tuning.blockSkill = clamp(skill * 1.06 + 0.02, 0, 0.97);
      tuning.reaction *= 0.8;
      tuning.comboMax = 4;
      tuning.dodgeChance = clamp(tuning.dodgeChance * 1.4, 0, 0.85);
      tuning.kickChance += 0.22;
      tuning.feintChance = 0.4;
      tuning.strafeStrength *= 1.15;
      tuning.retreatHpFrac = 0.22;
      tuning.openingDelay *= 0.75;
      tuning.targetStick = 1.4;
      tuning.attackGapMin *= 0.7;
      tuning.dirWeights.thrust += 0.8;
      tuning.dirWeights.overhead += 0.3;
      break;

    case 'brute':
      tuning.blockSkill *= 0.45;
      tuning.dodgeChance *= 0.3;
      tuning.strafeStrength *= 0.55;
      tuning.comboMax = 2;
      tuning.retreatHpFrac = 0.08;
      tuning.retreatOutnumbered = 99;
      tuning.openingDelay *= 0.5;
      tuning.kickChance *= 0.5;
      tuning.attackGapMin *= 0.7;
      tuning.attackGapMax *= 0.7;
      tuning.dirWeights.overhead += 2.2;
      tuning.dirWeights.left += 0.4;
      tuning.rushDistance += 1.5;
      tuning.playerBias *= 1.2;
      tuning.hesitation = 0;
      tuning.idealRangeOffset = -0.15;
      tuning.targetStick = 0.8;
      break;

    case 'duelist':
      tuning.blockSkill = clamp(tuning.blockSkill * 1.1, 0, 0.95);
      tuning.dodgeChance = clamp(tuning.dodgeChance * 1.4, 0, 0.85);
      tuning.strafeStrength *= 1.3;
      tuning.comboMax = 2;
      tuning.kickChance += 0.12;
      tuning.feintChance = 0.28;
      tuning.openingDelay *= 0.8;
      tuning.retreatHpFrac = 0.3;
      tuning.idealRangeOffset = 0.12;
      tuning.attackGapMin *= 0.9;
      tuning.dirWeights.thrust += 1.8;
      tuning.dirWeights.left += 0.2;
      tuning.targetStick = 1.1;
      break;

    default:
      break;
  }

  // Final sanitization — clamped, finite, internally consistent.
  tuning.reaction = clamp(num(tuning.reaction, 0.4), 0.06, 1.4);
  tuning.blockSkill = clamp(num(tuning.blockSkill), 0, 0.97);
  tuning.dodgeChance = clamp(num(tuning.dodgeChance), 0, 0.85);
  tuning.strafeStrength = clamp(num(tuning.strafeStrength), 0.1, 1.4);
  tuning.attackGapMin = clamp(num(tuning.attackGapMin), 0.05, 1.5);
  tuning.attackGapMax = clamp(num(tuning.attackGapMax), tuning.attackGapMin, 2.2);
  tuning.decisionMin = clamp(num(tuning.decisionMin), 0.2, 2.5);
  tuning.decisionMax = clamp(num(tuning.decisionMax), tuning.decisionMin, 3.5);
  tuning.comboMax = Math.max(1, Math.round(num(tuning.comboMax, 1)));
  tuning.kickChance = clamp(num(tuning.kickChance), 0, 1);
  tuning.feintChance = clamp(num(tuning.feintChance), 0, 1);
  tuning.hesitation = clamp(num(tuning.hesitation), 0, 0.8);
  tuning.openingDelay = clamp(num(tuning.openingDelay, 0.8), 0.1, 1.8);
  tuning.retreatHpFrac = clamp(num(tuning.retreatHpFrac), 0.05, 0.7);
  tuning.retreatOutnumbered = Math.max(1, Math.round(num(tuning.retreatOutnumbered, 2)));
  tuning.staminaReserve = clamp(num(tuning.staminaReserve), 0, 45);
  tuning.targetStick = clamp(num(tuning.targetStick), 0, 3);
  tuning.churn = clamp(num(tuning.churn), 0, 2);
  tuning.playerBias = clamp(num(tuning.playerBias), 0, 5);
  tuning.weakestBias = clamp(num(tuning.weakestBias), 0, 3);
  tuning.helpBias = clamp(num(tuning.helpBias), 0, 3);
  tuning.dogpileAvoid = clamp(num(tuning.dogpileAvoid), 0, 6);
  for (const dir of ATTACK_DIRS) tuning.dirWeights[dir] = clamp(num(tuning.dirWeights[dir], 1), 0.05, 10);

  return tuning;
}

/* ------------------------------------------------------------------ */
/* Target selection                                                    */
/* ------------------------------------------------------------------ */

export interface TargetOptions {
  currentTargetId: number | null;
  /** Deterministic RNG stream used for tactical churn/jitter. */
  rng: () => number;
  duel: boolean;
  ffa: boolean;
  /** Last fighter that damaged us (notifyDamaged), if still relevant. */
  recentAttackerId?: number | null;
}

function countAlliesEngaged(self: FighterInfo, target: FighterInfo, list: FighterInfo[], radius: number): number {
  let count = 0;
  const tx = num(target.position.x);
  const tz = num(target.position.z);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || !o.alive || o.id === self.id || !isAlly(self, o)) continue;
    const dx = num(o.position.x) - tx;
    const dz = num(o.position.z) - tz;
    if (dx * dx + dz * dz <= radius * radius) count++;
  }
  return count;
}

/**
 * Allies who are converging on (or already engaged with) `target`, plus how many of them are
 * closer to the target than `self`. Used both for anti-dogpile scoring and for the "wait your
 * turn" behaviour when several team-mates are already swarming the player.
 */
function assessAlliesConverging(
  self: FighterInfo,
  target: FighterInfo,
  list: FighterInfo[],
): { count: number; closer: number } {
  const selfPos = numPos(self.position);
  const tPos = numPos(target.position);
  const selfDist = Math.hypot(tPos.x - selfPos.x, tPos.z - selfPos.z);
  let count = 0;
  let closer = 0;
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || !o.alive || o.id === self.id || !isAlly(self, o)) continue;
    const oPos = numPos(o.position);
    const dx = tPos.x - oPos.x;
    const dz = tPos.z - oPos.z;
    const d = Math.hypot(dx, dz);
    if (!Number.isFinite(d) || d > 8.5) continue;
    let converging = d <= 2.6;
    if (!converging) {
      // Heading toward the target: treat a facing ally as committed even if still closing.
      const bearing = yawBetween(oPos.x, oPos.z, tPos.x, tPos.z);
      converging = Math.abs(angleDelta(num(o.facing), bearing)) < 1.0;
    }
    if (!converging) continue;
    count++;
    if (d < selfDist - 0.15 || (Math.abs(d - selfDist) <= 0.15 && o.id < self.id)) closer++;
  }
  return { count, closer };
}

function hasNearbyAlly(self: FighterInfo, point: { x: number; z: number }, list: FighterInfo[], radius: number): boolean {
  const px = num(point.x);
  const pz = num(point.z);
  for (let i = 0; i < list.length; i++) {
    const o = list[i];
    if (!o || !o.alive || o.id === self.id || !isAlly(self, o)) continue;
    const dx = num(o.position.x) - px;
    const dz = num(o.position.z) - pz;
    if (dx * dx + dz * dz <= radius * radius) return true;
  }
  return false;
}

/**
 * Choose the fighter to pursue. Team-aware (free-for-all treats everyone else as hostile),
 * prefers nearby/weak/vulnerable/player targets, punishes opponents recovering from a swing,
 * helps allies under attack, and spreads allies across different targets instead of dogpiling.
 * Returns null when no hostile target exists.
 */
export function selectTarget(ctx: AIContext, tuning: AITuning, opts: TargetOptions): FighterInfo | null {
  const self = ctx.self;
  const list = ctx.fighters;
  if (!self || !list) return null;

  const selfPos = numPos(self.position);
  const selfReach = num(self.weapon?.reach, 2.4);
  let best: FighterInfo | null = null;
  let bestScore = -Infinity;

  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (!f || !f.alive || f.id === self.id || !isHostile(self, f)) continue;
    // Never chase opponents who are still materialising / already out of the fight.
    if (f.state === 'spawn' || f.state === 'victory' || f.state === 'dead') continue;
    const pos = numPos(f.position);
    const d = Math.hypot(pos.x - selfPos.x, pos.z - selfPos.z);
    if (!Number.isFinite(d) || d > MAX_TARGET_DIST) continue;

    let score = 7.2 - d * 0.34;

    if (f.isPlayer) score += tuning.playerBias;

    const hpFrac = clamp(num(f.hp, 100) / Math.max(1, num(f.maxHp, 100)), 0, 1);
    score += tuning.weakestBias * (1 - hpFrac) * 3.4;

    if (f.state === 'stagger') score += 2.6;
    else if (f.state === 'attack') score += num(f.windupRemaining) > 0 ? 1.2 : 1.8;
    else if (f.state === 'block') score += 0.4;
    else if (f.state === 'dodge') score -= 0.3;

    const enemyFacing = num(f.facing);
    const bearingToMe = yawBetween(pos.x, pos.z, selfPos.x, selfPos.z);
    const facingErr = Math.abs(angleDelta(enemyFacing, bearingToMe));
    if (f.state === 'attack' && facingErr < 0.8) score += 1.6;
    else if (f.state === 'attack' && facingErr > 1.3) score -= 0.4;

    if (num(f.weapon?.reach, 2.4) > selfReach + 0.45) score -= 0.55;
    if (f.targeted) score += 0.7;

    if (opts.recentAttackerId != null && f.id === opts.recentAttackerId && d <= 14) score += 2.4;
    if (f.state === 'attack' && hasNearbyAlly(self, f.position, list, 3.6)) score += tuning.helpBias;

    const focus = assessAlliesConverging(self, f, list);
    if (focus.count > 0) {
      // Swarming the player is penalised harder so the pack spreads out / circles instead.
      const focusWeight = f.isPlayer ? 1.7 : 1;
      score -= focus.count * tuning.dogpileAvoid * (0.7 + hpFrac * 0.8) * focusWeight;
    }

    if (f.id === opts.currentTargetId) {
      // Sticky targeting keeps duels focused; free-for-all fighters churn targets.
      score += tuning.targetStick * (opts.ffa ? 0 : 1) + (opts.duel ? 1.0 : 0.45);
    }

    const jitter = opts.duel ? 0.18 : 0.55 + tuning.churn * 0.5;
    score += (opts.rng() - 0.5) * jitter;

    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Steering helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Steering that prevents fighters from overlapping or clumping. Writes a world-space push
 * vector into `out` and returns it. Allies push harder than enemies (avoid running through
 * friends), and exact overlaps are resolved deterministically from fighter ids.
 */
export function computeSeparation(
  self: FighterInfo,
  fighters: FighterInfo[],
  out: { x: number; z: number },
): { x: number; z: number } {
  out.x = 0;
  out.z = 0;
  if (!self || !fighters) return out;
  const sx = num(self.position?.x);
  const sz = num(self.position?.z);
  for (let i = 0; i < fighters.length; i++) {
    const o = fighters[i];
    if (!o || !o.alive || o.id === self.id) continue;
    const dx = sx - num(o.position?.x);
    const dz = sz - num(o.position?.z);
    const d2 = dx * dx + dz * dz;
    if (!(d2 < SEP_RADIUS * SEP_RADIUS)) continue;
    if (d2 < 1e-8) {
      // Exactly stacked: deterministic, symmetric direction so both parties separate.
      const lo = Math.min(self.id, o.id);
      const hi = Math.max(self.id, o.id);
      const a = ((lo * 61 + hi * 113) % 628) / 100;
      const sign = self.id <= o.id ? 1 : -1;
      out.x += Math.sin(a) * sign;
      out.z += Math.cos(a) * sign;
      continue;
    }
    const d = Math.sqrt(d2);
    const t = (SEP_RADIUS - d) / SEP_RADIUS;
    // Linear falloff is intentionally strong: the game loop may not resolve fighter-fighter
    // collisions, so the AI must actively steer around friends and enemies rather than overlap.
    const weight = t * (isAlly(self, o) ? 1.9 : 1.3);
    out.x += (dx / d) * weight;
    out.z += (dz / d) * weight;
  }
  return out;
}

/** Obstacle + arena bounds avoidance. Writes an inward/around steering push into `out`. */
function computeAvoidance(self: FighterInfo, arena: AIContext['arena'], out: { x: number; z: number }): void {
  out.x = 0;
  out.z = 0;
  const px = num(self.position?.x);
  const pz = num(self.position?.z);

  const obstacles = arena?.obstacles;
  if (obstacles) {
    for (let i = 0; i < obstacles.length; i++) {
      const o = obstacles[i];
      if (!o) continue;
      const ox = num(o.x);
      const oz = num(o.z);
      const r = Math.max(0.1, num(o.r));
      const dx = px - ox;
      const dz = pz - oz;
      const d = Math.hypot(dx, dz);
      const clearance = r + BODY_RADIUS + 0.35;
      if (!Number.isFinite(d)) continue;
      if (d < 1e-4) {
        const a = ((self.id * 97) % 628) / 100;
        out.x += Math.sin(a) * 1.4;
        out.z += Math.cos(a) * 1.4;
      } else if (d < clearance) {
        const push = ((clearance - d) / clearance) * 1.8;
        out.x += (dx / d) * push;
        out.z += (dz / d) * push;
      } else if (d < clearance + 1.1) {
        const push = (1 - (d - clearance) / 1.1) * 0.28;
        out.x += (dx / d) * push;
        out.z += (dz / d) * push;
      }
    }
  }

  const b = arena?.bounds;
  if (b) {
    const minX = num(b.minX, -24);
    const maxX = num(b.maxX, 24);
    const minZ = num(b.minZ, -20);
    const maxZ = num(b.maxZ, 20);
    if (px < minX + EDGE_MARGIN) out.x += ((minX + EDGE_MARGIN - px) / EDGE_MARGIN) * 1.6;
    if (px > maxX - EDGE_MARGIN) out.x -= ((px - (maxX - EDGE_MARGIN)) / EDGE_MARGIN) * 1.6;
    if (pz < minZ + EDGE_MARGIN) out.z += ((minZ + EDGE_MARGIN - pz) / EDGE_MARGIN) * 1.6;
    if (pz > maxZ - EDGE_MARGIN) out.z -= ((pz - (maxZ - EDGE_MARGIN)) / EDGE_MARGIN) * 1.6;
  }
}

function inCorner(self: FighterInfo, arena: AIContext['arena']): boolean {
  const b = arena?.bounds;
  if (!b) return false;
  const px = num(self.position?.x);
  const pz = num(self.position?.z);
  const nearX = px < num(b.minX, -24) + 2.4 || px > num(b.maxX, 24) - 2.4;
  const nearZ = pz < num(b.minZ, -20) + 2.4 || pz > num(b.maxZ, 20) - 2.4;
  return nearX && nearZ;
}

/* ------------------------------------------------------------------ */
/* Attack direction                                                    */
/* ------------------------------------------------------------------ */

/**
 * Pick an attack direction from personality weights, adapted to the situation: avoids the
 * opponent's current guard direction (less effectively for low-skill fighters), favours thrust
 * at long range and overhead at close range, and leans overhead against shields.
 */
export function chooseAttackDir(
  tuning: AITuning,
  target: FighterInfo | null,
  rand: () => number,
  distance = 2.5,
): AttackDir {
  const weights: Record<AttackDir, number> = {
    left: tuning.dirWeights.left,
    right: tuning.dirWeights.right,
    overhead: tuning.dirWeights.overhead,
    thrust: tuning.dirWeights.thrust,
  };

  if (target) {
    const guard = target.guardDir;
    if (guard) {
      // A skilled fighter avoids the guarded line; a recruit often swings straight into it.
      const avoid = 0.15 + (1 - tuning.skill) * 0.85;
      weights[guard] *= avoid;
    }
    if (target.shield) weights.overhead *= 1.12;
    if (target.state === 'attack' && num(target.windupRemaining) > 0) weights.thrust *= 1.08;
  }

  if (distance > 2.8) weights.thrust *= 1.3;
  else if (distance < 1.7) weights.overhead *= 1.25;

  let total = 0;
  for (const dir of ATTACK_DIRS) total += Math.max(0.02, weights[dir]);
  let roll = rand() * total;
  for (const dir of ATTACK_DIRS) {
    roll -= Math.max(0.02, weights[dir]);
    if (roll <= 0) return dir;
  }
  return ATTACK_DIRS[Math.floor(rand() * ATTACK_DIRS.length) % ATTACK_DIRS.length];
}

/* ------------------------------------------------------------------ */
/* Intent sanitization                                                 */
/* ------------------------------------------------------------------ */

/** Guarantee a returned intent contains only finite values and legal directions. */
export function sanitizeIntent(intent: Intent): Intent {
  const mx = num(intent.moveX);
  const mz = num(intent.moveZ);
  const len = Math.hypot(mx, mz);
  if (!Number.isFinite(len) || len < 1e-4) {
    intent.moveX = 0;
    intent.moveZ = 0;
  } else {
    intent.moveX = mx / len;
    intent.moveZ = mz / len;
  }

  if (intent.attack != null && !ATTACK_DIRS.includes(intent.attack)) delete intent.attack;
  if (intent.block != null && !ATTACK_DIRS.includes(intent.block)) intent.block = null;

  if (intent.dodge) {
    const dx = num(intent.dodge.x);
    const dz = num(intent.dodge.z);
    const dl = Math.hypot(dx, dz);
    if (!Number.isFinite(dl) || dl < 1e-4) delete intent.dodge;
    else {
      intent.dodge.x = dx / dl;
      intent.dodge.z = dz / dl;
    }
  }

  if (intent.faceYaw != null) {
    if (!Number.isFinite(intent.faceYaw)) delete intent.faceYaw;
    else intent.faceYaw = normalizeAngle(intent.faceYaw);
  }
  if (intent.lockTargetId != null && !Number.isFinite(intent.lockTargetId)) intent.lockTargetId = null;

  return intent;
}

/* ------------------------------------------------------------------ */
/* Threat reading                                                      */
/* ------------------------------------------------------------------ */

interface Threat {
  fighter: FighterInfo;
  dir: AttackDir;
  remaining: number;
  distance: number;
}

/**
 * Find the most urgent enemy currently winding up an attack aimed at us. Only windups that can
 * plausibly connect (range + facing) count, so the AI does not shy at a distant swing.
 */
function findThreat(self: FighterInfo, fighters: FighterInfo[]): Threat | null {
  let best: Threat | null = null;
  let bestScore = -Infinity;
  const selfPos = numPos(self.position);
  const selfFacing = num(self.facing);
  for (let i = 0; i < fighters.length; i++) {
    const o = fighters[i];
    if (!o || !o.alive || !isHostile(self, o)) continue;
    if (o.state === 'spawn' || o.state === 'victory') continue;
    if (o.state !== 'attack' || !o.attackDir) continue;
    const remaining = num(o.windupRemaining);
    if (remaining <= 0.001) continue;

    const oPos = numPos(o.position);
    const dx = oPos.x - selfPos.x;
    const dz = oPos.z - selfPos.z;
    const d = Math.hypot(dx, dz);
    if (!(d <= THREAT_RANGE)) continue;

    const bearingToMe = yawBetween(oPos.x, oPos.z, selfPos.x, selfPos.z);
    if (Math.abs(angleDelta(num(o.facing), bearingToMe)) > 1.15) continue;

    const reach = num(o.weapon?.reach, 2.4) + 0.7;
    if (d > reach + 0.8) continue;
    // An enemy blowing past us / behind us is less of a threat than one bearing down.
    const facingMe = Math.abs(angleDelta(selfFacing, yawBetween(selfPos.x, selfPos.z, oPos.x, oPos.z)));
    const score =
      (1 - clamp(d / THREAT_RANGE, 0, 1)) * 2.2 +
      clamp(remaining, 0, 0.6) +
      (facingMe < 1.2 ? 0.3 : 0) -
      (o.attackDir === 'thrust' ? 0.1 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = { fighter: o, dir: o.attackDir, remaining, distance: d };
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Controller                                                          */
/* ------------------------------------------------------------------ */

type ResponseKind = 'block' | 'dodge' | 'none';

interface PendingResponse {
  attackerId: number;
  dir: AttackDir;
  kind: ResponseKind;
  /** Absolute time when the reaction resolves. */
  due: number;
  /** Absolute time the defensive window ends (impact + active + slack). */
  until: number;
  dodgeX: number;
  dodgeZ: number;
}

interface DamageMemory {
  pendingAttackerId: number | null;
}

const _sep = { x: 0, z: 0 };
const _avoid = { x: 0, z: 0 };

/** Find an alive fighter by id (linear; n is tiny). */
function findFighterById(list: FighterInfo[], id: number | null): FighterInfo | null {
  if (id == null) return null;
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    if (f && f.id === id) return f.alive ? f : null;
  }
  return null;
}

/**
 * Create a tactical AI controller for one fighter.
 *
 * @param profile Personality/difficulty profile from `core/config.ts`.
 * @param seed Deterministic seed; controllers with equal seeds behave identically.
 */
export function createAIController(profile: AIProfile, seed: number): AIController {
  const tuning = tuningFor(profile);
  const rand = mulberry32((seed >>> 0) ^ 0x9e3779b9);
  const damageMemory: DamageMemory = { pendingAttackerId: null };

  /* --- persistent tactical state --- */
  let targetId: number | null = null;
  let nextRetargetAt = -1;
  let flankSign: 1 | -1 = rand() < 0.5 ? -1 : 1;
  let strafeSign: 1 | -1 = rand() < 0.5 ? -1 : 1;
  let nextStrafeFlip = -1;
  let nextHesitateCheck = -1;
  let hesitateUntil = -1;
  let openingUntil = -1;
  let acquiredTargets = 0;
  let staggerTargetId: number | null = null;
  let staggerHits = 0;
  let nextAttackAt = -1;
  let attackLockUntil = -1;
  let comboHotUntil = -1;
  let comboCount = 0;
  let lastTargetId: number | null = null;
  let lastTargetHp = -1;
  let targetGuardTime = 0;
  let probeUntil = -1;
  let pending: PendingResponse | null = null;
  let blockDir: GuardDir | null = null;
  let blockUntil = -1;
  let blockAttackerId: number | null = null;
  let nextDodgeAt = -1;
  let nextKickAt = -1;
  let retreating = false;
  let retreatUntil = -1;
  let nextRetreatAt = -1;
  let recentAttackerId: number | null = null;
  let recentAttackerUntil = -1;
  let lastTime = 0;
  let stuckTimer = 0;
  let lastX = 0;
  let lastZ = 0;
  let hasLastPos = false;

  return {
    update(ctx: AIContext): Intent {
      const self = ctx?.self;
      const fighters = ctx?.fighters ?? [];
      // Nothing to control (dead / missing): return a safe idle intent.
      if (!self || self.alive === false) {
        return { moveX: 0, moveZ: 0, sprint: false, block: null };
      }

      const dtRaw = num(ctx.dt, 1 / 60);
      const dt = clamp(dtRaw, 0, 0.1);
      const now = Math.max(0, num(ctx.time, lastTime + dt));
      lastTime = now;

      // Carry damage notifications received since the last frame into target selection.
      if (damageMemory.pendingAttackerId != null) {
        recentAttackerId = damageMemory.pendingAttackerId;
        recentAttackerUntil = now + 2.6;
        damageMemory.pendingAttackerId = null;
        nextRetargetAt = now; // react immediately: turn on whoever just hit us
        openingUntil = Math.min(openingUntil, now + 0.3); // getting hit ends the opening dither
      }
      if (recentAttackerId != null && now > recentAttackerUntil) recentAttackerId = null;

      const selfPos = numPos(self.position);
      const stamina = clamp(num(self.stamina, 100), 0, Math.max(1, num(self.maxStamina, 100)));
      const hpFrac = clamp(num(self.hp, 100) / Math.max(1, num(self.maxHp, 100)), 0, 1);
      const staminaFrac = clamp(stamina / Math.max(1, num(self.maxStamina, 100)), 0, 1);
      const selfReach = Math.max(1.2, num(self.weapon?.reach, 2.4));
      const selfState = self.state;

      /* ------------------------------------------------------------ */
      /* 1. Local situation: friends, enemies, duel vs brawl          */
      /* ------------------------------------------------------------ */
      let closeEnemies = 0;
      let closeAllies = 0;
      let nearbyEnemies = 0;
      let nearbyAllies = 0;
      let nearestEnemy: FighterInfo | null = null;
      let nearestEnemyDist = Infinity;
      const ffa = self.team === -1;

      for (let i = 0; i < fighters.length; i++) {
        const o = fighters[i];
        if (!o || !o.alive || o.id === self.id) continue;
        const oPos = numPos(o.position);
        const d = Math.hypot(oPos.x - selfPos.x, oPos.z - selfPos.z);
        if (!Number.isFinite(d)) continue;
        if (isHostile(self, o)) {
          if (d <= 5.0) closeEnemies++;
          if (d <= 14) nearbyEnemies++;
          if (d < nearestEnemyDist) {
            nearestEnemyDist = d;
            nearestEnemy = o;
          }
        } else if (isAlly(self, o)) {
          if (d <= 5.0) closeAllies++;
          if (d <= 14) nearbyAllies++;
        }
      }

      const duel = !ffa && nearbyEnemies <= 1;
      const brawl = !duel;

      /* ------------------------------------------------------------ */
      /* 2. Target acquisition / switching                            */
      /* ------------------------------------------------------------ */
      let target = findFighterById(fighters, targetId);
      if (target && !isHostile(self, target)) target = null;

      const stale =
        nextRetargetAt < 0 ||
        now >= nextRetargetAt ||
        (target != null && distance2D(self.position, target.position) > 26);

      if (!target || stale) {
        const previousId = targetId;
        target = selectTarget(ctx, tuning, {
          currentTargetId: targetId,
          rng: rand,
          duel,
          ffa,
          recentAttackerId: recentAttackerId != null ? recentAttackerId : null,
        });
        targetId = target ? target.id : null;
        if (targetId !== previousId) {
          flankSign = rand() < 0.5 ? -1 : 1;
          targetGuardTime = 0;
          lastTargetHp = target ? num(target.hp, 100) : -1;
          lastTargetId = targetId;
          comboCount = 0;
          lastX = selfPos.x;
          lastZ = selfPos.z;
          hasLastPos = true;
          // Readable opening hesitation: the first target is measured much longer than a
          // mid-fight switch. Low-skill profiles give the opponent a real window to react.
          const openingBase = acquiredTargets === 0 ? tuning.openingDelay : tuning.openingDelay * 0.4;
          openingUntil = now + openingBase * (0.9 + rand() * 0.25);
          acquiredTargets++;
        }
        const retargetBase = duel ? 2.1 : ffa ? 0.8 : 1.5;
        nextRetargetAt = now + retargetBase * (0.8 + rand() * 0.5);
      }

      // If the target is not visible yet but enemies exist, chase the nearest ready one.
      if (
        !target &&
        nearestEnemy &&
        nearestEnemy.state !== 'spawn' &&
        nearestEnemy.state !== 'victory' &&
        nearestEnemy.state !== 'dead'
      ) {
        target = nearestEnemy;
      }

      const targetPos = target ? numPos(target.position) : { x: selfPos.x, z: selfPos.z };
      const targetDist = target ? Math.hypot(targetPos.x - selfPos.x, targetPos.z - selfPos.z) : Infinity;
      const toTargetYaw = target ? yawBetween(selfPos.x, selfPos.z, targetPos.x, targetPos.z) : num(self.facing);
      const facingErr = target ? Math.abs(angleDelta(num(self.facing), toTargetYaw)) : Math.PI;

      // Anti-focus-fire: if two or more team-mates are already closing on the player, the
      // extras hold back and circle instead of piling on. Only the two closest commit.
      const focus = target ? assessAlliesConverging(self, target, fighters) : { count: 0, closer: 0 };
      const playerGang = !!target && target.isPlayer && focus.count >= 2 && focus.closer >= 2;

      // Combat-mode tuning: duels are patient, brawls are more opportunistic.
      const aggression =
        clamp(tuning.aggression + (duel ? 0.06 : brawl ? 0.1 : 0), 0, 1);
      const idealRange = clamp(
        selfReach + tuning.idealRangeOffset + (duel ? 0.05 : 0),
        1.35,
        3.4,
      );

      /* ------------------------------------------------------------ */
      /* 3. Non-actionable states: no voluntary actions               */
      /* ------------------------------------------------------------ */
      if (
        selfState === 'stagger' ||
        selfState === 'dodge' ||
        selfState === 'spawn' ||
        selfState === 'victory'
      ) {
        pending = null;
        blockDir = null;
        return sanitizeIntent({
          moveX: 0,
          moveZ: 0,
          sprint: false,
          block: null,
          faceYaw: target ? toTargetYaw : num(self.facing),
          lockTargetId: target ? target.id : null,
        });
      }

      /* ------------------------------------------------------------ */
      /* 4. Defensive reaction (read windup, delay by reaction time)  */
      /* ------------------------------------------------------------ */
      if (nextStrafeFlip < 0 || now >= nextStrafeFlip) {
        strafeSign = rand() < 0.5 ? -1 : 1;
        nextStrafeFlip = now + 1.1 + rand() * 2.3;
      }

      // Expire a held guard once its attack window has passed or the attacker is gone.
      if (blockDir != null) {
        const attacker = findFighterById(fighters, blockAttackerId);
        if (!attacker || now > blockUntil || (attacker.state !== 'attack' && now > blockUntil - 0.12)) {
          blockDir = null;
          blockAttackerId = null;
        }
      }

      let dodgeNow = false;
      let dodgeX = 0;
      let dodgeZ = 0;
      let defending = blockDir != null;

      const canDefend = selfState !== 'attack';
      const threat = canDefend ? findThreat(self, fighters) : null;

      if (canDefend && blockDir == null && threat) {
        if (!pending || pending.attackerId !== threat.fighter.id) {
          const impactAt = now + Math.max(0, threat.remaining);
          const haste = 0.78 + rand() * 0.5;
          // Reading the windup pose gives a head start; profile.reaction stays the base latency.
          const due = now + tuning.reaction * 0.7 * haste;
          // Only react if the response can actually start before the blow lands.
          if (due <= impactAt + 0.06) {
            const canDodge = now >= nextDodgeAt && stamina >= COMBAT.dodge.stamina + 2;
            const dodgeRoll = canDodge ? tuning.dodgeChance : 0;
            const roll = rand();
            let kind: ResponseKind = 'none';
            if (roll < dodgeRoll) kind = 'dodge';
            else if (roll < dodgeRoll + tuning.blockSkill) kind = 'block';
            if (kind !== 'none') {
              const aPos = numPos(threat.fighter.position);
              const awayX = selfPos.x - aPos.x;
              const awayZ = selfPos.z - aPos.z;
              const al = Math.hypot(awayX, awayZ) || 1;
              const nx = awayX / al;
              const nz = awayZ / al;
              const side =
                threat.dir === 'left' ? 1 : threat.dir === 'right' ? -1 : rand() < 0.5 ? -1 : 1;
              const lateral = -nz * side;
              const lateralZ = nx * side;
              let ddx = lateral + nx * 0.55;
              let ddz = lateralZ + nz * 0.55;
              const dl = Math.hypot(ddx, ddz) || 1;
              ddx /= dl;
              ddz /= dl;
              pending = {
                attackerId: threat.fighter.id,
                dir: threat.dir,
                kind,
                due,
                until: impactAt + 0.22,
                dodgeX: ddx,
                dodgeZ: ddz,
              };
            }
          }
        }
      }

      if (pending) {
        const attacker = findFighterById(fighters, pending.attackerId);
        if (!attacker || now > pending.until) {
          pending = null;
        } else if (now >= pending.due) {
          if (pending.kind === 'block') {
            blockDir = pending.dir;
            blockAttackerId = pending.attackerId;
            blockUntil = pending.until;
            defending = true;
          } else if (
            pending.kind === 'dodge' &&
            now >= nextDodgeAt &&
            stamina >= COMBAT.dodge.stamina + 2
          ) {
            dodgeNow = true;
            dodgeX = pending.dodgeX;
            dodgeZ = pending.dodgeZ;
            nextDodgeAt =
              now + COMBAT.dodge.cooldown * (1.18 - tuning.skill * 0.28) + rand() * 0.2;
            // Skilled fighters convert a dodge into a counter-attack window.
            nextAttackAt = Math.min(nextAttackAt, now + 0.3);
          }
          pending = null;
        }
      }

      /* ------------------------------------------------------------ */
      /* 5. Retreat / disengage hysteresis                            */
      /* ------------------------------------------------------------ */
      const outnumbered =
        closeEnemies >= tuning.retreatOutnumbered &&
        closeEnemies > closeAllies + 1 &&
        !duel;
      const cornered = inCorner(self, ctx.arena);

      // Brutes never give ground; everyone else can disengage in short bursts when losing badly.
      if (tuning.archetype === 'brute') retreating = false;
      else if (!retreating) {
        const lowHp = hpFrac <= tuning.retreatHpFrac;
        const losing =
          outnumbered ||
          closeEnemies >= 3 ||
          staminaFrac <= 0.18 ||
          (tuning.archetype === 'recruit' && hpFrac <= tuning.retreatHpFrac * 0.7);
        const inDanger =
          hpFrac <= tuning.retreatHpFrac + 0.1 &&
          outnumbered;
        if (
          now >= nextRetreatAt &&
          !cornered &&
          closeEnemies > 0 &&
          ((lowHp && losing) || inDanger)
        ) {
          retreating = true;
          retreatUntil = now + 1.8 + rand() * 1.3;
        }
      } else {
        const recovered = hpFrac >= tuning.retreatHpFrac + 0.12;
        const lonePursuer = closeEnemies <= 1 && hpFrac > tuning.retreatHpFrac * 0.75;
        const expired = now > retreatUntil;
        if (closeEnemies === 0 || expired || (recovered && !outnumbered) || lonePursuer) {
          retreating = false;
          nextRetreatAt = now + 3.5;
        }
      }
      if (retreating && cornered) {
        // Fight, don't hug the wall — but don't instantly re-trigger either.
        retreating = false;
        nextRetreatAt = now + 2.5;
      }

      /* ------------------------------------------------------------ */
      /* 6. Offence decision                                          */
      /* ------------------------------------------------------------ */
      let attackDirOut: AttackDir | undefined;
      let kickOut = false;

      const targetReady =
        !!target &&
        target.alive &&
        target.state !== 'spawn' &&
        target.state !== 'dead' &&
        target.state !== 'victory';
      const staggerLocked = !!target && target.isPlayer && target.state === 'stagger' && staggerHits >= 1;

      if (
        !dodgeNow &&
        !defending &&
        !retreating &&
        !pending &&
        !playerGang &&
        !staggerLocked &&
        target !== null &&
        targetReady &&
        selfState !== 'attack'
      ) {
        const cost = attackStaminaCost(self.weapon);
        const canStamina = stamina >= cost + tuning.staminaReserve;
        const facingOk = facingErr < 0.55;
        // Low-skill fighters commit from a little too far away and whiff more often.
        const attackReach = selfReach + 0.28 + (1 - tuning.skill) * 0.32;
        const rangeOk = targetDist <= attackReach;
        const animReady = now >= attackLockUntil;
        const cadenceReady = now >= nextAttackAt;
        const openingReady = now >= openingUntil;
        const turtle = targetGuardTime > 0.42 && target.state === 'block';
        const opening = isOpening(target, selfPos);
        const backstab =
          Math.abs(angleDelta(num(target.facing), yawBetween(targetPos.x, targetPos.z, selfPos.x, selfPos.z))) > 1.25;
        const expose = opening || backstab;
        const willPunish = expose && rand() < 0.5 + tuning.skill * 0.45;
        const comboHot = now < comboHotUntil;

        if (facingOk && rangeOk && canStamina && animReady && openingReady && (cadenceReady || willPunish)) {
          // Kick a shield turtle / very close opponent out of their guard.
          const kickReady =
            now >= nextKickAt &&
            targetDist <= COMBAT.kick.range - 0.15 &&
            stamina >= COMBAT.kick.stamina + 6 &&
            rand() < tuning.kickChance &&
            (turtle || targetDist < 1.7);
          if (kickReady) {
            kickOut = true;
            nextKickAt = now + COMBAT.kick.cooldown * (0.9 + rand() * 0.2);
            attackLockUntil = now + 0.34;
            nextAttackAt = now + 0.34;
          } else if (turtle && tuning.feintChance > 0 && probeUntil < now && rand() < tuning.feintChance) {
            // Feint-like probe: stop short, shift the guard line, then commit.
            probeUntil = now + 0.16 + rand() * 0.26;
            nextAttackAt = Math.max(nextAttackAt, probeUntil);
          } else if (probeUntil <= now) {
            attackDirOut = chooseAttackDir(tuning, target, rand, targetDist);
            const timing = attackTiming(self.weapon);
            attackLockUntil = now + timing.total + 0.05;
            const gap =
              (tuning.attackGapMin + (tuning.attackGapMax - tuning.attackGapMin) * rand()) *
              (1.35 - aggression * 0.85) *
              (1 + (1 - tuning.skill) * 0.6) * // low-skill profiles swing less often
              (comboHot ? 0.45 : 1) *
              (1 - Math.min(comboCount, tuning.comboMax) * 0.04) *
              (expose ? 0.6 : 1) *
              (brawl ? 0.85 : 1);
            nextAttackAt = attackLockUntil + Math.max(0.04, gap);
            if (target.isPlayer && target.state === 'stagger') {
              // One punish hit on a staggered player, then give them a moment to recover.
              staggerHits++;
              nextAttackAt = Math.max(nextAttackAt, attackLockUntil + 0.85);
            }
            if (comboHot) comboCount = Math.min(tuning.comboMax, comboCount + 1);
            else comboCount = 1;
          }
        }
      }

      /* ------------------------------------------------------------ */
      /* 7. Movement                                                  */
      /* ------------------------------------------------------------ */
      let primaryX = 0;
      let primaryZ = 0;
      let sprintWanted = false;

      const toTargetX = target ? (targetPos.x - selfPos.x) / (targetDist || 1) : 0;
      const toTargetZ = target ? (targetPos.z - selfPos.z) / (targetDist || 1) : 0;
      const tangentX = -toTargetZ * strafeSign;
      const tangentZ = toTargetX * strafeSign;

      // Hesitation: recruits dither when not under immediate threat.
      if (nextHesitateCheck < 0 || now >= nextHesitateCheck) {
        nextHesitateCheck = now + tuning.decisionMin + rand() * (tuning.decisionMax - tuning.decisionMin);
        if (
          tuning.hesitation > 0 &&
          nearestEnemyDist > 3.2 &&
          !defending &&
          !dodgeNow &&
          rand() < tuning.hesitation
        ) {
          hesitateUntil = now + 0.18 + rand() * 0.4;
        }
      }
      const hesitating = now < hesitateUntil;

      if (selfState === 'attack') {
        // During our own swing: press in slightly if short, otherwise hold the line.
        const step = targetDist > idealRange + 0.25 ? 0.55 : 0.1;
        primaryX = toTargetX * step;
        primaryZ = toTargetZ * step;
      } else if (dodgeNow) {
        primaryX = 0;
        primaryZ = 0;
      } else if (defending) {
        // Guarding: back off slightly and keep circling; never sprint into the blow.
        const guardThreat = blockAttackerId != null ? findFighterById(fighters, blockAttackerId) : threat?.fighter;
        if (guardThreat) {
          const gPos = numPos(guardThreat.position);
          const ax = selfPos.x - gPos.x;
          const az = selfPos.z - gPos.z;
          const al = Math.hypot(ax, az) || 1;
          primaryX = (ax / al) * 0.5 - (az / al) * 0.22 * strafeSign;
          primaryZ = (az / al) * 0.5 + (ax / al) * 0.22 * strafeSign;
        } else if (target) {
          primaryX = -toTargetX * 0.45 + tangentX * 0.22;
          primaryZ = -toTargetZ * 0.45 + tangentZ * 0.22;
        }
      } else if (retreating) {
        // Run from the local enemy centroid, curving toward the middle of the arena.
        let cx = 0;
        let cz = 0;
        let n = 0;
        for (let i = 0; i < fighters.length; i++) {
          const o = fighters[i];
          if (!o || !o.alive || !isHostile(self, o)) continue;
          const oPos = numPos(o.position);
          if (Math.hypot(oPos.x - selfPos.x, oPos.z - selfPos.z) <= 8) {
            cx += oPos.x;
            cz += oPos.z;
            n++;
          }
        }
        if (n > 0) {
          cx /= n;
          cz /= n;
          let ax = selfPos.x - cx;
          let az = selfPos.z - cz;
          const al = Math.hypot(ax, az);
          if (al < 0.05) {
            ax = -toTargetX || 0;
            az = -toTargetZ || 1;
          } else {
            ax /= al;
            az /= al;
          }
          const b = ctx.arena?.bounds;
          if (b) {
            const midX = (num(b.minX, -24) + num(b.maxX, 24)) * 0.5;
            const midZ = (num(b.minZ, -20) + num(b.maxZ, 20)) * 0.5;
            const tx = midX - selfPos.x;
            const tz = midZ - selfPos.z;
            const tl = Math.hypot(tx, tz) || 1;
            ax = ax * 0.65 + (tx / tl) * 0.35;
            az = az * 0.65 + (tz / tl) * 0.35;
          }
          primaryX = ax;
          primaryZ = az;
          sprintWanted = nearestEnemyDist < 4.2 && stamina > 30;
        }
      } else if (hesitating) {
        primaryX = 0;
        primaryZ = 0;
      } else if (target && playerGang) {
        // Wait your turn: hold a wider ring around the swarmed player and let the two
        // closest attackers work, without giving up positioning.
        const waitRange = idealRange + 0.55;
        if (targetDist > waitRange + 1.2) {
          primaryX = toTargetX + tangentX * 0.25;
          primaryZ = toTargetZ + tangentZ * 0.25;
          sprintWanted = false;
        } else {
          const radialCorr = clamp((targetDist - waitRange) * 1.2, -0.58, 0.58);
          primaryX = tangentX * (0.55 + tuning.strafeStrength * 0.35) + toTargetX * radialCorr * 0.7;
          primaryZ = tangentZ * (0.55 + tuning.strafeStrength * 0.35) + toTargetZ * radialCorr * 0.7;
        }
      } else if (target) {
        // Combat positioning: approach / hold the ring / backpedal out of range.
        const radial = targetDist - idealRange;
        if (targetDist > idealRange + 0.4) {
          let approachX = toTargetX;
          let approachZ = toTargetZ;
          // Flank when a teammate is already engaged with our target.
          const supported = countAlliesEngaged(self, target, fighters, ENGAGED_RADIUS) > 0;
          if (supported && !duel) {
            const ang = Math.atan2(toTargetX, toTargetZ) + flankSign * (0.5 + rand() * 0.25);
            approachX = Math.sin(ang);
            approachZ = Math.cos(ang);
          }
          primaryX = approachX + tangentX * 0.1 * tuning.strafeStrength;
          primaryZ = approachZ + tangentZ * 0.1 * tuning.strafeStrength;
          sprintWanted = targetDist > tuning.rushDistance && stamina > 26;
        } else if (targetDist < idealRange - 0.5) {
          primaryX = -toTargetX + tangentX * 0.4 * tuning.strafeStrength;
          primaryZ = -toTargetZ + tangentZ * 0.4 * tuning.strafeStrength;
        } else {
          // Circle strafe at the edge of reach, weaving a little.
          const weave = Math.sin(now * 2.3 + ((self.id * 0.7) % 6.28)) * 0.12;
          const radialCorr = clamp(radial * 1.25, -0.55, 0.55);
          primaryX =
            tangentX * tuning.strafeStrength +
            toTargetX * radialCorr * 0.75 +
            toTargetZ * weave;
          primaryZ =
            tangentZ * tuning.strafeStrength +
            toTargetZ * radialCorr * 0.75 -
            toTargetX * weave;
          // Sidestep more when an enemy is swinging at us and we are not guarding.
          if (threat) {
            primaryX += tangentX * 0.35;
            primaryZ += tangentZ * 0.35;
          }
        }
      } else if (
        nearestEnemy &&
        nearestEnemy.state !== 'spawn' &&
        nearestEnemy.state !== 'victory' &&
        nearestEnemy.state !== 'dead'
      ) {
        // No target chosen but a ready enemy exists somewhere: close the distance.
        const ePos = numPos(nearestEnemy.position);
        const dx = ePos.x - selfPos.x;
        const dz = ePos.z - selfPos.z;
        const dl = Math.hypot(dx, dz) || 1;
        primaryX = dx / dl;
        primaryZ = dz / dl;
        sprintWanted = dl > 5 && stamina > 26;
      } else {
        // Idle patrol toward the arena centre so free-for-all fighters find the action.
        const b = ctx.arena?.bounds;
        if (b) {
          const midX = (num(b.minX, -24) + num(b.maxX, 24)) * 0.5;
          const midZ = (num(b.minZ, -20) + num(b.maxZ, 20)) * 0.5;
          const dx = midX - selfPos.x;
          const dz = midZ - selfPos.z;
          const dl = Math.hypot(dx, dz);
          if (dl > 3) {
            primaryX = dx / dl * 0.8;
            primaryZ = dz / dl * 0.8;
          }
        }
      }

      // Stuck detection: if we want to move but are pinned (wall, crowd), slide sideways.
      const movedDist = Math.hypot(selfPos.x - lastX, selfPos.z - lastZ);
      lastX = selfPos.x;
      lastZ = selfPos.z;
      if (!hasLastPos) {
        hasLastPos = true;
        lastX = selfPos.x;
        lastZ = selfPos.z;
      }
      const wantsToMove = Math.hypot(primaryX, primaryZ) > 0.45;
      if (wantsToMove && selfState !== 'attack' && movedDist < dt * 0.35) {
        stuckTimer += dt;
      } else {
        stuckTimer = Math.max(0, stuckTimer - dt * 2);
      }
      if (stuckTimer > 0.4) {
        primaryX += tangentX * 0.9;
        primaryZ += tangentZ * 0.9;
        stuckTimer = 0;
        strafeSign = (strafeSign * -1) as 1 | -1;
      }

      // Separation + obstacle/wall steering.
      computeSeparation(self, fighters, _sep);
      computeAvoidance(self, ctx.arena, _avoid);
      const sepWeight = defending ? 1.2 : 1.0;
      let moveX = primaryX + _sep.x * sepWeight + _avoid.x * 1.35;
      let moveZ = primaryZ + _sep.z * sepWeight + _avoid.z * 1.35;

      const sprint = sprintWanted && !defending && !dodgeNow && stamina > 20;

      /* ------------------------------------------------------------ */
      /* 8. Facing + intent assembly                                  */
      /* ------------------------------------------------------------ */
      let faceYaw = num(self.facing);
      if (defending) {
        const guardThreat = blockAttackerId != null ? findFighterById(fighters, blockAttackerId) : threat?.fighter;
        if (guardThreat) {
          const gPos = numPos(guardThreat.position);
          faceYaw = yawBetween(selfPos.x, selfPos.z, gPos.x, gPos.z);
        } else if (target) {
          faceYaw = toTargetYaw;
        }
      } else if (target) {
        faceYaw = toTargetYaw;
      } else if (nearestEnemy) {
        const ePos = numPos(nearestEnemy.position);
        faceYaw = yawBetween(selfPos.x, selfPos.z, ePos.x, ePos.z);
      }

      const intent: Intent = {
        moveX,
        moveZ,
        sprint,
        block: defending ? blockDir : null,
        faceYaw,
        lockTargetId: target ? target.id : null,
      };
      if (attackDirOut) intent.attack = attackDirOut;
      if (kickOut) intent.kick = true;
      if (dodgeNow) intent.dodge = { x: dodgeX, z: dodgeZ };

      /* ------------------------------------------------------------ */
      /* 9. Remember target state for combo / turtle / punish logic   */
      /* ------------------------------------------------------------ */
      if (target) {
        if (lastTargetId !== target.id) {
          lastTargetId = target.id;
          lastTargetHp = num(target.hp, 100);
          targetGuardTime = 0;
        } else {
          if (num(target.hp, 100) < lastTargetHp - 0.01) comboHotUntil = now + 1.05;
          lastTargetHp = num(target.hp, 100);
        }
        if (target.state === 'block') targetGuardTime += dt;
        else targetGuardTime = 0;
        if (target.state === 'stagger') {
          if (staggerTargetId !== target.id) {
            staggerTargetId = target.id;
            staggerHits = 0;
          }
        } else if (staggerTargetId === target.id) {
          staggerTargetId = null;
          staggerHits = 0;
        }
      } else {
        targetGuardTime = 0;
        lastTargetHp = -1;
      }

      return sanitizeIntent(intent);
    },

    notifyDamaged(attackerId: number, _dir: AttackDir): void {
      if (typeof attackerId === 'number' && Number.isFinite(attackerId)) {
        damageMemory.pendingAttackerId = attackerId;
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* Offence helpers                                                     */
/* ------------------------------------------------------------------ */

/** Is the opponent currently vulnerable or committed enough to be punished? */
function isOpening(target: FighterInfo, selfPos: { x: number; z: number }): boolean {
  if (target.state === 'stagger') return true;
  if (target.state === 'dodge') return false;
  if (target.state === 'spawn' || target.state === 'victory' || target.state === 'dead') return false;
  // An enemy still winding up is dangerous, not open; a committed swing is punishable.
  if (target.state === 'attack') return num(target.windupRemaining) <= 0.001;
  // Idle / moving opponents can still react — only an exposed flank counts as an opening.
  const tPos = numPos(target.position);
  const yawToSelf = yawBetween(tPos.x, tPos.z, selfPos.x, selfPos.z);
  return Math.abs(angleDelta(num(target.facing), yawToSelf)) > 1.25;
}
