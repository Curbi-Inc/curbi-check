"""Curbi remote configured-rule checking for LangChain LCEL."""
import asyncio
from langchain_core.runnables import RunnableLambda
from ._check import Checker, CurbiError, CurbiUnavailable, CurbiBlocked

__all__ = ["curbi_guard", "CurbiError", "CurbiUnavailable", "CurbiBlocked"]


def curbi_guard(policy, *, api_key=None, timeout=10.0):
    """Pipe after generated text. Returns the exact text or raises a CurbiError.

    Remote checks send the policy and reply to Curbi. This is not a streaming
    interceptor, execution authorization, or provider confirmation.
    """
    checker = Checker(policy, api_key, timeout)

    async def check_async(reply):
        return await asyncio.to_thread(checker.check, reply)

    return RunnableLambda(checker.check, afunc=check_async, name="curbi_guard")
