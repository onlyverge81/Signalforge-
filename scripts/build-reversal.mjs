// Build reversal.json — the cross-sectional SHORT-TERM REVERSAL evidence harness. Run in CI.
//
// Question: does a LOWER trailing 1-month return predict a HIGHER forward return across the
// universe (recent losers bounce), out-of-sample, surviving a label-shuffle placebo?
//
// Short-term (1-month) reversal is the canonical complement to 12-1 momentum: momentum SKIPS
// the most recent month precisely to dodge this effect, so the two factors are orthogonal by
// construction. Like momentum, this is a CROSS-SECTIONAL price study and reuses the merit
// machinery verbatim — `runStudy`/`walkForward`/`deflated`/`placebo`/`betaControl` in
// study-lib.mjs are factor-agnostic (they only need { period, merit, fwdRet }). The only new
// thing is `buildReversalObservations`, which sets `merit = −(trailing 1-month return)` so a
// big recent LOSER scores HIGH and a positive IC means "losers bounce" (the reversal sign).
//
// Method (all lookahead-controlled):
//  • Polygon adjusted MONTHLY closes — the only vendor, no fallback (charter-clean).
//  • Survivorship-free roster.json universe (active + de-listed), reusing selectMeritUniverse.
//  • Monthly rebalance grid; 1-month, NON-overlapping forward windows (overlap=0 → honest naive t).
//  • Signal = −(price(rb) / price(rb−1mo) − 1), i.e. the negated most-recent-month return. The
//    signal uses only prices ≤ rb; entry is at rb; the forward window is rb→rb+1mo (no overlap).
//  • Per period: Spearman rank-IC(reversalScore, fwdRet). Controls: OOS split + label-shuffle placebo.
//
// In-sample is NEVER trusted here — an attractive reversal.json is "looks good in-sample," not
// proven. Only the OOS reversal-on ledger under FDR counts. INCONCLUSIVE is an acceptable outcome.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { priceOnOrBefore, selectMeritUniverse, pack, grid, addMonths, iso } from "./build-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REV_MAX = +(process.env.REV_MAX || 500);

// ─── prices: adjusted MONTHLY closes from Polygon (vendor parity, no fallback) ──
// minBars:3 — reversal needs only price(rb−1mo), price(rb) and price(rb+1mo); thin names still
// contribute the windows they have (buildReversalObservations skips incomplete ones).
async function fetchPrices(sym, key){
  const candles = await fetchPolygonAggs(sym, "1month", key, { minBars: 3 });
  const data = candles.map(c => ({ t: c.time, close: c.close })).sort((a,b)=>a.t-b.t);
  return { src: "Polygon (adjusted monthly close)", data };
}

// Observations for the 1-month reversal factor across all loaded tickers, on a MONTHLY grid.
//   merit  = −(price(rb) / price(rb−1mo) − 1)   (negated trailing 1-month return; loser ⇒ high)
//   fwdRet = price(rb+1mo) / price(rb) − 1       (formed/entered at rb, held one month)
// No-lookahead: the signal window ends at entry (rb); forward windows don't overlap.
export function buildReversalObservations(loaded, lookbackM = 1){
  const dates = grid(1);                                  // monthly rebalance
  const obs = [];
  for(const [sym, d] of Object.entries(loaded)){
    const prices = d.prices;
    if(!prices || !prices.length) continue;
    const lastT = prices[prices.length-1].t;
    for(const rb of dates){
      const fwdT = addMonths(rb, 1);
      if(fwdT > lastT) continue;                           // forward window not complete yet
      const pBack = priceOnOrBefore(prices, addMonths(rb, -lookbackM)); // start of the trailing window
      const entry = priceOnOrBefore(prices, rb);                        // signal cutoff == entry
      const exit  = priceOnOrBefore(prices, fwdT);
      if(!(pBack>0) || !(entry>0) || !(exit>0)) continue;
      obs.push({ sym, period: iso(rb), merit: -(entry/pBack - 1), fwdRet: exit/entry - 1 });
    }
  }
  return obs;
}

// Honest caveats — reversal is price-only, so its lookahead story is simple.
function reversalCaveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), bounded to REV_MAX names for CI runtime — de-listed losers are INCLUDED (critical for a reversal study)."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias is especially corrosive for reversal (the de-listed losers that DIDN'T bounce are missing); run universe-build for roster.json.",
    "Signal is the NEGATED most-recent-month return (loser ⇒ high score), so a positive rank-IC means 'recent losers bounce'. Prices are Polygon split/dividend-adjusted monthly closes.",
    "1-month NON-overlapping forward windows → the naive IC t is honest (no HAC inflation). One cross-section per rebalance still means modest power; INCONCLUSIVE is acceptable.",
    "Reversal at 1 month is the orthogonal complement to 12-1 momentum (which skips this month by design); a positive reversal IC alongside positive momentum IC is internally consistent, not a contradiction.",
    "In-sample is NEVER trusted here — only the OOS reversal-on ledger, cleared through FDR, is tradeable evidence.",
  ];
}

// Prefer the survivorship-free roster.json (reusing selectMeritUniverse for the active:de-listed
// proportion); fall back to the legacy tickers.txt set. Reversal needs only tickers — no CIK/SEC.
function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, REV_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return {
        tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${REV_MAX})`,
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
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the reversal study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source: universeSource, survivorshipFree } = resolveUniverse();
  console.log("reversal universe: " + universeSource);
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

  // A single factor configuration (1-month reversal) is tested → trials=1 (no config-search haircut).
  const rev1 = pack(buildReversalObservations(loaded, 1), { trials: 1 });

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(loaded).length, source: universeSource, survivorshipFree, skipped: errors },
    source: { prices: priceSrc || "unavailable" },
    primary: "1mo",
    reversalEdgeProven: rev1.proven,
    windows: { "1mo": rev1 },
    caveats: reversalCaveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT,"reversal.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote reversal.json — primary(1mo): "+rev1.significance+
    ", periods="+rev1.periods+", meanIC="+rev1.meanIC+
    ", proven="+rev1.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
