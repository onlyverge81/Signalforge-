// Offline unit tests for the contenders builder — no network.
// Pins the pure helpers: metric assembly, snapshot/financials parsing, the
// SEC↔Polygon cross-check, the technical verdict, record assembly, and ranking.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  metricMap, parseSnapshotPrices, parsePolygonFinancials, crossCheck,
  techVerdict, indexUniverse, buildContender, rankContenders,
  classifyWatch, rankWatchlist,
} from "./build-contenders.mjs";

const REC = { entity:"Apple Inc.", asof:"2026-03-28", epsTTM:8.26, bvps:7.25, de:0.78, roe:1.15, npm:0.27, cr:1.07, revG:0.17, epsG:0.22 };

test("metricMap: derives P/E & P/B from price ÷ filed EPS/BVPS", () => {
  const m = metricMap(REC, 200);
  assert.equal(m.peTTM, +(200/8.26).toFixed(4));
  assert.equal(m.pbAnnual, +(200/7.25).toFixed(4));
  assert.equal(m["totalDebt/totalEquityAnnual"], 0.78);
  assert.equal(m.roeTTM, 1.15);
});

test("metricMap: no positive P/E when EPS ≤ 0 or price missing", () => {
  assert.equal(metricMap({ epsTTM:-1, bvps:5 }, 100).peTTM, undefined);
  assert.equal(metricMap({ epsTTM:8, bvps:5 }, 0).peTTM, undefined);
});

test("parseSnapshotPrices: prefers last trade, falls back to day/prev close", () => {
  const j = { tickers:[
    { ticker:"AAPL", lastTrade:{ p:201.5 }, day:{ c:200 }, prevDay:{ c:199 } },
    { ticker:"MSFT", day:{ c:0 }, prevDay:{ c:410.2 } },   // pre-open: day.c is 0
    { ticker:"NUL", day:{ c:0 }, prevDay:{ c:0 } },         // no usable price → dropped
  ]};
  const p = parseSnapshotPrices(j);
  assert.equal(p.AAPL, 201.5);
  assert.equal(p.MSFT, 410.2);
  assert.equal(p.NUL, undefined);
});

test("parseSnapshotPrices: tolerates a malformed payload", () => {
  assert.deepEqual(parseSnapshotPrices(null), {});
  assert.deepEqual(parseSnapshotPrices({ status:"ERROR" }), {});
});

test("parsePolygonFinancials: pulls the latest filing's provenance + equity", () => {
  const j = { results:[{
    filing_date:"2026-05-01", end_date:"2026-03-28", fiscal_period:"Q2", fiscal_year:"2026",
    financials:{ balance_sheet:{ equity:{ value:74100000000 } } },
  }]};
  const f = parsePolygonFinancials(j);
  assert.equal(f.filingDate, "2026-05-01");
  assert.equal(f.fiscalPeriod, "Q2");
  assert.equal(f.equity, 74100000000);
  assert.equal(parsePolygonFinancials({ results:[] }), null);
});

test("crossCheck: aligned reporting periods pass; far-apart ones flag", () => {
  const ok = crossCheck(REC, { endDate:"2026-03-28", filingDate:"2026-05-01" });
  assert.equal(ok.ok, true);
  assert.equal(ok.checked, true);
  const stale = crossCheck(REC, { endDate:"2025-06-30", filingDate:"2025-08-01" });
  assert.equal(stale.ok, false);
  assert.ok(stale.gapDays > 120);
});

test("crossCheck: no filing → passes but marks itself unchecked", () => {
  const r = crossCheck(REC, null);
  assert.equal(r.ok, true);
  assert.equal(r.checked, false);
});

test("techVerdict: passes on a positive pattern edge alone (no signal study)", () => {
  const t = techVerdict(undefined, { edge:0.007, winRate:0.68 });
  assert.equal(t.pass, true);
  assert.equal(t.patternEdge, 0.007);
  assert.equal(t.trendPF, null);
});

test("techVerdict: negative edge & no signal study → fails", () => {
  assert.equal(techVerdict(null, { edge:-0.01 }).pass, false);
});

