import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {setupPage} from '../src/setup-page.ts';

test('restoring a saved setup key blocks generation until its verifier is ready',async()=>{
  const elements=new Map(),digests=[];let generations=0;
  const get=id=>{if(!elements.has(id))elements.set(id,{disabled:false,textContent:'',onclick:null});return elements.get(id);};
  const saved=new Map([['yilanPrivateLinkSetup:v1',Buffer.alloc(32,1).toString('base64url')]]);
  const context={document:{getElementById:get},TextEncoder,Uint8Array,
    crypto:{subtle:{digest:()=>new Promise(resolve=>digests.push(resolve))},getRandomValues:bytes=>{generations++;return bytes.fill(2);}},
    sessionStorage:{getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value)},
    navigator:{clipboard:{writeText:async()=>{}}},confirm:()=>true,btoa:value=>Buffer.from(value,'binary').toString('base64'),
    setTimeout,clearTimeout,AbortController,fetch:()=>{throw new Error('not used');}};
  const script=setupPage('test').match(/<script nonce="test">([\s\S]*?)<\/script>/)[1];
  vm.runInNewContext(script,context);
  assert.equal(get('generate').disabled,true);await get('generate').onclick();assert.equal(generations,0);
  digests.shift()(new ArrayBuffer(32));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(get('generate').disabled,false);
  const generating=get('generate').onclick();assert.equal(generations,1);assert.equal(get('copyVerifier').disabled,true);
  digests.shift()(new Uint8Array(32).fill(1).buffer);await generating;
  assert.equal(get('copyVerifier').disabled,false);
  let copied;context.navigator.clipboard.writeText=async value=>{copied=value;};await get('copyVerifier').onclick();
  assert.equal(copied,'01'.repeat(32));
});
