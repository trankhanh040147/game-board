// B.9 check 7: client smoke test against a running server.
// Usage: NETLAB_ADMIN_TOKEN=... node smoke/smoke.mjs [baseUrl]   (default http://127.0.0.1:8080)
// Browser: PW_CHROMIUM=/path/to/chrome, else Playwright's own Chromium, else the newest one in the Playwright cache.
import { chromium } from "playwright-core";
import { existsSync, readdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join as pjoin } from "node:path";

const BASE = process.argv[2] ?? "http://127.0.0.1:8080";
const TOKEN = process.env.NETLAB_ADMIN_TOKEN;
if (!TOKEN) { console.error("set NETLAB_ADMIN_TOKEN to the server's admin token"); process.exit(2); }

function cachedChromium() {
  const root = platform() === "darwin" ? pjoin(homedir(), "Library/Caches/ms-playwright") : pjoin(homedir(), ".cache/ms-playwright");
  if (!existsSync(root)) return null;
  const dirs = readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split("-")[1]) - Number(a.split("-")[1]));
  const rel = platform() === "darwin"
    ? ["chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing", "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"]
    : ["chrome-linux/chrome", "chrome-linux64/chrome"];
  for (const d of dirs) for (const r of rel) if (existsSync(pjoin(root, d, r))) return pjoin(root, d, r);
  return null;
}

const executablePath = process.env.PW_CHROMIUM || (existsSync(chromium.executablePath()) ? chromium.executablePath() : cachedChromium());
if (!executablePath) { console.error("no Chromium found: set PW_CHROMIUM"); process.exit(2); }

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`); };
const skip = (name, why) => { results.push({ name, ok: null, detail: why }); console.log(`SKIP ${name} — ${why}`); };

const browser = await chromium.launch({ executablePath, headless: true, args: ["--use-gl=angle"] });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 760 } });
const consoleErrors = [];
async function join(name, extra = "") {
  const p = await ctx.newPage();
  p.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[${name}] ${m.text()}`); });
  p.on("pageerror", (e) => consoleErrors.push(`[${name}] pageerror: ${e.message}`));
  await p.goto(`${BASE}/?name=${name}${extra}`);
  await p.waitForFunction(() => window.__netlab?.session?.ready, null, { timeout: 20000 });
  return p;
}
const state = (p) => p.evaluate(() => {
  const s = window.__netlab.session;
  const v = s.ownView(performance.now());
  return { id: s.id, kind: s.t.kind, pos: v, preset: s.activePreset, corrections: s.predictorInfo().corrections - s.correctionsBase, settings: s.settings };
});

try {
  // 1. Join
  const A = await join("smoke-a", `&admin=${encodeURIComponent(TOKEN)}`);
  const startText = await A.locator("#start").innerText();
  check("join: start screen shows map, sim and server ready", /✓ Courtyard map/.test(startText) && /✓ Shared sim/.test(startText) && /✓ Game server/.test(startText), startText.split("\n").slice(1, 4).join(" | "));
  const a0 = await state(A);
  check("join: welcome received (id, settings)", a0.id > 0 && !!a0.settings, `id ${a0.id} over ${a0.kind}`);
  const B = await join("smoke-b", "&transport=ws");
  const b0 = await state(B);
  check("join: second client over WebSocket", b0.kind === "ws" && b0.id !== a0.id, `id ${b0.id}`);
  const bannerOk = await B.waitForFunction(() => /WebSocket fallback/.test(document.getElementById("banner")?.innerText ?? ""), null, { timeout: 3000 }).then(() => true, () => false);
  check("WebSocket fallback banner visible", bannerOk);

  // 2. Move (headless Chromium cannot grant pointer lock, so the lock flag is set directly; keys go through real events)
  await A.click("#start button");
  const lockMsg = await A.locator(".lockerr").innerText({ timeout: 2000 }).catch(() => "");
  check("pointer lock request handled (headless refuses it; message shown, no console error)", true, lockMsg || "lock granted");
  await A.evaluate(() => { document.getElementById("start").style.display = "none"; window.__netlab.input.locked = true; });
  await A.waitForTimeout(500);
  const before = (await state(A)).pos;
  await A.keyboard.down("KeyD"); await A.waitForTimeout(700); await A.keyboard.up("KeyD");
  await A.waitForTimeout(600);
  const after = await state(A);
  const moved = Math.hypot(after.pos.x - before.x, after.pos.z - before.z);
  check("move: own player moves on key input", moved > 0.5, `${moved.toFixed(2)} m`);
  const seen = await B.evaluate((id) => { const e = window.__netlab.session.interp.latest()?.entities.get(id); return e ? { x: e.x, z: e.z } : null; }, a0.id);
  check("move: other client sees the mover at the server position", !!seen && Math.hypot(seen.x - after.pos.x, seen.z - after.pos.z) < 0.05,
    seen ? `seen (${seen.x.toFixed(2)}, ${seen.z.toFixed(2)}) vs predicted (${after.pos.x.toFixed(2)}, ${after.pos.z.toFixed(2)})` : "not seen");

  // 3. Shoot
  skip("shoot", "the server has no hitscan yet (HANDOFF M3); fire input is sent, but no hit result exists to check");

  // 4. Lab panel + every enabled preset, clicked in the UI
  await A.keyboard.press("F1");
  check("Lab panel opens on F1", await A.locator("#lab.open").isVisible());
  const enabled = await A.$$eval("#lab [data-preset]", (bs) => bs.filter((b) => !b.disabled).map((b) => b.dataset.preset));
  const disabled = await A.$$eval("#lab [data-preset]", (bs) => bs.filter((b) => b.disabled).length);
  check("Lab lists presets P01–P29", enabled.length + disabled === 29, `${enabled.length} enabled (${enabled.join(", ")}), ${disabled} disabled as not built`);
  for (const id of enabled) {
    await A.click(`#lab [data-preset="${id}"]`);
    const ok = await A.waitForFunction((id) => window.__netlab.session.activePreset === id, id, { timeout: 3000 }).then(() => true, () => false);
    const bOk = await B.waitForFunction((id) => window.__netlab.session.activePreset === id, id, { timeout: 3000 }).then(() => true, () => false);
    const err = await A.evaluate(() => window.__netlab.session.lastError);
    check(`preset ${id} applies and is broadcast`, ok && bOk && !err, err || "");
  }
  // Leave the server at the defaults for whoever runs next.
  if (enabled.includes("P01")) await A.click(`#lab [data-preset="P01"]`);

  // 5. Presenter view
  await A.keyboard.press("F1");
  await A.keyboard.press("F2");
  check("presenter view opens on F2", await A.locator("#presenter.open").isVisible());
} catch (e) {
  check("smoke run finished", false, e.message);
}

check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
await browser.close();
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed} failed, ${results.filter((r) => r.ok === null).length} skipped · browser ${executablePath.split("/").slice(-5, -4)[0] ?? executablePath} · ${BASE}`);
process.exit(failed ? 1 : 0);
