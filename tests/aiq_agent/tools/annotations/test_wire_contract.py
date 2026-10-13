"""The Anmerkungen wire, validated against the schema the BFF generated from its own zod.

ADR-0055 read from this side: there is no Pydantic twin of the request body.
The contract is ``frontends/ui/tests/fixtures/document-annotations.schema.json``,
serialised from ``lib/annotations/types.ts``, and what this file asserts is that
the bodies ``tools/annotations/register.py`` really builds validate against it,
so a field renamed on the TS side fails here rather than as a 400 the reader
sees as „Piloti konnte keine Anmerkung setzen“. Every op runs through the tool
itself, because a literal dict would be the second description of the contract.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator

from aiq_agent.tools.annotations.register import run_document_annotations

from .conftest import ANNOTATION
from .conftest import LIST_BODY
from .conftest import PROPOSAL
from .conftest import PROPOSE_BODY
from .conftest import REPLY_BODY
from .conftest import answering

SCHEMA_PATH = (
    Path(__file__).resolve().parents[4] / "frontends" / "ui" / "tests" / "fixtures" / "document-annotations.schema.json"
)
DEFS = (
    "InternalAnnotationRequest",
    "InternalAnnotationListResponse",
    "InternalAnnotationProposeResponse",
    "InternalAnnotationReplyResponse",
)


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """A validator for one named definition, resolving ``$ref`` against the whole file."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


@pytest.mark.parametrize("name", DEFS)
def test_the_fixture_is_where_the_contract_lives(schema: dict[str, Any], name: str) -> None:
    """A guard on the guard: a renamed or moved definition must fail loudly, not silently pass."""
    assert name in schema["$defs"]


@pytest.mark.parametrize(
    ("name", "body"),
    [
        ("InternalAnnotationListResponse", LIST_BODY),
        ("InternalAnnotationProposeResponse", PROPOSE_BODY),
        ("InternalAnnotationReplyResponse", REPLY_BODY),
    ],
)
def test_the_answers_these_tests_fake_are_the_routes_own(schema: dict[str, Any], name: str, body: dict) -> None:
    """The fakes would otherwise drift from the route and test a shape it never sends."""
    _validator(schema, name).validate(body)


async def test_list_validates(schema, monkeypatch, calls) -> None:
    answering(monkeypatch, calls, LIST_BODY)
    await run_document_annotations("list")

    _validator(schema, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0]["op"] == "list"


async def test_propose_validates_for_a_region_and_a_point(schema, monkeypatch, calls) -> None:
    point = {**PROPOSAL, "shape": "point", "w": 0.3, "h": 0.3, "basis": None}
    answering(monkeypatch, calls, PROPOSE_BODY)
    await run_document_annotations("propose", proposals=[PROPOSAL, point])

    payload = calls[0][0]
    _validator(schema, "InternalAnnotationRequest").validate(payload)
    assert payload["proposals"][0]["w"] == 0.2
    assert "w" not in payload["proposals"][1] and "basis" not in payload["proposals"][1]


async def test_reply_validates(schema, monkeypatch, calls) -> None:
    answering(monkeypatch, calls, REPLY_BODY)
    await run_document_annotations("reply", annotation=ANNOTATION, body="Ist im Index C korrigiert.")

    _validator(schema, "InternalAnnotationRequest").validate(calls[0][0])
    assert calls[0][0]["annotationId"] == ANNOTATION


async def test_every_body_names_the_answer_this_turn_writes_as_a_uuid(schema, monkeypatch, calls) -> None:
    """The zod says ``uuid``; JSON Schema's ``format`` is not asserted by default, so this is."""
    answering(monkeypatch, calls, LIST_BODY)
    await run_document_annotations("list")

    uuid.UUID(calls[0][0]["answerMessageId"])
