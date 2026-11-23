import "./hud/hud.css";
import { courtyard } from "./render/map";
import { World } from "./render/scene";
import { FixedLoop, FpsMeter, type FpsCap } from "./game/loop";
import { InputCapture } from "./game/input";
import { NetGraph, type Row } from "./hud/netgraph";
import { Scorecard, Banner, el } from "./hud/widgets";
import { LabPanel, type LabBackend } from "./hud/lab";

const DEFAULT_TICK_RATE = 64; // B.4 default; the server's broadcast value replaces it once connected
const hud = document.body;

interface Probe { map: boolean; wasm: boolean; server: boolean; webTransportCapable: boolean }

async function probeFile(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { method: "HEAD" });
    // Vite dev serves index.html for unknown paths, so check the type too.
    return r.ok && !(r.headers.get("content-type") ?? "").includes("text/html");
  } catch { return false; }
}

function probeWs(): Promise<boolean> {
  return new Promise((resolve) => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try { ws = new WebSocket(`${proto}://${location.host}/ws`); } catch { resolve(false); return; }
    const t = setTimeout(() => { ws.close(); resolve(false); }, 3000);
    ws.onopen = () => { clearTimeout(t); ws.close(); resolve(true); };
    ws.onerror = () => { clearTimeout(t); resolve(false); };
  });
}

async function boot() {
  const probe: Probe = {
    map: courtyard !== null,
    wasm: await probeFile("./sim.wasm"),
    server: await probeWs(),
    webTransportCapable: window.isSecureContext && typeof (window as any).WebTransport === "function",
  };

  const canvas = el("canvas", { id: "view" });
  hud.appendChild(canvas);
  const banner = new Banner(hud);
  const scorecard = new Scorecard(hud);
  const graph = new NetGraph(hud);
  hud.appendChild(el("div", { id: "crosshair", class: "hud" }));

  // Not wired yet: the WASM sim and wire protocol are being built by core. Until then the client is honest about it.
  const backend: LabBackend = {
    connected: false, builtPresets: new Set(), settings: null, activePreset: null,
    applyPreset() {}, setSetting() {},
  };
  const lab = new LabPanel(hud, backend);

  const bannerLines: string[] = [];
  if (!probe.webTransportCapable) bannerLines.push(`<span class="warn">WebSocket fallback</span> — ${window.isSecureContext ? "this browser has no WebTransport" : "page is not a secure context (plain HTTP), so WebTransport is unavailable"}; game packets go over TCP.`);
  bannerLines.push("Offline: not connected to a game server. Spectator camera only (not the game's movement rules).");
  banner.set(bannerLines);

  const start = el("div", { id: "start" });
  const card = el("div", { class: "card box" });
  const row = (ok: boolean, name: string, note: string) => `<div class="row"><span class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</span> ${name} <span class="dim">${note}</span></div>`;
  card.innerHTML = `<h1>Netcode Lab</h1>
    ${row(probe.map, "Courtyard map", probe.map ? "shared/map.json" : "shared/map.json missing")}
    ${row(probe.wasm, "Shared sim (WASM)", probe.wasm ? "sim.wasm found" : "sim.wasm not built yet")}
    ${row(probe.server, "Game server", probe.server ? "/ws reachable; protocol not wired in this client build yet" : "/ws not reachable")}
    <p class="dim">Click to look around (pointer lock, raw mouse). WASD to fly, Space up, Shift down. F1 opens the Lab panel. Esc releases the mouse.</p>`;
  const go = el("button", {}, probe.map ? "Enter spectator view" : "Map missing");
  (go as HTMLButtonElement).disabled = !probe.map;
  card.appendChild(go);
  start.appendChild(card);
  hud.appendChild(start);
  if (!courtyard) return;

  const world = new World(canvas, courtyard);
  const input = new InputCapture(canvas);
  const fps = new FpsMeter();
  let lastFrameMs = 0;
  // Spectator camera state: starts above the Blue spawn looking at the gap.
  const cam = { x: 0, y: 6, z: 30 };
  input.pitch = -0.2;

  go.addEventListener("click", () => input.lock());
  canvas.addEventListener("click", () => { if (!input.locked) input.lock(); });
  input.onLockChange = (locked) => { start.style.display = locked || lab.open ? "none" : "flex"; };
  input.onFirePress = () => world.rifle.fire(performance.now());
  lab.onToggle = (open) => {
    if (open && input.locked) document.exitPointerLock();
    start.style.display = open || input.locked ? "none" : "flex";
  };
  const keys = new Set<string>();
  addEventListener("keydown", (e) => { if (input.locked) keys.add(e.code); });
  addEventListener("keyup", (e) => keys.delete(e.code));

  const loop = new FixedLoop(DEFAULT_TICK_RATE, {
    onTick() {
      const i = input.sample();
      const step = 12 / DEFAULT_TICK_RATE;
      const fx = -Math.sin(i.yaw), fz = -Math.cos(i.yaw);
      const mx = (i.forward ? 1 : 0) - (i.back ? 1 : 0), sx = (i.right ? 1 : 0) - (i.left ? 1 : 0);
      cam.x += (fx * mx - fz * sx) * step;
      cam.z += (fz * mx + fx * sx) * step;
      cam.y += ((i.jump ? 1 : 0) - (keys.has("ShiftLeft") ? 1 : 0)) * step;
    },
    onRender(_alpha, frameMs) {
      const now = performance.now();
      fps.push(now);
      lastFrameMs = frameMs;
      world.setView(cam.x, cam.y, cam.z, input.yaw, input.pitch);
      world.rifle.update(now, frameMs);
      world.render();
    },
  });
  lab.local = {
    get fpsCap() { return loop.fpsCap; },
    setFpsCap(v: number) { loop.fpsCap = v as FpsCap; },
  };
  loop.start();

  const tickHz = (DEFAULT_TICK_RATE).toString();
  setInterval(() => {
    const rows: Row[] = [
      { key: "rtt", label: "RTT", value: null, unit: "ms", source: "measured" },
      { key: "jitter", label: "jitter", value: null, unit: "ms", source: "measured" },
      { key: "loss", label: "loss", value: null, unit: "%", source: "measured" },
      { key: "tick", label: "client tick", value: `${loop.currentTick} @ ${tickHz} Hz`, source: "measured" },
      { key: "snap", label: "snapshots", value: null, unit: "/s", source: "measured" },
      { key: "interp", label: "interp buffer", value: null, unit: "ms", source: "setting" },
      { key: "pending", label: "pending inputs", value: null, source: "measured" },
      { key: "corr", label: "corrections", value: null, source: "measured" },
      { key: "svtick", label: "server tick", value: null, unit: "ms", source: "server" },
      { key: "fps", label: "FPS", value: `${fps.fps} (${lastFrameMs.toFixed(1)} ms)`, source: "measured" },
      { key: "kbps", label: "kbps up/down", value: null, source: "measured" },
    ];
    graph.render(rows);
    scorecard.render(null);
  }, 250);
}

boot();
