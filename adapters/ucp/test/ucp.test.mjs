// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// UCP adapter tests. Fixtures marked SPEC are copied from the UCP specification at tag v2026-08-25
// (docs/specification/overview/index.md, "Policies" section; source/schemas/common/types/policy.json,
// message_warning.json; source/schemas/shopping/order.json, types/adjustment.json). Everything else is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, governingPolicy, checkDisclosures, durations, orderRecord, UCP_ACTIONS, checkReplyAgainstOrder, checkReplyTerms, SCOPE_TYPES } from '../src/ucp.mjs';

const RET = 'dev.ucp.shopping.policy.return', WAR = 'dev.ucp.shopping.policy.warranty';
// SPEC: engraved item, final-sale override on line 2.
const SPEC_RETURN = [
  { type: RET, description: { plain: 'Free 30-day returns from delivery.' } },
  { type: RET, description: { plain: 'This engraved item is final sale and cannot be returned.' }, applies_to: ['$.line_items[2]'], url: 'https://example.com/returns#final-sale' },
];
const SPEC_DISCLOSURE = { type: 'warning', code: RET, path: '$.line_items[2]', presentation: 'disclosure', content: 'This engraved item is final sale and cannot be returned.' };
// SPEC: site-wide warranty with a per-item override.
const SPEC_WARRANTY = [
  { type: WAR, description: { plain: '1-year limited warranty on all items.' } },
  { type: WAR, description: { plain: '3-year extended warranty on this item.' }, applies_to: ['$.line_items[2]'] },
];
const checkout = (policies, messages) => ({ line_items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], policies, messages });

test('scope is exactly the two well-known types', () => {
  assert.deepEqual([...SCOPE_TYPES].sort(), [RET, WAR]);
});

test('JSONPath subset: singular, wildcard, root; filters and slices refused', () => {
  assert.deepEqual(parsePath('$'), []);
  assert.deepEqual(parsePath('$.line_items[2]'), ['line_items', 2]);
  assert.deepEqual(parsePath("$['line_items'][0]"), ['line_items', 0]);
  assert.deepEqual(parsePath('$.line_items[*]'), ['line_items', '*']);
  for (const p of ["$.products[?@.category=='x']", '$.line_items[0:2]', '$..line_items', 'line_items[0]', '$.line_items[-1]', '$.a[01]']) assert.equal(parsePath(p), null, p);
});

test('precedence: singular item override governs its node; response-wide governs the rest (SPEC)', () => {
  assert.equal(governingPolicy(SPEC_RETURN, RET, ['line_items', 2]).index, 1);
  assert.equal(governingPolicy(SPEC_RETURN, RET, ['line_items', 0]).index, 0);
  assert.equal(governingPolicy(SPEC_WARRANTY, WAR, ['line_items', 2]).index, 1);
  assert.equal(governingPolicy(SPEC_WARRANTY, WAR, ['line_items', 1]).index, 0);
  assert.equal(governingPolicy(SPEC_RETURN, WAR, ['line_items', 0]).status, 'none');
});

test('precedence: depth first, then singular beats set at equal depth; a true tie is ambiguous, never silently resolved', () => {
  const p = [{ type: RET, description: { plain: 'set' }, applies_to: ['$.line_items[*]'] }, { type: RET, description: { plain: 'one' }, applies_to: ['$.line_items[1]'] }];
  assert.equal(governingPolicy(p, RET, ['line_items', 1]).index, 1);
  assert.equal(governingPolicy(p, RET, ['line_items', 0]).index, 0);
  const tie = [{ type: RET, description: { plain: 'a' } }, { type: RET, description: { plain: 'b' } }];
  assert.equal(governingPolicy(tie, RET, ['line_items', 0]).status, 'ambiguous');
  // A policy is scored by its best covering target: singular [1] lifts it to (2,1), tying a separate singular policy.
  const multi = [{ type: RET, description: { plain: 'a' }, applies_to: ['$.line_items[*]', '$.line_items[1]'] }, { type: RET, description: { plain: 'b' }, applies_to: ['$.line_items[1]'] }];
  assert.equal(governingPolicy(multi, RET, ['line_items', 1]).status, 'ambiguous');
  assert.equal(governingPolicy(multi, RET, ['line_items', 0]).index, 0);
  const bad = [{ type: RET, description: { plain: 'a' }, applies_to: ["$.line_items[?@.x]"] }];
  assert.equal(governingPolicy(bad, RET, ['line_items', 0]).status, 'unsupported');
});

