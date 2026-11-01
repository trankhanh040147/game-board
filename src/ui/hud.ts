/**
 * Top HUD: settlement identity, time/weather/era, vital statistics, the core
 * resource ribbon with net-per-day deltas, alerts, speed controls and the
 * overlay/menu controls. Everything is cached-node diffed on refresh().
 */
import type { OverlayMode, ResourceId } from '../sim/types';
import {
  capitalOf,
  dateLabel,
  seasonOf,
  unreadNotifications,
  totalPopulation,
} from '../sim/core';
import { SPEEDS } from '../sim/config';
import { icon } from './icons';
import {
  clamp,
  createDeltaTracker,
  deltaText,
  esc,
  escAttr,
  fmt,
  fmtInt,
  meter,
  pct,
  pct100,
  pretty,
  scoreTone,
  seasonIcon,
  selectedSettlement,
  signed,
  stateOf,
  tip,
  tipText,
  weatherIcon,
  type DeltaTracker,
  type Services,
} from './util';

interface StatChip {
  key: string;
  icon: string;
  label: string;
  tone?: () => string;
  value: () => string;
  delta?: () => string;
  tip: () => string;
}

interface ResourceChip {
  res: ResourceId;
  root: HTMLElement;
  value: HTMLElement;
  delta: HTMLElement;
}

const OVERLAYS: { mode: OverlayMode; label: string; icon: string; hint: string }[] = [
  { mode: 'none', label: 'None', icon: 'map', hint: 'Plain map — terrain, buildings, people.' },
  { mode: 'fertility', label: 'Soil fertility', icon: 'wheat', hint: 'Farmland quality. Green feeds a growing town.' },
  { mode: 'forest', label: 'Tree cover', icon: 'tree', hint: 'Standing timber and regrowth.' },
  { mode: 'water', label: 'Water access', icon: 'drop', hint: 'Rivers, lakes and aquifer reach.' },
  { mode: 'pollution', label: 'Pollution', icon: 'cloud', hint: 'Industrial fallout. Red is punishing.' },
  { mode: 'beauty', label: 'Beauty', icon: 'leaf', hint: 'Landscape worth living in.' },
  { mode: 'deposits', label: 'Deposits', icon: 'ore', hint: 'Ore, stone and fuel under the ground.' },
  { mode: 'roads', label: 'Road network', icon: 'road', hint: 'Where carts and caravans can move.' },
  { mode: 'population', label: 'Population', icon: 'people', hint: 'Where your people actually live.' },
  { mode: 'supply', label: 'Supply reach', icon: 'cart', hint: 'Logistics reach from your settlement.' },
  { mode: 'resources', label: 'Resource sites', icon: 'pin', hint: 'Known sites, ruins and wonders.' },
];

