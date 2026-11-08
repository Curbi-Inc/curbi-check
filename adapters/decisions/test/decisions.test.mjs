// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Decision-model adapter: typed answers are checked against policy with arithmetic and comparison only.
// Fixtures are synthetic. Their shapes follow vendor doc pages as summarized by search, not loaded docs;
// FIELDS.md lists every field name still to be confirmed from a primary source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { normalizeSystemone, normalizeDecisions, route, decisionReceipt, checkAction, compileDecisionPolicy } from '../src/decisions.mjs';

const at = '2026-11-07T04:00:00.000Z';
const now = Date.parse(at);
const calibration = { dataset: 'refund-labels-2026-10', accuracy_at_threshold: 0.97, measured_at: '2026-10-30T00:00:00Z' };
const policy = compileDecisionPolicy({ decisions: { refund_eligible: {
  allowed: ['eligible', 'ineligible', 'unclear'], act_at: 0.92, min_margin: 0.5,
  pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }, { provider: 'typesafe', model: 'jev-1.13.0' }, { provider: 'openai', model: 'gpt-6-luna' }],
  below: 'hand_off', calibration, max_calibration_age_days: 30, operations: { eligible: 'billing.refund' } } } });

const sysReq = (type = 'choice') => ({ model: 'fastino/GLiDE', state: { ticket: 'Order arrived broken' },
  questions: { refund_eligible: { type, instructions: 'Is a refund allowed?', ...(type === 'noul' ? {} : { criteria: { eligible: 'policy allows', ineligible: 'policy forbids', unclear: 'not enough info' } }) } } });
const glide = (probabilities, extra = {}) => ({ model: 'glide', answers: { refund_eligible: { type: 'choice',
  choice: Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0], confidence: 0.9, probabilities, ...extra } } });
const one = (req, res, provider = 'fastino') => normalizeSystemone({ provider, request: req, response: res, receivedAt: at });

test('systemone choice: a confident, pinned, calibrated answer acts, and the receipt binds both digests', () => {
  const records = one(sysReq(), glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }));
  assert.equal(records.length, 1);
  const r = records[0];
  assert.deepEqual([r.object, r.shape, r.type, r.selected, r.model], ['curbi.decision.v1', 'systemone', 'choice', 'eligible', 'fastino/GLiDE']);
  assert.match(r.request_digest, /^sha256:[0-9a-f]{64}$/);
  const out = route(policy, 'refund_eligible', records, { now });
  assert.deepEqual([out.outcome, out.selected, out.reasons], ['act', 'eligible', []]);
  const receipt = decisionReceipt({ policy, questionId: 'refund_eligible', records, result: out, prev: null });
  assert.deepEqual([receipt.object, receipt.signed, receipt.provider_signed, receipt.prev_receipt_digest], ['curbi.decision-receipt.v1', false, false, null]);
  assert.deepEqual(receipt.record_digests.length, 1);
  assert.deepEqual(checkAction(policy, 'refund_eligible', out, 'billing.refund'), []);
});

test('malformed probabilities are inconsistent, never act', () => {
  for (const p of [{ eligible: 1.2, ineligible: -0.2, unclear: 0 }, { eligible: 0.7, ineligible: 0.1, unclear: 0.1 }, { eligible: 'high', ineligible: 0, unclear: 0 }]) {
    const out = route(policy, 'refund_eligible', one(sysReq(), glide(p)), { now });
    assert.equal(out.outcome, 'hand_off'); assert.ok(out.reasons.includes('inconsistent'), JSON.stringify(out));
  }
  assert.throws(() => one(sysReq(), { answers: {} }), /malformed/);
});

test('a selected option that is not the top-probability option, or outside allowed, is inconsistent', () => {
  const lied = glide({ eligible: 0.05, ineligible: 0.94, unclear: 0.01 }, { choice: 'eligible' });
  assert.ok(route(policy, 'refund_eligible', one(sysReq(), lied), { now }).reasons.includes('inconsistent'));
  const outside = glide({ eligible: 0.01, ineligible: 0.01, unclear: 0.01, approve_all: 0.97 });
  assert.ok(route(policy, 'refund_eligible', one(sysReq(), outside), { now }).reasons.includes('inconsistent'));
});

test('below threshold or margin goes to the policy’s below rule: hand_off by default, deny when set', () => {
  const low = one(sysReq(), glide({ eligible: 0.80, ineligible: 0.15, unclear: 0.05 }));
  assert.deepEqual(route(policy, 'refund_eligible', low, { now }), { outcome: 'hand_off', selected: 'eligible', reasons: ['below_threshold'] });
  const close = one(sysReq(), glide({ eligible: 0.93, ineligible: 0.07, unclear: 0 }));
  assert.equal(route(compileDecisionPolicy({ decisions: { refund_eligible: { ...policy.decisions.refund_eligible, act_at: 0.9, min_margin: 0.9 } } }), 'refund_eligible', close, { now }).reasons[0], 'below_margin');
  const deny = compileDecisionPolicy({ decisions: { refund_eligible: { ...policy.decisions.refund_eligible, below: 'deny' } } });
  assert.equal(route(deny, 'refund_eligible', low, { now }).outcome, 'deny');
});

test('an unpinned model or version is refused even when confident', () => {
  const req = { ...sysReq(), model: 'fastino/GLiDE-2' };
  const out = route(policy, 'refund_eligible', one(req, glide({ eligible: 0.99, ineligible: 0.01, unclear: 0 })), { now });
  assert.equal(out.outcome, 'hand_off'); assert.ok(out.reasons.includes('unpinned_model'));
});

test('a stale or missing calibration blocks act when the threshold gates an action', () => {
  const confident = one(sysReq(), glide({ eligible: 0.99, ineligible: 0.01, unclear: 0 }));
  const stale = compileDecisionPolicy({ decisions: { refund_eligible: { ...policy.decisions.refund_eligible, calibration: { ...calibration, measured_at: '2026-08-01T00:00:00Z' } } } });
  assert.ok(route(stale, 'refund_eligible', confident, { now }).reasons.includes('calibration_stale'));
  const { calibration: _, ...rest } = policy.decisions.refund_eligible;
  assert.ok(route(compileDecisionPolicy({ decisions: { refund_eligible: rest } }), 'refund_eligible', confident, { now }).reasons.includes('calibration_missing'));
});

test('systemone noul: one probability becomes a two-option record; Jev gives no confidence so it is computed', () => {
  const p = compileDecisionPolicy({ decisions: { refund_eligible: { allowed: ['true', 'false'], act_at: 0.9, min_margin: 0.8, pin: [{ provider: 'typesafe', model: 'jev-1.13.0' }], calibration, max_calibration_age_days: 30, operations: { true: 'billing.refund' } } } });
  const req = { ...sysReq('noul'), model: 'jev-1.13.0' };
  const recs = one(req, { answers: { refund_eligible: { type: 'noul', noul: 0.97 } } }, 'typesafe');
  assert.deepEqual([recs[0].selected, recs[0].probabilities, Math.round(recs[0].confidence * 100)], ['true', { true: 0.97, false: 0.030000000000000027 }, 94]);
  assert.equal(route(p, 'refund_eligible', recs, { now }).outcome, 'act');
  assert.throws(() => one(req, { answers: { refund_eligible: { type: 'noul', noul: true } } }, 'typesafe'), /malformed/, 'not a boolean');
});

