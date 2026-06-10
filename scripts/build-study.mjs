// Build study.json — the merit-evidence harness. Run in CI alongside fundamentals.
//
// Question: does a higher point-in-time merit score predict a higher forward
// return across the universe, out-of-sample, surviving a label-shuffle placebo?
//
// Method (all lookahead-controlled):
//  • Reconstruct each name's merit AS OF a grid of rebalance dates from the SEC
//    XBRL history (distill(j, asOf)), lagged 75 days so the filing was public.
//  • Take adjusted monthly prices; forward return = price(d+H) / price(d) − 1.
//  • Rebalance spacing == horizon H, so forward windows DON'T overlap.
//  • Per period: Spearman rank-IC(merit, fwdRet). Test the IC series (study-lib).
//  • Controls: OOS time-split + merit-label shuffle placebo.
//
// Everything statistical lives in study-lib.mjs (unit-tested). This file is IO:
// it fetches, reconstructs, and writes. The honest expected outcome on this small
// survivor universe is INCONCLUSIVE — see the caveats baked into the output.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers, distill } from "./build-fundamentals.mjs";
import { secCik, secFetch, meritMetrics, meritScore } from "./sec-lib.mjs";
import { runStudy, placebo, meritEdgeProven } from "./study-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DAY = 864e5;
const round = x => (x==null?null:Math.round(x*1e4)/1e4);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ─── prices: adjusted monthly closes, keyless (Yahoo primary, Stooq fallback) ──
async function fetchYahoo(sym){
  const u="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(sym)+"?range=max&interval=1mo";
  const r=await fetch(u,{headers:{"User-Agent":"SignalForge study builder (https://github.com/onlyverge81/signalforge-)"}});
  if(!r.ok) throw new Error("yahoo HTTP "+r.status);
  const j=await r.json();
  const res=j?.chart?.result?.[0];
  if(!res||!res.timestamp) throw new Error("yahoo: no series");
  const adj=res.indicators?.adjclose?.[0]?.adjclose;
  const cl=adj||res.indicators?.quote?.[0]?.close||[];
  const out=[];
  for(let i=0;i<res.timestamp.length;i++){ const c=cl[i]; if(c!=null&&isFinite(c)&&c>0) out.push({t:res.timestamp[i]*1000, close:c}); }
  return out.sort((a,b)=>a.t-b.t);
}
async function fetchStooq(sym){
  const u="https://stooq.com/q/d/l/?s="+encodeURIComponent(sym.toLowerCase())+".us&i=m";
  const r=await fetch(u);
  if(!r.ok) throw new Error("stooq HTTP "+r.status);
  const lines=(await r.text()).trim().split(/\r?\n/);
  if(lines.length<2||!/date/i.test(lines[0])) throw new Error("stooq: no series");
  const out=[];
  for(const line of lines.slice(1)){ const c=line.split(","); const t=Date.parse(c[0]); const close=parseFloat(c[4]); if(isFinite(t)&&isFinite(close)&&close>0) out.push({t,close}); }
  return out.sort((a,b)=>a.t-b.t);
}
async function fetchPrices(sym){
  try{ return { src:"Yahoo (adjusted close)", data:await fetchYahoo(sym) }; }
  catch(_){ return { src:"Stooq (close)", data:await fetchStooq(sym) }; }
}

// ─── date / lookup helpers ───────────────────────────────────────────────────
const iso = ms => new Date(ms).toISOString().slice(0,10);
function addMonths(ms,n){ const d=new Date(ms); d.setUTCMonth(d.getUTCMonth()+n); return d.getTime(); }
function priceOnOrBefore(prices, targetMs){ // monthly close at-or-before target
  let best=null;
  for(const p of prices){ if(p.t<=targetMs) best=p; else break; }
  return best?best.close:null;
}
// Rebalance grid: every `stepM` months from 2010-06-30 up to now.
function grid(stepM){
  const out=[]; const until=Date.now();
  let d=Date.UTC(2010,5,30);
  while(d<=until){ out.push(d); d=addMonths(d,stepM); }
  return out;
}

