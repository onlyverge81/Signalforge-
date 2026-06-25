# SignalForge — project memory

SignalForge is a single-page **Live Trading Analyzer** (`index.html`) backed by a CI
research pipeline (`scripts/*.mjs`). The app scores US stocks on Polygon bars with a
confluence of technical indicators and emits a BUY/HOLD verdict with ATR stop/target.
The pipeline mines edges, logs forward (out-of-sample) predictions, scores them, and
promotes/demotes strategies through a lifecycle registry.

## Prime directive — what "profitable" means here

**Success = a proven positive expectancy over ≥100 out-of-sample trades, measured as
alpha vs a total-return buy-&-hold benchmark.** It is NOT "consistent daily profits."
A statistical edge pays off over hundreds of trades with high variance — never daily
certainty. Demanding daily profit is what produced an over-trading, edge-free engine in
the first place; do not optimize for activity or for a green backtest.

**Never tune the backtest until it shows green.** In-sample fitting overstates edge and
dies live. The only verdict that counts is out-of-sample, in `forward-perf.json` /
`strategy-registry.json`. Let the ledger mature; let the registry promote survivors.

## Measured state (so you don't re-derive it)

- **R3 LIQUID-universe re-run (DONE, in-sample) CORRECTED two conclusions** — the single most important reason R3
  mattered. On the tradeable default (factor-interaction 32 names / shadow-backtest 20 names, illiquid dropped):
  (1) **lowvol is DETHRONED** — #1 on the junky roster (IC 0.113, t 3.99) → **#10, IC 0.042, t 0.87, NOT SIGNIFICANT**
  on liquid names: its pie dominance was confirmed **stale-price micro-cap artifact** (angle A, now as the default).
  The new liquid headline is **Vol (IC 0.111, t 2.4, now #1) + momentum-12-1 (t 2.2) + Trend (t 2.7)**. (2) The
  shadow-cleanup **expectancy no longer flips POSITIVE** on tradeable names — removing MACD+Pat+ADX(+Div) takes the
  engine from significantly-losing (t −2.71) to a **coin toss** (expectancy −0.05, t −0.20), NOT the +0.15 it showed
  on junk (that flip was a micro-cap oversold-bounce effect). MACD stays the worst single offender; Div's incremental
  help shrinks to ~noise once liquid. **Robust survivors held (momentum/Vol/Trend; nuisances drag); the fragile ones
  (lowvol-edge, engine-turns-profitable) were contamination we'd have believed without R3.** Small/noisy samples,
  still in-sample — the OOS ledger is the arbiter.

- **In-sample (`signal-study.json`, Polygon daily, 410 names):** the symmetric engine is a
  *statistically significant loser* — baseline t-stat ≈ −12.6, total ≈ −14,960, while
  buy-&-hold returned ≈ +140%.
- **Two leaks, both now gated:** (1) **shorting a rising market** (SELL t ≈ −19, negative
  before costs) → fixed by **long-only default**; (2) **churn past the cost barrier** (long
  book gross +5,855, cost drag −4,871) → fixed by the **cost gate** (target must clear 2×
  round-trip cost). Long-only + wide-stop is the only non-losing variant; on the current
  survivorship-free run it reads in-sample **t ≈ 7.3** (`signal-study.json`) — but in-sample
  is never trusted here, so this is "looks good in-sample," not "proven."
- **Out-of-sample (`forward-perf.json`):** ledger is new; trades still maturing. The honest
  verdict is **"not enough evidence,"** never "loser." Don't read a verdict from 0 closed trades.
- **The one signal with positive statistical life is the fundamental merit/IC study**
  (`study.json`): 6-mo rank-IC ≈ **0.20, t ≈ 5.5** (in-sample, ~9 periods; placebo null);
  12-mo IC ≈ 0.24 but only ~4 periods (TOO FEW). This is **low-power and in-sample** — OOS
  n≈3 can't reach significance by design. Now hardened (walk-forward, beta-timing diagnostic,
  deflated-t) and wired into the OOS ledger as the propose-only **`merits-on`** variant.
- **Pattern edge is dead:** daily Convergence ≈ −0.70% vs baseline; the cleaned intraday
  15-min sweep (`convergence-scan.json`) is significantly **negative** at swing horizons
  (t ≈ −5 @ 48 bars). Win rate is market beta, not skill.

The "losing verdict" the app shows is the system being **correct and honest**, not broken.

## Methodology (non-negotiable)

- **Alpha, not beta.** Score every strategy against matched-window buy-&-hold; a high win
  rate in a rising market is beta, not edge.
- **No lookahead.** Point-in-time data only; fill at next-bar open; subtract costs up front.
- **Multiple-testing correction.** Every variant tested inflates false positives — gate
  promotions with Benjamini-Hochberg FDR (BY reported as a dependence cross-check).
- **Promote slow, demote fast.** Propose-only: candidates need ≥10 OOS trades at q≤0.05 to
  promote; ≥5 at p≤0.1 to demote. The registry is the product.
- **Honesty over green.** Surface measured expectancy, t-stat, and the buy-&-hold benchmark
  beside every verdict. "No proven edge" is integrity, not a bug.

### The audit ritual (R6) — the standing gauntlet EVERY new vote / factor / feature must run

This is the codified habit that compounds more than any single edge — the repeatable process the
whole "Wheel" arc converged on. A candidate is NEVER wired into the live engine on a hunch or an
in-sample win; it walks the full gauntlet, and only the OOS ledger pulls the trigger:

1. **Cross-sectional IC first (the pie).** Measure the candidate's forward-return rank-IC across the
   universe (reuse `study-lib.mjs` — it is factor-agnostic). |meanIC| as a share of the total is its
   "weighted data value." A vote earns a seat by helping the TEAM, not by birthright.
