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
import { analyze, runBacktest, scoreAt, scorePosition, checkBarExit, checkBarExitFine, isAmbiguousBar, tradeNet, realizedStats, convergenceBreakout, convergenceForming, backtestPattern, edgeStatus, avgIndexGainByDate, correctionLevels, backtestCorrection, efficiencyRatio, marketRegime, regimeChecklist, guideBrief, stockStage, trendTemplate, workupChecklist, provenSummary, computeSignal, valueScore, divergenceFixed, recentTrend, patternsContext, correctedVotes, divergence, patterns, lineKinematics, headingEvent, esdProject, esdAccuracyBacktest } from "./engine.mjs";

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

// ─── 5b) FORMING-stage detector — the tightening squeeze BEFORE the breakout ──
test("convergenceForming: false on too-short input", () => {
  assert.equal(convergenceForming(genFlat(40)).forming, false);
});
test("convergenceForming: TRUE mid-coil — uptrend + ribbon tight + not yet popped", () => {
  // Truncate the trend→coil→breakout fixture INSIDE the coil (before the breakout bars).
  const cf = convergenceForming(genTrendCoilBreak().slice(0, 75));
  assert.equal(cf.forming, true, "the tightening ribbon in an uptrend should read FORMING");
  assert.ok(cf.barsForming >= 3, "the squeeze has persisted ≥ minFormingBars");
  assert.ok(Number.isInteger(cf.formingStartIdx) && cf.formingStartIdx >= 0, "marks where the tightening began");
  assert.ok(cf.tightness >= 0 && cf.tightness <= 1, "tightness is a 0..1 proximity-to-pinch");
});
test("convergenceForming: false once it has BROKEN OUT (that's a BREAKOUT, not FORMING)", () => {
  // The full fixture ends deep in the breakout — the ribbon has expanded, so FORMING is off.
  assert.equal(convergenceForming(genTrendCoilBreak()).forming, false);
});
test("convergenceForming: false on a flat base — no established uptrend", () => {
  assert.equal(convergenceForming(genFlat(120)).forming, false);
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

test("marketRegime: a genuinely choppy market reads RANGING and favors mean-reversion", () => {
  // True bar-to-bar chop (a sawtooth that reverses every bar) → ER ≈ 0.05, below the unambiguous-chop
  // floor → RANGING. (A smooth sine is NOT this: it's locally directional, so the relative classifier
  // correctly reads it TRANSITIONAL — that's the whole point of the daily-index recalibration.)
  const bars = Array.from({ length: 220 }, (_, i) => ({ close: 100 + (i % 2) * 2 }));
  const r = marketRegime(bars);
  assert.equal(r.trend, "RANGING");
  assert.match(r.favored, /Mean-reversion/);
});

test("marketRegime: a trend EMERGING from chop reads TRENDING at a mid-range ER (the daily-index fix)", () => {
  // 190 bars of chop (low ER baseline) then a noisy drift up. The recent 21-bar ER lands in the MID-RANGE
  // (~0.35) — BELOW the old absolute 0.45 TRENDING bar (so the old code mislabeled it), but well ABOVE the
  // market's own efficiency norm, so the relative classifier correctly calls it TRENDING.
  const bars = [];
  for (let i = 0; i < 190; i++) bars.push({ close: 100 + (i % 2) * 2 });   // choppy baseline
  let p = 100;
  for (let i = 0; i < 30; i++) { p += 0.3 + (i % 2 ? 0.8 : -0.8); bars.push({ close: p }); } // drift up, noisy
  const r = marketRegime(bars);
  assert.ok(r.er < 0.45, "absolute ER is mid-range, under the old TRENDING bar (er=" + r.er + ")");
  assert.equal(r.trend, "TRENDING");                                       // relative-to-own-norm catches it
});

test("marketRegime: a falling, volatile tape flags ELEVATED risk; <40 bars → null (honest)", () => {
  const bars = Array.from({ length: 220 }, (_, i) => ({ close: 200 - i * 0.5 + (i > 180 ? Math.sin(i) * 8 : 0) }));
  const r = marketRegime(bars);
  assert.equal(r.direction, "BEAR");
  assert.ok(r.risk && /headwind|ELEVATED/.test(r.risk));
  assert.equal(marketRegime(Array.from({ length: 20 }, () => ({ close: 100 }))), null, "too little history → null, not a guess");
});

// ─── guideBrief: the 🧑‍🏫 GUIDE coached read (pure, display-only) ──────────────

test("guideBrief: null analysis → null (safe empty state)", () => {
  assert.equal(guideBrief(null, null, {}), null);
  assert.equal(guideBrief(undefined, { label:"BULL" }, {}), null);
});

test("guideBrief: a SELL surfaces the SHORT setup as awareness (un-muted) but never as a trade", () => {
  const a = { signal:"SELL", score:-6, confidence:60,
    indicators:{ rsi:{v:45} }, confluence:{ bear:5 }, patterns:[], divergence:null };
  const g = guideBrief(a, null, {});
  assert.equal(g.here.muted, true, "SELL is muted under long-only");
  assert.ok(g.apply.short, "short awareness block present on a SELL");
  assert.equal(g.apply.short.score, -6);
  assert.match(g.apply.short.read, /NOT taken|long-only/, "framed as awareness, not a trade");
  // A merely-bearish HOLD (score ≤ −5) also surfaces the awareness, even without a SELL verdict.
  const bearishHold = guideBrief({ signal:"HOLD", score:-5, indicators:{}, confluence:{} }, null, {});
  assert.ok(bearishHold.apply.short, "score ≤ −5 surfaces the short read even on HOLD");
  // A neutral setup does not.
  assert.equal(guideBrief({ signal:"HOLD", score:1, indicators:{}, confluence:{} }, null, {}).apply.short, null);
});

test("guideBrief: a divided engine resolves to the regime-favored camp in the cliffs", () => {
  const a = { signal:"HOLD", score:0, indicators:{}, patterns:[], divergence:null,
    confluence:{ famConflict:true, meanRevDir:1, trendDir:-1 } };
  const ranging = guideBrief(a, { label:"BULL · RANGING", trend:"RANGING", favored:"Mean-reversion" }, {});
  assert.ok(ranging.cliffs.some(c => /DIVIDED/.test(c) && /mean-reversion/.test(c)), "RANGING ⇒ trust mean-reversion camp");
  const trending = guideBrief(a, { label:"BULL · TRENDING", trend:"TRENDING", favored:"Trend" }, {});
  assert.ok(trending.cliffs.some(c => /DIVIDED/.test(c) && /trend/.test(c)), "TRENDING ⇒ trust trend camp");
});

test("guideBrief: an intraday chart recommends switching to the DAILY swing timeframe", () => {
  const a = { signal:"BUY", score:5, indicators:{}, patterns:[], divergence:null, confluence:{} };
  const g = guideBrief(a, { label:"BULL", trend:"RANGING" }, { intraday:true, resLabel:"15-min" });
  assert.match(g.apply.resolution.rec, /DAILY/, "intraday ⇒ recommend DAILY");
  // A daily chart is confirmed, not redirected.
  const daily = guideBrief(a, { label:"BULL", trend:"RANGING" }, { intraday:false, resLabel:"Daily" });
  assert.equal(daily.apply.resolution.rec, "Daily");
});

test("guideBrief: oversold RSI yields a confirm-reversal watch item and an oversold cliffs note", () => {
  const a = { signal:"HOLD", score:0, confluence:{}, patterns:[], divergence:null,
    indicators:{ rsi:{v:22}, adx:{adx:30}, bb:{sig:"BULLISH",v:{lower:1}}, vol:{sig:"DIVERGING"} } };
  const g = guideBrief(a, { label:"BULL · RANGING", trend:"RANGING" }, {});
  const rsiItem = g.watch.find(w => w.key === "RSI");
  assert.ok(rsiItem && rsiItem.status === "confirm", "oversold RSI ⇒ confirm status");
  assert.match(rsiItem.action, /bounce/, "action coaches confirming the bounce");
  assert.ok(g.cliffs.some(c => /OVERSOLD/.test(c)), "oversold called out in the cliffs");
  assert.ok(g.watch.find(w => w.key === "ADX"), "ADX item present");
  assert.ok(g.watch.find(w => w.key === "VOL").status === "caution", "diverging volume ⇒ caution");
});

test("guideBrief: detected patterns and divergence surface in the formation; BUY routes to SIZE", () => {
  const a = { signal:"BUY", score:6, confidence:70, confluence:{},
    indicators:{ rsi:{v:55} },
    patterns:[{ name:"Bullish Engulfing", type:"BULLISH", desc:"reversal" }],
    divergence:{ type:"BULLISH", desc:"momentum building" } };
  const g = guideBrief(a, { label:"BULL · TRENDING", trend:"TRENDING", direction:"BULL" }, { mode:"tactical" });
  assert.equal(g.formation.patterns.length, 1);
  assert.equal(g.formation.divergence.type, "BULLISH");
  assert.ok(g.formation.nextWatch.length > 0);
  assert.equal(g.next.tab, "size", "an actionable BUY routes to the SIZE tab");
  // A muted/non-BUY routes to EVIDENCE instead.
  assert.equal(guideBrief({ ...a, signal:"SELL" }, null, {}).next.tab, "evidence");
});

// ─── Self-conflict family split (research angles C+F) ─────────────────────────

test("computeSignal exposes the mean-reversion vs trend family split and flags famConflict", () => {
  const base = { B:{lower:105,upper:110}, last:{close:100}, pats:[], div:null, volSig:"NEUTRAL", ADX:null, OBV:null, VWAP:null };
  // Mean-reversion camp BUYS (oversold RSI/Stoch + close below lower band) while the TREND camp SELLS
  // (MACD<0, fast<slow MAs, downtrend) → the engine fighting itself.
  const conflict = computeSignal({ ...base, R:20, S:10, M:{macd:-0.5}, s5:9, s10:10, s20:19, s50:20, trend:"DOWNTREND" });
  assert.equal(conflict.meanRevDir, 1, "RSI/Stoch oversold + below-band ⇒ mean-rev camp bullish");
  assert.equal(conflict.trendDir, -1, "MACD<0 + falling MAs + downtrend ⇒ trend camp bearish");
  assert.equal(conflict.famConflict, true, "opposite camps ⇒ self-conflict");
  // Both camps AGREE (everything bullish) → no family conflict.
  const aligned = computeSignal({ ...base, R:20, S:10, M:{macd:0.5}, s5:11, s10:10, s20:21, s50:20, trend:"UPTREND" });
  assert.equal(aligned.meanRevDir, 1);
  assert.equal(aligned.trendDir, 1);
  assert.equal(aligned.famConflict, false, "same-direction camps ⇒ aligned");
  // analyze() surfaces it on confluence (engine→app contract).
  const a = analyze(gen(160), "TST", "Stocks", "Trend Following", 1.5, 2.0);
  assert.ok("famConflict" in a.confluence && "trendDir" in a.confluence && "meanRevDir" in a.confluence);
});

test("computeSignal.icBackedShare = proven-vote share of the directional conviction (vote-weight test)", () => {
  const base = { last:{close:100}, pats:[], div:null, ADX:null, OBV:null, VWAP:null };
  // All-bullish: Trend (proven, w2) + Vol (proven, w1) vs MACD (dead, w2.5) → proven share = 3/5.5.
  const s = computeSignal({ ...base, R:null, S:null, M:{macd:0.5}, B:null, s5:11, s10:10, s20:21, s50:20,
    trend:"UPTREND", volSig:"CONFIRMING" });
  // Bullish drivers here: MACD(2.5), MA(1.5), MAlong(2), Trend(2), Vol(1) → proven = Trend+Vol = 3 of 9.
  assert.ok(s.icBackedShare > 0 && s.icBackedShare < 1, "share is a fraction, got " + s.icBackedShare);
  assert.ok(Math.abs(s.icBackedShare - (3 / 9)) < 1e-3, "Trend+Vol weight / total bullish driver weight (3 of 9, 3dp)");
  // No proven votes firing the signal's way → share 0.
  const none = computeSignal({ ...base, R:null, S:null, M:{macd:0.5}, B:null, s5:11, s10:10, s20:21, s50:20,
    trend:"SIDEWAYS", volSig:"NEUTRAL" });
  assert.equal(none.icBackedShare, 0, "no Trend/Vol/BB driver ⇒ 0 proven share");
});

test("computeSignal drop: removing a named vote excludes it from the team; absent vote is a no-op", () => {
  const base = { last:{close:100}, pats:[], div:null, ADX:null, OBV:null, VWAP:null, S:null, R:null, B:null };
  const ctx = { ...base, M:{macd:0.5}, s5:11, s10:10, s20:21, s50:20, trend:"UPTREND", volSig:"NEUTRAL" };
  const full = computeSignal(ctx);
  const noMacd = computeSignal(ctx, [], { drop:["MACD"] });
  assert.equal(full.bull - noMacd.bull, 1, "dropping the bullish MACD removes one bull vote");
  assert.ok(full.score !== noMacd.score, "dropping a contributing vote changes the weighted score");
  assert.equal(computeSignal(ctx, [], { drop:["NOPE"] }).score, full.score, "dropping an absent vote is a no-op");
  assert.equal(computeSignal(ctx, []).score, full.score, "empty opts is byte-identical to the default path");
});

test("analyze shadows: shadowDrops attaches per-config team-minus-vote verdicts; off by default", () => {
  const cfgs = [{ key:"shadow-noMacd", drop:["MACD"] }, { key:"shadow-noPat", drop:["Pat"] }];
  const a = analyze(gen(160), "TST", "Stocks", "Trend Following", 1.5, 2.0, { shadowDrops: cfgs });
  assert.ok(a.shadows, "shadows attached when requested");
  for (const c of cfgs) assert.ok(["BUY","HOLD","SELL"].includes(a.shadows[c.key]), c.key + " is a decision");
  assert.equal(analyze(gen(160), "TST", "Stocks", "Trend Following", 1.5, 2.0).shadows, null, "no opts ⇒ no shadows (zero overhead)");
});

// ─── valueScore: implausible-net-margin sanity guard (data-quality net) ──────
test("valueScore: drops an impossible net margin (>150%) and flags it, instead of scoring it as elite", () => {
  // NVDA-style bad TTM assembly produced npm ≈ 5.93 (593%) → scored healthy +2 ("highly profitable").
  const m = { roeTTM: 0.30, netProfitMarginTTM: 5.93, currentRatioAnnual: 2 };
  const vs = valueScore(m);
  assert.ok(vs.flags.some(f => /implausible/i.test(f)), "the implausible margin is flagged");
  // healthy = roe>0.15 (+2) + current ratio>1.5 (+1); the bad +2 margin must NOT be counted.
  assert.equal(vs.healthy, 3);
});

test("valueScore: a normal net margin still scores and is not flagged", () => {
  const vs = valueScore({ netProfitMarginTTM: 0.25 });            // 25% → +2, no flag
  assert.equal(vs.healthy, 2);
  assert.ok(!vs.flags.some(f => /implausible/i.test(f)));
});

test("valueScore: a legitimately high ROE (>100%) is untouched (low-equity/buyback names)", () => {
  const vs = valueScore({ roeTTM: 2.22 });                        // MA-style ROE → +2, no flag
  assert.equal(vs.healthy, 2);
  assert.ok(!vs.flags.some(f => /implausible/i.test(f)));
});

// ─── R5: corrected candidate votes (propose-only; never an in-sample re-wire) ──

// A bar helper for hand-crafted candle geometry.
const bar = (o,h,l,c,v=1e6) => ({date:"2025-01-01",open:o,high:h,low:l,close:c,volume:v});

test("recentTrend reads only the recent window (fixes whole-window staleness)", () => {
  // Whole series nets UP (100→…→150), but the recent 50 bars fall hard → DOWNTREND now.
  const closes=[]; for(let i=0;i<60;i++) closes.push(100+i);           // 100..159 (up)
  for(let i=0;i<50;i++) closes.push(159-i*1.5);                        // sharp recent decline
  const tr=recentTrend(closes,50);
  assert.equal(tr.dir,-1);
  assert.equal(tr.state,"DOWNTREND");
});

test("divergenceFixed kills the window-mismatch false signal a recent crash produced", () => {
  // Early decline (RSI low) → long rise (RSI climbs across the OLD window) → recent crash. The BUGGY
  // divergence reads the rising RSI from the pre-crash window and prints a false BULLISH bottom against
  // the crash's lower lows; the same-window fix reads RSI AFTER the crash (low) and does NOT.
  const data=[]; let p=100;
  for(let i=0;i<15;i++){ p-=1; data.push(p); }                         // early decline → low RSI
  for(let i=0;i<45;i++){ p+=1; data.push(p); }                         // long rise → RSI climbs in the old window
  for(let i=0;i<12;i++){ p-=4; data.push(p); }                         // recent crash → RSI now low
  const buggy=divergence(data);
  const fixed=divergenceFixed(data);
  assert.equal(buggy && buggy.type, "BULLISH");                        // the documented false signal
  assert.ok(!(fixed && fixed.type === "BULLISH"));                     // corrected: no false bottom
});

test("patternsContext honors a bullish reversal at a bottom, suppresses it at a top", () => {
  // Same Bullish-Engulfing geometry on the last two bars; only the surrounding TREND differs.
  const engB = bar(50,50.2,47.8,48);                                   // bearish
  const engC = bar(47,51.2,46.8,51);                                   // bullish engulf of engB
  const downA = bar(54,54.2,53.8,53.5);
  const down = [bar(60,60.1,59.9,60), bar(58,58.1,57.9,58), bar(56,56.1,55.9,56), downA, engB, engC];
  const upA = bar(45,46.2,44.8,46);
  const up   = [bar(40,40.1,39.9,40), bar(42,42.1,41.9,42), bar(44,44.1,43.9,44), upA, engB, engC];
  assert.equal(patternsContext(down).dir, 1);                          // bottom → honored
  assert.equal(patternsContext(up).dir, 0);                            // top → suppressed (context-aware)
});

test("patternsContext collapses multiple patterns into a single net vote (no stacking)", () => {
  // Three White Soldiers + Bullish Engulfing can both fire on the same bars; corrected = one net vote.
  const s=[bar(40,40.2,39.8,40.1),bar(40,41,39.5,41),bar(40.5,42.5,40,42),bar(42,44.5,41.5,44)];
  const r=patternsContext(s);
  assert.ok(r.dir===1 || r.dir===0);                                   // never >1; a single collapsed vote
});

test("correctedVotes emits DivFix/TrendFix/PatFix with the originals' weights", () => {
  const down=[bar(60,60.1,59.9,60),bar(58,58.1,57.9,58),bar(56,56.1,55.9,56),
              bar(54,54.2,53.8,53.5),bar(50,50.2,47.8,48),bar(47,51.2,46.8,51)];
  const cv=correctedVotes(down.map(d=>d.close), down);
  const byName=Object.fromEntries(cv.map(v=>[v.n,v]));
  assert.equal(byName.TrendFix.w, 2);
  assert.equal(byName.TrendFix.dir, -1);                              // recent decline
  assert.equal(byName.PatFix.w, 1.5);
  assert.equal(byName.PatFix.dir, 1);                                 // bullish reversal at a bottom
  assert.ok(!("DivFix" in byName));                                   // <25 bars → no divergence read
});

test("scoreAt default path is byte-identical (corrected is opt-in)", () => {
  const s=gen(120);
  assert.deepEqual(scoreAt(s), scoreAt(s, null, false));              // additive arg never changes default
  const corr=scoreAt(s, null, true);
  assert.ok(corr && ["BUY","SELL","HOLD"].includes(corr.signal));    // corrected team still produces a verdict
});

test("analyze shadow-corrected config drops Div/Trend/Pat and injects the corrected forms", () => {
  const s=gen(120);
  const a=analyze(s,"TEST","SPY","tactical",1.5,2.0,
    { shadowDrops:[{key:"shadow-corrected",drop:["Div","Trend","Pat"],corrected:true}] });
  assert.ok(a.shadows && ["BUY","SELL","HOLD"].includes(a.shadows["shadow-corrected"]));
  // The live verdict is untouched by the shadow computation.
  assert.equal(a.signal, analyze(s,"TEST","SPY","tactical",1.5,2.0).signal);
});

// ─── regimeChecklist — actionable VERIFY/CONFIRM preflight (display-only) ──────

test("regimeChecklist: null regime → empty list", () => {
  assert.deepEqual(regimeChecklist(null), []);
});

test("regimeChecklist: BULL·RANGING·NORMAL maps each line to a verifiable fact + action", () => {
  const g={ direction:"BULL", trend:"RANGING", vol:"NORMAL", er:0.07, approxMA:false,
            favored:"Mean-reversion — oversold bounces (RSI / Stoch / BB) are favored",
            cautioned:"Breakouts: likely bull-traps; trend votes misfire in chop", risk:null, label:"BULL · RANGING" };
  const cl=regimeChecklist(g,{resLabel:"Daily",intraday:false});
  assert.deepEqual(cl.map(i=>i.key), ["A","B","C","D"]);                 // four lettered lines
  const A=cl.find(i=>i.key==="A"), B=cl.find(i=>i.key==="B"), C=cl.find(i=>i.key==="C"), D=cl.find(i=>i.key==="D");
  assert.equal(A.label,"DIRECTION"); assert.equal(A.status,"confirm");   // BULL = tailwind
  assert.equal(B.label,"MODE");      assert.equal(B.status,"confirm");   // RANGING is a decisive mode
  assert.match(B.value, /ER 0\.07/);                                     // ER surfaced on the MODE line
  assert.ok(B.action.includes("Mean-reversion"));                       // toolkit folded into the action
  assert.equal(C.label,"VOLATILITY"); assert.equal(C.status,"confirm");  // NORMAL vol → standard size
  assert.equal(D.label,"HORIZON");   assert.equal(D.status,"confirm");   // daily chart matches the daily regime
  assert.ok(D.action.includes("matches"));
});

test("regimeChecklist: an INTRADAY chart flips the HORIZON line to VERIFY with the timeframe", () => {
  const g={ direction:"BULL", trend:"TRENDING", vol:"NORMAL", er:0.6, approxMA:false,
            favored:"Trend-following is reliable here", cautioned:"Mean-reversion fights the tape", risk:null, label:"BULL · TRENDING" };
  const D=regimeChecklist(g,{resLabel:"15-min",intraday:true}).find(i=>i.key==="D");
  assert.equal(D.status,"verify");                                       // mismatch must be flagged, not silent
  assert.match(D.value, /15-min/);
  assert.ok(D.action.includes("INTRADAY") && D.action.includes("swing"));
});

test("regimeChecklist: BEAR + STORMY raise DIRECTION/VOLATILITY to caution", () => {
  const g={ direction:"BEAR", trend:"TRANSITIONAL", vol:"STORMY", er:0.3, approxMA:true,
            favored:"Mixed — demand stronger confluence", cautioned:"Single-signal conviction is risky", risk:"ELEVATED — bear + high volatility: reduce size.", label:"BEAR · TRANSITIONAL" };
  const cl=regimeChecklist(g);
  assert.equal(cl.find(i=>i.key==="A").status,"caution");               // BEAR headwind
  assert.equal(cl.find(i=>i.key==="C").status,"caution");               // STORMY → trim size
  assert.equal(cl.find(i=>i.key==="B").status,"verify");                // TRANSITIONAL is unresolved
  assert.match(cl.find(i=>i.key==="A").value, /\(≈\)/);                 // approxMA surfaced honestly
});

// ─── THE WORK-UP — stockStage / trendTemplate / workupChecklist / provenSummary ───
// Pure expert reads + the 9-step conductor. Display-only: never recompute a signal, never touch a gate.
// Deterministic OHLC ramps (no RNG) so stage / template boundaries are exact.
function ramp(n, slope, start=100){
  const rows=[];
  for(let i=0;i<n;i++){ const close=+(start+slope*i).toFixed(4);
    rows.push({date:"2025-01-01", open:close, high:+(close+1).toFixed(4), low:+(close-1).toFixed(4), close, volume:1000000}); }
  return rows;
}

test("stockStage: rising series above a rising MA → Stage 2 (confirm)", () => {
  const s=stockStage(ramp(252,0.5));
  assert.equal(s.stage,2); assert.equal(s.status,"confirm");
  assert.equal(s.maRising,true); assert.equal(s.priceAboveMA,true); assert.equal(s.approx,false);
});
test("stockStage: falling series below a falling MA → Stage 4 (caution)", () => {
  const s=stockStage(ramp(252,-0.3,200));
  assert.equal(s.stage,4); assert.equal(s.status,"caution"); assert.equal(s.priceAboveMA,false);
});
test("stockStage: flat series → Stage 1 (basing)", () => {
  const s=stockStage(ramp(60,0));
  assert.equal(s.stage,1);
});
test("stockStage: <30 bars → honest nodata", () => {
  const s=stockStage(ramp(20,0.5));
  assert.equal(s.status,"nodata"); assert.equal(s.stage,null); assert.equal(s.approx,true);
});
test("stockStage: <150 bars but ≥30 → approx flagged, still reads a stage", () => {
  const s=stockStage(ramp(120,0.5));
  assert.equal(s.approx,true); assert.equal(s.stage,2);                 // slope window fits → Stage 2 still readable
});

test("trendTemplate: clean uptrend (252 bars) → PASS, all applicable", () => {
  const t=trendTemplate(ramp(252,0.5));
  assert.equal(t.overall,"PASS"); assert.equal(t.status,"confirm");
  assert.equal(t.applicable,8); assert.equal(t.passedCount,8);
});
test("trendTemplate: downtrend → FAIL", () => {
  const t=trendTemplate(ramp(252,-0.3,200));
  assert.equal(t.overall,"FAIL"); assert.equal(t.status,"caution");
});
test("trendTemplate: 120 bars → MA-stack checks null (counted out, never failed), no crash", () => {
  const t=trendTemplate(ramp(120,0.5));
  assert.equal(t.checks.find(c=>c.key==="3").pass,null);               // 150>200 needs 200 bars
  assert.equal(t.checks.find(c=>c.key==="4").pass,null);               // 200MA-rising needs 220+
  assert.ok(t.applicable<8);                                           // nulls excluded from the denominator
  assert.notEqual(t.overall,"NODATA");
});
test("trendTemplate: <50 bars → NODATA", () => {
  assert.equal(trendTemplate(ramp(40,0.5)).overall,"NODATA");
});

const BUY_ANALYSIS={ signal:"BUY", rr:2.5, entry:100, sl:96, tp1:110, confluence:{} };
const FULL_CTX={
  analysis:BUY_ANALYSIS,
  regime:{ direction:"BULL", label:"BULL · TRENDING" },
  stage:{ stage:2, read:"advancing" },
  template:{ overall:"PASS", passedCount:8, applicable:8, read:"leader" },
  fundamentals:{ grade:"A", verdict:"strong" },
  proven:{ provenAny:false, label:"NOT YET PROVEN", detail:"no proof yet" },
  sizing:{ posSize:100, riskPct:1, capped:false, maxPosPct:20 },
  company:{ name:"Test Co", industry:"Software" },
};
test("workupChecklist: full clean BUY ctx → technical steps pass, but PROVEN gate stays caution", () => {
  const w=workupChecklist(FULL_CTX);
  assert.equal(w.steps.length,9);
  assert.equal(w.steps.find(s=>s.n===1).status,"pass");                // market BULL
  assert.equal(w.steps.find(s=>s.n===3).status,"pass");                // Stage 2 + template PASS
  assert.equal(w.steps.find(s=>s.n===4).status,"pass");                // grade A
  assert.equal(w.steps.find(s=>s.n===7).status,"pass");                // R:R 2.5
  assert.equal(w.steps.find(s=>s.n===8).status,"pass");                // sized, not capped
  assert.equal(w.steps.find(s=>s.n===6).status,"caution");             // PROVEN edge — independent of the boxes
  assert.equal(w.passCount,5); assert.equal(w.techPassCount,4);        // {1,3,7,8}
});
test("workupChecklist: HONESTY INVARIANT — all technical boxes green, edge still NOT PROVEN", () => {
  const w=workupChecklist(FULL_CTX);
  assert.equal(w.steps[5].status,"caution");                           // step 6 (index 5)
  assert.match(w.summary,/NOT PROVEN/);                                // the summary refuses to imply a trade
});
test("workupChecklist: empty ctx → no throw, nothing passes, PROVEN stays caution", () => {
  const w=workupChecklist({});
  assert.equal(w.passCount,0);
  assert.equal(w.steps.find(s=>s.n===6).status,"caution");             // no evidence → honest default
  assert.ok(w.steps.every(s=>["nodata","info","caution"].includes(s.status)));
});
test("workupChecklist: HOLD verdict → plan step is info (long-only stand-aside), not a fail", () => {
  const w=workupChecklist({ ...FULL_CTX, analysis:{ signal:"HOLD", rr:0 } });
  assert.equal(w.steps.find(s=>s.n===7).status,"info");
});
test("workupChecklist: intraday → stage step forced to nodata (multi-week read)", () => {
  const w=workupChecklist({ ...FULL_CTX, intraday:true });
  assert.equal(w.steps.find(s=>s.n===3).status,"nodata");
  assert.match(w.steps.find(s=>s.n===3).value,/INTRADAY/);
});

test("provenSummary: a promotable variant → provenAny true; none → candidate label", () => {
  assert.equal(provenSummary({variants:[{promotable:false},{promotable:true}]}).provenAny,true);
  assert.equal(provenSummary({variants:[{promotable:false}]}).provenAny,false);
  assert.equal(provenSummary({variants:{a:{promotable:true}}}).provenAny,true);   // keyed-object form
  assert.match(provenSummary(null).label,/NOT YET PROVEN/);
});

// ─── ESD (Estimated Stock Destination) — SMA20 heading projection (display-only) ──
function risingBars(n, step=1, base=100){
  const r=[]; for(let i=0;i<n;i++){ const c=base+i*step; r.push({open:c-0.3,high:c+0.5,low:c-0.5,close:c,date:"d"+i,volume:1000}); } return r;
}
function fallingBars(n, step=1, base=240){
  const r=[]; for(let i=0;i<n;i++){ const c=base-i*step; r.push({open:c+0.3,high:c+0.5,low:c-0.5,close:c,date:"d"+i,volume:1000}); } return r;
}

test("lineKinematics: a steadily rising line reads up with positive slope/lift/angle; short series → null", () => {
  const series=Array.from({length:31},(_,i)=>100+i);     // slope 1/bar
  const k=lineKinematics(series,20,2);
  assert.equal(k.dir,"up");
  assert.ok(k.slopePerBar>0 && k.lift>0 && k.angleDeg>0);
  assert.equal(lineKinematics([1,2,3],20,2),null);       // fewer than W+1 points
});

test("lineKinematics: ATR-normalized angle is scale-invariant (wider ATR → flatter degree)", () => {
  const series=Array.from({length:31},(_,i)=>100+i);
  const tight=lineKinematics(series,20,2).angleDeg;
  const wide =lineKinematics(series,20,8).angleDeg;
  assert.ok(wide<tight && wide>0);                       // same slope, wider ATR → smaller angle
});

test("headingEvent: SMA20 below the fast pack and rising = below/up, separated; point-in-time (no lookahead)", () => {
  const bars=risingBars(45);
  const ev=headingEvent(bars, bars.length-1, {});
  assert.equal(ev.side,"below");                         // in an uptrend SMA20 lags below the faster MAs
  assert.equal(ev.leaning,"up");
  assert.equal(ev.separated,true);
  const trimmed=headingEvent(bars.slice(0,36), 35, {});  // evaluating at bar 35 must ignore bars after 35
  const same   =headingEvent(bars, 35, {});
  assert.deepEqual(same, trimmed);
});

test("esdProject: up-lean targets the nearest level ABOVE (tp1); a rising ray with no level above is invalid", () => {
  const bars=risingBars(45);
  const s20=headingEvent(bars,bars.length-1,{}).s20;
  const up=esdProject(bars,{tp1:s20+5, sl:s20-5},{});
  assert.equal(up.valid,true);
  assert.equal(up.leaning,"up");
  assert.equal(up.targetName,"tp1");
  assert.ok(up.etaBars>0 && up.ray && up.ray.y1===up.targetPrice);
  const noAbove=esdProject(bars,{sl:s20-5},{});          // rising ray, only a level below → no destination
  assert.equal(noAbove.valid,false);
});

test("esdProject: down-lean targets the nearest level BELOW (sl)", () => {
  const bars=fallingBars(45);
  const s20=headingEvent(bars,bars.length-1,{}).s20;
  const dn=esdProject(bars,{sl:s20-5, support:s20-10},{});
  assert.equal(dn.leaning,"down");
  assert.equal(dn.valid,true);
  assert.equal(dn.targetName,"sl");
  assert.ok(dn.etaBars>0);
});

test("esdAccuracyBacktest: returns honest stats + a boolean proven (never green by construction)", () => {
  const r=esdAccuracyBacktest(risingBars(120),{});
  assert.ok(r && r.n>0);
  assert.equal(typeof r.proven,"boolean");
  assert.ok(typeof r.trades==="number" && r.trades>=0);
  assert.ok(r.avgErr==null || r.avgErr>=0);
});
