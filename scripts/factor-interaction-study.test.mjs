// Tests for the factor-interaction "pie chart" research harness. Pure-function coverage only —
// no network. Pins: vote-vector fidelity to the engine, no-lookahead in the panel, the pie
// arithmetic, the conditional/interaction lift, and the combined-composite diversification.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  voteVector, VOTE_WEIGHTS, factorValues, FACTOR_NAMES, FUNDAMENTAL_NAMES,
  buildPanel, obsFor, standaloneICs, contributionPie, spearman,
  correlationMatrix, conditionalIC, interactionScan, combinedComposite,
  parsePolyFinancials, recAsOf, autopsyValues,
} from "./factor-interaction-study.mjs";
import { computeSignal, rsi, macd, bb, stoch, sma, patterns, divergence, adxCalc, obvCalc, vwapCalc } from "./engine.mjs";

// Build a synthetic OHLCV series; `f` maps an index to a close, volume optional.
function series(n, f, volF){
  const out = [];
  for(let i = 0; i < n; i++){
    const close = f(i);
    const prev = i > 0 ? f(i - 1) : close;
    const high = Math.max(close, prev) * 1.01, low = Math.min(close, prev) * 0.99;
    out.push({ t: Date.UTC(2018, 0, 1) + i * 86400000, open: prev, high, low, close, volume: volF ? volF(i) : 1000 });
  }
  return out;
}

test("voteVector mirrors the engine: Σ dir·weight reproduces computeSignal's pre-penalty weighted sum", () => {
  // A clean rising series so several votes fire.
  const data = series(120, i => 100 + i * 0.5 + Math.sin(i / 5) * 2);
  const v = voteVector(data);
  // Re-derive the engine's weighted (pre-penalty) sum from the same ctx the engine builds.
  const closes = data.map(d => d.close), vols = data.map(d => d.volume), last = data[data.length - 1];
  const ctx = {
    R: rsi(closes), M: macd(closes), B: bb(closes), S: stoch(data), last,
    s5: sma(closes, 5), s10: sma(closes, 10), s20: sma(closes, 20), s50: sma(closes, 50),
    pats: patterns(data), div: divergence(closes), ADX: adxCalc(data), OBV: obvCalc(data), VWAP: vwapCalc(data),
    trend: ((last.close - closes[0]) / closes[0] * 100) > 2 ? "UPTREND" : "SIDEWAYS",
    volSig: "NEUTRAL",
  };
  // engine's weighted sum, but using ADX nominal weight 3 (our VOTE_WEIGHTS) — restrict the check to
  // the always-present, fixed-weight votes so dynamic ADX weighting / pattern multiplicity don't skew it.
  const fixed = ["RSI", "MACD", "MA", "MAlong", "Trend", "Stoch", "BB", "OBV", "VWAP"];
  let mine = 0;
  for(const k of fixed){ if(v[k] != null) mine += v[k] * VOTE_WEIGHTS[k]; }
  // Engine vote dirs for the same names (recompute inline, identical thresholds):
  let eng = 0;
  if(ctx.R != null) eng += (ctx.R < 40 ? 1 : ctx.R > 60 ? -1 : 0) * 2;
  if(ctx.M) eng += (ctx.M.macd > 0 ? 1 : -1) * 2.5;
  if(ctx.s5 && ctx.s10) eng += (ctx.s5 > ctx.s10 ? 1 : -1) * 1.5;
  if(ctx.s20 && ctx.s50) eng += (ctx.s20 > ctx.s50 ? 1 : -1) * 2;
  eng += (ctx.trend === "UPTREND" ? 1 : ctx.trend === "DOWNTREND" ? -1 : 0) * 2;
  if(ctx.S != null) eng += (ctx.S < 25 ? 1 : ctx.S > 75 ? -1 : 0) * 1.5;
  if(ctx.B) eng += (last.close < ctx.B.lower ? 1 : last.close > ctx.B.upper ? -1 : 0) * 1.5;
  if(ctx.OBV) eng += (ctx.OBV.rising ? 1 : -1) * 2;
  if(ctx.VWAP) eng += (last.close > ctx.VWAP ? 1 : -1) * 1.5;
  assert.equal(mine, eng, "harness vote directions must match the engine's");
  // And computeSignal runs on the same ctx without throwing (smoke).
  assert.ok(["BUY", "HOLD", "SELL"].includes(computeSignal(ctx).signal));
});

