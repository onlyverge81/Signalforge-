// SignalForge core engine — server-side (Node), shared with the browser.
//
// Ported VERBATIM from the browser app's inline <script> (index.html) so the
// signal, ATR stops, backtest and t-stat gate are byte-for-byte identical. The
// reason it lives here too: a browser can compute these, but nothing OUTSIDE the
// browser (a CI cron, a CLI preview) could — they were trapped in the Babel
// <script>. Now the same pure math runs in Node so an automated forward test can
// log the engine's live decisions to paper-ledger.json on settled bars.
//
// PARITY RULE: index.html keeps its own copy (it's a no-build static file and
// cannot import this module). These two copies must stay identical; scripts/
// engine.test.mjs pins the behavior so they can't silently drift — the same
// discipline as sec-lib.mjs ↔ the browser's former SEC code.

// ─── CSV Parser ────────────────────────────────────────────────────────────
export function parseCSV(raw) {
  try {
    const lines = raw.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];
    const hdr = lines[0].toLowerCase().split(",").map(h => h.trim());
    const fi = kws => hdr.findIndex(h => kws.some(k => h.includes(k)));
    const ci = fi(["close","price","last"]);
    if (ci < 0) return [];
    const di=fi(["date","time"]),oi=fi(["open"]),hi=fi(["high"]),li=fi(["low"]),vi=fi(["vol"]);
    return lines.slice(1).map(line => {
      const c = line.split(",");
      const close = parseFloat(c[ci]);
      return {
        date:   di>=0 ? (c[di]||"").trim() : "",
        open:   parseFloat(c[oi]) || close,
        high:   parseFloat(c[hi]) || close,
        low:    parseFloat(c[li]) || close,
        close,
        volume: parseInt(c[vi]) || 0,
      };
    }).filter(d => !isNaN(d.close) && d.close > 0);
  } catch { return []; }
}

// ─── Data-integrity audit ───────────────────────────────────────────────────
// Pure & defensive: never throws, returns {issues:[{level,code,msg}], suspect}.
export function auditData(rows){
  const issues=[];
  if(!rows||rows.length<5) return {issues,suspect:false};
  const n=rows.length;
  const add=(level,code,msg)=>issues.push({level,code,msg});

  // 1) Malformed bars: high<low, or open/close outside the [low,high] range.
  let bad=0;
  for(const d of rows){
    if(d.high<d.low) bad++;
    else if(d.close>d.high+1e-9||d.close<d.low-1e-9||d.open>d.high+1e-9||d.open<d.low-1e-9) bad++;
  }
  if(bad) add("SEVERE","ohlc", bad+" bar"+(bad>1?"s have":" has")+" impossible OHLC values (high<low, or open/close outside the range) — the feed is malformed.");

  // 2) Date order / duplicates / gaps (only when dates parse).
  const ts=rows.map(d=>Date.parse(d.date));
  if(ts.every(t=>!isNaN(t))){
    let dup=0,back=0;
    for(let i=1;i<n;i++){ if(ts[i]===ts[i-1])dup++; else if(ts[i]<ts[i-1])back++; }
    if(dup) add("WARN","dupdate", dup+" duplicate timestamp"+(dup>1?"s":"")+" — the same bar appears more than once.");
    if(back) add("WARN","unordered", back+" out-of-order bar"+(back>1?"s":"")+" — dates aren't monotonic, but every indicator assumes chronological order.");
    const gaps=[]; for(let i=1;i<n;i++){const dt=ts[i]-ts[i-1]; if(dt>0)gaps.push(dt);}
    if(gaps.length){
      const med=gaps.slice().sort((a,b)=>a-b)[Math.floor(gaps.length/2)];
      let big=0; for(const g of gaps) if(g>med*3.5 && g>med+1.5*864e5) big++; // >3.5× typical spacing AND >~1.5d
      if(big) add("WARN","gap", big+" gap"+(big>1?"s":"")+" in the series (missing bars vs the typical spacing) — backtest windows may straddle holes.");
    }
  } else {
    add("WARN","nodates","Bars have no parseable dates — gap and ordering checks were skipped.");
  }

  // 3) Discontinuities, sized against the instrument's OWN volatility.
  const rets=[]; for(let i=1;i<n;i++){ if(rows[i-1].close>0) rets.push(Math.abs((rows[i].close-rows[i-1].close)/rows[i-1].close)); }
  const sorted=rets.slice().sort((a,b)=>a-b);
  const medAbs=sorted.length?sorted[Math.floor(sorted.length/2)]:0;
  const candLimit=Math.max(0.18, medAbs*6);
  const splitLimit=Math.max(0.35, medAbs*8);
  let split=0,outlier=0;
  for(let i=1;i<n;i++){
    const c0=rows[i-1].close,c1=rows[i].close; if(!(c0>0))continue;
    const r=(c1-c0)/c0; if(Math.abs(r)<=candLimit) continue;
    const r2=(i+1<n&&c1>0)?(rows[i+1].close-c1)/c1:0;
    const reverts=Math.sign(r2)===-Math.sign(r)&&Math.abs(r2)>=Math.abs(r)*0.6;
    if(reverts) outlier++;
    else if(Math.abs(r)>splitLimit) split++;
  }
  if(split)   add("SEVERE","jump", split+" price discontinuit"+(split>1?"ies":"y")+" far beyond this instrument's normal range — typically an unadjusted split/dividend; it distorts trend, ATR stops and the backtest.");
  if(outlier) add("SEVERE","outlier", outlier+" single-bar spike"+(outlier>1?"s that revert":" that reverts")+" — a bad print/tick rather than a real move.");

  // 4) Stale / frozen feed: a run of identical closes.
  let run=1,maxRun=1;
  for(let i=1;i<n;i++){ if(rows[i].close===rows[i-1].close){ run++; if(run>maxRun)maxRun=run; } else run=1; }
  if(maxRun>=5)      add("SEVERE","frozen","A frozen stretch of "+maxRun+" identical closes — a stale feed; the volatility and signals computed across it are meaningless.");
  else if(maxRun>=3) add("WARN","flat","A flat stretch of "+maxRun+" identical closes — possibly thin or stale data.");

  return {issues, suspect:issues.some(i=>i.level==="SEVERE")};
}

