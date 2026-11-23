// M7 infrastructure page (A.12, P16–P18, P20): ping each region's beacon 10× and take the median, open a
// matchmaking ticket with that RTT map and watch the threshold relax, switch the simulated cable cut, compare
// relayed routes. Route settings are simulated (A.16); the RTTs on this page are measured by this browser over them.
import { WsTransport, WtTransport, webTransportPossible, type Transport } from "../net/transport";

const css = `
:root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--text:#e6e8ee;--dim:#8a91a0;--blue:#2563EB;--orange:#EA580C;--bad:#ef4444;--ok:#22c55e;--warn:#f59e0b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
main{max-width:1100px;margin:0 auto;padding:12px;display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
h1{font-size:16px;margin:0 0 4px;grid-column:1/-1}h2{font-size:12px;margin:0 0 6px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:10px;min-width:0}
button,select,input{background:#222733;color:var(--text);border:1px solid var(--line);border-radius:4px;padding:4px 8px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--dim)}.row{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:4px 0}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{padding:2px 4px;text-align:right;border-bottom:1px solid var(--line)}th:first-child,td:first-child{text-align:left}
.dim{color:var(--dim)}.bad{color:var(--bad)}.ok{color:var(--ok)}.warn{color:var(--warn)}.tag{font-size:11px;border:1px solid var(--warn);color:var(--warn);border-radius:3px;padding:0 4px}
ol{margin:4px 0;padding-left:18px}a{color:#7aa2ff}
`;
document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
document.body.innerHTML = `<main>
<h1>Regions, beacons and matchmaking <span class="tag">routes simulated</span></h1>
<section><h2>Me (P16)</h2>
  <div class="row">ISP <select id="isp"><option>viettel</option><option>vnpt</option><option>fpt</option></select>
  Last mile <select id="lm"><option>good</option><option>wifi</option><option>bad</option></select></div>
  <div class="row">Route <select id="route"><option value="direct">direct</option><option value="relay-public">relay: public</option><option value="relay-backbone">relay: backbone</option></select>
  <span class="dim">(P18)</span></div>
  <div class="row"><button id="ping">Ping beacons (10× each)</button><label><input type="checkbox" id="keep"> keep pinging</label><span id="pingStatus" class="dim"></span></div>
  <table id="rtt"></table>
  <div class="dim" id="tr"></div>
</section>
<section><h2>Matchmaking (P17)</h2>
  <div class="row"><button id="mm">Find match with this RTT map</button></div>
  <div id="ticket" class="dim">No ticket yet. Ping first.</div>
</section>
<section><h2>Cable cut (P16)</h2>
  <div class="row"><input id="tok" placeholder="admin token" size="14"><button id="cut">Cut cables to sg</button><button id="heal">Repair</button></div>
  <div id="cutState" class="dim"></div>
  <div class="dim">The cut adds delay, jitter and loss to routes to sg only (simulated). Ping again to see it; the alert "p95 of one ISP &gt; 150 ms for 1 min" fires in Prometheus/Grafana (deploy/).</div>
</section>
<section style="grid-column:1/-1"><h2>Budget by route (P18) <span class="tag">est.</span></h2>
  <div class="dim">A.11 shot budget for a player and a target on the measured route to the best region: uplink + downlink = this browser's
  median RTT, plus the late-packet allowance (p95 − median, which the interpolation buffer must absorb), plus fixed A.11 values
  (64 Hz, 20 snapshots/s, 100 ms buffer, 60 FPS). Route settings are simulated; the RTTs are measured here. Ping once per route to compare.</div>
  <div id="budget"></div></section>
<section style="grid-column:1/-1"><h2>Ping history <span class="tag">routes simulated</span></h2><table id="hist"></table></section>
<section style="grid-column:1/-1"><h2>Route table <span class="tag">simulated</span></h2><table id="routes"></table>
  <div class="dim">Game rooms: <code>/r/{region}/ws</code> · beacons: <code>/beacon/{region}/ws|wt</code> · <a href="./duel.html">duel mini-mode</a> · <a href="/metrics">/metrics</a></div></section>
</main>`;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const sel = (id: string) => $<HTMLSelectElement>(id).value;
const REGIONS = ["hcm", "hn", "sg"];
let rttMap: Record<string, number> = {};
let info: any = null;

