/**
 * AUDIO LAB — dev-only harness for the BLADE & MOUNT procedural audio engine.
 *
 * Every SFX, crowd state, music track and mix probe can be auditioned here.
 * The page also exposes `window.__audioLab` so headless QA (tools/shot.mjs
 * `--eval`, or puppeteer) can verify: AudioContext state, recipe coverage for
 * all 23 SfxNames, a 200-sound rapid-fire stress run, non-zero analyser signal
 * and camera-relative spatial panning — without listening.
 *
 *   /audio-lab.html
 *   /audio-lab.html?autostart=1   (attempts unlock + music without a click)
 */

import * as THREE from 'three';
import '@fontsource/cinzel/600.css';
import '@fontsource/eb-garamond/400.css';
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import { audio } from '../audio/audio';
import { SFX_NAMES } from '../audio/sfx';
import { MUSIC_TRACKS } from '../audio/music';
import { MAX_SFX_VOICES, THROTTLE_MS } from '../audio/dsp';
import type { MusicTrack, SfxName } from '../core/types';

/* ------------------------------------------------------------------ */
/* Metadata                                                            */
/* ------------------------------------------------------------------ */

interface SfxMeta {
  label: string;
  hint: string;
}

const SFX_META: Record<SfxName, SfxMeta> = {
  swing: { label: 'Sword Whoosh', hint: 'air · bandpass' },
  'swing-heavy': { label: 'Heavy Whoosh', hint: 'greatsword' },
  'hit-flesh': { label: 'Flesh Hit', hint: 'thump + squelch' },
  'hit-armor': { label: 'Armour Hit', hint: 'FM metal' },
  'hit-shield': { label: 'Shield Block', hint: 'oak + rattle' },
  'block-weapon': { label: 'Weapon Parry', hint: 'bright clang' },
  'guard-break': { label: 'Guard Break', hint: 'crack + boom' },
  kick: { label: 'Kick', hint: 'body thud' },
  death: { label: 'Death', hint: 'groan + collapse' },
  footstep: { label: 'Footstep', hint: 'sand scuff' },
  dodge: { label: 'Dodge', hint: 'cloth swish' },
  spawn: { label: 'Spawn', hint: 'presence swell' },
  gong: { label: 'Gong', hint: '6 s inharmonic' },
  horn: { label: 'War Horn', hint: '3-note fanfare' },
  'round-start': { label: 'Round Start', hint: 'horn + drum roll' },
  'crowd-cheer': { label: 'Crowd Cheer', hint: 'voices + claps' },
  bet: { label: 'Bet Coin', hint: 'purse' },
  'bet-win': { label: 'Bet Win', hint: 'coin shower' },
  'bet-lose': { label: 'Bet Lose', hint: 'purse drop' },
  victory: { label: 'Victory Sting', hint: 'brass fanfare' },
  defeat: { label: 'Defeat Sting', hint: 'minor lament' },
  'ui-click': { label: 'UI Click', hint: 'wooden tick' },
  'ui-hover': { label: 'UI Hover', hint: 'soft air' },
};

const PANELS: { id: string; sounds: SfxName[] }[] = [
  {
    id: 'panel-steel',
    sounds: ['swing', 'swing-heavy', 'hit-flesh', 'hit-armor', 'hit-shield', 'block-weapon', 'guard-break', 'kick'],
  },
  {
    id: 'panel-ceremony',
    sounds: ['death', 'footstep', 'dodge', 'spawn', 'gong', 'horn', 'round-start', 'crowd-cheer'],
  },
  {
    id: 'panel-coin',
    sounds: ['bet', 'bet-win', 'bet-lose', 'victory', 'defeat', 'ui-click', 'ui-hover'],
  },
];

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

function el<T extends HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`audio-lab: missing ${selector}`);
  return found;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

const logEl = el<HTMLDivElement>('#log');
const logLines: string[] = [];

function logLine(text: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  const stamp = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const prefix = kind === 'ok' ? '<span class="ok">✔</span>' : kind === 'err' ? '<span class="err">✘</span>' : '·';
  logLines.push(`<span class="hint">${stamp}</span> ${prefix} ${text}`);
  if (logLines.length > 60) logLines.shift();
  logEl.innerHTML = logLines.join('\n');
  logEl.scrollTop = logEl.scrollHeight;
}

