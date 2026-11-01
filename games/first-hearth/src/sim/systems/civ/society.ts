/**
 * civil.society — politics, classes and culture.
 * ---------------------------------------------
 * The settlement as a body politic: who works with their hands, who with their
 * head, who owns what, and whether they believe the council is worth listening
 * to on a cold morning.
 *
 * Responsibilities
 *  - Policy upkeep (influence / treasury / insight) and forced repeal of laws
 *    the settlement can no longer pay for.
 *  - Class composition from professions and professions' class mapping.
 *  - Approval, stability and crime dynamics, driven by needs, inequality,
 *    taxation, rations, work hours, policy class support, doctrine and food.
 *  - Culture generation from artists, temples, schools, festivals and the
 *    cultureRate/ festival policies.
 *  - Seasonal festivals: food and ale spent for morale and culture.
 *  - `society.mods`: recomposed each day from the sliders and permanent
 *    megaproject works; leftover temporary keys decay.
 *  - Cached settlement alerts for the UI.
 */
import type { Alert, ClassId, Settlement, SimContext, SimSystem } from '../../types';
import { DAYS_PER_SEASON, DAYS_PER_YEAR } from '../../types';
import { addTempoModifier } from './events';
import {
  buildingDef,
  capitalOf,
  clamp,
  foodDaysOf,
  modOf,
  removeStock,
  seasonOf,
  totalPopulation,
  waterDaysOf,
} from '../../core';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

const TAX_MORALE_POINT = 46; // approval points lost at 100% tax
const CLASS_IDS: ClassId[] = ['laborer', 'artisan', 'scholar', 'merchant'];

interface ClassTally {
  count: number;
  wealth: number;
  moraleSum: number;
  detailCount: number;
}

function newTally(): ClassTally {
  return { count: 0, wealth: 0, moraleSum: 0, detailCount: 0 };
}

