import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: Number(process.argv[2]??1) });
page.on('pageerror', e=>console.log('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,800));
const setup = await page.evaluate(() => {
  const click=(s)=>document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g=window.__game; g.pause();
  const s=g.state,c=g.content,cap=s.settlements[0];
  s.flags.auto_research=1; s.research.era=2;
  for(const id of c.techOrder){const t=c.techs[id]; if(t&&t.era<=2)s.research.completed[id]=s.tick;}
  for(const k of ['wood','stone','clay','fiber','plank','brick','iron','tools','grain','berries','water']) if(c.resources[k]) cap.stock[k]=(cap.stock[k]??0)+300;
  cap.treasury=2000;
  for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++) if(Math.abs(dx)===2||Math.abs(dy)===2) g.placeRoad(cap.x+dx,cap.y+dy);
  const types=['lean_to','hut','hut','hut','foragers_camp','woodcutter_camp','stone_pit','well','granary','farm','farm','sawmill','smithy','market','carpenter_shop','mill','bakery','temple','school','clinic','well','hut','hut','farm'];
  let n=0;
  for(const t of types){ for(let r=0;r<10;r++){const x=cap.x+((n%7)-3)+(r%3),y=cap.y+Math.floor(n/7)-2+Math.floor(r/3); if(g.placeBuilding(t,x,y).ok) break;} n++; }
  for(let k=0;k<20;k++){g.advanceDays(10); for(let i=0;i<10;i++){const p=s.events.pending;if(!p.length)break;const ch=p[0].choices;g.resolveDecision(p[0].id,ch[ch.length-1]?.id??'');}}
  s.events.pending=[]; s.events.warnings=[];
  g.resume(); g.setSpeed(2);
  return {tick:s.tick,pop:s.settlements[0].population,bld:s.buildings.length,chunks:g.renderer?.debugStats?.chunks,bakes:g.renderer?.debugStats?.bakeCount};
});
console.log('setup', JSON.stringify(setup));
await page.evaluate(() => {
  const r = window.__game.renderer;
  const t = r.terrain;
  window.__phases = {};
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    if (typeof orig !== 'function') return;
    obj[name] = function(...args) {
      const a = performance.now();
      try { return orig.apply(this, args); }
      finally {
        const d = performance.now() - a;
        const ph = window.__phases[label] ?? (window.__phases[label] = { n:0, total:0, max:0 });
        ph.n++; ph.total += d; if (d > ph.max) ph.max = d;
      }
    };
  };
  wrap(t, 'draw', 'terrain.draw');
  wrap(t, 'bake', 'terrain.bake');
  wrap(t, 'drawChunk', 'terrain.drawChunk');
  wrap(t, 'drawFlatChunk', 'terrain.flatChunk');
  wrap(t, 'evict', 'terrain.evict');
  wrap(r, 'drawDeco', 'drawDeco');
  wrap(r, 'drawActors', 'drawActors');
  wrap(r, 'drawOverlay', 'overlay');
  wrap(r, 'bakeFog', 'bakeFog');
  wrap(r.fx, 'update', 'fx.update');
  wrap(r.fx, 'drawClouds', 'fx.clouds');
  // eviction counters
  const ev = t.evict.bind(t);
  window.__evictions = 0;
  t.evict = () => { const before = t.chunkCount; ev(); window.__evictions += (before - t.chunkCount); };
  window.__bakeStartCount = t.bakeCount;
});
await new Promise(r=>setTimeout(r,7000));
const out = await page.evaluate(() => {
  const p = window.__phases;
  const out = {};
  for (const k in p) out[k] = { n:p[k].n, avg:+(p[k].total/p[k].n).toFixed(2), total:+p[k].total.toFixed(0), max:+p[k].max.toFixed(1) };
  const t = window.__game.renderer.terrain;
  return { phases: out, evictions: window.__evictions, bakes: t.bakeCount - window.__bakeStartCount, chunks: t.chunkCount, bytesMB: +(t.byteCount/1048576).toFixed(1), debug: window.__game.renderer.debugStats };
});
console.log(JSON.stringify(out,null,2));
await browser.close();