export class HUD {
  readonly root: HTMLElement;
  private statChips: { el: HTMLElement; value: HTMLElement; delta: HTMLElement | null; meta: StatChip }[] = [];
  private resourceChips: ResourceChip[] = [];
  private readonly refs = new Map<string, HTMLElement>();
  private readonly cache = new Map<string, string>();
  private overlayPopover!: HTMLElement;
  private alertsPopover!: HTMLElement;
  private overlayOpen = false;
  private alertsOpen = false;
  private tracker: DeltaTracker;
  private tickSample = 0;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('header');
    this.root.className = 'fh-hud';
    this.root.setAttribute('aria-label', 'Game status bar');
    this.root.innerHTML = this.renderShell();
    this.mountRefs();
    this.tracker = createDeltaTracker(() => this.sampleValues());
    this.buildStatChips();
    this.buildResourceChips();
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('keydown', this.onKeyDown);
    document.addEventListener('pointerdown', this.onDocPointerDown, true);
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('keydown', this.onKeyDown);
    document.removeEventListener('pointerdown', this.onDocPointerDown, true);
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  private renderShell(): string {
    return `
      <div class="fh-hud-main">
        <div class="fh-brand">
          <div class="fh-crest" aria-hidden="true">${icon('hearth', 'fh-icon is-crest')}</div>
          <div class="fh-brand-text">
            <button type="button" class="fh-brand-name display clickable" data-act="focus-capital" ${tipText('Centre the view on your capital (F)')}>${esc('—')}</button>
            <div class="fh-brand-meta">
              <span class="fh-era-chip" data-js="era">${icon('era', 'fh-icon is-tiny')}<b>Era I</b><span data-js="era-name">—</span></span>
              <span class="fh-seed" data-js="seed"></span>
            </div>
          </div>
          <button type="button" class="fh-pop-pill clickable" data-act="focus-capital" data-js="popwrap" ${tipText('Population of the selected settlement. Click to recentre.')}>
            ${icon('people', 'fh-icon')}
            <b data-js="pop">1</b><span class="fh-pop-label">souls</span>
          </button>
        </div>

        <div class="fh-when">
          <button type="button" class="fh-date clickable" data-act="open-almanac" ${tipText('The almanac holds the long story — charts and chronicle (C).')}>
            <span class="fh-date-main display" data-js="date">Year 1 · Spring 1</span>
            <span class="fh-weather-line">
              <span class="fh-weather-icon" data-js="weather-icon">${icon('sun', 'fh-icon is-small')}</span>
              <span class="fh-temp" data-js="temp">—</span>
              <span class="fh-forecast" data-js="forecast">—</span>
            </span>
          </button>
        </div>

        <div class="fh-hud-controls">
          <button type="button" class="fh-alert-pill clickable" data-act="toggle-alerts" data-js="alertpill" hidden>
            ${icon('warning', 'fh-icon is-small')}<b data-js="alertcount">0</b><span>alerts</span>
          </button>
          <button type="button" class="fh-iconbtn clickable" data-act="open-alerts" aria-label="Warnings and alerts" ${tipText('Warnings, causes and live alerts')}>
            ${icon('info', 'fh-icon')}<span class="fh-badge-dot" data-js="warnbadge" hidden></span>
          </button>
          <span class="fh-speed-state" data-js="speedstate" ${tipText('Current pace — press Space to pause, 1–4 to change')}>1×</span>
          <div class="fh-speed" role="group" aria-label="Time controls">
            <button type="button" class="fh-speed-btn clickable" data-speed="0" data-js="speed0" aria-label="Pause" ${tipText('Pause (Space)')}>${icon('pause', 'fh-icon is-small')}</button>
            <button type="button" class="fh-speed-btn clickable" data-speed="1" data-js="speed1" aria-label="Speed 1" ${tipText('Speed 1 — a slow, observant pace (1)')}>1</button>
            <button type="button" class="fh-speed-btn clickable" data-speed="2" data-js="speed2" aria-label="Speed 2" ${tipText('Speed 2 — the intended pace (2)')}>2</button>
            <button type="button" class="fh-speed-btn clickable" data-speed="3" data-js="speed3" aria-label="Speed 3" ${tipText('Speed 3 — brisk (3)')}>3</button>
            <button type="button" class="fh-speed-btn clickable" data-speed="4" data-js="speed4" aria-label="Speed 4" ${tipText('Speed 4 — years pass in moments (4)')}>4</button>
          </div>
          <button type="button" class="fh-iconbtn clickable" data-act="toggle-overlay" data-js="overlaybtn" aria-label="Map overlays" aria-haspopup="true" ${tipText('Map overlays — see fertility, pollution, deposits and more')}>
            ${icon('layers', 'fh-icon')}
          </button>
          <button type="button" class="fh-iconbtn clickable" data-act="open-notifications" data-js="bellbtn" aria-label="Chronicle of notices" ${tipText('Notices — everything that has happened recently')}>
            ${icon('bell', 'fh-icon')}<span class="fh-badge" data-js="bellbadge" hidden>0</span>
          </button>
          <button type="button" class="fh-iconbtn clickable" data-act="open-save" aria-label="Save and load" ${tipText('Save, load and export the world')}>
            ${icon('save', 'fh-icon')}
          </button>
          <button type="button" class="fh-iconbtn clickable" data-act="open-settings" aria-label="Settings" ${tipText('Settings, accessibility and shortcuts')}>
            ${icon('gear', 'fh-icon')}
          </button>
          <button type="button" class="fh-iconbtn clickable" data-act="open-help" aria-label="Help, tour and shortcuts" ${tipText('Help — replay the tour, shortcuts and first steps (?)')}>
            ${icon('help', 'fh-icon')}
          </button>
        </div>
      </div>

      <div class="fh-hud-ribbon" data-js="ribbon">
        <div class="fh-statstrip" data-js="stats"></div>
        <div class="fh-ribbon-sep" aria-hidden="true"></div>
        <div class="fh-resstrip" data-js="resources" aria-label="Key resources"></div>
      </div>

      <div class="fh-hud-popover fh-overlay-popover" data-js="overlaypopover" hidden></div>
      <div class="fh-hud-popover fh-alerts-popover" data-js="alertspopover" hidden></div>
    `;
  }

