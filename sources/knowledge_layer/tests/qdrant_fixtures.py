"""The Qdrant store fixtures, for a conftest every test loads.

They import :mod:`qdrant_testing`, and with it the Qdrant client, only when a
test asks for a store: `tests/conftest.py` and `frontends/aiq_api/tests/conftest.py`
load for every test of their suites, and importing the client up front made each
of those tests pay for it (docs/audit/blast-radius-2026-10.md). Imported by
path, like every helper a suite under `sources/` shares.
"""

from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import pytest


@pytest.fixture
def qdrant_store(monkeypatch, request) -> Iterator[Any]:
    """:func:`qdrant_testing.shared_store`: the process-wide store on its module's shared pair."""
    from sources.knowledge_layer.tests import qdrant_testing

    yield from qdrant_testing.shared_store(monkeypatch, request)


@pytest.fixture
def fresh_qdrant_store(monkeypatch) -> Iterator[Any]:
    """:func:`qdrant_testing.fresh_store`: the process-wide store on a pair of its own."""
    from sources.knowledge_layer.tests import qdrant_testing

    yield from qdrant_testing.fresh_store(monkeypatch)
