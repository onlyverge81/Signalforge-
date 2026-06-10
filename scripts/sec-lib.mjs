// SEC EDGAR XBRL helpers — server-side (Node).
//
// Ported VERBATIM from the browser app's former inline implementation so the
// TTM / quarter-over-quarter math is byte-for-byte identical. The whole reason
// these live here now is that a browser can't fetch data.sec.gov (CORS) and
// can't set a User-Agent — but a CI runner can. So the SEC work happens here,
// once a night, and the app just reads the resulting fundamentals.json.

const UA = process.env.SEC_USER_AGENT ||
  "SignalForge fundamentals builder (https://github.com/onlyverge81/signalforge-)";

// SEC asks for a descriptive User-Agent and ≤10 requests/second. We send the UA
// on every call; the build script paces the requests.
export async function secFetch(url){
  const r = await fetch(url, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if(!r.ok) throw new Error("HTTP "+r.status+" for "+url);
  return r;
}

let _secTickerMap = null;
export async function secCik(sym){
  if(!_secTickerMap){
    const r = await secFetch("https://www.sec.gov/files/company_tickers.json");
    _secTickerMap = await r.json();
  }
  for(const k in _secTickerMap){ if(String(_secTickerMap[k].ticker||"").toUpperCase()===sym) return String(_secTickerMap[k].cik_str).padStart(10,"0"); }
  return null;
}

export function secUnit(node){ return (node&&node.units)?(node.units[Object.keys(node.units)[0]]||[]):[]; }

// Optional `asOf` (ISO date) makes any read POINT-IN-TIME: entries whose period
// ends after `asOf` are dropped, so the value is what was knowable on that date.
// Omitting `asOf` is byte-identical to the original latest-value behavior.
function cutoff(asOf){ return asOf ? new Date(asOf).getTime() : Infinity; }

export function secDurations(node, asOf){ // duration (flow) entries with day-length
  const lim=cutoff(asOf);
  return secUnit(node).filter(e=>e.start&&e.end&&e.val!=null && new Date(e.end).getTime()<=lim)
    .map(e=>({val:e.val,start:e.start,end:e.end,days:Math.round((new Date(e.end)-new Date(e.start))/864e5)}));
}

// Trailing-twelve-month value from quarterly filings, the rolling way:
// TTM = last full year (10-K) + current fiscal YTD − prior-year same YTD.
// XBRL files the FY annual plus cumulative YTD periods; subtracting the
// year-ago YTD rolls the window forward to the latest quarter. Falls back to
// summing 4 quarters, then to the bare FY, so annual-only filers still work.
export function secTTM(node, asOf){
  const all=secDurations(node, asOf);
  if(!all.length) return null;
  const annual=all.filter(e=>e.days>=350&&e.days<=380).sort((a,b)=>new Date(b.end)-new Date(a.end));
  if(!annual.length){
    const q=all.filter(e=>e.days>=80&&e.days<=100).sort((a,b)=>new Date(b.end)-new Date(a.end));
    return q.length>=4 ? {val:q.slice(0,4).reduce((s,e)=>s+e.val,0),end:q[0].end,basis:"TTM"} : null;
  }
  const fy=annual[0];
  const latestEnd=all.reduce((m,e)=>new Date(e.end)>new Date(m)?e.end:m, fy.end);
  if(new Date(latestEnd)<=new Date(fy.end)) return {val:fy.val,end:fy.end,basis:"FY"}; // 10-K is newest
  // current fiscal YTD = the longest cumulative period ending at the latest date
  const ytdCur=all.filter(e=>e.end===latestEnd&&e.days<350).sort((a,b)=>b.days-a.days)[0];
  if(!ytdCur) return {val:fy.val,end:fy.end,basis:"FY"};
  const ytdPrior=all.filter(e=>Math.abs(e.days-ytdCur.days)<=12 && Math.abs(Math.round((new Date(ytdCur.end)-new Date(e.end))/864e5)-365)<=20)
                    .sort((a,b)=>new Date(b.end)-new Date(a.end))[0];
  if(!ytdPrior) return {val:fy.val,end:fy.end,basis:"FY"};
  return {val: fy.val + ytdCur.val - ytdPrior.val, end: ytdCur.end, basis:"TTM"};
}

// Most-recent quarter vs the same quarter a year earlier — the sharpest, most
// current growth read, straight off the latest 10-Q.
export function secQYoY(node, asOf){
  const q=secDurations(node, asOf).filter(e=>e.days>=80&&e.days<=100).sort((a,b)=>new Date(b.end)-new Date(a.end));
  if(!q.length) return null;
  const cur=q[0];
  const prior=q.find(e=>Math.abs(Math.round((new Date(cur.end)-new Date(e.end))/864e5)-365)<=25);
  return (prior&&prior.val!==0)?(cur.val-prior.val)/Math.abs(prior.val):null;
}

export function secInstant(node, asOf){ // latest point-in-time (balance-sheet) value
  const lim=cutoff(asOf);
  const arr=secUnit(node).filter(e=>e.end&&e.val!=null && new Date(e.end).getTime()<=lim);
  if(!arr.length) return null;
  arr.sort((a,b)=>new Date(b.end)-new Date(a.end));
  return arr[0].val;
}

export function secFirst(facts,names){ for(const n of names){ if(facts[n]) return facts[n]; } return null; }

// ─── Merit score (parity with the browser app's valueScore().total) ──────────
// The cross-sectional study ranks names by merit; the app DISPLAYS valueScore's
// grade. To keep CI ranking and the shown grade from drifting, this reproduces
// valueScore().total (index.html) thresholds EXACTLY. Returns −2..+14, or null
// when no fields are present. Guarded by sec-lib.test.mjs.
export function meritScore(m){
  if(!m) return null;
  const num=v=>(v==null||isNaN(v))?null:Number(v);
  const pe=num(m.peTTM), pb=num(m.pbAnnual), de=num(m["totalDebt/totalEquityAnnual"]);
  const roe=num(m.roeTTM), npm=num(m.netProfitMarginTTM), cr=num(m.currentRatioAnnual);
  const revG=num(m.revenueGrowthTTMYoy), epsG=num(m.epsGrowthTTMYoy);
  if(![pe,pb,de,roe,npm,cr,revG,epsG].some(v=>v!=null)) return null;
  let cheap=0, healthy=0, growing=0;
  if(pe!=null){ if(pe>0&&pe<15)cheap+=2; else if(pe>=15&&pe<25)cheap+=1; else if(pe>=25)cheap-=1; }
  if(pb!=null){ if(pb>0&&pb<1.5)cheap+=2; else if(pb>=1.5&&pb<3)cheap+=1; else if(pb>=5)cheap-=1; }
  if(de!=null){ if(de<0.5)healthy+=2; else if(de<1)healthy+=1; else if(de>2)healthy-=2; }
  if(roe!=null){ if(roe>0.15)healthy+=2; else if(roe>0.08)healthy+=1; else if(roe<0)healthy-=2; }
  if(npm!=null){ if(npm>0.20)healthy+=2; else if(npm>0.10)healthy+=1; else if(npm<0)healthy-=2; }
  if(cr!=null){ if(cr>1.5)healthy+=1; else if(cr<1)healthy-=1; }
  if(revG!=null){ if(revG>0.15)growing+=2; else if(revG>0.05)growing+=1; else if(revG<0)growing-=1; }
  if(epsG!=null){ if(epsG>0.15)growing+=2; else if(epsG>0)growing+=1; else if(epsG<0)growing-=1; }
  return cheap+healthy+growing;
}

// Build the browser-shaped metric object from a stored fundamentals rec + the
// price at the as-of date (P/E and P/B need a price; the rest are filed ratios).
export function meritMetrics(rec, price){
  if(!rec) return null;
  const m={};
  if(price>0 && rec.epsTTM!=null && rec.epsTTM!==0) m.peTTM=price/rec.epsTTM;
  if(price>0 && rec.bvps>0)  m.pbAnnual=price/rec.bvps;
  if(rec.de!=null)   m["totalDebt/totalEquityAnnual"]=rec.de;
  if(rec.roe!=null)  m.roeTTM=rec.roe;
  if(rec.npm!=null)  m.netProfitMarginTTM=rec.npm;
  if(rec.cr!=null)   m.currentRatioAnnual=rec.cr;
  if(rec.revG!=null) m.revenueGrowthTTMYoy=rec.revG;
  if(rec.epsG!=null) m.epsGrowthTTMYoy=rec.epsG;
  return Object.keys(m).length?m:null;
}
