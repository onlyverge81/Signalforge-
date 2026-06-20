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
import { fetchPolygonAggs, fetchSectorMap } from "./pattern-study.mjs";
import { selectMeritUniverse, grid, addMonths, iso } from "./build-study.mjs";
import { momentumValue, reversalValue, lowVolValue } from "./forward-log.mjs";
import { periodStats, assessSignificance, rankIC, sectorNeutralIC } from "./study-lib.mjs";
import { rsi, macd, bb, stoch, atr, adxCalc, obvCalc, vwapCalc, patterns, divergence, sma, valueScore } from "./engine.mjs";
import { meritMetrics } from "./sec-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FIS_MAX = +(process.env.FIS_MAX || 120);
const MIN_BARS = 260;                 // ≥253 so the 12-month lookback factors are all computable
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;
// Robustness (angle A) — liquidity screen + beta window. Env-overridable; defaults target a tradeable
// floor that excludes the stale-priced micro-cap delisted names that can fake a low-vol "edge".
const LIQ_MIN_ADV   = +(process.env.LIQ_MIN_ADV   || 2_000_000);  // trailing median dollar-volume floor ($)
const LIQ_MIN_PRICE = +(process.env.LIQ_MIN_PRICE || 5);          // price floor ($) — drops sub-$5 junk
const LIQ_WIN       = +(process.env.LIQ_WIN       || 60);         // trailing bars for the ADV median
const BETA_WIN      = +(process.env.BETA_WIN      || 120);        // trailing bars for each name's market beta

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

// ─── AUTOPSY fundamentals: cheap / healthy / growing + merit composite ────────
// The whole-app pie weighs the AUTOPSY (✚ VALUE) tab too. We reconstruct each name's point-in-time
// fundamentals from Polygon's /vX/reference/financials (the SAME charter-pure, CI-reachable source
// the quality-duration study uses — net income, revenue, equity, debt, current assets/liabilities,
// EPS, by filing_date) into a `rec`, then reuse the app's AUTOPSY engine VERBATIM —
// valueScore(meritMetrics(rec, price)) — so cheap/healthy/growing/total are computed by the exact
// code the app shows, not a re-implementation. Filing_date is already the PUBLIC date, so reading
// the latest filing with filing_date ≤ rebalance is point-in-time with no extra lag.
export const FUNDAMENTAL_NAMES = ["AUTOPSY_cheap", "AUTOPSY_healthy", "AUTOPSY_growing", "merit"];

