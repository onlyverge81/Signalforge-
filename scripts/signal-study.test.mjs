// Offline unit tests for the signal-study harness — no network.
// Pins the pure helpers and an end-to-end backtest→segment pass on a synthetic series.

import { test } from "node:test";
import assert from "node:assert/strict";
import { segment, buyHoldPct } from "./signal-study.mjs";
import { runBacktest, scoreAt } from "./engine.mjs";

test("buyHoldPct: close-to-close return in percent", () => {
  const c = [{close:100},{close:50},{close:110}];
  assert.equal(buyHoldPct(c), 10);              // 110/100 - 1
  assert.equal(buyHoldPct([{close:100}]), null); // too short
  assert.equal(buyHoldPct([{close:0},{close:5}]), null); // bad base
});

test("segment: groups trades by key and runs identical stats per group", () => {
  const trades = [
    { dir:"BUY",  result:"WIN",  pnlPct: 2, grossPct: 2 },
    { dir:"BUY",  result:"WIN",  pnlPct: 1, grossPct: 1 },
    { dir:"SELL", result:"LOSS", pnlPct:-3, grossPct:-3 },
  ];
  const byDir = segment(trades, t => t.dir);   // returns full realizedStats per group
  assert.equal(byDir.BUY.total, 2);
  assert.equal(byDir.BUY.wins, 2);
  assert.equal(byDir.BUY.winRate, 100);
  assert.equal(byDir.SELL.total, 1);
  assert.equal(byDir.SELL.winRate, 0);
  assert.ok(Math.abs(byDir.BUY.expectancy - 1.5) < 1e-9); // (2+1)/2
});

// Deterministic OHLC series (mirrors engine.test's generator) so the backtest runs.
function gen(n){
  const rows=[]; let p=100;
  for(let i=0;i<n;i++){
    const drift=0.25, wig=Math.sin(i/5)*1.5 + Math.cos(i/11)*0.8;
    const close=+(p + drift*i + wig).toFixed(4);
    const open=+(close - Math.sin(i/7)*0.5).toFixed(4);
    const high=+(Math.max(open,close)+Math.abs(Math.cos(i/3))*0.9+0.3).toFixed(4);
    const low=+(Math.min(open,close)-Math.abs(Math.sin(i/4))*0.9-0.3).toFixed(4);
    rows.push({date:`2025-01-${String(1+i%28).padStart(2,"0")}`,open,high,low,close,volume:1e6});
  }
  return rows;
}

test("integration: runBacktest → pooled segment by direction is consistent", () => {
  const bt = runBacktest(gen(200), scoreAt, 1.5, 2.0, {slip:0.05, comm:0.05}, null, false);
  assert.ok(bt.trades.length > 0, "expected some trades on the synthetic series");
  const byDir = segment(bt.trades, t => t.dir);
  // every bucket's trade count must sum back to the whole
  const summed = Object.values(byDir).reduce((a,s)=>a+s.total, 0);
  assert.equal(summed, bt.trades.length);
  // pooled win count across buckets equals the backtest's win tally
  const wins = Object.values(byDir).reduce((a,s)=>a+s.wins, 0);
  assert.equal(wins, bt.stats.wins);
});
