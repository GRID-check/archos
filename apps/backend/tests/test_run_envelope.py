"""A background run acts as the person who commissioned it, by echo (ADR-0108).

The job API keeps the envelope the BFF signed for the submit, only when it
verifies for the run's requester; it travels in the encrypted payload; the
worker injects the same bytes at claim, renews them through the BFF once they
are an hour old, and drops them on any refusal or failure. Python never signs.

The envelopes below are signed by the TEST, standing in for the BFF. The code
under test only ever verifies.
"""

from __future__ import annotations

import ast
import base64
import hashlib
import hmac
import inspect
import json
import math
import os
import re
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest import mock

import pytest
from fastapi import APIRouter
from fastapi import FastAPI
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from starlette.datastructures import Headers

from agent.project_context import REQUEST_CONTEXT_ENVELOPE_HEADER
from agent.project_context import REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from agent.project_context import GridRequestContext
from agent_host.jobs import access as job_access
from agent_host.jobs import queue
from agent_host.jobs import run_envelope
from agent_host.jobs import worker as worker_mod
from agent_host.jobs.agent_job import run_agent_job
from agent_host.jobs.event_store import EventStore
from agent_host.jobs.run_envelope import RUN_ENVELOPE_RENEW_AFTER_MS
from agent_host.jobs.run_envelope import capture_request_envelope
from agent_host.jobs.run_envelope import envelope_headers_for_run
from agent_host.jobs.run_envelope import parse_renewal
from agent_host.jobs.run_envelope import refusal_reason
from agent_host.jobs.runner import WORKER_ENVELOPE_HEADERS
from agent_host.jobs.runner import _inject_worker_headers
from agent_host.jobs.runner import _run_user_info

from .test_job_submit_data_sources import submit_app  # noqa: F401 - the public submit route, built once

SECRET = "internal-test-token"  # noqa: S105  # pragma: allowlist secret
REPO = Path(__file__).resolve().parents[3]
SCHEMA_PATH = REPO / "apps" / "workspace" / "tests" / "fixtures" / "run-envelope.schema.json"
IDENTITY = {"organization_id": "org-1", "user_id": "user-1", "project_id": "proj-1"}
SCOPE = [{"collection": "oib_knowledge", "shelf": "base"}, {"collection": "proj_1", "shelf": "project"}]
HOUR_MS = 60 * 60 * 1000


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sign(
    *,
    user_id: str = "user-1",
    organization_id: str = "org-1",
    issued_at: int | None = None,
    scope: list[dict[str, str]] | None = SCOPE,
    secret: str = SECRET,
    marker: str = "submit",
    requester: dict[str, str] | None = None,
) -> dict[str, str]:
    """What the BFF puts on the wire (the test plays the BFF; nothing under test signs)."""
    payload: dict[str, Any] = {"organizationId": organization_id, "userId": user_id, "projectId": "proj-1"}
    if scope is not None:
        payload["collectionScope"] = scope
    payload["issuedAt"] = _now_ms() if issued_at is None else issued_at
    payload["marker"] = marker
    if requester is not None:
        payload["requester"] = requester
    raw = json.dumps(payload)
    return {
        REQUEST_CONTEXT_ENVELOPE_HEADER: base64.urlsafe_b64encode(raw.encode()).decode().rstrip("="),
        REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: hmac.new(secret.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }


def _carried(headers: dict[str, str]) -> dict[str, str]:
    return {
        "header": headers[REQUEST_CONTEXT_ENVELOPE_HEADER],
        "signature": headers[REQUEST_CONTEXT_ENVELOPE_SIG_HEADER],
    }


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("FRONTEND_INTERNAL_URL", "http://frontend:3000")


@pytest.fixture(autouse=True)
def _no_retry_pause(monkeypatch):
    async def _skip(_seconds: float) -> None:
        return None

    monkeypatch.setattr("agent_host.internal_retry._sleep", _skip)


@pytest.fixture(scope="module")
def schema() -> dict[str, Any]:
    with SCHEMA_PATH.open(encoding="utf-8") as handle:
        return json.load(handle)


def _validator(schema: dict[str, Any], name: str) -> Draft202012Validator:
    return Draft202012Validator({**schema["$defs"][name], "$defs": schema["$defs"]})


class _Response:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        if isinstance(self._body, Exception):
            raise self._body
        return self._body


class _BFF:
    """A stand-in for ``httpx.AsyncClient`` answering the renewal route."""

    calls: list[dict[str, Any]] = []
    answers: list[tuple[int, Any]] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc) -> None:
        return None

    async def post(self, url, *, json, headers):
        type(self).calls.append({"url": url, "json": json, "headers": headers})
        status, body = type(self).answers.pop(0) if len(type(self).answers) > 1 else type(self).answers[0]
        return _Response(status, body)


