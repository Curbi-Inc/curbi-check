// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Raw-byte binding (CTO re-review 6718432732: "raw responseBytes can disagree with the separately supplied parsed
// response; native JSON.parse can erase duplicate members"). When bytes are given, they are what gets parsed, checked
// and digested; a disagreeing object, a duplicate member, invalid UTF-8, a BOM or a lone surrogate is malformed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { normalizeSystemone, normalizeDecisions, compileDecisionPolicy, route } from '../src/decisions.mjs';

const enc = s => new TextEncoder().encode(s);
const sha = b => 'sha256:' + createHash('sha256').update(b).digest('hex');
const now = Date.parse('2026-11-07T04:00:00Z');
const request = { model: 'gpt-6-luna', questions: [{ type: 'choice', name: 'q', choices: [{ value: 'allow' }, { value: 'deny' }] }] };
const acting = { type: 'choice', name: 'q', choice: 'allow', confidence: 0.95, probabilities: [{ value: 'allow', probability: 0.97 }, { value: 'deny', probability: 0.03 }] };
const policy = compileDecisionPolicy({ decisions: { q: { allowed: ['allow', 'deny'], act_at: 0.9 } } });
const norm = args => normalizeDecisions({ provider: 'openai', request, ...args });

test('bytes alone are parsed and digested; the record says it is byte-bound', () => {
  const bytes = enc(JSON.stringify({ answers: [acting] }));
  const [r] = norm({ responseBytes: bytes });
  assert.equal(r.response_digest, sha(bytes)); assert.deepEqual(r.bytes_bound, { request: false, response: true });
  assert.equal(route(policy, 'q', [r], { now }).outcome, 'act');
});

test('bytes and a matching object agree; without bytes the record says it is object-bound', () => {
  const res = { answers: [acting] };
  assert.equal(norm({ response: res, responseBytes: enc(JSON.stringify(res, null, 2)) })[0].selected, 'allow');
  assert.deepEqual(norm({ response: res })[0].bytes_bound, { request: false, response: false });
});

test('bytes that disagree with the supplied object are malformed', () => {
  const refused = enc(JSON.stringify({ answers: [{ type: 'refusal', name: 'q' }] }));
  assert.throws(() => norm({ response: { answers: [acting] }, responseBytes: refused }), /responseBytes and response disagree/);
  const reqBytes = enc(JSON.stringify({ ...request, model: 'other-model' }));
  assert.throws(() => norm({ requestBytes: reqBytes, response: { answers: [acting] } }), /requestBytes and request disagree/);
});

test('a duplicate member cannot hide a refusal, at any depth or spelling', () => {
  const dupAnswer = '{"answers":[{"type":"refusal","name":"q","type":"choice","choice":"allow","confidence":0.95,"probabilities":[{"value":"allow","probability":0.97},{"value":"deny","probability":0.03}]}]}';
  assert.throws(() => norm({ responseBytes: enc(dupAnswer) }), /duplicate member "type"/);
  const escaped = '{"answers":[],"\\u0061nswers":[]}';
  assert.throws(() => norm({ responseBytes: enc(escaped) }), /duplicate member "answers"/);
  const sys = '{"answers":{"q":{"type":"refusal"},"q":{"type":"noul","noul":0.99,"confidence":0.99}}}';
  assert.throws(() => normalizeSystemone({ provider: 'fastino', request: { model: 'm', questions: { q: { type: 'noul' } } }, responseBytes: enc(sys) }), /duplicate member "q"/);
});

test('strings with quotes, braces and backslashes do not confuse the duplicate scan', () => {
  const tricky = { answers: [{ ...acting, name: 'q' }], note: 'a"}{"answers":[]\\' };
  const [r] = norm({ responseBytes: enc(JSON.stringify(tricky)) });
  assert.equal(r.selected, 'allow');
});

test('invalid UTF-8, a BOM, a lone surrogate, a string, or non-JSON is malformed', () => {
  const good = JSON.stringify({ answers: [acting] });
  assert.throws(() => norm({ responseBytes: Uint8Array.from([...enc(good.slice(0, -2)), 0xff, 0x7d, 0x5d]) }), /not valid UTF-8/);
  assert.throws(() => norm({ responseBytes: enc('﻿' + good) }), /not JSON/);
  assert.throws(() => norm({ responseBytes: enc(good.replace('"q"', '"\\ud800"')) }), /lone surrogate/);
  assert.throws(() => norm({ responseBytes: good }), /a Uint8Array/);
  assert.throws(() => norm({ responseBytes: enc('{"answers": [') }), /not JSON/);
});
