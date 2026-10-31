#!/usr/bin/env node
/** Zoom into HUD details (combat log marks, top-left counters) for visual defect inspection. */
import { boot, sleep, shot, evalIn } from './lib.mjs';
import { waitFor } from './lib.mjs';

const ctx = await boot({ width: 1920, height: 1080, wait: 3500 });
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
await sleep(400);
await page.keyboard.press('Enter');
await waitState('fighting');
await sleep(2500);
// generate a few log lines
await evalIn(page, `const g = window.__game.game;
  g.ui.pushLog({ text: 'Delivered 27 damage', kind: 'damage' });
  g.ui.pushLog({ text: 'Speed bonus: +14%', kind: 'info' });
  g.ui.pushLog({ text: 'Blocked 19 damage with your shield', kind: 'block' });
  g.ui.pushLog({ text: 'You got 8 experience', kind: 'xp' });
  g.ui.pushLog({ text: 'Regular Fighter knocked unconscious', kind: 'kill' });
  g.ui.pushLog({ text: 'You earned 4 denars', kind: 'reward' });
  return true;`);
await sleep(700);
const log = await page.$('.bm-hud-log');
if (log) await log.screenshot({ path: 'shots/qa/zoom-01-log.png' });
await page.screenshot({ path: 'shots/qa/zoom-02-hud-topleft.png', clip: { x: 0, y: 0, width: 520, height: 200 } });
await page.screenshot({ path: 'shots/qa/zoom-03-hud-vitals.png', clip: { x: 1320, y: 780, width: 600, height: 300 } });
await page.screenshot({ path: 'shots/qa/zoom-04-crosshair.png', clip: { x: 860, y: 440, width: 200, height: 200 } });
console.log('logs', await page.evaluate(() => Array.from(document.querySelectorAll('.bm-logline')).map((n) => ({ text: n.innerText.trim(), markW: n.querySelector('.bm-logline-mark')?.getBoundingClientRect().width, color: getComputedStyle(n.querySelector('.bm-logline-mark')).background }))));
console.log('jump overlay', await page.evaluate(() => ({
  hint: document.querySelector('.bm-hud-hint')?.innerText,
  hintVisible: document.querySelector('.bm-hud-hint')?.classList.contains('is-visible'),
})));
await ctx.browser.close();
