import type { NetcodeSim, SimState, Snapshot, Debug, Pong } from "./wasm";
import type { Transport } from "./transport";
import type { InputIntent } from "../game/input";
import { InterpBuffer, type EntitySample } from "../game/interp";
import type { LabBackend } from "../hud/lab";
import type { SnapEvent, RoundMsg, ScoreRow, KillMsg, ClaimRejectedMsg, HistoryMsg, DebugPosData } from "../game/events";

export interface SupportedSetting { key: string; kind: string; allowed?: unknown[]; min?: number; max?: number; built: boolean; note?: string }
export interface PresetDesc { id: string; title: string; section: string; banner?: string; built: boolean }
export interface CondDir { delayMs: number; jitterMs: number; lossPct: number; dupPct: number; reorderPct: number }

const PING_MS = 250;
const CORRECTION_TAU_MS = 80;
export const LOSS_WINDOW_S = 10;

/** One connected game session: clock sync, paced inputs, prediction/reconciliation via WASM, snapshot buffer. */
export class Session implements LabBackend {
  connected = true;
  closedReason = "";
  id = -1;
  team: "blue" | "orange" = "blue";
  name = "";
  settings: Record<string, any> | null = null;
  supported: SupportedSetting[] = [];
  presets: PresetDesc[] = [];
  builtPresets = new Set<string>();
  activePreset: string | null = null;
  banner = "";
  cond: { up: CondDir; down: CondDir } | null = null;
  players = new Map<number, { name: string; team: string }>();
  serverStats: any = null;
  lastError = "";
  onChange: () => void = () => {};
  /** Server-confirmed snapshot events (shot/damage/death), each delivered once (the server resends until acked). */
  onSnapEvent: (e: SnapEvent, now: number) => void = () => {};
  onKill: (m: KillMsg, now: number) => void = () => {};
  onClaimRejected: (m: ClaimRejectedMsg, now: number) => void = () => {};
  onHistory: (m: HistoryMsg) => void = () => {};
  round: RoundMsg | null = null;
  /** P25: the last glitch the server announced (name and explain come from the server). */
  /** Fill bots (bots' fill.go): running count, whether the server can start them, last error. */
  fill: { bots: number; enabled: boolean; error: string } | null = null;
  glitch: { kind: string; name: string; explain: string; on?: boolean; ms?: number; at: number } | null = null;
  scoreRows: ScoreRow[] | null = null;
  /** Snapshot events the codec did not know (counted, never dropped silently). */
  unknownEvents = 0;
  private seenShots = new Set<number>();
  private seenDamage = new Set<string>();
  private seenLife = 0;
  private deathLives = new Set<number>();
  spectator = false;
  life = 0;
  dead = false;
  private welcomed = false;
  /** Spectators: each player's own view, relayed by the server while truthGhost is on (B.7 three truths). */
  readonly debugFrom = new Map<number, { at: number; data: DebugPosData }>();
  /** Client-measured numbers for the 1 Hz report (scoreboard ping/loss/FPS); set by the page. */
  reportSource: () => { fps: number } = () => ({ fps: 0 });
  /** Data for the debugpos relay (own predicted + others as drawn); set by the page. */
  debugSource: (() => DebugPosData | null) | null = null;
  private lastReport = 0;
  private lastDebug = 0;
  /** The server placed us (join; respawn in M4): the view takes the server's yaw/pitch. */
  onSpawn: (yaw: number, pitch: number) => void = () => {};

  readonly interp = new InterpBuffer();
  ghost: Debug | null = null;
  ownServer: SimState | null = null;
  ownInfo: Snapshot["own"] | null = null;
  lastSnapshotTick = 0;
  /** Encoding bits of the newest snapshot (S.ENC) and how many arrived delta-encoded against an acked baseline (P27). */
  lastEncoding = 0;
  deltaSnaps = 0;

