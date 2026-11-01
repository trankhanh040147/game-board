import { createRequire } from 'node:module';
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url)); const repo = join(here,'..','..');
const require = createRequire(import.meta.url);
const puppeteer = require(join(repo,'games/first-hearth/node_modules/puppeteer-core'));
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--hide-scrollbars','--mute-audio'] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors=[], bad=[];
page.on('console', m=>{ if(m.type()==='error') errors.push(m.text()); });
page.on('pageerror', e=>errors.push('pageerror: '+e.message));
page.on('response', r=>{ if(r.status()>=400) bad.push({url:r.url(),status:r.status()}); });
await page.goto('https://first-hearth.vercel.app', { waitUntil: 'load' });
await new Promise(r=>setTimeout(r,2500));
const before = await page.evaluate(() => {
  const b=[...document.querySelectorAll('button')].find(x=>/LIGHT THE HEARTH/i.test(x.textContent||''));
  const r = b? b.getBoundingClientRect() : null;
  return { btn: b?b.textContent.replace(/\s+/g,' ').trim():null, x: r? r.x+r.width/2:null, y: r? r.y+r.height/2:null, visible: r? r.width>0:false, overlay: !!document.querySelector('[class*="onboard"],[class*="tour"],[class*="intro"]'), canvas: !!document.querySelector('canvas') };
});
await page.screenshot({ path: join(here,'final','game-first-hearth-desktop.png') });
let clicked=null;
if(before.visible) { await page.mouse.click(before.x, before.y); clicked=before.btn; }
await new Promise(r=>setTimeout(r,3000));
const after = await page.evaluate(() => {
  const btn=[...document.querySelectorAll('button')].find(x=>/LIGHT THE HEARTH/i.test(x.textContent||''));
  const r = btn? btn.getBoundingClientRect(): null;
  return { btnStillVisible: !!(r&&r.width>0), body: document.body.innerText.replace(/\s+/g,' ').trim().slice(0,200), overlayText: /LIGHT THE HEARTH/i.test(document.body.innerText) };
});
await page.screenshot({ path: join(here,'final','game-first-hearth-after-interaction.png') });
// keyboard: pause/resume + build panel
await page.keyboard.press('KeyB'); await new Promise(r=>setTimeout(r,900));
const afterKeys = await page.evaluate(()=>document.body.innerText.replace(/\s+/g,' ').trim().slice(0,160));
await page.keyboard.press('Escape'); await new Promise(r=>setTimeout(r,300));
await page.keyboard.press('Space'); await new Promise(r=>setTimeout(r,300));
await page.screenshot({ path: join(here,'final','game-first-hearth-after-keys.png') });
// mobile
await page.setViewport({ width:390, height:844, deviceScaleFactor:2, isMobile:true, hasTouch:true });
await page.goto('https://first-hearth.vercel.app', { waitUntil:'load' }); await new Promise(r=>setTimeout(r,2500));
await page.screenshot({ path: join(here,'final','game-first-hearth-mobile.png') });
const mobile = await page.evaluate(()=>({ innerWidth: window.innerWidth, scrollWidth: document.documentElement.scrollWidth }));
const out={ clicked, before, after, afterKeys, mobile, errors, bad };
await writeFile(join(here,'first-hearth-interaction.json'), JSON.stringify(out,null,1));
console.log(JSON.stringify(out,null,1));
await browser.close();
