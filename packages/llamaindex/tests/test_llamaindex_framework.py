import asyncio
import pytest
import httpx
from llama_index.core.base.base_query_engine import BaseQueryEngine
from llama_index.core.base.response.schema import Response, StreamingResponse, PydanticResponse
from llama_index.core.schema import NodeWithScore, TextNode
from pydantic import BaseModel
from curbi_llamaindex import CurbiQueryEngine, CurbiBlocked, CurbiUnavailable
from test_transport_llamaindex import wire, POLICY, PASS


class ExistingEngine(BaseQueryEngine):
    def __init__(self, response):
        super().__init__(callback_manager=None)
        self.result = response
        self.queries = []

    def _get_prompt_modules(self):
        return {}

    def _query(self, query_bundle):
        self.queries.append(query_bundle.query_str)
        return self.result

    async def _aquery(self, query_bundle):
        return self._query(query_bundle)


def response(text="Pro is $49."):
    return Response(response=text, source_nodes=[NodeWithScore(node=TextNode(text="Source evidence"), score=0.9)], metadata={"source": "kept"})


def test_real_query_engine_preserves_response_sources_and_metadata(wire):
    original = response()
    inner = ExistingEngine(original)
    engine = CurbiQueryEngine(inner, POLICY)
    assert isinstance(engine, BaseQueryEngine)
    assert engine.query("price?") is original
    assert original.source_nodes[0].node.text == "Source evidence"
    assert original.metadata == {"source": "kept"}
    assert inner.queries == ["price?"]
    assert "Source evidence" not in wire[1][0].content.decode()


def test_real_async_query_preserves_original_response(wire):
    original = response()
    engine = CurbiQueryEngine(ExistingEngine(original), POLICY)
    assert asyncio.run(engine.aquery("price?")) is original


def test_real_query_engine_blocks_configured_wrong_price(wire):
    state, _ = wire
    state["response"] = lambda req: httpx.Response(200, json={**PASS, "pass": False, "findings": [{"rule": "price:mismatch", "span": [7, 10], "text": "$99", "why": "Wrong price"}]})
    engine = CurbiQueryEngine(ExistingEngine(response("Pro is $99.")), POLICY)
    with pytest.raises(CurbiBlocked):
        engine.query("price?")
    with pytest.raises(CurbiBlocked):
        asyncio.run(engine.aquery("price?"))


class Answer(BaseModel):
    text: str


@pytest.mark.parametrize("result", [PydanticResponse(response=Answer(text="unchecked structured text")), StreamingResponse(response_gen=iter(["hello"]))])
def test_unsupported_result_types_never_silently_bypass(wire, result):
    with pytest.raises(CurbiUnavailable):
        CurbiQueryEngine(ExistingEngine(result), POLICY).query("price?")
    assert not wire[1]


def test_requires_real_query_engine():
    with pytest.raises(ValueError):
        CurbiQueryEngine(object(), POLICY)


def test_response_changed_during_check_is_never_returned(wire):
    state, calls = wire
    original = response("Pro is $49.")
    def mutate(req):
        original.response = "Unchecked replacement is $99."
        return httpx.Response(200, json=PASS)
    state["response"] = mutate
    engine = CurbiQueryEngine(ExistingEngine(original), POLICY)
    with pytest.raises(CurbiUnavailable, match="reply_changed"):
        engine.query("price?")
    assert b"Pro is $49." in calls[0].content
