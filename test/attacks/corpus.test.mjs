// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Corpus files in the curbi-platform attack format (revenue-engine/claimcheck-web-v14/attacks), run here against the
// exported checker with the same rule as the platform's attacks.test.mjs: every case keeps its verdict and rules, an
// attack must be caught and a guard must pass. Files starting "known-open" document bypasses and are exempt from the
// attack/guard rule. live-attacks runs the same files against the live API once they are copied to the platform.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../checker/check-api.js');
const dir = new URL('./corpus/', import.meta.url);
for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const s = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
  test(`${f}: ${s.cases.length} cases keep their verdict and rules`, () => {
    for (const c of s.cases) {
      const r = runCheck({ version: s.version, policy: s.policy, reply: c.reply, ...(c.record ? { record: c.record } : {}) });
      assert.deepEqual([r.pass, [...new Set(r.findings.map(x => x.rule))].sort()], [c.expectedPass, c.expectedRules], `${c.id}: ${c.reply}`);
      if (!f.startsWith('known-open')) assert.equal(c.expectedPass, s.guards.includes(c.id), `${c.id}: an attack must be caught, a guard must pass`);
    }
  });
}
