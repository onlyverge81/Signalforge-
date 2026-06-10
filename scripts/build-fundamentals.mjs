// Build fundamentals.json from SEC EDGAR — run nightly in CI.
//
// For each ticker in tickers.txt: resolve its CIK, pull the XBRL companyfacts
// feed, and distill the PRICE-INDEPENDENT figures (TTM EPS, book value/share,
// and the ratios that don't need a price). The app derives P/E and P/B at render
// time from the live price ÷ filed EPS/BVPS, so the ratios stay current between
// nightly runs. Output is keyed by ticker and read same-origin by the app.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { secCik, secFetch, secTTM, secQYoY, secInstant, secFirst } from "./sec-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function readTickers(file){
  const txt = fs.readFileSync(file || path.join(__dirname, "tickers.txt"), "utf8");
  return txt.split(/\r?\n/)
    .map(s => s.replace(/#.*$/, "").trim().toUpperCase())
    .filter(Boolean);
}

// Distill one companyfacts JSON into the stored record. Pure — unit-tested.
export function distill(j){
  const G=(j.facts&&j.facts["us-gaap"])||{}, D=(j.facts&&j.facts["dei"])||{};
  // Flow items → trailing twelve months from the quarterly filings.
  const epsT=secTTM(secFirst(G,["EarningsPerShareDiluted","EarningsPerShareBasic"]));
  const niT =secTTM(secFirst(G,["NetIncomeLoss","ProfitLoss"]));
  const revT=secTTM(secFirst(G,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"]));
  // Balance-sheet items → latest reported quarter (already current).
  const equity=secInstant(secFirst(G,["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]));
  const shares=secInstant(secFirst(D,["EntityCommonStockSharesOutstanding"])||secFirst(G,["CommonStockSharesOutstanding"]));
  const assetsC=secInstant(secFirst(G,["AssetsCurrent"]));
  const liabC =secInstant(secFirst(G,["LiabilitiesCurrent"]));
  const ltd=secInstant(secFirst(G,["LongTermDebtNoncurrent","LongTermDebt"]));
  const std=secInstant(secFirst(G,["LongTermDebtCurrent","DebtCurrent"]));
  const debt=(ltd!=null||std!=null)?((ltd||0)+(std||0)):null;
  const eps=epsT&&epsT.val, ni=niT&&niT.val, rev=revT&&revT.val;
  // Growth → latest quarter year-over-year.
  const revG=secQYoY(secFirst(G,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"]));
  const epsG=secQYoY(secFirst(G,["EarningsPerShareDiluted","EarningsPerShareBasic"]));

  const rec={}, set=(k,v)=>{ if(v!=null&&isFinite(v)) rec[k]=+(+v).toFixed(6); };
  set("epsTTM", eps);                                  // for P/E = price ÷ epsTTM
  if(equity>0&&shares>0) set("bvps", equity/shares);   // for P/B = price ÷ bvps
  if(debt!=null&&equity>0) set("de", debt/equity);
  if(ni!=null&&equity>0)   set("roe", ni/equity);
  if(ni!=null&&rev>0)      set("npm", ni/rev);
  if(assetsC!=null&&liabC>0) set("cr", assetsC/liabC);
  if(revG!=null) set("revG", revG);
  if(epsG!=null) set("epsG", epsG);

  const asof=(niT||revT||epsT||{}).end||null;
  const basis=(niT&&niT.basis)||(revT&&revT.basis)||"TTM"; // TTM unless only an annual was available
  return { rec, asof, basis };
}

async function buildOne(sym){
  const cik=await secCik(sym);
  if(!cik) return { sym, error:"not in SEC EDGAR" };
  const r=await secFetch("https://data.sec.gov/api/xbrl/companyfacts/CIK"+cik+".json");
  const j=await r.json();
  const { rec, asof, basis }=distill(j);
  if(Object.keys(rec).length===0) return { sym, error:"no usable figures" };
  return { sym, data:{ entity:j.entityName||sym, cik, asof, basis, ...rec } };
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function main(){
  const tickers=readTickers();
  const out={}, errors=[];
  for(const sym of tickers){
    try{
      const res=await buildOne(sym);
      if(res.data){ out[sym]=res.data; console.log("✓ "+sym.padEnd(6)+" "+res.data.entity+" (as of "+res.data.asof+", "+res.data.basis+")"); }
      else { errors.push(sym+": "+res.error); console.warn("✗ "+sym.padEnd(6)+" — "+res.error); }
    }catch(e){ errors.push(sym+": "+(e.message||e)); console.warn("✗ "+sym.padEnd(6)+" — "+(e.message||e)); }
    await sleep(250); // be polite to SEC (≤10 req/s; we do ~4)
  }
  fs.writeFileSync(path.join(ROOT,"fundamentals.json"), JSON.stringify(out)+"\n");
  console.log("\nWrote fundamentals.json — "+Object.keys(out).length+" companies"+(errors.length?(", "+errors.length+" skipped"):"")+".");
}

// Run only when invoked directly (so tests can import distill/readTickers).
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
