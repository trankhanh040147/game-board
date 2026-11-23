// Duel mini-mode page (A.13, presets P21–P23 and the duel half of P25). Two browser windows (or one window and
// bin/duelbot) join a room on bin/duelrelay. Each runs the deterministic Go duel sim in WASM; the relay only forwards
// inputs. Every number on this page is measured by the session (sim/duel/session.go).
import { loadDuel, type NetcodeDuel, type DuelState, type DuelStats } from "./wasm";
import { WsTransport, WtTransport, webTransportPossible, type Transport } from "../net/transport";

interface PresetDoc { id: string; idea: string; observe: string; banner: string }
const found = import.meta.glob<PresetDoc[]>("../../../docs/presets.json", { eager: true, import: "default" });
const DOCS = new Map<string, PresetDoc>((Object.values(found)[0] ?? []).map((p) => [p.id, p]));
const P25_DUEL = "Desync: non-deterministic simulation in lockstep or rollback games, caught by state checksums (A.14).";

const css = `
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--dim:#8a91a0;--blue:#2563EB;--orange:#EA580C;--bad:#ef4444;--ok:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.4 ui-sans-serif,system-ui,sans-serif}
#app{display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:12px;padding:12px;max-width:1240px;margin:0 auto}
@media (max-width:900px){#app{grid-template-columns:1fr}}
h1{font-size:16px;margin:0 0 8px}h2{font-size:12px;margin:12px 0 4px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
canvas{width:100%;background:#0b0d11;border:2px solid var(--line);border-radius:6px;display:block}
canvas.rb{border-color:var(--orange)}canvas.stall{border-color:var(--warn)}canvas.desync{border-color:var(--bad)}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px}
.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0}
button,select{background:#222733;color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font:inherit;cursor:pointer}
button:hover{border-color:var(--dim)}button.on{border-color:var(--blue);background:#1b2a4a}
table{width:100%;border-collapse:collapse}td{padding:2px 0;vertical-align:top}td:last-child{text-align:right;font-variant-numeric:tabular-nums}
.dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}
#banner{min-height:2.8em;margin:8px 0;padding:6px 8px;border-left:3px solid var(--blue);background:#141a26}
#status{margin:6px 0}#desync{font-weight:600;margin:6px 0}
kbd{background:#222733;border:1px solid var(--line);border-radius:3px;padding:0 4px}
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
document.body.innerHTML = `
<div id="app">
  <div>
    <h1>Duel · rollback, input delay, lockstep</h1>
    <div class="row">
      <button data-p="P21">P21 Rollback</button><button data-p="P22">P22 Input delay</button>
      <button data-p="P23">P23 Lockstep</button><button data-p="P25">P25 Inject nondeterminism</button>
    </div>
    <div id="banner" class="dim">Pick a preset. Open this page in a second window side by side, or run <kbd>bin/duelbot</kbd> for a bot opponent.</div>
    <canvas id="stage" width="800" height="300"></canvas>
    <div id="status" class="dim">Loading…</div>
    <div id="desync"></div>
    <div class="dim">Move <kbd>A</kbd>/<kbd>D</kbd> or <kbd>←</kbd>/<kbd>→</kbd>, jump <kbd>W</kbd>/<kbd>↑</kbd>/<kbd>Space</kbd>, attack <kbd>J</kbd>/<kbd>K</kbd>.
    Use two windows side by side, not two tabs in one window: the browser throttles a hidden tab, and its peer then waits.</div>
  </div>
  <div class="panel">
    <h2>Match</h2>
    <div class="row">Mode <select id="mode"><option value="0">rollback</option><option value="1">lockstep</option></select>
      D <select id="delay"><option value="-1">auto</option>${[0, 1, 2, 3, 4, 6, 8].map((d) => `<option value="${d}">${d}</option>`).join("")}</select>
      <button id="restart">Restart both</button></div>
    <div class="row">My link <select id="cond"><option value="lan">LAN</option><option value="default">Default (40 ms)</option><option value="bad">Bad route (80 ms, jitter 15, loss 1%)</option></select>
      <span class="dim">simulated</span></div>
    <div class="row"><button id="inject">Inject nondeterminism (this window)</button></div>
    <h2>Rollback (P21, P22)</h2><table id="t-rb"></table>
    <h2>Lockstep (P23)</h2><table id="t-ls"></table>
    <h2>Checksums (P25)</h2><table id="t-ck"></table>
    <h2>Link</h2><table id="t-net"></table>
  </div>
