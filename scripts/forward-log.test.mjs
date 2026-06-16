// Offline unit tests for the forward-test logger's pure helpers — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSettled, markToMarket, mergeLedger, buildEntry, parseFeed, gradeFor, forwardGates, meritGate, momentumValue, momentumRankGate, reversalValue, reversalRankGate, lowVolValue, lowVolRankGate, qualityValue, qualityRankGate, eventTags, earningsGate, buildPositionEntry, markToMarketPosition } from "./forward-log.mjs";

// A long uptrend of `up` rising bars then `dip` declining bars (a pullback inside the trend).
const _pbar = c => { c=+(+c).toFixed(4); return { date:"2025-01-01", open:c, high:+(c+1).toFixed(4), low:+(c-1).toFixed(4), close:c, volume:1e6 }; };
function posUp(up, dip=0){
  const rows=[]; for(let i=0;i<up;i++) rows.push(_pbar(100+0.5*i));
  const top=100+0.5*(up-1); for(let i=1;i<=dip;i++) rows.push(_pbar(top-1.2*i));
  return rows;
}

// ─── splitSettled — drop a trailing FORMING bar, keep settled history ────────
test("splitSettled: a bar dated today before settlement is treated as forming", () => {
  const today = new Date("2026-06-11T15:00:00Z");          // 15:00 UTC → before 21:00
  const candles = [
    { date: "2026-06-09", close: 1 },
    { date: "2026-06-10", close: 2 },
    { date: "2026-06-11", close: 3 },                       // today, still forming
  ];
  const { settled, formingBar } = splitSettled(candles, today);
  assert.equal(settled.length, 2);
  assert.equal(formingBar.date, "2026-06-11");
});

test("splitSettled: after settlement hour, today's bar counts as settled", () => {
  const evening = new Date("2026-06-11T22:00:00Z");         // 22:00 UTC → past 21:00
  const candles = [{ date: "2026-06-10", close: 2 }, { date: "2026-06-11", close: 3 }];
  const { settled, formingBar } = splitSettled(candles, evening);
  assert.equal(settled.length, 2);
  assert.equal(formingBar, null);
});

// ─── markToMarket — no-lookahead exits with the shared SL-first / cost math ───
const openTrade = {
  id: "X-1day-2026-01-10-BUY", ticker: "X", interval: "1day", signal: "BUY",
  entry: 100, sl: 98, tp1: 104, tp2: 110, status: "OPEN",
  dataAsOf: { date: "2026-01-10", close: 100 },
};
const bar = (date, high, low) => ({ date, open: 100, high, low, close: (high + low) / 2 });

test("markToMarket: closes WIN on the first bar AFTER entry that tags TP", () => {
  const settled = [
    bar("2026-01-10", 105, 99),   // SAME day as entry → must be ignored (no lookahead)
    bar("2026-01-11", 101, 100),  // no touch
    bar("2026-01-12", 106, 101),  // high ≥ tp1 → WIN here
  ];
  const r = markToMarket(openTrade, settled, "2026-01-12T22:00:00Z");
  assert.equal(r.status, "WIN");
  assert.equal(r.exit, 104);
  assert.equal(r.exitDate, "2026-01-12");
  assert.equal(r.barsHeld, 2);         // 2 bars after entry
  assert.ok(r.pnlPct < 4 && r.pnlPct > 3.5); // 4% gross − 0.12% cost
});

test("markToMarket: a bar straddling SL and TP is a LOSS (SL-first)", () => {
  const settled = [bar("2026-01-11", 105, 97)]; // low ≤ sl AND high ≥ tp1
  const r = markToMarket(openTrade, settled);
  assert.equal(r.status, "LOSS");
  assert.equal(r.exit, 98);
});

test("markToMarket: stays OPEN when no later bar touches a level", () => {
  const settled = [bar("2026-01-11", 103, 99), bar("2026-01-12", 103.5, 99.5)];
  const r = markToMarket(openTrade, settled);
  assert.equal(r.status, "OPEN");
  assert.equal(r, openTrade); // unchanged reference when still open
});

