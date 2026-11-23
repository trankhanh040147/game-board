// core's check of the Lab's page presets: /duel.html?preset= and /infra.html?preset= put the page in the preset's state.
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const root = join(homedir(), "Library/Caches/ms-playwright");
let exe = null;
for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse()) {
  const p = join(root, d, "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing");
  if (existsSync(p)) { exe = p; break; }
}
const BASE = process.argv[2], TOKEN = process.env.NETLAB_ADMIN_TOKEN;
const b = await chromium.launch({ executablePath: exe, headless: true });
const errors = [];
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) fail++; };
async function page(url, tag) {
  const p = await b.newPage();
  p.on("console", (m) => { if (m.type() === "error") errors.push(`[${tag}] ${m.text()}`); });
  p.on("pageerror", (e) => errors.push(`[${tag}] ${e}`));
  await p.goto(url);
  return p;
}
const want = { P21: { mode: "0", delay: "0" }, P22: { mode: "0", delay: "-1" }, P23: { mode: "1", delay: "-1" } };
for (const id of ["P21", "P22", "P23"]) {
  const room = `core-${id}-${Date.now() % 100000}`;
  const a = await page(`${BASE}/duel.html?room=${room}&preset=${id}`, id + "a");
  const c = await page(`${BASE}/duel.html?room=${room}&preset=${id}`, id + "b");
  // the preset may restart the match once with its mode/delay; give it time
  await a.waitForFunction(() => (window.__duel?.stats()?.frame ?? 0) > 120, null, { timeout: 25000 }).catch(() => {});
  await a.waitForTimeout(3000);
  const st = await a.evaluate(() => ({ mode: document.querySelector("#mode, select[name=mode]")?.value, delay: document.querySelector("#delay, select[name=delay]")?.value, banner: document.getElementById("banner")?.innerText ?? "", stats: window.__duel?.stats() }));
  const w = want[id];
  check(st.banner.startsWith(id), `${id}: banner names the preset · "${st.banner.split("\n")[0].slice(0, 70)}"`);
  check(st.mode === w.mode && st.delay === w.delay, `${id}: mode ${st.mode} (want ${w.mode}), delay ${st.delay} (want ${w.delay}; -1 = auto by ping)`);
  check((st.stats?.frame ?? 0) > 60, `${id}: match running · frame ${st.stats?.frame}`);
  await a.close(); await c.close();
}
const iw = { P16: { route: "direct", region: "sg" }, P17: { route: "direct", region: "best" }, P18: { route: "relay-backbone", region: "sg" } };
for (const id of ["P16", "P17", "P18"]) {
  const p = await page(`${BASE}/infra.html?preset=${id}&admin=${TOKEN}`, id);
  await p.waitForFunction((id) => (document.getElementById("pbanner")?.innerText ?? "").includes(id), id, { timeout: 15000 }).catch(() => {});
  await p.waitForTimeout(id === "P18" ? 8000 : 1500);
  const st = await p.evaluate(() => ({ banner: document.getElementById("pbanner")?.innerText ?? "", route: document.getElementById("route")?.value, region: document.getElementById("bregion")?.value }));
  check(st.banner.includes(id) && /simulated/.test(st.banner), `${id}: banner names the preset and says simulated · "${st.banner.split("\n")[0].slice(0, 60)}"`);
  check(st.route === iw[id].route && st.region === iw[id].region, `${id}: route ${st.route}, budget region ${st.region}`);
  check(/cable cut (off|set off)/.test(st.banner), `${id}: cable cut off as the preset wants`);
  await p.close();
}
check(errors.length === 0, `no console errors${errors.length ? ": " + errors.slice(0, 3).join(" | ") : ""}`);
await b.close();
process.exit(fail ? 1 : 0);