@pytest.fixture
def bff():
    _BFF.calls = []
    _BFF.answers = [(500, None)]
    with mock.patch("agent_host.jobs.run_envelope.httpx.AsyncClient", _BFF):
        yield _BFF


def _renewal(*, user_id: str = "user-1", scope: list[dict[str, str]] | None = SCOPE) -> dict[str, Any]:
    headers = _sign(user_id=user_id, scope=scope, marker="renewed")
    issued = json.loads(base64.urlsafe_b64decode(headers[REQUEST_CONTEXT_ENVELOPE_HEADER] + "=="))["issuedAt"]
    return {**_carried(headers), "issuedAt": issued}


# --- carry: only an envelope that speaks for the run's requester is kept -----


class TestCapture:
    def test_a_verified_envelope_is_kept_byte_for_byte(self):
        headers = _sign()
        assert capture_request_envelope(Headers(headers), user_id="user-1", organization_id="org-1") == _carried(
            headers
        )

    @pytest.mark.parametrize(
        "headers, user_id, organization_id",
        [
            (_sign(user_id="someone-else"), "user-1", "org-1"),
            (_sign(organization_id="org-2"), "user-1", "org-1"),
            (_sign(secret="not-the-secret"), "user-1", "org-1"),
            (_sign(issued_at=1), "user-1", "org-1"),
            (_sign(), None, "org-1"),
            ({}, "user-1", "org-1"),
        ],
        ids=["another-user", "another-org", "forged", "stale", "no-requester", "absent"],
    )
    def test_anything_else_is_not_carried(self, headers, user_id, organization_id):
        assert capture_request_envelope(Headers(headers), user_id=user_id, organization_id=organization_id) is None

    def test_without_the_shared_secret_nothing_is_carried(self, monkeypatch):
        monkeypatch.delenv("INTERNAL_API_TOKEN")
        assert capture_request_envelope(Headers(_sign()), user_id="user-1") is None


# --- carry: submit route -> encrypted payload -> worker -> injected headers ----


def _skill_body(**overrides: Any) -> dict[str, Any]:
    body = {
        "input": "Prüfe die Fluchtwege.",
        "output": "deep-research",
        "organization_id": "org-1",
        "user_id": "user-1",
        "project_id": "proj-1",
        "run_id": "run-1",
        "owner_email": "requester@example.com",
        "collection_scope": ["oib_knowledge", "proj_1"],
    }
    body.update(overrides)
    return body


@pytest.fixture
def db_url(tmp_path, monkeypatch):
    url = f"sqlite:///{tmp_path}/jobs.db"
    monkeypatch.setenv("NAT_JOB_STORE_DB_URL", url)
    monkeypatch.setenv("WORKER_LIVENESS_FILE", str(tmp_path / "alive"))
    monkeypatch.setenv("JOB_PAYLOAD_KEK", base64.b64encode(os.urandom(32)).decode())
    monkeypatch.delenv("DEEP_CHECKPOINT_DB", raising=False)
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()
    queue.ensure_research_queue_table(url)
    yield url
    queue._queues.pop(url, None)
    EventStore._tables_initialized.clear()
    job_access._job_access_schema_initialized.clear()


