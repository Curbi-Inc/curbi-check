import {test} from 'node:test';
import assert from 'node:assert/strict';
import {wrapLanguageModel,generateText} from 'ai';
import {MockLanguageModelV4} from 'ai/test';
import {curbiMiddleware,checkReply,CurbiCheckError} from '../src/index.mjs';
const policy={prices:[{item:'Pro',amount:49}]};
const result=(findings=[])=>({object:'check',version:'2026-11-01',recordTrust:'caller_supplied_unverified',pass:findings.length===0,findings,proof:{authorizationGranted:false}});
const finding={rule:'price:mismatch',span:[7,10],text:'$99',why:'Pro is $49.'};
const response=text=>({content:[{type:'text',text}],finishReason:{unified:'stop',raw:'stop'},usage:{inputTokens:{total:1,noCache:1,cacheRead:0,cacheWrite:0},outputTokens:{total:1,text:1,reasoning:0}},warnings:[]});
const transport=data=>async()=>Response.json(data);
test('real AI SDK wrapLanguageModel+generateText releases checked text and metadata',async()=>{
 let calls=0;const model=wrapLanguageModel({model:new MockLanguageModelV4({doGenerate:response('Pro is $49.')}),middleware:curbiMiddleware({policy,fetch:async(url,init)=>{calls++;assert.equal(url,'https://api.curbi.io/v1/check');assert.equal(init.redirect,'error');assert.equal(JSON.parse(init.body).reply,'Pro is $49.');return Response.json(result());}})});
 const out=await generateText({model,prompt:'price?',maxRetries:0});assert.equal(out.text,'Pro is $49.');assert.equal(out.providerMetadata.curbi.pass,true);assert.equal(calls,1);
});
test('real wrapped model refuses a finding with original spans',async()=>{
 const model=wrapLanguageModel({model:new MockLanguageModelV4({doGenerate:response('Pro is $99.')}),middleware:curbiMiddleware({policy,fetch:transport(result([finding]))})});
 await assert.rejects(generateText({model,prompt:'price?',maxRetries:0}),e=>e instanceof CurbiCheckError&&e.code==='findings'&&e.findings[0].text==='$99');
});
test('real AI SDK binary file parts survive the content snapshot',async()=>{
 const generated=response('Pro is $49.');generated.content.push({type:'file',mediaType:'image/png',data:{type:'data',data:new Uint8Array([1,2,3])}});
 const model=wrapLanguageModel({model:new MockLanguageModelV4({doGenerate:generated}),middleware:curbiMiddleware({policy,fetch:transport(result())})});
 const out=await generateText({model,prompt:'price?',maxRetries:0});assert.equal(out.text,'Pro is $49.');assert.deepEqual([...out.files[0].uint8Array],[1,2,3]);
});
test('streaming is refused before provider invocation',async()=>{let called=false;const base=new MockLanguageModelV4({doStream:async()=>{called=true;throw Error('not reached');}});const model=wrapLanguageModel({model:base,middleware:curbiMiddleware({policy})});await assert.rejects(model.doStream({prompt:[]}),/streaming_unsupported/);assert.equal(called,false);});
test('policy and model content are pinned across network awaits',async()=>{
 const p=structuredClone(policy),original=response('Pro is $49.');let finish;const gate=new Promise(r=>finish=r);
 const middleware=curbiMiddleware({policy:p,fetch:async(_u,i)=>{assert.equal(JSON.parse(i.body).policy.prices[0].amount,49);await gate;return Response.json(result());}});p.prices[0].amount=99;
 const pending=middleware.wrapGenerate({doGenerate:async()=>original});await new Promise(r=>setImmediate(r));original.content[0].text='Pro is $99.';original.structuredOutputText='Pro is $99.';finish();const released=await pending;assert.equal(released.content[0].text,'Pro is $49.');assert.equal(released.structuredOutputText,undefined);
});
test('optional key is only an auth header; errors never reflect transport secrets',async()=>{let n=0;await assert.rejects(checkReply('Pro is $49.',{policy,apiKey:'private_test_key',fetch:async(u,i)=>{n++;assert.equal(i.headers.Authorization,'Bearer private_test_key');assert.ok(!u.includes('private_test_key'));throw Error('private_test_key');}}),e=>e.code==='transport'&&!e.message.includes('private_test_key'));assert.equal(n,1);});
for(const status of [301,401,429,500])test('HTTP '+status+' is no verdict',async()=>{await assert.rejects(checkReply('x',{policy,fetch:async()=>new Response('{}',{status})}),e=>e.code==='http_'+status);});
for(const mutate of [r=>r.pass=false,r=>delete r.proof,r=>r.proof.authorizationGranted=true,r=>r.findings=[{...finding,span:[99,100]}],r=>r.version='future',r=>r.findings=[{...finding,text:'wrong'}]])test('malformed verdict fails closed',async()=>{const r=result();mutate(r);await assert.rejects(checkReply('Pro is $49.',{policy,fetch:transport(r)}),CurbiCheckError);});
test('invalid JSON/content type and oversized response fail closed',async()=>{
 for(const make of [()=>new Response('bad',{headers:{'Content-Type':'application/json'}}),()=>new Response('{}'),()=>new Response('{}',{headers:{'Content-Type':'application/json','Content-Length':'1048577'}})])await assert.rejects(checkReply('x',{policy,fetch:async()=>make()}),CurbiCheckError);
});
test('timeout bounds both fetch and body without retries',async()=>{
 await assert.rejects(checkReply('x',{policy,timeoutMs:10,fetch:()=>new Promise(()=>{})}),e=>e.code==='timeout');
 let cancelled=false;await assert.rejects(checkReply('x',{policy,timeoutMs:10,fetch:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json'}})}),e=>e.code==='timeout');assert.equal(cancelled,true);
});
test('empty policy, oversized reply and alternate structured output are refused',async()=>{
 assert.throws(()=>curbiMiddleware({policy:{}}),e=>e.code==='no_rules');
 await assert.rejects(checkReply('x'.repeat(4001),{policy}),e=>e.code==='invalid_input');
 const m=curbiMiddleware({policy,fetch:transport(result())});await assert.rejects(m.wrapGenerate({doGenerate:async()=>({...response('Pro is $49.'),structuredOutputText:'Pro is $99.'})}),e=>e.code==='structured_output_unsupported');
});
