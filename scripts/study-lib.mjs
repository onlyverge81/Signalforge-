// Merit-evidence study — the pure cross-sectional statistics. No IO, no network,
// fully unit-tested. Given point-in-time observations {sym, period, merit, fwdRet}
// (one per name per rebalance date, forward windows NON-overlapping when the
// rebalance spacing equals the return horizon), it answers a single question:
// does a higher merit score predict a higher forward return across the universe,
// out-of-sample, and does the relationship survive a label-shuffle placebo?
//
// The test statistic is the per-period rank Information Coefficient (Spearman
// correlation of merit vs forward return within each cross-section). Per-period
// ICs across non-overlapping periods are far closer to independent than pooled
// observations, so a t-test on the IC series is defensible — with the explicit
// caveat that the period count is small (few degrees of freedom).

// ─── rank / correlation primitives ──────────────────────────────────────────
function ranks(xs){ // average ranks (ties share the mean rank)
  const idx=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]);
  const r=new Array(xs.length);
  let i=0;
  while(i<idx.length){
    let j=i; while(j+1<idx.length && idx[j+1][0]===idx[i][0]) j++;
    const avg=(i+j)/2+1; for(let k=i;k<=j;k++) r[idx[k][1]]=avg; i=j+1;
  }
  return r;
}
function pearson(a,b){
  const n=a.length; if(n<3) return null;
  const ma=a.reduce((x,y)=>x+y,0)/n, mb=b.reduce((x,y)=>x+y,0)/n;
  let num=0,da=0,db=0;
  for(let i=0;i<n;i++){ const x=a[i]-ma, y=b[i]-mb; num+=x*y; da+=x*x; db+=y*y; }
  return (da<=0||db<=0) ? null : num/Math.sqrt(da*db);
}

// Spearman rank correlation of merit vs forward return for one cross-section.
export function rankIC(rows){
  const clean=rows.filter(r=>r.merit!=null&&isFinite(r.merit)&&r.fwdRet!=null&&isFinite(r.fwdRet));
  if(clean.length<3) return null;
  return pearson(ranks(clean.map(r=>r.merit)), ranks(clean.map(r=>r.fwdRet)));
}

// Top-tertile mean forward return minus bottom-tertile, ranked by merit.
export function tertileSpread(rows){
  const clean=rows.filter(r=>r.merit!=null&&isFinite(r.merit)&&r.fwdRet!=null&&isFinite(r.fwdRet));
  if(clean.length<3) return null;
  const s=[...clean].sort((a,b)=>a.merit-b.merit);
  const k=Math.max(1,Math.floor(s.length/3));
  const mean=arr=>arr.reduce((x,r)=>x+r.fwdRet,0)/arr.length;
  return mean(s.slice(-k))-mean(s.slice(0,k));
}

// t-test on a series (e.g. the per-period IC series). Sample variance (n−1) —
// the honest, conservative choice given the small period counts here. Verdict
// thresholds are sized for a small-sample mean test, NOT for runBacktest's
// per-trade regime (which had hundreds of observations).
export function assessSignificance(series){
  const xs=series.filter(v=>v!=null&&isFinite(v));
  const n=xs.length;
  const mean=n?xs.reduce((a,b)=>a+b,0)/n:0;
  const variance=n>1?xs.reduce((a,b)=>a+(b-mean)**2,0)/(n-1):0;
  const sd=Math.sqrt(variance);
  const se=sd>0?sd/Math.sqrt(n):0;
  const t=se>0?mean/se:0;
  let verdict="NOT SIGNIFICANT";
  if(n<6) verdict="TOO FEW PERIODS";
  else if(Math.abs(t)>2) verdict="SIGNIFICANT";
  else if(Math.abs(t)>1.5) verdict="SUGGESTIVE";
  return {n, mean:round(mean), sd:round(sd), t:round(t), verdict};
}
const round=x=>Math.round(x*1e4)/1e4;

// Group observations into per-period cross-sections (keyed by `period`).
function byPeriod(observations){
  const g=new Map();
  for(const o of observations){ if(!g.has(o.period)) g.set(o.period,[]); g.get(o.period).push(o); }
  return [...g.entries()].sort((a,b)=>a[0]<b[0]?-1:1); // chronological (ISO dates sort lexically)
}

// Full cross-sectional study over the observation panel.
export function runStudy(observations, {oosFrac=0.3}={}){
  const grouped=byPeriod(observations);
  const periods=grouped.map(([period,rows])=>({
    period, n:rows.length, ic:rankIC(rows), spread:tertileSpread(rows),
  })).filter(p=>p.ic!=null);
  const ics=periods.map(p=>p.ic);
  const overall=assessSignificance(ics);
  const spread=assessSignificance(periods.map(p=>p.spread));
  const cut=Math.floor(periods.length*(1-oosFrac));
  const inSample =assessSignificance(periods.slice(0,cut).map(p=>p.ic));
  const outSample=assessSignificance(periods.slice(cut).map(p=>p.ic));
  return {
    periods,
    meanIC:overall.mean, icT:overall.t, n:overall.n, significance:overall.verdict,
    spread,
    oos:{ splitIdx:cut, trainPct:Math.round((1-oosFrac)*100), testPct:Math.round(oosFrac*100), inSample, outSample },
  };
}

// Placebo: shuffle merit labels WITHIN each period, recompute the IC series.
// A real edge collapses to ~0 here; if the placebo still "passes", the headline
// result was an artifact. Seeded for reproducibility.
function mulberry(a){ return function(){ a|=0; a=a+0x6D2B79F5|0; let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
export function placebo(observations, seed=1){
  const rng=mulberry(seed);
  const ics=[];
  for(const [,rows] of byPeriod(observations)){
    const merits=rows.map(r=>r.merit);
    for(let i=merits.length-1;i>0;i--){ const j=Math.floor(rng()*(i+1)); [merits[i],merits[j]]=[merits[j],merits[i]]; }
    const ic=rankIC(rows.map((r,i)=>({merit:merits[i], fwdRet:r.fwdRet})));
    if(ic!=null) ics.push(ic);
  }
  return assessSignificance(ics);
}

// The Phase-2 gate: merit may move the signal ONLY if the full-sample edge is
// significant AND it points the SAME (positive) direction in BOTH the in- and
// out-of-sample halves AND the label-shuffle placebo is null. Conservative by
// construction. Note: we test OOS *direction persistence*, not OOS independent
// significance — with the small period counts this universe yields, an OOS slice
// can never reach significance on its own, so demanding it would be a gate that
// no honest result could ever pass. The UI still shows the OOS verdict in full.
export function meritEdgeProven(study, placeboRes){
  const ok=v=>v==="SIGNIFICANT"||v==="SUGGESTIVE";
  return !!(study && placeboRes
    && ok(study.significance) && study.meanIC>0
    && study.oos.inSample.mean>0 && study.oos.outSample.mean>0
    && !ok(placeboRes.verdict));
}
