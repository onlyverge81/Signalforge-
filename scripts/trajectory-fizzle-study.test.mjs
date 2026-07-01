// Offline unit tests for the trajectory-fizzle study's pure logic — no network, no Polygon key.
// Locks: the ESD launch-fingerprint predicate (launchFires) honors side/leaning/sep/angle/curvature;
// the episode resolver (esdEpisodes) is the reached/fizzled/censored trichotomy on synthetic bars;
// horizonEdge = trigger-fwd minus baseline-fwd (0 when the trigger is always on); the convergence
// recal helpers (recalConversion RVOL filter, recalVerdict "if it ain't broke" gate); pickSweetSpot's
// minN floor and bestHorizon's ≥suggestive preference.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  esdFeatures, launchFires, esdEpisodes, horizonEdge, bestHorizon, pickSweetSpot,
  conversionRate, recalConversion, recalVerdict, median, mean, selectContenderUniverse,
} from "./trajectory-fizzle-study.mjs";

// ── synthetic bar builders ──────────────────────────────────────────────────
function flatThenRamp(flatN, rampN, step){
  const bars = []; let p = 100, i = 0;
  for (; i < flatN; i++) bars.push({ t: i, date: "d" + i, open: p, high: p + 0.2, low: p - 0.2, close: p, volume: 1000 });
  for (let k = 0; k < rampN; k++, i++){ p += step; bars.push({ t: i, date: "d" + i, open: p - step / 2, high: p + 0.3, low: p - 0.5, close: p, volume: 1500 }); }
  return bars;
}

test("launchFires honors side/leaning/sep/angle/curvature; baseline passes, weak reads fail", () => {
  const combo = { sep: 1.75, angleDeg: 20, curvature: 0.5, side: "below", leaning: "up" };
  const strong = { side: "below", leaning: "up", gapATR: 2.0, atr: 1, angleDeg: 25, curvNorm: 0.6 };
  assert.equal(launchFires(strong, combo), true);
  assert.equal(launchFires({ ...strong, side: "above" }, combo), false);   // wrong side
  assert.equal(launchFires({ ...strong, leaning: "down" }, combo), false); // wrong lean
  assert.equal(launchFires({ ...strong, gapATR: 1.0 }, combo), false);     // separation too small
  assert.equal(launchFires({ ...strong, angleDeg: 12 }, combo), false);    // angle too shallow
  assert.equal(launchFires({ ...strong, curvNorm: 0.1 }, combo), false);   // curvature too flat
  assert.equal(launchFires(null, combo), false);
});

test("launchFires with null thresholds is permissive (only side/leaning matter)", () => {
  const combo = { sep: 0, angleDeg: null, curvature: null, side: "below", leaning: "up" };
  assert.equal(launchFires({ side: "below", leaning: "up", gapATR: 0.1, atr: 1, angleDeg: 3, curvNorm: -9 }, combo), true);
  assert.equal(launchFires({ side: "any", leaning: "up", gapATR: 5, atr: 1, angleDeg: 3, curvNorm: 9 }, { ...combo, side: "any" }), true);
});

test("esdFeatures is point-in-time and populates only after warm-up", () => {
  const bars = flatThenRamp(30, 50, 0.8);
  const feats = esdFeatures(bars, {});
  assert.equal(feats.length, bars.length);
  assert.equal(feats.slice(0, 20).every(f => f == null), true);        // no read before warm
  const late = feats.filter(Boolean);
  assert.ok(late.length > 10);
  assert.ok(late.every(f => ["above", "below", "level"].includes(f.side)));
});

test("esdEpisodes resolves a clean up-ramp to REACHED and a stall/reversal to FIZZLE", () => {
  const up = flatThenRamp(30, 50, 0.8);
  const rUp = esdEpisodes(up, { sep: 0.25, angleDeg: 0, curvature: null, side: "below", leaning: "up" }, {});
  assert.ok(rUp.flags >= 1);
  assert.ok(rUp.reached >= 1, "a clean rising ramp should reach the target");
  assert.equal(rUp.reached + rUp.fizzled + rUp.censored, rUp.flags);

  // a shallow rise that fires the launch but can't reach a far target, then a sustained crash → fizzle
  // (adverse stop / heading reversal resolves it before the unreachable target).
  const roll = flatThenRamp(35, 18, 0.4);
  let p = roll[roll.length - 1].close;
  for (let k = 0; k < 45; k++){ p -= 1.0; roll.push({ t: roll.length, date: "r" + k, open: p + 0.5, high: p + 0.6, low: p - 0.6, close: p, volume: 1200 }); }
  const rRoll = esdEpisodes(roll, { sep: 0.25, angleDeg: 0, curvature: null, side: "below", leaning: "up" }, { moveTargetATR: 20 });
  assert.ok(rRoll.fizzled >= 1, "a rollover after the launch should fizzle");
});

test("esdEpisodes never overlaps episodes (each fire resolves before the next)", () => {
  const bars = flatThenRamp(30, 60, 0.7);
  const r = esdEpisodes(bars, { sep: 0.25, angleDeg: 0, curvature: null, side: "below", leaning: "up" }, {});
  const idxs = r.episodes.map(e => e.idx);
  for (let k = 1; k < r.episodes.length; k++) assert.ok(r.episodes[k].idx > r.episodes[k - 1].idx + r.episodes[k - 1].resBars - 1);
});

