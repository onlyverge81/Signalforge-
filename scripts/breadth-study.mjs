// Build breadth-study.json — the "Show of Hands" breadth-consensus research harness.
// Run on-demand (workflow_dispatch); prints a rollup to the job log + uploads the JSON artifact.
// IN-SAMPLE measurement on real Polygon history, NOT a promotion and NOT wired into any gate.
//
// The question (the user's hypothesis): at a bar, count how many "instruments" (the engine's votes +
// candle features) point the same way — does a SUM of agreeing instruments over a duration ("13 of the
// last 23 were green") separate CLEAR directional expectancy from NOISE, and is there a QUORUM threshold
// where consensus is tradeable? And does VOLUME (RVOL) make a difference — rule it in or out?
//
// THE REFRAME (the thesis, confirmed with the user): "13 of 23 green → buy" is right as an OBSERVATION,
// but the engine's ~23 instruments are NOT 23 independent witnesses. The factor-interaction PCA proved
// 8 selectors collapse to ~5.3 effective bets / ~3 economic axes; MA/MAlong/Trend move as one, RSI/Stoch/BB
// move as one and OPPOSE the trend camp in chop (famConflict). So a naive "13 green" can be ONE CAMP
// SHOUTING IN UNISON — the very mechanism behind the engine's measured t ≈ −12.6. The real signal is not
// HOW MANY hands agree but WHETHER INSTRUMENTS THAT NORMALLY DISAGREE SUDDENLY AGREE. The study therefore
// climbs a ladder of instrument SETS and compares them head-to-head:
//   SET1 raw-13         — the literal headcount of the 13 SIGNALS-tab votes (voteVector).
//   SET2 expanded ~23   — each candle pattern as its OWN hand (the user's literal "23 instruments").
//   SET3 proven-subset  — only the votes the pie's robustness probes RESCUED (Trend, Vol, BB + momentum).
//   SET4 cross-camp     — agreement between the two NORMALLY-OPPOSED families (trend camp vs mean-reversion
//                         camp). |net|=2 means the rare cross-axis quorum the thesis predicts is informative.
// If SET4 / SET3 carry a cleaner forward-return curve than the raw SET1/SET2 headcount, the reframe is
// confirmed IN-SAMPLE: it's a quorum of independents, not a show of hands.
//
// Method (all lookahead-controlled, charter-clean — Polygon BARS only, no SEC/Yahoo/fallback):
//  • Polygon adjusted DAILY closes; survivorship-free roster.json universe (reusing selectMeritUniverse).
//  • LIQUID default surface (R3): clearsLiquidityBar drops perpetual micro-cap junk; FULL roster is an
//    opt-in bias cross-check (BREADTH_UNIVERSE=full).
//  • Per name, per bar (point-in-time, slice ≤ bar): the four SETS' net agreement; the trailing-D windowed
//    "green count"; the RVOL. Forward target = the H-bar forward return (only COMPLETE windows — no-lookahead).
//  • Curves: forward-return expectancy bucketed by agreement COUNT (net), by RATIO bins, and by the windowed
//    green-fraction. The QUORUM = the lowest bucket whose mean is positive AND significant.
//  • THE VOLUME TEST: within the high-consensus rows, split RVOL≥1.5 vs <1.5 and compare — indistinguishable
//    means → volume RULED OUT (consensus carries it); a materially cleaner high-RVOL curve → RULED IN.
//
// Honesty (binding): in-sample is NEVER the verdict. An attractive curve is "looks good in-sample," not
// proven. The technical core is a MEASURED in-sample loser (baseline t ≈ −12.6), and the build-up geometry
// it rides is itself a measured loser (≈ −0.71%); thin/negative slices are the honest finding. ⅔ is an
// a-priori STRUCTURAL quorum, never tuned to in-sample expectancy. Only the OOS ledger, cleared through the
// BH/BY FDR family, makes the breadth-quorum / breadth-vol labels tradeable.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { selectMeritUniverse } from "./build-study.mjs";
import { momentumValue } from "./forward-log.mjs";
import { assessSignificance, overlapAdjustedT } from "./study-lib.mjs";
import { relVolSeries, patterns } from "./engine.mjs";
import { voteVector, clearsLiquidityBar } from "./factor-interaction-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BREADTH_MAX  = +(process.env.BREADTH_MAX  || 40);   // names cap (runtime)
const BREADTH_BARS = +(process.env.BREADTH_BARS || 750);  // most-recent bars per name (runtime cap)
const VOTE_WARM    = 60;                                   // bars before votes/indicators are trustworthy
const D_WINDOW     = +(process.env.BREADTH_WIN  || 20);    // "of the last ~20" consensus window
const HZ           = [5, 10];                              // forward horizons (trading days) — short swing
const RVOL_HI      = 1.5;                                  // conviction threshold (RVOL ≥ 1.5)
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;
const pct   = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e6) / 1e4;   // → percent, 4dp

