import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:2 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,600));
await page.evaluate(()=>{
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game; const s=g.state;
  s.flags.auto_research=1; s.research.era=2;
  for(const id of g.content.techOrder){const t=g.content.techs[id]; if(t&&t.era<=1)s.research.completed[id]=s.tick;}
  g.advanceDays(200);
  s.events.pending=[]; s.events.warnings=[];
  g.resume(); g.setSpeed(2);
  window.__frames=[]; let last=performance.now();
  const loop=(now)=>{ window.__frames.push(now-last); last=now; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});
async function measure(label, action, ms=4000){
  await page.evaluate(action);
  await new Promise(r=>setTimeout(r,ms));
  const res = await page.evaluate(()=>{ const f=window.__frames.splice(0); const a=f.slice(5); const avg=a.reduce((s,v)=>s+v,0)/Math.max(1,a.length); const sorted=[...a].sort((x,y)=>x-y); return {fps:+(1000/avg).toFixed(1), p95:+sorted[Math.floor(sorted.length*0.95)]?.toFixed(1), max:+sorted[sorted.length-1]?.toFixed(1)}; });
  console.log(label, JSON.stringify(res));
}
await measure('baseline', ()=>{});
await measure('codex', ()=>{ document.querySelector('[data-rail="codex"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await measure('codex-scroll', ()=>{ document.querySelector('[data-rail="market"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await measure('people', ()=>{ document.querySelector('[data-rail="people"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await measure('almanac', ()=>{ document.querySelector('[data-rail="almanac"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await measure('society', ()=>{ document.querySelector('[data-rail="society"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await measure('closed', ()=>{ document.querySelector('[data-panel-close]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await browser.close();
