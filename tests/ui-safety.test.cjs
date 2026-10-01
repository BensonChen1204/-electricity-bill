// Execute the actual inline app script with a minimal DOM for failure paths.
// Layout/mobile interaction still requires the separate real-browser smoke test.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Sync=require('../sync-engine.js');
const createTransport=require('../cloud-sync.js');
const SYNTHETIC_TOKEN='A'.repeat(43);
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const synthetic=()=>({schemaVersion:2,month:'2040-01',rate:3,rooms:['101','102','201','202','301','302'].map(room=>({room,prev:10,curr:'12',rent:20,water:2,others:[]})),history:[]});
function app({initialFailure=false,capability=false,token=null,initial=synthetic()}={}){
  const elements=new Map();
  function element(id=''){return {id,disabled:false,hidden:false,value:'',innerHTML:'',textContent:'',dataset:{},style:{},children:[],closed:false,classList:{add(){},remove(){},toggle(){}},appendChild(x){this.children.push(x);},addEventListener(){},querySelector(){return element();},querySelectorAll(){return [];},close(){this.closed=true;},showModal(){},focus(){},click(){},remove(){},getContext(){return {};}};}
  for(const match of html.matchAll(/\bid="([^"]+)"/g))elements.set(match[1],element(match[1]));
  let fail=initialFailure;const data=new Map([['yilanUtilityV2',JSON.stringify(initial)],['yilanUtilityV1','legacy-raw-synthetic'],['yilanFamilyPin','synthetic-secret']]);
  const storage={get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem(k,v){if(fail)throw new Error('quota');data.set(k,String(v));},removeItem:k=>data.delete(k)};
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);},querySelectorAll:selector=>selector==='button,input'?[...elements.values()]:[],querySelector:()=>element(),createElement:()=>element(),addEventListener(){},visibilityState:'visible',body:element()};
  const location={hash:token===null?'':'#yilan-access='+token,pathname:'/',search:''};
  const cloud=capability?createTransport({protocol:'worker-v1',authMode:'capability-v1',functionUrl:'https://synthetic.example.test/v1/state'},storage,async()=>({ok:true,json:async()=>({exists:true,payload:synthetic(),revision:1})}),{randomUUID:()=> 'synthetic-device'},{location,history:{replaceState(){location.hash='';}}})
    :{enabled:()=>false,getPin:()=>storage.getItem('yilanFamilyPin')||'',setPin:pin=>pin?storage.setItem('yilanFamilyPin',pin):storage.removeItem('yilanFamilyPin'),endpoint:'unconfigured',atomic:false};
  const window={YilanSync:Sync,YilanCloud:cloud,addEventListener(){},scrollTo(){}};
  const context=vm.createContext({window,document,localStorage:storage,sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=> 'synthetic-tab'},navigator:{},Date,Number,Math,JSON,Set,Blob,URL,console,confirm:()=>true,setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(code,context);
  return {context,elements,storage,cloud,location,setFail:v=>{fail=v;},get:expr=>vm.runInContext(expr,context),run:expr=>vm.runInContext(expr,context)};
}
test('initial backup failure shows only recovery panel, never baked-in readings',()=>{
  const f=app({initialFailure:true});assert.equal(f.get('state'),null);
  assert.equal(f.elements.get('appShell').hidden,true);assert.equal(f.elements.get('recoveryBlockedPanel').hidden,false);
  assert.equal(f.elements.get('rooms').children.length,0);assert.equal(f.elements.get('confirmComplete').disabled,true);
  assert.equal(f.elements.get('exportBlockedRecovery').disabled,false);
  assert.equal(f.storage.getItem('yilanUtilityV1'),'legacy-raw-synthetic');
});
test('month-completion storage failure preserves memory, freezes mutation controls, and never toasts success',()=>{
  const f=app();const before=f.storage.getItem('yilanUtilityV2');f.setFail(true);f.elements.get('confirmComplete').onclick();
  assert.equal(f.storage.getItem('yilanUtilityV2'),before);assert.equal(f.get('state.month'),'2040-02');
  assert.equal(f.get('state.history.length'),1);assert.equal(f.get('dataEditsBlocked'),true);
  assert.equal(f.elements.get('confirmComplete').disabled,true);assert.equal(f.elements.get('saveSettings').disabled,true);
  assert.equal(f.elements.get('exportBlockedRecovery').disabled,false);assert.equal(f.elements.get('cancelComplete').disabled,false);
  assert.equal(f.elements.get('completeDialog').closed,false);
  assert.match(f.elements.get('toast').textContent,/儲存失敗/);assert.doesNotMatch(f.elements.get('toast').textContent,/已完成/);
  const recovery=f.run('window.YilanSync.exportRecovery(localStorage)');assert.ok(!JSON.stringify(recovery).includes('synthetic-secret'));
});
test('settings save failure never closes the dialog or reports a successful save',()=>{
  const f=app();f.setFail(true);f.elements.get('monthInput').value='2041-01';f.elements.get('rateInput').value='4';f.elements.get('saveSettings').onclick();
  assert.equal(f.elements.get('settingsDialog').closed,false);assert.match(f.elements.get('toast').textContent,/儲存失敗/);assert.doesNotMatch(f.elements.get('toast').textContent,/設定已更新/);
});
test('UI recalculation and monthly completion semantics remain intact for synthetic data',()=>{
  const f=app();assert.equal(f.get('calc(state.rooms[0]).amount'),6);assert.equal(f.get('roomTotal(state.rooms[0])'),28);
  f.elements.get('confirmComplete').onclick();assert.equal(f.get('state.month'),'2040-02');assert.equal(f.get('state.rooms[0].prev'),12);assert.equal(f.get('state.rooms[0].curr'),'');
  assert.equal(f.get('state.history[0].rooms[0].total'),28);assert.equal(f.get('state.rooms[0].rent'),20);f.run('syncController.dispose()');
});

