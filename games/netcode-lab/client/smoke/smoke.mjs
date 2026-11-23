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
  check("join: welcome received (id, settings)", a0.id > 0 && !!a0.settings, `id ${a0.id} over ${a0.kind} (http page on loopback is a secure context)`);
  const B = await join("smoke-b", "&transport=ws");
  const b0 = await state(B);
  check("join: second client over WebSocket", b0.kind === "ws" && b0.id !== a0.id, `id ${b0.id}`);
  // 1b. HTTPS page (what LAN players open): WebTransport with the pinned self-signed cert, no fallback banner.
  const info = await (await fetch(`${BASE}/api/info`)).json();
  if (info.wt) {
    const httpsBase = `https://${new URL(BASE).hostname}:${info.wt.port}`;
    const tls = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 760 } });
    const H = await tls.newPage();
    H.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[smoke-https] ${m.text()}`); });
    H.on("pageerror", (e) => consoleErrors.push(`[smoke-https] pageerror: ${e.message}`));
    await H.goto(`${httpsBase}/?name=smoke-https`);
    const hOk = await H.waitForFunction(() => window.__netlab?.session?.ready, null, { timeout: 20000 }).then(() => true, () => false);
    const hKind = hOk ? await H.evaluate(() => window.__netlab.session.t.kind) : "none";
    await H.waitForTimeout(400);
    const hBanner = await H.locator("#banner").innerText().catch(() => "");
    check("join over HTTPS page: WebTransport datagrams, no fallback banner", hKind === "wt" && !/WebSocket fallback/.test(hBanner), `${httpsBase} → ${hKind}`);
    await tls.close();
  } else skip("join over HTTPS page", "server reports no WebTransport (/api/info wt = null)");
  await A.evaluate((tok) => window.__netlab.session.setSetting("compDelta", true, tok), TOKEN);
  await A.waitForTimeout(1500);
  const delta = await A.evaluate(() => { const s = window.__netlab.session; return { deltaSnaps: s.deltaSnaps, enc: s.lastEncoding, compDelta: s.settings.compDelta, err: s.lastError }; });
  check("v3 ack by snapId: with compDelta on, snapshots arrive delta-encoded against the acked one (P27)", delta.compDelta === true && delta.deltaSnaps > 0, JSON.stringify(delta));
  await A.evaluate((tok) => window.__netlab.session.applyPreset("P01", tok), TOKEN);
  const bannerOk = await B.waitForFunction(() => /WebSocket fallback/.test(document.getElementById("banner")?.innerText ?? ""), null, { timeout: 3000 }).then(() => true, () => false);
  check("WebSocket fallback banner visible and says the stall is simulated", bannerOk && /simulated/.test(await B.locator("#banner").innerText()));
  const graph = await A.locator("#netgraph").innerText();
  const cond = await A.evaluate(() => window.__netlab.session.cond);
  const simOn = cond && (cond.up.delayMs + cond.down.delayMs) > 0;
  check("A.16: RTT row says it includes simulated delay when the conditioner is on", !simOn || /RTT[^\n]*incl\. simulated/.test(graph), simOn ? graph.split("\n")[0] : "conditioner off");

  // 2. Play without pointer lock. Headless Chromium rejects requestPointerLock (a real rejected promise), so this is
  //    the same path an embedded browser view takes. Expect: overlay closes, drag-to-look note, keys move the player.
  await A.click("#start button");
  const overlayClosed = await A.waitForFunction(() => getComputedStyle(document.getElementById("start")).display === "none", null, { timeout: 3000 }).then(() => true, () => false);
  const note = await A.locator("#dragnote").isVisible();
  const lockMsg = await A.locator(".lockerr").textContent().catch(() => "");
  check("refused pointer lock (rejected promise): overlay closes, drag-to-look note shown", overlayClosed && note, lockMsg || "lock was granted");
  const before = (await state(A)).pos;
  await A.keyboard.down("KeyD"); await A.waitForTimeout(700); await A.keyboard.up("KeyD");
  await A.waitForTimeout(600);
  const after = await state(A);
  const moved = Math.hypot(after.pos.x - before.x, after.pos.z - before.z);
  check("move: own player moves on key input", moved > 0.5, `${moved.toFixed(2)} m`);
  const yaw0 = await A.evaluate(() => window.__netlab.input.yaw);
  await A.mouse.move(640, 380); await A.mouse.down({ button: "right" }); await A.mouse.move(540, 380, { steps: 5 }); await A.mouse.up({ button: "right" });
  const yaw1 = await A.evaluate(() => window.__netlab.input.yaw);
  check("drag to look turns the view", Math.abs(yaw1 - yaw0) > 0.05, `yaw ${yaw0.toFixed(3)} → ${yaw1.toFixed(3)} rad`);
  const seen = await B.evaluate((id) => { const e = window.__netlab.session.interp.latest()?.entities.get(id); return e ? { x: e.x, z: e.z } : null; }, a0.id);
  check("move: other client sees the mover at the server position", !!seen && Math.hypot(seen.x - after.pos.x, seen.z - after.pos.z) < 0.05,
    seen ? `seen (${seen.x.toFixed(2)}, ${seen.z.toFixed(2)}) vs predicted (${after.pos.x.toFixed(2)}, ${after.pos.z.toFixed(2)})` : "not seen");

  // 2b. requestPointerLock that throws synchronously, as reported from an embedded view (WrongDocumentError).
  const C = await ctx.newPage();
  C.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[smoke-c] ${m.text()}`); });
  C.on("pageerror", (e) => consoleErrors.push(`[smoke-c] pageerror: ${e.message}`));
  await C.addInitScript(() => {
    Element.prototype.requestPointerLock = function () { throw new DOMException("The root document of this element is not valid for pointer lock.", "WrongDocumentError"); };
  });
  await C.goto(`${BASE}/?name=smoke-c`);
  await C.waitForFunction(() => window.__netlab?.session?.ready, null, { timeout: 20000 });
  await C.click("#start button");
  const cClosed = await C.waitForFunction(() => getComputedStyle(document.getElementById("start")).display === "none", null, { timeout: 3000 }).then(() => true, () => false);
  const cMsg = await C.locator(".lockerr").textContent().catch(() => "");
  const c0 = (await C.evaluate(() => window.__netlab.session.ownView(performance.now())));
  await C.keyboard.down("KeyA"); await C.waitForTimeout(600); await C.keyboard.up("KeyA"); await C.waitForTimeout(300);
  const c1 = (await C.evaluate(() => window.__netlab.session.ownView(performance.now())));
  const cMoved = Math.hypot(c1.x - c0.x, c1.z - c0.z);
  check("refused pointer lock (sync WrongDocumentError): overlay closes, message names the error, keys move", cClosed && /WrongDocumentError/.test(cMsg) && cMoved > 0.5, `${cMsg} · moved ${cMoved.toFixed(2)} m`);
  await C.keyboard.press("Escape");
  const cBack = await C.waitForFunction(() => getComputedStyle(document.getElementById("start")).display !== "none", null, { timeout: 2000 }).then(() => true, () => false);
  check("Esc leaves drag mode and shows the overlay again", cBack);
  await C.close();

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
  await A.keyboard.press("F2");

  // 6. Real shots. The target gets its own browser: headless Chromium stops animation frames in a background tab,
  //    which would freeze that client's game loop.
  await B.close();
  const browser2 = await chromium.launch({ executablePath, headless: true, args: ["--use-gl=angle"] });
  try {
    const T = await browser2.newPage({ viewport: { width: 1280, height: 760 } });
    T.on("console", (m) => { if (m.type() === "error") consoleErrors.push(`[smoke-target] ${m.text()}`); });
    T.on("pageerror", (e) => consoleErrors.push(`[smoke-target] pageerror: ${e.message}`));
    await T.goto(`${BASE}/?name=smoke-target`);
    await T.waitForFunction(() => window.__netlab?.session?.ready, null, { timeout: 20000 });
    await T.click("#start button");
    await A.bringToFront();
    const who = (p) => p.evaluate(() => { const s = window.__netlab.session; return { id: s.id, team: s.team, ...s.ownView(performance.now()) }; });
    const a = await who(A), t = await who(T);
    if (a.team === t.team) throw new Error(`shooter and target joined the same team (${a.team}); teammates cannot be hit`);
    await A.click(`#lab [data-preset="P09"]`).catch(async () => { await A.keyboard.press("F1"); await A.click(`#lab [data-preset="P09"]`); await A.keyboard.press("F1"); });
    await A.waitForFunction(() => window.__netlab.session.activePreset === "P09", null, { timeout: 3000 });
    if (await A.locator("#lab.open").isVisible()) await A.keyboard.press("F1");
    // Line of fire at x ≈ 5.5 passes between the low wall (|x| < 3) and the side blocks (|x| > 8).
    const goX = async (p, x) => {
      for (let i = 0; i < 40; i++) {
        const v = await who(p); const dx = x - v.x; if (Math.abs(dx) < 0.3) return;
        const key = (v.team === "blue") === (dx > 0) ? "KeyD" : "KeyA";
        await p.keyboard.down(key); await p.waitForTimeout(Math.min(250, Math.abs(dx) * 60)); await p.keyboard.up(key); await p.waitForTimeout(150);
      }
    };
    await A.evaluate(() => { window.__netlab.input.yaw = 0; window.__netlab.input.pitch = 0; });
    await T.evaluate(() => { window.__netlab.input.yaw = Math.PI; window.__netlab.input.pitch = 0; });
    // Opening the Lab or the presenter view leaves play on purpose; press Play again (drag mode headless).
    const play = async (p) => { if (await p.locator("#start").isVisible()) await p.click("#start button"); };
    await play(A);
    await goX(A, 5.5); await goX(T, 5.5);
    await A.waitForTimeout(500);
    // Aim at the target as this client draws it (interpolated), after mouse-down so the press cannot move the aim.
    const aimAndFire = async () => {
      await A.evaluate(() => { window.__shot = null; const s = window.__netlab.session; if (!s.__wrapped) { const prev = s.onSnapEvent; s.onSnapEvent = (e, now) => { prev(e, now); if (e.type === "shot") { window.__shot = e; window.__marker = getComputedStyle(document.getElementById("hitmarker")).display; } }; s.__wrapped = true; } });
      const aim = () => A.evaluate((tid) => {
        const n = window.__netlab, e = n.drawn().get(tid), m = n.session.ownView(performance.now());
        const dx = e.x - m.x, dz = e.z - m.z; n.input.yaw = Math.atan2(-dx, -dz); n.input.pitch = Math.atan2(((e.y ?? 0) + 1.0) - (m.y + 1.6), Math.hypot(dx, dz));
      }, t.id);
      // Aim before the press (the first fire tick may be sampled right after it) and again after it.
      await A.mouse.move(640, 380); await aim(); await A.mouse.down(); await aim();
      await A.waitForTimeout(30); await A.mouse.up();
      await A.waitForFunction(() => window.__shot, null, { timeout: 5000 }).catch(() => {});
      await A.waitForTimeout(200);
      return A.evaluate(() => ({
        shot: window.__shot && { hitId: window.__shot.hitId, hitbox: window.__shot.hitbox, damage: window.__shot.damage, lagcomp: window.__shot.lagcomp, seenId: window.__shot.seenId, movedCm: window.__shot.movedCm, renderTick: window.__shot.renderTick, rewoundTick: window.__shot.rewoundTick, resolveTick: window.__shot.resolveTick },
        reason: document.getElementById("shotreason")?.innerText ?? "",
        marker: window.__marker ?? "none", // read inside the event handler: a body-hit marker lasts 200 ms
        boxes: window.__netlab.world.scene.children.filter((o) => o.type === "Group" && o.children[0]?.type === "LineSegments" && o.children[0].renderOrder === 30).length,
      }));
    };
    const hit = await aimAndFire();
    check("shoot (P09, lag comp on, target still): server confirms the hit, hit marker shows", !!hit.shot && hit.shot.hitId === t.id && hit.marker !== "none",
      hit.shot ? `hitId ${hit.shot.hitId}, hitbox ${hit.shot.hitbox}, damage ${hit.shot.damage}, rendered tick ${hit.shot.renderTick} → rewound ${hit.shot.rewoundTick} (resolved ${hit.shot.resolveTick})` : "no shot event");
    check("P09 overlay: red (your render time) and blue (server) hitboxes drawn", hit.boxes >= 2, `${hit.boxes} boxes · ${hit.reason.split("\n")[0]}`);
    await A.keyboard.press("F1");
    await A.click(`#lab [data-preset="P08"]`);
    await A.waitForFunction(() => window.__netlab.session.activePreset === "P08", null, { timeout: 3000 });
    await A.keyboard.press("F1");
    await play(A);
    await A.waitForTimeout(400);
    await T.keyboard.down("KeyA"); await A.waitForTimeout(350);
    const miss = await aimAndFire();
    await T.keyboard.up("KeyA");
    check("P08 (lag comp off, target strafing): shot event with lagcomp off and a miss reason on screen", !!miss.shot && miss.shot.lagcomp === false && /lag compensation off/.test(miss.reason),
      miss.shot ? `${miss.shot.hitId ? "hit" : "miss"}, seenId ${miss.shot.seenId}, server MovedCm ${miss.shot.movedCm} · "${miss.reason.split("\n")[0]}"` : "no shot event");
    await A.keyboard.press("F1");
    await A.click(`#lab [data-preset="P01"]`);
    await A.keyboard.press("F1");
  } finally {
    await browser2.close();
  }
} catch (e) {
  check("smoke run finished", false, e.message);
}

check("no console errors", consoleErrors.length === 0, consoleErrors.join(" | "));
await browser.close();
const failed = results.filter((r) => r.ok === false).length;
console.log(`\n${results.filter((r) => r.ok).length} passed, ${failed} failed, ${results.filter((r) => r.ok === null).length} skipped · browser ${executablePath.split("/").slice(-5, -4)[0] ?? executablePath} · ${BASE}`);
process.exit(failed ? 1 : 0);
