// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Dogfood: run Curbi's own team outputs (issue comments, commit messages) through the Curbi checker before they are
// posted, and again afterwards as a report. Deterministic: rendering, chunking and checking are pure functions.
// The only network calls are the optional live check (checkLive) and the optional GitHub evidence read
// (github-evidence.mjs), and both take an injected fetch so tests stay offline.
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

export const REPLY_CHARS = 4000;   // the checker's per-reply limit
export const BATCH_CASES = 50;     // the checker's per-request case limit

// Markdown to the plain text a reader sees. Fenced blocks are dropped: in our posts they hold the attached check
// result JSON or code, which is evidence, not a claim. Inline code keeps its text, since `merged` in backticks
// still reads as a claim.
export function renderPlain(md) {
  if (typeof md !== 'string') throw new TypeError('post body must be a string');
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, '')
    .replace(/!?\[([^\]]*)\]\([^)\s]*\)/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*\|?[-:\s|]+\|[-:\s|]*$/gm, '')
    .replace(/\s*\|\s*/g, ' | ')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,:;!?]|$)/g, '$1$2')
    .replace(/^-{3,}\s*$/gm, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Split at paragraph, then line, then sentence boundaries so no chunk exceeds the reply limit and no claim is cut
// in half unless a single sentence is itself longer than the limit.
export function chunk(text, max = REPLY_CHARS) {
  if (!Number.isInteger(max) || max < 100) throw new RangeError('max must be an integer >= 100');
  const out = []; let cur = '';
  const pieces = p => p.length <= max ? [p] : p.split(/\n/).flatMap(l => l.length <= max ? [l] : (l.match(/[^.!?]+[.!?]*\s*/g) ?? [l]).flatMap(s => s.length <= max ? [s.trim()] : s.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g'))));
  for (const para of text.split(/\n{2,}/)) for (const p of pieces(para)) if (p.trim()) {
    if (p.length > max) throw new Error('internal: piece longer than max');
    if (!cur) cur = p; else if (cur.length + 2 + p.length <= max) cur += '\n\n' + p; else { out.push(cur); cur = p; }
  }
  if (cur) out.push(cur);
  return out;
}

// Our posts end with an attestation paragraph that quotes the forbidden phrases the post was checked against
// ("The forbidden phrases were \"production ready\", ..."). That is a mention, not a claim, so exactly that paragraph
// (the one opening "Unsigned Curbi check" or "Exact unsigned ... check") is set aside, and the report counts it.
const ATTESTATION = /^(?:exact\s+)?unsigned\s+(?:curbi\s+)?(?:wording\s+|rule\s+)?check\b/i;
export function dropAttestation(text) {
  const paras = text.split(/\n{2,}/), kept = paras.filter(p => !ATTESTATION.test(p.trim()));
  return { text: kept.join('\n\n'), dropped: paras.length - kept.length };
}

// One post becomes cases sharing the post's record. ids are `${postId}#${n}`.
export function toCases(post, max = REPLY_CHARS) {
  if (!post || typeof post.id !== 'string' || !post.id) throw new TypeError('post.id must be a non-empty string');
  const parts = chunk(dropAttestation(renderPlain(post.body)).text, max);
  return parts.map((reply, i) => ({ id: `${post.id}#${i + 1}`.slice(0, 60), reply, ...(post.record ? { record: post.record } : {}) }));
}

function summarize(posts, results) {
  const byPost = new Map(posts.map(p => [p.id, { id: p.id, author: p.author ?? null, url: p.url ?? null, chunks: 0, attestationDropped: dropAttestation(renderPlain(p.body)).dropped,
    recordOps: (p.record?.effects ?? []).filter(e => e.status === 'DONE').map(e => e.operation), pass: true, findings: [] }]));
  for (const r of results) {
    const postId = r.id.replace(/#\d+$/, ''); const row = byPost.get(postId);
    if (!row) throw new Error(`result for unknown post ${r.id}`);
    row.chunks++; if (!r.pass) row.pass = false;
    for (const f of r.findings) row.findings.push({ rule: f.rule, text: f.text, why: f.why });
  }
  const rows = [...byPost.values()];
  return { object: 'curbi.dogfood.report.v1', recordTrust: 'caller_supplied_unverified', signed: false, posts: rows.length,
    passed: rows.filter(r => r.pass).length, flagged: rows.filter(r => !r.pass).length, rows };
}

// Offline: the exported production checker, in process.
export function checkLocal(policy, posts) {
  const results = [];
  for (const p of posts) for (const c of toCases(p)) {
    const r = runCheck({ policy, reply: c.reply, ...(c.record ? { record: c.record } : {}) });
    if (r.error) throw new Error(`${c.id}: ${r.error}`);
    results.push({ id: c.id, pass: r.pass, findings: r.findings });
  }
  return summarize(posts, results);
}

// Live: POST /v1/check in batches of 50. Same report shape, so local and live can be compared row by row.
export async function checkLive(policy, posts, { fetch: f = globalThis.fetch, api = 'https://api.curbi.io' } = {}) {
  const cases = posts.flatMap(p => toCases(p)), results = [];
  for (let i = 0; i < cases.length; i += BATCH_CASES) {
    const res = await f(`${api.replace(/\/$/, '')}/v1/check`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ policy, cases: cases.slice(i, i + BATCH_CASES) }) });
    const body = await res.json();
    if (!res.ok || !Array.isArray(body.results)) throw new Error(`live check HTTP ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
    results.push(...body.results.map(r => ({ id: r.id, pass: r.pass, findings: r.findings })));
  }
  return summarize(posts, results);
}

// Rows that differ between two reports (local vs live). Empty means parity.
export function compareReports(a, b) {
  const key = r => JSON.stringify([r.pass, r.findings.map(f => [f.rule, f.text])]);
  const bm = new Map(b.rows.map(r => [r.id, r]));
  return a.rows.filter(r => !bm.has(r.id) || key(r) !== key(bm.get(r.id))).map(r => r.id);
}

// Which role wrote a #43 post: posts open with "CTO ..." / "**CAIO ..." or sign off "— CTO".
export function roleOf(body) {
  const head = body.slice(0, 200), tail = body.slice(-200);
  if (/^\W*CAIO\b/.test(head) || /\bCAIO\s*\(/.test(head)) return 'CAIO';
  if (/^\W*CTO\b/.test(head) || /—\s*CTO\s*$/.test(tail.trim())) return 'CTO';
  return null;
}

export function toMarkdown(report) {
  const esc = s => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`**Dogfood report** (unsigned; records ${report.recordTrust}): ${report.posts} posts, ${report.passed} passed, ${report.flagged} flagged.`, '', '| Post | Author | Result | Findings |', '|---|---|---|---|'];
  for (const r of report.rows) lines.push(`| ${r.url ? `[${esc(r.id)}](${r.url})` : esc(r.id)} | ${esc(r.author ?? '')} | ${r.pass ? 'pass' : 'flagged'} | ${r.findings.map(f => `\`${f.rule}\` "${esc(f.text)}"`).join('; ')} |`);
  return lines.join('\n');
}
