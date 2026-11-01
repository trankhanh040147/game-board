#!/usr/bin/env node
/**
 * QA: controls + combat mechanics via real input where possible and controlled synthetic setups.
 * Covers: WASD, sprint, attack directions, directional blocks (correct/wrong), guard break,
 * kick, dodge i-frames, lock-on, reach, friendly fire, dead-men-don't-hit, arena bounds.
 */
import { boot, sleep, shot, evalIn, parseArgs, writeJson, state } from './lib.mjs';
import { waitFor } from './lib.mjs';

const args = parseArgs();
const W = args.width, H = args.height;
const suffix = `${W}x${H}`;
const res = { checks: [], shots: [], notes: [] };
const check = (name, pass, detail) => {
  res.checks.push({ name, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
};
const note = (text, data) => {
  res.notes.push({ text, data });
  console.log(`[NOTE] ${text} :: ${JSON.stringify(data)}`);
};

const ctx = await boot({ url: args.url, width: W, height: H, wait: 3500 });
const { page } = ctx;
const snap = async (n) => res.shots.push(await shot(page, `${n}-${suffix}`));
const clickReal = async (needle) => {
  const box = await page.evaluate((n) => {
    const norm = (t) => t.replace(/\s+/g, ' ').toUpperCase();
    const b = Array.from(document.querySelectorAll('button')).find((x) => !x.disabled && norm(x.innerText).includes(norm(n)));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, needle);
  if (!box) return null;
  await page.mouse.click(box.x, box.y);
  return true;
};
const waitState = async (wanted, timeout = 15000) => !!(await waitFor(page, (w) => window.__game?.getState?.().state === w, timeout, 150, wanted));
const logText = () => page.evaluate(() => Array.from(document.querySelectorAll('.bm-logline-text')).map((n) => n.innerText.trim()));
const clearLog = () => page.evaluate(() => window.__game.game.ui.clearLog());

/** Freeze the melee: all AI off, everyone parked far away, player back at origin facing +Z. */
const freezeArena = async () => {
  await evalIn(page, `const g = window.__game.game;
    for (const f of g.fighters) {
      if (f.isPlayer) continue;
      f.ai = null; f.velocity.set(0,0,0);
      f.position.set(-40 - f.id, 0, -40 - f.id); f.state = 'idle'; f.stamina = 100; f.actionLock = 0;
    }
    const p = g.player;
    p.position.set(0, 0, 0); p.velocity.set(0,0,0); p.yaw = 0; p.stamina = 100; p.state = 'idle'; p.actionLock = 0;
    g.cameraCtrl.yaw = 0;
    return true;`);
  await sleep(250);
};
const placeFighter = async (which, x, z, hp) => {
  return evalIn(page, `const g = window.__game.game;
    const p = g.player;
    const list = g.fighters.filter(f => !f.isPlayer && f.alive);
    const e = ${which === 'teammate'
      ? 'g.fighters.find(f => !f.isPlayer && f.alive && f.team === p.team)'
      : 'list.find(f => f.team !== p.team) || list[0]'};
    if (!e) return null;
    e.ai = null; e.velocity.set(0,0,0);
    e.position.set(p.position.x + ${x}, 0, p.position.z + ${z});
    e.state = 'idle'; e.actionLock = 0; e.hp = ${hp ?? 'e.maxHp'}; e.stamina = 100;
    e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    e.hitConsumed = false;
    p.yaw = Math.atan2(e.position.x - p.position.x, e.position.z - p.position.z);
    g.cameraCtrl.yaw = p.yaw;
    return { name: e.name, id: e.id, team: e.team, hp: e.hp, maxHp: e.maxHp };
  `);
};
const wait = (ms) => sleep(ms);

try {
  await clickReal('TOURNAMENT');
  await waitState('bracket', 8000);
  await sleep(600);
  await clickReal('ENTER THE LISTS');
  await sleep(400);
  await page.keyboard.press('Enter');
  await waitState('fighting', 12000);
  await sleep(600);
  const lock = await page.evaluate(() => ({ locked: window.__game.game.input.locked, el: document.pointerLockElement?.tagName ?? null }));
  note('pointer lock state at fight start', lock);
  await freezeArena();
  await clearLog();

  /* ---------- 1. Attack directions via real mouse + keys ---------- */
  const dirResults = {};
  for (const [key, dir] of [['a', 'left'], ['d', 'right'], ['w', 'overhead'], ['s', 'thrust']]) {
    await evalIn(page, `const g = window.__game.game; g.player.state='idle'; g.player.actionLock=0; g.player.stamina=100; return true;`);
    await page.mouse.move(640, 360);
    await page.mouse.down();
    await wait(120);
    await page.keyboard.down(`Key${key.toUpperCase()}`);
    await wait(120);
    const held = await evalIn(page, `return { attackHeld: window.__game.game.playerCtrl.attackHeld, dir: window.__game.game.playerCtrl.attackDir };`);
    await page.keyboard.up(`Key${key.toUpperCase()}`);
    await page.mouse.up();
    await wait(120);
    const swung = await evalIn(page, `const p = window.__game.game.player; return { state: p.state, attackDir: p.attackDir, stamina: p.stamina };`);
    dirResults[dir] = { held, swung };
    await wait(800);
  }
  res.attackDirs = dirResults;
  for (const d of ['left', 'right', 'overhead', 'thrust']) {
    const r = dirResults[d];
    check(`attack direction "${d}" selected + swings`, r?.swung?.state === 'attack' && r?.swung?.attackDir === d, r);
  }
  // real swing through the target
  await placeFighter('enemy', 0, 1.9, 100000);
  await evalIn(page, `const g = window.__game.game; g.player.state='idle'; g.player.actionLock=0; g.player.stamina=100; return true;`);
  for (let i = 0; i < 4; i++) {
    await page.mouse.down();
    await wait(120);
    await page.keyboard.down('KeyS');
    await wait(80);
    await page.keyboard.up('KeyS');
    await page.mouse.up();
    await wait(700);
  }
  const hit = await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    return { dealt: p.damageDealt, kills: p.kills, enemyHp: e?.hp, enemyMaxHp: e?.maxHp, aimErr: e ? p.aimErrorTo(e.position) : null };`);
  check('player strikes actually damage a target in reach', hit.dealt > 0 && hit.enemyHp < 100000, hit);
  await snap('50-fight-block');

  /* ---------- 2. Directional block: correct (shield) ---------- */
  await freezeArena();
  await clearLog();
  const enemy = await placeFighter('enemy', 0, 1.8, 100000);
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    p.state='idle'; p.stamina=100; p.hp=p.maxHp; p.actionLock=0; return true;`);
  // hold RMB (default guard = overhead), enemy strikes overhead
  await page.mouse.down({ button: 'right' });
  await wait(250);
  const blockState = await evalIn(page, `const p = window.__game.game.player; return { state: p.state, guardDir: p.guardDir };`);
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    e.requestAttack('overhead'); return true;`);
  await wait(500);
  await page.mouse.up({ button: 'right' });
  const correct = await evalIn(page, `const g = window.__game.game; const p = g.player; return {
    hp: p.hp, maxHp: p.maxHp, blocks: p.blocks, stamina: p.stamina, state: p.state,
    log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()),
  };`);
  check('RMB hold enters block with chosen guard dir', blockState.state === 'block' && blockState.guardDir === 'overhead', blockState);
  check('correct-direction shield block: no HP loss, stamina spent', correct.hp === correct.maxHp && correct.blocks >= 1 && correct.stamina < 100, correct);
  check('block is logged ("Blocked … damage with your shield")', correct.log.some((l) => /Blocked \d+ damage with your shield/i.test(l)), correct.log.slice(-4));
  res.blockCorrect = correct;

  /* ---------- 3. Wrong-direction block -> hit lands ---------- */
  await freezeArena();
  await clearLog();
  await placeFighter('enemy', 0, 1.8, 100000);
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    p.state='idle'; p.stamina=100; p.hp=p.maxHp; p.actionLock=0; return true;`);
  await page.mouse.down({ button: 'right' });
  await wait(200);
  await page.keyboard.down('KeyA'); // guard left
  await wait(120);
  await page.keyboard.up('KeyA');
  await wait(100);
  const wrongGuard = await evalIn(page, `const p = window.__game.game.player; return { state: p.state, guardDir: p.guardDir };`);
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    e.requestAttack('overhead'); return true;`);
  await wait(550);
  await page.mouse.up({ button: 'right' });
  const wrong = await evalIn(page, `const g = window.__game.game; const p = g.player; return {
    hp: p.hp, maxHp: p.maxHp, blocks: p.blocks,
    log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()),
  };`);
  check('guard direction changes with A while blocking', wrongGuard.guardDir === 'left', wrongGuard);
  check('wrong-direction block fails and takes damage', wrong.hp < wrong.maxHp, { hp: wrong.hp, maxHp: wrong.maxHp });
  check('wrong block does not log a block', !wrong.log.some((l) => /^Blocked/i.test(l)), wrong.log.slice(-4));
  res.blockWrong = wrong;

  /* ---------- 4. Guard break at low stamina ---------- */
  await freezeArena();
  await clearLog();
  await placeFighter('enemy', 0, 1.7, 100000);
  await page.mouse.down({ button: 'right' });
  await wait(220);
  const beforeGB = await evalIn(page, `const g = window.__game.game; const p = g.player;
    p.stamina = 1.5; p.state='block'; g.playerCtrl.blockHeld = true; g.playerCtrl.blockDir='overhead';
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    e.requestAttack('overhead');
    return { stamina: p.stamina, guard: p.guardDir };`);
  await wait(550);
  await page.mouse.up({ button: 'right' });
  const gb = await evalIn(page, `const g = window.__game.game; const p = g.player; return {
    stamina: p.stamina, state: p.state, guardDir: p.guardDir, hp: p.hp,
    log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()),
  };`);
  check('guard breaks when stamina cannot pay the block', gb.log.some((l) => /guard was broken/i.test(l)) || gb.stamina === 0 || gb.state === 'stagger', { before: beforeGB, after: gb });
  check('guard break logged', gb.log.some((l) => /guard/i.test(l)), gb.log.slice(-5));
  res.guardBreak = gb;

  /* ---------- 5. Kick stagger + cooldown ---------- */
  await freezeArena();
  await clearLog();
  const kickTarget = await placeFighter('enemy', 0, 1.7, 100000);
  await evalIn(page, `const g = window.__game.game; const p = g.player; p.state='idle'; p.actionLock=0; p.stamina=100; p.kickCooldown=0; return true;`);
  await page.keyboard.press('KeyF');
  await wait(350);
  const kicked = await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    return { enemyState: e?.state, enemyTimer: e?.stateTimer, cooldown: p.kickCooldown,
      log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()) };`);
  check('kick staggers the opponent in front', kicked.enemyState === 'stagger', { enemyState: kicked.enemyState, timer: kicked.enemyTimer });
  check('kick logged + cooldown started', kicked.log.some((l) => /kicked/i.test(l)) && kicked.cooldown > 0, { cooldown: kicked.cooldown, log: kicked.log.slice(-3) });
  // second kick during cooldown must not fire
  await evalIn(page, `const g = window.__game.game; const p = g.player; p.state='idle'; p.actionLock=0; p.stamina=100; return true;`);
  const cdBefore = await evalIn(page, `return window.__game.game.player.kickCooldown;`);
  await page.keyboard.press('KeyF');
  await wait(250);
  const cdAfter = await evalIn(page, `return { cooldown: window.__game.game.player.kickCooldown, wants: window.__game.game.player.wantsKick };`);
  check('kick respects 4s cooldown', cdAfter.cooldown > 0 && cdAfter.cooldown < cdBefore + 0.4 && !cdAfter.wants, { before: cdBefore, after: cdAfter });
  await snap('51-kick');

  /* ---------- 6. Dodge i-frames ---------- */
  await freezeArena();
  await clearLog();
  await placeFighter('enemy', 0, 1.9, 100000);
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    p.state='idle'; p.actionLock=0; p.stamina=100; p.dodgeCooldown=0; p.hp=p.maxHp; return true;`);
  const preDodge = await evalIn(page, `const p=window.__game.game.player; return { x: p.position.x, z: p.position.z, hp: p.hp };`);
  await page.keyboard.press('Space');
  await wait(80);
  const dodging = await evalIn(page, `const p = window.__game.game.player; return { state: p.state, invuln: p.dodgeInvulnerable, stamina: p.stamina };`);
  // enemy swings while i-frames are up
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    e.position.set(p.position.x + Math.sin(p.yaw)*1.2, 0, p.position.z + Math.cos(p.yaw)*1.2);
    e.yaw = Math.atan2(p.position.x - e.position.x, p.position.z - e.position.z);
    e.requestAttack('thrust'); return true;`);
  await wait(300);
  const postDodge = await evalIn(page, `const g = window.__game.game; const p = g.player; return {
    state: p.state, hp: p.hp, invuln: p.dodgeInvulnerable, stamina: p.stamina,
    dodgeCooldown: p.dodgeCooldown,
    log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()),
  };`);
  const moved = Math.hypot((await evalIn(page, `return window.__game.game.player.position.x;`)) - preDodge.x, (await evalIn(page, `return window.__game.game.player.position.z;`)) - preDodge.z);
  res.dodge = { preDodge, dodging, postDodge, moved };
  check('Space triggers dodge with i-frames', dodging.state === 'dodge' && dodging.invuln > 0, dodging);
  check('dodge grants ~2.5m burst distance', moved > 1.5, { moved });
  check('attack during i-frames deals no damage', postDodge.hp === preDodge.hp, { hpBefore: preDodge.hp, hpAfter: postDodge.hp });
  await snap('52-dodge');

  /* ---------- 7. Lock-on ---------- */
  await freezeArena();
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const list = g.fighters.filter(f => !f.isPlayer && f.alive);
    const e = list.find(f => f.team !== p.team);
    e.position.set(p.position.x + Math.sin(p.yaw)*4.0, 0, p.position.z + Math.cos(p.yaw)*4.0);
    e.ai = null; g.cameraCtrl.yaw = p.yaw;
    return { id: e.id, name: e.name };`);
  await page.keyboard.press('KeyQ');
  await wait(350);
  const locked = await evalIn(page, `const g = window.__game.game; return {
    lockId: g.lockTargetId, hud: g.ui.lastHud ? { isLocked: !!g.ui.lastHud.target?.isLocked, targetName: g.ui.lastHud.target?.name } : null,
    ringVisible: g.targetRing?.visible, ringOpacity: g.targetRingMat?.opacity,
    overlayLocked: g.overlay.isLocked ?? null,
  };`);
  check('Q locks the nearest enemy in the camera cone', locked.lockId !== null && locked.lockId !== undefined, locked);
  check('target ring appears for the locked target', locked.ringVisible === true && locked.ringOpacity > 0.2, { visible: locked.ringVisible, opacity: locked.ringOpacity });
  await snap('53-lockon');
  await page.keyboard.press('KeyQ');
  await wait(250);
  const unlocked = await evalIn(page, `return { lockId: window.__game.game.lockTargetId };`);
  check('Q again releases the lock', unlocked.lockId === null, unlocked);

  /* ---------- 8. Sprint + movement ---------- */
  await freezeArena();
  const preSprint = await evalIn(page, `const p = window.__game.game.player; p.stamina = 100; return { x: p.position.x, z: p.position.z, stamina: p.stamina };`);
  await page.keyboard.down('KeyW');
  await page.keyboard.down('ShiftLeft');
  await wait(1200);
  const sprint = await evalIn(page, `const p = window.__game.game.player; return {
    speed: p.velocity.length(), x: p.position.x, z: p.position.z, stamina: p.stamina,
  };`);
  await page.keyboard.up('ShiftLeft');
  await page.keyboard.up('KeyW');
  const travelled = Math.hypot(sprint.x - preSprint.x, sprint.z - preSprint.z);
  check('W moves the player', travelled > 1.0, { travelled, sprint });
  check('Shift sprints faster than walk (3.9 m/s)', sprint.speed > 4.4, { speed: sprint.speed });
  check('sprint drains stamina', sprint.stamina < preSprint.stamina, { before: preSprint.stamina, after: sprint.stamina });
  res.sprint = { preSprint, sprint, travelled };

  /* ---------- 9. Reach / out-of-reach ---------- */
  await freezeArena();
  await clearLog();
  await evalIn(page, `const g = window.__game.game; const p = g.player; p.state='idle'; p.actionLock=0; p.stamina=100; return true;`);
  const farTarget = await placeFighter('enemy', 5.5, 0, 100000);
  const farBefore = await evalIn(page, `const g = window.__game.game; const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== g.player.team); return e.hp;`);
  await evalIn(page, `window.__game.game.player.requestAttack('thrust'); return true;`);
  await wait(600);
  const farAfter = await evalIn(page, `const g = window.__game.game; const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== g.player.team); return e.hp;`);
  check('strikes do not reach beyond weapon reach (5.5 m)', farAfter === farBefore, { before: farBefore, after: farAfter, target: farTarget });

  /* ---------- 10. Friendly fire + friendly kill reward log ---------- */
  await freezeArena();
  await clearLog();
  const mate = await placeFighter('teammate', 1.8, 0, 3);
  check('found a teammate for friendly-fire test', !!mate, mate);
  // force a clean hit on the teammate (no guard)
  await evalIn(page, `const g = window.__game.game; const p = g.player;
    const m = g.fighters.find(f => !f.isPlayer && f.alive && f.team === p.team);
    if (!m) return false;
    m.ai = null; m.state='idle'; m.actionLock=0; m.hp=2;
    m.position.set(p.position.x + Math.sin(p.yaw)*1.8, 0, p.position.z + Math.cos(p.yaw)*1.8);
    p.requestAttack('thrust'); return true;`);
  await wait(700);
  const ff = await evalIn(page, `const g = window.__game.game; const p = g.player; return {
    kills: p.kills, xp: g.profile.xp, level: g.profile.level,
    log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()),
    rewardLogs: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()).filter(t => /earned|experience/i.test(t)),
  };`);
  res.friendlyFire = ff;
  check('friendly fire is ON and warned in the log', ff.log.some((l) => /own|friendly|kinsman/i.test(l) || ff.log.some((l) => /knocked unconscious/i.test(l))), ff.log.slice(-6));
  if (ff.rewardLogs.length > 0 && ff.kills === 0) {
    note('BUG: friendly-fire kill prints kill-reward log lines ("You earned … denars"/XP) without awarding a kill', { rewardLogs: ff.rewardLogs, kills: ff.kills });
  }
  await snap('54-friendly-fire');

  /* ---------- 11. Dead fighters never attack ---------- */
  await freezeArena();
  await clearLog();
  const deadTarget = await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.alive && f.team !== p.team);
    e.knockOut(g.world);
    // park it right in front of the player
    e.position.set(p.position.x + Math.sin(p.yaw)*1.5, 0, p.position.z + Math.cos(p.yaw)*1.5);
    return { alive: e.alive, state: e.state, hp: e.hp, attacks: e.attackDir };`);
  const hpBeforeDeadTest = await evalIn(page, `return window.__game.game.player.hp;`);
  await wait(1200);
  const deadCheck = await evalIn(page, `const g = window.__game.game; const p = g.player;
    const e = g.fighters.find(f => !f.isPlayer && f.state === 'dead');
    return { hp: p.hp, deadState: e?.state, deadAlive: e?.alive, attacks: e?.attackDir,
      log: Array.from(document.querySelectorAll('.bm-logline-text')).map(n => n.innerText.trim()) };`);
  check('corpses stay dead and do not attack', deadCheck.hp === hpBeforeDeadTest && deadCheck.deadAlive === false, { hpBefore: hpBeforeDeadTest, deadCheck });
  res.deadCheck = deadCheck;

  /* ---------- 12. Arena bounds ---------- */
  const bounds = await evalIn(page, `const g = window.__game.game; const p = g.player;
    p.position.set(g.arena.bounds.maxX + 5, 0.5, 0);
    // simulate a frame of physics pushing further out
    for (let i = 0; i < 3; i++) { p.position.x += 2; g.arena.clampPosition(p.position, p.radius); }
    return { bounds: g.arena.bounds, pos: { x: p.position.x, y: p.position.y, z: p.position.z }, radius: p.radius };`);
  const b = bounds.bounds;
  check('arena clamping keeps fighters inside the walls',
    bounds.pos.x >= b.minX - 0.01 && bounds.pos.x <= b.maxX + 0.01 && bounds.pos.z >= b.minZ - 0.01 && bounds.pos.z <= b.maxZ + 0.01,
    bounds);

  /* ---------- 13. No NaN / Inf in live simulation ---------- */
  const nan = await evalIn(page, `const g = window.__game.game; const bad = [];
    for (const f of g.fighters) {
      const v = [f.position.x, f.position.y, f.position.z, f.hp, f.stamina, f.yaw, f.velocity.x, f.velocity.z];
      if (v.some(n => !Number.isFinite(n))) bad.push({ id: f.id, name: f.name, v });
    }
    const pv = [g.player?.position.x, g.player?.position.y, g.player?.position.z, g.player?.hp];
    return { bad, player: pv, camera: [g.cameraCtrl.position.x, g.cameraCtrl.position.y, g.cameraCtrl.position.z] };`);
  check('no NaN/Inf fighter positions/HP/stamina', nan.bad.length === 0 && nan.player.every((n) => Number.isFinite(n)), nan);


  /* ---------- 14. Tab scoreboard ---------- */
  await freezeArena();
  await page.keyboard.down('Tab');
  await wait(400);
  const tabHeld = await evalIn(page, `const el = document.querySelector('.co-scoreboard'); return {
    scoreboard: el && el.classList.contains('show') ? el.innerText.replace(/\s+/g,' ').trim() : null,
    rows: el ? el.querySelectorAll('.row').length : 0,
  };`);
  await page.keyboard.up('Tab');
  await wait(250);
  const tabReleased = await evalIn(page, `const el = document.querySelector('.co-scoreboard'); return { text: el && el.classList.contains('show') ? el.innerText.trim() : null };`);
  check('Tab shows the tournament scoreboard while held', !!tabHeld.scoreboard, tabHeld);
  check('Tab scoreboard hides on release', !tabReleased.text, tabReleased);

  /* ---------- 15. Wheel zoom ---------- */
  const zoomBefore = await evalIn(page, `return { d: window.__game.game.cameraCtrl.targetDistance, actual: window.__game.game.cameraCtrl.distance };`);
  await page.mouse.wheel({ deltaY: -240 });
  await wait(300);
  const zoomIn = await evalIn(page, `return { d: window.__game.game.cameraCtrl.targetDistance };`);
  await page.mouse.wheel({ deltaY: 480 });
  await wait(500);
  const zoomOut = await evalIn(page, `return { d: window.__game.game.cameraCtrl.targetDistance, actual: window.__game.game.cameraCtrl.distance };`);
  check('mouse wheel changes camera distance', zoomIn.d !== zoomBefore.d && zoomOut.d !== zoomIn.d, { before: zoomBefore, in: zoomIn, out: zoomOut });
  await snap('55-zoom');

  /* ---------- 16. Pointer-lock loss pauses; Esc resumes ---------- */
  const wasLocked = await evalIn(page, `return window.__game.game.input.locked;`);
  if (!wasLocked) {
    // re-acquire with a trusted click on the canvas
    await page.mouse.click(640, 360);
    await wait(400);
  }
  await evalIn(page, `if (document.pointerLockElement) document.exitPointerLock(); return true;`);
  const pausedByLoss = !!(await waitFor(page, () => window.__game?.getState?.().state === 'paused', 5000, 150));
  check('losing pointer lock auto-pauses', pausedByLoss, { wasLocked });
  await page.keyboard.press('Escape');
  const resumedFromLoss = !!(await waitFor(page, () => window.__game?.getState?.().state === 'fighting', 5000, 150));
  check('Esc resumes from the pointer-loss pause', resumedFromLoss);
  if (!(await evalIn(page, `return window.__game.game.input.locked;`))) {
    await page.mouse.click(640, 360);
    await wait(400);
  }

  /* ---------- 17. H toggles hint visibility ---------- */
  const hintsBefore = await evalIn(page, `return window.__game.game.settings.showHints;`);
  await page.keyboard.press('KeyH');
  await wait(400);
  const hintsAfter = await evalIn(page, `return { setting: window.__game.game.settings.showHints,
    stored: JSON.parse(localStorage.getItem('blade-and-mount.settings.v1') || '{}').showHints };`);
  check('H toggles the hints setting', hintsAfter.setting === !hintsBefore, { before: hintsBefore, after: hintsAfter });
  await page.keyboard.press('KeyH');
  await wait(300);

  res.errors = ctx.consoleErrors;
  check('no unexpected console errors during combat tests', ctx.consoleErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0, ctx.consoleErrors);
} catch (err) {
  res.fatal = String(err?.stack || err);
  console.error('FATAL', err);
  try { await snap('fatal-combat'); } catch { /* ignore */ }
}

await writeJson(`combat-${suffix}.json`, res);
const fails = res.checks.filter((c) => !c.pass);
console.log(`\n=== ${res.checks.length - fails.length}/${res.checks.length} checks passed; ${fails.length} failed ===`);
console.log('NOTES:', JSON.stringify(res.notes, null, 2));
await ctx.browser.close();
process.exitCode = fails.length || res.fatal ? 1 : 0;