// Pure: Polygon financials `results` → sorted [{t, ni, revenue, eps, equity, liabilities, curAssets, curLiab}].
export function parsePolyFinancials(results){
  const out = [];
  for(const res of (results || [])){
    const fin = res.financials || {};
    const is = fin.income_statement || {}, bs = fin.balance_sheet || {};
    const val = x => (x && x.value != null && isFinite(x.value)) ? x.value : null;
    const ni = val(is.net_income_loss);
    const revenue = val(is.revenues);
    const eps = val(is.basic_earnings_per_share) ?? val(is.diluted_earnings_per_share);
    const equity = val(bs.equity_attributable_to_parent) ?? val(bs.equity);
    const liabilities = val(bs.liabilities);
    const curAssets = val(bs.current_assets);
    const curLiab = val(bs.current_liabilities);
    const filing = res.filing_date || res.end_date;
    if(filing) out.push({ t: Date.parse(filing), ni, revenue, eps, equity, liabilities, curAssets, curLiab });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Pure: build the point-in-time AUTOPSY `rec` from the latest filing ≤ asOfMs (with the prior filing
// for YoY growth). Returns the {epsTTM,bvps,de,roe,npm,cr,revG,epsG} record meritMetrics consumes, or
// null when no filing is public yet. No-lookahead: never reads a filing dated after asOfMs.
export function recAsOf(parsed, asOfMs){
  const past = (parsed || []).filter(f => f.t <= asOfMs);
  if(!past.length) return null;
  const cur = past[past.length - 1], prev = past.length > 1 ? past[past.length - 2] : null;
  const pos = x => (x != null && isFinite(x) && x > 0) ? x : null;
  const shares = (cur.ni != null && cur.eps != null && cur.eps !== 0) ? cur.ni / cur.eps : null;  // shares ≈ NI/EPS
  const rec = {
    epsTTM: (cur.eps != null && isFinite(cur.eps)) ? cur.eps : null,
    bvps: (pos(cur.equity) && pos(shares)) ? cur.equity / shares : null,
    de: (pos(cur.equity) && cur.liabilities != null) ? cur.liabilities / cur.equity : null,
    roe: pos(cur.equity) && cur.ni != null ? cur.ni / cur.equity : null,
    npm: pos(cur.revenue) && cur.ni != null ? cur.ni / cur.revenue : null,
    cr: pos(cur.curLiab) && cur.curAssets != null ? cur.curAssets / cur.curLiab : null,
    revG: (prev && pos(prev.revenue) && cur.revenue != null) ? cur.revenue / prev.revenue - 1 : null,
    epsG: (prev && pos(prev.eps) && cur.eps != null) ? cur.eps / prev.eps - 1 : null,
  };
  return Object.values(rec).some(v => v != null) ? rec : null;
}

// Pure: the AUTOPSY sub-scores for one name at one rebalance, via the app's own valueScore engine.
export function autopsyValues(parsed, asOfMs, price){
  const rec = recAsOf(parsed, asOfMs);
  const vs = rec ? valueScore(meritMetrics(rec, price)) : null;
  if(!vs) return { AUTOPSY_cheap: null, AUTOPSY_healthy: null, AUTOPSY_growing: null, merit: null };
  return { AUTOPSY_cheap: vs.cheap, AUTOPSY_healthy: vs.healthy, AUTOPSY_growing: vs.growing, merit: vs.total };
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
// ─── Robustness (angle A): liquidity screen + beta/sector neutralisation ──────
// Why: the survivorship-free roster is heavy with DE-LISTED micro-caps whose low REALIZED volatility
// is often stale-price illusion (a name that barely trades has artificially smooth returns → fake
// "low-vol premium"). And a cross-sectional factor can be a SECTOR or pure-BETA bet in disguise. These
// pure helpers let the harness re-measure every slice on a LIQUID sub-universe and after removing the
// market-beta / sector component — the charter's "alpha, not beta" made testable.

export function dollarVol(bar){ return (bar.close > 0 && bar.volume > 0) ? bar.close * bar.volume : 0; }

// Median trailing dollar-volume over the `win` bars ending at idx (inclusive). Pure, point-in-time.
export function trailingMedianDollarVol(series, idx, win = LIQ_WIN){
  const lo = Math.max(0, idx - win + 1);
  const vals = [];
  for(let i = lo; i <= idx; i++) vals.push(dollarVol(series[i]));
  if(!vals.length) return 0;
  vals.sort((a, b) => a - b);
  const m = vals.length >> 1;
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2;
}

// Is the name tradeable at bar idx? Price floor AND trailing-median dollar-volume floor. Point-in-time.
export function liquidAt(series, idx, { minADV = LIQ_MIN_ADV, minPrice = LIQ_MIN_PRICE, win = LIQ_WIN } = {}){
  if(!series[idx] || !(series[idx].close >= minPrice)) return false;
  return trailingMedianDollarVol(series, idx, win) >= minADV;
}

// Daily simple returns keyed by bar timestamp (for beta alignment). Pure.
export function dailyReturnsByT(series){
  const m = new Map();
  for(let i = 1; i < series.length; i++){
    const p0 = series[i - 1].close, p1 = series[i].close;
    if(p0 > 0 && p1 > 0) m.set(series[i].t, p1 / p0 - 1);
  }
  return m;
}

// Trailing market beta = cov(name,mkt)/var(mkt) over the `win` bars ending at idx, aligned by
// timestamp to the market-return map. Pure; null when too few overlapping bars. No-lookahead (≤ idx).
export function trailingBeta(series, mktRetByT, idx, win = BETA_WIN){
  const lo = Math.max(1, idx - win + 1);
  const ns = [], ms = [];
  for(let i = lo; i <= idx; i++){
    const p0 = series[i - 1].close, p1 = series[i].close;
    const mr = mktRetByT.get(series[i].t);
    if(p0 > 0 && p1 > 0 && mr != null) { ns.push(p1 / p0 - 1); ms.push(mr); }
  }
  if(ns.length < 20) return null;
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const mn = mean(ns), mm = mean(ms);
  let cov = 0, varM = 0;
  for(let i = 0; i < ns.length; i++){ cov += (ns[i] - mn) * (ms[i] - mm); varM += (ms[i] - mm) ** 2; }
  return varM > 0 ? cov / varM : null;
}

// Beta-neutral IC: per period, cross-sectionally regress fwdRet on beta (OLS), recompute rank-IC on
// the RESIDUAL forward return. If the IC survives, the edge is alpha; if it collapses, it was a beta
// bet. Mirrors study-lib's sectorNeutralIC contract (verdict + retention). Pure.
export function betaNeutralIC(observations){
  const byP = new Map();
  for(const r of observations){ if(!byP.has(r.period)) byP.set(r.period, []); byP.get(r.period).push(r); }
  const neutral = [], raw = [];
  for(const [, rows] of byP){
    const clean = rows.filter(r => r.merit != null && isFinite(r.merit) && r.fwdRet != null && isFinite(r.fwdRet) && r.beta != null && isFinite(r.beta));
    if(clean.length < 3) continue;
    const n = clean.length;
    const mb = clean.reduce((a, r) => a + r.beta, 0) / n;
    const mf = clean.reduce((a, r) => a + r.fwdRet, 0) / n;
    let cov = 0, varB = 0;
    for(const r of clean){ cov += (r.beta - mb) * (r.fwdRet - mf); varB += (r.beta - mb) ** 2; }
    if(!(varB > 0)) continue;
    const slope = cov / varB, intercept = mf - slope * mb;
    const resid = clean.map(r => ({ merit: r.merit, fwdRet: r.fwdRet - (intercept + slope * r.beta) }));
    const icN = rankIC(resid), icR = rankIC(clean);
    if(icN != null && icR != null){ neutral.push(icN); raw.push(icR); }
  }
  if(neutral.length < 6) return { available: false, periods: neutral.length };
  const nStat = assessSignificance(neutral);
  const rawMean = raw.reduce((a, b) => a + b, 0) / raw.length;
  const retention = Math.abs(rawMean) > 1e-9 ? round(nStat.mean / rawMean) : null;
  const ok = v => v === "SIGNIFICANT" || v === "SUGGESTIVE";
  const verdict = !ok(nStat.verdict) ? "BETA-DRIVEN (mostly market)"
    : (retention != null && retention >= 0.5) ? "SURVIVES (alpha)"
    : "PARTLY BETA-DRIVEN";
  return { available: true, periods: neutral.length, meanIC: nStat.mean, icT: nStat.t,
    significance: nStat.verdict, rawMeanIC: round(rawMean), retention, verdict };
}

export function buildPanel(barsByTicker, dates, { minBars = MIN_BARS, fundamentals = null, market = null, sectorOf = null, liquidity = false } = {}){
  const rows = [];
  const mktRetByT = market ? dailyReturnsByT(market.slice().sort((a, b) => a.t - b.t)) : null;
  for(const [sym, bars] of Object.entries(barsByTicker)){
    if(!bars || bars.length < minBars) continue;
    const series = bars.slice().sort((a, b) => a.t - b.t);
    const parsed = fundamentals ? fundamentals[sym] : null;       // point-in-time financials, if loaded
    const sector = sectorOf ? (sectorOf[sym] || null) : null;
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
      if(parsed) Object.assign(values, autopsyValues(parsed, rb, entry));   // AUTOPSY cheap/healthy/growing/merit, point-in-time
      const row = { sym, period: iso(rb), fwdRet: exit / entry - 1, values };
      if(liquidity) row.liquid = liquidAt(series, idx);                       // tradeable at this bar? (point-in-time)
      if(sectorOf) row.sector = sector;                                       // SIC division for sector-neutral IC
      if(mktRetByT) row.beta = trailingBeta(series, mktRetByT, idx);          // trailing market beta for beta-neutral IC
      rows.push(row);
    }
  }
  return rows;
}

// Extract the factor-agnostic observation array study-lib consumes, for one contributor.
export function obsFor(panel, name){
  return panel.map(r => ({ sym: r.sym, period: r.period, merit: r.values[name], fwdRet: r.fwdRet }));
}

// Same, but carrying the sector + beta tags the neutralisation diagnostics need.
export function obsForNeutral(panel, name){
  return panel.map(r => ({ sym: r.sym, period: r.period, merit: r.values[name], fwdRet: r.fwdRet, sector: r.sector ?? null, beta: r.beta ?? null }));
}

// Per-contributor robustness row: raw IC, IC on the LIQUID subset, and sector/beta-neutral verdicts.
export function robustnessFor(panel, name){
  const liquid = panel.filter(r => r.liquid);
  const liqStat = liquid.length ? assessSignificance(periodStats(obsFor(liquid, name)).map(p => p.ic)) : { mean: null, t: null, n: 0, verdict: "NO DATA" };
  const neutralObs = obsForNeutral(panel, name);
  return {
    name,
    liquidIC: liqStat.mean, liquidT: liqStat.t, liquidPeriods: liqStat.n, liquidVerdict: liqStat.verdict,
    sectorNeutral: sectorNeutralIC(neutralObs),
    betaNeutral: betaNeutralIC(neutralObs),
  };
}

// ─── Dimensionality (angle B): unique/incremental IC + PCA "effective number of bets" ─────────
// The pie's slices are UNIVARIATE — they overstate how many independent edges exist when factors
// overlap (the corr matrix shows healthy↔merit ≈ 0.84). These pure helpers answer two questions:
//  • UNIQUE IC: what does each selector add AFTER removing what every OTHER selector explains? (a
//    redundant factor's unique IC collapses toward 0; an independent one keeps most of its raw IC.)
//  • PCA: how few real axes do the selectors collapse to (the "effective number of bets")?

// Solve the small linear system Ax=b by Gaussian elimination with partial pivoting. null if singular.
export function solveLinear(A, b){
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for(let c = 0; c < n; c++){
    let piv = c;
    for(let r = c + 1; r < n; r++) if(Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if(Math.abs(M[piv][c]) < 1e-12) return null;
    [M[c], M[piv]] = [M[piv], M[c]];
    for(let r = 0; r < n; r++){
      if(r === c) continue;
      const f = M[r][c] / M[c][c];
      for(let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  // After full Gauss-Jordan elimination each row is [pivot·x_i | rhs], so x_i = rhs / pivot.
  return M.map((row, i) => row[n] / row[i]);
}

// OLS residuals of y on the columns X (each X[i] is the regressor row for obs i, WITHOUT intercept —
// an intercept is added). Optional ridge λ on the non-intercept diagonal keeps the normal equations
// solvable under near-collinear regressors (e.g. healthy/merit ≈ 0.84). Returns y minus the fit, or
// null if still singular. Standardise the columns before calling so λ is scale-invariant.
export function olsResidual(y, X, ridge = 0){
  const n = y.length; if(!n) return null;
  const k = X[0].length + 1;                       // +1 intercept
  const D = X.map(r => [1, ...r]);                  // design matrix with intercept
  const XtX = Array.from({ length: k }, () => Array(k).fill(0));
  const Xty = Array(k).fill(0);
  for(let i = 0; i < n; i++){
    for(let a = 0; a < k; a++){
      Xty[a] += D[i][a] * y[i];
      for(let b = 0; b < k; b++) XtX[a][b] += D[i][a] * D[i][b];
    }
  }
  for(let a = 1; a < k; a++) XtX[a][a] += ridge;   // don't penalise the intercept
  const beta = solveLinear(XtX, Xty);
  if(!beta || beta.some(v => v == null || !isFinite(v))) return null;
  return y.map((yi, i) => yi - D[i].reduce((s, x, a) => s + x * beta[a], 0));
}

// Unique (partial) IC: per period, residualise the target selector against ALL the others (cross-
// sectional OLS), then rank-IC the residual against the forward return. Aggregated like standaloneICs.
// Columns are z-scored per period (via standardizeByPeriod) so price factors (~1) and fundamental
// scores (~100) share a scale; a small ridge keeps it solvable under the collinear fundamentals.
export function uniqueIC(panel, names){
  const std = standardizeByPeriod(panel, names);            // {period, fwdRet, z:{name:zval}} complete rows
  const byP = new Map();
  for(const r of std){ if(!byP.has(r.period)) byP.set(r.period, []); byP.get(r.period).push(r); }
  return names.map(target => {
    const others = names.filter(n => n !== target);
    const ics = [];
    for(const [, rows] of byP){
      if(rows.length < others.length + 3) continue;          // need more obs than regressors
      const y = rows.map(r => r.z[target]);
      const X = rows.map(r => others.map(n => r.z[n]));
      const resid = olsResidual(y, X, 1e-6);
      if(!resid) continue;
      const ic = rankIC(rows.map((r, i) => ({ merit: resid[i], fwdRet: r.fwdRet })));
      if(ic != null) ics.push(ic);
    }
    const st = assessSignificance(ics);
    return { name: target, uniqueIC: st.mean, t: st.t, nPeriods: st.n, verdict: st.verdict };
  });
}

// Per-period z-scored selector rows (mean 0, sd 1 within each period across names). Drops rows with
// any non-finite selector so the matrix is complete. Pure.
export function standardizeByPeriod(panel, names){
  const out = [];
  const byP = new Map();
  for(const r of panel){ if(!byP.has(r.period)) byP.set(r.period, []); byP.get(r.period).push(r); }
  for(const [period, rows] of byP){
    const clean = rows.filter(r => names.every(n => r.values[n] != null && isFinite(r.values[n])));
    if(clean.length < 3) continue;
    const stat = {};
    for(const n of names){
      const v = clean.map(r => r.values[n]);
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) || 1;
      stat[n] = { m, sd };
    }
    for(const r of clean){
      const z = {}; for(const n of names) z[n] = (r.values[n] - stat[n].m) / stat[n].sd;
      out.push({ period, fwdRet: r.fwdRet, z });
    }
  }
  return out;
}

// Pearson correlation matrix of the standardised selector columns (pooled across periods → the
// average within-period cross-sectional correlation). Returns an n×n array aligned to `names`.
export function corrMatrixPearson(stdRows, names){
  const n = names.length;
  const C = Array.from({ length: n }, () => Array(n).fill(0));
  for(let a = 0; a < n; a++) for(let b = a; b < n; b++){
    let sxy = 0, sx = 0, sy = 0;
    for(const r of stdRows){ const x = r.z[names[a]], y = r.z[names[b]]; sxy += x * y; sx += x * x; sy += y * y; }
    const c = (sx > 0 && sy > 0) ? sxy / Math.sqrt(sx * sy) : 0;
    C[a][b] = C[b][a] = c;
  }
  return C;
}

// Jacobi eigenvalue algorithm for a small symmetric matrix. Returns eigenvalues + eigenvectors sorted
// by DESCENDING eigenvalue. Pure; ample for the ≤8×8 correlation matrices here.
export function jacobiEig(A){
  const n = A.length;
  const a = A.map(r => r.slice());
  const V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i === j ? 1 : 0));
  for(let sweep = 0; sweep < 100; sweep++){
    let off = 0;
    for(let p = 0; p < n; p++) for(let q = p + 1; q < n; q++) off += a[p][q] * a[p][q];
    if(off < 1e-14) break;
    for(let p = 0; p < n; p++) for(let q = p + 1; q < n; q++){
      if(Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for(let k = 0; k < n; k++){
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for(let k = 0; k < n; k++){
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for(let k = 0; k < n; k++){
        const vkp = V[k][p], vkq = V[k][q];
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const vals = a.map((row, i) => row[i]);
  const idx = vals.map((v, i) => i).sort((x, y) => vals[y] - vals[x]);
  return { values: idx.map(i => vals[i]), vectors: idx.map(i => V.map(row => row[i])) };
}

// Effective number of independent bets from the eigenvalue spectrum: the participation ratio
// (Σλ)²/Σλ² (1 = one dominant axis, n = fully independent), plus the Kaiser count (λ>1). Pure.
export function effectiveBets(eigenvalues){
  const pos = eigenvalues.map(v => Math.max(0, v));
  const sum = pos.reduce((a, b) => a + b, 0);
  const sumSq = pos.reduce((a, b) => a + b * b, 0);
  return { participationRatio: sumSq > 0 ? round(sum * sum / sumSq) : null, kaiser: eigenvalues.filter(v => v > 1).length };
}

// PCA of the cross-sectional selector panel → dimensionality verdict + the top components' loadings.
export function pca(panel, names){
  const std = standardizeByPeriod(panel, names);
  if(std.length < names.length + 3) return { available: false, rows: std.length };
  const C = corrMatrixPearson(std, names);
  const { values, vectors } = jacobiEig(C);
  const total = values.reduce((a, v) => a + Math.max(0, v), 0) || 1;
  const eb = effectiveBets(values);
  let cum = 0;
  const components = values.slice(0, Math.min(3, names.length)).map((v, p) => {
    cum += Math.max(0, v) / total;
    const loadings = {}; names.forEach((n, i) => { loadings[n] = round(vectors[p][i]); });
    return { pc: p + 1, eigenvalue: round(v), varPct: round(100 * Math.max(0, v) / total), cumVarPct: round(100 * cum), loadings };
  });
  return { available: true, rows: std.length, names, eigenvalues: values.map(round),
    effectiveBets: eb.participationRatio, kaiser: eb.kaiser, components };
}

// ─── Regime split (angle C): is a factor's edge durable, or just a bull-market trend? ──────────
// Classify each rebalance by the broad-market trend (SPY close vs its own trailing 200-DMA, point-in-
// time), then re-measure each selector's IC separately in BULL and BEAR months. A durable edge holds
// the same sign (ideally significant) in both; a bull-only edge is a trend artifact, not skill.
export function marketRegimeByDate(market, dates, win = 200){
  const m = market.slice().sort((a, b) => a.t - b.t);
  const closes = m.map(b => b.close);
  const out = new Map();
  for(const rb of dates){
    let idx = -1;
    for(let i = 0; i < m.length; i++){ if(m[i].t <= rb) idx = i; else break; }
    if(idx < win - 1){ out.set(iso(rb), null); continue; }
    const smaVal = sma(closes.slice(0, idx + 1), win);     // trailing 200-DMA at this rebalance
    out.set(iso(rb), smaVal != null ? (m[idx].close >= smaVal ? "bull" : "bear") : null);
  }
  return out;
}

// Split each selector's per-period IC series into bull/bear buckets by regimeOf (period → regime).
export function regimeSplitIC(panel, names, regimeOf){
  const ok = v => v === "SIGNIFICANT" || v === "SUGGESTIVE";
  return names.map(name => {
    const ps = periodStats(obsFor(panel, name));
    const bull = [], bear = [];
    for(const p of ps){ const r = regimeOf.get(p.period); if(r === "bull") bull.push(p.ic); else if(r === "bear") bear.push(p.ic); }
    const bs = assessSignificance(bull), br = assessSignificance(bear);
    const sameSign = bs.mean != null && br.mean != null && bs.mean !== 0 && Math.sign(bs.mean) === Math.sign(br.mean);
    const thin = bs.n < 4 || br.n < 4;
    const verdict = thin ? "INSUFFICIENT SPLIT"
      : (ok(bs.verdict) && ok(br.verdict) && sameSign) ? "DURABLE (both regimes)"
      : (ok(bs.verdict) && !ok(br.verdict)) ? "BULL-ONLY (trend artifact?)"
      : (!ok(bs.verdict) && ok(br.verdict)) ? "BEAR-ONLY"
      : sameSign ? "CONSISTENT SIGN (weak both)"
      : "REGIME-FLIP (sign changes)";
    return { name,
      bull: { meanIC: bs.mean, t: bs.t, nPeriods: bs.n },
      bear: { meanIC: br.mean, t: br.t, nPeriods: br.n },
      sameSign, verdict };
  });
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
    "AUTOPSY (cheap/healthy/growing) + merit are reconstructed point-in-time from Polygon /vX/reference/financials (filing_date ≤ rebalance) and scored by the app's OWN valueScore(meritMetrics(...)) — no re-implementation. Names without financials drop from those slices only.",
    "OUTLOOK is EXCLUDED from the pie by construction, not by oversight: it is a MARKET-TIMING projection (the same 3-index move applied to every name), so it has ~0 cross-sectional name-selection variance and cannot rank names — a slice would be misleading. It is judged on its own alpha-vs-buy-&-hold backtest in the app, not here.",
    "1-month forward windows, monthly rebalance, only COMPLETE windows (no-lookahead). One cross-section per rebalance → modest power; INCONCLUSIVE is an acceptable outcome.",
    "ROBUSTNESS (angle A): every slice is RE-MEASURED on a liquidity-screened subset (price≥$" + LIQ_MIN_PRICE + ", trailing-median $" + (LIQ_MIN_ADV/1e6) + "M ADV) and after BETA- and SECTOR-neutralisation. A slice that collapses on liquid names was a stale-price micro-cap artifact; one that dies sector/beta-neutral was a sector or market bet, not stock selection. This is the charter's 'alpha, not beta' made testable — watch lowvol especially.",
    "DIMENSIONALITY (angle B): UNIQUE IC residualises each selector against all the others (cross-sectional OLS) → its contribution AFTER redundancy; PCA's 'effective bets' (participation ratio of the eigenvalues) counts the truly independent axes. Univariate pie slices OVERSTATE breadth when factors overlap (healthy/merit ≈ 0.84) — this collapses them to the real few.",
    "REGIME SPLIT (angle C): each selector's IC is re-measured in BULL vs BEAR months (SPY vs its 200-DMA, point-in-time). A DURABLE edge holds the same sign in both regimes; a BULL-ONLY edge is a trend artifact that won't survive a market turn. All ~5y of history sits in one macro cycle, so the split has limited power — read it as a direction, not a proof.",
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

// Polygon /vX/reference/financials (annual, ascending) → parsed point-in-time filings. Best-effort:
// a name with no financials simply drops out of the AUTOPSY contributors (its bars factors still count).
async function fetchFinancials(sym, key){
  const u = "https://api.polygon.io/vX/reference/financials?ticker=" + encodeURIComponent(sym) +
    "&timeframe=annual&order=asc&limit=20&apiKey=" + encodeURIComponent(key);
  const r = await fetch(u);
  if(!r.ok) throw new Error("financials HTTP " + r.status);
  const j = await r.json();
  return parsePolyFinancials(j.results || []);
}

function bar(pct){ const n = Math.round(Math.max(0, Math.min(100, pct || 0)) / 4); return "█".repeat(n) + "·".repeat(25 - n); }

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY — the factor-interaction study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source, survivorshipFree } = resolveUniverse();
  console.log("factor-interaction universe: " + source);

  const barsByTicker = {}; const fundamentals = {}; const errors = []; let fundCount = 0;
  for(const sym of tickers){
    try{
      const bars = await fetchDaily(sym, key);
      if(bars.length < MIN_BARS) throw new Error(`only ${bars.length} bars (<${MIN_BARS})`);
      barsByTicker[sym] = bars;
      // Fundamentals are best-effort — a name with none keeps its bars contributors, just no AUTOPSY slice.
      try{ const fin = await fetchFinancials(sym, key); if(fin.length){ fundamentals[sym] = fin; fundCount++; } }catch{ /* no financials → skip AUTOPSY for this name */ }
      console.log("✓ " + sym.padEnd(6) + " " + bars.length + " daily bars" + (fundamentals[sym] ? (" + " + fundamentals[sym].length + " filings") : ""));
    }catch(e){ errors.push(sym + ": " + (e.message || e)); console.warn("✗ " + sym.padEnd(6) + " — " + (e.message || e)); }
  }

  // Robustness inputs (angle A) — best-effort, never fatal: a market proxy (SPY) for beta and the SIC
  // sector map. If either fails the pie still emits; only that neutralisation column goes unavailable.
  let market = null;
  try{ market = await fetchDaily("SPY", key); console.log("market proxy: SPY " + market.length + " daily bars (for beta)"); }
  catch(e){ console.warn("SPY fetch failed — beta-neutral IC unavailable: " + (e.message || e)); }
  let sectorOf = null;
  try{ sectorOf = await fetchSectorMap(Object.keys(barsByTicker), key); console.log("sectors resolved: " + Object.keys(sectorOf || {}).length + "/" + Object.keys(barsByTicker).length); }
  catch(e){ console.warn("sector map failed — sector-neutral IC unavailable: " + (e.message || e)); }

  const dates = grid(1);
  const haveFunda = fundCount > 0;
  const panel = buildPanel(barsByTicker, dates, { fundamentals: haveFunda ? fundamentals : null, market, sectorOf, liquidity: true });
  // Whole-app pie: price/risk FACTORS + 13 technical VOTES + (when financials loaded) the AUTOPSY
  // fundamentals (cheap/healthy/growing/merit). OUTLOOK is documented-excluded (market-timing, not
  // cross-sectional — see caveats).
  const FUNDA = haveFunda ? FUNDAMENTAL_NAMES : [];
  const ALL = [...FACTOR_NAMES, ...FUNDA, ...VOTE_NAMES];
  const kindOf = n => FACTOR_NAMES.includes(n) ? "factor" : FUNDAMENTAL_NAMES.includes(n) ? "fundamental" : "vote";
  const ics = standaloneICs(panel, ALL);
  const pie = contributionPie(ics);

  // ─── ROBUSTNESS (angle A): does the edge survive a liquidity screen + beta/sector neutralisation? ──
  const liquidRows = panel.filter(r => r.liquid);
  const liquidPie = contributionPie(standaloneICs(liquidRows, ALL));
  const robustness = {
    liquidity: { minADV: LIQ_MIN_ADV, minPrice: LIQ_MIN_PRICE, advWindow: LIQ_WIN, betaWindow: BETA_WIN,
      liquidRows: liquidRows.length, totalRows: panel.length,
      liquidNames: new Set(liquidRows.map(r => r.sym)).size, totalNames: Object.keys(barsByTicker).length },
    market: market ? "SPY" : null,
    sectorsResolved: sectorOf ? Object.keys(sectorOf).length : 0,
    perContributor: ALL.map(n => robustnessFor(panel, n)),
    liquidPie,
  };
  // Interactions + composite span the cross-sectional SELECTORS (price/risk factors + fundamentals).
  const selectors = [...FACTOR_NAMES, ...FUNDA];
  const corr = correlationMatrix(panel, selectors);
  const interactions = interactionScan(panel, selectors);
  const icW = selectors.map(n => { const s = ics.find(x => x.name === n); return s && s.meanIC != null ? Math.abs(s.meanIC) : 0; });
  const compositeEqual = combinedComposite(panel, selectors);
  const compositeICw = combinedComposite(panel, selectors, { weights: icW });

  // ─── DIMENSIONALITY (angle B): unique/incremental IC + PCA "effective number of bets" ──────────
  const uIC = uniqueIC(panel, selectors);
  const dimensionality = {
    pca: pca(panel, selectors),
    uniqueIC: uIC.map(u => {
      const raw = ics.find(s => s.name === u.name);
      const rawIC = raw ? raw.meanIC : null;
      return { ...u, rawIC,
        retainedShare: (rawIC != null && Math.abs(rawIC) > 1e-9 && u.uniqueIC != null) ? round(u.uniqueIC / rawIC) : null };
    }),
  };

  // ─── REGIME SPLIT (angle C): is each selector's edge durable across bull/bear markets? ─────────
  let regimes = { available: false };
  if(market){
    const regimeOf = marketRegimeByDate(market, dates);
    const periodsInPanel = [...new Set(panel.map(r => r.period))];
    const bullPeriods = periodsInPanel.filter(p => regimeOf.get(p) === "bull").length;
    const bearPeriods = periodsInPanel.filter(p => regimeOf.get(p) === "bear").length;
    regimes = { available: true, method: "SPY close vs trailing 200-DMA (point-in-time)",
      bullPeriods, bearPeriods, perContributor: regimeSplitIC(panel, [...FACTOR_NAMES, ...FUNDA], regimeOf) };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(barsByTicker).length, withFinancials: fundCount, source, survivorshipFree, skipped: errors },
    source: { prices: "Polygon (adjusted daily close)", fundamentals: haveFunda ? "Polygon /vX/reference/financials (point-in-time by filing_date)" : "none loaded" },
    config: { rebalance: "monthly", forwardHorizon: "1 month", minBars: MIN_BARS, rows: panel.length },
    contributors: { factors: FACTOR_NAMES, fundamentals: FUNDA, votes: VOTE_NAMES, voteWeights: VOTE_WEIGHTS },
    excluded: { OUTLOOK: "market-timing projection (same index move applied to every name) — ~0 cross-sectional name-selection variance by construction; judged on its own alpha-vs-buy-&-hold backtest, not in this pie." },
    standaloneIC: ics.map(s => ({ ...s, kind: kindOf(s.name), engineWeight: VOTE_WEIGHTS[s.name] || null })),
    pie,
    correlationMatrix: corr,
    interactions,
    composite: { equalWeight: compositeEqual, icWeighted: compositeICw },
    robustness,
    dimensionality,
    regimes,
    caveats: caveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT, "factor-interaction-study.json"), JSON.stringify(out) + "\n");

  // ─── console rollup ───────────────────────────────────────────────────────
  console.log("\n════ FACTOR-INTERACTION PIE (|rank-IC| share of weighted data value) ════");
  console.log("  panel rows: " + panel.length + " over " + Object.keys(barsByTicker).length + " names\n");
  for(const p of pie){
    const kind = (FACTOR_NAMES.includes(p.name) ? "factor" : FUNDAMENTAL_NAMES.includes(p.name) ? "fundamtl" : "vote  ").padEnd(8);
    const ew = VOTE_WEIGHTS[p.name] != null ? ` engW=${VOTE_WEIGHTS[p.name]}` : "";
    console.log("  " + p.name.padEnd(15) + " " + kind + " " + bar(p.weightPct) + " " +
      String(p.weightPct).padStart(5) + "%  IC=" + (p.meanIC ?? "n/a") + " (t=" + (p.t ?? "n/a") + ", " + p.verdict + ")" + ew);
  }
  console.log("\n════ TOP SELECTOR INTERACTIONS (IC of A within B's top vs bottom tertile) ════");
  for(const x of interactions.slice(0, 6)){
    console.log("  " + x.factor.padEnd(9) + " | " + x.conditionedOn.padEnd(9) +
      " top=" + x.topIC + " bottom=" + x.bottomIC + " LIFT=" + x.lift + " (n=" + x.nPeriods + ")");
  }
  console.log("\n════ COMBINED COMPOSITE (z-scored blend of the cross-sectional selectors) ════");
  const cc = compositeEqual;
  console.log("  equal-weight   meanIC=" + cc.meanIC + " t=" + cc.t + " (" + cc.verdict + "), n=" + cc.nPeriods +
    "; best single=" + (cc.bestSingle ? cc.bestSingle.name + " " + cc.bestSingle.meanIC : "n/a") + ", gain=" + cc.gain);
  console.log("  IC-weighted    meanIC=" + compositeICw.meanIC + " t=" + compositeICw.t + " (" + compositeICw.verdict + ")");

  console.log("\n════ ROBUSTNESS (angle A): liquidity screen + beta/sector neutralisation ════");
  console.log("  liquid: " + robustness.liquidity.liquidRows + "/" + robustness.liquidity.totalRows + " rows, " +
    robustness.liquidity.liquidNames + "/" + robustness.liquidity.totalNames + " names (price≥$" + LIQ_MIN_PRICE +
    ", $" + (LIQ_MIN_ADV/1e6) + "M ADV) · sectors " + robustness.sectorsResolved + " · beta vs " + (robustness.market || "—"));
  const sig = ic => ic == null ? " n/a " : (ic >= 0 ? "+" : "") + ic.toFixed(4);
  for(const n of [...FACTOR_NAMES, ...FUNDA]){
    const r = robustness.perContributor.find(x => x.name === n); if(!r) continue;
    const full = ics.find(x => x.name === n);
    const sn = r.sectorNeutral.available ? r.sectorNeutral.verdict : "n/a";
    const bn = r.betaNeutral.available ? r.betaNeutral.verdict : "n/a";
    console.log("  " + n.padEnd(15) + " raw=" + sig(full && full.meanIC) + "  liquid=" + sig(r.liquidIC) +
      " (t=" + (r.liquidT == null ? "–" : r.liquidT.toFixed(1)) + ")  sector→" + sn + "  beta→" + bn);
  }
  console.log("  ↳ a slice that CRATERS on liquid names was stale-price micro-cap noise; one that dies sector/beta-neutral was a sector/market bet.");

  console.log("\n════ DIMENSIONALITY (angle B): how few independent bets do the selectors really hold? ════");
  const P = dimensionality.pca;
  if(P.available){
    console.log("  eigenvalues: [" + P.eigenvalues.join(", ") + "]");
    console.log("  EFFECTIVE BETS = " + P.effectiveBets + " of " + selectors.length + " selectors (Kaiser λ>1: " + P.kaiser + ")");
    for(const c of P.components){
      const load = Object.entries(c.loadings).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 4)
        .map(([n, v]) => n + " " + (v >= 0 ? "+" : "") + v).join(", ");
      console.log("  PC" + c.pc + " (" + c.varPct + "% var, cum " + c.cumVarPct + "%): " + load);
    }
  } else console.log("  PCA unavailable (only " + P.rows + " complete rows).");
  console.log("  UNIQUE IC (each selector's contribution AFTER removing the others):");
  for(const u of dimensionality.uniqueIC){
    const rs = u.retainedShare == null ? "–" : Math.round(u.retainedShare * 100) + "%";
    console.log("    " + u.name.padEnd(15) + " raw=" + (u.rawIC ?? "n/a") + " → unique=" + (u.uniqueIC ?? "n/a") +
      " (t=" + (u.t == null ? "–" : u.t.toFixed(1)) + ", keeps " + rs + ") " + u.verdict);
  }
  console.log("  ↳ a selector whose unique IC ≈ 0 is REDUNDANT (its edge is already in the others); one that keeps most of its raw IC is an independent axis.");

  if(regimes.available){
    console.log("\n════ REGIME SPLIT (angle C): bull vs bear-market IC (SPY vs 200-DMA) ════");
    console.log("  " + regimes.bullPeriods + " bull months, " + regimes.bearPeriods + " bear months");
    const f = x => x == null ? " n/a " : (x >= 0 ? "+" : "") + x.toFixed(4);
    for(const r of regimes.perContributor){
      console.log("    " + r.name.padEnd(15) +
        " bull=" + f(r.bull.meanIC) + " (t" + (r.bull.t == null ? "–" : r.bull.t.toFixed(1)) + ",n" + r.bull.nPeriods + ")" +
        "  bear=" + f(r.bear.meanIC) + " (t" + (r.bear.t == null ? "–" : r.bear.t.toFixed(1)) + ",n" + r.bear.nPeriods + ")  → " + r.verdict);
    }
    console.log("  ↳ DURABLE = same-sign edge in both regimes; BULL-ONLY = a trend artifact that dies when the market turns.");
  }

  console.log("\nWrote factor-interaction-study.json" + (errors.length ? (" (" + errors.length + " skipped)") : "") + ".");
  console.log("IN-SAMPLE only — not proven, not wired into any gate. Only the OOS ledger under FDR counts.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
