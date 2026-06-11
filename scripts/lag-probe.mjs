// Data-lag probe — measures how FRESH Polygon's feed actually is versus wall-clock,
// per symbol, and records it in lag-report.json so git history becomes the lag
// track record over time. Staleness is only meaningful while the US market is OPEN,
// so the CI cron runs DURING session hours (see .github/workflows/lag-probe.yml).
//
// Why this exists: the app used a free feed with no tick timestamp, so it could
// show stale data as "live" with no signal of it. Polygon snapshots carry a
// last-trade timestamp, so `now − lastTs` is the real lag. We classify it into
// freshness bands and, when a Twelve Data key is present, also sample the old free
// feed to record how much the migration gained.
//
// Usage:
//   node scripts/lag-probe.mjs                 # probe universe + indices, write report
//   node scripts/lag-probe.mjs --preview       # print the freshness table, no writes
//   node scripts/lag-probe.mjs --preview --ticker AAPL
//   node scripts/lag-probe.mjs --fixture fx.json --preview   # offline (no network)
//
// Needs POLYGON_API_KEY (the REST key — NOT the Flat-Files S3 secret). Optional
// TWELVE_DATA_KEY adds a free-vs-Polygon lag delta. Non-fatal by design in CI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const REPORT_PATH = path.join(ROOT, "lag-report.json");

// True index tickers (Polygon prefixes indices with "I:") — the Outlook's real
// inputs, replacing the DIA/SPY/QQQ ETF proxies.
export const INDICES = [["I:DJI", "Dow"], ["I:SPX", "S&P 500"], ["I:NDX", "Nasdaq 100"]];
const POLY = "https://api.polygon.io";
const HISTORY_CAP = 200;

// ─── Freshness bands (pure) ─────────────────────────────────────────────────
// REALTIME  : within a minute of a live tick (paid real-time feed).
// DELAYED   : 1–20 min behind — where a 15-min-delayed free/Starter feed lands.
// STALE     : >20 min behind while the market is open — something is wrong/lagging.
// CLOSED    : market shut; the last print is from a prior session by definition.
export const REALTIME_MAX_SEC = 60;
export const DELAYED_MAX_SEC = 20 * 60;
export function classifyFreshness({ stalenessSec, isOpen }) {
  if (!isOpen) return "CLOSED";
  if (stalenessSec == null || !isFinite(stalenessSec)) return "UNKNOWN";
  if (stalenessSec < REALTIME_MAX_SEC) return "REALTIME";
  if (stalenessSec < DELAYED_MAX_SEC) return "DELAYED";
  return "STALE";
}

// Polygon timestamps come in NANOSECONDS (~1e18); tolerate ms (~1e12) too.
export function tsToMs(t) {
  if (t == null) return null;
  const n = Number(t);
  if (!isFinite(n) || n <= 0) return null;
  return n > 1e14 ? Math.round(n / 1e6) : n;
}

// Normalize one /v3/snapshot/indices result into a sample.
export function parseIndexResult(r, nowMs = Date.now()) {
  const lastMs = tsToMs(r.last_updated);
  const isOpen = r.market_status === "open" || r.market_status === "regular_trading";
  const stalenessSec = lastMs != null ? Math.max(0, (nowMs - lastMs) / 1000) : null;
  return {
    symbol: r.ticker,
    venue: "INDEX",
    isMarketOpen: isOpen,
    lastTs: lastMs,
    stalenessSec,
    freshnessBand: classifyFreshness({ stalenessSec, isOpen }),
    value: r.value ?? r.session?.close ?? null,
    pct: r.session?.change_percent ?? null,
  };
}

// Normalize a /v2/snapshot stock ticker object. `marketOpen` comes from
// /v1/marketstatus/now (stock snapshots don't carry a per-symbol status).
export function parseStockTicker(t, marketOpen, nowMs = Date.now()) {
  const lastMs = tsToMs(t.lastTrade?.t ?? t.updated ?? t.min?.t);
  const stalenessSec = lastMs != null ? Math.max(0, (nowMs - lastMs) / 1000) : null;
  return {
    symbol: t.ticker,
    venue: "STOCK",
    isMarketOpen: !!marketOpen,
    lastTs: lastMs,
    stalenessSec,
    freshnessBand: classifyFreshness({ stalenessSec, isOpen: !!marketOpen }),
    value: t.lastTrade?.p ?? t.day?.c ?? null,
    pct: t.todaysChangePerc ?? null,
  };
}

