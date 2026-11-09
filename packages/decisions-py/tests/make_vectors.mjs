// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Generates parity vectors from the JavaScript adapter: valid fixtures for every vendor shape, deterministic mutations
// of each (deleted fields, wrong types, perturbed probabilities, bad declarations), policy-validation cases, and
// routes, receipts and action checks over the records. The Python port must reproduce every vector exactly.
// Run: node packages/decisions-py/tests/make_vectors.mjs > packages/decisions-py/tests/vectors.json
import * as D from '../../../adapters/decisions/src/decisions.mjs';

const at = '2026-11-07T04:00:00.000Z', now = Date.parse(at);
const out = [];
const attempt = f => { try { return { ok: true, value: f() }; } catch (e) { return { ok: false, error: e.message }; } };
const clone = v => structuredClone(v);
const VALUES = [null, true, false, 'x', '', 0, 1, 1.5, -1, 0.5, [], {}];

const crit3 = { eligible: 'policy allows', ineligible: 'policy forbids', unclear: 'not enough info' };
const rubric = ['none', 'some', 'full'];
const BASES = [
  ['systemone', 'fastino', { model: 'fastino/GLiDE', state: {}, questions: { q: { type: 'choice', instructions: 'i', criteria: crit3 } } },
    { model: 'glide', answers: { q: { type: 'choice', choice: 'eligible', confidence: 0.9, probabilities: { eligible: 0.96, ineligible: 0.03, unclear: 0.01 } } } }],
  ['systemone', 'typesafe', { model: 'jev-1.13.0', questions: { q: { type: 'choice', criteria: crit3 } } },
    { answers: { q: { type: 'choice', choice: 'ineligible', confidence: 0.7, probabilities: { eligible: 0.1, ineligible: 0.85, unclear: 0.05 } } } }],
  ['systemone', 'typesafe', { model: 'jev-1.13.0', questions: { q: { type: 'noul' } } }, { answers: { q: { type: 'noul', noul: 0.97 } } }],
  ['systemone', 'fastino', { model: 'fastino/GLiDE', questions: { q: { type: 'noul' } } }, { answers: { q: { type: 'noul', noul: 0.2, confidence: 0.6 } } }],
  ['systemone', 'fastino', { model: 'fastino/GLiDE', questions: { q: { type: 'score', criteria: rubric } } },
    { answers: { q: { type: 'score', score: 2, expected_level: 1.9, confidence: 0.9, probabilities: { 0: 0.02, 1: 0.06, 2: 0.92 }, legend: { 0: 'none', 1: 'some', 2: 'full' } } } }],
  ['systemone', 'fastino', { model: 'fastino/GLiDE', questions: { q: { type: 'score', criteria: { 1: 'some', 0: 'none', 2: 'full' } } } },
    { answers: { q: { type: 'score', score: 1, expected_level: 1.0, confidence: 0.8, probabilities: { 0: 0.05, 1: 0.9, 2: 0.05 }, legend: { 0: 'none', 1: 'some', 2: 'full' } } } }],
  ['systemone', 'typesafe', { model: 'jev-1.13.0', questions: { q: { type: 'score', criteria: rubric } } },
    { answers: { q: { type: 'score', score: 1.43, confidence: 0.5, probabilities: { 0: 0.1, 1: 0.37, 2: 0.53 }, legend: { 0: 'none', 1: 'some', 2: 'full' } } } }],
  ['systemone', 'fastino', { model: 'fastino/GLiDE', questions: { a: { type: 'noul' }, b: { type: 'choice', criteria: { yes: 'y', no: 'n' } } } },
    { answers: { b: { type: 'refusal' }, a: { type: 'noul', noul: 0.99, confidence: 0.99 } } }],
  ['decisions', 'openai', { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'predicate', name: 'q' }] }, { answers: [{ type: 'predicate', name: 'q', probability: 0.95, confidence: 0.9 }] }],
  ['decisions', 'openai', { model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'q', choices: [{ value: 'eligible' }, { value: 'ineligible', description: 'd' }, { value: 'unclear' }] }] },
    { answers: [{ type: 'choice', name: 'q', choice: 'eligible', confidence: 0.9, probabilities: [{ value: 'eligible', probability: 0.94 }, { value: 'ineligible', probability: 0.05 }, { value: 'unclear', probability: 0.01 }] }] }],
  ['decisions', 'openai', { model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'q', choices: [{ value: true }, { value: false }] }] },
    { answers: [{ type: 'choice', name: 'q', choice: true, confidence: 0.8, probabilities: [{ value: true, probability: 0.9 }, { value: false, probability: 0.1 }] }] }],
  ['decisions', 'openai', { model: 'gpt-6-luna', questions: [{ type: 'score', name: 'q', levels: [{ label: 'none' }, { label: 'some' }, { label: 'full' }] }] },
    { answers: [{ type: 'score', name: 'q', score: 1.9, confidence: 0.9, probabilities: [{ value: 0, label: 'none', probability: 0.02 }, { value: 1, label: 'some', probability: 0.06 }, { value: 2, label: 'full', probability: 0.92 }] }] }],
  ['decisions', 'openai', { model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'q', choices: [{ value: 'a' }, { value: 'b' }] }] }, { answers: [{ type: 'choice', name: 'q', choice: 'a', confidence: 0.99 }] }],
  ['decisions', 'openai', { model: 'gpt-6-luna', questions: [{ type: 'predicate' }, { type: 'choice', name: 'c', choices: [{ value: 'a' }, { value: 'b' }] }] },
    { answers: [{ type: 'predicate', probability: 0.3 }, { type: 'refusal', name: 'c' }] }],
];

