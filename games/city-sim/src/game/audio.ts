import { GameEventType } from "./events";

/**
 * Synthesized WebAudio sound effects for city actions and events.
 * Off by default until the user's first click; supports explicit mute toggle.
 */
class SoundController {
  private ctx: AudioContext | null = null;
  private hasInteracted = false;
  private muted = true; // Off by default until first click or manual unmute
  private autoEnabledOnFirstClick = false;

  public isMuted(): boolean {
    return this.muted || !this.hasInteracted;
  }

  public unlockOnFirstClick(): boolean {
    if (!this.hasInteracted) {
      this.hasInteracted = true;
      if (!this.autoEnabledOnFirstClick) {
        this.autoEnabledOnFirstClick = true;
        this.muted = false;
      }
      this.ensureContext();
      return true;
    }
    return false;
  }

  public toggleMute(): boolean {
    this.hasInteracted = true;
    this.autoEnabledOnFirstClick = true;
    this.muted = !this.muted;
    if (!this.muted) {
      this.ensureContext();
      this.playTone(523.25, 0.06, "sine", 0.07);
    }
    return this.muted;
  }

  public setMuted(mute: boolean): void {
    this.hasInteracted = true;
    this.autoEnabledOnFirstClick = true;
    this.muted = mute;
    if (!this.muted) {
      this.ensureContext();
    }
  }

  private ensureContext(): AudioContext | null {
    if (typeof window === "undefined") return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return null;
      try {
        this.ctx = new AudioCtx();
      } catch {
        return null;
      }
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private playTone(
    freq: number,
    durationSec: number,
    type: OscillatorType = "sine",
    gainPeak: number = 0.08,
    delaySec: number = 0,
    endFreq?: number,
  ): void {
    if (this.muted || !this.hasInteracted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;

    try {
      const now = ctx.currentTime + delaySec;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = type;
      osc.frequency.setValueAtTime(freq, now);
      if (endFreq && endFreq > 0) {
        osc.frequency.exponentialRampToValueAtTime(endFreq, now + durationSec);
      }

      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.linearRampToValueAtTime(gainPeak, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationSec);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(now);
      osc.stop(now + durationSec + 0.01);
    } catch {
      // Ignore audio errors in headless environments
    }
  }

  public playForEvent(type: GameEventType, kind?: string): void {
    if (this.muted || !this.hasInteracted) return;

    switch (type) {
      case "placed":
        if (kind === "bulldoze") {
          this.playTone(240, 0.09, "triangle", 0.08, 0, 130);
        } else if (kind === "road") {
          this.playTone(310, 0.055, "triangle", 0.07, 0, 370);
        } else {
          this.playTone(392, 0.065, "sine", 0.075, 0, 493.88);
        }
        break;

      case "built":
        this.playTone(440, 0.07, "triangle", 0.07, 0, 523.25);
        this.playTone(587.33, 0.09, "sine", 0.07, 0.055);
        break;

      case "grown":
        this.playTone(523.25, 0.07, "sine", 0.065, 0);
        this.playTone(659.25, 0.08, "sine", 0.065, 0.055);
        this.playTone(783.99, 0.11, "triangle", 0.07, 0.11);
        break;

      case "garden planted":
      case "garden_planted":
        this.playTone(587.33, 0.08, "sine", 0.075, 0);
        this.playTone(739.99, 0.09, "sine", 0.075, 0.05);
        this.playTone(880, 0.14, "triangle", 0.08, 0.1);
        break;

      case "milestone":
        this.playTone(523.25, 0.1, "triangle", 0.09, 0);
        this.playTone(659.25, 0.1, "triangle", 0.09, 0.08);
        this.playTone(783.99, 0.12, "triangle", 0.09, 0.16);
        this.playTone(1046.5, 0.24, "sine", 0.1, 0.24);
        break;

      case "green_city":
        this.playTone(493.88, 0.1, "sine", 0.08, 0);
        this.playTone(659.25, 0.12, "sine", 0.08, 0.07);
        this.playTone(987.77, 0.18, "triangle", 0.08, 0.14);
        break;

      case "traffic_jam":
        this.playTone(220, 0.08, "sawtooth", 0.045, 0, 195);
        this.playTone(205, 0.1, "sawtooth", 0.045, 0.1, 175);
        break;

      case "income":
        this.playTone(880, 0.05, "sine", 0.045, 0);
        this.playTone(1174.66, 0.07, "sine", 0.045, 0.045);
        break;

      case "undo":
        this.playTone(420, 0.06, "sine", 0.07, 0, 290);
        break;

      default:
        break;
    }
  }
}

export const soundController = new SoundController();
