// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Runs the real LiveKit Agents package (@livekit/agents@1.9.2): CurbiAgent extends voice.Agent and its llmNode
// override wraps the framework's own default llmNode. The model stream is a fixture (no LiveKit server, no inference).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voice } from '@livekit/agents';
import { CurbiAgent, curbiLLMStream } from '../src/livekit.mjs';
const FALLBACK = 'I need to transfer you to a manager to approve that rate.';
const policy = { prices: [{ item: 'Pro annual', amount: 500 }], forbid: [{ id: 'guarantee', phrases: ['guarantee'] }], actions: { applied: 'billing.invoice.apply_discount' }, unknownAmounts: 'allow' };
const chunk = (content, i) => ({ id: 'c' + i, delta: { role: 'assistant', content } });
const fromArray = items => new ReadableStream({ start(c) { items.forEach(x => c.enqueue(x)); c.close(); } });
const drain = async s => { const out = [], r = s.getReader(); for (;;) { const { value, done } = await r.read(); if (done) return out; out.push(value); } };
const said = out => out.filter(x => typeof x === 'string').join('');

test('clean model output reaches TTS and transcript whole (ChatChunk deltas)', async () => {
  const out = await drain(curbiLLMStream(fromArray(['Thanks for ', 'calling. Pro annual is ', '$500 a year.'].map(chunk)), { policy, fallback: FALLBACK }));
  assert.equal(said(out), 'Thanks for calling. Pro annual is $500 a year.');
});
test('a promise is cut mid-sentence; only the approved fallback follows', async () => {
  let cut; const out = await drain(curbiLLMStream(fromArray(['Thanks for calling. ', 'We guar', 'antee the ', 'best rate. Pro annual is $1.'].map(chunk)), { policy, fallback: FALLBACK, onCut: c => { cut = c; } }));
  assert.equal(said(out), 'Thanks for calling. ' + FALLBACK); assert.equal(cut.finding.rule, 'forbid:guarantee');
});
test('an unrecorded "applied" claim is never spoken; tool-call chunks and flush markers pass through', async () => {
  const marker = { flush: true }, toolChunk = { id: 't', delta: { role: 'assistant', toolCalls: [{ name: 'apply_discount' }] } };
  const out = await drain(curbiLLMStream(fromArray([chunk("I've applied ", 0), toolChunk, marker, chunk('a $50 discount.', 1)]), { policy, fallback: FALLBACK }));
  assert.equal(said(out), FALLBACK); assert.ok(out.includes(marker)); assert.ok(out.some(x => x?.delta?.toolCalls));
});
test('a recorded action passes when the record is supplied', async () => {
  const out = await drain(curbiLLMStream(fromArray(["I've applied a $50 discount."].map(chunk)), { policy, fallback: FALLBACK, record: { effects: [{ operation: 'billing.invoice.apply_discount', status: 'DONE' }] } }));
  assert.equal(said(out), "I've applied a $50 discount.");
});
test('CurbiAgent is a real voice.Agent whose llmNode wraps the framework default', async () => {
  const agent = new CurbiAgent({ instructions: 'Help with billing.', curbi: { policy, fallback: FALLBACK } });
  assert.ok(agent instanceof voice.Agent);
  const original = voice.Agent.default.llmNode;
  let calledWith;
  voice.Agent.default.llmNode = async (a, ...rest) => { calledWith = a; return fromArray(['Sure. ', 'We guarantee it.'].map(chunk)); };
  try { assert.equal(said(await drain(await agent.llmNode(null, {}, {}))), 'Sure. ' + FALLBACK); assert.equal(calledWith, agent); }
  finally { voice.Agent.default.llmNode = original; }
});
test('CurbiAgent refuses construction without an approved fallback or with an invalid policy', () => {
  assert.throws(() => new CurbiAgent({ instructions: 'x', curbi: { policy } }));
  assert.throws(() => new CurbiAgent({ instructions: 'x', curbi: { policy: { forbids: [] }, fallback: FALLBACK } }));
});

