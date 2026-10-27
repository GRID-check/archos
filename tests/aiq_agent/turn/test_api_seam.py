"""The one place the agent tier reaches into the API tier.

Which modules may import ``aiq_api`` is the ``agent-api-seam`` contract in
``pyproject.toml``'s ``[tool.importlinter]``, checked by ``lint-imports`` in
``task be:lint``. These tests pin what the seam hands over.
"""

from __future__ import annotations

from unittest.mock import create_autospec

from aiq_agent.turn import api_seam
from aiq_agent.turn.api_seam import AuthError
from aiq_agent.turn.api_seam import skip_clarifier_requested


def test_outside_a_request_nobody_asked_to_skip_the_clarifier():
    assert skip_clarifier_requested() is False


def test_auth_error_is_the_api_tiers_class():
    from aiq_api.auth.errors import AuthError as ApiAuthError

    assert AuthError is ApiAuthError


def test_an_ingest_job_is_queued_by_the_api_tiers_own_enqueue(monkeypatch):
    from aiq_api.jobs import ingest_dispatch

    enqueue_only = create_autospec(ingest_dispatch.enqueue_only, return_value=True)
    monkeypatch.setattr(ingest_dispatch, "enqueue_only", enqueue_only)

    assert api_seam.enqueue_ingest_job("job") is True
    enqueue_only.assert_called_once_with("job")
