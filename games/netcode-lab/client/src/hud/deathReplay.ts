import type { CourtyardMap } from "../render/map";
import type { DeathEvent, Vec3 } from "../game/events";
import { escapeHtml } from "./combat";

// P24 "died behind the wall": after you die, compare where you were on your own screen at the hit tick with where the
// server rewound you to (what the shooter saw). Your own path comes from this browser's predicted states.

export class DeathReplay {
  private root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private text: HTMLElement;

  constructor(parent: HTMLElement, private map: CourtyardMap) {
    this.root = document.createElement("div");
    this.root.id = "deathreplay";
    this.root.className = "hud box";
    this.canvas = document.createElement("canvas");
    this.canvas.width = 360; this.canvas.height = 170;
    this.text = document.createElement("div");
    this.root.append(this.canvas, this.text);
    this.root.style.display = "none";
    parent.appendChild(this.root);
  }

  hide() { this.root.style.display = "none"; }

  /**
   * path: your own predicted positions for the last ~1 s (oldest first); youAtHit: your predicted position for the
   * hit tick (null when this browser no longer holds it); coverOnYourScreen: whether map geometry blocked the line
   * from the shooter to your head at youAtHit (null when the server sent no shooter position).
   */
  /** used: where the server placed you for the trace (rewound when lag comp was on); shooter: shooter feet. */
  show(e: DeathEvent, killer: string, path: Vec3[], youAtHit: Vec3 | null, used: Vec3, shooter: Vec3, coverOnYourScreen: boolean | null, tickMs: number, historyMs: number, favourMs: number) {
    const pts = [...path, used, shooter, ...(youAtHit ? [youAtHit] : [])];
    let minX = Math.min(...pts.map((p) => p.x)) - 4, maxX = Math.max(...pts.map((p) => p.x)) + 4;
    let minZ = Math.min(...pts.map((p) => p.z)) - 4, maxZ = Math.max(...pts.map((p) => p.z)) + 4;
    const W = this.canvas.width, H = this.canvas.height;
    const s = Math.min(W / (maxX - minX), H / (maxZ - minZ));
    const px = (x: number) => (x - minX) * s, pz = (z: number) => (z - minZ) * s;
    const g = this.canvas.getContext("2d")!;
    g.fillStyle = "#1c1f26"; g.fillRect(0, 0, W, H);
    for (const b of this.map.boxes) {
      if (b.id === "floor") continue;
      g.fillStyle = b.id === "low-wall" ? "#6b7280" : "#9ca3af";
      g.fillRect(px(b.min[0]), pz(b.min[2]), (b.max[0] - b.min[0]) * s, (b.max[2] - b.min[2]) * s);
    }
    g.strokeStyle = "#fbbf24"; g.lineWidth = 2; g.beginPath();
    path.forEach((p, i) => (i ? g.lineTo(px(p.x), pz(p.z)) : g.moveTo(px(p.x), pz(p.z)))); g.stroke();
    const dot = (p: Vec3, c: string, r = 5) => { g.fillStyle = c; g.beginPath(); g.arc(px(p.x), pz(p.z), r, 0, 7); g.fill(); };
    if (youAtHit) dot(youAtHit, "#fbbf24", 6);
    dot(used, "#3b82f6", 6);
    dot(shooter, "#ef4444", 5);
    if (youAtHit) { g.strokeStyle = "rgba(239,68,68,.6)"; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(px(shooter.x), pz(shooter.z)); g.lineTo(px(youAtHit.x), pz(youAtHit.z)); g.stroke(); g.setLineDash([]); }
    const behindMs = (e.resolveTick - (e.rewoundTick + e.rewoundFrac / 65536)) * tickMs;
    const dist = youAtHit ? Math.hypot(youAtHit.x - used.x, youAtHit.z - used.z) : null;
    this.text.innerHTML = [
      `<b>Why you died</b> <span class="dim">(P24, A.10)</span> — killed by ${escapeHtml(killer)} <span style="color:#ef4444">●</span>`,
      `<span style="color:#fbbf24">●</span> you on your screen at the hit (tick ${e.resolveTick})${youAtHit ? "" : " — not in this browser's history"}`,
      e.lagcomp
        ? `<span style="color:#3b82f6">●</span> you as the shooter saw you: the server rewound ${behindMs.toFixed(0)} ms (tick ${e.rewoundTick}${historyMs < 1000 ? `, history cap ${historyMs} ms` : ""})`
        : `<span style="color:#3b82f6">●</span> where the server traced you: no rewind (${favourMs > 0 ? `favour-victim: shooter RTT above ${favourMs} ms, or ` : ""}lag compensation off)`,
      dist !== null ? `Gap between the two: ${(dist * 100).toFixed(0)} cm.` : "",
      coverOnYourScreen === null ? "" : coverOnYourScreen ? `<span class="warn">On your screen you were already behind cover.</span> The shot was fair to the shooter, so it looks unfair to you.` : "On your screen the shooter still had line of sight.",
    ].filter(Boolean).join("<br>");
    this.root.style.display = "";
  }
}
