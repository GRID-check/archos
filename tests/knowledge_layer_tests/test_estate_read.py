"""``read_file`` on the estate: the backend, the stored page text and its fallback (ADR-0133, ADR-0134).

What is pinned:

* one backend instance serves every turn: the rows are the turn's, read per call;
* a restricted document's guessed path gets the very answer a path that does not exist gets, and
  resolves once this turn may name its collection (listing hides, reading admits);
* stored page text is read through the scoped lookup's storage key, and an ``index.json`` that
  names another document or version is refused; without one the pages are rebuilt from chunks;
* every block is one page, cites ``file, p.N``, states its ``Path:``, carries no line gutter, and
  the records ride the call's artifact.
"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from knowledge_layer import estate as estate_module
from knowledge_layer import stored_pages
from knowledge_layer.browse import FileRow
from knowledge_layer.estate import EstateBackend
from knowledge_layer.estate import PagesRefused
from knowledge_layer.estate import no_such_file
from knowledge_layer.estate import pages_for_lines
from knowledge_layer.estate import parse_pages
from knowledge_layer_testing.estate_read import BSK
from knowledge_layer_testing.estate_read import PAGES
from knowledge_layer_testing.estate_read import RESTRICTED
from knowledge_layer_testing.estate_read import SECRET
from knowledge_layer_testing.estate_read import TURN
from knowledge_layer_testing.estate_read import _backend
from knowledge_layer_testing.estate_read import _capture  # noqa: F401 - autouse fixture
from knowledge_layer_testing.estate_read import _page_reader

from agent.common.citation_collector import collect_citations
from agent.common.grounding_block import get_grounding_block
from agent.knowledge.restricted_use import RestrictedUse
from agent.knowledge.restricted_use import bind_restricted_use
from agent.knowledge.restricted_use import reset_restricted_use
from agent.knowledge.scoping import ScopedCollection


class TestTenancy:
    async def test_one_backend_serves_each_turn_its_own_rows(self) -> None:
        backend = _backend()
        assert [f.path for f in await backend.listable_files()] == [
            "/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md",
            "/project/Notiz.txt",
        ]
        token = TURN.set("org_b")
        try:
            assert [f.path for f in await backend.listable_files()] == ["/project/Fremd.pdf.md"]
            missing = await backend.read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md")
        finally:
            TURN.reset(token)
        assert missing.status == "error"
        assert missing.text.startswith('No file "/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md".')


class TestPrivacy:
    async def test_a_guessed_restricted_path_reads_exactly_like_a_miss(self) -> None:
        """Nothing confirms it exists: not the text, not the status, not a suggestion (ADR-0088)."""
        backend = _backend(restricted=())
        guessed = await backend.read_file("/project/Personal/Vertrag.pdf.md")
        absent = await backend.read_file("/project/Personal/Vertrxg.pdf.md")
        assert guessed.status == absent.status == "error"
        assert guessed.text == no_such_file("/project/Personal/Vertrag.pdf.md")
        assert absent.text == no_such_file("/project/Personal/Vertrxg.pdf.md")
        assert "Vertrag" not in absent.text.split("\n", 1)[1]

    async def test_a_restricted_document_reads_once_its_collection_may_be_named(self, monkeypatch) -> None:
        """The real loader: restricted rows are loaded only for collections the turn admitted."""
        backend = EstateBackend(
            SimpleNamespace(),
            rows_loader=lambda: _async([BSK]),
            page_reader=_page_reader({"Vertrag.pdf": {1: "§ 1 Gehalt"}}),
        )
        monkeypatch.setattr(backend, "entries", lambda: [ScopedCollection(RESTRICTED, "project")])

        async def rows_of(entries):
            return [SECRET] if entries else []

        monkeypatch.setattr(estate_module, "_rows_of", rows_of)
        before = await backend.read_file("/project/Personal/Vertrag.pdf.md")
        assert before.text == no_such_file("/project/Personal/Vertrag.pdf.md")

        use = RestrictedUse(organization_id="o", user_id="u", conversation_id="c", project_id="p")
        use.admitted.add(RESTRICTED)
        token = bind_restricted_use(use)
        try:
            after = await backend.read_file("/project/Personal/Vertrag.pdf.md")
        finally:
            reset_restricted_use(token)
        assert after.status == "ok"
        assert "Citation: Vertrag.pdf, p.1" in after.text

    async def test_a_restricted_document_is_never_suggested(self) -> None:
        backend = _backend(restricted=[SECRET])
        result = await backend.read_file("/project/Personal/Vertrage.pdf.md")
        assert "Vertrag.pdf" not in result.text

    async def test_without_its_folder_a_restricted_namesake_loses_to_the_listable_one(self) -> None:
        twin = FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection=RESTRICTED, folder="Personal")
        backend = _backend(restricted=[twin])
        result = await backend.read_file("/project/Brandschutzkonzept.pdf.md", pages="1")
        assert "Collection: proj_a\n" in result.text
        assert "Moved: /project/Brandschutzkonzept.pdf.md is now" not in result.text


class TestTheBlocks:
    async def test_one_block_per_page_with_the_citation_key_and_path(self) -> None:
        result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", pages="2-3")
        assert result.status == "ok"
        assert [hit.citation_key for hit in result.hits] == [
            "Brandschutzkonzept.pdf, p.2",
            "Brandschutzkonzept.pdf, p.3",
        ]
        assert "Path: /project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md" in result.text
        assert "--- Result 2 ---" in result.text and "--- Result 3 ---" not in result.text
        assert result.text.startswith("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md, pages 2-3 of 3. ")

    async def test_a_body_is_the_page_verbatim_with_no_line_gutter(self) -> None:
        """Quote verification compares against the body, so a gutter would break a quote across a line."""
        result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", pages="2")
        assert result.hits[0].body == PAGES[2]
        assert "\n2.1 Rettungsweg\nDer Fluchtweg" in result.text
        assert "@@ lines" not in result.text

    async def test_the_records_are_filed_and_collected(self) -> None:
        with collect_citations() as collected:
            result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf", pages="1")
        assert [hit.citation_key for hit in collected] == ["Brandschutzkonzept.pdf, p.1"]
        assert get_grounding_block(result.text) is not None

    async def test_a_bare_pdf_path_answers_with_the_text(self) -> None:
        result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf", pages="1")
        assert result.status == "ok" and "Brandschutzkonzept.pdf.md, page 1 of 3" in result.text

    async def test_a_stale_folder_still_resolves_and_says_where_the_file_is(self) -> None:
        result = await _backend().read_file("/project/Alt/Brandschutzkonzept.pdf.md", pages="1")
        assert "Moved: /project/Alt/Brandschutzkonzept.pdf.md is now /project/Gutachten/Brandschutz/" in result.text

    async def test_without_pages_the_opening_page_and_the_next_call(self, monkeypatch) -> None:
        async def no_outline(self, file):
            return ""

        monkeypatch.setattr(EstateBackend, "_outline", no_outline)
        result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md")
        assert [hit.page for hit in result.hits] == [1]
        assert 'Next: pages="2-3"' in result.text

    async def test_offset_on_a_paged_document_reads_the_pages_it_maps_to(self) -> None:
        result = await _backend().read_file(
            "/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", offset=2, limit=2
        )
        assert [hit.page for hit in result.hits] == [2]
        assert "offset/limit were read as lines" in result.text

    async def test_a_text_file_is_read_in_lines_as_one_pageless_block(self) -> None:
        result = await _backend().read_file("/project/Notiz.txt", offset=1, limit=1)
        assert [(hit.page, hit.body, hit.citation_key) for hit in result.hits] == [(None, "b", "Notiz.txt")]
        assert "lines 2-2 of 3" in result.text and "Next: offset=2." in result.text

    async def test_a_rebuilt_document_says_so(self) -> None:
        backend = _backend(page_reader=_page_reader({"Brandschutzkonzept.pdf": PAGES}, origin="chunks"))
        result = await backend.read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", pages="1")
        assert "Rebuilt from the index; page breaks inside a passage are approximate." in result.text

    async def test_a_drawing_page_says_it_is_a_reading_and_not_a_measurement(self) -> None:
        async def read(collection, file_name, *, wanted=None):
            page = stored_pages.Page(number=1, text="Grundriss EG 1:100", source="vlm_reading")
            return stored_pages.PageText(pages=[page], origin="stored", page_count=1)

        backend = _backend(page_reader=read)
        result = await backend.read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", pages="1")
        assert result.hits[0].content_type == "drawing"
        assert "not its printed text. Read off, not measured" in result.text

    async def test_a_folder_is_not_a_file(self) -> None:
        result = await _backend().read_file("/project/Gutachten/")
        assert result.status == "error" and "is a folder" in result.text

    async def test_pages_past_the_end_say_how_many_there_are(self) -> None:
        result = await _backend().read_file("/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md", pages="9")
        assert result.status == "empty" and "has 3 page(s)" in result.text


class TestPageAddresses:
    def test_the_three_spellings(self) -> None:
        assert parse_pages("3") == [3]
        assert parse_pages("3-5") == [3, 4, 5]
        assert parse_pages("3,7, 11") == [3, 7, 11]
        assert parse_pages(4) == [4]
        assert parse_pages(None) is None

    @pytest.mark.parametrize("raw", ["drei", "5-3", "0", "1-31"])
    def test_what_cannot_be_served_is_refused_with_the_rule(self, raw: str) -> None:
        with pytest.raises(PagesRefused):
            parse_pages(raw)

    def test_lines_map_onto_the_pages_they_fall_on(self) -> None:
        pages = [stored_pages.Page(number=n, text="a\nb") for n in (1, 2, 3)]
        assert pages_for_lines(pages, 0, 2) == [1]
        assert pages_for_lines(pages, 1, 2) == [1, 2]


class TestStoredPages:
    KEY = "org/o/project/p/doc/d1/v2/w1/Brandschutzkonzept.pdf"

    def _index(self, **file_overrides) -> dict:
        body, index = _render_pages(PAGES, document_id="d1", version=2)
        index["file"].update(file_overrides)
        return index

    def _store(self, index: dict) -> tuple:
        body, _ = _render_pages(PAGES, document_id="d1", version=2)
        objects = {
            "org/o/project/p/doc/d1/v2/w1/_text/index.json": json.dumps(index).encode(),
            "org/o/project/p/doc/d1/v2/w1/_text/pages.md": body,
        }
        asked: list = []

        def fetch(key, bucket, byte_range):
            asked.append((key, byte_range))
            data = objects.get(key)
            if data is None or byte_range is None:
                return data
            return data[byte_range[0] : byte_range[1] + 1]

        async def resolve(collection, file_name):
            from knowledge_layer.view_image import StorageLocation

            return StorageLocation(self.KEY, None, "ver-2", "d1")

        return resolve, fetch, asked

    async def test_the_stored_pages_are_read_by_a_range_over_the_wanted_ones(self) -> None:
        resolve, fetch, asked = self._store(self._index())
        text = await stored_pages.read_stored("proj_a", "B.pdf", wanted={2}, resolve=resolve, fetch=fetch)
        assert text is not None and text.origin == "stored"
        assert [(page.number, page.text) for page in text.pages] == [(2, PAGES[2])]
        assert asked[-1][0].endswith("/_text/pages.md") and asked[-1][1] is not None

    @pytest.mark.parametrize("override", [{"document_id": "d9"}, {"version": 1}])
    async def test_an_index_of_another_document_or_version_is_refused(self, override) -> None:
        resolve, fetch, _asked = self._store(self._index(**override))
        assert await stored_pages.read_stored("proj_a", "B.pdf", resolve=resolve, fetch=fetch) is None

    async def test_no_index_falls_back_to_the_chunks(self) -> None:
        async def resolve(collection, file_name):
            return ("org/o/doc/d1/B.pdf", None)

        def chunks(collection, file_name):
            return [(1, "Seite eins", {}), (1, "noch eins", {}), (2, "Seite zwei", {"content_type": "drawing"})]

        text = await stored_pages.read_pages(
            "proj_a", "B.pdf", resolve=resolve, fetch=lambda *a: None, read_chunks=chunks
        )
        assert text is not None and text.rebuilt
        assert [(p.number, p.text) for p in text.pages] == [(1, "Seite eins\n\nnoch eins"), (2, "Seite zwei")]
        assert text.pages[1].is_drawing

    def test_the_key_names_its_version(self) -> None:
        assert stored_pages.key_version(self.KEY) == 2
        assert stored_pages.key_version("org/o/doc/d1/B.pdf") is None
        assert stored_pages.text_prefix(self.KEY) == "org/o/project/p/doc/d1/v2/w1/_text/"


def _render_pages(pages: dict[int, str], *, document_id: str, version: int) -> tuple[bytes, dict]:
    """``pages.md`` and ``index.json`` in the writer's schema 1 (``page_text_store.render``)."""
    body = bytearray()
    entries = []
    for number in range(1, max(pages) + 1):
        body += f"<!-- page {number} -->\n".encode()
        encoded = (pages[number] + "\n").encode()
        entries.append(
            {"page": number, "offset": len(body), "length": len(encoded), "lines": 1, "source": "text_layer"}
        )
        body += encoded
    index = {
        "schema_version": 1,
        "file": {"document_id": document_id, "version": version, "page_count": max(pages), "failed_pages": []},
        "pages": entries,
    }
    return bytes(body), index


async def _async(value):
    return value
