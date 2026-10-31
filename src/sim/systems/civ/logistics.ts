/**
 * civ.logistics — Storage, spoilage, road connectivity, caravans.
 *
 * Responsibilities:
 *   - recompute settlement storage overflow (storageCap comes from buildings.ts),
 *   - spoil perishable food (governed by the `spoilageRate` modifier and season),
 *   - maintain inter-settlement connectivity (`settlement.connectivity`, days by road),
 *   - move all caravans one step per day and resolve arrivals,
 *   - auto-distribute resources between settlements when one is short,
 *   - mirror caravans into `world.markers` for the renderer.
 *
 * Caravan kinds:
 *   - 'player'   : internal transfer. Cargo was loaded at the origin; delivered on arrival.
 *   - 'neighbor' : owned by economy.ts trade routes. Deliveries/collections are resolved
 *                  here so that physical travel and treasury stay in sync.
 *
 * Determinism: no Math.random / Date.now.
 */
import type {
  Caravan,
  Content,
  GameState,
  ResourceId,
  Settlement,
  SimContext,
  SimSystem,
  Stockpile,
  Tile,
} from '../../types';
import {
  addStock,
  clamp,
  clamp01,
  foodDaysOf,
  modOf,
  nextId,
  removeStock,
  round1,
  round2,
  stockOf,
  stockTotal,
} from '../../core';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

export const LOGISTICS_TUNING = {
  /** Base caravan speed in tiles per day (roads raise this via `roadSpeed`). */
  caravanSpeed: 2.4,
  /** Fraction of remaining stock lost per day for a fully perishable good. */
  spoilageBase: 0.035,
  spoilageSummer: 1.3,
  spoilageWinter: 0.55,
  spoilageSpring: 1.0,
  spoilageAutumn: 0.9,
  /** Notification pacing for spoilage. */
  spoilageNotifyInterval: 18,
  spoilageNotifyAmount: 2,
  /** How many days between refreshing one settlement's connectivity row. */
  connectivityRefreshDays: 5,
  /** Base cargo units a caravan can carry. */
  caravanCapacity: 40,
  /** Extra capacity per caravan-post style building. */
  caravanPostCapacity: 30,
  /** Minimum days between auto-distribution dispatches per settlement. */
  transferCooldownDays: 4,
  maxPlayerCaravans: 12,
  maxCaravans: 48,
  /** Donor must hold this many days of food beyond its own reserve. */
  donorFoodBufferDays: 6,
  /** Materials auto-transfer only when the recipient has none and donor has plenty. */
  materialDonorSurplus: 30,
  materialTransferAmount: 12,
} as const;

const EPS = 1e-6;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const logisticsSystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;

  for (const st of s.settlements) {
    applySpoilage(ctx, st);
    enforceStorageCap(ctx, st);
  }

  updateConnectivity(ctx);
  moveCaravans(ctx);
  distributeBetweenSettlements(ctx);

  for (const st of s.settlements) st.storageUsed = round2(stockTotal(st));
  syncCaravanMarkers(ctx);
};

// ---------------------------------------------------------------------------
// Spoilage
// ---------------------------------------------------------------------------

function spoilageRateFor(ctx: SimContext, resId: ResourceId): number {
  const def = ctx.c.resources[resId];
  if (!def) return 0;
  const tags = def.tags ?? [];
  let base = 0;
  if (def.perishable) base = LOGISTICS_TUNING.spoilageBase;
  else if (def.edible && def.category === 'luxury') base = 0.012;
  else if (def.edible && def.id === 'preserved_food') base = 0.002;
  else if (def.edible && (tags.includes('protein') || tags.includes('forage'))) base = 0.028;
  else if (def.perishable === undefined && (tags.includes('protein') || tags.includes('wild'))) base = 0.028;
  else return 0;

  const mod = clamp(modOf(ctx, -1, 'spoilageRate'), -0.9, 2);
  const season = ctx.s.world.weather.season;
  const seasonal =
    season === 'summer'
      ? LOGISTICS_TUNING.spoilageSummer
      : season === 'winter'
        ? LOGISTICS_TUNING.spoilageWinter
        : season === 'spring'
          ? LOGISTICS_TUNING.spoilageSpring
          : LOGISTICS_TUNING.spoilageAutumn;
  return clamp(base * (1 + mod) * seasonal, 0, 0.5);
}

