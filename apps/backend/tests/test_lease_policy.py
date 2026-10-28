"""The claim lease the workers share: one env reader, one liveness marker, and defaults the BFF agrees with."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from aiq_api.jobs import lease_policy
from aiq_api.jobs import worker as worker_mod

_BFF_RUNNER = Path(__file__).resolve().parents[3] / "frontends" / "ui" / "workers" / "jobs" / "index.js"


@pytest.mark.parametrize(
    ("raw", "floor", "expected"),
    [
        (None, None, 7),
        ("", None, 7),
        ("many", None, 7),
        ("-2", None, -2),
        ("0", 0, 0),
        ("-1", 0, 7),
        ("0", 1, 7),
        ("12", 1, 12),
    ],
)
def test_int_env_falls_back_below_its_floor_and_on_anything_not_a_number(monkeypatch, raw, floor, expected):
    if raw is None:
        monkeypatch.delenv("TEST_LEASE", raising=False)
    else:
        monkeypatch.setenv("TEST_LEASE", raw)

    assert lease_policy.int_env("TEST_LEASE", 7, floor=floor) == expected


def test_the_liveness_marker_is_written_and_a_failed_write_does_not_raise(tmp_path, caplog):
    marker = tmp_path / "alive"
    lease_policy.touch_liveness(str(marker))
    assert marker.read_text() == "ok"

    lease_policy.touch_liveness(str(tmp_path / "missing" / "alive"))
    assert "Could not write the liveness file" in caplog.text


def _bff_default(name: str) -> int:
    declared = re.search(rf"toInt\(env\.{name},\s*([\d_]+)\)", _BFF_RUNNER.read_text())
    assert declared, f"{name} has no default in {_BFF_RUNNER}"
    return int(declared.group(1))


def test_the_bff_claim_loop_shares_the_lease_defaults_that_are_meant_to_be_shared():
    """Max attempts and dead retention are one policy. The drain is not: a BFF slice is a minute, a run ten."""
    assert _bff_default("BFF_JOBS_MAX_ATTEMPTS") == lease_policy.MAX_ATTEMPTS
    assert _bff_default("BFF_JOBS_DEAD_RETENTION_DAYS") == lease_policy.DEAD_RETENTION_DAYS
    assert _bff_default("BFF_JOBS_DRAIN_SECONDS") == 60
    assert lease_policy.DRAIN_SECONDS == 600


async def test_the_research_worker_reaps_once_a_heartbeat_not_on_every_poll(monkeypatch):
    reaps = []

    async def reap(self):
        reaps.append(1)

    monkeypatch.setattr(worker_mod.ResearchWorker, "_fail_exhausted", reap)
    monkeypatch.setattr(worker_mod.ResearchWorker, "_purge_dead", lambda self: _nothing())
    worker = worker_mod.ResearchWorker()

    for _ in range(5):
        await worker._maintain()

    assert len(reaps) == 1


async def test_a_failed_reap_does_not_end_the_poll_loop(monkeypatch, caplog):
    async def reap(self):
        raise ConnectionError("database restarting")

    monkeypatch.setattr(worker_mod.ResearchWorker, "_fail_exhausted", reap)
    monkeypatch.setattr(worker_mod.ResearchWorker, "_purge_dead", lambda self: _nothing())

    await worker_mod.ResearchWorker()._maintain()

    assert "Reaping exhausted research claims failed" in caplog.text


async def _nothing() -> None:
    return None
