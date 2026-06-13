// Universe-wide edge of the "Uptrend Convergence with Breakout" pattern.
//
// Pulls Polygon daily aggregates for every ticker in tickers.txt — the SAME vendor
// and adjusted bars the live app fetches with, so the historical edge is measured
// on the same feed the in-app detector signals on (vendor parity, no fallback).
// Each series is audited first (auditData) and SKIPPED if it has SEVERE issues —
// split/dividend discontinuities, bad prints, frozen feeds — so one corrupt bar
// can't poison the pooled edge. Every clean ticker is measured BOTH with the trend
// filter (the shipped default) and without, so we can see whether requiring an
// established uptrend actually buys an edge. Writes pattern-study.json (read
// same-origin by the app's Convergence-Breakout card). The pure helpers
// (parsePolygonAggs, aggregate) are unit-tested offline; main() only runs when the
// file is invoked directly, so tests can import safely.
//
// Requires POLYGON_API_KEY (the REST key). Paced for the free tier's 5 req/min;
// override with --pace <ms> or POLYGON_PACE_MS for a higher-rate plan.
//
// "Bigger sample size" lives here: ~36 tickers × years of daily bars is a far
// larger sample than any single in-app fetch can give.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backtestPattern, auditData } from "./engine.mjs";
import { readTickers } from "./build-fundamentals.mjs";
import { loadStudyUniverse } from "./universe-build.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const HORIZON = 20;
const POLY = "https://api.polygon.io";

// Supported resolutions → Polygon (multiplier, timespan), mirroring the app's
// POLY_RES so script bars match the live card across timeframes. `ms` is the bar
// period (used to tell a SETTLED bar from a still-forming one intraday). Friendly
// keys ("1day", "5min") double as the ledger's `interval` tag.
export const RESOLUTIONS = {
  "1min":  { mult: 1,  span: "minute", ms: 60_000 },
  "5min":  { mult: 5,  span: "minute", ms: 5 * 60_000 },
  "15min": { mult: 15, span: "minute", ms: 15 * 60_000 },
  "30min": { mult: 30, span: "minute", ms: 30 * 60_000 },
  "1hour": { mult: 1,  span: "hour",   ms: 60 * 60_000 },
  "1day":  { mult: 1,  span: "day",    ms: 24 * 60 * 60_000 },
  "1week": { mult: 1,  span: "week",   ms: 7 * 24 * 60 * 60_000 },
  "1month":{ mult: 1,  span: "month",  ms: 30 * 24 * 60 * 60_000 },
};

// Polygon aggregates JSON → candle array. Same mapping the app's polyBars() uses
// (o/h/l/c/v, 4-dp, drop non-positive closes) PLUS `time` (epoch ms, the bar's
// start) so intraday bars are orderable and settleable — daily code keeps using
// `date`. Pure.
export function parsePolygonAggs(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(b => ({
    date: new Date(b.t).toISOString().slice(0,10),
    time: +b.t,
    open:  +(+b.o).toFixed(4),
    high:  +(+b.h).toFixed(4),
    low:   +(+b.l).toFixed(4),
    close: +(+b.c).toFixed(4),
    volume: +b.v || 0,
  })).filter(d => d.close > 0);
}

// ─── Regular trading hours (RTH) filter for intraday bars ────────────────────
// Polygon /v2/aggs include PRE/POST-market trades. For liquid names those sessions are
// thin: 15-min bars there repeat closes (→ audit "frozen") and the overnight gap reads as
// a bar-to-bar "jump" — both flagged SEVERE, so the name is wrongly dropped. A swing/EOD
// study wants the regular session anyway. We key off the bar's epoch `time`, converted to
// New York local time (DST-correct via Intl), and keep only 09:30 ≤ start < 16:00 ET.
const ET_HM = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
export function etMinutes(epochMs){
  let h = 0, m = 0;
  for(const p of ET_HM.formatToParts(new Date(epochMs))){
    if(p.type === "hour")   h = +p.value;
    if(p.type === "minute") m = +p.value;
  }
  if(h === 24) h = 0; // some ICU builds emit 24 for midnight
  return h * 60 + m;
}
export function filterRegularHours(candles){
  return (candles || []).filter(c => {
    if(!Number.isFinite(c.time)) return true; // no intraday stamp (e.g. daily bars) → keep
    const t = etMinutes(c.time);
    return t >= 570 && t < 960;                // 09:30 (570) … 16:00 (960)
  });
}