const median = (a: number[]) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = (v: number, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : "—");

async function open(region: string): Promise<Transport> {
  const q = `?isp=${sel("isp")}&lm=${sel("lm")}&route=${sel("route")}&platform=browser`;
  if (webTransportPossible() && info?.wt) {
    try { return await WtTransport.connect({ ...info, wt: { ...info.wt, path: `/beacon/${region}/wt${q}` } }); } catch (e) { console.warn("beacon: WebTransport failed, using WebSocket", e); }
  }
  return WsTransport.connect(`/beacon/${region}/ws${q}`);
}

async function pingRegion(region: string) {
  const t = await open(region);
  t.sendControl({ t: "hello" }); // a WebTransport control stream exists for the server only once written
  const sent = new Map<number, number>(), rtts: number[] = [];
  t.onBinary = (b) => { const s = new DataView(b.buffer, b.byteOffset).getUint32(0, true); const at = sent.get(s); if (at !== undefined) { rtts.push(performance.now() - at); sent.delete(s); } };
  const base = (Math.random() * 2 ** 31) | 0;
  for (let i = 0; i < 10; i++) {
    const b = new Uint8Array(12); new DataView(b.buffer).setUint32(0, base + i, true);
    sent.set(base + i, performance.now()); t.sendBinary(b);
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 1000));
  t.close();
  fetch("./api/infra/report", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region, isp: sel("isp"), platform: "browser", rtts, sent: 10, lost: 10 - rtts.length }) });
  return { rtts, lost: 10 - rtts.length, kind: t.kind };
}

interface Round { id: number; at: string; route: string; cut: boolean; isp: string; lm: string; region: string; median: number; p95: number; jitter: number; lost: number; kind: string }
const history: Round[] = [];
let roundNo = 0;
const pct = (a: number[], p: number) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]; };
const jit = (a: number[]) => (a.length < 2 ? NaN : a.slice(1).reduce((x, v, i) => x + Math.abs(v - a[i]), 0) / (a.length - 1));

async function round() {
  $("pingStatus").textContent = "pinging…";
  const cut = (await (await fetch("./api/regions", { cache: "no-store" })).json()).cableCut as boolean;
  const rows: string[] = [];
  let kind = "";
  const id = ++roundNo;
  for (const rg of REGIONS) {
    try {
      const r = await pingRegion(rg);
      kind = r.kind;
      rttMap[rg] = median(r.rtts);
      const s = [...r.rtts].sort((a, b) => a - b);
      history.push({ id, at: new Date().toLocaleTimeString(), route: sel("route"), cut, isp: sel("isp"), lm: sel("lm"), region: rg, median: rttMap[rg], p95: pct(r.rtts, 95), jitter: jit(r.rtts), lost: r.lost, kind });
      rows.push(`<tr><td>${rg}</td><td><b>${f(rttMap[rg])}</b></td><td>${f(s[0])}</td><td>${f(s[s.length - 1])}</td><td>${f(jit(r.rtts))}</td><td>${r.lost}/10</td></tr>`);
    } catch (e) { rows.push(`<tr><td>${rg}</td><td colspan="5" class="bad">${(e as Error).message}</td></tr>`); }
  }
  if (history.length > 300) history.splice(0, history.length - 300);
  $("rtt").innerHTML = `<tr><th>region</th><th>median ms</th><th>min</th><th>max</th><th>jitter</th><th>lost</th></tr>` + rows.join("");
  $("pingStatus").textContent = `measured by this browser over ${kind === "wt" ? "WebTransport datagrams" : "WebSocket (TCP: loss shows as delay)"} · cable cut ${cut ? "ON" : "off"} (simulated)`;
  drawHistory(); drawBudget();
}

