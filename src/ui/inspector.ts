/**
 * Right-hand contextual inspector: tile, building, citizen and the settlement
 * overview tab. Rebuilds only when the meaningful state signature changes so
 * hovers, tooltips and focus survive the 4 Hz refresh.
 */
import type {
  Building,
  BuildingDef,
  Citizen,
  ResourceId,
  Settlement,
} from '../sim/types';
import { buildingById, citizenById, completeBuildingsOf, dateLabel, livingCitizens, modOfState, yearOf } from '../sim/core';
import { icon } from './icons';
import {
  buildingStatusText,
  buildingStatusTone,
  citizenClassOf,
  classTone,
  conditionText,
  costChips,
  deltaText,
  emptyState,
  esc,
  escAttr,
  fmt,
  fmtInt,
  foodStockUnits,
  gauge,
  iconHtml,
  meter,
  modChips,
  modLines,
  needsOf,
  pct,
  pct100,
  pretty,
  professionIcon,
  professionLabel,
  scoreTone,
  sectionTitle,
  selectedSettlement,
  skillLabel,
  sortStockRows,
  stateOf,
  tip,
  tipText,
  toneClass,
  type Services,
} from './util';

type InspectorTab = 'inspect' | 'settlement';

const PRIORITIES = [
  { value: 0, label: 'Low', tip: 'Low priority — jobs here are filled last.' },
  { value: 1, label: 'Normal', tip: 'Normal priority — default assignment.' },
  { value: 2, label: 'High', tip: 'High priority — workers come here before normal jobs.' },
  { value: 3, label: 'Critical', tip: 'Critical — workers and inputs are routed here first.' },
];

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class Inspector {
  readonly root: HTMLElement;
  private body!: HTMLElement;
  private tabsHost!: HTMLElement;
  private titleHost!: HTMLElement;
  private eyebrowHost!: HTMLElement;
  private tab: InspectorTab = 'inspect';
  private signature = '';
  private lastSelection = '';
  private confirmDemolish = -1;
  private collapsed = false;
  private refreshBudget = 0;

  constructor(private readonly svc: Services) {
    this.root = document.createElement('aside');
    this.root.className = 'fh-inspector';
    this.root.setAttribute('aria-label', 'Inspector');
    this.root.innerHTML = `
      <div class="fh-panel-head fh-inspector-head">
        <div class="fh-panel-titles">
          <span class="fh-eyebrow" data-js="eyebrow">Selected</span>
          <h2 class="display" data-js="title">Settlement</h2>
        </div>
        <div class="fh-head-actions">
          <button type="button" class="fh-iconbtn is-quiet clickable" data-act="collapse" aria-label="Collapse inspector" ${tipText('Collapse the inspector')}>${icon('chevron_right', 'fh-icon is-small')}</button>
        </div>
      </div>
      <div class="fh-inspector-tabs" data-js="tabs" role="tablist">
        <button type="button" role="tab" class="fh-itab clickable is-active" data-tab="inspect">${icon('eye', 'fh-icon is-tiny')}<span>Inspect</span></button>
        <button type="button" role="tab" class="fh-itab clickable" data-tab="settlement">${icon('flag', 'fh-icon is-tiny')}<span>Settlement</span></button>
      </div>
      <div class="fh-inspector-body" data-js="body" role="tabpanel"></div>
    `;
    this.body = this.root.querySelector('[data-js="body"]') as HTMLElement;
    this.tabsHost = this.root.querySelector('[data-js="tabs"]') as HTMLElement;
    this.titleHost = this.root.querySelector('[data-js="title"]') as HTMLElement;
    this.eyebrowHost = this.root.querySelector('[data-js="eyebrow"]') as HTMLElement;
    this.root.addEventListener('click', this.onClick);
    this.root.addEventListener('input', this.onSlider);
    this.root.addEventListener('change', this.onSlider);
  }

  destroy(): void {
    this.root.removeEventListener('click', this.onClick);
    this.root.removeEventListener('input', this.onSlider);
    this.root.removeEventListener('change', this.onSlider);
  }

  private onSlider = (ev: Event): void => {
    const input = ev.target;
    if (!(input instanceof HTMLInputElement)) return;
    const key = input.dataset.governor;
    if (!key) return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    if (key === 'importUrgency') this.svc.app.setGovernor({ importUrgency: value });
    else if (key === 'reserveFoodDays') this.svc.app.setGovernor({ reserveFoodDays: value });
    this.signature = '';
  };

  toggleCollapsed(): void {
    this.collapsed = !this.collapsed;
    this.root.classList.toggle('is-collapsed', this.collapsed);
    const btn = this.root.querySelector<HTMLElement>('[data-act="collapse"]');
    if (btn) btn.innerHTML = icon(this.collapsed ? 'chevron_left' : 'chevron_right', 'fh-icon is-small');
  }

  refresh(force = false): void {
    const app = this.svc.app;
    const s = stateOf(this.svc);
    const view = app.view;
    const st = selectedSettlement(this.svc);
    const b = view.selectedBuildingId >= 0 ? buildingById(s, view.selectedBuildingId) : null;
    const citizen = view.selectedCitizenId >= 0 ? citizenById(s, view.selectedCitizenId) : null;
    const selectionKey = b ? `b:${b.id}:${b.progress >= 1 ? '1' : '0'}` : citizen ? `c:${citizen.id}` : view.selectedTile >= 0 ? `t:${view.selectedTile}` : `s:${st?.id ?? -1}`;
    if (selectionKey !== this.lastSelection) {
      this.lastSelection = selectionKey;
      if (b || citizen || view.selectedTile >= 0) this.tab = 'inspect';
    }
    this.updateTabs(!!(b || citizen || view.selectedTile >= 0));
    const sig = this.makeSignature(b, citizen, st);
    // Rebuild at most every other refresh unless the selection changed.
    if (!force && sig === this.signature && ++this.refreshBudget < 2) return;
    this.refreshBudget = 0;
    if (!force && sig === this.signature) return;
    this.signature = sig;
    this.render(b, citizen, st);
  }

  private updateTabs(hasSelection: boolean): void {
    for (const btn of this.tabsHost.querySelectorAll<HTMLElement>('[data-tab]')) {
      const active = btn.dataset.tab === this.tab && (btn.dataset.tab === 'settlement' || hasSelection);
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
      if (btn.dataset.tab === 'inspect') {
        btn.classList.toggle('is-disabled', !hasSelection);
        btn.setAttribute('aria-disabled', String(!hasSelection));
      }
    }
  }

  private makeSignature(b: Building | null, citizen: Citizen | null, st: Settlement | null): string {
    const s = stateOf(this.svc);
    const view = this.svc.app.view;
    const parts: (string | number)[] = [this.tab, view.selectedSettlementId, s.tick >> 2, this.confirmDemolish];
    if (this.tab === 'inspect') {
      if (b) {
        parts.push('b', b.id, Math.round(b.progress * 20), b.enabled ? 1 : 0, b.active ? 1 : 0, b.priority, Math.round(b.workers), Math.round(b.efficiency * 20), Math.round(b.condition * 20), b.recipeId ?? '', b.status, Math.round(b.sourceStrength * 10));
      } else if (citizen) {
        parts.push('c', citizen.id, citizen.alive ? 1 : 0, citizen.jobBuildingId, citizen.homeBuildingId, Math.round(citizen.health), Math.round(citizen.morale), citizen.profession, citizen.traits.length);
      } else {
        parts.push('t', view.selectedTile);
        const t = s.world.tiles[view.selectedTile];
        if (t) parts.push(t.buildingId, t.road, t.settlementId, t.siteIndex, t.deposit?.amount ?? -1, Math.round(t.pollution * 20));
      }
    } else if (st) {
      parts.push('s', st.id, st.population, st.workforce, st.unemployed, st.homeless, Math.round(st.storageUsed), Math.round(st.morale), st.alerts.length, st.buildings.length, Math.round(st.foodDays), Math.round(st.treasury));
    }
    return parts.join('|');
  }

  // -------------------------------------------------------------------------
  // Render dispatch
  // -------------------------------------------------------------------------

  private render(b: Building | null, citizen: Citizen | null, st: Settlement | null): void {
    const s = stateOf(this.svc);
    const view = this.svc.app.view;
    if (this.tab === 'settlement') {
      this.eyebrowHost.textContent = 'Settlement';
      this.titleHost.textContent = st?.name ?? 'No settlement';
      this.body.innerHTML = st ? this.renderSettlement(st) : emptyState('No settlement', 'Found a settlement to see its ledgers.', 'flag');
      return;
    }
    if (b) {
      this.eyebrowHost.textContent = 'Building';
      this.titleHost.textContent = this.defOf(b)?.name ?? 'Building';
      this.body.innerHTML = this.renderBuilding(b);
      return;
    }
    if (citizen) {
      this.eyebrowHost.textContent = 'Citizen';
      this.titleHost.textContent = `${citizen.name} ${citizen.surname}`;
      this.body.innerHTML = this.renderCitizen(citizen);
      return;
    }
    const tile = view.selectedTile >= 0 ? s.world.tiles[view.selectedTile] : null;
    if (tile) {
      this.eyebrowHost.textContent = 'Terrain';
      this.titleHost.textContent = this.svc.app.content.biomes[tile.biome]?.name ?? pretty(tile.biome);
      this.body.innerHTML = this.renderTile(view.selectedTile);
      return;
    }
    this.eyebrowHost.textContent = 'Settlement';
    this.titleHost.textContent = st?.name ?? 'Settlement';
    this.body.innerHTML = st ? this.renderSettlement(st) : emptyState('Nothing selected', 'Click the map to inspect terrain, buildings or people.', 'eye');
  }

  private defOf(b: Building): BuildingDef | null {
    return this.svc.app.content.buildings[b.typeId] ?? null;
  }

  // -------------------------------------------------------------------------
  // Tile
  // -------------------------------------------------------------------------

  private renderTile(idx: number): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const w = s.world;
    const x = idx % w.width;
    const y = Math.floor(idx / w.width);
    const t = w.tiles[idx];
    if (!t) return emptyState('Unknown ground', 'That tile is beyond the map.');
    const biome = c.biomes[t.biome];
    const claimedBy = t.settlementId >= 0 ? s.settlements.find((x2) => x2.id === t.settlementId) : null;
    const building = t.buildingId >= 0 ? s.buildings.find((b) => b.id === t.buildingId) : null;
    const bdef = building ? this.defOf(building) : null;
    const site = t.siteIndex >= 0 ? w.sites[t.siteIndex] : null;
    const siteDef = site ? c.sites[site.defId] : null;
    const explored = w.explored[idx] === 1;
    const bars: [string, number, string][] = [
      ['Fertility', t.fertility, 'How well crops and orchards grow here.'],
      ['Forest', t.forest, 'Tree cover — timber, forage and wildlife habitat.'],
      ['Water', t.water, 'Fresh water available within this tile.'],
      ['Forage', t.forage, 'Wild food abundance.'],
      ['Wildlife', t.wildlife, 'Game density for hunting.'],
      ['Beauty', t.beauty, 'Landscape quality — lifts morale of nearby homes.'],
      ['Pollution', t.pollution, 'Contamination. Harms health and soil.'],
    ];
    return `
      <div class="fh-inspect-scroll">
        <div class="fh-tile-head">
          <span class="fh-biome-swatch" style="background:${escAttr(biome?.color ?? '#777')};box-shadow:0 0 0 1px rgba(255,255,255,.12)"></span>
          <span class="fh-tile-coords">${x}, ${y}<br><small>${explored ? 'charted' : 'unknown'}</small></span>
          <span class="fh-tile-claim">${claimedBy ? icon('flag', 'fh-icon is-tiny') + esc(claimedBy.name) : icon('compass', 'fh-icon is-tiny') + 'Unclaimed'}</span>
        </div>
        ${biome ? `<p class="fh-flavor serif">${esc(biome.desc)}</p>` : ''}
        <div class="fh-bars-grid">
          ${bars
            .map(
              ([label, value, hint]) =>
                `<div class="fh-bar-cell" ${tipText(hint)}><span class="fh-bar-label">${esc(label)}</span>${meter(value, 1, { tone: label === 'Pollution' ? scoreTone((1 - value) * 100) : scoreTone(value * 100), showValue: true, valueText: pct(value) })}</div>`,
            )
            .join('')}
        </div>
        <div class="fh-tile-facts">
          <div ${tipText('Elevation above the sea')}><span>Elevation</span><b>${fmt(t.elev * 100)}%</b></div>
          <div ${tipText('Residual soil moisture')}><span>Moisture</span><b>${fmt(t.moisture * 100)}%</b></div>
          <div ${tipText('Baseline mean temperature')}><span>Mean temp</span><b>${fmt(t.temp, 1)}°C</b></div>
          <div ${tipText('Road grade on this tile')}><span>Road</span><b>${t.road > 0 ? pct(t.road) : '—'}</b></div>
        </div>
        ${
          t.deposit
            ? `<div class="fh-callout" ${tipText('A natural deposit. Mining or quarrying here extracts it.')}>
                <span class="fh-callout-icon">${icon(c.resources[t.deposit.resource]?.icon ?? 'ore', 'fh-icon is-small')}</span>
                <span><b>${esc(c.resources[t.deposit.resource]?.name ?? pretty(t.deposit.resource))} deposit</b><small>${fmtInt(t.deposit.amount)} of ${fmtInt(t.deposit.initial)} left · quality ${pct(t.deposit.quality)} · ${esc(t.deposit.kind)}</small></span>
              </div>`
            : ''
        }
        ${
          siteDef
            ? `<div class="fh-callout is-discovery" ${tipText('A site of interest. Visit it with an expedition to claim its boon.')}>
                <span class="fh-callout-icon">${icon(siteDef.icon, 'fh-icon is-small')}</span>
                <span><b>${esc(siteDef.name)}</b><small>${esc(siteDef.desc)} · ${site?.visited ? 'visited' : site?.discovered ? 'discovered' : 'undiscovered'}</small></span>
              </div>`
            : ''
        }
        ${
          building && bdef
            ? `<button type="button" class="fh-link-row clickable" data-act="select-building" data-building="${building.id}" ${tipText('Open this building in the inspector')}>
                ${icon(bdef.visual?.icon ?? 'hammer', 'fh-icon is-small')}<span><b>${esc(bdef.name)}</b><small>${esc(buildingStatusText(building))}</small></span>${icon('chevron_right', 'fh-icon is-tiny')}
              </button>`
            : ''
        }
        <div class="fh-action-row">
          <button type="button" class="fh-btn is-quiet clickable" data-act="plant-here" ${tipText('Plant saplings around this tile — 1.5 wood · 0.5 fiber')}>${icon('seed', 'fh-icon is-tiny')} Plant trees</button>
          <button type="button" class="fh-btn is-quiet clickable" data-act="road-here" ${tipText('Lay a road on this tile — 1 stone · 0.5 wood')}>${icon('road', 'fh-icon is-tiny')} Road here</button>
          <button type="button" class="fh-btn is-quiet clickable" data-act="build-here" ${tipText('Open construction and place a building on this tile')}>${icon('hammer', 'fh-icon is-tiny')} Build here</button>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Building
  // -------------------------------------------------------------------------

  private renderBuilding(b: Building): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const def = this.defOf(b);
    if (!def) return emptyState('Unknown building', 'This structure is not in the content set.');
    const st = s.settlements.find((x) => x.id === b.settlementId) ?? null;
    const recipe = b.recipeId ? c.recipes[b.recipeId] : null;
    const statusTone = buildingStatusTone(b);
    const workersNeeded = def.jobs.reduce((n, j) => n + j.count, 0);
    const inputs = recipe ? Object.entries(recipe.inputs).filter(([, v]) => v > 0) : [];
    const outputs = recipe ? Object.entries(recipe.outputs).filter(([, v]) => v > 0) : [];
    const eff = Math.max(0.02, b.efficiency);
    const crewRatio = recipe && recipe.workers > 0 ? clamp01(b.workers / recipe.workers) : 1;
    const flowFactor = b.progress >= 1 && b.enabled && b.active ? eff * crewRatio : 0;
    const stock = st?.stock ?? {};
    const flowRow = (res: ResourceId, amount: number, outbound: boolean): string => {
      const resource = c.resources[res];
      const rate = amount * (flowFactor || 0);
      const have = stock[res] ?? 0;
      const days = rate > 0 && !outbound ? (have - amount) > 0 ? fmt((have) / rate) : '—' : '—';
      return `<div class="fh-flow-row" ${tipText(`${resource?.name ?? pretty(res)} — ${fmt(amount, 2)}/day at full crew. In store: ${fmt(have, 1)}.`)}>
        <span class="fh-flow-name">${icon(resource?.icon ?? 'diamond', 'fh-icon is-tiny')}${esc(resource?.name ?? pretty(res))}</span>
        <span class="fh-flow-rate ${outbound ? 'is-bad' : 'is-good'}">${outbound ? '−' : '+'}${fmt(rate, 2)}/d</span>
        <span class="fh-flow-have">${fmt(have, 1)}<small>${days !== '—' ? ` · ${days}d` : ''}</small></span>
      </div>`;
    };
    return `
      <div class="fh-inspect-scroll">
        <div class="fh-b-head">
          <span class="fh-b-icon" style="--fh-accent:${escAttr(def.visual?.accent ?? '#c9a55b')}">${icon(def.visual?.icon ?? 'hammer', 'fh-icon')}</span>
          <span class="fh-b-headtext">
            <span class="fh-b-cat">${esc(pretty(def.category))} · Era ${def.era + 1}</span>
            <span class="fh-b-status ${statusTone}"><i></i>${esc(buildingStatusText(b))}</span>
          </span>
        </div>
        <p class="fh-flavor serif">“${esc(def.flavor || def.desc)}”</p>
        ${
          b.progress < 1
            ? `<div class="fh-construct"><div class="fh-construct-head"><span>Under construction</span><b>${pct(b.progress)}</b></div>${meter(b.progress, 1, { tone: 'is-warn' })}</div>`
            : ''
        }
        <div class="fh-quickgrid">
          <div ${tipText('Workers assigned / jobs available. Assign workers by raising this building’s priority.')}><span>Workers</span><b>${b.workers}<small>/${workersNeeded}</small></b></div>
          <div ${tipText('Production efficiency — skill, morale, condition, inputs and road access.')}><span>Efficiency</span><b class="${scoreTone(b.efficiency * 100)}">${pct(b.efficiency)}</b></div>
          <div ${tipText('Structural condition. Repairs are automatic when the governor allows.')}><span>Condition</span><b class="${scoreTone(b.condition * 100)}">${pct(b.condition)}</b></div>
          <div ${tipText('Gather source strength of the surrounding land.')}><span>Source</span><b>${pct(b.sourceStrength)}</b></div>
        </div>
        ${meter(b.efficiency, 1, { tone: scoreTone(b.efficiency * 100) })}
        ${
          recipe
            ? `<div class="fh-recipe">
                <div class="fh-recipe-head">
                  <span class="fh-mini-head">Recipe</span>
                  <span class="fh-recipe-name">${esc(recipe.name)}</span>
                </div>
                <div class="fh-recipe-picker">
                  ${def.recipes
                    .map((rid) => {
                      const r = c.recipes[rid];
                      if (!r) return '';
                      const locked = r.requiresTech?.some((t) => !s.research.completed[t]) ?? false;
                      return `<button type="button" class="fh-recipe-btn clickable ${b.recipeId === rid ? 'is-active' : ''} ${locked ? 'is-locked' : ''}" data-act="recipe" data-recipe="${escAttr(rid)}" ${tipText(locked ? `Requires ${(r.requiresTech ?? []).map((t) => c.techs[t]?.name ?? t).join(', ')}` : `${r.desc ?? r.name} — ${fmt(r.workers)} workers`)}>${esc(r.name)}</button>`;
                    })
                    .join('')}
                </div>
                ${recipe.desc ? `<p class="fh-recipe-desc">${esc(recipe.desc)}</p>` : ''}
              </div>
              <div class="fh-flows">
                <div class="fh-flow-col">${sectionTitle('Consumes', `${fmt(recipe.workers)} crew`)}${inputs.length ? inputs.map(([res, amount]) => flowRow(res, amount, true)).join('') : '<span class="fh-faint fh-small">Nothing</span>'}</div>
                <div class="fh-flow-col">${sectionTitle('Produces', flowFactor ? `${pct(eff)} eff.` : 'paused')}${outputs.length ? outputs.map(([res, amount]) => flowRow(res, amount, false)).join('') : '<span class="fh-faint fh-small">Gathered from the land</span>'}</div>
              </div>`
            : ''
        }
        ${
          Object.keys(b.shortages ?? {}).length
            ? `<div class="fh-callout is-warn">${icon('warning', 'fh-icon is-small')}<span><b>Input shortage</b><small>${Object.entries(b.shortages)
                .map(([res, amount]) => `${esc(c.resources[res]?.name ?? pretty(res))}: ${fmt(amount, 1)} short`)
                .join(' · ')}</small></span></div>`
            : ''
        }
        <div class="fh-section-block">
          ${sectionTitle('Effects', modChips(def.effects, 6))}
          <div class="fh-statlist">
            ${def.housing ? `<div><span>Housing</span><b>${def.housing.capacity} beds · quality ${fmt(def.housing.quality, 1)}</b></div>` : ''}
            ${def.storage ? `<div><span>Storage</span><b>+${fmt(def.storage)}</b></div>` : ''}
            ${def.pollution ? `<div><span>Pollution</span><b class="is-bad">${fmt(def.pollution, 1)}/day</b></div>` : ''}
            ${def.beauty ? `<div><span>Beauty</span><b class="${def.beauty > 0 ? 'is-good' : 'is-bad'}">${fmt(def.beauty, 1)}</b></div>` : ''}
            ${def.waterUse ? `<div><span>Water use</span><b>${fmt(def.waterUse, 1)}/day</b></div>` : ''}
            ${def.energyUse ? `<div><span>Energy use</span><b>${fmt(def.energyUse, 1)}/day</b></div>` : ''}
            ${def.upgradeTo ? `<div><span>Upgrades to</span><b>${esc(c.buildings[def.upgradeTo]?.name ?? pretty(def.upgradeTo))}</b></div>` : ''}
          </div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Priority', PRIORITIES[b.priority]?.label ?? 'Normal')}
          <div class="fh-seg" role="group" aria-label="Building priority">
            ${PRIORITIES.map((p) => `<button type="button" class="fh-seg-btn clickable ${b.priority === p.value ? 'is-active' : ''}" data-act="priority" data-priority="${p.value}" aria-pressed="${b.priority === p.value}" ${tipText(p.tip)}>${esc(p.label)}</button>`).join('')}
          </div>
        </div>
        <div class="fh-action-row">
          <button type="button" class="fh-btn ${b.enabled ? 'is-quiet' : 'is-good'} clickable" data-act="toggle-enabled" ${tipText(b.enabled ? 'Pause this building — saves upkeep and inputs' : 'Resume this building')}>${icon(b.enabled ? 'pause' : 'play', 'fh-icon is-tiny')} ${b.enabled ? 'Pause' : 'Resume'}</button>
          <button type="button" class="fh-btn is-quiet clickable" data-act="select-settlement" ${tipText('Open the settlement ledger')}>${icon('flag', 'fh-icon is-tiny')} Settlement</button>
          ${
            this.confirmDemolish === b.id
              ? `<span class="fh-confirm">Dismantle for ${b.progress < 1 ? '75' : '20'}% refund? <button class="fh-btn is-bad clickable" data-act="demolish-yes">Dismantle</button><button class="fh-btn is-ghost clickable" data-act="demolish-no">Keep</button></span>`
              : `<button type="button" class="fh-btn is-ghost clickable" data-act="demolish">${icon('close', 'fh-icon is-tiny')} Dismantle</button>`
          }
        </div>
        <div class="fh-faint fh-small fh-built">Built ${yearOf(b.builtTick)} · ${esc(def.name)}</div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Citizen
  // -------------------------------------------------------------------------

  private renderCitizen(c: Citizen): string {
    const content = this.svc.app.content;
    const s = stateOf(this.svc);
    const cls = citizenClassOf(content, c);
    const needs = needsOf(c);
    const skills = Object.entries(c.skills ?? {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 7);
    const job = c.jobBuildingId >= 0 ? s.buildings.find((b) => b.id === c.jobBuildingId) : null;
    const home = c.homeBuildingId >= 0 ? s.buildings.find((b) => b.id === c.homeBuildingId) : null;
    const jobDef = job ? this.defOf(job) : null;
    const homeDef = home ? this.defOf(home) : null;
    const link = (id: number, label: string): string => {
      const other = citizenById(s, id);
      if (!other) return `<span class="fh-faint">${esc(label)}</span>`;
      return `<button type="button" class="fh-person-link clickable" data-act="select-citizen" data-citizen="${id}" ${tipText(`Inspect ${other.name} ${other.surname}`)}>${esc(other.name)} ${esc(other.surname)}</button>`;
    };
    const thoughts = (c.thoughts ?? []).slice(0, 5);
    return `
      <div class="fh-inspect-scroll">
        <div class="fh-c-head">
          <span class="fh-avatar ${c.sex === 'f' ? 'is-f' : 'is-m'}">${esc(c.name.charAt(0))}${esc(c.surname.charAt(0))}</span>
          <span class="fh-c-headtext">
            <span class="fh-c-sub">${c.alive ? `${Math.floor(c.age)} winters · ${c.sex === 'm' ? 'man' : 'woman'}` : 'Deceased'}</span>
            <span class="fh-c-chips">
              <span class="fh-chip ${classTone(cls)}">${icon(professionIcon(content, c.profession), 'fh-icon is-tiny')}${esc(professionLabel(content, c.profession))}</span>
              <span class="fh-chip is-neutral">${esc(pretty(cls))}</span>
              ${c.notable ? `<span class="fh-chip is-brass">${icon('star', 'fh-icon is-tiny')}Notable</span>` : ''}
              ${c.pregnant ? `<span class="fh-chip is-info">${icon('seed', 'fh-icon is-tiny')}Expecting</span>` : ''}
            </span>
          </span>
        </div>
        <div class="fh-vitals">
          ${vitalBar('Health', c.health, 'is-good', 'Physical condition. Illness and hunger wear it down.')}
          ${vitalBar('Morale', c.morale, 'is-brass', 'Spirits. Low morale pushes people to leave or refuse work.')}
          ${vitalBar('Hunger', c.hunger, 'is-bad', 'Hunger rises when food runs short. 100 is starvation.')}
          ${vitalBar('Thirst', c.thirst, 'is-info', 'Thirst rises without water. Deadly faster than hunger.')}
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Needs', '0–100 satisfaction')}
          <div class="fh-rings">${needs.map((n) => gauge(n.label, n.value / 100, { tone: scoreTone(n.value), hint: `${n.label}: ${fmt(n.value)}/100` })).join('')}</div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Skills', `${fmt(c.education)} education`)}
          <div class="fh-skilllist">
            ${skills
              .map(
                ([id, value]) => `<div class="fh-skillrow" ${tipText(`${skillLabel(content, id)} — ${fmt(value)}/100. Grows with practice.`)}><span>${esc(skillLabel(content, id))}</span>${meter(value, 100, { tone: 'is-brass' })}<b>${fmt(value)}</b></div>`,
              )
              .join('')}
          </div>
        </div>
        ${
          c.traits.length
            ? `<div class="fh-section-block">${sectionTitle('Traits')}<div class="fh-chipwrap">${c.traits
                .map((t) => {
                  const def = content.traits[t];
                  return `<span class="fh-trait" ${tipText(def ? `${def.name}: ${def.desc}` : pretty(t))}>${icon(def?.icon ?? 'spark', 'fh-icon is-tiny')}${esc(def?.name ?? pretty(t))}</span>`;
                })
                .join('')}</div></div>`
            : ''
        }
        ${
          thoughts.length
            ? `<div class="fh-section-block">${sectionTitle('Thoughts')}<blockquote class="fh-thoughts serif">${thoughts.map((t) => `<p>“${esc(t)}”</p>`).join('')}</blockquote></div>`
            : ''
        }
        <div class="fh-section-block">
          ${sectionTitle('Life')}
          <div class="fh-statlist">
            <div><span>Home</span><b>${homeDef ? esc(homeDef.name) : 'Homeless'}</b></div>
            <div><span>Work</span><b>${jobDef ? esc(jobDef.name) : 'Unemployed'}</b></div>
            <div><span>Wealth</span><b>${fmt(c.wealth)}</b></div>
            <div><span>Income</span><b>${fmt(c.income)}/day</b></div>
            <div><span>Origin</span><b>${esc(pretty(c.origin))}</b></div>
            <div><span>Born</span><b>Year ${yearOf(c.bornTick)}</b></div>
            ${c.deathTick >= 0 ? `<div><span>Died</span><b class="is-bad">Year ${yearOf(c.deathTick)} · ${esc(pretty(c.deathCause))}</b></div>` : ''}
          </div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Kin & friends')}
          <div class="fh-links">
            ${c.spouseId >= 0 ? `<span><em>Spouse</em>${link(c.spouseId, 'Spouse')}</span>` : ''}
            ${c.parentIds.length ? `<span><em>Parents</em>${c.parentIds.map((id) => link(id, 'parent')).join(' ')}</span>` : ''}
            ${c.childIds.length ? `<span><em>Children</em>${c.childIds.slice(0, 6).map((id) => link(id, 'child')).join(' ')}</span>` : ''}
            ${c.friendIds.length ? `<span><em>Friends</em>${c.friendIds.slice(0, 4).map((id) => link(id, 'friend')).join(' ')}</span>` : ''}
            ${!c.spouseId && !c.parentIds.length && !c.childIds.length ? '<span class="fh-faint">No recorded kin.</span>' : ''}
          </div>
        </div>
      </div>`;
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  private renderSettlement(st: Settlement): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const citizens = livingCitizens(s).filter((x) => x.settlementId === st.id);
    const children = citizens.filter((x) => x.age < 16).length;
    const elders = citizens.filter((x) => x.age >= 62).length;
    const adults = Math.max(0, citizens.length - children);
    const pop = s.settlements.reduce((n, x) => n + x.population, 0);
    const rows = sortStockRows(st, c);
    const prod = this.productionSummary(st);
    const services = this.serviceSummary(st);
    const professions = new Map<string, number>();
    for (const citizen of citizens) {
      const key = citizen.profession as string;
      professions.set(key, (professions.get(key) ?? 0) + 1);
    }
    const topProf = [...professions.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
    const stAlerts = st.alerts ?? [];
    const otherSettlements = s.settlements.filter((x) => x.id !== st.id);
    const availableTechs = c.techOrder.filter((id) => s.research.completed[id] === undefined).length;
    return `
      <div class="fh-inspect-scroll">
        <div class="fh-st-head">
          <span class="fh-st-badge">${icon(st.isCapital ? 'crown' : 'flag', 'fh-icon')}</span>
          <span class="fh-st-headtext">
            <span class="fh-st-name display">${esc(st.name)}</span>
            <span class="fh-faint fh-small">${st.isCapital ? 'Capital' : 'Settlement'} · founded year ${yearOf(st.foundedTick)}</span>
          </span>
          <span class="fh-st-pop"><b>${fmtInt(st.population)}</b><small>people</small></span>
        </div>
        ${
          otherSettlements.length
            ? `<div class="fh-chipwrap">${[st, ...otherSettlements]
                .map((x) => `<button class="fh-chip clickable ${x.id === st.id ? 'is-brass' : 'is-neutral'}" data-act="select-settlement-id" data-settlement="${x.id}" ${tipText(`Switch ledger to ${x.name}`)}>${icon('flag', 'fh-icon is-tiny')}${esc(x.name)}</button>`)
                .join('')}</div>`
            : ''
        }
        ${
          stAlerts.length
            ? `<div class="fh-alertstack">${stAlerts
                .map((a) => {
                  const fix = ALERT_FIXES[a.kind] ?? ALERT_FIXES.event;
                  return `<button type="button" class="fh-callout fh-alert-action ${a.severity >= 3 ? 'is-bad' : a.severity === 2 ? 'is-warn' : 'is-info'} clickable" data-act="alert-fix" data-kind="${escAttr(a.kind)}" ${tipText(`${fix.hint} · click to open the right panel`)}>
                    ${icon('warning', 'fh-icon is-small')}
                    <span><b>${esc(a.title)}</b><small>${esc(a.detail)} · since ${dateLabel(a.sinceTick)}</small><em>${esc(fix.hint)} →</em></span>
                  </button>`;
                })
                .join('')}</div>`
            : ''
        }
        <div class="fh-vitals fh-vitals-4">
          ${vitalBar('Morale', st.morale, 'is-brass', 'Settlement morale: how content your people are.')}
          ${vitalBar('Stability', st.stability, 'is-good', 'Order and predictability. Low stability invites crime and unrest.')}
          ${vitalBar('Housing', st.housing.capacity > 0 ? Math.min(100, (st.housing.occupied / Math.max(1, st.housing.capacity)) * 100) : 0, 'is-info', 'Housing occupancy — 100% means full homes.')}
          ${vitalBar('Storage', st.storageCap > 0 ? Math.min(100, (st.storageUsed / st.storageCap) * 100) : 0, 'is-info', 'Storehouse fill. When full, production is wasted.')}
        </div>
        <div class="fh-quickgrid">
          <div ${tipText('Those able to work')}><span>Workforce</span><b>${fmtInt(st.workforce)}</b></div>
          <div ${tipText('Would work, has no job')}><span>Idle</span><b class="${st.unemployed > 0 ? 'is-warn' : ''}">${fmtInt(st.unemployed)}</b></div>
          <div ${tipText('People without a bed')}><span>Homeless</span><b class="${st.homeless > 0 ? 'is-bad' : 'is-good'}">${fmtInt(st.homeless)}</b></div>
          <div ${tipText('Buildings standing')}><span>Buildings</span><b>${fmtInt(st.buildings.length)}</b></div>
          <div ${tipText('Coin in the settlement treasury')}><span>Treasury</span><b class="is-brass">${fmt(st.treasury)}</b></div>
          <div ${tipText('Food units in store (edible value)')}><span>Food units</span><b>${fmt(foodStockUnits(s, c, st))}</b></div>
          <div ${tipText('Insight available realm-wide')}><span>Insight</span><b class="is-info">${fmt(s.research.insight)}</b></div>
          <div ${tipText('Undiscovered technologies in this era or earlier')}><span>Codex</span><b>${fmtInt(availableTechs)} open</b></div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('People', `${fmtInt(pop)} realm-wide`)}
          <div class="fh-stackbar" ${tipText(`Children ${children} · Adults ${adults} · Elders ${elders}`)}>
            <span class="is-info" style="flex:${Math.max(0.01, adults - elders)}"></span>
            <span class="is-brass" style="flex:${Math.max(0.01, children)}"></span>
            <span class="is-neutral" style="flex:${Math.max(0.01, elders)}"></span>
          </div>
          <div class="fh-legend-row">
            <span><i class="is-info"></i>Adults ${adults}</span><span><i class="is-brass"></i>Children ${children}</span><span><i class="is-neutral"></i>Elders ${elders}</span>
          </div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Professions', `${citizens.length} detailed`)}
          ${
            topProf.length
              ? `<div class="fh-barlist">${topProf
                  .map(
                    ([prof, n]) =>
                      `<div class="fh-barrow" ${tipText(`${professionLabel(c, prof)} — ${n} people`)}><span>${icon(professionIcon(c, prof), 'fh-icon is-tiny')}${esc(professionLabel(c, prof))}</span>${meter(n, Math.max(1, topProf[0][1]), { tone: 'is-brass' })}<b>${n}</b></div>`,
                  )
                  .join('')}</div>`
              : '<p class="fh-faint fh-small">No detailed citizens in this settlement yet.</p>'
          }
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Services', 'coverage from civic buildings')}
          ${services.length ? `<div class="fh-chipwrap">${services.map((sv) => `<span class="fh-service" ${tipText(`${pretty(sv.kind)} service · strength ${fmt(sv.amount, 1)} · from ${sv.count} building${sv.count > 1 ? 's' : ''}`)}>${icon(serviceIcon(sv.kind), 'fh-icon is-tiny')}${esc(pretty(sv.kind))}<b>${fmt(sv.amount, 1)}</b></span>`).join('')}</div>` : '<p class="fh-faint fh-small">No civic services yet — build a well, school or shrine.</p>'}
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Production', 'estimated per day')}
          ${
            prod.length
              ? `<div class="fh-barlist">${prod
                  .map(
                    (row) =>
                      `<div class="fh-barrow" ${tipText(`${row.name}: about ${fmt(row.rate, 2)} per day at current efficiency`)}><span>${icon(row.icon, 'fh-icon is-tiny')}${esc(row.name)}</span><b class="is-good">+${fmt(row.rate, 2)}/d</b></div>`,
                  )
                  .join('')}</div>`
              : '<p class="fh-faint fh-small">No operating production yet.</p>'
          }
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Storehouse', `${fmt(st.storageUsed)} / ${fmt(st.storageCap)}`)}
          ${meter(st.storageUsed, Math.max(1, st.storageCap), { tone: st.storageUsed > st.storageCap * 0.92 ? 'is-warn' : 'is-good' })}
          <div class="fh-stocklist">
            ${
              rows.length
                ? rows
                    .slice(0, 12)
                    .map(
                      (row) =>
                        `<div class="fh-stockrow" ${tipText(`${c.resources[row.res]?.name ?? pretty(row.res)} — ${fmt(row.amount, 1)} in store. ${esc(c.resources[row.res]?.desc ?? '')}`)}>${icon(c.resources[row.res]?.icon ?? 'diamond', 'fh-icon is-tiny')}<span>${esc(c.resources[row.res]?.name ?? pretty(row.res))}</span><b>${fmt(row.amount, 1)}</b></div>`,
                    )
                    .join('')
                : '<p class="fh-faint fh-small">The stores are empty.</p>'
            }
            ${rows.length > 12 ? `<button class="fh-link clickable" data-act="open-market">+${rows.length - 12} more in the market</button>` : ''}
          </div>
        </div>
        <div class="fh-section-block">
          ${sectionTitle('Governor', 'automation')}
          <div class="fh-toggle-grid">
            ${governorToggle('autoAssign', 'Auto-assign jobs', st.governor.autoAssign, 'Let the governor assign workers to the highest-priority jobs.')}
            ${governorToggle('autoRepair', 'Auto-repair', st.governor.autoRepair, 'Spend materials to keep buildings in good condition.')}
            ${governorToggle('autoBuild', 'Auto-build', st.governor.autoBuild, 'Allow the governor to queue construction (not yet automated).')}
            ${governorToggle('autoTrade', 'Auto-trade', st.governor.autoTrade, 'Buy critical goods and sell surplus at the market.')}
          </div>
          <div class="fh-slider-row"><span ${tipText('How aggressively the governor imports when stocks run low')}>Import urgency</span><input type="range" min="0" max="1" step="0.05" value="${st.governor.importUrgency}" data-governor="importUrgency" aria-label="Import urgency" /></div>
          <div class="fh-slider-row"><span ${tipText('Food reserve the governor protects from sale')}>Food reserve (days)</span><input type="range" min="0" max="40" step="1" value="${st.governor.reserveFoodDays}" data-governor="reserveFoodDays" aria-label="Food reserve days" /></div>
        </div>
        <div class="fh-action-row">
          <button type="button" class="fh-btn is-quiet clickable" data-act="open-society">${icon('scale', 'fh-icon is-tiny')} Society</button>
          <button type="button" class="fh-btn is-quiet clickable" data-act="open-market">${icon('market', 'fh-icon is-tiny')} Market</button>
          <button type="button" class="fh-btn is-quiet clickable" data-act="open-people">${icon('people', 'fh-icon is-tiny')} People</button>
        </div>
      </div>`;
  }

  private productionSummary(st: Settlement): { name: string; icon: string; rate: number }[] {
    const c = this.svc.app.content;
    const totals = new Map<string, number>();
    for (const b of completeBuildingsOf(stateOf(this.svc), st.id)) {
      if (!b.enabled || !b.active) continue;
      const def = this.defOf(b);
      const recipe = b.recipeId ? c.recipes[b.recipeId] : null;
      if (!def || !recipe) continue;
      const crew = recipe.workers > 0 ? Math.min(1, b.workers / recipe.workers) : 1;
      const factor = b.efficiency * crew;
      for (const [res, amount] of Object.entries(recipe.outputs)) {
        totals.set(res, (totals.get(res) ?? 0) + amount * factor);
      }
      if (recipe.gather) {
        const res = recipe.gather.resource;
        totals.set(res, (totals.get(res) ?? 0) + recipe.gather.rate * factor * Math.max(0.2, b.sourceStrength));
      }
    }
    return [...totals.entries()]
      .filter(([, rate]) => rate > 0.001)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([res, rate]) => ({
        name: c.resources[res]?.name ?? pretty(res),
        icon: c.resources[res]?.icon ?? 'diamond',
        rate,
      }));
  }

  private serviceSummary(st: Settlement): { kind: string; amount: number; count: number }[] {
    const c = this.svc.app.content;
    const map = new Map<string, { amount: number; count: number }>();
    for (const b of completeBuildingsOf(stateOf(this.svc), st.id)) {
      const def = this.defOf(b);
      if (!def?.service) continue;
      const entry = map.get(def.service.kind) ?? { amount: 0, count: 0 };
      entry.amount += def.service.amount * Math.max(0.3, b.efficiency);
      entry.count += 1;
      map.set(def.service.kind, entry);
    }
    return [...map.entries()].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.amount - a.amount);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private onClick = (ev: MouseEvent): void => {
    const target = ev.target instanceof Element ? ev.target : null;
    if (!target) return;
    const tab = target.closest<HTMLElement>('[data-tab]');
    if (tab) {
      if (tab.dataset.tab === 'inspect' && this.tabsHost.querySelector('.fh-itab.is-disabled')) return;
      this.tab = (tab.dataset.tab as InspectorTab) ?? 'inspect';
      this.signature = '';
      this.refresh(true);
      return;
    }
    const actEl = target.closest<HTMLElement>('[data-act]');
    if (!actEl) return;
    const act = actEl.dataset.act;
    const app = this.svc.app;
    const s = stateOf(this.svc);
    switch (act) {
      case 'collapse':
        this.toggleCollapsed();
        break;
      case 'select-building': {
        const id = Number(actEl.dataset.building);
        if (Number.isFinite(id)) app.selectBuilding(id);
        break;
      }
      case 'select-citizen': {
        const id = Number(actEl.dataset.citizen);
        if (Number.isFinite(id)) app.selectCitizen(id);
        break;
      }
      case 'select-settlement':
        this.tab = 'settlement';
        this.signature = '';
        this.refresh(true);
        break;
      case 'select-settlement-id':
        app.selectSettlement(Number(actEl.dataset.settlement));
        this.signature = '';
        this.refresh(true);
        break;
      case 'recipe': {
        const rid = actEl.dataset.recipe;
        if (rid) app.setBuildingRecipe(app.view.selectedBuildingId, rid);
        break;
      }
      case 'priority':
        app.setBuildingPriority(app.view.selectedBuildingId, Number(actEl.dataset.priority));
        this.signature = '';
        this.refresh(true);
        break;
      case 'toggle-enabled':
        app.toggleBuilding(app.view.selectedBuildingId);
        this.signature = '';
        this.refresh(true);
        break;
      case 'demolish':
        this.confirmDemolish = app.view.selectedBuildingId;
        this.signature = '';
        this.refresh(true);
        break;
      case 'demolish-yes':
        if (this.confirmDemolish >= 0) {
          app.demolish(this.confirmDemolish);
          this.confirmDemolish = -1;
          this.signature = '';
          this.refresh(true);
        }
        break;
      case 'demolish-no':
        this.confirmDemolish = -1;
        this.signature = '';
        this.refresh(true);
        break;
      case 'plant-here': {
        const idx = app.view.selectedTile;
        if (idx >= 0) {
          const x = idx % s.world.width;
          const y = Math.floor(idx / s.world.width);
          app.plantForest(x, y);
        }
        break;
      }
      case 'road-here': {
        const idx = app.view.selectedTile;
        if (idx >= 0) app.placeRoad(idx % s.world.width, Math.floor(idx / s.world.width));
        break;
      }
      case 'build-here':
        this.svc.openPanel('objectives');
        break;
      case 'open-society':
        this.svc.openPanel('society');
        break;
      case 'open-market':
        this.svc.openPanel('market');
        break;
      case 'open-people':
        this.svc.openPanel('people');
        break;
      case 'alert-fix': {
        const kind = actEl.dataset.kind ?? 'event';
        const fix = ALERT_FIXES[kind] ?? ALERT_FIXES.event;
        if (fix.panel) this.svc.openPanel(fix.panel);
        else this.svc.focusBuild(fix.buildCategory ?? null);
        break;
      }
      case 'governor': {
        const key = actEl.dataset.governorKey as 'autoAssign' | 'autoRepair' | 'autoBuild' | 'autoTrade' | undefined;
        if (!key) break;
        const current = selectedSettlement(this.svc)?.governor[key] ?? false;
        this.svc.app.setGovernor({ [key]: !current });
        this.signature = '';
        this.refresh(true);
        break;
      }
      default:
        break;
    }
  };
}

interface AlertFix {
  hint: string;
  panel?: 'society' | 'market' | 'codex' | 'objectives' | 'almanac' | 'expeditions';
  buildCategory?: string | null;
}

const ALERT_FIXES: Record<string, AlertFix> = {
  food: { hint: 'Build farms, a granary or forage further', buildCategory: 'food' },
  water: { hint: 'Dig a well or lay an aqueduct', buildCategory: 'water' },
  housing: { hint: 'Raise more homes', buildCategory: 'housing' },
  jobs: { hint: 'Add workplaces, or pause a low-priority site', buildCategory: 'industry' },
  pollution: { hint: 'Add beauty or move industry', buildCategory: 'beauty' },
  health: { hint: 'Build a clinic and improve rations', panel: 'society' },
  security: { hint: 'Fund order through policy', panel: 'society' },
  economy: { hint: 'Open the market and trade', panel: 'market' },
  ecology: { hint: 'Study the land in the almanac', panel: 'almanac' },
  event: { hint: 'Read the warnings and decide', panel: 'objectives' },
};

function vitalBar(label: string, value: number, tone: string, hint: string): string {
  return `<div class="fh-vital" ${tipText(hint)}><span class="fh-vital-label">${esc(label)}</span>${meter(value, 100, { tone: tone + '', showValue: true, valueText: fmt(value) })}</div>`;
}

function governorToggle(key: string, label: string, on: boolean, hint: string): string {
  return `<button type="button" class="fh-toggle clickable ${on ? 'is-on' : ''}" data-act="governor" data-governor-key="${escAttr(key)}" aria-pressed="${on}" ${tipText(hint)}>${icon(on ? 'check' : 'dot', 'fh-icon is-tiny')}<span>${esc(label)}</span></button>`;
}

function serviceIcon(kind: string): string {
  switch (kind) {
    case 'water':
      return 'drop';
    case 'health':
      return 'heart';
    case 'education':
      return 'school';
    case 'culture':
      return 'culture';
    case 'safety':
      return 'shield';
    case 'trade':
      return 'scale';
    case 'faith':
      return 'shrine';
    default:
      return 'spark';
  }
}

// Keep a reference to helpers used above (tree-shaking guard for unused imports).
void costChips;
void deltaText;
void conditionText;
void modLines;
void toneClass;
void pct100;
void clamp01;
void escAttr;
void iconHtml;
void fmtInt;
