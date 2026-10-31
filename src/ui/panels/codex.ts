/**
 * Codex: the technology tree in branch columns, era bands, doctrine offers and
 * a compact summary of insight + affinity.
 */
import type { DoctrineDef, TechDef } from '../../sim/types';
import { hasTech, techAvailable, techRequirementsMet } from '../../sim/core';
import { icon } from '../icons';
import {
  chip,
  modChips,
  modLines,
  pct,
  roman,
  signed,
  stateOf,
  tip,
  tipText,
  toneClass,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

type Filter = 'all' | 'available' | 'era' | 'done';

export class CodexPanel implements GamePanel {
  readonly id = 'codex' as const;
  readonly subtitle = 'Knowledge, its branches and its cost';
  private filter: Filter = 'available';
  private branchFocus: string | null = null;

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Codex';
  }

  title(): string {
    return 'Discoveries';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const insight = s.research.insight;
    const era = s.research.era;
    const completed = Object.keys(s.research.completed).length;
    const available = c.techOrder.filter((id) => techAvailable(s, c, id));
    const eraDef = c.eras[era];
    const doctrine = s.research.doctrine ? c.doctrines[s.research.doctrine] : null;
    const offers = (s.research.doctrineChoices ?? []).map((id) => c.doctrines[id]).filter(Boolean) as DoctrineDef[];

    const branches = Object.values(c.branches);
    const affinityMax = Math.max(1, ...branches.map((b) => s.research.affinity[b.id] ?? 0));

    return `
      <div class="fh-gp-scroll">
        <div class="fh-codex-summary">
          <div class="fh-sum-card" ${tipText('Insight is produced by scholars, teachers and curious minds.')}>
            <span class="fh-sum-label">${icon('star', 'fh-icon is-tiny')} Insight</span>
            <b>${signed(insight, 0).replace('+', '')}</b>
            <small>${insight >= (available[0] ? c.techs[available[0]].cost : 0) ? `${available.length} discoveries within reach` : 'accumulating'}</small>
          </div>
          <div class="fh-sum-card" ${tipText('Your era sets which discoveries are within contemplation.')}>
            <span class="fh-sum-label">${icon('era', 'fh-icon is-tiny')} Era</span>
            <b>${roman(era + 1)}</b>
            <small>${eraDef?.name ?? 'Unknown age'}</small>
          </div>
          <div class="fh-sum-card">
            <span class="fh-sum-label">${icon('book', 'fh-icon is-tiny')} Discovered</span>
            <b>${completed}</b>
            <small>${available.length} available now</small>
          </div>
          <div class="fh-sum-card" ${tipText('A creed shapes the whole of your civilisation. One may be chosen per era.')}>
            <span class="fh-sum-label">${icon('doctrine', 'fh-icon is-tiny')} Creed</span>
            <b class="is-small">${doctrine ? doctrine.name : offers.length ? 'Unchosen' : '—'}</b>
            <small>${doctrine ? doctrine.motto : offers.length ? 'three paths offered' : 'no offer yet'}</small>
          </div>
        </div>

        ${
          offers.length && !doctrine
            ? panelSection(
                'A creed is offered',
                `<p class="fh-gp-lede serif">Your people have grown numerous enough to ask what they are for. Choose the shape of their belief — this choice colours everything that follows.</p>
                 <div class="fh-doctrine-grid">${offers.map((d) => this.doctrineCard(d, false)).join('')}</div>`,
                `${offers.length} paths`,
              )
            : ''
        }
        ${doctrine ? panelSection('The creed you walk', this.doctrineCard(doctrine, true)) : ''}

        <div class="fh-codex-toolbar">
          <div class="fh-seg" role="group" aria-label="Discovery filter">
            ${(
              [
                ['available', 'Available'],
                ['all', 'All'],
                ['era', 'This era'],
                ['done', 'Discovered'],
              ] as [Filter, string][]
            )
              .map(([key, label]) => `<button type="button" class="fh-seg-btn clickable ${this.filter === key ? 'is-active' : ''}" data-act="filter" data-filter="${key}" aria-pressed="${this.filter === key}">${label}</button>`)
              .join('')}
          </div>
          <div class="fh-branch-affinity">
            ${branches
              .map((b) => {
                const affinity = s.research.affinity[b.id] ?? 0;
                return `<button type="button" class="fh-affinity clickable ${this.branchFocus === b.id ? 'is-active' : ''}" data-act="focus-branch" data-branch="${b.id}" aria-pressed="${this.branchFocus === b.id}" ${tipText(`${b.name}: ${affinity} discoveries${this.branchFocus === b.id ? ' · click to show all branches' : ' · click to focus'}`)}>
                  <span class="fh-affinity-dot" style="background:${b.color}"></span><span>${b.name}</span>
                  <span class="fh-affinity-bar"><i style="width:${Math.round((affinity / affinityMax) * 100)}%;background:${b.color}"></i></span>
                </button>`;
              })
              .join('')}
          </div>
        </div>

        <div class="fh-codex-columns ${this.branchFocus ? 'is-focused' : ''}">
          ${branches
            .filter((b) => !this.branchFocus || b.id === this.branchFocus)
            .map((b) => this.branchColumn(b.id, b.name, b.color, b.desc, b.icon))
            .join('')}
        </div>
      </div>`;
  }

  private doctrineCard(d: DoctrineDef, chosen: boolean): string {
    return `<div class="fh-doctrine ${chosen ? 'is-chosen' : ''}" style="--fh-doctrine:${d.color}">
      <div class="fh-doctrine-head">
        <span class="fh-doctrine-icon" style="color:${d.color}">${icon(d.icon, 'fh-icon')}</span>
        <span><b class="display">${d.name}</b><small class="serif">“${d.motto}”</small></span>
      </div>
      <p class="fh-doctrine-desc">${d.desc}</p>
      <div class="fh-doctrine-mods">${modChips(d.effects, 5)}</div>
      <ul class="fh-doctrine-bonus">${d.bonusText.map((b) => `<li>${b}</li>`).join('')}</ul>
      ${chosen ? `<div class="fh-doctrine-foot">${icon('check', 'fh-icon is-tiny')} The creed of your people</div>` : `<button type="button" class="fh-btn is-ember clickable" data-act="doctrine" data-doctrine="${d.id}">${icon('crown', 'fh-icon is-tiny')} Adopt this creed</button>`}
    </div>`;
  }

  private branchColumn(id: string, name: string, color: string, desc: string, iconName: string): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const techs = c.techOrder.map((tid) => c.techs[tid]).filter((t): t is TechDef => !!t && t.branch === id);
    const filtered = techs.filter((t) => {
      if (this.filter === 'available') return techAvailable(s, c, t.id);
      if (this.filter === 'era') return t.era === s.research.era;
      if (this.filter === 'done') return hasTech(s, t.id);
      return true;
    });
    const byEra = new Map<number, TechDef[]>();
    for (const t of filtered) {
      const list = byEra.get(t.era) ?? [];
      list.push(t);
      byEra.set(t.era, list);
    }
    const eras = [...byEra.keys()].sort((a, b) => a - b);
    const doneCount = techs.filter((t) => hasTech(s, t.id)).length;
    return `<section class="fh-branch" data-branch="${id}" style="--fh-branch:${color}">
      <header class="fh-branch-head" ${tipText(desc)}>
        <span class="fh-branch-icon" style="color:${color}">${icon(iconName, 'fh-icon is-small')}</span>
        <span class="fh-branch-title"><b class="display">${name}</b><small>${doneCount}/${techs.length} discovered</small></span>
      </header>
      <div class="fh-branch-body">
        ${
          eras.length
            ? eras
                .map(
                  (era) => `<div class="fh-era-band"><span class="fh-era-label">Era ${roman(era + 1)}</span></div>
                    ${(byEra.get(era) ?? []).map((t) => this.techCard(t)).join('')}`,
                )
                .join('')
            : `<div class="fh-branch-empty">${this.filter === 'available' ? 'Nothing available in this branch right now.' : this.filter === 'done' ? 'Nothing yet discovered here.' : 'Nothing in this era.'}</div>`
        }
      </div>
    </section>`;
  }

  private techCard(t: TechDef): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const done = hasTech(s, t.id);
    const available = techAvailable(s, c, t.id);
    const affordable = s.research.insight >= t.cost;
    const missing = t.requires.filter((r) => !hasTech(s, r));
    const state = done ? 'done' : available ? 'available' : 'locked';
    const effects = modLines(t.effects, 3);
    const unlocks = (t.unlocksBuildings ?? []).map((b) => c.buildings[b]?.name).filter(Boolean);
    return `<button type="button" class="fh-tech is-${state} ${available && affordable ? 'is-affordable' : ''} clickable" data-act="tech" data-tech="${t.id}" ${tip(this.techTip(t))}>
      <span class="fh-tech-top">
        <span class="fh-tech-name">${done ? icon('check', 'fh-icon is-tiny') : available ? icon('spark', 'fh-icon is-tiny') : icon('lock', 'fh-icon is-tiny')}${t.name}</span>
        <span class="fh-tech-cost ${affordable ? '' : 'is-short'}">${icon('star', 'fh-icon is-tiny')}${Math.round(t.cost)}</span>
      </span>
      <span class="fh-tech-effects">${effects.map((e) => `<span class="${e.good ? 'is-good' : 'is-bad'}">${e.label} ${signed(e.value * 100, 0)}%</span>`).join('')}</span>
      ${
        state === 'locked'
          ? `<span class="fh-tech-need">needs ${missing.map((r) => c.techs[r]?.name ?? r).join(', ') || `era ${roman(t.era + 1)}`}</span>`
          : unlocks.length
            ? `<span class="fh-tech-unlocks">${icon('hammer', 'fh-icon is-tiny')}${unlocks.slice(0, 2).join(', ')}</span>`
            : `<span class="fh-tech-flavor serif">${t.flavor ? `“${t.flavor}”` : ''}</span>`
      }
    </button>`;
  }

  private techTip(t: TechDef): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const done = hasTech(s, t.id);
    const missing = t.requires.filter((r) => !hasTech(s, r));
    const unlocks = (t.unlocksBuildings ?? []).map((b) => c.buildings[b]?.name).filter(Boolean);
    const policies = (t.unlocksPolicies ?? []).map((p) => c.policies[p]?.name).filter(Boolean);
    return `<div class="fh-tip-head">${icon('book', 'fh-icon is-small')} ${t.name}</div>
      <div class="fh-tip-body">${t.desc}</div>
      ${t.flavor ? `<div class="fh-tip-flavor serif">“${t.flavor}”</div>` : ''}
      <div class="fh-tip-grid">
        <span>Cost</span><b>${icon('star', 'fh-icon is-tiny')}${t.cost} insight</b>
        <span>Branch</span><b>${c.branches[t.branch]?.name ?? t.branch}</b>
        <span>Era</span><b>${roman(t.era + 1)}</b>
        ${t.requires.length ? `<span>Requires</span><b>${t.requires.map((r) => c.techs[r]?.name ?? r).join(', ')}</b>` : ''}
        ${t.excludes?.length ? `<span>Excludes</span><b>${t.excludes.map((r) => c.techs[r]?.name ?? r).join(', ')}</b>` : ''}
        ${unlocks.length ? `<span>Unlocks</span><b>${unlocks.join(', ')}</b>` : ''}
        ${policies.length ? `<span>Policies</span><b>${policies.join(', ')}</b>` : ''}
      </div>
      ${modLines(t.effects, 8).length ? `<div class="fh-tip-mods">${modChips(t.effects, 8)}</div>` : ''}
      ${done ? `<div class="fh-tip-foot">${icon('check', 'fh-icon is-tiny')} Discovered</div>` : missing.length ? `<div class="fh-tip-foot">First discover ${missing.map((r) => c.techs[r]?.name ?? r).join(', ')}.</div>` : `<div class="fh-tip-foot">Click to spend ${t.cost} insight.</div>`}
    `;
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'tech') {
      const id = el.dataset.tech;
      if (id) {
        this.svc.app.chooseTech(id);
        host.reload();
      }
    } else if (act === 'doctrine') {
      const id = el.dataset.doctrine;
      if (id) {
        this.svc.app.chooseDoctrine(id);
        host.reload();
      }
    } else if (act === 'filter') {
      this.filter = (el.dataset.filter as Filter) ?? 'all';
      host.reload();
    } else if (act === 'focus-branch') {
      const branch = el.dataset.branch ?? null;
      this.branchFocus = this.branchFocus === branch ? null : branch;
      host.reload();
    }
  }
}
