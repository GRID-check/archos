"""OCR debris in the ranked search (``chunk_noise``), and the switch that keeps it out.

The fixtures in ``tests/fixtures/ocr_noise`` are passages captured from a live
``knowledge_search`` for "Brandabschnitt Gebäudeklasse 5 Wohngebäude" over the
OIB corpus (2026-10): the drawing debris of the Erläuterungen zu OIB-RL 2, the
chunks it sits in, and ordinary passages, lists and tables as text.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from knowledge_layer import chunk_noise
from knowledge_layer.chunk_noise import MIN_DEBRIS_SHARE
from knowledge_layer.chunk_noise import is_noise_chunk
from knowledge_layer.chunk_noise import judge_text
from knowledge_layer.chunk_noise import noise_filter_enabled
from knowledge_layer.chunk_noise import without_noise
from knowledge_layer.fusion import pool_without_noise
from knowledge_layer.register import KnowledgeRetrievalConfig
from knowledge_layer.register import knowledge_retrieval

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.schema import Chunk
from aiq_agent.knowledge.schema import ContentType
from aiq_agent.knowledge.schema import RetrievalResult
from aiq_agent.knowledge.scoping import ScopedCollection

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "ocr_noise"


def _fixture(name: str) -> str:
    return (FIXTURES / f"{name}.txt").read_text(encoding="utf-8")


# The two strings the search returned as hits of their own weight, verbatim.
ROTATED_WALL_LABELS = "06\nIE\n/\n06\nIER\ndnaW\n06\nIE\n/"
SPACED_CAPITALS = "2 i n n A sg n e z s . a W m H t G s . 4 / 0 0 B E m 2 · : c < C > : U : l , l"


class TestTheScorer:
    @pytest.mark.parametrize("name", ["noise_rotated_wall_labels", "noise_shredded_building_class_labels"])
    def test_drawing_debris_is_noise(self, name):
        assert judge_text(_fixture(name)).is_noise

    def test_the_quoted_debris_lines_are_all_debris(self):
        for text in (ROTATED_WALL_LABELS, SPACED_CAPITALS):
            verdict = judge_text(text)
            assert verdict.debris_glyphs == verdict.glyphs

    def test_a_long_run_of_the_quoted_debris_is_noise(self):
        assert judge_text("\n".join([ROTATED_WALL_LABELS] * 4)).is_noise
        assert judge_text("\n".join([SPACED_CAPITALS] * 3)).is_noise

    @pytest.mark.parametrize("name", ["prose_clause_with_list", "prose_category_list"])
    def test_ordinary_german_legal_text_is_not_noise(self, name):
        verdict = judge_text(_fixture(name))
        assert not verdict.is_noise
        assert verdict.debris_share < 0.05

    @pytest.mark.parametrize(
        "name",
        [
            "table_as_text_building_classes",
            "table_as_text_fire_resistance",
            "table_as_text_roofs",
            "table_as_text_values_only",
        ],
    )
    def test_a_table_read_as_text_is_not_noise(self, name):
        verdict = judge_text(_fixture(name))
        assert not verdict.is_noise
        assert verdict.debris_share < 0.1

    @pytest.mark.parametrize(
        "name", ["mixed_wall_labels_then_prose", "mixed_building_class_figures", "mixed_prose_then_drawing_debris"]
    )
    def test_debris_around_a_real_paragraph_keeps_the_passage(self, name):
        # The paragraph about Brandabschnitte in Wohnnutzung sits under forty lines of `06`/`IE`:
        # glyph-weighted, the passage is what it says, not how many lines its drawing took.
        assert not judge_text(_fixture(name)).is_noise

    @pytest.mark.parametrize(
        "text", ["OIB-Richtlinie 2 — Brandschutz\n3.1 Brandabschnitte", "Zu Punkt 3.1.1", "a)", ""]
    )
    def test_a_heading_or_a_fragment_is_too_short_to_judge(self, text):
        assert not judge_text(text).is_noise

    def test_a_garbled_text_layer_is_noise_as_page_triage_measures_it(self):
        text = "(cid:37)(cid:68)(cid:88)(cid:69)(cid:72)(cid:86)(cid:70)(cid:75)(cid:72)(cid:76)(cid:71) " * 12

        verdict = judge_text(text)

        assert verdict.garbled
        assert verdict.is_noise

    def test_the_limit_sits_between_the_measured_populations(self):
        noise = [
            judge_text(_fixture(n)).debris_share
            for n in ("noise_rotated_wall_labels", "noise_shredded_building_class_labels")
        ]
        text = [
            judge_text(_fixture(n)).debris_share
            for n in ("prose_clause_with_list", "table_as_text_building_classes", "mixed_building_class_figures")
        ]
        assert max(text) < MIN_DEBRIS_SHARE <= min(noise)


def _chunk(chunk_id: str, content: str, *, content_type: ContentType = ContentType.TEXT, page: int = 1) -> Chunk:
    return Chunk(
        chunk_id=chunk_id,
        content=content,
        score=0.6,
        file_name="erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf",
        page_number=page,
        display_citation=f"erlaeuterungen_oib-rl_2_ausgabe_mai_2023.pdf, p.{page}",
        content_type=content_type,
        metadata={"collection": PROJECT, "page_label": str(page)},
    )


class TestWhichChunksAreJudged:
    def test_a_text_chunk_of_debris_is_noise(self):
        assert is_noise_chunk(_chunk("n", _fixture("noise_rotated_wall_labels")))

    @pytest.mark.parametrize("kind", [ContentType.DRAWING, ContentType.CHART, ContentType.TABLE, ContentType.IMAGE])
    def test_a_visual_or_table_chunk_is_never_judged(self, kind):
        assert not is_noise_chunk(_chunk("v", _fixture("noise_rotated_wall_labels"), content_type=kind))

    def test_a_passage_left_out_of_the_first_and_the_widened_pool_counts_once(self):
        # A requery widens the pool: the debris left out of the first pool still
        # counts though the fusion may drop it, and one left out of both counts once.
        shared = _chunk("n1", _fixture("noise_rotated_wall_labels"))
        first_only = _chunk("n2", _fixture("noise_shredded_building_class_labels"))
        widened_only = _chunk("n3", ROTATED_WALL_LABELS * 8)
        prose = _chunk("a", _fixture("prose_clause_with_list"))

        def pool(*chunks):
            return RetrievalResult(chunks=list(chunks), query="q", backend="test")

        _, first = pool_without_noise(pool(shared, first_only, prose), enabled=True)
        _, widened = pool_without_noise(pool(shared, widened_only, prose), enabled=True)

        assert len(first | widened) == 3

    def test_without_noise_keeps_the_order_and_counts_what_went(self):
        a, noise, b = (
            _chunk("a", _fixture("prose_clause_with_list")),
            _chunk("n", _fixture("noise_rotated_wall_labels")),
            _chunk("b", _fixture("prose_category_list")),
        )

        kept, dropped = without_noise([a, noise, b])

        assert [chunk.chunk_id for chunk in kept] == ["a", "b"]
        assert dropped == 1


class TestTheSwitch:
    def test_off_by_default(self, monkeypatch):
        monkeypatch.delenv(chunk_noise.DROP_OCR_NOISE_ENV, raising=False)
        assert KnowledgeRetrievalConfig().drop_ocr_noise is None
        assert noise_filter_enabled(None) is False

    @pytest.mark.parametrize(
        ("value", "expected"), [("true", True), ("1", True), ("on", True), ("false", False), ("", False)]
    )
    def test_the_environment_decides_when_the_config_does_not(self, monkeypatch, value, expected):
        monkeypatch.setenv(chunk_noise.DROP_OCR_NOISE_ENV, value)
        assert noise_filter_enabled(None) is expected

    def test_the_config_wins_over_the_environment(self, monkeypatch):
        monkeypatch.setenv(chunk_noise.DROP_OCR_NOISE_ENV, "true")
        assert noise_filter_enabled(False) is False


# ---------------------------------------------------------------------------
# Through the tool
# ---------------------------------------------------------------------------

PROJECT = "proj_1"


class _Retriever:
    backend_name = "fake"
    embed_model_name = "fake-embedder"

    def __init__(self, pool: list[Chunk]):
        self.pool = pool
        self.top_k: list[int] = []

    async def retrieve(self, query, collection_name, top_k, filters=None):
        self.top_k.append(top_k)
        chunks = [chunk.model_copy(deep=True) for chunk in self.pool[:top_k]] if collection_name == PROJECT else []
        return RetrievalResult(chunks=chunks, query=query, backend="fake", success=True)

    async def find_text(self, collection_name, pattern, filters=None, limit=500, **_options):
        if collection_name != PROJECT:
            return []
        return [chunk.model_copy(deep=True) for chunk in self.pool if "dnaW" in chunk.content][:limit]

    async def candidate_counts(self, *args, **kwargs):
        return None


def _pool() -> list[Chunk]:
    # Debris ranked first, as on the live search, then the passages it pushed out.
    return [
        _chunk("noise-1", _fixture("noise_rotated_wall_labels"), page=10),
        _chunk("prose-1", _fixture("prose_clause_with_list"), page=11),
        _chunk("noise-2", _fixture("noise_shredded_building_class_labels"), page=12),
        _chunk(
            "drawing-1",
            "[DRAWING from page 24]\n\nGebäude der GK 5 mit drei Brandabschnitten.",
            content_type=ContentType.DRAWING,
            page=24,
        ),
        _chunk("mixed-1", _fixture("mixed_wall_labels_then_prose"), page=13),
        _chunk("prose-2", _fixture("prose_category_list"), page=14),
        _chunk("table-1", _fixture("table_as_text_fire_resistance"), page=15),
    ]


@pytest.fixture
def harness(monkeypatch):
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)
    monkeypatch.setattr("knowledge_layer.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr("aiq_agent.knowledge.get_superseded_files", lambda collection: {})
    for name in ("get_document_doc_classes", "get_document_display_titles", "get_document_folder_paths"):
        monkeypatch.setattr(f"aiq_agent.knowledge.factory.{name}", lambda _c, _f: {})
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection(PROJECT, Shelf.PROJECT)],
    )
    monkeypatch.delenv(chunk_noise.DROP_OCR_NOISE_ENV, raising=False)
    spans: list[dict] = []

    def _capture(*, tool_name, search_input, picks):
        spans.append(dict(search_input))

    monkeypatch.setattr("aiq_agent.observability.retrieval_trace.emit_retrieval_span", _capture)
    retriever = _Retriever(_pool())
    monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: retriever)
    set_turn_documents([])
    yield SimpleNamespace(spans=spans, retriever=retriever)
    set_turn_documents(None)


async def _search(drop_ocr_noise: bool | None, **kwargs) -> str:
    config = KnowledgeRetrievalConfig(
        collection_name="oib_knowledge",
        include_session_collection=False,
        project_collections=[PROJECT],
        top_k=4,
        max_chunks_per_document=0,
        drop_ocr_noise=drop_ocr_noise,
    )
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(**kwargs))


def _cited_pages(out: str) -> list[str]:
    return [line.rsplit("p.", 1)[1] for line in out.splitlines() if line.startswith("Citation: ")]


class TestThroughTheTool:
    async def test_off_the_search_is_byte_identical_to_no_filter(self, harness):
        unset = await _search(None, query="Brandabschnitt Gebäudeklasse 5 Wohngebäude")
        off = await _search(False, query="Brandabschnitt Gebäudeklasse 5 Wohngebäude")

        assert off == unset
        assert _cited_pages(off) == ["10", "11", "12", "24"]
        assert set(harness.retriever.top_k) == {4}
        assert "OCR debris" not in off
        assert all("dropped_as_noise" not in span for span in harness.spans)

    async def test_on_the_debris_goes_and_real_passages_take_its_slots(self, harness):
        out = await _search(True, query="Brandabschnitt Gebäudeklasse 5 Wohngebäude")

        assert _cited_pages(out) == ["11", "24", "13", "14"]
        assert max(harness.retriever.top_k) == 3 * 4  # headroom, so the freed slots are refilled
        assert out.startswith("Left out 2 passage(s) whose text is OCR debris")
        assert harness.spans[-1]["dropped_as_noise"] == 2

    async def test_on_with_nothing_to_drop_the_span_says_zero(self, harness, monkeypatch):
        clean = [chunk for chunk in _pool() if not chunk.chunk_id.startswith("noise")]
        monkeypatch.setattr("knowledge_layer.register._get_retriever", lambda config: _Retriever(clean))

        out = await _search(True, query="Brandabschnitt")

        assert "OCR debris" not in out
        assert harness.spans[-1]["dropped_as_noise"] == 0

    async def test_an_exact_match_keeps_every_passage_with_the_filter_on(self, harness):
        off = await _search(False, query="dnaW", match="exact")
        on = await _search(True, query="dnaW", match="exact")

        assert on == off
        assert "p.10" in on
        assert "OCR debris" not in on
