// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Adversarial pass 2 (2026-10-29): overlapping item names, partial words, aliases and multi-item sentences.
// Every case runs under the policy as written AND with the price list reversed: attribution must not depend on order.
// Expected: '' = passes; 'mismatch:<Item>' = price:mismatch naming that item; other strings = that price:* rule.
//   miss       = was wrong (silent pass or wrong finding). Recorded as `todo` first, then fixed and promoted to a guard.
//   limitation = a known false positive that still fails closed (flagged, never passed). Pinned, not fixed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');

const PO = { prices: [{ item: 'Pro', amount: 9 }, { item: 'Pro Plus', amount: 19 }, { item: 'Pro Plus Annual', amount: 190 }, { item: 'Team', amount: 29, aliases: ['Team', 'Teams plan', 'Team Pro'] }, { item: 'Starter', amount: 49 }] };
const PN = { prices: [{ item: 'Pro', amount: 9 }, { item: 'Pro+', amount: 19 }, { item: 'C++ Course', amount: 99 }, { item: 'Crème', amount: 5 }, { item: 'Plan 2', amount: 20 }] };
const got = (policy, reply) => runCheck({ policy, reply }).findings.filter(f => f.rule.startsWith('price:')).map(f => f.rule === 'price:mismatch' ? 'mismatch:' + f.why.split(' is ')[0] : f.rule.slice(6));

const CASES = [
  // overlap, correct price: the longer name is the one being priced
  ['o1', PO, 'Pro Plus is $19.', []], ['o2', PO, 'Pro is $9.', []], ['o3', PO, 'Pro Plus Annual is $190.', []],
  ['o4', PO, 'The Pro Plus plan costs $19 per month.', []], ['o5', PO, 'pro plus is $19.', []], ['o6', PO, 'PRO PLUS: $19', []],
  ['o7', PO, 'Pro-Plus is $19.', []], ['o8', PO, 'Pro  Plus is $19.', []], ['o9', PO, "Pro Plus's price is $19.", []],
  ['o10', PO, 'Pro Plus is $19/mo.', []], ['o11', PO, 'Pro Plus (monthly) is $19.', []], ['o12', PO, '"Pro Plus" is $19.', []],
  ['o13', PO, 'Pro Plus is 19 dollars.', []], ['o14', PO, 'Pro Plus is $19.00.', []], ['o15', PO, 'Pro Plus is US$19.', []],
  ['o16', PO, 'Pro Plus costs nineteen dollars.', []], ['o17', PO, 'Prо Plus is $19.', []],
  // overlap, wrong price: caught, and charged to the right item
  ['w1', PO, 'Pro Plus is $9.', ['mismatch:Pro Plus']], ['w2', PO, 'Pro is $19.', ['mismatch:Pro']],
  ['w3', PO, 'Pro Plus Annual is $19.', ['mismatch:Pro Plus Annual']], ['w4', PO, 'Pro Plus is $190.', ['mismatch:Pro Plus']],
  ['w5', PO, 'Pro-Plus is $9.', ['mismatch:Pro Plus']], ['w6', PO, 'PRO PLUS: $9', ['mismatch:Pro Plus']],
  ['w7', PO, 'Pro Plus is €19.', ['mismatch:Pro Plus']], ['w8', PO, 'Pro Plus is ninety dollars.', ['mismatch:Pro Plus']],
  ['w9', PO, 'Prо Plus is $9.', ['mismatch:Pro Plus']], ['w10', PO, 'Pro  Plus is $9.', ['mismatch:Pro Plus']],
  // several items in one sentence
  ['m1', PO, 'Pro is $9 and Pro Plus is $19.', []], ['m2', PO, 'Pro Plus is $19 and Pro is $9.', []],
  ['m3', PO, 'Pro is $9, Pro Plus is $19, and Pro Plus Annual is $190.', []], ['m4', PO, 'Choose Pro ($9) or Pro Plus ($19).', []],
  ['m5', PO, 'Upgrade from Pro to Pro Plus for $19.', []], ['m6', PO, '$19 gets you Pro Plus.', []],
  ['m7', PO, 'Pro is $9 and Pro Plus is $9.', ['mismatch:Pro Plus']], ['m8', PO, 'Choose Pro ($9) or Pro Plus ($9).', ['mismatch:Pro Plus']],
  ['m9', PO, 'Pro is $19 and Pro Plus is $19.', ['mismatch:Pro']], ['m10', PO, 'Pro Plus is $19, Pro is $9.', []],
  ['m11', PO, 'Pro Plus: $19. Pro: $9.', []], ['m12', PO, 'Starter is $49, Pro is $9, Team is $29.', []],
  ['m13', PO, 'Starter is $49, Pro is $29, Team is $9.', ['mismatch:Pro', 'mismatch:Team']],
  ['m14', PO, 'Compared with Pro at $9, Pro Plus is $19.', []], ['m15', PO, 'Pro is $9 per seat; Pro Plus is $19 per seat.', []],
  ['m16', PO, 'For $9 you get Pro; for $19 you get Pro Plus.', []], ['m17', PO, 'Pro Plus is $19 while Pro Plus Annual is $190.', []],
  // aliases, including an alias that contains another item's name
  ['a1', PO, 'The Teams plan is $29.', []], ['a2', PO, 'The Teams plan is $20.', ['mismatch:Team']],
  ['a3', PO, 'Team Pro is $29.', []], ['a4', PO, 'Team Pro is $9.', ['mismatch:Team']],
  ['a5', PO, 'Pros are $9.', []], ['a6', PO, 'Starters are $49.', []], ['a7', PO, 'Teams are $29.', []],
  // a name inside a longer word is not a mention
  ['p1', PO, 'Professional services are $500.', ['unattributed']], ['p2', PO, 'Our Proton add-on is $5.', ['unattributed']],
  ['p3', PO, 'iPro is $19.', ['unattributed']], ['p4', PO, 'Teamwork training is $29.', ['unattributed']], ['p5', PO, 'Approve the Pro upgrade for $9.', []],
  // names with symbols, accents and digits
  ['n1', PN, 'Pro+ is $19.', []], ['n2', PN, 'Pro+ is $9.', ['mismatch:Pro+']], ['n3', PN, 'The C++ Course is $99.', []],
  ['n4', PN, 'The C++ Course is $9.', ['mismatch:C++ Course']], ['n5', PN, 'Crème is $5.', []], ['n6', PN, 'Crème is $9.', ['mismatch:Crème']],
  ['n7', PN, 'Plan 20 is $35.', ['unattributed']], ['n8', PN, 'Plan 2 is $20.', []],
  // known false positives that fail closed (flagged, never passed): grammar the nearest-name rule cannot read
  ['k1', PO, 'Pro Plus and Pro are $19 and $9 respectively.', []], ['k2', PO, 'Pro Plus, our most popular plan for growing teams that need more seats, is $19.', []],
  ['k3', PO, 'Pro Plus is $10 more than Pro.', []],
];
// All 46 misses recorded in the first commit of this PR (9 of them silent passes) are fixed: longest name wins, names
// normalized like reply text, space/hyphen variants, symbol-safe edges, ';' ends a clause. They are guards now.
const MISSES = new Set([]);
const LIMITATIONS = new Set(['k1', 'k2', 'k3']);
const reversed = p => ({ ...p, prices: [...p.prices].reverse() });

