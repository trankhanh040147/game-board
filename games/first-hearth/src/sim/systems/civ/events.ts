/**
 * civil.events — the event director, warnings, crises and choices.
 * ---------------------------------------------------------------
 * This is the drama engine. Every day it:
 *
 *  1. maintains the list of visible WARNINGS, computed from the actual state
 *     (food days, water days, housing, unemployment, pollution, drought,
 *     epidemic risk, neighbours at war) with a cause and a lead time;
 *  2. ticks down active tempo modifiers and fires scheduled events that were
 *     telegraphed earlier;
 *  3. rolls the weighted event director: content events whose structured
 *     `condition` is true, respecting era, cooldown, `once`, `requiresFlag`,
 *     severity pacing and the settlement's tension;
 *  4. telegraphs serious crises (`telegraphDays > 0`) as scheduled events with a
 *     warning first, then fires them later;
 *  5. opens `PendingDecision`s (which pause the game in app.ts) or applies the
 *     automatic effects of simple events;
 *  6. queues event chains and records history/cooldowns.
 *
 * `applyEffects` is the shared interpreter for the whole `EventEffect` union. It
 * is deliberately independent of `SimContext` so exploration, sites, objectives
 * and actions can all call it with identical semantics.
 *
 * The module must never import `actions.ts` (actions imports us).
 */
import type {
  ActionResult,
  ActiveEvent,
  ChronicleEntry,
  Citizen,
  Condition,
  Content,
  EventChoice,
  EventDef,
  EventEffect,
  GameRules,
  GameState,
  ModifierDelta,
  Notification,
  PendingDecision,
  Settlement,
  SimContext,
  SimSystem,
  SiteDefId,
  Warning,
} from '../../types';
import { LIMITS } from '../../config';
import {
  addChronicle,
  addStock,
  buildingDef,
  canAfford,
  capitalOf,
  clamp,
  evalCondition,
  foodDaysOf,
  forEachTileInRadius,
  hasTech,
  nextId,
  payCost,
  pushNotification,
  removeStock,
  setFlag,
  setStock,
  settlementById,
  stockOf,
  tileAt,
  totalPopulation,
  waterDaysOf,
} from '../../core';
import { computeMetric } from '../../metrics';
import { createCitizen, destroyBuilding, removeCitizen, revealArea } from '../../state';
import { Rng, seedFromString, sfc32 } from '../../rng';

// ---------------------------------------------------------------------------
// Effect interpreter
// ---------------------------------------------------------------------------

export interface EffectsOptions {
  /** Settlement used for 'capital' scope (default: capitalOf(state)). */
  settlementId?: number;
  /** If false (default), population kills are capped at 15% unless telegraphed. */
  telegraphed?: boolean;
  /** Deterministic random source. Defaults to the state's own sfc32 stream. */
  rng?: () => number;
  notify?: (text: string, severity?: Notification['severity'], icon?: string) => void;
  chronicle?: (title: string, body: string, kind: ChronicleEntry['kind'], importance?: 1 | 2 | 3) => void;
}

// Global drama pacing. Complaints about "three crises in a fortnight" are the
// fastest way to make a simulation feel like a slot machine, so the director
// enforces quiet minimums between the big beats.
const SEVERITY3_MIN_GAP = 50; // days between severity-3 event *starts*
// Real-time-aware breathing room: the player should get at least ~20-30 real
// seconds between decisions at normal speed. Early game uses a wider gap.
const DECISION_GAP_BY_ERA = [60, 50, 42, 34, 28, 24, 20];
const COOLDOWN_MULTIPLIER = 2; // an event id never re-fires before 2x its cooldown

const CATEGORY_KIND: Record<EventDef['category'], ChronicleEntry['kind']> = {
  nature: 'nature',
  economy: 'trade',
  society: 'society',
  science: 'discovery',
  migration: 'society',
  conflict: 'conflict',
  discovery: 'discovery',
  omen: 'legend',
  boom: 'growth',
  crisis: 'disaster',
};

function notifyDefault(state: GameState): (text: string, severity?: Notification['severity'], icon?: string) => void {
  return (text, severity = 'info', icon = 'bell') => {
    pushNotification(state, text, severity, icon);
  };
}

function chronicleDefault(
  state: GameState,
): (title: string, body: string, kind: ChronicleEntry['kind'], importance?: 1 | 2 | 3) => void {
  return (title, body, kind, importance = 2) => {
    addChronicle(state, title, body, kind, importance);
  };
}

/** Resolve a settlement scope into concrete settlements. */
function stockTotal(st: Settlement): number {
  let total = 0;
  for (const k in st.stock) total += st.stock[k] ?? 0;
  return total;
}

function scopeSettlements(state: GameState, scope: 'capital' | 'all' | 'poorest' | 'richest', override?: number): Settlement[] {
  if (scope === 'all') return state.settlements.filter((st) => st.population > 0 || st.buildings.length > 0);
  if (scope === 'poorest' || scope === 'richest') {
    const list = state.settlements.filter((st) => st.population > 0 || st.buildings.length > 0);
    if (list.length === 0) return [];
    list.sort((a, b) => (scope === 'poorest' ? stockTotal(a) - stockTotal(b) : stockTotal(b) - stockTotal(a)));
    return list.slice(0, 1);
  }
  if (override !== undefined && override >= 0) {
    const st = settlementById(state, override);
    if (st) return [st];
  }
  const cap = capitalOf(state);
  return cap ? [cap] : [];
}

function alivePopulation(state: GameState, settlements: Settlement[]): number {
  let n = 0;
  const ids = new Set(settlements.map((st) => st.id));
  for (const c of state.citizens) if (c.alive && ids.has(c.settlementId)) n++;
  for (const co of state.cohorts) if (co.count > 0 && ids.has(co.settlementId)) n += co.count;
  return n;
}

/** Children first in folk memory, but the RNG decides who is lost. */
function pickVictims(state: GameState, settlements: Settlement[], count: number, rng: () => number): number {
  if (count <= 0) return 0;
  const ids = new Set(settlements.map((st) => st.id));
  const pool = state.citizens.filter((c) => c.alive && ids.has(c.settlementId));
  let killed = 0;
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  for (const c of pool) {
    if (killed >= count) break;
    removeCitizen(state, c, 'the disaster');
    const st = settlementById(state, c.settlementId);
    if (st) st.stats.deaths++;
    killed++;
  }
  // Not enough detailed citizens? Take from the cohorts.
  let remaining = count - killed;
  if (remaining > 0) {
    const cohorts = state.cohorts.filter((co) => co.count > 0 && ids.has(co.settlementId));
    for (const co of cohorts) {
      if (remaining <= 0) break;
      const take = Math.min(co.count, remaining);
      co.count -= take;
      remaining -= take;
      killed += take;
      state.stats.citizensDied += take;
    }
    state.cohorts = state.cohorts.filter((co) => co.count > 0);
  }
  return killed;
}

