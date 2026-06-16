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
  return {n, mean:round(mean), sd:round(sd), t:round(t), verdict:verdictFor(t,n)};
}

// Shared verdict thresholds — sized for a small-sample mean test. One source of truth
// so assessSignificance, the overlap-adjusted t and the deflated t all agree.
export function verdictFor(t, n){
  if(n<6) return "TOO FEW PERIODS";
  if(Math.abs(t)>2) return "SIGNIFICANT";
  if(Math.abs(t)>1.5) return "SUGGESTIVE";
  return "NOT SIGNIFICANT";
}
const round=x=>Math.round(x*1e4)/1e4;

// Group observations into per-period cross-sections (keyed by `period`).
function byPeriod(observations){
  const g=new Map();
  for(const o of observations){ if(!g.has(o.period)) g.set(o.period,[]); g.get(o.period).push(o); }
  return [...g.entries()].sort((a,b)=>a[0]<b[0]?-1:1); // chronological (ISO dates sort lexically)
}

// Full cross-sectional study over the observation panel.
// Per-period cross-section stats, chronological. `mktRet` is the equal-weight universe
// forward return that period — the "market" leg the beta diagnostic checks the spread against.
export function periodStats(observations){
  return byPeriod(observations).map(([period,rows])=>{
    const fr=rows.map(r=>r.fwdRet).filter(v=>v!=null&&isFinite(v));
    return {
      period, n:rows.length, ic:rankIC(rows), spread:tertileSpread(rows),
      mktRet: fr.length ? fr.reduce((a,b)=>a+b,0)/fr.length : null,
    };
  }).filter(p=>p.ic!=null);
}

