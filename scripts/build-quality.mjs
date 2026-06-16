// Build quality.json — the cross-sectional QUALITY (profitability) evidence harness. Run in CI.
//
// Question: do MORE-PROFITABLE names earn a HIGHER forward return than less-profitable ones
// across the universe (the quality / profitability premium), out-of-sample, surviving a
// label-shuffle placebo? This is a NON-PRICE, fundamental factor — distinct from the merit
// COMPOSITE (which blends valuation + health + growth): quality reads pure profitability only.
//
// Like the price factors it's CROSS-SECTIONAL and reuses the merit machinery verbatim —
// `runStudy`/`walkForward`/`deflated`/`placebo`/`betaControl` in study-lib.mjs are factor-agnostic
// (they only need { period, merit, fwdRet }). It also reuses the merit study's SEC+price loading
// (`loadTicker`, `resolveMeritUniverse`) and point-in-time `distill`. The only new thing is
// `buildQualityObservations`, which sets `merit = a profitability ratio` (ROE or net margin), so a
// MORE-PROFITABLE name scores HIGH and a positive rank-IC means "quality outperforms".
//
// Method (all lookahead-controlled):
//  • Fundamentals reconstructed point-in-time from SEC XBRL with the same 75-day filing lag as
//    merit (`meritAsOfISO`) — no fundamental lookahead. Prices: Polygon adjusted MONTHLY closes.
//  • Survivorship-free roster.json universe (active + de-listed), reusing resolveMeritUniverse.
//  • Monthly rebalance grid; 1-month, NON-overlapping forward windows (overlap=0 → honest naive t).
//  • Two profitability windows — ROE and net profit margin (NPM) → trials=2.
//  • Per period: Spearman rank-IC(profitability, fwdRet). Controls: OOS split + label-shuffle placebo.
//
// In-sample is NEVER trusted here — only the OOS quality-on ledger under FDR counts. Quality and
// the merit grade share the profitability inputs, so the FDR family's BY cross-check (which is
// robust to dependence) matters more than usual. INCONCLUSIVE is an acceptable outcome.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distill as realDistill } from "./build-fundamentals.mjs";
import { loadTicker, resolveMeritUniverse, priceOnOrBefore, meritAsOfISO, pack, grid, addMonths, iso } from "./build-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Observations for one profitability metric across all loaded tickers, on a MONTHLY grid.
//   merit  = rec[metric] at rb−75d (ROE or NPM, point-in-time)   (more profitable ⇒ higher)
//   fwdRet = price(rb+1mo) / price(rb) − 1                        (held one month)
// `distill` is injectable so the no-lookahead/sign contract can be unit-tested without raw XBRL.
export function buildQualityObservations(loaded, metric, { distill = realDistill } = {}){
  const dates = grid(1);                                  // monthly rebalance
  const obs = [];
  for(const [sym, d] of Object.entries(loaded)){
    const prices = d.prices;
    if(!prices || !prices.length) continue;
    const lastT = prices[prices.length-1].t;
    for(const rb of dates){
      const fwdT = addMonths(rb, 1);
      if(fwdT > lastT) continue;                           // forward window not complete yet
      const entry = priceOnOrBefore(prices, rb);
      const exit  = priceOnOrBefore(prices, fwdT);
      if(!(entry>0) || !(exit>0)) continue;
      const rec = distill(d.j, meritAsOfISO(rb)).rec;      // fundamentals public ≥75d before rebalance
      const v = rec ? rec[metric] : null;
      if(v == null || !isFinite(v)) continue;
      obs.push({ sym, period: iso(rb), merit: Number(v), fwdRet: exit/entry - 1 });
    }
  }
  return obs;
}

function qualityCaveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), bounded for CI runtime — de-listed names are INCLUDED."
      : "Universe is the legacy survivor set — survivorship bias inflates quality (the unprofitable names that died are missing); run universe-build for roster.json.",
    "Quality is pure PROFITABILITY (ROE / net margin), reconstructed point-in-time from SEC XBRL with a 75-day filing lag — no fundamental lookahead. Prices are Polygon split/dividend-adjusted monthly closes.",
    "Quality shares its profitability inputs with the merit grade, so quality-on and merits-on are correlated variants — lean on the FDR family's BY (dependence-robust) cross-check, not BH alone.",
    "1-month NON-overlapping forward windows → the naive IC t is honest (no HAC inflation). XBRL exists only from ~2009 and fundamentals move slowly, so power is modest; INCONCLUSIVE is acceptable.",
    "In-sample is NEVER trusted here — only the OOS quality-on ledger, cleared through FDR, is tradeable evidence.",
  ];
}

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the quality study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { entries, source: universeSource, survivorshipFree } = resolveMeritUniverse();
  console.log("quality universe: " + universeSource);
  const loaded={}; const errors=[]; let priceSrc=null;
  for(const { sym, cik } of entries){
    try{
      const d = await loadTicker(sym, key, cik);
      loaded[sym] = d; priceSrc = priceSrc || d.priceSrc;
      console.log("✓ "+sym.padEnd(6)+" "+d.prices.length+" monthly bars");
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
    await new Promise(r=>setTimeout(r,300)); // be polite to SEC EDGAR (Polygon is unthrottled)
  }

  // trials=2 — two profitability windows (ROE and net margin) are tested, so the deflated-t is
  // haircut for the configuration search even in-sample (an honest overfit control).
  const TRIALS = 2;
  const roe = pack(buildQualityObservations(loaded, "roe"), { trials: TRIALS });
  const npm = pack(buildQualityObservations(loaded, "npm"), { trials: TRIALS });

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: entries.length, covered: Object.keys(loaded).length, source: universeSource, survivorshipFree, skipped: errors },
    source: { fundamentals:"SEC EDGAR XBRL (point-in-time, 75-day filing lag)", prices: priceSrc||"unavailable" },
    primary: "roe",
    qualityEdgeProven: roe.proven,
    windows: { "roe": roe, "npm": npm },
    caveats: qualityCaveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT,"quality.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote quality.json — primary(roe): "+roe.significance+
    ", periods="+roe.periods+", meanIC="+roe.meanIC+
    ", proven="+roe.proven+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
