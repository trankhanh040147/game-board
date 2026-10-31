/**
 * civil.research — insight, eras and creeds.
 * -----------------------------------------
 * A settlement learns by having enough people with enough time to think, and
 * the occasional stroke of luck. Insight accumulates from scholars, schools,
 * curious citizens and culture, and is spent on the tech tree (either through
 * the UI, which calls actions.chooseTech, or by the scholars' own project in
 * `research.current`).
 *
 * Responsibilities
 *  - Daily insight income: scholars in science buildings, education, culture,
 *    population curiosity, insightFlat, researchRate.
 *  - Auto-studying `research.current` (and the queue) when it is affordable so a
 *    headless or hands-off settlement still discovers things.
 *  - Applying a completed tech's bonus, affinity, unlock flags and unlocksMechanics.
 *  - Era progression from `content.eras[i].requirement` via metrics.computeMetric.
 *  - Doctrine offers at era transitions (`research.doctrineChoices`).
 *  - Serendipity: rare flavour discoveries with an insight burst.
 */
import type { Citizen, SimContext, SimSystem, TechDef, TechId } from '../../types';
import { DAYS_PER_YEAR } from '../../types';
import {
  addChronicle,
  addStock,
  buildingDef,
  capitalOf,
  clamp,
  hasTech,
  modOf,
  pushNotification,
  setFlag,
  techAvailable,
  techsAvailable,
} from '../../core';
import { computeMetric } from '../../metrics';
import { addTempoModifier } from './events';

// ---------------------------------------------------------------------------
// Insight income
// ---------------------------------------------------------------------------

function scholarshipOf(ctx: SimContext, c: Citizen): number {
  return c.skills.scholarship ?? 0;
}

function insightIncome(ctx: SimContext): { total: number; scholars: number; base: number; education: number; culture: number } {
  const s = ctx.s;
  const cap = capitalOf(s);
  const settlementId = cap?.id ?? -1;

  // 1) Scholars working in science buildings.
  let scholars = 0;
  let skillSum = 0;
  let skilled = 0;
  for (const b of s.buildings) {
    if (b.progress < 1 || !b.enabled || b.condition < 0.2) continue;
    const def = buildingDef(ctx.c, b);
    if (!def) continue;
    const scientific = def.category === 'science' || def.jobs.some((j) => j.profession === 'scholar');
    if (!scientific) continue;
    scholars += b.workers;
    for (const id of b.workerIds) {
      const c = s.citizens.find((x) => x.id === id);
      if (c?.alive) {
        skillSum += scholarshipOf(ctx, c);
        skilled++;
      }
    }
  }
  const avgSkill = skilled > 0 ? skillSum / skilled : 38;
  const scholarInsight = scholars * ctx.rules.insightPerScholar * (0.45 + avgSkill / 100) * (1 + modOf(ctx, settlementId, 'researchRate'));

  // 2) Education and curiosity of the general population.
  const adults = clamp(computeMetric(s, ctx.c, 'adults'), 0, 4000);
  let educationSum = 0;
  let eduN = 0;
  for (const c of s.citizens) {
    if (!c.alive || c.age < 16) continue;
    educationSum += c.education;
    eduN++;
  }
  const avgEducation = eduN > 0 ? educationSum / eduN : 10;
  const base = 0.5 + adults * 0.11;
  const education = (avgEducation / 100) * Math.sqrt(Math.max(0, adults)) * 0.16;

  // 3) Culture and libraries feed the life of the mind.
  const culture = s.society.culturePoints * 0.0016;

  const total = (scholarInsight + base + education + culture) * (1 + modOf(ctx, settlementId, 'researchRate'));
  return { total, scholars: scholarInsight, base, education, culture };
}

// ---------------------------------------------------------------------------
// Completing a tech (mirrors actions.chooseTech so auto-study behaves the same)
// ---------------------------------------------------------------------------

