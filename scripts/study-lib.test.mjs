// Offline unit tests for the merit-evidence study math — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { rankIC, tertileSpread, assessSignificance, runStudy, placebo, meritEdgeProven } from "./study-lib.mjs";

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
