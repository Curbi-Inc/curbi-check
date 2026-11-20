# UCP adapter

Checks the agreement UCP requires but nobody verifies.

UCP v2026-08-25, *Presenting policies*: a disclosure's content "**MUST** agree with the policy it pairs with." UCP pairs each disclosure with the one policy that governs its `path` under its own precedence rules. No party in the protocol checks that the two agree. This adapter does, with deterministic code only. It calls no model and makes no network calls.

## Scope

Only the two well-known policy types are in scope:

- `dev.ucp.shopping.policy.return`
- `dev.ucp.shopping.policy.warranty`

Disclosures with any other `code` are reported as `out_of_scope` and not checked.

## What it does

| Function | Input | Checks |
|---|---|---|
| `checkDisclosures(response)` | A cart, checkout or order response with `policies[]` and `messages[]` | Resolves the governing policy for each `presentation: "disclosure"` warning, using spec *Precedence* steps 1–4 (depth first, then singular over set; a tie is `ambiguous`). It then compares the disclosure with that policy on two things: stated time windows (days/weeks compared in days, months/years in months; days are never converted to months) and final-sale vs returnable wording. |
| `checkReplyTerms({ response, reply })` | An agent reply and the same response | Checks a reply's claims about return windows, warranty length and final sale against the response's in-scope policies. A reply names no JSONPath, so final sale is flagged only when every return policy is final sale. |
| `orderRecord(order)` / `checkReplyAgainstOrder({ order, reply })` | A UCP Order | Turns `adjustments[]` into a Curbi record. Only `status: "completed"` counts as `DONE`. The unchanged Curbi checker then checks claims such as "I refunded you" against it. |

### Disclosure statuses

| Status | Meaning |
|---|---|
| `verbatim` | Same text after normalizing case and whitespace. |
| `no_conflict_found` | The two checks found no conflict. This is **not** proof of agreement: different wording cannot be judged without interpretation, and this adapter does not interpret. |
| `conflict` | A finding: `ucp:disclosure-duration-mismatch` or `ucp:disclosure-final-sale-mismatch`. |
| `unpaired` | No policy of that type covers the path (spec rule 2, SHOULD). Reported as `ucp:disclosure-unpaired`. |
| `ambiguous` | Two same-type policies tie, so UCP leaves the outcome undefined. Reported as `ucp:policy-ambiguous`. |
| `unsupported` | The path or a target uses JSONPath this adapter does not evaluate (filters, slices, descendant segments, negative indexes), or the disclosure path is not singular. Reported as `ucp:path-unsupported`. It is never guessed. |
| `out_of_scope` | Not a return or warranty disclosure. |

## What it does not claim

- **UCP policy is not Curbi policy.** `policies[]` and `messages[]` are the business's own statements. The adapter checks them against each other, and the agent's reply against them. Output carries `sourceTrust: "business_self_reported"`.
- **The Order does not prove completion.** It is a business-written snapshot (`recordSource: "ucp_order_business_snapshot"`), not independent provider confirmation that a refund or return happened.
- **It does not prove agreement.** It finds specific, checkable conflicts. `no_conflict_found` is the absence of those findings, nothing more.
- **Output is unsigned.** No result is a PAP receipt.

## Evidence

- 16 tests in `test/ucp.test.mjs`. The fixtures marked SPEC are copied from the specification.
- 16 targeted mutations to the source each made at least one test fail.
- All 3 `$.policies` examples in the v2026-08-25 docs are accepted. The one policy-plus-disclosure pair in the spec (the engraved final-sale item) returns `verbatim` with no findings.
- All 4 Order examples with `adjustments[]` in `docs/specification/shopping/order/index.md` map to records.

Field provenance is listed in [FIELDS.md](FIELDS.md).
