// Offline unit test for the merit study's pure universe selector — no network.
// (The rest of build-study.mjs is IO; the statistical core is tested in study-lib.test.mjs.)

import { test } from "node:test";
import assert from "node:assert/strict";
import { selectMeritUniverse } from "./build-study.mjs";

const co = (ticker, active, cik = "0000000001") => ({ ticker, active, cik });

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
