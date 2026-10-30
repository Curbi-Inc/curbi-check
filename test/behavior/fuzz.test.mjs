// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// CAIO fuzz pass (2026-10-29): 10 malformed-input classes against validate_policy, export_regression, verify_bundle
// and policy_check over MCP. Invariants for every input: no exception escapes the handler, no 5xx, every refusal is
// typed, nothing malformed verifies or passes, Object.prototype stays clean, and CPU stays bounded at the body limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createMcpHandler, MCP_LIMITS } from '../../mcp/mcp-handler.mjs';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const V = JSON.parse(readFileSync(new URL('../../proof/vectors/cases.json', import.meta.url), 'utf8')), good = V.cases[0].bundle;
const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18' };
const P = { prices: [{ item: 'Starter', amount: 49 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { refunded: 'billing.refund' } };
// A fresh handler per request keeps the burst limit out of the way. Deep values are spliced in as JSON text.
const raw = async body => { const r = await createMcpHandler({ runCheck, catalog: { documents: [] }, now: () => 0 })(new Request('https://curbi.io/api/mcp', { method: 'POST', headers: H, body })); assert.ok(r.status < 500, 'no 5xx'); return { status: r.status, j: await r.json() }; };
const DEEP = n => '{"a":'.repeat(n) + '{}' + '}'.repeat(n);
const body = (name, args) => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }).replace(/"@DEEP(\d+)"/g, (_, n) => DEEP(+n));
const call = async (name, args) => (await raw(body(name, args))).j;
const refused = async (name, args, re) => { const j = await call(name, args); const sc = j.result?.structuredContent; assert.ok(j.error || j.result?.isError, `${name} must refuse ${body(name, args).slice(0, 120)}`); if (j.result) assert.ok(sc.error.type && sc.error.message, 'typed error'); if (re) assert.match(j.error?.message ?? sc.error.message, re); return j; };
const accepted = async (name, args) => { const j = await call(name, args); assert.equal(j.result?.isError, false, JSON.stringify(j).slice(0, 200)); return j.result.structuredContent; };

test('C1 deep nesting: refused before parsing in every slot; the echo that used to overflow the stack cannot be reached', async () => {
  for (const d of [65, 3000, 10000, 13000]) for (const [name, args] of [['validate_policy', { policy: '@DEEP' + d }], ['export_regression', { policy: P, reply: "I've refunded you.", record: { effects: [{ operation: 'billing.refund', status: 'DONE', extra: '@DEEP' + d }] } }], ['verify_bundle', { bundle: { ...good, items: ['@DEEP' + d] }, keys: V.keys, allowTest: true }], ['policy_check', { policy: P, reply: 'x', record: '@DEEP' + d }]]) {
    const b = body(name, args), { status, j } = await raw(b);
    if (new TextEncoder().encode(b).byteLength > MCP_LIMITS.bodyBytes) { assert.equal(status, 413); continue; }   // the size limit refuses it first
    assert.equal(status, 400); assert.match(j.error.message, /nests deeper than 64 levels/);
  }
  assert.equal(MCP_LIMITS.depth, 64);
  // Brackets inside strings are text, not nesting; ordinary depth is untouched.
  assert.equal((await accepted('policy_check', { policy: P, reply: '['.repeat(3000) })).pass, true);
  assert.equal((await accepted('export_regression', { policy: P, reply: "I've refunded you.", record: { effects: [{ operation: 'billing.refund', status: 'DONE' }] } })).regression.cases[0].expectedPass, true);
});

test('C2 lone surrogates, bidi, combining storms, ZWJ emoji and NUL: no exception, output stays valid JSON, spans stay in range', async () => {
  for (const u of ['\ud800', '\udfff', 'a\ud83dz', '‮⁦x', 'e' + '́'.repeat(3990), '👩‍👩‍👧‍👦'.repeat(100), '\u0000', '﻿Starter is $99.']) {
    const r = await accepted('policy_check', { policy: P, reply: u });
    for (const f of r.findings) assert.ok(f.span[0] >= 0 && f.span[1] <= u.length && f.span[0] <= f.span[1]);
    await call('validate_policy', { policy: { prices: [{ item: u.slice(0, 80), amount: 1 }], forbid: [{ id: 'x', phrases: [u.slice(0, 80)] }] } });
    const ex = await call('export_regression', { policy: P, reply: u });
    if (!ex.result.isError) assert.doesNotThrow(() => JSON.parse(JSON.parse(ex.result.content[0].text).testFile.contents.match(/JSON\.parse\((".*")\);/)[1]));
    assert.equal((await call('verify_bundle', { bundle: { ...good, checkpoint: u }, keys: V.keys, allowTest: true })).result.structuredContent.ok, false);
  }
  await refused('export_regression', { policy: P, reply: 'x', title: 'a‮b' }, /control or bidirectional/);
});