function newMigrants(
  state: GameState,
  content: Content,
  settlements: Settlement[],
  count: number,
  rng: () => number,
  profession?: string,
): number {
  const st = settlements[0];
  if (!st || count <= 0) return 0;
  let made = 0;
  for (let i = 0; i < Math.min(count, 60); i++) {
    const seedLabel = `${state.seed}:migrant:${state.tick}:${state.nextIds.citizen}:${i}`;
    const sub = new Rng(seedFromString(seedLabel));
    const c = createCitizen(state, content, sub, {
      settlementId: st.id,
      age: Math.round(16 + rng() * 30),
      profession: profession && content.professions[profession] ? (profession as Citizen['profession']) : 'idle',
    });
    c.origin = 'migrant';
    c.health = clamp(50 + rng() * 35, 0, 100);
    c.morale = clamp(45 + rng() * 25, 0, 100);
    state.stats.migrantsArrived++;
    st.stats.arrivals++;
    made++;
  }
  return made;
}

function worstKillFraction(def: EventDef): number {
  let worst = 0;
  const scan = (effects: EventEffect[] | undefined): void => {
    for (const fx of effects ?? []) {
      if (fx.kind === 'kill') worst = Math.max(worst, fx.fraction);
      if (fx.kind === 'raid') worst = Math.max(worst, Math.min(0.2, fx.strength / 100));
    }
  };
  scan(def.autoEffects);
  for (const ch of def.choices ?? []) scan(ch.effects);
  return worst;
}

/**
 * Apply any list of EventEffects to the game state.
 *
 * Safe to call outside a tick. All quantities are clamped to what actually
 * exists (never negative stock, never negative population, never more than 15%
 * of the population killed unless `opts.telegraphed` is true).
 */
