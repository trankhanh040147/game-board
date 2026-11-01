/**
 * Left build panel: categories, search, eras/tech lock badges, live affordability
 * and the road / planting / demolition tools.
 */
import type { BuildingDef, BuildingId, ResourceId } from '../sim/types';
import { missingCost, modOfState, scaleCost } from '../sim/core';
import { roman } from './util';
import {
  chip,
  clamp,
  esc,
  escAttr,
  fmt,
  iconHtml,
  jobsTotal,
  modChips,
  pct,
  pretty,
  selectedSettlement,
  stateOf,
  tip,
  tipText,
  type Services,
} from './util';
import { icon } from './icons';

interface CardRef {
  el: HTMLElement;
  def: BuildingDef;
  costEls: { res: ResourceId; el: HTMLElement }[];
}

type ToolMode = '__road__' | '__plant' | '__demolish__' | null;

const CATEGORY_META: Record<string, { label: string; icon: string }> = {
  housing: { label: 'Housing', icon: 'house' },
  food: { label: 'Food', icon: 'wheat' },
  gathering: { label: 'Gathering', icon: 'camp' },
  industry: { label: 'Industry', icon: 'workshop' },
  energy: { label: 'Energy', icon: 'spark' },
  water: { label: 'Water', icon: 'drop' },
  storage: { label: 'Storage', icon: 'storehouse' },
  logistics: { label: 'Logistics', icon: 'cart' },
  science: { label: 'Science', icon: 'lab' },
  society: { label: 'Society', icon: 'crown' },
  defence: { label: 'Defence', icon: 'shield' },
  beauty: { label: 'Beauty', icon: 'garden' },
  special: { label: 'Special', icon: 'star' },
};

const ERA_NAMES = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

export class BuildPanel {
  readonly root: HTMLElement;
  private listHost!: HTMLElement;
  private categoryHost!: HTMLElement;
  private searchInput!: HTMLInputElement;
  private footerHost!: HTMLElement;
  private toolHost!: HTMLElement;
  private cards: CardRef[] = [];
  private category: string = 'all';
  private search = '';
  private showLocked = true;
  private affordableOnly = false;
  private renderKey = '';
  private collapsed = false;
  private demolishMode = false;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('aside');
    this.root.className = 'fh-build-panel';
    this.root.setAttribute('aria-label', 'Construction');
    this.root.innerHTML = `
      <div class="fh-panel-head fh-build-head">
        <div class="fh-panel-titles">
          <span class="fh-eyebrow">Raise</span>
          <h2 class="display">Construction</h2>
        </div>
        <div class="fh-head-actions">
          <button type="button" class="fh-iconbtn is-quiet clickable" data-act="toggle-locked" data-js="lockedbtn" aria-label="Toggle locked buildings" ${tipText('Show or hide buildings you have not unlocked yet')}>${icon('filter', 'fh-icon is-small')}</button>
          <button type="button" class="fh-iconbtn is-quiet clickable" data-act="collapse" aria-label="Collapse build panel" ${tipText('Collapse the build panel (B)')}>${icon('chevron_left', 'fh-icon is-small')}</button>
        </div>
      </div>
      <div class="fh-build-tools">
        <button type="button" class="fh-tool clickable" data-tool="__road__" aria-pressed="false" ${tipText('Road brush — lay roads for carts, access and speed. Cost: 1 stone · 0.5 wood')}>${icon('road', 'fh-icon is-small')}<span>Road</span></button>
        <button type="button" class="fh-tool clickable" data-tool="__plant__" aria-pressed="false" ${tipText('Plant saplings — restore forest and beauty (1.5 wood · 0.5 fiber)')}>${icon('seed', 'fh-icon is-small')}<span>Plant</span></button>
        <button type="button" class="fh-tool clickable" data-tool="__demolish__" aria-pressed="false" ${tipText('Demolish — select a building and confirm to dismantle it for partial refund')}>${icon('close', 'fh-icon is-small')}<span>Clear</span></button>
      </div>
      <div class="fh-build-filters">
        <label class="fh-search">
          <span class="fh-search-icon">${icon('search', 'fh-icon is-small')}</span>
          <input type="search" data-js="search" placeholder="Search buildings…" aria-label="Search buildings" autocomplete="off" spellcheck="false" />
          <button type="button" class="fh-search-clear clickable" data-act="clear-search" aria-label="Clear search" hidden>${icon('close', 'fh-icon is-tiny')}</button>
        </label>
        <div class="fh-cat-strip" data-js="categories" role="tablist" aria-label="Building categories"></div>
      </div>
      <div class="fh-build-list" data-js="list" role="list"></div>
      <div class="fh-build-foot" data-js="foot"></div>
    `;
    this.listHost = this.query('list');
    this.categoryHost = this.query('categories');
    this.searchInput = this.query('search') as HTMLInputElement;
    this.footerHost = this.query('foot');
    this.toolHost = this.root.querySelector<HTMLElement>('.fh-build-tools') as HTMLElement;

