// Offline unit tests for the pattern-study harness — no network.
// Pins the two pure helpers: Polygon aggregate parsing and the universe pooling math.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolygonAggs, aggregate, RESOLUTIONS } from "./pattern-study.mjs";

test("parsePolygonAggs: maps Polygon aggregate bars to candles (app's polyBars shape)", () => {
  const j = { results: [
    { t: 1704153600000, o:100,   h:101, l:99,  c:100.5, v:1000000 },
    { t: 1704240000000, o:100.5, h:102, l:100, c:101.7, v:1200000 },
  ] };
  const rows = parsePolygonAggs(j);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].close, 100.5);
  assert.equal(rows[1].high, 102);
  assert.equal(rows[1].volume, 1200000);
  assert.match(rows[0].date, /^\d{4}-\d{2}-\d{2}$/);
  // intraday orderability: the epoch-ms bar start is preserved alongside `date`.
  assert.equal(rows[0].time, 1704153600000);
  assert.ok(rows[1].time > rows[0].time);
});

test("RESOLUTIONS: every supported timeframe maps to a Polygon (mult, span) and a period", () => {
  for (const key of ["1min","5min","15min","30min","1hour","1day"]) {
    const r = RESOLUTIONS[key];
    assert.ok(r, key + " missing");
    assert.ok(["minute","hour","day"].includes(r.span));
    assert.ok(r.mult >= 1 && r.ms > 0);
  }
  assert.deepEqual([RESOLUTIONS["15min"].mult, RESOLUTIONS["15min"].span], [15, "minute"]);
  assert.deepEqual([RESOLUTIONS["1hour"].mult, RESOLUTIONS["1hour"].span], [1, "hour"]);
  assert.equal(RESOLUTIONS["5min"].ms, 300000);
});

test("parsePolygonAggs: drops non-positive closes and tolerates an empty payload", () => {
  assert.deepEqual(parsePolygonAggs({}), []);
  assert.deepEqual(parsePolygonAggs({ results: null }), []);
  const rows = parsePolygonAggs({ results: [{ t:1704153600000, o:0, h:0, l:0, c:0, v:0 }] });
  assert.deepEqual(rows, []);
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
