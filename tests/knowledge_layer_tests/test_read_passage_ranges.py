"""Ranged reads: ``read_passage(document, pages="4-6")`` and the cursor that continues one.

What is pinned:

* ``pages`` parses the spellings a model sends and refuses the rest with the call to make;
* the neighbouring chunks' overlap is delivered once, and no chunk loses text of its own;
* a read over the size cap stops at a chunk boundary and ends with a cursor, and the cursor continues
  without repeating or skipping a chunk;
* a cursor names a position in ONE document: another document's, a mangled one and a forged one are
  refused, and no cursor changes which collection or scope a read runs in.
"""

from __future__ import annotations

import base64
import json
import re
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.turn_status import fetch_signature
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.read_passage import RangeRefused
from sources.knowledge_layer.src.read_passage import ReadCursor
from sources.knowledge_layer.src.read_passage import ReadPassageConfig
from sources.knowledge_layer.src.read_passage import _chunk_position
from sources.knowledge_layer.src.read_passage import _parse_pages
from sources.knowledge_layer.src.read_passage import _range_order
from sources.knowledge_layer.src.read_passage import _without_overlap
from sources.knowledge_layer.src.read_passage import decode_cursor
from sources.knowledge_layer.src.read_passage import encode_cursor
from sources.knowledge_layer.src.read_passage import read_passage
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig

REPORT = "Brandschutzkonzept.pdf"
OTHER = "Gutachten.pdf"
COLLECTION = "proj_a"


def _document(file_name: str) -> SimpleNamespace:
    return SimpleNamespace(file_name=file_name, display_title=None, summary=None, tags=None)


def _chunk(
    page: int,
    ordinal: int,
    content: str,
    *,
    end: int | None = None,
    file_name: str = REPORT,
    collection: str = COLLECTION,
    content_type: ContentType = ContentType.TEXT,
) -> Chunk:
    metadata: dict[str, object] = {
        "page_label": str(page),
        "chunk_ordinal": ordinal,
        "chunking": "page",
        "collection": collection,
    }
    if end is not None:
        metadata["page_end"] = str(end)
    return Chunk(
        chunk_id=f"{file_name}-{page}-{ordinal}",
        content=content,
        score=1.0,
        file_name=file_name,
        page_number=page,
        display_citation=f"{file_name}, p.{page}",
        content_type=content_type,
        metadata=metadata,
    )


SENTENCE = "Der Fluchtweg darf an keiner Stelle länger als vierzig Meter sein und muss ins Freie führen."


class _Retriever:
    """A retriever that reads by filter: it records every call and honours ``start_from``."""

    def __init__(self, chunks: list[Chunk]):
        self.chunks = chunks
        self.calls: list[dict] = []

    async def fetch(self, collection_name, filters, limit, order_by=None, start_from=None):
        self.calls.append({"collection": collection_name, "filters": filters, "limit": limit, "start_from": start_from})
        ordered = _range_order(self.chunks)
        if start_from is not None:
            ordered = [chunk for chunk in ordered if _chunk_position(chunk) > start_from]
        return [chunk.model_copy(deep=True) for chunk in ordered[:limit]]


@pytest.fixture
def harness(monkeypatch):
    def build(chunks: list[Chunk], documents: tuple[str, ...] = (REPORT,)) -> _Retriever:
        retriever = _Retriever(chunks)

        async def _documents(collection: str):
            return [_document(name) for name in documents]

        monkeypatch.setattr("aiq_agent.knowledge.factory.get_active_retriever", lambda: retriever)
        monkeypatch.setattr("aiq_agent.knowledge.factory.get_available_documents_async", _documents)
        monkeypatch.setattr(
            "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
            lambda: [ScopedCollection(COLLECTION, Shelf.PROJECT)],
        )
        for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
            monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
        return retriever

    return build


def _builder() -> MagicMock:
    builder = MagicMock()
    builder.get_function_config = MagicMock(
        return_value=KnowledgeRetrievalConfig(collection_name=COLLECTION, include_base_collection=False)
    )
    return builder


