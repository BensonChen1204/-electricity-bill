// Synthetic local-only browser test. Generated test capabilities are never
// registered in Cloudflare or sent to a production API/account.
const http = require('node:http');
const assert = require('node:assert/strict');
const {createHash} = require('node:crypto');
const {chromium} = require('playwright');
const {setupPage} = require('../backend/src/setup-page.ts');
let expectedVerifier = '', requests = 0;
const server = http.createServer(async(req,res)=>{
  if(req.url==='/setup'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'nonce-synthetic-test'; style-src 'nonce-synthetic-test'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.end(setupPage('synthetic-test'));return;
  }
  if(req.url==='/v1/state'){
    requests++;assert.equal(req.headers.origin,undefined,'same-origin GET must not require an extra API CORS origin');
    res.setHeader('Content-Type','application/json');
    if(!expectedVerifier){res.writeHead(503);res.end(JSON.stringify({error:'auth_not_configured'}));return;}
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    if(createHash('sha256').update(token).digest('hex')!==expectedVerifier){res.writeHead(401);res.end(JSON.stringify({error:'unauthorized'}));return;}
    res.end(JSON.stringify({exists:true,revision:1,payload:{rooms:Array.from({length:6},()=>({}))}}));return;
  }
  res.writeHead(404);res.end();
});
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),args:['--no-sandbox']});
  try{
    const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
    await context.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
    const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base+'/setup');
    assert.equal(requests,0);assert.equal(await page.locator('#copyLink').isEnabled(),false);
    await page.locator('#generate').click();await page.waitForFunction(()=>!document.getElementById('copyVerifier').disabled);
    assert.equal(requests,0,'generation is client-only');
    await page.locator('#verify').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('尚未完成'));
    assert.equal(await page.locator('#copyLink').isEnabled(),false);
    await page.locator('#copyVerifier').click();
    expectedVerifier=await page.evaluate(()=>navigator.clipboard.readText());
    assert.match(expectedVerifier,/^[a-f0-9]{64}$/);
    await page.locator('#verify').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('連線驗證成功'));
    await page.locator('#copyLink').click();
    const privateLink=await page.evaluate(()=>navigator.clipboard.readText());
    const parsed=new URL(privateLink),token=parsed.hash.slice('#yilan-access='.length);
    assert.equal(parsed.origin,'https://bensonchen1204.github.io');assert.equal(parsed.pathname,'/-electricity-bill/');assert.equal(parsed.search,'');
    assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(createHash('sha256').update(token).digest('hex'),expectedVerifier);
    assert.ok(!(await page.locator('body').innerText()).includes(token),'never render the private capability');
    await page.reload();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('已恢復'));
    assert.equal(await page.locator('#copyLink').isEnabled(),false,'must recheck after reload');
    await page.locator('#verify').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('連線驗證成功'));
    page.once('dialog',dialog=>dialog.dismiss());await page.locator('#generate').click();
    await page.locator('#copyVerifier').click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),expectedVerifier);
    expectedVerifier='0'.repeat(64);await page.locator('#verify').click();await page.waitForFunction(()=>document.getElementById('status').textContent.includes('不符'));
    assert.equal(await page.locator('#copyLink').isEnabled(),false);
    page.once('dialog',dialog=>dialog.accept());await page.locator('#forget').click();
    assert.equal(await page.locator('#verify').isEnabled(),false);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('yilanPrivateLinkSetup:v1')),null);
    assert.deepEqual(errors,[]);await context.close();
    console.log('PASS: local setup generation, verifier copy, fail-closed check, authenticated synthetic check, private fragment share, reload, cancellation and cleanup; no production credentials or calls');
  }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;server.close();});
