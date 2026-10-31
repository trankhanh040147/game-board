/**
 * civ.economy — Prices, taxes, treasury, neighbour trade and the governor's market.
 *
 * Daily flow:
 *   1. make sure every resource has a PriceInfo (content can grow at runtime),
 *   2. float prices from supply / demand against stock, mean-reverting to base,
 *      clamped 0.2x–6x, with a 30-day history,
 *   3. rare market shocks that move a single good,
 *   4. collect taxes (population + buildings) and pay coin upkeep,
 *   5. establish and dispatch neighbour trade routes as physical caravans,
 *   6. governor.autoTrade: buy critical food/medicine, sell big surplus.
 *
 * Prices are a decision lever, not a spreadsheet: they move slowly, respond to
 * scarcity and to the player's own trades, and only spike on real events.
 *
 * Determinism: randomness only via ctx.rng.
 */
import type {
  Content,
  GameState,
  PriceInfo,
  ResourceDef,
  ResourceId,
  Settlement,
  SimContext,
  SimSystem,
} from '../../types';
import { LIMITS } from '../../config';
import {
  addStock,
  capitalOf,
  clamp,
  foodDaysOf,
  modOf,
  removeStock,
  round1,
  round2,
  settlementById,
  stockOf,
  stockTotal,
  totalPopulation,
} from '../../core';
import { setSettlementAlert, clearSettlementAlert, freeStorageSpace } from './buildings';
import { createCaravanFromPoint, LOGISTICS_TUNING } from './logistics';

// ---------------------------------------------------------------------------
// Tuning knobs
// ---------------------------------------------------------------------------

export const ECONOMY_TUNING = {
  /** Price caught up to its target this fast each day. */
  priceResponse: 0.14,
  /** Pull back toward base price each day (keeps prices from drifting forever). */
  priceMeanReversion: 0.02,
  minPriceFactor: 0.2,
  maxPriceFactor: 6,
  priceHistoryLength: 30,
  /** Food reserve the market prices against, in days. */
  foodReserveDays: 5,
  /** Materials reserve priced against, in "building-equivalents". */
  materialsPerBuilding: 0.7,
  /** Coin per worker-day at the baseline 12% tax rate. */
  taxIncomePerWorker: 0.9,
  baselineTaxRate: 0.12,
  /** Tax on the value of completed buildings. */
  buildingTaxValueFactor: 0.0035,
  /** Flat coin upkeep per completed, enabled building. */
  coinUpkeepPerBuilding: 0.06,
  /** Coin upkeep proportional to building value. */
  coinUpkeepValueFactor: 0.0015,
  /** Market spread applied to buy/sell orders (mirrors actions.tradeNow). */
  spread: 1.12,
  /** Days between caravans dispatched along one route. */
  routeDispatchInterval: 3,
  /** Trade routes are reconsidered this often. */
  routeRefreshDays: 5,
  /** Chance per day of a single-good market shock. */
  shockChance: 0.012,
  shockCooldownDays: 24,
  /** Governor auto-trade cadence (days per settlement). */
  autoTradeInterval: 2,
  autoTradeMaxBuy: 40,
  autoTradeMaxSell: 20,
  /** Surplus multiplier over target stock before auto-selling. */
  autoSellSurplusFactor: 2.2,
  /** Emergency starvation relief: days of food bought per purchase. */
  emergencyFoodDays: 4,
  /** Punitive price multiplier when a discovered neighbour can help. */
  emergencyNeighbourPrice: 1.8,
  /** Even with nobody on the map, a river trader will sell — at a price. */
  emergencyRiverTraderPrice: 2.2,
  /** One emergency purchase per this many days. */
  emergencyCooldownDays: 3,
  /** Emergency purchases are capped to keep them an act of desperation. */
  emergencyMaxUnits: 80,
} as const;

// ---------------------------------------------------------------------------
// System
// ---------------------------------------------------------------------------

