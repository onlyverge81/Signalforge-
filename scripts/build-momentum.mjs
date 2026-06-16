// Build momentum.json — the cross-sectional price-MOMENTUM evidence harness. Run in CI.
//
// Question: does a higher trailing price-momentum rank predict a higher forward return
// across the universe, out-of-sample, surviving a label-shuffle placebo?
//
// Cross-sectional momentum is the most-replicated equity anomaly. SignalForge has only ever
// scored names in ISOLATION; this is its first cross-sectional PRICE study. It reuses the
// merit study's machinery verbatim — `runStudy`/`walkForward`/`deflated`/`placebo`/`betaControl`
// in study-lib.mjs are factor-agnostic (they only need { period, merit, fwdRet }), so the only
// new thing here is `buildMomentumObservations`, which sets `merit = trailing momentum`.
//
// Method (all lookahead-controlled):
//  • Polygon adjusted MONTHLY closes — the only vendor, no fallback (charter-clean).
//  • Survivorship-free roster.json universe (active + de-listed), reusing selectMeritUniverse.
//  • Monthly rebalance grid; 1-month, NON-overlapping forward windows (overlap=0 → honest naive t).
//  • Signal = trailing return over `lookback` months, SKIPPING the most recent month (the classic
//    12-1 / 6-1 momentum that dodges short-term reversal). Point-in-time prices only.
//  • Per period: Spearman rank-IC(momentum, fwdRet). Controls: OOS split + label-shuffle placebo.
//
// The honest expected outcome in-sample may look attractive — but in-sample is NEVER trusted
// here. Only the OOS `momentum-on` ledger under FDR counts. INCONCLUSIVE is a fine outcome.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { priceOnOrBefore, selectMeritUniverse, pack, grid, addMonths, iso } from "./build-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const MOM_MAX = +(process.env.MOM_MAX || 500);

// ─── prices: adjusted MONTHLY closes from Polygon (vendor parity, no fallback) ──
// minBars:13 so a name needs ≥13 monthly closes to support a 12-1 lookback at all; thinner
// names still contribute the windows they do have (buildMomentumObservations skips the rest).
async function fetchPrices(sym, key){
  const candles = await fetchPolygonAggs(sym, "1month", key, { minBars: 13 });
  const data = candles.map(c => ({ t: c.time, close: c.close })).sort((a,b)=>a.t-b.t);
  return { src: "Polygon (adjusted monthly close)", data };
}

// Observations for one momentum lookback across all loaded tickers, aligned on a MONTHLY grid.
// merit = trailing return over `lookbackM` months, skipping the most recent month:
//   merit = price(rb−1mo) / price(rb−lookbackM) − 1     (signal uses only prices ≤ rb−1mo)
//   fwdRet = price(rb+1mo) / price(rb) − 1              (formed/entered at rb, held one month)
// No-lookahead: the signal cutoff (rb−1mo) precedes entry (rb); forward windows don't overlap.
export function buildMomentumObservations(loaded, lookbackM){
  const dates = grid(1);                                  // monthly rebalance
  const obs = [];
  for(const [sym, d] of Object.entries(loaded)){
    const prices = d.prices;
    if(!prices || !prices.length) continue;
    const lastT = prices[prices.length-1].t;
    for(const rb of dates){
      const fwdT = addMonths(rb, 1);
      if(fwdT > lastT) continue;                           // forward window not complete yet
      const pSig  = priceOnOrBefore(prices, addMonths(rb, -1));        // skip the most recent month
      const pBack = priceOnOrBefore(prices, addMonths(rb, -lookbackM));
      const entry = priceOnOrBefore(prices, rb);
      const exit  = priceOnOrBefore(prices, fwdT);
      if(!(pSig>0) || !(pBack>0) || !(entry>0) || !(exit>0)) continue;
      obs.push({ sym, period: iso(rb), merit: pSig/pBack - 1, fwdRet: exit/entry - 1 });
    }
  }
  return obs;
}

// Honest caveats — momentum needs no fundamentals, so its lookahead story is simpler than merit's.
function momentumCaveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), bounded to MOM_MAX names for CI runtime — de-listed losers are INCLUDED."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias inflates any positive result; run universe-build for the survivorship-free roster.json.",
    "Signal is trailing price return over the lookback, SKIPPING the most recent month (classic 12-1 / 6-1), to dodge short-term reversal. Prices are Polygon split/dividend-adjusted monthly closes.",
    "1-month NON-overlapping forward windows → the naive IC t is honest (no HAC inflation). One cross-section per rebalance still means modest power; INCONCLUSIVE is an acceptable outcome.",
    "In-sample is NEVER trusted here — an attractive momentum.json is 'looks good in-sample,' not proven. Only the OOS momentum-on ledger, cleared through FDR, is tradeable evidence.",
  ];
}

// Prefer the survivorship-free roster.json (reusing selectMeritUniverse for the active:de-listed
// proportion); fall back to the legacy tickers.txt set. Momentum needs only tickers — no CIK/SEC.
function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, MOM_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return {
        tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${MOM_MAX})`,
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
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the momentum study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source: universeSource, survivorshipFree } = resolveUniverse();
  console.log("momentum universe: " + universeSource);
  const loaded={}; const errors=[]; let priceSrc=null;
  for(const sym of tickers){
    try{
      const px = await fetchPrices(sym, key);
      if(!px.data.length) throw new Error("no price series");
      loaded[sym] = { prices: px.data }; priceSrc = priceSrc || px.src;
      console.log("✓ "+sym.padEnd(6)+" "+px.data.length+" monthly bars");
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
    // Polygon Starter is unthrottled (POLYGON_PACE_MS=0) — no sleep, no SEC politeness needed.
  }

  const mom12 = pack(buildMomentumObservations(loaded, 12));
  const mom6  = pack(buildMomentumObservations(loaded, 6));

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(loaded).length, source: universeSource, survivorshipFree, skipped: errors },
    source: { prices: priceSrc || "unavailable" },
    primary: "12-1",
    momentumEdgeProven: mom12.proven,
    windows: { "12-1": mom12, "6-1": mom6 },
    caveats: momentumCaveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT,"momentum.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote momentum.json — primary(12-1): "+mom12.significance+
    ", periods="+mom12.periods+", meanIC="+mom12.meanIC+
    ", proven="+mom12.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
