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
// Requires POLYGON_API_KEY. The market snapshot is ONE grouped-daily request; the
// universe is then restricted to active common stock (type=CS) via the reference
// endpoint (a handful of paged requests, paced for the free tier) so ETFs and
// leveraged/inverse funds are excluded — we want real companies, not funds.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POLY = "https://api.polygon.io";
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
// out illiquid names and penny/oversized prices, drops symbol formats that aren't
// plain common stock (warrants/units/preferreds carry '.'/'-'/'+'/'/'), and — when
// an `allow` set is supplied — keeps ONLY those tickers (used to restrict to active
// common stocks, type=CS, so ETFs and leveraged/inverse funds are excluded). Then
// ranks by dollar volume and takes the top `limit`. Pure and deterministic.
export function selectUniverse(rows, opts = {}){
  const { minPrice = 5, maxPrice = 1e6, minDollarVol = 5e6, limit = 500, allow = null } = opts;
  const isCommon = t => /^[A-Z]{1,5}$/.test(t);  // plain symbols only; excludes BRK.B, units, warrants
  const allowed = allow ? (allow instanceof Set ? allow : new Set(allow)) : null;
  return rows
    .filter(r => isCommon(r.ticker)
      && (!allowed || allowed.has(r.ticker))
      && r.close >= minPrice && r.close <= maxPrice && r.dollarVolume >= minDollarVol)
    .sort((a, b) => b.dollarVolume - a.dollarVolume)
    .slice(0, limit)
    .map(r => r.ticker);
}

// Polygon reference-tickers JSON → array of ticker symbols. Pure; drops malformed rows.
export function parseRefTickers(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(t => t && t.ticker).filter(Boolean);
}

