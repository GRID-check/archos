"""`list_files(view="tree")`: a card per folder, counted from the turn's rows alone (tier 0)."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import _LIST_FILES_DESCRIPTION
from sources.knowledge_layer.src.browse import MAX_TREE_CARDS
from sources.knowledge_layer.src.browse import ListFilesConfig
from sources.knowledge_layer.src.browse import file_rows
from sources.knowledge_layer.src.browse import folder_cards
from sources.knowledge_layer.src.browse import list_files
from sources.knowledge_layer.src.browse import render_listing
from sources.knowledge_layer.src.browse import render_tree
from sources.knowledge_layer.src.browse import select_files
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig


def _doc(name: str, folder: str | None = None, **extra) -> AvailableDocument:
    return AvailableDocument(file_name=name, folder_path=folder, collection="proj_1", shelf="project", **extra)


def _cards(docs, *, root=None, depth=2):
    return {card.path: card for card in folder_cards(file_rows(docs), root=root, depth=depth)}


def test_counts_separate_direct_from_subtree_and_the_cards_come_parents_first():
    cards = folder_cards(
        file_rows([_doc("a.pdf", "E"), _doc("b.pdf", "E/P"), _doc("c.pdf", "E/P"), _doc("d.pdf")]), root=None, depth=2
    )
    assert [card.path for card in cards] == ["", "E", "E/P"]
    top, einreichung, plans = cards
    assert (top.total, top.direct) == (4, 1)
    assert (einreichung.total, einreichung.direct, einreichung.subfolders) == (3, 1, (("E/P", 2),))
    assert (plans.total, plans.direct, plans.depth) == (2, 2, 2)


def test_depth_bounds_the_cards_but_not_the_counts():
    cards = _cards([_doc("a.pdf", "A/B/C/D")], depth=1)
    assert set(cards) == {"", "A"}
    assert cards["A"].total == 1 and cards["A"].subfolders == (("A/B", 1),)


def test_a_root_folder_makes_it_card_zero():
    cards = _cards([_doc("a.pdf", "A/B"), _doc("b.pdf", "A")], root="A", depth=1)
    assert set(cards) == {"A", "A/B"} and cards["A"].depth == 0 and cards["A/B"].depth == 1


def test_types_untyped_and_pages_with_unknowns():
    cards = _cards(
        [
            _doc("a.pdf", "E", tags=["Grundriss"], page_count=10),
            _doc("b.pdf", "E", tags=["Grundriss", "Brandschutz"], page_count=5),
            _doc("c.pdf", "E"),
        ]
    )
    card = cards["E"]
    assert card.types == (("Grundriss", 2),) and card.untyped == 1
    assert (card.pages, card.pages_unknown) == (15, 1)
    text = render_tree(list(cards.values()), total_rows=3)
    assert "3 documents (all here), 15 pages (1 without count)" in text
    assert "Dokumentart: Grundriss 2 · untyped 1" in text


def test_no_page_line_while_no_count_is_stored():
    text = render_tree(list(_cards([_doc("a.pdf", "E")]).values()), total_rows=1)
    assert "page" not in text


def test_dates_and_the_newest_document():
    card = _cards([_doc("a.pdf", "E", added_at="2026-05-04"), _doc("b.pdf", "E", added_at="2026-06-12T10:00:00")])["E"]
    assert (card.first_added, card.last_added) == ("2026-05-04", "2026-06-12")
    assert card.newest == "b.pdf (2026-06-12)"


def test_current_fassung_from_a_name_series():
    card = _cards([_doc("EP_Index-A.pdf", "E"), _doc("EP_Index-B.pdf", "E")])["E"]
    assert card.superseded == 1
    assert card.current == ("EP_Index-B.pdf (Index B; by file name) replaces EP_Index-A.pdf",)


def test_current_fassung_from_a_title_block_beats_the_name():
    facts_a = {"document_number": "A-101", "revision": "A", "revision_date": "2026-01-01"}
    facts_b = {"document_number": "A-101", "revision": "B", "revision_date": "2026-02-03"}
    card = _cards(
        [_doc("Plan neu.pdf", "E", revision_facts=facts_b), _doc("Plan alt.pdf", "E", revision_facts=facts_a)]
    )["E"]
    assert card.current == ("Plan neu.pdf (Index B, Stand 03.02.2026; by Plankopf) replaces Plan alt.pdf",)


def test_current_fassung_from_a_persons_confirmation():
    card = _cards([_doc("alt.pdf", "E", superseded_by="neu.pdf"), _doc("neu.pdf", "E")])["E"]
    assert card.current == ("neu.pdf (confirmed) replaces alt.pdf",)


def test_an_older_fassung_outside_the_selection_still_counts_when_series_rows_are_given():
    rows = file_rows([_doc("EP_Index-A.pdf", "alt"), _doc("EP_Index-B.pdf", "E")])
    inside = [row for row in rows if row.folder == "E"]
    card = {c.path: c for c in folder_cards(inside, root="E", depth=1, series_rows=rows)}["E"]
    assert card.current == ("EP_Index-B.pdf (Index B; by file name) replaces EP_Index-A.pdf",)


def test_the_tree_is_bounded_and_names_the_next_call():
    docs = [_doc(f"f{i}.pdf", f"F{i:02}") for i in range(MAX_TREE_CARDS + 5)]
    cards = folder_cards(file_rows(docs), root=None, depth=2)
    text = render_tree(cards, total_rows=len(docs))
    assert text.count("  1 document") == MAX_TREE_CARDS - 1  # the top card takes one slot
    assert "6 folders not shown" in text and 'view="tree"' in text
    assert "never cite it" in text


def test_a_card_names_at_most_three_current_fassungen():
    docs = [_doc(f"S{i}_Index-{x}.pdf", "E") for i in range(5) for x in "AB"]
    text = render_tree(list(_cards(docs).values()), total_rows=len(docs))
    assert text.count("Current Fassung:") == 6  # three on the top card, three on E
    assert "2 more documents with several Fassungen" in text


def test_an_empty_selection_says_so():
    listing = select_files(file_rows([_doc("a.pdf", "E")]), name_contains="nothing")
    assert "No file" in render_tree([], total_rows=0, notes=listing.notes)


def test_a_file_row_shows_its_page_count():
    text = render_listing(select_files(file_rows([_doc("a.pdf", page_count=3), _doc("b.pdf", page_count=1)])))
    assert "3 pages" in text and "1 page " in text.replace("1 page ·", "1 page ")


def test_the_description_teaches_the_tree_view():
    assert 'view="tree"' in _LIST_FILES_DESCRIPTION


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("proj_1", Shelf.PROJECT)],
    )
    monkeypatch.setattr("aiq_agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    yield
    set_turn_documents(None)


class TestTheTool:
    async def _call(self, **kwargs) -> str:
        builder = MagicMock()
        builder.get_function_config = MagicMock(return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge"))
        async with list_files(ListFilesConfig(), builder) as info:
            return await info.single_fn(info.input_schema(**kwargs))

    async def test_the_tree_view_answers_with_cards_not_file_lines(self, scope):
        set_turn_documents([_doc("a.pdf", "E"), _doc("b.pdf", "E/P")])
        text = await self._call(view="tree")
        assert "E/  2 documents" in text and "- a.pdf" not in text

    async def test_filters_and_folder_apply_and_a_restricted_collection_never_appears(self, scope):
        restricted = AvailableDocument(
            file_name="Gehalt.pdf", folder_path="E/P", collection="proj_1_r0123456789ab", shelf="project"
        )
        set_turn_documents([_doc("a.pdf", "E"), _doc("b.pdf", "E/P"), _doc("Plan_x.pdf", "E/P"), restricted])
        text = await self._call(view="tree", folder="e", name_contains="plan")
        assert "E/  1 document" in text and "E/P/  1 document" in text
        assert "2 documents" not in text and "Gehalt" not in text
        assert "Gehalt" not in await self._call(view="tree")

    async def test_an_unknown_view_is_refused(self, scope):
        set_turn_documents([_doc("a.pdf")])
        with pytest.raises(Exception):  # noqa: B017,PT011 - the Literal rejects it at the schema
            await self._call(view="forest")
