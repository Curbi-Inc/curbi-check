// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// UCP adapter tests. Fixtures marked SPEC are copied from the UCP specification at tag v2026-08-25
// (docs/specification/overview/index.md, "Policies" section; source/schemas/common/types/policy.json,
// message_warning.json; source/schemas/shopping/order.json, types/adjustment.json). Everything else is synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePath, governingPolicy, checkDisclosures, durations, orderRecord, UCP_ACTIONS, checkReplyAgainstOrder, checkReplyTerms, termDurations, SCOPE_TYPES } from '../src/ucp.mjs';

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

test('JSONPath subset: typed segments; quoted names are never wildcards; filters and slices refused', () => {
  assert.deepEqual(parsePath('$'), []);
  assert.deepEqual(parsePath('$.line_items[2]'), [{ k: 'name', v: 'line_items' }, { k: 'index', v: 2 }]);
  assert.deepEqual(parsePath("$['line_items'][0]"), [{ k: 'name', v: 'line_items' }, { k: 'index', v: 0 }]);
  assert.deepEqual(parsePath('$["line_items"]'), [{ k: 'name', v: 'line_items' }]);
  assert.deepEqual(parsePath('$.line_items[*]'), [{ k: 'name', v: 'line_items' }, { k: 'wild' }]);
  assert.deepEqual(parsePath('$.line_items.*'), [{ k: 'name', v: 'line_items' }, { k: 'wild' }]);
  assert.deepEqual(parsePath("$['*']"), [{ k: 'name', v: '*' }], 'quoted star is a name');
  assert.deepEqual(parsePath("$['it\\'s']"), [{ k: 'name', v: "it's" }]);
  assert.deepEqual(parsePath("$['a\\u0041']"), [{ k: 'name', v: 'aA' }]);
  for (const p of ["$.products[?@.category=='x']", '$.line_items[0:2]', '$..line_items', 'line_items[0]', '$.line_items[-1]', '$.a[01]', "$['a\\q']", "$['unterminated]", "$['a'x[0]"]) assert.equal(parsePath(p), null, p);
});

