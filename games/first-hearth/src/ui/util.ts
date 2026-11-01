/**
 * Shared UI utilities: escaping, formatting, HTML builders, data derivation and
 * the small service contract modules use to talk to the shell.
 */
import type { GameApp } from '../app';
import type {
  Building,
  BuildingDef,
  Citizen,
  Condition,
  Content,
  GameState,
  ModifierDelta,
  ModifierKey,
  ResourceId,
  Settlement,
  SettlementStats,
} from '../sim/types';
import { MODIFIER_META } from '../sim/types';
import { capitalOf, citizenById, settlementById, capitalOf as cap } from '../sim/core';
import { fmtNumber, fmtPercent, titleCase } from '../sim/core';
import { icon } from './icons';

// ---------------------------------------------------------------------------
// Shell service contract
// ---------------------------------------------------------------------------

export type PanelId =
  | 'codex'
  | 'society'
  | 'market'
  | 'people'
  | 'almanac'
  | 'diplomacy'
  | 'expeditions'
  | 'wonders'
  | 'objectives';

export type ExpeditionKind = 'scout' | 'survey' | 'settle';
export type SettingsTab = 'save' | 'settings' | 'help';

export interface Services {
  app: GameApp;
  openPanel(id: PanelId): void;
  closePanel(): void;
  activePanel(): PanelId | null;
  togglePanel(id: PanelId): void;
  openSettings(tab?: SettingsTab): void;
  openNewGame(): void;
  openNotifications(): void;
  focusBuild(category: string | null): void;
  startTour(force?: boolean): void;
  showFirstSteps(): void;
  setExpeditionTarget(kind: ExpeditionKind | null): void;
  getExpeditionTarget(): ExpeditionKind | null;
  openDecisionModal(): void;
  refreshSoon(): void;
  toast(text: string, severity?: 'info' | 'good' | 'warn' | 'bad', iconName?: string): void;
}