test('systemone score: the integer level is selected; expected_level is kept but never selects', () => {
  const req = { model: 'fastino/GLiDE', state: 's', questions: { severity: { type: 'score', instructions: 'How bad?', criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } };
  const [r] = one(req, { answers: { severity: { type: 'score', score: 2, expected_level: 1.9, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.06, '2': 0.92 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } });
  assert.deepEqual([r.type, r.selected, r.expected_level], ['score', '2', 1.9]);
});

const oaReq = { model: 'gpt-6-luna', input: 'Order arrived broken', questions: [{ type: 'choice', name: 'refund_eligible', instructions: 'Is a refund allowed?', choices: [{ value: 'eligible' }, { value: 'ineligible' }, { value: 'unclear' }] }] };
test('decisions shape: a choice with per-option probabilities acts; without them the margin is unavailable and it hands off', () => {
  const withP = normalizeDecisions({ provider: 'openai', request: oaReq, response: { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', confidence: 0.95, probabilities: [{ value: 'eligible', probability: 0.97 }, { value: 'ineligible', probability: 0.02 }, { value: 'unclear', probability: 0.01 }] }] }, receivedAt: at });
  assert.equal(route(policy, 'refund_eligible', withP, { now }).outcome, 'act');
  const noP = normalizeDecisions({ provider: 'openai', request: oaReq, response: { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', confidence: 0.95 }] }, receivedAt: at });
  assert.deepEqual(route(policy, 'refund_eligible', noP, { now }).reasons, ['margin_unavailable']);
});

test('decisions shape: a refusal never acts, and a predicate maps to true/false', () => {
  const refused = normalizeDecisions({ provider: 'openai', request: oaReq, response: { model: 'gpt-6-luna', answers: [{ type: 'refusal', name: 'refund_eligible' }] }, receivedAt: at });
  assert.deepEqual(route(policy, 'refund_eligible', refused, { now }).reasons, ['refused']);
  const pred = normalizeDecisions({ provider: 'openai', request: { ...oaReq, questions: [{ type: 'predicate', name: 'q', instructions: 'x' }] }, response: { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'q', probability: 0.2 }] }, receivedAt: at });
  assert.deepEqual([pred[0].type, pred[0].selected, pred[0].probabilities.false], ['predicate', 'false', 0.8]);
});

const consensusPolicy = compileDecisionPolicy({ decisions: { refund_eligible: { ...policy.decisions.refund_eligible,
  below: 'escalate', consensus: { models: ['fastino/GLiDE', 'jev-1.13.0'], require: 'all', max_divergence: 0.05 } } } });
const jevAnswer = p => { const g = glide(p); return one({ ...sysReq(), model: 'jev-1.13.0' }, { ...g, answers: { refund_eligible: { type: 'choice', ...g.answers.refund_eligible } } }, 'typesafe'); };
test('consensus: agreement acts; disagreement or divergence hands off; a missing model escalates to it', () => {
  const g = one(sysReq(), glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }));
  assert.deepEqual(route(consensusPolicy, 'refund_eligible', g, { now }), { outcome: 'escalate', selected: 'eligible', reasons: ['consensus_incomplete'], next_model: 'jev-1.13.0' });
  assert.equal(route(consensusPolicy, 'refund_eligible', [...g, ...jevAnswer({ eligible: 0.95, ineligible: 0.04, unclear: 0.01 })], { now }).outcome, 'act');
  const split = route(consensusPolicy, 'refund_eligible', [...g, ...jevAnswer({ eligible: 0.02, ineligible: 0.97, unclear: 0.01 })], { now });
  assert.deepEqual([split.outcome, split.reasons], ['hand_off', ['consensus_disagreement']]);
  const drift = route(consensusPolicy, 'refund_eligible', [...g, ...jevAnswer({ eligible: 0.80, ineligible: 0.15, unclear: 0.05 })], { now });
  assert.ok(drift.reasons.includes('consensus_divergence'));
});

test('an action that contradicts the checked decision is a finding', () => {
  const acted = route(policy, 'refund_eligible', one(sysReq(), glide({ eligible: 0.01, ineligible: 0.98, unclear: 0.01 })), { now });
  assert.deepEqual(checkAction(policy, 'refund_eligible', acted, 'billing.refund'), [{ rule: 'decision:contradicted', why: 'Decision refund_eligible selected "ineligible"; billing.refund needs "eligible".' }]);
  const handed = route(policy, 'refund_eligible', one(sysReq(), glide({ eligible: 0.6, ineligible: 0.3, unclear: 0.1 })), { now });
  assert.equal(checkAction(policy, 'refund_eligible', handed, 'billing.refund')[0].rule, 'decision:not_acted');
});

test('determinism: the same records and policy give byte-identical results and receipts; input objects are not mutated', () => {
  const res = glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }); const frozen = JSON.stringify(res);
  const a = one(sysReq(), res), b = one(sysReq(), structuredClone(res));
  const ra = route(policy, 'refund_eligible', a, { now }), rb = route(policy, 'refund_eligible', b, { now });
  assert.equal(JSON.stringify(decisionReceipt({ policy, questionId: 'refund_eligible', records: a, result: ra, prev: 'sha256:' + '0'.repeat(64) })),
    JSON.stringify(decisionReceipt({ policy, questionId: 'refund_eligible', records: b, result: rb, prev: 'sha256:' + '0'.repeat(64) })));
  assert.equal(JSON.stringify(res), frozen);
});

test('policy validation refuses unknown fields and bad thresholds', () => {
  for (const bad of [{ allowed: ['a'], act_at: 1.5 }, { allowed: [], act_at: 0.9 }, { allowed: ['a'], act_at: 0.9, below: 'act' }, { allowed: ['a'], act_at: 0.9, extra: 1 }, { allowed: ['a'], act_at: 0.9, consensus: { models: [], require: 'all', max_divergence: 0.1 } }])
    assert.throws(() => compileDecisionPolicy({ decisions: { q: bad } }), /policy\.decisions\.q/);
});

test('CPU: 400 questions in one response normalize and route linearly', () => {
  const qs = {}, ans = {}, decisions = {};
  for (let i = 0; i < 400; i++) {
    const options = Object.fromEntries(Array.from({ length: 255 }, (_, k) => ['o' + k, 'option ' + k]));
    qs['q' + i] = { type: 'choice', instructions: 'x', criteria: options };
    const probabilities = Object.fromEntries(Object.keys(options).map((k, j) => [k, j ? 0.0001 : 1 - 254 * 0.0001]));
    ans['q' + i] = { type: 'choice', choice: 'o0', confidence: 0.9, probabilities };
    decisions['q' + i] = { allowed: Object.keys(options), act_at: 0.9, min_margin: 0.5, pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }], calibration, max_calibration_age_days: 30 };
  }
  const p = compileDecisionPolicy({ decisions });
  const t = performance.now();
  const recs = one({ model: 'fastino/GLiDE', state: 's', questions: qs }, { answers: ans });
  for (let i = 0; i < 400; i++) assert.equal(route(p, 'q' + i, recs.filter(r => r.question_id === 'q' + i), { now }).outcome, 'act');
  const ms = performance.now() - t;
  assert.ok(ms < 2000, ms.toFixed(0) + ' ms');
});

