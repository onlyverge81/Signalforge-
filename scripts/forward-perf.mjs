// Forward-performance scorer — reads the out-of-sample paper ledger and scores
// each variant's realized trades as ALPHA vs. a matched buy-&-hold benchmark,
// not as raw return. This is the guard against fooling ourselves: a long-only
// book on a rising tape will show a positive number whether or not the signal
// adds anything. The only honest question is "did timing the entry and exit beat
// just owning the same names over the same windows?" — i.e. alpha, not beta.
//
// The benchmark, per trade, is matched-window buy-&-hold: buy the SAME ticker at
// the SAME entry, hold passively to the close of the SAME exit bar (instead of
// exiting at the SL/TP touch). Because both legs pay one identical round-trip
// cost over the identical window, the cost CANCELS — alpha is cost-invariant, so
// fees can't be laundered into apparent edge.
//
// Step (a) of the profitability wheel: measure alpha. The significance test
// (multiple-testing-corrected) and the promotion engine build on top of this.
//
// Usage:
//   node scripts/forward-perf.mjs                 # print the per-variant alpha table
//   node scripts/forward-perf.mjs --json          # emit the raw forward-perf object
//   node scripts/forward-perf.mjs --write         # also write forward-perf.json

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const LEDGER_PATH = path.join(ROOT, "paper-ledger.json");
const PERF_PATH = path.join(ROOT, "forward-perf.json");

// Round-trip cost in % (slip+comm, both legs) — must mirror forward-log's CFG so
// the strategy's NET return and the benchmark's NET return share the same drag.
// It cancels in the alpha (same window, same single round trip) but is kept
// explicit so the per-leg net returns we report are themselves honest.
export const COST_PER_TRADE = (0.05 + 0.01) * 2;

const CLOSED = new Set(["WIN", "LOSS", "CLOSED"]);

// ─── A trade is benchmarkable only once it has a realized, matched window ─────
// Needs a closed status, a positive entry, and the exit-bar close captured at
// mark-to-market (older rows logged before benchClose existed are reported as
// uncovered rather than silently dropped or guessed).
export function isBenchmarkable(t) {
  return !!t && CLOSED.has(t.status)
    && Number.isFinite(t.entry) && t.entry > 0
    && Number.isFinite(t.benchClose) && t.benchClose > 0
    && Number.isFinite(t.grossPct);
}

// ─── Matched-window buy-&-hold gross return (%) for a long position ──────────
// Long-only book → benchmark is always long the same name. (Defined for the
// general case so a future short policy stays correct.)
export function buyHoldGrossPct(entry, benchClose, dir = "BUY") {
  const move = dir === "BUY" ? (benchClose - entry) : (entry - benchClose);
  return move / entry * 100;
}

// ─── Per-trade alpha: strategy return minus its matched buy-&-hold benchmark ──
// stratGross/stratNet come straight from the ledger (the engine's own exit math).
// benchGross is buy-&-hold over the identical window; benchNet pays the same one
// round trip. alphaPct is the difference — gross and net are equal because the
// cost is identical on both legs, which is the point.
export function tradeAlpha(t, costPerTrade = COST_PER_TRADE) {
  const dir = t.signal === "SELL" ? "SELL" : "BUY";
  const stratGross = t.grossPct;
  const stratNet = Number.isFinite(t.pnlPct) ? t.pnlPct : stratGross - costPerTrade;
  const benchGross = buyHoldGrossPct(t.entry, t.benchClose, dir);
  const benchNet = benchGross - costPerTrade;
  const alphaPct = stratGross - benchGross; // == stratNet - benchNet (cost cancels)
  return {
    id: t.id,
    ticker: t.ticker,
    stratGross: round(stratGross),
    stratNet: round(stratNet),
    benchGross: round(benchGross),
    benchNet: round(benchNet),
    alphaPct: round(alphaPct),
    beatBench: stratGross > benchGross,
  };
}

// ─── Aggregate a set of closed trades into one variant's alpha record ─────────
// Reports BOTH conventions: additive (sum of per-trade %, matching the engine's
// equity-curve convention) and compounded (geometric growth of $1 — "what the
// money actually did"). Alpha is reported each way; the compounded total-return
// alpha is the headline. Coverage is surfaced honestly: trades that aren't yet
// benchmarkable are counted, never quietly ignored.
export function variantAlpha(trades, costPerTrade = COST_PER_TRADE) {
  const all = trades || [];
  const closed = all.filter(t => CLOSED.has(t.status));
  const usable = all.filter(isBenchmarkable);
  const uncovered = closed.length - usable.length;

  const legs = usable.map(t => tradeAlpha(t, costPerTrade));
  const n = legs.length;

  const sum = arr => arr.reduce((a, b) => a + b, 0);
  const stratNetSum = sum(legs.map(l => l.stratNet));
  const benchNetSum = sum(legs.map(l => l.benchNet));
  const alphaSum = sum(legs.map(l => l.alphaPct));

  // Geometric growth of $1 through each leg's NET return (in fractional terms).
  const grow = arr => arr.reduce((acc, r) => acc * (1 + r / 100), 1) - 1;
  const stratGrowth = grow(legs.map(l => l.stratNet)) * 100;
  const benchGrowth = grow(legs.map(l => l.benchNet)) * 100;

  const beat = legs.filter(l => l.beatBench).length;

  return {
    n,
    closed: closed.length,
    uncovered,
    beatBench: beat,
    beatBenchRate: n ? round(beat / n * 100) : null,
    // additive (equity-curve) convention
    stratNetSum: round(stratNetSum),
    benchNetSum: round(benchNetSum),
    alphaSum: round(alphaSum),
    meanAlphaPerTrade: n ? round(alphaSum / n) : null,
    // compounded (geometric) convention — the headline
    stratGrowthPct: round(stratGrowth),
    benchGrowthPct: round(benchGrowth),
    alphaGrowthPct: round(stratGrowth - benchGrowth),
    legs,
  };
}

