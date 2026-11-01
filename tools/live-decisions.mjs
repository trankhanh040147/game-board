import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:2 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,150));});
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,700));
await page.evaluate(()=>{
  document.querySelector('[data-act="begin"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
});
await new Promise(r=>setTimeout(r,600));
await page.evaluate(()=>{ document.querySelector('[data-act="skip"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await new Promise(r=>setTimeout(r,500));
await page.evaluate(()=>{ const g=window.__game; g.resume(); g.setSpeed(2); window.__frames=[]; let last=performance.now(); const loop=(n)=>{window.__frames.push(n-last); last=n; requestAnimationFrame(loop);}; requestAnimationFrame(loop); });
await new Promise(r=>setTimeout(r,1500));
const pre = await page.evaluate(()=>({paused:window.__game.paused, tick:window.__game.state.tick, speed:window.__game.speed}));
console.log('pre', JSON.stringify(pre));
const out = await page.evaluate(async ()=>{
  const g=window.__game; g.resume(); g.setSpeed(2);
  const t0=performance.now(); const decisions=[]; const t0tick=g.state.tick;
  return await new Promise(resolve=>{
    const iv=setInterval(()=>{
      const dt=(performance.now()-t0)/1000;
      const p=g.state.events.pending;
      if(p.length){
        const d=p[0];
        decisions.push({at:+dt.toFixed(1), tick:g.state.tick, title:d.title, pass:!!document.querySelector('[data-choice="__none"]')});
        document.querySelector('[data-choice="__none"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      }
      if(dt>70){
        clearInterval(iv);
        const f=window.__frames.slice(3); const a=f.reduce((s,v)=>s+v,0)/Math.max(1,f.length); const sorted=[...f].sort((x,y)=>x-y);
        resolve({decisions, tickStart:t0tick, tickEnd:g.state.tick, pending:g.state.events.pending.length, paused:g.paused, fps:+(1000/a).toFixed(1), p95:+sorted[Math.floor(sorted.length*0.95)]?.toFixed(1), maxFrame:+sorted[sorted.length-1]?.toFixed(1), history:g.state.events.history.length});
      }
    },350);
  });
});
console.log(JSON.stringify({out, errors},null,2));
await page.screenshot({path:'shots/accept-live-2.png'});
await browser.close();
