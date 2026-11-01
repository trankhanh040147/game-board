'use strict';
/* =========================================================================
   ALIEN SHOOTER — core.js
   Math helpers · WebAudio synth engine · input · camera · particle FX
   ========================================================================= */

/* ------------------------------ math ----------------------------------- */
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (list) => list[(Math.random() * list.length) | 0];
const dist = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay);
const angTo = (ax, ay, bx, by) => Math.atan2(by - ay, bx - ax);
const sign = (v) => (v < 0 ? -1 : 1);
const fmtNum = (n) => Math.round(n).toLocaleString('en-US');
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}
function angLerp(a, b, t) {
  let d = ((b - a + Math.PI * 3) % TAU) - Math.PI;
  return a + d * t;
}
function approach(v, target, amount) {
  if (v < target) return Math.min(v + amount, target);
  return Math.max(v - amount, target);
}


/* ---------------------- cached glow sprites ---------------------------- */
const _glowCache = new Map();

function _hexA(hex, a) {
  if (hex[0] !== '#') return hex;
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** Pre-rendered radial glow sprite (white core -> colour -> transparent). */
function glowSprite(color, midAlpha = 0.65) {
  const key = color + '|' + midAlpha;
  let c = _glowCache.get(key);
  if (c) return c;
  const size = 128;
  c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  const half = size / 2;
  const grd = g.createRadialGradient(half, half, 0, half, half, half);
  grd.addColorStop(0, 'rgba(255,255,255,0.95)');
  grd.addColorStop(0.22, _hexA(color, midAlpha));
  grd.addColorStop(0.55, _hexA(color, midAlpha * 0.35));
  grd.addColorStop(1, _hexA(color, 0));
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  _glowCache.set(key, c);
  return c;
}

function drawGlow(ctx, sprite, x, y, radius) {
  ctx.drawImage(sprite, x - radius, y - radius, radius * 2, radius * 2);
}

/* ------------------------------ audio ---------------------------------- */
class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    this.enabled = true;
    this.ready = false;
    this._lastShot = 0;
    this._lastHit = 0;
  }

  init() {
    if (this.ctx) { this.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch (e) { return; }

    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 24;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.22;

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(comp);
    comp.connect(this.ctx.destination);

    // 1s of white noise, reused by every explosion / impact
    const len = Math.floor(this.ctx.sampleRate);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    this.ready = true;
    this.resume();
  }

  resume() {
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  setEnabled(v) {
    this.enabled = v;
    if (this.master) this.master.gain.value = v ? 0.55 : 0;
  }

  get t() { return this.ctx ? this.ctx.currentTime : 0; }

  tone(opts) {
    if (!this.ready || !this.enabled) return;
    const o = Object.assign({ freq: 440, freqEnd: null, type: 'square', dur: 0.12, vol: 0.1, attack: 0.004 }, opts);
    const t0 = this.t;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = o.type;
    osc.frequency.setValueAtTime(Math.max(20, o.freq), t0);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), t0 + o.dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + o.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.03);
  }

  noise(opts) {
    if (!this.ready || !this.enabled || !this.noiseBuf) return;
    const o = Object.assign({ dur: 0.2, vol: 0.12, freq: 1200, freqEnd: null, type: 'lowpass', q: 1, attack: 0.004 }, opts);
    const t0 = this.t;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const filt = this.ctx.createBiquadFilter();
    filt.type = o.type;
    filt.Q.value = o.q;
    filt.frequency.setValueAtTime(clamp(o.freq, 30, 16000), t0);
    if (o.freqEnd) filt.frequency.exponentialRampToValueAtTime(clamp(o.freqEnd, 30, 16000), t0 + o.dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, o.vol), t0 + o.attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
    src.connect(filt).connect(g).connect(this.master);
    src.start(t0);
    src.stop(t0 + o.dur + 0.03);
  }

  /* ---------- game sounds ---------- */
  shoot() {
    const now = performance.now();
    if (now - this._lastShot < 38) return;
    this._lastShot = now;
    this.tone({ freq: rand(760, 900), freqEnd: 210, type: 'square', dur: 0.075, vol: 0.055 });
    this.noise({ dur: 0.045, vol: 0.03, freq: 3400, freqEnd: 1200, type: 'highpass' });
  }
  enemyShoot() {
    this.tone({ freq: 330, freqEnd: 130, type: 'sawtooth', dur: 0.13, vol: 0.035 });
  }
  hit() {
    const now = performance.now();
    if (now - this._lastHit < 45) return;
    this._lastHit = now;
    this.noise({ dur: 0.05, vol: 0.05, freq: 2600, freqEnd: 900, type: 'bandpass', q: 1.4 });
  }
  kill() {
    this.noise({ dur: 0.16, vol: 0.075, freq: 1400, freqEnd: 180, type: 'lowpass' });
    this.tone({ freq: 180, freqEnd: 60, type: 'sine', dur: 0.16, vol: 0.06 });
  }
  explode() {
    this.noise({ dur: 0.42, vol: 0.16, freq: 1100, freqEnd: 60, type: 'lowpass', q: 0.8 });
    this.tone({ freq: 120, freqEnd: 38, type: 'sine', dur: 0.4, vol: 0.14 });
    this.tone({ freq: 320, freqEnd: 70, type: 'triangle', dur: 0.22, vol: 0.06 });
  }
  hurt() {
    this.tone({ freq: 260, freqEnd: 70, type: 'sawtooth', dur: 0.2, vol: 0.11 });
    this.noise({ dur: 0.14, vol: 0.07, freq: 700, freqEnd: 200, type: 'lowpass' });
  }
  pickup() {
    this.tone({ freq: 880, freqEnd: 1320, type: 'sine', dur: 0.09, vol: 0.05 });
  }
  health() {
    this.tone({ freq: 520, type: 'sine', dur: 0.1, vol: 0.05 });
    this.tone({ freq: 780, type: 'sine', dur: 0.13, vol: 0.045, attack: 0.05 });
  }
  levelup() {
    const notes = [523, 659, 784, 1046];
    notes.forEach((f, i) => {
      setTimeout(() => this.tone({ freq: f, type: 'triangle', dur: 0.18, vol: 0.07 }), i * 70);
    });
  }
  dash() {
    this.noise({ dur: 0.19, vol: 0.075, freq: 500, freqEnd: 3600, type: 'bandpass', q: 1.2 });
  }
  waveStart() {
    this.tone({ freq: 190, freqEnd: 260, type: 'sawtooth', dur: 0.34, vol: 0.05 });
    setTimeout(() => this.tone({ freq: 260, freqEnd: 380, type: 'sawtooth', dur: 0.3, vol: 0.05 }), 130);
  }
  boss() {
    this.tone({ freq: 70, freqEnd: 40, type: 'sine', dur: 1.1, vol: 0.16 });
    this.tone({ freq: 141, freqEnd: 92, type: 'sawtooth', dur: 0.9, vol: 0.05 });
    this.noise({ dur: 1.0, vol: 0.05, freq: 320, freqEnd: 90, type: 'lowpass' });
  }
  gameover() {
    const notes = [392, 330, 262, 175];
    notes.forEach((f, i) => {
      setTimeout(() => this.tone({ freq: f, type: 'triangle', dur: 0.42, vol: 0.08 }), i * 150);
    });
  }
}

