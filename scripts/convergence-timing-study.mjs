// Convergence TIMING study — measure, on REAL history, how long the "Uptrend Convergence"
// setup takes through its phases, so the FORMING-stage detector can be calibrated to data
// instead of the detector's default 8-bar cap. For every breakout the live detector flags,
// it records two gaps:
//   • FORMING → PINCH  (`formingBars`)  — how many consecutive bars the MA ribbon was already
//                                          tight (spread ≤ ~2×coilPct) leading into the pinch.
//   • PINCH → BREAKOUT (`barsSinceCoil`) — bars from the tight pinch to the confirmed pop.
//
// HONESTY: in-sample geometry measurement only — it answers "how fast does the shape move,"
// NOT "is it profitable" (the pattern's edge is ≈ −0.71% universe-wide, a measured loser).
// `barsSinceCoil` is structurally capped at the detector's coilLookback (default 8), so the
// pinch→breakout distribution lives in [1, coilLookback]; forming→pinch is uncapped. Needs
// POLYGON_API_KEY (no fallback vendor by design); no-ops without it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convergenceEvents, auditData } from "./engine.mjs";
import { fetchPolygonAggs, filterRegularHours } from "./pattern-study.mjs";
import { topNTickers } from "./convergence-scan.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Linear-interpolated quantile of an ALREADY-SORTED ascending array. Pure.
export function quantile(sorted, q){
  if(!sorted || !sorted.length) return null;
  const pos = (sorted.length - 1) * q, base = Math.floor(pos), rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
}

// Distribution summary of an integer-bar series: count, mean, quartiles, p90, range, histogram. Pure.
export function summarizeTiming(values){
  const v = (values || []).filter(Number.isFinite).slice().sort((a, b) => a - b);
  const n = v.length;
  if(!n) return { n: 0, mean: null, median: null, p25: null, p75: null, p90: null, min: null, max: null, hist: {} };
  const mean = v.reduce((a, x) => a + x, 0) / n;
  const hist = {}; for(const x of v) hist[x] = (hist[x] || 0) + 1;
  const r = q => { const x = quantile(v, q); return x == null ? null : +x.toFixed(2); };
  return { n, mean: +mean.toFixed(2), median: r(0.5), p25: r(0.25), p75: r(0.75), p90: r(0.90), min: v[0], max: v[n - 1], hist };
}

// Minutes per bar for the human clock (null for daily+).
export function minutesPerBar(resolution){
  const m = { "1min": 1, "5min": 5, "15min": 15, "30min": 30, "1h": 60, "1hour": 60 };
  return m[resolution] ?? null;
}

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY — the timing study has no fallback vendor by design."); process.exit(2); }

  const topN         = +(process.env.CT_TOP_N || 120);
  const resolution   = process.env.CT_RESOLUTION || "15min";
  const lookbackDays  = +(process.env.CT_LOOKBACK_DAYS || 60);
  const coilLookback  = +(process.env.CT_COIL_LOOKBACK || 8);   // detector cap on pinch→breakout
  const pace          = +(process.env.POLYGON_PACE_MS || 0);
  const intraday      = /min|hour/.test(resolution);
  const rth           = !/^(0|false|no)$/i.test(process.env.CT_RTH ?? "1");
  const minPerBar     = minutesPerBar(resolution);

  let universe;
  try { universe = JSON.parse(fs.readFileSync(path.join(ROOT, "universe.json"), "utf8")); }
  catch { console.error("universe.json missing — run universe-build first."); process.exit(2); }
  const syms = topNTickers(universe, topN);
  console.log(`timing: top ${syms.length} names @ ${resolution}, ~${lookbackDays}d, coilLookback=${coilLookback}`);

  const barsSince = [], forming = [], perName = [];
  let withData = 0, namesWithEvents = 0, skipped = 0;

  for(let i = 0; i < syms.length; i++){
    const sym = syms[i];
    try {
      const raw = await fetchPolygonAggs(sym, resolution, key, { lookbackMs: lookbackDays * 864e5, minBars: 120 });
      const used = (rth && intraday) ? filterRegularHours(raw) : raw;
      if(auditData(used).suspect){ skipped++; continue; }
      withData++;
      const ev = convergenceEvents(used, { trendFilter: true, coilLookback });
      if(ev.length){
        namesWithEvents++;
        for(const e of ev){ barsSince.push(e.barsSinceCoil); forming.push(e.formingBars); }
        perName.push({ sym, events: ev.length });
      }
      if(i % 25 === 0) console.log(`  …${i}/${syms.length} (${sym}) events=${ev.length}`);
    } catch(e){ skipped++; }
    if(i < syms.length - 1 && pace) await sleep(pace);
  }

  const pinchToBreakout = summarizeTiming(barsSince);
  const formingToPinch  = summarizeTiming(forming);
  const clk = bars => (minPerBar != null && bars != null) ? ` (~${Math.round(bars * minPerBar)} min)` : "";

  const out = {
    generatedAt: new Date().toISOString(),
    pattern: "Uptrend Convergence (trend-filtered)",
    resolution, lookbackDays, topN, coilLookback, minutesPerBar: minPerBar, regularHoursOnly: rth && intraday,
    universeSource: "universe.json (dollar-volume ranked, top N)",
    namesScanned: syms.length, withData, namesWithEvents, skipped, totalEvents: barsSince.length,
    formingToPinchBars: formingToPinch,     // FORMING → PINCH (uncapped)
    pinchToBreakoutBars: pinchToBreakout,   // PINCH → BREAKOUT (capped at coilLookback)
    topNames: perName.sort((a, b) => b.events - a.events).slice(0, 15),
    caveats: [
      "In-sample geometry timing only — it measures how fast the SHAPE moves, NOT profitability (the pattern's edge is ≈ −0.71% universe-wide, a measured loser).",
      `PINCH→BREAKOUT is structurally bounded by coilLookback=${coilLookback}: the detector only counts a breakout within ${coilLookback} bars of the pinch, so this distribution lives in [1, ${coilLookback}].`,
      "FORMING→PINCH = consecutive bars the ribbon was already tight (spread ≤ ~2×coilPct) up to the pinch — a proxy for how long the squeeze had been developing.",
      "15-min bars carry a +15-min feed delay (Polygon Starter); intraday uses regular-hours-only bars.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "convergence-timing-study.json"), JSON.stringify(out, null, 1) + "\n");

  console.log(`\nEvents: ${barsSince.length} across ${namesWithEvents} names (${withData} with data, ${skipped} skipped).`);
  console.log(`FORMING → PINCH  (bars): median ${formingToPinch.median}${clk(formingToPinch.median)}, p25 ${formingToPinch.p25}, p75 ${formingToPinch.p75}, p90 ${formingToPinch.p90}, max ${formingToPinch.max}`);
  console.log(`PINCH → BREAKOUT (bars): median ${pinchToBreakout.median}${clk(pinchToBreakout.median)}, p25 ${pinchToBreakout.p25}, p75 ${pinchToBreakout.p75}, p90 ${pinchToBreakout.p90}, max ${pinchToBreakout.max} (capped at ${coilLookback})`);
  console.log(`Histograms: forming→pinch  ${JSON.stringify(formingToPinch.hist)}`);
  console.log(`            pinch→breakout ${JSON.stringify(pinchToBreakout.hist)}`);
  console.log(`Wrote convergence-timing-study.json (${namesWithEvents} names with events).`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
