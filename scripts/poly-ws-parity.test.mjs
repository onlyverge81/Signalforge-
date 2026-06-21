// Parity guard: index.html's inline PolyLiveSocket ↔ scripts/poly-ws.mjs.
// Run: node --test scripts/
//
// The browser client (class PolyLiveSocket + wsBand in index.html) and the unit-tested
// protocol module (poly-ws.mjs) are SEPARATE copies — they share no code, so they can
// silently drift. This test extracts the live-socket block out of index.html, runs it in
// a vm sandbox behind a mock WebSocket, drives the real auth→subscribe→bar lifecycle, and
// asserts every wire frame / parsed bar / freshness band equals what poly-ws.mjs produces.
// If you change one side and not the other, a case here goes red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import {
  authMessage, subscribeMessage, wsBar, parseWsMessage, wsFreshness, WS_CLUSTERS, wsClusterUrl,
} from "./poly-ws.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, "..", "index.html"), "utf8");

// ─── Extract the inline block: POLY_WS_CLUSTERS + wsBand + class PolyLiveSocket ──
const START = "const POLY_WS_CLUSTERS=";
const END = "// Stock OHLC bars";
const i0 = html.indexOf(START), i1 = html.indexOf(END);
assert.ok(i0 > 0 && i1 > i0, "could not locate the PolyLiveSocket block in index.html");
const SRC = html.slice(i0, i1);

// Freeze "now" so wsBand (which reads Date.now() internally) and wsFreshness(end, now)
// compare with zero clock skew — exact stalenessSec + band parity, boundaries included.
const FIXED_NOW = 1_700_000_000_000;

// Spin up an isolated sandbox running the extracted browser code behind a mock socket.
function makeSandbox(){
  const sent = [];
  let last = null;
  class MockWebSocket {
    constructor(url){ this.url = url; this.onopen = this.onmessage = this.onclose = this.onerror = null; last = this; }
    send(s){ sent.push(s); }
    close(){ this._closed = true; }
  }
  const ctx = {
    WebSocket: MockWebSocket,
    setTimeout: () => 0,            // reconnect timer is never exercised here
    Date: { now: () => FIXED_NOW }, // wsBand reads this; nothing else needs Date
    JSON, console,
  };
  vm.createContext(ctx);
  vm.runInContext(
    SRC + "\nglobalThis.__PLS=PolyLiveSocket; globalThis.__wsBand=wsBand; globalThis.__clusters=POLY_WS_CLUSTERS;",
    ctx,
  );
  return { PolyLiveSocket: ctx.__PLS, wsBand: ctx.__wsBand, clusters: ctx.__clusters, sent, inst: () => last };
}

// Connect a socket and return the mock + collected callbacks.
function connect(opts){
  const box = makeSandbox();
  const bars = [], statuses = [];
  const sock = new box.PolyLiveSocket({
    onBar: b => bars.push(b), onStatus: s => statuses.push(s), ...opts,
  });
  sock.connect();
  return { box, sock, ws: box.inst(), bars, statuses, sent: box.sent };
}
const frame = (events) => ({ data: JSON.stringify(events) });
// Sandbox-origin objects carry the vm realm's prototypes, so deepStrictEqual would reject
// them as "not reference-equal" vs node-realm expectations. Normalize to plain values first.
const plain = (x) => JSON.parse(JSON.stringify(x));

// ─── 1) Cluster map parity ──────────────────────────────────────────────────
test("parity: the app's POLY_WS_CLUSTERS equals poly-ws.mjs WS_CLUSTERS (delayed default)", () => {
  const { clusters } = makeSandbox();
  assert.deepEqual(plain(clusters), WS_CLUSTERS);
  assert.equal(clusters.delayed, wsClusterUrl("delayed"));
  assert.equal(clusters.realtime, wsClusterUrl("realtime"));
  // Default + unknown mode both resolve to the honest (delayed) cluster, matching wsClusterUrl.
  const s = makeSandbox();
  assert.equal(new s.PolyLiveSocket({ tickers: ["X"] }).url, wsClusterUrl("delayed"));
  assert.equal(new s.PolyLiveSocket({ tickers: ["X"], mode: "bogus" }).url, wsClusterUrl("bogus"));
  assert.equal(new s.PolyLiveSocket({ tickers: ["X"], mode: "realtime" }).url, wsClusterUrl("realtime"));
});

// ─── 2) Auth frame parity ─────────────────────────────────────────────────────
test("parity: on open the app sends exactly authMessage(key)", () => {
  const { ws, sent } = connect({ key: "SECRET", tickers: ["AAPL"] });
  ws.onopen();
  assert.equal(sent[0], JSON.stringify(authMessage("SECRET")));
});

