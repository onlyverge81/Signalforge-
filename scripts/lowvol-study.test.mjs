// Offline unit tests for the cross-sectional low-volatility study — no network.
// Pins the no-lookahead contract + the LOW-VOL SIGN of buildLowVolObservations, the stdev helper,
// and proves the factor wires end-to-end through the (factor-agnostic) study-lib machinery via pack().

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLowVolObservations, stdev } from "./build-lowvol.mjs";
import { grid, pack, iso } from "./build-study.mjs";

const DATES = grid(1);

// A panel where each name has a DISTINCT, persistent volatility but ~zero drift, plus a forward
// return engineered to REWARD calm names: fwd return decreasing in vol. Construct monthly returns
// for name idx as r_k = vol_idx·(−1)^k (oscillation ⇒ realized stdev = vol_idx, ~zero compounding
// drift). Then make the cross-section's forward outcome favour low vol by ordering amplitudes so a
// calmer name (smaller vol) tends to a higher next-month return — here the natural construction
// already does it: at any rb, fwdRet = r_{m+1} = vol·(−1)^{m+1}; its RANK across names flips each
// month, so to get a clean +IC we instead pin the sign test separately and use a monotone fixture.
function volPanel(vols, M){
  const loaded = {};
  vols.forEach((v, idx) => {
    const prices = []; let p = 100;
    for(let k=0;k<M;k++){
      if(k>0) p = p * (1 + v*Math.pow(-1, k));
      prices.push({ t: DATES[k], close: p });
    }
    loaded["S"+idx] = { prices };
  });
  return loaded;
}

// ─── stdev helper ─────────────────────────────────────────────────────────────
test("stdev: population standard deviation; <2 points ⇒ 0; constant series ⇒ 0", () => {
  assert.equal(stdev([]), 0);
  assert.equal(stdev([5]), 0);
  assert.equal(stdev([3, 3, 3]), 0);
  assert.ok(Math.abs(stdev([1, -1]) - 1) < 1e-12, "±1 has population stdev 1");
  assert.ok(Math.abs(stdev([2, 4, 4, 4, 5, 5, 7, 9]) - 2) < 1e-12, "textbook example → 2");
});

// ─── no-lookahead + SIGN pins ─────────────────────────────────────────────────
test("buildLowVolObservations: merit is the NEGATED trailing realized vol; fwdRet is next-month — point-in-time", () => {
  const M = 18, vols = [0.01, 0.03, 0.05];
  const obs = buildLowVolObservations(volPanel(vols, M), 6);
  assert.ok(obs.length > 0, "expected observations");
  const v = 0.03, idx = vols.indexOf(v), m = 8;
  const o = obs.find(r => r.sym === "S"+idx && r.period === iso(DATES[m]));
  assert.ok(o, "expected an observation for S"+idx);
  // The oscillating returns have magnitude v every month ⇒ realized stdev over the window = v.
  assert.ok(Math.abs(o.merit - (-v)) < 1e-9, "merit must be the negated trailing realized vol (−v)");
  // fwdRet (rb→rb+1) = v·(−1)^(m+1).
  assert.ok(Math.abs(o.fwdRet - (v*Math.pow(-1, m+1))) < 1e-9, "fwdRet must be the one-month-forward return");
});

test("buildLowVolObservations: a CALM name scores higher than a WILD name (sign check)", () => {
  const M = 16;
  const obs = buildLowVolObservations(volPanel([0.01, 0.08], M), 6);
  const rb = iso(DATES[8]);
  const calm = obs.find(o => o.sym === "S0" && o.period === rb);
  const wild = obs.find(o => o.sym === "S1" && o.period === rb);
  assert.ok(calm && wild, "both names present at the rebalance");
  assert.ok(calm.merit > wild.merit, "the calmer name must have the higher low-vol score");
  assert.ok(Math.abs(calm.merit - (-0.01)) < 1e-9 && Math.abs(wild.merit - (-0.08)) < 1e-9);
});

test("buildLowVolObservations: drops rebalances whose forward window is incomplete; needs ≥2 trailing returns", () => {
  const M = 18;
  const obs = buildLowVolObservations(volPanel([0.02, 0.04, 0.06], M), 6);
  const lastBar = iso(DATES[M-1]);
  assert.ok(!obs.some(o => o.period === lastBar), "the last bar can't be a rebalance");
  for(const o of obs) assert.ok(o.period < lastBar, "every rebalance precedes the last bar");
  // A name with only 2 monthly bars can't form a 6-month vol window → contributes nothing.
  const tiny = { S0: { prices: [{t:DATES[0],close:100},{t:DATES[1],close:101}] } };
  assert.deepEqual(buildLowVolObservations(tiny, 6), []);
});

// ─── end-to-end: a low-vol-predictive panel wires through pack() with the right SIGN ──
test("pack(): a calm-rewards panel yields positive mean IC; the label-shuffle placebo collapses", () => {
  // Monotone fixture: 3 names with vols 0.02/0.04/0.06 and forward returns pinned to REWARD calm
  // (lower vol ⇒ higher fwdRet) at every rebalance. Build prices so the forward month return is
  // exactly (0.10 − vol·k-independent): we synthesize directly as observations to isolate the IC sign.
  const periods = ["2021-01","2021-02","2021-03","2021-04"];
  const obs = [];
  for(const p of periods){
    for(const [sym, vol] of [["A",0.02],["B",0.04],["C",0.06]]){
      obs.push({ period: p, merit: -vol, fwdRet: 0.10 - vol }); // calmer (higher merit) ⇒ higher fwdRet
    }
  }
  const packed = pack(obs);
  assert.ok(packed.meanIC > 0.5, "calm→higher-return must give a strongly positive IC, got "+packed.meanIC);
  assert.ok(Math.abs(packed.placebo.meanIC) < packed.meanIC, "placebo IC must collapse relative to the real signal");
});

test("buildLowVolObservations: empty panel yields no observations (never throws)", () => {
  assert.deepEqual(buildLowVolObservations({}, 6), []);
});