test("markToMarket: SELL mirrors (profit when price falls to TP)", () => {
  const sell = { ...openTrade, signal: "SELL", sl: 102, tp1: 96 };
  const settled = [bar("2026-01-11", 101, 95)]; // low ≤ tp1, high < sl → WIN
  const r = markToMarket(sell, settled);
  assert.equal(r.status, "WIN");
  assert.equal(r.exit, 96);
});

// ─── mergeLedger — union by id, prefer closed, no dupes ──────────────────────
test("mergeLedger: unions by id, prefers a closed trade over its open version", () => {
  const open = { id: "A", status: "OPEN", loggedAt: "2026-01-10T00:00:00Z" };
  const closed = { id: "A", status: "WIN", loggedAt: "2026-01-10T00:00:00Z", exitAt: "2026-01-15T00:00:00Z" };
  const other = { id: "B", status: "OPEN", loggedAt: "2026-01-09T00:00:00Z" };
  const merged = mergeLedger([open, other], [closed]);
  assert.equal(merged.length, 2);                       // no dupes
  assert.equal(merged.find(e => e.id === "A").status, "WIN");
  assert.equal(merged[0].id, "B");                      // sorted by loggedAt
});

// ─── buildEntry — produces a tagged entry on a real settled series ────────────
function genUp(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const close = +(100 + 0.4 * i + Math.sin(i / 6) * 1.2).toFixed(4);
    const open = +(close - 0.3).toFixed(4);
    const high = +(Math.max(open, close) + 0.7).toFixed(4);
    const low = +(Math.min(open, close) - 0.7).toFixed(4);
    rows.push({ date: `2025-${String(1 + Math.floor(i / 28) % 12).padStart(2, "0")}-${String(1 + i % 28).padStart(2, "0")}`, open, high, low, close, volume: 1e6 });
  }
  return rows;
}

test("buildEntry: emits a tagged entry with stable id and gate flags", () => {
  const settled = genUp(120);
  const e = buildEntry({ sym: "TST", settled, fundaDB: null, loggedAt: "2026-06-11T22:00:00Z" });
  assert.ok(e);
  assert.equal(e.ticker, "TST");
  assert.equal(e.interval, "1day");
  assert.equal(e.barState, "closed");
  assert.equal(e.entryFill, "close@settled");
  assert.ok(["OPEN", "OBSERVATION"].includes(e.status));
  assert.equal(e.id, `TST-1day-${settled[settled.length - 1].date}-${e.signal}`);
  assert.ok("signalMuted" in e.tags && "edgeVerdict" in e.tags && "dataSuspect" in e.tags);
  // Too little history → null (no untrustworthy logging).
  assert.equal(buildEntry({ sym: "TST", settled: genUp(20), fundaDB: null }), null);
});

test("buildEntry: HOLD is recorded as an OBSERVATION (no position)", () => {
  // A flat, choppy series tends to read HOLD; assert the OBSERVATION path shape.
  const settled = genUp(120).map((r, i) => ({ ...r, close: 100 + Math.sin(i / 3) * 0.5, open: 100, high: 101, low: 99 }));
  const e = buildEntry({ sym: "FLT", settled, fundaDB: null });
  if (e && e.signal === "HOLD") {
    assert.equal(e.status, "OBSERVATION");
    assert.equal(e.exit, null);
  }
});

// ─── forwardGates — long-only + cost + sign-aware edge policy ────────────────
// A clean, proven-winning long entry: target (110) clears 2× cost easily.
const okBuy = { signal:"BUY", entry:100, tp1:110, costPerTrade:0.12, longOnly:true,
                stats:{ significance:"SIGNIFICANT", expectancy:0.4 }, suspect:false };

test("forwardGates: a tradeable long opens a position", () => {
  const g = forwardGates(okBuy);
  assert.equal(g.actionable, true);
  assert.equal(g.tags.signalMuted, false);
  assert.equal(g.tags.negativeEdge, false);
});

