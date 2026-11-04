/**
 * Apex Drift — procedural WebAudio engine and SFX.
 *
 * No audio assets and no libraries: the engine note is a small stack of detuned
 * saw/square oscillators driven through a lowpass + waveshaper, and every other
 * sound is filtered noise or a synthesised blip. The `AudioContext` is created
 * lazily on the first `resume()` (which the app calls from a user gesture) so
 * browsers are happy and so importing this module in Node is a no-op.
 *
 * The module touches no DOM/Audio globals at import time.
 *
 * @module app/audio
 * @typedef {{
 *   rpm01?: number|null, throttle?: number|null, speed?: number|null,
 *   slip?: number|null, boosting?: boolean|null, surface?: string|null,
 *   parked?: boolean|null, raceState?: string|null,
 * }} AudioFrame
 */

const VOLUME_DEFAULT = 0.8;
const NOISE_SECONDS = 2;
const SILENT = 0.0001;

/** @returns {number} */
function clampNumber(value, lo, hi, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return n < lo ? lo : n > hi ? hi : n;
}

/** `performance.now()` in ms; falls back to `Date.now()` when unavailable. */
function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/**
 * Soft-clip curve for the engine waveshaper. Gentle enough to keep the tone,
 * strong enough to make the oscillator stack sound like a combustion engine.
 * @param {number} amount
 * @returns {Float32Array}
 */
function makeDriveCurve(amount) {
  const samples = 1024;
  const curve = new Float32Array(samples);
  const drive = amount > 0 ? amount : 1;
  for (let i = 0; i < samples; i += 1) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) * 0.9;
  }
  return curve;
}

/**
 * Build a loopable noise buffer.
 * @param {BaseAudioContext} context
 * @param {'white'|'pink'} kind
 * @returns {AudioBuffer}
 */
function makeNoiseBuffer(context, kind) {
  const length = Math.max(1, Math.floor(context.sampleRate * NOISE_SECONDS));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  if (kind === 'pink') {
    /* Paul Kellet's economy pink filter — cheap and stable. */
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    for (let i = 0; i < length; i += 1) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = clampNumber(pink * 0.1, -1, 1, 0);
    }
  } else {
    for (let i = 0; i < length; i += 1) data[i] = Math.random() * 2 - 1;
  }

  return buffer;
}

/**
 * Create the procedural audio system.
 *
 * All methods are safe to call before the context exists and in environments
 * without WebAudio (every call becomes a no-op).
 *
 * @returns {{
 *   resume: () => void,
 *   suspend: () => void,
 *   dispose: () => void,
 *   setMuted: (value: boolean) => void,
 *   muted: boolean,
 *   setVolume: (value: number) => void,
 *   update: (frame?: AudioFrame) => void,
 *   event: (kind: string) => void,
 * }}
 */
