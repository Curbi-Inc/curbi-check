#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Read-only route smoke test for api.curbi.io, for the legacy-API retirement.
//   node tools/route-smoke.mjs --phase before   # supported routes must pass; legacy routes are reported
//   node tools/route-smoke.mjs --phase after    # supported routes must pass AND every legacy route must be gone
// Sends no bodies and no writes. Supported routes are read with GET (the MCP with a read-only tools/list POST).
// Legacy POST routes are probed with OPTIONS only, so no handler runs. Exit 0 = pass, 1 = fail, 2 = usage error.
const BASE = process.env.CURBI_API_BASE || 'https://api.curbi.io';
const phase = process.argv.includes('--phase') ? process.argv[process.argv.indexOf('--phase') + 1] : null;
if (!['before', 'after'].includes(phase)) { console.error('usage: route-smoke.mjs --phase before|after'); process.exit(2); }

const json = async r => { try { return JSON.parse(await r.text()); } catch { return null; } };
const SUPPORTED = [
  ['GET /v1/check', () => fetch(BASE + '/v1/check'), async r => r.status === 200 && (await json(r))?.object === 'check.info'],
  ['GET /.well-known/curbi-receipt-keys.json', () => fetch(BASE + '/.well-known/curbi-receipt-keys.json'), async r => r.status === 200 && Array.isArray((await json(r))?.keys)],
  ['POST /mcp tools/list', () => fetch(BASE + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }),
    async r => r.status === 200 && ((await json(r))?.result?.tools ?? []).some(t => t.name === 'policy_check')],
  ['GET /proof/health', () => fetch(BASE + '/proof/health'), async r => r.status === 200 && (await json(r))?.service === 'curbi-hosted-proof'],
];
// The 19 endpoints the legacy "Curbi API 2.0.0" lists at its root, plus the root itself. IDs are fixed fakes.
const LEGACY_GET = ['/', '/health', '/api/signals/route-smoke-000000', '/api/report/route-smoke-000000', '/report/route-smoke-000000'];
const LEGACY_OPTIONS = ['/api/config/pipeline', '/api/contact', '/api/audit/start', '/api/audit/complete', '/api/report/generate', '/api/report/send',
  '/api/tour/start', '/api/tour/complete', '/api/demo/start', '/api/demo/complete', '/api/consultation/book', '/api/setup/start',
  '/api/onboarding/start', '/api/customer/live', '/api/signal'];
// Legacy is "alive" if it answers in its own shape: JSON with an "ok" field, a "Curbi API" service name, its report page,
// or its CORS preflight (204 allowing POST with Authorization).
async function legacyAlive(method, path) {
  const r = await fetch(BASE + path, { method, headers: method === 'OPTIONS' ? { origin: 'https://route-smoke.invalid', 'access-control-request-method': 'POST' } : {} });
  if (method === 'OPTIONS') return { status: r.status, alive: r.status === 204 && /authorization/i.test(r.headers.get('access-control-allow-headers') || '') };
  const text = await r.text();
  let body = null; try { body = JSON.parse(text); } catch {}
  return { status: r.status, alive: (body && ('ok' in body || body.service === 'Curbi API')) || /<title>\s*Curbi Report\s*<\/title>/i.test(text) };
}

let failed = false;
console.log(`route-smoke ${phase} against ${BASE} at ${new Date().toISOString()}`);
for (const [name, call, ok] of SUPPORTED) {
  let pass = false, status = 'error';
  try { const r = await call(); status = r.status; pass = await ok(r); } catch (e) { status = String(e.message || e); }
  console.log(`${pass ? 'PASS' : 'FAIL'}  supported  ${name}  [${status}]`);
  if (!pass) failed = true;
}
let alive = 0;
for (const [method, paths] of [['GET', LEGACY_GET], ['OPTIONS', LEGACY_OPTIONS]]) for (const p of paths) {
  let res; try { res = await legacyAlive(method, p); } catch (e) { res = { status: String(e.message || e), alive: false }; }
  if (res.alive) alive++;
  const bad = phase === 'after' && res.alive;
  if (bad) failed = true;
  console.log(`${bad ? 'FAIL' : res.alive ? 'LIVE' : 'GONE'}  legacy     ${method} ${p}  [${res.status}]`);
}
console.log(`legacy routes still answering: ${alive}/${LEGACY_GET.length + LEGACY_OPTIONS.length}`);
console.log(failed ? 'RESULT: FAIL' : 'RESULT: PASS');
process.exit(failed ? 1 : 0);
