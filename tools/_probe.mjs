import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox','--use-angle=metal','--enable-unsafe-swiftshader','--window-size=1600,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
await page.goto('http://127.0.0.1:5299', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 30000 });
await new Promise(r=>setTimeout(r,1200));
await page.evaluate(() => document.querySelector('.fh-welcome [data-act="begin"]')?.click());
await new Promise(r=>setTimeout(r,700));
const vis = () => page.evaluate(() => { const p=document.querySelector('.fh-game-panel'); if(!p) return {w:0,cls:'none',title:''}; const r=p.getBoundingClientRect(); return {w:Math.round(r.width), cls:p.className, title:p.querySelector('h2')?.textContent?.trim()}; });
const results = [];
for (const [key, name] of [['t','codex'],['s','society'],['m','market'],['p','people'],['c','almanac'],['d','diplomacy'],['e','expeditions'],['w','wonders'],['o','objectives']]) {
  await page.keyboard.press(key);
  await new Promise(r=>setTimeout(r,600));
  const opened = await vis();
  await page.keyboard.press('Escape');
  await new Promise(r=>setTimeout(r,450));
  const closed = await vis();
  results.push({ name, opened: opened.w > 0, title: opened.title, escClosed: closed.w === 0 });
  // recover with click if needed
  if (closed.w > 0) { await page.evaluate(() => document.querySelector('[data-panel-close]')?.click()); await new Promise(r=>setTimeout(r,350)); }
}
console.log(JSON.stringify(results, null, 1));
await browser.close();
