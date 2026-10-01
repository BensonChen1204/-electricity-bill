import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createRequire } from 'node:module';
import { prepareBaseline } from '../scripts/prepare-baseline.mjs';
import { payload } from './fixtures.mjs';

const origin = 'https://bensonchen1204.github.io';
// A synthetic test credential, never a household credential.
const pin = 'synthetic-local-test-only';
const schema = await readFile(new URL('../migrations/0001_state.sql',import.meta.url),'utf8');
async function setup(t, { seed = true, configured = true } = {}) {
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: new URL('../dist/index.js',import.meta.url).pathname,
    compatibilityDate:'2026-10-01', compatibilityFlags:['nodejs_compat'],
    d1Databases:['DB'],
    ratelimits:{AUTH_LIMITER:{namespace_id:'1001001',simple:{limit:60,period:60}}},
    bindings:{ALLOWED_ORIGIN:origin,YILAN_FAMILY_PIN:configured?pin:''},
  }));
  t.after(()=>mf.dispose());
  const db = await mf.getD1Database('DB');
  // exec splits on newlines; batch each full SQL statement including triggers.
  const statements = schema.match(/CREATE TABLE[\s\S]*?;|CREATE TRIGGER[\s\S]*?END;/g);
  await db.batch(statements.map(sql=>db.prepare(sql)));
  if (seed) await db.prepare(prepareBaseline(JSON.stringify(payload()),{source:'synthetic-test',sourceRevision:8}).sql).run();
  const request = (method='GET', body, extraHeaders={}, path='/v1/state')=>mf.dispatchFetch('https://worker.test'+path,{
    method,headers:{origin,'x-family-pin':pin,'content-type':'application/json',...extraHeaders},
    body:body===undefined?undefined:(typeof body==='string'?body:JSON.stringify(body)),
  });
  const write = (expected_revision, p=payload(), mutation_id=randomUUID())=>({payload:p,expected_revision,actor:'device-synthetic',mutation_id});
  return {mf,db,request,write};
}

test('auth, CORS, methods and no-store fail closed',async t=>{
  const {request}=await setup(t);
  assert.equal((await request('GET',undefined,{'x-family-pin':'wrong'})).status,401);
  assert.equal((await request('GET',undefined,{origin:'https://evil.example'})).status,403);
  const preflight=await request('OPTIONS'); assert.equal(preflight.status,204);
  assert.equal(preflight.headers.get('access-control-allow-origin'),origin);
  assert.equal((await request('DELETE')).status,405);
  assert.equal((await request('GET',undefined,{},'/v1/state?pin=bad')).status,404);
  const get=await request(); assert.equal(get.status,200);
  assert.match(get.headers.get('cache-control'),/no-store/);
  assert.equal((await get.json()).revision,1);
});
test('missing authentication configuration never exposes state',async t=>{
  const {request}=await setup(t,{configured:false}); assert.equal((await request()).status,503);
});
test('empty database cannot be silently seeded by any phone',async t=>{
  const {request,write,db}=await setup(t,{seed:false});
  assert.equal((await (await request()).json()).baseline_required,true);
  assert.equal((await request('POST',write(1))).status,428);
  assert.equal((await request('POST',write(0))).status,400);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM app_state').first()).n,0);
});
test('one winner in concurrent two-phone writes, one immutable snapshot',async t=>{
  const {request,write,db}=await setup(t);
  const a=payload();a.rooms[0].curr='115'; const b=payload();b.rooms[1].curr='120';
  const responses=await Promise.all([request('POST',write(1,a)),request('POST',write(1,b))]);
  assert.deepEqual(responses.map(r=>r.status).sort(),[200,409]);
  const row=await db.prepare('SELECT * FROM app_state').first();assert.equal(row.revision,2);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM state_versions').first()).n,2);
  const old=await db.prepare('SELECT payload FROM state_versions WHERE revision=1').first();
  assert.deepEqual(JSON.parse(old.payload),payload());
  await assert.rejects(db.prepare('UPDATE state_versions SET actor=?').bind('changed').run(),/immutable/);
});
test('lost-response and concurrent retries are idempotent even after newer updates',async t=>{
  const {request,write,db}=await setup(t); const body=write(1);
  const retry=await Promise.all([request('POST',body),request('POST',body)]);
  assert.deepEqual(retry.map(r=>r.status),[200,200]);
  assert.equal((await request('POST',write(2))).status,200);
  const again=await (await request('POST',body)).json(); assert.equal(again.revision,2);assert.equal(again.replayed,true);
  const different={...body,payload:{...payload(),rate:8}};assert.equal((await request('POST',different)).status,409);
  assert.equal((await db.prepare('SELECT count(*) AS n FROM state_versions').first()).n,3);
});
test('snapshot insert failure rolls back canonical state',async t=>{
  const {request,write,db}=await setup(t);
  await db.prepare("CREATE TRIGGER synthetic_fail BEFORE INSERT ON state_versions WHEN NEW.revision=2 BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END;").run();
  assert.equal((await request('POST',write(1))).status,503);
  assert.equal((await db.prepare('SELECT revision FROM app_state').first()).revision,1);
});
test('invalid and oversized bodies are rejected without writes',async t=>{
  const {request,write,db}=await setup(t);
  assert.equal((await request('POST','{')).status,400);
  assert.equal((await request('POST',write(1),{'content-type':'text/plain'})).status,415);
  assert.equal((await request('POST',write(1,{rooms:[]}))).status,400);
  assert.equal((await request('POST','x'.repeat(512*1024+1))).status,413);
  assert.equal((await db.prepare('SELECT revision FROM app_state').first()).revision,1);
});
test('duplicate seed fails without altering original or receipt',async t=>{
  const {db}=await setup(t);
  const sql=prepareBaseline(JSON.stringify({...payload(),rate:8}),{source:'second-source'}).sql;
  await assert.rejects(db.prepare(sql).run());
  assert.equal((await db.prepare('SELECT source FROM baseline_receipt').first()).source,'synthetic-test');
  assert.equal(JSON.parse((await db.prepare('SELECT payload FROM app_state').first()).payload).rate,5);
});
test('unauthorized attempts are throttled',async t=>{
  const {request}=await setup(t);
  let final;
  for(let i=0;i<65;i++) final=await request('GET',undefined,{'x-family-pin':'wrong'});
  assert.equal(final.status,429);assert.equal(final.headers.get('retry-after'),'60');
});
test('global failed-attempt budget bounds guesses across IPs and releases valid slots',async t=>{
  const {request,db}=await setup(t);
  for(let i=0;i<12;i++) assert.equal((await request()).status,200);
  for(let i=0;i<10;i++) assert.equal((await request('GET',undefined,{'x-family-pin':'wrong','CF-Connecting-IP':'192.0.2.'+i})).status,401);
  const blocked=await request('GET',undefined,{'CF-Connecting-IP':'192.0.2.99'});
  assert.equal(blocked.status,429);assert.ok(Number(blocked.headers.get('retry-after'))>0);
  await db.prepare('UPDATE auth_budget SET window_start=window_start-600').run();
  assert.equal((await request()).status,200);
});
test('a stale auth window cannot roll the global budget backwards',async t=>{
  const {request,db}=await setup(t);
  await request();
  await db.prepare('UPDATE auth_budget SET window_start=window_start+600,attempts=10').run();
  const before=await db.prepare('SELECT * FROM auth_budget').first();
  assert.equal((await request()).status,429);
  assert.deepEqual(await db.prepare('SELECT * FROM auth_budget').first(),before);
});