  private conn: number;
  private clock: number;
  private pacer: number;
  private pred = 0;
  private seq = 0;
  private prevPred: SimState | null = null;
  private curPred: SimState | null = null;
  private lastTickAt = 0;
  private lastClientTick = 0;
  /** Own predicted state per client tick (last 256), so P24 can say where you were on your screen at the hit tick. */
  readonly ownByTick = new Map<number, SimState>();
  private offset = [0, 0, 0];
  private lastPing = -Infinity;
  lastReplayed = 0;

  // 1 s measurement window
  private win = { at: 0, snaps: 0, up: 0, down: 0, sent: 0, lost: 0, recv: 0, gaps: 0 };
  meas = { snapsPerSec: null as number | null, kbpsUp: null as number | null, kbpsDown: null as number | null, upLossPct: null as number | null, downLossPct: null as number | null, lossWindowS: 0, maxSnapGapMs: 0 };
  private snapGapMax = 0;
  /** Per-second packet counts for the last LOSS_WINDOW_S seconds. Loss at 1% needs a window of hundreds of packets;
   *  one second holds only ~20 snapshots, where a single drop reads 5% and most seconds read 0%. */
  private lossWin: { sent: number; lost: number; recv: number; gaps: number }[] = [];
  private lastSnapAt = 0;

  constructor(readonly sim: NetcodeSim, readonly t: Transport, name: string, spectate = false) {
    this.conn = sim.newConn();
    this.clock = sim.newClock();
    this.pacer = sim.newPacer();
    t.onControl = (m) => this.onControl(m);
    t.onBinary = (b) => this.onBinary(b);
    t.onClose = (r) => { this.connected = false; this.closedReason = r; this.onChange(); };
    t.sendControl(spectate ? { t: "join", name, spectate: true } : { t: "join", name });
    this.win.at = performance.now();
  }

  get tickRate(): number { return this.settings?.tickRate ?? 64; }
  get tickMs(): number { return 1000 / this.tickRate; }
  get ready(): boolean { return this.welcomed && (this.spectator || this.pred !== 0); }
  setting<T>(k: string, fallback: T): T { return (this.settings?.[k] as T) ?? fallback; }
  isBuilt(key: string): boolean { return this.supported.find((s) => s.key === key)?.built ?? false; }

  /** Interpolation buffer in ms from the current settings (interpAuto = k × send interval). */
  get bufferMs(): number {
    const s = this.settings;
    if (!s) return 0;
    return s.interpAuto ? s.interpK * (1000 / s.sendRate) : s.interpMs;
  }

  private onControl(m: any) {
    switch (m.t) {
      case "welcome":
        this.id = m.id; this.name = m.name; this.team = m.team;
        this.applySettings(m.settings, m.presetId, m.banner);
        this.supported = m.supportedSettings ?? [];
        this.presets = m.presets ?? [];
        this.builtPresets = new Set(this.presets.filter((p) => p.built).map((p) => p.id));
        this.cond = m.cond ?? null;
        this.spectator = !!m.spectator;
        this.life = m.life ?? 0;
        this.seenLife = this.life;
        if (m.round) this.round = m.round;
        if (!this.spectator) {
          this.pred = this.sim.newPredictor(m.spawn);
          this.curPred = this.prevPred = m.spawn;
          this.onSpawn(this.sim.angleToRadians(m.spawn.yaw), this.sim.angleToRadians(m.spawn.pitch));
        }
        this.welcomed = true;
        break;
      case "players":
        this.players = new Map((m.players ?? []).map((p: any) => [p.id, { name: p.name, team: p.team }]));
        break;
      case "settings":
        this.applySettings(m.settings, m.presetId, m.banner);
        this.lastError = ""; // a successful Lab change clears the previous refusal
        break;
      case "cond": this.cond = m.cond; break;
      case "stats": this.serverStats = m; break;
      case "round": this.round = m; break;
      case "scoreboard": this.scoreRows = m.players; this.round = { t: "round", no: m.no, state: m.state, endsAtServerMs: m.endsAtServerMs, scores: m.scores }; break;
      case "kill": this.onKill(m, performance.now()); break;
      case "claimRejected": this.onClaimRejected(m, performance.now()); break;
      case "history": this.onHistory(m); break;
      case "fill": this.fill = { bots: m.bots ?? 0, enabled: !!m.enabled, error: m.error ?? "" }; break;
      case "presetPage": this.lastError = `${m.id} runs on its own page: ${m.page}`; break;
      case "glitch": this.glitch = { kind: m.kind, name: m.name, explain: m.explain, on: m.on, ms: m.ms, at: performance.now() }; break;
      case "debugpos": if (m.data?.own) this.debugFrom.set(m.from, { at: performance.now(), data: m.data }); break;
      case "error": this.lastError = m.msg; break;
    }
    this.onChange();
  }

