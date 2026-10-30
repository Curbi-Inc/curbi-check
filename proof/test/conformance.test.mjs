// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Conformance suite for any Curbi Proof 0.1 verifier: every published vector must give its documented result.
// Standalone: needs only src/proof.mjs and vectors/, so it ships inside the downloadable verifier package.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyBundle, importKeys } from '../src/proof.mjs';
const V = JSON.parse(readFileSync(new URL('../vectors/cases.json', import.meta.url), 'utf8'));
const optionsFor = c => { const { keys, ...o } = c.options; return { ...o, keys: keys === undefined ? V.keys : keys ?? undefined }; };

for (const c of V.cases) test(`vector ${c.id}: ${c.description}`, async () => {
  const r = await verifyBundle(c.bundle, optionsFor(c)), e = c.expect;
  assert.equal(r.ok, e.ok, JSON.stringify({ reason: r.reason, items: r.items.map(i => i.reason), forks: r.history.forks.map(f => f.reason), checked: r.history.checked }));
  if (e.reason) assert.equal(r.reason, e.reason);
  if (e.verified !== undefined) assert.equal(r.summary.verified, e.verified);
  if (e.appendOnly !== undefined) assert.equal(r.history.appendOnly, e.appendOnly);
  for (const [i, reason] of Object.entries(e.items || {})) assert.equal(r.items[i].reason, reason, 'item ' + i);
  for (const [i, row] of r.items.entries()) if (!(i in (e.items || {})) && e.items) assert.equal(row.ok, true, 'item ' + i + ' should still verify');
  if (e.forks) { assert.deepEqual(r.history.forks.map(f => f.reason), e.forks); for (const f of r.history.forks) assert.ok(f.a.startsWith('curbi1.') && f.b.startsWith('curbi1.'), 'fork evidence is both signed heads'); }
});

test('the valid bundle covers four unrelated mutations, each bound to its attestation and agent', async () => {
  const r = await verifyBundle(V.cases[0].bundle, { keys: V.keys, allowTest: true });
  assert.deepEqual(r.items.map(i => [i.op, i.resource, i.agent_id, i.attested]), [
    ['billing.refund', 'charge:ch_1001', 'agent:support', true], ['calendar.book', 'slot:2026-11-03T15:00Z/dr-lee', 'agent:reception', true],
    ['dispatch.create', 'job:hvac-4411', 'agent:ops', true], ['access.unlock', 'space:hq/floor-3/door-2', 'agent:concierge', true]]);
  assert.equal(r.items[0].amount_minor, 5000); assert.equal(r.checkpoint.size, 4); assert.equal(r.keysFrom, 'caller');
  assert.equal(V.held.state, 'UNKNOWN'); assert.ok(!JSON.stringify(V.cases[0].bundle).includes(V.held.idempotency_key), 'held outcome never logged');
});

test('a bundle may carry keys, but they are a demo convenience, never a silent trust anchor', async () => {
  const r = await verifyBundle(V.cases[0].bundle, { trustBundleKeys: true, allowTest: true });
  assert.equal(r.ok, true); assert.equal(r.keysFrom, 'bundle');
  const forged = structuredClone(V.cases.find(c => c.id === 'checkpoint-unknown-key').bundle);
  assert.equal((await verifyBundle(forged, { keys: V.keys, allowTest: true })).reason, 'checkpoint_unknown_key');
});

test('hostile input never throws and always carries a typed reason', async () => {
  const valid = V.cases[0].bundle;
  for (const b of [null, 1, 'x', [], {}, { object: 'curbi.proof.bundle' }, { ...valid, spec: 'curbi.proof/9' }, { ...valid, checkpoint: 'curbi1.' + 'A'.repeat(5000) }, { ...valid, items: Array(300).fill(valid.items[0]) },
    { ...valid, items: [{ receipt: valid.items[0].receipt, inclusion: { index: 0, path: ['@@'] } }] }, { ...valid, items: [{ receipt: valid.items[0].receipt }] }, { ...valid, history: [{}] }, { ...valid, items: [null] }]) {
    const r = await verifyBundle(b, { keys: V.keys, allowTest: true });
    assert.equal(r.ok, false); assert.equal(typeof (r.reason || r.items.find(i => i.reason)?.reason), 'string');
  }
  const { skipped } = await importKeys({ keys: [{ ...V.keys.keys[0], d: 'AAAA' }, { kty: 'RSA' }] }, { allowTest: true });
  assert.deepEqual(skipped.map(s => s.reason), ['private_key_refused', 'malformed_key']);
});
