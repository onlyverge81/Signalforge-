// Convergence (Uptrend Convergence) backtest SCAN — sweeps forward horizons on the top-N
// US names at an intraday resolution and reports edge vs a matched baseline, so we can see
// at which horizon (if any) the pattern's forward return beats "just being in the tape."
//
// HONESTY: this is in-sample exploration. A horizon that looks profitable here is a
// HYPOTHESIS for the out-of-sample ledger, not a proven edge — every number is reported as
// edge-vs-baseline (alpha) with a cross-sectional t-stat, never a bare win rate. Needs
// POLYGON_API_KEY (no fallback vendor by design); no-ops without it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backtestPattern, auditData } from "./engine.mjs";
import { fetchPolygonAggs, aggregate, filterRegularHours } from "./pattern-study.mjs";

const severeCodes = audit => audit.issues.filter(i => i.level === "SEVERE").map(i => i.code);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Top-N tickers from the dollar-volume-ranked universe.json. Pure.
export function topNTickers(universe, n){
  const t = (universe && universe.tickers) || [];
  return t.slice(0, Math.max(0, n));
}

// Cross-sectional significance of an edge series (one edge per ticker): is the pattern's
// edge CONSISTENTLY positive across names, or noise? Returns {n, mean, sd, t}. Pure.
export function tStat(values){
  const v = (values || []).filter(Number.isFinite);
  const n = v.length;
  if(n < 2) return { n, mean: n ? v[0] : null, sd: null, t: null };
  const mean = v.reduce((a, x) => a + x, 0) / n;
  const sd = Math.sqrt(v.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null;
  return { n, mean, sd, t };
}

function verdictFor(t){
  if(t == null) return "TOO FEW";
  const a = Math.abs(t);
  if(a >= 2)   return t > 0 ? "SIGNIFICANT +" : "SIGNIFICANT −";
  if(a >= 1.5) return t > 0 ? "SUGGESTIVE +" : "SUGGESTIVE −";
  return "NOT SIGNIFICANT";
}

const pct = v => v != null ? (v * 100 >= 0 ? "+" : "") + (v * 100).toFixed(3) + "%" : "—";

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY — the scan has no fallback vendor by design."); process.exit(2); }

  const topN       = +(process.env.SCAN_TOP_N || 300);
  const resolution = process.env.SCAN_RESOLUTION || "15min";
  const lookbackDays = +(process.env.SCAN_LOOKBACK_DAYS || 45); // ~1 month window + pattern warmup
  const horizons   = (process.env.SCAN_HORIZONS || "6,12,24,48").split(",").map(s => +s.trim()).filter(Boolean);
  const pace       = +(process.env.POLYGON_PACE_MS || 0);
  const rth        = !/^(0|false|no)$/i.test(process.env.SCAN_RTH ?? "1"); // default ON for intraday
  const intraday   = /min|hour/.test(resolution);

  let universe;
  try { universe = JSON.parse(fs.readFileSync(path.join(ROOT, "universe.json"), "utf8")); }
  catch { console.error("universe.json missing — run universe-build first."); process.exit(2); }
  const syms = topNTickers(universe, topN);
  console.log(`scan: top ${syms.length} names @ ${resolution}, ~${lookbackDays}d, horizons [${horizons.join(", ")}]`);

  // perH[h] = array of per-ticker backtestPattern results at horizon h.
  const perH = Object.fromEntries(horizons.map(h => [h, []]));
  const skipped = [];
  let withData = 0;
  // Raw-vs-RTH audit tally — proves whether the skips are extended-hours artifacts.
  const codeTally = {};
  let rawSuspect = 0, rthSuspect = 0, recoveredByRth = 0;

  for(let i = 0; i < syms.length; i++){
    const sym = syms[i];
    try {
      const raw = await fetchPolygonAggs(sym, resolution, key, { lookbackMs: lookbackDays * 864e5, minBars: 120 });
      const clean = (rth && intraday) ? filterRegularHours(raw) : raw;

      // Audit BOTH so the report can show what extended hours alone caused.
      const aRaw = auditData(raw), aClean = auditData(clean);
      const rawBad = aRaw.suspect, cleanBad = aClean.suspect;
      if(rawBad){ rawSuspect++; for(const c of severeCodes(aRaw)) codeTally[c] = (codeTally[c] || 0) + 1; }
      if(cleanBad) rthSuspect++;
      if(rawBad && !cleanBad) recoveredByRth++;

      const used = (rth && intraday) ? clean : raw;
      const usedAudit = (rth && intraday) ? aClean : aRaw;
      if(usedAudit.suspect){
        skipped.push({ sym, bars: raw.length, rthBars: clean.length, rawCodes: severeCodes(aRaw), rthCodes: severeCodes(aClean) });
        continue;
      }
      withData++;
      for(const h of horizons){
        const bt = backtestPattern(used, { horizon: h, trendFilter: true });
        if(bt && bt.signals > 0) perH[h].push(bt);
      }
      if(i % 25 === 0) console.log(`  …${i}/${syms.length} (${sym})`);
    } catch(e){ skipped.push({ sym, reason: (e.message || String(e)).slice(0, 60) }); }
    if(i < syms.length - 1 && pace) await sleep(pace);
  }

  const byHorizon = horizons.map(h => {
    const rows = perH[h];
    const agg = aggregate(rows, h);                 // pooled, count-weighted (tested)
    const sig = tStat(rows.map(r => r.edge));        // cross-sectional edge significance
    return {
      horizon: h,
      tickersWithSignals: rows.length,
      totalSignals: rows.reduce((a, r) => a + (r.signals || 0), 0),
      pooledWinRate: agg.winRate,
      pooledAvgFwdRet: agg.avgFwdRet,
      baselineAvgFwdRet: agg.baselineAvgFwdRet,
      edge: agg.edge,
      edgeTStatAcrossTickers: sig.t != null ? +sig.t.toFixed(2) : null,
      verdict: verdictFor(sig.t),
    };
  });

  // "Best" = highest edge that is at least suggestive — honest, not just the max.
  const ranked = [...byHorizon].filter(r => r.edge != null).sort((a, b) => b.edge - a.edge);
  const best = ranked.find(r => r.edgeTStatAcrossTickers != null && r.edgeTStatAcrossTickers >= 1.5) || ranked[0] || null;

  const out = {
    generatedAt: new Date().toISOString(),
    pattern: "Uptrend Convergence (trend-filtered)",
    resolution, lookbackDays, topN,
    regularHoursOnly: rth && intraday,
    priceSrc: `Polygon ${resolution} (adjusted${rth && intraday ? ", regular hours 09:30–16:00 ET" : ""})`,
    universeSource: "universe.json (dollar-volume ranked, top N)",
    scanned: syms.length, withData, skippedCount: skipped.length,
    audit: {
      note: "rawSuspect = names flagged SEVERE on full-session bars; rthSuspect = still flagged after the regular-hours filter; recoveredByRth = extended-hours artifacts.",
      rawSuspect, rthSuspect, recoveredByRth, rawSevereCodeTally: codeTally,
    },
    horizons: byHorizon,
    best: best ? { horizon: best.horizon, edge: best.edge, verdict: best.verdict } : null,
    caveats: [
      "In-sample exploration over ~1 month of intraday bars — a profitable horizon here is a HYPOTHESIS for the OOS ledger, not a proven edge.",
      "Edge is forward return vs a matched same-window baseline (alpha), not a raw win rate; the t-stat is cross-sectional across names.",
      "No costs subtracted in this forward-return scan — a positive edge must still clear the 2× round-trip cost gate before it is tradeable.",
    ],
    skipped: skipped.slice(0, 40),
  };
  fs.writeFileSync(path.join(ROOT, "convergence-scan.json"), JSON.stringify(out, null, 1) + "\n");

  console.log(`\naudit: raw-suspect ${rawSuspect}, rth-suspect ${rthSuspect}, recovered-by-RTH ${recoveredByRth}; raw severe codes ${JSON.stringify(codeTally)}`);
  console.log("\nHORIZON   tickers  signals   edge      t      verdict");
  for(const r of byHorizon){
    console.log(`${String(r.horizon).padStart(4)}      ${String(r.tickersWithSignals).padStart(5)}   ${String(r.totalSignals).padStart(6)}   ${pct(r.edge).padStart(9)}  ${String(r.edgeTStatAcrossTickers ?? "—").padStart(5)}   ${r.verdict}`);
  }
  console.log("\nBest (edge, ≥suggestive): " + (best ? `horizon ${best.horizon} — edge ${pct(best.edge)} (${best.verdict})` : "none reached significance"));
  console.log(`Wrote convergence-scan.json (${withData} names with data, ${skipped.length} skipped).`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
