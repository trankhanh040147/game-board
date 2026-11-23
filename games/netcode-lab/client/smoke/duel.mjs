// Duel smoke test (M8): two headless Chromium pages through bin/duelrelay, then one page against bin/duelbot.
// Checks: both peers simulate ~60 frames/s, checksums are compared every frame with no desync, P23 lockstep runs,
// P25 inject is caught by both peers at the injected frame, and WASM (browser) vs native (bot) stays in sync.
// Usage: DUEL_URL=http://127.0.0.1:8090 node smoke/duel.mjs   (relay running; bin/duelbot built)
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

function cachedChromium() {
  const root = join(homedir(), "Library/Caches/ms-playwright");
  if (!existsSync(root)) return null;
  for (const d of readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]))) {
    for (const p of ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-linux/chrome"]) {
      if (existsSync(join(root, d, p))) return join(root, d, p);
    }
  }
  return null;
}
const executablePath = process.env.PW_CHROMIUM || (existsSync(chromium.executablePath()) ? chromium.executablePath() : cachedChromium());
if (!executablePath) { console.error("no Chromium found: set PW_CHROMIUM"); process.exit(2); }
const base = process.env.DUEL_URL ?? "http://127.0.0.1:8090";
const bot = process.env.DUEL_BOT ?? "../bin/duelbot";
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
let fail = 0;
const check = (ok, msg) => { console.log(`${ok ? "PASS" : "FAIL"} ${msg}`); if (!ok) fail++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(room) {
  const p = await browser.newPage();
  p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}/duel.html?room=${room}`);
  return p;
}
const stats = (p) => p.evaluate(() => window.__duel?.stats());
async function waitFrame(p, n, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) { const s = await stats(p); if (s?.started && s.frame >= n) return s; if (Date.now() > end) throw new Error(`frame ${n} not reached: ${JSON.stringify(s)}`); await sleep(200); }
}
const line = (s) => `frame ${s.frame} D=${s.delay}${s.delayAuto ? " auto" : ""} rtt ${s.rttMs.toFixed(0)} ms rollbacks ${s.rollbacks} rolled back ${s.framesRolledBack} stalls ${s.stallFrames} (${s.stallMs.toFixed(0)} ms) checks ${s.checksCompared} desync ${s.desync ? s.desync.frame : "none"}`;

// 1. Browser vs browser, rollback, keys held on A.
const room = `smoke-${Date.now()}`;
const a = await open(room), b = await open(room);
await waitFrame(a, 60); await waitFrame(b, 60);
await a.keyboard.down("KeyD"); await sleep(700); await a.keyboard.up("KeyD"); await a.keyboard.press("KeyJ");
await b.keyboard.down("KeyA"); await sleep(500); await b.keyboard.press("Space"); await b.keyboard.up("KeyA");
await sleep(3000);
let sa = await stats(a), sb = await stats(b);
console.log(`A ${line(sa)}\nB ${line(sb)}`);
check(sa.checksCompared > 150 && sb.checksCompared > 150, "browser vs browser: checksums compared every frame");
check(!sa.desync && !sb.desync, "browser vs browser: no desync");
check(sa.rollbacks + sb.rollbacks > 0, "rollback mode rolled back on opponent input changes");

// 2. P23 lockstep on both, then 3. P25 inject on A.
await a.click('[data-p="P23"]');
await sleep(500);
await waitFrame(a, 120); await waitFrame(b, 120);
await sleep(2000);
sa = await stats(a); sb = await stats(b);
console.log(`lockstep A ${line(sa)}\nlockstep B ${line(sb)}`);
check(sa.mode === 1 && sb.mode === 1 && sa.rollbacks === 0 && sb.rollbacks === 0, "P23: both peers in lockstep, no rollbacks");
await a.click('[data-p="P25"]');
await sleep(2000);
sa = await stats(a); sb = await stats(b);
console.log(`inject at ${sa.injectedAt} bit ${sa.injectedBit}: A desync ${JSON.stringify(sa.desync)} B desync ${JSON.stringify(sb.desync)}`);
check(sa.desync?.frame === sa.injectedAt && sb.desync?.frame === sa.injectedAt, "P25: both peers name the injected frame as the first desync");
const shown = await a.textContent("#desync");
check(/DESYNC at frame/.test(shown), "P25: desync named on screen");
check(new RegExp(`seed ${sa.seed}\\b`).test(shown), `P25: banner shows the seed (${sa.seed}) so the flip is reproducible`);
await a.close(); await b.close();

// 4. Browser (WASM) vs bin/duelbot (native) in rollback D=0.
const room2 = `smoke-bot-${Date.now()}`;
const c = await open(room2);
const wsUrl = base.replace(/^http/, "ws") + "/duel/ws";
const child = spawn(bot, ["-room", room2, "-url", wsUrl], { stdio: "ignore" });
await waitFrame(c, 60);
await c.click('[data-p="P21"]');
await sleep(500);
await waitFrame(c, 400);
const sc = await stats(c);
console.log(`browser vs bot: ${line(sc)}`);
check(sc.checksCompared > 300 && !sc.desync, "browser (WASM) vs bot (native arm64): no desync");
child.kill();
await c.close();

check(errors.length === 0, `no console errors${errors.length ? ": " + errors.join(" | ") : ""}`);
await browser.close();
process.exit(fail ? 1 : 0);
