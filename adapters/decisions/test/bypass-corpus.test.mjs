// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Decision-adapter bypass corpus (CAIO, 2026-11-08). Each attack tries to turn a typed answer into "act" when it
// shouldn't; it must end anywhere but act (or be malformed). Each guard is a legitimate answer that must still act,
// so a fix can't pass by refusing everything. Run before the provider-label fix, "provider-label" acted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as D from '../src/decisions.mjs';

const now = Date.parse('2026-11-07T04:00:00Z');
const calibration = { dataset: 'd', accuracy_at_threshold: 0.97, measured_at: '2026-11-01T00:00:00Z' };
const pin = [{ provider: 'fastino', model: 'fastino/GLiDE' }, { provider: 'openai', model: 'gpt-6-luna' }];
const policy = D.compileDecisionPolicy({ decisions: { q: { allowed: ['eligible'], act_at: 0.9, min_margin: 0.5, pin, calibration, operations: { eligible: 'billing.refund' } } } });
const consensus = D.compileDecisionPolicy({ decisions: { q: { allowed: ['eligible'], act_at: 0.9, consensus: { models: ['fastino/GLiDE', 'jev-1.13.0'], require: 'all', max_divergence: 0.1 } } } });
const sys = (criteria, answer, { model = 'fastino/GLiDE', echo, provider = 'fastino' } = {}) => D.normalizeSystemone({ provider,
  request: { model, questions: { q: { type: 'choice', criteria } } }, response: { ...(echo ? { model: echo } : {}), answers: { q: { type: 'choice', confidence: 0.95, ...answer } } } });
const oai = (choices, answer, { model = 'gpt-6-luna', provider = 'openai' } = {}) => D.normalizeDecisions({ provider,
  request: { model, questions: [{ type: 'choice', name: 'q', choices }] }, response: { answers: [{ type: 'choice', name: 'q', confidence: 0.95, ...answer }] } });
const C2 = { eligible: 'a', ineligible: 'b' }, P = (e, i) => ({ eligible: e, ineligible: i });
const OC = [{ value: 'eligible' }, { value: 'ineligible' }], OP = (e, i) => [{ value: 'eligible', probability: e }, { value: 'ineligible', probability: i }];
const outcome = (records, pol = policy) => D.route(pol, 'q', records, { now }).outcome;

const ATTACKS = {
  'NaN in a probability': () => sys(C2, { choice: 'eligible', probabilities: P(1, NaN) }),
  'probabilities as strings': () => sys(C2, { choice: 'eligible', probabilities: P('0.99', '0.01') }),
  'Infinity as a probability': () => sys(C2, { choice: 'eligible', probabilities: P(Infinity, 0) }),
  'a tie at the top': () => sys(C2, { choice: 'eligible', probabilities: P(0.5, 0.5) }),
  'a pinned model name only in the response echo': () => sys(C2, { choice: 'eligible', probabilities: P(0.99, 0.01) }, { model: 'fastino/GLiDE-unpinned', echo: 'fastino/GLiDE' }),
  'a lookalike option (capital I for l)': () => sys({ eIigible: 'a', ineligible: 'b' }, { choice: 'eIigible', probabilities: { eIigible: 0.99, ineligible: 0.01 } }),
  'a case variant of the option': () => sys({ Eligible: 'a', ineligible: 'b' }, { choice: 'Eligible', probabilities: { Eligible: 0.99, ineligible: 0.01 } }),
  'a trailing space in the option': () => sys({ 'eligible ': 'a', ineligible: 'b' }, { choice: 'eligible ', probabilities: { 'eligible ': 0.99, ineligible: 0.01 } }),
  'a choice that was never requested': () => sys({ ineligible: 'b', other: 'c' }, { choice: 'eligible', probabilities: { eligible: 0.99, ineligible: 0.01, other: 0 } }),
  'provider-label: an OpenAI-shaped answer labeled as Fastino': () => oai(OC, { choice: 'eligible', probabilities: OP(0.99, 0.01) }, { provider: 'fastino', model: 'fastino/GLiDE' }),
  'OpenAI choice with no probabilities': () => oai(OC, { choice: 'eligible' }),
  'OpenAI probabilities for only one option': () => oai(OC, { choice: 'eligible', probabilities: [{ value: 'eligible', probability: 0.99 }] }),
  'a refusal and an answer under one question name': () => D.normalizeDecisions({ provider: 'openai', request: { model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'q', choices: OC }, { type: 'choice', name: 'q', choices: OC }] },
    response: { answers: [{ type: 'refusal', name: 'q' }, { type: 'choice', name: 'q', choice: 'eligible', confidence: 0.99, probabilities: OP(0.99, 0.01) }] } }),
  'one model counted twice under two provider labels': () => [...sys(C2, { choice: 'eligible', probabilities: P(0.99, 0.01) }), ...sys(C2, { choice: 'eligible', probabilities: P(0.99, 0.01) }, { provider: 'typesafe' })],
};
const GUARDS = {
  'a sum inside the 0.01 tolerance': () => sys(C2, { choice: 'eligible', probabilities: P(1, 0.009) }),
  'an option named __proto__': () => sys(JSON.parse('{"eligible":"a","__proto__":"x"}'), { choice: 'eligible', probabilities: JSON.parse('{"eligible":0.99,"__proto__":0.01}') }),
  'an option named hasOwnProperty': () => sys({ eligible: 'a', hasOwnProperty: 'b' }, { choice: 'eligible', probabilities: { eligible: 0.99, hasOwnProperty: 0.01 } }),
  'a negative zero for the other option': () => sys(C2, { choice: 'eligible', probabilities: P(1, -0) }),
  'a boolean choice declared next to a string one': () => oai([{ value: true }, { value: 'eligible' }], { choice: 'eligible', probabilities: [{ value: 'eligible', probability: 0.99 }, { value: true, probability: 0.01 }] }),
  'a plain OpenAI answer': () => oai(OC, { choice: 'eligible', probabilities: OP(0.99, 0.01) }),
};

for (const [name, make] of Object.entries(ATTACKS)) test(`attack never acts: ${name}`, () => {
  const pol = name.startsWith('one model counted twice') ? consensus : policy;
  let got; try { got = outcome(make(), pol); } catch (e) { assert.match(e.message, /^malformed: /); return; }
  assert.notEqual(got, 'act', name);
});
for (const [name, make] of Object.entries(GUARDS)) test(`guard still acts: ${name}`, () => assert.equal(outcome(make()), 'act', name));
test('the provider-label fix names the right parser', () => {
  assert.throws(ATTACKS['provider-label: an OpenAI-shaped answer labeled as Fastino'], /fastino answers in the systemone shape; use normalizeSystemone/);
});
