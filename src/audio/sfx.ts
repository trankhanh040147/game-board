/**
 * BLADE & MOUNT — designed SFX synthesis.
 *
 * Every sound the game can request is built here from oscillators, filtered
 * noise and FM/KS primitives — no samples. Recipes are grouped by "physical
 * event" (air, impact, metal, wood, voice, ceremony, UI) and layered so each
 * one has a transient, a body and a tail; that layering is what separates a
 * weighty game hit from a beep.
 *
 * `RECIPES` is a `Record<SfxName, ...>`, so the compiler (and tests) enforce
 * that every name in src/core/types.ts has a real recipe.
 */

import type { SfxName } from '../core/types';
import { clamp, expEnvelope, makePluckBuffer, rand, swellEnvelope } from './dsp';

/* ------------------------------------------------------------------ */
/* Kit                                                                 */
/* ------------------------------------------------------------------ */

export interface NoiseBank {
  white: AudioBuffer;
  pink: AudioBuffer;
  brown: AudioBuffer;
}

interface LayerOptions {
  /** Offset from the event start, seconds. */
  at?: number;
  /** Stereo position of this layer, −1 left … +1 right. */
  pan?: number;
}

interface NoiseOptions extends LayerOptions {
  type?: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  peak?: number;
  attack?: number;
  /** Total layer length in seconds (attack + tail). */
  dur: number;
  color?: keyof NoiseBank;
  /** Playback-rate multiplier for extra variation. */
  speed?: number;
  /** Optional extra low-pass on the way out (keeps layers warm). */
  lp?: number;
}

interface ToneOptions extends LayerOptions {
  type?: OscillatorType;
  f0: number;
  f1?: number;
  peak?: number;
  attack?: number;
  dur: number;
  /** Low-pass cutoff in Hz. */
  lp?: number;
  q?: number;
  detune?: number;
  /** Vibrato depth in cents + rate in Hz. */
  vibrato?: { rate: number; cents: number };
}

interface FmOptions extends LayerOptions {
  f0: number;
  f1?: number;
  ratio?: number;
  index?: number;
  dur: number;
  peak?: number;
  attack?: number;
  type?: OscillatorType;
  lp?: number;
}

interface HornOptions extends LayerOptions {
  /** Vibrato depth in cents. */
  vibrato?: number;
  /** Brightness of the brass (low-pass cutoff multiplier). */
  bright?: number;
}

interface BellOptions extends LayerOptions {
  beat?: number;
  attack?: number;
}

/**
 * A tiny synth workspace bound to one voice. All node creation is local; the
 * engine owns the voice's gain/pan/reverb routing and disposal.
 */
export class SfxKit {
  readonly ctx: AudioContext;
  readonly out: AudioNode;
  readonly banks: NoiseBank;
  readonly start: number;
  readonly rate: number;

  constructor(opts: {
    ctx: AudioContext;
    out: AudioNode;
    noise: NoiseBank;
    /** Absolute context time of the event. */
    start?: number;
    /** Pitch/rate multiplier for this instance. */
    rate?: number;
  }) {
    this.ctx = opts.ctx;
    this.out = opts.out;
    this.banks = opts.noise;
    this.start = opts.start ?? opts.ctx.currentTime;
    this.rate = clamp(opts.rate ?? 1, 0.55, 1.9);
  }

  private when(at = 0): number {
    return this.start + Math.max(0, at);
  }

  private route(node: AudioNode, pan?: number): AudioNode {
    if (pan === undefined || Math.abs(pan) < 0.01) {
      node.connect(this.out);
      return this.out;
    }
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = clamp(pan, -1, 1);
    node.connect(panner);
    panner.connect(this.out);
    return panner;
  }

  /* ----------------------------- layers ---------------------------- */

  noise(o: NoiseOptions): void {
    const ctx = this.ctx;
    const t = this.when(o.at);
    const dur = Math.max(0.014, o.dur);
    const src = ctx.createBufferSource();
    src.buffer = this.banks[o.color ?? 'pink'];
    src.loop = true;
    src.playbackRate.value = clamp((o.speed ?? 1) * (0.94 + this.rate * 0.06), 0.4, 3);

    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'bandpass';
    const f0 = Math.max(24, o.f0 * this.rate);
    filter.frequency.setValueAtTime(f0, t);
    if (o.f1 !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(24, o.f1 * this.rate), t + dur * 0.82);
    }
    filter.Q.setValueAtTime(o.q ?? 1, t);

    let head: AudioNode = filter;
    src.connect(filter);

    if (o.lp !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(Math.max(60, o.lp), t);
      lp.Q.setValueAtTime(0.6, t);
      filter.connect(lp);
      head = lp;
    }

