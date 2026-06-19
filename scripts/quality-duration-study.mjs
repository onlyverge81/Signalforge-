// Quality × Duration study — tests the intuition: does owning HIGH-QUALITY stocks and holding over a
// DURATION mature into realized value (hit-rate + alpha), vs low-quality and vs just holding SPY?
// Runs in CI (POLYGON_API_KEY + egress). In-sample MEASUREMENT, not a promotion.
//
// Method (point-in-time, no lookahead):
//  • Quality = ROE distilled from SEC XBRL at each rebalance with the merit 75-day filing lag.
//  • Universe is quality-VARIED on purpose (high-ROE compounders + low-ROE/cyclical/struggling names)
//    so the high-vs-low contrast isolates quality from general drift.
//  • At each monthly rebalance, tag the name HIGH (ROE>0.15) / MID / LOW (ROE<0.08), then measure the
//    forward 3 / 6 / 12-MONTH return, whether it ended positive (the "hit"), and the alpha vs holding
//    SPY over the identical window. Prices: Polygon adjusted monthly closes (the only vendor).
//
// The question: does HIGH quality lift the hit-rate AND the alpha as the hold lengthens ("bring it
// home")? If high≈low≈SPY, quality+duration is just beta. If high ≫ low and beats SPY, it's real.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distill as realDistill } from "./build-fundamentals.mjs";
import { loadTicker, priceOnOrBefore, meritAsOfISO, grid, addMonths, iso } from "./build-study.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

// Quality-VARIED US universe (point-in-time ROE decides the bucket, not this list).
const STOCKS = (process.env.QD_STOCKS ||
  "AAPL,MSFT,NVDA,GOOGL,META,V,MA,COST,LLY,HD,JNJ,PG," +   // typically high-ROE
  "JPM,XOM,KO,CSCO,DIS,NKE," +                              // mid
  "INTC,F,T,VZ,WBA,PFE,KHC,BAC,PARA,GM").split(",");        // typically low-ROE / cyclical / struggling
const DURATIONS = { "3mo": 3, "6mo": 6, "12mo": 12 };
const HIGH_ROE = 0.15, LOW_ROE = 0.08;

const round = (x, d = 3) => x == null || !isFinite(x) ? null : Math.round(x * 10 ** d) / 10 ** d;
const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

async function spyPrices(key) {
  const c = await fetchPolygonAggs("SPY", "1month", key, { minBars: 13 });
  return c.map(b => ({ t: b.time, close: b.close })).sort((a, b) => a.t - b.t);
}

