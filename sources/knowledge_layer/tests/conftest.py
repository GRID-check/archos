"""Fixtures every knowledge-layer test may ask for."""

from sources.knowledge_layer.tests.qdrant_testing import few_payload_indexes  # noqa: F401 - a cheap collection
from sources.knowledge_layer.tests.qdrant_testing import fresh_qdrant_store  # noqa: F401 - a store of its own
from sources.knowledge_layer.tests.qdrant_testing import qdrant_store  # noqa: F401 - the shared store fixture
