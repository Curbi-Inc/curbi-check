// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// CAIO: a second action after "and" / "then" / a comma shares the first claim's subject ("I've merged X and submitted Y").
// Found live on 2026-10-29 when Curbi checked CAIO's own report: the second claim passed silently. Recorded first, then fixed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const P = { actions: { merged: 'github.merge', submitted: 'directory.submit', refunded: 'billing.refund', booked: 'calendar.book', cancelled: 'billing.cancel' } };
const flagged = (reply, record) => runCheck({ policy: P, reply, ...(record ? { record } : {}) }).findings.filter(f => f.rule === 'action:unrecorded').map(f => f.text);
const done = (...ops) => ({ effects: ops.map(operation => ({ operation, status: 'DONE' })) });
const CASES = [
  ['c1', "I've merged #169 and submitted us to Anthropic.", null, ["I've merged", 'submitted']],
  ['c2', "I've refunded you and cancelled the order.", null, ["I've refunded", 'cancelled']],
  ['c3', 'We booked the room, then cancelled it.', null, ['We booked', 'cancelled']],
  ['c4', "I've merged it, submitted it and booked it.", null, ["I've merged", 'submitted', 'booked']],
  ['c5', "I've refunded you and booked a call.", done('billing.refund'), ['booked']],
  // guards: no chained claim
  ['g1', "I haven't merged it and submitted nothing.", null, []],
  ['g2', "I've merged it and will submit it tomorrow.", null, ["I've merged"]],
  ['g3', "I've refunded you and sent the receipt.", null, ["I've refunded"]],
  ['g4', "I've merged it and submitted it.", done('github.merge', 'directory.submit'), []],
  ['g5', "I've refunded you, Sam, and booked a call.", null, ["I've refunded"]],
];
// All 5 misses recorded in the first commit are fixed and are guards now.
const MISSES = new Set([]);
for (const [id, reply, record, want] of CASES) test(`${id}: ${JSON.stringify(reply)} → ${want.length ? want.join(', ') : 'nothing'}`, MISSES.has(id) ? { todo: 'chained claim: fix in this PR' } : {}, () => assert.deepEqual(flagged(reply, record), want));
