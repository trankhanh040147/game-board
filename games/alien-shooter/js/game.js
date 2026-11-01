'use strict';
/* =========================================================================
   ALIEN SHOOTER — game.js
   Game loop · wave director · upgrade cards · collision · renderer · HUD
   ========================================================================= */

/* Canvas roundRect fallback (older Safari) */
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    this.moveTo(x + rr, y);
    this.arcTo(x + w, y, x + w, y + h, rr);
    this.arcTo(x + w, y + h, x, y + h, rr);
    this.arcTo(x, y + h, x, y, rr);
    this.arcTo(x, y, x + w, y, rr);
    this.closePath();
    return this;
  };
}

/* =========================================================================
   UPGRADE POOL
   ========================================================================= */
const UPGRADES = [
  {
    id: 'damage', icon: '✦', name: 'OVERCHARGE', desc: '+25% damage per bullet.', max: 9, weight: 11,
    apply: (p) => { p.stats.damage *= 1.25; },
  },
  {
    id: 'rate', icon: '⚡', name: 'RAPID FIRE', desc: '+18% fire rate.', max: 9, weight: 11,
    apply: (p) => { p.stats.fireRate *= 1.18; },
  },
  {
    id: 'multi', icon: '✳', name: 'MULTI-SHOT', desc: '+1 projectile per shot.', max: 4, weight: 6, rare: true,
    apply: (p) => { p.stats.multishot += 1; },
  },
  {
    id: 'pierce', icon: '➶', name: 'PIERCING ROUNDS', desc: 'Bullets pierce +1 target.', max: 3, weight: 5, rare: true,
    apply: (p) => { p.stats.pierce += 1; },
  },
  {
    id: 'speed', icon: '»', name: 'THRUSTERS', desc: '+10% movement speed.', max: 6, weight: 8,
    apply: (p) => { p.stats.speed *= 1.1; },
  },
  {
    id: 'vitality', icon: '❤', name: 'BIO-ARMOR', desc: '+25 max health and heal 25 now.', max: 6, weight: 8,
    apply: (p) => { p.stats.maxHp += 25; p.hp = Math.min(p.stats.maxHp, p.hp + 25); },
  },
  {
    id: 'crit', icon: '◎', name: 'PRECISION', desc: '+10% crit chance.', max: 5, weight: 7,
    apply: (p) => { p.stats.crit = Math.min(0.95, p.stats.crit + 0.1); },
  },
  {
    id: 'critdmg', icon: '✸', name: 'CRIT AMPLIFIER', desc: '+50% crit damage.', max: 4, weight: 5, rare: true,
    apply: (p) => { p.stats.critMult += 0.5; },
  },
  {
    id: 'regen', icon: '✚', name: 'NANO-REPAIR', desc: 'Regenerate +1.2 health per second.', max: 5, weight: 6,
    apply: (p) => { p.stats.regen += 1.2; },
  },
  {
    id: 'magnet', icon: '◉', name: 'GRAVITY FIELD', desc: '+70% XP pickup radius, +15% XP gained.', max: 4, weight: 5,
    apply: (p) => { p.stats.magnet *= 1.7; p.stats.xpGain += 0.15; },
  },
  {
    id: 'dash', icon: '⇥', name: 'PHASE DRIVE', desc: '-20% dash cooldown.', max: 4, weight: 6,
    apply: (p) => { p.stats.dashCd *= 0.8; },
  },
  {
    id: 'bulletsize', icon: '●', name: 'HEAVY SLUGS', desc: '+25% bullet size.', max: 4, weight: 6,
    apply: (p) => { p.stats.bulletSize *= 1.25; },
  },
  {
    id: 'explosive', icon: '✹', name: 'PLASMA WARHEADS', desc: 'Bullets explode on impact.', max: 3, weight: 5, rare: true,
    apply: (p) => { p.stats.explosive += 1; },
  },
  {
    id: 'shockwave', icon: '◈', name: 'NOVA DASH', desc: 'Dash emits a damaging shockwave.', max: 1, weight: 4, rare: true,
    apply: (p) => { p.stats.shockwave = true; },
  },
  {
    id: 'drone', icon: '⬢', name: 'COMBAT DRONE', desc: 'Summon a drone that fires automatically.', max: 3, weight: 4, rare: true,
    apply: (p) => { p.stats.drones += 1; },
  },
  {
    id: 'velocity', icon: '↗', name: 'RAIL ACCELERATOR', desc: '+20% bullet velocity.', max: 4, weight: 6,
    apply: (p) => { p.stats.bulletSpeed *= 1.2; },
  },
];

const REPAIR_CARD = {
  id: 'repair', icon: '✚', name: 'EMERGENCY REPAIR', desc: 'Restore 45 health instantly.', max: 999, weight: 1,
  apply: (p) => { p.hp = Math.min(p.stats.maxHp, p.hp + 45); },
};

const BOSS_NAMES = ['HIVE QUEEN', 'BROOD MOTHER', 'XENO TITAN', 'VOID SPAWNER', 'OMEGA HULK'];

/* =========================================================================
   GAME
   ========================================================================= */
class Game {
  constructor() {
    this.canvas = document.getElementById('game');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.input = new Input(this.canvas);
    this.audio = new AudioEngine();
    this.camera = new Camera();
    this.fx = new FX();

    this.dpr = 1;
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    this.state = 'title';
    this.time = 0;

    // static world decor
    this.stars = [];
    for (let i = 0; i < 260; i++) {
      this.stars.push({
        x: rand(-200, WORLD.w + 200),
        y: rand(-200, WORLD.h + 200),
        r: rand(0.5, 1.9),
        a: rand(0.12, 0.65),
        tw: rand(0, TAU),
        sp: rand(0.6, 2.4),
      });
    }
    this.nebulas = [
      { x: WORLD.w * 0.22, y: WORLD.h * 0.25, r: 780, c: 'rgba(40,90,255,0.11)' },
      { x: WORLD.w * 0.78, y: WORLD.h * 0.7, r: 900, c: 'rgba(150,50,255,0.09)' },
      { x: WORLD.w * 0.6, y: WORLD.h * 0.15, r: 620, c: 'rgba(0,220,255,0.07)' },
      { x: WORLD.w * 0.35, y: WORLD.h * 0.8, r: 700, c: 'rgba(255,60,140,0.05)' },
    ];

    // static arena decor (rocks / crystals / alien egg clusters)
    this.decor = [];
    const cxw = WORLD.w / 2;
    const cyw = WORLD.h / 2;
    for (let i = 0; i < 58; i++) {
      const x = rand(ARENA_PAD + 70, WORLD.w - ARENA_PAD - 70);
      const y = rand(ARENA_PAD + 70, WORLD.h - ARENA_PAD - 70);
      if (dist(x, y, cxw, cyw) < 230) continue;
      const k = Math.random();
      if (k < 0.55) {
        this.decor.push({
          kind: 'rock', x, y, r: rand(16, 52), rot: rand(0, TAU),
          pts: Array.from({ length: 7 }, () => rand(0.68, 1.12)),
        });
      } else if (k < 0.82) {
        this.decor.push({ kind: 'crystal', x, y, r: rand(13, 28), rot: rand(0, TAU), hue: Math.random() < 0.5 ? '#35f0ff' : '#a06bff' });
      } else {
        this.decor.push({ kind: 'egg', x, y, r: rand(20, 38), rot: rand(0, TAU) });
      }
    }

    // splat layer
    this.splatCanvas = document.createElement('canvas');
    this.splatCanvas.width = WORLD.w;
    this.splatCanvas.height = WORLD.h;
    this.splatCtx = this.splatCanvas.getContext('2d');

    this.player = new Player(this);
    this.enemies = [];
    this.bullets = [];
    this.pickups = [];
    this.telegraphs = [];
    this.spawnQueue = [];

    this.score = 0;
    this.kills = 0;
    this.wave = 0;
    this.elapsed = 0;
    this.waveActive = false;
    this.nextWaveTimer = 0;
    this.spawnTimer = 0;
    this.bossAlive = false;
    this.pendingLevelUps = 0;
    this.taken = {};
    this.cardChoices = [];
    this.lastTs = 0;
    this._cachedHud = {};
    this.lowFx = false;
    this._fpsTimer = 0;
    this._fpsFrames = 0;

    try {
      if (('ontouchstart' in window) || navigator.maxTouchPoints > 0) {
        document.body.classList.add('is-touch');
      }
    } catch (err) { /* ignore */ }

    this.el = this._refs();
    this._bindUI();

    this.resize();
    window.addEventListener('resize', () => this.resize());

    this.reset();
    this.setState('title');
    this.updateHUD();

    this._loop = this._loop.bind(this);
    requestAnimationFrame(this._loop);
  }