// ─── Technical Analysis ────────────────────────────────────────────────────
export const sma = (p,n) => p.length<n ? null : p.slice(-n).reduce((a,b)=>a+b,0)/n;
export function ema(p,n) {
  if (p.length<n) return null;
  const k=2/(n+1); let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n;
  for (let i=n;i<p.length;i++) e=p[i]*k+e*(1-k); return e;
}
export function rsi(p,n=14) {
  if (p.length<n+1) return null;
  let g=0,l=0;
  for (let i=p.length-n;i<p.length;i++) { const d=p[i]-p[i-1]; d>0?g+=d:l-=d; }
  const rs=(g/n)/((l/n)||.0001);
  return parseFloat((100-100/(1+rs)).toFixed(1));
}
export function macd(p) {
  const e12=ema(p,12),e26=ema(p,26); if(!e12||!e26) return null;
  const m=e12-e26; return {macd:parseFloat(m.toFixed(4)),ema12:e12,ema26:e26};
}
export function bb(p,n=20) {
  if (p.length<n) return null;
  const sl=p.slice(-n),mu=sl.reduce((a,b)=>a+b,0)/n;
  const sd=Math.sqrt(sl.reduce((a,b)=>a+Math.pow(b-mu,2),0)/n);
  return {upper:mu+2*sd,middle:mu,lower:mu-2*sd};
}
export function stoch(data,n=14) {
  if (data.length<n) return null;
  const sl=data.slice(-n),lo=Math.min(...sl.map(d=>d.low)),hi=Math.max(...sl.map(d=>d.high));
  return parseFloat(((sl[sl.length-1].close-lo)/((hi-lo)||1)*100).toFixed(1));
}
export function atr(data,n=14) {
  if (data.length<2) return 0;
  const trs=data.slice(-Math.min(n+1,data.length)).map((d,i,a)=>{
    if(i===0) return d.high-d.low;
    return Math.max(d.high-d.low,Math.abs(d.high-a[i-1].close),Math.abs(d.low-a[i-1].close));
  });
  return trs.reduce((a,b)=>a+b,0)/trs.length;
}
export function adxCalc(data,n=14){
  if(data.length<n*2)return null;
  const tr=[],plusDM=[],minusDM=[];
  for(let i=1;i<data.length;i++){
    const h=data[i].high,l=data[i].low,ph=data[i-1].high,pl=data[i-1].low,pc=data[i-1].close;
    tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));
    const up=h-ph,dn=pl-l;
    plusDM.push(up>dn&&up>0?up:0);
    minusDM.push(dn>up&&dn>0?dn:0);
  }
  const smooth=arr=>{let s=arr.slice(0,n).reduce((a,b)=>a+b,0);const out=[s];for(let i=n;i<arr.length;i++){s=s-s/n+arr[i];out.push(s);}return out;};
  const trS=smooth(tr),pS=smooth(plusDM),mS=smooth(minusDM);
  const dx=[];
  for(let i=0;i<trS.length;i++){
    const pdi=100*pS[i]/(trS[i]||1),mdi=100*mS[i]/(trS[i]||1);
    dx.push(100*Math.abs(pdi-mdi)/((pdi+mdi)||1));
  }
  if(dx.length<n)return null;
  const adx=dx.slice(-n).reduce((a,b)=>a+b,0)/n;
  const li=trS.length-1;
  const pdi=100*pS[li]/(trS[li]||1),mdi=100*mS[li]/(trS[li]||1);
  return{adx:+adx.toFixed(1),plusDI:+pdi.toFixed(1),minusDI:+mdi.toFixed(1)};
}
// ─── Market-regime notifier ("read the room") ────────────────────────────────
// Awareness, NOT a gate: classify the broad-market environment from a daily index series so the human
// knows which toolkit fits. Research (factor-interaction angles C+F) showed the engine's votes are
// CONDITIONALLY valid — trend-following works in TRENDING markets, mean-reversion in RANGING ones — and
// the regime-blind confluence fires them all at once, fighting itself. This surfaces the regime so the
// verdict can be weighted by it. Close-only (works on any index proxy, incl. close-only feeds).
// Kaufman efficiency ratio = |net move| / Σ|bar-to-bar move| over n bars: ~1 = clean trend, ~0 = chop.
export function efficiencyRatio(closes,n=21){
  if(!closes||closes.length<n+1) return null;
  const seg=closes.slice(-(n+1));
  const net=Math.abs(seg[seg.length-1]-seg[0]);
  let path=0; for(let i=1;i<seg.length;i++) path+=Math.abs(seg[i]-seg[i-1]);
  return path>0?net/path:0;
}
export function marketRegime(bars){
  const closes=(bars||[]).map(b=>b&&b.close).filter(c=>c>0);
  if(closes.length<40) return null;                                // need enough for a vol baseline
  const last=closes[closes.length-1];
  const win=Math.min(200,closes.length);
  const ma=closes.slice(-win).reduce((a,b)=>a+b,0)/win;           // proxy 200-DMA (shorter if data is)
  const approxMA=win<200;
  const direction=last>ma*1.01?"BULL":last<ma*0.99?"BEAR":"NEUTRAL";
  const er=efficiencyRatio(closes,21);
  const trend=er==null?"UNKNOWN":er>=0.45?"TRENDING":er<0.25?"RANGING":"TRANSITIONAL";
  const rets=[]; for(let i=1;i<closes.length;i++) rets.push(closes[i]/closes[i-1]-1);
  const stdev=a=>{ if(a.length<2) return null; const m=a.reduce((x,y)=>x+y,0)/a.length; return Math.sqrt(a.reduce((x,y)=>x+(y-m)**2,0)/a.length); };
  const recentVol=stdev(rets.slice(-21)), baseVol=stdev(rets.slice(-126));
  const vol=(recentVol==null||baseVol==null||baseVol===0)?"UNKNOWN"
    :recentVol>baseVol*1.35?"STORMY":recentVol<baseVol*0.75?"CALM":"NORMAL";
  let favored,cautioned;
  if(trend==="TRENDING"){ favored="Trend-following — momentum & breakouts (MA / MACD-up) are reliable here"; cautioned="Mean-reversion: 'buy the dip' fights the tape — oversold can keep falling"; }
  else if(trend==="RANGING"){ favored="Mean-reversion — oversold bounces (RSI / Stoch / BB) are favored"; cautioned="Breakouts: likely bull-traps; trend votes misfire in chop"; }
  else { favored="Transitional / mixed — demand stronger multi-signal confluence before acting"; cautioned="Single-signal conviction is risky until the regime resolves"; }
  const risk=(direction==="BEAR"&&vol==="STORMY")?"ELEVATED — bear + high volatility: reduce size. A regime-blind signal fails hardest here."
    :(vol==="STORMY")?"Volatility is elevated vs its 6-month norm — widen stops or trim size."
    :(direction==="BEAR")?"Bear trend — long signals face a market headwind.":null;
  const label=[direction!=="NEUTRAL"?direction:null,trend!=="UNKNOWN"?trend:null].filter(Boolean).join(" · ")||"INDETERMINATE";
  return { direction, trend, vol, er:er==null?null:+er.toFixed(2), approxMA, favored, cautioned, risk, label };
}
export function obvCalc(data){
  if(data.length<16)return null;
  let obv=0;const series=[0];
  for(let i=1;i<data.length;i++){
    if(data[i].close>data[i-1].close)obv+=data[i].volume;
    else if(data[i].close<data[i-1].close)obv-=data[i].volume;
    series.push(obv);
  }
  const recent=series.slice(-5).reduce((a,b)=>a+b,0)/5;
  const prior=series.slice(-15,-5).reduce((a,b)=>a+b,0)/10;
  return{obv,rising:recent>prior};
}
export function vwapCalc(data){
  if(!data.length)return null;
  let pv=0,vol=0;
  data.slice(-20).forEach(d=>{const tp=(d.high+d.low+d.close)/3;pv+=tp*d.volume;vol+=d.volume;});
  return vol>0?+(pv/vol).toFixed(4):null;
}
export function patterns(data) {
  const out=[],n=data.length; if(n<3) return out;
  const [c,b,a]=[data[n-1],data[n-2],data[n-3]];
  const body=d=>Math.abs(d.close-d.open), range=d=>d.high-d.low;
  if(b.close<b.open&&c.close>c.open&&c.open<=b.close&&c.close>=b.open)
    out.push({name:"Bullish Engulfing",type:"BULLISH",desc:"Bullish candle fully engulfs prior bearish — strong reversal signal."});
  if(b.close>b.open&&c.close<c.open&&c.open>=b.close&&c.close<=b.open)
    out.push({name:"Bearish Engulfing",type:"BEARISH",desc:"Bearish candle fully engulfs prior bullish — strong reversal signal."});
  if(range(c)>0&&body(c)/range(c)<0.08)
    out.push({name:"Doji",type:"NEUTRAL",desc:"Open and close nearly equal — indecision, potential reversal ahead."});
  const lw=Math.min(c.open,c.close)-c.low, uw=c.high-Math.max(c.open,c.close);
  if(body(c)>0&&lw>2*body(c)&&uw<body(c))
    out.push({name:"Hammer",type:"BULLISH",desc:"Long lower wick — buyers rejected lows, bullish reversal."});
  if(body(c)>0&&uw>2*body(c)&&lw<body(c))
    out.push({name:"Shooting Star",type:"BEARISH",desc:"Long upper wick — sellers rejected highs, bearish reversal."});
  if([a,b,c].every(d=>d.close>d.open)&&b.close>a.close&&c.close>b.close)
    out.push({name:"Three White Soldiers",type:"BULLISH",desc:"Three consecutive bullish candles — strong upward momentum."});
  if([a,b,c].every(d=>d.close<d.open)&&b.close<a.close&&c.close<b.close)
    out.push({name:"Three Black Crows",type:"BEARISH",desc:"Three consecutive bearish candles — strong downward pressure."});
  return out;
}
export function divergence(closes,n=10) {
  if(closes.length<n+15) return null;
  const rsiAt=i=>rsi(closes.slice(0,i+1));
  const recentP=closes.slice(-n),recentR=closes.slice(0,-n).map((_,i,a)=>rsiAt(i)).filter(Boolean);
  if(recentR.length<3) return null;
  const pUp=recentP[recentP.length-1]>recentP[0];
  const rUp=recentR[recentR.length-1]>recentR[0];
  if(pUp&&!rUp) return{type:"BEARISH",desc:"Price making higher highs but RSI declining — momentum weakening, potential reversal."};
  if(!pUp&&rUp)  return{type:"BULLISH",desc:"Price making lower lows but RSI rising — selling pressure fading, potential bottom."};
  return null;
}

