#!/usr/bin/env node
/**
 * FIRST HEARTH — autosave hitch probe.
 *
 * Measures the synchronous cost of saveToStorage() (serializeState + localStorage
 * setItem) and checks whether the 30-day autosave produces a long task / frame
 * hitch at speed 4 with a mid-game settlement.
 *
 * Usage: node tools/profile-autosave.mjs [dpr=1] [speed=4] [durationMs=4000]
 */
import puppeteer from 'puppeteer-core';

const dpr = Number(process.argv[2] ?? 1);
const speed = Number(process.argv[3] ?? 4);
const durationMs = Number(process.argv[4] ?? 4000);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: dpr });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await page.goto('http://127.0.0.1:5280/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 45000 });
await new Promise((r) => setTimeout(r, 1000));

const setup = await page.evaluate(() => {
  const click = (sel) => document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  click('[data-act="begin"]');
  const g = window.__game;
  g.pause();
  const s = g.state, c = g.content, cap = s.settlements[0];
  s.flags.auto_research = 1; s.research.era = 2;
  for (const id of c.techOrder) { const t = c.techs[id]; if (t && t.era <= 2) s.research.completed[id] = s.tick; }
  s.research.insight = 500;
  for (const k of ['wood', 'stone', 'clay', 'fiber', 'plank', 'brick', 'iron', 'tools', 'grain', 'berries', 'water']) if (c.resources[k]) cap.stock[k] = (cap.stock[k] ?? 0) + 300;
  cap.treasury = 2000;
  const types = ['lean_to', 'hut', 'hut', 'hut', 'foragers_camp', 'woodcutter_camp', 'stone_pit', 'well', 'granary', 'farm', 'farm', 'sawmill', 'smithy', 'market', 'carpenter_shop', 'mill', 'bakery', 'temple', 'school', 'clinic', 'well', 'hut', 'hut', 'farm'];
  let n = 0;
  for (const t of types) {
    for (let r = 0; r < 10; r++) {
      const x = cap.x + ((n % 7) - 3) + (r % 3), y = cap.y + Math.floor(n / 7) - 2 + Math.floor(r / 3);
      if (g.placeBuilding(t, x, y).ok) break;
    }
    n++;
  }
  s.cohorts.push({ id: 900001, settlementId: cap.id, profession: 'laborer', ageBand: 'adult', count: 120, health: 82, morale: 70, education: 30 });
  for (let k = 0; k < 20; k++) {
    g.advanceDays(10);
    for (let i = 0; i < 10; i++) {
      const p = s.events.pending;
      if (!p.length) break;
      const ch = p[0].choices;
      const pick = ch.find((x) => !x.cost || Object.keys(x.cost).length === 0) ?? ch[0];
      const res = g.resolveDecision(p[0].id, pick?.id ?? '__none');
      if (!res.ok) g.resolveDecision(p[0].id, '__none');
    }
  }
  s.events.pending = [];
  s.events.warnings = [];
  document.querySelectorAll('.fh-welcome,.fh-modal-backdrop,.fh-modal').forEach((e) => { if (e instanceof HTMLElement) e.style.display = 'none'; });
  return { tick: s.tick, pop: s.citizens.filter((x) => x.alive).length + s.cohorts.reduce((a, x) => a + x.count, 0), buildings: s.buildings.length };
});

// Instrument: localStorage writes + tick timings + long tasks + explicit save timing.
const probes = await page.evaluate(() => {
  const g = window.__game;
  window.__as = { writes: [], ticking: false, tickMs: [], saves: [] };
  const origSet = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, value) {
    const t0 = performance.now();
    const r = origSet.call(this, key, value);
    window.__as.writes.push({ key: String(key), len: String(value).length, ms: Math.round((performance.now() - t0) * 100) / 100 });
    return r;
  };
  const origTick = g.tickOnce.bind(g);
  g.tickOnce = () => {
    const t0 = performance.now();
    origTick();
    window.__as.tickMs.push(performance.now() - t0);
  };
  // Explicit probes: serialize-only (exportSave) vs serialize + localStorage (save).
  const tSer = performance.now();
  const json = g.exportSave();
  const serializeMs = performance.now() - tSer;
  const t0 = performance.now();
  g.save('probe-save');
  const explicitMs = performance.now() - t0;
  // Force the next tick to cross the 30-day autosave boundary.
  g.lastAutosaveDay = g.state.tick - 30;
  window.__as.explicitSaveMs = Math.round(explicitMs * 100) / 100;
  window.__as.serializeMs = Math.round(serializeMs * 100) / 100;
  window.__as.jsonBytes = json.length;
  window.__longs = [];
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longs.push({ start: Math.round(e.startTime), dur: Math.round(e.duration * 10) / 10 });
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* unsupported */ }
  return { explicitSaveMs: window.__as.explicitSaveMs, serializeMs: window.__as.serializeMs, jsonBytes: window.__as.jsonBytes, tick: g.state.tick, pop: g.state.cohorts.reduce((a, c) => a + c.count, 0) + g.state.citizens.filter((c) => c.alive).length, buildings: g.state.buildings.length };
});

await page.evaluate((sp) => {
  const g = window.__game;
  // Keep running through decisions so the 16 ticks of the probe window happen.
  g.decisionPause = false;
  g.resume();
  g.setSpeed(sp);
}, speed);
await new Promise((r) => setTimeout(r, durationMs));

const result = await page.evaluate(() => {
  const as = window.__as;
  const sort = (a) => [...a].sort((x, y) => x - y);
  const ts = sort(as.tickMs);
  const saves = as.writes.filter((w) => w.key.includes('autosave') || w.key.includes('probe'));
  return {
    explicitSaveMs: as.explicitSaveMs,
    serializeMs: as.serializeMs,
    jsonBytes: as.jsonBytes,
    writes: as.writes,
    saveWrites: saves,
    tick: { n: ts.length, avg: ts.length ? +(ts.reduce((a, b) => a + b, 0) / ts.length).toFixed(2) : 0, p95: ts.length ? +ts[Math.floor(ts.length * 0.95)].toFixed(2) : 0, max: ts.length ? +ts[ts.length - 1].toFixed(1) : 0 },
    longTasks: window.__longs,
    tickNow: window.__game.state.tick,
    pop: window.__game.state.cohorts.reduce((a, c) => a + c.count, 0) + window.__game.state.citizens.filter((c) => c.alive).length,
  };
});

const autoWrites = result.saveWrites.filter((w) => w.key.includes('autosave'));
const autoMs = autoWrites.reduce((a, w) => a + w.ms, 0);
const over30 = result.longTasks.filter((l) => l.dur > 30);
console.log(`DPR=${dpr} SPEED=${speed} setup pop=${setup.pop} buildings=${setup.buildings} tick=${setup.tick}`);
console.log(`serializeState only: ${result.serializeMs} ms (${result.jsonBytes} chars); save('probe') total: ${result.explicitSaveMs} ms (serialize + localStorage)`);
console.log(`autosaves during ${durationMs}ms: ${autoWrites.length} ${autoWrites.map((w) => `[${w.len} chars ${w.ms}ms]`).join(' ')}`);
console.log(`tick ms: avg=${result.tick.avg} p95=${result.tick.p95} max=${result.tick.max} (n=${result.tick.n})`);
console.log(`long tasks: ${result.longTasks.length} ${JSON.stringify(result.longTasks.slice(0, 6))}; >30ms: ${over30.length}; total autosave ms: ${autoMs.toFixed(2)}`);
if (errors.length) console.log('errors', errors.slice(0, 5));
await browser.close();
process.exit(over30.length > 2 ? 1 : 0);
