// Universe-wide edge of the "Uptrend Convergence with Breakout" pattern.
//
// Pulls Polygon daily aggregates for every ticker in tickers.txt — the SAME vendor
// and adjusted bars the live app fetches with, so the historical edge is measured
// on the same feed the in-app detector signals on (vendor parity, no fallback).
// Each series is audited first (auditData) and SKIPPED if it has SEVERE issues —
// split/dividend discontinuities, bad prints, frozen feeds — so one corrupt bar
// can't poison the pooled edge. Every clean ticker is measured BOTH with the trend
// filter (the shipped default) and without, so we can see whether requiring an
// established uptrend actually buys an edge. Writes pattern-study.json (read
// same-origin by the app's Convergence-Breakout card). The pure helpers
// (parsePolygonAggs, aggregate) are unit-tested offline; main() only runs when the
// file is invoked directly, so tests can import safely.
//
// Requires POLYGON_API_KEY (the REST key). Paced for the free tier's 5 req/min;
// override with --pace <ms> or POLYGON_PACE_MS for a higher-rate plan.
//
// "Bigger sample size" lives here: ~36 tickers × years of daily bars is a far
// larger sample than any single in-app fetch can give.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backtestPattern, auditData } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";
import { loadStudyUniverse } from "./universe-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HORIZON = 20;
const POLY = "https://api.polygon.io";

// Supported resolutions → Polygon (multiplier, timespan), mirroring the app's
// POLY_RES so script bars match the live card across timeframes. `ms` is the bar
// period (used to tell a SETTLED bar from a still-forming one intraday). Friendly
// keys ("1day", "5min") double as the ledger's `interval` tag.
export const RESOLUTIONS = {
  "1min":  { mult: 1,  span: "minute", ms: 60_000 },
  "5min":  { mult: 5,  span: "minute", ms: 5 * 60_000 },
  "15min": { mult: 15, span: "minute", ms: 15 * 60_000 },
  "30min": { mult: 30, span: "minute", ms: 30 * 60_000 },
  "1hour": { mult: 1,  span: "hour",   ms: 60 * 60_000 },
  "1day":  { mult: 1,  span: "day",    ms: 24 * 60 * 60_000 },
  "1week": { mult: 1,  span: "week",   ms: 7 * 24 * 60 * 60_000 },
  "1month":{ mult: 1,  span: "month",  ms: 30 * 24 * 60 * 60_000 },
};

// Polygon aggregates JSON → candle array. Same mapping the app's polyBars() uses
// (o/h/l/c/v, 4-dp, drop non-positive closes) PLUS `time` (epoch ms, the bar's
// start) so intraday bars are orderable and settleable — daily code keeps using
// `date`. Pure.
export function parsePolygonAggs(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(b => ({
    date: new Date(b.t).toISOString().slice(0,10),
    time: +b.t,
    open:  +(+b.o).toFixed(4),
    high:  +(+b.h).toFixed(4),
    low:   +(+b.l).toFixed(4),
    close: +(+b.c).toFixed(4),
    volume: +b.v || 0,
  })).filter(d => d.close > 0);
}

// Pool per-ticker backtest results into one universe aggregate. Per-ticker means
// are weighted by their signal counts (baseline by eligible-bar counts) so a
// ticker with more triggers carries proportionally more weight. Pure.
export function aggregate(perTicker, horizon){
  const live = perTicker.filter(Boolean);
  const withSig = live.filter(t => t.signals > 0);
  const wsum = (arr, val, wt) => arr.reduce((a,t)=>a + val(t)*wt(t), 0);
  const totalSignals = live.reduce((a,t)=>a + t.signals, 0);
  const totalElig    = live.reduce((a,t)=>a + t.eligibleBars, 0);
  const wAvg  = totalSignals ? wsum(withSig, t=>t.avgFwdRet, t=>t.signals)/totalSignals : null;
  const wWin  = totalSignals ? wsum(withSig, t=>t.winRate,   t=>t.signals)/totalSignals : null;
  const wBase = totalElig    ? wsum(live,    t=>t.baselineAvgFwdRet, t=>t.eligibleBars)/totalElig : null;
  return {
    tickers: live.length,
    tickersWithSignals: withSig.length,
    positiveEdgeTickers: withSig.filter(t=>t.edge>0).length,
    signals: totalSignals,
    winRate: wWin,
    avgFwdRet: wAvg,
    baselineAvgFwdRet: wBase,
    edge: (wAvg!=null && wBase!=null) ? wAvg-wBase : null,
    horizon,
  };
}

// Default lookback per resolution (ms). Daily wants deep history; intraday is
// bounded so the bar count stays sane (Polygon caps at limit=50000). Tunable.
function defaultLookbackMs(span){
  if(span === "month" || span === "week") return 25 * 365 * 864e5;  // deep history for coarse bars
  if(span === "day")    return 20 * 365 * 864e5;  // ~20y of daily
  if(span === "hour")   return 3  * 365 * 864e5;  // ~3y of hourly
  return 60 * 864e5;                              // ~60d of minute bars
}