@pytest.fixture
def skills_client():
    from agent_host.routes.skills import add_skill_routes

    router = APIRouter()
    add_skill_routes(router)
    app = FastAPI()
    app.include_router(router)
    job_store = mock.MagicMock()
    job_store.ensure_job_id.side_effect = lambda job_id: job_id or "job-1"
    job_store._create_job = mock.AsyncMock(return_value=None)
    with mock.patch("nat.front_ends.fastapi.async_jobs.job_store.JobStore", return_value=job_store):
        with TestClient(app) as client:
            yield client


@pytest.fixture
def replayed(monkeypatch) -> list[dict[str, Any]]:
    """``run_agent_job`` with its real signature, recording what the worker replays."""
    calls: list[dict[str, Any]] = []
    signature = inspect.signature(run_agent_job)

    async def _bind_like_the_real_one(**kwargs):
        signature.bind(**kwargs)
        calls.append(kwargs)

    monkeypatch.setattr(worker_mod, "run_agent_job", _bind_like_the_real_one)
    return calls


class _Slot:
    def __init__(self, value: Any) -> None:
        self.value = value

    def get(self) -> Any:
        return self.value

    def set(self, value: Any) -> None:
        self.value = value


class _Attrs:
    """The request metadata a worker writes into: ``headers`` follows ``_request.headers``."""

    def __init__(self) -> None:
        self._request = SimpleNamespace(headers=Headers(headers={}))

    @property
    def headers(self) -> Headers:
        return self._request.headers


async def _submit_and_replay(client: TestClient, db_url: str, headers: dict[str, str]) -> dict[str, Any]:
    response = client.post(
        "/v1/internal/skills/submit",
        json=_skill_body(),
        headers={"x-grid-internal-token": SECRET, **headers},
    )
    assert response.status_code == 200, response.text
    claim = queue.claim_next(db_url, "worker-1", stale_seconds=30, max_attempts=3)
    assert claim is not None
    await worker_mod.ResearchWorker()._run_claimed(claim)
    return claim


async def _inject(kwargs: dict[str, Any]) -> Headers:
    state = SimpleNamespace(metadata=_Slot(_Attrs()))
    injected = await envelope_headers_for_run(
        kwargs["request_envelope"],
        run_id=kwargs["run_id"],
        job_id=kwargs["job_id"],
        identity=(kwargs["usage_context"] or {}).get("identity"),
    )
    if injected:
        _inject_worker_headers(state, injected)
    return state.metadata.get().headers


class TestCarriedThroughTheQueue:
    async def test_the_envelope_survives_submit_payload_and_injection_unchanged(
        self, db_url, skills_client, replayed, bff
    ):
        sent = _sign()
        claim = await _submit_and_replay(skills_client, db_url, sent)

        # At rest it is inside the encrypted payload, never readable in the row.
        from sqlalchemy import text

        with queue._engine(db_url).connect() as conn:
            stored = conn.execute(text("SELECT payload FROM research_job_queue")).scalar_one()
        assert stored.startswith("enc:")
        assert sent[REQUEST_CONTEXT_ENVELOPE_SIG_HEADER] not in stored
        assert claim["payload"]["request_envelope"] == _carried(sent)

        assert len(replayed) == 1
        headers = await _inject(replayed[0])
        context = GridRequestContext.from_headers(dict(headers), secret=SECRET)
        assert context.envelope_header == sent[REQUEST_CONTEXT_ENVELOPE_HEADER]
        assert context.envelope_signature == sent[REQUEST_CONTEXT_ENVELOPE_SIG_HEADER]
        assert context.user_id == "user-1"
        assert bff.calls == [], "a fresh envelope is echoed, not renewed"

    async def test_a_run_submitted_without_one_injects_none(self, db_url, skills_client, replayed, bff):
        await _submit_and_replay(skills_client, db_url, {})

        assert replayed[0]["request_envelope"] is None
        headers = await _inject(replayed[0])
        assert REQUEST_CONTEXT_ENVELOPE_HEADER not in headers
        assert REQUEST_CONTEXT_ENVELOPE_SIG_HEADER not in headers

    async def test_an_envelope_for_another_person_is_not_carried(self, db_url, skills_client, replayed, bff):
        await _submit_and_replay(skills_client, db_url, _sign(user_id="someone-else"))

        assert replayed[0]["request_envelope"] is None
        assert REQUEST_CONTEXT_ENVELOPE_HEADER not in await _inject(replayed[0])


