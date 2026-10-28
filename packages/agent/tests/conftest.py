"""Pytest fixtures for tests."""

from unittest.mock import MagicMock

import pytest
from aiq_agent.common.llm_provider import LLMProvider

# This suite sits outside `tests/`, so `tests/conftest.py` does not apply to it:
# its shared fixtures (the cache reset and the live-decision stub, both autouse)
# are registered here by name.
from tests.conftest import _isolate_shared_cache  # noqa: F401
from tests.conftest import _no_live_decisions  # noqa: F401
from tests.conftest import emitted  # noqa: F401
from tests.conftest import fresh_qdrant_store  # noqa: F401
from tests.conftest import qdrant_store  # noqa: F401
from tests.conftest import strict_provider_llm  # noqa: F401


@pytest.fixture
def mock_llm():
    """Create a mock LLM for testing."""
    llm = MagicMock()
    llm.ainvoke = MagicMock()
    return llm


@pytest.fixture
def llm_provider(mock_llm):
    """Create an LLMProvider with a mock default LLM."""
    provider = LLMProvider()
    provider.set_default(mock_llm)
    return provider
