#!/usr/bin/env node
/**
 * Headless screenshot + smoke-test tool.
 * Usage:
 *   node tools/shot.mjs --url http://127.0.0.1:5280 --out shots/game.png --wait 5000
 *   node tools/shot.mjs --url ... --eval "window.__game.setSpeed(3)" --settle 4000
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const url = arg('url', 'http://127.0.0.1:5280');
const out = arg('out', 'shots/game.png');
const wait = Number(arg('wait', '5500'));
const width = Number(arg('width', '1600'));
const height = Number(arg('height', '900'));
const evalScript = arg('eval', '');
const settle = Number(arg('settle', '1500'));
const fullPage = argv.includes('--full');
const scale = Number(arg('scale', '1'));

const chromePaths = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const executablePath = chromePaths.find((p) => fs.existsSync(p));
if (!executablePath) {
  console.error('No Chrome/Chromium executable found.');
  process.exit(1);
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-webgl',
    '--ignore-gpu-blocklist',
    '--enable-unsafe-swiftshader',
    '--use-angle=metal',
    '--window-size=' + width + ',' + height,
  ],
  defaultViewport: { width, height, deviceScaleFactor: scale },
});
const page = await browser.newPage();
const errors = [];
const logs = [];
page.on('console', (msg) => {
  const type = msg.type();
  const text = msg.text();
  logs.push(`[${type}] ${text}`);
  if (type === 'error' || type === 'warning') {
    if (!text.includes('GPU stall') && !text.includes('WebGL') && !text.includes('Download the React')) errors.push(`[${type}] ${text}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 30000 });
  } catch {
    errors.push('[boot] window.__FIRST_HEARTH__.ready never became true');
    const boot = await page.evaluate(() => document.getElementById('boot-screen')?.innerText ?? '').catch(() => '');
    if (boot) errors.push('[boot-text] ' + boot.replace(/\s+/g, ' ').slice(0, 300));
  }
  await new Promise((r) => setTimeout(r, wait));
  if (evalScript) {
    try {
      const result = await page.evaluate((code) => {
        return new Function('return (async () => { ' + code + ' })()')();
      }, evalScript);
      if (result !== undefined) console.log('eval:', JSON.stringify(result));
    } catch (e) {
      errors.push('[eval] ' + e.message);
    }
    await new Promise((r) => setTimeout(r, settle));
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage });
  console.log(`saved ${out}`);
  const info = await page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    const c = g.state;
    return {
      seed: c.seed,
      tick: c.tick,
      date: c.tick,
      pop: c.settlements.reduce((a, s) => a + s.population, 0),
      buildings: c.buildings.length,
      fps: Math.round(g.fps),
      contentErrors: g.contentErrors?.length ?? 0,
      tab: g.view.overlay,
    };
  }).catch(() => null);
  if (info) console.log('state:', JSON.stringify(info));
} catch (err) {
  errors.push('[fatal] ' + err.message);
}
console.log('--- console errors ---');
for (const e of errors) console.log(e);
if (!errors.length) console.log('(none)');
if (argv.includes('--logs')) {
  console.log('--- logs ---');
  for (const l of logs.slice(-80)) console.log(l);
}
await browser.close();
process.exit(errors.length ? 1 : 0);
