// Offline unit tests for the breadth (show-of-hands) study — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tally, patternHands, expandedVotes, provenVotes, campVotes, setTallies,
  windowedConsensus, bucketByCount, bucketByBins, quorumFrom, volumeTest,
  buildNameRows, VOTE_NAMES, TREND_CAMP, MEANREV_CAMP,
} from "./breadth-study.mjs";

// ─── tally ────────────────────────────────────────────────────────────────────
test("tally counts bull/bear/active/net/ratio over the chosen keys only", () => {
  const votes = { A: 1, B: 1, C: -1, D: 0, E: 1 };
  const t = tally(votes, ["A", "B", "C", "D"]);   // E excluded by key set
  assert.equal(t.bull, 2);
  assert.equal(t.bear, 1);
  assert.equal(t.active, 3);
  assert.equal(t.net, 1);
  assert.ok(Math.abs(t.ratio - 2 / 3) < 1e-9);
});

test("tally with no active hands → ratio null", () => {
  const t = tally({ A: 0, B: 0 }, ["A", "B"]);
  assert.equal(t.active, 0);
  assert.equal(t.ratio, null);
  assert.equal(t.net, 0);
});

// ─── patternHands / expandedVotes ───────────────────────────────────────────────
test("patternHands scores each detected candle pattern as its own ±1 hand", () => {
  // Build a clean Bullish Engulfing (needs ≥3 bars): prior bearish bar fully engulfed by the last bar.
  const data = [
    { open: 10.0, high: 10.5, low: 9.8, close: 10.0, volume: 100 },
    { open: 10.0, high: 10.1, low: 9.4, close: 9.5, volume: 150 },   // bearish (close < open)
    { open: 9.4, high: 10.3, low: 9.3, close: 10.2, volume: 200 },   // bullish, engulfs prior
  ];
  const h = patternHands(data);
  // At least one bullish hand present, valued +1; no key valued 0.
  assert.ok(Object.values(h).some(v => v === 1));
  assert.ok(Object.values(h).every(v => v === 1 || v === -1));
});

test("expandedVotes drops the collapsed Pat vote and adds per-pattern hands", () => {
  const vv = { RSI: 1, Pat: -1, MA: 1 };
  const data = [
    { open: 10.0, high: 10.5, low: 9.8, close: 10.0, volume: 100 },
    { open: 10.0, high: 10.1, low: 9.4, close: 9.5, volume: 150 },
    { open: 9.4, high: 10.3, low: 9.3, close: 10.2, volume: 200 },
  ];
  const e = expandedVotes(vv, data);
  assert.equal(e.Pat, undefined);           // the single collapsed vote is gone
  assert.equal(e.RSI, 1);                    // other votes preserved
  assert.ok(Object.keys(e).length >= 2);
});

// ─── camp votes (SET4 — the two normally-opposed families) ─────────────────────
test("campVotes collapses each family to one direction; agreement → |net|=2", () => {
  // Trend camp all bullish, mean-reversion camp all bullish → both agree (the rare quorum).
  const vv = { MA: 1, MAlong: 1, Trend: 1, MACD: 1, RSI: 1, Stoch: 1, BB: 1 };
  const c = campVotes(vv);
  assert.equal(c.TrendCamp, 1);
  assert.equal(c.MeanRevCamp, 1);
  assert.equal(tally(c, ["TrendCamp", "MeanRevCamp"]).net, 2);   // both witnesses converge
});

test("campVotes when families OPPOSE → net 0 (one camp shouting, not a quorum)", () => {
  const vv = { MA: 1, MAlong: 1, Trend: 1, MACD: 1, RSI: -1, Stoch: -1, BB: -1 };
  const c = campVotes(vv);
  assert.equal(c.TrendCamp, 1);
  assert.equal(c.MeanRevCamp, -1);
  assert.equal(tally(c, ["TrendCamp", "MeanRevCamp"]).net, 0);
});

test("setTallies returns all four SETS with net fields", () => {
  const slice = Array.from({ length: 80 }, (_, i) => ({ open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 }));
  const vv = { RSI: 1, MA: 1, MAlong: 1, Trend: 1, MACD: 1, Stoch: 1, BB: 1, Vol: 1 };
  const t = setTallies(vv, slice);
  for (const k of ["raw13", "expanded", "proven", "camps"]) assert.ok(typeof t[k].net === "number", k + " has a net");
});

// ─── windowedConsensus — no-lookahead / tail-identical ─────────────────────────
test("windowedConsensus counts trailing-D net-bullish bars only", () => {
  const net = [1, -1, 1, 1, 0, 1];   // bars 0..5
  const w = windowedConsensus(net, 5, 4);   // window = bars 2..5: [1,1,0,1] → 3 green of 4
  assert.equal(w.greenBars, 3);
  assert.equal(w.D, 4);
  assert.ok(Math.abs(w.frac - 0.75) < 1e-9);
});

test("windowedConsensus is no-lookahead: appending FUTURE bars cannot change the value at i", () => {
  const base = [1, 1, -1, 1, 1];
  const extended = [...base, 1, -1, 1, 1, 1];   // future bars appended
  const a = windowedConsensus(base, 4, 3);
  const b = windowedConsensus(extended, 4, 3);  // same i, same D → identical (reads only ≤ i)
  assert.deepEqual(a, b);
});

