/**
 * Player actions. Every mutation initiated by the UI goes through this module so
 * that validation, costs and side effects stay consistent and testable.
 */
import type {
  ActionResult,
  Building,
  BuildingDef,
  BuildingId,
  Content,
  DoctrineId,
  GameRules,
  GameState,
  PolicyId,
  ResourceId,
  Settlement,
  TechId,
} from './types';
import { RULES, LIMITS, WORLDGEN } from './config';
import {
  addChronicle,
  addStock,
  buildingDef,
  canAfford,
  capitalOf,
  claimableTile,
  hasTech,
  isBuildingUnlocked,
  isPolicyUnlocked,
  missingCost,
  modOfState,
  nextId,
  payCost,
  pushNotification,
  recipeForBuilding,
  refundCost,
  removeStock,
  scaleCost,
  settlementById,
  stockOf,
  techAvailable,
  techRequirementsMet,
  tileAt,
  tileIndex,
} from './core';
import { createBuilding, createSettlement, createCitizen, claimAround, footprint } from './state';
import { applyDecisionChoice } from './systems/civ/events';
import { Rng } from './rng';

export interface ActionContext {
  state: GameState;
  content: Content;
  rules?: GameRules;
}

function rulesOf(a: ActionContext): GameRules {
  return a.rules ?? RULES;
}

function fail(message: string): ActionResult {
  return { ok: false, message };
}

// ---------------------------------------------------------------------------
// Building placement
// ---------------------------------------------------------------------------

export interface PlacementCheck {
  ok: boolean;
  reason?: string;
  cost: Record<ResourceId, number>;
  missing: Record<ResourceId, number>;
  def: BuildingDef | null;
}

export function placementCheck(a: ActionContext, typeId: BuildingId, x: number, y: number, settlementId: number): PlacementCheck {
  const { state, content } = a;
  const def = content.buildings[typeId] ?? null;
  const cost: Record<ResourceId, number> = def ? scaleCost(def.cost, 1 + modOfState(state, settlementId, 'constructionCost')) : {};
  const empty: PlacementCheck = { ok: false, reason: 'Unknown building', cost, missing: {}, def };
  if (!def) return empty;
  const st = settlementById(state, settlementId);
  if (!st) return { ...empty, reason: 'No settlement selected' };
  if (def.era > state.research.era) return { ...empty, reason: `Requires era ${def.era + 1}` };
  if (!isBuildingUnlocked(state, content, typeId)) {
    const missing = def.requiresTech.find((t) => content.techs[t] && !hasTech(state, t));
    return { ...empty, reason: missing ? `Requires ${content.techs[missing]?.name ?? missing}` : 'Not yet available' };
  }
  const w = state.world;
  const tiles = footprint(def.size, x, y);
  for (const f of tiles) {
    if (!claimableTile(w, content, f.x, f.y)) return { ...empty, reason: 'Cannot build on that terrain' };
    const t = tileAt(w, f.x, f.y);
    if (!t) return { ...empty, reason: 'Outside the world' };
    if (t.buildingId >= 0) return { ...empty, reason: 'Tile is occupied' };
    const dist = Math.hypot(f.x - st.x, f.y - st.y);
    if (dist > 9) return { ...empty, reason: `Too far from ${st.name} (max 9 tiles)` };
    if (t.settlementId >= 0 && t.settlementId !== st.id) return { ...empty, reason: 'Land claimed by another settlement' };
  }
  const center = tileAt(w, x, y)!;
  const place = def.placement;
  if (place.needWater) {
    let found = center.water > 0.25;
    for (const f of tiles) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const t = tileAt(w, f.x + dx, f.y + dy);
          if (t && (t.water > 0.4 || content.biomes[t.biome]?.tags?.includes('water'))) found = true;
        }
      }
    }
    if (!found) return { ...empty, reason: 'Needs water nearby' };
  }
  if (place.needForest && center.forest < 0.15) return { ...empty, reason: 'Needs forest on this tile' };
  if (place.needForest) {
    let forestNearby = false;
    for (const f of tiles) {
      for (let dy = -2; dy <= 2 && !forestNearby; dy++) {
        for (let dx = -2; dx <= 2 && !forestNearby; dx++) {
          const t = tileAt(w, f.x + dx, f.y + dy);
          if (t && t.forest > 0.2) forestNearby = true;
        }
      }
    }
    if (!forestNearby) return { ...empty, reason: 'No forest within reach' };
  }
  if (place.needDeposit) {
    let found = false;
    for (const f of tiles) {
      for (let dy = -2; dy <= 2 && !found; dy++) {
        for (let dx = -2; dx <= 2 && !found; dx++) {
          const t = tileAt(w, f.x + dx, f.y + dy);
          if (t?.deposit && t.deposit.resource === place.needDeposit && t.deposit.amount > 0) found = true;
        }
      }
    }
    if (!found) return { ...empty, reason: `Needs ${content.resources[place.needDeposit]?.name ?? place.needDeposit} deposit nearby` };
  }
  if (place.unique) {
    const exists = state.buildings.some((b) => b.typeId === typeId && b.settlementId === settlementId);
    if (exists) return { ...empty, reason: 'Only one allowed per settlement' };
  }
  if (place.maxPerSettlement) {
    const count = state.buildings.filter((b) => b.typeId === typeId && b.settlementId === settlementId).length;
    if (count >= place.maxPerSettlement) return { ...empty, reason: `Limit ${place.maxPerSettlement} per settlement` };
  }
  if (def.tags?.includes('unique_world')) {
    if (state.buildings.some((b) => b.typeId === typeId)) return { ...empty, reason: 'A wonder already stands' };
  }
  const missing = missingCost(st, cost);
  return { ok: Object.keys(missing).length === 0, reason: Object.keys(missing).length ? 'Not enough materials' : undefined, cost, missing, def };
}

