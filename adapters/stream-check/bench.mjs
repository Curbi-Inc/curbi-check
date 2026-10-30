// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Curbi, Inc.
// Latency of the streaming interceptor on this machine. Reports per-chunk processing time (the delay
// Curbi adds before text can reach the synthesiser), not end-to-end voice latency.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import { createStreamChecker } from './src/stream.mjs';
const policy = {
  prices: Array.from({ length: 10 }, (_, i) => ({ item: 'Plan' + i, amount: 49 + i * 10 })),
  forbid: Array.from({ length: 10 }, (_, i) => ({ id: 'rule-' + i, phrases: ['guarantee', 'full refund', 'risk free', 'approved', 'no fee'].map(p => p + (i ? ' ' + i : '')) })),
  actions: { booked: 'calendar.book', refunded: 'billing.refund', applied: 'billing.discount', sent: 'messages.send', cancelled: 'calendar.cancel' },
};
const sentence = 'Plan3 is $79 a month and includes setup, onboarding and support for your whole team. ';
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(p * a.length))];
const results = {};
for (const [label, chars, chunk] of [['typical voice turn (~350 chars)', 350, 6], ['long reply (~2,000 chars)', 2000, 6], ['max reply (4,000 chars)', 3990, 6]]) {
  const text = sentence.repeat(Math.ceil(chars / sentence.length)).slice(0, chars);
  const times = [];
  for (let rep = 0; rep < 30; rep++) {
    const s = createStreamChecker({ policy, fallback: 'A teammate will confirm that.' });
    for (let i = 0; i < text.length; i += chunk) { const t0 = performance.now(); s.push(text.slice(i, i + chunk)); times.push((performance.now() - t0) * 1000); }
    s.end();
  }
  times.sort((a, b) => a - b);
  results[label] = { chunks: times.length / 30, p50_us: +pct(times, 0.5).toFixed(1), p99_us: +pct(times, 0.99).toFixed(1), max_us: +times[times.length - 1].toFixed(1) };
}
const out = { measured: new Date().toISOString().slice(0, 10), node: process.version, cpu: os.cpus()[0]?.model, policy: '10 prices, 10 forbid rules × 5 phrases, 5 actions', chunkChars: 6, results,
  note: 'Per-push processing time on one machine. Each push re-checks the unreleased text, so cost grows with reply length. Not an end-to-end voice latency claim.' };
writeFileSync(new URL('BENCH.json', import.meta.url), JSON.stringify(out, null, 1) + '\n');
console.log(JSON.stringify(results, null, 1));