function applySpoilage(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  let lostFood = 0;
  let lostValue = 0;
  for (const resId in st.stock) {
    const amount = st.stock[resId] ?? 0;
    if (amount <= 0.5) continue;
    const rate = spoilageRateFor(ctx, resId);
    if (rate <= 0) continue;
    const lost = amount * rate;
    if (lost < 0.01) continue;
    removeStock(st, resId, lost);
    const def = ctx.c.resources[resId];
    if (def?.edible) lostFood += lost * def.edible;
    lostValue += lost;
  }
  if (lostValue >= LOGISTICS_TUNING.spoilageNotifyAmount) {
    const flag = `spoilage_notify_${st.id}`;
    if (ctx.tick - (s.flags[flag] ?? -999) > LOGISTICS_TUNING.spoilageNotifyInterval) {
      s.flags[flag] = ctx.tick;
      ctx.notify(
        `${round1(lostValue)} units spoiled in ${st.name}'s stores.${lostFood > 0 ? ' Build a granary or preserve food.' : ''}`,
        'warn',
        'storehouse',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Storage cap overflow
// ---------------------------------------------------------------------------

function enforceStorageCap(ctx: SimContext, st: Settlement): void {
  const used = stockTotal(st);
  const cap = Math.max(0, st.storageCap);
  if (used <= cap + EPS) return;
  // Overflow is a slow bleed, not a cliff: at most ~12% of the excess per day,
  // so a settlement is never stripped bare the morning after its granary burns.
  const totalExcess = used - cap;
  let excess = Math.min(totalExcess, Math.max(0.25, totalExcess * 0.12));
  // First pass: loss falls on non-food piles (largest first); then food
  // proportionally. Storage overflow should sting, never starve the town.
  const entries = Object.keys(st.stock)
    .map((id) => ({ id, amount: st.stock[id] ?? 0, edible: !!ctx.c.resources[id]?.edible }))
    .filter((e) => e.amount > 0)
    .sort((a, b) => Number(a.edible) - Number(b.edible) || b.amount - a.amount);
  for (const entry of entries) {
    if (excess <= EPS) break;
    if (entry.edible) continue;
    const take = Math.min(entry.amount, excess);
    removeStock(st, entry.id, take);
    excess -= take;
  }
  if (excess > EPS) {
    const edibleTotal = entries.filter((e) => e.edible).reduce((n, e) => n + e.amount, 0);
    if (edibleTotal > 0) {
      for (const entry of entries) {
        if (excess <= EPS) break;
        if (!entry.edible) continue;
        const take = Math.min(entry.amount, (excess * entry.amount) / edibleTotal);
        if (take > 0) {
          removeStock(st, entry.id, take);
          excess -= take;
        }
      }
    }
  }
  const flag = `overflow_notify_${st.id}`;
  if (ctx.tick - (ctx.s.flags[flag] ?? -999) > 30) {
    ctx.s.flags[flag] = ctx.tick;
    ctx.notify(`${st.name} has no space left in storage; goods are being lost.`, 'warn', 'storehouse');
  }
}

// ---------------------------------------------------------------------------
// Road network / connectivity
// ---------------------------------------------------------------------------

/** Movement cost of entering a tile, in "tile-equivalents" (Infinity = blocked). */
function stepCost(c: Content, t: Tile | undefined): number {
  if (!t) return Infinity;
  const biome = c.biomes[t.biome];
  if (!biome || biome.walkCost >= 20) return Infinity;
  let cost = 0.6 + biome.walkCost * 0.55;
  if (t.road > 0) cost *= 1 - 0.6 * clamp01(t.road);
  if (t.pollution > 0.6) cost *= 1.08;
  return cost;
}

// --- scratch buffers reused by Dijkstra (single-threaded, transient only) ---
let scratchSize = 0;
let pfDist = new Float32Array(0);
let pfPrev = new Int32Array(0);
let pfDone = new Uint8Array(0);

function ensureScratch(size: number): void {
  if (scratchSize >= size) return;
  scratchSize = size;
  pfDist = new Float32Array(size);
  pfPrev = new Int32Array(size);
  pfDone = new Uint8Array(size);
}

/** Tiny binary min-heap of (cost, value) pairs. */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];

  get size(): number {
    return this.keys.length;
  }

  push(key: number, val: number): void {
    this.keys.push(key);
    this.vals.push(val);
    let i = this.keys.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= this.keys[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop(): number {
    const top = this.vals[0] ?? -1;
    const lastKey = this.keys.pop();
    const lastVal = this.vals.pop();
    if (this.keys.length > 0 && lastKey !== undefined && lastVal !== undefined) {
      this.keys[0] = lastKey;
      this.vals[0] = lastVal;
      let i = 0;
      const n = this.keys.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;
        if (l < n && this.keys[l] < this.keys[smallest]) smallest = l;
        if (r < n && this.keys[r] < this.keys[smallest]) smallest = r;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const k = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = k;
    const v = this.vals[a];
    this.vals[a] = this.vals[b];
    this.vals[b] = v;
  }
}

/**
 * Dijkstra over walkable tiles. When `targetIdx >= 0` the search stops on arrival
 * and returns the reconstructed tile-index path; with `targetIdx < 0` it explores
 * the whole reachable area and returns null (pfDist still holds the result).
 */
function runDijkstra(s: GameState, c: Content, startIdx: number, targetIdx: number): number[] | null {
  const w = s.world;
  const n = w.tiles.length;
  ensureScratch(n);
  pfDist.fill(Infinity);
  pfPrev.fill(-1);
  pfDone.fill(0);
  if (startIdx < 0 || startIdx >= n) return null;

  const heap = new MinHeap();
  pfDist[startIdx] = 0;
  heap.push(0, startIdx);
  const width = w.width;

  while (heap.size > 0) {
    const idx = heap.pop();
    if (idx < 0 || pfDone[idx]) continue;
    pfDone[idx] = 1;
    if (idx === targetIdx) break;
    const d = pfDist[idx];
    const x = idx % width;
    const y = (idx - x) / width;

    // 4-neighbourhood
    if (x > 0) relax(idx, idx - 1, d);
    if (x < width - 1) relax(idx, idx + 1, d);
    if (y > 0) relax(idx, idx - width, d);
    if (y < w.height - 1) relax(idx, idx + width, d);
  }

  function relax(from: number, to: number, base: number): void {
    if (pfDone[to]) return;
    const cost = stepCost(c, w.tiles[to]);
    if (!Number.isFinite(cost)) return;
    const next = base + cost;
    if (next < pfDist[to]) {
      pfDist[to] = next;
      pfPrev[to] = from;
      heap.push(next, to);
    }
  }

  if (targetIdx < 0) return null;
  if (!Number.isFinite(pfDist[targetIdx])) return null;
  const path: number[] = [];
  let cur = targetIdx;
  let guard = 0;
  while (cur >= 0 && cur !== startIdx && guard++ < n + 4) {
    path.push(cur);
    cur = pfPrev[cur];
  }
  if (cur !== startIdx) return null;
  path.push(startIdx);
  path.reverse();
  return path;
}

function settlementTileIndex(s: GameState, st: Settlement): number {
  return st.y * s.world.width + st.x;
}

/**
 * Refresh one settlement's connectivity row per invocation (rotating), so that
 * map-wide pathfinding never runs for every settlement in the same tick.
 */
function updateConnectivity(ctx: SimContext): void {
  const s = ctx.s;
  const list = s.settlements.filter((st) => st.buildings.length > 0 || st.population > 0);
  if (list.length < 2) return;
  const refresh = LOGISTICS_TUNING.connectivityRefreshDays;
  for (let attempt = 0; attempt < list.length; attempt++) {
    const row = (ctx.tick + attempt) % list.length;
    const from = list[row];
    const missing = list.some((other) => other.id !== from.id && from.connectivity[other.id] === undefined);
    if (!missing && (ctx.tick + row) % refresh !== 0) continue;
    recomputeConnectivityRow(ctx, from, list);
    if (!missing) break;
  }
}

function recomputeConnectivityRow(ctx: SimContext, from: Settlement, list: Settlement[]): void {
  const s = ctx.s;
  from.connectivity[from.id] = 0;
  if (list.length < 2) return;
  const startIdx = settlementTileIndex(s, from);
  runDijkstra(s, ctx.c, startIdx, -1);
  const speed = Math.max(0.4, LOGISTICS_TUNING.caravanSpeed * (1 + modOf(ctx, from.id, 'roadSpeed')));
  for (const other of list) {
    if (other.id === from.id) continue;
    const dist = pfDist[settlementTileIndex(s, other)];
    const days = Number.isFinite(dist) ? Math.max(1, Math.round((dist / speed) * 10) / 10) : 0;
    from.connectivity[other.id] = days;
    other.connectivity[from.id] = days;
  }
}

// ---------------------------------------------------------------------------
// Caravans — creation helpers (also used by economy.ts)
// ---------------------------------------------------------------------------

export interface CaravanOptions {
  kind?: 'player' | 'neighbor';
  routeId?: number;
  label?: string;
  color?: string;
}

/** Cargo units a settlement's caravans can carry (transport mods + caravan posts). */
export function caravanCapacity(ctx: SimContext, st: Settlement): number {
  let capacity = LOGISTICS_TUNING.caravanCapacity * (1 + modOf(ctx, st.id, 'transportCapacity'));
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== st.id || b.progress < 1) continue;
    const def = ctx.c.buildings[b.typeId];
    if (!def) continue;
    const tags = def.tags ?? [];
    if (tags.includes('caravan') || tags.includes('transport') || b.typeId.includes('caravan')) {
      capacity += LOGISTICS_TUNING.caravanPostCapacity * (0.3 + 0.7 * b.condition);
    }
  }
  return Math.max(4, Math.round(capacity));
}

/** Path of points between two settlements, or null when no land route exists. */
export function pathBetween(ctx: SimContext, from: { x: number; y: number }, to: { x: number; y: number }): { x: number; y: number }[] | null {
  const s = ctx.s;
  const w = s.world;
  const start = nearestWalkableIndex(ctx, from.x, from.y);
  const target = nearestWalkableIndex(ctx, to.x, to.y);
  if (start < 0 || target < 0) return null;
  const path = runDijkstra(s, ctx.c, start, target);
  if (!path) return null;
  return path.map((idx) => ({ x: idx % w.width, y: Math.floor(idx / w.width) }));
}

function nearestWalkableIndex(ctx: SimContext, x: number, y: number): number {
  const s = ctx.s;
  const w = s.world;
  const idx = y * w.width + x;
  if (Number.isFinite(stepCost(ctx.c, w.tiles[idx]))) return idx;
  for (let r = 1; r <= 3; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w.width || ny >= w.height) continue;
        const i = ny * w.width + nx;
        if (Number.isFinite(stepCost(ctx.c, w.tiles[i]))) return i;
      }
    }
  }
  return -1;
}

