// Offline unit tests for the cross-sectional momentum study — no network.
// Pins the no-lookahead contract of buildMomentumObservations and proves the factor
// wiring end-to-end through the (factor-agnostic) study-lib machinery via pack().

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMomentumObservations } from "./build-momentum.mjs";
import { grid, pack, iso } from "./build-study.mjs";

// Synthetic monthly panel on the REAL rebalance grid, so priceOnOrBefore aligns exactly:
// stock S_idx compounds at a constant monthly rate g → close[k] = 100·(1+g)^k.
// Then trailing momentum and the next-month forward return are both strictly monotonic in g,
// so the per-period rank-IC(momentum, fwdRet) is +1 — a clean positive-factor fixture.
const DATES = grid(1);
function panel(growths, M){
  const loaded = {};
  growths.forEach((g, idx) => {
    const prices = [];
    for(let k=0;k<M;k++) prices.push({ t: DATES[k], close: 100*Math.pow(1+g, k) });
    loaded["S"+idx] = { prices };
  });
  return loaded;
}
const GROWTHS = [-0.02, -0.01, 0, 0.01, 0.02, 0.03]; // 6 names → ≥3 per cross-section for rankIC
const M = 20;

// ─── no-lookahead pins ────────────────────────────────────────────────────────
test("buildMomentumObservations: merit skips the most recent month; fwdRet is next-month — point-in-time", () => {
  const loaded = panel(GROWTHS, M);
  const obs = buildMomentumObservations(loaded, 12);
  assert.ok(obs.length > 0, "expected observations");
  // First fully-formed 12-1 rebalance is k=12 (needs price at rb−12mo and a complete rb+1 window).
  const g = 0.02, idx = GROWTHS.indexOf(g);
  const rb = iso(DATES[12]);
  const o = obs.find(r => r.sym === "S"+idx && r.period === rb);
  assert.ok(o, "expected an observation for S"+idx+" at "+rb);
  // merit = price(rb−1mo)/price(rb−12mo) − 1 = (1+g)^11 − 1 (skip-month, 11-month return)
  assert.ok(Math.abs(o.merit - (Math.pow(1+g,11)-1)) < 1e-9, "merit must be the skip-month trailing return");
  // fwdRet = price(rb+1mo)/price(rb) − 1 = g (one-month forward)
  assert.ok(Math.abs(o.fwdRet - g) < 1e-9, "fwdRet must be the one-month-forward return");
});

test("buildMomentumObservations: drops rebalances whose forward window is incomplete (no peeking past the last bar)", () => {
  const loaded = panel(GROWTHS, M);
  const obs = buildMomentumObservations(loaded, 12);
  const lastBar = iso(DATES[M-1]);
  assert.ok(!obs.some(o => o.period === lastBar), "the last bar can't be a rebalance — its rb+1 forward window doesn't exist yet");
  // Every emitted period must leave room for the one-month forward window.
  for(const o of obs) assert.ok(o.period < lastBar, "every rebalance precedes the last bar");
});

test("buildMomentumObservations: both 12-1 and 6-1 lookbacks emit; 6-1 sees more (earlier) periods", () => {
  const loaded = panel(GROWTHS, M);
  const p12 = new Set(buildMomentumObservations(loaded, 12).map(o => o.period));
  const p6  = new Set(buildMomentumObservations(loaded, 6 ).map(o => o.period));
  assert.ok(p12.size > 0 && p6.size > 0, "both windows produce observations");
  assert.ok(p6.size > p12.size, "the 6-month lookback unlocks earlier rebalances than the 12-month one");
});

// ─── end-to-end: the factor wires through pack()/runStudy with the right SIGN ──
test("pack(): a momentum-predictive panel yields positive mean IC; the label-shuffle placebo collapses", () => {
  const obs = buildMomentumObservations(panel(GROWTHS, M), 12);
  const packed = pack(obs);
  assert.ok(packed.meanIC > 0.5, "monotonic momentum→return must give a strongly positive IC, got "+packed.meanIC);
  assert.equal(typeof packed.proven, "boolean");
  // Placebo shuffles merit labels within each period → the relationship must wash out.
  assert.ok(Math.abs(packed.placebo.meanIC) < packed.meanIC, "placebo IC must collapse relative to the real signal");
  // trials threads through to the overfit haircut (the momentum driver passes trials=2 for its
  // two lookback windows); default stays 1 so the merit caller is unchanged.
  assert.equal(pack(obs, { trials: 2 }).deflated.trials, 2);
  assert.equal(packed.deflated.trials, 1, "default trials is 1");
});

test("buildMomentumObservations: empty/short panels yield no observations (never throws)", () => {
  assert.deepEqual(buildMomentumObservations({}, 12), []);
  // A name with only a few bars can't support a 12-month lookback → contributes nothing.
  const short = { S0: { prices: [0,1,2,3].map(k => ({ t: DATES[k], close: 100+k })) } };
  assert.deepEqual(buildMomentumObservations(short, 12), []);
});
