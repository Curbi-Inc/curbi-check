// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Policy profiles: each file is a curbi.regression. Every case must get exactly its expected verdict and rules, so a
// profile never documents a catch it misses. Cases named gap-* pass on purpose: they show what the policy cannot catch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const dir = new URL('./', import.meta.url), files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();

for (const f of files) {
  const t = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  test(`${t.template.id}: catches and passes exactly as documented`, () => {
    assert.equal(t.object, 'curbi.regression');
    assert.equal(t.template.id + '.json', f);
    assert.ok(t.cases.some(c => !c.expectedPass) && t.cases.some(c => c.expectedPass), 'needs both catches and passes');
    assert.ok(t.cases.some(c => c.id.startsWith('gap-')), 'documents at least one thing it cannot catch');
    for (const c of t.cases) {
      const r = runCheck({ version: t.version, policy: t.policy, reply: c.reply, ...(c.record ? { record: c.record } : {}) });
      const want = [c.expectedPass, c.expectedRules];
      assert.deepEqual([r.pass, [...new Set(r.findings.map(x => x.rule))].sort()], want, `${c.id}: ${c.reply}`);
    }
  });
}

test('ai-agent-verification: labelled as a verification policy, never as security', () => {
  const t = JSON.parse(readFileSync(new URL('ai-agent-verification.json', dir), 'utf8'));
  const text = JSON.stringify(t.template);
  assert.match(t.template.description, /^A verification policy, not a security product\./);
  assert.match(text, /does not detect prompt injection/);
  for (const claim of [/prevents? (hacking|attacks|breaches)/i, /secures? (your )?(infrastructure|systems|data)/i, /protects? against/i])
    assert.doesNotMatch(text, claim);
});
