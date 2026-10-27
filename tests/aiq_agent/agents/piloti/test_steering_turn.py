"""A note typed while Piloti works reaches the next round, and holds back a write chosen before it.

Through the COMPILED GRAPH, because the two halves live in two nodes: the agent
node reads the inbox at the top of a decision, the tools node holds back the
writes of a round the model chose before a note arrived. A unit test of either
passes while the two disagree.

What is pinned, per ``common/steering.py``:

* the note is in the NEXT request, after the messages that existed when it
  arrived, and at that same index in every later request (the prompt cache's
  prefix stays byte-stable);
* it never enters ``state.messages``, so ``answer_pipeline.this_turn`` sees the
  turn it saw before;
* a write the model chose before the note is answered with the hold notice and
  not run, its reads run, and every call still gets exactly one result;
* the reader is told ``steer_applied`` with the round, and the round costs what
  it cost without the note.
"""

from __future__ import annotations

from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from aiq_agent.agents.piloti.agent import _SYNTHESIS_ANCHOR
from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.answer_pipeline import this_turn
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.registry import SourceRegistry
from aiq_agent.common import LLMProvider
from aiq_agent.common import turn_status
from aiq_agent.common.steering import HELD_FOR_STEER
from aiq_agent.common.steering import SteerInbox
from aiq_agent.common.steering import SteerNote
from aiq_agent.common.steering import bind_steer_inbox
from aiq_agent.common.steering import unbind_steer_inbox
from aiq_agent.common.wire_v2 import FocusRegion
from aiq_agent.common.wire_v2 import SteerAppliedBody

_PROMPT = "Du bist Piloti."
_QUESTION = "Markier die Tür im Erdgeschoss."
_NOTE = "nicht die Tür, die Treppe"

RAN: list[str] = []


@tool("look")
def look(page: int) -> str:
    """Look at a page of the document."""
    RAN.append(f"look:{page}")
    return f"Seite {page}: Tür links, Treppe rechts"


@tool("canvas__mark")
def mark(target: str) -> str:
    """Propose an Anmerkung on the document."""
    RAN.append(f"mark:{target}")
    return f"Vorgeschlagen: {target}"


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
        patch("aiq_agent.agents.piloti.answer_pipeline.verify_citations") as verify,
        patch("aiq_agent.agents.piloti.answer_pipeline.sanitize_report") as sanitize,
    ):
        verify.side_effect = lambda content, reg, reference_sources=None, **_: MagicMock(
            verified_report=content, removed_citations=[]
        )
        sanitize.side_effect = lambda content: MagicMock(sanitized_report=content)
        yield


@pytest.fixture
def inbox():
    """One turn's inbox, bound the way the socket binds it, in a SYNC fixture (gotchas: ContextVar tokens)."""
    box = SteerInbox()
    token = bind_steer_inbox(box)
    yield box
    unbind_steer_inbox(token)


def _call(name: str, call_id: str, **args) -> dict:
    return {"name": name, "args": args, "id": call_id}


class Scripted:
    """The model: one reply per decision, every request kept, and a hook that runs DURING a call."""

    def __init__(self, *replies: AIMessage, during: dict[int, object] | None = None) -> None:
        self.replies = list(replies)
        self.requests: list[list] = []
        self.during = during or {}

    async def respond(self, messages, *_args, **_kwargs):
        self.requests.append(list(messages))
        hook = self.during.get(len(self.requests))
        if callable(hook):
            hook()
        return self.replies[len(self.requests) - 1]


def _agent(model: Scripted, *, ceiling: int = 7) -> PilotiAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=model.respond)
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return PilotiAgent(llm_provider=provider, tools=[look, mark], system_prompt=_PROMPT, max_tool_iterations=ceiling)


async def _run(agent: PilotiAgent) -> ResearchAgentState:
    return await agent.run(ResearchAgentState(messages=[HumanMessage(content=_QUESTION)]))


def _note(steer_id: str = "s1", region: FocusRegion | None = None) -> SteerNote:
    return SteerNote(steer_id=steer_id, text=_NOTE, author="Anna Asker", focus_region=region)


def _notes_in(request: list) -> list[int]:
    return [
        index for index, message in enumerate(request) if isinstance(message, HumanMessage) and _NOTE in message.content
    ]