// ─── 3) Subscribe frame parity (only after a real auth_success) ───────────────
test("parity: after auth_success the app subscribes exactly subscribeMessage(channel, tickers)", () => {
  const { ws, sent } = connect({ key: "K", tickers: ["AAPL", "TSLA"], channel: "AM" });
  ws.onopen();
  ws.onmessage(frame([{ ev: "status", status: "auth_success", message: "authenticated" }]));
  assert.equal(sent[1], JSON.stringify(subscribeMessage("AM", ["AAPL", "TSLA"])));
});

test("parity: isAuthSuccess gating matches — 'success'+authenticated subscribes, other statuses don't", () => {
  // The success/authenticated variant must also trigger subscribe (mirrors isAuthSuccess()).
  const a = connect({ key: "K", tickers: ["SPY"], channel: "A" });
  a.ws.onopen();
  a.ws.onmessage(frame([{ ev: "status", status: "success", message: "authenticated" }]));
  assert.equal(a.sent[1], JSON.stringify(subscribeMessage("A", ["SPY"])));
  // A non-auth status must NOT subscribe (only the auth frame was sent).
  const b = connect({ key: "K", tickers: ["SPY"], channel: "AM" });
  b.ws.onopen();
  b.ws.onmessage(frame([{ ev: "status", status: "connected", message: "Connected Successfully" }]));
  assert.equal(b.sent.length, 1);
});

// ─── 4) Bar parsing parity (the app's onBar == parseWsMessage(frame).bars) ────
test("parity: streamed AM/A events parse to the same candles as parseWsMessage/wsBar", () => {
  const { ws, bars } = connect({ key: "K", tickers: ["AAPL"] });
  ws.onopen();
  ws.onmessage(frame([{ ev: "status", status: "auth_success", message: "authenticated" }]));
  const events = [
    { ev: "AM", sym: "AAPL", o: "1", h: "2", l: "0.5", c: "1.5", v: "1000", s: 1000, e: 61000, vw: "1.2" },
    { ev: "A",  sym: "TSLA", o: "9", h: "9.4", l: "8.8", c: "9.1", v: "5", s: 2000, e: 2999, vw: null },
    { ev: "AM", sym: "MSFT", o: "3", h: "3", l: "3", c: "3", s: 5000, e: 65000 }, // no v/vw → 0 / null
  ];
  ws.onmessage(frame(events));
  assert.deepEqual(plain(bars), parseWsMessage(JSON.stringify(events)).bars);
  assert.deepEqual(plain(bars), events.map(wsBar));
});

test("parity: mixed frame (status + bars + junk) yields the same bars; bad JSON is swallowed", () => {
  const { ws, bars } = connect({ key: "K", tickers: ["AAPL"] });
  ws.onopen();
  const mixed = [
    { ev: "status", status: "auth_success", message: "authenticated" },
    { ev: "AM", sym: "AAPL", o: "1", h: "2", l: "0.5", c: "1.5", v: "1000", s: 1000, e: 61000, vw: "1.2" },
    { ev: "T", sym: "AAPL", p: "1.5" },   // trade event → ignored by both
    { foo: "bar" },                        // no .ev → ignored
    null,                                  // → ignored
  ];
  ws.onmessage(frame(mixed));
  assert.deepEqual(plain(bars), parseWsMessage(JSON.stringify(mixed)).bars);
  // Malformed JSON must not throw and must produce no bars (tolerant, like parseWsMessage).
  const before = bars.length;
  assert.doesNotThrow(() => ws.onmessage({ data: "{not json" }));
  assert.equal(bars.length, before);
  // A single (non-array) event object is accepted too.
  ws.onmessage({ data: JSON.stringify({ ev: "AM", sym: "NVDA", o: "1", h: "1", l: "1", c: "1", s: 1, e: 2 }) });
  assert.deepEqual(plain(bars[bars.length - 1]), wsBar({ ev: "AM", sym: "NVDA", o: "1", h: "1", l: "1", c: "1", s: 1, e: 2 }));
});

// ─── 5) Freshness band parity (wsBand ↔ wsFreshness), boundaries included ─────
test("parity: wsBand equals wsFreshness across REALTIME/DELAYED/STALE incl. boundaries", () => {
  const { wsBand } = makeSandbox();
  for (const ageSec of [0, 30, 89, 90, 91, 600, 1199, 1200, 1201, 3600]) {
    const end = FIXED_NOW - ageSec * 1000;
    assert.deepEqual(plain(wsBand(end)), wsFreshness(end, FIXED_NOW), `age=${ageSec}s`);
  }
});