  /** Predictor corrections at the last settings change: the HUD counts from there, so each preset starts at 0. */
  correctionsBase = 0;
  settingsEpoch = 0;

  private applySettings(s: Record<string, any>, presetId: string | null | undefined, banner: string | undefined) {
    const prevTick = this.settings?.tickRate;
    if (this.pred) this.correctionsBase = this.sim.predictorInfo(this.pred).corrections;
    this.settingsEpoch++;
    this.settings = s;
    this.activePreset = presetId || null;
    this.banner = banner ?? "";
    if (!s.truthGhost) this.ghost = null;
    if (prevTick && prevTick !== s.tickRate) this.interp.clear();
  }

  private onBinary(b: Uint8Array) {
    const now = performance.now();
    const msg = this.sim.decode(this.conn, b, now);
    if (msg.dup) return;
    if (msg.type === "pong") this.sim.clockPong(this.clock, msg as Pong, now);
    else if (msg.type === "snapshot") this.onSnapshot(msg, now);
    else if (msg.type === "debug") this.ghost = msg;
    else if (msg.type === "invalid") this.lastError = `bad packet: ${msg.error}`;
  }

  private onSnapshot(s: Snapshot, now: number) {
    if (this.lastSnapAt) this.snapGapMax = Math.max(this.snapGapMax, now - this.lastSnapAt);
    this.lastSnapAt = now;
    this.win.snaps++;
    this.lastSnapshotTick = s.serverTick;
    this.lastEncoding = s.encoding;
    if (s.encoding & this.sim.ENC.delta) this.deltaSnaps++;
    this.ownServer = s.own.state;
    this.ownInfo = s.own;
    // Lead mode (core 0b4e1af): the smallest arrival lead since the last snapshot; 127 = no input arrived (ignored).
    this.sim.pacerFeedback(this.pacer, s.own.starved, now, s.own.inputLead);
    this.dead = s.own.dead;
    if (this.pred && (s.lastProcessedInputSeq > 0 || s.own.life !== this.life)) {
      const replay = this.setting("reconcile", true);
      const r = this.sim.reconcile(this.pred, s.own.state, s.lastProcessedInputSeq, this.sim.dtForRate(this.tickRate), replay, s.own.life, s.own.dead);
      this.lastReplayed = r.replayed;
      if (r.respawned || s.own.life !== this.life) {
        // A new life: the server placed us at a spawn. Jump there, no blending, and take the spawn's view direction.
        this.life = s.own.life;
        this.offset = [0, 0, 0];
        this.prevPred = this.curPred = r.state;
        this.onSpawn(this.sim.angleToRadians(s.own.state.yaw), this.sim.angleToRadians(s.own.state.pitch));
      } else if (replay) {
        // Same rules give delta 0; a real correction is blended out over a few frames (A.7) instead of a hard jump.
        if (r.corrected) for (let i = 0; i < 3; i++) this.offset[i] += r.delta[i] / this.sim.FX;
        if (this.prevPred) this.prevPred = { ...this.prevPred, x: this.prevPred.x - r.delta[0], y: this.prevPred.y - r.delta[1], z: this.prevPred.z - r.delta[2] };
      } else {
        this.offset = [0, 0, 0];
        this.prevPred = r.state; // hard snap: the P04 view
      }
      this.curPred = r.state;
    }
    if (this.spectator) this.ownServer = null;
    const ents = new Map<number, EntitySample & { team: number; moving: boolean }>();
    const F = this.sim.FX;
    for (const e of s.entities) {
      ents.set(e.id, { x: e.x / F, y: e.y / F, z: e.z / F, yaw: this.sim.angleToRadians(e.yaw), alive: (e.anim & this.sim.ANIM.dead) === 0, team: e.team, moving: (e.anim & this.sim.ANIM.moving) !== 0 });
    }
    this.interp.push(s.serverTimeMs, now, ents);
    for (const ev of s.events) {
      if (ev.type === "shot") { if (this.seenShots.has(ev.shotSeq)) continue; this.seenShots.add(ev.shotSeq); }
      else if (ev.type === "damage") { const k = `${ev.shooterId}:${ev.shotSeq}`; if (this.seenDamage.has(k)) continue; this.seenDamage.add(k); }
      else if (ev.type === "death") { if (ev.life <= this.seenLife - 1 || this.deathLives.has(ev.life)) continue; this.deathLives.add(ev.life); }
      else { this.unknownEvents++; continue; }
      this.onSnapEvent(ev, now);
    }
    if (this.seenShots.size > 512) this.seenShots = new Set([...this.seenShots].slice(-256));
    if (this.seenDamage.size > 512) this.seenDamage = new Set([...this.seenDamage].slice(-256));
    // v3: ack the snapshot's own id; the server deltas against what we ack (P27).
    this.t.sendBinary(this.sim.encodeSnapshotAck(this.conn, s.snapId, s.serverTick, now));
  }

