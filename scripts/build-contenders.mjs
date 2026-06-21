// Build contenders.json — the daily A/B shortlist for pre-execution diligence.
//
// This is the on-ramp from "universe" → "research" → "execution": a curated,
// ranked watchlist of the names worth a deeper look TODAY. It joins data already
// on disk — fundamentals.json (SEC EDGAR, distilled nightly) and pattern-study.json
// (the convergence-breakout edge per ticker) — with a LIVE Polygon price (one
// grouped snapshot) and Polygon's filing record (/vX/reference/financials) for each
// name. Every ticker is graded with the SAME valueScore() the app's AUTOPSY uses,
// the A/B names are kept, and each is annotated with a technical edge and a
// SEC-vs-Polygon filing cross-check. A name that clears ALL THREE boxes
// (grade A/B · positive technical edge · filings agree) is flagged allBoxes — the
// "checked off before execution" shortlist. Writes contenders.json, read
// same-origin by the app's CONTENDERS tab.
//
// Why daily: the valuation half of the grade (P/E, P/B) moves with price every day,
// so A/B membership changes daily; the quality/growth half only changes on new
// filings — filing.daysAgo surfaces when that last happened, cueing a fresh
// diligence pass each earnings season.
//
// Network budget: ONE grouped snapshot for all prices + one financials call per
// ticker (paced 13s for the free tier's 5 req/min; financials are non-fatal so an
// un-entitled tier still yields the graded list). The pure helpers are unit-tested
// offline; main() only runs when the file is invoked directly, so tests import safely.
//
// Requires POLYGON_API_KEY. No fallback vendor by design: if fundamentals.json is
// missing or no A/B name survives, it refuses to overwrite a good contenders.json.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { valueScore } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const POLY = "https://api.polygon.io";

function readJSON(p){ try{ return JSON.parse(fs.readFileSync(p, "utf8")); }catch(e){ return null; } }

// ─── Pure helpers (unit-tested offline) ──────────────────────────────────────

// Assemble the valueScore() input from a fundamentals.json record + a live price.
// Byte-for-byte the same derivation the app and forward-log use (gradeFor): P/E and
// P/B come from today's price ÷ filed EPS/BVPS, so the grade stays current between
// nightly filing refreshes. Pure.
export function metricMap(rec, price){
  const n = v => (v == null || isNaN(v)) ? null : Number(v);
  const map = {};
  const put = (k, v) => { if (v != null && isFinite(v)) map[k] = +(+v).toFixed(4); };
  const eps = n(rec.epsTTM), bvps = n(rec.bvps);
  if (price > 0 && eps > 0)  put("peTTM", price / eps);
  if (price > 0 && bvps > 0) put("pbAnnual", price / bvps);
  put("totalDebt/totalEquityAnnual", n(rec.de));
  put("roeTTM", n(rec.roe));
  put("netProfitMarginTTM", n(rec.npm));
  put("currentRatioAnnual", n(rec.cr));
  put("revenueGrowthTTMYoy", n(rec.revG));
  put("epsGrowthTTMYoy", n(rec.epsG));
  return map;
}

// Grouped-snapshot JSON → { SYM: price }. Prefer the live last trade, then today's
// close, then the previous close (so pre-open, when day.c is 0, we still get a price).
// Pure.
export function parseSnapshotPrices(j){
  const arr = j && j.tickers;
  const out = {};
  if (!Array.isArray(arr)) return out;
  for (const t of arr){
    if (!t || !t.ticker) continue;
    const px = (t.lastTrade && t.lastTrade.p)
            || (t.day && t.day.c)
            || (t.prevDay && t.prevDay.c)
            || (t.min && t.min.c)
            || null;
    if (px > 0) out[String(t.ticker).toUpperCase()] = +(+px).toFixed(4);
  }
  return out;
}

// /vX/reference/financials JSON → the latest filing's provenance + headline equity.
// Pure. Returns null when no filing is present.
export function parsePolygonFinancials(j){
  const r = j && Array.isArray(j.results) && j.results[0];
  if (!r) return null;
  const bs = (r.financials && r.financials.balance_sheet) || {};
  const eqNode = bs.equity || bs.equity_attributable_to_parent || null;
  const equity = eqNode && typeof eqNode.value === "number" ? eqNode.value : null;
  return {
    filingDate: r.filing_date || null,
    fiscalPeriod: r.fiscal_period || null,
    fiscalYear: r.fiscal_year || null,
    endDate: r.end_date || null,
    equity,
  };
}