/** Create a caravan travelling from an arbitrary point (e.g. a neighbour capital). */
export function createCaravanFromPoint(
  ctx: SimContext,
  fromX: number,
  fromY: number,
  tx: number,
  ty: number,
  cargo: Stockpile,
  opts: CaravanOptions = {},
): Caravan | null {
  const s = ctx.s;
  if (s.market.caravans.length >= LOGISTICS_TUNING.maxCaravans) return null;
  const path = pathBetween(ctx, { x: fromX, y: fromY }, { x: tx, y: ty });
  if (!path || path.length === 0) return null;
  const cv: Caravan = {
    id: nextId(s, 'caravan'),
    routeId: opts.routeId ?? -1,
    kind: opts.kind ?? 'player',
    x: path[0].x,
    y: path[0].y,
    tx,
    ty,
    path,
    progress: 0,
    cargo: sanitizeCargo(cargo),
    label: opts.label ?? 'Caravan',
    color: opts.color ?? '#d9a84e',
  };
  s.market.caravans.push(cv);
  return cv;
}

/** Create a caravan travelling from a settlement to an arbitrary tile. */
export function createCaravanToTile(
  ctx: SimContext,
  from: Settlement,
  tx: number,
  ty: number,
  cargo: Stockpile,
  opts: CaravanOptions = {},
): Caravan | null {
  return createCaravanFromPoint(ctx, from.x, from.y, tx, ty, cargo, opts);
}

