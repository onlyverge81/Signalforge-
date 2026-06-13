// Automated forward-test logger — runs the SignalForge engine headless and
// records its LIVE decisions as paper trades in paper-ledger.json. Run nightly
// in CI (after US close) so it logs SETTLED end-of-day bars, then marks open
// trades to market with the SAME exit math as the backtest. This is the honest,
// out-of-sample track record the in-sample backtest can't be: no human clicking,
// no cherry-picking, git history = the timestamped, tamper-evident log.
//
// Usage:
//   node scripts/forward-log.mjs                      # log the whole universe, write ledger
//   node scripts/forward-log.mjs --preview            # print what it WOULD log, no writes
//   node scripts/forward-log.mjs --preview --ticker AAPL
//   node scripts/forward-log.mjs --fixture fx.json --preview   # offline (no network), from a saved feed
//
// The forward-test configuration is fixed and documented so the record is
// comparable over time. It logs the LIVE TRADING POLICY: long-only (shorts are a
// measured, significant money-loser in this universe) on daily bars with a wide
// ATR×3 stop / ATR×4 target (the only backtested config with profit factor > 1 —
// the tight ATR×1.5 stop whipsawed), typical-retail costs. A position is opened
// only for a tradeable long (see forwardGates); shorts, thin or proven-losing
// setups are recorded as no-position observations.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, runBacktest, scoreAt, auditData, checkBarExit, tradeNet, valueScore, edgeStatus } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonDaily, fetchPolygonDividends, dividendsInWindow } from "./pattern-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "paper-ledger.json");

// ─── Fixed forward-test configuration (mirrors the app's defaults) ───────────
export const CFG = {
  interval: "1day",
  market: "Stocks",
  strategy: "Trend Following (long-only, wide-stop)",
  slMult: 3.0,                              // ATR×3 — give the trade room (tight stops whipsawed)
  tpMult: 4.0,                              // ATR×4 — keeps the original ~1.33:1 reward:risk geometry
  longOnly: true,                           // shorts are a significant measured loser — don't take them
  costs: { slip: 0.05, comm: 0.01 },        // "Typical retail"
  provider: "Polygon",
  source: "Polygon EOD (CI, adjusted)",
  entryFill: "close@settled",
};
const costPerTrade = (CFG.costs.slip + CFG.costs.comm) * 2;
// Stocks Starter has UNLIMITED API calls, so no inter-ticker throttle by default
// (override POLYGON_PACE_MS if running on a rate-limited tier).
const PACE = +(process.env.POLYGON_PACE_MS || 0);

// ─── Candle provenance: separate SETTLED bars from a trailing FORMING bar ────
// A daily bar dated "today" is still forming until the US session settles. Treat
// the trailing bar as forming only if it's dated today (UTC) and we're before
// ~21:00 UTC (after 16:00 ET close + buffer the print is final). The nightly cron
// runs later, so the day's settled close IS logged; an intraday preview drops it.
export function splitSettled(candles, now = new Date()) {
  if (!candles.length) return { settled: [], formingBar: null };
  const today = now.toISOString().slice(0, 10);
  const hourUTC = now.getUTCHours();
  const last = candles[candles.length - 1];
  const forming = last && String(last.date).slice(0, 10) === today && hourUTC < 21;
  return forming
    ? { settled: candles.slice(0, -1), formingBar: last }
    : { settled: candles, formingBar: null };
}

// ─── fundamentalGrade tag from fundamentals.json (price-derived, like the app) ─
export function gradeFor(sym, price, fundaDB) {
  if (!fundaDB) return null;
  const rec = fundaDB[sym];
  if (!rec) return null;
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
  const vs = valueScore(map);
  return vs ? vs.grade : null;
}

