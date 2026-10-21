"""The north-star set: the exemplar document and its rows kept in step, and the rows held to today's tools.

Offline. A live run needs a model key, a Qdrant and the seeded fixture projects. What is pinned here is what
would make the set measure the wrong thing or drift from the document: an exemplar without a row, a row
asking for a tool or argument that does not exist, a gold box that does not resolve, a drawn box that does
not hold its gold, a row that the ideal answer of its exemplar would fail.
"""

from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import files_eval  # noqa: E402
import fixture_files  # noqa: E402
import judge  # noqa: E402
import north_star_eval  # noqa: E402
import render_fixture_drawings as drawings  # noqa: E402
import suite  # noqa: E402
import visual_eval  # noqa: E402

ROWS = north_star_eval.load_questions()
BY_ID = {row["id"]: row for row in ROWS}
EXEMPLARS = north_star_eval.doc_exemplars()
FILES_PROJECT = fixture_files.load_project()
DRAWINGS = {d["file_name"] for d in drawings.load_spec()["drawings"]}
SCHEMA = {tool["name"]: tool for tool in json.loads(files_eval.TOOL_SCHEMA.read_text(encoding="utf-8"))["tools"]}


def _canvas_members() -> set[str]:
    """The canvas group's members, as the model sees them (``canvas__point``), read off its DESCRIPTIONS."""
    source = (REPO_ROOT / "src/aiq_agent/tools/canvas/register.py").read_text(encoding="utf-8")
    block = source.split("DESCRIPTIONS = {", 1)[1].split("\n}\n", 1)[0]
    return {f"canvas__{name}" for name in re.findall(r'^    "([a-z_]+)": \(', block, re.MULTILINE)}


def _file_change_operations() -> set[str]:
    source = (REPO_ROOT / "src/aiq_agent/tools/files/register.py").read_text(encoding="utf-8")
    return set(ast.literal_eval(re.search(r"^_OPERATIONS = (\(.*?\))", source, re.MULTILINE).group(1)))


#: Every name the model can call today: the configured tools, the canvas group spelled out, and `look`.
TOOLS = {*files_eval.configured_tools(), *_canvas_members(), "look"} - {"canvas"}


def _tool_items(row: dict) -> list:
    tools = (row.get("expect") or {}).get("tools") or {}
    return [item for key in ("must", "any", "must_not") for item in tools.get(key) or []]


class TestTheDocumentAndTheRows:
    def test_every_exemplar_has_a_row_and_every_row_an_exemplar(self):
        assert set(EXEMPLARS) == set(BY_ID)
        assert len(ROWS) == len(BY_ID), "row ids are unique"

    def test_horizon_is_marked_the_same_in_both(self):
        assert {i for i, horizon in EXEMPLARS.items() if horizon} == {r["id"] for r in ROWS if r.get("horizon")}

    def test_the_horizon_covers_scenes_five_and_seven(self):
        scenes = {s for row in ROWS if row.get("horizon") for s in row["scene"]}
        assert {5, 7} <= scenes

    def test_the_exemplars_cover_every_scene_and_the_restraint(self):
        assert {s for row in ROWS for s in row["scene"]} >= {1, 2, 3, 4, 5, 7, "restraint"}

    def test_the_document_is_linked_from_the_capability_register_and_the_docs_index(self):
        for page in ("docs/architecture/agent-capabilities.md", "docs/README.md"):
            assert "north-star-answers.md" in (REPO_ROOT / page).read_text(encoding="utf-8"), page


