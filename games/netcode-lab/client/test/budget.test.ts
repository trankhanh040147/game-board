import { test } from "node:test";
import assert from "node:assert/strict";
import { segments, total, complete, rollingMean, withinTolerance, ClockSync, ArrivalHist } from "../src/hud/budgetCalc.ts";

const shot = { shotSeq: 7, clickMs: 1000, sentMs: 1012, recvMs: 1033, tickStartMs: 1040, snapSentMs: 1070, targetRecvMs: 1092, targetInterpMs: 95, targetFrameMs: 1195 };

test("segments partition click → target frame exactly", () => {
  const s = segments(shot);
  assert.deepEqual(s, { shooterFrame: 12, uplink: 21, tickWait: 7, snapshotWait: 30, downlink: 22, interp: 95, targetFrame: 8 });
  assert.equal(total(s), shot.targetFrameMs - shot.clickMs);
});

test("a shot without the target half is partial and left out of the rolling mean", () => {
  const miss = segments({ ...shot, targetRecvMs: undefined, targetInterpMs: undefined, targetFrameMs: undefined });
  assert.equal(complete(miss), false);
  assert.equal(total(miss), null);
  const r = rollingMean([miss, segments(shot)]);
  assert.equal(r?.count, 1);
  assert.equal(r?.mean.uplink, 21);
});

test("rolling mean keeps the last 20 complete shots", () => {
  const all = Array.from({ length: 30 }, (_, i) => segments({ ...shot, sentMs: shot.clickMs + i }));
  const r = rollingMean(all)!;
  assert.equal(r.count, 20);
  assert.equal(r.mean.shooterFrame, (10 + 29) / 2);
});

test("tolerance: 15% of the formula with a 3 ms floor", () => {
  assert.equal(withinTolerance(100, 114), true);
  assert.equal(withinTolerance(100, 116), false);
  assert.equal(withinTolerance(4, 6.9), true);
});

test("clock sync takes the median offset of the lowest-RTT half", () => {
  const c = new ClockSync();
  // server clock = local + 500; one-way 20 ms; one sample with a 200 ms queueing spike
  c.add(0, 520, 520, 40); c.add(100, 620, 620, 140); c.add(200, 720, 720, 440); c.add(300, 820, 820, 340);
  assert.equal(c.offsetMs, 500);
  assert.equal(c.toServer(1000), 1500);
});

test("arrival histogram counts stalls beyond 3× the interval", () => {
  const h = new ArrivalHist(50);
  for (const t of [0, 50, 100, 150, 400, 450]) h.add(t);
  assert.equal(h.gaps, 5);
  assert.equal(h.stalls, 1);
  assert.equal(h.maxGap, 250);
});
