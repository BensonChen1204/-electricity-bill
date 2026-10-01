const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sync = require('../sync-engine.js');
const createTransport = require('../cloud-sync.js');
// Deliberately synthetic fixtures, unrelated to any household's real records.
const state = (reading = '12') => ({ schemaVersion: 2, month: '2040-01', rate: 3, rooms: [{room: 'TEST', prev: 10, curr: reading, rent: 20, water: 2, others: []}], history: [] });
const copy = value => JSON.parse(JSON.stringify(value));
const SYNTHETIC_TOKEN = 'A'.repeat(43);
const workerConfig = (url = 'https://sync.example.test/v1/state') => ({protocol:'worker-v1',authMode:'capability-v1',functionUrl:url});
function privateLink(hash = '#yilan-access=' + SYNTHETIC_TOKEN) {
  const location = {hash,pathname:'/rental/',search:'?view=month'};
  const calls = [];
  return {location,calls,history:{state:{view:'month'},replaceState(state,title,url){calls.push({state,title,url});location.hash='';}}};
}
class Storage {
  data = new Map(); fail = false;
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] || null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k,v) { if (this.fail) throw new Error('quota'); this.data.set(k,String(v)); }
  removeItem(k) { this.data.delete(k); }
}
function fixture(local = state(), options = {}) {
  const storage = options.storage || new Storage();
  if (!options.storage) storage.setItem(Sync.STATE_KEY, JSON.stringify(local));
  const server = { exists: true, payload: state(), revision: 1, updated_at: '2040-01-01T00:00:00Z' };
  const calls = [], statuses = [];
  let offline = false, id = 0;
  const transport = {
    endpoint: options.endpoint || 'worker-v1:https://sync.example.test/v1/state', enabled: () => true, getPin: () => 'synthetic-pin',
    load: async () => { if(offline) throw new Error('offline'); return copy(server); },
    save: async (payload, expectedRevision, mutationId) => {
      calls.push({payload:copy(payload), expectedRevision, mutationId});
      if(offline) throw new Error('offline');
      if(expectedRevision!==server.revision) throw Object.assign(new Error('revision_conflict'),{status:409});
      server.payload=copy(payload);server.revision++;
      return {revision:server.revision, updated_at:server.updated_at, mutation_id:mutationId};
    }
  };
  let applied = null;
  const engine = Sync.create({ storage, transport, initialState: local, uuid:()=>`fake-id-${++id}`, tabId:options.tabId || 'tab-a', debounceMs:100000, onStatus:s=>statuses.push(s), onApply:s=>{applied=s;}, ...options.engine });
  return {engine,storage,server,transport,calls,statuses,offline:v=>{offline=v;},applied:()=>applied};
}
test('first backup retains byte-exact raw V2 and V1 and excludes credentials', () => {
  const storage=new Storage(), v2=' { "old": [1, 2] } ', v1='not-json-but-retain-it';
  storage.setItem(Sync.STATE_KEY,v2); storage.setItem(Sync.LEGACY_KEY,v1); storage.setItem('yilanFamilyPin','secret-never-export');
  const backup=Sync.captureInitialBackup(storage);
  assert.equal(backup.raw[Sync.STATE_KEY],v2);assert.equal(backup.raw[Sync.LEGACY_KEY],v1);
  storage.setItem(Sync.STATE_KEY,'changed');Sync.captureInitialBackup(storage);
  assert.equal(JSON.parse(storage.getItem(Sync.INITIAL_BACKUP_KEY)).raw[Sync.STATE_KEY],v2);
  assert.ok(!JSON.stringify(Sync.exportRecovery(storage)).includes('secret-never-export'));
});
test('unknown differing local and cloud require an explicit choice', async () => {
  const f=fixture(state('15'));await f.engine.sync();
  assert.equal(f.engine.status().mode,'conflict'); assert.equal(f.calls.length,0);assert.equal(f.applied(),null);
  assert.equal(f.engine.metadata().ack,null);
  await f.engine.resolve('local');assert.equal(f.server.payload.rooms[0].curr,'15');assert.equal(f.calls[0].expectedRevision,1);
  assert.equal(f.engine.status().mode,'synced');f.engine.dispose();
});
test('empty remote is never seeded, even after editing defaults', async () => {
  const f=fixture(); f.server.exists=false;await f.engine.sync();f.engine.saveLocal(state('99'));await f.engine.sync();
  assert.equal(f.engine.status().mode,'needs-baseline');assert.equal(f.calls.length,0);f.engine.dispose();
});
test('offline edits survive reload and reconnect to the unchanged base', async () => {
  const f=fixture();await f.engine.sync();f.offline(true);f.engine.saveLocal(state('18'));await f.engine.sync();f.engine.dispose();
  const next=fixture(state('18'),{storage:f.storage});await next.engine.sync();
  assert.equal(next.calls.length,1);assert.equal(next.server.payload.rooms[0].curr,'18');next.engine.dispose();
});
test('offline edits and a newer remote both survive reload as a conflict', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('18'));f.engine.dispose();
  const next=fixture(state('18'),{storage:f.storage});next.server.payload=state('21');next.server.revision=2;await next.engine.sync();
  assert.equal(next.engine.status().mode,'conflict');assert.equal(next.engine.snapshot().rooms[0].curr,'18');assert.equal(next.server.payload.rooms[0].curr,'21');assert.equal(next.calls.length,0);next.engine.dispose();
});
test('clean local refresh backs up before applying newer remote', async () => {
  const f=fixture();await f.engine.sync();f.server.payload=state('25');f.server.revision=2;await f.engine.sync();
  assert.equal(f.applied().rooms[0].curr,'25');const records=Sync.exportRecovery(f.storage).records;
  assert.ok(records.some(r=>r.raw.includes('before-cloud-apply')&&r.raw.includes('"curr":"12"')));f.engine.dispose();
});
test('backup failure blocks destructive remote replacement', async () => {
  const f=fixture();await f.engine.sync();f.server.payload=state('25');f.server.revision=2;f.storage.fail=true;await f.engine.sync();
  assert.equal(f.engine.status().mode,'backup_error');assert.equal(f.engine.snapshot().rooms[0].curr,'12');assert.equal(f.applied(),null);f.engine.dispose();
});
test('409 preserves both versions and does not advance the acknowledged base', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('18'));
  f.transport.save=async()=>{f.server.payload=state('26');f.server.revision=2;throw Object.assign(new Error('conflict'),{status:409});};
  await f.engine.sync();assert.equal(f.engine.status().mode,'conflict');assert.equal(f.engine.snapshot().rooms[0].curr,'18');assert.equal(f.engine.metadata().ack.revision,1);assert.equal(f.applied(),null);f.engine.dispose();
});
test('explicit use-cloud has a durable pair backup', async () => {
  const f=fixture(state('15'));await f.engine.sync();await f.engine.resolve('remote');
  assert.equal(f.engine.snapshot().rooms[0].curr,'12');assert.equal(f.calls.length,0);
  assert.ok(Sync.exportRecovery(f.storage).records.some(r=>r.raw.includes('explicit-remote')&&r.raw.includes('"curr":"15"')));f.engine.dispose();
});
test('a remote change after the choice requires a new choice', async () => {
  const f=fixture(state('15'));await f.engine.sync();f.server.payload=state('30');f.server.revision=2;await f.engine.resolve('remote');
  assert.equal(f.engine.status().mode,'conflict');assert.equal(f.engine.snapshot().rooms[0].curr,'15');assert.equal(f.applied(),null);f.engine.dispose();
});
test('edits made while GET is in flight are never overwritten', async () => {
  const f=fixture();await f.engine.sync();let release;
  f.transport.load=()=>new Promise(r=>{release=r;});const pending=f.engine.sync();
  f.engine.saveLocal(state('17'));release({exists:true,payload:state('28'),revision:2});await pending;
  assert.equal(f.engine.snapshot().rooms[0].curr,'17');assert.equal(f.engine.status().mode,'conflict');f.engine.dispose();
});
test('writes serialize and an in-flight edit becomes the next write', async () => {
  const f=fixture();await f.engine.sync();const originalSave=f.transport.save;let release,active=0,max=0;
  f.transport.save=async(...args)=>{active++;max=Math.max(max,active);if(!release)await new Promise(r=>{release=r;});const out=await originalSave(...args);active--;return out;};
  f.engine.saveLocal(state('17'));const pending=f.engine.sync();await new Promise(setImmediate);f.engine.saveLocal(state('19'));const repeated=f.engine.sync();release();await pending;await repeated;
  assert.equal(max,1);assert.equal(f.calls.length,2);assert.equal(f.server.payload.rooms[0].curr,'19');assert.equal(f.calls[1].expectedRevision,2);f.engine.dispose();
});
test('endpoint change cannot reuse a previous endpoint acknowledgment', async () => {
  const f=fixture();await f.engine.sync();f.engine.dispose();const next=fixture(state(),{storage:f.storage,endpoint:'worker-v1:https://other.example.test/v1/state'});
  next.server.payload=state('41');await next.engine.sync();assert.equal(next.engine.status().mode,'conflict');assert.equal(next.calls.length,0);assert.equal(next.engine.metadata().ack,null);next.engine.dispose();
});
test('stale-tab save preserves its draft without overwriting shared local state', async () => {
  const f=fixture();await f.engine.sync();const other=fixture(state(),{storage:f.storage,tabId:'tab-b'});await other.engine.sync();
  f.engine.saveLocal(state('16'));assert.equal(other.engine.saveLocal(state('17')),false);
  assert.equal(JSON.parse(f.storage.getItem(Sync.STATE_KEY)).rooms[0].curr,'16');assert.equal(other.engine.status().conflict.kind,'other-tab');
  assert.equal(JSON.parse(f.storage.getItem(other.engine.keys.draftKey)).payload.rooms[0].curr,'17');f.engine.dispose();other.engine.dispose();
});
test('a stale-tab durable draft is recovered after reload', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('18'));f.engine.dispose();f.storage.setItem(Sync.STATE_KEY,JSON.stringify(state('20')));
  const next=fixture(state('20'),{storage:f.storage,tabId:'tab-a'});
  assert.equal(next.engine.snapshot().rooms[0].curr,'18');assert.equal(next.engine.status().conflict.kind,'other-tab');next.engine.dispose();
});
test('transport load never writes revision; Worker POST carries explicit CAS and mutation id', async () => {
  const storage=new Storage();storage.setItem('yilanFamilyPin','synthetic-pin');storage.setItem('yilanCloudRevision','99');const requests=[];
  const transport=createTransport(workerConfig(),storage,async(url,req)=>{assert.equal(url,'https://sync.example.test/v1/state');requests.push(req);return {ok:true,json:async()=>({exists:true,payload:state(),revision:5})};},{randomUUID:()=> 'actor'},privateLink());
  await transport.load();assert.equal(storage.getItem('yilanCloudRevision'),'99');assert.equal(storage.length,3);
  assert.equal(requests[0].headers.Authorization,'Bearer '+SYNTHETIC_TOKEN);assert.equal(requests[0].headers['x-family-pin'],undefined);
  await transport.save(state(),5,'mutation-test');const body=JSON.parse(requests[1].body);
  assert.equal(body.expected_revision,5);assert.equal(body.mutation_id,'mutation-test');assert.equal(requests[1].headers.apikey,undefined);assert.equal(requests[1].headers['x-family-pin'],undefined);assert.equal(requests[1].headers.Authorization,'Bearer '+SYNTHETIC_TOKEN);assert.equal(requests[1].redirect,'error');assert.equal(requests[1].credentials,'omit');
  await assert.rejects(()=>transport.save(state(),0,'mutation-test'),/verified_baseline_required/);
});
test('legacy config remains legacy and requires its anon key', () => {
  const storage=new Storage();const t=createTransport({functionUrl:'https://legacy.example.test/function',anonKey:'synthetic-public-key'},storage,()=>{},{});
  assert.equal(t.protocol,'supabase-legacy');assert.equal(t.atomic,false);assert.equal(t.enabled(),true);
});
test('credential-bearing or unknown endpoint configuration is rejected',()=>{
  for(const config of [{protocol:'other',functionUrl:'https://sync.example.test'},{protocol:'worker-v1',functionUrl:'https://sync.example.test?token=secret'},{protocol:'worker-v1',functionUrl:'https://user:pass@sync.example.test'}]){
    assert.equal(createTransport(config,new Storage(),()=>{},{}).enabled(),false);
  }
});
test('service worker never intercepts cross-origin/API/auth/unknown assets', () => {
  const handlers={};vm.runInNewContext(fs.readFileSync(require.resolve('../sw.js'),'utf8'),{URL,Set,self:{registration:{scope:'https://app.example.test/rental/'},location:{origin:'https://app.example.test'},addEventListener:(name,handler)=>handlers[name]=handler}});
  for(const [url,method,headers] of [
    ['https://api.example.test/v1/state','GET',{}],['https://app.example.test/api/state','GET',{}],['https://app.example.test/rental/api','GET',{}],['https://app.example.test/rental/index.html?token=a','GET',{}],['https://app.example.test/rental/index.html','POST',{}],['https://app.example.test/rental/index.html','GET',{'x-family-pin':'test'}],['https://app.example.test/rental/unknown.js','GET',{}],['https://app.example.test/rental/index.html','GET',{'Authorization':'Bearer '+SYNTHETIC_TOKEN}]
  ]){
    let intercepted=false;handlers.fetch({request:{url,method,headers:new Headers(headers)},respondWith:()=>{intercepted=true;}});assert.equal(intercepted,false,url);
  }
});
test('draft lineage wins over another tab newer acknowledged metadata on reload', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('18'));f.engine.dispose();
  const meta=JSON.parse(f.storage.getItem(f.engine.keys.metaKey));meta.ack={revision:2,payload:state('25')};f.storage.setItem(f.engine.keys.metaKey,JSON.stringify(meta));
  const next=fixture(state('18'),{storage:f.storage});next.server.payload=state('25');next.server.revision=2;await next.engine.sync();
  assert.equal(next.engine.status().mode,'conflict');assert.equal(next.engine.metadata().ack.revision,1);assert.equal(next.calls.length,0);next.engine.dispose();
});
test('a reloaded or duplicated tab recovers its predecessor draft into a unique journal', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('18'));f.engine.dispose();
  const next=fixture(state('18'),{storage:f.storage,tabId:'fresh-tab',engine:{recoveryDraftId:'tab-a'}});
  assert.notEqual(next.engine.keys.draftKey,f.engine.keys.draftKey);
  assert.equal(JSON.parse(f.storage.getItem(next.engine.keys.draftKey)).payload.rooms[0].curr,'18');next.engine.dispose();
});
test('uncertain network failure retries the identical mutation ID after reload', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('17'));let mutation;
  f.transport.save=async(p,r,id)=>{mutation=id;throw new Error('lost-response-before-commit');};await f.engine.sync();f.engine.dispose();
  const next=fixture(state('17'),{storage:f.storage});await next.engine.sync();assert.equal(next.calls[0].mutationId,mutation);next.engine.dispose();
});
test('raw remote data is retained before normalization', async () => {
  const f=fixture(state('18'),{engine:{normalize:p=>{delete p.extraSyntheticField;return p;}}});f.server.payload.extraSyntheticField='retain-me';await f.engine.sync();
  assert.ok(Sync.exportRecovery(f.storage).records.some(r=>r.raw.includes('retain-me')));f.engine.dispose();
});
test('metadata-only quota failure after remote apply cannot authorize a stale UI overwrite', async () => {
  const f=fixture();await f.engine.sync();const original=f.storage.setItem.bind(f.storage);let failMeta=true;
  f.storage.setItem=(key,value)=>{if(failMeta&&key===f.engine.keys.metaKey)throw new Error('metadata-quota');original(key,value);};
  f.server.payload=state('25');f.server.revision=2;await f.engine.sync();
  assert.equal(f.engine.status().mode,'storage_error');assert.equal(f.applied().rooms[0].curr,'25');assert.equal(f.engine.snapshot().rooms[0].curr,'25');
  assert.equal(JSON.parse(f.storage.getItem(Sync.STATE_KEY)).rooms[0].curr,'25');
  failMeta=false;const staleUi=state('12');staleUi.rate=9;assert.equal(f.engine.saveLocal(staleUi),false);await f.engine.sync();
  assert.equal(f.calls.length,0);assert.equal(f.server.payload.rooms[0].curr,'25');assert.equal(f.engine.status().mode,'storage_error');f.engine.dispose();
});
test('invalid payload responses show an actionable validation status, never offline', async () => {
  const f=fixture();await f.engine.sync();f.engine.saveLocal(state('17'));f.transport.save=async()=>{throw Object.assign(new Error('invalid_payload'),{status:400});};
  await f.engine.sync();assert.equal(f.engine.status().mode,'invalid-data');assert.equal(f.engine.snapshot().rooms[0].curr,'17');f.engine.dispose();
});
test('unsaved modal edits defer remote replacement until editing ends', async () => {
  let editing=false;const f=fixture(state(),{engine:{canApplyRemote:()=>!editing}});await f.engine.sync();
  f.server.payload=state('25');f.server.revision=2;editing=true;await f.engine.sync();
  assert.equal(f.engine.status().mode,'editing');assert.equal(f.applied(),null);assert.equal(f.engine.metadata().ack.revision,1);
  editing=false;await f.engine.sync();assert.equal(f.applied().rooms[0].curr,'25');f.engine.dispose();
});

