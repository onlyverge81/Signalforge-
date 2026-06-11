// Offline unit tests for the forward-test logger's pure helpers — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSettled, markToMarket, mergeLedger, buildEntry, parseFeed, gradeFor } from "./forward-log.mjs";

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

test("gradeFor: returns a letter grade from filed figures + price, null when absent", () => {
  const db = { AAA: { epsTTM: 10, bvps: 20, de: 0.3, roe: 0.25, npm: 0.25, cr: 2, revG: 0.2, epsG: 0.2 } };
  const g = gradeFor("AAA", 100, db); // P/E 10, P/B 5
  assert.ok(["A", "B", "C", "D", "F"].includes(g));
  assert.equal(gradeFor("ZZZ", 100, db), null);
  assert.equal(gradeFor("AAA", 100, null), null);
});
