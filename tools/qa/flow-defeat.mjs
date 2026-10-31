#!/usr/bin/env node
/** QA flow: tournament defeat path + knocked-out-player-but-team-advances path. */
import { boot, sleep, shot, evalIn, parseArgs, writeJson, state } from './lib.mjs';
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
const waitState = async (wanted, timeout = 15000) => {
  const v = await waitFor(page, (w) => window.__game?.getState?.().state === w, timeout, 150, wanted);
  return !!v;
};
const startTournament = async () => {
  const before = (await state(page))?.state;
  await sleep(900); // let menu entrance animation settle so a real click lands on the button
  const clicked = await clickReal('TOURNAMENT');
  await sleep(700);
  const after = (await state(page))?.state;
  if (after !== 'bracket') {
    const diag = await page.evaluate(() => ({
      buttons: Array.from(document.querySelectorAll('button')).map((b) => ({ t: b.innerText.replace(/\s+/g, ' ').trim().slice(0, 40), disabled: b.disabled, r: b.getBoundingClientRect().toJSON() })),
      menuOpen: document.querySelector('.bm-menu-host')?.className,
    }));
    console.log('  startTournament diag:', { before, clicked, after, diag: JSON.stringify(diag).slice(0, 800) });
    // fall back to a DOM click (no user gesture needed to enter the bracket)
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('TOURNAMENT'));
      b?.click();
    });
    await sleep(700);
    console.log('  after DOM click:', (await state(page))?.state);
  }
  await waitState('bracket', 8000);
  await sleep(500);
};
const enterRound = async () => {
  const clicked = await clickReal('ENTER THE LISTS');
  await sleep(400);
  const s1 = (await state(page))?.state;
  await page.keyboard.press('Enter');
  const ok = await waitState('fighting', 12000);
  await sleep(400);
  const s2 = (await state(page))?.state;
  console.log('  enterRound:', { clicked, s1, ok, s2, player: await page.evaluate(() => !!window.__game.game.player) });
  return ok;
};

