// QA harness: verify the three deployed games in a real Chrome.
// Run: node shots/qa/check-games.mjs
// Outputs: shots/qa/games-report.json + shots/qa/game-*.png
import { createRequire } from 'node:module';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GAMES = [
  { key: 'first-hearth', url: 'https://first-hearth.vercel.app', kind: 'canvas2d' },
  { key: 'blade-and-mount', url: 'https://blade-and-mount.vercel.app', kind: 'webgl' },
  { key: 'alien-shooter', url: 'https://alien-shooter-omega.vercel.app', kind: 'canvas2d' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function canvasSig(page) {
  return page.evaluate(() => {
    const c = document.querySelector('canvas');
    if (!c) return { hasCanvas: false };
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const out = { hasCanvas: true, w: c.width, h: c.height, cssW: c.clientWidth, cssH: c.clientHeight };
    try {
      const tmp = document.createElement('canvas');
      tmp.width = 64; tmp.height = 64;
      const ctx = tmp.getContext('2d');
      ctx.drawImage(c, 0, 0, 64, 64);
      const d = ctx.getImageData(0, 0, 64, 64).data;
      let sum = 0, lit = 0;
      for (let i = 0; i < d.length; i += 4) { const v = d[i] + d[i + 1] + d[i + 2]; sum += v; if (v > 24) lit++; }
      out.pixelSum = sum;
      out.litPixels = lit;
      out.sig = (sum % 1e9) + ':' + lit;
    } catch (e) { out.readError = String(e && e.message ? e.message : e); }
    out.hasGL = !!gl;
    return out;
  });
}

async function runGame(browser, g) {
  const result = { ...g, desktop: {}, mobile: {}, interactions: [], issues: [] };
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  const consoleErrors = [], consoleWarnings = [], pageErrors = [], failedRequests = [], responses = [];
  page.on('console', (m) => {
    const t = m.type(); const text = m.text();
    if (t === 'error') consoleErrors.push(text);
    else if (t === 'warning' || t === 'warn') consoleWarnings.push(text);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
  page.on('response', async (r) => {
    try {
      const req = r.request();
      const h = r.headers();
      const len = Number(h['content-length'] || 0);
      responses.push({ url: r.url(), status: r.status(), type: req.resourceType(), enc: h['content-encoding'] || '', len });
    } catch { /* ignore */ }
  });

  let resp = null;
  const t0 = Date.now();
  try {
    resp = await page.goto(g.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  } catch (e) {
    result.issues.push(`navigation failed: ${e.message}`);
  }
  const ttDom = Date.now() - t0;
  // wait for load event and a little settle
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
  const ttLoad = Date.now() - t0;

  // wait for canvas to appear
  await page.waitForSelector('canvas', { timeout: 15000 }).catch(() => {});
  const canvasAppearedMs = Date.now() - t0;

  // poll for first non-blank canvas frame (webgl needs a few frames)
  let firstFrameMs = null, lastSig = null, sigChanges = 0;
  const pollStart = Date.now();
  while (Date.now() - pollStart < 12000) {
    const s = await canvasSig(page);
    if (s.hasCanvas && (s.litPixels || 0) > 40) {
      if (firstFrameMs === null) firstFrameMs = Date.now() - t0;
      if (lastSig !== null && s.sig !== lastSig) sigChanges++;
      lastSig = s.sig;
      if (sigChanges >= 2) break; // canvas is alive
    }
    await sleep(80);
  }
  result.desktop.firstFrameMs = firstFrameMs;
  result.desktop.canvasAppearedMs = canvasAppearedMs;
  result.desktop.ttDomContentLoadedMs = ttDom;
  result.desktop.ttLoadMs = ttLoad;
  result.desktop.canvas = await canvasSig(page);

  // page metadata
  result.desktop.meta = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const desc = q('meta[name="description"]');
    const vp = q('meta[name="viewport"]');
    const icon = q('link[rel~="icon"]');
    return {
      title: document.title,
      lang: document.documentElement.lang || null,
      metaDescription: desc ? desc.content : null,
      viewport: vp ? vp.content : null,
      favicon: icon ? icon.getAttribute('href') : null,
      h1: [...document.querySelectorAll('h1')].map((e) => e.textContent.trim()),
      bodyText: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600) : '',
      canvasBg: (() => { const c = q('canvas'); return c ? getComputedStyle(c).backgroundColor : null; })(),
      buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).slice(0, 10),
    };
  });

  // resource weight
  result.desktop.resources = await page.evaluate(() => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const res = performance.getEntriesByType('resource').map((r) => ({
      name: r.name, type: r.initiatorType, transfer: Math.round(r.transferSize || 0), decoded: Math.round(r.decodedBodySize || 0),
    }));
    const byType = {};
    for (const r of res) {
      const k = r.type || 'other';
      byType[k] = byType[k] || { n: 0, transfer: 0, decoded: 0 };
      byType[k].n++; byType[k].transfer += r.transfer; byType[k].decoded += r.decoded;
    }
    return {
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      loadEvent: Math.round(nav.loadEventEnd || 0),
      transferTotal: res.reduce((n, r) => n + r.transfer, 0),
      decodedTotal: res.reduce((n, r) => n + r.decoded, 0),
      byType,
      resourceCount: res.length,
      js: res.filter((r) => /script/i.test(r.type) || /\.js($|\?)/.test(r.name)).map((r) => ({ name: r.name.split('/').pop(), transfer: r.transfer, decoded: r.decoded })),
    };
  });

  await page.screenshot({ path: join(here, `game-${g.key}-desktop.png`) });

  // ---- interaction 1: mouse move + click on canvas centre
  try {
    const box = await page.evaluate(() => {
      const c = document.querySelector('canvas');
      if (!c) return null;
      const r = c.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
    });
    if (box) {
      const before = await canvasSig(page);
      await page.mouse.move(box.x - 120, box.y - 60, { steps: 8 });
      await page.mouse.move(box.x, box.y, { steps: 8 });
      await page.mouse.click(box.x, box.y);
      await sleep(1200);
      const afterClick = await canvasSig(page);
      // keyboard
      await page.keyboard.down('KeyW'); await sleep(300); await page.keyboard.up('KeyW');
      await page.keyboard.press('Space'); await sleep(400);
      await page.keyboard.press('Enter'); await sleep(600);
      const afterKeys = await canvasSig(page);
      result.interactions.push({
        label: 'canvas click + WASD + Space/Enter',
        box,
        canvasChangedOnClick: before.sig !== afterClick.sig,
        canvasChangedOnKeys: afterClick.sig !== afterKeys.sig,
        before: before.sig, afterClick: afterClick.sig, afterKeys: afterKeys.sig,
        newPageErrors: pageErrors.length,
      });
      await page.screenshot({ path: join(here, `game-${g.key}-after-interaction.png`) });
    } else {
      result.issues.push('no canvas found for interaction test');
    }
  } catch (e) {
    result.issues.push(`interaction error: ${e.message}`);
  }

  // ---- interaction 2: try an onboarding button if present (first-hearth has one)
  try {
    const btn = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /begin|start|play|continue|enter|skip/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: b.textContent.trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
    });
    if (btn && btn.visible && btn.x >= 0 && btn.y >= 0) {
      await page.mouse.click(btn.x, btn.y);
      await sleep(1500);
      result.interactions.push({ label: `button "${btn.text}"`, clicked: true, canvas: await canvasSig(page), newPageErrors: pageErrors.length });
    }
  } catch (e) { /* optional */ }

  result.desktop.consoleErrors = consoleErrors;
  result.desktop.consoleWarnings = consoleWarnings;
  result.desktop.pageErrors = pageErrors;
  result.desktop.failedRequests = failedRequests;
  result.desktop.httpStatus = resp ? resp.status() : null;
  result.desktop.responses = responses.filter((r) => r.status >= 400 || r.status === 0);
  result.desktop.responseCount = responses.length;

  // ---- mobile
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await page.goto(g.url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch((e) => result.issues.push(`mobile nav: ${e.message}`));
  await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
  await sleep(2500);
  result.mobile = await page.evaluate(() => {
    const c = document.querySelector('canvas');
    return {
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      canvas: c ? { cssW: c.clientWidth, cssH: c.clientHeight, w: c.width, h: c.height } : null,
      touchControls: document.querySelectorAll('[class*="touch"],[class*="joystick"],[class*="control"]').length,
      bodyText: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 300) : '',
    };
  });
  result.mobile.consoleErrors = consoleErrors.slice(result.desktop.consoleErrors.length);
  // touch interaction attempt
  try {
    const b = await page.evaluate(() => { const c = document.querySelector('canvas'); if (!c) return null; const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    if (b) { await page.touchscreen.tap(b.x, b.y); await sleep(900); }
  } catch { /* ignore */ }
  await page.screenshot({ path: join(here, `game-${g.key}-mobile.png`) });

  // favicon check
  try {
    const fav = result.desktop.meta.favicon;
    if (fav) {
      const u = new URL(fav, g.url).href;
      const r = await page.evaluate(async (url) => { try { const x = await fetch(url); return x.status; } catch { return 'ERR'; } }, u);
      result.desktop.faviconStatus = r;
    }
  } catch { /* ignore */ }

  await page.close();
  return result;
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--hide-scrollbars', '--mute-audio', '--no-first-run', '--disable-gpu-sandbox'],
});
await mkdir(here, { recursive: true });

const results = [];
for (const g of GAMES) {
  process.stderr.write(`\n=== ${g.key} (${g.url}) ===\n`);
  try {
    const r = await runGame(browser, g);
    results.push(r);
    process.stderr.write(
      `status=${r.desktop.httpStatus} title=${JSON.stringify(r.desktop.meta.title)} ` +
      `firstFrame=${r.desktop.firstFrameMs}ms load=${r.desktop.ttLoadMs}ms ` +
      `errs=${r.desktop.consoleErrors.length} pageErrs=${r.desktop.pageErrors.length} failedReq=${r.desktop.failedRequests.length} ` +
      `http4xx=${r.desktop.responses.length} js=${JSON.stringify(r.desktop.byType || (r.desktop.resources && r.desktop.resources.byType))}\n`,
    );
  } catch (e) {
    results.push({ ...g, fatal: String(e && e.stack ? e.stack : e) });
    process.stderr.write(`FATAL ${e.message}\n`);
  }
}
await browser.close();

const out = { generatedAt: new Date().toISOString(), chrome: CHROME, results };
await writeFile(join(here, 'games-report.json'), JSON.stringify(out, null, 1));
console.log('wrote', join(here, 'games-report.json'));
