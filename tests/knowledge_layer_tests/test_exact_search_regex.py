"""``knowledge_search(match="regex")``, context lines, the folder pushdown and the capped counts.

The store is a fake that runs the SAME ``qdrant.retrieval.find_text`` over in-memory points, so the
person's regex, its timeout and its narrowing words are the production code; only the Qdrant client
is missing. What a live server adds (the tokenizer, the facet) is covered by the store tests.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import AvailableDocument
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.browse import MAX_MATCH_CHUNKS
from sources.knowledge_layer.src.browse import MAX_SNIPPET_LINES
from sources.knowledge_layer.src.browse import group_matches
from sources.knowledge_layer.src.browse import match_snippets
from sources.knowledge_layer.src.browse import user_pattern
from sources.knowledge_layer.src.qdrant import retrieval
from sources.knowledge_layer.src.qdrant.retrieval import PatternTooCostly
from sources.knowledge_layer.src.qdrant.retrieval import user_literal_tokens
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import knowledge_retrieval


def _doc(name: str, folder: str | None = None) -> AvailableDocument:
    return AvailableDocument(file_name=name, folder_path=folder, collection="proj_1", shelf="project", summary="x")


PROJECT = [
    _doc("Grundriss_EG.pdf", "Plaene/Grundrisse"),
    _doc("Schnitt_A-A.pdf", "Plaene/Schnitte"),
    _doc("Brandschutzkonzept.pdf", "Brandschutz"),
]


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("oib_knowledge", Shelf.BASE), ScopedCollection("proj_1", Shelf.PROJECT)],
    )
    monkeypatch.setattr("aiq_agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    set_turn_documents(PROJECT)
    yield
    set_turn_documents(None)


def _chunk(file_name: str, content: str, *, page: int = 1, chunk_id: str = "1", collection: str = "proj_1") -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=1.0,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=ContentType.TEXT,
        metadata={"page_label": str(page), "collection": collection},
    )


class _Store:
    """The retriever the tool talks to: ``find_text`` runs the real scan over in-memory points."""

    def __init__(self, points: list[Chunk], *, indexed: bool = True, candidates: dict[str, int] | None = None):
        self.points = points
        self.calls: list[dict] = []
        self.scanned: list[dict] = []
        self.indexed = indexed
        self.candidates = candidates

    async def find_text(self, collection_name, pattern, filters=None, limit=500, user_regex=False):
        self.calls.append({"collection": collection_name, "filters": filters, "user_regex": user_regex})
        records = [
            SimpleNamespace(
                id=chunk.chunk_id,
                payload={"text": chunk.content, "chunk_id": chunk.chunk_id, "file_name": chunk.file_name},
            )
            for chunk in self.points
            if chunk.metadata["collection"] == collection_name
        ]
        fake = SimpleNamespace(
            scroll=lambda scope, flt, *extra: self.scanned.append({"extra": extra}) or iter(records),
            text_index_sound=lambda scope: self.indexed,
        )
        original = retrieval.get_store
        retrieval.get_store = lambda *a, **k: fake
        try:
            hits = retrieval.find_text(collection_name, pattern, filters, limit, user_regex=user_regex)
        finally:
            retrieval.get_store = original
        by_id = {chunk.chunk_id: chunk for chunk in self.points}
        return [by_id[hit.chunk_id] for hit in hits]

    async def candidate_counts(self, collection_name, pattern, filters=None, user_regex=False):
        return self.candidates

    async def retrieve(self, *args, **kwargs):  # pragma: no cover
        raise AssertionError("match='regex' must not run the ranked search")


@pytest.fixture
def search_with(monkeypatch, scope):
    def install(retriever):
        monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: retriever)
        monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)
        monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
        monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
        return retriever

    return install


async def _search(**kwargs) -> str:
    config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", include_base_collection=True)
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


class TestUserPattern:
    def test_a_pattern_in_python_syntax_compiles_and_ignores_case(self):
        compiled, refusal = user_pattern(r"MA ?37/\d{6}-\d{4}")
        assert refusal == ""
        assert compiled.search("Geschäftszahl ma37/123456-0001 vom")

    @pytest.mark.parametrize("text", ["(unclosed", "a[b", "*start", "x{2,1}"])
    def test_a_pattern_that_is_not_a_regex_is_refused_with_the_way_out(self, text):
        compiled, refusal = user_pattern(text)
        assert compiled is None
        assert "not a valid regex" in refusal and 'match="exact"' in refusal

    def test_a_pattern_longer_than_the_bound_is_refused(self):
        compiled, refusal = user_pattern("a" * 301)
        assert compiled is None and "too long" in refusal

    @pytest.mark.parametrize("text", ["a*", "(?:x)?", r"\b?"])
    def test_a_pattern_that_matches_the_empty_string_is_refused(self, text):
        compiled, refusal = user_pattern(text)
        assert compiled is None and "empty string" in refusal


class TestLiteralWords:
    @pytest.mark.parametrize(
        ("pattern", "expected"),
        [
            (r"\bFluchtweg\b", [["fluchtweg"]]),
            (r"(?i)\bBrandabschnitt BA-03\b", [["brandabschnitt", "ba", "03"]]),
            (r"Brandabschnitt BA-03\b", [["ba", "03"]]),  # the first word may sit inside a longer one
            (r"\bT30-\d+", [["t30"]]),
            (r"Tür|Tor\b", None),
            (r"Brand abschnitt|Fluchtweg\b", None),
        ],
    )
    def test_the_words_every_match_holds(self, pattern, expected):
        assert user_literal_tokens(pattern) == expected

    @pytest.mark.parametrize(
        "pattern",
        [
            r"MA ?37/\d{6}",  # 37 may follow MA directly: no token boundary
            r"Fluchtweg\w*",  # matches inside a longer word
            r"[A-Z]{2}\d+",
            r"Flucht(?:weg)?\b",
            r"(?x) Fluchtweg \b",
            r".*",
            r"Müller\b",  # not ASCII: the index folds it, this reader does not model that
        ],
    )
    def test_when_in_doubt_there_is_no_word(self, pattern):
        assert user_literal_tokens(pattern) is None

    def test_every_alternative_needs_its_own_word(self):
        assert user_literal_tokens(r"\bBA-03\b|\bBA-04\b") == [["ba", "03"], ["ba", "04"]]


class TestRegexSearch:
    async def test_a_regex_finds_every_hit_and_counts_per_file(self, search_with):
        store = search_with(
            _Store(
                [
                    _chunk("Grundriss_EG.pdf", "Tür T30-2 im BA-03", page=1, chunk_id="1"),
                    _chunk("Schnitt_A-A.pdf", "Tür T90-1 und Tür T30-4", page=4, chunk_id="2"),
                    _chunk("Schnitt_A-A.pdf", "keine Tuer", page=5, chunk_id="3"),
                ]
            )
        )
        text = await _search(query=r"\bT30-\d+", match="regex")
        assert "## Matches for regex `\\bT30-\\d+`" in text
        assert "- Grundriss_EG.pdf (Projektwissen): 1×, p. 1" in text
        assert "- Schnitt_A-A.pdf (Projektwissen): 1×, p. 4" in text
        assert "Citation: Schnitt_A-A.pdf, p.4" in text
        assert all(call["user_regex"] for call in store.calls)

    async def test_context_shows_n_lines_around_each_hit_and_marks_the_hit(self, search_with):
        body = "\n".join(["Zeile 1", "Zeile 2", "Fluchtweg 40 m", "Zeile 4", "Zeile 5", "Zeile 6"])
        search_with(_Store([_chunk("Brandschutzkonzept.pdf", body, page=7)]))
        text = await _search(query=r"\bFluchtweg \d+", match="regex", context=1)
        snippets = text[text.index("## Lines around the matches") :]
        assert "Brandschutzkonzept.pdf, p.7:" in snippets
        assert "  Zeile 2\n> Fluchtweg 40 m\n  Zeile 4" in snippets
        assert "Zeile 1" not in snippets and "Zeile 5" not in snippets
        assert "cite the passages above" in snippets

    async def test_context_zero_prints_the_hit_lines_alone_and_works_for_exact_too(self, search_with):
        search_with(_Store([_chunk("Brandschutzkonzept.pdf", "a\nBA-03 Nord\nb", page=2)]))
        text = await _search(query="BA-03", match="exact", context=0)
        assert "> BA-03 Nord" in text
        assert "  a" not in text

    async def test_context_is_bounded_and_only_for_literal_modes(self, search_with):
        search_with(_Store([]))
        assert "0 to 3" in await _search(query="BA-03", match="exact", context=9)
        assert "only `match=" in await _search(query="BA-03", context=1)

    def test_snippets_stop_at_their_line_bound_and_say_so(self):
        body = "\n".join(f"Treffer {n}" for n in range(60))
        chunks = [_chunk("a.pdf", body, page=1)]
        groups = group_matches(chunks, __import__("re").compile("Treffer"))
        text = match_snippets(groups, __import__("re").compile("Treffer"), 0)
        assert text.count("\n> ") <= MAX_SNIPPET_LINES
        assert f"stop at {MAX_SNIPPET_LINES}" in text

    async def test_a_multi_line_match_marks_every_line_it_covers(self, search_with):
        search_with(_Store([_chunk("Grundriss_EG.pdf", "x\nOIB\nRichtlinie 2\ny", page=1)]))
        text = await _search(query=r"OIB\s+Richtlinie", match="regex", context=0, folder="Plaene")
        assert "> OIB\n> Richtlinie 2" in text

    async def test_an_invalid_pattern_is_refused_before_any_scan(self, search_with):
        store = search_with(_Store([]))
        assert "not a valid regex" in await _search(query="Fluchtweg(", match="regex")
        assert store.calls == []

    async def test_a_pattern_with_no_literal_word_and_no_narrowing_is_refused_before_the_scan(self, search_with):
        store = search_with(_Store([_chunk("Grundriss_EG.pdf", "MA 37/123456-0001")]))
        text = await _search(query=r"MA ?37/\d{6}-\d{4}", match="regex")
        assert "needs something to narrow" in text and "folder=" in text
        assert store.calls == []

    async def test_a_folder_lets_a_pattern_without_a_word_run(self, search_with):
        store = search_with(_Store([_chunk("Grundriss_EG.pdf", "MA 37/123456-0001")]))
        text = await _search(query=r"MA ?37/\d{6}-\d{4}", match="regex", folder="Plaene")
        assert "Grundriss_EG.pdf" in text and "1×" in text
        assert [call["collection"] for call in store.calls] == ["proj_1"]

    async def test_the_regex_mode_can_be_switched_off(self, search_with):
        search_with(_Store([]))
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge", include_base_collection=True, match_modes=["meaning", "exact"]
        )
        async with knowledge_retrieval(config, MagicMock()) as info:
            out = await info.single_fn(info.input_schema(query="Fluchtweg", match="regex"))
        assert "not available" in out

    async def test_no_hit_says_a_regex_was_read_not_a_phrase(self, search_with):
        search_with(_Store([_chunk("Grundriss_EG.pdf", "nichts")]))
        text = await _search(query=r"Fluchtweg\b", match="regex", folder="Plaene")
        assert text.startswith("No match for regex")
        assert "umlaut spellings and line breaks are not matched for you" in text


class TestFolderPushdown:
    async def test_a_folder_is_a_folder_ancestors_condition_not_a_file_list(self, search_with):
        store = search_with(_Store([]))
        await _search(query="BA-03", match="exact", folder="Plaene")
        assert [call["collection"] for call in store.calls] == ["proj_1"]
        assert store.calls[0]["filters"] == {"folder_ancestors": "plaene"}

    async def test_the_folder_is_read_in_its_stored_spelling_and_composes_with_a_file_narrowing(self, search_with):
        store = search_with(_Store([]))
        await _search(query="BA-03", match="exact", folder="plaene/grundrisse", file_name="Grundriss_EG.pdf")
        assert store.calls[0]["filters"] == {
            "$and": [{"file_name": {"$in": ["Grundriss_EG.pdf"]}}, {"folder_ancestors": "plaene/grundrisse"}]
        }

    async def test_a_folder_nothing_is_filed_in_is_said_not_scanned(self, search_with):
        store = search_with(_Store([]))
        assert "list_files" in await _search(query="BA-03", match="regex", folder="Statik")
        assert store.calls == []

    def test_tenancy_stays_anded_on_the_pushed_down_folder(self):
        from sources.knowledge_layer.src.qdrant.scope import scope_filter

        flt = scope_filter(["proj_1"], {"folder_ancestors": "plaene"})
        keys = [getattr(condition, "key", None) for condition in flt.must]
        assert keys[0] == "scope" or keys[0] is not None
        assert len(flt.must) == 2

    def test_the_facet_runs_under_the_scope_filter_too(self):
        from knowledge_layer.qdrant.schema import physical_for_scope
        from knowledge_layer.qdrant.store import QdrantStore

        client = MagicMock()
        client.facet.return_value = SimpleNamespace(hits=[SimpleNamespace(value="a.pdf", count=7)])
        store = QdrantStore(client)
        store._present.add(physical_for_scope("proj_1"))
        assert store.facet_counts("proj_1", "file_name", {"folder_ancestors": "plaene"}) == {"a.pdf": 7}
        sent = client.facet.call_args.kwargs["facet_filter"]
        assert len(sent.must) == 2
        assert client.facet.call_args.kwargs["exact"] is True


class TestCostlyPatterns:
    async def test_a_catastrophic_pattern_is_stopped_and_said_not_a_no(self, search_with, monkeypatch):
        monkeypatch.setattr(retrieval, "USER_REGEX_TIMEOUT", 0.05)
        store = search_with(_Store([_chunk("Grundriss_EG.pdf", "a" * 60 + "!")]))
        text = await _search(query=r"(a|aa)+$", match="regex", folder="Plaene")
        assert "too costly" in text and "NOT a result" in text
        assert len(store.calls) == 1

    def test_find_text_raises_on_the_first_chunk_that_outruns_the_timeout(self, monkeypatch):
        monkeypatch.setattr(retrieval, "USER_REGEX_TIMEOUT", 0.05)
        record = SimpleNamespace(id="1", payload={"text": "a" * 60 + "!", "chunk_id": "1"})
        fake = SimpleNamespace(scroll=lambda *a, **k: iter([record]), text_index_sound=lambda scope: False)
        monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: fake)
        with pytest.raises(PatternTooCostly):
            retrieval.find_text("proj_1", r"(a|aa)+$", None, 5, user_regex=True)

    def test_a_pattern_cheap_per_chunk_but_costly_over_many_is_stopped_at_the_scan_deadline(self, monkeypatch):
        """The review's pattern: it names a common word, so the gate passes, and it never matches.

        Each chunk costs it well under the per-chunk limit; sixty of them cost seconds. The scan
        stops at its own deadline instead of reading on, and says it was the scan.
        """
        import time

        monkeypatch.setattr(retrieval, "USER_REGEX_SCAN_SECONDS", 0.3)
        text = "Brandschutz " + "Wand aus Beton, a " * 330
        records = [SimpleNamespace(id=str(n), payload={"text": text, "chunk_id": str(n)}) for n in range(60)]
        fake = SimpleNamespace(scroll=lambda *a, **k: iter(records), text_index_sound=lambda scope: True)
        monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: fake)

        started = time.monotonic()
        with pytest.raises(PatternTooCostly) as stopped:
            retrieval.find_text("proj_1", r"\bbrandschutz\b(.*a){3}Z", None, 5, user_regex=True)
        assert time.monotonic() - started < 1.5
        assert stopped.value.scan is True

    def test_a_scan_past_its_chunk_cap_is_stopped(self, monkeypatch):
        monkeypatch.setattr(retrieval, "USER_REGEX_SCAN_CHUNKS", 3)
        records = [SimpleNamespace(id=str(n), payload={"text": "Tür T30", "chunk_id": str(n)}) for n in range(10)]
        fake = SimpleNamespace(scroll=lambda *a, **k: iter(records), text_index_sound=lambda scope: False)
        monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: fake)
        with pytest.raises(PatternTooCostly) as stopped:
            retrieval.find_text("proj_1", r"T90", None, 5, user_regex=True)
        assert stopped.value.scan is True

    async def test_a_scan_that_ran_out_of_time_is_said_to_be_no_result(self, search_with, monkeypatch):
        monkeypatch.setattr(retrieval, "USER_REGEX_SCAN_CHUNKS", 1)
        search_with(_Store([_chunk("Grundriss_EG.pdf", "Tür", chunk_id=str(n)) for n in range(3)]))
        text = await _search(query=r"\bTür\b T90", match="regex", folder="Plaene")
        assert "too costly" in text and "NOT a result" in text and "takes longer than one search may" in text

    def test_counting_the_matches_has_a_deadline_too(self):
        import time

        chunks = [_chunk("a.pdf", "Tür T30", chunk_id=str(n)) for n in range(3)]
        with pytest.raises(TimeoutError):
            group_matches(chunks, user_pattern(r"T30")[0], timeout=0.2, deadline=time.monotonic() - 1)

    def test_an_ordinary_pattern_is_not_stopped(self, monkeypatch):
        record = SimpleNamespace(id="1", payload={"text": "Tür T30-2", "chunk_id": "1"})
        fake = SimpleNamespace(scroll=lambda *a, **k: iter([record]), text_index_sound=lambda scope: False)
        monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: fake)
        assert len(retrieval.find_text("proj_1", r"T30-\d", None, 5, user_regex=True)) == 1

    def test_the_scan_is_narrowed_by_the_words_when_the_index_is_sound(self, monkeypatch):
        seen = []
        fake = SimpleNamespace(
            scroll=lambda scope, flt, *extra: seen.extend(extra) or iter([]), text_index_sound=lambda scope: True
        )
        monkeypatch.setattr(retrieval, "get_store", lambda *a, **k: fake)
        retrieval.find_text("proj_1", r"\bFluchtweg \d+", None, 5, user_regex=True)
        assert len(seen) == 1
        assert seen[0].should[0].match.text == "fluchtweg"


class TestCappedCounts:
    def _points(self, count: int) -> list[Chunk]:
        return [_chunk("Grundriss_EG.pdf", "BA-03 hier", page=1 + n % 9, chunk_id=str(n)) for n in range(count)]

    async def test_a_capped_scan_says_at_least_and_gives_the_passages_per_file(self, search_with):
        search_with(
            _Store(self._points(MAX_MATCH_CHUNKS + 20), candidates={"Grundriss_EG.pdf": 812, "Schnitt_A-A.pdf": 40})
        )
        text = await _search(query=r"\bBA-03\b", match="regex")
        assert "at least 500 occurrence(s)" in text
        assert "lower bounds" in text
        assert "Grundriss_EG.pdf 812, Schnitt_A-A.pdf 40" in text

    async def test_the_same_for_the_literal_mode(self, search_with):
        search_with(_Store(self._points(MAX_MATCH_CHUNKS), candidates={"Grundriss_EG.pdf": 640}))
        text = await _search(query="BA-03", match="exact")
        assert "at least" in text and "Grundriss_EG.pdf 640" in text

    async def test_an_uncapped_scan_prints_an_exact_count_and_no_candidates(self, search_with):
        search_with(_Store(self._points(3), candidates={"Grundriss_EG.pdf": 999}))
        text = await _search(query="BA-03", match="exact")
        assert "3 occurrence(s) in 1 file(s)" in text and "at least" not in text
        assert "999" not in text

    async def test_without_a_facet_the_table_still_says_at_least(self, search_with):
        store = _Store(self._points(MAX_MATCH_CHUNKS))
        store.candidate_counts = None
        search_with(store)
        text = await _search(query="BA-03", match="exact")
        assert "at least" in text and "Passages that hold" not in text


class TestLiteralSearchIsRecorded:
    """A literal search leaves the record the ``file-tools-used`` score counts as navigation (ADR-0127)."""

    @pytest.mark.parametrize("mode", ["exact", "regex"])
    async def test_each_literal_search_leaves_one_record(self, search_with, monkeypatch, mode):
        recorded: list[str] = []
        monkeypatch.setattr("aiq_agent.common.turn_status.emit_literal_search", recorded.append)
        search_with(_Store([_chunk("Grundriss_EG.pdf", "BA-03 Nord", page=2)]))

        await _search(query="BA-03", match=mode)

        assert recorded == [mode]


class TestDescriptionFollowsMatchModes:
    """The eval arms' ``match_modes`` knob: the description offers exactly the modes the search accepts."""

    async def _description(self, modes):
        config = KnowledgeRetrievalConfig(
            collection_name="oib_knowledge", include_base_collection=True, match_modes=modes
        )
        async with knowledge_retrieval(config, MagicMock()) as info:
            return info.description

    async def test_the_search_arm_is_not_offered_a_literal_mode(self, search_with):
        search_with(_Store([]))
        text = await self._description(["meaning"])
        assert 'match="exact"' not in text and 'match="regex"' not in text

    async def test_the_navigate_arm_is_told_the_search_is_literal_only(self, search_with):
        search_with(_Store([]))
        text = await self._description(["exact", "regex"])
        assert text.startswith('In this configuration the search is literal only: pass `match="exact"` or')
        assert '`match="exact"` returns EVERY passage' in text

    async def test_production_offers_every_mode(self, search_with):
        search_with(_Store([]))
        text = await self._description(["meaning", "exact", "regex"])
        assert '`match="exact"` returns' in text and '`match="regex"` is the same search' in text
        assert "literal only" not in text


