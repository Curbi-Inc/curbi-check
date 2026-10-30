// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Runs the real Vercel AI SDK (ai@7.0.138: generateText, streamText, wrapLanguageModel) with its own mock model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, streamText, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { curbiMiddleware } from '../src/ai-sdk.mjs';
const FALLBACK = 'I need to transfer you to a manager to approve that rate.';
const policy = { prices: [{ item: 'Pro', amount: 49 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { applied: 'billing.discount' } };
const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
const genModel = text => new MockLanguageModelV4({ doGenerate: async () => ({ content: [{ type: 'text', text }], finishReason: { unified: 'stop', raw: 'stop' }, usage, warnings: [] }) });
const streamModel = deltas => new MockLanguageModelV4({ doStream: async () => ({ stream: convertArrayToReadableStream([
  { type: 'stream-start', warnings: [] }, { type: 'text-start', id: 't1' }, ...deltas.map(delta => ({ type: 'text-delta', id: 't1', delta })), { type: 'text-end', id: 't1' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }]) }) });
const wrap = model => wrapLanguageModel({ model, middleware: curbiMiddleware({ policy, fallback: FALLBACK }) });

test('generateText: a clean reply passes through untouched, with curbi metadata', async () => {
  const r = await generateText({ model: wrap(genModel('Pro is $49 a month.')), prompt: 'price?' });
  assert.equal(r.text, 'Pro is $49 a month.'); assert.equal(r.providerMetadata.curbi.pass, true);
});
test('generateText: a wrong price is replaced by the approved fallback; findings are exposed', async () => {
  const r = await generateText({ model: wrap(genModel('Good news, Pro is $39 for you.')), prompt: 'price?' });
  assert.equal(r.text, FALLBACK); assert.deepEqual(r.providerMetadata.curbi.findings.map(f => f.rule), ['price:mismatch']);
});
test('generateText: an unrecorded action claim is replaced', async () => {
  const r = await generateText({ model: wrap(genModel("I've applied a $50 discount.")), prompt: 'discount' });
  assert.equal(r.text, FALLBACK); assert.ok(r.providerMetadata.curbi.findings.some(f => f.rule === 'action:unrecorded'));
});
test('streamText: clean stream arrives whole, sentence by sentence', async () => {
  const r = streamText({ model: wrap(streamModel(['Thanks for ', 'calling. Pro is ', '$4', '9 a month.'])), prompt: 'x' });
  assert.equal(await r.text, 'Thanks for calling. Pro is $49 a month.');
  assert.equal((await r.providerMetadata).curbi.pass, true);
});
test('streamText: the violating sentence never reaches the client; the fallback does', async () => {
  const r = streamText({ model: wrap(streamModel(['Thanks for calling. ', 'We guar', 'antee you ', 'will love it. ', 'Pro is $39.'])), prompt: 'x' });
  const parts = []; for await (const t of r.textStream) parts.push(t);
  const all = parts.join('');
  assert.equal(all, 'Thanks for calling. ' + FALLBACK); assert.doesNotMatch(all, /guar|\$39/);
  assert.equal((await r.providerMetadata).curbi.finding.rule, 'forbid:guarantee');
});
test('invalid policy or missing fallback fails at setup, not mid-conversation', () => {
  assert.throws(() => curbiMiddleware({ policy: { forbids: [] }, fallback: FALLBACK }));
  assert.throws(() => curbiMiddleware({ policy }));
});

