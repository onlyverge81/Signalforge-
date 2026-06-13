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
  round-trip cost). Long-only + wide-stop is the only non-losing variant, and it is *not yet
  significant* (t ≈ 1.5) — i.e. "not losing," not "proven."
- **Out-of-sample (`forward-perf.json`):** ledger is new; trades still maturing. The honest
  verdict is **"not enough evidence,"** never "loser." Don't read a verdict from 0 closed trades.
- **No proven alpha anywhere yet:** merit IC ≈ 0.03 (NOT SIGNIFICANT); pattern edge ≈ −0.70%
  vs baseline (its win rate is market beta, not skill).

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

## Commands

- Tests: `node --test scripts/*.test.mjs` (currently 111, keep green).
- Studies (need `POLYGON_API_KEY`): `node scripts/signal-study.mjs`, `pattern-study.mjs`,
  `build-fundamentals.mjs` → `build-study.mjs`.
- Forward pipeline (nightly CI): `forward-log.mjs` → `forward-perf.mjs` → `promote.mjs`.

## Active task

The driving task is the **"Wheel of Problem-Solving"** profitability analysis (four logic
quadrants → synthesis → action plan). Track A (long-only default, cost gate, honest verdict
surface) is shipped; remaining: this CLAUDE.md, then **Track B** — hunt a real edge via deeper
Polygon (survivorship-free universe, total-return benchmark, intraday search), every candidate
clearing no-lookahead + OOS t≥2 after FDR before it's ever shown as tradeable.