test('C3 boundary sizes: every limit accepts its maximum and refuses one more', async () => {
  const rep = (k, f) => Array.from({ length: k }, (_, i) => f(i));
  for (const [ok, over] of [
    [{ policy: P, reply: 'a'.repeat(4000) }, { policy: P, reply: 'a'.repeat(4001) }],
    [{ policy: P, reply: '😀'.repeat(2000) }, { policy: P, reply: '😀'.repeat(2000) + 'a' }],
    [{ policy: P, cases: rep(50, () => ({ reply: 'x' })) }, { policy: P, cases: rep(51, () => ({ reply: 'x' })) }],
    [{ policy: P, cases: [{ id: 'i'.repeat(60), reply: 'x' }] }, { policy: P, cases: [{ id: 'i'.repeat(61), reply: 'x' }] }],
    [{ policy: { forbid: [{ id: 'x', phrases: rep(20, i => 'p' + i) }] }, reply: 'x' }, { policy: { forbid: [{ id: 'x', phrases: rep(21, i => 'p' + i) }] }, reply: 'x' }],
    [{ policy: { forbid: [{ id: 'x', phrases: ['p'.repeat(80)] }] }, reply: 'x' }, { policy: { forbid: [{ id: 'x', phrases: ['p'.repeat(81)] }] }, reply: 'x' }],
    [{ policy: { prices: [{ item: 'S', amount: 1, aliases: rep(8, i => 'a' + i) }] }, reply: 'x' }, { policy: { prices: [{ item: 'S', amount: 1, aliases: rep(9, i => 'a' + i) }] }, reply: 'x' }],
  ]) for (const name of ['policy_check', 'export_regression']) { await accepted(name, ok); await refused(name, over); }
  await accepted('export_regression', { policy: P, reply: 'x', title: 't'.repeat(80) }); await refused('export_regression', { policy: P, reply: 'x', title: 't'.repeat(81) });
  await accepted('verify_bundle', { bundle: good, keys: V.keys, allowTest: true, known: Array(64).fill('k'.repeat(4096)).slice(0, 12) });
  await refused('verify_bundle', { bundle: good, keys: V.keys, allowTest: true, known: Array(65).fill('a') }); await refused('verify_bundle', { bundle: good, keys: V.keys, allowTest: true, known: ['k'.repeat(4097)] });
  const pad = n => JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'validate_policy', arguments: { policy: { description: 'd'.repeat(n) } } } }), base = pad(0).length;
  assert.equal((await raw(pad(MCP_LIMITS.bodyBytes - base))).j.result.structuredContent.valid, true, 'exactly 64 KiB is accepted');
  assert.equal((await raw(pad(MCP_LIMITS.bodyBytes - base + 1))).status, 413, 'one byte more is refused');
});

test('C4 conflicting fields are refused, never resolved silently', async () => {
  await refused('validate_policy', { policy: P, reply: 'x' }); await refused('export_regression', { policy: P, reply: 'x', cases: [{ reply: 'y' }] }, /not both/);
  await refused('export_regression', { policy: P, reply: 'x', verify: 'required' }); await refused('export_regression', { policy: P, reply: 'x', record: { receipts: [] } });
  await refused('export_regression', { policy: P, reply: 'x', version: '2026-10-27' }); await refused('export_regression', { policy: P, cases: [{ reply: 'x', expectedPass: true }] });
  await refused('verify_bundle', { bundle: good, keys: V.keys, trustBundleKeys: true }); await refused('verify_bundle', { bundle: good, keys: V.keys, mode: 'live' });
  assert.equal((await accepted('validate_policy', { policy: { prices: [{ item: 'S', amount: 1, amounts: [1] }] } })).valid, false);
  assert.equal((await accepted('validate_policy', { policy: { unknownAmounts: 'ignore' } })).valid, false);
});