export const economySystem: SimSystem = (ctx: SimContext): void => {
  const s = ctx.s;
  ensurePrices(ctx);
  updatePrices(ctx);
  marketShock(ctx);
  collectTaxesAndUpkeep(ctx);
  ensureTradeRoutes(ctx);
  processTradeRoutes(ctx);
  autoTrade(ctx);
  s.market.lastUpdateTick = ctx.tick;

  // Refresh storage accounting after every stock mover has run (population
  // consumption, taxes, trade purchases) so caches and a save/load rebuild
  // agree. economy runs late in the tick pipeline, after population.
  for (const st of s.settlements) st.storageUsed = round2(stockTotal(st));
};

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

function ensurePrices(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  for (const id of c.resourceOrder) {
    const def = c.resources[id];
    if (!def) continue;
    let info = s.market.prices[id];
    if (!info) {
      info = { price: def.basePrice, base: def.basePrice, supply: 0, demand: 0, trend: 0, history: [def.basePrice] };
      s.market.prices[id] = info;
    }
    info.base = def.basePrice;
    if (!Array.isArray(info.history)) info.history = [def.basePrice];
  }
  if (!Number.isFinite(s.market.tariff)) s.market.tariff = 0.04;
}

function targetStockFor(def: ResourceDef, pop: number, buildings: number): number {
  if (def.edible) {
    return Math.max(2, (pop * 0.6 * ECONOMY_TUNING.foodReserveDays) / Math.max(0.2, def.edible));
  }
  switch (def.category) {
    case 'raw':
      return Math.max(3, buildings * ECONOMY_TUNING.materialsPerBuilding);
    case 'refined':
    case 'component':
      return Math.max(1, buildings * 0.25);
    case 'energy':
      return Math.max(2, buildings * 0.3);
    case 'luxury':
    case 'science':
      return Math.max(1, buildings * 0.15);
    default:
      return 4;
  }
}

function estimatedDailyDemand(def: ResourceDef, pop: number): number {
  if (def.edible) return (pop * 0.6) / Math.max(0.2, def.edible);
  const tags = def.tags ?? [];
  if (def.category === 'energy' || tags.includes('fuel')) return Math.max(0.5, pop * 0.05);
  return Math.max(0.4, pop * 0.02);
}

/** Resources a settlement needs on hand for building and upkeep. */
const CONSTRUCTION_GOODS = new Set<string>([
  'stone',
  'wood',
  'clay',
  'fiber',
  'plank',
  'brick',
  'iron',
  'steel',
  'tools',
  'rope',
  'coal',
  'charcoal',
  'coke',
]);

/** A completed market or trade post is required for any market trade. */
function hasMarket(ctx: SimContext, st: Settlement): boolean {
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== st.id || b.progress < 1 || !b.enabled) continue;
    const def = ctx.c.buildings[b.typeId];
    if (!def) continue;
    if (b.typeId === 'market' || b.typeId === 'trade_post') return true;
    const tags = def.tags ?? [];
    if (tags.includes('market') || tags.includes('trade')) return true;
  }
  return false;
}

/** True when the settlement has a working building that yields this resource. */
function settlementProduces(ctx: SimContext, st: Settlement, resource: ResourceId): boolean {
  for (const b of ctx.s.buildings) {
    if (b.settlementId !== st.id || b.progress < 1 || !b.enabled) continue;
    const def = ctx.c.buildings[b.typeId];
    if (!def) continue;
    for (const rid of def.recipes) {
      const recipe = ctx.c.recipes[rid];
      if (!recipe) continue;
      if (recipe.gather?.resource === resource) return true;
      if ((recipe.outputs[resource] ?? 0) > 0) return true;
    }
  }
  return false;
}

