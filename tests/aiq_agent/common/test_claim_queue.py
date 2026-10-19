"""The claim substrate is generic over its table: a second queue is a second table, nothing else.

The ingestion queue's scenarios (fair order, cap, reap, upgrade) are
``tests/knowledge_layer_tests/test_ingest_queue.py``. These pin what the
research queue will rely on when it adopts the substrate: that a queue built
with another table and lane name behaves the same and touches nothing of the
ingestion queue's.
"""

from __future__ import annotations

import os

import pytest
from sqlalchemy import create_engine
from sqlalchemy import text

from aiq_agent.common import claim_queue

CLAIM = {"stale_seconds": 180, "max_attempts": 3}
_POSTGRES = os.environ.get("AIQ_TEST_POSTGRES_URL")
_TABLES = ("research_claims", "research_claim_turns", "other_claims", "other_claim_turns")


def test_the_postgres_branch_ran_where_it_is_required():
    """CI's ``task be:test:postgres`` sets the guard: there a missing database fails instead of skipping green."""
    if os.environ.get("AIQ_TEST_POSTGRES_REQUIRED"):
        assert _POSTGRES, "AIQ_TEST_POSTGRES_URL is unset while AIQ_TEST_POSTGRES_REQUIRED is set"


@pytest.fixture(
    params=[
        "sqlite",
        pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="AIQ_TEST_POSTGRES_URL not set")),
    ]
)
def url(request, tmp_path):
    url = f"sqlite:///{tmp_path}/queues.db" if request.param == "sqlite" else _POSTGRES
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))
    with engine.begin() as conn:
        for table in _TABLES:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
    yield url
    engine.dispose()


def _queue(url: str, name: str = "research", table: str = "research_claims", turns: str = "research_claim_turns"):
    engines: dict[str, object] = {}

    def engine_for(db_url: str):
        if db_url not in engines:
            engines[db_url] = create_engine(db_url.replace("postgresql://", "postgresql+psycopg://", 1))
        return engines[db_url]

    return claim_queue.ClaimQueue(
        name=name, table=table, turns_table=turns, db_url=lambda: url, engine_for=engine_for, reap_lock_id=0x5253
    )


def test_two_queues_in_one_database_do_not_see_each_others_jobs(url):
    research = _queue(url)
    other = _queue(url, name="other", table="other_claims", turns="other_claim_turns")

    research.enqueue("r0", "org-a", "payload")

    assert other.claim_next("w1", **CLAIM) is None
    assert research.claim_next("w1", **CLAIM).job_id == "r0"
    assert other.counts() == {"queued": 0, "claimed": 0, "dead": 0, "cancelled": 0}
    assert research.counts() == {"queued": 0, "claimed": 1, "dead": 0, "cancelled": 0}


def test_a_queue_keeps_its_own_fairness_and_priority(url):
    queue = _queue(url)
    queue.enqueue("a-bulk", "org-a", "p", "bulk")
    queue.enqueue("a-live", "org-a", "p")
    queue.enqueue("b0", "org-b", "p")

    claimed = [queue.claim_next(f"w{i}", **CLAIM) for i in range(3)]

    # Lanes alternate (fewest running, then longest unserved); inside a lane, interactive first.
    assert [c.lane for c in claimed] == ["org-a", "org-b", "org-a"]
    assert [c.job_id for c in claimed if c.lane == "org-a"] == ["a-live", "a-bulk"]


def _created_at(queue: claim_queue.ClaimQueue, url: str, job_id: str, at: str) -> None:
    with queue._engine_for(url).begin() as conn:
        conn.execute(text(f"UPDATE {queue.table} SET created_at = :at WHERE job_id = :id"), {"at": at, "id": job_id})


# The next two scenarios are the lane order every claim shares: the same two run in
# tests/knowledge_layer_tests/test_ingest_queue.py and in the BFF's
# frontends/ui/src/lib/jobs-queue/queue.integration.spec.ts. Priority never picks the lane.


def test_a_lane_is_ranked_by_its_oldest_job_not_its_best_priority(url):
    queue = _queue(url)
    queue.enqueue("a-bulk", "org-a", "p", "bulk")
    queue.enqueue("b-live", "org-b", "p")
    _created_at(queue, url, "a-bulk", "2026-09-30 10:00:00")
    _created_at(queue, url, "b-live", "2026-09-30 10:00:01")

    assert queue.claim_next("w1", **CLAIM).job_id == "a-bulk"