/* ------------------------------------------------------------------ */
/* Camera / listener                                                   */
/* ------------------------------------------------------------------ */

const camera = new THREE.PerspectiveCamera(62, 16 / 9, 0.1, 200);
camera.position.set(0, 2.1, 9.5);
camera.lookAt(0, 1.4, -4);
camera.updateMatrixWorld(true);

let orbiting = true;
let orbitTime = 0;
audio.update(camera, 0.016);

const spatialDots: { x: number; z: number; age: number; tone: number }[] = [];
let lastSpatialText = 'no spatial events yet';

/* ------------------------------------------------------------------ */
/* Sound triggering                                                    */
/* ------------------------------------------------------------------ */

function flashButton(button: HTMLButtonElement): void {
  button.classList.add('flash');
  window.setTimeout(() => button.classList.remove('flash'), 120);
}

function triggerSound(name: SfxName, opts?: { pos?: THREE.Vector3; volume?: number; rate?: number }): void {
  audio.unlock();
  audio.play(name, opts);
  logLine(`<b>${name}</b> ${opts?.pos ? 'at position' : ''}`);
  if (opts?.pos) addSpatialDot(opts.pos.x, opts.pos.z);
}

function addSpatialDot(x: number, z: number): void {
  spatialDots.push({ x, z, age: 0, tone: Math.random() });
  if (spatialDots.length > 24) spatialDots.shift();
}

/* ------------------------------------------------------------------ */
/* Build panels                                                        */
/* ------------------------------------------------------------------ */

const soundButtons = new Map<SfxName, HTMLButtonElement>();

for (const panel of PANELS) {
  const grid = el<HTMLDivElement>(`#${panel.id}`);
  for (const name of panel.sounds) {
    const meta = SFX_META[name];
    const button = document.createElement('button');
    button.className = 'sfx';
    button.dataset.sound = name;
    button.innerHTML = `<span class="name">${meta.label}</span><span class="hint">${meta.hint}</span>`;
    button.addEventListener('click', () => {
      flashButton(button);
      triggerSound(name, { volume: 0.9 });
    });
    grid.appendChild(button);
    soundButtons.set(name, button);
  }
}

/* ------------------------------------------------------------------ */
/* Music / crowd / volume controls                                     */
/* ------------------------------------------------------------------ */

const musicButtons = new Map<MusicTrack, HTMLButtonElement>();
let activeTrack: MusicTrack | null = null;

function setActiveMusic(track: MusicTrack | null): void {
  activeTrack = track;
  for (const [key, button] of musicButtons) button.classList.toggle('flash', key === track);
  el<HTMLElement>('#st-music').textContent = track ?? '—';
  if (track) logLine(`music → <b>${track}</b>`);
}

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-track]')) {
  const track = button.dataset.track as MusicTrack;
  musicButtons.set(track, button);
  button.addEventListener('click', () => {
    audio.unlock();
    audio.startMusic(track);
    setActiveMusic(track);
  });
}

el<HTMLButtonElement>('[data-act="music-stop"]').addEventListener('click', () => {
  audio.stopMusic(1.2);
  setActiveMusic(null);
  logLine('music fading out (1.2 s)');
});

const crowdSlider = el<HTMLInputElement>('#s-crowd');
const crowdValue = el<HTMLElement>('#v-crowd');
crowdSlider.addEventListener('input', () => {
  const level = Number(crowdSlider.value);
  audio.setCrowd(level);
  crowdValue.textContent = level.toFixed(2);
});

function bindCheer(selector: string, act: () => void): void {
  el<HTMLButtonElement>(selector).addEventListener('click', () => {
    audio.unlock();
    act();
  });
}

bindCheer('[data-act="crowd-calm"]', () => {
  crowdSlider.value = '0.15';
  crowdValue.textContent = '0.15';
  audio.setCrowd(0.15);
  logLine('crowd → 0.15 (idle murmur)');
});
bindCheer('[data-act="cheer-half"]', () => {
  crowdSlider.value = '0.6';
  crowdValue.textContent = '0.60';
  audio.setCrowd(0.6);
  audio.cheer(0.5);
  logLine('cheer(0.5) + crowd 0.60');
});
bindCheer('[data-act="cheer-full"]', () => {
  crowdSlider.value = '1';
  crowdValue.textContent = '1.00';
  audio.setCrowd(1);
  audio.cheer(1);
  logLine('cheer(1.0) + crowd 1.00');
});