test("horizonEdge = trigger-fwd minus baseline-fwd; always-on trigger ⇒ edge 0", () => {
  const bars = flatThenRamp(20, 80, 0.5);
  const he = horizonEdge(bars, () => true, [3, 8], { warm: 31 });
  assert.equal(he[3].edge, 0);
  assert.equal(he[8].edge, 0);
  assert.ok(he[3].n > 0 && he[3].n === he[3].eligible);
  // a trigger that fires only on up-bars of a ZIGZAG is a strict subset of eligible bars
  const zz = [];
  for (let j = 0; j < 100; j++){ const c = 100 + j * 0.1 + (j % 2 ? 2 : -2); zz.push({ t: j, date: "z" + j, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1000 }); }
  const zcl = zz.map(b => b.close);
  const he2 = horizonEdge(zz, (b, i) => zcl[i] > zcl[i - 1], [3], { warm: 31 });
  assert.ok(he2[3].n > 0 && he2[3].n < he2[3].eligible);
});

test("bestHorizon prefers the highest edge that is ≥ suggestive, else the max edge", () => {
  const rows = [
    { horizon: 3, edge: 0.01, tAcrossNames: 0.5 },
    { horizon: 8, edge: 0.03, tAcrossNames: 1.0 },   // higher edge but not significant
    { horizon: 13, edge: 0.02, tAcrossNames: 2.1 },  // suggestive+
  ];
  assert.equal(bestHorizon(rows).horizon, 13);       // significant one wins over higher-but-noisy
  const noneSig = rows.map(r => ({ ...r, tAcrossNames: 0.3 }));
  assert.equal(bestHorizon(noneSig).horizon, 8);     // falls back to max edge
  assert.equal(bestHorizon([]), null);
});

test("pickSweetSpot enforces the minN floor and maximizes conversion", () => {
  const rows = [
    { key: "a", reached: 15, fizzled: 10, conversionRate: 0.60, medianFavMovePct: 0.02 },  // n=25 eligible
    { key: "b", reached: 3, fizzled: 1, conversionRate: 0.75, medianFavMovePct: 0.05 },     // n=4 too few
    { key: "c", reached: 18, fizzled: 12, conversionRate: 0.60, medianFavMovePct: 0.03 },  // tie on rate, better move
  ];
  const best = pickSweetSpot(rows, { minN: 20 });
  assert.equal(best.key, "c");                        // n≥20 and wins the move tie-break
  assert.equal(pickSweetSpot(rows, { minN: 40 }), null);
});

test("conversionRate + recalConversion RVOL co-filter", () => {
  assert.equal(conversionRate(3, 1), 0.75);
  assert.equal(conversionRate(0, 0), null);
  const eps = [
    { outcome: "breakout", rvolFlag: 1.6 }, { outcome: "fizzle", rvolFlag: 0.8 },
    { outcome: "breakout", rvolFlag: 2.0 }, { outcome: "censored", rvolFlag: 3 },
  ];
  assert.deepEqual(recalConversion(eps, null), { conv: 2, fizz: 1, rate: 0.6667 });
  assert.deepEqual(recalConversion(eps, 1.5), { conv: 2, fizz: 0, rate: 1 });  // the fizzle is filtered out (low RVOL)
});

test("recalVerdict is 'if it ain't broke' — warranted only on a real gain with enough n", () => {
  // the REAL sweep rows carry the field as `conversionRate` (not `rate`) — the bug run #1 exposed
  const real = { formingMult: 2, minFormingBars: 5, rvolMin: null, conv: 29, fizz: 20, conversionRate: 0.5918 };
  const v = recalVerdict(0.4844, real, { minGain: 0.05, minN: 30 });
  assert.equal(v.warranted, true);                       // +10.7pp, n=49 → warranted (was wrongly false pre-fix)
  assert.equal(v.gain, 0.1074);
  assert.equal(v.bestRate, 0.5918);
  // legacy `rate` field still accepted
  assert.equal(recalVerdict(0.40, { rate: 0.50, conv: 20, fizz: 20 }, { minGain: 0.05, minN: 30 }).warranted, true);
  assert.equal(recalVerdict(0.40, { conversionRate: 0.42, conv: 20, fizz: 20 }, { minGain: 0.05, minN: 30 }).warranted, false); // gain too small
  assert.equal(recalVerdict(0.40, { conversionRate: 0.60, conv: 5, fizz: 5 }, { minGain: 0.05, minN: 30 }).warranted, false);   // too few n
  assert.equal(recalVerdict(null, null, {}).warranted, false);
});

test("selectContenderUniverse unions A/B ∪ C, dedupes, caps, and is empty-safe", () => {
  const db = {
    contenders: [{ sym: "EOG" }, { sym: "NEM" }, { sym: "BLK" }],   // A/B
    watchlist: [{ sym: "AA" }, { sym: "eog" }, { sym: "ADSK" }],    // C (eog dup, different case)
  };
  const all = selectContenderUniverse(db, 0);
  assert.deepEqual(all, ["EOG", "NEM", "BLK", "AA", "ADSK"]);       // dedup case-insensitive, A/B before C
  assert.deepEqual(selectContenderUniverse(db, 2), ["EOG", "NEM"]); // cap
  assert.deepEqual(selectContenderUniverse({}, 5), []);            // empty-safe
  assert.deepEqual(selectContenderUniverse({ contenders: [{}, { sym: "" }, { sym: "X" }] }, 0), ["X"]); // skips missing sym
});

test("median/mean ignore null/NaN", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, null, 3, 4]), 2.5);
  assert.equal(median([]), null);
  assert.equal(mean([2, 4, null, NaN]), 3);
  assert.equal(mean([]), null);
});
