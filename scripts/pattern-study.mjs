// Universe-wide edge of the "Uptrend Convergence with Breakout" pattern.
//
// Pulls Polygon daily aggregates for every ticker in tickers.txt — the SAME vendor
// and adjusted bars the live app fetches with, so the historical edge is measured
// on the same feed the in-app detector signals on (vendor parity, no fallback).
// Runs the shared engine's backtestPattern() over each and writes pattern-study.json
// (read same-origin by the app's Convergence-Breakout card). The pure helpers
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
import { backtestPattern } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HORIZON = 20;
const POLY = "https://api.polygon.io";

// Polygon aggregates JSON → candle array. Byte-for-byte the same mapping the app's
// polyBars() uses (date/o/h/l/c/v, 4-dp, drop non-positive closes), so the study's
// bars match the live card's. Pure.
export function parsePolygonAggs(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(b => ({
    date: new Date(b.t).toISOString().slice(0,10),
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

// As much adjusted daily history as the plan allows (request ~20y; Polygon returns
// what it has). adjusted=true matches the app's polyFetchCandles exactly.
async function fetchPolygonDaily(sym, key){
  const to = new Date(), from = new Date(to.getTime() - 20*365*864e5), fmt = d => d.toISOString().slice(0,10);
  const u = `${POLY}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/1/day/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise --pace / POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP "+r.status);
  const candles = parsePolygonAggs(await r.json());
  if(candles.length < 100) throw new Error("only "+candles.length+" bars");
  return candles;
}

function parseArgs(argv){
  const a = { preview:false, dryRun:false, horizon:HORIZON, tickersFile:null,
              pace: +(process.env.POLYGON_PACE_MS || 13000) };  // 5 req/min free tier
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

  const syms = readTickers(args.tickersFile);
  const perTicker = [], universe = [];
  for(let i=0;i<syms.length;i++){
    const sym = syms[i];
    try{
      const candles = await fetchPolygonDaily(sym, key);
      const bt = backtestPattern(candles, { horizon: args.horizon });
      if(bt){
        perTicker.push(bt);
        universe.push({ sym, bars:candles.length, signals:bt.signals, winRate:bt.winRate, avgFwdRet:bt.avgFwdRet, edge:bt.edge });
        console.log("✓ "+sym.padEnd(6)+" "+String(candles.length).padStart(5)+" bars · "+String(bt.signals).padStart(3)+" signals · edge "+(bt.edge!=null?(bt.edge*100>=0?"+":"")+(bt.edge*100).toFixed(2)+"%":"—"));
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
    thresholds: { coilPct:0.006, gapPct:0.004, coilLookback:8, slopeLookback:3 },
    aggregate: aggregate(perTicker, args.horizon),
    universe,
  };
  if(args.preview || args.dryRun){ console.log("\n"+JSON.stringify(out.aggregate, null, 2)); return; }
  // Never clobber a good study with an empty one (e.g. a bad key or a total outage).
  if(universe.length === 0){ console.error("No ticker returned data — refusing to overwrite pattern-study.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "pattern-study.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote pattern-study.json — "+universe.length+" tickers, pooled edge "+(out.aggregate.edge!=null?(out.aggregate.edge*100>=0?"+":"")+(out.aggregate.edge*100).toFixed(2)+"%":"—")+" over "+args.horizon+" bars.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
