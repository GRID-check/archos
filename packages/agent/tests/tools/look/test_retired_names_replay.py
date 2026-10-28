"""A turn whose transcript still carries a call to a retired look tool runs (ADR-0128, plan risk R1).

The previous turn's tool calls and results stay in the transcript for one turn
(``history.prune_tool_results``), so the first follow-up after the deploy that
retired ``view_knowledge_image`` and ``canvas__look`` sends the model a call to
a tool that is no longer bound. Through the COMPILED GRAPH: the old call and its
result reach the model as a pair (a call without its result is what a provider
refuses), nothing on this side re-runs, drops or rejects it, and the turn looks
with ``look`` and answers.

What this cannot show is whether every provider accepts a historical call to an
undeclared tool, so ``history.replay_retired_look_names`` does not ask: it shows
the model the old calls (and their results) as ``look``, arguments renamed, for
one release. The first test runs it through the compiled graph; the rest pin the mapping.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from agent.agents.piloti.agent import ChatAgent
from agent.agents.piloti.history import prune_tool_results
from agent.agents.piloti.history import replay_retired_look_names
from agent.agents.piloti.models import ResearchAgentState
from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry
from agent.common import LLMProvider
from agent.common import turn_status

RAN: list[str] = []

#: What each retired tool was called with in a stored turn.
RETIRED_CALLS = {
    "view_knowledge_image": {"file_name": "Grundriss_EG.pdf", "page_number": 2, "collection": "proj_1"},
    "canvas__look": {"page": 2, "region": [0.1, 0.1, 0.3, 0.2]},
}


@tool("look")
def look(document: str = "", page: int = 1) -> str:
    """Look at a page of a document."""
    RAN.append(f"look:{document}:{page}")
    return f"Seite {page}: Tür 1,00 m"


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    turn_status._retrieval_round.set(None)
    yield
    RAN.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
    """The answer pipeline is not what these tests are about."""
    with (
        patch.object(SourceRegistry, "all_sources", return_value=[SourceEntry(url="https://example.com")]),
        patch("agent.agents.piloti.answer_pipeline.verify_citations") as verify,
        patch("agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


def _previous_turn(retired: str) -> list:
    """A stored turn that looked with ``retired``: the question, the call, its image result, the answer."""
    return [
        HumanMessage(content="Wie breit ist die Tür im EG?"),
        AIMessage(content="", tool_calls=[{"name": retired, "args": RETIRED_CALLS[retired], "id": "old-1"}]),
        ToolMessage(
            content=[
                {"type": "text", "text": "Rendered page 2 of 'Grundriss_EG.pdf' (100x50px)."},
                {"type": "image_url", "image_url": {"url": "data:image/jpeg;base64,AAAA"}},
            ],
            tool_call_id="old-1",
            name=retired,
        ),
        AIMessage(content="Die Tür ist 1,00 m breit."),
    ]


class Scripted:
    def __init__(self, *replies: AIMessage) -> None:
        self.replies = list(replies)
        self.requests: list[list] = []

    async def respond(self, messages, *_args, **_kwargs):
        self.requests.append(list(messages))
        return self.replies[len(self.requests) - 1]


def _agent(model: Scripted) -> tuple[ChatAgent, MagicMock]:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=model.respond)
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return ChatAgent(llm_provider=provider, tools=[look], system_prompt="Du bist Piloti."), llm


@pytest.mark.parametrize("retired", sorted(RETIRED_CALLS))
async def test_a_follow_up_after_a_retired_look_looks_with_look_and_answers(retired: str) -> None:
    history = prune_tool_results([*_previous_turn(retired), HumanMessage(content="Und im OG?")])
    model = Scripted(
        AIMessage(content="", tool_calls=[{"name": "look", "args": {"document": "Grundriss_OG.pdf"}, "id": "l1"}]),
        AIMessage(content="Im OG ist die Tür ebenfalls 1,00 m breit."),
    )
    agent, llm = _agent(model)

    result = await agent.run(ResearchAgentState(messages=history))

    # The turn looked with the one tool there is, and answered.
    assert RAN == ["look:Grundriss_OG.pdf:1"]
    assert result.messages[-1].content == "Im OG ist die Tür ebenfalls 1,00 m breit."
    # Only `look` is bound; the retired name is never offered again.
    bound = [t.name for call in llm.bind_tools.call_args_list for t in call.args[0]]
    assert retired not in bound and "look" in bound
    # Every request carries the old call WITH its result, both under the name that is bound now:
    # a call without a result, or to an undeclared tool, is what a provider refuses.
    for request in model.requests:
        old = [c for m in request if isinstance(m, AIMessage) for c in m.tool_calls if c["id"] == "old-1"]
        results = [m for m in request if isinstance(m, ToolMessage) and m.tool_call_id == "old-1"]
        assert [c["name"] for c in old] == ["look"]
        assert [m.name for m in results] == ["look"]
        assert not any(c["name"] == retired for m in request if isinstance(m, AIMessage) for c in m.tool_calls)


@pytest.mark.parametrize("retired", sorted(RETIRED_CALLS))
def test_one_turn_later_the_retired_call_is_pruned_with_its_result(retired: str) -> None:
    """The transcript forgets the old name by itself after one more turn: nothing stored carries it for long."""
    later = [
        *_previous_turn(retired),
        HumanMessage(content="Und im OG?"),
        AIMessage(content="Auch 1,00 m."),
        HumanMessage(content="Danke. Und die Treppe?"),
    ]

    pruned = prune_tool_results(later)

    assert not any(isinstance(m, ToolMessage) for m in pruned)
    assert not any(isinstance(m, AIMessage) and m.tool_calls for m in pruned)


def test_the_retired_call_is_replayed_as_look_with_its_arguments_renamed() -> None:
    old = _previous_turn("view_knowledge_image")

    replayed = replay_retired_look_names(old)

    call = replayed[1].tool_calls[0]
    assert call["name"] == "look"
    # file_name -> document, page_number -> page; look takes no collection.
    assert call["args"] == {"document": "Grundriss_EG.pdf", "page": 2}
    assert replayed[2].name == "look" and replayed[2].tool_call_id == "old-1"
    # The stored transcript is not edited.
    assert old[1].tool_calls[0]["name"] == "view_knowledge_image"
    assert old[1].tool_calls[0]["args"]["file_name"] == "Grundriss_EG.pdf"


def test_the_canvas_call_keeps_its_arguments_and_provider_tool_use_blocks_follow() -> None:
    message = AIMessage(
        content=[{"type": "tool_use", "id": "old-1", "name": "canvas__look", "input": {"page": 2}}],
        tool_calls=[{"name": "canvas__look", "args": RETIRED_CALLS["canvas__look"], "id": "old-1"}],
    )

    replayed = replay_retired_look_names([message])[0]

    assert replayed.tool_calls[0]["name"] == "look"
    assert replayed.tool_calls[0]["args"] == RETIRED_CALLS["canvas__look"]
    assert replayed.content[0]["name"] == "look"


def test_other_tools_and_plain_messages_are_untouched() -> None:
    other = AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"page_number": 3}, "id": "w1"}])
    messages = [HumanMessage(content="hi"), other, AIMessage(content="ok")]

    assert replay_retired_look_names(messages) == messages
