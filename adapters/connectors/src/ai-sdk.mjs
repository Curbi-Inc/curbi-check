// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Vercel AI SDK connector: a LanguageModel middleware. Wrap any model and every reply is checked with
// Curbi's deterministic checker before your app sees it.
//   generate: a failing reply is replaced by the approved fallback; findings ride along in providerMetadata.curbi.
//   stream:   text goes through the Curbi stream interceptor, so only checked sentences reach the client,
//             and a violation is cut before it is streamed out.
// Local and synchronous: no network, no model calls, nothing stored.
import { createRequire } from 'node:module';
import { createStreamChecker } from '../../stream-check/src/stream.mjs';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

export function curbiMiddleware({ policy, record, verify, fallback }) {
  // Pin caller-owned configuration before validation or asynchronous model work.
  policy = structuredClone(policy);
  record = record === undefined ? undefined : structuredClone(record);
  verify = verify === undefined ? undefined : structuredClone(verify);
  if (typeof fallback !== 'string' || !fallback) throw new Error('curbiMiddleware: an approved fallback line is required');
  if(!runCheck({policy,reply:fallback,...(record?{record}:{}),...(verify?{verify}:{})}).pass)throw new Error('fallback violates the configured policy');
  runCheck({ policy, reply: 'ok' });                                         // fail fast on an invalid policy
  const ctx = { ...(record ? { record } : {}), ...(verify ? { verify } : {}) };
  return {
    specificationVersion: 'v4',
    async wrapGenerate({ doGenerate }) {
      const res = await doGenerate();
      const text = res.content.filter(p => p.type === 'text').map(p => p.text).join('');
      if (!text.trim()) return res;
      const r = runCheck({ policy, reply: text, ...ctx });
      const meta = { ...(res.providerMetadata || {}), curbi: { pass: r.pass, recordTrust: r.recordTrust, findings: r.findings.map(f => ({ rule: f.rule, text: f.text, why: f.why })) } };
      if (r.pass) return { ...res, providerMetadata: meta };
      const content = [...res.content.filter(p => p.type !== 'text'), { type: 'text', text: fallback }];
      return { ...res, content, providerMetadata: meta };
    },
    async wrapStream({ doStream }) {
      const { stream, ...rest } = await doStream();
      const checker = createStreamChecker({ policy, fallback, ...ctx });
      let cut = null, textId = null;
      const out = (controller, id, delta) => { if (delta) controller.enqueue({ type: 'text-delta', id, delta }); };
      const transform = new TransformStream({
        transform(part, controller) {
          if (part.type === 'text-start') { textId = part.id; return controller.enqueue(part); }
          if (part.type === 'text-delta') {
            if (cut) return;                                                   // nothing after a cut is streamed
            const r = checker.push(part.delta);
            for (const s of r.release) out(controller, part.id, s);
            if (r.cut) { cut = r.cut; out(controller, part.id, (checker.spoken ? ' ' : '') + cut.fallback); }
            return;
          }
          if (part.type === 'text-end' && !cut) {
            const r = checker.end();
            for (const s of r.release) out(controller, part.id, s);
            if (r.cut) { cut = r.cut; out(controller, part.id, (checker.spoken ? ' ' : '') + cut.fallback); }
          }
          if (part.type === 'finish') {
            controller.enqueue({ ...part, providerMetadata: { ...(part.providerMetadata || {}), curbi: { pass: !cut, finding: cut ? { rule: cut.finding.rule, text: cut.finding.text, why: cut.finding.why } : null } } });
            return;
          }
          controller.enqueue(part);
        },
      });
      return { stream: stream.pipeThrough(transform), ...rest };
    },
  };
}

