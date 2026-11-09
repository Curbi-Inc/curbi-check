# Input gate: deterministic checks at input

The "check at input" half of the product: every item that enters a model's context gets a deterministic context check, and a proposed action is admitted only when the turn's checks support it. It implements the design on curbi-platform#43 ([6683031134](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6683031134), with the boundary revision [6686406580](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6686406580)). It is a pure library and stays unsigned; the host signs the manifest and appends records to the gate log.

```js
import { compileInputPolicy, compileRegistry, gateTurn, admitProposal, memoryNonces, memoryTurns } from './src/input-gate.mjs';
const policy = compileInputPolicy({ version: 1, classes: { retrieval: 'hand-off' },
  entities: [{ type: 'charge', prefix: 'ch_', min: 8, max: 40 }],
  claims: { prices: [{ item: 'Pro', amount: 99 }], actions: { refunded: 'billing.refund' } } });
const registry = compileRegistry({ version: 3, revocation_checked_at, ed25519: [{ kid, public_key_pem, classes: ['tool'] }], hmac: [{ id: 'we_1', secret }] });
const turn = gateTurn({ items, policy, registry, ctx: { turn_id, scope_digest, now, nonces, state, grant, index, request_bytes } });
// host: sign turn.manifest, append turn.checks and the manifest to the gate log, call the model
const decision = admitProposal({ proposal, turn, grant, policy, registry, ctx: { now, turns } });   // admit | deny + reasons
```

## Lanes

| Lane | What it checks | Outcomes |
|---|---|---|
| **Provenance** | An ed25519 signature or Stripe webhook HMAC, against keys pinned in the host's registry. Also checks the key's class, revocation and expiry, nonce replay, the principal (scope) binding, signature age, and freshness of the revocation data. | `verified`, `unsigned`, `unconfirmed` (unknown key, stale revocation data) or `denied` (bad signature, input-supplied key, revoked or expired key, replay, principal mismatch) |
| **State consistency** | Claims the item makes, extracted by the shipped checker's own extractors (prices, discounts, action claims). They're compared with this scope's DONE receipts, matched to the item's `operation_id` when it names one. | Per claim: `confirmed`, `unconfirmed` or `contradicted` |
| **Scope authorization** | The grant (operation, resource, currency, cap, expiry, scope) and **tuple provenance**. One verified tool or state observation, or a grant tuple, must bind the same operation, resource and currency, with a maximum at or above the amount. The grant cap bounds the amount but never supplies the tuple. Also checks the manifest (digest, expiry, turn, scope, policy, registry) and one operation per turn. | `admit`, or `deny` with reasons |

**Item verdicts:**
- `denied`: provenance was denied, or an entity is out of scope.
- `contradicted`: a claim conflicts with the policy.
- `verified`: provenance verified and every claim confirmed.
- `unconfirmed`: anything else.

**Turn disposition:** each class's mode is `allow-labeled`, `hand-off` or `block`. The turn's disposition is `proceed_labeled`, `hand_off` or `block`.

## Times
- **Every time is strict ISO 8601 UTC** (`2026-11-08T20:00:00Z`, optional milliseconds). That covers registry `revocation_checked_at`, each key's `not_after` and each envelope's `issued_at`. Loose forms and junk are refused, and `ctx.now` must be a finite number.
- **Key validity:** every pinned ed25519 key needs a `not_after`. It's expired at that instant (`now >= not_after`), not only after it.
- **Revocation data:** it's fresh only if it was checked at or before `now`, and no longer ago than `max_revocation_age_ms`. A check time in the future gives `unconfirmed` (`revocation_data_from_future`), never `verified`.
- **Why:** this closes the CTO review findings in 6727923670.

## Boundaries, each locked by a test that fails if broken
- **No AI judges input text.**
  - The only text logic is literal extraction by the shipped checker.
  - The source may import only `node:crypto`, `node:module` and the checker.
  - Policy and registry fields that would configure a judge, model, classifier, prompt, hook or callback are refused.
  - Functions and proxies are refused as input.
  - An item's words about itself (`"verified": true`) change nothing.
- **No double-brokered check.**
  - Everything is computed in process, once, with no network.
  - Remote, endpoint, URL and broker settings are refused.
  - `admitProposal` recomputes every check digest and the manifest digest, so a verdict computed elsewhere is never accepted.
- **No LLM checks LLM output.**
  - Model output is an item like any other. Even signed, it never supplies a tuple.
  - No callback can be passed in.

`node adapters/input-gate/mutations.mjs` breaks each boundary in the source, one at a time, and requires a test to fail. All 12 mutations are caught, including three timestamp mutations. Results are read from TAP output.

## Host work (CTO, curbi-platform)
- Sign `turn.manifest` in the attestation domain, and append the context checks and manifest to the gate log.
- Add the `context_digest` / manifest reference to the executor's input assessment.
- Call `admitProposal` before dispatch, deny on `deny`, and keep the durable nonce and turn stores (this library ships in-memory ones for tests).

## Limits
- **Verified means authenticated, not true.** Unsigned text is never shown true, and no injection detection is claimed. Coverage is only the declared classes, ID formats, keys and claim rules.
- **The extractors are the output checker's.** What it can't read (for example, the telegraphic status claims found by dogfooding), this can't read either.
- **No Curbi receipt or bundle verifier yet.** Curbi receipts and bundles as provenance sources aren't wired in this patch: only ed25519 host signatures and Stripe webhook HMACs.
- **JSON fields are flattened.** Every string field of a JSON item is read as text; structure beyond `observation` and `operation_id` isn't interpreted.
