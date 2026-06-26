// Offline unit tests for the contender-monitor pure helpers — no network.
// Run: node --test scripts/contender-monitor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { withinSession, classifyLead, rankLeads, buildReport, PATTERN_EDGE_NOTE, OPEN_MIN, CLOSE_MIN } from "./contender-monitor.mjs";

// ── withinSession — the 09:50–16:00 ET weekday gate ─────────────────────────
test("withinSession: open during the weekday window, closed outside it", () => {
  assert.equal(withinSession(3, 590).open, true);                 // Wed 09:50 ET — exactly open
  assert.equal(withinSession(3, 960).open, true);                 // Wed 16:00 ET — exactly close (inclusive)
  assert.equal(withinSession(3, 720).open, true);                 // Wed midday
  assert.equal(withinSession(3, 589).open, false);                // 09:49 — one min early
  assert.equal(withinSession(3, 961).open, false);                // 16:01 — after the close
});
test("withinSession: weekends are always closed", () => {
  assert.equal(withinSession(0, 720).open, false);                // Sunday midday
  assert.equal(withinSession(6, 720).open, false);                // Saturday midday
  assert.equal(withinSession(0, 720).isWeekday, false);
});
test("withinSession: defaults match 09:50 / 16:00 ET", () => {
  assert.equal(OPEN_MIN, 590);
  assert.equal(CLOSE_MIN, 960);
});

// ── classifyLead — a lead fires on any signal; grounded needs vetted quality + BUY ──
test("classifyLead: engine BUY on a vetted all-boxes name is a GROUNDED lead", () => {
  const r = classifyLead({ engine: { signal: "BUY" }, allBoxes: true, conv: { detected: false } });
  assert.equal(r.lead, true);
  assert.equal(r.grounded, true);
  assert.ok(r.reasons.some(x => /all-boxes/.test(x)));
});
test("classifyLead: a coil→pop with no engine BUY is a lead but NOT grounded (geometry only)", () => {
  const r = classifyLead({ engine: { signal: "HOLD" }, allBoxes: true, conv: { detected: true, strength: 0.8 } });
  assert.equal(r.lead, true);
  assert.equal(r.grounded, false);                                // HOLD ⇒ not grounded even if all-boxes
  assert.ok(r.reasons.some(x => /geometry only/.test(x)));        // honestly labeled
});
test("classifyLead: a BUY on a non-vetted name is a lead, not grounded", () => {
  const r = classifyLead({ engine: { signal: "BUY" }, allBoxes: false, conv: { detected: false } });
  assert.equal(r.lead, true);
  assert.equal(r.grounded, false);
});
test("classifyLead: nothing firing → not a lead", () => {
  assert.equal(classifyLead({ engine: { signal: "HOLD" }, allBoxes: false, conv: { detected: false } }).lead, false);
});

// ── rankLeads — grounded first, then BUY, then convergence strength ─────────
test("rankLeads: grounded outranks a stronger-but-ungrounded coil→pop", () => {
  const recs = [
    { sym: "GEO", lead: true, grounded: false, engine: { signal: "HOLD" }, conv: { detected: true, strength: 0.99 } },
    { sym: "GND", lead: true, grounded: true,  engine: { signal: "BUY"  }, conv: { detected: false, strength: 0 } },
    { sym: "NOPE", lead: false, grounded: false, engine: { signal: "HOLD" }, conv: { detected: false } },
  ];
  const out = rankLeads(recs);
  assert.deepEqual(out.map(r => r.sym), ["GND", "GEO"]);          // grounded first; non-lead filtered out
});

