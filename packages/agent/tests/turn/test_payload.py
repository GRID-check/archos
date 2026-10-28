"""What one user message states about how to answer it (`turn/payload.py`).

The chat socket hands the turn the v2 `user_message` with flat, typed fields;
`nat run` and a single-shot HTTP turn hand it the question as a plain string.
"""

import pytest

from agent.common.data_sources import unavailable_source_ids
from agent.common.focus_file import get_focused_file_name
from agent.common.focus_file import get_turn_shelves
from agent.common.focus_file import set_turn_intent
from agent.common.wire_v2 import UserMessage
from agent.turn import payload as payload_module
from agent.turn.payload import extract_turn_inputs


def _message(text: str = "fass zusammen", **fields) -> UserMessage:
    return UserMessage(conversation_id="c1", message_id="m1", text=text, **fields)


@pytest.fixture(autouse=True)
def _clear_intent():
    yield
    set_turn_intent()


class TestTheTurnsClientTools:
    """``user_message.client_tools`` (AG-UI's RunAgentInput.tools) sets what the turn may offer (ADR-0144)."""

    def test_a_declared_tool_is_the_turns_and_a_plain_question_declares_none(self):
        from agent.common.client_tools import client_tool_declared

        extract_turn_inputs(_message(client_tools=["show_in_viewer", "unknown_tool"]))
        assert client_tool_declared("show_in_viewer") and not client_tool_declared("unknown_tool")

        extract_turn_inputs("eine Frage")
        assert not client_tool_declared("show_in_viewer")

    def test_a_question_without_the_field_declares_none(self):
        from agent.common.client_tools import client_tool_declared

        extract_turn_inputs(_message(client_tools=["show_in_viewer"]))
        extract_turn_inputs(_message())
        assert not client_tool_declared("show_in_viewer")


class TestExtractTurnInputs:
    """The wire -> state lift.

    Retrieval reads the turn focus from ContextVars that this lift sets. Reading
    them was once a separate step in the register layer, ordered only by a
    comment, and nothing noticed when it was removed entirely.
    """

    def test_lifts_the_focus_from_the_message(self):
        inputs = extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf", focus_shelf="project"))

        assert inputs.query_text == "fass zusammen"
        assert inputs.focus_file_name == "Aufsicht.pdf"
        assert inputs.focus_shelf == "project"

    def test_a_plain_question_is_the_whole_question_and_states_nothing_else(self):
        """`nat run`: no JSON is read out of the text, and no data source is chosen."""
        inputs = extract_turn_inputs('  {"query": "x", "data_sources": ["web_search"]}  ')

        assert inputs.query_text == '{"query": "x", "data_sources": ["web_search"]}'
        assert inputs.data_sources is None
        assert inputs.focus_file_name is None

    def test_anything_else_is_refused(self):
        with pytest.raises(TypeError):
            extract_turn_inputs({"content": {"messages": [{"role": "user", "content": "x"}]}})

    def test_a_turn_without_a_subject_clears_the_previous_one(self):
        """The vars outlive one turn; a plain message must not inherit a subject."""
        extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf"))
        inputs = extract_turn_inputs(_message("welche OIB-Richtlinien gelten in Wien?"))

        assert inputs.focus_file_name is None
        assert inputs.focus_shelf is None
        extract_turn_inputs(_message(focus_file_name="Aufsicht.pdf"))
        assert extract_turn_inputs("und jetzt?").focus_file_name is None

    def test_the_selection_of_data_sources_comes_through_even_when_empty(self):
        assert extract_turn_inputs(_message(data_sources=["web_search"])).data_sources == ["web_search"]
        assert extract_turn_inputs(_message(data_sources=[])).data_sources == []
        assert "skills" not in extract_turn_inputs(_message())._fields

    def test_an_unstated_selection_switches_off_only_what_the_organization_did(self):
        """A headless sender (the MCP ask, a wake, the document check) states no
        selection. That is every source the organization allows, never none: the
        MCP ask once answered that its knowledge base was switched off."""
        inputs = extract_turn_inputs(_message())

        assert inputs.data_sources is None
        assert unavailable_source_ids(inputs.data_sources, disabled_sources=set()) == frozenset()

    def test_the_intent_is_set_for_retrieval_by_the_lift(self):
        extract_turn_inputs(_message(focus_file_name="Protokoll.pdf", focus_shelf="session"))
        assert get_focused_file_name() == "Protokoll.pdf"
        # `base` rides along with every subject shelf: a subject narrows which
        # documents the turn reads, not whether the law applies.
        assert get_turn_shelves() == frozenset({"session", "base"})

        extract_turn_inputs(_message(source_preset="law"))
        assert get_turn_shelves() == frozenset({"base"})

    def test_a_failure_to_set_the_focus_raises_instead_of_leaking_the_last_turn(self, monkeypatch):
        def broken(**_kw):
            raise RuntimeError("focus store gone")

        monkeypatch.setattr(payload_module, "set_turn_intent", broken)
        with pytest.raises(RuntimeError, match="focus store gone"):
            extract_turn_inputs(_message(focus_file_name="a.pdf"))


