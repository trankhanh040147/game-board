/**
 * Diplomacy: the neighbours you have met, their temper, and the offers on the
 * table. Actions are read-only until the diplomacy action API lands.
 */
import { icon } from '../icons';
import {
  chip,
  esc,
  fmt,
  fmtInt,
  gauge,
  pct,
  pretty,
  scoreTone,
  selectedSettlement,
  signed,
  stateOf,
  tip,
  tipText,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

const RELATION_TONE: Record<string, string> = {
  unknown: 'is-neutral',
  neutral: 'is-neutral',
  trade: 'is-good',
  alliance: 'is-brass',
  war: 'is-bad',
};

export class DiplomacyPanel implements GamePanel {
  readonly id = 'diplomacy' as const;
  readonly subtitle = 'Neighbour civilisations and their moods';
  private expanded = new Set<number>();

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Marches';
  }

  title(): string {
    return 'Diplomacy';
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const civs = s.neighbors.civs;
    const met = civs.filter((n) => n.discovered);
    const mapReveal = s.exploration.mapReveal;
    const totalPop = s.settlements.reduce((n, x) => n + x.population, 0);
    if (!met.length) {
      return `<div class="fh-gp-scroll">${this.emptyState()}</div>`;
    }
    return `
      <div class="fh-gp-scroll">
        <div class="fh-summary-row">
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('handshake', 'fh-icon is-tiny')} Neighbours met</span><b>${met.length}</b><small>${civs.length} ${civs.length === 1 ? 'people' : 'peoples'} in the world</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('compass', 'fh-icon is-tiny')} Valley charted</span><b>${pct(mapReveal)}</b><small>${fmtInt(s.exploration.sitesFound)} sites found</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('trade', 'fh-icon is-tiny')} Trade balance</span><b>${signed(s.market.tradeBalance, 0)}</b><small>coin this age</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('shield', 'fh-icon is-tiny')} Our strength</span><b>${fmtInt(totalPop)}</b><small>people to defend</small></div>
        </div>

        <div class="fh-civ-grid">
          ${met.map((civ) => this.civCard(civ)).join('')}
        </div>

        ${
          civs.length > met.length
            ? `<div class="fh-callout is-info">${icon('compass', 'fh-icon is-small')}<span><b>${civs.length - met.length} peoples remain unmet</b><small>Send scouts and surveyors further afield to find them. The Expeditions panel can begin a journey.</small></span></div>`
            : ''
        }
        <p class="fh-gp-footnote">${icon('info', 'fh-icon is-tiny')} Treaties, gifts and declarations require a diplomacy action API which is still being written. Offers from neighbours appear here as they arrive.</p>
      </div>`;
  }

  private emptyState(): string {
    const s = stateOf(this.svc);
    return `<div class="fh-empty fh-empty-hero">
      <div class="fh-compass-art" aria-hidden="true">
        <span class="fh-compass-ring is-outer"></span>
        <span class="fh-compass-ring is-inner"></span>
        <span class="fh-compass-needle"></span>
        ${icon('compass', 'fh-icon is-large')}
      </div>
      <span class="fh-eyebrow">Uncharted</span>
      <h2 class="display">The valley feels empty</h2>
      <p class="fh-empty-body">No other people have been met yet. Smoke on the horizon is usually a hearth — but someone must go and look. Send a party along the rivers and see who answers.</p>
      <div class="fh-chipwrap fh-empty-ways">
        <span class="fh-chip is-info">${icon('eye', 'fh-icon is-tiny')}Scouts reveal the land</span>
        <span class="fh-chip is-brass">${icon('compass', 'fh-icon is-tiny')}Surveyors find sites</span>
        <span class="fh-chip is-neutral">${icon('flag', 'fh-icon is-tiny')}Settlers found new hearths</span>
      </div>
      <button type="button" class="fh-btn is-ember clickable" data-act="open-expeditions">${icon('compass', 'fh-icon is-tiny')} Plan an expedition</button>
      <p class="fh-faint fh-small">${pct(s.exploration.mapReveal)} of the valley charted so far · ${fmtInt(s.exploration.sitesFound)} sites found</p>
    </div>`;
  }

  private civCard(civ: NonNullable<ReturnType<typeof stateOf>['neighbors']['civs'][number]>): string {
    const c = this.svc.app.content;
    const s = stateOf(this.svc);
    const expanded = this.expanded.has(civ.id);
    const attitude = (civ.attitude + 100) / 200; // -100..100 -> 0..1
    const relation = civ.relation;
    return `<article class="fh-civ" style="--fh-civ:${civ.color}">
      <header class="fh-civ-head">
        <span class="fh-civ-mark" aria-hidden="true"></span>
        <span class="fh-civ-title"><b class="display">${esc(civ.name)}</b><small>${esc(pretty(civ.archetype))} · ${esc(pretty(relation))}</small></span>
        <span class="fh-chip ${RELATION_TONE[relation] ?? 'is-neutral'}">${icon(relation === 'war' ? 'sword' : relation === 'trade' ? 'trade' : relation === 'alliance' ? 'handshake' : 'dot', 'fh-icon is-tiny')}${esc(pretty(relation))}</span>
      </header>
      <div class="fh-civ-attitude">
        ${gauge('Attitude', attitude, { tone: scoreTone(attitude * 100), hint: `Attitude ${signed(civ.attitude, 0)}: negative means hostile, positive means friendly.` })}
        <div class="fh-civ-stats">
          <div ${tipText('Their wealth relative to yours')}><span>Wealth</span><b>${fmt(civ.wealth)}</b></div>
          <div ${tipText('Their military strength')}><span>Military</span><b>${fmt(civ.military)}</b></div>
          <div ${tipText('Their technological era')}><span>Tech</span><b>${fmt(civ.techLevel, 1)}</b></div>
          <div ${tipText('Their population')}><span>People</span><b>${fmtInt(civ.population)}</b></div>
        </div>
      </div>
      <div class="fh-civ-markets">
        <span ${tipText('What they sell to the world')}>${icon('arrow_down', 'fh-icon is-tiny')} exports ${civ.exports.slice(0, 3).map((r) => esc(c.resources[r]?.name ?? pretty(r))).join(', ') || '—'}</span>
        <span ${tipText('What they wish to buy')}>${icon('arrow_up', 'fh-icon is-tiny')} imports ${civ.imports.slice(0, 3).map((r) => esc(c.resources[r]?.name ?? pretty(r))).join(', ') || '—'}</span>
      </div>
      ${
        civ.offers.length
          ? `<div class="fh-civ-offers">
              <span class="fh-mini-head">On the table</span>
              ${civ.offers
                .map((offer, index) => {
                  const expired = offer.expiresTick > 0 && offer.expiresTick <= s.tick;
                  return `<div class="fh-offer ${expired ? 'is-expired' : ''}">
                    <span class="fh-offer-kind">${icon(offer.kind === 'war' ? 'sword' : offer.kind === 'trade' ? 'trade' : offer.kind === 'gift' ? 'gift' : offer.kind === 'demand' ? 'warning' : 'handshake', 'fh-icon is-tiny')}${esc(pretty(offer.kind))}</span>
                    <span class="fh-offer-text">${esc(offer.text)}<small class="fh-offer-expiry">${expired ? 'expired' : offer.expiresTick > 0 ? `expires day ${fmtInt(offer.expiresTick)}` : 'standing'}</small></span>
                    <span class="fh-offer-actions">
                      <button type="button" class="fh-mini-btn is-buy clickable ${expired ? 'is-disabled' : ''}" data-act="offer" data-civ="${civ.id}" data-offer="${index}" data-accept="1" ${expired ? 'aria-disabled="true"' : ''} ${tipText(expired ? 'This offer has expired' : 'Accept these terms')}>Accept</button>
                      <button type="button" class="fh-mini-btn clickable ${expired ? 'is-disabled' : ''}" data-act="offer" data-civ="${civ.id}" data-offer="${index}" data-accept="0" ${expired ? 'aria-disabled="true"' : ''} ${tipText(expired ? 'This offer has expired' : 'Decline these terms')}>Decline</button>
                    </span>
                  </div>`;
                })
                .join('')}
            </div>`
          : ''
      }
      <div class="fh-civ-foot">
        <span class="fh-faint">Last contact ${civ.lastContactTick > 0 ? `day ${fmtInt(civ.lastContactTick)}` : 'never'}</span>
        <span class="fh-civ-gifts">
          <span class="fh-mini-head">Send a gift</span>
          <button type="button" class="fh-mini-btn clickable" data-act="gift" data-civ="${civ.id}" data-gift="treasury" ${tipText('Send 10 coin as a gift — a small warmth between peoples')}>${icon('coin', 'fh-icon is-tiny')}10</button>
          <button type="button" class="fh-mini-btn clickable" data-act="gift" data-civ="${civ.id}" data-gift="berries" ${tipText('Send 5 food as a gift')}>${icon('berries', 'fh-icon is-tiny')}5</button>
        </span>
        <button type="button" class="fh-link clickable" data-act="civ-detail" data-civ="${civ.id}">${expanded ? 'Hide' : 'Details'} →</button>
      </div>
      ${
        expanded
          ? `<div class="fh-civ-detail">
              <div><span>Discovered</span><b>${civ.discoveredTick >= 0 ? `day ${fmtInt(civ.discoveredTick)}` : '—'}</b></div>
              <div><span>Capital</span><b>${Math.round(civ.capital.x)}, ${Math.round(civ.capital.y)}</b></div>
              <div><span>Raid cooldown</span><b>${civ.raidCooldown > 0 ? `${fmtInt(civ.raidCooldown)} days` : 'ready'}</b></div>
              <div><span>Attitude</span><b>${signed(civ.attitude, 0)}</b></div>
            </div>`
          : ''
      }
    </article>`;
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    if (act === 'offer') {
      const civId = Number(el.dataset.civ);
      const offerIndex = Number(el.dataset.offer);
      const accept = el.dataset.accept === '1';
      if (Number.isFinite(civId) && Number.isFinite(offerIndex)) {
        this.svc.app.respondToOffer(civId, offerIndex, accept);
        host.reload();
      }
    } else if (act === 'gift') {
      const civId = Number(el.dataset.civ);
      const kind = el.dataset.gift;
      if (Number.isFinite(civId)) {
        if (kind === 'treasury') this.svc.app.giftToNeighbor(civId, null, 10);
        else this.svc.app.giftToNeighbor(civId, 'berries', 5);
        host.reload();
      }
    } else if (act === 'open-expeditions') this.svc.openPanel('expeditions');
    else if (act === 'civ-detail') {
      const id = Number(el.dataset.civ);
      if (this.expanded.has(id)) this.expanded.delete(id);
      else this.expanded.add(id);
      host.reload();
    }
  }
}

void selectedSettlement;
void chip;
void panelSection;