// CTO review 6703556475: duplicate records from one model must not stand in for a missing one.
test('consensus counts distinct models: two records from GLiDE never satisfy an all-model quorum for GLiDE + Jev', () => {
  const g = one(sysReq(), glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }));
  const g2 = one(sysReq(), glide({ eligible: 0.97, ineligible: 0.02, unclear: 0.01 }));
  const out = route(consensusPolicy, 'refund_eligible', [...g, ...g2], { now });
  assert.notEqual(out.outcome, 'act');
  assert.ok(out.reasons.includes('duplicate_model'), JSON.stringify(out));
  const k1 = compileDecisionPolicy({ decisions: { refund_eligible: { ...consensusPolicy.decisions.refund_eligible, consensus: { models: ['fastino/GLiDE', 'jev-1.13.0'], require: 2, max_divergence: 0.05 } } } });
  assert.notEqual(route(k1, 'refund_eligible', [...g, ...g2], { now }).outcome, 'act', 'k = 2 also needs two distinct models');
});

// CTO review: OpenAI documents probabilities as arrays of {value, probability}, and score levels by label.
test('decisions shape: array probabilities {value, probability} act, and score levels are matched by label', () => {
  const recs = normalizeDecisions({ provider: 'openai', request: oaReq, response: { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', confidence: 0.95,
    probabilities: [{ value: 'eligible', probability: 0.97 }, { value: 'ineligible', probability: 0.02 }, { value: 'unclear', probability: 0.01 }] }] }, receivedAt: at });
  assert.deepEqual(recs[0].probabilities, { eligible: 0.97, ineligible: 0.02, unclear: 0.01 });
  assert.equal(route(policy, 'refund_eligible', recs, { now }).outcome, 'act');
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'sev', instructions: 'How bad?', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] }] };
  const [s] = normalizeDecisions({ provider: 'openai', request: sreq, response: { model: 'gpt-6-luna', answers: [{ type: 'score', name: 'sev', score: 1.9, confidence: 0.9,
    probabilities: [{ value: 0, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.06 }, { value: 2, label: 'severe', probability: 0.92 }] }] }, receivedAt: at });
  assert.deepEqual([s.options, s.selected, s.score_position], [['none', 'minor', 'severe'], 'severe', 1.9]);
  assert.throws(() => normalizeDecisions({ provider: 'openai', request: oaReq, response: { answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', probabilities: [{ value: 'eligible', probability: 0.5 }, { value: 'eligible', probability: 0.5 }] }] }, receivedAt: at }), /malformed/, 'duplicate values are not silently merged');
});

// CTO review: Fastino criteria may be arrays; a score's levels are then indexed positions.
test('systemone shape: array criteria give string options for Choice and indexed levels for Score', () => {
  const creq = { model: 'fastino/GLiDE', state: 's', questions: { refund_eligible: { type: 'choice', instructions: 'x', criteria: ['eligible', 'ineligible', 'unclear'] } } };
  assert.throws(() => one(creq, glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 })), /malformed/, 'Choice criteria are an object for both vendors (per CTO review 6710879991)');
  const sreq = { model: 'fastino/GLiDE', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } };
  const [s] = one(sreq, { answers: { sev: { type: 'score', score: 2, expected_level: 1.9, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.06, '2': 0.92 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } });
  assert.deepEqual([s.options, s.selected], [['0', '1', '2'], '2']);
});

// CTO review: TypeSafe scores are fractional positions, not level indices. The selected level comes from the
// probabilities; the fractional value is kept, never used to select.
test('systemone shape: a fractional score selects the top-probability level and keeps the position', () => {
  const sreq = { model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } };
  const [s] = one(sreq, { answers: { sev: { type: 'score', score: 1.84, confidence: 0.8, probabilities: { '0': 0.03, '1': 0.1, '2': 0.87 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } }, 'typesafe');
  assert.deepEqual([s.selected, s.score_position], ['2', 1.84]);
});

// CTO re-review 6705370559, P1: a fractional position outside 0..top, or one that disagrees with the probability-weighted
// mean of the levels, is an invalid typed record and must not act.
const sevPolicy = compileDecisionPolicy({ decisions: { sev: { allowed: ['0', '1', '2'], act_at: 0.9, min_margin: 0.5,
  pin: [{ provider: 'typesafe', model: 'jev-1.13.0' }], calibration, max_calibration_age_days: 30 } } });
const tsScore = score => one({ model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } },
  { answers: { sev: { type: 'score', score, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } }, 'typesafe');
test('TypeSafe fractional score: out of range or inconsistent with the probabilities never acts; the documented mean acts', () => {
  for (const bad of [999.5, -1.5, 0.93]) {
    const out = route(sevPolicy, 'sev', tsScore(bad), { now });
    assert.notEqual(out.outcome, 'act', String(bad));
    assert.ok(out.reasons.includes('inconsistent'), JSON.stringify(out));
  }
  assert.deepEqual(route(sevPolicy, 'sev', tsScore(1.93), { now }), { outcome: 'act', selected: '2', reasons: [] });
});

// CTO re-review, P2: OpenAI's documented Score answer has a fractional score and probability items with a numeric value
// (the level index) and a label. The fractional position is kept, never turned into a vendor categorical answer.
test('decisions shape: the documented numeric Score response normalizes, keeps its position and routes', () => {
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'urgency', instructions: 'How urgent?', levels: [{ label: 'low' }, { label: 'medium' }, { label: 'high' }] }] };
  const res = { model: 'gpt-6-luna', answers: [{ type: 'score', name: 'urgency', score: 1.1, confidence: 0.6,
    probabilities: [{ value: 0, label: 'low', probability: 0.1 }, { value: 1, label: 'medium', probability: 0.7 }, { value: 2, label: 'high', probability: 0.2 }] }] };
  const [r] = normalizeDecisions({ provider: 'openai', request: sreq, response: res, receivedAt: at });
  assert.deepEqual([r.options, r.probabilities, r.selected, r.score_position], [['low', 'medium', 'high'], { low: 0.1, medium: 0.7, high: 0.2 }, 'medium', 1.1]);
  const p = compileDecisionPolicy({ decisions: { urgency: { allowed: ['low', 'medium', 'high'], act_at: 0.6, min_margin: 0.4, pin: [{ provider: 'openai', model: 'gpt-6-luna' }], calibration, max_calibration_age_days: 30 } } });
  assert.equal(route(p, 'urgency', [r], { now }).outcome, 'act');
  const [bad] = normalizeDecisions({ provider: 'openai', request: sreq, response: { ...res, answers: [{ ...res.answers[0], score: 2.9 }] }, receivedAt: at });
  assert.ok(route(p, 'urgency', [bad], { now }).reasons.includes('inconsistent'));
  const [whole] = normalizeDecisions({ provider: 'openai', request: sreq, response: { ...res, answers: [{ ...res.answers[0], score: 1 }] }, receivedAt: at });
  assert.deepEqual([whole.selected, whole.score_position], ['medium', 1], 'an integer score is still a position, not a level index');
});