function classOfProfession(ctx: SimContext, profession: string): ClassId {
  const meta = ctx.c.professions[profession];
  if (meta) return meta.class;
  switch (profession) {
    case 'scholar':
    case 'healer':
    case 'priest':
      return 'scholar';
    case 'smith':
    case 'carpenter':
    case 'weaver':
    case 'mason':
    case 'potter':
    case 'tanner':
    case 'miller':
    case 'baker':
    case 'artist':
      return 'artisan';
    case 'merchant':
      return 'merchant';
    default:
      return 'laborer';
  }
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

/**
 * Rebuild `society.mods`: slider laws (recomposed from scratch) plus permanent
 * megaproject works, while any leftover temporary keys decay toward zero.
 */
function recomposeMods(ctx: SimContext): void {
  const s = ctx.s;
  const society = s.society;

  // Permanent keys are recomputed from scratch below, so they must not also be
  // read back from yesterday's object (megaprojects would otherwise compound
  // every tick). Everything else is a temporary afterglow and decays.
  const perm: { -readonly [K in keyof typeof society.mods]: number } = {};
  const set = (key: keyof typeof society.mods, value: number): void => {
    if (!Number.isFinite(value)) return;
    if (Math.abs(value) < 1e-6) delete perm[key];
    else perm[key] = value;
  };
  const prev = { ...society.mods };
  const work = society.workHours;
  if (work >= 12) {
    set('workSpeed', 0.11);
    set('moraleRate', -0.05);
    set('healthRate', -0.03);
  } else if (work <= 8) {
    set('workSpeed', -0.1);
    set('moraleRate', 0.035);
    set('healthRate', 0.015);
  } else {
    set('workSpeed', 0);
    set('moraleRate', 0);
    set('healthRate', 0);
  }
  if (society.rations === 'meager') {
    set('moraleRate', (perm.moraleRate ?? 0) - 0.02);
  } else if (society.rations === 'generous') {
    set('foodConsumption', 0.12);
    set('moraleRate', (perm.moraleRate ?? 0) + 0.02);
  }
  // A heavy tax is collected less efficiently as people find ways around it.
  set('taxEfficiency', -clamp((society.taxRate - 0.12) * 0.8, 0, 0.22));

  // 3) permanent works
  for (const id in s.megaprojects) {
    const mp = s.megaprojects[id];
    if (mp.status !== 'done') continue;
    const def = ctx.c.megaprojects[id];
    if (!def?.effects) continue;
    for (const key in def.effects) {
      const k = key as keyof typeof society.mods;
      const v = def.effects[k];
      if (typeof v === 'number') set(k, (perm[k] ?? 0) + v);
    }
  }

  // 4) doctrine identity flourishes beyond its static ModifierDelta
  switch (s.research.doctrine) {
    case 'hearthkeepers':
      set('moraleFlat', (perm.moraleFlat ?? 0) + 1.5);
      break;
    case 'emberwardens':
      set('crimeRate', (perm.crimeRate ?? 0) - 0.05);
      break;
    case 'chroniclers':
      set('cultureRate', (perm.cultureRate ?? 0) + 0.06);
      break;
    case 'riverwardens':
      set('waterConsumption', (perm.waterConsumption ?? 0) - 0.04);
      break;
    case 'seedkeepers':
      set('spoilageRate', (perm.spoilageRate ?? 0) - 0.04);
      break;
    default:
      break;
  }

  // 5) compose: fresh permanent values + decayed leftovers from yesterday
  const permanentKeys = new Set<string>(Object.keys(perm));
  society.mods = { ...perm };
  for (const key in prev) {
    if (permanentKeys.has(key)) continue;
    const v = prev[key as keyof typeof prev];
    if (typeof v !== 'number') continue;
    const next = v * 0.97;
    if (Math.abs(next) >= 0.0015) society.mods[key as keyof typeof society.mods] = next;
  }
}

// ---------------------------------------------------------------------------
// Policy upkeep
// ---------------------------------------------------------------------------

function processPolicies(ctx: SimContext): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  if (!cap) return;
  for (const pid in s.society.policies) {
    if (!s.society.policies[pid]) continue;
    const def = ctx.c.policies[pid];
    if (!def) continue;
    const upkeep = def.upkeep ?? {};
    let paid = true;
    const infl = upkeep.influence ?? 0;
    const treas = upkeep.treasury ?? 0;
    const insight = upkeep.insight ?? 0;
    if (infl > 0 && cap.influence + 1e-6 < infl) paid = false;
    if (treas > 0 && cap.treasury + 1e-6 < treas) paid = false;
    if (insight > 0 && s.research.insight + 1e-6 < insight) paid = false;
    if (paid) {
      if (infl > 0) cap.influence = Math.max(0, cap.influence - infl);
      if (treas > 0) cap.treasury = Math.max(0, cap.treasury - treas);
      if (insight > 0) {
        s.research.insight = Math.max(0, s.research.insight - insight);
      }
      s.flags[`policy_ok:${pid}`] = 0;
      continue;
    }
    // Unpaid: the law is honoured on paper only. Grumbling grows.
    const unpaid = (s.flags[`policy_unpaid:${pid}`] ?? 0) + 1;
    s.flags[`policy_unpaid:${pid}`] = unpaid;
    s.society.stability = clamp(s.society.stability - 0.15, 0, 100);
    if (unpaid >= 10) {
      s.society.policies[pid] = false;
      s.society.policyHistory.push({ policy: pid, tick: ctx.tick, on: false });
      delete s.flags[`policy_unpaid:${pid}`];
      ctx.notify(`${def.name} lapses: we can no longer pay for it.`, 'warn', 'crown');
      for (const classId of CLASS_IDS) {
        const support = def.classSupport[classId] ?? 0;
        if (support > 0.2) s.society.approval = clamp(s.society.approval - 2, 0, 100);
      }
    } else if (unpaid === 2) {
      ctx.notify(`We cannot pay the keepers of ${def.name}. Pay or repeal it.`, 'warn', 'crown');
    }
  }
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

function tallyClasses(ctx: SimContext): Record<ClassId, ClassTally> {
  const s = ctx.s;
  const tallies: Record<ClassId, ClassTally> = {
    laborer: newTally(),
    artisan: newTally(),
    scholar: newTally(),
    merchant: newTally(),
  };
  for (const c of s.citizens) {
    if (!c.alive) continue;
    if (c.age < 16) continue;
    const cls = classOfProfession(ctx, c.profession);
    const t = tallies[cls];
    t.count++;
    t.detailCount++;
    t.wealth += c.wealth;
    t.moraleSum += c.morale;
  }
  for (const co of s.cohorts) {
    if (co.count <= 0 || co.ageBand === 'child') continue;
    const cls = classOfProfession(ctx, co.profession);
    const t = tallies[cls];
    t.count += co.count;
    t.moraleSum += co.morale * co.count;
    t.wealth += 0; // cohorts hold abstract wealth via class aggregate
  }
  return tallies;
}

function processClasses(ctx: SimContext): void {
  const s = ctx.s;
  const tallies = tallyClasses(ctx);
  const approval = s.society.approval;
  for (const cls of CLASS_IDS) {
    const t = tallies[cls];
    const state = s.society.classes[cls];
    const avgMorale = t.count > 0 ? t.moraleSum / t.count : 50;
    state.count = t.count;
    state.wealth = Math.round(t.wealth * 10) / 10;
    state.satisfaction = Math.round(clamp(avgMorale, 0, 100) * 10) / 10;

    // Policy support is the biggest single lever, then taxes and rations.
    let support = 0;
    let policyCount = 0;
    for (const pid in s.society.policies) {
      if (!s.society.policies[pid]) continue;
      const def = ctx.c.policies[pid];
      if (!def) continue;
      support += def.classSupport[cls] ?? 0;
      policyCount++;
    }
    let target = approval - 50;
    if (policyCount > 0) target += (support / policyCount) * 26;
    target -= (s.society.taxRate - 0.12) * 120;
    target += s.society.rations === 'generous' ? 5 : s.society.rations === 'meager' ? -8 : 0;
    target += s.society.workHours >= 12 ? -6 : s.society.workHours <= 8 ? 4 : 0;
    if (cls === 'merchant' && s.society.policies['trade_tariffs']) target -= 8;
    if (cls === 'merchant' && s.society.policies['free_ports']) target += 8;
    if (cls === 'artisan' && s.society.policies['guild_charter']) target += 10;
    if (cls === 'artisan' && s.society.policies['state_workshops']) target -= 10;
    if (cls === 'laborer' && s.society.policies['poor_relief']) target += 8;
    if (cls === 'laborer' && s.society.policies['land_commons']) target += 6;
    if (cls === 'scholar' && s.society.policies['public_schooling']) target += 8;
    if (cls === 'scholar' && s.research.doctrine === 'starwatchers') target += 3;
    target += s.research.doctrine === 'hearthkeepers' && cls === 'laborer' ? 3 : 0;
    state.approval = Math.round(clamp(state.approval + (clamp(target, -100, 100) - state.approval) * 0.1, -100, 100) * 10) / 10;

    // Class wealth slowly accumulates from incomes and trade.
    if (t.count > 0) {
      const perHead = t.wealth / t.count;
      state.wealth = Math.round((perHead * t.count + t.count * 0.02) * 10) / 10;
    }
  }
}

// ---------------------------------------------------------------------------
// Approval / stability / crime
// ---------------------------------------------------------------------------

function processMood(ctx: SimContext): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  const pop = totalPopulation(s);
  if (pop <= 0) return;

  // Weighted class approval and satisfaction.
  let weightedApproval = 0;
  let weightedSatisfaction = 0;
  let classCount = 0;
  for (const cls of CLASS_IDS) {
    const c = s.society.classes[cls];
    weightedApproval += c.approval * c.count;
    weightedSatisfaction += c.satisfaction * c.count;
    classCount += c.count;
  }
  const classApproval = classCount > 0 ? weightedApproval / classCount : 0;
  const classSatisfaction = classCount > 0 ? weightedSatisfaction / classCount : 50;

  // Individual citizens matter too, especially early when classes are thin.
  let citizenSum = 0;
  let n = 0;
  for (const c of s.citizens) {
    if (!c.alive) continue;
    citizenSum += c.morale;
    n++;
  }
  const citizenMorale = n > 0 ? citizenSum / n : classSatisfaction;
  const moraleBlend = classCount > 0 ? citizenMorale * 0.55 + classSatisfaction * 0.45 : citizenMorale;

  let approvalTarget = 46 + (moraleBlend - 50) * 0.55 + classApproval * 0.25;
  approvalTarget -= (s.society.taxRate - 0.12) * TAX_MORALE_POINT;
  approvalTarget += s.society.rations === 'generous' ? 5 : s.society.rations === 'meager' ? -8 : 0;
  approvalTarget += s.society.workHours >= 12 ? -5 : s.society.workHours <= 8 ? 3 : 0;
  approvalTarget -= s.society.crime * 0.12;
  if (cap) {
    const fd = foodDaysOf(s, ctx.c, cap);
    const wd = waterDaysOf(s, cap);
    if (fd < 3) approvalTarget -= 10;
    else if (fd > 15) approvalTarget += 3;
    if (wd < 2) approvalTarget -= 10;
    if (cap.homeless > 0) approvalTarget -= Math.min(14, cap.homeless * 1.6);
  }
  approvalTarget += s.research.doctrine === 'hearthkeepers' ? 3 : 0;
  approvalTarget += s.research.doctrine === 'chroniclers' ? 2 : 0;
  approvalTarget += s.research.doctrine === 'iron_assembly' ? -2 : 0;
  for (const pid in s.society.policies) {
    if (!s.society.policies[pid]) continue;
    const def = ctx.c.policies[pid];
    if (!def) continue;
    const support = (def.classSupport.laborer ?? 0) + (def.classSupport.artisan ?? 0) + (def.classSupport.scholar ?? 0) + (def.classSupport.merchant ?? 0);
    approvalTarget += support * 1.4;
  }
  if (cap) {
    // Building beauty and services cheer a town square.
    for (const b of ctx.s.buildings) {
      if (b.settlementId !== cap.id || b.progress < 1) continue;
      const def = buildingDef(ctx.c, b);
      if (!def) continue;
      if (def.category === 'beauty') approvalTarget += 0.12;
      if (def.service?.kind === 'safety') approvalTarget += 0.2;
      if (def.service?.kind === 'faith') approvalTarget += 0.1;
    }
  }
  approvalTarget = clamp(approvalTarget, 0, 100);
  s.society.approval = clamp(s.society.approval + (approvalTarget - s.society.approval) * 0.08, 0, 100);

  // ---- crime ---------------------------------------------------------------
  const labourCompanies = s.settlements.reduce((a, st) => a + st.workforce, 0);
  const unemployed = s.settlements.reduce((a, st) => a + st.unemployed, 0);
  const homeless = s.settlements.reduce((a, st) => a + st.homeless, 0);
  const unemploymentRate = labourCompanies > 0 ? unemployed / labourCompanies : 0;
  const homelessRate = pop > 0 ? homeless / pop : 0;
  // Rough inequality: spread of class average wealth.
  const wealths = CLASS_IDS.map((c) => s.society.classes[c].wealth);
  const rich = Math.max(...wealths);
  const poor = Math.min(...wealths);
  const inequality = rich > 1 ? clamp((rich - poor) / (rich + 1), 0, 1) : 0;
  let crimeTarget = 3;
  crimeTarget += unemploymentRate * 34;
  crimeTarget += homelessRate * 45;
  crimeTarget += inequality * 12;
  crimeTarget += s.society.taxRate * 42;
  crimeTarget += s.society.workHours >= 12 ? 5 : 0;
  crimeTarget += s.society.rations === 'meager' ? 4 : 0;
  crimeTarget -= s.society.stability * 0.03;
  crimeTarget -= s.society.approval * 0.035;
  crimeTarget *= 1 + modOf(ctx, cap?.id ?? -1, 'crimeRate');
  if (s.research.doctrine === 'emberwardens') crimeTarget -= 3;
  crimeTarget = clamp(crimeTarget, 0, 100);
  s.society.crime = clamp(s.society.crime + (crimeTarget - s.society.crime) * 0.06, 0, 100);

  // ---- stability -----------------------------------------------------------
  let stabilityTarget = 48 + s.society.approval * 0.3 - s.society.crime * 0.45;
  stabilityTarget += modOf(ctx, cap?.id ?? -1, 'stability') * 100;
  if (cap) {
    const fd = foodDaysOf(s, ctx.c, cap);
    if (fd < 2) stabilityTarget -= 13;
    else if (fd > 10) stabilityTarget += 3;
    if (cap.homeless > 0) stabilityTarget -= Math.min(10, cap.homeless * 1.2);
  }
  // A standing guard and a wall settle the streets.
  if (cap) {
    let guards = 0;
    for (const b of ctx.s.buildings) {
      if (b.settlementId !== cap.id || b.progress < 1) continue;
      const def = buildingDef(ctx.c, b);
      if (!def) continue;
      if (def.service?.kind === 'safety') guards += def.service.amount;
      if (def.category === 'defence') guards += 2;
    }
    stabilityTarget += Math.min(10, guards * 0.6);
  }
  // War with a neighbour makes the streets nervous.
  for (const civ of s.neighbors.civs) {
    if (civ.discovered && civ.relation === 'war') stabilityTarget -= 8;
  }
  stabilityTarget = clamp(stabilityTarget, 0, 100);
  s.society.stability = clamp(s.society.stability + (stabilityTarget - s.society.stability) * 0.07, 0, 100);

  // ---- legitimacy: a moot every year or so --------------------------------
  if (ctx.tick - s.society.lastElectionTick >= DAYS_PER_YEAR && ctx.tick > 32) {
    s.society.lastElectionTick = ctx.tick;
    const verdict = s.society.approval > 55 ? 'The moot affirms the council' : s.society.approval > 35 ? 'The moot is divided' : 'The moot is restive';
    ctx.notify(`${verdict} — approval ${Math.round(s.society.approval)}%.`, s.society.approval > 45 ? 'info' : 'warn', 'crown');
  }
}

