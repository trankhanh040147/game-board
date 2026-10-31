#!/usr/bin/env node
/** Diagnose duplicate player fighter / duplicate team id in tournament setup. */
import { boot, sleep, evalIn } from './lib.mjs';
import { waitFor } from './lib.mjs';

const ctx = await boot({ width: 1280, height: 720, wait: 3500 });
const { page } = ctx;
const waitState = async (w) => !!(await waitFor(page, (x) => window.__game?.getState?.().state === x, 15000, 150, w));
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
await clickReal('TOURNAMENT');
await waitState('bracket');
await sleep(800);
const t0 = await evalIn(page, `const g = window.__game.game; const t = g.tournament; return {
  teams: t.teams.map(tm => ({ id: tm.id, name: tm.name, isPlayer: tm.isPlayerTeam, members: tm.members.map(m => ({ id: m.id, name: m.name, isPlayer: m.isPlayer, teamId: m.teamId })) })),
  contestantIds: t.contestants.map(c => c.id),
  contestantPlayers: t.contestants.filter(c => c.isPlayer).map(c => ({ id: c.id, name: c.name, alive: c.alive })),
  players: t.contestants.filter(c => c.isPlayer).length,
  seeds: t.seed,
};`);
console.log('BRACKET TEAMS:', JSON.stringify(t0, null, 1));
await clickReal('ENTER THE LISTS');
await sleep(400);
await page.keyboard.press('Enter');
await waitState('fighting');
await sleep(500);
const t1 = await evalIn(page, `const g = window.__game.game; return {
  fighters: g.fighters.map(f => ({ id: f.id, name: f.name, team: f.team, player: f.isPlayer, x: +f.position.x.toFixed(1), z: +f.position.z.toFixed(1) })),
  playerRefId: g.player?.id, playerTeam: g.player?.team,
  teamIds: g.tournament.teams.map(t => t.id),
  fighterCount: g.fighters.length,
};`);
console.log('FIGHTERS:', JSON.stringify(t1, null, 1));
await ctx.browser.close();
