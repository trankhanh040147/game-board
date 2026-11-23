// core's P14 check: the Lab-triggered peek test shows in the perf panel as "our measurement" with Riot as ref.
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
const b = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-gl=angle"] });
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
const errors = [];
p.on("pageerror", (e) => errors.push(e.message));
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
await p.goto(`${BASE}/?name=presenter&spectate=1&admin=${TOKEN}`);
await p.waitForFunction(() => window.__netlab?.session?.ready && window.__perf, null, { timeout: 20000 });
await p.keyboard.press("F3");
await p.click('#perf [data-peek="3"]');
await p.waitForFunction(() => /Running 3 crossings/.test(document.getElementById("perf").innerText), null, { timeout: 10000 });
console.log("PASS P14 running shown");
await p.waitForFunction(() => /our measurement/.test(document.getElementById("perf").innerText), null, { timeout: 120000 });
const txt = await p.locator("#perf").innerText();
const i = txt.search(/P14 PEEKER|P14 peeker/i); const sec = txt.slice(i);
console.log("PASS P14 result shown:\n" + sec.split("\n").slice(0, 12).join("\n"));
console.log(/\bref\b/.test(sec) && /Riot/.test(sec) ? "PASS ref labelled beside it" : "FAIL ref missing");
console.log(/simulated/.test(sec) ? "PASS conditioner labelled simulated" : "FAIL simulated label missing");
console.log(errors.length ? "FAIL console errors: " + errors.join(" | ") : "PASS no console errors");
await b.close();
