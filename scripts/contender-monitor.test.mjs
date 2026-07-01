// Offline unit tests for the contender-monitor pure helpers — no network.
// Run: node --test scripts/contender-monitor.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { withinSession, classifyLead, rankLeads, buildReport, selectMonitorNames, PATTERN_EDGE_NOTE, OPEN_MIN, CLOSE_MIN } from "./contender-monitor.mjs";

// ── selectMonitorNames — the swept universe: A/B shortlist + grade-C watch tier ─
test("selectMonitorNames: includes A/B contenders + C watchlist, excludes D/F lowtier", () => {
  const db = {
    contenders: [{ sym: "AAA", grade: "A" }, { sym: "BBB", grade: "B" }],
    watchlist:  [{ sym: "CCC", grade: "C" }],
    lowtier:    [{ sym: "DDD", grade: "D" }, { sym: "FFF", grade: "F" }],
  };
  assert.deepEqual(selectMonitorNames(db).map(c => c.sym), ["AAA", "BBB", "CCC"]);
});
test("selectMonitorNames: dedups by symbol (A/B wins) and is empty-safe", () => {
  const db = { contenders: [{ sym: "AAA", grade: "A" }], watchlist: [{ sym: "aaa", grade: "C" }, { sym: null }] };
  const r = selectMonitorNames(db);
  assert.deepEqual(r.map(c => c.sym), ["AAA"]);
  assert.equal(r[0].grade, "A");                 // the A/B record wins over the duplicate C
  assert.deepEqual(selectMonitorNames(null), []); // no db → no throw
  assert.deepEqual(selectMonitorNames({}), []);
});

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

// ── lifecycle timer: buildReport attaches a phase and DROPS expired leads (no stale re-listing) ──
test("buildReport: a spent (EXPIRED) lead is dropped; a live one keeps its phase", () => {
  const gen = "2026-07-01T18:00:00.000Z";
  const nowMs = Date.parse(gen);
  const bar = 15 * 60000;
  const mk = (sym, ageBars) => ({
    sym, grade: "B", allBoxes: false,
    engine: { signal: "HOLD" }, conv: { detected: true, strength: 0.8 }, forming: { forming: false },
    lastBarMs: nowMs, launchMs: nowMs - ageBars * bar,
  });
  const rep = buildReport({ generatedAt: gen, session: { open: true }, records: [mk("LIVE", 2), mk("STALE", 40)] });
  const syms = rep.leads.map(l => l.sym);
  assert.ok(syms.includes("LIVE"), "a fresh coil lead stays");
  assert.ok(!syms.includes("STALE"), "a lead past its ~1-day max life is dropped");
  const live = rep.leads.find(l => l.sym === "LIVE");
  assert.ok(live.phase && live.phase.phase === "boosters", "the live lead carries its flight phase");
  assert.equal(live.phase.expired, false);
});

test("buildReport: a plain BUY (launchMs null) is never expired — a live verdict always stays", () => {
  const gen = "2026-07-01T18:00:00.000Z";
  const rep = buildReport({ generatedAt: gen, session: { open: true },
    records: [{ sym: "BUYONLY", grade: "A", allBoxes: true, engine: { signal: "BUY" }, conv: { detected: false }, forming: { forming: false }, lastBarMs: Date.parse(gen), launchMs: null }] });
  const l = rep.leads.find(l => l.sym === "BUYONLY");
  assert.ok(l, "the BUY lead stays on the board");
  assert.equal(l.phase.expired, false);
});
