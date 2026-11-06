import React, { useEffect, useRef, useState } from "react";
import { applyToolAt, COSTS, placeGarden } from "./game/actions";
import { soundController } from "./game/audio";
import {
  computeEconomyMetrics,
  createInitialEconomy,
  EconomyMetrics,
  stepEconomyAndGrowth,
} from "./game/economy";
import { GameEventRecord, gameEvents } from "./game/events";
import {
  deriveUnlockedTools,
  MILESTONE_GOALS,
  UNLOCK_POP_REQUIREMENTS,
} from "./game/goals";
import { CityRenderer } from "./game/renderer";
import {
  captureTileSnapshot,
  clearStateStorage,
  computeCounts,
  createInitialState,
  GameState,
  hasAdjacentRoad,
  isZoneKind,
  loadStateFromStorage,
  PlacementUndo,
  restorePlacementUndo,
  saveStateToStorage,
  TileSnapshot,
  ToolKind,
} from "./game/state";
import { createTrafficSystem, stepTraffic, TrafficSystem } from "./game/traffic";

export type SimSpeed = 0 | 1 | 3;

declare global {
  interface Window {
    __probe: () => {
      money: number;
      day: number;
      roads: number;
      buildings: number;
      population: number;
      jobs: number;
      cars: number;
      averageTripTime: number;
      avgTripTime: number;
      congestion: number;
      congestionPercent: number;
      happiness: number;
      greenCoverage: number;
      greenCoveragePercent: number;
      greenPoints: number;
      gardens: number;
      taxesPerDay: number;
      upkeepPerDay: number;
      demand: { res: number; com: number; ind: number };
      gridSize: number;
      score: number;
      speed: SimSpeed;
      hoveredTile: { x: number; y: number } | null;
      goalsDone: string[];
      unlocked: ToolKind[];
      events: GameEventRecord[];
      positions: {
        centerTile: { x: number; y: number };
        tileToScreen: (x: number, y: number) => { x: number; y: number };
      };
      state: GameState;
    };
  }
}

interface ToolDef {
  id: ToolKind;
  label: string;
  shortLabel: string;
  cost: number;
  shortcut: string;
  accentBg: string;
  description: string;
  unlockPop?: number;
}

const TOOLS: ToolDef[] = [
  {
    id: "road",
    label: "Road",
    shortLabel: "Road",
    cost: COSTS.road,
    shortcut: "1",
    accentBg: "bg-[#4a4f5c]",
    description: "Connect homes, shops and workshops across the island",
  },
  {
    id: "res",
    label: "Residential",
    shortLabel: "Homes",
    cost: COSTS.zone,
    shortcut: "2",
    accentBg: "bg-[#c85538]",
    description: "Cozy cottages, townhouses and apartments for citizens",
  },
  {
    id: "com",
    label: "Commercial",
    shortLabel: "Shops",
    cost: COSTS.zone,
    shortcut: "3",
    accentBg: "bg-[#17695f]",
    description: "Cafes, boutiques and glass office towers (+jobs & taxes)",
    unlockPop: UNLOCK_POP_REQUIREMENTS.com,
  },
  {
    id: "ind",
    label: "Industrial",
    shortLabel: "Work",
    cost: COSTS.zone,
    shortcut: "4",
    accentBg: "bg-[#8a5d24]",
    description: "Workshops and clean factories for high employment",
    unlockPop: UNLOCK_POP_REQUIREMENTS.ind,
  },
  {
    id: "garden",
    label: "Garden",
    shortLabel: "Garden",
    cost: COSTS.garden,
    shortcut: "5",
    accentBg: "bg-[#1f6b4a]",
    description: "Plant lush trees & flowers on a roof (+15% tax, +mood)",
    unlockPop: UNLOCK_POP_REQUIREMENTS.garden,
  },
  {
    id: "bulldoze",
    label: "Bulldoze",
    shortLabel: "Clear",
    cost: COSTS.bulldoze,
    shortcut: "6",
    accentBg: "bg-[#b33620]",
    description: "Clear a road or building from a tile",
  },
  {
    id: "select",
    label: "Select",
    shortLabel: "Inspect",
    cost: 0,
    shortcut: "7",
    accentBg: "bg-[#1d5f8a]",
    description: "Click any tile to inspect details or add a garden",
  },
];

interface CelebrationBannerData {
  id: string;
  title: string;
  description: string;
  rewardMoney: number;
}

type ToastVariant = "warning" | "unlock" | "success" | "jam";

interface ToastNotice {
  message: string;
  variant: ToastVariant;
}

