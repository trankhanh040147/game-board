#!/usr/bin/env node
/** Diagnose early player damage/death in tournament round 1: who hits the player, from where. */
import { boot, sleep, shot, evalIn, state } from './lib.mjs';
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
await sleep(600);
await clickReal('ENTER THE LISTS');
await sleep(300);
await page.keyboard.press('Enter');
await waitState('fighting');
// hook combat events
await evalIn(page, `const g = window.__game.game; window.__dbg = []; const orig = g.world.emit;
  g.world.emit = (ev) => {
    if (ev.type === 'hit' || ev.type === 'kill' || ev.type === 'block') {
      window.__dbg.push({
        t: +(performance.now()/1000).toFixed(2), type: ev.type,
        a: ev.attacker?.name, aId: ev.attacker?.id, aTeam: ev.attacker?.team, aPlayer: !!ev.attacker?.isPlayer,
        d: ev.defender?.name, dId: ev.defender?.id, dTeam: ev.defender?.team, dPlayer: !!ev.defender?.isPlayer,
        dmg: ev.info ? Math.round(ev.info.damage) : null,
        aDist: ev.attacker && ev.defender ? +ev.attacker.position.distanceTo(ev.defender.position).toFixed(2) : null,
      });
    }
    orig(ev);
  };
  // record spawn layout
  const p = g.player;
  window.__spawns = g.fighters.map(f => ({ name: f.name, team: f.team, x: +f.position.x.toFixed(1), z: +f.position.z.toFixed(1), player: f.isPlayer }));
  return { player: { x: p.position.x, z: p.position.z, team: p.team }, spawns: window.__spawns };`);
const spawnInfo = await evalIn(page, `return { player: { team: window.__game.game.player.team, x: +window.__game.game.player.position.x.toFixed(1), z: +window.__game.game.player.position.z.toFixed(1) }, spawns: window.__spawns };`);
console.log('SPAWNS:', JSON.stringify(spawnInfo, null, 1));
const timeline = [];
for (let i = 0; i < 20; i++) {
  await sleep(300);
  const s = await evalIn(page, `const g = window.__game.game; const p = g.player; const near = g.fighters.filter(f => f.alive && !f.isPlayer)
    .map(f => ({ name: f.name, team: f.team, d: +f.position.distanceTo(p.position).toFixed(2), state: f.state }))
    .sort((a,b)=>a.d-b.d).slice(0,4);
    return { hp: +p.hp.toFixed(1), alive: p.alive, state: p.state, t: +(performance.now()/1000).toFixed(1), near, ev: window.__dbg.slice(-6) };`);
  timeline.push(s);
  if (!s.alive) break;
}
console.log('TIMELINE:', JSON.stringify(timeline, null, 1));
await page.screenshot({ path: 'shots/qa/zoom-05-player-death.png' });
await ctx.browser.close();
