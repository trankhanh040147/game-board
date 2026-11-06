import { GameState, ToolKind } from "./state";

export interface MilestoneCheckContext {
  population: number;
  gardens: number;
  cars: number;
  congestion: number;
}

export interface MilestoneGoal {
  id: string;
  title: string;
  shortTitle: string;
  description: string;
  rewardMoney: number;
  progressText: (ctx: MilestoneCheckContext) => string;
  check: (ctx: MilestoneCheckContext) => boolean;
}

export const MILESTONE_GOALS: MilestoneGoal[] = [
  {
    id: "pop_100",
    title: "100 Citizens",
    shortTitle: "100 Pop",
    description: "Grow your island town to 100 citizens",
    rewardMoney: 250,
    progressText: (ctx) => `${Math.min(100, ctx.population)} / 100 pop`,
    check: (ctx) => ctx.population >= 100,
  },
  {
    id: "first_garden",
    title: "First Rooftop Garden",
    shortTitle: "First Garden",
    description: "Plant your first lush rooftop garden",
    rewardMoney: 150,
    progressText: (ctx) => `${Math.min(1, ctx.gardens)} / 1 garden`,
    check: (ctx) => ctx.gardens >= 1,
  },
  {
    id: "pop_500",
    title: "500 Citizens",
    shortTitle: "500 Pop",
    description: "Expand into a thriving city of 500 citizens",
    rewardMoney: 600,
    progressText: (ctx) => `${Math.min(500, ctx.population)} / 500 pop`,
    check: (ctx) => ctx.population >= 500,
  },
  {
    id: "gardens_10",
    title: "10 Rooftop Gardens",
    shortTitle: "10 Gardens",
    description: "Transform 10 roofs into sky gardens",
    rewardMoney: 500,
    progressText: (ctx) => `${Math.min(10, ctx.gardens)} / 10 gardens`,
    check: (ctx) => ctx.gardens >= 10,
  },
  {
    id: "congestion_under_20_100_cars",
    title: "Smooth Flow (100 Cars, <20% Jam)",
    shortTitle: "<20% Jam @ 100 Cars",
    description: "Keep congestion under 20% with 100+ active cars",
    rewardMoney: 800,
    progressText: (ctx) => `${ctx.cars}/100 cars · ${ctx.congestion}% jam`,
    check: (ctx) => ctx.cars >= 100 && ctx.congestion < 20,
  },
];

export const UNLOCK_POP_REQUIREMENTS: Partial<Record<ToolKind, number>> = {
  com: 20,
  ind: 50,
  garden: 100,
};

/**
 * Derives the set of unlocked tools based on city population progression:
 * - Road, Residential, Bulldoze, Select: unlocked at start (0 pop)
 * - Commercial: unlocks at 20 pop
 * - Industrial: unlocks at 50 pop
 * - Rooftop Garden: unlocks at 100 pop
 */
export function deriveUnlockedTools(
  state: GameState,
  currentPopulation: number,
): Set<ToolKind> {
  const effectivePop = Math.max(currentPopulation, state.peakPopulation ?? 0);
  const unlocked = new Set<ToolKind>(["road", "res", "bulldoze", "select"]);

  let hasComOnGrid = false;
  let hasIndOnGrid = false;
  let hasGardenOnGrid = false;

  for (let y = 0; y < state.gridSize; y++) {
    for (let x = 0; x < state.gridSize; x++) {
      const t = state.grid[y]?.[x];
      if (!t) continue;
      if (t.kind === "com") hasComOnGrid = true;
      if (t.kind === "ind") hasIndOnGrid = true;
      if (t.building?.garden) hasGardenOnGrid = true;
    }
  }

  if (effectivePop >= 20 || hasComOnGrid) {
    unlocked.add("com");
  }
  if (effectivePop >= 50 || hasIndOnGrid) {
    unlocked.add("ind");
  }
  if (
    effectivePop >= 100 ||
    hasGardenOnGrid ||
    (state.goalsDone && state.goalsDone.includes("pop_100"))
  ) {
    unlocked.add("garden");
  }

  return unlocked;
}
