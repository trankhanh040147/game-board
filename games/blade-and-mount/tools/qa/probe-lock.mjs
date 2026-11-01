#!/usr/bin/env node
/** Probe pointer lock + basic flow in headless Chrome. */
import { boot, state, sleep, clickText, uiText, shot, evalIn } from './lib.mjs';

const ctx = await boot({ wait: 4000 });
const { page } = ctx;

// menu
console.log('state:', await state(page));

// real mouse click on Tournament menu button (trusted user gesture)
const btnBox = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => x.innerText.includes('TOURNAMENT'));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
console.log('tournament button box:', btnBox);
if (btnBox) await page.mouse.click(btnBox.x, btnBox.y);
await sleep(1200);
console.log('after menu click:', await state(page));

// click Enter the Lists with real mouse
const enterBox = await page.evaluate(() => {
  const b = Array.from(document.querySelectorAll('button')).find((x) => /Enter the Lists/i.test(x.innerText));
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: b.innerText };
});
console.log('enter button:', enterBox);
if (enterBox) await page.mouse.click(enterBox.x, enterBox.y);
await sleep(800);
console.log('state after enter:', await state(page));
console.log('pointerLock:', await page.evaluate(() => ({
  el: document.pointerLockElement?.tagName ?? null,
  locked: window.__game?.game?.input?.locked,
})));
await shot(page, 'probe-01-intro');

// wait intro end
await sleep(4200);
console.log('state after intro:', await state(page));
console.log('lock now:', await page.evaluate(() => ({ el: document.pointerLockElement?.tagName ?? null, locked: window.__game?.game?.input?.locked })));

// simulate mouse look
await page.mouse.move(800, 360);
await sleep(200);
console.log('camera yaw/mouse:', await page.evaluate(() => ({
  camYaw: window.__game.game.playerCtrl.camera?.yaw,
  dbg: window.__game.getState(),
})));

await shot(page, 'probe-02-fight');
console.log('errors:', ctx.consoleErrors, ctx.failedRequests);
await ctx.browser.close();
