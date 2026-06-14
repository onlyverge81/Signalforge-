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
import { fetchPolygonAggs } from "./pattern-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const DAY = 864e5;
const round = x => (x==null?null:Math.round(x*1e4)/1e4);
const sleep = ms => new Promise(r=>setTimeout(r,ms));

// ─── prices: adjusted MONTHLY closes from Polygon — the only vendor, no fallback ──
// Same split/dividend-adjusted feed the rest of the stack uses (vendor parity), via
// the shared fetchPolygonAggs. minBars:2 so short-history names still contribute the
// windows they do have (buildObservations skips any incomplete forward window itself).
async function fetchPrices(sym, key){
  const candles = await fetchPolygonAggs(sym, "1month", key, { minBars: 2 });
  const data = candles.map(c => ({ t: c.time, close: c.close })).sort((a,b)=>a.t-b.t);
  return { src: "Polygon (adjusted monthly close)", data };
}

// ─── date / lookup helpers ───────────────────────────────────────────────────
const iso = ms => new Date(ms).toISOString().slice(0,10);
function addMonths(ms,n){ const d=new Date(ms); d.setUTCMonth(d.getUTCMonth()+n); return d.getTime(); }
export function priceOnOrBefore(prices, targetMs){ // monthly close at-or-before target (never after)
  let best=null;
  for(const p of prices){ if(p.t<=targetMs) best=p; else break; }
  return best?best.close:null;
}
// Fundamentals must be PUBLIC before they may inform a rebalance: the as-of date is the
// rebalance minus a filing lag. Named + exported so the no-lookahead contract is pinned by a
// test, not just a comment (changing the lag is then a deliberate, test-visible decision).
export const MERIT_FILING_LAG_DAYS = 75;
export function meritAsOfISO(rbMs){ return iso(rbMs - MERIT_FILING_LAG_DAYS*DAY); }
// Rebalance grid: every `stepM` months from 2010-06-30 up to now.
function grid(stepM){
  const out=[]; const until=Date.now();
  let d=Date.UTC(2010,5,30);
  while(d<=until){ out.push(d); d=addMonths(d,stepM); }
  return out;
}

// ─── per-ticker raw data (one SEC + one price fetch each) ─────────────────────
// A pre-resolved CIK (from the survivorship-free roster) bypasses secCik's symbol map,
// which only knows CURRENT filers — that's how de-listed names get reached at all.
async function loadTicker(sym, key, cik=null){
  const resolved = cik || await secCik(sym);
  if(!resolved) throw new Error("not in SEC EDGAR");
  const r=await secFetch("https://data.sec.gov/api/xbrl/companyfacts/CIK"+resolved+".json");
  const j=await r.json();
  const px=await fetchPrices(sym, key);
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
      const rec=distill(d.j, meritAsOfISO(rb)).rec;     // fundamentals public ≥75d before rebalance
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
    // Step-1 hardening, surfaced honestly beside the headline:
    walkForward: { folds: study.walkForward.folds, hitRate: study.walkForward.hitRate,
      oofMeanIC: study.walkForward.oof.mean, oofVerdict: study.walkForward.oof.verdict },
    betaControl: { spreadMktCorr: study.betaControl.spreadMktCorr, meanSpread: study.betaControl.meanSpread },
    deflated: { trials: study.deflated.trials, tDeflated: study.deflated.tDeflated, verdict: study.deflated.verdict },
    proven: meritEdgeProven(study, plac),
    perPeriod: study.periods.map(p=>({ period:p.period, n:p.n, ic:round(p.ic), spread:round(p.spread) })),
  };
}

