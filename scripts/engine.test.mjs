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
import { analyze, runBacktest, scoreAt, scorePosition, checkBarExit, checkBarExitFine, isAmbiguousBar, tradeNet, realizedStats, convergenceBreakout, backtestPattern, edgeStatus, avgIndexGainByDate, correctionLevels, backtestCorrection, efficiencyRatio, marketRegime } from "./engine.mjs";

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

// ─── 5) POSITION mode — true 200-bar trend filter, dip-buy, thesis-break, trailing ──
const pbar = c => { c=+(+c).toFixed(4); return { date:"2025-01-01", open:c, high:+(c+1).toFixed(4), low:+(c-1).toFixed(4), close:c, volume:1e6 }; };
// `up` rising bars then `dip` declining bars (a pullback inside the uptrend).
function posUp(up, dip=0){
  const rows=[]; for(let i=0;i<up;i++) rows.push(pbar(100+0.5*i));
  const top=100+0.5*(up-1); for(let i=1;i<=dip;i++) rows.push(pbar(top-1.2*i));
  return rows;
}

test("scorePosition: NOT engaged under 200 bars — no silent short-SMA proxy (the fix)", () => {
  const r=scorePosition(posUp(150));
  assert.equal(r.engaged, false);
  assert.equal(r.signal, "HOLD");
  assert.match(r.reason, /200 bars/);
});

test("scorePosition: with 200+ bars, buys a pullback inside a real uptrend", () => {
  const r=scorePosition(posUp(206, 14)); // 206 up, then a 14-bar dip → RSI<45, still > SMA200
  assert.equal(r.engaged, true);
  assert.equal(r.signal, "BUY");
  assert.ok(r.dipDepth > 0 && r.trendStrength > 0);
});

test("scorePosition: a broken long-term thesis flips to SELL", () => {
  const rows=[]; for(let i=0;i<100;i++) rows.push(pbar(100+0.5*i));   // up to 149.5
  for(let i=1;i<=180;i++) rows.push(pbar(149.5-0.6*i));               // long decline below SMA200
  const r=scorePosition(rows);
  assert.equal(r.engaged, true);
  assert.equal(r.signal, "SELL");
});

