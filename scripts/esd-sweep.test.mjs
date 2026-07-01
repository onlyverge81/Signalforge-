// Offline unit tests for the ESD sweep's pure logic — no network.
// Locks: the 9:55 ET open boundary, the heading-lead classification (separated + valid → lead,
// grounded on all-boxes), the ranking (grounded first, then steeper angle), and that every report
// carries the projection/overshoot caveats.

import { test } from "node:test";
import assert from "node:assert/strict";
import { withinSession } from "./contender-monitor.mjs";
import { classifyEsdLead, rankEsdLeads, buildReport, ESD_OPEN_MIN, ESD_CLOSE_MIN, ESD_NOTE } from "./esd-sweep.mjs";

test("ESD sweep session gate opens at 9:55 ET (595) and closes at 16:00 (960), weekdays only", () => {
  const o = { openMin: ESD_OPEN_MIN, closeMin: ESD_CLOSE_MIN };
  assert.equal(withinSession(3, 594, o).open, false);   // 09:54 — before the first scan
  assert.equal(withinSession(3, 595, o).open, true);    // 09:55 — first scan
  assert.equal(withinSession(3, 960, o).open, true);    // 16:00 — the close (inclusive)
  assert.equal(withinSession(3, 961, o).open, false);   // 16:01 — after close
  assert.equal(withinSession(0, 700, o).open, false);   // Sunday — weekend
  assert.equal(withinSession(6, 700, o).open, false);   // Saturday — weekend
});

const upLead   = { sym: "AAA", allBoxes: true,  heading: { separated: true,  leaning: "up",   side: "below" }, esd: { valid: true,  leaning: "up",   angleDeg: 12, targetName: "tp1", targetPrice: 110, etaBars: 8 } };
const upPlain  = { sym: "BBB", allBoxes: false, heading: { separated: true,  leaning: "up",   side: "below" }, esd: { valid: true,  leaning: "up",   angleDeg: 30, targetName: "resistance", targetPrice: 55, etaBars: 5 } };
const noDest   = { sym: "CCC", allBoxes: true,  heading: { separated: true,  leaning: "up",   side: "below" }, esd: { valid: false } };
const flat     = { sym: "DDD", allBoxes: true,  heading: { separated: false, leaning: "flat", side: "level" }, esd: { valid: true,  leaning: "flat", angleDeg: 0,  targetName: null, targetPrice: null, etaBars: null } };

test("classifyEsdLead: separated + valid → lead; all-boxes → grounded; no destination / not-separated → not a lead", () => {
  assert.equal(classifyEsdLead(upLead).lead, true);
  assert.equal(classifyEsdLead(upLead).grounded, true);
  assert.equal(classifyEsdLead(upPlain).lead, true);
  assert.equal(classifyEsdLead(upPlain).grounded, false);   // valid heading but not vetted
  assert.equal(classifyEsdLead(noDest).lead, false);        // valid:false → no reachable level
  assert.equal(classifyEsdLead(flat).lead, false);          // not separated
});

test("rankEsdLeads: grounded first, then steeper angle", () => {
  const ranked = rankEsdLeads([upPlain, upLead, noDest, flat].map(r => ({ ...r, ...classifyEsdLead(r) })));
  assert.equal(ranked.length, 2);                            // only the two real leads
  assert.equal(ranked[0].sym, "AAA");                        // grounded outranks the steeper-but-ungrounded
  assert.equal(ranked[1].sym, "BBB");
});

test("buildReport: always carries the projection/overshoot caveats + ESD note; counts are correct", () => {
  const rep = buildReport({ generatedAt: "t", session: { weekday: 3, etMin: 600, open: true },
    records: [upLead, upPlain, noDest, flat], scanned: 4, withData: 4, resolution: "1hour" });
  assert.equal(rep.counts.leads, 2);
  assert.equal(rep.counts.grounded, 1);
  assert.equal(rep.counts.up, 2);
  assert.equal(rep.esdNote, ESD_NOTE);
  assert.ok(rep.caveats.some(c => /15-MINUTE DELAYED/.test(c)));
  assert.ok(rep.caveats.some(c => /PROJECTION that overshoots/.test(c)));
  assert.equal(rep.marketOpen, true);
});
