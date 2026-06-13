// SignalForge web-app driver — launch, render, interact, screenshot.
//
// SignalForge is ONE self-contained file (../../../index.html): a React app transpiled in
// the browser by @babel/standalone, with React/ReactDOM/Babel loaded from the unpkg CDN.
// In this container the CDN (and the Polygon/TwelveData APIs) are blocked by the egress
// proxy (HTTP 403), so:
//   • we serve the repo root over local HTTP (so the app's ./*.json fetches resolve), and
//   • we intercept the three unpkg <script> URLs and fulfill them from local npm copies
//     (node_modules here) — index.html itself is NEVER modified.
// Live market data still needs a user-entered Polygon key and is proxy-blocked anyway; the
// app degrades to its built-in sample data, which is what we screenshot/drive.
//
// Usage:  node driver.mjs [--shot out.png] [--ticker AAPL]
// Exit 0 = app mounted and rendered; non-zero = it did not.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../../..");            // <unit> = repo root
const NM   = path.join(HERE, "node_modules");
const arg  = (f, d) => { const i = process.argv.indexOf(f); return i > -1 ? process.argv[i + 1] : d; };
const SHOT = path.resolve(arg("--shot", path.join(HERE, "signalforge.png")));
const TICKER = arg("--ticker", "");

// unpkg URL → local vendored file (installed via this skill's package.json).
const VENDOR = {
  "react@18/umd/react.production.min.js":           path.join(NM, "react/umd/react.production.min.js"),
  "react-dom@18/umd/react-dom.production.min.js":   path.join(NM, "react-dom/umd/react-dom.production.min.js"),
  "@babel/standalone/babel.min.js":                 path.join(NM, "@babel/standalone/babel.min.js"),
};
for (const p of Object.values(VENDOR))
  if (!fs.existsSync(p)) { console.error("missing vendored lib:", p, "\n→ run `npm install` in", HERE); process.exit(2); }

const MIME = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };

// Static server rooted at the repo so index.html and its sibling ./*.json load normally.
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
  const file = path.join(REPO, rel);
  if (!file.startsWith(REPO) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});

const port = await new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port)));
const base = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

const errors = [];
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", e => errors.push("pageerror: " + e.message));

// Fulfill the blocked CDN scripts from local copies; let everything else through.
await page.route("**/unpkg.com/**", route => {
  const u = route.request().url();
  const hit = Object.keys(VENDOR).find(k => u.includes(k));
  if (hit) return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(VENDOR[hit]) });
  return route.fulfill({ status: 404, body: "" });
});

let exitCode = 0;
try {
  await page.goto(base, { waitUntil: "networkidle", timeout: 30000 });
  // The app has mounted once #root has real children (Babel transpile + React render).
  await page.waitForFunction(() => {
    const r = document.getElementById("root");
    return r && r.children.length > 0 && r.innerText.trim().length > 20;
  }, { timeout: 30000 });

  const title = await page.title();
  const heading = (await page.innerText("body")).split("\n").map(s => s.trim()).filter(Boolean).slice(0, 6);
  console.log("title:", title);
  console.log("first text lines:", JSON.stringify(heading));

  // Optional interaction: type a ticker into the symbol box (live fetch is proxy-blocked,
  // but this exercises the real input/handlers and proves the UI is interactive).
  if (TICKER) {
    const box = page.locator('input[type="text"], input:not([type])').first();
    await box.fill(TICKER);
    console.log("typed ticker:", await box.inputValue());
  }

  await page.screenshot({ path: SHOT, fullPage: false });
  console.log("screenshot:", SHOT);
  if (errors.length) console.log("console errors (non-fatal, expected for blocked CDN/API):", errors.slice(0, 5));
  console.log("RESULT: PASS — app mounted and rendered.");
} catch (e) {
  exitCode = 1;
  console.error("RESULT: FAIL —", e.message.split("\n")[0]);
  try { await page.screenshot({ path: SHOT }); console.error("failure screenshot:", SHOT); } catch {}
  console.error("console errors:", errors.slice(0, 10));
} finally {
  await browser.close();
  server.close();
}
process.exit(exitCode);