test("techVerdict: trend profit-factor ≥ 1 rescues a flat pattern", () => {
  const t = techVerdict({ trendHold:{ profitFactor:1.3, expectancy:0.2 } }, { edge:-0.01 });
  assert.equal(t.pass, true);
  assert.equal(t.trendPF, 1.3);
});

test("indexUniverse: maps universe[] by uppercase symbol", () => {
  const m = indexUniverse({ universe:[{ sym:"aapl", edge:0.01 }, { sym:"MSFT", edge:0.02 }] });
  assert.equal(m.AAPL.edge, 0.01);
  assert.equal(m.MSFT.edge, 0.02);
  assert.deepEqual(indexUniverse(null), {});
});

test("buildContender: A/B name clearing all three boxes is flagged allBoxes", () => {
  // Cheap price + strong fundamentals → grade A/B; positive edge; aligned filing.
  const c = buildContender({
    sym:"AAPL", rec:REC, price:60,
    patternRow:{ edge:0.007, winRate:0.68 }, signalRow:null,
    fin:{ filingDate:"2026-05-01", endDate:"2026-03-28", fiscalPeriod:"Q2", fiscalYear:"2026", equity:74e9 },
    now:new Date("2026-06-01"),
  });
  assert.ok(c.grade === "A" || c.grade === "B");
  assert.equal(c.tech.pass, true);
  assert.equal(c.crossCheck.ok, true);
  assert.equal(c.allBoxes, true);
  assert.equal(c.filing.daysAgo, 31);
  assert.ok(c.reasons.length > 0);
});

test("buildContender: positive grade but negative edge fails the technical box", () => {
  const c = buildContender({ sym:"AAPL", rec:REC, price:60, patternRow:{ edge:-0.02 }, fin:null });
  assert.ok(c.grade === "A" || c.grade === "B");
  assert.equal(c.tech.pass, false);
  assert.equal(c.allBoxes, false);
});

test("rankContenders: drops non-A/B, orders all-boxes then total then symbol", () => {
  const list = [
    { sym:"C1", grade:"C", total:5, allBoxes:false },
    { sym:"B1", grade:"B", total:7, allBoxes:false },
    { sym:"A2", grade:"A", total:8, allBoxes:true },
    { sym:"A1", grade:"A", total:12, allBoxes:true },
  ];
  const r = rankContenders(list);
  assert.deepEqual(r.map(c => c.sym), ["A1", "A2", "B1"]); // C1 dropped; all-boxes first, then total
});

test("classifyWatch: tags the C-grade upside angles", () => {
  assert.deepEqual(classifyWatch({ total:5, cheap:1, growing:1, tech:{ pass:false } }), ["borderline"]);
  assert.deepEqual(classifyWatch({ total:2, cheap:4, growing:0, tech:{ pass:true } }), ["techEdge", "deepValue"]);
  assert.deepEqual(classifyWatch({ total:3, cheap:0, growing:3, tech:{ pass:false } }), ["highGrowth"]);
  assert.deepEqual(classifyWatch({ total:2, cheap:1, growing:1, tech:{ pass:false } }), []);
});

test("rankWatchlist: only C-grade, tagged float above plain, attaches watchTags", () => {
  const list = [
    { sym:"A1", grade:"A", total:12, cheap:4, growing:4, tech:{ pass:true } }, // excluded
    { sym:"PLAIN", grade:"C", total:2, cheap:0, growing:0, tech:{ pass:false } },
    { sym:"GEM", grade:"C", total:5, cheap:1, growing:1, tech:{ pass:true } },  // borderline + techEdge
    { sym:"D1", grade:"D", total:-3, cheap:0, growing:0, tech:{ pass:false } }, // excluded
  ];
  const r = rankWatchlist(list);
  assert.deepEqual(r.map(c => c.sym), ["GEM", "PLAIN"]);
  assert.deepEqual(r[0].watchTags, ["borderline", "techEdge"]);
  assert.deepEqual(r[1].watchTags, []);
});
