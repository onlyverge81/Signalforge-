// CONTENDER MONITOR — a live, market-hours sweep that CAPTURES the convergence (coil→pop)
// setup + the engine's read across ALL contenders WHILE IT'S HAPPENING, instead of you having
// to open one stock at a time. Runs on a schedule (see contender-monitor.yml); writes
// contender-monitor.json which the app's MONITOR tab renders.
//
// HONESTY (binding):
//  • The feed is 15-MINUTE DELAYED (Polygon Stocks Starter) — this is awareness within ~15 min,
//    NOT real-time execution. Never badged "real-time".
//  • The convergence pattern is a MEASURED LOSER universe-wide (edge ≈ −0.71% over 20 bars). It
//    is shown as a geometry TRIGGER only — never a proven buy. A "lead" is grounded by the
//    contender's vetted quality (grade A/B + momentum + filing = allBoxes, baked in
//    contenders.json) plus the engine's live read — none of which is OOS-proven either.
//  • Display/awareness only. This script reads analyze() output; it changes no gate or verdict.
// Needs POLYGON_API_KEY (no fallback vendor by design); no-ops without it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, convergenceForming } from "./engine.mjs";
import { fetchPolygonAggs, filterRegularHours, etMinutes } from "./pattern-study.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const OPEN_MIN  = 590; // 09:50 ET — start 20 min after the open (skip the opening chaos)
export const CLOSE_MIN = 960; // 16:00 ET — the close
export const PATTERN_EDGE_NOTE =
  "Convergence (coil→pop) universe edge ≈ −0.71% over 20 bars — a geometry TRIGGER, not a proven signal. Treat leads as candidates for your own eyes, never as a buy.";

// Pure market-hours gate: weekday (0=Sun..6=Sat, ET) + minutes-since-ET-midnight → is the
// session in the monitor window? Pure so the boundary logic is unit-tested without mocking Date.
export function withinSession(weekday, etMin, opts = {}){
  const openMin  = opts.openMin  ?? OPEN_MIN;
  const closeMin = opts.closeMin ?? CLOSE_MIN;
  const isWeekday = weekday >= 1 && weekday <= 5;
  const inHours = etMin >= openMin && etMin <= closeMin;
  return { open: isWeekday && inHours, isWeekday, inHours, weekday, etMin, openMin, closeMin };
}

// ET weekday + minutes for a wall-clock instant (DST-correct via Intl). Impure (reads the clock
// via the passed epoch); kept thin so withinSession holds all the testable logic.
const ET_WD = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" });
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function etParts(epochMs){
  const wd = WD[ET_WD.format(new Date(epochMs))] ?? 0;
  return { weekday: wd, etMin: etMinutes(epochMs) };
}

// Classify one scanned record into a lead. A lead fires on ANY notable signal (extensible —
// add future setups to the OR); "grounded" is the evidence-leaning case (vetted quality + a
// live engine BUY). The convergence flag is labeled as geometry-only so it never reads as proof.
export function classifyLead(rec){
  const buy  = !!(rec.engine && rec.engine.signal === "BUY");
  const conv = !!(rec.conv && rec.conv.detected);
  // FORMING is the EARLY stage — only while it has NOT yet broken out (once it pops it's a BREAKOUT).
  const forming = !!(rec.forming && rec.forming.forming) && !conv;
  const lead = buy || conv || forming;
  const grounded = !!(rec.allBoxes && buy);
  const stage = conv ? "BREAKOUT" : forming ? "FORMING" : null; // convergence lifecycle stage (null = pure engine read)
  const reasons = [];
  if(buy)  reasons.push("engine BUY (intraday — tactical, unproven)");
  if(conv) reasons.push("coil→pop BREAKOUT (geometry only; pattern edge ≈ −0.71%)");
  if(forming) reasons.push(`⏳ convergence FORMING — ribbon tightening ${(rec.forming && rec.forming.barsForming) || 0} bars (early-warning; ~1 bar to pop once it pinches)`);
  if(rec.allBoxes) reasons.push("vetted all-boxes (A/B + momentum + filing)");
  // NOTE: return `stage` (not a `forming` boolean) so the spread {...rec, ...classifyLead(rec)} never
  // clobbers rec.forming — the OBJECT carrying barsForming/tightness/startDate the UI needs.
  return { lead, grounded, stage, reasons };
}

// Rank leads: grounded first, then live BUYs, then BREAKOUT before FORMING, then by strength/tightness
// — so the dead-pattern geometry can NEVER outrank a quality-grounded engine read, and a confirmed pop
// outranks a still-forming squeeze.
export function rankLeads(records){
  const stageRank = r => r.stage === "BREAKOUT" ? 2 : r.stage === "FORMING" ? 1 : 0;
  return (records || []).filter(r => r.lead).sort((a, b) => {
    if(a.grounded !== b.grounded) return a.grounded ? -1 : 1;
    const ab = a.engine && a.engine.signal === "BUY" ? 1 : 0;
    const bb = b.engine && b.engine.signal === "BUY" ? 1 : 0;
    if(ab !== bb) return bb - ab;
    if(stageRank(a) !== stageRank(b)) return stageRank(b) - stageRank(a); // BREAKOUT before FORMING
    const as = a.stage === "FORMING" ? ((a.forming && a.forming.tightness) || 0) : ((a.conv && a.conv.strength) || 0);
    const bs = b.stage === "FORMING" ? ((b.forming && b.forming.tightness) || 0) : ((b.conv && b.conv.strength) || 0);
    return bs - as;
  });
}