// Adjusted aggregates at ANY supported resolution. One endpoint shape serves
// 1/5/15/30-min, hourly and daily (the multiplier/timespan come from RESOLUTIONS),
// exactly like the app's polyFetchCandles. adjusted=true matches the live card.
// Exported so the forward logger and studies fetch any timeframe through one path.
export async function fetchPolygonAggs(sym, resolution, key, opts = {}){
  const spec = RESOLUTIONS[resolution];
  if(!spec) throw new Error("unknown resolution: " + resolution);
  const to = new Date();
  const from = new Date(to.getTime() - (opts.lookbackMs || defaultLookbackMs(spec.span)));
  const fmt = d => d.toISOString().slice(0,10);
  const u = `${POLY}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${spec.mult}/${spec.span}/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=${opts.limit || 50000}&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP "+r.status);
  const candles = parsePolygonAggs(await r.json());
  if(candles.length < (opts.minBars ?? 100)) throw new Error("only "+candles.length+" bars for "+sym+" @ "+resolution);
  return candles;
}

// Daily history — the common case, kept as a thin wrapper over fetchPolygonAggs so
// existing callers (signal-study, forward-log) are unchanged.
export async function fetchPolygonDaily(sym, key){
  return fetchPolygonAggs(sym, "1day", key);
}

function parseArgs(argv){
  const a = { preview:false, dryRun:false, horizon:HORIZON, tickersFile:null,
              pace: +(process.env.POLYGON_PACE_MS || 0) };  // Starter: unlimited calls — no throttle needed
  for(let i=2;i<argv.length;i++){ const x=argv[i];
    if(x==="--preview") a.preview=true;
    else if(x==="--dry-run") a.dryRun=true;
    else if(x==="--horizon") a.horizon=+argv[++i];
    else if(x==="--tickers") a.tickersFile=argv[++i];
    else if(x==="--pace") a.pace=+argv[++i];
  }
  return a;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function main(){
  const args = parseArgs(process.argv);
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the study has no fallback vendor by design."); process.exit(2); }

  const { tickers: syms, source } = loadStudyUniverse({ root: ROOT, explicitFile: args.tickersFile, readTickersFn: readTickers });
  console.log("universe: " + syms.length + " tickers — " + source);
  const perF = [], perU = [], universe = [], skipped = [];
  const pct = v => v!=null ? (v*100>=0?"+":"")+(v*100).toFixed(2)+"%" : "—";
  for(let i=0;i<syms.length;i++){
    const sym = syms[i];
    try{
      const candles = await fetchPolygonDaily(sym, key);
      // Data hygiene: skip series with SEVERE issues (split/dividend discontinuities,
      // bad prints, frozen feeds) — one corrupt bar inflates a forward-return window
      // and poisons the pooled aggregate (this is what made META read edge −23pp).
      const audit = auditData(candles);
      if(audit.suspect){
        const codes = [...new Set(audit.issues.filter(x=>x.level==="SEVERE").map(x=>x.code))];
        skipped.push({ sym, bars:candles.length, issues:codes });
        console.log("✗ "+sym.padEnd(6)+" SKIPPED — data audit ("+codes.join(",")+"): corrupt bars would distort the edge");
        continue;
      }
      // Measure WITH the trend filter (the shipped default) and WITHOUT, so we can
      // see whether requiring an established uptrend actually buys an edge.
      const btF = backtestPattern(candles, { horizon: args.horizon, trendFilter:true });
      const btU = backtestPattern(candles, { horizon: args.horizon, trendFilter:false });
      if(btF && btU){
        perF.push(btF); perU.push(btU);
        universe.push({ sym, bars:candles.length, signals:btF.signals, winRate:btF.winRate,
                        avgFwdRet:btF.avgFwdRet, edge:btF.edge, unfiltered:{ signals:btU.signals, edge:btU.edge } });
        console.log("✓ "+sym.padEnd(6)+String(candles.length).padStart(6)+" bars · filtered "+String(btF.signals).padStart(3)+" sig edge "+pct(btF.edge)+"  | raw "+String(btU.signals).padStart(3)+" sig edge "+pct(btU.edge));
      } else {
        console.log("· "+sym.padEnd(6)+" insufficient bars for the horizon");
      }
    }catch(e){
      console.log("✗ "+sym.padEnd(6)+" "+e.message);
    }
    if(i < syms.length-1) await sleep(args.pace);  // stay under Polygon's rate limit
  }

  const out = {
    generatedAt: new Date().toISOString(),
    horizon: args.horizon,
    priceSrc: "Polygon daily (adjusted)",
    trendFilter: true,
    thresholds: { coilPct:0.006, gapPct:0.004, coilLookback:8, slopeLookback:3, trendFilter:true, trendLookback:20, trendMinSlope:0.01 },
    aggregate: aggregate(perF, args.horizon),                 // the shipped (trend-filtered) detector
    unfilteredAggregate: aggregate(perU, args.horizon),       // same setup without the trend gate
    skipped,
    universe,
  };
  if(args.preview || args.dryRun){
    console.log("\nFILTERED:   "+JSON.stringify(out.aggregate));
    console.log("UNFILTERED: "+JSON.stringify(out.unfilteredAggregate));
    if(skipped.length) console.log("SKIPPED:    "+skipped.map(s=>s.sym+"("+s.issues.join("/")+")").join(", "));
    return;
  }
  // Never clobber a good study with an empty one (e.g. a bad key or a total outage).
  if(universe.length === 0){ console.error("No ticker returned usable data — refusing to overwrite pattern-study.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "pattern-study.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote pattern-study.json — "+universe.length+" tickers ("+skipped.length+" skipped). Pooled edge over "+args.horizon+" bars: filtered "+pct(out.aggregate.edge)+" vs raw "+pct(out.unfilteredAggregate.edge)+".");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
