import { gameEvents } from "./events";
import { buildRoadGraph, findRoadPath, getAdjacentRoads, GridPoint, tileKey } from "./roads";
import { GameState, isZoneKind } from "./state";

export const MAX_CARS = 300;
const SPAWN_INTERVAL_TICKS = 3;

export const CAR_COLORS = [
  0xe06d53, // terracotta coral
  0xf4b942, // warm marigold taxi
  0x4ea8de, // sky teal blue
  0x52b788, // sage mint green
  0xf2e9e4, // cream ivory
];

export interface Car {
  id: number;
  path: GridPoint[];
  segmentIndex: number;
  progress: number;
  prevSegmentIndex: number;
  prevProgress: number;
  speed: number;
  color: number;
  ticksElapsed: number;
}

export interface JammedRoadTile {
  x: number;
  y: number;
  load: number;
}

export interface TrafficSystem {
  cars: Car[];
  nextCarId: number;
  completedTripTimes: number[];
  averageTripTime: number;
  congestionPercent: number;
  noRoadAccessCount: number;
  jammedTiles: JammedRoadTile[];
  lastJamAlertTick: number;
}

export function createTrafficSystem(): TrafficSystem {
  return {
    cars: [],
    nextCarId: 1,
    completedTripTimes: [],
    averageTripTime: 0,
    congestionPercent: 0,
    noRoadAccessCount: 0,
    jammedTiles: [],
    lastJamAlertTick: -999,
  };
}

export function stepTraffic(state: GameState, traffic: TrafficSystem): void {
  const graph = buildRoadGraph(state);

  // 1. Decay per-tile road load
  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (tile.kind === "road") {
        tile.load = Math.max(0, (tile.load ?? 0) * 0.78);
      } else {
        tile.load = 0;
      }
    }
  }

  // 2. Count cars currently on each road tile
  const tileOccupancy = new Map<string, number>();
  for (const car of traffic.cars) {
    const pt = car.path[car.segmentIndex];
    if (pt) {
      const k = tileKey(pt.x, pt.y);
      tileOccupancy.set(k, (tileOccupancy.get(k) ?? 0) + 1);
    }
  }

  // 3. Advance existing cars along their paths
  const survivingCars: Car[] = [];
  for (const car of traffic.cars) {
    car.prevSegmentIndex = car.segmentIndex;
    car.prevProgress = car.progress;
    car.ticksElapsed += 1;

    // Verify current and next road tiles still exist (in case player bulldozed road)
    const currPt = car.path[car.segmentIndex];
    const nextPt = car.path[car.segmentIndex + 1];
    if (
      !currPt ||
      state.grid[currPt.y]?.[currPt.x]?.kind !== "road" ||
      (nextPt && state.grid[nextPt.y]?.[nextPt.x]?.kind !== "road")
    ) {
      continue;
    }

    if (!nextPt) {
      // Reached final node
      recordTripCompletion(traffic, car.ticksElapsed);
      continue;
    }

    const nextKey = tileKey(nextPt.x, nextPt.y);
    const carsAhead = tileOccupancy.get(nextKey) ?? 0;

    // Slow down when next tile holds more than 3 cars
    const congestionFactor = carsAhead > 3 ? 0.32 : 1.0;
    const stepDist = car.speed * congestionFactor;

    car.progress += stepDist;
    const currTile = state.grid[currPt.y][currPt.x];
    const currOcc = tileOccupancy.get(tileKey(currPt.x, currPt.y)) ?? 1;
    currTile.load = Math.min(
      12,
      (currTile.load ?? 0) + (currOcc >= 3 || carsAhead >= 3 ? 0.85 : 0.18),
    );

    if (car.progress >= 1) {
      car.progress -= 1;
      car.segmentIndex += 1;

      const enteredPt = car.path[car.segmentIndex];
      if (enteredPt && state.grid[enteredPt.y]?.[enteredPt.x]?.kind === "road") {
        const enteredTile = state.grid[enteredPt.y][enteredPt.x];
        enteredTile.load = Math.min(
          12,
          (enteredTile.load ?? 0) + (carsAhead >= 3 ? 0.95 : 0.22),
        );
      }

      if (car.segmentIndex >= car.path.length - 1) {
        recordTripCompletion(traffic, car.ticksElapsed);
        continue;
      }
    }

    survivingCars.push(car);
  }
  traffic.cars = survivingCars;

  // 4. Spawn new trips every N ticks & update 'no road access' flags
  const buildingsByZone: Array<{
    x: number;
    y: number;
    kind: "res" | "com" | "ind";
    level: number;
    adjRoads: GridPoint[];
  }> = [];

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (isZoneKind(tile.kind) && tile.building && tile.building.level > 0) {
        const adjRoads = getAdjacentRoads(state, x, y);
        buildingsByZone.push({
          x,
          y,
          kind: tile.kind,
          level: tile.building.level,
          adjRoads,
        });
      }
    }
  }

  let noRoadAccessCount = 0;
  const shouldSpawn = state.tick % SPAWN_INTERVAL_TICKS === 0;

  for (let i = 0; i < buildingsByZone.length; i++) {
    const src = buildingsByZone[i];
    const tile = state.grid[src.y][src.x];
    if (!tile.building) continue;

    if (src.adjRoads.length === 0) {
      tile.building.noRoadAccess = true;
      noRoadAccessCount += 1;
      continue;
    }

    // Find candidate destinations of another zone type that also have road access
    const otherZoneCandidates = buildingsByZone.filter(
      (b) => b.kind !== src.kind && b.adjRoads.length > 0,
    );

    if (otherZoneCandidates.length === 0) {
      tile.building.noRoadAccess = false;
      continue;
    }

    // Pick a deterministic-yet-varied target order so trips distribute across destinations
    const startOffset = (state.tick + i * 5) % otherZoneCandidates.length;
    let foundPath: GridPoint[] | null = null;

    for (let k = 0; k < otherZoneCandidates.length; k++) {
      const dst = otherZoneCandidates[(startOffset + k) % otherZoneCandidates.length];
      const startRoad = src.adjRoads[0];
      const endRoad = dst.adjRoads[0];
      const path = findRoadPath(graph, startRoad, endRoad);
      if (path && path.length >= 1) {
        foundPath = path;
        break;
      }
    }

    tile.building.noRoadAccess = false;

    if (!foundPath) {
      continue;
    }

    if (shouldSpawn && traffic.cars.length < MAX_CARS && foundPath.length >= 2) {
      const color = CAR_COLORS[traffic.nextCarId % CAR_COLORS.length];
      const speed = 0.34 + ((traffic.nextCarId * 17) % 10) * 0.012;
      traffic.cars.push({
        id: traffic.nextCarId++,
        path: foundPath,
        segmentIndex: 0,
        progress: 0,
        prevSegmentIndex: 0,
        prevProgress: 0,
        speed,
        color,
        ticksElapsed: 0,
      });
    }
  }

  traffic.noRoadAccessCount = noRoadAccessCount;

  // 5. Compute congestion %, jammed tiles (load > 5), and average trip time
  let roadCount = 0;
  let loadSum = 0;
  let congestedRoads = 0;
  const jammedTiles: JammedRoadTile[] = [];

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (tile.kind === "road") {
        roadCount += 1;
        const load = tile.load ?? 0;
        loadSum += Math.min(1, load / 8);
        if (load > 5) {
          congestedRoads += 1;
          jammedTiles.push({
            x,
            y,
            load: Math.round(load * 10) / 10,
          });
        }
      }
    }
  }

  jammedTiles.sort((a, b) => b.load - a.load);
  traffic.jammedTiles = jammedTiles;

  if (
    jammedTiles.length > 0 &&
    state.tick - traffic.lastJamAlertTick >= 15
  ) {
    traffic.lastJamAlertTick = state.tick;
    const worst = jammedTiles[0];
    gameEvents.emit("traffic_jam", {
      tick: state.tick,
      x: worst.x,
      y: worst.y,
      amount: worst.load,
      message: `Traffic jam alert on road (${worst.x}, ${worst.y}) — load ${worst.load}!`,
    });
  }

  if (roadCount > 0) {
    const avgLoadRatio = loadSum / roadCount;
    const congestedRatio = congestedRoads / roadCount;
    traffic.congestionPercent = Math.min(
      100,
      Math.round((avgLoadRatio * 0.65 + congestedRatio * 0.35) * 100),
    );
  } else {
    traffic.congestionPercent = 0;
  }

  if (traffic.completedTripTimes.length > 0) {
    const sum = traffic.completedTripTimes.reduce((a, b) => a + b, 0);
    traffic.averageTripTime = Math.round((sum / traffic.completedTripTimes.length) * 10) / 10;
  } else if (traffic.cars.length > 0) {
    const sum = traffic.cars.reduce((a, c) => a + c.ticksElapsed, 0);
    traffic.averageTripTime = Math.round((sum / traffic.cars.length) * 10) / 10;
  } else {
    traffic.averageTripTime = 0;
  }
}

