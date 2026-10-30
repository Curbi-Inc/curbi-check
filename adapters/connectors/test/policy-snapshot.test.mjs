// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import test from 'node:test';import assert from 'node:assert/strict';
import {curbiMiddleware} from '../src/ai-sdk.mjs';import {curbiGuard} from '../src/langchain.mjs';
const fallback='A teammate will confirm the price.';
test('AI SDK caller mutation cannot widen the admitted policy',async()=>{
 const policy={prices:[{item:'Starter',amount:49}]};const m=curbiMiddleware({policy,fallback});policy.prices[0].amount=99;
 const r=await m.wrapGenerate({doGenerate:async()=>({content:[{type:'text',text:'Starter is $99.'}]})});assert.equal(r.content.find(p=>p.type==='text').text,fallback);assert.equal(r.providerMetadata.curbi.pass,false);
});
test('LangChain caller mutation cannot widen the admitted policy',async()=>{
 const policy={prices:[{item:'Starter',amount:49}]};const guard=curbiGuard({policy,fallback});policy.prices[0].amount=99;assert.equal(await guard.invoke('Starter is $99.'),fallback);
});

import {createStreamChecker} from '../../stream-check/src/stream.mjs';
test('voice/stream caller mutation cannot widen the admitted policy',()=>{const policy={prices:[{item:'Starter',amount:49}]};const c=createStreamChecker({policy,fallback});policy.prices[0].amount=99;const a=c.push('Starter is $99. '),b=c.end();assert.ok(a.cut||b.cut);});
