// Loads the duel sim + session (wasm/duel, Go) as globalThis.NetcodeDuel.

export interface DuelFighter { x: number; y: number; hp: number; facing: number; atk: number; stun: number }
export interface DuelState { frame: number; ko: number; score: [number, number]; f: [DuelFighter, DuelFighter] }
export interface DuelStats {
  frame: number; delay: number; delayAuto: boolean; mode: number; started: boolean;
  rollbacks: number; framesRolledBack: number; maxDepth: number; lastDepth: number; lastRollbackAt: number; predicted: number;
  stallFrames: number; stallMs: number; syncWaits: number; checksCompared: number; remoteChanges: number;
  packetsIn: number; packetsOut: number; rttMs: number; jitterMs: number; rttSamples: number;
  rollbacksPerSec: number; rolledBackPerSec: number; stallFramesPerSec: number; stallMsPerSec: number;
  seed: string; injectedAt: number; injectedBit: number; injectedFighter: number;
  desync: { frame: number; local: string; remote: string } | null;
}
export interface NetcodeDuel {
  apiVersion: number; HZ: number; Q: number; STAGE_W: number; W: number; H: number; MAX_ROLLBACK: number;
  ATK: { startup: number; active: number; total: number; reach: number; low: number; high: number };
  BTN: { left: number; right: number; jump: number; attack: number };
  MODE: { rollback: number; lockstep: number };
  autoDelay(rttMs: number): number;
  lockstepAutoDelay(rttMs: number): number;
  newSession(c: { side: number; delay: number; mode: number; epoch: number; seed: string }): number;
  begin(h: number): void;
  tick(h: number, buttons: number, nowMs: number): boolean;
  packet(h: number, nowMs: number): Uint8Array;
  receive(h: number, b: Uint8Array, nowMs: number): string | null;
  inject(h: number): void;
  state(h: number): DuelState;
  stats(h: number): DuelStats;
  free(h: number): void;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

export async function loadDuel(): Promise<NetcodeDuel> {
  await loadScript("./wasm_exec.js");
  const g = globalThis as any;
  const go = new g.Go();
  const ready = new Promise<void>((r) => (g.onNetcodeDuelReady = r));
  const resp = await fetch("./duel.wasm");
  if (!resp.ok) throw new Error(`duel.wasm: HTTP ${resp.status} (run: make duel-www)`);
  const { instance } = await WebAssembly.instantiate(await resp.arrayBuffer(), go.importObject);
  go.run(instance);
  await ready;
  if (g.NetcodeDuel.apiVersion !== 1) throw new Error(`duel.wasm API ${g.NetcodeDuel.apiVersion}, page expects 1`);
  return g.NetcodeDuel as NetcodeDuel;
}
