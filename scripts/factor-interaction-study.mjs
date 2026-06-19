// Build factor-interaction-study.json — the "pie chart of weighted data value" research harness.
// Run on-demand (workflow_dispatch); prints a rollup to the job log + uploads the JSON artifact.
// IN-SAMPLE measurement on real Polygon history, NOT a promotion and NOT wired into any gate.
//
// The question (the user's "Wheel of Problem-Solving" arc): SignalForge's tools each cast a vote
// toward a signal — but which ones actually carry forward-return information, how REDUNDANT are
// they with each other, and does COMBINING two weak-but-real ones beat either alone? The live OOS
// ledger can't answer yet (0 closed trades), so we put SignalForge "in reverse" against the
// abundance of Polygon historical bars and measure it NOW.
//
// Method (all lookahead-controlled, charter-clean — Polygon BARS only, no SEC/Yahoo/fallback):
//  • Polygon adjusted DAILY closes; survivorship-free roster.json universe (reusing selectMeritUniverse).
//  • Monthly rebalance grid; 1-month forward return; only COMPLETE forward windows (no-lookahead).
//  • Contributors measured per name per rebalance, point-in-time from bars ≤ rebalance:
//      – PRICE/RISK FACTORS: momentum 12-1, momentum 6-1, reversal 1-mo, low-vol 12-mo
//        (reusing momentumValue / reversalValue / lowVolValue from forward-log.mjs VERBATIM, so the
//         study measures exactly the contributors the live OOS labels use).
//      – TECHNICAL VOTES: the 13 SIGNALS-tab votes (RSI, MACD, MA, MAlong, Trend, Stoch, BB,
//        Patterns, Divergence, Volume, ADX, OBV, VWAP), input as the RAW vote DIRECTION the engine
//        casts (−1/0/+1). Using the bare direction (not dir×weight) is deliberate: the MEASURED
//        rank-IC then reveals the weight each vote EMPIRICALLY deserves, which we print beside the
//        engine's HAND-SET weight — exposing which votes earn their keep and which are dead freight.
//  • Per contributor: the per-period Spearman rank-IC series (study-lib's factor-agnostic machinery).
//  • THE PIE: each contributor's |meanIC| as a share of the total — its "weighted data value".
//  • COMBINATIONS: a per-period Spearman correlation matrix (redundancy), a conditional/interaction
//    scan (IC of factor A within factor B's TOP vs BOTTOM tertile → the interaction "lift"), and a
//    z-scored combined composite vs the best single factor (does the blend diversify?).
//
// Honesty (binding): in-sample is NEVER the verdict here. An attractive pie is "looks good
// in-sample," not proven. Only the OOS ledger, cleared through FDR, is tradeable evidence. The
// votes' technical core is a MEASURED in-sample loser (baseline t ≈ −12.6) — expect thin/negative
// slices, which is the honest, useful finding, not a bug to tune away.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { selectMeritUniverse, grid, addMonths, iso } from "./build-study.mjs";
import { momentumValue, reversalValue, lowVolValue } from "./forward-log.mjs";
import { periodStats, assessSignificance, rankIC } from "./study-lib.mjs";
import { rsi, macd, bb, stoch, atr, adxCalc, obvCalc, vwapCalc, patterns, divergence, sma } from "./engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIS_MAX = +(process.env.FIS_MAX || 120);
const MIN_BARS = 260;                 // ≥253 so the 12-month lookback factors are all computable
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;

// The four PRICE/RISK factors, defined by the SAME functions the live OOS labels use (forward-log).
export const FACTOR_NAMES = ["mom12_1", "mom6_1", "reversal", "lowvol"];
export function factorValues(slice){
  return {
    mom12_1:  momentumValue(slice, { lookback: 252, skip: 21 }),
    mom6_1:   momentumValue(slice, { lookback: 126, skip: 21 }),
    reversal: reversalValue(slice, { lookback: 21 }),
    lowvol:   lowVolValue(slice,   { lookback: 252 }),
  };
}

