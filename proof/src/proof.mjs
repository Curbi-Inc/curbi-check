// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Curbi Proof 0.1: the standalone, offline verifier for portable records of agent actions.
// One file, zero dependencies, zero network: WebCrypto only, so it runs unchanged in browsers, Workers,
// Deno and Node 20+. Copy it anywhere. Nothing here calls Curbi; the caller decides which keys to trust.
//
//   attestation  permission for ONE exact mutation, signed before it runs      (private execution gate (not distributed here))
//   receipt      provider-confirmed completion of that mutation, signed after  (same "curbi1." envelope)
//   log          every receipt is a leaf in an append-only Merkle log (RFC 9162 hashing, the
//                Certificate Transparency construction: standard, not novel)
//   checkpoint   the signed head of that log: { log, size, root, at }
//   bundle       receipts + inclusion proofs + the checkpoint (+ consistency proofs to older heads):
//                the unit that travels between parties, verified with a public key, offline.
//
// What a valid bundle shows: a trusted key signed exactly these receipts, they sit at these positions in one
// append-only history, and (with consistency proofs) earlier heads were not rewritten. What it does not show:
// that the provider's own systems agree. The receipt binds a digest of the provider evidence; the evidence
// itself is only as strong as its source.
export const SPEC = 'curbi.proof/0.1';
export const PREFIX = 'curbi1.';
export const DOMAIN = { attest: 'curbi-attest-v1.', receipt: 'curbi-receipt-v1.', checkpoint: 'curbi-checkpoint-v1.' };
export const ALG = 'rfc9162-sha256';
export const LIMITS = { items: 256, tokenChars: 4096, pathLen: 64, keys: 32, history: 16, known: 64, maxSize: 2 ** 31 - 1, skewMs: 120000 };
const enc = new TextEncoder(), dec = new TextDecoder();

export const b64u = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const unb64u = s => {
  if (typeof s !== 'string' || !/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
const str = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
const eq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const hash32 = s => { try { const h = unb64u(s); return h.length === 32 ? h : null; } catch { return null; } };
const time = v => str(v, 64) ? Date.parse(v) : NaN;
const money = v => v == null || (Number.isSafeInteger(v) && v >= 0);

// ---- Canonical JSON (identical to attest/envelope.mjs): sorted keys, NFC strings, safe integers only.
export function canonical(v, depth = 0) {
  if (depth > 8) throw new Error('canonical: too deep');
  if (v === null || typeof v === 'boolean') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isSafeInteger(v)) throw new Error('canonical: numbers must be safe integers'); return String(v); }
  if (typeof v === 'string') return JSON.stringify(v.normalize('NFC'));
  if (Array.isArray(v)) return '[' + v.map(x => canonical(x, depth + 1)).join(',') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).sort().map(k => { if (v[k] === undefined) throw new Error('canonical: undefined'); return JSON.stringify(k.normalize('NFC')) + ':' + canonical(v[k], depth + 1); }).join(',') + '}';
  throw new Error('canonical: unsupported type');
}
const sha = async u8 => new Uint8Array(await crypto.subtle.digest('SHA-256', u8));
export const digest = async v => 'sha256:' + b64u(await sha(enc.encode(canonical(v))));

// ---- RFC 9162 §2.1 Merkle tree hashing. Leaf = H(0x00 || data), node = H(0x01 || left || right).
export const leafHash = bytes => { const b = new Uint8Array(bytes.length + 1); b.set(bytes, 1); return sha(b); };
export const nodeHash = (l, r) => { const b = new Uint8Array(65); b[0] = 1; b.set(l, 1); b.set(r, 33); return sha(b); };
export const leafOf = token => leafHash(enc.encode(token));   // a log leaf is the exact signed receipt string
export const emptyRoot = () => sha(new Uint8Array(0));