function drawHistory() {
  const last = history.slice(-30).reverse();
  $("hist").innerHTML = `<tr><th>time</th><th>route</th><th>cable cut</th><th>ISP · last mile</th><th>region</th><th>median</th><th>p95</th><th>jitter</th><th>lost</th><th>via</th></tr>` +
    last.map((h) => `<tr><td>${h.at}</td><td>${h.route}</td><td class="${h.cut ? "bad" : ""}">${h.cut ? "ON" : "off"}</td><td>${h.isp} · ${h.lm}</td><td>${h.region}</td><td>${f(h.median)}</td><td>${f(h.p95)}</td><td>${f(h.jitter)}</td><td>${h.lost}/10</td><td>${h.kind}</td></tr>`).join("");
}

// A.11 fixed parts at the defaults (est.): half a frame at 60 FPS each side, half a 64 Hz tick, half a 20/s send interval, 100 ms buffer.
const FIXED = { shooterFrame: 1000 / 60 / 2, tickWait: 1000 / 64 / 2, snapshotWait: 1000 / 20 / 2, interp: 100, targetFrame: 1000 / 60 / 2 };
const PARTS = [["shooterFrame", "shooter frame", "#60a5fa"], ["uplink", "uplink (½ RTT)", "#a78bfa"], ["tickWait", "tick wait", "#f472b6"], ["snapshotWait", "snapshot wait", "#fbbf24"],
  ["downlink", "downlink (½ RTT)", "#34d399"], ["late", "late-packet allowance (p95 − median)", "#f87171"], ["interp", "interpolation buffer", "#22d3ee"], ["targetFrame", "target frame", "#94a3b8"]] as const;

function drawBudget() {
  // Latest round per (route, cable cut, ISP, last mile); the best region of that round.
  const latestId = new Map<string, number>();
  for (const h of history) latestId.set(`${h.route}|${h.cut}|${h.isp}|${h.lm}`, h.id);
  const latest = new Map<string, Round[]>();
  for (const [k, id] of latestId) latest.set(k, history.filter((h) => h.id === id));
  const bars = [...latest.values()].map((g) => {
    const best = g.filter((x) => Number.isFinite(x.median)).sort((a, b) => a.median - b.median)[0];
    if (!best) return null;
    const v: Record<string, number> = { ...FIXED, uplink: best.median / 2, downlink: best.median / 2, late: Math.max(0, best.p95 - best.median) };
    return { best, v, total: PARTS.reduce((a, [k]) => a + v[k], 0) };
  }).filter((x) => x !== null) as { best: Round; v: Record<string, number>; total: number }[];
  if (!bars.length) { $("budget").innerHTML = `<div class="dim">Ping first.</div>`; return; }
  const scale = Math.max(...bars.map((b) => b.total));
  $("budget").innerHTML = bars.map(({ best, v, total }) => `<div class="row" style="justify-content:space-between"><span>${best.route} · cable cut ${best.cut ? "<b class=bad>ON</b>" : "off"} · ${best.isp} · ${best.lm} → ${best.region} (median ${f(best.median)}, p95 ${f(best.p95)}, jitter ${f(best.jitter)} ms, lost ${best.lost}/10)</span><b>${f(total, 0)} ms est.</b></div>
    <div style="display:flex;height:14px;border-radius:3px;overflow:hidden;background:#111827">${PARTS.map(([k, label, c]) => `<div title="${label}: ${f(v[k])} ms" style="width:${(100 * v[k]) / scale}%;background:${c}"></div>`).join("")}</div>`).join("") +
    `<div class="dim" style="margin-top:4px">${PARTS.map(([, label, c]) => `<span style="display:inline-block;width:8px;height:8px;background:${c};margin:0 3px 0 8px"></span>${label}`).join("")}</div>`;
}

