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
  const perf = {
    generatedAt: new Date().toISOString(),
    method: "matched-window buy-&-hold; alpha = strategy net − benchmark net (cost-invariant)",
    costPerTrade,
    ledger: { rows: rows.length, closed: closedTotal, benchmarkable },
    variants: variantsOut,
  };
  return attachSignificance(perf);
}

// ─── Significance, multiple-testing-corrected ─────────────────────────────────
// With 8 variant lenses, the best-looking one will look good by luck. A positive
// alpha is necessary, not sufficient: we ask whether each variant's per-trade
// alpha series (a PAIRED difference — strategy minus its own benchmark over the
// same window) is significantly above zero, then correct for how many lenses we
// tried. Promotion uses Benjamini-Hochberg FDR (controls the false-discovery
// proportion among the variants we promote); Benjamini-Yekutieli is reported as a
// stricter cross-check, valid under ARBITRARY dependence — which matters here,
// because the variants overlap (grade buckets nest inside "all"; merits-on/off
// partition it). "Demote fast, promote slow": a variant must clear FDR to be
// promotable, but a significantly NEGATIVE alpha flags it a proven loser at once.

export const MIN_TRADES_SIG = 10;   // below this, forward data is too thin to test
export const Q_SIGNIFICANT = 0.05;  // FDR gate to call a variant promotable
export const Q_SUGGESTIVE = 0.10;   // FDR gate for "worth watching", not yet promotable

// Lanczos log-gamma and the regularized incomplete beta (Numerical Recipes) — the
// minimal kit for an exact Student-t tail without pulling in a stats dependency.
function gammaln(x) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091,
    -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) { y++; ser += c[j] / y; }
  return -tmp + Math.log(2.5066282746310005 * ser / x);
}
function betacf(a, b, x) {
  const MAXIT = 200, EPS = 3e-12, FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - qab * x / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d; let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}
export function betai(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
}

// One-sided upper-tail p-value P(T ≥ t) for Student-t with df degrees of freedom.
// pUpper answers "is mean alpha > 0?" (promotion); pLower answers "< 0?" (demote).
export function tUpperP(t, df) {
  if (!(df > 0)) return null;
  const p2 = betai(df / 2, 0.5, df / (df + t * t)); // two-sided P(|T| > |t|)
  return t >= 0 ? p2 / 2 : 1 - p2 / 2;
}

// Sample mean, sample std (n−1: honest small-sample inference), and one-sample t.
export function tTest(xs) {
  const n = xs.length;
  if (n < 2) return { n, mean: n ? xs[0] : null, std: null, t: null, df: null };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, b) => a + (b - mean) ** 2, 0);
  const std = Math.sqrt(ss / (n - 1));
  const se = std / Math.sqrt(n);
  const t = se > 0 ? mean / se : (mean === 0 ? 0 : Infinity * Math.sign(mean));
  return { n, mean, std, t, df: n - 1 };
}

// Benjamini-Hochberg step-up adjusted p-values (q-values). c = harmonic factor
// for Benjamini-Yekutieli (arbitrary-dependence valid); pass c = sum_{i=1..m}(1/i)
// to get BY, or c = 1 for BH. Returns q in the ORIGINAL input order.
function fdrAdjust(pvals, c = 1) {
  const m = pvals.length;
  if (!m) return [];
  const order = pvals.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k--) {
    const raw = order[k].p * m * c / (k + 1);
    prev = Math.min(prev, raw);
    q[order[k].i] = Math.min(prev, 1);
  }
  return q;
}