class TestTheSubjectVersion:
    """What the composer says about the subject's OPEN version, and only that."""

    def test_it_travels_beside_the_focus_file_name(self):
        inputs = extract_turn_inputs(
            _message(
                focus_file_name="Befund.md",
                focus_document_id="doc-9",
                focus_version_id="ver-9",
                focus_version_state="draft",
            )
        )

        assert (inputs.subject.document_id, inputs.subject.version_id, inputs.subject.state) == (
            "doc-9",
            "ver-9",
            "draft",
        )
        assert inputs.subject.is_open

    def test_an_ordinary_message_names_no_subject_version(self):
        assert not extract_turn_inputs(_message()).subject.is_open

    def test_an_incomplete_triple_is_not_open(self):
        assert not extract_turn_inputs(_message(focus_document_id="doc-9", focus_version_state="draft")).subject.is_open

    def test_a_plain_turn_does_not_inherit_the_previous_ones_subject(self):
        extract_turn_inputs(_message(focus_document_id="d", focus_version_id="v", focus_version_state="draft"))

        assert not extract_turn_inputs(_message("und jetzt?")).subject.is_open


class TestTurnReasoningEffort:
    """The composer's Aufwand dial reaches the turn through the same lift."""

    def test_the_stated_level_is_the_turns(self):
        from agent.common.reasoning_settings import get_turn_reasoning_effort

        extract_turn_inputs(_message(reasoning_effort="high"))

        assert get_turn_reasoning_effort() == "high"

    def test_a_turn_without_one_clears_the_previous_turns(self):
        from agent.common.reasoning_settings import get_turn_reasoning_effort

        extract_turn_inputs(_message(reasoning_effort="xhigh"))
        extract_turn_inputs(_message())
        assert get_turn_reasoning_effort() is None

        extract_turn_inputs(_message(reasoning_effort="low"))
        extract_turn_inputs("plain question")
        assert get_turn_reasoning_effort() is None

    def test_the_wire_refuses_a_level_the_dial_does_not_offer(self):
        from pydantic import ValidationError

        with pytest.raises(ValidationError):
            _message(reasoning_effort="none")
        with pytest.raises(ValidationError):
            _message(reasoning_effort="max")


class TestTheReviewCanvas:
    """The box a person drew, and the ask to answer in its thread."""

    def test_a_box_is_lifted_and_the_turn_is_a_canvas_turn(self):
        region = {"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2}
        inputs = extract_turn_inputs(_message(focus_region=region))

        assert inputs.focus_region is not None and inputs.focus_region.page == 2
        assert inputs.reply_in_thread is False
        assert inputs.surface == "review_canvas"

    def test_a_thread_reply_needs_the_mark_the_box_belongs_to(self):
        region = {"page": 2, "x": 0.1, "y": 0.2, "w": 0.3, "h": 0.2}
        without_mark = extract_turn_inputs(_message(focus_region=region, reply_in_thread=True))
        with_mark = extract_turn_inputs(_message(focus_region={**region, "annotation_id": "a-1"}, reply_in_thread=True))

        assert without_mark.reply_in_thread is False and without_mark.surface == "review_canvas"
        assert with_mark.reply_in_thread is True and with_mark.surface == "annotation_thread"

    def test_a_plain_question_is_a_chat_turn(self):
        assert extract_turn_inputs(_message()).surface == "chat"
        assert extract_turn_inputs("Wie hoch?").surface == "chat"

    def test_the_canvas_document_is_set_for_the_tools_and_cleared_next_turn(self):
        from agent.common.focus_file import get_focused_document_id

        extract_turn_inputs(_message(focus_document_id="11111111-0000-4000-8000-000000000001"))
        assert get_focused_document_id() == "11111111-0000-4000-8000-000000000001"

        extract_turn_inputs(_message())
        assert get_focused_document_id() is None
