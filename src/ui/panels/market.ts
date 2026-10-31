/**
 * Market: price list with trends, buy/sell steppers, treasury, tariff and the
 * trade routes your settlement runs.
 */
import type { ResourceId } from '../../sim/types';
import { modOfState } from '../../sim/core';
import { icon } from '../icons';
import {
  chip,
  esc,
  escAttr,
  fmt,
  iconHtml,
  pct,
  pretty,
  scoreTone,
  selectedSettlement,
  signed,
  stateOf,
  tip,
  tipText,
  toneClass,
  type Services,
} from '../util';
import { panelSection, type GamePanel, type PanelHost } from './host';

type MarketFilter = 'tradable' | 'store' | 'all';

export class MarketPanel implements GamePanel {
  readonly id = 'market' as const;
  readonly subtitle = 'Prices, trade and what the world will pay';
  private filter: MarketFilter = 'tradable';
  private qty = new Map<ResourceId, number>();
  private lastPriceTick = -1;

  constructor(private readonly svc: Services) {}

  eyebrow(): string {
    return 'The Exchange';
  }

  title(): string {
    return 'Market';
  }

  private quantity(res: ResourceId): number {
    return this.qty.get(res) ?? 5;
  }

  private unitPrice(res: ResourceId, direction: 'buy' | 'sell'): number {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const info = s.market.prices[res];
    const price = info?.price ?? c.resources[res]?.basePrice ?? 1;
    const spread = 1.18;
    const tariff = s.market.tariff ?? 0.04;
    const st = selectedSettlement(this.svc);
    const mod = modOfState(s, st?.id ?? -1, direction === 'buy' ? 'tradeBuyPrice' : 'tradeSellPrice');
    return direction === 'buy' ? price * spread * (1 + tariff) * (1 + mod) : (price / spread) * (1 - tariff) * (1 + mod);
  }

