// Final games evidence: desktop + mobile screenshots and one explicit, meaningful
// interaction per game (onboarding start, match start, tournament flow).
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const out = join(here, 'final');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
const report = { generatedAt: new Date().toISOString(), games: [] };

async function newPage() {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  const errors = [], bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) bad.push({ url: r.url(), status: r.status() }); });
  return { ctx, page, errors, bad };
}

// ---- First Hearth: onboarding modal -> "Light the Hearth"
{
  const { ctx, page, errors, bad } = await newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('https://first-hearth.vercel.app', { waitUntil: 'load' });
  await sleep(2500);
  await page.screenshot({ path: join(out, 'game-first-hearth-desktop.png') });
  const before = await page.evaluate(() => ({ onboarding: !!document.querySelector('[class*="onboard"],[class*="tour"],[class*="intro"]'), text: document.body.innerText.slice(0, 120) }));
  // click the primary start button by text
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /light the hearth|begin|enter the valley/i.test(x.textContent || ''));
    if (!b) return null;
    const r = b.getBoundingClientRect(); b.click(); return { text: b.textContent.trim(), w: Math.round(r.width) };
  });
  await sleep(2500);
  const after = await page.evaluate(() => ({ onboarding: !!document.querySelector('[class*="onboard"],[class*="tour"],[class*="intro"]'), body: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 140) }));
  await page.screenshot({ path: join(out, 'game-first-hearth-after-interaction.png') });
  // keyboard: space pause, speed keys, build panel
  await page.keyboard.press('Space'); await sleep(300);
  await page.keyboard.press('KeyB'); await sleep(800);
  const afterKeys = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 140));
  await page.screenshot({ path: join(out, 'game-first-hearth-after-keys.png') });
  // mobile
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('https://first-hearth.vercel.app', { waitUntil: 'load' }); await sleep(2500);
  await page.screenshot({ path: join(out, 'game-first-hearth-mobile.png') });
  const mobile = await page.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  report.games.push({ key: 'first-hearth', clicked, onboardingBefore: before.onboarding, onboardingAfter: after.onboarding, bodyBefore: before.text, bodyAfter: after.body, afterKeys, mobile, errors, bad });
  await ctx.close();
}

// ---- Alien Shooter: title -> "START THE FIGHT" -> HUD visible
{
  const { ctx, page, errors, bad } = await newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('https://alien-shooter-omega.vercel.app', { waitUntil: 'load' });
  await sleep(2000);
  await page.screenshot({ path: join(out, 'game-alien-shooter-desktop.png') });
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /start the fight/i.test(x.textContent || ''));
    if (!b) return null; b.click(); return b.textContent.trim();
  });
  await sleep(1800);
  const hud = await page.evaluate(() => {
    const h = document.querySelector('#hud');
    return { hudExists: !!h, hudHidden: h ? h.classList.contains('hidden') : null, text: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 160) };
  });
  await page.screenshot({ path: join(out, 'game-alien-shooter-after-interaction.png') });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('https://alien-shooter-omega.vercel.app', { waitUntil: 'load' }); await sleep(2000);
  await page.screenshot({ path: join(out, 'game-alien-shooter-mobile.png') });
  const mobile = await page.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, touch: document.querySelectorAll('[class*="touch"],[class*="joystick"],[class*="dash"]').length }));
  report.games.push({ key: 'alien-shooter', clicked, hud, mobile, errors, bad });
  await ctx.close();
}

// ---- Blade & Mount: menu -> Tournament -> Enter the Lists -> choose arms
{
  const { ctx, page, errors, bad } = await newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto('https://blade-and-mount.vercel.app', { waitUntil: 'load' });
  await sleep(3000);
  await page.screenshot({ path: join(out, 'game-blade-and-mount-desktop.png') });
  const steps = [];
  async function clickText(re) {
    const t = await page.evaluate((reSrc) => {
      const rx = new RegExp(reSrc, 'i');
      const b = [...document.querySelectorAll('button')].find((x) => rx.test(x.textContent || ''));
      if (!b) return null; const r = b.getBoundingClientRect(); return { text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 };
    }, re.source);
    if (!t || !t.visible) return null;
    await page.mouse.click(t.x, t.y); await sleep(1800); return t.text;
  }
  steps.push({ label: 'open tournament', clicked: await clickText(/Tournament/) });
  steps.push({ label: 'enter lists', clicked: await clickText(/Enter the Lists|Begin/) });
  steps.push({ label: 'confirm loadout', clicked: await clickText(/Take the Field|Fight|Begin the Bout|Confirm/) });
  await sleep(1500);
  const state = await page.evaluate(() => ({ body: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 200), canvas: !!document.querySelector('canvas') }));
  await page.screenshot({ path: join(out, 'game-blade-and-mount-after-interaction.png') });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto('https://blade-and-mount.vercel.app', { waitUntil: 'load' }); await sleep(3000);
  await page.screenshot({ path: join(out, 'game-blade-and-mount-mobile.png') });
  const mobile = await page.evaluate(() => ({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, touchControls: document.querySelectorAll('[class*="touch"],[class*="joystick"]').length, buttons: [...document.querySelectorAll('button')].length }));
  report.games.push({ key: 'blade-and-mount', steps, state, mobile, errors, bad });
  await ctx.close();
}

await browser.close();
await writeFile(join(here, 'games-final.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify(report, null, 1).slice(0, 4000));
console.log('wrote shots/qa/games-final.json + final/game-*.png');
