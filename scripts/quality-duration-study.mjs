// Quality × Duration study — tests the intuition: does owning HIGH-QUALITY stocks and holding over a
// DURATION mature into realized value (hit-rate + alpha), vs low-quality and vs just holding SPY?
// Runs in CI (POLYGON_API_KEY + egress). In-sample MEASUREMENT, not a promotion.
//
// ALL POLYGON (charter-pure — the only vendor): quality = ROE computed from Polygon's financials
// endpoint (net income ÷ equity, point-in-time by filing_date); prices = Polygon adjusted monthly.
// SEC EDGAR is avoided entirely (it 403s the CI runner anyway).
//
// Method (point-in-time, no lookahead):
//  • At each monthly rebalance, ROE = the most recent ANNUAL filing whose filing_date ≤ rb (public).
//  • Tag HIGH (ROE>0.15) / MID / LOW (ROE<0.08); measure forward 3 / 6 / 12-MONTH return, whether it
//    ended positive (the "hit"), and the alpha vs holding SPY over the identical window.
//  • Universe is quality-VARIED on purpose so the high-vs-low contrast isolates quality from drift.
//
// The question: does HIGH quality lift the hit-rate AND the alpha as the hold lengthens ("bring it
// home")? If high≈low≈SPY → beta. If high ≫ low and beats SPY → real selection value.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { priceOnOrBefore, grid, addMonths } from "./build-study.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { valueScore } from "./engine.mjs";
import { meritMetrics } from "./sec-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// fundamentals.json — the app's AUTOPSY data (SEC-distilled rec per name). Used for the A/B/C
// grade (valueScore at the latest price). Default universe = every graded name (a real scan).
let FUNDA = {};
try { FUNDA = JSON.parse(fs.readFileSync(path.join(ROOT, "fundamentals.json"), "utf8")); } catch { /* none → fall back */ }

// Quality-VARIED US universe (point-in-time ROE decides the bucket, not this list).
const STOCKS = (process.env.QD_STOCKS || Object.keys(FUNDA).join(",") ||
  "AAPL,MSFT,NVDA,GOOGL,META,V,MA,COST,LLY,HD,JNJ,PG," +   // typically high-ROE
  "JPM,XOM,KO,CSCO,DIS,NKE," +                              // mid
  "INTC,F,T,VZ,WBA,PFE,KHC,BAC,PARA,GM").split(",");        // typically low-ROE / cyclical / struggling
const DURATIONS = { "3mo": 3, "6mo": 6, "12mo": 12 };
const HIGH_ROE = 0.15, LOW_ROE = 0.08;

const round = (x, d = 3) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function monthly(sym, key) {
  const c = await fetchPolygonAggs(sym, "1month", key, { minBars: 13 });
  return c.map(b => ({ t: b.time, close: b.close })).sort((a, b) => a.t - b.t);
}

// ROE series from Polygon financials: net income ÷ equity, keyed by filing date (point-in-time).
async function polyROE(sym, key) {
  const u = "https://api.polygon.io/vX/reference/financials?ticker=" + encodeURIComponent(sym) +
    "&timeframe=annual&order=asc&limit=20&apiKey=" + encodeURIComponent(key);
  const r = await fetch(u);
  if (!r.ok) throw new Error("financials HTTP " + r.status);
  const j = await r.json();
  const out = [];
  for (const res of (j.results || [])) {
    const fin = res.financials || {};
    const ni = fin.income_statement && fin.income_statement.net_income_loss && fin.income_statement.net_income_loss.value;
    const bs = fin.balance_sheet || {};
    const eq = (bs.equity_attributable_to_parent && bs.equity_attributable_to_parent.value) ?? (bs.equity && bs.equity.value);
    const filing = res.filing_date || res.end_date;
    if (ni != null && eq > 0 && filing) out.push({ t: Date.parse(filing), roe: ni / eq });
  }
  return out.sort((a, b) => a.t - b.t);
}