/* ------------------------------ input ---------------------------------- */
class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.keys = new Set();
    this.pressedKeys = new Set();
    this.mouse = { sx: 0, sy: 0, down: false, inside: true };
    this.isTouch = false;
    this.dashRequested = false;
    this.sticks = {
      move: { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 },
      aim: { active: false, id: null, ox: 0, oy: 0, dx: 0, dy: 0 },
    };
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      const blocked = ['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash'];
      if (blocked.includes(e.code)) e.preventDefault();
      if (!this.keys.has(e.code)) this.pressedKeys.add(e.code);
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouse.down = false;
    });

    window.addEventListener('mousemove', (e) => {
      this.mouse.sx = e.clientX;
      this.mouse.sy = e.clientY;
    });
    window.addEventListener('mousedown', (e) => {
      if (e.target && e.target.closest && e.target.closest('.ui-btn, .card, .btn')) return;
      if (e.button === 0) this.mouse.down = true;
      if (e.button === 2) e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 0) this.mouse.down = false;
    });
    window.addEventListener('contextmenu', (e) => e.preventDefault());

    /* --- touch: left half = move stick, right half = aim + autofire --- */
    const onDown = (e) => {
      if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return;
      this.isTouch = true;
      const db = this.dashButton();
      if (Math.hypot(e.clientX - db.x, e.clientY - db.y) < db.r + 14) {
        this.dashRequested = true;
        if (e.cancelable) e.preventDefault();
        return;
      }
      const half = window.innerWidth * 0.5;
      const kind = e.clientX < half ? 'move' : 'aim';
      const s = this.sticks[kind];
      if (s.active) return;
      s.active = true;
      s.id = e.pointerId;
      s.ox = e.clientX;
      s.oy = e.clientY;
      s.dx = 0;
      s.dy = 0;
      if (e.cancelable) e.preventDefault();
    };
    const onMove = (e) => {
      const s = e.pointerId === this.sticks.move.id ? this.sticks.move
        : e.pointerId === this.sticks.aim.id ? this.sticks.aim : null;
      if (!s) return;
      let dx = e.clientX - s.ox;
      let dy = e.clientY - s.oy;
      const len = Math.hypot(dx, dy);
      const maxR = 70;
      if (len > maxR) { dx = (dx / len) * maxR; dy = (dy / len) * maxR; }
      s.dx = dx;
      s.dy = dy;
      if (e.cancelable) e.preventDefault();
    };
    const onUp = (e) => {
      for (const k of ['move', 'aim']) {
        const s = this.sticks[k];
        if (s.id === e.pointerId) {
          s.active = false;
          s.id = null;
          s.dx = 0;
          s.dy = 0;
        }
      }
    };
    this.canvas.addEventListener('pointerdown', onDown, { passive: false });
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  isDown(code) { return this.keys.has(code); }
  wasPressed(code) { return this.pressedKeys.has(code); }
  endFrame() { this.pressedKeys.clear(); }

  dashButton() {
    return { x: window.innerWidth - 76, y: window.innerHeight - 172, r: 40 };
  }

  consumeDash() {
    const v = this.dashRequested;
    this.dashRequested = false;
    return v;
  }

  get fireHeld() { return this.mouse.down || this.sticks.aim.active; }

  moveAxis() {
    let x = 0;
    let y = 0;
    if (this.isDown('KeyA') || this.isDown('ArrowLeft')) x -= 1;
    if (this.isDown('KeyD') || this.isDown('ArrowRight')) x += 1;
    if (this.isDown('KeyW') || this.isDown('ArrowUp')) y -= 1;
    if (this.isDown('KeyS') || this.isDown('ArrowDown')) y += 1;

    const s = this.sticks.move;
    if (s.active) {
      const len = Math.hypot(s.dx, s.dy);
      if (len > 9) {
        const k = Math.min(1, (len - 9) / 55);
        x += (s.dx / len) * k;
        y += (s.dy / len) * k;
      }
    }
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }
    return { x, y };
  }

  aimVector() {
    const s = this.sticks.aim;
    if (s.active) {
      const len = Math.hypot(s.dx, s.dy);
      if (len > 12) return { x: s.dx / len, y: s.dy / len, active: true };
    }
    return { x: 0, y: 0, active: false };
  }
}

