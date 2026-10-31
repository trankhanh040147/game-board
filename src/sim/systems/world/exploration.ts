/**
 * Exploration system — fog of war, expeditions, site visits and the discovery of neighbours.
 *
 * The player's settlement continuously charts a small radius; roads and expeditions push the
 * fog back further. Expeditions (scout/survey/settle) move day by day toward a target, reveal
 * tiles along the way, visit sites and discover neighbouring civilisations.
 *
 * `applySiteEffects(ctx, site)` is exported for actions/events to re-use: it interprets the
 * structural subset of EventEffect (stock, insight, culture, treasury, morale, health,
 * tileDeposit, forest, fertility, pollution, reveal, flag, relation, tempo/settlement modifiers,
 * chronicle, notification, discoverSite, scheduleEvent, inspiration, grantTech) and debug-logs
 * the people/combat kinds that sim-society owns (kill, migrate, raid, destroyBuildings).
 */
import type {
  EventEffect,
  Settlement,
  SimContext,
  SimSystem,
  Site,
  Tile,
  WorldState,
} from '../../types';
import {
  addStock,
  capitalOf,
  clamp,
  getFlag,
  livingCitizens,
  modOf,
  nextId,
  removeStock,
  setFlag,
  tileAt,
} from '../../core';
import { countExploredTiles, revealCircle } from '../../world/worldgen';
import { isWaterTile, tileSafe, walkCost } from '../../world/terrain';

// ---------------------------------------------------------------------------
// Site effects (shared with actions / events)
// ---------------------------------------------------------------------------

export function applySiteEffects(ctx: SimContext, site: Site): void {
  const def = ctx.c.sites[site.defId];
  if (!def) return;
  const s = ctx.s;
  const chronicleTitles = new Set<string>();
  for (const effect of def.effects) {
    if (effect.kind === 'chronicle') chronicleTitles.add(effect.title);
    applyEffect(ctx, effect);
  }
  if (def.chronicleTitle && !chronicleTitles.has(def.chronicleTitle)) {
    ctx.chronicle(
      def.chronicleTitle,
      def.chronicleBody ?? def.desc,
      'discovery',
      def.rarity === 'legendary' ? 3 : 2,
    );
  }
  ctx.notify(
    `${def.name}: ${def.desc}`,
    'discovery',
    def.icon || 'eye',
  );
  // Central visit bookkeeping so actions/events calling this directly also count.
  s.exploration.sitesVisited += 1;
  if (site.visited === false) site.visited = true;
}

function pickSettlements(s: SimContext['s'], which: 'capital' | 'all' | 'poorest' | 'richest'): Settlement[] {
  const living = s.settlements.filter((st) => st.population > 0 || st.isCapital);
  if (living.length === 0) return [];
  switch (which) {
    case 'capital': {
      const cap = capitalOf(s);
      return cap ? [cap] : [living[0]];
    }
    case 'all':
      return living;
    case 'poorest':
      return [living.slice().sort((a, b) => a.treasury - b.treasury)[0]];
    case 'richest':
      return [living.slice().sort((a, b) => b.treasury - a.treasury)[0]];
    default:
      return living;
  }
}

function roundTiles(
  w: WorldState,
  cx: number,
  cy: number,
  radius: number,
  fn: (t: Tile, dist: number) => void,
): void {
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > radius) continue;
      const t = tileSafe(w, cx + dx, cy + dy);
      if (t) fn(t, d);
    }
  }
}

