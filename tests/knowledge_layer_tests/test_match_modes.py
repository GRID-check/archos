"""``match_modes``: the answer suite's switch between the ways of finding (ADR-0127).

An eval knob: the ``search`` arm keeps ranked search only, the ``navigate`` arm
only the literal modes. Production keeps every mode, so the default is the test
that nothing narrows by accident.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from aiq_agent.common.source_kinds import Shelf
from aiq_agent.knowledge.scoping import ScopedCollection
from sources.knowledge_layer.src.register import KnowledgeRetrievalConfig
from sources.knowledge_layer.src.register import knowledge_retrieval


class TestTheConfigField:
    def test_every_mode_is_on_by_default(self):
        assert KnowledgeRetrievalConfig().match_modes == ["meaning", "exact", "regex"]

    def test_an_override_string_is_a_list(self):
        # `nat run --override … match_modes exact,regex`: the key is new to the YAML, so the value stays a string.
        config = KnowledgeRetrievalConfig(match_modes="exact, regex")
        assert config.match_modes == ["exact", "regex"]

    def test_a_single_mode_is_a_list_of_one(self):
        assert KnowledgeRetrievalConfig(match_modes="meaning").match_modes == ["meaning"]


@pytest.fixture
def offline(monkeypatch):
    monkeypatch.setattr(
        "aiq_agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("proj_1", Shelf.PROJECT)],
    )
    monkeypatch.setattr("sources.knowledge_layer.src.register._get_retriever", lambda config: MagicMock())
    monkeypatch.setattr("sources.knowledge_layer.src.register._initialize_ingestor", lambda config, llm: None)
    monkeypatch.setattr("aiq_agent.knowledge.factory.configure_summary_db", lambda url: None)
    monkeypatch.setattr("aiq_agent.knowledge.norm_store.configure_norm_store", lambda url: None)


async def _search(modes: str, match: str) -> str:
    config = KnowledgeRetrievalConfig(collection_name="oib_knowledge", match_modes=modes)
    async with knowledge_retrieval(config, MagicMock()) as info:
        return await info.single_fn(info.input_schema(query="Fluchtweg", match=match))


class TestTheRefusal:
    @pytest.mark.parametrize(("modes", "match"), [("exact,regex", "meaning"), ("meaning", "exact")])
    async def test_a_mode_the_configuration_withholds_is_refused_by_name(self, offline, modes, match):
        assert await _search(modes, match) == f"`match={match}` is not available in this configuration."

    async def test_an_empty_match_is_meaning(self, offline):
        assert "`match=meaning` is not available" in await _search("exact", "")