test("voteVector returns directional votes in {-1,0,1}", () => {
  const data = series(120, i => 100 + i * 0.5);
  const v = voteVector(data);
  for(const k of Object.keys(v)) assert.ok([-1, 0, 1].includes(v[k]), k + " must be -1/0/1");
  assert.ok(Object.keys(v).length >= 6, "most votes should fire on a clean series");
});

test("factorValues computes the four price/risk factors on a long series", () => {
  const data = series(300, i => 100 * Math.pow(1.002, i));   // steady uptrend
  const fv = factorValues(data);
  assert.deepEqual(Object.keys(fv).sort(), [...FACTOR_NAMES].sort());
  assert.ok(fv.mom12_1 > 0, "uptrend ⇒ positive 12-1 momentum");
  assert.ok(fv.lowvol != null && fv.lowvol < 0, "low-vol is NEGATED realized vol (≤0)");
});

test("buildPanel enforces no-lookahead: a future spike never leaks into the rebalance merit", () => {
  // Flat-ish then a spike far in the future; the merit at an early rebalance must ignore the spike.
  const n = 320;
  const bars = series(n, i => (i < 300 ? 100 + (i % 5) : 1000));  // huge late spike
  const rbIdx = 280;
  const rb = bars[rbIdx].t;
  const dates = [rb];
  const panel = buildPanel({ ZZ: bars }, dates, { minBars: 260 });
  assert.equal(panel.length, 1, "one complete row at the rebalance");
  const row = panel[0];
  // Recompute the factor from the slice up to rb only; must equal the panel's value (no future bars used).
  const slice = bars.slice(0, rbIdx + 1);
  assert.equal(row.values.mom12_1, factorValues(slice).mom12_1, "merit must use only bars ≤ rb");
  // fwdRet uses a bar AFTER rb (the spike begins at i=300 > 280) so it is large and positive.
  assert.ok(row.fwdRet > 1, "forward return should capture the post-rebalance move");
});

test("buildPanel drops rows whose forward window is incomplete", () => {
  const bars = series(300, i => 100 + i);
  const lastT = bars[bars.length - 1].t;
  const panel = buildPanel({ ZZ: bars }, [lastT], { minBars: 260 });  // no bars after the last → incomplete
  assert.equal(panel.length, 0, "no forward bar ⇒ row dropped (no-lookahead)");
});

test("spearman: perfect monotonic ⇒ 1, perfect inverse ⇒ -1", () => {
  assert.equal(spearman([1, 2, 3, 4], [10, 20, 30, 40]), 1);
  assert.equal(spearman([1, 2, 3, 4], [40, 30, 20, 10]), -1);
  assert.equal(spearman([1, 2], [3, 4]), null, "fewer than 3 pairs ⇒ null");
});

// A synthetic panel where a factor's rank predicts the forward return, for IC/pie/composite tests.
function predictivePanel({ periods = 8, names = 12, strength = 1 } = {}){
  const panel = [];
  for(let p = 0; p < periods; p++){
    for(let s = 0; s < names; s++){
      const a = (s / names) - 0.5;                  // factor A: spread across names
      const b = ((names - s) / names) - 0.5;        // factor B: anti-correlated with A
      const noise = ((p * 7 + s * 13) % 11) / 11 - 0.5;
      const fwdRet = strength * a + 0.2 * noise;    // A predicts forward return; B does not (it's −A)
      panel.push({ sym: "S" + s, period: "2020-0" + (p + 1), fwdRet, values: { A: a, B: b, C: noise } });
    }
  }
  return panel;
}