def _regex_examples(description: str) -> list[str]:
    """Every backticked regex in the parenthesis after „for a pattern“ in the regex paragraph."""
    import re

    paragraph = description[description.index('`match="regex"`') : description.index("Returns: numbered")]
    offered = paragraph[paragraph.index("for a pattern (") : paragraph.index("`|` is then")]
    return re.findall(r"`([^`]+)`", offered)


class TestRegexExamplesPassTheirOwnAnchorRule:
    async def test_every_example_in_the_description_is_accepted_without_a_folder(self, search_with):
        from sources.knowledge_layer.src.browse import _has_literal_word
        from sources.knowledge_layer.src.register import _KNOWLEDGE_SEARCH_DESCRIPTION

        examples = _regex_examples(_KNOWLEDGE_SEARCH_DESCRIPTION)
        assert examples, "the description offers no regex example"
        for example in examples:
            assert _has_literal_word(example), f"{example!r} would be refused by its own description"

    async def test_the_refusal_says_how_to_rewrite(self, search_with):
        search_with(_Store([_chunk("Grundriss_EG.pdf", "MA 37/123456-0001")]))
        text = await _search(query=r"MA ?37/\d{6}", match="regex")
        assert "Rewrite it so one word is written out in full" in text
        assert "`MA ?37/\\d{6}` becomes `MA 37/\\d{6}`" in text
        assert "folder=" in text
        ok = await _search(query=r"MA 37/\d{6}", match="regex")
        assert "Grundriss_EG.pdf" in ok


