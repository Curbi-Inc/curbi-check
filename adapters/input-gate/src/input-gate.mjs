// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Curbi input gate: the "check at input" half. Every item that enters a model's context (user text, tool results,
// retrieved documents, state) gets a deterministic context check, and a proposed action is admitted only when the
// turn's checks support it. Three lanes:
//   provenance          - who produced the bytes: signatures and HMACs against keys pinned in the host's registry,
//                         nonce replay, principal binding, revocation freshness. Keys inside the input are never used.
//   state consistency   - what the bytes claim against the record: the shipped checker's own extractors (prices,
//                         action claims) compared with DONE receipts for this scope and operation.
//   scope authorization - what a proposal may do: grant scope and cap, plus tuple provenance (one verified source must
//                         bind the same operation, resource and currency, with a maximum at or above the amount).
// Hard boundaries, each locked by a test that fails if broken:
//   - no AI judges input text: the only text logic is literal extraction by the shipped checker; no model, no
//     classifier, no callback hook. Policy fields that would configure one are refused.
//   - no double-brokered check: everything is computed here, once, in process. No network, no remote checker, and a
//     verdict computed elsewhere is never accepted; admitProposal recomputes every digest it relies on.
//   - no LLM checks LLM output: model output is an item like any other, it is never a verifier, and an item's own
//     claims about its verification ("verified": true) are data, not provenance.
// Signing the manifest and appending records to the gate log is host (CTO) work; this library stays unsigned.
import { createHash, createHmac, createPublicKey, timingSafeEqual, verify as edVerify } from 'node:crypto';
import { createRequire } from 'node:module';
const { runCheck } = createRequire(import.meta.url)('../../../checker/check-api.js');

export const VERSION = 1;
export const VERIFIER_VERSION = 'curbi-input-gate/1';
export const LIMITS = { itemBytes: 65536, items: 64, entities: 200, stringFields: 2000, depth: 16 };
export const TTL_MS = 300000;
const CLASSES = ['user', 'tool', 'retrieval', 'state', 'config', 'model'];
const MODES = ['allow-labeled', 'hand-off', 'block'];
// Field names that would configure judgement by a model, a hook or a remote service. Refused anywhere in a policy.
const NO_JUDGE = /^(?:judge|judges|model|models|llm|classifier|classify|prompt|embedding|embeddings|score_with|callback|hook|hooks|remote|endpoint|url|broker|delegate|webhook_url)$/i;

export class InputGateError extends Error { constructor(code, msg) { super(`${code}: ${msg}`); this.code = code; } }
const bad = (code, msg) => { throw new InputGateError(code, msg); };

// ---------- canonical bytes and digests ----------
export function canonical(v, depth = 0) {
  if (depth > LIMITS.depth) bad('too_deep', 'nesting deeper than 16');
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) bad('not_canonical', 'non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x, depth + 1)).join(',') + ']';
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    return '{' + Object.keys(v).sort().map(k => { if (v[k] === undefined) bad('not_canonical', `undefined at ${k}`); return JSON.stringify(k) + ':' + canonical(v[k], depth + 1); }).join(',') + '}';
  }
  bad('not_canonical', `unsupported value ${typeof v}`);
}
const b64u = buf => Buffer.from(buf).toString('base64url');
export const digestBytes = bytes => 'sha256:' + b64u(createHash('sha256').update(bytes).digest());
export const digest = obj => digestBytes(Buffer.from(canonical(obj), 'utf8'));
const toBytes = b => typeof b === 'string' ? Buffer.from(b, 'utf8') : b instanceof Uint8Array ? Buffer.from(b) : bad('bad_item', 'bytes must be a string or Uint8Array');
// Plain data only: functions, getters and proxies cannot reach the gate's logic (no hook can be smuggled in).
function plain(x, where) {
  try { return structuredClone(x); } catch { bad('not_plain_data', `${where} must be plain data (no functions or proxies)`); }
}

