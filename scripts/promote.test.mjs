// Offline unit tests for the promotion engine — no network.
// Run: node --test scripts/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreLedger } from "./forward-perf.mjs";
import {
  planTransitions, ratify, emptyRegistry, DEFAULT_POLICY, REFERENCE_VARIANTS,
} from "./promote.mjs";

// Drive through the real pipeline with a synthetic ledger so significance is
// computed exactly as in production, then plan transitions on the result.
function ledgerFor(specs) {
  // specs: [{ label, grade, merits, alpha, n }] → rows whose strat beats a flat bench by `alpha`.
  const rows = [];
  let k = 0;
  for (const s of specs) {
    for (let i = 0; i < s.n; i++) {
      const a = s.alpha + (i % 2 ? 0.05 : -0.05); // tiny noise → finite variance
      rows.push({
        id: `${s.label}-${k++}`, ticker: s.label, signal: "BUY",
        status: a >= 0 ? "WIN" : "LOSS", entry: 100, exit: 100 + a,
        grossPct: +a.toFixed(4), pnlPct: +a.toFixed(4), benchClose: 100,
        tags: { fundamentalGrade: s.grade ?? null, meritsActivated: !!s.merits, dataSuspect: !!s.suspect },
      });
    }
  }
  return rows;
}

// ─── demote fast: a proven loser is auto-retired on few trades, no human ──────
test("planTransitions: a significantly negative variant is auto-DEMOTED to retired", () => {
  // grade-C: 6 trades (≥ demote.minTrades=5) of clearly negative alpha.
  const perf = scoreLedger(ledgerFor([{ label: "C", grade: "C", alpha: -3, n: 6 }]));
  const { registry, events } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.variants["grade-C"].state, "retired");
  assert.ok(events.some(e => e.type === "DEMOTED" && e.variant === "grade-C"));
  // demotion needed FEWER than the 10 trades promotion requires — that's the asymmetry.
  assert.ok(6 < DEFAULT_POLICY.promote.minTrades);
});

test("planTransitions: too few trades to demote stays candidate (no premature cut)", () => {
  const perf = scoreLedger(ledgerFor([{ label: "C", grade: "C", alpha: -3, n: 4 }])); // < demote.minTrades
  const { registry } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.variants["grade-C"].state, "candidate");
});

// ─── promote slow: a winner is only PROPOSED, never auto-activated ────────────
test("planTransitions: a significant winner is PROPOSED, not auto-promoted to live", () => {
  const perf = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12 }]));
  const { registry, events } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.variants["grade-A"].state, "candidate"); // NOT live
  const aProp = registry.proposals.find(p => p.variant === "grade-A" && p.status === "pending");
  assert.ok(aProp, "grade-A should have a pending proposal");
  assert.equal(aProp.to, "live");
  assert.equal(aProp.action, "promote");
  assert.ok(events.some(e => e.type === "PROPOSED"));
});

test("planTransitions: re-running refreshes proposals, never duplicates a variant", () => {
  const perf = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12 }]));
  let { registry } = planTransitions(perf, emptyRegistry());
  const before = registry.proposals.filter(p => p.status === "pending").length;
  ({ registry } = planTransitions(perf, registry));
  const pending = registry.proposals.filter(p => p.status === "pending");
  assert.equal(pending.length, before); // stable, not growing
  // at most one pending proposal per variant
  const byVar = pending.map(p => p.variant);
  assert.equal(new Set(byVar).size, byVar.length);
});

// ─── human ratification is the only path to live ──────────────────────────────
test("ratify: a human accepting a pending proposal moves the variant to live", () => {
  const perf = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12 }]));
  const { registry } = planTransitions(perf, emptyRegistry());
  const res = ratify(registry, "grade-A", true);
  assert.equal(res.ok, true);
  assert.equal(res.registry.variants["grade-A"].state, "live");
  assert.equal(res.registry.proposals.find(p => p.variant === "grade-A").status, "ratified");
});

test("ratify: rejecting leaves the variant where it was and records the decision", () => {
  const perf = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12 }]));
  const { registry } = planTransitions(perf, emptyRegistry());
  const res = ratify(registry, "grade-A", false);
  assert.equal(res.registry.variants["grade-A"].state, "candidate");
  assert.equal(res.registry.proposals.find(p => p.variant === "grade-A").status, "rejected");
});

test("ratify: nothing pending → a clear no-op error, not a silent state change", () => {
  const res = ratify(emptyRegistry(), "grade-A", true);
  assert.equal(res.ok, false);
});

// ─── circuit breaker: suspect data freezes promotions, still allows demotions ─
test("planTransitions: circuit breaker freezes promotions when data is suspect", () => {
  const rows = ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12, suspect: true }]);
  const perf = scoreLedger(rows);
  assert.ok(perf.ledger.suspectRate >= 50);
  const { registry, events } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.halted, true);
  assert.equal(registry.proposals.filter(p => p.status === "pending").length, 0);
  assert.ok(events.some(e => e.type === "CIRCUIT_BREAKER"));
  assert.ok(events.some(e => e.type === "PROMOTION_FROZEN"));
});

// ─── proposals withdraw when a variant stops clearing the gate ────────────────
test("planTransitions: a proposal is withdrawn once the variant decays below the gate", () => {
  const strong = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 3, n: 12 }]));
  let { registry } = planTransitions(strong, emptyRegistry());
  assert.ok(registry.proposals.some(p => p.variant === "grade-A" && p.status === "pending"));
  // next run: the same variant now shows no edge (alpha ~0) → proposal withdrawn.
  const weak = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: 0.01, n: 12 }]));
  ({ registry } = planTransitions(weak, registry));
  assert.ok(!registry.proposals.some(p => p.variant === "grade-A" && p.status === "pending"));
  assert.ok(registry.proposals.some(p => p.variant === "grade-A" && p.status === "withdrawn"));
});

// ─── reference variants never transition ──────────────────────────────────────
test('planTransitions: "all" is a reference and is never promoted or demoted', () => {
  assert.ok(REFERENCE_VARIANTS.has("all"));
  const perf = scoreLedger(ledgerFor([{ label: "A", grade: "A", alpha: -3, n: 12 }]));
  const { registry } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.variants["all"].state, "reference");
  assert.equal(registry.proposals.some(p => p.variant === "all"), false);
});

// ─── empty ledger: the honest default is to do nothing ────────────────────────
test("planTransitions: an empty ledger produces no transitions and no proposals", () => {
  const perf = scoreLedger([]);
  const { registry, events } = planTransitions(perf, emptyRegistry());
  assert.equal(registry.proposals.length, 0);
  assert.equal(events.length, 0);
  assert.equal(registry.halted, false);
});
