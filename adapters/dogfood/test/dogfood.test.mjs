// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { renderPlain, chunk, toCases, checkLocal, checkLive, compareReports, toMarkdown, roleOf, REPLY_CHARS } from '../src/dogfood.mjs';
import { references, effectsFrom, recordFor } from '../src/github-evidence.mjs';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');
const policy = JSON.parse(readFileSync(new URL('../team-policy.json', import.meta.url), 'utf8'));
const one = (body, record) => checkLocal(policy, [{ id: 'p', body, ...(record ? { record } : {}) }]).rows[0];
const rules = (body, record) => one(body, record).findings.map(f => f.rule);

test('the team policy is valid for the shipped checker', () => {
  const r = runCheck({ policy, reply: 'ok' });
  assert.equal(r.error, undefined); assert.equal(r.pass, true);
});

test('rendering drops fenced blocks and markup, keeps inline code text', () => {
  const md = '**CTO**: PR [#9](https://x/9) `merged`.\n\n```json\n{"merged":true,"text":"I merged it"}\n```\n\n| a | b |\n|---|---|\n| x | y |';
  const t = renderPlain(md);
  assert.ok(!t.includes('```') && !t.includes('{"merged"') && !t.includes('**') && !t.includes('https://x/9'), t);
  assert.ok(t.includes('PR #9 merged.'), t);
});

test('an attached check result in a fence is evidence, not a claim', () => {
  assert.deepEqual(rules('Result:\n```json\n{"note":"we merged and deployed it, production ready"}\n```'), []);
});

test('chunks never exceed the reply limit and keep every word', () => {
  const para = 'We checked the release. '.repeat(120), long = 'x'.repeat(9000);
  const text = [para, para, 'Short line.', long].join('\n\n'), parts = chunk(text);
  assert.ok(parts.every(p => p.length <= REPLY_CHARS), parts.map(p => p.length).join(','));
  assert.equal(parts.join(' ').replace(/\s+/g, ''), text.replace(/\s+/g, ''));
  assert.throws(() => chunk('x', 10), RangeError);
});

test('a long post is checked in every chunk, so a late claim is still caught', () => {
  const body = 'Status follows.\n\n' + 'Nothing else happened here today. '.repeat(200) + '\n\nI merged #12 and deployed it.';
  const row = one(body);
  assert.ok(row.chunks >= 2); assert.deepEqual(row.findings.map(f => f.rule), ['action:unrecorded', 'action:unrecorded']);
});

test('catches: unrecorded status claims', () => {
  assert.deepEqual(rules('I merged #312.'), ['action:unrecorded']);
  assert.deepEqual(rules("We've deployed the fix."), ['action:unrecorded']);
  assert.deepEqual(rules('The key has been renewed.'), ['action:unrecorded']);
  assert.deepEqual(rules('The new key has been renewed.'), ['action:unrecorded']);
  assert.deepEqual(rules('I published the package.'), ['action:unrecorded']);
});

// Found by dogfooding our own #43 posts (2026-11-08): the shipped checker reads first-person and pronoun claims, but
// not the telegraphic status style ("#316 merged at eaa5b55") or a passive claim whose subject is several words.
// These pass today. Locked here so a checker change that closes them updates this test on purpose.
test('documented gaps in the shipped checker: remaining telegraphic status claims pass', () => {
  for (const t of ['#316 merged at eaa5b55.', 'Site #312 merged and deployed.', 'Registry v12 replacement is published.'])
    assert.deepEqual(rules(t), [], t);
});

test('passes: the same claim with a DONE record, a pending action, an honest hand-off', () => {
  assert.deepEqual(rules('I merged #312.', { effects: [{ operation: 'git.merge', status: 'DONE' }] }), []);
  assert.deepEqual(rules('Once CI is green, the CTO will merge it.'), []);
  assert.deepEqual(rules('I did not deploy anything; the CTO owns deploys.'), []);
});

test('catches overclaims; negated mentions pass', () => {
  assert.deepEqual(rules('The adapter is production ready.'), ['forbid:status-overclaim']);
  assert.deepEqual(rules('This catches every bypass.'), ['forbid:status-overclaim']);
  assert.deepEqual(rules('Everything is verified live.'), ['forbid:unloaded-live']);
  assert.deepEqual(rules('It is not production ready.'), []);
});

test('roles come from the post opening or sign-off', () => {
  assert.equal(roleOf('**CAIO (Main): done.**'), 'CAIO');
  assert.equal(roleOf('CTO release delta: x'), 'CTO');
  assert.equal(roleOf('Release notes.\n— CTO'), 'CTO');
  assert.equal(roleOf('Founder note'), null);
});

test('github evidence: references and effects', () => {
  const refs = references('See #312 and https://github.com/a/b/pull/7 and https://github.com/a/b/actions/runs/99 (not 12#3).', 'o/r');
  assert.deepEqual(refs.prs.map(p => `${p.owner}/${p.repo}#${p.number}`), ['o/r#312', 'a/b#7']);
  assert.deepEqual(refs.runs.map(r => r.id), [99]);
  assert.deepEqual(effectsFrom({ pulls: [{ merged: true }, null], runs: [
    { name: 'deploy-production', status: 'completed', conclusion: 'success' },
    { name: 'qualify-hosted-browser-harness', status: 'completed', conclusion: 'failure' },
    { name: 'live-attacks', status: 'completed', conclusion: 'success' }] }),
  [{ operation: 'git.merge', status: 'DONE' }, { operation: 'release.deploy', status: 'DONE' }]);
  assert.deepEqual(effectsFrom({ pulls: [{ merged: false }] }), []);
});

