// Shadow BACKTEST study — "SignalForge in reverse" for the team-minus-nuisance question.
//
// The forward-log shadow streams answer "does the team trade better without a vote?" OUT-OF-SAMPLE,
// but that needs the ledger to mature. This harness gives the IMMEDIATE, in-sample directional read:
// run the engine's OWN backtest (runBacktest + scoreAt) across the survivorship-free Polygon universe
// for the FULL team and for each team-minus-nuisance, and compare aggregate trade quality.
//
// HONESTY (binding): this is IN-SAMPLE and is NEVER the verdict. A team that backtests cleaner here is
// "looks better in-sample," not proven — the OOS shadow ledger (forward-perf shadow-* variants) is the
// arbiter. The nuisance set is principled: MACD (used backwards, angle F), Pat (dead/negative), ADX
// (~0 IC yet highest hand-weight). RSI/Stoch/BB are NOT dropped (angle F rescued them as timing tools).
//
// Charter-clean: Polygon daily bars only (no fallback vendor); reuses the engine's runBacktest/scoreAt
// VERBATIM (scoreAt gained an additive `drop` arg, parity-mirrored into index.html). Workflow-dispatch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runBacktest, scoreAt } from "./engine.mjs";
import { fetchPolygonAggs } from "./pattern-study.mjs";
import { selectMeritUniverse } from "./build-study.mjs";
import { readTickers } from "./build-fundamentals.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const SBT_MAX = +(process.env.SBT_MAX || 60);     // names (each runs 6 backtests → keep modest)
const MIN_BARS = 120;
const SLM = 1.5, TPM = 2.0, COSTS = { slip: 0.05, comm: 0.05 };
const round = x => (x == null || !isFinite(x)) ? null : Math.round(x * 1e4) / 1e4;

// The teams: the full engine + each principled nuisance removal (mirror of forward-log SHADOW_CONFIGS,
// plus the `full` baseline). RSI/Stoch/BB are deliberately never dropped (rescued by angle F).
export const TEAMS = [
  { key: "full",      drop: null,                  label: "Full team (baseline)" },
  { key: "noMacd",    drop: ["MACD"],              label: "− MACD (used backwards, F)" },
  { key: "noPat",     drop: ["Pat"],               label: "− Pattern (context-blind)" },
  { key: "noAdx",     drop: ["ADX"],               label: "− ADX (≈0 IC, highest weight)" },
  { key: "noDiv",     drop: ["Div"],               label: "− Divergence (window-bug, w2.5)" },
  { key: "noMacdPat", drop: ["MACD", "Pat"],       label: "− MACD + Pat" },
  { key: "noDead",    drop: ["MACD", "Pat", "ADX"], label: "− MACD + Pat + ADX" },
  { key: "noDeadDiv", drop: ["MACD", "Pat", "ADX", "Div"], label: "− MACD+Pat+ADX+Div (full cleanup)" },
];

// Pure: backtest ONE name with a team's vote-drop. Returns the per-name trade outcomes + buy-&-hold.
export function teamBacktestOne(bars, drop) {
  const bt = runBacktest(bars, slice => scoreAt(slice, drop), SLM, TPM, COSTS, null, false);
  const trades = bt.trades || [];
  const pnls = trades.map(t => t.pnlPct).filter(v => v != null && isFinite(v));
  const buyHold = (bars.length > 1 && bars[0].close > 0) ? (bars[bars.length - 1].close / bars[0].close - 1) * 100 : 0;
  const totalReturn = pnls.reduce((a, b) => a + b, 0);
  return { n: pnls.length, pnls, totalReturn, buyHold, alpha: totalReturn - buyHold,
    wins: trades.filter(t => t.result === "WIN").length };
}