export function createAudio() {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {Record<string, any>|null} */
  let graph = null;
  let disposed = false;
  let muted = false;
  let volume = VOLUME_DEFAULT;
  let lastNitroEventAt = -Infinity;

  /** Last frame values, used for edge detection and defensive fallbacks. */
  const last = {
    rpm01: 0,
    throttle: 0,
    speed: 0,
    slip: 0,
    boosting: false,
    surface: 'road',
    parked: true,
    raceState: 'title',
  };

  /* --------------------------------------------------------- graph setup -- */

  function audioCtor() {
    if (typeof globalThis === 'undefined') return null;
    const ctor = globalThis.AudioContext || globalThis.webkitAudioContext || null;
    return typeof ctor === 'function' ? ctor : null;
  }

  function gainNode(value) {
    const node = ctx.createGain();
    node.gain.value = value;
    return node;
  }

  function biquad(type, frequency, q) {
    const node = ctx.createBiquadFilter();
    node.type = type;
    node.frequency.value = frequency;
    node.Q.value = q;
    return node;
  }

  function noiseSource(buffer) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    return src;
  }

  /** Smooth (zipper-free) parameter automation. */
  function setTarget(param, value, timeConstant = 0.05) {
    if (!param || !ctx) return;
    try {
      param.setTargetAtTime(value, ctx.currentTime, Math.max(0.005, timeConstant));
    } catch {
      try {
        param.value = value;
      } catch {
        /* ignore hostile/stub nodes */
      }
    }
  }

  function buildGraph(context) {
    const white = makeNoiseBuffer(context, 'white');
    const pink = makeNoiseBuffer(context, 'pink');

    const master = context.createGain();
    master.gain.value = muted ? 0 : volume;

    const limiter = context.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 12;
    limiter.ratio.value = 8;
    limiter.attack.value = 0.004;
    limiter.release.value = 0.22;

    master.connect(limiter);
    limiter.connect(context.destination);

    const sources = [];

    /* ---------------------------------------------------------- engine -- */
    const engineOut = gainNode(0);
    const shaper = context.createWaveShaper();
    shaper.curve = makeDriveCurve(1.7);
    shaper.oversample = '2x';
    const filter = biquad('lowpass', 640, 1.15);

    filter.connect(shaper);
    shaper.connect(engineOut);
    engineOut.connect(master);

    /* Slight per-oscillator detune gives the stack its beat/rasp. */
    const osc1 = context.createOscillator();
    osc1.type = 'sawtooth';
    osc1.frequency.value = 60;
    osc1.detune.value = -6;

    const osc2 = context.createOscillator();
    osc2.type = 'square';
    osc2.frequency.value = 30;
    osc2.detune.value = 9;

    const osc3 = context.createOscillator();
    osc3.type = 'sawtooth';
    osc3.frequency.value = 90;
    osc3.detune.value = 5;

    const osc1Gain = gainNode(0.5);
    const osc2Gain = gainNode(0.34);
    const osc3Gain = gainNode(0.22);
    osc1.connect(osc1Gain);
    osc2.connect(osc2Gain);
    osc3.connect(osc3Gain);
    osc1Gain.connect(filter);
    osc2Gain.connect(filter);
    osc3Gain.connect(filter);

    /* Induction rasp: quiet pink noise breathing with the revs. */
    const inductionSrc = noiseSource(pink);
    const inductionFilter = biquad('bandpass', 1200, 0.8);
    const inductionGain = gainNode(0.03);
    inductionSrc.connect(inductionFilter);
    inductionFilter.connect(inductionGain);
    inductionGain.connect(filter);

    /* ------------------------------------------------- tyre / surface -- */
    const squealSrc = noiseSource(white);
    const squealFilter = biquad('bandpass', 1100, 6);
    const squealGain = gainNode(0);
    squealSrc.connect(squealFilter);
    squealFilter.connect(squealGain);
    squealGain.connect(master);

    const surfaceSrc = noiseSource(white);
    const surfaceFilter = biquad('bandpass', 520, 1.1);
    const surfaceGain = gainNode(0);
    surfaceSrc.connect(surfaceFilter);
    surfaceFilter.connect(surfaceGain);
    surfaceGain.connect(master);

    /* ------------------------------------------------------------ wind -- */
    const windSrc = noiseSource(white);
    const windFilter = biquad('highpass', 900, 0.7);
    const windGain = gainNode(0);
    windSrc.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);

    /* ----------------------------------------------------------- nitro -- */
    const nitroRumbleGain = gainNode(0);
    const nitroRumbleFilter = biquad('lowpass', 180, 1);
    const nitroRumbleOsc = context.createOscillator();
    nitroRumbleOsc.type = 'sine';
    nitroRumbleOsc.frequency.value = 45;
    const nitroRumbleNoise = noiseSource(pink);
    nitroRumbleOsc.connect(nitroRumbleFilter);
    nitroRumbleNoise.connect(nitroRumbleFilter);
    nitroRumbleFilter.connect(nitroRumbleGain);
    nitroRumbleGain.connect(master);

    /* Start every persistent source. */
    const now = context.currentTime;
    for (const osc of [osc1, osc2, osc3, nitroRumbleOsc]) {
      try {
        osc.start(now);
        sources.push(osc);
      } catch {
        /* ignore */
      }
    }
    for (const src of [inductionSrc, squealSrc, surfaceSrc, windSrc, nitroRumbleNoise]) {
      try {
        src.start(now);
        sources.push(src);
      } catch {
        /* ignore */
      }
    }

    return {
      master,
      limiter,
      white,
      pink,
      sources,
      engine: { out: engineOut, filter, shaper, osc1, osc2, osc3, inductionGain },
      squeal: { gain: squealGain, filter: squealFilter },
      surface: { gain: surfaceGain, filter: surfaceFilter },
      wind: { gain: windGain, filter: windFilter },
      nitro: { gain: nitroRumbleGain, osc: nitroRumbleOsc, filter: nitroRumbleFilter },
    };
  }

  /**
   * Lazily create the AudioContext + graph. Returns null when WebAudio is
   * unavailable (Node, old browsers, blocked contexts).
   * @returns {AudioContext|null}
   */
  function ensure() {
    if (ctx) return ctx;
    if (disposed) return null;
    const Ctor = audioCtor();
    if (!Ctor) return null;
    try {
      ctx = new Ctor({ latencyHint: 'interactive' });
      graph = buildGraph(ctx);
      setTarget(graph.master.gain, muted ? 0 : volume, 0.02);
      return ctx;
    } catch {
      ctx = null;
      graph = null;
      return null;
    }
  }

  /* ------------------------------------------------------------ one-shots -- */

  /**
   * Schedule a short oscillator blip with a click-free envelope.
   * @param {number} frequency
   * @param {number} duration seconds
   * @param {{type?: OscillatorType, peak?: number, delay?: number, endFreq?: number, attack?: number}} [options]
   */
  function beep(frequency, duration, options = {}) {
    if (!ctx || !graph) return;
    const type = options.type ?? 'square';
    const peak = clampNumber(options.peak ?? 0.14, 0.0002, 0.45, 0.14);
    const delay = Math.max(0, clampNumber(options.delay ?? 0, 0, 10, 0));
    const attack = Math.max(0.004, Math.min(duration * 0.5, options.attack ?? 0.008));
    const endFreq = options.endFreq ?? 0;
    try {
      const t0 = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const env = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(Math.max(20, frequency), t0);
      if (endFreq > 0) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
      }
      env.gain.setValueAtTime(SILENT, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      env.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);
      osc.connect(env);
      env.connect(graph.master);
      osc.start(t0);
      osc.stop(t0 + duration + 0.04);
      osc.onended = () => {
        try {
          osc.disconnect();
          env.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* a failed one-shot must never break the frame */
    }
  }

  /**
   * Schedule a filtered noise burst.
   * @param {number} duration seconds
   * @param {{filter?: BiquadFilterType, freq?: number, endFreq?: number, q?: number,
   *          peak?: number, delay?: number, buffer?: 'white'|'pink', attack?: number}} [options]
   */
  function noiseBurst(duration, options = {}) {
    if (!ctx || !graph) return;
    const filterType = options.filter ?? 'bandpass';
    const freq = Math.max(20, options.freq ?? 1200);
    const endFreq = options.endFreq ?? 0;
    const peak = clampNumber(options.peak ?? 0.16, 0.0002, 0.45, 0.16);
    const delay = Math.max(0, clampNumber(options.delay ?? 0, 0, 10, 0));
    const attack = Math.max(0.004, Math.min(duration * 0.5, options.attack ?? 0.012));
    try {
      const t0 = ctx.currentTime + delay;
      const src = ctx.createBufferSource();
      src.buffer = options.buffer === 'pink' ? graph.pink : graph.white;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = filterType;
      filter.Q.value = clampNumber(options.q ?? 1.2, 0.0001, 30, 1.2);
      filter.frequency.setValueAtTime(freq, t0);
      if (endFreq > 0) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
      }
      const env = ctx.createGain();
      env.gain.setValueAtTime(SILENT, t0);
      env.gain.exponentialRampToValueAtTime(peak, t0 + attack);
      env.gain.exponentialRampToValueAtTime(SILENT, t0 + duration);
      src.connect(filter);
      filter.connect(env);
      env.connect(graph.master);
      src.start(t0);
      src.stop(t0 + duration + 0.05);
      src.onended = () => {
        try {
          src.disconnect();
          filter.disconnect();
          env.disconnect();
        } catch {
          /* ignore */
        }
      };
    } catch {
      /* ignore */
    }
  }

  function playNitroBurst() {
    noiseBurst(0.5, { filter: 'bandpass', freq: 420, endFreq: 2600, q: 1.1, peak: 0.18 });
    beep(72, 0.55, { type: 'sawtooth', peak: 0.09, endFreq: 132 });
  }

  /* ------------------------------------------------------------ public API -- */

  function resume() {
    if (disposed) return;
    const context = ensure();
    if (!context) return;
    if (context.state === 'suspended') {
      try {
        const pending = context.resume();
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
      } catch {
        /* ignore */
      }
    }
  }

  function suspend() {
    if (!ctx || disposed) return;
    if (ctx.state !== 'running') return;
    try {
      const pending = ctx.suspend();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    const g = graph;
    const c = ctx;
    graph = null;
    ctx = null;
    if (!c) return;
    if (g) {
      for (const src of g.sources) {
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
      }
      try {
        g.master.disconnect();
        g.limiter.disconnect();
      } catch {
        /* ignore */
      }
    }
    try {
      const pending = c.close();
      if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch {
      /* ignore */
    }
  }

  function setMuted(value) {
    muted = Boolean(value);
    if (!ctx || !graph) return;
    setTarget(graph.master.gain, muted ? 0 : volume, 0.06);
  }

  function setVolume(value) {
    volume = clampNumber(value, 0, 1, volume);
    if (!ctx || !graph || muted) return;
    setTarget(graph.master.gain, volume, 0.08);
  }

  /**
   * Per-frame parameter update. Called every rendered frame by `main.js`.
   * @param {AudioFrame} [frame]
   */
  function update(frame) {
    if (disposed) return;
    if (!frame || typeof frame !== 'object') return;

    const rpm = clampNumber(frame.rpm01, 0, 1, last.rpm01);
    const throttle = Math.max(0, clampNumber(frame.throttle, -1, 1, last.throttle));
    const speed = Math.max(0, clampNumber(frame.speed, 0, 400, last.speed));
    const slip = clampNumber(frame.slip, 0, 1, last.slip);
    const boosting = Boolean(frame.boosting);
    const parked = Boolean(frame.parked);
    const surface = typeof frame.surface === 'string' ? frame.surface : last.surface;
    const raceState = typeof frame.raceState === 'string' ? frame.raceState : last.raceState;

    const wasBoosting = last.boosting;
    last.rpm01 = rpm;
    last.throttle = throttle;
    last.speed = speed;
    last.slip = slip;
    last.boosting = boosting;
    last.surface = surface;
    last.parked = parked;
    last.raceState = raceState;

    if (!ctx || !graph) return;

    try {
      const speedNorm = clampNumber(speed / 88, 0, 1, 0);
      const menuIdle = raceState === 'title' || raceState === 'garage' || raceState === 'loading';
      const fundamental = 55 + rpm * 135;

      /* Engine: 2–3 detuned oscillators → lowpass → drive → gain. */
      setTarget(graph.engine.osc1.frequency, fundamental, 0.03);
      setTarget(graph.engine.osc2.frequency, fundamental * 0.5, 0.03);
      setTarget(graph.engine.osc3.frequency, fundamental * 1.5, 0.04);
      setTarget(graph.engine.filter.frequency, 380 + rpm * 2600 + throttle * 420, 0.05);

      let engineGain;
      if (parked) engineGain = menuIdle ? 0.014 : 0.03 + rpm * 0.05;
      else engineGain = 0.075 + throttle * 0.15 + speedNorm * 0.07;
      setTarget(graph.engine.out.gain, clampNumber(engineGain, 0, 0.32, 0.1), 0.07);
      setTarget(graph.engine.inductionGain.gain, 0.015 + rpm * 0.035, 0.08);

      /* Tyre squeal rises with slip; pitch lifts a little as it breaks away. */
      const squealTarget =
        slip > 0.1 ? clampNumber((slip - 0.1) / 0.9, 0, 1, 0) * 0.14 * (0.35 + speedNorm * 0.65) : 0;
      setTarget(graph.squeal.gain.gain, squealTarget, 0.05);
      setTarget(graph.squeal.filter.frequency, 900 + slip * 900 + speedNorm * 250, 0.06);

      /* Surface noise: kerbs buzz, grass hisses, asphalt is a low rumble. */
      let surfaceFreq = 480;
      if (surface === 'kerb') surfaceFreq = 1900;
      else if (surface === 'grass') surfaceFreq = 1200;
      const surfaceExtra = surface === 'road' ? 0 : 0.028;
      setTarget(graph.surface.gain.gain, 0.012 + speedNorm * 0.05 + surfaceExtra, 0.08);
      setTarget(graph.surface.filter.frequency, surfaceFreq + speedNorm * 260, 0.08);

      /* Wind builds with speed. */
      setTarget(graph.wind.gain.gain, Math.pow(speedNorm, 1.6) * 0.085, 0.1);
      setTarget(graph.wind.filter.frequency, 760 + speedNorm * 900, 0.1);

      /* Nitrous rumble under the boost. */
      setTarget(graph.nitro.gain.gain, boosting ? 0.11 : 0, 0.07);
      setTarget(graph.nitro.osc.frequency, 42 + speedNorm * 12, 0.1);

      /* Burst on boost start, unless main already fired event('nitro'). */
      if (boosting && !wasBoosting && nowMs() - lastNitroEventAt > 250) {
        playNitroBurst();
      }
    } catch {
      /* never let audio break a frame */
    }
  }

  /**
   * Fire a one-shot. Unknown kinds are ignored.
   * @param {string} kind
   */
  function event(kind) {
    if (disposed) return;
    if (!ctx || !graph) return;
    try {
      switch (kind) {
        case 'countdown':
          beep(680, 0.14, { type: 'square', peak: 0.16 });
          break;
        case 'go':
          beep(1360, 0.46, { type: 'square', peak: 0.2 });
          beep(680, 0.46, { type: 'triangle', peak: 0.12 });
          break;
        case 'lap':
          beep(880, 0.1, { type: 'triangle', peak: 0.16 });
          beep(1320, 0.24, { type: 'triangle', peak: 0.14, delay: 0.11 });
          break;
        case 'best':
          beep(1046.5, 0.18, { type: 'triangle', peak: 0.16 });
          beep(1568, 0.42, { type: 'triangle', peak: 0.14, delay: 0.12 });
          beep(2093, 0.3, { type: 'sine', peak: 0.05, delay: 0.2 });
          break;
        case 'finish': {
          const notes = [523.25, 659.25, 783.99, 1046.5];
          notes.forEach((note, index) => {
            beep(note, index === notes.length - 1 ? 0.6 : 0.16, {
              type: 'square',
              peak: 0.12,
              delay: index * 0.1,
            });
          });
          break;
        }
        case 'scrape':
          noiseBurst(0.22, { filter: 'bandpass', freq: 2400, endFreq: 1400, q: 2.2, peak: 0.16 });
          break;
        case 'nitro':
          lastNitroEventAt = nowMs();
          playNitroBurst();
          break;
        case 'shift':
          noiseBurst(0.05, { filter: 'highpass', freq: 2600, q: 0.8, peak: 0.06 });
          break;
        case 'click':
          beep(920, 0.05, { type: 'sine', peak: 0.07 });
          break;
        case 'crash':
          beep(120, 0.5, { type: 'sine', peak: 0.3, endFreq: 38 });
          noiseBurst(0.4, { filter: 'lowpass', freq: 1600, endFreq: 220, q: 0.7, peak: 0.22 });
          break;
        default:
          break;
      }
    } catch {
      /* ignore */
    }
  }

  return {
    get muted() {
      return muted;
    },
    resume,
    suspend,
    dispose,
    setMuted,
    setVolume,
    update,
    event,
  };
}

export default createAudio;
