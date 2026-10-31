/**
 * BLADE & MOUNT — procedural audio engine (WebAudio, zero assets).
 *
 * Signal flow:
 *
 *   SFX voices ─┬─→ sfx bus ─┐
 *               └─→ sfx reverb send → convolver ─┤
 *   crowd bed ───────────────────────────────────┤→ master → glue comp
 *   music ─────┬──────────────────────────────────┘        → limiter
 *              └─→ music reverb send → convolver ─→         → analyser → out
 *
 * Design notes:
 *  - Every sound is synthesised at runtime (see ./sfx.ts); music is a
 *    Karplus–Strong / drone / frame-drum sequencer (see ./music.ts).
 *  - One-shot voices are capped and identical names are throttled, so a
 *    16-fighter brawl cannot build a wall of phasey noise.
 *  - Positional one-shots use distance attenuation plus a constant-power-ish
 *    stereo pan relative to the camera right vector (no PannerNode HRTF cost).
 *  - The engine never throws when locked/suspended/unsupported: it degrades to
 *    silence and resumes on the next user gesture.
 */

import type * as THREE from 'three';
import type { AudioAPI, MusicTrack, SfxName } from '../core/types';
import {
  clamp01,
  IDENTITY_LISTENER,
  makeImpulseResponse,
  makeNoiseBuffer,
  MAX_SFX_VOICES,
  safeRate,
  spatialMix,
  THROTTLE_MS,
  volumeCurve,
  type Listener,
  type NoiseColor,
} from './dsp';
import { MusicPlayer } from './music';
import {
  ambientRoar,
  ambientShout,
  playRecipe,
  SfxKit,
  type NoiseBank,
} from './sfx';

/* ------------------------------------------------------------------ */
/* Mix tuning                                                          */
/* ------------------------------------------------------------------ */

/** Per-name retrigger guard (ms). The default for anything omitted. */
const GAP_MS: Partial<Record<SfxName, number>> = {
  swing: 30,
  'swing-heavy': 36,
  'hit-flesh': 30,
  'hit-armor': 30,
  'hit-shield': 30,
  'block-weapon': 34,
  'guard-break': 55,
  kick: 50,
  death: 70,
  footstep: 38,
  dodge: 60,
  spawn: 60,
  gong: 400,
  horn: 420,
  'crowd-cheer': 220,
  'ui-click': 30,
  'ui-hover': 34,
  bet: 60,
  victory: 500,
  defeat: 500,
  'round-start': 360,
  'bet-win': 90,
  'bet-lose': 90,
};

/** Simultaneous instances allowed per name. */
const MAX_SAME: Partial<Record<SfxName, number>> = {
  gong: 1,
  horn: 2,
  victory: 1,
  defeat: 1,
  'round-start': 1,
  'crowd-cheer': 3,
  death: 3,
  swing: 5,
  'swing-heavy': 4,
  footstep: 3,
  'hit-flesh': 5,
  'hit-armor': 4,
  'hit-shield': 4,
  'block-weapon': 4,
  'guard-break': 2,
  kick: 3,
};

/** How much of each sound is blended into the shared stone-hall reverb. */
const REVERB_SEND: Partial<Record<SfxName, number>> = {
  gong: 0.62,
  horn: 0.42,
  'round-start': 0.38,
  victory: 0.46,
  defeat: 0.5,
  'crowd-cheer': 0.24,
  death: 0.2,
  'block-weapon': 0.24,
  'guard-break': 0.2,
  'hit-armor': 0.17,
  bet: 0.1,
  'bet-win': 0.16,
  'bet-lose': 0.12,
  spawn: 0.3,
};

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  glue: DynamicsCompressorNode;
  limiter: DynamicsCompressorNode;
  analyser: AnalyserNode;
  sfx: GainNode;
  music: GainNode;
  sfxReverb: ConvolverNode;
  sfxReverbSend: GainNode;
  musicReverb: ConvolverNode;
  musicReverbSend: GainNode;
  crowdBus: GainNode;
  crowdNodes: AudioNode[];
}

interface VoiceOut {
  input: GainNode;
  dispose(): void;
}

interface Voice {
  name: SfxName | 'ambient';
  endAt: number;
}