function updatePrices(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  const pop = Math.max(1, totalPopulation(s));
  let buildings = 0;
  for (const b of s.buildings) if (b.progress >= 1) buildings++;

  const stockTotals = new Map<ResourceId, number>();
  for (const st of s.settlements) {
    for (const res in st.stock) {
      stockTotals.set(res, (stockTotals.get(res) ?? 0) + (st.stock[res] ?? 0));
    }
  }

  for (const id of c.resourceOrder) {
    const def = c.resources[id];
    const info = s.market.prices[id];
    if (!def || !info) continue;
    if (!(def.basePrice > 0)) continue;

    const stock = stockTotals.get(id) ?? 0;
    const target = targetStockFor(def, pop, buildings);
    const scarcity = clamp(target / Math.max(0.75, stock), 0.25, 4.5);
    // Today's player/route trades tilt the price before it settles back.
    const flow = clamp((info.demand - info.supply) / Math.max(1, info.demand + info.supply + 1), -1, 1);
    const targetPrice = clamp(
      info.base * scarcity * (1 + 0.35 * flow),
      info.base * ECONOMY_TUNING.minPriceFactor,
      info.base * ECONOMY_TUNING.maxPriceFactor,
    );

    const previous = info.price;
    let price =
      previous +
      (targetPrice - previous) * ECONOMY_TUNING.priceResponse +
      (info.base - previous) * ECONOMY_TUNING.priceMeanReversion;
    price = clamp(price, info.base * ECONOMY_TUNING.minPriceFactor, info.base * ECONOMY_TUNING.maxPriceFactor);

    info.price = Math.round(price * 100) / 100;
    info.supply = Math.round(stock * 10) / 10;
    info.demand = Math.round(estimatedDailyDemand(def, pop) * 10) / 10;
    info.trend = previous > 0 ? Math.round(((info.price - previous) / previous) * 1000) / 1000 : 0;
    info.history.push(info.price);
    while (info.history.length > ECONOMY_TUNING.priceHistoryLength) info.history.shift();
  }
}

function marketShock(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  const last = s.flags['last_market_shock'] ?? -999;
  if (ctx.tick - last < ECONOMY_TUNING.shockCooldownDays) return;
  if (ctx.rng() >= ECONOMY_TUNING.shockChance) return;

  const tradable: ResourceId[] = c.resourceOrder.filter((id) => c.resources[id]?.tradable);
  if (tradable.length === 0) return;
  const picked = tradable[Math.min(tradable.length - 1, Math.floor(ctx.rng() * tradable.length))];
  const info = s.market.prices[picked];
  const def = c.resources[picked];
  if (!info || !def) return;
  const multiplier = 0.7 + ctx.rng() * 0.7; // 0.7x .. 1.4x
  const before = info.price;
  info.price = clamp(round2(before * multiplier), info.base * 0.2, info.base * 6);
  info.trend = before > 0 ? round2((info.price - before) / before) : 0;
  info.history.push(info.price);
  while (info.history.length > ECONOMY_TUNING.priceHistoryLength) info.history.shift();
  s.flags['last_market_shock'] = ctx.tick;
  ctx.notify(
    `Word from the road: the price of ${def.name} ${info.price > before ? 'has jumped' : 'has dropped'} sharply.`,
    'info',
    'coin',
  );
}

// ---------------------------------------------------------------------------
// Taxes and coin upkeep
// ---------------------------------------------------------------------------

function collectTaxesAndUpkeep(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  const taxRate = clamp(s.society.taxRate ?? 0.12, 0, 0.45);
  for (const st of s.settlements) {
    const workforce = st.workforce > 0 ? st.workforce : st.population * 0.62;
    const efficiency = Math.max(0.1, 1 + modOf(ctx, st.id, 'taxEfficiency'));
    let income = workforce * ECONOMY_TUNING.taxIncomePerWorker * (taxRate / ECONOMY_TUNING.baselineTaxRate) * efficiency;

    let coinUpkeep = 0;
    for (const b of s.buildings) {
      if (b.settlementId !== st.id || b.progress < 1) continue;
      const def = c.buildings[b.typeId];
      if (!def) continue;
      let value = 0;
      for (const res in def.cost) value += (def.cost[res] ?? 0) * (c.resources[res]?.basePrice ?? 1);
      income += value * ECONOMY_TUNING.buildingTaxValueFactor * efficiency;
      if (b.enabled) coinUpkeep += ECONOMY_TUNING.coinUpkeepPerBuilding + value * ECONOMY_TUNING.coinUpkeepValueFactor;
    }

    coinUpkeep *= Math.max(0.2, 1 + modOf(ctx, st.id, 'upkeepCost'));

    if (income > 0) {
      st.treasury += income;
      st.taxesCollected = round2((st.taxesCollected ?? 0) + income);
    }
    if (coinUpkeep > 0) {
      const paid = Math.min(Math.max(0, st.treasury), coinUpkeep);
      st.treasury -= paid;
      st.upkeepPaid = round2((st.upkeepPaid ?? 0) + paid);
      if (paid < coinUpkeep - 0.01) {
        setSettlementAlert(st, {
          id: `treasury_empty_${st.id}`,
          kind: 'economy',
          severity: paid < coinUpkeep * 0.4 ? 3 : 1,
          title: 'Treasury thin',
          detail: 'Coin upkeep for buildings is going unpaid. Raise taxes or sell goods.',
          sinceTick: ctx.tick,
        });
      } else {
        clearSettlementAlert(st, 'economy', 'Treasury thin');
      }
    }
    if (st.treasury < 0) st.treasury = 0;
  }
}