export function completeTech(ctx: SimContext, techId: TechId): boolean {
  const s = ctx.s;
  const tech: TechDef | undefined = ctx.c.techs[techId];
  if (!tech || hasTech(s, techId)) return false;
  if (s.research.insight + 1e-6 < tech.cost) return false;
  s.research.insight -= tech.cost;
  s.research.completed[techId] = ctx.tick;
  s.stats.techsResearched++;
  s.research.affinity[tech.branch] = (s.research.affinity[tech.branch] ?? 0) + 1;

  if (tech.bonus) {
    if (tech.bonus.insight) s.research.insight += tech.bonus.insight;
    if (tech.bonus.culture) {
      const cap = capitalOf(s);
      if (cap) cap.culture += tech.bonus.culture;
    }
    if (tech.bonus.stock) {
      const cap = capitalOf(s);
      if (cap) for (const res in tech.bonus.stock) addStock(cap, res, tech.bonus.stock[res]);
    }
    if (tech.bonus.flag) setFlag(s, tech.bonus.flag, 1);
    if (tech.bonus.revealRadius) {
      const cap = capitalOf(s);
      if (cap) s.flags[`reveal_at_${cap.x}_${cap.y}`] = tech.bonus.revealRadius;
    }
  }
  // Mechanics flags are how techs switch whole systems on.
  for (const mech of tech.unlocksMechanics ?? []) {
    const already = s.flags[mech] === 1;
    setFlag(s, mech, 1);
    if (!already) {
      pushNotification(s, `New capability: ${mech.replace(/_/g, ' ')}.`, 'discovery', 'gear');
    }
  }
  pushNotification(s, `Discovery: ${tech.name} — ${tech.desc}`, 'discovery', 'star');
  addChronicle(
    s,
    `The Discovery of ${tech.name}`,
    tech.flavor || tech.desc,
    'discovery',
    tech.era >= 3 ? 2 : 1,
  );
  return true;
}

// ---------------------------------------------------------------------------
// Auto-study
// ---------------------------------------------------------------------------

function pickNextTech(ctx: SimContext): TechId | null {
  const s = ctx.s;
  const queue = s.research.queue;
  while (queue.length > 0) {
    const next = queue.shift() as TechId;
    if (techAvailable(s, ctx.c, next)) return next;
  }
  const available = techsAvailable(s, ctx.c);
  if (available.length === 0) return null;
  // Prefer the cheapest thing we can finish soon; ties go to the branch we are
  // already strong in (affinity), which gives each settlement a character.
  available.sort((a, b) => {
    const affinityA = s.research.affinity[a.branch] ?? 0;
    const affinityB = s.research.affinity[b.branch] ?? 0;
    const discountA = a.cost * (1 - Math.min(0.18, affinityA * 0.015));
    const discountB = b.cost * (1 - Math.min(0.18, affinityB * 0.015));
    return discountA - discountB || a.era - b.era || a.id.localeCompare(b.id);
  });
  return available[0]?.id ?? null;
}

