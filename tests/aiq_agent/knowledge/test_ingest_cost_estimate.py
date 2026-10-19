"""The ingest-cost estimate: its constants, its mechanism, and how it degrades.

The constants are pinned so a re-fit is a deliberate edit with the calibration
docstring beside it, and the mechanism is pinned at the boundaries the adapter
sets (100px, 64 rasters, 20 rendered pages, 500 OCR pages). The degradation
tests are the point of the module: a pre-read that could not see the images must
return "I cannot say", never a number that quietly omits 81% of the bill.
"""

from __future__ import annotations

from dataclasses import FrozenInstanceError

import pytest

from aiq_agent.knowledge.ingest_cost_estimate import CALIBRATION_SAMPLE_SIZE
from aiq_agent.knowledge.ingest_cost_estimate import DOCUMENT_USD_PER_DOCUMENT
from aiq_agent.knowledge.ingest_cost_estimate import EMBEDDING_TOKENS_PER_PAGE
from aiq_agent.knowledge.ingest_cost_estimate import EMBEDDING_USD_PER_1K_TOKENS
from aiq_agent.knowledge.ingest_cost_estimate import EMBEDDING_USD_PER_PAGE
from aiq_agent.knowledge.ingest_cost_estimate import LOGO_IMAGE_ALLOWANCE
from aiq_agent.knowledge.ingest_cost_estimate import MAX_IMAGES_PER_DOCUMENT
from aiq_agent.knowledge.ingest_cost_estimate import MAX_OCR_PAGES
from aiq_agent.knowledge.ingest_cost_estimate import MAX_RENDERED_PAGES
from aiq_agent.knowledge.ingest_cost_estimate import MIN_RASTER_PX
from aiq_agent.knowledge.ingest_cost_estimate import TRANSCRIPTION_USD_PER_CALL
from aiq_agent.knowledge.ingest_cost_estimate import UPPER_BOUND_MULTIPLIER
from aiq_agent.knowledge.ingest_cost_estimate import VISION_COMPLETION_TOKENS_PER_CALL
from aiq_agent.knowledge.ingest_cost_estimate import VISION_PROMPT_TOKENS_PER_CALL
from aiq_agent.knowledge.ingest_cost_estimate import VISION_USD_PER_CALL
from aiq_agent.knowledge.ingest_cost_estimate import IngestCostEstimate
from aiq_agent.knowledge.ingest_cost_estimate import PdfPreReadFacts
from aiq_agent.knowledge.ingest_cost_estimate import estimate_ingest_cost


def _facts(
    *,
    pages: int | None = 1,
    rasters: tuple[tuple[int, int], ...] | None = (),
    scanned: int | None = 0,
    drawings: int | None = 0,
) -> PdfPreReadFacts:
    return PdfPreReadFacts(
        page_count=pages,
        embedded_raster_sizes_px=rasters,
        scanned_pages=scanned,
        drawing_pages=drawings,
    )


class TestTheConstants:
    def test_raster_and_cap_constants_match_the_adapter(self):
        assert MIN_RASTER_PX == 100
        assert MAX_IMAGES_PER_DOCUMENT == 64
        assert LOGO_IMAGE_ALLOWANCE == 1
        assert MAX_RENDERED_PAGES == 20
        assert MAX_OCR_PAGES == 500

    def test_usd_constants_are_the_fitted_values(self):
        assert VISION_USD_PER_CALL == pytest.approx(0.008439)
        assert TRANSCRIPTION_USD_PER_CALL == pytest.approx(0.017218)
        assert DOCUMENT_USD_PER_DOCUMENT == pytest.approx(0.000228)
        assert UPPER_BOUND_MULTIPLIER == pytest.approx(4.0)

    def test_token_constants_are_the_fitted_values(self):
        assert EMBEDDING_TOKENS_PER_PAGE == 977
        assert EMBEDDING_USD_PER_1K_TOKENS == pytest.approx(0.00013)
        assert VISION_PROMPT_TOKENS_PER_CALL == 2993
        assert VISION_COMPLETION_TOKENS_PER_CALL == 1012

    def test_embedding_usd_per_page_is_tokens_priced(self):
        assert EMBEDDING_USD_PER_PAGE == pytest.approx(EMBEDDING_TOKENS_PER_PAGE * EMBEDDING_USD_PER_1K_TOKENS / 1000)

    def test_sample_size_is_recorded(self):
        assert CALIBRATION_SAMPLE_SIZE == 259


