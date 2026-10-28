"""What a card is built from, and the hash that says whether it must be built again."""

from __future__ import annotations

import pytest
from knowledge_layer.browse import file_rows

from aiq_agent.knowledge.folder_cards.inputs import PROMPT_VERSION
from aiq_agent.knowledge.folder_cards.inputs import folder_inputs
from aiq_agent.knowledge.folder_cards.inputs import input_hash


def _row(name, folder, summary="Ein Dokument.", **extra):
    return {"file_name": name, "folder_path": folder, "collection": "proj", "summary": summary, **extra}


ROWS = [
    _row("BS-Gutachten.pdf", "Gutachten", "Brandschutzgutachten für das Wohnhaus.", doc_class="report"),
    _row("Statik.pdf", "Gutachten", "Statische Vorbemessung.", page_count=12),
    _row("Schall.pdf", "Gutachten", "Schallschutznachweis."),
    _row("Bescheid.pdf", "Gutachten/Behörde", "Bescheid der Baubehörde."),
    _row("Grundriss EG.pdf", "Pläne", "Grundriss Erdgeschoß."),
]


def _inputs(rows=ROWS, cards=None, path="Gutachten"):
    return folder_inputs("proj", path, file_rows(rows), cards or {})


class TestInputs:
    def test_direct_documents_and_child_folders_one_level_down(self):
        inputs = _inputs()

        assert [d.file_name for d in inputs.documents] == ["BS-Gutachten.pdf", "Schall.pdf", "Statik.pdf"]
        assert [(f.name, f.documents) for f in inputs.folders] == [("Behörde", ("Bescheid.pdf",))]
        assert inputs.depth == 1
        assert "Pläne" not in str(inputs)

    def test_a_child_with_a_card_stands_for_itself_by_its_abstract(self):
        cards = {"Gutachten/Behörde": {"abstract": "Bescheide der Behörde.", "abstract_hash": "h1"}}

        (child,) = _inputs(cards=cards).folders

        assert (child.abstract, child.abstract_hash, child.documents) == ("Bescheide der Behörde.", "h1", ())

    def test_the_persons_description_is_an_input(self):
        cards = {"Gutachten": {"folder_description": "  Alle   Gutachten  "}}

        assert _inputs(cards=cards).description == "Alle Gutachten"

    def test_tiny_and_empty(self):
        assert _inputs(path="Pläne").tiny
        assert _inputs(path="Leer").empty
        assert not _inputs().tiny


class TestInputHash:
    def test_stable_under_row_order(self):
        assert input_hash(_inputs()) == input_hash(_inputs(list(reversed(ROWS))))

    def test_a_child_summary_changes_it(self):
        changed = [*ROWS[:2], _row("Schall.pdf", "Gutachten", "Schallschutz, überarbeitet."), *ROWS[3:]]

        assert input_hash(_inputs()) != input_hash(_inputs(changed))

    def test_a_child_cards_abstract_hash_changes_it_and_its_text_alone_does_not(self):
        card = {"abstract": "Bescheide.", "abstract_hash": "h1"}
        same_hash = {"abstract": "Bescheide, anders formuliert.", "abstract_hash": "h1"}
        other_hash = {"abstract": "Bescheide.", "abstract_hash": "h2"}

        base = input_hash(_inputs(cards={"Gutachten/Behörde": card}))

        assert input_hash(_inputs(cards={"Gutachten/Behörde": same_hash})) == base
        assert input_hash(_inputs(cards={"Gutachten/Behörde": other_hash})) != base

    @pytest.mark.parametrize("extra", [{"page_count": 40}, {"added_at": "2026-10-21"}])
    def test_counts_and_dates_do_not_change_it(self, extra):
        changed = [{**ROWS[0], **extra}, *ROWS[1:]]

        assert input_hash(_inputs()) == input_hash(_inputs(changed))

    def test_a_new_document_in_a_carded_subfolder_does_not_reach_the_parent(self):
        cards = {"Gutachten/Behörde": {"abstract": "Bescheide.", "abstract_hash": "h1"}}
        more = [*ROWS, _row("Bescheid 2.pdf", "Gutachten/Behörde")]

        assert input_hash(_inputs(cards=cards)) == input_hash(_inputs(more, cards=cards))

    def test_the_prompt_version_is_part_of_it(self, monkeypatch):
        from aiq_agent.knowledge.folder_cards import inputs as module

        before = input_hash(_inputs())
        monkeypatch.setattr(module, "PROMPT_VERSION", f"{PROMPT_VERSION}-next")

        assert input_hash(_inputs()) != before


def test_a_folder_without_a_card_still_reads_its_description():
    """The first build of a folder reads what a person wrote about it, before any card exists."""
    from aiq_agent.knowledge.folder_cards.inputs import folder_inputs

    inputs = folder_inputs("proj_a", "Gutachten", [], {}, {"Gutachten": "Alle   externen Gutachten"})
    assert inputs.description == "Alle externen Gutachten"
    assert folder_inputs("proj_a", "Gutachten", [], {}).description is None
