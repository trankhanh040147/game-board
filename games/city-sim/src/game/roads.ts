import { GameState } from "./state";

export interface GridPoint {
  x: number;
  y: number;
}

export interface RoadNode {
  key: string;
  x: number;
  y: number;
  neighbors: GridPoint[];
}

export interface RoadGraph {
  nodes: Map<string, RoadNode>;
}

export function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

const DIRS: Array<[number, number]> = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export function buildRoadGraph(state: GameState): RoadGraph {
  const nodes = new Map<string, RoadNode>();

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      if (state.grid[y][x].kind !== "road") continue;

      const neighbors: GridPoint[] = [];
      for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (
          nx >= 0 &&
          nx < state.gridSize &&
          ny >= 0 &&
          ny < state.gridSize &&
          state.grid[ny][nx].kind === "road"
        ) {
          neighbors.push({ x: nx, y: ny });
        }
      }

      nodes.set(tileKey(x, y), {
        key: tileKey(x, y),
        x,
        y,
        neighbors,
      });
    }
  }

  return { nodes };
}

export function getAdjacentRoads(state: GameState, x: number, y: number): GridPoint[] {
  const roads: GridPoint[] = [];
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (
      nx >= 0 &&
      nx < state.gridSize &&
      ny >= 0 &&
      ny < state.gridSize &&
      state.grid[ny][nx].kind === "road"
    ) {
      roads.push({ x: nx, y: ny });
    }
  }
  return roads;
}

function manhattan(a: GridPoint, b: GridPoint): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * A* pathfinding over the 4-neighbour road graph.
 * Returns an ordered array of road coordinates from start to goal (inclusive),
 * or null if no road path connects them.
 */
export function findRoadPath(
  graph: RoadGraph,
  start: GridPoint,
  goal: GridPoint,
): GridPoint[] | null {
  const startK = tileKey(start.x, start.y);
  const goalK = tileKey(goal.x, goal.y);
  if (!graph.nodes.has(startK) || !graph.nodes.has(goalK)) {
    return null;
  }
  if (startK === goalK) {
    return [{ x: start.x, y: start.y }];
  }

  const open: Array<{ point: GridPoint; key: string; f: number }> = [
    { point: start, key: startK, f: manhattan(start, goal) },
  ];
  const cameFrom = new Map<string, GridPoint>();
  const gScore = new Map<string, number>([[startK, 0]]);
  const closed = new Set<string>();

  while (open.length > 0) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) {
      if (open[i].f < open[bestIdx].f) {
        bestIdx = i;
      }
    }
    const current = open.splice(bestIdx, 1)[0];

    if (current.key === goalK) {
      const path: GridPoint[] = [{ x: goal.x, y: goal.y }];
      let currKey = goalK;
      while (cameFrom.has(currKey)) {
        const prev = cameFrom.get(currKey)!;
        path.push(prev);
        currKey = tileKey(prev.x, prev.y);
      }
      path.reverse();
      return path;
    }

    closed.add(current.key);
    const node = graph.nodes.get(current.key);
    if (!node) continue;

    const currentG = gScore.get(current.key) ?? Infinity;
    for (const neighbor of node.neighbors) {
      const nKey = tileKey(neighbor.x, neighbor.y);
      if (closed.has(nKey)) continue;

      const tentativeG = currentG + 1;
      if (tentativeG < (gScore.get(nKey) ?? Infinity)) {
        cameFrom.set(nKey, current.point);
        gScore.set(nKey, tentativeG);
        const f = tentativeG + manhattan(neighbor, goal);
        const existing = open.find((item) => item.key === nKey);
        if (existing) {
          existing.f = f;
        } else {
          open.push({ point: neighbor, key: nKey, f });
        }
      }
    }
  }

  return null;
}
