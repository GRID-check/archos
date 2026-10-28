"""Shared doubles for the folder card builder: a per-test agent DB, a BFF in memory, a model that answers JSON."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from dataclasses import field
from pathlib import Path
from typing import Any

import pytest
from langchain_core.messages import AIMessage

ROOT = next(path for path in Path(__file__).resolve().parents if (path / "Taskfile.yml").is_file())
FOLDER_CARDS_SCHEMA = ROOT / "frontends/ui/tests/fixtures/folder-cards.schema.json"


_POSTGRES = os.environ.get("GRID_TEST_POSTGRES_URL")
_BACKENDS = [
    "sqlite",
    pytest.param("postgres", marks=pytest.mark.skipif(not _POSTGRES, reason="GRID_TEST_POSTGRES_URL not set")),
]
_BUILDER_TABLES = ("folder_card_queue", "folder_card_collections", "folder_card_usage", "folder_card_manifests")


def _database_url(backend: str, tmp_path: Path) -> str:
    """A SQLite file per test, or the throwaway Postgres with the builder's tables cleared."""
    from sqlalchemy import text

    from aiq_agent.knowledge import document_metadata_store as store
    from aiq_agent.knowledge.folder_cards import queue

    if backend == "sqlite":
        return f"sqlite:///{tmp_path / 'agent.db'}"
    engine = store.DocumentMetadataStore._get_or_create_sync_engine(_POSTGRES)
    with engine.begin() as conn:
        for table in _BUILDER_TABLES:
            conn.execute(text(f"DROP TABLE IF EXISTS {table}"))
    # Another test in this process may have created them: the flag says "exists".
    queue._ensured.discard(_POSTGRES)
    return _POSTGRES


@pytest.fixture(params=_BACKENDS)
def database_url(request, tmp_path):
    """The agent database the builder keeps its state in, on every backend production runs."""
    return _database_url(request.param, tmp_path)


@pytest.fixture(params=_BACKENDS)
def agent_db(request, tmp_path, monkeypatch, folder_cards_flag):
    """A fresh agent DB as ``document_metadata`` and the queue's home; folder cards on."""
    from sqlalchemy import text

    from aiq_agent.knowledge import factory
    from aiq_agent.knowledge.document_metadata_store import DocumentMetadataStore

    previous = factory._document_metadata_store
    url = _database_url(request.param, tmp_path)
    if request.param == "postgres":
        with DocumentMetadataStore._get_or_create_sync_engine(url).begin() as conn:
            conn.execute(text("DROP TABLE IF EXISTS document_metadata"))
    DocumentMetadataStore._tables_initialized.discard(url)
    factory.configure_summary_db(url)
    folder_cards_flag.on("org_1")
    # The organization the hooks gate on when no request or ingest context names one.
    from aiq_agent.knowledge.folder_cards import queue

    queue.remember_collection("proj", "org_1")
    yield url
    folder_cards_flag.reset()
    factory._document_metadata_store = previous


class FolderCardsFlag:
    """The ``folder-cards`` WorkOS flag as the BFF answers it (``gate._fetch``), per organization."""

    def __init__(self, monkeypatch) -> None:
        from aiq_agent.knowledge.folder_cards import gate

        self.enabled: set[str] = set()
        self.asked: list[str] = []
        self._gate = gate
        gate.forget()
        monkeypatch.setattr(gate, "_fetch", self._answer)

    def _answer(self, organization_id: str) -> bool:
        self.asked.append(organization_id)
        return organization_id in self.enabled

    def on(self, organization_id: str) -> None:
        self.enabled.add(organization_id)
        self._gate.forget()

    def off(self, organization_id: str) -> None:
        self.enabled.discard(organization_id)
        self._gate.forget()

    def reset(self) -> None:
        self._gate.forget()


@pytest.fixture
def folder_cards_flag(monkeypatch) -> FolderCardsFlag:
    return FolderCardsFlag(monkeypatch)