// CTO re-review 6707270386, P1a: for TypeSafe and OpenAI every numeric score is a mean position, whole numbers included.
// GLiDE keeps its separate integer level-index contract.
test('whole-number scores are positions for TypeSafe and OpenAI: checked against the mean; GLiDE indices still select', () => {
  const ts = (score, probabilities) => one({ model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } },
    { answers: { sev: { type: 'score', score, confidence: 0.9, probabilities, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } }, 'typesafe');
  const bad = route(sevPolicy, 'sev', ts(0, { '0': 0.95, '1': 0, '2': 0.05 }), { now });
  assert.notEqual(bad.outcome, 'act'); assert.ok(bad.reasons.includes('inconsistent'), JSON.stringify(bad));
  const goodPolicy = compileDecisionPolicy({ decisions: { sev: { ...sevPolicy.decisions.sev, act_at: 0.85 } } });
  assert.deepEqual(route(goodPolicy, 'sev', ts(1, { '0': 0.05, '1': 0.9, '2': 0.05 }), { now }), { outcome: 'act', selected: '1', reasons: [] }, 'a valid integer mean acts');
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'urgency', instructions: 'x', levels: [{ label: 'low' }, { label: 'medium' }, { label: 'high' }] }] };
  const oa = (score, ps) => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'score', name: 'urgency', score, confidence: 0.6,
    probabilities: ps.map((probability, value) => ({ value, label: ['low', 'medium', 'high'][value], probability })) }] }, receivedAt: at });
  const p = compileDecisionPolicy({ decisions: { urgency: { allowed: ['low', 'medium', 'high'], act_at: 0.6, min_margin: 0.4, pin: [{ provider: 'openai', model: 'gpt-6-luna' }], calibration, max_calibration_age_days: 30 } } });
  assert.ok(route(p, 'urgency', oa(0, [0.95, 0, 0.05]), { now }).reasons.includes('inconsistent'));
  assert.equal(route(p, 'urgency', oa(1, [0.1, 0.8, 0.1]), { now }).outcome, 'act');
  const glidePolicy = compileDecisionPolicy({ decisions: { sev: { ...sevPolicy.decisions.sev, pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }] } } });
  const [g] = one({ model: 'fastino/GLiDE', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } },
    { answers: { sev: { type: 'score', score: 2, expected_level: 1.93, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } });
  assert.deepEqual([g.selected, g.score_position], ['2', 1.93], 'GLiDE integer score is a level index; its expected_level is the checked position');
  assert.equal(route(glidePolicy, 'sev', [g], { now }).outcome, 'act');
});

// CTO re-review, P1b: a label must not paper over an invalid numeric index. Range, uniqueness and index-to-declared-level
// identity are checked before routing; a mismatch is malformed.
test('OpenAI numeric value plus label: duplicate, out-of-range or swapped indices are malformed', () => {
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'sev', instructions: 'x', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] }] };
  const run = probabilities => () => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'score', name: 'sev', score: 1.93, confidence: 0.9, probabilities }] }, receivedAt: at });
  assert.throws(run([{ value: 0, label: 'none', probability: 0.02 }, { value: 0, label: 'minor', probability: 0.03 }, { value: 0, label: 'severe', probability: 0.95 }]), /malformed/, 'duplicate index');
  assert.throws(run([{ value: 999, label: 'none', probability: 0.02 }, { value: 999, label: 'minor', probability: 0.03 }, { value: 999, label: 'severe', probability: 0.95 }]), /malformed/, 'out of range');
  assert.throws(run([{ value: 2, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.03 }, { value: 0, label: 'severe', probability: 0.95 }]), /malformed/, 'swapped labels');
  assert.doesNotThrow(run([{ value: 0, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.03 }, { value: 2, label: 'severe', probability: 0.95 }]));
});

// CTO re-review 6709502686, P1: answers must correspond one to one, in order, with the requested questions. A duplicate,
// extra, missing or mismatched answer is malformed, so a later answer can never erase a refusal or a conflicting decision.
const qReq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'choice', name: 'q', instructions: 'x', choices: [{ value: 'allow' }, { value: 'deny' }] }] };
const allowAnswer = { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: [{ value: 'allow', probability: 0.95 }, { value: 'deny', probability: 0.05 }] };
const denyAnswer = { type: 'choice', name: 'q', choice: 'deny', confidence: 0.9, probabilities: [{ value: 'allow', probability: 0.05 }, { value: 'deny', probability: 0.95 }] };
const qPolicy = compileDecisionPolicy({ decisions: { q: { allowed: ['allow', 'deny'], act_at: 0.9, min_margin: 0.5, pin: [{ provider: 'openai', model: 'gpt-6-luna' }] } } });
const oaq = answers => normalizeDecisions({ provider: 'openai', request: qReq, response: { model: 'gpt-6-luna', answers }, receivedAt: at });
test('decisions shape: duplicate, extra, missing or mismatched answers are malformed; a refusal is never erased', () => {
  assert.equal(route(qPolicy, 'q', oaq([allowAnswer]), { now }).outcome, 'act', 'control');
  for (const [why, answers] of [['refusal then allow', [{ type: 'refusal', name: 'q' }, allowAnswer]], ['deny then allow', [denyAnswer, allowAnswer]],
    ['extra answer', [allowAnswer, { ...allowAnswer, name: 'other' }]], ['missing answer', []], ['wrong name', [{ ...allowAnswer, name: 'r' }]]])
    assert.throws(() => oaq(answers), /malformed/, why);
  const unnamed = { ...qReq, questions: [{ type: 'choice', instructions: 'x', choices: [{ value: 'allow' }, { value: 'deny' }] }, { type: 'choice', instructions: 'y', choices: [{ value: 'allow' }, { value: 'deny' }] }] };
  const { name: _n, ...anon } = allowAnswer;
  assert.equal(normalizeDecisions({ provider: 'openai', request: unnamed, response: { answers: [anon, anon] }, receivedAt: at }).length, 2, 'unnamed questions match by position');
  assert.throws(() => normalizeDecisions({ provider: 'openai', request: unnamed, response: { answers: [anon, allowAnswer] }, receivedAt: at }), /malformed/, 'a named answer for an unnamed question');
  assert.throws(() => one(sysReq(), { answers: { ...glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }).answers, extra: { choice: 'x', probabilities: {} } } }), /malformed/, 'systemone extra answer');
});

