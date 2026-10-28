"""The turn context is its own message; the system prompt is the same bytes on every turn.

A request is ``[system, *earlier turns, turn context, newest question, *this
turn]``. Everything a turn varies (the date, the asker, the inventory, the
workspace, the project) is in the turn context, so the system prompt and the
whole history in front of the newest question are a prefix the next round and
the next turn share byte for byte. Appended to the system prompt, the per-turn
half made every turn's first message unique: the provider's prefix cache ended
inside the system message and never reached the history, and a model that keeps
its reasoning across turns saw its instructions change under it.

What fails here: a per-turn value leaking into the system prompt, the context
landing anywhere but right before the newest question, or the context entering
the stored transcript.

And the answer-language line (live on dev 2026-10-28, project Holzbau Wien,
conversation ``s_db26a123…``): „What is this project about?" was answered
entirely in German although the static prompt says to write in the language of
the newest message (#1336). The turn context is mostly German and is the
human-role message right before the question, so it outweighed the rule. What
fails: the line missing on an English question, present on a German or
ambiguous one, anywhere but after ``</turn_context>``, or not in the trace.
"""

from __future__ import annotations

from datetime import datetime
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import SystemMessage
from langchain_core.messages import ToolMessage
from langchain_core.tools import tool

from agent.agents.piloti import prompt as prompt_module
from agent.agents.piloti.agent import ChatAgent
from agent.agents.piloti.models import ResearchAgentState
from agent.agents.piloti.prompt import TurnPrompt
from agent.agents.piloti.prompt import render_turn_prompt
from agent.agents.piloti.prompt import request_messages
from agent.agents.piloti.prompt import system_prompt_template
from agent.common import LLMProvider
from agent.common.prompt_store import PromptStore
from agent.common.steering import AppliedSteer
from agent.observability.langfuse_trace_attributes import begin_trace_contributions
from agent.observability.langfuse_trace_attributes import end_trace_contributions
from agent.observability.langfuse_trace_attributes import snapshot_contributions

TOOLS = [{"name": "knowledge_search"}, {"name": "workspace__search"}, {"name": "project_lookup"}]
PROMPT = TurnPrompt(system="SYSTEM", context="<turn_context>\nCTX\n</turn_context>")


@pytest.fixture(autouse=True)
def _bundled_prompt(monkeypatch):
    monkeypatch.setattr(prompt_module, "prompt_store", lambda: PromptStore(enabled=False))


class _Day(datetime):
    """A clock pinned to one day, so two renders can straddle midnight."""

    day = 1

    @classmethod
    def now(cls, tz=None):
        return datetime(2026, 10, cls.day, 9, 30)


def _states() -> tuple[ResearchAgentState, ResearchAgentState]:
    first = ResearchAgentState(messages=[HumanMessage(content="Wie hoch darf ich bauen?")])
    second = ResearchAgentState(
        messages=[HumanMessage(content="Und im Dachgeschoß?")],
        user_info={"name": "Anna Weber", "email": "anna@example.at", "office": "Atelier Nord"},
        project_context="name: Wohnbau\nPROJECT_MEMORY v1\n- [fact | high | unverified] GK 4",
        available_documents=[{"file_name": "Grundriss_EG.pdf", "shelf": "project"}],
        workspace_block="project: p-1",
        org_instructions="Kurz antworten.",
        reference_projects="- Wohnbau Graz (id p1): 2019",
        focus_file_name="Grundriss_EG.pdf",
        confined=True,
        deep_research_allowed=False,
    )
    return first, second


class TestTheSystemPromptIsTheStaticHalf:
    def test_it_is_byte_identical_whatever_the_turn_carries(self, monkeypatch):
        first_state, second_state = _states()
        monkeypatch.setattr(prompt_module, "datetime", _Day)
        _Day.day = 1
        first = render_turn_prompt(system_prompt_template(), first_state, TOOLS)
        _Day.day = 2
        second = render_turn_prompt(system_prompt_template(), second_state, TOOLS)

        assert first.system == second.system
        assert first.context != second.context

    def test_every_per_turn_value_is_in_the_context_and_none_in_the_system_prompt(self, monkeypatch):
        _, state = _states()
        monkeypatch.setattr(prompt_module, "datetime", _Day)
        _Day.day = 2
        rendered = render_turn_prompt(system_prompt_template(), state, TOOLS)

        for value in ("2026-10-02", "Anna Weber", "Wohnbau", "Grundriss_EG.pdf", "p-1", "Kurz antworten."):
            assert value in rendered.context, value
            assert value not in rendered.system, value
        assert rendered.context.startswith("<turn_context>")
        assert "<restricted_conversation>" in rendered.context