class TestTheRows:
    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_expects_something_and_only_known_things(self, row):
        expect = row.get("expect") or {}
        assert str(row["id"]).startswith("ns-")
        assert expect.get("tools") or expect.get("judge"), "a row without expect.tools or a judge measures nothing"
        assert set(expect) <= files_eval.CHECK_KEYS
        assert set(expect.get("tools") or {}) <= files_eval.TOOL_KEYS
        assert all(kind in judge.RUBRICS for kind in expect.get("judge") or [])
        assert set(row["scene"]) <= north_star_eval.SCENES
        assert row.get("capability")

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_every_tool_a_row_names_exists_today_with_those_arguments(self, row):
        for item in _tool_items(row):
            name, arguments = next(iter(item.items())) if isinstance(item, dict) else (item, {})
            assert name in TOOLS, f"{name} is not a tool the agent can call"
            if name in SCHEMA:
                properties = SCHEMA[name]["inputSchema"]["properties"]
                assert set(arguments) <= set(properties), f"{name} has no {set(arguments) - set(properties)}"
            for argument, wanted in arguments.items():
                values = wanted if isinstance(wanted, list) else [wanted]
                if (name, argument) == ("knowledge_search", "match"):
                    assert set(values) <= {"meaning", "exact", "regex"}
                if (name, argument) == ("list_files", "view"):
                    assert set(values) <= set(SCHEMA[name]["inputSchema"]["properties"]["view"]["anyOf"][0]["enum"])
                if (name, argument) == ("propose_file_change", "operation"):
                    assert set(values) <= _file_change_operations()

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_names_only_files_its_fixture_holds(self, row):
        asked = " ".join(str(v) for v in [row["question"], row.get("expect"), row.get("gold")])
        named = {w.strip("`'\",.?:;()[]{}") for w in asked.replace("(", " ").split() if ".pdf" in w}
        named = {n.split("'")[0] for n in named}
        holds = set(FILES_PROJECT.names) if row["fixture"] == "files" else DRAWINGS
        assert named <= holds

    @pytest.mark.parametrize("row", [r for r in ROWS if r["fixture"] == "visual"], ids=lambda row: row["id"])
    def test_a_visual_row_has_a_gold_that_resolves_to_a_box(self, row):
        assert row["gold"], "a visual row says where the answer is"
        for gold in row["gold"]:
            x, y, w, h = gold["box"]
            assert 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1 and y + h <= 1

    def test_a_drawn_box_holds_its_gold(self):
        given = [row for row in ROWS if row.get("box") == "given"]
        assert given, "the drawn-box exemplar has a row"
        for row in given:
            for gold in row["gold"]:
                assert visual_eval.coverage(tuple(row["region"]), gold["box"]) == pytest.approx(1.0)

    def test_the_loader_refuses_what_would_measure_nothing(self, tmp_path):
        spec = drawings.load_spec()
        bad = tmp_path / "rows.yaml"
        bad.write_text(
            "questions:\n  - {id: ns-x, scene: [3], capability: c, fixture: visual, box: given, "
            "question: q, gold: {document: EP-02_Schnitt_A-A.pdf, page: 1, element: title-scale}, "
            "expect: {tools: {must: [look]}}}\n",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="box: given"):
            north_star_eval.load_questions(bad, spec)
        bad.write_text(
            "questions:\n  - {id: ns-x, scene: [1], capability: c, fixture: files, needs: [telepathy], "
            "question: q, expect: {tools: {must: [list_files]}}}\n",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="unknown needs"):
            north_star_eval.load_questions(bad, spec)

    @pytest.mark.parametrize("row", [r for r in ROWS if r.get("maps_to")], ids=lambda row: row["id"])
    def test_a_mapped_row_names_rows_that_exist(self, row):
        known = {r["id"] for r in files_eval.load_questions()} | {r["id"] for r in visual_eval.load_questions()}
        assert set(row["maps_to"]) <= known


class TestWhatRunsOnThisCommit:
    def test_a_row_waits_for_what_it_needs_and_the_horizon_never_runs(self):
        everything = set(files_eval.NEEDS) | set(north_star_eval.HARNESS)
        runnable, waiting, horizon = north_star_eval.split(ROWS, everything)
        assert {r["id"] for r in runnable} == {r["id"] for r in ROWS if not r.get("horizon")}
        assert waiting == []
        assert set(horizon) == {"ns-notice-new-document", "ns-learn-office"}
        _, waiting, _ = north_star_eval.split(ROWS, set())
        assert any(w.startswith("ns-drawn-box (") and "given_box" in w for w in waiting)

    def test_today_the_drawn_box_and_the_proposal_wait_and_say_why(self):
        _, waiting, _ = north_star_eval.split(ROWS)
        ids = {w.split(" ", 1)[0] for w in waiting}
        assert "ns-drawn-box" in ids
        assert ("ns-propose-move" in ids) == ("proposals" not in north_star_eval.harness_available())

    def test_the_rows_run_files_first_each_behind_its_fixture(self):
        groups = north_star_eval.by_fixture(ROWS)
        assert list(groups) == ["files", "visual"]
        assert all(row["set"] == fixture for fixture, rows in groups.items() for row in rows)


def _run(row: dict, answer: str, calls: list[dict], rounds: int = 1) -> dict[str, bool]:
    """The checks ``suite.observe`` would record for a run, minus the judge (offline)."""
    run = suite.Run(question_id=row["id"], run=1, answer=answer, tool_args=calls, research_calls=rounds)
    checks = suite.check(row, run, {"cards": []})
    expect = {**row["expect"], "judge": []}
    if row["set"] == "visual":
        checks.update(visual_eval.visual_checks(expect, calls, row["gold"], answer, row["question"], None, [], rounds))
    else:
        checks.update(files_eval.files_checks(expect, calls, answer, row["question"], None, [], rounds))
    return checks


def call(name: str, **arguments: object) -> dict:
    return {"name": name, "arguments": arguments}


