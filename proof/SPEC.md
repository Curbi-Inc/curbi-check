# Curbi Proof 0.1: portable, offline-verifiable records of agent actions

**Status:** open draft. Wire tokens and vectors are stable for 0.1. Production signing is **off**: the published key set (`/.well-known/curbi-receipt-keys.json`) is empty, and every example here uses a key tagged `curbi_env: "test"`.

## 1. Why this exists
When anyone can rebuild a stack from a prompt, code and model quality stop being defensible. A history of actions that a public key can check, and that cannot be quietly rewritten, keeps its value. This spec makes that history portable.

- Proof travels with the record.
- Any party can verify it offline: another agent, a merchant, an auditor, a device in a physical space. They need no call to Curbi, no account and no network.

The contract is deliberately generic. A mutation is a mutation whether the provider is a payment processor, a calendar, a dispatch system or a door controller. The vectors cover all four.

## 2. Objects
Every signed object uses one envelope (shipped since Check API v15):

```
token   = "curbi1." base64url(payload JSON) "." base64url(Ed25519 signature)
message = DOMAIN || base64url(payload JSON)          // what the signature covers
```

| Type | DOMAIN | Signed when | Key payload fields |
|---|---|---|---|
| Attestation | `curbi-attest-v1.` | **Before** a mutation runs, after grant, limits, budget and rate checks pass | `contract_id`, `contract_version`, `tenant`, `subject`, `agent_id`, `mutation`, `target`, `resource`, `payload_hash`, `idempotency_key`, `grant_digest`, `amount_minor`/`currency`, `recovery`, `iat`/`exp` |
| Receipt | `curbi-receipt-v1.` | **After** the provider confirms exactly the attested mutation | `sub`, `op`, `key`, `status: "DONE"`, `tenant`, `resource`, `payload_hash`, `amount_minor`/`currency`, `att` (digest of the attestation), `evidence` (digest of provider evidence), `at`/`exp` |
| Checkpoint | `curbi-checkpoint-v1.` | Whenever the issuer publishes its log head | `v: 1`, `typ: "checkpoint"`, `alg: "rfc9162-sha256"`, `log`, `size`, `root`, `at`, `kid` |

- **Domain separation:** a permission can never be replayed as a completion, and neither can pass as a log head.
- **No receipt for unknown outcomes:** a failed or UNKNOWN outcome produces no receipt and nothing enters the log. The key is held until reconciled (see `private execution gate (not distributed here)`).
- **Digests:** `digest(x) = "sha256:" base64url(SHA-256(canonical(x)))`. Canonical JSON uses sorted keys, NFC strings and safe integers only. Money is integer minor units.

## 3. The log
Receipts are leaves of an append-only Merkle tree using **RFC 9162 §2.1 hashing**:
- `leaf = SHA-256(0x00 || receipt token bytes)`
- `node = SHA-256(0x01 || left || right)`
- empty tree: `SHA-256("")`

This is the Certificate Transparency construction, so CT tooling and auditors already understand it. Inclusion proofs use RFC 9162 §2.1.3 and consistency proofs use §2.1.4.

A tree size and root are meaningful only as the pair one checkpoint signs. Verifiers must never take them from anywhere else.

## 4. Bundle
The unit that travels between parties:

```json
{ "object": "curbi.proof.bundle", "spec": "curbi.proof/0.1",
  "checkpoint": "curbi1.…",
  "items":   [{ "receipt": "curbi1.…", "attestation": "curbi1.…", "inclusion": { "index": 0, "path": ["…"] } }],
  "history": [{ "checkpoint": "curbi1.… (older head)", "consistency": ["…"] }],
  "keys":    { "keys": [ … ] } }
```

`attestation`, `history` and `keys` are optional.

## 5. Verification (`verifyBundle` in `src/proof.mjs`)
1. **Trust anchor: the caller's key set.** Keys inside a bundle are ignored unless the caller explicitly opts in. The result then says `keysFrom: "bundle"`.
   - Private keys are refused.
   - Keys tagged `curbi_env: "test"` are refused unless `allowTest` is set.
   - Each key's `not_before`/`not_after` window is checked against the signing time of every token it vouches for.
2. **Checkpoint:** signature (checkpoint domain), shape, key window.
3. **Each receipt:**
   - signature (receipt domain), `status: "DONE"`, key window;
   - in `fresh` mode only, `exp` (archival mode keeps history valid after expiry);
   - not dated after the head;
   - not a duplicate;
   - no other DONE receipt for the same tenant and idempotency key;
   - one receipt per log position;
   - **RFC 9162 inclusion under the signed head**.
4. **Attestation, if present:** signature (attest domain), version 1, type `attest`, required identity fields and a well-formed issue/expiry interval. `receipt.att` must equal its digest; mutation, tenant, resource, payload hash, subject, idempotency key, amount and currency must match. It cannot be issued after the receipt's completion time (allowing the documented two-minute clock skew).
   - The receipt can be issued after permission expiry when reconciliation finishes later. A completion timestamp is not an execution timestamp; the bundle does not prove that execution began within the permission's validity interval.
