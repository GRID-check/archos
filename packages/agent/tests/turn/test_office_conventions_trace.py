"""The office's conventions a turn was shown reach its trace (ADR-0129)."""

from __future__ import annotations

import pytest

from agent.common.platform_lessons import LessonsResolution
from agent.observability.langfuse_trace_attributes import reset_contributions
from agent.observability.langfuse_trace_attributes import snapshot_contributions
from agent.project_context import RequestContext
from agent.stages.flags import TurnFlags
from agent.turn import context as context_mod
from agent.turn.context import load_turn_context
from agent.turn.context_client import WORKSPACE_MAX_CHARS
from agent.turn.context_client import ContextBlocks
from agent.turn.context_client import _bounded_lines
from agent.turn.context_client import office_convention_lines

WORKSPACE = "\n".join(
    [
        "WORKSPACE v1 (the workspace as of this turn; the proposal list is the newest 8)",
        "project: Hubergasse · id p1 · active",
        "proposals made in this conversation (newest first):",
        "- a · waiting for the person · operation: Move a file",
        "office conventions (counted from 7 of the office's projects; usually, not always: …):",
        "- Gutachten usually filed under Fachplaner/Gutachten (4 of 5 projects that file one in a folder)",
        "- Index usually letters (A, B, C) (5 of 6 projects)",
    ]
)


class TestOfficeConventionLines:
    def test_counts_only_the_lines_under_the_header(self):
        assert office_convention_lines(WORKSPACE) == 2

    def test_a_block_without_conventions_has_none(self):
        assert office_convention_lines("WORKSPACE v1\n- a · applied · operation: x") == 0
        assert office_convention_lines(None) == 0

    def test_eight_long_proposals_and_the_conventions_fit_the_bound(self):
        heading = "h" * 120  # the five header lines: asker, project, conversation, inbox, runs
        proposal = "- " + "p" * 480  # an id, a status, a 200-char summary and a 200-char outcome
        convention = "- " + "c" * 218
        header = "office conventions (" + "h" * 200
        block = "\n".join(["WORKSPACE v1", *([heading] * 5), *([proposal] * 8), header, *([convention] * 6)])
        assert _bounded_lines(block, WORKSPACE_MAX_CHARS) == block


@pytest.fixture
def quiet_setup(monkeypatch):
    monkeypatch.setattr(context_mod, "resolve_platform_lessons", lambda _cid: LessonsResolution(digest=None, arm="off"))

    async def flags(**_kw):
        return TurnFlags(enabled_stages=frozenset(), deep_research_allowed=True, tasks_allowed=True)

    monkeypatch.setattr(context_mod, "resolve_turn_flags", flags)
    monkeypatch.setattr(context_mod, "get_user_message_id_from_context", lambda: "msg-1")


class TestTheTraceSaysWhatTheTurnWasShown:
    async def _load(self, monkeypatch, workspace):
        monkeypatch.setattr(
            context_mod,
            "fetch_turn_context",
            lambda *_a, **_kw: ContextBlocks(None, None, None, workspace=workspace),
        )
        reset_contributions()
        await load_turn_context(
            RequestContext(context_transport="bff", organization_id="org"),
            conversation_id="c1",
            query_text="Wo legen wir Gutachten ab?",
            resolve_stages=False,
        )
        metadata = (snapshot_contributions() or {}).get("metadata", {})
        reset_contributions()
        return metadata

    async def test_the_lines_shown_are_counted(self, quiet_setup, monkeypatch):
        metadata = await self._load(monkeypatch, WORKSPACE)
        assert metadata["office_conventions_lines"] == 2

    async def test_a_workspace_without_them_records_zero(self, quiet_setup, monkeypatch):
        metadata = await self._load(monkeypatch, "WORKSPACE v1\nproject: none")
        assert metadata["office_conventions_lines"] == 0

    async def test_no_workspace_records_nothing(self, quiet_setup, monkeypatch):
        metadata = await self._load(monkeypatch, None)
        assert "office_conventions_lines" not in metadata
