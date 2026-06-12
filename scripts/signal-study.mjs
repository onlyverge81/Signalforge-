// Universe-wide profitability of the SignalForge VERDICT (the live BUY/SELL engine).
//
// Backtests the SAME engine the app ships — runBacktest() driven by scoreAt(), which
// shares computeSignal() with analyze(), so this measures the exact verdict a user
// sees — across the Polygon daily universe with realistic costs and no lookahead
// (signals fill at the next bar's open, ATR×1.5 stop / ATR×2.0 target). Each clean
// series is fetched ONCE and run through several strategy variants, then every trade
// is pooled for a universe-level expectancy + t-stat and segmented (direction, score
// strength) to discover where the edge actually lives. Writes signal-study.json.
//
// Requires POLYGON_API_KEY. Audited series with SEVERE issues are skipped. The pure
// helpers (segment, buyHoldPct) are unit-tested offline; main() only runs on direct
// invocation so tests import safely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest, scoreAt, scorePosition, realizedStats, auditData } from "./engine.mjs";
import { fetchPolygonDaily } from "./pattern-study.mjs";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const COSTS = { slip:0.05, comm:0.05 };   // ~0.2% round-trip, typical retail
const SLM = 1.5, TPM = 2.0;

// Wrap a scorer so SELL signals become HOLD — the first run showed shorts are the
// biggest money-loser in this universe, so "long-only" tests whether dropping them
// fixes the edge.
const longOnly = base => slice => { const r = base(slice); return (r && r.signal === "SELL") ? { ...r, signal:"HOLD" } : r; };

// Strategy variants — each fetched series is replayed through all of them so we can
// compare apples-to-apples and recommend the best-performing configuration. The
// last three are the optimization hypotheses from run #1: drop shorts, widen the
// (whipsaw-prone) stop, and both together.
const VARIANTS = [
  { name:"baseline",     scorer:scoreAt,            slm:1.5, tpm:2.0, hold:false }, // the shipped swing verdict
  { name:"tightTP",      scorer:scoreAt,            slm:1.5, tpm:1.5, hold:false }, // 1:1 R:R
  { name:"wideTP",       scorer:scoreAt,            slm:1.5, tpm:3.0, hold:false }, // 1:2 R:R
  { name:"trendHold",    scorer:scorePosition,      slm:1.5, tpm:2.0, hold:true  }, // trend-following, hold to thesis break
  { name:"longOnly",     scorer:longOnly(scoreAt),  slm:1.5, tpm:2.0, hold:false }, // drop the losing shorts
  { name:"wideStop",     scorer:scoreAt,            slm:3.0, tpm:4.0, hold:false }, // give trades room (tight stop whipsaws)
  { name:"longWideStop", scorer:longOnly(scoreAt),  slm:3.0, tpm:4.0, hold:false }, // both fixes combined
];

// ─── pure helpers (unit-tested) ──────────────────────────────────────────────
// Split trades by a bucket key and run the SAME realizedStats on each group, so
// every segment's win-rate / expectancy / t-stat is computed identically.
export function segment(trades, keyFn){
  const groups = {};
  for(const t of trades){ const k = keyFn(t); (groups[k] = groups[k] || []).push(t); }
  const out = {};
  for(const k of Object.keys(groups)) out[k] = realizedStats(groups[k]).stats;
  return out;
}
// Buy-and-hold return % over a candle series — the benchmark the verdict must beat.
export function buyHoldPct(candles){
  if(!candles || candles.length < 2 || !(candles[0].close > 0)) return null;
  return parseFloat(((candles[candles.length-1].close / candles[0].close - 1) * 100).toFixed(2));
}
// Trim realizedStats() down to the fields worth persisting per ticker/segment.
function slim(stats){
  const { total, winRate, expectancy, profitFactor, totalReturn, sharpe, maxDrawdown, tStat, significance } = stats;
  return { total, winRate, expectancy, profitFactor, totalReturn, sharpe, maxDrawdown, tStat, significance };
}
const fmtPct = v => v!=null ? (v>=0?"+":"")+v.toFixed(2)+"%" : "—";