// ─── Pure trading-policy gates for the forward record (testable, no network) ──
// Decide whether a signal opens a paper position and why it is/ isn't muted:
//   longOnlyMuted — a SELL under the long-only policy (shorts lose; never taken)
//   costMuted     — the target can't clear 2× round-trip cost (edge too thin to pay for)
//   edgeMuted     — the instrument's backtested edge is unproven OR a proven loser
//                   (edgeStatus encodes the t-stat's SIGN — a SIGNIFICANT *negative*
//                   edge is a money-loser, not a green light)
//   dataSuspect   — the inputs failed the audit
// A position OPENs only for a tradeable long: a permitted BUY with clean inputs,
// a target that clears costs, and a backtest that is not a PROVEN loser. An
// unproven-but-not-negative edge still opens (logged, flagged) so the honest
// out-of-sample record keeps building; everything else is a no-position observation.
export function forwardGates({ signal, entry, tp1, stats, suspect, costPerTrade, longOnly }) {
  const es = edgeStatus(stats);
  const expMovePct    = (entry > 0 && tp1 != null) ? Math.abs(tp1 - entry) / entry * 100 : 0;
  const costMuted     = expMovePct < 2 * (costPerTrade || 0);
  const longOnlyMuted = !!longOnly && signal === "SELL";
  const edgeMuted     = es.muted;
  const dataSuspect   = !!suspect;
  const signalMuted   = edgeMuted || dataSuspect || costMuted || longOnlyMuted;
  const actionable    = signal === "BUY" && !longOnlyMuted && !dataSuspect && !costMuted && !es.negativeEdge;
  return {
    actionable,
    tags: {
      signalMuted, edgeMuted, dataSuspect, costMuted, longOnlyMuted,
      edgeVerdict: es.verdict, negativeEdge: es.negativeEdge,
    },
  };
}

// ─── Build the ledger entry for the latest settled bar ───────────────────────
// A tradeable long → OPEN position; HOLD, a long-only-blocked short, or a thin /
// proven-losing setup → OBSERVATION (no position, no P&L). Every row carries its
// gate tags so realized stats can later be segmented by them.
export function buildEntry({ sym, settled, fundaDB, loggedAt = new Date().toISOString() }) {
  if (settled.length < 30) return null; // not enough history for a trustworthy signal
  const a = analyze(settled, sym, CFG.market, CFG.strategy, CFG.slMult, CFG.tpMult);
  const bt = settled.length >= 40
    ? runBacktest(settled, scoreAt, CFG.slMult, CFG.tpMult, CFG.costs, null, false)
    : null;
  const audit = auditData(settled);
  const gate = forwardGates({
    signal: a.signal, entry: a.entry, tp1: a.tp1,
    stats: bt?.stats, suspect: audit.suspect, costPerTrade, longOnly: CFG.longOnly,
  });
  const decision = settled[settled.length - 1];
  const grade = gradeFor(sym, decision.close, fundaDB);

  const isObs = !gate.actionable;
  const id = `${sym}-${CFG.interval}-${decision.date}-${a.signal}`;
  return {
    id,
    loggedAt,
    ticker: sym,
    market: CFG.market,
    interval: CFG.interval,
    source: CFG.source,
    entryFill: CFG.entryFill,
    signal: a.signal,
    confidence: a.confidence,
    trend: a.trend,
    strength: a.strength,
    entry: a.entry, sl: a.sl, tp1: a.tp1, tp2: a.tp2, rr: a.rr,
    support: a.support, resistance: a.resistance,
    dataAsOf: { date: decision.date, close: decision.close, provider: CFG.provider },
    barState: "closed",
    tags: { ...gate.tags, fundamentalGrade: grade, meritsActivated: false },
    status: isObs ? "OBSERVATION" : "OPEN",
    exit: null, exitAt: null, exitDate: null, barsHeld: null,
    pnl: null, grossPct: null, pnlPct: null, benchClose: null, benchDiv: null,
  };
}

