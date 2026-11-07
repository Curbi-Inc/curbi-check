# Decision-model field names: confirmation status

This session can't load vendor pages (its proxy refuses docs.typesafe.ai, docs.fastino.ai and developers.openai.com). The statuses below come from two primary-source reads posted on #43:
- **Curbi-env:** the Curbi-environment CAIO session loaded the vendor pages on 2026-11-07 ([6710842943](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6710842943)).
- **CTO:** the CTO's reviews read the vendors' OpenAPI schemas and guides ([6705370559](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6705370559), [6707270386](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6707270386), [6709502686](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6709502686), [6710693985](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6710693985), [6710879991](https://github.com/Curbi-Inc/curbi-platform/issues/43#issuecomment-6710879991)).

## systemone (TypeSafe Jev, Fastino GLiDE)

| Field | What the adapter enforces | Status |
|---|---|---|
| endpoint | `POST /v1/systemone` on api.fastino.ai and api.typesafe.ai | confirmed (Curbi-env) |
| request | `model`, `state`, `questions` keyed by your IDs; each question has `type` and `instructions`; Choice and Score also have `criteria` | confirmed (Curbi-env) |
| providers | only `fastino` and `typesafe`; any other provider is malformed | by design |
| types | `noul`, `choice`, `score` only; TypeSafe `box` and anything else is malformed | by design (Box not supported) |
| response envelope | `answers`, an object keyed by exactly the requested question IDs; extra or missing IDs are malformed | confirmed (Curbi-env; TypeSafe `SystemOneResponse` requires `model`, `answers`, `usage`) |
| answer `type` | required for both vendors, and must equal the question's type | confirmed (CTO: Fastino and TypeSafe OpenAPI) |
| Choice criteria | an object keyed by option, both vendors; an array is malformed | confirmed (CTO) |
| Score criteria | TypeSafe: ordered array of 1 to 10 levels. GLiDE: ordered array, or numeric-key object of 1 to 255 levels, sorted and reindexed. Levels are `"0"`..`"N-1"` | confirmed (CTO, Curbi-env) |
| GLiDE Noul answer | required `type`, `noul`, `confidence`; `noul` and `confidence` in [0,1] | confirmed (CTO: Fastino OpenAPI) |
| GLiDE Choice answer | required `type`, `choice` (string), `confidence` in [0,1], `probabilities` (object) | confirmed (CTO) |
| GLiDE Score answer | required `type`, `score` (integer level index), `expected_level` (number in 0..top), `confidence`, `probabilities`, `legend` (one entry per level). The level is `score`; `expected_level` is checked against the probability-weighted mean (0.05 tolerance) | confirmed (CTO, Curbi-env) |
| TypeSafe Noul answer | required `type`, `noul`. No vendor confidence; the adapter derives abs(2·noul − 1) and records `confidence_source: "derived"` | confirmed (CTO, Curbi-env) |
| TypeSafe Choice answer | same required fields as GLiDE | confirmed (CTO) |
| TypeSafe Score answer | required `type`, `score`, `confidence`, `legend`, `probabilities`. `score` is the weighted-mean position, whole numbers included; the level comes from the probabilities; the position must lie in 0..top and within 0.05 of the mean. TypeSafe's `confidence` is never used as a probability margin | confirmed (CTO) |
| refusal | an answer with `type: "refusal"` never acts | adapter safety rule; not a documented systemone answer type |
| model IDs | `fastino/GLiDE` (echoed as `glide`). Jev `jev-1.13.0` and `jev-1.14.0`; `jev-latest` and `jev-preview` point to 1.14.0, and the response `model` gives the versioned ID. Pin versioned IDs | confirmed (Curbi-env, CTO) |

## decisions (OpenAI)

| Field | What the adapter enforces | Status |
|---|---|---|
| endpoint and model | `POST /v1/decisions`, `gpt-6-luna` only, 1 to 400 questions | confirmed (Curbi-env) |
| types | `predicate`, `choice`, `score` only | confirmed (CTO) |
| answer identity | `answers[]` correspond one to one, in order, with `questions`, matched by `name` (absent for an unnamed question); duplicate, extra, missing or mismatched answers are malformed | confirmed (CTO) |
| refusal | `type: "refusal"` never acts | confirmed (Curbi-env) |
| predicate | `probability` | confirmed (Curbi-env) |
| choice | `choice` and `confidence`; `probabilities` is an array of `{value, probability}`. `choice` and each `value` must be strictly equal to a declared choice (string or boolean); object-form probabilities and null or object values are malformed | confirmed (Curbi-env, CTO) |
| score | `score` is always a number, the weighted mean of level indices (e.g. 1.1). `probabilities` items are `{value: integer level index, label, probability}` with in-range, unique indices whose labels match the declared levels. Request levels are `{label, description}`, 2 to 10. A string score is malformed | confirmed (Curbi-env, CTO) |

## Still open
- **Microsoft-Decision-1:** no primary API documentation reachable from either session. Not modeled.
- Vendor prices are kept out of the adapter.
