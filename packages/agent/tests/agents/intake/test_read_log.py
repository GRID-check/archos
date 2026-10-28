"""A quote counts only when it stands in text this run read, in that file (ADR-0111)."""

from __future__ import annotations

import asyncio
import unicodedata

from agent.agents.intake.read_log import NOT_FOUND
from agent.agents.intake.read_log import IntakeReadLog
from agent.agents.intake.read_log import bind_read_log
from agent.agents.intake.read_log import current_read_log
from agent.agents.intake.read_log import reset_read_log


def _log() -> IntakeReadLog:
    log = IntakeReadLog()
    log.log("Baubeschreibung.pdf", 2, "Tragwerk: Das Gebäude wird in\nHolzbauweise   errichtet.")
    log.log("Baubeschreibung.pdf", 3, "Das Gebäude hat drei oberirdische Geschoße und ein Kellergeschoß.")
    return log


class TestContains:
    def test_a_quote_in_the_text_is_found_on_its_page(self):
        assert _log().contains("Baubeschreibung.pdf", "drei oberirdische Geschoße") == 3

    def test_whitespace_and_case_are_folded_on_both_sides(self):
        assert _log().contains("baubeschreibung.PDF", "das gebäude wird in HOLZBAUWEISE errichtet") == 2

    def test_unicode_forms_are_folded(self):
        """A decomposed „ä" in the model's quote matches the composed one the extractor wrote."""
        decomposed = unicodedata.normalize("NFD", "Das Gebäude hat drei")
        assert decomposed != "Das Gebäude hat drei"
        assert _log().contains("Baubeschreibung.pdf", decomposed) == 3

    def test_a_quote_not_in_the_text_is_not_found(self):
        assert _log().contains("Baubeschreibung.pdf", "vier oberirdische Geschoße") is NOT_FOUND

    def test_a_quote_from_another_file_is_not_found(self):
        assert _log().contains("Einreichplan.pdf", "drei oberirdische Geschoße") is NOT_FOUND

    def test_a_quote_across_a_page_break_is_filed_under_the_page_it_starts_on(self):
        assert _log().contains("Baubeschreibung.pdf", "Holzbauweise errichtet. Das Gebäude hat drei") == 2

    def test_the_page_the_model_named_wins_when_the_quote_stands_there_too(self):
        log = _log()
        log.log("Baubeschreibung.pdf", 7, "Das Gebäude hat drei oberirdische Geschoße.")
        assert log.contains("Baubeschreibung.pdf", "drei oberirdische Geschoße", page=7) == 7
        assert log.contains("Baubeschreibung.pdf", "drei oberirdische Geschoße") == 3

    def test_text_without_a_page_is_found_without_one(self):
        log = IntakeReadLog()
        log.log("Notiz.docx", None, "Bauweise: Massivbau")
        assert log.contains("Notiz.docx", "bauweise: massivbau") is None

    def test_an_empty_quote_is_never_found(self):
        assert _log().contains("Baubeschreibung.pdf", "   ") is NOT_FOUND


class TestClosest:
    def test_it_offers_the_words_read_that_come_closest_with_their_page(self):
        closest = _log().closest("Baubeschreibung.pdf", "vier oberirdische Geschoße")
        assert closest is not None and closest.page == 3
        assert "drei oberirdische Geschoße" in closest.text
        assert _log().contains("Baubeschreibung.pdf", closest.text) == 3, "the offer is itself a quote that passes"

    def test_it_offers_nothing_when_nothing_read_comes_close_or_the_file_was_not_read(self):
        assert _log().closest("Baubeschreibung.pdf", "Bundesland laut Grundbuch") is None
        assert _log().closest("Einreichplan.pdf", "drei oberirdische Geschoße") is None

    def test_the_page_the_model_named_wins_a_tie(self):
        log = _log()
        log.log("Baubeschreibung.pdf", 7, "Das Gebäude hat drei oberirdische Geschoße.")
        assert log.closest("Baubeschreibung.pdf", "vier oberirdische Geschoße", page=7).page == 7


class TestWhatWasRead:
    def test_opened_files_are_the_documents_read_and_a_search_hit_is_only_seen(self):
        log = _log()
        log.log("Einreichplan.pdf", 1, "Bundesland: Wien")
        log.mark_opened("Baubeschreibung.pdf")
        assert log.documents_read == ["Baubeschreibung.pdf"]
        assert set(log.files_seen) == {"Baubeschreibung.pdf", "Einreichplan.pdf"}

    def test_the_name_is_the_one_the_tools_spelled(self):
        assert _log().canonical_name("BAUBESCHREIBUNG.pdf") == "Baubeschreibung.pdf"
        assert _log().canonical_name("Unbekannt.pdf") is None


class TestPerRun:
    async def test_each_run_has_its_own_log_and_nothing_is_left_bound(self):
        async def run(text: str) -> list[str]:
            log, token = bind_read_log()
            try:
                current_read_log().log("A.pdf", 1, text)
                await asyncio.sleep(0)
                return [entry.text for entry in current_read_log()._texts[next(iter(current_read_log()._texts))]]
            finally:
                reset_read_log(token)

        first, second = await asyncio.gather(run("eins"), run("zwei"))
        assert (first, second) == (["eins"], ["zwei"])
        assert current_read_log() is None