class TestWhereTheContextGoes:
    def test_right_before_the_newest_question_after_every_earlier_turn(self):
        history = [
            HumanMessage(content="erste Frage"),
            AIMessage(content="erste Antwort"),
            HumanMessage(content="zweite Frage"),
            AIMessage(content="", tool_calls=[{"name": "knowledge_search", "args": {}, "id": "c1"}]),
            ToolMessage(content="Treffer", tool_call_id="c1"),
        ]

        request = request_messages(PROMPT, history)

        assert isinstance(request[0], SystemMessage) and request[0].content == "SYSTEM"
        assert request[1:3] == history[:2]
        assert isinstance(request[3], HumanMessage) and request[3].content == PROMPT.context
        assert request[4:] == history[2:]

    def test_the_prefix_before_the_newest_question_is_what_the_last_turn_sent(self):
        """Turn two's request starts with turn one's system prompt and question, byte for byte."""
        turn_one = [HumanMessage(content="erste Frage")]
        turn_two = [*turn_one, AIMessage(content="erste Antwort"), HumanMessage(content="zweite Frage")]

        one = request_messages(PROMPT, turn_one)
        two = request_messages(TurnPrompt(system="SYSTEM", context="<turn_context>\nANDERS\n</turn_context>"), turn_two)

        assert two[0] == one[0]
        assert two[1] == turn_one[0]

    def test_a_transcript_without_a_question_gets_it_after_the_system_prompt(self):
        request = request_messages(PROMPT, [AIMessage(content="geweckt")])

        assert [m.content for m in request] == ["SYSTEM", PROMPT.context, "geweckt"]

    def test_steering_notes_keep_their_place_after_the_context(self):
        history = [
            HumanMessage(content="Frage"),
            AIMessage(content="", tool_calls=[{"name": "look", "args": {}, "id": "c1"}]),
            ToolMessage(content="Bild", tool_call_id="c1"),
        ]
        note = AppliedSteer(steer_id="s1", content="Nur Seite 2, bitte.", at=len(history), round=1)

        request = request_messages(PROMPT, history, [note])

        assert [m.content for m in request] == [
            "SYSTEM",
            PROMPT.context,
            "Frage",
            "",
            "Bild",
            "Nur Seite 2, bitte.",
        ]


#: The shape of Holzbau Wien's turn context on dev: English keys, German values
#: and memory, German shelf names and summaries, German office instructions.
HOLZBAU_CONTEXT = "\n".join(
    [
        "confirmed:",
        "- project_name: Holzbau Wien",
        "- site_address: Lacknergasse 98",
        "- federal_state: vienna",
        "- bauherrschaft: privat",
        "- building_class: GK5",
        "PROJECT_MEMORY v1",
        "- [fact | high | unverified] Die Lacknergasse-Grundrisse zeigen ein Massivgebäude mit Turnsaal.",
        "documents:",
        "- projektstand: projektstand-holzbau-wien-2026-09-15.md",
    ]
)

LINE_START = "Answer in English"


def _holzbau_state(question: str) -> ResearchAgentState:
    return ResearchAgentState(
        messages=[
            HumanMessage(content="Welche Gebäudeklasse hat das Projekt?"),
            AIMessage(content="Gebäudeklasse 5."),
            HumanMessage(content=question),
        ],
        user_info={"name": "Matthias Bigl", "office": "Atelier Nord"},
        project_context=HOLZBAU_CONTEXT,
        available_documents=[
            {"file_name": "pd8280-2.pdf", "shelf": "project", "summary": "Der Lageplan im Maßstab 1:500."}
        ],
        org_instructions="Bitte immer in der Sie-Form antworten.",
    )


def _context_message(question: str) -> str:
    state = _holzbau_state(question)
    prompt = render_turn_prompt(system_prompt_template(), state, TOOLS)
    request = request_messages(prompt, state.messages)
    assert request[-1].content == question
    assert request[-2].content == prompt.context
    return str(request[-2].content)