  private mountRefs(): void {
    for (const el of this.root.querySelectorAll<HTMLElement>('[data-js]')) {
      const key = el.dataset.js;
      if (key) this.refs.set(key, el);
    }
    this.overlayPopover = this.refs.get('overlaypopover') as HTMLElement;
    this.alertsPopover = this.refs.get('alertspopover') as HTMLElement;
    this.refs.get('overlaybtn')?.setAttribute('aria-expanded', 'false');
    this.refs.get('alertspopover')?.setAttribute('aria-hidden', 'true');
  }

  private buildStatChips(): void {
    const metas: StatChip[] = [
      {
        key: 'morale',
        icon: 'heart',
        label: 'Morale',
        tone: () => scoreTone(selectedSettlement(this.svc)?.morale ?? 0),
        value: () => pct100(selectedSettlement(this.svc)?.morale ?? 0),
        delta: () => deltaText(this.tracker.rate('morale'), 'day'),
        tip: () => {
          const st = selectedSettlement(this.svc);
          const s = stateOf(this.svc);
          const avg = s.metrics.series['morale']?.slice(-1)[0] ?? st?.morale ?? 0;
          return `<div class="fh-tip-head">${icon('heart', 'fh-icon is-small')} Morale</div>
            <div class="fh-tip-body">How willing your people are to keep going. Below 35 they begin to leave; below 20 the hearth is at risk.</div>
            <div class="fh-tip-grid"><span>Hearth morale</span><b>${pct100(st?.morale ?? 0)}</b><span>People (avg)</span><b>${pct100(avg)}</b><span>Approval</span><b>${pct100(s.society.approval)}</b></div>`;
        },
      },
      {
        key: 'food',
        icon: 'wheat',
        label: 'Food',
        tone: () => scoreTone((selectedSettlement(this.svc)?.foodDays ?? 0) * 10, 45, 20),
        value: () => `${fmt(selectedSettlement(this.svc)?.foodDays ?? 0)}d`,
        delta: () => deltaText(this.tracker.rate('foodDays'), 'day'),
        tip: () => {
          const st = selectedSettlement(this.svc);
          return `<div class="fh-tip-head">${icon('wheat', 'fh-icon is-small')} Food stores</div>
            <div class="fh-tip-body">Days of food left at current consumption. Below 12 days, start foraging, farming or buying.</div>
            <div class="fh-tip-grid"><span>Days remaining</span><b>${fmt(st?.foodDays ?? 0)}</b><span>Morale weight</span><b>${pct100(st?.morale ?? 0)}</b></div>`;
        },
      },
      {
        key: 'water',
        icon: 'drop',
        label: 'Water',
        tone: () => scoreTone((selectedSettlement(this.svc)?.waterDays ?? 0) * 10, 45, 20),
        value: () => `${fmt(selectedSettlement(this.svc)?.waterDays ?? 0)}d`,
        delta: () => deltaText(this.tracker.rate('waterDays'), 'day'),
        tip: () => `<div class="fh-tip-head">${icon('drop', 'fh-icon is-small')} Water</div>
          <div class="fh-tip-body">Days of fresh water in store. A well, river camp or cistern keeps this from falling.</div>`,
      },
      {
        key: 'treasury',
        icon: 'coin',
        label: 'Treasury',
        tone: () => 'is-brass',
        value: () => fmt(selectedSettlement(this.svc)?.treasury ?? 0),
        delta: () => deltaText(this.tracker.rate('treasury'), 'day'),
        tip: () => `<div class="fh-tip-head">${icon('coin', 'fh-icon is-small')} Treasury</div>
          <div class="fh-tip-body">Coin for wages, imports and great works. Taxes and trade bring it in; upkeep takes it away.</div>`,
      },
      {
        key: 'insight',
        icon: 'star',
        label: 'Insight',
        tone: () => 'is-info',
        value: () => fmt(stateOf(this.svc).research.insight),
        delta: () => deltaText(this.tracker.rate('insight'), 'day'),
        tip: () => {
          const s = stateOf(this.svc);
          const eta = this.tracker.rate('insight');
          return `<div class="fh-tip-head">${icon('star', 'fh-icon is-small')} Insight</div>
            <div class="fh-tip-body">The currency of discovery. Scholars, teachers and curiosity produce it.</div>
            <div class="fh-tip-grid"><span>Insight</span><b>${fmt(s.research.insight)}</b><span>Discoveries</span><b>${Object.keys(s.research.completed).length}</b><span>Net</span><b>${signed(eta, 2)}/day</b></div>`;
        },
      },
      {
        key: 'influence',
        icon: 'influence',
        label: 'Influence',
        tone: () => 'is-violet',
        value: () => fmt(selectedSettlement(this.svc)?.influence ?? 0),
        delta: () => deltaText(this.tracker.rate('influence'), 'day'),
        tip: () => `<div class="fh-tip-head">${icon('influence', 'fh-icon is-small')} Influence</div>
          <div class="fh-tip-body">Political capital. Enacting policies spends it; a respected settlement regains it slowly.</div>`,
      },
      {
        key: 'culture',
        icon: 'culture',
        label: 'Culture',
        tone: () => 'is-good',
        value: () => fmt(selectedSettlement(this.svc)?.culture ?? stateOf(this.svc).society.culturePoints ?? 0),
        delta: () => deltaText(this.tracker.rate('culture'), 'day'),
        tip: () => `<div class="fh-tip-head">${icon('culture', 'fh-icon is-small')} Culture</div>
          <div class="fh-tip-body">Art, festivals and shared story. It steadies morale and unlocks the life of the mind.</div>`,
      },
    ];
    const host = this.refs.get('stats');
    if (!host) return;
    host.innerHTML = metas
      .map(
        (m) => `<div class="fh-stat" data-key="${m.key}" ${tip(m.tip())}>
          <span class="fh-stat-icon">${icon(m.icon, 'fh-icon is-small')}</span>
          <span class="fh-stat-body"><span class="fh-stat-label">${esc(m.label)}</span>
          <span class="fh-stat-foot"><b class="fh-stat-value" data-js="stat-${m.key}">—</b><span class="fh-stat-delta" data-js="statd-${m.key}"></span></span></span>
        </div>`,
      )
      .join('');
    this.statChips = metas.map((meta) => {
      const el = host.querySelector<HTMLElement>(`[data-key="${meta.key}"]`) as HTMLElement;
      return {
        el,
        meta,
        value: host.querySelector<HTMLElement>(`[data-js="stat-${meta.key}"]`) as HTMLElement,
        delta: host.querySelector<HTMLElement>(`[data-js="statd-${meta.key}"]`),
      };
    });
  }

