"""Counts of the literal search on chunks cut the way ingestion cuts them: one place in the document, one match.

The office-file eval's fixture used to seed one chunk per page, with no overlap and no breadcrumb,
and every count looked right on it. These tests cut the same documents with the REAL chunkers
(``adapter.text_chunks_for_pages``, through ``fixture_files.chunk_specs``, and ``clause_documents``)
and run the REAL ``qdrant.retrieval.find_text`` over them in memory, so the two ways a stored chunk
holds text twice are in the data:

* the overlap: a word in the 96-token overlap of a section is in two chunks;
* the breadcrumb: a section's heading is restated at the head of every chunk of the section, and
  of its subsections, and a Punkt chunk opens with the Richtlinie's label and its ancestors.

Each count below was wrong before ``chunk_positions`` (the number it was is in the test).
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer.browse import group_matches
from knowledge_layer.browse import match_snippets
from knowledge_layer.browse import phrase_pattern
from knowledge_layer.chunk_positions import own_texts
from knowledge_layer.chunk_positions import split_prefix
from knowledge_layer.qdrant import retrieval
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from agent.common.source_kinds import Shelf
from agent.knowledge.inventory import set_turn_documents
from agent.knowledge.schema import AvailableDocument
from agent.knowledge.schema import Chunk
from agent.knowledge.schema import ContentType
from agent.knowledge.scoping import ScopedCollection

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import fixture_files  # noqa: E402

COLLECTION = "proj_1"
PROJECT = fixture_files.load_project()
PROTOCOL = "Besprechungsprotokoll_Tragwerk_2026-04-28.pdf"
REPORT = "Brandschutzkonzept_Hubergasse14.pdf"


def _as_chunks(name: str) -> list[Chunk]:
    """The fixture file's chunks as the adapter hands them to the search: text, metadata, ordinal."""
    file = next(f for f in PROJECT.files if f.name == name)
    chunks = []
    for spec in fixture_files.chunk_specs(PROJECT, file):
        metadata = {**spec["metadata"], "collection": COLLECTION, "chunk_ordinal": spec["ordinal"]}
        page = int(metadata["page_label"])
        chunks.append(
            Chunk(
                chunk_id=spec["chunk_id"],
                content=spec["text"],
                score=1.0,
                file_name=name,
                page_number=page,
                display_citation=f"{name}, p.{page}",
                content_type=ContentType.TEXT,
                metadata=metadata,
            )
        )
    return chunks


def _clause_chunks() -> list[Chunk]:
    """A small Richtlinie through ``clause_documents``, the OIB corpus's chunker."""
    from knowledge_layer.llamaindex.clause_chunking import clause_documents

    pages = [
        "OIB-Richtlinie 2\nBrandschutz\n",
        "1 Begriffsbestimmungen gelten sinngemaess fuer diese Richtlinie.\n"
        "2 Allgemeine Anforderungen an das Brandverhalten von Bauprodukten.\n"
        "2.1 Bauprodukte muessen den Anforderungen der Tabelle 1a entsprechen.\n"
        "2.2 Die Bauteile muessen den erforderlichen Anforderungen genuegen.\n",
        "2.3 Oeffnungen in brandabschnittsbildenden Bauteilen sind zulaessig.\n"
        "3 Flucht- und Rettungswege muessen ins Freie fuehren.\n"
        "3.1 Die nutzbare Breite von Fluchtwegen muss mindestens 1,20 m betragen.\n",
    ]
    name = "oib-rl_2_ausgabe_mai_2023.pdf"
    documents = clause_documents([{"page_number": n, "text": t} for n, t in enumerate(pages, 1)], name, 1)
    return [
        Chunk(
            chunk_id=f"c{ordinal}",
            content=document.text,
            score=1.0,
            file_name=name,
            page_number=int(document.metadata["page_label"]),
            display_citation=name,
            content_type=ContentType.TEXT,
            metadata={**document.metadata, "collection": COLLECTION, "chunk_ordinal": ordinal},
        )
        for ordinal, document in enumerate(documents)
    ]