class TestTheAnswerLanguageLine:
    def test_an_english_question_gets_it_after_the_whole_context(self):
        context = _context_message("What is this project about?")

        assert context.count(LINE_START) == 1
        assert context.index(LINE_START) > context.index("</turn_context>")
        # Nothing follows it: it is the last text before the question.
        assert context.rstrip().splitlines()[-1].startswith(LINE_START)

    def test_another_language_is_named_as_itself(self):
        context = _context_message("Qu'est-ce que ce projet et quelle est sa classe?")

        assert "Answer in French" in context
        assert LINE_START not in context

    @pytest.mark.parametrize(
        "question",
        ["Worum geht es in diesem Projekt?", "Wie hoch darf ich bauen", "?", "ok", "Matthias Bigl", "GK5", "ok danke"],
    )
    def test_a_german_or_ambiguous_question_gets_none(self, question):
        context = _context_message(question)

        assert "Answer in" not in context
        assert context.rstrip().endswith("</turn_context>")

    def test_the_system_prompt_is_the_same_bytes_either_way(self):
        english = render_turn_prompt(system_prompt_template(), _holzbau_state("What is this project about?"), TOOLS)
        german = render_turn_prompt(system_prompt_template(), _holzbau_state("Worum geht es?"), TOOLS)

        assert english.system == german.system
        assert LINE_START not in english.system


@tool
def knowledge_search(query: str) -> str:
    """Search the knowledge base."""
    return "Treffer"


class TestThroughTheAgent:
    @pytest.fixture
    def llm(self):
        model = MagicMock()
        model.ainvoke = AsyncMock(side_effect=[AIMessage(content="Antwort eins."), AIMessage(content="Antwort zwei.")])
        model.bind_tools = MagicMock(return_value=model)
        return model

    @pytest.fixture
    def agent(self, llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=llm)
        return ChatAgent(llm_provider=provider, tools=[knowledge_search])

    async def test_two_turns_send_the_same_system_prompt_and_store_no_context(self, agent, llm):
        first = await agent.run(
            ResearchAgentState(messages=[HumanMessage(content="Frage eins")], project_context="name: A")
        )
        second_history = [*first.messages, HumanMessage(content="Frage zwei")]
        second = await agent.run(
            ResearchAgentState(
                messages=second_history,
                project_context="name: B",
                user_info={"name": "Anna Weber"},
            )
        )

        sent_one = llm.ainvoke.call_args_list[0][0][0]
        sent_two = llm.ainvoke.call_args_list[1][0][0]
        assert sent_one[0].content == sent_two[0].content
        assert "name: A" in sent_one[-2].content and sent_one[-1].content == "Frage eins"
        assert "name: B" in sent_two[-2].content and sent_two[-1].content == "Frage zwei"
        # Turn one's context is not replayed into turn two.
        assert not any("name: A" in str(message.content) for message in sent_two)
        # Request-only: the stored transcript carries no turn context.
        for result in (first, second):
            assert not any("<turn_context>" in str(message.content) for message in result.messages)

    async def test_the_request_carries_the_line_and_the_trace_names_the_call(self, agent, llm):
        token = begin_trace_contributions()
        try:
            await agent.run(_holzbau_state("What is this project about?"))
            contributed = snapshot_contributions()
        finally:
            end_trace_contributions(token)

        sent = llm.ainvoke.call_args_list[0][0][0]
        assert sent[-1].content == "What is this project about?"
        assert str(sent[-2].content).rstrip().splitlines()[-1].startswith(LINE_START)
        assert contributed is not None
        metadata = contributed["metadata"]
        assert metadata["question_language"] == "en"
        assert metadata["answer_language_instructed"] is True
        assert metadata["question_language_confidence"] >= 0.9

    async def test_a_german_turn_is_recorded_as_not_instructed(self, agent, llm):
        token = begin_trace_contributions()
        try:
            await agent.run(_holzbau_state("Worum geht es in diesem Projekt?"))
            contributed = snapshot_contributions()
        finally:
            end_trace_contributions(token)

        sent = llm.ainvoke.call_args_list[0][0][0]
        assert "Answer in" not in str(sent[-2].content)
        assert contributed is not None
        assert contributed["metadata"]["question_language"] == "de"
        assert contributed["metadata"]["answer_language_instructed"] is False
