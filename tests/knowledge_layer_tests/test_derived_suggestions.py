"""Suggestions for documents ingested before the Fassung step existed, derived on read.

A document with no stored suggestion still shows one in the collection listing when the title blocks
(same ``document_number``, strictly later Index or date) or the revision grammar of the file names say it
is the current member of a series. Nothing is stored, no model is called, a dismissed or linked pair is
skipped, and a held or in-flight name is never named; when the job store cannot be read, nothing is.
"""

from __future__ import annotations

import pytest
from knowledge_layer.llamaindex import revisions

from agent.knowledge.schema import AvailableDocument
from agent.knowledge.schema import FileInfo
from agent.knowledge.schema import FileStatus
from agent_host.routes.documents import _merge_summaries


def _row(name, facts=None, **kwargs) -> AvailableDocument:
    return AvailableDocument(file_name=name, summary="Beschreibung.", revision_facts=facts, **kwargs)


def _held(names=()):
    return lambda: set(names)


B, C = "Grundriss_EG_Index_B.pdf", "Grundriss_EG_Index_C.pdf"


class TestByTheFileNames:
    def test_the_current_member_gets_the_newest_older_one(self):
        rows = [_row("Grundriss_EG_Index_A.pdf"), _row(B), _row(C)]

        derived = revisions.derive_suggestions(rows, _held())

        assert list(derived) == [C]
        assert derived[C] == {
            "of": B,
            "confidence": 0.9,
            "reason": "Index/Datum im Dateinamen: Index C nach Index B",
            "basis": "name",
        }

    def test_the_date_orders_a_series_without_an_index(self):
        rows = [_row("Statik_2026-05-01.pdf"), _row("Statik_2026-08-14.pdf")]
        derived = revisions.derive_suggestions(rows, _held())
        assert derived["Statik_2026-08-14.pdf"]["of"] == "Statik_2026-05-01.pdf"
        assert derived["Statik_2026-08-14.pdf"]["reason"] == "Index/Datum im Dateinamen: 14.08.2026 nach 01.05.2026"

    def test_one_state_twice_or_two_formats_are_no_series(self):
        assert revisions.derive_suggestions([_row("a_Index_B.pdf"), _row("a_Index_B.PDF")], _held()) == {}
        assert revisions.derive_suggestions([_row("a_Index_B.pdf"), _row("a_Index_C.dwg")], _held()) == {}

    def test_a_pair_a_person_dismissed_is_skipped(self):
        dismissed = {"of": B, "confidence": 0.9, "reason": "x", "basis": "name", "dismissed": True}
        assert revisions.derive_suggestions([_row(B), _row(C, revision_suggestion=dismissed)], _held()) == {}

    def test_a_dismissal_of_another_pair_does_not_block(self):
        elsewhere = {"of": "Anderes.pdf", "confidence": 0.9, "reason": "x", "basis": "name", "dismissed": True}
        derived = revisions.derive_suggestions([_row(B), _row(C, revision_suggestion=elsewhere)], _held())
        assert derived[C]["of"] == B

    def test_a_stored_open_suggestion_speaks_for_the_file(self):
        stored = {"of": "Entwurf.pdf", "confidence": 0.8, "reason": "x", "basis": "content", "dismissed": False}
        assert revisions.derive_suggestions([_row(B), _row(C, revision_suggestion=stored)], _held()) == {}

    def test_a_linked_pair_is_skipped(self):
        assert revisions.derive_suggestions([_row(B, superseded_by=C), _row(C, supersedes=[B])], _held()) == {}

    def test_an_older_member_already_replaced_by_another_is_passed_over(self):
        rows = [
            _row("Grundriss_EG_Index_A.pdf"),
            _row(B, superseded_by="Sonst.pdf"),
            _row(C),
        ]
        assert revisions.derive_suggestions(rows, _held())[C]["of"] == "Grundriss_EG_Index_A.pdf"

    def test_a_current_member_that_is_itself_replaced_gets_nothing(self):
        assert revisions.derive_suggestions([_row(B), _row(C, superseded_by="Neu.pdf")], _held()) == {}