    this.searchInput.addEventListener('input', () => {
      this.search = this.searchInput.value.trim().toLowerCase();
      const clear = this.root.querySelector<HTMLElement>('[data-act="clear-search"]');
      if (clear) clear.hidden = !this.search;
      this.renderList(true);
    });
    this.searchInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && this.search) {
        ev.stopPropagation();
        this.searchInput.value = '';
        this.search = '';
        this.renderList(true);
      }
    });
    this.root.addEventListener('click', this.onClick);
  }

  private query(key: string): HTMLElement {
    return this.root.querySelector<HTMLElement>(`[data-js="${key}"]`) as HTMLElement;
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  setCollapsed(collapsed: boolean): void {
    this.collapsed = collapsed;
    this.root.classList.toggle('is-collapsed', collapsed);
    this.root.querySelector('.fh-build-head .fh-head-actions [data-act="collapse"]')?.setAttribute('aria-label', collapsed ? 'Expand build panel' : 'Collapse build panel');
    const btn = this.root.querySelector<HTMLElement>('[data-act="collapse"]');
    if (btn) btn.innerHTML = icon(collapsed ? 'chevron_right' : 'chevron_left', 'fh-icon is-small');
  }

  toggleCollapsed(): void {
    this.setCollapsed(!this.collapsed);
  }

  focusCategory(category: string | null): void {
    this.setCollapsed(false);
    this.search = '';
    this.searchInput.value = '';
    this.category = category ?? 'all';
    this.renderKey = '';
    this.renderCategories();
    this.renderList(true);
    this.syncToolState();
    this.renderFooter();
    this.listHost.scrollTop = 0;
  }

  cancelTool(): void {
    this.demolishMode = false;
    this.svc.app.setBuildMode(null);
    this.syncToolState();
  }

  refresh(): void {
    const s = stateOf(this.svc);
    const st = selectedSettlement(this.svc);
    const c = this.svc.app.content;
    const mode = this.svc.app.view.buildMode;
    const unlockedCount = c.buildingOrder.filter((id) => {
      const def = c.buildings[id];
      return def && (def.era <= s.research.era || s.flags[`unlock_building:${id}`]);
    }).length;
    const key = [
      this.category,
      this.search,
      this.showLocked ? '1' : '0',
      this.affordableOnly ? '1' : '0',
      s.research.era,
      unlockedCount,
      Object.keys(s.research.completed).length,
      st?.id ?? -1,
      (s.flags['wonders_unlocked'] ? 1 : 0),
      mode ?? '',
      this.demolishMode ? '1' : '0',
    ].join('|');
    if (key !== this.renderKey) {
      this.renderKey = key;
      this.renderCategories();
      this.renderList();
      this.syncToolState();
    } else {
      this.updateAffordability();
    }
    this.renderFooter();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private renderCategories(): void {
    const c = this.svc.app.content;
    const counts = new Map<string, number>();
    for (const id of c.buildingOrder) {
      const def = c.buildings[id];
      if (!def) continue;
      counts.set(def.category, (counts.get(def.category) ?? 0) + 1);
    }
    const cats = [...counts.keys()].sort((a, b) => {
      const order = Object.keys(CATEGORY_META);
      return order.indexOf(a) - order.indexOf(b);
    });
    this.categoryHost.innerHTML = [
      `<button type="button" role="tab" class="fh-cat clickable ${this.category === 'all' ? 'is-active' : ''}" data-cat="all" aria-selected="${this.category === 'all'}">${icon('grid', 'fh-icon is-tiny')}<span>All</span></button>`,
      ...cats.map((cat) => {
        const meta = CATEGORY_META[cat] ?? { label: pretty(cat), icon: 'dot' };
        return `<button type="button" role="tab" class="fh-cat clickable ${this.category === cat ? 'is-active' : ''}" data-cat="${escAttr(cat)}" aria-selected="${this.category === cat}" ${tipText(`${meta.label} — ${counts.get(cat) ?? 0} kinds`)}>${icon(meta.icon, 'fh-icon is-tiny')}<span>${esc(meta.label)}</span></button>`;
      }),
    ].join('');
  }

  private filtered(): BuildingDef[] {
    const c = this.svc.app.content;
    const s = stateOf(this.svc);
    const out: BuildingDef[] = [];
    for (const id of c.buildingOrder) {
      const def = c.buildings[id];
      if (!def) continue;
      if (this.category !== 'all' && def.category !== this.category) continue;
      const unlocked = def.era <= s.research.era || !!s.flags[`unlock_building:${id}`];
      const techOk = (def.requiresTech ?? []).every((t) => !!s.research.completed[t] || !c.techs[t]);
      const isUnlocked = unlocked && techOk;
      if (!isUnlocked && !this.showLocked) continue;
      if (this.search) {
        const hay = `${def.name} ${def.desc} ${def.flavor ?? ''} ${(def.tags ?? []).join(' ')} ${def.category} ${id}`.toLowerCase();
        if (!hay.includes(this.search)) continue;
      }
      if (this.affordableOnly) {
        const st = selectedSettlement(this.svc);
        if (!st) continue;
        const cost = scaleCost(def.cost, 1 + modOfState(s, st.id, 'constructionCost'));
        if (Object.keys(missingCost(st, cost)).length > 0) continue;
      }
      out.push(def);
    }
    // Era asc, then category, then name (keeps the first-shelter essentials on top).
    out.sort((a, b) => a.era - b.era || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return out;
  }

  private renderList(force = false): void {
    if (force) this.renderKey = '';
    const defs = this.filtered();
    if (!defs.length) {
      this.cards = [];
      this.listHost.innerHTML = `<div class="fh-empty"><p class="fh-empty-title">Nothing matches</p><p class="fh-empty-body">Try another category, or clear the search.</p></div>`;
      return;
    }
    const s = stateOf(this.svc);
    const st = selectedSettlement(this.svc);
    this.listHost.innerHTML = defs
      .map((def) => {
        const unlocked = def.era <= s.research.era && (def.requiresTech ?? []).every((t) => !!s.research.completed[t] || !this.svc.app.content.techs[t]);
        const eraAllowed = def.era <= s.research.era;
        const missingTechs = (def.requiresTech ?? []).filter((t) => !s.research.completed[t] && this.svc.app.content.techs[t]);
        const active = this.svc.app.view.buildMode === def.id && !this.demolishMode;
        const cost = scaleCost(def.cost, 1 + (st ? modOfState(s, st.id, 'constructionCost') : 0));
        const activeChip = active ? '<span class="fh-build-active" aria-label="Selected">' + icon('check', 'fh-icon is-tiny') + '</span>' : '';
        return `<button type="button" role="listitem" class="fh-build-card clickable ${active ? 'is-active' : ''} ${unlocked ? '' : 'is-locked'}" data-build="${escAttr(def.id)}" ${tip(this.cardTip(def, cost, unlocked, eraAllowed, missingTechs))}>
          <span class="fh-build-icon" style="--fh-accent:${escAttr(def.visual?.accent ?? '#c9a55b')}">${icon(def.visual?.icon ?? 'hammer', 'fh-icon')}${activeChip}</span>
          <span class="fh-build-body">
            <span class="fh-build-title"><b>${esc(def.name)}</b><span class="fh-build-era">${unlocked ? '' : icon('diamond', 'fh-icon is-tiny')}Era ${ERA_NAMES[def.era] ?? def.era + 1}</span></span>
            <span class="fh-build-desc">${esc(def.desc)}</span>
            <span class="fh-build-row"><span class="fh-build-costs" data-costs>${this.costChipsHtml(cost, st?.stock)}</span><span class="fh-build-jobs" ${tipText('Jobs this building offers at full crew')}>${icon('person', 'fh-icon is-tiny')}${jobsTotal(def)}</span></span>
            ${unlocked ? '' : `<span class="fh-build-lock">${icon('lock', 'fh-icon is-tiny')}${esc(this.lockText(def, eraAllowed, missingTechs))}</span>`}
          </span>
        </button>`;
      })
      .join('');
    this.cards = defs.map((def) => {
      const el = this.listHost.querySelector<HTMLElement>(`[data-build="${CSS.escape(def.id)}"]`) as HTMLElement;
      const costEls = Array.from(el.querySelectorAll<HTMLElement>('[data-costs] .fh-cost')).map((costEl) => ({ res: costEl.dataset.res ?? '', el: costEl }));
      return { el, def, costEls };
    });
    this.attachCostRes();
  }

  private attachCostRes(): void {
    // Cost chips carry their resource id for live affordability updates.
    const c = this.svc.app.content;
    for (const card of this.cards) {
      const cost = card.def.cost;
      for (const { res, el } of card.costEls) {
        void res;
        void el;
      }
      void c;
    }
  }

  private costChipsHtml(cost: Record<ResourceId, number>, stock: Record<ResourceId, number> | undefined): string {
    const c = this.svc.app.content;
    return Object.entries(cost)
      .filter(([, v]) => v > 0)
      .map(([res, amount]) => {
        const def = c.resources[res];
        const have = stock?.[res] ?? 0;
        const missing = stock ? have + 1e-6 < amount : false;
        return `<span class="fh-cost ${missing ? 'is-missing' : ''}" data-res="${escAttr(res)}" ${tipText(`${def?.name ?? pretty(res)} · need ${fmt(amount, 1)}${stock ? ` · have ${fmt(have, 1)}` : ''}`)}>${icon(def?.icon ?? 'diamond', 'fh-icon is-tiny')}<b>${esc(fmt(amount, 1))}</b></span>`;
      })
      .join('');
  }

  private lockText(def: BuildingDef, eraAllowed: boolean, missingTechs: string[]): string {
    if (!eraAllowed) return `Era ${ERA_NAMES[def.era] ?? def.era + 1}`;
    if (missingTechs.length) {
      const names = missingTechs.map((t) => this.svc.app.content.techs[t]?.name ?? pretty(t));
      return names.slice(0, 2).join(' · ');
    }
    return 'Locked';
  }

  private cardTip(def: BuildingDef, cost: Record<ResourceId, number>, unlocked: boolean, eraAllowed: boolean, missingTechs: string[]): string {
    const c = this.svc.app.content;
    const jobs = def.jobs.map((j) => `<span>${icon(c.professions[j.profession]?.icon ?? 'person', 'fh-icon is-tiny')}${esc(c.professions[j.profession]?.name ?? pretty(j.profession))} ×${j.count}</span>`).join('');
    const extra: string[] = [];
    if (def.housing) extra.push(`<span>Housing</span><b>${def.housing.capacity} beds · quality ${fmt(def.housing.quality, 1)}</b>`);
    if (def.storage) extra.push(`<span>Storage</span><b>+${fmt(def.storage)} units</b>`);
    if (def.pollution) extra.push(`<span>Pollution</span><b>${fmt(def.pollution, 1)}/day</b>`);
    if (def.beauty) extra.push(`<span>Beauty aura</span><b>${def.beauty > 0 ? '+' : ''}${fmt(def.beauty, 1)}</b>`);
    if (def.waterUse) extra.push(`<span>Water use</span><b>${fmt(def.waterUse, 1)}/day</b>`);
    if (def.energyUse) extra.push(`<span>Energy use</span><b>${fmt(def.energyUse, 1)}/day</b>`);
    if (def.buildTicks) extra.push(`<span>Build time</span><b>${fmt(def.buildTicks)} days</b>`);
    if (def.placement?.needWater) extra.push(`<span>Placement</span><b>Needs water nearby</b>`);
    if (def.placement?.needForest) extra.push(`<span>Placement</span><b>Needs forest</b>`);
    if (def.placement?.needDeposit) extra.push(`<span>Placement</span><b>Needs ${esc(c.resources[def.placement.needDeposit]?.name ?? pretty(def.placement.needDeposit))} deposit</b>`);
    if (def.placement?.unique) extra.push(`<span>Placement</span><b>One per settlement</b>`);
    const lock = !unlocked
      ? `<div class="fh-tip-lock">${icon('lock', 'fh-icon is-small')} ${!eraAllowed ? `Unlocks in era ${ERA_NAMES[def.era] ?? def.era + 1}` : `Requires ${esc(missingTechs.map((t) => c.techs[t]?.name ?? pretty(t)).join(', '))}`}</div>`
      : '';
    const costHtml = Object.entries(cost)
      .filter(([, v]) => v > 0)
      .map(([res, v]) => `<span>${icon(c.resources[res]?.icon ?? 'diamond', 'fh-icon is-tiny')}${esc(c.resources[res]?.name ?? pretty(res))}</span><b>${fmt(v, 1)}</b>`)
      .join('');
    return `<div class="fh-tip-head">${icon(def.visual?.icon ?? 'hammer', 'fh-icon is-small')} ${esc(def.name)}</div>
      <div class="fh-tip-body">${esc(def.desc)}</div>
      ${def.flavor ? `<div class="fh-tip-flavor serif">“${esc(def.flavor)}”</div>` : ''}
      ${lock}
      <div class="fh-tip-grid">${costHtml}${extra.join('')}</div>
      ${jobs ? `<div class="fh-tip-jobs">${jobs}</div>` : ''}
      ${def.effects ? `<div class="fh-tip-mods">${modChips(def.effects, 8)}</div>` : ''}
      <div class="fh-tip-foot">${unlocked ? `Click, then choose a tile within reach of ${esc(selectedSettlement(this.svc)?.name ?? 'your settlement')}.` : 'Discover the required knowledge first.'}</div>`;
  }

  private updateAffordability(): void {
    const st = selectedSettlement(this.svc);
    if (!st) return;
    const s = stateOf(this.svc);
    for (const card of this.cards) {
      const cost = scaleCost(card.def.cost, 1 + modOfState(s, st.id, 'constructionCost'));
      const missing = missingCost(st, cost);
      const els = card.el.querySelectorAll<HTMLElement>('[data-costs] .fh-cost');
      els.forEach((el) => {
        const res = el.dataset.res ?? '';
        const need = cost[res] ?? 0;
        const have = st.stock[res] ?? 0;
        el.classList.toggle('is-missing', have + 1e-6 < need);
      });
      card.el.classList.toggle('is-unaffordable', Object.keys(missing).length > 0);
    }
  }

  private renderFooter(): void {
    const st = selectedSettlement(this.svc);
    const mode = this.svc.app.view.buildMode;
    const def = mode && mode !== '__road__' && mode !== '__plant__' && mode !== '__demolish__' ? this.svc.app.content.buildings[mode] : null;
    let html = '';
    if (this.demolishMode) {
      html = `<span class="fh-foot-hint is-warn">${icon('close', 'fh-icon is-tiny')} Select a building to dismantle <button type="button" class="fh-btn is-ghost clickable" data-act="cancel-tool">Cancel</button></span>`;
    } else if (mode === '__road__') {
      html = `<span class="fh-foot-hint">${icon('road', 'fh-icon is-tiny')} Drag or click to lay road · <kbd>Esc</kbd> to stop</span>`;
    } else if (mode === '__plant__') {
      html = `<span class="fh-foot-hint">${icon('seed', 'fh-icon is-tiny')} Click bare ground to plant · <kbd>Esc</kbd> to stop</span>`;
    } else if (def) {
      html = `<span class="fh-foot-hint is-active">${icon(def.visual?.icon ?? 'hammer', 'fh-icon is-tiny')} Placing <b>${esc(def.name)}</b> · <kbd>Esc</kbd> to cancel</span>`;
    } else {
      html = `<span class="fh-foot-hint faint">${icon(st ? 'pin' : 'warning', 'fh-icon is-tiny')} ${st ? `${esc(st.name)} · ${fmt(st.storageUsed)}/${fmt(st.storageCap)} used` : 'No settlement selected'}</span>`;
    }
    this.footerHost.innerHTML = html;
  }

  private syncToolState(): void {
    const mode = this.svc.app.view.buildMode;
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-tool]')) {
      const tool = btn.dataset.tool as ToolMode;
      const active = tool === '__demolish__' ? this.demolishMode : mode === tool;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    }
    this.root.querySelectorAll<HTMLElement>('[data-build]').forEach((el) => {
      el.classList.toggle('is-active', !this.demolishMode && mode === el.dataset.build);
    });
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private selectBuilding(def: BuildingDef): void {
    this.demolishMode = false;
    if (!this.affordable(def)) {
      this.svc.toast(`Not enough materials for ${def.name}.`, 'warn', 'warning');
    }
    const mode = this.svc.app.view.buildMode;
    this.svc.app.setBuildMode(mode === def.id ? null : def.id);
    this.syncToolState();
    this.renderFooter();
  }

  private affordable(def: BuildingDef): boolean {
    const st = selectedSettlement(this.svc);
    if (!st) return false;
    const s = stateOf(this.svc);
    const cost = scaleCost(def.cost, 1 + modOfState(s, st.id, 'constructionCost'));
    return Object.keys(missingCost(st, cost)).length === 0;
  }

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const cat = target.closest<HTMLElement>('[data-cat]');
    if (cat) {
      this.category = cat.dataset.cat ?? 'all';
      this.renderCategories();
      this.renderList(true);
      return;
    }
    const tool = target.closest<HTMLElement>('[data-tool]');
    if (tool) {
      const mode = tool.dataset.tool as ToolMode;
      if (mode === '__demolish__') {
        this.demolishMode = !this.demolishMode;
        this.svc.app.setBuildMode(this.demolishMode ? '__demolish__' : null);
      } else {
        this.demolishMode = false;
        this.svc.app.setBuildMode(this.svc.app.view.buildMode === mode ? null : mode);
      }
      this.syncToolState();
      this.renderFooter();
      this.renderKey = '';
      return;
    }
    const card = target.closest<HTMLElement>('[data-build]');
    if (card?.dataset.build) {
      const def = this.svc.app.content.buildings[card.dataset.build];
      if (def) this.selectBuilding(def);
      return;
    }
    const act = target.closest<HTMLElement>('[data-act]')?.dataset.act;
    switch (act) {
      case 'collapse':
        this.toggleCollapsed();
        break;
      case 'toggle-locked':
        this.showLocked = !this.showLocked;
        this.root.querySelector('[data-js="lockedbtn"]')?.classList.toggle('is-active', !this.showLocked);
        this.renderList(true);
        break;
      case 'clear-search':
        this.searchInput.value = '';
        this.search = '';
        (this.root.querySelector('[data-act="clear-search"]') as HTMLElement | null)?.setAttribute('hidden', '');
        this.renderList(true);
        this.searchInput.focus();
        break;
      case 'cancel-tool':
        this.cancelTool();
        this.renderKey = '';
        break;
      default:
        break;
    }
  };
}