function formatClock(tick: number): string {
  const hour = (8 + Math.floor(tick % 24)) % 24;
  const mins = (tick % 2) * 30;
  return `${String(hour).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

function getHourOfDay(tick: number): number {
  return (8 + Math.floor(tick % 24)) % 24;
}

function LockIcon({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className={className} aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M10 2a4 4 0 00-4 4v2H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-1V6a4 4 0 00-4-4zm2 6V6a2 2 0 10-4 0v2h4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ConfettiBurstGraphic() {
  const pieces = [
    { cx: 14, cy: 14, color: "#f4b942", tx: "-22px", ty: "-20px", rot: "-120deg", delay: "0s" },
    { cx: 46, cy: 10, color: "#52b788", tx: "20px", ty: "-24px", rot: "140deg", delay: "0.1s" },
    { cx: 10, cy: 38, color: "#e07a5f", tx: "-24px", ty: "14px", rot: "-95deg", delay: "0.18s" },
    { cx: 48, cy: 40, color: "#4ea8de", tx: "24px", ty: "16px", rot: "110deg", delay: "0.06s" },
    { cx: 28, cy: 6, color: "#ff6b8b", tx: "4px", ty: "-26px", rot: "85deg", delay: "0.14s" },
  ];

  return (
    <svg
      viewBox="0 0 56 56"
      className="pointer-events-none absolute -inset-2 h-14 w-14 overflow-visible"
      aria-hidden="true"
    >
      {pieces.map((p, idx) => (
        <rect
          key={idx}
          x={p.cx}
          y={p.cy}
          width="5"
          height="5"
          rx="1.5"
          fill={p.color}
          className="animate-confetti-piece"
          style={
            {
              "--tx": p.tx,
              "--ty": p.ty,
              "--rot": p.rot,
              animationDelay: p.delay,
              transformOrigin: `${p.cx}px ${p.cy}px`,
            } as React.CSSProperties
          }
        />
      ))}
      <path
        d="M8 22l2-5 2 5 5 2-5 2-2 5-2-5-5-2 5-2z"
        fill="#f7c95c"
        className="animate-sparkle"
      />
      <path
        d="M47 20l1.6-4 1.6 4 4 1.6-4 1.6-1.6 4-1.6-4-4-1.6 4-1.6z"
        fill="#74c69d"
        className="animate-sparkle"
        style={{ animationDelay: "0.35s" }}
      />
    </svg>
  );
}

function ToolIcon({ id, className = "h-5 w-5" }: { id: ToolKind; className?: string }) {
  switch (id) {
    case "road":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M6 3L3 21h18L18 3H6z"
            fill="#4a4f5c"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path
            d="M12 6v3m0 3v3m0 3v2"
            stroke="#f8fafc"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "res":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M3 11.5L12 4l9 7.5"
            stroke="#e07a5f"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M6 10.5V20h12v-9.5"
            fill="#f7ede2"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <rect x="10" y="14" width="4" height="6" rx="1" fill="#e07a5f" />
        </svg>
      );
    case "com":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect
            x="5"
            y="4"
            width="14"
            height="16"
            rx="2"
            fill="#cbe8f0"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M8 8h3m2 0h3M8 12h3m2 0h3M8 16h8"
            stroke="#17695f"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </svg>
      );
    case "ind":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M3 20V11l6 3V11l6 3V7h5v13H3z"
            fill="#f2e2b3"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
          <path d="M16 4c1-1 2.5-1 3.5 0" stroke="#7a4b3a" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case "garden":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <circle cx="12" cy="10" r="5.5" fill="#52b788" stroke="currentColor" strokeWidth="1.6" />
          <circle cx="8.5" cy="12" r="3.5" fill="#40916c" />
          <circle cx="15.5" cy="12" r="3.5" fill="#74c69d" />
          <path d="M12 14v6M8 20h8" stroke="#7f5539" strokeWidth="2" strokeLinecap="round" />
          <circle cx="10" cy="9" r="1.2" fill="#ffbe0b" />
          <circle cx="14" cy="10.5" r="1.2" fill="#ff6b8b" />
        </svg>
      );
    case "bulldoze":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <rect
            x="4"
            y="10"
            width="11"
            height="6"
            rx="1.5"
            fill="#f4a261"
            stroke="currentColor"
            strokeWidth="1.7"
          />
          <path
            d="M15 11h3l2 5h-5M3 18h14"
            stroke="#c92a2a"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="7" cy="18" r="2" fill="currentColor" />
          <circle cx="13" cy="18" r="2" fill="currentColor" />
        </svg>
      );
    case "select":
    default:
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
          <path
            d="M6 4l12 7.5-5.2 1.6L16 19l-2.6 1.3-3.1-5.8L6 18V4z"
            fill="#4ea8de"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      );
  }
}

function HappinessFaceIcon({ happiness }: { happiness: number }) {
  const isHappy = happiness >= 65;
  const isNeutral = happiness >= 40 && happiness < 65;
  const fill = isHappy ? "#52b788" : isNeutral ? "#f4b942" : "#e07a5f";

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 sm:h-6 sm:w-6 shrink-0" aria-hidden="true">
      <circle cx="12" cy="12" r="9.5" fill={fill} stroke="#2c303a" strokeWidth="1.6" />
      <circle cx="9" cy="10" r="1.3" fill="#2c303a" />
      <circle cx="15" cy="10" r="1.3" fill="#2c303a" />
      {isHappy ? (
        <path
          d="M8.2 13.8c1 2 2.4 2.8 3.8 2.8s2.8-.8 3.8-2.8"
          fill="none"
          stroke="#2c303a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ) : isNeutral ? (
        <path
          d="M8.5 15h7"
          fill="none"
          stroke="#2c303a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M8.5 16.5c1-1.6 2.2-2.3 3.5-2.3s2.5.7 3.5 2.3"
          fill="none"
          stroke="#2c303a"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function TimeOfDayIcon({ hour }: { hour: number }) {
  const isNight = hour >= 20 || hour < 6;
  const isEvening = (hour >= 17 && hour < 20) || (hour >= 6 && hour < 8);

  if (isNight) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5 text-indigo-700" fill="currentColor" aria-hidden="true">
        <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
      </svg>
    );
  }
  if (isEvening) {
    return (
      <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5 text-[#b33620]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path strokeLinecap="round" d="M12 3v2m6.364.636l-1.414 1.414M21 12h-2M5 12H3m3.05-5.95L4.636 4.636M16 12a4 4 0 11-8 0" />
        <path strokeLinecap="round" d="M3 17h18M6 20h12" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5 text-[#b87a08]" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="4" fill="#f4b942" />
      <path strokeLinecap="round" d="M12 2v2m0 16v2m8-10h2M2 12h2m13.657-5.657l1.414-1.414M4.929 19.071l1.414-1.414m0-11.314L4.93 4.93m14.142 14.142l-1.414-1.414" />
    </svg>
  );
}

function getBuildingTitle(kind: string, level?: number): string {
  if (kind === "road") return "City Street";
  if (kind === "res") {
    if (!level) return "Residential Plot";
    if (level === 1) return "Sunny Cottage";
    if (level === 2) return "Terracotta Townhouse";
    return "Skyline Apartments";
  }
  if (kind === "com") {
    if (!level) return "Commercial Plot";
    if (level === 1) return "Corner Boutique";
    if (level === 2) return "Harbor Glass Office";
    return "Teal Commerce Tower";
  }
  if (kind === "ind") {
    if (!level) return "Industrial Plot";
    if (level === 1) return "Craft Workshop";
    if (level === 2) return "Ochre Mill & Silo";
    return "Clean-Tech Works";
  }
  return "Open Meadow";
}

function attachSetHelper<T>(arr: T[], set: Set<T>): T[] {
  Object.defineProperty(arr, "has", {
    value: (item: T) => set.has(item),
    enumerable: false,
    configurable: true,
  });
  return arr;
}

export default function App() {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<GameState>(loadStateFromStorage() ?? createInitialState());
  const trafficRef = useRef<TrafficSystem>(createTrafficSystem());
  const economyRef = useRef<EconomyMetrics>(
    computeEconomyMetrics(
      stateRef.current,
      trafficRef.current,
      stateRef.current.greenPoints ?? 0,
    ),
  );
  const rendererRef = useRef<CityRenderer | null>(null);
  const toolRef = useRef<ToolKind>("road");
  const speedRef = useRef<SimSpeed>(1);
  const lastTickTimeRef = useRef<number>(performance.now());
  const hoveredTileRef = useRef<{ x: number; y: number } | null>(null);
  const selectedTileRef = useRef<{ x: number; y: number } | null>(null);
  const isFirstRunRef = useRef<boolean>(true);

  // Undo tracking
  const activeStrokeRef = useRef<{
    tool: ToolKind;
    previousMoney: number;
    tilesMap: Map<string, TileSnapshot>;
  } | null>(null);
  const lastUndoRef = useRef<PlacementUndo | null>(null);
  const [undoSnapshot, setUndoSnapshot] = useState<PlacementUndo | null>(null);

  // Track previously unlocked tools so we can announce new unlocks
  const prevUnlockedRef = useRef<Set<ToolKind>>(
    deriveUnlockedTools(stateRef.current, economyRef.current.population),
  );

  const [cityName] = useState("Sunmeadow Isles");
  const [selectedTool, setSelectedTool] = useState<ToolKind>("road");
  const [hoveredToolId, setHoveredToolId] = useState<ToolKind | null>(null);
  const [speed, setSpeed] = useState<SimSpeed>(1);
  const [sidePanelOpen, setSidePanelOpen] = useState<boolean>(true);
  const [mobileSheetOpen, setMobileSheetOpen] = useState<boolean>(false);
  const [tutorialDismissed, setTutorialDismissed] = useState<boolean>(false);
  const [selectedTile, setSelectedTile] = useState<{ x: number; y: number } | null>(null);
  const [isAudioMuted, setIsAudioMuted] = useState<boolean>(true);

  const [celebrationBanner, setCelebrationBanner] =
    useState<CelebrationBannerData | null>(null);
  const celebrationTimerRef = useRef<number | null>(null);

  const [hud, setHud] = useState(() => {
    const s = stateRef.current;
    const counts = computeCounts(s);
    const econ = economyRef.current;
    return {
      money: s.money,
      day: s.day,
      tick: s.tick,
      cars: 0,
      averageTripTime: 0,
      congestion: 0,
      noRoadAccessCount: 0,
      jammedTiles: [] as Array<{ x: number; y: number; load: number }>,
      goalsDone: s.goalsDone ?? [],
      ...counts,
      ...econ,
    };
  });
  const [hoveredTile, setHoveredTile] = useState<{ x: number; y: number } | null>(null);
  const [toast, setToast] = useState<ToastNotice | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = (message: string, variant: ToastVariant = "warning") => {
    setToast({ message, variant });
    if (toastTimerRef.current) {
      window.clearTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = window.setTimeout(() => {
      setToast(null);
    }, 3600);
  };

  const triggerCelebrationBanner = (data: CelebrationBannerData) => {
    setCelebrationBanner(data);
    if (celebrationTimerRef.current) {
      window.clearTimeout(celebrationTimerRef.current);
    }
    celebrationTimerRef.current = window.setTimeout(() => {
      setCelebrationBanner(null);
    }, 5500);
  };

  const evaluateMilestonesAndUnlocks = (
    s: GameState,
    t: TrafficSystem,
    counts: ReturnType<typeof computeCounts>,
    econ: EconomyMetrics,
  ) => {
    if (!Array.isArray(s.goalsDone)) {
      s.goalsDone = [];
    }

    const ctx = {
      population: econ.population,
      gardens: counts.gardens,
      cars: t.cars.length,
      congestion: t.congestionPercent,
    };

    let milestoneAdded = false;
    for (const goal of MILESTONE_GOALS) {
      if (!s.goalsDone.includes(goal.id) && goal.check(ctx)) {
        s.goalsDone.push(goal.id);
        s.money += goal.rewardMoney;
        milestoneAdded = true;

        gameEvents.emit("milestone", {
          tick: s.tick,
          goalId: goal.id,
          label: goal.title,
          amount: goal.rewardMoney,
          message: `Milestone reached: ${goal.title}! +$${goal.rewardMoney}`,
        });

        triggerCelebrationBanner({
          id: goal.id,
          title: goal.title,
          description: goal.description,
          rewardMoney: goal.rewardMoney,
        });
      }
    }

    if (milestoneAdded) {
      saveStateToStorage(s);
    }

    // Check newly unlocked tools
    const nextUnlocked = deriveUnlockedTools(s, econ.population);
    for (const toolId of nextUnlocked) {
      if (!prevUnlockedRef.current.has(toolId)) {
        const def = TOOLS.find((item) => item.id === toolId);
        if (def) {
          gameEvents.emit("unlocked", {
            tick: s.tick,
            kind: toolId,
            label: def.label,
            message: `Unlocked ${def.label} (${def.shortLabel})!`,
          });
          showToast(
            `Unlocked ${def.label} (${def.shortLabel}) — ready to build!`,
            "unlock",
          );
        }
      }
    }
    prevUnlockedRef.current = nextUnlocked;
  };

  const refreshHud = () => {
    const s = stateRef.current;
    const t = trafficRef.current;
    const counts = computeCounts(s);
    const econ = computeEconomyMetrics(s, t, economyRef.current.greenPoints);
    economyRef.current = econ;
    s.greenPoints = econ.greenPoints;

    isFirstRunRef.current = counts.roads === 0 && counts.buildings === 0;

    evaluateMilestonesAndUnlocks(s, t, counts, econ);

    setHud({
      money: s.money,
      day: s.day,
      tick: s.tick,
      cars: t.cars.length,
      averageTripTime: t.averageTripTime,
      congestion: t.congestionPercent,
      noRoadAccessCount: t.noRoadAccessCount,
      jammedTiles: t.jammedTiles,
      goalsDone: [...(s.goalsDone ?? [])],
      ...counts,
      ...econ,
    });
  };

  const unlockedSet = deriveUnlockedTools(stateRef.current, hud.population);

  const updateSelectedTile = (tile: { x: number; y: number } | null) => {
    selectedTileRef.current = tile;
    setSelectedTile(tile);
    rendererRef.current?.updateHighlightMeshes();
  };

  const selectTool = (tool: ToolKind) => {
    const currentUnlocked = deriveUnlockedTools(
      stateRef.current,
      economyRef.current.population,
    );
    if (!currentUnlocked.has(tool)) {
      const def = TOOLS.find((t) => t.id === tool);
      const reqPop = UNLOCK_POP_REQUIREMENTS[tool] ?? 20;
      setHoveredToolId(tool);
      showToast(
        `${def?.label ?? tool} unlocks at ${reqPop} pop (currently ${economyRef.current.population} pop)`,
        "warning",
      );
      return;
    }
    toolRef.current = tool;
    setSelectedTool(tool);
    rendererRef.current?.updateHighlightMeshes();
  };

  const changeSpeed = (nextSpeed: SimSpeed) => {
    speedRef.current = nextSpeed;
    lastTickTimeRef.current = performance.now();
    setSpeed(nextSpeed);
  };

  const handleToggleMute = () => {
    const muted = soundController.toggleMute();
    setIsAudioMuted(muted);
  };

  const handleUndoLastPlacement = () => {
    const undo = lastUndoRef.current;
    if (!undo) return;
    const refund = Math.max(0, undo.previousMoney - stateRef.current.money);
    const restored = restorePlacementUndo(stateRef.current, undo);
    if (restored) {
      lastUndoRef.current = null;
      setUndoSnapshot(null);
      gameEvents.emit("undo", {
        tick: stateRef.current.tick,
        kind: undo.tool,
        amount: refund,
        message: `Undid ${undo.label}`,
      });
      rendererRef.current?.syncFromState();
      refreshHud();
      showToast(`Undid ${undo.label} (refunded $${refund})`, "success");
    }
  };

  const handleResetCity = () => {
    clearStateStorage();
    gameEvents.clear();
    stateRef.current = createInitialState();
    trafficRef.current = createTrafficSystem();
    economyRef.current = createInitialEconomy();
    lastUndoRef.current = null;
    setUndoSnapshot(null);
    setCelebrationBanner(null);
    prevUnlockedRef.current = deriveUnlockedTools(stateRef.current, 0);
    updateSelectedTile(null);
    setTutorialDismissed(false);
    isFirstRunRef.current = true;
    rendererRef.current?.syncFromState();
    refreshHud();
    showToast("Started a fresh island meadow!", "success");
  };

  const handleAddGardenFromInspector = (gx: number, gy: number) => {
    const s = stateRef.current;
    const prevTile = s.grid[gy]?.[gx];
    const snap = prevTile ? captureTileSnapshot(prevTile) : null;
    const prevMoney = s.money;

    const res = placeGarden(s, gx, gy);
    if (!res.ok && res.reason) {
      showToast(res.reason, "warning");
      return;
    }
    if (res.changed) {
      if (snap) {
        const undoRecord: PlacementUndo = {
          label: "Rooftop Garden",
          tool: "garden",
          previousMoney: prevMoney,
          tiles: [snap],
        };
        lastUndoRef.current = undoRecord;
        setUndoSnapshot(undoRecord);
      }
      rendererRef.current?.syncFromState();
      refreshHud();
      showToast("Planted a lush rooftop garden!", "success");
    }
  };

  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const initialCounts = computeCounts(stateRef.current);
    isFirstRunRef.current = initialCounts.roads === 0 && initialCounts.buildings === 0;

    const onFirstUserClick = () => {
      const enabledNow = soundController.unlockOnFirstClick();
      if (enabledNow) {
        setIsAudioMuted(soundController.isMuted());
      }
    };
    window.addEventListener("pointerdown", onFirstUserClick, { once: true });

    const unsubEvents = gameEvents.on("*", (ev) => {
      soundController.playForEvent(ev.type, ev.kind);
      if (ev.type === "traffic_jam" && ev.message) {
        showToast(ev.message, "jam");
      } else if (ev.type === "green_city" && ev.message) {
        showToast(ev.message, "success");
      }
    });

    const getTickIntervalMs = () => {
      if (speedRef.current === 3) return 150;
      return 450;
    };

    const renderer = new CityRenderer({
      container,
      getState: () => stateRef.current,
      getTraffic: () => trafficRef.current,
      getTool: () => toolRef.current,
      isToolUnlocked: (tool) =>
        deriveUnlockedTools(stateRef.current, economyRef.current.population).has(tool),
      getSelectedTile: () => selectedTileRef.current,
      isFirstRunScreen: () => isFirstRunRef.current,
      getTickAlpha: () => {
        if (speedRef.current === 0) return 1;
        const elapsed = performance.now() - lastTickTimeRef.current;
        return Math.max(0, Math.min(1, elapsed / getTickIntervalMs()));
      },
      onStrokeStart: () => {
        if (toolRef.current === "select") {
          activeStrokeRef.current = null;
          return;
        }
        activeStrokeRef.current = {
          tool: toolRef.current,
          previousMoney: stateRef.current.money,
          tilesMap: new Map<string, TileSnapshot>(),
        };
      },
      onPaintTiles: (tiles) => {
        if (toolRef.current === "select") {
          return;
        }
        const currentUnlocked = deriveUnlockedTools(
          stateRef.current,
          economyRef.current.population,
        );
        if (!currentUnlocked.has(toolRef.current)) {
          const reqPop = UNLOCK_POP_REQUIREMENTS[toolRef.current] ?? 20;
          showToast(`Unlocks at ${reqPop} pop!`, "warning");
          return;
        }

        let anyChanged = false;
        let firstError: string | undefined;
        let zonedWithoutRoad = false;

        if (!activeStrokeRef.current) {
          activeStrokeRef.current = {
            tool: toolRef.current,
            previousMoney: stateRef.current.money,
            tilesMap: new Map<string, TileSnapshot>(),
          };
        }

        const stroke = activeStrokeRef.current;

        for (const t of tiles) {
          const key = `${t.x},${t.y}`;
          const existingTile = stateRef.current.grid[t.y]?.[t.x];
          const preSnap =
            existingTile && !stroke.tilesMap.has(key)
              ? captureTileSnapshot(existingTile)
              : null;

          const res = applyToolAt(stateRef.current, t.x, t.y, toolRef.current);
          if (res.changed) {
            anyChanged = true;
            if (preSnap) {
              stroke.tilesMap.set(key, preSnap);
            }
            if (isZoneKind(toolRef.current) && !hasAdjacentRoad(stateRef.current, t.x, t.y)) {
              zonedWithoutRoad = true;
            }
          }
          if (!res.ok && !firstError && res.reason) {
            firstError = res.reason;
          }
        }

        if (firstError) {
          showToast(firstError, "warning");
        } else if (zonedWithoutRoad) {
          showToast("Needs a road next to it so builders can reach this plot", "warning");
        }

        if (anyChanged) {
          const toolDef = TOOLS.find((item) => item.id === stroke.tool);
          const undoData: PlacementUndo = {
            label:
              stroke.tilesMap.size > 1
                ? `${stroke.tilesMap.size} ${toolDef?.shortLabel ?? stroke.tool} tiles`
                : `${toolDef?.label ?? stroke.tool}`,
            tool: stroke.tool,
            previousMoney: stroke.previousMoney,
            tiles: Array.from(stroke.tilesMap.values()),
          };
          lastUndoRef.current = undoData;
          setUndoSnapshot(undoData);

          renderer.syncFromState();
          refreshHud();
        }
      },
      onStrokeEnd: () => {
        activeStrokeRef.current = null;
      },
      onHoverTile: (tile) => {
        hoveredTileRef.current = tile;
        setHoveredTile(tile);
      },
      onSelectTile: (tile) => {
        if (!tile) return;
        const tData = stateRef.current.grid[tile.y]?.[tile.x];
        if (toolRef.current === "select" || (tData && tData.building)) {
          updateSelectedTile(tile);
          if (tData?.building?.noRoadAccess) {
            showToast("Needs a road next to it", "warning");
          }
        }
      },
    });

    rendererRef.current = renderer;

    window.__probe = () => {
      const s = stateRef.current;
      const t = trafficRef.current;
      const counts = computeCounts(s);
      const econ = computeEconomyMetrics(s, t, economyRef.current.greenPoints);
      economyRef.current = econ;
      evaluateMilestonesAndUnlocks(s, t, counts, econ);

      const goalsSet = new Set<string>(s.goalsDone ?? []);
      const goalsDoneArr = attachSetHelper(Array.from(goalsSet), goalsSet);

      const unlockedToolsSet = deriveUnlockedTools(s, econ.population);
      const unlockedArr = attachSetHelper(
        Array.from(unlockedToolsSet),
        unlockedToolsSet,
      );

      const recentEvents = gameEvents.getRecentEvents();

      return {
        money: s.money,
        day: s.day,
        roads: counts.roads,
        buildings: counts.buildings,
        population: econ.population,
        jobs: econ.jobs,
        cars: t.cars.length,
        averageTripTime: t.averageTripTime,
        avgTripTime: t.averageTripTime,
        congestion: t.congestionPercent,
        congestionPercent: t.congestionPercent,
        happiness: econ.happiness,
        greenCoverage: econ.greenCoveragePercent,
        greenCoveragePercent: econ.greenCoveragePercent,
        greenPoints: econ.greenPoints,
        gardens: counts.gardens,
        taxesPerDay: econ.taxesPerDay,
        upkeepPerDay: econ.upkeepPerDay,
        demand: econ.demand,
        gridSize: s.gridSize,
        score:
          econ.population * 12 +
          econ.happiness * 8 +
          Math.round(econ.greenPoints * 10) +
          s.money,
        speed: speedRef.current,
        hoveredTile: hoveredTileRef.current,
        goalsDone: goalsDoneArr,
        unlocked: unlockedArr,
        events: recentEvents,
        positions: {
          centerTile: renderer.tileToScreen(16, 16),
          tileToScreen: (x: number, y: number) => renderer.tileToScreen(x, y),
        },
        state: s,
      };
    };

    const handleKeyShortcuts = (e: KeyboardEvent) => {
      if (
        document.activeElement &&
        ["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && key === "z") {
        e.preventDefault();
        handleUndoLastPlacement();
        return;
      }
      if (key === "z") {
        handleUndoLastPlacement();
        return;
      }
      if (key === "1" || key === "r") selectTool("road");
      else if (key === "2") selectTool("res");
      else if (key === "3") selectTool("com");
      else if (key === "4") selectTool("ind");
      else if (key === "5" || key === "g") selectTool("garden");
      else if (key === "6" || key === "b") selectTool("bulldoze");
      else if (key === "7" || key === "v") selectTool("select");
      else if (key === "m") handleToggleMute();
      else if (key === " ") {
        e.preventDefault();
        changeSpeed(speedRef.current === 0 ? 1 : 0);
      } else if (key === "escape") {
        updateSelectedTile(null);
      }
    };
    window.addEventListener("keydown", handleKeyShortcuts);

    let timerId = 0;
    const tickLoop = () => {
      if (speedRef.current > 0) {
        lastTickTimeRef.current = performance.now();
        const { economy } = stepEconomyAndGrowth(
          stateRef.current,
          trafficRef.current,
          economyRef.current,
        );
        economyRef.current = economy;
        stateRef.current.greenPoints = economy.greenPoints;
        stepTraffic(stateRef.current, trafficRef.current);
        renderer.syncFromState();
        refreshHud();
      }
      timerId = window.setTimeout(tickLoop, speedRef.current === 3 ? 150 : 450);
    };
    timerId = window.setTimeout(tickLoop, 450);

    const autosaveId = window.setInterval(() => {
      saveStateToStorage(stateRef.current);
    }, 10000);

    return () => {
      window.removeEventListener("pointerdown", onFirstUserClick);
      window.removeEventListener("keydown", handleKeyShortcuts);
      unsubEvents();
      window.clearTimeout(timerId);
      window.clearInterval(autosaveId);
      saveStateToStorage(stateRef.current);
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  const hoveredTileData = hoveredTile
    ? stateRef.current.grid[hoveredTile.y]?.[hoveredTile.x]
    : null;

  const inspectedTileCoord = selectedTile ?? null;
  const inspectedTileData = inspectedTileCoord
    ? stateRef.current.grid[inspectedTileCoord.y]?.[inspectedTileCoord.x]
    : null;

  const isCityEmpty = hud.roads === 0 && hud.buildings === 0;
  const showTutorial = !tutorialDismissed && (isCityEmpty || hud.day <= 2);
  const currentHour = getHourOfDay(hud.tick);

  const milestoneContext = {
    population: hud.population,
    gardens: hud.gardens,
    cars: hud.cars,
    congestion: hud.congestion,
  };
  const hoveredToolDef = hoveredToolId
    ? TOOLS.find((t) => t.id === hoveredToolId) ?? null
    : null;

  const toastStyles: Record<
    ToastVariant,
    { border: string; badgeBg: string; eyebrow: string; eyebrowColor: string; icon: React.ReactNode }
  > = {
    unlock: {
      border: "border-[#52b788]",
      badgeBg: "bg-[#1f6b4a] text-white",
      eyebrow: "New Tool Unlocked",
      eyebrowColor: "text-[#74c69d]",
      icon: (
        <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <path d="M10 2a4 4 0 00-3.87 3h2.06A2 2 0 0112 6v2H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2h-1V6a4 4 0 00-4-4z" />
        </svg>
      ),
    },
    success: {
      border: "border-[#52b788]",
      badgeBg: "bg-[#1f6b4a] text-white",
      eyebrow: "City Update",
      eyebrowColor: "text-[#74c69d]",
      icon: <span className="text-xs font-black">✓</span>,
    },
    jam: {
      border: "border-[#ef4444]",
      badgeBg: "bg-[#b91c1c] text-white",
      eyebrow: "Traffic Alert",
      eyebrowColor: "text-[#fca5a5]",
      icon: <span className="text-xs font-black">!</span>,
    },
    warning: {
      border: "border-[#f4b942]",
      badgeBg: "bg-[#b33620] text-white",
      eyebrow: "Mayor Notice",
      eyebrowColor: "text-[#f7c95c]",
      icon: <span className="text-xs font-black">!</span>,
    },
  };

  return (
    <div className="relative h-dvh w-screen overflow-hidden bg-[#f3ead7] text-[#2c303a] select-none">
      {/* Full-Viewport 3D Isometric Playfield */}
      <div
        ref={mountRef}
        className="absolute inset-0 h-full w-full"
        data-testid="city-viewport"
      />

      {/* Non-Overlapping Flex-Column HUD Overlay */}
      <div className="pointer-events-none absolute inset-0 z-20 flex flex-col justify-between p-1.5 sm:p-3">
        {/* TOP ZONE: Header + Non-Overlapping Banner / Toast Slot */}
        <div className="flex shrink-0 flex-col items-center gap-1.5 w-full">
          <header className="flex w-full flex-wrap items-center justify-between gap-1.5 sm:gap-2">
            {/* Left Cluster: City Identity, Treasury, Population & Happiness */}
            <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 sm:gap-2.5 rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/94 px-2.5 py-1.5 sm:px-3 sm:py-2 shadow-lg backdrop-blur-md">
              {/* City Badge */}
              <div className="flex items-center gap-1.5 pr-0.5">
                <span className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-xl bg-[#e07a5f]/20 text-[#962d17]">
                  <svg viewBox="0 0 24 24" className="h-4 w-4 sm:h-5 sm:w-5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 21h18M5 21V7l7-4 7 4v14M9 9h1m4 0h1m-6 4h1m4 0h1m-5 8v-5h4v5" />
                  </svg>
                </span>
                <div className="hidden lg:block">
                  <div className="text-[10px] font-extrabold tracking-wider text-[#484237] uppercase leading-none">
                    Island Diorama
                  </div>
                  <div className="text-sm font-extrabold text-[#2c303a] leading-tight">
                    {cityName}
                  </div>
                </div>
              </div>

              <div className="hidden lg:block h-7 w-px bg-[#dcd0b8]" />

              {/* Treasury / Money Readout */}
              <div className="flex items-center gap-1.5 px-0.5">
                <div>
                  <div className="text-[10px] font-extrabold tracking-wider text-[#484237] uppercase leading-none">
                    Treasury
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1">
                    <span
                      className="text-sm sm:text-base font-extrabold text-[#185a3e]"
                      data-testid="money-readout"
                    >
                      ${hud.money.toLocaleString()}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] font-extrabold ${
                        hud.netIncomePerDay >= 0
                          ? "bg-[#52b788]/25 text-[#185a3e]"
                          : "bg-[#e63946]/20 text-[#962d17]"
                      }`}
                      title={`Taxes +$${hud.taxesPerDay}/day · Road care -$${hud.upkeepPerDay}/day`}
                    >
                      {hud.netIncomePerDay >= 0 ? "+" : ""}
                      ${hud.netIncomePerDay}/d
                    </span>
                  </div>
                </div>
              </div>

              <div className="h-6 w-px bg-[#dcd0b8]" />

              {/* Population & Jobs */}
              <div className="flex items-center gap-1.5 px-0.5">
                <span className="hidden sm:flex h-7 w-7 items-center justify-center rounded-xl bg-[#2a9d8f]/20 text-[#135b52]">
                  <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a4 4 0 00-5-3.87M9 20H4v-2a4 4 0 015-3.87m6-4.13a4 4 0 11-8 0 4 4 0 018 0zm6 2a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                </span>
                <div>
                  <div className="text-[10px] font-extrabold tracking-wider text-[#484237] uppercase leading-none">
                    Citizens
                  </div>
                  <div className="mt-0.5 text-xs sm:text-sm font-extrabold text-[#2c303a] leading-tight">
                    {hud.population} <span className="font-bold text-[#484237]">pop</span>
                    <span className="mx-1 text-[#6e6556]">·</span>
                    <span className="text-[#135b52]">{hud.jobs}</span>{" "}
                    <span className="font-bold text-[#484237]">jobs</span>
                  </div>
                </div>
              </div>

              <div className="h-6 w-px bg-[#dcd0b8]" />

              {/* Happiness Face-Icon Meter */}
              <div className="flex items-center gap-1.5 px-0.5">
                <HappinessFaceIcon happiness={hud.happiness} />
                <div>
                  <div className="text-[10px] font-extrabold tracking-wider text-[#484237] uppercase leading-none">
                    Mood
                  </div>
                  <div
                    className="mt-0.5 text-xs sm:text-sm font-extrabold text-[#2c303a] leading-tight"
                    data-testid="happiness-readout"
                  >
                    {hud.happiness}% Happy
                  </div>
                </div>
              </div>
            </div>

            {/* Right Cluster: Day/Clock & Speed Pill Controls + Audio + Camera */}
            <div className="pointer-events-auto flex flex-wrap items-center justify-between sm:justify-start gap-1 sm:gap-1.5 rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/94 px-2 py-1 sm:px-2.5 sm:py-1.5 shadow-lg backdrop-blur-md">
              {/* Day & Clock Pill */}
              <div className="flex items-center gap-1 px-1 py-0.5">
                <TimeOfDayIcon hour={currentHour} />
                <span
                  className="text-[11px] sm:text-xs font-extrabold text-[#2c303a] whitespace-nowrap"
                  data-testid="day-readout"
                >
                  Day {hud.day} · {formatClock(hud.tick)}
                </span>
              </div>

              {/* Speed Pill Icon Buttons */}
              <div
                className="flex items-center gap-0.5 rounded-full bg-[#efe4ce] p-0.5"
                role="group"
                aria-label="Game speed controls"
              >
                {(
                  [
                    {
                      value: 0 as SimSpeed,
                      label: "Pause",
                      icon: (
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                          <rect x="6" y="5" width="4" height="14" rx="1" />
                          <rect x="14" y="5" width="4" height="14" rx="1" />
                        </svg>
                      ),
                    },
                    {
                      value: 1 as SimSpeed,
                      label: "1x",
                      icon: (
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                          <path d="M7 5v14l11-7-11-7z" />
                        </svg>
                      ),
                    },
                    {
                      value: 3 as SimSpeed,
                      label: "3x",
                      icon: (
                        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="currentColor" aria-hidden="true">
                          <path d="M4 5v14l9-7-9-7zm9 0v14l9-7-9-7z" />
                        </svg>
                      ),
                    },
                  ] as const
                ).map((opt) => {
                  const active = speed === opt.value;
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => changeSpeed(opt.value)}
                      data-testid={`speed-${opt.label.toLowerCase()}`}
                      className={`flex min-h-[28px] min-w-[32px] sm:min-h-[34px] sm:min-w-[42px] items-center justify-center gap-0.5 sm:gap-1 rounded-full px-1.5 sm:px-2 py-0.5 text-[10px] sm:text-xs font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17695f] ${
                        active
                          ? "bg-[#2c303a] text-[#fcf8f0] shadow-sm"
                          : "text-[#2c303a] hover:bg-[#dfd1b5]"
                      }`}
                      title={`Speed: ${opt.label}`}
                    >
                      {opt.icon}
                      <span>{opt.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Mute Toggle, Camera Rotate & Reset Buttons */}
              <div className="flex items-center gap-0.5 sm:gap-1">
                <button
                  type="button"
                  onClick={handleToggleMute}
                  data-testid="mute-toggle"
                  className={`flex min-h-[28px] min-w-[28px] sm:min-h-[34px] sm:min-w-[34px] items-center justify-center rounded-full px-1.5 text-xs font-extrabold transition focus-visible:outline-2 focus-visible:outline-[#17695f] ${
                    isAudioMuted
                      ? "bg-[#efe4ce] text-[#484237] hover:bg-[#e2d4b7]"
                      : "bg-[#52b788]/30 text-[#185a3e] hover:bg-[#52b788]/40"
                  }`}
                  title={isAudioMuted ? "Unmute sound effects (M)" : "Mute sound effects (M)"}
                  aria-label={isAudioMuted ? "Unmute sound effects" : "Mute sound effects"}
                >
                  {isAudioMuted ? "🔇" : "🔊"}
                </button>
                <button
                  type="button"
                  onClick={() => rendererRef.current?.rotateStep(-1)}
                  className="flex min-h-[28px] min-w-[30px] sm:min-h-[34px] sm:min-w-[36px] items-center justify-center rounded-full bg-[#efe4ce] px-1.5 text-[10px] sm:text-xs font-extrabold text-[#2c303a] transition hover:bg-[#e2d4b7] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                  title="Rotate view left (Q)"
                  aria-label="Rotate view counter-clockwise"
                >
                  ↺ Q
                </button>
                <button
                  type="button"
                  onClick={() => rendererRef.current?.rotateStep(1)}
                  className="flex min-h-[28px] min-w-[30px] sm:min-h-[34px] sm:min-w-[36px] items-center justify-center rounded-full bg-[#efe4ce] px-1.5 text-[10px] sm:text-xs font-extrabold text-[#2c303a] transition hover:bg-[#e2d4b7] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                  title="Rotate view right (E)"
                  aria-label="Rotate view clockwise"
                >
                  E ↻
                </button>
                <button
                  type="button"
                  onClick={handleResetCity}
                  data-testid="reset-city-button"
                  className="flex min-h-[28px] sm:min-h-[34px] items-center justify-center rounded-full border border-[#c85538]/45 bg-[#fae3dc] px-2 sm:px-2.5 text-[10px] sm:text-xs font-extrabold text-[#962d17] transition hover:bg-[#f5cfc3] focus-visible:outline-2 focus-visible:outline-[#c85538]"
                  title="Reset city to an empty island"
                >
                  Reset City
                </button>
              </div>
            </div>
          </header>

          {/* Celebratory Milestone Banner with Confetti & Sparkle Burst */}
          {celebrationBanner && (
            <div
              role="status"
              data-testid="milestone-banner"
              className="animate-banner-pop pointer-events-auto relative flex max-w-md items-center gap-3 rounded-2xl border-2 border-[#f4b942] bg-[#2c303a]/96 px-4 py-2.5 text-[#fcf8f0] shadow-2xl backdrop-blur-md"
            >
              <div className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#f4b942]/20 text-xl">
                <ConfettiBurstGraphic />
                <span>🏆</span>
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[10px] font-extrabold tracking-wider text-[#f7c95c] uppercase">
                    Milestone Reached!
                  </span>
                  <span className="rounded-full bg-[#1f6b4a] px-2 py-0.5 text-[11px] font-extrabold text-white">
                    +${celebrationBanner.rewardMoney} Reward
                  </span>
                </div>
                <div className="text-sm font-extrabold text-white">
                  {celebrationBanner.title}
                </div>
                <div className="text-xs font-semibold text-[#e2d6c3]">
                  {celebrationBanner.description}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCelebrationBanner(null)}
                className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-xs font-bold text-[#e2d6c3] hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-[#f7c95c]"
                aria-label="Dismiss milestone celebration"
              >
                ✕
              </button>
            </div>
          )}

          {/* Cohesive Toast & Unlock Notice Banner */}
          {toast && !celebrationBanner && (
            <div
              role="alert"
              data-testid="toast-banner"
              className={`animate-banner-pop pointer-events-auto flex max-w-md items-center gap-2.5 rounded-2xl border-2 ${toastStyles[toast.variant].border} bg-[#2c303a]/96 px-3.5 py-2 text-xs sm:text-sm font-bold text-[#fcf8f0] shadow-2xl backdrop-blur-md`}
            >
              <span
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-xl ${toastStyles[toast.variant].badgeBg}`}
              >
                {toastStyles[toast.variant].icon}
              </span>
              <div className="min-w-0">
                <div
                  className={`text-[10px] font-extrabold tracking-wider uppercase leading-none ${toastStyles[toast.variant].eyebrowColor}`}
                >
                  {toastStyles[toast.variant].eyebrow}
                </div>
                <div className="mt-0.5 leading-snug text-[#fcf8f0]">{toast.message}</div>
              </div>
              <button
                type="button"
                onClick={() => setToast(null)}
                className="ml-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-xs text-[#e2d6c3] hover:bg-white/15 hover:text-white focus-visible:outline-2 focus-visible:outline-white"
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        {/* MIDDLE WORKSPACE ROW: Left City Pulse Panel + Right Tutorial / Tile Inspector */}
        <div className="flex min-h-0 flex-1 items-start justify-between gap-2 overflow-hidden py-1 w-full">
          {/* Left Collapsible Panel (Tablet & Desktop md+) */}
          <div className="hidden md:flex max-h-full flex-col">
            {sidePanelOpen ? (
              <aside
                aria-label="City pulse and metrics"
                className="pointer-events-auto max-h-full w-60 lg:w-72 overflow-y-auto rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/92 p-2.5 lg:p-3 shadow-xl backdrop-blur-md"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-extrabold tracking-wider text-[#484237] uppercase">
                    City Pulse
                  </h2>
                  <button
                    type="button"
                    onClick={() => setSidePanelOpen(false)}
                    className="flex min-h-[26px] min-w-[26px] items-center justify-center rounded-xl text-xs font-extrabold text-[#484237] hover:bg-[#efe4ce] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                    title="Collapse panel"
                    aria-label="Collapse city pulse panel"
                  >
                    ◀
                  </button>
                </div>

                {/* Active City Event Badges (Traffic Jam / Green City Bonus) */}
                {(hud.jammedTiles.length > 0 || hud.greenCityBonusActive) && (
                  <div className="mt-1.5 space-y-1" data-testid="active-events-list">
                    {hud.jammedTiles.length > 0 && (
                      <div className="animate-congestion-pulse flex items-center gap-2 rounded-xl border border-[#c92a2a]/60 bg-[#fae3dc] px-2.5 py-1 text-xs font-extrabold text-[#962d17]">
                        <span className="inline-block h-2 w-2 rounded-full bg-[#c92a2a]" />
                        <span>
                          Traffic Jam at ({hud.jammedTiles[0].x}, {hud.jammedTiles[0].y}) · Load{" "}
                          {hud.jammedTiles[0].load}
                        </span>
                      </div>
                    )}
                    {hud.greenCityBonusActive && (
                      <div className="flex items-center gap-2 rounded-xl border border-[#1f6b4a]/45 bg-[#52b788]/25 px-2.5 py-1 text-xs font-extrabold text-[#185a3e]">
                        <span>🌿</span>
                        <span>Green City Bonus (&gt;25% Roofs: +$15/day, +6 mood)</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Milestone Goals Checklist */}
                <div
                  className="mt-1.5"
                  aria-label="Milestone goals checklist"
                  data-testid="milestone-checklist"
                >
                  <div className="flex items-center justify-between text-xs font-extrabold text-[#2c303a]">
                    <span className="uppercase tracking-wider text-[#484237]">
                      Milestone Goals
                    </span>
                    <span className="rounded-full bg-[#efe4ce] px-2 py-0.5 text-[11px] text-[#2c303a]">
                      {hud.goalsDone.length} / {MILESTONE_GOALS.length}
                    </span>
                  </div>
                  <ul className="mt-1 space-y-1">
                    {MILESTONE_GOALS.map((goal) => {
                      const done = hud.goalsDone.includes(goal.id);
                      return (
                        <li
                          key={goal.id}
                          data-testid={`goal-${goal.id}`}
                          className={`flex items-center justify-between gap-2 rounded-xl border px-2 py-0.5 text-xs transition ${
                            done
                              ? "border-[#1f6b4a]/50 bg-[#52b788]/20 text-[#185a3e]"
                              : "border-[#dcd0b8] bg-[#efe4ce]/65 text-[#2c303a]"
                          }`}
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span
                              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-extrabold ${
                                done
                                  ? "bg-[#1f6b4a] text-white"
                                  : "border border-[#8c7f6a] bg-[#fcf8f0] text-transparent"
                              }`}
                            >
                              ✓
                            </span>
                            <div className="truncate">
                              <div
                                className={`font-extrabold leading-tight ${
                                  done ? "line-through" : ""
                                }`}
                              >
                                {goal.shortTitle}
                              </div>
                              <div className="text-[10px] font-bold text-[#484237] leading-tight">
                                {done ? "Completed!" : goal.progressText(milestoneContext)}
                              </div>
                            </div>
                          </div>
                          <span
                            className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-extrabold ${
                              done
                                ? "bg-[#1f6b4a] text-white"
                                : "bg-[#f4b942]/35 text-[#5c3d04]"
                            }`}
                          >
                            +${goal.rewardMoney}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>

                <div className="my-1.5 h-px bg-[#dcd0b8]" />

                {/* RCI Demand Bars */}
                <div aria-label="RCI Demand">
                  <div className="flex items-center justify-between text-xs font-extrabold text-[#2c303a]">
                    <span>Zone Demand</span>
                    <span className="text-[11px] font-bold text-[#484237]">
                      Homes · Shops · Work
                    </span>
                  </div>
                  <div className="mt-1 space-y-1">
                    {(
                      [
                        {
                          key: "res",
                          label: "Homes (R)",
                          val: hud.demand.res,
                          barClass: "bg-[#e07a5f]",
                        },
                        {
                          key: "com",
                          label: "Shops (C)",
                          val: hud.demand.com,
                          barClass: "bg-[#2a9d8f]",
                        },
                        {
                          key: "ind",
                          label: "Work (I)",
                          val: hud.demand.ind,
                          barClass: "bg-[#d4a373]",
                        },
                      ] as const
                    ).map((d) => (
                      <div key={d.key} className="space-y-0.5">
                        <div className="flex justify-between text-xs font-bold">
                          <span className="text-[#2c303a]">{d.label}</span>
                          <span className="text-[#484237]">{d.val}%</span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#e2d5be]">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${d.barClass}`}
                            style={{ width: `${Math.max(8, d.val)}%` }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="my-1.5 h-px bg-[#dcd0b8]" />

                {/* Traffic Congestion Gauge with Congestion Color Pulse */}
                <div>
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-[#2c303a]">Traffic Flow</span>
                    <span
                      className={
                        hud.congestion >= 65
                          ? "font-extrabold text-[#962d17]"
                          : hud.congestion >= 35
                            ? "font-extrabold text-[#6e4904]"
                            : "font-extrabold text-[#185a3e]"
                      }
                    >
                      {hud.congestion}% busy
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#e2d5be]">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        hud.congestion >= 65
                          ? "animate-congestion-pulse bg-[#e63946]"
                          : hud.congestion >= 35
                            ? "animate-congestion-pulse bg-[#f4b942]"
                            : "bg-[#4ea8de]"
                      }`}
                      style={{ width: `${Math.max(6, hud.congestion)}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] font-bold text-[#484237]">
                    <span>{hud.cars} cars on roads</span>
                    <span>Avg trip {hud.averageTripTime}t</span>
                  </div>
                  {hud.noRoadAccessCount > 0 && (
                    <div className="mt-1 rounded-xl border border-[#c85538]/50 bg-[#fae3dc] px-2 py-1 text-xs font-bold text-[#962d17]">
                      {hud.noRoadAccessCount} building{hud.noRoadAccessCount > 1 ? "s" : ""} need a road next to them
                    </div>
                  )}
                </div>

                <div className="my-1.5 h-px bg-[#dcd0b8]" />

                {/* Green Coverage */}
                <div>
                  <div className="flex items-center justify-between text-xs font-bold">
                    <span className="text-[#2c303a]">Green Rooftops</span>
                    <span className="font-extrabold text-[#185a3e]" data-testid="green-coverage-readout">
                      {hud.greenCoveragePercent}% Green Roofs
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[#e2d5be]">
                    <div
                      className="h-full rounded-full bg-[#40916c] transition-all duration-300"
                      style={{ width: `${Math.max(6, hud.greenCoveragePercent)}%` }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-[11px] font-bold text-[#484237]">
                    <span>{hud.gardensCount} rooftop gardens</span>
                    <span>{hud.greenPoints} green pts</span>
                  </div>
                </div>

                {/* Hover Status Footer */}
                <div className="mt-1.5 rounded-xl bg-[#efe4ce]/85 px-2.5 py-1 text-[11px] font-bold text-[#484237]">
                  {hoveredTile ? (
                    <span>
                      Tile ({hoveredTile.x}, {hoveredTile.y}) ·{" "}
                      {getBuildingTitle(hoveredTileData?.kind ?? "empty", hoveredTileData?.building?.level)}
                      {hoveredTileData?.building ? ` (L${hoveredTileData.building.level})` : ""}
                    </span>
                  ) : (
                    <span>Right-drag to pan · Scroll to zoom · Click building to inspect</span>
                  )}
                </div>
              </aside>
            ) : (
              <button
                type="button"
                onClick={() => setSidePanelOpen(true)}
                className="pointer-events-auto flex min-h-[40px] items-center gap-2 rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/94 px-3.5 py-2 text-xs font-extrabold text-[#2c303a] shadow-lg backdrop-blur-md hover:bg-[#f5ebd8] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                aria-label="Open city pulse panel"
              >
                <span>City Pulse & Goals ({hud.goalsDone.length}/{MILESTONE_GOALS.length})</span>
                <span className="rounded-full bg-[#52b788]/25 px-2 py-0.5 text-[#185a3e]">
                  {hud.greenCoveragePercent}% Green
                </span>
                <span>▶</span>
              </button>
            )}
          </div>

          {/* Right Column: First-Run Welcome Tutorial Card & Tile Inspector */}
          <div className="ml-auto flex max-h-full flex-col items-end gap-2 overflow-y-auto">
            {/* First-Run / Empty State Dismissible Tutorial Card */}
            {showTutorial && (!inspectedTileCoord || !mobileSheetOpen) && (
              <aside
                aria-label="Quick start guide"
                data-testid="tutorial-card"
                className="pointer-events-auto w-[min(21rem,calc(100vw-1.5rem))] md:w-64 lg:w-72 rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/95 p-2.5 sm:p-3.5 shadow-xl backdrop-blur-md"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="inline-block rounded-full bg-[#e07a5f]/20 px-2 py-0.5 text-[10px] font-extrabold text-[#962d17]">
                      Welcome Mayor
                    </span>
                    <h2 className="text-xs sm:text-sm font-extrabold text-[#2c303a]">
                      Build your miniature island
                    </h2>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTutorialDismissed(true)}
                    data-testid="dismiss-tutorial"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-xl text-[#484237] hover:bg-[#efe4ce] hover:text-[#2c303a] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                    aria-label="Dismiss guide"
                  >
                    ✕
                  </button>
                </div>
                <p className="hidden md:block mt-1 text-xs font-bold text-[#484237] leading-snug">
                  Draw a road, zone Homes to reach 20 citizens, and unlock Shops, Work &amp; Rooftop Gardens:
                </p>
                <ol className="mt-1.5 space-y-1 sm:space-y-1.5 text-[11px] sm:text-xs font-bold text-[#2c303a]">
                  <li className="flex items-center gap-2 rounded-xl bg-[#efe4ce]/80 px-2 py-1 sm:px-2.5 sm:py-1.5">
                    <span className="flex h-4 w-4 sm:h-5 sm:w-5 shrink-0 items-center justify-center rounded-full bg-[#2c303a] text-[10px] font-extrabold text-white">
                      1
                    </span>
                    <span>Drag to draw a Road ($10) across the island</span>
                  </li>
                  <li className="flex items-center gap-2 rounded-xl bg-[#efe4ce]/80 px-2 py-1 sm:px-2.5 sm:py-1.5">
                    <span className="flex h-4 w-4 sm:h-5 sm:w-5 shrink-0 items-center justify-center rounded-full bg-[#b33620] text-[10px] font-extrabold text-white">
                      2
                    </span>
                    <span>Zone Homes ($5) beside roads to unlock Shops at 20 pop</span>
                  </li>
                  <li className="flex items-center gap-2 rounded-xl bg-[#efe4ce]/80 px-2 py-1 sm:px-2.5 sm:py-1.5">
                    <span className="flex h-4 w-4 sm:h-5 sm:w-5 shrink-0 items-center justify-center rounded-full bg-[#1f6b4a] text-[10px] font-extrabold text-white">
                      3
                    </span>
                    <span>Unlock Work at 50 pop &amp; Rooftop Gardens at 100 pop</span>
                  </li>
                </ol>
                <button
                  type="button"
                  onClick={() => setTutorialDismissed(true)}
                  className="hidden md:flex mt-2.5 min-h-[36px] w-full items-center justify-center rounded-xl bg-[#17695f] px-4 py-1.5 text-xs font-extrabold text-white shadow-sm transition hover:bg-[#12544c] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17695f]"
                >
                  Got it, let&apos;s build!
                </button>
              </aside>
            )}

            {/* Tile Inspector Card on Click */}
            {inspectedTileCoord && inspectedTileData && (
              <aside
                aria-label="Tile inspector"
                data-testid="tile-inspector"
                className="pointer-events-auto w-[min(19.5rem,calc(100vw-1.5rem))] rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/96 p-3.5 shadow-2xl backdrop-blur-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-[11px] font-extrabold tracking-wider text-[#484237] uppercase">
                      Tile ({inspectedTileCoord.x}, {inspectedTileCoord.y})
                    </div>
                    <h3 className="text-sm sm:text-base font-extrabold text-[#2c303a]">
                      {getBuildingTitle(
                        inspectedTileData.kind,
                        inspectedTileData.building?.level,
                      )}
                    </h3>
                  </div>
                  <button
                    type="button"
                    onClick={() => updateSelectedTile(null)}
                    className="flex min-h-[32px] min-w-[32px] items-center justify-center rounded-xl text-[#484237] hover:bg-[#efe4ce] focus-visible:outline-2 focus-visible:outline-[#17695f]"
                    aria-label="Close tile inspector"
                  >
                    ✕
                  </button>
                </div>

                <div className="mt-2.5 space-y-1.5 text-xs font-bold text-[#2c303a]">
                  {inspectedTileData.building ? (
                    <>
                      <div className="flex justify-between rounded-xl bg-[#efe4ce]/80 px-3 py-1.5">
                        <span className="text-[#484237]">Building Level</span>
                        <span className="font-extrabold text-[#2c303a]">
                          Level {inspectedTileData.building.level} of 3
                        </span>
                      </div>
                      <div className="flex justify-between rounded-xl bg-[#efe4ce]/80 px-3 py-1.5">
                        <span className="text-[#484237]">
                          {inspectedTileData.kind === "res" ? "Residents" : "Local Jobs"}
                        </span>
                        <span className="font-extrabold text-[#2c303a]">
                          {inspectedTileData.kind === "res"
                            ? `${inspectedTileData.building.level * 4} residents`
                            : inspectedTileData.kind === "com"
                              ? `${inspectedTileData.building.level * 4} jobs`
                              : `${inspectedTileData.building.level * 6} jobs`}
                        </span>
                      </div>
                      <div className="flex justify-between rounded-xl bg-[#efe4ce]/80 px-3 py-1.5">
                        <span className="text-[#484237]">Road Connection</span>
                        <span
                          className={
                            inspectedTileData.building.noRoadAccess
                              ? "font-extrabold text-[#962d17]"
                              : "font-extrabold text-[#185a3e]"
                          }
                        >
                          {inspectedTileData.building.noRoadAccess
                            ? "Needs a road next to it"
                            : "Connected"}
                        </span>
                      </div>

                      {/* Rooftop Garden Status & Action Button */}
                      {(inspectedTileData.kind === "res" ||
                        inspectedTileData.kind === "com") && (
                        <div className="pt-1">
                          {inspectedTileData.building.garden ? (
                            <div className="flex items-center gap-2 rounded-xl border border-[#1f6b4a]/45 bg-[#52b788]/25 px-3 py-2 text-xs font-extrabold text-[#185a3e]">
                              <span>🌿 Lush Rooftop Garden (+15% tax, +mood)</span>
                            </div>
                          ) : (
                            <button
                              type="button"
                              onClick={() =>
                                handleAddGardenFromInspector(
                                  inspectedTileCoord.x,
                                  inspectedTileCoord.y,
                                )
                              }
                              data-testid="inspector-add-garden"
                              className={`flex min-h-[40px] w-full items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-xs font-extrabold text-white shadow-md transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
                                hud.money >= COSTS.garden
                                  ? "bg-[#1f6b4a] hover:bg-[#175238] focus-visible:outline-[#1f6b4a]"
                                  : "bg-[#b33620] hover:bg-[#942b18] focus-visible:outline-[#b33620]"
                              }`}
                            >
                              <span>Add rooftop garden - ${COSTS.garden}</span>
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  ) : inspectedTileData.kind === "road" ? (
                    <div className="rounded-xl bg-[#efe4ce]/80 px-3 py-2 text-[#2c303a]">
                      Asphalt street with sidewalks · Traffic load{" "}
                      {Math.round((inspectedTileData.load ?? 0) * 10) / 10}
                      {(inspectedTileData.load ?? 0) > 5 ? " (🚨 Jammed!)" : ""}
                    </div>
                  ) : isZoneKind(inspectedTileData.kind) ? (
                    <div className="rounded-xl bg-[#efe4ce]/80 px-3 py-2 text-[#2c303a]">
                      {hasAdjacentRoad(
                        stateRef.current,
                        inspectedTileCoord.x,
                        inspectedTileCoord.y,
                      )
                        ? "Zoned plot — builders will arrive shortly!"
                        : "Needs a road next to it before buildings can sprout."}
                    </div>
                  ) : (
                    <div className="rounded-xl bg-[#efe4ce]/80 px-3 py-2 text-[#2c303a]">
                      Open cream island meadow ready for roads or zoning.
                    </div>
                  )}
                </div>
              </aside>
            )}
          </div>
        </div>

        {/* BOTTOM ZONE: Mobile Drawer + Hover Tooltip + Tool Palette Dock */}
        <div className="flex shrink-0 flex-col items-center gap-1.5 w-full">
          {/* Narrow Screen Bottom Sheet Toggle & Drawer (Mobile < md) */}
          <div className="flex w-full flex-col items-center md:hidden">
            {mobileSheetOpen && (
              <div className="pointer-events-auto mb-1.5 max-h-[38vh] w-full max-w-md overflow-y-auto rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/96 p-3 shadow-2xl backdrop-blur-md">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-xl bg-[#efe4ce]/80 p-1.5">
                    <div className="text-[11px] font-bold text-[#484237]">Homes (R)</div>
                    <div className="text-sm font-extrabold text-[#962d17]">
                      {hud.demand.res}%
                    </div>
                  </div>
                  <div className="rounded-xl bg-[#efe4ce]/80 p-1.5">
                    <div className="text-[11px] font-bold text-[#484237]">Shops (C)</div>
                    <div className="text-sm font-extrabold text-[#135b52]">
                      {hud.demand.com}%
                    </div>
                  </div>
                  <div className="rounded-xl bg-[#efe4ce]/80 p-1.5">
                    <div className="text-[11px] font-bold text-[#484237]">Work (I)</div>
                    <div className="text-sm font-extrabold text-[#6e4904]">
                      {hud.demand.ind}%
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex items-center justify-between text-xs font-bold text-[#2c303a]">
                  <span>
                    Traffic: {hud.cars} cars ({hud.congestion}% busy)
                  </span>
                  <span>
                    Gardens: {hud.gardensCount} ({hud.greenCoveragePercent}%)
                  </span>
                </div>
                <div className="mt-2 space-y-1 border-t border-[#dcd0b8] pt-2">
                  {MILESTONE_GOALS.map((goal) => {
                    const done = hud.goalsDone.includes(goal.id);
                    return (
                      <div
                        key={goal.id}
                        className="flex items-center justify-between text-xs font-bold"
                      >
                        <span
                          className={
                            done ? "text-[#185a3e] line-through" : "text-[#2c303a]"
                          }
                        >
                          {done ? "✓ " : "○ "}
                          {goal.shortTitle}
                        </span>
                        <span className="text-[11px] font-extrabold text-[#484237]">
                          +${goal.rewardMoney}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setMobileSheetOpen((v) => !v)}
              className="pointer-events-auto flex min-h-[34px] items-center gap-2 rounded-full border border-[#d6c8b0] bg-[#fcf8f0]/95 px-3.5 py-1 text-xs font-extrabold text-[#2c303a] shadow-md backdrop-blur-md focus-visible:outline-2 focus-visible:outline-[#17695f]"
            >
              <span>
                Goals ({hud.goalsDone.length}/{MILESTONE_GOALS.length}) ·{" "}
                {hud.greenCoveragePercent}% Green
              </span>
              <span>{mobileSheetOpen ? "▼" : "▲"}</span>
            </button>
          </div>

          {/* Bottom Tool Palette Dock + Floating Hover Tooltip + Undo */}
          <nav
            aria-label="City building tools"
            className="pointer-events-auto mx-auto flex max-w-full flex-col items-center justify-center"
          >
            {/* Consistent Floating Tooltip Above Dock (including Locked Tool 'Unlocks at X pop') */}
            {hoveredToolDef && (
              <div
                role="tooltip"
                data-testid="tool-hover-tooltip"
                className="mb-1.5 flex flex-wrap items-center justify-center gap-2 rounded-xl border border-[#d6c8b0] bg-[#2c303a]/96 px-3 py-1.5 text-xs text-[#fcf8f0] shadow-xl backdrop-blur-md"
              >
                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-extrabold text-[#f7c95c]">
                  Key {hoveredToolDef.shortcut}
                </span>
                <span className="font-extrabold text-white">{hoveredToolDef.label}</span>
                <span className="hidden sm:inline text-[#e2d6c3]">
                  — {hoveredToolDef.description}
                </span>
                {!unlockedSet.has(hoveredToolDef.id) && hoveredToolDef.unlockPop && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[#b33620] px-2 py-0.5 text-[11px] font-extrabold text-white">
                    <LockIcon className="h-3 w-3" />
                    <span>Unlocks at {hoveredToolDef.unlockPop} pop</span>
                  </span>
                )}
              </div>
            )}

            <div className="flex max-w-full items-center gap-1 sm:gap-1.5 overflow-x-auto rounded-2xl border border-[#d6c8b0] bg-[#fcf8f0]/95 p-1 sm:p-1.5 shadow-2xl backdrop-blur-md">
              {TOOLS.map((tool) => {
                const isUnlocked = unlockedSet.has(tool.id);
                const active = selectedTool === tool.id && isUnlocked;
                const unaffordable =
                  isUnlocked && tool.cost > 0 && hud.money < tool.cost;

                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => selectTool(tool.id)}
                    onMouseEnter={() => setHoveredToolId(tool.id)}
                    onMouseLeave={() =>
                      setHoveredToolId((prev) => (prev === tool.id ? null : prev))
                    }
                    onFocus={() => setHoveredToolId(tool.id)}
                    onBlur={() =>
                      setHoveredToolId((prev) => (prev === tool.id ? null : prev))
                    }
                    aria-disabled={!isUnlocked}
                    data-testid={`tool-${tool.id}`}
                    title={
                      isUnlocked
                        ? `${tool.label} (${tool.shortcut}) — ${tool.description}`
                        : `${tool.label} — Unlocks at ${tool.unlockPop} pop`
                    }
                    className={`group relative flex min-h-[48px] min-w-[41px] sm:min-w-[78px] lg:min-w-[88px] shrink-0 flex-col lg:flex-row items-center justify-center gap-0.5 lg:gap-1.5 rounded-xl px-1.5 sm:px-2.5 py-1 text-xs font-extrabold transition focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#17695f] ${
                      !isUnlocked
                        ? "cursor-not-allowed border border-[#c8beaa] bg-[#e2dac9] text-[#4d473d]"
                        : active
                          ? "bg-[#2c303a] text-[#fcf8f0] shadow-md -translate-y-0.5"
                          : "bg-[#efe4ce]/90 text-[#2c303a] hover:bg-[#e2d3b5]"
                    }`}
                  >
                    {/* Lock badge (always visible when locked) or Keyboard shortcut pill */}
                    {!isUnlocked ? (
                      <span
                        className="absolute top-1 right-1 lg:static inline-flex h-3.5 w-3.5 lg:h-4 lg:w-4 shrink-0 items-center justify-center rounded-full bg-[#4d473d] text-white"
                        aria-hidden="true"
                      >
                        <LockIcon className="h-2.5 w-2.5" />
                      </span>
                    ) : (
                      <span
                        className={`hidden lg:inline-flex h-4 min-w-[16px] items-center justify-center rounded px-1 text-[10px] font-extrabold ${
                          active
                            ? "bg-white/20 text-[#fcf8f0]"
                            : "bg-[#d8cbb2] text-[#2c303a]"
                        }`}
                      >
                        {tool.shortcut}
                      </span>
                    )}

                    <ToolIcon
                      id={tool.id}
                      className={`h-4 w-4 sm:h-5 sm:w-5 shrink-0 ${
                        !isUnlocked ? "grayscale opacity-75" : ""
                      }`}
                    />

                    <div className="flex flex-col items-center lg:items-start leading-tight">
                      <span className="hidden lg:inline">{tool.label}</span>
                      <span className="lg:hidden text-[10px] sm:text-[11px]">{tool.shortLabel}</span>

                      {/* Cost or Unlock Requirement Chip */}
                      {!isUnlocked && tool.unlockPop ? (
                        <span className="mt-0.5 inline-flex items-center rounded-full bg-[#cfc4ae] px-1.5 py-0.2 text-[9px] sm:text-[10px] font-extrabold text-[#2c303a]">
                          {tool.unlockPop} pop
                        </span>
                      ) : (
                        <span
                          className={`mt-0.5 inline-flex items-center rounded-full px-1.5 py-0.2 text-[9px] sm:text-[10px] font-extrabold ${
                            unaffordable
                              ? "bg-[#b91c1c] text-white"
                              : active
                                ? "bg-[#b33620] text-white"
                                : "bg-[#d8cbb2] text-[#2c303a]"
                          }`}
                        >
                          {tool.cost > 0 ? `$${tool.cost}` : "Free"}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}

              <div className="mx-0.5 h-7 w-px shrink-0 bg-[#d6c8b0]" />

              {/* Undo Last Placement Button */}
              <button
                type="button"
                onClick={handleUndoLastPlacement}
                aria-disabled={!undoSnapshot}
                data-testid="undo-button"
                title={
                  undoSnapshot
                    ? `Undo ${undoSnapshot.label} (Z)`
                    : "Nothing to undo yet (Z)"
                }
                className={`flex min-h-[44px] min-w-[40px] sm:min-h-[48px] sm:min-w-[64px] shrink-0 flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-1 rounded-xl px-1.5 sm:px-2.5 py-1 text-xs font-extrabold transition focus-visible:outline-2 focus-visible:outline-[#17695f] ${
                  undoSnapshot
                    ? "bg-[#efe4ce] text-[#2c303a] hover:bg-[#e2d2b3]"
                    : "cursor-not-allowed border border-[#d5cbb8] bg-[#e6decb] text-[#544d40]"
                }`}
              >
                <span className="text-sm leading-none">↶</span>
                <div className="flex flex-col items-center sm:items-start leading-tight">
                  <span className="text-[10px] sm:text-xs">Undo</span>
                  <span className="text-[9px] sm:text-[10px] font-extrabold text-[#484237]">
                    Key Z
                  </span>
                </div>
              </button>
            </div>
          </nav>
        </div>
      </div>
    </div>
  );
}
