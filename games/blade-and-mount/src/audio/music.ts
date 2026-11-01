/**
 * BLADE & MOUNT — adaptive procedural music.
 *
 * A tiny lookahead sequencer renders medieval-ish motifs on the WebAudio
 * clock: Karplus–Strong plucked strings (lute/gittern), detuned drone pads,
 * frame drums and the occasional muted horn swell. Each track is a 16-beat
 * loop; transitions crossfade. Everything is synthesised at runtime — no
 * samples, no files.
 *
 * The player deliberately sits ~20 dB under the SFX bus: it is a bed, not a
 * concert. Per-track internal gains are small because the music bus already
 * applies the user's music volume.
 */

import type { MusicTrack } from '../core/types';
import { makePluckBuffer } from './dsp';
import type { NoiseBank } from './sfx';

export interface MusicHost {
  ctx: AudioContext;
  /** Music bus (already volume-controlled by the engine). */
  bus: AudioNode;
  /** Shared reverb send input, if available. */
  send: AudioNode | null;
  noise: NoiseBank;
}

interface ActiveTrack {
  track: MusicTrack;
  gain: GainNode;
  beat: number;
  nextTime: number;
}

interface TrackDef {
  bpm: number;
  /** Loop length in beats. */
  loop: number;
  step: (c: BeatComposer) => void;
}

/* ------------------------------------------------------------------ */
/* Beat composer — the palette each track writes with                  */
/* ------------------------------------------------------------------ */

export class BeatComposer {
  private readonly ctx: AudioContext;
  private readonly out: AudioNode;
  private readonly send: AudioNode | null;
  private readonly noise: NoiseBank;
  private readonly cache: Map<number, AudioBuffer>;
  readonly when: number;
  readonly beat: number;
  readonly beatDur: number;
  readonly loop: number;

  constructor(opts: {
    ctx: AudioContext;
    out: AudioNode;
    send: AudioNode | null;
    noise: NoiseBank;
    cache: Map<number, AudioBuffer>;
    when: number;
    beat: number;
    beatDur: number;
    loop: number;
  }) {
    this.ctx = opts.ctx;
    this.out = opts.out;
    this.send = opts.send;
    this.noise = opts.noise;
    this.cache = opts.cache;
    this.when = opts.when;
    this.beat = opts.beat;
    this.beatDur = opts.beatDur;
    this.loop = opts.loop;
  }

  private at(offsetBeats = 0): number {
    return this.when + offsetBeats * this.beatDur;
  }

  private bus(node: AudioNode, pan = 0, sendAmount = 0): void {
    let head = node;
    if (Math.abs(pan) > 0.01) {
      const panner = this.ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
      node.connect(panner);
      head = panner;
    }
    head.connect(this.out);
    if (this.send && sendAmount > 0) {
      const send = this.ctx.createGain();
      send.gain.value = sendAmount;
      head.connect(send);
      send.connect(this.send);
    }
  }

  /** Plain oscillator voice with optional filter and vibrato. */
  tone(
    freq: number,
    opts: {
      type?: OscillatorType;
      at?: number;
      gain?: number;
      dur: number;
      attack?: number;
      filter?: number;
      detune?: number;
      pan?: number;
      send?: number;
    },
  ): void {
    const ctx = this.ctx;
    const when = this.at(opts.at);
    const dur = Math.max(0.05, opts.dur);
    const osc = ctx.createOscillator();
    osc.type = opts.type ?? 'triangle';
    osc.frequency.setValueAtTime(Math.max(20, freq), when);
    osc.detune.value = opts.detune ?? 0;
    let head: AudioNode = osc;
    if (opts.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(opts.filter, when);
      filter.Q.setValueAtTime(0.6, when);
      osc.connect(filter);
      head = filter;
    }
    const env = ctx.createGain();
    const attack = Math.max(0.004, opts.attack ?? Math.min(0.3, dur * 0.25));
    const peak = Math.max(0.0004, opts.gain ?? 0.02);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    head.connect(env);
    this.bus(env, opts.pan, opts.send ?? 0.2);
    osc.start(when);
    osc.stop(when + dur + 0.06);
  }

