"""Fakes for ``document_annotations``: the signed envelope and the one HTTP call.

Only the POST is faked. The tool, its payload builders and its renderers are
the real ones, so what the tests read is what a turn would send and say.
"""

from __future__ import annotations

from typing import Any

import pytest

from aiq_agent import project_context
from aiq_agent.tools.annotations import register as annotations
from aiq_agent.tools.documents.filing import SignedEnvelope

HEADER, SIGNATURE = "eyJzaWduZWQiOiJ0dXJuIn0", "c0ffee"
DOCUMENT = "11111111-0000-4000-8000-000000000001"
ANNOTATION = "33333333-0000-4000-8000-000000000003"

Calls = list[tuple[dict[str, Any], SignedEnvelope]]


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
        "onCurrentFassung": True,
        "createdByName": "Martin Huber",
        "createdAt": "2026-10-01T08:00:00.000Z",
        "replies": [{"authorKind": "person", "body": "Prüfe ich.", "createdByName": "Anna Berger"}],
        **extra,
    }


LIST_BODY = {"documentId": DOCUMENT, "annotations": [listed()]}
PROPOSE_BODY = {
    "documentId": DOCUMENT,
    "proposed": [{"id": "44444444-0000-4000-8000-000000000004", "number": 5, "page": 1}],
}
REPLY_BODY = {"documentId": DOCUMENT, "annotationId": ANNOTATION, "number": 4, "replies": 2}

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
def calls(monkeypatch: pytest.MonkeyPatch) -> Calls:
    """The envelope a turn carries, and the record of every body posted."""
    monkeypatch.setattr(project_context, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setattr(project_context, "get_conversation_id_from_context", lambda: "s_conv_1")
    monkeypatch.setattr(project_context, "get_user_message_id_from_context", lambda: "m_user_7")
    return []


def answering(monkeypatch: pytest.MonkeyPatch, calls: Calls, *bodies: dict[str, Any] | Exception) -> None:
    """Answer each POST with the next body, or raise it when it is an exception."""
    queue = list(bodies)

    def fake(payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
        calls.append((payload, envelope))
        body = queue.pop(0) if len(queue) > 1 else queue[0]
        if isinstance(body, Exception):
            raise body
        return body

    monkeypatch.setattr(annotations, "post_annotations", fake)