// Cross-reference the SEC-derived record against Polygon's filing record. The honest,
// tier-agnostic check is PERIOD ALIGNMENT: both sources should reflect the same most
// recent reporting period. A large gap means they disagree on what the latest filing
// is — worth a manual look before trusting either. (Equity is captured for display
// but not gated on, since fundamentals.json stores book value/share, not raw equity.)
// Pure.
export function crossCheck(rec, fin){
  if (!fin || (!fin.filingDate && !fin.endDate)){
    return { ok: true, checked: false, note: "No Polygon filing to cross-check — SEC used as-is." };
  }
  const secAsof = rec && rec.asof ? Date.parse(rec.asof) : NaN;
  const polyStr = fin.endDate || fin.filingDate;
  const polyEnd = Date.parse(polyStr);
  if (isNaN(secAsof) || isNaN(polyEnd)){
    return { ok: true, checked: false, polyEnd: polyStr, note: "Period dates unavailable — not cross-checked." };
  }
  const gapDays = Math.round(Math.abs(secAsof - polyEnd) / 864e5);
  const ok = gapDays <= 120; // within ~one reporting quarter
  return {
    ok, checked: true, gapDays,
    secAsof: rec.asof, polyEnd: polyStr, polyEquity: fin.equity ?? null,
    note: ok
      ? "SEC & Polygon agree on the latest reporting period."
      : "SEC (" + rec.asof + ") and Polygon (" + polyStr + ") disagree on the latest period — verify the filing.",
  };
}

// Technical box. patternRow = pattern-study universe entry (convergence-breakout
// edge). signalRow = optional signal-study entry (trend-hold backtest); when present
// its trend profit-factor ≥ 1 also passes. The name clears the box if EITHER read is
// positive. Pure, and null-safe so it works with the pattern study alone.
export function techVerdict(signalRow, patternRow){
  const patternEdge = patternRow && typeof patternRow.edge === "number" ? patternRow.edge : null;
  const patternWin  = patternRow && typeof patternRow.winRate === "number" ? patternRow.winRate : null;
  const th = signalRow && signalRow.trendHold;
  const trendPF = th && typeof th.profitFactor === "number" ? th.profitFactor : null;
  const trendExpectancy = th && typeof th.expectancy === "number" ? th.expectancy : null;
  const pass = (patternEdge != null && patternEdge > 0) || (trendPF != null && trendPF >= 1);
  return { patternEdge, patternWin, trendPF, trendExpectancy, pass };
}

// Index a study's universe[] by uppercase symbol. Pure.
export function indexUniverse(study){
  const m = {};
  const arr = study && Array.isArray(study.universe) ? study.universe : [];
  for (const r of arr){ if (r && r.sym) m[String(r.sym).toUpperCase()] = r; }
  return m;
}

// Assemble one contender record from already-fetched inputs. Pure — the network is
// done by the caller, so this (grade + all-boxes logic) is fully unit-tested.
export function buildContender({ sym, rec, price, patternRow, signalRow, fin, now = new Date() }){
  const map = metricMap(rec, price);
  const vs = valueScore(map);
  if (!vs) return null;
  const tech = techVerdict(signalRow, patternRow);
  const cc = crossCheck(rec, fin);
  const filing = fin ? {
    date: fin.filingDate, period: fin.fiscalPeriod, fiscalYear: fin.fiscalYear,
    daysAgo: fin.filingDate ? Math.round((now - Date.parse(fin.filingDate)) / 864e5) : null,
  } : null;
  const allBoxes = (vs.grade === "A" || vs.grade === "B") && tech.pass && cc.ok;
  return {
    sym, entity: rec.entity || null,
    grade: vs.grade, total: vs.total, cheap: vs.cheap, healthy: vs.healthy, growing: vs.growing,
    verdict: vs.verdict, reasons: vs.reasons, flags: vs.flags,
    price: price != null ? +(+price).toFixed(4) : null,
    peTTM: map.peTTM ?? null, pbAnnual: map.pbAnnual ?? null,
    roe: rec.roe ?? null, npm: rec.npm ?? null, de: rec.de ?? null,
    revG: rec.revG ?? null, epsG: rec.epsG ?? null,
    asof: rec.asof || null,
    filing, crossCheck: cc, tech, allBoxes,
  };
}