class TestTheMechanism:
    def test_a_text_page_pays_only_the_vectors_and_the_constant(self):
        estimate = estimate_ingest_cost(_facts(pages=1))
        assert estimate.vision_calls == 0
        assert estimate.transcription_calls == 0
        assert estimate.embedding_tokens == EMBEDDING_TOKENS_PER_PAGE
        assert estimate.expected_usd == pytest.approx(EMBEDDING_USD_PER_PAGE + DOCUMENT_USD_PER_DOCUMENT)

    def test_embedding_tokens_follow_the_page_count(self):
        assert estimate_ingest_cost(_facts(pages=10)).embedding_tokens == 10 * EMBEDDING_TOKENS_PER_PAGE

    def test_each_distinct_big_raster_past_the_logo_is_a_vision_call(self):
        rasters = ((200, 200), (300, 300), (400, 400))
        assert estimate_ingest_cost(_facts(rasters=rasters)).vision_calls == 3 - LOGO_IMAGE_ALLOWANCE

    def test_one_distinct_raster_is_forgiven_as_the_letterhead(self):
        assert estimate_ingest_cost(_facts(rasters=((400, 400),))).vision_calls == 0

    def test_repeated_rasters_of_one_size_are_counted_once(self):
        rasters = ((400, 400), (400, 400), (400, 400), (300, 300))
        assert estimate_ingest_cost(_facts(rasters=rasters)).vision_calls == 2 - LOGO_IMAGE_ALLOWANCE

    @pytest.mark.parametrize("small", [(99, 500), (500, 99), (99, 99), (1, 1)])
    def test_rasters_below_the_minimum_are_ignored(self, small):
        estimate = estimate_ingest_cost(_facts(rasters=(small,)))
        assert estimate.vision_calls == 0

    def test_the_image_cap_bounds_the_vision_calls(self):
        rasters = tuple((100 + i, 100 + i) for i in range(200))
        assert (
            estimate_ingest_cost(_facts(rasters=rasters)).vision_calls == MAX_IMAGES_PER_DOCUMENT - LOGO_IMAGE_ALLOWANCE
        )

    def test_a_raster_free_drawing_document_renders_pages(self):
        estimate = estimate_ingest_cost(_facts(rasters=(), drawings=5))
        assert estimate.vision_calls == 5

    def test_rendered_pages_are_capped(self):
        estimate = estimate_ingest_cost(_facts(rasters=(), drawings=MAX_RENDERED_PAGES + 10))
        assert estimate.vision_calls == MAX_RENDERED_PAGES

    def test_rendered_pages_add_nothing_when_rasters_already_pay(self):
        with_rasters = estimate_ingest_cost(_facts(rasters=((400, 400), (500, 500)), drawings=20))
        without_rasters = estimate_ingest_cost(_facts(rasters=(), drawings=20))
        assert with_rasters.vision_calls == 1
        assert without_rasters.vision_calls == 20

    def test_scanned_pages_drive_transcription(self):
        estimate = estimate_ingest_cost(_facts(scanned=61))
        assert estimate.transcription_calls == 61

    def test_transcription_is_capped(self):
        estimate = estimate_ingest_cost(_facts(scanned=MAX_OCR_PAGES + 100))
        assert estimate.transcription_calls == MAX_OCR_PAGES

    def test_negative_counts_are_read_as_zero(self):
        estimate = estimate_ingest_cost(_facts(pages=-3, rasters=(), scanned=-4, drawings=-5))
        assert estimate.vision_calls == 0
        assert estimate.transcription_calls == 0
        assert estimate.embedding_tokens == 0

    def test_tokens_follow_the_predicted_calls(self):
        estimate = estimate_ingest_cost(_facts(rasters=((200, 200), (300, 300), (400, 400))))
        assert estimate.vision_prompt_tokens == 2 * VISION_PROMPT_TOKENS_PER_CALL
        assert estimate.vision_completion_tokens == 2 * VISION_COMPLETION_TOKENS_PER_CALL

    def test_the_usd_sums_its_parts(self):
        estimate = estimate_ingest_cost(_facts(pages=4, rasters=((200, 200), (300, 300)), scanned=2))
        expected = (
            1 * VISION_USD_PER_CALL
            + 2 * TRANSCRIPTION_USD_PER_CALL
            + 4 * EMBEDDING_USD_PER_PAGE
            + DOCUMENT_USD_PER_DOCUMENT
        )
        assert estimate.expected_usd == pytest.approx(expected)

    def test_the_upper_bound_is_the_multiplier_and_never_below_the_estimate(self):
        estimate = estimate_ingest_cost(_facts(rasters=((200, 200), (300, 300))))
        assert estimate.upper_usd == pytest.approx(estimate.expected_usd * UPPER_BOUND_MULTIPLIER)
        assert estimate.upper_usd >= estimate.expected_usd


