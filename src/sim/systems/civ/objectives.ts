/**
 * civil.objectives — goals, milestones, achievements, tutorial and wonders.
 * ----------------------------------------------------------------------
 * The long arc of the settlement: onboarding objectives, era milestones,
 * lifetime achievements, contextual tutorial hints, and the great works that
 * take a generation to finish.
 *
 * Milestones and achievements are pure content: a structured `Condition`
 * evaluated against `metrics.computeMetric`. Rewards are paid once and recorded
 * in `state.milestones.completed` / `state.objectives.completed`.
 *
 * Megaprojects advance from `state.megaprojects[id]` (status 'building', set by
 * actions.startMegaproject) at 1/durationDays * (1 + buildSpeed) per day. On
 * completion the permanent modifiers are picked up by society.ts and the
 * one-time `bonus` effects are applied here.
 */
import type {
  AchievementDef,
  Condition,
  MilestoneDef,
  Notification,
  SimContext,
  SimSystem,
} from '../../types';
import { LIMITS } from '../../config';
import {
  addChronicle,
  capitalOf,
  clamp,
  evalCondition,
  hasTech,
  modOf,
  pushNotification,
  setFlag,
  totalPopulation,
} from '../../core';
import { computeMetric } from '../../metrics';
import { addTempoModifier, applyEffectsCtx } from './events';
import { eraProgress } from './research';

// ---------------------------------------------------------------------------
// Conditions & rewards
// ---------------------------------------------------------------------------

function conditionTrue(ctx: SimContext, cond: Condition): boolean {
  try {
    return evalCondition(cond, ctx.s, ctx.c, (s, c, metric) => computeMetric(s, c, metric), ctx.rng);
  } catch {
    return false;
  }
}

function notifyMilestone(ctx: SimContext, text: string, icon: string): void {
  const s = ctx.s;
  pushNotification(s, text, 'milestone' as Notification['severity'], icon);
}

function payMilestoneReward(ctx: SimContext, def: MilestoneDef): void {
  const s = ctx.s;
  const reward = def.reward;
  if (!reward) return;
  if (reward.insight) {
    s.research.insight += reward.insight;
    s.research.totalInsight += reward.insight;
    s.stats.insightEarned += reward.insight;
  }
  if (reward.culture) {
    s.society.culturePoints += reward.culture;
    s.stats.cultureEarned += reward.culture;
    const cap = capitalOf(s);
    if (cap) cap.culture += reward.culture;
  }
  if (reward.treasury) {
    const cap = capitalOf(s);
    if (cap) cap.treasury += reward.treasury;
  }
}

function payAchievementReward(ctx: SimContext, def: AchievementDef): void {
  const s = ctx.s;
  const reward = def.reward;
  if (!reward) return;
  if (reward.insight) {
    s.research.insight += reward.insight;
    s.research.totalInsight += reward.insight;
    s.stats.insightEarned += reward.insight;
  }
  if (reward.culture) {
    s.society.culturePoints += reward.culture;
    s.stats.cultureEarned += reward.culture;
    const cap = capitalOf(s);
    if (cap) cap.culture += reward.culture;
  }
  if (reward.morale) {
    for (const c of s.citizens) {
      if (!c.alive) continue;
      c.morale = clamp(c.morale + reward.morale, 0, 100);
    }
    for (const co of s.cohorts) {
      if (co.count > 0) co.morale = clamp(co.morale + reward.morale, 0, 100);
    }
  }
}

// ---------------------------------------------------------------------------
// Milestones
// ---------------------------------------------------------------------------

