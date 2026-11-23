// M5/M6 presenter displays (D3): P11 shot budget, P12 cost meters, P15 budget table, P19 tick health, P29 snapshot
// inter-arrival. One mount call, after the page has set its own Session handlers:
//
//   mountPerf(session, hudRoot)
//
// It only wraps the session's public hooks (transport onBinary/onControl/sendBinary, onSnapEvent), always calling
// the previous handler, so the page's behaviour is unchanged. F3 toggles the panel; it also opens on P11, P12, P15,
// P19 and P29. Numbers are measured here or by the server; the A.11 formula column is labelled est. (A.16).
import type { Session } from "../net/session";
import { SEGMENTS, type SegKey, type ShotStamps, segments, total, rollingMean, withinTolerance, WHY, ClockSync, ArrivalHist } from "./budgetCalc";

const PRESETS = new Set(["P11", "P12", "P15", "P19", "P29"]);
const COLORS = ["#60a5fa", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#22d3ee", "#f87171"];
const TOKEN_KEY = "netlab.adminToken";

const css = `
#perf{position:fixed;z-index:20;right:12px;top:150px;width:400px;max-height:calc(100vh - 170px);overflow-y:auto;pointer-events:auto;display:none;font-size:12px}
#perf.open{display:block}#perf h3{margin:8px 0 4px;font-size:12px;color:var(--dim,#9ca3af);text-transform:uppercase;letter-spacing:.05em}
#perf h3:first-child{margin-top:0}#perf table{width:100%;border-collapse:collapse}#perf td,#perf th{padding:1px 4px;text-align:right;white-space:nowrap}
#perf td:first-child,#perf th:first-child{text-align:left;white-space:normal}#perf th{color:var(--dim,#9ca3af);font-weight:400}
#perf .bar{display:flex;height:14px;border-radius:3px;overflow:hidden;background:#111827;margin:2px 0}
#perf .bar>div{height:100%}#perf .lbl{display:flex;justify-content:space-between;color:var(--dim,#9ca3af);font-size:11px}
#perf .dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px}
#perf .ok{color:#4ade80}#perf .bad{color:#f87171}#perf .dim{color:var(--dim,#9ca3af)}#perf .why{color:#fbbf24;font-size:11px}
#perf button{font:inherit;cursor:pointer;color:inherit;background:#1f2937;border:1px solid #374151;border-radius:4px;padding:2px 8px;margin-right:4px}
#perf button.on{border-color:#60a5fa}#perf .hist{display:flex;align-items:flex-end;height:60px;gap:2px;margin:4px 0}
#perf .hist>div{flex:1;background:#60a5fa;min-height:1px}#perf .hist>div.stall{background:#f87171}
`;

const f = (v: number | null | undefined, d = 1) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : v.toFixed(d));
const tok = () => { try { return sessionStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };

export function mountPerf(s: Session, root: HTMLElement) {
  document.head.insertAdjacentHTML("beforeend", `<style>${css}</style>`);
  const panel = document.createElement("div");
  panel.id = "perf";
  panel.className = "hud box";
  root.appendChild(panel);
  // Fixed header (never re-rendered): the P19 loop switch, so a click never lands on a replaced button.
  const head = document.createElement("div");
  head.innerHTML = `<div data-p19ctl>P19 loop: <button data-loop="zeroalloc">zero-alloc</button><button data-loop="naive">allocating</button><button data-reset>reset window</button></div>`;
  const body = document.createElement("div");
  panel.append(head, body);
  let forced = false;
  addEventListener("keydown", (e) => { if (e.code === "F3") { e.preventDefault(); forced = !forced; render(); } });

  // ---- capture (all times local performance.now(), mapped to the server clock when used) ----
  const clock = new ClockSync();
  let lastSnap: { tick: number; serverMs: number } | null = null;
  let clickAt: number | null = null;
  let lastFireSeq = 0;
  const fired = new Map<number, { click: number; sent: number }>();
  const shots: ShotStamps[] = [];
  const bySeq = new Map<number, ShotStamps>();
  const seenQueue: { shooterId: number; shotSeq: number; recvServer: number; resolveMs: number; at: number }[] = [];
  let hist = new ArrivalHist(50);
  let histKey = "";
  const perTransport: Record<string, { stalls: number; gaps: number; maxGap: number; intervalMs: number }> = {};
  const byLoop: Record<string, any> = {};

  addEventListener("mousedown", (e) => { if (e.button === 0) clickAt = e.timeStamp; }, true);

  const t = s.t;
  const prevBin = t.onBinary;
  t.onBinary = (b: Uint8Array) => {
    const now = performance.now();
    try {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      if (b[0] === 2 && b.length >= 21) {
        lastSnap = { tick: dv.getUint32(9, true), serverMs: dv.getFloat64(13, true) };
        hist.add(now);
      } else if (b[0] === 5 && b.length >= 33) {
        clock.add(dv.getFloat64(9, true), dv.getFloat64(17, true), dv.getFloat64(25, true), now);
      }
    } catch { /* measurement only; the session decodes and reports bad packets itself */ }
    prevBin(b);
  };
  const prevCtl = t.onControl;
  t.onControl = (m: any) => {
    if (m?.t === "shotTrace") {
      const st = bySeq.get(m.shotSeq);
      if (st) { st.targetRecvMs = m.targetRecvServerMs; st.targetInterpMs = m.targetInterpMs; st.targetFrameMs = m.targetFrameServerMs; }
    }
    prevCtl(m);
  };
  const origSend = t.sendBinary.bind(t);
  t.sendBinary = (b: Uint8Array) => {
    if (b[0] === 1 && b.length > 10) {
      const now = performance.now();
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      let o = 10;
      for (let i = 0; i < b[9] && o + 14 <= b.length; i++) {
        const seq = dv.getUint32(o, true), buttons = dv.getUint16(o + 8, true);
        const fire = (buttons & 32) !== 0;
        if (fire && seq > lastFireSeq) {
          lastFireSeq = seq;
          if (clickAt !== null && clickAt <= now) fired.set(seq, { click: clickAt, sent: now });
          clickAt = null;
        }
        o += 14 + (fire ? 8 : 0);
      }
      for (const k of fired.keys()) if (k < lastFireSeq - 2000) fired.delete(k);
    }
    origSend(b);
  };
  const prevEv = s.onSnapEvent;
  s.onSnapEvent = (e, now) => {
    if (e.type === "shot" && lastSnap) {
      const p = fired.get(e.shotSeq);
      const click = p && clock.toServer(p.click), sent = p && clock.toServer(p.sent);
      if (p && click != null && sent != null) {
        const st: ShotStamps = { shotSeq: e.shotSeq, clickMs: click, sentMs: sent, recvMs: e.recvMs, tickStartMs: e.tickStartMs, snapSentMs: lastSnap.serverMs };
        shots.push(st); bySeq.set(e.shotSeq, st);
        if (shots.length > 200) bySeq.delete(shots.shift()!.shotSeq);
      }
    } else if (e.type === "damage" && lastSnap) {
      const recv = clock.toServer(now);
      if (recv !== null) seenQueue.push({ shooterId: e.shooterId, shotSeq: e.shotSeq, recvServer: recv,
        resolveMs: lastSnap.serverMs - (lastSnap.tick - e.resolveTick) * s.tickMs, at: now });
    }
    prevEv(e, now);
  };
  // Target half: the first frame whose render time reached the shot's tick (A.11 "target frame").
  const frame = (now: number) => {
    requestAnimationFrame(frame);
    for (let i = seenQueue.length - 1; i >= 0; i--) {
      const q = seenQueue[i];
      const r = s.renderServerMs(now), srv = clock.toServer(now);
      if (now - q.at > 3000) { seenQueue.splice(i, 1); continue; }
      if (r === null || srv === null || r < q.resolveMs) continue;
      const overshoot = r - q.resolveMs; // how long the shot had been renderable when this frame drew it
      t.sendControl({ t: "shotSeen", shooterId: q.shooterId, shotSeq: q.shotSeq, recvServerMs: q.recvServer,
        interpMs: srv - overshoot - q.recvServer, frameServerMs: srv });
      seenQueue.splice(i, 1);
    }
  };
  requestAnimationFrame(frame);

  // ---- render ----
  function budget(st: any): string {
    const est = st?.budgetEst;
    const estMs: Partial<Record<SegKey, number>> = {};
    for (const x of est?.segments ?? []) estMs[x.key as SegKey] = x.ms;
    const segs = shots.map(segments);
    const last = segs.length ? segs[segs.length - 1] : null;
    const avg = rollingMean(segs, 20);
    const rows: [string, Partial<Record<SegKey, number | null>> | null, string][] = [
      [`est. (A.11 formula)`, est ? estMs : null, est ? f(est.totalMs, 0) : "—"],
      [`last shot #${shots.length ? shots[shots.length - 1].shotSeq : "—"}`, last, last ? f(total(last), 0) : "—"],
      [`avg of last ${avg?.count ?? 0} complete`, avg?.mean ?? null, avg ? f(total(avg.mean), 0) : "—"],
    ];
    const scale = Math.max(1, ...rows.map(([, r]) => (r ? SEGMENTS.reduce((a, x) => a + Math.max(0, r[x.key] ?? 0), 0) : 0)));
    const bar = (r: Partial<Record<SegKey, number | null>> | null) =>
      `<div class="bar">${r ? SEGMENTS.map((x, i) => `<div title="${x.label}: ${f(r[x.key])} ms" style="width:${(100 * Math.max(0, r[x.key] ?? 0)) / scale}%;background:${COLORS[i]}"></div>`).join("") : ""}</div>`;
    const pending = last && total(last) === null ? `<div class="dim">Last shot: target half not in yet (only hits on another player send it back).</div>` : "";
    const p11 = `<h3>P11 shot budget, ms (server-synced clocks)</h3>${rows.map(([n, r, tot]) => `<div class="lbl"><span>${n}</span><span>${tot} ms</span></div>${bar(r)}`).join("")}
      <div>${SEGMENTS.map((x, i) => `<span class="dot" style="background:${COLORS[i]}"></span>${x.label}`).join(" · ")}</div>${pending}
      <div class="dim">${est?.note ?? "est. needs the server's stats"}</div>`;
    let p15 = `<h3>P15 budget table: formula vs measured</h3><table><tr><th>segment</th><th>est.</th><th>measured avg</th><th>diff</th></tr>`;
    for (const x of SEGMENTS) {
      const e = estMs[x.key], m = avg?.mean[x.key];
      const ok = e !== undefined && m !== undefined ? withinTolerance(e, m) : null;
      p15 += `<tr><td>${x.label}${ok === false ? `<div class="why">${WHY[x.key]}</div>` : ""}</td><td>${f(e)}</td><td>${f(m)}</td><td class="${ok === null ? "" : ok ? "ok" : "bad"}">${e !== undefined && m !== undefined ? f(m - e) : "—"}</td></tr>`;
    }
    const te = est?.totalMs, tm = avg ? total(avg.mean) : null;
    const tok15 = te !== undefined && tm !== null ? withinTolerance(te, tm, 15, 0) : null;
    p15 += `<tr><td><b>total</b></td><td>${f(te, 0)}</td><td>${f(tm, 0)}</td><td class="${tok15 === null ? "" : tok15 ? "ok" : "bad"}">${te !== undefined && tm !== null ? `${f(tm - te, 0)} (${f((100 * (tm - te)) / te, 0)}%)` : "—"}</td></tr></table>
      <div class="dim">Tolerance: total within ±15% (B.9 check 4); a segment is flagged beyond max(15%, 3 ms), with the reason it differs. n = ${avg?.count ?? 0} hits.</div>`;
    return p11 + p15;
  }

  function cost(st: any): string {
    const c = st?.cost, y = st?.youCost, budgetMs = st?.tick?.budgetMs;
    if (!c) return `<h3>P12 cost</h3><div class="dim">waiting for server stats</div>`;
    const meter = (v: number, max: number) => `<div class="bar"><div style="width:${Math.min(100, (100 * v) / max)}%;background:${v > max ? "#f87171" : "#60a5fa"}"></div></div>`;
    return `<h3>P12 cost at ${st.tickRate} Hz, ${st.sendRate} snapshots/s (measured)</h3>
      <div class="lbl"><span>server ms per tick p50 / p99 (budget ${f(budgetMs, 2)})</span><span>${f(c.tickMsP50, 3)} / ${f(c.tickMsP99, 3)}</span></div>${meter(c.tickMsP99 ?? 0, budgetMs || 1)}
      <div class="lbl"><span>total egress (${c.clients} clients)</span><span>${f(c.totalEgressKbps)} kbps</span></div>${meter(c.totalEgressKbps ?? 0, 2000)}
      <div class="lbl"><span>you: down / up</span><span>${f(y?.downKbps)} / ${f(y?.upKbps)} kbps · ${f(y?.snapshotsPerSec)} snaps/s</span></div>
      <div class="dim">${c.note ?? ""}</div>`;
  }

  function tick(st: any): string {
    const w = st?.window?.tickMs, gc = st?.window?.gc, budgetMs = st?.tick?.budgetMs, loop = s.settings?.loop ?? "?";
    if (w) byLoop[loop] = { ...w, gc, at: Date.now() };
    const ladder = w ? (["p50Ms", "p95Ms", "p99Ms", "p999Ms", "maxMs"] as const).map((k) => {
      const v = w[k];
      return `<div class="lbl"><span>${k.replace("Ms", "")}</span><span>${v === null ? `— (needs ${k === "p999Ms" ? 1000 : 100} samples)` : f(v, 3) + " ms"}</span></div>${v === null ? "" : `<div class="bar"><div style="width:${Math.min(100, (100 * v) / (budgetMs || 1))}%;background:${v > budgetMs ? "#f87171" : "#34d399"}"></div></div>`}`;
    }).join("") : `<div class="dim">waiting for server stats</div>`;
    const cmp = Object.entries(byLoop).map(([k, v]) => `<tr><td>${k}</td><td>${f(v.withinBudgetPct, 2)}%</td><td>${f(v.p99Ms, 3)}</td><td>${f(v.gc?.pauseP99Ms, 3)}</td><td>${v.gc?.cycles ?? "—"}</td><td>${v.samples}</td></tr>`).join("");
    return `<h3>P19 tick health (whole window, measured)</h3>
      <div>Active loop: <b>${loop}</b> (switch at the top of this panel)</div>
      <div>Ticks within budget (${f(budgetMs, 2)} ms): <b>${f(w?.withinBudgetPct, 2)}%</b> of ${w?.samples ?? 0} · over budget ${w?.overBudget ?? "—"}</div>
      <div class="dim">Tick duration percentiles; bar = share of the budget</div>${ladder}
      <div>GC: ${gc ? `${gc.cycles} cycles · pause p50 ${f(gc.pauseP50Ms, 3)} / p99 ${f(gc.pauseP99Ms, 3)} / max ${f(gc.pauseMaxMs, 3)} ms · heap ${f(gc.heapBytes / 1048576)} MB${gc.goMemLimitBytes ? ` · GOMEMLIMIT ${f(gc.goMemLimitBytes / 1048576, 0)} MB` : ""}` : "—"}</div>
      ${cmp ? `<table><tr><th>last seen per loop</th><th>within</th><th>p99 ms</th><th>GC p99 ms</th><th>GC cycles</th><th>ticks</th></tr>${cmp}</table>` : ""}
      <div class="dim">Switching the loop needs the admin token (Lab, F1). Reset the window after switching to compare like with like.</div>`;
  }

  function arrivals(): string {
    const sendRate = s.settings?.sendRate ?? 20, key = `${t.kind}/${sendRate}`;
    if (key !== histKey) { hist = new ArrivalHist(1000 / sendRate); histKey = key; }
    perTransport[t.kind] = { stalls: hist.stalls, gaps: hist.gaps, maxGap: hist.maxGap, intervalMs: hist.intervalMs };
    const max = Math.max(1, ...hist.counts);
    const labels = [...hist.edges.map((e) => `<${e}`), `≥${hist.edges[hist.edges.length - 1]}`];
    const bars = hist.counts.map((c, i) => `<div class="${(hist.edges[i - 1] ?? 0) >= 3 * hist.intervalMs ? "stall" : ""}" title="${labels[i]} ms: ${c}" style="height:${(100 * c) / max}%"></div>`).join("");
    return `<h3>P29 snapshot inter-arrival (this browser, measured)</h3>
      <div>${t.kind === "wt" ? "WebTransport datagrams" : "WebSocket (TCP)"} · send interval ${f(hist.intervalMs)} ms · ${hist.gaps} gaps</div>
      <div class="hist">${bars}</div><div class="lbl"><span>${labels[0]} ms</span><span>${labels[labels.length - 1]} ms</span></div>
      <div>Stalls &gt; 3× interval (${f(3 * hist.intervalMs, 0)} ms): <b class="${hist.stalls ? "bad" : "ok"}">${hist.stalls}</b> · max gap ${f(hist.maxGap, 0)} ms</div>
      <div class="dim">Red bins are stalls. Compare with <code>?transport=ws</code> at 5% loss (B.9 check 6).</div>`;
  }

  function render() {
    const preset = s.activePreset ?? "";
    const open = forced || PRESETS.has(preset);
    panel.classList.toggle("open", open);
    if (!open) return;
    const st = s.serverStats;
    const show = (id: string) => forced || preset === id || (preset === "P15" && id === "P11");
    let html = "";
    if (show("P11") || show("P15")) html += budget(st);
    if (show("P12")) html += cost(st);
    if (show("P19")) html += tick(st);
    if (show("P29")) html += arrivals();
    html += `<div class="dim">F3 toggles this panel · clock offset ${f(clock.offsetMs)} ms (from pongs)</div>`;
    if (html !== lastHtml) { body.innerHTML = html; lastHtml = html; }
    const p19 = show("P19");
    (head.firstElementChild as HTMLElement).style.display = p19 ? "" : "none";
    head.querySelectorAll<HTMLButtonElement>("[data-loop]").forEach((b) => b.classList.toggle("on", b.dataset.loop === s.settings?.loop));
  }
  let lastHtml = "";
  // One delegated handler: the panel re-renders twice a second, so buttons are replaced often.
  panel.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    if (b.dataset.loop) s.setSetting("loop", b.dataset.loop, tok());
    if (b.hasAttribute("data-reset")) t.sendControl({ t: "statsReset", token: tok() });
  });
  setInterval(render, 500);
  return { render, state: () => ({ shots: shots.map((x) => ({ ...x, seg: segments(x) })), hist: { ...hist, counts: [...hist.counts] }, clockOffsetMs: clock.offsetMs, byLoop, perTransport }) };
}
