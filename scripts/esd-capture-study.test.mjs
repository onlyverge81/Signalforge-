// Offline unit tests for the ESD capture study's pure measurement — no network.
// Locks: a below→up SMA20 launch is detected with a positive lead; a flat series fires no event;
// the measurement is point-in-time (truncating bars after the move can't change the detected event).

import { test } from "node:test";
import assert from "node:assert/strict";
import { measureName } from "./esd-capture-study.mjs";

function bars(closes){ return closes.map((c, i) => ({ t: i * 864e5, open: c - 0.1, high: c + 0.2, low: c - 0.2, close: c, volume: 1000 })); }

// 45 nearly-flat bars then a launch — the SMA20 separates below the fast pack and leans up.
function launchSeries(){
  const cl = []; let p = 100;
  for (let i = 0; i < 45; i++){ p += 0.02; cl.push(p); }
  for (let i = 0; i < 45; i++){ p += 1.2; cl.push(p); }
  return bars(cl);
}

test("measureName: detects the below→up launch with a positive lead and a stable angle", () => {
  const m = measureName(launchSeries());
  assert.equal(m.event, true);
  assert.equal(m.reached, true);
  assert.ok(m.leadBars > 0 && m.leadHours > 0);
  assert.ok(m.flipRate === 0 || m.flipRate < 0.5);     // a clean launch should not whipsaw
  assert.ok(m.launchSlope > 0);                         // SMA20 leaning up at the event
});

test("measureName: a flat series fires no event", () => {
  const flat = bars(Array.from({ length: 90 }, () => 100));
  assert.equal(measureName(flat).event, false);
});

test("measureName: point-in-time — truncating bars AFTER the event can't change the detected event start", () => {
  const full = launchSeries();
  const mFull = measureName(full);
  // Cut the series a few bars past where the move becomes obvious; the event detection must be identical.
  const cut = full.slice(0, 45 + (mFull.leadBars || 0) + 3);
  const mCut = measureName(cut);
  assert.equal(mCut.event, true);
  assert.equal(mCut.flipRate, mFull.flipRate);          // same point-in-time event window
});