// The engine's HAND-SET vote weights (engine.mjs computeSignal) — printed beside the MEASURED
// IC-weight so the study can say whether each weight is empirically justified. Patterns/Volume
// have variable presence; ADX's weight is dynamic — these are the nominal values for reference.
export const VOTE_WEIGHTS = { RSI:2, MACD:2.5, MA:1.5, MAlong:2, Trend:2, Stoch:1.5, BB:1.5,
  Pat:1.5, Div:2.5, Vol:1, ADX:3, OBV:2, VWAP:1.5 };
export const VOTE_NAMES = Object.keys(VOTE_WEIGHTS);

// Mirror of analyze()'s ctx-build + computeSignal()'s per-vote DIRECTION logic (engine.mjs), but
// returning the bare directional vote per indicator (−1/0/+1) instead of an aggregate signal. Kept
// byte-faithful to the engine's thresholds; a unit test asserts Σ dir·weight reproduces the engine's
// pre-penalty weighted sum, so this can't silently drift from the real scorer.
export function voteVector(data){
  if(!data || data.length < 2) return {};
  const closes = data.map(d => d.close), vols = data.map(d => d.volume);
  const last = data[data.length - 1];
  const R = rsi(closes), M = macd(closes), B = bb(closes), S = stoch(data);
  const s5 = sma(closes, Math.min(5, closes.length));
  const s10 = sma(closes, Math.min(10, closes.length));
  const s20 = sma(closes, Math.min(20, closes.length));
  const s50 = sma(closes, Math.min(50, closes.length));
  const pats = patterns(data), div = divergence(closes);
  const ADX = adxCalc(data), OBV = obvCalc(data), VWAP = vwapCalc(data);
  const chg = (last.close - closes[0]) / closes[0] * 100;
  const trend = chg > 2 ? "UPTREND" : chg < -2 ? "DOWNTREND" : "SIDEWAYS";
  const avgV = vols.slice(0, -3).reduce((a, b) => a + b, 0) / Math.max(vols.length - 3, 1);
  const recV = vols.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const volSig = recV > avgV * 1.15 ? "CONFIRMING" : recV < avgV * 0.85 ? "DIVERGING" : "NEUTRAL";

  const v = {};
  if(R != null)  v.RSI = R < 40 ? 1 : R > 60 ? -1 : 0;
  if(M)          v.MACD = M.macd > 0 ? 1 : -1;
  if(s5 && s10)  v.MA = s5 > s10 ? 1 : -1;
  if(s20 && s50) v.MAlong = s20 > s50 ? 1 : -1;
  v.Trend = trend === "UPTREND" ? 1 : trend === "DOWNTREND" ? -1 : 0;
  if(S != null)  v.Stoch = S < 25 ? 1 : S > 75 ? -1 : 0;
  if(B)          v.BB = last.close < B.lower ? 1 : last.close > B.upper ? -1 : 0;
  // Patterns: net of all detected (the engine pushes one vote each; we collapse to their sum's sign·count
  // contribution, but for an IC input we use the NET direction so a name has one Pat value per period).
  if(pats && pats.length){
    const net = pats.reduce((a, p) => a + (p.type === "BULLISH" ? 1 : p.type === "BEARISH" ? -1 : 0), 0);
    v.Pat = Math.sign(net);
  }
  if(div) v.Div = div.type === "BULLISH" ? 1 : -1;
  if(volSig === "CONFIRMING" && trend === "UPTREND") v.Vol = 1;
  else if(volSig === "CONFIRMING" && trend === "DOWNTREND") v.Vol = -1;
  if(ADX) v.ADX = ADX.plusDI > ADX.minusDI ? 1 : -1;
  if(OBV) v.OBV = OBV.rising ? 1 : -1;
  if(VWAP) v.VWAP = last.close > VWAP ? 1 : -1;
  return v;
}

