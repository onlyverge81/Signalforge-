// Offline unit tests for the extracted SignalForge engine — no network.
// Run: node --test scripts/
//
// Two jobs:
//  1) Pin the shared trade helpers (checkBarExit / tradeNet / realizedStats) that
//     both runBacktest and the forward-test ledger rely on — the SL-first tie, the
//     round-trip cost model, and the t-stat significance verdict.
//  2) Regression-lock analyze() + runBacktest() on a deterministic synthetic series
//     so the engine.mjs copy can't silently drift from the browser's (index.html).
//     If you change the engine in index.html, mirror it here and update the snapshot.

import { test } from "node:test";
import assert from "node:assert/strict";
import { analyze, runBacktest, scoreAt, checkBarExit, checkBarExitFine, isAmbiguousBar, tradeNet, realizedStats, convergenceBreakout, backtestPattern, edgeStatus } from "./engine.mjs";

// ─── Helper: deterministic OHLC series (no RNG, fixed formula) ───────────────
function gen(n){
  const rows=[]; let p=100;
  for(let i=0;i<n;i++){
    const drift=0.25, wig=Math.sin(i/5)*1.5 + Math.cos(i/11)*0.8;
    const close=+(p + drift*i + wig).toFixed(4);
    const open=+(close - Math.sin(i/7)*0.5).toFixed(4);
    const high=+(Math.max(open,close)+Math.abs(Math.cos(i/3))*0.9+0.3).toFixed(4);
    const low=+(Math.min(open,close)-Math.abs(Math.sin(i/4))*0.9-0.3).toFixed(4);
    const vol=1000000+Math.round(Math.abs(Math.sin(i/6))*500000);
    const d=`2025-${String(1+Math.floor(i/28)%12).padStart(2,"0")}-${String(1+i%28).padStart(2,"0")}`;
    rows.push({date:d,open,high,low,close,volume:vol});
  }
  return rows;
}

// ─── 1) checkBarExit — SL is checked FIRST (pessimistic tie) ─────────────────
test("checkBarExit: a bar straddling both SL and TP is a LOSS (SL-first tie)", () => {
  const t={dir:"BUY", entry:100, sl:98, tp:102};
  // low 97 ≤ sl AND high 103 ≥ tp on the same bar → must resolve LOSS, not WIN.
  assert.deepEqual(checkBarExit(t, {open:100,high:103,low:97,close:101}), {exit:98, result:"LOSS"});
});

test("checkBarExit: clean TP hit is a WIN; no touch is null; SELL side mirrors", () => {
  const buy={dir:"BUY", entry:100, sl:98, tp:102};
  assert.deepEqual(checkBarExit(buy, {open:100,high:103,low:99,close:101}), {exit:102, result:"WIN"});
  assert.equal(checkBarExit(buy, {open:100,high:101,low:99,close:100}), null);
  const sell={dir:"SELL", entry:100, sl:102, tp:98};
  // SELL: high ≥ sl is the loss leg, checked first.
  assert.deepEqual(checkBarExit(sell, {open:100,high:103,low:97,close:99}), {exit:102, result:"LOSS"});
  assert.deepEqual(checkBarExit(sell, {open:100,high:101,low:97,close:99}), {exit:98, result:"WIN"});
});

// ─── 1b) checkBarExitFine — resolve the straddle from finer sub-bars ─────────
test("isAmbiguousBar: true only when a bar straddles BOTH stop and target", () => {
  const t={dir:"BUY", entry:100, sl:98, tp:102};
  assert.equal(isAmbiguousBar(t, {high:103, low:97}), true);   // both touched
  assert.equal(isAmbiguousBar(t, {high:103, low:99}), false);  // only TP
  assert.equal(isAmbiguousBar(t, {high:101, low:97}), false);  // only SL
});

test("checkBarExitFine: sub-bars reveal TP came first → WIN, overturning the pessimistic LOSS", () => {
  const t={dir:"BUY", entry:100, sl:98, tp:102};
  const coarse={open:100,high:103,low:97,close:101};          // ambiguous: straddles both
  assert.deepEqual(checkBarExit(t, coarse), {exit:98, result:"LOSS"}); // pessimistic guess
  // intraday path: price tagged TP (high 102.5) BEFORE it ever traded down to SL.
  const subBars=[
    {open:100,high:102.5,low:100,close:102},                  // TP touched here, SL not yet
    {open:102,high:102,low:97,close:98},                      // SL later — but we already exited
  ];
  assert.deepEqual(checkBarExitFine(t, coarse, subBars), {exit:102, result:"WIN", resolvedBy:"subbars"});
});

test("checkBarExitFine: sub-bars confirming SL-first keep the LOSS", () => {
  const t={dir:"BUY", entry:100, sl:98, tp:102};
  const coarse={open:100,high:103,low:97,close:101};
  const subBars=[
    {open:100,high:100.5,low:97,close:98},                    // SL first
    {open:98,high:103,low:98,close:102},                      // TP only afterwards
  ];
  assert.deepEqual(checkBarExitFine(t, coarse, subBars), {exit:98, result:"LOSS", resolvedBy:"subbars"});
});

