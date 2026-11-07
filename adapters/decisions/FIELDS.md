# Decision-model field names: confirmation status

This session couldn't load the vendor docs: the egress proxy refuses `docs.typesafe.ai`, `docs.fastino.ai` and `developers.openai.com`. Every name below comes from search-engine summaries of the vendor's own doc pages (2026-11-07). None is confirmed from the primary page by this session. On 2026-11-07 the CTO's review (#43 comment 6703556475), made from a session that loaded the pages, reported four corrections; they're applied below and marked "per CTO review". A session that can load those pages should still mark each row confirmed, or correct it.

| Shape | Field | What the adapter assumes | Summary source | Status |
|---|---|---|---|---|
| systemone | endpoint | `POST /v1/systemone` (api.fastino.ai, api.typesafe.ai) | docs.fastino.ai/inference/systemone, docs.typesafe.ai/primitives/choice | to confirm |
| systemone | request | `model`, `state` (string, object or array), `questions` (object keyed by your ID) | same | to confirm |
| systemone | question | `type`, `instructions`; Choice and Score also `criteria`, as an object keyed by option **or an array** (per CTO review). An array gives Choice its labels and Score its indexed levels | docs.fastino.ai/inference/systemone, glide-score | array form per CTO review; exact array item shape to confirm |
| systemone | types | `noul` (yes/no), `choice`, `score`; TypeSafe also lists `box` | docs.fastino.ai/concepts/glide-noul, docs.typesafe.ai/primitives | to confirm; `box` not supported |
| systemone | response envelope | `answers` keyed by question ID | docs.typesafe.ai (per CTO re-review 6705370559, from the primary page) | TypeSafe per CTO re-review; Fastino still to confirm |
| systemone | Noul answer | `noul` (probability of true); GLiDE also `confidence` = abs(2·noul − 1); Jev gives no confidence | glide-noul, docs.typesafe.ai/primitives | to confirm |
| systemone | Choice answer | `choice`, `confidence`, `probabilities` (keys = criteria keys, sum ≈ 1) | glide-choice, typesafe choice | to confirm |
| systemone | Score answer | GLiDE: `score` (integer level index), `expected_level`, `confidence`, `probabilities`, `legend`. TypeSafe: `score` is a fractional position from 0 through the top level, equal to the probability-weighted mean (per CTO re-review). The level is selected from `probabilities`; the position is kept as `score_position`, and one outside 0..top or more than 0.05 from the mean is `inconsistent` | glide-score, docs.typesafe.ai/primitives/score | TypeSafe per CTO re-review; GLiDE edge cases to confirm |
| systemone | model IDs | `fastino/GLiDE` (echoed as `glide`); `jev-1.13.0`, `jev-1.14.0` seen on different pages | glide docs, typesafe choice and box pages | to confirm; pin uses the requested model, because the echo differs |
| systemone | Microsoft-Decision-1 | not modeled | Foundry and OpenRouter listings only | **open: API shape not confirmed** |
| decisions | endpoint and model | `POST /v1/decisions`, `gpt-6-luna` only | developers.openai.com/api/docs/guides/decisions | to confirm |
| decisions | request | `model`, `input` (text or ordered messages), `questions[]` with `type`, `instructions`, `name`, and choices or levels; up to 400 | same, plus the GA changelog | to confirm; the adapter reads `choices` and `levels` |
| decisions | answers | `answers[]` with `type` and `name`; predicate gives `probability`; choice gives `choice` and `confidence` | guide examples | to confirm |
| decisions | choice per-option probabilities | `probabilities` as an **array of `{value, probability}`** (per CTO review); duplicate values are malformed. An object form is still accepted | developers.openai.com/api/docs/guides/decisions | per CTO review; without them the result is `margin_unavailable` |
| decisions | score answer | fractional `score` (e.g. 1.1) with `probabilities` items `{value: level index, label, probability}` (per CTO re-review, from the official guide). Levels are named by `label`; the fractional score is kept as `score_position` and checked like TypeSafe's; an integer score is a level index | developers.openai.com/api/docs/guides/decisions | per CTO re-review |
| decisions | refusal | an answer with `type: "refusal"` | guide examples, a community bug report | to confirm |

Prices quoted in sources aren't used by the adapter. They're kept out of the code on purpose: the GLiDE price conflicts between sources ($0.04/1M on Fastino's docs, $0.30/1M in one benchmark).