// ─── pure rank / correlation primitives (study-lib keeps pearson private) ─────
function ranksOf(xs){
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length); let i = 0;
  while(i < idx.length){
    let j = i; while(j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; for(let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1;
  }
  return r;
}
function pearson(a, b){
  const n = a.length; if(n < 3) return null;
  const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for(let i = 0; i < n; i++){ const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  return (da <= 0 || db <= 0) ? null : num / Math.sqrt(da * db);
}
// Spearman rank correlation of two equal-length aligned arrays (nulls dropped pairwise).
export function spearman(xs, ys){
  const a = [], b = [];
  for(let i = 0; i < xs.length; i++){
    if(xs[i] != null && isFinite(xs[i]) && ys[i] != null && isFinite(ys[i])){ a.push(xs[i]); b.push(ys[i]); }
  }
  if(a.length < 3) return null;
  return pearson(ranksOf(a), ranksOf(b));
}

// ─── panel: one row per (sym, rebalance) with every contributor's value + the forward return ──
// No-lookahead: a contributor at rb reads only bars with t ≤ rb; fwdRet needs a bar strictly after
// rb up to rb+1mo, and the row is dropped unless that forward window is complete.
export function buildPanel(barsByTicker, dates, { minBars = MIN_BARS } = {}){
  const rows = [];
  for(const [sym, bars] of Object.entries(barsByTicker)){
    if(!bars || bars.length < minBars) continue;
    const series = bars.slice().sort((a, b) => a.t - b.t);
    for(const rb of dates){
      // last bar at-or-before the rebalance
      let idx = -1;
      for(let i = 0; i < series.length; i++){ if(series[i].t <= rb) idx = i; else break; }
      if(idx < minBars - 1) continue;                       // not enough history for the 12-mo factors
      const fwdT = addMonths(rb, 1);
      let j = idx;
      for(let i = idx + 1; i < series.length; i++){ if(series[i].t <= fwdT) j = i; else break; }
      if(j <= idx) continue;                                 // forward window not complete → drop (no-lookahead)
      const entry = series[idx].close, exit = series[j].close;
      if(!(entry > 0) || !(exit > 0)) continue;
      const slice = series.slice(0, idx + 1);
      const values = { ...factorValues(slice), ...voteVector(slice) };
      rows.push({ sym, period: iso(rb), fwdRet: exit / entry - 1, values });
    }
  }
  return rows;
}

// Extract the factor-agnostic observation array study-lib consumes, for one contributor.
export function obsFor(panel, name){
  return panel.map(r => ({ sym: r.sym, period: r.period, merit: r.values[name], fwdRet: r.fwdRet }));
}

// Standalone predictive value per contributor: the per-period rank-IC series summarised.
export function standaloneICs(panel, names){
  return names.map(name => {
    const ps = periodStats(obsFor(panel, name));
    const st = assessSignificance(ps.map(p => p.ic));
    return { name, meanIC: st.mean, t: st.t, nPeriods: st.n, verdict: st.verdict };
  });
}

// THE PIE: each contributor's |meanIC| as a percentage of the total |meanIC| across contributors.
// Contributors with null/NaN meanIC (too few periods) get 0% and are flagged. Sorted by share.
export function contributionPie(icStats){
  const finite = icStats.filter(s => s.meanIC != null && isFinite(s.meanIC));
  const total = finite.reduce((a, s) => a + Math.abs(s.meanIC), 0);
  return icStats.map(s => ({
    name: s.name,
    meanIC: s.meanIC,
    t: s.t,
    weightPct: (total > 0 && s.meanIC != null && isFinite(s.meanIC)) ? round(100 * Math.abs(s.meanIC) / total) : 0,
    sign: s.meanIC == null ? null : (s.meanIC >= 0 ? "+" : "−"),
    verdict: s.verdict,
  })).sort((a, b) => b.weightPct - a.weightPct);
}

// Per-period Spearman correlation matrix between contributor value columns (redundancy view): how
// much do two tools say the same thing? Averaged across periods so period effects don't dominate.
export function correlationMatrix(panel, names){
  const byPeriod = new Map();
  for(const r of panel){ if(!byPeriod.has(r.period)) byPeriod.set(r.period, []); byPeriod.get(r.period).push(r); }
  const M = {};
  for(const a of names){
    M[a] = {};
    for(const b of names){
      if(a === b){ M[a][b] = 1; continue; }
      const corrs = [];
      for(const [, rows] of byPeriod){
        const c = spearman(rows.map(r => r.values[a]), rows.map(r => r.values[b]));
        if(c != null) corrs.push(c);
      }
      M[a][b] = corrs.length ? round(corrs.reduce((x, y) => x + y, 0) / corrs.length) : null;
    }
  }
  return M;
}

// Conditional / INTERACTION IC: within each period, split names into B's TOP and BOTTOM tertile by
// the conditioning factor, then measure A's rank-IC inside each subset. `lift` = meanTopIC −
// meanBottomIC answers "does A predict BETTER among high-B names?" — the combinatorial edge the
// user is after ("does combining two weak-but-real factors beat either alone?").
export function conditionalIC(panel, aName, bName, { topFrac = 1 / 3 } = {}){
  const byPeriod = new Map();
  for(const r of panel){ if(!byPeriod.has(r.period)) byPeriod.set(r.period, []); byPeriod.get(r.period).push(r); }
  const topICs = [], bottomICs = [];
  for(const [, rows] of byPeriod){
    const clean = rows.filter(r => r.values[bName] != null && isFinite(r.values[bName])
      && r.values[aName] != null && isFinite(r.values[aName]) && r.fwdRet != null && isFinite(r.fwdRet));
    if(clean.length < 9) continue;                          // need ≥3 per tertile to rank honestly
    const sorted = clean.slice().sort((x, y) => x.values[bName] - y.values[bName]);
    const k = Math.max(3, Math.floor(sorted.length * topFrac));
    const top = sorted.slice(-k), bottom = sorted.slice(0, k);
    const icT = rankIC(top.map(r => ({ merit: r.values[aName], fwdRet: r.fwdRet })));
    const icB = rankIC(bottom.map(r => ({ merit: r.values[aName], fwdRet: r.fwdRet })));
    if(icT != null) topICs.push(icT);
    if(icB != null) bottomICs.push(icB);
  }
  const top = assessSignificance(topICs), bot = assessSignificance(bottomICs);
  const lift = (top.n && bot.n) ? round(top.mean - bot.mean) : null;
  return { factor: aName, conditionedOn: bName, topIC: top.mean, bottomIC: bot.mean, lift, nPeriods: Math.min(top.n, bot.n) };
}

// Scan every ordered pair among `names` for an interaction lift; sorted by |lift| so the strongest
// conditional structure surfaces first.
export function interactionScan(panel, names, opts){
  const out = [];
  for(const a of names) for(const b of names){ if(a !== b) out.push(conditionalIC(panel, a, b, opts)); }
  return out.filter(x => x.lift != null).sort((x, y) => Math.abs(y.lift) - Math.abs(x.lift));
}

// Per-period cross-sectional z-score of a contributor across names (mean 0, sd 1). Pure helper.
function zByPeriod(rows, name){
  const vals = rows.map(r => r.values[name]).filter(v => v != null && isFinite(v));
  if(vals.length < 2) return null;
  const m = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - m) * (b - m), 0) / vals.length);
  if(!(sd > 0)) return null;
  return r => { const v = r.values[name]; return (v != null && isFinite(v)) ? (v - m) / sd : null; };
}

