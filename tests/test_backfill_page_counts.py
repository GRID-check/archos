"""Tests for the page-count backfill script's pure core and its per-file driver.

``largest_page`` is the whole answer: the highest page a file's chunks reach. The driver is
exercised with fake readers and writers, so no Qdrant or summaries database is needed.
"""

import importlib.util
import sys
from pathlib import Path

from aiq_agent.knowledge.schema import AvailableDocument

REPO_ROOT = Path(__file__).resolve().parents[1]


def _load_backfill():
    """Import ``scripts/backfill_page_counts.py`` without requiring a package."""
    if str(REPO_ROOT) not in sys.path:
        sys.path.insert(0, str(REPO_ROOT))
    spec = importlib.util.spec_from_file_location(
        "scripts.backfill_page_counts",
        REPO_ROOT / "scripts" / "backfill_page_counts.py",
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


backfill = _load_backfill()


class TestLargestPage:
    def test_highest_page_label_wins_over_order_of_chunks(self):
        payloads = [{"page_label": "2"}, {"page_label": "14"}, {"page_label": "9"}]
        assert backfill.largest_page(payloads) == 14

    def test_page_end_of_a_spanning_chunk_counts(self):
        payloads = [{"page_label": "3", "page_end": "6"}, {"page_label": "4"}]
        assert backfill.largest_page(payloads) == 6

    def test_a_chunk_starting_early_but_spanning_furthest_is_found(self):
        # A chunk that starts on page 3 and runs to page 16 must beat the later-starting chunks.
        payloads = [{"page_label": "3", "page_end": "16"}, {"page_label": "12"}, {"page_label": "13"}]
        assert backfill.largest_page(payloads) == 16

    def test_integers_and_numeric_strings_are_both_pages(self):
        assert backfill.largest_page([{"page_label": 5}, {"page_label": "7"}]) == 7

    def test_text_locators_and_missing_labels_carry_no_page(self):
        payloads = [{"page_label": "Zeilen 1-20"}, {"page_label": None}, {}, {"page_label": "None"}]
        assert backfill.largest_page(payloads) is None

    def test_zero_negative_and_boolean_are_not_pages(self):
        payloads = [{"page_label": "0"}, {"page_label": -3}, {"page_label": True}]
        assert backfill.largest_page(payloads) is None

    def test_a_bad_page_end_does_not_hide_a_good_page_label(self):
        assert backfill.largest_page([{"page_label": "4", "page_end": "n/a"}]) == 4

    def test_no_chunks_is_no_count(self):
        assert backfill.largest_page([]) is None


class FakeStore:
    """Holds per-file payloads and records what was written."""

    def __init__(self, payloads: dict[tuple[str, str], list[dict]], missing: set[tuple[str, str]] = frozenset()):
        self.payloads = payloads
        self.missing = set(missing)
        self.written: list[tuple[str, str, int]] = []

    def read(self, collection: str, file_name: str) -> list[dict]:
        if (collection, file_name) in self.missing:
            raise ConnectionError("qdrant down")
        return self.payloads.get((collection, file_name), [])

    def write(self, collection: str, file_name: str, count: int) -> bool:
        self.written.append((collection, file_name, count))
        return True


def _doc(name: str, page_count: int | None = None) -> AvailableDocument:
    return AvailableDocument(file_name=name, summary="s", page_count=page_count)


class TestProcessDocument:
    def test_apply_writes_the_largest_page(self):
        store = FakeStore({("oib", "plan.pdf"): [{"page_label": "1"}, {"page_label": "4", "page_end": "5"}]})
        outcome = backfill.process_document(
            "oib", "plan.pdf", read_payloads=store.read, write_count=store.write, apply=True
        )
        assert outcome == backfill.COUNTED
        assert store.written == [("oib", "plan.pdf", 5)]

    def test_dry_run_reads_and_reports_but_writes_nothing(self):
        store = FakeStore({("oib", "plan.pdf"): [{"page_label": "7"}]})
        outcome = backfill.process_document(
            "oib", "plan.pdf", read_payloads=store.read, write_count=store.write, apply=False
        )
        assert outcome == backfill.COUNTED
        assert store.written == []

    def test_file_without_page_numbers_is_unknown_and_not_written(self):
        store = FakeStore({("oib", "notes.txt"): [{"page_label": "Zeilen 1-9"}]})
        outcome = backfill.process_document(
            "oib", "notes.txt", read_payloads=store.read, write_count=store.write, apply=True
        )
        assert outcome == backfill.UNKNOWN
        assert store.written == []

    def test_unreadable_store_fails_that_file_only(self):
        store = FakeStore({}, missing={("oib", "down.pdf")})
        outcome = backfill.process_document(
            "oib", "down.pdf", read_payloads=store.read, write_count=store.write, apply=True
        )
        assert outcome == backfill.FAILED
        assert store.written == []

    def test_write_matching_no_row_is_a_failure(self):
        outcome = backfill.process_document(
            "oib",
            "gone.pdf",
            read_payloads=lambda c, f: [{"page_label": "2"}],
            write_count=lambda c, f, n: False,
            apply=True,
        )
        assert outcome == backfill.FAILED


class TestRunBackfill:
    def test_files_with_a_count_are_skipped_and_the_rest_counted(self):
        store = FakeStore(
            {
                ("oib", "a.pdf"): [{"page_label": "3"}],
                ("oib", "b.pdf"): [{"page_label": "9"}],
            }
        )
        docs = {"oib": [_doc("a.pdf", page_count=12), _doc("b.pdf"), _doc("c.txt")]}
        stats = backfill.run_backfill(
            collections=["oib"],
            get_documents=lambda collection: docs[collection],
            read_payloads=store.read,
            write_count=store.write,
            apply=True,
        )
        assert store.written == [("oib", "b.pdf", 9)]
        assert (stats.processed, stats.counted, stats.unknown, stats.skipped, stats.failed) == (3, 1, 1, 1, 0)

    def test_every_collection_is_visited(self):
        store = FakeStore({("one", "x.pdf"): [{"page_label": "1"}], ("two", "y.pdf"): [{"page_label": "2"}]})
        docs = {"one": [_doc("x.pdf")], "two": [_doc("y.pdf")]}
        backfill.run_backfill(
            collections=["one", "two"],
            get_documents=lambda collection: docs[collection],
            read_payloads=store.read,
            write_count=store.write,
            apply=True,
        )
        assert sorted(store.written) == [("one", "x.pdf", 1), ("two", "y.pdf", 2)]

    def test_one_failing_file_does_not_stop_the_batch(self):
        store = FakeStore(
            {("oib", "ok.pdf"): [{"page_label": "5"}]},
            missing={("oib", "bad.pdf")},
        )
        docs = {"oib": [_doc("bad.pdf"), _doc("ok.pdf")]}
        stats = backfill.run_backfill(
            collections=["oib"],
            get_documents=lambda collection: docs[collection],
            read_payloads=store.read,
            write_count=store.write,
            apply=True,
        )
        assert store.written == [("oib", "ok.pdf", 5)]
        assert stats.failed == 1
        assert stats.counted == 1