// Attach significance to a scored-perf object. Builds the multiple-testing family
// from variants with enough trades (MIN_TRADES_SIG); under-powered ones are honestly
// marked TOO FEW and kept OUT of the correction (testing thin buckets and counting
// them would distort the FDR). Returns the same object with per-variant sig fields
// and a top-level multipleTesting summary.
export function attachSignificance(perf, opts = {}) {
  const minN = opts.minTrades ?? MIN_TRADES_SIG;
  const entries = Object.entries(perf.variants);

  // 1) per-variant t-test on the paired alpha series
  const stat = {};
  for (const [label, v] of entries) {
    const alphas = (v.legs || []).map(l => l.alphaPct);
    const tt = tTest(alphas);
    const pUpper = tt.df ? tUpperP(tt.t, tt.df) : null;
    const pLower = tt.df ? tUpperP(-tt.t, tt.df) : null;
    stat[label] = { tt, pUpper, pLower };
  }

  // 2) multiple-testing family = variants with n ≥ minN and a defined p
  const family = entries
    .map(([label]) => label)
    .filter(label => stat[label].tt.n >= minN && stat[label].pUpper != null);
  const m = family.length;
  const harmonic = Array.from({ length: m }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);

  const qUpBH = fdrAdjust(family.map(l => stat[l].pUpper), 1);
  const qUpBY = fdrAdjust(family.map(l => stat[l].pUpper), harmonic);
  const qDnBH = fdrAdjust(family.map(l => stat[l].pLower), 1);
  const qOf = (arr, label) => { const k = family.indexOf(label); return k < 0 ? null : round(arr[k]); };

  // 3) verdict per variant
  for (const [label, v] of entries) {
    const { tt, pUpper, pLower } = stat[label];
    const inFamily = family.includes(label);
    const qBH = qOf(qUpBH, label), qBY = qOf(qUpBY, label), qNegBH = qOf(qDnBH, label);
    const meanAlpha = v.meanAlphaPerTrade;

    let verdict, promotable = false, provenLoser = false;
    if (tt.n < minN) {
      verdict = "TOO FEW TRADES";
    } else if (meanAlpha > 0 && qBH != null && qBH < Q_SIGNIFICANT) {
      verdict = "SIGNIFICANT"; promotable = true;
    } else if (meanAlpha > 0 && qBH != null && qBH < Q_SUGGESTIVE) {
      verdict = "SUGGESTIVE";
    } else if (meanAlpha < 0 && qNegBH != null && qNegBH < Q_SIGNIFICANT) {
      verdict = "PROVEN LOSER"; provenLoser = true;
    } else {
      verdict = "NOT SIGNIFICANT";
    }

    v.significance = {
      n: tt.n,
      meanAlpha: round(meanAlpha),
      tStat: round(tt.t),
      df: tt.df,
      pUpper: round(pUpper),
      pLower: round(pLower),
      qBH, qBY, qNegBH,
      inFamily,
      verdict,
      promotable,          // cleared FDR on the positive side → eligible to promote
      provenLoser,         // significantly negative alpha → demote candidate
    };
  }

  perf.multipleTesting = {
    method: "Benjamini-Hochberg FDR (promotion); Benjamini-Yekutieli reported as arbitrary-dependence cross-check",
    minTrades: minN,
    familySize: m,
    family,
    qSignificant: Q_SIGNIFICANT,
    qSuggestive: Q_SUGGESTIVE,
    note: m === 0
      ? "No variant has enough forward trades yet to test — the honest verdict is 'not enough evidence', not zero."
      : `${m} variant(s) had enough trades to enter the correction.`,
  };
  return perf;
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
  console.log(`  ${pad("variant", 12)} ${padN("n", 4)} ${padN("alpha%", 9)} ${padN("t", 7)} ${padN("qBH", 8)} ${padN("qBY", 8)}  verdict`);
  console.log(`  ${"-".repeat(12)} ${"-".repeat(4)} ${"-".repeat(9)} ${"-".repeat(7)} ${"-".repeat(8)} ${"-".repeat(8)}  ${"-".repeat(15)}`);
  for (const [label, v] of Object.entries(perf.variants)) {
    const s = v.significance || {};
    if (!v.n) { console.log(`  ${pad(label, 12)} ${padN(0, 4)} ${padN("—", 9)} ${padN("—", 7)} ${padN("—", 8)} ${padN("—", 8)}  ${s.verdict || "TOO FEW TRADES"}`); continue; }
    const sign = v.alphaGrowthPct > 0 ? "+" : "";
    const fmt = x => (x == null ? "—" : x);
    const flag = s.promotable ? " ✓PROMOTABLE" : s.provenLoser ? " ✗LOSER" : "";
    console.log(`  ${pad(label, 12)} ${padN(v.n, 4)} ${padN(sign + v.alphaGrowthPct, 9)} ${padN(fmt(s.tStat), 7)} ${padN(fmt(s.qBH), 8)} ${padN(fmt(s.qBY), 8)}  ${s.verdict}${flag}`);
  }
  const mt = perf.multipleTesting || {};
  console.log(`\n  alpha% = compounded net (strat − buy&hold, cost-invariant); t on the paired per-trade alpha series.`);
  console.log(`  qBH = Benjamini-Hochberg FDR across ${mt.familySize || 0} testable variant(s); qBY = arbitrary-dependence cross-check.`);
  console.log(`  Promotable ⇔ alpha>0 AND qBH<${Q_SIGNIFICANT}. ${mt.note || ""}`);
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
