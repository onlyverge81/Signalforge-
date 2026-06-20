// Offline unit tests for the forward-performance scorer — no network.
// Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buyHoldGrossPct, buyHoldTotalPct, tradeAlpha, variantAlpha, scoreLedger, isBenchmarkable,
  defaultVariants, COST_PER_TRADE, gradeAB, bothTac,
  betai, tUpperP, tTest, attachSignificance, MIN_TRADES_SIG,
} from "./forward-perf.mjs";
import { markToMarket } from "./forward-log.mjs";

// A minimal closed-trade row, mirroring the ledger schema.
function closed({ id = "T", ticker = "X", signal = "BUY", entry = 100, exit, benchClose, benchDiv, grade = null, merits = false, momentum = false, reversal = false, lowVol = false, quality = false, newsPositive = false, newsQuiet = true, earningsRecent = false }) {
  const grossPct = (exit - entry) / entry * 100;
  return {
    id, ticker, signal, entry, exit,
    grossPct: parseFloat(grossPct.toFixed(4)),
    pnlPct: parseFloat((grossPct - COST_PER_TRADE).toFixed(4)),
    status: grossPct >= 0 ? "WIN" : "LOSS",
    benchClose, benchDiv,
    tags: { fundamentalGrade: grade, meritsActivated: merits, momentumActivated: momentum, reversalActivated: reversal, lowVolActivated: lowVol, qualityActivated: quality, newsPositive, newsQuiet, earningsRecent },
  };
}

// ─── buy-&-hold benchmark ─────────────────────────────────────────────────────
test("buyHoldGrossPct: long return over the matched window", () => {
  assert.equal(buyHoldGrossPct(100, 110, "BUY"), 10);
  assert.equal(buyHoldGrossPct(100, 90, "BUY"), -10);
  assert.equal(buyHoldGrossPct(100, 110, "SELL"), -10); // short loses on a rally
});

test("buyHoldTotalPct: dividends lift the long hold (and are paid by a short)", () => {
  assert.equal(buyHoldTotalPct(100, 110, 0, "BUY"), 10);     // no div → price-only
  assert.equal(buyHoldTotalPct(100, 110, 2, "BUY"), 12);     // +$2/sh div on a $100 entry → +2%
  assert.equal(buyHoldTotalPct(100, 110, 2, "SELL"), -12);   // short pays the dividend
  assert.equal(buyHoldTotalPct(100, 110, undefined, "BUY"), 10); // missing benchDiv → price-only
});

test("tradeAlpha: a dividend the holder collects raises the bar (shrinks alpha)", () => {
  // strat +4% (exit 104); hold closes at 108 AND collects a $1 dividend → bench 9%, not 8%.
  const t = closed({ entry: 100, exit: 104, benchClose: 108, benchDiv: 1 });
  const a = tradeAlpha(t);
  assert.equal(a.benchGross, 9);
  assert.equal(a.alphaPct, -5);     // 4 − 9; the dividend made buy-&-hold harder to beat
  assert.equal(a.beatBench, false);
});

// ─── the core property: alpha is cost-invariant ───────────────────────────────
test("tradeAlpha: cost cancels — alpha is identical at any cost level", () => {
  // strategy exits at 104 (TP); the same name closes the exit bar at 108.
  const t = closed({ entry: 100, exit: 104, benchClose: 108 });
  const a0 = tradeAlpha(t, 0);
  const a5 = tradeAlpha(t, 5);
  assert.equal(a0.alphaPct, a5.alphaPct);
  // strat +4% vs bench +8% over the same window → it gave up 4 points of alpha.
  assert.equal(a0.alphaPct, -4);
  assert.equal(a0.beatBench, false);
});

test("tradeAlpha: beating buy-&-hold yields positive alpha", () => {
  // strategy banks +6 (exit 106) while holding to close would have given +2 (102).
  const t = closed({ entry: 100, exit: 106, benchClose: 102 });
  const a = tradeAlpha(t);
  assert.equal(a.alphaPct, 4);
  assert.equal(a.beatBench, true);
});

