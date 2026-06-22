// Offline unit tests for the fundamentals universe selectors — no network.
// (The SEC crawl in main() is IO; distill is exercised via the study tests.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectLiquidUniverse, parseSnapshotDollarVol } from "./build-fundamentals.mjs";

const co = (ticker, active, cik = "0000000001") => ({ ticker, cik, active });

test("parseSnapshotDollarVol: price × day volume, prevDay fallback pre-open", () => {
  const j = { tickers: [
    { ticker: "AAA", day: { c: 10, v: 1000 } },                       // 10,000
    { ticker: "BBB", day: { c: 0, v: 0 }, prevDay: { c: 5, v: 4000 } }, // pre-open → 20,000
    { ticker: "CCC", lastTrade: { p: 2 }, day: { v: 100 } },           // 200 (no day.c → fall to lastTrade price)
    { ticker: "ZZZ", day: { c: 0, v: 0 } },                           // no liquidity → dropped
    { ticker: null },
  ] };
  const dv = parseSnapshotDollarVol(j);
  assert.equal(dv.AAA, 10000);
  assert.equal(dv.BBB, 20000);
  assert.equal(dv.CCC, 200);
  assert.equal("ZZZ" in dv, false);
});

test("parseSnapshotDollarVol: tolerates a malformed payload", () => {
  assert.deepEqual(parseSnapshotDollarVol(null), {});
  assert.deepEqual(parseSnapshotDollarVol({ status: "ERROR" }), {});
});

test("selectLiquidUniverse: ranks active CIK-bearing names by dollar volume, capped", () => {
  const roster = [co("AAA", true), co("BBB", true), co("CCC", true), co("DDD", true)];
  const dv = { AAA: 100, BBB: 900, CCC: 500, DDD: 50 };
  const got = selectLiquidUniverse(roster, dv, 2).map(c => c.sym);
  assert.deepEqual(got, ["BBB", "CCC"]); // top-2 by liquidity
});

test("selectLiquidUniverse: excludes de-listed and CIK-less names (active-only universe)", () => {
  const roster = [co("AAA", true), co("DEAD", false), { ticker: "NOCIK", active: true, cik: null }];
  const dv = { AAA: 100, DEAD: 9999, NOCIK: 9999 };
  assert.deepEqual(selectLiquidUniverse(roster, dv, 10).map(c => c.sym), ["AAA"]);
});

test("selectLiquidUniverse: names with no liquidity reading sort last; ticker tie-break; tolerates empty", () => {
  const roster = [co("AAA", true), co("BBB", true), co("CCC", true)];
  const dv = { CCC: 1 }; // AAA/BBB unknown (→0), CCC has liquidity
  const got = selectLiquidUniverse(roster, dv, 10).map(c => c.sym);
  assert.deepEqual(got, ["CCC", "AAA", "BBB"]); // CCC first; the two 0-dv names ticker-sorted
  assert.deepEqual(selectLiquidUniverse(null, {}, 10), []);
});

test("selectLiquidUniverse: carries the roster CIK through", () => {
  const roster = [{ ticker: "AAA", active: true, cik: "0001090872" }];
  assert.deepEqual(selectLiquidUniverse(roster, { AAA: 5 }, 10), [{ sym: "AAA", cik: "0001090872" }]);
});