const sliders = {
  master: el<HTMLInputElement>('#s-master'),
  music: el<HTMLInputElement>('#s-music'),
  sfx: el<HTMLInputElement>('#s-sfx'),
};
const sliderValues = {
  master: el<HTMLElement>('#v-master'),
  music: el<HTMLElement>('#v-music'),
  sfx: el<HTMLElement>('#v-sfx'),
};

function pushVolumes(): void {
  audio.setVolumes(Number(sliders.master.value), Number(sliders.music.value), Number(sliders.sfx.value));
  sliderValues.master.textContent = Number(sliders.master.value).toFixed(2);
  sliderValues.music.textContent = Number(sliders.music.value).toFixed(2);
  sliderValues.sfx.textContent = Number(sliders.sfx.value).toFixed(2);
}

for (const slider of [sliders.master, sliders.music, sliders.sfx]) {
  slider.addEventListener('input', pushVolumes);
}

/* ------------------------------------------------------------------ */
/* Probes (also exposed on window.__audioLab for headless QA)          */
/* ------------------------------------------------------------------ */

interface VerifySfxResult {
  ok: boolean;
  state: string | null;
  expected: number;
  plays: number;
  drops: number;
  recipeErrors: number;
  peak: number;
  voices: number;
  missing: string[];
}

async function verifySfx(): Promise<VerifySfxResult> {
  audio.unlock();
  await wait(260);
  audio.resetStats();
  const played: SfxName[] = [];
  for (const name of SFX_NAMES) {
    audio.play(name, { volume: 0.85 });
    played.push(name);
    await wait(80);
  }
  const peak = await audio.measurePeak(700);
  const diag = audio.getDiagnostics();
  const missing = SFX_NAMES.filter((name) => !played.includes(name));
  const result: VerifySfxResult = {
    ok:
      diag.state === 'running' &&
      diag.plays === SFX_NAMES.length &&
      diag.errors === 0 &&
      missing.length === 0 &&
      peak > 0.002,
    state: diag.state,
    expected: SFX_NAMES.length,
    plays: diag.plays,
    drops: diag.drops,
    recipeErrors: diag.errors,
    peak,
    voices: diag.voices,
    missing,
  };
  logLine(
    `verify SFX: <b>${result.plays}/${result.expected}</b> recipes · peak ${result.peak.toFixed(3)} · errors ${result.recipeErrors} · ${result.ok ? 'PASS' : 'FAIL'}`,
    result.ok ? 'ok' : 'err',
  );
  return result;
}

interface StressResult {
  ok: boolean;
  fired: number;
  plays: number;
  drops: number;
  thrown: number;
  recipeErrors: number;
  maxVoices: number;
  voiceCap: number;
  state: string | null;
}

async function stressRun(count = 200): Promise<StressResult> {
  audio.unlock();
  await wait(220);
  audio.resetStats();
  let maxVoices = 0;
  let thrown = 0;
  for (let i = 0; i < count; i++) {
    const name = SFX_NAMES[Math.floor(Math.random() * SFX_NAMES.length)];
    try {
      audio.play(name, { volume: 0.5 + Math.random() * 0.5, rate: 0.85 + Math.random() * 0.3 });
    } catch {
      thrown++;
    }
    if (i % 4 === 0) {
      maxVoices = Math.max(maxVoices, audio.getDiagnostics().voices);
      await wait(2);
    }
  }
  maxVoices = Math.max(maxVoices, audio.getDiagnostics().voices);
  const peak = await audio.measurePeak(300);
  const diag = audio.getDiagnostics();
  const result: StressResult = {
    ok:
      diag.state === 'running' &&
      thrown === 0 &&
      diag.errors === 0 &&
      maxVoices <= MAX_SFX_VOICES &&
      diag.plays + diag.drops === count &&
      peak > 0.002,
    fired: count,
    plays: diag.plays,
    drops: diag.drops,
    thrown,
    recipeErrors: diag.errors,
    maxVoices,
    voiceCap: MAX_SFX_VOICES,
    state: diag.state,
  };
  logLine(
    `stress ×${count}: played <b>${result.plays}</b> · throttled ${result.drops} · max voices ${result.maxVoices}/${result.voiceCap} · peak ${peak.toFixed(3)} · ${result.ok ? 'PASS' : 'FAIL'}`,
    result.ok ? 'ok' : 'err',
  );
  return result;
}