// Pool per-ticker backtest results into one universe aggregate. Per-ticker means
// are weighted by their signal counts (baseline by eligible-bar counts) so a
// ticker with more triggers carries proportionally more weight. Pure.
export function aggregate(perTicker, horizon){
  const live = perTicker.filter(Boolean);
  const withSig = live.filter(t => t.signals > 0);
  const wsum = (arr, val, wt) => arr.reduce((a,t)=>a + val(t)*wt(t), 0);
  const totalSignals = live.reduce((a,t)=>a + t.signals, 0);
  const totalElig    = live.reduce((a,t)=>a + t.eligibleBars, 0);
  const wAvg  = totalSignals ? wsum(withSig, t=>t.avgFwdRet, t=>t.signals)/totalSignals : null;
  const wWin  = totalSignals ? wsum(withSig, t=>t.winRate,   t=>t.signals)/totalSignals : null;
  const wBase = totalElig    ? wsum(live,    t=>t.baselineAvgFwdRet, t=>t.eligibleBars)/totalElig : null;
  return {
    tickers: live.length,
    tickersWithSignals: withSig.length,
    positiveEdgeTickers: withSig.filter(t=>t.edge>0).length,
    signals: totalSignals,
    winRate: wWin,
    avgFwdRet: wAvg,
    baselineAvgFwdRet: wBase,
    edge: (wAvg!=null && wBase!=null) ? wAvg-wBase : null,
    horizon,
  };
}

// Default lookback per resolution (ms). Daily wants deep history; intraday is
// bounded so the bar count stays sane (Polygon caps at limit=50000). Tunable.
function defaultLookbackMs(span){
  if(span === "month" || span === "week") return 25 * 365 * 864e5;  // deep history for coarse bars
  if(span === "day")    return 20 * 365 * 864e5;  // ~20y of daily
  if(span === "hour")   return 3  * 365 * 864e5;  // ~3y of hourly
  return 60 * 864e5;                              // ~60d of minute bars
}

// Adjusted aggregates at ANY supported resolution. One endpoint shape serves
// 1/5/15/30-min, hourly and daily (the multiplier/timespan come from RESOLUTIONS),
// exactly like the app's polyFetchCandles. adjusted=true matches the live card.
// Exported so the forward logger and studies fetch any timeframe through one path.
export async function fetchPolygonAggs(sym, resolution, key, opts = {}){
  const spec = RESOLUTIONS[resolution];
  if(!spec) throw new Error("unknown resolution: " + resolution);
  const to = new Date();
  const from = new Date(to.getTime() - (opts.lookbackMs || defaultLookbackMs(spec.span)));
  const fmt = d => d.toISOString().slice(0,10);
  const u = `${POLY}/v2/aggs/ticker/${encodeURIComponent(sym)}/range/${spec.mult}/${spec.span}/${fmt(from)}/${fmt(to)}?adjusted=true&sort=asc&limit=${opts.limit || 50000}&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP "+r.status);
  const candles = parsePolygonAggs(await r.json());
  if(candles.length < (opts.minBars ?? 100)) throw new Error("only "+candles.length+" bars for "+sym+" @ "+resolution);
  return candles;
}

// Daily history — the common case, kept as a thin wrapper over fetchPolygonAggs so
// existing callers (signal-study, forward-log) are unchanged.
export async function fetchPolygonDaily(sym, key){
  return fetchPolygonAggs(sym, "1day", key);
}

// ─── Corporate actions: cash dividends (for the total-return benchmark) ───────
// Polygon aggregates with adjusted=true adjust for SPLITS only, NOT dividends — so a
// price-only buy-&-hold understates the true total return a holder earns. These helpers
// supply the missing dividend cash so the benchmark (and thus alpha) is honest.

// Polygon /v3/reference/dividends JSON → [{exDate, cash}] (positive cash only). Pure.
export function parseDividends(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(d => ({ exDate: d.ex_dividend_date, cash: +d.cash_amount || 0 }))
            .filter(d => d.exDate && d.cash > 0);
}

// Cash per share a holder receives over (fromDate, toDate]: dividends whose EX-date falls
// strictly after entry (they owned before it) and on/before exit. Date strings compare
// lexically (YYYY-MM-DD). Pure.
export function dividendsInWindow(divs, fromDate, toDate){
  if(!Array.isArray(divs) || !fromDate || !toDate) return 0;
  let sum = 0;
  for(const d of divs){
    if(d && d.exDate > fromDate && d.exDate <= toDate && Number.isFinite(d.cash)) sum += d.cash;
  }
  return +sum.toFixed(4);
}

// All cash dividends for a symbol (most recent first; default 1000 covers decades). Network.
export async function fetchPolygonDividends(sym, key, opts = {}){
  const u = `${POLY}/v3/reference/dividends?ticker=${encodeURIComponent(sym)}&limit=${opts.limit || 1000}&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP "+r.status+" on dividends");
  return parseDividends(await r.json());
}