export function placeBuilding(a: ActionContext, typeId: BuildingId, x: number, y: number, settlementId?: number): ActionResult {
  const { state, content } = a;
  const st = settlementId !== undefined ? settlementById(state, settlementId) : capitalOf(state);
  if (!st) return fail('No settlement to build in');
  const check = placementCheck(a, typeId, x, y, st.id);
  if (!check.ok || !check.def) return fail(check.reason ?? 'Cannot build here');
  if (!payCost(st, check.cost)) {
    const missingText = Object.keys(check.missing)
      .map((r) => `${content.resources[r]?.name ?? r} ×${Math.ceil(check.missing[r])}`)
      .join(', ');
    return fail(`Missing materials: ${missingText}`);
  }
  const building = createBuilding(state, content, typeId, x, y, st.id, { completed: false });
  if (!building) {
    refundCost(st, check.cost);
    return fail('Could not place building');
  }
  claimAround(state, content, st, 1);
  for (const f of footprint(check.def.size, x, y)) {
    const t = tileAt(state.world, f.x, f.y);
    if (t && t.siteIndex >= 0) {
      const site = state.world.sites[t.siteIndex];
      if (site) site.visited = true;
    }
  }
  pushNotification(state, `Construction begins: ${check.def.name}.`, 'info', 'hammer');
  return { ok: true, cost: check.cost, message: `${check.def.name} under construction` };
}

export function demolishBuilding(a: ActionContext, buildingId: number): ActionResult {
  const { state, content } = a;
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b) return fail('No such building');
  const def = buildingDef(content, b);
  const st = settlementById(state, b.settlementId);
  if (!def || !st) return fail('No such building');
  for (const f of footprint(def.size, b.x, b.y)) {
    const t = tileAt(state.world, f.x, f.y);
    if (t && t.buildingId === b.id) t.buildingId = -1;
  }
  st.buildings = st.buildings.filter((id) => id !== buildingId);
  state.buildings = state.buildings.filter((x) => x.id !== buildingId);
  if (b.progress < 1) {
    refundCost(st, scaleCost(def.cost, 0.75));
  } else {
    refundCost(st, scaleCost(def.cost, 0.2));
  }
  pushNotification(state, `${def.name} dismantled.`, 'info', 'hammer');
  return { ok: true, message: `${def.name} dismantled` };
}

export function toggleBuilding(a: ActionContext, buildingId: number): ActionResult {
  const b = a.state.buildings.find((x) => x.id === buildingId);
  if (!b) return fail('No such building');
  b.enabled = !b.enabled;
  return { ok: true, message: b.enabled ? 'Building enabled' : 'Building paused' };
}

