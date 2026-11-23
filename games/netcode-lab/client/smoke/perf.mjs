// D3 check: the P11/P12/P15/P19/P29 panel (hud/perf.ts) against a real server, with real hits between two browsers.
// Needs the page to expose window.__perf = mountPerf(session, hud) (main.ts) and an admin token.
// Usage: NETLAB_ADMIN_TOKEN=x node smoke/perf.mjs http://127.0.0.1:<port> [shots]
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function cachedChromium() {
  const root = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1])))
    for (const p of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome"])
      if (existsSync(join(root, d, p))) return join(root, d, p);
  return null;
}
const executablePath = process.env.PW_CHROMIUM || (existsSync(chromium.executablePath()) ? chromium.executablePath() : cachedChromium());
const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const SHOTS = Number(process.argv[3] ?? 12);
const TOKEN = process.env.NETLAB_ADMIN_TOKEN ?? "";
const errors = [];
let fail = 0;
const check = (ok, msg, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}${detail ? " · " + detail : ""}`); if (!ok) fail++; };

async function open(browser, name, admin) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 760 } });
  p.on("console", (m) => { if (m.type() === "error") errors.push(`[${name}] ${m.text()}`); });
  p.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  await p.goto(`${BASE}/?name=${name}${admin ? `&admin=${TOKEN}` : ""}`);
  await p.waitForFunction(() => window.__netlab?.session?.ready && window.__perf, null, { timeout: 20000 });
  await p.click("#start button");
  return p;
}
const b1 = await chromium.launch({ executablePath, headless: true, args: ["--use-gl=angle"] });
const b2 = await chromium.launch({ executablePath, headless: true, args: ["--use-gl=angle"] });
const A = await open(b1, "perf-shooter", true);
const T = await open(b2, "perf-target", false);
const who = (p) => p.evaluate(() => { const s = window.__netlab.session; return { id: s.id, team: s.team, dead: s.dead, ...s.ownView(performance.now()) }; });
let a = await who(A), t = await who(T);
check(a.team !== t.team, "shooter and target on different teams", `${a.team} vs ${t.team}`);

await A.keyboard.press("F3");
check(await A.locator("#perf.open").isVisible(), "F3 opens the panel");

const goX = async (p, x) => {
  for (let i = 0; i < 40; i++) {
    const v = await who(p); const dx = x - v.x; if (Math.abs(dx) < 0.3) return;
    const key = (v.team === "blue") === (dx > 0) ? "KeyD" : "KeyA";
    await p.keyboard.down(key); await p.waitForTimeout(Math.min(250, Math.abs(dx) * 60)); await p.keyboard.up(key); await p.waitForTimeout(150);
  }
};
await A.evaluate(() => { window.__netlab.input.yaw = 0; window.__netlab.input.pitch = 0; });
await T.evaluate(() => { window.__netlab.input.yaw = Math.PI; window.__netlab.input.pitch = 0; });
await goX(A, 5.5); await goX(T, 5.5);
const aim = () => A.evaluate((tid) => {
  const n = window.__netlab, e = n.drawn().get(tid), m = n.session.ownView(performance.now());
  if (!e || !m) return;
  const dx = e.x - m.x, dz = e.z - m.z; n.input.yaw = Math.atan2(-dx, -dz); n.input.pitch = Math.atan2(((e.y ?? 0) + 1.0) - (m.y + 1.6), Math.hypot(dx, dz));
}, t.id);
for (let i = 0; i < SHOTS; i++) {
  if ((await who(T)).dead) { await T.waitForTimeout(3600); await goX(T, 5.5); }
  await A.mouse.move(640, 380); await aim(); await A.mouse.down(); await aim(); await A.waitForTimeout(30); await A.mouse.up();
  await A.waitForTimeout(450);
}
await A.waitForTimeout(1500);
const st = await A.evaluate(() => window.__perf.state());
const done = st.shots.filter((s) => Object.values(s.seg).every((v) => v !== null));
check(st.shots.length >= SHOTS / 2, "P11: shots traced on the shooter (click → server → snapshot)", `${st.shots.length} traced of ${SHOTS} clicks`);
check(done.length >= 3, "P11: complete traces with the target half (shotSeen → shotTrace)", `${done.length} complete`);
const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
const avg = {};
for (const k of Object.keys(done[0]?.seg ?? {})) avg[k] = done.reduce((x, s) => x + s.seg[k], 0) / Math.max(1, done.length);
const neg = done.flatMap((s) => Object.entries(s.seg).filter(([, v]) => v < -2).map(([k, v]) => `${k} ${v.toFixed(1)}`));
check(neg.length === 0, "P11: no segment below −2 ms (clock-sync error bound)", neg.join(", "));
const fps = async (p) => p.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(f); else r(n / 2); }; requestAnimationFrame(f); }));
console.log(`measured rAF rate: shooter ${await fps(A)} /s, target ${await fps(T)} /s (headless, software WebGL)`);
const panel = await A.textContent("#perf");
const est = await A.evaluate(() => window.__netlab.session.serverStats?.budgetEst);
console.log(`avg of ${done.length} complete (ms): ${Object.entries(avg).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")} · total ${sum(avg).toFixed(1)}`);
console.log(`est. (ms): ${est?.segments.map((x) => `${x.key} ${x.ms.toFixed(1)}`).join(", ")} · total ${est?.totalMs.toFixed(1)}`);
check(/P15 budget table/.test(panel) && /est\./.test(panel), "P15: formula vs measured table shown, formula labelled est.");
check(/P12 cost at \d+ Hz/.test(panel) && /kbps/.test(panel), "P12: cost meters show measured kbps and ms per tick");
check(/Ticks within budget/.test(panel) && /GC: \d+ cycles/.test(panel), "P19: % within budget and GC pauses shown");
check(/P29 snapshot inter-arrival/.test(panel) && st.hist.gaps > 50, "P29: inter-arrival histogram fed by snapshots", `${st.hist.gaps} gaps, ${st.hist.stalls} stalls > 3× interval, max ${st.hist.maxGap.toFixed(0)} ms`);

// P19 loop switch through the panel, from a presenter page that is not playing (while playing, the game owns the mouse).
const C = await b2.newPage({ viewport: { width: 1280, height: 760 } });
C.on("pageerror", (e) => errors.push(`[presenter] ${e.message}`));
await C.goto(`${BASE}/?name=perf-presenter&spectate=1&admin=${TOKEN}`);
await C.waitForFunction(() => window.__netlab?.session?.ready && window.__perf, null, { timeout: 20000 });
await C.keyboard.press("F3");
const setLoop = async (v) => { await C.click(`#perf [data-loop="${v}"]`); return C.waitForFunction((v) => window.__netlab.session.settings?.loop === v, v, { timeout: 3000 }).then(() => true, () => false); };
const naive = await setLoop("naive");
await C.waitForTimeout(2500); // two 1 Hz stats under the allocating loop
const zero = await setLoop("zeroalloc");
await C.waitForTimeout(1500);
check(naive && zero, "P19: loop switch naive ↔ zero-alloc from the panel (admin)");
const loops = await C.evaluate(() => Object.keys(window.__perf.state().byLoop));
console.log(`P19 numbers kept per loop: ${loops.join(", ")}`);

check(errors.length === 0, "no console errors", errors.join(" | "));
await b1.close(); await b2.close();
process.exit(fail ? 1 : 0);
