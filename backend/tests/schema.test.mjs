import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validPayload } from '../src/schema.ts';
import { prepareBaseline } from '../scripts/prepare-baseline.mjs';
import { payload } from './fixtures.mjs';

test('preserves full bill history and validates without normalization', () => {
  const p = payload();
  p.history.push({month:'2029-12',rate:5,rooms:p.rooms.map(r=>({...r,curr:'110',total:50,amount:50,ok:true})),completedAt:'2030-01-01T00:00:00Z'});
  assert.equal(validPayload(p), true);
  assert.equal(validPayload({...p,rooms:p.rooms.slice(1)}), false);
  assert.equal(validPayload({...p,rooms:[p.rooms[0],...p.rooms.slice(0,5)]}), false);
  assert.equal(validPayload({...p,rate:NaN}), false);
  assert.equal(validPayload({...p,month:'2030-99'}), false);
  assert.equal(validPayload({...p,rooms:p.rooms.map(r=>({...r,prev:-1}))}), false);
});
test('offline seed preserves verified payload and provenance, never uses defaults', () => {
  const p = payload(); p.rooms[0].others.push({name:"Synthetic ' quote",amount:-5});
  const out = prepareBaseline(JSON.stringify({state:p}),{source:'synthetic-test',sourceRevision:7,now:'2030-01-01T00:00:00Z'});
  assert.match(out.sql,/INSERT INTO app_state/);
  assert.match(out.sql,/Synthetic '' quote/);
  assert.equal(out.receipt.sourceRevision,7);
  assert.equal(out.receipt.sha256.length,64);
  assert.throws(()=>prepareBaseline('{}',{source:'test'}),/incompatible/);
  assert.throws(()=>prepareBaseline(JSON.stringify(p),{source:''}),/source/);
});
test('decimal forms accepted by the existing UI remain valid in current and archived bills', () => {
  for(const curr of ['123.','.5','0.5','123.50']){
    const p=payload();p.rooms[0].curr=curr;
    p.history.push({month:'2029-12',rate:5,rooms:structuredClone(p.rooms)});
    assert.equal(validPayload(p),true,curr);
    assert.doesNotThrow(()=>prepareBaseline(JSON.stringify(p),{source:'synthetic-decimal'}));
  }
  const invalid=payload();invalid.rooms[0].curr='.';assert.equal(validPayload(invalid),false);
});
