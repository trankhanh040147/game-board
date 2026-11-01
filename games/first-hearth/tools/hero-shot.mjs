import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
fs.mkdirSync('shots', { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('CONSOLE ' + m.text().slice(0, 240)); });
await page.goto('http://127.0.0.1:5280/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1200));
const info = await page.evaluate(() => {
  const click = (sel) => document.querySelector(sel)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  click('[data-act="begin"]');
  const g = window.__game;
  g.pause();
  const s = g.state;
  const c = g.content;
  const cap = s.settlements[0];
  // Advance into a mature early town for a good screenshot: grant era 2 techs + resources.
  s.flags.auto_research = 1;
  s.research.era = 2;
  for (const id of c.techOrder) { const t = c.techs[id]; if (t && t.era <= 2) s.research.completed[id] = s.tick; }
  s.research.insight = 900;
  const give = { wood: 400, stone: 300, clay: 160, fiber: 120, plank: 200, brick: 120, iron: 80, tools: 40, grain: 250, berries: 200, water: 120, coal: 60, glass: 30, cloth: 60, leather: 40, sand: 80, hides: 60, wool: 40, herbs: 30, salt: 20, copper: 40, charcoal: 60, rope: 30, pottery: 40, paper: 20, books: 10, medicine: 20, furniture: 20, machinery: 6, fuel: 20, energy: 40, ale: 20, wine: 10, art: 5, jewelry: 3, preserved_food: 60, chemicals: 10, glassware: 4, instruments: 2, computers: 0, electronics: 2, fertilizer: 20, concrete: 40, clothes: 30, flour: 80, bread: 80, meat: 80, fish: 80, clay2: 0 };
  for (const k in give) if (c.resources[k]) cap.stock[k] = (cap.stock[k] ?? 0) + give[k];
  cap.treasury = 2400;
  // Road grid around the centre
  for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
    if (Math.abs(dx) === 2 || Math.abs(dy) === 2) g.placeRoad(cap.x + dx, cap.y + dy);
  }
  const ring = [
    ['lean_to', 1, 0], ['hut', 0, -1], ['hut', -1, 0], ['hut', 0, 1],
    ['hut', 3, -1], ['hut', -3, 1], ['foragers_camp', 3, 2], ['woodcutter_camp', -3, -2],
    ['stone_pit', 4, -2], ['well', 1, 2], ['granary', -1, -2], ['farm', 5, 1], ['farm', -5, -1],
    ['sawmill', 2, -3], ['smithy', -2, 3], ['market', 0, 3], ['carpenter_shop', 4, 3],
    ['mill', -4, 2], ['bakery', -3, 3], ['temple', 2, 4], ['school', 4, -4], ['clinic', -4, -4],
    ['well', 5, -1], ['cottage', 1, -3], ['cottage', -1, 3], ['hovel', 0, 0], ['palisade', 4, 0], ['garden', 3, -2],
  ];
  for (const [type, dx, dy] of ring) {
    if (!c.buildings[type]) continue;
    for (let r = 0; r < 6; r++) {
      const x = cap.x + dx + (r === 1 ? 1 : r === 2 ? -1 : 0);
      const y = cap.y + dy + (r === 3 ? 1 : r === 4 ? -1 : 0);
      if (g.placeBuilding(type, x, y).ok) break;
    }
  }
  // Let the town grow and run.
  for (let k = 0; k < 24; k++) {
    g.advanceDays(10);
    for (let i = 0; i < 12; i++) { const p = s.events.pending; if (!p.length) break; const ch = p[0].choices; g.resolveDecision(p[0].id, ch[ch.length - 1]?.id ?? ''); }
  }
  // Force a pleasant summer day and clear modal chrome.
  s.world.weather.season = 'summer';
  s.world.weather.temperature = 23;
  s.world.weather.rainfall = 0;
  s.tick = Math.floor(s.tick / 64) * 64 + 16 * 1 + 7;
  g.pause();
  document.querySelectorAll('.fh-welcome, .fh-modal-backdrop, .fh-screen, .fh-welcome-panel, .fh-era-banner, .fh-toast, .fh-toasts, [class*=toast], .fh-decision-modal, .fh-modal-shell').forEach((e) => { if (e instanceof HTMLElement) e.style.display = 'none'; });
  const capNow = s.settlements[0];
  return { tick: s.tick, pop: s.settlements.reduce((a, x) => a + x.population, 0), buildings: s.buildings.length, era: s.research.era, techs: Object.keys(s.research.completed).length, food: Math.round(capNow.foodDays) };
});
await new Promise((r) => setTimeout(r, 1200));
await page.screenshot({ path: 'shots/first-hearth-hero-1920.png' });
// A second shot with a panel open (Codex), for the README.
await page.evaluate(() => { document.querySelector('[data-rail="codex"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await new Promise((r) => setTimeout(r, 700));
await page.screenshot({ path: 'shots/first-hearth-codex-1920.png' });
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
await page.evaluate(() => { document.querySelector('[data-panel-close]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: 'shots/first-hearth-hero-1600.png' });
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: 'shots/first-hearth-1280.png' });
console.log(JSON.stringify({ info, errors }, null, 2));
await browser.close();
