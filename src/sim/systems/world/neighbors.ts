/**
 * Neighbours system — 3-5 autonomous civilisations living their own lives on the map.
 *
 * Each civ has an archetype, a capital on suitable ground, an attitude toward the player,
 * a simple wealth/military/tech/population economy, periodic offers (trade/gift/demand/
 * alliance/war), telegraphed raids during war, and diplomacy transitions.
 *
 * Civs start UNDISCOVERED; the exploration system reveals them when scouts come near.
 * `initNeighbors(s, world, rng, content?)` is exported for createNewGame, but the system also
 * lazily initialises on its first tick so the game is robust either way.
 */
import type {
  Content,
  NeighborArchetype,
  NeighborCiv,
  ResourceCategory,
  ResourceId,
  SimSystem,
  WorldState,
} from '../../types';
import { capitalOf, clamp, getFlag, modOf, removeStock, setFlag } from '../../core';
import { NEIGHBOR_COLORS, NEIGHBOR_FALLBACK_NAMES } from '../../world/names';
import { isWaterTile, tileSafe, walkCost } from '../../world/terrain';

const ARCHETYPES: NeighborArchetype[] = [
  'agrarian',
  'mercantile',
  'martial',
  'scholarly',
  'nomadic',
];

export function initNeighbors(
  s: SimContextState,
  world: WorldState,
  rng: () => number,
  content?: Content,
): void {
  if (s.neighbors.civs.length > 0) return;
  const desired = 3 + Math.floor(rng() * 3); // 3..5
  const sites = pickCapitalSites(world, rng, content, desired);
  if (sites.length === 0) return;

  const usedNames = new Set<string>();
  const namePool = content?.names?.neighborNames?.length
    ? content.names.neighborNames
    : NEIGHBOR_FALLBACK_NAMES;
  const titlePool = content?.names?.neighborTitles ?? [];

  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    const archetype = ARCHETYPES[Math.floor(rng() * ARCHETYPES.length)];
    let name = namePool[Math.floor(rng() * namePool.length)] ?? NEIGHBOR_FALLBACK_NAMES[i % NEIGHBOR_FALLBACK_NAMES.length];
    if (usedNames.has(name)) name = `${name} ${titlePool.length ? titlePool[Math.floor(rng() * titlePool.length)] : ''}`.trim();
    usedNames.add(name);
    const id = s.neighbors.nextId++;
    const civ: NeighborCiv = {
      id,
      name,
      archetype,
      color: NEIGHBOR_COLORS[id % NEIGHBOR_COLORS.length],
      capital: { x: site.x, y: site.y },
      discovered: false,
      discoveredTick: -1,
      attitude: 0 + Math.round(rng() * 10) - 3,
      relation: 'unknown',
      wealth: archetype === 'mercantile' ? 90 + rng() * 60 : 45 + rng() * 50,
      military: archetype === 'martial' ? 55 + rng() * 40 : 22 + rng() * 25,
      techLevel: archetype === 'scholarly' ? 2 : 1,
      population: 70 + Math.round(rng() * 90),
      exports: pickGoods(content, rng, ['food', 'raw', 'luxury'], 2),
      imports: pickGoods(content, rng, ['refined', 'component', 'science'], 2),
      lastContactTick: -1,
      offers: [],
      raidCooldown: 0,
    };
    s.neighbors.civs.push(civ);
  }
}

type SimContextState = Parameters<SimSystem>[0]['s'];

// ---------------------------------------------------------------------------
// Capital site picking
// ---------------------------------------------------------------------------