function evaluateMilestones(ctx: SimContext): void {
  const s = ctx.s;
  for (const def of ctx.c.milestones ?? []) {
    if (!def?.id) continue;
    if (s.milestones.completed[def.id] !== undefined) continue;
    if (!conditionTrue(ctx, def.condition)) continue;
    s.milestones.completed[def.id] = ctx.tick;
    s.milestones.era = s.research.era;
    payMilestoneReward(ctx, def);
    const kind = def.kind === 'era' ? 'milestone' : def.kind === 'achievement' ? 'growth' : 'milestone';
    const title = def.chronicleTitle ?? def.name;
    const body = def.chronicleBody ?? def.desc;
    addChronicle(s, title, body, kind, def.kind === 'era' ? 3 : 2);
    notifyMilestone(ctx, `${def.name} — ${def.desc}`, def.icon || 'flag');
    const rewardBits: string[] = [];
    if (def.reward?.insight) rewardBits.push(`+${def.reward.insight} insight`);
    if (def.reward?.culture) rewardBits.push(`+${def.reward.culture} culture`);
    if (def.reward?.treasury) rewardBits.push(`+${def.reward.treasury} treasury`);
    if (rewardBits.length) ctx.notify(`Reward: ${rewardBits.join(', ')}.`, 'good', 'gift');
    if (def.kind === 'objective') ctx.chronicle(title, body, 'milestone', 2);
  }
}

// ---------------------------------------------------------------------------
// Achievements
// ---------------------------------------------------------------------------

function evaluateAchievements(ctx: SimContext): void {
  const s = ctx.s;
  for (const def of ctx.c.achievements ?? []) {
    if (!def?.id) continue;
    if (s.objectives.completed[def.id] !== undefined) continue;
    // Hidden achievements are still evaluated, but announced like any other.
    if (!conditionTrue(ctx, def.condition)) continue;
    s.objectives.completed[def.id] = ctx.tick;
    payAchievementReward(ctx, def);
    notifyMilestone(ctx, `Achievement: ${def.name} — ${def.desc}`, def.icon || 'trophy');
    ctx.chronicle(`The ${def.name}`, def.desc, 'milestone', def.hidden ? 2 : 1);
  }
}

// ---------------------------------------------------------------------------
// Current objective
// ---------------------------------------------------------------------------

function updateCurrentObjective(ctx: SimContext): void {
  const s = ctx.s;
  const era = s.research.era;
  let current: MilestoneDef | null = null;
  for (const def of ctx.c.milestones ?? []) {
    if (!def || def.kind !== 'objective') continue;
    if (s.milestones.completed[def.id] !== undefined) continue;
    if ((def.era ?? 0) > era) continue;
    current = def;
    break;
  }
  s.objectives.current = current ? current.id : '';
  if (current) {
    const prev = s.flags['objective_shown'];
    if (prev !== undefined && s.flags[`objective:${current.id}`] !== 1) {
      s.flags[`objective:${current.id}`] = 1;
      ctx.notify(`New objective: ${current.name}. ${current.desc}`, 'info', 'flag');
    }
    s.flags['objective_shown'] = 1;
  }
}

// ---------------------------------------------------------------------------
// Tutorial
// ---------------------------------------------------------------------------

const MAX_LOOKAHEAD = 2;

function processTutorial(ctx: SimContext): void {
  const s = ctx.s;
  if (!s.tutorial.active || s.tutorial.completed) return;
  const tips = [...(ctx.c.tutorial ?? [])].sort((a, b) => a.step - b.step);
  if (tips.length === 0) {
    s.tutorial.completed = true;
    return;
  }
  const seen = new Set(s.tutorial.milestonesSeen);
  for (const tip of tips) {
    if (seen.has(tip.id)) continue;
    if (tip.step < s.tutorial.step) continue;
    if (tip.step > s.tutorial.step + MAX_LOOKAHEAD) break;
    if (!conditionTrue(ctx, tip.condition)) continue;
    if (s.settings.showHints) {
      pushNotification(s, `${tip.title}: ${tip.body}`, 'info', 'hint');
    }
    s.tutorial.milestonesSeen.push(tip.id);
    if (s.tutorial.milestonesSeen.length > 64) s.tutorial.milestonesSeen.splice(0, s.tutorial.milestonesSeen.length - 64);
    if (tip.step > s.tutorial.step) s.tutorial.step = tip.step;
    break; // one hint per day at most
  }
  if (s.tutorial.step >= tips[tips.length - 1]!.step) {
    const allSeen = tips.every((tip) => s.tutorial.milestonesSeen.includes(tip.id));
    if (allSeen) {
      s.tutorial.completed = true;
      ctx.notify('The first lessons are learned. The rest is yours to discover.', 'good', 'hint');
    }
  }
}