// Assemble the committed report. Pure → the honesty caveats + the pattern-edge note are
// guaranteed present on every report (unit-tested), and the ranking is deterministic.
export function buildReport({ generatedAt, session, records = [], scanned = 0, withData = 0, dataFresh = false }){
  const ranked   = rankLeads(records.map(r => ({ ...r, ...classifyLead(r) })));
  const grounded = ranked.filter(l => l.grounded);
  return {
    generatedAt,
    sessionET: session ? { weekday: session.weekday, etMin: session.etMin } : null,
    marketOpen: !!(session && session.open),
    delayedMin: 15,
    dataFresh: !!dataFresh,
    scanned, withData,
    counts: {
      leads: ranked.length,
      grounded: grounded.length,
      buys: records.filter(r => r.engine && r.engine.signal === "BUY").length,
      convergence: records.filter(r => r.conv && r.conv.detected).length,
      forming: records.filter(r => r.forming && r.forming.forming && !(r.conv && r.conv.detected)).length,
    },
    patternEdgeNote: PATTERN_EDGE_NOTE,
    leads: ranked.slice(0, 120),
    caveats: [
      "Feed is 15-MINUTE DELAYED (Polygon Stocks Starter) — every read is ~15 min behind. Awareness, NOT real-time execution.",
      "The convergence (coil→pop) pattern is a MEASURED LOSER universe-wide (edge ≈ −0.71%); shown as a geometry trigger only.",
      "The intraday engine verdict is itself unproven (the tactical confluence is an in-sample loser, t ≈ −12.6); leads are candidates for the human, never proven signals.",
      "Grounded = a vetted all-boxes (A/B + momentum + filing) name with a live engine BUY — the most evidence-leaning case, still not OOS-proven.",
    ],
  };
}

const OUT = path.join(ROOT, "contender-monitor.json");
const write = obj => fs.writeFileSync(OUT, JSON.stringify(obj, null, 1) + "\n");

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY — the monitor has no fallback vendor by design."); process.exit(2); }

  const now = Date.now();
  const { weekday, etMin } = etParts(now);
  const session = withinSession(weekday, etMin);
  // Outside the 09:50–16:00 ET weekday window: exit clean WITHOUT rewriting the file, so the last
  // in-session report persists on the site and we don't churn a commit every off-hours cron tick.
  if(!session.open){
    console.log(`market closed (weekday ${weekday}, ET min ${etMin}; window ${session.openMin}-${session.closeMin}) — no scan, leaving last report intact.`);
    process.exit(0);
  }

  let db;
  try { db = JSON.parse(fs.readFileSync(path.join(ROOT, "contenders.json"), "utf8")); }
  catch { console.error("contenders.json missing — run build-contenders first."); process.exit(2); }
  const names = (db.contenders || []).filter(c => c && c.sym);
  const resolution = process.env.MON_RESOLUTION || "15min";
  const lookbackDays = +(process.env.MON_LOOKBACK_DAYS || 20);   // ~14 trading days of 15-min RTH bars
  const pace = +(process.env.POLYGON_PACE_MS || 0);
  console.log(`monitor: ${names.length} contenders @ ${resolution}, ~${lookbackDays}d, ET min ${etMin}`);

  const records = [];
  let withData = 0, freshCount = 0;
  for(let i = 0; i < names.length; i++){
    const c = names[i], sym = c.sym;
    try {
      const raw = await fetchPolygonAggs(sym, resolution, key, { lookbackMs: lookbackDays * 864e5, minBars: 80 });
      const bars = filterRegularHours(raw);
      if(bars.length < 80) continue;
      const a = analyze(bars, sym, "Stocks", "Trend Following", 1.5, 2.0);
      withData++;
      const last = bars[bars.length - 1];
      const fresh = Number.isFinite(last.time) ? (now - last.time) <= 45 * 60e3 : false; // ≤45 min ⇒ live-ish on a 15-min-delayed feed
      if(fresh) freshCount++;
      const cb = a.convBreakout || null;
      // FORMING-stage read: the ribbon tightening BEFORE the pop (the early-warning the timing study
      // located ~5h ahead of the pinch on 15-min). Captured here as its own lifecycle stage.
      const cf = convergenceForming(bars) || { forming: false };
      let forming = { forming: false };
      if(cf.forming){
        const startBar = bars[cf.formingStartIdx] || null;
        forming = { forming: true, barsForming: cf.barsForming, tightness: cf.tightness, nearPinch: !!cf.nearPinch,
          startMs: (startBar && startBar.time) || null, startDate: (startBar && startBar.date) || null };
      }
      records.push({
        sym, entity: c.entity || null, grade: c.grade || null, allBoxes: !!c.allBoxes,
        price: a.entry, lastBarMs: last.time || null, fresh,
        conv: cb ? { detected: !!cb.detected, strength: cb.strength != null ? +(+cb.strength).toFixed(3) : null } : { detected: false, strength: null },
        forming,
        patternEdge: a.convBreakoutTest && Number.isFinite(a.convBreakoutTest.edge) ? +(a.convBreakoutTest.edge * 100).toFixed(3) : null,
        engine: { signal: a.signal, score: a.score, confidence: a.confidence, entry: a.entry, sl: a.sl, tp1: a.tp1, rr: a.rr },
      });
      if(i % 50 === 0) console.log(`  …${i}/${names.length} (${sym})`);
    } catch(e){ /* thin/no-data name — skip silently */ }
    if(i < names.length - 1 && pace) await sleep(pace);
  }

  const report = buildReport({
    generatedAt: new Date().toISOString(), session, records,
    scanned: names.length, withData, dataFresh: freshCount > withData * 0.5,
  });
  write(report);
  console.log(`wrote contender-monitor.json — ${report.counts.leads} leads (${report.counts.grounded} grounded, ${report.counts.buys} BUY, ${report.counts.convergence} coil→pop, ${report.counts.forming} ⏳forming) over ${withData}/${names.length} names with data.`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