interface VolumeState {
  master: number;
  music: number;
  sfx: number;
}

type AmbientKind = 'shout' | 'roar';

/* ------------------------------------------------------------------ */
/* Engine                                                              */
/* ------------------------------------------------------------------ */

export class AudioEngine implements AudioAPI {
  private g: Graph | null = null;
  private banks: NoiseBank | null = null;
  private music: MusicPlayer | null = null;
  private musicWanted: MusicTrack | null = null;

  private voices: Voice[] = [];
  private lastAt = new Map<SfxName, number>();
  private lastPrune = 0;
  private timers = new Set<number>();

  private vols: VolumeState = { master: 0.85, music: 0.5, sfx: 0.85 };
  private listener: Listener = { ...IDENTITY_LISTENER };

  private crowdTarget = 0;
  private crowdCur = 0;
  private crowdSwell = 0;
  private nextShoutAt = 0;

  private peakBuf = new Float32Array(1024);
  private disposed = false;

  /** QA counters (used by the audio lab to prove coverage/robustness). */
  private statPlays = 0;
  private statDrops = 0;
  private statRecipeErrors = 0;

  /* ------------------------------ graph --------------------------- */

  unlock(): void {
    this.disposed = false;
    const existing = this.g;
    if (existing) {
      this.resume(existing.ctx);
      return;
    }
    try {
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor({ latencyHint: 'interactive' });

      // Master chain: mix → glue compressor → brick-wall-ish limiter → out.
      const master = ctx.createGain();
      master.gain.value = this.masterTarget();
      const glue = ctx.createDynamicsCompressor();
      glue.threshold.value = -17;
      glue.knee.value = 22;
      glue.ratio.value = 2.6;
      glue.attack.value = 0.005;
      glue.release.value = 0.24;
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -2.5;
      limiter.knee.value = 0;
      limiter.ratio.value = 20;
      limiter.attack.value = 0.0015;
      limiter.release.value = 0.09;
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.55;

      master.connect(glue);
      glue.connect(limiter);
      limiter.connect(analyser);
      analyser.connect(ctx.destination);

      const sfx = ctx.createGain();
      sfx.gain.value = this.sfxTarget();
      sfx.connect(master);

      const music = ctx.createGain();
      music.gain.value = this.musicTarget();
      music.connect(master);

      // One generated impulse shared by both reverbs (cheap: one buffer).
      const impulse = makeImpulseResponse(ctx, 2.7, 3.1);
      const sfxReverb = ctx.createConvolver();
      sfxReverb.buffer = impulse;
      const sfxReverbSend = ctx.createGain();
      sfxReverbSend.gain.value = 1;
      sfxReverbSend.connect(sfxReverb);
      sfxReverb.connect(sfx);

      const musicReverb = ctx.createConvolver();
      musicReverb.buffer = impulse;
      const musicReverbSend = ctx.createGain();
      musicReverbSend.gain.value = 1;
      musicReverbSend.connect(musicReverb);
      musicReverb.connect(music);

      const crowdBus = ctx.createGain();
      crowdBus.gain.value = 0;
      crowdBus.connect(sfx);

      const graph: Graph = {
        ctx,
        master,
        glue,
        limiter,
        analyser,
        sfx,
        music,
        sfxReverb,
        sfxReverbSend,
        musicReverb,
        musicReverbSend,
        crowdBus,
        crowdNodes: [],
      };
      this.g = graph;
      this.banks = {
        white: makeNoiseBuffer(ctx, 2, 'white' satisfies NoiseColor),
        pink: makeNoiseBuffer(ctx, 2, 'pink'),
        brown: makeNoiseBuffer(ctx, 2, 'brown'),
      };

      this.startCrowdBed(graph);

      this.music = new MusicPlayer({
        ctx,
        bus: music,
        send: musicReverbSend,
        noise: this.banks,
      });
      if (this.musicWanted) this.music.start(this.musicWanted);

      this.applyVolumes(true);
      this.resume(ctx);
    } catch {
      // No WebAudio, blocked context, or a hostile browser: stay silent.
      this.g = null;
      this.banks = null;
      this.music = null;
    }
  }

