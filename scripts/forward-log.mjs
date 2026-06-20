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
import { analyze, runBacktest, scoreAt, scorePosition, auditData, checkBarExit, tradeNet, valueScore, edgeStatus } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonDaily, fetchPolygonDividends, dividendsInWindow, fetchPolygonNews, newsWindow } from "./pattern-study.mjs";

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

// ─── POSITION forward stream (PR2) ───────────────────────────────────────────
// The app's POSITION philosophy (patient long-trend: buy dips in a real 200-bar uptrend,
// wide ATR trailing stop, hold for big moves) was never validated out-of-sample — the
// tactical scorer above is all the ledger tracked. POS_CFG logs scorePosition as its OWN
// ledger stream (tag mode:"position", distinct …-POS-… ids) so forward-perf scores it as a
// separate variant under the same FDR gate. Nothing auto-activates.
export const POS_CFG = {
  interval: CFG.interval, market: CFG.market, strategy: "Position (long-trend, ATR trailing)",
  slMult: 3.0, trailMult: 3.0, longOnly: true,
  costs: CFG.costs, provider: CFG.provider, source: CFG.source, entryFill: CFG.entryFill,
};
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

// ─── Merit overlay tag (propose-only) ─────────────────────────────────────────
// Does this name's point-in-time fundamental grade clear the merit bar? This is a LABEL,
// not a gate: it never enters forwardGates / actionable, so it does NOT change which trades
// open. It simply marks the opened-longs subset the merit overlay would favour, so the
// "merits-on" vs "merits-off" buckets in forward-perf become a clean A/B inside the SAME
// population — and the existing FDR promotion gate decides, out-of-sample, whether
// conditioning on merit actually adds alpha. Pure. Higher grade = better (A best).
const GRADE_RANK = { A: 4, B: 3, C: 2, D: 1, F: 0 };
export function meritGate(grade, { minGrade = "B" } = {}) {
  const g = GRADE_RANK[grade], m = GRADE_RANK[minGrade];
  return g != null && m != null && g >= m;
}

// ─── Cross-sectional MOMENTUM overlay (propose-only) ──────────────────────────
// The momentum.json study judges this factor with monthly bars; here, on the live DAILY
// feed, momentumValue computes the same 12-1 idea: trailing ~12-month return SKIPPING the
// most recent ~1 month (dodges short-term reversal). Same factor, daily approximation.
// momentumRankGate then ranks the run's universe and flags the TOP TERTILE — the genuinely
// cross-sectional step (SignalForge has only ever scored names in isolation). Like meritGate,
// momentumActivated is a LABEL: it never enters forwardGates / actionable, so it does not
// change which trades open — it only carves the opened-longs into an A/B the FDR gate judges.
const MOM_LOOKBACK = 252, MOM_SKIP = 21;       // ≈ 12 months and ≈ 1 month in trading days
export function momentumValue(candles, { lookback = MOM_LOOKBACK, skip = MOM_SKIP } = {}) {
  const c = candles || [];
  if (c.length <= lookback) return null;       // not enough history for a 12-month lookback
  const last = c.length - 1;
  const cSig = c[last - skip] && c[last - skip].close;
  const cBack = c[last - lookback] && c[last - lookback].close;
  if (!(cSig > 0) || !(cBack > 0)) return null;
  return cSig / cBack - 1;
}
// Pure: given this run's per-name momentum values (nulls allowed), return a boolean[] aligned
// to the input flagging the top `topFrac` by momentum. Conservative — fewer than 3 rankable
// names ⇒ no activation (a cross-section that small can't be ranked honestly).
export function momentumRankGate(values, { topFrac = 1 / 3 } = {}) {
  const flags = (values || []).map(() => false);
  const idx = (values || []).map((v, i) => [v, i]).filter(([v]) => v != null && isFinite(v));
  if (idx.length < 3) return flags;
  idx.sort((a, b) => b[0] - a[0]);             // highest momentum first
  const k = Math.max(1, Math.floor(idx.length * topFrac));
  for (let i = 0; i < k; i++) flags[idx[i][1]] = true;
  return flags;
}

