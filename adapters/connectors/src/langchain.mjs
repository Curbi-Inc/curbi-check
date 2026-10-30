// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// LangChain connector: a Runnable you pipe after any chat model or chain: model.pipe(curbiGuard({...})).
// A failing reply becomes an AIMessage carrying the approved fallback; findings are in response_metadata.curbi.
import { createRequire } from 'node:module';
import { RunnableLambda } from '@langchain/core/runnables';
import { AIMessage } from '@langchain/core/messages';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

export function curbiGuard({ policy, record, verify, fallback }) {
  // Pin caller-owned configuration before validation or asynchronous model work.
  policy = structuredClone(policy);
  record = record === undefined ? undefined : structuredClone(record);
  verify = verify === undefined ? undefined : structuredClone(verify);
  if (typeof fallback !== 'string' || !fallback) throw new Error('curbiGuard: an approved fallback line is required');
  if(!runCheck({policy,reply:fallback,...(record?{record}:{}),...(verify?{verify}:{})}).pass)throw new Error('fallback violates the configured policy');
  runCheck({ policy, reply: 'ok' });
  const ctx = { ...(record ? { record } : {}), ...(verify ? { verify } : {}) };
  return RunnableLambda.from(async input => {
    const isMsg = input && typeof input === 'object' && 'content' in input;
    const text = isMsg ? (typeof input.content === 'string' ? input.content : input.content.filter(p => p.type === 'text').map(p => p.text).join('')) : String(input);
    const r = runCheck({ policy, reply: text.trim() ? text : ' ', ...ctx });
    const curbi = { pass: r.pass, recordTrust: r.recordTrust, findings: r.findings.map(f => ({ rule: f.rule, text: f.text, why: f.why })) };
    if (!isMsg) return r.pass ? text : fallback;
    return new AIMessage({ content: r.pass ? input.content : fallback, response_metadata: { ...(input.response_metadata || {}), curbi }, id: input.id });
  }).withConfig({ runName: 'CurbiPolicyCheck' });
}