  private coreResources(): ResourceId[] {
    const c = this.svc.app.content;
    const cores = c.resourceOrder.filter((id) => c.resources[id]?.core);
    const fallback: ResourceId[] = ['berries', 'wood', 'stone', 'water', 'tools'];
    for (const res of fallback) if (!cores.includes(res) && c.resources[res]) cores.push(res);
    return cores.slice(0, 9);
  }

  private buildResourceChips(): void {
    const host = this.refs.get('resources');
    const c = this.svc.app.content;
    if (!host) return;
    host.innerHTML = this.coreResources()
      .map((res) => {
        const def = c.resources[res];
        return `<button type="button" class="fh-res clickable" data-res="${escAttr(res)}" ${tip(
          `<div class="fh-tip-head">${icon(def?.icon ?? 'diamond', 'fh-icon is-small')} ${esc(def?.name ?? pretty(res))}</div>
           <div class="fh-tip-body">${esc(def?.desc ?? 'A resource of the valley.')}</div>
           <div class="fh-tip-grid"><span>Category</span><b>${esc(pretty(def?.category ?? '—'))}</b><span>Base price</span><b>${fmt(def?.basePrice ?? 0)}</b>${def?.edible ? `<span>Food value</span><b>×${fmt(def.edible)}</b>` : ''}</div>`,
        )}>
          <span class="fh-res-icon">${icon(def?.icon ?? 'diamond', 'fh-icon is-small')}</span>
          <span class="fh-res-nums"><b data-js="res-${escAttr(res)}">0</b><span class="fh-res-delta" data-js="resd-${escAttr(res)}"></span></span>
        </button>`;
      })
      .join('');
    this.resourceChips = this.coreResources().map((res) => ({
      res,
      root: host.querySelector<HTMLElement>(`[data-res="${res}"]`) as HTMLElement,
      value: host.querySelector<HTMLElement>(`[data-js="res-${res}"]`) as HTMLElement,
      delta: host.querySelector<HTMLElement>(`[data-js="resd-${res}"]`) as HTMLElement,
    }));
  }

