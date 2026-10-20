"""Fakes for the canvas tools: the signed envelope, the HTTP calls, and a turn's state.

Only the two HTTP calls are faked (the canvas POST and the document-id lookup).
The tools, their payload builders, renderers, target resolution, card and
policy are the real ones, so what the tests read is what a turn would send and say.
"""

from __future__ import annotations

from typing import Any

import pytest

from aiq_agent import project_context
from aiq_agent.cards.registry import CardRegistry
from aiq_agent.cards.registry import reset_card_registry
from aiq_agent.cards.registry import set_card_registry
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.knowledge import AvailableDocument
from aiq_agent.knowledge.inventory import set_turn_documents
from aiq_agent.knowledge.restricted_use import bind_cross_project_turn
from aiq_agent.knowledge.restricted_use import bind_restricted_use
from aiq_agent.tools.canvas import calls as canvas_calls
from aiq_agent.tools.canvas import presence
from aiq_agent.tools.canvas import target as canvas_target
from aiq_agent.tools.documents.filing import SignedEnvelope

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
DOCUMENT = "11111111-0000-4000-8000-000000000001"
OTHER_DOCUMENT = "22222222-0000-4000-8000-000000000002"
ANNOTATION = "33333333-0000-4000-8000-000000000003"
PROPOSED = "44444444-0000-4000-8000-000000000004"
NAME = "Grundriss_EG.pdf"

Calls = list[tuple[dict[str, Any], SignedEnvelope]]

INVENTORY = [
    AvailableDocument(file_name="Grundriss_EG.pdf", shelf="project", collection="proj_1"),
    AvailableDocument(file_name="Grundriss_OG.pdf", shelf="project", collection="proj_1"),
    AvailableDocument(file_name="Schnitt A-A.pdf", shelf="office_shelf", collection="archiv_1"),
    AvailableDocument(file_name="OIB-RL2.pdf", shelf="base", collection="oib"),
]


def listed(**extra: Any) -> dict[str, Any]:
    """One mark as ``InternalAnnotationListResponse`` carries it, every field the schema requires."""
    return {
        "id": ANNOTATION,
        "number": 4,
        "page": 2,
        "shape": "region",
        "box": [0.1, 0.2, 0.35, 0.4],
        "kind": "defect",
        "status": "open",
        "authorKind": "person",
        "body": "Fluchtweg im 1. OG zu lang.",
        "basis": "OIB-RL 2, Pkt. 5.1.1",
        "assigneeName": "Anna Berger",
        "dueOn": "2026-10-20",
        "onCurrentRevision": True,
        "createdByName": "Martin Huber",
        "createdAt": "2026-10-01T08:00:00.000Z",
        "replies": [{"authorKind": "person", "body": "Prüfe ich.", "createdByName": "Anna Berger"}],
        **extra,
    }


LIST_BODY = {"documentId": DOCUMENT, "documentName": NAME, "annotations": [listed()]}
PROPOSE_BODY = {
    "documentId": DOCUMENT,
    "documentName": NAME,
    "proposed": [
        {
            "id": PROPOSED,
            "number": 5,
            "page": 1,
            "shape": "region",
            "x": 0.12,
            "y": 0.3,
            "w": 0.2,
            "h": 0.1,
            "kind": "defect",
            "body": "Treppenlaufbreite 1,10 m statt 1,20 m.",
        }
    ],
}
CREATE_BODY = {"documentId": DOCUMENT, "documentName": NAME, "created": PROPOSE_BODY["proposed"]}
UPDATE_BODY = {
    "documentId": DOCUMENT,
    "documentName": NAME,
    "annotationId": ANNOTATION,
    "number": 4,
    "status": "resolved",
    "before": {"status": "open", "assigneeUserId": None, "assigneeName": None},
    "after": {"status": "resolved", "assigneeUserId": "user_anna", "assigneeName": "Anna Berger"},
    "noted": True,
}
DELETE_BODY = {
    "documentId": DOCUMENT,
    "documentName": NAME,
    "annotationId": ANNOTATION,
    "number": 4,
    "body": "Fluchtweg im 1. OG zu lang.",
}
REPLY_BODY = {"documentId": DOCUMENT, "documentName": NAME, "annotationId": ANNOTATION, "number": 4, "replies": 2}
ROOM_BODY = {
    "documentId": DOCUMENT,
    "documentName": NAME,
    "peers": [
        {
            "name": "Anna Berger",
            "kind": "person",
            "page": 2,
            "viewport": {"page": 2, "y": 0.35},
            "selectedMarkNumber": 4,
            "draft": {"page": 2, "x": 0.3, "y": 0.5, "w": 0.1, "h": 0.1},
        },
        {
            "name": "Martin Huber",
            "kind": "person",
            "page": None,
            "viewport": None,
            "selectedMarkNumber": None,
            "draft": None,
        },
    ],
    "marks": {"open": 5, "proposed": 2},
}
OK_BODY = {"documentId": DOCUMENT, "documentName": NAME, "ok": True}

PROPOSAL = {
    "page": 1,
    "shape": "region",
    "x": 0.12,
    "y": 0.3,
    "w": 0.2,
    "h": 0.1,
    "kind": "defect",
    "body": "Treppenlaufbreite 1,10 m statt 1,20 m.",
    "basis": "OIB-RL 4, Pkt. 2.1.2",
}


@pytest.fixture
def registry():
    """A bound card registry, the way a turn binds one."""
    cards = CardRegistry()
    token = set_card_registry(cards)
    yield cards
    reset_card_registry(token)


@pytest.fixture(autouse=True)
def turn(monkeypatch):
    """A chat turn: an envelope, a conversation, an inventory, nothing restricted, no focus."""
    monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: "s_conv_1")
    monkeypatch.setattr(project_context, "get_user_message_id_from_context", lambda: "m_user_7")
    set_turn_documents(INVENTORY)
    set_turn_intent()
    bind_restricted_use(None)
    bind_cross_project_turn(None)
    presence.begin_canvas_presence()
    yield
    set_turn_documents(None)
    set_turn_intent()


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> Calls:
    """The record of every canvas body posted (answer each with :func:`answering`)."""
    return []


@pytest.fixture
def lookups(monkeypatch: pytest.MonkeyPatch) -> list[tuple[str, str]]:
    """The document-id lookups made; each answers with :data:`OTHER_DOCUMENT`."""
    made: list[tuple[str, str]] = []

    def fake(collection: str, file_name: str, envelope: SignedEnvelope) -> str | None:
        made.append((collection, file_name))
        return OTHER_DOCUMENT

    monkeypatch.setattr(canvas_target, "lookup_document_id", fake)
    return made


def answering(monkeypatch: pytest.MonkeyPatch, calls: Calls, *bodies: dict[str, Any] | Exception) -> None:
    """Answer each POST with the next body (the last one repeats), or raise it when it is an exception."""
    queue = list(bodies)

    def fake(payload: dict[str, Any], envelope: SignedEnvelope, **_: Any) -> dict[str, Any]:
        calls.append((payload, envelope))
        body = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(body, Exception):
            raise body
        return body

    monkeypatch.setattr(canvas_calls, "post_canvas", fake)
    monkeypatch.setattr(presence, "post_canvas", fake)
