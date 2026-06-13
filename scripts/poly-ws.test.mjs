// Offline unit tests for the Polygon WebSocket protocol helpers — no socket opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  WS_CLUSTERS, wsClusterUrl, authMessage, subscribeMessage, unsubscribeMessage,
  wsBar, parseWsMessage, isAuthSuccess, wsFreshness,
} from "./poly-ws.mjs";

test("wsClusterUrl: defaults to the delayed cluster; realtime is the upgrade flip", () => {
  assert.equal(wsClusterUrl(), WS_CLUSTERS.delayed);
  assert.equal(wsClusterUrl("delayed"), "wss://delayed.socket.polygon.io/stocks");
  assert.equal(wsClusterUrl("realtime"), "wss://socket.polygon.io/stocks");
  assert.equal(wsClusterUrl("garbage"), WS_CLUSTERS.delayed); // never crash → safe default
});

test("auth/subscribe message framing matches Polygon's protocol", () => {
  assert.deepEqual(authMessage("KEY123"), { action: "auth", params: "KEY123" });
  assert.deepEqual(subscribeMessage("AM", ["AAPL", "TSLA"]), { action: "subscribe", params: "AM.AAPL,AM.TSLA" });
  assert.deepEqual(subscribeMessage("AM", "NVDA"), { action: "subscribe", params: "AM.NVDA" });
  assert.deepEqual(unsubscribeMessage("AM", ["AAPL"]), { action: "unsubscribe", params: "AM.AAPL" });
});

test("parseWsMessage: separates status frames from aggregate bars; tolerates junk", () => {
  const frame = JSON.stringify([
    { ev: "status", status: "auth_success", message: "authenticated" },
    { ev: "AM", sym: "AAPL", o: 100, h: 101, l: 99.5, c: 100.7, v: 12000, s: 1700000000000, e: 1700000060000, vw: 100.4 },
    { ev: "Q", sym: "AAPL" }, // unknown-to-us channel → ignored
  ]);
  const { status, bars } = parseWsMessage(frame);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, "auth_success");
  assert.equal(bars.length, 1);
  assert.deepEqual(bars[0], { sym: "AAPL", ev: "AM", open: 100, high: 101, low: 99.5, close: 100.7, volume: 12000, start: 1700000000000, end: 1700000060000, vwap: 100.4 });
  // junk never throws
  assert.deepEqual(parseWsMessage("not json"), { status: [], bars: [] });
  assert.deepEqual(parseWsMessage({ ev: "AM", sym: "X", o: 1, h: 1, l: 1, c: 1, v: 0, s: 1, e: 2 }).bars.length, 1);
});

test("isAuthSuccess: recognizes Polygon's auth confirmation", () => {
  assert.equal(isAuthSuccess({ status: "auth_success" }), true);
  assert.equal(isAuthSuccess({ status: "success", message: "authenticated" }), true);
  assert.equal(isAuthSuccess({ status: "connected" }), false);
  assert.equal(isAuthSuccess(null), false);
});

test("wsFreshness: a Starter stream lands ~15-min old → DELAYED, labeled honestly (never faked REALTIME)", () => {
  const now = 1700000000000;
  assert.equal(wsFreshness(now - 30 * 1000, now).band, "REALTIME");      // fresh tick
  assert.equal(wsFreshness(now - 15 * 60 * 1000, now).band, "DELAYED");  // the Starter reality
  assert.equal(wsFreshness(now - 60 * 60 * 1000, now).band, "STALE");    // an hour old
  assert.equal(wsFreshness(now - 15 * 60 * 1000, now).stalenessSec, 900);
});