export function applyEffects(
  state: GameState,
  content: Content,
  rules: GameRules,
  effects: EventEffect[],
  opts: EffectsOptions = {},
): void {
  const s = state;
  const notify = opts.notify ?? notifyDefault(s);
  const chronicle = opts.chronicle ?? chronicleDefault(s);
  const rng = opts.rng ?? (() => sfc32(s.rng));
  const capital = capitalOf(s);
  const scopeId = opts.settlementId ?? capital?.id ?? -1;

  const capitalId = (): number => {
    const cap = capitalOf(s);
    return cap ? cap.id : -1;
  };

  for (const fx of effects ?? []) {
    try {
      switch (fx.kind) {
        case 'stock': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          for (const st of targets) {
            if (fx.mode === 'mul') {
              setStock(st, fx.resource, Math.max(0, stockOf(st, fx.resource) * Math.max(0, fx.amount)));
            } else if (fx.amount >= 0) {
              addStock(st, fx.resource, fx.amount, Math.max(0, st.storageCap));
            } else {
              removeStock(st, fx.resource, Math.min(stockOf(st, fx.resource), -fx.amount));
            }
          }
          break;
        }
        case 'stockFraction': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          for (const st of targets) {
            removeStock(st, fx.resource, stockOf(st, fx.resource) * clamp(fx.fraction, 0, 1));
          }
          break;
        }
        case 'morale': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          const ids = new Set(targets.map((t) => t.id));
          for (const c of s.citizens) if (c.alive && ids.has(c.settlementId)) c.morale = clamp(c.morale + fx.amount, 0, 100);
          for (const co of s.cohorts) if (ids.has(co.settlementId)) co.morale = clamp(co.morale + fx.amount, 0, 100);
          break;
        }
        case 'health': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          const ids = new Set(targets.map((t) => t.id));
          for (const c of s.citizens) if (c.alive && ids.has(c.settlementId)) c.health = clamp(c.health + fx.amount, 0, 100);
          for (const co of s.cohorts) if (ids.has(co.settlementId)) co.health = clamp(co.health + fx.amount, 0, 100);
          break;
        }
        case 'kill': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          const pop = alivePopulation(s, targets);
          if (pop <= 0) break;
          let fraction = clamp(fx.fraction, 0, 1);
          const telegraphed = !!opts.telegraphed;
          if (!telegraphed && fraction > 0.15) {
            fraction = 0.15;
            notify('The worst was averted — the warning gave people time to prepare.', 'warn', 'warning');
          }
          if (!telegraphed && pop <= 2) fraction = 0;
          const count = Math.min(pop, Math.round(pop * fraction));
          if (count <= 0) break;
          const killed = pickVictims(s, targets, count, rng);
          if (killed > 0) {
            notify(`${killed} ${killed === 1 ? 'person' : 'people'} died: ${fx.cause}.`, 'bad', 'skull');
            chronicle(
              `${killed} dead: ${fx.cause}`,
              `${killed} of the settlement's people were lost to ${fx.cause}. ${pop - killed > 0 ? `${pop - killed} remain.` : 'The hearths are cold.'}`,
              'disaster',
              killed >= 5 ? 3 : 2,
            );
            const ids = new Set(targets.map((t) => t.id));
            for (const c of s.citizens) if (c.alive && ids.has(c.settlementId)) c.morale = clamp(c.morale - 8, 0, 100);
          }
          break;
        }
        case 'migrate': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          if (targets.length === 0) break;
          if (fx.count > 0) {
            const made = newMigrants(s, content, targets, fx.count, rng, fx.profession);
            if (made > 0) {
              notify(`${made} new ${made === 1 ? 'arrival' : 'arrivals'} join the settlement.`, 'good', 'footsteps');
            }
          } else {
            const removeCount = -fx.count;
            const st = targets[0];
            if (!st) break;
            const pool = s.citizens.filter((c) => c.alive && c.settlementId === st.id && !c.notable);
            for (let i = 0; i < removeCount && pool.length > 0; i++) {
              const idx = Math.floor(rng() * pool.length);
              const c = pool.splice(idx, 1)[0];
              if (!c) continue;
              c.alive = false;
              c.deathCause = 'left the settlement';
              c.deathTick = s.tick;
              const at = s.citizens.indexOf(c);
              if (at >= 0) s.citizens.splice(at, 1);
              st.stats.departures++;
              if (st.population > 0) st.population--;
            }
          }
          break;
        }
        case 'tempoModifier': {
          addActiveEvent(s, {
            eventId: `tempo_${fx.key}`,
            title: `Ongoing: ${fx.key}`,
            modifier: { [fx.key]: fx.value } as ModifierDelta,
            endTick: s.tick + Math.max(1, fx.days),
            settlementId: -1,
            kind: 'tempo',
          });
          break;
        }
        case 'settlementModifier': {
          const target = scopeId >= 0 ? scopeId : capitalId();
          addActiveEvent(s, {
            eventId: `place_${fx.key}`,
            title: `Ongoing: ${fx.key}`,
            modifier: { [fx.key]: fx.value } as ModifierDelta,
            endTick: s.tick + Math.max(1, fx.days),
            settlementId: target,
            kind: 'persistent',
          });
          break;
        }
        case 'tileDeposit': {
          const cap = capitalOf(s);
          if (!cap) break;
          let placed = false;
          const radius = Math.max(1, Math.round(fx.radius));
          forEachTileInRadius(s.world, cap.y * s.world.width + cap.x, radius, (t) => {
            if (placed || t.deposit) return;
            if (!t || t.elev < 0.02) return;
            t.deposit = {
              resource: fx.resource,
              amount: Math.max(0, fx.amount),
              initial: Math.max(0, fx.amount),
              quality: 0.65,
              kind: 'surface',
            };
            placed = true;
          });
          if (placed) notify(`A new ${content.resources[fx.resource]?.name ?? fx.resource} deposit is found nearby.`, 'discovery', 'pick');
          break;
        }
        case 'forest':
        case 'fertility':
        case 'pollution': {
          const cap = capitalOf(s);
          if (!cap) break;
          const radius = Math.max(1, Math.round(fx.radius));
          forEachTileInRadius(s.world, cap.y * s.world.width + cap.x, radius, (t) => {
            if (fx.kind === 'forest') {
              t.forest = clamp(t.forest + fx.amount, 0, 1);
              t.beauty = clamp(t.beauty + fx.amount * 0.4, 0, 1);
            } else if (fx.kind === 'fertility') {
              t.fertility = clamp(t.fertility + fx.amount, 0, 1);
            } else {
              t.pollution = clamp(t.pollution + fx.amount, 0, 1);
            }
          });
          break;
        }
        case 'discoverSite': {
          const sites = s.world.sites;
          if (!sites || sites.length === 0) break;
          const cap = capitalOf(s);
          let target = null as (typeof sites)[number] | null;
          const candidates = sites.filter((site) => !site.discovered);
          if (candidates.length === 0) break;
          if (fx.siteId) {
            target = candidates.find((site) => site.defId === (fx.siteId as SiteDefId)) ?? null;
          }
          if (!target) {
            target = candidates[Math.floor(rng() * candidates.length)] ?? null;
          }
          if (!target) break;
          target.discovered = true;
          target.discoveredTick = s.tick;
          s.exploration.sitesFound++;
          s.stats.sitesDiscovered++;
          revealArea(s, target.x, target.y, 2, content);
          const def = content.sites[target.defId];
          if (def) notify(`Discovered: ${def.name} — ${def.desc}`, 'discovery', 'eye');
          void cap;
          break;
        }
        case 'reveal': {
          const cap = capitalOf(s);
          if (!cap) break;
          revealArea(s, cap.x, cap.y, Math.max(1, fx.radius), content);
          break;
        }
        case 'relation': {
          const civ = s.neighbors.civs.find((n) => n.id === fx.neighborId);
          if (!civ) break;
          civ.attitude = clamp(civ.attitude + fx.amount, -100, 100);
          if (civ.discovered) {
            notify(
              `${civ.name} ${fx.amount >= 0 ? 'thinks better of us' : 'thinks worse of us'}.`,
              fx.amount >= 0 ? 'good' : 'warn',
              'flag',
            );
          }
          break;
        }
        case 'treasury': {
          const targets = scopeSettlements(s, fx.settlement, scopeId);
          for (const st of targets) st.treasury = Math.max(0, st.treasury + fx.amount);
          break;
        }
        case 'insight': {
          s.research.insight = Math.max(0, s.research.insight + fx.amount);
          s.research.totalInsight = Math.max(0, s.research.totalInsight + Math.max(0, fx.amount));
          s.stats.insightEarned += Math.max(0, fx.amount);
          break;
        }
        case 'culture': {
          s.society.culturePoints += fx.amount;
          s.stats.cultureEarned += Math.max(0, fx.amount);
          const cap = capitalOf(s);
          if (cap) cap.culture = Math.max(0, cap.culture + fx.amount);
          break;
        }
        case 'unlockBuilding': {
          setFlag(s, `unlock_building:${fx.buildingId}`, 1);
          notify(`We now know how to raise a ${content.buildings[fx.buildingId]?.name ?? fx.buildingId}.`, 'discovery', 'hammer');
          break;
        }
        case 'grantTech': {
          grantTech(s, content, fx.tech, notify, chronicle);
          break;
        }
        case 'flag': {
          setFlag(s, fx.flag, fx.value as number | boolean);
          break;
        }
        case 'chronicle': {
          chronicle(fx.title, fx.body, 'legend', fx.importance);
          break;
        }
        case 'notification': {
          notify(fx.text, fx.severity, 'bell');
          break;
        }
        case 'scheduleEvent': {
          s.events.scheduled.push({ eventId: fx.eventId, fireTick: s.tick + Math.max(0, fx.delayDays) });
          break;
        }
        case 'unlockPolicy': {
          setFlag(s, `unlock_policy:${fx.policy}`, 1);
          notify(`A new law becomes thinkable: ${content.policies[fx.policy]?.name ?? fx.policy}.`, 'good', 'crown');
          break;
        }
        case 'destroyBuildings': {
          const cap = capitalOf(s);
          if (!cap) break;
          const count = clamp(Math.round(fx.count), 0, 6);
          const candidates = s.buildings.filter((b) => b.settlementId === cap.id && b.progress >= 1);
          for (let i = 0; i < count && candidates.length > 0; i++) {
            const idx = Math.floor(rng() * candidates.length);
            const b = candidates.splice(idx, 1)[0];
            if (!b) continue;
            const def = buildingDef(content, b);
            destroyBuilding(s, content, b, 'the disaster');
            chronicle(`${def?.name ?? 'A building'} is lost`, `The ${def?.name ?? 'building'} at ${cap.name} is destroyed.`, 'disaster', 2);
          }
          break;
        }
        case 'raid': {
          const cap = capitalOf(s);
          if (!cap) break;
          const strength = Math.max(0, fx.strength);
          let defence = 0;
          for (const b of s.buildings) {
            if (b.settlementId !== cap.id || b.progress < 1) continue;
            const def = buildingDef(content, b);
            if (!def) continue;
            if (def.service?.kind === 'safety') defence += def.service.amount * 0.8;
            if (def.category === 'defence') defence += 6;
            for (const job of def.jobs) if (job.profession === 'guard') defence += b.workers * 3;
          }
          defence *= 1 + modOfEffects(s, 'combatStrength');
          const damage = Math.max(0, strength - defence);
          if (damage <= 0) {
            notify('Raiders are driven off at the palisade.', 'good', 'shield');
            s.society.stability = clamp(s.society.stability + 3, 0, 100);
            break;
          }
          const fraction = clamp(damage / 400, 0.005, 0.14);
          const pop = alivePopulation(s, [cap]);
          const killed = pickVictims(s, [cap], Math.max(0, Math.round(pop * fraction)), rng);
          for (const c of s.citizens) if (c.alive && c.settlementId === cap.id) c.morale = clamp(c.morale - 12, 0, 100);
          for (const res in cap.stock) {
            if (content.resources[res]?.edible) removeStock(cap, res, stockOf(cap, res) * clamp(damage / 900, 0, 0.25));
          }
          s.society.stability = clamp(s.society.stability - 8, 0, 100);
          notify(`Raiders strike ${cap.name}. ${killed > 0 ? `${killed} dead. ` : ''}Stores plundered.`, 'bad', 'sword');
          chronicle('Raiders at the gates', `Raiders came to ${cap.name} and were only partly turned away. ${killed} were killed.`, 'conflict', 2);
          break;
        }
        case 'spawnRefugees': {
          const targets = scopeSettlements(s, 'capital', scopeId);
          if (targets.length === 0) break;
          const st = targets[0];
          if (!st) break;
          const made = newMigrants(s, content, targets, Math.max(0, Math.round(fx.count)), rng);
          if (made > 0) {
            for (const c of s.citizens) {
              if (c.origin === 'migrant' && c.settlementId === st.id) {
                c.health = clamp(c.health - 18, 5, 100);
                c.morale = clamp(c.morale - 12, 0, 100);
                c.thoughts.unshift('We lost everything before we came here.');
              }
            }
            notify(`Refugees arrive at ${st.name}: ${made} souls with nowhere else to go.`, 'warn', 'footsteps');
          }
          break;
        }
        case 'inspiration': {
          const branch = fx.branch;
          s.research.insight = Math.max(0, s.research.insight + fx.amount);
          s.research.totalInsight = Math.max(0, s.research.totalInsight + fx.amount);
          s.stats.insightEarned += Math.max(0, fx.amount);
          if (branch) {
            s.research.affinity[branch] = (s.research.affinity[branch] ?? 0) + Math.max(0.2, fx.amount * 0.02);
            s.research.discoveries.push(`A flash of insight in ${content.branches[branch]?.name ?? branch} (+${fx.amount}).`);
            if (s.research.discoveries.length > 120) s.research.discoveries.shift();
          }
          break;
        }
        default:
          break;
      }
    } catch {
      // A malformed content effect must never take down the world.
    }
  }
  void rules;
}

