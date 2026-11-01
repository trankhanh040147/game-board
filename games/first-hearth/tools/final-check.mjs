import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:2 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,150));});
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,800));
// welcome + tour
await page.evaluate(()=>document.querySelector('[data-act="begin"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})));
await new Promise(r=>setTimeout(r,700));
const tour1 = await page.evaluate(()=>({tour:!!document.querySelector('.fh-tour'), text:document.querySelector('.fh-tour')?.innerText?.replace(/\s+/g,' ').slice(0,90), paused:window.__game.paused, steps:document.querySelectorAll('.fh-tour-dot').length}));
// skip tour, play 25s at speed 3
await page.evaluate(()=>document.querySelector('[data-act="skip"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})));
await new Promise(r=>setTimeout(r,400));
await page.evaluate(()=>{ const g=window.__game; g.resume(); g.setSpeed(3); window.__f=[]; window.__longs=[]; let last=performance.now(); const loop=(n)=>{window.__f.push(n-last); last=n; requestAnimationFrame(loop);}; requestAnimationFrame(loop); try{new PerformanceObserver(l=>{for(const e of l.getEntries())window.__longs.push(Math.round(e.duration));}).observe({entryTypes:['longtask']});}catch{} });
await new Promise(r=>setTimeout(r,25000));
const perf = await page.evaluate(()=>{ const g=window.__game; const f=window.__f.slice(5); const avg=f.reduce((s,v)=>s+v,0)/Math.max(1,f.length); const sorted=[...f].sort((x,y)=>x-y); return {fps:+(1000/avg).toFixed(1), p95:+sorted[Math.floor(sorted.length*0.95)]?.toFixed(1), maxFrame:+sorted[sorted.length-1]?.toFixed(1), longTasks:window.__longs.filter(d=>d>0), tick:g.state.tick, pop:g.state.settlements[0].population, pending:g.state.events.pending.length, paused:g.paused, firstStepsVisible:!!document.querySelector('.fh-firststeps'), tourHiddenByCss:getComputedStyle(document.querySelector('.fh-firststeps')).opacity}; });
await page.screenshot({path:'shots/final-acceptance.png'});
// loaded-save tour check: save, reload, tour should appear even though tick>1
await page.evaluate(()=>{ window.__game.save('first-hearth.save.v1'); });
await page.reload({waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,2500));
const loaded = await page.evaluate(()=>({ tick:window.__game.state.tick, tour:!!document.querySelector('.fh-tour'), tourKey:localStorage.getItem('fh-tour-v1'), welcome:!!document.querySelector('.fh-welcome') }));
console.log(JSON.stringify({tour1, perf, loaded, errors},null,2));
await browser.close();