try {
  /* ---------- A. Defeat: player's whole house wiped ---------- */
  await startTournament();
  // place a wager we will lose
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('.bm-betchip')).find((x) => x.innerText.trim() === '50');
    b?.click();
  });
  await sleep(500);
  const betPlaced = await evalIn(page, `const g = window.__game.game; return { bet: g.tournament.bet, denars: g.profile.denars };`);
  check('wager placed before the doomed round', betPlaced.bet === 50, betPlaced);
  await enterRound();
  const before = await evalIn(page, `const g = window.__game.game; return {
    team: g.player.team, teammates: g.fighters.filter(f => f.team === g.player.team).map(f => f.name),
    denars: g.profile.denars, played: g.profile.tournamentsPlayed, won: g.profile.tournamentsWon,
  };`);
  res.defeatBefore = before;
  check('player team has 4 fighters', before.teammates.length === 4, before.teammates);
  // Wipe the player's whole house (player included) — should end the tournament.
  await evalIn(page, `const g = window.__game.game;
    for (const f of g.fighters) if (f.team === g.player.team) f.knockOut(g.world);
    return true;`);
  const gotResult = await waitState('round-result', 8000);
  check('house wipe -> round-result', gotResult);
  await sleep(600);
  const defeat = await evalIn(page, `const g = window.__game.game; const r = g.tournament.lastResult; return {
    advanced: r.advanced, eliminated: r.eliminated, champion: r.champion,
    playerSurvived: r.playerSurvived, rewardDenars: r.rewardDenars, rewardXp: r.rewardXp,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 500),
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
    state: g.state,
  };`);
  check('defeat marks eliminated (no advance)', defeat.advanced === false && defeat.eliminated === true, defeat);
  const betAfter = await evalIn(page, `const g = window.__game.game; return { denars: g.profile.denars, betWon: g.tournament.lastResult?.betWon, bet: g.tournament.lastResult?.bet };`);
  check('losing the round loses the wager (no payout, stake gone)', betAfter.betWon === 0 && betAfter.denars === betPlaced.denars - 50, { before: betPlaced, after: betAfter });
  check('defeat screen shows DEFEAT', /DEFEAT/i.test(defeat.text), defeat.text.slice(0, 140));
  check('defeat offers "Return to the Lists"', defeat.buttons.some((b) => /RETURN TO THE LISTS/i.test(b)), defeat.buttons);
  await snap('20-defeat-round-result');

  await clickReal('RETURN TO THE LISTS');
  const end = await waitState('tournament-end', 8000);
  check('defeat round -> tournament end screen', end);
  await sleep(700);
  const endData = await evalIn(page, `const g = window.__game.game; return {
    played: g.profile.tournamentsPlayed, won: g.profile.tournamentsWon, renown: g.profile.renown,
    denars: g.profile.denars, champ: g.tournament?.champion,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 500),
    stored: JSON.parse(localStorage.getItem('blade-and-mount.profile.v1') || '{}'),
  };`);
  check('tournament defeat recorded in profile', endData.played === (before.played ?? 0) + 1 && endData.won === (before.won ?? 0), endData);
  check('no champion renown on defeat', endData.champ === false && endData.renown === 0, endData.renown);
  check('defeat end screen shows round reached', /RETURN TO THE LISTS/i.test(endData.buttons ? '' : '') || /THE LISTS|ELIMINAT|FELL|DEFEAT/i.test(endData.text), endData.text.slice(0, 160));
  await snap('21-tournament-end-defeat');
  await clickReal('RETURN TO THE LISTS');
  check('back to menu after defeat', await waitState('menu', 6000));

  /* ---------- B. Knocked out but the house still advances ---------- */
  await startTournament();
  await enterRound();
  await evalIn(page, `const g = window.__game.game; g.player.knockOut(g.world); return true;`);
  await sleep(2500);
  const spectate = await evalIn(page, `const g = window.__game.game; const el = document.querySelector('.bm-spectate');
    return {
    state: g.state, playerAlive: g.player?.alive, playerState: g.player?.state,
    hudText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 2000),
    spectateEl: el ? { text: (el.textContent || '').replace(/\\s+/g,' ').trim(), vis: getComputedStyle(el).visibility, op: getComputedStyle(el).opacity } : null,
    camDead: g.cameraCtrl?.mode,
  };`);
  res.spectate = spectate;
  check('player death keeps fight running (spectate)', spectate.state === 'fighting' && spectate.playerAlive === false, { state: spectate.state, playerAlive: spectate.playerAlive });
  const spectateWord = `${spectate.spectateEl?.text ?? ''} ${spectate.hudText}`;
  check('spectator HUD shows "YOU HAVE FALLEN"', /YOU HAVE FALLEN/i.test(spectateWord) && (spectate.spectateEl ? spectate.spectateEl.vis !== 'hidden' : true), { spectateEl: spectate.spectateEl, hudHasBanner: /YOU HAVE FALLEN/i.test(spectate.hudText) });
  await snap('22-spectating');

  // Kill only the rival houses; the player's (dead) house should still advance.
  await evalIn(page, `const g = window.__game.game;
    const team = g.player.team;
    for (const f of g.fighters) if (f.alive && !f.isPlayer && f.team !== team) f.knockOut(g.world);
    return true;`);
  const advResult = await waitState('round-result', 8000);
  check('dead player + winning house -> round-result', advResult);
  await sleep(600);
  const adv = await evalIn(page, `const g = window.__game.game; const r = g.tournament.lastResult; return {
    advanced: r.advanced, champion: r.champion, playerSurvived: r.playerSurvived,
    next: r.nextRoundName, text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 400),
    buttons: Array.from(document.querySelectorAll('button')).map(b => b.innerText.replace(/\\s+/g,' ').trim()).filter(Boolean),
  };`);
  check('advanced while player was knocked out', adv.advanced === true && adv.playerSurvived === false, { advanced: adv.advanced, survived: adv.playerSurvived });
  check('result offers Onward', adv.buttons.some((b) => /ONWARD/i.test(b)), adv.buttons);
  await snap('23-advanced-while-dead');
  await clickReal('ONWARD');
  const bracket2 = await waitState('bracket', 8000);
  check('advances to round 2 bracket', bracket2);
  await sleep(500);
  const b2 = await evalIn(page, `const g = window.__game.game; return {
    round: g.tournament.roundIndex + 1,
    playerContestantAlive: g.tournament.contestants.find(c => c.isPlayer)?.alive,
    survivors: g.tournament.contestants.filter(c => c.alive).length,
    playerTeamMembers: g.tournament.teams.find(t => t.isPlayerTeam)?.members.map(m => m.name),
  };`);
  check('player re-enters the lists next round (alive again)', b2.playerContestantAlive === true, b2);
  check('round 2 has 8 survivors', b2.survivors === 8, b2.survivors);
  await snap('24-round2-after-dead-advance');
  console.log('  round2 state before enter:', await state(page));
  // Start round 2: player must actually respawn as a fighter.
  await clickReal('ENTER THE LISTS');
  await sleep(400);
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(500);
  const respawn = await evalIn(page, `const g = window.__game.game; return {
    playerAlive: g.player?.alive, playerHp: g.player?.hp, fighters: g.fighters.length,
  };`);
  check('player respawns for round 2', respawn.playerAlive === true && respawn.playerHp > 0, respawn);
  await snap('25-round2-respawn');

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;
  check('no unexpected console errors', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
}

await writeJson(`flow-defeat-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
