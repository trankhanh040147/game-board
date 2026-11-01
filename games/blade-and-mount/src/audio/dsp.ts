/**
 * BLADE & MOUNT — shared DSP primitives.
 *
 * Everything here is pure/runtime-generation only: noise banks, convolution
 * impulse, Karplus–Strong string synthesis, small envelope helpers and the
 * camera-relative attenuation/pan maths. No files, no network.
 */

/* ------------------------------------------------------------------ */
/* Tuning                                                              */
/* ------------------------------------------------------------------ */

/** Hard cap on simultaneous one-shot SFX voices (kills runaway stacking). */
export const MAX_SFX_VOICES = 24;

/** Identical SFX fired inside this window are treated as the same event. */
export const THROTTLE_MS = 30;

/** Values outside this range would sound like tape-speed artefacts. */
export const MIN_RATE = 0.55;
export const MAX_RATE = 1.9;

/* ------------------------------------------------------------------ */
/* Numeric helpers                                                     */
/* ------------------------------------------------------------------ */

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function clamp01(value: number): number {
  return Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

export function safeRate(rate: number | undefined): number {
  if (!Number.isFinite(rate ?? 1)) return 1;
  return clamp(rate ?? 1, MIN_RATE, MAX_RATE);
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Perceptual-ish volume curve for user-facing sliders. */
export function volumeCurve(value01: number, exponent = 1.2): number {
  return Math.pow(clamp01(value01), exponent);
}

/* ------------------------------------------------------------------ */
/* Spatialisation (camera-relative, stereo)                            */
/* ------------------------------------------------------------------ */

export interface Listener {
  x: number;
  y: number;
  z: number;
  /** Camera/world right vector (normalised, XZ used). */
  rx: number;
  rz: number;
  /** Camera/world forward vector (unused for pan, kept for future). */
  fx: number;
  fz: number;
}

export interface SpatialMix {
  gain: number;
  pan: number;
}

export const IDENTITY_LISTENER: Listener = { x: 0, y: 0, z: 0, rx: 1, rz: 0, fx: 0, fz: -1 };

/**
 * Distance rolloff. Full level inside ~1.5 m, roughly −6 dB at 6 m, near
 * silence beyond ~45 m. Chosen so an arena-sized brawl still reads loudly
 * while the far gatehouse is only a whisper.
 */
export function distanceGain(distance: number): number {
  if (!Number.isFinite(distance) || distance <= 0) return 1;
  const near = 0.9;
  const rolloff = 1 / (1 + Math.max(0, distance - near) * 0.19);
  const floorGain = 0.035;
  return clamp(rolloff, floorGain, 1);
}

/**
 * Stereo pan for a world point relative to the listener. Uses horizontal
 * distance so a sound above/below the camera does not over-pan; near sounds
 * pan harder than far ones, like a real point source.
 */
export function panFor(dx: number, dz: number): number {
  const horiz = Math.hypot(dx, dz);
  if (horiz < 1e-4) return 0;
  const side = dx / (horiz + 1.05);
  return clamp(side * 1.45, -0.92, 0.92);
}

export function spatialMix(
  pos: { x: number; y: number; z: number },
  listener: Listener,
): SpatialMix {
  const dx = pos.x - listener.x;
  const dy = pos.y - listener.y;
  const dz = pos.z - listener.z;
  const distance = Math.hypot(dx, dy, dz);
  // Project onto the listener's right vector (camera space X) for stereo pan.
  const rightAmount = dx * listener.rx + dz * listener.rz;
  return {
    gain: distanceGain(distance),
    pan: panFor(rightAmount, 0),
  };
}

/* ------------------------------------------------------------------ */
/* Noise banks                                                         */
/* ------------------------------------------------------------------ */

export type NoiseColor = 'white' | 'pink' | 'brown';

/**
 * Deterministic-ish noise beds shared by every effect. `pink` uses Paul
 * Kellet's filter cascade (warm, natural), `brown` is heavily integrated
 * (rumbles), `white` is flat (air, clicks).
 */
export function makeNoiseBuffer(
  ctx: BaseAudioContext,
  seconds = 2,
  color: NoiseColor = 'white',
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const channels = 2;
  const buffer = ctx.createBuffer(channels, length, ctx.sampleRate);
  for (let channel = 0; channel < channels; channel++) {
    const data = buffer.getChannelData(channel);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;
    let brown = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      if (color === 'white') {
        data[i] = white * 0.7;
        continue;
      }
      if (color === 'brown') {
        brown = (brown + white * 0.021) * 0.997;
        data[i] = clamp(brown * 3.2, -1, 1) * 0.8;
        continue;
      }
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.969 * b2 + white * 0.153852;
      b3 = 0.8665 * b3 + white * 0.3104856;
      b4 = 0.55 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.016898;
      const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
      b6 = white * 0.115926;
      data[i] = clamp(pink * 0.13, -1, 1);
    }
  }
  return buffer;
}

/**
 * A warm stone-hall impulse: decorrelated noise decays with a handful of
 * discrete early reflections. Used as the shared convolver reverb so impacts
 * and horns sit in the same space as the arena.
 */
export function makeImpulseResponse(
  ctx: BaseAudioContext,
  seconds = 2.9,
  decay = 3.0,
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  const taps = [0.012, 0.027, 0.045, 0.071, 0.113];
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    let smooth = 0;
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const noise = Math.random() * 2 - 1;
      // One-pole low-pass keeps the tail dark and arena-like.
      smooth += (noise - smooth) * 0.42;
      const body = Math.pow(1 - t, decay) * (1 - t * 0.35);
      data[i] = smooth * body * 0.62;
    }
    for (const tap of taps) {
      const index = Math.floor((tap + channel * 0.0043) * ctx.sampleRate);
      if (index < length) {
        data[index] += (channel === 0 ? 0.55 : 0.44) * (1 - tap * 5.5);
      }
    }
    // Fade the very tail to zero so the convolver never loops a hard edge.
    const fade = Math.min(512, length);
    for (let i = 0; i < fade; i++) {
      data[length - 1 - i] *= i / fade;
    }
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Karplus–Strong string synthesis                                     */
/* ------------------------------------------------------------------ */

export interface PluckOptions {
  /** 0 = dull/woolly lute, 1 = bright wire. */
  brightness?: number;
  /** Sustain length in seconds. */
  seconds?: number;
  /** Slight detune in cents for natural chorus. */
  detuneCents?: number;
}

/**
 * Generate a plucked-string waveform with the Karplus–Strong algorithm at the
 * requested frequency. Frequencies are quantised to 0.01 Hz by the caller's
 * cache, so a handful of buffers cover a whole score.
 */
export function makePluckBuffer(
  ctx: BaseAudioContext,
  frequency: number,
  options: PluckOptions = {},
): AudioBuffer {
  const freq = clamp(Number.isFinite(frequency) ? frequency : 220, 40, 4000);
  const brightness = clamp01(options.brightness ?? 0.55);
  const seconds = clamp(options.seconds ?? 1.5, 0.2, 5);
  const cents = options.detuneCents ?? 0;
  const tuned = freq * Math.pow(2, cents / 1200);
  const length = Math.max(8, Math.floor(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);

  const delayLength = Math.max(2, Math.round(ctx.sampleRate / tuned));
  const delay = new Float32Array(delayLength);
  // Excitation: a short burst of smoothed noise. Brighter pick = less smoothing.
  const smooth = 1 - brightness * 0.72;
  let lastNoise = 0;
  for (let i = 0; i < delayLength; i++) {
    const white = Math.random() * 2 - 1;
    lastNoise = lastNoise * smooth + white * (1 - smooth);
    delay[i] = lastNoise;
  }
  // Body/pick comb so the attack has a wooden "tick" rather than plain fizz.
  const pickIndex = Math.floor(delayLength * 0.18);
  if (pickIndex < delayLength) delay[pickIndex] += 0.6;

  // Per-period damping for a lute-like ~1.4 s tail; pitch-compensated.
  const period = delayLength / ctx.sampleRate;
  const t60 = 1.35 + 0.25 * (1 - brightness);
  const damp = Math.pow(10, (-3 * period) / t60);

  let index = 0;
  let previous = 0;
  for (let i = 0; i < length; i++) {
    const current = delay[index];
    data[i] = current;
    const averaged = (current + previous) * 0.5 * damp;
    previous = current;
    delay[index] = averaged;
    index = (index + 1) % delayLength;
  }

  // Slow amplitude fade at the tail end removes any buffer-boundary click.
  const fade = Math.min(Math.floor(ctx.sampleRate * 0.08), length);
  for (let i = 0; i < fade; i++) {
    data[length - 1 - i] *= i / fade;
  }
  return buffer;
}

/* ------------------------------------------------------------------ */
/* Envelope + graph helpers                                            */
/* ------------------------------------------------------------------ */

/**
 * Fast attack, exponential decay. Every transient in the game uses this so
 * impacts never click; the 0.0001 floor (not 0) keeps exponential ramps legal.
 */
export function expEnvelope(
  param: AudioParam,
  start: number,
  peak: number,
  attack: number,
  decayTail: number,
  floor = 0.0001,
): void {
  const target = Math.max(floor * 2, peak);
  const attackTime = Math.max(0.0006, attack);
  const end = start + attackTime + Math.max(0.01, decayTail);
  param.setValueAtTime(floor, start);
  param.exponentialRampToValueAtTime(target, start + attackTime);
  param.exponentialRampToValueAtTime(floor, end);
}

/** A soft swell (raised attack) used for winds, cloth and crowd layers. */
export function swellEnvelope(
  param: AudioParam,
  start: number,
  peak: number,
  attack: number,
  decayTail: number,
  floor = 0.0001,
): void {
  const target = Math.max(floor * 2, peak);
  const attackTime = Math.max(0.004, attack);
  param.setValueAtTime(floor, start);
  param.linearRampToValueAtTime(target, start + attackTime);
  param.exponentialRampToValueAtTime(floor, start + attackTime + Math.max(0.02, decayTail));
}
