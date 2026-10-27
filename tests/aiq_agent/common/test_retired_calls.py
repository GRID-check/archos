"""A retired spelling on Piloti's chat binding is answered with the exact replacement call (ADR-0133 slice 6)."""

from __future__ import annotations

from langchain_core.messages import AIMessage
from langchain_core.messages import ToolMessage

from aiq_agent.agents.piloti.agent import _notice
from aiq_agent.agents.piloti.agent import _split_round
from aiq_agent.agents.piloti.models import ResearchAgentState
from aiq_agent.common.retired_calls import RetiredNotice
from aiq_agent.common.retired_calls import known_paths
from aiq_agent.common.retired_calls import retired_call_notice

#: Piloti's chat binding, as far as the guard reads it.
PILOTI = frozenset({"knowledge_search", "list_files", "ls", "glob", "grep", "read_file", "look"})
#: Deep research's: the old names are what it has.
DEEP = frozenset({"knowledge_search", "read_passage", "list_files", "look"})


class TestTheNotice:
    def test_read_passage_names_read_file_with_the_path_a_hit_printed(self):
        paths = known_paths(["--- Result 1 ---\nPath: /law/oib/oib-rl_2_ausgabe_mai_2023.pdf.md\nCitation: x"])
        notice = retired_call_notice(
            "read_passage", {"document": "oib-rl_2_ausgabe_mai_2023.pdf", "clause": "3.5.2"}, PILOTI, paths
        )
        assert notice == (
            '`read_passage` is retired: call `read_file(file_path="/law/oib/oib-rl_2_ausgabe_mai_2023.pdf.md", '
            'clause="3.5.2")`.'
        )
        assert isinstance(notice, RetiredNotice)

    def test_read_passage_without_a_known_path_says_where_the_path_comes_from(self):
        notice = retired_call_notice("read_passage", {"document": "Gutachten.pdf", "pages": "3-4"}, PILOTI)
        assert notice is not None
        assert '`read_file(file_path="<its path>", pages="3-4")`' in notice
        assert "`Path:` line" in notice and '`glob(pattern="*Gutachten.pdf*")`' in notice

    def test_a_listing_names_ls_or_glob_and_a_revisions_call_runs(self):
        assert '`ls(path="/project/Brandschutz/")`' in retired_call_notice(
            "list_files", {"folder": "Brandschutz"}, PILOTI
        )
        assert '`glob(pattern="*EP-01*")`' in retired_call_notice("list_files", {"name_contains": "EP-01"}, PILOTI)
        assert '`ls(path="/office/")`' in retired_call_notice("list_files", {"shelf": "office_shelf"}, PILOTI)
        assert retired_call_notice("list_files", {}, PILOTI) is not None
        assert retired_call_notice("list_files", {"revisions_of": "EP-01.pdf"}, PILOTI) is None

    def test_a_literal_search_names_grep(self):
        notice = retired_call_notice("knowledge_search", {"query": "T30", "match": "exact", "stemmed": True}, PILOTI)
        assert (
            notice == '`knowledge_search` has no `match=` mode: call `grep(pattern="T30", mode="exact", stemmed=true)`.'
        )
        assert 'mode="regex"' in retired_call_notice("knowledge_search", {"query": r"\bT\d+", "match": "regex"}, PILOTI)
        assert retired_call_notice("knowledge_search", {"query": "Fluchtweg"}, PILOTI) is None

    def test_a_literal_search_keeps_its_scope_as_a_path(self):
        scoped = {"query": "T30", "match": "exact", "shelf": "office", "folder": "Brandschutz"}
        assert 'path="/office/Brandschutz/"' in retired_call_notice("knowledge_search", scoped, PILOTI)
        one = {"query": "T30", "match": "exact", "file_name": "Gutachten.pdf"}
        assert 'path="/project/Gutachten.pdf.md"' in retired_call_notice("knowledge_search", one, PILOTI)

    def test_deep_research_keeps_every_old_spelling(self):
        """The replacement is not bound there, so nothing is retired."""
        assert retired_call_notice("read_passage", {"document": "x.pdf"}, DEEP) is None
        assert retired_call_notice("list_files", {"folder": "A"}, DEEP) is None
        assert retired_call_notice("knowledge_search", {"query": "x", "match": "exact"}, DEEP) is None
        assert retired_call_notice("read_passage", {"document": "x.pdf"}, frozenset()) is None


class TestTheGuard:
    """Composed into the round's guards: answered without running, as an error, like a switched-off source."""

    def _state(self, *calls: dict) -> ResearchAgentState:
        return ResearchAgentState(messages=[AIMessage(content="", tool_calls=list(calls))])

    def test_a_retired_call_is_withheld_and_answered_as_an_error(self):
        state = self._state(
            {"name": "read_passage", "args": {"document": "a.pdf"}, "id": "1"},
            {"name": "grep", "args": {"pattern": "T30"}, "id": "2"},
        )
        split = _split_round(state, frozenset(), 0, PILOTI)
        assert [call["id"] for call in split.ran] == ["2"]
        [notice] = split.notices({})
        assert isinstance(notice, ToolMessage) and notice.status == "error" and notice.tool_call_id == "1"
        assert "`read_file(" in notice.content

    def test_the_path_comes_from_this_turn_s_results(self):
        state = ResearchAgentState(
            messages=[
                ToolMessage(content="Path: /project/Gutachten/a.pdf.md\n", tool_call_id="0", name="knowledge_search"),
                AIMessage(content="", tool_calls=[{"name": "read_passage", "args": {"document": "a.pdf"}, "id": "1"}]),
            ]
        )
        [notice] = _split_round(state, frozenset(), 0, PILOTI).notices({})
        assert '"/project/Gutachten/a.pdf.md"' in notice.content

    def test_without_the_binding_nothing_is_retired(self):
        state = self._state({"name": "read_passage", "args": {"document": "a.pdf"}, "id": "1"})
        assert [call["id"] for call in _split_round(state, frozenset(), 0).ran] == ["1"]

    def test_an_ordinary_notice_stays_a_success(self):
        assert _notice({"name": "x", "id": "1"}, "Not executed.").status == "success"