class TestThePublicSubmitRoute:
    """``/v1/jobs/async/submit`` keeps an envelope only for the bearer token's own subject."""

    @pytest.mark.parametrize("signed_for, kept", [("user-1", True), ("someone-else", False)])
    async def test_it_carries_what_was_signed_for_the_caller(self, submit_app, signed_for, kept):  # noqa: F811
        app, submitted_job, _builder = submit_app
        sent = _sign(user_id=signed_for)
        with TestClient(app) as client:
            response = client.post(
                "/v1/jobs/async/submit", json={"agent_type": "deep_researcher", "input": "q"}, headers=sent
            )

        assert response.status_code == 200
        carried = submitted_job.await_args.kwargs["request_envelope"]
        assert carried == (_carried(sent) if kept else None)


# --- inject and renew ---------------------------------------------------------


class TestRenewal:
    async def test_a_young_envelope_is_echoed_without_asking(self, bff):
        sent = _sign(issued_at=_now_ms() - (RUN_ENVELOPE_RENEW_AFTER_MS - 60_000))

        injected = await envelope_headers_for_run(_carried(sent), run_id="run-1", job_id="job-1", identity=IDENTITY)

        assert injected == sent
        assert set(injected) == set(WORKER_ENVELOPE_HEADERS)
        assert bff.calls == []

    async def test_past_the_age_the_bff_mints_a_fresh_one(self, bff, schema):
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)
        fresh = _renewal()
        _validator(schema, "RunEnvelopeResponse").validate(fresh)
        bff.answers = [(200, fresh)]

        injected = await envelope_headers_for_run(_carried(stale), run_id="run-1", job_id="job-1", identity=IDENTITY)

        assert injected == {
            REQUEST_CONTEXT_ENVELOPE_HEADER: fresh["header"],
            REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: fresh["signature"],
        }
        (call,) = bff.calls
        assert call["url"] == "http://frontend:3000/api/internal/runs/run-1/envelope"
        assert call["headers"]["X-Grid-Internal-Token"] == SECRET
        _validator(schema, "RunEnvelopeRequest").validate(call["json"])
        assert REQUEST_CONTEXT_ENVELOPE_HEADER not in call["headers"], "the renewal names the run, not a person"

    async def test_the_run_id_is_a_quoted_path_segment(self, bff):
        bff.answers = [(200, _renewal())]
        await envelope_headers_for_run(
            _carried(_sign(issued_at=_now_ms() - 2 * HOUR_MS)), run_id="../x", job_id="job-1", identity=IDENTITY
        )
        assert bff.calls[0]["url"].endswith("/api/internal/runs/..%2Fx/envelope")

    @pytest.mark.parametrize(
        "status, refusal",
        [(404, "unknown-run"), (409, "run-not-active"), (403, "requester-may-not-act")],
    )
    async def test_a_refusal_leaves_the_run_without_one(self, bff, schema, caplog, status, refusal):
        body = {"error": refusal, "message": "Nein."}
        _validator(schema, "RunEnvelopeError").validate(body)
        bff.answers = [(status, body)]
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)

        injected = await envelope_headers_for_run(_carried(stale), run_id="run-1", job_id="job-1", identity=IDENTITY)

        assert injected == {}
        assert len(bff.calls) == 1, "a refusal is an answer, not a reason to ask again"
        assert refusal in caplog.text
        assert stale[REQUEST_CONTEXT_ENVELOPE_HEADER] not in caplog.text
        assert stale[REQUEST_CONTEXT_ENVELOPE_SIG_HEADER] not in caplog.text

    async def test_an_unreachable_bff_keeps_the_carried_envelope_inside_its_window(self, bff):
        # No verdict on the requester: the carried envelope still verifies, and
        # the BFF judges every echoed call on the requester's current rights.
        bff.answers = [(503, None)]
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)
        headers = await envelope_headers_for_run(_carried(stale), run_id="run-1", job_id="job-1")
        assert headers == stale

    async def test_a_stale_envelope_without_a_run_keeps_the_carried_one(self, bff):
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)
        headers = await envelope_headers_for_run(_carried(stale), run_id=None, job_id="job-1")
        assert headers == stale
        assert bff.calls == []

    async def test_an_envelope_past_its_window_is_dropped_whatever_the_bff_says(self, bff):
        bff.answers = [(503, None)]
        expired = _sign(issued_at=_now_ms() - 7 * HOUR_MS)
        assert await envelope_headers_for_run(_carried(expired), run_id="run-1", job_id="job-1") == {}

    @pytest.mark.parametrize(
        "fresh",
        [
            {**_renewal(), "header": "e30", "signature": "0" * 64},
            _renewal(user_id="someone-else"),
            _renewal(scope=None),
        ],
        ids=["forged", "another-person", "no-scope"],
    )
    async def test_a_renewal_that_is_not_this_runs_is_refused(self, bff, fresh):
        bff.answers = [(200, fresh)]
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)
        assert await envelope_headers_for_run(_carried(stale), run_id="run-1", job_id="job-1") == {}

    async def test_a_carried_envelope_for_another_person_is_dropped(self, bff):
        sent = _sign(user_id="someone-else")
        assert await envelope_headers_for_run(_carried(sent), run_id="run-1", job_id="job-1", identity=IDENTITY) == {}

    async def test_a_carried_envelope_that_no_longer_verifies_is_dropped(self, bff, monkeypatch):
        sent = _sign()
        monkeypatch.setenv("INTERNAL_API_TOKEN", "a-rotated-secret")
        assert await envelope_headers_for_run(_carried(sent), run_id="run-1", job_id="job-1") == {}

    @pytest.mark.parametrize("value", [None, {}, {"header": "", "signature": "x"}, "header", ["a", "b"]])
    async def test_a_run_without_a_usable_payload_value_injects_none(self, bff, value):
        assert await envelope_headers_for_run(value, run_id="run-1", job_id="job-1") == {}
        assert bff.calls == []