export function runStudy(observations, {oosFrac=0.3, overlap=0, trials=1}={}){
  const periods=periodStats(observations);
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
    // Additive hardening (Step 1) — none of these change the fields above:
    walkForward: walkForward(observations),         // does past IC predict next-period IC?
    betaControl: betaControl(periods),              // is the long-short spread disguised beta-timing?
    overlapAdjusted: overlapAdjustedT(ics, overlap),// honest t when windows overlap (HAC)
    deflated: deflatedSignificance(ics, { trials }),// overfit haircut for # of configs tried
    sectorControl: sectorNeutralIC(observations),   // alpha, or a disguised sector bet? (sector-tagged obs only)
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
// TIGHTENED gate (Step 1): merit may move the live signal ONLY if the full-sample edge is
// significant, positive, same-signed in BOTH halves, placebo-null AND — new — it survives
// walk-forward (past IC predicts next-period IC, hitRate>0.5 with positive out-of-fold mean)
// AND the overfit-deflated t is still at least suggestive. "Proven" now means
// walk-forward-and-overfit-survived, not just one 70/30 split.
export function meritEdgeProven(study, placeboRes){
  const ok=v=>v==="SIGNIFICANT"||v==="SUGGESTIVE";
  const wf=study&&study.walkForward, df=study&&study.deflated;
  return !!(study && placeboRes
    && ok(study.significance) && study.meanIC>0
    && study.oos.inSample.mean>0 && study.oos.outSample.mean>0
    && !ok(placeboRes.verdict)
    && wf && wf.hitRate!=null && wf.hitRate>0.5 && wf.oof && wf.oof.mean>0
    && df && ok(df.verdict));
}

// ─── Step-1 hardening: walk-forward, beta diagnostic, HAC t, overfit haircut ──

// Walk-forward: expanding one-step-ahead folds. For each period k≥minTrain, the only
// information used to "predict" is the mean IC over periods [0..k); we then check whether
// the realised IC at k has the SAME SIGN. `hitRate` is the fraction of folds that agree —
// the honest "does the past predict the next period" test the one-shot 70/30 split cannot
// answer. The out-of-fold IC series is summarised with the same small-sample t-test.
export function walkForward(observations, {minTrain=3}={}){
  const ics=periodStats(observations).map(p=>p.ic);
  const n=ics.length, oofIC=[], trainMeanByFold=[]; let hits=0, folds=0;
  for(let k=minTrain;k<n;k++){
    const train=ics.slice(0,k);
    const tm=train.reduce((a,b)=>a+b,0)/train.length;
    oofIC.push(ics[k]); trainMeanByFold.push(round(tm)); folds++;
    if(tm!==0 && Math.sign(ics[k])===Math.sign(tm)) hits++;
  }
  return { folds, minTrain, oofIC:oofIC.map(round), oof:assessSignificance(oofIC),
    hitRate: folds?round(hits/folds):null, trainMeanByFold };
}

// Beta diagnostic. rankIC and tertileSpread are already WITHIN-PERIOD cross-sectional, so a
// uniform market move that period cancels — they are beta-neutral in LEVEL (which is why
// cross-sectionally demeaning forward returns would be a no-op here). What can still hide
// beta is TIMING: a long-short spread that only pays in up-markets. So we correlate the
// per-period spread series with the per-period market (equal-weight) return. |corr|≈0 ⇒ the
// spread is genuine cross-sectional skill; strongly positive ⇒ the "edge" is market-timing.
export function betaControl(periods){
  const pairs=(periods||[]).filter(p=>p.spread!=null&&isFinite(p.spread)&&p.mktRet!=null&&isFinite(p.mktRet));
  const spread=pairs.map(p=>p.spread), mkt=pairs.map(p=>p.mktRet);
  const corr=pearson(spread, mkt);
  const meanSpread=spread.length?spread.reduce((a,b)=>a+b,0)/spread.length:null;
  return { n:pairs.length, meanSpread:round(meanSpread), spreadMktCorr: corr==null?null:round(corr) };
}

// Overlap-adjusted t for the IC mean (Newey–West HAC, Bartlett kernel). When rebalances are
// spaced CLOSER than the return horizon, forward windows overlap and the IC series is
// autocorrelated — the naive t (assessSignificance) is then inflated. `overlap` = number of
// overlapping lags (≈ horizon/step − 1). Reduces to ~the naive SE at overlap=0.
export function overlapAdjustedT(series, overlap=0){
  const xs=(series||[]).filter(v=>v!=null&&isFinite(v));
  const n=xs.length;
  if(n<2) return { n, mean:n?round(xs[0]):null, seHAC:null, tHAC:null, overlap:0, verdict:"TOO FEW PERIODS" };
  const mean=xs.reduce((a,b)=>a+b,0)/n;
  const d=xs.map(x=>x-mean);
  const L=Math.max(0, Math.min(overlap, n-1));
  let varSum=d.reduce((a,e)=>a+e*e,0)/n;            // γ0
  for(let l=1;l<=L;l++){
    let g=0; for(let i=l;i<n;i++) g+=d[i]*d[i-l];
    g/=n;
    varSum+=2*(1-l/(L+1))*g;                        // Bartlett-weighted γl
  }
  const seHAC=varSum>0?Math.sqrt(varSum/n):0;
  const t=seHAC>0?mean/seHAC:0;
  return { n, mean:round(mean), seHAC:round(seHAC), tHAC:round(t), overlap:L, verdict:verdictFor(t,n) };
}

// Deflated significance: haircut the IC t-stat for the number of configurations effectively
// tried (`trials`). The expected maximum of `trials` iid t's grows like √(2·ln trials); we
// subtract that from |t|. trials=1 → no haircut (reproduces assessSignificance's verdict).
export function deflatedSignificance(series, {trials=1}={}){
  const base=assessSignificance(series);
  const threshold=trials>1?Math.sqrt(2*Math.log(trials)):0;
  const tDeflated=round(Math.sign(base.t)*Math.max(0, Math.abs(base.t)-threshold));
  return { trials, t:base.t, threshold:round(threshold), tDeflated, n:base.n, verdict:verdictFor(tDeflated, base.n) };
}

// ─── Sector-neutral diagnostic: alpha, not a disguised sector bet ──────────────
// A cross-sectional factor can be a SECTOR tilt in disguise — low-vol≈utilities/staples,
// momentum≈whatever sector ran, quality≈software. The headline rank-IC then rewards being in
// the right sector, not picking the right NAME (beta, not alpha). This re-measures the IC after
// removing each period's WITHIN-SECTOR mean forward return: residual_i = fwdRet_i − mean(fwdRet
// over names in the same sector that period). rankIC(merit, residual) then asks "does merit rank
// names correctly INSIDE their sector?" If the neutral IC retains most of the raw IC the edge is
// genuine stock-selection; if it collapses, the factor was mostly a sector bet.
//
// Pure and ADDITIVE: runs only when observations carry a `sector` tag and ≥2 sectors populate a
// period; otherwise returns {available:false} so factors without sector data are unaffected.
export function sectorNeutralIC(observations){
  const neutral=[], raw=[];
  for(const [,rows] of byPeriod(observations)){
    const clean=rows.filter(r=>r.merit!=null&&isFinite(r.merit)&&r.fwdRet!=null&&isFinite(r.fwdRet)&&r.sector!=null&&r.sector!=="");
    if(clean.length<3) continue;
    const sectors=new Set(clean.map(r=>r.sector));
    if(sectors.size<2) continue;                    // need ≥2 sectors to neutralise anything
    const sum=new Map(), cnt=new Map();
    for(const r of clean){ sum.set(r.sector,(sum.get(r.sector)||0)+r.fwdRet); cnt.set(r.sector,(cnt.get(r.sector)||0)+1); }
    const resid=clean.map(r=>({ merit:r.merit, fwdRet:r.fwdRet - sum.get(r.sector)/cnt.get(r.sector) }));
    const icN=rankIC(resid), icR=rankIC(clean);
    if(icN!=null&&icR!=null){ neutral.push(icN); raw.push(icR); }
  }
  if(neutral.length<6) return { available:false, periods:neutral.length };
  const nStat=assessSignificance(neutral);
  const rawMean=raw.reduce((a,b)=>a+b,0)/raw.length;
  // Retention = how much of the raw IC survives sector-neutralisation (signed; clamped for display).
  const retention=Math.abs(rawMean)>1e-9 ? round(nStat.mean/rawMean) : null;
  const ok=v=>v==="SIGNIFICANT"||v==="SUGGESTIVE";
  const verdict = !ok(nStat.verdict) ? "SECTOR-DRIVEN (mostly beta)"
    : (retention!=null&&retention>=0.5) ? "SURVIVES (stock-selection)"
    : "PARTLY SECTOR-DRIVEN";
  return { available:true, periods:neutral.length, meanIC:nStat.mean, icT:nStat.t,
    significance:nStat.verdict, rawMeanIC:round(rawMean), retention, verdict };
}