// RFC 9162 §2.1.3.2: does `leaf` sit at `index` in the tree of `size` leaves whose root is `root`?
export async function verifyInclusion(leaf, index, size, path, root) {
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(size) || index < 0 || index >= size || size > LIMITS.maxSize) return false;
  if (!Array.isArray(path) || path.length > LIMITS.pathLen) return false;
  let fn = index, sn = size - 1, r = leaf;
  for (const p of path) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      r = await nodeHash(p, r);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>>= 1; sn >>>= 1; }
    } else r = await nodeHash(r, p);
    fn >>>= 1; sn >>>= 1;
  }
  return sn === 0 && eq(r, root);
}

// RFC 9162 §2.1.4.2: is the tree (first, firstRoot) a prefix of (second, secondRoot)? This is what makes the
// history append-only: a deleted, reordered or edited receipt cannot produce a valid consistency proof.
export async function verifyConsistency(first, second, firstRoot, secondRoot, path) {
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second) || first < 0 || first > second || second > LIMITS.maxSize) return false;
  if (!Array.isArray(path) || path.length > LIMITS.pathLen) return false;
  if (first === 0) return path.length === 0;
  if (first === second) return path.length === 0 && eq(firstRoot, secondRoot);
  if (path.length === 0) return false;
  const p = (first & (first - 1)) === 0 ? [firstRoot, ...path] : path;
  let fn = first - 1, sn = second - 1;
  while ((fn & 1) === 1) { fn >>>= 1; sn >>>= 1; }
  let fr = p[0], sr = p[0];
  for (const c of p.slice(1)) {
    if (sn === 0) return false;
    if ((fn & 1) === 1 || fn === sn) {
      fr = await nodeHash(c, fr); sr = await nodeHash(c, sr);
      if ((fn & 1) === 0) while ((fn & 1) === 0 && fn !== 0) { fn >>>= 1; sn >>>= 1; }
    } else sr = await nodeHash(sr, c);
    fn >>>= 1; sn >>>= 1;
  }
  return eq(fr, firstRoot) && eq(sr, secondRoot) && sn === 0;
}

// ---- Keys. The caller's key set is the trust anchor. Keys tagged "curbi_env": "test" (published test vectors)
// verify only when the caller opts in with allowTest, so demo receipts can never pass as production history.
export async function importKeys(jwks, { allowTest = false } = {}) {
  const keys = new Map(), skipped = [];
  if (!Array.isArray(jwks?.keys) || jwks.keys.length > LIMITS.keys) return { keys, skipped: [{ reason: Array.isArray(jwks?.keys) ? 'too_many_keys' : 'malformed_keys' }] };
  for (const k of jwks.keys) {
    const kid = k?.kid;
    if (!k || k.kty !== 'OKP' || k.crv !== 'Ed25519' || !str(kid, 64) || !str(k.x, 64)) { skipped.push({ kid, reason: 'malformed_key' }); continue; }
    if (k.d !== undefined) { skipped.push({ kid, reason: 'private_key_refused' }); continue; }
    const env = k.curbi_env === 'test' ? 'test' : 'production';
    if (env === 'test' && !allowTest) { skipped.push({ kid, reason: 'test_key_not_allowed' }); continue; }
    const nb = k.not_before === undefined ? -Infinity : time(k.not_before), na = k.not_after === undefined ? Infinity : time(k.not_after);
    if (Number.isNaN(nb) || Number.isNaN(na) || nb > na) { skipped.push({ kid, reason: 'malformed_key' }); continue; }
    try { keys.set(kid, { key: await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: k.x }, { name: 'Ed25519' }, false, ['verify']), nb, na, env }); }
    catch { skipped.push({ kid, reason: 'malformed_key' }); }
  }
  return { keys, skipped };
}

