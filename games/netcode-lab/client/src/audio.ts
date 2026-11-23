// CC0 sound effects (docs/ASSETS.md). WebAudio needs a user gesture before it can play: call unlock() from Play.

export type SfxName = "rifle_shot" | "hit_marker" | "headshot" | "kill_confirm" | "player_death" | "footstep" | "jump"
  | "ui_click" | "round_start" | "round_end" | "rejected_claim" | "rubber_band_snap";

export class Sfx {
  private ctx: AudioContext | null = null;
  private buffers = new Map<SfxName, AudioBuffer>();
  private loading = new Map<SfxName, Promise<void>>();
  failures: string[] = [];
  volume = 0.5;

  unlock() {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    for (const n of ["rifle_shot", "hit_marker", "headshot", "kill_confirm", "player_death", "round_start", "round_end", "rejected_claim"] as SfxName[]) this.load(n);
  }

  private load(name: SfxName): Promise<void> {
    if (!this.ctx) return Promise.resolve();
    let p = this.loading.get(name);
    if (!p) {
      const ctx = this.ctx;
      p = fetch(`./sfx/${name}.ogg`)
        .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.arrayBuffer(); })
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => { this.buffers.set(name, buf); })
        .catch((e) => { this.failures.push(`sfx/${name}.ogg: ${e.message}`); console.warn(`sound failed, playing silence — sfx/${name}.ogg: ${e.message}`); });
      this.loading.set(name, p);
    }
    return p;
  }

  play(name: SfxName, gain = 1) {
    const ctx = this.ctx;
    if (!ctx) return;
    const buf = this.buffers.get(name);
    if (!buf) { this.load(name); return; } // first use before load finished: skip this one, never block a frame
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = this.volume * gain;
    src.connect(g).connect(ctx.destination);
    src.start();
  }
}
