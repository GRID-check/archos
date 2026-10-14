"""Doubles for the Erfassungs-Agent's suite: the BFF's intake route, the signed run, a project's pages.

Only the transport is faked (``client._opener.open``), so every body a test
reads is the one ``post_intake`` really built, headers included.
"""

from __future__ import annotations

import io
import json
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import pytest
from jsonschema import Draft202012Validator
from jsonschema import FormatChecker

import aiq_agent.project_context as pc
from aiq_agent.agents.intake import client
from aiq_agent.agents.intake import reading
from aiq_agent.agents.intake.read_log import bind_read_log
from aiq_agent.agents.intake.read_log import reset_read_log
from aiq_agent.knowledge.schema import AvailableDocument

ROOT = Path(__file__).resolve().parents[4]
INTAKE_SCHEMA = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "project-intake.schema.json"

HEADER, SIGNATURE = "eyJzaWduZWQiOiJydW4ifQ", "c0ffee"
TOKEN = "internal-token"
JOB = "job-intake-1"

NEEDS = [
    {
        "key": "geschosse_oberirdisch@bw1",
        "baseKey": "geschosse_oberirdisch",
        "bauwerkId": "bw1",
        "label": "Oberirdische Geschoße",
        "type": "number",
        "foundIn": ["Einreichplan", "Schnitte"],
        "decisive": True,
        "state": "open",
    },
    {
        "key": "bauweise",
        "baseKey": "bauweise",
        "bauwerkId": None,
        "label": "Bauweise",
        "type": "multi_select",
        "options": [{"token": "holzbau", "label": "Holzbau"}, {"token": "massivbau", "label": "Massivbau"}],
        "foundIn": ["Baubeschreibung"],
        "decisive": False,
        "state": "open",
    },
    {
        "key": "bundesland",
        "baseKey": "bundesland",
        "bauwerkId": None,
        "label": "Bundesland",
        "type": "single_select",
        "options": [{"token": "wien", "label": "Wien"}, {"token": "tirol", "label": "Tirol"}],
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


class FakeIntakeRoute:
    """``_opener.open`` answering by op: a dict is a 200 body, an int an HTTP error, an exception raised."""

    def __init__(self, **answers: Any) -> None:
        self.answers = {"needs": NEEDS_BODY, "finish": {"status": "ready"}, **answers}
        self.requests: list[urllib.request.Request] = []

    def bodies(self, op: str | None = None) -> list[dict[str, Any]]:
        bodies = [json.loads(request.data) for request in self.requests]
        return [body for body in bodies if op is None or body["op"] == op]

    def __call__(self, request: urllib.request.Request, timeout: float) -> Any:
        self.requests.append(request)
        body = json.loads(request.data)
        answer = self.answers[body["op"]]
        if callable(answer):
            answer = answer(body)
        if isinstance(answer, BaseException):
            raise answer
        if isinstance(answer, int):
            error = json.dumps({"error": "stale-reading" if answer == 409 else "nope"}).encode()
            raise urllib.error.HTTPError(request.full_url, answer, "refused", {}, io.BytesIO(error))
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(answer).encode("utf-8")
        return response


def recorded_all(outcome: str = "suggested"):
    """A ``record`` answer giving every value ``outcome``."""
    return lambda body: {"results": [{"key": value["key"], "outcome": outcome} for value in body["values"]]}


@pytest.fixture
def signed_run(monkeypatch):
    """A background run that carries its requester's envelope, with a service token."""
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (HEADER, SIGNATURE))
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://bff.test")


@pytest.fixture
def unsigned_run(monkeypatch):
    monkeypatch.setattr(pc, "get_request_envelope_from_context", lambda: (None, None))
    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", TOKEN)


@pytest.fixture
def route(monkeypatch):
    def install(**answers: Any) -> FakeIntakeRoute:
        fake = FakeIntakeRoute(**answers)
        monkeypatch.setattr(client._opener, "open", fake)
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
