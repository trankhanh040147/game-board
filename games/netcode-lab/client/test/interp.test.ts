import { test } from "node:test";
import assert from "node:assert/strict";
import { InterpBuffer, lerpAngle } from "../src/game/interp.ts";

const e = (x: number) => new Map([[1, { x, y: 0, z: 0, yaw: 0, alive: true }]]);

test("interpolates between the two snapshots around render time", () => {
  const b = new InterpBuffer();
  b.push(0, 1000, e(0));
  b.push(50, 1050, e(5));
  const s = b.sample(25)!;
  assert.equal(s.held, false);
  assert.equal(s.entities.get(1)!.x, 2.5);
});

test("holds at the newest snapshot when render time passes it (raw-mode stepping)", () => {
  const b = new InterpBuffer();
  b.push(0, 1000, e(0));
  b.push(50, 1050, e(5));
  const s = b.sample(70)!;
  assert.equal(s.held, true);
  assert.equal(s.entities.get(1)!.x, 5);
});

test("arrival clock follows the least-delayed snapshot, ignoring a jittered one", () => {
  const b = new InterpBuffer();
  b.push(0, 1020, e(0));   // 20 ms downlink
  b.push(50, 1090, e(1));  // 20 ms late (jitter)
  b.push(100, 1120, e(2));
  assert.equal(b.arrivalServerMs(1120), 100);
});

test("drops stale and duplicate snapshots", () => {
  const b = new InterpBuffer();
  b.push(50, 1000, e(5));
  b.push(50, 1001, e(9));
  b.push(0, 1002, e(0));
  assert.equal(b.latest()!.entities.get(1)!.x, 5);
});

test("yaw takes the short way round", () => {
  const v = lerpAngle(3.0, -3.0, 0.5);
  assert.ok(Math.abs(Math.abs(v) - Math.PI) < 0.01, String(v));
});

test("render time before the oldest snapshot holds at the oldest (single snapshot buffered)", () => {
  const b = new InterpBuffer();
  b.push(100, 1000, e(7));
  const s = b.sample(0)!;
  assert.equal(s.held, true);
  assert.equal(s.entities.get(1)!.x, 7);
  b.push(150, 1050, e(9));
  assert.equal(b.sample(50)!.entities.get(1)!.x, 7);
});