    const env = ctx.createGain();
    const attack = Math.max(0.0015, o.attack ?? 0.004);
    expEnvelope(env.gain, t, o.peak ?? 0.2, attack, Math.max(0.01, dur - attack));
    head.connect(env);
    this.route(env, o.pan);

    // Random offset into the bed so repeated hits never sound identical.
    const maxOffset = Math.max(0, (src.buffer?.duration ?? 2) - dur - 0.05);
    src.start(t, Math.random() * maxOffset);
    src.stop(t + dur + 0.06);
  }

  tone(o: ToneOptions): void {
    const ctx = this.ctx;
    const t = this.when(o.at);
    const dur = Math.max(0.02, o.dur);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    const f0 = Math.max(18, o.f0 * this.rate);
    osc.frequency.setValueAtTime(f0, t);
    if (o.f1 !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(14, o.f1 * this.rate), t + dur * 0.9);
    }
    if (o.detune) osc.detune.setValueAtTime(o.detune, t);

    let head: AudioNode = osc;
    if (o.lp !== undefined) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(Math.max(60, o.lp), t);
      filter.Q.setValueAtTime(o.q ?? 0.7, t);
      osc.connect(filter);
      head = filter;
    }

    const env = ctx.createGain();
    const attack = Math.max(0.0015, o.attack ?? 0.004);
    expEnvelope(env.gain, t, o.peak ?? 0.12, attack, Math.max(0.012, dur - attack));
    head.connect(env);
    this.route(env, o.pan);

    if (o.vibrato) {
      const lfo = ctx.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = o.vibrato.rate;
      const depth = ctx.createGain();
      depth.gain.value = o.vibrato.cents;
      lfo.connect(depth);
      depth.connect(osc.detune);
      lfo.start(t);
      lfo.stop(t + dur + 0.05);
    }

    osc.start(t);
    osc.stop(t + dur + 0.06);
  }

  /** Two-operator FM — the backbone of every metallic clang/ping. */
  fm(o: FmOptions): void {
    const ctx = this.ctx;
    const t = this.when(o.at);
    const dur = Math.max(0.03, o.dur);
    const base = Math.max(24, o.f0 * this.rate);
    const carrier = ctx.createOscillator();
    carrier.type = o.type ?? 'sine';
    carrier.frequency.setValueAtTime(base, t);
    if (o.f1 !== undefined) {
      carrier.frequency.exponentialRampToValueAtTime(Math.max(18, o.f1 * this.rate), t + dur * 0.85);
    }

    const mod = ctx.createOscillator();
    mod.type = 'sine';
    mod.frequency.setValueAtTime(base * (o.ratio ?? 1.41), t);
    const modDepth = ctx.createGain();
    const index = o.index ?? 2.2;
    modDepth.gain.setValueAtTime(base * index, t);
    modDepth.gain.exponentialRampToValueAtTime(base * index * 0.045, t + dur * 0.9);
    mod.connect(modDepth);
    modDepth.connect(carrier.frequency);

    let head: AudioNode = carrier;
    if (o.lp !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = Math.max(200, o.lp);
      carrier.connect(lp);
      head = lp;
    }
    const env = ctx.createGain();
    const attack = Math.max(0.0012, o.attack ?? 0.002);
    expEnvelope(env.gain, t, o.peak ?? 0.1, attack, Math.max(0.02, dur - attack));
    head.connect(env);
    this.route(env, o.pan);

    mod.start(t);
    mod.stop(t + dur + 0.06);
    carrier.start(t);
    carrier.stop(t + dur + 0.06);
  }

  /** Inharmonic bell/gong partials with slow beating between close pairs. */
  bell(freqs: number[], dur: number, peak = 0.08, o: BellOptions = {}): void {
    const at = o.at ?? 0;
    const beat = o.beat ?? 0.31;
    freqs.forEach((freq, i) => {
      const f = freq * this.rate;
      const partialDur = dur * (1 - i * 0.055);
      const partialPeak = (peak / Math.pow(1 + i * 0.55, 0.8)) * rand(0.82, 1.12);
      const pan = o.pan === undefined ? undefined : clamp(o.pan + rand(-0.12, 0.12), -1, 1);
      this.tone({
        at,
        type: 'sine',
        f0: f,
        f1: f * 0.9975,
        peak: partialPeak,
        attack: o.attack ?? 0.004,
        dur: partialDur,
        detune: -beat,
        pan,
      });
      this.tone({
        at: at + 0.006,
        type: 'sine',
        f0: f * 1.0016,
        peak: partialPeak * 0.55,
        attack: (o.attack ?? 0.004) + 0.006,
        dur: partialDur * 0.86,
        detune: beat,
        pan,
      });
    });
  }

  /** Layered brass voice with vibrato and a breath transient. */
  horn(freq: number, dur: number, peak = 0.05, o: HornOptions = {}): void {
    const ctx = this.ctx;
    const t = this.when(o.at);
    const f = freq * this.rate;
    const bright = o.bright ?? 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.max(220, f * 2.4 * bright), t);
    filter.frequency.linearRampToValueAtTime(
      Math.max(260, f * 4.2 * bright),
      t + Math.min(0.18, dur * 0.3),
    );
    filter.Q.setValueAtTime(1.1, t);

    const env = ctx.createGain();
    const attack = clamp(dur * 0.16, 0.03, 0.24);
    swellEnvelope(env.gain, t, peak, attack, Math.max(0.05, dur - attack));
    filter.connect(env);
    this.route(env, o.pan);

    const vibrato = ctx.createOscillator();
    vibrato.type = 'sine';
    vibrato.frequency.value = 5.1 + rand(-0.4, 0.4);
    const vibDepth = ctx.createGain();
    vibDepth.gain.value = o.vibrato ?? 4.5;

    const voices: [OscillatorType, number, number][] = [
      ['sawtooth', 1, 1],
      ['sawtooth', 1.0035, 0.72],
      ['square', 0.5, 0.3],
      ['triangle', 2, 0.16],
    ];
    for (const [type, mult, mul] of voices) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(f * mult * 0.994, t);
      osc.frequency.exponentialRampToValueAtTime(f * mult, t + Math.min(0.12, dur * 0.25));
      osc.detune.value = rand(-3, 3);
      vibrato.connect(vibDepth);
      vibDepth.connect(osc.detune);
      osc.connect(filter);
      osc.start(t);
      osc.stop(t + dur + 0.08);
    }
    vibrato.start(t);
    vibrato.stop(t + dur + 0.08);

    // Breath/rasp on the front of the note.
    this.noise({
      at: 0,
      type: 'bandpass',
      f0: f * 2.2,
      f1: f * 1.4,
      q: 0.9,
      peak: peak * 0.24,
      attack: 0.02,
      dur: Math.min(0.24, dur * 0.35),
    });
  }

  /** A shouted vowel — the human ingredient in crowd cheers and ambience. */
  crowdVoice(
    pan: number,
    options: { at?: number; base?: number; dur?: number; peak?: number } = {},
  ): void {
    const ctx = this.ctx;
    const t = this.when(options.at ?? 0);
    const base = (options.base ?? rand(150, 280)) * this.rate;
    const dur = options.dur ?? rand(0.35, 0.75);
    const peak = options.peak ?? rand(0.05, 0.11);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(base * 1.1, t);
    // "Hey!" / "Whoo!" contour: quick rise then fall.
    osc.frequency.linearRampToValueAtTime(base * rand(1.25, 1.6), t + Math.min(0.13, dur * 0.4));
    osc.frequency.exponentialRampToValueAtTime(base * rand(0.8, 1.0), t + dur);
    osc.detune.value = rand(-14, 14);

    // Two vowel formants; the second adds the "aa/oh" colour.
    const f1 = ctx.createBiquadFilter();
    f1.type = 'bandpass';
    f1.frequency.value = rand(520, 760);
    f1.Q.value = 3.2;
    const f2 = ctx.createBiquadFilter();
    f2.type = 'bandpass';
    f2.frequency.value = rand(1080, 1480);
    f2.Q.value = 4.5;
    const mix = ctx.createGain();
    mix.gain.value = 1;
    osc.connect(f1);
    osc.connect(f2);
    f1.connect(mix);
    const f2gain = ctx.createGain();
    f2gain.gain.value = 0.55;
    f2.connect(f2gain);
    f2gain.connect(mix);

    const env = ctx.createGain();
    swellEnvelope(env.gain, t, peak, Math.min(0.09, dur * 0.35), Math.max(0.05, dur * 0.65));
    mix.connect(env);
    this.route(env, clamp(pan, -1, 1));
    osc.start(t);
    osc.stop(t + dur + 0.06);
  }

  /** Short hand clap (three micro-bursts reads as many hands). */
  clap(pan: number, at = 0, peak = 0.05): void {
    for (let i = 0; i < 3; i++) {
      this.noise({
        at: at + i * rand(0.008, 0.02),
        type: 'highpass',
        f0: rand(1400, 2400),
        q: 0.7,
        peak: peak * (1 - i * 0.22),
        attack: 0.0012,
        dur: rand(0.035, 0.06),
        color: 'white',
        pan: clamp(pan + rand(-0.15, 0.15), -1, 1),
      });
    }
  }

  /** Thin cymbal-like air for stings and cheers. */
  shimmer(at: number, dur: number, peak: number): void {
    this.noise({
      at,
      type: 'highpass',
      f0: 3600,
      f1: 6200,
      q: 0.5,
      peak,
      attack: Math.min(0.5, dur * 0.35),
      dur,
      color: 'white',
    });
    this.noise({
      at: at + 0.01,
      type: 'bandpass',
      f0: 7200,
      f1: 9000,
      q: 0.8,
      peak: peak * 0.35,
      attack: 0.02,
      dur: dur * 0.7,
      color: 'white',
    });
  }
}

