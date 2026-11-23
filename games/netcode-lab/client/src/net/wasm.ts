// Loads the shared Go sim + codec (core's wasm/main.go) as globalThis.NetcodeSim. API: docs/PROTOCOL.md + wasm/main.go.

export interface SimState { x: number; y: number; z: number; vx: number; vy: number; vz: number; onGround: boolean; yaw: number; pitch: number }
export interface Cmd { seq: number; clientTick: number; buttons: number; yaw: number; pitch: number; renderTick?: number; renderFrac?: number; subtickFrac?: number }
export interface Entity { id: number; team: number; x: number; y: number; z: number; yaw: number; pitch: number; health: number; anim: number }
export interface Snapshot {
  type: "snapshot"; dup: boolean; serverTick: number; serverTimeMs: number; lastProcessedInputSeq: number;
  own: { state: SimState; health: number; inputBuffer: number; starved: number; inputLead: number; dead: boolean; life: number };
  snapId: number; baselineId: number; encoding: number; entities: Entity[]; events: SnapEvent[];
}
export interface Pong { type: "pong"; dup: boolean; clientSendMs: number; serverRecvMs: number; serverSendMs: number; serverTick: number; tickFrac: number; tickRate: number }
export interface Debug { type: "debug"; dup: boolean; serverTick: number; players: { id: number; x: number; y: number; z: number }[] }
export type Decoded = Snapshot | Pong | Debug | { type: "invalid"; error: string; dup?: boolean } | { type: "unknown"; code: number; dup: boolean };

import type { SnapEvent } from "../game/events";

export interface NetcodeSim {
  apiVersion: number; protocolVersion: number; FX: number;
  BTN: { forward: number; back: number; left: number; right: number; jump: number; fire: number };
  ANIM: { onGround: number; moving: number; dead: number };
  HIT: { none: number; body: number; head: number };
  ENC: { quant: number; bitpack: number; delta: number };
  PLAYER: { halfWidth: number; height: number; eyeHeight: number; body: { half: number; top: number }; head: { half: number; bottom: number; top: number } };
  dtForRate(rate: number): number;
  angleFromRadians(r: number): number;
  angleToRadians(a: number): number;
  newPredictor(s: SimState): number;
  predictorReset(p: number, s: SimState): void;
  predict(p: number, c: Cmd, dt: number): SimState;
  reconcile(p: number, server: SimState, lastSeq: number, dt: number, replay: boolean, life: number, dead: boolean): { state: SimState; corrected: boolean; replayed: number; respawned: boolean; delta: [number, number, number] };
  predictorInfo(p: number): { state: SimState; corrections: number; replayed: number; pending: number[] };
  newConn(): number;
  encodeInputFromPredictor(conn: number, p: number, nowMs: number): Uint8Array;
  encodePing(conn: number, nowMs: number): Uint8Array;
  encodeSnapshotAck(conn: number, baselineId: number, serverTick: number, nowMs: number): Uint8Array;
  decode(conn: number, b: Uint8Array, nowMs: number): Decoded;
  connStats(conn: number): { sent: number; acked: number; lost: number; rttMs: number; received: number; duplicates: number; old: number; remoteGaps: number };
  encodeClaim(conn: number, c: { seq: number; clientTick: number; x: number; y: number; z: number; victimId: number; hitbox: number }, nowMs: number): Uint8Array;
  aimDir(yaw: number, pitch: number): [number, number, number];
  /** Distance (m) from the eye at feet position (Q16.16) along yaw/pitch to the first map box, max 300. */
  traceMap(x: number, y: number, z: number, yaw: number, pitch: number): number;
  fireCooldownTicks(tickRate: number): number;
  newClock(): number;
  clockPong(c: number, p: Pong, nowMs: number): void;
  clockEstimate(c: number, nowMs: number): { ready: boolean; offsetMs: number; rttMs: number; minRttMs: number; lastRttMs: number; jitterMs: number; samples: number; serverTimeMs: number; serverTick: number; tickRate: number };
  newPacer(): number;
  pacerDue(pacer: number, clock: number, nowMs: number): number[];
  pacerFeedback(pacer: number, starved: number, nowMs: number, inputLead?: number): void;
  pacerInfo(pacer: number): { marginTicks: number; raises: number };
  free(h: number): void;
}

const EXPECTED_API = 3;

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

export async function loadSim(): Promise<NetcodeSim> {
  await loadScript("./wasm_exec.js");
  const g = globalThis as any;
  const go = new g.Go();
  const ready = new Promise<void>((r) => (g.onNetcodeSimReady = r));
  const resp = await fetch("./sim.wasm");
  if (!resp.ok) throw new Error(`sim.wasm: HTTP ${resp.status}`);
  const { instance } = await WebAssembly.instantiateStreaming(resp, go.importObject);
  go.run(instance);
  await ready;
  const sim = g.NetcodeSim as NetcodeSim;
  if (sim.apiVersion !== EXPECTED_API) throw new Error(`sim.wasm apiVersion ${sim.apiVersion}, client expects ${EXPECTED_API}`);
  return sim;
}