// CTO re-review, P2: OpenAI's documented wire types are a numeric Score and integer level indices; choice values are
// strings or booleans. Anything else is malformed, with no label fallback.
test('decisions shape: malformed OpenAI wire types are refused; valid numeric means, boolean and string choices pass', () => {
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'sev', instructions: 'x', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] }] };
  const items = v => [0, 1, 2].map(i => ({ value: v(i), label: ['none', 'minor', 'severe'][i], probability: [0.02, 0.03, 0.95][i] }));
  const sc = (score, probabilities) => () => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'score', name: 'sev', score, confidence: 0.9, probabilities }] }, receivedAt: at });
  assert.throws(sc('severe', items(i => i)), /malformed/, 'string score');
  assert.throws(sc(1.93, items(() => null)), /malformed/, 'null value');
  assert.throws(sc(1.93, items(() => ({ invalid: true }))), /malformed/, 'object value');
  assert.doesNotThrow(sc(1.93, items(i => i)), 'valid numeric mean');
  const breq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'choice', name: 'b', instructions: 'x', choices: [{ value: true }, { value: false }] }] };
  const [b] = normalizeDecisions({ provider: 'openai', request: breq, response: { answers: [{ type: 'choice', name: 'b', choice: true, confidence: 0.9,
    probabilities: [{ value: true, probability: 0.96 }, { value: false, probability: 0.04 }] }] }, receivedAt: at });
  assert.deepEqual([b.options, b.selected, b.probabilities], [['true', 'false'], 'true', { true: 0.96, false: 0.04 }]);
  assert.throws(() => oaq([{ ...allowAnswer, probabilities: [{ value: null, label: 'allow', probability: 0.95 }, { value: 'deny', probability: 0.05 }] }]), /malformed/, 'choice null value');
});

// CTO review 6710693985: validate raw discriminants and literal identity before any coercion.
const tsChoiceReq = { model: 'jev-1.13.0', state: 's', questions: { q: { type: 'choice', instructions: 'x', criteria: { allow: 'a', deny: 'd' } } } };
const tsPolicy = compileDecisionPolicy({ decisions: { q: { allowed: ['allow', 'deny'], act_at: 0.9, min_margin: 0.5, pin: [{ provider: 'typesafe', model: 'jev-1.13.0' }] } } });
test('systemone answer discriminant: a mismatched type is malformed, a refusal never acts, a matching type acts', () => {
  const ans = type => one(tsChoiceReq, { answers: { q: { ...(type ? { type } : {}), choice: 'allow', confidence: 0.9, probabilities: { allow: 0.95, deny: 0.05 } } } }, 'typesafe');
  assert.throws(() => ans('score'), /malformed/, 'score answer to a choice question');
  assert.throws(() => ans(undefined), /malformed/, 'TypeSafe answers carry their type');
  const refused = route(tsPolicy, 'q', ans('refusal'), { now });
  assert.deepEqual([refused.outcome, refused.reasons], ['hand_off', ['refused']]);
  assert.equal(route(tsPolicy, 'q', ans('choice'), { now }).outcome, 'act', 'control');
  const { type: _t, ...untyped } = glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }).answers.refund_eligible;
  assert.throws(() => one(sysReq(), { answers: { refund_eligible: untyped } }), /malformed/, 'GLiDE answers require type too (Fastino OpenAPI, per CTO review 6710879991)');
});

test('decisions shape: choice membership is exact by raw type; "true" is not the declared boolean true', () => {
  const breq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'choice', name: 'b', instructions: 'x', choices: [{ value: true }, { value: false }] }] };
  const bp = compileDecisionPolicy({ decisions: { b: { allowed: ['true', 'false'], act_at: 0.9, min_margin: 0.5, pin: [{ provider: 'openai', model: 'gpt-6-luna' }] } } });
  const run = (choice, v1, v2) => normalizeDecisions({ provider: 'openai', request: breq, response: { answers: [{ type: 'choice', name: 'b', choice, confidence: 0.9,
    probabilities: [{ value: v1, probability: 0.95 }, { value: v2, probability: 0.05 }] }] }, receivedAt: at });
  assert.throws(() => run('true', 'true', 'false'), /malformed/, 'string values for boolean choices');
  assert.throws(() => run('true', true, false), /malformed/, 'string choice for a boolean declaration');
  assert.equal(route(bp, 'b', run(true, true, false), { now }).outcome, 'act', 'exact booleans act');
  const sreq = { ...breq, questions: [{ ...breq.questions[0], choices: [{ value: 'true' }, { value: 'false' }] }] };
  assert.throws(() => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'choice', name: 'b', choice: true, confidence: 0.9,
    probabilities: [{ value: true, probability: 0.95 }, { value: false, probability: 0.05 }] }] }, receivedAt: at }), /malformed/, 'booleans for string declarations');
});

test('decisions shape: only predicate, choice and score are supported; any other type is malformed', () => {
  const ureq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'unsupported', name: 'u', instructions: 'x', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] }] };
  assert.throws(() => normalizeDecisions({ provider: 'openai', request: ureq, response: { answers: [{ type: 'unsupported', name: 'u', score: 1.93,
    probabilities: [{ value: 'none', probability: 0.02 }, { value: 'minor', probability: 0.03 }, { value: 'severe', probability: 0.95 }] }] }, receivedAt: at }), /malformed/);
  assert.throws(() => one({ model: 'jev-1.13.0', state: 's', questions: { u: { type: 'box', instructions: 'x', criteria: { a: 'a' } } } }, { answers: { u: { type: 'box', choice: 'a', probabilities: { a: 1 } } } }, 'typesafe'), /malformed/);
});

// CTO review 6710879991: each vendor's documented answer schema (Fastino and TypeSafe OpenAPI) is validated before any
// normalization: required fields, types and domains. A malformed answer never reaches routing.
const gChoice = () => ({ type: 'choice', choice: 'allow', confidence: 0.9, probabilities: { allow: 0.95, deny: 0.05 } });
const gNoul = () => ({ type: 'noul', noul: 0.97, confidence: 0.94 });
const gScore = () => ({ type: 'score', score: 2, expected_level: 1.93, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } });
const gReq = { model: 'fastino/GLiDE', state: 's', questions: {
  c: { type: 'choice', instructions: 'x', criteria: { allow: 'a', deny: 'd' } },
  n: { type: 'noul', instructions: 'x' },
  s: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } };
const gPolicy = compileDecisionPolicy({ decisions: Object.fromEntries([['c', ['allow', 'deny']], ['n', ['true', 'false']], ['s', ['0', '1', '2']]]
  .map(([id, allowed]) => [id, { allowed, act_at: 0.9, min_margin: 0.5, pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }] }])) });
const gRun = answers => one(gReq, { model: 'glide', answers: { c: gChoice(), n: gNoul(), s: gScore(), ...answers } });
const without = (o, k) => { const c = { ...o }; delete c[k]; return c; };
test('GLiDE raw schema: required fields, types and domains are validated before routing; valid controls act', () => {
  const ok = gRun({});
  for (const id of ['c', 'n', 's']) assert.equal(route(gPolicy, id, ok, { now }).outcome, 'act', 'control ' + id);
  const bad = [];
  for (const k of ['type', 'confidence']) bad.push(['choice -' + k, { c: without(gChoice(), k) }], ['noul -' + k, { n: without(gNoul(), k) }]);
  for (const k of ['type', 'expected_level', 'confidence', 'legend', 'probabilities']) bad.push(['score -' + k, { s: without(gScore(), k) }]);
  for (const v of ['0.9', null, -0.1, 1.1]) bad.push(['choice confidence ' + v, { c: { ...gChoice(), confidence: v } }], ['noul confidence ' + v, { n: { ...gNoul(), confidence: v } }], ['score confidence ' + v, { s: { ...gScore(), confidence: v } }]);
  bad.push(['score expected_level string', { s: { ...gScore(), expected_level: '1.93' } }], ['score expected_level out of range', { s: { ...gScore(), expected_level: 9 } }],
    ['score legend wrong length', { s: { ...gScore(), legend: ['none'] } }], ['score fractional index', { s: { ...gScore(), score: 1.5 } }], ['noul not a probability', { n: { ...gNoul(), noul: 1.2 } }]);
  for (const [why, answers] of bad) assert.throws(() => gRun(answers), /malformed/, why);
  const drift = route(gPolicy, 's', gRun({ s: { ...gScore(), expected_level: 0.2 } }), { now });
  assert.ok(drift.reasons.includes('inconsistent'), 'GLiDE expected_level must match the probability-weighted mean');
});