  /** Called every render frame. Runs the fixed ticks the pacer says are due; never passes frame dt to the sim. */
  frame(now: number, sample: () => InputIntent, onFire: (seq: number, clientTick: number) => { victimId: number; hitbox: number } | null | void) {
    // Ping only after the welcome: the server drops datagrams that arrive before the join is processed, and those
    // unacked pings would count as uplink loss.
    if (this.welcomed && now - this.lastPing >= PING_MS) {
      this.lastPing = now;
      this.t.sendBinary(this.sim.encodePing(this.conn, now));
    }
    this.measure(now);
    if (now - this.lastReport >= 1000 && !this.spectator) {
      this.lastReport = now;
      const e = this.sim.clockEstimate(this.clock, now);
      const loss = this.meas.downLossPct;
      if (e.ready) this.t.sendControl({ t: "report", rttMs: +e.rttMs.toFixed(1), jitterMs: +e.jitterMs.toFixed(1), lossPct: loss === null ? 0 : +loss.toFixed(2), fps: this.reportSource().fps });
    }
    if (this.setting("truthGhost", false) && !this.spectator && this.debugSource && now - this.lastDebug >= 100) {
      this.lastDebug = now;
      const d = this.debugSource();
      if (d) this.t.sendControl({ t: "debugpos", ...d }); // the server relays the whole message as `data`
    }
    if (!this.pred || !this.settings) return;
    const trust = this.setting<string>("authority", "server") === "trust";
    const dt = this.sim.dtForRate(this.tickRate);
    for (const clientTick of this.sim.pacerDue(this.pacer, this.clock, now)) {
      const i = sample();
      const B = this.sim.BTN;
      const buttons = (i.forward ? B.forward : 0) | (i.back ? B.back : 0) | (i.left ? B.left : 0) | (i.right ? B.right : 0) | (i.jump ? B.jump : 0) | (i.fire ? B.fire : 0);
      const cmd: any = { seq: ++this.seq, clientTick, buttons, yaw: this.sim.angleFromRadians(i.yaw), pitch: this.sim.angleFromRadians(i.pitch) };
      let claim: { victimId: number; hitbox: number } | null = null;
      if (i.fire) {
        // v3: stamp what we were drawing at the click, and where in its input tick the click fell (P26 sub-tick).
        const at = i.fireAt ?? now;
        const rt = this.renderServerTick(at);
        if (rt !== null) { cmd.renderTick = Math.floor(rt); cmd.renderFrac = Math.min(65535, Math.floor((rt % 1) * 65536)); }
        cmd.subtickFrac = Math.min(65535, Math.floor(this.inputTickPhase(at) * 65536));
        claim = onFire(cmd.seq, clientTick) || null;
      }
      this.prevPred = this.curPred;
      this.curPred = this.sim.predict(this.pred, cmd, dt);
      this.lastTickAt = now;
      this.lastClientTick = clientTick;
      this.ownByTick.set(clientTick, this.curPred!);
      if (this.ownByTick.size > 256) this.ownByTick.delete(this.ownByTick.keys().next().value!);
      this.t.sendBinary(this.sim.encodeInputFromPredictor(this.conn, this.pred, now));
      if (trust) {
        // A.5 trust mode: the client states its position and its own hit verdicts; the server relays them.
        const p = this.curPred!;
        this.t.sendBinary(this.sim.encodeClaim(this.conn, { seq: cmd.seq, clientTick, x: p.x, y: p.y, z: p.z, victimId: claim?.victimId ?? 0, hitbox: claim?.hitbox ?? 0 }, now));
      }
    }
    const decay = Math.exp(-(now - (this.lastFrame || now)) / CORRECTION_TAU_MS);
    for (let k = 0; k < 3; k++) this.offset[k] *= decay;
    this.lastFrame = now;
  }
  private lastFrame = 0;