async function main() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) { console.error("Set POLYGON_API_KEY — this study prices off Polygon (the only vendor)."); process.exit(2); }

  const spy = await monthly("SPY", key);
  console.log("SPY: " + spy.length + " monthly bars · loading " + STOCKS.length + " names (Polygon financials)…");

  const dates = grid(1);
  const tags = ["HIGH", "MID", "LOW"];
  const agg = {}; for (const t of tags) { agg[t] = {}; for (const d of Object.keys(DURATIONS)) agg[t][d] = { rets: [], alphas: [], hits: 0, beats: 0, n: 0 }; }
  const perStock = [];

  for (const sym of STOCKS) {
    let prices, fin;
    try { prices = await monthly(sym, key); fin = await polyROE(sym, key); }
    catch (e) { console.warn("✗ " + sym + " " + (e.message || e)); continue; }
    if (!prices.length || !fin.length) { console.warn("✗ " + sym + " no prices/financials (" + prices.length + "/" + fin.length + ")"); continue; }
    const lastT = prices[prices.length - 1].t;
    const roeAt = rbMs => { let v = null; for (const f of fin) { if (f.t <= rbMs) v = f.roe; else break; } return v; };  // latest filing ≤ rb
    // AUTOPSY grade (A/B/C/D/F) — the app's valueScore at the latest price, from fundamentals.json.
    const rec = FUNDA[sym];
    const grade = rec ? ((valueScore(meritMetrics(rec, prices[prices.length - 1].close)) || {}).grade || null) : null;
    const ps = { sym, roeLatest: round(fin[fin.length - 1].roe, 3), grade, six: { HIGH: 0, MID: 0, LOW: 0 }, hit6: [], ret6: [], alpha6: [], ret12: [], alpha12: [] };

    for (const rb of dates) {
      const roe = roeAt(rb); if (roe == null) continue;
      const tag = roe >= HIGH_ROE ? "HIGH" : roe < LOW_ROE ? "LOW" : "MID";
      const entry = priceOnOrBefore(prices, rb), sEntry = priceOnOrBefore(spy, rb);
      if (!(entry > 0) || !(sEntry > 0)) continue;
      for (const [dn, dm] of Object.entries(DURATIONS)) {
        const fwdT = addMonths(rb, dm); if (fwdT > lastT) continue;
        const exit = priceOnOrBefore(prices, fwdT), sExit = priceOnOrBefore(spy, fwdT);
        if (!(exit > 0) || !(sExit > 0)) continue;
        const ret = (exit / entry - 1) * 100, sRet = (sExit / sEntry - 1) * 100;
        const b = agg[tag][dn]; b.n++; b.rets.push(ret); b.alphas.push(ret - sRet); if (ret > 0) b.hits++; if (ret > sRet) b.beats++;
        if (dn === "6mo") { ps.six[tag]++; ps.hit6.push(ret > 0 ? 1 : 0); ps.ret6.push(ret); ps.alpha6.push(ret - sRet); }
        if (dn === "12mo") { ps.ret12.push(ret); ps.alpha12.push(ret - sRet); }
      }
    }
    ps.bucket6 = ps.six.HIGH >= ps.six.LOW && ps.six.HIGH >= ps.six.MID ? "HIGH" : ps.six.LOW > ps.six.MID ? "LOW" : "MID";
    ps.hitRate6 = round(mean(ps.hit6) * 100, 1); ps.meanRet6 = round(mean(ps.ret6), 1); ps.meanAlpha6 = round(mean(ps.alpha6), 1);
    ps.meanAlpha12 = round(mean(ps.alpha12), 1);
    perStock.push(ps);
    console.log("  ✓ " + sym.padEnd(6) + " grade=" + (ps.grade || "?") + " ROE=" + ps.roeLatest + " 6mo hit%=" + ps.hitRate6 + " alpha=" + ps.meanAlpha6 + " 12mo alpha=" + ps.meanAlpha12);
  }

  const roll = {}; for (const t of tags) { roll[t] = {}; for (const dn of Object.keys(DURATIONS)) { const b = agg[t][dn]; roll[t][dn] = {
    n: b.n, hitRate: round(b.n ? b.hits / b.n * 100 : null, 1), beatSpyRate: round(b.n ? b.beats / b.n * 100 : null, 1),
    meanRet: round(mean(b.rets), 2), medRet: round(median(b.rets), 2), meanAlpha: round(mean(b.alphas), 2), medAlpha: round(median(b.alphas), 2),
  }; } }

  // WINNERS scan: how to "find more" — names that cleared ≥60% 6-mo hit AND positive 6-mo alpha,
  // with their AUTOPSY grade. Plus a grade → mean-12mo-alpha cross-tab (does grade predict the edge?).
  const winners = perStock.filter(p => p.hitRate6 != null && p.hitRate6 >= 60 && p.meanAlpha6 > 0)
    .sort((a, b) => (b.meanAlpha6 || 0) - (a.meanAlpha6 || 0))
    .map(p => ({ sym: p.sym, grade: p.grade, roe: p.roeLatest, hit6: p.hitRate6, alpha6: p.meanAlpha6, alpha12: p.meanAlpha12 }));
  const byGrade = {}; for (const g of ["A", "B", "C", "D", "F"]) {
    const rows = perStock.filter(p => p.grade === g);
    if (rows.length) byGrade[g] = { n: rows.length, meanHit6: round(mean(rows.map(p => p.hitRate6).filter(v => v != null)), 1),
      meanAlpha6: round(mean(rows.map(p => p.meanAlpha6).filter(v => v != null)), 2), meanAlpha12: round(mean(rows.map(p => p.meanAlpha12).filter(v => v != null)), 2),
      names: rows.map(p => p.sym) };
  }

  const out = {
    generatedAt: new Date().toISOString(), source: "Polygon monthly (adjusted) + Polygon financials ROE (net income ÷ equity, by filing_date) + AUTOPSY grade (valueScore @ latest price)",
    durations: DURATIONS, thresholds: { highRoe: HIGH_ROE, lowRoe: LOW_ROE }, benchmark: "SPY (held the identical window)",
    byQuality: roll, byGrade, winners60: winners, perStock: perStock.sort((a, b) => (b.roeLatest || -9) - (a.roeLatest || -9)),
    caveats: [
      "In-sample MEASUREMENT over ~5y of Polygon Starter history; point-in-time ROE by filing_date. Not a promotion.",
      "Survivor-biased: today's listings; de-listed failures absent, which FLATTERS low-quality.",
      "Alpha is vs SPY over the identical hold window (beta-honest); a HIGH bucket that beats SPY is selection, not drift.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "quality-duration-study.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("\n── ROLLUP (hit% / meanAlpha vs SPY) ──");
  for (const t of tags) console.log(t.padEnd(5) + Object.keys(DURATIONS).map(dn => " " + dn + ": hit%=" + roll[t][dn].hitRate + " alpha=" + roll[t][dn].meanAlpha + " (n=" + roll[t][dn].n + ")").join(" |"));
  console.log("\n── BY AUTOPSY GRADE (does grade predict the edge?) ──");
  for (const g of Object.keys(byGrade)) console.log("  " + g + ": n=" + byGrade[g].n + " 6mo hit%=" + byGrade[g].meanHit6 + " 6mo alpha=" + byGrade[g].meanAlpha6 + " 12mo alpha=" + byGrade[g].meanAlpha12 + " · " + byGrade[g].names.join(","));
  console.log("\n── WINNERS (≥60% 6-mo hit AND positive alpha) — how to find more ──");
  for (const w of winners) console.log("  " + w.sym.padEnd(6) + " grade=" + (w.grade || "?") + " ROE=" + w.roe + " hit%=" + w.hit6 + " 6mo alpha=" + w.alpha6 + " 12mo alpha=" + w.alpha12);
  console.log("Wrote quality-duration-study.json.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