// ─── News / events (event-context gate) ──────────────────────────────────────
// Fresh news around a signal is gap/event risk — capture it on every logged signal so we
// can later test whether signals near news behave differently (database-driven, honest).

// Polygon /v2/reference/news JSON → [{publishedUtc, title, sentiment}]. Pure.
export function parseNews(j){
  const res = j && j.results;
  if(!Array.isArray(res)) return [];
  return res.map(n => ({
    publishedUtc: n.published_utc,
    title: n.title || "",
    sentiment: (Array.isArray(n.insights) && n.insights[0] && n.insights[0].sentiment) || null,
  })).filter(n => n.publishedUtc);
}

// Summarize news in the `days` BEFORE asOf: count, freshest timestamp, and a net sentiment
// (majority of tagged articles). The window is the recency that matters for event risk. Pure.
export function newsWindow(news, asOf, days = 3){
  if(!Array.isArray(news) || !asOf) return { count: 0, freshestUtc: null, sentiment: null };
  const to = new Date(asOf).getTime();
  const from = to - days * 864e5;
  let count = 0, freshest = null, pos = 0, neg = 0;
  for(const n of news){
    const t = new Date(n.publishedUtc).getTime();
    if(t >= from && t <= to){
      count++;
      if(!freshest || n.publishedUtc > freshest) freshest = n.publishedUtc;
      if(n.sentiment === "positive") pos++; else if(n.sentiment === "negative") neg++;
    }
  }
  const sentiment = count === 0 ? null : (pos > neg ? "positive" : neg > pos ? "negative" : "neutral");
  return { count, freshestUtc: freshest, sentiment };
}

// Recent news articles for a symbol (newest first; default 50). Network.
export async function fetchPolygonNews(sym, key, opts = {}){
  const u = `${POLY}/v2/reference/news?ticker=${encodeURIComponent(sym)}&limit=${opts.limit || 50}&order=desc&sort=published_utc&apiKey=${encodeURIComponent(key)}`;
  const r = await fetch(u);
  if(r.status === 429) throw new Error("rate limited (429) — raise POLYGON_PACE_MS");
  if(!r.ok) throw new Error("polygon HTTP "+r.status+" on news");
  return parseNews(await r.json());
}

function parseArgs(argv){
  const a = { preview:false, dryRun:false, horizon:HORIZON, tickersFile:null,
              resolution: process.env.POLY_RESOLUTION || "1day",
              pace: +(process.env.POLYGON_PACE_MS || 0) };  // Starter: unlimited calls — no throttle needed
  for(let i=2;i<argv.length;i++){ const x=argv[i];
    if(x==="--preview") a.preview=true;
    else if(x==="--dry-run") a.dryRun=true;
    else if(x==="--horizon") a.horizon=+argv[++i];
    else if(x==="--tickers") a.tickersFile=argv[++i];
    else if(x==="--resolution") a.resolution=argv[++i];
    else if(x==="--pace") a.pace=+argv[++i];
  }
  return a;
}

// Output file per resolution: daily keeps the canonical name (CI-stable); an intraday study
// writes a suffixed sibling so it never clobbers the daily artifact. Pure.
export function studyFileFor(resolution){
  return resolution && resolution !== "1day" ? `pattern-study-${resolution}.json` : "pattern-study.json";
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));