/** Convenience wrapper for systems that already hold a SimContext. */
export function applyEffectsCtx(ctx: SimContext, effects: EventEffect[], opts: EffectsOptions = {}): void {
  applyEffects(ctx.s, ctx.c, ctx.rules, effects, {
    rng: ctx.rng,
    notify: opts.notify ?? ((text, severity, icon) => ctx.notify(text, severity, icon)),
    chronicle: opts.chronicle ?? ((title, body, kind, importance) => ctx.chronicle(title, body, kind, importance)),
    ...opts,
  });
}

/** Grant a tech without insight cost (event/site reward). Mirrors actions.chooseTech. */
function grantTech(
  s: GameState,
  content: Content,
  techId: string,
  notify: (text: string, severity?: Notification['severity'], icon?: string) => void,
  chronicle: (title: string, body: string, kind: ChronicleEntry['kind'], importance?: 1 | 2 | 3) => void,
): void {
  const tech = content.techs[techId];
  if (!tech || hasTech(s, techId)) return;
  s.research.completed[techId] = s.tick;
  s.stats.techsResearched++;
  s.research.affinity[tech.branch] = (s.research.affinity[tech.branch] ?? 0) + 1;
  if (tech.bonus) {
    if (tech.bonus.insight) s.research.insight += tech.bonus.insight;
    if (tech.bonus.stock) {
      const cap = capitalOf(s);
      if (cap) for (const res in tech.bonus.stock) addStock(cap, res, tech.bonus.stock[res]);
    }
    if (tech.bonus.culture) {
      const cap = capitalOf(s);
      if (cap) cap.culture += tech.bonus.culture;
    }
    if (tech.bonus.flag) setFlag(s, tech.bonus.flag, 1);
  }
  for (const mech of tech.unlocksMechanics ?? []) setFlag(s, mech, 1);
  notify(`Discovery: ${tech.name} — ${tech.desc}`, 'discovery', 'star');
  chronicle(`The Discovery of ${tech.name}`, tech.flavor || tech.desc, 'discovery', 2);
}

function modOfEffects(s: GameState, key: keyof ModifierDelta): number {
  let total = 0;
  for (const ev of s.events.active) if (ev.settlementId === -1) total += ev.modifier[key] ?? 0;
  return total;
}

/** Public helper for other systems: apply a timed global/settlement modifier. */
export function addTempoModifier(
  state: GameState,
  modifier: ModifierDelta,
  days: number,
  title: string,
  settlementId = -1,
): void {
  addActiveEvent(state, {
    eventId: `tempo_${Object.keys(modifier).join('_')}`,
    title,
    modifier,
    endTick: state.tick + Math.max(1, Math.round(days)),
    settlementId,
    kind: 'tempo',
  });
}

/** Add a timed modifier event (deduping identical keys keeps the UI sane). */
function addActiveEvent(
  s: GameState,
  spec: { eventId: string; title: string; modifier: ModifierDelta; endTick: number; settlementId: number; kind: ActiveEvent['kind'] },
): void {
  s.events.active.push({
    id: nextId(s, 'event'),
    eventId: spec.eventId,
    startTick: s.tick,
    endTick: spec.endTick,
    title: spec.title,
    modifier: spec.modifier,
    settlementId: spec.settlementId,
    kind: spec.kind,
  });
  while (s.events.active.length > LIMITS.maxActiveEvents) s.events.active.shift();
}

// ---------------------------------------------------------------------------
// Warnings — computed from the actual state every day
// ---------------------------------------------------------------------------

interface WarningDraft {
  id: string;
  severity: 1 | 2 | 3;
  title: string;
  detail: string;
  cause: string;
  metric?: number;
  threshold?: number;
  daysUntil?: number;
  actionsHint?: string;
}

