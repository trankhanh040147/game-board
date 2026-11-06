import { gameEvents } from "./events";
import { GameState, hasAdjacentRoad, isZoneKind } from "./state";
import { TrafficSystem } from "./traffic";

export interface DemandBars {
  res: number; // 0..100
  com: number; // 0..100
  ind: number; // 0..100
}

export interface EconomyMetrics {
  population: number;
  jobs: number;
  taxesPerDay: number;
  upkeepPerDay: number;
  netIncomePerDay: number;
  demand: DemandBars;
  happiness: number;
  greenPoints: number;
  greenCoveragePercent: number;
  gardensCount: number;
  pollutionPenalty: number;
  greenCityBonusActive: boolean;
}

export function createInitialEconomy(): EconomyMetrics {
  return {
    population: 0,
    jobs: 0,
    taxesPerDay: 0,
    upkeepPerDay: 0,
    netIncomePerDay: 0,
    demand: { res: 75, com: 55, ind: 60 },
    happiness: 75,
    greenPoints: 0,
    greenCoveragePercent: 0,
    gardensCount: 0,
    pollutionPenalty: 0,
    greenCityBonusActive: false,
  };
}

export function computeEconomyMetrics(
  state: GameState,
  traffic: TrafficSystem,
  prevGreenPoints: number = 0,
): EconomyMetrics {
  let population = 0;
  let jobs = 0;
  let rawTaxes = 0;
  let roadCount = 0;
  let resComBuildings = 0;
  let totalBuildings = 0;
  let gardensCount = 0;

  const homes: Array<{ x: number; y: number; level: number }> = [];
  const industries: Array<{ x: number; y: number; level: number }> = [];
  const gardens: Array<{ x: number; y: number }> = [];

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (tile.kind === "road") {
        roadCount += 1;
      }

      if (!tile.building || tile.building.level <= 0) continue;
      const lvl = tile.building.level;
      totalBuildings += 1;

      const gardenTaxMult = tile.building.garden ? 1.15 : 1.0;

      if (tile.kind === "res") {
        population += lvl * 4;
        rawTaxes += lvl * 6 * gardenTaxMult;
        resComBuildings += 1;
        homes.push({ x, y, level: lvl });
      } else if (tile.kind === "com") {
        jobs += lvl * 4;
        rawTaxes += lvl * 8 * gardenTaxMult;
        resComBuildings += 1;
      } else if (tile.kind === "ind") {
        jobs += lvl * 6;
        rawTaxes += lvl * 9 * gardenTaxMult;
        industries.push({ x, y, level: lvl });
      }

      if (tile.building.garden) {
        gardensCount += 1;
        gardens.push({ x, y });
      }
    }
  }

  state.peakPopulation = Math.max(state.peakPopulation ?? 0, population);

  const greenCoveragePercent =
    resComBuildings > 0
      ? Math.min(100, Math.round((gardensCount / resComBuildings) * 100))
      : 0;
  const greenCityBonusActive = greenCoveragePercent > 25 && gardensCount > 0;

  const ecoBonusTax = greenCityBonusActive ? 15 : 0;
  const taxesPerDay = Math.round(rawTaxes) + ecoBonusTax;
  const upkeepPerDay = Math.round(roadCount * 0.5);
  const netIncomePerDay = taxesPerDay - upkeepPerDay;

  // Check industrial pollution near homes within 3 tiles
  let pollutedHomes = 0;
  let gardenBoostedHomes = 0;

  for (const home of homes) {
    let nearInd = false;
    for (const ind of industries) {
      const dist = Math.max(Math.abs(home.x - ind.x), Math.abs(home.y - ind.y));
      if (dist <= 3) {
        nearInd = true;
        break;
      }
    }
    if (nearInd) {
      pollutedHomes += 1;
    }

    let nearGarden = false;
    for (const g of gardens) {
      const dist = Math.max(Math.abs(home.x - g.x), Math.abs(home.y - g.y));
      if (dist <= 3) {
        nearGarden = true;
        break;
      }
    }
    if (nearGarden) {
      gardenBoostedHomes += 1;
    }
  }

  // Rooftop gardens mitigate industrial pollution
  const rawPollutionPenalty =
    homes.length > 0 ? Math.round((pollutedHomes / homes.length) * 28) : 0;
  const gardenMitigation = Math.min(rawPollutionPenalty, gardensCount * 4);
  const pollutionPenalty = Math.max(0, rawPollutionPenalty - gardenMitigation);

  // Traffic congestion penalty
  const congestionPenalty = Math.round(traffic.congestionPercent * 0.25);

  // Unemployment / no-jobs penalty (grace period under 20 pop before Commercial unlocks)
  const effectivePopForJobs = Math.max(0, population - 16);
  const workersNeeded = Math.round(effectivePopForJobs * 0.65);
  let noJobsPenalty = 0;
  if (workersNeeded > 0 && jobs < workersNeeded) {
    const shortageRatio = (workersNeeded - jobs) / workersNeeded;
    noJobsPenalty = Math.round(shortageRatio * 24);
  }

  // No road access penalty
  const disconnectedPenalty = Math.min(18, traffic.noRoadAccessCount * 4);

  // Rooftop garden & Green City bonuses
  const gardenRadiusBonus = Math.min(25, gardenBoostedHomes * 4 + gardensCount * 5);
  const greenCityHappinessBonus = greenCityBonusActive ? 6 : 0;

  const rawHappiness =
    74 -
    pollutionPenalty -
    congestionPenalty -
    noJobsPenalty -
    disconnectedPenalty +
    gardenRadiusBonus +
    greenCityHappinessBonus;

  const happiness = Math.max(0, Math.min(100, Math.round(rawHappiness)));

  // RCI demand calculation (0..100)
  const resBalance = jobs - workersNeeded;
  const resDemand = Math.max(
    15,
    Math.min(
      100,
      Math.round(55 + resBalance * 2.2 + (happiness - 50) * 0.4),
    ),
  );

  const comTargetJobs = Math.max(4, Math.round(population * 0.4));
  const comJobsCurrent = totalBuildings > 0 ? jobs * 0.45 : 0;
  const comDemand = Math.max(
    15,
    Math.min(100, Math.round(50 + (comTargetJobs - comJobsCurrent) * 3.0)),
  );

  const indTargetJobs = Math.max(6, Math.round(population * 0.45));
  const indJobsCurrent = totalBuildings > 0 ? jobs * 0.55 : 0;
  const indDemand = Math.max(
    15,
    Math.min(100, Math.round(55 + (indTargetJobs - indJobsCurrent) * 2.5)),
  );

  return {
    population,
    jobs,
    taxesPerDay,
    upkeepPerDay,
    netIncomePerDay,
    demand: {
      res: resDemand,
      com: comDemand,
      ind: indDemand,
    },
    happiness,
    greenPoints: prevGreenPoints,
    greenCoveragePercent,
    gardensCount,
    pollutionPenalty,
    greenCityBonusActive,
  };
}

