import importlib
import json
import time
import httpx
import pytest

check = importlib.import_module("curbi_langchain._check")
POLICY = {"prices": [{"item": "Pro", "amount": 49}]}
PASS = {"object": "check", "version": "2026-11-01", "pass": True, "findings": [], "proof": {"authorizationGranted": False}}


@pytest.fixture
def wire(monkeypatch):
    original = httpx.Client
    calls = []
    state = {"response": lambda req: httpx.Response(200, json=PASS)}

    def handler(request):
        calls.append(request)
        assert str(request.url) == "https://api.curbi.io/v1/check"
        assert request.method == "POST"
        return state["response"](request)

    def client(**kwargs):
        assert kwargs["follow_redirects"] is False
        assert kwargs["trust_env"] is False
        assert 0.1 <= kwargs["timeout"] <= 30
        return original(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(check.httpx, "Client", client)
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "false")
    monkeypatch.setenv("LANGSMITH_TRACING", "false")
    return state, calls


def test_pass_preserves_unicode_policy_snapshot_auth_and_idempotency(wire):
    state, calls = wire
    policy = {"prices": [{"item": "Pro", "amount": 49}]}
    c = check.Checker(policy, api_key="private-synthetic-test")
    policy["prices"][0]["amount"] = 999
    for _ in range(2):
        assert c.check("😀 Pro is $49.") == "😀 Pro is $49."
    assert json.loads(calls[0].content)["policy"]["prices"][0]["amount"] == 49
    assert calls[0].headers["Authorization"] == "Bearer private-synthetic-test"
    assert calls[0].headers["Idempotency-Key"] != calls[1].headers["Idempotency-Key"]
    assert "private-synthetic-test" not in repr(c)


def test_block_returns_structured_findings_with_utf16_span(wire):
    state, _ = wire
    finding = {"rule": "price:mismatch", "span": [3, 6], "text": "$99", "why": "Configured price differs"}
    state["response"] = lambda req: httpx.Response(200, json={**PASS, "pass": False, "findings": [finding]})
    with pytest.raises(check.CurbiBlocked) as error:
        check.Checker(POLICY).check("😀 $99")
    assert error.value.findings == (finding,)


@pytest.mark.parametrize("status", [301, 302, 307, 308, 400, 401, 403, 429, 500, 503])
def test_http_error_and_redirect_never_release_reply(wire, status):
    state, calls = wire
    state["response"] = lambda req: httpx.Response(status, headers={"Location": "https://elsewhere.invalid"})
    with pytest.raises(check.CurbiUnavailable):
        check.Checker(POLICY).check("Pro is $49.")
    assert len(calls) == 1


@pytest.mark.parametrize("verdict", [[], {}, {**PASS, "object": "check.batch"}, {**PASS, "version": "unknown"}, {**PASS, "pass": 1}, {**PASS, "findings": None}, {**PASS, "pass": False}, {**PASS, "findings": [{"rule": "x"}]}, {**PASS, "pass": False, "findings": [{"rule": "x", "why": "x", "span": [-1, 2], "text": "Pr"}]}, {**PASS, "pass": False, "findings": [{"rule": "x", "why": "x", "span": [0, 3], "text": "wrong"}]}, {**PASS, "pass": False, "findings": [{"rule": "x", "why": "x", "span": [False, 2], "text": "Pr"}]}])
def test_malformed_or_inconsistent_verdict_fails_closed(wire, verdict):
    state, _ = wire
    state["response"] = lambda req: httpx.Response(200, json=verdict)
    with pytest.raises(check.CurbiUnavailable):
        check.Checker(POLICY).check("Pro is $49.")


@pytest.mark.parametrize("response", [httpx.Response(200, content=b"{", headers={"Content-Type": "application/json"}), httpx.Response(200, json=PASS, headers={"Content-Type": "text/html"}), httpx.Response(200, content=b" " * 262145, headers={"Content-Type": "application/json"})])
def test_bad_json_content_type_and_oversized_response(wire, response):
    state, _ = wire
    state["response"] = lambda req: response
    with pytest.raises(check.CurbiUnavailable):
        check.Checker(POLICY).check("Pro is $49.")


def test_timeout_is_typed_sanitized_and_not_retried(wire):
    state, calls = wire
    def timeout(req):
        raise httpx.ReadTimeout("private-synthetic-test must not appear")
    state["response"] = timeout
    with pytest.raises(check.CurbiUnavailable) as error:
        check.Checker(POLICY, timeout=0.1).check("Pro is $49.")
    assert "private-synthetic-test" not in str(error.value)
    assert len(calls) == 1


@pytest.mark.parametrize("reply", [None, {}, "", " ", "x" * 4001, "😀" * 2001, "\ud800"])
def test_bad_reply_is_refused_before_network(wire, reply):
    _, calls = wire
    with pytest.raises(check.CurbiUnavailable):
        check.Checker(POLICY).check(reply)
    assert not calls


def test_oversized_json_refused_before_network(wire):
    _, calls = wire
    with pytest.raises(check.CurbiUnavailable):
        check.Checker({**POLICY, "large": "x" * 65536}).check("hello")
    assert not calls


@pytest.mark.parametrize("kwargs", [{"policy": {}}, {"policy": []}, {"policy": POLICY, "timeout": 0}, {"policy": POLICY, "timeout": True}, {"policy": POLICY, "timeout": float("inf")}, {"policy": POLICY, "api_key": "secret\nheader"}])
def test_invalid_constructor(kwargs):
    with pytest.raises(ValueError):
        check.Checker(**kwargs)


@pytest.mark.parametrize("policy", [{"prices": []}, {"forbid": []}, {"actions": {}}, {"prices": [], "forbid": [], "actions": {}}, {"metadata": "not a rule"}])
def test_policy_with_no_rules_refused_at_construction(policy):
    with pytest.raises(ValueError, match="no_rules"):
        check.Checker(policy)


def test_dribbling_body_cannot_extend_total_acceptance_deadline(wire, monkeypatch):
    state, _ = wire
    clock = [0.0]
    monkeypatch.setattr(time, "monotonic", lambda: clock[0])
    consumed = []
    class Dribble(httpx.SyncByteStream):
        def __iter__(self):
            for byte in json.dumps(PASS).encode():
                clock[0] += 0.06  # each chunk arrives inside the0.1s read timeout
                consumed.append(byte)
                yield bytes([byte])
    state["response"] = lambda req: httpx.Response(200, headers={"Content-Type": "application/json"}, stream=Dribble())
    with pytest.raises(check.CurbiUnavailable, match="deadline"):
        check.Checker(POLICY, timeout=0.1).check("Pro is $49.")
    assert len(consumed) < len(json.dumps(PASS))


@pytest.mark.parametrize("proof", ["missing", None, {}, {"authorizationGranted": True}, {"authorizationGranted": 0}, "authority"])
def test_verdict_must_explicitly_deny_execution_authority(wire, proof):
    state, _ = wire
    verdict = dict(PASS)
    if proof == "missing":
        verdict.pop("proof")
    else:
        verdict["proof"] = proof
    state["response"] = lambda req: httpx.Response(200, json=verdict)
    with pytest.raises(check.CurbiUnavailable):
        check.Checker(POLICY).check("Pro is $49.")
