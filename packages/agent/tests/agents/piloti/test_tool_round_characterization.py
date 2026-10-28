"""Characterization: what Piloti's tool loop does today, pinned before the loop moves onto LangChain.

Not a specification. Each test records the CURRENT behaviour of one seam the
move has to preserve or change on purpose, through the compiled graph:

* whether Piloti's inner graph writes checkpoints into the conversation
  graph's checkpointer (namespace ``shallow_research:*``);
* the exact transcript of ONE round that mixes every way a call is answered:
  ran, cross-round repeat, same-batch repeat of a failed fetch, refused
  (switched-off source), width-capped, and held for a steering note;
* one ``admit`` call for a round with two restricted results;
* the text the model reads for a schema-invalid call and for a tool that raises.

Each guard alone is pinned elsewhere (``test_repeat_fetch_guard.py``,
``test_disabled_sources.py``, ``test_budget_by_rounds.py``,
``test_steering_turn.py``, ``test_restricted_tool_round.py``,
``common/test_tool_errors.py``); what is pinned here is their composition and
order in one transcript. A diff here after a refactor is a decision, not noise.
"""

from __future__ import annotations

from typing import Any
from unittest.mock import AsyncMock
from unittest.mock import MagicMock
from unittest.mock import patch

import pytest
from agent_testing.conversation import turn
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool
from langgraph.checkpoint.memory import InMemorySaver

from agent.agents.deep_researcher.models import DeepResearchAgentState
from agent.agents.piloti.agent import _FAILED_FETCH_REPEAT_MESSAGE
from agent.agents.piloti.agent import _REPEAT_FETCH_PREFIX
from agent.agents.piloti.agent import _WIDTH_CAP_MESSAGE
from agent.agents.piloti.agent import ChatAgent
from agent.agents.piloti.agent import TurnConfig
from agent.agents.piloti.conversation import ConversationGraph
from agent.agents.piloti.models import ConversationState
from agent.agents.piloti.models import ResearchAgentState
from agent.citations.entries import SourceEntry
from agent.citations.registry import SourceRegistry
from agent.common import LLMProvider
from agent.common import turn_status
from agent.common.data_source_registry import populate_from_config
from agent.common.data_source_registry import reset_registry
from agent.common.data_sources import disabled_source_notice
from agent.common.steering import HELD_FOR_STEER
from agent.common.steering import SteerInbox
from agent.common.steering import SteerNote
from agent.common.steering import bind_steer_inbox
from agent.common.steering import unbind_steer_inbox
from agent.common.tool_calls import FETCH_FAILED_MARKER
from agent.knowledge import restricted_use as ru
from agent.knowledge.restricted_use import WITHHELD_NOTICE
from agent.knowledge.restricted_use import RestrictedUse
from agent.knowledge.restricted_use import bind_restricted_use
from agent.knowledge.restricted_use import reset_restricted_use

_PROMPT = "Du bist Piloti."
_ANSWER = AIMessage(content='```answer_json\n{"answer": "Fertig.", "kind": "walkthrough"}\n```')

RAN: list[str] = []
FAILING_QUERIES: set[str] = set()


@tool
def knowledge_search(query: str) -> str:
    """Search the office's documents."""
    if query in FAILING_QUERIES:
        FAILING_QUERIES.discard(query)
        RAN.append(f"knowledge_search:{query}:failed")
        return f"{FETCH_FAILED_MARKER} Knowledge search failed for query={query!r}."
    RAN.append(f"knowledge_search:{query}")
    return f"Treffer zu: {query}"


@tool
def read_passage(document: str, clause: str | None = None) -> str:
    """Open a named passage of a known document."""
    RAN.append(f"read_passage:{document}|{clause or ''}")
    return f"Passage aus {document} {clause or ''}".strip()


@tool
def web_search_tool(query: str) -> str:
    """Search the web."""
    RAN.append(f"web_search_tool:{query}")
    return f"Web-Treffer zu: {query}"


@tool("canvas__mark")
def mark(target: str) -> str:
    """Propose an Anmerkung on the document."""
    RAN.append(f"mark:{target}")
    return f"Vorgeschlagen: {target}"


@pytest.fixture(autouse=True)
def _clean_slate():
    RAN.clear()
    FAILING_QUERIES.clear()
    turn_status._retrieval_round.set(None)
    reset_registry()
    populate_from_config(
        [{"id": "web_search", "name": "Web-Suche", "description": "Search the web.", "tools": ["web_search_tool"]}]
    )
    yield
    reset_registry()
    RAN.clear()
    turn_status._retrieval_round.set(None)


@pytest.fixture(autouse=True)
def _bypass_citation_pipeline():
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