// ─── Mark an OPEN entry to market against newly-settled bars (no lookahead) ───
// Walks only bars dated STRICTLY AFTER the entry bar; closes on the first SL/TP
// touch via the shared checkBarExit (SL-first tie) and tradeNet (round-trip cost).
// Returns a NEW entry object (does not mutate); unchanged when still open.
export function markToMarket(entry, settled, exitAt = new Date().toISOString(), dividends = []) {
  if (entry.status !== "OPEN") return entry;
  const dir = entry.signal === "BUY" ? "BUY" : "SELL";
  const t = { dir, entry: entry.entry, sl: entry.sl, tp: entry.tp1 };
  const after = settled.filter(c => String(c.date) > String(entry.dataAsOf.date));
  for (let i = 0; i < after.length; i++) {
    const ex = checkBarExit(t, after[i]);
    if (ex) {
      const net = tradeNet(dir, entry.entry, ex.exit, costPerTrade);
      return {
        ...entry,
        status: ex.result,
        exit: parseFloat(ex.exit.toFixed(4)),
        exitDate: after[i].date,
        exitAt,
        barsHeld: i + 1,
        pnl: parseFloat(net.pnl.toFixed(4)),
        grossPct: parseFloat(net.grossPct.toFixed(4)),
        pnlPct: net.pnlPct,
        // Buy-&-hold benchmark reference: the underlying's CLOSE on the exit bar.
        // Same name, same entry, same matched window — but held passively to the
        // close instead of exiting at the SL/TP touch. forward-perf measures the
        // strategy's return against this to isolate alpha (skill) from beta (just
        // being long the tape). null on open/observation rows where no window exists.
        benchClose: parseFloat(after[i].close.toFixed(4)),
        // Cash dividends the benchmark holder collects over the same window — makes the
        // hold a TOTAL-return benchmark (Polygon adjusts splits, not dividends).
        benchDiv: dividendsInWindow(dividends, entry.dataAsOf.date, after[i].date),
      };
    }
  }
  return entry; // still open
}

// ─── Merge ledgers by id: keep the more-advanced status, latest timestamps ────
const RANK = { OBSERVATION: 0, OPEN: 1, WIN: 2, LOSS: 2, CLOSED: 2 };
export function mergeLedger(existing, incoming) {
  const byId = new Map();
  for (const e of existing || []) byId.set(e.id, e);
  for (const e of incoming || []) {
    const prev = byId.get(e.id);
    if (!prev) { byId.set(e.id, e); continue; }
    // Prefer the entry that has progressed further (open→closed); break ties by recency.
    const adv = (RANK[e.status] ?? 0) - (RANK[prev.status] ?? 0);
    if (adv > 0 || (adv === 0 && String(e.exitAt || e.loggedAt) >= String(prev.exitAt || prev.loggedAt))) {
      byId.set(e.id, e);
    }
  }
  return [...byId.values()].sort((a, b) => String(a.loggedAt).localeCompare(String(b.loggedAt)));
}