/** Create a caravan travelling between two settlements. */
export function createCaravanBetween(
  ctx: SimContext,
  from: Settlement,
  to: Settlement,
  cargo: Stockpile,
  kind: 'player' | 'neighbor' = 'player',
  label = 'Caravan',
  routeId = -1,
): Caravan | null {
  const cv = createCaravanToTile(ctx, from, to.x, to.y, cargo, { kind, label, routeId, color: kind === 'player' ? '#d9a84e' : '#7fc4a0' });
  return cv;
}

function sanitizeCargo(cargo: Stockpile): Stockpile {
  const out: Stockpile = {};
  for (const res in cargo) {
    const v = cargo[res];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[res] = round2(v);
  }
  return out;
}

export function cargoTotal(cargo: Stockpile): number {
  let total = 0;
  for (const res in cargo) total += cargo[res] ?? 0;
  return total;
}

// ---------------------------------------------------------------------------
// Caravan movement & arrival
// ---------------------------------------------------------------------------

function moveCaravans(ctx: SimContext): void {
  const s = ctx.s;
  const caravans = s.market.caravans;
  if (caravans.length === 0) return;
  const remaining: Caravan[] = [];
  for (const cv of caravans) {
    if (!cv.path || cv.path.length === 0) continue;
    const speed = Math.max(0.35, LOGISTICS_TUNING.caravanSpeed * (1 + modOf(ctx, settlementIdAt(ctx, cv), 'roadSpeed')));
    const segments = Math.max(1, cv.path.length - 1);
    cv.progress = Math.min(1, cv.progress + speed / segments);

    const floatIdx = cv.progress * segments;
    const i0 = Math.min(segments, Math.floor(floatIdx));
    const i1 = Math.min(segments, i0 + 1);
    const t = clamp01(floatIdx - i0);
    const a = cv.path[i0];
    const b = cv.path[i1];
    if (a && b) {
      cv.x = a.x + (b.x - a.x) * t;
      cv.y = a.y + (b.y - a.y) * t;
    }
    cv.tx = cv.path[cv.path.length - 1]?.x ?? cv.tx;
    cv.ty = cv.path[cv.path.length - 1]?.y ?? cv.ty;

    if (cv.progress >= 1 - EPS) {
      const turnedAround = resolveArrival(ctx, cv);
      if (turnedAround) remaining.push(turnedAround);
    } else {
      remaining.push(cv);
    }
  }
  s.market.caravans = remaining;
}