  /** Karplus–Strong pluck — the "lute" of the score. */
  pluck(
    freq: number,
    opts: {
      at?: number;
      gain?: number;
      dur?: number;
      filter?: number;
      pan?: number;
      brightness?: number;
      rate?: number;
      send?: number;
    } = {},
  ): void {
    const ctx = this.ctx;
    const when = this.at(opts.at);
    const dur = Math.max(0.1, opts.dur ?? 1.1);
    const key = Math.round(freq * 10) / 10;
    let buffer = this.cache.get(key);
    if (!buffer) {
      buffer = makePluckBuffer(ctx, freq, {
        brightness: opts.brightness ?? 0.58,
        seconds: 2,
      });
      this.cache.set(key, buffer);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = opts.rate ?? 1;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(Math.max(300, opts.filter ?? 2600), when);
    filter.Q.setValueAtTime(0.55, when);
    src.connect(filter);

    const env = ctx.createGain();
    const peak = Math.max(0.0004, opts.gain ?? 0.035);
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.004);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    filter.connect(env);
    this.bus(env, opts.pan, opts.send ?? 0.22);
    src.start(when);
    src.stop(when + dur + 0.05);
  }

  /** Detuned drone/choir pad; `beats` is the sustain length. */
  pad(freqs: number[], beats: number, gain = 0.02, opts: { at?: number; pan?: number } = {}): void {
    const ctx = this.ctx;
    const dur = Math.max(0.3, beats * this.beatDur);
    const when = this.at(opts.at);
    const attack = Math.min(1.6, dur * 0.4);
    freqs.forEach((freq, index) => {
      for (const [type, mult, mul, detune] of [
        ['sawtooth', 1, 0.62, -5],
        ['triangle', 1.0015, 1, 4],
        ['sine', 0.5, 0.5, 0],
      ] as [OscillatorType, number, number, number][]) {
        const osc = ctx.createOscillator();
        osc.type = type;
        osc.frequency.value = freq * mult;
        osc.detune.value = detune + index * 1.5;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = Math.min(1400, 420 + freq * 3.2);
        filter.Q.value = 0.5;
        const env = ctx.createGain();
        const peak = gain * mul * (index === 0 ? 1 : 0.72);
        env.gain.setValueAtTime(0.0001, when);
        env.gain.linearRampToValueAtTime(peak, when + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
        osc.connect(filter);
        filter.connect(env);
        this.bus(env, opts.pan, 0.28);
        osc.start(when);
        osc.stop(when + dur + 0.08);
      }
    });
  }

  /** Frame drum / skin percussion. */
  drum(kind: 'kick' | 'tom' | 'snare' | 'shaker' | 'rim', gainMul = 1, at = 0): void {
    const ctx = this.ctx;
    const when = this.at(at);
    if (kind === 'shaker') {
      const src = ctx.createBufferSource();
      src.buffer = this.noise.white;
      src.loop = true;
      src.playbackRate.value = 1.5;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 5200;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(0.016 * gainMul, when + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
      src.connect(hp);
      hp.connect(env);
      this.bus(env, Math.random() * 0.2 - 0.1, 0.05);
      src.start(when, Math.random() * 1.2);
      src.stop(when + 0.08);
      return;
    }
    if (kind === 'rim') {
      this.tone(420, { at, gain: 0.02 * gainMul, dur: 0.05, type: 'triangle' });
      const src = ctx.createBufferSource();
      src.buffer = this.noise.pink;
      src.loop = true;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 2600;
      bp.Q.value = 1.4;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, when);
      env.gain.exponentialRampToValueAtTime(0.02 * gainMul, when + 0.002);
      env.gain.exponentialRampToValueAtTime(0.0001, when + 0.07);
      src.connect(bp);
      bp.connect(env);
      this.bus(env, 0.1, 0.1);
      src.start(when, Math.random());
      src.stop(when + 0.09);
      return;
    }
    // Membrane: pitched sine drop plus a skin noise transient.
    const start = kind === 'kick' ? 102 : kind === 'tom' ? 168 : 226;
    const end = kind === 'kick' ? 42 : kind === 'tom' ? 88 : 132;
    const dur = kind === 'kick' ? 0.3 : kind === 'tom' ? 0.24 : 0.13;
    const peak = (kind === 'kick' ? 0.09 : kind === 'tom' ? 0.06 : 0.045) * gainMul;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(start, when);
    osc.frequency.exponentialRampToValueAtTime(end, when + dur * 0.8);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, when);
    env.gain.exponentialRampToValueAtTime(peak, when + 0.005);
    env.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    osc.connect(env);
    this.bus(env, 0, 0.08);
    osc.start(when);
    osc.stop(when + dur + 0.05);

    const src = ctx.createBufferSource();
    src.buffer = this.noise.pink;
    src.loop = true;
    src.playbackRate.value = kind === 'snare' ? 1.3 : 0.9;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = kind === 'snare' ? 1900 : 700;
    bp.Q.value = 0.8;
    const noiseEnv = ctx.createGain();
    noiseEnv.gain.setValueAtTime(0.0001, when);
    noiseEnv.gain.exponentialRampToValueAtTime(peak * 0.55, when + 0.003);
    noiseEnv.gain.exponentialRampToValueAtTime(0.0001, when + dur * 0.7);
    src.connect(bp);
    bp.connect(noiseEnv);
    this.bus(noiseEnv, 0, 0.06);
    src.start(when, Math.random() * 1.5);
    src.stop(when + dur * 0.8);
  }

