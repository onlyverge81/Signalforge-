// Promotion engine — the propose-only policy layer of the profitability wheel.
// It reads the beta-stripped, FDR-corrected alpha verdicts (forward-perf) and a
// lifecycle registry, then decides what changes state. The asymmetry is the whole
// point — "demote fast, promote slow":
//
//   • DEMOTE  is AUTOMATIC and applied immediately. A variant that is a proven
//     loser (significantly NEGATIVE alpha) is retired on LESS evidence and with
//     NO multiple-testing penalty — we are happy to be trigger-happy about
//     cutting risk. Protecting capital does not need a committee.
//   • PROMOTE is PROPOSE-ONLY. A variant that clears the strict, FDR-corrected
//     promotion gate is never auto-activated; it is written as a PENDING proposal
//     for a human to ratify. Adding risk / touching capital is human-gated.
//   • CIRCUIT BREAKER: if the forward data itself looks suspect above a threshold,
//     promotions are frozen (demotions still allowed — safety only cuts).
//
// Lifecycle:  candidate ──(human ratify)──▶ live ──(auto, proven loser)──▶ retired
//             retired ──(human ratify)──▶ live (reinstate)    "all" = reference
//
// Usage:
//   node scripts/promote.mjs                 # run the nightly plan, write registry + perf
//   node scripts/promote.mjs --dry-run       # print the plan, write nothing
//   node scripts/promote.mjs --json          # emit the updated registry
//   node scripts/promote.mjs --ratify grade-A   # a human accepts a pending promotion
//   node scripts/promote.mjs --reject grade-A    # a human declines a pending promotion

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scoreLedger } from "./forward-perf.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "paper-ledger.json");
const REGISTRY_PATH = path.join(ROOT, "strategy-registry.json");
const PERF_PATH = path.join(ROOT, "forward-perf.json");

// Variants that are portfolio references, not promotable gates ("all" = the whole
// book; you don't promote the book, you measure against it).
export const REFERENCE_VARIANTS = new Set(["all"]);

// The policy, made explicit and auditable so the asymmetry is a setting, not a
// buried constant. promote = strict + FDR-gated (handled upstream in forward-perf);
// demote = fast: fewer trades, looser one-sided threshold, NO multiplicity penalty.
export const DEFAULT_POLICY = {
  promote: { minTrades: 10, qMax: 0.05 },              // strict; uses BH-corrected qBH
  demote: { minTrades: 5, pMax: 0.10 },                // fast; raw one-sided negative p
  breaker: { suspectRatePct: 50 },                     // freeze promotions above this
};

export function emptyRegistry(now = new Date().toISOString()) {
  return { version: 1, updatedAt: now, policy: DEFAULT_POLICY, halted: false, variants: {}, proposals: [] };
}

function newNode(label, now) {
  const state = REFERENCE_VARIANTS.has(label) ? "reference" : "candidate";
  return { state, since: now, history: [{ at: now, from: null, to: state, reason: "registered" }] };
}

function transition(node, to, reason, now) {
  node.history.push({ at: now, from: node.state, to, reason });
  node.state = to;
  node.since = now;
}

// Drop / withdraw pending proposals for a variant (e.g. once it's retired).
function withdrawPending(proposals, label, now, reason) {
  for (const p of proposals) {
    if (p.variant === label && p.status === "pending") {
      p.status = "withdrawn"; p.resolvedAt = now; p.resolution = reason;
    }
  }
}

// Insert or refresh a single pending promotion proposal for a variant (deduped:
// one pending proposal per variant, evidence refreshed in place).
function upsertProposal(proposals, prop) {
  const existing = proposals.find(p => p.variant === prop.variant && p.status === "pending");
  if (existing) { Object.assign(existing, prop); return false; }
  proposals.push(prop); return true;
}