// The 13 SIGNALS-tab votes and the two opposing families (engine computeSignal camps).
export const VOTE_NAMES   = ["RSI","MACD","MA","MAlong","Trend","Stoch","BB","Pat","Div","Vol","ADX","OBV","VWAP"];
export const TREND_CAMP   = ["MA","MAlong","Trend","MACD"];      // trend-following family
export const MEANREV_CAMP = ["RSI","Stoch","BB"];               // mean-reversion family (rescued as timers, angle F)
export const PROVEN_VOTES = ["Trend","Vol","BB"];               // pie-robust survivors (+ momentum, added below)

// ─── pure consensus primitives ───────────────────────────────────────────────

// Directional show-of-hands over a chosen key set. votes is {name:−1|0|+1}; keys the subset to count.
// bull = #(+1), bear = #(−1), active = bull+bear, net = bull−bear, ratio = bull/active (null if none active).
export function tally(votes, keys){
  let bull = 0, bear = 0;
  for(const k of keys){ const v = votes && votes[k]; if(v === 1) bull++; else if(v === -1) bear++; }
  const active = bull + bear;
  return { bull, bear, active, net: bull - bear, ratio: active ? bull / active : null };
}

// Each detected candle pattern as its OWN hand (the user's literal "23 instruments"): bullish +1,
// bearish −1, doji/neutral abstains (0, i.e. omitted). Keyed by pattern name so each speaks separately.
export function patternHands(data){
  const out = {};
  for(const p of (patterns(data) || [])){
    if(p.type === "BULLISH") out[p.name] = 1;
    else if(p.type === "BEARISH") out[p.name] = -1;
  }
  return out;
}

// SET2: the raw 13 votes MINUS the single collapsed Pat vote, PLUS each pattern as its own hand.
export function expandedVotes(vv, data){
  const v = { ...vv }; delete v.Pat;
  return { ...v, ...patternHands(data) };
}

// SET3: only the votes the pie's robustness probes RESCUED — Trend, Vol, BB (BB rescued by angle F as a
// mean-reversion timer) plus the one factor that survived the liquidity screen, momentum-12-1's sign.
export function provenVotes(vv, slice){
  const m = momentumValue(slice);
  const v = { Trend: vv.Trend ?? 0, Vol: vv.Vol ?? 0, BB: vv.BB ?? 0 };
  if(m != null && isFinite(m)) v.Mom = m > 0 ? 1 : m < 0 ? -1 : 0;
  return v;
}

// SET4: the two NORMALLY-OPPOSED families collapsed to one direction each (trend camp vs mean-reversion
// camp). When they AGREE (|net|=2) the rare cross-axis quorum the thesis predicts is present — not "13
// correlated votes shouting", but two independent witnesses that usually disagree converging.
export function campVotes(vv){
  const sumSign = keys => { let s = 0; for(const k of keys){ const x = vv && vv[k]; if(x === 1) s++; else if(x === -1) s--; } return s > 0 ? 1 : s < 0 ? -1 : 0; };
  return { TrendCamp: sumSign(TREND_CAMP), MeanRevCamp: sumSign(MEANREV_CAMP) };
}

