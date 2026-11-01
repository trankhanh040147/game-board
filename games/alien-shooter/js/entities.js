'use strict';
/* =========================================================================
   ALIEN SHOOTER — entities.js
   Player ship · alien species · bullet & pickup helpers
   ========================================================================= */

const WORLD = { w: 2800, h: 1900 };
const ARENA_PAD = 70;

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${a})`;
}
function shade(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * k, 0, 255) | 0;
  const g = clamp(((n >> 8) & 255) * k, 0, 255) | 0;
  const b = clamp((n & 255) * k, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
}

/* soft dark disc so the player never gets lost in a swarm */
let _playerDisc = null;
function playerDiscSprite() {
  if (_playerDisc) return _playerDisc;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const half = size / 2;
  const grd = g.createRadialGradient(half, half, 0, half, half, half);
  grd.addColorStop(0, 'rgba(2,5,10,0.88)');
  grd.addColorStop(0.5, 'rgba(2,5,10,0.6)');
  grd.addColorStop(0.78, 'rgba(2,5,10,0.22)');
  grd.addColorStop(1, 'rgba(2,5,10,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  _playerDisc = c;
  return c;
}

const ENEMY_DEFS = {
  crawler: {
    name: 'Crawler', hp: 16, speed: 94, r: 16, dmg: 7, xp: 3, score: 10,
    color: '#4dff9d', glow: '#00ff88', legs: 5,
  },
  skitter: {
    name: 'Skitter', hp: 11, speed: 196, r: 13, dmg: 7, xp: 3, score: 14,
    color: '#e2ff5c', glow: '#b6ff00', legs: 4,
  },
  spitter: {
    name: 'Spitter', hp: 28, speed: 82, r: 19, dmg: 7, xp: 7, score: 24,
    color: '#c07bff', glow: '#a24bff', legs: 6,
  },
  brute: {
    name: 'Brute', hp: 95, speed: 54, r: 30, dmg: 16, xp: 16, score: 50,
    color: '#ff8a5c', glow: '#ff4d1f', legs: 6,
  },
  boss: {
    name: 'HIVE QUEEN', hp: 620, speed: 62, r: 52, dmg: 22, xp: 150, score: 500,
    color: '#ff4d9d', glow: '#ff1f86', legs: 10,
    boss: true,
  },
};

/* =========================================================================
   PLAYER
   ========================================================================= */
class Player {
  constructor(game) {
    this.game = game;
    this.reset();
  }

  reset() {
    this.x = WORLD.w / 2;
    this.y = WORLD.h / 2;
    this.vx = 0;
    this.vy = 0;
    this.r = 16;
    this.aim = -Math.PI / 2;

    this.stats = {
      maxHp: 100,
      speed: 305,
      damage: 9,
      fireRate: 3.4,
      bulletSpeed: 790,
      bulletSize: 1,
      pierce: 0,
      multishot: 0,
      crit: 0.05,
      critMult: 2.2,
      regen: 0,
      magnet: 155,
      dashCd: 1.5,
      xpGain: 1,
      explosive: 0,
      shockwave: false,
      drones: 0,
    };

    this.hp = this.stats.maxHp;
    this.level = 1;
    this.xp = 0;
    this.xpNext = 6;

    this.fireTimer = 0;
    this.dashTime = 0;
    this.dashCdTimer = 0;
    this.dashDir = { x: 0, y: -1 };
    this.invuln = 0;
    this.hurtFlash = 0;
    this.recoil = 0;
    this.muzzle = 0;
    this.ghosts = [];
    this.ghostTimer = 0;
    this.drones = [];
    this.bob = 0;
  }

  get alive() { return this.hp > 0; }
  get hpRatio() { return clamp(this.hp / this.stats.maxHp, 0, 1); }

  gainXp(v) {
    this.xp += v * this.stats.xpGain;
    while (this.xp >= this.xpNext) {
      this.xp -= this.xpNext;
      this.level++;
      this.xpNext = Math.round(6 + (this.level - 1) * 4.6 + Math.pow(this.level, 1.35));
      this.game.pendingLevelUps++;
    }
  }

  heal(v) {
    const before = this.hp;
    this.hp = Math.min(this.stats.maxHp, this.hp + v);
    return this.hp - before;
  }

  hurt(dmg, game, sx, sy) {
    if (this.invuln > 0 || !this.alive) return false;
    this.hp -= dmg;
    this.invuln = 0.6;
    this.hurtFlash = 1;
    game.camera.addShake(7);
    game.fx.ring(this.x, this.y, { r0: this.r, r1: this.r * 4.2, life: 0.36, color: '#ff4d6a', width: 3 });
    game.fx.burst(this.x, this.y, {
      count: 14, colors: ['#ff4d6a', '#ff9d6b', '#ffffff'], speedMin: 90, speedMax: 320,
      lifeMin: 0.2, lifeMax: 0.5, sizeMin: 1.5, sizeMax: 3.6,
    });
    game.audio.hurt();
    if (this.hp <= 0) {
      this.hp = 0;
      game.onPlayerDeath();
    }
    return true;
  }

  healFlash(game) {
    this.invuln = Math.max(this.invuln, 0.25);
    game.fx.ring(this.x, this.y, { r0: this.r, r1: this.r * 3.4, life: 0.45, color: '#7dffb0', width: 2.5 });
  }

  startDash(game, axis) {
    const dir = (axis.x || axis.y)
      ? { x: axis.x, y: axis.y }
      : { x: Math.cos(this.aim), y: Math.sin(this.aim) };
    const l = Math.hypot(dir.x, dir.y) || 1;
    this.dashDir = { x: dir.x / l, y: dir.y / l };
    this.dashTime = 0.17;
    this.dashCdTimer = this.stats.dashCd;
    this.invuln = Math.max(this.invuln, 0.34);
    game.audio.dash();
    game.camera.addShake(2.5);
    game.fx.ring(this.x, this.y, { r0: 8, r1: 62, life: 0.32, color: '#35f0ff', width: 2.5 });
    game.fx.burst(this.x, this.y, {
      count: 16, dir: Math.atan2(-this.dashDir.y, -this.dashDir.x), cone: 0.9,
      speedMin: 120, speedMax: 380, colors: ['#35f0ff', '#a6f4ff', '#ffffff'],
      lifeMin: 0.18, lifeMax: 0.45, sizeMin: 1.2, sizeMax: 3,
    });
    if (this.stats.shockwave) {
      game.shockwave(this.x, this.y, 170, this.stats.damage * 2.4, '#35f0ff');
    }
  }

  update(dt, game) {
    const s = this.stats;
    const inp = game.input;
    const axis = inp.moveAxis();

    /* ---------------- movement ---------------- */
    if (this.dashTime > 0) {
      this.dashTime -= dt;
      const sp = 980;
      this.vx = this.dashDir.x * sp;
      this.vy = this.dashDir.y * sp;
      this.ghostTimer -= dt;
      if (this.ghostTimer <= 0) {
        this.ghostTimer = 0.022;
        this.ghosts.push({ x: this.x, y: this.y, a: this.aim, life: 0.3, max: 0.3 });
      }
    } else {
      const moving = Math.hypot(axis.x, axis.y) > 0.01;
      const k = 1 - Math.exp(-(moving ? 15 : 11) * dt);
      this.vx = lerp(this.vx, axis.x * s.speed, k);
      this.vy = lerp(this.vy, axis.y * s.speed, k);
      this.ghostTimer -= dt;
      if (Math.hypot(this.vx, this.vy) > s.speed * 0.75 && this.ghostTimer <= 0) {
        this.ghostTimer = 0.075;
        this.ghosts.push({ x: this.x, y: this.y, a: this.aim, life: 0.18, max: 0.18 });
      }
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.x = clamp(this.x, ARENA_PAD + this.r, WORLD.w - ARENA_PAD - this.r);
    this.y = clamp(this.y, ARENA_PAD + this.r, WORLD.h - ARENA_PAD - this.r);

    /* ---------------- aim ---------------- */
    const aimV = inp.aimVector();
    if (aimV.active) {
      this.aim = Math.atan2(aimV.y, aimV.x);
    } else if (inp.isTouch) {
      const t = game.nearestEnemy(this.x, this.y, 620);
      if (t) this.aim = angTo(this.x, this.y, t.x, t.y);
    } else {
      const m = game.camera.toWorld(inp.mouse.sx, inp.mouse.sy);
      if (Math.hypot(m.x - this.x, m.y - this.y) > 14) {
        this.aim = Math.atan2(m.y - this.y, m.x - this.x);
      }
    }

    /* ---------------- timers ---------------- */
    if (this.invuln > 0) this.invuln -= dt;
    if (this.dashCdTimer > 0) this.dashCdTimer -= dt;
    this.hurtFlash = Math.max(0, this.hurtFlash - dt * 2.4);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    this.muzzle = Math.max(0, this.muzzle - dt * 16);
    this.bob += dt;
    if (s.regen > 0 && this.hp > 0) this.hp = Math.min(s.maxHp, this.hp + s.regen * dt);

    /* ---------------- dash ---------------- */
    if (this.dashCdTimer <= 0 && (inp.wasPressed('Space') || inp.consumeDash())) {
      this.startDash(game, axis);
    }

    /* ---------------- shooting ---------------- */
    this.fireTimer -= dt;
    const wantFire = inp.fireHeld && game.state === 'playing';
    if (wantFire && this.fireTimer <= 0) {
      this.fire(game);
      this.fireTimer = Math.max(this.fireTimer + 1 / s.fireRate, -0.05);
    }
    if (!wantFire && this.fireTimer < 0) this.fireTimer = 0;

    /* ---------------- ghost decay ---------------- */
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      this.ghosts[i].life -= dt;
      if (this.ghosts[i].life <= 0) this.ghosts.splice(i, 1);
    }

    /* ---------------- drones ---------------- */
    this.updateDrones(dt, game);
  }

  fire(game) {
    const s = this.stats;
    const n = 1 + Math.round(s.multishot);
    const arc = n > 1 ? 0.14 + 0.085 * (n - 1) : 0;
    const mx = this.x + Math.cos(this.aim) * (this.r + 9);
    const my = this.y + Math.sin(this.aim) * (this.r + 9);

    for (let i = 0; i < n; i++) {
      const off = n === 1 ? 0 : lerp(-arc / 2, arc / 2, i / (n - 1));
      const a = this.aim + off + rand(-0.018, 0.018);
      const crit = Math.random() < s.crit;
      const dmg = s.damage * (crit ? s.critMult : 1);
      game.spawnBullet({
        x: mx, y: my,
        vx: Math.cos(a) * s.bulletSpeed * rand(0.97, 1.03),
        vy: Math.sin(a) * s.bulletSpeed * rand(0.97, 1.03),
        r: 4.2 * s.bulletSize * (crit ? 1.4 : 1),
        damage: dmg,
        pierce: s.pierce,
        hostile: false,
        crit,
        explosive: s.explosive,
        color: crit ? '#ffe066' : '#7ef9ff',
        life: 1.35,
      });
    }

    this.recoil = 1;
    this.muzzle = 1;
    game.fx.burst(mx, my, {
      count: 5, dir: this.aim, cone: 0.45, speedMin: 90, speedMax: 300,
      colors: ['#7ef9ff', '#ffffff', '#bff8ff'], lifeMin: 0.08, lifeMax: 0.22,
      sizeMin: 1, sizeMax: 2.6, drag: 6,
    });
    game.camera.addShake(0.75);
    game.audio.shoot();
  }

  updateDrones(dt, game) {
    if (this.stats.drones <= 0) { this.drones.length = 0; return; }
    while (this.drones.length < this.stats.drones) {
      this.drones.push({ a: rand(0, TAU), t: rand(0, 1) });
    }
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      d.a += dt * 1.5;
      d.t -= dt;
      const ox = Math.cos(d.a) * 46;
      const oy = Math.sin(d.a) * 46;
      d.x = this.x + ox;
      d.y = this.y + oy;
      if (d.t <= 0) {
        const target = game.nearestEnemy(d.x, d.y, 460);
        d.t = 1.05;
        if (target) {
          const a = angTo(d.x, d.y, target.x, target.y);
          game.spawnBullet({
            x: d.x, y: d.y, vx: Math.cos(a) * 720, vy: Math.sin(a) * 720,
            r: 3, damage: this.stats.damage * 0.55, pierce: 0, hostile: false,
            crit: false, explosive: 0, color: '#a06bff', life: 1,
          });
          game.fx.burst(d.x, d.y, { count: 3, dir: a, cone: 0.4, speedMin: 60, speedMax: 160, colors: ['#a06bff'], lifeMin: 0.06, lifeMax: 0.16, sizeMin: 1, sizeMax: 2 });
        }
      }
    }
  }

  /* ---------------- drawing ---------------- */
  draw(ctx, game) {
    const t = performance.now() / 1000;

    // dash ghosts
    for (let i = 0; i < this.ghosts.length; i++) {
      const g = this.ghosts[i];
      const k = g.life / g.max;
      ctx.save();
      ctx.globalAlpha = k * 0.32;
      ctx.globalCompositeOperation = 'lighter';
      ctx.translate(g.x, g.y);
      ctx.rotate(g.a);
      ctx.fillStyle = '#35f0ff';
      ctx.beginPath();
      ctx.moveTo(20, 0);
      ctx.lineTo(-10, 12);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-10, -12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // shadow
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(this.x + 3, this.y + 15, 20, 8, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // aura
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const pulse = 0.55 + Math.sin(t * 4) * 0.12;
    ctx.globalAlpha = 0.34 + pulse * 0.18;
    drawGlow(ctx, glowSprite('#35f0ff', 0.45), this.x, this.y, 74);
    ctx.globalAlpha = 1;
    // rotating targeting ring
    ctx.globalAlpha = 0.4 + Math.sin(t * 3) * 0.12;
    ctx.strokeStyle = 'rgba(126,249,255,.55)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([7, 11]);
    ctx.lineDashOffset = -t * 22;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 30, 0, TAU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    // contrast disc + bright rim so the ship pops out of a swarm
    ctx.save();
    ctx.drawImage(playerDiscSprite(), this.x - 34, this.y - 34, 68, 68);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + Math.sin(t * 5) * 0.12;
    ctx.strokeStyle = 'rgba(150,250,255,.9)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 23, 0, TAU);
    ctx.stroke();
    ctx.restore();

    // hull
    ctx.save();
    ctx.translate(this.x, this.y);
    ctx.rotate(this.aim);
    ctx.scale(1.1, 1.1);

    const hurt = this.hurtFlash;
    const bodyFill = hurt > 0.02 ? `rgba(255,${Math.round(120 + 100 * (1 - hurt))},140,1)` : '#143356';

    // engine flames
    const thrust = Math.hypot(this.vx, this.vy) / this.stats.speed;
    for (let i = -1; i <= 1; i += 2) {
      const fy = i * 5.5;
      const len = 10 + thrust * 16 + Math.sin(t * 30 + i) * 3;
      const fg = ctx.createLinearGradient(-8, fy, -8 - len, fy);
      fg.addColorStop(0, 'rgba(120,250,255,.95)');
      fg.addColorStop(0.5, 'rgba(53,240,255,.55)');
      fg.addColorStop(1, 'rgba(53,240,255,0)');
      ctx.fillStyle = fg;
      ctx.beginPath();
      ctx.moveTo(-6, fy - 3.4);
      ctx.lineTo(-6 - len, fy);
      ctx.lineTo(-6, fy + 3.4);
      ctx.closePath();
      ctx.fill();
    }

    // wings
    ctx.fillStyle = '#1b3e63';
    ctx.strokeStyle = 'rgba(126,249,255,.8)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(16, 0);
    ctx.lineTo(-4, 15);
    ctx.lineTo(-12, 11);
    ctx.lineTo(-8, 0);
    ctx.lineTo(-12, -11);
    ctx.lineTo(-4, -15);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // core hull
    ctx.fillStyle = bodyFill;
    ctx.beginPath();
    ctx.moveTo(22, 0);
    ctx.lineTo(-2, 8.5);
    ctx.lineTo(-10, 0);
    ctx.lineTo(-2, -8.5);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = hurt > 0.02 ? '#ff8fa8' : '#a8fbff';
    ctx.lineWidth = 2;
    ctx.stroke();
    // nose highlight
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(21, 0);
    ctx.lineTo(6, 0);
    ctx.stroke();

    // cockpit
    const cg = ctx.createRadialGradient(2, 0, 0, 2, 0, 8);
    cg.addColorStop(0, '#ffffff');
    cg.addColorStop(0.38, '#b9faff');
    cg.addColorStop(1, 'rgba(53,240,255,0)');
    ctx.fillStyle = cg;
    ctx.beginPath();
    ctx.arc(2, 0, 8, 0, TAU);
    ctx.fill();

    // cannon
    const rec = this.recoil * 3;
    ctx.fillStyle = '#22456b';
    ctx.strokeStyle = 'rgba(150,240,255,.7)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(10 - rec, -3, 13, 6, 2);
    ctx.fill();
    ctx.stroke();

    // muzzle flash
    if (this.muzzle > 0.02) {
      const mf = this.muzzle;
      ctx.globalCompositeOperation = 'lighter';
      const mg = ctx.createRadialGradient(24, 0, 0, 24, 0, 18 * mf + 6);
      mg.addColorStop(0, `rgba(255,255,255,${0.95 * mf})`);
      mg.addColorStop(0.4, `rgba(126,249,255,${0.6 * mf})`);
      mg.addColorStop(1, 'rgba(126,249,255,0)');
      ctx.fillStyle = mg;
      ctx.beginPath();
      ctx.arc(24, 0, 18 * mf + 6, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // invulnerability ring
    if (this.invuln > 0) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(this.invuln * 1.6, 0, 0.85);
      ctx.strokeStyle = '#9ff6ff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.r + 9 + Math.sin(t * 18) * 2, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }

    // drones
    for (let i = 0; i < this.drones.length; i++) {
      const d = this.drones[i];
      if (d.x == null) continue;
      ctx.save();
      ctx.translate(d.x, d.y);
      ctx.rotate(t * 3 + i);
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = '#c9a9ff';
      ctx.beginPath();
      ctx.moveTo(7, 0);
      ctx.lineTo(-5, 5);
      ctx.lineTo(-2, 0);
      ctx.lineTo(-5, -5);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,107,255,.8)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, TAU);
      ctx.stroke();
      ctx.restore();
    }
  }
}

/* =========================================================================
   ENEMIES
   ========================================================================= */
let ENEMY_ID = 0;

class Enemy {
  constructor(game, type, x, y) {
    const def = ENEMY_DEFS[type];
    const wave = game.wave;
    this.id = ++ENEMY_ID;
    this.type = type;
    this.def = def;
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.r = def.r;

    const hpMul = 1 + (wave - 1) * 0.27;
    const bossMul = def.boss ? 1 + (wave / 5 - 1) * 0.62 : 1;
    this.maxHp = Math.round(def.hp * hpMul * bossMul);
    this.hp = this.maxHp;
    this.speed = def.speed * Math.min(1.6, 1 + (wave - 1) * 0.038);
    this.dmg = def.dmg * (1 + (wave - 1) * 0.13);

    this.seed = rand(0, TAU);
    this.age = 0;
    this.facing = rand(0, TAU);
    this.flash = 0;
    this.dead = false;
    this.touchCd = 0.35;
    this.attackTimer = rand(0.9, 2.2);
    this.charge = 0;
    this.bossIndex = 0;
    this.bossDash = 0;
    this.bossDashDir = { x: 0, y: 0 };
    this.bossWindup = 0;
    this.spawnAnim = 0.45;
    this.radiusBase = def.r;
  }

  get isBoss() { return !!this.def.boss; }

  update(dt, game) {
    this.age += dt;
    this.spawnAnim = Math.max(0, this.spawnAnim - dt);
    this.flash = Math.max(0, this.flash - dt * 4.5);
    if (this.touchCd > 0) this.touchCd -= dt;

    const p = game.player;
    const d = dist(this.x, this.y, p.x, p.y) || 1;
    const ang = angTo(this.x, this.y, p.x, p.y);
    let dvx = 0;
    let dvy = 0;

    switch (this.type) {
      case 'crawler': {
        const wob = Math.sin(this.age * 3.1 + this.seed) * 0.38;
        const a = ang + wob;
        dvx = Math.cos(a) * this.speed;
        dvy = Math.sin(a) * this.speed;
        break;
      }
      case 'skitter': {
        const wob = Math.sin(this.age * 8.4 + this.seed);
        const a = ang + wob * 1.05;
        const burst = 1 + 0.5 * Math.max(0, Math.sin(this.age * 2.4 + this.seed));
        dvx = Math.cos(a) * this.speed * burst;
        dvy = Math.sin(a) * this.speed * burst;
        break;
      }
      case 'spitter': {
        let a = ang;
        if (d < 260) a = ang + Math.PI;
        else if (d < 360) a = ang + Math.PI / 2 * sign(Math.sin(this.age * 0.9 + this.seed));
        dvx = Math.cos(a) * this.speed;
        dvy = Math.sin(a) * this.speed;

        this.attackTimer -= dt;
        if (this.attackTimer <= 0) {
          this.attackTimer = rand(1.9, 2.8);
          this.charge = 0.42;
        }
        if (this.charge > 0) {
          this.charge -= dt;
          if (this.charge <= 0 && d < 900) {
            const lead = 0.28;
            const tx = p.x + p.vx * lead;
            const ty = p.y + p.vy * lead;
            const a2 = angTo(this.x, this.y, tx, ty);
            game.spawnBullet({
              x: this.x + Math.cos(a2) * (this.r + 6),
              y: this.y + Math.sin(a2) * (this.r + 6),
              vx: Math.cos(a2) * 300, vy: Math.sin(a2) * 300,
              r: 7, damage: this.dmg, pierce: 0, hostile: true,
              color: '#c07bff', life: 4.2,
            });
            game.audio.enemyShoot();
            game.fx.burst(this.x + Math.cos(a2) * this.r, this.y + Math.sin(a2) * this.r, {
              count: 6, dir: a2, cone: 0.5, speedMin: 60, speedMax: 200,
              colors: ['#c07bff', '#e9c6ff'], lifeMin: 0.1, lifeMax: 0.3, sizeMin: 1, sizeMax: 2.6,
            });
          }
        }
        break;
      }
      case 'brute': {
        const enraged = this.hp / this.maxHp < 0.42;
        const sp = this.speed * (enraged ? 1.4 : 1);
        const wob = Math.sin(this.age * 1.7 + this.seed) * 0.2;
        dvx = Math.cos(ang + wob) * sp;
        dvy = Math.sin(ang + wob) * sp;
        break;
      }
      case 'boss': {
        this.updateBoss(dt, game, d, ang);
        dvx = this._dvx || 0;
        dvy = this._dvy || 0;
        break;
      }
    }

    if (!this.isBoss) this.facing = angLerp(this.facing, ang, 1 - Math.exp(-7.5 * dt));

    const k = 1 - Math.exp(-5.5 * dt);
    this.vx = lerp(this.vx, dvx, k);
    this.vy = lerp(this.vy, dvy, k);

    // keep some distance from the player's body (soft push)
    if (d < this.r + p.r + 4) {
      const push = (this.r + p.r + 4 - d) * 4;
      this.vx -= Math.cos(ang) * push;
      this.vy -= Math.sin(ang) * push;
    }

    this.x += this.vx * dt;
    this.y += this.vy * dt;

    // walls
    const pad = ARENA_PAD + this.r;
    if (this.x < pad) { this.x = pad; this.vx = Math.abs(this.vx) * 0.35; }
    if (this.x > WORLD.w - pad) { this.x = WORLD.w - pad; this.vx = -Math.abs(this.vx) * 0.35; }
    if (this.y < pad) { this.y = pad; this.vy = Math.abs(this.vy) * 0.35; }
    if (this.y > WORLD.h - pad) { this.y = WORLD.h - pad; this.vy = -Math.abs(this.vy) * 0.35; }

    // contact damage
    if (this.touchCd <= 0 && d < this.r + p.r + 2 && p.alive) {
      if (p.hurt(this.dmg, game, this.x, this.y)) {
        this.touchCd = 0.85;
        const knock = 320;
        p.vx += Math.cos(ang) * knock;
        p.vy += Math.sin(ang) * knock;
        this.vx -= Math.cos(ang) * 120;
        this.vy -= Math.sin(ang) * 120;
      }
    }
  }

  updateBoss(dt, game, d, ang) {
    const p = game.player;
    // orbital approach
    const wantR = 330;
    let mvx = 0, mvy = 0;
    if (d > wantR + 60) {
      mvx = Math.cos(ang) * this.speed;
      mvy = Math.sin(ang) * this.speed;
    } else if (d < wantR - 90) {
      mvx = -Math.cos(ang) * this.speed * 0.9;
      mvy = -Math.sin(ang) * this.speed * 0.9;
    } else {
      const tangent = ang + Math.PI / 2;
      mvx = Math.cos(tangent) * this.speed * 0.75;
      mvy = Math.sin(tangent) * this.speed * 0.75;
    }

    // wind-up / dash attack
    if (this.bossDash > 0) {
      this.bossDash -= dt;
      mvx = this.bossDashDir.x * 780;
      mvy = this.bossDashDir.y * 780;
      game.fx.burst(this.x, this.y, {
        count: 2, colors: ['#ff4d9d', '#ff9dd0'], speedMin: 30, speedMax: 120,
        lifeMin: 0.15, lifeMax: 0.4, sizeMin: 2, sizeMax: 5,
      });
    } else if (this.bossWindup > 0) {
      this.bossWindup -= dt;
      mvx *= 0.15;
      mvy *= 0.15;
      const glow = 1 - this.bossWindup / 0.7;
      game.fx.burst(this.x + rand(-50, 50), this.y + rand(-50, 50), {
        count: 1, colors: ['#ff4d9d'], speedMin: 20, speedMax: 90,
        lifeMin: 0.2, lifeMax: 0.45, sizeMin: 2, sizeMax: 4,
      });
      if (this.bossWindup <= 0) {
        this.bossDash = 0.34;
        this.bossDashDir = { x: Math.cos(ang), y: Math.sin(ang) };
        game.camera.addShake(6);
        game.fx.ring(this.x, this.y, { r0: 20, r1: 150, life: 0.3, color: '#ff4d9d', width: 4 });
      }
    } else {
      this.attackTimer -= dt;
      if (this.attackTimer <= 0) {
        this.attackTimer = clamp(2.5 - game.wave * 0.02, 1.35, 2.6);
        this.doBossAttack(game, ang);
      }
    }

    this._dvx = mvx;
    this._dvy = mvy;
  }

  doBossAttack(game, ang) {
    const idx = this.bossIndex % 4;
    this.bossIndex++;
    const p = game.player;

    if (idx === 0) {
      // radial ring
      const n = 16;
      const off = rand(0, TAU);
      for (let i = 0; i < n; i++) {
        const a = off + (i / n) * TAU;
        game.spawnBullet({
          x: this.x + Math.cos(a) * (this.r + 4), y: this.y + Math.sin(a) * (this.r + 4),
          vx: Math.cos(a) * 215, vy: Math.sin(a) * 215,
          r: 8, damage: this.dmg * 0.7, hostile: true, color: '#ff4d9d', life: 5,
        });
      }
      game.audio.explode();
      game.camera.addShake(5);
      game.fx.ring(this.x, this.y, { r0: this.r, r1: this.r + 110, life: 0.4, color: '#ff4d9d', width: 4 });
    } else if (idx === 1) {
      // aimed triple
      for (let i = -1; i <= 1; i++) {
        const a = ang + i * 0.19;
        game.spawnBullet({
          x: this.x + Math.cos(a) * (this.r + 4), y: this.y + Math.sin(a) * (this.r + 4),
          vx: Math.cos(a) * 380, vy: Math.sin(a) * 380,
          r: 9, damage: this.dmg * 0.75, hostile: true, color: '#ffb84d', life: 4,
        });
      }
      game.audio.enemyShoot();
    } else if (idx === 2) {
      // summon
      if (game.enemies.length < 42) {
        const n = 2 + Math.floor(game.wave / 5);
        for (let i = 0; i < n; i++) {
          const a = rand(0, TAU);
          const x = clamp(this.x + Math.cos(a) * 90, ARENA_PAD + 40, WORLD.w - ARENA_PAD - 40);
          const y = clamp(this.y + Math.sin(a) * 90, ARENA_PAD + 40, WORLD.h - ARENA_PAD - 40);
          game.spawnEnemyAt('crawler', x, y);
          game.fx.ring(x, y, { r0: 4, r1: 40, life: 0.4, color: '#4dff9d', width: 2 });
        }
      }
      game.audio.waveStart();
    } else {
      // charge
      this.bossWindup = 0.7;
      game.audio.boss();
      game.fx.text(this.x, this.y - this.r - 24, '!', { color: '#ff4d9d', size: 34, life: 0.75, vy: -10 });
      game.camera.addShake(4);
    }
  }

  hurt(dmg, game, crit, kx = 0, ky = 0) {
    if (this.dead) return;
    this.hp -= dmg;
    this.flash = 1;
    this.vx += kx;
    this.vy += ky;
    if (crit) {
      game.fx.text(this.x + rand(-8, 8), this.y - this.r - 8, Math.round(dmg) + '!', {
        color: '#ffe066', size: 17, life: 0.75, vy: -62,
      });
    } else {
      game.fx.text(this.x + rand(-8, 8), this.y - this.r - 6, String(Math.round(dmg)), {
        color: '#dff3ff', size: 12, life: 0.55, vy: -50,
      });
    }
    if (this.hp <= 0) this.die(game);
  }

  die(game) {
    if (this.dead) return;
    this.dead = true;
    game.kills++;
    game.addScore(Math.round(this.def.score * (1 + game.wave * 0.03)));

    const col = this.def.color;
    const glow = this.def.glow;
    game.fx.burst(this.x, this.y, {
      count: this.isBoss ? 90 : this.def.r > 20 ? 30 : 16,
      colors: [col, glow, '#ffffff', shade(col, 0.6)],
      speedMin: 40, speedMax: this.isBoss ? 520 : 300,
      lifeMin: 0.25, lifeMax: this.isBoss ? 1.1 : 0.7,
      sizeMin: 1.4, sizeMax: this.isBoss ? 7 : 4,
      drag: 2.4,
    });
    game.fx.ring(this.x, this.y, {
      r0: this.r * 0.5, r1: this.r * (this.isBoss ? 8 : 3.2),
      life: this.isBoss ? 0.8 : 0.4, color: col, width: this.isBoss ? 8 : 2.5,
    });
    game.addSplat(this.x, this.y, this.r * (this.isBoss ? 2.4 : 1.3), col);

    if (this.isBoss) {
      game.camera.addShake(18);
      game.audio.explode();
      for (let i = 0; i < 5; i++) {
        setTimeout(() => {
          if (game.state === 'title') return;
          const a = rand(0, TAU);
          const rr = rand(0, 70);
          game.fx.burst(this.x + Math.cos(a) * rr, this.y + Math.sin(a) * rr, {
            count: 16, colors: ['#ff4d9d', '#ffb84d', '#ffffff', '#a24bff'],
            speedMin: 60, speedMax: 320, lifeMin: 0.3, lifeMax: 0.9, sizeMin: 2, sizeMax: 6,
          });
          game.audio.explode();
        }, i * 90);
      }
      game.bossAlive = false;
      game.bossJustDied = true;
    } else {
      game.audio.kill();
      game.camera.addShake(this.def.r > 20 ? 4 : 1.4);
    }

    // xp orbs
    const orbCount = this.isBoss ? 14 : this.def.xp >= 12 ? 4 : this.def.xp >= 6 ? 2 : 1;
    const per = this.def.xp / orbCount;
    for (let i = 0; i < orbCount; i++) {
      const a = rand(0, TAU);
      const sp = rand(20, 95);
      game.pickups.push({
        type: 'xp', x: this.x, y: this.y,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        r: 6, value: per, life: 22, age: 0, seed: rand(0, TAU),
      });
    }

    // health drop
    const dropChance = this.isBoss ? 1 : this.def.r > 20 ? 0.35 : 0.045;
    if (Math.random() < dropChance) {
      game.pickups.push({
        type: 'health', x: this.x + rand(-14, 14), y: this.y + rand(-14, 14),
        vx: rand(-40, 40), vy: rand(-40, 40), r: 10, value: this.isBoss ? 60 : 26,
        life: 26, age: 0, seed: rand(0, TAU),
      });
    }

    // brute splits
    if (this.type === 'brute' && game.enemies.length < 46) {
      for (let i = 0; i < 2; i++) {
        const a = rand(0, TAU);
        game.spawnEnemyAt('crawler', this.x + Math.cos(a) * 34, this.y + Math.sin(a) * 34);
      }
    }
  }

  draw(ctx, game) {
    const def = this.def;
    const t = this.age;
    const r = this.r;
    const tIn = 1 - clamp(this.spawnAnim / 0.45, 0, 1);
    const scale = 0.4 + 0.6 * tIn;
    const flash = this.flash;
    const hurtCol = flash > 0.06;

    // ground shadow
    ctx.save();
    ctx.globalAlpha = 0.34 * scale;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(this.x + 2, this.y + r * 0.85, r * 0.95 * scale, r * 0.34 * scale, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    // soft aura
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.26 * scale;
    drawGlow(ctx, glowSprite(def.glow, 0.4), this.x, this.y, r * 2.0);
    ctx.globalAlpha = 1;
    ctx.restore();

    ctx.save();
    ctx.translate(this.x, this.y);
    if (this.isBoss) ctx.rotate(t * 0.18);
    else ctx.rotate(this.facing);
    ctx.scale(scale, scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const glowCol = rgba(def.glow, 0.75);
    const skin = hurtCol ? '#ffffff' : '#08101c';

    if (this.type === 'crawler') {
      /* ---------- CRAWLER: low six-legged insect with mandibles ---------- */
      for (let i = 0; i < 3; i++) {
        for (let sd = -1; sd <= 1; sd += 2) {
          const bx = (i - 1) * r * 0.46;
          const wig = Math.sin(t * 11 + i * 1.7 + (sd > 0 ? 0 : 1.9)) * r * 0.16;
          ctx.strokeStyle = rgba(def.glow, 0.45);
          ctx.lineWidth = Math.max(1.3, r * 0.1);
          ctx.beginPath();
          ctx.moveTo(bx, sd * r * 0.4);
          ctx.quadraticCurveTo(bx + r * 0.22, sd * r * 1.05, bx + wig + sd * r * 0.12, sd * r * 1.5);
          ctx.stroke();
        }
      }
      // back spikes
      ctx.fillStyle = rgba(def.color, 0.55);
      for (let i = 0; i < 3; i++) {
        const bx = (-0.55 + i * 0.36) * r;
        ctx.beginPath();
        ctx.moveTo(bx - r * 0.12, -r * 0.42);
        ctx.lineTo(bx, -r * 0.95);
        ctx.lineTo(bx + r * 0.12, -r * 0.42);
        ctx.closePath();
        ctx.fill();
      }
      // carapace
      const bg = ctx.createLinearGradient(-r, -r, r * 0.8, r);
      bg.addColorStop(0, hurtCol ? '#ffffff' : shade(def.color, 0.42));
      bg.addColorStop(0.65, skin);
      bg.addColorStop(1, '#04080f');
      ctx.fillStyle = bg;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = Math.max(1.5, r * 0.1);
      ctx.beginPath();
      ctx.moveTo(r * 0.98, 0);
      ctx.quadraticCurveTo(r * 0.45, -r * 0.78, -r * 0.5, -r * 0.6);
      ctx.quadraticCurveTo(-r * 0.95, 0, -r * 0.5, r * 0.6);
      ctx.quadraticCurveTo(r * 0.45, r * 0.78, r * 0.98, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // ridges
      ctx.strokeStyle = rgba(def.color, 0.3);
      ctx.lineWidth = Math.max(1, r * 0.06);
      for (let i = 1; i <= 2; i++) {
        ctx.beginPath();
        ctx.moveTo(-r * 0.1 - i * r * 0.22, -r * 0.35);
        ctx.quadraticCurveTo(-r * 0.05 - i * r * 0.22, 0, -r * 0.1 - i * r * 0.22, r * 0.35);
        ctx.stroke();
      }
      // mandibles
      ctx.strokeStyle = rgba(def.color, 0.95);
      ctx.lineWidth = Math.max(1.6, r * 0.13);
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.beginPath();
        ctx.moveTo(r * 0.62, sd * r * 0.12);
        ctx.quadraticCurveTo(r * 1.3, sd * r * 0.42, r * 1.28, sd * r * 0.02);
        ctx.stroke();
      }
      // eyes
      ctx.globalCompositeOperation = 'lighter';
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.beginPath();
        ctx.arc(r * 0.5, sd * r * 0.3, r * 0.1, 0, TAU);
        ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.arc(r * 0.5, sd * r * 0.3, r * 0.24, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else if (this.type === 'skitter') {
      /* ---------- SKITTER: long-legged sprinter ---------- */
      for (let i = 0; i < 2; i++) {
        for (let sd = -1; sd <= 1; sd += 2) {
          const bx = (i - 0.5) * r * 0.7;
          const wig = Math.sin(t * 16 + i * 2.2 + (sd > 0 ? 0 : 1.4)) * r * 0.3;
          ctx.strokeStyle = rgba(def.glow, 0.65);
          ctx.lineWidth = Math.max(1.2, r * 0.09);
          ctx.beginPath();
          ctx.moveTo(bx, sd * r * 0.32);
          ctx.quadraticCurveTo(bx + r * 0.5, sd * r * 1.0, bx + wig, sd * r * 1.75);
          ctx.stroke();
        }
      }
      // tail spike
      ctx.fillStyle = rgba(def.color, 0.6);
      ctx.beginPath();
      ctx.moveTo(-r * 0.8, -r * 0.2);
      ctx.lineTo(-r * 1.75, 0);
      ctx.lineTo(-r * 0.8, r * 0.2);
      ctx.closePath();
      ctx.fill();
      // elongated body
      const bg = ctx.createLinearGradient(-r, 0, r, 0);
      bg.addColorStop(0, hurtCol ? '#ffffff' : '#0a1220');
      bg.addColorStop(0.7, hurtCol ? '#ffffff' : shade(def.color, 0.35));
      bg.addColorStop(1, def.color);
      ctx.fillStyle = bg;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = Math.max(1.4, r * 0.1);
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.1, r * 0.55, 0, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // carapace segment lines
      ctx.strokeStyle = 'rgba(0,0,0,.45)';
      ctx.lineWidth = 1.4;
      for (let i = -1; i <= 1; i++) {
        ctx.beginPath();
        ctx.moveTo(i * r * 0.38, -r * 0.42);
        ctx.lineTo(i * r * 0.38, r * 0.42);
        ctx.stroke();
      }
      // eyes forward
      ctx.globalCompositeOperation = 'lighter';
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.beginPath();
        ctx.arc(r * 0.75, sd * r * 0.2, r * 0.09, 0, TAU);
        ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.arc(r * 0.75, sd * r * 0.2, r * 0.22, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else if (this.type === 'spitter') {
      /* ---------- SPITTER: bloated sac on tentacles ---------- */
      // tentacles
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * TAU + 0.6;
        const sway = Math.sin(t * 3.4 + i * 1.5) * 0.25;
        const tx = Math.cos(a + Math.PI + sway) * r * 1.75;
        const ty = Math.sin(a + Math.PI + sway) * r * 1.75;
        ctx.strokeStyle = rgba(def.glow, 0.55);
        ctx.lineWidth = Math.max(1.4, r * 0.12);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55);
        ctx.quadraticCurveTo(Math.cos(a + 0.8) * r * 1.2, Math.sin(a + 0.8) * r * 1.2, tx, ty);
        ctx.stroke();
      }
      // pulsing sac
      const puff = 1 + Math.sin(t * 3.2 + this.seed) * 0.05;
      const bg = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r * puff);
      bg.addColorStop(0, hurtCol ? '#ffffff' : shade(def.color, 0.5));
      bg.addColorStop(0.55, hurtCol ? '#ffffff' : shade(def.color, 0.22));
      bg.addColorStop(1, '#070c17');
      ctx.fillStyle = bg;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = Math.max(1.6, r * 0.1);
      ctx.beginPath();
      ctx.arc(0, 0, r * puff, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // veins
      ctx.strokeStyle = rgba(def.glow, 0.45);
      ctx.lineWidth = Math.max(1, r * 0.06);
      for (let i = 0; i < 3; i++) {
        const a0 = t * 0.6 + (i / 3) * TAU;
        ctx.beginPath();
        ctx.moveTo(Math.cos(a0) * r * 0.25, Math.sin(a0) * r * 0.25);
        ctx.quadraticCurveTo(
          Math.cos(a0 + 0.4) * r * 0.62, Math.sin(a0 + 0.4) * r * 0.62,
          Math.cos(a0 + 0.2) * r * 0.92, Math.sin(a0 + 0.2) * r * 0.92
        );
        ctx.stroke();
      }
      // charging mouth
      if (this.charge > 0) {
        const k = 1 - this.charge / 0.42;
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.beginPath();
        ctx.arc(r * 0.92, 0, r * 0.16 + r * 0.12 * k, 0, TAU);
        ctx.fill();
        ctx.fillStyle = rgba(def.color, 0.9);
        ctx.beginPath();
        ctx.arc(r * 0.92, 0, r * 0.34 + r * 0.3 * k, 0, TAU);
        ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      // eyes
      ctx.globalCompositeOperation = 'lighter';
      for (let i = -1; i <= 1; i++) {
        ctx.fillStyle = 'rgba(255,255,255,.9)';
        ctx.beginPath();
        ctx.arc(r * 0.42, i * r * 0.24, r * 0.07, 0, TAU);
        ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.arc(r * 0.42, i * r * 0.24, r * 0.18, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else if (this.type === 'brute') {
      /* ---------- BRUTE: armoured tank with claws ---------- */
      // stubby legs
      for (let i = 0; i < 3; i++) {
        for (let sd = -1; sd <= 1; sd += 2) {
          const bx = (i - 1) * r * 0.5;
          const wig = Math.sin(t * 7 + i * 2 + (sd > 0 ? 0 : 2)) * r * 0.12;
          ctx.strokeStyle = rgba(def.color, 0.55);
          ctx.lineWidth = Math.max(2.4, r * 0.18);
          ctx.beginPath();
          ctx.moveTo(bx, sd * r * 0.55);
          ctx.lineTo(bx + wig + sd * r * 0.3, sd * r * 1.05);
          ctx.stroke();
        }
      }
      // claws
      ctx.strokeStyle = rgba(def.color, 0.9);
      ctx.lineWidth = Math.max(2.6, r * 0.16);
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.beginPath();
        ctx.moveTo(r * 0.55, sd * r * 0.5);
        ctx.quadraticCurveTo(r * 1.25, sd * r * 0.85, r * 1.15, sd * r * 0.1);
        ctx.stroke();
      }
      // shoulder plates
      ctx.fillStyle = hurtCol ? '#ffffff' : shade(def.color, 0.3);
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.beginPath();
        ctx.ellipse(-r * 0.1, sd * r * 0.72, r * 0.52, r * 0.34, sd * 0.4, 0, TAU);
        ctx.fill();
        ctx.strokeStyle = def.color;
        ctx.lineWidth = Math.max(1.5, r * 0.07);
        ctx.stroke();
      }
      // main carapace
      const bg = ctx.createLinearGradient(-r, -r, r, r);
      bg.addColorStop(0, hurtCol ? '#ffffff' : shade(def.color, 0.38));
      bg.addColorStop(0.6, hurtCol ? '#ffffff' : '#0a0f1a');
      bg.addColorStop(1, '#04070e');
      ctx.fillStyle = bg;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = Math.max(2, r * 0.1);
      ctx.beginPath();
      ctx.roundRect(-r * 0.9, -r * 0.72, r * 1.8, r * 1.44, r * 0.4);
      ctx.fill();
      ctx.stroke();
      // glowing cracks
      ctx.strokeStyle = rgba(def.glow, 0.75);
      ctx.lineWidth = Math.max(1.4, r * 0.07);
      ctx.beginPath();
      ctx.moveTo(-r * 0.55, -r * 0.3);
      ctx.lineTo(-r * 0.15, 0);
      ctx.lineTo(-r * 0.45, r * 0.3);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(r * 0.1, -r * 0.45);
      ctx.lineTo(r * 0.35, -r * 0.05);
      ctx.lineTo(r * 0.15, r * 0.35);
      ctx.stroke();
      // eyes
      ctx.globalCompositeOperation = 'lighter';
      for (let sd = -1; sd <= 1; sd += 2) {
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.beginPath();
        ctx.arc(r * 0.45, sd * r * 0.3, r * 0.09, 0, TAU);
        ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.arc(r * 0.45, sd * r * 0.3, r * 0.22, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else {
      /* ---------- BOSS: hulking hive queen ---------- */
      // ring of spikes
      ctx.fillStyle = rgba(def.color, 0.8);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        const len = r * (i % 2 === 0 ? 1.5 : 1.28);
        ctx.beginPath();
        ctx.moveTo(Math.cos(a - 0.14) * r * 0.92, Math.sin(a - 0.14) * r * 0.92);
        ctx.lineTo(Math.cos(a) * len, Math.sin(a) * len);
        ctx.lineTo(Math.cos(a + 0.14) * r * 0.92, Math.sin(a + 0.14) * r * 0.92);
        ctx.closePath();
        ctx.fill();
      }
      // body
      const bg = ctx.createRadialGradient(-r * 0.25, -r * 0.3, r * 0.15, 0, 0, r * 1.05);
      bg.addColorStop(0, hurtCol ? '#ffffff' : shade(def.color, 0.55));
      bg.addColorStop(0.5, hurtCol ? '#ffffff' : shade(def.color, 0.2));
      bg.addColorStop(1, '#0a0510');
      ctx.fillStyle = bg;
      ctx.strokeStyle = def.color;
      ctx.lineWidth = Math.max(2.5, r * 0.07);
      ctx.beginPath();
      ctx.arc(0, 0, r * 1.02, 0, TAU);
      ctx.fill();
      ctx.stroke();
      // inner maw
      const maw = 0.55 + Math.sin(t * 2.4) * 0.15;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath();
      ctx.arc(0, 0, r * 0.55 * maw + r * 0.2, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(def.glow, 0.5);
      ctx.lineWidth = 2;
      ctx.stroke();
      // eyes
      ctx.globalCompositeOperation = 'lighter';
      const eyePos = [[r * 0.42, -r * 0.3], [r * 0.42, r * 0.3], [r * 0.7, 0]];
      for (const [ex2, ey2] of eyePos) {
        ctx.fillStyle = 'rgba(255,255,255,.95)';
        ctx.beginPath();
        ctx.arc(ex2, ey2, r * 0.09, 0, TAU);
        ctx.fill();
        ctx.fillStyle = glowCol;
        ctx.beginPath();
        ctx.arc(ex2, ey2, r * 0.2, 0, TAU);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      // wind-up telegraph glow
      if (this.bossWindup > 0) {
        ctx.globalCompositeOperation = 'lighter';
        const k = 1 - this.bossWindup / 0.7;
        ctx.strokeStyle = `rgba(255,80,160,${0.4 + k * 0.6})`;
        ctx.lineWidth = 3 + k * 5;
        ctx.beginPath();
        ctx.arc(0, 0, r * 1.45 + k * r * 0.5, 0, TAU);
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // hit flash shell
    if (flash > 0) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = flash * 0.5;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, r * (this.type === 'skitter' ? 1.2 : 1.05), 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    ctx.restore();

    // hp bar
    if (!this.isBoss && this.hp < this.maxHp) {
      const w = Math.max(24, r * 2);
      const ratio = clamp(this.hp / this.maxHp, 0, 1);
      const bx = this.x - w / 2;
      const by = this.y - r - 14;
      ctx.save();
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillRect(bx - 1, by - 1, w + 2, 5);
      ctx.fillStyle = ratio > 0.5 ? '#4dff9d' : ratio > 0.22 ? '#ffd24d' : '#ff4d6a';
      ctx.fillRect(bx, by, w * ratio, 3);
      ctx.restore();
    }
  }
}
