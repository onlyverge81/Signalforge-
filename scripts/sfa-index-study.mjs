// SFA12 × Index-Move research study — answers a specific batch of questions with REAL Polygon data.
// Runs in CI (POLYGON_API_KEY + egress available); writes sfa-index-study.json + a console report.
//
// Questions (user-posed):
//  Q1 SFA12 gap vs actual price — is the signal more reliable when price ALIGNS within a threshold
//     of SFA12, and is it more reliable in UP vs DOWN regimes? Does a large gap predict mean-reversion?
//  Q2 Avg trailing-20-DAY index move% — does it "ring true" more day→day, week→week or month→month?
//     How often is the projected gain% REACHED, and what FRACTION of it is actually realized?
//  Q3 Combined (SUM of the 3 indexes) move% — same questions.
//  Q4 Do the Sum/Avg + their cross-index DISPERSION help identify an up/down regime on the horizon?
//  Q5 Combine vs Avg — correlation (they're the same signal ×3); the real info is index DISPERSION.
//
// Method: daily Polygon bars (the only vendor); 10 liquid US large-caps + SPY/DIA/QQQ proxies.
// Horizons measured as forward 1 / 5 / 21 trading days (day / week / month). Point-in-time —
// every projection at bar i is scored against bars i+H with no lookahead. In-sample by nature
// (a measurement, not a promotion); the OOS ledger remains the only verdict for any edge found.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sfa12Series, avgIndexGainByDate, atr, sma } from "./engine.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const STOCKS  = (process.env.SFA_STOCKS || "AAPL,MSFT,NVDA,AMZN,GOOGL,META,TSLA,JPM,XOM,JNJ").split(",");
const PROXIES = ["SPY", "DIA", "QQQ"];
const HORIZONS = { day: 1, week: 5, month: 21 };
const WINDOW = +(process.env.SFA_WINDOW || 130);   // ~6 months of trading days analysed (after warmup)
const ALIGN_ATR = 0.5;                              // |price−SFA12| < 0.5·ATR ⇒ "aligned"

const round = (x, d = 3) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const stdev = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); };
const pearson = (x, y) => {
  const n = Math.min(x.length, y.length); if (n < 3) return null;
  const mx = mean(x.slice(0, n)), my = mean(y.slice(0, n));
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; num += a * b; dx += a * a; dy += b * b; }
  return (dx <= 0 || dy <= 0) ? null : round(num / Math.sqrt(dx * dy));
};

// Rolling SMA over a close array (null until n filled).
function smaArr(closes, n) { const out = []; let s = 0; for (let i = 0; i < closes.length; i++) { s += closes[i]; if (i >= n) s -= closes[i - n]; out.push(i >= n - 1 ? s / n : null); } return out; }

async function loadDaily(sym, key) {
  const c = await fetchPolygonAggs(sym, "1day", key, { minBars: 60 });
  return c.map(b => ({ date: b.time ? new Date(b.time).toISOString().slice(0, 10) : b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }))
          .filter(d => d.close > 0);
}

// ── Q1: SFA12 gap vs price, bucketed by alignment + regime; forward 5-day behaviour. ──
function sfaAnalysis(rows) {
  const closes = rows.map(d => d.close);
  const sfa = sfa12Series(rows, 30);                          // comp series (engine-identical)
  const compAt = new Map(sfa.series.map(p => [p.i, p.value]));
  const s5 = smaArr(closes, 5), s10 = smaArr(closes, 10), s20 = smaArr(closes, 20);
  const H = HORIZONS.week;
  const buckets = { aligned: [], extended: [] }, regime = { UP: [], DOWN: [] };
  const gapMag = [], fwdRevert = [];                          // for mean-reversion correlation
  const start = Math.max(30, rows.length - WINDOW);
  for (let i = start; i < rows.length - H; i++) {
    const comp = compAt.get(i); if (comp == null) continue;
    const a = atr(rows.slice(0, i + 1), 14); if (!(a > 0)) continue;
    const gapAtr = (closes[i] - comp) / a;                    // +: price above SFA12 (extended up)
    const fwd = (closes[i + H] - closes[i]) / closes[i] * 100;
    (Math.abs(gapAtr) < ALIGN_ATR ? buckets.aligned : buckets.extended).push(fwd);
    const up = s5[i] > s10[i] && s10[i] > s20[i], down = s5[i] < s10[i] && s10[i] < s20[i];
    if (up) regime.UP.push(fwd); else if (down) regime.DOWN.push(fwd);
    // mean-reversion: does a bigger gap predict the gap CLOSING (fwd move opposite the gap sign)?
    gapMag.push(gapAtr); fwdRevert.push(-Math.sign(gapAtr) * fwd);
  }
  const stat = a => ({ n: a.length, meanFwd5: round(mean(a)), medFwd5: round(median(a)), hitUp: round(a.filter(v => v > 0).length / (a.length || 1) * 100, 1) });
  return {
    aligned: stat(buckets.aligned), extended: stat(buckets.extended),
    regimeUp: stat(regime.UP), regimeDown: stat(regime.DOWN),
    gapMeanReversionCorr: pearson(gapMag.map(Math.abs), fwdRevert),  // >0 ⇒ larger gap → more reversion
  };
}