// ─── runner ──────────────────────────────────────────────────────────────────
function parseArgs(argv){
  const a = { preview:false, dryRun:false, tickersFile:null, pace:+(process.env.POLYGON_PACE_MS || 13000) };
  for(let i=2;i<argv.length;i++){ const x=argv[i];
    if(x==="--preview") a.preview=true;
    else if(x==="--dry-run") a.dryRun=true;
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
  const pooled = {};                         // variant name → pooled trade array
  for(const v of VARIANTS) pooled[v.name] = [];
  const universe = [], skipped = [];
  let bhSum = 0, bhN = 0;

  for(let i=0;i<syms.length;i++){
    const sym = syms[i];
    try{
      const candles = await fetchPolygonDaily(sym, key);
      const audit = auditData(candles);
      if(audit.suspect){
        const codes = [...new Set(audit.issues.filter(x=>x.level==="SEVERE").map(x=>x.code))];
        skipped.push({ sym, bars:candles.length, issues:codes });
        console.log("✗ "+sym.padEnd(6)+" SKIPPED — data audit ("+codes.join(",")+")");
        continue;
      }
      const bh = buyHoldPct(candles);
      const row = { sym, bars:candles.length, buyHoldPct:bh };
      for(const v of VARIANTS){
        const bt = runBacktest(candles, v.scorer, v.slm, v.tpm, COSTS, null, v.hold);
        // tag each trade with its source so pooled segments stay attributable
        for(const t of bt.trades) t.sym = sym;
        pooled[v.name].push(...bt.trades);
        row[v.name] = slim(bt.stats);
      }
      universe.push(row);
      if(bh!=null){ bhSum += bh; bhN++; }
      const b = row.baseline;
      console.log("✓ "+sym.padEnd(6)+String(candles.length).padStart(6)+" bars · baseline "+String(b.total).padStart(3)+" trades · win "+b.winRate+"% · exp "+fmtPct(b.expectancy)+" · ret "+fmtPct(b.totalReturn)+" · vs B&H "+fmtPct(bh));
    }catch(e){
      console.log("✗ "+sym.padEnd(6)+" "+e.message);
    }
    if(i < syms.length-1) await sleep(args.pace);
  }

  const variants = {};
  for(const v of VARIANTS) variants[v.name] = slim(realizedStats(pooled[v.name]).stats);
  const base = pooled.baseline;
  const out = {
    generatedAt: new Date().toISOString(),
    priceSrc: "Polygon daily (adjusted)",
    params: { slMult:SLM, tpMult:TPM, costs:COSTS, noLookahead:true, fillAt:"next bar open" },
    variants,                                                  // pooled stats per strategy variant
    segments: {                                               // baseline trades, sliced to find the edge
      byDirection:     segment(base, t => t.dir),
      byScoreStrength: segment(base, t => { const a=Math.abs(t.score); return a>=8?"strong(≥8)":a>=6?"medium(6-8)":"weak(<6)"; }),
      byHold:          segment(base, t => t.barsHeld<=3?"≤3 bars":t.barsHeld<=10?"4-10 bars":">10 bars"),
    },
    benchmark: { avgBuyHoldPct: bhN?parseFloat((bhSum/bhN).toFixed(2)):null, tickers:bhN },
    skipped,
    universe,
  };

  if(args.preview || args.dryRun){
    console.log("\nVARIANTS (pooled):"); for(const k of Object.keys(variants)) console.log("  "+k.padEnd(10)+JSON.stringify(variants[k]));
    console.log("\nBASELINE by direction:"); for(const k of Object.keys(out.segments.byDirection)) console.log("  "+k.padEnd(6)+JSON.stringify(out.segments.byDirection[k]));
    console.log("\navg buy&hold: "+fmtPct(out.benchmark.avgBuyHoldPct)+(skipped.length?"  · skipped: "+skipped.map(s=>s.sym).join(","):""));
    return;
  }
  if(universe.length === 0){ console.error("No ticker returned usable data — refusing to overwrite signal-study.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "signal-study.json"), JSON.stringify(out)+"\n");
  const bs = variants.baseline;
  console.log("\nWrote signal-study.json — "+universe.length+" tickers ("+skipped.length+" skipped). Baseline pooled: "+bs.total+" trades, win "+bs.winRate+"%, expectancy "+fmtPct(bs.expectancy)+", t="+bs.tStat+" ("+bs.significance+"). Avg B&H "+fmtPct(out.benchmark.avgBuyHoldPct)+".");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