test('TypeSafe raw schema: Noul needs no confidence and records it as derived; Choice and Score keep their required fields', () => {
  const tReq = { model: 'jev-1.14.0', state: 's', questions: { n: { type: 'noul', instructions: 'x' }, c: { type: 'choice', instructions: 'x', criteria: { allow: 'a', deny: 'd' } },
    s: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } };
  const tAns = () => ({ n: { type: 'noul', noul: 0.97 }, c: gChoice(), s: { type: 'score', score: 1.93, confidence: 0.8, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } });
  const recs = one(tReq, { model: 'jev-1.14.0', answers: tAns() }, 'typesafe');
  const n = recs.find(r => r.question_id === 'n');
  assert.deepEqual([n.confidence_source, Math.round(n.confidence * 100)], ['derived', 94]);
  assert.equal(one(gReq, { answers: { c: gChoice(), n: gNoul(), s: gScore() } }).find(r => r.question_id === 'n').confidence_source, 'vendor');
  for (const [why, patch] of [['choice -confidence', { c: without(gChoice(), 'confidence') }], ['score -legend', { s: without(tAns().s, 'legend') }],
    ['score -confidence', { s: without(tAns().s, 'confidence') }], ['noul confidence out of range', { n: { type: 'noul', noul: 0.97, confidence: 2 } }]])
    assert.throws(() => one(tReq, { answers: { ...tAns(), ...patch } }, 'typesafe'), /malformed/, why);
  assert.throws(() => one({ ...tReq, questions: { ...tReq.questions, s: { ...tReq.questions.s, criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } }, { answers: tAns() }, 'typesafe'), /malformed/, 'TypeSafe Score criteria are an array');
  const eleven = Array.from({ length: 11 }, (_, i) => 'l' + i);
  assert.throws(() => one({ ...tReq, questions: { s: { type: 'score', instructions: 'x', criteria: eleven } } }, { answers: { s: { type: 'score', score: 0, confidence: 1, legend: eleven, probabilities: Object.fromEntries(eleven.map((_, i) => [String(i), i ? 0 : 1])) } } }, 'typesafe'), /malformed/, 'TypeSafe Score has at most 10 levels');
  assert.throws(() => one(gReq, { answers: { c: gChoice(), n: gNoul(), s: gScore() } }, 'acme'), /malformed/, 'unknown systemone provider');
});

test('GLiDE Score criteria may be a numeric-key object: sorted and reindexed to 0..N-1', () => {
  const req = { model: 'fastino/GLiDE', state: 's', questions: { s: { type: 'score', instructions: 'x', criteria: { '20': 'severe', '3': 'none', '10': 'minor' } } } };
  const [r] = one(req, { answers: { s: gScore() } });
  assert.deepEqual([r.options, r.selected], [['0', '1', '2'], '2']);
  assert.throws(() => one({ ...req, questions: { s: { ...req.questions.s, criteria: { a: 'none', b: 'minor' } } } }, { answers: { s: gScore() } }), /malformed/, 'non-numeric Score keys');
});

// CTO re-review 6717162776 / 6717511187: raw contracts and policy booleans are validated before normalization.
test('systemone legend: an index-keyed object whose values match the requested rubric; arrays, wrong keys, bad values or a reversed rubric are malformed', () => {
  const ok = gRun({});
  assert.equal(route(gPolicy, 's', ok, { now }).outcome, 'act', 'control');
  for (const [why, legend] of [['array', ['none', 'minor', 'severe']], ['wrong keys', { a: 'none', b: 'minor', c: 'severe' }],
    ['invalid values', { '0': 1, '1': null, '2': 'severe' }], ['reversed rubric', { '0': 'severe', '1': 'minor', '2': 'none' }], ['extra key', { '0': 'none', '1': 'minor', '2': 'severe', '3': 'x' }]])
    assert.throws(() => gRun({ s: { ...gScore(), legend } }), /malformed/, why);
});

test('OpenAI raw contract: choice and score need a confidence in [0,1]; score probability items need labels; null names are valid for unnamed questions', () => {
  const question = { type: 'choice', name: 'q', instructions: 'Choose', choices: [{ value: 'allow' }, { value: 'deny' }] };
  const answer = { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: [{ value: 'allow', probability: 0.95 }, { value: 'deny', probability: 0.05 }] };
  const p = compileDecisionPolicy({ decisions: { q: { allowed: ['allow', 'deny'], act_at: 0.9, min_margin: 0.5 }, 0: { allowed: ['allow', 'deny'], act_at: 0.9, min_margin: 0.5 } } });
  const check = (q, a, key = 'q') => route(p, key, normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'synthetic', questions: [q] },
    response: { model: 'gpt-6-luna', answers: [a], usage: { input_tokens: 1, output_tokens: 1 } }, receivedAt: at }), { now });
  assert.equal(check(question, answer).outcome, 'act', 'control');
  for (const c of ['high', null, -0.1, 1.1]) assert.throws(() => check(question, { ...answer, confidence: c }), /malformed/, 'confidence ' + c);
  const { confidence: _c, ...noConf } = answer;
  assert.throws(() => check(question, noConf), /malformed/, 'missing confidence');
  const { name: _n, ...unnamed } = question;
  assert.equal(check(unnamed, { ...answer, name: null }, '0').outcome, 'act', 'documented null name on an unnamed question');
  assert.deepEqual(check(unnamed, { type: 'refusal', name: null }, '0').reasons, ['refused'], 'a null-name refusal stays a refusal');
  const sreq = { type: 'score', name: 'sev', instructions: 'x', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] };
  const sp = compileDecisionPolicy({ decisions: { sev: { allowed: ['none', 'minor', 'severe'], act_at: 0.9, min_margin: 0.5 } } });
  const sc = probabilities => () => normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'x', questions: [sreq] },
    response: { answers: [{ type: 'score', name: 'sev', score: 1.93, confidence: 0.9, probabilities }] }, receivedAt: at });
  assert.throws(sc([{ value: 0, probability: 0.02 }, { value: 1, probability: 0.03 }, { value: 2, probability: 0.95 }]), /malformed/, 'score items need labels');
  assert.equal(route(sp, 'sev', sc([0, 1, 2].map(i => ({ value: i, label: ['none', 'minor', 'severe'][i], probability: [0.02, 0.03, 0.95][i] })))(), { now }).outcome, 'act', 'labelled control');
});

