"""``grep`` on the estate: two stages, citable content, and never a silent no (ADR-0133 slice 4).

The candidates come from the files fixture's Brandschutzkonzept cut by the real section chunker
(overlap and breadcrumbs, ``fixture_files.chunk_specs``), so the counts are checked against text
held twice as production holds it. What is pinned:

* a count counts each place in the document once, on the chunks' own text, and on the stored
  page text when the document has it (which then decides);
* ``content`` returns the matching pages as grounding blocks citing ``file, p.N`` with a ``Path:``,
  the records collected for the call's artifact;
* a collection whose scan failed, or a regex scan that ran out of time, makes the result
  ``incomplete``, and an incomplete search never says "no match";
* a path narrows to its mount and folder, and a restricted folder's path answers as a folder that
  does not exist; the Herleitung row is ``search`` with its mode.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from aiq_agent.common import turn_status
from aiq_agent.common.citation_collector import collect_citations
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src import stored_pages
from sources.knowledge_layer.src.browse import FileRow
from sources.knowledge_layer.src.estate import EstateBackend
from sources.knowledge_layer.src.estate_grep import GrepRefused
from sources.knowledge_layer.src.estate_grep import compile_query
from sources.knowledge_layer.src.qdrant.retrieval import PatternTooCostly

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "scripts" / "turn_census"))

import fixture_files  # noqa: E402

PROJECT = fixture_files.load_project()
REPORT = "Brandschutzkonzept_Hubergasse14.pdf"
COLLECTION = "proj_1"
OFFICE = "office_shelf_org"


def _chunks(name: str = REPORT) -> list[Chunk]:
    file = next(f for f in PROJECT.files if f.name == name)
    out = []
    for spec in fixture_files.chunk_specs(PROJECT, file):
        metadata = {**spec["metadata"], "chunk_ordinal": spec["ordinal"]}
        page = int(metadata["page_label"])
        out.append(
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
    return out


def _report_row() -> FileRow:
    file = next(f for f in PROJECT.files if f.name == REPORT)
    return FileRow(file_name=REPORT, shelf="project", collection=COLLECTION, folder=file.folder or "")


class Retriever:
    """``find_text`` as the store answers it: every chunk the pattern finds, per collection."""

    def __init__(self, by_collection: dict, fail: set[str] = frozenset(), deadline: set[str] = frozenset()):
        self.by_collection = by_collection
        self.fail = fail
        self.deadline = deadline
        self.asked: list[str] = []

    async def find_text(self, collection, pattern, *, filters=None, limit=500, user_regex=False, stem_phrases=None):
        self.asked.append(collection)
        if collection in self.fail:
            raise RuntimeError("store down")
        if collection in self.deadline:
            raise PatternTooCostly(pattern, scan=True)
        compiled = re.compile(pattern, re.IGNORECASE) if user_regex else re.compile(pattern)
        return [
            chunk.model_copy(deep=True)
            for chunk in self.by_collection.get(collection, [])
            if compiled.search(chunk.content)
        ][:limit]


def _backend(retriever: Retriever, rows=None, stored=None) -> EstateBackend:
    rows = (
        rows
        if rows is not None
        else [
            _report_row(),
            FileRow(file_name="Vorlage.docx", shelf="office_shelf", collection=OFFICE, folder="Vorlagen"),
        ]
    )

    async def listable():
        return list(rows)

    async def none():
        return []

    backend = EstateBackend(SimpleNamespace(), rows_loader=listable, restricted_loader=none, retriever=retriever)
    backend.entries = lambda: [ScopedCollection(COLLECTION, "project"), ScopedCollection(OFFICE, "office_shelf")]
    backend._restricted_search_loader = none

    async def reader(collection, file_name, *, wanted=None):
        return stored(collection, file_name) if stored else None

    backend._stored_reader = reader
    return backend


@pytest.fixture(autouse=True)
def _setup(monkeypatch):
    from sources.knowledge_layer.src import browse

    monkeypatch.setattr(browse, "_collection_filter", lambda collection, **_kwargs: None)
    monkeypatch.setattr(
        "sources.knowledge_layer.src.register._resolve_base_collection", lambda _config: "oib_knowledge"
    )
    token = begin_grounding_capture()
    try:
        yield
    finally:
        end_grounding_capture(token)


def _occurrences_in_pages(word: str) -> int:
    file = next(f for f in PROJECT.files if f.name == REPORT)
    return sum(len(re.findall(word, page, re.IGNORECASE)) for page in file.pages)


class TestCounts:
    async def test_a_count_is_each_place_once(self) -> None:
        retriever = Retriever({COLLECTION: _chunks()})
        result = await _backend(retriever).grep("Fluchtweg")
        expected = _occurrences_in_pages("Fluchtweg")
        assert expected > 0
        assert f"{expected} occurrence" in result.text
        assert "Brandschutzkonzept_Hubergasse14.pdf.md:" in result.text and "p." in result.text
        assert "files searched" in result.text and "hyphenation folded" in result.text
        assert "Citation:" not in result.text, "files_with_matches is an index"

    async def test_the_stored_page_text_decides_when_there_is_some(self) -> None:
        def stored(collection, file_name):
            page = stored_pages.Page(number=3, text="Der Fluchtweg führt ins Freie.")
            return stored_pages.PageText(pages=[page], origin="stored", page_count=14)

        result = await _backend(Retriever({COLLECTION: _chunks()}), stored=stored).grep("Fluchtweg")
        assert "1 occurrence in 1 file" in result.text and "1× p.3" in result.text

    async def test_count_mode_and_a_complete_no(self) -> None:
        backend = _backend(Retriever({COLLECTION: _chunks()}))
        counted = await backend.grep("Fluchtweg", output_mode="count")
        assert re.search(r"Brandschutzkonzept_Hubergasse14\.pdf\.md: \d+$", counted.text, re.MULTILINE)
        missing = await backend.grep("Sprinklerzentrale")
        assert missing.text.startswith('No match for "Sprinklerzentrale" in 2 files of every place.')
        assert "A solid no for the WORDING" in missing.text


class TestContent:
    async def test_content_is_citable_pages_with_their_path(self) -> None:
        with collect_citations() as collected:
            result = await _backend(Retriever({COLLECTION: _chunks()})).grep(
                "Fluchtweg", output_mode="content", context=1
            )
        assert result.hits and all(hit.citation_key.startswith(f"{REPORT}, p.") for hit in result.hits)
        assert all(hit.path and hit.path.endswith(f"{REPORT}.md") for hit in result.hits)
        assert "Path: /project/" in result.text
        assert "## Lines around the matches" in result.text and "#page=" in result.text
        assert [hit.citation_key for hit in collected] == [hit.citation_key for hit in result.hits]
        assert len({hit.page for hit in result.hits}) == len(result.hits), "one block per page"


class TestNeverASilentNo:
    async def test_a_failed_collection_makes_it_incomplete_not_no(self) -> None:
        retriever = Retriever({COLLECTION: _chunks()}, fail={OFFICE})
        result = await _backend(retriever).grep("Sprinklerzentrale")
        assert "No match" in result.text and "in what could be searched" in result.text
        assert "incomplete: /office not searched (the store did not answer)." in result.text
        assert "NOT a no" in result.text
        assert "A solid no" not in result.text

    async def test_a_regex_scan_that_ran_out_of_time_is_named(self) -> None:
        retriever = Retriever({COLLECTION: _chunks()}, deadline={OFFICE})
        result = await _backend(retriever).grep(r"Flucht\w+", mode="regex")
        assert "INCOMPLETE" in result.text and "incomplete: /office not searched to the end" in result.text

    async def test_every_store_down_is_an_error_and_says_nothing_was_searched(self) -> None:
        retriever = Retriever({}, fail={COLLECTION, OFFICE})
        result = await _backend(retriever).grep("Fluchtweg")
        assert result.status == "error" and "NOT a no" in result.text


class TestScope:
    async def test_a_path_asks_only_its_mount(self) -> None:
        retriever = Retriever({COLLECTION: _chunks()})
        await _backend(retriever).grep("Fluchtweg", path="/office/")
        assert retriever.asked == [OFFICE]

    async def test_a_restricted_folder_reads_as_a_folder_that_does_not_exist(self) -> None:
        backend = _backend(Retriever({COLLECTION: _chunks()}))
        secret = FileRow(file_name="Vertrag.pdf", shelf="project", collection="proj_1_r0123456789ab", folder="Personal")

        async def restricted():
            return [secret]

        backend._restricted_search_loader = restricted
        hidden = await backend.grep("Gehalt", path="/project/Personal/")
        absent = await backend.grep("Gehalt", path="/project/Persona/")
        assert hidden.text.replace("Personal", "X") == absent.text.replace("Persona", "X")

    async def test_the_action_row_is_a_search_with_its_mode(self, monkeypatch) -> None:
        emitted = []
        monkeypatch.setattr(turn_status, "emit_step", lambda step, started=False: emitted.append(step))
        await _backend(Retriever({COLLECTION: _chunks()})).grep(r"Flucht\w+", mode="regex")
        settled = [step for step in emitted if step.kind == "action" and step.status != "running"]
        assert settled and settled[-1].verb == "search" and settled[-1].mode == "regex"
        assert settled[-1].counts.hits and settled[-1].counts.searched == 2


class TestThePattern:
    def test_exact_folds_and_a_short_one_is_a_whole_word(self) -> None:
        assert compile_query("Brandabschnitt 3", "exact", False).compiled.search("BRANDABSCHNITT\n3")
        short = compile_query("EG", "exact", False).compiled
        assert short.search("im EG links") and not short.search("Steg")
        assert compile_query("Strasse", "exact", False).compiled.search("Straße")

    @pytest.mark.parametrize("pattern, mode", [("x", "exact"), ("(", "regex"), ("a*", "regex"), ("Flucht", "meaning")])
    def test_what_cannot_run_is_refused_with_the_rule(self, pattern: str, mode: str) -> None:
        with pytest.raises(GrepRefused):
            compile_query(pattern, mode, False)
