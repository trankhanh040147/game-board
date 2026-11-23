// D5 check: one browser player + fill bots (balanced) play round 1 on a fresh server; kills both ways; then the
// presenter removes the bots. Usage: NETLAB_ADMIN_TOKEN=x node smoke/fill.mjs http://127.0.0.1:<port>
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
const BASE = process.argv[2] ?? "http://127.0.0.1:8080", TOKEN = process.env.NETLAB_ADMIN_TOKEN ?? "";
const executablePath = process.env.PW_CHROMIUM || (existsSync(chromium.executablePath()) ? chromium.executablePath() : cachedChromium());
const b = await chromium.launch({ executablePath, headless: true, args: ["--use-gl=angle"] });
const errors = [];
const p = await b.newPage({ viewport: { width: 1280, height: 760 } });
p.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
p.on("pageerror", (e) => errors.push(e.message));
await p.goto(`${BASE}/?name=human&admin=${TOKEN}`);
await p.waitForFunction(() => window.__netlab?.session?.ready, null, { timeout: 20000 });
await p.click("#start button");
await p.evaluate(() => { const s = window.__netlab.session; window.__kills = []; window.__fill = null; const pk = s.onKill; s.onKill = (m, now) => { window.__kills.push(m); pk(m, now); };
  const pc = s.t.onControl; s.t.onControl = (m) => { if (m?.t === "fill") window.__fill = m; pc(m); }; });
await p.evaluate((tok) => window.__netlab.session.t.sendControl({ t: "fill", token: tok, n: -1 }), TOKEN);
await p.waitForFunction(() => window.__fill?.bots > 0, null, { timeout: 10000 });
const fill = await p.evaluate(() => window.__fill);
await p.waitForFunction((n) => window.__netlab.session.players.size >= n + 1, fill.bots, { timeout: 15000 });
const me = await p.evaluate(() => ({ id: window.__netlab.session.id, team: window.__netlab.session.team, round: window.__netlab.session.round }));
console.log(`fill: ${fill.bots} bots (balance) · me ${me.team} · round ${me.round?.no} ${me.round?.state}, ends in ${me.round ? ((me.round.endsAtServerMs - (await p.evaluate(() => window.__netlab.session.clockEstimate(performance.now()).serverTimeMs))) / 1000).toFixed(0) : "?"} s`);
// Play until round 1 ends: aim at the nearest enemy as drawn and click (the server decides hits).
const t0 = Date.now();
let clicks = 0;
while (Date.now() - t0 < 150000) {
  const r = await p.evaluate(() => window.__netlab.session.round);
  if (r && r.no === me.round.no && r.state === "ended") break;
  const aimed = await p.evaluate(() => {
    const n = window.__netlab, s = n.session; if (s.dead) return false;
    const m = s.ownView(performance.now()); if (!m) return false;
    let best = null, bd = 1e9;
    for (const [id, e] of n.drawn()) { const pl = s.players.get(id); if (!pl || pl.team === s.team) continue; const d = Math.hypot(e.x - m.x, e.z - m.z); if (d < bd) { bd = d; best = e; } }
    if (!best || bd > 40) return false;
    const dx = best.x - m.x, dz = best.z - m.z; n.input.yaw = Math.atan2(-dx, -dz); n.input.pitch = Math.atan2(((best.y ?? 0) + 1.0) - (m.y + 1.6), Math.hypot(dx, dz));
    return true;
  });
  if (aimed) { await p.mouse.move(640, 380); await p.mouse.down(); await p.waitForTimeout(30); await p.mouse.up(); clicks++; }
  await p.waitForTimeout(350);
}
await p.waitForTimeout(1500);
const end = await p.evaluate(() => ({ round: window.__netlab.session.round, rows: window.__netlab.session.scoreRows, kills: window.__kills, id: window.__netlab.session.id }));
console.log(`round ${end.round?.no} ${end.round?.state} · scores blue ${end.round?.scores?.blue} orange ${end.round?.scores?.orange} · ${clicks} clicks by the browser`);
for (const r of end.rows ?? []) console.log(`  ${r.team.padEnd(6)} ${r.name.padEnd(14)} K ${r.kills} D ${r.deaths} shots ${r.shots ?? "-"} hits ${r.hits ?? "-"} ping ${r.pingMs ?? "-"}`);
const humanKills = end.kills.filter((k) => k.killerId === end.id).length, humanDeaths = end.kills.filter((k) => k.victimId === end.id).length;
const botVsBot = end.kills.filter((k) => /\[bot\]/.test(k.killer) && /\[bot\]/.test(k.victim)).length;
console.log(`kill feed: ${end.kills.length} kills · browser killed ${humanKills} · browser died ${humanDeaths} · bot vs bot ${botVsBot}`);
// Presenter removes the bots.
await p.evaluate((tok) => window.__netlab.session.t.sendControl({ t: "fill", token: tok, n: 0 }), TOKEN);
const gone = await p.waitForFunction(() => window.__fill?.bots === 0 && window.__netlab.session.players.size === 1, null, { timeout: 10000 }).then(() => true, () => false);
console.log(`remove: ${gone ? "all bots left" : "NOT removed"} · players now ${await p.evaluate(() => window.__netlab.session.players.size)}`);
console.log(`console errors: ${errors.length ? errors.join(" | ") : "none"}`);
await b.close();
process.exit(humanKills > 0 && humanDeaths > 0 && gone && errors.length === 0 ? 0 : 1);