  private resume(ctx: AudioContext): void {
    if (ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const resuming = ctx.resume();
      if (resuming && typeof resuming.then === 'function') {
        void resuming.then(
          () => {
            if (ctx.state === 'running') removeGestureUnlock();
          },
          () => {
            /* still blocked; the next gesture retries */
          },
        );
      }
    } catch {
      /* blocked resume is not an error for gameplay */
    }
  }

  private userActivated(): boolean {
    if (typeof navigator === 'undefined') return false;
    const activation = (navigator as unknown as { userActivation?: { hasBeenActive: boolean } })
      .userActivation;
    if (!activation) return true; // older browsers: assume the caller knows
    return activation.hasBeenActive;
  }

  /**
   * Returns true when scheduling is worthwhile. Attempts a resume when a real
   * gesture has happened; otherwise the sound is dropped rather than queued
   * (avoids dumping a pile of notes when autoplay unlocks late).
   */
  private ensureRunning(ctx: AudioContext): boolean {
    if (ctx.state === 'running') return true;
    if (ctx.state === 'closed') return false;
    this.resume(ctx);
    return this.userActivated();
  }

  get isReady(): boolean {
    return this.g !== null && !this.disposed;
  }

  get state(): string | null {
    return this.g ? this.g.ctx.state : null;
  }

  get currentMusic(): MusicTrack | null {
    return this.music?.track ?? this.musicWanted;
  }

  get activeVoices(): number {
    return this.voices.length;
  }

  /* ---------------------------- crowd bed ------------------------- */

  private startCrowdBed(g: Graph): void {
    const ctx = g.ctx;
    const add = (node: AudioNode): AudioNode => {
      g.crowdNodes.push(node);
      return node;
    };

    /** Filtered loop of a noise bed with a slow, organic level drift. */
    const layer = (opts: {
      color: NoiseColor;
      type: BiquadFilterType;
      freq: number;
      q: number;
      rate: number;
      level: number;
      lfoHz: number;
      lfoDepth: number;
    }): void => {
      const src = ctx.createBufferSource();
      src.buffer = this.banks ? this.banks[opts.color] : makeNoiseBuffer(ctx, 2, opts.color);
      src.loop = true;
      src.playbackRate.value = opts.rate;
      const filter = ctx.createBiquadFilter();
      filter.type = opts.type;
      filter.frequency.value = opts.freq;
      filter.Q.value = opts.q;
      const gain = ctx.createGain();
      gain.gain.value = opts.level;
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = opts.lfoHz;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = opts.lfoDepth;
      lfo.connect(lfoGain);
      lfoGain.connect(gain.gain);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(g.crowdBus);
      add(src);
      add(filter);
      add(gain);
      add(lfo);
      add(lfoGain);
      src.start();
      lfo.start();
    };

    // Murmur body, upper chatter, air, and a roar bed that cheers push up.
    layer({ color: 'pink', type: 'bandpass', freq: 380, q: 0.55, rate: 1, level: 0.5, lfoHz: 0.073, lfoDepth: 0.16 });
    layer({ color: 'pink', type: 'bandpass', freq: 900, q: 0.85, rate: 1.17, level: 0.24, lfoHz: 0.113, lfoDepth: 0.09 });
    layer({ color: 'white', type: 'highpass', freq: 2900, q: 0.5, rate: 1.53, level: 0.05, lfoHz: 0.19, lfoDepth: 0.022 });
    layer({ color: 'pink', type: 'lowpass', freq: 620, q: 0.6, rate: 0.82, level: 0.34, lfoHz: 0.051, lfoDepth: 0.12 });
    layer({ color: 'brown', type: 'lowpass', freq: 240, q: 0.7, rate: 0.7, level: 0.24, lfoHz: 0.041, lfoDepth: 0.09 });

    // Crowd sits in the same hall as the weapons (subtle send).
    const send = ctx.createGain();
    send.gain.value = 0.12;
    g.crowdBus.connect(send);
    send.connect(g.sfxReverbSend);
    add(send);
  }

  setCrowd(level: number): void {
    this.crowdTarget = clamp01(level);
  }