class TestTheWireContract:
    """The client reads exactly what the BFF's zod exports, and nothing else."""

    def test_the_fixture_is_where_the_contract_lives(self, schema):
        assert {"RunEnvelopeRequest", "RunEnvelopeResponse", "RunEnvelopeError"} <= set(schema["$defs"])

    @pytest.mark.parametrize(
        "body",
        [
            {"header": "h", "signature": "s"},
            {"header": "h", "signature": "s", "issuedAt": "1700000000000"},
            {"header": "", "signature": "s", "issuedAt": 1},
            {"header": "h", "signature": "s", "issuedAt": 1, "userId": "user-1"},
            {"header": "h", "signature": "s", "issuedAt": 1.5},
            None,
        ],
    )
    def test_what_the_schema_refuses_the_worker_refuses(self, schema, body):
        assert not _validator(schema, "RunEnvelopeResponse").is_valid(body)
        assert parse_renewal(body) is None

    def test_what_the_schema_accepts_the_worker_reads(self, schema):
        body = {"header": "h", "signature": "s", "issuedAt": 1_760_000_000_000}
        _validator(schema, "RunEnvelopeResponse").validate(body)
        parsed = parse_renewal(body)
        assert parsed is not None
        assert (parsed.header, parsed.signature) == ("h", "s")

    def test_the_renewal_age_is_the_bffs(self):
        """One decision in two languages: when the worker asks is when the BFF expects to be asked."""
        source = (REPO / "apps/workspace/bff/runs/run-envelope-types.ts").read_text(encoding="utf-8")
        match = re.search(r"export const RUN_ENVELOPE_RENEW_AFTER_MS = ([\d *]+)\n", source)
        assert match, "RUN_ENVELOPE_RENEW_AFTER_MS moved; point this test at it"
        assert math.prod(int(factor) for factor in match.group(1).split("*")) == RUN_ENVELOPE_RENEW_AFTER_MS

    def test_every_refusal_the_schema_names_is_one_the_worker_names(self, schema):
        named = schema["$defs"]["RunEnvelopeError"]["properties"]["error"]["enum"]
        assert set(named) == run_envelope.RUN_ENVELOPE_REFUSALS
        for code in named:
            assert refusal_reason({"error": code, "message": "x"}) == code
        assert refusal_reason({"error": "something-else", "message": "x"}) is None