for (const [id, policy, reply, want] of CASES) {
  if (LIMITATIONS.has(id)) continue;   // pinned below: they are flagged (never passed), with the exact finding they get today
  const opts = MISSES.has(id) ? { todo: 'miss in pass 2: fix in this PR' } : {};
  test(`${id}: ${JSON.stringify(reply)} → ${want.length ? want.join(', ') : 'passes'}`, opts, () => {
    for (const p of [policy, reversed(policy)]) assert.deepEqual(got(p, reply), want, p === policy ? 'policy order' : 'reversed policy order');
  });
}

// Grammar the nearest-name rule cannot read: "respectively" lists, a name more than 60 characters before its price
// (where "teams" reads as the Team plan), and a relative amount ("$10 more than"). Each is a false positive that fails
// closed, in either policy order. Pinned exactly, so a change in either direction (fixed, or worse: passed) is noticed.
const PINNED = { k1: ['mismatch:Pro'], k2: ['mismatch:Team'], k3: ['mismatch:Pro Plus'] };
test('limitations fail closed: each is flagged, never a pass, with the finding pinned', () => {
  for (const [id, policy, reply] of CASES) if (LIMITATIONS.has(id)) for (const p of [policy, reversed(policy)]) {
    assert.equal(runCheck({ policy: p, reply }).pass, false, id); assert.deepEqual(got(p, reply), PINNED[id], id);
  }
});