def _legacy(content: str, *, page: int, chunk_id: str) -> Chunk:
    """A point written before ``chunk_ordinal`` existed: per-page splitter output, no ordinal."""
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=1.0,
        file_name="Altbestand.pdf",
        page_number=page,
        display_citation="Altbestand.pdf",
        content_type=ContentType.TEXT,
        metadata={"page_label": str(page), "collection": COLLECTION},
    )


def _counts(chunks: list[Chunk], phrase: str) -> list[tuple[str, int, list[int]]]:
    return [(g.file_name, g.occurrences, g.pages) for g in group_matches(chunks, phrase_pattern([phrase]))]


class TestTheFixtureHoldsTextTwice:
    """The premise: without these, the counts below would pass on develop too."""

    def test_the_protocol_has_a_section_cut_in_two_with_an_overlap(self):
        parts = [c for c in _as_chunks(PROTOCOL) if c.metadata.get("clause_id") == "3"]
        assert [c.metadata["section_part"] for c in parts] == [1, 2]
        assert sum("Kopfbolzendübeln" in c.content for c in parts) == 2
        assert all(c.content.startswith("3 Holz-Beton-Verbunddecke\n\n") for c in parts)

    def test_the_report_restates_its_chapter_heading_in_every_subsection(self):
        chapter = [c for c in _as_chunks(REPORT) if str(c.metadata.get("clause_path", "")).startswith("3 Rettungswege")]
        assert len(chapter) == 4
        assert all("Rettungswege" in c.content for c in chapter)


class TestOnePlaceOneMatch:
    def test_a_word_in_the_overlap_counts_once(self):
        # develop: 2×, p. 2 (part 1 and part 2 both hold the sentence).
        assert _counts(_as_chunks(PROTOCOL), "Kopfbolzendübel") == [(PROTOCOL, 1, [2])]

    def test_a_heading_word_counts_once_where_the_heading_stands(self):
        # develop: 3×, p. 2, 3 (both parts and the subsection's breadcrumb).
        assert _counts(_as_chunks(PROTOCOL), "Verbunddecke") == [(PROTOCOL, 1, [2])]

    def test_a_chapter_heading_is_not_counted_in_its_subsections(self):
        # develop: 8×, p. 3, 7, 8, 9. The text says it on pages 3 (heading 2.1 and twice in the body),
        # 7 (the chapter heading) and 9 (the Aufzug body).
        assert _counts(_as_chunks(REPORT), "Rettungsweg") == [(REPORT, 5, [3, 7, 9])]

    def test_the_count_of_the_planted_word_is_unchanged(self):
        assert _counts(_as_chunks(REPORT), "Fluchtweg") == [(REPORT, 3, [3, 7, 11])]

    def test_a_clause_counts_the_guideline_label_and_its_ancestors_never(self):
        # develop: 4× (Punkt 2 and the ancestor line of 2.1, 2.2, 2.3).
        assert _counts(_clause_chunks(), "Bauprodukten") == [("oib-rl_2_ausgabe_mai_2023.pdf", 1, [2])]
        # The label line „oib-rl_2…“ heads every Punkt; it is the pipeline's, not the Richtlinie's text.
        assert _counts(_clause_chunks(), "ausgabe_mai") == []

    def test_a_chunk_whose_only_match_is_the_overlap_is_no_passage(self):
        [group] = group_matches(_as_chunks(PROTOCOL), phrase_pattern(["Kopfbolzendübel"]))
        assert [c.metadata["section_part"] for c in group.chunks] == [1]

    def test_the_lines_around_a_match_show_it_once_and_never_the_breadcrumb(self):
        pattern = re.compile(phrase_pattern(["Kopfbolzendübel"]))
        groups = group_matches(_as_chunks(PROTOCOL), pattern)
        lines = match_snippets(groups, pattern, 0)
        assert lines.count("> Die Schubverbindung") == 1
        heading = match_snippets(
            group_matches(_as_chunks(PROTOCOL), phrase_pattern(["Verbunddecke"])),
            re.compile(phrase_pattern(["Verbunddecke"])),
            1,
        )
        assert heading.count("> 3 Holz-Beton-Verbunddecke") == 1
        assert "›" not in heading

    def test_a_stemmed_hit_in_the_breadcrumb_alone_is_not_kept(self):
        # The stemmed index matched the breadcrumb; the counting pattern finds it there and nowhere else.
        returned = [c for c in _as_chunks(PROTOCOL) if "Verbunddecke" in c.content]
        assert len(returned) == 3
        groups = group_matches(returned, phrase_pattern(["Verbunddecke"]), store_decides=True)
        assert [(g.occurrences, [c.metadata.get("section_part") for c in g.chunks]) for g in groups] == [(1, [1])]