// Keep only A/B, rank: all-boxes first, then total score, then symbol. Pure.
export function rankContenders(list){
  return list
    .filter(c => c.grade === "A" || c.grade === "B")
    .sort((a, b) =>
      (Number(b.allBoxes) - Number(a.allBoxes)) ||
      (b.total - a.total) ||
      a.sym.localeCompare(b.sym));
}

// Why a C-grade name is still worth a look later — the "diamond in the rough"
// angles. A C that just missed the B cutoff, or whose chart is already working, or
// that's a standout in one category (deep value / high growth), is a watchlist
// candidate even if the blended grade isn't there yet. Pure.
export function classifyWatch(c){
  const tags = [];
  if (c.total >= 4) tags.push("borderline");        // within 2 of the B cutoff (6)
  if (c.tech && c.tech.pass) tags.push("techEdge");  // the chart is already working
  if (c.cheap >= 3) tags.push("deepValue");          // standout on valuation
  if (c.growing >= 3) tags.push("highGrowth");       // standout on growth → could re-rate
  return tags;
}

// The "watch later" tier: grade-C names, each tagged with its upside angle, ranked
// so the genuinely interesting ones (tagged) float above the plain C's. Pure.
export function rankWatchlist(list){
  return list
    .filter(c => c.grade === "C")
    .map(c => ({ ...c, watchTags: classifyWatch(c) }))
    .sort((a, b) =>
      (Number(b.watchTags.length > 0) - Number(a.watchTags.length > 0)) ||
      (b.total - a.total) ||
      a.sym.localeCompare(b.sym));
}

// ─── Network (not unit-tested; the container blocks api.polygon.io) ───────────

async function fetchSnapshotPrices(syms, key){
  // ONE grouped snapshot for every ticker — keeps the daily call budget tiny.
  const u = `${POLY}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${encodeURIComponent(syms.join(","))}&apiKey=${encodeURIComponent(key)}`;
  try{
    const r = await fetch(u);
    if (!r.ok) return {};
    return parseSnapshotPrices(await r.json());
  }catch(e){ return {}; }
}

async function fetchPrevClose(sym, key){
  // Per-ticker fallback when the grouped snapshot misses a name (one extra call).
  const u = `${POLY}/v2/aggs/ticker/${encodeURIComponent(sym)}/prev?adjusted=true&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if (r.status === 429) throw new Error("rate limited (429) — raise --pace / POLYGON_PACE_MS");
  if (!r.ok) throw new Error("HTTP " + r.status);
  const j = await r.json();
  const c = j && Array.isArray(j.results) && j.results[0] && j.results[0].c;
  if (!(c > 0)) throw new Error("no prev close");
  return +(+c).toFixed(4);
}

async function fetchFinancials(sym, key){
  const u = `${POLY}/vX/reference/financials?ticker=${encodeURIComponent(sym)}&limit=1&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if (r.status === 429) throw new Error("rate limited (429) — raise --pace / POLYGON_PACE_MS");
  if (!r.ok) throw new Error("HTTP " + r.status);
  return parsePolygonFinancials(await r.json());
}

