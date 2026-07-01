// ESD SWEEP — a market-hours sweep that surfaces which CONTENDERS are flashing the SMA20
// "nautical heading" (the ESD launch) RIGHT NOW, instead of you opening one stock at a time.
// Runs on a schedule (see esd-sweep.yml, first scan ~9:55 ET then ~every 30 min); writes
// esd-sweep.json which the app's 🚀 ESD tab renders.
//
// HONESTY (binding):
//  • The feed is 15-MINUTE DELAYED (Polygon Stocks Starter) — awareness within ~15 min, NOT
//    real-time execution. Never badged "real-time".
//  • The ESD is a straight-line SMA20 projection — it OVERSHOOTS by construction (a moving
//    average lags and decelerates as price reverts). A heading "lead" is a candidate for the
//    human's own eyes, NEVER a proven target. The engine read it carries is itself unproven.
//  • Display/awareness only. Reads analyze() + esdProject() output; changes no gate or verdict.
// Needs POLYGON_API_KEY (no fallback vendor by design); no-ops without it.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyze, esdProject, headingEvent } from "./engine.mjs";
import { fetchPolygonAggs, filterRegularHours } from "./pattern-study.mjs";
import { withinSession, etParts } from "./contender-monitor.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sleep = ms => new Promise(r => setTimeout(r, ms));

export const ESD_OPEN_MIN  = 595; // 09:55 ET — the user's first-scan time (25 min after the open)
export const ESD_CLOSE_MIN = 960; // 16:00 ET — the close
export const ESD_NOTE =
  "The ESD is a straight-line SMA20 projection — it OVERSHOOTS by construction (a moving average lags and decelerates). A heading lead is a candidate for your own eyes, never a proven target.";

// Classify one scanned record into an ESD heading lead. A lead = the SMA20 has SEPARATED from the
// fast-MA pack AND its ray reaches a level (esd.valid). "grounded" = the same on a vetted all-boxes
// (A/B + momentum + filing) name — the most evidence-leaning case, still not OOS-proven.
export function classifyEsdLead(rec){
  const valid = !!(rec.esd && rec.esd.valid);
  const separated = !!(rec.heading && rec.heading.separated);
  const lead = separated && valid;
  const grounded = !!(rec.allBoxes && lead);
  const reasons = [];
  if(lead) reasons.push(`SMA20 heading ${rec.heading.leaning} (${rec.heading.side} the pack) → ${rec.esd.targetName} $${rec.esd.targetPrice} in ~${Math.round(rec.esd.etaBars)} bars at ${rec.esd.angleDeg}° (projection)`);
  if(rec.allBoxes) reasons.push("vetted all-boxes (A/B + momentum + filing)");
  return { lead, grounded, reasons };
}

// Rank: grounded first, then the STEEPER heading (|angle|), then the SOONER ETA — so a quality-grounded
// heading always outranks a bare one, and the most-imminent projections surface on top.
export function rankEsdLeads(records){
  return (records || []).filter(r => r.lead).sort((a, b) => {
    if(a.grounded !== b.grounded) return a.grounded ? -1 : 1;
    const aa = Math.abs((a.esd && a.esd.angleDeg) || 0), ba = Math.abs((b.esd && b.esd.angleDeg) || 0);
    if(aa !== ba) return ba - aa;                          // steeper heading first
    const ae = (a.esd && a.esd.etaBars) != null ? a.esd.etaBars : Infinity;
    const be = (b.esd && b.esd.etaBars) != null ? b.esd.etaBars : Infinity;
    return ae - be;                                        // sooner ETA first
  });
}

// Assemble the committed report. Pure → the honesty caveats + the projection note are guaranteed
// present on every report (unit-tested), and the ranking is deterministic.
export function buildReport({ generatedAt, session, records = [], scanned = 0, withData = 0, dataFresh = false, resolution = null }){
  const ranked   = rankEsdLeads(records.map(r => ({ ...r, ...classifyEsdLead(r) })));
  const grounded = ranked.filter(l => l.grounded);
  return {
    generatedAt, resolution,
    sessionET: session ? { weekday: session.weekday, etMin: session.etMin } : null,
    marketOpen: !!(session && session.open),
    delayedMin: 15,
    dataFresh: !!dataFresh,
    scanned, withData,
    counts: {
      leads: ranked.length,
      grounded: grounded.length,
      up: ranked.filter(l => l.heading && l.heading.leaning === "up").length,
      down: ranked.filter(l => l.heading && l.heading.leaning === "down").length,
    },
    esdNote: ESD_NOTE,
    leads: ranked.slice(0, 120),
    caveats: [
      "Feed is 15-MINUTE DELAYED (Polygon Stocks Starter) — every read is ~15 min behind. Awareness, NOT real-time execution.",
      "The ESD is a labeled PROJECTION that overshoots by construction; the SMA20 heading and the engine read are both UNPROVEN.",
      "A lead = the SMA20 has separated from the fast-MA pack AND its ray reaches a level. Candidates for the human eye, never proven buys.",
      "Display/awareness only — touches no gate or verdict.",
    ],
  };
}