// ─── SFA12 tracker (composite of SMA5/10/20 + trend %) ───────────────────────
export function sfa12Series(rows, startIdx=30, lookback=12){
  const closes=rows.map(d=>d.close);
  const comp=[];
  for(let i=0;i<closes.length;i++){
    if(i<19){ comp.push(null); continue; }
    const sl=closes.slice(0,i+1);
    comp.push((sma(sl,5)+sma(sl,10)+sma(sl,20))/3);
  }
  const pctAt=(i,n)=>{
    if(i-lookback<19) return null;
    const a=sma(closes.slice(0,i-lookback+1),n), b=sma(closes.slice(0,i+1),n);
    if(a==null||b==null||a===0) return null;
    return (b-a)/a*100;
  };
  const series=[];
  for(let i=startIdx;i<closes.length;i++){ if(comp[i]!=null) series.push({i,value:comp[i]}); }
  const li=closes.length-1, sl=closes.slice(0,li+1);
  const s5=sma(sl,5), s10=sma(sl,10), s20=sma(sl,20);
  const p5=pctAt(li,5), p10=pctAt(li,10), p20=pctAt(li,20);
  const pct=(p5!=null&&p10!=null&&p20!=null)?parseFloat(((p5+p10+p20)/3).toFixed(2)):null;
  let state="SIDEWAYS";
  if(s5!=null&&s10!=null&&s20!=null&&pct!=null){
    if(s5>s10&&s10>s20&&pct>0) state="UPTREND";
    else if(s5<s10&&s10<s20&&pct<0) state="DOWNTREND";
  }
  return { value: comp[li], pct, state, lookback, series };
}

// ─── "Uptrend Convergence with Breakout" — MA-ribbon squeeze → expansion ──────
// A position-trade setup: SMA5, SMA10 and the SFA12 composite pinch to ~one price
// (the coil), then SMA5 breaks out above with a WIDENING gap while SMA10 and the
// composite climb together (the confirm). Detection only — like SFA12 it does NOT
// feed the live signal; it's surfaced and backtested on its own so its edge can be
// measured on a big sample. Pure + deterministic; thresholds tunable.
const CB_DEFAULTS={ coilPct:0.006, gapPct:0.004, coilLookback:8, slopeLookback:3, horizon:20, minBars:60,
                    trendFilter:true, trendLookback:20, trendMinSlope:0.01 };
function cbOpts(o){ return Object.assign({}, CB_DEFAULTS, o||{}); }
// O(N) rolling SMA5/10/20/50 + the SFA12 composite (mean of 5/10/20), index-aligned.
function maRibbon(cl){
  const s5=[],s10=[],s20=[],s50=[],comp=[]; let a5=0,a10=0,a20=0,a50=0;
  for(let i=0;i<cl.length;i++){
    a5+=cl[i]; if(i>=5)a5-=cl[i-5]; s5[i]=i>=4?a5/5:null;
    a10+=cl[i]; if(i>=10)a10-=cl[i-10]; s10[i]=i>=9?a10/10:null;
    a20+=cl[i]; if(i>=20)a20-=cl[i-20]; s20[i]=i>=19?a20/20:null;
    a50+=cl[i]; if(i>=50)a50-=cl[i-50]; s50[i]=i>=49?a50/50:null;
    comp[i]=(s5[i]!=null&&s10[i]!=null&&s20[i]!=null)?(s5[i]+s10[i]+s20[i])/3:null;
  }
  return {s5,s10,s50,comp};
}
// Evaluate the setup AT bar i from precomputed ribbons (no slicing → cheap to loop).
function cbDetectAt(R, cl, i, P){
  const s5=R.s5,s10=R.s10,s50=R.s50,comp=R.comp,k=P.slopeLookback;
  if(i<20+k || s5[i]==null||s10[i]==null||comp[i]==null) return {detected:false};
  const price=cl[i];
  const spreadPct=j=>(s5[j]==null||s10[j]==null||comp[j]==null)?null
    :(Math.max(s5[j],s10[j],comp[j])-Math.min(s5[j],s10[j],comp[j]))/cl[j];
  // Coil: a tight pinch within the last coilLookback bars, before the current pop.
  let coilIdx=-1, coilSpread=null;
  for(let j=i-1;j>=Math.max(20,i-P.coilLookback);j--){ const sp=spreadPct(j); if(sp!=null&&sp<=P.coilPct){ coilIdx=j; coilSpread=sp; break; } }
  if(coilIdx<0) return {detected:false, coilSpreadPct:null, breakoutGapPct:null};
  // Pop + confirm at bar i. SMA5 leads on top; SMA10 and the SFA12 composite ride
  // together below (composite includes SMA5, so it sits just above SMA10, not below).
  const stacked=s5[i]>s10[i] && s5[i]>comp[i];
  const together=Math.abs(comp[i]-s10[i])/price<=P.gapPct;
  const gapNow=(s5[i]-s10[i])/price, gapPrev=(s5[i-1]-s10[i-1])/cl[i-1];
  const s5Rising=s5[i]>s5[i-k], s10Rising=s10[i]>s10[i-k], compRising=comp[i]>comp[i-k];
  const gapWidening=gapNow>gapPrev && gapNow>=P.gapPct;
  // Trend filter: only fire inside an ESTABLISHED uptrend (price above a rising
  // 50-day SMA) — a coil/breakout is a momentum setup, so it pays where momentum
  // already exists, not on a pop off a flat base. Optional (trendFilter:false).
  let trendOK=true;
  if(P.trendFilter){
    const j=i-P.trendLookback;
    trendOK = s50[i]!=null && j>=0 && s50[j]!=null && cl[i]>s50[i] && (s50[i]-s50[j])/s50[j] >= P.trendMinSlope;
  }
  const detected=stacked && together && s5Rising && gapWidening && s10Rising && compRising && trendOK;
  const strength=detected?Math.max(0,Math.min(1,(gapNow/P.gapPct)*0.5+(1-coilSpread/P.coilPct)*0.5)):0;
  return { detected, barsSinceCoil:i-coilIdx, coilSpreadPct:coilSpread, breakoutGapPct:gapNow,
           strength:parseFloat(strength.toFixed(2)), stacked, together, s5Rising, gapWidening, s10Rising, compRising, trendOK };
}
function cbMedian(a){ if(!a.length) return null; const s=a.slice().sort((x,y)=>x-y),m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; }
// Live detection at the latest bar.
export function convergenceBreakout(slice, opts){
  const P=cbOpts(opts); const need = P.trendFilter ? 50+P.trendLookback : 21+P.slopeLookback;
  if(!slice||slice.length<need) return null;
  const cl=slice.map(d=>d.close); return cbDetectAt(maRibbon(cl), cl, cl.length-1, P);
}
// Forward-return edge: at every trigger bar, the H-bar forward return vs the
// unconditional baseline over the same eligible bars. Pure; O(N).
export function backtestPattern(data, opts){
  const P=cbOpts(opts), H=P.horizon;
  if(!data||data.length<P.minBars+H+1) return null;
  const cl=data.map(d=>d.close), R=maRibbon(cl), sig=[], all=[];
  const start=Math.max(P.minBars, 21+P.slopeLookback, P.trendFilter ? 49+P.trendLookback : 0);
  for(let i=start;i<data.length-H;i++){
    const fwd=(cl[i+H]-cl[i])/cl[i]; all.push(fwd);
    if(cbDetectAt(R,cl,i,P).detected) sig.push(fwd);
  }
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null, win=a=>a.length?a.filter(x=>x>0).length/a.length:null;
  const sM=mean(sig), bM=mean(all);
  return { horizon:H, signals:sig.length, eligibleBars:all.length, winRate:win(sig),
    avgFwdRet:sM, medianFwdRet:cbMedian(sig), baselineWinRate:win(all), baselineAvgFwdRet:bM,
    edge:(sM!=null&&bM!=null)?sM-bM:null };
}

