// Execute the actual inline app script with a minimal DOM for failure paths.
// Layout/mobile interaction still requires the separate real-browser smoke test.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const Sync=require('../sync-engine.js');
const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
const code=html.match(/<script>([\s\S]*?)<\/script>/)[1];
const synthetic=()=>({schemaVersion:2,month:'2040-01',rate:3,rooms:['101','102','201','202','301','302'].map(room=>({room,prev:10,curr:'12',rent:20,water:2,others:[]})),history:[]});
function app({initialFailure=false}={}){
  const elements=new Map();
  function element(id=''){return {id,disabled:false,hidden:false,value:'',innerHTML:'',textContent:'',dataset:{},style:{},children:[],closed:false,classList:{add(){},remove(){},toggle(){}},appendChild(x){this.children.push(x);},addEventListener(){},querySelector(){return element();},querySelectorAll(){return [];},close(){this.closed=true;},showModal(){},focus(){},click(){},remove(){},getContext(){return {};}};}
  for(const match of html.matchAll(/\bid="([^"]+)"/g))elements.set(match[1],element(match[1]));
  let fail=initialFailure;const data=new Map([['yilanUtilityV2',JSON.stringify(synthetic())],['yilanUtilityV1','legacy-raw-synthetic'],['yilanFamilyPin','synthetic-secret']]);
  const storage={get length(){return data.size;},key:i=>[...data.keys()][i],getItem:k=>data.get(k)??null,setItem(k,v){if(fail)throw new Error('quota');data.set(k,String(v));},removeItem:k=>data.delete(k)};
  const document={getElementById:id=>{if(!elements.has(id))elements.set(id,element(id));return elements.get(id);},querySelectorAll:selector=>selector==='button,input'?[...elements.values()]:[],querySelector:()=>element(),createElement:()=>element(),addEventListener(){},visibilityState:'visible',body:element()};
  const window={YilanSync:Sync,YilanCloud:{enabled:()=>false,getPin:()=>'',endpoint:'unconfigured',atomic:false},addEventListener(){},scrollTo(){}};
  const context=vm.createContext({window,document,localStorage:storage,sessionStorage:{getItem:()=>null,setItem(){}},crypto:{randomUUID:()=> 'synthetic-tab'},navigator:{},Date,Number,Math,JSON,Set,Blob,URL,console,confirm:()=>true,setTimeout:()=>0,clearTimeout(){}});
  vm.runInContext(code,context);
  return {context,elements,storage,setFail:v=>{fail=v;},get:expr=>vm.runInContext(expr,context),run:expr=>vm.runInContext(expr,context)};
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
