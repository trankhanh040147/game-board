/**
 * Wonders: the megaprojects that outlast a lifetime.
 */
import { hasTech } from '../../sim/core';
import { icon } from '../icons';
import {
  chip,
  costChips,
  esc,
  fmt,
  meter,
  pct,
  pretty,
  roman,
  selectedSettlement,
  stateOf,
  tip,
  tipText,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

export class WondersPanel implements GamePanel {
  readonly id = 'wonders' as const;
  readonly subtitle = 'Undertakings that outlast a lifetime';

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Great Works';
  }

  title(): string {
    return 'Wonders';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const st = selectedSettlement(this.svc);
    const order = c.megaprojectOrder;
    const cards = order
      .map((id) => {
        const def = c.megaprojects[id];
        const mp = s.megaprojects[id];
        if (!def || !mp) return '';
        const eraOk = s.research.era >= def.era;
        const techOk = def.requiresTech.every((t) => hasTech(s, t));
        const canAfford = st ? Object.entries(def.cost).every(([res, amount]) => (st.stock[res] ?? 0) + 1e-6 >= amount) : false;
        const insightOk = s.research.insight >= def.insightCost;
        const status = mp.status;
        const missingTechs = def.requiresTech.filter((t) => !hasTech(s, t));
        const blockedReason = !eraOk ? `Requires era ${roman(def.era + 1)}` : !techOk ? `Requires ${missingTechs.map((t) => c.techs[t]?.name ?? t).join(', ')}` : !canAfford ? 'Not enough materials' : !insightOk ? `Requires ${def.insightCost} insight` : '';
        return `<article class="fh-wonder is-${status}" ${tip(`<div class="fh-tip-head">${icon(def.icon, 'fh-icon is-small')} ${esc(def.name)}</div><div class="fh-tip-body">${esc(def.desc)}</div><div class="fh-tip-grid">${Object.entries(def.cost).map(([res, amount]) => `<span>${icon(c.resources[res]?.icon ?? 'diamond', 'fh-icon is-tiny')}${esc(c.resources[res]?.name ?? pretty(res))}</span><b>${fmt(amount)}</b>`).join('')}<span>Insight</span><b>${fmt(def.insightCost)}</b><span>Duration</span><b>${fmt(def.durationDays)} days</b></div>`)}>
          <div class="fh-wonder-head">
            <span class="fh-wonder-icon">${icon(def.icon, 'fh-icon is-large')}</span>
            <span class="fh-wonder-title"><b class="display">${esc(def.name)}</b><small>Era ${roman(def.era + 1)} · ${fmt(def.durationDays)} days</small></span>
            <span class="fh-wonder-status ${status === 'done' ? 'is-good' : status === 'building' ? 'is-warn' : status === 'available' ? 'is-brass' : 'is-neutral'}">${status === 'done' ? 'complete' : status === 'building' ? 'building' : status === 'available' ? 'available' : 'locked'}</span>
          </div>
          <p class="fh-wonder-desc">${esc(def.desc)}</p>
          ${status === 'building' ? `<div class="fh-wonder-progress">${meter(mp.progress, 1, { tone: 'is-brass', showValue: true, valueText: pct(mp.progress) })}<small>${icon('hourglass', 'fh-icon is-tiny')} started ${fmt(s.tick - mp.startedTick)} days ago</small></div>` : ''}
          ${status === 'done' ? `<div class="fh-wonder-done">${icon('check', 'fh-icon is-tiny')} Completed — ${esc(def.completionChronicle.title)}</div>` : ''}
          <div class="fh-wonder-costs">${costChips(c, { ...def.cost, insight: def.insightCost }, st?.stock)}</div>
          <div class="fh-wonder-mods">${this.effectChips(def.effects)}</div>
          <div class="fh-wonder-stages">${def.stages
            .map(
              (stage, i) => `<div class="fh-wonder-stage ${status === 'done' ? 'is-done' : ''}" ${tipText(stage.effectText)}>
                <span class="fh-wonder-stage-num">${roman(i + 1)}</span>
                <span><b>${esc(stage.name)}</b><small>${esc(stage.effectText)}</small></span>
              </div>`,
            )
            .join('')}</div>
          ${
            status === 'done' || status === 'building'
              ? ''
              : `<button type="button" class="fh-btn ${status === 'available' && !blockedReason ? 'is-ember' : 'is-quiet'} clickable" data-act="start" data-wonder="${id}" ${blockedReason ? 'aria-disabled="true"' : ''} ${tipText(blockedReason || `Begin this great work; it will take ${def.durationDays} days`)}>
                  ${icon(blockedReason ? 'lock' : 'spark', 'fh-icon is-tiny')} ${blockedReason || 'Begin the work'}
                </button>`
          }
        </article>`;
      })
      .join('');

    return `<div class="fh-gp-scroll">
      <div class="fh-wonders-intro serif">There are works a people raise not for a season but for a century — works that say <em>we were here, and we meant to stay</em>. They cost dear, and they take years. Build one anyway.</div>
      <div class="fh-wonder-grid">${cards || `<p class="fh-faint">No great works authored yet.</p>`}</div>
      ${panelSection(
        'The measure of a civilisation',
        `<div class="fh-wonders-stats">
          <div>${icon('megaproject', 'fh-icon is-small')}<span><b>${order.filter((id) => s.megaprojects[id]?.status === 'done').length}</b><small>completed</small></span></div>
          <div>${icon('spark', 'fh-icon is-small')}<span><b>${order.filter((id) => s.megaprojects[id]?.status === 'building').length}</b><small>in progress</small></span></div>
          <div>${icon('hourglass', 'fh-icon is-small')}<span><b>${order.filter((id) => s.megaprojects[id]?.status === 'available').length}</b><small>within reach</small></span></div>
          <div>${icon('star', 'fh-icon is-small')}<span><b>${fmt(s.research.insight)}</b><small>insight in hand</small></span></div>
        </div>`,
      )}
    </div>`;
  }

  private effectChips(effects: Record<string, number> | undefined): string {
    if (!effects) return '';
    const lines = Object.entries(effects).filter(([, v]) => Math.abs(v) > 0.0001);
    if (!lines.length) return '';
    return lines
      .slice(0, 6)
      .map(([key, value]) => {
        const label = (() => {
          const map: Record<string, string> = {
            workSpeed: 'Work speed',
            buildSpeed: 'Build speed',
            researchRate: 'Insight rate',
            cultureRate: 'Culture rate',
            moraleRate: 'Morale',
            healthRate: 'Health',
            beauty: 'Beauty',
            stability: 'Stability',
            taxEfficiency: 'Tax',
            storageCap: 'Storage',
            migrationRate: 'Migration',
          };
          return map[key] ?? pretty(key);
        })();
        return `<span class="fh-modchip ${value > 0 ? 'is-good' : 'is-bad'}">${esc(label)} <b>${value > 0 ? '+' : ''}${Math.round(value * 100)}%</b></span>`;
      })
      .join('');
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act !== 'start') return;
    const id = el.dataset.wonder;
    if (!id) return;
    const result = this.svc.app.startMegaproject(id);
    if (!result.ok && result.message) this.svc.toast(result.message, 'warn', 'warning');
    host.reload();
  }
}

void chip;
