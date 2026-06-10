// Offline unit tests for the SEC math — no network. Run: node --test scripts/
import { test } from "node:test";
import assert from "node:assert/strict";
import { secTTM, secQYoY, secInstant, secFirst } from "./sec-lib.mjs";
import { distill, readTickers } from "./build-fundamentals.mjs";

// Helper: wrap a flat array of XBRL entries as a unit node (USD by default).
const node = (arr, unit="USD") => ({ units: { [unit]: arr } });

test("secTTM rolls the window: FY + current YTD − prior-year YTD", () => {
  const n = node([
    { start:"2023-01-01", end:"2023-12-31", val:100 }, // FY2023 (364d)
    { start:"2024-01-01", end:"2024-09-30", val:90 },  // YTD 2024 (~273d)
    { start:"2023-01-01", end:"2023-09-30", val:70 },  // YTD 2023 (~273d)
  ]);
  const r = secTTM(n);
  assert.equal(r.basis, "TTM");
  assert.equal(r.end, "2024-09-30");
  assert.equal(r.val, 120); // 100 + 90 − 70
});

test("secTTM falls back to the bare FY when the 10-K is the newest period", () => {
  const n = node([{ start:"2023-01-01", end:"2023-12-31", val:250 }]);
  const r = secTTM(n);
  assert.equal(r.basis, "FY");
  assert.equal(r.val, 250);
});

test("secTTM sums 4 quarters when there is no annual period", () => {
  const n = node([
    { start:"2024-07-01", end:"2024-09-30", val:10 },
    { start:"2024-04-01", end:"2024-06-30", val:12 },
    { start:"2024-01-01", end:"2024-03-31", val:11 },
    { start:"2023-10-01", end:"2023-12-31", val:9 },
  ]);
  const r = secTTM(n);
  assert.equal(r.basis, "TTM");
  assert.equal(r.val, 42);
  assert.equal(r.end, "2024-09-30");
});

test("secQYoY compares the latest quarter to the year-ago quarter", () => {
  const n = node([
    { start:"2024-07-01", end:"2024-09-30", val:50 }, // latest Q
    { start:"2023-07-01", end:"2023-09-30", val:40 }, // year-ago Q
  ]);
  assert.equal(secQYoY(n), (50 - 40) / 40); // +0.25
});

test("secInstant returns the most recent point-in-time value", () => {
  const n = node([
    { end:"2023-09-30", val:400 },
    { end:"2024-09-30", val:500 },
  ]);
  assert.equal(secInstant(n), 500);
});

test("secFirst returns the first present tag", () => {
  const facts = { Revenues: { units:{} } };
  assert.equal(secFirst(facts, ["SalesRevenueNet","Revenues"]), facts.Revenues);
  assert.equal(secFirst(facts, ["Nope"]), null);
});

test("distill emits price-independent fields the app expects", () => {
  // Minimal synthetic companyfacts with the tags distill reads.
  const dur = (start,end,val) => ({ start, end, val });
  const inst = (end,val) => ({ end, val });
  const j = {
    entityName: "Test Co",
    facts: {
      "us-gaap": {
        EarningsPerShareDiluted: { units:{ "USD/shares":[ dur("2023-01-01","2023-12-31",6), dur("2024-01-01","2024-09-30",5), dur("2023-01-01","2023-09-30",4) ] } },
        NetIncomeLoss:          { units:{ "USD":[ dur("2023-01-01","2023-12-31",1000), dur("2024-01-01","2024-09-30",900), dur("2023-01-01","2023-09-30",700) ] } },
        Revenues:               { units:{ "USD":[ dur("2023-01-01","2023-12-31",5000), dur("2024-01-01","2024-09-30",4500), dur("2023-01-01","2023-09-30",4000), dur("2024-07-01","2024-09-30",1600), dur("2023-07-01","2023-09-30",1400) ] } },
        StockholdersEquity:     { units:{ "USD":[ inst("2024-09-30",4000) ] } },
        AssetsCurrent:          { units:{ "USD":[ inst("2024-09-30",3000) ] } },
        LiabilitiesCurrent:     { units:{ "USD":[ inst("2024-09-30",1500) ] } },
        LongTermDebt:           { units:{ "USD":[ inst("2024-09-30",2000) ] } },
      },
      "dei": {
        EntityCommonStockSharesOutstanding: { units:{ "shares":[ inst("2024-09-30",1000) ] } },
      },
    },
  };
  const { rec, asof, basis } = distill(j);
  assert.equal(basis, "TTM");
  assert.equal(asof, "2024-09-30");
  // epsTTM = 6 + 5 − 4 = 7
  assert.equal(rec.epsTTM, 7);
  // bvps = equity/shares = 4000/1000 = 4
  assert.equal(rec.bvps, 4);
  // de = debt/equity = 2000/4000 = 0.5
  assert.equal(rec.de, 0.5);
  // niTTM = 1000 + 900 − 700 = 1200; revTTM = 5000 + 4500 − 4000 = 5500
  assert.equal(rec.roe, +(1200/4000).toFixed(6)); // 0.3
  assert.equal(rec.npm, +(1200/5500).toFixed(6));
  // cr = 3000/1500 = 2
  assert.equal(rec.cr, 2);
  // P/E and P/B must NOT be precomputed (they need the live price)
  assert.equal(rec.peTTM, undefined);
  assert.equal(rec.pbAnnual, undefined);
});

test("readTickers strips comments and blanks", () => {
  const tmp = new URL("./tickers.txt", import.meta.url);
  const list = readTickers(tmp.pathname);
  assert.ok(list.includes("AAPL"));
  assert.ok(list.includes("CMCSA"));
  assert.ok(!list.some(t => t.startsWith("#")));
  assert.ok(!list.includes(""));
});