// ---------- policy ----------
function walkNoJudge(v, path) {
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (NO_JUDGE.test(k)) bad('no_model_judging', `${path}.${k}: the input gate takes literal rules only; model, hook and remote settings are refused`);
    walkNoJudge(x, `${path}.${k}`);
  }
}
export function compileInputPolicy(input) {
  const p = plain(input, 'policy');
  if (!p || typeof p !== 'object' || Array.isArray(p)) bad('bad_policy', 'policy must be an object');
  walkNoJudge(p, 'policy');
  const only = ['version', 'classes', 'entities', 'claims', 'max_revocation_age_ms', 'max_signature_age_s'];
  for (const k of Object.keys(p)) if (!only.includes(k)) bad('bad_policy', `policy.${k} is not a field`);
  if (!Number.isInteger(p.version) || p.version < 1) bad('bad_policy', 'policy.version must be a positive integer');
  const classes = {};
  for (const c of CLASSES) { const m = p.classes?.[c] ?? 'allow-labeled'; if (!MODES.includes(m)) bad('bad_policy', `policy.classes.${c}: ${MODES.join(' | ')}`); classes[c] = m; }
  for (const k of Object.keys(p.classes ?? {})) if (!CLASSES.includes(k)) bad('bad_policy', `policy.classes.${k} is not a class`);
  const entities = (p.entities ?? []).map((e, i) => {
    if (!e || typeof e.type !== 'string' || !/^[a-z_]{1,30}$/.test(e.type)) bad('bad_policy', `policy.entities[${i}].type`);
    if (typeof e.prefix !== 'string' || !/^[A-Za-z0-9_-]{1,12}$/.test(e.prefix)) bad('bad_policy', `policy.entities[${i}].prefix: literal letters, digits, _ or -`);
    if (!Number.isInteger(e.min) || !Number.isInteger(e.max) || e.min < 1 || e.max > 128 || e.min > e.max) bad('bad_policy', `policy.entities[${i}]: 1 <= min <= max <= 128`);
    for (const k of Object.keys(e)) if (!['type', 'prefix', 'min', 'max'].includes(k)) bad('bad_policy', `policy.entities[${i}].${k} is not a field`);
    return { type: e.type, prefix: e.prefix, min: e.min, max: e.max };
  });
  const claims = p.claims ?? {};
  for (const k of Object.keys(claims)) if (!['prices', 'discounts', 'actions'].includes(k)) bad('bad_policy', `policy.claims.${k} is not a field`);
  const claimsPolicy = { ...claims, unknownAmounts: 'allow' };
  if (claims.prices || claims.actions || claims.discounts) { const r = runCheck({ policy: claimsPolicy, reply: 'ok' }); if (r.error) bad('bad_policy', `policy.claims: ${r.error}`); }
  const age = (k, d) => { const v = p[k] ?? d; if (!Number.isInteger(v) || v < 1) bad('bad_policy', `policy.${k}`); return v; };
  const out = { version: p.version, classes, entities, claims: claimsPolicy, max_revocation_age_ms: age('max_revocation_age_ms', TTL_MS), max_signature_age_s: age('max_signature_age_s', 300) };
  return Object.freeze({ ...out, hash: digest(out) });
}

// ---------- times ----------
// Every time the gate reads is strict ISO 8601 UTC (2026-11-08T20:00:00Z, optional milliseconds) that round-trips
// through Date: Date.parse alone accepts loose forms and returns NaN for junk, and NaN compares false both ways, which
// is how an invalid expiry once read as "not expired" (CTO review 6727923670).
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
export function isoTime(v) {
  if (typeof v !== 'string' || !ISO_UTC.test(v)) return NaN;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== v.slice(0, 19)) return NaN;
  return ms;
}