2. **Robustness angles A–F (don't trust a single number).** Liquidity screen + beta/sector-neutral IC
   (A — is it a stale-price micro-cap or sector-bet artifact?); unique/incremental IC + PCA effective
   bets (B — is it a NEW axis or a double-count?); bull/bear regime split (C — same-sign or a flip?);
   IC term-structure (E — which horizon, and is the t honest under overlap?); a FAIR exam for the tool's
   real job (F — e.g. judge an oscillator on TIMING via an event study, not cross-sectional selection).
3. **Shadow team — with vs without.** Run the engine's own backtest WITH and WITHOUT the candidate
   (`scoreAt`/`computeSignal` `drop`/inject); the RELATIVE Δ (expectancy, alpha, churn) is the flashlight.
   In-sample, never the verdict.
4. **OOS under the R1 bar.** Wire it propose-only (tag a forward-log row; NEVER touch `gate.actionable`),
   let `forward-perf` score it under the BH+BY FDR family, and judge ONLY at the locked R1 PROMOTE/DEMOTE
   thresholds (n≥10, q≤0.05 on BOTH BH and BY, positive alpha, persistence in both halves; demote at the
   lower bar). Fixed monthly cadence — no optional-stopping.
5. **Record it** in this file's progress checklist (measured numbers + honest caveats), win or lose. A
   killed hypothesis recorded is as valuable as a survivor — it stops the next session re-deriving it.

**The binding rule through all five: in-sample POINTS, the OOS ledger PULLS the trigger — NEVER an
in-sample re-wire.** Green that hasn't cleared this gauntlet is contamination (R3 proved it: the pie's
in-sample #1 was a stale-price artifact that the liquidity screen halved).

## Polygon data charter (Stocks Starter, $29/mo — the ONLY vendor)

Polygon is the single source of truth. **Never add or fall back to another vendor** (the
code enforces "no fallback by design"). Exhaust Polygon before reaching elsewhere.

- **Aggregates** (`/v2/aggs`) — all resolutions via `RESOLUTIONS` / `fetchPolygonAggs`
  (`scripts/pattern-study.mjs`): 1/5/15/30-min, 1-hour, daily. Mirrors the app's `POLY_RES`.
- **Second / minute aggregates** — resolve intrabar SL/TP order via `checkBarExitFine`
  (`scripts/engine.mjs`) when a coarse bar straddles both levels.
- **WebSockets** (`wss://delayed.socket.polygon.io/stocks`) — live streaming; the cluster
  flips to real-time on a tier upgrade. Always badge freshness honestly.
- **Reference tickers** (`/v3/reference/tickers?active=false`) — delisted names →
  **survivorship-free** universe. (The merit study still uses Yahoo + 36 survivors — a charter
  violation and a bias inflator; migrating it to Polygon is open Track-B work.)
- **Corporate actions** (`/v3/reference/splits`, `/dividends`) — total-return benchmark;
  detect adjustment mutations.
- **News / earnings** — event gates for signals.
- **Snapshot, Technical Indicators, Flat Files (S3 bulk)** — quotes/freshness, engine
  cross-checks, bulk historical backfill.
- **Constraint: 15-minute delayed.** Real-time intraday trading is impossible on this feed;
  target multi-day swing/EOD horizons where the delay is immaterial. Never fake "real-time."
- **Unlimited API calls** — no throttle (`POLYGON_PACE_MS=0`).

**Verify-first tab flow + DATA-tab declutter (DONE) — display-only UX:** reordered the tab bar into a
decision funnel — `DATA · LIVE · EVIDENCE · FORWARD TEST · BACKTEST · REPLAY · AUTOPSY · OUTLOOK · SIGNALS ·
SIZE · HISTORY` — so the SIGNALS verdict sits 9th, AFTER the verification tabs ("verify first, signal last").
`fetchLive` now lands on **LIVE** (chart + freshness/quote) instead of auto-jumping to SIGNALS, so the
verdict is reached by walking the chain, not shoved first. Removed the stale manual-CSV block from the DATA
tab (textarea + PASTE&RUN + LOAD SAMPLE + Yahoo/TradingView download links — off-charter, unused since
Polygon auto-fetch) and the now-dead `SAMPLE` const; replaced with a "DATA SOURCE → ⚡ LIVE" note + jump
button. KEPT the load-bearing `csv`/`parseCSV`/`run` plumbing (fetchLive writes `csv`; BACKTEST sliders +
DATA RUN re-analyze it). Empty-state "LOAD DATA" buttons now point to LIVE. NO engine/parity impact (tab
order + DATA tab chrome only); 214 tests green; driver-verified (new order, no textarea, zero JS errors).

**1-hour resolution honesty fixes (DONE) — app-only, no engine change:** user-found discrepancy where the
1-hour timeframe gave a "false sense of info" (price↔signal + a wrong OUTLOOK "20-day avg"). Three root causes,
all fixed: (1) **OUTLOOK was timeframe-leaking** — `buildOutlook`/`avgIndexGainByDate(...,20)`/`backtestCorrection
(...,period:20)` ran on the CHART-resolution bars, so on 1hr the "average trailing-20-DAY index gain%" (the
broad-market sentiment that drives the correction projection) was really 20 HOURS. Fix: the OUTLOOK now ALWAYS
fetches DAILY stock + DAILY index/ETF bars (and a daily trend) regardless of chart resolution — `buildOutlook`/
`avgIndexGainByDate` logic UNCHANGED (parity-safe; only the inputs changed). Fixed on BOTH the Polygon and the
Twelve-Data branches. (2) **No regular-hours filter** — the app fed pre/post-market intraday bars to the engine
(the CI already filters via `filterRegularHours`), so the intraday `last.close` the verdict/ATR levels anchored
to could be a thin extended-hours print. Fix: ported the tested RTH filter (`etMinutesMs`/`filterRthResults`,
09:30–16:00 ET) into `polyFetchCandles`, **US-EQUITIES ONLY** (gated on `!sym.includes("/")` so 24/7 crypto/forex
are untouched) and intraday spans only. (3) **Timeframe was never shown** post-fetch — a 1-hour read looked
identical to a daily swing call. Fix: `RES_LABEL` echoed on the LIVE meta line + SIGNALS hero, plus an amber
"⏱ INTRADAY · <tf>" caveat badge for any intraday timeframe. NO engine/parity impact (fetch layer + display +
OUTLOOK inputs only; `analyze`/`runBacktest`/`scoreAt`/`avgIndexGainByDate` untouched); 214 tests green; RTH ET
boundaries unit-checked; app mounts clean (live behavior needs a key in a real browser — egress-blocked in CI).

## Invariants

- **`index.html` ↔ `scripts/engine.mjs` parity.** The app and the study engine must compute
  identical signals/backtests. Mirror every engine change into both; keep them byte-for-byte.
- `POLYGON_API_KEY` is the only secret; scripts no-op gracefully without it in CI.
- **Review before merge — never auto-merge to `main`.** Push the branch, open/update the PR,
  and STOP. The user reviews and merges (or explicitly says "merge it") themselves. Keep PRs
  single-feature so review stays tractable.

## Commands

- Tests: `node --test scripts/*.test.mjs` (currently 111, keep green).
- Studies (need `POLYGON_API_KEY`): `node scripts/signal-study.mjs`, `pattern-study.mjs`,
  `build-fundamentals.mjs` → `build-study.mjs`.
- Forward pipeline (nightly CI): `forward-log.mjs` → `forward-perf.mjs` → `promote.mjs`.

## Active task — progress & resume checklist

Driving task: the **"Wheel of Problem-Solving"** profitability analysis → action plan (full
analysis in the approved plan file; branch `claude/signalforge-profitability-wheel-qbclby`).

**Done & pushed:**
- Resolution-aware data layer (`RESOLUTIONS`, `fetchPolygonAggs`, 1min…1month) +
  `checkBarExitFine` intrabar exit fix; dropped obsolete free-tier pacing.
- Track A (already shipped in the merged PR #23): long-only default, 2×-cost gate, honest
  verdict surface (expectancy/t-stat/buy-&-hold) — verified live, not re-implemented.
- `CLAUDE.md` (this file).
- **Track B 1a:** merit study (`build-study.mjs`) priced off **Polygon** monthly bars, not
  Yahoo/Stooq (no fallback). CI passes `POLYGON_API_KEY`.
- **Track B 1b (DONE):** survivorship-free merit study. `parseRefTickerRows` (CIK + de-listed,
  tested); `fetchTickerRoster` pages `active=true`+`active=false` → emits `roster.json`
  (CIK-bearing, incl. de-listed); `build-study.mjs` resolves CIK from `roster.json` via the pure
  `selectMeritUniverse` (keeps all de-listed first, then active, capped by `MERIT_MAX=500`),
  bypassing the survivor-biased `secCik`; graceful fallback to `tickers.txt`. Caveats now track
  which universe was used. `universe-build.yml` commits `roster.json`. Note: roster.json is
  generated by the next universe-build CI run (needs the API key) — until then build-study falls
  back to the legacy set.
- **Intraday edge probe (DONE, negative result):** `convergence-scan.mjs` + `.yml` sweep the
  Convergence pattern across top-N dollar-volume names at intraday resolution. Added the
  `filterRegularHours`/`etMinutes` RTH filter (extended-hours `frozen` bars were wrongly
  failing the audit; 30/32 skips recovered). Verdict: **no tradeable long edge** — alpha is
  significantly negative at swing horizons. Hypothesis killed honestly.
- **`run-signalforge` skill** (`.claude/skills/run-signalforge/`): Playwright driver that
  serves the app, routes the egress-blocked unpkg CDN to local libs, and screenshots it.
- **Merit edge — hardened + wired (DONE):** `study-lib.mjs` gained `walkForward`,
  `betaControl` (spread-vs-market timing — note: rank-IC/spread are already within-period
  beta-neutral, so a `fwdRetExcess` demean would be a no-op; the time-series co-movement is
  the real check), `overlapAdjustedT` (Newey–West HAC), `deflatedSignificance`; `meritEdgeProven`
  tightened to require walk-forward + deflated survival. `build-study.mjs` surfaces them and
  pins the 75-day lag (`meritAsOfISO`) + `priceOnOrBefore` with tests. `forward-log.mjs`
  `meritGate` flips `meritsActivated` as a **propose-only label** (never touches
  `gate.actionable`) → the `merits-on` variant now competes under the existing FDR gate.
- **POSITION mode realism — PR1 (DONE):** `scorePosition` now requires a TRUE 200-bar window
  (was `Math.min(200,len)` — a silent short-SMA proxy); with fewer bars it returns
  `engaged:false`/HOLD honestly. `runBacktest` hold-mode BUY exits via an ATR **trailing stop**
  (let winners run, no fixed-TP cap) + thesis-break. POSITION shows its **own** conviction
  (trendStrength + dipDepth) via `positionDisplay`, not the tactical confluence number.
  Mirrored byte-for-byte into `index.html` (parity verified); tests + copy updated.
- **POSITION mode — PR2 (DONE):** `scorePosition` now logs its OWN forward/OOS stream.
  `forward-log.mjs` `buildPositionEntry` (engaged ≥200-bar dip-buy → OPEN, else null/OBSERVATION)
  + `markToMarketPosition` (ATR trailing stop + thesis-break, no-lookahead) under `POS_CFG`,
  tagged `mode:"position"` with `…-POS-…` ids. `forward-perf.mjs` adds a **`position`** variant
  and scopes the tactical family (all/grades/merits) to `mode!=="position"` so the two
  philosophies never conflate. Judged under the same FDR gate; nothing auto-activates.
- **OUTLOOK "correction period" rebuild (DONE):** the projection now uses the **average**
  trailing-20-day gain of the 3 indexes (not the session **sum**), via pure
  `avgIndexGainByDate`. `correctionLevels` sets an error-buffered **TP = price+|proj|+avgErr**
  (let it run) and a tight **SL = price−min(|proj|,avgErr)** (red-flag). New `runBacktest`
  custom-target seam (`pending.customSl/customTp ?? ATR fallback`) is additive — existing
  callers unchanged (regression snapshots green). `backtestCorrection` replaces the
  directional-only test with **full P&L vs matched buy-&-hold** (alpha-honest), expanding-window
  `avgErr` (no-lookahead); `proven` only when ≥20 trades **AND** significant **AND** meanAlpha>0.
  Mirrored byte-for-byte into `index.html` (parity verified); panel leads with alpha/expectancy/
  significance. Beta-by-construction → honest likely verdict is "no proven edge"; **not** wired
  into any OOS ledger/registry (display-only).
- **Cross-sectional MOMENTUM study (DONE) — the first cross-sectional PRICE factor:** the engine
  had only ever scored names in isolation; momentum ranks the universe against itself (the one
  shape with positive statistical life, like merit IC). `scripts/build-momentum.mjs`
  (`buildMomentumObservations`: `merit = price(rb−1mo)/price(rb−Lmo)−1`, skip-month 12-1 & 6-1,
  1-month non-overlapping forward, point-in-time) writes `momentum.json`, **reusing study-lib.mjs
  verbatim** (it's factor-agnostic — only needs `{period,merit,fwdRet}`). Generic helpers
  `pack`/`grid`/`addMonths`/`iso` exported from `build-study.mjs` (additive; merit behavior
  unchanged). Charter-clean: Polygon monthly bars, survivorship-free roster via
  `selectMeritUniverse`, no Yahoo. **Propose-only OOS wiring:** `momentumValue` (daily 12-1) +
  pure cross-sectional `momentumRankGate` (top-tertile) in `forward-log.mjs` tag
  `tags.momentumActivated` — set in `main()` AFTER ranking the run's batch, NEVER touching
  `gate.actionable` (statuses byte-identical, verified). `forward-perf.mjs` adds
  `momentum-on`/`momentum-off` variants under the existing FDR gate; nothing auto-activates.
  CI: `momentum-study.yml` (weekly, Polygon key). Tests +9 (166 green). In-sample is NEVER
  trusted — only the OOS `momentum-on` ledger cleared through FDR counts.

**First momentum CI run (DONE, in-sample only):** `momentum-study.yml` ran on the survivorship-free
roster (294/500 covered, 270 de-listed). Both windows read `proven:true` IN-SAMPLE — 12-1: meanIC
0.0845, t 4.06, 47 periods; 6-1: meanIC 0.0777, t 4.22, 53 periods; placebo null, walk-forward
hit-rate 0.75/0.76, beta-timing corr −0.27/−0.07 (NOT disguised beta), both time-split halves
significant. **Honest caveats:** the "OOS split" is an in-sample time-split (not forward OOS); all
periods sit in the 2022–2026 regime (Polygon Starter monthly history ≈5y); 206 thin/0-bar de-listed
tickers skipped. Strongest in-sample factor in the repo — still NOT proven. Now hardened with a
**trials=2 deflation** (`pack(obs,{trials})`): the 2 lookback windows are haircut even in-sample
(12-1 t→2.89, 6-1 t→3.04, both still SIGNIFICANT). Verdict still rests on the live OOS ledger.

**Total-return benchmark — ALREADY WIRED (not a TODO):** the OOS path is total-return, not price-only.
`forward-log.mjs` fetches `fetchPolygonDividends` and stamps `benchDiv` on every closed trade (tactical
`markToMarket` + position `markToMarketPosition`); `forward-perf.mjs` `buyHoldTotalPct`/`tradeAlpha`
add the dividends the holder collects. So alpha is measured vs a same-name TOTAL-return hold.

**Event gates — propose-only labels (DONE), hard gate deferred:** the `events` summary
(`newsWindow`: count/freshest/sentiment, point-in-time ≤ decision bar) was already captured on every
ledger row; now `eventTags(events)` (pure, `forward-log.mjs`) turns it into TWO opposite A/B hypotheses,
tagged on tactical + position rows: `newsPositive` (count>0 && sentiment positive → post-news drift /
PEAD) and `newsQuiet` (sentiment≠negative → event-risk avoidance). `forward-perf.mjs` adds
`news-pos-on/off` + `news-quiet-on/off` under the existing FDR gate. Reads ONLY the captured events
(never re-fetches → no-lookahead); NEVER touches `gate.actionable` (statuses byte-identical, tested).
A HARD event gate is deferred until a label earns it OOS. Tests +3 (169 green).

**Earnings-proximity gate — propose-only label (DONE), solved via SEC, not Polygon:** the Polygon-Starter
earnings-calendar entitlement question is moot — the earnings-announcement date is reachable from the SEC
EDGAR data already fetched. `secLastFiled(facts,names,asOf)` (pure, `sec-lib.mjs`) returns the latest 10-Q/
10-K `filed` date (≈ the earnings release), point-in-time (never a filing dated after asOf). `distill`
surfaces it as `lastFiled` on every `fundamentals.json` record. `earningsGate(rec,decisionDate,{recentDays:30})`
(`forward-log.mjs`) tags `earningsRecent` on tactical + position rows — the post-earnings-DRIFT hypothesis on
hard numbers (complements the news-sentiment label). `forward-perf.mjs` adds `earnings-recent-on/off` under the
FDR gate. Propose-only: never touches `gate.actionable` (tested). No-lookahead: filing dates are historical and
forward-log only logs the current bar. Tests +5 (174 green). `lastFiled` populates on the next fundamentals CI run.

**Cross-sectional SHORT-TERM REVERSAL factor (DONE) — Phase 1 of the factor-expansion roadmap:** the
orthogonal complement to momentum (which SKIPS the most recent month precisely to dodge reversal).
`scripts/build-reversal.mjs` (`buildReversalObservations`: `merit = −(price(rb)/price(rb−1mo)−1)` so a
recent LOSER scores HIGH; 1-month non-overlapping forward; point-in-time) writes `reversal.json`,
**reusing study-lib.mjs verbatim** (factor-agnostic). Single window (1mo, trials=1). Charter-clean:
Polygon monthly bars, survivorship-free roster via `selectMeritUniverse`. **Propose-only OOS wiring:**
`reversalValue` (daily negated 1-month return) + pure `reversalRankGate` (top-tertile = biggest recent
losers) in `forward-log.mjs` set `tags.reversalActivated` in `main()` AFTER ranking the run's batch,
NEVER touching `gate.actionable`. `forward-perf.mjs` adds `reversal-on`/`reversal-off` under the existing
FDR gate. CI: `reversal-study.yml` (weekly Sun 09:23, clear of the sibling slots). Tests +12 (190 green).
In-sample is NEVER trusted — only the OOS `reversal-on` ledger cleared through FDR counts.

**Cross-sectional LOW-VOLATILITY factor (DONE) — Phase 2:** risk-based factor, orthogonal to the
price-trend overlays. `scripts/build-lowvol.mjs` (`buildLowVolObservations`: `merit = −stdev(trailing
monthly returns)` so a CALM name scores HIGH; `stdev` pure-helper exported & tested; 12-mo + 6-mo windows,
trials=2; 1-month non-overlapping forward; point-in-time) writes `lowvol.json`, reusing study-lib.mjs
verbatim. Charter-clean: Polygon monthly bars, survivorship-free roster. **Propose-only OOS wiring:**
`lowVolValue` (daily negated realized vol over ~252d) + pure `lowVolRankGate` (top-tertile = calmest) in
`forward-log.mjs` set `tags.lowVolActivated` after ranking the batch, NEVER touching `gate.actionable`.
`forward-perf.mjs` adds `lowvol-on`/`lowvol-off` under the FDR gate. CI: `lowvol-study.yml` (weekly Sun
10:23). Tests +10 (200 green). Only the OOS `lowvol-on` ledger cleared through FDR counts.

**Cross-sectional QUALITY (profitability) factor (DONE) — Phase 3, first NON-PRICE expansion factor:**
distinct from the merit COMPOSITE (valuation+health+growth) — quality reads pure profitability. Exported
`loadTicker` + `resolveMeritUniverse` from `build-study.mjs` (additive) so `scripts/build-quality.mjs`
reuses the merit SEC+price loading + point-in-time `distill` (75-day lag). `buildQualityObservations(loaded,
metric, {distill})` sets `merit = rec[metric]` (ROE primary, NPM secondary → trials=2; `distill` injected so
the no-lookahead/sign contract is unit-tested without raw XBRL). Charter-clean: SEC XBRL + Polygon monthly,
survivorship-free roster. **Propose-only OOS wiring:** `qualityValue(rec)` (reads ROE off `fundaDB`) + pure
`qualityRankGate` (top-tertile = most profitable) in `forward-log.mjs` set `tags.qualityActivated` after
ranking the batch, NEVER touching `gate.actionable`. `forward-perf.mjs` adds `quality-on`/`quality-off`.
Quality shares inputs with the merit grade → correlated variants; lean on the FDR family's BY (dependence-
robust) cross-check. CI: `quality-study.yml` (weekly Sun 11:23). Tests +9 (209 green).

**Live forming-bar chart (DONE) — Phase 4 (cosmetic, app-only):** `goLive`'s `onBar` folds the streamed
price into the LAST visible candle (`forming:true`, expanding high/low, close=latest) via `setRows` —
NEVER re-running `analyze()`, so the verdict stays frozen (no real-time signal faked on the delayed feed).
`Chart` draws the forming bar hollow + cyan with a "● LIVE" tag. `stopLive` clears the flag; `fetchLive`
calls `stopLive` first so a stale symbol's bar can't bleed into a new series. Honest-cosmetic now; on a
Polygon tier upgrade the cluster flips to `realtime` (one-word `mode` change) and this SAME bar becomes a
genuine real-time forming candle — "its future status, revealed automatically" (user's framing). Engine
parity untouched (the change is in Chart + the live socket, not analyze/runBacktest/scoreAt). 209 tests green.

**Factor-expansion roadmap (user-approved, by priority):** Phase 1 reversal DONE ↑; Phase 2 low-volatility
DONE ↑; Phase 3 quality (profitability) DONE ↑; Phase 4 live forming-bar chart DONE ↑. ALL FOUR COMPLETE.
Each factor is propose-only / FDR-gated / never auto-activated — candidates, not proven edges.

**EVIDENCE-tab surfacing of the new factors (DONE) — display-only, closes the factor loop:** the app's
EVIDENCE tab rendered `study.json` (merit) + `momentum.json` but not the three shipped siblings. Added
read-only same-origin fetches for `reversal.json` / `lowvol.json` / `quality.json` (guarded on `.windows`)
and three `studyHarness(...)` cards mirroring the momentum card verbatim — same in-sample-only framing
("STRONG IN-SAMPLE — NOT YET OOS-PROVEN"), the quality card points at the scoreboard's BY column (shared
inputs with merit). `studyHarness` got a one-line guard so a SINGLE-window study (reversal) doesn't render
a redundant self-comparison line (`six && six!==H`); merit/momentum unaffected. NO engine/parity impact
(EVIDENCE viewer only, not analyze/runBacktest). Verified: all 5 cards render, single-window guard holds,
zero app JS errors via a Playwright drive of the EVIDENCE tab; 209 tests green. Cards populate live once the
weekly CI builds the three JSONs. Also added `reversal-on`/`lowvol-on`/`quality-on` (+ `quality-on` beside
`merits-on`) to the OOS variant SCOREBOARD's row list (hardcoded labels, `.filter(([k])=>V[k])` still hides
rows with no data) so the new propose-only labels surface there once forward-perf logs them.

**Sector-neutral honesty hardening (DONE) — "alpha, not a disguised sector bet":** a cross-sectional factor
can be a SECTOR tilt in disguise (low-vol≈utilities, momentum≈whatever ran, quality≈software). Added pure
`sectorNeutralIC(obs)` to `study-lib.mjs`: per period it removes each name's WITHIN-SECTOR mean forward
return (residual = fwdRet − sectorMeanFwdRet) and recomputes rank-IC(merit, residual); if the neutral IC
keeps most of the raw IC the edge is genuine stock-selection (verdict SURVIVES), if it collapses it was
mostly beta (SECTOR-DRIVEN). ADDITIVE: wired into `runStudy` as `sectorControl` and surfaced by `pack()`,
defaulting to `{available:false}` when obs lack a `sector` tag (existing studies unchanged). Sector source:
SIC division via Polygon ticker-DETAIL — pure `sicDivision`/`parseTickerSector` + best-effort `fetchSectorMap`
in `pattern-study.mjs` (names with no SIC just drop from the diagnostic). All five studies (momentum/reversal/
lowvol/quality/merit) now tag obs with `sector` (`buildXObservations` gained an optional `{sectorOf}`; each
`main()` builds the map). EVIDENCE harness shows a "SECTOR-NEUTRAL IC" tile (green SURVIVES / yellow PARTLY /
red SECTOR-DRIVEN) when available. Tests +5 (214 green): the diagnostic SURVIVES a within-sector signal,
COLLAPSES a pure sector bet, and is a no-op without sector tags; SIC mapping unit-tested. NOT wired into any
gate (`meritEdgeProven` untouched) — diagnostic only, for now. Populates once the weekly CI resolves SICs.

**Blank-screen reliability fix (DONE) — self-hosted libs + boot watchdog:** the deployed Pages app could
render a SILENT BLACK SCREEN — it pulled React/ReactDOM + a 3 MB `@babel/standalone` from the unpkg CDN and
transpiled in-browser, with `#root` empty and NO fallback, so any CDN hiccup / slow mobile load blanked it.
Fix: **self-hosted** the three libs same-origin under `vendor/` (react 18.3.1, react-dom 18.3.1,
@babel/standalone 7.29.7) — `index.html` now loads `./vendor/*` (unpkg dropped from CSP `script-src`), so a
third-party outage can't blank the app; still single-file in-browser-transpiled (charter preserved). Added a
`#boot` loader ("Loading SignalForge…") + a `__sfBootFail` watchdog: each vendored `<script>` has `onerror`,
plus a 20 s mount timeout; on failure it shows a "couldn't load — ↻ Reload" overlay instead of black. The
helper is timing-robust (a `<head>` script can fail before `<body>`/#boot exists → it defers to DOMContentLoaded
and creates the overlay). `createRoot(...).render` replaces `#boot` on success. `pages.yml` uploads `path:'.'`
so `vendor/` deploys. Verified via the run-signalforge driver: app mounts same-origin; both a network-abort and
an HTTP-503 on babel show the Reload overlay (no silent black). NO engine/parity impact (head + boot only).

**Quality × Duration research → quality-position OOS variant (DONE):** on-demand research harnesses
`scripts/sfa-index-study.mjs` + `scripts/quality-duration-study.mjs` (+ `.yml` workflow_dispatch, artifact +
log only — no commit/deploy) probe ideas with REAL Polygon data. The SFA12 × index-move family was KILLED
(bull-window mirages: SFA12 align/extension = outliers, dispersion ≈ 0, Sum = 3×Avg degenerate, the monthly
market-up filter had a NEGATIVE −2.1% edge). The ONE positive: **quality (ROE) × DURATION** — high-ROE names
held 3/6/12mo beat SPY with an edge that GROWS with the hold (12-mo alpha HIGH +1.9% / MID −5.6% / LOW −12.4%,
monotonic, n≈1000). ROE comes from **Polygon `/vX/reference/financials`** (net income ÷ equity, by filing_date)
— charter-pure, and it sidesteps SEC EDGAR's 403 of the CI runner. In-sample/survivor-biased, so wired OOS not
trusted: the **POSITION (long-hold) stream now carries the `quality` tag** (`buildPositionEntry` + the run loop
ranks the position batch via `qualityRankGate` → `qualityActivated`), and `forward-perf.mjs` adds
`quality-position-on`/`quality-position-off` (the "quality × duration" A/B inside the months-long position
trades, under the same FDR gate; never touches `gate.actionable`). Tests +1 (215 green). It matures like every
other label — only the OOS ledger through FDR counts.

**Factor-interaction "PIE CHART" study + combined OOS variants + EVIDENCE pie view (DONE) — branch
`claude/signalforge-profitability-wheel-qbclby`, 5 commits, 233 tests green, pushed (no PR yet):** the user's
"Wheel of Problem-Solving" arc — *each SignalForge tool sums to a role toward a signal; put them through
combinatorial correlation analysis to reveal each one's weighted data value (a "pie chart"); use SignalForge
"in reverse" against Polygon history since the live ledger can't decide (0 closed trades).* Shipped as five
pieces:
- **`scripts/factor-interaction-study.mjs` + `.yml`** (workflow_dispatch, artifact + log only — no commit/deploy,
  never wired to a gate). On-demand harness measuring, per name per monthly rebalance (1-month forward, complete
  windows only, no-lookahead), every tool's forward-return rank-IC: **THE PIE** = each tool's |meanIC| as a share
  of the total ("weighted data value"); a per-period Spearman **correlation matrix** (redundancy); a
  **conditional/interaction scan** (`conditionalIC` = IC of A within B's top vs bottom tertile → the "lift", the
  "do two weak factors combine?" answer); a z-scored **combined composite** vs best single. Reuses `study-lib.mjs`
  (factor-agnostic) + `build-study` helpers; Polygon bars only.
- **Whole-app pie contributors** (user picked "whole-app"): 4 price/risk **FACTORS** (`factorValues` reuses
  `momentumValue`/`reversalValue`/`lowVolValue` from forward-log VERBATIM) + 13 technical **VOTES**
  (`voteVector` mirrors `computeSignal`'s vote dirs; input as the RAW direction so the measured IC reveals each
  vote's *empirically-deserved* weight, shown beside the hand-set `VOTE_WEIGHTS`) + 4 AUTOPSY **FUNDAMENTALS**
  (`parsePolyFinancials`→`recAsOf`→`autopsyValues` reconstructs point-in-time fundamentals from Polygon
  `/vX/reference/financials` by filing_date, scored by the app's OWN `valueScore(meritMetrics(...))` — no
  re-impl). **OUTLOOK is documented-excluded** (market-timing projection = ~0 cross-sectional variance, can't
  rank names; in `excluded` + caveats). Interactions/composite span the cross-sectional SELECTORS (factors +
  fundamentals).
- **Propose-only COMBINED OOS variants** in `forward-perf.mjs` (`bothTac` helper): `mom-quality-on/off`,
  `mom-lowvol-on/off`, `rev-lowvol-on/off` — AND of two existing tactical tags; read existing tags (no
  forward-log change); never touch `gate.actionable`; auto-included in the BH/BY FDR family (correlated with
  parents → lean on BY).
- **Option B refinement** — `quality-grade-position-on/off` (AUTOPSY grade A/B × duration) ALONGSIDE the
  top-tertile-ROE `quality-position` variant (pure `gradeAB`, reads the `fundamentalGrade` tag already on
  position rows; the 36-name scan found grade A/B ≈ +9pt 12-mo alpha vs C/D negative — sign flips at B/C).
- **EVIDENCE-tab pie view** (`factorPie` state + card; display-only, parity-safe) renders
  `factor-interaction-study.json` — bars colored by IC sign, kind badges (factor/fundamtl/vote), engine weight,
  interaction lifts, composite. Verified via run-signalforge driver (renders, zero app JS errors). New
  scoreboard rows for the combined + position-quality labels (hidden until data lands).
- **Honesty:** in-sample only, never the verdict; technical core is a measured loser (t −12.6) so thin/negative
  vote slices are the expected finding. Populates once `factor-interaction-study.yml` is dispatched in CI (the
  sandbox can't reach Polygon and has no secret — studies run in Actions, where the repo `POLYGON_API_KEY` is
  injected automatically; the key is correct, it's a sandbox/CI location boundary, not a key problem).

**Pie CI runs + the "Wheel in reverse" expert-trader probes — A/B/C robustness (DONE, MEASURED) — branch
`claude/signalforge-profitability-wheel-qbclby`:** the workflow gained an **opt-in `commit` input** (default
artifact-only; when true it commits `factor-interaction-study.json` to the dispatch branch — NEVER main — so
EVIDENCE renders it same-origin). Dispatched in CI (cap 120; survivorship-free roster: 81 covered, 73 w/
financials, ~2,792 monthly obs, 48 periods, 2022–2026). The **first real pie** put **lowvol #1** (IC 0.113,
t 3.99), then momentum 12-1 (0.089), Vol/Trend votes (~0.07), merit/healthy (~0.05); **Pat is NEGATIVE**
(−0.059); ADX/RSI/MACD (the engine's HIGHEST hand-weights) are ~0 → the engine's vote weights are
**mis-calibrated vs measured IC**. Three expert-trader probes were then built into the harness (all PURE +
unit-tested, in-sample/research-only, NEVER gated):
- **Angle A — liquidity screen + beta/sector-neutral IC** (`liquidAt` price≥$5 & trailing-median ADV≥$2M;
  `trailingBeta` vs SPY; `betaNeutralIC`; reuse `sectorNeutralIC`). **VERDICT:** on the 45 liquid names
  **lowvol HALVES (0.113→0.050, t 1.2 — significance gone): ~half its pie was stale-price micro-cap artifact.**
  **Momentum-12-1 is the lone robust survivor** (keeps ~80%, 0.071 t 1.8, neither sector nor beta). 6-1 momentum
  collapses on liquid names → it's specifically the **12-1** window. Quality/merit survive sector/beta neutral
  (genuine selection) but their liquid IC ≈ 0 (size-conditional). reversal/cheap = beta-driven noise.
- **Angle B — unique/incremental IC + PCA effective bets** (`uniqueIC` residualises each selector vs all others,
  z-scored per period + ridge — note the FIX: raw scales (mom ~1, lowvol ~0.01, fundamentals ~100) + collinear
  fundamentals made `XtX` singular → price factors read TOO-FEW-PERIODS; standardise+ridge cured it; `pca` via
  Jacobi eigensolver + participation-ratio). **VERDICT: 8 selectors ≈ 5.3 effective bets, ~3 economic axes**
  (PC1 quality/low-risk = merit+healthy+lowvol; PC2 momentum; PC3 reversal/value). **merit (keeps 11%) and
  AUTOPSY_healthy (−5%) are REDUNDANT** — the pie double-counted one quality axis as three. **The two momentum
  windows duplicate each other** (12-1 keeps only 28% once 6-1 is in) → use ONE window. **lowvol is the one
  statistically-independent axis (unique t 3.5)** — but A says that strength lives in illiquid names. growing is
  weakly independent (keeps 94%).
- **Angle C — bull/bear regime split** (`marketRegimeByDate` SPY vs 200-DMA; `regimeSplitIC`). Sample is
  **regime-imbalanced: 38 bull vs 10 bear months**, so bear power is low. **momentum-12-1 stays SAME-SIGN
  positive in both** (+0.099 bull / +0.048 bear) → "bull-signif, bear same-sign UNDERPOWERED" — NOT a disproven
  artifact (verdict logic refined to separate same-sign-underpowered from true sign-FLIP). **lowvol +0.148→−0.019,
  merit/healthy positive→negative = real BULL-ONLY flips.** reversal & growing are the only BEAR-positive signals.
  Honest meta-conclusion: 5y / one macro cycle can't PROVE regime durability — the OOS ledger stays the arbiter.
- **Angle E — IC term-structure** (`buildPanel` `horizons` opt stamps 1wk/1mo/3mo/6mo/12mo fwd returns no-lookahead;
  `termStructure` IC per horizon + Newey–West HAC t via `overlapAdjustedT`, overlap ≈ horizon/month). IC rises
  MONOTONICALLY with horizon (momentum 0.020→0.089→0.117→0.210→0.272; lowvol/merit similar) — but that "12mo is
  best" is a TRAP: rank-IC mechanically grows for any persistent signal (cumulative-return SNR), and 12mo overlaps
  11 neighbors so effective n ≈ 48/12 ≈ 4 (naïve t 15 is nonsense; even HAC t 9.7 is unreliable). Decision-useful
  reads: **NO 1-week edge in anything** (swing/multi-month only — confirms the delayed-feed charter); **1mo is the
  clean non-overlapping column** (matches the pie); the survivors are **SLOW** (months) → belong in the POSITION
  book, not rapid turnover; **reversal flips NEGATIVE at 6-12mo** (−0.083, momentum reasserts) → useless here. So
  momentum-liquid should be held weeks-to-months, not days.
- **Angle F — fair OSCILLATOR trial** (`oscVotesAt` = voteVector's RSI/MACD/Stoch/BB thresholds, engine parity;
  `oscillatorEventStudy` = within-name event study, H=21d, excess = signal-bar fwd return − the name's own
  buy-&-hold, significance ACROSS names). **The pie was the WRONG EXAM:** judged on TIMING (their real job), three
  of four are significant — **RSI +1.13% (t2.3), Stoch +0.98% (t2.4), BB +2.6% (t2.6)** oversold-BUY excess (the
  AVOID side is symmetrically negative) → genuine MEAN-REVERSION timers, and the engine's oversold→buy direction is
  CORRECT. **MACD is used BACKWARDS:** trend-follow buy (macd>0) LOSES −1.56% (t−2.7) while FADING it wins +1.42%
  (t3.9). This explains the engine self-conflicting (RSI/Stoch/BB "buy the dip" vs MACD "buy the breakout" fire
  opposite on the same bar → sum + costs + churn = the measured t −12.6 loser). **BUT NOT a green light:** an
  oversold bounce on the micro-cap roster is the textbook BID-ASK-BOUNCE / stale-price trap (angle A), it's
  cost-blind + high-turnover, in-sample, and across-name correlated. **Hypothesis, NOT a mandate — do NOT flip MACD
  or re-wire votes off in-sample; it earns a change only OOS.**

**Net engine implication (in-sample, not a mandate):** the system effectively holds **~2 tradeable independent
edges, not 8 — momentum-12-1 (robust to liquidity, own axis, same-sign both regimes; use ONE window) and a
size-constrained low-risk-quality axis** — while the confluence sums many correlated quality/fundamental votes
as if independent, and over-weights dead oscillators (ADX/RSI/MACD) vs the measured IC. The disciplined next
move is an OOS **momentum-12-1-on-liquid** variant judged by FDR; NO engine re-weight off in-sample alone.
EVIDENCE pie card now shows ROBUSTNESS + DIMENSIONALITY + REGIME panels (driver-verified, zero JS errors).

**momentum-12-1-on-liquid OOS variant — WIRED (DONE):** the disciplined follow-through on the A/B/C verdict —
the one survivor gets its own propose-only OOS label. `forward-log.mjs` `liquidAtBar(candles)` (pure: decision-bar
price ≥ $5 AND trailing-60-bar median dollar-volume ≥ $2M) stamps `tags.liquid` on every tactical row (static,
point-in-time; never enters the gate). `forward-perf.mjs` adds `momentum-liquid-on/off` (= `bothTac(momentumActivated,
liquid)`) under the existing BH/BY FDR family — so the scoreboard can compare momentum-on (any liquidity) vs
momentum-liquid-on directly. Surfaced in the EVIDENCE scoreboard. Tests +2 (248 green). Matures like every label —
only the OOS ledger through FDR counts; the 12-1 window is already what `momentumValue` uses (single window, per B).

**Market-regime notifier ("read the room") — DONE (display-only, awareness not a gate):** the user's framing of the
angle-C+F diagnosis — the engine's votes are CONDITIONALLY valid (trend-following in TRENDING markets, mean-reversion
in RANGING ones) and the regime-blind confluence fires them all at once, fighting itself. The honest fix is NOT a
secret regime gate (that would overfit one 2022–2026 cycle) but to SURFACE the regime so the human applies the right
toolkit. `marketRegime(bars)` (pure, in `engine.mjs`, mirrored byte-for-byte into `index.html`): close-only so it
works on any index proxy — **direction** (BULL/BEAR vs proxy 200-DMA), **trend** via Kaufman `efficiencyRatio`
(|net move|/Σ|bar move|: TRENDING ≥0.45 / RANGING <0.25 / TRANSITIONAL), **vol** (21d realized vs 126d baseline:
CALM/NORMAL/STORMY) → a `{label, favored, cautioned, risk}` read mapping the room to the toolkit. `buildOutlook`
attaches `regime` from the primary index proxy (SPY); the OUTLOOK tab leads with a bold **🧭 MARKET REGIME** card
(favored vs "fights the room" + an ELEVATED-risk flag in bear+stormy) and the SIGNALS hero shows a compact regime
chip beside the verdict. NEVER touches `analyze`/`scoreAt`/`runBacktest`/any gate (parity-safe; verdict unchanged) —
it tells you which of the engine's votes to TRUST, not what to do. Tests +4 (256 green); engine↔app parity verified
byte-identical; app mounts clean. Populates on a live fetch (egress-blocked in CI; needs a key in a real browser).

**Self-conflict (Headline #2) — Step 1 MEASURE (DONE), step-by-step, one at a time:** the angle-F diagnosis —
the engine sums MEAN-REVERSION votes (RSI/Stoch/BB, oversold→buy) and TREND votes (MACD/MA/MAlong/Trend) as if
independent, but they're conditionally valid in opposite regimes, so they fire opposite on the same bar and the
confluence fights itself (part of the measured t −12.6). The disciplined fix is sequential: **(1) MEASURE → (2)
SURFACE → (3) RESOLVE**, and resolve ONLY if the OOS ledger proves it. Step 1 shipped: `computeSignal` now derives
a **family-level split** (`trendDir`, `meanRevDir`, `famConflict` = the two camps point opposite ways) beside the
existing generic `conflict` penalty — surfaced on `analyze().confluence`, mirrored byte-for-byte into `index.html`
(parity verified; the snapshot test is unchanged — additive only). `forward-log` tags `votesConflict` on every
tactical row; `forward-perf` adds **`votes-aligned-on/off`** under the existing BH/BY FDR family, asking on LIVE
trades: *does the verdict pay more when the engine is NOT fighting itself?* Propose-only — never touches
`gate.actionable`; the family split is a LABEL, the engine's signal is byte-identical. Tests +2 (258 green; engine
+ forward-perf). Steps 2 (surface the conflict in the SIGNALS panel) and 3 (let the regime pick the lead camp) are
DEFERRED until this OOS A/B clears FDR — no in-sample re-wire.

**Self-conflict (Headline #2) — Step 2 SURFACE (DONE, display-only):** the SIGNALS panel now SHOWS when the engine
is divided. When `analysis.confluence.famConflict` is true, the hero gets a compact **⚠ ENGINE DIVIDED** chip and a
prominent advisory block spelling out the split — "Mean-reversion votes (RSI/Stoch/BB) say BUY, trend votes
(MACD/MA/MAlong/Trend) say AVOID — the confluence is fighting itself; each camp is valid in a different regime, so
one is noise right now." When the OUTLOOK regime is loaded it adds a **regime-aware read** ("market is RANGING →
weight the MEAN-REVERSION camp"), tying Step 2 to the regime notifier. STRICTLY display: the verdict is byte-identical
(famConflict is a read-out of the existing signal, never an input). App mounts clean, zero JS errors; renders on a
live fetch (analysis needs data — egress-blocked in CI). Step 3 (regime actually PICKS the lead camp in the score)
stays deferred until the votes-aligned OOS ledger clears FDR.

**Vote-weight mis-calibration — OOS test WIRED (DONE):** the pie found the engine's HAND weights mis-calibrated vs
measured IC — ADX weighted 3 (highest) but IC ≈ 0; RSI/MACD/Pat ≈ 0/negative; Vol IC 0.074 at weight 1
(under-weighted), Trend significant. Tested OOS without re-weighting the live engine (charter): `computeSignal`
derives `icBackedShare` = of the weighted conviction pushing THIS signal's way, the fraction from the PROVEN votes
(Trend/Vol/BB) vs the over-weighted dead ones — surfaced on `analyze().confluence`, mirrored byte-for-byte into
`index.html` (parity IDENTICAL; analyze snapshot unchanged — additive). `forward-log` tags `icBackedShare`;
`forward-perf` adds **`ic-backed-on/off`** (proven votes carry ≥⅓ of the case) under the existing BH/BY FDR family
— the live A/B: do BUYs the data trusts beat BUYs propped up by the mis-weighted dead votes? If on>off under FDR,
that's the evidence to re-weight (NEVER in-sample). Propose-only — never touches `gate.actionable`; the signal is
byte-identical. Tests +2 (260 green). EVIDENCE scoreboard row added; matures via the nightly pipeline like every label.

**MACD-fade — OOS test WIRED (DONE), the last loose thread from angle F:** F found MACD is used BACKWARDS at swing
horizons (trend-follow buy LOSES −1.56% t−2.7, FADING it wins +1.42% t3.9). Wired with NO engine change — `analyze`
already exposes the MACD direction via `indicators.macd.sig`, so `forward-log` tags `macdBull` (the MACD vote dir at
the decision bar). `forward-perf` adds **`macd-fade-on/off`**: ON = BUYs the engine took while MACD was BEARISH (it
FADED MACD), OFF = while MACD was BULLISH (it FOLLOWED it). The live A/B: if ON>OFF under FDR, MACD's engine direction
is confirmed BACKWARDS — evidence to flip/drop the MACD vote (never in-sample). Rows with no MACD (null) fall in
neither leg. Propose-only; no engine/parity impact (reads existing analyze output). Tests +1 (261 green). EVIDENCE
scoreboard row added. Every notable discovery from the pie now has an OOS follow-through.

**Team-minus-nuisance SHADOW ENGINE (DONE) — "a vote is welcome to contribute, but not when it's a nuisance":**
the user's framing of the pie — it exposed each vote's ROLE in the team signal; a vote earns its seat by helping
the TEAM, not by birthright, and the honest way to revoke a welcome is to run the team WITHOUT it and let the OOS
ledger judge (demote-fast, never an in-sample re-wire). `computeSignal` gains an additive `opts.drop` (filter votes
by name; default path byte-identical) and `analyze` an `opts.shadowDrops` → `a.shadows` (per-config team-minus-vote
verdict, decision-only, off by default, zero app overhead) — both mirrored byte-for-byte into `index.html` (parity
IDENTICAL; analyze snapshot unchanged). `forward-log.mjs` `SHADOW_CONFIGS` + `buildShadowEntries` log each shadow
team's OWN actionable-BUY stream (tag `mode:"shadow-…"`, gated identically to the real engine), marked by the SAME
`markToMarket` as tactical; the factor overlays + `forward-perf` `tac()` exclude `shadow-*` so they never conflate
with the real tactical `all`. `forward-perf` adds **`shadow-noMacd` / `shadow-noPat` / `shadow-noAdx` /
`shadow-noMacdPat` / `shadow-noDead`** — each scored vs the full team's `all`: if a shadow team's alpha beats `all`
under FDR, that vote is a net NUISANCE (evidence to demote it). The nuisance set is principled — MACD (backwards, F),
Pat (negative/dead), ADX (~0 IC yet highest hand-weight); **RSI/Stoch/BB are deliberately NOT shadowed (angle F
RESCUED them as mean-reversion timers).** Propose-only; never touches `gate.actionable`; the real signal is
byte-identical. EVIDENCE scoreboard rows added. Tests +4 (265 green; engine drop/shadows, forward-log builder,
forward-perf scoping). Matures via the nightly pipeline like every label.

**Shadow BACKTEST study (DONE) — the IMMEDIATE in-sample read on the same question:** the OOS shadow streams need
the ledger to mature; this gives the directional answer NOW. `scripts/shadow-backtest-study.mjs` (+ `.yml`
workflow_dispatch, opt-in commit) runs the engine's OWN `runBacktest`/`scoreAt` across the survivorship-free Polygon
universe for the FULL team and each team-minus-nuisance, comparing aggregate trade quality (win%, expectancy, pooled
t, total P&L, mean alpha vs each name's buy-&-hold) — the REVEAL is the Δ vs full (positive Δexpectancy/Δalpha + fewer
trades = the drop helped in-sample). `scoreAt` gained an additive `drop` arg (parity-mirrored into `index.html`); a
closure scorer `slice=>scoreAt(slice,drop)` runs each shadow backtest through the UNCHANGED `runBacktest`. Pure
`teamBacktestOne`/`aggregateTeam`/`revealVsFull` are unit-tested (TEAMS pins RSI/Stoch/BB are NEVER dropped). HONEST:
IN-SAMPLE, never the verdict — the engine's technical core is a measured loser (t −12.6) so even the full team may be
negative; the RELATIVE delta is the flashlight, the OOS `shadow-*` ledger under FDR is the arbiter. Tests +4 (269
green).

**First shadow-backtest CI run (DONE, in-sample reveal) — branch `claude/signalforge-profitability-wheel-qbclby`,
merged via PR #53:** 38/60 survivorship-free names. **Full team:** 2420 trades, win 41.8%, per-trade expectancy
**−0.533 (t −2.76, significantly losing)**, meanAlpha vs buy-&-hold −57.7. **Dropping the nuisances helps, and they
COMPOUND:** −MACD alone cuts 556 trades (−23%) + recovers +17pp alpha (the worst single offender — confirms angle F);
−Pat/−ADX help less alone; **the full cleanup (−MACD−Pat−ADX) FLIPS per-trade expectancy from −0.533 to +0.206 (t
−2.76 → +0.89), cuts trades 36% (2420→1557), and lifts win rate to 44.8%** — Δexpectancy +0.74, Δalpha +42pp. The
strongest evidence yet that MACD/Pat/ADX are net-negative nuisances (pie diagnosed → angle F mechanised MACD → the
in-reverse backtest shows removal flips expectancy positive + slashes churn). **HONEST BOUNDS:** in-sample (the green
the charter says dies live); even cleaned the team's alpha is STILL −15.3 (recovered +42pp but still loses to passive
— "a much less bad loser," not an edge); junky de-listed micro-cap universe. This STRENGTHENS THE PRIOR for demoting
the three; the OOS `shadow-*` ledger under FDR is still the arbiter — NO in-sample re-wire.

**Vote-construction self-audit (DONE, diagnostic) — "the check-engine light was on by construction":** a tread-lightly
read of the SIGNALS-tab votes (does the engine actually recognise the chart's moving parts?) found the pie's dead/
negative votes are dead for IDENTIFIABLE construction faults, several over-weighted — this is the MECHANISM behind the
t −12.6. Findings (empirically verified where subtle; NONE re-wired — diagnostic only):
- **`Div` (divergence) — BUG, mismatched windows (weight 2.5).** Compares the LAST-10-bar price move against RSI
  computed over the OLD `[0..len−10]` window — different, non-overlapping periods. A recent CRASH produced "lower lows
  but RSI rising → bullish bottom" because the RSI it read predated the crash. The one arguable true bug.
- **`Pat` (patterns) — CONTEXT-BLIND (geometry CORRECT).** Wick/body/range math is right (hammer/engulfing/doji/etc.
  all recognised), but it fires reversal patterns regardless of trend-location — a Hammer fires identically at a top
  and a bottom — and multiple patterns STACK (one bar → 2+ Pat votes @1.5). Negative IC explained.
- **`Trend` — whole-window net move, not the current trend.** `(last−first)/first` over the ENTIRE loaded series →
  window-length-dependent (a name that rose 200 bars then fell 40 reads UPTREND on full history, DOWNTREND on recent
  50). It scores a significant pie IC (0.072) only because cross-sectionally it's an ACCIDENTAL momentum proxy — right
  answer, wrong mechanism; misleading as the displayed "UPTREND/DOWNTREND".
- **`RSI` 40/60 thresholds** (vs textbook 30/70) — fires at non-extreme levels → "which side of ~50," diluted.
- **`MACD` = EMA12>EMA26** — a plain fast/slow crossover (redundant with the MA votes), no signal-line/histogram, and
  backwards at swing horizons (F). **`VWAP`** is a 20-bar volume-weighted MA mislabeled as session VWAP.
The honest meta: the SIGNALS dashboard shows 7 authoritative votes; under the hood 3 are buggy/misapplied (Div, Trend-
as-displayed, Pat), 2 redundant/mis-thresholded (MACD, RSI), 1 mislabeled (VWAP). DISCIPLINE: corrections become
OOS-testable CANDIDATE votes (corrected divergence / recent-window Trend / context-aware Pat), never in-sample patches.

**Second shadow-backtest run (8 teams incl. Div, DONE, in-sample) — merged via PR #56:** the audit's `Div` bug now has
its own shadow team. Result (38 names): **dropping Div alone helps modestly** (Δexpectancy +0.096, Δalpha +5.2pp —
on par with Pat/ADX, below MACD; quirk: it ADDS 73 trades, improving quality not churn). **The full 4-vote cleanup
`noDeadDiv` (−MACD−Pat−ADX−Div) is the new best team:** expectancy +0.148 (t +0.61) vs the 3-vote `noDead` +0.081,
win 44.7%, trades −38% (2435→1513), alpha recovered +43.7pp — i.e. removing the divergence bug ON TOP of the other
three makes the cleanest team cleaner still. **The nuisances COMPOUND super-additively:** sum of the 4 single Δexp =
+0.365, but all-four-together = +0.738 (double) — they reinforce each other's bad trades. HONEST (unchanged): in-sample
(dies live); even fully cleaned alpha is STILL −18.6 (loses to passive) and t +0.61 is a COIN TOSS, not significance.
The OOS `shadow-noDiv`/`shadow-noDeadDiv` ledger under FDR is the arbiter — NO in-sample re-wire.

**Contenders hardening (DONE) — branch `claude/signalforge-duplicate-parsecsv-yiWlH`, 4 issues found reviewing
the first live `contenders.json`:**
- **#1 implausible-fundamentals guard:** a bad SEC TTM assembly gave **NVDA npm ≈ 5.93 (593%)**, scored as
  "highly profitable." `valueScore` (`engine.mjs`, mirrored byte-for-byte into `index.html`) now drops a net
  margin with `|npm|>1.5` and flags it ("implausible — likely a filing-data error, ignored"); legit high ROE
  (>100%, low-equity/buyback names) is untouched. The REAL cause is the upstream `distill`/`secTTM` revenue
  TTM assembly — the guard is a safety net, not the cure (follow-up open). Tests +3.
- **#2 universe widened to ~S&P 500:** `fundamentals.json` was capped at 36 names (the 46-name `tickers.txt`).
  `build-fundamentals.mjs` now ranks the **active** `roster.json` names by **dollar volume** from one full-market
  Polygon snapshot (`parseSnapshotDollarVol` + `selectLiquidUniverse`, pure/tested) → top ~500 active, CIK-bearing
  names; crawls SEC by the roster CIK (skips `secCik`); falls back to `tickers.txt` without a key/roster.
  `build-contenders.mjs` grades **every** name in `fundamentals.json` (was `readTickers().filter`) and uses the
  full-market snapshot. `fundamentals.yml` gains `POLYGON_API_KEY`; `contenders.yml` sets `POLYGON_PACE_MS=0`
  (the plan is unlimited — 500 financials calls in minutes, not ~100min). Tests +6.
- **#3 honest technical box (no more dead-pattern coin-flip):** `allBoxes` gated on the convergence pattern, a
  MEASURED LOSER. `techVerdict` now reads **12-1 momentum** (`momentumFromMonthly` off Polygon monthly bars — the
  one robust factor) as a **tri-state box** (`pass`/`fail`/**`nodata`** — never conflates "no data" with "negative,"
  fixing the META/MSFT false-negative); the pattern edge is kept only as an experimental secondary read. `allBoxes`
  = grade A/B AND `box==="pass"` AND `crossCheck.ok`. CONTENDERS tab shows the momentum read + a distinct
  "no price history" state. Tests updated.
- **#4 propose-only `contenders-on` OOS ledger:** `forward-log.mjs` `contenderTag(contendersDB, sym)` tags
  `contenderAllBoxes`/`contenderAB` on tactical + position rows (point-in-time: current bar vs current list, no
  lookahead); `forward-perf.mjs` adds `contenders-on/off` + `contenders-ab-on/off` under the existing BH/BY FDR
  family. NEVER touches `gate.actionable` (status byte-identical, tested). EVIDENCE scoreboard rows added. Tests +3.
- Engine↔app `valueScore` parity verified byte-identical; app mounts clean (driver, zero JS errors); 298 tests green.
  Live SEC/Polygon crawl runs in CI (sandbox blocks both) — dispatch `fundamentals.yml` then `contenders.yml` after
  merge to populate the widened list.

**R6 + R5 — codify the ritual + corrected candidate votes (DONE) — branch `claude/signalforge-profitability-wheel-qbclby`:**
the roadmap executed two-at-once per the user's "R5-6". **R6 (cheap, foundational):** the standing gauntlet
(cross-sectional IC → robustness A–F → shadow with-vs-without → OOS under the R1 bar → record; NEVER an in-sample
re-wire) is now written into the Methodology section ("### The audit ritual (R6)") as the requirement every new
vote/factor/feature must pass — the habit that compounds more than any single edge. **R5 (the corrected votes):** the
vote-construction self-audit's three faults get FIXED candidate forms, judged OOS exactly like the nuisances —
`divergenceFixed` (price vs RSI over the SAME recent window; a regression test proves it KILLS the false-bottom the
window-mismatch bug printed after a crash, where the buggy `divergence` still reads BULLISH), `recentTrend` (net move
over the last ~50 bars, not the whole stale series), `patternsContext` (same geometry, but a reversal pattern earns a
vote only at the right LOCATION and multiple patterns COLLAPSE to one net vote — ending the context-blind stacking).
Additive `corrected` path on `computeSignal`/`scoreAt`/`analyze` (`CORRECTED_DROP=["Div","Trend","Pat"]` + inject the
fixed forms); default path byte-identical, mirrored into `index.html` (parity verified). Wired propose-only:
`shadow-corrected` in `forward-log` SHADOW_CONFIGS + `forward-perf` variant (scored vs the full team's `all` under the
FDR family) + a `corrected` team in the in-sample `shadow-backtest-study` (immediate flashlight). The live engine is
UNCHANGED — candidates only; only the OOS ledger under R1 (or the shadow-backtest Δ) earns a re-wire. Tests +7 (307
green); app mounts clean (driver, zero JS errors). The `shadow-corrected` OOS stream matures via the nightly pipeline;
dispatch `shadow-backtest-study.yml` for the in-sample read.

**Shadow-backtest run with the `corrected` team (DONE, in-sample) — branch `claude/signalforge-profitability-wheel-qbclby`,
run #4, LIQUID default (20 covered, 18 illiquid dropped from cap 60, survivorship-free):** the immediate flashlight on
R5. **Full team:** 1463 trades, win 41.3%, expectancy −0.467 (t −2.60, significantly losing), alpha −97.1. **The R5
`corrected` re-build (Div/Trend/Pat → DivFix/TrendFix/PatFix) barely helps and ADDS churn:** expectancy −0.400 (t −2.29),
alpha −94.6, 1581 trades — Δexp **+0.066**, Δalpha **+2.5pp**, Δtrades **+118**. The honest lesson: **correcting the votes
is a much weaker lever than DROPPING them in-sample** — fixing the bugs keeps Div/Trend/Pat contributing (still correlated,
still churning +118 trades), whereas removing the nuisances cuts trades and recovers alpha. By contrast the nuisance-DROP
teams compound: −MACD alone Δalpha +17.6pp (−331 trades, worst single offender, confirms angle F); the full cleanup
**−MACD+Pat+ADX+Div** is the best team at expectancy −0.083 (t −0.36), alpha −66.7, 882 trades (Δexp **+0.383**, Δalpha
**+30.5pp**, −581 trades). **HONEST BOUNDS (unchanged):** only 20 liquid names, in-sample, and even the best cleanup STILL
loses to passive (alpha −66.7, t −0.36 = a coin toss) — the R3 corrected-conclusion holds (on tradeable names the cleanup
is "a much less bad loser," not an edge). This POINTS toward demote-over-correct for the nuisance set; the OOS
`shadow-corrected` vs `shadow-noDeadDiv` ledger under FDR is the arbiter — NO in-sample re-wire.

**Regime card → actionable VERIFY/CONFIRM checklist (DONE, display-only) — "make awareness-only ACTIONABLE":** the
user's read of the OUTLOOK 🧭 MARKET REGIME card — it stated the regime (BULL · RANGING · ER 0.07 · NORMAL VOL) as
vague prose ("✓ Favored here / ⚠ Fights the room / Awareness only"), not something you can ACT on. Rebuilt as a
pre-trade **A–D Verify/Confirm checklist** via pure `regimeChecklist(regime,{resLabel,intraday})` (`engine.mjs`,
mirrored byte-for-byte into `index.html`, parity verified): **A · DIRECTION** (vs ~200-DMA → tailwind/headwind),
**B · MODE** (TRENDING/RANGING + ER → the toolkit to trust, folding in favored/cautioned), **C · VOLATILITY**
(21d vs 6-mo norm → the sizing dial), **D · HORIZON** (the regime is a DAILY/swing read — flags a mismatch when the
chart is INTRADAY, the user's IMG_1189 confusion). Each line carries `{value, status:confirm|verify|caution, read
(the fact), action (→ DO)}`; the card renders lettered rows colored by status with an explicit "→ DO:" action and a
⚑ BOTTOM-LINE risk banner. The SIGNALS hero regime chip tooltip was made consistent (same A–D action summary). STRICTLY
display — `marketRegime`/`analyze`/the verdict are byte-identical; `regimeChecklist` is a pure read-out, never an input.
Tests +4 (311 green; A–D mapping, intraday→HORIZON verify, BEAR+STORMY→caution, null→[]); app mounts clean (driver,
zero JS errors). **Other-tab vagueness AUDIT (reported, not yet built):** the same "status-without-action" pattern still
lives in the SIGNALS macro chip ("🌐 RISK-OFF · CONTEXT" — "CONTEXT" = "not yet proven", unexplained) and the
"UNCONFIRMED EDGE" badge; the ENGINE-DIVIDED advisory is already actionable (gives camp directions + a regime room-read).
Offered as the next one-at-a-time pass.

**"Why is the regime ALWAYS BULL·RANGING·NORMAL?" — diagnosis + market-wide labeling fix #1 (DONE, display-only):**
the user spotted that the OUTLOOK 🧭 regime and the SIGNALS "ENGINE DIVIDED" read identically no matter which stock is
loaded. Root cause (traced, not guessed): the regime is `marketRegime(idx["SPY"])` (`index.html`) — it reads the **S&P
proxy, NOT the stock**, so it is correctly IDENTICAL for every ticker (it's "read the room" = the broad market) and only
moves day-to-day. The 🌐 MACRO chip is the twin (computed from `outlook.combined`, the SPY·DIA·QQQ session sum) — also
market-wide. Neither was LABELED as market-wide, so both looked like stuck per-stock reads. Two further mechanisms recorded
for later passes: (a) the ER mode thresholds (TRENDING≥0.45 / RANGING<0.25, `engine.mjs`) are mis-calibrated for DAILY
INDEX data — net 21-day index progress is small vs the summed daily path, so ER sits structurally low (~0.07) and pins the
MODE to RANGING almost always (display heuristic, not a gate — fix #2, deferred); (b) "ENGINE DIVIDED" fires on most names
because the engine genuinely conflicts nearly always (Headline #2, the real pathology) and its "Room read" lead-camp line is
fed by the stuck-RANGING regime, so it always says "weight mean-reversion" (fix #3, deferred). **Fix #1 SHIPPED:** both the
🧭 regime card (header → "US MARKET REGIME · SPY" + a clarifier that it's the room your stock trades inside, same for every
ticker, NOT a read on the stock) and the 🌐 macro card/chips (→ "US MARKET MACRO · SPY·DIA·QQQ · same for every ticker") are
now explicitly labeled market-wide; the SIGNALS chips show "🧭 MKT · …" / "🌐 MKT · …" with tooltips that lead with the
market-wide caveat. STRICTLY display (no engine/gate/verdict touched); app mounts clean (driver, zero JS errors). Fix #3 (de-boilerplate
ENGINE DIVIDED) remains offered as the next pass.

**Fix #2 — ER trend-MODE recalibrated for daily-index data (DONE) — "stop pinning the regime to RANGING":** the old
absolute cut-points (`er>=0.45` TRENDING / `er<0.25` RANGING, `marketRegime` in `engine.mjs`) were mis-tuned for DAILY
INDEX bars — net 21-day index drift is small vs the summed daily path, so the efficiency ratio sits structurally low
(~0.07–0.20) and the mode read RANGING almost always. Fix (mirrors the EXISTING `vol` classifier, which is relative to a
6-month baseline): keep absolute calls only at the UNAMBIGUOUS extremes (`er>=0.45` = clean trend, `er<=0.10` = clear
chop), and classify the wide MID-RANGE where daily data actually lives RELATIVE to the market's OWN efficiency norm — the
MEDIAN of its trailing rolling 21-bar ER (`baseER`): TRENDING if `er>=baseER*1.35`, RANGING if `er<=baseER*0.75`, else
TRANSITIONAL (short-history fallback uses daily-calibrated absolutes 0.30/0.18). Self-calibrating across resolutions/assets;
the absolute ER is still surfaced for transparency. Now it DISCRIMINATES (a trend emerging from chop reads TRENDING at a
mid-range ER the old 0.45 bar never reached) instead of being stuck. **Honest limitation:** a persistent moderate trend
whose ER stays near its own (now-elevated) baseline reads TRANSITIONAL rather than TRENDING — relative classification's
known tradeoff; the absolute ≥0.45 ceiling still catches strong trends. Mirrored byte-for-byte into `index.html` (parity
verified); display-only, touches no gate/verdict. Tests: updated the "choppy" case to genuine bar-to-bar chop (the old
smooth-sine series is locally directional → correctly TRANSITIONAL now) + added an emergent-trend discrimination test
(312 green); app mounts clean.

**Fix #3 — de-boilerplate ENGINE DIVIDED (DONE, display-only):** the advisory read like static boilerplate because (a) it
fires on most names (the engine genuinely conflicts nearly always) and (b) its old "Room read" line only weighted a camp
("weight the MEAN-REVERSION camp") without an actionable conclusion, and was dropped entirely when the regime was
TRANSITIONAL. Rebuilt (`index.html`, SIGNALS advisory + hero chip tooltip): the regime now RESOLVES the split to an honest
LEAN — "the US market is RANGING → trust the MEAN-REVERSION camp, which says **BUY** → honest lean: BUY; discount the trend
camp as out-of-regime noise" — using the camp's OWN direction (`trendDir`/`meanRevDir` already on `analysis.confluence`).
When the regime is TRANSITIONAL/unread it says so explicitly ("neither camp is favored — a genuine stand-aside") instead of
omitting the line. Added a calibration line: the split is the engine's NORMAL state, not a rare alarm (it conflicts on most
names — the t −12.6 pathology, Headline #2). Combined with fix #2 (the regime now varies), the read now changes with the
room + the two camps' directions instead of being fixed prose. STRICTLY display — reads existing `confluence` fields; the
verdict is byte-identical; no engine/gate touched. App mounts clean (driver, zero JS errors). All three regime-clarity
passes (#1 label market-wide, #2 recalibrate ER, #3 de-boilerplate) now done.

**FORWARD-TEST "duplicate rows" fix (DONE, display-only) — shadow streams polluting the human ledger view:** the user
spotted the FORWARD TEST · OPEN POSITIONS table showing the SAME name 4–5× with IDENTICAL entry/SL/TP (BAC ×4, V ×5, CAT
×5). Root cause (traced): the tab derived `opens`/`closed`/`obs`/segments from the RAW `paper-ledger.json` with NO mode
scoping (`index.html`), so the internal team-minus-vote **shadow-* research streams** — which reuse the tactical entry/SL/TP
VERBATIM — rendered as exact-duplicate rows (one per shadow team that fired the same BUY; ~8 shadow configs after the
shadow-corrected merge). The POSITION stream added a second (differently-stopped) row per name too. Fix (display-only — the
tab "only reads the ledger"): hide `shadow-*` rows from the OPEN/CLOSED/OBS tables AND the segmented-performance card (their
home is the OOS SCOREBOARD on EVIDENCE, not the paper-trade view), scope the REALIZED-PERFORMANCE segments to TACTICAL-only
(POSITION is a distinct philosophy with its own scoreboard variant — pooling months-long trailing holds with tactical
expectancy was apples-to-oranges), and add a **MODE** column (TACTICAL/POSITION, color-coded) to the OPEN + CLOSED tables so
the two legitimate streams are labeled and never mistaken for a duplicate. A footnote reports how many shadow rows were
hidden. NO engine/ledger-file change (the file correctly carries shadow rows for the scoreboard); app mounts clean (driver,
zero JS errors). 312 tests green (no tested code touched).

**CONTENDERS "🏢 COMPANY" button (DONE) — context on-ramp beside ANALYZE (user idea, kids-friendly):** each contender
card now has a secondary **🏢 COMPANY** button stacked ABOVE the primary **ANALYZE →** (kept both per the user's call —
ANALYZE is the core action, never replaced). It toggles an inline ABOUT panel: company name · industry · a short "what it
does" description · a **"Visit official website ↗"** outbound link (`target=_blank rel=noopener noreferrer`, http(s)-only).
Data is Polygon ticker-details (`/v3/reference/tickers`, `homepage_url`/`description`/`sic_description`) — charter-clean,
no new vendor. Wired two ways: `build-contenders.mjs` BAKES `about:{name,homepage,industry,description}` (pure
`parseTickerDetails`, description truncated 500, non-http homepages dropped) onto every DISPLAYED name (A/B shortlist + C
watch tier) so it works with NO key; the app lazy-fetches via `polyTickerDetails` as a fallback when a key is set but the
JSON has no baked profile, and shows a gentle "loads after the next build / add a key" note otherwise. STRICTLY context —
never touches the grade/signal/gate (a company's homepage is marketing, not edge; framed "context, not a signal"). Tests
+1 (313 green; parseTickerDetails extraction/truncation/non-http rejection/empty-safe). App mounts clean (driver, zero JS
errors). The baked profiles populate on the next `contenders.yml` CI run; until then the button lazy-fetches with a key.
**CONTENDERS personal watchlist — Not/👍/🌟 + change-since-you-reacted (DONE) — user idea, kids-friendly:** each
contender card gets a **WATCHLIST** toolbar (🌟 Star · 👍 Like · 🚫 Not). Reacting **pins** the name to the TOP of its
list (starred above liked; Not sinks) and **snapshots** its metrics, so the card then shows a "**SINCE YOU STARRED**"
row with ⬆/⬇ deltas vs that snapshot: **GRADE** (A→B with arrow), **PRICE** (%), **HEALTH**, **GROWTH** — auto-updating
as the nightly rebuild moves the numbers. A **📄 NEW FILING** flag lights when the company files a new 10-Q/10-K since you
reacted (the snapshot's `filing.date` vs current — the "until next filings update" anchor the user described); the
baseline is kept so the deltas span the filing. A **MY PICKS** header stat + an **⊞ ALL NAMES / ★ MY PICKS ONLY** view
toggle round it out. Persistence is **`localStorage` (`sf_contender_picks`)** — DEVICE-LOCAL by design (the app is a
static single file, no backend/accounts; charter-clean, no new vendor), survives reloads + CI rebuilds. STRICTLY a
personal overlay — never touches the grade/signal/gate. Pure display + localStorage (no engine/data change; 313 tests
green). Verified via a Playwright drive of the CONTENDERS tab: 385 reaction toolbars render, a 🌟 click pins + shows the
SINCE-YOU-STARRED delta row, MY PICKS stat present, zero JS errors. (Earlier queued; now shipped.)

**🧑‍🏫 GUIDE tab — expert-advisor that coaches the whole toolkit into one read (DONE) — branch
`claude/signalforge-profitability-wheel-qbclby`:** the capstone of the "status-without-action" theme (the regime A–D
checklist, market labeling, ER recalibration, de-boilerplated ENGINE DIVIDED were the per-feature passes). One pure
`guideBrief(analysis, regime, opts)` (`engine.mjs`, exported + unit-tested; mirrored byte-for-byte into `index.html`,
parity verified) synthesizes the ALREADY-COMPUTED `analysis` + `outlook.regime` into `{here, cliffs, watch, apply,
formation, next}` — reads existing fields ONLY, NEVER touches `analyze`/`computeSignal`/`scoreAt`/any gate/the
long-only policy (verdict byte-identical; `analyze` snapshot unchanged). The GUIDE tab is placed **3rd, right after
LIVE** (an on-ramp): YOU ARE HERE (verdict+regime+mode+timeframe chips) · **HOUSE RULES** (the advisory board answering
the user's "who are the best teachers" ask — **Edward Thorp** (quant: only bet a MEASURED edge, size by it, no edge →
don't trade) + **Richard Dennis / the Turtles** (mechanical rules, ATR-based sizing, cut losses fast / let winners run),
whose proven methods ARE the OOS-gated, ATR-sized, momentum-tilted system) · CLIFFS-NOTES (regime-favored read, the
DIVIDED-engine resolved lean, RSI extremes, mentor-voiced) · WHAT TO LOOK 👀 FOR (status-coded RSI/ADX/BB/VWAP/VOL/MACD
checklist, reusing the regime-checklist item style) · APPLY NOW (recommended mode/timeframe/strategy from the regime) ·
CHART FORMATION (patterns/divergence + what-to-watch-next) · NEXT STEP (routes to SIZE on an actionable BUY, else
EVIDENCE). **A SHORT setup is surfaced as AWARENESS** (read from the raw `analysis.signal`/`score` — confirmed
`index.html:2247` carries the raw SELL; muting is display-only), honestly framed "NOT taken under the long-only default"
— never made actionable. STRICTLY display-only; no engine/parity/gate impact. Tests +6 (319 green); app mounts clean
(driver: GUIDE empty state renders, full JSX transpiles, zero JS errors). Loaded-state cards populate on a live fetch
(needs a key in a real browser — egress-blocked in CI).

**🧭 THE WORK-UP — reframe the whole app as a REAL expert's guided stock work-up (DONE) — branch
`claude/signalforge-profitability-wheel-qbclby`:** the user (and their kids — beginners in training) asked: what does a
PROFESSIONAL's full work-up of a stock look like, and make the app match it across ALL tabs. Researched + synthesized the
canonical pro sequence (O'Neil **CAN SLIM**, Minervini **SEPA / 8-point Trend Template**, Weinstein **Stage Analysis**,
top-down, the pre-trade/risk checklist, journaling) and mapped it onto the app. Key finding: SignalForge already holds
EVERY piece a pro uses — and on risk + proof it is MORE rigorous than the retail frameworks (FDR-gated OOS evidence, ATR
sizing, a forward journal); what it lacked was the plain-English numbered SEQUENCE and two teachable reads it could compute
but never surfaced. Shipped (user picked **Full** + **reorder tabs into the 1–9 funnel**), STRICTLY display-only:
- **Two NEW pure expert reads** (`engine.mjs`, exported + tested, mirrored byte-for-byte into `index.html`): `stockStage(bars)`
  (Weinstein Stage 1–4 from price vs a ~150-bar/30-week SMA + its SLOPE — Stage 2 = above a rising MA = the buy zone; the
  slope uses a window that always FITS so Stage 2/4 read on sub-150-bar series) and `trendTemplate(bars)` (Minervini's 8
  points — price>50MA, 50>150>200 stack, 200 rising, within 25% of 52-wk high, ≥30% above low, RS 12-mo proxy [labelled],
  holds-above-50MA; checks whose window isn't met return `pass:null`, counted out via `applicable`, NEVER failed). Both take
  the bar SERIES (analyze() only carries SMA5/10/20/50) and degrade HONESTLY to `nodata`.
- **`workupChecklist(ctx)` conductor** (`engine.mjs`, exported + tested, mirrored): a pure ASSEMBLER over already-computed
  inputs → 9 ordered steps `{n,phase,tab,title,proCheck,status,value,read,action,why}` (status ∈ pass|fail|caution|nodata|info,
  reusing the regimeChecklist item shape). 1 READ THE MARKET→outlook · 2 KNOW THE COMPANY→contenders · 3 STAGE & TREND→signals ·
  4 FUNDAMENTALS→value · 5 CATALYST→value · 6 **PROVEN EDGE?→evidence (the honesty gate)** · 7 THE PLAN (R:R≥2)→signals ·
  8 SIZE IT→position · 9 JOURNAL→paper. **Honesty invariant (unit-locked):** Step 6 is INDEPENDENT of the technical boxes and
  stays `caution` "NOT YET PROVEN" until the OOS ledger proves an edge — all-technical-green NEVER implies a trade; the summary
  carries "NOT PROVEN" and a footer disclaimer says so. Plus tiny `provenSummary(forwardPerf)` (provenAny = any variant
  `promotable`; currently false = the app's identity). NEVER touches `analyze`/`computeSignal`/`scoreAt`/any gate (verdict
  byte-identical; `analyze` snapshot unchanged).
- **GUIDE = the conductor:** a **🧭 THE WORK-UP** card (9-step progress list, `X/9 confirmed`, status icons, per-step "GO TO
  <TAB>" buttons, the disclaimer) renders ABOVE the existing guideBrief cards. A shared **`proLens(n)`** banner ("STEP n OF 9 ·
  <phase>" + what-a-pro-checks + status + "← back to THE WORK-UP") indexes into ONE computed `wu` result and is dropped on
  every funnel tab (OUTLOOK→1, CONTENDERS→2, SIGNALS→3&7, AUTOPSY→4&5, EVIDENCE→6, SIZE→8, FORWARD TEST/HISTORY→9) — no
  duplicated logic. **Tab bar reordered** into the funnel: `DATA · LIVE · GUIDE · OUTLOOK · CONTENDERS · SIGNALS · AUTOPSY ·
  EVIDENCE · SIZE · FORWARD TEST · BACKTEST · REPLAY · HISTORY`.
- Tests +15 (**334 green**); engine↔app parity byte-identical for all 4 functions; app mounts clean, new tab order + GUIDE/
  OUTLOOK/SIGNALS/SIZE render with zero JS errors (driver). Loaded-state populates on a live fetch (needs a key in a real
  browser — egress-blocked in CI). Catalyst step 5 is `nodata` until a per-symbol filing date is surfaced in-app (honest TODO).

**Next — Track B:**
- Mature the `momentum-on` / `merits-on` / `news-*` / `earnings-recent-on` OOS ledgers to n≥10; human-ratify
  only if they clear FDR. PASSIVE — the nightly `forward-log → forward-perf → promote` already partitions every
  variant, and the BH+BY FDR family auto-grows to include each new label once it has ≥ MIN_TRADES_SIG trades.
- **WebSocket live plumbing is ~built, not greenfield:** `scripts/poly-ws.mjs` (unit-tested protocol:
  auth/subscribe/parse/`wsFreshness`) + `PolyLiveSocket` in `index.html` (auth→subscribe→onBar, auto-reconnect,
  cleanup) + a "GO LIVE" UI toggle + honest DELAYED badge (never fakes REALTIME on Starter; cluster is a one-word
  `mode` flip on upgrade). Confirmed entitled: the user's Stocks-Starter plan **includes WebSockets** (delayed).
  Added a **staleness watchdog** (15s `setInterval` re-ages the badge from the last bar's end via `wsBand`, so a
  stalled stream decays to STALE instead of freezing). Remaining = OPTIONAL: fold the live forming bar into the
  chart (cosmetic on a delayed/swing feed — NOT a real-time signal) + a PolyLiveSocket↔poly-ws.mjs parity test.
  Live end-to-end needs a key in a real browser (the delayed socket is egress-blocked in CI).
- Every candidate clears no-lookahead + OOS t≥2 after FDR before it's ever shown as tradeable.

## Improvement roadmap (recommendation backlog — dedup'd, pick ONE at a time)

Single source of truth so recommendations aren't overlaid or lost. Status: ✅ done · ⏳ passive (ledger only) ·
🟢 actionable now (charter-clean) · 🔵 decision (user's call, gated on OOS proof). **Sustainable rule: one at a
time; the in-sample dyno points, the OOS ledger pulls the trigger; NEVER an in-sample re-wire.**

- ✅ DONE this arc: scoreAt↔analyze parity audit (clean, 370/370); patterns()/candle audit (geometry correct,
  context-blind); vote-construction audit (Div bug, Trend window-dep, RSI/MACD/VWAP mis-thresholds); shadow engine
  + shadow backtest (8 teams); `shadow-noDiv`/`noDeadDiv`.
- ⏳ PASSIVE — mature the ~22 OOS labels + 7 shadow streams to n≥10 and clear the BH/BY FDR family. Time, not work.
- 🟢 **R1 · Pre-register the promotion bar** (cheapest, foundational, do FIRST): ✅ **DONE — LOCKED protocol below.**
- 🟢 **R2 · Prune the FDR TEST family** (cheap, restores power): ✅ **DONE.** The FDR denominator now counts only genuine
  PROMOTION HYPOTHESES — `forward-perf` flags each variant `fdr` and EXCLUDES baselines (`all`/`position`), every `-off`
  control leg (the complement, not a hypothesis), and the dominated `shadow-noMacdPat`. ~halves the family `m`, restoring
  BH/BY power and ending the double-count of anti-correlated legs. Excluded-but-populated variants read verdict `CONTEXT`
  (not a false `NOT SIGNIFICANT`). Tests +1 (299 green).
- 🟢 **R3 · Liquid PRIMARY research universe** (biggest contamination fix): ✅ **DONE (shared screen, two studies).**
  Pure `clearsLiquidityBar(bars)` (median price≥$5 AND median daily $-vol≥$2M over a name's history) is now the DEFAULT
  universe gate for `factor-interaction-study` + `shadow-backtest-study` — drops the perpetual micro-cap junk that
  contaminated the pie (lowvol artifact, oversold bounce). Liquid de-listed names still pass (NO survivorship bias
  added). The full survivorship-free roster stays an opt-in **bias cross-check** via `FIS_UNIVERSE=full` /
  `SBT_UNIVERSE=full`; the `universe.screen` field + caveats record which ran. Tests +1 (300 green). Pattern to adopt
  next in the sibling cross-sectional studies (momentum/reversal/lowvol/quality/merit) — same helper, same toggle.
- 🟢 **R4 · Audit the SIZE / risk-management layer** (untapped frontier): ✅ **AUDITED (diagnostic, nothing re-wired).**
  The CORE sizing model is CORRECT — textbook fixed-fractional `shares = risk$ ÷ stop-distance`, risk-$ held constant,
  uses the same ATR-based SL the signal sets, and is AUTO vol-normalized (wider ATR → wider stop → fewer shares).
  But four RISK gaps (mirror image of the signal layer — core sound, management thin): **(1) no concentration cap
  ENFORCED** — a tight stop inflates POSITION VALUE to >100% of the account (un-buyable without margin) while the tab's
  printed "≤10-20%" rule is never applied; **(2) "max loss" is idealized** — ignores costs/slippage AND assumes the
  stop fills at price (a gap-down blows through it), shown as definite; **(3) NO portfolio-level risk** — sizes each
  trade in isolation, but the engine's longs are all correlated (long, momentum-tilted) so 10×1% ≠ 10% heat (the deep
  "unmeasured factor"); **(4) NO edge-aware sizing** — full 1% on every signal regardless of proof, i.e. over-betting a
  coin-toss (Kelly says ≈0 with no edge; ties to the FDR discipline — don't size what hasn't cleared the bar). FIXES:
  #1 cap + #2 honest max-loss are charter-clean DISPLAY-layer safety fixes (touch the risk tool, not signal/gate);
  #3 portfolio heat + #4 edge-aware sizing are the deeper frontier (bigger builds). Verified empirically (tight stop →
  125% of account at 1% risk). Risk management, not signal-squeezing, is the higher-leverage gap.
  **#1 + #2 NOW APPLIED (display-only, no engine/parity change):** the SIZE tab caps position value at `MAX_POS_PCT=20%`
  of account (recommends `min(risk-based, concentration-cap)` size; an amber ⚑ banner shows the risk-rule size, the cap,
  and the SHRUNK effective risk when binding — you risk LESS, never more); the "max loss" line is relabelled "(ideal)"
  with a caveat that it excludes costs/slippage and assumes the stop fills at price (a gap-down can exceed it). 300 tests
  green, app mounts clean. #3/#4 remain the deeper frontier.
- 🟢 **R5 · Candidate CORRECTED votes**: ✅ **DONE — the `shadow-corrected` team.** The three faulty votes from the
  self-audit get FIXED candidate forms, judged OOS like every nuisance: `divergenceFixed` (price vs RSI over the SAME
  recent window — kills the window-mismatch false-bottom the bug produced after a crash), `recentTrend` (net move over
  only the last ~50 bars, not the whole stale series), `patternsContext` (same geometry but a reversal pattern earns a
  vote only at the right LOCATION — bullish at a bottom / bearish at a top — and multiple patterns COLLAPSE to ONE net
  vote, ending the context-blind stacking). `computeSignal`/`scoreAt`/`analyze` gained an additive `corrected` path
  (`CORRECTED_DROP=["Div","Trend","Pat"]` + inject the fixed forms); default path byte-identical, mirrored into
  `index.html` (parity verified). Wired propose-only: `shadow-corrected` in `forward-log` SHADOW_CONFIGS (own OOS BUY
  stream, gated identically), `forward-perf` `shadow-corrected` variant (scored vs the full team's `all` under the FDR
  family), and a `corrected` team in the in-sample `shadow-backtest-study` (the immediate directional read). The live
  engine's votes are UNCHANGED — these are CANDIDATES; only the OOS ledger under the R1 bar (or the shadow-backtest's
  relative Δ as a flashlight) earns a re-wire. Tests +7 (307 green); app mounts clean.
- 🟢 **R6 · Codify the audit RITUAL**: ✅ **DONE.** The gauntlet (cross-sectional IC → robustness A–F → shadow →
  OOS under the R1 bar → record) is now written into the Methodology section above ("### The audit ritual (R6)") as
  the standing requirement every new vote/factor/feature must pass. The habit compounds more than any single edge.
- 🔵 **D1 · Demote-fast the nuisances** (MACD first, then the MACD+Pat+ADX+Div trio) WHEN their `shadow-*` streams clear
  FDR. Lower bar than promotion; cut, don't flip.
- 🔵 **D2 · Self-conflict Step 3** (regime picks the lead camp in the score) — only after `votes-aligned` clears FDR.
- 🔵 **D3 · Vote re-weight** (`ic-backed`) — DE-PRIORITIZED: the pie's cross-sectional IC is the wrong target for the
  engine's per-name decision (angle F); if anything, weight by the timing evidence, not selection IC.
- 🔵 **D4 · Product reframe** — momentum-12-1-on-liquid as the SPINE; regime notifier + confluence demoted to a TIMING
  overlay the human consults, not the verdict (even fully cleaned the confluence is a coin-toss that loses to passive).
- 🔵 **D5 · Terminal milestone** — pre-commit a go/no-go date: "at 100 closed `momentum-liquid` OOS trades, decide;
  demote whatever FDR has cleared." Turns open-ended measurement into a decidable project.
- ⏳ OPTIONAL leftovers: WebSocket forming-bar parity test; live end-to-end (needs a key in a real browser).

### R1 — Pre-registered PROMOTE / DEMOTE protocol (LOCKED 2026-06-22 — do not soften after seeing data)

Written BEFORE the ledger filled, expressly to forbid optional-stopping (moving the bar to fit a number you've
already watched). Operates on `forward-perf.json`'s per-variant `alphaGrowthPct` (alpha vs TOTAL-return buy-&-hold),
its BH and BY FDR `significance`, and `n` (closed, benchmarkable trades).

**PROMOTE** a propose-only label to "ratified / tradeable" — ALL must hold:
1. **Coverage:** `n ≥ 10` closed benchmarkable OOS trades (charter floor). `n < 10` ⇒ status WATCH, never promoted.
2. **Significance:** clears the FDR family at `q ≤ 0.05` on **BOTH the BH and the BY** columns — not BH alone (the
   ~30-member family is correlated; BY is the dependence-robust check and is now a co-gate, not just a footnote).
3. **Sign:** point-estimate `alphaGrowthPct > 0` (a significant NEGATIVE alpha is evidence to DEMOTE, never promote).
4. **Persistence (anti-overfit):** split the label's closed trades chronologically in half — mean alpha must be
   **positive in BOTH halves**. If `n < 20` the split is untrustworthy ⇒ status PROVISIONAL, hold promotion until `n ≥ 20`.
5. **Cleanliness:** no-lookahead intact; not flagged data-suspect.

**DEMOTE** (cut a nuisance vote / mark a label dead) — LOWER bar, cut fast (charter "demote fast"):
1. `n ≥ 5` closed OOS trades.
2. The adverse verdict at `p ≤ 0.1`: for a nuisance VOTE, its `shadow-*` team's alpha beats the full team's `all`;
   for a label, a significant NEGATIVE `alphaGrowthPct`. Cut, don't flip; never re-wire the live engine in-sample.

**ANTI-OPTIONAL-STOPPING (binding process):**
- Evaluate ONLY at the fixed cadence (monthly) — never continuously; do NOT act on the first threshold crossing
  between checkpoints.
- A label evaluated and failed is re-examined only at the NEXT scheduled checkpoint, not re-tested daily for a cross.
- This bar is FROZEN. To change it, change it for FUTURE labels with a dated note — NEVER retroactively to admit a
  label you have already been watching.
- **Terminal (D5):** at 100 closed `momentum-liquid` OOS trades, force a go/no-go and demote whatever has cleared.