test('C5 prototype keys are plain data: unknown fields are refused and Object.prototype is never touched', async () => {
  for (const k of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal((await raw(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_policy","arguments":{"policy":{"${k}":{"polluted":1}}}}}`)).j.result.structuredContent.valid, false, k);
    assert.equal((await raw(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"export_regression","arguments":{"policy":{},"reply":"x","${k}":{"polluted":1}}}}`)).j.result.isError, true, k);
    assert.equal((await raw(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"verify_bundle","arguments":{"bundle":{"${k}":{"object":"curbi.proof.bundle"}},"keys":{"keys":[]}}}}`)).j.result.structuredContent.ok, false, k);
    const ids = (await accepted('policy_check', { policy: P, cases: [{ id: k, reply: 'x' }, { reply: 'y' }] })).results.map(r => r.id); assert.deepEqual(ids, [k, '1']);
  }
  const verb = await accepted('policy_check', { policy: { actions: { constructor: 'x.build' } }, reply: "I've constructor it." });
  assert.deepEqual(verb.findings.map(f => f.rule), ['action:unrecorded'], 'a verb named like a prototype key is just a verb');
  assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted'), false);
});

test('C6 numeric extremes: non-finite and non-number amounts are refused; unrepresentable prices are linted, not trusted', async () => {
  assert.equal((await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_policy","arguments":{"policy":{"prices":[{"item":"S","amount":1e999}]}}}}')).j.result.structuredContent.valid, false, '1e999 parses to Infinity');
  assert.equal((await raw('{"jsonrpc":"2.0","id":1e999,"method":"tools/list","params":{}}')).status, 400, 'id Infinity is not a JSON-RPC id');
  for (const amount of [-1, '9', true, [9], null]) assert.equal((await accepted('validate_policy', { policy: { prices: [{ item: 'S', amount }] } })).valid, false, JSON.stringify(amount));
  for (const amount of [0, -0, 5e-324, 1e308]) { const r = await accepted('validate_policy', { policy: { prices: [{ item: 'S', amount }] } }); assert.equal(r.valid, true); assert.ok(!r.warnings.some(w => w.code === 'amount_unmatchable'), String(amount)); }
  const lint = await accepted('validate_policy', { policy: { prices: [{ item: 'X', amount: 9.999 }, { item: 'Y', amounts: [1.5, 0.1, 2.25] }] } });
  assert.deepEqual(lint.warnings.map(w => [w.code, w.path]), [['amount_unmatchable', 'policy.prices[0].amount']], 'only the 3-decimal price, and no false price_never_fires');
  assert.deepEqual((await accepted('policy_check', { policy: P, reply: 'Starter is $' + '9'.repeat(3000) + '.' })).findings.map(f => f.rule), ['price:mismatch'], 'an over-long amount is still flagged');
  // Review catch: a length-bounded digit pattern read the tail of this number as 49, a silent pass. The whole run is one number.
  for (const r of ['Starter is 1,000,000,000,000,000,000,000,000,049 dollars.', 'Starter is $1,000,000,000,000,000,000,000,000,049.']) assert.deepEqual((await accepted('policy_check', { policy: P, reply: r })).findings.map(f => [f.rule, f.text.includes('1,000,000,000,000,000,000,000,000,049')]), [['price:mismatch', true]], r);
  assert.deepEqual((await accepted('policy_check', { policy: P, reply: 'Starter is 1,1,1,49 dollars.' })).findings.map(f => f.rule), ['price:malformed']);
});

test('C7 type confusion is refused with the path that is wrong', async () => {
  for (const [name, args, re] of [
    ['validate_policy', { policy: [] }], ['export_regression', { policy: P, cases: [{ id: 5, reply: 'x' }] }, /id/], ['export_regression', { policy: P, cases: [null] }],
    ['verify_bundle', { bundle: good, keys: V.keys, allowTest: 'true' }], ['verify_bundle', { bundle: good, keys: [] }], ['policy_check', { policy: P, cases: [{ id: 5, reply: 'x' }] }, /cases\[0\]\.id/],
    ['policy_check', { policy: P, cases: [{ id: 'i'.repeat(61), reply: 'x' }] }, /at most 60 characters/],
  ]) await refused(name, args, re);
  for (const policy of [{ prices: {} }, { forbid: 'guarantee' }, { forbid: [{ id: 'x', phrases: 'x' }] }]) assert.equal((await accepted('validate_policy', { policy })).valid, false);
  for (const bundle of [{ ...good, items: {} }, { ...good, history: 'x' }]) assert.equal((await accepted('verify_bundle', { bundle, keys: V.keys, allowTest: true })).ok, false);
});

test('C8 CPU at the 64 KiB body limit: amount and name storms are linear (they were amounts x names x length)', () => {
  const HP = { prices: Array.from({ length: 50 }, (_, i) => ({ item: 'Pro Plus' + ' x'.repeat(i % 5), amount: i, aliases: Array.from({ length: 8 }, (_, k) => 'Pro' + ' Plus'.repeat(k)) })), forbid: Array.from({ length: 50 }, (_, i) => ({ id: 'f' + i, phrases: Array.from({ length: 20 }, (_, k) => 'a '.repeat(36) + i + 'x' + k) })) };
  const SP = { prices: [{ item: 'Pro', amount: 9, aliases: Array.from({ length: 8 }, (_, k) => 'Pro' + ' Plus'.repeat(k)) }] };
  for (const [w, reply] of Object.entries({ 'dollar storm': '$1 '.repeat(1333), 'names and dollars': 'Pro Plus $1 '.repeat(333), 'digit run': '1,'.repeat(1999) + '1', 'names only': 'Pro Plus '.repeat(444), 'cents': '99 cents '.repeat(444), 'free claims': 'Pro Plus is free '.repeat(235), 'ranges': '$1-2 '.repeat(800) })) for (const policy of [HP, SP]) {
    const one = { reply: reply.slice(0, 4000) }; let k = 50; while (k > 1 && JSON.stringify({ policy, cases: Array(k).fill(one) }).length > 65536) k--;
    const t = performance.now(); runCheck({ policy, cases: Array(k).fill(one) }); const ms = performance.now() - t;
    // Locally 16-62 ms after this PR; 224-855 ms before it. The bound leaves ~8x headroom for slower CI machines.
    assert.ok(ms < 500, `${w}, ${k} cases: ${ms.toFixed(0)} ms`);
  }
});

test('C9 transport garbage: each is a JSON-RPC error with a 4xx status, never a crash', async () => {
  for (const b of ['nope', '{"jsonrpc":"2.0","id":1,"method":"tools/list"} x', '[{"jsonrpc":"2.0","id":1,"method":"tools/list"}]', '{"jsonrpc":"2.0","id":{},"method":"tools/list"}', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":[]}', '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_policy","arguments":[]}}', '{"jsonrpc":"1.0","id":1,"method":"tools/list"}', new Uint8Array([0x7b, 0xff, 0xfe, 0x7d])]) {
    const { status, j } = await raw(b); assert.ok(status >= 400 && status < 500 || j.error, String(b).slice(0, 40)); assert.ok(j.error.code < 0);
  }
  const unknown = await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"write_file","arguments":{}}}'); assert.equal(unknown.j.error.message, 'Unknown tool');
});

