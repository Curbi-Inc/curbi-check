# Curbi Check

Check an agent reply against explicit rules. Keep the exact finding as a regression.

```sh
git clone https://github.com/Curbi-Inc/curbi-check.git
cd curbi-check
npm ci --ignore-scripts
npm test
```

Node 22+. Local deterministic checker, six read-only MCP tools, AI SDK/LangChain/LiveKit adapters, stream checking and an offline proof verifier. MIT. No model calls or private checkout required. The root suite runs 371 synthetic tests. A decision-model adapter in [adapters/decisions](adapters/decisions/README.md) checks typed model answers against policy. Framework tests use synthetic models; this is not a model-quality score.

```js
const {runCheck}=require('./checker/check-api.js');
console.log(runCheck({policy:{prices:[{item:'Starter',amount:49}]},reply:'Starter is $99.'}));
```

The public API is https://api.curbi.io/v1/check; MCP is https://api.curbi.io/mcp. Docs: https://curbi.io/connect/.

A pass means no configured rule fired. Caller records remain unverified; tools are not authorized by a text check. Proof verification authenticates signed statements against keys you choose, not provider reality. Production signing is off.

The HTTP adapter in adapters/ai-sdk-http rejects streaming. Local streaming adapters preserve tool-call parts without granting execution authority. Construct a fresh local adapter when policy or supplied outcome records change; configuration is snapshotted at initialization.

## Source boundary

This is a clean export, with no private Git history. SOURCE-MANIFEST.json records source and exported digests; import relocation and MIT headers are declared transformations. The private checker remains the source of truth. The candidate includes adapter policy-snapshot PR #188; release review must pin the final private commit.

Only proof verification/specification/public vectors and their conformance suite are included. The private issuer, signing gate, reference log and vector generator are excluded. No hosted ledger, account/site code, production keys or customer failures are included.

Synthetic fixtures are regression cases, not a training corpus. Do not ingest additions into a training or trusted failure corpus without authenticated human approval. Private corpus admission is outside this public package.

## Security checks

Gitleaks 8.30.1 was checksum-verified and run with base64 decoding enabled. The five exact idempotency identifiers inside public synthetic signed vectors are allowlisted as non-credentials; no path-wide exclusion is used. The raw scan initially flagged 33 encoded vector occurrences, all mapped to those public identifiers. New credentials remain detectable. No production/private JWK is distributed.

npm dependency scripts are disabled for installation. Preserve upstream licenses; the dependency tree includes a deprecated fluent-ffmpeg dependency inherited through LiveKit. Pinned dependencies are not a promise of zero vulnerabilities.


## Framework packages

New `@curbi/vercel`, `curbi-langchain` and `curbi-llamaindex` distribution candidates live in [`packages/`](packages/PUBLISHING.md). They use real framework interfaces and audit completed text through the Check API. Registry publication and ownership are separate from a passing build; see the publishing handoff for the exact pending setup and release gates. Do not assume an unpublished name can already be installed.
