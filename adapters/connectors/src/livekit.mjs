// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// LiveKit Agents connector (voice). Curbi sits on llmNode, the one place the model's text is produced, so
// the speech (ttsNode) and the on-screen transcript (transcriptionNode) both only receive checked text.
// Text goes through the Curbi stream interceptor: sentences are released once checked; a forbidden phrase,
// unrecorded action claim or wrong price is cut before it is spoken, and the approved fallback is said instead.
// Tool-call chunks pass through untouched; their execution belongs to the gate (attested execution).
import { voice } from '@livekit/agents';
import { createStreamChecker } from '../../stream-check/src/stream.mjs';

// Transform any LiveKit llmNode stream (string | ChatChunk | FlushSentinel) into a checked stream.
export function curbiLLMStream(source, { policy, record, verify, verified, fallback, onCut }) {
  const checker = createStreamChecker({ policy, record, verify, verified, fallback });
  let cut = null;
  const text = c => typeof c === 'string' ? c : (c && c.delta && typeof c.delta.content === 'string' ? c.delta.content : null);
  const emit = (controller, s) => { if (s) controller.enqueue(s); };
  const handle = (controller, r) => {
    for (const s of r.release) emit(controller, s);
    if (r.cut && !cut) { cut = r.cut; emit(controller, (checker.spoken ? ' ' : '') + cut.fallback); onCut?.(cut); }
  };
  return new ReadableStream({
    async start(controller) {
      const reader = source.getReader ? source.getReader() : null, iter = reader ? null : source[Symbol.asyncIterator]();
      try {
        while (true) {
          const { value, done } = reader ? await reader.read() : await iter.next();
          if (done) break;
          const t = text(value);
          if (t === null) { controller.enqueue(value); continue; }                                  // tool calls, usage, flush markers
          if (typeof value !== 'string' && (value.delta.toolCalls?.length)) controller.enqueue({ ...value, delta: { ...value.delta, content: undefined } });
          if (!cut) handle(controller, checker.push(t));                                          // nothing after a cut is spoken
        }
        if (!cut) handle(controller, checker.end());
        controller.close();
      } catch (e) { controller.error(e); }
    },
  });
}

// Drop-in Agent: new CurbiAgent({ instructions, llm, tts, ..., curbi: { policy, fallback, record?, onCut? } })
export class CurbiAgent extends voice.Agent {
  #curbi;
  constructor({ curbi, ...options }) {
    if (!curbi || typeof curbi.fallback !== 'string' || !curbi.fallback) throw new Error('CurbiAgent: curbi.policy and an approved curbi.fallback are required');
    createStreamChecker({ policy: curbi.policy, fallback: curbi.fallback });            // validate the policy at construction
    super(options);
    this.#curbi = curbi;
  }
  async llmNode(chatCtx, toolCtx, modelSettings) {
    const stream = await voice.Agent.default.llmNode(this, chatCtx, toolCtx, modelSettings);
    return stream ? curbiLLMStream(stream, typeof this.#curbi.record === 'function' ? { ...this.#curbi, record: this.#curbi.record() } : this.#curbi) : stream;
  }
}

