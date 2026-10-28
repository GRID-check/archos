"""The Qdrant store fixtures, for a conftest every test loads.

They import :mod:`knowledge_layer_testing.qdrant`, and with it the Qdrant client, only when a
test asks for a store: `tests/conftest.py` and `apps/backend/tests/conftest.py`
load for every test of their suites, and importing the client up front made each
of those tests pay for it (docs/audit/blast-radius-2026-10.md).
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest


@pytest.fixture
def qdrant_store(monkeypatch, request) -> Iterator[Any]:
    """:func:`knowledge_layer_testing.qdrant.shared_store`: the process-wide store on its module's shared pair."""
    from knowledge_layer_testing import qdrant as qdrant_testing

    yield from qdrant_testing.shared_store(monkeypatch, request)


@pytest.fixture
def fresh_qdrant_store(monkeypatch) -> Iterator[Any]:
    """:func:`knowledge_layer_testing.qdrant.fresh_store`: the process-wide store on a pair of its own."""
    from knowledge_layer_testing import qdrant as qdrant_testing

    yield from qdrant_testing.fresh_store(monkeypatch)