// ── Q2/Q3: index projection realisation by horizon. projectedPct = index gain% applied 1:1 to
//    the stock; realizedFraction = actual stock move% / projectedPct; reached = hit-or-exceeded. ──
function realisation(rows, gainByDate, scale = 1) {
  const closes = rows.map(d => d.close);
  const out = {};
  for (const [name, H] of Object.entries(HORIZONS)) {
    const fracs = [], reached = [], dirHit = [];
    const start = Math.max(20, rows.length - WINDOW);
    for (let i = start; i < rows.length - H; i++) {
      const g0 = gainByDate.get(rows[i].date); if (g0 == null || g0 === 0) continue;
      const proj = g0 * scale;                                // projected % move
      const real = (closes[i + H] - closes[i]) / closes[i] * 100;
      fracs.push(real / proj);
      reached.push(proj > 0 ? (real >= proj ? 1 : 0) : (real <= proj ? 1 : 0));
      dirHit.push(Math.sign(real) === Math.sign(proj) ? 1 : 0);
    }
    out[name] = {
      n: fracs.length,
      reachedRate: round(mean(reached) * 100, 1),
      dirHitRate: round(mean(dirHit) * 100, 1),
      meanRealizedFrac: round(mean(fracs)),
      medianRealizedFrac: round(median(fracs)),
    };
  }
  return out;
}

// ── Q6: the one robust thread. Does conditioning a LONG on "market UP (avg-20 index > 0) AND
//    stock above SMA20", held ~1 month (21d), beat just being long? Compare the CONDITIONAL
//    21-day forward return (net of a round-trip cost) to the UNCONDITIONAL 21-day return. If
//    cond ≈ uncond, the filter is dressed-up beta (no selection edge); if cond ≫ uncond, the
//    market-up condition adds return. No lookahead (signal at i, return i→i+21).
const COST_RT = 0.1;   // ~10bps round-trip drag on each conditioned trade
function monthlyMarketUp(rows, gainByDate) {
  const closes = rows.map(d => d.close);
  const s20 = smaArr(closes, 20);
  const H = HORIZONS.month;
  const cond = [], uncond = [];
  const start = Math.max(20, rows.length - WINDOW);
  for (let i = start; i < rows.length - H; i++) {
    const r = (closes[i + H] - closes[i]) / closes[i] * 100;
    uncond.push(r);
    const g = gainByDate.get(rows[i].date);
    if (g != null && g > 0 && s20[i] != null && closes[i] >= s20[i]) cond.push(r - COST_RT);  // net of cost
  }
  return { cond, uncond };
}

