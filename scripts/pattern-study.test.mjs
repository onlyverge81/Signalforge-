// Offline unit tests for the pattern-study harness — no network.
// Pins the two pure helpers: Stooq CSV parsing and the universe pooling math.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStooq, aggregate } from "./pattern-study.mjs";

test("parseStooq: maps Stooq daily CSV columns to candles", () => {
  const csv = "Date,Open,High,Low,Close,Volume\n"+
              "2025-01-02,100,101,99,100.5,1000000\n"+
              "2025-01-03,100.5,102,100,101.7,1200000\n";
  const rows = parseStooq(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].close, 100.5);
  assert.equal(rows[1].high, 102);
  assert.equal(rows[1].volume, 1200000);
});

test("parseStooq: returns [] on a Stooq error/empty payload", () => {
  assert.deepEqual(parseStooq("N/A"), []);
  assert.deepEqual(parseStooq("<html>blocked</html>"), []);
  assert.deepEqual(parseStooq(""), []);
});

test("aggregate: pools per-ticker results weighted by counts", () => {
  const perTicker = [
    { signals:10, eligibleBars:100, winRate:0.6, avgFwdRet:0.04, baselineAvgFwdRet:0.01, edge:0.03 },
    { signals:30, eligibleBars:300, winRate:0.5, avgFwdRet:0.02, baselineAvgFwdRet:0.01, edge:0.01 },
  ];
  const agg = aggregate(perTicker, 20);
  assert.equal(agg.tickers, 2);
  assert.equal(agg.tickersWithSignals, 2);
  assert.equal(agg.positiveEdgeTickers, 2);
  assert.equal(agg.signals, 40);
  // signal-weighted avg = (0.04*10 + 0.02*30)/40 = 0.025
  assert.ok(Math.abs(agg.avgFwdRet - 0.025) < 1e-9);
  // signal-weighted win = (0.6*10 + 0.5*30)/40 = 0.525
  assert.ok(Math.abs(agg.winRate - 0.525) < 1e-9);
  // baseline weighted by eligibleBars = (0.01*100 + 0.01*300)/400 = 0.01
  assert.ok(Math.abs(agg.baselineAvgFwdRet - 0.01) < 1e-9);
  assert.ok(Math.abs(agg.edge - 0.015) < 1e-9); // 0.025 - 0.01
  assert.equal(agg.horizon, 20);
});

test("aggregate: no-signal tickers contribute baseline but not the signal means", () => {
  const agg = aggregate([{ signals:0, eligibleBars:200, winRate:null, avgFwdRet:null, baselineAvgFwdRet:0.02, edge:null }], 20);
  assert.equal(agg.signals, 0);
  assert.equal(agg.avgFwdRet, null);
  assert.equal(agg.winRate, null);
  assert.equal(agg.edge, null);
  assert.ok(Math.abs(agg.baselineAvgFwdRet - 0.02) < 1e-9);
  assert.equal(agg.tickersWithSignals, 0);
});