  render(): string {
    const s = stateOf(this.svc);
    const c = this.svc.app.content;
    const st = selectedSettlement(this.svc);
    const treasury = st?.treasury ?? 0;
    const market = s.market;
    const hasMarketBuilding = s.buildings.some((b) => b.progress >= 1 && ['market', 'trade_post'].includes(b.typeId) && b.settlementId === (st?.id ?? -1));
    const rows = c.resourceOrder
      .map((id) => c.resources[id])
      .filter((def): def is NonNullable<typeof def> => !!def)
      .filter((def) => {
        if (this.filter === 'store') return (st?.stock[def.id] ?? 0) > 0.001;
        if (this.filter === 'tradable') return def.tradable !== false;
        return true;
      });
    const trend = (res: ResourceId): { dir: number; pct: number } => {
      const info = market.prices[res];
      const hist = info?.history ?? [];
      if (hist.length >= 2) {
        const last = hist[hist.length - 1];
        const prev = hist[Math.max(0, hist.length - 2)];
        const change = prev > 0 ? (last - prev) / prev : 0;
        return { dir: change > 0.005 ? 1 : change < -0.005 ? -1 : 0, pct: change };
      }
      return { dir: info?.trend ? Math.sign(info.trend) : 0, pct: info?.trend ?? 0 };
    };
    return `
      <div class="fh-gp-scroll">
        <div class="fh-market-summary">
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('coin', 'fh-icon is-tiny')} Treasury</span><b>${fmt(treasury)}</b><small>coin available</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('trade', 'fh-icon is-tiny')} Trade balance</span><b class="${toneClass(market.tradeBalance)}">${signed(market.tradeBalance, 0)}</b><small>coin this age</small></div>
          <div class="fh-sum-card" ${tipText('A tariff is charged on every import and withheld on every export.')}><span class="fh-sum-label">${icon('tariff', 'fh-icon is-tiny')} Tariff</span><b>${pct(market.tariff)}</b><small>on foreign trade</small></div>
          <div class="fh-sum-card"><span class="fh-sum-label">${icon('road', 'fh-icon is-tiny')} Routes</span><b>${market.routes.filter((r) => r.active).length}</b><small>${s.neighbors.civs.filter((n) => n.discovered).length} neighbours met</small></div>
        </div>
        ${
          !hasMarketBuilding
            ? `<div class="fh-callout is-warn">${icon('warning', 'fh-icon is-small')}<span><b>No market standing</b><small>Build a market or trade post before buying or selling. Prices below are what the wider world is paying.</small></span></div>`
            : ''
        }
        <div class="fh-market-toolbar">
          <div class="fh-seg" role="group" aria-label="Resource filter">
            ${(
              [
                ['tradable', 'Tradable'],
                ['store', 'In store'],
                ['all', 'All goods'],
              ] as [MarketFilter, string][]
            )
              .map(([key, label]) => `<button type="button" class="fh-seg-btn clickable ${this.filter === key ? 'is-active' : ''}" data-act="filter" data-filter="${key}" aria-pressed="${this.filter === key}">${label}</button>`)
              .join('')}
          </div>
          <span class="fh-market-note">${rows.length} goods · prices update daily${this.lastPriceTick >= 0 ? ` · last update day ${this.lastPriceTick}` : ''}</span>
        </div>

        <div class="fh-market-table" role="table" aria-label="Market prices">
          <div class="fh-market-row is-head" role="row">
            <span role="columnheader">Good</span><span role="columnheader">Price</span><span role="columnheader">Trend</span><span role="columnheader">In store</span><span role="columnheader">Qty</span><span role="columnheader">Trade</span>
          </div>
          ${rows
            .map((def) => {
              const info = market.prices[def.id];
              const price = info?.price ?? def.basePrice;
              const base = info?.base ?? def.basePrice;
              const t = trend(def.id);
              const stock = st?.stock[def.id] ?? 0;
              const quantity = this.quantity(def.id);
              const buyUnit = this.unitPrice(def.id, 'buy');
              const sellUnit = this.unitPrice(def.id, 'sell');
              const canBuy = treasury >= buyUnit * quantity;
              const canSell = stock >= quantity;
              const supply = info?.supply ?? 0;
              const demand = info?.demand ?? 0;
              return `<div class="fh-market-row" role="row" data-tip-html="${escAttr(
                `<div class="fh-tip-head">${icon(def.icon, 'fh-icon is-small')} ${esc(def.name)}</div>
                 <div class="fh-tip-body">${esc(def.desc)}</div>
                 <div class="fh-tip-grid"><span>Base price</span><b>${fmt(base)}</b><span>Current</span><b>${fmt(price)}</b><span>Buy at</span><b>${fmt(buyUnit)} each</b><span>Sell at</span><b>${fmt(sellUnit)} each</b><span>Supply</span><b>${fmt(supply, 1)}</b><span>Demand</span><b>${fmt(demand, 1)}</b>${def.edible ? `<span>Food value</span><b>×${def.edible}</b>` : ''}</div>`,
              )}">
                <span class="fh-mkt-good">${icon(def.icon, 'fh-icon is-tiny')}<span>${esc(def.name)}</span><small class="fh-faint">${esc(pretty(def.category))}</small></span>
                <span class="fh-mkt-price">${fmt(price)}<small class="${toneClass(price - base)}">${signed(((price - base) / Math.max(0.01, base)) * 100, 0)}% of base</small></span>
                <span class="fh-mkt-trend ${t.dir > 0 ? 'is-bad' : t.dir < 0 ? 'is-good' : ''}" ${tipText(t.dir > 0 ? 'Prices rising — buying now costs more' : t.dir < 0 ? 'Prices falling — a good time to buy' : 'Prices steady')}>${icon(t.dir > 0 ? 'trend_up' : t.dir < 0 ? 'trend_down' : 'minus', 'fh-icon is-tiny')}${signed(t.pct * 100, 0)}%</span>
                <span class="fh-mkt-stock">${fmt(stock)}<small>${s.difficulty === 'harsh' ? 'harsh' : ''}</small></span>
                <span class="fh-mkt-qty">
                  <button type="button" class="fh-step clickable" data-act="qty-dec" data-res="${def.id}" aria-label="Decrease quantity">${icon('minus', 'fh-icon is-tiny')}</button>
                  <input type="number" class="fh-qty-input" min="1" max="999" step="1" value="${quantity}" data-qty-res="${def.id}" aria-label="Quantity of ${escAttr(def.name)}" />
                  <button type="button" class="fh-step clickable" data-act="qty-inc" data-res="${def.id}" aria-label="Increase quantity">${icon('plus', 'fh-icon is-tiny')}</button>
                </span>
                <span class="fh-mkt-actions">
                  <button type="button" class="fh-mini-btn is-buy clickable ${canBuy ? '' : 'is-disabled'}" data-act="buy" data-res="${def.id}" aria-label="Buy ${escAttr(def.name)}" ${tipText(`Buy ${quantity} ${def.name} for about ${fmt(buyUnit * quantity)} coin`)}>${icon('arrow_down', 'fh-icon is-tiny')}Buy</button>
                  <button type="button" class="fh-mini-btn is-sell clickable ${canSell ? '' : 'is-disabled'}" data-act="sell" data-res="${def.id}" aria-label="Sell ${escAttr(def.name)}" ${tipText(`Sell ${quantity} ${def.name} for about ${fmt(sellUnit * quantity)} coin`)}>${icon('arrow_up', 'fh-icon is-tiny')}Sell</button>
                </span>
              </div>`;
            })
            .join('')}
        </div>

        ${panelSection(
          'Trade routes',
          `${
            market.routes.length
              ? `<div class="fh-routes">${market.routes
                  .slice(0, 20)
                  .map((route) => {
                    const def = c.resources[route.resource];
                    const dest = route.toKind === 'neighbor' ? s.neighbors.civs.find((n) => n.id === route.toId)?.name ?? `Neighbour ${route.toId}` : s.settlements.find((x) => x.id === route.toId)?.name ?? 'Settlement';
                    return `<div class="fh-route ${route.active ? '' : 'is-muted'}">
                      <span class="fh-route-good">${icon(def?.icon ?? 'diamond', 'fh-icon is-tiny')}${esc(def?.name ?? pretty(route.resource))}</span>
                      <span class="fh-route-dir ${route.direction === 'import' ? 'is-good' : 'is-bad'}">${route.direction === 'import' ? 'import' : 'export'} ${fmt(route.amountPerDay, 1)}/d</span>
                      <span class="fh-route-dest">${icon(route.toKind === 'neighbor' ? 'handshake' : 'flag', 'fh-icon is-tiny')}${esc(dest)}</span>
                    </div>`;
                  })
                  .join('')}</div>`
              : `<p class="fh-faint fh-small">No standing routes. Your governor may open trade when stocks run low, and neighbours may offer terms in Diplomacy.</p>`
          }`,
          `${market.routes.length} routes`,
        )}
        ${
          s.settlements.length > 1
            ? panelSection(
                'Caravans',
                `<div class="fh-routes">${s.market.caravans
                  .slice(0, 8)
                  .map((car) => `<div class="fh-route"><span class="fh-route-good">${icon('cart', 'fh-icon is-tiny')}${esc(car.label)}</span><span class="fh-route-dir">${pct(car.progress)} of the way</span><span class="fh-route-dest">${esc(Object.entries(car.cargo).map(([r, a]) => `${fmt(a)} ${c.resources[r]?.name ?? r}`).join(', ') || 'empty')}</span></div>`)
                  .join('') || '<p class="fh-faint fh-small">No caravans on the road.</p>'}</div>`,
              )
            : ''
        }
      </div>`;
  }

  private flashPrices(): void {
    this.lastPriceTick = stateOf(this.svc).market.lastUpdateTick;
  }

  handleInput(input: HTMLInputElement): void {
    const res = input.dataset.qtyRes;
    if (!res) return;
    const value = Math.max(1, Math.min(999, Math.round(Number(input.value) || 1)));
    this.qty.set(res, value);
  }

  handleAction(act: string, el: HTMLElement, host: PanelHost): void {
    const res = el.dataset.res as ResourceId | undefined;
    if (!res && act !== 'filter' && act !== 'open-diplomacy') return;
    if (act === 'qty-inc' || act === 'qty-dec') {
      const current = this.quantity(res!);
      const step = current < 10 ? 1 : current < 50 ? 5 : 10;
      this.qty.set(res!, Math.max(1, Math.min(999, current + (act === 'qty-inc' ? step : -step))));
      host.reload();
      return;
    }
    if (act === 'buy' || act === 'sell') {
      const amount = this.quantity(res!);
      this.svc.app.trade(res!, amount, act);
      this.flashPrices();
      host.reload();
      return;
    }
    if (act === 'filter') {
      this.filter = (el.dataset.filter as MarketFilter) ?? 'tradable';
      host.reload();
      return;
    }
    if (act === 'open-diplomacy') this.svc.openPanel('diplomacy');
  }
}

// Keep tidy-import guards; these helpers are used by adjacent panels.
void chip;
void iconHtml;
void scoreTone;
