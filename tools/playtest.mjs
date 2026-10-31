#!/usr/bin/env node
/**
 * End-to-end playtest via headless Chrome: menu -> bracket -> bet -> round -> input -> pause.
 * Usage: node tools/playtest.mjs [--url http://127.0.0.1:5274]
 */
import puppeteer from 'puppeteer-core';
import path from 'node:path';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const url = getArg('url', 'http://127.0.0.1:5274/');
const outDir = getArg('out', 'shots/playtest');
fs.mkdirSync(outDir, { recursive: true });
const chrome = ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  headless: true,
  executablePath: chrome,
  args: ['--no-sandbox', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--use-angle=metal', '--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));

const state = () => page.evaluate(() => window.__game?.getState?.() ?? null);
const shot = async (name) => { await page.screenshot({ path: path.join(outDir, `${name}.png`) }); };
const clickText = async (needle) => page.evaluate((text) => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.toUpperCase().includes(text.toUpperCase()));
  if (!btn) return false;
  btn.click();
  return true;
}, needle);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
await sleep(4500);
const results = { url, steps: [] };
results.menu = await state();
await shot('01-menu');

// menu buttons inventory
results.menuButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.replace(/\n/g, ' | ')));
if (!(await clickText('TOURNAMENT'))) throw new Error('Tournament button not found');
await sleep(1600);
results.bracket = await state();
await shot('02-bracket');
results.bracketText = await page.evaluate(() => document.body.innerText.slice(0, 900));
results.betButtons = await page.evaluate(() => Array.from(document.querySelectorAll('button')).map((b) => b.innerText.replace(/\n/g, ' | ')));

// place a bet if possible
const betOk = await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll('button')).find((b) => b.innerText.trim() === '50');
  if (!btn) return false;
  btn.click();
  return true;
});
await sleep(400);
results.betPlaced = betOk;
await shot('03-bet');
if (!(await clickText('ENTER THE LISTS'))) throw new Error('Enter the Lists button not found');
await sleep(4800);
results.fight = await state();
await shot('04-fight-start');

// pause early (before the player can die) using the Escape key
await page.keyboard.press('Escape');
await sleep(900);
results.pause = await state();
await shot('05-pause');
results.pauseText = await page.evaluate(() => document.body.innerText.slice(0, 700));
if (!(await clickText('SETTINGS'))) results.settingsButton = false;
await sleep(800);
await shot('06-settings');
results.settingsText = await page.evaluate(() => document.body.innerText.slice(0, 900));
await clickText('BACK');
await sleep(600);
await clickText('RESUME');
await sleep(1200);
results.resumed = await state();
await shot('07-resumed');

// simulate input: look, move, attack, block, dodge, kick
await page.mouse.move(640, 360);
await page.mouse.move(780, 330, { steps: 10 });
await page.keyboard.down('KeyW');
await sleep(750);
await page.keyboard.up('KeyW');
await page.mouse.down({ button: 'left' });
await page.mouse.move(780 + 130, 330, { steps: 8 });
await page.mouse.move(780 - 100, 330, { steps: 8 });
await page.mouse.up({ button: 'left' });
await sleep(600);
results.attack = await state();
await shot('08-attack');
await page.mouse.down({ button: 'right' });
await sleep(900);
await page.mouse.up({ button: 'right' });
await sleep(300);
results.block = await state();
await page.keyboard.press('Space');
await sleep(500);
await page.keyboard.press('KeyF');
await sleep(600);
await shot('09-action');
results.logText = await page.evaluate(() => document.querySelector('.bm-hud-log, #ui-root')?.innerText?.slice(0, 1400) ?? '');
await sleep(3500);
results.later = await state();
results.perf = await page.evaluate(() => ({ fps: window.__game?.getState?.().fps, drawCalls: window.__game?.getState?.().drawCalls }));
await shot('10-later');

// fps measurement
await browser.close().catch(() => {});
results.errors = errors;
console.log(JSON.stringify(results, null, 2));