// ─── per-ticker raw data (one SEC + one price fetch each) ─────────────────────
async function loadTicker(sym){
  const cik=await secCik(sym);
  if(!cik) throw new Error("not in SEC EDGAR");
  const r=await secFetch("https://data.sec.gov/api/xbrl/companyfacts/CIK"+cik+".json");
  const j=await r.json();
  const px=await fetchPrices(sym);
  if(!px.data.length) throw new Error("no price series");
  return { j, prices:px.data, priceSrc:px.src };
}

// Observations for one horizon across all loaded tickers, aligned on the grid.
function buildObservations(loaded, horizonM){
  const dates=grid(horizonM);
  const obs=[];
  for(const [sym,d] of Object.entries(loaded)){
    const lastT=d.prices[d.prices.length-1].t;
    for(const rb of dates){
      const fwdT=addMonths(rb,horizonM);
      if(fwdT>lastT) continue;                          // forward window not complete yet
      const entry=priceOnOrBefore(d.prices, rb);
      const exit =priceOnOrBefore(d.prices, fwdT);
      if(!(entry>0)||!(exit>0)) continue;
      const rec=distill(d.j, iso(rb-75*DAY)).rec;       // fundamentals public ≥75d before rebalance
      const merit=meritScore(meritMetrics(rec, entry));
      if(merit==null) continue;
      obs.push({ sym, period:iso(rb), merit, fwdRet:exit/entry-1 });
    }
  }
  return obs;
}

function pack(obs){
  const study=runStudy(obs);
  const plac=placebo(obs, 1337);
  return {
    periods: study.periods.length,
    observations: obs.length,
    meanIC: study.meanIC, icT: study.icT, significance: study.significance,
    spread: { mean: round(study.spread.mean), verdict: study.spread.verdict },
    oos: {
      trainPct: study.oos.trainPct, testPct: study.oos.testPct,
      inSample:  { n:study.oos.inSample.n,  meanIC:study.oos.inSample.mean,  verdict:study.oos.inSample.verdict },
      outSample: { n:study.oos.outSample.n, meanIC:study.oos.outSample.mean, verdict:study.oos.outSample.verdict },
    },
    placebo: { meanIC: plac.mean, verdict: plac.verdict },
    proven: meritEdgeProven(study, plac),
    perPeriod: study.periods.map(p=>({ period:p.period, n:p.n, ic:round(p.ic), spread:round(p.spread) })),
  };
}

const CAVEATS = [
  "Universe is ~36 hand-picked, still-listed large-caps — survivorship bias inflates any positive result; de-listed losers are absent.",
  "Few non-overlapping periods (one cross-section per rebalance) means low statistical power. INCONCLUSIVE here is the expected, honest outcome — not a bug.",
  "Merit is reconstructed point-in-time from SEC XBRL with a 75-day filing lag (no fundamental lookahead). Prices are adjusted monthly closes.",
  "A single universe and vendor; not a substitute for a broad, point-in-time, survivorship-free factor study. This gates the app's merit-fusion, it does not endorse the factor in general.",
];

async function main(){
  const tickers=readTickers();
  const loaded={}; const errors=[]; let priceSrc=null;
  for(const sym of tickers){
    try{
      const d=await loadTicker(sym);
      loaded[sym]=d; priceSrc=priceSrc||d.priceSrc;
      console.log("✓ "+sym.padEnd(6)+" "+d.prices.length+" monthly bars");
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
    await sleep(300); // be polite to both APIs
  }

  const h12=buildObservations(loaded,12);
  const h6 =buildObservations(loaded,6);
  const primary=pack(h12);

  const out={
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(loaded).length, skipped: errors },
    source: { fundamentals:"SEC EDGAR XBRL (point-in-time, 75-day filing lag)", prices: priceSrc||"unavailable" },
    primary: "12m",
    meritEdgeProven: primary.proven,
    horizons: { "12m": primary, "6m": pack(h6) },
    caveats: CAVEATS,
  };
  fs.writeFileSync(path.join(ROOT,"study.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote study.json — primary(12m): "+primary.significance+
    ", periods="+primary.periods+", meanIC="+primary.meanIC+
    ", proven="+primary.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
