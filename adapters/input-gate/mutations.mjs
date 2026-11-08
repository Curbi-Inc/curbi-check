#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Proves the "never" tests bite: breaks each boundary in the source, one at a time, and requires at least one test to
// fail. The source is restored in a finally block. Run: node adapters/input-gate/mutations.mjs (exit 1 if any is missed).
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const src = fileURLToPath(new URL('./src/input-gate.mjs', import.meta.url)), testFile = fileURLToPath(new URL('./test/input-gate.test.mjs', import.meta.url));
const orig = readFileSync(src, 'utf8');
const MUTATIONS = {
  'add a network call (AI or remote judge)': ['export function contextCheck(rawItem, policy, registry, ctx) {', "export function contextCheck(rawItem, policy, registry, ctx) {\n  if (globalThis.__judge) fetch('https://judge.example');"],
  'import a model SDK': ["import { createRequire } from 'node:module';", "import { createRequire } from 'node:module';\nimport 'openai';"],
  'stop refusing judge, model and remote policy fields': ['    if (NO_JUDGE.test(k)) bad(', '    if (false) bad('],
  'trust a supplied check verdict': ['return d === digest(rec); });', 'return true; });'],
  'trust the manifest digest as given': ["if (!turn?.manifest || turn.manifest_digest !== digest(turn.manifest)) deny('manifest_digest_mismatch');", ''],
  'let model output supply a tuple': ["(item.class === 'tool' || item.class === 'state')", "(item.class === 'tool' || item.class === 'state' || item.class === 'model')"],
  'let an item vouch for itself': ['  const provenance = verifyProvenance(', "  const provenance = json?.verified === true ? { result: 'verified', key_id: null, fresh: true, reason: null } : verifyProvenance("],
  'use a key supplied inside the input': ['for (const k of ENVELOPE_KEY_FIELDS) if (Object.hasOwn(env, k)) return', 'for (const k of []) if (Object.hasOwn(env, k)) return'],
  'let the grant cap supply the tuple': ["  if (!source) deny('tuple_provenance_unverified');", "  if (!source && !(amount <= grant.max_amount_minor)) deny('tuple_provenance_unverified');"],
};
let missed = 0;
try {
  for (const [name, [a, b]] of Object.entries(MUTATIONS)) {
    if (!orig.includes(a)) { console.log(`STALE  | ${name}: anchor not found`); missed++; continue; }
    writeFileSync(src, orig.replace(a, b));
    const r = spawnSync(process.execPath, ['--test', testFile], { encoding: 'utf8' });
    const fails = r.stdout.split('\n').filter(l => l.startsWith('not ok')).length;
    console.log(`${fails ? 'CAUGHT' : 'MISSED'} | ${name} | ${fails} failing test(s)`); if (!fails) missed++;
  }
} finally { writeFileSync(src, orig); }
process.exit(missed ? 1 : 0);
