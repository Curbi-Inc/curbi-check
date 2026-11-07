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
const glide = (probabilities, extra = {}) => ({ model: 'glide', answers: { refund_eligible: {
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
  const recs = one(req, { answers: { refund_eligible: { noul: 0.97 } } }, 'typesafe');
  assert.deepEqual([recs[0].selected, recs[0].probabilities, Math.round(recs[0].confidence * 100)], ['true', { true: 0.97, false: 0.030000000000000027 }, 94]);
  assert.equal(route(p, 'refund_eligible', recs, { now }).outcome, 'act');
  assert.throws(() => one(req, { answers: { refund_eligible: { noul: true } } }, 'typesafe'), /malformed/, 'not a boolean');
});

test('systemone score: the integer level is selected; expected_level is kept but never selects', () => {
  const req = { model: 'fastino/GLiDE', state: 's', questions: { severity: { type: 'score', instructions: 'How bad?', criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } };
  const [r] = one(req, { answers: { severity: { score: 2, expected_level: 1.9, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.06, '2': 0.92 }, legend: { '0': 'none', '1': 'minor', '2': 'severe' } } } });
  assert.deepEqual([r.type, r.selected, r.expected_level], ['score', '2', 1.9]);
});

const oaReq = { model: 'gpt-6-luna', input: 'Order arrived broken', questions: [{ type: 'choice', name: 'refund_eligible', instructions: 'Is a refund allowed?', choices: ['eligible', 'ineligible', 'unclear'] }] };
test('decisions shape: a choice with per-option probabilities acts; without them the margin is unavailable and it hands off', () => {
  const withP = normalizeDecisions({ provider: 'openai', request: oaReq, response: { model: 'gpt-6-luna', answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', confidence: 0.95, probabilities: { eligible: 0.97, ineligible: 0.02, unclear: 0.01 } }] }, receivedAt: at });
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
const jevAnswer = p => one({ ...sysReq(), model: 'jev-1.13.0' }, glide(p), 'typesafe');
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
    ans['q' + i] = { choice: 'o0', confidence: 0.9, probabilities };
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
  const [s] = normalizeDecisions({ provider: 'openai', request: sreq, response: { model: 'gpt-6-luna', answers: [{ type: 'score', name: 'sev', score: 'severe',
    probabilities: [{ value: 'none', probability: 0.02 }, { value: 'minor', probability: 0.06 }, { value: 'severe', probability: 0.92 }] }] }, receivedAt: at });
  assert.deepEqual([s.options, s.selected], [['none', 'minor', 'severe'], 'severe']);
  assert.throws(() => normalizeDecisions({ provider: 'openai', request: oaReq, response: { answers: [{ type: 'choice', name: 'refund_eligible', choice: 'eligible', probabilities: [{ value: 'eligible', probability: 0.5 }, { value: 'eligible', probability: 0.5 }] }] }, receivedAt: at }), /malformed/, 'duplicate values are not silently merged');
});

// CTO review: Fastino criteria may be arrays; a score's levels are then indexed positions.
test('systemone shape: array criteria give string options for Choice and indexed levels for Score', () => {
  const creq = { model: 'fastino/GLiDE', state: 's', questions: { refund_eligible: { type: 'choice', instructions: 'x', criteria: ['eligible', 'ineligible', 'unclear'] } } };
  const [c] = one(creq, glide({ eligible: 0.96, ineligible: 0.03, unclear: 0.01 }));
  assert.deepEqual(c.options, ['eligible', 'ineligible', 'unclear']);
  assert.equal(route(policy, 'refund_eligible', [c], { now }).outcome, 'act');
  const sreq = { model: 'fastino/GLiDE', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } };
  const [s] = one(sreq, { answers: { sev: { score: 2, expected_level: 1.9, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.06, '2': 0.92 } } } });
  assert.deepEqual([s.options, s.selected], [['0', '1', '2'], '2']);
});

// CTO review: TypeSafe scores are fractional positions, not level indices. The selected level comes from the
// probabilities; the fractional value is kept, never used to select.
test('systemone shape: a fractional score selects the top-probability level and keeps the position', () => {
  const sreq = { model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } };
  const [s] = one(sreq, { answers: { sev: { score: 1.84, confidence: 0.8, probabilities: { '0': 0.03, '1': 0.1, '2': 0.87 } } } }, 'typesafe');
  assert.deepEqual([s.selected, s.score_position], ['2', 1.84]);
});

// CTO re-review 6705370559, P1: a fractional position outside 0..top, or one that disagrees with the probability-weighted
// mean of the levels, is an invalid typed record and must not act.
const sevPolicy = compileDecisionPolicy({ decisions: { sev: { allowed: ['0', '1', '2'], act_at: 0.9, min_margin: 0.5,
  pin: [{ provider: 'typesafe', model: 'jev-1.13.0' }], calibration, max_calibration_age_days: 30 } } });
const tsScore = score => one({ model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } },
  { answers: { sev: { score, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 } } } }, 'typesafe');
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
  const res = { model: 'gpt-6-luna', answers: [{ type: 'score', name: 'urgency', score: 1.1,
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
  const ts = (score, probabilities) => one({ model: 'jev-1.13.0', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: { '0': 'none', '1': 'minor', '2': 'severe' } } } },
    { answers: { sev: { score, confidence: 0.9, probabilities } } }, 'typesafe');
  const bad = route(sevPolicy, 'sev', ts(0, { '0': 0.95, '1': 0, '2': 0.05 }), { now });
  assert.notEqual(bad.outcome, 'act'); assert.ok(bad.reasons.includes('inconsistent'), JSON.stringify(bad));
  const goodPolicy = compileDecisionPolicy({ decisions: { sev: { ...sevPolicy.decisions.sev, act_at: 0.85 } } });
  assert.deepEqual(route(goodPolicy, 'sev', ts(1, { '0': 0.05, '1': 0.9, '2': 0.05 }), { now }), { outcome: 'act', selected: '1', reasons: [] }, 'a valid integer mean acts');
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'urgency', instructions: 'x', levels: [{ label: 'low' }, { label: 'medium' }, { label: 'high' }] }] };
  const oa = (score, ps) => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'score', name: 'urgency', score,
    probabilities: ps.map((probability, value) => ({ value, label: ['low', 'medium', 'high'][value], probability })) }] }, receivedAt: at });
  const p = compileDecisionPolicy({ decisions: { urgency: { allowed: ['low', 'medium', 'high'], act_at: 0.6, min_margin: 0.4, pin: [{ provider: 'openai', model: 'gpt-6-luna' }], calibration, max_calibration_age_days: 30 } } });
  assert.ok(route(p, 'urgency', oa(0, [0.95, 0, 0.05]), { now }).reasons.includes('inconsistent'));
  assert.equal(route(p, 'urgency', oa(1, [0.1, 0.8, 0.1]), { now }).outcome, 'act');
  const glidePolicy = compileDecisionPolicy({ decisions: { sev: { ...sevPolicy.decisions.sev, pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }] } } });
  const [g] = one({ model: 'fastino/GLiDE', state: 's', questions: { sev: { type: 'score', instructions: 'x', criteria: ['none', 'minor', 'severe'] } } },
    { answers: { sev: { score: 2, expected_level: 1.93, confidence: 0.9, probabilities: { '0': 0.02, '1': 0.03, '2': 0.95 } } } });
  assert.deepEqual([g.selected, g.score_position], ['2', undefined], 'GLiDE integer score is a level index');
  assert.equal(route(glidePolicy, 'sev', [g], { now }).outcome, 'act');
});

