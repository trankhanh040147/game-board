#!/usr/bin/env node
/** Probe known-suspicious flows: Escape in bracket, pause->abandon, replay. */
import { boot, state, sleep, clickText, uiText, shot } from './lib.mjs';

const ctx = await boot({ wait: 3500 });
const { page } = ctx;
const r = {};

const clickReal = async (needle) => {
  const box = await page.evaluate((n) => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.replace(/\s+/g, ' ').includes(n));
    if (!b) return null;
    const rc = b.getBoundingClientRect();
    return { x: rc.x + rc.width / 2, y: rc.y + rc.height / 2 };
  }, needle);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
};

// start tournament (trusted click)
await clickReal('TOURNAMENT');
await sleep(1000);
r.bracketState = await state(page);

// ESC in bracket should return to the menu AND leave the game usable.
await page.keyboard.press('Escape');
await sleep(800);
r.afterEscState = await state(page);
r.afterEscUi = (await uiText(page)).slice(0, 200);
await shot(page, 'probe-03-esc-bracket');

// Now click Tournament in the menu again — this must start a *new* tournament.
const clicked = await clickReal('TOURNAMENT');
r.clickTournamentAgain = clicked;
await sleep(1200);
r.afterMenuTournament = await state(page);
r.afterMenuTournamentUi = (await uiText(page)).slice(0, 300);
await shot(page, 'probe-04-after-esc-start');

// If still broken, try Arena Melee from this state.
const clickedMelee = await clickReal('ARENA MELEE');
r.clickMelee = clickedMelee;
await sleep(1500);
r.afterMelee = await state(page);

console.log(JSON.stringify(r, null, 2));
console.log('errors:', ctx.consoleErrors, ctx.failedRequests);
await ctx.browser.close();