function applyEffect(ctx: SimContext, effect: EventEffect): void {
  const s = ctx.s;
  const c = ctx.c;
  const cap = capitalOf(s);
  switch (effect.kind) {
    case 'stock': {
      for (const st of pickSettlements(s, effect.settlement)) {
        if (effect.mode === 'mul') {
          st.stock[effect.resource] = Math.max(0, (st.stock[effect.resource] ?? 0) * effect.amount);
        } else if (effect.amount >= 0) {
          addStock(st, effect.resource, effect.amount);
        } else {
          removeStock(st, effect.resource, -effect.amount);
        }
      }
      break;
    }
    case 'stockFraction': {
      for (const st of pickSettlements(s, effect.settlement)) {
        const have = st.stock[effect.resource] ?? 0;
        removeStock(st, effect.resource, have * clamp(effect.fraction, 0, 1));
      }
      break;
    }
    case 'morale': {
      for (const st of pickSettlements(s, effect.settlement)) {
        st.morale = clamp(st.morale + effect.amount, 0, 100);
      }
      break;
    }
    case 'health': {
      for (const st of pickSettlements(s, effect.settlement)) {
        for (const cit of livingCitizens(s)) {
          if (cit.settlementId !== st.id) continue;
          cit.health = clamp(cit.health + effect.amount, 1, 100);
        }
      }
      break;
    }
    case 'treasury': {
      for (const st of pickSettlements(s, effect.settlement)) st.treasury += effect.amount;
      break;
    }
    case 'insight':
      s.research.insight += effect.amount;
      s.research.totalInsight += Math.max(0, effect.amount);
      break;
    case 'culture':
      if (cap) cap.culture += effect.amount;
      s.society.culturePoints += effect.amount;
      break;
    case 'tempoModifier': {
      s.events.active.push({
        id: nextId(s, 'event'),
        eventId: 'site_blessing',
        startTick: ctx.tick,
        endTick: ctx.tick + Math.max(1, effect.days),
        title: 'Site blessing',
        modifier: { [effect.key]: effect.value },
        settlementId: -1,
        kind: 'tempo',
      });
      break;
    }
    case 'settlementModifier': {
      if (!cap) break;
      s.events.active.push({
        id: nextId(s, 'event'),
        eventId: 'site_blessing',
        startTick: ctx.tick,
        endTick: ctx.tick + Math.max(1, effect.days),
        title: 'Site blessing',
        modifier: { [effect.key]: effect.value },
        settlementId: cap.id,
        kind: 'tempo',
      });
      break;
    }
    case 'tileDeposit': {
      if (!cap) break;
      roundTiles(s.world, cap.x, cap.y, Math.max(1, effect.radius), (t) => {
        if (t.deposit) {
          if (t.deposit.resource === effect.resource) {
            t.deposit.amount += effect.amount;
            t.deposit.initial += effect.amount;
          }
        } else if (!isWaterTile(c, t)) {
          t.deposit = {
            resource: effect.resource,
            amount: effect.amount,
            initial: effect.amount,
            quality: 0.7,
            kind: 'surface',
          };
        }
      });
      break;
    }
    case 'forest':
      if (!cap) break;
      roundTiles(s.world, cap.x, cap.y, Math.max(1, effect.radius), (t) => {
        t.forest = Math.round(clamp(t.forest + effect.amount, 0, 1) * 1000) / 1000;
      });
      break;
    case 'fertility':
      if (!cap) break;
      roundTiles(s.world, cap.x, cap.y, Math.max(1, effect.radius), (t) => {
        t.fertility = Math.round(clamp(t.fertility + effect.amount, 0, 1) * 1000) / 1000;
      });
      break;
    case 'pollution':
      if (!cap) break;
      roundTiles(s.world, cap.x, cap.y, Math.max(1, effect.radius), (t) => {
        t.pollution = Math.round(clamp(t.pollution + effect.amount, 0, 1) * 1000) / 1000;
      });
      break;
    case 'reveal':
      if (!cap) break;
      revealWithDiscovery(ctx, cap.x, cap.y, Math.max(1, effect.radius));
      break;
    case 'discoverSite': {
      if (!cap) break;
      const radius = Math.max(1, effect.radius);
      for (const site of s.world.sites) {
        if (site.discovered) continue;
        if (effect.siteId && site.defId !== effect.siteId) continue;
        if (Math.hypot(site.x - cap.x, site.y - cap.y) > radius) continue;
        discoverSite(ctx, site);
      }
      break;
    }
    case 'relation': {
      const civ = s.neighbors.civs.find((civ) => civ.id === effect.neighborId);
      if (civ) civ.attitude = clamp(civ.attitude + effect.amount, -100, 100);
      break;
    }
    case 'flag':
      setFlag(s, effect.flag, effect.value);
      break;
    case 'chronicle':
      ctx.chronicle(effect.title, effect.body, 'discovery', effect.importance);
      break;
    case 'notification':
      ctx.notify(effect.text, effect.severity, 'star');
      break;
    case 'scheduleEvent':
      s.events.scheduled.push({ eventId: effect.eventId, fireTick: ctx.tick + Math.max(0, effect.delayDays) });
      break;
    case 'inspiration':
      s.research.insight += effect.amount;
      s.research.totalInsight += Math.max(0, effect.amount);
      if (effect.branch) {
        s.research.affinity[effect.branch] = (s.research.affinity[effect.branch] ?? 0) + effect.amount * 0.1;
      }
      break;
    case 'grantTech': {
      if (!c.techs[effect.tech]) break;
      if (s.research.completed[effect.tech] === undefined) {
        s.research.completed[effect.tech] = ctx.tick;
        ctx.notify(`A forgotten art returns to us: ${c.techs[effect.tech].name}.`, 'discovery', 'star');
      }
      break;
    }
    case 'unlockBuilding': {
      setFlag(s, `unlock_building:${effect.buildingId}`, 1);
      const name = c.buildings[effect.buildingId]?.name ?? effect.buildingId;
      ctx.notify(`We now know how to raise a ${name}.`, 'discovery', 'hammer');
      break;
    }
    case 'unlockPolicy': {
      setFlag(s, `unlock_policy:${effect.policy}`, 1);
      ctx.notify('A new way of governing ourselves is now open to us.', 'discovery', 'scroll');
      break;
    }
    // Owned by society/events interpreters (people + combat consequences).
    case 'kill':
    case 'migrate':
    case 'raid':
    case 'destroyBuildings':
    case 'spawnRefugees':
      ctx.log(`[exploration] site effect '${effect.kind}' deferred to society/events interpreter`);
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Fog-of-war reveal with discovery bookkeeping
// ---------------------------------------------------------------------------

export function revealWithDiscovery(
  ctx: SimContext,
  cx: number,
  cy: number,
  radius: number,
): number {
  const s = ctx.s;
  const w = s.world;
  const ex = s.exploration;
  const newly = revealCircle(w, cx, cy, radius);
  if (newly > 0) {
    ex.revealedTiles = countExploredTiles(w);
    ex.mapReveal = w.tiles.length ? ex.revealedTiles / w.tiles.length : 0;
  }
  // sites inside the revealed bubble are discovered (but not yet visited)
  const r = Math.ceil(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > radius * radius) continue;
      const t = tileSafe(w, cx + dx, cy + dy);
      if (!t || t.siteIndex < 0) continue;
      const site = w.sites[t.siteIndex];
      if (site && !site.discovered) discoverSite(ctx, site);
    }
  }
  // neighbour capitals inside the bubble are contacted
  for (const civ of s.neighbors.civs) {
    if (civ.discovered) continue;
    const d = Math.hypot(civ.capital.x - cx, civ.capital.y - cy);
    if (d <= radius + 2) {
      civ.discovered = true;
      civ.discoveredTick = ctx.tick;
      s.stats.neighborsMet += 1;
      ctx.notify(
        `Smoke on the horizon: ${civName(civ)} have been met. They are ${archetypeLabel(civ.archetype)}, and they know this land better than we do.`,
        'discovery',
        'flag',
      );
      ctx.chronicle(
        `First Contact: ${civName(civ)}`,
        `Scouts returned with word of another people beyond the ridge — ${archetypeLabel(civ.archetype)}, with their own fields and their own gods.`,
        'discovery',
        2,
      );
    }
  }
  return newly;
}