</div>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("stage");
const ctx = canvas.getContext("2d")!;
const statusEl = $("status"), desyncEl = $("desync"), bannerEl = $("banner");
const modeSel = $<HTMLSelectElement>("mode"), delaySel = $<HTMLSelectElement>("delay"), condSel = $<HTMLSelectElement>("cond");

const params = new URLSearchParams(location.search);
const room = params.get("room") ?? "duel";
// ?preset=P21|P22|P23|P25 (links from the game's Lab): applied once, when the first match starts.
let pendingPreset = (params.get("preset") ?? "").toUpperCase();
const PRESET_CFG: Record<string, { mode: number; delay: number }> = { P21: { mode: 0, delay: 0 }, P22: { mode: 0, delay: -1 }, P23: { mode: 1, delay: -1 } };

let D: NetcodeDuel;
let net: Transport | null = null;
let h = 0; // session handle
let side = 0;
let matchInfo: any = null;
let startAt = 0;
let slotsDone = 0;
let t0 = 0;
let myProfile = "default", peerProfile = "?", peerName = "", peerTransport = "";
let simulatedThisSec = 0, fps = 0, fpsAt = 0;
const WARMUP_MS = 1000; // ping-only time before frame 0, so "auto" D has a measured ping

const keys = new Set<string>();
addEventListener("keydown", (e) => { if (!(e.target instanceof HTMLSelectElement)) { keys.add(e.code); if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault(); } });
addEventListener("keyup", (e) => keys.delete(e.code));
addEventListener("blur", () => keys.clear());
function buttons(): number {
  const B = D.BTN;
  let b = 0;
  if (keys.has("KeyA") || keys.has("ArrowLeft")) b |= B.left;
  if (keys.has("KeyD") || keys.has("ArrowRight")) b |= B.right;
  if (keys.has("KeyW") || keys.has("ArrowUp") || keys.has("Space")) b |= B.jump;
  if (keys.has("KeyJ") || keys.has("KeyK")) b |= B.attack;
  return b;
}

function setBanner(id: string) {
  const d = DOCS.get(id);
  const text = id === "P25" ? P25_DUEL : d?.banner ?? "";
  bannerEl.className = "";
  bannerEl.innerHTML = `<b>${id} ${d?.idea ?? ""}</b> · ${text}<br><span class="dim">Observe: ${d?.observe ?? ""}</span>`;
  document.querySelectorAll<HTMLButtonElement>("[data-p]").forEach((b) => b.classList.toggle("on", b.dataset.p === id));
}

function restart(mode: number, delay: number) {
  net?.sendControl({ t: "restart", mode, delay });
}

document.querySelectorAll<HTMLButtonElement>("[data-p]").forEach((b) => b.addEventListener("click", () => {
  const id = b.dataset.p!;
  setBanner(id);
  if (id === "P21") { modeSel.value = "0"; delaySel.value = "0"; restart(0, 0); }
  if (id === "P22") { modeSel.value = "0"; delaySel.value = "-1"; restart(0, -1); }
  if (id === "P23") { modeSel.value = "1"; delaySel.value = "-1"; restart(1, -1); }
  if (id === "P25" && h) D.inject(h);
}));
$("restart").addEventListener("click", () => restart(+modeSel.value, +delaySel.value));
$("inject").addEventListener("click", () => { if (h) { D.inject(h); setBanner("P25"); } });
condSel.addEventListener("change", () => net?.sendControl({ t: "cond", profile: condSel.value }));

function onControl(m: any) {
  switch (m.t) {
    case "welcome": side = m.side; myProfile = m.profile; condSel.value = m.profile; break;
    case "wait": statusEl.textContent = `Room "${room}": waiting for an opponent. Open this page in another window, or run: bin/duelbot -room ${room}`; break;
    case "cond": myProfile = m.profile; condSel.value = m.profile in { lan: 1, default: 1, bad: 1 } ? m.profile : condSel.value; break;
    case "peerCond": peerProfile = m.profile; break;
    case "peerLeft": if (h) D.free(h); h = 0; matchInfo = null; statusEl.textContent = "Opponent left. Waiting for a new one…"; break;
    case "error": statusEl.innerHTML = `<span class="bad">${m.error}</span>`; break;
    case "start":
      if (h) D.free(h);
      side = m.side; matchInfo = m; peerName = m.peer; peerTransport = m.peerTransport; peerProfile = m.peerProfile;
      modeSel.value = String(m.mode); delaySel.value = String(m.delay);
      h = D.newSession({ side: m.side, delay: m.delay, mode: m.mode, epoch: m.epoch, seed: String(BigInt(m.seed) + BigInt(m.side)) });
      startAt = performance.now();
      slotsDone = Math.floor((performance.now() - t0) / (1000 / D.HZ));
      if (pendingPreset) {
        const id = pendingPreset, cfg = PRESET_CFG[id];
        setBanner(id);
        if (cfg && (cfg.mode !== m.mode || cfg.delay !== m.delay)) restart(cfg.mode, cfg.delay); // the next start carries it
        else {
          pendingPreset = "";
          if (id === "P25") setTimeout(() => { if (h) D.inject(h); }, WARMUP_MS + 500); // after frame 0
        }
      }
      break;
  }
}