test('actual browser engine and D1 reconcile two offline phones without silent loss',async t=>{
  const {request,db}=await setup(t);
  const {create}=createRequire(import.meta.url)('../../sync-engine.js');
  function phone(name) {
    const data=new Map([['yilanUtilityV2',JSON.stringify(payload())]]);
    const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,String(v)),removeItem:k=>data.delete(k),key:i=>[...data.keys()][i]??null,get length(){return data.size;}};
    const transport={endpoint:'worker-v1:https://worker.test/v1/state',enabled:()=>true,getPin:()=>pin,
      load:async()=>(await request()).json(),
      save:async(p,r,id)=>{
        const response=await request('POST',{payload:p,expected_revision:r,actor:name,mutation_id:id});
        const body=await response.json();if(!response.ok)throw Object.assign(new Error(body.error),{status:response.status});return body;
      }};
    const engine=create({storage,transport,initialState:payload(),tabId:name,debounceMs:2**30});
    t.after(()=>engine.dispose());return {engine,data};
  }
  const a=phone('phone-a'),b=phone('phone-b');
  await Promise.all([a.engine.sync(),b.engine.sync()]);
  const pa=payload();pa.rooms[0].curr='115';
  const pb=payload();pb.rooms[1].curr='125';
  a.engine.saveLocal(pa);b.engine.saveLocal(pb);
  await a.engine.sync();await b.engine.sync();
  assert.equal(a.engine.status().mode,'synced');assert.equal(b.engine.status().mode,'conflict');
  assert.equal(b.engine.snapshot().rooms[1].curr,'125');
  assert.equal(JSON.parse((await db.prepare('SELECT payload FROM app_state').first()).payload).rooms[0].curr,'115');
  await b.engine.resolve('remote');assert.equal(b.engine.status().mode,'synced');
  assert.equal(b.engine.snapshot().rooms[0].curr,'115');
  assert.ok([...b.data.entries()].some(([key,value])=>key.startsWith('yilanSyncBackup:')&&value.includes('125')));
});
