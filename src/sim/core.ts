/**
 * Shared simulation helpers. Every system uses these so behaviour stays
 * consistent (storage limits, modifiers, tech checks, terrain access...).
 */
import type {
  Building,
  BuildingDef,
  ChronicleEntry,
  Citizen,
  Condition,
  Content,
  GameRules,
  GameState,
  ModifierDelta,
  ModifierKey,
  Notification,
  PolicyId,
  RecipeDef,
  ResourceDef,
  ResourceId,
  SeasonId,
  Settlement,
  SimContext,
  TechDef,
  TechId,
  Tile,
  WorldState,
} from './types';
import { DAYS_PER_SEASON, DAYS_PER_YEAR, SEASONS } from './types';
import { DIFFICULTIES } from './config';

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);
export const clamp01 = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const sum = (vals: number[]): number => vals.reduce((a, b) => a + b, 0);
export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round2 = (v: number): number => Math.round(v * 100) / 100;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

export function yearOf(tick: number): number {
  return Math.floor(tick / DAYS_PER_YEAR) + 1;
}

export function seasonIndexOf(tick: number): number {
  const dayOfYear = ((tick % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  return Math.floor(dayOfYear / DAYS_PER_SEASON);
}

export function seasonOf(tick: number): SeasonId {
  return SEASONS[seasonIndexOf(tick)];
}

export function dayOfSeason(tick: number): number {
  return (((tick % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR) % DAYS_PER_SEASON + 1;
}

export function dayOfYear(tick: number): number {
  return (((tick % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR) + 1;
}

export function dateLabel(tick: number): string {
  const s = seasonOf(tick);
  return `Year ${yearOf(tick)} · ${s[0].toUpperCase()}${s.slice(1)} ${dayOfSeason(tick)}`;
}

export function shortDate(tick: number): string {
  return `Y${yearOf(tick)} ${seasonOf(tick).slice(0, 3)}${dayOfSeason(tick)}`;
}

// ---------------------------------------------------------------------------
// World/tiles
// ---------------------------------------------------------------------------

export function tileIndex(w: WorldState, x: number, y: number): number {
  return y * w.width + x;
}

export function inBounds(w: WorldState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w.width && y < w.height;
}

export function tileAt(w: WorldState, x: number, y: number): Tile | null {
  if (!inBounds(w, x, y)) return null;
  return w.tiles[y * w.width + x] ?? null;
}

export function tileByIndex(w: WorldState, idx: number): Tile | null {
  if (idx < 0 || idx >= w.tiles.length) return null;
  return w.tiles[idx] ?? null;
}

export function xOf(w: WorldState, idx: number): number {
  return idx % w.width;
}

export function yOf(w: WorldState, idx: number): number {
  return Math.floor(idx / w.width);
}

export function distance(w: WorldState, x1: number, y1: number, x2: number, y2: number): number {
  const dx = x1 - x2;
  const dy = y1 - y2;
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceIdx(w: WorldState, a: number, b: number): number {
  return distance(w, xOf(w, a), yOf(w, a), xOf(w, b), yOf(w, b));
}

export function neighbors4(w: WorldState, idx: number): number[] {
  const x = idx % w.width;
  const y = (idx - x) / w.width;
  const out: number[] = [];
  if (x > 0) out.push(idx - 1);
  if (x < w.width - 1) out.push(idx + 1);
  if (y > 0) out.push(idx - w.width);
  if (y < w.height - 1) out.push(idx + w.width);
  return out;
}

export function neighbors8(w: WorldState, idx: number): number[] {
  const x = idx % w.width;
  const y = (idx - x) / w.width;
  const out: number[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx >= 0 && ny >= 0 && nx < w.width && ny < w.height) out.push(ny * w.width + nx);
    }
  }
  return out;
}

/** All tile indices within `radius` (Euclidean) of idx, excluding idx itself. */
export function tilesInRadius(w: WorldState, idx: number, radius: number): number[] {
  const out: number[] = [];
  const cx = idx % w.width;
  const cy = (idx - cx) / w.width;
  const r = Math.ceil(radius);
  const r2 = radius * radius;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (dx * dx + dy * dy > r2) continue;
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && ny >= 0 && nx < w.width && ny < w.height) out.push(ny * w.width + nx);
    }
  }
  return out;
}

export function forEachTileInRadius(w: WorldState, idx: number, radius: number, cb: (t: Tile, i: number) => void): void {
  for (const i of tilesInRadius(w, idx, radius)) {
    const t = w.tiles[i];
    if (t) cb(t, i);
  }
}

/** Cached radius indices; cache is transient and rebuilt on load. */
export function radiusIndices(s: GameState, idx: number, radius: number): number[] {
  const key = idx * 100 + Math.round(radius * 10);
  let arr = s.cache.radiusMap.get(key);
  if (!arr) {
    arr = tilesInRadius(s.world, idx, radius);
    s.cache.radiusMap.set(key, arr);
  }
  return arr;
}

/** True when a tile is walkable land suitable for claiming/settling. */
export function claimableTile(w: WorldState, c: Content, x: number, y: number, allowUnknown = false): boolean {
  if (!inBounds(w, x, y)) return false;
  const t = w.tiles[y * w.width + x];
  if (!t) return false;
  if (t.elev < 0.02) return false;
  const biome = c.biomes[t.biome];
  if (!biome) return false;
  if (biome.walkCost >= 20) return false;
  if (t.deposit?.kind === 'aquifer' && biome.tags?.includes('water')) return false;
  if (!allowUnknown && !w.explored[y * w.width + x] && w.explored[y * w.width + x] !== 1) {
    // exploration always permits claiming discovered land; unknown land is not claimable
    return false;
  }
  return true;
}

/** Nearest road or settlement centre distance for logistics access. */
export function roadAccessScore(w: WorldState, x: number, y: number, radius = 3): number {
  let best = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if (!inBounds(w, nx, ny)) continue;
      const t = w.tiles[ny * w.width + nx];
      if (!t) continue;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (t.road > 0 && dist <= radius) best = Math.max(best, 1 - dist / (radius + 1));
      if (t.buildingId >= 0) best = Math.max(best, 0.35 * (1 - dist / (radius + 1)));
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------

export function nextId(s: GameState, kind: keyof GameState['nextIds']): number {
  return s.nextIds[kind]++;
}

// ---------------------------------------------------------------------------
// Settlements
// ---------------------------------------------------------------------------

export function capitalOf(s: GameState): Settlement | null {
  for (const st of s.settlements) if (st.isCapital) return st;
  return s.settlements[0] ?? null;
}

export function settlementById(s: GameState, id: number): Settlement | null {
  return s.settlements.find((st) => st.id === id) ?? null;
}

export function settlementByName(s: GameState, name: string): Settlement | null {
  return s.settlements.find((st) => st.name === name) ?? null;
}

export function settlementTile(s: GameState, st: Settlement): Tile | null {
  return tileAt(s.world, st.x, st.y);
}

export function settlementsAlive(s: GameState): Settlement[] {
  return s.settlements.filter((st) => st.population > 0 || st.buildings.length > 0);
}

// ---------------------------------------------------------------------------
// Citizens
// ---------------------------------------------------------------------------

export function citizenById(s: GameState, id: number): Citizen | null {
  if (id < 0) return null;
  return s.citizens.find((c) => c.id === id) ?? null;
}

export function livingCitizens(s: GameState): Citizen[] {
  return s.citizens.filter((c) => c.alive);
}

export function citizensOf(s: GameState, settlementId: number, aliveOnly = true): Citizen[] {
  return s.citizens.filter((c) => c.settlementId === settlementId && (!aliveOnly || c.alive));
}

export function populationOf(s: GameState, settlementId: number): number {
  let n = 0;
  for (const c of s.citizens) if (c.alive && c.settlementId === settlementId) n++;
  for (const co of s.cohorts) if (co.settlementId === settlementId && co.count > 0) n += co.count;
  return n;
}

export function totalPopulation(s: GameState): number {
  let n = 0;
  for (const c of s.citizens) if (c.alive) n++;
  for (const co of s.cohorts) n += co.count;
  return n;
}

export function isWorkingAge(age: number): boolean {
  return age >= 12 && age <= 68;
}

export function professionClass(c: Content, profession: string): 'laborer' | 'artisan' | 'scholar' | 'merchant' {
  return c.professions[profession]?.class ?? 'laborer';
}

// ---------------------------------------------------------------------------
// Buildings
// ---------------------------------------------------------------------------

export function buildingDef(c: Content, b: Building | string): BuildingDef | undefined {
  const id = typeof b === 'string' ? b : b.typeId;
  return c.buildings[id];
}

export function buildingById(s: GameState, id: number): Building | null {
  if (id < 0) return null;
  return s.buildings.find((b) => b.id === id) ?? null;
}

export function buildingsOf(s: GameState, settlementId: number): Building[] {
  return s.buildings.filter((b) => b.settlementId === settlementId);
}

export function completeBuildingsOf(s: GameState, settlementId: number): Building[] {
  return s.buildings.filter((b) => b.settlementId === settlementId && b.progress >= 1);
}

export function isComplete(b: Building): boolean {
  return b.progress >= 1;
}

export function buildingAt(s: GameState, x: number, y: number): Building | null {
  const idx = y * s.world.width + x;
  const t = s.world.tiles[idx];
  if (!t || t.buildingId < 0) return null;
  return buildingById(s, t.buildingId);
}

export function recipeOf(c: Content, b: Building): RecipeDef | undefined {
  if (!b.recipeId) return undefined;
  return c.recipes[b.recipeId];
}

export function recipeForBuilding(c: Content, def: BuildingDef): RecipeDef | undefined {
  for (const id of def.recipes) {
    const r = c.recipes[id];
    if (r) return r;
  }
  return undefined;
}

export function isOperational(b: Building): boolean {
  return b.progress >= 1 && b.active && b.enabled && b.condition > 0.05;
}

// ---------------------------------------------------------------------------
// Stockpiles
// ---------------------------------------------------------------------------

export function stockOf(st: Settlement, res: ResourceId): number {
  return st.stock[res] ?? 0;
}

export function stockTotal(st: Settlement): number {
  let total = 0;
  for (const k in st.stock) total += st.stock[k] ?? 0;
  return total;
}

export function storageFootprint(st: Settlement): number {
  return Math.round(stockTotal(st) * 100) / 100;
}

export function addStock(st: Settlement, res: ResourceId, amount: number, cap = Infinity): number {
  if (amount <= 0) return 0;
  let added = amount;
  if (cap !== Infinity) {
    const current = stockOf(st, res);
    const room = Math.max(0, cap - current);
    added = Math.min(added, room);
  }
  if (added <= 0) return 0;
  st.stock[res] = stockOf(st, res) + added;
  return added;
}

export function removeStock(st: Settlement, res: ResourceId, amount: number): number {
  if (amount <= 0) return 0;
  const current = stockOf(st, res);
  const taken = Math.min(current, amount);
  const next = current - taken;
  if (next <= 1e-9) delete st.stock[res];
  else st.stock[res] = next;
  return taken;
}

export function setStock(st: Settlement, res: ResourceId, amount: number): void {
  if (amount <= 0) delete st.stock[res];
  else st.stock[res] = amount;
}

export function canAfford(st: Settlement, cost: Record<ResourceId, number>): boolean {
  for (const res in cost) {
    if (stockOf(st, res) + 1e-6 < cost[res]) return false;
  }
  return true;
}

export function missingCost(st: Settlement, cost: Record<ResourceId, number>): Record<ResourceId, number> {
  const missing: Record<ResourceId, number> = {};
  for (const res in cost) {
    const need = cost[res] - stockOf(st, res);
    if (need > 1e-6) missing[res] = need;
  }
  return missing;
}

export function payCost(st: Settlement, cost: Record<ResourceId, number>): boolean {
  if (!canAfford(st, cost)) return false;
  for (const res in cost) removeStock(st, res, cost[res]);
  return true;
}

export function refundCost(st: Settlement, cost: Record<ResourceId, number>, fraction = 1): void {
  for (const res in cost) addStock(st, res, cost[res] * fraction);
}

export function stockSnapshot(st: Settlement): Record<ResourceId, number> {
  const out: Record<ResourceId, number> = {};
  for (const k in st.stock) {
    const v = st.stock[k];
    if (v > 0.01) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

/** Days of food remaining, counting edible stock. */
export function foodDaysOf(s: GameState, c: Content, st: Settlement): number {
  let food = 0;
  for (const res in st.stock) {
    const def = c.resources[res];
    if (def?.edible) food += (st.stock[res] ?? 0) * def.edible;
  }
  const need = Math.max(0.001, st.population * (s.difficulty === 'harsh' ? 0.648 : 0.6));
  return food / need;
}

export function waterDaysOf(s: GameState, st: Settlement): number {
  const need = Math.max(0.001, st.population * 0.9);
  return (st.stock.water ?? 0) / need;
}

// ---------------------------------------------------------------------------
// Modifiers
// ---------------------------------------------------------------------------

export function addMod(target: ModifierDelta, key: ModifierKey, value: number): void {
  target[key] = (target[key] ?? 0) + value;
}

export function mergeMods(...sources: (ModifierDelta | undefined | null)[]): ModifierDelta {
  const out: ModifierDelta = {};
  for (const src of sources) {
    if (!src) continue;
    for (const key in src) {
      const k = key as ModifierKey;
      const v = src[k];
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] ?? 0) + v;
    }
  }
  return out;
}

export function collectGlobalModifiers(s: GameState, c: Content, _rules: GameRules): ModifierDelta {
  const out: ModifierDelta = {};

  // Technology
  for (const techId in s.research.completed) {
    const t: TechDef | undefined = c.techs[techId];
    if (t?.effects) mergeInto(out, t.effects);
  }
  // Doctrine identity
  if (s.research.doctrine) {
    const d = c.doctrines[s.research.doctrine];
    if (d?.effects) mergeInto(out, d.effects);
  }
  // Active policies
  for (const pid in s.society.policies) {
    if (!s.society.policies[pid]) continue;
    const p = c.policies[pid];
    if (p?.effects) mergeInto(out, p.effects);
  }
  // Temporary society modifiers (festivals, shortages, event choices)
  mergeInto(out, s.society.mods);
  // Difficulty
  const diff = DIFFICULTIES[s.difficulty]?.mods;
  if (diff) mergeInto(out, diff);
  return out;
}

export function mergeInto(target: ModifierDelta, src: ModifierDelta): void {
  for (const key in src) {
    const k = key as ModifierKey;
    const v = src[k];
    if (typeof v === 'number' && Number.isFinite(v)) target[k] = (target[k] ?? 0) + v;
  }
}

/** Sum of modifier for a given settlement / scope (-1 = global only). */
export function modOf(ctx: SimContext, settlementId: number, key: ModifierKey): number {
  return modOfState(ctx.s, settlementId, key, ctx.mods);
}

/**
 * Modifier lookup that works outside of a tick (UI, actions, tests).
 * `baseMods` may be supplied to avoid duplicated aggregation.
 */
export function modOfState(s: GameState, settlementId: number, key: ModifierKey, baseMods?: ModifierDelta): number {
  const global = baseMods ?? s.cache.globalMods ?? EMPTY_MODS;
  let total = global[key] ?? 0;
  if (settlementId >= 0) {
    const st = settlementById(s, settlementId);
    if (st?.mods) total += st.mods[key] ?? 0;
  }
  // Active event modifiers (global + settlement scoped)
  for (const ev of s.events.active) {
    if (ev.settlementId === -1 || ev.settlementId === settlementId) {
      total += ev.modifier[key] ?? 0;
    }
  }
  return Number.isFinite(total) ? total : 0;
}

export const EMPTY_MODS: ModifierDelta = {};

export function modsFor(ctx: SimContext, settlementId: number): ModifierDelta {
  const st = settlementId >= 0 ? settlementById(ctx.s, settlementId) : null;
  const out: ModifierDelta = {};
  mergeInto(out, ctx.mods);
  if (st?.mods) mergeInto(out, st.mods);
  for (const ev of ctx.s.events.active) {
    if (ev.settlementId === -1 || ev.settlementId === settlementId) mergeInto(out, ev.modifier);
  }
  return out;
}

/** Apply a modifier multiplicatively to a base value: base * (1 + mod). */
export function applyMod(base: number, mod: number, floor = 0): number {
  const v = base * (1 + mod);
  return v < floor ? floor : v;
}

// ---------------------------------------------------------------------------
// Research & society
// ---------------------------------------------------------------------------

export function hasTech(s: GameState, techId: TechId): boolean {
  return s.research.completed[techId] !== undefined;
}

export function eraOf(s: GameState): number {
  return s.research.era;
}

export function techAvailable(s: GameState, c: Content, techId: TechId): boolean {
  const t = c.techs[techId];
  if (!t || hasTech(s, techId)) return false;
  if (t.era > s.research.era) return false;
  for (const req of t.requires) if (!hasTech(s, req)) return false;
  if (t.excludes) {
    for (const ex of t.excludes) if (hasTech(s, ex)) return false;
  }
  return true;
}

export function techsAvailable(s: GameState, c: Content): TechDef[] {
  return c.techOrder.map((id) => c.techs[id]).filter((t): t is TechDef => !!t && techAvailable(s, c, t.id));
}

export function hasPolicy(s: GameState, policy: PolicyId): boolean {
  return !!s.society.policies[policy];
}

export function isPolicyUnlocked(s: GameState, c: Content, policy: PolicyId): boolean {
  const p = c.policies[policy];
  if (!p) return false;
  if (p.era > s.research.era) return false;
  for (const req of p.requiresTech) if (!hasTech(s, req)) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export function getFlag(s: GameState, key: string): number {
  return s.flags[key] ?? 0;
}

export function setFlag(s: GameState, key: string, value: number | boolean): void {
  s.flags[key] = typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

export function addFlag(s: GameState, key: string, delta: number): void {
  s.flags[key] = (s.flags[key] ?? 0) + delta;
}

// ---------------------------------------------------------------------------
// Content helpers
// ---------------------------------------------------------------------------

export function resourceDef(c: Content, id: ResourceId): ResourceDef | undefined {
  return c.resources[id];
}

export function isFood(c: Content, id: ResourceId): boolean {
  return !!c.resources[id]?.edible;
}

export function foodUnits(c: Content, st: Settlement): number {
  let total = 0;
  for (const res in st.stock) {
    const d = c.resources[res];
    if (d?.edible) total += (st.stock[res] ?? 0) * d.edible;
  }
  return total;
}

export function emptyStock(): Record<ResourceId, number> {
  return {};
}

export function scaleCost(cost: Record<ResourceId, number>, factor: number): Record<ResourceId, number> {
  const out: Record<ResourceId, number> = {};
  for (const k in cost) out[k] = Math.max(0, Math.round(cost[k] * factor * 10) / 10);
  return out;
}

// ---------------------------------------------------------------------------
// History / notifications
// ---------------------------------------------------------------------------

export function addChronicle(
  s: GameState,
  title: string,
  body: string,
  kind: ChronicleEntry['kind'],
  importance: 1 | 2 | 3 = 2,
): ChronicleEntry {
  const entry: ChronicleEntry = {
    id: nextId(s, 'chronicle'),
    tick: s.tick,
    year: yearOf(s.tick),
    season: seasonOf(s.tick),
    title,
    body,
    kind,
    importance,
  };
  s.chronicle.push(entry);
  if (s.chronicle.length > 400) s.chronicle.splice(0, s.chronicle.length - 400);
  return entry;
}

export function pushNotification(
  s: GameState,
  text: string,
  severity: Notification['severity'] = 'info',
  icon = 'bell',
): Notification {
  const n: Notification = {
    id: nextId(s, 'notification'),
    tick: s.tick,
    text,
    severity,
    icon,
    read: false,
  };
  s.notifications.push(n);
  const cap = 180;
  if (s.notifications.length > cap) s.notifications.splice(0, s.notifications.length - cap);
  return n;
}

export function unreadNotifications(s: GameState): number {
  return s.notifications.filter((n) => !n.read).length;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (abs >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (abs >= 10_000) return (n / 1000).toFixed(1) + 'k';
  if (abs >= 100) return Math.round(n).toString();
  if (abs >= 10) return (Math.round(n * 10) / 10).toString();
  if (abs >= 1) return (Math.round(n * 10) / 10).toString();
  if (abs === 0) return '0';
  return n.toFixed(2);
}

export function fmtSigned(n: number): string {
  const v = Math.round(n * 10) / 10;
  return (v >= 0 ? '+' : '') + fmtNumber(v);
}

export function fmtPercent(n: number, digits = 0): string {
  return (n * 100).toFixed(digits) + '%';
}

export function titleCase(str: string): string {
  return str
    .split('_')
    .map((s) => (s ? s[0].toUpperCase() + s.slice(1) : s))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Condition evaluation (structured content conditions)
// ---------------------------------------------------------------------------

export interface MetricProvider {
  (s: GameState, c: Content, metric: string): number;
}

export function evalCondition(
  cond: Condition,
  s: GameState,
  c: Content,
  getMetric: MetricProvider,
  rng: () => number,
): boolean {
  switch (cond.kind) {
    case 'metric': {
      const v = getMetric(s, c, cond.metric);
      switch (cond.op) {
        case '>':
          return v > cond.value;
        case '<':
          return v < cond.value;
        case '>=':
          return v >= cond.value;
        case '<=':
          return v <= cond.value;
        case '==':
          return Math.abs(v - cond.value) < 1e-6;
        case '!=':
          return Math.abs(v - cond.value) >= 1e-6;
      }
      return false;
    }
    case 'all':
      return cond.conditions.every((x) => evalCondition(x, s, c, getMetric, rng));
    case 'any':
      return cond.conditions.some((x) => evalCondition(x, s, c, getMetric, rng));
    case 'not':
      return !evalCondition(cond.condition, s, c, getMetric, rng);
    case 'flag': {
      const raw = s.flags[cond.flag];
      if (typeof cond.value === 'string' || typeof cond.value === 'boolean') {
        const asNum = typeof cond.value === 'boolean' ? (cond.value ? 1 : 0) : NaN;
        const target = typeof cond.value === 'boolean' ? asNum : cond.value;
        if (typeof target === 'number') {
          const v = raw ?? 0;
          return cond.op === '==' ? v === target : cond.op === '!=' ? v !== target : cond.op === '>' ? v > target : v < target;
        }
        return false;
      }
      const v = raw ?? 0;
      switch (cond.op) {
        case '==':
          return Math.abs(v - cond.value) < 1e-6;
        case '!=':
          return Math.abs(v - cond.value) >= 1e-6;
        case '>':
          return v > cond.value;
        case '<':
          return v < cond.value;
      }
      return false;
    }
    case 'hasTech':
      return hasTech(s, cond.tech);
    case 'hasPolicy':
      return hasPolicy(s, cond.policy);
    case 'era':
      return cond.op === '>=' ? s.research.era >= cond.value : cond.op === '<=' ? s.research.era <= cond.value : s.research.era === cond.value;
    case 'random':
      return rng() < cond.chance;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Serialisation-safe deep clone (structured state only)
// ---------------------------------------------------------------------------

export function deepClone<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      /* fall through */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}
