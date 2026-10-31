#!/usr/bin/env node
/**
 * FIRST HEARTH — full browser QA matrix (puppeteer-core + system Chrome).
 *
 * Boots the dev server app at 1600x900 and 1280x800, checks console/page errors,
 * screenshots the map, every rail panel, overlays, the decisions modal and the
 * minimap, then measures FPS at 4x with 100+ population, save/load/export/import
 * round-trips and heap growth over 2000 ticks.
 *
 * Usage:
 *   node tools/browser-qa.mjs                     # uses http://127.0.0.1:5280
 *   node tools/browser-qa.mjs --url http://127.0.0.1:5280 --out-dir shots
 *
 * Exit code 0 = no console/page errors and no failed functional checks.
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const arg = (name, fallback = '') => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = arg('url', 'http://127.0.0.1:5280');
const outDir = arg('out-dir', 'shots');
const W = 1600;
const H = 900;

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
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: true,
  executablePath,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', `--window-size=${W},${H}`],
});

const report = { url, generatedAt: new Date().toISOString(), consoleErrors: [], pageErrors: [], checks: [], shots: [], perf: {}, functional: {} };
const errors = [];

function check(name, ok, detail = '') {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function newPage(width, height) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error' || type === 'warning') {
      if (/GPU stall|WebGL|Download the React|Autofill/i.test(text)) return;
      if (type === 'error') {
        report.consoleErrors.push(text);
        errors.push(`[console] ${text}`);
      }
    }
  });
  page.on('pageerror', (err) => {
    report.pageErrors.push(err.message);
    errors.push(`[pageerror] ${err.message}`);
  });
  return page;
}

async function screenshot(page, name) {
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  report.shots.push(file);
  return file;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  try {
    await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 45000 });
    check(`${label}: app boots (__FIRST_HEARTH__.ready)`, true);
  } catch {
    const boot = await page.evaluate(() => document.getElementById('boot-screen')?.innerText ?? '').catch(() => '');
    check(`${label}: app boots (__FIRST_HEARTH__.ready)`, false, boot.replace(/\s+/g, ' ').slice(0, 200));
  }
  await wait(1500);
  // The onboarding overlay blocks all interaction on first boot: dismiss it.
  const welcome = await page.evaluate(() => {
    const btn = document.querySelector('.fh-welcome [data-act="begin"]');
    if (!btn) return false;
    btn.click();
    return true;
  });
  if (welcome) {
    check(`${label}: welcome overlay dismisses`, true);
    await wait(700);
  }
}

// ---------------------------------------------------------------------------
// Desktop 1600x900
// ---------------------------------------------------------------------------
const page = await newPage(W, H);
await boot(page, '1600x900');

const info0 = await page.evaluate(() => {
  const g = window.__game;
  if (!g) return null;
  return { tick: g.state.tick, seed: g.state.seed, pop: g.state.settlements.reduce((a, s) => a + s.population, 0), contentErrors: g.contentErrors?.length ?? 0, canvas: !!document.querySelector('canvas'), fps: Math.round(g.fps) };
});
check('1600x900: window.__game exposed', !!info0);
check('1600x900: content validation clean in app', !!info0 && info0.contentErrors === 0, `contentErrors=${info0?.contentErrors}`);
check('1600x900: canvas rendered', !!info0?.canvas);
await screenshot(page, 'qa-map-1600x900');

// Panels (keyboard shortcuts from ui/index RAIL).
const panels = [
  ['t', 'codex'],
  ['s', 'society'],
  ['m', 'market'],
  ['p', 'people'],
  ['c', 'almanac'],
  ['d', 'diplomacy'],
  ['e', 'expeditions'],
  ['w', 'wonders'],
  ['o', 'objectives'],
];
for (const [key, id] of panels) {
  await page.keyboard.press(key);
  await wait(450);
  const visible = await page.evaluate(() => {
    const panel = document.querySelector('.fh-game-panel');
    if (!panel) return null;
    const r = panel.getBoundingClientRect();
    return { cls: panel.className, w: Math.round(r.width), h: Math.round(r.height), title: panel.querySelector('h2,h3,.fh-panel-title')?.textContent?.trim() ?? '' };
  });
  check(`panel ${id}: opens`, !!visible, visible ? `${visible.w}x${visible.h} "${visible.title}"` : 'no .fh-game-panel');
  await screenshot(page, `qa-panel-${id}-1600x900`);
  await page.keyboard.press('Escape');
  await wait(250);
}
const panelClosed = await page.evaluate(() => !document.querySelector('.fh-game-panel'));
check('panel: Escape closes', panelClosed);

// Overlays.
const overlays = ['fertility', 'forest', 'water', 'pollution', 'beauty', 'deposits', 'roads', 'population'];
for (const overlay of overlays) {
  const ok = await page.evaluate((mode) => {
    const g = window.__game;
    if (!g?.renderer) return false;
    g.renderer.setOverlay(mode);
    return true;
  }, overlay);
  await wait(350);
  if (overlay === 'fertility' || overlay === 'deposits') await screenshot(page, `qa-overlay-${overlay}-1600x900`);
  check(`overlay ${overlay}: renders`, ok);
}
await page.evaluate(() => window.__game.renderer.setOverlay('none'));

// Minimap.
const minimap = await page.evaluate(() => {
  const el = document.querySelector('.fh-minimap');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
check('minimap: present and sized', !!minimap && minimap.w > 60, JSON.stringify(minimap));
await screenshot(page, 'qa-minimap-1600x900');

// Decisions modal: inject a real pending decision from content and open it.
const decision = await page.evaluate(() => {
  const g = window.__game;
  const ev = Object.values(g.content.events).find((e) => e.choices && e.choices.length >= 2 && e.condition);
  if (!ev) return null;
  const pending = {
    id: g.state.events.nextDecisionId++,
    eventId: ev.id,
    title: ev.title,
    text: ev.text,
    choices: ev.choices,
    createdTick: g.state.tick,
    severity: ev.severity ?? 1,
    category: ev.category ?? 'society',
    icon: ev.icon ?? 'event',
    causes: ev.causeHints ?? [],
  };
  g.state.events.pending.push(pending);
  g.emit('decision');
  g.refreshUI();
  return { title: ev.title, choices: ev.choices.length };
});
await wait(650);
const modalOpen = await page.evaluate(() => {
  const m = document.querySelector('.fh-modal-backdrop');
  if (!m) return null;
  const r = m.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
check('decisions modal: opens with choices', !!modalOpen, decision ? `"${decision.title}" choices=${decision.choices}` : 'no event with choices');
await screenshot(page, 'qa-decision-modal-1600x900');
if (modalOpen) {
  await page.evaluate(() => document.querySelector('[data-modal-close]')?.click());
  await wait(300);
}
// Clear the injected pending decision so it does not stall later measurements.
await page.evaluate(() => {
  const g = window.__game;
  g.state.events.pending.length = 0;
  g.refreshUI();
});

// Save / load / export / import.
const io = await page.evaluate(() => {
  const g = window.__game;
  for (let i = 0; i < 5; i++) g.tickOnce(); // make the state non-trivial
  const tick = g.state.tick;
  const saved = g.save();
  const json = g.exportSave();
  for (let i = 0; i < 5; i++) g.tickOnce();
  const tickAfter = g.state.tick;
  const loaded = g.load();
  const tickRestored = g.state.tick;
  const imported = (() => {
    try {
      g.importSave(json);
      return true;
    } catch {
      return false;
    }
  })();
  return { tick, tickAfter, tickRestored, saved, loaded, imported, jsonLen: json.length, hasLocalStorage: !!localStorage.getItem('first-hearth.save.v1') };
});
check('save: writes a save', !!io?.saved);
check('load: restores tick position', !!io && io.tickRestored === io.tick, `tick ${io?.tick} -> saved; after 5 ticks ${io?.tickAfter}; reloaded ${io?.tickRestored}`);
check('export/import: JSON round-trips', !!io?.imported, `json ${io?.jsonLen} chars`);
check('save: localStorage entry exists', !!io?.hasLocalStorage);

// Performance: 4x speed with 100+ population.
const perf = await page.evaluate(async () => {
  const g = window.__game;
  const cap = g.state.settlements[0];
  // Inject population as LOD cohorts (the sim folds large populations this way).
  g.state.cohorts.push({ id: 900000, settlementId: cap.id, profession: 'laborer', ageBand: 'adult', count: 140, health: 82, morale: 70, education: 30 });
  for (let i = 0; i < 10; i++) g.tickOnce(); // let systems pick them up
  const pop = g.state.cohorts.reduce((a, c) => a + c.count, 0) + g.state.citizens.filter((c) => c.alive).length;
  g.setSpeed(4);
  const t0 = performance.now();
  for (let i = 0; i < 60; i++) g.tickOnce(); // headless tick throughput
  const msPerTick = (performance.now() - t0) / 60;
  await new Promise((r) => setTimeout(r, 2500)); // let rAF run at 4x
  return { pop, fps: Math.round(g.fps), msPerTick: Math.round(msPerTick * 100) / 100, speed: g.speed };
});
check('perf: 100+ population injected', perf.pop >= 100, `pop=${perf.pop}`);
check('perf: 4x fps >= 30', perf.fps >= 30, `fps=${perf.fps} speed=${perf.speed}`);
check('perf: headless tick < 25ms', perf.msPerTick < 25, `${perf.msPerTick}ms/tick`);
await screenshot(page, 'qa-4x-100pop-1600x900');
report.perf['1600x900'] = perf;

// Heap growth over 2000 ticks.
const heap = await page.evaluate(() => {
  const g = window.__game;
  const before = performance.memory ? performance.memory.usedJSHeapSize : 0;
  for (let i = 0; i < 2000; i++) g.tickOnce();
  const after = performance.memory ? performance.memory.usedJSHeapSize : 0;
  return { before, after, deltaMB: Math.round(((after - before) / 1048576) * 10) / 10, notes: g.state.notifications.length, citizens: g.state.citizens.filter((c) => c.alive).length };
});
check('memory: 2000 ticks do not blow up (< 80MB growth)', heap.deltaMB < 80, `${heap.deltaMB}MB delta, notifications=${heap.notes}, citizens=${heap.citizens}`);
report.perf.heap = heap;

// Layout overflow at 1600x900.
const overflow1600 = await page.evaluate(() => {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bad = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > vw + 2 || r.left < -2) bad.push(`${el.className || el.tagName}: x=${Math.round(r.left)}..${Math.round(r.right)}`);
    if (bad.length > 8) break;
  }
  return { scrollW: document.documentElement.scrollWidth, innerW: vw, scrollH: document.documentElement.scrollHeight, innerH: vh, bad };
});
check('1600x900: no horizontal overflow', overflow1600.scrollW <= overflow1600.innerW + 2, `scrollW=${overflow1600.scrollW} innerW=${overflow1600.innerW} bad=${overflow1600.bad.slice(0, 3).join(' | ')}`);

// ---------------------------------------------------------------------------
// Laptop 1280x800
// ---------------------------------------------------------------------------
const page2 = await newPage(1280, 800);
await boot(page2, '1280x800');
await screenshot(page2, 'qa-map-1280x800');
await page2.keyboard.press('c');
await wait(450);
await screenshot(page2, 'qa-panel-almanac-1280x800');
await page2.keyboard.press('Escape');
await wait(250);
await page2.keyboard.press('m');
await wait(450);
await screenshot(page2, 'qa-panel-market-1280x800');
await page2.keyboard.press('Escape');
await wait(250);

const overflow1280 = await page2.evaluate(() => {
  const vw = window.innerWidth;
  const bad = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    if (r.right > vw + 2 || r.left < -2) bad.push(`${String(el.className).slice(0, 30)}: x=${Math.round(r.left)}..${Math.round(r.right)}`);
    if (bad.length > 8) break;
  }
  return { scrollW: document.documentElement.scrollWidth, innerW: vw, scrollH: document.documentElement.scrollHeight, innerH: window.innerHeight, bad };
});
check('1280x800: no horizontal overflow', overflow1280.scrollW <= overflow1280.innerW + 2, `scrollW=${overflow1280.scrollW} innerW=${overflow1280.innerW} bad=${overflow1280.bad.slice(0, 3).join(' | ')}`);
check('1280x800: no vertical overflow (shell fits)', overflow1280.scrollH <= overflow1280.innerH + 4, `scrollH=${overflow1280.scrollH} innerH=${overflow1280.innerH}`);

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
report.consoleErrors = [...new Set(report.consoleErrors)];
report.pageErrors = [...new Set(report.pageErrors)];
check('console/page errors == 0', errors.length === 0, errors.slice(0, 6).join(' | '));

const jsonPath = path.join(outDir, 'qa-browser-report.json');
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
const failed = report.checks.filter((c) => !c.ok);
console.log(`\nchecks: ${report.checks.length - failed.length}/${report.checks.length} passed, ${failed.length} failed`);
console.log(`console errors: ${report.consoleErrors.length}, page errors: ${report.pageErrors.length}`);
console.log(`report: ${jsonPath}`);
console.log(`screenshots: ${report.shots.length} in ${outDir}`);
await browser.close();
process.exit(failed.length || errors.length ? 1 : 0);