test('policy booleans: require_calibration must be a boolean', () => {
  for (const v of [0, 1, 'false', null]) assert.throws(() => compileDecisionPolicy({ decisions: { q: { allowed: ['a'], act_at: 0.9, require_calibration: v } } }), /policy\.decisions\.q/, String(v));
  assert.doesNotThrow(() => compileDecisionPolicy({ decisions: { q: { allowed: ['a'], act_at: 0.9, require_calibration: false } } }));
});

// CTO re-review 6717768775 of 8cd28d7: two act paths. Each test below failed on 8cd28d7 before the fix.
const oaRun = (q, a, p, key) => route(p, key, normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'synthetic', questions: [q] },
  response: { model: 'gpt-6-luna', answers: [a] }, receivedAt: at }), { now });
const allowPolicy = compileDecisionPolicy({ decisions: { q: { allowed: ['allow'], act_at: 0.8, min_margin: 0 } } });
const twoProbs = (a, b) => [{ value: a, probability: 0.95 }, { value: b, probability: 0.05 }];

test('P1a OpenAI Choice: the discriminant is the required literal value; a conflicting label or name never changes its meaning', () => {
  // The CTO's exact reproduction: declared values are deny/reject; "allow" exists only as a label.
  const conflict = { type: 'choice', name: 'q', instructions: 'x', choices: [{ value: 'deny', label: 'allow' }, { value: 'reject', label: 'deny' }] };
  assert.throws(() => oaRun(conflict, { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }, allowPolicy, 'q'), /malformed/, 'CTO reproduction');
  // The same values without the stray labels: "allow" is still not declared, so it can't act either.
  const plain = { ...conflict, choices: [{ value: 'deny' }, { value: 'reject' }] };
  assert.throws(() => oaRun(plain, { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }, allowPolicy, 'q'), /malformed/, 'undeclared value');
  for (const [why, choice] of [['label only', { label: 'allow' }], ['name only', { name: 'allow' }], ['key only', { key: 'allow' }], ['value null', { value: null, label: 'allow' }],
    ['value number', { value: 1 }], ['bare string', 'allow'], ['bare boolean', true]]) {
    const q = { ...conflict, choices: [choice, { value: 'deny' }] };
    assert.throws(() => oaRun(q, { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }, allowPolicy, 'q'), /malformed/, why);
  }
  // Declarations are rejected before routing: duplicates, typed collisions this record format can't keep apart, wrong counts.
  for (const [why, choices] of [['duplicate value', [{ value: 'allow' }, { value: 'allow' }]], ['"true" and true', [{ value: 'true' }, { value: true }]],
    ['one choice', [{ value: 'allow' }]], ['256 choices', Array.from({ length: 256 }, (_, i) => ({ value: 'c' + i }))], ['not an array', { allow: {} }]])
    assert.throws(() => oaRun({ ...conflict, choices }, { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }, allowPolicy, 'q'), /malformed/, why);
  // Correct typed controls act; description is allowed.
  const good = { ...conflict, choices: [{ value: 'allow', description: 'policy allows' }, { value: 'deny' }] };
  assert.equal(oaRun(good, { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }, allowPolicy, 'q').outcome, 'act', 'string control');
  const bp = compileDecisionPolicy({ decisions: { q: { allowed: ['true'], act_at: 0.8, min_margin: 0 } } });
  assert.equal(oaRun({ ...conflict, choices: [{ value: true }, { value: false }] }, { type: 'choice', name: 'q', choice: true, confidence: 0.9, probabilities: twoProbs(true, false) }, bp, 'q').outcome, 'act', 'boolean control');
});

test('P1a OpenAI Score: levels are matched by their own required label; a value, name or missing label is malformed', () => {
  const sp = compileDecisionPolicy({ decisions: { sev: { allowed: ['severe'], act_at: 0.9, min_margin: 0 } } });
  const run = levels => oaRun({ type: 'score', name: 'sev', instructions: 'x', levels }, { type: 'score', name: 'sev', score: 1.93, confidence: 0.9,
    probabilities: [0, 1, 2].map(i => ({ value: i, label: ['none', 'minor', 'severe'][i], probability: [0.02, 0.03, 0.95][i] })) }, sp, 'sev');
  assert.equal(run([{ label: 'none' }, { label: 'minor', description: 'd' }, { label: 'severe' }]).outcome, 'act', 'control');
  for (const [why, levels] of [['name instead of label', [{ label: 'none' }, { label: 'minor' }, { name: 'severe' }]], ['value instead of label', [{ label: 'none' }, { label: 'minor' }, { value: 'severe' }]],
    ['stray value beside label', [{ label: 'none' }, { label: 'minor' }, { label: 'severe', value: 'none' }]], ['non-string label', [{ label: 'none' }, { label: 'minor' }, { label: 2 }]],
    ['bare string', ['none', 'minor', 'severe']], ['duplicate label', [{ label: 'none' }, { label: 'severe' }, { label: 'severe' }]], ['one level', [{ label: 'severe' }]],
    ['11 levels', Array.from({ length: 11 }, (_, i) => ({ label: 'l' + i }))]])
    assert.throws(() => run(levels), /malformed/, why);
});

test('P1b policy: an explicitly undefined field is refused; omitted fields keep their safe defaults', () => {
  const base = { allowed: ['allow'], act_at: 0.8, operations: { allow: 'billing.refund' } };
  // The CTO's exact reproductions.
  assert.throws(() => compileDecisionPolicy({ decisions: { q: { ...base, require_calibration: undefined } } }), /policy\.decisions\.q: require_calibration/, 'require_calibration: undefined');
  const stale = { dataset: 'd', accuracy_at_threshold: 0.99, measured_at: '2020-01-01T00:00:00Z' };
  assert.throws(() => compileDecisionPolicy({ decisions: { q: { ...base, calibration: stale, max_calibration_age_days: undefined } } }), /policy\.decisions\.q: max_calibration_age_days/, 'max_calibration_age_days: undefined');
  // Every policy field, and the nested consensus and calibration objects, refuse a present undefined.
  for (const k of ['allowed', 'act_at', 'min_margin', 'pin', 'consensus', 'below', 'calibration', 'max_calibration_age_days', 'require_calibration', 'operations'])
    assert.throws(() => compileDecisionPolicy({ decisions: { q: { ...base, [k]: undefined } } }), /policy\.decisions\.q/, k);
  assert.throws(() => compileDecisionPolicy({ decisions: { q: { ...base, consensus: { models: ['m'], require: 'all', max_divergence: 0.1, extra: undefined } } } }), /policy\.decisions\.q/, 'consensus field');
  assert.throws(() => compileDecisionPolicy({ decisions: { q: { ...base, calibration: { ...stale, measured_at: '2026-11-01T00:00:00Z', note: undefined } } } }), /policy\.decisions\.q/, 'calibration field');
  // Omitted: the safe defaults still apply.
  const confident = normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'choice', name: 'q', instructions: 'x', choices: [{ value: 'allow' }, { value: 'deny' }] }] },
    response: { answers: [{ type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }] }, receivedAt: at });
  assert.deepEqual(route(compileDecisionPolicy({ decisions: { q: base } }), 'q', confident, { now }).reasons, ['calibration_missing'], 'omitted require_calibration');
  assert.deepEqual(route(compileDecisionPolicy({ decisions: { q: { ...base, calibration: stale } } }), 'q', confident, { now }).reasons, ['calibration_stale'], 'omitted max_calibration_age_days');
  assert.equal(route(compileDecisionPolicy({ decisions: { q: { ...base, calibration: { ...stale, measured_at: '2026-11-01T00:00:00Z' } } } }), 'q', confident, { now }).outcome, 'act', 'fresh control');
});