// CTO re-review, P1b: a label must not paper over an invalid numeric index. Range, uniqueness and index-to-declared-level
// identity are checked before routing; a mismatch is malformed.
test('OpenAI numeric value plus label: duplicate, out-of-range or swapped indices are malformed', () => {
  const sreq = { model: 'gpt-6-luna', input: 'x', questions: [{ type: 'score', name: 'sev', instructions: 'x', levels: [{ label: 'none' }, { label: 'minor' }, { label: 'severe' }] }] };
  const run = probabilities => () => normalizeDecisions({ provider: 'openai', request: sreq, response: { answers: [{ type: 'score', name: 'sev', score: 1.93, probabilities }] }, receivedAt: at });
  assert.throws(run([{ value: 0, label: 'none', probability: 0.02 }, { value: 0, label: 'minor', probability: 0.03 }, { value: 0, label: 'severe', probability: 0.95 }]), /malformed/, 'duplicate index');
  assert.throws(run([{ value: 999, label: 'none', probability: 0.02 }, { value: 999, label: 'minor', probability: 0.03 }, { value: 999, label: 'severe', probability: 0.95 }]), /malformed/, 'out of range');
  assert.throws(run([{ value: 2, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.03 }, { value: 0, label: 'severe', probability: 0.95 }]), /malformed/, 'swapped labels');
  assert.doesNotThrow(run([{ value: 0, label: 'none', probability: 0.02 }, { value: 1, label: 'minor', probability: 0.03 }, { value: 2, label: 'severe', probability: 0.95 }]));
});