class TestTheNextRoundReadsTheNote:
    async def test_a_note_typed_during_round_one_is_in_round_two_and_holds_the_door_mark_back(self, inbox, emitted):
        """The whole story: the model chose to look AND mark the door; the person typed while it decided."""
        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=1), _call("canvas__mark", "m1", target="Tür")]),
            AIMessage(content="", tool_calls=[_call("canvas__mark", "m2", target="Treppe")]),
            AIMessage(content="Die Treppe ist markiert."),
            during={1: lambda: inbox.offer(_note())},
        )

        result = await _run(_agent(model))

        # The read ran, the write chosen before the note did not; the one after it did.
        assert RAN == ["look:1", "mark:Treppe"]
        held = [m for m in result.messages if isinstance(m, ToolMessage) and m.tool_call_id == "m1"]
        assert [m.content for m in held] == [HELD_FOR_STEER]
        # Every call of round one got exactly one result.
        round_one = [m for m in result.messages if isinstance(m, ToolMessage) and m.tool_call_id in {"l1", "m1"}]
        assert sorted(m.tool_call_id for m in round_one) == ["l1", "m1"]

        # Round two's request carries the note right after round one's results, and only round two onward.
        first, second, third = model.requests
        assert _notes_in(first) == []
        assert isinstance(second[0], SystemMessage)
        assert _notes_in(second) == [len(second) - 1]
        assert isinstance(second[-2], ToolMessage)
        # The same bytes at the same index in round three: the prefix stays cacheable.
        assert third[: len(second)] == second
        assert _notes_in(third) == _notes_in(second)
        assert 'author="Anna Asker"' in second[-1].content and "round 2" in second[-1].content

        # Never in the state: the turn boundary is the question, as before.
        assert not any(isinstance(m, HumanMessage) and _NOTE in str(m.content) for m in result.messages)
        assert [m.content for m in result.messages if isinstance(m, HumanMessage)] == [_QUESTION]
        assert len(this_turn(result.messages)) == len(result.messages) - 1
        assert [steer.steer_id for steer in result.steering] == ["s1"]

        # The reader is told which round read it, and the hold left its record.
        applied = [body.value for body in emitted if isinstance(body, SteerAppliedBody)]
        assert [(value.steer_id, value.round) for value in applied] == [("s1", 2)]
        record = emitted.step("status:steered:0")
        assert record.detail == {"round": 0, "withheld": 1}
        assert record.channel == turn_status.CHANNEL_TECHNICAL
        # The round cost what it costs without a note: two decisions that asked for tools.
        assert result.tool_iterations == 2
        assert inbox.applied and not inbox.has_pending()

    async def test_a_note_that_arrives_while_tools_run_is_read_next_and_holds_nothing(self, inbox):
        """The writes were chosen and run before the note; there is nothing to hold, only a next round."""

        @tool("look")
        def slow_look(page: int) -> str:
            """Look at a page of the document."""
            RAN.append(f"look:{page}")
            inbox.offer(_note())
            return "Seite 1"

        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=1)]),
            AIMessage(content="Die Treppe."),
        )
        llm = MagicMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.ainvoke = AsyncMock(side_effect=model.respond)
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        agent = PilotiAgent(llm_provider=provider, tools=[slow_look, mark], system_prompt=_PROMPT)

        await _run(agent)

        assert RAN == ["look:1"]
        assert _notes_in(model.requests[1]) == [len(model.requests[1]) - 1]

    async def test_two_notes_keep_the_order_they_were_typed_in(self, inbox):
        def both():
            inbox.offer(_note("s1"))
            inbox.offer(SteerNote(steer_id="s2", text="und das Podest"))

        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=1)]),
            AIMessage(content="Fertig."),
            during={1: both},
        )

        await _run(_agent(model))

        tail = [m.content for m in model.requests[1][-2:]]
        assert _NOTE in tail[0] and "und das Podest" in tail[1]

    async def test_a_box_drawn_while_piloti_works_travels_with_the_note(self, inbox):
        region = FocusRegion(page=3, x=0.41, y=0.22, w=0.17, h=0.18)
        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=3)]),
            AIMessage(content="Fertig."),
            during={1: lambda: inbox.offer(_note(region=region))},
        )

        await _run(_agent(model))

        assert "[Region: p. 3, x 0.41–0.58, y 0.22–0.40]" in model.requests[1][-1].content

    async def test_forced_synthesis_reads_the_note_and_keeps_the_anchor_last(self, inbox):
        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=1)]),
            AIMessage(content="Die Antwort."),
            during={1: lambda: inbox.offer(_note())},
        )

        result = await _run(_agent(model, ceiling=1))

        synthesis = model.requests[1]
        assert synthesis[-1].content == _SYNTHESIS_ANCHOR
        assert _notes_in(synthesis) == [len(synthesis) - 2]
        assert result.research_truncated is True


class TestWithoutAnInbox:
    async def test_a_turn_outside_a_socket_is_byte_identical(self):
        """An eval, ``nat run`` or a job binds no inbox: nothing is read, held or spliced."""
        model = Scripted(
            AIMessage(content="", tool_calls=[_call("look", "l1", page=1), _call("canvas__mark", "m1", target="Tür")]),
            AIMessage(content="Fertig."),
        )

        result = await _run(_agent(model))

        # One round runs its calls concurrently: what ran is the claim, not the order.
        assert sorted(RAN) == ["look:1", "mark:Tür"]
        # System prompt, turn context, the question: nothing human after them.
        assert all(not isinstance(m, HumanMessage) for m in model.requests[1][3:])
        assert result.steering == []

    async def test_a_note_the_final_call_never_read_is_left_for_the_next_question(self, inbox):
        """The model decided to finish while the person typed: the note stays unread, no steer_applied."""
        model = Scripted(AIMessage(content="Fertig."), during={1: lambda: inbox.offer(_note())})

        result = await _run(_agent(model))

        assert result.steering == []
        assert inbox.has_pending() and inbox.applied == []