async function main(){
  const args = parseArgs(process.argv);
  const key = process.env.POLYGON_API_KEY || process.env.POLYGON_KEY || "";
  if(!key){ console.error("Set POLYGON_API_KEY (the REST key) — the study has no fallback vendor by design."); process.exit(2); }
  if(!RESOLUTIONS[args.resolution]){ console.error("Unknown --resolution '"+args.resolution+"'. Use one of: "+Object.keys(RESOLUTIONS).join(", ")); process.exit(2); }

  const { tickers: syms, source } = loadStudyUniverse({ root: ROOT, explicitFile: args.tickersFile, readTickersFn: readTickers });
  console.log("universe: " + syms.length + " tickers — " + source + " @ " + args.resolution);
  const perF = [], perU = [], universe = [], skipped = [];
  const pct = v => v!=null ? (v*100>=0?"+":"")+(v*100).toFixed(2)+"%" : "—";
  for(let i=0;i<syms.length;i++){
    const sym = syms[i];
    try{
      const candles = await fetchPolygonAggs(sym, args.resolution, key);
      // Data hygiene: skip series with SEVERE issues (split/dividend discontinuities,
      // bad prints, frozen feeds) — one corrupt bar inflates a forward-return window
      // and poisons the pooled aggregate (this is what made META read edge −23pp).
      const audit = auditData(candles);
      if(audit.suspect){
        const codes = [...new Set(audit.issues.filter(x=>x.level==="SEVERE").map(x=>x.code))];
        skipped.push({ sym, bars:candles.length, issues:codes });
        console.log("✗ "+sym.padEnd(6)+" SKIPPED — data audit ("+codes.join(",")+"): corrupt bars would distort the edge");
        continue;
      }
      // Measure WITH the trend filter (the shipped default) and WITHOUT, so we can
      // see whether requiring an established uptrend actually buys an edge.
      const btF = backtestPattern(candles, { horizon: args.horizon, trendFilter:true });
      const btU = backtestPattern(candles, { horizon: args.horizon, trendFilter:false });
      if(btF && btU){
        perF.push(btF); perU.push(btU);
        universe.push({ sym, bars:candles.length, signals:btF.signals, winRate:btF.winRate,
                        avgFwdRet:btF.avgFwdRet, edge:btF.edge, unfiltered:{ signals:btU.signals, edge:btU.edge } });
        console.log("✓ "+sym.padEnd(6)+String(candles.length).padStart(6)+" bars · filtered "+String(btF.signals).padStart(3)+" sig edge "+pct(btF.edge)+"  | raw "+String(btU.signals).padStart(3)+" sig edge "+pct(btU.edge));
      } else {
        console.log("· "+sym.padEnd(6)+" insufficient bars for the horizon");
      }
    }catch(e){
      console.log("✗ "+sym.padEnd(6)+" "+e.message);
    }
    if(i < syms.length-1) await sleep(args.pace);  // stay under Polygon's rate limit
  }

  const out = {
    generatedAt: new Date().toISOString(),
    horizon: args.horizon,
    resolution: args.resolution,
    priceSrc: "Polygon " + args.resolution + " (adjusted)",
    trendFilter: true,
    thresholds: { coilPct:0.006, gapPct:0.004, coilLookback:8, slopeLookback:3, trendFilter:true, trendLookback:20, trendMinSlope:0.01 },
    aggregate: aggregate(perF, args.horizon),                 // the shipped (trend-filtered) detector
    unfilteredAggregate: aggregate(perU, args.horizon),       // same setup without the trend gate
    skipped,
    universe,
  };
  if(args.preview || args.dryRun){
    console.log("\nFILTERED:   "+JSON.stringify(out.aggregate));
    console.log("UNFILTERED: "+JSON.stringify(out.unfilteredAggregate));
    if(skipped.length) console.log("SKIPPED:    "+skipped.map(s=>s.sym+"("+s.issues.join("/")+")").join(", "));
    return;
  }
  // Never clobber a good study with an empty one (e.g. a bad key or a total outage).
  const outFile = studyFileFor(args.resolution);
  if(universe.length === 0){ console.error("No ticker returned usable data — refusing to overwrite "+outFile+"."); process.exit(1); }
  fs.writeFileSync(path.join(ROOT, outFile), JSON.stringify(out)+"\n");
  console.log("\nWrote "+outFile+" — "+universe.length+" tickers ("+skipped.length+" skipped). Pooled edge over "+args.horizon+" bars @ "+args.resolution+": filtered "+pct(out.aggregate.edge)+" vs raw "+pct(out.unfilteredAggregate.edge)+".");
}

if(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)){
  main().catch(e=>{ console.error(e); process.exit(1); });
}