/* ------------------------------------------------------------------ */
/* Recipes                                                             */
/* ------------------------------------------------------------------ */

export type SfxRecipe = (k: SfxKit) => number;

/** Every recipe returns its audible tail length in seconds. */
export const RECIPES: Record<SfxName, SfxRecipe> = {
  /* ------------------------------ air ----------------------------- */
  swing: (k) => {
    // Two crossed band-passes make the classic "shh-WHOOSH": air accelerating
    // past the blade then trailing off.
    k.noise({ type: 'bandpass', f0: 430, f1: 1750, q: 1.5, peak: 0.36, attack: 0.055, dur: 0.16 });
    k.noise({ at: 0.045, type: 'bandpass', f0: 1900, f1: 380, q: 1.15, peak: 0.3, attack: 0.012, dur: 0.14 });
    k.tone({ type: 'sine', f0: 720, f1: 300, peak: 0.028, attack: 0.02, dur: 0.14 });
    k.noise({ type: 'lowpass', f0: 260, f1: 150, q: 0.7, peak: 0.08, attack: 0.05, dur: 0.12 });
    return 0.27;
  },

  'swing-heavy': (k) => {
    k.noise({ type: 'bandpass', f0: 150, f1: 720, q: 1.1, peak: 0.5, attack: 0.09, dur: 0.24 });
    k.noise({ at: 0.1, type: 'bandpass', f0: 900, f1: 190, q: 0.9, peak: 0.36, attack: 0.02, dur: 0.2 });
    k.tone({ type: 'sine', f0: 105, f1: 52, peak: 0.24, attack: 0.05, dur: 0.26 });
    k.noise({ type: 'lowpass', f0: 420, f1: 140, q: 0.8, peak: 0.2, attack: 0.08, dur: 0.22 });
    k.tone({ type: 'sawtooth', f0: 180, f1: 74, peak: 0.05, attack: 0.04, dur: 0.28, lp: 460 });
    return 0.4;
  },

  dodge: (k) => {
    k.noise({ type: 'bandpass', f0: 1650, f1: 420, q: 1.25, peak: 0.22, attack: 0.035, dur: 0.28 });
    k.noise({ type: 'lowpass', f0: 520, f1: 160, q: 0.7, peak: 0.1, attack: 0.05, dur: 0.22 });
    k.tone({ type: 'triangle', f0: 300, f1: 170, peak: 0.03, attack: 0.02, dur: 0.16 });
    return 0.34;
  },

  spawn: (k) => {
    k.noise({ type: 'bandpass', f0: 180, f1: 1500, q: 1.0, peak: 0.12, attack: 0.22, dur: 0.38 });
    k.tone({ type: 'sine', f0: 380, f1: 560, peak: 0.03, attack: 0.2, dur: 0.34 });
    k.fm({ f0: 1900, ratio: 2.1, index: 1.4, dur: 0.5, peak: 0.02, attack: 0.2 });
    k.noise({ type: 'lowpass', f0: 260, f1: 90, q: 0.7, peak: 0.14, attack: 0.02, dur: 0.22 });
    return 0.55;
  },

  /* ---------------------------- impacts --------------------------- */
  'hit-flesh': (k) => {
    k.tone({ type: 'sine', f0: 168, f1: 42, peak: 0.62, attack: 0.0016, dur: 0.16 });
    k.tone({ type: 'triangle', f0: 104, f1: 58, peak: 0.26, attack: 0.002, dur: 0.18 });
    k.noise({ type: 'bandpass', f0: 900, f1: 260, q: 1.5, peak: 0.34, attack: 0.0018, dur: 0.12, color: 'white' });
    k.noise({ type: 'lowpass', f0: 520, f1: 150, q: 0.8, peak: 0.3, attack: 0.006, dur: 0.17 });
    k.noise({ type: 'highpass', f0: 3200, q: 0.8, peak: 0.14, attack: 0.0012, dur: 0.025, color: 'white' });
    return 0.24;
  },

  'hit-armor': (k) => {
    k.fm({ f0: 540, ratio: 1.42, index: 3.2, dur: 0.34, peak: 0.17, attack: 0.0016, lp: 6000 });
    k.noise({ type: 'highpass', f0: 2800, f1: 2000, q: 0.7, peak: 0.26, attack: 0.0012, dur: 0.035, color: 'white' });
    k.tone({ type: 'sine', f0: 132, f1: 52, peak: 0.3, attack: 0.002, dur: 0.13 });
    for (const [freq, peak] of [[820, 0.06], [1290, 0.05], [1960, 0.035], [2960, 0.02]]) {
      k.tone({ type: 'triangle', f0: freq, f1: freq * 0.985, peak, attack: 0.003, dur: 0.36, detune: rand(-9, 9) });
    }
    k.noise({ type: 'bandpass', f0: 1400, f1: 900, q: 1.4, peak: 0.09, attack: 0.004, dur: 0.12 });
    return 0.5;
  },

  'hit-shield': (k) => {
    k.tone({ type: 'triangle', f0: 192, f1: 86, peak: 0.52, attack: 0.0018, dur: 0.19 });
    k.noise({ type: 'bandpass', f0: 640, f1: 300, q: 1.1, peak: 0.3, attack: 0.002, dur: 0.15 });
    k.tone({ type: 'sine', f0: 118, f1: 62, peak: 0.18, attack: 0.003, dur: 0.14 });
    // Loose boss/rivets rattling on the board.
    for (let i = 0; i < 4; i++) {
      k.noise({
        at: 0.012 + i * rand(0.012, 0.03),
        type: 'highpass',
        f0: rand(1700, 2600),
        q: 1.2,
        peak: 0.05,
        attack: 0.0012,
        dur: rand(0.02, 0.045),
        color: 'white',
        pan: rand(-0.25, 0.25),
      });
    }
    k.tone({ type: 'triangle', f0: 1480, f1: 1400, peak: 0.03, attack: 0.002, dur: 0.12 });
    return 0.32;
  },

  'block-weapon': (k) => {
    // Bright blade-on-blade ring with a high FM bite and a short body.
    k.fm({ f0: 1470, ratio: 1.57, index: 3.6, dur: 0.55, peak: 0.13, attack: 0.0014, lp: 9000 });
    k.noise({ type: 'highpass', f0: 2900, f1: 2400, q: 0.6, peak: 0.32, attack: 0.001, dur: 0.03, color: 'white' });
    for (const [freq, peak, dur] of [
      [2205, 0.05, 0.6],
      [2950, 0.04, 0.5],
      [4090, 0.028, 0.42],
      [5480, 0.014, 0.3],
    ]) {
      k.tone({ type: 'triangle', f0: freq, f1: freq * 0.992, peak, attack: 0.002, dur, detune: rand(-11, 11) });
    }
    k.tone({ type: 'sine', f0: 232, f1: 108, peak: 0.18, attack: 0.002, dur: 0.14 });
    k.noise({ type: 'bandpass', f0: 1100, f1: 600, q: 1.2, peak: 0.1, attack: 0.003, dur: 0.1 });
    return 0.85;
  },

  'guard-break': (k) => {
    k.noise({ type: 'highpass', f0: 3200, q: 0.7, peak: 0.5, attack: 0.001, dur: 0.022, color: 'white' });
    k.fm({ f0: 905, ratio: 1.71, index: 4.2, dur: 0.42, peak: 0.11, attack: 0.0016, lp: 7000 });
    k.tone({ type: 'sine', f0: 96, f1: 38, peak: 0.42, attack: 0.002, dur: 0.32 });
    k.tone({ type: 'sawtooth', f0: 262, f1: 76, peak: 0.12, attack: 0.004, dur: 0.3, lp: 520 });
    k.noise({ type: 'lowpass', f0: 1400, f1: 180, q: 0.8, peak: 0.28, attack: 0.003, dur: 0.28 });
    k.noise({ type: 'bandpass', f0: 2600, f1: 1300, q: 1.1, peak: 0.1, attack: 0.01, dur: 0.2 });
    return 0.6;
  },

  kick: (k) => {
    k.tone({ type: 'sine', f0: 140, f1: 37, peak: 0.6, attack: 0.0018, dur: 0.19 });
    k.noise({ type: 'bandpass', f0: 900, f1: 260, q: 1.0, peak: 0.28, attack: 0.002, dur: 0.1, color: 'white' });
    k.noise({ type: 'lowpass', f0: 380, f1: 160, q: 0.7, peak: 0.14, attack: 0.01, dur: 0.16 });
    k.tone({ type: 'triangle', f0: 88, f1: 52, peak: 0.16, attack: 0.004, dur: 0.16 });
    return 0.3;
  },

  death: (k) => {
    // A short pained groan (two formant-ish saws) then the body hits the sand.
    k.tone({ type: 'sawtooth', f0: 196, f1: 92, peak: 0.1, attack: 0.012, dur: 0.6, lp: 620 });
    k.tone({ type: 'sawtooth', f0: 148, f1: 74, peak: 0.07, attack: 0.02, dur: 0.66, lp: 480, detune: -12 });
    k.noise({ type: 'bandpass', f0: 520, f1: 240, q: 3, peak: 0.1, attack: 0.03, dur: 0.55 });
    k.noise({ type: 'bandpass', f0: 1150, f1: 700, q: 4, peak: 0.05, attack: 0.05, dur: 0.45 });
    // Collapse: cloth + armour + ground thud.
    k.noise({ type: 'lowpass', f0: 900, f1: 140, q: 0.7, peak: 0.28, attack: 0.02, dur: 0.34 });
    k.tone({ type: 'sine', f0: 82, f1: 33, peak: 0.44, attack: 0.004, dur: 0.28 });
    for (let i = 0; i < 5; i++) {
      k.noise({
        at: 0.42 + i * rand(0.02, 0.055),
        type: 'highpass',
        f0: rand(1500, 2800),
        q: 1.3,
        peak: rand(0.02, 0.05),
        attack: 0.0014,
        dur: rand(0.02, 0.05),
        color: 'white',
        pan: rand(-0.3, 0.3),
      });
    }
    k.tone({ at: 0.88, type: 'sine', f0: 62, f1: 28, peak: 0.3, attack: 0.006, dur: 0.24 });
    return 1.25;
  },

  footstep: (k) => {
    // Sand: a gritty scuff + the smallest possible heel thump.
    k.noise({ type: 'bandpass', f0: 720, f1: 300, q: 0.95, peak: 0.13, attack: 0.002, dur: 0.065, pan: rand(-0.12, 0.12) });
    k.noise({ type: 'highpass', f0: 1800, q: 0.6, peak: 0.035, attack: 0.0014, dur: 0.04, color: 'white' });
    k.tone({ type: 'sine', f0: 108, f1: 74, peak: 0.045, attack: 0.002, dur: 0.075 });
    k.noise({ type: 'lowpass', f0: 300, f1: 120, q: 0.6, peak: 0.05, attack: 0.004, dur: 0.09 });
    return 0.12;
  },

  /* ---------------------------- ceremony -------------------------- */
  gong: (k) => {
    // Blacksmith-hammered bronze: inharmonic partials, slow beating, long tail.
    k.noise({ type: 'lowpass', f0: 900, f1: 180, q: 0.7, peak: 0.35, attack: 0.002, dur: 0.22, color: 'white' });
    k.tone({ type: 'sine', f0: 74, f1: 40, peak: 0.34, attack: 0.003, dur: 0.5 });
    k.bell([82.4, 109.6, 138.7, 176.9, 233.1, 296.7, 391.8, 512.3, 701.4], 5.8, 0.085, { beat: 0.34 });
    // Blooming high shimmer that arrives after the strike.
    k.noise({ at: 0.05, type: 'bandpass', f0: 2400, f1: 3100, q: 0.9, peak: 0.03, attack: 0.6, dur: 3.4 });
    return 6.1;
  },

  horn: (k) => {
    // War-horn call: low, breathy, three-note fanfare with a long final note.
    k.noise({ type: 'bandpass', f0: 620, f1: 380, q: 0.9, peak: 0.06, attack: 0.06, dur: 0.5 });
    k.horn(110, 0.62, 0.055, { vibrato: 3.5, bright: 0.9 });
    k.horn(146.83, 0.56, 0.05, { at: 0.68, vibrato: 4.2, bright: 1 });
    k.horn(164.81, 1.35, 0.06, { at: 1.22, vibrato: 5, bright: 1.1 });
    k.tone({ type: 'triangle', f0: 55, peak: 0.05, attack: 0.1, dur: 1.4 });
    return 2.75;
  },

  'round-start': (k) => {
    k.horn(146.83, 0.7, 0.05, { vibrato: 4.5 });
    k.horn(196, 1.0, 0.045, { at: 0.5, vibrato: 5 });
    // Drum roll into the clash.
    for (let i = 0; i < 7; i++) {
      k.tone({
        at: 0.05 + i * 0.085,
        type: 'sine',
        f0: 150 - i * 4,
        f1: 74,
        peak: 0.06 + i * 0.008,
        attack: 0.003,
        dur: 0.16,
      });
      k.noise({
        at: 0.05 + i * 0.085,
        type: 'bandpass',
        f0: 1500,
        q: 0.9,
        peak: 0.02,
        attack: 0.002,
        dur: 0.05,
        color: 'white',
      });
    }
    k.noise({ type: 'bandpass', f0: 520, f1: 900, q: 0.6, peak: 0.11, attack: 0.3, dur: 1.3 });
    return 2.1;
  },

  /* ----------------------------- crowd ---------------------------- */
  'crowd-cheer': (k) => {
    // Bed: body roar + upper air, then a scatter of individual voices/claps.
    k.noise({ type: 'lowpass', f0: 520, f1: 700, q: 0.5, peak: 0.32, attack: 0.36, dur: 2.1 });
    k.noise({ type: 'bandpass', f0: 620, f1: 820, q: 0.55, peak: 0.28, attack: 0.3, dur: 2.0 });
    k.noise({ type: 'bandpass', f0: 1500, f1: 1750, q: 0.9, peak: 0.15, attack: 0.24, dur: 1.8 });
    k.noise({ type: 'highpass', f0: 3000, q: 0.6, peak: 0.06, attack: 0.2, dur: 1.6, color: 'white' });

    for (let i = 0; i < 9; i++) {
      k.crowdVoice(rand(-0.9, 0.9), {
        at: rand(0, 0.9),
        base: rand(150, 300),
        dur: rand(0.3, 0.7),
        peak: rand(0.04, 0.09),
      });
    }
    for (let i = 0; i < 7; i++) {
      k.clap(rand(-0.9, 0.9), rand(0.05, 1.1), rand(0.02, 0.045));
    }
    return 2.55;
  },

  /* ------------------------------- UI ----------------------------- */
  'ui-click': (k) => {
    k.tone({ type: 'triangle', f0: 1080, f1: 880, peak: 0.095, attack: 0.0014, dur: 0.05 });
    k.noise({ type: 'highpass', f0: 2600, q: 0.7, peak: 0.055, attack: 0.001, dur: 0.02, color: 'white' });
    k.tone({ type: 'sine', f0: 196, f1: 150, peak: 0.035, attack: 0.001, dur: 0.045 });
    return 0.07;
  },

  'ui-hover': (k) => {
    k.tone({ type: 'triangle', f0: 1520, f1: 1340, peak: 0.03, attack: 0.0016, dur: 0.045 });
    k.noise({ type: 'highpass', f0: 4200, q: 0.8, peak: 0.012, attack: 0.001, dur: 0.02, color: 'white' });
    return 0.055;
  },

  bet: (k) => {
    // A handful of coins into a purse.
    for (let i = 0; i < 3; i++) {
      k.fm({ at: i * rand(0.025, 0.05), f0: rand(2300, 4000), ratio: rand(1.8, 2.6), index: 1.2, dur: 0.22, peak: 0.035, lp: 9000 });
    }
    k.noise({ type: 'bandpass', f0: 1600, f1: 900, q: 1.1, peak: 0.05, attack: 0.002, dur: 0.09 });
    k.tone({ type: 'sine', f0: 300, f1: 260, peak: 0.03, attack: 0.002, dur: 0.09 });
    return 0.32;
  },

  'bet-win': (k) => {
    // Cascading coin shower, resolving on a bright ring.
    for (let i = 0; i < 7; i++) {
      k.fm({ at: i * 0.055, f0: 2100 + i * 340 + rand(-120, 120), ratio: rand(1.9, 2.7), index: 1.4, dur: 0.24, peak: 0.035, lp: 10000 });
    }
    k.tone({ at: 0.32, type: 'sine', f0: 4400, f1: 4380, peak: 0.03, attack: 0.002, dur: 0.4 });
    k.shimmer(0.16, 0.4, 0.02);
    return 0.72;
  },

  'bet-lose': (k) => {
    // Purse dropped on a board: dull knock, two coins settling flat.
    k.tone({ type: 'triangle', f0: 260, f1: 150, peak: 0.1, attack: 0.0016, dur: 0.1 });
    k.noise({ type: 'lowpass', f0: 700, f1: 240, q: 0.7, peak: 0.1, attack: 0.002, dur: 0.12 });
    k.fm({ at: 0.05, f0: 980, ratio: 2.2, index: 0.9, dur: 0.12, peak: 0.028 });
    k.fm({ at: 0.13, f0: 740, ratio: 2.4, index: 0.8, dur: 0.12, peak: 0.022 });
    k.noise({ at: 0.16, type: 'bandpass', f0: 700, f1: 380, q: 1.2, peak: 0.04, attack: 0.02, dur: 0.2 });
    return 0.42;
  },

  /* ----------------------------- stings --------------------------- */
  victory: (k) => {
    // Bright D-major brass fanfare with a drum accent and cymbal air.
    const melody: [number, number, number][] = [
      [293.66, 0, 0.5],
      [369.99, 0.17, 0.5],
      [440, 0.34, 0.55],
      [587.33, 0.62, 1.6],
    ];
    for (const [freq, at, dur] of melody) k.horn(freq, dur, 0.055, { at, vibrato: 4, bright: 1.25 });
    k.horn(73.42, 2.3, 0.045, { at: 0, vibrato: 2, bright: 0.8 });
    k.tone({ type: 'sine', f0: 72, f1: 44, peak: 0.3, attack: 0.003, dur: 0.3 });
    k.tone({ at: 0.62, type: 'sine', f0: 84, f1: 48, peak: 0.24, attack: 0.003, dur: 0.3 });
    k.shimmer(0.62, 1.5, 0.05);
    k.noise({ at: 0.61, type: 'bandpass', f0: 2400, f1: 3600, q: 1, peak: 0.08, attack: 0.01, dur: 0.3, color: 'white' });
    return 2.9;
  },

  defeat: (k) => {
    // Slow descending minor horn, low drum, a distant bell toll.
    const notes: [number, number, number][] = [
      [220, 0, 0.65],
      [196, 0.42, 0.7],
      [174.61, 0.86, 0.8],
      [146.83, 1.32, 1.5],
    ];
    for (const [freq, at, dur] of notes) k.horn(freq, dur, 0.042, { at, vibrato: 3, bright: 0.72 });
    k.tone({ type: 'sine', f0: 64, f1: 36, peak: 0.26, attack: 0.01, dur: 0.8 });
    k.tone({ at: 1.3, type: 'sine', f0: 58, f1: 32, peak: 0.2, attack: 0.01, dur: 0.6 });
    k.bell([174.61, 261.63], 2.4, 0.02, { at: 0.1, beat: 0.5 });
    k.noise({ type: 'lowpass', f0: 400, f1: 120, q: 0.6, peak: 0.1, attack: 0.4, dur: 1.8 });
    return 3.2;
  },
};