function settlementIdAt(ctx: SimContext, cv: Caravan): number {
  // Best effort: used only for road-speed modifiers, so nearest settlement is fine.
  let best = -1;
  let bestDist = Infinity;
  for (const st of ctx.s.settlements) {
    const d = Math.hypot(st.x - cv.x, st.y - cv.y);
    if (d < bestDist) {
      bestDist = d;
      best = st.id;
    }
  }
  return best;
}

/** Resolve a caravan that reached the end of its path. Returns a turned-around
 * caravan that must stay on the road (export leg 1), or null when finished. */
function resolveArrival(ctx: SimContext, cv: Caravan): Caravan | null {
  const s = ctx.s;
  if (cv.kind === 'player') {
    const dest = settlementNearest(ctx, cv.tx, cv.ty);
    if (!dest) return null;
    const wasted = deliverCargo(ctx, dest, cv.cargo);
    if (wasted >= 1) {
      ctx.notify(`A caravan reached ${dest.name} but found no storage space for ${round1(wasted)} units.`, 'warn', 'caravan');
    }
    return null;
  }

  // Neighbour trade routes are created by economy.ts; resolve their two legs here.
  const route = s.market.routes.find((r) => r.id === cv.routeId);
  if (!route) return null;
  const st = s.settlements.find((x) => x.id === route.fromSettlement);
  if (!st) return null;
  const resDef = ctx.c.resources[route.resource];

  if (route.direction === 'import') {
    const wasted = deliverCargo(ctx, st, cv.cargo);
    if (wasted >= 1) {
      ctx.notify(`Imported ${resDef?.name ?? route.resource} partially wasted: ${st.name} storage is full.`, 'warn', 'caravan');
    }
    return null;
  }

  // Export: leg 1 arrives empty at the player's settlement -> load, turn around.
  if (cargoTotal(cv.cargo) < 0.01) {
    const capacity = caravanCapacity(ctx, st);
    const available = stockOf(st, route.resource);
    const wanted = Math.min(capacity, available, Math.max(0.5, route.amountPerDay * 2));
    if (wanted < 0.5) return null; // nothing to sell; caravan dissolves
    removeStock(st, route.resource, wanted);
    cv.cargo = { [route.resource]: round2(wanted) };
    cv.path = cv.path.slice().reverse();
    cv.progress = 0;
    cv.label = `Export — ${resDef?.name ?? route.resource}`;
    const first = cv.path[0];
    const last = cv.path[cv.path.length - 1];
    if (first) {
      cv.x = first.x;
      cv.y = first.y;
    }
    if (last) {
      cv.tx = last.x;
      cv.ty = last.y;
    }
    const price = ctx.s.market.prices[route.resource];
    if (price) price.supply += wanted;
    return cv;
  }

  // Export: leg 2 arrives at the neighbour -> goods sold.
  const unitPrice =
    (s.market.prices[route.resource]?.price ?? resDef?.basePrice ?? 1) * (1 - s.market.tariff) * (1 + modOf(ctx, st.id, 'tradeSellPrice'));
  const total = unitPrice * cargoTotal(cv.cargo);
  st.treasury += total;
  st.tradeBalance += total;
  s.market.tradeBalance += total;
  s.stats.caravansSent++;
  const flag = `export_notify_${st.id}`;
  if (ctx.tick - (s.flags[flag] ?? -999) > 25) {
    s.flags[flag] = ctx.tick;
    ctx.notify(`${resDef?.name ?? route.resource} sold to ${neighborName(ctx, route.toId)} for ${Math.round(total)} coin.`, 'good', 'coin');
  }
  return null;
}

