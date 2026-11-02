"""Curbi remote configured-rule checks for completed LlamaIndex responses."""
import asyncio
from llama_index.core.base.base_query_engine import BaseQueryEngine
from llama_index.core.base.response.schema import Response
from ._check import Checker, CurbiError, CurbiUnavailable, CurbiBlocked

__all__ = ["CurbiQueryEngine", "CurbiError", "CurbiUnavailable", "CurbiBlocked"]


class CurbiQueryEngine(BaseQueryEngine):
    """Check a completed Response before returning the same object and sources.

    Streaming/non-text response types fail closed; this wrapper does not gate
    tools executed inside the wrapped engine or grant execution permission.
    """
    def __init__(self, query_engine, policy, *, api_key=None, timeout=10.0):
        if not isinstance(query_engine, BaseQueryEngine):
            raise ValueError("query_engine must be a LlamaIndex BaseQueryEngine")
        super().__init__(callback_manager=query_engine.callback_manager)
        self._engine = query_engine
        self._checker = Checker(policy, api_key, timeout)

    def _get_prompt_modules(self):
        return {"query_engine": self._engine}

    def _checked(self, response):
        if not isinstance(response, Response) or not isinstance(response.response, str):
            raise CurbiUnavailable("Only completed text Responses are supported")
        snapshot = response.response
        self._checker.check(snapshot)
        if response.response != snapshot:
            raise CurbiUnavailable("reply_changed during check")
        return response

    def _query(self, query_bundle):
        return self._checked(self._engine.query(query_bundle))

    async def _aquery(self, query_bundle):
        response = await self._engine.aquery(query_bundle)
        return await asyncio.to_thread(self._checked, response)