// ---------- registry (host-pinned trust material) ----------
export function compileRegistry(input) {
  const r = plain(input, 'registry');
  walkNoJudge(r, 'registry');
  if (!Number.isInteger(r?.version)) bad('bad_registry', 'registry.version must be an integer');
  if (!Number.isFinite(isoTime(r.revocation_checked_at))) bad('bad_registry', 'registry.revocation_checked_at must be an ISO 8601 UTC time');
  const ed25519 = new Map(), hmac = new Map();
  for (const k of r.ed25519 ?? []) {
    if (typeof k.kid !== 'string' || typeof k.public_key_pem !== 'string') bad('bad_registry', 'ed25519 keys need kid and public_key_pem');
    const notAfter = isoTime(k.not_after);
    if (!Number.isFinite(notAfter)) bad('bad_registry', `ed25519 key ${k.kid}: not_after must be an ISO 8601 UTC time; every pinned key has a bounded validity`);
    ed25519.set(k.kid, { key: createPublicKey(k.public_key_pem), revoked: k.revoked === true, not_after: notAfter, classes: k.classes ?? CLASSES });
  }
  for (const h of r.hmac ?? []) {
    if (typeof h.id !== 'string' || typeof h.secret !== 'string' || h.secret.length < 16) bad('bad_registry', 'hmac entries need id and a secret of 16+ characters');
    hmac.set(h.id, { secret: h.secret, revoked: h.revoked === true, classes: h.classes ?? ['tool'] });
  }
  const pub = { version: r.version, revocation_checked_at: r.revocation_checked_at, ed25519: [...ed25519.keys()].sort(), hmac: [...hmac.keys()].sort(), ed25519_pem: (r.ed25519 ?? []).map(k => k.public_key_pem).sort() };
  return Object.freeze({ version: r.version, revocationCheckedAt: isoTime(r.revocation_checked_at), ed25519, hmac, digest: digest(pub) });
}

// In-memory nonce store for tests and single-process hosts. A real host supplies a durable store with the same shape.
export function memoryNonces() { const s = new Set(); return { has: (scope, n) => s.has(scope + '\u0000' + n), add: (scope, n) => { s.add(scope + '\u0000' + n); } }; }

