// Offline unit tests for the convergence-scan pure helpers — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { topNTickers, tStat } from "./convergence-scan.mjs";

test("topNTickers: takes the first N of the dollar-volume-ranked universe", () => {
  const u = { tickers: ["A", "B", "C", "D", "E"] };
  assert.deepEqual(topNTickers(u, 3), ["A", "B", "C"]);
  assert.deepEqual(topNTickers(u, 99), ["A", "B", "C", "D", "E"]); // fewer than N → all
  assert.deepEqual(topNTickers({}, 5), []);                        // no tickers → empty
  assert.deepEqual(topNTickers(u, 0), []);
});

test("tStat: cross-sectional significance of a per-ticker edge series", () => {
  // a consistently positive small edge → large positive t
  const pos = tStat([0.01, 0.012, 0.009, 0.011, 0.010]);
  assert.equal(pos.n, 5);
  assert.ok(pos.t > 5, "tightly clustered positive edges should be strongly significant");
  // edges centered on zero → t near zero
  const noise = tStat([0.02, -0.02, 0.01, -0.01, 0.0]);
  assert.ok(Math.abs(noise.t) < 1, "symmetric noise should not look significant");
  // guards
  assert.equal(tStat([0.5]).t, null); // n<2
  assert.equal(tStat([]).t, null);
  assert.equal(tStat([1, 1, 1]).t, null); // zero variance → undefined t, not Infinity
});
