---
name: run-signalforge
description: Build, launch, screenshot, and drive the SignalForge web app (index.html). Use when asked to run, start, open, render, screenshot, smoke-test, or interact with the SignalForge Live Trading Analyzer UI in a headless container.
---

# Run SignalForge

SignalForge is **one self-contained file** at the repo root, `index.html`: a React app
that is transpiled **in the browser** by `@babel/standalone`, with React / ReactDOM / Babel
pulled from the **unpkg CDN**. There is no build step and no `package.json` for the app.

In this container the CDN and the market-data APIs (`unpkg.com`, `api.polygon.io`,
`api.twelvedata.com`) are **blocked by the egress proxy (HTTP 403)**, and live data needs a
user-entered Polygon key anyway. So the driver:

- serves the **repo root** over local HTTP (so the app's `./*.json` sibling fetches resolve), and
- **intercepts the three unpkg `<script>` URLs** and fulfils them from local npm copies —
  `index.html` is never modified.

The app then mounts on its built-in **sample data** (live fetch stays dark), which is what
you render and drive.

> Paths below are relative to the **repo root** (`<unit>/`). The driver lives at
> `.claude/skills/run-signalforge/driver.mjs`.

## Prerequisites

A Playwright Chromium is already present at `/opt/pw-browsers` (`PLAYWRIGHT_BROWSERS_PATH`),
build **1194** — which is matched by **`playwright-core@1.56.0`** (pinned in this skill's
`package.json`). No `apt-get` is needed: Chromium launched headless with `--no-sandbox` and
no missing system libraries.

Install the skill's own deps once (Playwright driver + the vendored React/ReactDOM/Babel):

```bash
cd .claude/skills/run-signalforge && npm install
```

## Run (agent path) — the driver

```bash
node .claude/skills/run-signalforge/driver.mjs --ticker AAPL
```

What it does: launches the pre-installed Chromium, serves the repo, routes unpkg → local
libs, waits for `#root` to actually populate (Babel compiles *after* load, so navigation
finishing is not enough), types the ticker, and writes a screenshot. Flags:

- `--shot <path>` — screenshot output (default `.claude/skills/run-signalforge/signalforge.png`).
- `--ticker <SYM>` — type a symbol into the ticker box to exercise the real input handlers.

Expected output ends with:

```
title: SignalForge — Live Trading Analyzer
first text lines: ["SIGNALFORGEPRO TRADING ANALYZER", … "◈ SIGNALS","◎ OUTLOOK"]
RESULT: PASS — app mounted and rendered.
```

The screenshot shows the **LIVE** tab: data-provider toggle, Polygon key box, ticker
(your `--ticker` value), resolution/mode selectors, and **"✓ 36 companies loaded"** — that
last line proves `./fundamentals.json` was served from the repo root. Open the PNG to confirm
it is the real UI and not an error page.

## Run (human path)

Open `index.html` in a normal browser **with internet** (so unpkg + Polygon load) and paste a
Polygon REST key to fetch live data. Useless in this headless, egress-blocked container — use
the driver instead.

## Test (the research pipeline, not the app)

The `scripts/` engine has a real unit suite; run it to sanity-check engine/study changes:

```bash
node --test scripts/*.test.mjs
```

## Gotchas

- **CDN + market APIs are proxy-blocked (403).** The driver vendors React/ReactDOM/Babel
  locally and routes unpkg to them; live Polygon/TwelveData fetches cannot work here. The app
  is designed to degrade to sample data, so the UI still renders fully.
- **Playwright version must match the pre-installed browser build.** Chromium build **1194**
  ↔ `playwright-core@1.56.0`. Other versions resolve to a different build dir and die with
  `Executable doesn't exist at /opt/pw-browsers/chromium*-<NNNN>/...` (1.48 wanted 1223, 1.55
  wanted 1187). If `/opt/pw-browsers` is ever refreshed, re-pin: install candidates and pick
  the one whose `chromium.executablePath()` points at an existing dir.
- **Run headless Chromium with `--no-sandbox`** — the container runs as root and the sandbox
  refuses to start otherwise (the driver already passes it).
- **Wait for `#root` to have children, not for navigation.** `@babel/standalone` transpiles
  the inline `<script type="text/babel">` after the page loads, so there's a gap between
  "page loaded" and "React mounted." The driver polls `#root.children.length > 0`.
- **`ERR_CERT_AUTHORITY_INVALID` / `ERR_*` console errors are expected and non-fatal** — the
  egress proxy MITM-rejects the blocked hosts. `RESULT: PASS` is the real signal.
- **Serve from the repo root.** The app fetches `./fundamentals.json`, `./study.json`,
  `./pattern-study.json`, `./paper-ledger.json`, `./lag-report.json` relative to the page; if
  you serve any other directory they 404 and the data panels go empty.

## Troubleshooting

- `browserType.launch: Executable doesn't exist at /opt/pw-browsers/chromium_headless_shell-<NNNN>/…`
  → `playwright-core` version ≠ installed browser build. Re-pin to the version matching the
  `chromium-<NNNN>` dir under `/opt/pw-browsers` (1194 → `playwright-core@1.56.0`).
- `missing vendored lib: …/node_modules/react/umd/…` → run `npm install` in the skill dir.
- Timeout waiting for `#root` to populate, blank screenshot → the unpkg route didn't fire
  (vendored libs missing) or you served the wrong root; confirm `npm install` ran and the URL
  is the repo root.
