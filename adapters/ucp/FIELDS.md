# UCP field provenance

All confirmed fields were read from the UCP repository, tag `v2026-08-25` (commit `87dd4b1`, `github.com/Universal-Commerce-Protocol/ucp`). The ucp.dev site itself could not be loaded from this environment (proxy 403). The repository is the source the site is built from.

## Confirmed from primary source

| Field | Source |
|---|---|
| Policy `type` (required). Well-known values are `dev.ucp.shopping.policy.return` and `dev.ucp.shopping.policy.warranty`. The vocabulary is open, and platforms MUST tolerate unknown values. | `source/schemas/common/types/policy.json` |
| Policy `description` (required). It is an object with at least one of `plain`, `markdown`, `html`. | `policy.json`, `common/types/description.json` |
| Policy `applies_to`. It is an array of RFC 9535 JSONPath strings relative to the response root. When omitted, the policy is response-wide. | `policy.json`; spec overview, *Targeting* |
| Policy `url`, optional. | `policy.json` |
| Precedence: targets are evaluated against the response, and a target covers a node when a matched node's normalized path is a prefix of the node's. Depth comes first, then precision (singular query 1, set match 0). A tie is undefined and SHOULD be flagged. | `docs/specification/overview/index.md`, *Targeting* and *Precedence* (lines 3097–3162 at `87dd4b1`) |
| A name selector selects only a member of an object, and matches nothing on an array. A wildcard selects all children. An index selector selects only an element of an array. | RFC 9535 §2.3.1.2, §2.3.2.2, §2.3.3.2 |
| A disclosure is a `messages[]` warning with `presentation: "disclosure"`, `path` set to the item, and `code` set to the policy `type`. | Spec overview, *Presenting policies*; `common/types/message_warning.json` |
| Disclosure rule 1: the content MUST agree with the policy it pairs with. Rule 2: it SHOULD resolve to a governing policy. | Spec overview, *Presenting policies* |
| Warning `type` is `const "warning"`. `code`, `content` and `path` are present. `presentation` defaults to `"notice"`. | `message_warning.json` |
| Order `policies` is a snapshot of the policies that applied at checkout. Order `adjustments` is an array of `types/adjustment.json`. | `source/schemas/shopping/order.json` |
| Adjustment `type` is an open string (typically refund, return, credit, price_adjustment, dispute, cancellation). Adjustment `status` is one of `pending`, `completed`, `failed`. | `source/schemas/shopping/types/adjustment.json` |

## Not confirmed, and not relied on

- Whether any live UCP deployment emits `policies[]` with `applies_to` targeting, or disclosure warnings, in production. Only spec examples were checked.
- How Google's UCP implementation (reported to run 2026-04-08, not 2026-08-25) represents policies. The adapter targets 2026-08-25 only.
- Any machine-readable schema for policy descriptions beyond free text. None exists in this release, so time windows and final-sale wording are extracted from text by fixed rules.
- Adjustment `type` values beyond the examples. The adapter accepts `[a-z_]{1,40}` and maps four verbs: refunded, returned, credited, cancelled/canceled.
