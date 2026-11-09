// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Admission binding (CTO re-review 6747192975). Three reproduced cases, plus the exact-request binding:
//   1. a caller edited a turn (a check flipped to verified, digests recomputed) and admitProposal admitted it;
//   2. compileRegistry gave the same digest after a pinned key was flipped to revoked;
//   3. a turn whose disposition was hand_off was admitted at dispatch.
// Admission now reads the turn only from the host-held turn log that gateTurn wrote, refuses a caller-supplied turn,
// requires the exact request bytes the manifest committed to, and enforces the manifest's disposition.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as edSign } from 'node:crypto';
import * as G from '../src/input-gate.mjs';
const { compileInputPolicy, compileRegistry, gateTurn, admitProposal, memoryNonces, memoryTurns, memoryTurnLog, digest, digestBytes, signingPayload } = G;

const NOW = Date.parse('2026-11-09T18:00:00Z');
const SCOPE = digest({ tenant: 't1' });
const kp = generateKeyPairSync('ed25519'), other = generateKeyPairSync('ed25519');
const pem = k => k.publicKey.export({ type: 'spki', format: 'pem' });
const key = (o = {}) => ({ kid: 'read', public_key_pem: pem(kp), classes: ['tool'], not_after: '2026-12-31T00:00:00Z', ...o });
const REGI = (o = {}) => ({ version: 1, revocation_checked_at: '2026-11-09T17:59:00Z', ed25519: [key()], hmac: [{ id: 'we_1', secret: 'whsec_0123456789abcdef' }], ...o });
const REG = compileRegistry(REGI());
const POLICY = compileInputPolicy({ version: 1, classes: { retrieval: 'hand-off' } });
const GRANT = { scope_digest: SCOPE, operations: ['billing.refund'], resources: ['ch_AAAA1111'], currency: 'usd', max_amount_minor: 100, expires_at: '2026-11-09T19:00:00Z' };
const REQUEST = '{"model":"m","messages":[{"role":"user","content":"refund my last charge"}]}';
let n = 0;
const toolObs = () => {
  const bytes = JSON.stringify({ observation: { operation: 'billing.refund', resource: 'ch_AAAA1111', currency: 'usd', max_amount_minor: 500 } });
  const env = { type: 'ed25519', kid: 'read', scope_digest: SCOPE, nonce: `n${++n}`, issued_at: '2026-11-09T17:59:30Z' };
  env.signature = edSign(null, signingPayload(digestBytes(Buffer.from(bytes)), 'tool', env), kp.privateKey).toString('base64url');
  return { class: 'tool', bytes, envelope: env };
};
const proposal = (o = {}) => ({ turn_id: 't-1', operation_id: 'op-1', operation: 'billing.refund', resource: 'ch_AAAA1111', amount_minor: 50, currency: 'usd', ...o });
const setup = (items, { request = REQUEST } = {}) => {
  const turnLog = memoryTurnLog();
  const turn = gateTurn({ items, policy: POLICY, registry: REG, ctx: { turn_id: 't-1', scope_digest: SCOPE, now: NOW, nonces: memoryNonces(), grant: GRANT, turnLog, request_bytes: request } });
  const admit = (p = proposal(), o = {}) => admitProposal({ proposal: p, grant: GRANT, policy: POLICY, registry: REG, ...o,
    ctx: { now: NOW + 1000, turns: memoryTurns(), turnLog, request_bytes: REQUEST, ...(o.ctx ?? {}) } });
  return { turn, turnLog, admit };
};

test('control: a verified tool observation with the exact request is admitted', () => {
  assert.equal(setup([toolObs()]).admit().verdict, 'admit');
});

test('1. an edited turn has no effect: admission reads only the host-held turn log', () => {
  const { turn, admit } = setup([{ class: 'user', bytes: 'refund ch_AAAA1111 for 50 cents' }]);
  const forged = structuredClone(turn);
  forged.checks[0].verdict = 'verified';
  forged.checks[0].observation = { operation: 'billing.refund', resource: 'ch_AAAA1111', currency: 'usd', max_amount_minor: 500 };
  const { digest: _, ...rec } = forged.checks[0]; forged.checks[0].digest = digest(rec);
  forged.manifest.context_check_digests = [forged.checks[0].digest]; forged.manifest_digest = digest(forged.manifest);
  assert.throws(() => admit(proposal(), { turn: forged }), /caller_supplied_turn/);
  turn.checks[0].verdict = 'verified';   // editing the returned copy doesn't reach the log either
  assert.deepEqual(admit().reasons, ['tuple_provenance_unverified']);
});

test('1. an unknown turn, or a turn id used twice at gating, is refused', () => {
  const { admit, turnLog } = setup([toolObs()]);
  assert.deepEqual(admit(proposal({ turn_id: 't-2' })).reasons, ['turn_unknown']);
  assert.throws(() => gateTurn({ items: [], policy: POLICY, registry: REG, ctx: { turn_id: 't-1', scope_digest: SCOPE, now: NOW, nonces: memoryNonces(), turnLog, request_bytes: REQUEST } }), /turn_reused/);
});

