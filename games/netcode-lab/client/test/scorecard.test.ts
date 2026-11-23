import { test } from "node:test";
import assert from "node:assert/strict";
import { score } from "../src/hud/scorecard.ts";

const all = { mode: "auth" as const, predict: true, reconcile: true, interp: true, lagcomp: true };

test("all green only with every technique on and server authority (P10)", () => {
  const s = score(all);
  assert.deepEqual([s.instant, s.smooth, s.fair, s.cheatProof], ["yes", "yes", "yes", "yes"]);
});
test("dumb client: Instant no, Cheat-proof yes (A.4)", () => {
  const s = score({ ...all, mode: "dumb" });
  assert.equal(s.instant, "no"); assert.equal(s.cheatProof, "yes");
});
test("trust client: Instant and Fair yes, Cheat-proof no (A.5)", () => {
  const s = score({ ...all, mode: "trust", lagcomp: false });
  assert.deepEqual([s.instant, s.fair, s.cheatProof], ["yes", "yes", "no"]);
});
test("prediction without reconciliation is partial", () => {
  assert.equal(score({ ...all, reconcile: false }).instant, "partial");
});
test("each technique off turns its own cell red", () => {
  assert.equal(score({ ...all, interp: false }).smooth, "no");
  assert.equal(score({ ...all, lagcomp: false }).fair, "no");
  assert.equal(score({ ...all, predict: false }).instant, "no");
});