function discoverSite(ctx: SimContext, site: Site): void {
  const s = ctx.s;
  site.discovered = true;
  site.discoveredTick = ctx.tick;
  s.exploration.sitesFound += 1;
  const def = ctx.c.sites[site.defId];
  if (def) {
    const flavour: 'milestone' | 'discovery' = def.rarity === 'legendary' ? 'milestone' : 'discovery';
    ctx.notify(`Discovered: ${def.name} — ${def.desc}`, flavour, 'eye');
  }
}

function civName(civ: { name: string }): string {
  const n = civ.name.trim();
  if (/^the\s/i.test(n)) return n.charAt(0).toUpperCase() + n.slice(1);
  return `the ${n}`;
}

function archetypeLabel(archetype: string): string {
  switch (archetype) {
    case 'agrarian':
      return 'patient farmers of the river flats';
    case 'mercantile':
      return 'traders with bright boats and sharper ledgers';
    case 'martial':
      return 'hard-eyed warriors who keep their oaths and their grudges';
    case 'scholarly':
      return 'star-watchers and keepers of old books';
    default:
      return 'riders who follow the herds and the seasons';
  }
}

// ---------------------------------------------------------------------------
// Main system
// ---------------------------------------------------------------------------

export const explorationSystem: SimSystem = (ctx) => {
  const s = ctx.s;
  const w = s.world;
  const c = ctx.c;
  const ex = s.exploration;
  const tick = ctx.tick;
  const cap = capitalOf(s);
  const speedMod = modOf(ctx, cap ? cap.id : -1, 'expeditionSpeed');

  // ---- 1. chart the land around settlements (and along roads) ----------
  for (const st of s.settlements) {
    const radius = 3 + Math.min(2, Math.floor(st.population / 45));
    revealWithDiscovery(ctx, st.x, st.y, radius);
  }
  if (tick % 3 === 0) {
    for (const st of s.settlements) {
      for (let dy = -9; dy <= 9; dy++) {
        for (let dx = -9; dx <= 9; dx++) {
          const t = tileSafe(w, st.x + dx, st.y + dy);
          if (!t || t.road < 0.35) continue;
          if (w.explored[(st.y + dy) * w.width + (st.x + dx)] === 1) continue;
          revealWithDiscovery(ctx, st.x + dx, st.y + dy, 1);
        }
      }
    }
  }

  // ---- 2. expeditions ---------------------------------------------------
  for (let i = ex.expeditions.length - 1; i >= 0; i--) {
    const e = ex.expeditions[i];
    const here = tileAt(w, Math.round(e.x), Math.round(e.y));
    const terrain = here ? walkCost(c, here) : 1.4;
    const baseSpeed = e.kind === 'scout' ? 1.35 : e.kind === 'survey' ? 1.05 : 0.85;
    const speed = Math.max(0.2, (baseSpeed * (1 + speedMod)) / clamp(terrain, 0.7, 3.2));

    const dx = e.tx - e.x;
    const dy = e.ty - e.y;
    const dist = Math.hypot(dx, dy);
    const step = Math.min(speed, Math.max(0, dist));
    if (dist > 0.001) {
      e.x += (dx / dist) * step;
      e.y += (dy / dist) * step;
    }
    // progress from the owning settlement to the target
    const owner = s.settlements.find((st) => st.id === e.settlementId);
    const total = owner ? Math.max(1, Math.hypot(e.tx - owner.x, e.ty - owner.y)) : Math.max(1, dist);
    e.progress = clamp(1 - Math.hypot(e.tx - e.x, e.ty - e.y) / total, 0, 1);

    // fog opens along the route
    const revealRadius = e.kind === 'scout' ? 2 : 1.5;
    if (tick % 1 === 0) revealWithDiscovery(ctx, Math.round(e.x), Math.round(e.y), revealRadius);

    // supplies drain; an unsupplied party turns for home
    e.supplies -= 0.32 + e.party * 0.022;
    if (e.supplies <= 0) {
      ctx.notify(
        `${e.label} is out of supplies and turning back. They reached ${Math.round(e.progress * 100)}% of the way.`,
        'warn',
        'pack',
      );
      ex.expeditions.splice(i, 1);
      continue;
    }

    // visit any site the party stands on
    const standing = tileAt(w, Math.round(e.x), Math.round(e.y));
    if (standing && standing.siteIndex >= 0) {
      const site = w.sites[standing.siteIndex];
      if (site && !site.visited) {
        visitSite(ctx, site, e.label);
      }
    }

    // arrival
    if (Math.hypot(e.tx - e.x, e.ty - e.y) < 0.8) {
      arrive(ctx, e);
      ex.expeditions.splice(i, 1);
    }
  }

  // ---- 3. renderer markers ---------------------------------------------
  const others = w.markers.filter((m) => m.kind !== 'expedition' && m.kind !== 'scout');
  w.markers = others;
  for (const e of ex.expeditions) {
    w.markers.push({
      id: nextId(s, 'marker'),
      kind: e.kind === 'scout' ? 'scout' : 'expedition',
      x: Math.round(e.x),
      y: Math.round(e.y),
      tx: e.tx,
      ty: e.ty,
      label: e.label,
      color: e.kind === 'scout' ? '#d9c9a3' : '#9fc0d4',
    });
  }

  // ---- 4. site legend bookkeeping --------------------------------------
  for (const site of w.sites) {
    if (!site.visited) continue;
    const def = c.sites[site.defId];
    if (def?.rarity !== 'legendary') continue;
    if (!ex.legendaryFound.includes(site.id)) {
      ex.legendaryFound.push(site.id);
      ctx.chronicle(
        `The ${def.name}`,
        def.chronicleBody ?? 'A place out of the old stories, found at last, and found to be real.',
        'legend',
        3,
      );
      ctx.notify(`A legend made real: ${def.name}.`, 'milestone', 'crown');
    }
  }

  // ---- 5. map reveal bookkeeping --------------------------------------
  ex.revealedTiles = countExploredTiles(w);
  ex.mapReveal = w.tiles.length ? ex.revealedTiles / w.tiles.length : 0;
  setFlag(s, 'exploration.mapReveal01', Math.round(ex.mapReveal * 100));
  if (ex.mapReveal > 0.5 && getFlag(s, 'exploration.halfWarn') !== 1) {
    setFlag(s, 'exploration.halfWarn', 1);
    ctx.notify('Half the known world is charted. Beyond the maps, the land keeps its secrets.', 'discovery', 'map');
  }
};