test('private-link UI has no password entry and directs a new device to the family link',()=>{
  const f=app({capability:true});f.elements.get('cloudBtn').onclick();
  assert.equal(f.elements.get('legacyCloudAuth').hidden,true);assert.equal(f.elements.get('cloudPinInput').disabled,true);assert.equal(f.elements.get('cloudPinInput').value,'');
  assert.equal(f.elements.get('cloudPrivateLinkNote').hidden,false);assert.match(f.elements.get('cloudPrivateLinkNote').textContent,/家人提供的完整私人連結/);
  assert.equal(f.elements.get('connectCloud').hidden,true);assert.equal(f.elements.get('disconnectCloud').hidden,true);
  assert.match(f.elements.get('dataStatus').textContent,/私人連結/);assert.equal(f.cloud.getCredential(),'');f.run('syncController.dispose()');
});
test('private link opens and reconnects without a PIN while disconnect keeps rental data',async()=>{
  const f=app({capability:true,token:SYNTHETIC_TOKEN});await f.run('syncController.sync()');f.elements.get('cloudBtn').onclick();
  assert.equal(f.location.hash,'');assert.equal(f.elements.get('dataStatus').textContent,'雲端已同步');
  assert.equal(f.elements.get('legacyCloudAuth').hidden,true);assert.equal(f.elements.get('cloudPinInput').value,'');
  assert.equal(f.elements.get('connectCloud').textContent,'重新同步');assert.equal(f.elements.get('connectCloud').hidden,false);
  assert.ok(![...f.elements.values()].some(el=>el.textContent.includes(SYNTHETIC_TOKEN)||String(el.value).includes(SYNTHETIC_TOKEN)));
  await f.elements.get('connectCloud').onclick();const before=f.storage.getItem('yilanUtilityV2');
  f.elements.get('disconnectCloud').onclick();assert.equal(f.cloud.getCredential(),'');assert.equal(f.storage.getItem('yilanUtilityV2'),before);
  assert.equal(f.storage.getItem('yilanFamilyPin'),'synthetic-secret');assert.equal(f.elements.get('connectCloud').hidden,true);
  assert.match(f.elements.get('toast').textContent,/已取消/);f.run('syncController.dispose()');
});
test('expired or malformed private links show actionable link guidance instead of PIN errors',async()=>{
  const f=app({capability:true,token:SYNTHETIC_TOKEN});await f.run('syncController.sync()');f.run("syncStatus={mode:'unauthorized'};updateDataStatus()");
  assert.match(f.elements.get('dataStatus').textContent,/私人連結已失效/);assert.doesNotMatch(f.elements.get('dataStatus').textContent,/密碼/);f.run('syncController.dispose()');
  const invalid=app({capability:true,token:'malformed'});assert.equal(invalid.location.hash,'');assert.match(invalid.elements.get('dataStatus').textContent,/連結不完整/);invalid.run('syncController.dispose()');
});
test('legacy cloud dialog keeps its existing PIN flow until config cutover',async()=>{
  const f=app();f.elements.get('cloudBtn').onclick();assert.equal(f.elements.get('legacyCloudAuth').hidden,false);
  assert.equal(f.elements.get('cloudPinInput').disabled,false);assert.equal(f.elements.get('cloudPinInput').value,'synthetic-secret');assert.equal(f.elements.get('cloudPrivateLinkNote').hidden,true);
  f.elements.get('cloudPinInput').value='synthetic-updated';await f.elements.get('connectCloud').onclick();assert.equal(f.storage.getItem('yilanFamilyPin'),'synthetic-updated');
  f.elements.get('disconnectCloud').onclick();assert.equal(f.storage.getItem('yilanFamilyPin'),null);f.run('syncController.dispose()');
});

test('imported room, reading, other-charge, and history strings cannot create active HTML',()=>{
  const initial=synthetic();
  initial.rooms[0].room='<img src=x onerror="window.syntheticXss=1">';
  initial.rooms[0].curr='" autofocus onfocus="window.syntheticXss=2';
  initial.rooms[0].others=[{name:'<svg onload="window.syntheticXss=3">',amount:1}];
  initial.history=[{month:'2039-12',rate:'<img src=x onerror="window.syntheticXss=4">',rooms:[],completedAt:'2040-01-01T00:00:00Z'}];
  const raw=JSON.stringify(initial),f=app({initial});f.run('openFixed();renderHistory()');
  for(const id of ['rooms','billBody','tenantGrid','fixedGrid']){
    const markup=f.elements.get(id).children.map(el=>el.innerHTML).join('');
    assert.ok(!markup.includes('<img src=x'),id);assert.ok(!markup.includes('<svg onload='),id);
    assert.ok(!markup.includes('value="" autofocus onfocus='),id);assert.ok(markup.includes('&lt;img src=x'),id);
  }
  assert.ok(f.elements.get('rooms').children[0].innerHTML.includes('value="&quot; autofocus onfocus=&quot;'));
  assert.ok(f.elements.get('tenantGrid').children[0].innerHTML.includes('&lt;svg onload=&quot;'));
  assert.ok(f.elements.get('historyList').innerHTML.includes('&lt;img src=x onerror=&quot;'));
  assert.ok(!f.elements.get('historyList').innerHTML.includes('<img src=x'));
  assert.equal(JSON.parse(f.storage.getItem(Sync.INITIAL_BACKUP_KEY)).raw.yilanUtilityV2,raw);
  assert.equal(f.storage.getItem('yilanUtilityV2'),raw);f.run('syncController.dispose()');
});
