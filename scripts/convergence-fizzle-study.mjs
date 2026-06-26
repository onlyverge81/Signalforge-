// Convergence FIZZLE-RATE study — the base rate the timing study couldn't measure. The timing
// study only timed coils that DID pop; this asks: of every FORMING flag (the ⏳ early-warning the
// monitor now shows), what fraction actually BREAKS OUT vs FIZZLES (loosens back up with no pop)?
// That is the precision/noise of the ⏳ list. It also splits conversion by how TIGHT the squeeze
// got, so we can see whether tightening the corridor (or requiring a longer forming run) would
// raise the hit rate.
//
// HONESTY: in-sample geometry only — "does the shape resolve into a pop," NOT "is the pop
// profitable" (the pattern edge is ≈ −0.71% universe-wide, a measured loser). Needs
// POLYGON_API_KEY (no fallback vendor by design); no-ops without it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convergenceFizzle, auditData } from "./engine.mjs";
import { fetchPolygonAggs, filterRegularHours } from "./pattern-study.mjs";
import { topNTickers } from "./convergence-scan.mjs";
import { quantile, minutesPerBar } from "./convergence-timing-study.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Conversion rate of a {conv, fizz} tally (breakouts ÷ resolved); null when nothing resolved. Pure.
export function conversionRate(conv, fizz){
  const resolved = conv + fizz;
  return resolved ? +(conv / resolved).toFixed(4) : null;
}
const median = arr => { const v = (arr || []).filter(Number.isFinite).slice().sort((a, b) => a - b); return v.length ? quantile(v, 0.5) : null; };
const pct = v => v != null ? (v * 100).toFixed(1) + "%" : "—";

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY — the fizzle study has no fallback vendor by design."); process.exit(2); }

  const topN        = +(process.env.CF_TOP_N || 120);
  const resolution  = process.env.CF_RESOLUTION || "15min";
  const lookbackDays = +(process.env.CF_LOOKBACK_DAYS || 60);
  const pace         = +(process.env.POLYGON_PACE_MS || 0);
  const intraday     = /min|hour/.test(resolution);
  const rth          = !/^(0|false|no)$/i.test(process.env.CF_RTH ?? "1");
  const minPerBar    = minutesPerBar(resolution);

  let universe;
  try { universe = JSON.parse(fs.readFileSync(path.join(ROOT, "universe.json"), "utf8")); }
  catch { console.error("universe.json missing — run universe-build first."); process.exit(2); }
  const syms = topNTickers(universe, topN);
  console.log(`fizzle: top ${syms.length} names @ ${resolution}, ~${lookbackDays}d`);

  let flags = 0, converted = 0, fizzled = 0, censored = 0, withData = 0, skipped = 0;
  const convRes = [], fizzRes = [];
  // Split conversion by how tight the squeeze got — does demanding a tighter pinch raise the hit rate?
  const byTight = { tight: { conv: 0, fizz: 0 }, loose: { conv: 0, fizz: 0 } }; // tight = maxTightness ≥ 0.5

  for(let i = 0; i < syms.length; i++){
    const sym = syms[i];
    try {
      const raw = await fetchPolygonAggs(sym, resolution, key, { lookbackMs: lookbackDays * 864e5, minBars: 120 });
      const used = (rth && intraday) ? filterRegularHours(raw) : raw;
      if(auditData(used).suspect){ skipped++; continue; }
      withData++;
      const f = convergenceFizzle(used, { trendFilter: true });
      flags += f.flags; converted += f.converted; fizzled += f.fizzled; censored += f.censored;
      for(const e of f.episodes){
        if(e.outcome === "breakout") convRes.push(e.resBars);
        else if(e.outcome === "fizzle") fizzRes.push(e.resBars);
        if(e.outcome !== "censored"){
          const b = e.maxTightness >= 0.5 ? byTight.tight : byTight.loose;
          if(e.outcome === "breakout") b.conv++; else b.fizz++;
        }
      }
      if(i % 25 === 0) console.log(`  …${i}/${syms.length} (${sym}) flags=${f.flags}`);
    } catch(e){ skipped++; }
    if(i < syms.length - 1 && pace) await sleep(pace);
  }

  const overall = conversionRate(converted, fizzled);
  const clk = bars => (minPerBar != null && bars != null) ? ` (~${Math.round(bars * minPerBar)} min)` : "";
  const out = {
    generatedAt: new Date().toISOString(),
    pattern: "Uptrend Convergence — FORMING-stage fizzle rate",
    resolution, lookbackDays, topN, minutesPerBar: minPerBar, regularHoursOnly: rth && intraday,
    namesScanned: syms.length, withData, skipped,
    flags, converted, fizzled, censored,
    conversionRate: overall,                                   // breakouts ÷ (breakouts + fizzles)
    medianBarsToBreakout: median(convRes), medianBarsToFizzle: median(fizzRes),
    conversionByTightness: {
      tight_ge_0_5: { conv: byTight.tight.conv, fizz: byTight.tight.fizz, rate: conversionRate(byTight.tight.conv, byTight.tight.fizz) },
      loose_lt_0_5: { conv: byTight.loose.conv, fizz: byTight.loose.fizz, rate: conversionRate(byTight.loose.conv, byTight.loose.fizz) },
    },
    caveats: [
      "In-sample geometry only — measures whether the FORMING shape RESOLVES into a pop, NOT whether the pop is profitable (pattern edge ≈ −0.71% universe-wide).",
      "A 'flag' = the live ⏳ FORMING condition firing (ribbon in the corridor, uptrend, run ≥ minFormingBars, not yet broken out). conversionRate = breakouts ÷ (breakouts + fizzles); censored (still forming at data end) is excluded.",
      "Higher conversion in the tight bucket ⇒ demanding a tighter pinch (or longer run) would cut ⏳ noise — a calibration lever, not yet applied.",
      "15-min carries a +15-min feed delay; intraday uses regular-hours-only bars.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "convergence-fizzle-study.json"), JSON.stringify(out, null, 1) + "\n");

  console.log(`\nFlags: ${flags} (${converted} breakout · ${fizzled} fizzle · ${censored} censored) over ${withData} names (${skipped} skipped).`);
  console.log(`CONVERSION RATE (breakout ÷ resolved): ${pct(overall)}  —  median ${median(convRes)} bars to breakout${clk(median(convRes))}, ${median(fizzRes)} bars to fizzle${clk(median(fizzRes))}`);
  console.log(`By tightness — TIGHT(≥0.5): ${pct(out.conversionByTightness.tight_ge_0_5.rate)} (${byTight.tight.conv}/${byTight.tight.conv + byTight.tight.fizz})  ·  LOOSE(<0.5): ${pct(out.conversionByTightness.loose_lt_0_5.rate)} (${byTight.loose.conv}/${byTight.loose.conv + byTight.loose.fizz})`);
  console.log(`Wrote convergence-fizzle-study.json.`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
