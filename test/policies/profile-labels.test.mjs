// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// The CAIO agent profiles are labelled as verification policies, never as security products, and say what they miss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const dir = new URL('./', import.meta.url);
for (const id of ['mcp-tool-claims', 'coding-agent-claims']) test(`${id}: labelled as a verification policy, never as security`, () => {
  const t = JSON.parse(readFileSync(new URL(`${id}.json`, dir), 'utf8'));
  const text = JSON.stringify(t.template).replace(/does not detect prompt injection/g, '');
  assert.equal(t.template.category, 'ai-agents');
  assert.match(t.template.description, /^A verification policy, not a security product\./);
  assert.match(t.template.description, /does not /);
  for (const claim of [/prevents? (hacking|attacks|breaches)/i, /secures? (your )?(infrastructure|systems|data)/i, /protects? against/i, /detects? (prompt )?injection/i])
    assert.doesNotMatch(text, claim);
});
