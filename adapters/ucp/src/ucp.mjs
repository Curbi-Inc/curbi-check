// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// UCP adapter: checks the agreement UCP requires but does not verify.
//
// UCP (spec v2026-08-25, "Presenting policies") says a disclosure's content "MUST agree with the policy it pairs with",
// and pairs each disclosure with the one policy that governs its path under the spec's longest-prefix precedence.
// No party in the protocol checks that agreement. This adapter does, deterministically and narrowly:
//   1. resolves the governing policy for each disclosure exactly as the spec's Precedence section defines;
//   2. compares disclosure and policy on two things a rule can check without interpretation: stated time windows
//      (days/weeks, months/years) and final-sale vs returnable language;
//   3. checks an agent's reply about return/warranty terms against the same policies;
//   4. turns Order adjustments into a record for the unchanged Curbi checker, so "I refunded you" is checked against
//      what the business's Order says.
// Scope is the two well-known policy types only. UCP policy is the business's own statement, not Curbi policy, and an
// Order is a business-written snapshot, not independent provider confirmation. No model calls; no network.
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

export const UCP_SPEC = '2026-08-25';
export const SCOPE_TYPES = new Set(['dev.ucp.shopping.policy.return', 'dev.ucp.shopping.policy.warranty']);
const RET = 'dev.ucp.shopping.policy.return';
export const LIMITS = { policies: 200, messages: 200, text: 4000, appliesTo: 32, pathChars: 512, depth: 32, adjustments: 100, visits: 10000 };
const NOTES = {
  policy: "UCP policies[] and messages[] are the business's own statements, not Curbi policy; this checks them against each other.",
  noConflict: 'no_conflict_found means the deterministic checks (time windows, final sale) found no conflict; it is not proof of agreement.',
  order: 'The Order is a business-written snapshot (source_trust business_self_reported), not provider confirmation that anything happened.',
  unsigned: 'Unsigned. Not a PAP receipt.',
};

const fail = m => { throw new TypeError(m); };
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x);

// RFC 9535 subset, as typed segments: root `$`, member names (`.name`, `['name']`, `["name"]`), array indexes
// (`[0]`), and wildcards (`.*`, `[*]`). A quoted name is always a name, even `'*'`. Filters, slices, negative indexes
// and descendant segments are refused (null), so a target we cannot evaluate is reported, never guessed.
const ESC = { "'": "'", '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
function quoted(p, i) {
  const q = p[i]; let out = ''; i++;
  while (i < p.length) {
    const ch = p[i];
    if (ch === q) return { v: out, i: i + 1 };
    if (ch === '\\') {
      const e = p[i + 1];
      if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(p.slice(i + 2, i + 6))) { out += String.fromCharCode(parseInt(p.slice(i + 2, i + 6), 16)); i += 6; continue; }
      if (!(e in ESC) || (e === "'" && q !== "'") || (e === '"' && q !== '"')) return null;
      out += ESC[e]; i += 2; continue;
    }
    if (ch < ' ') return null;
    out += ch; i++;
  }
  return null;
}
export function parsePath(p) {
  if (typeof p !== 'string' || p.length > LIMITS.pathChars || p[0] !== '$') return null;
  const segs = []; let i = 1;
  while (i < p.length) {
    let m;
    if (p.startsWith('.*', i)) { segs.push({ k: 'wild' }); i += 2; }
    else if (p[i] === '.' && (m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(p.slice(i + 1)))) { segs.push({ k: 'name', v: m[0] }); i += 1 + m[0].length; }
    else if (p.startsWith('[*]', i)) { segs.push({ k: 'wild' }); i += 3; }
    else if (p[i] === '[' && (m = /^\[(0|[1-9]\d{0,8})\]/.exec(p.slice(i)))) { segs.push({ k: 'index', v: Number(m[1]) }); i += m[0].length; }
    else if (p[i] === '[' && (p[i + 1] === "'" || p[i + 1] === '"')) { const r = quoted(p, i + 1); if (!r || p[r.i] !== ']') return null; segs.push({ k: 'name', v: r.v }); i = r.i + 1; }
    else return null;
    if (segs.length > LIMITS.depth) return null;
  }
  return segs;
}
const singular = segs => segs.every(s => s.k !== 'wild');
// Evaluate typed segments against the response (RFC 9535 2.3.1-2.3.3): a name selects a member of an object only; an
// index selects an element of an array only; a wildcard selects every child. Returns matched normalized paths, or null
// when evaluation would visit more than LIMITS.visits nodes.
function evaluate(root, segs) {
  let nodes = [{ path: [], v: root }], visits = 0;
  for (const s of segs) {
    const next = [];
    for (const n of nodes) {
      const v = n.v;
      if (s.k === 'name') { if (isObj(v) && Object.prototype.hasOwnProperty.call(v, s.v)) next.push({ path: [...n.path, { k: 'name', v: s.v }], v: v[s.v] }); }
      else if (s.k === 'index') { if (Array.isArray(v) && s.v < v.length) next.push({ path: [...n.path, { k: 'index', v: s.v }], v: v[s.v] }); }
      else if (Array.isArray(v)) v.forEach((x, j) => next.push({ path: [...n.path, { k: 'index', v: j }], v: x }));
      else if (isObj(v)) for (const key of Object.keys(v)) next.push({ path: [...n.path, { k: 'name', v: key }], v: v[key] });
      visits += next.length;
      if (visits > LIMITS.visits) return null;
    }
    nodes = next;
  }
  return nodes.map(n => n.path);
}
const prefixOf = (a, b) => a.length <= b.length && a.every((s, i) => s.k === b[i].k && s.v === b[i].v);