// Deterministic mutations of an answer object, a question declaration, and the envelope.
function* mutate(shape, req, res) {
  yield ['base', req, res];
  const answers = shape === 'systemone' ? Object.entries(res.answers) : res.answers.map((a, i) => [i, a]);
  for (const [ak, a] of answers) {
    for (const f of Object.keys(a)) {
      const r = clone(res); delete r.answers[ak][f]; yield [`del ${ak}.${f}`, req, r];
      for (const [i, v] of VALUES.entries()) { const r2 = clone(res); r2.answers[ak][f] = v; yield [`set ${ak}.${f}=${i}`, req, r2]; }
    }
    if (a.probabilities) {
      const r = clone(res), p = r.answers[ak].probabilities;
      if (Array.isArray(p)) { p.reverse(); yield [`reverse ${ak}.p`, req, r];
        const r2 = clone(res); r2.answers[ak].probabilities.push(clone(r2.answers[ak].probabilities[0])); yield [`dup ${ak}.p`, req, r2];
        const r3 = clone(res); r3.answers[ak].probabilities[0].probability = 0.5; yield [`skew ${ak}.p`, req, r3];
        const r4 = clone(res); r4.answers[ak].probabilities[0].value = 'true'; yield [`strval ${ak}.p`, req, r4];
      } else { const ks = Object.keys(p); [p[ks[0]], p[ks[1]]] = [p[ks[1]], p[ks[0]]]; yield [`swap ${ak}.p`, req, r];
        const r2 = clone(res); r2.answers[ak].probabilities.extra = 0; yield [`extra ${ak}.p`, req, r2];
        const r3 = clone(res); delete r3.answers[ak].probabilities[ks[0]]; yield [`drop ${ak}.p`, req, r3];
        const r4 = clone(res); r4.answers[ak].probabilities[ks[0]] = 0.6; yield [`skew ${ak}.p`, req, r4];
      }
    }
    if (a.legend) { const r = clone(res); r.answers[ak].legend = ['none', 'some', 'full']; yield [`legend-array ${ak}`, req, r];
      const r2 = clone(res); r2.answers[ak].legend = { 0: 'full', 1: 'some', 2: 'none' }; yield [`legend-reversed ${ak}`, req, r2]; }
  }
  const qs = shape === 'systemone' ? Object.entries(req.questions) : req.questions.map((q, i) => [i, q]);
  for (const [qk, q] of qs) {
    for (const f of Object.keys(q)) { const r = clone(req); delete r.questions[qk][f]; yield [`qdel ${qk}.${f}`, r, res];
      for (const [i, v] of [null, 'x', 1, [], {}].entries()) { const r2 = clone(req); r2.questions[qk][f] = v; yield [`qset ${qk}.${f}=${i}`, r2, res]; } }
    for (const list of ['choices', 'levels']) if (q[list]) {
      const r = clone(req); r.questions[qk][list].push(clone(r.questions[qk][list][0])); yield [`qdup ${qk}.${list}`, r, res];
      const r2 = clone(req); r2.questions[qk][list][0].label = 'shadow'; r2.questions[qk][list][0].name = 'n'; yield [`qshadow ${qk}.${list}`, r2, res];
      const r3 = clone(req); r3.questions[qk][list] = r3.questions[qk][list].map(o => Object.values(o)[0]); yield [`qbare ${qk}.${list}`, r3, res];
    }
  }
  const r = clone(res); r.model = 5; yield ['model-echo-num', req, r];
  const rq = clone(req); rq.model = 7; yield ['model-num', rq, res];
  yield ['no-answers', req, { answers: shape === 'systemone' ? {} : [] }];
}

