// P26 (sub-tick timing error), P27 (compression meters) and P28 (interest management), from data the server already
// sends (1 Hz stats) and this client's own shot events. Every number is measured here or by the server; nothing is
// estimated. F4 toggles the panel; it also opens on P26, P27 and P28.
import type { Session } from "../net/session";
import type { ShotEvent } from "../game/events";

const PRESETS = new Set(["P26", "P27", "P28"]);
const BIN_MS = 2;
const BINS = 9; // 0–2 … 16+ ms
const TOKEN_KEY = "netlab.adminToken";
const tok = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };
const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
const kbps = (bps: number | undefined) => (bps === undefined ? null : (bps * 8) / 1000);

interface Meter { raw: number | null; quant: number | null; bitpack: number | null; delta: number | null; ents: number | null; others: number; at: number }

export function mountWire(s: Session, root: HTMLElement) {
  const panel = document.createElement("div");
  panel.id = "wire";
  panel.className = "hud box";
  root.appendChild(panel);
  // Fixed header with the switches (never re-rendered, so a click cannot land on a replaced button).
  const head = document.createElement("div");
  head.className = "wirehead";
  head.innerHTML = `<b>Wire &amp; timing</b> <span class="dim">(F4)</span>
    <div class="sw"><span>P26</span><button data-k="subtick">sub-tick</button>
    <span>P27</span><button data-k="compQuant">quantise</button><button data-k="compBitpack">bit-pack</button><button data-k="compDelta">delta</button>
    <span>P28</span><button data-k="interest">interest</button></div>`;
  const body = document.createElement("div");
  panel.append(head, body);
  head.addEventListener("click", (e) => {
    const k = (e.target as HTMLElement).dataset?.k;
    if (!k || !s.settings) return;
    s.setSetting(k, !s.settings[k], tok());
  });
  let forced = false;
  addEventListener("keydown", (e) => { if (e.code === "F4") { e.preventDefault(); forced = !forced; render(); } });

  // P26: this client's own shots, timing error as the server measured it, split by the sub-tick setting.
  const hist = { on: new Array(BINS).fill(0), off: new Array(BINS).fill(0) };
  let ownShots = { on: 0, off: 0 };
  const prev = s.onSnapEvent;
  s.onSnapEvent = (e, now) => {
    prev(e, now);
    if (e.type !== "shot") return;
    const sh = e as ShotEvent;
    if (typeof sh.timingErrMs !== "number" || sh.trust) return;
    const k = s.settings?.subtick ? "on" : "off";
    hist[k][Math.min(BINS - 1, Math.floor(sh.timingErrMs / BIN_MS))]++;
    ownShots[k]++;
    render();
  };

  // P27/P28: keep the last meter reading per scene state, so "at rest vs moving" and "interest on vs off" can be compared.
  const byMotion: { rest: Meter | null; moving: Meter | null } = { rest: null, moving: null };
  const byInterest: { off: Meter | null; on: Meter | null } = { off: null, on: null };
  let last: Meter | null = null;

  function onStats() {
    const st = s.serverStats;
    const eb = st?.you?.entityBytes;
    if (!st || !eb) return;
    const latest = s.interp.latest();
    const ents = latest ? [...latest.entities.values()] : [];
    const moving = ents.some((x: any) => x.moving);
    const m: Meter = { raw: kbps(eb.rawBps), quant: kbps(eb.quantBps), bitpack: kbps(eb.quantBitpackBps), delta: kbps(eb.deltaBps), ents: st.you.entitiesPerSnapshot ?? null, others: Math.max(0, (st.players ?? 1) - 1), at: performance.now() };
    last = m;
    if (ents.length) byMotion[moving ? "moving" : "rest"] = m;
    byInterest[s.settings?.interest ? "on" : "off"] = m;
    render();
  }
  let seenStats: unknown = null;
  setInterval(() => { if (s.serverStats !== seenStats) { seenStats = s.serverStats; onStats(); } }, 250);

  function histRow(label: string, h: number[], n: number) {
    const max = Math.max(1, ...h);
    return `<div class="lbl"><span>${label}</span><span>${n} shots</span></div><div class="hist">${h.map((c, i) =>
      `<div title="${i * BIN_MS}${i === BINS - 1 ? "+" : `–${(i + 1) * BIN_MS}`} ms: ${c}" style="height:${(100 * c) / max}%"></div>`).join("")}</div>`;
  }
  function meterRow(label: string, m: Meter | null) {
    if (!m) return `<tr><td>${label}</td><td colspan="4" class="dim">not seen yet</td></tr>`;
    return `<tr><td>${label}</td><td>${f(m.raw)}</td><td>${f(m.quant)}</td><td>${f(m.bitpack)}</td><td>${f(m.delta)}</td></tr>`;
  }

  function render() {
    const open = forced || PRESETS.has(s.activePreset ?? "");
    panel.classList.toggle("open", open);
    const st = s.settings;
    for (const b of head.querySelectorAll<HTMLButtonElement>("button[data-k]")) {
      const on = !!st?.[b.dataset.k!];
      b.classList.toggle("on", on);
      b.textContent = `${b.dataset.k === "subtick" ? "sub-tick" : b.dataset.k === "interest" ? "interest" : b.dataset.k!.replace("comp", "").toLowerCase()} ${on ? "on" : "off"}`;
      b.disabled = !tok();
    }
    if (!open) return;
    // Stop above the net graph (bottom-left) so neither covers the other.
    const ng = document.getElementById("netgraph")?.getBoundingClientRect();
    if (ng) panel.style.maxHeight = `${Math.max(140, ng.top - panel.getBoundingClientRect().top - 8)}px`;
    const w = s.serverStats?.window?.shotTimingErrMs;
    const srv = (x: any) => x && x.samples ? `${x.samples} shots · p50 ${f(x.p50Ms)} · p95 ${f(x.p95Ms)} · max ${f(x.maxMs)} ms · ${f(x.withinBudgetPct, 0)}% within one tick` : "no shots yet";
    const tickMs = 1000 / (st?.tickRate ?? 64);
    body.innerHTML = `
      <h3>P26 sub-tick: shot timing error</h3>
      <div class="dim">|time the server used for the shot − click time|, measured by the server. ${BIN_MS} ms bins; one tick = ${tickMs.toFixed(1)} ms at ${st?.tickRate ?? "—"} Hz.</div>
      ${histRow("your shots, sub-tick on", hist.on, ownShots.on)}
      ${histRow("your shots, quantised to the tick", hist.off, ownShots.off)}
      <div class="dim">All players since the last stats reset — on: ${srv(w?.subtickOn)}; quantised: ${srv(w?.quantised)}.</div>
      <div class="why">Sub-tick removes this timing error only. It does not make the server simulate or send at 128 Hz.</div>
      <h3>P27 compression: entity section, kbps</h3>
      <div class="dim">What this client's entity list costs in each encoding, measured by the server every snapshot, whatever encoding is on.</div>
      <table><tr><th></th><th>raw</th><th>quant</th><th>+bitpack</th><th>+delta</th></tr>
        ${meterRow("now", last)}${meterRow("last at rest", byMotion.rest)}${meterRow("last while moving", byMotion.moving)}</table>
      <div class="dim">"Moving" = some player had the moving flag in the newest snapshot. Delta needs an acked snapshot; at rest it sends almost nothing.</div>
      <h3>P28 interest management</h3>
      <table><tr><th></th><th>entities / snapshot</th><th>other players</th><th>entity kbps (sent)</th></tr>
        ${(["off", "on"] as const).map((k) => { const m = byInterest[k]; return `<tr><td>interest ${k}${(st?.interest ? "on" : "off") === k ? " (now)" : ""}</td><td>${m ? f(m.ents, 0) : "—"}</td><td>${m ? m.others : "—"}</td><td>${m ? f(sentKbps(m)) : "—"}</td></tr>`; }).join("")}</table>
      <div class="dim">Grid cell ${st?.interestCellM ?? "—"} m, 3×3 cells around you. With few players everyone is near; the effect shows with many bots spread over the map.</div>`;
  }
  function sentKbps(m: Meter) {
    const st = s.settings;
    if (!st) return null;
    if (st.compDelta) return m.delta;
    if (st.compBitpack) return m.bitpack;
    if (st.compQuant) return m.quant;
    return m.raw;
  }
  const prevChange = s.onChange;
  s.onChange = () => { prevChange(); render(); };
  render();
  return { render };
}
