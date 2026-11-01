import puppeteer from 'puppeteer-core';
const browser = await puppeteer.launch({ headless:true, executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', args:['--no-sandbox','--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
await page.setViewport({ width:1600, height:900, deviceScaleFactor:1 });
await page.evaluateOnNewDocument(()=>{ try{localStorage.clear();}catch{} });
const errors=[]; page.on('pageerror',e=>errors.push(e.message)); page.on('console',m=>{if(m.type()==='error')errors.push(m.text().slice(0,150));});
await page.goto('http://127.0.0.1:5280/',{waitUntil:'networkidle2'});
await page.waitForFunction('window.__FIRST_HEARTH__?.ready===true');
await new Promise(r=>setTimeout(r,700));
const steps=[];
await page.evaluate(()=>{ document.querySelector('[data-act="begin"]')?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
await new Promise(r=>setTimeout(r,700));
for(let i=0;i<10;i++){
  const snap = await page.evaluate(()=>{
    const tour=document.querySelector('.fh-tour');
    return { visible:!!tour, text: tour?.innerText?.replace(/\s+/g,' ').slice(0,180) ?? null, nextBtn: !!document.querySelector('[data-act="next"]'), paused: window.__game.paused, key: localStorage.getItem('fh-tour-v1') };
  });
  steps.push(snap);
  if(!snap.visible) break;
  await page.evaluate(()=>{ const b=document.querySelector('[data-act="next"]'); b?.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
  await new Promise(r=>setTimeout(r,250));
}
const final = await page.evaluate(()=>({ tour: !!document.querySelector('.fh-tour'), key: localStorage.getItem('fh-tour-v1'), paused: window.__game.paused, firstSteps: !!document.querySelector('[class*=fh-firststeps]') }));
console.log(JSON.stringify({steps, final, errors}, null, 2));
await page.screenshot({path:'shots/accept-tour-final.png'});
await browser.close();