class TestDegradation:
    def test_unseen_images_yield_no_dollar_estimate(self):
        estimate = estimate_ingest_cost(_facts(rasters=None))
        assert estimate.expected_usd is None
        assert estimate.upper_usd is None
        assert estimate.is_coarse is True
        assert estimate.missing_inputs == ("embedded_raster_sizes_px",)

    def test_unseen_images_still_report_what_the_other_facts_give(self):
        estimate = estimate_ingest_cost(_facts(pages=10, rasters=None, scanned=2))
        assert estimate.embedding_tokens == 10 * EMBEDDING_TOKENS_PER_PAGE
        assert estimate.transcription_calls == 2

    def test_an_unseen_page_count_costs_only_the_vectors_and_the_constant(self):
        estimate = estimate_ingest_cost(_facts(pages=None, rasters=((200, 200), (300, 300))))
        assert estimate.expected_usd is not None
        assert estimate.embedding_tokens == 0
        assert estimate.is_coarse is True
        assert estimate.missing_inputs == ("page_count",)
        assert estimate.expected_usd == pytest.approx(1 * VISION_USD_PER_CALL + DOCUMENT_USD_PER_DOCUMENT)

    def test_an_unseen_scan_count_is_read_as_none(self):
        estimate = estimate_ingest_cost(_facts(scanned=None))
        assert estimate.transcription_calls == 0
        assert estimate.is_coarse is True
        assert estimate.missing_inputs == ("scanned_pages",)

    def test_an_unseen_drawing_count_is_read_as_none(self):
        estimate = estimate_ingest_cost(_facts(rasters=(), drawings=None))
        assert estimate.vision_calls == 0
        assert estimate.is_coarse is True
        assert estimate.missing_inputs == ("drawing_pages",)

    def test_every_missing_fact_is_named_in_report_order(self):
        estimate = estimate_ingest_cost(_facts(pages=None, rasters=None, scanned=None, drawings=None))
        assert estimate.missing_inputs == (
            "page_count",
            "embedded_raster_sizes_px",
            "scanned_pages",
            "drawing_pages",
        )

    def test_complete_facts_are_not_coarse(self):
        estimate = estimate_ingest_cost(_facts(pages=3, rasters=((200, 200),), scanned=0, drawings=0))
        assert estimate.is_coarse is False
        assert estimate.missing_inputs == ()

    def test_no_estimate_means_no_vision_tokens_either(self):
        estimate = estimate_ingest_cost(_facts(rasters=None))
        assert estimate.vision_prompt_tokens == 0
        assert estimate.vision_completion_tokens == 0


class TestPurity:
    def test_the_same_facts_give_the_same_estimate(self):
        facts = _facts(pages=2, rasters=((200, 200), (300, 300)), scanned=1)
        assert estimate_ingest_cost(facts) == estimate_ingest_cost(facts)

    def test_the_estimate_is_frozen(self):
        estimate = estimate_ingest_cost(_facts())
        assert isinstance(estimate, IngestCostEstimate)
        with pytest.raises(FrozenInstanceError):
            estimate.vision_calls = 99