test("standaloneICs + contributionPie: predictive factor gets a fat slice, noise gets a thin one", () => {
  const panel = predictivePanel();
  const ics = standaloneICs(panel, ["A", "B", "C"]);
  const icA = ics.find(x => x.name === "A");
  assert.ok(icA.meanIC > 0.5, "A should have strongly positive IC");
  const pie = contributionPie(ics);
  const total = pie.reduce((s, p) => s + p.weightPct, 0);
  assert.ok(Math.abs(total - 100) < 0.5, "pie weights sum to ~100%");
  assert.equal(pie[0].name === "A" || pie[0].name === "B", true, "A/B (the structured columns) dominate the pie");
  const wA = pie.find(p => p.name === "A").weightPct, wC = pie.find(p => p.name === "C").weightPct;
  assert.ok(wA > wC, "the predictive factor outweighs pure noise");
});

test("correlationMatrix: anti-correlated columns read strongly negative; diagonal is 1", () => {
  const panel = predictivePanel();
  const M = correlationMatrix(panel, ["A", "B", "C"]);
  assert.equal(M.A.A, 1);
  assert.ok(M.A.B < -0.9, "A and B are constructed inversely");
});

test("conditionalIC + interactionScan: an interaction-only factor shows a positive lift", () => {
  // Factor X predicts forward returns ONLY among names where gate G is high (top tertile).
  const panel = [];
  for(let p = 0; p < 8; p++){
    for(let s = 0; s < 12; s++){
      const x = (s % 4) - 1.5;                       // X varies within each G group
      const g = s < 8 ? 0 : 1;                       // bottom 8 = low G, top 4 = high G
      const noise = ((p * 5 + s) % 7) / 7 - 0.5;
      const fwdRet = (g === 1 ? x : 0) + 0.05 * noise;  // X only "works" when G is high
      panel.push({ sym: "S" + s, period: "2021-0" + (p + 1), fwdRet, values: { X: x, G: g } });
    }
  }
  const c = conditionalIC(panel, "X", "G");
  assert.ok(c.topIC != null && c.bottomIC != null);
  assert.ok(c.lift > 0.2, "X predicts much better inside G's top tertile ⇒ positive lift");
  const scan = interactionScan(panel, ["X", "G"]);
  // sorted by |lift| descending; the X|G interaction is present with a positive lift.
  for(let i = 1; i < scan.length; i++) assert.ok(Math.abs(scan[i - 1].lift) >= Math.abs(scan[i].lift), "scan sorted by |lift|");
  const xg = scan.find(s => s.factor === "X" && s.conditionedOn === "G");
  assert.ok(xg && xg.lift > 0.2, "X|G interaction surfaces with a positive lift");
});

test("combinedComposite: two independent positive-IC factors blend to ≥ the best single", () => {
  // Two orthogonal predictive factors → an equal-weight composite should not underperform the best one.
  const panel = [];
  for(let p = 0; p < 10; p++){
    for(let s = 0; s < 16; s++){
      const a = (s % 4) - 1.5;                       // factor A
      const b = (Math.floor(s / 4)) - 1.5;           // factor B, orthogonal to A
      const fwdRet = a + b;                          // both contribute
      panel.push({ sym: "S" + s, period: "2022-" + String(p + 1).padStart(2, "0"), fwdRet, values: { A: a, B: b } });
    }
  }
  const cc = combinedComposite(panel, ["A", "B"]);
  assert.ok(cc.meanIC != null && cc.bestSingle != null);
  assert.ok(Math.abs(cc.meanIC) >= Math.abs(cc.bestSingle.meanIC) - 1e-9, "composite ≥ best single (diversification)");
  assert.ok(cc.gain >= -1e-9, "diversification gain is non-negative here");
});