// ─── Shared signal logic: weighted votes + confluence + conflict penalty ─────
export function computeSignal(ctx, extraVotes=[], opts={}) {
  const {R,M,s5,s10,s20,s50,trend,S,B,last,pats,div,volSig,ADX,OBV,VWAP} = ctx;
  const votes=[];
  if(R!=null)  votes.push({n:"RSI",   dir:R<40?1:R>60?-1:0, w:2});
  if(M)        votes.push({n:"MACD",  dir:M.macd>0?1:-1,     w:2.5});
  if(s5&&s10)  votes.push({n:"MA",    dir:s5>s10?1:-1,       w:1.5});
  if(s20&&s50) votes.push({n:"MAlong",dir:s20>s50?1:-1,      w:2});
  votes.push({n:"Trend", dir:trend==="UPTREND"?1:trend==="DOWNTREND"?-1:0, w:2});
  if(S!=null)  votes.push({n:"Stoch", dir:S<25?1:S>75?-1:0,  w:1.5});
  if(B)        votes.push({n:"BB",    dir:last.close<B.lower?1:last.close>B.upper?-1:0, w:1.5});
  pats.forEach(p=>votes.push({n:"Pat", dir:p.type==="BULLISH"?1:p.type==="BEARISH"?-1:0, w:1.5}));
  if(div) votes.push({n:"Div", dir:div.type==="BULLISH"?1:-1, w:2.5});
  if(volSig==="CONFIRMING"&&trend==="UPTREND")   votes.push({n:"Vol",dir:1,w:1});
  if(volSig==="CONFIRMING"&&trend==="DOWNTREND") votes.push({n:"Vol",dir:-1,w:1});
  if(ADX) votes.push({n:"ADX", dir:ADX.plusDI>ADX.minusDI?1:-1, w:ADX.adx>25?3:ADX.adx>20?1.5:0.5});
  if(OBV) votes.push({n:"OBV", dir:OBV.rising?1:-1, w:2});
  if(VWAP)votes.push({n:"VWAP",dir:last.close>VWAP?1:-1, w:1.5});
  if(extraVotes.length) votes.push(...extraVotes);

  // Shadow-engine support: drop named votes to ask "does the TEAM signal score better without this
  // member?" (the team-minus-nuisance test). Default path (no drop) is byte-identical.
  const used = (opts.drop && opts.drop.length) ? votes.filter(v=>!opts.drop.includes(v.n)) : votes;
  const active=used.filter(v=>v.dir!==0);
  const bull=active.filter(v=>v.dir>0).length;
  const bear=active.filter(v=>v.dir<0).length;
  const weighted=active.reduce((a,v)=>a+v.dir*v.w,0);
  const conflict=Math.min(bull,bear);
  const penalty=conflict*0.8;
  const net=weighted>0?weighted-penalty:weighted+penalty;

  let signal="HOLD";
  if(net>=5 && bull>=3 && bull>bear) signal="BUY";
  else if(net<=-5 && bear>=3 && bear>bull) signal="SELL";

  const total=bull+bear;
  const agreement=total>0?Math.max(bull,bear)/total:0;
  const confidence=Math.min(95,Math.max(35,Math.round(40+Math.abs(net)*3+agreement*15)));

  // Family-level conflict (research angles C+F): the generic `conflict` above counts ANY disagreement
  // equally, but the engine's real split is MEAN-REVERSION (RSI/Stoch/BB, oversold→buy) vs TREND
  // (MACD/MA/MAlong/Trend). When those two camps point opposite ways the engine is fighting itself —
  // one camp is right for the regime, the other is noise. Measured here, surfaced as a LABEL only.
  const famDir=names=>{ const s=active.filter(v=>names.includes(v.n)).reduce((a,v)=>a+v.dir,0); return s>0?1:s<0?-1:0; };
  const trendDir=famDir(["MACD","MA","MAlong","Trend"]);
  const meanRevDir=famDir(["RSI","Stoch","BB"]);
  const famConflict=trendDir!==0 && meanRevDir!==0 && trendDir!==meanRevDir;

  // Vote-weight mis-calibration test (factor-interaction pie): the engine's HAND weights over-weight
  // empirically-dead votes (ADX is weighted 3 but measured IC ≈ 0; RSI/MACD/Pat ≈ 0/negative) and
  // under-weight proven ones (Vol IC 0.074 at weight 1; Trend significant). icBackedShare = of the
  // weighted conviction pushing THIS signal's way, the fraction coming from the PROVEN votes. Low share
  // ⇒ the call rests on the over-weighted dead votes. A LABEL only (tests OOS whether that costs money).
  const IC_PROVEN_VOTES=["Trend","Vol","BB"];
  const sd=net>0?1:net<0?-1:0;
  let drvW=0, provW=0;
  for(const v of active){ if(sd!==0 && Math.sign(v.dir)===sd){ drvW+=v.w; if(IC_PROVEN_VOTES.includes(v.n)) provW+=v.w; } }
  const icBackedShare=drvW>0?parseFloat((provW/drvW).toFixed(3)):0;

  return {signal, score:parseFloat(net.toFixed(1)), bull, bear, conflict, confidence, trendDir, meanRevDir, famConflict, icBackedShare};
}

