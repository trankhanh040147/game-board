#!/usr/bin/env node
/** QA flow: Arena Melee — HUD counters, real kill wiring, death result, clear result, persistence. */
import { boot, sleep, shot, evalIn, parseArgs, writeJson, uiText, state } from './lib.mjs';
import { waitFor } from './lib.mjs';

const args = parseArgs();
const W = args.width, H = args.height;
const suffix = `${W}x${H}`;
const res = { checks: [], shots: [] };
const check = (name, pass, detail) => {
  res.checks.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
};

const ctx = await boot({ url: args.url, width: W, height: H, wait: 3500 });
const { page } = ctx;
const snap = async (n) => res.shots.push(await shot(page, `${n}-${suffix}`));
const clickReal = async (needle) => {
  const box = await page.evaluate((n) => {
    const norm = (t) => t.replace(/\s+/g, ' ').toUpperCase();
    const b = Array.from(document.querySelectorAll('button')).find((x) => !x.disabled && norm(x.innerText).includes(norm(n)));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, needle);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  return true;
};
const waitState = async (wanted, timeout = 15000) => !!(await waitFor(page, (w) => window.__game?.getState?.().state === w, timeout, 150, wanted));

const startMelee = async () => {
  await sleep(600);
  await clickReal('ARENA MELEE');
  await waitState('intro', 8000);
  await sleep(400);
  await page.keyboard.press('Enter');
  const ok = await waitState('fighting', 12000);
  await sleep(1200);
  return ok;
};

/** Put one live enemy right in front of the player, weaken it, and swing until it dies. */
const forceKill = async () => {
  const setup = await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => f.alive && !f.isPlayer);
    if (!e) return { ok: false, reason: 'no enemy' };
    e.ai = null; e.velocity.set(0,0,0);
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    e.position.set(p.position.x + fx * 1.9, 0, p.position.z + fz * 1.9);
    e.hp = 4; e.state = 'idle';
    p.requestAttack('thrust');
    return { ok: true, enemy: e.name, before: g.getDebugState() };
  `);
  // swing a few times in case the first one is blocked/dodged
  for (let i = 0; i < 6; i++) {
    await sleep(600);
    const st = await state(page);
    if ((st.meleeBeaten ?? 0) > 0) break;
    await evalIn(page, `const g = window.__game.game; const p = g.player;
      const e = g.fighters.find(f => f.alive && !f.isPlayer);
      if (!e) return false;
      e.ai = null; e.velocity.set(0,0,0);
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      e.position.set(p.position.x + fx * 1.9, 0, p.position.z + fz * 1.9);
      e.hp = Math.min(e.hp, 4); e.state = 'idle';
      p.yaw = Math.atan2(e.position.x - p.position.x, e.position.z - p.position.z);
      p.requestAttack('thrust');
      return true;`);
  }
  return setup;
};

try {
  /* ---------- A. Melee start + HUD ---------- */
  const started = await startMelee();
  check('melee starts and reaches fighting', started);
  await sleep(1500);
  const melee0 = await evalIn(page, `const g = window.__game.game; return {
    state: g.state, mode: g.mode, total: g.melee?.total, spawned: g.melee?.spawned,
    aliveEnemies: g.fighters.filter(f => f.alive && !f.isPlayer).length,
    playerAlive: g.player?.alive,
    hudText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 500),
    lastHud: g.ui.lastHud ? { mode: g.ui.lastHud.mode, beaten: g.ui.lastHud.opponentsBeaten, remaining: g.ui.lastHud.opponentsRemaining, total: g.ui.lastHud.opponentsTotal } : null,
    drawCalls: g.getDebugState().drawCalls, fps: g.getDebugState().fps,
  };`);
  res.melee0 = melee0;
  check('melee mode active with 35 opponents total', melee0.mode === 'melee' && melee0.total === 35, { mode: melee0.mode, total: melee0.total });
  check('HUD shows "Opponents Beaten: 0" / "Opponents Remaining: 35"',
    /OPPONENTS BEATEN:\s*0/i.test(melee0.hudText) && /OPPONENTS REMAINING:\s*35/i.test(melee0.hudText), melee0.hudText.slice(0, 240));
  check('melee spawfs 3-8 live opponents', melee0.aliveEnemies >= 3 && melee0.aliveEnemies <= 8, melee0.aliveEnemies);
  await snap('30-melee-fight');

  /* ---------- B. Real kill -> HUD counters + combat log ---------- */
  const killInfo = await forceKill();
  const killState = await evalIn(page, `const g = window.__game.game; return {
    beaten: g.melee?.beaten, defeatedTotal: g.melee?.defeatedTotal,
    hudText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
    logText: Array.from(document.querySelectorAll('.bm-log-entry, .bm-log-row, .bm-hud-log *')).map(n => n.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean).slice(-8),
    hudRemaining: g.ui.lastHud?.opponentsRemaining,
    hudBeaten: g.ui.lastHud?.opponentsBeaten,
  };`);
  res.kill = killInfo;
  check('player kill increments Opponents Beaten', killState.beaten >= 1, killState.beaten);
  check('HUD remaining decrements to 34', killState.hudRemaining === 34, killState.hudRemaining);
  check('combat log has M&B phrasing ("knocked unconscious" / experience)',
    /knocked unconscious|experience/i.test(killState.hudText), killState.hudText.slice(-240));
  await snap('31-melee-kill');

  /* ---------- C. Waves keep spawning ---------- */
  await sleep(2200);
  const waves = await evalIn(page, `const g = window.__game.game; return {
    spawned: g.melee?.spawned, alive: g.fighters.filter(f => f.alive && !f.isPlayer).length,
  };`);
  check('new opponents keep spawning', waves.spawned >= 3 && waves.alive >= 2, waves);

  /* ---------- D. Player death -> melee result (defeat) ---------- */
  await evalIn(page, `const g = window.__game.game; g.player.knockOut(g.world); return true;`);
  const deadResult = await waitState('melee-result', 8000);
  check('player death ends the melee run', deadResult);
  await sleep(700);
  const dead = await evalIn(page, `const g = window.__game.game; const r = g.melee?.lastResult; return {
    victory: r?.victory, beaten: r?.beaten, total: r?.total, rewardDenars: r?.rewardDenars,
    rewardRenown: r?.rewardRenown, best: r?.best,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 400),
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
    profile: { runs: g.profile.meleeRuns, best: g.profile.bestMelee, denars: g.profile.denars, xp: g.profile.xp },
    stored: JSON.parse(localStorage.getItem('blade-and-mount.profile.v1') || '{}'),
  };`);
  res.meleeDeath = dead;
  check('melee defeat result shows "You Fell" flavour', /FELL|FALLEN|DEFEAT/i.test(dead.text), dead.text.slice(0, 160));
  check('melee run recorded (meleeRuns+1, bestMelee)', dead.profile.runs === 1 && dead.profile.best === Math.max(1, dead.beaten), dead.profile);
  check('melee profile persisted', dead.stored.meleeRuns === 1, dead.stored.meleeRuns);
  check('defeat offers "Leave the Arena"', dead.buttons.some((b) => /LEAVE THE ARENA/i.test(b)), dead.buttons);
  await snap('32-melee-defeat');
  await clickReal('LEAVE THE ARENA');
  check('leaving melee returns to menu', await waitState('menu', 6000));

  /* ---------- E. Clear: 35/35 -> victory result ---------- */
  const started2 = await startMelee();
  check('melee can be replayed from menu', started2);
  // Synthetic end-game state: 34 beaten, exactly 1 opponent left; kill the last one for real.
  await evalIn(page, `const g = window.__game.game; const m = g.melee;
    // clear the sand first (does not touch melee counters), then hand-place the 35th opponent
    for (const f of g.fighters) if (!f.isPlayer && f.alive) f.knockOut(g.world);
    m.spawned = 34; m.total = 35; m.defeatedTotal = 34; m.beaten = 34; m.xpEarned = 272;
    g.spawnMeleeEnemy(true);
    return { alive: g.fighters.filter(f => f.alive && !f.isPlayer).length, spawned: m.spawned };`);
  await sleep(400);
  const preClear = await state(page);
  check('synthetic clear state: 1 opponent remaining', preClear.meleeBeaten === 34, preClear);
  // spawn one guaranteed live opponent in front of the player
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => f.alive && !f.isPlayer);
    if (e) { e.ai = null; e.hp = 4; e.position.set(p.position.x + Math.sin(p.yaw)*1.9, 0, p.position.z + Math.cos(p.yaw)*1.9); }
    return !!e;`);
  for (let i = 0; i < 10; i++) {
    await sleep(550);
    const s = await state(page);
    if (s.state === 'melee-result') break;
    await evalIn(page, `const g = window.__game.game; const p = g.player;
      if (!p.alive || g.state !== 'fighting') return false;
      let e = g.fighters.find(f => f.alive && !f.isPlayer);
      if (!e) return false;
      e.ai = null; e.hp = Math.min(e.hp, 4); e.state = 'idle';
      e.position.set(p.position.x + Math.sin(p.yaw)*1.9, 0, p.position.z + Math.cos(p.yaw)*1.9);
      p.yaw = Math.atan2(e.position.x - p.position.x, e.position.z - p.position.z);
      p.requestAttack('thrust'); return true;`);
  }
  const clearRes = await waitState('melee-result', 8000);
  check('35th kill finishes the melee (clear)', clearRes);
  await sleep(700);
  const clear = await evalIn(page, `const g = window.__game.game; const r = g.melee?.lastResult; return {
    victory: r?.victory, beaten: r?.beaten, total: r?.total, rewardDenars: r?.rewardDenars,
    rewardXp: r?.rewardXp, rewardRenown: r?.rewardRenown, best: r?.best,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 400),
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
    profile: { runs: g.profile.meleeRuns, best: g.profile.bestMelee, denars: g.profile.denars, renown: g.profile.renown, xp: g.profile.xp },
    stored: JSON.parse(localStorage.getItem('blade-and-mount.profile.v1') || '{}'),
  };`);
  res.meleeClear = clear;
  check('clear screen shows victory + 35/35', clear.victory === true && clear.beaten === 35, { victory: clear.victory, beaten: clear.beaten });
  check('clear rewards: +250 clear bonus (310 denars total)', clear.rewardDenars === 310, clear.rewardDenars);
  check('clear grants +2 renown', clear.rewardRenown === 2, clear.rewardRenown);
  check('bestMelee updates to 35', clear.profile.best === 35, clear.profile);
  check('clear offers "Take Your Winnings"', clear.buttons.some((b) => /TAKE YOUR WINNINGS/i.test(b)), clear.buttons);
  await snap('33-melee-clear');
  await clickReal('TAKE YOUR WINNINGS');
  check('leaving melee clear returns to menu', await waitState('menu', 6000));

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;
  check('no unexpected console errors', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
  try { await snap('fatal-melee'); } catch { /* ignore */ }
}

await writeJson(`flow-melee-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