# --- echo, never sign ------------------------------------------------------------

#: Every place in this tier that computes an HMAC, and why it may. A new one is a
#: new answer to "who signs here?", and the answer for an envelope is: nobody.
_HMAC_SITES = {
    ("packages/agent/src/agent/project_context.py", "from_envelope"),  # verifies, compare_digest
    ("apps/backend/src/agent_host/auth/utils.py", "_build_pseudonymous_trace_user_id"),  # trace ids
    ("apps/backend/src/agent_host/auth/utils.py", "_build_pseudonymous_trace_client_id"),  # trace ids
}


def _hmac_sites(root: Path) -> set[tuple[str, str]]:
    sites: set[tuple[str, str]] = set()
    for path in root.rglob("*.py"):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for function in ast.walk(tree):
            if not isinstance(function, ast.FunctionDef | ast.AsyncFunctionDef):
                continue
            for node in ast.walk(function):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr in {"new", "digest"}
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id == "hmac"
                ):
                    sites.add((path.relative_to(REPO).as_posix(), function.name))
    return sites


class TestNothingIsSignedInPython:
    def test_no_hmac_is_computed_anywhere_it_has_not_been_justified(self):
        sites = _hmac_sites(REPO / "packages" / "agent" / "src" / "agent") | _hmac_sites(
            REPO / "apps" / "backend" / "src"
        )
        assert sites == _HMAC_SITES

    def test_the_run_envelope_path_has_no_signing_primitive(self):
        imported = {
            alias.name
            for node in ast.walk(ast.parse(Path(run_envelope.__file__).read_text(encoding="utf-8")))
            if isinstance(node, ast.Import | ast.ImportFrom)
            for alias in node.names
        } | {
            node.module
            for node in ast.walk(ast.parse(Path(run_envelope.__file__).read_text(encoding="utf-8")))
            if isinstance(node, ast.ImportFrom) and node.module
        }
        assert not imported & {"hmac", "hashlib", "secrets"}

    async def test_what_is_injected_is_only_ever_bytes_the_bff_produced(self, bff):
        """Byte identity is the proof of echo: a re-encode or a re-sign would differ."""
        sent = _sign()
        assert await envelope_headers_for_run(_carried(sent), run_id="run-1", job_id="job-1") == sent

        fresh = _renewal()
        bff.answers = [(200, fresh)]
        stale = _sign(issued_at=_now_ms() - 2 * HOUR_MS)
        injected = await envelope_headers_for_run(_carried(stale), run_id="run-1", job_id="job-1")
        assert set(injected.values()) == {fresh["header"], fresh["signature"]}


class TestTheRunKnowsWhoItIsFor:
    """A scheduled fire submits no ``user_info``: the run's signed envelope names the person."""

    ANNA = {"name": "Anna Weber", "email": "anna@example.at", "organizationName": "Atelier Nord"}

    def test_a_run_without_user_info_is_named_from_its_envelope(self):
        assert _run_user_info(None, _sign(requester=self.ANNA)) == {
            "name": "Anna Weber",
            "email": "anna@example.at",
            "office": "Atelier Nord",
        }

    def test_the_user_info_a_chat_submitted_stands(self):
        submitted = {"name": "Ben Huber", "email": "ben@example.at"}
        assert _run_user_info(submitted, _sign(requester=self.ANNA)) is submitted

    def test_an_envelope_that_does_not_verify_names_nobody(self):
        assert _run_user_info(None, _sign(requester=self.ANNA, secret="another-secret")) is None
        assert _run_user_info(None, None) is None
