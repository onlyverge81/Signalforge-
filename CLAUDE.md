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