function onBinary(b: Uint8Array) {
  if (h) D.receive(h, b, performance.now());
}

// The sim pump runs from a worker timer: a hidden tab's own timers are throttled to 1 Hz,
// which would stall the opponent. Rendering stays on requestAnimationFrame.
function startPump(fn: () => void) {
  const src = "setInterval(()=>postMessage(0),4)";
  const w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  w.onmessage = fn;
}

function pump() {
  if (!h) return;
  const now = performance.now();
  const target = Math.floor((now - t0) / (1000 / D.HZ));
  let due = target - slotsDone;
  if (due > 8) due = 8; // after a long freeze, drop the backlog instead of fast-forwarding
  slotsDone = target;
  for (let k = 0; k < due; k++) {
    const s = D.stats(h);
    if (!s.started && now - startAt >= WARMUP_MS) D.begin(h);
    if (D.tick(h, buttons(), now)) simulatedThisSec++;
    net?.sendBinary(D.packet(h, now));
  }
  if (now - fpsAt >= 1000) { fps = simulatedThisSec * 1000 / (now - fpsAt); simulatedThisSec = 0; fpsAt = now; }
}

const fmt = (v: number, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : "—");
function rows(id: string, r: [string, string, string?][]) {
  $(id).innerHTML = r.map(([k, v, c]) => `<tr><td class="dim">${k}</td><td class="${c ?? ""}">${v}</td></tr>`).join("");
}

// Cosmetic art (client/public/duel, CC0, docs/ASSETS.md). It only reads sim state; nothing here feeds the sim.
// Sheets: 96×128 frames, rows idle(1) walk(8) jump(1) attack(3) hit(2). Missing art falls back to boxes, logged once.
function img(src: string) { const i = new Image(); i.src = src; i.onerror = () => console.warn(`duel art missing: ${src}`); return i; }
const art = { fighters: [img("./duel/fighter_blue.png"), img("./duel/fighter_orange.png")], bg: img("./duel/stage_bg.png"), ground: img("./duel/ground_tile.png") };
const ready = (i: HTMLImageElement) => i.complete && i.naturalWidth > 0;
const sfx = { punch: new Audio("./duel/punch.ogg"), whoosh: new Audio("./duel/whoosh.ogg") };
function play(a: HTMLAudioElement) { const c = a.cloneNode() as HTMLAudioElement; c.volume = 0.5; c.play().catch(() => {}); }
const FW = 96, FH = 128;
const cos = [0, 1].map(() => ({ lastX: 0, walkT: 0, lastAtk: 0, lastStun: 0 }));
let soundFrame = -1;