test("checkBarExitFine: unambiguous bars and the no-sub-bars case defer to checkBarExit", () => {
  const t={dir:"BUY", entry:100, sl:98, tp:102};
  // clean TP, sub-bars irrelevant → identical to checkBarExit (no resolvedBy tag)
  assert.deepEqual(checkBarExitFine(t, {open:100,high:103,low:99,close:101}, []), {exit:102, result:"WIN"});
  // ambiguous but no finer data → falls back to the safe pessimistic LOSS
  assert.deepEqual(checkBarExitFine(t, {open:100,high:103,low:97,close:101}, null), {exit:98, result:"LOSS"});
});

// ─── 2) tradeNet — round-trip cost model ─────────────────────────────────────
test("tradeNet: subtracts the round-trip cost from gross %, both directions", () => {
  assert.deepEqual(tradeNet("BUY", 100, 102, 0.2), {pnl:2, grossPct:2, pnlPct:1.8});
  // SELL profits when exit < entry.
  const s=tradeNet("SELL", 100, 98, 0.2);
  assert.equal(s.pnl, 2); assert.equal(s.grossPct, 2); assert.equal(s.pnlPct, 1.8);
  // Zero cost ⇒ pnlPct === grossPct.
  assert.equal(tradeNet("BUY", 50, 55, 0).pnlPct, 10);
});

// ─── 3) realizedStats — counts + significance verdict ────────────────────────
test("realizedStats: win/loss tally and expectancy over a fixed set", () => {
  const trades=[
    {result:"WIN",  pnlPct:3, grossPct:3.2},
    {result:"WIN",  pnlPct:1, grossPct:1.2},
    {result:"LOSS", pnlPct:-2, grossPct:-1.8},
    {result:"WIN",  pnlPct:2, grossPct:2.2},
  ];
  const {stats}=realizedStats(trades);
  assert.equal(stats.total, 4);
  assert.equal(stats.wins, 3);
  assert.equal(stats.losses, 1);
  assert.equal(stats.winRate, 75);
  assert.equal(stats.totalReturn, 4);   // 3+1-2+2
  assert.equal(stats.expectancy, 1);    // 4/4
});

test("realizedStats: significance buckets match the t-stat gate", () => {
  // <10 trades → TOO FEW TRADES
  assert.equal(realizedStats(Array.from({length:5},()=>({result:"WIN",pnlPct:1,grossPct:1}))).stats.significance, "TOO FEW TRADES");
  // 30 trades, real spread, high t-stat → SIGNIFICANT
  const sig=Array.from({length:30},(_,i)=>({result:"WIN", pnlPct:i%2?3:1, grossPct:i%2?3:1}));
  assert.equal(realizedStats(sig).stats.significance, "SIGNIFICANT");
  // 30 identical returns → zero variance → t-stat 0 → NOT SIGNIFICANT
  const flat=Array.from({length:30},()=>({result:"WIN", pnlPct:2, grossPct:2}));
  assert.equal(realizedStats(flat).stats.significance, "NOT SIGNIFICANT");
});

// ─── 4) Regression snapshot — analyze() + runBacktest() on a fixed series ─────
// These exact numbers are produced by the current engine. A diff here means the
// engine math changed; if intentional, re-capture and update — and mirror the
// same change into index.html so the browser and Node copies stay identical.
test("analyze() snapshot on the deterministic 160-bar series", () => {
  const a=analyze(gen(160), "TST", "Stocks", "Trend Following", 1.5, 2.0);
  assert.equal(a.signal, "HOLD");
  assert.equal(a.confidence, 61);
  assert.equal(a.trend, "UPTREND");
  assert.equal(a.strength, "STRONG");
  assert.equal(a.score, 3.8);
  assert.equal(a.entry, 140.0624);
  assert.equal(a.sl, 143.0462);
  assert.equal(a.tp1, 136.0839);
  assert.equal(a.rr, 1.3);
  assert.equal(a.support, 134.2359);
  assert.equal(a.resistance, 141.5198);
});

test("runBacktest() snapshot on the deterministic 160-bar series", () => {
  const bt=runBacktest(gen(160), scoreAt, 1.5, 2.0, {slip:0.05, comm:0.05}, null, false);
  assert.equal(bt.stats.total, 8);
  assert.equal(bt.stats.wins, 8);
  assert.equal(bt.stats.losses, 0);
  assert.equal(bt.stats.winRate, 100);
  assert.equal(bt.stats.totalReturn, 26.1);
  assert.equal(bt.stats.expectancy, 3.26);
  assert.equal(bt.stats.maxDrawdown, 0);
  assert.equal(bt.stats.significance, "TOO FEW TRADES"); // only 8 trades on this series
});

