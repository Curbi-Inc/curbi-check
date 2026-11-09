# Decision-model adapter

Decision models such as TypeSafe Jev, Fastino GLiDE and OpenAI's Decisions API return typed answers with probabilities: yes/no, one of N, or a level on a scale. This adapter checks that answer against your policy before your agent acts on it. Every check is arithmetic and comparison; Curbi never calls a vendor or holds a vendor key.

```js
import { normalizeSystemone, normalizeDecisions, compileDecisionPolicy, route, decisionReceipt, checkAction } from './src/decisions.mjs';
const policy = compileDecisionPolicy({ decisions: { refund_eligible: {
  allowed: ['eligible', 'ineligible', 'unclear'], act_at: 0.92, min_margin: 0.5,
  pin: [{ provider: 'fastino', model: 'fastino/GLiDE' }], below: 'hand_off',
  calibration: { dataset: 'refund-labels-2026-10', accuracy_at_threshold: 0.97, measured_at: '2026-10-30T00:00:00Z' },
  operations: { eligible: 'billing.refund' } } } });
const records = normalizeSystemone({ provider: 'fastino', request, response: { answers }, receivedAt: new Date().toISOString() });
const result = route(policy, 'refund_eligible', records, { now: Date.now() });   // act | escalate | hand_off | deny
const receipt = decisionReceipt({ policy, questionId: 'refund_eligible', records, result, prev: null });
checkAction(policy, 'refund_eligible', result, 'billing.refund');               // [] or decision:contradicted / decision:not_acted
```

**Checks:**
- **Shape:** probabilities lie in [0,1] and sum to 1 ± 0.01, and the selected option is allowed and has the top probability. Otherwise the result is `inconsistent`.
- **Threshold:** p(selected) ≥ `act_at`.
- **Margin:** p(top) − p(second) ≥ `min_margin`. Without per-option probabilities, the result is `margin_unavailable`.
- **Pin:** the requested provider and model must be listed.
- **Calibration:** a declared reference, younger than `max_calibration_age_days`, is required when the decision gates an operation.
- **Consensus:** all models (or k of them) must agree, within `max_divergence`. A missing model gives `escalate` with `next_model` when `below` is `escalate`. The host makes that call.
- **Refusal:** a refused answer never acts.

**Receipts:** `curbi.decision-receipt.v1` holds the policy digest, every record's digest (each record carries its request and response digests), the outcome and reasons, and `prev_receipt_digest` for chaining. Receipts are unsigned until production signing is qualified. `provider_signed` is false, because vendors don't sign responses. A receipt shows what the host received and what this check decided, not what the vendor computed.

**Limits:**
- Vendor probabilities are reported, not true. Set each threshold on labeled data; Curbi enforces a threshold but can't make it right.
- Each vendor's raw answer is validated against its documented schema before normalization; [FIELDS.md](FIELDS.md) records what's confirmed from primary sources. Microsoft-Decision-1 isn't modeled until its API shape is confirmed.
- **Raw bytes are authoritative.** Pass `requestBytes` and `responseBytes` (Uint8Array) and the adapter parses them itself, strictly: valid UTF-8, no BOM, JSON, no duplicate member names (`JSON.parse` keeps only the last, which could hide a refusal), and well-formed Unicode in every string. The record is built from that parse and the digest covers those bytes. If you also pass the parsed object, it must match the bytes (canonical JSON), or the input is malformed. Each record's `bytes_bound` says which digests cover raw bytes. Without bytes, the digests cover the canonical JSON of the objects you passed.
- **Not proven by bytes:** that the bytes came from the vendor. Vendors don't sign responses, so the binding shows what the host received, not who sent it.