export function hasGardenWithinRadius(
  state: GameState,
  cx: number,
  cy: number,
  radius: number = 3,
): boolean {
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx >= 0 && nx < state.gridSize && ny >= 0 && ny < state.gridSize) {
        if (state.grid[ny][nx].building?.garden) {
          return true;
        }
      }
    }
  }
  return false;
}

export function stepEconomyAndGrowth(
  state: GameState,
  traffic: TrafficSystem,
  prevEconomy: EconomyMetrics,
): { economy: EconomyMetrics; changed: boolean } {
  let changed = false;
  state.tick += 1;

  const isNewDay = state.tick % 10 === 0;
  if (isNewDay) {
    state.day += 1;
    changed = true;
  }

  const metrics = computeEconomyMetrics(state, traffic, prevEconomy.greenPoints);

  // Trickle of green points from rooftop gardens
  if (metrics.gardensCount > 0) {
    metrics.greenPoints =
      Math.round((metrics.greenPoints + metrics.gardensCount * 0.25) * 10) / 10;
  }

  // Trigger Green City bonus when green roof coverage > 25%
  if (
    metrics.greenCityBonusActive &&
    (state.greenBonusLastDay === undefined || state.greenBonusLastDay === 0)
  ) {
    state.greenBonusLastDay = state.day;
    state.money += 50;
    changed = true;
    gameEvents.emit("green_city", {
      tick: state.tick,
      amount: 50,
      message: `Green City Bonus! ${metrics.greenCoveragePercent}% green roofs (+$50 eco grant & +mood)`,
    });
  } else if (
    isNewDay &&
    metrics.greenCityBonusActive &&
    state.day - (state.greenBonusLastDay ?? 0) >= 3
  ) {
    state.greenBonusLastDay = state.day;
    state.money += 40;
    gameEvents.emit("green_city", {
      tick: state.tick,
      amount: 40,
      message: `Green City Eco Grant! ${metrics.greenCoveragePercent}% rooftop garden coverage (+$40)`,
    });
  }

  // Apply daily taxes and road upkeep on day rollover
  if (isNewDay) {
    state.money = Math.max(0, state.money + metrics.netIncomePerDay);
    if (metrics.netIncomePerDay !== 0) {
      gameEvents.emit("income", {
        tick: state.tick,
        amount: metrics.netIncomePerDay,
        message:
          metrics.netIncomePerDay >= 0
            ? `Daily treasury income +$${metrics.netIncomePerDay}`
            : `Daily upkeep cost -$${Math.abs(metrics.netIncomePerDay)}`,
      });
    }
  }

  // Drive zone spawning & building level growth from RCI demand and happiness
  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (!isZoneKind(tile.kind)) continue;

      const roadAdj = hasAdjacentRoad(state, x, y);
      const zoneDemand = metrics.demand[tile.kind];

      if (!tile.building) {
        if (roadAdj && zoneDemand >= 15) {
          const zonedTick = tile.zonedTick ?? state.tick;
          tile.zonedTick = zonedTick;
          const waitTicks = zoneDemand >= 65 ? 2 : 3;
          if (state.tick - zonedTick >= waitTicks) {
            tile.building = {
              level: 1,
              garden: false,
              spawnedAt: performance.now(),
              noRoadAccess: false,
            };
            changed = true;
            gameEvents.emit("built", {
              tick: state.tick,
              x,
              y,
              kind: tile.kind,
              level: 1,
              message: `New ${tile.kind.toUpperCase()} building built at (${x}, ${y})`,
            });
          }
        }
      } else if (roadAdj && !tile.building.noRoadAccess && tile.building.level < 3) {
        const nearGarden = hasGardenWithinRadius(state, x, y, 3);
        const growthThreshold = nearGarden ? 28 : 40;
        if (zoneDemand >= growthThreshold && metrics.happiness >= 35) {
          const age = state.tick - (tile.zonedTick ?? 0);
          const interval = nearGarden ? 8 : 12;
          if (
            age > 0 &&
            age % interval === 0 &&
            (x * 7 + y * 13 + state.tick) % 2 === 0
          ) {
            tile.building.level += 1;
            tile.building.spawnedAt = performance.now();
            changed = true;
            gameEvents.emit("grown", {
              tick: state.tick,
              x,
              y,
              kind: tile.kind,
              level: tile.building.level,
              message: `Building at (${x}, ${y}) grew to Level ${tile.building.level}`,
            });
          }
        }
      }
    }
  }

  const updatedEconomy = computeEconomyMetrics(state, traffic, metrics.greenPoints);
  return { economy: updatedEconomy, changed };
}
