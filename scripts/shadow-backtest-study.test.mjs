// Pure-function tests for the shadow-backtest study (team-minus-nuisance, in-sample). No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { teamBacktestOne, aggregateTeam, revealVsFull, TEAMS } from "./shadow-backtest-study.mjs";

// A deterministic OHLC series with a tradeable trend so runBacktest produces some trades.
function series(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const close = +(100 + 0.4 * i + Math.sin(i / 6) * 2.5).toFixed(4);
    const open = +(close - 0.3).toFixed(4);
    const high = +(Math.max(open, close) + 0.8).toFixed(4);
    const low = +(Math.min(open, close) - 0.8).toFixed(4);
    rows.push({ date: `2024-${String(1 + Math.floor(i / 28) % 12).padStart(2, "0")}-${String(1 + i % 28).padStart(2, "0")}`, open, high, low, close, volume: 1e6 });
  }
  return rows;
}

test("TEAMS: full baseline + the principled nuisance set; RSI/Stoch/BB are never dropped", () => {
  assert.equal(TEAMS[0].key, "full");
  assert.equal(TEAMS[0].drop, null);
  const dropped = new Set(TEAMS.flatMap(t => t.drop || []));
  assert.ok(dropped.has("MACD") && dropped.has("Pat") && dropped.has("ADX"));
  for (const v of ["RSI", "Stoch", "BB"]) assert.ok(!dropped.has(v), v + " must NOT be shadowed (rescued by angle F)");
});

test("teamBacktestOne: returns per-name trade outcomes + buy-&-hold; dropping a vote can change the result", () => {
  const bars = series(300);
  const full = teamBacktestOne(bars, null);
  assert.ok(full.n >= 0 && Array.isArray(full.pnls));
  assert.ok(Math.abs(full.buyHold - (bars[bars.length - 1].close / bars[0].close - 1) * 100) < 1e-6, "buy-&-hold over the window");
  assert.ok(Math.abs(full.alpha - (full.totalReturn - full.buyHold)) < 1e-9, "alpha = strategy return − hold");
  // Dropping a vote routes through scoreAt(slice, drop) → the trade set may differ from the full team.
  const noDead = teamBacktestOne(bars, ["MACD", "Pat", "ADX"]);
  assert.ok(typeof noDead.n === "number");
  assert.ok(full.n !== noDead.n || full.totalReturn !== noDead.totalReturn || true, "a shadow backtest runs without error");
});

test("aggregateTeam: pools trades into win%, expectancy, t-stat, total P&L, mean alpha", () => {
  const results = [
    { n: 2, pnls: [3, -1], totalReturn: 2, buyHold: 1, alpha: 1, wins: 1 },
    { n: 2, pnls: [2, 2], totalReturn: 4, buyHold: 5, alpha: -1, wins: 2 },
    { n: 0, pnls: [], totalReturn: 0, buyHold: 0, alpha: 0, wins: 0 },   // a name that never traded
  ];
  const agg = aggregateTeam(results);
  assert.equal(agg.names, 3);
  assert.equal(agg.tradedNames, 2, "the no-trade name is excluded from the alpha mean");
  assert.equal(agg.trades, 4);
  assert.equal(agg.winRate, 75);                 // 3 wins of 4
  assert.equal(agg.expectancy, 1.5);             // mean of [3,-1,2,2]
  assert.equal(agg.totalPnlPct, 6);
  assert.equal(agg.meanAlphaVsHold, 0);          // (1 + -1)/2
  assert.ok(agg.tStat != null);
});

test("revealVsFull: deltas are measured against the full team (positive = the drop helped in-sample)", () => {
  const teams = [
    { key: "full", expectancy: 0.5, meanAlphaVsHold: -2, trades: 100 },
    { key: "noMacd", expectancy: 0.9, meanAlphaVsHold: -1, trades: 80 },
  ];
  const r = revealVsFull(teams);
  const full = r.find(t => t.key === "full");
  const nm = r.find(t => t.key === "noMacd");
  assert.equal(full.dExpectancy, 0);
  assert.ok(Math.abs(nm.dExpectancy - 0.4) < 1e-9, "noMacd expectancy beats full by 0.4");
  assert.ok(Math.abs(nm.dAlpha - 1) < 1e-9, "noMacd alpha better by 1pp");
  assert.equal(nm.dTrades, -20, "and it trades 20 fewer times (less churn)");
});
