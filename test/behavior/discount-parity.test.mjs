import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {runCheck}=createRequire(import.meta.url)('../../checker/check-api.js');
test('production discount parity: prices alone reject discounts; explicit scoped approval allows them',()=>{
 const prices=[{item:'Pro',amount:99},{item:'Starter',amount:29}];
 const run=(policy,reply)=>runCheck({version:'2026-11-01',policy,reply});
 assert.ok(run({prices},'I can give you 40% off the Pro plan.').findings.some(x=>x.rule==='price:discount'));
 assert.equal(run({prices,discounts:[{percent:40,items:['Pro']}]},'I can give you 40% off the Pro plan.').pass,true);
 assert.ok(run({prices,discounts:[{percent:40,items:['Pro']}]},'I can give you 40% off the Starter plan.').findings.some(x=>x.rule==='price:discount'));
});