  _refs() {
    const $ = (id) => document.getElementById(id);
    return {
      hud: $('hud'),
      hudWave: $('hudWave'),
      hudEnemies: $('hudEnemies'),
      hudScore: $('hudScore'),
      hudLevel: $('hudLevel'),
      hudHpFill: $('hudHpFill'),
      hudHpGhost: $('hudHpGhost'),
      hudHpTxt: $('hudHpTxt'),
      hudXpFill: $('hudXpFill'),
      hudDashFill: $('hudDashFill'),
      hudChips: $('hudChips'),
      banner: $('banner'),
      bannerMain: $('bannerMain'),
      bannerSub: $('bannerSub'),
      titleScreen: $('titleScreen'),
      pauseScreen: $('pauseScreen'),
      levelupScreen: $('levelupScreen'),
      gameoverScreen: $('gameoverScreen'),
      levelupNum: $('levelupNum'),
      cards: $('cards'),
      btnStart: $('btnStart'),
      btnResume: $('btnResume'),
      btnQuit: $('btnQuit'),
      btnRestart: $('btnRestart'),
      btnMenu: $('btnMenu'),
      goStats: $('goStats'),
      pauseStats: $('pauseStats'),
      muteBadge: $('muteBadge'),
      btnPause: $('btnPause'),
      btnMute: $('btnMute'),
      canvas: this.canvas,
    };
  }

  _bindUI() {
    const e = this.el;
    e.btnStart.addEventListener('click', () => this.start());
    e.btnResume.addEventListener('click', () => this.resume());
    e.btnQuit.addEventListener('click', () => this.toMenu());
    e.btnPause.addEventListener('click', () => {
      if (this.state === 'playing') this.pause();
      else if (this.state === 'paused') this.resume();
    });
    e.btnMute.addEventListener('click', () => this.toggleMute());
    e.btnRestart.addEventListener('click', () => this.start());
    e.btnMenu.addEventListener('click', () => this.toMenu());
    e.cards.addEventListener('click', (ev) => {
      const card = ev.target.closest('.card');
      if (!card) return;
      const i = parseInt(card.dataset.i, 10);
      if (Number.isFinite(i)) this.pickUpgrade(i);
    });
  }

  /* ---------------------------------------------------------------- state */
  setState(s) {
    this.state = s;
    const stateClasses = ['state-title', 'state-playing', 'state-paused', 'state-levelup', 'state-gameover'];
    for (const c of stateClasses) document.body.classList.remove(c);
    document.body.classList.add('state-' + s);
    const e = this.el;
    e.titleScreen.classList.toggle('show', s === 'title');
    e.pauseScreen.classList.toggle('show', s === 'paused');
    e.levelupScreen.classList.toggle('show', s === 'levelup');
    e.gameoverScreen.classList.toggle('show', s === 'gameover');
    const hudVisible = s === 'playing' || s === 'paused' || s === 'levelup';
    e.hud.classList.toggle('hidden', !hudVisible);
    if (s !== 'paused' && s !== 'gameover') e.pauseStats.innerHTML = '';
  }

  resize() {
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.vw = window.innerWidth;
    this.vh = window.innerHeight;
    this.canvas.width = Math.floor(this.vw * this.dpr);
    this.canvas.height = Math.floor(this.vh * this.dpr);
    this.canvas.style.width = this.vw + 'px';
    this.canvas.style.height = this.vh + 'px';
    this.camera.resize(this.vw, this.vh, WORLD);
    this.camera.snap(this.player);
    this._buildVignette();
  }