test("windowedConsensus skips null (un-warmed) bars in the denominator", () => {
  const net = [null, null, 1, -1, 1];
  const w = windowedConsensus(net, 4, 5);
  assert.equal(w.D, 3);             // only 3 non-null bars in the window
  assert.equal(w.greenBars, 2);
});

// ─── curves ─────────────────────────────────────────────────────────────────
test("bucketByCount groups by integer net and reports mean/posRate", () => {
  const rows = [
    { key: 2, fwd: 0.01 }, { key: 2, fwd: 0.03 },
    { key: -1, fwd: -0.02 }, { key: -1, fwd: 0.01 },
  ];
  const curve = bucketByCount(rows);
  assert.deepEqual(curve.map(c => c.bucket), [-1, 2]);   // ascending
  const hi = curve.find(c => c.bucket === 2);
  assert.equal(hi.n, 2);
  assert.ok(hi.meanPct > 0);
  assert.equal(hi.posRate, 1);
});

test("bucketByBins partitions by ratio bins, inclusive of the top edge", () => {
  const rows = [
    { val: 0.55, fwd: 0.0 }, { val: 0.7, fwd: 0.02 }, { val: 1.0, fwd: 0.05 },
  ];
  const bins = [0.5, 0.6, 2 / 3, 0.75, 0.9, 1.0001];
  const curve = bucketByBins(rows, bins);
  assert.equal(curve.reduce((a, c) => a + c.n, 0), 3);   // every row placed exactly once
});

test("quorumFrom finds the lowest significant positive ascending bucket", () => {
  const curve = [
    { bucket: -1, n: 50, meanPct: -1, t: -3 },
    { bucket: 0, n: 50, meanPct: 0.1, t: 0.5 },
    { bucket: 2, n: 40, meanPct: 1.2, t: 2.6 },   // first significant positive
    { bucket: 3, n: 30, meanPct: 1.5, t: 3.0 },
  ];
  const q = quorumFrom(curve);
  assert.equal(q.found, true);
  assert.equal(q.at, 2);
});

test("quorumFrom returns not-found when nothing clears t≥2", () => {
  const curve = [{ bucket: 1, n: 50, meanPct: 0.3, t: 1.1 }, { bucket: 2, n: 40, meanPct: 0.4, t: 1.5 }];
  assert.equal(quorumFrom(curve).found, false);
});

// ─── volume test ───────────────────────────────────────────────────────────────
test("volumeTest rules volume OUT when high/low RVOL means are indistinguishable", () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push({ key: 3, fwd: 0.01, rvol: i % 2 ? 2.0 : 0.5 });  // identical means
  const v = volumeTest(rows, { hiKey: 2 });
  assert.ok(v.verdict.startsWith("VOLUME RULED OUT"));
});

test("volumeTest is INCONCLUSIVE when a leg is thin", () => {
  const rows = [{ key: 3, fwd: 0.01, rvol: 2.0 }, { key: 3, fwd: 0.02, rvol: 0.5 }];
  assert.ok(volumeTest(rows, { hiKey: 2 }).verdict.startsWith("INCONCLUSIVE"));
});

// ─── buildNameRows — integration, no-lookahead emission ────────────────────────
test("buildNameRows emits decision rows per set×horizon with finite forward returns", () => {
  // 200 synthetic bars (a gentle drift) — enough to warm votes + windows + a 10-bar forward.
  const series = Array.from({ length: 200 }, (_, i) => {
    const c = 100 + i * 0.2 + Math.sin(i / 7) * 2;
    return { t: i, open: c - 0.3, high: c + 0.6, low: c - 0.6, close: c, volume: 1000 + (i % 5) * 100 };
  });
  const rows = buildNameRows(series);
  assert.ok(rows["raw13_5"].length > 0);
  assert.ok(rows["camps_5"].length > 0);
  for (const r of rows["raw13_5"]) {
    assert.ok(r.fwd != null && isFinite(r.fwd));
    assert.ok(r.rvol === null || isFinite(r.rvol));
  }
});

test("buildNameRows windowFrac at a bar is unaffected by appending future bars (no-lookahead)", () => {
  const mk = n => Array.from({ length: n }, (_, i) => {
    const c = 100 + i * 0.15 + Math.cos(i / 5) * 1.5;
    return { t: i, open: c - 0.2, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 + (i % 4) * 50 };
  });
  const shortS = mk(140), longS = mk(180);
  const a = buildNameRows(shortS)["raw13_5"];
  const b = buildNameRows(longS)["raw13_5"];
  // The decision rows present in BOTH (same leading bars) must share key/windowFrac — features read only ≤ i.
  const m = Math.min(a.length, b.length);
  for (let i = 0; i < m - 10; i++) {       // drop the tail where the short series ran out of forward bars
    assert.equal(a[i].key, b[i].key);
    assert.equal(a[i].windowFrac, b[i].windowFrac);
  }
});

test("the camp keys partition the trend and mean-reversion families correctly", () => {
  assert.deepEqual(TREND_CAMP, ["MA", "MAlong", "Trend", "MACD"]);
  assert.deepEqual(MEANREV_CAMP, ["RSI", "Stoch", "BB"]);
  assert.ok(VOTE_NAMES.includes("Pat"));   // Pat is in the raw 13 but excluded from both camps
});