// Pure: aggregate the per-name results for one team across the universe. Pools every trade's pnl% for
// a significance read (t = mean/se), plus win rate, total P&L, and mean alpha vs each name's buy-&-hold.
export function aggregateTeam(results) {
  const allPnls = results.flatMap(r => r.pnls);
  const n = allPnls.length;
  const mean = n ? allPnls.reduce((a, b) => a + b, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(allPnls.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const t = (sd > 0 && n > 1) ? mean / (sd / Math.sqrt(n)) : 0;
  const wins = results.reduce((a, r) => a + r.wins, 0);
  const tradedNames = results.filter(r => r.n > 0).length;
  const meanAlpha = tradedNames ? results.reduce((a, r) => a + (r.n > 0 ? r.alpha : 0), 0) / tradedNames : 0;
  return {
    names: results.length, tradedNames, trades: n,
    winRate: n ? round(100 * wins / n) : 0,
    expectancy: round(mean), tStat: round(t),
    totalPnlPct: round(results.reduce((a, r) => a + r.totalReturn, 0)),
    meanAlphaVsHold: round(meanAlpha),
  };
}

// Pure: the "reveal" — each shadow team's deltas vs the full team (positive = the drop HELPED in-sample).
export function revealVsFull(teams) {
  const full = teams.find(t => t.key === "full");
  if (!full) return teams;
  return teams.map(t => t.key === "full" ? { ...t, dExpectancy: 0, dAlpha: 0, dTrades: 0 } : {
    ...t,
    dExpectancy: round((t.expectancy || 0) - (full.expectancy || 0)),
    dAlpha: round((t.meanAlphaVsHold || 0) - (full.meanAlphaVsHold || 0)),
    dTrades: (t.trades || 0) - (full.trades || 0),
  });
}

function resolveUniverse() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, "roster.json"), "utf8"));
    if (Array.isArray(r.companies) && r.companies.length) {
      const picked = selectMeritUniverse(r.companies, SBT_MAX);
      const delisted = picked.filter(c => !c.active).length;
      return { tickers: picked.map(c => c.ticker),
        source: `roster.json (survivorship-free: ${picked.length} names, ${delisted} de-listed; cap ${SBT_MAX})`,
        survivorshipFree: true };
    }
  } catch { /* no roster → fall back */ }
  return { tickers: readTickers().slice(0, SBT_MAX),
    source: "tickers.txt (legacy survivor set — run universe-build for roster.json)", survivorshipFree: false };
}

async function fetchDaily(sym, key) {
  const candles = await fetchPolygonAggs(sym, "1day", key, { minBars: MIN_BARS });
  return candles.map(c => ({ date: c.date, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function main() {
  const key = process.env.POLYGON_API_KEY;
  if (!key) { console.error("Set POLYGON_API_KEY — the shadow backtest prices off Polygon, no fallback vendor by design."); process.exit(2); }
  const { tickers, source, survivorshipFree } = resolveUniverse();
  console.log("shadow-backtest universe: " + source);

  const barsByTicker = {}; const errors = [];
  for (const sym of tickers) {
    try {
      const bars = await fetchDaily(sym, key);
      if (bars.length < MIN_BARS) throw new Error(`only ${bars.length} bars (<${MIN_BARS})`);
      barsByTicker[sym] = bars;
      process.stdout.write(".");
    } catch (e) { errors.push(sym + ": " + (e.message || e)); }
  }
  console.log("\n" + Object.keys(barsByTicker).length + " names loaded (" + errors.length + " skipped).");

  const teams = TEAMS.map(team => {
    const results = Object.values(barsByTicker).map(bars => teamBacktestOne(bars, team.drop));
    return { key: team.key, label: team.label, drop: team.drop, ...aggregateTeam(results) };
  });
  const revealed = revealVsFull(teams);

  const out = {
    generatedAt: new Date().toISOString(),
    universe: { requested: tickers.length, covered: Object.keys(barsByTicker).length, source, survivorshipFree, skipped: errors },
    config: { slMult: SLM, tpMult: TPM, costs: COSTS, minBars: MIN_BARS },
    teams: revealed,
    caveats: [
      "IN-SAMPLE backtest over the loaded Polygon history — 'looks better in-sample,' NEVER proven. The OOS shadow-* streams in forward-perf are the arbiter.",
      "The engine's technical core is a measured in-sample LOSER (baseline t ≈ −12.6), so even the full team's expectancy may be negative; the REVEAL is the RELATIVE delta — does dropping a nuisance vote improve trade quality / cut over-trading?",
      "Nuisance set is principled (MACD backwards / Pat dead / ADX over-weighted); RSI/Stoch/BB are NOT dropped — angle F rescued them as mean-reversion timers.",
      survivorshipFree ? "Survivorship-free roster (incl. de-listed)." : "Legacy survivor set — survivorship bias; run universe-build for roster.json.",
    ],
  };
  fs.writeFileSync(path.join(ROOT, "shadow-backtest-study.json"), JSON.stringify(out) + "\n");

  console.log("\n════ SHADOW BACKTEST — does the team backtest cleaner WITHOUT a nuisance vote? (in-sample) ════");
  console.log("  team                            trades  win%   expectancy  tStat   meanAlpha   Δexp   Δalpha  Δtrades");
  for (const t of revealed) {
    const d = (v, pad) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v).toString().padStart(pad);
    console.log("  " + t.label.padEnd(32) +
      String(t.trades).padStart(6) + "  " + String(t.winRate).padStart(4) + "  " +
      d(t.expectancy, 10) + "  " + d(t.tStat, 6) + "  " + d(t.meanAlphaVsHold, 9) + "  " +
      (t.key === "full" ? "   —      —       —" : d(t.dExpectancy, 5) + "  " + d(t.dAlpha, 6) + "  " + d(t.dTrades, 7)));
  }
  console.log("  ↳ POSITIVE Δexp / Δalpha (and fewer Δtrades) = dropping that vote IMPROVED the team in-sample → a nuisance candidate.");
  console.log("  ↳ IN-SAMPLE only — the OOS shadow-* ledger under FDR is the verdict; this just points the flashlight.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