  _buildVignette() {
    const w = Math.max(2, Math.round(this.vw / 2));
    const h = Math.max(2, Math.round(this.vh / 2));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const g = c.getContext('2d');
    const grd = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.78);
    grd.addColorStop(0, 'rgba(0,0,0,0)');
    grd.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    grd.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
    this.vignette = c;
  }

  reset() {
    this.player.reset();
    this.enemies.length = 0;
    this.bullets.length = 0;
    this.pickups.length = 0;
    this.telegraphs.length = 0;
    this.spawnQueue.length = 0;
    this.score = 0;
    this.kills = 0;
    this.wave = 0;
    this.elapsed = 0;
    this.waveActive = false;
    this.nextWaveTimer = 0;
    this.spawnTimer = 0;
    this.bossAlive = false;
    this.bossJustDied = false;
    this.pendingLevelUps = 0;
    this.taken = {};
    this.cardChoices = [];
    this.fx.clear();
    this.splatCtx.clearRect(0, 0, WORLD.w, WORLD.h);
    this.camera.resize(this.vw, this.vh, WORLD);
    this.camera.snap(this.player);
    this.refreshChips();
    this.updateHUD();
  }

  start() {
    this.audio.init();
    this.audio.resume();
    this.reset();
    this.setState('playing');
    this.input.mouse.down = false;
    this.player.invuln = 1.2; // brief spawn protection
    this.startWave(1);
    this.updateHUD();
  }

  toMenu() {
    this.reset();
    this.setState('title');
    this.el.banner.classList.remove('show');
    this.audio.resume();
  }

  pause() {
    if (this.state !== 'playing') return;
    this.setState('paused');
    this.input.mouse.down = false;
    this.el.pauseStats.innerHTML = [
      this._stat('WAVE', String(this.wave), 'cyan'),
      this._stat('KILLS', String(this.kills), ''),
      this._stat('SCORE', fmtNum(this.score), 'violet'),
    ].join('');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.audio.resume();
    this.setState('playing');
    this.input.mouse.down = false;
  }

  _stat(k, v, cls) {
    return `<div class="stat"><div class="stat-k">${k}</div><div class="stat-v ${cls}">${v}</div></div>`;
  }

  toggleMute() {
    this.audio.setEnabled(!this.audio.enabled);
    this.el.muteBadge.classList.toggle('hidden', this.audio.enabled);
    this.el.btnMute.textContent = this.audio.enabled ? '🔊' : '🔇';
  }

  /* ---------------------------------------------------------------- waves */
  startWave(n) {
    this.wave = n;
    this.waveActive = true;
    this.spawnQueue.length = 0;
    this.spawnTimer = 0.7;
    this.nextWaveTimer = 0;

    if (n % 5 === 0) {
      this.bossAlive = true;
      this.bossName = BOSS_NAMES[Math.min(BOSS_NAMES.length - 1, Math.floor(n / 5) - 1)];
      this.spawnQueue.push('boss');
      const adds = 3 + Math.floor(n / 5) * 2;
      for (let i = 0; i < adds; i++) this.spawnQueue.push(pick(['crawler', 'skitter']));
      shuffle(this.spawnQueue);
      this.banner('⚠ ' + this.bossName, `WAVE ${n} — BOSS INCOMING`, 'danger');
      this.audio.boss();
      this.camera.addShake(9);
    } else {
      const count = Math.round(6 + n * 2.3);
      const pool = [{ t: 'crawler', w: 10 }];
      if (n >= 2) pool.push({ t: 'skitter', w: 7 });
      if (n >= 3) pool.push({ t: 'spitter', w: 5 });
      if (n >= 4) pool.push({ t: 'brute', w: 3 + Math.min(3, n * 0.08) });
      for (let i = 0; i < count; i++) this.spawnQueue.push(this._weighted(pool));
      shuffle(this.spawnQueue);
      this.banner(`WAVE ${n}`, `${count} HOSTILES INCOMING`, '');
      this.audio.waveStart();
    }
  }

  _weighted(pool) {
    let total = 0;
    for (const p of pool) total += p.w;
    let r = Math.random() * total;
    for (const p of pool) {
      r -= p.w;
      if (r <= 0) return p.t;
    }
    return pool[0].t;
  }

  onWaveClear() {
    const bonus = 100 + this.wave * 45;
    this.addScore(bonus);
    if (this.bossJustDied) {
      this.banner('BOSS DOWN', `+${bonus} SCORE`, 'danger');
      this.bossJustDied = false;
    } else {
      this.banner(`WAVE ${this.wave} CLEAR`, `+${bonus} SCORE`, '');
    }
    this.player.heal(10);
    this.nextWaveTimer = 2.6;
    this.audio.waveStart();
  }

  _spawnSpot(minDist) {
    for (let i = 0; i < 30; i++) {
      const a = rand(0, TAU);
      const rr = rand(470, 700);
      const x = clamp(this.player.x + Math.cos(a) * rr, ARENA_PAD + 70, WORLD.w - ARENA_PAD - 70);
      const y = clamp(this.player.y + Math.sin(a) * rr, ARENA_PAD + 70, WORLD.h - ARENA_PAD - 70);
      if (dist(x, y, this.player.x, this.player.y) >= minDist) return { x, y };
    }
    return {
      x: clamp(this.player.x + rand(-700, 700), ARENA_PAD + 70, WORLD.w - ARENA_PAD - 70),
      y: clamp(this.player.y + rand(-700, 700), ARENA_PAD + 70, WORLD.h - ARENA_PAD - 70),
    };
  }

  telegraphSpawn(type) {
    const isBoss = type === 'boss';
    const spot = this._spawnSpot(isBoss ? 460 : 430);
    this.telegraphs.push({ x: spot.x, y: spot.y, type, t: isBoss ? 1.2 : 0.6, total: isBoss ? 1.2 : 0.6, boss: isBoss });
  }

  spawnEnemyAt(type, x, y) {
    if (this.enemies.length > 60) return;
    x = clamp(x, ARENA_PAD + 40, WORLD.w - ARENA_PAD - 40);
    y = clamp(y, ARENA_PAD + 40, WORLD.h - ARENA_PAD - 40);
    const e = new Enemy(this, type, x, y);
    this.enemies.push(e);
    this.fx.ring(x, y, {
      r0: 4, r1: e.r * 2.6, life: 0.4,
      color: ENEMY_DEFS[type].color, width: 2,
    });
    if (type === 'boss') {
      this.fx.ring(x, y, { r0: 10, r1: 260, life: 0.9, color: '#ff4d9d', width: 6 });
      this.camera.addShake(12);
      this.audio.explode();
    }
    return e;
  }

  /* ---------------------------------------------------------------- update */
  _loop(ts) {
    if (!this.lastTs) this.lastTs = ts;
    let dt = (ts - this.lastTs) / 1000;
    this.lastTs = ts;
    if (!Number.isFinite(dt) || dt <= 0) dt = 1 / 60;
    dt = Math.min(dt, 0.05);

    this.update(dt);
    this.render();
    this.updateHUD();
    this.input.endFrame();

    // adaptive quality: if the browser can't keep up, shed the expensive extras
    if (this.state === 'playing') {
      this._fpsTimer += dt;
      this._fpsFrames++;
      if (this._fpsTimer >= 2) {
        const fps = this._fpsFrames / this._fpsTimer;
        if (!this.lowFx && fps < 44) {
          this.lowFx = true;
          this.fx.MAX = 340;
          document.body.classList.add('lowfx');
        }
        this._fpsTimer = 0;
        this._fpsFrames = 0;
      }
    } else {
      this._fpsTimer = 0;
      this._fpsFrames = 0;
    }

    requestAnimationFrame(this._loop);
  }

  update(dt) {
    this._handleKeys();

    if (this.state === 'title' || this.state === 'gameover') {
      this.fx.update(dt * 0.5);
      this.camera.update(dt, this.player);
      this.player.bob += dt;
      return;
    }
    if (this.state !== 'playing') return;

    this.elapsed += dt;
    this.time += dt;

    /* --- player --- */
    this.player.update(dt, this);

    /* --- wave director --- */
    if (this.waveActive) {
      if (this.spawnQueue.length > 0) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0) {
          const type = this.spawnQueue.shift();
          this.spawnTimer = clamp(0.62 - this.wave * 0.016, 0.15, 0.62) * rand(0.6, 1.4);
          this.telegraphSpawn(type);
        }
      } else if (this.enemies.length === 0) {
        this.waveActive = false;
        this.onWaveClear();
      }
    } else if (this.nextWaveTimer > 0) {
      this.nextWaveTimer -= dt;
      if (this.nextWaveTimer <= 0) this.startWave(this.wave + 1);
    }

    /* --- telegraphs --- */
    for (let i = this.telegraphs.length - 1; i >= 0; i--) {
      const t = this.telegraphs[i];
      t.t -= dt;
      if (Math.random() < dt * 22) {
        this.fx.burst(t.x + rand(-26, 26), t.y + rand(-26, 26), {
          count: 1, colors: [t.boss ? '#ff4d9d' : '#4dff9d'],
          speedMin: 10, speedMax: 50, lifeMin: 0.2, lifeMax: 0.45, sizeMin: 1, sizeMax: 2.4,
        });
      }
      if (t.t <= 0) {
        this.spawnEnemyAt(t.type, t.x, t.y);
        this.telegraphs.splice(i, 1);
      }
    }

    /* --- enemies --- */
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) es[i].update(dt, this);
    this._separateEnemies();
    for (let i = es.length - 1; i >= 0; i--) {
      if (es[i].dead) es.splice(i, 1);
    }

    this._updateBullets(dt);
    this._updatePickups(dt);
    this.fx.update(dt);
    this.camera.update(dt, this.player);

    if (this.pendingLevelUps > 0 && this.state === 'playing') this.openLevelUp();
  }

  _handleKeys() {
    const inp = this.input;
    if (inp.wasPressed('KeyM')) this.toggleMute();

    if (this.state === 'playing') {
      if (inp.wasPressed('KeyP') || inp.wasPressed('Escape')) this.pause();
    } else if (this.state === 'paused') {
      if (inp.wasPressed('KeyP') || inp.wasPressed('Escape')) this.resume();
    } else if (this.state === 'levelup') {
      if (inp.wasPressed('Digit1') || inp.wasPressed('Numpad1')) this.pickUpgrade(0);
      else if (inp.wasPressed('Digit2') || inp.wasPressed('Numpad2')) this.pickUpgrade(1);
      else if (inp.wasPressed('Digit3') || inp.wasPressed('Numpad3')) this.pickUpgrade(2);
    } else if (this.state === 'title') {
      if (inp.wasPressed('Enter') || inp.wasPressed('Space') || inp.wasPressed('NumpadEnter')) this.start();
    } else if (this.state === 'gameover') {
      if (inp.wasPressed('KeyR') || inp.wasPressed('Enter')) this.start();
    }
  }

  _separateEnemies() {
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const a = es[i];
      for (let j = i + 1; j < es.length; j++) {
        const b = es[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const min = a.r + b.r;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.01 && d2 < min * min) {
          const d = Math.sqrt(d2);
          const push = ((min - d) / d) * 0.5;
          const px = dx * push;
          const py = dy * push;
          const wa = b.r / min;
          const wb = a.r / min;
          a.x -= px * wa;
          a.y -= py * wa;
          b.x += px * wb;
          b.y += py * wb;
        }
      }
    }
  }

  spawnBullet(o) {
    const b = Object.assign({ hits: [], life: 1.4, crit: false, explosive: 0, pierce: 0, hostile: false }, o);
    this.bullets.push(b);
    if (this.bullets.length > 700) this.bullets.shift();
  }

  _updateBullets(dt) {
    const bs = this.bullets;
    const p = this.player;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.life -= dt;

      let kill = b.life <= 0 || b.x < -80 || b.y < -80 || b.x > WORLD.w + 80 || b.y > WORLD.h + 80;

      if (!kill) {
        if (b.hostile) {
          const dx = b.x - p.x;
          const dy = b.y - p.y;
          if (p.alive && dx * dx + dy * dy < (b.r + p.r) * (b.r + p.r)) {
            p.hurt(b.damage, this, b.x, b.y);
            this.fx.burst(b.x, b.y, {
              count: 8, colors: [b.color, '#ffffff'], speedMin: 40, speedMax: 180,
              lifeMin: 0.12, lifeMax: 0.35, sizeMin: 1, sizeMax: 2.6,
            });
            kill = true;
          }
        } else {
          const es = this.enemies;
          for (let j = 0; j < es.length; j++) {
            const e = es[j];
            if (e.dead) continue;
            if (b.hits.length > 0 && b.hits.indexOf(e.id) !== -1) continue;
            const dx = e.x - b.x;
            const dy = e.y - b.y;
            const rr = e.r + b.r;
            if (dx * dx + dy * dy > rr * rr) continue;

            e.hurt(b.damage, this, b.crit, b.vx * 0.02, b.vy * 0.02);
            this.audio.hit();
            this.fx.burst(b.x, b.y, {
              count: 6, dir: Math.atan2(b.vy, b.vx) + Math.PI, cone: 0.9,
              speedMin: 50, speedMax: 220, colors: [b.color, '#ffffff', '#ffe066'],
              lifeMin: 0.1, lifeMax: 0.3, sizeMin: 1, sizeMax: 2.4, drag: 5,
            });
            if (b.explosive > 0) {
              this.explode(b.x, b.y, 58 + b.explosive * 20, b.damage * 0.5, '#ffb84d');
            }
            b.hits.push(e.id);
            if (b.hits.length > b.pierce) { kill = true; break; }
          }
        }
      }

      if (kill) bs.splice(i, 1);
    }
  }

  _updatePickups(dt) {
    const p = this.player;
    const arr = this.pickups;
    for (let i = arr.length - 1; i >= 0; i--) {
      const o = arr[i];
      o.age += dt;
      o.life -= dt;

      // magnet / drift
      const dx = p.x - o.x;
      const dy = p.y - o.y;
      const d = Math.hypot(dx, dy) || 1;
      if (o.type === 'xp') {
        const mag = p.stats.magnet;
        if (d < mag) {
          const pull = (1 - d / mag) * 1500 + 260;
          o.vx += (dx / d) * pull * dt;
          o.vy += (dy / d) * pull * dt;
        }
        o.vx *= Math.exp(-1.6 * dt);
        o.vy *= Math.exp(-1.6 * dt);
      } else {
        o.vx *= Math.exp(-2.2 * dt);
        o.vy *= Math.exp(-2.2 * dt);
      }
      o.x += o.vx * dt;
      o.y += o.vy * dt;

      // collect
      const d2 = Math.hypot(p.x - o.x, p.y - o.y);
      if (d2 < p.r + o.r + 4) {
        if (o.type === 'xp') {
          p.gainXp(o.value);
          this.audio.pickup();
          this.fx.burst(o.x, o.y, {
            count: 4, colors: ['#7ef9ff', '#a06bff'], speedMin: 40, speedMax: 140,
            lifeMin: 0.1, lifeMax: 0.25, sizeMin: 1, sizeMax: 2,
          });
        } else if (o.type === 'health') {
          const healed = p.heal(o.value);
          if (healed > 0) {
            this.audio.health();
            this.fx.text(p.x, p.y - 26, '+' + Math.round(healed), { color: '#7dffb0', size: 15, life: 0.9, vy: -52 });
            p.healFlash(this);
          }
        }
        arr.splice(i, 1);
        continue;
      }

      if (o.life <= 0) arr.splice(i, 1);
    }
  }

  /* ---------------------------------------------------------------- combat helpers */
  nearestEnemy(x, y, maxDist = Infinity) {
    let best = null;
    let bd = maxDist * maxDist;
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = e; }
    }
    return best;
  }

  explode(x, y, radius, damage, color = '#ffb84d') {
    this.fx.ring(x, y, { r0: 5, r1: radius, life: 0.35, color, width: 4 });
    this.fx.burst(x, y, {
      count: 16, colors: [color, '#ffffff', '#ffd9a0'], speedMin: 60, speedMax: 330,
      lifeMin: 0.18, lifeMax: 0.5, sizeMin: 1.4, sizeMax: 4,
    });
    this.camera.addShake(3);
    this.audio.explode();
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      if (dist(x, y, e.x, e.y) < radius + e.r) e.hurt(damage, this, false);
    }
  }

  shockwave(x, y, radius, damage, color = '#35f0ff') {
    this.fx.ring(x, y, { r0: 8, r1: radius, life: 0.42, color, width: 5 });
    this.fx.ring(x, y, { r0: 8, r1: radius * 0.7, life: 0.3, color: '#ffffff', width: 2 });
    const es = this.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      if (e.dead) continue;
      const d = dist(x, y, e.x, e.y);
      if (d < radius + e.r) {
        const a = angTo(x, y, e.x, e.y);
        e.hurt(damage, this, false, Math.cos(a) * 260, Math.sin(a) * 260);
      }
    }
  }

  addScore(n) {
    this.score += Math.round(n);
  }

  addSplat(x, y, r, color) {
    const c = this.splatCtx;
    c.save();
    c.globalCompositeOperation = 'source-over';
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, rgba(color, 0.5));
    g.addColorStop(0.55, rgba(color, 0.24));
    g.addColorStop(1, rgba(color, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, TAU);
    c.fill();
    for (let i = 0; i < 7; i++) {
      const a = rand(0, TAU);
      const rr = rand(0, r * 0.95);
      const blob = rand(r * 0.06, r * 0.2);
      c.fillStyle = rgba(color, rand(0.12, 0.3));
      c.beginPath();
      c.arc(x + Math.cos(a) * rr, y + Math.sin(a) * rr, blob, 0, TAU);
      c.fill();
    }
    c.restore();
  }

  /* ---------------------------------------------------------------- level up */
  openLevelUp() {
    if (this.state === 'gameover') return;
    this.setState('levelup');
    this.audio.levelup();
    this.fx.ring(this.player.x, this.player.y, {
      r0: this.player.r, r1: this.player.r + 90, life: 0.6, color: '#a06bff', width: 4,
    });
    this.fx.burst(this.player.x, this.player.y, {
      count: 24, colors: ['#a06bff', '#c9a9ff', '#35f0ff', '#ffffff'],
      speedMin: 40, speedMax: 260, lifeMin: 0.3, lifeMax: 0.8, sizeMin: 1.5, sizeMax: 3.5,
    });
    this.el.levelupNum.textContent = String(this.player.level);
    this.buildCards();
  }

  buildCards() {
    const pool = UPGRADES.filter((u) => (this.taken[u.id] || 0) < u.max);
    const chosen = [];
    while (chosen.length < 3 && pool.length > 0) {
      let total = 0;
      for (const u of pool) total += u.weight || 10;
      let r = Math.random() * total;
      let idx = 0;
      for (; idx < pool.length; idx++) {
        r -= pool[idx].weight || 10;
        if (r <= 0) break;
      }
      idx = Math.min(idx, pool.length - 1);
      chosen.push(pool[idx]);
      pool.splice(idx, 1);
    }
    while (chosen.length < 3) chosen.push(REPAIR_CARD);
    this.cardChoices = chosen;

    const html = chosen.map((u, i) => {
      const taken = this.taken[u.id] || 0;
      const max = u.max >= 999 ? 0 : u.max;
      let pips = '';
      if (max > 0) {
        for (let k = 0; k < max; k++) {
          pips += `<span class="card-pip${k < taken ? ' on' : ''}"></span>`;
        }
      }
      const stackTxt = max > 0 ? `LEVEL ${taken + 1} / ${max}` : 'HEAL';
      return `<button class="card${u.rare ? ' rare' : ''}" data-i="${i}" style="animation-delay:${i * 55}ms">
        <span class="card-key">${i + 1}</span>
        <span class="card-icon">${u.icon}</span>
        <div class="card-name">${u.name}</div>
        <div class="card-desc">${u.desc}</div>
        <div class="card-foot">
          <span class="card-stack">${stackTxt}</span>
          <span class="card-pips">${pips}</span>
        </div>
      </button>`;
    }).join('');

    this.el.cards.innerHTML = html;
  }

  pickUpgrade(i) {
    if (this.state !== 'levelup') return;
    const u = this.cardChoices[i];
    if (!u) return;
    u.apply(this.player, this);
    this.taken[u.id] = (this.taken[u.id] || 0) + 1;
    this.pendingLevelUps = Math.max(0, this.pendingLevelUps - 1);
    this.refreshChips();
    this.audio.pickup();

    this.el.cards.innerHTML = '';
    this.el.levelupScreen.classList.remove('show');

    if (this.pendingLevelUps > 0) {
      this.state = 'playing'; // allow openLevelUp to re-trigger
      this.openLevelUp();
    } else {
      this.setState('playing');
      this.input.mouse.down = false;
    }
  }

  onPlayerDeath() {
    if (this.state === 'gameover') return;
    const p = this.player;
    this.camera.addShake(22);
    this.audio.explode();
    this.audio.gameover();
    this.fx.burst(p.x, p.y, {
      count: 80, colors: ['#7ef9ff', '#ffffff', '#ff4d6a', '#35f0ff'],
      speedMin: 60, speedMax: 560, lifeMin: 0.4, lifeMax: 1.4, sizeMin: 2, sizeMax: 6, drag: 2.2,
    });
    this.fx.ring(p.x, p.y, { r0: 10, r1: 280, life: 0.8, color: '#7ef9ff', width: 6 });

    let best = 0;
    try {
      best = parseInt(localStorage.getItem('alienShooterBest') || '0', 10) || 0;
      if (this.score > best) {
        best = this.score;
        localStorage.setItem('alienShooterBest', String(best));
      }
    } catch (err) { /* file:// storage may be blocked */ }

    const mm = Math.floor(this.elapsed / 60);
    const ss = String(Math.floor(this.elapsed % 60)).padStart(2, '0');
    this.el.goStats.innerHTML = [
      this._stat('SCORE', fmtNum(this.score), 'cyan'),
      this._stat('KỶ LỤC', fmtNum(best), 'amber'),
      this._stat('WAVE', String(this.wave), ''),
      this._stat('KILLS', String(this.kills), ''),
      this._stat('LEVEL', String(this.player.level), 'violet'),
      this._stat('THỜI GIAN', `${mm}:${ss}`, ''),
    ].join('');

    this.setState('gameover');
    this.el.hud.classList.add('hidden');
  }

  /* ---------------------------------------------------------------- HUD */
  refreshChips() {
    const s = this.player.stats;
    const chips = [
      `DMG <b>${Math.round(s.damage)}</b>`,
      `RATE <b>${s.fireRate.toFixed(1)}/s</b>`,
    ];
    if (s.multishot >= 1) chips.push(`MULTI <b>×${1 + Math.round(s.multishot)}</b>`);
    if (s.pierce >= 1) chips.push(`PIERCE <b>${s.pierce}</b>`);
    if (s.crit > 0.05) chips.push(`CRIT <b>${Math.round(s.crit * 100)}%</b>`);
    if (s.explosive > 0) chips.push('💥 <b>HE</b>');
    if (s.shockwave) chips.push('◎ <b>NOVA</b>');
    this.el.hudChips.innerHTML = chips.map((c) => `<span class="chip">${c}</span>`).join('');
  }

  updateHUD() {
    const p = this.player;
    const e = this.el;
    const remaining = this.enemies.length + this.spawnQueue.length + this.telegraphs.length;
    const hpPct = Math.round(p.hpRatio * 100);
    const xpPct = clamp((p.xp / p.xpNext) * 100, 0, 100);
    const dashPct = clamp(1 - p.dashCdTimer / p.stats.dashCd, 0, 1) * 100;

    const cache = this._cachedHud;
    if (cache.wave !== this.wave) { e.hudWave.textContent = String(this.wave).padStart(2, '0'); cache.wave = this.wave; }
    if (cache.rem !== remaining) { e.hudEnemies.textContent = String(remaining); cache.rem = remaining; }
    if (cache.score !== this.score) { e.hudScore.textContent = fmtNum(this.score); cache.score = this.score; }
    if (cache.level !== p.level) { e.hudLevel.textContent = String(p.level); cache.level = p.level; }

    e.hudHpFill.style.width = hpPct + '%';
    e.hudHpGhost.style.width = hpPct + '%';
    e.hudXpFill.style.width = xpPct + '%';
    e.hudDashFill.style.width = dashPct + '%';

    const hpTxt = `${Math.ceil(p.hp)} / ${p.stats.maxHp}`;
    if (cache.hpTxt !== hpTxt) { e.hudHpTxt.textContent = hpTxt; cache.hpTxt = hpTxt; }
    const low = hpPct <= 30;
    if (cache.low !== low) {
      e.hudHpFill.parentElement.classList.toggle('low', low);
      cache.low = low;
    }
  }

  banner(main, sub, cls) {
    const b = this.el.banner;
    this.el.bannerMain.textContent = main;
    this.el.bannerMain.className = 'banner-main' + (cls ? ' ' + cls : '');
    this.el.bannerSub.textContent = sub || '';
    b.classList.remove('show');
    void b.offsetWidth;
    b.classList.add('show');
  }

  /* ---------------------------------------------------------------- render */
  render() {
    const ctx = this.ctx;
    const cam = this.camera;
    const dpr = this.dpr;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#04060d';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;

    // camera transform (world -> device px)
    const z = cam.zoom;
    const shakeX = cam.ox * dpr;
    const shakeY = cam.oy * dpr;
    ctx.setTransform(z * dpr, 0, 0, z * dpr, (-cam.x * z) * dpr + shakeX, (-cam.y * z) * dpr + shakeY);

    this._drawFloor(ctx);
    this._drawDecor(ctx);
    this._drawStars(ctx);
    this._drawArena(ctx);

    // splat layer (visible region only)
    const vx = cam.x - 20;
    const vy = cam.y - 20;
    const vw = this.vw / z + 40;
    const vh = this.vh / z + 40;
    const sx = clamp(Math.floor(vx), 0, WORLD.w);
    const sy = clamp(Math.floor(vy), 0, WORLD.h);
    const sw = clamp(Math.ceil(vw), 0, WORLD.w - sx);
    const sh = clamp(Math.ceil(vh), 0, WORLD.h - sy);
    if (sw > 0 && sh > 0) ctx.drawImage(this.splatCanvas, sx, sy, sw, sh, sx, sy, sw, sh);

    this._drawTelegraphs(ctx);
    this._drawPickups(ctx);
    this._drawEnemies(ctx);
    this.player.draw(ctx, this);
    this._drawBullets(ctx);
    this.fx.drawParticles(ctx);
    this.fx.drawTexts(ctx);

    // ---------------- screen space ----------------
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._drawScreenFX(ctx);
  }

  _drawFloor(ctx) {
    const cam = this.camera;
    const z = cam.zoom;
    const x0 = cam.x - 40;
    const y0 = cam.y - 40;
    const w = this.vw / z + 80;
    const h = this.vh / z + 80;

    // base
    ctx.fillStyle = '#080d19';
    ctx.fillRect(x0, y0, w, h);

    // nebulas
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    if (!this.lowFx) for (const n of this.nebulas) {
      if (n.x + n.r < x0 || n.x - n.r > x0 + w || n.y + n.r < y0 || n.y - n.r > y0 + h) continue;
      const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
      g.addColorStop(0, n.c);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(n.x - n.r, n.y - n.r, n.r * 2, n.r * 2);
    }
    ctx.restore();

    // grid
    const step = 96;
    const gx0 = Math.floor(x0 / step) * step;
    const gy0 = Math.floor(y0 / step) * step;
    ctx.save();
    ctx.lineWidth = 1;
    for (let x = gx0; x < x0 + w; x += step) {
      const major = Math.round(x / step) % 4 === 0;
      ctx.strokeStyle = major ? 'rgba(95,175,255,0.20)' : 'rgba(95,175,255,0.075)';
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y0 + h);
      ctx.stroke();
    }
    for (let y = gy0; y < y0 + h; y += step) {
      const major = Math.round(y / step) % 4 === 0;
      ctx.strokeStyle = major ? 'rgba(95,175,255,0.20)' : 'rgba(95,175,255,0.075)';
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x0 + w, y);
      ctx.stroke();
    }
    ctx.restore();

    // soft light pool around the player
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.12;
    drawGlow(ctx, glowSprite('#35f0ff', 0.55), this.player.x, this.player.y, 380);
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _drawDecor(ctx) {
    const cam = this.camera;
    const z = cam.zoom;
    const x0 = cam.x - 80;
    const y0 = cam.y - 80;
    const w = this.vw / z + 160;
    const h = this.vh / z + 160;
    const t = performance.now() / 1000;

    for (let i = 0; i < this.decor.length; i++) {
      const d = this.decor[i];
      if (d.x + d.r < x0 || d.x - d.r > x0 + w || d.y + d.r < y0 || d.y - d.r > y0 + h) continue;

      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(d.rot);

      if (d.kind === 'rock') {
        ctx.beginPath();
        const n = d.pts.length;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * TAU;
          const rr = d.r * d.pts[k];
          const px = Math.cos(a) * rr;
          const py = Math.sin(a) * rr;
          if (k === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = '#0a1120';
        ctx.fill();
        ctx.strokeStyle = 'rgba(96,150,220,0.22)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        // inner facet
        ctx.beginPath();
        ctx.moveTo(-d.r * 0.35, -d.r * 0.3);
        ctx.lineTo(d.r * 0.2, -d.r * 0.55);
        ctx.lineTo(d.r * 0.45, d.r * 0.1);
        ctx.lineTo(-d.r * 0.1, d.r * 0.4);
        ctx.closePath();
        ctx.fillStyle = 'rgba(90,150,230,0.055)';
        ctx.fill();
      } else if (d.kind === 'crystal') {
        const glow = 0.55 + Math.sin(t * 1.6 + d.x * 0.01) * 0.2;
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, d.r * 2.6);
        g.addColorStop(0, rgba(d.hue, 0.18 * glow));
        g.addColorStop(1, rgba(d.hue, 0));
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, d.r * 2.6, 0, TAU);
        ctx.fill();

        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + 0.4;
          ctx.save();
          ctx.rotate(a);
          ctx.beginPath();
          ctx.moveTo(0, -d.r);
          ctx.lineTo(d.r * 0.34, d.r * 0.55);
          ctx.lineTo(-d.r * 0.34, d.r * 0.55);
          ctx.closePath();
          ctx.fillStyle = rgba(d.hue, 0.22);
          ctx.fill();
          ctx.strokeStyle = rgba(d.hue, 0.55 * glow);
          ctx.lineWidth = 1.2;
          ctx.stroke();
          ctx.restore();
        }
      } else {
        // alien egg cluster
        const pulse = 0.6 + Math.sin(t * 2.2 + d.x * 0.02) * 0.4;
        ctx.globalCompositeOperation = 'lighter';
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, d.r * 2.2);
        g.addColorStop(0, `rgba(80,255,150,${0.10 * pulse})`);
        g.addColorStop(1, 'rgba(80,255,150,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, d.r * 2.2, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';

        for (let k = 0; k < 3; k++) {
          const a = (k / 3) * TAU + d.x * 0.01;
          const ox = Math.cos(a) * d.r * 0.42;
          const oy = Math.sin(a) * d.r * 0.42;
          ctx.fillStyle = '#0a1a14';
          ctx.strokeStyle = `rgba(80,255,150,${0.3 + 0.25 * pulse})`;
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.ellipse(ox, oy, d.r * 0.36, d.r * 0.46, a, 0, TAU);
          ctx.fill();
          ctx.stroke();
          ctx.strokeStyle = `rgba(150,255,190,${0.25 + 0.2 * pulse})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(ox - d.r * 0.1, oy - d.r * 0.28);
          ctx.lineTo(ox + d.r * 0.1, oy + d.r * 0.2);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
  }

  _drawStars(ctx) {
    const cam = this.camera;
    const z = cam.zoom;
    const x0 = cam.x - 40;
    const y0 = cam.y - 40;
    const w = this.vw / z + 80;
    const h = this.vh / z + 80;
    const t = performance.now() / 1000;

    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const starStep = this.lowFx ? 2 : 1;
    for (let i = 0; i < this.stars.length; i += starStep) {
      const s = this.stars[i];
      if (s.x < x0 || s.x > x0 + w || s.y < y0 || s.y > y0 + h) continue;
      const a = s.a * (0.55 + 0.45 * Math.sin(t * s.sp + s.tw));
      ctx.globalAlpha = a;
      ctx.fillStyle = '#bfe6ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  _drawArena(ctx) {
    const pad = ARENA_PAD;
    const w = WORLD.w - pad * 2;
    const h = WORLD.h - pad * 2;
    const t = performance.now() / 1000;

    ctx.save();
    // inner glow field
    ctx.strokeStyle = 'rgba(53,240,255,0.34)';
    ctx.lineWidth = 3.5;
    ctx.shadowColor = 'rgba(53,240,255,0.55)';
    ctx.shadowBlur = 26;
    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, 26);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // second faint inner line
    ctx.strokeStyle = 'rgba(120,220,255,0.09)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(pad + 12, pad + 12, w - 24, h - 24, 20);
    ctx.stroke();

    // corner brackets
    const cl = 90;
    ctx.strokeStyle = 'rgba(53,240,255,0.6)';
    ctx.lineWidth = 5;
    const corners = [
      [pad, pad, 1, 1],
      [WORLD.w - pad, pad, -1, 1],
      [pad, WORLD.h - pad, 1, -1],
      [WORLD.w - pad, WORLD.h - pad, -1, -1],
    ];
    for (const [cx, cy, dx, dy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + dx * cl, cy);
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx, cy + dy * cl);
      ctx.stroke();
    }

    // hazard ticks along top/bottom
    ctx.strokeStyle = `rgba(255,77,157,${0.12 + 0.06 * Math.sin(t * 2)})`;
    ctx.lineWidth = 2;
    for (let x = pad + 140; x < WORLD.w - pad - 140; x += 90) {
      ctx.beginPath();
      ctx.moveTo(x, pad - 6);
      ctx.lineTo(x + 26, pad - 6);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, WORLD.h - pad + 6);
      ctx.lineTo(x + 26, WORLD.h - pad + 6);
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawTelegraphs(ctx) {
    const t = performance.now() / 1000;
    for (const g of this.telegraphs) {
      const p = 1 - clamp(g.t / g.total, 0, 1);
      const baseR = g.boss ? 74 : 34;
      const r = baseR * (1.1 - p * 0.35);
      const col = g.boss ? '#ff4d9d' : '#4dff9d';

      ctx.save();
      ctx.translate(g.x, g.y);
      ctx.globalCompositeOperation = 'lighter';

      // pulsing rings
      for (let i = 0; i < 2; i++) {
        const rr = r * (1 + i * 0.45) + Math.sin(t * 8 + i) * 3;
        ctx.globalAlpha = (0.5 - i * 0.18) * (0.5 + p * 0.5);
        ctx.strokeStyle = col;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(0, 0, rr, 0, TAU);
        ctx.stroke();
      }

      // progress arc
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = col;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.72, -Math.PI / 2, -Math.PI / 2 + TAU * p);
      ctx.stroke();

      // ground glow
      const grd = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      grd.addColorStop(0, rgba(col, 0.28 * p));
      grd.addColorStop(1, rgba(col, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fill();

      // rotating cross
      ctx.globalAlpha = 0.75;
      ctx.strokeStyle = col;
      ctx.lineWidth = 2;
      ctx.rotate(t * 2);
      for (let i = 0; i < 2; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.5, 0);
        ctx.lineTo(r * 0.5, 0);
        ctx.stroke();
        ctx.rotate(Math.PI / 2);
      }
      ctx.restore();
    }
  }

  _drawPickups(ctx) {
    const t = performance.now() / 1000;
    for (const o of this.pickups) {
      const fade = o.life < 3 && Math.floor(o.life * 6) % 2 === 0 ? 0.35 : 1;
      ctx.save();
      ctx.globalAlpha = fade;
      ctx.translate(o.x, o.y);

      if (o.type === 'xp') {
        const pulse = 1 + Math.sin(t * 8 + o.seed) * 0.18;
        ctx.globalCompositeOperation = 'lighter';
        drawGlow(ctx, glowSprite('#7ef9ff', 0.85), 0, 0, 16 * pulse);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(0, 0, 2.6, 0, TAU);
        ctx.fill();
      } else {
        // health crate
        ctx.rotate(Math.sin(t * 2 + o.seed) * 0.12);
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.85;
        drawGlow(ctx, glowSprite('#7dffb0', 0.6), 0, 0, 28);
        ctx.globalAlpha = fade;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(10,28,20,.92)';
        ctx.strokeStyle = '#7dffb0';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(-9, -9, 18, 18, 4);
        ctx.fill();
        ctx.stroke();
        ctx.strokeStyle = '#c9ffdd';
        ctx.lineWidth = 2.6;
        ctx.beginPath();
        ctx.moveTo(-4.5, 0); ctx.lineTo(4.5, 0);
        ctx.moveTo(0, -4.5); ctx.lineTo(0, 4.5);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  _drawEnemies(ctx) {
    for (const e of this.enemies) e.draw(ctx, this);
  }

  _drawBullets(ctx) {
    const bs = this.bullets;
    const t = performance.now() / 90;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';

    for (let i = 0; i < bs.length; i++) {
      const b = bs[i];
      if (b.hostile) {
        const pulse = 1 + Math.sin(t + b.x * 0.05) * 0.1;
        // outer halo
        ctx.globalAlpha = 0.32;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 2.2 * pulse, 0, TAU);
        ctx.fill();
        // body
        ctx.globalAlpha = 0.95;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.9, 0, TAU);
        ctx.fill();
        // hot core
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.42, 0, TAU);
        ctx.fill();
      } else {
        const a = Math.atan2(b.vy, b.vx);
        const len = 18 + b.r * 2.4;
        // trail
        ctx.globalAlpha = 0.3;
        ctx.strokeStyle = b.color;
        ctx.lineWidth = b.r * 1.7;
        ctx.beginPath();
        ctx.moveTo(b.x - Math.cos(a) * len, b.y - Math.sin(a) * len);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // bright core streak
        ctx.globalAlpha = 1;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = Math.max(1.2, b.r * 0.55);
        ctx.beginPath();
        ctx.moveTo(b.x - Math.cos(a) * len * 0.55, b.y - Math.sin(a) * len * 0.55);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        // head glow
        ctx.globalAlpha = 0.75;
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 1.7, 0, TAU);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.55, 0, TAU);
        ctx.fill();
        if (b.crit) {
          ctx.globalAlpha = 0.5 + Math.sin(t * 2) * 0.25;
          ctx.strokeStyle = '#ffe066';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(b.x, b.y, b.r * 3.2, 0, TAU);
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  _drawScreenFX(ctx) {
    const w = this.vw;
    const h = this.vh;
    const p = this.player;
    const t = performance.now() / 1000;

    // off-screen enemy indicators
    if (this.state === 'playing' || this.state === 'levelup' || this.state === 'paused') {
      const margin = 34;
      const cx = w / 2;
      const cy = h / 2;
      const shown = [];
      for (const e of this.enemies) {
        const sx = (e.x - this.camera.x) * this.camera.zoom;
        const sy = (e.y - this.camera.y) * this.camera.zoom;
        if (sx > -20 && sx < w + 20 && sy > -20 && sy < h + 20) continue;
        shown.push({ sx, sy, e });
        if (shown.length > 10) break;
      }
      for (const { sx, sy, e } of shown) {
        const dx = sx - cx;
        const dy = sy - cy;
        const a = Math.atan2(dy, dx);
        const ex = clamp(sx, margin, w - margin);
        const ey = clamp(sy, margin, h - margin);
        ctx.save();
        ctx.translate(ex, ey);
        ctx.rotate(a);
        ctx.globalAlpha = 0.6;
        ctx.fillStyle = e.isBoss ? '#ff4d9d' : e.def.color;
        ctx.beginPath();
        ctx.moveTo(10, 0);
        ctx.lineTo(-6, 6);
        ctx.lineTo(-3, 0);
        ctx.lineTo(-6, -6);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }

    // boss bar
    const boss = this.enemies.find((e) => e.isBoss);
    if (boss && this.bossAlive) {
      const bw = Math.min(w * 0.5, 560);
      const bx = (w - bw) / 2;
      const by = 52;
      const ratio = clamp(boss.hp / boss.maxHp, 0, 1);
      ctx.save();
      ctx.fillStyle = 'rgba(5,8,16,.72)';
      ctx.strokeStyle = 'rgba(255,77,157,.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.roundRect(bx - 2, by - 2, bw + 4, 16, 8);
      ctx.fill();
      ctx.stroke();

      const g = ctx.createLinearGradient(bx, 0, bx + bw, 0);
      g.addColorStop(0, '#ff2d6f');
      g.addColorStop(0.6, '#ff6ba8');
      g.addColorStop(1, '#ffb84d');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw * ratio, 12, 6);
      ctx.fill();

      ctx.font = '700 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(255,180,210,.9)';
      ctx.fillText((this.bossName || 'BOSS').toUpperCase(), w / 2, by - 8);
      ctx.restore();
    }

    // hurt vignette
    if (p.hurtFlash > 0) {
      const a = p.hurtFlash * 0.34;
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.25, w / 2, h / 2, Math.max(w, h) * 0.62);
      g.addColorStop(0, 'rgba(255,0,40,0)');
      g.addColorStop(1, `rgba(255,0,40,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // low hp pulse
    if (p.hpRatio < 0.3 && p.alive && this.state === 'playing') {
      const a = (0.16 + Math.sin(t * 5) * 0.07) * (1 - p.hpRatio / 0.3);
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.2, w / 2, h / 2, Math.max(w, h) * 0.6);
      g.addColorStop(0, 'rgba(255,0,40,0)');
      g.addColorStop(1, `rgba(255,0,40,${a})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    }

    // vignette (cached)
    if (this.vignette) ctx.drawImage(this.vignette, 0, 0, w, h);

    // crosshair
    if (!this.input.isTouch && this.state === 'playing') {
      const mx = this.input.mouse.sx;
      const my = this.input.mouse.sy;
      ctx.save();
      ctx.translate(mx, my);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = 'rgba(126,249,255,.9)';
      ctx.lineWidth = 1.6;
      const gap = 6;
      const len = 9;
      const rot = t * 0.8;
      ctx.rotate(rot);
      for (let i = 0; i < 4; i++) {
        ctx.beginPath();
        ctx.moveTo(gap, 0);
        ctx.lineTo(gap + len, 0);
        ctx.stroke();
        ctx.rotate(Math.PI / 2);
      }
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#7ef9ff';
      ctx.beginPath();
      ctx.arc(0, 0, 1.8, 0, TAU);
      ctx.fill();
      ctx.restore();
    }

    // touch sticks
    if (this.input.isTouch && this.state === 'playing') {
      const drawStick = (s, color) => {
        if (!s.active) return;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.5;
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(s.ox, s.oy, 52, 0, TAU);
        ctx.stroke();
        ctx.globalAlpha = 0.85;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(s.ox + s.dx, s.oy + s.dy, 22, 0, TAU);
        ctx.fill();
        ctx.restore();
      };
      drawStick(this.input.sticks.move, 'rgba(53,240,255,1)');
      drawStick(this.input.sticks.aim, 'rgba(255,77,157,1)');

      // dash button
      const db = this.input.dashButton();
      const ready = p.dashCdTimer <= 0;
      ctx.save();
      ctx.translate(db.x, db.y);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = ready ? 0.9 : 0.35;
      ctx.fillStyle = ready ? 'rgba(53,240,255,.14)' : 'rgba(53,240,255,.05)';
      ctx.beginPath();
      ctx.arc(0, 0, db.r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = ready ? '#35f0ff' : 'rgba(53,240,255,.45)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, db.r, 0, TAU);
      ctx.stroke();
      if (!ready) {
        const prog = 1 - clamp(p.dashCdTimer / p.stats.dashCd, 0, 1);
        ctx.globalAlpha = 0.95;
        ctx.strokeStyle = '#8dff6b';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.arc(0, 0, db.r - 3, -Math.PI / 2, -Math.PI / 2 + TAU * prog);
        ctx.stroke();
      }
      ctx.globalAlpha = ready ? 1 : 0.5;
      ctx.fillStyle = '#d8f7ff';
      ctx.font = '800 10px ui-monospace, Menlo, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('DASH', 0, 0);
      ctx.restore();
    }
  }
}

/* ------------------------------------------------------------------ boot */
function bootAlienShooter() {
  if (!window.GAME) window.GAME = new Game();
}
if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootAlienShooter);
} else {
  bootAlienShooter();
}