class TestByTheTitleBlocks:
    def test_the_same_number_with_a_later_index_suggests_by_title_block_whatever_the_names(self):
        rows = [
            _row("Zeichnung 7.pdf", {"document_number": "A-101", "revision": "B"}),
            _row("Entwurf neu.pdf", {"document_number": "A 101", "revision": "C"}),
        ]

        derived = revisions.derive_suggestions(rows, _held())

        assert list(derived) == ["Entwurf neu.pdf"]
        assert derived["Entwurf neu.pdf"]["basis"] == "title_block"
        assert derived["Entwurf neu.pdf"]["of"] == "Zeichnung 7.pdf"
        assert derived["Entwurf neu.pdf"]["confidence"] == 0.95
        assert "Index C statt B" in derived["Entwurf neu.pdf"]["reason"]

    def test_the_sheets_beat_the_names(self):
        rows = [
            _row(C, {"document_number": "A-101", "revision": "B"}),
            _row(B, {"document_number": "A-101", "revision": "C"}),
        ]
        derived = revisions.derive_suggestions(rows, _held())
        assert list(derived) == [B] and derived[B]["of"] == C and derived[B]["basis"] == "title_block"

    def test_an_index_on_one_side_only_is_not_a_guess(self):
        rows = [
            _row("a.pdf", {"document_number": "A-101"}),
            _row("b.pdf", {"document_number": "A-101", "revision": "B"}),
        ]
        assert revisions.derive_suggestions(rows, _held()) == {}

    def test_the_same_state_twice_is_a_copy(self):
        facts = {"document_number": "A-101", "revision": "B"}
        assert revisions.derive_suggestions([_row("a.pdf", facts), _row("b.pdf", facts)], _held()) == {}

    def test_a_dismissed_or_linked_pair_is_skipped(self):
        older = {"document_number": "A-101", "revision": "B"}
        newer = {"document_number": "A-101", "revision": "C"}
        dismissed = {"of": "alt.pdf", "confidence": 0.9, "reason": "x", "basis": "title_block", "dismissed": True}
        assert (
            revisions.derive_suggestions(
                [_row("alt.pdf", older), _row("neu.pdf", newer, revision_suggestion=dismissed)], _held()
            )
            == {}
        )
        assert (
            revisions.derive_suggestions(
                [_row("alt.pdf", older, superseded_by="neu.pdf"), _row("neu.pdf", newer)], _held()
            )
            == {}
        )

    def test_it_covers_the_file_so_the_name_reading_does_not_speak_twice(self):
        rows = [
            _row(B, {"document_number": "A-101", "revision": "B"}),
            _row(C, {"document_number": "A-101", "revision": "C"}),
        ]
        assert revisions.derive_suggestions(rows, _held())[C]["basis"] == "title_block"


class TestHeldNames:
    def test_a_held_name_is_never_named(self):
        rows = [_row(B), _row(C)]
        assert revisions.derive_suggestions(rows, _held([B])) == {}
        assert revisions.derive_suggestions(rows, _held([C])) == {}

    def test_a_held_file_is_taken_out_before_the_pair_is_chosen(self):
        rows = [_row("Grundriss_EG_Index_A.pdf"), _row(B), _row(C)]
        assert revisions.derive_suggestions(rows, _held([B]))[C]["of"] == "Grundriss_EG_Index_A.pdf"

    def test_when_the_job_store_cannot_be_read_nothing_is_suggested(self):
        assert revisions.derive_suggestions([_row(B), _row(C)], lambda: None) == {}

    def test_the_job_store_is_not_read_when_there_is_nothing_to_suggest(self):
        def boom():
            raise AssertionError("read")

        assert revisions.derive_suggestions([_row("a.pdf"), _row("b.pdf")], boom) == {}


def _file(name: str) -> FileInfo:
    return FileInfo(file_id=name, file_name=name, collection_name="proj_a", status=FileStatus.SUCCESS)


class TestInTheListing:
    def test_a_file_without_a_stored_suggestion_gets_the_derived_one(self):
        files = [_file(B), _file(C)]

        _merge_summaries(files, [_row(B), _row(C)], _held())

        assert files[0].revision_suggestion is None
        assert files[1].revision_suggestion == {
            "of": B,
            "confidence": 0.9,
            "reason": "Index/Datum im Dateinamen: Index C nach Index B",
            "basis": "name",
        }

    def test_without_a_held_reader_nothing_is_derived(self):
        files = [_file(B), _file(C)]
        _merge_summaries(files, [_row(B), _row(C)])
        assert files[1].revision_suggestion is None

    def test_a_stored_suggestion_is_the_one_sent(self):
        stored = {"of": B, "confidence": 0.77, "reason": "Gespeichert.", "basis": "content", "dismissed": False}
        files = [_file(B), _file(C)]
        _merge_summaries(files, [_row(B), _row(C, revision_suggestion=stored)], _held())
        assert files[1].revision_suggestion["reason"] == "Gespeichert."

    @pytest.mark.parametrize("held", [[B], [C]])
    def test_a_held_name_is_not_sent(self, held):
        files = [_file(B), _file(C)]
        _merge_summaries(files, [_row(B), _row(C)], _held(held))
        assert all(f.revision_suggestion is None for f in files)

    def test_the_listing_route_reads_held_names_of_its_collection(self, monkeypatch):
        from agent_host.routes.documents import _held_names_of

        seen = []
        monkeypatch.setattr(revisions, "held_file_names", lambda collection: seen.append(collection) or {"x.pdf"})
        assert _held_names_of("proj_a")() == {"x.pdf"}
        assert seen == ["proj_a"]