// Combined composite: z-score each factor cross-sectionally per period, weighted-sum into one score,
// then measure that score's rank-IC. Compares to the best single factor → diversification gain.
// Default weights = equal; pass IC-magnitude weights to tilt toward the stronger factors.
export function combinedComposite(panel, names, { weights = null } = {}){
  const w = weights || names.map(() => 1);
  const byPeriod = new Map();
  for(const r of panel){ if(!byPeriod.has(r.period)) byPeriod.set(r.period, []); byPeriod.get(r.period).push(r); }
  const ics = [];
  for(const [, rows] of byPeriod){
    const zfns = names.map(n => zByPeriod(rows, n));
    if(zfns.some(f => f == null)) continue;
    const scored = rows.map(r => {
      let s = 0, ok = true;
      for(let i = 0; i < names.length; i++){ const z = zfns[i](r); if(z == null){ ok = false; break; } s += w[i] * z; }
      return ok ? { merit: s, fwdRet: r.fwdRet } : null;
    }).filter(Boolean);
    const ic = rankIC(scored);
    if(ic != null) ics.push(ic);
  }
  const st = assessSignificance(ics);
  const singles = standaloneICs(panel, names);
  const best = singles.filter(s => s.meanIC != null).sort((a, b) => Math.abs(b.meanIC) - Math.abs(a.meanIC))[0] || null;
  return {
    names, weights: w,
    meanIC: st.mean, t: st.t, nPeriods: st.n, verdict: st.verdict,
    bestSingle: best ? { name: best.name, meanIC: best.meanIC } : null,
    gain: (best && st.mean != null) ? round(Math.abs(st.mean) - Math.abs(best.meanIC)) : null,
  };
}

function caveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), capped to FIS_MAX for runtime — de-listed losers are INCLUDED."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias inflates any positive result; run universe-build for roster.json.",
    "PRICE/RISK factors are computed by the SAME functions the live OOS labels use (momentumValue / reversalValue / lowVolValue in forward-log.mjs) — daily-bar approximations of the monthly studies.",
    "TECHNICAL votes are input as the engine's RAW vote DIRECTION (−1/0/+1); the measured IC-weight reveals the weight each vote EMPIRICALLY deserves, shown beside the engine's hand-set weight.",
    "1-month forward windows, monthly rebalance, only COMPLETE windows (no-lookahead). One cross-section per rebalance → modest power; INCONCLUSIVE is an acceptable outcome.",
    "IN-SAMPLE only — an attractive pie is 'looks good in-sample,' NOT proven. The technical confluence is a measured in-sample loser (baseline t ≈ −12.6); thin/negative vote slices are the honest finding. Only the OOS ledger under FDR is tradeable evidence.",
  ];
}

function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, FIS_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return { tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${FIS_MAX})`,
        survivorshipFree: true };
    }
  }catch{ /* no roster yet → fall back */ }
  return { tickers: readTickers().slice(0, FIS_MAX),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)", survivorshipFree: false };
}

async function fetchDaily(sym, key){
  const candles = await fetchPolygonAggs(sym, "1day", key, { minBars: MIN_BARS });
  return candles.map(c => ({ t: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.t - b.t);
}

function bar(pct){ const n = Math.round(Math.max(0, Math.min(100, pct || 0)) / 4); return "█".repeat(n) + "·".repeat(25 - n); }

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY — the factor-interaction study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source, survivorshipFree } = resolveUniverse();
  console.log("factor-interaction universe: " + source);

  const barsByTicker = {}; const errors = [];
  for(const sym of tickers){
    try{
      const bars = await fetchDaily(sym, key);
      if(bars.length < MIN_BARS) throw new Error(`only ${bars.length} bars (<${MIN_BARS})`);
      barsByTicker[sym] = bars;
      console.log("✓ " + sym.padEnd(6) + " " + bars.length + " daily bars");
    }catch(e){ errors.push(sym + ": " + (e.message || e)); console.warn("✗ " + sym.padEnd(6) + " — " + (e.message || e)); }
  }

  const dates = grid(1);
  const panel = buildPanel(barsByTicker, dates);
  const ALL = [...FACTOR_NAMES, ...VOTE_NAMES];
  const ics = standaloneICs(panel, ALL);
  const pie = contributionPie(ics);
  const corr = correlationMatrix(panel, FACTOR_NAMES);
  const interactions = interactionScan(panel, FACTOR_NAMES);
  // Equal-weight and IC-magnitude-weighted composites of the price/risk factors.
  const icW = FACTOR_NAMES.map(n => { const s = ics.find(x => x.name === n); return s && s.meanIC != null ? Math.abs(s.meanIC) : 0; });
  const compositeEqual = combinedComposite(panel, FACTOR_NAMES);
  const compositeICw = combinedComposite(panel, FACTOR_NAMES, { weights: icW });

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(barsByTicker).length, source, survivorshipFree, skipped: errors },
    source: { prices: "Polygon (adjusted daily close)" },
    config: { rebalance: "monthly", forwardHorizon: "1 month", minBars: MIN_BARS, rows: panel.length },
    contributors: { factors: FACTOR_NAMES, votes: VOTE_NAMES, voteWeights: VOTE_WEIGHTS },
    standaloneIC: ics.map(s => ({ ...s, kind: FACTOR_NAMES.includes(s.name) ? "factor" : "vote", engineWeight: VOTE_WEIGHTS[s.name] || null })),
    pie,
    correlationMatrix: corr,
    interactions,
    composite: { equalWeight: compositeEqual, icWeighted: compositeICw },
    caveats: caveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT, "factor-interaction-study.json"), JSON.stringify(out) + "\n");

  // ─── console rollup ───────────────────────────────────────────────────────
  console.log("\n════ FACTOR-INTERACTION PIE (|rank-IC| share of weighted data value) ════");
  console.log("  panel rows: " + panel.length + " over " + Object.keys(barsByTicker).length + " names\n");
  for(const p of pie){
    const kind = FACTOR_NAMES.includes(p.name) ? "factor" : "vote  ";
    const ew = VOTE_WEIGHTS[p.name] != null ? ` engW=${VOTE_WEIGHTS[p.name]}` : "";
    console.log("  " + p.name.padEnd(9) + " " + kind + " " + bar(p.weightPct) + " " +
      String(p.weightPct).padStart(5) + "%  IC=" + (p.meanIC ?? "n/a") + " (t=" + (p.t ?? "n/a") + ", " + p.verdict + ")" + ew);
  }
  console.log("\n════ TOP FACTOR INTERACTIONS (IC of A within B's top vs bottom tertile) ════");
  for(const x of interactions.slice(0, 6)){
    console.log("  " + x.factor.padEnd(9) + " | " + x.conditionedOn.padEnd(9) +
      " top=" + x.topIC + " bottom=" + x.bottomIC + " LIFT=" + x.lift + " (n=" + x.nPeriods + ")");
  }
  console.log("\n════ COMBINED COMPOSITE (z-scored blend of the 4 price/risk factors) ════");
  const cc = compositeEqual;
  console.log("  equal-weight   meanIC=" + cc.meanIC + " t=" + cc.t + " (" + cc.verdict + "), n=" + cc.nPeriods +
    "; best single=" + (cc.bestSingle ? cc.bestSingle.name + " " + cc.bestSingle.meanIC : "n/a") + ", gain=" + cc.gain);
  console.log("  IC-weighted    meanIC=" + compositeICw.meanIC + " t=" + compositeICw.t + " (" + compositeICw.verdict + ")");
  console.log("\nWrote factor-interaction-study.json" + (errors.length ? (" (" + errors.length + " skipped)") : "") + ".");
  console.log("IN-SAMPLE only — not proven, not wired into any gate. Only the OOS ledger under FDR counts.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
