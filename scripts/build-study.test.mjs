// Offline unit test for the merit study's pure universe selector — no network.
// (The rest of build-study.mjs is IO; the statistical core is tested in study-lib.test.mjs.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMeritUniverse } from "./build-study.mjs";

const co = (ticker, active, cik = "0000000001") => ({ ticker, active, cik });

test("selectMeritUniverse: keeps ALL de-listed first, then fills with active, ticker-sorted", () => {
  const roster = [
    co("ZZZ", true), co("AAA", true), co("LEHMQ", false), co("WAMUQ", false),
  ];
  const got = selectMeritUniverse(roster, 3).map(c => c.ticker);
  // both de-listed (sorted) are kept; one active fills the remaining slot (sorted → AAA)
  assert.deepEqual(got, ["LEHMQ", "WAMUQ", "AAA"]);
});

test("selectMeritUniverse: when de-listed alone exceeds the cap, takes the first cap of them", () => {
  const roster = [ co("DDD", false), co("BBB", false), co("CCC", false), co("AAA", true) ];
  const got = selectMeritUniverse(roster, 2).map(c => c.ticker);
  assert.deepEqual(got, ["BBB", "CCC"]); // de-listed sorted, capped at 2; no active room
});

test("selectMeritUniverse: drops CIK-less and malformed rows; tolerates empty input", () => {
  const roster = [ co("AAA", true), { ticker:"NOCIK", active:true, cik:null }, null, { active:true } ];
  assert.deepEqual(selectMeritUniverse(roster, 10).map(c => c.ticker), ["AAA"]);
  assert.deepEqual(selectMeritUniverse(null, 10), []);
});