  /** Distant hand-bell / chime partials. */
  bell(freq: number, gain = 0.012, dur = 2.6, at = 0): void {
    for (const [mult, mul] of [
      [1, 1],
      [2.02, 0.4],
      [3.01, 0.16],
    ]) {
      this.tone(freq * mult, {
        at,
        type: 'sine',
        gain: gain * mul,
        dur: dur * (mul > 0.5 ? 1 : 0.6),
        attack: 0.012,
        send: 0.4,
      });
    }
  }

  /** Muted horn pad — a breath of brass under the plucks. */
  hornSwell(freq: number, beats: number, gain = 0.012, at = 0): void {
    const dur = Math.max(0.4, beats * this.beatDur);
    this.tone(freq, {
      at,
      type: 'sawtooth',
      gain,
      dur,
      attack: Math.min(1.4, dur * 0.45),
      filter: 620,
      send: 0.3,
    });
    this.tone(freq * 1.0035, {
      at,
      type: 'triangle',
      gain: gain * 0.7,
      dur,
      attack: Math.min(1.2, dur * 0.4),
      filter: 820,
      send: 0.3,
    });
  }

  /** Short low pulse used by the melee tension bed. */
  pulse(freq = 55, gain = 0.02, at = 0): void {
    this.tone(freq, {
      at,
      type: 'sawtooth',
      gain,
      dur: Math.min(0.22, this.beatDur * 0.5),
      attack: 0.008,
      filter: 300,
      send: 0.1,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Tracks                                                              */
/* ------------------------------------------------------------------ */

const MENU: TrackDef = {
  bpm: 56,
  loop: 16,
  step: (c) => {
    const b = c.beat;
    if (b === 0) {
      c.pad([73.42, 110.0, 146.83], 8, 0.021);
      c.pluck(146.83, { gain: 0.05, dur: 1.6 });
      c.drum('kick', 0.4);
    }
    if (b === 2) c.pluck(220.0, { gain: 0.036, dur: 1.2 });
    if (b === 4) {
      c.pluck(261.63, { gain: 0.04, dur: 1.3 });
      c.bell(293.66, 0.011, 2.2);
    }
    if (b === 7) c.pluck(196.0, { gain: 0.03, dur: 1.1 });
    if (b === 8) {
      c.pad([87.31, 130.81, 174.61], 8, 0.018);
      c.pluck(174.61, { gain: 0.04, dur: 1.4 });
      c.drum('tom', 0.45);
    }
    if (b === 10) c.pluck(233.08, { gain: 0.034, dur: 1.2 });
    if (b === 12) c.pluck(220.0, { gain: 0.03, dur: 1.1 });
    if (b === 14) c.bell(220.0, 0.01, 2.5);
    if (b === 15) c.pluck(110.0, { gain: 0.04, dur: 1.5 });
  },
};

const TOURNAMENT: TrackDef = {
  bpm: 82,
  loop: 16,
  step: (c) => {
    const b = c.beat;
    if (b === 0) {
      c.pad([73.42, 110.0, 146.83], 8, 0.019);
      c.hornSwell(146.83, 5, 0.009);
    }
    if (b === 8) {
      c.pad([87.31, 130.81, 174.61], 8, 0.017);
      c.hornSwell(174.61, 5, 0.008);
    }
    // Plucked ostinato on every beat, alternating chord tones.
    const arp = [220.0, 293.66, 220.0, 329.63, 174.61, 261.63, 174.61, 293.66];
    c.pluck(arp[b % arp.length], {
      gain: b % 4 === 0 ? 0.026 : 0.019,
      dur: 0.5,
      filter: 2300,
      pan: (b % 2 === 0 ? -1 : 1) * 0.12,
    });
    if (b % 4 === 0) c.drum('kick', 1);
    if (b === 4 || b === 12) c.drum('snare', 0.8);
    if (b === 6 || b === 14) c.drum('tom', 0.75);
    if (b % 2 === 1) c.drum('shaker', 0.8);
    if (b === 10) c.drum('rim', 0.7);
    // Passing dissonance that resolves on the loop point.
    if (b === 10) c.tone(155.56, { gain: 0.008, dur: 1.4, attack: 0.5, filter: 700 });
  },
};

const MELEE: TrackDef = {
  bpm: 112,
  loop: 16,
  step: (c) => {
    const b = c.beat;
    if (b === 0) c.pad([73.42, 110.0, 146.83], 8, 0.017);
    if (b === 8) c.pad([116.54, 174.61, 233.08], 8, 0.015);
    c.pulse(b % 4 === 0 ? 55 : 73.42, 0.016);

    const kickBeats = [0, 3, 6, 8, 11, 14];
    if (kickBeats.includes(b)) c.drum('kick', 1.05);
    if (b === 4 || b === 12) c.drum('snare', 0.95);
    if (b === 2 || b === 10) c.drum('tom', 0.85);
    if (b % 2 === 1) c.drum('shaker', 0.65);

    // Driving eighth-note ostinato.
    const figure = [146.83, 220.0, 174.61, 261.63, 196.0, 293.66, 174.61, 220.0];
    for (let i = 0; i < 2; i++) {
      c.pluck(figure[(b * 2 + i) % figure.length], {
        at: i * 0.5,
        gain: i === 0 ? 0.014 : 0.01,
        dur: 0.34,
        filter: 2400,
        pan: (i === 0 ? -1 : 1) * 0.15,
        brightness: 0.65,
      });
    }
    // A held minor-second tension high in the texture.
    if (b === 12) c.tone(311.13, { gain: 0.006, dur: 2.2, attack: 0.8, filter: 1500 });
  },
};

const VICTORY: TrackDef = {
  bpm: 88,
  loop: 16,
  step: (c) => {
    const b = c.beat;
    const chords: Record<number, number[]> = {
      0: [130.81, 164.81, 196.0],
      4: [87.31, 174.61, 220.0],
      8: [98.0, 196.0, 246.94],
      12: [130.81, 196.0, 261.63],
    };
    const chord = chords[b];
    if (chord) c.pad(chord, 4, 0.016);
    if (b % 4 === 0) c.drum('kick', 0.8);
    if (b === 4 || b === 12) c.drum('snare', 0.6);
    if (b % 2 === 1) c.drum('shaker', 0.5);
    const melody: Record<number, number> = {
      0: 392.0, 2: 523.25, 4: 659.25, 8: 783.99, 12: 659.25, 14: 523.25,
    };
    const freq = melody[b];
    if (freq) c.pluck(freq, { gain: 0.026, dur: 1.0, filter: 3200, send: 0.3 });
    if (b === 0) c.bell(523.25, 0.008, 2.4);
  },
};

const DEFEAT: TrackDef = {
  bpm: 52,
  loop: 16,
  step: (c) => {
    const b = c.beat;
    if (b === 0) {
      c.pad([110.0, 130.81, 164.81], 8, 0.02);
      c.tone(55.0, { gain: 0.016, dur: 8 * c.beatDur, attack: 2, filter: 300 });
    }
    if (b === 8) c.pad([87.31, 130.81, 174.61], 8, 0.018);
    const melody: Record<number, number> = { 0: 220.0, 4: 196.0, 8: 174.61, 12: 164.81 };
    const freq = melody[b];
    if (freq) c.pluck(freq, { gain: 0.03, dur: 1.5, filter: 1600, brightness: 0.45 });
    if (b === 0) c.drum('kick', 0.45);
    if (b === 8) c.drum('tom', 0.35);
    if (b === 6) c.bell(220.0, 0.009, 3.2);
  },
};

const TRACKS: Record<MusicTrack, TrackDef> = {
  menu: MENU,
  tournament: TOURNAMENT,
  melee: MELEE,
  victory: VICTORY,
  defeat: DEFEAT,
};

/** Exposed for tests + the audio lab. */
export const MUSIC_TRACKS = Object.keys(TRACKS) as MusicTrack[];

/* ------------------------------------------------------------------ */
/* Player                                                              */
/* ------------------------------------------------------------------ */

export class MusicPlayer {
  private readonly host: MusicHost;
  private readonly loopBus: GainNode;
  /** Make-up gain: note-level gains are kept small for clean maths. */
  private readonly trim: GainNode;
  private readonly cache = new Map<number, AudioBuffer>();
  private current: ActiveTrack | null = null;
  private timer: number | null = null;
  private disposers = new Set<number>();

  constructor(host: MusicHost) {
    this.host = host;
    this.trim = host.ctx.createGain();
    // ~ -22 dB under the loudest effects at the default sliders: a bed, not a
    // concert. The master/music sliders still ride on top of this.
    this.trim.gain.value = 9;
    this.trim.connect(host.bus);
    this.loopBus = host.ctx.createGain();
    this.loopBus.gain.value = 1;
    this.loopBus.connect(this.trim);
  }

  get track(): MusicTrack | null {
    return this.current?.track ?? null;
  }

  start(track: MusicTrack): void {
    if (this.current?.track === track) return;
    this.fadeOutCurrent(0.9);
    const { ctx } = this.host;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(1, now + 1.6);
    gain.connect(this.loopBus);
    this.current = {
      track,
      gain,
      beat: 0,
      nextTime: now + 0.14,
    };
    if (this.timer === null) {
      this.timer = window.setInterval(this.schedule, 80);
    }
    this.schedule();
  }

  stop(fade = 1.2): void {
    this.fadeOutCurrent(fade);
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  private fadeOutCurrent(fade: number): void {
    const current = this.current;
    if (!current) return;
    const { ctx } = this.host;
    const now = ctx.currentTime;
    const param = current.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(Math.max(0.0001, param.value), now);
    param.exponentialRampToValueAtTime(0.0001, now + Math.max(0.1, fade));
    const timer = window.setTimeout(() => {
      try {
        current.gain.disconnect();
      } catch {
        /* already gone */
      }
      this.disposers.delete(timer);
    }, Math.max(0.1, fade) * 1000 + 150);
    this.disposers.add(timer);
    this.current = null;
  }

  private schedule = (): void => {
    const active = this.current;
    if (!active) return;
    const { ctx } = this.host;
    // Do not thicken a suspended context with queued notes; resync on resume.
    if (ctx.state !== 'running') {
      active.nextTime = ctx.currentTime + 0.1;
      return;
    }
    const def = TRACKS[active.track];
    const beatDur = 60 / def.bpm;
    const ahead = ctx.currentTime + 0.42;
    if (active.nextTime < ctx.currentTime - 0.5) {
      // Tab hidden / scheduler stalled: resync instead of firing a burst.
      active.nextTime = ctx.currentTime + 0.06;
    }
    let guard = 0;
    while (active.nextTime < ahead && guard < 48) {
      const composer = new BeatComposer({
        ctx,
        out: active.gain,
        send: this.host.send,
        noise: this.host.noise,
        cache: this.cache,
        when: active.nextTime,
        beat: active.beat,
        beatDur,
        loop: def.loop,
      });
      try {
        def.step(composer);
      } catch {
        /* a dropped note must never silence the game */
      }
      active.nextTime += beatDur;
      active.beat = (active.beat + 1) % def.loop;
      guard++;
    }
  };

  dispose(): void {
    this.stop(0.3);
    for (const id of this.disposers) window.clearTimeout(id);
    this.disposers.clear();
    this.cache.clear();
    try {
      this.loopBus.disconnect();
      this.trim.disconnect();
    } catch {
      /* already disconnected */
    }
  }
}