interface MusicVerifyRow {
  track: MusicTrack;
  reported: MusicTrack | null;
  peak: number;
}

interface VerifyMusicResult {
  ok: boolean;
  rows: MusicVerifyRow[];
  state: string | null;
}

async function verifyMusic(): Promise<VerifyMusicResult> {
  audio.unlock();
  const previous = audio.getVolumes();
  audio.setVolumes(previous.master, 1, 0);
  await wait(180);
  const rows: MusicVerifyRow[] = [];
  for (const track of MUSIC_TRACKS) {
    audio.startMusic(track);
    await wait(950);
    const peak = await audio.measurePeak(400);
    rows.push({ track, reported: audio.getDiagnostics().music, peak });
    logLine(`music <b>${track}</b> · peak ${peak.toFixed(4)}`);
  }
  audio.stopMusic(0.4);
  await wait(200);
  audio.setVolumes(previous.master, previous.music, previous.sfx);
  const ok = rows.every((row) => row.reported === row.track && row.peak > 0.0015);
  logLine(`verify music: ${ok ? 'PASS' : 'FAIL'}`, ok ? 'ok' : 'err');
  return { ok, rows, state: audio.getDiagnostics().state };
}

interface SpatialProbeResult {
  ok: boolean;
  state: string | null;
  left: { gain: number; pan: number };
  right: { gain: number; pan: number };
  far: { gain: number; pan: number };
  demo: { played: boolean };
  fired: number;
}

async function verifySpatial(): Promise<SpatialProbeResult> {
  audio.unlock();
  orbiting = false;
  camera.position.set(0, 1.7, 0);
  camera.lookAt(0, 1.7, -9);
  camera.updateMatrixWorld(true);
  audio.update(camera, 0.016);
  await wait(60);

  const left = audio.debugSpatial({ x: -4, y: 1, z: -2 });
  const right = audio.debugSpatial({ x: 4, y: 1, z: -2 });
  const far = audio.debugSpatial({ x: 0, y: 1, z: -40 });

  const hit = (x: number, z: number): void => {
    audio.play('hit-flesh', { pos: new THREE.Vector3(x, 1, z), volume: 1 });
    addSpatialDot(x, z);
  };
  hit(-4, -2);
  await wait(150);
  hit(4, -2);
  await wait(150);
  hit(0, -40);
  await wait(200);

  lastSpatialText = `L pan ${left.pan.toFixed(2)} · R pan ${right.pan.toFixed(2)} · far g ${far.gain.toFixed(3)}`;
  el<HTMLElement>('#cmp-last').textContent = lastSpatialText;
  const result: SpatialProbeResult = {
    ok: left.pan < -0.25 && right.pan > 0.25 && far.gain < 0.35 && left.gain > 0.1,
    state: audio.getDiagnostics().state,
    left,
    right,
    far,
    demo: { played: true },
    fired: 3,
  };
  logLine(
    `spatial: L(${left.pan.toFixed(2)}) R(${right.pan.toFixed(2)}) far gain ${far.gain.toFixed(3)} · ${result.ok ? 'PASS' : 'FAIL'}`,
    result.ok ? 'ok' : 'err',
  );
  return result;
}

interface RebuildResult {
  ok: boolean;
  state: string | null;
  ready: boolean;
  peak: number;
  music: MusicTrack | null;
}

async function rebuildEngine(): Promise<RebuildResult> {
  logLine('dispose → unlock (clean rebuild)');
  audio.dispose();
  await wait(160);
  audio.unlock();
  await wait(240);
  audio.startMusic('menu');
  audio.setCrowd(0.5);
  audio.play('gong', { volume: 0.8 });
  const peak = await audio.measurePeak(500);
  const diag = audio.getDiagnostics();
  const result: RebuildResult = {
    ok: diag.ready && diag.state === 'running' && peak > 0.002,
    state: diag.state,
    ready: diag.ready,
    peak,
    music: diag.music,
  };
  setActiveMusic(result.music);
  logLine(`rebuild: state <b>${result.state}</b> · peak ${peak.toFixed(3)} · ${result.ok ? 'PASS' : 'FAIL'}`, result.ok ? 'ok' : 'err');
  return result;
}

/* ------------------------------------------------------------------ */
/* Probe button wiring                                                 */
/* ------------------------------------------------------------------ */

