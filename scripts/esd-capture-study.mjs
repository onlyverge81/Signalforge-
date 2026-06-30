// Build esd-capture-study.json — settle the ESD timeframe question with data, not a guess.
// Run on-demand (workflow_dispatch); prints a rollup to the job log + uploads the JSON artifact.
// IN-SAMPLE measurement on real Polygon history, NOT a promotion and NOT wired into any gate.
//
// The question (the user's ESD idea): treat the SMA20 (purple) line as a navigational HEADING. When it
// SEPARATES from the fast-MA pack and leans (the "launch" the screenshots show), we project a ray to a price
// level → the Estimated Stock Destination. To catch it AT ITS EARLIEST (current week, not after the move is
// spent) we must pick the right resolution. The SMA20 is a 20-bar average, so it confirms LATE; the tradeoff
// is timeframe-specific: a faster timeframe (30min) flags the heading sooner but its angle whipsaws; a slower
// one (Daily) is stable but lags. This study measures, per name across 30min / 1hour / 1day:
//   • LEAD — calendar time from the first below→up SMA20 separation to the bar the move becomes "obvious"
//            (price has travelled ESD_MOVE from the event-start close). Larger lead = earlier capture.
//   • STABILITY — how often the SMA20 slope sign FLIPS over the bars right after the event (the angle
//            whipsaw). Lower flip-rate = a steadier heading you can trust between the 3 daily scans.
//   • LAUNCH ANGLE — the ATR-normalized SMA20 degree at the event start (for color).
// The recommended resolution is the one that surfaces the pop EARLIEST and MOST STABLY.
//
// Method (charter-clean — Polygon BARS only, no SEC/Yahoo/fallback):
//  • Polygon adjusted bars; survivorship-free roster.json universe (reusing selectMeritUniverse).
//  • LIQUID default surface (R3): clearsLiquidityBar drops perpetual micro-cap junk; FULL roster is an
//    opt-in bias cross-check (ESD_UNIVERSE=full). Intraday bars are filtered to regular hours (RTH).
//  • Pure headingEvent/lineKinematics from the engine (the SAME functions the ESD tab + math use) — every
//    per-bar read is point-in-time (slice ≤ bar); the "obvious move" reads bars strictly after the event.
//
// Honesty (binding): in-sample is NEVER the verdict. This study only picks the timeframe that DISPLAYS the
// heading earliest; whether the ESD projection has predictive worth is a separate question answered ONLY by
// esdAccuracyBacktest (the overshoot/alpha gate) and, ultimately, the OOS ledger. A straight-line MA ray
// OVERSHOOTS by construction — the ESD is a labeled projection, never a promise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTickers } from "./build-fundamentals.mjs";
import { fetchPolygonAggs, filterRegularHours } from "./pattern-study.mjs";
import { selectMeritUniverse } from "./build-study.mjs";
import { clearsLiquidityBar } from "./factor-interaction-study.mjs";
import { headingEvent } from "./engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ESD_MAX   = +(process.env.ESD_MAX  || 40);          // names cap (runtime)
const ESD_MOVE  = +(process.env.ESD_MOVE || 0.05);        // "obvious move" = this fraction from the event-start close
const WARM      = 45;                                     // bars before headingEvent is trustworthy (needs ≥31)
const STAB_K    = 10;                                     // bars after the event to measure angle-flip stability
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;

// resolution → {label, RTH filter?}; the three timeframes the user asked to compare.
const RESOS = [
  { key: "30min", label: "30-min", intraday: true,  lookbackMs: 120 * 864e5, minBars: 200 },
  { key: "1hour", label: "1-hour", intraday: true,  lookbackMs: 180 * 864e5, minBars: 150 },
  { key: "1day",  label: "Daily",  intraday: false, minBars: 80 },
];

