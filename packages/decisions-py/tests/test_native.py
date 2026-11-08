# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Curbi, Inc.
"""Behaviour checks written against the Python API directly, alongside the JavaScript parity vectors."""
import hashlib
import json

import pytest

import curbi_decisions as D

REQ = {"model": "gpt-6-luna", "questions": [{"type": "choice", "name": "q", "choices": [{"value": "allow"}, {"value": "deny"}]}]}
ACT = {"type": "choice", "name": "q", "choice": "allow", "confidence": 0.95, "probabilities": [{"value": "allow", "probability": 0.97}, {"value": "deny", "probability": 0.03}]}
POLICY = D.compile_decision_policy({"decisions": {"q": {"allowed": ["allow", "deny"], "act_at": 0.9}}})


def test_version_matches_checker():
    assert D.CHECKER == f"curbi-check/decisions {D.__version__}"


def test_confident_answer_acts_and_receipt_is_unsigned():
    recs = D.normalize_decisions(provider="openai", request=REQ, response={"answers": [ACT]})
    out = D.route(POLICY, "q", recs, now=0)
    assert out == {"outcome": "act", "selected": "allow", "reasons": []}
    receipt = D.decision_receipt(policy=POLICY, question_id="q", records=recs, result=out)
    assert receipt["signed"] is False and receipt["provider_signed"] is False


def test_a_refusal_never_acts():
    recs = D.normalize_decisions(provider="openai", request=REQ, response={"answers": [{"type": "refusal", "name": "q"}]})
    assert D.route(POLICY, "q", recs, now=0)["outcome"] == "hand_off"


def test_true_is_not_one():
    req = {"model": "m", "questions": [{"type": "choice", "name": "q", "choices": [{"value": True}, {"value": False}]}]}
    with pytest.raises(D.Malformed, match="not a declared choice"):
        D.normalize_decisions(provider="openai", request=req, response={"answers": [{"type": "choice", "name": "q", "choice": 1, "confidence": 0.9}]})


def test_raw_bytes_are_authoritative():
    raw = json.dumps({"answers": [ACT]}).encode()
    [r] = D.normalize_decisions(provider="openai", request=REQ, response_bytes=raw)
    assert r["response_digest"] == "sha256:" + hashlib.sha256(raw).hexdigest() and r["bytes_bound"]["response"] is True
    dup = b'{"answers":[{"type":"refusal","name":"q","type":"choice"}]}'
    with pytest.raises(D.Malformed, match='duplicate member "type"'):
        D.normalize_decisions(provider="openai", request=REQ, response_bytes=dup)
    with pytest.raises(D.Malformed, match="disagree"):
        D.normalize_decisions(provider="openai", request=REQ, response={"answers": [ACT]}, response_bytes=json.dumps({"answers": [{"type": "refusal", "name": "q"}]}).encode())


def test_no_network_imports():
    import inspect
    src = inspect.getsource(D)
    for mod in ("urllib", "http", "socket", "requests", "httpx", "subprocess", "openai", "anthropic"):
        assert f"import {mod}" not in src and f"from {mod}" not in src, mod