// ─── Variant definitions: named predicates that carve the ledger into the gates
// whose forward alpha we're judging. "all" is the live policy as-shipped; the
// rest are the candidate lenses (does requiring grade A add alpha? do the merit
// overlays?). Promotion later asks: which of these variants earns its alpha
// SIGNIFICANTLY? Buckets with no trades simply report n:0 — honest emptiness.
export function defaultVariants() {
  const grade = g => t => (t.tags && t.tags.fundamentalGrade) === g;
  return [
    { label: "all", where: () => true },
    { label: "grade-A", where: grade("A") },
    { label: "grade-B", where: grade("B") },
    { label: "grade-C", where: grade("C") },
    { label: "grade-D", where: grade("D") },
    { label: "grade-F", where: grade("F") },
    { label: "merits-on", where: t => !!(t.tags && t.tags.meritsActivated) },
    { label: "merits-off", where: t => !(t.tags && t.tags.meritsActivated) },
  ];
}

// ─── Score the whole ledger: every variant's alpha record, keyed by label ─────
export function scoreLedger(ledger, variants = defaultVariants(), costPerTrade = COST_PER_TRADE) {
  const rows = Array.isArray(ledger) ? ledger : [];
  const closedTotal = rows.filter(t => CLOSED.has(t.status)).length;
  const benchmarkable = rows.filter(isBenchmarkable).length;
  const variantsOut = {};
  for (const v of variants) {
    variantsOut[v.label] = variantAlpha(rows.filter(v.where), costPerTrade);
  }
  return {
    generatedAt: new Date().toISOString(),
    method: "matched-window buy-&-hold; alpha = strategy net − benchmark net (cost-invariant)",
    costPerTrade,
    ledger: { rows: rows.length, closed: closedTotal, benchmarkable },
    variants: variantsOut,
  };
}

function round(x) { return Number.isFinite(x) ? parseFloat(x.toFixed(4)) : x; }
function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }

// ─── CLI table ───────────────────────────────────────────────────────────────
function printTable(perf) {
  const L = perf.ledger;
  console.log(`Forward performance — alpha vs. matched buy-&-hold (beta-stripped)`);
  console.log(`ledger: ${L.rows} rows, ${L.closed} closed, ${L.benchmarkable} benchmarkable\n`);
  if (!L.benchmarkable) {
    console.log("  (no benchmarkable trades yet — closed trades carrying a benchClose are needed.)");
    return;
  }
  const pad = (s, n) => String(s).padEnd(n);
  const padN = (s, n) => String(s).padStart(n);
  console.log(`  ${pad("variant", 12)} ${padN("n", 4)} ${padN("strat%", 9)} ${padN("bench%", 9)} ${padN("alpha%", 9)} ${padN("beat%", 7)}`);
  console.log(`  ${"-".repeat(12)} ${"-".repeat(4)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(7)}`);
  for (const [label, v] of Object.entries(perf.variants)) {
    if (!v.n) { console.log(`  ${pad(label, 12)} ${padN(0, 4)} ${padN("—", 9)} ${padN("—", 9)} ${padN("—", 9)} ${padN("—", 7)}`); continue; }
    const sign = v.alphaGrowthPct > 0 ? "+" : "";
    console.log(`  ${pad(label, 12)} ${padN(v.n, 4)} ${padN(v.stratGrowthPct, 9)} ${padN(v.benchGrowthPct, 9)} ${padN(sign + v.alphaGrowthPct, 9)} ${padN(v.beatBenchRate, 7)}`);
  }
  console.log(`\n  strat%/bench% = compounded net growth of $1; alpha% = strat − bench (cost-invariant).`);
  console.log(`  Positive alpha is necessary, not sufficient — significance comes next.`);
}

function main() {
  const args = process.argv.slice(2);
  const ledger = readJSON(LEDGER_PATH) || [];
  const perf = scoreLedger(ledger);
  if (args.includes("--json")) { console.log(JSON.stringify(perf, null, 2)); }
  else { printTable(perf); }
  if (args.includes("--write")) {
    fs.writeFileSync(PERF_PATH, JSON.stringify(perf, null, 2) + "\n");
    console.log(`\nforward-perf.json written (${perf.ledger.benchmarkable} benchmarkable).`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