// ─── Liquidity overlay (propose-only) — gate momentum to TRADEABLE names ──────
// The factor-interaction robustness probe (angle A) found momentum-12-1 is the ONE factor whose edge
// SURVIVES a liquidity screen (~80% retained on liquid names), while lowvol/quality were largely
// stale-price micro-cap artifacts. liquidAtBar marks whether the DECISION bar clears a price floor and
// a trailing-median dollar-volume floor, so a momentum-on-LIQUID variant can be judged OOS. Pure,
// point-in-time (reads only bars up to the decision bar). A LABEL only — never enters the gate.
const LIQ_MIN_ADV = 2_000_000, LIQ_MIN_PRICE = 5, LIQ_WIN = 60;
export function liquidAtBar(candles, { minADV = LIQ_MIN_ADV, minPrice = LIQ_MIN_PRICE, win = LIQ_WIN } = {}) {
  const c = candles || [];
  if (!c.length) return false;
  const last = c[c.length - 1];
  if (!(last && last.close >= minPrice)) return false;
  const lo = Math.max(0, c.length - win);
  const dv = [];
  for (let i = lo; i < c.length; i++) { const b = c[i]; if (b && b.close > 0 && b.volume > 0) dv.push(b.close * b.volume); }
  if (!dv.length) return false;
  dv.sort((a, b) => a - b);
  const m = dv.length >> 1;
  const med = dv.length % 2 ? dv[m] : (dv[m - 1] + dv[m]) / 2;
  return med >= minADV;
}

// ─── Cross-sectional SHORT-TERM REVERSAL overlay (propose-only) ───────────────
// The reversal.json study judges this factor with monthly bars; here, on the live DAILY feed,
// reversalValue computes the same 1-month idea: the NEGATED trailing ~1-month return, so a
// recent LOSER scores HIGH. It's the orthogonal complement to momentum (which deliberately
// SKIPS the most recent month). reversalRankGate flags the TOP TERTILE by reversal score — the
// biggest recent losers, the names a reversal bet would favour. Like momentum, reversalActivated
// is a LABEL: it never enters forwardGates / actionable, so it never changes which trades open.
const REV_LOOKBACK = 21;                        // ≈ 1 month in trading days
export function reversalValue(candles, { lookback = REV_LOOKBACK } = {}) {
  const c = candles || [];
  if (c.length <= lookback) return null;        // not enough history for a 1-month window
  const last = c.length - 1;
  const cNow = c[last] && c[last].close;
  const cBack = c[last - lookback] && c[last - lookback].close;
  if (!(cNow > 0) || !(cBack > 0)) return null;
  return -(cNow / cBack - 1);                   // negated 1-month return: loser ⇒ high score
}
// Pure: flag the top `topFrac` by reversal score (biggest recent losers). Same conservative
// rule as momentumRankGate — fewer than 3 rankable names ⇒ no activation. Distinct function so
// the two overlays can diverge later without entangling.
export function reversalRankGate(values, { topFrac = 1 / 3 } = {}) {
  const flags = (values || []).map(() => false);
  const idx = (values || []).map((v, i) => [v, i]).filter(([v]) => v != null && isFinite(v));
  if (idx.length < 3) return flags;
  idx.sort((a, b) => b[0] - a[0]);             // highest reversal score (biggest loser) first
  const k = Math.max(1, Math.floor(idx.length * topFrac));
  for (let i = 0; i < k; i++) flags[idx[i][1]] = true;
  return flags;
}

// ─── Cross-sectional LOW-VOLATILITY overlay (propose-only) ────────────────────
// The lowvol.json study judges this factor with monthly bars; here, on the live DAILY feed,
// lowVolValue computes the same idea from DAILY returns: the NEGATED realized volatility over a
// trailing ~12-month window, so a CALM name scores HIGH. It's a risk-based factor, orthogonal to
// the price-trend overlays (momentum / reversal). lowVolRankGate flags the TOP TERTILE by low-vol
// score — the calmest names a low-vol bet would favour. Like the others, lowVolActivated is a
// LABEL: it never enters forwardGates / actionable, so it never changes which trades open.
const LV_LOOKBACK = 252;                        // ≈ 12 months of daily returns
export function lowVolValue(candles, { lookback = LV_LOOKBACK } = {}) {
  const c = candles || [];
  if (c.length <= lookback) return null;        // not enough history for a 12-month vol window
  const rets = [];
  for (let i = c.length - lookback; i < c.length; i++) {
    const a = c[i - 1] && c[i - 1].close, b = c[i] && c[i].close;
    if (!(a > 0) || !(b > 0)) return null;
    rets.push(b / a - 1);
  }
  if (rets.length < 2) return null;
  const mean = rets.reduce((s, v) => s + v, 0) / rets.length;
  const varc = rets.reduce((s, v) => s + (v - mean) * (v - mean), 0) / rets.length;
  return -Math.sqrt(varc);                      // negated realized vol: calm ⇒ high score
}
// Pure: flag the top `topFrac` by low-vol score (calmest names). Same conservative rule as the
// other rank gates — fewer than 3 rankable names ⇒ no activation.
export function lowVolRankGate(values, { topFrac = 1 / 3 } = {}) {
  const flags = (values || []).map(() => false);
  const idx = (values || []).map((v, i) => [v, i]).filter(([v]) => v != null && isFinite(v));
  if (idx.length < 3) return flags;
  idx.sort((a, b) => b[0] - a[0]);             // highest low-vol score (calmest) first
  const k = Math.max(1, Math.floor(idx.length * topFrac));
  for (let i = 0; i < k; i++) flags[idx[i][1]] = true;
  return flags;
}