const recordsByBase = [];
BASES.forEach(([shape, provider, req, res], bi) => {
  const fn = shape === 'systemone' ? D.normalizeSystemone : D.normalizeDecisions;
  for (const [name, rq, rs] of mutate(shape, req, res)) {
    const r = attempt(() => fn({ provider, request: rq, response: rs, receivedAt: at }));
    out.push({ kind: 'normalize', name: `${bi}:${name}`, shape, args: { provider, request: rq, response: rs, received_at: at }, ...(r.ok ? { ok: true, records: r.value } : { ok: false, error: r.error }) });
    if (name === 'base') recordsByBase.push(r.value);
  }
  // Raw bytes, when given, are what get digested.
  const bytes = new TextEncoder().encode(JSON.stringify(req));
  const rb = attempt(() => fn({ provider, request: req, response: res, receivedAt: at, requestBytes: bytes }));
  out.push({ kind: 'normalize', name: `${bi}:bytes`, shape, args: { provider, request: req, response: res, received_at: at, request_bytes_utf8: JSON.stringify(req) }, ...(rb.ok ? { ok: true, records: rb.value } : { ok: false, error: rb.error }) });
});
// Raw-byte binding: bytes are authoritative and strictly parsed. Bytes travel as base64 so invalid UTF-8 survives.
const b64 = u8 => Buffer.from(u8).toString('base64');
const RAW = (shape, json) => {
  const good = JSON.stringify(json), first = shape === 'systemone' ? '"answers":{' : '"answers":[';
  return [
    ['raw-only', enc(good), false], ['raw-pretty', enc(JSON.stringify(json, null, 2)), true],
    ['raw-mismatch', enc(good.replace('0.9', '0.91')), true], ['raw-dup-top', enc(good.replace(first, `"answers":${shape === 'systemone' ? '{}' : '[]'},${first}`)), false],
    ['raw-dup-escaped', enc(good.replace('{"', '{"\\u006dodel":"x","model":"y","')), false],
    ['raw-bom', enc('\ufeff' + good), false], ['raw-bad-utf8', Uint8Array.from([...enc(good.slice(0, -1)), 0xc3, 0x28, 0x7d]), false],
    ['raw-lone-surrogate', enc(good.replace('{', '{"zz":"\\udc00",')), false], ['raw-not-json', enc(good.slice(0, -1)), false],
    ['raw-nan', enc(good.replace('0.9', 'NaN')), false], ['raw-bigint', enc(good.replace('0.9', '12345678901234567890')), false],
    ['raw-huge', enc(good.replace('0.9', '1e400')), false], ['raw-tricky-string', enc(good.replace('{', '{"note":"a\\"}{\\"answers\\":[]\\\\",')), false],
  ];
};
const enc = s => new TextEncoder().encode(s);
BASES.forEach(([shape, provider, req, res], bi) => {
  const fn = shape === 'systemone' ? D.normalizeSystemone : D.normalizeDecisions;
  for (const [name, bytes, withObj] of RAW(shape, res)) {
    const args = { provider, request: req, ...(withObj ? { response: res } : {}), received_at: at, response_bytes_b64: b64(bytes) };
    const r = attempt(() => fn({ provider, request: req, ...(withObj ? { response: res } : {}), receivedAt: at, responseBytes: bytes }));
    out.push({ kind: 'normalize', name: `${bi}:${name}`, shape, args, ...(r.ok ? { ok: true, records: r.value } : { ok: false, error: r.error }) });
  }
  const rqBytes = enc(JSON.stringify(req)), r = attempt(() => fn({ provider, requestBytes: rqBytes, response: res, receivedAt: at }));
  out.push({ kind: 'normalize', name: `${bi}:raw-request-only`, shape, args: { provider, response: res, received_at: at, request_bytes_b64: b64(rqBytes) }, ...(r.ok ? { ok: true, records: r.value } : { ok: false, error: r.error }) });
});
for (const pv of ['fastino', 'typesafe', 'azure-openai']) { const [, , req, res] = BASES[9]; const r = attempt(() => D.normalizeDecisions({ provider: pv, request: req, response: res, receivedAt: at }));
  out.push({ kind: 'normalize', name: `decisions-provider-${pv}`, shape: 'decisions', args: { provider: pv, request: req, response: res, received_at: at }, ...(r.ok ? { ok: true, records: r.value } : { ok: false, error: r.error }) }); }
