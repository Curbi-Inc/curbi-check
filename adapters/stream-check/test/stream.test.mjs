// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createStreamChecker } from '../src/stream.mjs';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');
const FALLBACK = 'I need to transfer you to a manager to approve that rate.';
const corpus = JSON.parse(readFileSync(new URL('../../../test/fixtures/corpus.v1.json', import.meta.url)));
// Deterministic pseudo-random chunking (seeded), so failures reproduce exactly.
const rng = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const chunks = (text, rand) => { const out = []; for (let i = 0; i < text.length;) { const n = 1 + Math.floor(rand() * 7); out.push(text.slice(i, i + n)); i += n; } return out; };
function stream(policy, reply, rand, record) {
  const s = createStreamChecker({ policy, record, fallback: FALLBACK }), released = [];
  let cut = null;
  for (const c of chunks(reply, rand)) { const r = s.push(c); released.push(...r.release); if (r.cut) { cut = r.cut; break; } }
  if (!cut) { const r = s.end(); released.push(...r.release); cut = r.cut; }
  return { spoken: released.join(''), cut };
}

const cases = corpus.cases.filter(c => c.expect.status === 200 && c.browser === 'same' && typeof c.request.reply === 'string' && c.request.reply.trim() && !c.request.verify)
  .map(c => ({ id: c.id, policy: typeof c.request.policy === 'string' ? corpus.policies[c.request.policy.slice(1)] : c.request.policy, reply: c.request.reply, record: c.request.record }));

test(`streaming = batch on ${cases.length} corpus replies × 30 random chunkings: cut iff batch fails, and nothing that fails is ever spoken`, () => {
  let runs = 0;
  for (const c of cases) {
    const batch = runCheck({ policy: c.policy, reply: c.reply, ...(c.record ? { record: c.record } : {}) });
    for (let seed = 1; seed <= 30; seed++) {
      const { spoken, cut } = stream(c.policy, c.reply, rng(seed * 7919), c.record); runs++;
      if (batch.pass) { assert.equal(cut, null, `${c.id}#${seed} cut a passing reply: ${JSON.stringify(cut?.finding)}`); assert.equal(spoken, c.reply, c.id); }
      else {
        assert.ok(cut, `${c.id}#${seed} failing reply was never cut`);
        for (const f of batch.findings) assert.ok(spoken.length <= f.span[0] || f.rule === 'empty', `${c.id}#${seed} spoke "${spoken}" past finding ${f.rule}@${f.span}`);
        assert.ok(c.reply.startsWith(spoken), c.id);
      }
    }
  }
  assert.equal(runs, cases.length * 30);
});

test('early cut: a forbidden promise stops the stream mid-sentence, before the sentence is released', () => {
  const s = createStreamChecker({ policy: { forbid: [{ id: 'guarantee', phrases: ['guarantee'] }] }, fallback: FALLBACK });
  assert.deepEqual(s.push('Thanks for calling. '), { release: ['Thanks for calling.'], cut: null });
  assert.equal(s.push('We guar').cut, null);                                   // incomplete word: wait
  const r = s.push('antee your rate is locked');                              // no sentence end yet
  assert.equal(r.cut.finding.rule, 'forbid:guarantee'); assert.equal(r.cut.fallback, FALLBACK);
  assert.equal(s.spoken, 'Thanks for calling.');
});
test('decimals are not sentence ends: "$49." then "50" is $49.50, not a released "$49."', () => {
  const s = createStreamChecker({ policy: { prices: [{ item: 'Pro', amount: 49.5 }] }, fallback: FALLBACK });
  assert.deepEqual(s.push('Pro is $49.').release, []); assert.deepEqual(s.push('50. ').release, ['Pro is $49.50.']);
});
test('a wrong price is caught at sentence end; the earlier correct sentence is still spoken', () => {
  const s = createStreamChecker({ policy: { prices: [{ item: 'Pro', amount: 49 }] }, fallback: FALLBACK });
  s.push('Pro is $49 a month. '); const r = s.push('For you, Pro is $39. ');
  assert.equal(r.cut.finding.rule, 'price:mismatch'); assert.equal(s.spoken, 'Pro is $49 a month.');
});
test('after a cut, the stream stays closed', () => {
  const s = createStreamChecker({ policy: { actions: { booked: 'calendar.book' } }, fallback: FALLBACK });
  assert.ok(s.push("I've booked you ").cut); assert.ok(s.push('for Monday. All set. ').cut); assert.equal(s.spoken, '');
});
test('requires an approved fallback line and a valid policy', () => {
  assert.throws(() => createStreamChecker({ policy: {} }));
  assert.throws(() => createStreamChecker({ policy: { forbids: [] }, fallback: FALLBACK }));
});
test('overlong streams cut instead of growing without bound', () => {
  const s = createStreamChecker({ policy: {}, fallback: FALLBACK, maxChars: 50 });
  assert.equal(s.push('a'.repeat(60)).cut.finding.rule, 'stream:too_long');
});
test('a chunk boundary inside a word never triggers a cut: "refund" + "able" is "refundable"', () => {
  const s = createStreamChecker({ policy: { forbid: [{ id: 'refund-promise', phrases: ['refund'] }] }, fallback: FALLBACK });
  assert.equal(s.push('This plan is refund').cut, null);
  const r = s.push('able within 30 days. '); assert.equal(r.cut, null); assert.deepEqual(r.release, ['This plan is refundable within 30 days.']);
});

