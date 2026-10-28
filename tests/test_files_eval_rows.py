"""The office-file eval's rows, fixture, arms and checks: everything between a recorded turn and its report (ADR-0127).

Offline: the live run needs a model key, a Qdrant and the seeded project. What is pinned here is what
would make a live run measure the wrong thing: a row with no expectation, a row naming a file the
fixture does not hold, an arm that does not change what it says it changes, a check that reads a
recorded call wrongly.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import files_eval  # noqa: E402
import fixture_files  # noqa: E402
import judge  # noqa: E402
import suite  # noqa: E402

ROWS = files_eval.load_questions()
PROJECT = fixture_files.load_project()


class TestTheRows:
    def test_there_are_about_thirty_and_every_id_is_pf(self):
        assert 24 <= len(ROWS) <= 36
        assert all(str(row["id"]).startswith("pf-") for row in ROWS)
        assert len({row["id"] for row in ROWS}) == len(ROWS)

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_expects_something_and_only_known_things(self, row):
        expect = row.get("expect") or {}
        assert expect.get("tools") or expect.get("judge"), "a row without expect.tools or a judge measures nothing"
        assert set(expect) <= files_eval.CHECK_KEYS
        assert set(expect.get("tools") or {}) <= files_eval.TOOL_KEYS
        assert set(row.get("needs") or []) <= set(files_eval.NEEDS)
        assert all(kind in judge.RUBRICS for kind in expect.get("judge") or [])

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_names_only_files_the_fixture_holds(self, row):
        asked = " ".join(str(v) for v in [row["question"], row.get("expect"), row.get("open") or ""])
        named = {word.strip("`'\",.?:;()[]{}") for word in asked.replace("(", " ").split() if word.endswith(".pdf")}
        assert named <= set(PROJECT.names)

    def test_every_expected_file_mention_is_a_real_name(self):
        mentioned = {m for row in ROWS for m in (row["expect"].get("mentions") or []) if str(m).endswith(".pdf")}
        assert mentioned <= set(PROJECT.names)


class TestTheFixture:
    def test_the_extension_refiles_the_plans_and_adds_the_report_and_the_letter(self):
        folders = {file.name: file.folder for file in PROJECT.files}
        assert folders["EP-01_Grundrisse_Index-B.pdf"] == "Einreichung/Pläne"
        assert folders["Brandschutzkonzept_Hubergasse14.pdf"] == "Gutachten/Brandschutz"
        assert folders["Schreiben_MA37_Baubeginn.pdf"] == "Korrespondenz/Behörde"
        assert folders["Baubeschreibung_Hubergasse14.pdf"] == "Einreichung"
        assert {f.folder.split("/")[0] for f in PROJECT.files} == {
            "Einreichung", "Bestand", "Behörde", "Nachbarn", "Gutachten", "Korrespondenz",
        }  # fmt: skip

    def test_the_planted_facts_are_where_the_questions_expect_them(self):
        report = next(f for f in PROJECT.files if f.name.startswith("Brandschutzkonzept"))
        assert len(report.pages) == 14
        assert [n for n, page in enumerate(report.pages, 1) if "fluchtweg" in page.casefold()] == [3, 7, 11]
        assert "fluchtweg" not in report.pages[8].casefold() and "Aufzug" in report.pages[8]
        everything = "\n".join(page for f in PROJECT.files for page in f.pages)
        assert "Sprinkler" not in everything
        assert {"567812", "123456", "654321"} <= {z for z in ("567812", "123456", "654321") if z in everything}
        assert sum("Fluchtweg" in page for f in PROJECT.files for page in f.pages) == 3
        assert len([f for f in PROJECT.files if f.folder.startswith("Einreichung")]) == 6

    def test_the_newest_upload_is_the_letter(self):
        newest = max(PROJECT.files, key=lambda f: f.added_at or "")
        assert newest.name == "Schreiben_MA37_Baubeginn.pdf"

    def test_the_base_project_is_left_untouched(self):
        from scripts.intake_eval.fixture import load_fixture

        assert {f.folder for f in load_fixture().files} >= {"Einreichung"}
        assert "Einreichung/Pläne" not in {f.folder for f in load_fixture().files}

    def test_the_report_is_cut_by_the_section_chunker_with_what_the_reading_tools_order_by(self):
        file = next(f for f in PROJECT.files if f.name.startswith("Brandschutzkonzept"))
        specs = fixture_files.chunk_specs(PROJECT, file)
        assert {s["metadata"]["chunking"] for s in specs} == {"section"}
        covered = {
            page for s in specs for page in range(int(s["metadata"]["page_label"]), int(s["metadata"]["page_end"]) + 1)
        }
        assert covered == set(range(1, 15)), "every page is held by a chunk's page range"
        assert [s["ordinal"] for s in specs] == list(range(len(specs)))
        assert len({s["chunk_id"] for s in specs}) == len(specs)
        assert specs == fixture_files.chunk_specs(PROJECT, file), (
            "ids are stable: re-seeding overwrites, never duplicates"
        )

    def test_chunks_hold_text_twice_as_production_stores_it(self):
        """The breadcrumb and the overlap, without which the count rows measure nothing (``pf-count-*``)."""
        report = next(f for f in PROJECT.files if f.name.startswith("Brandschutzkonzept"))
        breadcrumbs = [s["metadata"].get("clause_path") or "" for s in fixture_files.chunk_specs(PROJECT, report)]
        assert sum(path.startswith("3 Rettungswege und Aufzug") for path in breadcrumbs) == 4
        protocol = next(f for f in PROJECT.files if f.name.startswith("Besprechungsprotokoll"))
        parts = [s for s in fixture_files.chunk_specs(PROJECT, protocol) if s["metadata"].get("clause_id") == "3"]
        assert [s["metadata"]["section_part"] for s in parts] == [1, 2]
        assert all("Kopfbolzendübeln" in s["text"] for s in parts), "the planted word stands in the overlap"
        assert sum("Kopfbolzendübel" in page for page in protocol.pages) == 1
        assert sum("Verbunddecke" in page for page in protocol.pages) == 1

    def test_the_visual_set_keeps_one_chunk_per_page(self):
        import fixture_visual

        assert fixture_visual.load_project().chunking == "page"

    def test_the_envelope_scope_is_the_projects_own_collection(self):
        scope = fixture_files.FilesWorkspace(PROJECT).envelope_fields["collectionScope"]
        assert scope == [{"collection": "proj_files_eval", "shelf": "project"}]


class TestTheArms:
    TOOLS = ["web_search_tool", "knowledge_search", "read_passage", "list_files", "look"]

    #: The research agent's tools once ADR-0133's slices land: literal search is a tool of its own.
    COMING = ["web_search_tool", "knowledge_search", "ls", "glob", "grep", "read_file", "look"]

    def test_hybrid_changes_nothing(self):
        assert files_eval.arm_overrides("hybrid", self.TOOLS) == []
        assert files_eval.arm_overrides("hybrid", self.COMING) == []

    def test_semantic_unbinds_the_navigation_tools_and_keeps_ranked_search_only(self):
        pairs = dict(files_eval.arm_overrides("semantic", self.TOOLS))
        assert pairs["functions.shallow_research_agent.tools"] == "web_search_tool,knowledge_search,look"
        assert pairs["functions.knowledge_search.match_modes"] == "meaning"
        # The filesystem verbs over the estate are navigation too (ADR-0133); the override switches them off.
        assert pairs["functions.shallow_research_agent.filesystem"] == "null"
        from agent.agents.piloti.register import ResearchAgentConfig

        assert ResearchAgentConfig(llm="x", filesystem="null").filesystem is None
        assert ResearchAgentConfig(llm="x", filesystem="knowledge_search").filesystem == "knowledge_search"

    def test_semantic_unbinds_the_coming_filesystem_tools_too(self):
        pairs = dict(files_eval.arm_overrides("semantic", self.COMING))
        assert pairs["functions.shallow_research_agent.tools"] == "web_search_tool,knowledge_search,look"
        assert pairs["functions.knowledge_search.match_modes"] == "meaning"

    def test_grep_drops_the_prefetch_and_ranked_search(self):
        pairs = dict(files_eval.arm_overrides("grep", self.TOOLS))
        assert pairs == {
            "functions.shallow_research_agent.prefetch": "false",
            "functions.shallow_research_agent.tools": "web_search_tool,read_passage,list_files,look",
        }

    def test_grep_unbinds_ranked_search_once_grep_is_a_tool(self):
        pairs = dict(files_eval.arm_overrides("grep", self.COMING))
        assert pairs == {
            "functions.shallow_research_agent.tools": "web_search_tool,ls,glob,grep,read_file,look",
            "functions.shallow_research_agent.prefetch": "false",
        }

    def test_the_names_before_adr_0133_are_the_same_arms(self):
        for old, new in files_eval.LEGACY_ARMS.items():
            assert files_eval.arm_overrides(old, self.TOOLS) == files_eval.arm_overrides(new, self.TOOLS)
        assert files_eval.arm_name(None) == "hybrid"
        assert files_eval.arms_of("all") == ["semantic", "grep", "hybrid"]
        assert files_eval.arms_of("navigate") == ["grep"]

    def test_an_unknown_arm_is_refused(self):
        with pytest.raises(ValueError):
            files_eval.arm_overrides("lexical", self.TOOLS)

    def test_the_overrides_name_keys_the_config_and_its_schema_accept(self):
        from knowledge_layer.register import KnowledgeRetrievalConfig

        from agent.agents.piloti.register import ResearchAgentConfig

        for arm in ("semantic", "grep"):
            pairs = dict(files_eval.arm_overrides(arm, self.TOOLS))
            if "functions.knowledge_search.match_modes" in pairs:
                KnowledgeRetrievalConfig(match_modes=pairs["functions.knowledge_search.match_modes"])
            if "functions.shallow_research_agent.prefetch" in pairs:
                ResearchAgentConfig(llm="x", prefetch=pairs["functions.shallow_research_agent.prefetch"])
        tools = files_eval.configured_tools()
        assert {"knowledge_search", "list_files"} <= set(tools)
        # Piloti reads with `read_file` over the estate (ADR-0133 slice 6); the navigate arm unbinds the search.
        assert "read_passage" not in tools
        assert "knowledge_search" not in dict(files_eval.arm_overrides("navigate", tools))[
            "functions.shallow_research_agent.tools"
        ].split(",")

    def test_the_config_has_the_functions_the_overrides_path_through(self):
        import yaml

        loaded = yaml.safe_load((REPO_ROOT / "configs" / "config_oib_openrouter.yml").read_text(encoding="utf-8"))
        assert "knowledge_search" in loaded["functions"] and "shallow_research_agent" in loaded["functions"]


class TestWhatTheCommitCanDo:
    def test_a_row_waits_for_the_argument_it_needs(self):
        rows = [{"id": "a"}, {"id": "b", "needs": ["pages"]}, {"id": "c", "needs": ["pages", "regex"]}]
        run, waiting = files_eval.split_applicable(rows, {"pages"})
        assert [r["id"] for r in run] == ["a", "b"] and waiting == ["c"]

    def test_the_needs_are_read_off_the_exported_tool_schema(self):
        found = files_eval.available_needs()
        assert found <= set(files_eval.NEEDS)
        # Today's tools have none of the S3/S5/S6/S7 arguments; once a slice lands its row starts running.
        schema = REPO_ROOT / "apps" / "workspace" / "tests" / "fixtures" / "backend-tools.schema.json"
        assert schema.exists()


class TestTheChecks:
    CALLS = [
        {"name": "shallow__knowledge_search", "arguments": {"query": "Fluchtweg", "match": "Exact"}},
        {"name": "list_files", "arguments": {"folder": "Einreichung"}},
    ]

    def _checks(self, expect, calls=None, answer="", rounds=2, judge=None):
        return files_eval.files_checks(expect, calls or self.CALLS, answer, "q", judge, [], rounds)

    def test_a_call_matches_by_basename_and_argument_value_ignoring_case(self):
        assert files_eval.called({"knowledge_search": {"match": ["exact", "regex"]}}, self.CALLS)
        assert not files_eval.called({"knowledge_search": {"match": "regex"}}, self.CALLS)
        assert files_eval.called("list_files", self.CALLS)
        assert not files_eval.called("read_passage", self.CALLS)

    def test_must_any_and_must_not(self):
        checks = self._checks(
            {"tools": {"must": ["list_files"], "any": ["read_passage", "list_files"], "must_not": ["read_passage"]}}
        )
        assert all(checks.values()) and len(checks) == 3
        failing = self._checks({"tools": {"must": ["read_passage"], "must_not": ["list_files"]}})
        assert not any(failing.values())

    def test_rounds_and_a_count_of_markers(self):
        assert self._checks({"max_research_calls": 3}, rounds=3) == {"rounds<=3": True}
        assert self._checks({"max_research_calls": 2}, rounds=3) == {"rounds<=2": False}
        expect = {"at_least": {"n": 2, "of": ["Aufzug", "Löschwasser", "Brandschutzordnung"]}}
        assert self._checks(expect, answer="Der Aufzug ... und das Löschwasser")["at_least:2"]
        assert not self._checks(expect, answer="Nur der Aufzug")["at_least:2"]

    def test_a_follow_up_may_not_list_twice(self):
        twice = [*self.CALLS, {"name": "list_files", "arguments": {}}]
        assert self._checks({"no_repeat": ["list_files"]}, twice) == {"no_repeat:list_files": False}
        assert self._checks({"no_repeat": ["list_files"]}) == {"no_repeat:list_files": True}

    def test_a_judge_that_cannot_answer_fails_the_check_and_says_so(self):
        signals: list[str] = []
        checks = files_eval.files_checks(
            {"judge": ["none_found"]}, [], "Keine Fundstelle.", "q", lambda *_: None, signals, 1
        )
        assert checks == {"judge:none_found": False} and signals == ["judge_unavailable:none_found"]

    def test_calls_are_read_off_the_recorded_function_call_items(self):
        items = [
            {"type": "message"},
            {"type": "function_call", "name": "read_passage", "arguments": '{"document": "a.pdf", "pages": "4-6"}'},
            {"type": "function_call", "name": "list_files", "arguments": "not json"},
        ]
        assert files_eval.recorded_calls(items) == [
            {"name": "read_passage", "arguments": {"document": "a.pdf", "pages": "4-6"}},
            {"name": "list_files", "arguments": {}},
        ]

    def test_the_moves_a_run_made(self):
        assert files_eval.moves(self.CALLS) == "list+grep"
        meaning = [{"name": "knowledge_search", "arguments": {"query": "Aufzug"}}]
        assert files_eval.moves(meaning) == "search"
        coming = [
            {"name": "ls", "arguments": {"path": "/project/"}},
            {"name": "grep", "arguments": {"pattern": "Fluchtweg"}},
            {"name": "read_file", "arguments": {"file_path": "/project/Einreichung/a.pdf.md"}},
        ]
        assert files_eval.moves(coming) == "list+grep+read"
        assert files_eval.moves([]) == "none"

    def test_a_row_written_for_the_old_names_holds_for_the_standard_ones(self):
        """ADR-0133 §8: the matcher maps old to new for the release the aliases live, so runs compare."""
        new = [
            {"name": "read_file", "arguments": {"file_path": "/project/Gutachten/B.pdf.md", "pages": "4-6"}},
            {"name": "ls", "arguments": {"path": "/project/Einreichung/", "depth": 2}},
            {"name": "grep", "arguments": {"pattern": "Fluchtweg"}},
        ]
        assert files_eval.called({"read_passage": {"pages": "4-6", "document": "B.pdf"}}, new)
        assert files_eval.called({"list_files": {"view": "tree", "folder": "Einreichung"}}, new)
        assert files_eval.called({"knowledge_search": {"match": "exact"}}, new)
        # A grep is the literal move, reported apart from a ranked search (the arms compare the two).
        assert files_eval.moves(new) == "list+grep+read"

    def test_a_row_written_for_the_standard_names_holds_for_the_old_ones(self):
        assert files_eval.called({"grep": {"mode": "exact"}}, self.CALLS)
        assert files_eval.called("ls", self.CALLS)
        assert files_eval.called({"read_file": {"pages": "2"}}, [{"name": "read_passage", "arguments": {"pages": "2"}}])

    def test_a_draft_is_no_file_move(self):
        drafts = [
            {"name": "read_file", "arguments": {"file_path": "/drafts/a.md"}},
            {"name": "ls", "arguments": {"path": "/drafts/"}},
        ]
        assert not files_eval.called("read_passage", drafts)
        assert not files_eval.called("list_files", drafts)
        assert files_eval.moves(drafts) == "none"


class TestTheComingNames:
    """ADR-0133 §8: a call by a coming name holds the row written for today's, and the other way round."""

    def test_a_path_is_read_as_the_scope_it_addresses(self):
        assert files_eval.path_scope("/project/Gutachten/Brandschutz/Brandschutzkonzept_Hubergasse14.pdf.md") == {
            "shelf": "project",
            "folder": "Gutachten/Brandschutz",
            "file_name": "Brandschutzkonzept_Hubergasse14.pdf",
        }
        assert files_eval.path_scope("/project/Behörde/") == {"shelf": "project", "folder": "Behörde"}
        assert files_eval.path_scope("/project/Einreichung/Pläne") == {
            "shelf": "project",
            "folder": "Einreichung/Pläne",
        }
        assert files_eval.path_scope("/project/") == {"shelf": "project"}
        assert files_eval.path_scope(None) == {}

    def test_grep_holds_an_exact_search_row_and_its_default_mode_is_exact(self):
        calls = [{"name": "grep", "arguments": {"pattern": "Fluchtweg", "path": "/project/"}}]
        assert files_eval.called({"knowledge_search": {"match": ["exact", "regex"]}}, calls)
        assert not files_eval.called({"knowledge_search": {"match": "regex"}}, calls)
        regex = [{"name": "grep", "arguments": {"pattern": r"MA 37/\d+", "mode": "regex"}}]
        assert files_eval.called({"knowledge_search": {"match": "regex"}}, regex)

    def test_a_scoped_grep_or_search_holds_a_folder_row(self):
        scoped = [{"name": "grep", "arguments": {"pattern": "Höhe", "path": "/project/Behörde/"}}]
        assert files_eval.called({"knowledge_search": {"folder": "Behörde"}}, scoped)
        meaning = [{"name": "knowledge_search", "arguments": {"query": "Brandschutz", "path": "/project/Nachbarn/"}}]
        assert files_eval.called({"knowledge_search": {"folder": "Nachbarn"}}, meaning)
        one = [
            {
                "name": "knowledge_search",
                "arguments": {"path": "/project/Nachbarn/Brandschutzgutachten_Hubergasse16.pdf.md"},
            }
        ]
        assert files_eval.called({"knowledge_search": {"file_name": "Brandschutzgutachten_Hubergasse16.pdf"}}, one)

    def test_ls_and_glob_hold_a_list_row_and_read_file_a_read_row(self):
        assert files_eval.called("list_files", [{"name": "ls", "arguments": {"path": "/project/"}}])
        assert files_eval.called("list_files", [{"name": "glob", "arguments": {"pattern": "**/*Schnitt*"}}])
        read = [
            {"name": "read_file", "arguments": {"file_path": "/project/Gutachten/Brandschutz/B.pdf.md", "pages": "4-6"}}
        ]
        assert files_eval.called("read_passage", read)
        assert files_eval.called({"read_passage": {"document": "B.pdf", "pages": "4-6"}}, read)
        assert not files_eval.called({"list_files": {"revisions_of": "*"}}, [{"name": "ls", "arguments": {}}])

    def test_a_row_written_with_a_coming_name_holds_todays_call(self):
        today = [
            {"name": "knowledge_search", "arguments": {"query": "Fluchtweg", "match": "exact", "folder": "Behörde"}}
        ]
        assert files_eval.called("grep", today)
        assert files_eval.called({"grep": {"mode": "exact", "path": "/project/Behörde/"}}, today)
        assert files_eval.called({"grep": {"path": ["/project/Behörde/", "/project/Nachbarn/"]}}, today)
        assert files_eval.called("ls", [{"name": "list_files", "arguments": {}}])

    def test_no_repeat_counts_a_listing_by_either_name(self):
        calls = [{"name": "ls", "arguments": {}}, {"name": "list_files", "arguments": {}}]
        checks = files_eval.files_checks({"no_repeat": ["list_files"]}, calls, "", "q", None, [], 1)
        assert checks == {"no_repeat:list_files": False}

    def test_every_row_holds_for_the_coming_names_of_its_own_tools(self):
        """Each `tools.must` item a row names by today's tool is met by the coming tool's call."""
        coming = {
            "list_files": {"name": "ls", "arguments": {"path": "/project/"}},
            "read_passage": {"name": "read_file", "arguments": {"file_path": "/project/x.pdf.md"}},
        }
        for row in ROWS:
            for item in (row["expect"].get("tools") or {}).get("must") or []:
                if isinstance(item, str) and item in coming:
                    assert files_eval.called(item, [coming[item]]), row["id"]
                if (
                    isinstance(item, dict)
                    and set(item) == {"knowledge_search"}
                    and set(item["knowledge_search"]) == {"match"}
                ):
                    grep = {"name": "grep", "arguments": {"pattern": "x"}}
                    assert files_eval.called(item, [grep]), row["id"]


