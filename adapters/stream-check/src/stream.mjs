// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Streaming interceptor for voice agents. Model text arrives in small chunks; speech synthesis
// should only ever receive text that has already passed Curbi's checks.
//
// - A sentence is released to the synthesiser only once it is complete and checked with all prior context.
//   (Voice pipelines synthesise per sentence or clause anyway, so this adds only the check's own time.)
// - Forbidden phrases and action claims are final as soon as their words are complete, so they cut the
//   stream mid-sentence, before the sentence is ever released.
// - Price findings need the whole sentence (the item can come after the amount), so they cut at sentence end.
// On a cut, nothing after the last released sentence is spoken; the contract's approved fallback line is.
// Same engine as the Check API (no fork): the result for the full text equals the batch result.
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

const EARLY = /^(?:forbid:|action:)/;                              // final as soon as the words are complete
const SENTENCE_END = /[.!?](?=\s)/g;                              // needs following whitespace: '$49.' may still become '$49.50'
const ACTIVE_WORD = /[\p{L}\p{N}$'’-]$/u;                         // chunk ends mid-word: the last word may still grow

// verified: the result of verifyReceipts() for this record (server side), so signed receipts count as proof.
export function createStreamChecker({ policy, record, verify, verified, fallback, maxChars = 4000 }) {
  // Bind the stream to the configuration admitted at construction.
  policy = structuredClone(policy);
  record = record === undefined ? undefined : structuredClone(record);
  verify = verify === undefined ? undefined : structuredClone(verify);
  verified = verified === undefined ? undefined : structuredClone(verified);
  if (typeof fallback !== 'string' || !fallback) throw new Error('an approved fallback line is required');
  if(!Number.isInteger(maxChars)||maxChars<1||maxChars>4000)throw new Error('maxChars must be an integer from1 to4000');
  const fb=runCheck({policy,reply:fallback,...(record?{record}:{}),...(verify?{verify}:{})},verified?[verified]:undefined);if(!fb.pass)throw new Error('fallback violates the configured policy');
  runCheck({ policy, reply: 'ok', ...(record ? { record } : {}), ...(verify ? { verify } : {}) });   // validate policy up front
  let text = '', released = 0, done = false, cut = null;
  const check = upto => runCheck({ policy, reply: text.slice(0, upto) || ' ', ...(record ? { record } : {}), ...(verify ? { verify } : {}) }, verified ? [verified] : undefined).findings.filter(f => f.rule !== 'empty');
  const stop = (finding) => { done = true; cut = { finding, fallback, releasedChars: released }; return { release: [], cut }; };

  function step(final) {
    if (done) return { release: [], cut };
    const out = [];
    // 1. early cut: a complete forbidden phrase or action claim anywhere in the unreleased text
    const stable = final || !ACTIVE_WORD.test(text) ? text.length : text.search(/\S+$/);
    if (stable > released) {
      const early = check(stable).find(f => EARLY.test(f.rule) && f.span[1] > released && f.span[1] <= stable);
      if (early) return stop(early);
    }
    // 2. release each complete sentence that passes with all prior context
    const ends = [...text.matchAll(SENTENCE_END)].map(m => m.index + 1).filter(e => e > released);
    if (final && text.length > released) ends.push(text.length);
    for (const end of ends) {
      const bad = check(end).find(f => f.span[1] > released && f.span[0] < end);
      if (bad) {const r=stop(bad);return {...r,release:out};}
      out.push(text.slice(released, end)); released = end;
    }
    return { release: out, cut: null };
  }
  return {
    push(chunk) { if (done) return { release: [], cut }; text += String(chunk); if (text.length > maxChars) return stop({ rule: 'stream:too_long', span: [maxChars, text.length], text: '', why: 'Reply exceeded the checked length.' }); return step(false); },
    end() { const r = step(true); done = true; return r; },
    get spoken() { return text.slice(0, released); },
  };
}

