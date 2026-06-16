// Offline unit tests for the cross-sectional quality (profitability) study — no network.
// Pins the no-lookahead contract (distill called at rb−75d) + the QUALITY SIGN, and proves the
// factor wires end-to-end through the (factor-agnostic) study-lib machinery via pack(). `distill`
// is injected so we never need raw SEC XBRL in a unit test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQualityObservations } from "./build-quality.mjs";
import { grid, pack, iso, meritAsOfISO } from "./build-study.mjs";

const DATES = grid(1);

// Panel: each name compounds at a constant monthly rate g_idx AND carries a constant profitability
// q_idx, with q ordered to MATCH g (more profitable ⇒ higher forward return). The injected distill
// returns the name's stored profitability regardless of asOf, so merit = q_idx (constant) and
// fwdRet = g_idx — strictly monotone together ⇒ per-period rank-IC = +1.
function panel(rows, M){
  const loaded = {};
  rows.forEach(({ g, q }, idx) => {
    const prices = [];
    for(let k=0;k<M;k++) prices.push({ t: DATES[k], close: 100*Math.pow(1+g, k) });
    loaded["S"+idx] = { prices, j: { roe: q, npm: q/2 } };  // npm half of roe → same ranking
  });
  return loaded;
}
// Fake distill: reads the stored profitability off the name's `j`, ignoring asOf (constant fundamentals).
const fakeDistill = (j, _asOf) => ({ rec: j ? { roe: j.roe, npm: j.npm } : null });
const ROWS = [{ g:-0.01, q:0.04 }, { g:0.00, q:0.08 }, { g:0.01, q:0.12 }, { g:0.02, q:0.16 }];
const M = 16;

// ─── no-lookahead pin ─────────────────────────────────────────────────────────
test("buildQualityObservations: distill is read at the 75-day-lagged as-of (point-in-time, never after rb)", () => {
  const seenAsOf = [];
  const spyDistill = (j, asOf) => { seenAsOf.push(asOf); return fakeDistill(j, asOf); };
  const obs = buildQualityObservations(panel(ROWS, M), "roe", { distill: spyDistill });
  assert.ok(obs.length > 0, "expected observations");
  // Every as-of must equal meritAsOfISO(rb) for some rebalance — i.e. 75 days BEFORE the rebalance.
  for(const rb of DATES){
    const expected = meritAsOfISO(rb);
    // when this rb produced an observation, the lagged as-of must have been used (never rb itself)
    if(seenAsOf.includes(expected)) assert.ok(expected < iso(rb), "as-of must precede the rebalance bar");
  }
  assert.ok(seenAsOf.every(a => DATES.some(rb => meritAsOfISO(rb) === a)), "all as-ofs are 75-day-lagged rebalance dates");
});

test("buildQualityObservations: merit is the profitability metric; a MORE-profitable name scores higher", () => {
  const obs = buildQualityObservations(panel(ROWS, M), "roe", { distill: fakeDistill });
  const rb = iso(DATES[6]);
  const lowQ  = obs.find(o => o.sym === "S0" && o.period === rb); // q=0.04
  const highQ = obs.find(o => o.sym === "S3" && o.period === rb); // q=0.16
  assert.ok(lowQ && highQ, "both names present at the rebalance");
  assert.ok(Math.abs(lowQ.merit - 0.04) < 1e-9 && Math.abs(highQ.merit - 0.16) < 1e-9, "merit == ROE");
  assert.ok(highQ.merit > lowQ.merit, "the more-profitable name must have the higher quality score");
  // The npm window reads the other metric.
  const npmObs = buildQualityObservations(panel(ROWS, M), "npm", { distill: fakeDistill });
  const o = npmObs.find(r => r.sym === "S3" && r.period === rb);
  assert.ok(Math.abs(o.merit - 0.08) < 1e-9, "npm window reads rec.npm");
});

test("buildQualityObservations: drops incomplete-forward rebalances; null/missing profitability skipped", () => {
  const obs = buildQualityObservations(panel(ROWS, M), "roe", { distill: fakeDistill });
  const lastBar = iso(DATES[M-1]);
  assert.ok(!obs.some(o => o.period === lastBar), "the last bar can't be a rebalance");
  // A name whose distill yields no profitability contributes nothing (but never throws).
  const noProfit = { S0: { prices: panel(ROWS, M).S0.prices, j: { roe: null, npm: null } } };
  assert.deepEqual(buildQualityObservations(noProfit, "roe", { distill: fakeDistill }), []);
});

// ─── end-to-end: the factor wires through pack()/runStudy with the right SIGN ──
test("pack(): a quality-predictive panel yields positive mean IC; the label-shuffle placebo collapses", () => {
  const obs = buildQualityObservations(panel(ROWS, M), "roe", { distill: fakeDistill });
  const packed = pack(obs);
  assert.ok(packed.meanIC > 0.5, "more-profitable→higher-return must give a strongly positive IC, got "+packed.meanIC);
  assert.ok(Math.abs(packed.placebo.meanIC) < packed.meanIC, "placebo IC must collapse relative to the real signal");
});

test("buildQualityObservations: empty panel yields no observations (never throws)", () => {
  assert.deepEqual(buildQualityObservations({}, "roe", { distill: fakeDistill }), []);
});