test("forwardGates: a SELL is never taken under long-only (recorded, not opened)", () => {
  const g = forwardGates({ ...okBuy, signal:"SELL" });
  assert.equal(g.actionable, false);
  assert.equal(g.tags.longOnlyMuted, true);
  assert.equal(g.tags.signalMuted, true);
});

test("forwardGates: a PROVEN-losing long is muted and not opened (the bug fix)", () => {
  const g = forwardGates({ ...okBuy, stats:{ significance:"SIGNIFICANT", expectancy:-0.47 } });
  assert.equal(g.tags.negativeEdge, true);
  assert.equal(g.tags.edgeMuted, true);
  assert.equal(g.actionable, false);    // a measured loser must NOT take the trade
});

test("forwardGates: a target too thin to clear 2× costs is cost-muted", () => {
  const g = forwardGates({ ...okBuy, tp1:100.1 }); // 0.1% move < 2×0.12% = 0.24%
  assert.equal(g.tags.costMuted, true);
  assert.equal(g.actionable, false);
});

test("forwardGates: an UNPROVEN-but-not-losing long still opens (honest logging)", () => {
  const g = forwardGates({ ...okBuy, stats:{ significance:"NOT SIGNIFICANT", expectancy:0.2 } });
  assert.equal(g.tags.edgeMuted, true);     // display-muted: edge not established
  assert.equal(g.tags.negativeEdge, false); // but it isn't a proven loser
  assert.equal(g.actionable, true);         // so we still log the paper position
});

// ─── parseFeed + gradeFor ────────────────────────────────────────────────────
test("parseFeed: maps a Twelve Data response oldest-first and drops bad rows", () => {
  const feed = { values: [
    { datetime: "2026-01-03", open: "3", high: "4", low: "2", close: "3.5", volume: "10" },
    { datetime: "2026-01-02", open: "2", high: "3", low: "1", close: "2.5", volume: "10" },
  ] };
  const rows = parseFeed(feed, "X");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, "2026-01-02"); // reversed to chronological
  assert.equal(rows[1].close, 3.5);
});

// ─── meritGate — propose-only merit LABEL (must not change the trade decision) ─
test("meritGate: grade A/B clear the bar; C/D/F/null do not", () => {
  assert.equal(meritGate("A"), true);
  assert.equal(meritGate("B"), true);
  assert.equal(meritGate("C"), false);
  assert.equal(meritGate("F"), false);
  assert.equal(meritGate(null), false);
  assert.equal(meritGate("A", { minGrade: "A" }), true);
  assert.equal(meritGate("B", { minGrade: "A" }), false);
});

test("buildEntry: meritsActivated tracks grade but never changes the OPEN/OBSERVATION decision", () => {
  const settled = genUp(120);
  const base = buildEntry({ sym: "TST", settled, fundaDB: null, loggedAt: "2026-06-11T22:00:00Z" });
  assert.equal(base.tags.meritsActivated, false); // no grade → overlay off
  const db = { TST: { epsTTM: 10, bvps: 20, de: 0.3, roe: 0.25, npm: 0.25, cr: 2, revG: 0.2, epsG: 0.2 } };
  const graded = buildEntry({ sym: "TST", settled, fundaDB: db, loggedAt: "2026-06-11T22:00:00Z" });
  // The label is exactly the pure gate applied to the resolved grade…
  assert.equal(graded.tags.meritsActivated, meritGate(graded.tags.fundamentalGrade));
  // …and the decision, signal, entry and id are byte-identical with or without the overlay:
  // merit is a label, not a gate (the Step-3 safety property).
  assert.equal(graded.status, base.status);
  assert.equal(graded.signal, base.signal);
  assert.equal(graded.id, base.id);
  assert.equal(graded.entry, base.entry);
});

