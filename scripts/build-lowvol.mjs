// Build lowvol.json — the cross-sectional LOW-VOLATILITY evidence harness. Run in CI.
//
// Question: do LOW-volatility names earn a HIGHER forward return than high-volatility names
// across the universe (the low-vol / low-beta anomaly), out-of-sample, surviving a label-shuffle
// placebo? This is a risk-based factor, orthogonal to the price-trend factors (momentum/reversal).
//
// Like momentum and reversal, this is CROSS-SECTIONAL and reuses the merit machinery verbatim —
// `runStudy`/`walkForward`/`deflated`/`placebo`/`betaControl` in study-lib.mjs are factor-agnostic
// (they only need { period, merit, fwdRet }). The only new thing is `buildLowVolObservations`,
// which sets `merit = −(trailing realized volatility)` so a CALM name scores HIGH and a positive
// rank-IC means "calm names outperform" (the low-vol sign).
//
// Method (all lookahead-controlled):
//  • Polygon adjusted MONTHLY closes — the only vendor, no fallback (charter-clean).
//  • Survivorship-free roster.json universe (active + de-listed), reusing selectMeritUniverse.
//  • Monthly rebalance grid; 1-month, NON-overlapping forward windows (overlap=0 → honest naive t).
//  • Signal = −(stdev of the trailing `lookbackM` monthly returns), using only returns ≤ rb.
//    Entry at rb; forward window rb→rb+1mo. Two windows (12-mo and 6-mo trailing vol) → trials=2.
//  • Per period: Spearman rank-IC(lowVolScore, fwdRet). Controls: OOS split + label-shuffle placebo.
//
// In-sample is NEVER trusted here — only the OOS lowvol-on ledger under FDR counts. INCONCLUSIVE
// is an acceptable outcome.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { priceOnOrBefore, selectMeritUniverse, pack, grid, addMonths, iso } from "./build-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LV_MAX = +(process.env.LV_MAX || 500);

// ─── prices: adjusted MONTHLY closes from Polygon (vendor parity, no fallback) ──
// minBars:8 so a name can support at least a 6-month trailing-vol window (needs lookback+1
// closes for `lookback` returns, plus the entry/forward bars); thinner names contribute the
// windows they do have (buildLowVolObservations skips the rest).
async function fetchPrices(sym, key){
  const candles = await fetchPolygonAggs(sym, "1month", key, { minBars: 8 });
  const data = candles.map(c => ({ t: c.time, close: c.close })).sort((a,b)=>a.t-b.t);
  return { src: "Polygon (adjusted monthly close)", data };
}

// Population standard deviation of a numeric array (0 for <2 points). Pure helper.
export function stdev(xs){
  const a = (xs || []).filter(v => v != null && isFinite(v));
  if(a.length < 2) return 0;
  const mean = a.reduce((s,v)=>s+v,0) / a.length;
  const varc = a.reduce((s,v)=>s+(v-mean)*(v-mean),0) / a.length;
  return Math.sqrt(varc);
}

// Observations for one trailing-vol lookback across all loaded tickers, on a MONTHLY grid.
//   merit  = −stdev(monthly returns over the trailing `lookbackM` months, ending at rb)  (calm ⇒ high)
//   fwdRet = price(rb+1mo) / price(rb) − 1                                                (held one month)
// No-lookahead: every return in the trailing window ends at or before rb (the entry bar); the
// forward window rb→rb+1mo doesn't overlap the signal window.
export function buildLowVolObservations(loaded, lookbackM){
  const dates = grid(1);                                  // monthly rebalance
  const obs = [];
  for(const [sym, d] of Object.entries(loaded)){
    const prices = d.prices;
    if(!prices || !prices.length) continue;
    const lastT = prices[prices.length-1].t;
    for(const rb of dates){
      const fwdT = addMonths(rb, 1);
      if(fwdT > lastT) continue;                           // forward window not complete yet
      // Trailing monthly returns ending AT rb: r_k = price(rb−(k−1)mo)/price(rb−k·mo) − 1, k=1..lookbackM.
      const rets = []; let ok = true;
      for(let k=1; k<=lookbackM; k++){
        const pNew = priceOnOrBefore(prices, addMonths(rb, -(k-1)));
        const pOld = priceOnOrBefore(prices, addMonths(rb, -k));
        if(!(pNew>0) || !(pOld>0)){ ok = false; break; }
        rets.push(pNew/pOld - 1);
      }
      if(!ok || rets.length < 2) continue;                 // need ≥2 returns for a stdev
      const entry = priceOnOrBefore(prices, rb);
      const exit  = priceOnOrBefore(prices, fwdT);
      if(!(entry>0) || !(exit>0)) continue;
      obs.push({ sym, period: iso(rb), merit: -stdev(rets), fwdRet: exit/entry - 1 });
    }
  }
  return obs;
}

// Honest caveats — low-vol is price-only, so its lookahead story is simple.
function lowVolCaveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), bounded to LV_MAX names for CI runtime — de-listed names are INCLUDED (high-vol blow-ups belong in a low-vol study)."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias flatters low-vol (the high-vol names that died are missing); run universe-build for the survivorship-free roster.json.",
    "Signal is the NEGATED stdev of trailing monthly returns (calm ⇒ high score), so a positive rank-IC means 'calm names outperform'. Prices are Polygon split/dividend-adjusted monthly closes.",
    "Realized vol from MONTHLY returns over 12 / 6 months is a coarse risk proxy (daily vol would be finer); it is, however, point-in-time and vendor-clean. Modest power per cross-section.",
    "1-month NON-overlapping forward windows → the naive IC t is honest (no HAC inflation). INCONCLUSIVE is an acceptable outcome.",
    "In-sample is NEVER trusted here — only the OOS lowvol-on ledger, cleared through FDR, is tradeable evidence.",
  ];
}

// Prefer the survivorship-free roster.json (reusing selectMeritUniverse); fall back to tickers.txt.
function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, LV_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return {
        tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${LV_MAX})`,
        survivorshipFree: true,
      };
    }
  }catch{ /* no roster.json yet → fall back */ }
  return {
    tickers: readTickers(),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)",
    survivorshipFree: false,
  };
}

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the low-vol study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source: universeSource, survivorshipFree } = resolveUniverse();
  console.log("low-vol universe: " + universeSource);
  const loaded={}; const errors=[]; let priceSrc=null;
  for(const sym of tickers){
    try{
      const px = await fetchPrices(sym, key);
      if(!px.data.length) throw new Error("no price series");
      loaded[sym] = { prices: px.data }; priceSrc = priceSrc || px.src;
      console.log("✓ "+sym.padEnd(6)+" "+px.data.length+" monthly bars");
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
  }

  // trials=2 — two trailing-vol windows (12-mo and 6-mo) are tested, so the deflated-t is haircut
  // for the configuration search even in-sample (an honest overfit control).
  const TRIALS = 2;
  const lv12 = pack(buildLowVolObservations(loaded, 12), { trials: TRIALS });
  const lv6  = pack(buildLowVolObservations(loaded, 6),  { trials: TRIALS });

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(loaded).length, source: universeSource, survivorshipFree, skipped: errors },
    source: { prices: priceSrc || "unavailable" },
    primary: "12mo",
    lowVolEdgeProven: lv12.proven,
    windows: { "12mo": lv12, "6mo": lv6 },
    caveats: lowVolCaveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT,"lowvol.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote lowvol.json — primary(12mo): "+lv12.significance+
    ", periods="+lv12.periods+", meanIC="+lv12.meanIC+
    ", proven="+lv12.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
