/**
 * Expeditions: send scouts, surveyors and settler parties into the fog. Target
 * selection happens on the map; the shell shows a targeting banner meanwhile.
 */
import { capitalOf, dateLabel } from '../../sim/core';
import { expeditionCost } from '../../sim/actions';
import { icon } from '../icons';
import {
  chip,
  costChips,
  esc,
  fmt,
  fmtInt,
  meter,
  pct,
  pretty,
  selectedSettlement,
  stateOf,
  tip,
  tipText,
  type ExpeditionKind,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

const KINDS: { kind: ExpeditionKind; label: string; icon: string; blurb: string }[] = [
  { kind: 'scout', label: 'Scout', icon: 'eye', blurb: 'Two fast walkers trace the rivers and reveal the land. Cheap, quick, no answers.' },
  { kind: 'survey', label: 'Survey', icon: 'compass', blurb: 'Surveyors chart sites and deposits in detail, revealing what lies beneath.' },
  { kind: 'settle', label: 'Settle', icon: 'flag', blurb: 'A settler party founds a new hearth. Requires 10 people at home and open, claimable land.' },
];

export class ExpeditionsPanel implements GamePanel {
  readonly id = 'expeditions' as const;
  readonly subtitle = 'Send scouts, surveyors and settlers into the unknown';

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Horizon';
  }

  title(): string {
    return 'Expeditions';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const capital = capitalOf(s);
    const st = selectedSettlement(this.svc) ?? capital;
    const target = this.svc.getExpeditionTarget();
    const active = s.exploration.expeditions ?? [];
    const sites = s.world.sites.filter((site) => site.discovered);
    const costCards = KINDS.map((k) => {
      const cost = expeditionCost(k.kind);
      const canAfford = capital
        ? Object.entries(cost).every(([res, amount]) => (capital.stock[res] ?? 0) + 1e-6 >= amount)
        : false;
      const isTarget = target === k.kind;
      return `<article class="fh-expedition-card ${isTarget ? 'is-targeting' : ''}">
        <header>${icon(k.icon, 'fh-icon is-small')}<span><b>${k.label}</b><small>${k.kind === 'settle' ? 'found a settlement' : k.kind === 'survey' ? 'chart what is hidden' : 'reveal the land'}</small></span></header>
        <p>${esc(k.blurb)}</p>
        <div class="fh-expedition-costs">${costChips(c, cost, capital?.stock)}</div>
        <button type="button" class="fh-btn ${isTarget ? 'is-ember' : 'is-quiet'} clickable" data-act="target" data-kind="${k.kind}" ${canAfford ? '' : 'aria-disabled="true"'} ${tipText(canAfford ? 'Then click a destination tile on the map' : 'Not enough supplies')}>
          ${icon('target', 'fh-icon is-tiny')} ${isTarget ? 'Cancel targeting' : 'Choose target on map'}
        </button>
        ${k.kind === 'settle' && (capital?.population ?? 0) < 10 ? `<span class="fh-faint fh-small">Needs 10 people at home.</span>` : ''}
      </article>`;
    }).join('');

    return `<div class="fh-gp-scroll">
      ${
        target
          ? `<div class="fh-callout is-info fh-targeting">${icon('target', 'fh-icon is-small')}<span><b>Choosing a destination</b><small>Click a tile on the map to send the ${esc(target)} party. Press Esc to cancel.</small></span><button type="button" class="fh-btn is-ghost clickable" data-act="cancel-target">Cancel</button></div>`
          : ''
      }
      <div class="fh-expedition-grid">${costCards}</div>

      ${panelSection(
        'Afar',
        active.length
          ? `<div class="fh-expedition-list">${active
              .map(
                (exp) => `<div class="fh-expedition" ${tipText(`${exp.label} · party of ${exp.party} · supplies ${fmt(exp.supplies)}`)}>
                  <span class="fh-expedition-icon">${icon(exp.kind === 'settle' ? 'flag' : exp.kind === 'survey' ? 'compass' : 'eye', 'fh-icon is-small')}</span>
                  <span class="fh-expedition-copy"><b>${esc(exp.label)}</b><small>to ${exp.tx}, ${exp.ty} · party of ${exp.party}</small></span>
                  <span class="fh-expedition-progress">${meter(exp.progress, 1, { tone: 'is-info' })}<small>${pct(exp.progress)}</small></span>
                </div>`,
              )
              .join('')}</div>`
          : `<p class="fh-faint fh-small">No parties in the field. The map beyond the clearing is dark.</p>`,
        `${active.length} afield`,
      )}

      ${panelSection(
        'Known sites',
        sites.length
          ? `<div class="fh-site-grid">${sites
              .map((site) => {
                const def = c.sites[site.defId];
                return `<article class="fh-site ${site.visited ? 'is-visited' : ''}" ${tipText(def?.desc ?? 'A place of power and story.')}>
                  <span class="fh-site-icon" style="color:${def?.color ?? '#c9a55b'}">${icon(def?.icon ?? 'pin', 'fh-icon is-small')}</span>
                  <span><b>${esc(site.name)}</b><small>${esc(def ? pretty(def.kind) : 'site')} · ${site.visited ? 'visited' : site.discovered ? 'discovered' : 'unknown'}</small></span>
                  ${site.visited ? `<span class="fh-site-check">${icon('check', 'fh-icon is-tiny')}</span>` : ''}
                </article>`;
              })
              .join('')}</div>`
          : `<p class="fh-faint fh-small">No sites found yet. Scouts and surveyors discover them.</p>`,
        `${sites.length} found`,
      )}

      <div class="fh-explore-foot">
        <span>${icon('map', 'fh-icon is-tiny')} ${pct(s.exploration.mapReveal)} of the valley charted</span>
        <span>${icon('eye', 'fh-icon is-tiny')} ${fmtInt(s.exploration.sitesFound)} sites found</span>
        <span>${icon('compass', 'fh-icon is-tiny')} ${fmtInt(s.exploration.revealedTiles)} tiles charted</span>
        <span>${icon('handshake', 'fh-icon is-tiny')} ${s.neighbors.civs.filter((n) => n.discovered).length} neighbours met</span>
      </div>
      ${panelSection(
        'How a journey unfolds',
        `<div class="fh-journey-steps">
          <div class="fh-journey-step"><span class="fh-step-num">I</span><span><b>Choose a target</b><small>Pick a kind of party, then click anywhere on the map. The further the journey, the longer the wait.</small></span></div>
          <div class="fh-journey-step"><span class="fh-step-num">II</span><span><b>The land is revealed</b><small>Your party uncovers tiles as it travels — terrain, sites, deposits and eventually other peoples.</small></span></div>
          <div class="fh-journey-step"><span class="fh-step-num">III</span><span><b>The horizon returns</b><small>Sites may be visited for boons; settlers found a new hearth with its own people and stores.</small></span></div>
        </div>`,
        `${s.exploration.expeditions.length} afield`,
      )}
      <p class="fh-gp-footnote">${icon('info', 'fh-icon is-tiny')} Expeditions cost supplies now and reveal the map as they travel. Settlement parties found a new hearth with its own stock and people.</p>
    </div>`;
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'target') {
      const kind = el.dataset.kind as ExpeditionKind;
      const current = this.svc.getExpeditionTarget();
      this.svc.setExpeditionTarget(current === kind ? null : kind);
      host.reload();
    } else if (act === 'cancel-target') {
      this.svc.setExpeditionTarget(null);
      host.reload();
    }
  }
}

void dateLabel;
void fmt;
void chip;