test("runBacktest holdMode: a TRAILING stop lets a winner run past a fixed TP, exits on the pullback", () => {
  const rows=[];
  for(let i=0;i<35;i++) rows.push(pbar(100));            // base
  for(let i=1;i<=20;i++) rows.push(pbar(100+i));         // rally 101..120 (peak)
  for(let i=1;i<=10;i++) rows.push(pbar(120-i));         // pullback 119..110
  // Custom scorer: one BUY early (atr=1), HOLD after — isolates the EXIT logic from entry.
  let fired=false;
  const scorer=slice=>{ if(!fired && slice.length===34){ fired=true; return {score:6,signal:"BUY",atr:1}; } return {score:0,signal:"HOLD",atr:1}; };
  const bt=runBacktest(rows, scorer, 3, 6, {slip:0,comm:0}, null, true); // holdMode (POSITION)
  assert.equal(bt.trades.length, 1);
  const tr=bt.trades[0];
  assert.ok(tr.exit > tr.entry + 6, "winner ran PAST the 6xATR fixed-TP cap (trailing let it run)");
  assert.ok(tr.exit < 120, "but exited on the pullback — did not sell the exact top");
  assert.equal(tr.result, "WIN");
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

// ─── 5) Custom-target seam — scorer-supplied TP/SL override the ATR default ───
test("runBacktest: scorer customTp/customSl set the trade's targets (not the ATR fallback)", () => {
  const data=gen(60);
  // Fire exactly once (at the first eligible bar, i=30 → slice.length 31) with absolute
  // custom levels; everything after holds. The fill is at the NEXT bar's open.
  let injTp=null, injSl=null;
  const scorer=(slice)=>{
    if(slice.length!==31) return {signal:"HOLD"};
    const c=slice[slice.length-1].close;
    injTp=c+0.5; injSl=c-0.5;
    return {signal:"BUY", atr:1, score:1, customSl:injSl, customTp:injTp};
  };
  const bt=runBacktest(data, scorer, 1.5, 2.0, {slip:0,comm:0}, null, false);
  assert.ok(bt.trades.length>=1, "expected the BUY to open a trade");
  const t=bt.trades[0];
  assert.equal(t.tp, injTp, "tp must equal the injected customTp");
  assert.equal(t.sl, injSl, "sl must equal the injected customSl");
  // And it must NOT be the ATR default (entry ± atr*mult with atr=1).
  assert.notEqual(t.tp, t.entry+1*2.0, "tp should not be the ATR fallback");
});

test("runBacktest: omitting custom targets keeps the ATR fallback byte-identical", () => {
  // A BUY with no custom fields → tp/sl are entry ± atr*mult exactly.
  const data=gen(60);
  const scorer=(slice)=> slice.length===31 ? {signal:"BUY", atr:2, score:1} : {signal:"HOLD"};
  const bt=runBacktest(data, scorer, 1.5, 2.0, {slip:0,comm:0}, null, false);
  assert.ok(bt.trades.length>=1);
  const t=bt.trades[0];
  assert.equal(t.tp, t.entry+2*2.0, "ATR tp fallback unchanged");
  assert.equal(t.sl, t.entry-2*1.5, "ATR sl fallback unchanged");
});

// ─── 6) avgIndexGainByDate — averaged trailing-window gain, date-aligned ──────
test("avgIndexGainByDate: averages each index's trailing-window % at aligned dates", () => {
  const A=[{date:"1",close:100},{date:"2",close:100},{date:"3",close:110}]; // +10% at "3"
  const B=[{date:"1",close:200},{date:"2",close:200},{date:"3",close:230}]; // +15% at "3"
  const C=[{date:"1",close:50}, {date:"2",close:50}, {date:"3",close:55}];  // +10% at "3"
  const m=avgIndexGainByDate([A,B,C],2);
  assert.ok(Math.abs(m.get("3")-(10+15+10)/3)<1e-9, "avg of 10/15/10 at date 3");
  assert.equal(m.get("1"), undefined, "no full window at date 1 → omitted");
  assert.equal(m.get("2"), undefined, "no full window at date 2 → omitted");
});

test("avgIndexGainByDate: a date missing from any index is dropped (exact alignment)", () => {
  const A=[{date:"1",close:100},{date:"2",close:100},{date:"3",close:110}];
  const B=[{date:"1",close:200},{date:"2",close:200},{date:"9",close:230}]; // no date "3"
  const m=avgIndexGainByDate([A,B],2);
  assert.equal(m.get("3"), undefined, "date present in A but not B must be omitted");
  assert.equal(m.size, 0);
});

// ─── 7) correctionLevels — TP adds the error buffer, SL takes the lesser ──────
test("correctionLevels: TP = entry + mag + err; SL = entry − min(mag, err)", () => {
  // err > mag → SL uses mag (the lesser).
  let lv=correctionLevels({entry:100, gainsPct:2, avgErr:3});
  assert.equal(lv.mag, 2);
  assert.equal(lv.tp, 105, "100 + 2 + 3");
  assert.equal(lv.sl, 98, "100 − min(2,3)=2");
  // mag > err → SL uses err (the lesser).
  lv=correctionLevels({entry:100, gainsPct:5, avgErr:2});
  assert.equal(lv.tp, 107, "100 + 5 + 2");
  assert.equal(lv.sl, 98, "100 − min(5,2)=2");
  // delta keeps the sign of the projected gain; mag is absolute.
  lv=correctionLevels({entry:100, gainsPct:-4, avgErr:1});
  assert.equal(lv.delta, -4);
  assert.equal(lv.mag, 4);
  assert.equal(lv.tp, 105, "100 + 4 + 1");
  assert.equal(lv.sl, 99, "100 − min(4,1)=1");
});

// ─── 8) backtestCorrection — full P&L + alpha + alpha-honest proven gate ──────
test("backtestCorrection: produces stats/alpha and an HONEST proven gate", () => {
  const data=gen(160);
  // A positive trailing-gain map over every aligned date (uptrend assumption).
  const gain=new Map(data.map(d=>[d.date, 1.5]));
  const r=backtestCorrection(data, gain, {period:20, costs:{slip:0.05,comm:0.05}});
  assert.ok(r, "expected a result object");
  assert.equal(typeof r.trades, "number");
  assert.ok(r.stats && typeof r.stats.expectancy==="number", "carries realized stats");
  assert.equal(typeof r.proven, "boolean");
  // The gate is exactly: ≥20 trades AND resolved AND positive mean alpha — never green otherwise.
  const sig=r.stats.significance;
  const expectGate = r.trades>=20 && (sig==="SIGNIFICANT"||sig==="SUGGESTIVE") && r.meanAlpha>0;
  assert.equal(r.proven, expectGate, "proven must equal the alpha-honest gate");
  if(r.proven){ assert.ok(r.meanAlpha>0, "proven implies positive alpha"); }
});

test("backtestCorrection: returns null without enough bars, and never trades on a null map", () => {
  assert.equal(backtestCorrection(gen(10), new Map(), {period:20}), null, "too few bars → null");
  assert.equal(backtestCorrection(gen(60), null, {period:20}), null, "no gain map → null");
  // An empty gain map yields no BUYs (every bar is HOLD) → zero trades, proven false.
  const r=backtestCorrection(gen(60), new Map(), {period:20});
  assert.ok(r, "empty map still returns a (descriptive) result");
  assert.equal(r.trades, 0);
  assert.equal(r.proven, false);
});

// ─── Market-regime notifier ("read the room") ────────────────────────────────

test("efficiencyRatio: a straight-line trend ≈ 1, a round-trip chop ≈ 0", () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);           // monotonic
  assert.ok(efficiencyRatio(up, 21) > 0.99, "clean trend → ER ~1");
  const chop = Array.from({ length: 30 }, (_, i) => 100 + (i % 2));    // up-down-up-down, no net move
  assert.ok(efficiencyRatio(chop, 21) < 0.1, "pure chop → ER ~0");
  assert.equal(efficiencyRatio([1, 2, 3], 21), null, "too few bars → null");
});

