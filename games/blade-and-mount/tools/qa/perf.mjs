#!/usr/bin/env node
/**
 * QA perf/stability probe: bot-driven tournament or melee run with periodic sampling.
 * Records FPS, draw calls, triangles, stuck fighters, NaN, console errors, state flow.
 * Usage: node tools/qa/perf.mjs --width 1280 --height 720 --quality high --mode tournament --duration 90000
 */
import { launch, sleep, shot, parseArgs, writeJson } from './lib.mjs';

const args = parseArgs();
const argv = process.argv.slice(2);
const get = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const width = Number(get('width', '1280'));
const height = Number(get('height', '720'));
const quality = get('quality', 'high');
const mode = get('mode', 'tournament');
const duration = Number(get('duration', '90000'));
const seed = get('seed', '123');
const tag = get('tag', `${mode}-${quality}-${width}x${height}`);
const url = `${args.url.replace(/\/$/, '')}/?autostart=${mode}&bot=1&seed=${seed}&quality=${quality}`;

const ctx = await launch({ url, width, height });
const { page } = ctx;
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
await sleep(2500);

const samples = [];
const stuck = new Map(); // id -> { since, desc }
const stuckEvents = [];
const nanEvents = [];
const stateNoise = [];
let lastState = 'boot';
let roundsCompleted = 0;
const t0 = Date.now();
let shotAt30 = false;
let shotAt60 = false;

const clickIf = async (needle) => {
  const ok = await page.evaluate((n) => {
    const norm = (t) => t.replace(/\s+/g, ' ').toUpperCase();
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => !x.disabled && norm(x.innerText).includes(norm(n)),
    );
    if (!b) return false;
    b.click();
    return b.innerText.replace(/\s+/g, ' ').trim();
  }, needle);
  return ok;
};

while (Date.now() - t0 < duration) {
  await sleep(2000);
  const elapsed = Date.now() - t0;
  const snap = await page.evaluate(() => {
    const g = window.__game?.game;
    if (!g) return null;
    const s = g.getDebugState();
    const fighters = g.fighters.map((f) => ({
      id: f.id, name: f.name, alive: f.alive, state: f.state, hp: f.hp, stamina: f.stamina,
      x: +f.position.x.toFixed(3), y: +f.position.y.toFixed(3), z: +f.position.z.toFixed(3),
      speed: +Math.hypot(f.velocity.x, f.velocity.z).toFixed(3),
      attackTimer: f.attackTimer, deadTime: f.deadTime,
      team: f.team, isPlayer: f.isPlayer,
    }));
    const enemiesNear = fighters.filter((f) => f.alive);
    const nan = fighters.filter((f) => ![f.x, f.y, f.z, f.hp, f.stamina].every(Number.isFinite));
    const state = g.state;
    const roundIdx = g.tournament ? g.tournament.roundIndex + 1 : 0;
    return {
      state, roundIdx, s, nan, fighters, aliveCount: enemiesNear.length,
      camera: [g.cameraCtrl.position.x, g.cameraCtrl.position.y, g.cameraCtrl.position.z],
      playerHp: g.player?.hp ?? 0,
      playerAlive: g.player?.alive ?? false,
      lock: g.input?.locked ?? false,
    };
  });
  if (!snap) { stateNoise.push({ t: elapsed, why: 'no game' }); continue; }
  const prev = samples[samples.length - 1];
  samples.push({ t: elapsed, fps: snap.s.fps, drawCalls: snap.s.drawCalls, triangles: snap.s.triangles, state: snap.state, round: snap.roundIdx, alive: snap.aliveCount, playerAlive: snap.playerAlive, playerHp: Math.round(snap.playerHp) });
  if (snap.nan.length) nanEvents.push({ t: elapsed, nan: snap.nan });

  // stuck detection: alive fighter barely moving but in an actionable combat state near an enemy
  const alive = snap.fighters.filter((f) => f.alive);
  for (const f of alive) {
    const nearEnemy = alive.some((o) => o.id !== f.id && (o.team < 0 || f.team < 0 || o.team !== f.team) &&
      Math.hypot(o.x - f.x, o.z - f.z) < 5);
    const busy = f.state === 'idle' || f.state === 'attack' || f.state === 'block' || f.state === 'stagger';
    const isStuck = nearEnemy && busy && f.speed < 0.12;
    const rec = stuck.get(f.id);
    if (isStuck && !rec) stuck.set(f.id, { since: elapsed, desc: `${f.name} ${f.state} hp=${Math.round(f.hp)} pos=${f.x},${f.z}` });
    else if (!isStuck && rec) stuck.delete(f.id);
    else if (isStuck && rec && elapsed - rec.since > 5000) {
      stuckEvents.push({ t: elapsed, stuckMs: elapsed - rec.since, ...rec });
      stuck.delete(f.id);
    }
  }

  if (snap.state !== lastState) {
    stateNoise.push({ t: elapsed, from: lastState, to: snap.state, round: snap.roundIdx });
    if (snap.state === 'round-result') roundsCompleted++;
    lastState = snap.state;
  }

  // Drive the flow: enter each round, skip intros, advance results.
  if (snap.state === 'bracket') {
    await clickIf('ENTER THE LISTS') || await clickIf('FIGHT FOR THE CROWN');
  } else if (snap.state === 'intro') {
    await page.keyboard.press('Enter');
  } else if (snap.state === 'menu') {
    await clickIf('TOURNAMENT') || await clickIf('ARENA MELEE');
  }

  // Auto-advance the bot through round results / tournament ends.
  if (snap.state === 'round-result') {
    const advanced = await clickIf('ONWARD') || await clickIf('CLAIM THE CROWN') || await clickIf('RETURN TO THE LISTS');
    if (!advanced) console.log('  could not find advance button at', elapsed);
  } else if (snap.state === 'tournament-end' || snap.state === 'melee-result') {
    // end reached: record and finish early
    stateNoise.push({ t: elapsed, note: 'end screen reached', state: snap.state });
    break;
  }

  if (!shotAt30 && elapsed > 30000) {
    shotAt30 = true;
    await shot(page, `perf-${tag}-30s`);
  }
  if (!shotAt60 && elapsed > 60000) {
    shotAt60 = true;
    await shot(page, `perf-${tag}-60s`);
  }
}

