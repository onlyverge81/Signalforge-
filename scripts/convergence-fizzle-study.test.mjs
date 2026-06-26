import { test } from "node:test";
import assert from "node:assert/strict";
import { convergenceFizzle } from "./engine.mjs";
import { conversionRate } from "./convergence-fizzle-study.mjs";

function push(rows, c){ const close = +c.toFixed(4); rows.push({ date: "2025-01-01", open: close, high: close + 0.2, low: close - 0.2, close, volume: 1e6 }); }
// Uptrend → long tight coil → UPWARD breakout (the coil CONVERTS).
function genTrendCoilBreak(){
  const rows = [];
  for(let i = 0; i < 60; i++) push(rows, 100 + i * 0.5);
  for(let i = 0; i < 24; i++) push(rows, 129.5 + (i % 2 ? 0.02 : -0.02));
  for(let i = 1; i <= 25; i++) push(rows, 129.5 + i * 0.7);
  return rows;
}
// Uptrend → long tight coil → sharp DROP (ribbon widens DOWN, no up-breakout → the coil FIZZLES).
function genCoilFizzle(){
  const rows = [];
  for(let i = 0; i < 60; i++) push(rows, 100 + i * 0.5);
  for(let i = 0; i < 24; i++) push(rows, 129.5 + (i % 2 ? 0.02 : -0.02));
  for(let i = 1; i <= 14; i++) push(rows, 129.5 - i * 0.7);
  return rows;
}

test("convergenceFizzle: empty/too-short input → no episodes", () => {
  const f = convergenceFizzle([]);
  assert.equal(f.flags, 0);
  assert.deepEqual(f.episodes, []);
});

test("convergenceFizzle: a coil that pops is CONVERTED (breakout), never a fizzle", () => {
  const f = convergenceFizzle(genTrendCoilBreak(), { trendFilter: true });
  assert.ok(f.flags >= 1, "the tightening coil should raise a FORMING flag");
  assert.ok(f.converted >= 1, "and it should resolve as a breakout");
  // every episode carries a valid outcome + a 0..1 maxTightness
  for(const e of f.episodes){
    assert.ok(["breakout", "fizzle", "censored"].includes(e.outcome));
    assert.ok(e.maxTightness >= 0 && e.maxTightness <= 1);
    assert.ok(e.resBars >= 0);
  }
});

test("convergenceFizzle: a coil that loosens/reverses with no pop is a FIZZLE", () => {
  const f = convergenceFizzle(genCoilFizzle(), { trendFilter: true });
  assert.ok(f.flags >= 1, "the tightening coil should raise a FORMING flag");
  assert.ok(f.fizzled >= 1, "and with no upward breakout it should fizzle");
  assert.equal(f.converted, 0, "no breakout occurred");
});

test("convergenceFizzle: flags partition into breakout + fizzle + censored", () => {
  const f = convergenceFizzle(genTrendCoilBreak(), { trendFilter: true });
  assert.equal(f.converted + f.fizzled + f.censored, f.flags);
});

test("conversionRate: breakouts ÷ resolved; null when nothing resolved", () => {
  assert.equal(conversionRate(3, 1), 0.75);
  assert.equal(conversionRate(0, 4), 0);
  assert.equal(conversionRate(0, 0), null);
});