// Curbi-env corrections C1–C6 (#43 6710842943), reproduced on the vendors' own documented examples (loaded 2026-11-07).
test('C1–C6: the vendors’ documented example responses normalize as documented', () => {
  // C1 + C2 + C3: OpenAI's guide choice and score examples.
  const oc = normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'I was charged twice for my order.', questions: [{ type: 'choice', name: 'department', instructions: 'x',
    choices: [{ value: 'billing', description: 'a' }, { value: 'technical', description: 'b' }, { value: 'shipping', description: 'c' }, { value: 'other', description: 'd' }] }] },
    response: { answers: [{ type: 'choice', name: 'department', choice: 'billing', probabilities: [{ value: 'billing', probability: 0.95 }, { value: 'technical', probability: 0.02 }, { value: 'shipping', probability: 0.01 }, { value: 'other', probability: 0.02 }], confidence: 0.93 }] } })[0];
  assert.deepEqual([oc.selected, oc.probabilities], ['billing', { billing: 0.95, technical: 0.02, shipping: 0.01, other: 0.02 }], 'C1: array probabilities are read, not margin_unavailable');
  const os = normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'Export fails in Safari but works in Chrome.', questions: [{ type: 'score', name: 'severity', instructions: 'x',
    levels: [{ label: 'Cosmetic', description: 'a' }, { label: 'Workaround available', description: 'b' }, { label: 'Fully blocked', description: 'c' }] }] },
    response: { answers: [{ type: 'score', name: 'severity', score: 1.1, probabilities: [{ value: 0, label: 'Cosmetic', probability: 0.1 }, { value: 1, label: 'Workaround available', probability: 0.7 }, { value: 2, label: 'Fully blocked', probability: 0.2 }], confidence: 0.55 }] } })[0];
  assert.deepEqual(os.options, ['Cosmetic', 'Workaround available', 'Fully blocked'], 'C2: options are the labels, not "undefined"');
  assert.deepEqual([os.selected, os.score_position], ['Workaround available', 1.1], 'C3: the level is the argmax; the decimal score is a position');
  // C4: Fastino's documented multi-question request, Score criteria as an ordered array.
  const g = normalizeSystemone({ provider: 'fastino', request: { model: 'fastino/GLiDE', state: 'Refund request', questions: {
    department: { type: 'choice', instructions: 'x', criteria: { billing: 'a', returns: 'b', shipping: 'c' } },
    urgency: { type: 'score', instructions: 'x', criteria: ['low urgency, can wait', 'medium urgency, handle soon', 'high urgency, handle immediately'] } } },
    response: { model: 'glide', answers: { department: { type: 'choice', choice: 'returns', confidence: 0.9992611288391886, probabilities: { billing: 0.00031500429476013744, returns: 0.9995761331339488, shipping: 0.00010886257129113499 } },
      urgency: { type: 'score', score: 0, expected_level: 0.27621539375795195, confidence: 0.4999999998141525, probabilities: { 0: 0.7412615353520668, 1: 0.24126153553791435, 2: 0.017476929110018805 },
        legend: { 0: 'low urgency, can wait', 1: 'medium urgency, handle soon', 2: 'high urgency, handle immediately' } } }, usage: { input_tokens: 743, output_tokens: 252 } } });
  assert.deepEqual(g.map(r => [r.question_id, r.selected]), [['department', 'returns'], ['urgency', '0']], 'C4: documented array criteria are accepted');
  // C5: TypeSafe's documented Score example, a decimal score of 1.43.
  const j = normalizeSystemone({ provider: 'typesafe', request: { model: 'jev-1.13.0', state: 'x', questions: { bug_severity: { type: 'score', instructions: 'x', criteria: ['cosmetic', 'workaround', 'none'] } } },
    response: { model: 'jev-1.13.0', answers: { bug_severity: { type: 'score', score: 1.43, confidence: 0.35, legend: { 0: 'cosmetic', 1: 'workaround', 2: 'none' }, probabilities: { 0: 0, 1: 0.57, 2: 0.43 } } } } })[0];
  assert.deepEqual([j.selected, j.score_position], ['1', 1.43], 'C5: a decimal Jev score is a position and does not throw');
  // C6: TypeSafe's documented Noul example has no confidence; the derived value is labelled.
  const n = normalizeSystemone({ provider: 'typesafe', request: { model: 'jev-1.13.0', state: 'x', questions: { is_human_escalation: { type: 'noul', instructions: 'x' } } },
    response: { model: 'jev-1.13.0', answers: { is_human_escalation: { type: 'noul', noul: 0.99 } } } })[0];
  assert.equal(n.confidence_source, 'derived', 'C6: derived confidence is labelled');
});

// Same class as P1b, found in this pass: a getter can pass validation and then change when the policy is copied.
test('policy and wire inputs are read once: a getter that changes between validation and copy cannot erase a default', () => {
  const flip = (ok, later) => { let n = 0; return { get() { return n++ === 0 ? ok : later; }, enumerable: true }; };
  const pol = Object.defineProperty({ allowed: ['allow'], act_at: 0.8, operations: { allow: 'billing.refund' } }, 'require_calibration', flip(true, undefined));
  const compiled = (() => { try { return compileDecisionPolicy({ decisions: { q: pol } }); } catch (e) { return e; } })();
  if (!(compiled instanceof Error)) {
    const recs = normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'choice', name: 'q', instructions: 'x', choices: [{ value: 'allow' }, { value: 'deny' }] }] },
      response: { answers: [{ type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'deny') }] }, receivedAt: at });
    assert.notEqual(route(compiled, 'q', recs, { now }).outcome, 'act', 'a flipped require_calibration must not act without calibration');
  }
  const act = flip(0.8, 0.0001);
  const pol2 = Object.defineProperty({ allowed: ['allow'], min_margin: 0, require_calibration: false }, 'act_at', act);
  const c2 = compileDecisionPolicy({ decisions: { q: pol2 } });
  assert.equal(c2.decisions.q.act_at, 0.8, 'the validated act_at is the one kept');
  // Wire inputs: a request whose choice value flips after validation.
  const choice = Object.defineProperty({}, 'value', flip('deny', 'allow'));
  assert.throws(() => oaRun({ type: 'choice', name: 'q', instructions: 'x', choices: [choice, { value: 'reject' }] },
    { type: 'choice', name: 'q', choice: 'allow', confidence: 0.9, probabilities: twoProbs('allow', 'reject') }, allowPolicy, 'q'), /malformed/, 'flipped declaration');
});