// ─── edgeStatus — the SIGN-aware gate (the inverted-significance bug fix) ─────
// A SIGNIFICANT *negative* edge is a proven money-loser; it must mute, not show.
test("edgeStatus: a SIGNIFICANT negative edge is muted, not proven (the bug fix)", () => {
  const e = edgeStatus({ significance:"SIGNIFICANT", expectancy:-0.47 });
  assert.equal(e.proven, false);          // a loser is never 'proven'
  assert.equal(e.shown, false);           // never shown loud
  assert.equal(e.muted, true);            // muted because the edge is against us
  assert.equal(e.negativeEdge, true);     // explicitly a proven loser
});
test("edgeStatus: a SIGNIFICANT positive edge is proven and shown", () => {
  const e = edgeStatus({ significance:"SIGNIFICANT", expectancy:0.42 });
  assert.equal(e.proven, true);
  assert.equal(e.shown, true);
  assert.equal(e.muted, false);
  assert.equal(e.negativeEdge, false);
});
test("edgeStatus: SUGGESTIVE positive shows but isn't 'proven'; unproven and missing mute", () => {
  const sug = edgeStatus({ significance:"SUGGESTIVE", expectancy:0.3 });
  assert.equal(sug.shown, true); assert.equal(sug.proven, false); assert.equal(sug.muted, false);
  const weak = edgeStatus({ significance:"NOT SIGNIFICANT", expectancy:0.3 });
  assert.equal(weak.muted, true); assert.equal(weak.negativeEdge, false); // unproven ≠ a loser
  const none = edgeStatus(null);
  assert.equal(none.muted, true); assert.equal(none.verdict, null);
});

// ─── 5) "Uptrend Convergence with Breakout" pattern detector ─────────────────
// Mechanics (trendFilter:false): coil (flat ribbon) → breakout (steady uptrend)
// fires; a flat ribbon alone stays silent; too-short input returns null.
function push(rows,c){ const close=+c.toFixed(4); rows.push({date:"2025-01-01",open:close,high:close+0.2,low:close-0.2,close,volume:1000000}); }
function genCoilBreak(){
  const rows=[];
  for(let i=0;i<40;i++) push(rows, 100 + (i%2?0.02:-0.02));  // coil: ribbon pinched flat
  for(let i=1;i<=40;i++) push(rows, 100 + i*0.8);            // pop: steady uptrend
  return rows;
}
function genFlat(n){ const rows=[]; for(let i=0;i<n;i++) push(rows, 100+(i%2?0.02:-0.02)); return rows; }
// Established uptrend → long flat coil → breakout (passes the trend filter).
function genTrendCoilBreak(){
  const rows=[];
  for(let i=0;i<60;i++) push(rows, 100 + i*0.5);            // 60-bar uptrend → rising SMA50
  for(let i=0;i<24;i++) push(rows, 129.5 + (i%2?0.02:-0.02)); // 24-bar coil (long enough to pinch SMA20)
  for(let i=1;i<=25;i++) push(rows, 129.5 + i*0.7);          // breakout
  return rows;
}
// Flat base (no prior trend) → long coil → breakout (the filter should suppress).
function genFlatCoilBreak(){
  const rows=[];
  for(let i=0;i<85;i++) push(rows, 100 + (i%2?0.02:-0.02)); // flat base → flat SMA50
  for(let i=1;i<=25;i++) push(rows, 100 + i*0.7);           // breakout off the flat base
  return rows;
}

test("convergenceBreakout: null on too-short input", () => {
  assert.equal(convergenceBreakout(genFlat(12)), null);
});

test("backtestPattern: fires on coil→breakout mechanics (filter off)", () => {
  const bt=backtestPattern(genCoilBreak(), {horizon:5, minBars:30, trendFilter:false});
  assert.ok(bt, "expected a result object");
  assert.ok(bt.signals>0, "expected ≥1 detection, got "+bt.signals);
  assert.ok(bt.avgFwdRet>0, "uptrend signals should carry positive forward return");
  assert.ok(bt.edge!=null, "edge should be computable");
});

test("pattern stays silent on a flat ribbon (no breakout)", () => {
  const bt=backtestPattern(genFlat(120), {horizon:5, minBars:30, trendFilter:false});
  assert.ok(bt, "expected a result with enough bars");
  assert.equal(bt.signals, 0);
});

test("trend filter: fires inside an established uptrend (default on)", () => {
  const bt=backtestPattern(genTrendCoilBreak(), {horizon:5, minBars:50});
  assert.ok(bt, "expected a result object");
  assert.ok(bt.signals>0, "an in-uptrend breakout should pass the trend filter, got "+bt.signals);
});

test("trend filter: suppresses a breakout off a flat base", () => {
  const series=genFlatCoilBreak();
  const off=backtestPattern(series, {horizon:5, minBars:50, trendFilter:false});
  const on =backtestPattern(series, {horizon:5, minBars:50, trendFilter:true});
  assert.ok(off.signals>0, "filter-off should still see the raw breakout, got "+off.signals);
  assert.ok(on.signals<off.signals, "filter-on must drop flat-base signals: on="+on.signals+" off="+off.signals);
});