export function analyze(data, ticker, market, strategy, slMult, tpMult, opts={}) {
  const SLM = slMult || 1.5;
  const TPM = tpMult || 2.0;
  const closes=data.map(d=>d.close), vols=data.map(d=>d.volume);
  const last=data[data.length-1];
  const R=rsi(closes), M=macd(closes), B=bb(closes), S=stoch(data), A=atr(data);
  const s5=sma(closes,Math.min(5,closes.length));
  const s10=sma(closes,Math.min(10,closes.length));
  const s20=sma(closes,Math.min(20,closes.length));
  const s50=sma(closes,Math.min(50,closes.length));
  const pats=patterns(data);
  const div=divergence(closes);
  const ADX=adxCalc(data);
  const OBV=obvCalc(data);
  const VWAP=vwapCalc(data);

  const chg=(last.close-closes[0])/closes[0]*100;
  const trend=chg>2?"UPTREND":chg<-2?"DOWNTREND":"SIDEWAYS";
  const strength=Math.abs(chg)>8?"STRONG":Math.abs(chg)>3?"MODERATE":"WEAK";

  const avgV=vols.slice(0,-3).reduce((a,b)=>a+b,0)/Math.max(vols.length-3,1);
  const recV=vols.slice(-3).reduce((a,b)=>a+b,0)/3;
  const volSig=recV>avgV*1.15?"CONFIRMING":recV<avgV*0.85?"DIVERGING":"NEUTRAL";

  const ctx={R,M,s5,s10,s20,s50,trend,S,B,last,pats,div,volSig,ADX,OBV,VWAP};
  const sigResult=computeSignal(ctx);
  const score=sigResult.score;
  const signal=sigResult.signal;
  // Shadow-engine verdicts (team-minus-nuisance): when callers pass shadowDrops, recompute the team
  // signal with each named vote removed. Decision-only (BUY/HOLD/SELL) — the ledger compares the
  // shadow team's trades vs the full team's. Off by default (no overhead, no app change).
  let shadows=null;
  if(opts.shadowDrops && opts.shadowDrops.length){
    shadows={};
    for(const sc of opts.shadowDrops) shadows[sc.key]=computeSignal(ctx,[],{drop:sc.drop}).signal;
  }
  const confidence=sigResult.confidence;

  const sfa12=sfa12Series(data);
  const convBreakout=convergenceBreakout(data);
  const convBreakoutTest=backtestPattern(data);
  const sfa12Vote={n:"SFA12", dir: sfa12.state==="UPTREND"?1 : sfa12.state==="DOWNTREND"?-1 : 0, w:2};
  const pick=o=>({signal:o.signal,confidence:o.confidence,score:o.score,bull:o.bull,bear:o.bear});
  let sfa12Compare=null;
  if(sfa12.pct!=null){
    const sigNew=computeSignal(ctx, sfa12Vote.dir===0?[]:[sfa12Vote]);
    sfa12Compare={ old:pick(sigResult), new:pick(sigNew), vote:sfa12Vote, changed: sigResult.signal!==sigNew.signal };
  }

  const sup=Math.min(...data.slice(-Math.min(20,data.length)).map(d=>d.low));
  const res=Math.max(...data.slice(-Math.min(20,data.length)).map(d=>d.high));
  const e=last.close;
  const sl=signal==="BUY"?e-A*SLM:e+A*SLM;
  const tp1=signal==="BUY"?e+A*TPM:e-A*TPM;
  const tp2=signal==="BUY"?e+A*TPM*1.75:e-A*TPM*1.75;
  const rr=parseFloat((Math.abs(tp1-e)/Math.abs(sl-e)).toFixed(1));

  const rsiLabel=R?R>70?"OVERBOUGHT":R<30?"OVERSOLD":"NEUTRAL":"N/A";

  return {
    signal,confidence,trend,strength,
    entry:parseFloat(e.toFixed(4)),sl:parseFloat(sl.toFixed(4)),
    tp1:parseFloat(tp1.toFixed(4)),tp2:parseFloat(tp2.toFixed(4)),rr,
    support:parseFloat(sup.toFixed(4)),resistance:parseFloat(res.toFixed(4)),
    score,
    sfa12, sfa12Compare, convBreakout, convBreakoutTest, shadows,
    confluence:{bull:sigResult.bull,bear:sigResult.bear,conflict:sigResult.conflict,trendDir:sigResult.trendDir,meanRevDir:sigResult.meanRevDir,famConflict:sigResult.famConflict,icBackedShare:sigResult.icBackedShare},
    indicators:{
      rsi:{v:R,label:rsiLabel},
      stoch:{v:S,label:S>75?"OVERBOUGHT":S<25?"OVERSOLD":"NEUTRAL"},
      macd:{sig:M?(M.macd>0?"BULLISH":"BEARISH"):"N/A",desc:M?"MACD "+(M.macd>=0?"+":"")+M.macd.toFixed(3):"Insufficient data"},
      ma:{sig:s5&&s10?(s5>s10?"BULLISH":"BEARISH"):"N/A",s5,s10,s20,s50},
      bb:{sig:B?(last.close>B.upper?"BEARISH":last.close<B.lower?"BULLISH":"NEUTRAL"):"N/A",v:B},
      vol:{sig:volSig,recent:recV,avg:avgV},
      atr:parseFloat(A.toFixed(4)),
      adx:ADX?{sig:ADX.adx>25?(ADX.plusDI>ADX.minusDI?"BULLISH":"BEARISH"):"NEUTRAL",adx:ADX.adx,plusDI:ADX.plusDI,minusDI:ADX.minusDI}:null,
      obv:OBV?{sig:OBV.rising?"BULLISH":"BEARISH",rising:OBV.rising,v:OBV.obv}:null,
      vwap:VWAP?{sig:last.close>VWAP?"BULLISH":"BEARISH",v:VWAP}:null,
    },
    patterns:pats, divergence:div,
    levels:[
      {price:parseFloat(sup.toFixed(4)),type:"SUPPORT",strength:"STRONG"},
      {price:parseFloat(res.toFixed(4)),type:"RESISTANCE",strength:"STRONG"},
      ...(B?[
        {price:parseFloat(B.lower.toFixed(4)),type:"SUPPORT",strength:"MODERATE"},
        {price:parseFloat(B.upper.toFixed(4)),type:"RESISTANCE",strength:"MODERATE"},
      ]:[]),
    ],
    risks:[
      "Support at "+fmt(sup)+" — breach would invalidate bullish thesis",
      volSig==="DIVERGING"?"Volume declining — weakening conviction in current move":"Monitor for volume confirmation on breakout",
      R&&R>70?"RSI overbought at "+R+" — momentum may stall soon":R&&R<30?"RSI oversold at "+R+" — bounce possible":"RSI "+R+" — no extreme readings",
    ],
    reasoning:
      ticker+" ("+market+") shows a "+strength.toLowerCase()+" "+trend.toLowerCase()+" over the "+data.length+"-candle period. "+
      (M?M.macd>0?"MACD positive ("+M.macd.toFixed(3)+") — bullish momentum active. ":"MACD negative ("+M.macd.toFixed(3)+") — bearish pressure. ":"")+
      (R?"RSI "+R+" ("+rsiLabel+"). ":"")+
      (div?div.desc+" ":"")+
      (pats.length?pats[0].name+" pattern detected. ":"")+
      "Score "+score+" → "+signal+" at "+confidence+"% confidence using "+strategy+".",
    bias:
      signal==="BUY"?"Test of resistance near "+fmt(res)+" expected. Volume confirmation required. Trail stop as price moves in your favour.":
      signal==="SELL"?"Retest of support near "+fmt(sup)+" expected. Any rallies should be treated as selling opportunities.":
      "Consolidation between "+fmt(sup)+"–"+fmt(res)+" likely. Wait for a decisive breakout with volume before entering.",
  };
}

// ─── Scorers (backtest signal at a slice) ────────────────────────────────────
export function scorePosition(slice){
  if(slice.length<30)return null;
  const cl=slice.map(d=>d.close),last=slice[slice.length-1];
  // The long-term trend filter is only meaningful with a TRUE 200-bar window. With less
  // history we must NOT silently trade a short-SMA proxy (the old Math.min(200,len) bug) —
  // report "not engaged" honestly so POSITION holds instead of acting on a fake trend.
  if(cl.length<200) return {score:0, signal:"HOLD", atr:atr(slice), engaged:false,
    reason:"long-term trend needs 200 bars; have "+cl.length, trendStrength:0, dipDepth:0};
  const s50=sma(cl,50), s200=sma(cl,200), R=rsi(cl);
  if(!s50||!s200) return {score:0, signal:"HOLD", atr:atr(slice), engaged:false,
    reason:"insufficient data", trendStrength:0, dipDepth:0};
  const longUptrend = last.close>s200 && s50>s200;
  const longDowntrend = last.close<s200 && s50<s200;
  let signal="HOLD", score=0;
  if(longUptrend){
    score=3;
    if(R!=null && R<45){ signal="BUY"; score=6; }  // buy a pullback within the uptrend
  } else if(longDowntrend){
    score=-6; signal="SELL";                        // long-term thesis broken — exit/avoid
  }
  // Position-native conviction inputs (used instead of the tactical confluence number):
  //  trendStrength = how far SMA50 sits above SMA200 (regime conviction);
  //  dipDepth      = how far RSI is below the 45 buy threshold (entry conviction).
  return { score, signal, atr:atr(slice), engaged:true,
    trendStrength: s200>0 ? (s50-s200)/s200 : 0,
    dipDepth: (longUptrend && R!=null) ? Math.max(0, 45-R) : 0 };
}