// ---------- lane 1: provenance ----------
// The exact bytes an ed25519 producer signs: canonical JSON of these fields. Exported so hosts sign the same thing.
export function signingPayload(itemDigest, cls, env) {
  return Buffer.from(canonical({ v: VERSION, item_digest: itemDigest, class: cls, scope_digest: env.scope_digest, nonce: env.nonce, issued_at: env.issued_at }));
}
const ENVELOPE_KEY_FIELDS = ['key', 'jwk', 'public_key', 'public_key_pem', 'secret', 'x5c', 'x5u', 'jku'];
export function verifyProvenance(item, registry, ctx) {
  const env = item.envelope;
  if (env === undefined || env === null) return { result: 'unsigned', key_id: null, fresh: null, reason: 'no_envelope' };
  if (typeof env !== 'object') return { result: 'denied', key_id: null, fresh: null, reason: 'bad_envelope' };
  for (const k of ENVELOPE_KEY_FIELDS) if (Object.hasOwn(env, k)) return { result: 'denied', key_id: null, fresh: null, reason: 'input_supplied_key' };
  if (!Number.isFinite(ctx.now)) bad('bad_now', 'ctx.now must be a finite time in milliseconds');
  // Fresh means checked at or before now, and no longer ago than the policy allows. A check time in the future is not
  // evidence of anything, so it is never fresh.
  const revAge = ctx.now - registry.revocationCheckedAt, revFuture = revAge < 0;
  const revFresh = !revFuture && revAge <= ctx.policy.max_revocation_age_ms;
  const notFresh = revFuture ? 'revocation_data_from_future' : 'stale_revocation_data';
  const nonceSeen = n => ctx.nonces.has(ctx.scope_digest, n);
  if (env.type === 'ed25519') {
    const k = registry.ed25519.get(env.kid);
    if (!k) return { result: 'unconfirmed', key_id: env.kid ?? null, fresh: revFresh, reason: 'unknown_key' };
    if (k.revoked) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'revoked_key' };
    if (ctx.now >= k.not_after) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'expired_key' };
    if (!k.classes.includes(item.class)) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'key_not_for_class' };
    const signed = signingPayload(item.item_digest, item.class, env);
    let sig; try { sig = Buffer.from(String(env.signature), 'base64url'); } catch { sig = Buffer.alloc(0); }
    if (sig.length !== 64 || !edVerify(null, signed, k.key, sig)) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'bad_signature' };
    if (env.scope_digest !== ctx.scope_digest) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'principal_mismatch' };
    const issued = isoTime(env.issued_at);
    if (!Number.isFinite(issued)) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'bad_issued_at' };
    if (ctx.now - issued > ctx.policy.max_signature_age_s * 1000 || issued - ctx.now > 60000) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'stale_signature' };
    if (typeof env.nonce !== 'string' || !env.nonce) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'missing_nonce' };
    if (nonceSeen(env.nonce)) return { result: 'denied', key_id: env.kid, fresh: revFresh, reason: 'replayed_nonce' };
    ctx.nonces.add(ctx.scope_digest, env.nonce);
    return revFresh ? { result: 'verified', key_id: env.kid, fresh: true, reason: null } : { result: 'unconfirmed', key_id: env.kid, fresh: false, reason: notFresh };
  }
  if (env.type === 'stripe-webhook') {
    // Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">. The secret is the host's, held in its registry.
    const h = registry.hmac.get(env.endpoint);
    if (!h) return { result: 'unconfirmed', key_id: env.endpoint ?? null, fresh: revFresh, reason: 'unknown_key' };
    if (h.revoked) return { result: 'denied', key_id: env.endpoint, fresh: revFresh, reason: 'revoked_key' };
    if (!h.classes.includes(item.class)) return { result: 'denied', key_id: env.endpoint, fresh: revFresh, reason: 'key_not_for_class' };
    const parts = Object.fromEntries(String(env.header ?? '').split(',').map(x => x.split('=')).filter(x => x.length === 2));
    const t = Number(parts.t), want = createHmac('sha256', h.secret).update(`${parts.t}.`).update(item.bytes).digest();
    let got; try { got = Buffer.from(String(parts.v1 ?? ''), 'hex'); } catch { got = Buffer.alloc(0); }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return { result: 'denied', key_id: env.endpoint, fresh: revFresh, reason: 'bad_signature' };
    if (!Number.isInteger(t) || Math.abs(ctx.now / 1000 - t) > ctx.policy.max_signature_age_s) return { result: 'denied', key_id: env.endpoint, fresh: revFresh, reason: 'stale_signature' };
    const nonce = `stripe:${parts.t}:${parts.v1}`;
    if (nonceSeen(nonce)) return { result: 'denied', key_id: env.endpoint, fresh: revFresh, reason: 'replayed_nonce' };
    ctx.nonces.add(ctx.scope_digest, nonce);
    return revFresh ? { result: 'verified', key_id: env.endpoint, fresh: true, reason: null } : { result: 'unconfirmed', key_id: env.endpoint, fresh: false, reason: notFresh };
  }
  return { result: 'unconfirmed', key_id: null, fresh: revFresh, reason: 'unknown_envelope_type' };
}