// ─── POSITION forward stream (PR2) ────────────────────────────────────────────
test("buildPositionEntry: skips short history; OPENs a dip-buy in a REAL 200-bar uptrend", () => {
  assert.equal(buildPositionEntry({ sym:"X", settled: posUp(150), fundaDB:null }), null); // <200 → not engaged → not logged
  const e = buildPositionEntry({ sym:"X", settled: posUp(206,14), fundaDB:null, loggedAt:"2026-06-15T22:00:00Z" });
  assert.ok(e);
  assert.equal(e.tags.mode, "position");
  assert.equal(e.signal, "BUY");
  assert.equal(e.status, "OPEN");
  assert.ok(e.sl < e.entry && e.highWater === e.entry); // wide stop set, high-water seeded
  assert.match(e.id, /-POS-/);
});

test("buildPositionEntry: an engaged uptrend with no pullback is a HOLD observation (no position)", () => {
  const e = buildPositionEntry({ sym:"X", settled: posUp(220, 0), fundaDB:null });
  assert.ok(e);
  assert.equal(e.signal, "HOLD");
  assert.equal(e.status, "OBSERVATION");
  assert.equal(e.entry, null);
});

test("markToMarketPosition: a TRAILING stop lets a winner run, then exits on the pullback", () => {
  const d = n => "2026-02-" + String(n).padStart(2,"0");
  const bar = (day,c) => ({ date:d(day), open:c, high:c+1, low:c-1, close:c });
  const settled = [ bar(1,100) ];                            // entry bar
  for(let i=1;i<=20;i++) settled.push(bar(1+i, 100+i));      // rally 101..120
  for(let i=1;i<=10;i++) settled.push(bar(21+i, 120-i));     // pullback 119..110
  const entry = { status:"OPEN", signal:"BUY", ticker:"X", interval:"1day", entry:100, sl:97, atr:1,
    highWater:100, dataAsOf:{date:d(1), close:100}, tags:{mode:"position"} };
  const r = markToMarketPosition(entry, settled, "2026-03-01T00:00:00Z", []);
  assert.equal(r.status, "WIN");
  assert.ok(r.exit > 100 + 6, "ran past a 6xATR fixed cap (trailing let it run)");
  assert.ok(r.exit < 120, "exited on the pullback, not the exact top");
});

test("gradeFor: returns a letter grade from filed figures + price, null when absent", () => {
  const db = { AAA: { epsTTM: 10, bvps: 20, de: 0.3, roe: 0.25, npm: 0.25, cr: 2, revG: 0.2, epsG: 0.2 } };
  const g = gradeFor("AAA", 100, db); // P/E 10, P/B 5
  assert.ok(["A", "B", "C", "D", "F"].includes(g));
  assert.equal(gradeFor("ZZZ", 100, db), null);
  assert.equal(gradeFor("AAA", 100, null), null);
});

// ─── momentum overlay — propose-only cross-sectional LABEL (no decision change) ─
test("momentumValue: null without ~12 months of history; positive on a steady uptrend", () => {
  assert.equal(momentumValue(genUp(120)), null, "120 daily bars < 252 lookback → null");
  const mom = momentumValue(genUp(300));
  assert.ok(mom != null && mom > 0, "a 300-bar uptrend has positive 12-1 momentum, got " + mom);
  // Skip-month: the signal ignores the most recent ~21 bars (uses close[len-1-21] / close[len-1-252]).
  const c = genUp(300), last = c.length - 1;
  assert.ok(Math.abs(mom - (c[last - 21].close / c[last - 252].close - 1)) < 1e-9, "uses the skip-month 12-1 definition");
});

test("momentumRankGate: flags the top tertile; <3 rankable names ⇒ none; nulls ignored", () => {
  // 6 values → top third = top 2. Highest two (0.9, 0.5) flagged.
  assert.deepEqual(momentumRankGate([0.1, 0.9, -0.2, 0.5, 0.0, -0.5]),
    [false, true, false, true, false, false]);
  assert.deepEqual(momentumRankGate([0.5, 0.4]), [false, false], "too few to rank → no activation");
  // nulls are not rankable and never activate; the 3 finite values rank among themselves.
  assert.deepEqual(momentumRankGate([null, 0.3, null, 0.9, 0.1]),
    [false, false, false, true, false]);
});