// All four SETS' {bull,bear,active,net,ratio} for one slice, given a precomputed voteVector.
export const SET_NAMES = ["raw13","expanded","proven","camps"];
export function setTallies(vv, slice){
  const present = VOTE_NAMES.filter(k => vv[k] !== undefined);
  const exp = expandedVotes(vv, slice);
  const prov = provenVotes(vv, slice);
  const camp = campVotes(vv);
  return {
    raw13:    tally(vv,   present),
    expanded: tally(exp,  Object.keys(exp)),
    proven:   tally(prov, Object.keys(prov)),
    camps:    tally(camp, Object.keys(camp)),
  };
}

// Trailing-D windowed "green count" over a precomputed per-bar net series: how many of the D bars ending
// at i had a NET-bullish consensus (net > 0). No-lookahead — reads only netSeries[≤ i]. Pure.
export function windowedConsensus(netSeries, i, D = D_WINDOW){
  const lo = Math.max(0, i - D + 1);
  let green = 0, n = 0;
  for(let j = lo; j <= i; j++){ if(netSeries[j] == null) continue; n++; if(netSeries[j] > 0) green++; }
  return { greenBars: green, D: n, frac: n ? green / n : null };
}

// Bucket a set of decision rows by an integer KEY (net agreement count), summarising the forward return.
// rows: [{key, fwd, rvol}]. Returns ascending buckets [{bucket,n,meanPct,t,posRate}].
export function bucketByCount(rows, { field = "fwd" } = {}){
  const by = new Map();
  for(const r of rows){ if(r.key == null) continue; if(!by.has(r.key)) by.set(r.key, []); by.get(r.key).push(r[field]); }
  return [...by.keys()].sort((a, b) => a - b).map(k => {
    const xs = by.get(k).filter(v => v != null && isFinite(v));
    const st = assessSignificance(xs);
    return { bucket: k, n: xs.length, meanPct: pct(st.mean), t: round(st.t), posRate: round(xs.filter(v => v > 0).length / (xs.length || 1)) };
  });
}

// Bucket decision rows by RATIO (or windowed green-FRACTION) into [lo,hi) bins. rows:[{val,fwd}].
export function bucketByBins(rows, bins, { field = "fwd" } = {}){
  return bins.slice(0, -1).map((lo, i) => {
    const hi = bins[i + 1];
    const xs = rows.filter(r => r.val != null && r.val >= lo && (i === bins.length - 2 ? r.val <= hi : r.val < hi))
                   .map(r => r[field]).filter(v => v != null && isFinite(v));
    const st = assessSignificance(xs);
    return { lo, hi, n: xs.length, meanPct: pct(st.mean), t: round(st.t), posRate: round(xs.filter(v => v > 0).length / (xs.length || 1)) };
  });
}

// The QUORUM: the lowest ASCENDING bucket whose mean forward return is positive AND significant
// (t ≥ 2), with the curve non-decreasing up to it. In-sample only — a POINTER, never a set threshold.
export function quorumFrom(curve){
  for(let i = 0; i < curve.length; i++){
    const c = curve[i];
    if(c.n >= 5 && c.meanPct != null && c.meanPct > 0 && c.t != null && c.t >= 2){
      return { found: true, at: c.bucket ?? c.lo, meanPct: c.meanPct, t: c.t, n: c.n };
    }
  }
  return { found: false };
}