// ─── Cross-sectional QUALITY (profitability) overlay (propose-only) ───────────
// The quality.json study judges this NON-PRICE factor with point-in-time SEC profitability; here,
// qualityValue reads the same idea straight off the distilled fundamentals record already on
// fundaDB (the ROE the merit grade also uses), so a MORE-PROFITABLE name scores HIGH. It's a
// fundamental factor, distinct from the merit COMPOSITE (which blends valuation + growth too).
// qualityRankGate flags the TOP TERTILE by profitability. Like the others, qualityActivated is a
// LABEL: it never enters forwardGates / actionable, so it never changes which trades open.
export function qualityValue(rec) {
  if (!rec) return null;
  const v = rec.roe;                            // return on equity — the canonical profitability proxy
  return (v == null || !isFinite(v)) ? null : Number(v);
}
// Pure: flag the top `topFrac` by profitability. Same conservative rule as the other rank gates —
// fewer than 3 rankable names ⇒ no activation.
export function qualityRankGate(values, { topFrac = 1 / 3 } = {}) {
  const flags = (values || []).map(() => false);
  const idx = (values || []).map((v, i) => [v, i]).filter(([v]) => v != null && isFinite(v));
  if (idx.length < 3) return flags;
  idx.sort((a, b) => b[0] - a[0]);             // highest profitability first
  const k = Math.max(1, Math.floor(idx.length * topFrac));
  for (let i = 0; i < k; i++) flags[idx[i][1]] = true;
  return flags;
}

// ─── Event overlay (propose-only) — two news hypotheses as A/B LABELS ─────────
// Reads ONLY the already-captured point-in-time `events` summary (newsWindow up to the
// decision bar) — it NEVER re-fetches, so it stays no-lookahead. Like meritGate, these are
// labels: they never enter forwardGates / actionable, so which trades open is unchanged.
// Two independent, opposite hypotheses, each judged on its own under the FDR gate:
//   newsPositive — post-news DRIFT (PEAD-like): fresh positive news flow confirms the long.
//   newsQuiet    — event-risk AVOIDANCE: no fresh NEGATIVE news in the window (count 0 = quiet).
export function eventTags(events){
  const e = events || {};
  return {
    newsPositive: e.count > 0 && e.sentiment === "positive",
    newsQuiet: e.sentiment !== "negative",
  };
}

