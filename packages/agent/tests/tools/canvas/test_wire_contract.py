"""The canvas wire, validated against the schemas the contract lives in.

ADR-0055 read from this side: there is no Pydantic twin of a request body. The
Anmerkungen ops are ``apps/workspace/tests/fixtures/document-annotations.schema.json``,
serialised from ``lib/annotations/types.ts``; the room ops are
``tests/fixtures/canvas/room-ops.schema.json``, the contract as agreed with the
BFF until it exports them too. What this file asserts is that the bodies the
tools really build validate against those, so a field renamed on the TS side
fails here rather than as a 400 the reader sees as „Piloti konnte keine
Anmerkung setzen“. Every op runs through the tool itself, because a literal dict
would be a second description of the contract.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from agent_testing.canvas import ANNOTATION
from agent_testing.canvas import CREATE_BODY
from agent_testing.canvas import DELETE_BODY
from agent_testing.canvas import DOCUMENT
from agent_testing.canvas import LIST_BODY
from agent_testing.canvas import OK_BODY
from agent_testing.canvas import PROPOSAL
from agent_testing.canvas import PROPOSE_BODY
from agent_testing.canvas import REPLY_BODY
from agent_testing.canvas import ROOM_BODY
from agent_testing.canvas import UPDATE_BODY
from agent_testing.canvas import answering
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

from agent.common.focus_file import set_turn_intent
from agent.tools.canvas import presence
from agent.tools.canvas.register import run_delete
from agent.tools.canvas.register import run_highlight
from agent.tools.canvas.register import run_mark
from agent.tools.canvas.register import run_marks
from agent.tools.canvas.register import run_point
from agent.tools.canvas.register import run_reply
from agent.tools.canvas.register import run_room
from agent.tools.canvas.register import run_update

ROOT = Path(__file__).resolve().parents[5]
ANNOTATIONS_SCHEMA = ROOT / "apps" / "workspace" / "tests" / "fixtures" / "document-annotations.schema.json"
ANNOTATION_DEFS = (
    "InternalAnnotationRequest",
    "InternalAnnotationListResponse",
    "InternalAnnotationProposeResponse",
    "InternalAnnotationCreateResponse",
    "InternalAnnotationUpdateResponse",
    "InternalAnnotationDeleteResponse",
    "InternalAnnotationReplyResponse",
    "InternalRoomResponse",
    "InternalRoomGestureResponse",
)


@pytest.fixture(scope="module")
def annotations() -> dict[str, Any]:
    return json.loads(ANNOTATIONS_SCHEMA.read_text(encoding="utf-8"))


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one named definition, resolving ``$ref`` against the whole file, formats asserted."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]}, format_checker=FormatChecker())


@pytest.mark.parametrize("name", ANNOTATION_DEFS)
def test_the_fixture_is_where_the_contract_lives(annotations: dict[str, Any], name: str) -> None:
    """A guard on the guard: a renamed or moved definition must fail loudly, not silently pass."""
    assert name in annotations["$defs"]


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("InternalAnnotationListResponse", LIST_BODY),
        ("InternalAnnotationProposeResponse", PROPOSE_BODY),
        ("InternalAnnotationCreateResponse", CREATE_BODY),
        ("InternalAnnotationUpdateResponse", UPDATE_BODY),
        ("InternalAnnotationDeleteResponse", DELETE_BODY),
        ("InternalAnnotationReplyResponse", REPLY_BODY),
        ("InternalRoomResponse", ROOM_BODY),
        ("InternalRoomGestureResponse", OK_BODY),
    ],
)
def test_the_answers_these_tests_fake_are_the_routes_own(annotations, name, body) -> None:
    """The fakes would otherwise drift from the route and test a shape it never sends."""
    _validator(annotations, name).validate(body)


async def test_marks_validates(annotations, monkeypatch, calls) -> None:
    answering(monkeypatch, calls, LIST_BODY)
    await run_marks()

    _validator(annotations, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0]["op"] == "list"


async def test_mark_validates_for_a_region_and_a_point(annotations, monkeypatch, calls, registry) -> None:
    point = {**PROPOSAL, "shape": "point", "w": 0.3, "h": 0.3, "basis": None}
    answering(monkeypatch, calls, PROPOSE_BODY)
    await run_mark([PROPOSAL, point])

    payload = calls[0][0]
    _validator(annotations, "InternalAnnotationRequest").validate(payload)
    assert payload["proposals"][0]["w"] == 0.2
    assert "w" not in payload["proposals"][1] and "basis" not in payload["proposals"][1]


async def test_a_mark_on_sketch_elements_validates(annotations, monkeypatch, calls, registry) -> None:
    answering(monkeypatch, calls, PROPOSE_BODY)
    await run_mark([{"element_ids": ["Kp3xQ9vR2mT7wY1zA4bC6"], "kind": "hint", "body": "Breite prüfen."}])

    payload = calls[0][0]
    _validator(annotations, "InternalAnnotationRequest").validate(payload)
    assert "page" not in payload["proposals"][0]


async def test_an_open_mark_validates(annotations, monkeypatch, calls, registry) -> None:
    answering(monkeypatch, calls, CREATE_BODY)
    await run_mark([PROPOSAL], open=True)

    _validator(annotations, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0]["op"] == "create" and calls[0][0]["marks"][0]["w"] == 0.2


@pytest.mark.parametrize(
    "change",
    [
        {"status": "resolved"},
        {"assignee": "Anna Berger", "due_on": "2026-10-20"},
        {"assignee": "-", "due_on": "-"},
        {"kind": "question", "body": "Ist die Tür EI2 30-C?"},
    ],
)
async def test_update_validates_by_id_and_by_number(annotations, monkeypatch, calls, registry, change) -> None:
    answering(monkeypatch, calls, LIST_BODY, UPDATE_BODY)
    await run_update("Nr. 4", "Erledigt: passt.", **change)
    await run_update(ANNOTATION, "Erledigt: passt.", **change)

    assert [payload["op"] for payload, _ in calls] == ["list", "update", "update"]
    by_number, by_id = calls[1][0], calls[2][0]
    for payload in (by_number, by_id):
        _validator(annotations, "InternalAnnotationRequest").validate(payload)
    # Looked up by number, the mark is changed only if it still stands as it was read.
    assert by_number["expectedStatus"] == "open" and "expectedStatus" not in by_id


async def test_delete_validates(annotations, monkeypatch, calls, registry) -> None:
    answering(monkeypatch, calls, DELETE_BODY)
    await run_delete(ANNOTATION)

    _validator(annotations, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0] == {**calls[0][0], "op": "delete", "annotationId": ANNOTATION}


async def test_reply_validates(annotations, monkeypatch, calls, registry) -> None:
    answering(monkeypatch, calls, REPLY_BODY)
    await run_reply(ANNOTATION, "Ist im Index C korrigiert.")

    _validator(annotations, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0]["annotationId"] == ANNOTATION


async def test_a_named_document_validates_on_every_annotation_op(annotations, monkeypatch, calls, lookups) -> None:
    answering(monkeypatch, calls, LIST_BODY)
    await run_marks(document="Grundriss_OG.pdf")

    _validator(annotations, "InternalAnnotationRequest").validate(calls[0][0])
    assert "documentId" in calls[0][0]


async def test_every_annotation_body_names_the_answer_this_turn_writes_as_a_uuid(monkeypatch, calls) -> None:
    answering(monkeypatch, calls, LIST_BODY)
    await run_marks()

    uuid.UUID(calls[0][0]["answerMessageId"])


async def test_every_room_op_validates(annotations, monkeypatch, calls) -> None:
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
    answering(monkeypatch, calls, ROOM_BODY, OK_BODY)

    await run_room()
    await run_point(2, 0.4, 0.5, "Hier")
    await run_point(2, 0.4, 0.5)
    await run_highlight(1, 0.1, 0.2, 0.3, 0.1, "Hier: Fluchtweg 1,10 m")
    await presence.leave_canvas(presence.current_canvas_presence())

    assert [payload["op"] for payload, _ in calls] == ["room", "point", "point", "highlight", "leave"]
    for payload, _ in calls:
        _validator(annotations, "InternalAnnotationRequest").validate(payload)