  /**
   * How far (in ticks, 0..1) the clock has moved past the moment the newest predicted tick became due. The pacer makes
   * tick T due once serverTick(now) + RTT/2 + margin passes T − 1 (net/clock TargetClientTick), so this is the real
   * accumulator remainder, not "time since the frame that happened to run the tick".
   */
  /** Fraction (0..1) of the pacer's input tick at time t: frac of serverTick(t) + RTT/2 + margin (net/clock). */
  private inputTickPhase(t: number): number {
    const e = this.sim.clockEstimate(this.clock, t);
    if (!e.ready) return 0;
    const x = e.serverTick + (e.rttMs / 2) * (e.tickRate / 1000) + this.sim.pacerInfo(this.pacer).marginTicks;
    return x - Math.floor(x);
  }

  private tickPhase(now: number): number {
    const e = this.sim.clockEstimate(this.clock, now);
    if (!e.ready || !this.lastClientTick) return 1;
    const x = e.serverTick + (e.rttMs / 2) * (e.tickRate / 1000) + this.sim.pacerInfo(this.pacer).marginTicks;
    return Math.min(1, Math.max(0, x - (this.lastClientTick - 1)));
  }

  /** Own eye position in metres for this frame: predicted (and blended) or, with prediction off, the raw server state.
   *  frameMs is the measured frame interval. When a fixed tick is at least as frequent as a frame (64 Hz at 60 FPS)
   *  the newest predicted state is drawn, so input shows in the frame that sampled it. Slower ticks are interpolated
   *  between the last two predicted states ("fix your timestep"), which costs up to one tick of latency. */
  ownView(now: number, frameMs = 1000 / 60): { x: number; y: number; z: number } | null {
    const F = this.sim.FX;
    if (!this.setting("predict", true)) {
      const s = this.ownServer;
      return s ? { x: s.x / F, y: s.y / F, z: s.z / F } : null;
    }
    if (!this.curPred || !this.prevPred) return null;
    const a = this.tickMs <= frameMs * 1.05 ? 1 : this.tickPhase(now);
    const p = this.prevPred, c = this.curPred;
    return {
      x: (p.x + (c.x - p.x) * a) / F + this.offset[0],
      y: (p.y + (c.y - p.y) * a) / F + this.offset[1],
      z: (p.z + (c.z - p.z) * a) / F + this.offset[2],
    };
  }

  clockEstimate(now: number) { return this.sim.clockEstimate(this.clock, now); }

  /** Server time (ms) at which other players are drawn now. Null until a snapshot arrived. */
  renderServerMs(now: number): number | null {
    const arrival = this.interp.arrivalServerMs(now);
    if (arrival === null) return null;
    return this.setting("interp", true) ? arrival - this.bufferMs : arrival;
  }