// Precedence, spec "Precedence" steps 1-4: evaluate each same-type policy's targets against the response; a target
// covers the node when one of its matched normalized paths is a prefix of the node's. Score each policy by its deepest
// covering match as (depth, precision): precision 1 for a singular query, 0 for a set match. Highest wins; a shared
// highest score is undefined in the spec and is reported as ambiguous.
export function governingPolicy(response, type, nodePathString) {
  const { policies } = validateResponse(response);
  const segs = parsePath(nodePathString);
  if (!segs || !singular(segs)) return { status: 'unsupported', target: String(nodePathString).slice(0, 120) };
  const node = evaluate(response, segs);
  if (!node || node.length !== 1) return { status: 'unmatched' };
  let best = null, tied = false;
  for (let i = 0; i < policies.length; i++) {
    const p = policies[i];
    if (p.type !== type) continue;
    let score = null;
    for (const t of p.applies_to === undefined ? ['$'] : p.applies_to) {
      const ts = parsePath(t), matched = ts && evaluate(response, ts);
      if (!ts || !matched) return { status: 'unsupported', index: i, target: String(t).slice(0, 120) };
      for (const m of matched) {
        if (!prefixOf(m, node[0])) continue;
        const sc = [m.length, singular(ts) ? 1 : 0];
        if (!score || sc[0] > score[0] || (sc[0] === score[0] && sc[1] > score[1])) score = sc;
      }
    }
    if (!score) continue;
    if (!best || score[0] > best.score[0] || (score[0] === best.score[0] && score[1] > best.score[1])) { best = { index: i, score }; tied = false; }
    else if (score[0] === best.score[0] && score[1] === best.score[1]) tied = true;
  }
  if (!best) return { status: 'none' };
  return tied ? { status: 'ambiguous', index: best.index } : { status: 'governs', index: best.index };
}

const text = d => (d.plain ?? d.markdown ?? d.html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const norm = s => s.normalize('NFKC').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '');

const WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fourteen: 14, thirty: 30, sixty: 60, ninety: 90 };
const DUR = new RegExp(String.raw`\b(\d{1,4}|${Object.keys(WORDS).join('|')})[\s-]*(day|week|month|year)s?\b`, 'gi');
// Days and weeks compare in days; months and years compare in months. Days are never converted to months.
export function durations(s) {
  const out = [];
  for (const m of s.normalize('NFKC').matchAll(DUR)) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : WORDS[m[1].toLowerCase()], u = m[2].toLowerCase();
    out.push(u === 'day' ? { n, base: 'day' } : u === 'week' ? { n: n * 7, base: 'day' } : u === 'month' ? { n, base: 'month' } : { n: n * 12, base: 'month' });
  }
  return out;
}
// Windows are attributed to the term they belong to, so "Refunds are processed within 60 days" is not a return window.
// Bounded contract: inside one clause, each window belongs to the nearest term word before it, or, when none precedes it,
// the nearest term word after it ("30-day returns"). A clause with no term word counts only in lenient mode (policy and
// disclosure text, whose type is already known). Agent replies are strict: the window must belong to the named term.
const KW = /\b(?:(return\w*|send\s+(?:it|this|them)\s+back)|(warrant\w*|guarantee\w*)|(refund\w*|ship\w*|deliver\w*|exchange\w*|cancel\w*|trial|subscription))\b/gi;
const KIND = ['return', 'warranty', 'other'];
const clauses = t => t.split(/[.!?;\n]|,|\b(?:and|but)\b/i).map(x => x.trim()).filter(Boolean);
export function termDurations(t, term, strict) {
  return clauses(t).flatMap(c => {
    const kws = [...c.matchAll(KW)].map(m => ({ at: m.index, kind: KIND[m.slice(1, 4).findIndex(Boolean)] }));
    return [...c.normalize('NFKC').matchAll(DUR)].filter(m => {
      const before = kws.filter(k => k.at < m.index).pop(), owner = before ?? kws.find(k => k.at > m.index);
      return owner ? owner.kind === term : !strict;
    }).flatMap(m => durations(m[0]));
  });
}
const durationConflict = (c, p) => {
  for (const base of ['day', 'month']) {
    const cv = c.filter(d => d.base === base).map(d => d.n), pv = new Set(p.filter(d => d.base === base).map(d => d.n));
    const bad = cv.find(n => pv.size && !pv.has(n));
    if (bad !== undefined) return { stated: bad, base, policy: [...pv] };
  }
  return null;
};

