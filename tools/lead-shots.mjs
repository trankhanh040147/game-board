import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const outDir = 'shots/lead';
fs.mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('404')) errors.push('CONSOLE ' + m.text().slice(0, 300)); });
await page.goto('http://127.0.0.1:5280/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 30000 });
await new Promise((r) => setTimeout(r, 1500));
// begin, set up a settlement with some buildings and days
await page.evaluate(() => {
  document.querySelector('[data-act="begin"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const g = window.__game;
  g.pause();
  const cap = g.state.settlements[0];
  const types = ['foragers_camp', 'woodcutter_camp', 'lean_to', 'well', 'stone_pit', 'hut', 'granary'];
  let n = 0;
  for (let dy = -5; dy <= 5 && n < types.length; dy++) {
    for (let dx = -5; dx <= 5 && n < types.length; dx++) {
      if (dx === 0 && dy === 0) continue;
      const res = g.placeBuilding(types[n], cap.x + dx, cap.y + dy);
      if (res.ok) n++;
    }
  }
  g.advanceDays(60);
  for (let i = 0; i < 30; i++) {
    const p = g.state.events.pending;
    if (!p.length) break;
    const ch = p[0].choices;
    g.resolveDecision(p[0].id, ch[ch.length - 1]?.id ?? '');
  }
  g.advanceDays(40);
  for (let i = 0; i < 30; i++) {
    const p = g.state.events.pending;
    if (!p.length) break;
    const ch = p[0].choices;
    g.resolveDecision(p[0].id, ch[ch.length - 1]?.id ?? '');
  }
  g.pause();
  document.querySelectorAll('.fh-welcome, .fh-modal-backdrop, .fh-screen').forEach((e) => { if (e instanceof HTMLElement) e.style.display = 'none'; });
});
await new Promise((r) => setTimeout(r, 600));
await page.screenshot({ path: outDir + '/map-day100.png' });
const panels = ['codex', 'society', 'market', 'people', 'almanac', 'diplomacy', 'expeditions', 'wonders', 'objectives'];
for (const p of panels) {
  await page.evaluate((id) => {
    document.querySelector(`[data-rail="${id}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, p);
  await new Promise((r) => setTimeout(r, 450));
  await page.screenshot({ path: `${outDir}/panel-${p}.png` });
  await page.evaluate(() => { document.querySelector('[data-panel-close]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await new Promise((r) => setTimeout(r, 150));
}
const info = await page.evaluate(() => {
  const g = window.__game;
  return {
    tick: g.state.tick,
    pop: g.state.settlements.reduce((a, s) => a + s.population, 0),
    buildings: g.state.buildings.length,
    era: g.state.research.era,
    techs: Object.keys(g.state.research.completed).length,
    food: Math.round(g.state.settlements[0].foodDays),
    morale: Math.round(g.state.settlements[0].morale),
    errors: g.contentErrors.length,
    fps: Math.round(g.fps),
  };
});
console.log(JSON.stringify({ info, errors }, null, 2));
await browser.close();
