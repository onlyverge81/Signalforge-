// Offline unit tests for the broad-universe builder's pure helpers — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseGroupedDaily, selectUniverse, recentWeekday, normTickers, pickUniverse, parseRefTickers, parseRefTickerRows, shiftDay } from "./universe-build.mjs";

// ─── parseGroupedDaily — Polygon grouped JSON → liquidity-tagged rows ─────────
test("parseGroupedDaily: maps fields, derives dollar volume, drops malformed rows", () => {
  const j = { results: [
    { T:"AAA", o:10, h:11, l:9, c:10, v:1_000_000, t:1 }, // $vol = 10,000,000
    { T:"BBB", o:5,  h:5,  l:5, c:0, v:5_000, t:1 },        // close 0 → dropped
    { T:"CCC", o:2,  h:3,  l:1, c:2, v:0, t:1 },            // volume 0 → dropped
  ] };
  const rows = parseGroupedDaily(j);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticker, "AAA");
  assert.equal(rows[0].dollarVolume, 10_000_000);
  assert.deepEqual(parseGroupedDaily(null), []);          // defensive on bad input
});

// ─── selectUniverse — screen + liquidity rank, survivorship-free by construction ─
test("selectUniverse: ranks by dollar volume and screens out illiquid/penny/odd symbols", () => {
  const rows = [
    { ticker:"BIG",  close:100, volume:10_000_000, dollarVolume:1_000_000_000 },
    { ticker:"MID",  close:50,  volume:1_000_000,  dollarVolume:50_000_000 },
    { ticker:"PENNY",close:1,   volume:99_000_000, dollarVolume:99_000_000 }, // price < $5 → out
    { ticker:"THIN", close:40,  volume:100,        dollarVolume:4_000 },       // < min $vol → out
    { ticker:"BRK.B",close:400, volume:5_000_000,  dollarVolume:2_000_000_000 }, // non-common symbol → out
  ];
  const u = selectUniverse(rows, { minPrice:5, minDollarVol:5e6, limit:10 });
  assert.deepEqual(u, ["BIG", "MID"]);    // ranked by $vol; penny/thin/odd excluded
});

test("selectUniverse: respects the limit (broadens far past the 36-name list)", () => {
  // letter-only 3-char symbols (base-26) so they pass the common-stock screen
  const sym = i => "A".repeat(0) + String.fromCharCode(65 + (i / 676 | 0) % 26, 65 + (i / 26 | 0) % 26, 65 + i % 26);
  const rows = Array.from({ length: 800 }, (_, i) => ({
    ticker: sym(i), close: 50, volume: 1e6, dollarVolume: 1e9 - i,
  }));
  assert.equal(selectUniverse(rows, { limit:500 }).length, 500);
  assert.equal(selectUniverse(rows, { limit:50 })[0], sym(0)); // highest $vol first
});

test("selectUniverse: an allow-set keeps ONLY those tickers (drops ETFs even if higher $vol)", () => {
  const rows = [
    { ticker:"SPY",  close:500, volume:80_000_000, dollarVolume:40_000_000_000 }, // ETF, huge $vol
    { ticker:"AAPL", close:200, volume:50_000_000, dollarVolume:10_000_000_000 }, // common stock
    { ticker:"SOXL", close:30,  volume:90_000_000, dollarVolume:2_700_000_000 },  // leveraged ETF
    { ticker:"MSFT", close:400, volume:20_000_000, dollarVolume:8_000_000_000 },  // common stock
  ];
  const u = selectUniverse(rows, { allow:new Set(["AAPL","MSFT"]) });
  assert.deepEqual(u, ["AAPL", "MSFT"]); // SPY/SOXL dropped despite ranking higher
});

// ─── parseRefTickers — Polygon reference/tickers → symbol list ───────────────
test("parseRefTickers: extracts ticker symbols, drops malformed", () => {
  const j = { results: [ { ticker:"AAPL", type:"CS" }, { name:"no-ticker" }, { ticker:"MSFT" } ] };
  assert.deepEqual(parseRefTickers(j), ["AAPL", "MSFT"]);
  assert.deepEqual(parseRefTickers(null), []);
});

// ─── parseRefTickerRows — rich rows carrying CIK + de-listed flag ─────────────
test("parseRefTickerRows: keeps CIK (10-digit) and de-listed status, drops ticker-less rows", () => {
  const j = { results: [
    { ticker:"AAPL", cik:"0000320193", active:true },
    { ticker:"LEHMQ", cik:320194, active:false, delisted_utc:"2010-03-12T00:00:00Z" }, // de-listed loser
    { name:"no-ticker", cik:"999" },                                                   // dropped
    { ticker:"NOCIK", active:true },                                                   // cik → null
  ] };
  assert.deepEqual(parseRefTickerRows(j), [
    { ticker:"AAPL",  cik:"0000320193", active:true,  delistedUtc:null },
    { ticker:"LEHMQ", cik:"0000320194", active:false, delistedUtc:"2010-03-12T00:00:00Z" },
    { ticker:"NOCIK", cik:null,         active:true,  delistedUtc:null },
  ]);
  assert.deepEqual(parseRefTickerRows(null), []);
});

// ─── shiftDay — UTC date arithmetic across boundaries ────────────────────────
test("shiftDay: steps days backward/forward across month boundaries", () => {
  assert.equal(shiftDay("2026-06-12", -1), "2026-06-11");
  assert.equal(shiftDay("2026-06-01", -1), "2026-05-31");
  assert.equal(shiftDay("2026-06-12", 0), "2026-06-12");
});

// ─── normTickers — uppercase, trim, de-dupe, drop blanks ─────────────────────
test("normTickers: normalizes and de-dupes, preserving first-seen order", () => {
  assert.deepEqual(normTickers([" aapl ", "MSFT", "aapl", "", null, "nvda"]), ["AAPL", "MSFT", "NVDA"]);
  assert.deepEqual(normTickers(null), []);
});

// ─── pickUniverse — explicit > universe.json > tickers.txt ───────────────────
test("pickUniverse: an explicit --tickers list wins over everything", () => {
  const r = pickUniverse({ explicit:["aapl"], universe:["BIG","MID"], fallback:["X","Y","Z"] });
  assert.deepEqual(r.tickers, ["AAPL"]);
  assert.match(r.source, /override/);
});

test("pickUniverse: falls to the broad universe.json when no explicit list", () => {
  const r = pickUniverse({ explicit:null, universe:["big","mid"], fallback:["X"] });
  assert.deepEqual(r.tickers, ["BIG", "MID"]);
  assert.match(r.source, /universe\.json/);
});

test("pickUniverse: falls all the way back to tickers.txt when nothing else is present", () => {
  const r = pickUniverse({ explicit:null, universe:[], fallback:["aapl","msft"] });
  assert.deepEqual(r.tickers, ["AAPL", "MSFT"]);
  assert.match(r.source, /tickers\.txt/);
});

// ─── recentWeekday — never returns a weekend ─────────────────────────────────
test("recentWeekday: rolls a weekend back to Friday", () => {
  assert.equal(recentWeekday(new Date("2026-06-13T12:00:00Z")), "2026-06-12"); // Sat → Fri
  assert.equal(recentWeekday(new Date("2026-06-14T12:00:00Z")), "2026-06-12"); // Sun → Fri
  assert.equal(recentWeekday(new Date("2026-06-11T12:00:00Z")), "2026-06-11"); // Thu stays
});
