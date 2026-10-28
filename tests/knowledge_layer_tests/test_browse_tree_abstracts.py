"""The written (tier-1) abstract in ``list_files(view="tree")``: under its folder's head, stale said, off when off."""

from __future__ import annotations

from unittest.mock import MagicMock

import pytest
from knowledge_layer.browse import ListFilesConfig
from knowledge_layer.browse import abstract_lines
from knowledge_layer.browse import file_rows
from knowledge_layer.browse import folder_cards
from knowledge_layer.browse import list_files
from knowledge_layer.browse import render_tree
from knowledge_layer.register import KnowledgeRetrievalConfig

from agent.common.source_kinds import Shelf
from agent.knowledge.folder_cards import ListedAbstract
from agent.knowledge.inventory import set_turn_documents
from agent.knowledge.schema import AvailableDocument
from agent.knowledge.scoping import ScopedCollection


def _doc(name: str, folder: str | None = None) -> AvailableDocument:
    return AvailableDocument(file_name=name, folder_path=folder, collection="proj_1", shelf="project")


DOCS = [_doc("a.pdf", "Gutachten"), _doc("b.pdf", "Gutachten/Behörde")]


def test_an_abstract_sits_under_its_folders_head_and_a_stale_one_says_so():
    found = {
        ("proj_1", "Gutachten"): ListedAbstract("Gutachten zum Wohnhaus.", "fresh", "2026-10-20T10:00:00Z"),
        ("proj_1", "Gutachten/Behörde"): ListedAbstract("Bescheide.", "stale", "2026-09-01T10:00:00Z"),
    }

    text = render_tree(folder_cards(file_rows(DOCS), root=None), total_rows=2, abstracts=abstract_lines(found))

    lines = text.splitlines()
    head = next(i for i, line in enumerate(lines) if line.startswith("  Gutachten/  "))
    assert lines[head + 1] == "    About: Gutachten zum Wohnhaus."
    assert "      About: Bescheide. (stale, written 2026-09-01)" in lines


def test_no_abstracts_is_the_tier_zero_tree():
    cards = folder_cards(file_rows(DOCS), root=None)

    assert render_tree(cards, total_rows=2) == render_tree(cards, total_rows=2, abstracts={})
    assert "About:" not in render_tree(cards, total_rows=2)


@pytest.fixture
def scope(monkeypatch):
    monkeypatch.setattr(
        "agent.knowledge.scoping.get_scoped_collections_from_context",
        lambda: [ScopedCollection("proj_1", Shelf.PROJECT)],
    )
    monkeypatch.setattr("agent.knowledge.ingest_status_store.in_flight_files", lambda collections: {})
    monkeypatch.setattr("agent.project_context.get_organization_id_from_context", lambda: "org_1")
    yield
    set_turn_documents(None)


def _flag(monkeypatch, on: bool) -> None:
    """The ``folder-cards`` flag as the BFF answers it for the turn's organization."""
    from agent.knowledge.folder_cards import gate

    gate.forget()
    monkeypatch.setattr(gate, "_fetch", lambda organization_id: on and organization_id == "org_1")


async def _tree() -> str:
    builder = MagicMock()
    builder.get_function_config = MagicMock(return_value=KnowledgeRetrievalConfig(collection_name="oib_knowledge"))
    async with list_files(ListFilesConfig(), builder) as info:
        return await info.single_fn(info.input_schema(view="tree"))


async def test_the_tool_reads_the_turns_collections_cards(scope, monkeypatch):
    asked = []

    def get_cards(organization_id, collection, *, timeout=0):
        asked.append((organization_id, collection))
        return {"Gutachten": {"abstract": "Gutachten zum Wohnhaus.", "status": "fresh", "generated_at": None}}

    _flag(monkeypatch, True)
    monkeypatch.setattr("agent.knowledge.folder_cards.client.get_cards", get_cards)
    set_turn_documents(DOCS)

    text = await _tree()

    assert asked == [("org_1", "proj_1")]
    assert "About: Gutachten zum Wohnhaus." in text


async def test_off_or_unreachable_the_listing_is_tier_zero_alone(scope, monkeypatch):
    def unreachable(*args, **kwargs):
        raise OSError("down")

    monkeypatch.setattr("agent.knowledge.folder_cards.client.get_cards", unreachable)
    set_turn_documents(DOCS)

    _flag(monkeypatch, False)
    assert "About:" not in await _tree()
    _flag(monkeypatch, True)
    text = await _tree()
    assert "Gutachten/  2 documents" in text and "About:" not in text
