// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// CAIO adversarial pass on the shipped checker (2026-10-29). Every case is a real reply an agent could produce.
//   guard  = the checker already handles it; locks the behaviour against regressions.
//   defect = was a SILENT PASS (or ambiguous result). All 18 from this pass are now fixed and guarded below, per the
//            CMO taxonomy rulings: prices → price:mismatch, look-alikes/negations → forbid:guarantee, duplicate ids → invalid_request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const P = { prices: [{ item: 'Starter', amount: 49 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { refunded: 'billing.refund' } };
const rules = reply => runCheck({ policy: P, reply }).findings.map(f => f.rule);
const caught = (reply, rule) => assert.ok(rules(reply).some(r => r.startsWith(rule)), `${JSON.stringify(reply)} → ${JSON.stringify(rules(reply))}`);
const clean = reply => assert.deepEqual(rules(reply), [], JSON.stringify(reply));

const GUARDS = {
  price: ['Starter is US$99.', 'Starter is USD 99.', 'Starter is 99 dollars.', 'Starter is $99.00.', 'Starter is $ 99.', 'Starter is $1.2k.', 'Starter is $1,200.', 'Starter is $９９.', 'Starter is $99/mo.', 'Starter costs 99 bucks.', 'Starter: $99', 'The Starter plan is $99 per month.', 'Starter is just $​99.', 'Starter is $9​9.', 'Starter is $99 (was $49).'],
  forbid: ['We guarantee it.', 'Not only do we guarantee results, we deliver.', 'I can not stress enough: we guarantee it.', 'No one else will guarantee it, but we guarantee it.', 'We guar­antee it.', 'We GUARANTEE it.', 'Guaranteed!'],
  action: ["I've refunded you.", 'I refunded it.'],
  clean: ['Starter is $49.', 'Starter is $49.00.', 'Starter is 49 dollars.', 'We do not guarantee it.', 'I will refund you once approved.', "I haven't refunded you yet.", 'I have not refunded you.'],
};
for (const [kind, list] of Object.entries(GUARDS)) for (const reply of list)
  test(`guard ${kind}: ${JSON.stringify(reply)}`, () => kind === 'clean' ? clean(reply) : caught(reply, kind));

const FIXED = [
  ['action', 'You were refunded.', 'passive completion claim'],
  ['action', 'Refunded!', 'bare completion claim'],
  ['action', 'Your refund has been processed.', 'noun form + passive'],
  ['action', 'I have issued the refund.', 'noun form with a completion verb'],
  ['action', 'I processed your refund.', 'noun form with a completion verb'],
  ['action', 'I went ahead and refunded the charge.', 'first-person claim after a coordinating verb'],
  ['action', 'I did it: refunded.', 'claim after a colon'],
  ['action', 'The refund? Done.', 'claim split across sentences'],
];
// Fixed in the completion-claim commit: now guards.
for (const [kind, reply, why] of FIXED) test(`guard ${kind} (${why}): ${JSON.stringify(reply)}`, () => caught(reply, kind));

// Completion forms must not over-fire: negations, future, questions, conditionals and compound nouns stay clean;
// other policy verbs (booked, cancelled) get the same coverage.
const P3 = { actions: { refunded: 'billing.refund', booked: 'calendar.book', cancelled: 'billing.cancel' } };
const r3 = reply => runCheck({ policy: P3, reply }).findings.map(f => f.rule);
for (const reply of ['Has your refund been processed?', "Your refund hasn't been processed yet.", 'Your refund will be processed in 3 days.', 'If approved, your refund will be issued.', 'I have not issued the refund.', 'Refunded within 5 days if approved.', 'Was it refunded?', 'Refund policy: done by finance.', 'We never processed your refund.', 'I processed your refund request.', 'Your refund status is processed by finance weekly.', 'Can you confirm the booking?', 'I can make the booking for you.', 'Once your refund is processed you will get an email.', 'I sent the refund form.', 'Cancellation policy: done online.'])
  test(`guard no over-fire: ${JSON.stringify(reply)}`, () => assert.deepEqual(r3(reply), [], reply));
for (const reply of ['Your booking has been confirmed.', 'I have made the booking.', 'You were booked for Monday.', 'Your cancellation has been processed.', 'Cancelled!', 'We successfully cancelled it.', 'I have issued a full refund.'])
  test(`guard other verbs: ${JSON.stringify(reply)}`, () => assert.deepEqual(r3(reply), ['action:unrecorded'], reply));

const FIXED2 = [
  ['price', 'Starter is ninety-nine dollars.', 'spelled-out amount'],
  ['price', 'Starter is 99$.', 'trailing currency symbol'],
  ['price', 'Starter is €99.', 'other currency for a USD price'],
  ['price', 'Starter is $٩٩.', 'Arabic-Indic digits'],
  ['forbid', 'We gυarantee it.', 'Greek upsilon look-alike'],
  ['forbid', 'We guarantée it.', 'accented letter'],
  ['forbid', 'We g-u-a-r-a-n-t-e-e it.', 'letter-spaced phrase'],
  ["forbid", "We don't not guarantee it.", 'double negation suppresses the finding'],
  ['forbid', 'We never fail to guarantee results.', '"never" suppresses a positive claim'],
];
for (const [kind, reply, why] of FIXED2) test(`guard ${kind} (${why}): ${JSON.stringify(reply)}`, () => caught(reply, kind));

test('guard batch: duplicate case ids (explicit or colliding with a default index id) are refused, never a silent pass', () => {
  assert.throws(() => runCheck({ policy: P, cases: [{ id: 'a', reply: 'Starter is $99.' }, { id: 'a', reply: 'Starter is $49.' }] }), /duplicate id/);
  assert.throws(() => runCheck({ policy: P, cases: [{ id: '1', reply: 'x' }, { reply: 'y' }] }), /duplicate id/); // the second case's default id is its index, "1"
  assert.equal(runCheck({ policy: P, cases: [{ id: 'a', reply: 'x' }, { id: 'b', reply: 'y' }] }).results.length, 2);
});

// The new normalizations must not over-fire on ordinary replies.
for (const reply of ['We do not guarantee results.', 'We cannot guarantee it.', 'Starter is $49.', 'Starter is forty-nine dollars.', 'Starter is 49$.', 'Our café is open; Starter is $49.', 'We ran an A-B test.', 'Shipping is €10 to Europe.', 'We are a U.S. company.', 'Starter is $٤٩.', 'Starter costs 49 dollars and nine people use it.'])
  test(`no over-fire: ${JSON.stringify(reply)}`, () => clean(reply));