// ---------------------------------------------------------------------------
// Neighbour trade routes
// ---------------------------------------------------------------------------

function ensureTradeRoutes(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  if (ctx.tick % ECONOMY_TUNING.routeRefreshDays !== 0) return;
  const st = capitalOf(s);
  if (!st) return;
  if (s.market.routes.length >= LIMITS.maxTradeRoutes) return;

  for (const civ of s.neighbors.civs) {
    if (!civ.discovered) continue;
    if (civ.relation === 'war') continue;
    const existing = s.market.routes.filter((r) => r.toKind === 'neighbor' && r.toId === civ.id && r.active);
    if (existing.length >= 2) continue;
    const eraFactor = 1 + s.research.era * 0.4;

    for (const resId of civ.exports) {
      if (s.market.routes.length >= LIMITS.maxTradeRoutes) return;
      if (!c.resources[resId]) continue;
      if (existing.some((r) => r.resource === resId && r.direction === 'import')) continue;
      s.market.routes.push({
        id: s.market.nextRouteId++,
        fromSettlement: st.id,
        toKind: 'neighbor',
        toId: civ.id,
        resource: resId,
        amountPerDay: Math.max(1, Math.round((1.5 + s.research.era) * eraFactor * 10) / 10),
        direction: 'import',
        active: true,
        establishedTick: ctx.tick,
      });
      ctx.notify(`A trade route opens with ${civ.name}: importing ${c.resources[resId]?.name ?? resId}.`, 'good', 'coin');
      existing.push(s.market.routes[s.market.routes.length - 1]);
    }

    for (const resId of civ.imports) {
      if (s.market.routes.length >= LIMITS.maxTradeRoutes) return;
      if (!c.resources[resId]) continue;
      if (stockOf(st, resId) < 25) continue;
      if (existing.some((r) => r.resource === resId && r.direction === 'export')) continue;
      s.market.routes.push({
        id: s.market.nextRouteId++,
        fromSettlement: st.id,
        toKind: 'neighbor',
        toId: civ.id,
        resource: resId,
        amountPerDay: Math.max(1, Math.round((1.5 + s.research.era * 0.6) * 10) / 10),
        direction: 'export',
        active: true,
        establishedTick: ctx.tick,
      });
      ctx.notify(`A trade route opens with ${civ.name}: exporting ${c.resources[resId]?.name ?? resId}.`, 'good', 'coin');
      existing.push(s.market.routes[s.market.routes.length - 1]);
    }
  }
}

