// Offline unit tests for the data-lag probe — pure helpers only, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyFreshness, tsToMs, parseIndexResult, parseStockTicker,
  percentile, aggregate, inferPlan, mergeReport, samplesFromFixture,
  REALTIME_MAX_SEC, DELAYED_MAX_SEC,
} from "./lag-probe.mjs";

test("classifyFreshness bands at the boundaries", () => {
  assert.equal(classifyFreshness({ stalenessSec: 5, isOpen: false }), "CLOSED");
  assert.equal(classifyFreshness({ stalenessSec: 0, isOpen: true }), "REALTIME");
  assert.equal(classifyFreshness({ stalenessSec: REALTIME_MAX_SEC - 1, isOpen: true }), "REALTIME");
  assert.equal(classifyFreshness({ stalenessSec: REALTIME_MAX_SEC, isOpen: true }), "DELAYED");
  assert.equal(classifyFreshness({ stalenessSec: 15 * 60, isOpen: true }), "DELAYED"); // 15-min delayed feed
  assert.equal(classifyFreshness({ stalenessSec: DELAYED_MAX_SEC - 1, isOpen: true }), "DELAYED");
  assert.equal(classifyFreshness({ stalenessSec: DELAYED_MAX_SEC, isOpen: true }), "STALE");
  assert.equal(classifyFreshness({ stalenessSec: null, isOpen: true }), "UNKNOWN");
});

test("tsToMs handles nanoseconds and milliseconds", () => {
  assert.equal(tsToMs(1_700_000_000_000_000_000), 1_700_000_000_000); // ns → ms
  assert.equal(tsToMs(1_700_000_000_000), 1_700_000_000_000);          // already ms
  assert.equal(tsToMs(0), null);
  assert.equal(tsToMs(null), null);
  assert.equal(tsToMs("not a number"), null);
});

test("parseIndexResult: open + fresh tick → REALTIME with live pct", () => {
  const now = 1_700_000_060_000; // 60s after the tick
  const s = parseIndexResult({
    ticker: "I:SPX", value: 5234.18, market_status: "open",
    last_updated: 1_700_000_000_000 * 1e6, // ns
    session: { change_percent: 0.42, close: 5234.18, previous_close: 5212.3 },
  }, now);
  assert.equal(s.symbol, "I:SPX");
  assert.equal(s.venue, "INDEX");
  assert.equal(s.isMarketOpen, true);
  assert.equal(s.stalenessSec, 60);
  assert.equal(s.freshnessBand, "DELAYED"); // exactly 60s → DELAYED (boundary)
  assert.equal(s.pct, 0.42);
  assert.equal(s.value, 5234.18);
});

test("parseIndexResult: closed market → CLOSED regardless of staleness", () => {
  const s = parseIndexResult({
    ticker: "I:DJI", value: 39000, market_status: "closed",
    last_updated: 1_700_000_000_000 * 1e6, session: { change_percent: -0.1 },
  }, 1_700_000_005_000);
  assert.equal(s.freshnessBand, "CLOSED");
  assert.equal(s.isMarketOpen, false);
});

test("parseStockTicker: uses lastTrade.t and market-open flag", () => {
  const now = 1_700_000_010_000; // 10s after the trade
  const s = parseStockTicker({
    ticker: "AAPL", todaysChangePerc: 1.23,
    lastTrade: { p: 195.5, t: 1_700_000_000_000 * 1e6 },
  }, true, now);
  assert.equal(s.symbol, "AAPL");
  assert.equal(s.stalenessSec, 10);
  assert.equal(s.freshnessBand, "REALTIME");
  assert.equal(s.value, 195.5);
  assert.equal(s.pct, 1.23);
});

test("percentile picks the expected order statistic", () => {
  assert.equal(percentile([10, 20, 30, 40], 50), 20);
  assert.equal(percentile([10, 20, 30, 40], 90), 40);
  assert.equal(percentile([], 50), null);
});

test("aggregate summarizes bands and staleness over open samples", () => {
  const samples = [
    { isMarketOpen: true, stalenessSec: 5, freshnessBand: "REALTIME" },
    { isMarketOpen: true, stalenessSec: 900, freshnessBand: "DELAYED" },
    { isMarketOpen: true, stalenessSec: 2000, freshnessBand: "STALE" },
    { isMarketOpen: true, stalenessSec: 15, freshnessBand: "REALTIME" },
  ];
  const a = aggregate(samples, "2026-06-11T18:00:00.000Z");
  assert.equal(a.nSymbols, 4);
  assert.equal(a.marketOpen, true);
  assert.equal(a.pctRealtime, 50);
  assert.equal(a.pctDelayed, 25);
  assert.equal(a.pctStale, 25);
  assert.equal(a.medianStalenessSec, 15);
  assert.equal(a.p90StalenessSec, 2000);
});

test("inferPlan reads the freshest open sample", () => {
  assert.equal(inferPlan([{ isMarketOpen: true, stalenessSec: 8 }]), "real-time (Developer+)");
  assert.equal(inferPlan([{ isMarketOpen: true, stalenessSec: 900 }]), "delayed ~15min (Free/Starter)");
  assert.equal(inferPlan([{ isMarketOpen: false, stalenessSec: 8 }]), "unknown (market closed)");
});

test("mergeReport appends, is idempotent on probedAt, and caps history", () => {
  const agg1 = { probedAt: "t1", pctRealtime: 100 };
  const agg2 = { probedAt: "t2", pctRealtime: 50 };
  let r = mergeReport({ latest: null, history: [] }, agg1, [{ symbol: "AAPL" }]);
  assert.equal(r.history.length, 1);
  assert.equal(r.latest.runAgg.probedAt, "t1");

  r = mergeReport(r, agg2, []);
  assert.equal(r.history.length, 2);

  // Re-running the same probedAt replaces, not duplicates.
  const agg2b = { probedAt: "t2", pctRealtime: 75 };
  r = mergeReport(r, agg2b, []);
  assert.equal(r.history.length, 2);
  assert.equal(r.history[1].pctRealtime, 75);

  // Cap.
  let big = { latest: null, history: Array.from({ length: 200 }, (_, i) => ({ probedAt: "h" + i })) };
  big = mergeReport(big, { probedAt: "new" }, [], 200);
  assert.equal(big.history.length, 200);
  assert.equal(big.history[big.history.length - 1].probedAt, "new");
  assert.equal(big.history[0].probedAt, "h1");
});

test("samplesFromFixture parses indices + stocks deterministically", () => {
  const fx = {
    nowMs: 1_700_000_030_000, // 30s after the ticks
    marketStatus: { market: "open" },
    indices: { results: [
      { ticker: "I:SPX", value: 5234, market_status: "open", last_updated: 1_700_000_000_000 * 1e6, session: { change_percent: 0.3 } },
    ] },
    stocks: { AAPL: { ticker: { ticker: "AAPL", todaysChangePerc: 1.1, lastTrade: { p: 195, t: 1_700_000_000_000 * 1e6 } } } },
  };
  const s = samplesFromFixture(fx);
  assert.equal(s.length, 2);
  assert.equal(s[0].symbol, "I:SPX");
  assert.equal(s[0].stalenessSec, 30);
  assert.equal(s[0].freshnessBand, "REALTIME");
  assert.equal(s[1].symbol, "AAPL");
  assert.equal(s[1].isMarketOpen, true);
  assert.equal(s[1].stalenessSec, 30);
});
