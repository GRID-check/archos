"""Fassungen on the metadata row: a person's link, Piloti's suggestion, the change line.

``superseded_by`` is written by a person's confirmation only and lives on the
OLDER document's row; ``revision_suggestion`` is Piloti's advice and hides
nothing; ``change_summary`` says what changed against the file named by
``change_basis``. All three ride the row the way ``topics`` and ``capture`` do:
optional columns, a re-register leaves them alone, an old table is migrated.
"""

import tempfile
from pathlib import Path

import pytest

from aiq_agent.knowledge.document_metadata_store import SUGGESTION_BASES
from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore
from aiq_agent.knowledge.document_metadata_store import LinkOutcome
from aiq_agent.knowledge.document_metadata_store import dismissed_fassungen

SUGGESTION = {
    "of": "Grundriss_EG_Index_B.pdf",
    "confidence": 0.85,
    "reason": "Gleicher Grundriss, Stiege verschoben.",
    "basis": "name",
    "dismissed": False,
    "dismissed_of": [],
}


@pytest.fixture
def temp_db():
    with tempfile.TemporaryDirectory() as tmpdir:
        db_url = f"sqlite:///{Path(tmpdir) / 'fassungen.db'}"
        yield db_url
        DocumentMetadataStore.dispose_engine(db_url)


@pytest.fixture
def store(temp_db):
    return DocumentMetadataStore(temp_db)


def _doc(store, name, collection="coll"):
    return {doc.file_name: doc for doc in store.get_all(collection)}[name]


@pytest.fixture
def pair(store):
    store.register("coll", "B.pdf", "Grundriss EG, Stiege im Süden.")
    store.register("coll", "C.pdf", "Grundriss EG, Stiege im Norden.")
    return store


