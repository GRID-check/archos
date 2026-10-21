"""The workspace eval's harness, the part a CI machine can run (ADR-0122).

`scripts/turn_census/suite.py --set workspace` needs a model key to RUN. What is
testable offline: that the fixture door ranks a search exactly as the server
does (both the ranking `discovery.ts` runs today and `lib/text/operation-search.ts`,
held to the lists `workspace-eval.fixture.spec.ts` wrote from the TypeScript),
that a write comes back as the server's proposal and a read with the fixture's
record, that the agent's own client reads the door's answers, that the question
set names only operations and ids the fixture holds, and how the checks read a
turn. An eval that misreads a turn reports its own bugs as the agent's.
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import workspace_eval  # noqa: E402
from fixture_bff import FixtureBFF  # noqa: E402
from fixture_workspace import FIXTURES  # noqa: E402
from fixture_workspace import PROPOSED_TEXT  # noqa: E402
from fixture_workspace import FixtureWorkspace  # noqa: E402
from fixture_workspace import workspace_calls  # noqa: E402

CATALOG = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
OFFICE = json.loads((FIXTURES / "office.json").read_text(encoding="utf-8"))
TOKEN = "eval-token"


@pytest.mark.parametrize("ranking", ["production", "folded"])
def test_the_fixture_ranks_every_recorded_query_as_the_server_does(ranking: str) -> None:
    door = FixtureWorkspace(ranking=ranking)
    for query, expected in CATALOG["search"][ranking].items():
        got = [hit["name"] for hit in door.rank(query)[: CATALOG["limit"]]]
        assert got == expected, query


def test_german_requests_miss_on_the_server_today_and_hit_once_folded() -> None:
    """The measurement behind the fix: the recorded German queries, top hit against the intended operation."""
    production = CATALOG["search"]["production"]
    folded = CATALOG["search"]["folded"]
    german = [query for query in production if any(c.isupper() for c in query[:1])]
    assert len(german) >= 10
    assert sum(1 for query in german if production[query][:1] == folded[query][:1]) <= 2
    assert folded["Mitglied zu Projekt hinzufügen"][0] == "project-member-add"


def test_a_write_is_proposed_and_changes_nothing() -> None:
    door = FixtureWorkspace()
    answer = door.handle(
        {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {
                "name": "call-operation",
                "arguments": {
                    "name": "project-folder-create",
                    "input": {"params": {"id": OFFICE["current"]}, "body": {"name": "Brandschutz"}},
                },
            },
        },
        "conv-1",
    )
    result = answer["result"]
    assert result["content"][0]["text"] == PROPOSED_TEXT
    assert result["structuredContent"]["decision"] == "propose"
    assert result["structuredContent"]["operation"] == "project-folder-create"
    assert "Brandschutz" in result["structuredContent"]["summary"]


def test_a_write_missing_a_required_field_is_refused_with_the_schema_hint() -> None:
    door = FixtureWorkspace()
    result = door.call({"name": "project-folder-create", "input": {"params": {"id": OFFICE["current"]}}}, "c")
    assert result["isError"]
    assert "body" in result["content"][0]["text"]
    assert "describe-operation" in result["content"][0]["text"]


def test_a_read_answers_from_the_office_by_project() -> None:
    door = FixtureWorkspace()
    result = door.call({"name": "project-member-list", "input": {"params": {"id": OFFICE["current"]}}}, "c")
    names = [member["name"] for member in result["structuredContent"]["members"]]
    assert "Thomas Wagner" in names
    unknown = door.call({"name": "no-such-operation", "input": {}}, "c")
    assert unknown["isError"] and "search-operations" in unknown["content"][0]["text"]


def test_the_agents_own_client_reads_the_doors_answer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from aiq_agent.tools.documents.filing import SignedEnvelope
    from aiq_agent.tools.workspace.client import call_tool_result

    bff = FixtureBFF(TOKEN, tmp_path / "requests.jsonl", workspace=FixtureWorkspace()).start()
    try:
        monkeypatch.setenv("FRONTEND_INTERNAL_URL", bff.url)
        monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
        envelope = SignedEnvelope(header="e30", signature="sig")
        result = call_tool_result("search-operations", {"query": "list project members"}, envelope)
        assert "project-member-list" in result.text
        proposed = call_tool_result(
            "call-operation",
            {
                "name": "project-folder-create",
                "input": {"params": {"id": OFFICE["current"]}, "body": {"name": "Fotos"}},
            },
            envelope,
        )
        assert proposed.text == PROPOSED_TEXT
        assert proposed.structured and proposed.structured["decision"] == "propose"
    finally:
        bff.stop()
    calls = workspace_calls(tmp_path / "requests.jsonl", None)
    assert [call["tool"] for call in calls] == ["search-operations", "call-operation"]


def test_turn_context_carries_the_rendered_workspace_block() -> None:
    data = FixtureWorkspace().turn_context("conv-9")["data"]
    assert data["projectContext"] is None
    if "workspace" in data:
        assert "conv-9" in data["workspace"]


def test_every_question_names_operations_and_ids_the_fixture_holds() -> None:
    names = {op["name"] for op in CATALOG["operations"]}
    office_text = json.dumps(OFFICE, ensure_ascii=False)
    for question in workspace_eval.load_questions():
        expect = question.get("expect") or {}
        for name in [*(expect.get("reads") or []), *(expect.get("no_repeat") or [])]:
            assert name in names, (question["id"], name)
        for item in expect.get("proposes") or []:
            assert item["operation"] in names, (question["id"], item["operation"])
            for value in (item.get("input") or {}).values():
                if isinstance(value, str) and "-" in value and len(value) == 36:
                    assert value in office_text, (question["id"], value)
        assert set(expect.get("judge") or []) <= set(workspace_eval.MEANING_CHECKS)


def _call(tool: str, arguments: dict, result: dict) -> dict:
    return {"tool": tool, "arguments": arguments, "result": result}


def test_the_checks_read_what_the_door_served() -> None:
    proposal = {"structuredContent": {"decision": "propose", "proposalId": "p", "operation": "project-member-add"}}
    calls = [
        _call("search-operations", {"query": "x"}, {"structuredContent": {"operations": []}}),
        _call("call-operation", {"name": "project-member-list", "input": {}}, {"structuredContent": {"members": []}}),
        _call(
            "call-operation",
            {
                "name": "project-member-add",
                "input": {
                    "params": {"id": "P"},
                    "body": {"organizationMembershipId": "om_a", "roleSlug": "project-editor"},
                },
            },
            proposal,
        ),
    ]
    expect = {
        "reads": ["project-member-list", "inbox-list"],
        "proposes": [
            {"operation": "project-member-add", "input": {"params.id": "p", "body.organizationMembershipId": "om_a"}},
            {"operation": "project-member-add", "input": {"body.organizationMembershipId": "om_b"}},
        ],
        "no_write": True,
        "no_repeat": ["project-member-list"],
        "judge": ["pending"],
    }
    signals: list[str] = []
    checks = workspace_eval.workspace_checks(expect, calls, [], "Vorgeschlagen.", "q", lambda *_: True, signals)
    assert checks == {
        "reads:project-member-list": True,
        "reads:inbox-list": False,
        "proposes:project-member-add": True,
        "proposes:project-member-add#2": False,
        "no_write": False,
        "no_repeat:project-member-list": False,
        "judge:pending": True,
    }
    metrics = workspace_eval.door_metrics(calls)
    assert metrics["searches"] == 1 and metrics["search_misses"] == 1 and metrics["proposals"] == 1


def test_a_judge_that_cannot_answer_fails_the_check_and_says_so() -> None:
    signals: list[str] = []
    checks = workspace_eval.workspace_checks({"judge": ["asks"]}, [], [], "Welche Anna?", "q", None, signals)
    assert checks == {"judge:asks": False}
    assert signals == ["judge_unavailable:asks"]


def test_no_workspace_counts_a_bound_tool_call_the_door_never_saw() -> None:
    checks = workspace_eval.workspace_checks({"no_workspace": True}, [], ["workspace__search"], "a", "q", None, [])
    assert checks == {"no_workspace": False}


def test_the_fixture_bff_drops_the_mcp_door_without_the_token(tmp_path: Path) -> None:
    bff = FixtureBFF(TOKEN, tmp_path / "requests.jsonl", workspace=FixtureWorkspace()).start()
    try:
        request = urllib.request.Request(
            f"{bff.url}/api/mcp",
            data=b"{}",
            headers={"Content-Type": "application/json", "X-Grid-Internal-Token": "wrong"},
            method="POST",
        )
        with pytest.raises(Exception):  # noqa: B017 - a dropped connection, whatever urllib calls it
            urllib.request.urlopen(request, timeout=5)
    finally:
        bff.stop()


def test_a_follow_up_turn_sees_the_proposal_the_conversation_filed() -> None:
    door = FixtureWorkspace()
    before = door.turn_context("conv-f")["data"].get("workspace") or ""
    assert "proposals made in this conversation: none" in before
    door.call(
        {"name": "project-folder-create", "input": {"params": {"id": OFFICE["current"]}, "body": {"name": "Fotos"}}},
        "conv-f",
    )
    after = door.turn_context("conv-f")["data"]["workspace"]
    assert "waiting for the person · operation: Create" in after
    assert "Fotos" in after
    assert "proposals made in this conversation: none" in door.turn_context("conv-other")["data"]["workspace"]
