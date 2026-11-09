// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Timestamp boundaries (CTO review 6727923670): a key expiry that isn't a date, revocation data from the future, an
// expiry exactly at "now" and loosely formatted times must never yield "verified".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import { compileInputPolicy, compileRegistry, contextCheck, memoryNonces, digest, digestBytes, signingPayload } from '../src/input-gate.mjs';

const NOW = Date.parse('2026-11-08T20:00:00Z');
const SCOPE = digest({ tenant: 't1' });
const kp = generateKeyPairSync('ed25519'), pem = kp.publicKey.export({ type: 'spki', format: 'pem' });
const POLICY = compileInputPolicy({ version: 1 });
const reg = (key = {}, over = {}) => compileRegistry({ version: 1, revocation_checked_at: '2026-11-08T19:58:00Z',
  ed25519: [{ kid: 'k', public_key_pem: pem, classes: ['tool'], not_after: '2026-12-01T00:00:00Z', ...key }], ...over });
let n = 0;
const item = (issued = '2026-11-08T19:59:30Z') => {
  const bytes = '{"ok":true}', env = { type: 'ed25519', kid: 'k', scope_digest: SCOPE, nonce: `n${++n}`, issued_at: issued };
  env.signature = edSign(null, signingPayload(digestBytes(Buffer.from(bytes)), 'tool', env), kp.privateKey).toString('base64url');
  return { class: 'tool', bytes, envelope: env };
};
const check = (r, it = item(), now = NOW) => contextCheck(it, POLICY, r, { scope_digest: SCOPE, now, nonces: memoryNonces(), state: null, grant: null, index: null, policy: POLICY });

test('control: a well-formed registry and item verify', () => assert.equal(check(reg()).provenance.result, 'verified'));

test('a key expiry that is not a date, or is missing, is refused when the registry compiles', () => {
  for (const not_after of ['not-a-date', '', '2026-13-01T00:00:00Z', 1767225600000, null])
    assert.throws(() => reg({ not_after }), /bad_registry/, String(not_after));
  assert.throws(() => compileRegistry({ version: 1, revocation_checked_at: '2026-11-08T19:58:00Z', ed25519: [{ kid: 'k', public_key_pem: pem }] }), /not_after/);
});

test('a key is expired at its not_after instant, not only after it', () => {
  assert.equal(check(reg({ not_after: '2026-11-08T20:00:00Z' })).reasons[0], 'provenance:expired_key');
  assert.equal(check(reg({ not_after: '2026-11-08T20:00:00.001Z' })).provenance.result, 'verified');
});

test('revocation data from the future is never fresh', () => {
  const r = check(reg({}, { revocation_checked_at: '2099-01-01T00:00:00Z' }));
  assert.deepEqual([r.provenance.result, r.provenance.fresh, r.verdict, r.reasons[0]], ['unconfirmed', false, 'unconfirmed', 'provenance:revocation_data_from_future']);
  assert.equal(check(reg({}, { revocation_checked_at: '2026-11-08T20:00:01Z' })).reasons[0], 'provenance:revocation_data_from_future');
});

test('registry and envelope times must be strict ISO 8601 UTC', () => {
  for (const t of ['Nov 8 2026', '2026-11-08', '2026-11-08T19:58:00', '2026-11-08T19:58:00+00:00', '2026-11-08 19:58:00Z'])
    assert.throws(() => reg({}, { revocation_checked_at: t }), /bad_registry/, t);
  for (const t of ['Nov 8 2026 19:59:30 UTC', '2026-11-08T19:59:30+00:00', 'not-a-date'])
    assert.equal(check(reg(), item(t)).reasons[0], 'provenance:bad_issued_at', t);
});

test('a "now" that is not a finite number is refused', () => {
  for (const now of [NaN, Infinity, undefined, '2026-11-08T20:00:00Z'])
    assert.throws(() => contextCheck(item(), POLICY, reg(), { scope_digest: SCOPE, now, nonces: memoryNonces(), state: null, grant: null, index: null, policy: POLICY }), /bad_now/, String(now));
});
