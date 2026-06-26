import { test } from "node:test";
import assert from "node:assert/strict";
import { convergenceEvents } from "./engine.mjs";
import { quantile, summarizeTiming, minutesPerBar } from "./convergence-timing-study.mjs";

// Reuse the engine-test fixture shape: an established uptrend → tight coil → breakout that
// passes the trend filter (so convergenceEvents detects ≥1 event with measurable timing).
function push(rows, c){ const close = +c.toFixed(4); rows.push({ date: "2025-01-01", open: close, high: close + 0.2, low: close - 0.2, close, volume: 1e6 }); }
function genTrendCoilBreak(){
  const rows = [];
  for(let i = 0; i < 60; i++) push(rows, 100 + i * 0.5);             // 60-bar uptrend → rising SMA50
  for(let i = 0; i < 24; i++) push(rows, 129.5 + (i % 2 ? 0.02 : -0.02)); // 24-bar coil
  for(let i = 1; i <= 25; i++) push(rows, 129.5 + i * 0.7);          // breakout
  return rows;
}

test("convergenceEvents: empty on too-short input", () => {
  assert.deepEqual(convergenceEvents([]), []);
  assert.deepEqual(convergenceEvents(genTrendCoilBreak().slice(0, 40)), []); // < 70 bars needed (trend filter)
});

test("convergenceEvents: detects the coil→breakout and records BOTH timing gaps", () => {
  const ev = convergenceEvents(genTrendCoilBreak(), { trendFilter: true });
  assert.ok(ev.length >= 1, "at least one breakout detected");
  for(const e of ev){
    assert.ok(Number.isInteger(e.barsSinceCoil) && e.barsSinceCoil >= 1 && e.barsSinceCoil <= 8,
      "pinch→breakout within the coilLookback cap (1..8)");
    assert.ok(Number.isInteger(e.formingBars) && e.formingBars >= 1,
      "forming→pinch counts the tight bars leading into the pinch");
    assert.ok(e.idx >= 0 && e.date != null, "carries the bar index + date for the timestamp");
  }
});

test("convergenceEvents: a wider coilLookback never tightens the pinch→breakout cap below the default", () => {
  const wide = convergenceEvents(genTrendCoilBreak(), { trendFilter: true, coilLookback: 20 });
  for(const e of wide) assert.ok(e.barsSinceCoil <= 20, "respects the configured cap");
});

test("quantile: linear-interpolated on a sorted array", () => {
  const s = [1, 2, 3, 4];
  assert.equal(quantile(s, 0.5), 2.5);
  assert.equal(quantile(s, 0.25), 1.75);
  assert.equal(quantile(s, 0), 1);
  assert.equal(quantile(s, 1), 4);
  assert.equal(quantile([], 0.5), null);
});

test("summarizeTiming: count, mean, quartiles, range, and a histogram", () => {
  const s = summarizeTiming([4, 2, 2, 3]); // sorts to [2,2,3,4]
  assert.equal(s.n, 4);
  assert.equal(s.mean, 2.75);
  assert.equal(s.median, 2.5);
  assert.equal(s.min, 2);
  assert.equal(s.max, 4);
  assert.deepEqual(s.hist, { 2: 2, 3: 1, 4: 1 });
  const empty = summarizeTiming([]);
  assert.equal(empty.n, 0);
  assert.equal(empty.median, null);
});

test("minutesPerBar: maps intraday resolutions; null for daily+", () => {
  assert.equal(minutesPerBar("15min"), 15);
  assert.equal(minutesPerBar("5min"), 5);
  assert.equal(minutesPerBar("1h"), 60);
  assert.equal(minutesPerBar("1day"), null);
  assert.equal(minutesPerBar("1week"), null);
});