// ─── the whole point: positive raw return can be NEGATIVE alpha (beta trap) ───
test("variantAlpha: a profitable book that lags buy-&-hold has negative alpha", () => {
  // Both trades make money, but each badly trails simply holding the name.
  const trades = [
    closed({ id: "A", entry: 100, exit: 103, benchClose: 115 }), // +3 vs +15
    closed({ id: "B", entry: 100, exit: 102, benchClose: 110 }), // +2 vs +10
  ];
  const v = variantAlpha(trades, 0);
  assert.equal(v.n, 2);
  assert.ok(v.stratGrowthPct > 0, "strategy is profitable in raw terms");
  assert.ok(v.alphaGrowthPct < 0, "yet it destroyed alpha vs. just holding");
  assert.equal(v.beatBench, 0);
  assert.equal(v.beatBenchRate, 0);
});

test("variantAlpha: compounded growth multiplies, not adds", () => {
  const trades = [
    closed({ id: "A", entry: 100, exit: 110, benchClose: 100 }), // +10 strat, 0 bench
    closed({ id: "B", entry: 100, exit: 110, benchClose: 100 }), // +10 strat, 0 bench
  ];
  const v = variantAlpha(trades, 0);
  // net per trade = +10 − 0.12 cost = 9.88. additive: 19.76;
  // compounded: 1.0988² − 1 = 20.74% > the additive sum (growth multiplies).
  assert.equal(v.stratNetSum, 19.76);
  assert.equal(v.stratGrowthPct, 20.7361);
  assert.ok(v.stratGrowthPct > v.stratNetSum);
});

// ─── coverage is surfaced, not hidden ─────────────────────────────────────────
test("isBenchmarkable / uncovered: closed-but-no-benchClose is counted, not dropped", () => {
  const ok = closed({ id: "A", entry: 100, exit: 105, benchClose: 108 });
  const noBench = { id: "B", ticker: "Y", signal: "BUY", entry: 100, exit: 105, grossPct: 5, pnlPct: 4.88, status: "WIN", benchClose: null, tags: {} };
  const open = { id: "C", status: "OPEN", entry: 100, benchClose: null, tags: {} };
  assert.equal(isBenchmarkable(ok), true);
  assert.equal(isBenchmarkable(noBench), false);
  assert.equal(isBenchmarkable(open), false);
  const v = variantAlpha([ok, noBench, open]);
  assert.equal(v.n, 1);
  assert.equal(v.closed, 2);     // ok + noBench are closed
  assert.equal(v.uncovered, 1);  // noBench counted as uncovered
});

// ─── variant grouping ─────────────────────────────────────────────────────────
test("scoreLedger: variants carve the ledger by gate tags", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 106, benchClose: 102, grade: "A" }), // +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 112, grade: "C" }), // -alpha
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.ledger.benchmarkable, 2);
  assert.equal(perf.variants["all"].n, 2);
  assert.equal(perf.variants["grade-A"].n, 1);
  assert.equal(perf.variants["grade-C"].n, 1);
  assert.equal(perf.variants["grade-B"].n, 0);
  assert.ok(perf.variants["grade-A"].alphaGrowthPct > 0);
  assert.ok(perf.variants["grade-C"].alphaGrowthPct < 0);
});

test("scoreLedger: merits-on / merits-off partition the SAME population by the meritsActivated tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 106, benchClose: 102, grade: "A", merits: true }),  // high-merit, +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 112, grade: "C", merits: false }), // low-merit, -alpha
    closed({ id: "C", entry: 100, exit: 108, benchClose: 103, grade: "B", merits: true }),  // high-merit, +alpha
  ];
  const perf = scoreLedger(ledger);
  // The two buckets are a clean A/B that re-unions to the whole "all" variant.
  assert.equal(perf.variants["merits-on"].n + perf.variants["merits-off"].n, perf.variants["all"].n);
  assert.equal(perf.variants["merits-on"].n, 2);
  assert.equal(perf.variants["merits-off"].n, 1);
  // Each gets its own independent alpha record.
  assert.ok(perf.variants["merits-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["merits-off"].alphaGrowthPct < 0);
});