// ── buildReport — honesty invariants always present ─────────────────────────
test("buildReport: the pattern-edge note + 15-min-delayed caveat are ALWAYS present", () => {
  const rep = buildReport({ generatedAt: "2026-06-25T14:00:00Z", session: { open: true, weekday: 3, etMin: 600 }, records: [] });
  assert.equal(rep.patternEdgeNote, PATTERN_EDGE_NOTE);
  assert.match(rep.patternEdgeNote, /−0\.71%|not a proven signal/);
  assert.ok(rep.caveats.some(c => /15-MINUTE DELAYED/.test(c)));
  assert.equal(rep.delayedMin, 15);
  assert.equal(rep.marketOpen, true);
});
test("buildReport: classifies + counts + ranks records end to end", () => {
  const records = [
    { sym: "A", allBoxes: true,  engine: { signal: "BUY"  }, conv: { detected: false, strength: null } },
    { sym: "B", allBoxes: false, engine: { signal: "HOLD" }, conv: { detected: true,  strength: 0.5 } },
    { sym: "C", allBoxes: true,  engine: { signal: "HOLD" }, conv: { detected: false, strength: null } }, // not a lead
  ];
  const rep = buildReport({ generatedAt: "t", session: { open: true, weekday: 3, etMin: 600 }, records, scanned: 3, withData: 3 });
  assert.equal(rep.counts.leads, 2);
  assert.equal(rep.counts.grounded, 1);
  assert.equal(rep.counts.buys, 1);
  assert.equal(rep.counts.convergence, 1);
  assert.equal(rep.leads[0].sym, "A");                            // grounded BUY ranks first
});
test("buildReport: empty scan still yields a valid, honest report (no throw)", () => {
  const rep = buildReport({ generatedAt: "t", session: null, records: [] });
  assert.equal(rep.counts.leads, 0);
  assert.equal(rep.marketOpen, false);
  assert.ok(rep.caveats.length >= 3);
});

// ── FORMING stage — the tightening squeeze caught BEFORE the breakout ────────
test("classifyLead: a FORMING squeeze (no BUY, no breakout) is a lead, stage FORMING, not grounded", () => {
  const r = classifyLead({ engine: { signal: "HOLD" }, allBoxes: false, conv: { detected: false }, forming: { forming: true, barsForming: 6, tightness: 0.7 } });
  assert.equal(r.lead, true);
  assert.equal(r.stage, "FORMING");
  assert.equal(r.grounded, false);
  assert.ok(r.reasons.some(x => /FORMING/.test(x)));
});
test("classifyLead: once it has BROKEN OUT, the stage is BREAKOUT (forming is suppressed)", () => {
  const r = classifyLead({ engine: { signal: "HOLD" }, allBoxes: false, conv: { detected: true, strength: 0.5 }, forming: { forming: true, barsForming: 6 } });
  assert.equal(r.stage, "BREAKOUT");
});
test("rankLeads: a confirmed BREAKOUT outranks a still-FORMING squeeze", () => {
  const recs = [
    { sym: "FRM", lead: true, grounded: false, engine: { signal: "HOLD" }, stage: "FORMING",  forming: { forming: true, tightness: 0.9 } },
    { sym: "BRK", lead: true, grounded: false, engine: { signal: "HOLD" }, stage: "BREAKOUT", conv: { detected: true, strength: 0.4 } },
  ];
  assert.deepEqual(rankLeads(recs).map(r => r.sym), ["BRK", "FRM"]);
});
test("buildReport: counts forming-only names and surfaces them as ⏳ FORMING leads", () => {
  const records = [
    { sym: "A", allBoxes: true,  engine: { signal: "BUY"  }, conv: { detected: false } },                                    // grounded BUY
    { sym: "F", allBoxes: false, engine: { signal: "HOLD" }, conv: { detected: false }, forming: { forming: true, barsForming: 5, tightness: 0.6 } }, // forming-only
  ];
  const rep = buildReport({ generatedAt: "t", session: { open: true, weekday: 3, etMin: 600 }, records, scanned: 2, withData: 2 });
  assert.equal(rep.counts.forming, 1);
  assert.equal(rep.counts.leads, 2);
  const f = rep.leads.find(l => l.sym === "F");
  assert.ok(f && f.stage === "FORMING");
});
