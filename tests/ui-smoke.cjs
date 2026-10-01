// Optional local UI smoke test. Requires Playwright + Chromium. All credentials,
// rental data, and the intercepted HTTPS API are synthetic. No production API.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const root=path.join(__dirname,'..');
const SYNTHETIC_TOKEN='A'.repeat(43),API='https://sync.example.test/v1/state';
const fixture=()=>({schemaVersion:2,month:'2040-01',rate:3,rooms:['101','102','201','202','301','302'].map(room=>({room,prev:10,curr:'12',rent:20,water:2,others:[]})),history:[]});
let remote=fixture(),revision=1,posts=0,offline=false,apiCalls=0;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  // This same-origin API path exists solely for checking service-worker bypass.
  if(url.pathname==='/v1/state'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'unauthorized'}));return;}
  if(url.pathname==='/cloud-config.js'){
    res.setHeader('Content-Type','text/javascript');res.end(`window.YILAN_CLOUD_CONFIG={protocol:'worker-v1',authMode:'capability-v1',functionUrl:'${API}'};`);return;
  }
  const filename=url.pathname==='/'?'index.html':url.pathname.slice(1);
  if(!['index.html','cloud-sync.js','sync-engine.js','sw.js','manifest.webmanifest','favicon.svg'].includes(filename)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',filename.endsWith('.js')?'text/javascript':filename.endsWith('.svg')?'image/svg+xml':filename.endsWith('.webmanifest')?'application/manifest+json':'text/html');
  res.end(fs.readFileSync(path.join(root,filename)));
});
(async()=>{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  if(process.argv.includes('--serve')){console.log('Synthetic shell fixture: http://127.0.0.1:'+server.address().port+' (HTTPS API is mocked only in automated tests)');return;}
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  try{
    const base=`http://127.0.0.1:${server.address().port}`;
    async function guardedContext(options={}){
      const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',...options});
      await context.route('**/*',async route=>{
        const request=route.request(),url=request.url();
        assert.ok(!url.includes(SYNTHETIC_TOKEN));
        if(new URL(url).origin===base)return route.continue();
        if(url!==API)return route.abort();
        const cors={'Access-Control-Allow-Origin':base,'Access-Control-Allow-Headers':'Authorization, Content-Type','Access-Control-Allow-Methods':'GET, POST, OPTIONS'};
        if(request.method()==='OPTIONS')return route.fulfill({status:204,headers:cors});
        const reply=payload=>route.fulfill({...payload,headers:cors});
        apiCalls++;
        assert.equal(request.headers().authorization,'Bearer '+SYNTHETIC_TOKEN);
        assert.equal(request.headers()['x-family-pin'],undefined);assert.equal(request.headers().apikey,undefined);
        assert.ok(!(request.postData()||'').includes(SYNTHETIC_TOKEN));
        if(offline)return route.abort();
        if(request.method()==='GET')return reply({status:200,json:{exists:true,payload:remote,revision,updated_at:'2040-01-01T00:00:00Z'}});
        const body=request.postDataJSON();posts++;
        if(body.expected_revision!==revision)return reply({status:409,json:{error:'revision_conflict',revision}});
        remote=body.payload;revision++;
        return reply({status:200,json:{revision,updated_at:'2040-01-01T00:00:00Z',mutation_id:body.mutation_id}});
      });
      return context;
    }
    const context=await guardedContext();
    await context.addInitScript(s=>{if(!localStorage.getItem('synthetic-initialized')){localStorage.setItem('yilanUtilityV2',JSON.stringify(s));localStorage.setItem('yilanFamilyPin','synthetic-legacy-pin');localStorage.setItem('synthetic-initialized','yes');}},fixture());
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.goto(base+'/#yilan-access='+SYNTHETIC_TOKEN);await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(page.url(),base+'/');assert.equal(await page.locator('.reading').count(),6);
    // A regular bookmark/reload automatically uses the endpoint-scoped credential.
    await page.reload();await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    await page.locator('#settingsBtn').click();await page.locator('#cloudBtn').click();
    assert.equal(await page.locator('#cloudPinInput').isVisible(),false);assert.equal(await page.locator('#cloudPinInput').inputValue(),'');
    assert.match(await page.locator('#cloudPrivateLinkNote').textContent(),/下次直接開啟/);
    await page.locator('#closeCloud').click();
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
    const recovery=fs.readFileSync(await download.path(),'utf8');assert.ok(!recovery.includes(SYNTHETIC_TOKEN));assert.ok(!recovery.includes('synthetic-legacy-pin'));assert.equal(JSON.parse(recovery).currentInMemory.rooms[0].curr,'18');
    const resultsDir=process.env.UI_RESULTS_DIR||path.join(root,'test-results');fs.mkdirSync(resultsDir,{recursive:true});
    await page.screenshot({path:path.join(resultsDir,'mobile-conflict.png'),fullPage:true});
    await page.locator('#useRemoteCloud').click();await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(await page.locator('.reading').first().inputValue(),'22');assert.equal(posts,1);
    const beforeDisconnect=await page.evaluate(()=>localStorage.getItem('yilanUtilityV2'));
    await page.locator('#disconnectCloud').click();
    await page.waitForFunction(()=>document.getElementById('dataStatus').textContent.includes('私人連結'));
    assert.equal(await page.evaluate(()=>window.YilanCloud.getCredential()),'');
    assert.equal(await page.evaluate(()=>localStorage.getItem('yilanFamilyPin')),'synthetic-legacy-pin');
    assert.equal(await page.evaluate(()=>localStorage.getItem('yilanUtilityV2')),beforeDisconnect);
    await page.locator('#closeCloud').click();assert.equal(await page.locator('#cloudDialog').isVisible(),false);
    // A private link opened in this already-open tab is consumed without reload.
    const callsAfterDisconnect=apiCalls;await page.evaluate(()=>window.dispatchEvent(new Event('online')));await page.waitForTimeout(100);
    assert.equal(apiCalls,callsAfterDisconnect);
    await page.goto(base+'/#yilan-access='+SYNTHETIC_TOKEN);await page.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');assert.equal(page.url(),base+'/');
    assert.deepEqual(errors,[]);await context.close();

    const fresh=await guardedContext(),freshPage=await fresh.newPage(),callsBeforeMissing=apiCalls;
    await freshPage.goto(base);await freshPage.locator('#settingsBtn').click();await freshPage.locator('#cloudBtn').click();
    assert.equal(await freshPage.locator('#cloudPinInput').isVisible(),false);assert.equal(await freshPage.locator('#connectCloud').isVisible(),false);
    assert.match(await freshPage.locator('#cloudPrivateLinkNote').textContent(),/家人提供的完整私人連結/);assert.equal(apiCalls,callsBeforeMissing);
    await freshPage.locator('#closeCloud').click();await freshPage.goto(base+'/#yilan-access=malformed');
    await freshPage.waitForFunction(()=>document.getElementById('dataStatus').textContent.includes('連結不完整'));
    assert.equal(freshPage.url(),base+'/');assert.equal(apiCalls,callsBeforeMissing);
    // A genuinely new phone opens the good link and receives family data without a default-data conflict.
    await freshPage.goto(base+'/#yilan-access='+SYNTHETIC_TOKEN);
    await freshPage.waitForFunction(()=>document.getElementById('dataStatus').textContent==='雲端已同步');
    assert.equal(await freshPage.locator('.reading').first().inputValue(),'22');assert.equal(posts,1);await fresh.close();

    const blocked=await guardedContext();
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
    // Real service-worker lifecycle. No credentials or private data in its cache.
    const pwa=await guardedContext({serviceWorkers:'allow'});const p=await pwa.newPage();await p.goto(base);await p.waitForFunction(async()=>!!(await navigator.serviceWorker.ready).active);
    await p.reload();await p.waitForFunction(()=>!!navigator.serviceWorker.controller);
    await p.evaluate(()=>fetch('/v1/state'));
    const cached=await p.evaluate(async()=>{const entries=[];for(const name of await caches.keys()){for(const req of await (await caches.open(name)).keys())entries.push(req.url);}return entries;});
    assert.ok(cached.some(url=>url.endsWith('/sync-engine.js')));assert.ok(!cached.some(url=>url.includes('/v1/state')));assert.ok(!cached.some(url=>url.includes('yilan-access')));
    await pwa.setOffline(true);await p.reload();assert.ok((await p.title()).includes('宜蘭'));await pwa.close();
    console.log('PASS: private-link open/reload/same-tab reconnect, no PIN, missing/malformed links, device-only disconnect, mobile editing, offline conflict recovery, quota protection, service-worker offline shell; no production requests');
  }finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close();});