// ---------- item text and structured fields ----------
function parsed(bytes) { try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; } }
function textOf(bytes, json) {
  if (json === undefined) return bytes.toString('utf8');
  const out = []; const walk = (v, d) => { if (out.length >= LIMITS.stringFields || d > LIMITS.depth) return;
    if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') for (const x of Array.isArray(v) ? v : Object.values(v)) walk(x, d + 1); };
  walk(json, 0); return out.join('\n');
}
function pieces(text, max = 4000) {
  const out = []; let rest = text;
  while (rest.length > max) { let cut = rest.lastIndexOf(' ', max); if (cut < max / 2) cut = max; out.push(rest.slice(0, cut)); rest = rest.slice(cut); }
  if (rest.trim()) out.push(rest); return out;
}

// ---------- lane 2: state consistency ----------
// Claims come from the shipped checker's extractors, run twice: with no record (every action claim surfaces) and with
// this scope's DONE receipts (the ones still unrecorded stay unconfirmed). A price or discount conflict is contradicted.
export function checkClaims(text, policy, state, scopeDigest, operationId) {
  if (!policy.claims.prices && !policy.claims.actions && !policy.claims.discounts) return [];
  const receipts = (state?.receipts ?? []).filter(r => r && r.status === 'DONE' && r.scope_digest === scopeDigest && (operationId == null || r.operation_id === operationId));
  const effects = receipts.map(r => ({ operation: r.operation, status: 'DONE' }));
  const claims = [];
  pieces(text).forEach((reply, part) => {
    const bare = runCheck({ policy: policy.claims, reply }), backed = runCheck({ policy: policy.claims, reply, record: { effects } });
    if (bare.error || backed.error) bad('claims_error', bare.error || backed.error);
    const stillOpen = new Set(backed.findings.filter(f => f.rule === 'action:unrecorded').map(f => f.span.join(':')));
    for (const f of bare.findings) {
      if (f.rule === 'action:unrecorded') {
        const op = /no (\S+) effect is DONE/.exec(f.why)?.[1] ?? null;
        claims.push({ kind: 'action', operation: op, text: f.text, part, status: stillOpen.has(f.span.join(':')) ? 'unconfirmed' : 'confirmed',
          record: stillOpen.has(f.span.join(':')) ? null : receipts.find(r => r.operation === op)?.receipt_digest ?? null });
      } else if (f.rule.startsWith('price:')) claims.push({ kind: 'price', rule: f.rule, text: f.text, part, status: 'contradicted', record: 'policy.claims' });
    }
  });
  return claims;
}

// ---------- entities ----------
export function extractEntities(text, policy, { grant, index, scopeDigest }) {
  const found = new Map();
  for (const e of policy.entities) {
    const esc = e.prefix.replace(/[-]/g, '\\-');
    const rx = new RegExp(`(?<![A-Za-z0-9_])${esc}[A-Za-z0-9]{${e.min},${e.max}}(?![A-Za-z0-9_])`, 'g');
    for (const m of text.matchAll(rx)) { if (found.size >= LIMITS.entities) break; found.set(m[0], e.type); }
  }
  const listed = new Set(grant?.resources ?? []);
  return [...found].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, type]) => {
    const owner = index?.[id];
    const scope = listed.has(id) || owner === scopeDigest ? 'in_scope' : owner !== undefined ? 'out_of_scope' : 'unknown_entity';
    return { id, type, scope };
  });
}