async function main() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) { console.error("Set POLYGON_API_KEY — this study prices off Polygon (the only vendor)."); process.exit(2); }

  const spy = await spyPrices(key);
  console.log("SPY: " + spy.length + " monthly bars · loading " + STOCKS.length + " names…");

  const dates = grid(1);                                    // monthly rebalance grid
  // buckets[tag][dur] = { rets:[], alphas:[], hits:[], beats:[] }
  const tags = ["HIGH", "MID", "LOW"];
  const agg = {}; for (const t of tags) { agg[t] = {}; for (const d of Object.keys(DURATIONS)) agg[t][d] = { rets: [], alphas: [], hits: 0, beats: 0, n: 0 }; }
  const perStock = [];

  for (const sym of STOCKS) {
    let d; try { d = await loadTicker(sym, key); } catch (e) { console.warn("✗ " + sym + " " + (e.message || e)); continue; }
    const prices = d.prices; if (!prices || prices.length < 13) { console.warn("✗ " + sym + " thin prices"); continue; }
    const lastT = prices[prices.length - 1].t;
    const ps = { sym, roeLatest: null, six: { HIGH: 0, MID: 0, LOW: 0 }, hit6: [], ret6: [], alpha6: [] };
    let lastRoe = null;
    for (const rb of dates) {
      const rec = distillSafe(d.j, meritAsOfISO(rb));
      const roe = rec && rec.roe != null && isFinite(rec.roe) ? Number(rec.roe) : null;
      if (roe == null) continue; lastRoe = roe;
      const tag = roe >= HIGH_ROE ? "HIGH" : roe < LOW_ROE ? "LOW" : "MID";
      const entry = priceOnOrBefore(prices, rb), sEntry = priceOnOrBefore(spy, rb);
      if (!(entry > 0) || !(sEntry > 0)) continue;
      for (const [dn, dm] of Object.entries(DURATIONS)) {
        const fwdT = addMonths(rb, dm); if (fwdT > lastT) continue;
        const exit = priceOnOrBefore(prices, fwdT), sExit = priceOnOrBefore(spy, fwdT);
        if (!(exit > 0) || !(sExit > 0)) continue;
        const ret = (exit / entry - 1) * 100, sRet = (sExit / sEntry - 1) * 100, alpha = ret - sRet;
        const b = agg[tag][dn]; b.n++; b.rets.push(ret); b.alphas.push(alpha); if (ret > 0) b.hits++; if (ret > sRet) b.beats++;
        if (dn === "6mo") { ps.six[tag]++; ps.hit6.push(ret > 0 ? 1 : 0); ps.ret6.push(ret); ps.alpha6.push(alpha); }
      }
    }
    ps.roeLatest = round(lastRoe, 3);
    ps.bucket6 = ps.six.HIGH >= ps.six.LOW && ps.six.HIGH >= ps.six.MID ? "HIGH" : ps.six.LOW > ps.six.MID ? "LOW" : "MID";
    ps.hitRate6 = round(mean(ps.hit6) * 100, 1); ps.meanRet6 = round(mean(ps.ret6), 1); ps.meanAlpha6 = round(mean(ps.alpha6), 1);
    perStock.push(ps);
    console.log("  ✓ " + sym.padEnd(6) + " ROE=" + ps.roeLatest + " 6mo hit%=" + ps.hitRate6 + " ret=" + ps.meanRet6 + " alpha=" + ps.meanAlpha6);
  }

  const roll = {}; for (const t of tags) { roll[t] = {}; for (const dn of Object.keys(DURATIONS)) { const b = agg[t][dn]; roll[t][dn] = {
    n: b.n, hitRate: round(b.n ? b.hits / b.n * 100 : null, 1), beatSpyRate: round(b.n ? b.beats / b.n * 100 : null, 1),
    meanRet: round(mean(b.rets), 2), medRet: round(median(b.rets), 2), meanAlpha: round(mean(b.alphas), 2), medAlpha: round(median(b.alphas), 2),
  }; } }

  const out = {
    generatedAt: new Date().toISOString(), source: "Polygon monthly (adjusted) + SEC XBRL ROE (75-day lag)",
    durations: DURATIONS, thresholds: { highRoe: HIGH_ROE, lowRoe: LOW_ROE }, benchmark: "SPY (held the identical window)",
    byQuality: roll, perStock: perStock.sort((a, b) => (b.roeLatest || -9) - (a.roeLatest || -9)),
    caveats: [
      "In-sample MEASUREMENT over ~5y of Polygon Starter history, point-in-time ROE (75-day filing lag). Not a promotion.",
      "Survivor-biased: SEC's symbol→CIK map is today's listings; de-listed failures are absent, which FLATTERS low-quality.",
      "Alpha is vs SPY over the identical hold window (beta-honest); a HIGH bucket that beats SPY is selection, not drift.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "quality-duration-study.json"), JSON.stringify(out, null, 1) + "\n");
  console.log("\n── ROLLUP (hit% / meanAlpha vs SPY) ──");
  for (const t of tags) console.log(t.padEnd(5) + Object.keys(DURATIONS).map(dn => " " + dn + ": hit%=" + roll[t][dn].hitRate + " alpha=" + roll[t][dn].meanAlpha + " (n=" + roll[t][dn].n + ")").join(" |"));
  console.log("Wrote quality-duration-study.json.");
}

function distillSafe(j, asOf) { try { return realDistill(j, asOf).rec; } catch { return null; } }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