  private renderServerTick(now: number): number | null {
    const r = this.renderServerMs(now);
    const e = this.sim.clockEstimate(this.clock, now);
    if (r === null || !e.ready) return null;
    return e.serverTick - (e.serverTimeMs - r) / this.tickMs;
  }

  predictorInfo() { return this.pred ? this.sim.predictorInfo(this.pred) : null; }
  pacerInfo() { return this.sim.pacerInfo(this.pacer); }

  private measure(now: number) {
    const dtMs = now - this.win.at;
    if (dtMs < 1000) return;
    const cs = this.sim.connStats(this.conn);
    this.lossWin.push({ sent: cs.sent - this.win.sent, lost: cs.lost - this.win.lost, recv: cs.received - this.win.recv, gaps: cs.remoteGaps - this.win.gaps });
    if (this.lossWin.length > LOSS_WINDOW_S) this.lossWin.shift();
    const sum = this.lossWin.reduce((a, w) => ({ sent: a.sent + w.sent, lost: a.lost + w.lost, recv: a.recv + w.recv, gaps: a.gaps + w.gaps }), { sent: 0, lost: 0, recv: 0, gaps: 0 });
    const dSent = sum.sent, dLost = sum.lost, dRecv = sum.recv, dGaps = Math.max(0, sum.gaps);
    this.meas = {
      snapsPerSec: (this.win.snaps * 1000) / dtMs,
      kbpsUp: ((this.t.bytesUp - this.win.up) * 8) / dtMs,
      kbpsDown: ((this.t.bytesDown - this.win.down) * 8) / dtMs,
      upLossPct: dSent > 0 ? (100 * dLost) / dSent : null,
      downLossPct: dRecv + dGaps > 0 ? (100 * dGaps) / (dRecv + dGaps) : null,
      lossWindowS: this.lossWin.length,
      maxSnapGapMs: this.snapGapMax,
    };
    this.snapGapMax = 0;
    this.win = { at: now, snaps: 0, up: this.t.bytesUp, down: this.t.bytesDown, sent: cs.sent, lost: cs.lost, recv: cs.received, gaps: cs.remoteGaps };
  }

  applyPreset(id: string, token: string) { this.t.sendControl({ t: "preset", token, id }); }
  setSetting(key: string, value: unknown, token: string) { this.t.sendControl({ t: "lab", token, settings: { [key]: value } }); }
  /** P03 "modded client": one forged Claim (type 7) — "I hit <enemy> in the head" from where I stand, through any wall.
   *  The admin token only gates the Lab button; the server judges the claim by authority mode alone. */
  sendForgedClaim(_token: string): string {
    const enemy = [...this.players].find(([id, p]) => id !== this.id && p.team !== this.team && p.team !== "spectator");
    if (!enemy || !this.curPred) return "no enemy player to claim a hit on";
    const p = this.curPred;
    this.t.sendBinary(this.sim.encodeClaim(this.conn, { seq: this.seq, clientTick: this.lastClientTick, x: p.x, y: p.y, z: p.z, victimId: enemy[0], hitbox: this.sim.HIT.head }, performance.now()));
    return `forged headshot claim on ${enemy[1].name} sent`;
  }
  requestHistory() { this.t.sendControl({ t: "history" }); }
  /** Fill bots (admin): n = -1 balances the teams, 0 removes them. */
  sendFill(token: string, n: number) { this.t.sendControl({ t: "fill", token, n }); }
  /** P25 (admin): server-only speed modifier, or a downlink loss burst longer than the interpolation buffer. */
  sendGlitch(token: string, kind: "rubberband" | "lossBurst", opts: { on?: boolean; ms?: number; all?: boolean }) {
    this.t.sendControl({ t: "glitch", token, kind, ...opts });
  }
  setCond(up: Partial<CondDir>, down: Partial<CondDir>) { this.t.sendControl({ t: "cond", up, down }); }
  close() { this.t.close(); }
}