function processTradeRoutes(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  if (s.market.caravans.length >= LOGISTICS_TUNING.maxCaravans - 4) return;

  for (const route of s.market.routes) {
    if (!route.active || route.toKind !== 'neighbor') continue;
    const st = settlementById(s, route.fromSettlement);
    if (!st) continue;
    const civ = s.neighbors.civs.find((n) => n.id === route.toId);
    const resDef = c.resources[route.resource];
    if (!civ || !civ.discovered || civ.relation === 'war' || !resDef) continue;

    const flag = `route_dispatch_${route.id}`;
    if (ctx.tick - (s.flags[flag] ?? -999) < ECONOMY_TUNING.routeDispatchInterval) continue;

    const interval = ECONOMY_TUNING.routeDispatchInterval;

    if (route.direction === 'import') {
      const amount = Math.max(1, Math.round(route.amountPerDay * interval));
      const unitPrice =
        (s.market.prices[route.resource]?.price ?? resDef.basePrice) *
        ECONOMY_TUNING.spread *
        (1 + s.market.tariff) *
        (1 + modOf(ctx, st.id, 'tradeBuyPrice'));
      const cost = unitPrice * amount;
      if (st.treasury < cost) continue;
      const cv = createCaravanFromPoint(
        ctx,
        civ.capital.x,
        civ.capital.y,
        st.x,
        st.y,
        { [route.resource]: amount },
        { kind: 'neighbor', routeId: route.id, label: `Import — ${resDef.name}`, color: '#7fc4a0' },
      );
      if (!cv) continue;
      st.treasury -= cost;
      st.tradeBalance -= cost;
      s.market.tradeBalance -= cost;
      const info = s.market.prices[route.resource];
      if (info) info.demand += amount;
      s.flags[flag] = ctx.tick;
    } else {
      // Export: send an empty caravan to collect from the settlement; logistics
      // loads it, turns it around and credits the treasury on the return leg.
      if (stockOf(st, route.resource) < 1) continue;
      const cv = createCaravanFromPoint(ctx, civ.capital.x, civ.capital.y, st.x, st.y, {}, {
        kind: 'neighbor',
        routeId: route.id,
        label: `Export — ${resDef.name}`,
        color: '#c9b6d6',
      });
      if (!cv) continue;
      s.flags[flag] = ctx.tick;
    }
  }
}

// ---------------------------------------------------------------------------
// Governor auto-trade
// ---------------------------------------------------------------------------