test("buildEntry: momentum tag is attached; momentumActivated defaults false and never changes status", () => {
  const settled = genUp(300);                          // enough history for a momentum value
  const e = buildEntry({ sym: "TST", settled, fundaDB: null, loggedAt: "2026-06-11T22:00:00Z" });
  assert.ok(e);
  assert.ok("momentum" in e.tags && e.tags.momentum != null, "raw momentum value is logged");
  assert.equal(e.tags.momentumActivated, false, "cross-sectional flag is OFF until the run ranks the batch");
  // The label must not change the trade decision: status is driven purely by the gate.
  const gate = forwardGates({ signal: e.signal, entry: e.entry, tp1: e.tp1,
    stats: null, suspect: false, costPerTrade: 0.1, longOnly: true });
  assert.equal(e.status, gate.actionable ? "OPEN" : "OBSERVATION");
  // Short history → momentum tag is null but the entry still logs (label-only, never blocks).
  const short = buildEntry({ sym: "TST", settled: genUp(120), fundaDB: null });
  assert.equal(short.tags.momentum, null);
  assert.equal(short.tags.momentumActivated, false);
});

// ─── reversal overlay — propose-only cross-sectional LABEL (no decision change) ─
test("reversalValue: null without ~1 month of history; NEGATIVE on a steady uptrend (winner ⇒ low score)", () => {
  assert.equal(reversalValue(genUp(20)), null, "20 daily bars ≤ 21 lookback → null");
  const rev = reversalValue(genUp(300));
  assert.ok(rev != null && rev < 0, "a 300-bar uptrend rose last month → negative reversal score, got " + rev);
  // Definition: −(close[len-1] / close[len-1-21] − 1).
  const c = genUp(300), last = c.length - 1;
  assert.ok(Math.abs(rev - (-(c[last].close / c[last - 21].close - 1))) < 1e-9, "uses the negated 1-month-return definition");
});

test("reversalRankGate: flags the top tertile (biggest losers); <3 rankable ⇒ none; nulls ignored", () => {
  // 6 values → top third = top 2. Highest two reversal scores (0.9, 0.5) flagged.
  assert.deepEqual(reversalRankGate([0.1, 0.9, -0.2, 0.5, 0.0, -0.5]),
    [false, true, false, true, false, false]);
  assert.deepEqual(reversalRankGate([0.5, 0.4]), [false, false], "too few to rank → no activation");
  assert.deepEqual(reversalRankGate([null, 0.3, null, 0.9, 0.1]),
    [false, false, false, true, false]);
});

test("buildEntry: reversal tag is attached; reversalActivated defaults false and never changes status", () => {
  const e = buildEntry({ sym: "TST", settled: genUp(300), fundaDB: null, loggedAt: "2026-06-11T22:00:00Z" });
  assert.ok(e);
  assert.ok("reversal" in e.tags && e.tags.reversal != null, "raw reversal score is logged");
  assert.equal(e.tags.reversalActivated, false, "cross-sectional flag is OFF until the run ranks the batch");
  // The label must not change the trade decision: status is driven purely by the gate.
  const gate = forwardGates({ signal: e.signal, entry: e.entry, tp1: e.tp1,
    stats: null, suspect: false, costPerTrade: 0.1, longOnly: true });
  assert.equal(e.status, gate.actionable ? "OPEN" : "OBSERVATION");
});

// ─── low-vol overlay — propose-only cross-sectional LABEL (no decision change) ──
// A deterministic daily series whose return volatility scales with `amp`.
function genVol(n, amp) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const close = +(100 + amp * Math.sin(i / 3) + 0.01 * i).toFixed(4);
    rows.push({ date: `2025-01-01`, open: close, high: close + 1, low: close - 1, close, volume: 1e6 });
  }
  return rows;
}
test("lowVolValue: null without ~12 months of history; negative; CALM series scores higher than WILD", () => {
  assert.equal(lowVolValue(genVol(250, 1)), null, "250 daily bars ≤ 252 lookback → null");
  const calm = lowVolValue(genVol(300, 0.5));
  const wild = lowVolValue(genVol(300, 5));
  assert.ok(calm != null && wild != null, "enough history → a score");
  assert.ok(calm < 0 && wild < 0, "negated realized vol is ≤ 0");
  assert.ok(calm > wild, "the calmer series must have the higher (closer-to-zero) low-vol score");
});