// ─── Aggregation (pure) ─────────────────────────────────────────────────────
export function percentile(xs, p) {
  const a = xs.filter(x => x != null && isFinite(x)).sort((m, n) => m - n);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, Math.ceil(p / 100 * a.length) - 1));
  return +a[idx].toFixed(1);
}
export function aggregate(samples, probedAt = new Date().toISOString()) {
  const open = samples.filter(s => s.isMarketOpen);
  const pool = open.length ? open : samples;
  const st = pool.map(s => s.stalenessSec).filter(x => x != null);
  const band = b => samples.filter(s => s.freshnessBand === b).length;
  const n = samples.length || 1;
  return {
    probedAt,
    marketOpen: open.length > 0,
    nSymbols: samples.length,
    medianStalenessSec: percentile(st, 50),
    p90StalenessSec: percentile(st, 90),
    pctRealtime: +(band("REALTIME") / n * 100).toFixed(1),
    pctDelayed: +(band("DELAYED") / n * 100).toFixed(1),
    pctStale: +(band("STALE") / n * 100).toFixed(1),
    planInferred: inferPlan(samples),
  };
}
// Infer the plan tier from the freshest open-market sample we saw.
export function inferPlan(samples) {
  const open = samples.filter(s => s.isMarketOpen && s.stalenessSec != null);
  if (!open.length) return "unknown (market closed)";
  const best = Math.min(...open.map(s => s.stalenessSec));
  if (best < REALTIME_MAX_SEC) return "real-time (Developer+)";
  if (best < DELAYED_MAX_SEC) return "delayed ~15min (Free/Starter)";
  return "stale/unknown";
}

// Append this run to history (idempotent on probedAt), keep the last cap runs.
export function mergeReport(prev, runAgg, samples, cap = HISTORY_CAP) {
  const history = [...(prev?.history || [])];
  const last = history[history.length - 1];
  if (last && last.probedAt === runAgg.probedAt) history[history.length - 1] = runAgg;
  else history.push(runAgg);
  return { latest: { runAgg, samples }, history: history.slice(-cap) };
}

// Build samples from a saved fixture { nowMs?, marketStatus?, indices?, stocks? }.
export function samplesFromFixture(fx, nowMs = fx?.nowMs ?? Date.now()) {
  const out = [];
  const ms = fx?.marketStatus?.market;
  const marketOpen = ms === "open" || ms === "extended-hours";
  if (fx?.indices?.results) out.push(...fx.indices.results.map(r => parseIndexResult(r, nowMs)));
  if (fx?.stocks) for (const k of Object.keys(fx.stocks)) {
    const t = fx.stocks[k]?.ticker || fx.stocks[k];
    out.push(parseStockTicker(t, marketOpen, nowMs));
  }
  return out;
}

// ─── Network (live only) ────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
async function getJSON(url) { const r = await fetch(url); return r.json(); }

async function fetchMarketOpen(key) {
  try {
    const j = await getJSON(`${POLY}/v1/marketstatus/now?apiKey=${encodeURIComponent(key)}`);
    return j.market === "open" || j.market === "extended-hours";
  } catch { return false; }
}
async function fetchIndices(key) {
  const tickers = INDICES.map(i => i[0]).join(",");
  const j = await getJSON(`${POLY}/v3/snapshot/indices?ticker.any_of=${encodeURIComponent(tickers)}&apiKey=${encodeURIComponent(key)}`);
  if (j.status === "ERROR" || j.error) throw new Error(j.error || j.message || "indices snapshot error");
  return (j.results || []).map(r => parseIndexResult(r));
}
async function fetchStock(sym, key, marketOpen) {
  const j = await getJSON(`${POLY}/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(sym)}?apiKey=${encodeURIComponent(key)}`);
  if (j.status === "ERROR" || j.error) throw new Error(j.error || j.message || "stock snapshot error");
  if (!j.ticker) throw new Error('no snapshot for "' + sym + '"');
  return parseStockTicker(j.ticker, marketOpen);
}
// Optional free-vs-Polygon delta: Twelve Data /quote carries a `timestamp` (sec).
async function augmentTd(sample, tdKey, nowMs = Date.now()) {
  if (!tdKey || sample.venue !== "STOCK") return sample;
  try {
    const j = await getJSON("https://api.twelvedata.com/quote?symbol=" + encodeURIComponent(sample.symbol) + "&apikey=" + encodeURIComponent(tdKey));
    const tdMs = j.timestamp ? Number(j.timestamp) * 1000 : null;
    const tdPct = j.percent_change != null ? Number(j.percent_change) : null;
    return {
      ...sample,
      tdLastTs: tdMs,
      tdStalenessSec: tdMs != null ? Math.max(0, (nowMs - tdMs) / 1000) : null,
      tdVsPolygonDeltaPct: (tdPct != null && sample.pct != null) ? +(sample.pct - tdPct).toFixed(4) : null,
    };
  } catch { return sample; }
}