// THE VOLUME TEST: within the HIGH-consensus rows (key ≥ hiKey), split RVOL≥hi vs <hi and compare the
// forward-return means + t. Indistinguishable → volume RULED OUT (consensus carries it); a materially
// cleaner, significant high-RVOL leg → RULED IN. Pure.
export function volumeTest(rows, { hiKey, rvolHi = RVOL_HI } = {}){
  const hot = rows.filter(r => r.key != null && r.key >= hiKey && r.fwd != null && isFinite(r.fwd));
  const high = hot.filter(r => r.rvol != null && r.rvol >= rvolHi).map(r => r.fwd);
  const low  = hot.filter(r => r.rvol != null && r.rvol <  rvolHi).map(r => r.fwd);
  const sh = assessSignificance(high), sl = assessSignificance(low);
  const gap = (sh.mean != null && sl.mean != null) ? sh.mean - sl.mean : null;
  // RULED IN only if the high-RVOL leg is itself significant AND beats the low-RVOL leg by a real margin.
  const ruledIn = !!(gap != null && gap > 0 && sh.t != null && sh.t >= 2 && Math.abs(gap) > 0.002);
  return {
    hiKey, rvolHi, nHigh: high.length, nLow: low.length,
    highMeanPct: pct(sh.mean), highT: round(sh.t), lowMeanPct: pct(sl.mean), lowT: round(sl.t),
    gapPct: pct(gap),
    verdict: (high.length < 10 || low.length < 10) ? "INCONCLUSIVE (thin)" : ruledIn ? "VOLUME RULED IN" : "VOLUME RULED OUT (consensus carries it)",
  };
}

// ─── per-name panel: contiguous net series per SET + decision rows with forward returns ──────────────
// No-lookahead: every per-bar value reads slice(0, j+1); the forward target reads series[i+H] and the row
// is only emitted when that bar exists (complete window). The windowed consensus reads netSeries[≤ i].
export function buildNameRows(series, { d = D_WINDOW, warm = VOTE_WARM } = {}){
  const n = series.length;
  const net = {}; for(const s of SET_NAMES) net[s] = new Array(n).fill(null);
  const inst = {}; for(const s of SET_NAMES) inst[s] = new Array(n).fill(null);  // {net,ratio} at the bar
  const { rvol } = relVolSeries(series, 20);
  for(let j = warm; j < n; j++){
    const slice = series.slice(0, j + 1);
    const vv = voteVector(slice);
    const t = setTallies(vv, slice);
    for(const s of SET_NAMES){ net[s][j] = t[s].net; inst[s][j] = { net: t[s].net, ratio: t[s].ratio }; }
  }
  const rows = {};                                    // per (set × horizon) decision rows
  for(const s of SET_NAMES) for(const H of HZ) rows[`${s}_${H}`] = [];
  for(let i = warm + d; i < n; i++){
    for(const H of HZ){
      const k = i + H;
      if(k >= n) continue;
      const entry = series[i].close, exit = series[k].close;
      if(!(entry > 0) || !(exit > 0)) continue;
      const fwd = exit / entry - 1;
      const rv = rvol[i];
      for(const s of SET_NAMES){
        const win = windowedConsensus(net[s], i, d);
        rows[`${s}_${H}`].push({
          key: inst[s][i] ? inst[s][i].net : null,    // instantaneous net agreement count (the headcount)
          ratio: inst[s][i] ? inst[s][i].ratio : null,
          windowFrac: win.frac,                       // trailing-D green fraction (the "13 of 23" reading)
          fwd, rvol: rv,
        });
      }
    }
  }
  return rows;
}

// Ratio / windowed-fraction bins shared across sets ("verify-first" supermajority breakpoints).
export const RATIO_BINS = [0.5, 0.6, 2 / 3, 0.75, 0.9, 1.0001];