export function scoreFlat(slice){
  if(slice.length<26)return null;
  const cl=slice.map(d=>d.close),last=slice[slice.length-1];
  const R=rsi(cl),M=macd(cl),B=bb(cl),S=stoch(slice);
  const s5=sma(cl,5),s10=sma(cl,10),s20=sma(cl,20),s50=sma(cl,Math.min(50,cl.length));
  const pats=patterns(slice),div=divergence(cl);
  const ADX=adxCalc(slice),OBV=obvCalc(slice),VWAP=vwapCalc(slice);
  const chg=(last.close-cl[0])/cl[0]*100,trend=chg>2?"UPTREND":chg<-2?"DOWNTREND":"SIDEWAYS";
  let s=0;
  if(R!=null)s+=R<40?3:R>70?-3:R<50?1:-1;
  if(M)s+=M.macd>0?2:-2;
  if(s5&&s10)s+=s5>s10?1:-1;
  if(s10&&s20)s+=s10>s20?1:-1;
  if(s20&&s50)s+=s20>s50?1:-1;
  s+=trend==="UPTREND"?2:trend==="DOWNTREND"?-2:0;
  if(S!=null)s+=S<25?2:S>75?-2:0;
  if(B)s+=last.close<B.lower?2:last.close>B.upper?-2:0;
  pats.forEach(p=>{s+=p.type==="BULLISH"?2:p.type==="BEARISH"?-2:0;});
  if(div?.type==="BULLISH")s+=3; if(div?.type==="BEARISH")s-=3;
  if(ADX&&ADX.adx>25)s+=ADX.plusDI>ADX.minusDI?2:-2;else if(ADX&&ADX.adx>20)s+=ADX.plusDI>ADX.minusDI?1:-1;
  if(OBV)s+=OBV.rising?1:-1;
  if(VWAP)s+=last.close>VWAP?1:-1;
  return{score:s,signal:s>=4?"BUY":s<=-4?"SELL":"HOLD",atr:atr(slice)};
}

export function scoreAt(slice, drop=null) {
  if (slice.length < 26) return null;
  const closes = slice.map(d=>d.close), vols = slice.map(d=>d.volume);
  const last = slice[slice.length-1];
  const R=rsi(closes), M=macd(closes), B=bb(closes), S=stoch(slice);
  const s5=sma(closes,5), s10=sma(closes,10), s20=sma(closes,20), s50=sma(closes,Math.min(50,closes.length));
  const pats=patterns(slice), div=divergence(closes);
  const ADX=adxCalc(slice), OBV=obvCalc(slice), VWAP=vwapCalc(slice);
  const chg=(last.close-closes[0])/closes[0]*100;
  const trend=chg>2?"UPTREND":chg<-2?"DOWNTREND":"SIDEWAYS";
  const avgV=vols.slice(0,-3).reduce((a,b)=>a+b,0)/Math.max(vols.length-3,1);
  const recV=vols.slice(-3).reduce((a,b)=>a+b,0)/3;
  const volSig=recV>avgV*1.15?"CONFIRMING":recV<avgV*0.85?"DIVERGING":"NEUTRAL";
  // `drop` (shadow backtests): run the same team signal with named votes removed. Default null = unchanged.
  const r=computeSignal({R,M,s5,s10,s20,s50,trend,S,B,last,pats,div,volSig,ADX,OBV,VWAP}, [], (drop&&drop.length)?{drop}:{});
  return {score:r.score, signal:r.signal, atr:atr(slice)};
}

// ─── Shared trade-exit + stats helpers ───────────────────────────────────────
// Factored out of runBacktest so the forward-test logger marks positions to
// market with the IDENTICAL math (SL-first tie, cost model, significance). The
// browser's runBacktest is refactored to call these too — parity by construction.

// One bar's exit test. SL is checked FIRST so a bar that straddles both SL and
// TP counts as a LOSS (pessimistic) — the original runBacktest convention.
export function checkBarExit(t, candle){
  if(t.dir==="BUY"){
    if(candle.low<=t.sl)   return {exit:t.sl, result:"LOSS"};
    if(candle.high>=t.tp)  return {exit:t.tp, result:"WIN"};
  } else { // SELL
    if(candle.high>=t.sl)  return {exit:t.sl, result:"LOSS"};
    if(candle.low<=t.tp)   return {exit:t.tp, result:"WIN"};
  }
  return null;
}

// True when a bar straddles BOTH stop and target — the case where coarse OHLC
// cannot tell which was hit first, and checkBarExit has to guess (pessimistically).
export function isAmbiguousBar(t, candle){
  if(t.dir==="BUY")  return candle.low<=t.sl && candle.high>=t.tp;
  return candle.high>=t.sl && candle.low<=t.tp;
}

// Resolve a bar's exit using FINER sub-bars when the coarse bar is ambiguous.
// On a daily (or any coarse) bar that straddles both SL and TP, the true order is
// unknowable from OHLC alone — so checkBarExit books a pessimistic LOSS, which
// systematically understates winners. Given the finer bars that make up the coarse
// bar (e.g. Polygon minute or second aggregates), we replay them in time order and
// take the FIRST real touch. Falls back to the pessimistic checkBarExit only when
// no sub-bars are supplied, so behavior is unchanged unless finer data is provided.
// `subBars` must be the finer bars within this coarse bar, ascending by time.
export function checkBarExitFine(t, candle, subBars){
  if(!isAmbiguousBar(t, candle) || !subBars || !subBars.length){
    return checkBarExit(t, candle);
  }
  for(const sb of subBars){
    const ex = checkBarExit(t, sb);
    if(ex) return { ...ex, resolvedBy: "subbars" };
  }
  // Sub-bars never tagged a level (gap/rounding) — fall back to the safe convention.
  return checkBarExit(t, candle);
}

// Net P&L of a closed trade after round-trip costs (slip+comm, entry+exit).
export function tradeNet(dir, entry, exit, costPerTrade){
  const pnl = dir==="BUY" ? (exit-entry) : (entry-exit);
  const grossPct = pnl/entry*100;
  const pnlPct = parseFloat((grossPct - (costPerTrade||0)).toFixed(4));
  return {pnl, grossPct, pnlPct};
}

// Aggregate stats + equity curve over an array of CLOSED trades (each with
// .result and .pnlPct/.grossPct). Single source of the significance verdict.
export function realizedStats(trades){
  const wins=trades.filter(t=>t.result==="WIN");
  const losses=trades.filter(t=>t.result==="LOSS");
  const totalPnlPct=trades.reduce((a,t)=>a+t.pnlPct,0);
  const totalGrossPct=trades.reduce((a,t)=>a+(t.grossPct||t.pnlPct),0);
  const grossWin=wins.reduce((a,t)=>a+t.pnlPct,0);
  const grossLoss=Math.abs(losses.reduce((a,t)=>a+t.pnlPct,0));
  const winRate=trades.length?wins.length/trades.length*100:0;
  const avgWin=wins.length?grossWin/wins.length:0;
  const avgLoss=losses.length?grossLoss/losses.length:0;
  const profitFactor=grossLoss>0?grossWin/grossLoss:(grossWin>0?Infinity:0);
  const expectancy=trades.length?totalPnlPct/trades.length:0;
  const totalCostDrag=totalGrossPct-totalPnlPct;
  const netWins=trades.filter(t=>t.pnlPct>0).length;

  let equity=0;
  const curve=trades.map(t=>{equity+=t.pnlPct; return parseFloat(equity.toFixed(2));});

  const rets=trades.map(t=>t.pnlPct);
  const nT=rets.length;
  const mean=nT?rets.reduce((a,b)=>a+b,0)/nT:0;
  const variance=nT?rets.reduce((a,b)=>a+Math.pow(b-mean,2),0)/nT:0;
  const stdDev=Math.sqrt(variance);
  const sharpe=stdDev>0?mean/stdDev:0;
  let peak=0,maxDD=0;
  curve.forEach(eq=>{if(eq>peak)peak=eq;const dd=peak-eq;if(dd>maxDD)maxDD=dd;});
  let cl=0,maxConsecLoss=0;
  rets.forEach(x=>{if(x<=0){cl++;if(cl>maxConsecLoss)maxConsecLoss=cl;}else cl=0;});
  const se=stdDev>0?stdDev/Math.sqrt(nT):0;
  const tStat=se>0?mean/se:0;
  let significance="NOT SIGNIFICANT";
  if(nT<10) significance="TOO FEW TRADES";
  else if(nT>=30&&Math.abs(tStat)>2) significance="SIGNIFICANT";
  else if(nT>=20&&Math.abs(tStat)>1.5) significance="SUGGESTIVE";

  return {
    stats:{
      total:trades.length, wins:wins.length, losses:losses.length,
      winRate:parseFloat(winRate.toFixed(1)),
      avgWin:parseFloat(avgWin.toFixed(2)),
      avgLoss:parseFloat(avgLoss.toFixed(2)),
      totalReturn:parseFloat(totalPnlPct.toFixed(2)),
      grossReturn:parseFloat(totalGrossPct.toFixed(2)),
      costDrag:parseFloat(totalCostDrag.toFixed(2)),
      netWins,
      profitFactor:profitFactor===Infinity?"∞":parseFloat(profitFactor.toFixed(2)),
      expectancy:parseFloat(expectancy.toFixed(2)),
      sharpe:parseFloat(sharpe.toFixed(2)),
      maxDrawdown:parseFloat(maxDD.toFixed(2)),
      maxConsecLoss,
      stdDev:parseFloat(stdDev.toFixed(2)),
      tStat:parseFloat(tStat.toFixed(2)),
      significance,
    },
    curve,
  };
}

