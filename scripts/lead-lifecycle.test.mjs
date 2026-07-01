// Offline unit tests for the lead lifecycle "flight timer" — no network.
// Locks: resMinutes lookup, the launch anchors (convLaunchMs walk-back, esdLaunchMs current-run start),
// and leadPhase's rocket phases (Launched → Boosters → Boosters fell off → Angling to coast → Expired),
// the `expired` flag past max-life, unknown-anchor safety, and cfg overrides (so study medians can feed it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { resMinutes, convLaunchMs, esdLaunchMs, leadPhase } from "./engine.mjs";

const MIN = 60000;

test("resMinutes maps Polygon resolutions (1day = 390 trading minutes), defaults to 60", () => {
  assert.equal(resMinutes("15min"), 15);
  assert.equal(resMinutes("1hour"), 60);
  assert.equal(resMinutes("1day"), 390);
  assert.equal(resMinutes("bogus"), 60);
});

test("convLaunchMs walks back barsSinceCoil from the detection bar", () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({ time: i * 1000, close: 100 }));
  assert.equal(convLaunchMs(bars, 25, 6), 19000);       // 25-6 = index 19 → time 19000
  assert.equal(convLaunchMs(bars, 3, 10), 0);           // clamps at 0
  assert.equal(convLaunchMs(bars, 10, 0), 10000);       // no coil offset → detection bar
  assert.equal(convLaunchMs([], 5, 2), null);
  assert.equal(convLaunchMs(bars, null, 2), null);
});

test("esdLaunchMs returns the start of the current below→up separation run, else the last bar", () => {
  // flat base then a clean rising ramp → SMA20 separates below→up during the ramp
  const bars = []; let p = 100, i = 0;
  for (; i < 30; i++) bars.push({ time: i * 1000, close: p });
  for (let k = 0; k < 40; k++, i++){ p += 0.8; bars.push({ time: i * 1000, close: p }); }
  const launch = esdLaunchMs(bars, {});
  assert.ok(launch != null);
  assert.ok(launch < bars[bars.length - 1].time, "launch is earlier than the last bar (a real run start)");
  assert.ok(launch >= 30 * 1000, "launch lands in the ramp, not the flat base");
  // a series that never fires the fingerprint → anchor at the last bar
  const flat = Array.from({ length: 40 }, (_, j) => ({ time: j * 1000, close: 100 }));
  assert.equal(esdLaunchMs(flat, {}), 39000);
  assert.equal(esdLaunchMs([{ time: 1, close: 1 }], {}), null); // too short
});

test("leadPhase — ESD rocket phases scale with the lead's ETA, and expire past ~1.5× ETA", () => {
  const now = 1e9;
  const esd = ageBars => ({ esd: { etaBars: 7 }, launchMs: now - ageBars * 60 * MIN, resolution: "1hour" });
  assert.equal(leadPhase(esd(0.5), now).phase, "launched");   // ≤1 bar
  assert.equal(leadPhase(esd(2),   now).phase, "boosters");   // ≤0.5·eta = 3.5 bars
  assert.equal(leadPhase(esd(4),   now).phase, "fell_off");   // ≤0.85·eta = 5.95 bars
  assert.equal(leadPhase(esd(6.5), now).phase, "coast");      // ≤1.5·eta = 10.5 bars
  const exp = leadPhase(esd(11), now);
  assert.equal(exp.phase, "expired");
  assert.equal(exp.expired, true);
  // icons/labels present
  assert.equal(leadPhase(esd(0.5), now).icon, "🔔");
  assert.equal(leadPhase(esd(11), now).label, "EXPIRED");
});

test("leadPhase — convergence uses the measured burst/peak/day defaults (15min)", () => {
  const now = 1e9;
  const cv = ageBars => ({ conv: { detected: true }, launchMs: now - ageBars * 15 * MIN, resolution: "15min" });
  const opt = { kind: "convergence" };
  assert.equal(leadPhase(cv(0.5), now, opt).phase, "launched");   // ≤1 bar
  assert.equal(leadPhase(cv(4),   now, opt).phase, "boosters");   // ≤8 bars (pinch burst)
  assert.equal(leadPhase(cv(10),  now, opt).phase, "fell_off");   // ≤13 bars (H13 peak)
  assert.equal(leadPhase(cv(20),  now, opt).phase, "coast");      // ≤26 bars (~1 trading day)
  assert.equal(leadPhase(cv(30),  now, opt).expired, true);       // > 26 bars → expired
});

test("leadPhase — cfg overrides the durations (study medians can feed the thresholds)", () => {
  const now = 1e9;
  const cv = ageBars => ({ conv: {}, launchMs: now - ageBars * 15 * MIN });
  // shrink the burst to 3 bars → age 4 is now past boosters
  assert.equal(leadPhase(cv(4), now, { kind: "convergence", burstBars: 3, peakBars: 6, maxLifeBars: 10 }).phase, "fell_off");
  assert.equal(leadPhase(cv(12), now, { kind: "convergence", burstBars: 3, peakBars: 6, maxLifeBars: 10 }).expired, true);
});

test("leadPhase — unknown anchor and null inputs are safe", () => {
  assert.equal(leadPhase({ esd: { etaBars: 7 } }, 1e9).phase, "unknown");   // no launchMs/lastBarMs
  assert.equal(leadPhase(null, 1e9), null);
  assert.equal(leadPhase({ launchMs: 1 }, null), null);
  // falls back to lastBarMs when launchMs absent (age 2 bars → boosters, proving the fallback anchor is used)
  assert.equal(leadPhase({ lastBarMs: 1e9 - 30 * MIN, conv: {} }, 1e9, { kind: "convergence" }).phase, "boosters");
});

test("leadPhase — reports age/life/remain/pct for the progress read", () => {
  const now = 1e9;
  const p = leadPhase({ esd: { etaBars: 10 }, launchMs: now - 5 * 60 * MIN, resolution: "1hour" }, now);
  assert.equal(p.ageMs, 5 * 60 * MIN);
  assert.equal(p.lifeMs, 15 * 60 * MIN);       // 1.5 × 10 bars × 60min
  assert.ok(Math.abs(p.pct - (5 / 15)) < 1e-9);
  assert.equal(p.remainMs, 10 * 60 * MIN);
});