// ---------------------------------------------------------------------------
// Culture & festivals
// ---------------------------------------------------------------------------

function processCulture(ctx: SimContext): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  if (!cap) return;
  let artists = 0;
  let temples = 0;
  let schools = 0;
  for (const b of s.buildings) {
    if (b.settlementId !== cap.id || b.progress < 1 || !b.enabled) continue;
    const def = buildingDef(ctx.c, b);
    if (!def) continue;
    if (def.service?.kind === 'culture') temples += def.service.amount;
    if (def.service?.kind === 'faith') temples += def.service.amount * 0.5;
    if (def.service?.kind === 'education') schools += def.service.amount;
    if (def.category === 'beauty') temples += 1;
    if (def.jobs.some((j) => j.profession === 'artist')) artists += b.workers;
    if (def.jobs.some((j) => j.profession === 'priest')) artists += b.workers * 0.6;
  }
  const cultureRate = 1 + modOf(ctx, cap.id, 'cultureRate');
  const gain = (0.02 + artists * 0.14 + temples * 0.035 + schools * 0.02 + s.society.culturePoints * 0.0005) * Math.max(0.2, cultureRate);
  s.society.culturePoints += gain;
  cap.culture += gain;
  s.stats.cultureEarned += gain;

  // Influence is the currency of persuasion: earned from culture, temples and a
  // council people actually trust. Without income every policy would lapse.
  const faithService = temples;
  // Early game should allow a first policy within ~4-6 weeks; a cultured town
  // with temples and festivals earns influence several times faster.
  let influenceGain = 0.12 + s.society.culturePoints * 0.004 + faithService * 0.04;
  influenceGain += Math.max(0, s.society.approval - 55) * 0.005;
  influenceGain += s.society.traditions.length * 0.01;
  influenceGain *= 1 + modOf(ctx, cap.id, 'cultureRate') * 0.3;
  cap.influence = Math.min(150, Math.max(0, cap.influence + influenceGain));

  // Policy traditions: the first time a law sticks, it becomes a tradition.
  const seenPolicies = new Set(s.society.traditions);
  for (const entry of s.society.policyHistory) {
    if (!entry.on) continue;
    const def = ctx.c.policies[entry.policy];
    if (!def) continue;
    const label = `The ${def.name}`;
    if (!seenPolicies.has(label) && s.society.culturePoints > 6) {
      s.society.traditions.push(label);
      seenPolicies.add(label);
      ctx.notify(`A tradition takes root: ${label}.`, 'info', 'crown');
    }
  }
  if (s.society.traditions.length > 24) s.society.traditions.splice(0, s.society.traditions.length - 24);
  if (cap.culture > 9999) cap.culture = 9999;
}

