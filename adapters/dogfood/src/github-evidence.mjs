// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Builds a post's record from GitHub reads, not from the post's own words: a claim of "merged" is backed only when a
// pull request the post references reads back as merged, and "deployed" / "qualified" only when an Actions run it
// links reads back as a successful deploy / qualification run. Anything else stays unrecorded.
// Limits, stated plainly: the record is per post, not per claim (the checker binds operation, not which PR), and it
// is still caller-supplied to the checker (recordTrust stays caller_supplied_unverified). Keys, packages and pushes
// have no GitHub read here, so claims about them always need a record supplied some other way.

const PR_REF = /(?:github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+))|(?:^|[\s(])#(\d{1,6})\b/g;
const RUN_REF = /github\.com\/([\w.-]+)\/([\w.-]+)\/actions\/runs\/(\d+)/g;

export function references(body, defaultRepo) {
  const [dOwner, dRepo] = defaultRepo.split('/');
  const prs = new Map(), runs = new Map();
  for (const m of body.matchAll(PR_REF)) {
    const [owner, repo, n] = m[3] ? [m[1], m[2], m[3]] : [dOwner, dRepo, m[4]];
    prs.set(`${owner}/${repo}#${n}`, { owner, repo, number: Number(n) });
  }
  for (const m of body.matchAll(RUN_REF)) runs.set(`${m[1]}/${m[2]}/${m[3]}`, { owner: m[1], repo: m[2], id: Number(m[3]) });
  return { prs: [...prs.values()], runs: [...runs.values()] };
}

// Pure: GitHub API objects to effects.
export function effectsFrom({ pulls = [], runs = [] }) {
  const done = new Set();
  for (const p of pulls) if (p && p.merged === true) done.add('git.merge');
  for (const r of runs) if (r && r.status === 'completed' && r.conclusion === 'success') {
    if (/\bdeploy/i.test(r.name ?? '')) done.add('release.deploy');
    if (/qualif/i.test(r.name ?? '')) done.add('qualification.pass');
  }
  return [...done].sort().map(operation => ({ operation, status: 'DONE' }));
}

// A read that fails leaves its claim unrecorded (fail closed) and is pushed to `errors`, so the caller can refuse to
// report a run where evidence could not be read rather than present those claims as unbacked.
export async function recordFor(body, defaultRepo, { fetch: f = globalThis.fetch, api = 'https://api.github.com', headers = {}, errors = [] } = {}) {
  const { prs, runs } = references(body, defaultRepo);
  const get = async path => {
    const r = await f(`${api}${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'curbi-dogfood', ...headers } });
    if (r.ok) return r.json();
    if (r.status !== 404) errors.push(`${path}: HTTP ${r.status}`);   // 404: "#43" is an issue, not a pull request
    return null;
  };
  const pulls = await Promise.all(prs.slice(0, 20).map(p => get(`/repos/${p.owner}/${p.repo}/pulls/${p.number}`)));
  const runObjs = await Promise.all(runs.slice(0, 20).map(r => get(`/repos/${r.owner}/${r.repo}/actions/runs/${r.id}`)));
  return { effects: effectsFrom({ pulls, runs: runObjs }) };
}