class TestDistinctMatches:
    async def test_a_regex_lists_each_distinct_string_with_count_files_and_pages(self, search_with):
        search_with(
            _Store(
                [
                    _chunk("Grundriss_EG.pdf", "MA 37/111111 und MA 37/222222", page=1, chunk_id="1"),
                    _chunk("Schnitt_A-A.pdf", "ma 37/111111 wieder", page=4, chunk_id="2"),
                ]
            )
        )
        text = await _search(query=r"MA 37/\d{6}", match="regex")
        assert "Distinct matches: 2" in text
        assert "- `MA 37/111111`: 2× in Grundriss_EG.pdf, Schnitt_A-A.pdf, p. 1, 4" in text
        assert "- `MA 37/222222`: 1× in Grundriss_EG.pdf, p. 1" in text

    async def test_exact_search_has_no_distinct_table(self, search_with):
        search_with(_Store([_chunk("Grundriss_EG.pdf", "BA-03", page=1)]))
        assert "Distinct matches" not in await _search(query="BA-03", match="exact")

    def test_the_list_is_bounded_and_says_what_it_left_out(self):
        import re

        from sources.knowledge_layer.src.browse import MAX_DISTINCT_MATCHES
        from sources.knowledge_layer.src.browse import match_table

        body = " ".join(f"Nr{n:04d}" for n in range(MAX_DISTINCT_MATCHES + 5))
        pattern = re.compile(r"Nr\d{4}")
        groups = group_matches([_chunk("a.pdf", body)], pattern, collect_strings=True)
        text = match_table(groups, [r"Nr\d{4}"], truncated=False, regex_mode=True)
        assert f"Distinct matches: {MAX_DISTINCT_MATCHES + 5}" in text
        assert text.count("\n- `Nr") == MAX_DISTINCT_MATCHES
        assert "and 5 more distinct strings" in text


