export type TileKind = "empty" | "road" | "res" | "com" | "ind";

export type ToolKind = TileKind | "bulldoze" | "garden" | "select";

export interface Building {
  level: number;
  garden: boolean;
  gardenPlantedAt?: number;
  spawnedAt?: number;
  noRoadAccess?: boolean;
}

export interface Tile {
  x: number;
  y: number;
  kind: TileKind;
  building?: Building;
  zonedTick?: number;
  load?: number;
}

export interface TileSnapshot {
  x: number;
  y: number;
  kind: TileKind;
  building?: Building;
  zonedTick?: number;
  load?: number;
}

export interface PlacementUndo {
  label: string;
  tool: ToolKind;
  previousMoney: number;
  tiles: TileSnapshot[];
}

export interface GameState {
  gridSize: number;
  grid: Tile[][];
  money: number;
  day: number;
  tick: number;
  greenPoints?: number;
  goalsDone?: string[];
  peakPopulation?: number;
  greenBonusLastDay?: number;
}

export const GRID_SIZE = 32;
export const INITIAL_MONEY = 2000;
export const STORAGE_KEY = "seleya_iso_city_v1";
export const GOALS_STORAGE_KEY = "seleya_iso_city_goals_v1";

export function createEmptyGrid(size: number = GRID_SIZE): Tile[][] {
  const grid: Tile[][] = [];
  for (let y = 0; y < size; y++) {
    const row: Tile[] = [];
    for (let x = 0; x < size; x++) {
      row.push({
        x,
        y,
        kind: "empty",
        load: 0,
      });
    }
    grid.push(row);
  }
  return grid;
}

export function createInitialState(): GameState {
  return {
    gridSize: GRID_SIZE,
    grid: createEmptyGrid(GRID_SIZE),
    money: INITIAL_MONEY,
    day: 1,
    tick: 0,
    greenPoints: 0,
    goalsDone: [],
    peakPopulation: 0,
    greenBonusLastDay: 0,
  };
}

export function captureTileSnapshot(tile: Tile): TileSnapshot {
  return {
    x: tile.x,
    y: tile.y,
    kind: tile.kind,
    building: tile.building ? { ...tile.building } : undefined,
    zonedTick: tile.zonedTick,
    load: tile.load,
  };
}

export function restorePlacementUndo(state: GameState, undo: PlacementUndo): boolean {
  if (!undo.tiles.length) return false;
  for (const snap of undo.tiles) {
    if (snap.y >= 0 && snap.y < state.gridSize && snap.x >= 0 && snap.x < state.gridSize) {
      const target = state.grid[snap.y][snap.x];
      target.kind = snap.kind;
      target.building = snap.building ? { ...snap.building } : undefined;
      target.zonedTick = snap.zonedTick;
      target.load = snap.load ?? 0;
    }
  }
  state.money = undo.previousMoney;
  return true;
}

export function saveStateToStorage(state: GameState): boolean {
  try {
    const payload = {
      version: 1,
      savedAt: Date.now(),
      state,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    window.localStorage.setItem(
      GOALS_STORAGE_KEY,
      JSON.stringify(state.goalsDone ?? []),
    );
    return true;
  } catch {
    return false;
  }
}

export function loadStateFromStorage(): GameState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { version?: number; state?: GameState };
    if (parsed?.version !== 1 || !parsed.state) return null;
    const s = parsed.state;
    if (
      typeof s.money !== "number" ||
      typeof s.day !== "number" ||
      !Array.isArray(s.grid) ||
      s.grid.length !== GRID_SIZE
    ) {
      return null;
    }
    if (!Array.isArray(s.goalsDone)) {
      try {
        const rawGoals = window.localStorage.getItem(GOALS_STORAGE_KEY);
        s.goalsDone = rawGoals ? (JSON.parse(rawGoals) as string[]) : [];
      } catch {
        s.goalsDone = [];
      }
    }
    if (typeof s.peakPopulation !== "number") {
      s.peakPopulation = 0;
    }
    return s;
  } catch {
    return null;
  }
}

export function clearStateStorage(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(GOALS_STORAGE_KEY);
  } catch {
    // Ignore storage access errors
  }
}

export function isZoneKind(kind: TileKind | ToolKind): kind is "res" | "com" | "ind" {
  return kind === "res" || kind === "com" || kind === "ind";
}

export function hasAdjacentRoad(state: GameState, x: number, y: number): boolean {
  const dirs = [
    [0, -1],
    [1, 0],
    [0, 1],
    [-1, 0],
  ];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx >= 0 && nx < state.gridSize && ny >= 0 && ny < state.gridSize) {
      if (state.grid[ny][nx].kind === "road") {
        return true;
      }
    }
  }
  return false;
}

export function getStraightLineTiles(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Array<{ x: number; y: number }> {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const result: Array<{ x: number; y: number }> = [];

  if (Math.abs(dx) >= Math.abs(dy)) {
    const step = dx >= 0 ? 1 : -1;
    const count = Math.abs(dx);
    for (let i = 0; i <= count; i++) {
      result.push({ x: x0 + i * step, y: y0 });
    }
  } else {
    const step = dy >= 0 ? 1 : -1;
    const count = Math.abs(dy);
    for (let i = 0; i <= count; i++) {
      result.push({ x: x0, y: y0 + i * step });
    }
  }

  return result;
}

export function computeCounts(state: GameState) {
  let roads = 0;
  let buildings = 0;
  let population = 0;
  let gardens = 0;

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const tile = state.grid[y][x];
      if (tile.kind === "road") {
        roads += 1;
      }
      if (tile.building && tile.building.level > 0) {
        buildings += 1;
        if (tile.kind === "res") {
          population += tile.building.level * 4;
        }
        if (tile.building.garden) {
          gardens += 1;
        }
      }
    }
  }

  return { roads, buildings, population, gardens };
}