class TestTheLink:
    def test_the_link_is_set_on_the_older_row_and_read_back_both_ways(self, pair):
        assert pair.set_superseded_by("coll", "B.pdf", "C.pdf") is True

        assert _doc(pair, "B.pdf").superseded_by == "C.pdf"
        assert _doc(pair, "C.pdf").superseded_by is None
        assert _doc(pair, "C.pdf").supersedes == ["B.pdf"]
        assert _doc(pair, "B.pdf").supersedes is None

    def test_none_lifts_the_link(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        assert pair.set_superseded_by("coll", "B.pdf", None) is True
        assert _doc(pair, "B.pdf").superseded_by is None
        assert _doc(pair, "C.pdf").supersedes is None

    def test_no_row_means_false_and_nothing_is_created(self, store):
        assert store.set_superseded_by("coll", "ghost.pdf", "C.pdf") is False
        assert store.get_all("coll") == []

    def test_one_newer_file_may_replace_several_older_ones(self, pair):
        pair.register("coll", "A.pdf", "Grundriss EG, erste Fassung.")
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.set_superseded_by("coll", "A.pdf", "C.pdf")
        assert _doc(pair, "C.pdf").supersedes == ["A.pdf", "B.pdf"]

    def test_a_link_to_a_file_with_no_row_is_not_read_as_a_link(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "gone.pdf")
        assert _doc(pair, "B.pdf").superseded_by is None

    def test_a_link_never_crosses_collections(self, pair):
        pair.register("other", "C.pdf", "Ein anderes Dokument gleichen Namens.")
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        assert _doc(pair, "C.pdf", "other").supersedes is None

    def test_deleting_the_newer_file_makes_the_older_current_again(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "C.pdf")
        assert _doc(pair, "B.pdf").superseded_by is None
        assert pair.get_superseded_files("coll") == {}

    def test_deleting_the_older_file_leaves_the_newer_without_a_stale_reverse(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "B.pdf")
        assert _doc(pair, "C.pdf").supersedes is None

    def test_a_re_register_of_either_file_keeps_the_link(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.register("coll", "B.pdf", "Neu gelesen.")
        pair.register("coll", "C.pdf", "Neu gelesen.")
        assert _doc(pair, "B.pdf").superseded_by == "C.pdf"
        assert _doc(pair, "C.pdf").supersedes == ["B.pdf"]

    def test_the_replaced_files_are_read_at_search_time_per_collection(self, pair):
        pair.register("other", "X.pdf", "x")
        pair.register("other", "Y.pdf", "y")
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.set_superseded_by("other", "X.pdf", "Y.pdf")
        assert pair.get_superseded_files("coll") == {"B.pdf": "C.pdf"}
        assert pair.get_superseded_files("other") == {"X.pdf": "Y.pdf"}
        assert pair.get_superseded_files("none") == {}

    def test_the_replaced_files_skip_a_link_whose_newer_file_has_no_row(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "gone.pdf")
        assert pair.get_superseded_files("coll") == {}

    def test_the_batch_getter_answers_only_rows_that_have_a_link(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        assert pair.get_superseded_by_batch("coll", ["B.pdf", "C.pdf", "ghost.pdf"]) == {"B.pdf": "C.pdf"}
        assert pair.get_superseded_by_batch("coll", []) == {}


class TestAPurgeThatCanBeUndone:
    """An archive, the folder bin and a publish purge a document and read it again later.

    A link only a person makes must come back with it: the row's own link, its refusals and the
    change line told against a linked Fassung are kept by name, and the links other rows hold to it
    are left alone (read as nothing while it is gone).
    """

    def test_the_older_files_link_comes_back_when_it_is_read_again(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")

        pair.unregister("coll", "B.pdf")
        assert "B.pdf" not in {doc.file_name for doc in pair.get_all("coll")}
        assert _doc(pair, "C.pdf").supersedes is None

        pair.register("coll", "B.pdf", "Wieder gelesen.")
        assert _doc(pair, "B.pdf").superseded_by == "C.pdf"
        assert _doc(pair, "C.pdf").supersedes == ["B.pdf"]
        assert pair.get_superseded_files("coll") == {"B.pdf": "C.pdf"}

    def test_the_newer_file_finds_the_link_to_it_untouched(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")

        pair.unregister("coll", "C.pdf")
        # While C is gone, B answers again: the link is read as nothing, not erased.
        assert _doc(pair, "B.pdf").superseded_by is None
        assert pair.get_superseded_files("coll") == {}

        pair.register("coll", "C.pdf", "Wieder gelesen.")
        assert _doc(pair, "B.pdf").superseded_by == "C.pdf"
        assert pair.get_superseded_files("coll") == {"B.pdf": "C.pdf"}

    def test_refusals_and_the_linked_change_line_come_back(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.set_change_summary("coll", "C.pdf", "- Stiege nach Norden", "B.pdf")
        pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf")

        pair.unregister("coll", "C.pdf")
        pair.register("coll", "C.pdf", "Wieder gelesen.")

        restored = _doc(pair, "C.pdf")
        assert (restored.change_summary, restored.change_basis) == ("- Stiege nach Norden", "B.pdf")
        assert restored.revision_suggestion["dismissed_of"] == ["A.pdf"]

    def test_what_a_person_did_not_make_is_read_again_not_kept(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        pair.set_change_summary("coll", "C.pdf", "- gegenüber dem Upload davor", "C.pdf")

        pair.unregister("coll", "C.pdf")
        pair.register("coll", "C.pdf", "Wieder gelesen.")

        restored = _doc(pair, "C.pdf")
        assert restored.revision_suggestion is None
        assert restored.change_summary is None and restored.change_basis is None

    def test_the_kept_facts_are_taken_back_once(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "B.pdf")
        pair.register("coll", "B.pdf", "Wieder gelesen.")
        pair.set_superseded_by("coll", "B.pdf", None)

        pair.register("coll", "B.pdf", "Noch einmal gelesen.")

        assert _doc(pair, "B.pdf").superseded_by is None

    def test_a_kept_link_that_would_now_close_a_loop_is_not_taken_back(self, pair):
        pair.register("coll", "X.pdf", "Grundriss EG, Variante.")
        pair.link_fassung("coll", "C.pdf", "X.pdf")  # X replaces C
        pair.unregister("coll", "C.pdf")  # C archived, keeps "replaced by X"
        pair.link_fassung("coll", "X.pdf", "B.pdf")  # meanwhile B replaces X ...
        pair.link_fassung("coll", "B.pdf", "C.pdf")  # ... and C (gone, read as nothing) replaces B

        pair.register("coll", "C.pdf", "Aus dem Archiv zurück.")

        # C -> X -> B -> C would be a loop: the links made while C was gone stand.
        assert _doc(pair, "C.pdf").superseded_by is None
        assert _doc(pair, "B.pdf").superseded_by == "C.pdf"

    def test_kept_facts_never_cross_collections(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "B.pdf")

        pair.register("other", "B.pdf", "Gleicher Name, anderes Projekt.")
        pair.register("other", "C.pdf", "Gleicher Name, anderes Projekt.")

        assert _doc(pair, "B.pdf", "other").superseded_by is None

    def test_a_permanent_delete_keeps_nothing_and_frees_what_it_replaced(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.set_change_summary("coll", "C.pdf", "- Stiege nach Norden", "B.pdf")

        pair.unregister("coll", "C.pdf", permanent=True)
        pair.register("coll", "C.pdf", "Ein neues Dokument gleichen Namens.")

        assert _doc(pair, "C.pdf").change_summary is None
        assert _doc(pair, "B.pdf").superseded_by is None
        assert pair.get_superseded_files("coll") == {}

    def test_a_permanent_delete_also_frees_a_kept_link_to_it(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "B.pdf")  # archived, may come back

        pair.unregister("coll", "C.pdf", permanent=True)  # erased
        pair.register("coll", "C.pdf", "Ein neues Dokument gleichen Namens.")
        pair.register("coll", "B.pdf", "Aus dem Archiv zurück.")

        assert _doc(pair, "B.pdf").superseded_by is None

    def test_clearing_the_collection_forgets_what_was_kept(self, pair):
        pair.set_superseded_by("coll", "B.pdf", "C.pdf")
        pair.unregister("coll", "B.pdf")

        pair.clear_collection("coll")
        pair.register("coll", "B.pdf", "Neu.")
        pair.register("coll", "C.pdf", "Neu.")

        assert _doc(pair, "B.pdf").superseded_by is None


class TestRefusals:
    """Every file a person refused stays refused, whatever is suggested or refused afterwards."""

    def test_refusing_a_second_file_keeps_the_first_refusal(self, pair):
        assert pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf") is True
        assert pair.dismiss_revision_suggestion("coll", "C.pdf", "B.pdf") is True

        stored = _doc(pair, "C.pdf").revision_suggestion
        assert stored["dismissed_of"] == ["A.pdf", "B.pdf"]
        assert stored["of"] == "B.pdf" and stored["dismissed"] is True

    def test_refusing_another_file_leaves_the_open_suggestion_open(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)

        pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf")

        stored = _doc(pair, "C.pdf").revision_suggestion
        assert stored["of"] == SUGGESTION["of"] and stored["dismissed"] is False
        assert stored["dismissed_of"] == ["A.pdf"]

    def test_refusing_the_suggested_file_keeps_its_reason(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)

        pair.dismiss_revision_suggestion("coll", "C.pdf", SUGGESTION["of"])

        assert _doc(pair, "C.pdf").revision_suggestion == {
            **SUGGESTION,
            "dismissed": True,
            "dismissed_of": [SUGGESTION["of"]],
        }

    def test_a_new_suggestion_keeps_the_refusals_and_a_refused_one_is_stored_dismissed(self, pair):
        pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf")

        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        assert _doc(pair, "C.pdf").revision_suggestion["dismissed_of"] == ["A.pdf"]
        assert _doc(pair, "C.pdf").revision_suggestion["dismissed"] is False

        pair.set_revision_suggestion("coll", "C.pdf", {**SUGGESTION, "of": "A.pdf"})
        assert _doc(pair, "C.pdf").revision_suggestion["dismissed"] is True

    def test_clearing_the_suggestion_keeps_the_refusals(self, pair):
        pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf")
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)

        pair.set_revision_suggestion("coll", "C.pdf", None)

        stored = _doc(pair, "C.pdf").revision_suggestion
        assert stored["dismissed_of"] == ["A.pdf"] and stored["dismissed"] is True

    def test_a_record_written_before_the_list_still_reads_as_one_refusal(self):
        raw = '{"of": "B.pdf", "confidence": 0.9, "reason": "Gleich.", "basis": "name", "dismissed": true}'
        assert DocumentMetadataStore._decode_suggestion(raw)["dismissed_of"] == ["B.pdf"]
        assert dismissed_fassungen({"of": "B.pdf", "dismissed": True}) == ["B.pdf"]
        assert dismissed_fassungen({"of": "B.pdf", "dismissed": False}) == []
        assert dismissed_fassungen(None) == []

    def test_no_row_means_false(self, store):
        assert store.dismiss_revision_suggestion("coll", "ghost.pdf", "B.pdf") is False


class TestTheLinkIsOneStep:
    """The loop check and the write happen under one lock, so concurrent confirmations cannot close a loop."""

    def test_a_loop_is_refused_and_nothing_is_written(self, pair):
        assert pair.link_fassung("coll", "B.pdf", "C.pdf") is LinkOutcome.LINKED
        assert pair.link_fassung("coll", "C.pdf", "B.pdf") is LinkOutcome.LOOP
        assert _doc(pair, "C.pdf").superseded_by is None

    def test_an_older_file_without_a_row_is_missing(self, pair):
        assert pair.link_fassung("coll", "ghost.pdf", "C.pdf") is LinkOutcome.MISSING

    def test_concurrent_opposite_confirmations_store_one_link(self, pair):
        import threading

        for _ in range(20):
            pair.set_superseded_by("coll", "B.pdf", None)
            pair.set_superseded_by("coll", "C.pdf", None)
            barrier = threading.Barrier(2)
            outcomes = []

            def confirm(older, newer):
                barrier.wait()
                outcomes.append(pair.link_fassung("coll", older, newer))

            threads = [
                threading.Thread(target=confirm, args=("B.pdf", "C.pdf")),
                threading.Thread(target=confirm, args=("C.pdf", "B.pdf")),
            ]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()

            assert sorted(outcomes) == sorted([LinkOutcome.LINKED, LinkOutcome.LOOP])
            links = {doc.file_name: doc.superseded_by for doc in pair.get_all("coll")}
            assert sum(1 for newer in links.values() if newer) == 1

    def test_re_pointing_drops_the_change_line_the_former_replacement_told_against_it(self, pair):
        pair.register("coll", "D.pdf", "Grundriss EG, noch neuer.")
        pair.link_fassung("coll", "B.pdf", "C.pdf")
        pair.set_change_summary("coll", "C.pdf", "- Stiege nach Norden", "B.pdf")

        pair.link_fassung("coll", "B.pdf", "D.pdf")

        assert _doc(pair, "B.pdf").superseded_by == "D.pdf"
        assert _doc(pair, "C.pdf").change_summary is None

    def test_re_pointing_keeps_a_change_line_told_against_another_file(self, pair):
        pair.register("coll", "D.pdf", "Grundriss EG, noch neuer.")
        pair.link_fassung("coll", "B.pdf", "C.pdf")
        pair.set_change_summary("coll", "C.pdf", "- gegenüber dem Upload davor", "C.pdf")

        pair.link_fassung("coll", "B.pdf", "D.pdf")

        assert _doc(pair, "C.pdf").change_summary == "- gegenüber dem Upload davor"

    def test_the_suggestion_that_named_the_older_file_is_cleared_and_refusals_stay(self, pair):
        pair.dismiss_revision_suggestion("coll", "C.pdf", "A.pdf")
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION | {"of": "B.pdf"})

        pair.link_fassung("coll", "B.pdf", "C.pdf")

        stored = _doc(pair, "C.pdf").revision_suggestion
        assert stored["of"] == "A.pdf" and stored["dismissed"] is True


class TestTheSuggestion:
    def test_it_round_trips_as_the_six_keys(self, pair):
        assert pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION) is True
        assert _doc(pair, "C.pdf").revision_suggestion == SUGGESTION

    def test_a_suggestion_links_nothing(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        assert _doc(pair, "B.pdf").superseded_by is None
        assert _doc(pair, "C.pdf").supersedes is None
        assert pair.get_superseded_files("coll") == {}

    def test_none_clears_it(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        assert pair.set_revision_suggestion("coll", "C.pdf", None) is True
        assert _doc(pair, "C.pdf").revision_suggestion is None

    def test_a_dismissal_is_kept_with_the_suggestion(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", {**SUGGESTION, "dismissed": True})
        assert _doc(pair, "C.pdf").revision_suggestion["dismissed"] is True

    def test_no_row_means_false(self, store):
        assert store.set_revision_suggestion("coll", "ghost.pdf", SUGGESTION) is False

    @pytest.mark.parametrize(
        "broken",
        [
            {**SUGGESTION, "of": ""},
            {**SUGGESTION, "of": None},
            {**SUGGESTION, "confidence": 1.5},
            {**SUGGESTION, "confidence": -0.1},
            {**SUGGESTION, "confidence": True},
            {**SUGGESTION, "confidence": "0.9"},
            {**SUGGESTION, "confidence": float("nan")},
            {**SUGGESTION, "reason": "  "},
            {**SUGGESTION, "basis": "guess"},
            {k: v for k, v in SUGGESTION.items() if k != "basis"},
            "not a dict",
        ],
    )
    def test_an_invalid_suggestion_is_refused_and_stores_nothing(self, pair, broken):
        assert pair.set_revision_suggestion("coll", "C.pdf", broken) is False
        assert _doc(pair, "C.pdf").revision_suggestion is None

    def test_the_decoder_keeps_only_the_six_keys(self):
        decoded = DocumentMetadataStore._decode_suggestion(
            '{"of": "B.pdf", "confidence": 1, "reason": "Gleich.", "basis": "content", "extra": "x"}'
        )
        assert decoded == {
            "of": "B.pdf",
            "confidence": 1.0,
            "reason": "Gleich.",
            "basis": "content",
            "dismissed": False,
            "dismissed_of": [],
        }

    @pytest.mark.parametrize("raw", [None, "", "not json", "[1]", '{"of": "B.pdf"}'])
    def test_the_decoder_fails_open(self, raw):
        assert DocumentMetadataStore._decode_suggestion(raw) is None

    def test_the_bases_are_title_block_name_and_content(self):
        assert SUGGESTION_BASES == ("title_block", "name", "content")

    def test_the_raw_batch_getter_returns_the_stored_json(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        raw = pair.get_revision_suggestions_batch("coll", ["B.pdf", "C.pdf"])
        assert list(raw) == ["C.pdf"]
        assert DocumentMetadataStore._decode_suggestion(raw["C.pdf"]) == SUGGESTION

    def test_a_re_register_keeps_it(self, pair):
        pair.set_revision_suggestion("coll", "C.pdf", SUGGESTION)
        pair.register("coll", "C.pdf", "Neu gelesen.")
        assert _doc(pair, "C.pdf").revision_suggestion == SUGGESTION


class TestTheChangeLine:
    def test_summary_and_basis_are_written_together(self, pair):
        assert pair.set_change_summary("coll", "C.pdf", "- Stiege nach Norden", "B.pdf") is True
        doc = _doc(pair, "C.pdf")
        assert (doc.change_summary, doc.change_basis) == ("- Stiege nach Norden", "B.pdf")

    def test_clearing_the_summary_clears_the_basis_too(self, pair):
        pair.set_change_summary("coll", "C.pdf", "- x", "B.pdf")
        pair.set_change_summary("coll", "C.pdf", None, "B.pdf")
        doc = _doc(pair, "C.pdf")
        assert (doc.change_summary, doc.change_basis) == (None, None)

    def test_a_blank_summary_is_no_summary(self, pair):
        pair.set_change_summary("coll", "C.pdf", "   ", "B.pdf")
        assert _doc(pair, "C.pdf").change_summary is None

    def test_no_row_means_false(self, store):
        assert store.set_change_summary("coll", "ghost.pdf", "- x", "B.pdf") is False

    def test_a_re_register_keeps_it(self, pair):
        pair.set_change_summary("coll", "C.pdf", "- x", "B.pdf")
        pair.register("coll", "C.pdf", "Neu gelesen.")
        assert _doc(pair, "C.pdf").change_summary == "- x"


class TestTheSchema:
    def test_a_fresh_table_has_the_four_columns(self, temp_db):
        from sqlalchemy import create_engine
        from sqlalchemy import inspect

        DocumentMetadataStore(temp_db)
        engine = create_engine(temp_db)
        columns = {c["name"] for c in inspect(engine).get_columns("document_metadata")}
        assert {"superseded_by", "revision_suggestion", "change_summary", "change_basis"} <= columns
        engine.dispose()

    def test_an_existing_table_without_them_is_migrated_and_keeps_its_rows(self):
        from sqlalchemy import create_engine
        from sqlalchemy import inspect
        from sqlalchemy import text

        with tempfile.TemporaryDirectory() as tmpdir:
            db_url = f"sqlite:///{Path(tmpdir) / 'before_fassungen.db'}"
            engine = create_engine(db_url)
            with engine.connect() as conn:
                conn.execute(
                    text(
                        "CREATE TABLE document_metadata ("
                        "collection VARCHAR(256) NOT NULL, filename VARCHAR(512) NOT NULL, "
                        "summary TEXT NOT NULL, tags TEXT, doc_class TEXT, display_title TEXT, folder_path TEXT, "
                        "provenance TEXT, doc_class_suggestion TEXT, tags_set_by TEXT, topics TEXT, capture TEXT, "
                        "created_at DATETIME, PRIMARY KEY (collection, filename))"
                    )
                )
                conn.execute(
                    text(
                        "INSERT INTO document_metadata (collection, filename, summary) VALUES ('c', 'old.pdf', 'Alt.')"
                    )
                )
                conn.commit()
            assert "superseded_by" not in {c["name"] for c in inspect(engine).get_columns("document_metadata")}

            DocumentMetadataStore._tables_initialized.discard(db_url)
            store = DocumentMetadataStore(db_url)

            columns = {c["name"] for c in inspect(engine).get_columns("document_metadata")}
            assert {"superseded_by", "revision_suggestion", "change_summary", "change_basis"} <= columns
            old = store.get_all("c")[0]
            assert old.summary == "Alt."
            assert old.superseded_by is None and old.revision_suggestion is None and old.change_summary is None
            assert store.set_change_summary("c", "old.pdf", "- x", "old.pdf") is True

            engine.dispose()
            DocumentMetadataStore.dispose_engine(db_url)


class TestThroughTheFactory:
    """The seams the ingestion path and the route call, over one store."""

    @pytest.fixture
    def db_url(self):
        from aiq_agent.knowledge import configure_summary_db
        from aiq_agent.knowledge import factory

        with tempfile.TemporaryDirectory() as tmpdir:
            url = f"sqlite:///{Path(tmpdir) / 'factory_fassungen.db'}"
            configure_summary_db(url)
            yield url
            factory._document_metadata_store = None
            DocumentMetadataStore.dispose_engine(url)

    def test_the_seams_round_trip_and_the_available_documents_carry_the_facts(self, db_url):
        from aiq_agent.knowledge import get_available_documents
        from aiq_agent.knowledge import get_document_revision_suggestions
        from aiq_agent.knowledge import get_document_superseded_by
        from aiq_agent.knowledge import get_superseded_files
        from aiq_agent.knowledge import register_summary
        from aiq_agent.knowledge import set_document_change_summary
        from aiq_agent.knowledge import set_document_revision_suggestion
        from aiq_agent.knowledge import set_document_superseded_by

        register_summary("coll", "B.pdf", "Alt.")
        register_summary("coll", "C.pdf", "Neu.")

        assert set_document_superseded_by("coll", "B.pdf", "C.pdf") is True
        assert set_document_revision_suggestion("coll", "C.pdf", SUGGESTION) is True
        assert set_document_change_summary("coll", "C.pdf", "- Neu", "B.pdf") is True

        docs = {doc.file_name: doc for doc in get_available_documents("coll")}
        assert docs["B.pdf"].superseded_by == "C.pdf"
        assert docs["C.pdf"].supersedes == ["B.pdf"]
        assert docs["C.pdf"].revision_suggestion == SUGGESTION
        assert docs["C.pdf"].change_summary == "- Neu"
        assert get_superseded_files("coll") == {"B.pdf": "C.pdf"}
        assert get_document_superseded_by("coll", ["B.pdf", "C.pdf"]) == {"B.pdf": "C.pdf"}
        assert list(get_document_revision_suggestions("coll", ["B.pdf", "C.pdf"])) == ["C.pdf"]