const items3 = { line_items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
const gov = (policies, type, path, extra = {}) => governingPolicy({ ...items3, ...extra, policies }, type, path);

test('precedence: singular item override governs its node; response-wide governs the rest (SPEC)', () => {
  assert.equal(gov(SPEC_RETURN, RET, '$.line_items[2]').index, 1);
  assert.equal(gov(SPEC_RETURN, RET, '$.line_items[0]').index, 0);
  assert.equal(gov(SPEC_WARRANTY, WAR, '$.line_items[2]').index, 1);
  assert.equal(gov(SPEC_WARRANTY, WAR, '$.line_items[1]').index, 0);
  assert.equal(gov(SPEC_RETURN, WAR, '$.line_items[0]').status, 'none');
});

test('precedence: depth first, then singular beats set at equal depth; a true tie is ambiguous, never silently resolved', () => {
  const p = [{ type: RET, description: { plain: 'set' }, applies_to: ['$.line_items[*]'] }, { type: RET, description: { plain: 'one' }, applies_to: ['$.line_items[1]'] }];
  assert.equal(gov(p, RET, '$.line_items[1]').index, 1);
  assert.equal(gov(p, RET, '$.line_items[0]').index, 0);
  const tie = [{ type: RET, description: { plain: 'a' } }, { type: RET, description: { plain: 'b' } }];
  assert.equal(gov(tie, RET, '$.line_items[0]').status, 'ambiguous');
  const setTie = [{ type: RET, description: { plain: 'a' }, applies_to: ['$.line_items[*]'] }, { type: RET, description: { plain: 'b' }, applies_to: ['$.line_items.*'] }];
  assert.equal(gov(setTie, RET, '$.line_items[0]').status, 'ambiguous', 'two set matches at equal depth');
  // A policy is scored by its best covering target: singular [1] lifts it to (2,1), tying a separate singular policy.
  const multi = [{ type: RET, description: { plain: 'a' }, applies_to: ['$.line_items[*]', '$.line_items[1]'] }, { type: RET, description: { plain: 'b' }, applies_to: ['$.line_items[1]'] }];
  assert.equal(gov(multi, RET, '$.line_items[1]').status, 'ambiguous');
  assert.equal(gov(multi, RET, '$.line_items[0]').index, 0);
  const bad = [{ type: RET, description: { plain: 'a' }, applies_to: ["$.line_items[?@.x]"] }];
  assert.equal(gov(bad, RET, '$.line_items[0]').status, 'unsupported');
});

test('targets are evaluated against the response: a name never matches an array element, a nonmatch covers nothing', () => {
  // CTO P1 #2 reproduction: quoted '*' on the line_items array matches no node, so the root policy governs line 0.
  const p = [{ type: RET, description: { plain: 'This item is final sale and cannot be returned.' } }, { type: RET, description: { plain: 'Free 30-day returns.' }, applies_to: ["$.line_items['*']"] }];
  assert.equal(gov(p, RET, '$.line_items[0]').index, 0);
  const r = checkDisclosures({ line_items: [{ id: 'a' }], policies: p, messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Free 30-day returns.' }] });
  assert.equal(r.pass, false);
  assert.equal(r.disclosures[0].governing.index, 0);
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-final-sale-mismatch']);
  // A literal '*' member on an object does match.
  const obj = { line_items: [{ id: 'a' }], extra: { '*': { x: 1 } }, policies: [{ type: RET, description: { plain: 'r' } }, { type: RET, description: { plain: 's' }, applies_to: ["$.extra['*']"] }] };
  assert.equal(governingPolicy(obj, RET, "$.extra['*'].x").index, 1);
  assert.equal(governingPolicy(obj, RET, '$.line_items[0]').index, 0);
  // An index on an object, a name on an array and an out-of-range index all match nothing.
  for (const t of ['$.line_items.id', "$['line_items']['0']", '$.line_items[9]']) {
    assert.equal(gov([{ type: RET, description: { plain: 'r' } }, { type: RET, description: { plain: 's' }, applies_to: [t] }], RET, '$.line_items[0]').index, 0, t);
  }
  // The same holds for the node itself: a name on an array or an index on an object names no node.
  assert.equal(gov(SPEC_RETURN, RET, "$['line_items']['0']").status, 'unmatched');
  assert.equal(governingPolicy({ extra: { 0: { x: 1 } }, policies: SPEC_RETURN }, RET, '$.extra[0]').status, 'unmatched');
  assert.equal(governingPolicy({ extra: { 0: { x: 1 } }, policies: SPEC_RETURN }, RET, "$.extra['0']").index, 0);
  // A disclosure path that names no node in the response is reported, not paired.
  const miss = checkDisclosures({ ...items3, policies: SPEC_RETURN, messages: [{ type: 'warning', code: RET, path: '$.line_items[7]', presentation: 'disclosure', content: 'x' }] });
  assert.deepEqual(miss.findings.map(f => f.rule), ['ucp:path-unmatched']);
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

test('time windows are attributed to the term they describe (CTO attribution case)', () => {
  const p = [{ type: RET, description: { plain: 'Returns within 30 days. Refunds are processed within 60 days.' } }];
  const r = checkDisclosures({ ...items3, policies: p, messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Returns within 60 days.' }] });
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
  const ok = checkDisclosures({ ...items3, policies: p, messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Returns within 30 days; refunds take up to 60 days.' }] });
  assert.equal(ok.pass, true);
  assert.equal(checkReplyTerms({ response: { policies: p }, reply: 'Your refund will be processed within 60 days.' }).pass, true, 'refund timing is not a return window');
  assert.equal(checkReplyTerms({ response: { policies: p }, reply: 'Sorry for the 3 day wait, returns are free within 30 days.' }).pass, true, 'reply clauses must name the term');
  assert.deepEqual(checkReplyTerms({ response: { policies: p }, reply: 'You can return it within 60 days.' }).findings.map(f => f.rule), ['ucp:claim-duration-mismatch']);
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
  const deep = { a: Array.from({ length: 200 }, () => ({ b: Array.from({ length: 200 }, () => ({})) })) };
  assert.equal(governingPolicy({ ...deep, policies: [{ type: RET, description: { plain: 'r' }, applies_to: ['$.a[*].b[*]'] }] }, RET, '$.a[0].b[0]').status, 'unsupported', 'node visit cap');
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
  // CTO P1 #1 reproduction: a final-sale clause must not hide a warranty mismatch in the same sentence.
  const fw = { policies: [{ type: RET, description: { plain: 'This item is final sale and cannot be returned.' } }, { type: WAR, description: { plain: '1-year limited warranty on all items.' } }] };
  assert.deepEqual(checkReplyTerms({ response: fw, reply: 'This item is final sale, but it comes with a 2-year warranty.' }).findings.map(f => f.rule), ['ucp:claim-duration-mismatch']);
  assert.equal(checkReplyTerms({ response: fw, reply: 'This item is final sale, but it comes with a 1-year warranty.' }).pass, true);
  // Nor an affirmative return offer in another clause.
  assert.deepEqual(checkReplyTerms({ response: fw, reply: 'It is marked final sale, but you can return it within 30 days.' }).findings.map(f => f.rule), ['ucp:claim-final-sale-mismatch']);
});

test('CTO successor re-review: final-sale wording never masks an affirmative return offer (proposition-scoped)', () => {
  const FS = [{ type: RET, description: { plain: 'This item is final sale and cannot be returned.' } }];
  const disc = content => checkDisclosures({ line_items: [{ id: 'a' }], policies: FS,
    messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content }] });
  const rules = r => r.findings.map(f => f.rule);
  // Exact reproduction 1 (disclosure surface).
  const r1 = disc('This item is final sale, but you can return it within 60 days.');
  assert.equal(r1.pass, false);
  assert.deepEqual(rules(r1), ['ucp:disclosure-final-sale-mismatch']);
  for (const c of ['Final sale: you can return it within 60 days.', 'Final sale — you may return it within 60 days.',
    'Final sale, you can return it within 60 days.', 'This is final sale; however, returns are accepted within 60 days.',
    'Although this is final sale, you can return it.'])
    assert.deepEqual(rules(disc(c)), ['ucp:disclosure-final-sale-mismatch'], c);
  // Honest refusals still agree.
  for (const c of ['This item is final sale.', 'Final sale: this item cannot be returned.', 'Final sale. You cannot, under any circumstances, return it.',
    'Final sale and no returns within 60 days.', 'This item is final sale, so it cannot be returned.'])
    assert.equal(disc(c).pass, true, c);
  // Returnable policy vs a disclosure that only says final sale is still a conflict; a mixed policy is not judged.
  const ok = [{ type: RET, description: { plain: 'Returns accepted within 30 days.' } }];
  const d2 = checkDisclosures({ line_items: [{ id: 'a' }], policies: ok, messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'This item is final sale.' }] });
  assert.deepEqual(rules(d2), ['ucp:disclosure-final-sale-mismatch']);
  const mixed = [{ type: RET, description: { plain: 'Clearance items are final sale; other items can be returned within 30 days.' } }];
  const d3 = checkDisclosures({ line_items: [{ id: 'a' }], policies: mixed, messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'You can return it within 30 days.' }] });
  assert.equal(d3.pass, true);

  // Exact reproduction 2 (reply surface, colon).
  const resp = { line_items: [{ id: 'a' }], policies: FS };
  const r2 = checkReplyTerms({ response: resp, reply: 'This item is final sale: you can return it within 60 days.' });
  assert.equal(r2.pass, false);
  assert.deepEqual(rules(r2), ['ucp:claim-final-sale-mismatch']);
  for (const reply of ['Final sale — you can return it.', 'Final sale, you can return it for a full refund.', 'Although it is final sale, you may return it.', 'It is final sale; however, you can return it.'])
    assert.deepEqual(rules(checkReplyTerms({ response: resp, reply })), ['ucp:claim-final-sale-mismatch'], reply);
  for (const reply of ['This item is final sale: it cannot be returned.', 'Sorry, final sale, so you cannot return it.', 'You cannot, under any circumstances, return it.', 'Final sale, no returns.'])
    assert.equal(checkReplyTerms({ response: resp, reply }).pass, true, reply);
});

test('term attribution within one clause: a window belongs to the nearest preceding term word, else the nearest following', () => {
  // CTO retained observation: return and refund timing in one unsplit clause.
  const disc = (plain, content) => checkDisclosures({ line_items: [{ id: 'a' }], policies: [{ type: RET, description: { plain } }],
    messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content }] });
  const r = disc('Returns within 30 days with refunds processed within 60 days.', 'Returns within 60 days.');
  assert.deepEqual(r.findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
  assert.equal(disc('Returns within 30 days with refunds processed within 60 days.', 'Returns within 30 days.').pass, true);
  assert.equal(disc('Within 30 days you can return it for a refund.', 'Returns within 30 days.').pass, true, 'no preceding term: nearest following');
  assert.deepEqual(disc('30-day returns, refunds issued in 10 days.', 'Returns within 10 days.').findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
  assert.deepEqual(termDurations('Returns within 30 days with refunds processed within 60 days', 'return'), [{ n: 30, base: 'day' }]);
  assert.deepEqual(termDurations('Refunds processed within 60 days of a return', 'return'), []);
  assert.deepEqual(termDurations('within 45 days', 'return'), [{ n: 45, base: 'day' }], 'lenient: names no term');
  assert.deepEqual(termDurations('within 45 days', 'return', true), [], 'strict: must name the term');
});

test('CTO re-review of 6079423: keyword and window offsets share one normalized string', () => {
  const lig = 'ﬃ'.repeat(12) + ' Returns within 30 days with refunds processed within 60 days.';
  const resp = { line_items: [{ id: 'a' }], policies: [{ type: RET, description: { plain: lig } }],
    messages: [{ type: 'warning', code: RET, path: '$.line_items[0]', presentation: 'disclosure', content: 'Returns within 60 days.' }] };
  assert.deepEqual(checkDisclosures(resp).findings.map(f => f.rule), ['ucp:disclosure-duration-mismatch']);
  assert.deepEqual(checkReplyTerms({ response: resp, reply: 'You can return it within 60 days.' }).findings.map(f => f.rule), ['ucp:claim-duration-mismatch']);
  assert.deepEqual(termDurations(lig, 'return'), [{ n: 30, base: 'day' }]);
  // Compatibility forms in the keyword itself still attribute correctly.
  assert.deepEqual(termDurations('Ｒeturns within 30 days', 'return'), [{ n: 30, base: 'day' }]);
});
