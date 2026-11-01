import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument(() => { try { localStorage.clear(); } catch {} });
page.on('pageerror', e=>console.log('PAGEERR', e.message));
page.on('console', m=>{ if(m.type()==='error') console.log('CONSOLE', m.text().slice(0,200)); });
await page.goto('http://127.0.0.1:5280/', { waitUntil:'networkidle2' });
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,900));
const info = await page.evaluate(() => {
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game;
  g.pause();
  // place a starter camp + lean-to + well like a new player would
  const s=g.state, cap=s.settlements[0];
  for(const [t,dx,dy] of [['foragers_camp',2,1],['lean_to',1,-2],['well',-1,1],['woodcutter_camp',-2,2],['stone_pit',3,-1]]) {
    for(let r=0;r<8;r++){ const x=cap.x+dx+(r%3), y=cap.y+dy+Math.floor(r/3); if(g.placeBuilding(t,x,y).ok) break; }
  }
  for(let k=0;k<5;k++){ g.advanceDays(8); for(let i=0;i<6;i++){const p=s.events.pending;if(!p.length)break; const ch=p[0].choices.find(c=>!c.cost)??p[0].choices[0]; g.resolveDecision(p[0].id,ch?.id??'__none');} }
  document.querySelectorAll('.fh-welcome,.fh-modal-backdrop,.fh-modal,.fh-screen,.fh-toast,.fh-toasts,[class*=toast]').forEach(e=>{if(e instanceof HTMLElement)e.style.display='none';});
  const st=s.settlements[0];
  return { tick:s.tick, pop:st.population, bld:s.buildings.length, pending:s.events.pending.length, explored:s.exploration.revealedTiles, food:Math.round(st.foodDays), fps:g.fps };
});
console.log(JSON.stringify(info));
await new Promise(r=>setTimeout(r,1000));
await page.screenshot({ path:'shots/fog-fixed-1600.png' });
// zoom out a bit and pan to show fog boundary
await page.evaluate(()=>{ const g=window.__game; g.renderer?.centerOnTile(g.state.world.startX+6, g.state.world.startY-4, 0.8); });
await new Promise(r=>setTimeout(r,500));
await page.screenshot({ path:'shots/fog-fixed-zoomed.png' });
await browser.close();
