#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Usage:
//   Before posting (gate):   node adapters/dogfood/cli.mjs --draft post.md [--record rec.json] [--live]
//   After posting (report):  node adapters/dogfood/cli.mjs --comments comments.json [--since <id>] [--roles CTO,CAIO]
//                              [--evidence github --repo owner/name] [--live] [--json out.json] [--md out.md]
// comments.json is the GitHub REST list-issue-comments response (an array of {id, body, html_url, ...}).
// Exit code: 0 all pass, 1 any finding, 2 usage or check error. Results are unsigned; records are caller-supplied.
import { readFileSync, writeFileSync } from 'node:fs';
import { checkLocal, checkLive, compareReports, toMarkdown, roleOf } from './src/dogfood.mjs';
import { recordFor } from './src/github-evidence.mjs';


const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) { const a = args[i]; if (!a.startsWith('--')) { console.error(`unexpected ${a}`); process.exit(2); }
  const k = a.slice(2); opt[k] = ['live'].includes(k) ? true : args[++i]; }
const policy = JSON.parse(readFileSync(opt.policy ?? new URL('./team-policy.json', import.meta.url), 'utf8'));
try {
  let posts;
  if (opt.draft) posts = [{ id: 'draft', author: 'draft', body: readFileSync(opt.draft, 'utf8'), ...(opt.record ? { record: JSON.parse(readFileSync(opt.record, 'utf8')) } : {}) }];
  else if (opt.comments) {
    const roles = (opt.roles ?? 'CTO,CAIO').split(','), since = opt.since ? BigInt(opt.since) : 0n;
    posts = JSON.parse(readFileSync(opt.comments, 'utf8'))
      .filter(c => BigInt(c.id) > since).map(c => ({ id: String(c.id), url: c.html_url, author: roleOf(c.body), body: c.body }))
      .filter(p => roles.includes(p.author));
    if (opt.evidence === 'github') {
      if (!opt.repo) throw new Error('--evidence github needs --repo owner/name');
      const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
      const errors = [];
      for (const p of posts) p.record = await recordFor(p.body, opt.repo, { headers, errors });
      if (errors.length) throw new Error(`GitHub evidence unreadable, refusing to report: ${errors.slice(0, 5).join('; ')}`);
    }
  } else throw new Error('need --draft or --comments');
  const report = opt.live ? await checkLive(policy, posts, { api: process.env.CURBI_API ?? 'https://api.curbi.io' }) : checkLocal(policy, posts);
  report.mode = opt.live ? 'live' : 'local';
  if (opt.live) { report.parityWithLocal = compareReports(report, checkLocal(policy, posts)); }
  if (opt.json) writeFileSync(opt.json, JSON.stringify({ ...report, records: Object.fromEntries(posts.map(p => [p.id, p.record ?? null])) }, null, 2) + '\n');
  const md = toMarkdown(report); if (opt.md) writeFileSync(opt.md, md + '\n'); console.log(md);
  process.exit(report.flagged ? 1 : 0);
} catch (e) { console.error(e.message); process.exit(2); }
