import { gameEvents } from "./events";
import { GameState, isZoneKind, ToolKind } from "./state";

export const COSTS = {
  road: 10,
  zone: 5,
  bulldoze: 2,
  garden: 60,
} as const;

export interface ActionResult {
  ok: boolean;
  changed: boolean;
  reason?: string;
}

function inBounds(state: GameState, x: number, y: number): boolean {
  return x >= 0 && x < state.gridSize && y >= 0 && y < state.gridSize;
}

export function placeRoad(state: GameState, x: number, y: number): ActionResult {
  if (!inBounds(state, x, y)) {
    return { ok: false, changed: false, reason: "Out of grid bounds" };
  }
  const tile = state.grid[y][x];
  if (tile.kind === "road") {
    return { ok: true, changed: false };
  }
  if (state.money < COSTS.road) {
    return {
      ok: false,
      changed: false,
      reason: `Not enough money ($${COSTS.road} needed for a road, you have $${state.money})`,
    };
  }

  state.money -= COSTS.road;
  tile.kind = "road";
  tile.building = undefined;
  tile.zonedTick = undefined;
  tile.load = 0;

  gameEvents.emit("placed", {
    tick: state.tick,
    x,
    y,
    kind: "road",
    amount: COSTS.road,
    message: `Built road at (${x}, ${y})`,
  });

  return { ok: true, changed: true };
}

export function zone(
  state: GameState,
  x: number,
  y: number,
  kind: "res" | "com" | "ind",
): ActionResult {
  if (!inBounds(state, x, y)) {
    return { ok: false, changed: false, reason: "Out of grid bounds" };
  }
  const tile = state.grid[y][x];
  if (tile.kind === kind) {
    return { ok: true, changed: false };
  }
  if (tile.kind === "road") {
    return {
      ok: false,
      changed: false,
      reason: "Bulldoze the road first before zoning this tile",
    };
  }
  if (state.money < COSTS.zone) {
    const label =
      kind === "res" ? "Residential" : kind === "com" ? "Commercial" : "Industrial";
    return {
      ok: false,
      changed: false,
      reason: `Not enough money ($${COSTS.zone} needed to zone ${label})`,
    };
  }

  state.money -= COSTS.zone;
  tile.kind = kind;
  tile.building = undefined;
  tile.zonedTick = state.tick;

  gameEvents.emit("placed", {
    tick: state.tick,
    x,
    y,
    kind,
    amount: COSTS.zone,
    message: `Zoned ${kind.toUpperCase()} at (${x}, ${y})`,
  });

  return { ok: true, changed: true };
}

export function placeGarden(state: GameState, x: number, y: number): ActionResult {
  if (!inBounds(state, x, y)) {
    return { ok: false, changed: false, reason: "Out of grid bounds" };
  }
  const tile = state.grid[y][x];
  if (
    (tile.kind !== "res" && tile.kind !== "com") ||
    !tile.building ||
    tile.building.level < 1
  ) {
    return {
      ok: false,
      changed: false,
      reason:
        "Rooftop gardens require a Residential or Commercial building (level 1+)",
    };
  }
  if (tile.building.garden) {
    return { ok: true, changed: false };
  }
  if (state.money < COSTS.garden) {
    return {
      ok: false,
      changed: false,
      reason: `Not enough money ($${COSTS.garden} needed for a rooftop garden)`,
    };
  }

  state.money -= COSTS.garden;
  tile.building.garden = true;
  tile.building.gardenPlantedAt = performance.now();

  gameEvents.emit("garden planted", {
    tick: state.tick,
    x,
    y,
    kind: "garden",
    amount: COSTS.garden,
    message: `Planted rooftop garden at (${x}, ${y})`,
  });

  return { ok: true, changed: true };
}

export function bulldoze(state: GameState, x: number, y: number): ActionResult {
  if (!inBounds(state, x, y)) {
    return { ok: false, changed: false, reason: "Out of grid bounds" };
  }
  const tile = state.grid[y][x];
  if (tile.kind === "empty" && !tile.building) {
    return { ok: true, changed: false };
  }
  if (state.money < COSTS.bulldoze) {
    return {
      ok: false,
      changed: false,
      reason: `Not enough money ($${COSTS.bulldoze} needed to clear tile)`,
    };
  }

  state.money -= COSTS.bulldoze;
  tile.kind = "empty";
  tile.building = undefined;
  tile.zonedTick = undefined;
  tile.load = 0;

  gameEvents.emit("placed", {
    tick: state.tick,
    x,
    y,
    kind: "bulldoze",
    amount: COSTS.bulldoze,
    message: `Cleared tile (${x}, ${y})`,
  });

  return { ok: true, changed: true };
}

export function applyToolAt(
  state: GameState,
  x: number,
  y: number,
  tool: ToolKind,
): ActionResult {
  if (tool === "select") {
    return { ok: true, changed: false };
  }
  if (tool === "road") {
    return placeRoad(state, x, y);
  }
  if (tool === "garden") {
    return placeGarden(state, x, y);
  }
  if (tool === "bulldoze" || tool === "empty") {
    return bulldoze(state, x, y);
  }
  if (isZoneKind(tool)) {
    return zone(state, x, y, tool);
  }
  return { ok: false, changed: false, reason: "Unsupported tool" };
}