class TestShelfScope:
    @pytest.fixture
    def two_shelves(self, search_with):
        return search_with(
            _Store(
                [
                    _chunk("Grundriss_EG.pdf", "Fluchtweg 40 m", page=2, chunk_id="1"),
                    _chunk(
                        "OIB-RL2.pdf", "Fluchtweg 40 m und Fluchtweg", page=7, chunk_id="2", collection="oib_knowledge"
                    ),
                ]
            )
        )

    async def test_the_default_reads_every_shelf_and_counts_each(self, two_shelves):
        text = await _search(query="Fluchtweg", match="exact")
        assert "Searched: 3 documents plus a corpus (Projektwissen 3 documents, Basiswissen (whole corpus))" in text
        assert "\nProjektwissen: 1 match in 1 of 3 files" in text
        assert "\nBasiswissen: 2 matches in 1 file (documents not counted)" in text

    async def test_shelf_project_keeps_the_corpus_out(self, two_shelves):
        text = await _search(query="Fluchtweg", match="exact", shelf="project")
        assert "OIB-RL2.pdf" not in text and "Grundriss_EG.pdf" in text
        assert [call["collection"] for call in two_shelves.calls] == ["proj_1"]

    async def test_a_no_match_states_the_documents_searched_per_shelf(self, two_shelves):
        text = await _search(query="Brandabschnitt", match="exact", shelf="project")
        assert text.startswith("No match for")
        assert "Searched: 3 documents (Projektwissen 3 documents)." in text
        assert "\nProjektwissen: 0 matches in 3 files" in text

    async def test_a_shelf_out_of_scope_or_unknown_is_said_not_answered_with_a_no(self, two_shelves):
        assert "not part of this question's scope" in await _search(query="Fluchtweg", match="exact", shelf="office")
        assert "must be one of project, office, base" in await _search(query="Fluchtweg", match="exact", shelf="x")
        assert two_shelves.calls == []

    async def test_the_ranked_search_takes_the_same_refusal(self, two_shelves):
        assert "not part of this question's scope" in await _search(query="Fluchtweg", shelf="office")


class TestPageEndReachesTheHit:
    @pytest.mark.parametrize(
        ("metadata", "page", "expected"),
        [({"page_end": "5"}, 4, 5), ({"page_end": "4"}, 4, None), ({}, 4, None), ({"page_end": "x"}, 4, None)],
    )
    def test_only_a_later_numeric_end_is_stated(self, metadata, page, expected):
        from sources.knowledge_layer.src.register import _page_end

        assert _page_end(SimpleNamespace(metadata=metadata), page) == expected

    def test_a_chunk_without_a_page_states_no_end(self):
        from sources.knowledge_layer.src.register import _page_end

        assert _page_end(SimpleNamespace(metadata={"page_end": "5"}), None) is None