/** Every SFX name with a real recipe (compile-time checked against SfxName). */
export const SFX_NAMES = Object.keys(RECIPES) as SfxName[];

/** Render one SFX into a prepared voice; returns the audible tail length. */
export function playRecipe(name: SfxName, kit: SfxKit): number {
  const recipe = RECIPES[name];
  if (!recipe) return 0.2;
  return recipe(kit);
}

/* ------------------------------------------------------------------ */
/* Ambience helpers (engine-owned, not part of the public SFX list)    */
/* ------------------------------------------------------------------ */

/** A lone distant shout used to keep the stands alive between cheers. */
export function ambientShout(kit: SfxKit, pan: number, volume: number): number {
  const voices = 1 + (Math.random() < 0.4 ? 1 : 0);
  for (let i = 0; i < voices; i++) {
    kit.crowdVoice(pan + rand(-0.25, 0.25), {
      at: i * rand(0.02, 0.12),
      base: rand(160, 320),
      dur: rand(0.3, 0.65),
      peak: (0.05 + Math.random() * 0.05) * volume,
    });
  }
  if (Math.random() < 0.35) kit.clap(pan + rand(-0.2, 0.2), rand(0.02, 0.14), 0.02 * volume);
  return 0.8;
}

/** Low crowd roar swell used when the arena reacts to a kill. */
export function ambientRoar(kit: SfxKit, pan: number, volume: number): number {
  kit.noise({
    type: 'bandpass',
    f0: rand(420, 560),
    f1: rand(720, 980),
    q: 0.5,
    peak: 0.2 * volume,
    attack: 0.5,
    dur: 2.2,
    pan,
  });
  kit.noise({
    type: 'lowpass',
    f0: 340,
    f1: 500,
    q: 0.6,
    peak: 0.18 * volume,
    attack: 0.7,
    dur: 2.4,
    pan: pan * 0.5,
  });
  return 2.5;
}

/** Small convenience for QA: render a KS pluck buffer without a music player. */
export function pluckForTest(freq: number, ctx: BaseAudioContext): AudioBuffer {
  return makePluckBuffer(ctx, freq, { brightness: 0.6, seconds: 0.8 });
}
