#!/usr/bin/env node
/** QA: audio unlock, procedural SFX/music playback, volume/mute behaviour, no asset fetches. */
import { boot, sleep, shot, evalIn, parseArgs, writeJson } from './lib.mjs';

const args = parseArgs();
const W = args.width, H = args.height;
const suffix = `${W}x${H}`;
const res = { checks: [], shots: [], notes: [] };
const check = (name, pass, detail) => {
  res.checks.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
};

const ctx = await boot({ url: args.url, width: W, height: H, wait: 3500 });
const { page } = ctx;

try {
  const before = await evalIn(page, `const a = window.__game.game.world.audio; return {
    state: a.state, hasGraph: !!(a.g ?? null), unlocked: !!a.unlocked,
  };`);
  res.before = before;
  check('audio starts locked before any user gesture', before.state === null || before.state === 'suspended', before);

  // A real click on the canvas is the documented unlock gesture.
  await page.mouse.click(Math.floor(W / 2), Math.floor(H / 2));
  await sleep(700);
  const after = await evalIn(page, `const a = window.__game.game.world.audio; return { state: a.state };`);
  res.afterClick = after;
  check('clicking the page unlocks the AudioContext', after.state === 'running', after);

  // Play every SFX name and start music; capture thrown errors.
  const sfx = ['swing', 'swing-heavy', 'hit-flesh', 'hit-armor', 'hit-shield', 'block-weapon', 'guard-break',
    'kick', 'death', 'footstep', 'dodge', 'spawn', 'gong', 'horn', 'crowd-cheer', 'ui-click', 'ui-hover',
    'bet', 'victory', 'defeat', 'round-start', 'bet-win', 'bet-lose'];
  const playAll = await evalIn(page, `const a = window.__game.game.world.audio; const errors = [];
    const names = ${JSON.stringify(sfx)};
    for (const n of names) {
      try { a.play(n, { volume: 0.2, rate: 1 }); } catch (e) { errors.push(n + ': ' + e.message); }
    }
    try { a.startMusic('tournament'); } catch (e) { errors.push('music: ' + e.message); }
    try { a.setCrowd(0.6); a.cheer(0.8); a.gong(); } catch (e) { errors.push('crowd/gong: ' + e.message); }
    return { errors, state: a.state };`);
  res.playAll = playAll;
  check('all documented SFX + music play without throwing', playAll.errors.length === 0, playAll.errors);
  await sleep(1500);
  const musicState = await evalIn(page, `const g = window.__game.game.world.audio.g; return g ? { state: g.ctx.state, nodes: g.ctx.currentTime > 0 } : null;`);
  check('audio graph stays running after playback', musicState?.state === 'running', musicState);

  // Volumes: master 0 must not throw and settings persist
  const vol = await evalIn(page, `const g = window.__game.game;
    g.applySettings({ ...g.settings, masterVolume: 0, musicVolume: 0.1, sfxVolume: 0.2 });
    const a = g.world.audio;
    return { settings: { m: g.settings.masterVolume, mu: g.settings.musicVolume, s: g.settings.sfxVolume }, state: a.state };`);
  await sleep(300);
  check('volume changes apply without errors', vol.state === 'running', vol);
  await evalIn(page, `const g = window.__game.game; g.applySettings({ ...g.settings, masterVolume: 0.85, musicVolume: 0.4, sfxVolume: 0.8 }); return true;`);

  // unlock while already unlocked, and stop music
  const reUnlock = await evalIn(page, `const a = window.__game.game.world.audio; const errors = [];
    try { a.unlock(); a.unlock(); } catch (e) { errors.push(e.message); }
    return { errors, state: a.state };`);
  check('repeated unlock is safe', reUnlock.errors.length === 0 && reUnlock.state === 'running', reUnlock);

  // start a melee to hear the full audio path (music, crowd, horn, combat)
  await evalIn(page, `window.__game.game.startMelee(); return true;`);
  await sleep(1200);
  await page.keyboard.press('Enter');
  await sleep(2500);
  const during = await evalIn(page, `const g = window.__game.game; return { state: g.state, audioState: g.world.audio.state };`);
  check('audio keeps running through melee start', during.audioState === 'running', during);
  await shot(page, `60-audio-${suffix}`);

  const stopped = await evalIn(page, `const a = window.__game.game.world.audio; a.stopMusic(0.1); return { state: a.state };`);
  check('stopMusic does not break the graph', stopped.state === 'running', stopped);

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;
  check('no console errors from audio', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
  check('no failed asset/network requests (procedural audio only)', ctx.failedRequests.filter((r) => !r.includes('favicon')).length === 0, ctx.failedRequests);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
}

await writeJson(`audio-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