function visitSite(ctx: SimContext, site: Site, label: string): void {
  const def = ctx.c.sites[site.defId];
  site.visited = true;
  applySiteEffects(ctx, site);
  if (def && !def.chronicleTitle) {
    // Sites without their own lore entry get an expedition log line instead.
    ctx.chronicle(
      `${label} reaches the ${def.name}`,
      def.chronicleBody ?? def.desc,
      'discovery',
      def.rarity === 'legendary' ? 3 : 1,
    );
  }
}

function arrive(ctx: SimContext, e: SimContext['s']['exploration']['expeditions'][number]): void {
  const s = ctx.s;
  const w = s.world;
  const tx = Math.round(e.tx);
  const ty = Math.round(e.ty);
  switch (e.kind) {
    case 'scout':
      revealWithDiscovery(ctx, tx, ty, 4);
      ctx.notify(`${e.label} returns from the wilds with a full map of the country around the target.`, 'good', 'map');
      break;
    case 'survey':
      revealWithDiscovery(ctx, tx, ty, 6);
      ctx.notify(`${e.label} has surveyed the region in detail. Deposits and paths are marked on our charts.`, 'good', 'map');
      s.flags['exploration.surveys'] = (s.flags['exploration.surveys'] ?? 0) + 1;
      break;
    case 'settle':
      revealWithDiscovery(ctx, tx, ty, 5);
      setFlag(s, 'exploration.settleReadyX', tx);
      setFlag(s, 'exploration.settleReadyY', ty);
      setFlag(s, 'exploration.settleReadyTick', ctx.tick);
      ctx.notify(
        'The settle party has reached the chosen ground. The site is cleared and ready for a new settlement.',
        'good',
        'flag',
      );
      break;
    default:
      break;
  }
  // visit any site at the destination
  const t = tileAt(w, tx, ty);
  if (t && t.siteIndex >= 0) {
    const site = w.sites[t.siteIndex];
    if (site && !site.visited) visitSite(ctx, site, e.label);
  }
}

/** Utility for actions.ts: start an expedition from a settlement. */
export function createExpedition(
  s: SimContext['s'],
  kind: SimContext['s']['exploration']['expeditions'][number]['kind'],
  settlementId: number,
  x: number,
  y: number,
  tx: number,
  ty: number,
  party = 4,
  supplies = 20,
  label = 'Expedition',
): SimContext['s']['exploration']['expeditions'][number] {
  const e = {
    id: nextId(s, 'expedition'),
    kind,
    settlementId,
    x,
    y,
    tx,
    ty,
    progress: 0,
    party,
    label,
    revealed: [] as number[],
    speed: kind === 'scout' ? 1.35 : kind === 'survey' ? 1.05 : 0.85,
    supplies,
    returnTick: -1,
  };
  s.exploration.expeditions.push(e);
  return e;
}