@pytest.fixture
def inbox():
    """One turn's steering inbox, bound in a SYNC fixture (gotchas: ContextVar tokens)."""
    box = SteerInbox()
    token = bind_steer_inbox(box)
    yield box
    unbind_steer_inbox(token)


def _call(name: str, call_id: str, **args: Any) -> dict:
    return {"name": name, "args": args, "id": call_id}


def _agent(replies: Any, tools: list[Any], **kwargs: Any) -> ChatAgent:
    llm = MagicMock()
    llm.bind_tools = MagicMock(return_value=llm)
    llm.bind = MagicMock(return_value=llm)
    llm.ainvoke = AsyncMock(side_effect=replies)
    provider = MagicMock(spec=LLMProvider)
    provider.get = MagicMock(return_value=llm)
    return ChatAgent(llm_provider=provider, tools=tools, system_prompt=_PROMPT, max_tool_iterations=7, **kwargs)


def _transcript(result: ResearchAgentState) -> list[tuple[str, str]]:
    return [(str(m.tool_call_id), str(m.content)) for m in result.messages if isinstance(m, ToolMessage)]


class TestInnerGraphCheckpoints:
    async def test_the_inner_graph_checkpoints_into_the_outer_saver(self):
        """Today: Piloti's graph is compiled WITHOUT a checkpointer, and still writes checkpoints.

        Recorded as found. ``agent.run`` invokes it inside the conversation
        graph's ``shallow_research`` node, LangGraph hands the subgraph the
        parent's checkpointer, and every super-step of the inner loop lands in
        the conversation's saver under ``shallow_research:<task id>``: six for a
        turn of one tool round, one thread namespace. A move that stops this changes what a stored
        conversation holds; one that keeps it keeps a cost per turn.
        """
        piloti = _agent(
            [AIMessage(content="", tool_calls=[_call("knowledge_search", "k1", query="Q")]), _ANSWER],
            [knowledge_search],
        )

        async def research(state: ResearchAgentState) -> ResearchAgentState:
            return await piloti.run(state)

        async def deep(state: DeepResearchAgentState) -> DeepResearchAgentState:  # pragma: no cover
            raise AssertionError("deep research must not run")

        saver = InMemorySaver()
        graph = ConversationGraph(research_fn=research, deep_research_fn=deep, clarifier_fn=None, checkpointer=saver)
        await turn(graph, ConversationState(messages=[HumanMessage(content="Was steht drin?")]), thread_id="t1")

        items = [i async for i in saver.alist(None)]
        print("NS", sorted(i.config["configurable"].get("checkpoint_ns", "").split(":")[0] for i in items))
        namespaces = [item.config["configurable"].get("checkpoint_ns", "") async for item in saver.alist(None)]
        assert RAN == ["knowledge_search:Q"]
        assert namespaces.count("") == 3
        inner = [ns for ns in namespaces if ns]
        assert len(inner) == 6
        assert all(ns.startswith("shallow_research:") for ns in inner)
        assert len(set(inner)) == 1