out.push({ kind: 'normalize', name: 'unknown-provider', shape: 'systemone', args: { provider: 'acme', request: BASES[0][2], response: BASES[0][3] }, ...(() => { const r = attempt(() => D.normalizeSystemone({ provider: 'acme', request: BASES[0][2], response: BASES[0][3] })); return r.ok ? { ok: true, records: r.value } : { ok: false, error: r.error }; })() });

// Policies.
const calibration = { dataset: 'd', accuracy_at_threshold: 0.97, measured_at: '2026-10-30T00:00:00Z' };
const POLICIES = {
  single: { decisions: { q: { allowed: ['eligible', 'ineligible', 'unclear', 'true', 'false', '0', '1', '2', 'a', 'b', 'yes', 'no'], act_at: 0.9, min_margin: 0.5, calibration, operations: { eligible: 'billing.refund', true: 'billing.refund', 2: 'billing.refund' } } } },
  pinned: { decisions: { q: { allowed: ['eligible', 'true', '2', 'a'], act_at: 0.8, pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }, { provider: 'openai', model: 'gpt-6-luna' }], below: 'deny' } } },
  stale: { decisions: { q: { allowed: ['eligible', 'true', '2'], act_at: 0.8, calibration: { ...calibration, measured_at: '2026-01-01' }, operations: { eligible: 'billing.refund' } } } },
  missing: { decisions: { q: { allowed: ['eligible', 'true'], act_at: 0.8, operations: { eligible: 'billing.refund' }, max_calibration_age_days: 5 } } },
  all: { decisions: { q: { allowed: ['eligible', 'ineligible', 'true', 'false', '2'], act_at: 0.5, consensus: { models: ['fastino/GLiDE', 'jev-1.13.0', 'gpt-6-luna'], require: 'all', max_divergence: 0.05 }, below: 'escalate' } } },
  two: { decisions: { q: { allowed: ['eligible', 'ineligible', 'true', 'false', '2'], act_at: 0.5, consensus: { models: ['fastino/GLiDE', 'jev-1.13.0', 'gpt-6-luna'], require: 2, max_divergence: 0.5 } } } },
};
const compiled = Object.fromEntries(Object.entries(POLICIES).map(([k, p]) => [k, D.compileDecisionPolicy(p)]));
for (const [k, p] of Object.entries(POLICIES)) out.push({ kind: 'policy', name: k, policy: p, ok: true, compiled: compiled[k] });
// Policy validation mutations.
const qbase = POLICIES.single.decisions.q;
for (const f of ['allowed', 'act_at', 'min_margin', 'below', 'pin', 'consensus', 'calibration', 'require_calibration', 'max_calibration_age_days', 'operations', 'bogus'])
  [null, true, 'x', 0, 1, 2, -1, [], {}, ['a'], 'all', { models: ['m'], require: 1, max_divergence: 0.1 }, [{ provider: 'p', model: 'm' }]].forEach((v, i) => {
    const p = { decisions: { q: { ...clone(qbase), [f]: v } } }, r = attempt(() => D.compileDecisionPolicy(p));
    out.push({ kind: 'policy', name: `${f}=${i}`, policy: p, ...(r.ok ? { ok: true, compiled: r.value } : { ok: false, error: r.error }) });
  });

// Routes, receipts and actions: every valid base record set, alone and pooled for consensus, under every policy.
const pools = [...recordsByBase.filter(Boolean), recordsByBase.filter(Boolean).flat(), [recordsByBase[0], recordsByBase[2], recordsByBase[8]].filter(Boolean).flat(), [recordsByBase[0], recordsByBase[0]].flat(), []];
for (const [pk, pol] of Object.entries(compiled)) pools.forEach((records, ri) => {
  for (const t of [now, NaN, now + 400 * 86400000]) {
    const r = attempt(() => D.route(pol, 'q', records, { now: Number.isNaN(t) ? undefined : t }));
    const v = { kind: 'route', name: `${pk}:${ri}:${t}`, policy: POLICIES[pk], records, now: Number.isNaN(t) ? null : t };
    if (!r.ok) { out.push({ ...v, ok: false, error: r.error }); continue; }
    const receipt = D.decisionReceipt({ policy: pol, questionId: 'q', records, result: r.value, prev: ri % 2 ? 'sha256:prev' : null });
    const actions = Object.fromEntries(['billing.refund', 'other.op'].map(op => [op, D.checkAction(pol, 'q', r.value, op)]));
    out.push({ ...v, ok: true, result: r.value, receipt, actions });
  }
});

process.stdout.write(JSON.stringify({ generator: 'packages/decisions-py/tests/make_vectors.mjs', adapter: D.CHECKER, vectors: out }) + '\n');
