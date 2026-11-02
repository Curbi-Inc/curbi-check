# curbi-langchain

A real LangChain LCEL Runnable that checks completed **text** against your configured Curbi policy. A passing reply returns unchanged; findings raise `CurbiBlocked` with structured `.findings`. Invalid responses, timeouts and HTTP errors raise `CurbiUnavailable`, so unchecked text is not returned.

Install after the reviewed package is published: `pip install curbi-langchain==0.1.0`. For local evaluation before publication, build and install its wheel.

```python
from curbi_langchain import curbi_guard
guard = curbi_guard(policy={"prices": [{"item": "Pro", "amount": 49}]})
guard.invoke("Pro is $99.")  # CurbiBlocked: configured price mismatch
```

In an existing LangChain application, place the guard **after** `StrOutputParser()`:

```python
from langchain_core.output_parsers import StrOutputParser
from curbi_langchain import curbi_guard
# model is your existing LangChain chat model; no model is selected or funded here.
checked_chain = model | StrOutputParser() | curbi_guard(policy=your_policy)
reply = checked_chain.invoke("Explain our Pro plan")
# Also supported: await checked_chain.ainvoke(...), batch(...) and abatch(...).
```

`policy` must be a JSON dictionary with a non-empty `prices`, `forbid` or `actions` rule collection; empty/no-rule configurations are rejected before networking. Optional `api_key` goes in the Authorization header; keep it in your own secret store. `timeout` defaults to 10 seconds (accepted range 0.1–30), used as an absolute response-acceptance deadline, checked after headers, between body chunks and before accepting a result. HTTPX also applies per-phase timeouts. An already-blocked network read may finish later at its phase timeout; this is not a hard wall-clock cancellation guarantee. No automatic retries occur. Each check uses a fresh idempotency key. Managed API usage may be billable under your account's terms.

**Data and limits:** this is remote HTTP checking, not an embedded local checker. Your complete policy and reply are sent to the fixed `https://api.curbi.io/v1/check` endpoint. Redirects are refused; text/request/response sizes and verdict/finding spans are validated. Inputs support up to 4,000 UTF-16 code units and 64 KiB JSON; responses up to 256 KiB. Async checking runs the bounded synchronous client in a worker thread. Cancellation does not guarantee that an already-sent HTTP request is cancelled.

This checks completed text, not tokens as they stream; it does not prevent tools/actions already executed by the model. A pass means no configured rule fired. It grants no permission and proves no provider outcome or general truth. The adapter makes no model calls and prints no inputs, keys or provider payloads. LangChain's separately configured tracing may still record your application data.

MIT. Source and issue tracker: https://github.com/Curbi-Inc/curbi-check. Package version 0.1.0 is preparation for registry publication, not evidence it is already listed.

Validated framework version: langchain-core 1.7.4; httpx 0.28.1, Python 3.11. Tests use real framework classes and mocked HTTP, with no paid model or API calls.

The response must explicitly report `proof.authorizationGranted: false`; missing or contradictory authority metadata is rejected. A passing check never grants execution authority.
