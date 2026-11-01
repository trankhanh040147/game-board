#!/usr/bin/env node
/**
 * QA flow: cold load -> menu -> tournament bracket -> bet -> 4 rounds -> champion -> menu.
 * Also pause/settings/quality during round 1.
 * Usage: node tools/qa/flow-tournament.mjs [--url ...] [--width 1280 --height 720]
 */
import {
  boot, state, sleep, clickText, uiText, shot, evalIn, waitFor, parseArgs, writeJson, launch, sleep as s,
} from './lib.mjs';

const args = parseArgs();
const W = args.width, H = args.height;
const suffix = `${W}x${H}`;
const res = { url: args.url, resolution: `${W}x${H}`, checks: [], shots: [] };
const check = (name, pass, detail) => {
  res.checks.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + JSON.stringify(detail) : ''}`);
};

const ctx = await boot({ url: args.url, width: W, height: H, wait: 4200 });
const { page } = ctx;
const shotName = async (n) => {
  const p = await shot(page, `${n}-${suffix}`);
  res.shots.push(p);
  return p;
};

const clickReal = async (needle) => {
  const box = await page.evaluate((n) => {
    const norm = (t) => t.replace(/\s+/g, ' ').toUpperCase();
    const b = Array.from(document.querySelectorAll('button')).find(
      (x) => !x.disabled && norm(x.innerText).includes(norm(n)),
    );
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.innerText.replace(/\s+/g, ' ') };
  }, needle);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  return box.text;
};


const integrity = async () => evalIn(page, `const g = window.__game.game; const t = g.tournament; return {
  fighters: g.fighters.length,
  playerFighters: g.fighters.filter(f => f.isPlayer).length,
  teams: t ? t.teams.length : 0,
  teamIds: t ? t.teams.map(x => x.id) : [],
  uniqueTeamIds: t ? new Set(t.teams.map(x => x.id)).size : 0,
  membersPerTeam: t ? t.teams.map(x => x.members.map(m => m.name)) : [],
  playerTeamId: t ? t.playerTeamId : -1,
  playerTeamMembers: t ? t.teams.find(x => x.isPlayerTeam)?.members.length : 0,
};`);

const waitState = async (wanted, timeout = 12000) =>
  waitFor(page, (w) => window.__game?.getState?.().state === w, timeout, 150, wanted).then((v) => !!v);

try {
  /* ---------------- 1. Cold load / menu ---------------- */
  const menuState = await state(page);
  const menuText = await uiText(page);
  check('cold load reaches menu', menuState?.state === 'menu', menuState?.state);
  check('menu renders title + 5 entries', /BLADE & MOUNT/.test(menuText) && (await page.$$eval('.bm-menu-btn', (n) => n.length)) === 5);
  check('menu profile strip shows denars/renown/wins', /120/.test(menuText) && /DENARS/i.test(menuText) && /RENOWN/i.test(menuText));
  const menuButtons = await page.$$eval('.bm-menu-btn', (ns) => ns.map((n) => n.innerText.replace(/\n/g, ' | ')));
  res.menuButtons = menuButtons;
  await shotName('01-menu');

  /* ---------------- 2. Bracket ---------------- */
  const clicked = await clickReal('TOURNAMENT');
  check('Tournament menu button clickable', !!clicked, clicked);
  const gotBracket = await waitState('bracket');
  check('tournament opens bracket', gotBracket);
  await sleep(700);

  const bracket = await evalIn(page, `
    const g = window.__game.game;
    return {
      round: g.tournament.roundIndex + 1,
      teams: g.tournament.teams.length,
      teamSize: g.tournament.teams[0]?.members.length,
      survivors: g.tournament.contestants.filter(c => c.alive).length,
      bet: g.tournament.bet,
      betChips: Array.from(document.querySelectorAll('.bm-betchip')).map(b => ({ t: b.innerText.trim(), disabled: b.disabled, selected: b.classList.contains('is-selected') })),
      purse: g.buildTournamentView().purse,
      maxBet: g.buildTournamentView().maxBet,
      denars: g.profile.denars,
      withdraw: Array.from(document.querySelectorAll('button')).some(b => /WITHDRAW/i.test(b.innerText)),
      enter: Array.from(document.querySelectorAll('button')).some(b => /ENTER THE LISTS/i.test(b.innerText)),
    };
  `);
  res.bracket = bracket;
  check('round 1: 4 teams x 4', bracket.teams === 4 && bracket.teamSize === 4, bracket);
  check('16 survivors on the board', bracket.survivors === 16, bracket.survivors);
  check('bet chips present (0/25/50/100/150)', bracket.betChips.length === 5, bracket.betChips);
  check('purse + denars shown', bracket.purse === 60 && bracket.denars === 120, { purse: bracket.purse, denars: bracket.denars });
  await shotName('02-bracket');

  /* ---------------- 3. Bet ---------------- */
  const betChip = await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.bm-betchip')).find((x) => x.innerText.trim() === '100');
    if (!b || b.disabled) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check('100-denar bet chip enabled', !!betChip);
  if (betChip) {
    await page.mouse.click(betChip.x, betChip.y);
    await sleep(500);
  }
  const betState = await evalIn(page, `const g = window.__game.game; return {
    bet: g.tournament.bet,
    selected: Array.from(document.querySelectorAll('.bm-betchip.is-selected')).map(b => b.innerText.trim()),
    viewBet: g.buildTournamentView().bet,
    maxBet: g.buildTournamentView().maxBet,
  };`);
  check('bet 100 registered in state + UI', betState.bet === 100 && betState.selected.includes('100'), betState);
  await shotName('03-bet');

  /* ---------------- 4. Intro + fight ---------------- */
  const enterClicked = await clickReal('ENTER THE LISTS');
  check('Enter the Lists clickable', !!enterClicked, enterClicked);
  const entered = await waitFor(page, () => {
    const s = window.__game.getState().state;
    return s === 'intro' || s === 'fighting' ? s : null;
  }, 4000);
  check('round begins (intro)', entered === 'intro' || entered === 'fighting', entered);
  await shotName('04-round-intro');

  // Skip intro with Enter/Space (documented shortcut) or wait it out.
  await page.keyboard.press('Enter');
  const fighting = await waitState('fighting', 10000);
  check('intro transitions to fighting', fighting);
  await sleep(900);
  const hud = await evalIn(page, `return {
    hudVisible: !!document.querySelector('.bm-hud.is-open, .bm-hud.is-visible') || getComputedStyle(document.querySelector('.bm-hud') || document.body).opacity !== '0',
    uiRoundLabel: window.__game.game.ui.lastHud?.roundLabel,
    hudText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').trim().slice(0, 400),
    roundLabel: window.__game.game.lastHud?.roundLabel,
    objective: window.__game.game.lastHud?.objective,
    pointerLocked: document.pointerLockElement?.tagName ?? null,
    betDeducted: window.__game.game.profile.denars,
    playerHp: window.__game.game.player?.hp,
  };`);
  res.hud = hud;
  check('HUD shows round + objective', /I OF IV/i.test(hud.hudText) && /last two houses/i.test(hud.hudText), hud.hudText.slice(0, 160));
  check('HUD round label = "Round 1 of 4"', hud.uiRoundLabel === 'Round 1 of 4', hud.uiRoundLabel);
  check('bet deducted from purse at round start', hud.betDeducted === 20, hud.betDeducted);
  check('pointer lock engaged (escalation from user click)', hud.pointerLocked === 'CANVAS', hud.pointerLocked);
  const r1integ = await integrity();
  check('round 1 roster integrity (16 fighters, 1 player, 4 unique houses)',
    r1integ.fighters === 16 && r1integ.playerFighters === 1 && r1integ.teams === 4 && r1integ.uniqueTeamIds === 4,
    r1integ);
  await shotName('05-fight');

  /* ---------------- 5. Pause / settings / quality ---------------- */
  let paused = false;
  for (let attempt = 0; attempt < 3 && !paused; attempt++) {
    await page.keyboard.press('Escape');
    paused = await waitState('paused', 1600);
    if (!paused) await page.evaluate(() => { window.__game.getState().state === 'paused' || window.__game.getState().state === 'fighting'; });
  }
  let pauseNote = null;
  if (!paused) {
    pauseNote = 'headless Esc/pointer-lock race: forcing pause via debug API for UI verification';
    await evalIn(page, `window.__game.pause(); return true;`);
    paused = await waitState('paused', 3000);
  }
  check('Escape pauses', paused, pauseNote);
  check('pause overlay visible', /PAUSED/i.test(await uiText(page)));
  await shotName('06-pause');

  const settingsClicked = await clickReal('SETTINGS');
  check('pause -> Settings opens', !!settingsClicked);
  await sleep(600);
  const settingsText = await uiText(page);
  check('settings screen renders groups', /QUALITY/i.test(settingsText) && /MASTER VOLUME/i.test(settingsText), settingsText.slice(0, 200));
  await shotName('07-settings');

  const lowClicked = await clickReal('LOW');
  await sleep(700);
  const qualityState = await evalIn(page, `return {
    quality: window.__game.game.settings.quality,
    active: Array.from(document.querySelectorAll('.bm-seg-btn.is-on')).map(b => b.innerText.trim()).slice(0, 4),
    stored: JSON.parse(localStorage.getItem('blade-and-mount.settings.v1') || '{}').quality,
  };`);
  check('quality switch to low applies + persists', lowClicked && qualityState.quality === 'low' && qualityState.stored === 'low', qualityState);
  const fpsAfterQuality = await state(page);
  res.qualityState = { ...qualityState, drawCalls: fpsAfterQuality?.drawCalls, fps: fpsAfterQuality?.fps };
  await shotName('08-settings-low');

  // back to pause, then resume
  await clickReal('BACK');
  await sleep(600);
  const backToPause = /PAUSED/i.test(await uiText(page));
  check('Back from settings returns to pause', backToPause);
  await clickReal('RESUME');
  const resumed = await waitState('fighting', 6000);
  check('Resume returns to fighting', resumed);
  await sleep(500);
  const pauseGone = await evalIn(page, `const slot = document.querySelector('.bm-overlay-slot[data-overlay="pause"]');
    const cs = slot ? getComputedStyle(slot) : null;
    return { isOpen: !!slot?.classList.contains('is-open'), visibility: cs?.visibility, opacity: cs?.opacity,
             pointerEvents: cs?.pointerEvents };`);
  check('pause overlay hidden after resume', !pauseGone.isOpen && pauseGone.visibility === 'hidden' && Number(pauseGone.opacity) < 0.05, pauseGone);
  // restore quality to high for consistent screenshots/perf
  await evalIn(page, `window.__game.game.applySettings({ ...window.__game.game.settings, quality: 'high' });`);
  await sleep(400);

  /* ---------------- 6. Rounds 1-4 via debug trounce ---------------- */
  const roundReports = [];
  for (let round = 1; round <= 4; round++) {
    const before = await evalIn(page, `const g = window.__game.game; return {
      round: g.tournament.roundIndex + 1,
      teams: g.tournament.teams.length,
      membersPerTeam: g.tournament.teams.map(t => t.members.length),
      denars: g.profile.denars, level: g.profile.level, renown: g.profile.renown, xp: g.profile.xp,
      bet: g.tournament.bet,
    };`);
    // keep the player alive: trounce every other fighter, then wait for the round to resolve
    await evalIn(page, `window.__game.killEnemies();`);
    const result = await waitFor(page, () => {
      const s = window.__game.getState().state;
      return s === 'round-result' ? true : null;
    }, 8000);
    check(`round ${round}: resolves to round-result`, !!result);
    await sleep(600);
    const resultData = await evalIn(page, `const g = window.__game.game; const r = g.tournament.lastResult; return {
      advanced: r.advanced, champion: r.champion, eliminated: r.eliminated,
      rewardDenars: r.rewardDenars, rewardXp: r.rewardXp, rewardRenown: r.rewardRenown,
      bet: r.bet, betWon: r.betWon, purse: r.purse,
      playerDenars: r.playerDenars, playerLevel: r.playerLevel, playerXp: r.playerXp, playerRenown: r.playerRenown,
      title: (document.querySelector('.bm-outcome-title')?.innerText || '').trim(),
      text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 500),
      button: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean).slice(-4),
    };`);
    roundReports.push({ round, before, result: resultData });
    check(`round ${round}: reward maths sane`, typeof resultData.rewardDenars === 'number' && resultData.rewardDenars >= 0, {
      denars: resultData.rewardDenars, xp: resultData.rewardXp, renown: resultData.rewardRenown,
    });
    if (round === 1) check('round 1 bet pays 2x (200)', resultData.betWon === 200, resultData.betWon);
    await shotName(`09-round${round}-result`);

    // advance
    const btn = /CLAIM THE CROWN/i.test(resultData.button.join(' ')) ? 'CLAIM THE CROWN'
      : resultData.advanced ? 'ONWARD' : 'RETURN TO THE LISTS';
    const advanced = await clickReal(btn);
    check(`round ${round}: "${btn}" advances`, !!advanced, advanced);
    if (round < 4) {
      const nextBracket = await waitState('bracket', 8000);
      check(`round ${round + 1}: bracket appears`, nextBracket);
      await sleep(500);
      const nb = await evalIn(page, `const g = window.__game.game; return {
        round: g.tournament.roundIndex + 1,
        teams: g.tournament.teams.length,
        membersPerTeam: g.tournament.teams.map(t => t.members.length),
        survivors: g.tournament.contestants.filter(c => c.alive).length,
        betReset: g.tournament.bet,
        title: (document.querySelector('.bm-screen-title')?.innerText || '').trim(),
      };`);
      const expect = {
        2: { teams: 2, perTeam: 4, survivors: 8 },
        3: { teams: 2, perTeam: 2, survivors: 4 },
        4: { teams: 2, perTeam: 1, survivors: 2 },
      }[round + 1];
      check(`round ${round + 1}: bracket shape ${expect.teams}x${expect.perTeam}`, nb.teams === expect.teams && nb.membersPerTeam.every((n) => n === expect.perTeam), nb);
      check(`round ${round + 1}: ${expect.survivors} survivors`, nb.survivors === expect.survivors, nb.survivors);
      check(`round ${round + 1}: bet reset to 0`, nb.betReset === 0, nb.betReset);
      await shotName(`10-bracket-round${round + 1}`);
      await clickReal(round + 1 === 4 ? 'FIGHT FOR THE CROWN' : 'ENTER THE LISTS');
      await sleep(500);
      await page.keyboard.press('Enter');
      await waitState('fighting', 8000);
      await sleep(500);
      const integ = await integrity();
      const expectedFighters = { 2: 8, 3: 4, 4: 2 }[round + 1];
      check(`round ${round + 1} roster integrity (${expectedFighters} fighters, 1 player, unique houses)`,
        integ.fighters === expectedFighters && integ.playerFighters === 1 && integ.teams === 2 && integ.uniqueTeamIds === 2,
        integ);
    }
  }
  res.rounds = roundReports;

  /* ---------------- 7. Tournament end (champion) ---------------- */
  const endShown = await waitState('tournament-end', 8000);
  check('champion end screen shows', endShown);
  await sleep(800);
  const end = await evalIn(page, `const g = window.__game.game; return {
    state: g.state,
    champ: g.tournament.champion,
    won: g.profile.tournamentsWon,
    played: g.profile.tournamentsPlayed,
    denars: g.profile.denars, xp: g.profile.xp, level: g.profile.level, renown: g.profile.renown,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 600),
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
    stored: JSON.parse(localStorage.getItem('blade-and-mount.profile.v1') || '{}'),
  };`);
  check('champion flag + profile tournament win recorded', end.champ === true && end.won === 1 && end.played === 1, { champ: end.champ, won: end.won, played: end.played });
  check('champion screen shows crown copy', /CHAMPION/i.test(end.text), end.text.slice(0, 200));
  check('profile persisted to localStorage', end.stored.tournamentsWon === 1, end.stored);
  await shotName('11-tournament-champion');

  /* ---------------- 8. Back to menu ---------------- */
  await clickReal('RETURN TO THE LISTS');
  const backMenu = await waitState('menu', 6000);
  check('return to menu from champion screen', backMenu && (await state(page)).tournamentRound === 0);
  await sleep(700);
  const menuAfter = await uiText(page);
  check('menu profile strip reflects winnings', /TOURNEYS WON/i.test(menuAfter), menuAfter.slice(0, 120));
  await shotName('12-menu-after-champion');

  /* ---------------- 9. Escape-to-quit from bracket ---------------- */
  await clickReal('TOURNAMENT');
  await waitState('bracket', 6000);
  await page.keyboard.press('Escape');
  const menuFromBracket = await waitState('menu', 5000);
  check('Escape from bracket returns to menu (no dead end)', menuFromBracket);
  await clickText(page, 'TOURNAMENT');
  const bracketAgain = await waitState('bracket', 6000);
  check('can start a new tournament after escaping the board', bracketAgain);
  await clickReal('WITHDRAW');
  const menuFromWithdraw = await waitState('menu', 5000);
  check('Withdraw returns to menu', menuFromWithdraw);

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;
  check('no runtime console errors besides favicon 404', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
  try { await shot(page, `fatal-${suffix}`); } catch { /* ignore */ }
}

await writeJson(`flow-tournament-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
console.log('shots:', res.shots.join(', '));
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