// Opens one "curbi1." token of the given type. The signature is checked before any field is trusted, and the
// signing domain is per type, so an attestation can never pass as a receipt or a checkpoint.
export async function openToken(type, token, keys, skipped = []) {
  if (!DOMAIN[type]) return { error: 'unknown_type' };
  if (!str(token, LIMITS.tokenChars) || !token.startsWith(PREFIX)) return { error: 'malformed' };
  const parts = token.slice(PREFIX.length).split('.');
  if (parts.length !== 2) return { error: 'malformed' };
  let payload, sig;
  try { payload = JSON.parse(dec.decode(unb64u(parts[0]))); sig = unb64u(parts[1]); } catch { return { error: 'malformed' }; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !str(payload.kid, 64)) return { error: 'malformed' };
  const k = keys.get(payload.kid);
  if (!k) return { error: skipped.find(s => s.kid === payload.kid)?.reason || 'unknown_key' };
  let ok = false;
  try { ok = await crypto.subtle.verify({ name: 'Ed25519' }, k.key, sig, enc.encode(DOMAIN[type] + parts[0])); } catch { ok = false; }
  if (!ok) return { error: 'bad_signature' };
  const at = time(type === 'attest' ? payload.iat : payload.at);
  if (Number.isNaN(at)) return { error: 'malformed' };
  if (at < k.nb || at > k.na) return { error: 'key_not_valid_at_issue' };
  return { payload, at, env: k.env };
}

async function openCheckpoint(token, keys, skipped) {
  const o = await openToken('checkpoint', token, keys, skipped);
  if (o.error) return o;
  const p = o.payload, root = hash32(p.root);
  if (p.v !== 1 || p.typ !== 'checkpoint' || p.alg !== ALG || !str(p.log, 200) || !Number.isSafeInteger(p.size) || p.size < 0 || p.size > LIMITS.maxSize || !root) return { error: 'malformed' };
  if (p.size === 0 && !eq(root, await emptyRoot())) return { error: 'malformed' };
  return { ...o, root };
}

/**
 * Verifies a proof bundle offline.
 *   bundle  { object:'curbi.proof.bundle', spec, checkpoint, items:[{receipt, attestation?, inclusion:{index, path}}],
 *             history?:[{checkpoint, consistency:[...]}], keys? }
 *   options keys       JWKS the caller trusts (pinned, or fetched from /.well-known/curbi-receipt-keys.json)
 *           trustBundleKeys  use the bundle's own keys instead (demos only; reported as keysFrom:'bundle')
 *           allowTest  accept keys tagged curbi_env:'test'
 *           mode       'archival' (default: an expired receipt still proves history) | 'fresh' (also enforce exp)
 *           known      checkpoint tokens this verifier saw before; a head that disagrees with them is a fork
 * Never throws on hostile input. Returns { ok, ... } with a typed reason for every rejection.
 */
