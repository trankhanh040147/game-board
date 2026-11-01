// Cold per-route measurement for the board: fresh browser context + cache
// disabled, real PerformanceObserver for CLS/LCP. Run against local preview or
// production. Usage: node shots/qa/check-board-cold.mjs <baseUrl> <label>
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const base = (process.argv[2] || 'http://127.0.0.1:5202').replace(/\/$/, '');
const label = process.argv[3] || 'cold';
const ROUTES = ['/', '/making-of', '/making-of/first-hearth', '/making-of/blade-and-mount', '/making-of/alien-shooter', '/about', '/nope-404'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
const out = { generatedAt: new Date().toISOString(), base, label, routes: [] };

for (const route of ROUTES) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const errors = [], bad = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) bad.push({ url: r.url(), status: r.status() }); });
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument(() => {
    window.__qa = { cls: 0, lcp: null, fcp: null };
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__qa.cls += e.value;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        const es = list.getEntries(); const last = es[es.length - 1];
        if (last) window.__qa.lcp = Math.round(last.startTime);
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) if (e.name === 'first-contentful-paint') window.__qa.fcp = Math.round(e.startTime);
      }).observe({ type: 'paint', buffered: true });
    } catch {}
  });
  const cdp = await page.createCDPSession();
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const t0 = Date.now();
  let status = null;
  try { const r = await page.goto(base + route, { waitUntil: 'load', timeout: 60000 }); status = r.status(); } catch (e) { errors.push('nav: ' + e.message); }
  await sleep(2500);
  const m = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource').map((r) => ({ n: r.name, type: r.initiatorType, transfer: Math.round(r.transferSize || 0), decoded: Math.round(r.decodedBodySize || 0) }));
    const byType = {};
    for (const r of res) { const k = r.type || 'other'; byType[k] = byType[k] || { n: 0, transfer: 0 }; byType[k].n++; byType[k].transfer += r.transfer; }
    return {
      ttfb: Math.round(nav.responseStart || 0), dcl: Math.round(nav.domContentLoadedEventEnd || 0), load: Math.round(nav.loadEventEnd || 0),
      fcp: window.__qa.fcp, lcp: window.__qa.lcp, cls: Number(window.__qa.cls.toFixed(4)),
      transferTotal: res.reduce((n, r) => n + r.transfer, 0), decodedTotal: res.reduce((n, r) => n + r.decoded, 0),
      resourceCount: res.length, byType, title: document.title,
      innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth,
      h1: [...document.querySelectorAll('h1')].map((e) => e.textContent.trim()),
    };
  });
  out.routes.push({ route, status, ttLoad: Date.now() - t0, ...m, errors, bad });
  console.log(`${route.padEnd(32)} status=${status} ttfb=${m.ttfb} fcp=${m.fcp} lcp=${m.lcp} cls=${m.cls} weight=${(m.transferTotal / 1024).toFixed(0)}KB res=${m.resourceCount} errs=${errors.length} bad=${bad.length}`);
  await context.close();
}
await browser.close();
await writeFile(join(here, `board-cold-${label}.json`), JSON.stringify(out, null, 1));
console.log(`wrote shots/qa/board-cold-${label}.json`);