export function computeWarnings(state: GameState, content: Content, rules: GameRules): Warning[] {
  const s = state;
  const out: WarningDraft[] = [];
  const cap = capitalOf(s);
  void rules;

  if (cap) {
    const fd = foodDaysOf(s, content, cap);
    if (fd < 12) {
      out.push({
        id: 'food',
        severity: fd < 1.5 ? 3 : fd < 5 ? 2 : 1,
        title: fd < 1.5 ? 'The stores are nearly empty' : 'Food stores are thin',
        detail: `${fd.toFixed(1)} days of food remain for ${Math.round(cap.population)} people.`,
        cause: `Harvests and gathering no longer keep pace with ${Math.round(cap.population)} mouths.`,
        metric: fd,
        threshold: 12,
        daysUntil: Math.max(0, fd),
        actionsHint: 'Build or staff a food building, or set rations to meager.',
      });
    }
    const wd = waterDaysOf(s, cap);
    // If people can walk to a river every day, low *stored* water is tense but
    // not lethal; say so instead of crying famine.
    let nearRiver = false;
    {
      const cx = Math.round(cap.x);
      const cy = Math.round(cap.y);
      for (let dy = -3; dy <= 3 && !nearRiver; dy++) {
        for (let dx = -3; dx <= 3 && !nearRiver; dx++) {
          const t = tileAt(s.world, cx + dx, cy + dy);
          if (t && t.water > 0.3) nearRiver = true;
        }
      }
    }
    if (wd < 10) {
      out.push({
        id: 'water',
        severity: nearRiver ? (wd < 1 ? 2 : 1) : wd < 1 ? 3 : wd < 3 ? 2 : 1,
        title: nearRiver ? 'No water in store' : wd < 1 ? 'There is no water' : 'Water is running low',
        detail: nearRiver
          ? `Stores hold ${wd.toFixed(1)} days, but people are carrying water from the river.`
          : `${wd.toFixed(1)} days of water remain.`,
        cause: nearRiver ? 'No well: the carry is long and the stores are dry.' : 'Wells and rain are not keeping up with the settlement.',
        metric: wd,
        threshold: 10,
        daysUntil: Math.max(0, wd),
        actionsHint: 'Raise a well or repair the water supply.',
      });
    }
    if (cap.homeless > 0) {
      out.push({
        id: 'housing',
        severity: cap.homeless > 12 ? 3 : cap.homeless > 4 ? 2 : 1,
        title: 'People sleep in the open',
        detail: `${cap.homeless} people have no roof.`,
        cause: 'Housing capacity is below the population.',
        metric: cap.homeless,
        threshold: 0,
        actionsHint: 'Build huts or cottages.',
      });
    }
    const workforce = cap.workforce;
    if (workforce > 4) {
      const rate = cap.unemployed / workforce;
      if (rate > 0.2) {
        out.push({
          id: 'jobs',
          severity: rate > 0.45 ? 2 : 1,
          title: 'Idle hands',
          detail: `${cap.unemployed} of ${workforce} workers have no post.`,
          cause: 'There are more workers than job slots in the settlement.',
          metric: rate,
          threshold: 0.2,
          actionsHint: 'Build workshops and gathering camps, or found a new settlement.',
        });
      }
    }
    let pollutionSum = 0;
    let pollutionN = 0;
    for (const b of s.buildings) {
      if (b.settlementId !== cap.id) continue;
      pollutionSum += s.world.tiles[b.y * s.world.width + b.x]?.pollution ?? 0;
      pollutionN++;
    }
    const avgPollution = pollutionN > 0 ? pollutionSum / pollutionN : 0;
    if (avgPollution > 0.2) {
      out.push({
        id: 'pollution',
        severity: avgPollution > 0.6 ? 3 : avgPollution > 0.4 ? 2 : 1,
        title: 'The air fouls',
        detail: `Pollution around ${cap.name} is ${Math.round(avgPollution * 100)}%.`,
        cause: 'Smoke and waste from workshops and kilns.',
        metric: avgPollution,
        threshold: 0.2,
        actionsHint: 'Build cleaner variants, gardens, or let the land rest.',
      });
    }
    const drought = s.world.weather.drought;
    if (drought > 0.35) {
      out.push({
        id: 'drought',
        severity: drought > 0.75 ? 3 : drought > 0.55 ? 2 : 1,
        title: 'Drought',
        detail: `Soil moisture has been falling for days (drought ${Math.round(drought * 100)}%).`,
        cause: 'Little rain in recent weeks.',
        metric: drought,
        threshold: 0.35,
        actionsHint: 'Store water and favour wells, fishers and irrigation.',
      });
    }
    const sarc = 'A sickness spreads through the crowded quarters.';
    let healthSum = 0;
    let healthN = 0;
    for (const c of s.citizens) {
      if (!c.alive) continue;
      healthSum += c.health;
      healthN++;
    }
    const avgHealth = healthN > 0 ? healthSum / healthN : 80;
    if (avgHealth < 50 && (avgPollution > 0.2 || cap.homeless > 3)) {
      out.push({
        id: 'epidemic',
        severity: avgHealth < 35 ? 3 : 2,
        title: 'Fever in the settlement',
        detail: `Average health has fallen to ${Math.round(avgHealth)}.`,
        cause: sarc,
        metric: avgHealth,
        threshold: 50,
        actionsHint: 'Build a clinic, clean the water, and reduce crowding.',
      });
    }
    if (avgHealth < 32) {
      out.push({
        id: 'health',
        severity: 2,
        title: 'A sickly people',
        detail: `Average health is ${Math.round(avgHealth)}.`,
        cause: 'Hunger, thirst, cold and poor housing.',
        metric: avgHealth,
        threshold: 32,
        actionsHint: 'Improve food, water and housing before anything else.',
      });
    }
    // Immediate starvation / dehydration warning.
    let hungry = 0;
    let thirsty = 0;
    for (const c of s.citizens) {
      if (!c.alive) continue;
      if (c.hunger > 75) hungry++;
      if (c.thirst > 75) thirsty++;
    }
    if (hungry >= Math.max(1, Math.round(cap.population * 0.2))) {
      out.push({
        id: 'starving',
        severity: 3,
        title: 'People are starving',
        detail: `${hungry} people have not eaten properly in days.`,
        cause: 'Food distribution has failed.',
        metric: hungry,
        actionsHint: 'Ration what remains and send for food immediately.',
      });
    }
    if (thirsty >= Math.max(1, Math.round(cap.population * 0.2))) {
      out.push({
        id: 'dehydrated',
        severity: 3,
        title: 'People are dying of thirst',
        detail: `${thirsty} people have no water.`,
        cause: 'The wells have run dry or are unstaffed.',
        metric: thirsty,
        actionsHint: 'Restore the water supply now.',
      });
    }
    // Neighbour threat.
    let ourStrength = 0;
    for (const b of s.buildings) {
      if (b.progress < 1) continue;
      const def = buildingDef(content, b);
      if (def?.service?.kind === 'safety') ourStrength += def.service.amount;
      for (const job of def?.jobs ?? []) if (job.profession === 'guard') ourStrength += b.workers * 3;
    }
    for (const civ of s.neighbors.civs) {
      if (!civ.discovered) continue;
      if (civ.relation === 'war') {
        out.push({
          id: `threat:${civ.id}`,
          severity: 3,
          title: `War with ${civ.name}`,
          detail: `${civ.name} is at war with us. Raids may come at any time.`,
          cause: 'Diplomacy has failed.',
          metric: civ.military,
          daysUntil: 5,
          actionsHint: 'Build defences, guard posts, or seek peace.',
        });
      } else if (civ.attitude < -40 && civ.military > ourStrength * 2) {
        out.push({
          id: `threat:${civ.id}`,
          severity: 2,
          title: `${civ.name} grows hostile`,
          detail: `Their warbands outnumber our watch (${Math.round(civ.military)} vs ${Math.round(ourStrength)}).`,
          cause: 'Our neighbours no longer trust us.',
          metric: civ.attitude,
          daysUntil: 10,
          actionsHint: 'Send envoys or raise guards.',
        });
      }
    }
  }

  if (out.length > 10) out.length = 10;
  return out.map((w) => ({
    id: w.id,
    severity: w.severity,
    title: w.title,
    detail: w.detail,
    cause: w.cause,
    metric: w.metric,
    threshold: w.threshold,
    daysUntil: w.daysUntil,
    actionsHint: w.actionsHint,
  }));
}