5. **History:** each older head must be from the same log, no larger, and **proven a prefix** by an RFC 9162 consistency proof.
   - Heads the verifier saw before (`known`) are compared too.
   - The same size with a different root is **equivocation** (`history_rewritten` for a supplied history entry; `equivocation` for a caller-known head).
   - A missing or failed unsigned consistency path is **invalid_consistency** and leaves history unproven. It is not evidence that the issuer rewrote history: an intermediary can damage a proof between two honest heads.
   - A larger previously seen head makes delivery of a smaller head **rollback_detected**. This rejects the stale bundle without accusing the issuer of fraud.
   - **history_truncated** is reserved for a smaller head signed demonstrably later than a larger head (beyond the clock-skew allowance).
   - Only incompatible signed heads enter `history.forks`: equal-size divergent roots, or the signed size regression above. Both signed heads are returned for independent checking.
6. `ok` is true only if every receipt verifies, no fork exists, and every supplied or known older head is proven.

### Shapes and bounds
`items` is a required array; an explicit empty array may verify a checkpoint with zero receipts. `history`, if present, and caller `known` must be arrays. The selected trusted key set must contain a `keys` array. Limits are 256 items, 16 history entries, 64 known heads, 32 keys, 64 hashes per proof, 4,096 characters per token and tree size at most 2³¹−1. Excess collections are rejected in their entirety, never silently sliced. Invalid verification modes and clocks are rejected. Malformed inputs return a typed rejection rather than throwing.

### Reason codes
- Checkpoint: `checkpoint_*`.
- Receipt: `malformed`, `unknown_key`, `bad_signature`, `test_key_not_allowed`, `key_not_valid_at_issue`, `expired`, `after_checkpoint`, `duplicate`, `conflicting_receipt`, `malformed_inclusion`, `position_reused`, `not_in_log`.
- Attestation: `attestation_*`, `attestation_not_bound`, `attestation_mismatch`, `attestation_after_receipt`.
- History: `invalid_consistency`, `history_rewritten`, `equivocation`, `history_truncated`, `rollback_detected`, `different_log`, `checkpoint_order`, `no_proof_for_known_head`, `known_checkpoint_*`.
- Bundle: `not_a_bundle`, `unsupported_spec`, `no_trusted_keys`, `too_many_items`, `too_many_history`, `too_many_known`, `too_many_keys`, `malformed_*`, `unsupported_mode`, `fork_detected`, `receipt_rejected`, `history_unproven`.

## 6. What a valid bundle shows, and what it does not
**Shows:**
- A key you trust signed these exact receipts.
- Each receipt follows an attestation for the same mutation, where one is included.
- They occupy these positions in one checkpointed Merkle tree.
- With consistency proofs, earlier heads were not rewritten.

**Does not show:**
- that the provider's own systems agree. The receipt binds a *digest* of the provider evidence, and that evidence is only as strong as its source;
- that the issuer logged every action it took (omission). Monitors comparing heads over time, and providers co-signing, are the 0.2 work;
- anything about events signed by keys you did not choose to trust.
- execution within a permission's validity interval, a provider's present state, or absence of unknown forks when no remembered/witnessed heads are supplied.

## 7. Conformance
`vectors/cases.json` holds 16 cases generated from the real gate with a fixed clock and a seed-derived test key. Ed25519 is deterministic, so regeneration is byte-identical.

A conforming verifier gives each case its `expect` result:
- `options` are the verification options;
- `options.keys` absent means use the top-level `keys`;
- `null` means no caller keys.

`test/conformance.test.mjs` needs only `src/proof.mjs` and the vectors.

## 8. Generic by design
- **Operations** are `domain.verb` (`billing.refund`, `calendar.book`, `dispatch.create`, `access.unlock`).
- **Resources** are opaque URIs (`charge:ch_1001`, `space:hq/floor-3/door-2`).
- **Amounts** are optional and, when present, bound end to end.

Nothing in the envelope, log or verifier knows about refunds, the web or a particular provider.

## 9. Prior art (not novel, and we say so)
- Certificate Transparency (RFC 6962/9162), Trillian and Sigstore Rekor: Merkle-logged signed records.
- Google AP2 mandates: amount-bound signed authorization.
- Tool-execution receipts (arXiv 2603.10060).

Curbi's contribution is the binding across the whole action:
- grant → attested mutation → provider-confirmed receipt → logged history → the agent's customer-facing claim, checked by the Check API against the same receipt;
- one provider-agnostic contract;
- open conformance vectors.

## 10. Next (0.2)
- Production key ceremony and the first production-signed effect.
- Durable single-writer log with published heads.
- Witness co-signing of checkpoints, so equivocation is caught without the verifier having seen the old head.
- Provider-signed evidence where providers support it.
- A read-only MCP tool that verifies bundles.
