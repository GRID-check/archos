"""The visual eval's spec, rows and scorer: everything between a recorded turn and its report (ADR-0128).

Offline: a live run needs a model key, a Qdrant and the seeded project. What is pinned here is what would
make a live run measure the wrong thing: a gold box that is not where the ink is, a value in a row that
the drawing does not hold, a look counted under one of its names and not another, an IoU computed wrongly.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import files_eval  # noqa: E402
import fixture_visual  # noqa: E402
import render_fixture_drawings as drawings  # noqa: E402
import suite  # noqa: E402
import visual_eval  # noqa: E402

SPEC = drawings.load_spec()
ROWS = visual_eval.load_questions()
PAGES = {(d["file_name"], p["number"]): p for d in SPEC["drawings"] for p in d["pages"]}


def call(name: str, **arguments: object) -> dict:
    return {"name": name, "arguments": arguments}


class TestTheSpec:
    def test_element_ids_are_unique_on_a_page_and_boxes_stay_on_the_page(self):
        for page in PAGES.values():
            ids = [e["id"] for e in page["elements"]]
            assert len(ids) == len(set(ids))
            for element in page["elements"]:
                x, y, w, h = element["box"]
                assert 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1 and y + h <= 1, element["id"]

    def test_a_count_is_the_number_of_doors_drawn(self):
        for page in PAGES.values():
            doors = [e for e in page["elements"] if e["kind"] == "door"]
            area = next(e for e in page["elements"] if e["kind"] == "plan_area")
            assert area.get("value", 0) == len(doors)

    def test_the_two_revisions_differ_in_one_door_and_one_dimension(self):
        a, b = PAGES[("EP-01_Grundrisse_Index-A.pdf", 1)], PAGES[("EP-01_Grundrisse_Index-B.pdf", 1)]
        body = lambda page: {  # noqa: E731
            e["id"]: (e["kind"], e.get("text"), tuple(e["box"]))
            for e in page["elements"]
            if e["kind"] in ("door", "dimension", "room", "legend_entry")
        }
        changed = {k for k in body(a).keys() | body(b).keys() if body(a).get(k) != body(b).get(k)}
        assert changed == {"door-5", "dim-wohnen"}

    def test_the_only_indexed_text_is_a_caption_without_the_values_asked(self):
        indexed = " ".join(p["index_text"] for p in PAGES.values())
        for page in PAGES.values():
            for element in page["elements"]:
                if element["kind"] in ("dimension", "title_field"):
                    assert len(str(element["value"])) < 4 or str(element["value"]) not in indexed

    def test_the_project_seeds_one_chunk_per_page_from_the_caption(self):
        project = fixture_visual.load_project()
        assert sorted(project.names) == sorted(d["file_name"] for d in SPEC["drawings"])
        assert {len(f.pages) for f in project.files if "Index-B" in f.name} == {2}


class TestTheRendering:
    @pytest.fixture(scope="class")
    def rendered(self, tmp_path_factory):
        out = tmp_path_factory.mktemp("drawings")
        return drawings.render_all(out, SPEC, dpi=50)

    def test_sheets_have_the_size_of_a3_and_a1(self, rendered):
        import pypdfium2

        sizes = {}
        for name, path in rendered.items():
            document = pypdfium2.PdfDocument(path)
            sizes[name] = (len(document), tuple(round(v / 72 * 25.4) for v in document[0].get_size()))
        assert sizes["EP-01_Grundrisse_Index-B.pdf"] == (2, (420, 297))
        assert sizes["EP-01_Grundrisse_Index-A.pdf"] == (1, (420, 297))
        assert sizes["EP-02_Schnitt_A-A.pdf"] == (1, (841, 594))

    def test_every_drawn_element_has_ink_in_its_gold_box_and_a_blank_page_does_not(self):
        for drawing in SPEC["drawings"]:
            for page in drawing["pages"]:
                image = drawings.render_page(SPEC, drawing, page, dpi=100)
                for element in page["elements"]:
                    if element["kind"] == "plan_area":
                        continue
                    area = drawings.pixel_box(element["box"], image.size)
                    assert image.crop(area).getextrema()[0] < 128, (drawing["file_name"], element["id"])

    def test_nothing_but_the_spec_is_committed(self):
        committed = {p.suffix for p in (REPO_ROOT / "tests" / "fixtures" / "visual").iterdir()}
        assert committed <= {".json", ".yaml"}


class TestTheRows:
    def test_there_are_about_twenty_in_six_categories(self):
        assert 18 <= len(ROWS) <= 24
        assert {r["category"] for r in ROWS} == set(visual_eval.CATEGORIES)
        assert len({r["id"] for r in ROWS}) == len(ROWS)
        assert all(r["id"].startswith("pv-") for r in ROWS)

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_row_expects_a_look_or_none_and_only_known_things(self, row):
        expect = row["expect"]
        assert set(expect) <= files_eval.CHECK_KEYS
        tools = expect["tools"]
        assert set(tools) <= files_eval.TOOL_KEYS
        assert (tools.get("must") == ["look"]) != (tools.get("must_not") == ["look"])
        assert expect.get("mentions")
        assert (row["category"] == "skip") == bool(tools.get("must_not"))
        assert bool(row["gold"]) == bool(tools.get("must"))

    @pytest.mark.parametrize("row", ROWS, ids=lambda row: row["id"])
    def test_a_value_a_row_expects_is_the_one_the_gold_element_holds(self, row):
        spec_elements = {(f, n, e["id"]): e for (f, n), page in PAGES.items() for e in page["elements"]}
        for gold in row["gold"]:
            element = spec_elements[(gold["document"], gold["page"], gold["element"])]
            if element["kind"] in ("dimension", "title_field"):
                wanted = [alternative for item in row["expect"]["mentions"] for alternative in item]
                assert any(str(element["value"]) in str(alternative) for alternative in wanted)

    def test_counts_name_the_number_of_doors_the_page_has(self):
        words = {3: "drei", 4: "vier", 5: "fünf", 8: "acht"}
        for row in (r for r in ROWS if r["category"] == "count"):
            total = sum(
                next(e for e in PAGES[(g["document"], g["page"])]["elements"] if e["id"] == "plan-area")["value"]
                for g in row["gold"]
            )
            alternatives = [a for item in row["expect"]["mentions"] for a in item]
            assert any(a.startswith(f"{total} ") or a.startswith(words[total]) for a in alternatives)

    def test_a_row_naming_a_file_names_one_of_the_project(self):
        names = set(fixture_visual.load_project().names)
        for row in ROWS:
            mentioned = {m for item in row["expect"]["mentions"] for m in item if m.endswith(".pdf")}
            assert mentioned <= names

    def test_a_given_box_is_refused_in_the_set_that_does_not_send_one(self, tmp_path):
        path = tmp_path / "q.yaml"
        path.write_text(
            "questions:\n  - id: pv-x\n    question: q\n    box: given\n    expect: {tools: {must_not: [look]}}\n",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="only the north-star set"):
            visual_eval.load_questions(path)

    def test_a_gold_that_is_not_an_element_is_refused(self, tmp_path):
        path = tmp_path / "q.yaml"
        path.write_text(
            "questions:\n  - id: pv-x\n    question: q\n"
            "    gold: {document: EP-02_Schnitt_A-A.pdf, page: 1, element: nope}\n"
            "    expect: {tools: {must: [look]}}\n",
            encoding="utf-8",
        )
        with pytest.raises(ValueError, match="not an element"):
            visual_eval.load_questions(path)


class TestTheBoxes:
    def test_iou_of_equal_disjoint_and_nested_boxes(self):
        box = (0.1, 0.1, 0.2, 0.2)
        assert visual_eval.iou(box, box) == pytest.approx(1.0)
        assert visual_eval.iou(box, (0.5, 0.5, 0.1, 0.1)) == 0.0
        assert visual_eval.iou((0.0, 0.0, 1.0, 1.0), box) == pytest.approx(0.04)

    def test_iou_of_a_half_overlap(self):
        assert visual_eval.iou((0.0, 0.0, 0.2, 0.1), (0.1, 0.0, 0.2, 0.1)) == pytest.approx(1 / 3)

    def test_coverage_is_the_share_of_the_gold_inside_the_look(self):
        gold = (0.1, 0.1, 0.2, 0.2)
        assert visual_eval.coverage((0.0, 0.0, 1.0, 1.0), gold) == pytest.approx(1.0)
        assert visual_eval.coverage((0.0, 0.0, 0.2, 1.0), gold) == pytest.approx(0.5)
        assert visual_eval.coverage((0.5, 0.5, 0.1, 0.1), gold) == 0.0


class TestWhatCountsAsALook:
    @pytest.mark.parametrize("name", ["look", "canvas__look", "view_knowledge_image", "workspace__look"])
    def test_every_name_of_the_capability_is_a_look(self, name):
        assert visual_eval.is_look(name)

    @pytest.mark.parametrize("name", ["knowledge_search", "list_files", "read_passage", "canvas__highlight", "looking"])
    def test_other_tools_are_not(self, name):
        assert not visual_eval.is_look(name)

    def test_the_arguments_of_both_shapes_are_read(self):
        looks = visual_eval.looks_of(
            [
                call("canvas__look", document="Schnitt", page=2, region=[0.1, 0.2, 0.3, 0.4]),
                call("view_knowledge_image", file_name="Schnitt.pdf", page_number=3, collection="c"),
                call("knowledge_search", query="x"),
            ]
        )
        assert looks == [
            {"document": "Schnitt", "page": 2, "box": (0.1, 0.2, 0.3, 0.4)},
            {"document": "Schnitt.pdf", "page": 3, "box": visual_eval.WHOLE_PAGE},
        ]

    def test_a_region_that_is_not_four_numbers_is_the_whole_page(self):
        assert visual_eval.looks_of([call("look", document="a", region="oben")])[0]["box"] == visual_eval.WHOLE_PAGE

    @pytest.mark.parametrize(
        ("given", "same"),
        [
            ("EP-01_Grundrisse_Index-B.pdf", True),
            ("EP-01_Grundrisse_Index-B", True),
            ("Index-B", True),
            ("ep-01_grundrisse_index-b.PDF", True),
            ("EP-01_Grundrisse_Index-A.pdf", False),
            ("", False),
            ("5b0c9f64-8c53-4a53-9d8c-1f4a1c1e6a11", False),
        ],
    )
    def test_a_document_is_named_as_the_inventory_resolves_it(self, given, same):
        assert visual_eval.same_document("EP-01_Grundrisse_Index-B.pdf", given) is same


GOLD_DIM = {"document": "EP-01_Grundrisse_Index-B.pdf", "page": 1, "box": (0.05, 0.47, 0.06, 0.03)}


class TestTheScores:
    def test_the_best_look_at_the_right_page_scores_and_others_are_ignored(self):
        looks = [
            {"document": "EP-01_Grundrisse_Index-B.pdf", "page": 2, "box": visual_eval.WHOLE_PAGE},
            {"document": "EP-02_Schnitt_A-A.pdf", "page": 1, "box": visual_eval.WHOLE_PAGE},
            {"document": "Grundrisse_Index-B", "page": 1, "box": (0.0, 0.4, 0.2, 0.15)},
            {"document": "Grundrisse_Index-B", "page": 1, "box": (0.05, 0.47, 0.06, 0.03)},
        ]
        [score] = visual_eval.gold_scores(looks, [GOLD_DIM])
        assert score == {"iou": pytest.approx(1.0), "coverage": pytest.approx(1.0)}

    def test_a_generous_crop_covers_the_gold_with_a_small_iou(self):
        [score] = visual_eval.gold_scores(
            [{"document": "Index-B", "page": 1, "box": (0.0, 0.4, 0.2, 0.15)}], [GOLD_DIM]
        )
        assert score["coverage"] == pytest.approx(1.0)
        assert score["iou"] == pytest.approx(0.0018 / 0.03)

    def test_no_look_scores_zero(self):
        assert visual_eval.gold_scores([], [GOLD_DIM]) == [{"iou": 0.0, "coverage": 0.0}]


class TestTheChecks:
    @staticmethod
    def check(row_id: str, calls: list[dict], look_on: bool = True) -> dict[str, bool]:
        row = next(r for r in ROWS if r["id"] == row_id)
        return visual_eval.visual_checks(row["expect"], calls, row["gold"], "", row["question"], None, [], 1, look_on)

    def test_a_turn_that_looked_at_the_figure_holds_every_check(self):
        calls = [call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.0, 0.4, 0.2, 0.15])]
        assert self.check("pv-dim-wohnen", calls) == {"must:look": True, "gold_covered": True}

    def test_the_old_names_count_the_same(self):
        calls = [
            call(
                "view_knowledge_image",
                file_name="EP-01_Grundrisse_Index-B.pdf",
                page_number=1,
                region=[0, 0.4, 0.2, 0.15],
            )
        ]
        assert all(self.check("pv-dim-wohnen", calls).values())

    def test_a_turn_that_never_looked_fails_both(self):
        assert self.check("pv-dim-wohnen", [call("knowledge_search", query="Wohnen")]) == {
            "must:look": False,
            "gold_covered": False,
        }

    def test_a_look_at_the_wrong_page_is_a_look_that_missed(self):
        calls = [call("look", document="EP-01_Grundrisse_Index-B.pdf", page=2)]
        assert self.check("pv-dim-wohnen", calls) == {"must:look": True, "gold_covered": False}

    def test_a_revision_row_needs_every_gold_covered(self):
        a = call("look", document="EP-01_Grundrisse_Index-A.pdf", page=1)
        b = call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1)
        assert self.check("pv-fassung-overall", [a])["gold_covered"] is False
        assert self.check("pv-fassung-overall", [a, b])["gold_covered"] is True

    def test_a_skip_control_fails_when_it_looks(self):
        assert self.check("pv-skip-author", []) == {"must_not:look": True}
        assert self.check("pv-skip-author", [call("canvas__look", document="Schnitt")]) == {"must_not:look": False}

    def test_with_looking_off_a_look_is_not_asked_but_a_skip_still_is(self):
        assert self.check("pv-dim-wohnen", [], look_on=False) == {}
        assert self.check("pv-skip-author", [call("look", document="x")], look_on=False) == {"must_not:look": False}


@dataclass
class FakeRun:
    question_id: str
    tool_args: list[dict]
    checks: dict[str, bool]
    envelope: dict | None = None
    error: str = ""
    research_calls: int = 2
    input_tokens: int = 1000
    output_tokens: int = 100
    reasoning_tokens: int = 0
    wall_s: float = 10.0
    signals: list[str] = field(default_factory=list)


class TestParity:
    def test_not_applicable_until_the_card_and_the_step_exist(self):
        assert visual_eval.look_parity(2, [], available=False) == {"card": None, "step": None}

    def test_declared_models_make_it_applicable(self, tmp_path, monkeypatch):
        cards, wire = tmp_path / "models.py", tmp_path / "wire.py"
        cards.write_text('    type: Literal["look"] = "look"\n', encoding="utf-8")
        wire.write_text('    kind: Literal["tool"] = "tool"\n', encoding="utf-8")
        monkeypatch.setattr(visual_eval, "CARD_MODELS", cards)
        monkeypatch.setattr(visual_eval, "WIRE_MODELS", wire)
        assert visual_eval.parity_available() is False
        wire.write_text('    kind: Literal["look"] = "look"\n', encoding="utf-8")
        assert visual_eval.parity_available() is True

    def test_every_look_needs_a_card_item_once_available(self):
        cards = [{"type": "look", "items": [{}, {}]}, {"type": "surface"}]
        assert look_parity_card(2, cards) is True
        assert look_parity_card(3, cards) is False
        assert look_parity_card(1, []) is False


def look_parity_card(n: int, cards: list) -> bool | None:
    return visual_eval.look_parity(n, cards, available=True)["card"]


class TestTheReport:
    def runs(self) -> list[FakeRun]:
        looked = [call("look", document="EP-01_Grundrisse_Index-B.pdf", page=1, region=[0.0, 0.4, 0.2, 0.15])]
        return [
            FakeRun("pv-dim-wohnen", looked, {"must:look": True, "gold_covered": True}),
            FakeRun("pv-dim-wohnen", [], {"must:look": False, "gold_covered": False}),
            FakeRun("pv-skip-author", [call("canvas__look", document="Schnitt")], {"must_not:look": False}),
            FakeRun("pv-skip-listing", [], {"must_not:look": True}),
            FakeRun("pv-dim-bad", [], {}, error="timed out"),
        ]

    def test_the_totals_and_the_table(self, monkeypatch):
        # The table's parity column is pinned to the before-V3 shape; the parity tests cover the after.
        monkeypatch.setattr(visual_eval, "parity_available", lambda: False)
        text = "\n".join(visual_eval.report_lines(self.runs(), {"look": "on"}))
        assert "looking: on" in text
        assert "runs where every check held: 2/4 (50%)" in text
        assert "looks per run: median 0.5, mean 0.50, runs that looked 2/4" in text
        assert "skip controls that looked anyway: 1 of 2 run(s)" in text
        assert "| pv-dim-wohnen | dimension | 1/2 | 0.5 | 0.03 | 1/2 | n/a |" in text
        assert "pv-dim-bad" not in text
        assert "n/a (the look card and step arrive with V3)" in text or "see the table" in text

    def test_no_run_finished(self):
        assert "No run finished." in visual_eval.report_lines([FakeRun("pv-dim-bad", [], {}, error="x")])


class TestTheSuiteWiring:
    def test_visual_is_a_set_and_look_is_only_for_it(self, capsys):
        with pytest.raises(SystemExit):
            suite.main(["--set", "files", "--look", "off"])
        assert "--look is for --set visual" in capsys.readouterr().err

    def test_the_rows_load_through_the_suite(self):
        assert [q["id"] for q in suite._visual_questions()] == [r["id"] for r in ROWS]

    def test_the_fixture_bff_serves_the_lookup_and_the_bytes(self, tmp_path):
        import http.client
        import json
        import urllib.parse
        import urllib.request

        from fixture_bff import FixtureBFF

        workspace = fixture_visual.VisualWorkspace({"EP-02_Schnitt_A-A.pdf": b"%PDF-fixture"})
        bff = FixtureBFF("t0ken", tmp_path / "requests.jsonl", workspace=workspace).start()
        try:
            query = urllib.parse.urlencode(
                {"collection": fixture_visual.COLLECTION, "filename": "EP-02_Schnitt_A-A.pdf"}
            )
            request = urllib.request.Request(
                f"{bff.url}/api/internal/document-file?{query}", headers={"X-Grid-Internal-Token": "t0ken"}
            )
            located = json.loads(urllib.request.urlopen(request).read())  # noqa: S310 - loopback
            assert located["storageBucket"] == fixture_visual.BUCKET
            body = urllib.request.urlopen(f"{bff.url}/{located['storageBucket']}/{located['storageKey']}").read()  # noqa: S310
            assert body == b"%PDF-fixture"
            with pytest.raises((OSError, http.client.HTTPException)):
                urllib.request.urlopen(f"{bff.url}/{fixture_visual.BUCKET}/drawings/missing.pdf")  # noqa: S310
        finally:
            bff.stop()

    def test_look_off_sets_the_env_the_tool_reads(self):
        workspace = fixture_visual.VisualWorkspace({})
        assert workspace.env("http://x", look=False)["GRID_VIEW_IMAGES_ENABLED"] == "0"
        assert workspace.env("http://x", look=True)["GRID_VIEW_IMAGES_ENABLED"] == "1"
