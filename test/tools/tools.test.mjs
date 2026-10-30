// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// v36 (CAIO): validate_policy, plus fail-closed input handling for export_regression and verify_bundle.
// validate_policy uses the checker's own schema rules, then lints with probes run on the shipped checker. Nothing is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createMcpHandler } from '../../mcp/mcp-handler.mjs';
const require = createRequire(import.meta.url);
const { runCheck } = require('../../checker/check-api.js');
const V = JSON.parse(readFileSync(new URL('../../proof/vectors/cases.json', import.meta.url), 'utf8'));
const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
// A fresh handler per call keeps the per-IP burst limit out of these tests.
const call = async (name, args) => {
  const r = await createMcpHandler({ runCheck, catalog: { documents: [] }, now: () => 0 })(new Request('https://curbi.io/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
  assert.equal(r.status, 200); return (await r.json()).result;
};
const lint = async policy => (await call('validate_policy', { policy })).structuredContent;
const codes = r => r.warnings.map(w => w.code);

test('a sound policy is valid with no warnings', async () => {
  const r = await lint({ prices: [{ item: 'Starter', amount: 49 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { refunded: 'billing.refund' } });
  assert.deepEqual([r.valid, r.errors, r.warnings], [true, [], []]);
  assert.deepEqual(r.summary, { prices: 1, forbid: 1, phrases: 1, actions: 1 });
  assert.match(r.meaning, /does not show the policy is complete/);
});

test('schema errors are the same messages policy_check gives, returned as data with valid:false', async () => {
  for (const policy of [{ prices: [{ item: 'A' }] }, { forbids: [] }, { forbid: [{ id: 'Bad Id', phrases: ['x'] }] }, { actions: { refunded: 5 } }]) {
    const r = await lint(policy), pc = await call('policy_check', { policy, reply: 'x' });
    assert.equal(r.valid, false); assert.equal(pc.isError, true);
    assert.deepEqual(r.errors, [pc.structuredContent.error.message]);
  }
});

test('lint: empty policy, duplicate and overlapping items, duplicate ids and phrases, aliases that drop the item name', async () => {
  assert.deepEqual(codes(await lint({})), ['no_rules']);
  const r = await lint({ prices: [{ item: 'Pro', amount: 9 }, { item: 'Pro Plus', amount: 19 }, { item: 'pro', amount: 9 }, { item: 'Team', amount: 5, aliases: ['Teams plan'] }], forbid: [{ id: 'g', phrases: ['guarantee', 'Guarantee'] }, { id: 'g', phrases: ['refund'] }] });
  assert.equal(r.valid, true);
  for (const c of ['alias_overlap', 'duplicate_item', 'duplicate_phrase', 'duplicate_forbid_id', 'item_not_in_aliases']) assert.ok(codes(r).includes(c), c);
  assert.ok(!codes(r).includes('price_never_fires'), 'every alias is probed under its own name');
  // The overlap is still worth a warning, but the checker now resolves it: the longest name wins (v38 pass 2).
  assert.deepEqual(runCheck({ policy: { prices: [{ item: 'Pro', amount: 9 }, { item: 'Pro Plus', amount: 19 }] }, reply: 'Pro Plus is $19.' }).findings, []);
});

test('a maximal policy lints within the result limit; warnings are capped and the remainder counted', async () => {
  const policy = { prices: Array.from({ length: 50 }, (_, i) => ({ item: 'Item' + i, amount: i, aliases: Array.from({ length: 8 }, (_, k) => `a${i}x${k}`) })), forbid: Array.from({ length: 50 }, (_, i) => ({ id: 'f' + i, phrases: Array.from({ length: 20 }, (_, k) => `phrase${i}p${k}`) })) };
  const r = await call('validate_policy', { policy });
  assert.equal(r.isError, false); assert.ok(r.structuredContent.warnings.length > 0); assert.ok(r.structuredContent.warningsTruncated > 0);
  const long = n => 'L'.repeat(70) + n, worst = await call('validate_policy', { policy: { prices: Array.from({ length: 50 }, (_, i) => ({ item: long(i), amount: 1, aliases: Array.from({ length: 8 }, (_, k) => long(i * 8 + k)) })) } });
  assert.equal(worst.isError, false, 'long names still fit');
});

test('validate_policy refuses anything but one policy object, and is listed read-only', async () => {
  for (const args of [{}, { policy: [] }, { policy: null }, { policy: {}, reply: 'x' }]) { const r = await call('validate_policy', args); assert.equal(r.isError, true); assert.equal(r.structuredContent.error.type, 'invalid_request'); }
  const list = await (await createMcpHandler({ runCheck, catalog: { documents: [] } })(new Request('https://curbi.io/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) }))).json();
  const t = list.result.tools.find(x => x.name === 'validate_policy');
  assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  const src = readFileSync(new URL('../../mcp/mcp-handler.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src.slice(src.indexOf('function lintPolicy'), src.indexOf('const tools = [')), /fetch\(|put\(|localStorage|caches/);
});

test('verify_bundle: malformed known is refused up front; a receipt-less bundle says nothing was covered', async () => {
  const good = V.cases[0].bundle;
  for (const known of [[1], [null], ['x'.repeat(4097)], Array(65).fill('a'), 'a']) { const r = await call('verify_bundle', { bundle: good, keys: V.keys, allowTest: true, known }); assert.equal(r.isError, true); assert.match(r.structuredContent.error.message, /known/); }
  const empty = await call('verify_bundle', { bundle: { ...good, items: [] }, keys: V.keys, allowTest: true });
  assert.equal(empty.structuredContent.summary.receipts, 0); assert.match(empty.structuredContent.meaning, /contains no receipts, so no action is covered/);
});

test('verify_bundle: every malformed field fails closed with a reason, never ok', async () => {
  const good = V.cases[0].bundle, junk = [null, 0, '', 'x', [], {}, true, { a: { b: {} } }];
  for (const k of ['object', 'spec', 'checkpoint', 'items']) for (const j of junk) {
    if (k === 'items' && Array.isArray(j)) continue; // [] is the receipt-less case above
    const r = await call('verify_bundle', { bundle: { ...good, [k]: j }, keys: V.keys, allowTest: true });
    assert.equal(r.structuredContent.ok ?? false, false, `${k}=${JSON.stringify(j)}`);
  }
  for (const keys of [{}, { keys: 'x' }, { keys: [null, 1, 'k'] }]) assert.equal((await call('verify_bundle', { bundle: good, keys, allowTest: true })).structuredContent.ok, false);
});

test('export_regression: control and bidi characters never reach the generated test file', async () => {
  const policy = { prices: [{ item: 'S', amount: 1 }] };
  for (const args of [{ policy, reply: 'x', title: 'ok‮evil' }, { policy, reply: 'x', title: 'a\u0000b' }, { policy, cases: [{ id: 'a⁦b', reply: 'x' }] }]) {
    const r = await call('export_regression', args); assert.equal(r.isError, true); assert.match(r.structuredContent.error.message, /control or bidirectional/);
  }
  assert.equal((await call('export_regression', { policy, reply: 'x', title: 'Ünïcode ✓ fine' })).isError, false);
});