function pickCapitalSites(
  world: WorldState,
  rng: () => number,
  content: Content | undefined,
  count: number,
): { x: number; y: number }[] {
  const candidates: { x: number; y: number; score: number }[] = [];
  const cx = world.width / 2;
  const cy = world.height / 2;
  const maxR = Math.hypot(cx, cy);
  for (let y = 4; y < world.height - 4; y += 2) {
    for (let x = 4; x < world.width - 4; x += 2) {
      const t = tileSafe(world, x, y);
      if (!t) continue;
      if (content ? isWaterTile(content, t) : t.water > 0.9) continue;
      if (content && walkCost(content, t) > 4) continue;
      const dStart = Math.hypot(x - world.startX, y - world.startY);
      if (dStart < 15) continue;
      const dCenter = Math.hypot(x - cx, y - cy) / maxR;
      const score =
        t.fertility * 1.4 +
        t.water * 1.1 +
        t.forest * 0.35 -
        Math.abs(dCenter - 0.62) * 0.8 +
        rng() * 0.9;
      candidates.push({ x, y, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const chosen: { x: number; y: number }[] = [];
  for (const cand of candidates) {
    if (chosen.length >= count) break;
    if (chosen.some((o) => Math.hypot(o.x - cand.x, o.y - cand.y) < 11)) continue;
    chosen.push({ x: cand.x, y: cand.y });
  }
  return chosen;
}

function pickGoods(
  content: Content | undefined,
  rng: () => number,
  categories: ResourceCategory[],
  count: number,
): ResourceId[] {
  if (!content) return [];
  const pool: ResourceId[] = [];
  for (const id of content.resourceOrder) {
    const def = content.resources[id];
    if (!def) continue;
    if (def.tradable === false) continue;
    if (!categories.includes(def.category)) continue;
    pool.push(id);
  }
  const out: ResourceId[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const pick = Math.floor(rng() * pool.length);
    out.push(pool[pick]);
    pool.splice(pick, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main system
// ---------------------------------------------------------------------------

export const neighborsSystem: SimSystem = (ctx) => {
  const s = ctx.s;
  const rng = ctx.rng;
  const tick = ctx.tick;
  if (s.neighbors.civs.length === 0) initNeighbors(s, s.world, rng, ctx.c);

  const cap = capitalOf(s);
  const diplo = modOf(ctx, cap ? cap.id : -1, 'diplomacy');
  const combat = clamp(modOf(ctx, cap ? cap.id : -1, 'combatStrength'), -0.6, 2);

  for (const civ of s.neighbors.civs) {
    // ---- slow economic / demographic life ------------------------------
    const merc = civ.archetype === 'mercantile' ? 1.6 : 1;
    const martial = civ.archetype === 'martial' ? 2.2 : 0.8;
    const agrarian = civ.archetype === 'agrarian' ? 1.7 : 1;
    civ.wealth = clamp(civ.wealth + 0.3 * merc + (civ.relation === 'trade' ? 0.45 : 0), 0, 600);
    civ.military = clamp(civ.military + 0.03 * martial, 0, 400);
    civ.population = clamp(civ.population + 0.018 * agrarian, 0, 800);
    if (tick % 48 === 0) {
      civ.techLevel = clamp(civ.techLevel + (civ.archetype === 'scholarly' ? 0.8 : 0.45), 0, 6);
    }

    // ---- attitude drift toward the archetype's baseline ----------------
    const baseline = archetypeBaseline(civ.archetype);
    let drift = (baseline - civ.attitude) * 0.004;
    if (civ.discovered) drift += (rng() - 0.5) * 0.25 + diplo * 0.5;
    if (civ.relation === 'trade') drift += 0.05;
    if (civ.relation === 'war') drift -= 0.04;
    civ.attitude = clamp(civ.attitude + drift, -100, 100);

    // expire stale offers
    if (civ.offers.length > 0) civ.offers = civ.offers.filter((o) => o.expiresTick > tick);

    if (!civ.discovered) continue;

    // ---- diplomacy transitions ----------------------------------------
    if (civ.relation === 'unknown') civ.relation = 'neutral';
    if (
      civ.attitude <= -78 &&
      civ.relation !== 'war' &&
      civ.relation !== 'alliance' &&
      tick - civ.lastContactTick > 4
    ) {
      civ.relation = 'war';
      civ.raidCooldown = 10;
      civ.lastContactTick = tick;
      ctx.notify(
        `${capitalize(civName(civ))} have declared war. Their warriors are gathering at the border.`,
        'bad',
        'sword',
      );
      ctx.chronicle(
        `War with ${civName(civ)}`,
        `Old grievances were not settled by words. The ${civ.name} sharpened their blades and the border watch doubled.`,
        'conflict',
        3,
      );
    } else if (civ.relation === 'war' && civ.attitude > -18 && rng() < 0.02) {
      civ.relation = 'neutral';
      civ.lastContactTick = tick;
      ctx.notify(`Envoys of ${civName(civ)} have agreed to a truce. The border is quiet again.`, 'good', 'dove');
    }

    // ---- periodic offers ------------------------------------------------
    if (civ.offers.length === 0 && tick - civ.lastContactTick > 6 && rng() < offerChance(civ)) {
      createOffer(ctx, civ);
    }

    // ---- raids ----------------------------------------------------------
    const pendingKey = `neighbor.raid.pending.${civ.id}`;
    const pending = getFlag(s, pendingKey);
    const hostile = civ.relation === 'war' || (civ.attitude < -60 && civ.archetype === 'martial');
    if (hostile) {
      if (pending > 0 && tick >= pending) {
        setFlag(s, pendingKey, 0);
        executeRaid(ctx, civ, combat);
        civ.raidCooldown = 26 + Math.floor(rng() * 22);
        civ.lastContactTick = tick;
      } else if (pending === 0) {
        civ.raidCooldown -= 1;
        if (civ.raidCooldown <= 0 && rng() < 0.05) {
          setFlag(s, pendingKey, tick + 2);
          const contact = rng() < 0.5;
          ctx.notify(
            `Raiders of ${civName(civ)} are crossing the border. ${contact ? 'Their war-band was counted at dusk — warn the watch.' : 'Smoke has been seen above their camps.'} Two days, perhaps less.`,
            'warn',
            'sword',
          );
          ctx.chronicle(
            `The Border Stirs`,
            `Smoke rose beyond the marches and the watch came down from the ridge with word of a war-band. The gates were closed at noon and left closed.`,
            'conflict',
            2,
          );
        }
      }
    }
  }

  // ---- raider markers (cosmetic, rebuilt each tick) --------------------
  const others = s.world.markers.filter((m) => m.kind !== 'raider');
  for (const civ of s.neighbors.civs) {
    if (getFlag(s, `neighbor.raid.pending.${civ.id}`) <= 0) continue;
    if (!cap) break;
    others.push({
      id: 0,
      kind: 'raider',
      x: civ.capital.x,
      y: civ.capital.y,
      tx: cap.x,
      ty: cap.y,
      label: `Raiders — ${capitalize(civName(civ))}`,
      color: '#b4544a',
    });
  }
  for (const m of others) if (m.kind === 'raider') m.id = s.nextIds.marker++;
  s.world.markers = others;
};

// ---------------------------------------------------------------------------
// Offers & raids
// ---------------------------------------------------------------------------

function offerChance(civ: NeighborCiv): number {
  if (civ.relation === 'war') return 0;
  if (civ.archetype === 'mercantile') return 0.05;
  if (civ.attitude > 40) return 0.04;
  if (civ.attitude < -40) return 0.03;
  return 0.022;
}

function createOffer(ctx: Parameters<SimSystem>[0], civ: NeighborCiv): void {
  const s = ctx.s;
  const c = ctx.c;
  const rng = ctx.rng;
  const cap = capitalOf(s);
  if (!cap) return;
  const resName = (id: ResourceId | undefined): string =>
    id ? (c.resources[id]?.name ?? id) : 'goods';
  const good = civ.exports[Math.floor(rng() * Math.max(1, civ.exports.length))] ??
    c.resourceOrder[Math.floor(rng() * c.resourceOrder.length)];
  let amount = 15 + Math.round(rng() * 25);
  const expiresTick = ctx.tick + 8 + Math.floor(rng() * 5);
  let kind: NeighborCiv['offers'][number]['kind'] = 'trade';
  let text = '';
  if (civ.attitude < -40) {
    // A demand asks less than a trade offer so the text and the stored amount agree
    // (actions.ts pays the offer's `amount` when the player submits to it).
    kind = 'demand';
    const theirGun = civ.military > 60 ? 'their war-band' : 'their hunters';
    amount = Math.max(5, Math.round(amount * 0.6));
    text = `${capitalize(civName(civ))} demand ${amount} ${resName(good)} from our stores, or ${theirGun} will take it.`;
    civ.attitude = clamp(civ.attitude - 3, -100, 100);
  } else if (civ.attitude > 45 && civ.relation !== 'alliance' && rng() < 0.3) {
    kind = 'alliance';
    text = `${capitalize(civName(civ))} propose a lasting alliance: shared roads, shared enemies, shared salt.`;
  } else if (rng() < 0.3) {
    kind = 'gift';
    text = `${capitalize(civName(civ))} send ${amount} ${resName(good)} as a gift, and ask only that we remember them kindly.`;
  } else {
    kind = 'trade';
    const want = civ.imports[Math.floor(rng() * Math.max(1, civ.imports.length))];
    text = `${capitalize(civName(civ))} offer ${amount} ${resName(good)} in exchange for what we can spare of ${resName(want)}.`;
  }
  civ.offers.push({ kind, resource: good, amount, text, expiresTick });
  civ.lastContactTick = ctx.tick;
  ctx.notify(`Envoys from ${civName(civ)}: ${text}`, 'info', 'scroll');
}

function executeRaid(ctx: Parameters<SimSystem>[0], civ: NeighborCiv, combat: number): void {
  const s = ctx.s;
  const cap = capitalOf(s);
  if (!cap) return;
  const defence = clamp(1 - clamp(combat, -0.5, 2) * 0.55, 0.2, 1.6);
  const strength = (civ.military * 0.35 + civ.population * 0.08) * defence;
  const buildings = s.buildings.filter((b) => b.settlementId === cap.id);
  const hits = Math.min(buildings.length, 1 + Math.floor(strength / 45));
  let damaged = 0;
  for (let i = 0; i < hits; i++) {
    const b = buildings[Math.floor(ctx.rng() * buildings.length)];
    if (!b) continue;
    b.condition = clamp(b.condition - (0.08 + ctx.rng() * 0.16), 0, 1);
    damaged++;
  }
  // carried-off goods
  const resources = Object.keys(cap.stock).filter((r) => (cap.stock[r] ?? 0) > 6);
  let looted = 0;
  const take = Math.min(3, resources.length);
  for (let i = 0; i < take; i++) {
    const res = resources[Math.floor(ctx.rng() * resources.length)];
    if (!res) continue;
    const want = (cap.stock[res] ?? 0) * 0.1;
    const taken = removeStock(cap, res, want);
    looted += taken;
  }
  cap.morale = clamp(cap.morale - 3.5, 0, 100);
  cap.stability = clamp(cap.stability - 2.5, 0, 100);
  civ.attitude = clamp(civ.attitude - 4, -100, 100);
  setFlag(s, 'combat.raidsSuffered', (s.flags['combat.raidsSuffered'] ?? 0) + 1);
  ctx.notify(
    `Raiders struck in the night. ${damaged > 0 ? `${damaged} buildings were damaged; ` : ''}${looted > 0 ? 'stores were carried off.' : 'they were driven off before they could take much.'}`,
    'bad',
    'sword',
  );
  ctx.chronicle(
    'The Raid',
    `Hounds woke the settlement before the torches came. Men of the ${civ.name} took what they could carry and burned the rest; we counted the losses by morning.`,
    'conflict',
    3,
  );
}

function capitalize(s: string): string {
  return s.length ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function civName(civ: NeighborCiv): string {
  const n = civ.name.trim();
  if (/^the\s/i.test(n)) return n.charAt(0).toUpperCase() + n.slice(1);
  return `the ${n}`;
}

function archetypeBaseline(archetype: NeighborArchetype): number {
  switch (archetype) {
    case 'agrarian':
      return 18;
    case 'mercantile':
      return 28;
    case 'martial':
      return -12;
    case 'scholarly':
      return 22;
    default:
      return 4;
  }
}