// A minimal Polygon /vX/reference/financials payload (two annual filings) for the AUTOPSY layer.
function financialsPayload(){
  const mk = (filed, ni, rev, eps, eq, liab, ca, cl) => ({
    filing_date: filed,
    financials: {
      income_statement: { net_income_loss: { value: ni }, revenues: { value: rev }, basic_earnings_per_share: { value: eps } },
      balance_sheet: { equity_attributable_to_parent: { value: eq }, liabilities: { value: liab }, current_assets: { value: ca }, current_liabilities: { value: cl } },
    },
  });
  return [
    mk("2021-02-15", 80, 1000, 4.0, 400, 120, 300, 150),   // prior year
    mk("2022-02-15", 100, 1100, 5.0, 500, 100, 360, 150),  // latest: ROE 0.20, NPM ~0.091, D/E 0.2, CR 2.4, revG +10%, epsG +25%
  ];
}

test("parsePolyFinancials + recAsOf: point-in-time AUTOPSY rec, no filing read after asOf", () => {
  const parsed = parsePolyFinancials(financialsPayload());
  assert.equal(parsed.length, 2);
  assert.ok(parsed[0].t < parsed[1].t, "sorted ascending by filing date");
  // As of just before the 2022 filing, only the 2021 filing is public.
  const early = recAsOf(parsed, Date.parse("2022-01-01"));
  assert.ok(Math.abs(early.roe - 80 / 400) < 1e-9, "early ROE from the 2021 filing only");
  assert.equal(early.revG, null, "no prior filing before 2021 ⇒ no YoY growth");
  // As of after the 2022 filing, the latest numbers + YoY growth apply.
  const late = recAsOf(parsed, Date.parse("2022-06-01"));
  assert.ok(Math.abs(late.roe - 100 / 500) < 1e-9, "late ROE = 100/500 = 0.20");
  assert.ok(Math.abs(late.npm - 100 / 1100) < 1e-9, "NPM = NI/revenue");
  assert.ok(Math.abs(late.de - 100 / 500) < 1e-9, "D/E = liabilities/equity");
  assert.ok(Math.abs(late.cr - 360 / 150) < 1e-9, "current ratio = CA/CL");
  assert.ok(Math.abs(late.revG - (1100 / 1000 - 1)) < 1e-9, "revG = +10%");
  assert.ok(Math.abs(late.epsG - (5 / 4 - 1)) < 1e-9, "epsG = +25%");
});

test("autopsyValues reuses the app's valueScore: a strong, cheap, growing name scores positively", () => {
  const parsed = parsePolyFinancials(financialsPayload());
  // Low price ⇒ cheap P/E and P/B on top of the healthy/growing fundamentals.
  const v = autopsyValues(parsed, Date.parse("2022-06-01"), 30);
  assert.ok(v.AUTOPSY_healthy > 0, "healthy: ROE 20% + low D/E + good current ratio");
  assert.ok(v.AUTOPSY_growing > 0, "growing: revenue and EPS both up YoY");
  assert.ok(v.merit > 0, "merit total positive for a cheap, healthy, growing name");
  // Before any filing is public, AUTOPSY is null (no-lookahead).
  const none = autopsyValues(parsed, Date.parse("2019-01-01"), 30);
  assert.equal(none.merit, null);
});

test("buildPanel merges AUTOPSY fundamentals point-in-time when financials are supplied", () => {
  const bars = series(320, i => 100 + i * 0.2);
  const rb = bars[300].t;
  const parsed = parsePolyFinancials(financialsPayload());
  const panel = buildPanel({ ZZ: bars }, [rb], { minBars: 260, fundamentals: { ZZ: parsed } });
  assert.equal(panel.length, 1);
  for(const n of FUNDAMENTAL_NAMES) assert.ok(n in panel[0].values, "fundamental contributor " + n + " present");
  // Without fundamentals, the AUTOPSY keys are absent (bars-only pie still works).
  const bare = buildPanel({ ZZ: bars }, [rb], { minBars: 260 });
  assert.equal("merit" in bare[0].values, false);
});

test("obsFor yields the factor-agnostic {sym,period,merit,fwdRet} study-lib expects", () => {
  const panel = predictivePanel({ periods: 6, names: 9 });
  const obs = obsFor(panel, "A");
  assert.ok(obs.every(o => "sym" in o && "period" in o && "merit" in o && "fwdRet" in o));
});
