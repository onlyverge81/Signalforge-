// Universe-wide edge of the "Uptrend Convergence with Breakout" pattern.
//
// Pulls KEYLESS daily bars for every ticker in tickers.txt (Yahoo primary, Stooq
// fallback — Stooq alone blocks CI IPs), runs the shared engine's backtestPattern()
// over each, and writes pattern-study.json (read same-origin by the app's
// Convergence-Breakout card). Runs weekly in CI — no secret needed. The pure helpers
// (parseStooq, parseYahooChart, aggregate) are unit-tested offline; main() only runs
// when the file is invoked directly, so tests can import safely.
//
// "Bigger sample size" lives here: ~36 tickers × years of daily bars is a far
// larger sample than any single in-app fetch can give.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCSV, backtestPattern } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HORIZON = 20;

// Stooq daily CSV (Date,Open,High,Low,Close,Volume) → candle array. The engine's
// own parseCSV already maps those columns, so the bars match the app's shape.
export function parseStooq(csv){
  if(!csv || /^\s*<|N\/A/i.test(csv.trim())) return [];
  return parseCSV(csv).filter(r => r.close > 0);
}

// Yahoo v8 chart JSON → candle array (adjusted close preferred, so splits don't
// fake a coil/breakout). Only `close` drives the detector; OHLC carried for shape.
export function parseYahooChart(j){
  const res = j && j.chart && j.chart.result && j.chart.result[0];
  if(!res || !res.timestamp) return [];
  const q = (res.indicators && res.indicators.quote && res.indicators.quote[0]) || {};
  const adjArr = res.indicators && res.indicators.adjclose && res.indicators.adjclose[0] && res.indicators.adjclose[0].adjclose;
  const out = [];
  for(let i=0;i<res.timestamp.length;i++){
    const close = (adjArr && adjArr[i]!=null) ? adjArr[i] : (q.close ? q.close[i] : null);
    if(close==null || !isFinite(close) || close<=0) continue;
    out.push({
      date: new Date(res.timestamp[i]*1000).toISOString().slice(0,10),
      open: (q.open&&isFinite(q.open[i]))?q.open[i]:close,
      high: (q.high&&isFinite(q.high[i]))?q.high[i]:close,
      low:  (q.low&&isFinite(q.low[i]))?q.low[i]:close,
      close,
      volume: (q.volume&&isFinite(q.volume[i]))?q.volume[i]:0,
    });
  }
  return out;
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

const UA = "SignalForge pattern study (https://github.com/onlyverge81/signalforge-)";
async function fetchYahooDaily(sym){
  const u = "https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(sym)+"?range=10y&interval=1d";
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if(!r.ok) throw new Error("yahoo HTTP "+r.status);
  return parseYahooChart(await r.json());
}
async function fetchStooqDaily(sym){
  const u = "https://stooq.com/q/d/l/?s="+encodeURIComponent(sym.toLowerCase())+".us&i=d";
  const r = await fetch(u, { headers: { "User-Agent": UA } });
  if(!r.ok) throw new Error("stooq HTTP "+r.status);
  return parseStooq(await r.text());
}
// Yahoo primary (keyless, CI-friendly), Stooq as fallback — Stooq often blocks CI
// IPs, so it can't be the only source. Either yields the same candle shape.
async function fetchDaily(sym){
  let candles = [];
  try { candles = await fetchYahooDaily(sym); } catch(_) { candles = []; }
  if(candles.length < 100){ try { candles = await fetchStooqDaily(sym); } catch(_) {} }
  if(candles.length < 100) throw new Error("only "+candles.length+" bars from Yahoo/Stooq");
  return candles;
}

function parseArgs(argv){
  const a = { preview:false, dryRun:false, horizon:HORIZON, tickersFile:null };
  for(let i=2;i<argv.length;i++){ const x=argv[i];
    if(x==="--preview") a.preview=true;
    else if(x==="--dry-run") a.dryRun=true;
    else if(x==="--horizon") a.horizon=+argv[++i];
    else if(x==="--tickers") a.tickersFile=argv[++i];
  }
  return a;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function main(){
  const args = parseArgs(process.argv);
  const syms = readTickers(args.tickersFile);
  const perTicker = [], universe = [];
  for(const sym of syms){
    try{
      const candles = await fetchDaily(sym);
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
    await sleep(250); // be polite to the data vendor
  }
  const out = {
    generatedAt: new Date().toISOString(),
    horizon: args.horizon,
    priceSrc: "Yahoo daily, Stooq fallback (keyless)",
    thresholds: { coilPct:0.006, gapPct:0.004, coilLookback:8, slopeLookback:3 },
    aggregate: aggregate(perTicker, args.horizon),
    universe,
  };
  if(args.preview || args.dryRun){ console.log("\n"+JSON.stringify(out.aggregate, null, 2)); return; }
  fs.writeFileSync(path.join(ROOT, "pattern-study.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote pattern-study.json — "+universe.length+" tickers, pooled edge "+(out.aggregate.edge!=null?(out.aggregate.edge*100>=0?"+":"")+(out.aggregate.edge*100).toFixed(2)+"%":"—")+" over "+args.horizon+" bars.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