// Shift an ISO date (YYYY-MM-DD) by `days` (may be negative). Pure, UTC.
export function shiftDay(dateStr, days){
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Pick a sensible default snapshot date: the most recent weekday on/before `from`.
// (Grouped daily returns an empty results set on weekends/holidays — a weekday is
// a safe default; the CLI lets you pass an explicit --date for a known trading day.)
export function recentWeekday(from = new Date()){
  const d = new Date(from);
  while(d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Normalize a raw ticker list: uppercase, trim, drop blanks, de-dupe (stable order). Pure.
export function normTickers(list){
  const seen = new Set(), out = [];
  for(const t of (list || [])){
    const s = String(t || "").trim().toUpperCase();
    if(s && !seen.has(s)){ seen.add(s); out.push(s); }
  }
  return out;
}

// Choose the study universe with a clear precedence (pure, testable):
//   1) an explicit --tickers list (operator override) always wins
//   2) else the broad, survivorship-free universe.json (if present & non-empty)
//   3) else the static tickers.txt fallback (the legacy 36 names)
// Returns the resolved tickers plus a human-readable `source` for the run log.
export function pickUniverse({ explicit, universe, fallback }){
  const e = normTickers(explicit), u = normTickers(universe), f = normTickers(fallback);
  if(e.length) return { tickers:e, source:"--tickers override" };
  if(u.length) return { tickers:u, source:"universe.json (broad, survivorship-free)" };
  return { tickers:f, source:"tickers.txt (legacy default)" };
}

// Resolve the universe from disk for a study: explicit file → universe.json → tickers.txt.
// `readTickersFn` is injected (build-fundamentals.readTickers) so this module stays
// dependency-free and tests can import the pure pickers without touching the network.
export function loadStudyUniverse({ root, explicitFile, readTickersFn }){
  const explicit = explicitFile ? readTickersFn(explicitFile) : null;
  let universe = null;
  try { universe = (JSON.parse(fs.readFileSync(path.join(root, "universe.json"), "utf8")) || {}).tickers || null; }
  catch { /* no universe.json yet → fall back */ }
  return pickUniverse({ explicit, universe, fallback: readTickersFn() });
}

// One grouped-daily request → parsed rows. Exported so studies can reuse the fetcher.
export async function fetchGroupedDaily(date, key){
  const u = `${POLY}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP " + r.status);
  const rows = parseGroupedDaily(await r.json());
  if(rows.length < 100) throw new Error("only " + rows.length + " rows for " + date + " (market holiday / not yet settled)");
  return rows;
}

// Walk back from `start` up to `maxBack` days until grouped-daily returns a usable
// snapshot — skips the not-yet-settled current day, weekends, and holidays. Network.
export async function resolveSnapshot(key, start, maxBack = 7){
  let lastErr = null;
  for(let i = 0; i <= maxBack; i++){
    const date = shiftDay(start, -i);
    try { return { date, rows: await fetchGroupedDaily(date, key) }; }
    catch(e){ lastErr = e; /* 0 rows / holiday → step back a day and retry */ }
  }
  throw new Error(`no usable grouped-daily snapshot within ${maxBack + 1} days back from ${start}: ${lastErr && lastErr.message}`);
}

// All ACTIVE US common stocks (type=CS) as a Set — used to drop ETFs, leveraged/
// inverse funds, ADRs-as-funds, etc. so the universe is real companies. Pages via
// next_url; unthrottled on Starter (unlimited calls). Network; parseRefTickers is
// the unit-tested part.
export async function fetchCommonStockSet(key, pace = 0){
  const set = new Set();
  let url = `${POLY}/v3/reference/tickers?type=CS&market=stocks&active=true&limit=1000&apiKey=${encodeURIComponent(key)}`;
  for(let page = 0; url && page < 25; page++){
    const r = await fetch(url);
    if(r.status === 429) throw new Error("rate limited (429) on reference/tickers — raise POLYGON_PACE_MS");
    if(!r.ok) throw new Error("polygon HTTP " + r.status + " on reference/tickers");
    const j = await r.json();
    for(const t of parseRefTickers(j)) set.add(t);
    url = j.next_url ? j.next_url + `&apiKey=${encodeURIComponent(key)}` : null;
    if(url) await sleep(pace);
  }
  return set;
}

function parseArgs(argv){
  // Default to the most recent weekday BEFORE today — the current session isn't
  // settled until after the close, so "today" has no grouped-daily data yet.
  const a = { preview:false, date:recentWeekday(new Date(Date.now() - 864e5)), limit:500, minDollarVol:5e6 };
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
  const pace = +(process.env.POLYGON_PACE_MS || 0);  // Starter: unlimited calls — no throttle needed

  // 1) The set of real companies (active common stock), so ETFs / leveraged funds drop out.
  console.log("fetching active common-stock list (type=CS)…");
  const csSet = await fetchCommonStockSet(key, pace);
  console.log("common stocks (type=CS): " + csSet.size);
  if(csSet.size < 1000) throw new Error("reference/tickers returned only " + csSet.size + " common stocks — refusing to over-filter.");

  // 2) The most recent settled market snapshot (walks back over today/weekends/holidays).
  const { date, rows } = await resolveSnapshot(key, args.date, 7);
  const tickers = selectUniverse(rows, { limit:args.limit, minDollarVol:args.minDollarVol, allow:csSet });
  const out = {
    generatedAt: new Date().toISOString(),
    source: "Polygon grouped daily (adjusted) + reference tickers (type=CS)",
    snapshotDate: date,
    marketRows: rows.length,
    screen: { minPrice:5, minDollarVol:args.minDollarVol, limit:args.limit, commonStocksOnly:true },
    note: "Liquidity-ranked broad universe of ACTIVE COMMON STOCKS (type=CS) — ETFs and leveraged/inverse funds excluded; supersedes the 36-name tickers.txt to remove survivorship bias.",
    count: tickers.length,
    tickers,
  };

  if(args.preview){
    console.log(`snapshot ${date}: ${rows.length} market rows → ${tickers.length} common stocks after screen.`);
    console.log("top 20 by $vol: " + tickers.slice(0, 20).join(", "));
    return;
  }
  if(tickers.length === 0){ console.error("No tickers passed the screen — refusing to overwrite universe.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "universe.json"), JSON.stringify(out) + "\n");
  console.log(`Wrote universe.json — ${tickers.length} common stocks from ${rows.length} market rows on ${date}.`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
