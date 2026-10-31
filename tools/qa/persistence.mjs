#!/usr/bin/env node
/** QA: profile + settings persistence across reload, corrupted storage resilience, quality switching. */
import { boot, sleep, shot, evalIn, parseArgs, writeJson, state, uiText } from './lib.mjs';
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

try {
  /* ---------- A. Fresh profile defaults ---------- */
  const fresh = await evalIn(page, `const g = window.__game.game; return {
    profile: g.profile, stored: localStorage.getItem('blade-and-mount.profile.v1'),
    settings: g.settings, storedSettings: localStorage.getItem('blade-and-mount.settings.v1'),
    menuText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 260),
  };`);
  res.fresh = fresh;
  check('fresh profile defaults (120 denars, level 1, no wins)', fresh.profile.denars === 120 && fresh.profile.level === 1 && fresh.profile.tournamentsWon === 0, fresh.profile);
  check('default quality is high', fresh.settings.quality === 'high', fresh.settings.quality);

  /* ---------- B. Win a tournament round, then reload mid-tournament ---------- */
  await clickReal('TOURNAMENT');
  await waitState('bracket', 8000);
  await sleep(500);
  await clickReal('ENTER THE LISTS');
  await sleep(400);
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(500);
  await evalIn(page, `window.__game.killEnemies();`);
  await waitState('round-result', 8000);
  await sleep(500);
  const earned = await evalIn(page, `const g = window.__game.game; return {
    denars: g.profile.denars, xp: g.profile.xp, level: g.profile.level, renown: g.profile.renown,
    stored: JSON.parse(localStorage.getItem('blade-and-mount.profile.v1') || '{}'),
    state: g.state,
  };`);
  res.earned = earned;
  check('round win persisted to localStorage immediately', earned.stored.denars === earned.denars && earned.denars > 120, earned);

  // Reload — tournament should reset but profile must survive.
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
  await sleep(3200);
  const afterReload = await evalIn(page, `const g = window.__game.game; return {
    state: g.state, denars: g.profile.denars, xp: g.profile.xp, level: g.profile.level, renown: g.profile.renown,
    won: g.profile.tournamentsWon, played: g.profile.tournamentsPlayed,
    menuText: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 300),
  };`);
  res.afterReload = afterReload;
  check('reload returns to menu', afterReload.state === 'menu', afterReload.state);
  check('profile denars/XP survive reload', afterReload.denars === earned.denars && afterReload.xp === earned.xp, { before: earned, after: afterReload });
  check('menu profile strip reflects persisted denars', new RegExp(String(afterReload.denars)).test(afterReload.menuText), afterReload.menuText.slice(0, 160));
  await snap('40-menu-after-reload');

  /* ---------- C. Settings persist across reload + quality switch ---------- */
  // open settings from menu, change quality to LOW, sensitivity slider, language
  await clickReal('SETTINGS');
  await sleep(700);
  const settingsShot = await uiText(page);
  check('settings opens from main menu', /QUALITY/i.test(settingsShot), settingsShot.slice(0, 120));
  await clickReal('LOW');
  await sleep(300);
  const lowDraw = await state(page);
  await clickReal('MEDIUM');
  await sleep(500);
  const medDraw = await state(page);
  await clickReal('HIGH');
  await sleep(500);
  const highDraw = await state(page);
  // language toggle: find the "ENGLISH" segmented option and click it
  const lang = await evalIn(page, `const segs = Array.from(document.querySelectorAll('.bm-seg-btn')).map(b => ({ t: b.innerText.trim(), on: b.classList.contains('is-on') })); return segs;`);
  res.qualitySwitches = { low: lowDraw, medium: medDraw, high: highDraw };
  check('quality low/medium/high switch without errors', [lowDraw, medDraw, highDraw].every((s) => s && s.state === 'menu'), {
    low: lowDraw?.state, medium: medDraw?.state, high: highDraw?.state,
  });
  check('quality switch changes draw calls at runtime', lowDraw && medDraw && highDraw && (lowDraw.drawCalls !== highDraw.drawCalls || lowDraw.triangles !== highDraw.triangles), {
    low: { calls: lowDraw?.drawCalls, tris: lowDraw?.triangles },
    med: { calls: medDraw?.drawCalls, tris: medDraw?.triangles },
    high: { calls: highDraw?.drawCalls, tris: highDraw?.triangles },
  });
  // change sensitivity via range input if present, else programmatically through the UI handler path
  const sliders = await page.$$eval('input[type="range"]', (ns) => ns.map((n) => ({ min: n.min, max: n.max, value: n.value, label: n.getAttribute('aria-label') })));
  res.sliders = sliders;
  if (sliders.length) {
    await page.evaluate(() => {
      const input = document.querySelector('input[type="range"]');
      input.value = String(Number(input.max) * 0.8);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(400);
  }
  await clickReal('LOW');
  await sleep(500);
  const beforeReloadSettings = await evalIn(page, `const g = window.__game.game; return {
    settings: g.settings, stored: JSON.parse(localStorage.getItem('blade-and-mount.settings.v1') || '{}'),
  };`);
  res.beforeReloadSettings = beforeReloadSettings;
  check('settings saved to localStorage', beforeReloadSettings.stored.quality === beforeReloadSettings.settings.quality, beforeReloadSettings);
  await snap('41-settings-menu');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
  await sleep(3200);
  const afterSettings = await evalIn(page, `const g = window.__game.game; return {
    settings: g.settings,
    rendererQuality: g.engine.quality ?? null,
    booted: g.state,
    errors: [],
  };`);
  res.afterSettings = afterSettings;
  check('settings quality survives reload', afterSettings.settings.quality === beforeReloadSettings.settings.quality, afterSettings.settings.quality);
  check('game boots after reload with persisted quality', afterSettings.booted === 'menu', afterSettings.booted);
  await snap('42-menu-after-settings-reload');


  /* ---------- C2. Vietnamese language toggle + persistence ---------- */
  await clickReal('SETTINGS');
  await sleep(700);
  const langClicked = await clickReal('TIẾNG VIỆT');
  await sleep(700);
  const vi = await evalIn(page, `const g = window.__game.game; return {
    lang: g.settings.language, stored: JSON.parse(localStorage.getItem('blade-and-mount.settings.v1') || '{}').language,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 260),
  };`);
  check('VI language toggle switches + persists', langClicked && vi.lang === 'vi' && vi.stored === 'vi', { clicked: langClicked, lang: vi.lang, stored: vi.stored });
  check('VI copy is actually rendered (Cài Đặt)', /CÀI ĐẶT|Cài Đặt/i.test(vi.text), vi.text.slice(0, 160));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
  await sleep(3200);
  const viReload = await evalIn(page, `const g = window.__game.game; return {
    lang: g.settings.language,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 260),
  };`);
  check('VI language survives reload and menu is translated', viReload.lang === 'vi' && /Giải Đấu/i.test(viReload.text), viReload);
  await snap('44-menu-vi');
  // restore English
  await clickReal('SETTINGS');
  await sleep(600);
  await clickReal('ENGLISH');
  await sleep(500);
  const en = await evalIn(page, `const g = window.__game.game; return { lang: g.settings.language };`);
  check('language can be switched back to English', en.lang === 'en', en);
  await clickReal('BACK');
  await sleep(400);

  /* ---------- D. Corrupted localStorage resilience ---------- */
  await page.evaluate(() => {
    localStorage.setItem('blade-and-mount.profile.v1', '{not json!!');
    localStorage.setItem('blade-and-mount.settings.v1', '{"quality":"ultra","language":"xx"}');
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction('window.__ready === true', { timeout: 60000 }).catch(() => {});
  await sleep(3000);
  const corrupt = await evalIn(page, `const g = window.__game.game; return {
    state: g.state, denars: g.profile.denars, level: g.profile.level,
    quality: g.settings.quality, language: g.settings.language,
    text: (document.getElementById('ui-root')?.innerText ?? '').replace(/\\s+/g,' ').slice(0, 160),
  };`);
  res.corrupt = corrupt;
  check('corrupted profile JSON falls back to defaults without crashing', corrupt.state === 'menu' && corrupt.denars === 120, corrupt);
  check('invalid persisted quality falls back to high', corrupt.quality === 'high', corrupt.quality);
  check('invalid language falls back to en', corrupt.language === 'en', corrupt.language);
  await snap('43-menu-corrupt-storage');

  res.errors = ctx.consoleErrors;
  res.failedRequests = ctx.failedRequests;
  check('no unexpected console errors across reloads', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
}

await writeJson(`persistence-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