// A backtested edge earns a loud, *actionable* surface only when it is BOTH
// statistically resolved AND positive. The original gate keyed on the t-stat's
// magnitude alone — so a SIGNIFICANT *negative* edge (t≪0, a proven money-loser)
// read as "proven" and was shown/traded. It must be muted, not shown. This single
// predicate gates the live UI and the forward-test logger identically.
//   proven      — strong (SIGNIFICANT) AND makes money
//   shown       — at least SUGGESTIVE AND makes money
//   negativeEdge— resolved (≥SUGGESTIVE) but loses money (the bug this fixes)
//   muted       — anything not (resolved AND positive): unproven OR a proven loser
export function edgeStatus(stats){
  const verdict  = stats?.significance ?? null;
  const exp      = stats?.expectancy ?? 0;
  const resolved = verdict==="SIGNIFICANT" || verdict==="SUGGESTIVE";
  const positive = exp > 0;
  return {
    verdict,
    proven:       verdict==="SIGNIFICANT" && positive,
    shown:        resolved && positive,
    muted:        !(resolved && positive),
    negativeEdge: resolved && !positive,
  };
}

// ─── Backtest engine ─────────────────────────────────────────────────────────
export function runBacktest(data, scorer, slMult, tpMult, costs, range, holdMode) {
  const scoreFn = scorer || scoreAt;
  const SLM = slMult || 1.5;
  const TPM = tpMult || 2.0;
  const TRAIL_MULT = 3;               // POSITION trailing-stop width in ATRs (hold mode only)
  const slipPct = costs?.slip || 0;   // % per side
  const commPct = costs?.comm || 0;   // % per side
  const costPerTrade = (slipPct + commPct) * 2; // entry + exit
  const startIdx = range?.start!=null ? Math.max(30, range.start) : 30;
  const endIdx   = range?.end!=null   ? range.end : data.length;
  const trades=[];
  let openTrade=null;
  let pending=null; // signal queued on prior bar, fills at THIS bar's open (no lookahead)
  for (let i=startIdx; i<endIdx; i++) {
    const slice=data.slice(0,i+1);
    const candle=data[i];

    // 1) Fill any pending entry at THIS bar's OPEN (realistic — no lookahead)
    if (pending && !openTrade) {
      const entry=candle.open;
      const A=pending.atr;
      openTrade={
        dir:pending.dir, entry, openIndex:i, entryDate:candle.date,
        // Custom per-trade targets (e.g. the Outlook correction levels) override the ATR
        // default when the scorer supplies them; otherwise the ATR fallback is unchanged.
        sl: pending.customSl!=null ? pending.customSl : (pending.dir==="BUY"?entry-A*SLM:entry+A*SLM),
        tp: pending.customTp!=null ? pending.customTp : (pending.dir==="BUY"?entry+A*TPM:entry-A*TPM),
        score:pending.score, atr:A, highWater:entry,
      };
      pending=null;
    }

    // 2) Manage an open trade
    if (openTrade) {
      const t=openTrade;
      let closed=false;
      if (holdMode && t.dir==="BUY") {
        // POSITION: a TRAILING stop (let winners run — no fixed TP cap) ratcheting up from the
        // initial wide stop, plus a thesis-break exit. The trail level uses the high-water mark
        // as of PRIOR bars (updated only AFTER this bar's exit check → no intrabar lookahead).
        const trailStop = Math.max(t.sl, t.highWater - t.atr*TRAIL_MULT);
        if (candle.low <= trailStop) {
          t.exit=trailStop; t.result = trailStop>=t.entry ? "WIN" : "LOSS"; closed=true;
        } else {
          t.highWater = Math.max(t.highWater, candle.high);
          const sNow=scoreFn(slice);                      // exit if the long-term thesis breaks
          if (sNow && sNow.signal==="SELL") {
            t.exit=candle.close; t.result = candle.close>=t.entry ? "WIN" : "LOSS"; closed=true;
          }
        }
      } else {
        const ex=checkBarExit(t, candle);                 // tactical: SL/TP touch, SL-first tie
        if (ex) { t.exit=ex.exit; t.result=ex.result; closed=true; }
      }
      if (closed) {
        t.exitDate=candle.date;
        const net=tradeNet(t.dir, t.entry, t.exit, costPerTrade);
        t.pnl=net.pnl; t.grossPct=net.grossPct; t.pnlPct=net.pnlPct;
        t.barsHeld = i - t.openIndex;
        trades.push(t);
        openTrade=null;
      }
    }

    // 3) Generate a signal on THIS bar's close → queue it for NEXT bar's open
    if (!openTrade && !pending) {
      const r=scoreFn(slice);
      if (r && (r.signal==="BUY"||r.signal==="SELL") && r.atr>0) {
        pending={dir:r.signal, atr:r.atr, score:r.score, customSl:r.customSl, customTp:r.customTp};
      }
    }
  }

  const {stats,curve}=realizedStats(trades);
  return { trades, openTrade, stats, curve };
}

// ─── Outlook "market correction period" projection math (pure, app-mirrored) ──
// The OUTLOOK tab projects a stock's near-term price from the AVERAGE trailing-window
// gain of the three major indexes, with an error-buffered target/stop. Pure so the app
// and the tests share one implementation; mirrored byte-for-byte into index.html.

// Average cumulative % move of N index series over a trailing `period`, keyed by date.
// Point-in-time per index ((close[p]-close[p-period])/close[p-period]); a date is only
// emitted when EVERY index has a full-window value for it (exact date alignment).
export function avgIndexGainByDate(idxArrays, period=20){
  const arrs=(idxArrays||[]).filter(a=>Array.isArray(a)&&a.length>period);
  if(!arrs.length) return new Map();
  const perIdx=arrs.map(a=>{
    const m=new Map();
    for(let p=period;p<a.length;p++){
      const c0=a[p-period].close, c1=a[p].close;
      if(c0>0&&c1!=null) m.set(a[p].date,(c1-c0)/c0*100);
    }
    return m;
  });
  const out=new Map();
  for(const [date,v0] of perIdx[0]){
    let sum=v0, ok=true;
    for(let k=1;k<perIdx.length;k++){ const v=perIdx[k].get(date); if(v==null){ok=false;break;} sum+=v; }
    if(ok) out.set(date, sum/perIdx.length);
  }
  return out;
}

// Error-buffered target/stop from a projected gain. mag = |entry·gain%|; the target ADDS
// the average projection error as a buffer (generous — let it run); the stop SUBTRACTS the
// LESSER of the projection magnitude and the error (tight — an early red-flag exit level).
export function correctionLevels({entry, gainsPct, avgErr=0}){
  const delta=entry*(gainsPct||0)/100;
  const mag=Math.abs(delta);
  const err=Math.abs(avgErr||0);
  return { delta, mag, tp: entry+mag+err, sl: entry-Math.min(mag,err) };
}