async def _read(**kwargs) -> str:
    async with read_passage(ReadPassageConfig(), _builder()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _cursor_of(text: str) -> str | None:
    match = re.search(r'cursor="([^"]+)"', text)
    return match.group(1) if match else None


class TestParsePages:
    @pytest.mark.parametrize(
        ("raw", "expected"),
        [
            ("4-6", (4, 6)),
            ("4", (4, 4)),
            (5, (5, 5)),
            ("4–6", (4, 6)),
            ("4 bis 6", (4, 6)),
            (" S. 4 - 6 ", (4, 6)),
            ("", None),
            (None, None),
        ],
    )
    def test_the_spellings_a_model_sends(self, raw, expected):
        assert _parse_pages(raw) == expected

    def test_a_reversed_range_is_refused_with_the_corrected_call(self):
        with pytest.raises(RangeRefused, match=r'pages="4-6"'):
            _parse_pages("6-4", REPORT)

    def test_more_than_thirty_pages_is_refused_with_a_split(self):
        with pytest.raises(RangeRefused, match=r'pages="1-30" and pages="31-40"'):
            _parse_pages("1-40")

    @pytest.mark.parametrize("raw", ["vier", "4-", "0", "4,6"])
    def test_text_that_is_no_range_is_refused(self, raw):
        with pytest.raises(RangeRefused):
            _parse_pages(raw)


class TestWithoutOverlap:
    def test_a_head_repeating_the_previous_ending_is_cut_once(self):
        first = _chunk(4, 0, f"Einleitung zum Brandschutz. {SENTENCE}")
        second = _chunk(4, 1, f"{SENTENCE} Danach folgt der Rauchabzug.")

        trimmed = _without_overlap([first, second])

        assert trimmed[0].content == first.content
        assert trimmed[1].content == "Danach folgt der Rauchabzug."
        assert (trimmed[1].chunk_id, trimmed[1].page_number) == (second.chunk_id, second.page_number)

    def test_whitespace_differences_do_not_hide_the_overlap(self):
        first = _chunk(4, 0, f"Anfang.\n{SENTENCE}")
        second = _chunk(4, 1, SENTENCE.replace(" ", "  ") + " Rest des Absatzes.")

        assert _without_overlap([first, second])[1].content == "Rest des Absatzes."

    def test_a_chunk_that_is_only_the_overlap_keeps_its_own_text(self):
        first = _chunk(4, 0, f"Anfang. {SENTENCE}")
        second = _chunk(4, 1, SENTENCE)

        assert _without_overlap([first, second])[1].content == SENTENCE

    def test_a_short_repeat_is_the_chunks_own_text(self):
        first = _chunk(4, 0, "Tabelle 3 Anforderungen. Spalte A Spalte B")
        second = _chunk(4, 1, "Spalte A Spalte B bleibt hier stehen und gehört zu diesem Absatz.")

        assert _without_overlap([first, second])[1].content == second.content

    def test_chunks_that_were_not_cut_one_after_the_other_are_left_alone(self):
        first = _chunk(4, 0, f"Anfang. {SENTENCE}")
        gap = _chunk(5, 3, f"{SENTENCE} Weiter.")
        table = _chunk(5, 1, f"{SENTENCE} Weiter.", content_type=ContentType.TABLE)

        assert _without_overlap([first, gap])[1].content == gap.content
        assert _without_overlap([first, table])[1].content == table.content


class TestRangedRead:
    @pytest.mark.asyncio
    async def test_pages_come_back_in_reading_order_without_the_overlap(self, harness):
        retriever = harness(
            [
                _chunk(5, 2, "Seite fünf, zweiter Teil."),
                _chunk(4, 0, f"Seite vier beginnt hier. {SENTENCE}"),
                _chunk(4, 1, f"{SENTENCE} Seite vier endet hier."),
                _chunk(5, 3, "Seite fünf, dritter Teil."),
                _chunk(9, 4, "Weit hinten."),
            ]
        )

        text = await _read(document=REPORT, pages="4-5", conclusion="x")

        assert text.index("Seite vier beginnt") < text.index("Seite vier endet") < text.index("zweiter Teil")
        assert text.count(SENTENCE) == 1
        assert "Weit hinten" not in text
        assert "Read pages 4–5." in text
        assert "cursor=" not in text
        assert "Citation" in text and f"{REPORT}, p.4" in text
        (call,) = retriever.calls
        assert call["collection"] == COLLECTION
        assert call["filters"] == {
            "$and": [
                {"file_name": {"$eq": REPORT}},
                {"reading_order": {"$gte": 1}},
                {"reading_order": {"$lte": 5}},
            ]
        }

    @pytest.mark.asyncio
    async def test_a_chunk_that_runs_onto_the_range_is_included(self, harness):
        harness([_chunk(3, 0, "Beginnt auf drei.", end=5), _chunk(7, 1, "Zu spät.")])

        text = await _read(document=REPORT, pages="4-5", conclusion="x")

        assert "Beginnt auf drei." in text and "Zu spät." not in text

    @pytest.mark.asyncio
    async def test_a_page_without_text_is_named(self, harness):
        harness([_chunk(4, 0, "Vier."), _chunk(6, 1, "Sechs.")])

        assert "No text on page 5." in await _read(document=REPORT, pages="4-6", conclusion="x")

    @pytest.mark.asyncio
    async def test_a_range_beyond_the_document_says_so(self, harness):
        harness([_chunk(1, 0, "Eins.")])

        text = await _read(document=REPORT, pages="40-42", conclusion="x")

        assert "carries no passage" in text and "S. 40–42" in text

    @pytest.mark.asyncio
    async def test_a_reversed_range_is_refused_before_the_store_is_asked(self, harness):
        retriever = harness([_chunk(4, 0, "Vier.")])

        assert 'pages="4-6"' in await _read(document=REPORT, pages="6-4", conclusion="x")
        assert retriever.calls == []

    @pytest.mark.asyncio
    async def test_page_given_as_a_range_is_a_range(self, harness):
        harness([_chunk(4, 0, "Vier."), _chunk(5, 1, "Fünf."), _chunk(9, 2, "Neun.")])

        text = await _read(document=REPORT, page="4-5", conclusion="x")

        assert "Vier." in text and "Fünf." in text and "Neun." not in text

    @pytest.mark.asyncio
    async def test_a_clause_beats_pages(self, harness):
        retriever = harness([_chunk(4, 0, "Vier.")])

        await _read(document=REPORT, clause="3.5.2", pages="4-5", conclusion="x")

        assert all("reading_order" not in json.dumps(call["filters"]) for call in retriever.calls)


class TestCursor:
    def _long_document(self) -> list[Chunk]:
        # 10 chunks of 5,000 characters: four fit under the 24,000 cap.
        return [_chunk(1 + index // 2, index, f"Abschnitt {index}. " + "x" * 5_000) for index in range(10)]

    @pytest.mark.asyncio
    async def test_a_read_over_the_cap_ends_with_a_cursor_and_the_cursor_continues(self, harness):
        retriever = harness(self._long_document())

        first = await _read(document=REPORT, pages="1-5", conclusion="x")
        cursor = _cursor_of(first)
        assert cursor and "the rest follows" in first
        read_first = {int(n) for n in re.findall(r"Abschnitt (\d+)\.", first)}
        assert read_first == {0, 1, 2, 3}

        second = await _read(document=REPORT, cursor=cursor, conclusion="x")
        read_second = {int(n) for n in re.findall(r"Abschnitt (\d+)\.", second)}
        assert read_second == {4, 5, 6, 7}

        third = await _read(document=REPORT, cursor=_cursor_of(second), conclusion="x")
        assert {int(n) for n in re.findall(r"Abschnitt (\d+)\.", third)} == {8, 9}
        assert _cursor_of(third) is None and "Read pages" in third
        assert retriever.calls[1]["start_from"] == (2, 3)

    @pytest.mark.asyncio
    async def test_a_continuation_stays_inside_the_requested_range(self, harness):
        harness(self._long_document())

        first = await _read(document=REPORT, pages="1-3", conclusion="x")
        rest = await _read(document=REPORT, cursor=_cursor_of(first), conclusion="x")

        assert {int(n) for n in re.findall(r"Abschnitt (\d+)\.", rest)} == {4, 5}
        assert _cursor_of(rest) is None

    @pytest.mark.asyncio
    async def test_a_cut_never_splits_chunks_that_share_a_place(self, harness):
        # Three unnumbered chunks of one page tie at one place; the cap cannot fall between them.
        chunks = [_chunk(1, 0, "Erster. " + "x" * 20_000)]
        for tail in "abc":
            chunk = _chunk(2, 0, f"Gleichstand {tail}. " + "y" * 3_000)
            chunk.metadata.pop("chunk_ordinal")
            chunks.append(chunk)
        harness(chunks)

        first = await _read(document=REPORT, pages="1-2", conclusion="x")

        assert "Erster." in first and "Gleichstand" not in first
        rest = await _read(document=REPORT, cursor=_cursor_of(first), conclusion="x")
        assert all(f"Gleichstand {tail}." in rest for tail in "abc")

    @pytest.mark.asyncio
    async def test_a_cursor_with_nothing_after_it_says_the_read_is_complete(self, harness):
        harness([_chunk(1, 0, "Eins.")])
        token = encode_cursor(ReadCursor(REPORT, COLLECTION, 1, 0, None))

        assert "the read is complete" in await _read(document=REPORT, cursor=token, conclusion="x")

    def test_the_token_round_trips(self):
        cursor = ReadCursor(REPORT, COLLECTION, 7, 12, 9)

        assert decode_cursor(encode_cursor(cursor)) == cursor
        assert "=" not in encode_cursor(cursor)

    @pytest.mark.parametrize("token", ["", "not a cursor", "e30", base64.urlsafe_b64encode(b'["a"]').decode()])
    def test_what_is_not_a_cursor_does_not_decode(self, token):
        assert decode_cursor(token) is None

    def test_an_edited_token_does_not_decode(self):
        raw = json.loads(base64.urlsafe_b64decode(encode_cursor(ReadCursor(REPORT, COLLECTION, 7, 12, 9)) + "=="))
        raw[2] = 1  # a cursor moved to page 1 by hand keeps the old checksum
        forged = base64.urlsafe_b64encode(json.dumps(raw).encode()).decode().rstrip("=")

        assert decode_cursor(forged) is None

    @pytest.mark.asyncio
    async def test_a_cursor_for_another_document_is_refused(self, harness):
        retriever = harness([_chunk(1, 0, "Eins.")], documents=(REPORT, OTHER))
        token = encode_cursor(ReadCursor(OTHER, COLLECTION, 1, 0, None))

        text = await _read(document=REPORT, cursor=token, conclusion="x")

        assert "does not belong to" in text and f'read_passage(document="{REPORT}"' in text
        assert retriever.calls == []

    @pytest.mark.asyncio
    async def test_a_garbage_cursor_is_refused_with_the_call_that_starts_over(self, harness):
        retriever = harness([_chunk(1, 0, "Eins.")])

        text = await _read(document=REPORT, cursor="AAAA", pages="2-3", conclusion="x")

        assert 'pages="2–3"' in text or 'pages="2-3"' in text
        assert retriever.calls == []

    @pytest.mark.asyncio
    async def test_a_cursor_cannot_move_the_read_to_another_collection(self, harness):
        """The collection a cursor names must be one the document resolves to in THIS turn's scope."""
        retriever = harness([_chunk(1, 0, "Eins.")])
        token = encode_cursor(ReadCursor(REPORT, "proj_somebody_else", 1, 0, None))

        text = await _read(document=REPORT, cursor=token, conclusion="x")

        assert "does not belong to" in text
        assert retriever.calls == []

    @pytest.mark.asyncio
    async def test_every_fetch_of_a_ranged_read_is_in_the_turns_own_scope(self, harness):
        retriever = harness([_chunk(1, 0, "Eins.")])
        token = encode_cursor(ReadCursor(REPORT, COLLECTION, 1, 0, None))

        await _read(document=REPORT, pages="1-2", conclusion="x")
        await _read(document=REPORT, cursor=token, conclusion="x")

        assert {call["collection"] for call in retriever.calls} == {COLLECTION}
        assert all(call["filters"]["$and"][0] == {"file_name": {"$eq": REPORT}} for call in retriever.calls)


class TestRepeatGuard:
    @staticmethod
    def _call(**args):
        return {"name": "read_passage", "args": {"document": REPORT, **args}, "id": "c"}

    def test_two_ranges_of_one_document_are_not_repeats(self):
        assert fetch_signature(self._call(pages="1-3")) != fetch_signature(self._call(pages="4-6"))

    def test_one_range_spelled_two_ways_is_a_repeat(self):
        assert fetch_signature(self._call(pages="4-6")) == fetch_signature(self._call(pages=" 4 – 6"))

    def test_a_cursor_is_part_of_the_identity(self):
        assert fetch_signature(self._call(pages="1-9", cursor="a")) != fetch_signature(self._call(pages="1-9"))
