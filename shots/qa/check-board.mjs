// QA harness for the Game Board (local dev or preview).
// Run: node shots/qa/check-board.mjs [baseUrl] [label]
//   baseUrl default http://127.0.0.1:5199 (dev), label default "dev"
// Outputs shots/qa/board-<label>.json + shots/qa/board-<label>-*.png
import { createRequire } from 'node:module';
import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const base = (process.argv[2] || 'http://127.0.0.1:5199').replace(/\/$/, '');
const shotDir = join(here, 'final');
await mkdir(shotDir, { recursive: true });
const label = process.argv[3] || 'dev';
const ROUTES = [
  { path: '/', name: 'home', expectH1: true },
  { path: '/making-of', name: 'making-of', expectH1: true },
  { path: '/making-of/first-hearth', name: 'exhibit-first-hearth', game: 'first-hearth' },
  { path: '/making-of/blade-and-mount', name: 'exhibit-blade-and-mount', game: 'blade-and-mount' },
  { path: '/making-of/alien-shooter', name: 'exhibit-alien-shooter', game: 'alien-shooter' },
  { path: '/about', name: 'about' },
  { path: '/definitely-not-a-real-page-xyz', name: 'notfound', expected: 'notfound' },
];
const EXPECTED_PLAY = {
  'first-hearth': 'https://first-hearth.vercel.app',
  'blade-and-mount': 'https://blade-and-mount.vercel.app',
  'alien-shooter': 'https://alien-shooter-omega.vercel.app',
};
const VN = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function consoleCollector(page) {
  const c = { errors: [], warnings: [], pageErrors: [], failed: [], bad: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') c.errors.push(m.text());
    else if (m.type() === 'warn' || m.type() === 'warning') c.warnings.push(m.text());
  });
  page.on('pageerror', (e) => c.pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('requestfailed', (r) => c.failed.push({ url: r.url(), err: r.failure() && r.failure().errorText }));
  page.on('response', (r) => { if (r.status() >= 400) c.bad.push({ url: r.url(), status: r.status() }); });
  return c;
}

async function metrics(page) {
  return page.evaluate(() => {
    const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name, type: r.initiatorType, transfer: Math.round(r.transferSize || 0), decoded: Math.round(r.decodedBodySize || 0) }));
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const byType = {};
    for (const r of res) { byType[r.type] = byType[r.type] || { n: 0, transfer: 0 }; byType[r.type].n++; byType[r.type].transfer += r.transfer; }
    return {
      resourceCount: res.length,
      transferTotal: res.reduce((n, r) => n + r.transfer, 0),
      decodedTotal: res.reduce((n, r) => n + r.decoded, 0),
      byType,
      js: res.filter((r) => /script/i.test(r.type) || /\.(m?js)(\?|$)/.test(r.name)).map((r) => ({ name: r.name.split('/').pop(), transfer: r.transfer })),
      domContentLoadedMs: Math.round(nav.domContentLoadedEventEnd || 0),
      loadMs: Math.round(nav.loadEventEnd || 0),
      largestShifts: (() => {
        try {
          const entries = performance.getEntriesByType('layout-shift');
          return entries.reduce((n, e) => n + (e.hadRecentInput ? 0 : e.value), 0);
        } catch { return null; }
      })(),
    };
  });
}

async function inspectPage(page) {
  return page.evaluate(() => {
    const qsa = (s) => [...document.querySelectorAll(s)];
    const links = qsa('a[href]').map((a) => ({
      href: a.getAttribute('href'),
      abs: a.href,
      text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
      ariaLabel: a.getAttribute('aria-label'),
    }));
    const imgs = qsa('img').map((i) => ({
      src: i.getAttribute('src'), alt: i.getAttribute('alt'), w: i.getAttribute('width'), h: i.getAttribute('height'),
      naturalW: i.naturalWidth, naturalH: i.naturalHeight, complete: i.complete,
      cssW: Math.round(i.getBoundingClientRect().width), cssH: Math.round(i.getBoundingClientRect().height),
    }));
    const headings = qsa('h1,h2,h3').map((h) => ({ tag: h.tagName, text: (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 110), id: h.id || null }));
    const body = document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
    return {
      title: document.title,
      lang: document.documentElement.lang,
      metaDescription: (document.querySelector('meta[name="description"]') || {}).content || null,
      metaViewport: (document.querySelector('meta[name="viewport"]') || {}).content || null,
      canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
      ogTitle: (document.querySelector('meta[property="og:title"]') || {}).content || null,
      favicon: (document.querySelector('link[rel~="icon"]') || {}).getAttribute ? (document.querySelector('link[rel~="icon"]') || {}).getAttribute('href') : null,
      headings,
      h1Count: qsa('h1').length,
      links,
      imgs,
      overflow: { innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, overflows: document.documentElement.scrollWidth > window.innerWidth + 1 },
      bodyText: body,
      bodyLen: body.length,
      skipLink: !!document.querySelector('a.skip-link, .skip-link'),
      headerNavLinks: qsa('header a[href]').map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })),
      footerLinks: qsa('footer a[href]').map((a) => ({ href: a.getAttribute('href'), text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60) })),
      tables: qsa('table').map((t) => ({ rows: t.querySelectorAll('tbody tr').length, cols: t.querySelectorAll('thead th').length, caption: (t.querySelector('caption') || {}).textContent || null })),
      buttons: qsa('button').map((b) => ({ text: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50), ariaExpanded: b.getAttribute('aria-expanded'), ariaLabel: b.getAttribute('aria-label'), cls: b.className })),
      reducedMotionQuery: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      animatedCount: qsa('*').filter((el) => {
        const cs = getComputedStyle(el);
        const d = parseFloat(cs.animationDuration) || 0;
        const t = parseFloat(cs.transitionDuration) || 0;
        return d > 0.01 || t > 0.01;
      }).length,
      // numbers-ish strings for spot checks
      numbers: (body.match(/\b\d[\d,.]*(?:[KMB]|\s?(?:h|min|s))?\b/g) || []).slice(0, 120),
    };
  });
}