/* ------------------------------ camera --------------------------------- */
class Camera {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.zoom = 1;
    this.shake = 0;
    this.ox = 0;
    this.oy = 0;
    this._t = 0;
  }
  resize(vw, vh, world) {
    this.zoom = clamp(Math.min(vw / 1024, vh / 640), 0.85, 1.75);
    this.vw = vw;
    this.vh = vh;
    this.world = world;
  }
  snap(target) {
    const viewW = this.vw / this.zoom;
    const viewH = this.vh / this.zoom;
    this.x = target.x - viewW / 2;
    this.y = target.y - viewH / 2;
    this._clamp();
  }
  update(dt, target) {
    const viewW = this.vw / this.zoom;
    const viewH = this.vh / this.zoom;
    const tx = target.x - viewW / 2;
    const ty = target.y - viewH / 2;
    const k = 1 - Math.pow(0.0016, dt);
    this.x = lerp(this.x, tx, k);
    this.y = lerp(this.y, ty, k);
    this._clamp();

    this.shake = Math.max(0, this.shake - dt * (14 + this.shake * 4));
    this._t += dt;
    if (this.shake > 0.15) {
      const a = this.shake;
      this.ox = Math.sin(this._t * 61.3) * a + rand(-a, a) * 0.5;
      this.oy = Math.cos(this._t * 47.7) * a + rand(-a, a) * 0.5;
    } else {
      this.ox = 0;
      this.oy = 0;
    }
  }
  addShake(a) {
    this.shake = Math.min(this.shake + a, 26);
  }
  _clamp() {
    const viewW = this.vw / this.zoom;
    const viewH = this.vh / this.zoom;
    if (viewW >= this.world.w) this.x = (this.world.w - viewW) / 2;
    else this.x = clamp(this.x, 0, this.world.w - viewW);
    if (viewH >= this.world.h) this.y = (this.world.h - viewH) / 2;
    else this.y = clamp(this.y, 0, this.world.h - viewH);
  }
  toWorld(sx, sy) {
    return { x: sx / this.zoom + this.x, y: sy / this.zoom + this.y };
  }
}