class TestTheNewRows:
    """The rows the owner asked for: the open document is a hint, not the scope; and exact lookups."""

    def _pages(self, name: str) -> str:
        return "\n".join(next(f for f in PROJECT.files if f.name == name).pages)

    def _holding(self, needle: str) -> set[str]:
        return {f.name for f in PROJECT.files if needle in "\n".join(f.pages)}

    def test_an_outside_row_asks_about_a_fact_the_open_document_does_not_hold(self):
        outside = [row for row in ROWS if row["id"].startswith("pf-outside-")]
        assert len(outside) >= 3
        for row in outside:
            assert row["open"] in PROJECT.names
            for value in row["expect"]["mentions"]:
                assert value not in self._pages(row["open"]), row["id"]
                assert self._holding(value), f"{row['id']}: {value} stands nowhere"

    def test_the_inside_control_asks_what_the_open_document_holds(self):
        row = next(row for row in ROWS if row["id"] == "pf-inside-open")
        assert all(value in self._pages(row["open"]) for value in row["expect"]["mentions"])

    def test_the_exact_facts_stand_where_the_rows_expect_them(self):
        assert self._holding("REI 90") == {
            "Baubeschreibung_Hubergasse14.pdf",
            "Bescheid_MA37_Baubewilligung.pdf",
            "Brandschutzkonzept_Hubergasse14.pdf",
            "Brandschutzgutachten_Hubergasse16.pdf",
        }
        assert self._holding("§ 9 ") == {"Bebauungsbestimmungen_Hubergasse14.pdf"}
        assert self._holding("Wärmepumpe") == {"Baubeschreibung_Hubergasse14.pdf"}
        assert self._holding("Tiefgarage") == set() and self._holding("Garagengesetz")
        assert self._holding("B-01") == {"Bestandsplan_1974.pdf"}

    def test_an_open_row_sends_the_document_as_the_composer_does(self):
        import turn_input

        row = next(row for row in ROWS if row["id"] == "pf-outside-open-number")
        fields = turn_input.message_fields(row)
        assert fields["focus_file_name"] == "Brandschutzkonzept_Hubergasse14.pdf"
        assert fields["focus_shelf"] == "project" and fields["focus_document_id"]
        with pytest.raises(ValueError):
            turn_input.message_fields({"id": "x", "open": "Nirgends.pdf"})


