import asyncio
import pytest
import httpx
from langchain_core.runnables import Runnable
from langchain_core.language_models.fake_chat_models import FakeListChatModel
from langchain_core.output_parsers import StrOutputParser
from curbi_langchain import curbi_guard, CurbiBlocked, CurbiUnavailable
from test_transport_langchain import wire, POLICY, PASS


def test_real_lcel_model_parser_guard_batch(wire):
    guard = curbi_guard(POLICY)
    assert isinstance(guard, Runnable)
    chain = FakeListChatModel(responses=["Pro is $49."]) | StrOutputParser() | guard
    assert chain.invoke("price?") == "Pro is $49."
    assert chain.batch(["price?", "price?"]) == ["Pro is $49."] * 2


def test_real_lcel_async_and_abatch(wire):
    chain = FakeListChatModel(responses=["Pro is $49."]) | StrOutputParser() | curbi_guard(POLICY)
    assert asyncio.run(chain.ainvoke("price?")) == "Pro is $49."
    assert asyncio.run(chain.abatch(["one", "two"])) == ["Pro is $49."] * 2


def test_real_lcel_block_is_not_an_ai_message_or_unchecked_reply(wire):
    state, _ = wire
    state["response"] = lambda req: httpx.Response(200, json={**PASS, "pass": False, "findings": [{"rule": "price:mismatch", "span": [7, 10], "text": "$99", "why": "Wrong price"}]})
    chain = FakeListChatModel(responses=["Pro is $99."]) | StrOutputParser() | curbi_guard(POLICY)
    with pytest.raises(CurbiBlocked):
        chain.invoke("price?")
    with pytest.raises(CurbiBlocked):
        asyncio.run(chain.ainvoke("price?"))


def test_ai_message_without_parser_fails_closed(wire):
    with pytest.raises(CurbiUnavailable):
        (FakeListChatModel(responses=["Pro is $49."]) | curbi_guard(POLICY)).invoke("price?")
