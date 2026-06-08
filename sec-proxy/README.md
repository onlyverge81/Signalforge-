# SEC EDGAR CORS proxy

A tiny [Cloudflare Worker](https://workers.cloudflare.com/) that lets SignalForge
read fundamentals straight from **SEC EDGAR** (the companies' own 10-K/10-Q
filings) from any browser.

## Why it's needed

SignalForge is a static, client-side app. Two things can stop a browser from
calling SEC directly:

1. **CORS** — `data.sec.gov` may not send the `Access-Control-Allow-Origin`
   header the browser requires, so the `fetch` is blocked.
2. **User-Agent** — SEC's [fair-access policy](https://www.sec.gov/os/webmaster-faq#developers)
   asks every request to identify itself with a User-Agent, but browsers are not
   allowed to set that header.

This Worker fetches SEC **server-side** (where both problems disappear), sets a
proper User-Agent, and returns the response with permissive CORS headers.

## Safety

It is **not** an open proxy. It only forwards HTTPS `GET` requests to
`data.sec.gov` and `www.sec.gov` — anything else returns `403`. Responses are
cached for an hour.

## Deploy (≈2 minutes, free tier is plenty)

```bash
npm install -g wrangler      # Cloudflare's CLI
wrangler login               # opens a browser to authorize
cd sec-proxy
wrangler deploy
```

Wrangler prints a URL like `https://sec-proxy.<your-name>.workers.dev`.

> **Edit the User-Agent first.** Open `worker.js` and change `USER_AGENT` to
> include a real contact (e.g. your email), as SEC requests.

## Connect it to the app

1. Open SignalForge → **LIVE** tab.
2. Paste the Worker URL into **"SEC EDGAR PROXY URL — optional"**.
   It's saved in your browser (`localStorage`), not in the repo.
3. Enter a US ticker (e.g. `AAPL`) and hit **Fetch Live Data**. The **VALUE** tab
   auto-fills from SEC EDGAR (trailing-twelve-month figures), every number
   linking back to the filing.

Leave the field blank to fetch SEC directly — use the proxy only if your browser
hits a CORS error.

> Using a **custom domain** instead of `*.workers.dev`? Add it to the
> `connect-src` directive of the CSP `<meta>` tag in `index.html`.

## Quick self-test

```bash
# Should return Apple's company facts JSON, with an Access-Control-Allow-Origin header:
curl -i "https://sec-proxy.<your-name>.workers.dev/?url=https://data.sec.gov/api/xbrl/companyfacts/CIK0000320193.json" | head

# Should return 403 (host not allowed):
curl -i "https://sec-proxy.<your-name>.workers.dev/?url=https://example.com/" | head
```