let keepTimer = 0;
$("ping").addEventListener("click", () => round());
$("keep").addEventListener("change", async (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (!on) { clearTimeout(keepTimer); return; }
  // Keep beacon traffic flowing (P20): Prometheus rates need samples in every 1-minute window, or series go stale.
  const loop = async () => { if (!$<HTMLInputElement>("keep").checked) return; await round().catch(() => {}); keepTimer = window.setTimeout(loop, 1000); };
  loop();
});

$("mm").addEventListener("click", async () => {
  if (!Object.keys(rttMap).length) { $("ticket").textContent = "Ping first: the ticket carries the RTT map."; return; }
  const r = await fetch("./api/mm/ticket", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ player: "browser", isp: sel("isp"), lm: sel("lm"), route: sel("route"), platform: "browser", rtt: rttMap }) });
  let st = await r.json();
  const show = () => {
    $("ticket").className = "";
    $("ticket").innerHTML = `<div>Ticket <b>${st.id}</b> · <span class="${st.state === "matched" ? "ok" : st.state === "failed" ? "bad" : "warn"}">${st.state}</span> · waited ${st.waitedS} s</div>
      <div>RTT map: ${Object.entries(st.rtt).map(([k, v]) => `${k} ${f(v as number)} ms`).join(" · ")}</div>
      <div>Threshold now <b>${st.maxMs} ms</b>${st.nextStep ? `, relaxes to ${st.nextStep.maxMs} ms at ${st.nextStep.afterS} s` : ""} · eligible: ${st.eligible?.join(", ") || "none"}</div>
      ${st.region ? `<div>Chosen region <b>${st.region}</b> (${f(st.regionRttMs)} ms) · game room <code>${st.gamePath}/ws</code></div>` : ""}
      <ol>${st.events.map((e: any) => `<li>${e.atS} s: ${e.text}</li>`).join("")}</ol>`;
  };
  show();
  while (st.state === "searching") {
    await new Promise((r) => setTimeout(r, 500));
    st = await (await fetch(`./api/mm/ticket/${st.id}`)).json();
    show();
  }
});

async function setCut(on: boolean) {
  const r = await fetch("./api/regions/cut", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ on, token: $<HTMLInputElement>("tok").value }) });
  $("cutState").innerHTML = r.ok ? `Cable cut: <b class="${on ? "bad" : "ok"}">${on ? "ON" : "off"}</b> (simulated)` : `<span class="bad">${(await r.json()).error}</span>`;
  loadRoutes();
}
$("cut").addEventListener("click", () => setCut(true));
$("heal").addEventListener("click", () => setCut(false));

async function loadRoutes() {
  const t = await (await fetch("./api/regions", { cache: "no-store" })).json();
  const head = `<tr><th>RTT / jitter / loss (simulated)</th>${t.routes.map((r: string) => `<th>${r}</th>`).join("")}</tr>`;
  const rows = t.regions.flatMap((rg: string) => t.isps.map((isp: string) => `<tr><td>${rg} · ${isp}</td>${t.routes.map((ro: string) => { const x = t.table[rg][isp][ro]; return `<td>${x.rttMs} / ${x.jitterMs} / ${x.lossPct}%</td>`; }).join("")}</tr>`));
  $("routes").innerHTML = head + rows.join("");
  $("tr").textContent = `Last mile adds (simulated): wifi ${JSON.stringify(t.lastMile.wifi)}, bad ${JSON.stringify(t.lastMile.bad)}`;
  if (!$("cutState").innerHTML) $("cutState").innerHTML = `Cable cut: <b class="${t.cableCut ? "bad" : "ok"}">${t.cableCut ? "ON" : "off"}</b> (simulated)`;
}

info = await fetch("./api/infra/info", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
loadRoutes();
