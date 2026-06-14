// Offline unit tests for the merit-evidence study math — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankIC, tertileSpread, assessSignificance, runStudy, placebo, meritEdgeProven,
  verdictFor, walkForward, betaControl, overlapAdjustedT, deflatedSignificance, periodStats } from "./study-lib.mjs";

// Deterministic RNG so the planted/null panels are reproducible.
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }

test("rankIC: +1 for a monotonic relation, −1 for the inverse", () => {
  const up   = [0,1,2,3,4].map(i=>({merit:i, fwdRet:i}));
  const down = [0,1,2,3,4].map(i=>({merit:i, fwdRet:-i}));
  assert.equal(rankIC(up), 1);
  assert.equal(rankIC(down), -1);
  assert.equal(rankIC([{merit:1,fwdRet:2}]), null); // too few
});

test("tertileSpread: positive when top-merit names out-return bottom", () => {
  const rows=[0,1,2,3,4,5].map(i=>({merit:i, fwdRet:i}));
  assert.ok(tertileSpread(rows) > 0);
});

test("assessSignificance: TOO FEW PERIODS below 6 observations", () => {
  assert.equal(assessSignificance([0.1,0.2,0.3]).verdict, "TOO FEW PERIODS");
});

// Build a panel: 10 periods × 20 names. merit = i; forward return carries a real
// monotonic signal plus seeded noise so per-period ICs vary (non-degenerate).
function plantedPanel(coef, seed){
  const rng=mulberry(seed); const obs=[];
  for(let p=0;p<10;p++){
    const period="20"+(10+p)+"-06-30";
    for(let i=0;i<20;i++){
      const merit=i, noise=(rng()-0.5)*30;
      obs.push({sym:"S"+i, period, merit, fwdRet:coef*merit+noise});
    }
  }
  return obs;
}

test("a real merit→return edge reads SIGNIFICANT, holds OOS, and beats the placebo", () => {
  const obs=plantedPanel(1.0, 42);
  const study=runStudy(obs);
  assert.equal(study.significance, "SIGNIFICANT");
  assert.ok(study.meanIC > 0);
  assert.ok(study.oos.outSample.mean > 0);
  const plac=placebo(obs, 7);
  assert.notEqual(plac.verdict, "SIGNIFICANT");
  assert.equal(meritEdgeProven(study, plac), true);
});

test("a no-signal panel reads NOT SIGNIFICANT and is not proven", () => {
  const rng=mulberry(99); const obs=[];
  for(let p=0;p<10;p++){
    const period="20"+(10+p)+"-06-30";
    for(let i=0;i<20;i++) obs.push({sym:"S"+i, period, merit:i, fwdRet:(rng()-0.5)*30}); // return independent of merit
  }
  const study=runStudy(obs);
  assert.notEqual(study.significance, "SIGNIFICANT");
  const plac=placebo(obs, 3);
  // The honest gate must refuse to greenlight a noise panel.
  assert.equal(meritEdgeProven(study, plac), false);
});

test("the placebo on a real edge collapses toward zero IC", () => {
  const obs=plantedPanel(1.0, 11);
  const real=runStudy(obs).meanIC;
  const plac=placebo(obs, 11).mean;
  assert.ok(Math.abs(plac) < Math.abs(real)); // shuffling merit destroys the signal
});

// ─── Step-1 hardening ────────────────────────────────────────────────────────

test("verdictFor: shared thresholds (n<6 too few; |t|>2 sig; >1.5 suggestive)", () => {
  assert.equal(verdictFor(9, 3), "TOO FEW PERIODS");
  assert.equal(verdictFor(2.5, 10), "SIGNIFICANT");
  assert.equal(verdictFor(1.7, 10), "SUGGESTIVE");
  assert.equal(verdictFor(0.5, 10), "NOT SIGNIFICANT");
});

test("walkForward: a real edge predicts next-period IC (hitRate>0.5, oof.mean>0); noise does not", () => {
  const wfReal = walkForward(plantedPanel(1.0, 42));
  assert.ok(wfReal.folds >= 6);
  assert.ok(wfReal.hitRate > 0.5, "real edge should agree out-of-fold");
  assert.ok(wfReal.oof.mean > 0);

  const rng=mulberry(5); const noise=[];
  for(let p=0;p<10;p++){ const period="20"+(10+p)+"-06-30";
    for(let i=0;i<20;i++) noise.push({sym:"S"+i, period, merit:i, fwdRet:(rng()-0.5)*30}); }
  const wfNoise = walkForward(noise);
  assert.ok(wfNoise.oof.verdict !== "SIGNIFICANT", "noise out-of-fold IC must not read significant");
});

test("betaControl: pure cross-sectional skill has ~0 spread/market correlation", () => {
  // Spread is constant each period; market return varies → no co-movement of the EDGE with beta.
  const periods=[
    {spread:0.10, mktRet:-0.05}, {spread:0.10, mktRet:0.20}, {spread:0.10, mktRet:0.00},
    {spread:0.10, mktRet:0.15}, {spread:0.10, mktRet:-0.10},
  ];
  const bc=betaControl(periods);
  assert.equal(bc.n, 5);
  assert.ok(bc.spreadMktCorr === null || Math.abs(bc.spreadMktCorr) < 0.01);
  // And the opposite: a spread that only pays when the market is up reads as beta-timing.
  const beta=[{spread:-0.05,mktRet:-0.05},{spread:0.20,mktRet:0.20},{spread:0.0,mktRet:0.0},{spread:0.15,mktRet:0.15}];
  assert.ok(betaControl(beta).spreadMktCorr > 0.9);
});

test("overlapAdjustedT: lag correction inflates the SE (lowers t) on a positively autocorrelated series", () => {
  const xs=[0.10,0.12,0.14,0.13,0.16,0.18,0.17,0.20,0.22,0.21]; // trending ⇒ positive autocorrelation
  const hac0=overlapAdjustedT(xs, 0);  // no lag correction (baseline of the same estimator)
  const hac3=overlapAdjustedT(xs, 3);  // Bartlett-weighted lags 1..3
  assert.ok(hac3.seHAC > hac0.seHAC, "positive autocorrelation must widen the HAC SE");
  assert.ok(Math.abs(hac3.tHAC) < Math.abs(hac0.tHAC), "more lags ⇒ more conservative t");
  assert.equal(hac3.overlap, 3);
});

test("deflatedSignificance: more trials raises the bar; trials=1 reproduces the plain verdict", () => {
  const ics=periodStats(plantedPanel(1.0, 42)).map(p=>p.ic);
  const plain=deflatedSignificance(ics, {trials:1});
  assert.equal(plain.threshold, 0);
  assert.equal(plain.tDeflated, assessSignificance(ics).t);
  const many=deflatedSignificance(ics, {trials:100});
  assert.ok(many.threshold > 0);
  assert.ok(Math.abs(many.tDeflated) < Math.abs(plain.tDeflated), "haircut shrinks the t");
});

test("meritEdgeProven: tightened gate still greenlights a strong planted edge", () => {
  const obs=plantedPanel(1.0, 42);
  assert.equal(meritEdgeProven(runStudy(obs), placebo(obs, 7)), true);
});