export function setBuildingPriority(a: ActionContext, buildingId: number, priority: number): ActionResult {
  const b = a.state.buildings.find((x) => x.id === buildingId);
  if (!b) return fail('No such building');
  b.priority = Math.max(0, Math.min(3, Math.round(priority)));
  return { ok: true };
}

export function setBuildingRecipe(a: ActionContext, buildingId: number, recipeId: string): ActionResult {
  const { state, content } = a;
  const b = state.buildings.find((x) => x.id === buildingId);
  if (!b) return fail('No such building');
  const def = buildingDef(content, b);
  if (!def) return fail('Unknown building type');
  const recipe = content.recipes[recipeId];
  if (!recipe) return fail('Unknown recipe');
  if (!def.recipes.includes(recipeId)) return fail('That recipe is not available in this building');
  if (recipe.requiresTech && !techRequirementsMet(state, content, recipe.requiresTech)) return fail('Recipe not yet discovered');
  b.recipeId = recipeId;
  return { ok: true, message: `Now producing ${recipe.name}` };
}

export function setGovernor(a: ActionContext, settlementId: number, patch: Partial<Settlement['governor']>): ActionResult {
  const st = settlementById(a.state, settlementId);
  if (!st) return fail('No settlement');
  Object.assign(st.governor, patch);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Roads
// ---------------------------------------------------------------------------

export function roadCheck(a: ActionContext, x: number, y: number, settlementId: number): { ok: boolean; reason?: string; cost: Record<ResourceId, number> } {
  const { state, content } = a;
  const st = settlementById(state, settlementId);
  const cost: Record<ResourceId, number> = { stone: 1, wood: 0.5 };
  if (!st) return { ok: false, reason: 'No settlement', cost };
  const t = tileAt(state.world, x, y);
  if (!t) return { ok: false, reason: 'Outside the world', cost };
  if (!claimableTile(state.world, content, x, y)) return { ok: false, reason: 'Cannot lay road here', cost };
  if (t.buildingId >= 0) return { ok: false, reason: 'Something is built here', cost };
  if (t.road > 0) return { ok: false, reason: 'Road already exists', cost };
  if (Math.hypot(x - st.x, y - st.y) > 12) return { ok: false, reason: 'Too far from settlement', cost };
  return { ok: canAfford(st, cost), reason: canAfford(st, cost) ? undefined : 'Not enough stone', cost };
}

export function placeRoad(a: ActionContext, x: number, y: number, settlementId: number): ActionResult {
  const { state } = a;
  const st = settlementById(state, settlementId);
  if (!st) return fail('No settlement');
  const check = roadCheck(a, x, y, settlementId);
  if (!check.ok) return fail(check.reason ?? 'Cannot build road');
  payCost(st, check.cost);
  const t = tileAt(state.world, x, y)!;
  t.road = 0.85;
  if (t.settlementId < 0) {
    t.settlementId = st.id;
    st.claimedTiles.push(tileIndex(state.world, x, y));
    st.landClaimed = st.claimedTiles.length;
  }
  return { ok: true };
}

export function removeRoad(a: ActionContext, x: number, y: number): ActionResult {
  const t = tileAt(a.state.world, x, y);
  if (!t || t.road <= 0) return fail('No road here');
  t.road = 0;
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Research & doctrines
// ---------------------------------------------------------------------------

export function chooseTech(a: ActionContext, techId: TechId): ActionResult {
  const { state, content } = a;
  const tech = content.techs[techId];
  if (!tech) return fail('Unknown discovery');
  if (!techAvailable(state, content, techId)) return fail('Prerequisites not met or already discovered');
  if (state.research.insight < tech.cost) return fail(`Need ${Math.ceil(tech.cost - state.research.insight)} more insight`);
  state.research.insight -= tech.cost;
  state.research.completed[techId] = state.tick;
  state.stats.techsResearched++;
  if (tech.bonus) {
    if (tech.bonus.insight) state.research.insight += tech.bonus.insight;
    if (tech.bonus.culture) {
      const cap = capitalOf(state);
      if (cap) cap.culture += tech.bonus.culture;
    }
    if (tech.bonus.stock) {
      const cap = capitalOf(state);
      if (cap) for (const res in tech.bonus.stock) addStock(cap, res, tech.bonus.stock[res]);
    }
    if (tech.bonus.flag) state.flags[tech.bonus.flag] = 1;
    if (tech.bonus.revealRadius) {
      const cap = capitalOf(state);
      if (cap) {
        // reveal handled lazily to avoid importing state helpers here
        state.flags[`reveal_at_${cap.x}_${cap.y}`] = tech.bonus.revealRadius;
      }
    }
  }
  pushNotification(state, `Discovery: ${tech.name} — ${tech.desc}`, 'discovery', 'star');
  addChronicle(state, `The Discovery of ${tech.name}`, tech.flavor || tech.desc, 'discovery', tech.era >= 3 ? 2 : 1);
  // Branch affinity grows with each discovery.
  state.research.affinity[tech.branch] = (state.research.affinity[tech.branch] ?? 0) + 1;
  return { ok: true, message: `${tech.name} discovered` };
}

export function chooseDoctrine(a: ActionContext, doctrineId: DoctrineId): ActionResult {
  const { state, content } = a;
  const doctrine = content.doctrines[doctrineId];
  if (!doctrine) return fail('Unknown doctrine');
  if (!state.research.doctrineChoices.includes(doctrineId)) return fail('This creed is not on offer');
  if (state.research.doctrine) return fail('A creed has already been chosen');
  state.research.doctrine = doctrineId;
  state.research.doctrineChoices = [];
  state.research.nextDoctrineEra = Math.max(state.research.nextDoctrineEra, state.research.era + 1);
  state.cache.globalMods = {};
  pushNotification(state, `Creed adopted: ${doctrine.name} — ${doctrine.motto}`, 'good', 'crown');
  addChronicle(state, `The Creed of ${doctrine.name}`, `${doctrine.desc} Henceforth our people walk the path of ${doctrine.playstyle}.`, 'society', 3);
  return { ok: true, message: `${doctrine.name} adopted` };
}

// ---------------------------------------------------------------------------
// Society sliders & policies
// ---------------------------------------------------------------------------

export function setTaxRate(a: ActionContext, rate: number): ActionResult {
  const st = capitalOf(a.state);
  if (!st) return fail('No settlement');
  a.state.society.taxRate = Math.max(0, Math.min(0.45, rate));
  return { ok: true };
}

export function setRations(a: ActionContext, rations: 'meager' | 'normal' | 'generous'): ActionResult {
  a.state.society.rations = rations;
  return { ok: true };
}

export function setWorkHours(a: ActionContext, hours: number): ActionResult {
  if (![8, 10, 12].includes(hours)) return fail('Invalid work hours');
  a.state.society.workHours = hours;
  return { ok: true };
}

/** Influence cost actually charged for a policy (content cost with the society discount). */
export function policyInfluenceCost(policy: { cost: number }): number {
  return Math.max(1, Math.round(policy.cost * 0.6));
}

export function setPolicy(a: ActionContext, policyId: PolicyId, on: boolean): ActionResult {
  const { state, content } = a;
  const p = content.policies[policyId];
  if (!p) return fail('Unknown policy');
  if (!isPolicyUnlocked(state, content, policyId)) return fail('Policy not yet available');
  if (on) {
    if (state.society.policies[policyId]) return { ok: true };
    const cap = capitalOf(state);
    if (!cap) return fail('No settlement');
    if (p.conflicts) {
      for (const cid of p.conflicts) {
        if (state.society.policies[cid]) return fail(`Conflicts with ${content.policies[cid]?.name ?? cid}. Repeal it first.`);
      }
    }
    const cost = policyInfluenceCost(p);
    if ((cap.influence ?? 0) < cost) return fail(`Needs ${cost} influence`);
    cap.influence -= cost;
    state.society.policies[policyId] = true;
    state.society.policyHistory.push({ policy: policyId, tick: state.tick, on: true });
    pushNotification(state, `Policy enacted: ${p.name}`, 'info', 'crown');
  } else {
    state.society.policies[policyId] = false;
    state.society.policyHistory.push({ policy: policyId, tick: state.tick, on: false });
    pushNotification(state, `Policy repealed: ${p.name}`, 'info', 'crown');
  }
  state.cache.globalMods = {};
  return { ok: true, message: `${p.name} ${on ? 'enacted' : 'repealed'}` };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export function resolveDecision(a: ActionContext, decisionId: number, choiceId: string): ActionResult {
  const decision = a.state.events.pending.find((d) => d.id === decisionId);
  if (!decision) return fail('This decision has passed');
  const result = applyDecisionChoice(a.state, a.content, rulesOf(a), decision, choiceId);
  return result;
}

// ---------------------------------------------------------------------------
// Exploration & expansion
// ---------------------------------------------------------------------------

export function expeditionCost(kind: 'scout' | 'settle' | 'survey'): Record<ResourceId, number> {
  switch (kind) {
    case 'scout':
      return { food: 0, preserved_food: 0, berries: 8 };
    case 'survey':
      return { berries: 6, tools: 1 };
    case 'settle':
      return { preserved_food: 10, berries: 25, wood: 30, stone: 12 };
  }
}

export function startExpedition(a: ActionContext, kind: 'scout' | 'survey' | 'settle', tx: number, ty: number): ActionResult {
  const { state, content } = a;
  const st = capitalOf(state);
  if (!st) return fail('No settlement');
  if (state.exploration.expeditions.length >= LIMITS.maxExpeditions) return fail('Too many expeditions afield');
  const w = state.world;
  if (tx < 0 || ty < 0 || tx >= w.width || ty >= w.height) return fail('Target outside the world');
  const target = tileAt(w, tx, ty);
  if (!target) return fail('Target outside the world');
  const cost = expeditionCost(kind);
  if (!canAfford(st, cost)) return fail('Not enough supplies for the journey');
  if (kind === 'settle') {
    if (st.population < 10) return fail('At least 10 people are needed to found a new settlement');
    if (!claimableTile(w, content, tx, ty, true)) return fail('Cannot settle there');
    if (state.settlements.length >= LIMITS.maxSettlements) return fail('The realm can support no more settlements');
    if (state.settlements.some((s) => Math.hypot(s.x - tx, s.y - ty) < 8)) return fail('Too close to an existing settlement');
  }
  payCost(st, cost);
  const id = nextId(state, 'expedition');
  const rng = new Rng([...state.rng] as [number, number, number, number]);
  const partySize = kind === 'settle' ? 3 : 2;
  state.exploration.expeditions.push({
    id,
    kind,
    settlementId: st.id,
    x: st.x,
    y: st.y,
    tx,
    ty,
    progress: 0,
    party: partySize,
    label: kind === 'settle' ? 'Settler party' : kind === 'survey' ? 'Surveyors' : 'Scouts',
    revealed: [],
    speed: rng.range(0.9, 1.2),
    supplies: 12,
    returnTick: -1,
  });
  const markerId = nextId(state, 'marker');
  w.markers.push({
    id: markerId,
    kind: kind === 'settle' ? 'scout' : 'expedition',
    x: st.x,
    y: st.y,
    tx,
    ty,
    label: kind === 'settle' ? 'Settlers' : 'Scouts',
    color: kind === 'settle' ? '#d9a84e' : '#7fc4a0',
  });
  pushNotification(state, `${kind === 'settle' ? 'A settler party' : 'An expedition'} sets out for the unknown.`, 'info', 'compass');
  return { ok: true, message: 'Expedition underway' };
}

// ---------------------------------------------------------------------------
// Trade
// ---------------------------------------------------------------------------

export function tradeNow(a: ActionContext, resource: ResourceId, amount: number, direction: 'buy' | 'sell'): ActionResult {
  const { state, content } = a;
  const cap = capitalOf(state);
  if (!cap) return fail('No settlement');
  const hasMarket = state.buildings.some(
    (b) => b.settlementId === cap.id && b.progress >= 1 && ['market', 'trade_post'].includes(b.typeId),
  );
  if (!hasMarket) return fail('Build a market or trade post to trade');
  const price = state.market.prices[resource]?.price ?? content.resources[resource]?.basePrice ?? 1;
  const def = content.resources[resource];
  if (!def) return fail('Unknown resource');
  if (amount <= 0) return fail('Invalid amount');
  const spread = 1.18 - (state.market.prices[resource] ? 0 : 0);
  if (direction === 'buy') {
    const unit = price * spread * (1 + state.market.tariff) * (1 + modOfState(state, cap.id, 'tradeBuyPrice'));
    const total = unit * amount;
    if (cap.treasury < total) return fail(`Need ${total.toFixed(0)} coin`);
    cap.treasury -= total;
    addStock(cap, resource, amount);
    state.market.tradeBalance -= total;
    state.market.prices[resource].demand += amount;
    return { ok: true, message: `Bought ${amount} ${def.name} for ${total.toFixed(0)} coin` };
  }
  const have = stockOf(cap, resource);
  if (have < amount) return fail('Not enough to sell');
  const unit = price * (1 / spread) * (1 - state.market.tariff) * (1 + modOfState(state, cap.id, 'tradeSellPrice'));
  const total = unit * amount;
  removeStock(cap, resource, amount);
  cap.treasury += total;
  state.market.tradeBalance += total;
  state.market.prices[resource].supply += amount;
  return { ok: true, message: `Sold ${amount} ${def.name} for ${total.toFixed(0)} coin` };
}

// ---------------------------------------------------------------------------
// Megaprojects
// ---------------------------------------------------------------------------

export function startMegaproject(a: ActionContext, id: string): ActionResult {
  const { state, content } = a;
  const def = content.megaprojects[id];
  if (!def) return fail('Unknown undertaking');
  const mp = state.megaprojects[id];
  if (!mp) return fail('Unknown undertaking');
  if (mp.status === 'done') return fail('Already complete');
  if (mp.status === 'building') return fail('Already under construction');
  if (!content.eras[state.research.era] || state.research.era < def.era) return fail(`Requires era ${def.era + 1}`);
  for (const tech of def.requiresTech) if (!hasTech(state, tech)) return fail(`Requires ${content.techs[tech]?.name ?? tech}`);
  const cap = capitalOf(state);
  if (!cap) return fail('No settlement');
  if (!canAfford(cap, def.cost)) return fail('Not enough materials');
  if (state.research.insight < def.insightCost) return fail(`Requires ${def.insightCost} insight`);
  payCost(cap, def.cost);
  state.research.insight -= def.insightCost;
  mp.status = 'building';
  mp.startedTick = state.tick;
  mp.progress = 0;
  mp.invested = { ...def.cost };
  pushNotification(state, `A great work begins: ${def.name}`, 'good', 'spark');
  addChronicle(state, `The Beginning of ${def.name}`, `The first stone of ${def.name} is laid. It will take generations to complete — but it will outlast us all.`, 'milestone', 3);
  return { ok: true, message: `${def.name} begun` };
}

// ---------------------------------------------------------------------------
// Ecology actions
// ---------------------------------------------------------------------------

export function plantForest(a: ActionContext, x: number, y: number, settlementId: number): ActionResult {
  const { state, content } = a;
  const st = settlementById(state, settlementId);
  if (!st) return fail('No settlement');
  const t = tileAt(state.world, x, y);
  if (!t) return fail('Outside the world');
  if (!claimableTile(state.world, content, x, y)) return fail('Cannot plant here');
  const cost: Record<ResourceId, number> = { wood: 1.5, fiber: 0.5 };
  if (!canAfford(st, cost)) return fail('Need wood and fiber for saplings');
  payCost(st, cost);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const n = tileAt(state.world, x + dx, y + dy);
      if (!n || content.biomes[n.biome]?.walkCost >= 20) continue;
      n.forest = Math.min(1, n.forest + 0.12);
      n.beauty = Math.min(1, n.beauty + 0.03);
    }
  }
  state.stats.treesPlanted++;
  return { ok: true, message: 'Saplings planted' };
}

// ---------------------------------------------------------------------------
// Diplomacy — responding to neighbour offers
// ---------------------------------------------------------------------------

/**
 * Accept or decline one of a neighbour's pending offers.
 * Offer shapes are authored by the neighbours system:
 *   gift    — they give `resource` x `amount` (or coin)
 *   trade   — favourable exchange of `resource` x `amount`
 *   demand  — they demand `resource` x `amount` (tribute)
 *   alliance— mutual defence and open markets
 *   war     — pay tribute or face war
 */
export function respondToNeighborOffer(a: ActionContext, neighborId: number, offerIndex: number, accept: boolean): ActionResult {
  const { state, content } = a;
  const civ = state.neighbors.civs.find((c) => c.id === neighborId);
  if (!civ) return fail('No such people');
  const offer = civ.offers[offerIndex];
  if (!offer) return fail('That offer is no longer on the table');
  if (offer.expiresTick > 0 && offer.expiresTick < state.tick) {
    civ.offers.splice(offerIndex, 1);
    return fail('That offer has expired');
  }
  const cap = capitalOf(state);
  if (!cap) return fail('No settlement');
  const def = offer.resource ? content.resources[offer.resource] : undefined;
  const amount = Math.max(0, offer.amount ?? 0);
  const unit = offer.resource ? state.market.prices[offer.resource]?.price ?? def?.basePrice ?? 1 : 1;
  const bestow = (): void => {
    if (offer.resource && def) addStock(cap, offer.resource, Math.max(1, amount));
    else cap.treasury += Math.max(10, amount || 20);
  };
  if (accept) {
    switch (offer.kind) {
      case 'gift': {
        bestow();
        civ.attitude = Math.min(100, civ.attitude + 8);
        civ.lastContactTick = state.tick;
        pushNotification(state, `Gift accepted from ${civ.name}.`, 'good', 'handshake');
        addChronicle(state, `A Gift from ${civ.name}`, `Envoys of ${civ.name} laid gifts at our hearth. Goodwill is cheaper than war.`, 'trade', 1);
        break;
      }
      case 'trade': {
        if (!offer.resource || !def || amount <= 0) return fail('This trade offer is malformed');
        if (stockOf(cap, offer.resource) >= amount) {
          removeStock(cap, offer.resource, amount);
          const profit = unit * amount * 1.24;
          cap.treasury += profit;
          civ.attitude = Math.min(100, civ.attitude + 5);
          pushNotification(state, `Sold ${amount} ${def.name} to ${civ.name} for ${Math.round(profit)} coin.`, 'good', 'coin');
        } else {
          const cost = unit * amount * 1.12;
          if (cap.treasury < cost) return fail(`Need ${Math.round(cost)} coin for this trade`);
          cap.treasury -= cost;
          addStock(cap, offer.resource, amount);
          civ.attitude = Math.min(100, civ.attitude + 4);
          pushNotification(state, `Bought ${amount} ${def.name} from ${civ.name} for ${Math.round(cost)} coin.`, 'good', 'coin');
        }
        break;
      }
      case 'demand': {
        if (offer.resource && def && amount > 0) {
          if (!canAfford(cap, { [offer.resource]: amount })) return fail(`Cannot afford to meet the demand for ${def.name}`);
          payCost(cap, { [offer.resource]: amount });
        } else {
          const tribute = Math.max(20, Math.round(amount || 40));
          if (cap.treasury < tribute) return fail(`Cannot afford the tribute of ${tribute} coin`);
          cap.treasury -= tribute;
        }
        civ.attitude = Math.min(100, civ.attitude + 6);
        pushNotification(state, `Tribute sent to ${civ.name}. The frontier is quiet — for now.`, 'info', 'coin');
        break;
      }
      case 'alliance': {
        civ.relation = 'alliance';
        civ.attitude = Math.max(30, civ.attitude) + 12;
        civ.lastContactTick = state.tick;
        pushNotification(state, `Alliance sworn with ${civ.name}.`, 'good', 'handshake');
        addChronicle(state, `The Pact of ${civ.name}`, `Our hearth and the halls of ${civ.name} are bound by oath. Their enemies are ours; ours are theirs.`, 'society', 3);
        break;
      }
      case 'war': {
        if (offer.resource && def && amount > 0) {
          if (!canAfford(cap, { [offer.resource]: amount })) return fail(`Cannot afford the tribute of ${def.name}`);
          payCost(cap, { [offer.resource]: amount });
        } else {
          const tribute = Math.max(30, Math.round(amount || 60));
          if (cap.treasury < tribute) return fail(`Cannot afford the tribute of ${tribute} coin`);
          cap.treasury -= tribute;
        }
        civ.attitude = Math.min(100, civ.attitude + 4);
        pushNotification(state, `${civ.name} withdraws its warband, satisfied.`, 'warn', 'shield');
        break;
      }
    }
  } else {
    switch (offer.kind) {
      case 'demand':
      case 'war': {
        civ.attitude = Math.max(-100, civ.attitude - 18);
        if (offer.kind === 'war') {
          civ.relation = 'war';
          pushNotification(state, `${civ.name} declares war. Their warbands are marching.`, 'bad', 'sword');
          addChronicle(state, `War with ${civ.name}`, `The demands of ${civ.name} were refused. Their banners now cross our fields.`, 'conflict', 3);
        } else {
          pushNotification(state, `We refuse the demands of ${civ.name}.`, 'warn', 'warning');
        }
        break;
      }
      case 'gift': {
        civ.attitude = Math.max(-100, civ.attitude - 4);
        pushNotification(state, `Gift returned to ${civ.name}.`, 'info', 'handshake');
        break;
      }
      case 'trade': {
        civ.attitude = Math.max(-100, civ.attitude - 3);
        pushNotification(state, `Trade with ${civ.name} declined.`, 'info', 'coin');
        break;
      }
      case 'alliance': {
        civ.attitude = Math.max(-100, civ.attitude - 5);
        pushNotification(state, `The alliance of ${civ.name} was politely declined.`, 'info', 'handshake');
        break;
      }
    }
  }
  civ.offers.splice(offerIndex, 1);
  return { ok: true, message: accept ? 'Offer accepted' : 'Offer declined' };
}

/** Send a goodwill gift of goods or coin to a neighbour. */
export function giftToNeighbor(a: ActionContext, neighborId: number, resource: ResourceId | null, amount: number): ActionResult {
  const { state, content } = a;
  const civ = state.neighbors.civs.find((c) => c.id === neighborId);
  if (!civ) return fail('No such people');
  const cap = capitalOf(state);
  if (!cap) return fail('No settlement');
  let value = 0;
  if (resource) {
    const def = content.resources[resource];
    if (!def) return fail('Unknown gift');
    if (!canAfford(cap, { [resource]: amount })) return fail('Not enough to give');
    payCost(cap, { [resource]: amount });
    value = (state.market.prices[resource]?.price ?? def.basePrice) * amount;
  } else {
    const coin = Math.max(1, Math.round(amount));
    if (cap.treasury < coin) return fail('Not enough coin');
    cap.treasury -= coin;
    value = coin;
  }
  const gain = Math.min(20, 4 + value / 25);
  civ.attitude = Math.min(100, civ.attitude + gain);
  civ.lastContactTick = state.tick;
  pushNotification(state, `Gift sent to ${civ.name}. (+${Math.round(gain)} regard)`, 'good', 'handshake');
  return { ok: true, message: 'Gift sent' };
}

// ---------------------------------------------------------------------------
// New settlement helper used by exploration system
// ---------------------------------------------------------------------------

export function foundSettlementAt(a: ActionContext, x: number, y: number, fromSettlementId: number): Settlement | null {
  const { state, content } = a;
  if (!claimableTile(state.world, content, x, y, true)) return null;
  const st = createSettlement(state, content, x, y, false);
  state.settlements.push(st);
  claimAround(state, content, st, 2);
  const rng = new Rng([...state.rng] as [number, number, number, number]);
  for (let i = 0; i < 3; i++) {
    createCitizen(state, content, rng, { settlementId: st.id, age: rng.int(18, 38), profession: 'idle' });
  }
  st.stock.berries = 20;
  st.stock.wood = 15;
  st.stock.stone = 8;
  const origin = settlementById(state, fromSettlementId);
  if (origin) {
    origin.stock.berries = Math.max(0, (origin.stock.berries ?? 0) - 15);
    origin.stock.wood = Math.max(0, (origin.stock.wood ?? 0) - 12);
  }
  pushNotification(state, `${st.name} is founded.`, 'good', 'flag');
  addChronicle(state, `The Founding of ${st.name}`, `A handful of families leave the old hearth behind and raise a new banner at ${st.name}.`, 'founding', 3);
  return st;
}