  cheer(strength = 1): void {
    const amount = clamp01(strength);
    this.crowdSwell = Math.min(1.4, this.crowdSwell + 0.55 + amount * 0.6);
    this.play('crowd-cheer', { volume: 0.5 + amount * 0.5 });
    // A low roar underneath makes a full-arena cheer feel like a wall of people.
    if (this.g) this.playAmbient('roar', 0, 0.22 + amount * 0.3);
  }

  gong(): void {
    this.play('gong');
  }

  /* --------------------------- volumes ---------------------------- */

  setVolumes(master: number, music: number, sfx: number): void {
    this.vols = { master: clamp01(master), music: clamp01(music), sfx: clamp01(sfx) };
    if (this.g) this.applyVolumes(false);
  }

  getVolumes(): VolumeState {
    return { ...this.vols };
  }

  private masterTarget(): number {
    return 0.74 * volumeCurve(this.vols.master, 1.25);
  }

  private sfxTarget(): number {
    return 0.95 * volumeCurve(this.vols.sfx, 1.1);
  }

  private musicTarget(): number {
    return 0.56 * volumeCurve(this.vols.music, 1.1);
  }

  private applyVolumes(immediate: boolean): void {
    const g = this.g;
    if (!g) return;
    const now = g.ctx.currentTime;
    const set = (param: AudioParam, value: number, tau: number): void => {
      if (immediate) param.setValueAtTime(value, now);
      else param.setTargetAtTime(value, now, tau);
    };
    set(g.master.gain, this.masterTarget(), 0.09);
    set(g.sfx.gain, this.sfxTarget(), 0.08);
    set(g.music.gain, this.musicTarget(), 0.14);
  }

  /* --------------------------- spatial ---------------------------- */

  update(camera: THREE.Camera, dt: number): void {
    const e = camera.matrixWorld.elements;
    this.listener.x = e[12];
    this.listener.y = e[13];
    this.listener.z = e[14];
    const rx = e[0];
    const rz = e[2];
    const len = Math.hypot(rx, rz) || 1;
    this.listener.rx = rx / len;
    this.listener.rz = rz / len;
    this.listener.fx = e[8];
    this.listener.fz = e[10];

    const g = this.g;
    if (!g) return;

    const now = performance.now();
    if (now - this.lastPrune > 120 && this.voices.length > 0) {
      this.voices = this.voices.filter((voice) => voice.endAt > now);
      this.lastPrune = now;
    }

    // Framerate-independent smoothing of the crowd bed.
    const step = Math.min(0.1, Math.max(0, dt));
    this.crowdCur += (this.crowdTarget - this.crowdCur) * (1 - Math.exp(-1.6 * step));
    this.crowdSwell *= Math.exp(-1.15 * step);

    if (g.ctx.state === 'running') {
      const level = 0.02 + this.crowdCur * 0.3 + this.crowdSwell * 0.14;
      g.crowdBus.gain.setTargetAtTime(level, g.ctx.currentTime, 0.2);

      // Occasional lone shouts from the stands.
      if (this.crowdCur > 0.1 && g.ctx.currentTime > this.nextShoutAt) {
        this.nextShoutAt = g.ctx.currentTime + 1.3 + Math.random() * 3.2;
        const chance = 0.2 + this.crowdCur * 0.7;
        if (Math.random() < chance) {
          this.playAmbient('shout', Math.random() * 1.7 - 0.85, 0.25 + this.crowdCur * 0.55);
        } else if (Math.random() < 0.18) {
          this.playAmbient('roar', Math.random() * 1.2 - 0.6, 0.14 + this.crowdCur * 0.2);
        }
      }
    }
  }

  /** Debug helper used by the lab: what would a sound at `pos` sound like? */
  debugSpatial(pos: { x: number; y: number; z: number }): { gain: number; pan: number } {
    return spatialMix(pos, this.listener);
  }

  /* ------------------------------ play ---------------------------- */

  play(name: SfxName, opts?: { pos?: THREE.Vector3; volume?: number; rate?: number }): void {
    if (this.tryPlay(name, opts)) this.statPlays++;
    else this.statDrops++;
  }

