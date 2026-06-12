// Track B foundation — break the survivorship bias with a BROAD, liquidity-ranked
// universe pulled from Polygon's GROUPED DAILY endpoint.
//
// The studies today run on ~36 hand-picked, still-listed large-caps. study.json
// names this as caveat #1: "survivorship bias inflates any positive result;
// de-listed losers are absent." You cannot tune your way out of a biased sample —
// you have to widen it. Polygon's grouped-daily endpoint returns EVERY US stock's
// OHLCV for a single trading day in ONE request:
//   GET /v2/aggs/grouped/locale/us/market/stocks/{date}?adjusted=true
// So one call (not 36) yields the whole market on a date; rank by dollar volume and
// you have a broad, liquidity-screened universe to backtest on — including the names
// that later languished, which is exactly what a survivorship-free test needs.
//
// This file is the SCAFFOLD: pure, unit-tested selection helpers + a CLI that does
// the live pull (needs POLYGON_API_KEY, runs in CI like the sibling studies). It
// writes universe.json — a dated, liquidity-ranked ticker list the studies can read
// instead of the static tickers.txt. The pure helpers (parseGroupedDaily,
// selectUniverse) are tested offline; main() only runs on direct invocation.
//
// Requires POLYGON_API_KEY. Grouped daily is ONE request, so the free-tier rate
// limit is a non-issue here — the whole point is to stop looping per ticker.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POLY = "https://api.polygon.io";

// Polygon grouped-daily JSON → one row per ticker for that day. Each result carries
// T(icker), o/h/l/c, v(olume) and vw (vol-weighted avg price). We derive dollar
// volume (close × volume) as the liquidity rank key. Pure; drops malformed rows.
export function parseGroupedDaily(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(b => ({
    ticker: b.T,
    open:  +(+b.o).toFixed(4),
    high:  +(+b.h).toFixed(4),
    low:   +(+b.l).toFixed(4),
    close: +(+b.c).toFixed(4),
    volume: +b.v || 0,
    dollarVolume: Math.round((+b.c || 0) * (+b.v || 0)),
  })).filter(d => d.ticker && d.close > 0 && d.volume > 0);
}

// Screen + rank a parsed grouped-daily snapshot into a tradeable universe. Filters
// out illiquid names and penny/oversized prices, drops obvious non-common-stock
// symbols (warrants/units/preferreds carry '.'/'-'/'+'/'/' in Polygon tickers),
// then ranks by dollar volume and takes the top `limit`. Pure and deterministic.
export function selectUniverse(rows, opts = {}){
  const { minPrice = 5, maxPrice = 1e6, minDollarVol = 5e6, limit = 500 } = opts;
  const isCommon = t => /^[A-Z]{1,5}$/.test(t);  // plain symbols only; excludes BRK.B, units, warrants
  return rows
    .filter(r => isCommon(r.ticker) && r.close >= minPrice && r.close <= maxPrice && r.dollarVolume >= minDollarVol)
    .sort((a, b) => b.dollarVolume - a.dollarVolume)
    .slice(0, limit)
    .map(r => r.ticker);
}

// Pick a sensible default snapshot date: the most recent weekday on/before `from`.
// (Grouped daily returns an empty results set on weekends/holidays — a weekday is
// a safe default; the CLI lets you pass an explicit --date for a known trading day.)
export function recentWeekday(from = new Date()){
  const d = new Date(from);
  while(d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// One grouped-daily request → parsed rows. Exported so studies can reuse the fetcher.
export async function fetchGroupedDaily(date, key){
  const u = `${POLY}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP " + r.status);
  const rows = parseGroupedDaily(await r.json());
  if(rows.length < 100) throw new Error("only " + rows.length + " rows for " + date + " (market holiday? try --date a known trading day)");
  return rows;
}

function parseArgs(argv){
  const a = { preview:false, date:recentWeekday(), limit:500, minDollarVol:5e6 };
  for(let i=2;i<argv.length;i++){ const x=argv[i];
    if(x==="--preview") a.preview=true;
    else if(x==="--date") a.date=argv[++i];
    else if(x==="--limit") a.limit=+argv[++i];
    else if(x==="--min-dollar-vol") a.minDollarVol=+argv[++i];
  }
  return a;
}

async function main(){
  const args = parseArgs(process.argv);
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — no fallback vendor by design."); process.exit(2); }

  const rows = await fetchGroupedDaily(args.date, key);
  const tickers = selectUniverse(rows, { limit:args.limit, minDollarVol:args.minDollarVol });
  const out = {
    generatedAt: new Date().toISOString(),
    source: "Polygon grouped daily (adjusted)",
    snapshotDate: args.date,
    marketRows: rows.length,
    screen: { minPrice:5, minDollarVol:args.minDollarVol, limit:args.limit },
    note: "Liquidity-ranked broad universe — supersedes the 36-name tickers.txt to remove survivorship bias.",
    count: tickers.length,
    tickers,
  };

  if(args.preview){
    console.log(`grouped daily ${args.date}: ${rows.length} market rows → ${tickers.length} after screen.`);
    console.log("top 20 by $vol: " + tickers.slice(0, 20).join(", "));
    return;
  }
  if(tickers.length === 0){ console.error("No tickers passed the screen — refusing to overwrite universe.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "universe.json"), JSON.stringify(out) + "\n");
  console.log(`Wrote universe.json — ${tickers.length} tickers from ${rows.length} market rows on ${args.date}.`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