const median = a => { const s = a.filter(x => x != null && isFinite(x)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// ─── pure measurement (uses the engine's headingEvent — same code the ESD tab runs) ──
// Find the FIRST FRESH below→up SMA20 separation (the bullish launch), then measure lead + stability.
export function measureName(bars, opts = {}){
  const move = opts.move != null ? opts.move : ESD_MOVE;
  const warm = opts.warm != null ? opts.warm : WARM;
  const stabK = opts.stabK != null ? opts.stabK : STAB_K;
  const cl = bars.map(b => b && b.close);
  let prevFired = false, evStart = -1;
  for (let i = warm; i < bars.length; i++){
    const ev = headingEvent(bars.slice(0, i + 1), i, {});
    const fired = !!(ev && ev.separated && ev.side === "below" && ev.leaning === "up");
    if (fired && !prevFired){ evStart = i; break; }       // first fresh below→up separation
    prevFired = fired;
  }
  if (evStart < 0) return { event: false };
  const startClose = cl[evStart], startT = bars[evStart].t;
  // angle stability: sign-flips of the SMA20 slope over the next stabK bars (point-in-time)
  const signs = [];
  for (let j = evStart; j <= Math.min(evStart + stabK, bars.length - 1); j++){
    const ev = headingEvent(bars.slice(0, j + 1), j, {});
    if (ev) signs.push(ev.slopePerBar > 0 ? 1 : ev.slopePerBar < 0 ? -1 : 0);
  }
  let flips = 0; for (let k = 1; k < signs.length; k++) if (signs[k] !== signs[k - 1]) flips++;
  const flipRate = signs.length > 1 ? flips / (signs.length - 1) : null;
  const launchAngle = (() => { const ev = headingEvent(bars.slice(0, evStart + 1), evStart, {}); return ev ? ev.slopePerBar : null; })();
  // "obvious move": first later bar that has travelled `move` from the event-start close
  let obvIdx = -1;
  for (let i = evStart + 1; i < bars.length; i++){ if (startClose > 0 && Math.abs(cl[i] - startClose) / startClose >= move){ obvIdx = i; break; } }
  const reached = obvIdx > 0;
  return {
    event: true, reached,
    leadBars: reached ? obvIdx - evStart : null,
    leadHours: reached ? round((bars[obvIdx].t - startT) / 3.6e6) : null,
    flipRate: round(flipRate),
    launchSlope: round(launchAngle),
  };
}

// ─── universe + fetch (mirrors breadth-study) ────────────────────────────────
function resolveUniverse(){
  try{
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if(Array.isArray(r.companies) && r.companies.length){
      const picked = selectMeritUniverse(r.companies, ESD_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return { tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${ESD_MAX})`,
        survivorshipFree: true };
    }
  }catch{ /* no roster yet → fall back */ }
  return { tickers: readTickers().slice(0, ESD_MAX),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)", survivorshipFree: false };
}

async function fetchRes(sym, res, key){
  const opts = res.intraday ? { lookbackMs: res.lookbackMs, minBars: res.minBars } : { minBars: res.minBars };
  let candles = await fetchPolygonAggs(sym, res.key, key, opts);
  if(res.intraday) candles = filterRegularHours(candles);
  return candles.map(c => ({ t: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => a.t - b.t);
}

function caveats(survivorshipFree){
  return [
    survivorshipFree
      ? "Universe is the Polygon survivorship-free roster (active + DE-LISTED common stock), capped to ESD_MAX for runtime — de-listed losers INCLUDED."
      : "Universe is the legacy tickers.txt survivor set — survivorship bias inflates any positive result; run universe-build for roster.json.",
    "This study only picks the TIMEFRAME that displays the SMA20 heading earliest & most stably. It does NOT measure whether the ESD projection PREDICTS anything — that is esdAccuracyBacktest's overshoot/alpha gate, and ultimately the OOS ledger.",
    "A straight-line SMA20 ray OVERSHOOTS by construction (the average lags and decelerates as price reverts). The ESD is a labeled PROJECTION, never a promise; the launch angle is descriptive, not predictive.",
    "Every per-bar read is point-in-time (headingEvent reads slice ≤ bar); the 'obvious move' reads only bars strictly after the event. Intraday bars are filtered to regular hours (RTH).",
    "IN-SAMPLE only — the timeframe pick is a research convenience, not evidence of edge.",
  ];
}

async function main(){
  const key = process.env.POLYGON_API_KEY;
  if(!key){ console.error("Set POLYGON_API_KEY — the ESD capture study prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source, survivorshipFree } = resolveUniverse();
  console.log("ESD capture universe: " + source);
  const fullUniverse = process.env.ESD_UNIVERSE === "full";

  const perReso = {};
  for(const res of RESOS) perReso[res.key] = { label: res.label, covered: 0, withEvent: 0, reached: 0, leadHours: [], flipRates: [], launchSlopes: [], droppedIlliquid: 0, errors: [] };

  for(const sym of tickers){
    for(const res of RESOS){
      const R = perReso[res.key];
      try{
        const bars = await fetchRes(sym, res, key);
        if(bars.length < WARM + 20) throw new Error(`only ${bars.length} ${res.label} bars`);
        if(!fullUniverse && !clearsLiquidityBar(bars)){ R.droppedIlliquid++; continue; }
        R.covered++;
        const m = measureName(bars);
        if(m.event){
          R.withEvent++;
          if(m.reached){ R.reached++; if(m.leadHours != null) R.leadHours.push(m.leadHours); }
          if(m.flipRate != null) R.flipRates.push(m.flipRate);
          if(m.launchSlope != null) R.launchSlopes.push(m.launchSlope);
        }
        console.log("✓ " + sym.padEnd(6) + " " + res.label.padEnd(7) + " " + bars.length + " bars" + (m.event ? (m.reached ? "  event lead=" + m.leadHours + "h flip=" + m.flipRate : "  event (move not reached)") : "  no event"));
      }catch(e){ R.errors.push(sym + ": " + (e.message || e)); console.warn("✗ " + sym.padEnd(6) + " " + res.label.padEnd(7) + " — " + (e.message || e)); }
    }
  }

  // Per-resolution summary + the recommendation (earliest median lead AND lowest median flip-rate).
  const summary = {};
  for(const res of RESOS){
    const R = perReso[res.key];
    summary[res.key] = {
      label: R.label, covered: R.covered, withEvent: R.withEvent,
      reachRate: round(R.withEvent ? R.reached / R.withEvent : null),
      medianLeadHours: median(R.leadHours), medianFlipRate: median(R.flipRates), medianLaunchSlope: median(R.launchSlopes),
      droppedIlliquid: R.droppedIlliquid, skipped: R.errors.length,
    };
  }
  // Rank: higher lead is better, lower flip-rate is better; combined rank = sum of the two ranks (lower = better).
  const keys = RESOS.map(r => r.key).filter(k => summary[k].medianLeadHours != null);
  const leadRank = [...keys].sort((a, b) => (summary[b].medianLeadHours || 0) - (summary[a].medianLeadHours || 0));
  const stabRank = [...keys].sort((a, b) => (summary[a].medianFlipRate ?? 1) - (summary[b].medianFlipRate ?? 1));
  const score = {}; keys.forEach(k => { score[k] = leadRank.indexOf(k) + stabRank.indexOf(k); });
  const recommend = keys.length ? keys.slice().sort((a, b) => score[a] - score[b])[0] : null;

  const out = {
    generatedAt: new Date().toISOString(),
    question: "Which resolution (30min / 1hour / Daily) surfaces the SMA20 below→up 'launch' heading EARLIEST and MOST STABLY?",
    universe: { requested: tickers.length, source, survivorshipFree, screen: fullUniverse ? "FULL survivorship-free roster (bias cross-check)" : "LIQUID default (illiquid dropped per resolution)" },
    config: { move: ESD_MOVE, warm: WARM, stabK: STAB_K, resolutions: RESOS.map(r => r.key) },
    summary,
    recommendation: recommend ? { resolution: recommend, label: summary[recommend].label,
      why: `earliest+steadiest by combined rank (median lead ${summary[recommend].medianLeadHours}h, flip-rate ${summary[recommend].medianFlipRate})` } : null,
    caveats: caveats(survivorshipFree),
  };
  fs.writeFileSync(path.join(ROOT, "esd-capture-study.json"), JSON.stringify(out) + "\n");
  console.log("\nesd-capture-study.json written.");

  console.log("\n── ESD CAPTURE — which timeframe flags the SMA20 launch earliest & steadiest ──");
  for(const res of RESOS){
    const S = summary[res.key];
    console.log("[" + S.label.padEnd(7) + "] covered=" + String(S.covered).padStart(3) + " events=" + String(S.withEvent).padStart(3) +
      " reachRate=" + String(S.reachRate).padStart(5) + " medLead=" + String(S.medianLeadHours).padStart(7) + "h" +
      " medFlip=" + String(S.medianFlipRate).padStart(5) + " medSlope=" + String(S.medianLaunchSlope).padStart(8));
  }
  console.log(recommend ? ("\nRECOMMENDED resolution: " + summary[recommend].label + " — " + out.recommendation.why) : "\nNo resolution produced enough events to recommend (widen ESD_MAX).");
  console.log("IN-SAMPLE pointer only — this picks the DISPLAY timeframe; predictive worth is esdAccuracyBacktest + the OOS ledger.");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
