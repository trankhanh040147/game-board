// End-to-end check of the WASM JS API: a headless browser-like client in Node
// that loads sim.wasm, joins over WebSocket, syncs the clock, paces inputs,
// predicts, reconciles and acks snapshots, the same calls the TS client makes.
// Usage: node wasm/test/client-loop.mjs <sim.wasm> <wasm_exec.js> ws://127.0.0.1:8080/ws [seconds]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [wasmPath, execPath, url, secs = "10"] = process.argv.slice(2);
await import(pathToFileURL(execPath).href);
const go = new globalThis.Go();
const ready = new Promise((r) => (globalThis.onNetcodeSimReady = r));
const { instance } = await WebAssembly.instantiate(readFileSync(wasmPath), go.importObject);
go.run(instance);
await ready;
const S = globalThis.NetcodeSim;

const conn = S.newConn();
const clock = S.newClock();
const pacer = S.newPacer();
let pred = 0;
let settings = null;
let seq = 0;
const stats = { snapshots: 0, pongs: 0, inputsSent: 0, corrections: 0, replayed: 0, entitiesSeen: 0, errors: [] };

const ws = new WebSocket(url);
ws.binaryType = "arraybuffer";
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.send(JSON.stringify({ t: "join", name: "node-wasm-client" }));

ws.onmessage = (ev) => {
  const now = performance.now();
  if (typeof ev.data === "string") {
    const m = JSON.parse(ev.data);
    if (m.t === "welcome") { settings = m.settings; pred = S.newPredictor(m.spawn); }
    else if (m.t === "settings") settings = m.settings;
    else if (m.t === "error") stats.errors.push(m.msg);
    return;
  }
  const msg = S.decode(conn, new Uint8Array(ev.data), now);
  if (msg.dup) return;
  if (msg.type === "pong") { S.clockPong(clock, msg, now); stats.pongs++; }
  else if (msg.type === "snapshot" && pred) {
    stats.snapshots++;
    stats.entitiesSeen = Math.max(stats.entitiesSeen, msg.entities.length);
    S.pacerFeedback(pacer, msg.own.starved, now);
    if (msg.lastProcessedInputSeq > 0) {
      const r = S.reconcile(pred, msg.own.state, msg.lastProcessedInputSeq, S.dtForRate(settings.tickRate), settings.reconcile, msg.own.life, msg.own.dead);
      if (r.corrected) stats.corrections++;
      stats.replayed += r.replayed;
    }
    ws.send(S.encodeSnapshotAck(conn, msg.baselineId, msg.serverTick, now));
  }
};

const pingTimer = setInterval(() => ws.send(S.encodePing(conn, performance.now())), 250);
ws.send(S.encodePing(conn, performance.now()));
let yaw = 0;
const tickTimer = setInterval(() => {
  if (!pred) return;
  const now = performance.now();
  for (const clientTick of S.pacerDue(pacer, clock, now)) {
    yaw += 0.02;
    const cmd = { seq: ++seq, clientTick, buttons: S.BTN.forward, yaw: S.angleFromRadians(yaw), pitch: 0 };
    S.predict(pred, cmd, S.dtForRate(settings.tickRate));
    ws.send(S.encodeInputFromPredictor(conn, pred, now));
    stats.inputsSent++;
  }
}, 2);

await new Promise((r) => setTimeout(r, Number(secs) * 1000));
clearInterval(pingTimer); clearInterval(tickTimer);
const now = performance.now();
const est = S.clockEstimate(clock, now);
const info = S.predictorInfo(pred);
const apiCheck = {
  aimDir: S.aimDir(0, 0).map((v) => +v.toFixed(3)),
  traceFromSpawnM: +S.traceMap(info.state.x, info.state.y, info.state.z, info.state.yaw, 0).toFixed(2),
  claimBytes: S.encodeClaim(conn, { seq: 1, x: 0, y: 0, z: 0, victimId: 0, hitbox: 0 }, now).length,
  fireCooldownTicks64: S.fireCooldownTicks(64),
};
const out = { apiCheck,
  seconds: Number(secs), ...stats,
  predictorCorrections: info.corrections, pendingAtEnd: info.pending.length,
  rttMs: +est.rttMs.toFixed(2), jitterMs: +est.jitterMs.toFixed(2), serverTick: Math.round(est.serverTick), tickRate: est.tickRate,
  pacer: S.pacerInfo(pacer), conn: S.connStats(conn),
  position_m: [info.state.x / S.FX, info.state.y / S.FX, info.state.z / S.FX].map((v) => +v.toFixed(2)),
};
console.log(JSON.stringify(out, null, 2));
ws.close();
process.exit(0);