// ---------------------------------------------------------------------------
// Director
// ---------------------------------------------------------------------------

function conditionOk(ctx: SimContext, cond: Condition): boolean {
  try {
    return evalCondition(cond, ctx.s, ctx.c, (s, c, metric) => computeMetric(s, c, metric), ctx.rng);
  } catch {
    return false;
  }
}

interface ScoredEvent {
  def: EventDef;
  weight: number;
}

function eventWeight(ctx: SimContext, def: EventDef, severeWarnings: number): number {
  const s = ctx.s;
  let weight = Math.max(0.001, def.weight);
  const tension = s.events.tension;
  // Severe warnings make crises and nature more likely, booms less.
  if (def.category === 'crisis') weight *= 0.5 + tension * 2.2 + severeWarnings * 0.25;
  if (def.category === 'nature') weight *= 0.9 + tension * 0.7;
  if (def.category === 'boom') weight *= 1.3 - tension * 0.6;
  if (def.category === 'migration') weight *= 1 + (s.society.approval > 55 ? 0.2 : 0);
  if (def.severity === 3) weight *= 0.4 + tension * 1.6;
  if (def.severity === 1) weight *= 1.15;
  // Early game should be gentle and welcoming; later eras can be harsher.
  if (ctx.s.tick < 24) weight *= def.severity === 3 ? 0.1 : def.category === 'boom' || def.category === 'migration' ? 1.3 : 1;
  // Never offer the same event while its cousin is pending.
  if (s.events.pending.some((p) => p.eventId === def.id)) weight = 0;
  return weight;
}

function collectCandidates(ctx: SimContext): ScoredEvent[] {
  const s = ctx.s;
  const era = s.research.era;
  const severeWarnings = s.events.warnings.reduce((n, w) => n + (w.severity >= 2 ? 1 : 0), 0);
  const lastSevere = s.flags['event:last_severe_start'] ?? -9999;
  const lastDecision = s.flags['event:last_decision'] ?? -9999;
  const out: ScoredEvent[] = [];
  for (const id of ctx.c.eventOrder) {
    const def = ctx.c.events[id];
    if (!def) continue;
    if (def.minEra > era) continue;
    if (def.maxEra !== undefined && era > def.maxEra) continue;
    if (def.once && (s.events.seen[id] ?? 0) > 0) continue;
    // Never re-fire an event id before twice its authored cooldown.
    if ((s.events.cooldowns[id] ?? 0) > ctx.tick) continue;
    // One major crisis at a time: already-telegraphed scheduled chains bypass
    // this (they were announced earlier and are handled by the scheduler).
    if (def.severity >= 3 && ctx.tick - lastSevere < SEVERITY3_MIN_GAP) continue;
    // Open questions need breathing room: never stack decision events.
    if ((def.choices?.length ?? 0) > 0) {
      if (s.events.pending.length > 0) continue; // one open question at a time
      if (ctx.tick - lastDecision < decisionGap(era)) continue;
    }
    if (def.requiresFlag && (s.flags[def.requiresFlag] ?? 0) !== 0) continue;
    // A gentle opening: no questions in the first ten days, no serious event
    // before the player has had a month to find their feet.
    if (ctx.tick < 10 && (def.choices?.length ?? 0) > 0) continue;
    if (def.severity >= 2 && ctx.tick < 30) continue;
    if (s.events.scheduled.some((e) => e.eventId === id)) continue;
    if (s.events.pending.some((p) => p.eventId === id)) continue;
    // Fairness: a fatal event must be telegraphed.
    if (def.severity === 3 && def.telegraphDays <= 0 && worstKillFraction(def) > 0.04) continue;
    if (!conditionOk(ctx, def.condition)) continue;
    const weight = eventWeight(ctx, def, severeWarnings);
    if (weight > 0.0005) out.push({ def, weight });
  }
  return out;
}

function weightedChoice(rng: () => number, items: ScoredEvent[]): EventDef | null {
  let total = 0;
  for (const it of items) total += it.weight;
  if (total <= 0) return null;
  let roll = rng() * total;
  for (const it of items) {
    roll -= it.weight;
    if (roll <= 0) return it.def;
  }
  return items[items.length - 1]?.def ?? null;
}

/** Days between decision-bearing events; early game is deliberately slower. */
function decisionGap(era: number): number {
  return DECISION_GAP_BY_ERA[Math.min(era, DECISION_GAP_BY_ERA.length - 1)] ?? 30;
}

function scheduleTelegraphed(ctx: SimContext, def: EventDef): void {
  const s = ctx.s;
  const days = Math.max(1, Math.round(def.telegraphDays));
  s.events.scheduled.push({ eventId: def.id, fireTick: ctx.tick + days });
  const warning: Warning = {
    id: `event:${def.id}`,
    severity: def.severity,
    title: def.title,
    detail: def.warningText ?? def.text,
    cause: def.causeHints?.[0] ?? 'Conditions are building toward something.',
    daysUntil: days,
    actionsHint: 'Prepare before this arrives.',
  };
  s.events.warnings = [warning, ...s.events.warnings.filter((w) => w.id !== warning.id)].slice(0, 10);
  ctx.notify(`${def.title} — ${def.warningText ?? 'Something is coming.'}`, 'warn', 'warning');
}

