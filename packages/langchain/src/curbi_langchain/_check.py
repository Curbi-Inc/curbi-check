"""Bounded remote rule checks. Never permission or provider-outcome proof."""
import copy
import json
import math
import uuid
import time
import httpx

ENDPOINT = "https://api.curbi.io/v1/check"


class CurbiError(RuntimeError):
    """No unchecked result is returned when checking fails."""


class CurbiUnavailable(CurbiError):
    """The check did not yield a valid verdict."""


class CurbiBlocked(CurbiError):
    def __init__(self, findings):
        super().__init__("Curbi found a configured-rule violation")
        self.findings = tuple(copy.deepcopy(findings))


class Checker:
    def __init__(self, policy, api_key=None, timeout=10.0):
        if not isinstance(policy, dict) or not policy:
            raise ValueError("A non-empty policy is required")
        if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0.1 <= timeout <= 30:
            raise ValueError("timeout must be between 0.1 and 30 seconds")
        if api_key is not None and (not isinstance(api_key, str) or not 1 <= len(api_key) <= 512 or any(ord(c) < 33 or ord(c) > 126 for c in api_key)):
            raise ValueError("Invalid API key")
        try:
            self._policy = json.loads(json.dumps(policy, allow_nan=False))
        except (ValueError, TypeError, RecursionError):
            raise ValueError("Policy must contain JSON values") from None
        rules = self._policy
        if not (isinstance(rules.get("prices"), list) and rules["prices"] or isinstance(rules.get("forbid"), list) and rules["forbid"] or isinstance(rules.get("actions"), dict) and rules["actions"]):
            raise ValueError("Policy has no_rules: configure prices, forbid or actions")
        self._key, self._timeout = api_key, float(timeout)

    def check(self, reply):
        if not isinstance(reply, str) or not reply.strip():
            raise CurbiUnavailable("Non-empty text is required")
        try:
            utf16 = reply.encode("utf-16-le")
            body = json.dumps({"policy": self._policy, "reply": reply}, ensure_ascii=False, allow_nan=False).encode("utf-8")
        except (UnicodeError, ValueError, TypeError, RecursionError):
            raise CurbiUnavailable("Input is not valid bounded JSON text") from None
        if len(utf16) // 2 > 4000 or len(body) > 65536:
            raise CurbiUnavailable("Check input exceeds the supported limit")
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": "CurbiPython/0.1.0", "Idempotency-Key": uuid.uuid4().hex}
        if self._key:
            headers["Authorization"] = "Bearer " + self._key
        deadline = time.monotonic() + self._timeout

        def within_deadline():
            if time.monotonic() >= deadline:
                raise CurbiUnavailable("Check network deadline exceeded")

        try:
            with httpx.Client(timeout=self._timeout, follow_redirects=False, trust_env=False) as client:
                within_deadline()
                with client.stream("POST", ENDPOINT, headers=headers, content=body) as response:
                    within_deadline()
                    if response.status_code != 200:
                        raise CurbiUnavailable("Check service did not return success")
                    if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                        raise CurbiUnavailable("Check service returned an invalid content type")
                    chunks, size = [], 0
                    for chunk in response.iter_bytes():
                        within_deadline()
                        size += len(chunk)
                        if size > 262144:
                            raise CurbiUnavailable("Check response exceeds the supported limit")
                        chunks.append(chunk)
                    within_deadline()
                    verdict = json.loads(b"".join(chunks))
        except (httpx.RequestError, UnicodeError, ValueError, RecursionError):
            raise CurbiUnavailable("Check service unavailable or response invalid") from None
        if not isinstance(verdict, dict) or verdict.get("object") != "check" or verdict.get("version") != "2026-11-01" or type(verdict.get("pass")) is not bool:
            raise CurbiUnavailable("Invalid check verdict")
        proof = verdict.get("proof")
        if not isinstance(proof, dict) or proof.get("authorizationGranted") is not False:
            raise CurbiUnavailable("Invalid check authority boundary")
        findings = verdict.get("findings")
        if not isinstance(findings, list) or len(findings) > 100 or verdict["pass"] != (len(findings) == 0):
            raise CurbiUnavailable("Inconsistent check verdict")
        for finding in findings:
            if not isinstance(finding, dict) or not isinstance(finding.get("rule"), str) or not 1 <= len(finding["rule"]) <= 100 or not isinstance(finding.get("why"), str) or not isinstance(finding.get("text"), str):
                raise CurbiUnavailable("Invalid finding")
            span = finding.get("span")
            if not isinstance(span, list) or len(span) != 2 or any(type(n) is not int for n in span) or not 0 <= span[0] <= span[1] <= len(utf16) // 2:
                raise CurbiUnavailable("Invalid finding span")
            try:
                original = utf16[span[0] * 2:span[1] * 2].decode("utf-16-le")
            except UnicodeError:
                raise CurbiUnavailable("Invalid finding span") from None
            if finding["text"] != original:
                raise CurbiUnavailable("Finding does not match original text")
        within_deadline()
        if findings:
            raise CurbiBlocked(findings)
        return reply