// ─── Formatting ─────────────────────────────────────────────────────────────
function fmtSec(s) { return s == null ? "n/a" : s < 90 ? Math.round(s) + "s" : (s / 60).toFixed(1) + "m"; }
function fmtSample(s) {
  const pct = s.pct != null ? (s.pct >= 0 ? "+" : "") + s.pct + "%" : "";
  return `${String(s.symbol).padEnd(7)} ${String(s.freshnessBand).padEnd(8)} lag ${fmtSec(s.stalenessSec).padStart(6)}  ${pct}`;
}

// ─── CLI ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { preview: false, dryRun: false, ticker: null, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--preview") o.preview = true;
    else if (x === "--dry-run") o.dryRun = true;
    else if (x === "--ticker") o.ticker = (argv[++i] || "").toUpperCase();
    else if (x === "--fixture") o.fixture = argv[++i];
  }
  return o;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const writes = !(args.preview || args.dryRun);
  const fixture = args.fixture ? readJSON(path.resolve(args.fixture)) : null;
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  const tdKey = process.env.TWELVE_DATA_KEY || process.env.TD_API_KEY || "";
  if (!fixture && !key) { console.error("Set POLYGON_API_KEY (REST key), or pass --fixture for offline."); process.exit(2); }

  const probedAt = new Date().toISOString();
  let samples = [];

  if (fixture) {
    const nowMs = fixture.nowMs ?? (Date.parse(fixture.probedAt || "") || Date.now());
    samples = samplesFromFixture(fixture, nowMs);
    if (args.ticker) samples = samples.filter(s => s.symbol === args.ticker || s.symbol === "I:" + args.ticker);
  } else {
    const marketOpen = await fetchMarketOpen(key);
    try { samples.push(...await fetchIndices(key)); }
    catch (e) { if (args.preview) console.warn("✗ indices — " + (e.message || e)); }
    const tickers = args.ticker ? [args.ticker] : readTickers();
    for (const sym of tickers) {
      try {
        let s = await fetchStock(sym, key, marketOpen);
        s = await augmentTd(s, tdKey);
        samples.push(s);
      } catch (e) { if (args.preview) console.warn("✗ " + sym + " — " + (e.message || e)); }
      await sleep(250); // pace the API
    }
  }

  const runAgg = aggregate(samples, probedAt);

  if (!writes) {
    console.log("── DATA-LAG PROBE (no writes) ──────────────────────────────");
    for (const s of samples) console.log("  " + fmtSample(s));
    if (!samples.length) console.log("  (no samples)");
    console.log(`\n${samples.length} symbols · market ${runAgg.marketOpen ? "OPEN" : "closed"} · median lag ${fmtSec(runAgg.medianStalenessSec)} · p90 ${fmtSec(runAgg.p90StalenessSec)} · ${runAgg.pctRealtime}% realtime · plan: ${runAgg.planInferred}`);
    return;
  }

  const prev = readJSON(REPORT_PATH);
  const report = mergeReport(prev, runAgg, samples);
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  console.log(`lag-report.json: ${samples.length} samples · median ${fmtSec(runAgg.medianStalenessSec)} · ${runAgg.pctRealtime}% realtime · ${report.history.length} runs in history.`);
}

// Run only when invoked directly (so tests can import the pure helpers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