@pytest.fixture
def folder_cards_schema() -> dict[str, Any]:
    return json.loads(FOLDER_CARDS_SCHEMA.read_text(encoding="utf-8"))


@dataclass
class FakeBff:
    """The folder cards route, in memory: cards by (collection, path), a set of living folders."""

    folders: set[tuple[str, str]] = field(default_factory=set)
    cards: dict[tuple[str, str], dict[str, Any]] = field(default_factory=dict)
    descriptions: dict[tuple[str, str], str] = field(default_factory=dict)
    puts: list[dict[str, Any]] = field(default_factory=list)
    deletes: list[tuple[str, str]] = field(default_factory=list)
    #: What the worker did to each card's Qdrant point: ``(op, collection, folder_path, detail)``.
    points: list[tuple[str, str, str, Any]] = field(default_factory=list)

    def put_card(self, body: dict[str, Any]) -> bool:
        key = (body["collection"], body["folder_path"])
        if key not in self.folders:
            return False
        self.puts.append(body)
        self.cards[key] = dict(body)
        return True

    def get_cards(self, organization_id: str, collection: str, *, timeout: float = 0) -> dict[str, dict[str, Any]]:
        return {
            path: {**card, "folder_description": self.descriptions.get((collection, path)), "generated_at": None}
            for (name, path), card in self.cards.items()
            if name == collection and card["organization_id"] == organization_id
        }

    def read_collection(
        self, organization_id: str, collection: str, *, timeout: float = 0
    ) -> tuple[dict[str, dict[str, Any]], dict[str, str], set[str]]:
        """Like the BFF: cards, every described folder's description, and the folders the collection owns."""
        described = {path: text for (name, path), text in self.descriptions.items() if name == collection and text}
        owned = {path for name, path in self.folders if name == collection}
        return self.get_cards(organization_id, collection, timeout=timeout), described, owned

    def delete_card(self, organization_id: str, collection: str, folder_path: str) -> bool:
        self.deletes.append((collection, folder_path))
        return self.cards.pop((collection, folder_path), None) is not None


@pytest.fixture
def bff(monkeypatch) -> FakeBff:
    from aiq_agent.knowledge.folder_cards import client

    fake = FakeBff()
    monkeypatch.setattr(client, "put_card", fake.put_card)
    monkeypatch.setattr(client, "get_cards", fake.get_cards)
    monkeypatch.setattr(client, "read_collection", fake.read_collection)
    monkeypatch.setattr(client, "delete_card", fake.delete_card)
    # The point writes need an embedder and a Qdrant; ``test_folder_card_points.py`` runs them for real.
    from aiq_agent.knowledge.folder_cards import worker

    monkeypatch.setattr(
        worker,
        "_publish_point",
        lambda collection, card: fake.points.append(("put", collection, card["folder_path"], card)),
    )
    monkeypatch.setattr(
        worker,
        "_restamp_point",
        lambda collection, path, status: fake.points.append(("status", collection, path, status)),
    )
    monkeypatch.setattr(
        worker, "_drop_point", lambda collection, path: fake.points.append(("delete", collection, path, None))
    )
    return fake


class FakeModel:
    """A chat model double: ``bind(...)`` returns itself, ``ainvoke`` answers what ``reply`` says for the folder."""

    model_name = "test/summary-model"

    def __init__(self, reply=None) -> None:
        self.calls: list[str] = []
        self.reply = reply or (lambda prompt: {"abstract": "Ein Ordner.", "key_facts": []})
        self.bound: list[dict[str, Any]] = []

    def bind(self, **kwargs):
        self.bound.append(kwargs)
        return self

    async def ainvoke(self, messages):
        prompt = messages[-1].content
        self.calls.append(prompt)
        return AIMessage(
            content=json.dumps(self.reply(prompt), ensure_ascii=False),
            response_metadata={
                "token_usage": {"prompt_tokens": 1000, "completion_tokens": 100, "total_tokens": 1100},
                "model_name": self.model_name,
                "finish_reason": "stop",
            },
        )
