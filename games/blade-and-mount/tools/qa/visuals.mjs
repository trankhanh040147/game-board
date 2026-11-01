#!/usr/bin/env node
/**
 * QA visual pass: walk every major screen at a given resolution, screenshot each,
 * and record viewport overflow / clipping metrics + UI text snippets.
 * Usage: node tools/qa/visuals.mjs --width 1920 --height 1080
 */
import { boot, sleep, shot, evalIn, parseArgs, writeJson, uiText, state } from './lib.mjs';
import { waitFor } from './lib.mjs';

const args = parseArgs();
const W = args.width, H = args.height;
const suffix = `${W}x${H}`;
const res = { resolution: `${W}x${H}`, screens: [], checks: [], shots: [] };
const check = (name, pass, detail) => {
  res.checks.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
};

const ctx = await boot({ url: args.url, width: W, height: H, wait: 3800 });
const { page } = ctx;
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

const metrics = async (name) => {
  const m = await evalIn(page, `const vw = window.innerWidth, vh = window.innerHeight;
    const overflow = [];
    for (const node of document.querySelectorAll('#ui-root *')) {
      const cs = getComputedStyle(node);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) continue;
      if (node.tagName === 'CANVAS' || node.id === 'ui-root') continue;
      const r = node.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      if (r.right > vw + 1 || r.bottom > vh + 1 || r.left < -1 || r.top < -1) {
        overflow.push({ tag: node.tagName, cls: node.className?.toString().slice(0, 60), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left), top: Math.round(r.top) });
      }
    }
    return {
      vw, vh,
      docScrollW: document.documentElement.scrollWidth, docScrollH: document.documentElement.scrollHeight,
      bodyScrollW: document.body.scrollWidth, bodyScrollH: document.body.scrollHeight,
      overflow: overflow.slice(0, 12), overflowCount: overflow.length,
      uiOpen: document.body.classList.contains('ui-open'),
      text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 240),
    };`);
  res.screens.push({ name, ...m });
  const path = await shot(page, `v${suffix}-${name}`);
  res.shots.push(path);
  return m;
};

try {
  /* menu */
  await metrics('01-menu');
  /* controls from menu */
  await clickReal('CONTROLS');
  await sleep(700);
  await metrics('02-controls');
  await clickReal('BACK');
  await sleep(500);
  /* settings from menu */
  await clickReal('SETTINGS');
  await sleep(700);
  await metrics('03-settings');
  await clickReal('BACK');
  await sleep(500);
  /* credits */
  await clickReal('CREDITS');
  await sleep(700);
  await metrics('04-credits');
  await clickReal('BACK');
  await sleep(500);

  /* bracket */
  await clickReal('TOURNAMENT');
  await waitState('bracket', 8000);
  await sleep(900);
  await metrics('05-bracket');
  /* bet selected */
  await evalIn(page, `const b = Array.from(document.querySelectorAll('.bm-betchip')).find(x => x.innerText.trim() === '50'); b?.click(); return true;`);
  await sleep(500);
  await metrics('06-bracket-bet');

  /* intro */
  await clickReal('ENTER THE LISTS');
  await sleep(900);
  await metrics('07-round-intro');
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(1400);
  await metrics('08-fight-hud');
  await sleep(1600);
  await metrics('09-fight-action');

  /* pause */
  await page.keyboard.press('Escape');
  await waitState('paused', 6000);
  await sleep(700);
  await metrics('10-pause');
  await clickReal('SETTINGS');
  await sleep(600);
  await metrics('11-pause-settings');
  await clickReal('BACK');
  await sleep(400);
  await clickReal('CONTROLS');
  await sleep(600);
  await metrics('12-pause-controls');
  await clickReal('BACK');
  await sleep(400);
  await clickReal('RESUME');
  await waitState('fighting', 6000);
  await sleep(800);

  /* round result (win) + tournament end via defeat */
  await evalIn(page, `window.__game.killEnemies();`);
  await waitState('round-result', 8000);
  await sleep(900);
  await metrics('13-round-result-win');
  await clickReal('ONWARD');
  await waitState('bracket', 8000);
  await sleep(700);
  await metrics('14-bracket-round2');
  await clickReal('ENTER THE LISTS');
  await sleep(400);
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(600);
  /* wipe player's house for the defeat/end screens */
  await evalIn(page, `const g = window.__game.game; for (const f of g.fighters) if (f.team === g.player.team) f.knockOut(g.world); return true;`);
  await waitState('round-result', 8000);
  await sleep(800);
  await metrics('15-round-result-defeat');
  await clickReal('RETURN TO THE LISTS');
  await waitState('tournament-end', 8000);
  await sleep(900);
  await metrics('16-tournament-end-defeat');
  await clickReal('RETURN TO THE LISTS');
  await waitState('menu', 8000);
  await sleep(900);

  /* melee */
  await clickReal('ARENA MELEE');
  await sleep(400);
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(2200);
  await metrics('17-melee-hud');
  await evalIn(page, `const g = window.__game.game; g.player.knockOut(g.world); return true;`);
  await waitState('melee-result', 8000);
  await sleep(900);
  await metrics('18-melee-result');
  await clickReal('LEAVE THE ARENA');
  await waitState('menu', 8000);

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;

  /* overflow assertions */
  for (const s of res.screens) {
    const noDocScroll = s.docScrollW <= s.vw + 1 && s.docScrollH <= s.vh + 1;
    const noOverflow = s.overflowCount === 0;
    check(`viewport fits without scrolling: ${s.name}`, noDocScroll && noOverflow, {
      scroll: [s.docScrollW, s.docScrollH], viewport: [s.vw, s.vh], overflow: s.overflowCount, examples: s.overflow.slice(0, 3),
    });
  }
  check('no unexpected console errors across screens', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
  try { await shot(page, `fatal-visual-${suffix}`); } catch { /* ignore */ }
}

await writeJson(`visuals-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
console.log('shots:', res.shots.length ? res.shots.join(', ') : '(none)');
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