// Earnings-proximity overlay (propose-only): was the most recent 10-Q/10-K filed within
// `recentDays` before the decision bar? `lastFiled` (the earnings-announcement proxy from SEC
// EDGAR) rides on the fundamentals record, so this needs no Polygon earnings entitlement. A
// just-filed name sits in the post-earnings-announcement-DRIFT window (the PEAD hypothesis on
// hard numbers, complementing the news-sentiment label). Pure; another label, never a gate.
export function earningsGate(fundaRec, decisionDate, { recentDays = 30 } = {}) {
  if (!fundaRec || !fundaRec.lastFiled || !decisionDate) return false;
  const days = (new Date(decisionDate).getTime() - new Date(fundaRec.lastFiled).getTime()) / 864e5;
  return days >= 0 && days <= recentDays;
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
export function buildEntry({ sym, settled, fundaDB, news = [], loggedAt = new Date().toISOString() }) {
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
  const eventsAtSignal = newsWindow(news, decision.date + "T23:59:59Z", 3);

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
    // Event context at signal time: fresh news in the 3 days up to the decision bar (point-in-time).
    events: eventsAtSignal,
    // momentum = raw 12-1 trailing return (per-name); momentumActivated is set CROSS-SECTIONALLY
    // by the run loop after every name's momentum is known (default false until then). The news
    // labels (newsPositive / newsQuiet) ride the captured events — propose-only, never a gate.
    tags: { ...gate.tags, fundamentalGrade: grade, meritsActivated: meritGate(grade),
      momentum: (m => m == null ? null : parseFloat(m.toFixed(4)))(momentumValue(settled)),
      momentumActivated: false,
      reversal: (r => r == null ? null : parseFloat(r.toFixed(4)))(reversalValue(settled)),
      reversalActivated: false,
      lowVol: (v => v == null ? null : parseFloat(v.toFixed(6)))(lowVolValue(settled)),
      lowVolActivated: false,
      liquid: liquidAtBar(settled),
      quality: (q => q == null ? null : parseFloat(q.toFixed(4)))(qualityValue(fundaDB && fundaDB[sym])),
      qualityActivated: false, ...eventTags(eventsAtSignal),
      earningsRecent: earningsGate(fundaDB && fundaDB[sym], decision.date) },
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

// ─── POSITION entry (PR2): scorePosition decision, logged as its own stream ────
// Only logs when the long-term trend filter is genuinely ENGAGED (≥200 bars) — short-history
// names are skipped (null), matching the in-app "not engaged" honesty. An engaged BUY (a dip
// inside a real uptrend) OPENs a position with a wide ATR stop + trailing exit; engaged HOLD or
// a thesis-break SELL is a no-position OBSERVATION. Long-only by construction.
export function buildPositionEntry({ sym, settled, fundaDB, news = [], loggedAt = new Date().toISOString() }) {
  if (settled.length < 200) return null;                 // trend filter can't engage — don't log
  const ps = scorePosition(settled);
  if (!ps || ps.engaged === false) return null;
  const decision = settled[settled.length - 1];
  const grade = gradeFor(sym, decision.close, fundaDB);
  const eventsAtSignal = newsWindow(news, decision.date + "T23:59:59Z", 3);
  const actionable = ps.signal === "BUY" && ps.atr > 0;  // dip-buy only (never shorts)
  const entry = decision.close;
  const sl = actionable ? parseFloat((entry - ps.atr * POS_CFG.slMult).toFixed(4)) : null;
  return {
    id: `${sym}-${POS_CFG.interval}-POS-${decision.date}-${ps.signal}`,
    loggedAt, ticker: sym, market: POS_CFG.market, interval: POS_CFG.interval,
    source: POS_CFG.source, entryFill: POS_CFG.entryFill,
    signal: ps.signal, confidence: null,
    trend: ps.signal === "SELL" ? "DOWNTREND" : "UPTREND", strength: null,
    entry: actionable ? entry : null, sl, tp1: null, tp2: null, rr: null,
    atr: parseFloat((ps.atr).toFixed(4)), highWater: actionable ? entry : null,
    support: null, resistance: null,
    dataAsOf: { date: decision.date, close: decision.close, provider: POS_CFG.provider },
    barState: "closed",
    events: eventsAtSignal,
    tags: { mode: "position", engaged: true, fundamentalGrade: grade,
      trendStrength: parseFloat((ps.trendStrength || 0).toFixed(4)),
      dipDepth: parseFloat((ps.dipDepth || 0).toFixed(4)),
      // Quality (ROE) rides the POSITION (long-hold) stream too: the quality-duration study showed
      // high-ROE names beat the market with an edge that GROWS over months — position trades hold
      // for months (trailing stop), so quality-position is the propose-only "quality × duration"
      // A/B. Set CROSS-SECTIONALLY by the run loop after ranking the position batch; never a gate.
      quality: (q => q == null ? null : parseFloat(q.toFixed(4)))(qualityValue(fundaDB && fundaDB[sym])),
      qualityActivated: false, ...eventTags(eventsAtSignal),
      earningsRecent: earningsGate(fundaDB && fundaDB[sym], decision.date) },
    status: actionable ? "OPEN" : "OBSERVATION",
    exit: null, exitAt: null, exitDate: null, barsHeld: null,
    pnl: null, grossPct: null, pnlPct: null, benchClose: null, benchDiv: null,
  };
}

// ─── Mark a POSITION trade to market: ATR TRAILING stop + thesis-break (no lookahead) ─
// Mirrors runBacktest's hold-mode exit: trail level uses the high-water mark as of PRIOR bars,
// updated only AFTER the per-bar exit check. Returns a NEW object; persists the ratcheted
// high-water while still open.
export function markToMarketPosition(entry, settled, exitAt = new Date().toISOString(), dividends = [], trailMult = POS_CFG.trailMult) {
  if (entry.status !== "OPEN") return entry;
  const after = settled.filter(c => String(c.date) > String(entry.dataAsOf.date));
  const atrV = entry.atr || 0, initialSl = entry.sl;
  let highWater = entry.highWater != null ? entry.highWater : entry.entry;
  const close = (exit, c, bars) => {
    const net = tradeNet("BUY", entry.entry, exit, costPerTrade);
    return { ...entry, status: exit >= entry.entry ? "WIN" : "LOSS",
      exit: parseFloat(exit.toFixed(4)), exitDate: c.date, exitAt, barsHeld: bars,
      pnl: parseFloat(net.pnl.toFixed(4)), grossPct: parseFloat(net.grossPct.toFixed(4)), pnlPct: net.pnlPct,
      benchClose: parseFloat(c.close.toFixed(4)),
      benchDiv: dividendsInWindow(dividends, entry.dataAsOf.date, c.date) };
  };
  for (let i = 0; i < after.length; i++) {
    const c = after[i];
    const trailStop = Math.max(initialSl, highWater - atrV * trailMult);
    if (c.low <= trailStop) return close(trailStop, c, i + 1);
    highWater = Math.max(highWater, c.high);
    const sNow = scorePosition(settled.filter(b => String(b.date) <= String(c.date)));
    if (sNow && sNow.signal === "SELL") return close(c.close, c, i + 1);
  }
  return { ...entry, highWater };                        // still open — persist the trail
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
          // POSITION trades exit via the trailing/thesis-break mark; tactical via SL/TP.
          const isPos = e.tags && e.tags.mode === "position";
          const upd = isPos ? markToMarketPosition(e, settled, undefined, divs)
                            : markToMarket(e, settled, undefined, divs);
          if (upd.status !== "OPEN") { fresh.push(upd); closed++; }
        }
      }
      // 2) Build today's entries (tactical + POSITION), stamping news/event context.
      let news = [];
      if (!fixture && key) { try { news = await fetchPolygonNews(sym, key); } catch { news = []; } }
      for (const entry of [ buildEntry({ sym, settled, fundaDB, news }), buildPositionEntry({ sym, settled, fundaDB, news }) ]) {
        if (!entry) continue;
        const dup = ledger.some(e => e.id === entry.id) || fresh.some(e => e.id === entry.id);
        if (!dup) { fresh.push(entry); previews.push(entry); logged++; }
      }
      if (!fixture && PACE) await sleep(PACE); // throttle only if a rate-limited tier is set
    } catch (e) {
      skipped++;
      if (args.preview) console.warn("✗ " + sym + " — " + (e.message || e));
    }
  }

  // Cross-sectional momentum overlay: rank THIS run's new tactical longs by trailing momentum
  // and flag the top tertile as momentumActivated. Pure ranking on already-built entries; it
  // mutates only the propose-only label (never gate.actionable / which trades opened).
  const tacticalNew = previews.filter(e => e.tags && e.tags.mode !== "position");
  const momFlags = momentumRankGate(tacticalNew.map(e => e.tags.momentum));
  tacticalNew.forEach((e, i) => { e.tags.momentumActivated = momFlags[i]; });
  // Cross-sectional reversal overlay: same top-tertile ranking on the reversal score (biggest
  // recent losers). Independent label; touches only e.tags.reversalActivated, never the gate.
  const revFlags = reversalRankGate(tacticalNew.map(e => e.tags.reversal));
  tacticalNew.forEach((e, i) => { e.tags.reversalActivated = revFlags[i]; });
  // Cross-sectional low-vol overlay: top-tertile ranking on the low-vol score (calmest names).
  // Independent label; touches only e.tags.lowVolActivated, never the gate.
  const lvFlags = lowVolRankGate(tacticalNew.map(e => e.tags.lowVol));
  tacticalNew.forEach((e, i) => { e.tags.lowVolActivated = lvFlags[i]; });
  // Cross-sectional quality overlay: top-tertile ranking on profitability (highest ROE).
  // Independent label; touches only e.tags.qualityActivated, never the gate.
  const qFlags = qualityRankGate(tacticalNew.map(e => e.tags.quality));
  tacticalNew.forEach((e, i) => { e.tags.qualityActivated = qFlags[i]; });
  // Quality × DURATION (the quality-duration study's one positive find): rank the POSITION
  // (long-hold) batch by quality too, so quality-position can be judged on multi-month holds.
  // Same pure rank gate; touches only e.tags.qualityActivated on position rows, never the gate.
  const positionNew = previews.filter(e => e.tags && e.tags.mode === "position");
  const pqFlags = qualityRankGate(positionNew.map(e => e.tags.quality));
  positionNew.forEach((e, i) => { e.tags.qualityActivated = pqFlags[i]; });

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
