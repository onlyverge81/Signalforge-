// SignalForge — SEC EDGAR CORS proxy (Cloudflare Worker)
//
// Why this exists:
//   SignalForge pulls fundamentals straight from SEC EDGAR's primary filings.
//   Some browsers can't call data.sec.gov directly (CORS), and browsers can't
//   set the User-Agent header SEC's fair-access policy asks for. This Worker
//   fetches SEC server-side, sets a proper User-Agent, and returns the response
//   with permissive CORS headers so the static app can read it.
//
// Safety:
//   It is NOT an open proxy. It only forwards GET requests to data.sec.gov and
//   www.sec.gov over HTTPS — nothing else. Responses are cached for an hour.
//
// Usage from the app:
//   GET https://<your-worker>.workers.dev/?url=<encoded SEC url>
//   e.g. ?url=https%3A%2F%2Fdata.sec.gov%2Fapi%2Fxbrl%2Fcompanyfacts%2FCIK0000320193.json

const ALLOW = new Set(["data.sec.gov", "www.sec.gov"]);

// ⚠️ SEC asks that the User-Agent identify you with a contact. Edit this.
const USER_AGENT = "SignalForge/1.0 (contact: you@example.com)";

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return cors(new Response(null, { status: 204 }));
    if (request.method !== "GET") return cors(new Response("Only GET", { status: 405 }));

    const target = new URL(request.url).searchParams.get("url");
    if (!target) return cors(new Response("Missing ?url=", { status: 400 }));

    let t;
    try { t = new URL(target); } catch { return cors(new Response("Malformed url", { status: 400 })); }
    if (t.protocol !== "https:" || !ALLOW.has(t.hostname)) {
      return cors(new Response("Host not allowed: " + t.hostname, { status: 403 }));
    }

    let upstream;
    try {
      upstream = await fetch(t.toString(), {
        headers: { "User-Agent": USER_AGENT, "Accept": "application/json" },
        cf: { cacheTtl: 3600, cacheEverything: true },
      });
    } catch (e) {
      return cors(new Response("Upstream fetch failed: " + (e && e.message), { status: 502 }));
    }

    const body = await upstream.arrayBuffer();
    const resp = new Response(body, {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json" },
    });
    return cors(resp);
  },
};

function cors(resp) {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  resp.headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  resp.headers.set("Access-Control-Allow-Headers", "*");
  resp.headers.set("Cache-Control", "public, max-age=3600");
  return resp;
}
