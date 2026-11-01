import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', e => console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5299', { waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__FIRST_HEARTH__?.ready === true', { timeout: 30000 });
await new Promise(r => setTimeout(r, 1600));
await page.evaluate(() => { localStorage.clear(); });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__FIRST_HEARTH__?.ready === true', { timeout: 30000 });
await new Promise(r => setTimeout(r, 1800));
await page.evaluate(() => { document.querySelector('.fh-welcome [data-act="begin"]')?.click(); });
await new Promise(r => setTimeout(r, 1200));
await page.evaluate(() => { document.querySelector('.fh-tour-card [data-act="skip"]')?.click(); });
await new Promise(r => setTimeout(r, 800));
const saved = await page.evaluate(() => { const g = window.__game; g.advanceDays(6); const ok = g.save(); localStorage.removeItem('fh-tour-v1'); return { ok, tick: g.state.tick, keys: Object.keys(localStorage) }; });
console.log('before reload:', JSON.stringify(saved));
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction('window.__FIRST_HEARTH__?.ready === true', { timeout: 30000 });
for (const ms of [1200, 1200, 1200, 1500, 2000]) {
  await new Promise(r => setTimeout(r, ms));
  const st = await page.evaluate(() => {
    const root = document.querySelector('.fh-tour');
    const card = document.querySelector('.fh-tour-card');
    const modal = document.querySelector('.fh-modal-host .fh-modal');
    const g = window.__game;
    return {
      tick: g?.state?.tick, paused: g?.paused,
      tourHidden: root?.hidden, tourVisibleClass: !!root?.classList?.contains('is-visible'),
      cardRect: card ? { w: Math.round(card.getBoundingClientRect().width), h: Math.round(card.getBoundingClientRect().height) } : null,
      modalOpen: !!modal, modalClass: modal?.className ?? null,
      bodyTourOpen: document.body.classList.contains('fh-tour-open'),
      toast: Array.from(document.querySelectorAll('.fh-toast')).map(t => t.textContent?.trim()).slice(-3),
      welcomeOpen: !document.querySelector('.fh-welcome')?.hidden,
      ls: Object.keys(localStorage).filter(k => k.includes('tour') || k.includes('welcome')),
      pending: g?.state?.events?.pending?.length,
    };
  });
  console.log('after', ms, 'ms:', JSON.stringify(st));
  if (st.tourVisibleClass) break;
}
await page.screenshot({ path: 'shots/day3-returning-probe.png' });
await browser.close();
