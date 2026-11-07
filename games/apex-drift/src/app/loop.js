/**
 * Fixed-timestep game loop.
 *
 * The simulation advances in exact `step` increments no matter the display rate;
 * rendering happens once per animation frame. When the tab stalls, the
 * accumulator is clamped so the car does not teleport on resume.
 *
 * `requestAnimationFrame` is injected so the loop can be driven from tests or a
 * headless harness.
 */

import { clamp } from '../core/math.js';

/** Browser rAF wrapper used when the caller does not inject one. */
function defaultRaf(callback) {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(callback);
  return setTimeout(() => callback(Date.now()), 1000 / 60);
}

function defaultCancelRaf(handle) {
  if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  else clearTimeout(handle);
}

/**
 * @param {{
 *   step:number,
 *   maxSubsteps?:number,
 *   maxFrameDt?:number,
 *   onStep:(dt:number)=>void,
 *   onRender:(dt:number, interpolation:number)=>void,
 *   raf?:Function,
 *   cancelRaf?:Function,
 * }} options
 */
export function createLoop(options) {
  const step = options.step;
  const maxSubsteps = options.maxSubsteps ?? 8;
  const maxFrameDt = options.maxFrameDt ?? 0.1;
  const raf = options.raf ?? defaultRaf;
  const cancelRaf = options.cancelRaf ?? defaultCancelRaf;

  let accumulator = 0;
  let lastTime = null;
  let running = false;
  let handle = null;
  let frameCount = 0;
  let elapsed = 0;
  let fps = 60;
  let smoothFps = 60;
  const stats = { fps: 60, steps: 0, frame: 0, dt: 0 };

  /** Feed a timestamp in milliseconds; returns the number of simulated steps. */
  function advance(nowMs) {
    if (lastTime === null) {
      lastTime = nowMs;
      return 0;
    }
    let frameDt = (nowMs - lastTime) / 1000;
    lastTime = nowMs;
    if (!Number.isFinite(frameDt) || frameDt < 0) frameDt = 0;
    frameDt = Math.min(frameDt, maxFrameDt);
    if (frameDt > 0) {
      fps = 1 / frameDt;
      smoothFps += (fps - smoothFps) * 0.1;
    }
    elapsed += frameDt;
    frameCount += 1;

    accumulator += frameDt;
    let steps = 0;
    while (accumulator >= step && steps < maxSubsteps) {
      options.onStep(step);
      accumulator -= step;
      steps += 1;
      stats.steps += 1;
    }
    // If we are still behind after the substep budget, drop the backlog rather
    // than fast-forwarding (a huge catch-up looks like teleporting).
    if (steps === maxSubsteps && accumulator > step) accumulator = 0;

    stats.frame = frameCount;
    stats.fps = smoothFps;
    stats.dt = frameDt;
    const interpolation = clamp(accumulator / step, 0, 1);
    options.onRender(frameDt, interpolation);
    return steps;
  }

  function start() {
    if (running) return stats;
    running = true;
    lastTime = null;
    const tick = (nowMs) => {
      if (!running) return;
      advance(typeof nowMs === 'number' ? nowMs : Date.now());
      handle = raf(tick);
    };
    handle = raf(tick);
    return stats;
  }

  function stop() {
    running = false;
    if (handle !== null) {
      cancelRaf(handle);
      handle = null;
    }
  }

  function reset() {
    accumulator = 0;
    lastTime = null;
  }

  return {
    advance,
    start,
    stop,
    reset,
    stats,
    get running() {
      return running;
    },
    get fps() {
      return stats.fps;
    },
    get time() {
      return elapsed;
    },
    /** Fractional progress into the next simulation step (for interpolation). */
    get interpolation() {
      return clamp(accumulator / step, 0, 1);
    },
  };
}