function autoTrade(ctx: SimContext): void {
  const s = ctx.s;
  const c = ctx.c;
  for (const st of s.settlements) {
    if (!st.governor.autoTrade) continue;
    // No market means no ordinary trade — but a starving settlement can still
    // pay ruinous prices for emergency relief (Lead fairness rule).
    if (!hasMarket(ctx, st)) {
      emergencyRelief(ctx, st);
      continue;
    }
    const flag = `autotrade_${st.id}`;
    if (ctx.tick - (s.flags[flag] ?? -999) < ECONOMY_TUNING.autoTradeInterval) continue;
    s.flags[flag] = ctx.tick;

    const reserve = Math.max(1, st.governor.reserveFoodDays);
    const days = foodDaysOf(s, c, st);

    // 1) Buy emergency food when reserves run low.
    if (days < reserve) {
      const neededUnits = (reserve - days) * st.population * 0.6;
      let best: { id: ResourceId; edible: number; unitCost: number; score: number } | null = null;
      for (const resId of c.resourceOrder) {
        const def = c.resources[resId];
        if (!def?.edible || !def.tradable) continue;
        const price = s.market.prices[resId]?.price ?? def.basePrice;
        if (!(price > 0)) continue;
        const unitCost = price * ECONOMY_TUNING.spread * (1 + s.market.tariff) * (1 + modOf(ctx, st.id, 'tradeBuyPrice'));
        const score = def.edible / unitCost;
        if (!best || score > best.score) best = { id: resId, edible: def.edible, unitCost, score };
      }
      if (best) {
        const affordable = st.treasury / Math.max(0.01, best.unitCost);
        const amount = Math.min(
          ECONOMY_TUNING.autoTradeMaxBuy,
          affordable,
          Math.max(0, neededUnits / Math.max(0.2, best.edible)),
        );
        if (amount >= 1) {
          const cost = amount * best.unitCost;
          st.treasury -= cost;
          st.tradeBalance -= cost;
          s.market.tradeBalance -= cost;
          addStock(st, best.id, amount);
          const info = s.market.prices[best.id];
          if (info) info.demand += amount;
          const nFlag = `autotrade_buy_${st.id}`;
          if (ctx.tick - (s.flags[nFlag] ?? -999) > 20) {
            s.flags[nFlag] = ctx.tick;
            ctx.notify(
              `${st.name} buys ${round1(amount)} ${c.resources[best.id]?.name ?? best.id} to fill its stores.`,
              'info',
              'coin',
            );
          }
        }
      }
    }

    // 2) Keep a little medicine on hand.
    if (stockOf(st, 'medicine') < 2 && c.resources['medicine'] && st.treasury > 25) {
      const price = s.market.prices['medicine']?.price ?? c.resources['medicine'].basePrice;
      const unitCost = price * ECONOMY_TUNING.spread * (1 + s.market.tariff) * (1 + modOf(ctx, st.id, 'tradeBuyPrice'));
      if (st.treasury > unitCost * 2) {
        const amount = Math.min(3, st.treasury / unitCost);
        st.treasury -= amount * unitCost;
        st.tradeBalance -= amount * unitCost;
        s.market.tradeBalance -= amount * unitCost;
        addStock(st, 'medicine', amount);
        const info = s.market.prices['medicine'];
        if (info) info.demand += amount;
      }
    }

    // 3) Sell genuine surpluses (never below the reserve target).
    const pop = Math.max(1, st.population);
    for (const resId of c.resourceOrder) {
      const def = c.resources[resId];
      if (!def?.tradable || !(def.basePrice > 0)) continue;
      if (resId === 'water') continue;
      // Never sell food out of a settlement that is not comfortably fed.
      if (def.edible) {
        const foodDays = foodDaysOf(s, c, st);
        if (foodDays < Math.max(8, reserve * 1.5)) continue;
      }
      const stock = stockOf(st, resId);
      const target = targetStockFor(def, pop, Math.max(1, st.buildings.length));
      let floorStock = Math.max(10, target * ECONOMY_TUNING.autoSellSurplusFactor);
      if (CONSTRUCTION_GOODS.has(resId)) {
        // Never sell the materials a settlement builds and repairs with.
        floorStock = Math.max(30, st.governor.reserveMaterials * 2.5);
        if (stock <= floorStock * 2) continue;
        if (!settlementProduces(ctx, st, resId)) continue;
      }
      if (stock < floorStock) continue;
      const info = s.market.prices[resId];
      const price = info?.price ?? def.basePrice;
      if (!(price > 0)) continue;
      let amount = Math.min(ECONOMY_TUNING.autoTradeMaxSell, stock - floorStock);
      if (def.edible) {
        // Only sell food genuinely beyond a comfortable buffer of days.
        const foodDays = foodDaysOf(s, c, st);
        const surplusDays = foodDays - Math.max(18, reserve * 2);
        if (surplusDays <= 0) continue;
        const dailyNeed = Math.max(0.05, pop * 0.6);
        amount = Math.min(amount, (surplusDays * dailyNeed) / Math.max(0.2, def.edible));
      }
      if (amount < 1) continue;
      const unit = price * (1 / ECONOMY_TUNING.spread) * (1 - s.market.tariff) * (1 + modOf(ctx, st.id, 'tradeSellPrice'));
      const total = unit * amount;
      removeStock(st, resId, amount);
      st.treasury += total;
      st.tradeBalance += total;
      s.market.tradeBalance += total;
      if (info) info.supply += amount;
      const nFlag = `autotrade_sell_${st.id}`;
      if (ctx.tick - (s.flags[nFlag] ?? -999) > 25) {
        s.flags[nFlag] = ctx.tick;
        ctx.notify(`${st.name} sells ${round1(amount)} surplus ${def.name} for ${Math.round(total)} coin.`, 'info', 'coin');
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Emergency relief (starvation backstop when there is no market)
// ---------------------------------------------------------------------------

/**
 * A settlement without a market cannot trade — but it must not be able to sit on
 * a thousand coins while its people starve. When food runs dangerously low we
 * allow a punitive emergency purchase: from a discovered, non-hostile neighbour
 * at 1.8x normal import cost, or from an abstract river trader at 2.2x even with
 * no neighbours discovered. Rate-limited and capped: it averts catastrophe for a
 * settlement with money, not for one without.
 */
function emergencyRelief(ctx: SimContext, st: Settlement): void {
  const s = ctx.s;
  const c = ctx.c;
  const reserve = Math.max(1, st.governor.reserveFoodDays);
  const days = foodDaysOf(s, c, st);
  // True starvation backstop, not routine shopping: only below ~5 days of food.
  const triggerDays = Math.max(2, Math.min(reserve, 5));
  if (days >= triggerDays) return;

  const flag = `emergency_relief_${st.id}`;
  if (ctx.tick - (s.flags[flag] ?? -999) < ECONOMY_TUNING.emergencyCooldownDays) return;

  // Who can sell? A discovered, non-hostile neighbour at a punitive-but-possible
  // price; otherwise the abstract river trader at the ruinous price.
  let hasHelpfulNeighbour = false;
  for (const civ of s.neighbors.civs) {
    if (!civ.discovered) continue;
    if (civ.relation === 'war') continue;
    hasHelpfulNeighbour = true;
    break;
  }
  const priceMultiplier = hasHelpfulNeighbour
    ? ECONOMY_TUNING.emergencyNeighbourPrice
    : ECONOMY_TUNING.emergencyRiverTraderPrice;

  // Pick the most calorie-dense affordable edible.
  const neededFoodUnits = (reserve - days) * Math.max(0.1, st.population * 0.6);
  const targetPurchaseUnits = Math.max(neededFoodUnits, st.population * 0.6 * ECONOMY_TUNING.emergencyFoodDays);
  let best: { id: ResourceId; edible: number; unitCost: number; score: number } | null = null;
  for (const resId of c.resourceOrder) {
    const def = c.resources[resId];
    if (!def?.edible) continue;
    const price = s.market.prices[resId]?.price ?? def.basePrice;
    if (!(price > 0)) continue;
    const unitCost =
      price * priceMultiplier * (1 + s.market.tariff) * (1 + modOf(ctx, st.id, 'tradeBuyPrice'));
    if (st.treasury < unitCost) continue;
    const score = def.edible / unitCost;
    if (!best || score > best.score) best = { id: resId, edible: def.edible, unitCost, score };
  }
  if (!best) return; // no money: the famine remains a real risk, as it should be

  const affordable = st.treasury / best.unitCost;
  const amount = Math.floor(
    Math.max(0, Math.min(ECONOMY_TUNING.emergencyMaxUnits, affordable, targetPurchaseUnits / Math.max(0.2, best.edible))),
  );
  if (amount < 1) return;

  const cost = amount * best.unitCost;
  st.treasury -= cost;
  st.tradeBalance -= cost;
  s.market.tradeBalance -= cost;
  // Make room for relief food if the storehouse is packed with dry goods.
  const space = Math.max(0, st.storageCap - stockTotal(st));
  if (space < amount) freeStorageSpace(ctx, st, amount - space);
  addStock(st, best.id, amount);
  const info = s.market.prices[best.id];
  if (info) info.demand += amount;
  s.flags[flag] = ctx.tick;
  const source = hasHelpfulNeighbour ? 'a neighbour' : 'a river trader';
  ctx.notify(
    `Emergency relief: ${st.name} buys ${round1(amount)} ${c.resources[best.id]?.name ?? best.id} from ${source} at ruinous prices.`,
    'warn',
    'coin',
  );
}

// ---------------------------------------------------------------------------
// Helpers for UI / other systems
// ---------------------------------------------------------------------------

/** Current market price for a resource (falls back to base price). */
export function priceOf(state: GameState, resource: ResourceId, content?: Content): number {
  const info = state.market.prices[resource];
  if (info && Number.isFinite(info.price) && info.price > 0) return info.price;
  const base = content?.resources[resource]?.basePrice;
  return typeof base === 'number' && base > 0 ? base : 1;
}

/** Rough units of a good the market would move in a day (for UI tooltips). */
export function dailyVolume(state: GameState, resource: ResourceId): number {
  const info: PriceInfo | undefined = state.market.prices[resource];
  if (!info) return 0;
  return Math.max(0, info.demand ?? 0);
}

/** Clamp helper kept local so this module has no dependency on renderer code. */
export function exportableEconomySummary(state: GameState): {
  tradeBalance: number;
  routes: number;
  caravans: number;
  tariff: number;
} {
  return {
    tradeBalance: round2(state.market.tradeBalance),
    routes: state.market.routes.filter((r) => r.active).length,
    caravans: state.market.caravans.length,
    tariff: state.market.tariff,
  };
}
