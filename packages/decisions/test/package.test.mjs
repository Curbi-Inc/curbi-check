// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// The package ships the reviewed adapter byte for byte, and the Python port's parity vectors are regenerated from it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const at = p => fileURLToPath(new URL(p, import.meta.url));

test('the package source is byte-identical to the reviewed adapter', () => {
  assert.ok(readFileSync(at('../src/decisions.mjs')).equals(readFileSync(at('../../../adapters/decisions/src/decisions.mjs'))));
});
test('the Python parity vectors are current with the adapter', () => {
  const fresh = execFileSync(process.execPath, [at('../../decisions-py/tests/make_vectors.mjs')], { maxBuffer: 64 << 20 });
  assert.ok(fresh.equals(readFileSync(at('../../decisions-py/tests/vectors.json'))), 'regenerate: node packages/decisions-py/tests/make_vectors.mjs > packages/decisions-py/tests/vectors.json');
});
test('the package exports what its types declare', async () => {
  const m = await import('../src/decisions.mjs');
  for (const k of ['CHECKER', 'normalizeSystemone', 'normalizeDecisions', 'compileDecisionPolicy', 'route', 'decisionReceipt', 'checkAction', 'canonical', 'digest']) assert.ok(k in m, k);
  const dts = readFileSync(at('../src/index.d.ts'), 'utf8');
  for (const k of Object.keys(m)) assert.match(dts, new RegExp(`\\b${k}\\b`), `${k} is typed`);
  const pkg = JSON.parse(readFileSync(at('../package.json'), 'utf8'));
  assert.equal(m.CHECKER, `curbi-check/decisions ${pkg.version}`);
});
