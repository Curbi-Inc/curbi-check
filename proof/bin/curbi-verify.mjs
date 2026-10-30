#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// curbi-verify: check a Curbi Proof bundle offline. No network: keys come from a file you choose.
//   node bin/curbi-verify.mjs bundle.json --keys keys.json [--allow-test] [--fresh] [--known heads.json] [--json]
// Exit 0 = every receipt verified and no fork; 1 = rejected (reasons printed); 2 = usage error.
import { readFileSync } from 'node:fs';
import { verifyBundle } from '../src/proof.mjs';

const args = process.argv.slice(2), flag = f => args.includes(f), opt = f => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };
const file = args.find((a, i) => !a.startsWith('--') && !['--keys', '--known'].includes(args[i - 1]));
if (!file || flag('--help')) { console.error('usage: curbi-verify <bundle.json> --keys <jwks.json> [--allow-test] [--fresh] [--known <heads.json>] [--json]'); process.exit(2); }
const load = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { console.error(`cannot read ${p}: ${e.message}`); process.exit(2); } };
if (!opt('--keys')) { console.error('refusing to guess whom to trust: pass --keys <jwks.json> (for example a saved copy of https://curbi.io/.well-known/curbi-receipt-keys.json)'); process.exit(2); }
const known = opt('--known') ? load(opt('--known')) : [];
const r = await verifyBundle(load(file), { keys: load(opt('--keys')), allowTest: flag('--allow-test'), mode: flag('--fresh') ? 'fresh' : 'archival', known: Array.isArray(known) ? known : known.checkpoints || [] });
if (flag('--json')) console.log(JSON.stringify(r, null, 2));
else {
  console.log(`${r.ok ? 'VERIFIED' : 'REJECTED'}  ${r.spec}${r.reason ? '  reason=' + r.reason : ''}`);
  if (r.checkpoint) console.log(`head      ${r.checkpoint.log}  size=${r.checkpoint.size}  root=${r.checkpoint.root}  at=${r.checkpoint.at}  key=${r.checkpoint.kid} (${r.checkpoint.env})`);
  for (const i of r.items) console.log(`${i.ok ? '  ok ' : '  NO '} #${i.index} ${i.op ?? '?'} ${i.resource ?? ''}${i.amount_minor != null ? ' ' + i.amount_minor + ' ' + i.currency : ''}${i.agent_id ? ' by ' + i.agent_id : ''}${i.ok ? ' @leaf ' + i.leaf_index : ' → ' + i.reason}`);
  if (r.history.checked.length) console.log(`history   append-only=${r.history.appendOnly}  ${r.history.checked.map(c => `size ${c.size}: ${c.ok ? 'prefix proven' : c.reason}`).join('; ')}`);
  for (const f of r.history.forks) console.log(`FORK      ${f.reason}: two signed heads disagree (both returned with --json as evidence)`);
  for (const s of r.keys.skipped) console.log(`key       skipped ${s.kid}: ${s.reason}${s.reason === 'test_key_not_allowed' ? ' (add --allow-test for published test vectors)' : ''}`);
}
process.exit(r.ok ? 0 : 1);
