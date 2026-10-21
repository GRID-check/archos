"""The record channel (ADR-0124): workspace calls read off this turn's transcript, never off the source registry."""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from aiq_agent.common.workspace_records import is_workspace_call
from aiq_agent.common.workspace_records import record_from_result
from aiq_agent.common.workspace_records import records_from_messages


def _call(call_id: str, operation: str, result: str, *, tool: str = "workspace__call", **input_):
    return [
        AIMessage(content="", tool_calls=[{"id": call_id, "name": tool, "args": {"name": operation, "input": input_}}]),
        ToolMessage(content=result, tool_call_id=call_id, name=tool),
    ]


def test_the_qualified_name_is_matched_and_a_bare_call_is_not():
    assert is_workspace_call("workspace__call")
    assert is_workspace_call("piloti__workspace__call")
    assert is_workspace_call("workspace.call")
    assert not is_workspace_call("call")
    assert not is_workspace_call("canvas__update")
    assert not is_workspace_call("workspace__search")


def test_a_read_is_its_values_with_german_spellings_and_counts():
    record = record_from_result(
        "approvals-list",
        {},
        '{"items": [{"status": "approved", "due": "2026-11-03"}, {"status": "approved", "due": "2026-11-04"}]}',
    )
    assert record.outcome == "read"
    assert "freigegeben" in record.haystack and "3.11.2026" in record.haystack
    # Two rows: the list's length, and the repeated status.
    assert 2 in record.counts


def test_a_proposal_carries_what_was_proposed_and_a_refusal_is_no_record():
    proposal = record_from_result(
        "member-add",
        {"input": {"body": {"email": "lea@buero.at"}}},
        "Proposed — the person decides. Nothing was changed.",
    )
    assert proposal.outcome == "proposed" and "lea@buero.at" in proposal.haystack
    assert record_from_result("member-add", {}, "Fehler: the workspace server refused the call (403)") is None
    assert record_from_result("member-add", {}, "  ") is None


def test_a_capped_answer_that_is_not_json_is_matched_as_text():
    record = record_from_result("tasks-list", {}, '{"items": [{"title": "Statik prüfen"}\n[gekürzt: Antwort zu lang.]')
    assert record is not None and "statik prüfen" in record.haystack


def test_records_come_from_this_turns_calls_in_order_and_other_tools_are_ignored():
    messages = [
        HumanMessage("Wer ist im Projekt?"),
        *_call("1", "project-members-list", '{"members": [{"name": "Anna Berger"}]}'),
        *_call("2", "search-operations", "project-members-list: …", tool="workspace__search"),
        *_call("3", "member-add", "Proposed — the person decides. Nothing was changed.", body={"email": "x@y.at"}),
        *_call("4", "task-get", "Fehler: not found"),
    ]
    records = records_from_messages(messages)
    assert [(record.operation, record.outcome) for record in records] == [
        ("project-members-list", "read"),
        ("member-add", "proposed"),
    ]


def test_a_result_without_its_call_names_nothing_and_is_skipped():
    orphan = ToolMessage(content='{"a": "b"}', tool_call_id="nowhere", name="workspace__call")
    assert records_from_messages([orphan]) == []
