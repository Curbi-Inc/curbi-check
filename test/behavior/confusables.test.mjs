// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// look-alike letters (UTS #39 confusables for Latin lowercase) substituted one at a time into a forbidden phrase.
// Found from adversarial review #2: "gµarantee" (micro sign, NFKC -> Greek mu) passed silently. The sweep showed the class:
// 21 misses across 15 characters. Recorded as todo first, then fixed. Every substitution must be caught.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const P = { forbid: [{ id: 'guarantee', phrases: ['guarantee'] }] };
export const LOOKALIKES = { a: 'аɑαⱥ', c: 'сϲⅽ', e: 'еєҽ℮', g: 'ɡց', i: 'іιⅰɩ', n: 'ոп', o: 'оοօ', p: 'рρ', r: 'гᴦ', t: 'тτ', u: 'υսµμʋ', v: 'νѵ', x: 'хχ', y: 'уγ' };
const FIXED_LATER = new Set(''); // all 21 misses from the first commit are fixed and are guards now
const word = 'guarantee';
for (let i = 0; i < word.length; i++) for (const s of LOOKALIKES[word[i]] || '') {
  const w = word.slice(0, i) + s + word.slice(i + 1);
  test(`${w} (U+${s.codePointAt(0).toString(16).toUpperCase()} for "${word[i]}") is caught`, FIXED_LATER.has(s) ? { todo: 'look-alike sweep: fix in this PR' } : {}, () =>
    assert.deepEqual(runCheck({ policy: P, reply: `We ${w} results.` }).findings.map(f => f.rule), ['forbid:guarantee']));
}
test('folding look-alikes does not create findings in ordinary text', () => {
  for (const reply of ['We do not guarantee results.', 'Мы гарантируем результат.', 'The μ-controller costs nothing extra.', 'Ⓒ 2026 Curbi'])
    assert.deepEqual(runCheck({ policy: P, reply }).findings, [], reply);
});
