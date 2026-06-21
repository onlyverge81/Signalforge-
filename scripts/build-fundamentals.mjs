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
import { secCik, secFetch, secTTM, secQYoY, secInstant, secFirst, secLastFiled } from "./sec-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export function readTickers(file){
  const txt = fs.readFileSync(file || path.join(__dirname, "tickers.txt"), "utf8");
  return txt.split(/\r?\n/)
    .map(s => s.replace(/#.*$/, "").trim().toUpperCase())
    .filter(Boolean);
}

const FUND_MAX = +(process.env.FUND_MAX || 500);

// Full-market grouped-snapshot JSON → { SYM: dollarVolume } (price × day volume).
// Used to rank the active roster by liquidity, so the fundamentals universe is the
// ~500 most-traded names (a sensible "research today" set), not an alphabetical slice.
// Falls back to prevDay when the session hasn't opened. Pure.
export function parseSnapshotDollarVol(j){
  const arr = j && j.tickers;
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (const t of arr){
    if (!t || !t.ticker) continue;
    const px  = (t.day && t.day.c) || (t.prevDay && t.prevDay.c) || (t.lastTrade && t.lastTrade.p) || 0;
    const vol = (t.day && t.day.v) || (t.prevDay && t.prevDay.v) || 0;
    const dv = px * vol;
    if (dv > 0) out[String(t.ticker).toUpperCase()] = dv;
  }
  return out;
}

// Pure: pick the top `cap` ACTIVE, CIK-bearing roster names by dollar volume. Active
// only (this is a "buy/research today" universe — de-listed names don't belong), and
// names with no liquidity reading sort to the bottom. Ticker tie-break for determinism.
export function selectLiquidUniverse(companies, dollarVol, cap = FUND_MAX){
  const dv = dollarVol || {};
  const scored = (companies || [])
    .filter(c => c && c.ticker && c.cik && c.active !== false)
    .map(c => ({ sym: String(c.ticker).toUpperCase(), cik: c.cik, dv: dv[String(c.ticker).toUpperCase()] || 0 }));
  scored.sort((a, b) => (b.dv - a.dv) || (a.sym < b.sym ? -1 : a.sym > b.sym ? 1 : 0));
  return scored.slice(0, cap).map(({ sym, cik }) => ({ sym, cik }));
}

// Prefer the survivorship-free roster.json ranked by live dollar volume (top ~500
// active names with a CIK); fall back to the legacy tickers.txt + secCik when the
// roster or the snapshot is unavailable (CI-safe). Returns { entries:[{sym,cik}], source }.
export function resolveFundamentalsUniverse(snapshotJson){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if (Array.isArray(r.companies) && r.companies.length && snapshotJson){
      const picked = selectLiquidUniverse(r.companies, parseSnapshotDollarVol(snapshotJson), FUND_MAX);
      if (picked.length) return { entries: picked, source: `roster.json top-${picked.length} active by dollar volume (cap ${FUND_MAX})` };
    }
  }catch{ /* no roster.json yet → fall back */ }
  return { entries: readTickers().map(sym => ({ sym, cik: null })), source: "tickers.txt (legacy survivor set — run universe-build for roster.json)" };
}

// Distill one companyfacts JSON into the stored record. Pure — unit-tested.
// Optional `asOf` (ISO date) makes the whole record POINT-IN-TIME — only figures
// knowable on that date are used — which is what the merit-evidence study needs
// to reconstruct historical merit without lookahead. Omitting it = latest values.
export function distill(j, asOf){
  const G=(j.facts&&j.facts["us-gaap"])||{}, D=(j.facts&&j.facts["dei"])||{};
  // Flow items → trailing twelve months from the quarterly filings.
  const epsT=secTTM(secFirst(G,["EarningsPerShareDiluted","EarningsPerShareBasic"]), asOf);
  const niT =secTTM(secFirst(G,["NetIncomeLoss","ProfitLoss"]), asOf);
  const revT=secTTM(secFirst(G,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"]), asOf);
  // Balance-sheet items → latest reported quarter (already current).
  const equity=secInstant(secFirst(G,["StockholdersEquity","StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"]), asOf);
  const shares=secInstant(secFirst(D,["EntityCommonStockSharesOutstanding"])||secFirst(G,["CommonStockSharesOutstanding"]), asOf);
  const assetsC=secInstant(secFirst(G,["AssetsCurrent"]), asOf);
  const liabC =secInstant(secFirst(G,["LiabilitiesCurrent"]), asOf);
  const ltd=secInstant(secFirst(G,["LongTermDebtNoncurrent","LongTermDebt"]), asOf);
  const std=secInstant(secFirst(G,["LongTermDebtCurrent","DebtCurrent"]), asOf);
  const debt=(ltd!=null||std!=null)?((ltd||0)+(std||0)):null;
  const eps=epsT&&epsT.val, ni=niT&&niT.val, rev=revT&&revT.val;
  // Growth → latest quarter year-over-year.
  const revG=secQYoY(secFirst(G,["RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"]), asOf);
  const epsG=secQYoY(secFirst(G,["EarningsPerShareDiluted","EarningsPerShareBasic"]), asOf);

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
  // Latest filing date across the income-statement tags — the earnings-announcement proxy (a
  // 10-Q/10-K's `filed` date ≈ the earnings release). Point-in-time via the same asOf cutoff.
  const lastFiled=secLastFiled(G, ["EarningsPerShareDiluted","EarningsPerShareBasic","NetIncomeLoss","ProfitLoss","RevenueFromContractWithCustomerExcludingAssessedTax","Revenues","SalesRevenueNet","RevenueFromContractWithCustomerIncludingAssessedTax"], asOf);
  return { rec, asof, basis, lastFiled };
}

async function buildOne(sym, cik){
  cik = cik || await secCik(sym); // roster supplies the CIK; fall back to the SEC map
  if(!cik) return { sym, error:"not in SEC EDGAR" };
  const r=await secFetch("https://data.sec.gov/api/xbrl/companyfacts/CIK"+cik+".json");
  const j=await r.json();
  const { rec, asof, basis, lastFiled }=distill(j);
  if(Object.keys(rec).length===0) return { sym, error:"no usable figures" };
  return { sym, data:{ entity:j.entityName||sym, cik, asof, basis, lastFiled, ...rec } };
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

const POLY = "https://api.polygon.io";
// ONE full-market grouped snapshot → liquidity ranking input. No tickers filter, so a
// single call covers the whole market. Polygon is the only price vendor by charter;
// returns null (→ legacy fallback) without a key or on any error. Not unit-tested
// (the container blocks api.polygon.io); the parsing helper above is.
async function fetchFullSnapshot(key){
  if(!key) return null;
  try{
    const r = await fetch(`${POLY}/v2/snapshot/locale/us/markets/stocks/tickers?apiKey=${encodeURIComponent(key)}`);
    if(!r.ok) return null;
    return await r.json();
  }catch{ return null; }
}

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  const snap = await fetchFullSnapshot(key);
  const { entries, source } = resolveFundamentalsUniverse(snap);
  console.log("fundamentals universe: "+source+" ("+entries.length+" names)");
  const out={}, errors=[];
  for(const { sym, cik } of entries){
    try{
      const res=await buildOne(sym, cik);
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