const NO_RET = /\b(?:final[\s-]+sale|non-?returnable|(?:cannot|can(?:'|’)?t|may not|will not)\s+be\s+(?:returned|sent\s+back|exchanged)|not\s+(?:eligible|accepted)\s+for\s+(?:a\s+)?returns?|no\s+returns?)\b/i;
const RETURNABLE = /\b(?:free\s+returns?|returns?\s+(?:are\s+|is\s+)?(?:accepted|allowed|free|welcome|within)|(?:can|may)\s+(?:return|send\s+back|be\s+returned)\b|return\s+(?:it|this|them|the\s+item)\b|\d+[\s-]*day\s+returns?|full\s+refund|send\s+(?:it|this)\s+back)/i;
// Final sale and return offers are judged per proposition. Propositions split on sentence ends, ; : and dashes, and on
// contrast words; a plain comma or "and" does not split, so "you cannot, under any circumstances, return it" stays one
// proposition. An offer is negated only by a negation shortly before it in the same proposition, so a final-sale phrase
// elsewhere can never cancel an affirmative offer.
const PROPS = /[.!?;:\n\u2013\u2014]|\s-\s|\b(?:but|however|although|though|yet|except|whereas|while|nevertheless)\b/i;
const props = t => t.split(PROPS).map(x => x.trim()).filter(Boolean);
// "no" negates only when it directly precedes the offer ("no returns"), so "No problem, you can return it" is an offer.
const NEG_BEFORE = /(?:\b(?:not|cannot|can(?:'|\u2019)?t|won(?:'|\u2019)?t|unable|never)\b[^.!?;:\n]{0,40}|\bno\s+)$/i;
const offers = p => [...p.matchAll(new RegExp(RETURNABLE.source, 'gi'))].some(m => !NEG_BEFORE.test(p.slice(0, m.index)));
// stance(t): does the text say final sale / no returns anywhere, and does it make an affirmative return offer anywhere?
const stance = t => { const ps = props(t); return { final: ps.some(x => NO_RET.test(x)), offer: ps.some(offers) }; };
const finalSale = t => { const s = stance(t); return s.final && !s.offer; };
const returnable = t => stance(t).offer;
function validateResponse(r) {
  if (!isObj(r)) fail('response must be an object');
  const policies = r.policies ?? [], messages = r.messages ?? [];
  if (!Array.isArray(policies)) fail('policies must be an array');
  if (!Array.isArray(messages)) fail('messages must be an array');
  if (policies.length > LIMITS.policies) fail(`policies: at most ${LIMITS.policies}`);
  if (messages.length > LIMITS.messages) fail(`messages: at most ${LIMITS.messages}`);
  policies.forEach((p, i) => {
    if (!isObj(p) || typeof p.type !== 'string' || p.type.length > 200) fail(`policies[${i}].type: string`);
    const d = p.description;
    if (!isObj(d) || !['plain', 'markdown', 'html'].some(k => typeof d[k] === 'string')) fail(`policies[${i}].description: object with plain, markdown or html`);
    for (const k of ['plain', 'markdown', 'html']) if (d[k] !== undefined && (typeof d[k] !== 'string' || d[k].length > LIMITS.text)) fail(`policies[${i}].description.${k}: string of at most ${LIMITS.text} chars`);
    if (p.applies_to !== undefined && (!Array.isArray(p.applies_to) || !p.applies_to.length || p.applies_to.length > LIMITS.appliesTo || p.applies_to.some(t => typeof t !== 'string'))) fail(`policies[${i}].applies_to: 1-${LIMITS.appliesTo} strings`);
  });
  messages.forEach((m, i) => {
    if (!isObj(m)) fail(`messages[${i}]: object`);
    if (m.content !== undefined && (typeof m.content !== 'string' || m.content.length > LIMITS.text)) fail(`messages[${i}].content: string of at most ${LIMITS.text} chars`);
  });
  return { policies, messages };
}

export function checkDisclosures(response) {
  const { policies, messages } = validateResponse(response);
  const disclosures = [], findings = [];
  const find = (rule, mi, pi, t, why) => findings.push({ rule, messageIndex: mi, ...(pi !== undefined ? { policyIndex: pi } : {}), text: String(t).slice(0, 200), why });
  messages.forEach((m, mi) => {
    if (m.type !== 'warning' || m.presentation !== 'disclosure') return;
    const row = { index: mi, path: m.path ?? null, code: m.code ?? null, governing: null };
    disclosures.push(row);
    if (!SCOPE_TYPES.has(m.code)) { row.status = 'out_of_scope'; return; }
    const content = typeof m.content === 'string' ? m.content : '';
    const g = governingPolicy(response, m.code, typeof m.path === 'string' ? m.path : null);
    if (g.status === 'unsupported' && g.index === undefined) { row.status = 'unsupported'; find('ucp:path-unsupported', mi, undefined, m.path ?? '(missing path)', 'A disclosure path must be a singular JSONPath this adapter can evaluate.'); return; }
    if (g.status === 'unmatched') { row.status = 'unmatched'; find('ucp:path-unmatched', mi, undefined, m.path, 'The disclosure path names no node in this response.'); return; }
    if (g.status === 'unsupported') { row.status = 'unsupported'; find('ucp:path-unsupported', mi, g.index, g.target, 'A same-type policy uses an applies_to target this adapter cannot evaluate, so the governing policy is unknown.'); return; }
    if (g.status === 'none') { row.status = 'unpaired'; find('ucp:disclosure-unpaired', mi, undefined, content, `No ${m.code} policy covers ${m.path}; nothing structured stands behind this disclosure.`); return; }
    if (g.status === 'ambiguous') { row.status = 'ambiguous'; find('ucp:policy-ambiguous', mi, g.index, m.path, 'Two same-type policies tie for this node; UCP leaves the outcome undefined.'); return; }
    const pol = policies[g.index], ptext = text(pol.description);
    row.governing = { index: g.index, type: pol.type };
    if (norm(content) === norm(ptext)) { row.status = 'verbatim'; return; }
    const before = findings.length;
    const term = m.code === RET ? 'return' : 'warranty', dc = durationConflict(termDurations(content, term), termDurations(ptext, term));
    if (dc) find('ucp:disclosure-duration-mismatch', mi, g.index, content, `Disclosure states ${dc.stated} ${dc.base}s; the governing policy states ${dc.policy.join(' or ')} ${dc.base}s.`);
    // A policy that is purely final sale conflicts with any return offer in the disclosure; a purely returnable policy
    // conflicts with any final-sale statement. A policy that says both (e.g. clearance lines excepted) is not judged.
    if (m.code === RET) {
      const ps = stance(ptext), cs = stance(content);
      if (ps.final && !ps.offer && cs.offer) find('ucp:disclosure-final-sale-mismatch', mi, g.index, content, 'The governing policy says final sale; the disclosure offers returns.');
      else if (ps.offer && !ps.final && cs.final) find('ucp:disclosure-final-sale-mismatch', mi, g.index, content, 'The disclosure says final sale; the governing policy offers returns.');
    }
    row.status = findings.length > before ? 'conflict' : 'no_conflict_found';
  });
  return { object: 'curbi.ucp.disclosure-check.v1', ucpSpec: UCP_SPEC, sourceTrust: 'business_self_reported', signed: false, pass: findings.length === 0, disclosures, findings, notes: [NOTES.policy, NOTES.noConflict, NOTES.unsigned] };
}

// Agent reply about return/warranty terms vs the response's in-scope policies. A reply names no JSONPath, so it is
// compared with every policy of the type it talks about; final sale conflicts only when every return policy is final sale.
export function checkReplyTerms({ response, reply }) {
  const { policies } = validateResponse(response);
  if (typeof reply !== 'string' || reply.length > LIMITS.text) fail(`reply: string of at most ${LIMITS.text} chars`);
  const texts = type => policies.filter(p => p.type === type).map(p => text(p.description));
  const ret = texts(RET), war = texts('dev.ucp.shopping.policy.warranty'), findings = [];
  // Each clause is judged on its own: a final-sale or negated clause never hides a warranty mismatch or an affirmative
  // return offer in another clause of the same sentence.
  if (ret.length && ret.every(finalSale)) for (const p of props(reply)) {
    if (/\b(?:return|refund)\w*/i.test(p) && offers(p)) findings.push({ rule: 'ucp:claim-final-sale-mismatch', text: p.slice(0, 200), why: 'Reply offers a return; the return policy says final sale.' });
  }
  for (const clause of clauses(reply)) {
    if (ret.length) {
      const dc = durationConflict(termDurations(clause, 'return', true), ret.flatMap(t => termDurations(t, 'return')));
      if (dc) findings.push({ rule: 'ucp:claim-duration-mismatch', text: clause.slice(0, 200), why: `Reply states a ${dc.stated}-${dc.base} return window; the return policy states ${dc.policy.join(' or ')} ${dc.base}s.` });
    }
    if (war.length) {
      const dc = durationConflict(termDurations(clause, 'warranty', true), war.flatMap(t => termDurations(t, 'warranty')));
      if (dc) findings.push({ rule: 'ucp:claim-duration-mismatch', text: clause.slice(0, 200), why: `Reply states a ${dc.stated}-${dc.base} warranty; the warranty policy states ${dc.policy.join(' or ')} ${dc.base}s.` });
    }
  }
  return { object: 'curbi.ucp.terms-check.v1', ucpSpec: UCP_SPEC, sourceTrust: 'business_self_reported', signed: false, pass: findings.length === 0, findings, notes: [NOTES.policy, NOTES.unsigned] };
}

// Order adjustments (source/schemas/shopping/types/adjustment.json: type open string, status pending|completed|failed)
// as a Curbi record. Only `completed` counts as DONE.
export const UCP_ACTIONS = Object.freeze({ refunded: 'ucp.adjustment.refund', returned: 'ucp.adjustment.return', credited: 'ucp.adjustment.credit', cancelled: 'ucp.adjustment.cancellation', canceled: 'ucp.adjustment.cancellation' });
const STATUS = { completed: 'DONE', pending: 'PENDING', failed: 'FAILED' };
export function orderRecord(order) {
  if (!isObj(order) || typeof order.id !== 'string' || !order.id || order.id.length > 200) fail('order.id: non-empty string');
  const adj = order.adjustments ?? [];
  if (!Array.isArray(adj) || adj.length > LIMITS.adjustments) fail(`order.adjustments: array of at most ${LIMITS.adjustments}`);
  return { subject: order.id, effects: adj.map((a, i) => {
    if (!isObj(a) || typeof a.type !== 'string' || !/^[a-z_]{1,40}$/.test(a.type) || !STATUS[a.status]) fail(`order.adjustments[${i}]: type [a-z_] and status pending|completed|failed`);
    return { operation: `ucp.adjustment.${a.type}`, status: STATUS[a.status] };
  }) };
}

export function checkReplyAgainstOrder({ order, reply, policy = {} }) {
  if (!isObj(policy)) fail('policy must be an object');
  const result = runCheck({ policy: { ...policy, actions: { ...UCP_ACTIONS, ...(policy.actions ?? {}) } }, reply, record: orderRecord(order) });
  return { ...result, recordSource: 'ucp_order_business_snapshot', notes: [NOTES.order, NOTES.unsigned] };
}