function processStudy(ctx: SimContext): void {
  const s = ctx.s;
  // Player agency: scholars only study on their own when the run is explicitly
  // allowed to (headless autoplay sets auto_research=1). By default insight
  // accrues and the player chooses discoveries through actions.chooseTech.
  const auto = s.flags.auto_research === 1;
  if (!auto) return;
  const current = s.research.current;
  if (current) {
    if (hasTech(s, current) || !techAvailable(s, ctx.c, current)) {
      s.research.current = null;
    }
  }
  if (!s.research.current) {
    const next = pickNextTech(ctx);
    if (next) {
      s.research.current = next;
      const def = ctx.c.techs[next];
      if (def && ctx.tick % 7 === 3) {
        ctx.log(`research: studying ${def.name} (${def.cost} insight)`);
      }
    }
  }
  const studying = s.research.current;
  if (studying) {
    const def = ctx.c.techs[studying];
    if (def && s.research.insight >= def.cost) {
      if (completeTech(ctx, studying)) {
        s.research.current = null;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Eras & doctrines
// ---------------------------------------------------------------------------

function eraRequirementsMet(ctx: SimContext, eraIndex: number): boolean {
  const s = ctx.s;
  const era = ctx.c.eras[eraIndex];
  if (!era) return false;
  const req = era.requirement;
  if (!req) return true;
  const techs = computeMetric(s, ctx.c, 'techs');
  const population = computeMetric(s, ctx.c, 'population');
  const buildings = computeMetric(s, ctx.c, 'buildings');
  const insight = computeMetric(s, ctx.c, 'insight');
  const culture = computeMetric(s, ctx.c, 'culture');
  if (techs < (req.techs ?? 0)) return false;
  if (population < (req.population ?? 0)) return false;
  if (buildings < (req.buildings ?? 0)) return false;
  if (insight < (req.insight ?? 0)) return false;
  if (culture < (req.culture ?? 0)) return false;
  return true;
}

/** 0..1 progress toward the next era, for UI and milestones. */
export function eraProgress(ctx: SimContext): number {
  const s = ctx.s;
  const next = s.research.era + 1;
  const era = ctx.c.eras[next];
  if (!era) return 1;
  const req = era.requirement;
  if (!req) return 1;
  const ratios: number[] = [];
  const push = (got: number, need: number | undefined): void => {
    if (need === undefined || need <= 0) return;
    ratios.push(clamp(got / need, 0, 1));
  };
  push(computeMetric(s, ctx.c, 'techs'), req.techs);
  push(computeMetric(s, ctx.c, 'population'), req.population);
  push(computeMetric(s, ctx.c, 'buildings'), req.buildings);
  push(computeMetric(s, ctx.c, 'insight'), req.insight);
  push(computeMetric(s, ctx.c, 'culture'), req.culture);
  if (ratios.length === 0) return 1;
  return Math.min(...ratios);
}

function offerDoctrines(ctx: SimContext, eraIndex: number): void {
  const s = ctx.s;
  if (s.research.doctrine) return;
  const era = ctx.c.eras[eraIndex];
  if (!era) return;
  const candidates = (era.doctrines ?? []).filter((id) => !!ctx.c.doctrines[id]);
  if (candidates.length === 0) return;
  s.research.doctrineChoices = candidates.slice(0, 3);
  s.research.nextDoctrineEra = eraIndex + 1;
  const names = s.research.doctrineChoices.map((id) => ctx.c.doctrines[id]?.name ?? id).join(', ');
  ctx.notify(`A choice of creeds is offered: ${names}. Choose one in the Society panel.`, 'good', 'crown');
}

function processEras(ctx: SimContext): void {
  const s = ctx.s;
  const maxEra = Math.max(0, ctx.c.eras.length - 1);
  let advanced = 0;
  while (s.research.era < maxEra && eraRequirementsMet(ctx, s.research.era + 1) && advanced < 2) {
    s.research.era += 1;
    advanced++;
    s.milestones.era = s.research.era;
    const era = ctx.c.eras[s.research.era];
    if (!era) break;
    pushNotification(s, `A new age: ${era.name}. ${era.unlocksText}`, 'good', 'sun');
    addChronicle(s, `A new age: ${era.name}`, era.desc, 'milestone', 3);
    offerDoctrines(ctx, s.research.era);
    // A fresh age lifts spirits for a while.
    addTempoModifier(s, { moraleRate: 0.06, cultureRate: 0.05 }, 12, `A new age: ${era.name}`);
    for (const c of s.citizens) {
      if (c.alive) c.morale = clamp(c.morale + 4, 0, 100);
    }
  }
  // If a doctrine has never been chosen and an offer is outstanding for an old
  // era, refresh it against the current era's list so the player is never stuck.
  if (!s.research.doctrine && s.research.doctrineChoices.length === 0 && s.research.era > 0) {
    const era = ctx.c.eras[s.research.era];
    const candidates = (era?.doctrines ?? []).filter((id) => !!ctx.c.doctrines[id]);
    if (candidates.length > 0 && s.research.nextDoctrineEra <= s.research.era) {
      s.research.doctrineChoices = candidates.slice(0, 3);
    }
  }
}

// ---------------------------------------------------------------------------
// Serendipity
// ---------------------------------------------------------------------------

const IDEA_FLAVOURS = [
  'A child asks why the river never runs uphill. Nobody has a good answer.',
  'Someone notices that wet clay left by the fire hardens like stone.',
  'An old song has a counting pattern in it that turns out to be a calendar.',
  'A bird is seen dropping nuts on rocks. The nuts break. A thought is had.',
  'Two hunters compare a deer\'s leg to a bow and make something new.',
  'A grandmother remembers a plant that stopped a fever thirty years ago.',
  'A stone is found with a shell in it, far from any sea. The arguments last a year.',
  'Rainwater left to stand grows green, and then the sick stop drinking it and recover.',
];

function processSerendipity(ctx: SimContext): void {
  const s = ctx.s;
  let chance = 0.0045;
  for (const c of s.citizens) {
    if (c.alive && (c.traits.includes('curious') || c.traits.includes('dreamer'))) chance += 0.0015;
  }
  chance *= 1 + modOf(ctx, capitalOf(s)?.id ?? -1, 'researchRate');
  if (ctx.rng() >= chance) return;
  const amount = 1 + Math.floor(ctx.rng() * 5);
  s.research.insight += amount;
  s.research.totalInsight += amount;
  s.stats.insightEarned += amount;
  const branches = Object.keys(ctx.c.branches);
  if (branches.length > 0) {
    const branch = branches[Math.floor(ctx.rng() * branches.length)];
    if (branch) {
      s.research.affinity[branch] = (s.research.affinity[branch] ?? 0) + 0.5;
      const branchDef = ctx.c.branches[branch];
      ctx.discover(
        `${IDEA_FLAVOURS[Math.floor(ctx.rng() * IDEA_FLAVOURS.length)] ?? 'A new idea takes hold.'} (+${amount} insight, ${branchDef?.name ?? branch})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const researchSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (s.settlements.length === 0) return;
  if (ctx.c.techOrder.length === 0 && ctx.c.eras.length === 0) return;

  const income = insightIncome(ctx);
  s.research.insight += income.total;
  s.research.totalInsight += income.total;
  s.stats.insightEarned += income.total;

  processStudy(ctx);
  processEras(ctx);
  processSerendipity(ctx);

  // Yearly flavour: the settlement's scientific character.
  const year = Math.floor(ctx.tick / DAYS_PER_YEAR) + 1;
  const yearKey = `research_year_${year}`;
  if (!s.flags[yearKey]) {
    s.flags[yearKey] = 1;
    let bestBranch: string | null = null;
    let best = 0;
    for (const branch in s.research.affinity) {
      const v = s.research.affinity[branch] ?? 0;
      if (v > best) {
        best = v;
        bestBranch = branch;
      }
    }
    if (bestBranch && best >= 3) {
      const def = ctx.c.branches[bestBranch];
      if (def && ctx.tick > DAYS_PER_YEAR) {
        s.research.discoveries.push(`Year ${year}: our people lean towards ${def.name}.`);
        if (s.research.discoveries.length > 120) s.research.discoveries.shift();
      }
    }
  }

  // Keep numbers finite.
  if (!Number.isFinite(s.research.insight)) s.research.insight = 0;
  if (!Number.isFinite(s.research.totalInsight)) s.research.totalInsight = 0;
  s.research.insight = Math.max(0, s.research.insight);
};

/** Total insight per day, for the UI's "insight/day" readout. */
export function insightRate(ctx: SimContext): number {
  return Math.max(0, insightIncome(ctx).total);
}
