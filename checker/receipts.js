// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Curbi signed effect receipts, v1.
// When the control plane commits an effect (status DONE) it mints a receipt signed with
// Ed25519. The Check API accepts receipts in place of caller-asserted effects, so an agent
// (or anyone calling the API) cannot claim "I booked you" unless Curbi itself recorded it.
//
//   receipt = "curbi1." + b64url(payload JSON) + "." + b64url(signature)
//   signature covers the bytes "curbi-receipt-v1." + b64url(payload)   (domain separated)
//   payload  = { v:1, kid, sub, op, key, status:"DONE", at, exp }
//     sub: the conversation/run the receipt belongs to. A receipt only counts for that subject,
//          so an explicit different subject fails verification. The API caller supplies that subject; this is not caller authentication.
//     key: the effect's idempotency key. Duplicates count once per request; no cross-request consumption is implemented.
// Uses WebCrypto only, so the same file runs in Workers, browsers and Node >= 20.
const RCPT_PREFIX = 'curbi1.', RCPT_DOMAIN = 'curbi-receipt-v1.';
const RCPT_LIMITS = { receipts: 100, chars: 2048, skewMs: 120000, maxTtlMs: 7 * 864e5 };
const rcptEnc = new TextEncoder(), rcptDec = new TextDecoder();
const b64u = u8 => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
const unb64u = s => { if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url'); const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, c => c.charCodeAt(0)); };
const rcptStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;

async function importReceiptKeys(jwks) {
  const out = new Map(); out.windows = new Map();
  for (const k of (Array.isArray(jwks?.keys) ? jwks.keys.slice(0,32) : [])) {
    if (!k || typeof k !== 'object') continue;
    if (k.kty !== 'OKP' || k.crv !== 'Ed25519' || !rcptStr(k.kid, 64) || !rcptStr(k.x, 64) || k.d) continue; // never accept a private key here
    // Optional rotation window: a retired key keeps verifying receipts issued while it was current.
    const nb = k.not_before ? Date.parse(k.not_before) : -Infinity, na = k.not_after ? Date.parse(k.not_after) : Infinity;
    if (Number.isNaN(nb) || Number.isNaN(na)) continue;
    out.windows.set(k.kid, { nb, na });
    try { out.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: k.x }, { name: 'Ed25519' }, false, ['verify'])); } catch { /* Invalid configured keys never become trusted. */ }
  }
  return out;
}

async function mintReceipt(privateJwk, f, now = Date.now()) {
  for (const n of ['kid', 'sub', 'op', 'key']) if (!rcptStr(n === 'kid' ? privateJwk.kid : f[n], 200)) throw new Error('missing ' + n);
  const ttl = Math.min(f.ttlMs || 864e5, RCPT_LIMITS.maxTtlMs);
  const payload = { v: 1, kid: privateJwk.kid, sub: f.sub, op: f.op, key: f.key, status: 'DONE', at: new Date(now).toISOString(), exp: new Date(now + ttl).toISOString() };
  if (Number.isSafeInteger(f.amount_minor) && typeof f.currency === 'string') Object.assign(payload, { amount_minor: f.amount_minor, currency: f.currency });
  const key = await crypto.subtle.importKey('jwk', { kty: 'OKP', crv: 'Ed25519', x: privateJwk.x, d: privateJwk.d }, { name: 'Ed25519' }, false, ['sign']);
  const p = b64u(rcptEnc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, key, rcptEnc.encode(RCPT_DOMAIN + p)));
  return RCPT_PREFIX + p + '.' + b64u(sig);
}

// Returns { ops:Set of verified operations, valid:n, rejected:[{index, reason}] }. Never throws on bad receipts.
async function verifyReceipts(receipts, subject, keys, now = Date.now()) {
  const res = { ops: new Set(), amounts: new Map(), valid: 0, rejected: [] }, seen = new Set();
  if (!Array.isArray(receipts)) return res;
  for (let i = 0; i < Math.min(receipts.length, RCPT_LIMITS.receipts); i++) {
    const reject = reason => res.rejected.push({ index: i, reason });
    const r = receipts[i];
    if (!rcptStr(r, RCPT_LIMITS.chars) || !r.startsWith(RCPT_PREFIX)) { reject('malformed'); continue; }
    const parts = r.slice(RCPT_PREFIX.length).split('.');
    if (parts.length !== 2) { reject('malformed'); continue; }
    let p, sig;
    try { p = JSON.parse(rcptDec.decode(unb64u(parts[0]))); sig = unb64u(parts[1]); } catch { reject('malformed'); continue; }
    if (!p || p.v !== 1 || p.status !== 'DONE' || !rcptStr(p.op, 60) || !rcptStr(p.key, 200) || !rcptStr(p.sub, 200)) { reject('malformed'); continue; }
    const key = keys.get(p.kid);
    if (!key) { reject('unknown_key'); continue; }
    let ok = false;
    try { ok = await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, rcptEnc.encode(RCPT_DOMAIN + parts[0])); } catch { ok = false; }
    if (!ok) { reject('bad_signature'); continue; }   // checked before any claim in the payload is trusted
    const at = Date.parse(p.at), exp = Date.parse(p.exp);
    const w = keys.windows && keys.windows.get(p.kid);
    if (w && !(at >= w.nb && at <= w.na)) { reject('key_not_valid_at_issue'); continue; }
    if (!(exp > at) || !(at <= now + RCPT_LIMITS.skewMs) || !(exp > now) || !(exp - at <= RCPT_LIMITS.maxTtlMs)) { reject('expired_or_not_yet_valid'); continue; }
    if (!rcptStr(subject, 200) || p.sub !== subject) { reject('wrong_subject'); continue; }
    if (seen.has(p.kid + '|' + p.key)) { reject('duplicate'); continue; }
    seen.add(p.kid + '|' + p.key); res.ops.add(p.op); res.valid++;
    // Completion receipts from the attested-execution issuer also sign the exact amount (integer minor units).
    if (Number.isSafeInteger(p.amount_minor) && typeof p.currency === 'string') {
      if (!res.amounts.has(p.op)) res.amounts.set(p.op, []);
      res.amounts.get(p.op).push({ minor: p.amount_minor, currency: p.currency.toLowerCase() });
    }
  }
  if (receipts.length > RCPT_LIMITS.receipts) res.rejected.push({ index: RCPT_LIMITS.receipts, reason: 'over_limit' });
  return res;
}
if (typeof module !== 'undefined') module.exports = { mintReceipt, verifyReceipts, importReceiptKeys, RCPT_LIMITS };
