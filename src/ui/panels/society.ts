/**
 * Society: approval/stability/crime, the tax/rations/hours levers, policy cards,
 * class composition and the doctrine you walk.
 */
import type { PolicyDef } from '../../sim/types';
import { isPolicyUnlocked, modOfState } from '../../sim/core';
import { policyInfluenceCost } from '../../sim/actions';
import { icon } from '../icons';
import {
  chip,
  esc,
  fmt,
  gauge,
  modChips,
  modLines,
  pct,
  pct100,
  pretty,
  roman,
  scoreTone,
  selectedSettlement,
  signed,
  stateOf,
  tip,
  tipText,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

const CLASSES: { id: 'laborer' | 'artisan' | 'scholar' | 'merchant'; label: string; icon: string; blurb: string }[] = [
  { id: 'laborer', label: 'Laborers', icon: 'hammer', blurb: 'Hands in the field, the wood and the mine. The many.' },
  { id: 'artisan', label: 'Artisans', icon: 'workshop', blurb: 'Crafters of goods — cloth, tools, pottery, glass.' },
  { id: 'scholar', label: 'Scholars', icon: 'book', blurb: 'Keepers of insight, teachers and healers.' },
  { id: 'merchant', label: 'Merchants', icon: 'scale', blurb: 'Traders who turn surplus into coin.' },
];

export class SocietyPanel implements GamePanel {
  readonly id = 'society' as const;
  readonly subtitle = 'Law, labour and the shape of your people';
  private showLocked = true;

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Commons';
  }

  title(): string {
    return 'Society';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const society = s.society;
    const st = selectedSettlement(this.svc);
    const capital = st;
    const influence = capital?.influence ?? 0;
    const policies = c.policyOrder.map((id) => c.policies[id]).filter(Boolean) as PolicyDef[];
    const activeCount = Object.values(society.policies).filter(Boolean).length;
    const doctrine = s.research.doctrine ? c.doctrines[s.research.doctrine] : null;
    const offers = (s.research.doctrineChoices ?? []).map((id) => c.doctrines[id]).filter(Boolean);
    return `
      <div class="fh-gp-scroll">
        <div class="fh-society-gauges">
          ${gauge('Approval', society.approval / 100, { tone: scoreTone(society.approval), hint: 'Approval: how well the settlement thinks you govern. Affects stability and migration.' })}
          ${gauge('Stability', society.stability / 100, { tone: scoreTone(society.stability), hint: 'Stability: the calm of the streets. Low stability breeds crime and unrest.' })}
          ${gauge('Crime', society.crime / 100, { tone: scoreTone((100 - society.crime) * 1), hint: 'Crime: theft and violence. Rises with inequality, hunger and joblessness.' })}
          <div class="fh-society-figures">
            <div ${tipText('Influence available to enact policies')}><span>${icon('influence', 'fh-icon is-tiny')} Influence</span><b>${fmt(influence)}</b></div>
            <div ${tipText('Treasury in the capital')}><span>${icon('coin', 'fh-icon is-tiny')} Treasury</span><b>${fmt(capital?.treasury ?? 0)}</b></div>
            <div ${tipText('Culture accumulated by festivals, art and civic life')}><span>${icon('culture', 'fh-icon is-tiny')} Culture</span><b>${fmt(society.culturePoints)}</b></div>
            <div ${tipText('Policies currently in force')}><span>${icon('policy', 'fh-icon is-tiny')} Policies</span><b>${activeCount}</b></div>
          </div>
        </div>

        ${panelSection(
          'The levers of rule',
          `<div class="fh-levers">
            <label class="fh-lever" ${tipText('Tax rate: more coin now, less approval. High taxes feed the treasury but sour the people.')}>
              <span class="fh-lever-label">Tax rate <b>${pct(society.taxRate)}</b></span>
              <input type="range" min="0" max="0.45" step="0.01" value="${society.taxRate}" data-tax-slider data-focus-key="tax" aria-label="Tax rate" />
              <span class="fh-lever-foot"><span>0%</span><span>45%</span></span>
            </label>
            <div class="fh-lever" ${tipText('Rations: meagre stretches the stores but costs morale; generous lifts spirits and consumption.')}>
              <span class="fh-lever-label">Rations <b>${pretty(society.rations)}</b></span>
              <div class="fh-seg">
                ${(['meager', 'normal', 'generous'] as const)
                  .map((r) => `<button type="button" class="fh-seg-btn clickable ${society.rations === r ? 'is-active' : ''}" data-act="rations" data-rations="${r}" aria-pressed="${society.rations === r}">${pretty(r)}</button>`)
                  .join('')}
              </div>
              <span class="fh-lever-foot">${society.rations === 'meager' ? 'Stores last longer; spirits suffer.' : society.rations === 'generous' ? 'Spirits lift; granaries empty faster.' : 'A fair and steady table.'}</span>
            </div>
            <div class="fh-lever" ${tipText('Work hours: longer days produce more but exhaust your people.')}>
              <span class="fh-lever-label">Work hours <b>${society.workHours} / day</b></span>
              <div class="fh-seg">
                ${[8, 10, 12]
                  .map((h) => `<button type="button" class="fh-seg-btn clickable ${society.workHours === h ? 'is-active' : ''}" data-act="hours" data-hours="${h}" aria-pressed="${society.workHours === h}">${h}h</button>`)
                  .join('')}
              </div>
              <span class="fh-lever-foot">${society.workHours === 8 ? 'A gentler day. Less output, steadier people.' : society.workHours === 12 ? 'Long shifts. Output up, morale and health down.' : 'The customary working day.'}</span>
            </div>
          </div>`,
          '',
          'Three levers steer the whole of society. Every change is felt within days.',
        )}

        <div class="fh-gp-section">
          <div class="fh-gp-section-head">
            <h3>Classes</h3>
            <span class="fh-gp-section-extra">${icon('people', 'fh-icon is-tiny')} social fabric</span>
          </div>
          <div class="fh-class-table">
            <div class="fh-class-row is-head"><span>Class</span><span>People</span><span>Wealth</span><span>Satisfaction</span><span>Approval</span></div>
            ${CLASSES.map((cls) => {
              const state = society.classes[cls.id];
              return `<div class="fh-class-row" ${tipText(cls.blurb)}>
                <span class="fh-class-name">${icon(cls.icon, 'fh-icon is-tiny')}${cls.label}</span>
                <span>${fmt(state?.count ?? 0)}</span>
                <span>${fmt(state?.wealth ?? 0)}</span>
                <span class="fh-class-meter">${pct100(state?.satisfaction ?? 0)}</span>
                <span class="${scoreTone((state?.approval ?? 0) + 50)}">${signed(state?.approval ?? 0, 0)}</span>
              </div>`;
            }).join('')}
          </div>
        </div>

        ${panelSection(
          'Doctrine',
          doctrine
            ? `<div class="fh-doctrine is-chosen" style="--fh-doctrine:${doctrine.color}">
                <div class="fh-doctrine-head"><span class="fh-doctrine-icon" style="color:${doctrine.color}">${icon(doctrine.icon, 'fh-icon')}</span><span><b class="display">${esc(doctrine.name)}</b><small class="serif">“${esc(doctrine.motto)}”</small></span></div>
                <p class="fh-doctrine-desc">${esc(doctrine.desc)}</p>
                <div class="fh-doctrine-mods">${modChips(doctrine.effects, 8)}</div>
              </div>`
            : offers.length
              ? `<p class="fh-gp-lede">A creed awaits your word. <button type="button" class="fh-link clickable" data-act="open-codex">Open the Codex to choose →</button></p>`
              : `<p class="fh-faint fh-small">No creed offered yet. Grow your people and your insight.</p>`,
          '',
          doctrine ? undefined : 'A creed shapes the whole civilisation.',
        )}

        <div class="fh-gp-section">
          <div class="fh-gp-section-head">
            <h3>Policies</h3>
            <span class="fh-gp-section-extra">
              <button type="button" class="fh-link clickable" data-act="toggle-locked">${this.showLocked ? 'Hide' : 'Show'} unavailable</button>
            </span>
          </div>
          <div class="fh-policy-grid">
            ${policies.map((p) => this.policyCard(p)).join('')}
          </div>
        </div>

        ${
          society.traditions.length || society.festivals.length
            ? panelSection(
                'Traditions & festivals',
                `<div class="fh-chipwrap">${society.traditions.map((t) => `<span class="fh-chip is-brass">${icon('feather', 'fh-icon is-tiny')}${esc(pretty(t))}</span>`).join('')}${society.festivals.map((f) => `<span class="fh-chip is-info">${icon('culture', 'fh-icon is-tiny')}${esc(pretty(f))}</span>`).join('')}</div>`,
              )
            : ''
        }
      </div>`;
  }

  private policyCard(p: PolicyDef): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const st = selectedSettlement(this.svc);
    const on = !!s.society.policies[p.id];
    const unlocked = isPolicyUnlocked(s, c, p.id);
    const cost = policyInfluenceCost(p);
    const affordable = (st?.influence ?? 0) >= cost;
    const conflicts = (p.conflicts ?? []).filter((cid) => s.society.policies[cid]);
    const blocked = !unlocked || (!on && (conflicts.length > 0 || !affordable));
    if (!unlocked && !this.showLocked && !on) return '';
    const missingTechs = p.requiresTech.filter((t) => !s.research.completed[t]);
    const reqText = missingTechs.length ? missingTechs.map((t) => c.techs[t]?.name ?? t).join(', ') : '';
    const support = Object.entries(p.classSupport ?? {})
      .filter(([, v]) => typeof v === 'number' && v !== 0)
      .map(([cls, v]) => `<span class="${v > 0 ? 'is-good' : 'is-bad'}" ${tipText(`${pretty(cls)} support ${signed((v as number) * 100, 0)}%`)}>${icon(cls === 'scholar' ? 'book' : cls === 'merchant' ? 'scale' : cls === 'artisan' ? 'workshop' : 'hammer', 'fh-icon is-tiny')}${signed((v as number) * 100, 0)}%</span>`)
      .join('');
    const upkeep = Object.entries(p.upkeep ?? {})
      .filter(([, v]) => (v ?? 0) > 0)
      .map(([k, v]) => `${fmt(v ?? 0)} ${k}`)
      .join(' · ');
    return `<article class="fh-policy ${on ? 'is-on' : ''} ${!unlocked ? 'is-locked' : ''}">
      <div class="fh-policy-head">
        <span class="fh-policy-icon">${icon(on ? 'policy' : 'policy', 'fh-icon is-small')}</span>
        <span class="fh-policy-title"><b>${esc(p.name)}</b><small>${on ? 'in force' : unlocked ? `cost ${cost} influence` : `era ${roman(p.era + 1)}`}</small></span>
        <button type="button" class="fh-toggle clickable ${on ? 'is-on' : ''}" data-act="policy" data-policy="${p.id}" data-on="${on ? '0' : '1'}" aria-pressed="${on}" ${blocked && !on ? 'aria-disabled="true"' : ''} ${tipText(on ? 'Repeal this policy' : !unlocked ? `Requires ${reqText || `era ${roman(p.era + 1)}`}` : conflicts.length ? `Conflicts with ${conflicts.map((x) => c.policies[x]?.name ?? x).join(', ')}` : !affordable ? `Needs ${cost} influence` : `Enact for ${cost} influence`)}>${icon(on ? 'check' : 'dot', 'fh-icon is-tiny')}<span>${on ? 'Repeal' : 'Enact'}</span></button>
      </div>
      <p class="fh-policy-desc">${esc(p.desc)}</p>
      <div class="fh-policy-mods">${modChips(p.effects, 4)}</div>
      ${p.classSupport ? `<div class="fh-policy-support">${support}</div>` : ''}
      ${upkeep ? `<div class="fh-policy-foot">${icon('hourglass', 'fh-icon is-tiny')} upkeep ${esc(upkeep)}</div>` : ''}
      ${!on && unlocked && !affordable ? `<div class="fh-policy-foot is-warn">${icon('influence', 'fh-icon is-tiny')} needs ${cost} influence</div>` : ''}
      ${!on && unlocked && conflicts.length ? `<div class="fh-policy-foot is-bad">${icon('warning', 'fh-icon is-tiny')} conflicts with ${esc(conflicts.map((x) => c.policies[x]?.name ?? x).join(', '))}</div>` : ''}
    </article>`;
  }

  handleInput(input: HTMLInputElement): void {
    if (input.hasAttribute('data-tax-slider')) {
      const rate = Number(input.value);
      if (Number.isFinite(rate)) {
        this.svc.app.setTaxRate(rate);
        const label = input.closest('.fh-lever')?.querySelector('b');
        if (label) label.textContent = pct(rate);
      }
    }
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'rations') {
      const rations = el.dataset.rations as 'meager' | 'normal' | 'generous';
      if (rations) this.svc.app.setRations(rations);
      host.reload();
    } else if (act === 'hours') {
      const hours = Number(el.dataset.hours);
      if (Number.isFinite(hours)) this.svc.app.setWorkHours(hours);
      host.reload();
    } else if (act === 'policy') {
      const id = el.dataset.policy;
      const on = el.dataset.on === '1';
      if (id) {
        const result = this.svc.app.setPolicy(id, on);
        if (!result.ok && result.message) this.svc.toast(result.message, 'warn', 'warning');
      }
      host.reload();
    } else if (act === 'toggle-locked') {
      this.showLocked = !this.showLocked;
      host.reload();
    } else if (act === 'open-codex') {
      this.svc.openPanel('codex');
    }
  }
}