export async function verifyBundle(bundle, options = {}) {
  const out = { ok: false, spec: SPEC, keysFrom: null, keys: { trusted: [], skipped: [] }, checkpoint: null, items: [], history: { appendOnly: null, checked: [], forks: [] }, summary: { receipts: 0, verified: 0, rejected: 0 } };
  const fail = reason => { out.reason = reason; return out; };
  try {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return fail('malformed_options');
    const { keys, trustBundleKeys = false, allowTest = false, mode = 'archival', now = Date.now(), known = [] } = options;
    if (!bundle || typeof bundle !== 'object' || bundle.object !== 'curbi.proof.bundle') return fail('not_a_bundle');
    if (bundle.spec !== SPEC) return fail('unsupported_spec');
    if (mode !== 'archival' && mode !== 'fresh') return fail('unsupported_mode');
    if (typeof now !== 'number' || !Number.isFinite(now)) return fail('malformed_clock');
    if (typeof trustBundleKeys !== 'boolean' || typeof allowTest !== 'boolean') return fail('malformed_options');
    if (!Array.isArray(bundle.items)) return fail('malformed_items');
    if (bundle.items.length > LIMITS.items) return fail('too_many_items');
    if (bundle.history !== undefined && !Array.isArray(bundle.history)) return fail('malformed_history');
    if ((bundle.history?.length ?? 0) > LIMITS.history) return fail('too_many_history');
    if (!Array.isArray(known)) return fail('malformed_known');
    if (known.length > LIMITS.known) return fail('too_many_known');
    const anchor = trustBundleKeys ? bundle.keys : keys;
    out.keysFrom = trustBundleKeys ? 'bundle' : 'caller';
    if (!anchor) return fail('no_trusted_keys');
    if (!Array.isArray(anchor.keys)) return fail('malformed_keys');
    if (anchor.keys.length > LIMITS.keys) return fail('too_many_keys');
    const { keys: K, skipped } = await importKeys(anchor, { allowTest });
    out.keys = { trusted: [...K].map(([kid, k]) => ({ kid, env: k.env })), skipped };
    if (!K.size) return fail('no_trusted_keys');

    const cp = await openCheckpoint(bundle.checkpoint, K, skipped);
    if (cp.error) return fail('checkpoint_' + cp.error);
    out.checkpoint = { log: cp.payload.log, size: cp.payload.size, root: cp.payload.root, at: cp.payload.at, kid: cp.payload.kid, env: cp.env };

    // Receipts: signature, shape, key window, freshness, inclusion under the checkpoint, attestation binding.
    const items = bundle.items;
    const seenTokens = new Set(), byKey = new Map(), positions = new Map();
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {}, row = { index: i, ok: false };
      out.items.push(row);
      const reject = reason => { row.reason = reason; };
      const r = await openToken('receipt', it.receipt, K, skipped);
      if (r.error) { reject(r.error); continue; }
      const p = r.payload;
      if (p.v !== 1 || p.status !== 'DONE' || !str(p.op, 60) || !str(p.sub) || !str(p.key) || !money(p.amount_minor) || (p.currency != null && !str(p.currency, 16)) || !(time(p.exp) >= r.at)) { reject('malformed'); continue; }
      Object.assign(row, { op: p.op, sub: p.sub, key: p.key, tenant: p.tenant ?? null, resource: p.resource ?? null, amount_minor: p.amount_minor ?? null, currency: p.currency ?? null, at: p.at, kid: p.kid, env: r.env });
      if (mode === 'fresh' && !(time(p.exp) >= now - LIMITS.skewMs)) { reject('expired'); continue; }
      if (r.at > cp.at + LIMITS.skewMs) { reject('after_checkpoint'); continue; }
      if (seenTokens.has(it.receipt)) { reject('duplicate'); continue; }
      seenTokens.add(it.receipt);
      // Two different DONE receipts for one tenant + idempotency key is issuer misbehaviour, not two refunds.
      const ik = JSON.stringify([p.tenant ?? null, p.key]);
      if (byKey.has(ik)) { reject('conflicting_receipt'); out.items[byKey.get(ik)].ok = false; out.items[byKey.get(ik)].reason = 'conflicting_receipt'; continue; }
      byKey.set(ik, i);
      const inc = it.inclusion, path = Array.isArray(inc?.path) && inc.path.length <= LIMITS.pathLen ? inc.path.map(hash32) : null;
      if (!path || path.some(h => !h)) { reject('malformed_inclusion'); continue; }
      if (positions.has(inc.index)) { reject('position_reused'); continue; }
      if (!(await verifyInclusion(await leafOf(it.receipt), inc.index, cp.payload.size, path, cp.root))) { reject('not_in_log'); continue; }
      positions.set(inc.index, i); row.leaf_index = inc.index;
      if (it.attestation !== undefined) {
        const a = await openToken('attest', it.attestation, K, skipped);
        if (a.error) { reject('attestation_' + a.error); continue; }
        const ap = a.payload;
        if (ap.v !== 1 || ap.typ !== 'attest' || !str(ap.contract_id) || !str(ap.contract_version) || !str(ap.agent_id) || !str(ap.target) || !str(ap.subject) || !str(ap.tenant) || !str(ap.resource) || !str(ap.payload_hash) || !str(ap.mutation, 60) || !str(ap.idempotency_key) || !money(ap.amount_minor) || (ap.currency != null && !str(ap.currency, 16)) || !(time(ap.exp) >= a.at)) { reject('attestation_malformed'); continue; }
        if (p.att !== await digest(it.attestation)) { reject('attestation_not_bound'); continue; }
        if (ap.mutation !== p.op || ap.tenant !== p.tenant || ap.resource !== p.resource || ap.payload_hash !== p.payload_hash || ap.subject !== p.sub || ap.idempotency_key !== p.key || (ap.amount_minor ?? null) !== (p.amount_minor ?? null) || (ap.currency ?? null) !== (p.currency ?? null)) { reject('attestation_mismatch'); continue; }
        if (a.at > r.at + LIMITS.skewMs) { reject('attestation_after_receipt'); continue; }
        Object.assign(row, { agent_id: ap.agent_id, contract_id: ap.contract_id, attested: true });
      }
      row.ok = true;
    }

    // A bad, unsigned consistency path does not prove a fork. Only incompatible signed heads do:
    // equal-size roots that differ, or a smaller head signed demonstrably after a larger one.
    const latest = { token: bundle.checkpoint, size: cp.payload.size, root: cp.root, log: cp.payload.log, at: cp.at };
    const history = bundle.history ?? [];
    const proofs = [];
    for (const h of history) {
      const o = await openCheckpoint(h?.checkpoint, K, skipped), row = { size: o.payload?.size ?? null, ok: false };
      out.history.checked.push(row);
      if (o.error) { row.reason = 'checkpoint_' + o.error; continue; }
      if (o.payload.log !== latest.log) { row.reason = 'different_log'; continue; }
      const path = Array.isArray(h.consistency) && h.consistency.length <= LIMITS.pathLen ? h.consistency.map(hash32) : null;
      if (o.payload.size === latest.size && !eq(o.root, latest.root)) { row.reason = 'history_rewritten'; out.history.forks.push({ reason: 'history_rewritten', a: h.checkpoint, b: latest.token }); continue; }
      if (o.payload.size > latest.size) { row.reason = latest.at > o.at + LIMITS.skewMs ? 'history_truncated' : 'rollback_detected'; if (row.reason === 'history_truncated') out.history.forks.push({ reason: 'history_truncated', a: h.checkpoint, b: latest.token }); continue; }
      if (o.at > latest.at + LIMITS.skewMs) { row.reason = 'checkpoint_order'; continue; }
      if (!path || path.some(x => !x) || !(await verifyConsistency(o.payload.size, latest.size, o.root, latest.root, path))) {
        row.reason = 'invalid_consistency'; continue;
      }
      proofs.push({ token: h.checkpoint, ...o }); row.ok = true;
    }
    for (const t of known) {
      const o = await openCheckpoint(t, K, skipped);
      if (o.error) { out.history.checked.push({ size: null, ok: false, reason: 'known_checkpoint_' + o.error }); continue; }
      if (o.payload.log !== latest.log) { out.history.checked.push({ size: o.payload.size, ok: false, reason: 'different_log' }); continue; }
      if (o.payload.size === latest.size && !eq(o.root, latest.root)) { out.history.forks.push({ reason: 'equivocation', a: t, b: latest.token }); continue; }
      if (o.payload.size > latest.size) { if (latest.at > o.at + LIMITS.skewMs) out.history.forks.push({ reason: 'history_truncated', a: t, b: latest.token }); else out.history.checked.push({ size: o.payload.size, ok: false, reason: 'rollback_detected' }); continue; }
      if (o.at > latest.at + LIMITS.skewMs) { out.history.checked.push({ size: o.payload.size, ok: false, reason: 'checkpoint_order' }); continue; }
      if (o.payload.size < latest.size && !proofs.some(x => x.payload.size === o.payload.size && eq(x.root, o.root))) out.history.checked.push({ size: o.payload.size, ok: false, reason: 'no_proof_for_known_head' });
    }
    out.history.appendOnly = out.history.forks.length ? false : out.history.checked.length && out.history.checked.every(c => c.ok) ? true : null;

    out.summary = { receipts: out.items.length, verified: out.items.filter(r => r.ok).length, rejected: out.items.filter(r => !r.ok).length };
    out.ok = out.summary.rejected === 0 && out.history.appendOnly !== false && !out.history.checked.some(c => !c.ok);
    if (!out.ok) out.reason = out.history.forks.length ? 'fork_detected' : out.summary.rejected ? 'receipt_rejected' : 'history_unproven';
    return out;
  } catch {
    // Typed rejection includes malformed JSON-shaped values and defensive failures in crypto/runtime APIs.
    out.ok = false; return fail('malformed_input');
  }
}
