// Offline unit tests for the convergence-scan pure helpers — no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { topNTickers, tStat } from "./convergence-scan.mjs";
import { etMinutes, filterRegularHours } from "./pattern-study.mjs";

test("etMinutes: epoch → New York local minutes-since-midnight, DST-correct", () => {
  // Summer (EDT, UTC-4): 13:30 UTC = 09:30 ET = 570
  assert.equal(etMinutes(Date.UTC(2026, 5, 12, 13, 30)), 570);
  // Winter (EST, UTC-5): 14:30 UTC = 09:30 ET = 570  (proves DST handling, not a fixed offset)
  assert.equal(etMinutes(Date.UTC(2026, 0, 12, 14, 30)), 570);
  // Summer 19:45 UTC = 15:45 ET = 945 (last regular 15-min bar start)
  assert.equal(etMinutes(Date.UTC(2026, 5, 12, 19, 45)), 945);
});

test("filterRegularHours: keeps 09:30–16:00 ET, drops pre/post-market", () => {
  const mk = (utcH, utcM) => ({ time: Date.UTC(2026, 5, 12, utcH, utcM), close: 1 });
  const bars = [
    mk(8, 0),    // 04:00 ET pre-market   → drop
    mk(13, 30),  // 09:30 ET open         → keep
    mk(17, 0),   // 13:00 ET midday       → keep
    mk(19, 45),  // 15:45 ET last RTH bar → keep
    mk(20, 0),   // 16:00 ET close        → drop (exclusive)
    mk(23, 0),   // 19:00 ET post-market  → drop
  ];
  const kept = filterRegularHours(bars);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept.map(b => etMinutes(b.time)), [570, 780, 945]);
  // bars without an intraday stamp (e.g. daily) are passed through untouched
  assert.deepEqual(filterRegularHours([{ close: 5 }]), [{ close: 5 }]);
});

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
