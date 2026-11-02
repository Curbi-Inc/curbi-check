# curbi-llamaindex

A real LlamaIndex `BaseQueryEngine` wrapper that checks a completed `Response` before returning **the same response object**, preserving source nodes and metadata. Findings raise `CurbiBlocked` with structured `.findings`; timeout, invalid verdict and transport failures raise `CurbiUnavailable`.

Install after the reviewed package is published: `pip install curbi-llamaindex==0.1.0`. For evaluation before publication, build and install its wheel.

Given your existing LlamaIndex `query_engine` and configured policy:

```python
from curbi_llamaindex import CurbiQueryEngine
checked = CurbiQueryEngine(query_engine, policy={"prices": [{"item": "Pro", "amount": 49}]})
response = checked.query("What does Pro cost?")  # same Response, or CurbiError
```

`query_engine` must be a real LlamaIndex `BaseQueryEngine`; the example reuses yours and does not provision a model. `await checked.aquery(...)` is also supported. Only completed text `Response` objects are supported; streaming, structured Pydantic and other response types fail closed rather than silently bypassing checks.

`policy` must be a JSON dictionary with a non-empty `prices`, `forbid` or `actions` rule collection; empty/no-rule configurations are rejected before networking. Optional `api_key` is sent only in the Authorization header; keep it in your secret store. `timeout` defaults to 10 seconds (accepted range 0.1–30), used as an absolute response-acceptance deadline, checked after headers, between body chunks and before accepting a result. HTTPX also applies per-phase timeouts. An already-blocked network read may finish later at its phase timeout; this is not a hard wall-clock cancellation guarantee. No automatic retries occur. Each check uses a fresh idempotency key. Managed API usage may be billable under your account's terms.

**Data and limits:** this is remote HTTP checking, not a local embedded checker. Your policy and completed answer are sent to the fixed `https://api.curbi.io/v1/check`. Source nodes and metadata are not added to the request. Redirects are refused; verdicts and exact UTF-16 finding spans are validated. Limits: 4,000 UTF-16 text units, 64 KiB request JSON, 256 KiB response. Async checking uses a worker thread; cancelling a task does not guarantee cancellation of already-sent network work.

This wrapper cannot stop tools or provider actions already executed by the underlying engine. A pass means no configured rule fired; it grants no authorization and proves no provider outcome or general truth. This adapter selects no LLM, prints no content or keys, and adds no telemetry. Separately configured LlamaIndex tracing may still record your application data.

MIT. Source and issue tracker: https://github.com/Curbi-Inc/curbi-check. Version 0.1.0 is prepared for publication; source preparation does not mean a registry release exists.

Validated framework version: llama-index-core 0.14.25; httpx 0.28.1, Python 3.11. Tests use real framework classes and mocked HTTP, with no paid model or API calls.

The response must explicitly report `proof.authorizationGranted: false`; missing or contradictory authority metadata is rejected. A passing check never grants execution authority.

If the completed Response text changes while the network check is pending, the wrapper rejects it as `reply_changed`; unchanged Responses retain their original identity and source nodes.