function parseArgs(argv){
  const a = { preview:false, dryRun:false, tickersFile:null,
              pace: +(process.env.POLYGON_PACE_MS || 13000) }; // 5 req/min free tier
  for (let i = 2; i < argv.length; i++){ const x = argv[i];
    if (x === "--preview") a.preview = true;
    else if (x === "--dry-run") a.dryRun = true;
    else if (x === "--tickers") a.tickersFile = argv[++i];
    else if (x === "--pace") a.pace = +argv[++i];
  }
  return a;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pct = v => v != null ? (v*100 >= 0 ? "+" : "") + (v*100).toFixed(2) + "%" : "—";

async function main(){
  const args = parseArgs(process.argv);
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if (!key){ console.error("Set POLYGON_API_KEY (the REST key) — contenders needs a live price + filing record."); process.exit(2); }

  const funda = readJSON(path.join(ROOT, "fundamentals.json"));
  if (!funda || typeof funda !== "object"){ console.error("fundamentals.json missing — run build-fundamentals first."); process.exit(2); }
  const patternMap = indexUniverse(readJSON(path.join(ROOT, "pattern-study.json")));
  const signalMap  = indexUniverse(readJSON(path.join(ROOT, "signal-study.json"))); // optional

  const syms = readTickers(args.tickersFile).filter(s => funda[s]); // only names we can grade
  const prices = await fetchSnapshotPrices(syms, key);

  const graded = [];
  for (let i = 0; i < syms.length; i++){
    const sym = syms[i];
    const rec = funda[sym];
    try{
      let price = prices[sym];
      if (!(price > 0)){
        price = await fetchPrevClose(sym, key); // snapshot missed it → prev close
        await sleep(args.pace);
      }
      // Filings are non-fatal: an un-entitled tier still yields the graded list.
      let fin = null;
      try{ fin = await fetchFinancials(sym, key); }
      catch(e){ if (/429/.test(e.message)) console.log("  (financials rate-limited for " + sym + " — skipping its filing box)"); }

      const c = buildContender({ sym, rec, price, patternRow: patternMap[sym], signalRow: signalMap[sym], fin });
      if (!c) continue;
      graded.push(c);
      if (c.grade === "A" || c.grade === "B"){
        console.log("✓ " + sym.padEnd(6) + " " + c.grade + " total " + String(c.total).padStart(3) +
          (c.allBoxes ? "  ★ ALL BOXES" : "            ") +
          "  edge " + pct(c.tech.patternEdge) + "  filed " + (c.filing && c.filing.date || "—"));
      } else if (c.grade === "C"){
        const tags = classifyWatch(c);
        console.log("◦ " + sym.padEnd(6) + " C total " + String(c.total).padStart(3) +
          (tags.length ? "  💎 " + tags.join("/") : "") + "  edge " + pct(c.tech.patternEdge));
      } else if (args.preview){
        console.log("· " + sym.padEnd(6) + " " + c.grade + " total " + c.total + " (below watch tier)");
      }
    }catch(e){
      console.log("✗ " + sym.padEnd(6) + " " + e.message);
    }
    if (i < syms.length - 1) await sleep(args.pace); // stay under Polygon's rate limit
  }

  const ranked = rankContenders(graded);
  const watch = rankWatchlist(graded);
  const allBoxesN = ranked.filter(c => c.allBoxes).length;
  const out = {
    generatedAt: new Date().toISOString(),
    priceSrc: "Polygon snapshot (live last/close)",
    criteria: {
      grade: "A or B — valueScore over SEC fundamentals at the live price",
      technical: "pattern-study convergence-breakout edge > 0 (or trend profit-factor ≥ 1 when signal-study is present)",
      filing: "SEC & Polygon agree on the latest reporting period (within ~one quarter)",
      allBoxes: "grade A/B AND a positive technical edge AND the filing cross-check passes",
      watch: "grade C kept as a watch-later tier; tags flag the upside angle (borderline / techEdge / deepValue / highGrowth)",
    },
    counts: { universe: syms.length, aOrB: ranked.length, allBoxes: allBoxesN, watch: watch.length },
    contenders: ranked,
    watchlist: watch,
  };

  if (args.preview || args.dryRun){
    console.log("\nA/B contenders: " + ranked.length + " · all boxes checked: " + allBoxesN + " · watch-later (C): " + watch.length);
    return;
  }
  // Never clobber a good list with an empty one (bad key, outage, or stale inputs).
  if (ranked.length === 0 && watch.length === 0){ console.error("No A/B or watch-tier name produced — refusing to overwrite contenders.json."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, "contenders.json"), JSON.stringify(out) + "\n");
  console.log("\nWrote contenders.json — " + ranked.length + " A/B names (" + allBoxesN + " all boxes), " + watch.length + " watch-later (C).");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
