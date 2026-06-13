// Offline unit tests for the pattern-study harness — no network.
// Pins the two pure helpers: Polygon aggregate parsing and the universe pooling math.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePolygonAggs, aggregate, RESOLUTIONS, parseDividends, dividendsInWindow } from "./pattern-study.mjs";

test("parseDividends: keeps ex-date + positive cash, drops zero/empty payloads", () => {
  const j = { results: [
    { ex_dividend_date: "2024-02-09", cash_amount: 0.24 },
    { ex_dividend_date: "2024-05-10", cash_amount: 0.25 },
    { ex_dividend_date: "2024-08-12", cash_amount: 0 },     // dropped (no cash)
    { cash_amount: 0.25 },                                  // dropped (no ex-date)
  ] };
  assert.deepEqual(parseDividends(j), [
    { exDate: "2024-02-09", cash: 0.24 },
    { exDate: "2024-05-10", cash: 0.25 },
  ]);
  assert.deepEqual(parseDividends({}), []);
  assert.deepEqual(parseDividends({ results: null }), []);
});

test("dividendsInWindow: sums cash with ex-date in (from, to] — excludes the entry day, includes exit", () => {
  const divs = [
    { exDate: "2024-02-09", cash: 0.24 },  // before window → excluded
    { exDate: "2024-05-10", cash: 0.25 },  // inside → included
    { exDate: "2024-08-12", cash: 0.26 },  // on exit date → included
    { exDate: "2024-11-08", cash: 0.27 },  // after window → excluded
  ];
  assert.equal(dividendsInWindow(divs, "2024-02-09", "2024-08-12"), 0.51); // .25 + .26, NOT the entry-day .24
  assert.equal(dividendsInWindow(divs, "2024-09-01", "2024-10-01"), 0);    // none in range
  assert.equal(dividendsInWindow([], "2024-01-01", "2024-12-31"), 0);
  assert.equal(dividendsInWindow(null, "a", "b"), 0);
});

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
  for (const key of ["1min","5min","15min","30min","1hour","1day","1week","1month"]) {
    const r = RESOLUTIONS[key];
    assert.ok(r, key + " missing");
    assert.ok(["minute","hour","day","week","month"].includes(r.span));
    assert.ok(r.mult >= 1 && r.ms > 0);
  }
  assert.deepEqual([RESOLUTIONS["15min"].mult, RESOLUTIONS["15min"].span], [15, "minute"]);
  assert.deepEqual([RESOLUTIONS["1hour"].mult, RESOLUTIONS["1hour"].span], [1, "hour"]);
  // the merit study prices off Polygon monthly bars:
  assert.deepEqual([RESOLUTIONS["1month"].mult, RESOLUTIONS["1month"].span], [1, "month"]);
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