// ---------------------------------------------------------------------------
// Escaping & formatting
// ---------------------------------------------------------------------------

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function escAttr(value: unknown): string {
  return esc(value).replace(/`/g, '&#96;');
}

export const clamp = (v: number, min: number, max: number): number => (v < min ? min : v > max ? max : v);

/** Compact number for dense UI: 0.4, 12, 1.2k, 3.4M. */
export function fmt(n: number | undefined | null, digits = 1): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 10000) return fmtNumber(v);
  if (abs >= 100) return String(Math.round(v));
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 10 ** digits) / 10 ** digits);
}

export function fmtInt(n: number | undefined | null): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 10000) return fmtNumber(v);
  return String(Math.round(v));
}

/** Signed compact number with explicit +. */
export function signed(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '±0';
  const v = Math.round(n * 10 ** digits) / 10 ** digits;
  if (Math.abs(v) < 0.05) return '±0';
  return (v > 0 ? '+' : '') + fmt(v, digits);
}

/** 0..1 → "43%" */
export function pct(v: number, digits = 0): string {
  if (!Number.isFinite(v)) return '—';
  return fmtPercent(clamp(v, 0, 1), digits);
}

/** 0..100 → "43%" */
export function pct100(v: number, digits = 0): string {
  return pct((Number.isFinite(v) ? v : 0) / 100, digits);
}

export function toneClass(value: number, goodWhenPositive = true): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return 'is-neutral';
  const good = goodWhenPositive ? value > 0 : value < 0;
  return good ? 'is-good' : 'is-bad';
}

/** Value tone where "low is bad" for 0..100 scales. */
export function scoreTone(value: number, warnBelow = 45, badBelow = 25): string {
  if (value <= badBelow) return 'is-bad';
  if (value <= warnBelow) return 'is-warn';
  return 'is-good';
}

export function roman(n: number): string {
  const table: [number, string][] = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let v = Math.max(0, Math.round(n));
  let out = '';
  for (const [value, sym] of table) {
    while (v >= value) {
      out += sym;
      v -= value;
    }
  }
  return out || '0';
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function pretty(s: string | null | undefined): string {
  return titleCase(String(s ?? '').replace(/\s+/g, '_'));
}

export function truncate(s: string, max: number): string {
  const str = String(s ?? '');
  return str.length > max ? str.slice(0, Math.max(0, max - 1)) + '…' : str;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let handle = 0;
  return ((...args: never[]) => {
    window.clearTimeout(handle);
    handle = window.setTimeout(() => fn(...args), ms);
  }) as unknown as T;
}

// ---------------------------------------------------------------------------
// HTML builders
// ---------------------------------------------------------------------------

export function tip(html: string): string {
  return `data-tip-html="${escAttr(html)}"`;
}

export function tipText(text: string): string {
  return `data-tip="${escAttr(text)}"`;
}

export function iconHtml(name: string | undefined, className = 'fh-icon', size?: number): string {
  return icon(name, className, size);
}

export interface BarOpts {
  tone?: string;
  height?: number;
  showValue?: boolean;
  valueText?: string;
  title?: string;
  trackClass?: string;
  fillClass?: string;
}

/** A slim labelled meter. Values are clamped to the given max. */
export function meter(value: number, max = 1, opts: BarOpts = {}): string {
  const v = Number.isFinite(value) ? clamp(value, 0, max) : 0;
  const ratio = max > 0 ? v / max : 0;
  const width = Math.round(ratio * 1000) / 10;
  const tone = opts.tone ? ` ${opts.tone}` : '';
  const text = opts.valueText ?? (max === 1 ? pct(ratio) : fmt(v));
  const tipAttr = opts.title ? tipText(opts.title) : '';
  return `<div class="fh-meter${tone}${opts.trackClass ? ' ' + opts.trackClass : ''}"${tipAttr}>
    <div class="fh-meter-fill${opts.fillClass ? ' ' + opts.fillClass : ''}" style="width:${width}%"></div>
    ${opts.showValue ? `<span class="fh-meter-value">${esc(text)}</span>` : ''}
  </div>`;
}

export function gauge(label: string, value: number, opts: { max?: number; tone?: string; hint?: string; suffix?: string } = {}): string {
  const max = opts.max ?? 1;
  const ratio = max > 0 ? clamp(value / max, 0, 1) : 0;
  const tone = opts.tone ?? scoreTone(ratio * 100);
  const shown = opts.suffix ?? (max === 1 ? pct(ratio) : fmt(value));
  const tipAttr = opts.hint ? tipText(opts.hint) : '';
  return `<button type="button" class="fh-gauge clickable"${tipAttr} aria-label="${escAttr(`${label}: ${shown}`)}">
    <span class="fh-gauge-ring" style="--fh-gauge:${Math.round(ratio * 100)}%;" data-tone="${tone.replace('is-', '')}">
      <span class="fh-gauge-inner">${esc(shown)}</span>
    </span>
    <span class="fh-gauge-label">${esc(label)}</span>
  </button>`;
}

export function chip(label: string, opts: { icon?: string; tone?: string; tip?: string; className?: string } = {}): string {
  const tone = opts.tone ? ` ${opts.tone}` : '';
  const tipAttr = opts.tip ? tipText(opts.tip) : '';
  return `<span class="fh-chip${tone}${opts.className ? ' ' + opts.className : ''}"${tipAttr}>${opts.icon ? iconHtml(opts.icon, 'fh-icon is-small') : ''}<span class="fh-chip-label">${esc(label)}</span></span>`;
}

export function statRow(label: string, value: string, opts: { tone?: string; tip?: string; icon?: string } = {}): string {
  const tipAttr = opts.tip ? tipText(opts.tip) : '';
  return `<div class="fh-statrow"${tipAttr}>
    <span class="fh-statrow-label">${opts.icon ? iconHtml(opts.icon, 'fh-icon is-tiny') : ''}${esc(label)}</span>
    <span class="fh-statrow-value ${opts.tone ?? ''}">${value}</span>
  </div>`;
}

export function deltaText(value: number, per: string, digits = 1): string {
  if (!Number.isFinite(value) || Math.abs(value) < 0.05) return '';
  const arrow = value > 0.05 ? iconHtml('arrow_up', 'fh-icon is-tiny') : value < -0.05 ? iconHtml('arrow_down', 'fh-icon is-tiny') : '';
  return `<span class="fh-delta ${toneClass(value)}">${arrow}${esc(signed(value, digits))}<span class="fh-delta-per">/${per}</span></span>`;
}

export function emptyState(title: string, body: string, iconName = 'dot'): string {
  return `<div class="fh-empty">${iconHtml(iconName, 'fh-icon is-large')}<p class="fh-empty-title">${esc(title)}</p><p class="fh-empty-body">${esc(body)}</p></div>`;
}

export function sectionTitle(title: string, extra = '', hint?: string): string {
  return `<div class="fh-section-head"${hint ? tipText(hint) : ''}><h4>${esc(title)}</h4>${extra ? `<span class="fh-section-extra">${extra}</span>` : ''}</div>`;
}

// ---------------------------------------------------------------------------
// State derivation
// ---------------------------------------------------------------------------

export function stateOf(svc: Services): GameState {
  return svc.app.state;
}

export function contentOf(svc: Services): Content {
  return svc.app.content;
}

export function selectedSettlement(svc: Services): Settlement | null {
  const s = stateOf(svc);
  const id = svc.app.view.selectedSettlementId;
  return settlementById(s, id) ?? capitalOf(s);
}

export function settlementOrCapital(s: GameState): Settlement | null {
  return cap(s);
}

export function settlementName(svc: Services): string {
  return selectedSettlement(svc)?.name ?? 'No settlement';
}

export function buildingDefOf(svc: Services, b: Building | null): BuildingDef | null {
  if (!b) return null;
  return svc.app.content.buildings[b.typeId] ?? null;
}

export function citizenOf(svc: Services, id: number): Citizen | null {
  return citizenById(svc.app.state, id);
}

export function livingCitizensOf(s: GameState, settlementId?: number): Citizen[] {
  const out: Citizen[] = [];
  for (const c of s.citizens) {
    if (!c.alive) continue;
    if (settlementId !== undefined && c.settlementId !== settlementId) continue;
    out.push(c);
  }
  return out;
}

/** Total stock of a resource across settlements. */
export function totalStock(s: GameState, res: ResourceId): number {
  let n = 0;
  for (const st of s.settlements) n += st.stock[res] ?? 0;
  return n;
}

export function jobsTotal(def: BuildingDef | null): number {
  if (!def) return 0;
  let n = 0;
  for (const j of def.jobs) n += j.count;
  return n;
}

export function foodStockUnits(s: GameState, c: Content, st: Settlement | null): number {
  if (!st) return 0;
  let n = 0;
  for (const res in st.stock) {
    const def = c.resources[res];
    if (def?.edible) n += (st.stock[res] ?? 0) * def.edible;
  }
  return n;
}

export function citizenClassOf(c: Content, citizen: Citizen): string {
  const prof = citizen.profession;
  const meta = c.professions[prof as string];
  if (meta?.class) return meta.class;
  if (prof === 'child') return 'child';
  return 'laborer';
}

export function professionLabel(c: Content, profession: string): string {
  const meta = c.professions[profession];
  if (meta?.name) return meta.name;
  if (profession === 'child') return 'Child';
  if (profession === 'student') return 'Student';
  if (profession === 'idle') return 'Idle';
  return titleCase(profession);
}

export function professionIcon(c: Content, profession: string): string {
  return c.professions[profession]?.icon ?? (profession === 'child' ? 'seed' : profession === 'idle' ? 'hourglass' : 'person');
}

export function classTone(cls: string): string {
  switch (cls) {
    case 'scholar':
      return 'is-info';
    case 'artisan':
      return 'is-brass';
    case 'merchant':
      return 'is-good';
    default:
      return 'is-neutral';
  }
}

export function skillLabel(c: Content, id: string): string {
  return c.skills[id]?.name ?? titleCase(id);
}

/** Modifier keys whose values are flat amounts, not fractions. */
const FLAT_MODIFIERS = new Set<string>(['insightFlat', 'moraleFlat']);

export function modValueText(key: ModifierKey, value: number): string {
  if (FLAT_MODIFIERS.has(key)) {
    const unit = key === 'insightFlat' ? ' day' : '';
    return `${signed(value, 2)}${unit}`;
  }
  return `${signed(value * 100, 0)}%`;
}

/** Human-readable modifier effect lines. */
export function modLines(mods: ModifierDelta | undefined, limit = 8): { key: ModifierKey; label: string; value: number; good: boolean; text: string }[] {
  if (!mods) return [];
  const out: { key: ModifierKey; label: string; value: number; good: boolean; text: string }[] = [];
  for (const rawKey of Object.keys(mods) as ModifierKey[]) {
    const value = mods[rawKey];
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) < 0.0005) continue;
    const meta = MODIFIER_META[rawKey];
    const good = value * (meta?.good ?? 1) > 0;
    out.push({ key: rawKey, label: meta?.label ?? titleCase(rawKey), value, good, text: `${meta?.label ?? rawKey} ${modValueText(rawKey, value)}` });
  }
  out.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
  return out.slice(0, limit);
}

export function modChips(mods: ModifierDelta | undefined, limit = 6): string {
  const lines = modLines(mods, limit);
  if (!lines.length) return '<span class="fh-faint fh-small">No passive modifiers</span>';
  return lines
    .map(
      (l) =>
        `<span class="fh-modchip ${l.good ? 'is-good' : 'is-bad'}" ${tipText(`${l.label}: ${modValueText(l.key, l.value)}`)}>${esc(l.label)} <b>${esc(modValueText(l.key, l.value))}</b></span>`,
    )
    .join('');
}

/** Render any structured condition as readable text with current value. */
export function conditionText(cond: Condition | null | undefined, c: Content, depth = 0): string {
  if (!cond) return '—';
  switch (cond.kind) {
    case 'metric':
      return `${titleCase(cond.metric.replace(/^capital\./, ''))} ${cond.op} ${fmt(cond.value)}`;
    case 'all':
      return cond.conditions.map((x) => conditionText(x, c, depth + 1)).join(' and ');
    case 'any':
      return cond.conditions.map((x) => conditionText(x, c, depth + 1)).join(' or ');
    case 'not':
      return `not (${conditionText(cond.condition, c, depth + 1)})`;
    case 'flag':
      return `flag “${cond.flag}” ${cond.op} ${String(cond.value)}`;
    case 'hasTech':
      return `discover ${c.techs[cond.tech]?.name ?? cond.tech}`;
    case 'hasPolicy':
      return `enact ${c.policies[cond.policy]?.name ?? cond.policy}`;
    case 'era':
      return `era ${cond.op} ${roman(cond.value + 1)}`;
    case 'random':
      return `${pct(cond.chance)} chance`;
    default:
      return '—';
  }
}

export function seasonIcon(season: string): string {
  return season === 'winter' ? 'snow' : season === 'spring' ? 'seed' : season === 'summer' ? 'sun' : 'leaf';
}

export function weatherIcon(weather: { rainfall: number; storm: number; snow: number }): string {
  if (weather.storm > 0.25) return 'storm';
  if (weather.snow > 0.2) return 'snow';
  if (weather.rainfall > 0.45) return 'rain';
  if (weather.rainfall > 0.12) return 'cloud';
  return 'sun';
}

export function buildingStatusTone(b: Building): string {
  if (b.progress < 1) return 'is-warn';
  if (!b.enabled) return 'is-neutral';
  if (!b.active) return 'is-warn';
  if (b.condition <= 0.05) return 'is-bad';
  if (b.efficiency < 0.35) return 'is-warn';
  return 'is-good';
}

export function buildingStatusText(b: Building): string {
  if (b.progress < 1) return `Under construction · ${pct(b.progress)}`;
  if (!b.enabled) return 'Disabled';
  if (!b.active) return 'Idle';
  if (b.condition <= 0.05) return 'Ruined';
  return b.status || 'Working';
}

/** Nearest current value from a metrics series. */
export function seriesTail(s: GameState, key: string, count = 60): number[] {
  const arr = s.metrics.series[key] ?? [];
  return arr.slice(Math.max(0, arr.length - count));
}

export function seriesLast(s: GameState, key: string): number {
  const arr = s.metrics.series[key];
  return arr && arr.length ? arr[arr.length - 1] : 0;
}

/** Slope of the last N samples of a tracked metric (per day). */
export function seriesSlope(s: GameState, key: string, days = 8): number {
  const arr = s.metrics.series[key] ?? [];
  if (arr.length < 2) return 0;
  const n = Math.min(days, arr.length - 1);
  return (arr[arr.length - 1] - arr[arr.length - 1 - n]) / n;
}

/** Format a resource amount + name for cost lists. */
export function costChips(c: Content, cost: Record<ResourceId, number> | undefined, stock?: Record<ResourceId, number>): string {
  if (!cost) return '';
  const entries = Object.entries(cost).filter(([, v]) => v > 0);
  if (!entries.length) return '<span class="fh-faint fh-small">Free</span>';
  return entries
    .map(([res, amount]) => {
      const def = c.resources[res];
      const have = stock?.[res] ?? 0;
      const missing = stock ? have + 1e-6 < amount : false;
      return `<span class="fh-cost ${missing ? 'is-missing' : ''}" ${tipText(`${def?.name ?? pretty(res)} — ${fmt(amount, 1)} each${stock ? ` · in store ${fmt(have, 1)}` : ''}`)}>${iconHtml(def?.icon ?? 'diamond', 'fh-icon is-tiny')}<b>${esc(fmt(amount, 1))}</b><span class="fh-cost-name">${esc(def?.name ?? pretty(res))}</span></span>`;
    })
    .join('');
}

export function titleOfContent(c: Content, id: string, kind: 'building' | 'tech' | 'resource' | 'policy' | 'doctrine' | 'neighbor'): string {
  switch (kind) {
    case 'building':
      return c.buildings[id]?.name ?? pretty(id);
    case 'tech':
      return c.techs[id]?.name ?? pretty(id);
    case 'resource':
      return c.resources[id]?.name ?? pretty(id);
    case 'policy':
      return c.policies[id]?.name ?? pretty(id);
    case 'doctrine':
      return c.doctrines[id]?.name ?? pretty(id);
    case 'neighbor':
      return pretty(id);
    default:
      return pretty(id);
  }
}

export interface DeltaTracker {
  /** Change per simulated day for an arbitrary key. */
  rate(key: string): number;
  sample(tick: number): void;
  clear(): void;
}

/** Rolling sampler so HUD chips can show net/day deltas (uses sim days, not wall clock). */
export function createDeltaTracker(read: () => Record<string, number>, maxSamples = 14): DeltaTracker {
  const history: { tick: number; values: Record<string, number> }[] = [];
  return {
    sample(tick: number): void {
      const last = history[history.length - 1];
      if (last && last.tick === tick) return;
      history.push({ tick, values: read() });
      if (history.length > maxSamples) history.shift();
    },
    rate(key: string): number {
      if (history.length < 2) return 0;
      const first = history[0];
      const last = history[history.length - 1];
      const days = last.tick - first.tick;
      const a = first.values[key] ?? 0;
      const b = last.values[key] ?? 0;
      if (days <= 0 || !Number.isFinite(days)) return 0;
      return (b - a) / days;
    },
    clear(): void {
      history.length = 0;
    },
  };
}

export function sortStockRows(st: Settlement | null, c: Content): { res: ResourceId; amount: number }[] {
  if (!st) return [];
  const rows: { res: ResourceId; amount: number }[] = [];
  for (const res in st.stock) {
    const amount = st.stock[res] ?? 0;
    if (amount <= 0.001) continue;
    rows.push({ res, amount });
  }
  rows.sort((a, b) => {
    const da = c.resources[a.res];
    const db = c.resources[b.res];
    return (da?.category ?? '').localeCompare(db?.category ?? '') || (db?.tier ?? 0) - (da?.tier ?? 0) || b.amount - a.amount;
  });
  return rows;
}

export function aggregateStats(st: Settlement | null): SettlementStats | null {
  return st?.stats ?? null;
}

export function needsOf(citizen: Citizen): { key: keyof Citizen['needs']; label: string; value: number }[] {
  const labels: Record<keyof Citizen['needs'], string> = {
    food: 'Food',
    water: 'Water',
    shelter: 'Shelter',
    warmth: 'Warmth',
    health: 'Health',
    social: 'Company',
    purpose: 'Purpose',
    comfort: 'Comfort',
  };
  return (Object.keys(labels) as (keyof Citizen['needs'])[]).map((key) => ({ key, label: labels[key], value: citizen.needs?.[key] ?? 0 }));
}
