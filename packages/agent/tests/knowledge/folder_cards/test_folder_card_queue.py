"""The dirty-folder queue: ancestors in one mark, the debounce, deepest first, one winner per claim, the budget."""

from __future__ import annotations

import os

import pytest

from agent.knowledge.folder_cards import queue

T0 = 1_800_000_000.0


def test_the_postgres_branch_ran_where_it_is_required():
    """CI's ``task be:test:postgres`` sets the guard: there a missing database fails instead of skipping green."""
    if os.environ.get("TEST_POSTGRES_REQUIRED"):
        assert os.environ.get("TEST_POSTGRES_URL"), "TEST_POSTGRES_URL is unset while REQUIRED is set"


@pytest.fixture
def url(database_url):
    return database_url


def _paths(url, collection="proj"):
    return [path for path, _dirty, _marked in queue.queued(collection, url=url)]


class TestMark:
    def test_a_folder_marks_itself_and_every_folder_above_it(self, url):
        assert queue.mark("proj", ["Gutachten/Brandschutz/2026"], "org_1", now=T0, url=url) == 3

        assert _paths(url) == ["Gutachten", "Gutachten/Brandschutz", "Gutachten/Brandschutz/2026"]

    def test_the_root_is_no_folder(self, url):
        assert queue.mark("proj", ["", "/"], now=T0, url=url) == 0
        assert _paths(url) == []

    def test_a_second_mark_moves_the_quiet_clock_and_keeps_the_dirty_clock(self, url):
        queue.mark("proj", ["A"], now=T0, url=url)
        queue.mark("proj", ["A"], now=T0 + 120, url=url)

        assert queue.queued("proj", url=url) == [("A", T0, T0 + 120)]

    def test_an_organization_once_known_is_not_forgotten_by_a_mark_that_does_not_know_it(self, url):
        queue.mark("proj", ["A"], "org_1", now=T0, url=url)
        queue.mark("proj", ["A"], None, now=T0 + 1, url=url)

        (claimed,) = queue.claim(5, now=T0 + queue.QUIET_SECONDS + 10, url=url)
        assert claimed.organization_id == "org_1"


class TestClaim:
    def test_nothing_is_due_before_the_folder_went_quiet(self, url):
        queue.mark("proj", ["A"], now=T0, url=url)

        assert queue.claim(5, now=T0 + queue.QUIET_SECONDS - 1, url=url) == []
        assert [c.folder_path for c in queue.claim(5, now=T0 + queue.QUIET_SECONDS, url=url)] == ["A"]

    def test_a_folder_that_never_goes_quiet_is_due_after_the_hard_cap(self, url):
        for minute in range(0, 61, 5):
            queue.mark("proj", ["A"], now=T0 + minute * 60, url=url)

        assert [c.folder_path for c in queue.claim(5, now=T0 + queue.MAX_DIRTY_SECONDS, url=url)] == ["A"]

    def test_deepest_first_and_never_a_parent_while_a_child_is_queued(self, url):
        queue.mark("proj", ["A/B/C", "D"], now=T0, url=url)
        later = T0 + queue.QUIET_SECONDS + 1

        first = [claim.folder_path for claim in queue.claim(10, now=later, url=url)]

        assert first == ["A/B/C", "D"]

    def test_the_parent_follows_once_its_child_is_built(self, url):
        queue.mark("proj", ["A/B"], now=T0, url=url)
        later = T0 + queue.QUIET_SECONDS + 1
        (child,) = queue.claim(10, now=later, url=url)

        queue.finish(child, url=url)

        assert [claim.folder_path for claim in queue.claim(10, now=later + 1, url=url)] == ["A"]

    def test_a_claimed_row_is_claimed_once(self, url):
        queue.mark("proj", ["A"], now=T0, url=url)
        later = T0 + queue.QUIET_SECONDS + 1

        assert len(queue.claim(5, now=later, url=url)) == 1
        assert queue.claim(5, now=later + 1, url=url) == []
        assert len(queue.claim(5, now=later + queue.CLAIM_STALE_SECONDS + 1, url=url)) == 1

    def test_a_folder_marked_while_it_was_built_stays_queued_with_a_new_quiet_period(self, url):
        queue.mark("proj", ["A"], now=T0, url=url)
        (claim,) = queue.claim(5, now=T0 + queue.QUIET_SECONDS + 1, url=url)
        queue.mark("proj", ["A"], now=T0 + queue.QUIET_SECONDS + 30, url=url)

        queue.finish(claim, url=url)

        assert queue.queued("proj", url=url) == [("A", T0 + queue.QUIET_SECONDS + 30, T0 + queue.QUIET_SECONDS + 30)]

    def test_a_failing_folder_is_retried_after_a_quiet_period_and_given_up_after_its_attempts(self, url):
        queue.mark("proj", ["A"], now=T0, url=url)
        now = T0
        for attempt in range(1, queue.MAX_ATTEMPTS + 1):
            now += queue.QUIET_SECONDS + 1
            (claim,) = queue.claim(5, now=now, url=url)
            assert claim.attempts == attempt
            given_up = queue.fail(claim, now=now, url=url)
            assert given_up is (attempt == queue.MAX_ATTEMPTS)
        assert _paths(url) == []


class TestBudget:
    def test_tokens_add_up_per_organization_and_month(self, url):
        queue.add_tokens("org_1", 1000, now=T0, url=url)
        queue.add_tokens("org_1", 500, now=T0 + 60, url=url)
        queue.add_tokens("org_2", 7, now=T0, url=url)

        assert queue.tokens_used("org_1", now=T0, url=url) == 1500
        assert queue.tokens_used("org_2", now=T0, url=url) == 7
        assert queue.tokens_used("org_1", now=T0 + 40 * 86400, url=url) == 0


class TestCollections:
    def test_the_organization_of_a_collection_and_its_reconcile_clock(self, url):
        queue.remember_collection("proj", "org_1", url=url)

        assert queue.organization_of("proj", url=url) == "org_1"
        assert queue.collections_due_for_reconcile(3600, now=T0, url=url) == [("proj", "org_1")]
        queue.set_reconciled("proj", now=T0, url=url)
        assert queue.collections_due_for_reconcile(3600, now=T0 + 60, url=url) == []