test("scoreLedger: momentum-on / momentum-off partition the SAME population by the momentumActivated tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, momentum: true }),  // top-tertile, +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, momentum: false }), // rest, -alpha
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, momentum: true }),  // top-tertile, +alpha
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["momentum-on"].n + perf.variants["momentum-off"].n, perf.variants["all"].n);
  assert.equal(perf.variants["momentum-on"].n, 2);
  assert.equal(perf.variants["momentum-off"].n, 1);
  assert.ok(perf.variants["momentum-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["momentum-off"].alphaGrowthPct < 0);
});

test("scoreLedger: reversal-on / reversal-off partition the SAME population by the reversalActivated tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, reversal: true }),  // top-tertile loser, +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, reversal: false }), // rest, -alpha
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, reversal: true }),  // top-tertile loser, +alpha
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["reversal-on"].n + perf.variants["reversal-off"].n, perf.variants["all"].n);
  assert.equal(perf.variants["reversal-on"].n, 2);
  assert.equal(perf.variants["reversal-off"].n, 1);
  assert.ok(perf.variants["reversal-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["reversal-off"].alphaGrowthPct < 0);
});

test("scoreLedger: lowvol-on / lowvol-off partition the SAME population by the lowVolActivated tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, lowVol: true }),  // calm, +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, lowVol: false }), // wild, -alpha
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, lowVol: true }),  // calm, +alpha
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["lowvol-on"].n + perf.variants["lowvol-off"].n, perf.variants["all"].n);
  assert.equal(perf.variants["lowvol-on"].n, 2);
  assert.equal(perf.variants["lowvol-off"].n, 1);
  assert.ok(perf.variants["lowvol-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["lowvol-off"].alphaGrowthPct < 0);
});

test("scoreLedger: quality-on / quality-off partition the SAME population by the qualityActivated tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, quality: true }),  // profitable, +alpha
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, quality: false }), // unprofitable, -alpha
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, quality: true }),  // profitable, +alpha
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["quality-on"].n + perf.variants["quality-off"].n, perf.variants["all"].n);
  assert.equal(perf.variants["quality-on"].n, 2);
  assert.equal(perf.variants["quality-off"].n, 1);
  assert.ok(perf.variants["quality-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["quality-off"].alphaGrowthPct < 0);
});

test("scoreLedger: event overlays partition the tactical population by the news tags", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, newsPositive: true,  newsQuiet: true }),
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, newsPositive: false, newsQuiet: false }), // fresh bad news
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, newsPositive: false, newsQuiet: true }),  // quiet, no positive
  ];
  const perf = scoreLedger(ledger);
  // news-pos: only A is positive; on+off re-unions to all.
  assert.equal(perf.variants["news-pos-on"].n, 1);
  assert.equal(perf.variants["news-pos-on"].n + perf.variants["news-pos-off"].n, perf.variants["all"].n);
  // news-quiet: A and C are quiet, B is not.
  assert.equal(perf.variants["news-quiet-on"].n, 2);
  assert.equal(perf.variants["news-quiet-on"].n + perf.variants["news-quiet-off"].n, perf.variants["all"].n);
});

test("scoreLedger: earnings-recent partitions the tactical population by the SEC filing-proximity tag", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 107, benchClose: 102, earningsRecent: true }),
    closed({ id: "B", entry: 100, exit: 101, benchClose: 110, earningsRecent: false }),
    closed({ id: "C", entry: 100, exit: 109, benchClose: 103, earningsRecent: true }),
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["earnings-recent-on"].n, 2);
  assert.equal(perf.variants["earnings-recent-on"].n + perf.variants["earnings-recent-off"].n, perf.variants["all"].n);
});