// ─── The core decision, pure and testable ────────────────────────────────────
// Given the scored perf and the current registry, return a NEW registry plus an
// event log. Does NOT do IO. Demotions mutate state; promotions only enqueue
// pending proposals; the breaker freezes promotions.
export function planTransitions(perf, registry, policy = DEFAULT_POLICY, now = new Date().toISOString()) {
  const reg = JSON.parse(JSON.stringify(registry || emptyRegistry(now)));
  reg.policy = policy;
  reg.updatedAt = now;
  reg.variants = reg.variants || {};
  reg.proposals = reg.proposals || [];
  const events = [];

  // Circuit breaker — suspect forward data freezes promotions (not demotions).
  const suspectRate = perf.ledger?.suspectRate || 0;
  const tripped = suspectRate >= policy.breaker.suspectRatePct;
  reg.halted = tripped;
  if (tripped) events.push({ variant: null, type: "CIRCUIT_BREAKER", reason: `suspect data ${suspectRate}% ≥ ${policy.breaker.suspectRatePct}% — promotions frozen` });

  for (const [label, v] of Object.entries(perf.variants)) {
    if (!reg.variants[label]) { reg.variants[label] = newNode(label, now); }
    const node = reg.variants[label];
    if (node.state === "reference") continue; // benchmarks never transition
    const sig = v.significance || {};

    // DEMOTE — auto, applied, fast (looser n, raw one-sided negative p, no FDR).
    const demotable = sig.n >= policy.demote.minTrades
      && sig.meanAlpha < 0 && sig.pLower != null && sig.pLower < policy.demote.pMax;
    if (demotable && node.state !== "retired") {
      transition(node, "retired", `proven loser: mean alpha ${sig.meanAlpha} over ${sig.n} trades, one-sided p=${sig.pLower} < ${policy.demote.pMax}`, now);
      withdrawPending(reg.proposals, label, now, "variant retired");
      events.push({ variant: label, type: "DEMOTED", reason: node.history[node.history.length - 1].reason });
      continue;
    }

    // PROMOTE — propose-only, strict (sig.promotable is already BH-FDR gated).
    if (sig.promotable && node.state !== "live") {
      if (tripped) { events.push({ variant: label, type: "PROMOTION_FROZEN", reason: "circuit breaker active" }); continue; }
      const action = node.state === "retired" ? "reinstate" : "promote";
      const added = upsertProposal(reg.proposals, {
        variant: label, action, from: node.state, to: "live", status: "pending",
        proposedAt: now,
        evidence: { n: sig.n, meanAlpha: sig.meanAlpha, qBH: sig.qBH, qBY: sig.qBY, verdict: sig.verdict },
      });
      events.push({ variant: label, type: added ? "PROPOSED" : "PROPOSAL_REFRESHED", reason: `${action} → live (human ratify): qBH=${sig.qBH}, alpha ${sig.meanAlpha} over ${sig.n}` });
    }
  }

  // Withdraw stale pending proposals whose variant is no longer promotable.
  for (const p of reg.proposals) {
    if (p.status !== "pending") continue;
    const sig = perf.variants[p.variant]?.significance;
    if (!sig || !sig.promotable) {
      p.status = "withdrawn"; p.resolvedAt = now; p.resolution = "no longer clears the promotion gate";
      events.push({ variant: p.variant, type: "PROPOSAL_WITHDRAWN", reason: p.resolution });
    }
  }

  return { registry: reg, events };
}

// ─── Human-gated ratification (the only path to "live") ───────────────────────
export function ratify(registry, label, accept, now = new Date().toISOString()) {
  const reg = JSON.parse(JSON.stringify(registry));
  const prop = (reg.proposals || []).find(p => p.variant === label && p.status === "pending");
  if (!prop) return { registry: reg, ok: false, reason: `no pending proposal for "${label}"` };
  const node = reg.variants[label];
  if (accept) {
    prop.status = "ratified"; prop.resolvedAt = now;
    transition(node, "live", `human-ratified ${prop.action} (qBH=${prop.evidence?.qBH})`, now);
  } else {
    prop.status = "rejected"; prop.resolvedAt = now;
    node.history.push({ at: now, from: node.state, to: node.state, reason: "promotion rejected by human" });
  }
  reg.updatedAt = now;
  return { registry: reg, ok: true, action: accept ? "ratified" : "rejected" };
}

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

function summarize(reg, events, perf) {
  console.log(`Promotion engine — propose-only (demote fast, promote slow)`);
  console.log(`ledger: ${perf.ledger.rows} rows, ${perf.ledger.benchmarkable} benchmarkable, suspect ${perf.ledger.suspectRate}%${reg.halted ? "  ⚠ CIRCUIT BREAKER ACTIVE (promotions frozen)" : ""}`);
  console.log(`states: ${Object.entries(reg.variants).map(([l, n]) => `${l}=${n.state}`).join(", ")}`);
  if (events.length) {
    console.log(`\nevents this run:`);
    for (const e of events) console.log(`  [${e.type}] ${e.variant ?? ""} — ${e.reason}`);
  } else {
    console.log(`\nno transitions — not enough evidence to act (the expected, honest default).`);
  }
  const pending = (reg.proposals || []).filter(p => p.status === "pending");
  console.log(`\npending proposals (await human ratify): ${pending.length}`);
  for (const p of pending) console.log(`  ${p.variant}: ${p.action} → live  (qBH=${p.evidence?.qBH}, alpha ${p.evidence?.meanAlpha} over ${p.evidence?.n})  → ratify:  node scripts/promote.mjs --ratify ${p.variant}`);
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const now = new Date().toISOString();
  const ledger = readJSON(LEDGER_PATH) || [];
  const perf = scoreLedger(ledger);
  let registry = readJSON(REGISTRY_PATH) || emptyRegistry(now);

  // Human-gated actions take precedence and exit.
  const ratifyIdx = args.indexOf("--ratify");
  const rejectIdx = args.indexOf("--reject");
  if (ratifyIdx >= 0 || rejectIdx >= 0) {
    const accept = ratifyIdx >= 0;
    const label = args[(accept ? ratifyIdx : rejectIdx) + 1];
    const res = ratify(registry, label, accept, now);
    if (!res.ok) { console.error(res.reason); process.exit(2); }
    if (!dryRun) fs.writeFileSync(REGISTRY_PATH, JSON.stringify(res.registry, null, 2) + "\n");
    console.log(`${label}: ${res.action}${dryRun ? " (dry-run, not written)" : ""}.`);
    return;
  }

  const { registry: next, events } = planTransitions(perf, registry, registry.policy || DEFAULT_POLICY, now);
  if (args.includes("--json")) { console.log(JSON.stringify(next, null, 2)); return; }
  summarize(next, events, perf);
  if (!dryRun) {
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(next, null, 2) + "\n");
    fs.writeFileSync(PERF_PATH, JSON.stringify(perf, null, 2) + "\n");
    console.log(`\nwrote strategy-registry.json and forward-perf.json.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