  /** Returns true when a voice was actually created. */
  private tryPlay(name: SfxName, opts?: { pos?: THREE.Vector3; volume?: number; rate?: number }): boolean {
    const g = this.g;
    const banks = this.banks;
    if (!g || !banks || this.disposed) return false;
    if (!this.ensureRunning(g.ctx)) return false;

    const now = performance.now();
    const gap = GAP_MS[name] ?? THROTTLE_MS;
    const last = this.lastAt.get(name) ?? 0;
    if (now - last < gap) return false;

    let same = 0;
    for (const voice of this.voices) if (voice.name === name) same++;
    if (same >= (MAX_SAME[name] ?? 4)) return false;
    if (this.voices.length >= MAX_SFX_VOICES) return false;

    if (now - this.lastPrune > 120) {
      this.voices = this.voices.filter((voice) => voice.endAt > now);
      this.lastPrune = now;
      if (this.voices.length >= MAX_SFX_VOICES) return false;
    }

    const pos = opts?.pos;
    const mix = pos ? spatialMix(pos, this.listener) : { gain: 1, pan: 0 };
    const volume = clamp01(opts?.volume ?? 1) * mix.gain;
    if (volume < 0.012) return false;

    const rate = safeRate(opts?.rate);
    const send = REVERB_SEND[name] ?? 0.16;
    const voice = this.createVoice(mix.pan, volume, send);
    if (!voice) return false;

    let duration: number;
    try {
      const kit = new SfxKit({
        ctx: g.ctx,
        out: voice.input,
        noise: banks,
        start: g.ctx.currentTime + 0.004,
        rate,
      });
      duration = playRecipe(name, kit);
    } catch {
      this.statRecipeErrors++;
      voice.dispose();
      return false;
    }

    this.lastAt.set(name, now);
    this.trackVoice(name, duration, voice);
    return true;
  }

  /** Ambience voices are not part of the public API: engine-driven only. */
  private playAmbient(kind: AmbientKind, pan: number, volume01: number): void {
    const g = this.g;
    const banks = this.banks;
    if (!g || !banks || this.disposed) return;
    if (!this.ensureRunning(g.ctx)) return;
    if (this.voices.length >= MAX_SFX_VOICES) return;
    const voice = this.createVoice(pan, clamp01(volume01), 0.14);
    if (!voice) return;
    let duration = 0.8;
    try {
      const kit = new SfxKit({
        ctx: g.ctx,
        out: voice.input,
        noise: banks,
        start: g.ctx.currentTime + 0.004,
        rate: 1,
      });
      duration = kind === 'shout' ? ambientShout(kit, pan, clamp01(volume01)) : ambientRoar(kit, pan, clamp01(volume01));
    } catch {
      voice.dispose();
      return;
    }
    this.trackVoice('ambient', duration, voice);
  }

  private trackVoice(name: SfxName | 'ambient', duration: number, voice: VoiceOut): void {
    const endAt = performance.now() + duration * 1000 + 120;
    this.voices.push({ name, endAt });
    const timer = window.setTimeout(
      () => {
        try {
          voice.dispose();
        } catch {
          /* context may already be closed */
        }
        this.timers.delete(timer);
      },
      Math.max(140, duration * 1000 + 180),
    );
    this.timers.add(timer);
  }

  private createVoice(pan: number, volume: number, send: number): VoiceOut | null {
    const g = this.g;
    if (!g) return null;
    const ctx = g.ctx;
    const input = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    const vol = ctx.createGain();
    vol.gain.value = Math.max(0.0001, volume);
    input.connect(panner);
    panner.connect(vol);
    vol.connect(g.sfx);
    let sendNode: GainNode | null = null;
    if (send > 0) {
      sendNode = ctx.createGain();
      sendNode.gain.value = send;
      vol.connect(sendNode);
      sendNode.connect(g.sfxReverbSend);
    }
    return {
      input,
      dispose: () => {
        try {
          input.disconnect();
          panner.disconnect();
          vol.disconnect();
          sendNode?.disconnect();
        } catch {
          /* already gone */
        }
      },
    };
  }

  /* ------------------------------ music --------------------------- */

  startMusic(track: MusicTrack): void {
    this.musicWanted = track;
    if (this.music) this.music.start(track);
  }

