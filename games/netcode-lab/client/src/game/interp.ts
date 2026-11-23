// Entity interpolation (A.8, A.9). Rendering-side only: it never runs movement rules, it only
// places other players between two server snapshots, or at the latest one in raw mode.

export interface EntitySample { x: number; y: number; z: number; yaw: number; alive: boolean }
interface Snap { serverMs: number; entities: Map<number, EntitySample> }

const KEEP_MS = 1500;
const ARRIVAL_WINDOW_MS = 2000;

export class InterpBuffer {
  private snaps: Snap[] = [];
  /** (serverMs - localRecvMs) samples; the max is the least-delayed arrival line. */
  private offsets: { at: number; off: number }[] = [];

  push(serverMs: number, localRecvMs: number, entities: Map<number, EntitySample>) {
    if (this.snaps.length && serverMs <= this.snaps[this.snaps.length - 1].serverMs) return; // stale or duplicate
    this.snaps.push({ serverMs, entities });
    while (this.snaps.length > 2 && this.snaps[1].serverMs < serverMs - KEEP_MS) this.snaps.shift();
    this.offsets.push({ at: localRecvMs, off: serverMs - localRecvMs });
    while (this.offsets.length && this.offsets[0].at < localRecvMs - ARRIVAL_WINDOW_MS) this.offsets.shift();
  }

  clear() { this.snaps = []; this.offsets = []; }

  /** Server time of the newest snapshot as it would arrive now with no jitter (Source-style client clock). */
  arrivalServerMs(nowLocal: number): number | null {
    if (!this.offsets.length) return null;
    let best = -Infinity;
    for (const o of this.offsets) best = Math.max(best, o.off);
    return nowLocal + best;
  }

  latest(): Snap | null { return this.snaps[this.snaps.length - 1] ?? null; }

  /**
   * Interpolated entities at renderServerMs. If no later snapshot exists yet (buffer too small or a late packet),
   * entities hold at the newest one: that hold is what makes raw mode step.
   */
  sample(renderServerMs: number): { entities: Map<number, EntitySample>; held: boolean } | null {
    const n = this.snaps.length;
    if (!n) return null;
    if (renderServerMs >= this.snaps[n - 1].serverMs) return { entities: this.snaps[n - 1].entities, held: renderServerMs > this.snaps[n - 1].serverMs };
    if (renderServerMs <= this.snaps[0].serverMs) return { entities: this.snaps[0].entities, held: true };
    let i = n - 2;
    while (i > 0 && this.snaps[i].serverMs > renderServerMs) i--;
    const a = this.snaps[i], b = this.snaps[i + 1];
    if (renderServerMs <= a.serverMs) return { entities: a.entities, held: true };
    const t = (renderServerMs - a.serverMs) / (b.serverMs - a.serverMs);
    const out = new Map<number, EntitySample>();
    for (const [id, eb] of b.entities) {
      const ea = a.entities.get(id);
      if (!ea || !ea.alive || !eb.alive) { out.set(id, eb); continue; }
      out.set(id, {
        x: ea.x + (eb.x - ea.x) * t, y: ea.y + (eb.y - ea.y) * t, z: ea.z + (eb.z - ea.z) * t,
        yaw: lerpAngle(ea.yaw, eb.yaw, t), alive: true,
      });
    }
    return { entities: out, held: false };
  }
}

export function lerpAngle(a: number, b: number, t: number) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