// ---------- context check ----------
function observationOf(json) {
  const o = json?.observation;
  if (!o || typeof o !== 'object') return null;
  const ok = typeof o.operation === 'string' && typeof o.resource === 'string' && typeof o.currency === 'string' && Number.isInteger(o.max_amount_minor) && o.max_amount_minor >= 0;
  return ok ? { operation: o.operation, resource: o.resource, currency: o.currency.toLowerCase(), max_amount_minor: o.max_amount_minor } : null;
}
export function contextCheck(rawItem, policy, registry, ctx) {
  const item = plain(rawItem, 'item');
  if (!CLASSES.includes(item.class)) bad('bad_item', `class must be one of ${CLASSES.join(', ')}`);
  const bytes = toBytes(item.bytes);
  if (bytes.length > LIMITS.itemBytes) bad('item_too_large', `item over ${LIMITS.itemBytes} bytes`);
  const item_digest = digestBytes(bytes), json = parsed(bytes), text = textOf(bytes, json);
  const provenance = verifyProvenance({ class: item.class, bytes, item_digest, envelope: item.envelope }, registry, ctx);
  const operationId = typeof json?.operation_id === 'string' ? json.operation_id : null;
  const claims = checkClaims(text, policy, ctx.state, ctx.scope_digest, operationId);
  const entities = extractEntities(text, policy, { grant: ctx.grant, index: ctx.index, scopeDigest: ctx.scope_digest });
  const reasons = [];
  if (provenance.result === 'denied') reasons.push(`provenance:${provenance.reason}`);
  if (provenance.result === 'unsigned' || provenance.result === 'unconfirmed') reasons.push(`provenance:${provenance.reason}`);
  for (const e of entities) if (e.scope === 'out_of_scope') reasons.push(`entity:out_of_scope:${e.id}`);
  for (const c of claims) if (c.status !== 'confirmed') reasons.push(`claim:${c.status}:${c.kind}`);
  const verdict = provenance.result === 'denied' || entities.some(e => e.scope === 'out_of_scope') ? 'denied'
    : claims.some(c => c.status === 'contradicted') ? 'contradicted'
    : provenance.result === 'verified' && claims.every(c => c.status === 'confirmed') ? 'verified' : 'unconfirmed';
  // Only a verified tool or state item can carry an observation that supplies a tuple. Text never does.
  const observation = verdict === 'verified' && (item.class === 'tool' || item.class === 'state') ? observationOf(json) : null;
  const record = { object: 'curbi.context-check.v1', v: VERSION, item_digest, class: item.class, provenance: { result: provenance.result, key_id: provenance.key_id, fresh: provenance.fresh },
    principal_scope_digest: ctx.scope_digest, policy_hash: policy.hash, claims, entities, observation, verdict, reasons };
  return { ...record, digest: digest(record) };
}

// ---------- turn: all checks plus the manifest the host signs ----------
export function gateTurn({ items, policy, registry, ctx }) {
  if (!Array.isArray(items) || items.length > LIMITS.items) bad('bad_turn', `items: array of at most ${LIMITS.items}`);
  const c = plain({ turn_id: ctx.turn_id, scope_digest: ctx.scope_digest, now: ctx.now, state: ctx.state ?? null, grant: ctx.grant ?? null, index: ctx.index ?? null }, 'ctx');
  walkNoJudge(c, 'ctx');
  if (typeof c.turn_id !== 'string' || !c.turn_id || typeof c.scope_digest !== 'string' || !Number.isFinite(c.now)) bad('bad_turn', 'ctx needs turn_id, scope_digest and now');
  const nonces = ctx.nonces ?? bad('bad_turn', 'ctx.nonces store is required for replay protection');
  const checks = items.map(it => contextCheck(it, policy, registry, { ...c, nonces, policy }));
  const manifest = { object: 'curbi.turn-manifest.v1', v: VERSION, turn_id: c.turn_id, scope_digest: c.scope_digest, policy_version: policy.version, policy_hash: policy.hash,
    registry_version: registry.version, registry_digest: registry.digest, context_check_digests: checks.map(x => x.digest),
    request_digest: ctx.request_bytes == null ? null : digestBytes(toBytes(ctx.request_bytes)), verifier_version: VERIFIER_VERSION,
    issued_at: new Date(c.now).toISOString(), expires_at: new Date(c.now + TTL_MS).toISOString() };
  const denied = checks.some(x => x.verdict === 'denied'), modes = checks.filter(x => x.verdict !== 'verified').map(x => policy.classes[x.class]);
  const disposition = denied || modes.includes('block') ? 'block' : modes.includes('hand-off') ? 'hand_off' : 'proceed_labeled';
  return { checks, manifest, manifest_digest: digest(manifest), disposition };
}

// In-memory turn ledger for tests. A host supplies the durable ledger it already uses for idempotency.
export function memoryTurns() { const m = new Map(); return { get: t => m.get(t), set: (t, op) => { m.set(t, op); } }; }