class TestTheSuiteReadsTheSet:
    def test_a_recorded_turn_keeps_its_call_arguments_and_the_files_checks_run(self, tmp_path):
        import json

        message = {
            "type": "message",
            "content": [
                {
                    "text": "```answer_json\n"
                    + json.dumps({"answer": "Seite 3, 7, 11", "kind": "answer", "cards": []})
                    + "\n```"
                }
            ],
        }
        call = {
            "type": "function_call",
            "name": "knowledge_search",
            "arguments": '{"query": "Fluchtweg", "match": "exact"}',
        }
        usage = {"input_tokens": 1000, "output_tokens": 50, "output_tokens_details": {"reasoning_tokens": 0}}
        url = "https://openrouter.ai/api/v1/responses"
        request = {"input": [{"role": "user"}]}
        rows = [
            {"url": url, "t_start": 0.0, "t_end": 1.0, "req": {"input": "ping"}},
            {"url": url, "t_start": 2.0, "t_end": 4.0, "req": request, "usage": usage, "resp": {"output": [call]}},
            {"url": url, "t_start": 5.0, "t_end": 7.0, "req": request, "usage": usage, "resp": {"output": [message]}},
        ]
        record = tmp_path / "turn.jsonl"
        record.write_text("\n".join(json.dumps(row) for row in rows))
        log = tmp_path / "turn.log"
        log.write_text("")
        question = next(row for row in ROWS if row["id"] == "pf-exact-term")

        run = suite.observe(question, 1, record, log)

        assert run.tool_args == [{"name": "knowledge_search", "arguments": {"query": "Fluchtweg", "match": "exact"}}]
        assert run.checks["must:knowledge_search(match=['exact', 'regex'])"] is True

    def test_the_report_names_the_arm_and_the_rows_waiting(self):
        run = suite.Run(question_id="pf-orient-project", run=1, research_calls=2, wall_s=9.0)
        run.tool_args = [{"name": "list_files", "arguments": {}}]
        run.checks = {"any:list_files": True}
        run.cost_usd, run.input_tokens, run.output_tokens = 0.0123, 4000, 300
        run.tool_calls = ["list_files"]
        lines = files_eval.report_lines([run], {"arm": "navigate", "not_applicable": ["pf-read-range"]})
        text = "\n".join(lines)
        assert "arm: grep" in text
        assert "| pf-orient-project | 1/1 | n/a | 2 | 1.0 | 4,000 | 300 | $0.0123 | 9 | list |" in text
        assert "pf-read-range" in text

    def test_the_arm_flag_is_for_the_files_set(self, capsys):
        with pytest.raises(SystemExit):
            suite.main(["--arm", "search"])
        assert "--arm is for --set files" in capsys.readouterr().err

    def test_a_saved_files_report_is_re_read_with_the_set_chosen(self, tmp_path):
        import json

        run = suite.Run(question_id="pf-orient-project", run=1, error="timed out")
        meta = {"set": "files", "arm": "both", "stamp": None, "commit": "x", "started": "-"}
        results = {
            "meta": {**meta, "runs_per_question": 1, "overrides": []},
            "skipped": [],
            "not_in_corpus": [],
            "runs": [suite.asdict(run)],
        }
        path = tmp_path / "results.json"
        path.write_text(json.dumps(results))
        assert suite._rerender(path, None) == 0
