// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Curbi public preview: checks supplied text, not model/provider traffic or execution authority.
const DEFAULT_URL='https://curbi.io/api/v1/check';
const encoder=new TextEncoder();
const plain=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
const fail=message=>{throw new Error('Curbi: '+message+'; no unchecked reply was released');};
function input(reply,policy){
 if(typeof reply!=='string'||reply.length>4000||!plain(policy))fail('invalid check input');
 const body=JSON.stringify({policy,reply});if(encoder.encode(body).length>65536)fail('request exceeds 64 KiB');return body;
}
function endpoint(value){
 const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||u.hash||u.search)fail('HTTPS endpoint without credentials/query required');return u.href;
}
async function boundedJson(response,signal){
 const reader=response.body?.getReader();if(!reader)fail('missing response body');let bytes=0;const chunks=[];
 const abort=()=>{reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
 try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1048576){await reader.cancel();fail('response exceeds 1 MiB');}chunks.push(value);}}
 catch(error){throw error;}finally{signal.removeEventListener('abort',abort);reader.releaseLock();}
 const all=new Uint8Array(bytes);let at=0;for(const x of chunks){all.set(x,at);at+=x.length;}
 try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(all));}catch{fail('invalid JSON response');}
}
function verdict(result,reply){
 if(!plain(result)||result.object!=='check'||result.version!=='2026-11-01'||typeof result.pass!=='boolean'||!Array.isArray(result.findings)||result.findings.length>4000||result.proof?.authorizationGranted!==false||result.pass!==(result.findings.length===0))fail('invalid verdict');
 for(const finding of result.findings){
  const span=finding?.span;
  if(!plain(finding)||typeof finding.rule!=='string'||!finding.rule||finding.rule.length>200||typeof finding.text!=='string'||typeof finding.why!=='string'||finding.why.length>2000||!Array.isArray(span)||span.length!==2||!span.every(Number.isSafeInteger)||span[0]<0||span[1]<span[0]||span[1]>reply.length||reply.slice(span[0],span[1])!==finding.text)fail('invalid finding or original span');
 }
 return result;
}
export async function checkReply({reply,policy},{url=DEFAULT_URL,timeoutMs=15000,fetch:fetcher=globalThis.fetch}={}){
 if(typeof fetcher!=='function'||!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>60000)fail('invalid transport configuration');
 const body=input(reply,policy),target=endpoint(url),controller=new AbortController();let timer;
 const timeout=new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('Curbi: check timed out; no unchecked reply was released'));},timeoutMs);});
 try{return await Promise.race([(async()=>{
  const response=await fetcher(target,{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json','User-Agent':'curbi-ai-sdk-http/0.1.0-preview.1'},body});
  if(!response.ok)fail('HTTP '+response.status);
  if(!(response.headers.get('Content-Type')||'').toLowerCase().startsWith('application/json'))fail('non-JSON response');
  return verdict(await boundedJson(response,controller.signal),reply);
 })(),timeout]);}finally{clearTimeout(timer);controller.abort();}
}
export function curbiMiddleware({policy,fallback,...transport}){
 if(typeof fallback!=='string'||!fallback.trim())fail('approved fallback required');
 const captured=structuredClone(policy);input(fallback,captured); // caller mutation cannot silently widen this instance
 const check=reply=>checkReply({reply,policy:captured},transport);
 let fallbackCheck;
 return {
  specificationVersion:'v4',
  async wrapGenerate({doGenerate}){
   fallbackCheck??=check(fallback).then(result=>{if(!result.pass)fail('fallback violates configured policy');}).catch(error=>{fallbackCheck=undefined;throw error;});
   await fallbackCheck;
   const response=await doGenerate();
   if(!Array.isArray(response.content))fail('model response has no content array');
   const content=structuredClone(response.content); // audit and return the same snapshot across the network await
   if(content.some(p=>!plain(p)||typeof p.type!=='string'||(p.type==='text'&&typeof p.text!=='string')))fail('invalid model content');
   const text=content.filter(p=>p.type==='text').map(p=>p.text).join('');
   const result=await check(text);
   return {...response,content:result.pass?content:[...content.filter(p=>p.type!=='text'),{type:'text',text:fallback}],providerMetadata:{...response.providerMetadata,curbi:result}};
  },
  async wrapStream(){fail('HTTP middleware does not support streaming; use an independently reviewed stream adapter');},
 };
}