function recordTripCompletion(traffic: TrafficSystem, ticks: number) {
  traffic.completedTripTimes.push(ticks);
  if (traffic.completedTripTimes.length > 60) {
    traffic.completedTripTimes.shift();
  }
}

/**
 * Computes interpolated world position and heading for a car with right-lane offset.
 */
export function getCarInterpolatedTransform(
  car: Car,
  alpha: number,
): { gx: number; gy: number; dirX: number; dirY: number } {
  const clampedAlpha = Math.max(0, Math.min(1, alpha));

  const prevIdx = Math.min(car.prevSegmentIndex, car.path.length - 1);
  const currIdx = Math.min(car.segmentIndex, car.path.length - 1);

  const prevNextIdx = Math.min(prevIdx + 1, car.path.length - 1);
  const currNextIdx = Math.min(currIdx + 1, car.path.length - 1);

  const p0x =
    car.path[prevIdx].x +
    (car.path[prevNextIdx].x - car.path[prevIdx].x) * car.prevProgress;
  const p0y =
    car.path[prevIdx].y +
    (car.path[prevNextIdx].y - car.path[prevIdx].y) * car.prevProgress;

  const p1x =
    car.path[currIdx].x +
    (car.path[currNextIdx].x - car.path[currIdx].x) * car.progress;
  const p1y =
    car.path[currIdx].y +
    (car.path[currNextIdx].y - car.path[currIdx].y) * car.progress;

  const baseGx = p0x + (p1x - p0x) * clampedAlpha;
  const baseGy = p0y + (p1y - p0y) * clampedAlpha;

  let dx = car.path[currNextIdx].x - car.path[currIdx].x;
  let dy = car.path[currNextIdx].y - car.path[currIdx].y;
  if (dx === 0 && dy === 0 && currIdx > 0) {
    dx = car.path[currIdx].x - car.path[currIdx - 1].x;
    dy = car.path[currIdx].y - car.path[currIdx - 1].y;
  }
  const len = Math.hypot(dx, dy) || 1;
  const dirX = dx / len;
  const dirY = dy / len;

  const rightLaneOffset = 0.18;
  const gx = baseGx + -dirY * rightLaneOffset;
  const gy = baseGy + dirX * rightLaneOffset;

  return { gx, gy, dirX, dirY };
}