class TestLegacyPointsWithoutAnOrdinal:
    HEAD = "Die Brandmeldeanlage wird im Stiegenhaus an jedem Podest mit einem Druckknopfmelder ergänzt."

    def test_two_chunks_of_one_page_whose_head_repeats_the_other_tail_count_the_overlap_once(self):
        first = _legacy(f"Erster Absatz über die Anlage.\n{self.HEAD}", page=4, chunk_id="b")
        second = _legacy(f"{self.HEAD}\nZweiter Absatz ohne das Wort.", page=4, chunk_id="a")
        assert _counts([second, first], "Druckknopfmelder") == [("Altbestand.pdf", 1, [4])]

    def test_chunks_on_different_pages_are_never_one_overlap(self):
        first = _legacy(f"Erster Absatz.\n{self.HEAD}", page=4, chunk_id="b")
        second = _legacy(f"{self.HEAD}\nWeiter.", page=5, chunk_id="a")
        assert _counts([first, second], "Druckknopfmelder") == [("Altbestand.pdf", 2, [4, 5])]

    def test_past_its_bound_a_page_is_not_compared_pairwise_and_counts_as_stored(self):
        from knowledge_layer.chunk_positions import MAX_LEGACY_PAGE_CHUNKS

        first = _legacy(f"Erster Absatz.\n{self.HEAD}", page=4, chunk_id="b")
        second = _legacy(f"{self.HEAD}\nWeiter.", page=4, chunk_id="a")
        filler = [
            _legacy(f"Druckknopfmelder Nummer {n}.", page=4, chunk_id=f"f{n}") for n in range(MAX_LEGACY_PAGE_CHUNKS)
        ]
        assert _counts([first, second, *filler], "Druckknopfmelder")[0][1] == 2 + MAX_LEGACY_PAGE_CHUNKS

    def test_a_lone_legacy_chunk_counts_as_stored(self):
        assert _counts([_legacy(self.HEAD, page=1, chunk_id="x")], "Druckknopfmelder") == [("Altbestand.pdf", 1, [1])]


class TestThePrefixIsCutOnlyWhereTheChunkerWroteIt:
    def test_a_section_chunk_the_splitter_cut_again_keeps_its_text(self):
        chunk = _legacy("Fortsetzung ohne Breadcrumb", page=1, chunk_id="x")
        chunk.metadata.update({"chunking": "section", "clause_path": "3 Decke", "section_part": 2})
        assert split_prefix(chunk) == (0, "")

    def test_a_marker_is_the_pipelines_word(self):
        chunk = _legacy("[TABLE from page 3]\n\n| Raum | Fläche |", page=3, chunk_id="t")
        start, heading = split_prefix(chunk)
        assert chunk.content[start:] == "| Raum | Fläche |" and heading == ""

    def test_a_table_caption_counts_on_its_first_part_only(self):
        rows = "| Bauteil | REI |\n| --- | --- |\n| Decke | 60 |"
        parts = []
        for part, suffix in ((1, ""), (2, " (Teil 2 von 2)")):
            chunk = _legacy(f"Tabelle 2: Feuerwiderstand der Decken{suffix}\n\n{rows}", page=part, chunk_id=f"t{part}")
            chunk.metadata.update(
                {"chunking": "table", "clause_path": "Tabelle 2: Feuerwiderstand der Decken", "table_part": part}
            )
            chunk.content_type = ContentType.TABLE
            parts.append(chunk)
        assert [own.text.split("\n")[0] for own in own_texts(parts)] == [
            "Tabelle 2: Feuerwiderstand der Decken",
            "| Bauteil | REI |",
        ]
        assert _counts(parts, "Feuerwiderstand") == [("Altbestand.pdf", 1, [1])]


# ---------------------------------------------------------------------------
# Through the tool: the table, the distinct strings and the Herleitung row
# ---------------------------------------------------------------------------