test("marketRegime: a rising trend reads BULL · TRENDING and favors trend-following", () => {
  const bars = Array.from({ length: 220 }, (_, i) => ({ close: 100 * Math.pow(1.004, i) }));  // steady climb
  const r = marketRegime(bars);
  assert.equal(r.direction, "BULL");
  assert.equal(r.trend, "TRENDING");
  assert.match(r.favored, /Trend-following/);
  assert.match(r.label, /BULL/);
});

test("marketRegime: a choppy, flat market reads RANGING and favors mean-reversion", () => {
  const bars = Array.from({ length: 220 }, (_, i) => ({ close: 100 + Math.sin(i / 2) * 3 }));  // oscillating, no trend
  const r = marketRegime(bars);
  assert.equal(r.trend, "RANGING");
  assert.match(r.favored, /Mean-reversion/);
});

test("marketRegime: a falling, volatile tape flags ELEVATED risk; <40 bars → null (honest)", () => {
  const bars = Array.from({ length: 220 }, (_, i) => ({ close: 200 - i * 0.5 + (i > 180 ? Math.sin(i) * 8 : 0) }));
  const r = marketRegime(bars);
  assert.equal(r.direction, "BEAR");
  assert.ok(r.risk && /headwind|ELEVATED/.test(r.risk));
  assert.equal(marketRegime(Array.from({ length: 20 }, () => ({ close: 100 }))), null, "too little history → null, not a guess");
});
