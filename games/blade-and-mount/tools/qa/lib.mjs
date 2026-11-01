#!/usr/bin/env node
/**
 * Shared helpers for Blade & Mount QA scripts (puppeteer-core + system Chrome).
 * QA scope: tools/qa/** — does not touch game source.
 */
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

export const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const DEFAULT_URL = 'http://127.0.0.1:5274/';
export const SHOT_DIR = 'shots/qa';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs() {
  const argv = process.argv.slice(2);
  const arg = (name, fallback = '') => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  return {
    url: arg('url', DEFAULT_URL),
    width: Number(arg('width', '1280')),
    height: Number(arg('height', '720')),
    out: arg('out', ''),
    tag: arg('tag', 'qa'),
  };
}

export async function launch({ width = 1280, height = 720, url = DEFAULT_URL } = {}) {
  const executablePath = CHROME_PATHS.find((p) => fs.existsSync(p));
  if (!executablePath) throw new Error('No Chrome found');
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
      '--autoplay-policy=no-user-gesture-required',
      '--disable-frame-rate-limit',
      '--disable-gpu-vsync',
      `--window-size=${width},${height}`,
    ],
    defaultViewport: { width, height, deviceScaleFactor: 1 },
  });
  const page = await browser.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const failedRequests = [];
  page.on('console', (m) => {
    const t = m.type();
    const text = m.text();
    if (t === 'error') consoleErrors.push(text);
    else if (t === 'warning') consoleWarnings.push(text);
  });
  page.on('pageerror', (e) => consoleErrors.push('PAGEERROR ' + e.message));
  page.on('requestfailed', (r) => {
    const why = r.failure()?.errorText ?? 'failed';
    if (!why.includes('ERR_ABORTED')) failedRequests.push(`${r.url()} :: ${why}`);
  });
  page.on('response', (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.url()} :: HTTP ${r.status()}`);
  });
  return { browser, page, consoleErrors, consoleWarnings, failedRequests, url, width, height };
}

export async function boot({ url = DEFAULT_URL, width = 1280, height = 720, wait = 4500 } = {}) {
  const ctx = await launch({ url, width, height });
  await ctx.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  // wait for the first rendered frame (window.__ready)
  try {
    await ctx.page.waitForFunction('window.__ready === true', { timeout: 60000 });
  } catch {
    /* recorded by caller via ready flag */
  }
  await sleep(wait);
  return ctx;
}

export const state = (page) => page.evaluate(() => window.__game?.getState?.() ?? null);

export const evalIn = (page, code) =>
  page.evaluate((c) => {
    // eslint-disable-next-line no-new-func
    return new Function('return (async () => { ' + c + ' })()')();
  }, code);

export async function shot(page, name, dir = SHOT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${name}.png`);
  await page.screenshot({ path: out });
  return out;
}

export const buttons = (page) =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .filter((b) => b.offsetParent !== null || getComputedStyle(b).position === 'fixed')
      .map((b) => b.innerText.replace(/\s+/g, ' ').trim()),
  );

export async function clickText(page, needle, { exact = false } = {}) {
  return page.evaluate(
    (text, exactMode) => {
      const norm = (s) => s.replace(/\s+/g, ' ').trim().toUpperCase();
      const all = Array.from(document.querySelectorAll('button, [role="button"], .bm-betchip'));
      const btn = all.find((b) => {
        if (b.disabled) return false;
        const t = norm(b.innerText || b.getAttribute('aria-label') || '');
        return exactMode ? t === norm(text) : t.includes(norm(text));
      });
      if (!btn) return false;
      btn.click();
      return norm(btn.innerText || btn.getAttribute('aria-label') || '');
    },
    needle,
    exact,
  );
}

/** Visible text of the whole UI layer, collapsed. */
export const uiText = (page) =>
  page.evaluate(() => (document.getElementById('ui-root')?.innerText ?? '').replace(/\s+/g, ' ').trim());

export const bodyText = (page) =>
  page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim());

export async function waitFor(page, fn, timeout = 8000, step = 150, arg = undefined) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const v = await page.evaluate(fn, arg).catch(() => undefined);
    if (v) return v;
    await sleep(step);
  }
  return null;
}

export async function waitState(page, wanted, timeout = 10000) {
  const v = await waitFor(
    page,
    (w) => window.__game?.getState?.().state === w,
    timeout,
    150,
    wanted,
  ).catch(() => null);
  return !!v;
}

export async function dismissPointerLock(page) {
  // Some flows call requestPointerLock; leaving lock is handled by Escape/blur.
  await page.evaluate(() => {
    if (document.pointerLockElement) document.exitPointerLock();
  });
  await sleep(300);
}

export function writeJson(name, data, dir = SHOT_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, name);
  fs.writeFileSync(out, JSON.stringify(data, null, 2));
  return out;
}

export function section(results, title, data) {
  results.push({ section: title, ...data });
}

export function printSummary(results) {
  for (const r of results) {
    const status = r.pass === false ? 'FAIL' : r.pass === true ? 'PASS' : 'INFO';
    console.log(`[${status}] ${r.section}: ${JSON.stringify(r.summary ?? r)}`);
  }
}
