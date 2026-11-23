// P11/P15/P29 computation (no DOM), shared by hud/perf.ts and test/budget.test.ts.
// Every time here is server-synced ms: each client maps its own clock to the server clock (NTP-style, from pongs).

/** The 7 segments of A.11, in the order and with the keys of the server's `budgetEst` (stats, P15). */
export const SEGMENTS = [
  { key: "shooterFrame", label: "click → input sent (shooter frame)" },
  { key: "uplink", label: "uplink" },
  { key: "tickWait", label: "input playout buffer (waits for its stamped tick)" },
  { key: "snapshotWait", label: "wait for snapshot send" },
  { key: "downlink", label: "downlink to target" },
  { key: "interp", label: "target interpolation" },
  { key: "targetFrame", label: "target frame wait" },
] as const;
export type SegKey = (typeof SEGMENTS)[number]["key"];

/** Timestamps of one shot, all on the server clock (ms). Target fields come later, via shotTrace. */
export interface ShotStamps {
  shotSeq: number;
  clickMs: number;        // click, shooter's clock mapped to server
  sentMs: number;         // the first input packet carrying the fire left the shooter
  recvMs: number;         // ShotResult.recvMs: fire input left the server's uplink conditioner (S2)
  tickStartMs: number;    // ShotResult.tickStartMs: start of the resolving tick (S3)
  snapSentMs: number;     // serverTimeMs of the first snapshot carrying the ShotResult (S4)
  targetRecvMs?: number;  // shotTrace.targetRecvServerMs
  targetInterpMs?: number;
  targetFrameMs?: number; // shotTrace.targetFrameServerMs
}

/** Segment durations of one shot; a segment is null until its data arrived (a miss never gets the target half). */
export function segments(s: ShotStamps): Record<SegKey, number | null> {
  const d = (a: number | undefined, b: number | undefined) => (a === undefined || b === undefined ? null : b - a);
  const interp = s.targetInterpMs ?? null;
  const tail = d(s.targetRecvMs, s.targetFrameMs);
  return {
    shooterFrame: d(s.clickMs, s.sentMs),
    uplink: d(s.sentMs, s.recvMs),
    tickWait: d(s.recvMs, s.tickStartMs),
    snapshotWait: d(s.tickStartMs, s.snapSentMs),
    downlink: d(s.snapSentMs, s.targetRecvMs),
    interp,
    targetFrame: tail === null || interp === null ? null : tail - interp,
  };
}

export function complete(seg: Record<SegKey, number | null>): boolean {
  return SEGMENTS.every((x) => seg[x.key] !== null);
}

export function total(seg: Record<SegKey, number | null>): number | null {
  let t = 0;
  for (const x of SEGMENTS) { const v = seg[x.key]; if (v === null) return null; t += v; }
  return t;
}

/** Mean per segment over the last n complete shots. */
export function rollingMean(all: Record<SegKey, number | null>[], n = 20): { mean: Record<SegKey, number>; count: number } | null {
  const done = all.filter(complete).slice(-n);
  if (!done.length) return null;
  const mean = {} as Record<SegKey, number>;
  for (const x of SEGMENTS) mean[x.key] = done.reduce((a, s) => a + (s[x.key] as number), 0) / done.length;
  return { mean, count: done.length };
}

/** Why the measured value of a segment differs from the A.11 formula (P15). Shown when outside the tolerance. */
export const WHY: Record<SegKey, string> = {
  shooterFrame: "formula: half a frame; measured includes waiting for the 10 shots/s fire cooldown and the pacer's input tick",
  uplink: "formula: the conditioner's one-way delay; measured adds jitter, queueing and clock-sync error (±RTT/2 at worst)",
  tickWait: "by design (DECISIONS 51): the server holds each input until the tick it was stamped for, so this is the input playout buffer (pacer margin of a few ticks); the formula counts only half a tick",
  snapshotWait: "formula: half a send interval; 20/s at 64 Hz alternates 3- and 4-tick gaps, so one shot is 0–62.5 ms",
  downlink: "formula: the conditioner's one-way delay; measured adds jitter and both clients' clock-sync error",
  interp: "formula: the configured buffer; measured is how long until the target's render time reached the shot, minus frame wait",
  targetFrame: "formula: half a frame; measured is how long the shot had been renderable when the target's frame drew it",
};

/** P15 tolerance (B.9 check 4: ±15% of the total). Per segment we flag |diff| > max(15% of formula, 3 ms). */
export function withinTolerance(formula: number, measured: number, pct = 15, floorMs = 3): boolean {
  return Math.abs(measured - formula) <= Math.max((Math.abs(formula) * pct) / 100, floorMs);
}

/** NTP-style clock offset (server − local), median offset of the lowest-RTT half of the last 16 pongs. */
export class ClockSync {
  private samples: { rtt: number; off: number }[] = [];
  add(clientSendMs: number, serverRecvMs: number, serverSendMs: number, clientRecvMs: number) {
    const rtt = clientRecvMs - clientSendMs - (serverSendMs - serverRecvMs);
    const off = (serverRecvMs - clientSendMs + (serverSendMs - clientRecvMs)) / 2;
    if (rtt < 0) return;
    this.samples.push({ rtt, off });
    if (this.samples.length > 16) this.samples.shift();
  }
  get ready(): boolean { return this.samples.length >= 3; }
  get offsetMs(): number | null {
    if (!this.samples.length) return null;
    const best = [...this.samples].sort((a, b) => a.rtt - b.rtt).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
    const offs = best.map((s) => s.off).sort((a, b) => a - b);
    return offs[Math.floor(offs.length / 2)];
  }
  toServer(localMs: number): number | null { const o = this.offsetMs; return o === null ? null : localMs + o; }
}

/** P29: histogram of snapshot inter-arrival gaps (ms), with stalls > 3× the send interval counted. */
export class ArrivalHist {
  readonly edges = [10, 20, 30, 40, 50, 60, 70, 80, 100, 125, 150, 200, 300];
  counts = new Array(this.edges.length + 1).fill(0);
  gaps = 0;
  stalls = 0;
  maxGap = 0;
  private last: number | null = null;
  intervalMs: number;
  constructor(intervalMs: number) { this.intervalMs = intervalMs; }
  add(atMs: number) {
    if (this.last !== null) {
      const g = atMs - this.last;
      let i = this.edges.findIndex((e) => g < e);
      if (i < 0) i = this.edges.length;
      this.counts[i]++;
      this.gaps++;
      if (g > 3 * this.intervalMs) this.stalls++;
      this.maxGap = Math.max(this.maxGap, g);
    }
    this.last = atMs;
  }
}
