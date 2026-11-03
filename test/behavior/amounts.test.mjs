// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Adversarial pass 3 (2026-10-29): amount edge cases and multi-item sentences that survived pass 2.
// Run on the v39 source (curbi.io was not reachable from the test environment; live reproduction follows deployment).
// Every case runs under the policy as written AND reversed. Expected: '' = passes; 'mismatch:<Item>' = price:mismatch
// for that item; other strings = that price:* rule. Misses were recorded as `todo` first, then fixed and promoted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');

const P = { prices: [{ item: 'Pro', amount: 9 }, { item: 'Pro Plus', amount: 19 }, { item: 'Team', amount: 29 }, { item: 'Starter', amount: 49 }, { item: 'Enterprise', amounts: [99, 199] }, { item: 'Fleet', amount: 25000 }, { item: 'Add-on', amount: 0.99 }, { item: 'Basic', amount: 0 }] };
const got = (policy, reply) => runCheck({ policy, reply }).findings.filter(f => f.rule.startsWith('price:')).map(f => f.rule === 'price:mismatch' ? 'mismatch:' + f.why.split(' is ')[0] : f.rule.slice(6)).sort();

const CASES = [
  // magnitude suffixes: "$49k" is 49,000, never 49
  ['k1', 'Starter is $49k.', ['mismatch:Starter']], ['k2', 'Starter is $49K per year.', ['mismatch:Starter']], ['k3', 'Starter is $49M.', ['mismatch:Starter']],
  ['k4', 'Starter is $49 million.', ['mismatch:Starter']], ['k5', 'Starter is $49 thousand.', ['mismatch:Starter']], ['k6', 'Starter is $4.9k.', ['mismatch:Starter']],
  ['k7', 'Fleet is $25k.', []], ['k8', 'Fleet is $25K a year.', []], ['k9', 'Fleet is $25,000.', []], ['k10', 'Fleet is $2.5k.', ['mismatch:Fleet']],
  ['k11', 'Fleet is twenty-five thousand dollars.', []], ['k12', 'Starter is $49 monthly.', []], ['k13', 'Starter is $49/mo.', []], ['k14', 'Starter is $49 max.', []],
  ['k15', 'Starter is $49 for up to 5k users.', []], ['k16', 'Starter is $49 Monday to Friday.', []], ['k17', 'Starter is $49, billed monthly.', []],
  // cents
  ['c1', 'Starter is forty-nine dollars and ninety-nine cents.', ['mismatch:Starter']], ['c2', 'Starter is $49 and 99 cents.', ['mismatch:Starter']],
  ['c3', 'Starter is 5900 cents.', ['mismatch:Starter']], ['c4', 'Starter is 4900 cents.', []], ['c5', 'Pro is 99 cents.', ['mismatch:Pro']], ['c6', 'Pro is 99¢.', ['mismatch:Pro']],
  ['c7', 'Pro is 900¢.', []], ['c8', 'The Add-on is 99 cents.', []], ['c9', 'The Add-on is $0.99.', []], ['c10', 'The Add-on is ninety-nine cents.', []],
  ['c11', 'Starter is $49 and 0 cents.', []], ['c12', 'Starter is forty-nine dollars.', []],
  // ranges: the upper bound is a price claim too
  ['r1', 'Starter is $49-59.', ['mismatch:Starter']], ['r2', 'Starter is $49 to 59.', ['mismatch:Starter']], ['r3', 'Starter is $49–59.', ['mismatch:Starter']],
  ['r4', 'Starter is $49 - $59.', ['mismatch:Starter']], ['r5', 'Enterprise is $99-199.', []], ['r6', 'Enterprise is $99 to $199.', []],
  ['r7', 'Starter is $49 for 1-5 seats.', []], ['r8', 'Starter is $49 - 10% off for annual plans.', []], ['r9', 'Starter is $49 to start.', []],
  // "free" is a price claim of $0
  ['f1', 'Starter is free.', ['mismatch:Starter']], ['f2', 'Starter is completely free.', ['mismatch:Starter']], ['f3', 'Starter is at no cost.', ['mismatch:Starter']],
  ['f4', 'Starter costs nothing.', ['mismatch:Starter']], ['f5', "Starter's free of charge.", ['mismatch:Starter']], ['f6', 'Basic is free.', []],
  ['f7', 'Starter has a free trial.', []], ['f8', 'Feel free to try Starter.', []], ['f9', 'Starter is not free.', []], ['f10', "Starter isn't free.", []],
  ['f11', 'Starter is free to try for 14 days.', []], ['f12', 'Starter is free for 14 days.', []], ['f13', 'Shipping is free with Starter.', []],
  ['f14', 'Starter costs nothing extra to set up.', []], ['f15', 'Starter is free of ads.', []],
  // one amount for several items: each listed item is checked
  ['m1', 'Both Pro and Pro Plus are $19.', ['mismatch:Pro']], ['m2', 'Pro and Team each cost $29.', ['mismatch:Pro']],
  ['m3', 'Pro, Team and Starter are all $49.', ['mismatch:Pro', 'mismatch:Team']], ['m4', 'Pro and Pro Plus are both $19.', ['mismatch:Pro']],
  ['m5', 'Pro is $9 and Pro Plus is $19.', []], ['m6', 'Team and Starter plans are $29.', ['mismatch:Starter']], ['m7', 'Upgrade from Pro to Pro Plus for $19.', []],
  // spelled hundreds and thousands
  ['s1', 'Starter is a hundred dollars.', ['mismatch:Starter']], ['s2', 'Starter is one hundred dollars.', ['mismatch:Starter']], ['s3', 'Fleet is a thousand dollars.', ['mismatch:Fleet']],
  // already right before this pass: guards
  ['g1', 'Starter is $49.99.', ['mismatch:Starter']], ['g2', 'Starter is $49,99.', ['malformed']], ['g3', 'Starter is ＄59.', ['mismatch:Starter']],
  ['g4', 'Starter is 59 bucks.', ['mismatch:Starter']], ['g5', 'Pro Plus is $19 — Pro is $9.', []], ['g6', 'Unlike Pro Plus, Pro is $9.', []],
  ['g7', 'Starter is USD59.', ['mismatch:Starter']], ['g8', 'Starter costs 49.00 dollars.', []], ['g9', 'Starter is $49–$59.', ['mismatch:Starter']],
];
// All 26 misses recorded in the first commit of this PR (24 silent passes) are fixed and are guards now.
const MISSES = new Set([]);
const reversed = p => ({ ...p, prices: [...p.prices].reverse() });

for (const [id, reply, want] of CASES) test(`${id}: ${JSON.stringify(reply)} → ${want.length ? want.join(', ') : 'passes'}`, MISSES.has(id) ? { todo: 'miss in pass 3: fix in this PR' } : {}, () => {
  for (const p of [P, reversed(P)]) assert.deepEqual(got(p, reply), want, p === P ? 'policy order' : 'reversed policy order');
});
