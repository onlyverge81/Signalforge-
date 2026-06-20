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