// Full P&L backtest of the correction projection vs matched buy-&-hold (alpha-honest).
// Long-only (BUY when close≥SMA20); per bar the projected gain (as-of that date) plus an
// EXPANDING-window avg projection error (PRIOR bars only → no lookahead) set the custom
// TP/SL fed through runBacktest. Reports realized stats, directional accuracy, and the
// per-trade alpha vs a price-only buy-&-hold over the identical entry→exit window. The
// `proven` gate is alpha-honest: never green without ≥20 trades, significance, AND meanAlpha>0.
export function backtestCorrection(stockData, gainByDate, opts={}){
  const period=opts.period||20;
  const costs=opts.costs||{slip:0,comm:0};
  const data=stockData||[];
  if(data.length<period+2||!gainByDate) return null;
  const closes=data.map(d=>d.close);

  // Per-bar projection error (point-in-time): projected = close ± (close·gain%) in the
  // trend's direction; error vs the NEXT close. Feeds both the accuracy stats and the
  // expanding avgErr buffer (which only ever reads bars whose outcome is already known).
  const projErr=new Array(data.length).fill(null);
  let n=0,hits=0,baseHits=0,errSum=0,pctErrSum=0;
  for(let i=period;i<data.length-1;i++){
    const g=gainByDate.get(data[i].date); if(g==null) continue;
    const sma20=sma(closes.slice(0,i+1),20); if(sma20==null) continue;
    const trendUp=closes[i]>=sma20;
    const predMove=(trendUp?1:-1)*closes[i]*g/100;
    const projected=closes[i]+predMove;
    const actualMove=closes[i+1]-closes[i];
    projErr[i]=Math.abs(projected-closes[i+1]);
    if(predMove!==0&&actualMove!==0){
      n++;
      if(Math.sign(predMove)===Math.sign(actualMove)) hits++;
      if((trendUp?1:-1)===Math.sign(actualMove)) baseHits++;
      errSum+=projErr[i]; pctErrSum+=projErr[i]/closes[i+1]*100;
    }
  }
  // avgErrBefore[k] = mean projection error over bars strictly before k (no lookahead).
  const avgErrBefore=new Array(data.length).fill(0);
  { let s=0,c=0; for(let k=0;k<data.length;k++){ avgErrBefore[k]=c?s/c:0; if(projErr[k]!=null){s+=projErr[k];c++;} } }

  // Long-only correction scorer → custom error-buffered TP/SL via correctionLevels.
  const scorer=(slice)=>{
    const i=slice.length-1;
    const cl=slice.map(d=>d.close);
    const sma20=sma(cl,20); if(sma20==null) return {signal:"HOLD"};
    const a=atr(slice,14);
    const g=gainByDate.get(slice[i].date);
    if(g==null||g===0||!(cl[i]>=sma20)) return {signal:"HOLD", atr:a};
    const lv=correctionLevels({entry:cl[i], gainsPct:g, avgErr:avgErrBefore[i]});
    return {signal:"BUY", atr:a, score:g, customSl:lv.sl, customTp:lv.tp};
  };
  const bt=runBacktest(data, scorer, 1.5, 2.0, costs, null, false);

  // Alpha vs matched buy-&-hold: same entry, held to the SAME exit bar's close (price-only;
  // the forward-perf buyHoldGrossPct pattern, inlined for engine↔app parity).
  const legs=bt.trades.map(t=>{
    const exitIdx=t.openIndex+t.barsHeld;
    const benchClose=data[exitIdx]?data[exitIdx].close:t.exit;
    const benchPct=(benchClose-t.entry)/t.entry*100;
    return { stratPct:t.pnlPct, benchPct, alpha:t.pnlPct-benchPct, beat:t.pnlPct>benchPct };
  });
  const m=legs.length;
  const meanAlpha=m?legs.reduce((a,l)=>a+l.alpha,0)/m:null;
  const beatRate=m?legs.filter(l=>l.beat).length/m*100:null;
  const sig=bt.stats.significance;
  const proven=m>=20 && (sig==="SIGNIFICANT"||sig==="SUGGESTIVE") && meanAlpha>0;

  return {
    n, acc:n?hits/n*100:null, baseline:n?baseHits/n*100:null,
    edge:n?(hits-baseHits)/n*100:null,
    avgErr:n?errSum/n:null, avgPctErr:n?pctErrSum/n:null,
    trades:m, stats:bt.stats, meanAlpha, beatRate, proven,
  };
}

// ─── Buffett-style fundamental VALUE score (for the fundamentalGrade tag) ─────
export function valueScore(m){
  if(!m) return null;
  const flags=[], reasons=[];
  let cheap=0, healthy=0, growing=0;
  const num=v=>(v==null||isNaN(v))?null:Number(v);
  const pe=num(m.peTTM), pb=num(m.pbAnnual), de=num(m["totalDebt/totalEquityAnnual"]);
  const roe=num(m.roeTTM), npm=num(m.netProfitMarginTTM), cr=num(m.currentRatioAnnual);
  const revG=num(m.revenueGrowthTTMYoy), epsG=num(m.epsGrowthTTMYoy);

  if(pe!=null){
    if(pe>0&&pe<15){cheap+=2; reasons.push("P/E "+pe.toFixed(1)+" — attractively valued");}
    else if(pe>=15&&pe<25){cheap+=1; reasons.push("P/E "+pe.toFixed(1)+" — fairly valued");}
    else if(pe>=25){cheap-=1; reasons.push("P/E "+pe.toFixed(1)+" — expensive");}
    else if(pe<=0){flags.push("Negative earnings — no positive P/E");}
  }
  if(pb!=null){
    if(pb>0&&pb<1.5){cheap+=2; reasons.push("P/B "+pb.toFixed(2)+" — near/below book value");}
    else if(pb>=1.5&&pb<3){cheap+=1;}
    else if(pb>=5){cheap-=1; reasons.push("P/B "+pb.toFixed(2)+" — pricey vs assets");}
  }
  if(de!=null){
    if(de<0.5){healthy+=2; reasons.push("Debt/equity "+de.toFixed(2)+" — strong balance sheet");}
    else if(de<1){healthy+=1;}
    else if(de>2){healthy-=2; flags.push("High debt/equity "+de.toFixed(2));}
  }
  if(roe!=null){
    if(roe>0.15){healthy+=2; reasons.push("ROE "+(roe*100).toFixed(0)+"% — efficient capital use");}
    else if(roe>0.08){healthy+=1;}
    else if(roe<0){healthy-=2; flags.push("Negative ROE");}
  }
  if(npm!=null){
    if(npm>0.20){healthy+=2; reasons.push("Net margin "+(npm*100).toFixed(0)+"% — highly profitable");}
    else if(npm>0.10){healthy+=1;}
    else if(npm<0){healthy-=2; flags.push("Unprofitable — negative margin");}
  }
  if(cr!=null){
    if(cr>1.5){healthy+=1; reasons.push("Current ratio "+cr.toFixed(1)+" — liquid");}
    else if(cr<1){healthy-=1; flags.push("Current ratio <1 — liquidity risk");}
  }
  if(revG!=null){
    if(revG>0.15){growing+=2; reasons.push("Revenue +"+(revG*100).toFixed(0)+"% — expanding strongly");}
    else if(revG>0.05){growing+=1;}
    else if(revG<0){growing-=1; flags.push("Revenue shrinking");}
  }
  if(epsG!=null){
    if(epsG>0.15){growing+=2; reasons.push("EPS +"+(epsG*100).toFixed(0)+"% — earnings rising");}
    else if(epsG>0){growing+=1;}
    else if(epsG<0){growing-=1;}
  }

  const total=cheap+healthy+growing;
  let grade,verdict;
  if(total>=10){grade="A";verdict="STRONG VALUE — cheap, healthy, and growing. The kind of business a value screen flags for deeper study.";}
  else if(total>=6){grade="B";verdict="GOOD — solid fundamentals with real appeal. Worth a closer look.";}
  else if(total>=2){grade="C";verdict="FAIR — mixed picture. Some strengths, some concerns.";}
  else if(total>=-2){grade="D";verdict="WEAK — limited fundamental appeal at current price.";}
  else{grade="F";verdict="POOR — expensive and/or financially strained. A value investor would likely pass.";}

  const hasData = [pe,pb,de,roe,npm,cr,revG,epsG].some(v=>v!=null);
  return hasData ? {cheap,healthy,growing,total,grade,verdict,reasons,flags} : null;
}

// ─── Formatting ────────────────────────────────────────────────────────────
export function fmt(v,dec) {
  if(v==null||isNaN(v)) return "—";
  const d=dec!=null?dec:Math.abs(v)>=100?2:4;
  return "$"+Number(v).toFixed(d);
}
