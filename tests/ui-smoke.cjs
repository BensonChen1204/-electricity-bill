// Optional local UI smoke test. Requires Playwright + Chromium. No production API
// is contacted; the HTTP server, all auth, and all rental data are synthetic.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root=path.join(__dirname,'..');
const fixture=()=>({schemaVersion:2,month:'2040-01',rate:3,rooms:['101','102','201','202','301','302'].map(room=>({room,prev:10,curr:'12',rent:20,water:2,others:[]})),history:[]});
let remote=fixture(),revision=1,posts=0,offline=false;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/v1/state'){
    if(offline){res.destroy();return;}
    res.setHeader('Content-Type','application/json');
    if(req.method==='GET'){res.end(JSON.stringify({exists:true,payload:remote,revision,updated_at:'2040-01-01T00:00:00Z'}));return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);posts++;
    if(body.expected_revision!==revision){res.writeHead(409);res.end(JSON.stringify({error:'revision_conflict',revision}));return;}
    remote=body.payload;revision++;res.end(JSON.stringify({revision,updated_at:'2040-01-01T00:00:00Z',mutation_id:body.mutation_id}));return;
  }
  if(url.pathname==='/cloud-config.js'){
    res.setHeader('Content-Type','text/javascript');res.end(`window.YILAN_CLOUD_CONFIG={protocol:'worker-v1',functionUrl:'http://127.0.0.1:${server.address().port}/v1/state'};`);return;
  }
  const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!['index.html','cloud-sync.js','sync-engine.js','sw.js','manifest.webmanifest','favicon.svg'].includes(filename)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.svg')?'image/svg+xml':filename.endsWith('.webmanifest')?'application/manifest+json':'text/html');
  res.end(fs.readFileSync(path.join(root,filename)));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  if(process.argv.includes('--serve')){console.log('Synthetic UI fixture: http://127.0.0.1:'+server.address().port);return;}
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  try{
    const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
    const base=`http://127.0.0.1:${server.address().port}`;
    await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    await context.addInitScript(s=>{if(!localStorage.getItem('synthetic-initialized')){localStorage.setItem('yilanUtilityV2',JSON.stringify(s));localStorage.setItem('yilanFamilyPin','synthetic-only-pin');localStorage.setItem('synthetic-initialized','yes');}},fixture());
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(base);await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(await page.locator('.reading').count(),6);
    // Same controls and calculation semantics remain intact.
    await page.locator('.reading').first().fill('15');
    await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(remote.rooms[0].curr,'15');assert.equal(posts,1);
    offline=true;await page.locator('.reading').first().fill('18');
    await page.waitForFunction(()=>document.getElementById('dataStatus').textContent.includes('同步暫停'));
    await page.reload();await page.waitForFunction(()=>document.querySelector('.reading').value==='18');
    remote.rooms[0].curr='22';revision++;offline=false;
    await page.evaluate(()=>window.dispatchEvent(new Event('online')));
    await page.waitForFunction(()=>document.getElementById('dataStatus').textContent.includes('版本不同'));
    await page.locator('#settingsBtn').click();await page.locator('#cloudBtn').click();
    assert.equal(await page.locator('#cloudConflict').isVisible(),true);
    assert.equal(await page.locator('.reading').first().inputValue(),'18');
    const downloadPromise=page.waitForEvent('download');await page.locator('#exportSyncRecovery').click();const download=await downloadPromise;
    const recovery=fs.readFileSync(await download.path(),'utf8');assert.ok(!recovery.includes('synthetic-only-pin'));assert.equal(JSON.parse(recovery).currentInMemory.rooms[0].curr,'18');
    const resultsDir=process.env.UI_RESULTS_DIR||path.join(root,'test-results');fs.mkdirSync(resultsDir,{recursive:true});
    await page.screenshot({path:path.join(resultsDir,'mobile-conflict.png'),fullPage:true});
    await page.locator('#useRemoteCloud').click();await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(await page.locator('.reading').first().inputValue(),'22');assert.equal(posts,1);
    await page.locator('#closeCloud').click();
    assert.equal(await page.locator('#cloudDialog').isVisible(),false);
    assert.deepEqual(errors,[]);
    await context.close();
    const blocked=await browser.newContext({serviceWorkers:'block'});
    await blocked.addInitScript(s=>{
      localStorage.setItem('yilanUtilityV2',JSON.stringify(s));
      const original=Storage.prototype.setItem;
      Storage.prototype.setItem=function(key,value){if(key.startsWith('yilanSyncBackup:'))throw new DOMException('Synthetic quota','QuotaExceededError');return original.call(this,key,value);};
    },fixture());
    const blockedPage=await blocked.newPage();await blockedPage.goto(base);
    assert.equal(await blockedPage.locator('#recoveryBlockedPanel').isVisible(),true);
    assert.equal(await blockedPage.locator('#appShell').isVisible(),false);
    assert.equal(await blockedPage.locator('.reading').count(),0);
    assert.equal(await blockedPage.locator('#exportBlockedRecovery').isEnabled(),true);
    await blocked.close();
    // Real service worker lifecycle, still entirely local with synthetic config.
    const pwa=await browser.newContext();const p=await pwa.newPage();await p.goto(base);await p.waitForFunction(async()=>!!(await navigator.serviceWorker.ready).active);
    await p.reload();await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await p.evaluate(()=>fetch('/v1/state'));
    const cached=await p.evaluate(async()=>{const entries=[];for(const name of await caches.keys()){for(const req of await (await caches.open(name)).keys())entries.push(req.url);}return entries;});
    assert.ok(cached.some(url=>url.endsWith('/sync-engine.js')));assert.ok(!cached.some(url=>url.includes('/v1/state')));
    await pwa.setOffline(true);await p.reload();assert.ok((await p.title()).includes('宜蘭'));await pwa.close();
    console.log('PASS: mobile editing, offline reload, reconnect conflict, recovery export, explicit cloud resolution, close dialog, service-worker install and offline shell; no production requests');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