const OUT = path.join(ROOT, "esd-sweep.json");
const write = obj => fs.writeFileSync(OUT, JSON.stringify(obj, null, 1) + "\n");

async function main(){
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY — the ESD sweep has no fallback vendor by design."); process.exit(2); }

  const now = Date.now();
  const { weekday, etMin } = etParts(now);
  const session = withinSession(weekday, etMin, { openMin: ESD_OPEN_MIN, closeMin: ESD_CLOSE_MIN });
  // Outside the 09:55–16:00 ET weekday window: exit clean WITHOUT rewriting, so the last in-session
  // report persists on the site and we don't churn a commit every off-hours cron tick.
  if(!session.open){
    console.log(`market closed (weekday ${weekday}, ET min ${etMin}; window ${session.openMin}-${session.closeMin}) — no sweep, leaving last report intact.`);
    process.exit(0);
  }

  let db;
  try { db = JSON.parse(fs.readFileSync(path.join(ROOT, "contenders.json"), "utf8")); }
  catch { console.error("contenders.json missing — run build-contenders first."); process.exit(2); }
  const names = (db.contenders || []).filter(c => c && c.sym);
  const resolution = process.env.ESD_RESOLUTION || "1hour";    // SMA20 on 1-hour ≈ a ~3-day swing heading
  const lookbackDays = +(process.env.ESD_LOOKBACK_DAYS || 120);
  const pace = +(process.env.POLYGON_PACE_MS || 0);
  console.log(`esd-sweep: ${names.length} contenders @ ${resolution}, ~${lookbackDays}d, ET min ${etMin}`);

  const records = [];
  let withData = 0, freshCount = 0;
  for(let i = 0; i < names.length; i++){
    const c = names[i], sym = c.sym;
    try {
      const raw = await fetchPolygonAggs(sym, resolution, key, { lookbackMs: lookbackDays * 864e5, minBars: 80 });
      const bars = filterRegularHours(raw);
      if(bars.length < 60) continue;                          // need ≥ ~31 for headingEvent, with margin
      const a = analyze(bars, sym, "Stocks", "Trend Following", 1.5, 2.0);
      withData++;
      const last = bars[bars.length - 1];
      const fresh = Number.isFinite(last.time) ? (now - last.time) <= 2 * 3600e3 : false; // ≤2h on hourly ⇒ live-ish (15-min delayed)
      if(fresh) freshCount++;
      const ev  = headingEvent(bars, bars.length - 1, {}) || null;
      const esd = esdProject(bars, { sl: a.sl, tp1: a.tp1, support: a.support, resistance: a.resistance }, {}) || null;
      records.push({
        sym, entity: c.entity || null, grade: c.grade || null, allBoxes: !!c.allBoxes,
        price: a.entry, lastBarMs: last.time || null, fresh,
        heading: ev  ? { separated: !!ev.separated, side: ev.side, leaning: ev.leaning, gapATR: ev.gapATR } : null,
        esd:     esd ? { valid: !!esd.valid, leaning: esd.leaning, angleDeg: esd.angleDeg, targetName: esd.targetName, targetPrice: esd.targetPrice, etaBars: esd.etaBars } : null,
        engine:  { signal: a.signal, score: a.score, confidence: a.confidence },
      });
      if(i % 50 === 0) console.log(`  …${i}/${names.length} (${sym})`);
    } catch(e){ /* thin/no-data name — skip silently */ }
    if(i < names.length - 1 && pace) await sleep(pace);
  }

  const report = buildReport({
    generatedAt: new Date().toISOString(), session, records,
    scanned: names.length, withData, dataFresh: freshCount > withData * 0.5, resolution,
  });
  write(report);
  console.log(`wrote esd-sweep.json — ${report.counts.leads} heading leads (${report.counts.grounded} grounded, ${report.counts.up}↑ ${report.counts.down}↓) over ${withData}/${names.length} names with data.`);
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e => { console.error(e); process.exit(1); });
}
