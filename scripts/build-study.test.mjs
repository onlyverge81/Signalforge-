// Offline unit test for the merit study's pure universe selector — no network.
// (The rest of build-study.mjs is IO; the statistical core is tested in study-lib.test.mjs.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMeritUniverse, priceOnOrBefore, meritAsOfISO, MERIT_FILING_LAG_DAYS } from "./build-study.mjs";

const co = (ticker, active, cik = "0000000001") => ({ ticker, active, cik });

// ─── no-lookahead pins ────────────────────────────────────────────────────────
test("priceOnOrBefore: latest close at-or-before the target, never one dated after", () => {
  const prices = [
    { t: Date.UTC(2020, 0, 31), close: 10 },
    { t: Date.UTC(2020, 1, 29), close: 11 },
    { t: Date.UTC(2020, 2, 31), close: 12 },
  ];
  assert.equal(priceOnOrBefore(prices, Date.UTC(2020, 1, 29)), 11); // exact match
  assert.equal(priceOnOrBefore(prices, Date.UTC(2020, 1, 15)), 10); // between → the EARLIER close
  assert.equal(priceOnOrBefore(prices, Date.UTC(2019, 11, 1)), null); // before first → none (no peeking ahead)
  assert.equal(priceOnOrBefore(prices, Date.UTC(2025, 0, 1)), 12);  // after last → last available
});

test("meritAsOfISO: enforces the 75-day point-in-time filing lag", () => {
  assert.equal(MERIT_FILING_LAG_DAYS, 75);
  const rb = Date.UTC(2020, 5, 30); // 2020-06-30
  assert.equal(meritAsOfISO(rb), new Date(rb - 75 * 864e5).toISOString().slice(0, 10));
  assert.ok(meritAsOfISO(rb) < "2020-06-30", "as-of date must be strictly before the rebalance");
});

test("selectMeritUniverse: returns the whole roster (ticker-sorted) when it fits under the cap", () => {
  const roster = [ co("ZZZ", true), co("AAA", true), co("LEHMQ", false), co("WAMUQ", false) ];
  const got = selectMeritUniverse(roster, 10).map(c => c.ticker);
  assert.deepEqual(got, ["AAA", "LEHMQ", "WAMUQ", "ZZZ"]);
});

test("selectMeritUniverse: over the cap, preserves the active:de-listed mix (not all-dead, not all-survivor)", () => {
  // 6 de-listed + 6 active, cap 4 → proportional keeps 2 of each (survivorship-free).
  const roster = [
    ...["D1","D2","D3","D4","D5","D6"].map(t => co(t, false)),
    ...["A1","A2","A3","A4","A5","A6"].map(t => co(t, true)),
  ];
  const got = selectMeritUniverse(roster, 4);
  assert.equal(got.length, 4);
  assert.equal(got.filter(c => !c.active).length, 2); // de-listed half — INCLUDED
  assert.equal(got.filter(c =>  c.active).length, 2); // active half
});

test("selectMeritUniverse: drops CIK-less and malformed rows; tolerates empty input", () => {
  const roster = [ co("AAA", true), { ticker:"NOCIK", active:true, cik:null }, null, { active:true } ];
  assert.deepEqual(selectMeritUniverse(roster, 10).map(c => c.ticker), ["AAA"]);
  assert.deepEqual(selectMeritUniverse(null, 10), []);
});