test('capability link is scrubbed before storage and resumes only at the same endpoint', () => {
  const storage=new Storage(),browser=privateLink(),events=[];
  const replace=browser.history.replaceState;browser.history.replaceState=(...args)=>{events.push('scrub');replace(...args);};
  const set=storage.setItem.bind(storage);storage.setItem=(...args)=>{events.push('store');set(...args);};
  const first=createTransport(workerConfig(),storage,()=>{}, {},browser);
  assert.deepEqual(events,['scrub','store']);assert.equal(browser.location.hash,'');
  assert.equal(browser.calls[0].url,'/rental/?view=month');assert.deepEqual(browser.calls[0].state,{view:'month'});
  assert.equal(first.credentialStatus(),'ready');assert.equal(first.getPin(),'');assert.equal(first.getCredential(),SYNTHETIC_TOKEN);
  const second=createTransport(workerConfig(),storage,()=>{},{});
  assert.equal(second.getCredential(),SYNTHETIC_TOKEN);
  const other=createTransport(workerConfig('https://other.example.test/v1/state'),storage,()=>{},{});
  assert.equal(other.getCredential(),'');assert.equal(other.credentialStatus(),'access_link_required');
  assert.ok(!first.endpoint.includes(SYNTHETIC_TOKEN));
});
test('capability credentials stay out of recovery, drafts, metadata, and request bodies', async () => {
  const storage=new Storage();storage.setItem(Sync.STATE_KEY,JSON.stringify(state()));let remote=state(),revision=1;const bodies=[];
  const transport=createTransport(workerConfig(),storage,async(url,request)=>{
    if(request.method==='POST'){bodies.push(request.body);remote=JSON.parse(request.body).payload;revision++;}
    return {ok:true,json:async()=>({exists:true,payload:remote,revision})};
  },{randomUUID:()=> 'actor'},privateLink());
  const engine=Sync.create({storage,transport,initialState:state(),tabId:'synthetic',uuid:()=> 'test-id',debounceMs:100000});
  await engine.sync();assert.equal(engine.status().mode,'synced');engine.saveLocal(state('18'));await engine.sync();
  const exported=JSON.stringify(engine.exportRecovery());assert.ok(!exported.includes(SYNTHETIC_TOKEN));assert.ok(!exported.includes('yilanAccessToken'));
  assert.ok(!JSON.stringify(engine.metadata()).includes(SYNTHETIC_TOKEN));assert.ok(!bodies.join('').includes(SYNTHETIC_TOKEN));
  for(const [key,value] of storage.data)if(!key.startsWith('yilanAccessToken:'))assert.ok(!value.includes(SYNTHETIC_TOKEN),key);
  engine.dispose();
});
test('legacy transport never consumes or sends a capability token', async () => {
  const storage=new Storage();storage.setItem('yilanFamilyPin','synthetic-pin');const browser=privateLink(),requests=[];
  const t=createTransport({functionUrl:'https://legacy.example.test/function',anonKey:'synthetic-public-key'},storage,async(url,request)=>{requests.push(request);return {ok:true,json:async()=>({})};},{},browser);
  assert.equal(browser.location.hash,'');assert.equal(storage.length,1);assert.equal(t.getCredential(),'synthetic-pin');
  await t.load();assert.equal(requests[0].headers['x-family-pin'],'synthetic-pin');assert.equal(requests[0].headers.apikey,'synthetic-public-key');assert.equal(requests[0].headers.Authorization,undefined);
  t.setPin('synthetic-new-pin');assert.equal(t.getPin(),'synthetic-new-pin');t.clearCredential();assert.equal(t.getPin(),'');
});
test('only capability-v1 on a trusted configured HTTPS Worker can consume links', async () => {
  const configs=[
    {protocol:'worker-v1',functionUrl:'https://sync.example.test/v1/state'},
    {...workerConfig(),authMode:'unknown'},
    {...workerConfig(),protocol:'supabase-legacy',anonKey:'synthetic-public-key'},
    workerConfig('http://127.0.0.1/v1/state'),workerConfig('http://sync.example.test/v1/state'),
    workerConfig('https://user:pass@sync.example.test/v1/state'),workerConfig('https://sync.example.test/v1/state?token=synthetic'),
    workerConfig('https://sync.example.test/v1/state#synthetic'),workerConfig('not-a-url')
  ];
  for(const config of configs){
    const storage=new Storage(),browser=privateLink();let fetched=false;
    const t=createTransport(config,storage,async()=>{fetched=true;},{},browser);
    assert.equal(browser.location.hash,'');assert.equal(storage.length,0);assert.equal(t.enabled(),false);assert.equal(t.getCredential(),'');
    await assert.rejects(()=>t.load(),/cloud_not_configured/);assert.equal(fetched,false);
  }
});
test('malformed capability links are scrubbed and fail closed without storage or requests', async () => {
  for(const token of ['', 'A'.repeat(42),'A'.repeat(44),'A'.repeat(42)+'=','A'.repeat(42)+'/',SYNTHETIC_TOKEN+'\n',SYNTHETIC_TOKEN+'&other=1','%41'.repeat(43)]){
    const storage=new Storage(),browser=privateLink('#yilan-access='+token);let fetched=false;
    const t=createTransport(workerConfig(),storage,async()=>{fetched=true;},{},browser);
    assert.equal(browser.location.hash,'');assert.equal(storage.length,0);assert.equal(t.getCredential(),'');assert.equal(t.credentialStatus(),'invalid_access_link');
    await assert.rejects(()=>t.load(),/invalid_access_link/);assert.equal(fetched,false);
  }
});
test('missing links never generate credentials or reuse the legacy PIN', async () => {
  const storage=new Storage();storage.setItem('yilanFamilyPin','synthetic-pin');
  const t=createTransport(workerConfig(),storage,()=>{throw new Error('must not fetch');},{randomUUID:()=>{throw new Error('must not generate');}});
  assert.equal(t.getCredential(),'');assert.equal(t.getPin(),'');assert.equal(t.credentialStatus(),'access_link_required');
  t.setPin('B'.repeat(43));assert.equal(t.getCredential(),'');assert.equal(storage.getItem('yilanFamilyPin'),'synthetic-pin');
  await assert.rejects(()=>t.load(),/access_link_required/);
});
test('disconnect removes only the current endpoint credential on this device', () => {
  const storage=new Storage();storage.setItem(Sync.STATE_KEY,JSON.stringify(state()));storage.setItem('yilanFamilyPin','synthetic-pin');
  const t=createTransport(workerConfig(),storage,()=>{},{},privateLink());
  const other=createTransport(workerConfig('https://other.example.test/v1/state'),storage,()=>{},{},privateLink('#yilan-access='+'B'.repeat(43)));
  const otherDevice=new Storage(),remoteDevice=createTransport(workerConfig(),otherDevice,()=>{},{},privateLink());
  t.clearCredential();assert.equal(t.getCredential(),'');assert.equal(t.credentialStatus(),'access_link_required');
  assert.equal(other.getCredential(),'B'.repeat(43));assert.equal(remoteDevice.getCredential(),SYNTHETIC_TOKEN);
  assert.equal(storage.getItem('yilanFamilyPin'),'synthetic-pin');assert.deepEqual(JSON.parse(storage.getItem(Sync.STATE_KEY)),state());
});
test('fragment scrub and credential persistence failures never send the token', async () => {
  const storage=new Storage(),browser=privateLink();browser.history.replaceState=()=>{throw new Error('history unavailable');};
  const t=createTransport(workerConfig(),storage,()=>{throw new Error('must not fetch');},{},browser);
  assert.equal(storage.length,0);assert.equal(t.credentialStatus(),'access_link_scrub_failed');await assert.rejects(()=>t.load(),/access_link_scrub_failed/);
  for(const silentFailure of [false,true]){
    const failed=new Storage(),link=privateLink();if(silentFailure)failed.setItem=()=>{};else failed.fail=true;
    const blocked=createTransport(workerConfig(),failed,()=>{throw new Error('must not fetch');},{},link);
    assert.equal(link.location.hash,'');assert.equal(blocked.credentialStatus(),'access_storage_error');assert.equal(blocked.getCredential(),'');
    await assert.rejects(()=>blocked.load(),/access_storage_error/);
  }
});
test('failed credential removal cannot silently continue authenticated requests', async () => {
  const storage=new Storage(),t=createTransport(workerConfig(),storage,()=>{throw new Error('must not fetch');},{},privateLink());
  storage.removeItem=()=>{};assert.throws(()=>t.clearCredential(),/credential_removal_failed/);assert.equal(t.getCredential(),'');
  await assert.rejects(()=>t.load(),/access_storage_error/);
});