// ─── Polygon daily feed → candle array (same vendor + adjustment as the app) ──
// The live app fetches adjusted Polygon daily bars; mirroring that here keeps the
// forward-test verdict identical to what a user sees. parseFeed() stays for the
// --fixture path (offline tests still use a saved Twelve-Data-shaped feed).
async function fetchDaily(sym, key) {
  return fetchPolygonDaily(sym, key);
}
export function parseFeed(j, sym) {
  if (j.status === "error" || j.code) throw new Error((j.message || "feed error") + " (" + sym + ")");
  if (!j.values || !j.values.length) throw new Error('no data for "' + sym + '"');
  return j.values.slice().reverse().map(v => ({
    date: v.datetime,
    open: +parseFloat(v.open || v.close).toFixed(4),
    high: +parseFloat(v.high || v.close).toFixed(4),
    low: +parseFloat(v.low || v.close).toFixed(4),
    close: +parseFloat(v.close).toFixed(4),
    volume: parseFloat(v.volume) || 0,
  })).filter(d => d.close > 0);
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function summarize(entry) {
  const tg = entry.tags;
  const muted = tg.signalMuted ? "MUTED" : "actionable";
  const flags = [tg.dataSuspect ? "data-suspect" : null, "edge:" + tg.edgeVerdict, tg.fundamentalGrade ? "grade " + tg.fundamentalGrade : null].filter(Boolean).join(", ");
  return `${entry.ticker.padEnd(6)} ${entry.signal.padEnd(4)} @ ${entry.entry}  SL ${entry.sl} / TP1 ${entry.tp1} (RR ${entry.rr})  [${muted}; ${flags}]  asOf ${entry.dataAsOf.date}`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────
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
  const fundaDB = readJSON(path.join(ROOT, "fundamentals.json"));
  const fixture = args.fixture ? readJSON(path.resolve(args.fixture)) : null;
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if (!fixture && !key) { console.error("Set POLYGON_API_KEY (or pass --fixture for offline)."); process.exit(2); }

  let tickers = args.ticker ? [args.ticker] : readTickers();
  if (fixture && !args.ticker) tickers = Object.keys(fixture);

  const ledger = (writes ? readJSON(LEDGER_PATH) : readJSON(LEDGER_PATH)) || [];
  const fresh = [];
  const previews = [];
  let logged = 0, closed = 0, skipped = 0;

  for (const sym of tickers) {
    try {
      const feed = fixture ? (fixture[sym] || fixture) : null;
      const candles = feed ? parseFeed(feed, sym) : await fetchDaily(sym, key);
      const { settled } = splitSettled(candles);
      if (settled.length < 30) { skipped++; continue; }

      // 1) Mark existing OPEN trades for this ticker to market on the new settled bars.
      //    Fetch the name's cash dividends once (only when something is open) so the
      //    benchmark is total-return, not price-only. Best-effort: [] on any failure.
      const hasOpen = ledger.some(e => e.ticker === sym && e.interval === CFG.interval && e.status === "OPEN");
      let divs = [];
      if (hasOpen && !fixture && key) { try { divs = await fetchPolygonDividends(sym, key); } catch { divs = []; } }
      for (const e of ledger) {
        if (e.ticker === sym && e.interval === CFG.interval && e.status === "OPEN") {
          const upd = markToMarket(e, settled, undefined, divs);
          if (upd.status !== "OPEN") { fresh.push(upd); closed++; }
        }
      }
      // 2) Build today's entry.
      const entry = buildEntry({ sym, settled, fundaDB });
      if (entry) {
        const dup = ledger.some(e => e.id === entry.id) || fresh.some(e => e.id === entry.id);
        if (!dup) { fresh.push(entry); previews.push(entry); logged++; }
      }
      if (!fixture && PACE) await sleep(PACE); // throttle only if a rate-limited tier is set
    } catch (e) {
      skipped++;
      if (args.preview) console.warn("✗ " + sym + " — " + (e.message || e));
    }
  }

  if (args.preview) {
    console.log("── FORWARD-TEST PREVIEW (no writes) ─────────────────────────");
    for (const e of previews) console.log("  " + summarize(e));
    if (!previews.length) console.log("  (no new entries)");
    console.log(`\nWould log ${logged} new, close ${closed}, skip ${skipped}. Config: ${CFG.strategy}, ${CFG.interval}, SL×${CFG.slMult}/TP×${CFG.tpMult}, costs ${(costPerTrade).toFixed(2)}%/trade.`);
    if (args.ticker && previews[0]) console.log("\nRaw entry:\n" + JSON.stringify(previews[0], null, 2));
    return;
  }

  const merged = mergeLedger(ledger, fresh);
  if (writes) {
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(merged, null, 2) + "\n");
    console.log(`paper-ledger.json: +${logged} logged, ${closed} closed, ${skipped} skipped → ${merged.length} total.`);
  }
}

// Run only when invoked directly (so tests can import the pure helpers).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
