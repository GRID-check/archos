"""The record channel (ADR-0125): workspace calls read off this turn's transcript, never off the source registry."""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.messages import ToolMessage

from aiq_agent.common.answer_envelope import drop_unfiled_proposals
from aiq_agent.common.workspace_records import LISTING_MAX_CHARS
from aiq_agent.common.workspace_records import filed_proposal_ids
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
    assert record_from_result("member-add", {}, "Error: the workspace server refused the call (403)") is None
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
        *_call("4", "task-get", "Error: not found"),
    ]
    records = records_from_messages(messages)
    assert [(record.operation, record.outcome) for record in records] == [
        ("project-members-list", "read"),
        ("member-add", "proposed"),
    ]


def test_a_result_without_its_call_names_nothing_and_is_skipped():
    orphan = ToolMessage(content='{"a": "b"}', tool_call_id="nowhere", name="workspace__call")
    assert records_from_messages([orphan]) == []


def test_the_ids_this_turn_filed_are_read_off_the_text_the_tool_gave_the_model():
    from aiq_agent.tools.workspace.register import _show_proposal

    filed = "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c"
    structured = {"decision": "propose", "proposalId": filed.upper(), "operation": "folder-create", "summary": "Neu."}
    # The tool's own wording, so a change to it breaks here and not in production.
    text = _show_proposal(structured, {"input": {}}, "Proposed — the person decides. Nothing was changed.", {})
    messages = [
        HumanMessage("Leg an."),
        *_call("c1", "folder-create", text),
        # A read that mentions an id files nothing.
        *_call("c2", "inbox-list", '{"items": [{"text": "Proposal 0b0b0b0b-0000-4000-8000-000000000000"}]}'),
    ]
    assert filed_proposal_ids(messages) == frozenset({filed})


def test_unfiled_proposed_lines_are_dropped_and_counted():
    filed = "6f7a8b9c-0d1e-4f2a-9b3c-4d5e6f7a8b9c"
    payload = {
        "v": 1,
        "kind": "work",
        "work": {
            "done": [{"text": "gelesen"}],
            "proposed": [{"text": "a", "ref": filed}, {"text": "b", "ref": "other"}, {"text": "c"}],
        },
    }
    trimmed, dropped = drop_unfiled_proposals(payload, frozenset({filed}))
    assert dropped == 2
    assert trimmed["work"] == {"done": [{"text": "gelesen"}], "proposed": [{"text": "a", "ref": filed}]}
    only_unfiled = {"v": 1, "kind": "work", "work": {"proposed": [{"text": "b", "ref": "other"}]}}
    assert drop_unfiled_proposals(only_unfiled, frozenset()) == ({"v": 1, "kind": "work"}, 1)
    assert drop_unfiled_proposals(payload, frozenset({filed, "other"}))[1] == 1


def test_a_notice_the_agent_answered_the_call_with_is_no_record():
    from aiq_agent.common.steering import HELD_FOR_STEER
    from aiq_agent.tools.workspace.register import RATE_LIMITED

    for text in (HELD_FOR_STEER, RATE_LIMITED, "Error reaching the workspace: timeout. Nothing was changed."):
        assert record_from_result("task-get", {}, text) is None


def test_a_read_keeps_one_item_per_row_and_none_for_piloti_s_words():
    record = record_from_result(
        "comment-list",
        {},
        '{"total": 2, "items": [{"authoredBy": "user", "text": "Schnitt prüfen"},'
        '{"authoredBy": "agent", "text": "Die Brüstung ist zu niedrig"}]}',
    )
    assert "schnitt prüfen" in record.haystack and "brüstung" not in record.haystack
    assert any("schnitt prüfen" in item for item in record.items)
    assert any(item.split("\n") == ["2"] for item in record.items)


TREE = (
    "Top level  14 documents (2 here, 12 below), 2 subfolders\n"
    "  Dokumentart: Grundriss 5 · Schnitt 3\n"
    "Einreichung/  6 documents (all here; 2 older Fassungen)\n"
    "  Dokumentart: Grundriss 4\n"
    "  Current: Einreichplan EG Index B (2026-09-30)\n"
)


def _listing(result: str, tool: str = "knowledge__list_files") -> list:
    return [
        AIMessage(content="", tool_calls=[{"id": "l1", "name": tool, "args": {"view": "tree"}}]),
        ToolMessage(content=result, tool_call_id="l1", name=tool),
    ]


def test_a_listing_is_a_read_record_capped_and_one_item_per_line():
    (record,) = records_from_messages(_listing(TREE))
    assert (record.operation, record.outcome) == ("list_files", "read")
    assert len(record.items) == 5 and "einreichplan eg index b" in record.haystack
    (capped,) = records_from_messages(_listing("x " * 20_000))
    assert len(capped.haystack) <= LISTING_MAX_CHARS


def _estate(tool: str, args: dict, result: str, status: str = "success") -> list:
    return [
        AIMessage(content="", tool_calls=[{"id": "e1", "name": tool, "args": args}]),
        ToolMessage(content=result, tool_call_id="e1", name=tool, status=status),
    ]


def test_an_estate_ls_or_glob_is_a_listing_record_and_a_drafts_listing_is_not():
    """ADR-0133 slice 6: Piloti lists with `ls` and `glob`, read like `list_files` was."""
    (record,) = records_from_messages(_estate("ls", {"path": "/project/Einreichung/"}, TREE))
    assert (record.operation, record.outcome) == ("ls", "read")
    (found,) = records_from_messages(_estate("glob", {"pattern": "*Index*"}, "1 file matches"))
    assert found.operation == "glob"
    assert records_from_messages(_estate("ls", {"path": "/drafts/"}, "/drafts/a.md")) == []
    assert records_from_messages(_estate("ls", {"path": "/skills/"}, "/skills/x/")) == []
    assert records_from_messages(_estate("ls", {"path": "/project/X/"}, 'No folder "X".', status="error")) == []


def test_a_bare_name_counts_and_a_refusal_or_an_empty_listing_is_no_record():
    assert len(records_from_messages(_listing(TREE, tool="list_files"))) == 1
    assert records_from_messages(_listing("`view` must be files or tree.")) == []
    assert records_from_messages(_listing("  ")) == []