test("lowVolRankGate: flags the top tertile (calmest); <3 rankable ⇒ none; nulls ignored", () => {
  // 6 values → top third = 2. Highest two scores: 0.0 (idx 4) and −0.1 (idx 0) are the calmest.
  assert.deepEqual(lowVolRankGate([-0.1, -0.9, -0.2, -0.5, 0.0, -0.5]),
    [true, false, false, false, true, false], "the two least-negative (calmest) scores flag");
  assert.deepEqual(lowVolRankGate([-0.5, -0.4]), [false, false], "too few to rank → no activation");
  assert.deepEqual(lowVolRankGate([null, -0.3, null, -0.9, -0.1]),
    [false, false, false, false, true], "nulls ignored; calmest (−0.1) flagged");
});

test("buildEntry: lowVol tag is attached; lowVolActivated defaults false and never changes status", () => {
  const e = buildEntry({ sym: "TST", settled: genUp(300), fundaDB: null, loggedAt: "2026-06-11T22:00:00Z" });
  assert.ok(e);
  assert.ok("lowVol" in e.tags && e.tags.lowVol != null, "raw low-vol score is logged");
  assert.equal(e.tags.lowVolActivated, false, "cross-sectional flag is OFF until the run ranks the batch");
  const gate = forwardGates({ signal: e.signal, entry: e.entry, tp1: e.tp1,
    stats: null, suspect: false, costPerTrade: 0.1, longOnly: true });
  assert.equal(e.status, gate.actionable ? "OPEN" : "OBSERVATION");
});

// ─── quality overlay — propose-only cross-sectional LABEL (no decision change) ──
test("qualityValue: reads ROE off the fundamentals rec; null when missing/non-finite", () => {
  assert.equal(qualityValue({ roe: 0.18, npm: 0.10 }), 0.18, "returns ROE");
  assert.equal(qualityValue({ roe: null }), null);
  assert.equal(qualityValue({}), null, "no ROE → null");
  assert.equal(qualityValue(null), null, "no rec → null");
});

test("qualityRankGate: flags the top tertile (most profitable); <3 rankable ⇒ none; nulls ignored", () => {
  assert.deepEqual(qualityRankGate([0.05, 0.25, -0.10, 0.18, 0.02, -0.30]),
    [false, true, false, true, false, false], "top two ROEs (0.25, 0.18) flag");
  assert.deepEqual(qualityRankGate([0.2, 0.1]), [false, false], "too few to rank → no activation");
  assert.deepEqual(qualityRankGate([null, 0.1, null, 0.3, 0.05]),
    [false, false, false, true, false], "nulls ignored; highest (0.3) flagged");
});

test("buildEntry: quality tag rides fundaDB ROE; qualityActivated defaults false; null without fundamentals", () => {
  const fundaDB = { TST: { roe: 0.22, npm: 0.12, epsTTM: 5, bvps: 20 } };
  const e = buildEntry({ sym: "TST", settled: genUp(300), fundaDB, loggedAt: "2026-06-11T22:00:00Z" });
  assert.ok(e);
  assert.equal(e.tags.quality, 0.22, "raw profitability (ROE) is logged from fundaDB");
  assert.equal(e.tags.qualityActivated, false, "cross-sectional flag is OFF until the run ranks the batch");
  // No fundamentals → quality tag is null but the entry still logs (label-only, never blocks).
  const noFunda = buildEntry({ sym: "TST", settled: genUp(300), fundaDB: null });
  assert.equal(noFunda.tags.quality, null);
  assert.equal(noFunda.tags.qualityActivated, false);
});

