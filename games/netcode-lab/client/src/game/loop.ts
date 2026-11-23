// "Fix your timestep" accumulator (HANDOFF B.4 rule 1) plus a frame scheduler with an FPS cap.
// The sim never sees frame dt: onTick runs a whole number of fixed steps, onRender gets alpha in [0,1).

export type FpsCap = 30 | 60 | 144 | 0; // 0 = uncapped

export interface LoopHooks {
  onTick(tick: number): void;
  onRender(alpha: number, frameMs: number): void;
}

const MAX_STEPS_PER_FRAME = 8;

export class FixedLoop {
  tickMs: number;
  fpsCap: FpsCap = 60;
  private acc = 0;
  private tick = 0;
  private last = -1;
  private lastFrame = -1;
  private running = false;
  private channel = new MessageChannel();
  /** Ticks dropped because a frame took too long (spiral-of-death guard). Measured, shown in the net graph. */
  droppedTicks = 0;
  /** Extra speed applied by clock sync to run ahead of / behind the server (1 = real time). */
  timeScale = 1;

  constructor(tickRate: number, private hooks: LoopHooks) {
    this.tickMs = 1000 / tickRate;
    this.channel.port1.onmessage = () => this.frame(performance.now());
  }

  setTickRate(rate: number) { this.tickMs = 1000 / rate; }
  setTick(t: number) { this.tick = t; }
  get currentTick() { return this.tick; }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule();
  }
  stop() { this.running = false; }

  private schedule() {
    if (!this.running) return;
    // rAF is vsync-bound, so a cap above the display rate runs on a MessageChannel loop instead.
    if (this.fpsCap === 0 || this.fpsCap > 75) {
      const gap = this.fpsCap === 0 ? 0 : 1000 / this.fpsCap;
      const wait = this.lastFrame < 0 ? 0 : Math.max(0, this.lastFrame + gap - performance.now());
      if (wait < 1) this.channel.port2.postMessage(0);
      else setTimeout(() => this.frame(performance.now()), wait);
    } else {
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  private frame(now: number) {
    if (!this.running) return;
    const minGap = this.fpsCap === 0 ? 0 : 1000 / this.fpsCap;
    // 1 ms slack so a 60 cap on a 60 Hz display does not skip every other vsync.
    if (this.lastFrame >= 0 && now - this.lastFrame < minGap - 1) { this.schedule(); return; }
    const frameMs = this.lastFrame < 0 ? 0 : now - this.lastFrame;
    this.lastFrame = now;
    if (this.last < 0) this.last = now;
    this.acc += (now - this.last) * this.timeScale;
    this.last = now;
    let steps = 0;
    while (this.acc >= this.tickMs) {
      if (steps >= MAX_STEPS_PER_FRAME) {
        const extra = Math.floor(this.acc / this.tickMs);
        this.droppedTicks += extra;
        this.acc -= extra * this.tickMs;
        break;
      }
      this.tick++;
      this.hooks.onTick(this.tick);
      this.acc -= this.tickMs;
      steps++;
    }
    this.hooks.onRender(this.acc / this.tickMs, frameMs);
    this.schedule();
  }
}

/** Rolling frame-rate meter over the last second of real frames. */
export class FpsMeter {
  private times: number[] = [];
  push(now: number) {
    this.times.push(now);
    while (this.times.length && this.times[0] < now - 1000) this.times.shift();
  }
  get fps() { return this.times.length; }
}