class TestTheExemplarPassesItsRow:
    """The ideal trajectory and answer of an exemplar hold every check of its row; its anti-pattern does not."""

    def test_dimension(self):
        row = BY_ID["ns-dimension"]
        looks = [
            call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1),
            call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.03, 0.42, 0.2, 0.12]),
        ]
        ideal = "**5,24 m**, eingetragen an der Maßkette unter dem Wohnraum im Grundriss Erdgeschoß, Index B [1]."
        assert all(_run(row, ideal, looks, 3).values())
        unseen = _run(row, "Der Wohnraum ist 5,04 m breit.", [], 1)
        assert not unseen["must:look"] and not unseen["not:5,04"]

    def test_door_count_regions(self):
        row = BY_ID["ns-door-count"]
        doc = "EP-01_Grundrisse_Index-B.pdf"
        looks = [
            call("look", document=doc, page=1),
            call("look", document=doc, page=1, region=[0.03, 0.08, 0.68, 0.40]),
            call("look", document=doc, page=1, region=[0.03, 0.48, 0.68, 0.38]),
        ]
        assert all(_run(row, "**Fünf Türen** im Grundriss Erdgeschoß, Index B [1].", looks, 3).values())

    def test_fassung_compare_same_region_on_both(self):
        row = BY_ID["ns-fassung-compare"]
        region = [0.03, 0.44, 0.40, 0.30]
        looks = [
            call("look", document="EP-01_Grundrisse_Index-A.pdf", page=1, region=region),
            call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1, region=region),
        ]
        answer = "| Maß unter Wohnen | 5,04 m | **5,24 m** |\n| Wand Schlafen/Kind | durchgehend | **neue Tür** |"
        assert all(_run(row, answer, looks, 3).values())
        one_side = _run(row, answer, looks[1:], 3)
        assert one_side["gold_covered"] is False

    def test_plankopf_in_one_look(self):
        row = BY_ID["ns-plankopf"]
        look = [call("look", document="EP-02_Schnitt_A-A.pdf", page=1, region=[0.70, 0.66, 0.30, 0.30])]
        assert all(_run(row, "Maßstab **1:50**, Datum **14.03.2026**, Index B [1].", look, 2).values())

    def test_geschaeftszahlen_by_regex(self):
        row = BY_ID["ns-geschaeftszahlen"]
        search = [call("knowledge_search", match="regex", query=r"MA ?37/\d{6}(-\d{4})?(-\d+)?", context=1)]
        answer = "| MA 37/567812-2026-1 | … |\n| MA 37/654321-2026 | … |\n| MA 37/123456-2026 | … |"
        assert all(_run(row, answer, search, 2).values())
        ranked = _run(row, answer, [call("knowledge_search", query="Geschäftszahl MA 37")], 2)
        assert not ranked["must:knowledge_search(match=['regex', 'exact'])"]

    def test_current_fassung_from_the_folder_card_alone(self):
        row = BY_ID["ns-current-fassung"]
        tree = [call("list_files", view="tree", folder="Einreichung")]
        answer = "Sechs: drei direkt in der Einreichung … Bei den Grundrissen gilt Index B vom 03.02.2026."
        assert all(_run(row, answer, tree, 2).values())
        over_read = _run(row, answer, [*tree, call("read_passage", document="EP-01_Grundrisse_Index-B.pdf")], 3)
        assert not over_read["must_not:read_passage"] and not over_read["rounds<=2"]

    def test_trivial_stays_without_tools(self):
        row = BY_ID["ns-trivial"]
        assert all(_run(row, "EP-02_Schnitt_A-A.pdf, im Ordner Einreichung/Pläne.", [], 1).values())
        browsed = _run(row, "EP-02_Schnitt_A-A.pdf", [call("knowledge_search", query="Schnitt")], 2)
        assert not browsed["must_not:knowledge_search"]


class TestTheSuiteWiring:
    def test_north_star_is_a_set_the_suite_loads(self):
        assert [q["id"] for q in suite._north_star_questions()] == [r["id"] for r in ROWS]

    def test_the_arm_and_the_look_switch_stay_with_their_sets(self, capsys):
        with pytest.raises(SystemExit):
            suite.main(["--set", "north-star", "--arm", "search"])
        assert "--arm is for --set files" in capsys.readouterr().err

    def test_the_report_lists_what_waits_and_the_horizon(self):
        text = "\n".join(
            north_star_eval.report_lines(
                [], {"not_applicable": ["ns-drawn-box (given_box)"], "horizon": ["ns-learn-office"]}
            )
        )
        assert "No run finished." in text
        assert "Not applicable on this commit: ns-drawn-box (given_box)." in text
        assert "Horizon, not run: ns-learn-office." in text