const probeActions: Record<string, () => Promise<unknown>> = {
  'verify-sfx': verifySfx,
  stress: () => stressRun(200),
  'verify-music': verifyMusic,
  'verify-spatial': verifySpatial,
  rebuild: rebuildEngine,
};

let probeBusy = false;
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-act]')) {
  const action = button.dataset.act ?? '';
  const probe = probeActions[action];
  if (!probe) continue;
  button.addEventListener('click', () => {
    if (probeBusy) {
      logLine('probe already running…', 'err');
      return;
    }
    probeBusy = true;
    void probe()
      .catch((error: unknown) => logLine(`probe failed: ${String(error)}`, 'err'))
      .finally(() => {
        probeBusy = false;
      });
  });
}

/* ------------------------------------------------------------------ */
/* Status + meter rendering                                            */
/* ------------------------------------------------------------------ */

const stState = el<HTMLElement>('#st-state');
const stMusic = el<HTMLElement>('#st-music');
const stVoices = el<HTMLElement>('#st-voices');
const stCrowd = el<HTMLElement>('#st-crowd');
const stPlays = el<HTMLElement>('#st-plays');
const stDb = el<HTMLElement>('#st-db');
const veil = el<HTMLDivElement>('#veil');

const meterCanvas = el<HTMLCanvasElement>('#meter');
const meterCtx = meterCanvas.getContext('2d');
const meterHistory: number[] = new Array(180).fill(0);

const compassCanvas = el<HTMLCanvasElement>('#compass');
const compassCtx = compassCanvas.getContext('2d');

function dbToX(db: number, width: number): number {
  const t = Math.max(0, Math.min(1, (db + 60) / 60));
  return t * width;
}

