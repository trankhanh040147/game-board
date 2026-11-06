export type GameEventType =
  | "placed"
  | "built"
  | "grown"
  | "garden planted"
  | "garden_planted"
  | "milestone"
  | "income"
  | "traffic_jam"
  | "green_city"
  | "unlocked"
  | "undo";

export interface GameEventRecord {
  id: number;
  type: GameEventType;
  tick: number;
  timestamp: number;
  x?: number;
  y?: number;
  kind?: string;
  level?: number;
  amount?: number;
  goalId?: string;
  label?: string;
  message?: string;
}

type Listener = (event: GameEventRecord) => void;

export class GameEventEmitter {
  private listeners = new Map<GameEventType | "*", Set<Listener>>();
  private history: GameEventRecord[] = [];
  private nextId = 1;

  public on(type: GameEventType | "*", listener: Listener): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  public emit(
    type: GameEventType,
    payload: Omit<GameEventRecord, "id" | "type" | "timestamp"> = { tick: 0 },
  ): GameEventRecord {
    const record: GameEventRecord = {
      id: this.nextId++,
      type,
      timestamp: Date.now(),
      ...payload,
    };

    this.history.push(record);
    if (this.history.length > 60) {
      this.history.shift();
    }

    const direct = this.listeners.get(type);
    if (direct) {
      for (const fn of direct) {
        fn(record);
      }
    }

    // Mirror "garden planted" <-> "garden_planted" so listeners using either convention receive it
    if (type === "garden planted") {
      const alias = this.listeners.get("garden_planted");
      if (alias) {
        for (const fn of alias) {
          fn({ ...record, type: "garden_planted" });
        }
      }
    } else if (type === "garden_planted") {
      const alias = this.listeners.get("garden planted");
      if (alias) {
        for (const fn of alias) {
          fn({ ...record, type: "garden planted" });
        }
      }
    }

    const wildcard = this.listeners.get("*");
    if (wildcard) {
      for (const fn of wildcard) {
        fn(record);
      }
    }

    return record;
  }

  public getRecentEvents(): GameEventRecord[] {
    return [...this.history];
  }

  public clear(): void {
    this.history = [];
  }
}

export const gameEvents = new GameEventEmitter();
