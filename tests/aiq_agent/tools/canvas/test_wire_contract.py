"""The canvas wire, validated against the schemas the contract lives in.

ADR-0055 read from this side: there is no Pydantic twin of a request body. The
Anmerkungen ops are ``frontends/ui/tests/fixtures/document-annotations.schema.json``,
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
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.tools.canvas import presence
from aiq_agent.tools.canvas.register import run_highlight
from aiq_agent.tools.canvas.register import run_mark
from aiq_agent.tools.canvas.register import run_marks
from aiq_agent.tools.canvas.register import run_point
from aiq_agent.tools.canvas.register import run_reply
from aiq_agent.tools.canvas.register import run_room

from .conftest import ANNOTATION
from .conftest import DOCUMENT
from .conftest import LIST_BODY
from .conftest import OK_BODY
from .conftest import PROPOSAL
from .conftest import PROPOSE_BODY
from .conftest import REPLY_BODY
from .conftest import ROOM_BODY
from .conftest import answering

ROOT = Path(__file__).resolve().parents[4]
ANNOTATIONS_SCHEMA = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "document-annotations.schema.json"
ANNOTATION_DEFS = (
    "InternalAnnotationRequest",
    "InternalAnnotationListResponse",
    "InternalAnnotationProposeResponse",
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