  stopMusic(fade = 1.2): void {
    this.musicWanted = null;
    if (this.music) this.music.stop(fade);
  }

  /* --------------------------- diagnostics ------------------------ */

  private readPeak(): number {
    const g = this.g;
    if (!g) return 0;
    if (this.peakBuf.length !== g.analyser.fftSize) {
      this.peakBuf = new Float32Array(g.analyser.fftSize);
    }
    g.analyser.getFloatTimeDomainData(this.peakBuf);
    let peak = 0;
    for (let i = 0; i < this.peakBuf.length; i++) {
      const abs = Math.abs(this.peakBuf[i]);
      if (abs > peak) peak = abs;
    }
    return peak;
  }

  getDiagnostics(): {
    ready: boolean;
    state: string | null;
    voices: number;
    music: MusicTrack | null;
    master: number;
    peak: number;
    crowd: number;
    target: number;
    plays: number;
    drops: number;
    errors: number;
    maxVoices: number;
    listener: { x: number; y: number; z: number };
  } {
    const peak = this.readPeak();
    return {
      ready: this.isReady,
      state: this.g ? this.g.ctx.state : null,
      voices: this.voices.length,
      music: this.currentMusic,
      master: this.vols.master,
      peak,
      crowd: this.crowdCur,
      target: this.crowdTarget,
      plays: this.statPlays,
      drops: this.statDrops,
      errors: this.statRecipeErrors,
      maxVoices: MAX_SFX_VOICES,
      listener: { x: this.listener.x, y: this.listener.y, z: this.listener.z },
    };
  }

  /** Reset the QA counters (lab does this before each verification run). */
  resetStats(): void {
    this.statPlays = 0;
    this.statDrops = 0;
    this.statRecipeErrors = 0;
  }

  /** Peak amplitude over a window — the lab/QA uses this to prove signal. */
  async measurePeak(ms = 400): Promise<number> {
    if (!this.g) return 0;
    const end = performance.now() + Math.max(50, ms);
    let peak = 0;
    while (performance.now() < end) {
      peak = Math.max(peak, this.readPeak());
      await new Promise((resolve) => window.setTimeout(resolve, 16));
    }
    return peak;
  }

  /* ----------------------------- teardown ------------------------- */

  dispose(): void {
    this.disposed = true;
    for (const id of this.timers) window.clearTimeout(id);
    this.timers.clear();
    this.voices = [];
    this.lastAt.clear();
    this.music?.dispose();
    this.music = null;
    this.musicWanted = null;
    this.banks = null;
    const g = this.g;
    this.g = null;
    if (g) {
      try {
        for (const node of g.crowdNodes) node.disconnect();
        for (const node of [
          g.crowdBus,
          g.musicReverbSend,
          g.musicReverb,
          g.sfxReverbSend,
          g.sfxReverb,
          g.sfx,
          g.music,
          g.analyser,
          g.limiter,
          g.glue,
          g.master,
        ]) {
          node.disconnect();
        }
      } catch {
        /* ignore partially built graphs */
      }
      void g.ctx.close().catch(() => undefined);
    }
    this.crowdCur = 0;
    this.crowdSwell = 0;
    removeGestureUnlock();
  }
}

/* ------------------------------------------------------------------ */
/* Singleton + first-gesture unlock                                    */
/* ------------------------------------------------------------------ */

export const audio = new AudioEngine();

/** Create an isolated engine (tests / multiple mixes). */
export function createAudio(): AudioAPI {
  return new AudioEngine();
}

let removeGesture: (() => void) | null = null;

function installGestureUnlock(): void {
  if (typeof window === 'undefined' || removeGesture) return;
  const events: (keyof WindowEventMap)[] = ['pointerdown', 'keydown', 'touchstart'];
  const handler = (): void => {
    audio.unlock();
    if (audio.state === 'running') removeGestureUnlock();
  };
  for (const event of events) window.addEventListener(event, handler, { passive: true });
  removeGesture = () => {
    for (const event of events) window.removeEventListener(event, handler);
    removeGesture = null;
  };
}

function removeGestureUnlock(): void {
  removeGesture?.();
}

installGestureUnlock();
