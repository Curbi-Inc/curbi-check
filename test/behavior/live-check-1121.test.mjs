// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Live systems check (2026-11-21): action claims that passed silently on the production checker through the Curbi MCP
// connector, then reproduced on this source. Present-tense passive claims ("Your subscription is now cancelled") and
// UK/US spellings of a policy verb ("canceled" for "cancelled"). Honest, negated, conditional and rule-describing
// sentences must keep passing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');

const rules = (policy, reply, effects = []) => runCheck({ policy, reply, record: { effects } }).findings.map(f => f.rule);
const UK = { actions: { refunded: 'billing.refund', cancelled: 'billing.cancel' } };
const US = { actions: { refunded: 'billing.refund', canceled: 'billing.cancel' } };

test('present-tense passive completion claims need the operation DONE', () => {
  for (const reply of [
    'Your subscription is now cancelled.',
    'Your subscription is cancelled.',
    'Your order is now refunded.',
    'Your subscription is now cancelled, so you will not be billed again.',
    'Your subscription is already cancelled.',
    'Both of your orders are now refunded.',
    'It is now cancelled.',
  ]) assert.deepEqual(rules(UK, reply), ['action:unrecorded'], reply);
  // With the operation on record the same claims pass.
  assert.deepEqual(rules(UK, 'Your subscription is now cancelled.', [{ operation: 'billing.cancel', status: 'DONE' }]), []);
  assert.deepEqual(rules(UK, 'Your order is now refunded.', [{ operation: 'billing.refund', status: 'DONE' }]), []);
});

test('negated, conditional, question and rule-describing present-tense sentences still pass', () => {
  for (const reply of [
    'Your subscription is not cancelled yet.',
    'Your subscription is not cancelled.',
    'Once your subscription is cancelled, you will get an email.',
    'If your subscription is cancelled, you will get an email.',
    'When your order is refunded, we email you.',
    'Your subscription is cancelled when a payment fails twice.',
    'Your subscription is cancelled automatically if payment fails.',
    'Is your subscription cancelled?',
    'Your subscription is cancelled?',
    'Your order is refunded within 5 days of the return arriving.',
  ]) assert.deepEqual(rules(UK, reply), [], reply);
});

test('UK and US spellings of a policy verb are the same claim', () => {
  for (const [policy, reply] of [
    [UK, 'I canceled your subscription.'],
    [UK, 'Your account has been canceled.'],
    [UK, 'I have canceled it.'],
    [US, 'I cancelled your subscription.'],
    [US, 'Your account has been cancelled.'],
    [US, 'Your subscription is now cancelled.'],
  ]) assert.deepEqual(rules(policy, reply), ['action:unrecorded'], reply);
  // Either spelling on record satisfies the claim, because both map to the policy's one operation.
  assert.deepEqual(rules(UK, 'I canceled your subscription.', [{ operation: 'billing.cancel', status: 'DONE' }]), []);
  assert.deepEqual(rules(US, 'I cancelled your subscription.', [{ operation: 'billing.cancel', status: 'DONE' }]), []);
  // Honest negations in either spelling still pass.
  assert.deepEqual(rules(UK, "I haven't canceled your subscription."), []);
  assert.deepEqual(rules(US, 'I could not cancel your subscription.'), []);
  // A spelling the policy lists itself keeps its own operation; the twin never overrides it.
  const both = { actions: { cancelled: 'billing.cancel', canceled: 'legacy.cancel' } };
  assert.deepEqual(rules(both, 'I canceled your subscription.', [{ operation: 'billing.cancel', status: 'DONE' }]), ['action:unrecorded']);
  assert.deepEqual(rules(both, 'I canceled your subscription.', [{ operation: 'legacy.cancel', status: 'DONE' }]), []);
  const reversed = { actions: { canceled: 'legacy.cancel', cancelled: 'billing.cancel' } };
  assert.deepEqual(rules(reversed, 'I canceled your subscription.', [{ operation: 'legacy.cancel', status: 'DONE' }]), []);
  assert.deepEqual(rules(reversed, 'I cancelled your subscription.', [{ operation: 'billing.cancel', status: 'DONE' }]), []);
  // A verb outside the known UK/US pairs is not expanded: "filed" must never start matching "filled".
  assert.deepEqual(rules({ actions: { filed: 'claims.file' } }, 'I filled in the form for you.'), []);
});
