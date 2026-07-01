// Build trajectory-fizzle-study.json — the "sweet-spot + when-to-enter/exit" study the user asked for.
// Run on-demand (workflow_dispatch); prints a rollup to the job log + uploads the JSON (opt-in commit).
// IN-SAMPLE measurement on real Polygon history, NOT a promotion and NOT wired into any gate.
//
// Three questions, one harness (all reuse the EXACT engine functions the ESD tab + convergence monitor run):
//
//  A · ESD LAUNCH-FINGERPRINT SWEET SPOT — the ESD "launch fingerprint" (Position below · Leaning up · Angle°
//      · Curvature · Separation ATR) has a hand-set baseline (20° / 0.5 / 1.75 ATR). Does a COMBINATION of those
//      thresholds MINIMIZE FIZZLING? For every combo in the grid we walk each name point-in-time, open an EPISODE
//      when the fingerprint fires, and resolve it to reached-target / fizzled / censored (mirroring the convergence
//      fizzle trichotomy) — reporting the conversion rate, median favorable move, median bars-to-target, n, and the
//      sep-conditioned alpha/overshoot from esdAccuracyBacktest. The user's baseline is one row, not a foregone answer.
//
//  B · WHEN TO ENTER & EXIT (the report they couldn't find) — for ESD leads AND convergence-breakout leads, the
//      forward-return EDGE vs a matched same-window baseline at horizons {3,5,8,13,21,34} bars. Where the edge PEAKS
//      then decays = the optimal EXIT bar; a small entry-delay sweep asks whether entering on bar 0 or waiting is better.
//
//  C · CONVERGENCE RECALIBRATION CHECK — sweep the FORMING levers (tightness via formingMult, minFormingBars, an
//      RVOL co-filter) through convergenceFizzle → the min-fizzle lever combo. We RECOMMEND a recalibration ONLY if
//      the evidence clears a margin over today's default ("if it ain't broke don't fix it"); the live detector is
//      NEVER re-wired in-sample — the study reports whether a change is warranted, the OOS ledger decides.
//
// Method (charter-clean — Polygon BARS only, no SEC/Yahoo/fallback):
//  • Polygon adjusted bars; survivorship-free roster.json universe (reusing selectMeritUniverse).
//  • LIQUID default surface (R3): clearsLiquidityBar drops perpetual micro-cap junk; FULL roster is an opt-in bias
//    cross-check (TFS_UNIVERSE=full). Intraday bars are filtered to regular hours (RTH).
//  • Every per-bar read is point-in-time (headingEvent/lineKinematics/convergenceBreakout read slice ≤ bar).
//
// Honesty (binding): in-sample is NEVER the verdict. Convergence geometry is a MEASURED LOSER (≈ −0.71% universe-wide),
// so a min-fizzle combo is minimizing a bad base rate, not manufacturing edge. The straight-line SMA20 ray OVERSHOOTS
// by construction — the ESD is a labeled projection, never a promise. Nothing here is gated; only the OOS ledger
// (esd / conv-grounded variants) ever pulls the trigger. Short (down-lean / breakdown) rows are AWARENESS ONLY under
// the unchanged long-only charter.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs, filterRegularHours } from "./pattern-study.mjs";
import { selectMeritUniverse } from "./build-study.mjs";
import { clearsLiquidityBar } from "./factor-interaction-study.mjs";
import { headingEvent, lineKinematics, esdAccuracyBacktest, convergenceBreakout, convergenceFizzle } from "./engine.mjs";
import { tStat, verdictFor } from "./convergence-scan.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;
export const median = a => { const s = (a || []).filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const mean = a => { const v = (a || []).filter(x => x != null && isFinite(x)); return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null; };
// breakouts ÷ (breakouts + fizzles); null when nothing resolved. Pure.
export function conversionRate(conv, fizz){ const r = conv + fizz; return r ? +(conv / r).toFixed(4) : null; }

// ─── rolling SMA series (point-in-time; out[i] = SMA_n of closes[0..i], null before warm) ──────────
function smaSeries(cl, n){
  const out = new Array(cl.length).fill(null); let sum = 0;
  for (let i = 0; i < cl.length; i++){ const v = +cl[i] || 0; sum += v; if (i >= n) sum -= (+cl[i - n] || 0); if (i >= n - 1) out[i] = sum / n; }
  return out;
}

// ─── Part A: ESD launch-fingerprint features + episode resolver ───────────────────────────────────
// esdFeatures — per-bar, point-in-time read of the SMA20 heading the fingerprint thresholds: where the SMA20 sits vs
// the fast-MA pack (side), its slope direction (leaning), the ATR-gap (separation), the ATR-normalized angle°, and the
// ATR-normalized curvature (acceleration). Computed ONCE per name with sep:0 (so any non-flat lean is measured); each
// combo then thresholds these numbers in launchFires — 48 combos evaluate in O(1)/bar instead of re-deriving the heading.
export function esdFeatures(bars, opts = {}){
  const slopeWin = opts.slopeWin != null ? opts.slopeWin : 10;
  const warm = 20 + slopeWin + 2;
  const data = bars || [];
  const cl = data.map(b => b && b.close);
  const s20 = smaSeries(cl, 20);
  const feats = new Array(data.length).fill(null);
  for (let i = warm; i < data.length; i++){
    const ev = headingEvent(data.slice(0, i + 1), i, { sep: 0, slopeWin }); // sep:0 → separated on any non-flat lean
    if (!ev) continue;
    const tail = s20.slice(Math.max(0, i - 2 * slopeWin), i + 1).filter(v => v != null);
    const lk = lineKinematics(tail, slopeWin, ev.atr);
    feats[i] = {
      side: ev.side, leaning: ev.leaning, gapATR: ev.gapATR, atr: ev.atr,
      angleDeg: lk ? lk.angleDeg : null,
      curvNorm: (lk && lk.curvature != null && ev.atr > 0) ? +(lk.curvature / ev.atr).toFixed(4) : null,
    };
  }
  return feats;
}

// Does the launch fingerprint fire at a bar, given a combo of thresholds? Pure. `side`/`leaning` gate direction,
// `sep` the ATR-gap, `angleDeg` the minimum heading steepness, `curvature` the minimum ATR-normalized acceleration
// (positive-up for a rising launch, negative for a down-lean). null thresholds are "don't care".
export function launchFires(feat, combo = {}){
  if (!feat) return false;
  const side = combo.side || "below", leaning = combo.leaning || "up";
  if (feat.leaning !== leaning) return false;
  if (side !== "any" && feat.side !== side) return false;
  if (feat.gapATR == null || Math.abs(feat.gapATR) < (combo.sep != null ? combo.sep : 0)) return false;
  if (combo.angleDeg != null && !(feat.angleDeg != null && Math.abs(feat.angleDeg) >= combo.angleDeg)) return false;
  if (combo.curvature != null){
    if (feat.curvNorm == null) return false;
    if (leaning === "up" && feat.curvNorm < combo.curvature) return false;
    if (leaning === "down" && feat.curvNorm > -combo.curvature) return false;
  }
  return true;
}

// esdEpisodes — walk a name and resolve each FRESH fingerprint fire to reached / fizzled / censored. reached =
// price makes a favorable move ≥ moveTargetATR·ATR in the lean direction before the adverse stop or a heading
// reversal; fizzled = the adverse stop (stopATR·ATR against) OR the SMA20 slope flips against the lean, first;
// censored = neither within maxBars. Adverse is checked before favorable within a bar (conservative — never
// overstates conversion). Episodes never overlap (the walk jumps past each resolution). Pure; point-in-time.
export function esdEpisodes(bars, combo = {}, opts = {}){
  const slopeWin = opts.slopeWin != null ? opts.slopeWin : 10;
  const maxBars = opts.maxBars != null ? opts.maxBars : 34;
  const moveTargetATR = opts.moveTargetATR != null ? opts.moveTargetATR : 2.0;
  const stopATR = opts.stopATR != null ? opts.stopATR : 1.5;
  const feats = opts.features || esdFeatures(bars, opts);
  const leaning = combo.leaning || "up", dir = leaning === "up" ? 1 : -1;
  const data = bars || [];
  const cl = data.map(b => b && b.close);
  const hi = data.map(b => b && (b.high != null ? b.high : b.close));
  const lo = data.map(b => b && (b.low != null ? b.low : b.close));
  const s20 = smaSeries(cl, 20);
  const episodes = [];
  let prevFired = false, i = 0;
  while (i < data.length){
    const fired = launchFires(feats[i], combo);
    if (fired && !prevFired){
      const entry = cl[i], atrE = (feats[i] && feats[i].atr) || 0;
      const target = entry + dir * moveTargetATR * atrE, stop = entry - dir * stopATR * atrE;
      const cap = Math.min(i + maxBars, data.length - 1);
      let outcome = "censored", resBar = cap;
      for (let j = i + 1; j <= cap; j++){
        const adverse = dir > 0 ? lo[j] <= stop : hi[j] >= stop;
        const favor = dir > 0 ? hi[j] >= target : lo[j] <= target;
        const slope20 = (s20[j] != null && s20[j - slopeWin] != null) ? s20[j] - s20[j - slopeWin] : 0;
        const reversed = dir > 0 ? slope20 < 0 : slope20 > 0;
        if (adverse){ outcome = "fizzle"; resBar = j; break; }
        if (reversed){ outcome = "fizzle"; resBar = j; break; }
        if (favor){ outcome = "reached"; resBar = j; break; }
      }
      const movePct = entry ? ((cl[resBar] - entry) / entry * dir) : null;
      const favMovePct = outcome === "reached"
        ? ((dir > 0 ? (hi[resBar] - entry) : (entry - lo[resBar])) / entry)
        : movePct;
      episodes.push({
        idx: i, date: (data[i] && data[i].date) || null, outcome, resBars: resBar - i,
        movePct: movePct != null ? +movePct.toFixed(5) : null,
        favMovePct: favMovePct != null ? +favMovePct.toFixed(5) : null,
        angleDeg: feats[i] ? feats[i].angleDeg : null, gapATR: feats[i] ? feats[i].gapATR : null,
      });
      prevFired = true; i = resBar + 1; continue;
    }
    prevFired = fired; i++;
  }
  return {
    episodes, flags: episodes.length,
    reached: episodes.filter(e => e.outcome === "reached").length,
    fizzled: episodes.filter(e => e.outcome === "fizzle").length,
    censored: episodes.filter(e => e.outcome === "censored").length,
  };
}

// Pick the min-fizzle sweet spot: among combos with ≥ minN resolved episodes, the one with the highest conversion
// (tie-broken by median favorable move). Pure — returns the winning combo row or null. Honesty lives at the caller
// (the winning conversion can still be a bad base rate; the ESD ray overshoots).
export function pickSweetSpot(rows, opts = {}){
  const minN = opts.minN != null ? opts.minN : 20;
  const elig = (rows || []).filter(r => r && (r.reached + r.fizzled) >= minN && r.conversionRate != null);
  if (!elig.length) return null;
  return elig.slice().sort((a, b) =>
    (b.conversionRate - a.conversionRate) || ((b.medianFavMovePct ?? -9) - (a.medianFavMovePct ?? -9)))[0];
}

// ─── Part B: forward-return edge by horizon (enter/exit term-structure) ────────────────────────────
// horizonEdge — at each trigger bar record the H-bar forward return; the edge = mean(trigger fwd) − mean(all-eligible
// fwd) at that H (alpha vs "just being in the tape", matched window). Triggers are precomputed ONCE (triggerFn is
// O(bar)) then reused across horizons. Cross-sectional significance is taken across NAMES by the caller (one edge per
// name per H → no within-name overlap problem). Pure.
export function horizonEdge(bars, triggerFn, horizons, opts = {}){
  const warm = opts.warm != null ? opts.warm : 51;
  const data = bars || [];
  const cl = data.map(b => b && b.close);
  const trig = new Array(data.length).fill(false);
  for (let i = warm; i < data.length; i++) trig[i] = !!triggerFn(data, i);
  const out = {};
  for (const H of horizons){
    const sig = [], all = [];
    for (let i = warm; i < data.length - H; i++){
      const fwd = cl[i] > 0 ? (cl[i + H] - cl[i]) / cl[i] : null;
      if (fwd == null) continue;
      all.push(fwd);
      if (trig[i]) sig.push(fwd);
    }
    const sM = mean(sig), bM = mean(all);
    out[H] = {
      horizon: H, n: sig.length, eligible: all.length,
      sigAvg: sM == null ? null : +sM.toFixed(6), baselineAvg: bM == null ? null : +bM.toFixed(6),
      edge: (sM != null && bM != null) ? +(sM - bM).toFixed(6) : null,
      winRate: sig.length ? +(sig.filter(x => x > 0).length / sig.length).toFixed(4) : null,
    };
  }
  return out;
}

// Best exit horizon = the H whose cross-sectional edge is highest AND at least suggestive (|t| ≥ 1.5), else the
// highest-edge H. Pure; input is the per-horizon aggregated rows (edge + t across names).
export function bestHorizon(rows){
  const ranked = (rows || []).filter(r => r && r.edge != null).sort((a, b) => b.edge - a.edge);
  return ranked.find(r => r.tAcrossNames != null && Math.abs(r.tAcrossNames) >= 1.5 && r.edge > 0) || ranked[0] || null;
}

// ─── Part C: convergence recalibration ─────────────────────────────────────────────────────────────
// recalConversion — conversion rate of a convergenceFizzle episode set after an optional RVOL co-filter (keep only
// episodes whose FORMING-flag bar traded ≥ rvolMin relative volume). Pure. This is how the RVOL lever is swept
// without changing the detector: convergenceFizzle stamps rvolFlag on every episode already.
export function recalConversion(episodes, rvolMin){
  let conv = 0, fizz = 0;
  for (const e of (episodes || [])){
    if (e.outcome === "censored") continue;
    if (rvolMin != null && !(e.rvolFlag != null && e.rvolFlag >= rvolMin)) continue;
    if (e.outcome === "breakout") conv++;
    else if (e.outcome === "fizzle") fizz++;
  }
  return { conv, fizz, rate: conversionRate(conv, fizz) };
}

// Is a recalibration WARRANTED? Only if the best swept lever beats today's default conversion by ≥ minGain AND has
// ≥ minN resolved episodes — otherwise "if it ain't broke, don't fix it". Pure; returns the verdict + the delta.
export function recalVerdict(defaultRate, best, opts = {}){
  const minGain = opts.minGain != null ? opts.minGain : 0.05;
  const minN = opts.minN != null ? opts.minN : 30;
  const n = best ? (best.conv + best.fizz) : 0;
  const gain = (best && best.rate != null && defaultRate != null) ? +(best.rate - defaultRate).toFixed(4) : null;
  const warranted = !!(gain != null && gain >= minGain && n >= minN);
  return { warranted, gain, n, defaultRate: defaultRate ?? null, bestRate: best ? best.rate : null };
}

// ─── the grid ──────────────────────────────────────────────────────────────────────────────────────
const SEPS = [0.25, 0.75, 1.25, 1.75];        // separation (ATR gap) thresholds — 1.75 is the current baseline
const ANGLES = [10, 15, 20, 25];              // minimum heading angle° — 20 is the baseline
const CURVS = [0, 0.25, 0.5];                 // minimum ATR-normalized curvature — 0.5 is the baseline
const HORIZONS = [3, 5, 8, 13, 21, 34];       // enter/exit forward horizons (bars)
const RECAL_MULTS = [1.5, 2, 2.5];            // FORMING-corridor width = formingMult × coilPct (2 is the default)
const RECAL_MINBARS = [3, 5];                 // minimum forming run length (3 is the default)
const RECAL_RVOLS = [null, 1.0, 1.5];         // RVOL co-filter (null = no filter, today's default)

function comboKey(c){ return `sep${c.sep}_ang${c.angleDeg}_cur${c.curvature}_${c.side}_${c.leaning}`; }
function buildCombos(leaning, side){
  const out = [];
  for (const sep of SEPS) for (const angleDeg of ANGLES) for (const curvature of CURVS)
    out.push({ sep, angleDeg, curvature, side, leaning });
  return out;
}

// ─── universe + fetch (mirrors esd-capture-study) ───────────────────────────────────────────────────
function resolveUniverse(cap){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if (Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, cap);
      const delisted = picked.filter(c => !c.active).length;
      return { tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${cap})`,
        survivorshipFree: true };
    }
  }catch{ /* no roster yet → fall back */ }
  return { tickers: readTickers().slice(0, cap),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)", survivorshipFree: false };
}

async function fetchBars(sym, res, key, lookbackDays, intraday){
  const opts = intraday ? { lookbackMs: lookbackDays * 864e5, minBars: 120 } : { minBars: 120 };
  let candles = await fetchPolygonAggs(sym, res, key, opts);
  if (intraday) candles = filterRegularHours(candles);
  return candles.map(c => ({ t: c.time, date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.t - b.t);
}

function caveats(survivorshipFree, resolution){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), capped for runtime — de-listed losers INCLUDED (no survivorship inflation)."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias inflates any positive result; run universe-build for roster.json.",
    "IN-SAMPLE only — a min-fizzle combo / best exit bar / recalibration finding here is a POINTER for the OOS ledger, never the verdict. Nothing is wired to any gate.",
    "Convergence geometry is a MEASURED LOSER (≈ −0.71% universe-wide): a higher conversion rate minimizes a bad base rate, it does NOT manufacture edge. Part-A 'reached' is a geometry/ATR follow-through, not a profit.",
    "The straight-line SMA20 ray OVERSHOOTS by construction (the average lags and decelerates as price reverts). The ESD is a labeled PROJECTION, never a promise; angle/curvature are descriptive.",
    "Part-A alpha/overshoot come from esdAccuracyBacktest and are conditioned on the SEPARATION only (below→up); they do NOT vary with the angle/curvature thresholds in the same sep row.",
    "Part-B edge is forward return vs a matched same-window baseline (alpha vs the tape), no costs; significance is cross-sectional across NAMES (one edge per name per horizon → no within-name overlap). A positive horizon must still clear the 2× round-trip cost gate to be tradeable.",
    "Part-C 'recalibration warranted' requires the best lever to beat today's default conversion by a margin with enough n — otherwise 'if it ain't broke, don't fix it'. The live detector is NEVER re-wired in-sample.",
    `Down-lean / breakdown rows are AWARENESS ONLY under the unchanged long-only charter. Bars: Polygon ${resolution} (adjusted${/min|hour/.test(resolution) ? ", regular hours 09:30–16:00 ET, +15-min feed delay" : ""}).`,
  ];
}

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if (!key){ console.error("Set POLYGON_API_KEY — the trajectory-fizzle study prices off Polygon, no fallback vendor by design."); process.exit(2); }

  const cap = +(process.env.TFS_MAX || 30);
  const resolution = process.env.TFS_RESOLUTION || "1hour";
  const lookbackDays = +(process.env.TFS_LOOKBACK_DAYS || 180);
  const intraday = /min|hour/.test(resolution);
  const fullUniverse = process.env.TFS_UNIVERSE === "full";
  const minN = +(process.env.TFS_MIN_N || 20);
  const { tickers, source, survivorshipFree } = resolveUniverse(cap);
  console.log("trajectory-fizzle universe: " + source + `  @ ${resolution}, ~${lookbackDays}d`);

  const upCombos = buildCombos("up", "below");
  const downCombos = buildCombos("down", "above");   // short awareness (long-only charter → never actionable)
  const allCombos = [...upCombos, ...downCombos];

  // accumulators keyed by comboKey
  const acc = {};
  for (const c of allCombos) acc[comboKey(c)] = { combo: c, reached: 0, fizzled: 0, censored: 0, favMoves: [], etas: [] };
  const alphaBySep = {};                                // sep → {alphas:[], overshoots:[], proven:0, trades:0}
  for (const sep of SEPS) alphaBySep[sep] = { alphas: [], overshoots: [], proven: 0, tradesTotal: 0, names: 0 };
  // Part-B accumulators: per-horizon edge, one entry per name, for ESD and convergence triggers
  const esdEdge = Object.fromEntries(HORIZONS.map(h => [h, []]));
  const convEdge = Object.fromEntries(HORIZONS.map(h => [h, []]));
  // entry-delay sweep (ESD, at a mid horizon) — does waiting past the trigger bar help?
  const DELAY_H = 13, DELAYS = [0, 1, 2, 3];
  const delayEdge = Object.fromEntries(DELAYS.map(d => [d, []]));
  // Part-C accumulators: convergence recal lever sweep
  const recalAcc = {};                                 // key mult_minbars → episodes[]
  for (const m of RECAL_MULTS) for (const mb of RECAL_MINBARS) recalAcc[`${m}_${mb}`] = [];
  const defaultEpisodes = [];                           // today's default (mult 2, minBars 3) → base conversion

  let covered = 0, droppedIlliquid = 0, skipped = 0;
  for (const sym of tickers){
    try{
      const bars = await fetchBars(sym, resolution, key, lookbackDays, intraday);
      if (bars.length < 80) throw new Error(`only ${bars.length} bars`);
      if (!fullUniverse && !clearsLiquidityBar(bars)){ droppedIlliquid++; continue; }
      covered++;

      // ── Part A: features once, then every combo ──
      const feats = esdFeatures(bars, {});
      for (const c of allCombos){
        const r = esdEpisodes(bars, c, { features: feats });
        const a = acc[comboKey(c)];
        a.reached += r.reached; a.fizzled += r.fizzled; a.censored += r.censored;
        for (const e of r.episodes){
          if (e.outcome === "reached"){ if (e.favMovePct != null) a.favMoves.push(e.favMovePct); a.etas.push(e.resBars); }
        }
      }
      // sep-conditioned alpha/overshoot (below→up), once per sep
      for (const sep of SEPS){
        const bt = esdAccuracyBacktest(bars, { sep });
        if (bt){
          const A = alphaBySep[sep]; A.names++;
          if (bt.meanAlpha != null) A.alphas.push(bt.meanAlpha);
          if (bt.overshootBias != null) A.overshoots.push(bt.overshootBias);
          if (bt.proven) A.proven++;
          A.tradesTotal += bt.trades || 0;
        }
      }

      // ── Part B: horizon edge for ESD (baseline fingerprint) and convergence triggers ──
      const esdTrig = (bb, i) => { const ev = headingEvent(bb.slice(0, i + 1), i, { sep: 0.75 }); return !!(ev && ev.separated && ev.side === "below" && ev.leaning === "up"); };
      const convTrig = (bb, i) => { const d = convergenceBreakout(bb.slice(0, i + 1), { trendFilter: true }); return !!(d && d.detected); };
      const eE = horizonEdge(bars, esdTrig, HORIZONS), cE = horizonEdge(bars, convTrig, HORIZONS);
      for (const h of HORIZONS){ if (eE[h] && eE[h].edge != null && eE[h].n > 0) esdEdge[h].push(eE[h].edge); if (cE[h] && cE[h].edge != null && cE[h].n > 0) convEdge[h].push(cE[h].edge); }
      // entry-delay: shift the ESD trigger forward by d bars, measure edge at DELAY_H
      for (const d of DELAYS){
        const trigD = (bb, i) => (i - d >= 0) && esdTrig(bb, i - d);
        const eD = horizonEdge(bars, trigD, [DELAY_H]);
        if (eD[DELAY_H] && eD[DELAY_H].edge != null && eD[DELAY_H].n > 0) delayEdge[d].push(eD[DELAY_H].edge);
      }

      // ── Part C: convergence recal lever sweep ──
      for (const m of RECAL_MULTS) for (const mb of RECAL_MINBARS){
        const f = convergenceFizzle(bars, { trendFilter: true, formingMult: m, minFormingBars: mb });
        recalAcc[`${m}_${mb}`].push(...f.episodes);
        if (m === 2 && mb === 3) defaultEpisodes.push(...f.episodes);
      }
      console.log("✓ " + sym.padEnd(6) + " " + bars.length + " bars");
    }catch(e){ skipped++; console.warn("✗ " + sym.padEnd(6) + " — " + (e.message || e)); }
  }

  // ── assemble Part A rows ──
  const esdSweep = allCombos.map(c => {
    const a = acc[comboKey(c)];
    const A = alphaBySep[c.sep];
    return {
      ...c, key: comboKey(c),
      reached: a.reached, fizzled: a.fizzled, censored: a.censored,
      conversionRate: conversionRate(a.reached, a.fizzled),
      medianFavMovePct: round(median(a.favMoves)), medianEtaBars: median(a.etas),
      sepAlpha: round(mean(A.alphas)), sepOvershoot: round(mean(A.overshoots)), sepProvenNames: A.proven,
    };
  });
  const upRows = esdSweep.filter(r => r.leaning === "up");
  const sweetSpot = pickSweetSpot(upRows, { minN });
  const baselineRow = upRows.find(r => r.sep === 1.75 && r.angleDeg === 20 && r.curvature === 0.5) || null;

  // ── assemble Part B rows (cross-sectional t across names) ──
  const horizonRows = (edgeMap) => HORIZONS.map(h => {
    const vals = edgeMap[h]; const s = tStat(vals);
    return { horizon: h, names: vals.length, meanEdge: round(mean(vals)),
      tAcrossNames: s.t != null ? +s.t.toFixed(2) : null, verdict: verdictFor(s.t) };
  });
  const esdHorizons = horizonRows(esdEdge), convHorizons = horizonRows(convEdge);
  const esdBestExit = bestHorizon(esdHorizons), convBestExit = bestHorizon(convHorizons);
  const delayRows = DELAYS.map(d => { const vals = delayEdge[d]; const s = tStat(vals);
    return { delayBars: d, names: vals.length, meanEdge: round(mean(vals)), tAcrossNames: s.t != null ? +s.t.toFixed(2) : null }; });

  // ── assemble Part C rows ──
  const defRate = recalConversion(defaultEpisodes, null).rate;
  const convergenceRecal = [];
  for (const m of RECAL_MULTS) for (const mb of RECAL_MINBARS) for (const rv of RECAL_RVOLS){
    const r = recalConversion(recalAcc[`${m}_${mb}`], rv);
    convergenceRecal.push({ formingMult: m, minFormingBars: mb, rvolMin: rv, conv: r.conv, fizz: r.fizz, conversionRate: r.rate });
  }
  const recalEligible = convergenceRecal.filter(r => (r.conv + r.fizz) >= 30 && r.conversionRate != null);
  const bestRecal = recalEligible.slice().sort((a, b) => b.conversionRate - a.conversionRate)[0] || null;
  const recalCheck = recalVerdict(defRate, bestRecal, { minGain: 0.05, minN: 30 });

  const out = {
    generatedAt: new Date().toISOString(),
    question: "ESD launch-fingerprint min-fizzle sweet spot + when to ENTER/EXIT (ESD & convergence) + is a convergence recalibration warranted?",
    universe: { requested: tickers.length, covered, droppedIlliquid, skipped, source, survivorshipFree,
      screen: fullUniverse ? "FULL survivorship-free roster (bias cross-check)" : "LIQUID default (illiquid dropped)" },
    config: { resolution, lookbackDays, minN, seps: SEPS, angles: ANGLES, curvatures: CURVS, horizons: HORIZONS },
    // A
    esdSweep,
    esdSweetSpot: sweetSpot ? { ...sweetSpot } : null,
    esdBaselineRow: baselineRow,
    // B
    enterExitTermStructure: { esd: esdHorizons, convergence: convHorizons, esdEntryDelay: delayRows },
    esdBestExitBar: esdBestExit ? { horizon: esdBestExit.horizon, meanEdge: esdBestExit.meanEdge, t: esdBestExit.tAcrossNames, verdict: esdBestExit.verdict } : null,
    convBestExitBar: convBestExit ? { horizon: convBestExit.horizon, meanEdge: convBestExit.meanEdge, t: convBestExit.tAcrossNames, verdict: convBestExit.verdict } : null,
    // C
    convergenceRecal, convDefaultConversion: defRate, convBestRecal: bestRecal, convRecalWarranted: recalCheck,
    recommendation: {
      bestEsdCombo: sweetSpot ? { sep: sweetSpot.sep, angleDeg: sweetSpot.angleDeg, curvature: sweetSpot.curvature,
        conversionRate: sweetSpot.conversionRate, n: sweetSpot.reached + sweetSpot.fizzled } : null,
      esdBestExitBar: esdBestExit ? esdBestExit.horizon : null,
      convBestExitBar: convBestExit ? convBestExit.horizon : null,
      convRecalWarranted: recalCheck.warranted,
    },
    caveats: caveats(survivorshipFree, resolution),
  };
  fs.writeFileSync(path.join(ROOT, "trajectory-fizzle-study.json"), JSON.stringify(out) + "\n");
  console.log("\ntrajectory-fizzle-study.json written.");

  // ── job-log rollup ──
  const pct = v => v != null ? (v * 100).toFixed(1) + "%" : "—";
  const spct = v => v != null ? ((v >= 0 ? "+" : "") + (v * 100).toFixed(2) + "%") : "—";
  console.log(`\ncovered=${covered} droppedIlliquid=${droppedIlliquid} skipped=${skipped}`);
  console.log("\n── A · ESD LAUNCH-FINGERPRINT SWEET SPOT (up-lean; conversion = reached ÷ resolved) ──");
  console.log("  " + (sweetSpot ? `SWEET SPOT → sep ${sweetSpot.sep} · angle ${sweetSpot.angleDeg}° · curv ${sweetSpot.curvature} → conversion ${pct(sweetSpot.conversionRate)} (n=${sweetSpot.reached + sweetSpot.fizzled}, medMove ${spct(sweetSpot.medianFavMovePct)})` : `no combo reached n≥${minN}`));
  if (baselineRow) console.log(`  baseline (1.75/20/0.5) → conversion ${pct(baselineRow.conversionRate)} (n=${baselineRow.reached + baselineRow.fizzled}, medMove ${spct(baselineRow.medianFavMovePct)})`);
  console.log("\n── B · WHEN TO EXIT (edge vs matched baseline, t across names) ──");
  console.log("  ESD:  " + esdHorizons.map(r => `H${r.horizon} ${spct(r.meanEdge)} (t ${r.tAcrossNames ?? "—"})`).join("  "));
  console.log("        best exit → " + (esdBestExit ? `H${esdBestExit.horizon} ${spct(esdBestExit.meanEdge)} (${esdBestExit.verdict})` : "none"));
  console.log("  CONV: " + convHorizons.map(r => `H${r.horizon} ${spct(r.meanEdge)} (t ${r.tAcrossNames ?? "—"})`).join("  "));
  console.log("        best exit → " + (convBestExit ? `H${convBestExit.horizon} ${spct(convBestExit.meanEdge)} (${convBestExit.verdict})` : "none"));
  console.log("  ESD entry-delay @H" + DELAY_H + ": " + delayRows.map(r => `+${r.delayBars}b ${spct(r.meanEdge)}`).join("  "));
  console.log("\n── C · CONVERGENCE RECALIBRATION ──");
  console.log(`  default (mult 2 · minBars 3 · no RVOL) conversion ${pct(defRate)}`);
  console.log("  best lever → " + (bestRecal ? `mult ${bestRecal.formingMult} · minBars ${bestRecal.minFormingBars} · RVOL ${bestRecal.rvolMin ?? "off"} → ${pct(bestRecal.conversionRate)} (n=${bestRecal.conv + bestRecal.fizz})` : "insufficient episodes"));
  console.log(`  RECALIBRATION WARRANTED: ${recalCheck.warranted ? "YES" : "NO"} (gain ${recalCheck.gain != null ? (recalCheck.gain * 100).toFixed(1) + "pp" : "—"}, n ${recalCheck.n}) — ${recalCheck.warranted ? "candidate for the OOS ledger, NOT an in-sample re-wire" : "if it ain't broke, don't fix it"}`);
  console.log("\nIN-SAMPLE pointer only — the OOS ledger (esd / conv-grounded variants under FDR) pulls the trigger.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