class TestOneMixedRound:
    async def test_every_way_a_call_is_answered_in_one_round(self, inbox, emitted):
        """Round 1 runs one search. Round 2 asks for seven calls; a note arrives while the model decides it.

        * ``k1`` the retry-able search that FAILS: runs;
        * ``k2`` the same search in the same batch: the failed-repeat notice;
        * ``r1`` round one's search again: its earlier result, labelled;
        * ``w1`` a switched-off source: refused;
        * ``m1`` a write chosen before the note: held for the steer;
        * ``p1`` a passage: runs (third of three under the cap);
        * ``p2`` a passage past the width cap of 3: the width notice.
        """
        FAILING_QUERIES.add("kaputt")
        replies = [
            AIMessage(content="", tool_calls=[_call("knowledge_search", "s0", query="Fluchtweg")]),
            AIMessage(
                content="",
                tool_calls=[
                    _call("knowledge_search", "k1", query="kaputt"),
                    _call("knowledge_search", "k2", query="kaputt"),
                    _call("knowledge_search", "r1", query="Fluchtweg"),
                    _call("web_search_tool", "w1", query="Fluchtweg"),
                    _call("canvas__mark", "m1", target="Tür"),
                    _call("read_passage", "p1", document="OIB-RL 4", clause="2.1"),
                    _call("read_passage", "p2", document="OIB-RL 4", clause="2.2"),
                ],
            ),
            _ANSWER,
        ]
        decisions: list[int] = []

        async def model(*_args: Any, **_kwargs: Any) -> AIMessage:
            decisions.append(len(decisions))
            if len(decisions) == 2:
                inbox.offer(SteerNote(steer_id="s1", text="nicht die Tür", author="Anna"))
            return replies[len(decisions) - 1]

        agent = _agent(model, [knowledge_search, read_passage, web_search_tool, mark], max_calls_per_round=3)

        result = await agent.run(
            ResearchAgentState(messages=[HumanMessage(content="Wie lang darf der Fluchtweg sein?")]),
            turn=TurnConfig(disabled_sources=frozenset({"web_search"})),
        )

        # Round two's survivors run in parallel, so their execution order is not part of the contract.
        assert RAN[0] == "knowledge_search:Fluchtweg"
        assert sorted(RAN[1:]) == ["knowledge_search:kaputt:failed", "read_passage:OIB-RL 4|2.1"]
        # What ran first, in the ToolNode's order; then the withheld calls, in
        # the order repeats, refused, over width, held for the steer.
        assert _transcript(result) == [
            ("s0", "Treffer zu: Fluchtweg"),
            ("k1", f"{FETCH_FAILED_MARKER} Knowledge search failed for query='kaputt'."),
            ("p1", "Passage aus OIB-RL 4 2.1"),
            ("k2", _FAILED_FETCH_REPEAT_MESSAGE),
            ("r1", f"{_REPEAT_FETCH_PREFIX}\n\nTreffer zu: Fluchtweg"),
            ("w1", disabled_source_notice("web_search_tool", frozenset({"web_search"}), {"query": "Fluchtweg"})),
            ("p2", _WIDTH_CAP_MESSAGE),
            ("m1", HELD_FOR_STEER),
        ]
        assert "Web-Suche is switched off" in dict(_transcript(result))["w1"]
        assert result.tool_iterations == 2
        # The records, as found: the steer hold is stamped with the round the
        # agent node already advanced to (2), the other three with the round
        # they were withheld in (1).
        assert emitted_steps(emitted) == [
            "status:retrieval:0",
            "status:checkpoint:0",
            "status:repeat:1",
            "status:refused:1",
            "status:width:1",
            "status:retrieval:1",
            "status:checkpoint:1",
            "status:steered:2",
            "status:synthesis",
            "status:citations",
        ]


def emitted_steps(emitted: Any) -> list[str]:
    return [step.id for step in emitted.steps]


class TestTwoRestrictedResultsOneAdmission:
    async def test_one_admit_call_names_both_collections(self, monkeypatch):
        first, second = "proj_p1_r0123456789ab", "proj_p1_rba9876543210"

        @tool("knowledge_search")
        def restricted_search(query: str) -> str:
            """Search the project's documents."""
            collection = first if query == "Honorar" else second
            return (
                "Found 1 relevant document(s):\n\n--- Result 1 ---\n"
                f"Source: {query}\nCitation: {query}.pdf, p.1\nCollection: {collection}\n\nInhalt zu {query}.\n"
            )

        asked: list[dict] = []

        def post(_use, body):
            asked.append(body)
            return {"admitted": [first], "refused": [second]}

        monkeypatch.setattr(ru, "_post", post)
        use = RestrictedUse(
            organization_id="org", user_id="u1", conversation_id="c1", project_id="p1", drawable={first, second}
        )
        agent = _agent(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        _call("knowledge_search", "a", query="Honorar"),
                        _call("knowledge_search", "b", query="Termine"),
                    ],
                ),
                _ANSWER,
            ],
            [restricted_search],
        )
        token = bind_restricted_use(use)
        try:
            result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Honorar und Termine?")]))
        finally:
            reset_restricted_use(token)

        assert asked == [{"admit": sorted([first, second])}]
        transcript = dict(_transcript(result))
        assert "Inhalt zu Honorar." in transcript["a"]
        assert transcript["b"] == WITHHELD_NOTICE


class TestWhatAFailedCallSays:
    async def test_a_schema_invalid_call_and_a_raising_tool(self):
        @tool
        def explode(query: str) -> str:
            """Always fails."""
            raise RuntimeError("store rejected the filter")

        agent = _agent(
            [
                AIMessage(
                    content="",
                    tool_calls=[
                        _call("read_passage", "bad", clause=3),
                        _call("explode", "boom", query="x"),
                    ],
                ),
                _ANSWER,
            ],
            [read_passage, explode],
        )

        result = await agent.run(ResearchAgentState(messages=[HumanMessage(content="Was steht in 2.1?")]))

        assert dict(_transcript(result)) == {
            "bad": (
                "Error: the call was rejected. document: Field required; clause: Input should be a valid "
                "string (got 3). Fix the arguments and call again."
            ),
            "boom": "Error: RuntimeError: store rejected the filter",
        }