async function main() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) { console.error("Set POLYGON_API_KEY — this study prices off Polygon (the only vendor)."); process.exit(2); }

  console.log("Loading proxies " + PROXIES.join(",") + " + " + STOCKS.length + " stocks…");
  const proxy = {}; for (const p of PROXIES) { try { proxy[p] = await loadDaily(p, key); console.log("  ✓ " + p + " " + proxy[p].length + " bars"); } catch (e) { console.warn("  ✗ " + p + " " + (e.message || e)); } }
  const proxyArrs = PROXIES.map(p => proxy[p]).filter(Boolean);
  if (proxyArrs.length < 2) { console.error("Need ≥2 index proxies; aborting."); process.exit(1); }

  // Avg trailing-20-day index gain% (the OUTLOOK driver) + SUM (=3×avg) + per-date dispersion.
  const avgGain = avgIndexGainByDate(proxyArrs, 20);
  const sumGain = new Map([...avgGain].map(([d, v]) => [d, v * proxyArrs.length]));
  // per-index 20-day gains for dispersion
  const perIdx = proxyArrs.map(a => avgIndexGainByDate([a], 20));
  const disp = new Map();
  for (const d of avgGain.keys()) { const vs = perIdx.map(m => m.get(d)).filter(v => v != null); if (vs.length === perIdx.length) disp.set(d, stdev(vs)); }

  const perStock = [], aggAvg = { day: [], week: [], month: [] }, aggSum = { day: [], week: [], month: [] };
  const allCond = [], allUncond = [];   // Q6 pooled monthly market-up vs unconditional
  const dispVsAcc = { disp: [], acc: [] };
  for (const sym of STOCKS) {
    let rows; try { rows = await loadDaily(sym, key); } catch (e) { console.warn("✗ " + sym + " " + (e.message || e)); continue; }
    if (rows.length < 60) continue;
    const sfa = sfaAnalysis(rows);
    const ra = realisation(rows, avgGain, 1);
    const rs = realisation(rows, sumGain, 1);
    perStock.push({ sym, bars: rows.length, sfa, avg: ra, sum: rs });
    for (const h of Object.keys(HORIZONS)) { if (ra[h].dirHitRate != null) aggAvg[h].push(ra[h]); if (rs[h].dirHitRate != null) aggSum[h].push(rs[h]); }
    const mm = monthlyMarketUp(rows, avgGain); allCond.push(...mm.cond); allUncond.push(...mm.uncond);
    // Q4: does dispersion track WEEKLY directional accuracy of the avg projection?
    const closes = rows.map(d => d.close), H = HORIZONS.week, start = Math.max(20, rows.length - WINDOW);
    for (let i = start; i < rows.length - H; i++) {
      const g = avgGain.get(rows[i].date), dv = disp.get(rows[i].date); if (g == null || g === 0 || dv == null) continue;
      const real = (closes[i + H] - closes[i]) / closes[i] * 100;
      dispVsAcc.disp.push(dv); dispVsAcc.acc.push(Math.sign(real) === Math.sign(g) ? 1 : 0);
    }
    console.log("  ✓ " + sym.padEnd(6) + " sfa-align meanFwd5=" + sfa.aligned.meanFwd5 + " vs extended=" + sfa.extended.meanFwd5 + " | up=" + sfa.regimeUp.meanFwd5 + " down=" + sfa.regimeDown.meanFwd5);
  }

  const rollup = agg => Object.fromEntries(Object.keys(HORIZONS).map(h => [h, {
    stocks: agg[h].length,
    reachedRate: round(mean(agg[h].map(o => o.reachedRate)), 1),
    dirHitRate: round(mean(agg[h].map(o => o.dirHitRate)), 1),
    meanRealizedFrac: round(mean(agg[h].map(o => o.meanRealizedFrac))),
    medianRealizedFrac: round(mean(agg[h].map(o => o.medianRealizedFrac))),
  }]));

  // Q5: combine vs avg correlation over time (≈1.0 by construction).
  const dates = [...avgGain.keys()].filter(d => sumGain.has(d));
  const combineVsAvgCorr = pearson(dates.map(d => avgGain.get(d)), dates.map(d => sumGain.get(d)));
  // SFA12 reliability rollup
  const sfaRoll = (k, f = "meanFwd5") => round(mean(perStock.map(p => p.sfa[k] && p.sfa[k][f]).filter(v => v != null)));
  // Q6: monthly market-up. condMean is NET of cost; edge = cond − uncond (does the filter add return
  // beyond just being long?). t is NAIVE (overlapping 21-day windows + pooled names → autocorrelated;
  // treat as a rough magnitude, not a p-value). edge ≤ 0 ⇒ "dressed-up beta", no selection skill.
  const condMean = mean(allCond), uncondMean = mean(allUncond);
  const condSe = allCond.length ? stdev(allCond) / Math.sqrt(allCond.length) : 0;
  const q6 = {
    nCond: allCond.length, inMarketPct: round(allCond.length / (allUncond.length || 1) * 100, 1),
    condMean21Net: round(condMean), uncondMean21: round(uncondMean),
    edge: round(condMean - uncondMean), condTStatNaive: round(condSe > 0 ? condMean / condSe : 0, 2),
    note: "LONG when avg-20 index>0 AND stock≥SMA20, 21-day hold, net of cost vs UNCONDITIONAL 21-day return. edge≤0 ⇒ dressed-up beta.",
  };

  const out = {
    generatedAt: new Date().toISOString(),
    window: WINDOW, horizons: HORIZONS, alignAtr: ALIGN_ATR,
    stocks: perStock.map(p => p.sym), proxies: PROXIES, source: "Polygon daily (adjusted)",
    q1_sfa12: {
      meanFwd5_aligned: sfaRoll("aligned"), meanFwd5_extended: sfaRoll("extended"),
      meanFwd5_regimeUp: sfaRoll("regimeUp"), meanFwd5_regimeDown: sfaRoll("regimeDown"),
      medFwd5_aligned: sfaRoll("aligned", "medFwd5"), medFwd5_extended: sfaRoll("extended", "medFwd5"),
      medFwd5_regimeUp: sfaRoll("regimeUp", "medFwd5"), medFwd5_regimeDown: sfaRoll("regimeDown", "medFwd5"),
      gapMeanReversionCorr: round(mean(perStock.map(p => p.sfa.gapMeanReversionCorr).filter(v => v != null))),
    },
    q2_avgIndex: rollup(aggAvg),
    q3_combinedIndex: rollup(aggSum),
    q4_dispersionRegime: { dispVsWeeklyDirHitCorr: pearson(dispVsAcc.disp, dispVsAcc.acc), note: ">0 ⇒ higher dispersion → MORE directional reliability; <0 ⇒ dispersion = chop" },
    q5_combineVsAvg: { correlation: combineVsAvgCorr, note: "≈1.0 confirms Sum = 3×Avg (degenerate); the real signal is q4 dispersion" },
    q6_monthlyMarketUp: q6,
    perStock,
    caveats: [
      "In-sample MEASUREMENT over the recent ~6-month window — descriptive, not a promotion. Only the OOS ledger gates any edge.",
      "Realised fraction applies the index gain% 1:1 to the stock, so its mean ≈ the stock's beta to the broad market.",
      "Sum is exactly proxies×Avg, so q5 correlation is ~1 by construction; cross-index DISPERSION (q4) carries the non-redundant information.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "sfa-index-study.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("\n── ROLLUP ──");
  console.log("SFA12 fwd5 MEAN: aligned=" + out.q1_sfa12.meanFwd5_aligned + " extended=" + out.q1_sfa12.meanFwd5_extended + " | up=" + out.q1_sfa12.meanFwd5_regimeUp + " down=" + out.q1_sfa12.meanFwd5_regimeDown);
  console.log("SFA12 fwd5 MEDIAN: aligned=" + out.q1_sfa12.medFwd5_aligned + " extended=" + out.q1_sfa12.medFwd5_extended + " | up=" + out.q1_sfa12.medFwd5_regimeUp + " down=" + out.q1_sfa12.medFwd5_regimeDown + " | gap→reversion corr=" + out.q1_sfa12.gapMeanReversionCorr);
  for (const h of Object.keys(HORIZONS)) console.log("AVG  " + h.padEnd(5) + " reached%=" + out.q2_avgIndex[h].reachedRate + " dirHit%=" + out.q2_avgIndex[h].dirHitRate + " realizedFrac(med)=" + out.q2_avgIndex[h].medianRealizedFrac);
  console.log("dispersion→dirHit corr=" + out.q4_dispersionRegime.dispVsWeeklyDirHitCorr + " | combine~avg corr=" + out.q5_combineVsAvg.correlation);
  console.log("MONTHLY market-up: cond(net)=" + q6.condMean21Net + " uncond=" + q6.uncondMean21 + " EDGE=" + q6.edge + " t≈" + q6.condTStatNaive + " inMkt%=" + q6.inMarketPct);
  console.log("Wrote sfa-index-study.json.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