test('a truly new device automatically adopts authenticated cloud after a durable backup', async () => {
  const storage=new Storage(),f=fixture(state('15'),{storage});await f.engine.sync();
  assert.equal(f.engine.status().mode,'synced');assert.equal(f.applied().rooms[0].curr,'12');assert.equal(f.calls.length,0);
  assert.equal(JSON.parse(storage.getItem(Sync.STATE_KEY)).rooms[0].curr,'12');
  const backup=Sync.exportRecovery(storage).records.find(r=>r.raw.includes('before-cloud-apply'));
  assert.ok(backup);assert.equal(JSON.parse(backup.raw).raw[Sync.STATE_KEY],null);assert.equal(JSON.parse(backup.raw).raw[Sync.LEGACY_KEY],null);
  f.engine.dispose();
});
test('a first user edit during the pristine-device cloud read is preserved as a conflict', async () => {
  const f=fixture(state('15'),{storage:new Storage()});let release;
  f.transport.load=()=>new Promise(resolve=>{release=resolve;});const pending=f.engine.sync();
  f.engine.saveLocal(state('17'));release({exists:true,payload:state('12'),revision:1});await pending;
  assert.equal(f.engine.status().mode,'conflict');assert.equal(f.engine.snapshot().rooms[0].curr,'17');assert.equal(f.applied(),null);assert.equal(f.calls.length,0);
  assert.equal(JSON.parse(f.storage.getItem(Sync.STATE_KEY)).rooms[0].curr,'17');f.engine.dispose();
});
test('legacy records or a recovered draft prevent pristine-device automatic replacement', async () => {
  const legacy=new Storage();legacy.setItem(Sync.LEGACY_KEY,'existing-legacy-records');
  const f=fixture(state('15'),{storage:legacy});await f.engine.sync();assert.equal(f.engine.status().mode,'conflict');assert.equal(f.applied(),null);f.engine.dispose();
  const storage=new Storage();storage.setItem('yilanSyncDraft:old-tab',JSON.stringify({version:1,endpoint:'worker-v1:https://sync.example.test/v1/state',payload:state('15'),base:null}));
  const draft=fixture(state('15'),{storage,engine:{recoveryDraftId:'old-tab'}});await draft.engine.sync();assert.equal(draft.engine.status().mode,'conflict');assert.equal(draft.applied(),null);draft.engine.dispose();
});