test('1. admission is bound to the exact request bytes the manifest committed to', () => {
  const { admit } = setup([toolObs()]);
  assert.deepEqual(admit(proposal(), { ctx: { request_bytes: REQUEST + ' ' } }).reasons, ['request_mismatch']);
  assert.deepEqual(admit(proposal(), { ctx: { request_bytes: undefined } }).reasons, ['request_unbound']);
  assert.throws(() => setup([toolObs()], { request: null }), /request_bytes/);
});

test('2. the registry digest changes with every field of the key policy', () => {
  const base = REG.digest;
  const variants = {
    'revoked': REGI({ ed25519: [key({ revoked: true })] }),
    'classes': REGI({ ed25519: [key({ classes: ['tool', 'state'] })] }),
    'not_after': REGI({ ed25519: [key({ not_after: '2026-12-30T00:00:00Z' })] }),
    'kid-to-key': REGI({ ed25519: [key({ public_key_pem: pem(other) })] }),
    'kid': REGI({ ed25519: [key({ kid: 'read2' })] }),
    'hmac revoked': REGI({ hmac: [{ id: 'we_1', secret: 'whsec_0123456789abcdef', revoked: true }] }),
    'hmac secret': REGI({ hmac: [{ id: 'we_1', secret: 'whsec_fedcba9876543210' }] }),
    'hmac classes': REGI({ hmac: [{ id: 'we_1', secret: 'whsec_0123456789abcdef', classes: ['tool', 'state'] }] }),
    'revocation time': REGI({ revocation_checked_at: '2026-11-09T17:58:00Z' }),
  };
  for (const [name, r] of Object.entries(variants)) assert.notEqual(compileRegistry(r).digest, base, name);
  assert.equal(compileRegistry(REGI()).digest, base, 'same input, same digest');
  assert.doesNotMatch(JSON.stringify(REG), /whsec_0123456789abcdef/, 'the registry object keeps no plain secret in its digest material');
});

test('2. a manifest made under one registry is not admitted under a registry that revoked the key', () => {
  const { admit } = setup([toolObs()]);
  const revoked = compileRegistry(REGI({ ed25519: [key({ revoked: true })] }));
  assert.ok(admit(proposal(), { registry: revoked }).reasons.includes('policy_or_registry_mismatch'));
});

test('3. the turn disposition is in the manifest and enforced at dispatch', () => {
  const { turn, admit } = setup([toolObs(), { class: 'retrieval', bytes: 'a document' }]);
  assert.equal(turn.disposition, 'hand_off'); assert.equal(turn.manifest.disposition, 'hand_off');
  assert.deepEqual(admit().reasons, ['turn_disposition_hand_off']);
  const blocked = setup([toolObs(), { class: 'tool', bytes: 'x', envelope: { type: 'ed25519', kid: 'read', public_key_pem: 'x' } }]);
  assert.ok(blocked.admit().reasons.includes('turn_disposition_block'));
});

test('defense in depth: a tampered turn log record is caught by the recomputed digests', () => {
  const { turnLog } = setup([{ class: 'user', bytes: 'refund ch_AAAA1111' }]);
  const stored = turnLog.get('t-1');
  const tamper = f => { const t = structuredClone(stored); f(t); return { get: () => structuredClone(t), put: () => {} }; };
  const run = log => admitProposal({ proposal: proposal(), grant: GRANT, policy: POLICY, registry: REG, ctx: { now: NOW + 1000, turns: memoryTurns(), turnLog: log, request_bytes: REQUEST } }).reasons;
  const flip = t => { t.checks[0].verdict = 'verified'; t.checks[0].observation = { operation: 'billing.refund', resource: 'ch_AAAA1111', currency: 'usd', max_amount_minor: 500 }; };
  assert.ok(run(tamper(flip)).includes('context_check_digest_mismatch'));
  assert.ok(run(tamper(t => { flip(t); const { digest: _, ...r } = t.checks[0]; t.checks[0].digest = digest(r); })).includes('manifest_checks_mismatch'));
  assert.ok(run(tamper(t => { flip(t); const { digest: _, ...r } = t.checks[0]; t.checks[0].digest = digest(r); t.manifest.context_check_digests = [t.checks[0].digest]; })).includes('manifest_digest_mismatch'));
});

test('the in-memory turn log hands out copies: editing what it returns changes nothing', () => {
  const { turnLog, admit } = setup([{ class: 'user', bytes: 'refund ch_AAAA1111' }]);
  const got = turnLog.get('t-1');
  got.checks[0].verdict = 'verified'; got.checks[0].observation = { operation: 'billing.refund', resource: 'ch_AAAA1111', currency: 'usd', max_amount_minor: 500 };
  got.manifest.disposition = 'proceed_labeled';
  assert.equal(turnLog.get('t-1').checks[0].verdict, 'unconfirmed');
  assert.deepEqual(admit().reasons, ['tuple_provenance_unverified']);
});