async function keyboardWalk(page, steps = 10) {
  const seq = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    seq.push(await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return { tag: 'BODY' };
      const cs = getComputedStyle(a);
      const r = a.getBoundingClientRect();
      return {
        tag: a.tagName, text: (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 50), href: a.getAttribute ? a.getAttribute('href') : null,
        focusVisible: a.matches(':focus-visible'), outline: `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}`, visible: r.width > 0 && r.height > 0,
      };
    }));
  }
  return seq;
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
const report = { generatedAt: new Date().toISOString(), base, label, routes: [] };

for (const route of ROUTES) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const c = consoleCollector(page);
  const results = { ...route, desktop: {}, mobile: {}, nav: {}, console: {} };
  try {
    const t0 = Date.now();
    const resp = await page.goto(base + route.path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
    // let SPA router render + fonts settle
    await page.waitForFunction(() => (document.querySelector('main') || {}).children && document.querySelector('main').children.length > 0, { timeout: 15000 }).catch(() => {});
    await sleep(900);
    // trigger lazy-loaded images and reveal animations by walking the page
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 120)); }
      window.scrollTo(0, 0);
    });
    await sleep(900);
    await page.evaluate(async () => {
      await Promise.all([...document.images].filter((i) => !i.complete).map((i) => new Promise((res) => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); setTimeout(res, 4000); })));
    });
    results.routerMs = Date.now() - t0;
    results.desktop.httpStatus = resp ? resp.status() : null;
    results.desktop.url = page.url();
    results.desktop.info = await inspectPage(page);
    results.desktop.metrics = await metrics(page);
    await page.screenshot({ path: join(shotDir, `${route.name}-1440.png`), fullPage: false });

    // expand every collapsible so the full published text can be audited
    try {
      await page.evaluate(async () => {
        for (const d of document.querySelectorAll('details')) d.open = true;
        for (const b of document.querySelectorAll('button')) {
          if (/read the full prompt|show more|expand|read more/i.test(b.textContent || '')) { b.click(); await new Promise((r) => setTimeout(r, 30)); }
        }
      });
      await sleep(600);
      results.desktop.expandedText = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());
    } catch (e) { results.desktop.expandedTextError = e.message; }

    // keyboard walk on home/about only (representative)
    if (route.name === 'home' || route.name === 'about') {
      await page.evaluate(() => window.scrollTo(0, 0));
      results.nav.keyboard = await keyboardWalk(page, 12);
      results.nav.firstFocusScreenshot = join(shotDir, `${route.name}-focus.png`);
      await page.screenshot({ path: results.nav.firstFocusScreenshot });
      await page.keyboard.press('Escape').catch(() => {});
    }

    // external play link audit on home + exhibits
    const playLinks = results.desktop.info.links.filter((l) => /vercel\.app/.test(l.href || ''));
    results.nav.playLinks = playLinks;
    const expectedUrl = route.game ? EXPECTED_PLAY[route.game] : null;
    results.nav.expectedPlay = expectedUrl || null;
    if (expectedUrl) {
      results.nav.playLinkCorrect = playLinks.some((l) => (l.href || '').replace(/\/$/, '') === expectedUrl && l.target === '_blank');
    }

    // mobile
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await page.goto(base + route.path, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => (document.querySelector('main') || {}).children && document.querySelector('main').children.length > 0, { timeout: 15000 }).catch(() => {});
    await sleep(700);
    await page.evaluate(async () => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let y = 0; y < document.body.scrollHeight; y += step) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 100)); }
      window.scrollTo(0, 0);
    });
    await sleep(800);
    results.mobile.info = await inspectPage(page);
    results.mobile.metrics = await metrics(page);
    await page.screenshot({ path: join(shotDir, `${route.name}-390.png`), fullPage: false });

    // mobile menu: find toggle button
    const toggle = await page.evaluate(() => {
      const cands = [...document.querySelectorAll('button')];
      const b = cands.find((x) => /menu/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.className || '') + ' ' + (x.textContent || '')));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { ariaExpanded: b.getAttribute('aria-expanded'), ariaLabel: b.getAttribute('aria-label'), cls: String(b.className), x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
    });
    results.mobile.menuToggle = toggle;
    if (toggle && toggle.visible) {
      await page.mouse.click(toggle.x, toggle.y);
      await sleep(700);
      results.mobile.afterMenuClick = await page.evaluate(() => {
        const b = [...document.querySelectorAll('button')].find((x) => /menu/i.test((x.getAttribute('aria-label') || '') + ' ' + (x.className || '')));
        const header = document.querySelector('header') || document.body;
        const visibleAnchors = [...header.querySelectorAll('a')].filter((a) => {
          const r = a.getBoundingClientRect(); const cs = getComputedStyle(a);
          return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
        }).map((a) => ({ href: a.getAttribute('href'), text: a.textContent.replace(/\s+/g, ' ').trim(), visible: true }));
        return {
          ariaExpanded: b ? b.getAttribute('aria-expanded') : null,
          headerVisibleLinks: visibleAnchors,
          headerText: (header.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        };
      });
      await page.screenshot({ path: join(shotDir, `${route.name}-390-menu-open.png`), fullPage: false });
    }

    // reduced motion pass (home only)
    if (route.name === 'home') {
      await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      await page.setViewport({ width: 1440, height: 900 });
      await page.goto(base + route.path, { waitUntil: 'domcontentloaded' });
      await sleep(1500);
      results.desktop.reducedMotion = await page.evaluate(() => {
        const els = [...document.querySelectorAll('*')];
        const anim = els.filter((el) => {
          const cs = getComputedStyle(el);
          return (parseFloat(cs.animationDuration) || 0) > 0.01;
        }).map((el) => ({ cls: String(el.className).slice(0, 60), dur: getComputedStyle(el).animationDuration, name: getComputedStyle(el).animationName }));
        const hiddenReveals = [...document.querySelectorAll('.reveal,[data-reveal],.story-section,.section')].filter((el) => parseFloat(getComputedStyle(el).opacity) < 0.5).length;
        return { mediaMatches: matchMedia('(prefers-reduced-motion: reduce)').matches, animatedElements: anim.length, sample: anim.slice(0, 5), hiddenReveals, bodyOpacity: getComputedStyle(document.body).opacity };
      });
      await page.screenshot({ path: join(shotDir, `home-reduced-motion.png`) });
      await page.emulateMediaFeatures([]);
    }
  } catch (e) {
    results.fatal = String(e && e.stack ? e.stack : e);
  }
  results.console = {
    errors: c.errors, warnings: c.warnings, pageErrors: c.pageErrors,
    failedRequests: c.failed, badResponses: c.bad,
  };
  // internal link resolution (result only; verify in a second pass below)
  results.desktop.info && (results.desktop.info.absoluteInternalLinks = [...new Set(results.desktop.info.links.map((l) => l.abs).filter((u) => u && u.startsWith(base)))]);

  // Vietnamese leak scan
  results.desktop.info && (results.desktop.info.vietnameseChars = (results.desktop.info.bodyText.match(VN) ? results.desktop.info.bodyText.match(VN).slice(0, 10) : []));
  results.mobile.info && (results.mobile.info.vietnameseChars = (results.mobile.info.bodyText.match(VN) ? results.mobile.info.bodyText.match(VN).slice(0, 10) : []));

  report.routes.push(results);
  console.log(`[${route.name}] ${base}${route.path} status=${results.desktop.httpStatus} title=${JSON.stringify(results.desktop.info && results.desktop.info.title)} h1=${results.desktop.info && results.desktop.info.h1Count} overflow390=${results.mobile.info && results.mobile.info.overflow.overflows} errs=${results.console.errors.length} bad=${results.console.badResponses.length} transfer=${results.desktop.metrics && results.desktop.metrics.transferTotal}`);
  await page.close();
}

