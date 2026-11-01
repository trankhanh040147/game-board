import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({width:1600,height:900});
page.on('pageerror', e=>console.log('PAGEERR',e.message));
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,800));
const out = await page.evaluate(() => {
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game; g.pause();
  const s=g.state;
  const report=[];
  // advance 200 days resolving greedily with result capture
  for(let d=0;d<200;d++){
    g.advanceDays(1);
    for(let i=0;i<6;i++){
      const p=s.events.pending; if(!p.length) break;
      const dec=p[0];
      const results=[];
      for(const ch of dec.choices){
        const r=g.resolveDecision(dec.id, ch.id);
        results.push({choice:ch.id, ok:r.ok, msg:r.message});
        if(r.ok) break;
      }
      if(!s.events.pending.length) continue;
      // still pending: capture once and break
      if(p[0].id===dec.id && !results.some(r=>r.ok)){
        report.push({stuck:true, tick:s.tick, title:dec.title, eventId:dec.eventId, choices:dec.choices.map(c=>({id:c.id,cost:c.cost,requires:c.requires,effects:c.effects?.length})), results});
        break;
      }
    }
    if(report.some(r=>r.stuck)) break;
  }
  return {tick:s.tick, pending:s.events.pending.map(d=>({id:d.id,eventId:d.eventId,title:d.title,choices:d.choices.map(c=>({id:c.id,cost:c.cost,requires:c.requires}))})), report, history:s.events.history.length, pop:s.settlements[0].population, decisionsFlags:Object.fromEntries(Object.entries(s.flags).filter(([k])=>k.includes('event'))) };
});
console.log(JSON.stringify(out,null,2));
await browser.close();
