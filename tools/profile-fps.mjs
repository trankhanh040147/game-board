import puppeteer from 'puppeteer-core';
const dpr = Number(process.argv[2] ?? 2);
const speed = Number(process.argv[3] ?? 2);
const durationMs = Number(process.argv[4] ?? 10000);
const panels = (process.argv[5] ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const width = 1600, height = 900;
const browser = await puppeteer.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-angle=metal'] });
const page = await browser.newPage();
await page.setViewport({ width, height, deviceScaleFactor: dpr });
const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR ' + e.message));
page.on('console', m => { if (m.type()==='error') errors.push('CONSOLE ' + m.text().slice(0,200)); });
await page.goto('http://127.0.0.1:5280/', { waitUntil: 'networkidle2', timeout: 60000 });
await page.waitForFunction('window.__FIRST_HEARTH__ && window.__FIRST_HEARTH__.ready === true', { timeout: 30000 });
await new Promise(r => setTimeout(r, 1000));
// setup a mid-game settlement
const setup = await page.evaluate(() => {
  const click = (s) => document.querySelector(s)?.dispatchEvent(new MouseEvent('click',{bubbles:true}));
  click('[data-act="begin"]');
  const g = window.__game; g.pause();
  const s = g.state, c = g.content, cap = s.settlements[0];
  s.flags.auto_research = 1; s.research.era = 2;
  for (const id of c.techOrder) { const t = c.techs[id]; if (t && t.era <= 2) s.research.completed[id] = s.tick; }
  s.research.insight = 500;
  for (const k of ['wood','stone','clay','fiber','plank','brick','iron','tools','grain','berries','water']) if (c.resources[k]) cap.stock[k] = (cap.stock[k]??0)+300;
  cap.treasury = 2000;
  for (let dy=-4;dy<=4;dy++) for (let dx=-4;dx<=4;dx++) if (Math.abs(dx)===2||Math.abs(dy)===2) g.placeRoad(cap.x+dx, cap.y+dy);
  const types=['lean_to','hut','hut','hut','foragers_camp','woodcutter_camp','stone_pit','well','granary','farm','farm','sawmill','smithy','market','carpenter_shop','mill','bakery','temple','school','clinic','well','hut','hut','farm'];
  let n=0;
  for (const t of types) { for (let r=0;r<10;r++){ const x=cap.x+((n%7)-3)+(r%3), y=cap.y+Math.floor(n/7)-2+Math.floor(r/3); if(g.placeBuilding(t,x,y).ok) break; } n++; }
  for (let k=0;k<20;k++){ g.advanceDays(10); for(let i=0;i<8;i++){const p=s.events.pending; if(!p.length)break; const ch=p[0].choices; const pick=ch.find(c=>!c.cost||Object.keys(c.cost).length===0)??ch[0]; const r=g.resolveDecision(p[0].id,pick?.id??'__none'); if(!r.ok) g.resolveDecision(p[0].id,'__none');} }
  for (let i=0;i<40;i++){ const p=s.events.pending; if(!p.length) break; const ch=p[0].choices; const pick=ch.find(c=>!c.cost||Object.keys(c.cost).length===0)??ch[0]; const r=g.resolveDecision(p[0].id, pick?.id ?? '__none'); if(!r.ok) { const r2=g.resolveDecision(p[0].id,'__none'); if(!r2.ok) { window.__stuck = { title:p[0].title, why:r2.message }; break; } } }
  // Mid-game population: inject LOD cohorts (the sim folds large populations
  // into cohorts), then let systems settle so we profile >=100 population.
  s.cohorts.push({ id: 900000, settlementId: cap.id, profession: 'laborer', ageBand: 'adult', count: 140, health: 82, morale: 70, education: 30 });
  for (let i = 0; i < 6; i++) g.advanceDays(1);
  const totalPop = s.citizens.filter((c) => c.alive).length + s.cohorts.reduce((a, co) => a + co.count, 0);
  window.__pendingBeforeClear = s.events.pending.length;
  s.events.pending = [];
  s.events.warnings = [];
  document.querySelectorAll('.fh-welcome,.fh-modal-backdrop,.fh-modal,.fh-screen').forEach(e=>{ if(e instanceof HTMLElement) e.style.display='none'; });
  return { tick:s.tick, pop: totalPop, settlementPop: s.settlements.reduce((a,x)=>a+x.population,0), buildings:s.buildings.length, pending:s.events.pending.length };
});
// instrument
await page.evaluate((sp) => {
  const g = window.__game;
  window.__prof = { frames: [], renderMs: [], refreshMs: [], tickMs: [] };
  const origRender = g.renderer.render.bind(g.renderer);
  g.renderer.render = (t) => { const a=performance.now(); origRender(t); window.__prof.renderMs.push(performance.now()-a); };
  const origRefresh = g.ui.refresh.bind(g.ui);
  g.ui.refresh = () => { const a=performance.now(); origRefresh(); window.__prof.refreshMs.push(performance.now()-a); };
  const origTick = g.tickOnce.bind(g);
  g.tickOnce = () => { const a=performance.now(); origTick(); window.__prof.tickMs.push(performance.now()-a); };
  g.resume(); g.setSpeed(sp); window.__resumeState = { paused: g.paused, pending: g.state.events.pending.length, pendingBeforeClear: window.__pendingBeforeClear, stuck: window.__stuck ?? null };
  let last = performance.now();
  const loop = (now) => { window.__prof.frames.push(now-last); last=now; if (window.__prof.frames.length < 20000) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  window.__longs = [];
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__longs.push({start:e.startTime, dur:e.duration}); }).observe({entryTypes:['longtask']}); } catch {}
}, speed);
await page.evaluate((ps) => {
  for (const id of ps) {
    const btn = document.querySelector(`[data-rail="${id}"]`);
    if (btn instanceof HTMLElement) btn.click();
  }
}, panels);
await new Promise(r => setTimeout(r, durationMs));
const result = await page.evaluate(() => {
  const p = window.__prof;
  const stat = (arr) => { const a=[...arr].sort((x,y)=>x-y); const sum=a.reduce((s,v)=>s+v,0); return { n:a.length, avg: +(sum/Math.max(1,a.length)).toFixed(2), p50:+a[Math.floor(a.length*0.5)]?.toFixed(2), p95:+a[Math.floor(a.length*0.95)]?.toFixed(2), max:+a[a.length-1]?.toFixed(2) }; };
  const frames = p.frames.slice(5);
  const fps = 1000 / (frames.reduce((s,v)=>s+v,0)/Math.max(1,frames.length));
  const g = window.__game;
  return { fps:+fps.toFixed(1), frame:stat(frames), render:stat(p.renderMs), refresh:stat(p.refreshMs), tick:stat(p.tickMs),
    dpr: window.devicePixelRatio, canvas: [g.renderer?.constructor?.name, g.state.tick, g.state.settlements[0].population, g.state.buildings.length, g.speed, g.paused],
    pending: g.state.events.pending.length, history: g.state.events.history.length, resumeState: window.__resumeState, pausedNow: g.paused,
    longTasks: window.__longs.slice(-10), longCount: window.__longs.length,
    debug: g.renderer?.debugStats ?? null };
});
const longs = result.longTasks ?? [];
const warm = result.longCount > longs.length ? result.longCount - longs.length : 0;
const longOver50 = longs.filter((l) => l.dur > 50).length;
const fpsOk = result.fps >= 50;
const renderOk = (result.render?.p95 ?? 0) < 25;
const longOk = longOver50 <= 2;
console.log(`DPR=${dpr} SPEED=${speed} DURATION_MS=${durationMs} PANELS=${panels.join('+') || 'none'} setupPopulation=${setup.pop} buildings=${setup.buildings}`);
console.log(`ASSERT fps>=50: ${fpsOk} (${result.fps}); render p95<25ms: ${renderOk} (${result.render?.p95}ms, max ${result.render?.max}ms); longtasks>50ms<=2: ${longOk} (${longOver50}/${result.longCount}, warmupIgnored=${warm}); pending=${result.pending}`);
console.log(`TICK ms avg=${result.tick?.avg} p95=${result.tick?.p95} | refresh ms avg=${result.refresh?.avg} p95=${result.refresh?.p95}`);
console.log(JSON.stringify(result, null, 2));
if (errors.length) console.log('errors', errors.slice(0,5));
await browser.close();