test('SPEC example disclosure pairs with the final-sale policy verbatim', () => {
  const r = checkDisclosures(checkout(SPEC_RETURN, [SPEC_DISCLOSURE]));
  assert.equal(r.pass, true);
  assert.equal(r.disclosures[0].status, 'verbatim');
  assert.equal(r.disclosures[0].governing.index, 1);
});

test('a disclosure that promises returns on a final-sale line is a conflict', () => {
  const r = checkDisclosures(checkout(SPEC_RETURN, [{ ...SPEC_DISCLOSURE, content: 'Free 30-day returns on this item.' }]));
  assert.equal(r.pass, false);
  assert.equal(r.disclosures[0].status, 'conflict');
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-final-sale-mismatch']);
});

test('a disclosure stating a different window than its governing policy is a conflict', () => {
  const r = checkDisclosures(checkout(SPEC_RETURN, [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Returns accepted within 60 days.' }]));
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
  const w = checkDisclosures(checkout(SPEC_WARRANTY, [{ type: 'warning', code: WAR, path: '$.line_items[2]', presentation: 'disclosure', content: 'Covered by a 1-year warranty.' }]));
  assert.deepEqual(w.findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
});

test('equivalent units compare; incomparable units are not a finding', () => {
  const p = [{ type: RET, description: { plain: '30-day returns.' } }];
  const m = c => checkDisclosures(checkout(p, [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: c }]));
  assert.equal(m('Returns within 30 days of delivery.').disclosures[0].status, 'no_conflict_found');
  assert.equal(m('Returns within one month.').pass, true, 'days vs months are not converted, so not compared');
  const y = [{ type: WAR, description: { plain: '1-year warranty.' } }];
  const r = checkDisclosures(checkout(y, [{ type: 'warning', code: WAR, path: '$.line_items[0]', presentation: 'disclosure', content: '12-month warranty.' }]));
  assert.equal(r.pass, true);
  assert.deepEqual(durations('2 weeks, 14-day, a year, twelve months'), [{ n: 14, base: 'day' }, { n: 14, base: 'day' }, { n: 12, base: 'month' }, { n: 12, base: 'month' }]);
});

test('different wording with no checkable conflict is no_conflict_found, never "agrees"', () => {
  const r = checkDisclosures(checkout(SPEC_RETURN, [{ ...SPEC_DISCLOSURE, content: 'Personalized items cannot be sent back.' }]));
  assert.equal(r.disclosures[0].status, 'no_conflict_found');
  assert.equal(r.pass, true);
  assert.match(r.notes.join(' '), /not proof of agreement/);
});

test('unpaired, ambiguous, unsupported and out-of-scope disclosures are reported, not passed silently', () => {
  const msgs = [
    { type: 'warning', code: WAR, path: '$.line_items[0]', presentation: 'disclosure', content: 'Warranty applies.' },
    { type: 'warning', code: RET, path: '$.line_items[*]', presentation: 'disclosure', content: 'x' },
    { type: 'warning', code: 'final_sale', path: '$.line_items[0]', presentation: 'disclosure', content: 'Final sale.' },
    { type: 'warning', code: RET, path: '$.line_items[0]', content: 'notice only' },
  ];
  const r = checkDisclosures(checkout(SPEC_RETURN, msgs));
  assert.deepEqual(r.disclosures.map(d => d.status), ['unpaired', 'unsupported', 'out_of_scope']);
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-unpaired', 'ucp:path-unsupported']);
  assert.equal(r.pass, false);
  const tie = checkDisclosures(checkout([{ type: RET, description: { plain: 'a' } }, { type: RET, description: { plain: 'b' } }], [SPEC_DISCLOSURE]));
  assert.deepEqual(tie.findings.map(f => f.rule), ['ucp:policy-ambiguous']);
});

test('policy description falls back plain → markdown → html with tags stripped', () => {
  const p = [{ type: RET, description: { html: '<p>This item is <b>final sale</b>.</p>' } }];
  const r = checkDisclosures(checkout(p, [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Free returns within 30 days.' }]));
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-final-sale-mismatch']);
});

test('labels: UCP policy is the business\'s statement, not Curbi policy; trust is business_self_reported', () => {
  const r = checkDisclosures(checkout(SPEC_RETURN, [SPEC_DISCLOSURE]));
  assert.equal(r.object, 'curbi.ucp.disclosure-check.v1');
  assert.equal(r.sourceTrust, 'business_self_reported');
  assert.match(r.notes.join(' '), /business's own statement/);
  assert.equal(r.signed, false);
});

test('untrusted input is bounded and malformed input is refused', () => {
  assert.throws(() => checkDisclosures(null), /response must be an object/);
  assert.throws(() => checkDisclosures({ policies: 'x' }), /policies must be an array/);
  assert.throws(() => checkDisclosures({ policies: Array(201).fill(SPEC_RETURN[0]) }), /at most 200/);
  assert.throws(() => checkDisclosures({ policies: [{ type: RET }] }), /description/);
  assert.throws(() => checkDisclosures({ policies: [], messages: [{ type: 'warning', code: RET, presentation: 'disclosure', content: 'x'.repeat(4001) }] }), /4000/);
  assert.equal(parsePath('$' + '.a'.repeat(40)), null, 'depth cap');
});

// ORDER — a business-written snapshot. Shape per source/schemas/shopping/order.json + types/adjustment.json.
const order = { id: 'ord_1', checkout_id: 'chk_1', currency: 'USD', line_items: [{ id: 'a' }], fulfillment: {}, totals: [], permalink_url: 'https://example.com/o/1',
  adjustments: [{ id: 'adj_1', type: 'refund', occurred_at: '2026-11-19T10:00:00Z', status: 'pending' }] };

test('Order adjustments become a Curbi record; only completed counts as DONE', () => {
  const rec = orderRecord(order);
  assert.deepEqual(rec, { subject: 'ord_1', effects: [{ operation: 'ucp.adjustment.refund', status: 'PENDING' }] });
  const done = orderRecord({ ...order, adjustments: [{ ...order.adjustments[0], status: 'completed' }] });
  assert.equal(done.effects[0].status, 'DONE');
  assert.equal(UCP_ACTIONS.refunded, 'ucp.adjustment.refund');
});

test('agent claims checked against the Order through the unchanged Curbi checker', () => {
  const r = checkReplyAgainstOrder({ order, reply: 'I refunded you, it should arrive soon.' });
  assert.equal(r.pass, false);
  assert.deepEqual(r.findings.map(f => f.rule), ['action:unrecorded']);
  assert.equal(r.recordSource, 'ucp_order_business_snapshot');
  const ok = checkReplyAgainstOrder({ order: { ...order, adjustments: [{ ...order.adjustments[0], status: 'completed' }] }, reply: 'I refunded you.' });
  assert.equal(ok.pass, true);
  assert.match(ok.notes.join(' '), /not provider confirmation/);
});

test('agent reply about terms is checked against the response\'s governing return/warranty policies', () => {
  const resp = checkout(SPEC_RETURN.slice(0, 1).concat(SPEC_WARRANTY.slice(0, 1)), []);
  assert.deepEqual(checkReplyTerms({ response: resp, reply: 'You can return it within 60 days.' }).findings.map(f => f.rule), ['ucp:claim-duration-mismatch']);
  assert.equal(checkReplyTerms({ response: resp, reply: 'Returns are free within 30 days, and there is a 1-year warranty.' }).pass, true);
  assert.deepEqual(checkReplyTerms({ response: resp, reply: 'It comes with a 2-year warranty.' }).findings.map(f => f.rule), ['ucp:claim-duration-mismatch']);
  assert.equal(checkReplyTerms({ response: checkout([], []), reply: 'Returns within 60 days.' }).pass, true, 'no policy, nothing to compare');
  const fs = checkout(SPEC_RETURN.slice(1).map(p => ({ ...p, applies_to: undefined })), []);
  assert.deepEqual(checkReplyTerms({ response: fs, reply: 'No problem, you can return it for a full refund.' }).findings.map(f => f.rule), ['ucp:claim-final-sale-mismatch']);
  // Site-wide returns plus one final-sale line: a reply cannot be tied to a line, so offering a return is not flagged.
  assert.equal(checkReplyTerms({ response: checkout(SPEC_RETURN, []), reply: 'You can return it for a full refund.' }).pass, true);
  // A reply that itself says final sale is not an offer of returns.
  assert.equal(checkReplyTerms({ response: fs, reply: 'Sorry, this one is final sale, so you cannot return it.' }).pass, true);
  assert.equal(checkReplyTerms({ response: fs, reply: "Unfortunately you can't return it." }).pass, true, 'negated offer, no final-sale words');
  assert.equal(checkReplyTerms({ response: fs, reply: 'It is final sale, return it only if it arrives damaged.' }).pass, true, 'sentence-level final sale');
});