class _Store:
    """``find_text`` runs the real scan (``qdrant.retrieval.find_text``) over in-memory points."""

    def __init__(self, points: list[Chunk]):
        self.points = points

    async def find_text(self, collection_name, pattern, filters=None, limit=500, user_regex=False):
        records = [
            SimpleNamespace(
                id=c.chunk_id, payload={"text": c.content, "chunk_id": c.chunk_id, "file_name": c.file_name}
            )
            for c in self.points
            if c.metadata["collection"] == collection_name
        ]
        fake = SimpleNamespace(scroll=lambda scope, flt, *extra: iter(records), text_index_sound=lambda scope: True)
        original = retrieval.get_store
        retrieval.get_store = lambda *a, **k: fake
        try:
            hits = retrieval.find_text(collection_name, pattern, filters, limit, user_regex=user_regex)
        finally:
            retrieval.get_store = original
        by_id = {c.chunk_id: c for c in self.points}
        return [by_id[hit.chunk_id].model_copy(deep=True) for hit in hits]

    async def candidate_counts(self, *args, **kwargs):
        return None

    async def retrieve(self, *args, **kwargs):  # pragma: no cover - the literal modes never rank
        raise AssertionError("a literal search must not run the ranked search")


@pytest.fixture
def search_with(monkeypatch):
    monkeypatch.setattr(
        "agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(COLLECTION, Shelf.PROJECT)],
    )
    monkeypatch.setattr("agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"agent.knowledge.factory.{name}", lambda _c, _f: {})
    set_turn_documents(
        [
            AvailableDocument(file_name=name, collection=COLLECTION, shelf="project", summary="x")
            for name in (PROTOCOL, REPORT)
        ]
    )

    def install(retriever):
        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        return retriever

    yield install
    set_turn_documents(None)


async def _search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=False)
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestThroughTheTool:
    async def test_the_table_states_the_true_count_and_pages(self, search_with):
        search_with(_Store([*_as_chunks(PROTOCOL), *_as_chunks(REPORT)]))
        text = await _search(query="Rettungsweg", match="exact", context=0)
        assert "5 occurrence(s) in 1 file(s)" in text
        assert f"- {REPORT} (Projektwissen): 5×, p. 3, 7, 9" in text
        snippets = text[text.index("## Lines around the matches") :]
        assert "›" not in snippets
        assert snippets.count("> 3 Rettungswege und Aufzug") == 1

    async def test_a_regex_counts_each_distinct_string_once_per_place(self, search_with):
        search_with(_Store(_as_chunks(PROTOCOL)))
        text = await _search(query=r"\bKopfbolzend\w+", match="regex", file_name=PROTOCOL)
        assert f"- {PROTOCOL} (Projektwissen): 1×, p. 2" in text
        assert "- `Kopfbolzendübeln`: 1× in" in text

    async def test_a_capped_scan_that_read_only_breadcrumbs_is_not_a_no(self, search_with, monkeypatch):
        # Not reachable before the count read only a chunk's own text: then every capped scan had a match.
        from knowledge_layer import browse

        monkeypatch.setattr(browse, "MAX_MATCH_CHUNKS", 2)
        subsections = [c for c in _as_chunks(REPORT) if c.metadata.get("clause_id") in ("3.1", "3.2")]
        search_with(_Store(subsections))
        text = await _search(query="Rettungswege", match="exact")
        assert "NOT a no" in text and "No match" not in text


def test_the_adapter_hands_the_search_each_chunks_place_in_its_file(monkeypatch):
    """``chunk_ordinal`` is store-only metadata; without it on the hit no overlap could be found."""
    from knowledge_layer.llamaindex.retriever import LlamaIndexRetriever
    from knowledge_layer.qdrant import retrieval as adapter_retrieval
    from knowledge_layer.qdrant.search import Hit

    payload = {"text": "x", "chunk_id": "a", "file_name": "a.pdf", "page_label": "2", "chunk_ordinal": 7}
    monkeypatch.setattr(adapter_retrieval, "find_text", lambda *a, **k: [Hit("a", "x", payload, 0.0, 1.0)])
    retriever = LlamaIndexRetriever.__new__(LlamaIndexRetriever)

    [chunk] = retriever._find_text_sync("proj_1", "x", None, 5)

    assert chunk.metadata["chunk_ordinal"] == 7
