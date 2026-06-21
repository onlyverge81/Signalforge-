// Offline unit tests for the cross-sectional short-term reversal study — no network.
// Pins the no-lookahead contract + the REVERSAL SIGN of buildReversalObservations, and proves
// the factor wires end-to-end through the (factor-agnostic) study-lib machinery via pack().

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReversalObservations } from "./build-reversal.mjs";
import { grid, pack, iso } from "./build-study.mjs";

const DATES = grid(1);

// A MEAN-REVERTING monthly panel on the REAL rebalance grid (so priceOnOrBefore aligns exactly):
// each name's monthly return alternates sign with amplitude a → r_k = a·(−1)^k. Then the
// trailing-month return and the next-month return are equal-and-opposite, so the reversal score
// (−trailing) EQUALS the forward return at every rebalance → per-period rank-IC(reversal,fwdRet)
// = +1: a clean positive-REVERSAL fixture (losers bounce). Distinct amplitudes give ≥3 ranks.
function panel(amps, M){
  const loaded = {};
  amps.forEach((a, idx) => {
    const prices = []; let p = 100;
    for(let k=0;k<M;k++){
      if(k>0) p = p * (1 + a*Math.pow(-1, k));
      prices.push({ t: DATES[k], close: p });
    }
    loaded["S"+idx] = { prices };
  });
  return loaded;
}
const AMPS = [0.01, 0.02, 0.03, 0.04, 0.05, 0.06]; // 6 names → ≥3 per cross-section for rankIC
const M = 18;

// ─── no-lookahead + SIGN pins ─────────────────────────────────────────────────
test("buildReversalObservations: merit is the NEGATED trailing-1mo return; fwdRet is next-month — point-in-time", () => {
  const loaded = panel(AMPS, M);
  const obs = buildReversalObservations(loaded, 1);
  assert.ok(obs.length > 0, "expected observations");
  const a = 0.03, idx = AMPS.indexOf(a), m = 6;          // a fully-formed interior rebalance
  const rb = iso(DATES[m]);
  const o = obs.find(r => r.sym === "S"+idx && r.period === rb);
  assert.ok(o, "expected an observation for S"+idx+" at "+rb);
  // trailing-month return = a·(−1)^m  ⇒  merit = −a·(−1)^m
  assert.ok(Math.abs(o.merit - (-(a*Math.pow(-1,m)))) < 1e-9, "merit must be the NEGATED 1-month return");
  // fwdRet (rb→rb+1) = a·(−1)^(m+1) = −a·(−1)^m  ⇒  equals merit on this mean-reverting panel
  assert.ok(Math.abs(o.fwdRet - (-(a*Math.pow(-1,m)))) < 1e-9, "fwdRet must be the one-month-forward return");
  assert.ok(Math.abs(o.merit - o.fwdRet) < 1e-9, "by construction reversal score == forward return here");
});

test("buildReversalObservations: a recent LOSER scores positive; a recent WINNER scores negative", () => {
  // Three monthly bars: name fell 10% last month → reversal merit > 0; name rose 10% → merit < 0.
  const loser  = { L: { prices: [{t:DATES[0],close:100},{t:DATES[1],close:90}, {t:DATES[2],close:95}] } };
  const winner = { W: { prices: [{t:DATES[0],close:100},{t:DATES[1],close:110},{t:DATES[2],close:108}] } };
  const oL = buildReversalObservations(loser, 1).find(o => o.period === iso(DATES[1]));
  const oW = buildReversalObservations(winner, 1).find(o => o.period === iso(DATES[1]));
  assert.ok(oL && oL.merit > 0, "a recent loser must have a positive reversal score");
  assert.ok(oW && oW.merit < 0, "a recent winner must have a negative reversal score");
});

test("buildReversalObservations: drops rebalances whose forward window is incomplete (no peeking past the last bar)", () => {
  const obs = buildReversalObservations(panel(AMPS, M), 1);
  const lastBar = iso(DATES[M-1]);
  assert.ok(!obs.some(o => o.period === lastBar), "the last bar can't be a rebalance — its rb+1 forward window doesn't exist yet");
  for(const o of obs) assert.ok(o.period < lastBar, "every rebalance precedes the last bar");
});

// ─── end-to-end: the factor wires through pack()/runStudy with the right SIGN ──
test("pack(): a mean-reverting panel yields positive mean IC; the label-shuffle placebo collapses", () => {
  const obs = buildReversalObservations(panel(AMPS, M), 1);
  const packed = pack(obs);
  assert.ok(packed.meanIC > 0.5, "monotonic reversal→return must give a strongly positive IC, got "+packed.meanIC);
  assert.equal(typeof packed.proven, "boolean");
  assert.ok(Math.abs(packed.placebo.meanIC) < packed.meanIC, "placebo IC must collapse relative to the real signal");
  // The reversal driver tests a single window → trials=1; default pack stays 1 too.
  assert.equal(packed.deflated.trials, 1, "default trials is 1");
});

test("buildReversalObservations: empty/short panels yield no observations (never throws)", () => {
  assert.deepEqual(buildReversalObservations({}, 1), []);
  // A single bar can't form a trailing window or a forward window → contributes nothing.
  const one = { S0: { prices: [{ t: DATES[0], close: 100 }] } };
  assert.deepEqual(buildReversalObservations(one, 1), []);
});