function settlementNearest(ctx: SimContext, tx: number, ty: number): Settlement | null {
  let best: Settlement | null = null;
  let bestDist = Infinity;
  for (const st of ctx.s.settlements) {
    const d = Math.hypot(st.x - tx, st.y - ty);
    if (d < bestDist) {
      bestDist = d;
      best = st;
    }
  }
  return bestDist <= 6 ? best : null;
}

function neighborName(ctx: SimContext, id: number): string {
  return ctx.s.neighbors.civs.find((c) => c.id === id)?.name ?? 'a distant neighbour';
}

/** Deliver cargo into settlement stock, respecting storage; returns wasted units. */
function deliverCargo(ctx: SimContext, st: Settlement, cargo: Stockpile): number {
  let space = Math.max(0, st.storageCap - stockTotal(st));
  let wasted = 0;
  for (const res in cargo) {
    const amount = cargo[res] ?? 0;
    if (amount <= 0) continue;
    const allowed = Math.min(amount, space);
    const added = allowed > 0 ? addStock(st, res, allowed) : 0;
    space = Math.max(0, space - added);
    wasted += amount - added;
  }
  ctx.s.market.lastUpdateTick = ctx.tick;
  return wasted;
}

// ---------------------------------------------------------------------------
// Inter-settlement auto-distribution
// ---------------------------------------------------------------------------

interface TransferNeed {
  resource: ResourceId;
  amount: number;
  donor: Settlement;
}

/** Resource transfer planner: finds what a settlement lacks AND who can spare it. */
function findTransferNeed(ctx: SimContext, recipient: Settlement): TransferNeed | null {
  const s = ctx.s;
  const c = ctx.c;

  // --- food -----------------------------------------------------------
  const reserve = Math.max(1, recipient.governor.reserveFoodDays);
  const days = foodDaysOf(s, c, recipient);
  if (days < reserve) {
    const dailyNeed = Math.max(0.05, recipient.population * 0.6);
    const urgency = 1 + Math.max(0, Math.min(1.5, recipient.governor.importUrgency));
    let best: { resource: ResourceId; amount: number; donor: Settlement; score: number } | null = null;
    for (const resId in c.resources) {
      const def = c.resources[resId];
      if (!def?.edible) continue;
      if (stockOf(recipient, resId) > 2) continue;
      const amount = Math.min(120, ((reserve - days) * dailyNeed * urgency) / Math.max(0.2, def.edible));
      if (amount < 1) continue;
      const donor = pickDonor(ctx, recipient, resId, amount, true);
      if (!donor) continue;
      const score = def.edible * amount;
      if (!best || score > best.score) best = { resource: resId, amount, donor, score };
    }
    if (best) return { resource: best.resource, amount: best.amount, donor: best.donor };
  }

  // --- water ----------------------------------------------------------
  const waterId = 'water';
  if (c.resources[waterId] && stockOf(recipient, waterId) < Math.max(6, recipient.population * 1.5)) {
    const amount = Math.max(4, recipient.population * 2);
    const donor = pickDonor(ctx, recipient, waterId, amount, false);
    if (donor) return { resource: waterId, amount, donor };
  }

  // --- construction materials: only when a settlement has nothing at all ---
  for (const resId of ['wood', 'stone', 'clay', 'fiber']) {
    if (!c.resources[resId]) continue;
    if (stockOf(recipient, resId) > 1) continue;
    if (resId !== 'wood' && stockOf(recipient, 'wood') > 4) continue;
    const donor = pickDonor(ctx, recipient, resId, LOGISTICS_TUNING.materialTransferAmount, false);
    if (donor) return { resource: resId, amount: LOGISTICS_TUNING.materialTransferAmount, donor };
  }
  return null;
}

