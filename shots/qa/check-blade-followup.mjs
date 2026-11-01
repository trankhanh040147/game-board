// Follow-up: blade-and-mount is WebGL (three.js) with preserveDrawingBuffer=false,
// so drawImage readback returns blank. Measure frames via readPixels inside the
// rAF callback (valid before compositing) and verify a real menu interaction.
import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo, 'games/first-hearth/node_modules/puppeteer-core'));
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

// Hook rAF before any page script: after the app's own render callback runs,
// readPixels from the default framebuffer and record the first lit frame.
await page.evaluateOnNewDocument(() => {
  window.__qa = { frames: 0, firstLitFrameMs: null, litSeries: [], firstFrameMs: null, hitches: [] };
  const orig = window.requestAnimationFrame.bind(window);
  let last = 0;
  window.requestAnimationFrame = (cb) =>
    orig((ts) => {
      cb(ts);
      const q = window.__qa;
      q.frames++;
      if (q.firstFrameMs === null) q.firstFrameMs = ts;
      if (last && ts - last > 250) q.hitches.push(Math.round(ts - last));
      last = ts;
      try {
        const c = document.querySelector('canvas');
        if (!c) return;
        const gl = c.getContext('webgl2') || c.getContext('webgl');
        if (!gl) return;
        const w = Math.min(c.width, 160), h = Math.min(c.height, 90);
        const px = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let lit = 0, sum = 0;
        for (let i = 0; i < px.length; i += 4) { const v = px[i] + px[i + 1] + px[i + 2]; sum += v; if (v > 30) lit++; }
        q.litSeries.push(lit);
        if (q.firstLitFrameMs === null && lit > w * h * 0.05) q.firstLitFrameMs = Math.round(ts);
      } catch (e) { /* ignore */ }
    });
});

const t0 = Date.now();
const resp = await page.goto('https://blade-and-mount.vercel.app', { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForFunction(() => document.readyState === 'complete', { timeout: 30000 }).catch(() => {});
await sleep(3500);
const qa = await page.evaluate(() => ({ ...window.__qa, litSeries: window.__qa.litSeries.slice(0, 8) }));
const tSettle = Date.now() - t0;

// real interaction: open the Tournament list
const menuButtons = await page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim().slice(0, 60)));
let interaction = { clicked: null, before: null, after: null, urlBefore: page.url() };
const beforeShot = await page.screenshot();
try {
  const target = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /tournament/i.test(x.textContent || ''));
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { text: b.textContent.replace(/\s+/g, ' ').trim(), x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
  });
  if (target && target.visible) {
    await page.mouse.click(target.x, target.y);
    await sleep(2000);
    interaction.clicked = target.text;
    interaction.after = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400));
    interaction.urlAfter = page.url();
    await page.screenshot({ path: join(here, 'game-blade-and-mount-after-click.png') });
    // now try starting the tournament (a second interaction)
    const start = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /begin|start|enter|fight|enter the lists|advance/i.test(x.textContent || ''));
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { text: b.textContent.replace(/\s+/g, ' ').trim().slice(0, 60), x: r.x + r.width / 2, y: r.y + r.height / 2, visible: r.width > 0 && r.height > 0 };
    });
    if (start && start.visible) {
      await page.mouse.click(start.x, start.y);
      await sleep(2500);
      interaction.secondClick = start.text;
      interaction.afterSecond = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 400));
      await page.screenshot({ path: join(here, 'game-blade-and-mount-after-start.png') });
    }
  }
} catch (e) { interaction.error = e.message; }

// keyboard in-scene
const keyErrors = errors.length;
await page.keyboard.press('Escape');
await sleep(300);
interaction.keysOk = errors.length === keyErrors;

console.log(JSON.stringify({
  status: resp.status(), tSettleMs: tSettle,
  firstFrameMs: qa.firstFrameMs, firstLitFrameMs: qa.firstLitFrameMs, rafFramesInWindow: qa.frames,
  hitches: qa.hitches.slice(0, 5), errors,
  menuButtons, interaction: { ...interaction, beforeBinary: beforeShot.length },
}, null, 1));
await writeFile(join(here, 'blade-followup.json'), JSON.stringify({ qa, interaction, errors, menuButtons, status: resp.status() }, null, 1));
await browser.close();
