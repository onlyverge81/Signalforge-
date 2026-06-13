// Polygon WebSocket protocol — the live-streaming plumbing, as PURE helpers so the wire
// format is unit-tested off-line and the browser client in index.html mirrors exactly one
// source of truth. No socket is opened here; this only builds/parses messages.
//
// CHARTER NOTE: on Stocks Starter the live cluster is the DELAYED one (~15-min behind). The
// real-time cluster is a one-word config flip on a tier upgrade — we never fake real-time;
// wsFreshness() labels the band honestly so the badge tells the truth.

export const WS_CLUSTERS = {
  delayed:  "wss://delayed.socket.polygon.io/stocks", // Starter / Free — ~15-min delayed
  realtime: "wss://socket.polygon.io/stocks",         // Developer+ — flip here on upgrade
};

// Cluster URL for a mode; defaults to the honest (delayed) cluster for this plan.
export function wsClusterUrl(mode = "delayed"){
  return WS_CLUSTERS[mode] || WS_CLUSTERS.delayed;
}

// First frame after connect authenticates with the REST/WS key.
export function authMessage(key){
  return { action: "auth", params: String(key || "") };
}

// Subscribe/unsubscribe to a channel for one or more tickers, e.g. AM.AAPL,AM.TSLA.
// Channels: AM (per-minute aggregate), A (per-second), T (trades), Q (quotes).
export function subscribeMessage(channel, tickers){
  return { action: "subscribe", params: channelList(channel, tickers) };
}
export function unsubscribeMessage(channel, tickers){
  return { action: "unsubscribe", params: channelList(channel, tickers) };
}
function channelList(channel, tickers){
  return (Array.isArray(tickers) ? tickers : [tickers])
    .filter(Boolean).map(t => `${channel}.${t}`).join(",");
}

// Normalize one AM/A aggregate event to the app's candle shape (+ the bar's epoch window).
export function wsBar(ev){
  return {
    sym: ev.sym, ev: ev.ev,
    open: +ev.o, high: +ev.h, low: +ev.l, close: +ev.c, volume: +ev.v || 0,
    start: +ev.s, end: +ev.e,
    vwap: ev.vw != null ? +ev.vw : null,
  };
}

// Split a raw WS frame (array of events, or one event) into status messages and bars.
// Tolerant: bad JSON / non-arrays / unknown events are ignored, never thrown.
export function parseWsMessage(data){
  let arr;
  try { arr = typeof data === "string" ? JSON.parse(data) : data; } catch { return { status: [], bars: [] }; }
  if(!Array.isArray(arr)) arr = [arr];
  const status = [], bars = [];
  for(const ev of arr){
    if(!ev || !ev.ev) continue;
    if(ev.ev === "status") status.push({ status: ev.status, message: ev.message });
    else if(ev.ev === "AM" || ev.ev === "A") bars.push(wsBar(ev));
  }
  return { status, bars };
}

// True once Polygon confirms the key (so it's safe to send the subscribe frame).
export function isAuthSuccess(status){
  return !!status && (status.status === "auth_success" ||
    (status.status === "success" && /authenticated/i.test(status.message || "")));
}

// Freshness band from an aggregate's END time vs now. Starter delays ~15min, so a legitimately
// "live" streamed bar lands ~15min old — we label it DELAYED, never REALTIME. Mirrors the
// app's existing band vocabulary (REALTIME / DELAYED / STALE).
export function wsFreshness(endMs, nowMs = Date.now()){
  const stalenessSec = Math.max(0, Math.round((nowMs - endMs) / 1000));
  let band;
  if(stalenessSec <= 90) band = "REALTIME";
  else if(stalenessSec <= 20 * 60) band = "DELAYED"; // ~15-min delayed feed (Starter)
  else band = "STALE";
  return { band, stalenessSec };
}