function processFestivals(ctx: SimContext): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  if (!cap) return;
  const seasonIndex = Math.floor((s.tick % DAYS_PER_YEAR) / DAYS_PER_SEASON);
  const dayInSeason = (s.tick % DAYS_PER_YEAR) % DAYS_PER_SEASON;
  if (s.society.nextFestivalTick < 0) s.society.nextFestivalTick = s.tick + (8 - dayInSeason + DAYS_PER_SEASON) % DAYS_PER_SEASON;
  const festivalTradition = !!s.society.policies['festival_tradition'];
  const sacredCalendar = !!s.society.policies['sacred_calendar'];
  const pop = Math.max(1, cap.population);
  // A festival once per season, around its middle.
  if (s.tick < s.society.nextFestivalTick || dayInSeason !== 8) return;
  s.society.nextFestivalTick = s.tick + DAYS_PER_SEASON;
  if (pop < 3) return; // one hungry settler does not throw a feast

  const foodUnits = pop * (festivalTradition ? 0.3 : 0.22) * (sacredCalendar ? 0.8 : 1);
  let spent = 0;
  // Prefer ale/wine first (that is what festivals are for), then food.
  const luxuries = ['ale', 'wine'];
  for (const res of luxuries) {
    if (spent >= foodUnits * 0.5) break;
    const take = Math.min(removeStock(cap, res, foodUnits * 0.25), foodUnits * 0.25);
    spent += take * 2;
  }
  if (spent < foodUnits) {
    let remaining = foodUnits - spent;
    for (const res in cap.stock) {
      if (remaining <= 0) break;
      const def = ctx.c.resources[res];
      if (!def?.edible) continue;
      const stock = cap.stock[res] ?? 0;
      const take = Math.min(stock, remaining / Math.max(0.1, def.edible));
      if (take <= 0) continue;
      removeStock(cap, res, take);
      remaining -= take * def.edible;
    }
    spent = foodUnits;
  }
  if (spent < foodUnits * 0.4) {
    return; // could not afford a real feast
  }
  const seasonName = seasonOf(s.tick);
  const label = `${seasonName[0].toUpperCase()}${seasonName.slice(1)} Feast`;
  s.society.festivals.push(label);
  if (s.society.festivals.length > 8) s.society.festivals.shift();
  const boost = festivalTradition ? 9 : 6;
  for (const c of s.citizens) {
    if (!c.alive) continue;
    c.morale = clamp(c.morale + boost, 0, 100);
    c.thoughts.unshift(`We feasted at the ${label}.`);
    if (c.thoughts.length > 6) c.thoughts.length = 6;
  }
  for (const co of s.cohorts) {
    if (co.count <= 0) continue;
    co.morale = clamp(co.morale + boost * 0.8, 0, 100);
  }
  const cultureGain = (4 + pop * 0.08) * (festivalTradition ? 1.4 : 1);
  s.society.culturePoints += cultureGain;
  cap.culture += cultureGain;
  s.stats.cultureEarned += cultureGain;
  addTempoModifier(s, { moraleRate: 0.05, cultureRate: 0.06 }, 3, `The ${label}`, cap.id);
  ctx.notify(`${cap.name} holds the ${label}. For one evening, no one counts the stores.`, 'good', 'flame');
  if (ctx.tick % (DAYS_PER_YEAR * 2) < DAYS_PER_SEASON) {
    ctx.chronicle(
      `The ${label}`,
      `The ${seasonName} feast is kept in ${cap.name}. There is ale, and a fire, and a story told badly twice.`,
      'society',
      1,
    );
  }
}

