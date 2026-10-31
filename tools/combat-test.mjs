import puppeteer from 'puppeteer-core';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--no-sandbox','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader','--use-angle=metal','--autoplay-policy=no-user-gesture-required'],
  defaultViewport: { width: 1280, height: 720, deviceScaleFactor: 1 } });
const page = await browser.newPage();
const errors = []; page.on('console', m => { if (m.type()==='error') errors.push(m.text()); }); page.on('pageerror', e => errors.push('PAGEERROR '+e.message));
await page.goto('http://127.0.0.1:5274/?autostart=melee&seed=77', { waitUntil: 'domcontentloaded' });
const wait = async (fn, timeout=20000) => { const t = Date.now(); while (Date.now()-t<timeout) { if (await page.evaluate(fn)) return true; await sleep(200); } return false; };
await wait(() => window.__game?.getState?.().state === 'intro');
await page.evaluate(() => { const g = window.__game.game; g.skipIntro(); });
await wait(() => window.__game?.getState?.().state === 'fighting');
// isolate: freeze/disable all but two fighters, clear surroundings
const setup = await page.evaluate(() => {
  const g = window.__game.game;
  const p = g.player;
  const e = g.fighters.find(f => !f.isPlayer && f.alive);
  for (const f of g.fighters) {
    if (f === p || f === e) continue;
    f.ai = null; f.position.set(25, 0, 25); f.velocity.set(0,0,0); f.alive = false; f.state = 'dead';
  }
  e.ai = null;
  p.hp = 120; p.maxHp = 120; p.stamina = 100; p.state = 'idle';
  e.hp = 100; e.maxHp = 100; e.state = 'idle'; e.stamina = 100;
  p.position.set(0, 0, 0); p.yaw = 0; p.rig.root.rotation.y = 0; g.cameraCtrl.yaw = 0;
  e.position.set(0, 0, 2.0); e.yaw = Math.PI; e.rig.root.rotation.y = Math.PI;
  return { p: p.name, e: e.name, eId: e.id, eHp: e.hp };
});
await sleep(300);
const camInfo = await page.evaluate(() => ({yaw: window.__game.game.cameraCtrl.yaw, locked: window.__game.game.input.locked, state: window.__game.game.state}));
const attackDirs = {};
for (const dir of ['right','left','overhead','thrust']) {
  const res = await page.evaluate(async (dir) => {
    const g = window.__game.game; const p = g.player; const e = g.fighters.find(f => f.id !== p.id && !f.isPlayer && f.alive) ?? g.fighters.find(f => f.id !== p.id);
    e.hp = 100; e.maxHp = 100; e.state = 'idle'; e.alive = true; e.staggerUntil = 0;
    p.position.set(0,0,0); p.yaw = 0; p.rig.root.rotation.y = 0; g.cameraCtrl.yaw = 0;
    e.position.set(0,0,1.8); e.yaw = Math.PI;
    p.state = 'idle'; p.stamina = 100;
    p.requestAttack(dir);
    await new Promise(r => setTimeout(r, 700));
    return { dir, eHp: e.hp, log: document.querySelector('.bm-hud-log')?.innerText?.split('\n').slice(0,5) };
  }, dir);
  attackDirs[dir] = res;
}
// block test
const block = await page.evaluate(async () => {
  const g = window.__game.game; const p = g.player; const e = g.fighters.find(f => f.id === 101) ?? g.fighters.find(f => !f.isPlayer);
  e.alive = true; e.state = 'idle'; e.hp = 100; p.hp = 120; p.stamina = 100; p.state = 'idle';
  p.position.set(0,0,0); p.yaw = 0; g.cameraCtrl.yaw = 0; e.position.set(0,0,1.7); e.yaw = Math.PI;
  e.attackDir = null;
  p.setBlock('right');
  const ctrl = g.playerCtrl; const orig = ctrl.update;
  ctrl.update = () => ({ moveX: 0, moveZ: 0, sprint: false, block: 'right', faceYaw: 0 });
  const hpBefore = p.hp;
  e.requestAttack('right');
  await new Promise(r => setTimeout(r, 900));
  const out = { hpBefore, hpAfter: p.hp, blocks: p.blocks, state: p.state, stamina: Math.round(p.stamina), guard: p.guardDir };
  ctrl.update = orig;
  return out;
});
// guard break test
const guardBreak = await page.evaluate(async () => {
  const g = window.__game.game; const p = g.player; const e = g.fighters.find(f => !f.isPlayer);
  p.hp = 120; p.maxHp = 120; p.stamina = 3; p.state = 'idle'; e.state = 'idle'; e.hp = 100;
  p.position.set(0,0,0); p.yaw = 0; g.cameraCtrl.yaw = 0; e.position.set(0,0,1.7); e.yaw = Math.PI;
  p.setBlock('right');
  const ctrl = g.playerCtrl; const orig = ctrl.update;
  ctrl.update = () => ({ moveX: 0, moveZ: 0, sprint: false, block: 'right', faceYaw: 0 });
  e.requestAttack('right');
  await new Promise(r => setTimeout(r, 900));
  const out = { hp: p.hp, stamina: p.stamina, state: p.state, guard: p.guardDir };
  ctrl.update = orig;
  return out;
});
// kick test
const kick = await page.evaluate(async () => {
  const g = window.__game.game; const p = g.player; const e = g.fighters.find(f => !f.isPlayer);
  p.state = 'idle'; p.stamina = 100; p.kickCooldown = 0; p.actionLock = 0;
  p.position.set(0,0,0); p.yaw = 0; e.alive = true; e.state = 'block'; e.guardDir = 'overhead'; e.position.set(0,0,1.6); e.yaw = Math.PI; e.stateTimer = 0;
  p.requestKick();
  await new Promise(r => setTimeout(r, 200));
  return { eState: e.state, eStamina: Math.round(e.stamina), kickCd: p.kickCooldown };
});
// dodge iframes
const dodge = await page.evaluate(async () => {
  const g = window.__game.game; const p = g.player;
  p.state = 'idle'; p.stamina = 100; p.dodgeCooldown = 0; p.actionLock = 0;
  p.requestDodge(1, 0);
  const s0 = { state: p.state, inv: p.isInvulnerable() };
  await new Promise(r => setTimeout(r, 400));
  return { s0, state: p.state, pos: [p.position.x, p.position.z] };
});
console.log(JSON.stringify({ setup, camInfo, attackDirs, block, guardBreak, kick, dodge, errors }, null, 2));
await browser.close();