// ─── universe + fetch (mirrors factor-interaction-study) ─────────────────────
function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, BREADTH_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return { tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${BREADTH_MAX})`,
        survivorshipFree: true };
    }
  }catch{ /* no roster yet → fall back */ }
  return { tickers: readTickers().slice(0, BREADTH_MAX),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)", survivorshipFree: false };
}

async function fetchDaily(sym, key){
  const candles = await fetchPolygonAggs(sym, "1day", key, { minBars: VOTE_WARM + D_WINDOW + 30 });
  return candles.map(c => ({ t: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.t - b.t);
}

function caveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), capped to BREADTH_MAX for runtime — de-listed losers INCLUDED."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias inflates any positive result; run universe-build for roster.json.",
    "THE REFRAME: the 13 votes are NOT 13 independent witnesses (PCA: ~3 economic axes). SET1/SET2 are the naive HEADCOUNT; SET3 (pie-robust survivors) and SET4 (the two normally-opposed camps agreeing) test whether a QUORUM OF INDEPENDENTS beats it. SET4 |net|=2 is the rare cross-camp agreement the thesis predicts is informative.",
    "⅔ supermajority is an A-PRIORI STRUCTURAL breakpoint (in RATIO_BINS), never tuned to in-sample expectancy — the study CONFIRMS a quorum, it never SETS one. Tuning the threshold to the curve would be the in-sample re-wire R6 forbids.",
    "Forward windows are COMPLETE-only (no-lookahead): every per-bar vote/RVOL reads slice ≤ bar; the H-bar forward return reads a bar strictly after the decision bar. The windowed 'green count' reads only the trailing D nets.",
    "Per-name runtime caps (BREADTH_BARS most-recent bars, BREADTH_MAX names) bound the O(bars²) per-bar vote recompute — a research approximation, not a full-history measurement.",
    "The technical confluence is a MEASURED in-sample loser (baseline t ≈ −12.6) and the build-up geometry it rides is itself a measured loser (≈ −0.71%). A high green-count can be one correlated camp, not conviction — expect raw SET1/SET2 to look noisy. That is the honest finding, not a bug.",
    "IN-SAMPLE only — a clean breadth curve is 'looks good in-sample,' NOT proven. Only the OOS breadth-quorum-on / breadth-vol-on ledger, cleared through the BH/BY FDR family at the locked R1 bar, is tradeable evidence.",
  ];
}

function bar(t){ const n = Math.max(0, Math.min(25, Math.round((Math.abs(t || 0)) * 4))); return "█".repeat(n) + "·".repeat(25 - n); }

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY — the breadth study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source, survivorshipFree } = resolveUniverse();
  console.log("breadth universe: " + source);

  const barsByTicker = {}; const errors = [];
  for(const sym of tickers){
    try{
      let bars = await fetchDaily(sym, key);
      if(bars.length < VOTE_WARM + D_WINDOW + 30) throw new Error(`only ${bars.length} bars`);
      if(bars.length > BREADTH_BARS) bars = bars.slice(bars.length - BREADTH_BARS);   // runtime cap (most-recent)
      barsByTicker[sym] = bars;
      console.log("✓ " + sym.padEnd(6) + " " + bars.length + " daily bars");
    }catch(e){ errors.push(sym + ": " + (e.message || e)); console.warn("✗ " + sym.padEnd(6) + " — " + (e.message || e)); }
  }

  const fullUniverse = process.env.BREADTH_UNIVERSE === "full";
  let droppedIlliquid = 0;
  if(!fullUniverse){
    for(const sym of Object.keys(barsByTicker)){ if(!clearsLiquidityBar(barsByTicker[sym])){ delete barsByTicker[sym]; droppedIlliquid++; } }
    console.log("liquid screen: kept " + Object.keys(barsByTicker).length + ", dropped " + droppedIlliquid + " illiquid. Set BREADTH_UNIVERSE=full for the bias cross-check.");
  } else console.log("universe: FULL survivorship-free roster (bias cross-check) — liquid screen OFF.");

  // Pool every name's decision rows per (set × horizon).
  const pooled = {}; for(const s of SET_NAMES) for(const H of HZ) pooled[`${s}_${H}`] = [];
  let names = 0;
  for(const [sym, bars] of Object.entries(barsByTicker)){
    const rows = buildNameRows(bars);
    for(const k of Object.keys(rows)) pooled[k].push(...rows[k]);
    names++;
    if(names % 5 === 0) console.log("  …consensus computed for " + names + " names");
  }

  // Build the curves + quorum + volume test for every set, at the primary horizon (HZ[0]).
  const Hp = HZ[0];
  const sets = {};
  for(const s of SET_NAMES){
    const rows = pooled[`${s}_${Hp}`];
    const countCurve  = bucketByCount(rows);
    const ratioCurve  = bucketByBins(rows.map(r => ({ val: r.ratio, fwd: r.fwd })), RATIO_BINS);
    const windowCurve = bucketByBins(rows.map(r => ({ val: r.windowFrac, fwd: r.fwd })), RATIO_BINS);
    const quorum = quorumFrom(countCurve);
    // High-consensus = top half of the observed net range (≥ ceil(maxNet/2)), min 2.
    const maxNet = rows.reduce((m, r) => r.key != null && r.key > m ? r.key : m, 0);
    const hiKey = Math.max(2, Math.ceil(maxNet / 2));
    const vol = volumeTest(rows, { hiKey });
    // Consensus conversion rate at/above the structural ⅔ supermajority (≥3 active hands, ratio ≥ ⅔).
    const quorumRows = rows.filter(r => r.key != null && (r.key) >= 3 - 0 && r.ratio != null && r.ratio >= 2 / 3 && r.fwd != null);
    const convN = quorumRows.length, convPos = quorumRows.filter(r => r.fwd > 0).length;
    sets[s] = {
      rows: rows.length,
      countCurve, ratioCurve, windowCurve, quorum,
      volumeTest: vol,
      consensusConversion: { definition: "≥3 active hands AND ratio ≥ ⅔ (structural)", n: convN, positiveRate: round(convN ? convPos / convN : null) },
    };
  }

  const out = {
    generatedAt: new Date().toISOString(),
    thesis: "Show of hands → quorum of independents: the real signal is whether normally-opposed instruments agree, not how many hands are green.",
    universe: { requested: tickers.length, covered: Object.keys(barsByTicker).length, source, survivorshipFree,
      screen: fullUniverse ? "FULL survivorship-free roster (bias cross-check)" : `LIQUID default (${droppedIlliquid} illiquid dropped)`, skipped: errors },
    config: { window: D_WINDOW, horizons: HZ, primaryHorizon: Hp, rvolHigh: RVOL_HI, ratioBins: RATIO_BINS, barsCap: BREADTH_BARS, voteWarm: VOTE_WARM },
    sets,
    interpretation: {
      ladder: "Compare SET1 raw-13 / SET2 expanded (the HEADCOUNT) vs SET3 proven / SET4 camps (the QUORUM OF INDEPENDENTS). If SET3/SET4 carry a cleaner, more significant curve, the reframe holds in-sample.",
      crossCampQuorum: "SET4 |net|=2 = both the trend camp AND the mean-reversion camp agree — the rare cross-axis convergence the thesis predicts is informative (not explainable as one camp / beta).",
    },
    caveats: caveats(survivorshipFree),
  };

  fs.writeFileSync(path.join(ROOT, "breadth-study.json"), JSON.stringify(out) + "\n");
  console.log("\nbreadth-study.json written.");

  // Job-log rollup.
  console.log("\n── BREADTH (show-of-hands) — primary horizon " + Hp + "d, " + names + " names ──");
  for(const s of SET_NAMES){
    const S = sets[s];
    console.log("\n[" + s + "]  rows=" + S.rows + (S.quorum.found ? ("  quorum@net≥" + S.quorum.at + " mean=" + S.quorum.meanPct + "% t=" + S.quorum.t) : "  quorum: none significant"));
    for(const c of S.countCurve) console.log("  net=" + String(c.bucket).padStart(3) + " n=" + String(c.n).padStart(5) + " mean=" + String(c.meanPct).padStart(7) + "% t=" + String(c.t).padStart(6) + " " + bar(c.t));
    console.log("  VOLUME: " + S.volumeTest.verdict + " (high " + S.volumeTest.highMeanPct + "%/t" + S.volumeTest.highT + " vs low " + S.volumeTest.lowMeanPct + "%/t" + S.volumeTest.lowT + ", gap " + S.volumeTest.gapPct + "%)");
    console.log("  ⅔-conversion: " + S.consensusConversion.positiveRate + " positive over n=" + S.consensusConversion.n);
  }
  console.log("\nIN-SAMPLE pointer only — the OOS breadth-quorum-on / breadth-vol-on ledger under FDR is the arbiter.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
