// Cold-load measurement for the three deployed games: cache disabled, one fresh
// browser context per game. Reports TTFB / FCP / load, transfer by type,
// JS bytes, and console/network problems at 1440x900 and 390x844.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAMES = [
  { key: 'first-hearth', url: 'https://first-hearth.vercel.app' },
  { key: 'blade-and-mount', url: 'https://blade-and-mount.vercel.app' },
  { key: 'alien-shooter', url: 'https://alien-shooter-omega.vercel.app' },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
const out = { generatedAt: new Date().toISOString(), games: [] };

for (const g of GAMES) {
  for (const vp of [{ name: 'desktop', width: 1440, height: 900, isMobile: false }, { name: 'mobile', width: 390, height: 844, isMobile: true }]) {
    const context = await browser.createBrowserContext(); // fresh cache
    const page = await context.newPage();
    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.isMobile ? 2 : 1, isMobile: vp.isMobile, hasTouch: vp.isMobile });
    const cdp = await page.createCDPSession();
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    const errors = [], warnings = [], failed = [], bad = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); else if (m.type() === 'warn' || m.type() === 'warning') warnings.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    page.on('requestfailed', (r) => failed.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
    page.on('response', (r) => { if (r.status() >= 400) bad.push({ url: r.url(), status: r.status() }); });
    const t0 = Date.now();
    let status = null;
    try { const resp = await page.goto(g.url, { waitUntil: 'load', timeout: 60000 }); status = resp.status(); } catch (e) { errors.push('nav: ' + e.message); }
    const ttLoad = Date.now() - t0;
    await sleep(2500);
    const perf = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] || {};
      const paints = performance.getEntriesByType('paint').map((p) => ({ name: p.name, at: Math.round(p.startTime) }));
      const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name, type: r.initiatorType, transfer: Math.round(r.transferSize || 0), decoded: Math.round(r.decodedBodySize || 0), dur: Math.round(r.duration || 0) }));
      const byType = {};
      for (const r of res) { const k = r.type || 'other'; byType[k] = byType[k] || { n: 0, transfer: 0, decoded: 0 }; byType[k].n++; byType[k].transfer += r.transfer; byType[k].decoded += r.decoded; }
      const js = res.filter((r) => /script|\.js(\?|$)/i.test(r.type + r.name)).reduce((n, r) => n + r.transfer, 0);
      const fcp = (paints.find((p) => p.name === 'first-contentful-paint') || {}).at ?? null;
      return {
        ttfb: Math.round(nav.responseStart || 0), domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
        fcp, paints, transferTotal: res.reduce((n, r) => n + r.transfer, 0), decodedTotal: res.reduce((n, r) => n + r.decoded, 0),
        jsTransfer: js, resources: res.length, byType,
      };
    });
    const title = await page.title();
    const meta = await page.evaluate(() => ({
      desc: (document.querySelector('meta[name="description"]') || {}).content || null,
      viewport: (document.querySelector('meta[name="viewport"]') || {}).content || null,
      favicon: (document.querySelector('link[rel~="icon"]') || {}).getAttribute ? (document.querySelector('link[rel~="icon"]') || {}).getAttribute('href') : null,
      lang: document.documentElement.lang || null,
      h1: [...document.querySelectorAll('h1')].map((e) => e.textContent.trim()),
      canvas: !!document.querySelector('canvas'),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      bodyText: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    }));
    out.games.push({ key: g.key, url: g.url, viewport: vp.name, status, ttLoad, title, meta, perf, errors, warnings, failed, bad });
    console.log(`${g.key} ${vp.name}: status=${status} ttfb=${perf.ttfb}ms fcp=${perf.fcp}ms load=${perf.load}ms weight=${(perf.transferTotal / 1024).toFixed(0)}KB js=${(perf.jsTransfer / 1024).toFixed(0)}KB errs=${errors.length} bad=${bad.length} overflow=${meta.overflow} innerW=${meta.innerWidth}`);
    await context.close();
  }
}
await browser.close();
await writeFile(join(here, 'games-coldload.json'), JSON.stringify(out, null, 1));
console.log('wrote shots/qa/games-coldload.json');