/* ------------------------------ FX ------------------------------------- */
class FX {
  constructor() {
    this.particles = [];
    this.texts = [];
    this.rings = [];
    this.MAX = 900;
  }

  clear() {
    this.particles.length = 0;
    this.texts.length = 0;
    this.rings.length = 0;
  }

  _add(p) {
    if (this.particles.length >= this.MAX) this.particles.shift();
    p.age = 0;
    this.particles.push(p);
  }

  burst(x, y, opts = {}) {
    const o = Object.assign({
      count: 10,
      speedMin: 60, speedMax: 260,
      lifeMin: 0.25, lifeMax: 0.65,
      sizeMin: 1.2, sizeMax: 3.4,
      colors: ['#ffffff'],
      kind: 'glow',
      dir: null,        // angle; if set, confined to cone
      cone: 0.6,
      drag: 3.2,
      gravity: 0,
      spread: 0,
    }, opts);

    for (let i = 0; i < o.count; i++) {
      const a = o.dir != null ? o.dir + rand(-o.cone, o.cone) : rand(0, TAU);
      const sp = rand(o.speedMin, o.speedMax);
      const spd0 = o.spread > 0 ? rand(-o.spread, o.spread) : 0;
      this._add({
        kind: o.kind,
        x: x + rand(-2, 2),
        y: y + rand(-2, 2),
        vx: Math.cos(a) * sp + spd0,
        vy: Math.sin(a) * sp,
        life: rand(o.lifeMin, o.lifeMax),
        size: rand(o.sizeMin, o.sizeMax),
        color: pick(o.colors),
        drag: o.drag,
        gravity: o.gravity,
        rot: 0,
        vr: rand(-8, 8),
      });
    }
  }

  ring(x, y, opts = {}) {
    const o = Object.assign({ r0: 6, r1: 60, life: 0.4, color: '#fff', width: 3 }, opts);
    this.rings.push({ x, y, r0: o.r0, r1: o.r1, life: o.life, max: o.life, color: o.color, width: o.width });
  }

  text(x, y, str, opts = {}) {
    const o = Object.assign({ color: '#fff', size: 13, life: 0.85, vy: -46, vx: 0, bold: true }, opts);
    this.texts.push({ x, y, str, color: o.color, size: o.size, life: o.life, max: o.life, vy: o.vy, vx: o.vx, bold: o.bold });
    if (this.texts.length > 60) this.texts.shift();
  }

  update(dt) {
    const ps = this.particles;
    for (let i = ps.length - 1; i >= 0; i--) {
      const p = ps[i];
      p.age += dt;
      if (p.age >= p.life) { ps.splice(i, 1); continue; }
      const d = Math.exp(-p.drag * dt);
      p.vx *= d;
      p.vy *= d;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
    }
    const rs = this.rings;
    for (let i = rs.length - 1; i >= 0; i--) {
      rs[i].age = (rs[i].age || 0) + dt;
      if (rs[i].age >= rs[i].life) rs.splice(i, 1);
    }
    const ts = this.texts;
    for (let i = ts.length - 1; i >= 0; i--) {
      const t = ts[i];
      t.age = (t.age || 0) + dt;
      if (t.age >= t.life) { ts.splice(i, 1); continue; }
      t.y += t.vy * dt;
      t.x += t.vx * dt;
      t.vy *= Math.exp(-1.6 * dt);
    }
  }

  drawParticles(ctx) {
    const ps = this.particles;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const k = 1 - p.age / p.life;
      const alpha = p.kind === 'smoke' ? k * 0.35 : k * k;
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      const s = p.kind === 'smoke' ? p.size * (1 + p.age * 1.8) : p.size * (0.4 + k);
      ctx.beginPath();
      ctx.arc(p.x, p.y, s, 0, TAU);
      ctx.fill();
    }
    ctx.restore();

    // rings
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      const t = (r.age || 0) / r.life;
      const radius = lerp(r.r0, r.r1, 1 - (1 - t) * (1 - t));
      ctx.globalAlpha = (1 - t) * 0.85;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - t * 0.6);
      ctx.beginPath();
      ctx.arc(r.x, r.y, radius, 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawTexts(ctx) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let i = 0; i < this.texts.length; i++) {
      const t = this.texts[i];
      const k = 1 - t.age / t.life;
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.font = `${t.bold ? 800 : 600} ${t.size}px ui-monospace, "SF Mono", Menlo, monospace`;
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      ctx.fillText(t.str, t.x + 1.5, t.y + 1.5);
      ctx.fillStyle = t.color;
      ctx.fillText(t.str, t.x, t.y);
    }
    ctx.restore();
  }
}