// ---------------------------------------------------------------------------
// Megaprojects
// ---------------------------------------------------------------------------

function processMegaprojects(ctx: SimContext): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  const buildSpeed = 1 + modOf(ctx, cap?.id ?? -1, 'buildSpeed');
  for (const id of ctx.c.megaprojectOrder ?? []) {
    const def = ctx.c.megaprojects[id];
    if (!def) continue;
    let mp = s.megaprojects[id];
    if (!mp) {
      mp = { status: 'locked', progress: 0, startedTick: -1, invested: {} };
      s.megaprojects[id] = mp;
    }
    if (mp.status === 'done') continue;
    if (mp.status === 'locked') {
      const eraOk = s.research.era >= def.era;
      const techOk = (def.requiresTech ?? []).every((t) => hasTech(s, t));
      if (eraOk && techOk) {
        mp.status = 'available';
        ctx.notify(`A great work becomes possible: ${def.name}.`, 'good', 'spark');
      }
      continue;
    }
    if (mp.status === 'building') {
      const duration = Math.max(1, def.durationDays);
      mp.progress = clamp(mp.progress + (1 / duration) * Math.max(0.2, buildSpeed), 0, 1);
      if (mp.progress >= 1) {
        mp.status = 'done';
        mp.progress = 1;
        setFlag(s, `megaproject_done:${id}`, 1);
        addChronicle(
          s,
          def.completionChronicle?.title ?? `${def.name} is complete`,
          def.completionChronicle?.body ?? def.desc,
          'milestone',
          3,
        );
        notifyMilestone(ctx, `${def.name} is complete.`, def.icon || 'spark');
        applyEffectsCtx(ctx, def.bonus ?? [], { telegraphed: true });
        for (const c of s.citizens) {
          if (c.alive) c.morale = clamp(c.morale + 8, 0, 100);
        }
        addTempoModifier(s, { moraleRate: 0.08, cultureRate: 0.06 }, 30, `${def.name} complete`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Abandonment bookkeeping
// ---------------------------------------------------------------------------

function checkAbandonment(ctx: SimContext): void {
  const s = ctx.s;
  if (s.flags['all_abandoned'] === 1) return;
  if (s.settlements.length > 0 && totalPopulation(s) === 0) {
    setFlag(s, 'all_abandoned', 1);
    addChronicle(
      s,
      'The last hearth goes dark',
      'There is no one left to keep the fires. The wind moves through the settlement and finds no one to argue with.',
      'disaster',
      3,
    );
    pushNotification(s, 'The last hearth has gone dark.', 'bad', 'skull');
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const objectivesSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (s.settlements.length === 0) return;

  // Era progress drives the milestone bar in the UI.
  try {
    s.milestones.eraProgress = Math.round(eraProgress(ctx) * 1000) / 1000;
  } catch {
    s.milestones.eraProgress = 0;
  }
  if (s.milestones.era !== s.research.era) s.milestones.era = s.research.era;

  // Milestones are cheap and central: evaluate daily.
  try {
    evaluateMilestones(ctx);
  } catch (err) {
    ctx.log(`objectives: milestones failed: ${(err as Error).message}`);
  }
  // Achievements use broad metrics; every few days is plenty.
  if (ctx.tick % 4 === 0) {
    try {
      evaluateAchievements(ctx);
    } catch (err) {
      ctx.log(`objectives: achievements failed: ${(err as Error).message}`);
    }
  }
  updateCurrentObjective(ctx);

  try {
    processTutorial(ctx);
  } catch (err) {
    ctx.log(`objectives: tutorial failed: ${(err as Error).message}`);
  }

  try {
    processMegaprojects(ctx);
  } catch (err) {
    ctx.log(`objectives: megaprojects failed: ${(err as Error).message}`);
  }

  checkAbandonment(ctx);

  // Never let a missing/short content pack break the objective panel.
  if (s.objectives.current === undefined) s.objectives.current = '';
  void LIMITS;
};
