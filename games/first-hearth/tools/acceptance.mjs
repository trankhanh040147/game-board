import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:2 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
const errors=[];
page.on('pageerror', e=>errors.push('PAGEERROR '+e.message));
page.on('console', m=>{ if(m.type()==='error') errors.push('CONSOLE '+m.text().slice(0,200)); });
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,800));
// 1. welcome then tour
const step1 = await page.evaluate(()=>{
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game;
  return { tourVisible: !!document.querySelector('.fh-tour'), paused:g.paused, tick:g.state.tick, welcomeGone: !document.querySelector('.fh-welcome') };
});
await new Promise(r=>setTimeout(r,600));
await page.screenshot({ path:'shots/accept-tour-start.png' });
// advance tour 8 times via Next
const stepInfo = await page.evaluate(async ()=>{
  const out=[];
  for(let i=0;i<10;i++){
    const next=document.querySelector('[data-tour="next"]') ?? [...document.querySelectorAll('button')].find(b=>/next/i.test(b.textContent??''));
    const active=!!document.querySelector('.fh-tour');
    out.push({step:i, active, title:document.querySelector('.fh-tour-title')?.textContent ?? null});
    if(!active) break;
    next?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
    await new Promise(r=>setTimeout(r,120));
  }
  return out;
});
const afterTour = await page.evaluate(()=>{
  const g=window.__game;
  return { tourKey: localStorage.getItem('fh-tour-v1'), tourVisible: !!document.querySelector('.fh-tour'), paused:g.paused, tick:g.state.tick, firstSteps: !!document.querySelector('[class*=first-steps]') };
});
await page.screenshot({ path:'shots/accept-after-tour.png' });
// 2. resume and measure fps 5s
await page.evaluate(()=>{ const g=window.__game; if(g.paused && g.state.events.pending.length===0) g.resume(); g.setSpeed(2); window.__f=[]; let last=performance.now(); const loop=(n)=>{window.__f.push(n-last); last=n; requestAnimationFrame(loop);}; requestAnimationFrame(loop); });
await new Promise(r=>setTimeout(r,5000));
const perf = await page.evaluate(()=>{ const f=window.__f.slice(3); const a=f.reduce((s,v)=>s+v,0)/Math.max(1,f.length); const sorted=[...f].sort((x,y)=>x-y); return {fps:+(1000/a).toFixed(1),p95:+sorted[Math.floor(sorted.length*0.95)]?.toFixed(1),max:+sorted[sorted.length-1]?.toFixed(1), tick:window.__game.state.tick}; });
// 3. live decisions for 70s
const dec = await page.evaluate(async ()=>{
  const g=window.__game; g.resume(); g.setSpeed(2);
  const t0=performance.now(); const log=[]; let openCount=0;
  return await new Promise(resolve=>{
    const iv=setInterval(()=>{
      const dt=(performance.now()-t0)/1000;
      const p=g.state.events.pending;
      if(p.length){
        openCount++;
        const d=p[0];
        const pass=document.querySelector('[data-choice="__none"]');
        log.push({at:+dt.toFixed(1), tick:g.state.tick, title:d.title, passBtn:!!pass, paused:g.paused});
        pass?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      }
      if(dt>70){ clearInterval(iv); resolve({openCount, log, tick:g.state.tick, pending:g.state.events.pending.length, paused:g.paused, history:g.state.events.history.length}); }
    },400);
  });
});
await page.screenshot({ path:'shots/accept-live.png' });
const finalTick = await page.evaluate(()=>window.__game.state.tick);
console.log(JSON.stringify({step1, stepInfo, afterTour, perf, dec, finalTick, errors}, null, 2));
await browser.close();