function distributeBetweenSettlements(ctx: SimContext): void {
  const s = ctx.s;
  if (s.settlements.length < 2) return;
  if (ctx.s.market.caravans.filter((c) => c.kind === 'player').length >= LOGISTICS_TUNING.maxPlayerCaravans) return;

  for (const recipient of s.settlements) {
    if (ctx.tick - (recipient.lastCaravanTick ?? -999) < LOGISTICS_TUNING.transferCooldownDays) continue;
    const need = findTransferNeed(ctx, recipient);
    if (!need) continue;
    const donor = need.donor;
    const capacity = caravanCapacity(ctx, donor);
    const amount = Math.min(need.amount, capacity, stockOf(donor, need.resource));
    if (amount < 1) continue;
    const days = donor.connectivity[recipient.id] ?? recipient.connectivity[donor.id] ?? 0;
    if (!(days > 0)) continue;
    removeStock(donor, need.resource, amount);
    const cv = createCaravanBetween(
      ctx,
      donor,
      recipient,
      { [need.resource]: round2(amount) },
      'player',
      `Caravan — ${ctx.c.resources[need.resource]?.name ?? need.resource}`,
    );
    if (!cv) {
      addStock(donor, need.resource, amount);
      continue;
    }
    recipient.lastCaravanTick = ctx.tick;
    donor.lastCaravanTick = ctx.tick;
    s.stats.caravansSent++;
    const flag = `transfer_notify_${recipient.id}`;
    if (ctx.tick - (s.flags[flag] ?? -999) > 30) {
      s.flags[flag] = ctx.tick;
      ctx.notify(
        `${donor.name} sends ${round1(amount)} ${ctx.c.resources[need.resource]?.name ?? need.resource} to ${recipient.name}.`,
        'info',
        'caravan',
      );
    }
  }
}

function pickDonor(
  ctx: SimContext,
  recipient: Settlement,
  resource: ResourceId,
  amount: number,
  food: boolean,
): Settlement | null {
  const s = ctx.s;
  const c = ctx.c;
  let best: Settlement | null = null;
  let bestSurplus = 0;
  for (const donor of s.settlements) {
    if (donor.id === recipient.id) continue;
    const have = stockOf(donor, resource);
    if (have < amount * 1.25) continue;
    if (food) {
      const donorDays = foodDaysOf(s, c, donor);
      const donorReserve = Math.max(2, donor.governor.reserveFoodDays) + LOGISTICS_TUNING.donorFoodBufferDays;
      if (donorDays < donorReserve) continue;
      const surplus = donorDays - donorReserve;
      if (surplus > bestSurplus) {
        bestSurplus = surplus;
        best = donor;
      }
    } else {
      if (have < LOGISTICS_TUNING.materialDonorSurplus && resource !== 'water') continue;
      if (resource === 'water' && have < Math.max(20, amount * 2)) continue;
      if (have - amount > bestSurplus) {
        bestSurplus = have - amount;
        best = donor;
      }
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Cosmetic markers
// ---------------------------------------------------------------------------

function syncCaravanMarkers(ctx: SimContext): void {
  const s = ctx.s;
  if (!s.world.markers) return;
  const kept = s.world.markers.filter((m) => m.kind !== 'caravan');
  for (const cv of s.market.caravans) {
    kept.push({
      id: 900000 + cv.id,
      kind: 'caravan',
      x: Math.round(cv.x * 100) / 100,
      y: Math.round(cv.y * 100) / 100,
      tx: cv.tx,
      ty: cv.ty,
      label: cv.label,
      color: cv.color,
    });
  }
  s.world.markers = kept;
}