// ---------------------------------------------------------------------------
// Alerts (UI convenience)
// ---------------------------------------------------------------------------

function refreshAlerts(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  const kept = st.alerts.filter((a) => a.id.startsWith('bld_'));
  const alerts: Alert[] = [...kept];
  const push = (id: string, kind: Alert['kind'], severity: 1 | 2 | 3, title: string, detail: string): void => {
    const prev = kept.find((a) => a.id === id);
    alerts.push({ id, kind, severity, title, detail, sinceTick: prev ? prev.sinceTick : ctx.tick });
  };
  if (st.foodDays < 1.5) push('food', 'food', st.foodDays < 0.5 ? 3 : 2, 'Hunger', `Stores hold ${st.foodDays.toFixed(1)} days of food.`);
  else if (st.foodDays < 6) push('food_low', 'food', 1, 'Thin stores', `${st.foodDays.toFixed(1)} days of food remain.`);
  if (st.waterDays < 1.5) push('water', 'water', st.waterDays < 0.5 ? 3 : 2, 'Thirst', `Water holds ${st.waterDays.toFixed(1)} days.`);
  if (st.homeless > 0) push('housing', 'housing', st.homeless > 6 ? 2 : 1, 'Homeless', `${st.homeless} people have no roof.`);
  const workforce = st.workforce;
  if (workforce > 4 && st.unemployed / workforce > 0.35) {
    push('jobs', 'jobs', 1, 'Idle hands', `${st.unemployed} of ${workforce} workers lack a post.`);
  }
  const tile = s.world.tiles[Math.floor(st.y) * s.world.width + Math.floor(st.x)];
  const pollution = tile?.pollution ?? 0;
  if (pollution > 0.25) push('pollution', 'pollution', pollution > 0.6 ? 3 : pollution > 0.4 ? 2 : 1, 'Foul air', `Pollution around ${st.name} is ${Math.round(pollution * 100)}%.`);
  if (st.morale < 30 && st.population > 3) push('morale', 'economy', 2, 'Despair', `Morale has fallen to ${Math.round(st.morale)}.`);
  if (s.society.stability < 30 && st.population > 5) push('unrest', 'security', 2, 'Unrest', `Stability is ${Math.round(s.society.stability)}.`);
  if (s.society.crime > 35) push('crime', 'security', s.society.crime > 60 ? 3 : 1, 'Crime', `Crime has risen to ${Math.round(s.society.crime)}.`);
  st.alerts = alerts.slice(0, 8);
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const societySystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (s.settlements.length === 0) return;

  recomposeMods(ctx);
  processPolicies(ctx);
  processClasses(ctx);
  processMood(ctx);
  processCulture(ctx);
  processFestivals(ctx);

  for (const st of s.settlements) {
    refreshAlerts(ctx, st);
    st.stability = Math.round(s.society.stability * 10) / 10;
    st.morale = Math.round(clamp(st.morale, 0, 100) * 10) / 10;
  }

  // Unrest consequences: rarely, a bad night costs a building its windows.
  if (s.society.stability < 18 && s.society.crime > 45 && ctx.rng() < 0.012) {
    const cap = capitalOf(s);
    if (cap) {
      const candidates = ctx.s.buildings.filter(
        (b) => b.settlementId === cap.id && b.progress >= 1 && b.enabled && !b.typeId.includes('fire_pit'),
      );
      if (candidates.length > 0) {
        const target = candidates[Math.floor(ctx.rng() * candidates.length)];
        if (target) {
          target.condition = clamp(target.condition - 0.12, 0, 1);
          ctx.notify(`An angry crowd damages ${ctx.c.buildings[target.typeId]?.name ?? 'a building'} in ${cap.name}.`, 'bad', 'unrest');
        }
      }
    }
  }

  // Keep derived numbers finite for the UI no matter what content throws at us.
  s.society.approval = Number.isFinite(s.society.approval) ? s.society.approval : 50;
  s.society.stability = Number.isFinite(s.society.stability) ? s.society.stability : 60;
  s.society.crime = Number.isFinite(s.society.crime) ? s.society.crime : 5;
  s.society.culturePoints = Number.isFinite(s.society.culturePoints) ? s.society.culturePoints : 0;
};