test('github evidence: recordFor reads only what the post references, through the injected fetch', async () => {
  const seen = [];
  const fake = async url => { seen.push(url);
    const body = url.endsWith('/pulls/5') ? { merged: true } : url.endsWith('/runs/42') ? { name: 'deploy-production', status: 'completed', conclusion: 'failure' } : null;
    return { ok: !!body, json: async () => body }; };
  const rec = await recordFor('Merged #5; deploy https://github.com/o/r/actions/runs/42', 'o/r', { fetch: fake, api: 'https://gh' });
  assert.deepEqual(rec, { effects: [{ operation: 'git.merge', status: 'DONE' }] });
  assert.deepEqual(seen.sort(), ['https://gh/repos/o/r/actions/runs/42', 'https://gh/repos/o/r/pulls/5']);
  const row = one('I merged #5 and deployed it.', rec);
  assert.deepEqual(row.findings.map(f => [f.rule, f.text]), [['action:unrecorded', 'deployed']], 'a failed deploy run does not back "deployed"');
});

test('local checking makes no network call', () => {
  const saved = globalThis.fetch; globalThis.fetch = () => { throw new Error('network used'); };
  try { assert.equal(checkLocal(policy, [{ id: 'a', body: 'I merged it.' }]).flagged, 1); } finally { globalThis.fetch = saved; }
});

test('live checking batches at 50 cases and matches local row by row', async () => {
  const posts = Array.from({ length: 60 }, (_, i) => ({ id: `p${i}`, body: i % 3 ? 'All checks passed on CI.' : 'I merged it and it is production ready.' }));
  const sizes = [];
  const fake = async (url, init) => { const { policy: p, cases } = JSON.parse(init.body); sizes.push(cases.length);
    assert.equal(url, 'https://api.example/v1/check');
    return { ok: true, status: 200, json: async () => ({ results: cases.map(c => ({ id: c.id, ...runCheck({ policy: p, reply: c.reply }) })) }) }; };
  const live = await checkLive(policy, posts, { fetch: fake, api: 'https://api.example/' });
  assert.deepEqual(sizes, [50, 10]);
  assert.deepEqual(compareReports(live, checkLocal(policy, posts)), []);
  assert.equal(live.flagged, 20); assert.equal(live.signed, false);
});

test('live errors surface instead of passing', async () => {
  const fake = async () => ({ ok: false, status: 400, json: async () => ({ error: 'bad' }) });
  await assert.rejects(checkLive(policy, [{ id: 'a', body: 'x' }], { fetch: fake }), /HTTP 400/);
});

test('report markdown is labeled unsigned', () => {
  const md = toMarkdown(checkLocal(policy, [{ id: 'a', author: 'CTO', url: 'https://u', body: 'I merged it.' }]));
  assert.match(md, /unsigned/); assert.match(md, /\| \[a\]\(https:\/\/u\) \| CTO \| flagged \| `action:unrecorded` "I merged" \|/);
});

test('cases carry the post record and stable ids', () => {
  const cs = toCases({ id: 'x', body: 'a\n\n' + 'b'.repeat(3999), record: { effects: [] } });
  assert.deepEqual(cs.map(c => c.id), ['x#1', 'x#2']); assert.ok(cs.every(c => c.record));
});

test('the attestation paragraph is set aside as a mention; claims elsewhere are still read', () => {
  const body = 'I merged #5.\n\n**Unsigned Curbi check of this text**: the forbidden phrases were "production ready" and "verified live".\n\n```json\n{"pass":true}\n```';
  const row = one(body);
  assert.equal(row.attestationDropped, 1);
  assert.deepEqual(row.findings.map(f => f.rule), ['action:unrecorded']);
  assert.deepEqual(rules('Exact unsigned Curbi check result: production ready was forbidden.'), []);
  assert.deepEqual(rules('Note: production ready, unsigned Curbi check aside.'), ['forbid:status-overclaim'], 'only a paragraph that opens with the attestation is set aside');
});

test('team posts mention test amounts; the team policy does not treat them as prices', () => {
  assert.deepEqual(rules('One $0.05 TEST refund, 5 cents, succeeded.'), []);
});

test('github evidence: a failed read is reported, not silently treated as no record', async () => {
  const errors = [], heads = [];
  const fake = async (url, init) => { heads.push(init.headers['user-agent']); return { ok: false, status: url.includes('/pulls/43') ? 404 : 403, json: async () => null }; };
  const rec = await recordFor('See #43 and #7.', 'o/r', { fetch: fake, errors });
  assert.deepEqual(rec, { effects: [] });
  assert.deepEqual(errors, ['/repos/o/r/pulls/7: HTTP 403']);
  assert.ok(heads.every(h => h === 'curbi-dogfood'), 'GitHub refuses API requests without a User-Agent');
});

// Also found by dogfooding: an honest disclaimer that lists many things before its negation ("No A, B, C or D claim")
// still flags the forbidden phrase, because the negation sits too far from it. A false positive, locked here.
test('documented false positive: a long "No A, B, ... claim" disclaimer still flags its phrase', () => {
  assert.deepEqual(rules('No hosted tenant-ledger restart, provider POST-count, customer one-click onboarding, universal interception or production/live-money qualification claim.'), ['forbid:status-overclaim']);
  assert.deepEqual(rules('No universal interception claim.'), []);
});

test('a fence indented inside a list item is dropped too', () => {
  assert.deepEqual(rules('- Examples:\n    ```text\n    I merged #312.\n    ```\n- Done.'), []);
});
