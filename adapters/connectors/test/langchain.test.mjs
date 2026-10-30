// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Runs real LangChain (@langchain/core@1.2.17) with its own fake chat model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { curbiGuard } from '../src/langchain.mjs';
const FALLBACK = 'A teammate will confirm that for you.';
const policy = { prices: [{ item: 'Pro', amount: 49 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { booked: 'calendar.book' } };
const chain = responses => new FakeListChatModel({ responses }).pipe(curbiGuard({ policy, fallback: FALLBACK }));

test('model.pipe(curbiGuard): clean replies pass through', async () => {
  const m = await chain(['Pro is $49 a month.']).invoke('price?');
  assert.equal(m.content, 'Pro is $49 a month.'); assert.equal(m.response_metadata.curbi.pass, true);
});
test('a promise, a wrong price and an unrecorded booking are each replaced by the fallback', async () => {
  for (const [reply, rule] of [['We guarantee results.', 'forbid:guarantee'], ['Pro is $39.', 'price:mismatch'], ["You're booked for Monday.", 'action:unrecorded']]) {
    const m = await chain([reply]).invoke('x');
    assert.equal(m.content, FALLBACK, reply); assert.deepEqual(m.response_metadata.curbi.findings.map(f => f.rule), [rule]);
  }
});
test('a recorded booking passes when the record is supplied', async () => {
  const guard = curbiGuard({ policy, fallback: FALLBACK, record: { effects: [{ operation: 'calendar.book', status: 'DONE' }] } });
  const m = await new FakeListChatModel({ responses: ["You're booked for Monday."] }).pipe(guard).invoke('x');
  assert.equal(m.content, "You're booked for Monday."); assert.equal(m.response_metadata.curbi.recordTrust, 'caller_supplied_unverified');
});
test('works on plain strings too (e.g. after a StringOutputParser)', async () => {
  assert.equal(await curbiGuard({ policy, fallback: FALLBACK }).invoke('We guarantee it.'), FALLBACK);
});