  // -------------------------------------------------------------------------
  // Refresh
  // -------------------------------------------------------------------------

  private sampleValues(): Record<string, number> {
    const st = selectedSettlement(this.svc);
    const s = stateOf(this.svc);
    const values: Record<string, number> = {
      pop: totalPopulation(s),
      morale: st?.morale ?? 0,
      foodDays: st?.foodDays ?? 0,
      waterDays: st?.waterDays ?? 0,
      treasury: st?.treasury ?? 0,
      insight: s.research.insight,
      influence: st?.influence ?? 0,
      culture: st?.culture ?? s.society.culturePoints ?? 0,
    };
    const c = this.svc.app.content;
    for (const res of this.coreResources()) {
      let total = 0;
      for (const settle of s.settlements) total += settle.stock[res] ?? 0;
      void c;
      values[`res:${res}`] = total;
    }
    return values;
  }

  refresh(): void {
    const s = stateOf(this.svc);
    const st = selectedSettlement(this.svc);
    const c = this.svc.app.content;
    const app = this.svc.app;

    // Sampling for deltas: cheap, once ~every 4 refreshes (~1s).
    if (++this.tickSample >= 4) {
      this.tickSample = 0;
      this.tracker.sample(s.tick);
    }

    this.setText('date', dateLabel(s.tick));
    const era = c.eras[s.research.era];
    this.setText('era', `${icon('era', 'fh-icon is-tiny')}<b>Era ${['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'][s.research.era] ?? s.research.era + 1}</b><span>${esc(era?.name ?? '—')}</span>`);
    this.setText('seed', `seed ${s.seed}`);
    const nameEl = this.root.querySelector<HTMLElement>('.fh-brand-name');
    if (nameEl && nameEl.textContent !== (st?.name ?? 'No settlement')) {
      nameEl.textContent = st?.name ?? 'No settlement';
      nameEl.setAttribute('data-tip', `${st?.isCapital ? 'Capital' : 'Settlement'} · click to recentre (F)`);
    }
    this.setText('pop', fmtInt(totalPopulation(s)));

    const weather = s.world.weather;
    this.setText('weather-icon', icon(weatherIcon(weather), 'fh-icon is-small'));
    this.setText('temp', `${Math.round(weather.temperature)}°C`);
    this.setText('forecast', weather.forecast ? esc(weather.forecast) : pretty(weather.season));
    const dateBtn = this.root.querySelector<HTMLElement>('.fh-date');
    if (dateBtn) {
      const season = seasonOf(s.tick);
      dateBtn.setAttribute(
        'data-tip',
        `${pretty(season)} · ${pretty(weather.forecast || 'still air')} · ${Math.round(weather.temperature)}°C\nRain ${pct(weather.rainfall)} · Drought ${pct(weather.drought)} · Wind ${pct(weather.wind)}`,
      );
    }

    // Stat chips
    for (const chip of this.statChips) {
      const value = chip.meta.value();
      const delta = chip.meta.delta?.() ?? '';
      if (chip.value.textContent !== value) chip.value.textContent = value;
      if (chip.delta && chip.delta.innerHTML !== delta) chip.delta.innerHTML = delta;
      const tone = chip.meta.tone?.() ?? '';
      if (chip.el.dataset.tone !== tone) chip.el.dataset.tone = tone;
      if (chip.meta.key === 'morale' || chip.meta.key === 'food' || chip.meta.key === 'water') {
        const pctVal = chip.meta.key === 'morale' ? (st?.morale ?? 0) : clamp((st?.[chip.meta.key === 'food' ? 'foodDays' : 'waterDays'] ?? 0) * 8, 0, 100);
        const meterEl = chip.el.querySelector<HTMLElement>('.fh-stat-meter');
        if (!meterEl) {
          // lazy-add a micro meter under the stat body once
          const body = chip.el.querySelector('.fh-stat-body');
          if (body) body.insertAdjacentHTML('beforeend', '<span class="fh-stat-meter"></span>');
        }
        const m = chip.el.querySelector<HTMLElement>('.fh-stat-meter');
        if (m) {
          m.innerHTML = meter(pctVal, 100, { tone: scoreTone(pctVal) });
        }
      }
    }

    // Resource chips
    for (const chip of this.resourceChips) {
      let total = 0;
      for (const settle of s.settlements) total += settle.stock[chip.res] ?? 0;
      const absent = total < 0.005;
      const value = absent ? '·' : fmt(total);
      if (chip.value.textContent !== value) {
        chip.value.textContent = value;
        chip.value.classList.toggle('is-absent', absent);
      }
      chip.root.classList.toggle('is-absent', absent);
      const rate = this.tracker.rate(`res:${chip.res}`);
      const deltaHtml = Math.abs(rate) > 0.02 ? `${rate > 0 ? '+' : ''}${fmt(rate, 1)}/d` : '';
      if (chip.delta.textContent !== deltaHtml) {
        chip.delta.textContent = deltaHtml;
        chip.delta.className = `fh-res-delta ${rate > 0.02 ? 'is-good' : rate < -0.02 ? 'is-bad' : ''}`;
      }
      const def = c.resources[chip.res];
      chip.root.setAttribute(
        'data-tip',
        `${def?.name ?? pretty(chip.res)} — ${absent ? 'none in store' : `${fmt(total, 1)} in store`}${Math.abs(rate) > 0.02 ? ` · ${signed(rate, 2)}/day net` : ''}`,
      );
    }

    // Speed controls
    const paused = app.paused || app.speed <= 0;
    for (let i = 0; i <= 4; i++) {
      const btn = this.refs.get(`speed${i}`);
      if (!btn) continue;
      const active = i === 0 ? paused : !paused && app.speed === i;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    const statePill = this.refs.get('speedstate');
    if (statePill) {
      const label = paused ? 'PAUSED' : `${Math.max(1, app.speed)}×`;
      if (statePill.textContent !== label) statePill.textContent = label;
      statePill.classList.toggle('is-paused', paused);
      statePill.setAttribute('title', paused ? 'The world is paused — Space to resume' : `Running at speed ${app.speed} — Space to pause`);
    }
    const pauseBtn = this.refs.get('speed0');
    if (pauseBtn) {
      const iconName = paused ? 'play' : 'pause';
      if (this.cache.get('speed0icon') !== iconName) {
        this.cache.set('speed0icon', iconName);
        pauseBtn.innerHTML = icon(iconName, 'fh-icon is-small');
      }
    }

    // Alerts + badge
    const pending = s.events.pending.length;
    const warnings = s.events.warnings ?? [];
    const stAlerts = st?.alerts ?? [];
    const alertCount = warnings.length + stAlerts.length + pending;
    const pill = this.refs.get('alertpill');
    if (pill) {
      pill.hidden = alertCount === 0;
      this.setText('alertcount', fmtInt(alertCount));
      pill.dataset.tone = pending ? 'bad' : warnings.some((w) => w.severity === 3) ? 'warn' : 'info';
    }
    const warnBadge = this.refs.get('warnbadge');
    if (warnBadge) warnBadge.hidden = alertCount === 0;
    const unread = unreadNotifications(s);
    const bellBadge = this.refs.get('bellbadge');
    if (bellBadge) {
      bellBadge.hidden = unread === 0;
      const text = unread > 99 ? '99+' : String(unread);
      if (bellBadge.textContent !== text) bellBadge.textContent = text;
    }
    const overlayBtn = this.refs.get('overlaybtn');
    if (overlayBtn) overlayBtn.classList.toggle('is-active', s.world ? app.view.overlay !== 'none' : false);

    if (this.alertsOpen) this.renderAlerts();
    if (this.overlayOpen) this.renderOverlayMenu();
  }

  private setText(key: string, html: string): void {
    const el = this.refs.get(key);
    if (!el) return;
    if (this.cache.get(key) === html) return;
    this.cache.set(key, html);
    el.innerHTML = html;
  }

  // -------------------------------------------------------------------------
  // Popovers
  // -------------------------------------------------------------------------

  private renderOverlayMenu(): void {
    const s = stateOf(this.svc);
    const current = this.svc.app.view.overlay;
    const showGrid = this.svc.app.view.showGrid;
    const showRange = this.svc.app.view.showRange;
    this.overlayPopover.innerHTML = `
      <div class="fh-pop-head"><h3>Map overlays</h3><span class="fh-faint">layers of the valley</span></div>
      <div class="fh-overlay-grid" role="menu">
        ${OVERLAYS.map(
          (o) => `<button type="button" role="menuitemradio" aria-checked="${current === o.mode}" class="fh-overlay-item clickable ${current === o.mode ? 'is-active' : ''}" data-overlay="${o.mode}" data-act="pick-overlay">
            ${icon(o.icon, 'fh-icon')}<span><b>${esc(o.label)}</b><small>${esc(o.hint)}</small></span>
          </button>`,
        ).join('')}
      </div>
      <div class="fh-pop-sep"></div>
      <div class="fh-pop-toggles">
        <button type="button" class="fh-toggle clickable ${showGrid ? 'is-on' : ''}" data-act="toggle-grid" aria-pressed="${showGrid}">${icon('grid', 'fh-icon is-small')}<span>Grid</span></button>
        <button type="button" class="fh-toggle clickable ${showRange ? 'is-on' : ''}" data-act="toggle-range" aria-pressed="${showRange}">${icon('target', 'fh-icon is-small')}<span>Ranges</span></button>
      </div>
      <div class="fh-pop-foot"><span class="fh-faint">Revealed ${pct(s.exploration.mapReveal)} · ${fmtInt(s.exploration.revealedTiles)} tiles charted</span></div>
    `;
  }

  private renderAlerts(): void {
    const s = stateOf(this.svc);
    const st = selectedSettlement(this.svc);
    const warnings = [...(s.events.warnings ?? [])].sort((a, b) => b.severity - a.severity).slice(0, 8);
    const alerts = [...(st?.alerts ?? [])].sort((a, b) => b.severity - a.severity).slice(0, 8);
    const pending = s.events.pending;
    const active = s.events.active ?? [];
    const row = (severity: number, title: string, detail: string, extra = ''): string =>
      `<div class="fh-alert-row" data-tone="${severity >= 3 ? 'bad' : severity === 2 ? 'warn' : 'info'}">
        <span class="fh-alert-icon">${icon(severity >= 3 ? 'skull' : 'warning', 'fh-icon is-small')}</span>
        <span class="fh-alert-copy"><b>${esc(title)}</b><small>${esc(detail)}</small>${extra ? `<small class="fh-alert-extra">${esc(extra)}</small>` : ''}</span>
      </div>`;
    this.alertsPopover.innerHTML = `
      <div class="fh-pop-head"><h3>Alerts & omens</h3><span class="fh-faint">${warnings.length + alerts.length} active</span></div>
      ${
        pending.length
          ? `<div class="fh-alert-urgent">${icon('bell', 'fh-icon is-small')}<span><b>${pending.length} decision${pending.length > 1 ? 's' : ''} awaiting you</b><small>The world waits on your word.</small></span><button class="fh-btn is-ember clickable" data-act="open-decision">Decide</button></div>`
          : ''
      }
      <div class="fh-alert-list">
        ${warnings.map((w) => row(w.severity, w.title, w.detail, [w.cause && `Cause: ${w.cause}`, w.daysUntil !== undefined && w.daysUntil > 0 ? `~${fmt(w.daysUntil)} days` : ''].filter(Boolean).join(' · '))).join('')}
        ${alerts.map((a) => row(a.severity, a.title, a.detail, `Since year ${Math.floor(a.sinceTick / 64) + 1}`)).join('')}
        ${!warnings.length && !alerts.length && !pending.length ? `<div class="fh-empty-inline">${icon('check', 'fh-icon is-small')} Nothing demands attention. The valley is quiet.</div>` : ''}
      </div>
      ${
        active.length
          ? `<div class="fh-pop-sep"></div><div class="fh-active-events"><span class="fh-mini-head">Active forces</span>${active
              .slice(0, 4)
              .map((e) => `<span class="fh-chip is-warn" ${tipText(`${e.title} — ${Math.max(0, Math.ceil(e.endTick - s.tick))} days remaining`)}>${icon('hourglass', 'fh-icon is-tiny')}${esc(e.title)}</span>`)
              .join('')}</div>`
          : ''
      }
      <div class="fh-pop-foot"><button class="fh-btn clickable" data-act="open-objectives">Objectives & tutorial</button></div>
    `;
  }

  private toggleOverlay(): void {
    this.overlayOpen = !this.overlayOpen;
    if (this.overlayOpen) this.closeAlerts();
    this.overlayPopover.hidden = !this.overlayOpen;
    this.refs.get('overlaybtn')?.setAttribute('aria-expanded', String(this.overlayOpen));
    if (this.overlayOpen) this.renderOverlayMenu();
  }

  private toggleAlerts(): void {
    this.alertsOpen = !this.alertsOpen;
    if (this.alertsOpen) {
      this.overlayOpen = false;
      this.overlayPopover.hidden = true;
      this.refs.get('overlaybtn')?.setAttribute('aria-expanded', 'false');
    }
    this.alertsPopover.hidden = !this.alertsOpen;
    if (this.alertsOpen) this.renderAlerts();
  }

  private closeAlerts(): void {
    this.alertsOpen = false;
    this.alertsPopover.hidden = true;
  }

  closePopovers(): void {
    this.overlayOpen = false;
    this.overlayPopover.hidden = true;
    this.refs.get('overlaybtn')?.setAttribute('aria-expanded', 'false');
    this.closeAlerts();
  }

  private onDocPointerDown = (ev: PointerEvent): void => {
    if (!this.overlayOpen && !this.alertsOpen) return;
    const target = ev.target;
    if (!(target instanceof Node)) return;
    if (this.root.contains(target)) {
      const inOverlay = this.overlayPopover.contains(target);
      const inAlerts = this.alertsPopover.contains(target);
      const onToggle = target instanceof Element && target.closest('[data-act="toggle-overlay"], [data-act="toggle-alerts"], [data-act="open-alerts"]');
      if (inOverlay || inAlerts || onToggle) return;
    }
    this.closePopovers();
  };

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape' && (this.overlayOpen || this.alertsOpen)) {
      ev.stopPropagation();
      this.closePopovers();
    }
  };

  private onSpeed(speed: number): void {
    const app = this.svc.app;
    if (speed === 0) app.pause();
    else {
      app.setSpeed(speed);
      app.resume();
    }
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const speedBtn = target.closest<HTMLElement>('[data-speed]');
    if (speedBtn) {
      this.onSpeed(Number(speedBtn.dataset.speed ?? 1));
      return;
    }
    const overlayItem = target.closest<HTMLElement>('[data-overlay]');
    if (overlayItem) {
      this.svc.app.setOverlay(overlayItem.dataset.overlay as OverlayMode);
      this.renderOverlayMenu();
      this.svc.refreshSoon();
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    switch (act) {
      case 'focus-capital': {
        const cap = capitalOf(stateOf(this.svc));
        if (cap) this.svc.app.renderer?.centerOnTile(cap.x, cap.y, 1);
        break;
      }
      case 'open-almanac':
        this.svc.openPanel('almanac');
        break;
      case 'toggle-overlay':
        this.toggleOverlay();
        break;
      case 'toggle-alerts':
      case 'open-alerts':
        this.toggleAlerts();
        break;
      case 'open-notifications':
        this.svc.openNotifications();
        break;
      case 'open-save':
        this.svc.openSettings('save');
        break;
      case 'open-settings':
        this.svc.openSettings('settings');
        break;
      case 'open-help':
        this.svc.openSettings('help');
        break;
      case 'open-decision':
        this.closePopovers();
        this.svc.openDecisionModal();
        break;
      case 'open-objectives':
        this.closePopovers();
        this.svc.openPanel('objectives');
        break;
      case 'toggle-grid':
        this.svc.app.view.showGrid = !this.svc.app.view.showGrid;
        this.renderOverlayMenu();
        this.svc.refreshSoon();
        break;
      case 'toggle-range':
        this.svc.app.view.showRange = !this.svc.app.view.showRange;
        this.renderOverlayMenu();
        this.svc.refreshSoon();
        break;
      default:
        break;
    }
  };
}