function drawMeter(peak: number): void {
  if (!meterCtx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = meterCanvas.clientWidth || 600;
  const height = meterCanvas.clientHeight || 44;
  const pixelW = Math.max(1, Math.floor(width * dpr));
  const pixelH = Math.max(1, Math.floor(height * dpr));
  if (meterCanvas.width !== pixelW || meterCanvas.height !== pixelH) {
    meterCanvas.width = pixelW;
    meterCanvas.height = pixelH;
  }
  const ctx = meterCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  // dB grid.
  ctx.strokeStyle = 'rgba(176, 141, 87, 0.14)';
  ctx.lineWidth = 1;
  for (const db of [-6, -12, -24, -36, -48]) {
    const x = dbToX(db, width) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  ctx.fillStyle = 'rgba(160, 142, 115, 0.4)';
  ctx.font = "8px 'Barlow Condensed', sans-serif";
  ctx.fillText('-6', dbToX(-6, width) - 9, height - 3);
  ctx.fillText('-24', dbToX(-24, width) - 11, height - 3);
  ctx.fillText('-48', dbToX(-48, width) - 11, height - 3);

  // Rolling level history as a mirrored waveform.
  const n = meterHistory.length;
  const mid = height / 2;
  for (let i = 0; i < n; i++) {
    const value = meterHistory[i];
    const amp = Math.pow(Math.min(1, value * 2.4), 0.6) * (height * 0.44);
    const x = (i / n) * width;
    const bw = Math.max(1, width / n - 0.6);
    const hue = value > 0.7 ? '#d0603c' : value > 0.28 ? '#d8b46a' : '#8a6f45';
    ctx.fillStyle = hue;
    ctx.globalAlpha = 0.28 + value * 2.2;
    ctx.fillRect(x, mid - amp, bw, amp * 2);
  }
  ctx.globalAlpha = 1;

  // Instant peak marker with a soft glow.
  const db = peak > 1e-6 ? 20 * Math.log10(peak) : -80;
  const markerX = dbToX(db, width);
  ctx.save();
  ctx.shadowColor = 'rgba(224, 189, 124, 0.9)';
  ctx.shadowBlur = 8;
  ctx.strokeStyle = peak > 0.9 ? '#e3704a' : '#efd095';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(markerX, 2);
  ctx.lineTo(markerX, height - 2);
  ctx.stroke();
  ctx.restore();
}

function drawCompass(): void {
  if (!compassCtx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = compassCanvas.clientWidth || 122;
  const height = compassCanvas.clientHeight || 92;
  const pixelW = Math.max(1, Math.floor(width * dpr));
  const pixelH = Math.max(1, Math.floor(height * dpr));
  if (compassCanvas.width !== pixelW || compassCanvas.height !== pixelH) {
    compassCanvas.width = pixelW;
    compassCanvas.height = pixelH;
  }
  const ctx = compassCtx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scale = Math.min(width / 54, height / 46);
  const cx = width / 2;
  const cy = height / 2;
  const mapX = (x: number): number => cx + x * scale;
  const mapY = (z: number): number => cy + z * scale;

  // Arena floor.
  ctx.strokeStyle = 'rgba(176, 141, 87, 0.28)';
  ctx.lineWidth = 1;
  ctx.strokeRect(mapX(-25), mapY(-21), 50 * scale, 42 * scale);
  ctx.strokeStyle = 'rgba(176, 141, 87, 0.12)';
  ctx.beginPath();
  ctx.moveTo(cx, 2);
  ctx.lineTo(cx, height - 2);
  ctx.moveTo(2, cy);
  ctx.lineTo(width - 2, cy);
  ctx.stroke();

  // Falling spatial event dots.
  for (const dot of spatialDots) {
    const fade = Math.max(0, 1 - dot.age / 2.2);
    if (fade <= 0) continue;
    ctx.beginPath();
    ctx.arc(mapX(dot.x), mapY(dot.z), 2.6 + (1 - fade) * 4, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(224, 189, 124, ${fade * 0.9})`;
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(mapX(dot.x), mapY(dot.z), 1.7, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(224, 189, 124, ${fade})`;
    ctx.fill();
  }

  // Listener position + facing.
  const px = mapX(camera.position.x);
  const py = mapY(camera.position.z);
  const e = camera.matrixWorld.elements;
  const fx = e[8];
  const fz = e[10];
  ctx.beginPath();
  ctx.arc(px, py, 3.4, 0, Math.PI * 2);
  ctx.fillStyle = '#b08d57';
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + fx * 12, py + fz * 12);
  ctx.strokeStyle = 'rgba(224, 189, 124, 0.85)';
  ctx.lineWidth = 1.6;
  ctx.stroke();

  ctx.fillStyle = 'rgba(160, 142, 115, 0.55)';
  ctx.font = "8px 'Barlow Condensed', sans-serif";
  ctx.fillText('GATE', 4, 10);
}

function updateStatus(diag: ReturnType<typeof audio.getDiagnostics>): void {
  const state = diag.state ?? 'locked';
  stState.textContent = state;
  stState.className = state === 'running' ? 'on' : 'off';
  stMusic.textContent = diag.music ?? '—';
  stVoice(diag.voices);
  stCrowd.textContent = diag.crowd.toFixed(2);
  stPlays.textContent = `${diag.plays} / ${diag.drops}`;
  stDb.textContent = diag.peak > 1e-6 ? `−${Math.abs(20 * Math.log10(diag.peak)).toFixed(1)}` : '−∞';
  veil.classList.toggle('hidden', state === 'running');
}

function stVoice(count: number): void {
  stVoices.textContent = `${count}`;
  stVoices.className = count > MAX_SFX_VOICES * 0.8 ? 'off' : count > 0 ? 'gold' : '';
}

/* ------------------------------------------------------------------ */
/* Frame loop                                                          */
/* ------------------------------------------------------------------ */

let lastFrame = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;

  if (orbiting) {
    orbitTime += dt;
    const radius = 9.5;
    camera.position.set(Math.sin(orbitTime * 0.16) * radius, 2.1, Math.cos(orbitTime * 0.16) * radius);
    camera.lookAt(0, 1.4, 0);
    camera.updateMatrixWorld(true);
  }

  audio.update(camera, dt);
  const diag = audio.getDiagnostics();
  meterHistory.push(diag.peak);
  meterHistory.shift();

  for (const dot of spatialDots) dot.age += dt;
  for (let i = spatialDots.length - 1; i >= 0; i--) {
    if (spatialDots[i].age > 2.2) spatialDots.splice(i, 1);
  }

  drawMeter(diag.peak);
  drawCompass();
  updateStatus(diag);
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ */
/* Unlock veil + boot                                                  */
/* ------------------------------------------------------------------ */

el<HTMLButtonElement>('#unlock').addEventListener('click', () => {
  audio.unlock();
  audio.setCrowd(0.4);
  crowdSlider.value = '0.4';
  crowdValue.textContent = '0.40';
  audio.startMusic('menu');
  setActiveMusic('menu');
  logLine('audio unlocked · crowd bed 0.40 · menu music');
  window.setTimeout(() => {
    if (audio.getDiagnostics().state !== 'running') {
      logLine('AudioContext still suspended — click anywhere to retry', 'err');
    }
  }, 600);
});

window.setTimeout(() => {
  logLine(`audio-lab ready · ${SFX_NAMES.length} recipes · ${MUSIC_TRACKS.length} tracks · voice cap ${MAX_SFX_VOICES} · throttle ${THROTTLE_MS} ms`);
  logLine('click “Enter the Lists” or any signal to unlock the AudioContext');
}, 150);

const autostart = new URLSearchParams(location.search).has('autostart');
if (autostart) {
  audio.unlock();
  audio.setCrowd(0.55);
  crowdSlider.value = '0.55';
  crowdValue.textContent = '0.55';
  audio.startMusic('tournament');
  setActiveMusic('tournament');
  window.setTimeout(() => {
    audio.play('horn', { volume: 0.8 });
    window.setTimeout(() => audio.play('gong', { volume: 0.7 }), 700);
    window.setTimeout(() => audio.cheer(0.8), 1400);
  }, 400);
}

/* ------------------------------------------------------------------ */
/* Headless QA surface                                                 */
/* ------------------------------------------------------------------ */

interface PlayProbe {
  played: boolean;
  state: string | null;
  voices: number;
  plays: number;
}

interface AudioLabApi {
  unlock(): { state: string | null; ready: boolean };
  status(): ReturnType<typeof audio.getDiagnostics>;
  play(
    name: SfxName,
    opts?: { volume?: number; rate?: number; x?: number; y?: number; z?: number },
  ): PlayProbe;
  verifySfx(): Promise<VerifySfxResult>;
  stress(count?: number): Promise<StressResult>;
  verifyMusic(): Promise<VerifyMusicResult>;
  verifySpatial(): Promise<SpatialProbeResult>;
  rebuild(): Promise<RebuildResult>;
  setCrowd(value: number): void;
  cheer(strength?: number): void;
  startMusic(track: MusicTrack): void;
  stopMusic(): void;
  setVolumes(master: number, music: number, sfx: number): void;
  recipes(): SfxName[];
  tracks(): MusicTrack[];
}

const api: AudioLabApi = {
  unlock() {
    audio.unlock();
    return { state: audio.getDiagnostics().state, ready: audio.isReady };
  },
  status() {
    return audio.getDiagnostics();
  },
  play(name, opts) {
    if (!SFX_NAMES.includes(name)) throw new Error(`unknown sfx ${name}`);
    const before = audio.getDiagnostics().plays;
    const pos = opts && (opts.x !== undefined || opts.y !== undefined || opts.z !== undefined)
      ? new THREE.Vector3(opts.x ?? 0, opts.y ?? 1, opts.z ?? 0)
      : undefined;
    if (pos) addSpatialDot(pos.x, pos.z);
    audio.play(name, { volume: opts?.volume ?? 0.9, rate: opts?.rate, pos });
    const diag = audio.getDiagnostics();
    return { played: diag.plays > before, state: diag.state, voices: diag.voices, plays: diag.plays };
  },
  verifySfx,
  stress: (count = 200) => stressRun(count),
  verifyMusic,
  verifySpatial,
  rebuild: rebuildEngine,
  setCrowd(value: number) {
    audio.setCrowd(value);
    crowdSlider.value = String(Math.max(0, Math.min(1, value)));
    crowdValue.textContent = Number(crowdSlider.value).toFixed(2);
  },
  cheer(strength = 1) {
    audio.cheer(strength);
  },
  startMusic(track: MusicTrack) {
    audio.startMusic(track);
    setActiveMusic(track);
  },
  stopMusic() {
    audio.stopMusic(1.2);
    setActiveMusic(null);
  },
  setVolumes(master: number, music: number, sfx: number) {
    sliders.master.value = String(master);
    sliders.music.value = String(music);
    sliders.sfx.value = String(sfx);
    pushVolumes();
  },
  recipes: () => [...SFX_NAMES],
  tracks: () => [...MUSIC_TRACKS],
};

declare global {
  interface Window {
    __audioLab: AudioLabApi;
    __ready?: boolean;
  }
}

window.__audioLab = api;
window.__ready = true;

requestAnimationFrame(frame);
