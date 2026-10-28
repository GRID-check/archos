"""Doubles for the Erfassungs-Agent's suite: the BFF's intake route, the signed run, a project's pages.

Only the transport is faked (``bff_http._opener.open``), so every body a test
reads is the one ``post_intake`` really built, headers included.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

import aiq_agent.project_context as pc
from aiq_agent.agents.intake import reading
from aiq_agent.agents.intake.read_log import bind_read_log
from aiq_agent.agents.intake.read_log import reset_read_log
from aiq_agent.common import bff_http
from aiq_agent.knowledge.schema import AvailableDocument
from scripts.intake_eval.bff import FakeIntakeRoute as _IntakeRoute

ROOT = next(path for path in Path(__file__).resolve().parents if (path / "Taskfile.yml").is_file())
INTAKE_SCHEMA = ROOT / "apps" / "workspace" / "tests" / "fixtures" / "project-intake.schema.json"

HEADER, SIGNATURE = "eyJzaWduZWQiOiJydW4ifQ", "c0ffee"
TOKEN = "internal-token"
JOB = "job-intake-1"

NEEDS = [
    {
        "key": "storeys_above_ground@bldg1",
        "baseKey": "storeys_above_ground",
        "buildingId": "bldg1",
        "label": "Oberirdische Geschoße",
        "type": "number",
        "foundIn": ["Einreichplan", "Schnitte"],
        "decisive": True,
        "state": "open",
    },
    {
        "key": "construction_method",
        "baseKey": "construction_method",
        "buildingId": None,
        "label": "Bauweise",
        "type": "multi_select",
        "options": [{"token": "timber", "label": "Holzbau"}, {"token": "massivbau", "label": "Massivbau"}],
        "foundIn": ["Baubeschreibung"],
        "decisive": False,
        "state": "open",
    },
    {
        "key": "federal_state",
        "baseKey": "federal_state",
        "buildingId": None,
        "label": "Bundesland",
        "type": "single_select",
        "options": [{"token": "vienna", "label": "Wien"}, {"token": "tyrol", "label": "Tirol"}],
        "why": "Die Bauordnung des Landes gilt.",
        "foundIn": ["Einreichplan"],
        "decisive": False,
        "state": "suggested",
    },
]

NEEDS_BODY = {
    "needs": NEEDS,
    "unreadFiles": ["Baubeschreibung.pdf", "Einreichplan.pdf"],
    "description": "Zubau eines Wohnhauses",
    "location": None,
    "mode": "active",
    "previousSummary": None,
}

PAGES = {
    "Baubeschreibung.pdf": [
        ("1", "Baubeschreibung\nZubau Wohnhaus Musterstraße 1, 1010 Wien"),
        ("2", "Tragwerk: Das Gebäude wird in\nHolzbauweise   errichtet. Die Decken sind Brettsperrholz."),
        ("3", "Das Gebäude hat drei oberirdische Geschoße und ein Kellergeschoß."),
    ],
}

DOCUMENTS = [
    reading.ProjectDocument(
        collection="proj_1",
        document=AvailableDocument(file_name="Baubeschreibung.pdf", collection="proj_1", shelf="project"),
    ),
    reading.ProjectDocument(
        collection="proj_1",
        document=AvailableDocument(file_name="Einreichplan.pdf", collection="proj_1", shelf="project"),
    ),
]


class FakeIntakeRoute(_IntakeRoute):
    """The intake eval's transport double, with this suite's needs as the default ``needs`` answer."""

    def __init__(self, **answers: Any) -> None:
        super().__init__(**{"needs": NEEDS_BODY, **answers})


def recorded_all(outcome: str = "suggested"):
    """A ``record`` answer giving every value ``outcome``."""
    return lambda body: {"results": [{"key": value["key"], "outcome": outcome} for value in body["values"]]}


@pytest.fixture
def signed_run(monkeypatch):
    """A background run that carries its requester's envelope, with a service token."""
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test")


@pytest.fixture
def unsigned_run(monkeypatch):
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (None, None))
    monkeypatch.setenv("INTERNAL_API_TOKEN", TOKEN)


@pytest.fixture
def route(monkeypatch):
    def install(**answers: Any) -> FakeIntakeRoute:
        fake = FakeIntakeRoute(**answers)
        monkeypatch.setattr(bff_http._opener, "open", fake)
        return fake

    return install


@pytest.fixture
def project(monkeypatch):
    """The run's project: two documents, one with indexed pages."""

    async def documents():
        return list(DOCUMENTS)

    monkeypatch.setattr(reading, "project_documents", documents)
    monkeypatch.setattr(reading, "fetch_document_pages", lambda collection, name: PAGES.get(name))


@pytest.fixture
def read_log():
    log, token = bind_read_log()
    yield log
    reset_read_log(token)


@pytest.fixture(autouse=True)
def no_decision_model(monkeypatch):
    """No test reaches a real decision model: undecided, unless a test installs :func:`decider`."""
    monkeypatch.setattr("aiq_agent.common.decisions.decide_many_blocking", lambda states, *a, **k: [None] * len(states))


@pytest.fixture
def decider(monkeypatch):
    """The decision model answering p(stated) by the value's label; records the states it was asked."""
    from aiq_agent.common.decisions import Decision

    def install(by_label: dict[str, float]) -> list[dict]:
        seen: list[dict] = []

        def decide(states, questions, **kwargs):
            seen.extend(states)
            return [
                Decision(answers={"stated": {"type": "noul", "noul": by_label.get(state["value"], 0.9)}})
                for state in states
            ]

        monkeypatch.setattr("aiq_agent.common.decisions.decide_many_blocking", decide)
        return seen

    return install


@pytest.fixture(scope="session")
def intake_schema() -> dict[str, Any]:
    if not INTAKE_SCHEMA.exists():
        pytest.skip(
            f"{INTAKE_SCHEMA.relative_to(ROOT)} is not generated yet: lib/project-intake/intake-schema.ts exports it "
            "(intake-schema.spec.ts). Without it the wire bodies are pinned only by the shape tests."
        )
    return json.loads(INTAKE_SCHEMA.read_text(encoding="utf-8"))


def validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    """One named definition, ``$ref`` resolved against the whole file, formats asserted."""
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]}, format_checker=FormatChecker())