test("scoreLedger: POSITION is its own variant; the tactical family excludes it (no conflation)", () => {
  const ledger = [
    closed({ id:"T1", entry:100, exit:106, benchClose:102, grade:"A", merits:true }),       // tactical
    { ...closed({ id:"P1", entry:100, exit:112, benchClose:104 }), tags:{ mode:"position" } }, // position
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["all"].n, 1);          // tactical 'all' = T1 only
  assert.equal(perf.variants["position"].n, 1);     // position bucket = P1
  assert.equal(perf.variants["grade-A"].n, 1);      // tactical grade still resolves (T1)
  assert.equal(perf.variants["merits-on"].n, 1);    // and merits (T1), unaffected by the position row
});

test("scoreLedger: quality-position-on/off partition the POSITION stream by qualityActivated", () => {
  const ledger = [
    closed({ id: "T1", entry: 100, exit: 106, benchClose: 102, quality: true }),                          // tactical (excluded)
    { ...closed({ id: "P1", entry: 100, exit: 112, benchClose: 104 }), tags: { mode: "position", qualityActivated: true } },  // hi-quality long hold, +alpha
    { ...closed({ id: "P2", entry: 100, exit: 101, benchClose: 108 }), tags: { mode: "position", qualityActivated: false } }, // lo-quality long hold, -alpha
  ];
  const perf = scoreLedger(ledger);
  // the two buckets re-union to the whole POSITION stream (2 rows), tactical excluded.
  assert.equal(perf.variants["quality-position-on"].n + perf.variants["quality-position-off"].n, perf.variants["position"].n);
  assert.equal(perf.variants["quality-position-on"].n, 1);
  assert.equal(perf.variants["quality-position-off"].n, 1);
  assert.ok(perf.variants["quality-position-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["quality-position-off"].alphaGrowthPct < 0);
  // never conflated with the tactical quality-on label (T1 is tactical, P1/P2 are position).
  assert.equal(perf.variants["quality-on"].n, 1);
});

test("scoreLedger: quality-grade-position-on/off partition the POSITION stream by AUTOPSY grade A/B", () => {
  const ledger = [
    { ...closed({ id: "P1", entry: 100, exit: 112, benchClose: 104 }), tags: { mode: "position", fundamentalGrade: "A" } }, // grade A, +alpha
    { ...closed({ id: "P2", entry: 100, exit: 113, benchClose: 105 }), tags: { mode: "position", fundamentalGrade: "B" } }, // grade B, +alpha
    { ...closed({ id: "P3", entry: 100, exit: 101, benchClose: 108 }), tags: { mode: "position", fundamentalGrade: "C" } }, // grade C, -alpha
    { ...closed({ id: "P4", entry: 100, exit: 100, benchClose: 109 }), tags: { mode: "position", fundamentalGrade: "D" } }, // grade D, -alpha
  ];
  const perf = scoreLedger(ledger);
  // on/off re-union to the whole POSITION stream; A/B on the on-side, C/D on the off-side.
  assert.equal(perf.variants["quality-grade-position-on"].n + perf.variants["quality-grade-position-off"].n, perf.variants["position"].n);
  assert.equal(perf.variants["quality-grade-position-on"].n, 2);
  assert.equal(perf.variants["quality-grade-position-off"].n, 2);
  assert.ok(perf.variants["quality-grade-position-on"].alphaGrowthPct > 0);
  assert.ok(perf.variants["quality-grade-position-off"].alphaGrowthPct < 0);
});

test("gradeAB: only position-stream rows graded A or B qualify (propose-only label, never a gate)", () => {
  assert.equal(gradeAB({ tags: { mode: "position", fundamentalGrade: "A" } }), true);
  assert.equal(gradeAB({ tags: { mode: "position", fundamentalGrade: "B" } }), true);
  assert.equal(gradeAB({ tags: { mode: "position", fundamentalGrade: "C" } }), false);
  assert.equal(gradeAB({ tags: { mode: "position", fundamentalGrade: null } }), false);
  assert.equal(gradeAB({ tags: { fundamentalGrade: "A" } }), false, "tactical A is not a position-grade row");
});

test("scoreLedger: combined interaction overlays partition the tactical population by BOTH tags", () => {
  const ledger = [
    // momentum AND quality → mom-quality-on; +alpha
    { ...closed({ id: "A1", entry: 100, exit: 110, benchClose: 103 }), tags: { momentumActivated: true, qualityActivated: true } },
    // momentum but NOT quality → mom-quality-off
    { ...closed({ id: "A2", entry: 100, exit: 101, benchClose: 107 }), tags: { momentumActivated: true, qualityActivated: false } },
    // neither → mom-quality-off
    { ...closed({ id: "A3", entry: 100, exit: 102, benchClose: 106 }), tags: { momentumActivated: false, qualityActivated: false } },
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["mom-quality-on"].n, 1, "only the row with BOTH tags is on");
  assert.equal(perf.variants["mom-quality-on"].n + perf.variants["mom-quality-off"].n, perf.variants["all"].n, "on/off re-union to the tactical population");
  assert.ok(perf.variants["mom-quality-on"].alphaGrowthPct > 0);
});

test("bothTac: requires BOTH tactical tags; excludes position rows (interaction label, never a gate)", () => {
  assert.equal(bothTac({ tags: { momentumActivated: true, qualityActivated: true } }, "momentumActivated", "qualityActivated"), true);
  assert.equal(bothTac({ tags: { momentumActivated: true, qualityActivated: false } }, "momentumActivated", "qualityActivated"), false);
  assert.equal(bothTac({ tags: { mode: "position", momentumActivated: true, qualityActivated: true } }, "momentumActivated", "qualityActivated"), false, "position rows excluded");
});

test("scoreLedger: momentum-liquid-on isolates top-momentum names that also clear the liquidity floor", () => {
  const ledger = [
    // momentum AND liquid → on
    { ...closed({ id: "L1", entry: 100, exit: 112, benchClose: 104 }), tags: { momentumActivated: true, liquid: true } },
    // momentum but ILLIQUID → off (the artifact angle A warned about)
    { ...closed({ id: "L2", entry: 100, exit: 130, benchClose: 105 }), tags: { momentumActivated: true, liquid: false } },
    // not momentum → off
    { ...closed({ id: "L3", entry: 100, exit: 101, benchClose: 106 }), tags: { momentumActivated: false, liquid: true } },
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["momentum-liquid-on"].n, 1, "only the liquid momentum name is on");
  assert.equal(perf.variants["momentum-liquid-on"].n + perf.variants["momentum-liquid-off"].n, perf.variants["all"].n, "on/off re-union to the tactical population");
});

test("scoreLedger: votes-aligned partitions the tactical longs by the engine's self-conflict tag", () => {
  const ledger = [
    { ...closed({ id: "V1", entry: 100, exit: 108, benchClose: 104 }), tags: { votesConflict: false } },  // aligned
    { ...closed({ id: "V2", entry: 100, exit: 101, benchClose: 105 }), tags: { votesConflict: true } },    // conflicted
    { ...closed({ id: "V3", entry: 100, exit: 110, benchClose: 103 }), tags: {} },                          // no tag ⇒ treated aligned
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["votes-aligned-off"].n, 1, "only the conflicted row is off");
  assert.equal(perf.variants["votes-aligned-on"].n, 2, "aligned + untagged are on");
  assert.equal(perf.variants["votes-aligned-on"].n + perf.variants["votes-aligned-off"].n, perf.variants["all"].n, "on/off re-union to the tactical population");
});

test("scoreLedger: ic-backed partitions BUYs by whether proven votes carry ≥⅓ of the conviction", () => {
  const ledger = [
    { ...closed({ id: "I1", entry: 100, exit: 109, benchClose: 104 }), tags: { icBackedShare: 0.5 } },   // proven-driven
    { ...closed({ id: "I2", entry: 100, exit: 101, benchClose: 105 }), tags: { icBackedShare: 0.1 } },   // dead-vote-driven
    { ...closed({ id: "I3", entry: 100, exit: 110, benchClose: 103 }), tags: { icBackedShare: 0.33 } },  // boundary ⇒ on
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["ic-backed-on"].n, 2, "share ≥ 0.33 ⇒ on (incl. boundary)");
  assert.equal(perf.variants["ic-backed-off"].n, 1, "share < 0.33 ⇒ off");
  assert.equal(perf.variants["ic-backed-on"].n + perf.variants["ic-backed-off"].n, perf.variants["all"].n);
});

test("scoreLedger: empty ledger is honest, not a crash", () => {
  const perf = scoreLedger([]);
  assert.equal(perf.ledger.rows, 0);
  assert.equal(perf.ledger.benchmarkable, 0);
  assert.equal(perf.variants["all"].n, 0);
  assert.equal(perf.variants["all"].alphaGrowthPct, 0);
});

test("defaultVariants: covers all + grade + merit + momentum lenses", () => {
  const labels = defaultVariants().map(v => v.label);
  assert.ok(labels.includes("all"));
  assert.ok(labels.includes("grade-A"));
  assert.ok(labels.includes("merits-on"));
  assert.ok(labels.includes("momentum-on"));
  assert.ok(labels.includes("momentum-off"));
  assert.ok(labels.includes("news-pos-on"));
  assert.ok(labels.includes("news-quiet-on"));
  assert.ok(labels.includes("earnings-recent-on"));
});

// ─── statistics: incomplete beta, Student-t tail, one-sample t ────────────────
test("betai: symmetric base cases", () => {
  assert.ok(Math.abs(betai(0.5, 0.5, 0.5) - 0.5) < 1e-9); // I_0.5(½,½) = 0.5
  assert.equal(betai(2, 3, 0), 0);
  assert.equal(betai(2, 3, 1), 1);
});

test("tUpperP: t=0 is exactly half; large t → tiny p; matches a known value", () => {
  assert.ok(Math.abs(tUpperP(0, 10) - 0.5) < 1e-9);
  assert.ok(tUpperP(5, 20) < 0.001);
  assert.ok(tUpperP(-5, 20) > 0.999);
  // t=2.228, df=10 → two-sided 0.05 → one-sided upper ≈ 0.025
  assert.ok(Math.abs(tUpperP(2.228, 10) - 0.025) < 5e-4);
});

test("tTest: sample std uses n−1, t = mean / (std/√n)", () => {
  const r = tTest([1, 2, 3, 4, 5]); // mean 3, sample sd √2.5
  assert.equal(r.n, 5);
  assert.equal(r.mean, 3);
  assert.ok(Math.abs(r.std - Math.sqrt(2.5)) < 1e-12);
  assert.equal(r.df, 4);
  assert.ok(Math.abs(r.t - 3 / (Math.sqrt(2.5) / Math.sqrt(5))) < 1e-12);
});

// ─── significance with multiple-testing correction ───────────────────────────
// Build a synthetic perf object straight from per-variant alpha arrays so the
// statistics are exercised in isolation from the price→alpha plumbing.
function perfFrom(variantAlphas) {
  const variants = {};
  for (const [label, alphas] of Object.entries(variantAlphas)) {
    const mean = alphas.length ? alphas.reduce((a, b) => a + b, 0) / alphas.length : null;
    variants[label] = {
      n: alphas.length,
      legs: alphas.map((a, i) => ({ id: label + i, alphaPct: a })),
      meanAlphaPerTrade: mean == null ? null : parseFloat(mean.toFixed(4)),
      alphaGrowthPct: mean == null ? 0 : parseFloat(mean.toFixed(4)),
    };
  }
  return { variants };
}

test("attachSignificance: a strong, low-variance positive variant is promotable", () => {
  const strong = Array.from({ length: 12 }, (_, i) => 2 + (i % 2 ? 0.1 : -0.1)); // ~+2, tiny noise
  const perf = attachSignificance(perfFrom({ all: strong }));
  const s = perf.variants.all.significance;
  assert.equal(s.n, 12);
  assert.ok(s.tStat > 5);
  assert.ok(s.qBH < 0.05);
  assert.equal(s.verdict, "SIGNIFICANT");
  assert.equal(s.promotable, true);
  assert.equal(s.provenLoser, false);
});

test("attachSignificance: under-powered variant is TOO FEW and stays OUT of the family", () => {
  const perf = attachSignificance(perfFrom({
    big: Array.from({ length: 12 }, () => 2),
    tiny: [5, 5, 5], // only 3 trades — not testable
  }));
  assert.equal(perf.variants.tiny.significance.verdict, "TOO FEW TRADES");
  assert.equal(perf.variants.tiny.significance.inFamily, false);
  assert.equal(perf.multipleTesting.familySize, 1); // only "big" entered the correction
  assert.ok(!perf.multipleTesting.family.includes("tiny"));
});

test("attachSignificance: a significantly NEGATIVE variant is flagged a proven loser", () => {
  const losers = Array.from({ length: 12 }, (_, i) => -2 + (i % 2 ? 0.1 : -0.1));
  const perf = attachSignificance(perfFrom({ bad: losers }));
  const s = perf.variants.bad.significance;
  assert.equal(s.verdict, "PROVEN LOSER");
  assert.equal(s.provenLoser, true);
  assert.equal(s.promotable, false);
});

test("attachSignificance: FDR penalizes a modest variant tested among many nulls", () => {
  // "a" alone clears raw p<0.05, but it's screened alongside 5 zero-mean nulls.
  // With a family of 6, Benjamini-Hochberg multiplies the smallest p by 6 → no
  // promotion. This is exactly the protection against picking the luckiest lens.
  const a = [3, -1, 2, 0, 3, -1, 2, 1, 2, 0, 3, -1];   // raw t≈2.3, p≈0.02
  const nulls = {};
  for (let k = 0; k < 5; k++) nulls["n" + k] = Array.from({ length: 12 }, (_, i) => (i % 2 ? 1 : -1));
  const perf = attachSignificance(perfFrom({ a, ...nulls }));
  const s = perf.variants.a.significance;
  assert.ok(s.pUpper < 0.05, "raw p would look significant on its own");
  assert.equal(perf.multipleTesting.familySize, 6);
  assert.equal(s.promotable, false, "but FDR across 6 lenses withholds promotion");
  assert.ok(s.qBH >= 0.05);
  assert.ok(s.qBY >= s.qBH - 1e-9); // BY is at least as strict as BH
});

test("scoreLedger: thin real ledger yields TOO FEW, never a false promotion", () => {
  const ledger = [
    closed({ id: "A", entry: 100, exit: 106, benchClose: 102, grade: "A" }),
    closed({ id: "B", entry: 100, exit: 104, benchClose: 101, grade: "A" }),
  ];
  const perf = scoreLedger(ledger);
  assert.equal(perf.variants["grade-A"].significance.verdict, "TOO FEW TRADES");
  assert.equal(perf.variants["grade-A"].significance.promotable, false);
  assert.equal(perf.multipleTesting.familySize, 0);
  assert.ok(/not enough evidence/i.test(perf.multipleTesting.note));
});

// ─── markToMarket now captures the benchmark reference (exit-bar close) ────────
test("markToMarket: records benchClose = close of the exit bar", () => {
  const openTrade = {
    id: "X-1day-2026-01-10-BUY", ticker: "X", interval: "1day", signal: "BUY",
    entry: 100, sl: 98, tp1: 104, tp2: 110, status: "OPEN",
    dataAsOf: { date: "2026-01-10", close: 100 },
  };
  const bar = (date, high, low, close) => ({ date, open: 100, high, low, close });
  const settled = [
    bar("2026-01-10", 105, 99, 100),    // entry day — ignored (no lookahead)
    bar("2026-01-11", 101, 100, 100.5), // no touch
    bar("2026-01-12", 106, 101, 103),   // high ≥ tp1 → WIN; bench holds to close 103
  ];
  const out = markToMarket(openTrade, settled, "2026-01-12T22:00:00Z");
  assert.equal(out.status, "WIN");
  assert.equal(out.exit, 104);          // exited at the TP touch
  assert.equal(out.benchClose, 103);    // benchmark held to the exit bar's close
  // sanity: strat (+4 gross) beat buy-&-hold (+3) here
  const a = tradeAlpha(out, 0);
  assert.ok(a.alphaPct > 0);
});