test('C10 duplicate JSON keys: last value wins, deterministically, before any check runs', async () => {
  assert.equal((await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_policy","arguments":{"policy":{"prices":[{"item":"S","amount":1}]},"policy":[]}}}')).j.result.isError, true);
  assert.equal((await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"policy_check","arguments":{"policy":{"prices":[{"item":"S","amount":"x","amount":1}]},"reply":"S is $1."}}}')).j.result.structuredContent.pass, true);
  assert.equal((await raw('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"verify_bundle","name":"write_file","arguments":{}}}')).j.error.message, 'Unknown tool');
});

test('defence in depth: an unexpected throw inside any tool is a typed tool_failed error with no verdict', async () => {
  const h = createMcpHandler({ runCheck: () => { throw new RangeError('boom'); }, catalog: { documents: [] } });
  for (const name of ['policy_check', 'export_regression', 'validate_policy']) {
    const j = await (await h(new Request('https://curbi.io/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { policy: P, ...(name === 'validate_policy' ? {} : { reply: 'x' }) } } }) }))).json();
    assert.equal(j.result.isError, true, name); assert.match(j.result.structuredContent.error.type, /_failed$/, name);
    assert.ok(!('pass' in j.result.structuredContent) && !('valid' in j.result.structuredContent), 'no verdict');
  }
  // A result that cannot be serialized (here a BigInt; in the wild, input deep enough to overflow the stack) used to
  // throw outside every inner try and out of the Worker. Now it is caught at the dispatch boundary.
  // export_regression builds and serializes its suite outside its inner try; a throw there is the case to catch.
  const throwsLate = createMcpHandler({ runCheck: () => ({ pass: true, get findings() { throw new RangeError('Maximum call stack size exceeded'); } }), catalog: { documents: [] } });
  const j = await (await throwsLate(new Request('https://curbi.io/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'export_regression', arguments: { policy: P, reply: 'x' } } }) }))).json();
  assert.equal(j.result.structuredContent.error.type, 'tool_failed'); assert.ok(!('regression' in j.result.structuredContent));
});