let flashUntil = 0;
let lastRb = 0;
function render() {
  requestAnimationFrame(render);
  const W = canvas.width, Hh = canvas.height;
  ctx.fillStyle = "#0b0d11"; ctx.fillRect(0, 0, W, Hh);
  if (ready(art.bg)) ctx.drawImage(art.bg, 0, 0, W, Hh - 40);
  if (ready(art.ground)) { for (let x = 0; x < W; x += 40) ctx.drawImage(art.ground, x, Hh - 40, 40, 40); }
  else { ctx.fillStyle = "#1f2430"; ctx.fillRect(0, Hh - 40, W, 40); }
  if (!h) { canvas.className = ""; return; }
  const st: DuelState = D.state(h);
  const s: DuelStats = D.stats(h);
  const q = D.Q, gy = Hh - 40;
  const now = performance.now();
  if (s.rollbacks > lastRb) { lastRb = s.rollbacks; flashUntil = now + 120; }
  const stalled = s.started && (s.mode === D.MODE.lockstep ? s.stallFramesPerSec > 0 : s.predicted >= D.MAX_ROLLBACK);
  canvas.className = s.desync ? "desync" : now < flashUntil ? "rb" : stalled ? "stall" : "";
  st.f.forEach((f, i) => {
    const x = f.x / q, y = gy - f.y / q, w = D.W / q, hgt = D.H / q;
    const c = cos[i];
    const moving = Math.abs(f.x - c.lastX) > 0;
    c.walkT = moving ? c.walkT + 1 : 0;
    c.lastX = f.x;
    if (st.frame !== soundFrame) {
      if (f.atk > 0 && c.lastAtk === 0) play(sfx.whoosh);
      if (f.stun > 0 && c.lastStun === 0) play(sfx.punch);
    }
    c.lastAtk = f.atk; c.lastStun = f.stun;
    const sheet = art.fighters[i];
    if (ready(sheet)) {
      let row = 0, col = 0;
      if (f.stun) { row = 4; col = Math.floor(f.stun / 9) % 2; }
      else if (f.atk) { row = 3; col = Math.min(2, Math.floor((f.atk - 1) * 3 / D.ATK.total)); }
      else if (f.y > 0) row = 2;
      else if (moving) { row = 1; col = Math.floor(c.walkT / 5) % 8; }
      const dh = hgt * 1.5, dw = dh * FW / FH;
      ctx.save();
      ctx.translate(x, y);
      if (f.facing < 0) ctx.scale(-1, 1);
      ctx.drawImage(sheet, col * FW, row * FH, FW, FH, -dw / 2, -dh, dw, dh);
      ctx.restore();
      ctx.strokeStyle = i === 0 ? "rgba(37,99,235,.7)" : "rgba(234,88,12,.7)"; // the sim's box: the real hurtbox
      ctx.strokeRect(x - w / 2, y - hgt, w, hgt);
    } else {
      ctx.fillStyle = i === 0 ? "#2563EB" : "#EA580C";
      ctx.globalAlpha = f.stun ? 0.5 : 1;
      ctx.fillRect(x - w / 2, y - hgt, w, hgt);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#fff"; ctx.fillRect(x + f.facing * (w / 2 - 6) - 3, y - hgt + 12, 6, 6);
    }
    if (f.atk > D.ATK.startup && f.atk <= D.ATK.startup + D.ATK.active) {
      const x0 = x + f.facing * w / 2, x1 = x0 + f.facing * D.ATK.reach / q;
      ctx.fillStyle = "rgba(255,255,255,.6)";
      ctx.fillRect(Math.min(x0, x1), y - D.ATK.high / q, Math.abs(x1 - x0), (D.ATK.high - D.ATK.low) / q);
    }
    const bx = i === 0 ? 20 : W - 220;
    ctx.fillStyle = "#333"; ctx.fillRect(bx, 14, 200, 10);
    ctx.fillStyle = i === 0 ? "#2563EB" : "#EA580C"; ctx.fillRect(bx, 14, 2 * Math.max(0, f.hp), 10);
    ctx.fillStyle = "#e6e8ee"; ctx.font = "12px ui-sans-serif,system-ui";
    ctx.fillText(`${i === side ? "you" : "opponent"} · KOs ${st.score[i]}`, bx, 40);
  });
  soundFrame = st.frame;
  ctx.fillStyle = "#8a91a0"; ctx.font = "12px ui-monospace,monospace";
  ctx.fillText(`frame ${st.frame}`, W / 2 - 40, 20);
  if (st.ko) { ctx.fillStyle = "#e6e8ee"; ctx.font = "bold 28px ui-sans-serif"; ctx.fillText("K.O.", W / 2 - 30, Hh / 2); }
  if (!s.started) { ctx.fillStyle = "#e6e8ee"; ctx.font = "16px ui-sans-serif"; ctx.fillText("measuring ping…", W / 2 - 60, Hh / 2); }

  const rollback = s.mode === D.MODE.rollback;
  const dTxt = s.started ? `${s.delay}${s.delayAuto ? ` auto (ping ${fmt(s.rttMs)} ms${rollback ? "" : ", lockstep buffer"})` : " manual"}` : "—";
  statusEl.innerHTML = `Room "${room}" · you are ${side === 0 ? "Blue" : "Orange"} · opponent ${peerName}${matchInfo?.peerBot ? " (bot)" : ""} via ${peerTransport} · ` +
    `${rollback ? "rollback" : "lockstep"}, D = ${dTxt} · ${fmt(fps)} frames/s simulated`;
  const avg = s.rollbacks ? s.framesRolledBack / s.rollbacks : 0;
  rows("t-rb", rollback ? [
    ["Rollbacks / s (last 1 s)", fmt(s.rollbacksPerSec, 1)],
    ["Frames rolled back / s", fmt(s.rolledBackPerSec, 1)],
    ["Rollbacks · frames rolled back", `${s.rollbacks} · ${s.framesRolledBack}`],
    ["Avg · max depth (frames)", `${fmt(avg, 1)} · ${s.maxDepth}`],
    ["Predicted frames now", `${s.predicted} / ${D.MAX_ROLLBACK}`, s.predicted >= D.MAX_ROLLBACK ? "warn" : ""],
    ["Input delay D", dTxt],
    ["Waits at rollback cap", `${s.stallFrames} frames · ${fmt(s.stallMs)} ms`],
    ["Time-sync waits", `${s.syncWaits} frames`],
  ] : [["Rollbacks", "none in lockstep", "dim"]]);
  rows("t-ls", !rollback ? [
    ["Stall frames / s (last 1 s)", fmt(s.stallFramesPerSec, 1), s.stallFramesPerSec > 0 ? "warn" : ""],
    ["Stall ms / s", fmt(s.stallMsPerSec)],
    ["Stall frames · ms total", `${s.stallFrames} · ${fmt(s.stallMs)}`],
    ["Playout buffer D", dTxt],
  ] : [["Stalls", "lockstep only", "dim"]]);
  const inj = s.injectedAt >= 0 ? `bit ${s.injectedBit} of fighter ${s.injectedFighter} x at frame ${s.injectedAt} (seed ${s.seed})` : "none";
  rows("t-ck", [
    ["Frames compared", String(s.checksCompared)],
    ["My session seed", s.seed],
    ["Injected here", inj, s.injectedAt >= 0 ? "warn" : ""],
    ["Status", s.desync ? `DESYNC at frame ${s.desync.frame}` : "in sync", s.desync ? "bad" : "ok"],
  ]);
  desyncEl.innerHTML = s.desync ? `<span class="bad">DESYNC at frame ${s.desync.frame}: my checksum ${s.desync.local}, opponent's ${s.desync.remote}. ` +
    `${s.injectedAt >= 0 ? `This window flipped bit ${s.injectedBit} of fighter ${s.injectedFighter} x at frame ${s.injectedAt} (seed ${s.seed}).` : "The opponent's sim diverged (its seed and flip are on its screen)."} Restart both to resync.</span>` : "";
  rows("t-net", [
    ["Peer RTT (median of 32, via relay)", `${fmt(s.rttMs)} ms`],
    ["Peer jitter", `${fmt(s.jitterMs, 1)} ms`],
    ["My link · opponent's link (simulated)", `${myProfile} · ${peerProfile}`],
    ["Transport", net?.kind === "wt" ? "WebTransport datagrams" : "WebSocket (TCP; loss becomes a stall)"],
    ["Packets out · in", `${s.packetsOut} · ${s.packetsIn}`],
    ["Opponent input changes", String(s.remoteChanges)],
  ]);
}