// second pass: verify every internal link resolves (HTTP + renders an h1)
const allInternal = [...new Set(report.routes.flatMap((r) => (r.desktop.info ? r.desktop.info.absoluteInternalLinks : [])))]
  .filter((u) => { try { return !(u.includes('#') && u.split('#')[0] === base + new URL(u).pathname.replace(/\/$/, '') && report.routes.some((r) => r.desktop.url === u.split('#')[0])); } catch { return true; } });
const linkCheck = await browser.newPage();
const broken = [];
for (const rawUrl of allInternal) {
  const url = rawUrl.replace(/#.*$/, '');
  try {
    const resp = await linkCheck.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await sleep(500);
    const info = await linkCheck.evaluate(() => ({ h1: document.querySelectorAll('h1').length, bodyLen: (document.body.innerText || '').trim().length, title: document.title }));
    if (!resp || resp.status() >= 400 || info.bodyLen < 40) broken.push({ url, status: resp ? resp.status() : null, ...info });
  } catch (e) { broken.push({ url, error: e.message }); }
}
await linkCheck.close();
report.internalLinkAudit = { checked: allInternal.length, broken };

await browser.close();
await writeFile(join(here, `board-${label}.json`), JSON.stringify(report, null, 1));
console.log(`\nwrote shots/qa/board-${label}.json | internal links checked: ${allInternal.length}, broken: ${broken.length}`);
