import type { CourtyardMap } from "../render/map";
import { TEAM_COLOR } from "../render/scene";

// Presenter / spectator view (B.7): a top-down Courtyard with the "three truths" per player.
// Every mark comes from real data this browser holds; what it cannot know is labelled "needs server".

export interface PlayerMark { id: number; team: number; x: number; z: number }
export interface Frame {
  t: number;                        // performance.now()
  simNote: string;                  // A.16: ", incl. simulated N ms downlink" when the conditioner is on
  serverNowMs: number | null;       // synced server clock
  renderServerMs: number | null;    // the moment others are drawn at
  truth: PlayerMark[] | null;       // debug feed (server's current state); null while truthGhost is off
  truthTick: number | null;
  drawn: PlayerMark[];              // others as this client draws them (interpolated or raw)
  own: { id: number; team: number; x: number; z: number; yaw: number } | null; // this client's predicted self
  ownServer: { x: number; z: number } | null;   // newest server state of self (snapshot)
}

const HISTORY_MS = 2000;
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const teamHex = (t: number) => hex(t === 1 ? TEAM_COLOR.orange : TEAM_COLOR.blue);

export class PresenterView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private info: HTMLElement;
  private frames: Frame[] = [];
  open = false;
  paused = false;
  private cursor = 0; // index into frames while paused
  onToggle?: (open: boolean) => void;

  constructor(parent: HTMLElement, private map: CourtyardMap) {
    this.root = document.createElement("div");
    this.root.id = "presenter";
    this.root.innerHTML = `<header><b>Presenter view</b> <span class="dim">(F2) · top-down Courtyard · Space pause · ← → step one frame</span></header>`;
    this.canvas = document.createElement("canvas");
    this.info = document.createElement("div");
    this.info.className = "pinfo";
    this.root.append(this.canvas, this.info);
    parent.appendChild(this.root);
    addEventListener("keydown", (e) => {
      if (e.code === "F2") { e.preventDefault(); this.toggle(); return; }
      if (!this.open) return;
      if (e.code === "Space") { e.preventDefault(); this.paused = !this.paused; this.cursor = this.frames.length - 1; }
      if (this.paused && e.code === "ArrowLeft") this.cursor = Math.max(0, this.cursor - 1);
      if (this.paused && e.code === "ArrowRight") this.cursor = Math.min(this.frames.length - 1, this.cursor + 1);
    });
  }

  toggle(force?: boolean) {
    this.open = force ?? !this.open;
    this.root.classList.toggle("open", this.open);
    if (!this.open) this.paused = false;
    this.onToggle?.(this.open);
  }

  record(f: Frame) {
    if (this.paused) return; // keep the recorded 2 s frozen while stepping
    this.frames.push(f);
    while (this.frames.length && this.frames[0].t < f.t - HISTORY_MS) this.frames.shift();
  }

  draw() {
    if (!this.open || !this.frames.length) return;
    const f = this.paused ? this.frames[this.cursor] : this.frames[this.frames.length - 1];
    const dpr = Math.min(devicePixelRatio, 2);
    const W = this.canvas.clientWidth, H = this.canvas.clientHeight;
    if (this.canvas.width !== Math.round(W * dpr) || this.canvas.height !== Math.round(H * dpr)) { this.canvas.width = Math.round(W * dpr); this.canvas.height = Math.round(H * dpr); }
    const g = this.canvas.getContext("2d")!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const floor = this.map.boxes.find((b) => b.id === "floor")!;
    const mw = floor.max[0] - floor.min[0] + 4, mh = floor.max[2] - floor.min[2] + 4;
    const s = Math.min(W / mw, H / mh);
    // Blue spawn (+Z) at the bottom, as the Blue team sees the map.
    const px = (x: number) => W / 2 + x * s, pz = (z: number) => H / 2 + z * s;
    g.fillStyle = "#1c1f26"; g.fillRect(px(floor.min[0]), pz(floor.min[2]), (floor.max[0] - floor.min[0]) * s, (floor.max[2] - floor.min[2]) * s);
    for (const b of this.map.boxes) {
      if (b.id === "floor") continue;
      g.fillStyle = b.id === "low-wall" ? "#6b7280" : b.id.startsWith("crate") ? "#b45309" : "#9ca3af";
      g.fillRect(px(b.min[0]), pz(b.min[2]), (b.max[0] - b.min[0]) * s, (b.max[2] - b.min[2]) * s);
    }
    for (const team of ["blue", "orange"] as const) for (const sp of this.map.spawns[team]) {
      g.strokeStyle = hex(TEAM_COLOR[team]); g.globalAlpha = 0.25; g.beginPath(); g.arc(px(sp[0]), pz(sp[2]), 0.6 * s, 0, 7); g.stroke(); g.globalAlpha = 1;
    }
    const r = Math.max(7, 0.5 * s);
    const lines: string[] = [];
    const truthById = new Map((f.truth ?? []).map((p) => [p.id, p]));
    const cm = (a: { x: number; z: number }, b: { x: number; z: number }) => (Math.hypot(a.x - b.x, a.z - b.z) * 100).toFixed(0);

    for (const d of f.drawn) {
      const t = truthById.get(d.id);
      if (t) { g.strokeStyle = "#e5e7eb"; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(px(d.x), pz(d.z)); g.lineTo(px(t.x), pz(t.z)); g.stroke(); g.setLineDash([]); }
      g.strokeStyle = teamHex(d.team); g.lineWidth = 2; g.beginPath(); g.arc(px(d.x), pz(d.z), r, 0, 7); g.stroke(); g.lineWidth = 1;
      lines.push(`player ${d.id}: drawn here (interpolated) ${t ? `· server truth is ${cm(d, t)} cm ahead` : ""} · their own prediction: <span class="dim">needs server</span>`);
    }
    if (f.truth) for (const t of f.truth) {
      g.fillStyle = teamHex(t.team); g.beginPath(); g.arc(px(t.x), pz(t.z), r * 0.7, 0, 7); g.fill();
    }
    if (f.own) {
      const o = f.own;
      if (f.ownServer) { g.strokeStyle = "#fbbf24"; g.beginPath(); g.moveTo(px(o.x), pz(o.z)); g.lineTo(px(f.ownServer.x), pz(f.ownServer.z)); g.stroke(); }
      g.fillStyle = "#fbbf24"; g.save(); g.translate(px(o.x), pz(o.z)); g.rotate(-o.yaw);
      g.beginPath(); g.moveTo(0, -r * 1.6); g.lineTo(r, r); g.lineTo(-r, r); g.closePath(); g.fill(); g.restore();
      const t = truthById.get(o.id);
      lines.unshift(`you (player ${o.id}): predicted ▲ ${f.ownServer ? `· last snapshot of you is ${cm(o, f.ownServer)} cm behind` : ""}${t ? ` · server truth ${cm(o, t)} cm away` : ""}`);
    }
    const age = f.serverNowMs !== null && f.renderServerMs !== null ? f.serverNowMs - f.renderServerMs : null;
    const head = [
      `<b>${this.paused ? `PAUSED · frame ${this.cursor + 1}/${this.frames.length} · ${(f.t - this.frames[this.frames.length - 1].t).toFixed(0)} ms` : "live"}</b>`,
      `<span class="dim">Legend:</span> ● server truth (debug feed${f.truthTick ? `, tick ${f.truthTick}` : ""}) · ○ drawn by this client${age !== null ? ` (${age.toFixed(0)} ms in the past, measured${f.simNote})` : ""} · ▲ your prediction · <span style="color:#fbbf24">—</span> to your last server state`,
    ];
    if (!f.truth) head.push(`<span class="warn">Server truth hidden:</span> turn on truthGhost in the Lab (the server sends positions only then).`);
    head.push(`<span class="dim">Pause/step replays the last 2 s recorded by this browser; the server-side 2 s ring buffer (B.7) needs server.</span>`);
    this.info.innerHTML = head.concat(lines).join("<br>");
  }
}