// The relay's own info, or (when the duel is mounted on the game server) the game server's, with the duel WT path.
async function duelInfo(): Promise<any> {
  const r = await fetch("./api/duel/info", { cache: "no-store" }).catch(() => null);
  if (r?.ok) return r.json();
  const g = await fetch("/api/info", { cache: "no-store" }).catch(() => null);
  if (!g?.ok) return null;
  const info = await g.json();
  if (info.wt) info.wt = { ...info.wt, path: "/duel/wt" };
  return info;
}

async function connect(): Promise<Transport> {
  const forceWs = params.get("transport") === "ws";
  if (!forceWs && webTransportPossible()) {
    try {
      const info = await duelInfo();
      if (info?.wt) return await WtTransport.connect(info);
    } catch (e) { console.warn("duel: WebTransport failed, using WebSocket", e); }
  }
  return WsTransport.connect("/duel/ws");
}

async function main() {
  try {
    D = await loadDuel();
  } catch (e) {
    statusEl.innerHTML = `<span class="bad">${(e as Error).message}</span>`;
    return;
  }
  t0 = performance.now();
  fpsAt = t0;
  requestAnimationFrame(render);
  try {
    net = await connect();
  } catch (e) {
    statusEl.innerHTML = `<span class="bad">Relay not reachable (${(e as Error).message}). Start it: bin/duelrelay</span>`;
    return;
  }
  net.onControl = onControl;
  net.onBinary = onBinary;
  net.onClose = (r) => { statusEl.innerHTML = `<span class="bad">${r}</span>`; if (h) D.free(h); h = 0; };
  net.sendControl({ t: "join", room, name: `browser-${Math.random().toString(36).slice(2, 6)}` });
  startPump(pump);
  // Read-only hook for client/smoke/duel.mjs.
  (window as any).__duel = { stats: () => (h ? D.stats(h) : null), side: () => side, transport: () => net?.kind };
}
main();
