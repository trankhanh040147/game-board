#!/usr/bin/env node
/**
 * Headless screenshot tool for visual verification.
 * Usage:
 *   node tools/shot.mjs --url http://127.0.0.1:5273 --out shots/game.png --wait 6000
 *   node tools/shot.mjs --url ... --out ... --width 1920 --height 1080 --eval "window.__game?.debug?.startTournament()"
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
function arg(name, fallback = '') {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const url = arg('url', 'http://127.0.0.1:5273');
const out = arg('out', 'shots/game.png');
const wait = Number(arg('wait', '5000'));
const width = Number(arg('width', '1280'));
const height = Number(arg('height', '720'));
const evalScript = arg('eval', '');
const settle = Number(arg('settle', '1200'));
const fullPage = argv.includes('--full');

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
  defaultViewport: { width, height, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  const type = msg.type();
  if (type === 'error' || type === 'warning') {
    const text = msg.text();
    if (!text.includes('GPU stall') && !text.includes('WebGL')) errors.push(`[${type}] ${text}`);
  }
});
page.on('pageerror', (err) => errors.push(`[pageerror] ${err.message}`));
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await new Promise((r) => setTimeout(r, wait));
if (evalScript) {
  try {
    const result = await page.evaluate((code) => {
      // eslint-disable-next-line no-new-func
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
const ready = await page.evaluate(() => Boolean(window.__ready));
console.log(JSON.stringify({ out, ready, errors }, null, 2));
await browser.close();
if (errors.length) process.exitCode = 0;