// ---------- lane 3: scope authorization and tuple provenance ----------
export function admitProposal({ proposal: rawProposal, turn: rawTurn, grant: rawGrant, policy, registry, ctx }) {
  const proposal = plain(rawProposal, 'proposal'), turn = plain(rawTurn, 'turn'), grant = plain(rawGrant, 'grant');
  walkNoJudge({ proposal, grant }, 'admit');
  const reasons = [], deny = r => reasons.push(r);
  // Never trust a verdict computed elsewhere: every digest this decision relies on is recomputed here.
  const checksOk = Array.isArray(turn?.checks) && turn.checks.every(x => { const { digest: d, ...rec } = x; return d === digest(rec); });
  if (!checksOk) deny('context_check_digest_mismatch');
  else if (canonical(turn.checks.map(x => x.digest)) !== canonical(turn.manifest?.context_check_digests ?? null)) deny('manifest_checks_mismatch');
  if (!turn?.manifest || turn.manifest_digest !== digest(turn.manifest)) deny('manifest_digest_mismatch');
  const m = turn?.manifest ?? {};
  if (m.object !== 'curbi.turn-manifest.v1' || m.v !== VERSION || m.verifier_version !== VERIFIER_VERSION) deny('manifest_unknown_version');
  if (!(ctx.now < Date.parse(m.expires_at))) deny('manifest_expired');
  if (m.turn_id !== proposal.turn_id) deny('turn_mismatch');
  if (m.scope_digest !== grant.scope_digest) deny('scope_mismatch');
  if (m.policy_hash !== policy.hash || m.registry_digest !== registry.digest) deny('policy_or_registry_mismatch');
  const amount = proposal.amount_minor, currency = String(proposal.currency ?? '').toLowerCase();
  if (!Number.isInteger(amount) || amount <= 0) deny('bad_amount');
  // Scope authorization: the grant bounds what may happen. It never supplies the tuple on its cap alone.
  if (!(ctx.now < Date.parse(grant.expires_at))) deny('grant_expired');
  if (!(grant.operations ?? []).includes(proposal.operation)) deny('operation_not_granted');
  if (!(grant.resources ?? []).includes(proposal.resource)) deny('resource_not_granted');
  if (String(grant.currency ?? '').toLowerCase() !== currency) deny('currency_not_granted');
  if (!(amount <= grant.max_amount_minor)) deny('amount_over_grant_cap');
  // Tuple provenance: one verified source binds operation, resource and currency together, with max >= amount.
  const sources = [
    ...(checksOk ? turn.checks : []).filter(x => x.verdict === 'verified' && x.observation).map(x => ({ ...x.observation, from: x.digest })),
    ...(grant.tuples ?? []).map(t => ({ operation: t.operation, resource: t.resource, currency: String(t.currency).toLowerCase(), max_amount_minor: t.max_amount_minor, from: 'grant' })),
  ];
  const source = sources.find(s => s.operation === proposal.operation && s.resource === proposal.resource && s.currency === currency && Number.isInteger(s.max_amount_minor) && amount <= s.max_amount_minor);
  if (!source) deny('tuple_provenance_unverified');
  if (checksOk && turn.checks.some(x => x.verdict === 'denied')) deny('turn_has_denied_input');
  // Durable replay: one operation per turn; the same operation id may retry.
  const prior = ctx.turns.get(proposal.turn_id);
  if (prior !== undefined && prior !== proposal.operation_id) deny('turn_reused');
  const verdict = reasons.length ? 'deny' : 'admit';
  if (verdict === 'admit' && prior === undefined) ctx.turns.set(proposal.turn_id, proposal.operation_id);
  return { object: 'curbi.input-admission.v1', v: VERSION, verdict, reasons, source: verdict === 'admit' ? source.from : null,
    proposal_digest: digest(proposal), manifest_digest: turn?.manifest_digest ?? null };
}