/** Fire an event immediately (or open its decision). Returns the decision if one was opened. */
export function fireEvent(ctx: SimContext, def: EventDef, telegraphed = false): PendingDecision | null {
  const s = ctx.s;
  const id = def.id;
  s.events.seen[id] = (s.events.seen[id] ?? 0) + 1;
  s.events.cooldowns[id] = ctx.tick + Math.max(0, def.cooldownDays) * COOLDOWN_MULTIPLIER;
  s.events.lastEventTick = ctx.tick;
  s.events.quietDays = 0;
  s.events.tension = clamp(s.events.tension + 0.1, 0, 1);
  if (def.severity >= 3) s.flags['event:last_severe_start'] = ctx.tick;

  const kind = CATEGORY_KIND[def.category] ?? 'society';
  ctx.chronicle(def.title, def.text, kind, def.severity);
  const toastSeverity: Notification['severity'] =
    def.category === 'discovery' ? 'discovery' : def.category === 'boom' ? 'good' : def.severity >= 3 ? 'bad' : def.severity === 2 ? 'warn' : 'info';
  ctx.notify(def.title, toastSeverity, def.icon || 'bell');

  // Automatic effects always apply when the event fires.
  if (def.autoEffects?.length) {
    applyEffectsCtx(ctx, def.autoEffects, { telegraphed: telegraphed || def.telegraphDays > 0 });
  }

  let decision: PendingDecision | null = null;
  const choices = (def.choices ?? []).filter((ch) => !ch.requires || conditionOk(ctx, ch.requires));
  const decisionCap = capitalOf(s);
  const anyAffordable = choices.length === 0 || choices.some((ch) => !ch.cost || !decisionCap || canAfford(decisionCap, ch.cost));
  const lastDecisionTick = s.flags['event:last_decision'] ?? -9999;
  const deferToCouncil =
    choices.length > 0 &&
    (ctx.tick < 10 ||
      (def.severity >= 2 && ctx.tick < 30) ||
      ctx.tick - lastDecisionTick < Math.max(24, Math.round(decisionGap(s.research.era) * 0.6)));
  if (choices.length > 0 && deferToCouncil && anyAffordable) {
    // Chained or scheduled events can arrive close together; rather than
    // interrupt the player again, the council takes the cautious first choice.
    const fallback = choices.find((ch) => !ch.cost || !decisionCap || canAfford(decisionCap, ch.cost)) ?? choices[0];
    if (fallback) {
      applyDecisionChoice(s, ctx.c, ctx.rules, {
        id: s.events.nextDecisionId++,
        eventId: def.id,
        title: def.title,
        text: def.text,
        choices,
        createdTick: ctx.tick,
        severity: def.severity,
        category: def.category,
        icon: def.icon || 'bell',
        causes: def.causeHints ?? [],
      }, fallback.id);
      ctx.notify(`${def.title}: your council acted in your stead.`, 'info', 'crown');
    }
  } else if (choices.length > 0 && !anyAffordable) {
    // Nobody can act on this: don't trap the player behind an unresolvable
    // modal. The moment passes and the world moves on.
    s.flags['event:last_decision'] = ctx.tick;
    s.events.history.push({ eventId: id, tick: ctx.tick, choiceId: '__none' });
    if (s.events.history.length > 300) s.events.history.splice(0, s.events.history.length - 300);
    s.stats.eventsSurvived++;
    ctx.notify(`${def.title}: we lacked the means to act. The moment passed.`, 'info', 'hourglass');
  } else if (choices.length > 0) {
    s.flags['event:last_decision'] = ctx.tick;
    const causes = def.causeHints?.length ? def.causeHints : def.severity >= 2 ? [def.text.slice(0, 120)] : [];
    decision = {
      id: s.events.nextDecisionId++,
      eventId: def.id,
      title: def.title,
      text: def.text,
      choices,
      createdTick: ctx.tick,
      severity: def.severity,
      category: def.category,
      icon: def.icon || 'bell',
      causes,
    };
    if (s.events.pending.length >= LIMITS.maxPendingDecisions) {
      // Too many open questions: take the cautious first choice automatically.
      const first = choices[0];
      if (first) {
        applyDecisionChoice(s, ctx.c, ctx.rules, decision, first.id);
        decision = null;
      }
    } else {
      // The history entry is written when the player actually chooses, so an
      // event is never counted twice (once for opening, once for resolving).
      s.events.pending.push(decision);
    }
  } else {
    s.events.history.push({ eventId: id, tick: ctx.tick });
    if (s.events.history.length > 300) s.events.history.splice(0, s.events.history.length - 300);
    s.stats.eventsSurvived++;
  }

  // Chains.
  for (const link of def.chain ?? []) {
    s.events.scheduled.push({ eventId: link.eventId, fireTick: ctx.tick + Math.max(1, link.delayDays) });
  }
  return decision;
}

