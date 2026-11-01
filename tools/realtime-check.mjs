import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
page.on('pageerror', e=>console.log('PAGEERR', e.message));
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,700));
const out = await page.evaluate(async () => {
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game;
  g.resume(); g.setSpeed(2);
  const log=[];
  const t0=performance.now();
  let lastTick=-1, decisions=0;
  return await new Promise(resolve => {
    const iv=setInterval(()=>{
      const dt=(performance.now()-t0)/1000;
      const pending=g.state.events.pending.length;
      if(pending>0 && !g.paused) log.push('pending-while-running!');
      if(pending>0){
        decisions++;
        const d=g.state.events.pending[0];
        const pass=document.querySelector('[data-choice="__none"]');
        log.push({at:dt.toFixed(1)+'s', tick:g.state.tick, title:d.title, passButton: !!pass});
        // click let it pass
        pass?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
      }
      if(dt>90){ clearInterval(iv); resolve({log, decisions, tick:g.state.tick, paused:g.paused, history:g.state.events.history.length, fps:Math.round(g.fps)}); }
    }, 500);
  });
});
console.log(JSON.stringify(out,null,2));
await browser.close();