def test_tied_lanes_are_served_by_name_past_the_lanes_one_claim_ranks(url):
    queue = _queue(url)
    lanes = [f"org-{c}" for c in "abcdef"]  # more than the four lanes ranked per claim
    for n, lane in enumerate(reversed(lanes)):
        queue.enqueue(f"j{n}", lane, "p")
        _created_at(queue, url, f"j{n}", "2026-09-30 10:00:00")

    claimed = [queue.claim_next(f"w{i}", **CLAIM).lane for i in range(len(lanes))]

    assert claimed == lanes


def test_release_and_dead_rows_work_on_any_table(url):
    queue = _queue(url)
    queue.enqueue("r0", "org-a", "p")
    queue.claim_next("w1", **CLAIM)

    assert queue.release_claims(["r0"], "w1") == 1
    assert queue.claim_next("w2", **CLAIM).attempts == 1

    assert queue.mark_dead("r0", "cancelled") is True
    assert queue.counts() == {"queued": 0, "claimed": 0, "dead": 1, "cancelled": 0}


def test_a_queue_without_a_database_is_inert():
    queue = claim_queue.ClaimQueue(
        name="x", table="x_q", turns_table="x_t", db_url=lambda: None, engine_for=lambda u: None, reap_lock_id=1
    )

    assert queue.claim_next("w1", **CLAIM) is None
    assert queue.counts() == {"queued": 0, "claimed": 0, "dead": 0, "cancelled": 0}
    assert queue.release_claims(["a"], "w1") == 0
    assert queue.reap_exhausted(**CLAIM) == []
    assert queue.ahead_in_lane(["a"]) == {}
    with pytest.raises(RuntimeError, match="no database"):
        queue.enqueue("a", "org", "p")


@pytest.mark.parametrize(("name", "rank"), [(None, 0), ("interactive", 0), ("bulk", 1)])
def test_priority_names_rank_interactive_before_bulk(name, rank):
    assert claim_queue.priority_rank(name) == rank


def test_an_unknown_priority_is_a_value_error():
    with pytest.raises(ValueError, match="unknown priority 'now'"):
        claim_queue.priority_rank("now")


def test_queued_in_lane_counts_only_what_still_waits(url):
    queue = _queue(url)
    queue.enqueue("a0", "org-a", "p")
    queue.enqueue("a1", "org-a", "p")
    queue.enqueue("b0", "org-b", "p")
    queue.claim_next("w1", **CLAIM)

    waiting = {lane: queue.queued_in_lane(lane) for lane in ("org-a", "org-b", "org-c")}

    assert sum(waiting.values()) == 2
    assert waiting["org-c"] == 0


def test_a_table_from_before_lanes_gains_one_and_its_rows_wait_in_a_lane_of_their_own(url):
    postgres = url.startswith("postgres")
    ts, now = ("TIMESTAMP WITH TIME ZONE", "NOW()") if postgres else ("DATETIME", "CURRENT_TIMESTAMP")
    queue = _queue(url)
    with queue._engine_for(url).begin() as conn:
        conn.execute(
            text(
                "CREATE TABLE research_claims (job_id VARCHAR PRIMARY KEY, payload TEXT NOT NULL, "
                f"status VARCHAR NOT NULL DEFAULT 'queued', claimed_by VARCHAR, claimed_at {ts}, "
                f"heartbeat_at {ts}, attempts INTEGER NOT NULL DEFAULT 0, created_at {ts} DEFAULT {now})"
            )
        )
        conn.execute(text("INSERT INTO research_claims (job_id, payload) VALUES ('old', 'p')"))

    queue.ensure_table(url)

    claim = queue.claim_next("w1", **CLAIM)
    assert (claim.job_id, claim.lane, claim.priority) == ("old", claim_queue.NO_LANE, claim_queue.PRIORITY_INTERACTIVE)
    # A replica on the code that wrote the old table inserts no lane and still enqueues.
    with queue._engine_for(url).begin() as conn:
        conn.execute(text("INSERT INTO research_claims (job_id, payload) VALUES ('older-code', 'p')"))
    assert queue.counts()["queued"] == 1


def test_ddl_in_the_callers_transaction_is_not_marked_done_until_the_caller_says_it_committed(url):
    queue = _queue(url)
    engine = create_engine(url.replace("postgresql://", "postgresql+psycopg://", 1))

    with engine.connect() as conn:
        queue.ensure_table(url, conn)
        assert url not in queue.initialized  # not committed yet: another thread must not skip the DDL
        conn.rollback()
    assert url not in queue.initialized  # the commit never happened, so the next call creates the table

    queue.enqueue("r0", "org-a", "payload")  # its own ensure_table, on its own connection, which commits
    assert url in queue.initialized
    engine.dispose()