// Caveats honestly track which universe was used — survivorship-free roster vs the legacy
// survivor set — so study.json never overstates what it controlled for.
function caveatsFor(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock) — de-listed losers are INCLUDED, bounded to MERIT_MAX names for CI runtime."
      : "Universe is ~36 hand-picked, still-listed large-caps — survivorship bias inflates any positive result; de-listed losers are absent.",
    "Few non-overlapping periods (one cross-section per rebalance) means low statistical power. INCONCLUSIVE here is the expected, honest outcome — not a bug.",
    "Merit is reconstructed point-in-time from SEC XBRL with a 75-day filing lag (no fundamental lookahead). Prices are Polygon split/dividend-adjusted monthly closes.",
    survivorshipFree
      ? "XBRL exists only from ~2009, so pre-2009 de-listings remain absent. This gates the app's merit-fusion; it does not endorse the factor in general."
      : "Still a small, hand-picked survivor universe — run universe-build for the survivorship-free roster.json. This gates the app's merit-fusion; it does not endorse the factor in general.",
  ];
}

const MERIT_MAX = +(process.env.MERIT_MAX || 500);

// Deterministic even-stride sample: n items spread ACROSS the list (not the A–C front),
// so a cap doesn't bias the universe toward early tickers. Pure.
function stridedSample(arr, n){
  if(n >= arr.length) return arr.slice();
  if(n <= 0) return [];
  const out = [];
  for(let i = 0; i < n; i++) out.push(arr[Math.floor(i * arr.length / n)]);
  return out;
}

// Pure: pick the merit universe from a roster, bounded by `cap`, PRESERVING the roster's
// active:de-listed proportion (so it stays survivorship-free, not all-dead or all-survivor)
// and sampling each class evenly across the alphabet. Ticker-sorted output for determinism.
export function selectMeritUniverse(companies, cap){
  const byT = (a,b) => a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  const list = (companies || []).filter(c => c && c.ticker && c.cik);
  if(list.length <= cap) return list.sort(byT);
  const delisted = list.filter(c => !c.active).sort(byT);
  const active   = list.filter(c =>  c.active).sort(byT);
  const nDelisted = Math.min(delisted.length, Math.round(cap * delisted.length / list.length));
  const nActive   = Math.min(active.length, cap - nDelisted);
  return [...stridedSample(delisted, nDelisted), ...stridedSample(active, nActive)].sort(byT);
}

// Prefer the survivorship-free roster.json; fall back to the legacy survivor set
// (readTickers + secCik). Returns { entries:[{sym,cik}], source, survivorshipFree }.
function resolveMeritUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, MERIT_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return {
        entries: picked.map(c => ({ sym:c.ticker, cik:c.cik })),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${MERIT_MAX})`,
        survivorshipFree: true,
      };
    }
  }catch{ /* no roster.json yet → fall back */ }
  return {
    entries: readTickers().map(sym => ({ sym, cik:null })),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)",
    survivorshipFree: false,
  };
}

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the merit study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { entries, source: universeSource, survivorshipFree } = resolveMeritUniverse();
  console.log("merit universe: " + universeSource);
  const loaded={}; const errors=[]; let priceSrc=null;
  for(const { sym, cik } of entries){
    try{
      const d=await loadTicker(sym, key, cik);
      loaded[sym]=d; priceSrc=priceSrc||d.priceSrc;
      console.log("✓ "+sym.padEnd(6)+" "+d.prices.length+" monthly bars");
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
    await sleep(300); // be polite to SEC EDGAR (Polygon is unthrottled on Starter)
  }

  const h12=buildObservations(loaded,12);
  const h6 =buildObservations(loaded,6);
  const primary=pack(h12);

  const out={
    generatedAt: new Date().toISOString(),
    universe: { requested: entries.length, covered: Object.keys(loaded).length, source: universeSource, survivorshipFree, skipped: errors },
    source: { fundamentals:"SEC EDGAR XBRL (point-in-time, 75-day filing lag)", prices: priceSrc||"unavailable" },
    primary: "12m",
    meritEdgeProven: primary.proven,
    horizons: { "12m": primary, "6m": pack(h6) },
    caveats: caveatsFor(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT,"study.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote study.json — primary(12m): "+primary.significance+
    ", periods="+primary.periods+", meanIC="+primary.meanIC+
    ", proven="+primary.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