// ─── event overlay — propose-only news LABELS (two hypotheses, no decision change) ─
test("eventTags: newsPositive needs fresh positive news; newsQuiet means no fresh negative news", () => {
  assert.deepEqual(eventTags({ count: 2, sentiment: "positive" }), { newsPositive: true,  newsQuiet: true });
  assert.deepEqual(eventTags({ count: 3, sentiment: "negative" }), { newsPositive: false, newsQuiet: false });
  assert.deepEqual(eventTags({ count: 1, sentiment: "neutral"  }), { newsPositive: false, newsQuiet: true });
  // No news in the window (count 0, sentiment null) → not positive, but quiet (no bad news).
  assert.deepEqual(eventTags({ count: 0, sentiment: null }), { newsPositive: false, newsQuiet: true });
  assert.deepEqual(eventTags(undefined), { newsPositive: false, newsQuiet: true });
});

test("buildEntry: news labels ride the captured events and never change the OPEN/OBSERVATION decision", () => {
  const settled = genUp(120);
  const decisionDate = settled[settled.length - 1].date;
  // Fresh POSITIVE news on the decision bar → newsPositive true, newsQuiet true.
  const news = [{ publishedUtc: decisionDate + "T12:00:00Z", sentiment: "positive" }];
  const e = buildEntry({ sym: "TST", settled, fundaDB: null, news, loggedAt: "2026-06-11T22:00:00Z" });
  assert.equal(e.tags.newsPositive, true);
  assert.equal(e.tags.newsQuiet, true);
  assert.deepEqual(eventTags(e.events), { newsPositive: e.tags.newsPositive, newsQuiet: e.tags.newsQuiet });
  // Same series, fresh NEGATIVE news → flips both labels, but the status is unchanged (label-only).
  const neg = buildEntry({ sym: "TST", settled, fundaDB: null, news: [{ publishedUtc: decisionDate + "T12:00:00Z", sentiment: "negative" }] });
  assert.equal(neg.tags.newsPositive, false);
  assert.equal(neg.tags.newsQuiet, false);
  assert.equal(neg.status, e.status, "news sentiment must not change which trades open");
  // No news at all → quiet (no bad news), not positive.
  const none = buildEntry({ sym: "TST", settled, fundaDB: null, news: [] });
  assert.equal(none.tags.newsPositive, false);
  assert.equal(none.tags.newsQuiet, true);
});

// ─── earnings-proximity overlay — propose-only LABEL from the SEC filing date ──
test("earningsGate: true only when the last 10-Q/10-K was filed within recentDays before the bar", () => {
  const decision = "2026-06-11";
  assert.equal(earningsGate({ lastFiled: "2026-06-01" }, decision), true);   // 10 days ago → recent
  assert.equal(earningsGate({ lastFiled: "2026-04-01" }, decision), false);  // ~71 days ago → stale
  assert.equal(earningsGate({ lastFiled: "2026-06-25" }, decision), false);  // filed AFTER the bar → no lookahead
  assert.equal(earningsGate({ lastFiled: null }, decision), false);          // no filing date → off
  assert.equal(earningsGate(null, decision), false);                         // no record → off
  assert.equal(earningsGate({ lastFiled: "2026-05-20" }, decision, { recentDays: 10 }), false); // window tightened
});

test("buildEntry: earningsRecent rides fundamentals.lastFiled and never changes the trade decision", () => {
  const settled = genUp(120);
  const decisionDate = settled[settled.length - 1].date;
  const recent = { TST: { lastFiled: decisionDate } };                       // filed on the decision bar
  const e = buildEntry({ sym: "TST", settled, fundaDB: recent, loggedAt: "2026-06-11T22:00:00Z" });
  assert.equal(e.tags.earningsRecent, true);
  // Stale filing → label off, but status (OPEN/OBSERVATION) is identical (label-only).
  const stale = buildEntry({ sym: "TST", settled, fundaDB: { TST: { lastFiled: "2000-01-01" } } });
  assert.equal(stale.tags.earningsRecent, false);
  assert.equal(stale.status, e.status, "earnings proximity must not change which trades open");
  // No fundamentals at all → off, still logs.
  const none = buildEntry({ sym: "TST", settled, fundaDB: null });
  assert.equal(none.tags.earningsRecent, false);
});
