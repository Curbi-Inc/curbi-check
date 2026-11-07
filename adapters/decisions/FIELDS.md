# Decision-model field names: confirmation status

This session couldn't load the vendor docs: the egress proxy refuses `docs.typesafe.ai`, `docs.fastino.ai` and `developers.openai.com`. Every name below comes from search-engine summaries of the vendor's own doc pages (2026-11-07). None is confirmed from the primary page yet. A session that can load those pages should mark each row confirmed, or correct it.

| Shape | Field | What the adapter assumes | Summary source | Status |
|---|---|---|---|---|
| systemone | endpoint | `POST /v1/systemone` (api.fastino.ai, api.typesafe.ai) | docs.fastino.ai/inference/systemone, docs.typesafe.ai/primitives/choice | to confirm |
| systemone | request | `model`, `state` (string, object or array), `questions` (object keyed by your ID) | same | to confirm |
| systemone | question | `type`, `instructions`; Choice and Score also `criteria` (object keyed by option) | docs.fastino.ai/inference/systemone | to confirm |
| systemone | types | `noul` (yes/no), `choice`, `score`; TypeSafe also lists `box` | docs.fastino.ai/concepts/glide-noul, docs.typesafe.ai/primitives | to confirm; `box` not supported |
| systemone | **response envelope** | the host passes the per-question answers as `answers: {id: answer}` | **not found in any summary** | **open: must be confirmed before production** |
| systemone | Noul answer | `noul` (probability of true); GLiDE also `confidence` = abs(2·noul − 1); Jev gives no confidence | glide-noul, docs.typesafe.ai/primitives | to confirm |
| systemone | Choice answer | `choice`, `confidence`, `probabilities` (keys = criteria keys, sum ≈ 1) | glide-choice, typesafe choice | to confirm |
| systemone | Score answer | `score` (integer level index), `expected_level`, `confidence`, `probabilities`, `legend` | glide-score | to confirm |
| systemone | model IDs | `fastino/GLiDE` (echoed as `glide`); `jev-1.13.0`, `jev-1.14.0` seen on different pages | glide docs, typesafe choice and box pages | to confirm; pin uses the requested model, because the echo differs |
| systemone | Microsoft-Decision-1 | not modeled | Foundry and OpenRouter listings only | **open: API shape not confirmed** |
| decisions | endpoint and model | `POST /v1/decisions`, `gpt-6-luna` only | developers.openai.com/api/docs/guides/decisions | to confirm |
| decisions | request | `model`, `input` (text or ordered messages), `questions[]` with `type`, `instructions`, `name`, and choices or levels; up to 400 | same, plus the GA changelog | to confirm; the adapter reads `choices` and `levels` |
| decisions | answers | `answers[]` with `type` and `name`; predicate gives `probability`; choice gives `choice` and `confidence` | guide examples | to confirm |
| decisions | choice per-option probabilities | read from `probabilities` if present | **not shown in any summary** | **open**: without them, the margin can't be checked and the result is `margin_unavailable` (hand-off) |
| decisions | score answer | `score` | **not shown in any summary** | **open** |
| decisions | refusal | an answer with `type: "refusal"` | guide examples, a community bug report | to confirm |

Prices quoted in sources aren't used by the adapter. They're kept out of the code on purpose: the GLiDE price conflicts between sources ($0.04/1M on Fastino's docs, $0.30/1M in one benchmark).