// final state
const finalSnap = await page.evaluate(() => {
  const g = window.__game?.game;
  return g ? {
    state: g.state, mode: g.mode, round: g.tournament ? g.tournament.roundIndex + 1 : 0,
    fighters: g.fighters.length, alive: g.fighters.filter((f) => f.alive).length,
    s: g.getDebugState(), profile: { denars: g.profile.denars, xp: g.profile.xp, level: g.profile.level, renown: g.profile.renown, played: g.profile.tournamentsPlayed, won: g.profile.tournamentsWon, runs: g.profile.meleeRuns, best: g.profile.bestMelee },
  } : null;
});
await shot(page, `perf-${tag}-end`);

const fpsList = samples.map((s) => s.fps).filter((n) => Number.isFinite(n));
const avg = fpsList.length ? fpsList.reduce((a, b) => a + b, 0) / fpsList.length : 0;
const res = {
  tag, mode, quality, resolution: `${width}x${height}`, durationMs: duration,
  url,
  samples,
  frames: samples.length,
  fps: {
    avg: +avg.toFixed(1), min: fpsList.length ? Math.min(...fpsList) : 0, max: fpsList.length ? Math.max(...fpsList) : 0,
    p10: +(fpsList.slice().sort((a, b) => a - b)[Math.floor(fpsList.length * 0.1)] ?? 0).toFixed(1),
  },
  drawCalls: { max: Math.max(...samples.map((s) => s.drawCalls)), avg: +(samples.reduce((a, b) => a + b.drawCalls, 0) / Math.max(1, samples.length)).toFixed(0) },
  triangles: { max: Math.max(...samples.map((s) => s.triangles)) },
  roundsCompleted,
  stateFlow: stateNoise,
  stuckEvents,
  nanEvents,
  final: finalSnap,
  consoleErrors: ctx.consoleErrors,
  consoleWarnings: ctx.consoleWarnings.slice(0, 10),
  failedRequests: ctx.failedRequests,
};
await writeJson(`perf-${tag}.json`, res);
console.log(JSON.stringify({
  tag, mode, quality, resolution: res.resolution, frames: res.frames,
  fps: res.fps, drawCalls: res.drawCalls, triangles: res.triangles,
  roundsCompleted, finalState: finalSnap?.state, stuck: stuckEvents.length, nan: nanEvents.length,
  consoleErrors: ctx.consoleErrors.length, failedRequests: ctx.failedRequests.length,
}, null, 2));
await ctx.browser.close();