/** Dice: should the director fire something today? */
function maybeFireEvent(ctx: SimContext): void {
  const s = ctx.s;
  const tension = s.events.tension;
  const severe = s.events.warnings.filter((w) => w.severity >= 2).length;
  let chance = 0.055 + tension * 0.2 + Math.min(0.05, s.events.quietDays * 0.0012);
  if (s.events.quietDays < 3) chance *= 0.25;
  if (s.events.pending.length > 0) chance *= 0.35;
  if (s.tick < 24) chance *= 1.25;
  if (severe > 0) chance += severe * 0.02;
  chance = clamp(chance, 0.01, 0.4);

  const forceFirst = s.events.history.length === 0 && s.tick >= 4 && s.tick % 2 === 1;
  if (!forceFirst && ctx.rng() >= chance) {
    s.events.quietDays++;
    return;
  }
  const candidates = collectCandidates(ctx);
  if (candidates.length === 0) {
    s.events.quietDays++;
    return;
  }
  const def = weightedChoice(ctx.rng, candidates);
  if (!def) {
    s.events.quietDays++;
    return;
  }
  if (def.telegraphDays > 0) {
    // Schedule the real event and show the warning now.
    if (!s.events.scheduled.some((e) => e.eventId === def.id)) {
      scheduleTelegraphed(ctx, def);
      s.events.seen[def.id] = (s.events.seen[def.id] ?? 0) + 1;
      s.events.cooldowns[def.id] = ctx.tick + Math.max(0, def.cooldownDays) * COOLDOWN_MULTIPLIER;
      if (def.severity >= 3) s.flags['event:last_severe_start'] = ctx.tick;
      s.events.lastEventTick = ctx.tick;
      s.events.quietDays = 0;
      s.events.tension = clamp(s.events.tension + 0.05, 0, 1);
    }
    return;
  }
  fireEvent(ctx, def, false);
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

function decisionChronicle(decision: PendingDecision, choice: EventChoice, s: GameState): void {
  const kind = CATEGORY_KIND[decision.category] ?? 'society';
  addChronicle(
    s,
    decision.title,
    `${decision.text} The choice: ${choice.label}.`,
    kind,
    decision.severity,
  );
}

/**
 * Resolve a pending decision. Pays the choice cost from the capital, checks its
 * requirement, applies the effects and closes the decision.
 */
export function applyDecisionChoice(
  state: GameState,
  content: Content,
  rules: GameRules,
  decision: PendingDecision,
  choiceId: string,
): ActionResult {
  const s = state;
  if (choiceId === '__none' || choiceId === '') {
    // "Let it pass": always available so no decision can ever soft-lock the game.
    const cap0 = capitalOf(s);
    const idx0 = s.events.pending.findIndex((d) => d.id === decision.id);
    if (idx0 >= 0) s.events.pending.splice(idx0, 1);
    s.events.history.push({ eventId: decision.eventId, tick: s.tick, choiceId: '__none' });
    if (s.events.history.length > 300) s.events.history.splice(0, s.events.history.length - 300);
    s.stats.eventsSurvived++;
    if (cap0) {
      cap0.morale = Math.max(0, cap0.morale - 1.5);
      s.society.stability = Math.max(0, s.society.stability - 0.6);
      for (const c of s.citizens) if (c.alive && c.settlementId === cap0.id) c.morale = Math.max(0, c.morale - 2);
    }
    pushNotification(s, `${decision.title}: the matter was let pass.`, 'info', 'hourglass');
    addChronicle(s, `${decision.title} — Let Pass`, 'The question came before the hearth, and the hearth chose silence. Not every matter can be answered with the means at hand.', 'society', 1);
    return { ok: true, message: 'Let it pass' };
  }
  const choice = decision.choices.find((ch) => ch.id === choiceId);
  if (!choice) return { ok: false, message: 'No such choice' };
  const cap = capitalOf(s);
  if (!cap) return { ok: false, message: 'No settlement' };
  if (choice.requires) {
    const rng = () => sfc32(s.rng);
    const ok = evalCondition(choice.requires, s, content, (st, c, metric) => computeMetric(st, c, metric), rng);
    if (!ok) return { ok: false, message: 'That option is not available' };
  }
  if (choice.cost && Object.keys(choice.cost).length > 0) {
    if (!canAfford(cap, choice.cost)) {
      const missing = Object.keys(choice.cost)
        .filter((res) => stockOf(cap, res) + 1e-6 < (choice.cost?.[res] ?? 0))
        .map((res) => content.resources[res]?.name ?? res);
      return { ok: false, message: `Missing: ${missing.join(', ')}` };
    }
    payCost(cap, choice.cost);
  }
  const rng = () => sfc32(s.rng);
  applyEffects(s, content, rules, choice.effects, {
    settlementId: cap.id,
    telegraphed: decision.severity >= 3,
    rng,
    notify: (text, severity, icon) => pushNotification(s, text, severity, icon),
    chronicle: (title, body, kind, importance) => addChronicle(s, title, body, kind, importance),
  });
  // Close the decision.
  const idx = s.events.pending.findIndex((d) => d.id === decision.id);
  if (idx >= 0) s.events.pending.splice(idx, 1);
  s.events.history.push({ eventId: decision.eventId, tick: s.tick, choiceId });
  if (s.events.history.length > 300) s.events.history.splice(0, s.events.history.length - 300);
  s.stats.eventsSurvived++;
  decisionChronicle(decision, choice, s);
  pushNotification(s, `${decision.title}: ${choice.label}`, 'info', decision.icon || 'bell');
  return { ok: true, message: choice.label };
}

/** In a headless run nothing can click a modal; the prudent course is taken. */
function resolveStaleDecisions(ctx: SimContext): void {
  const s = ctx.s;
  if (s.events.pending.length === 0) return;
  const stale = s.events.pending.filter((d) => ctx.tick - d.createdTick > 14);
  for (const d of stale) {
    const cap = capitalOf(s);
    const choice =
      d.choices.find((ch) => !ch.cost || !cap || canAfford(cap, ch.cost)) ?? d.choices[0];
    if (!choice) {
      const idx = s.events.pending.indexOf(d);
      if (idx >= 0) s.events.pending.splice(idx, 1);
      continue;
    }
    applyDecisionChoice(s, ctx.c, ctx.rules, d, choice.id);
    ctx.notify(`${d.title}: with no word from the council, the moment passed.`, 'info', 'hourglass');
  }
}

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const eventsSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  if (!s.settlements || s.settlements.length === 0) return;
  const tick = ctx.tick;

  // 1) Expire active modifiers.
  s.events.active = s.events.active.filter((ev) => ev.endTick > tick || ev.endTick < 0);

  // 2) Scheduled events come due.
  if (s.events.scheduled.length > 0) {
    const due = s.events.scheduled.filter((e) => e.fireTick <= tick);
    s.events.scheduled = s.events.scheduled.filter((e) => e.fireTick > tick);
    for (const item of due) {
      const def = ctx.c.events[item.eventId];
      if (!def) continue;
      if (def.once && (s.events.seen[def.id] ?? 0) > 0) continue;
      ctx.log(`events: fired scheduled ${def.id}`);
      fireEvent(ctx, def, true);
    }
  }

  // 3) Cooldown bookkeeping.
  for (const id in s.events.cooldowns) {
    if ((s.events.cooldowns[id] ?? 0) <= tick) delete s.events.cooldowns[id];
  }

  // 4) Fresh warnings from the real state (kept for the UI and the director),
  //    plus the visible countdowns of events already telegraphed.
  try {
    const computed = computeWarnings(s, ctx.c, ctx.rules);
    const telegraph: Warning[] = [];
    for (const item of s.events.scheduled) {
      const def = ctx.c.events[item.eventId];
      if (!def || def.telegraphDays <= 0) continue;
      telegraph.push({
        id: `event:${def.id}`,
        severity: def.severity,
        title: def.title,
        detail: def.warningText ?? def.text,
        cause: def.causeHints?.[0] ?? 'Conditions are building toward something.',
        daysUntil: Math.max(0, item.fireTick - tick),
        actionsHint: 'Prepare before this arrives.',
      });
    }
    s.events.warnings = [...telegraph, ...computed].slice(0, 10);
  } catch {
    s.events.warnings = [];
  }

  // 5) Tension: rises with visible trouble and recent drama, falls with quiet.
  const severe = s.events.warnings.reduce((n, w) => n + (w.severity >= 2 ? w.severity : 0), 0);
  const quietBonus = s.events.quietDays > 24 ? -0.06 : 0;
  const tensionTarget = clamp(0.1 + severe * 0.045 + quietBonus, 0, 1);
  s.events.tension = clamp(s.events.tension + (tensionTarget - s.events.tension) * 0.18, 0, 1);

  // 6) Headless safety: resolve decisions nobody can click.
  resolveStaleDecisions(ctx);

  // 7) Roll the director.
  maybeFireEvent(ctx);

  // 8) Housekeeping.
  if (s.events.history.length > 300) s.events.history.splice(0, s.events.history.length - 300);
  if (s.events.pending.length > LIMITS.maxPendingDecisions) {
    s.events.pending.splice(0, s.events.pending.length - LIMITS.maxPendingDecisions);
  }
  for (const w of s.events.warnings) {
    if (!Number.isFinite(w.metric ?? 0)) w.metric = 0;
  }
};

// ---------------------------------------------------------------------------
// Small helpers kept for other systems
// ---------------------------------------------------------------------------

/** Apply a single event's automatic effects from anywhere (sites/objectives). */
export function runEventAutoEffects(ctx: SimContext, eventId: string, telegraphed = false): void {
  const def = ctx.c.events[eventId];
  if (!def) return;
  fireEvent(ctx, def, telegraphed);
}

/** Cancel a scheduled event (e.g. the crisis was prevented in time). */
export function cancelScheduledEvent(state: GameState, eventId: string): boolean {
  const idx = state.events.scheduled.findIndex((e) => e.eventId === eventId);
  if (idx < 0) return false;
  state.events.scheduled.splice(idx, 1);
  return true;
}

export interface EventPacingReport {
  tension: number;
  quietDays: number;
  lastEventTick: number;
  eventsFired: number;
  pending: number;
  warnings: number;
}

/** For QA/UI: a compact read of the director's mood. */
export function pacingReport(state: GameState): EventPacingReport {
  return {
    tension: Math.round(state.events.tension * 100) / 100,
    quietDays: state.events.quietDays,
    lastEventTick: state.events.lastEventTick,
    eventsFired: state.events.history.length,
    pending: state.events.pending.length,
    warnings: state.events.warnings.length,
  };
}

// Keep unused imports honest (contracts other modules rely on).
void totalPopulation;
void tileAt;
void Rng;
