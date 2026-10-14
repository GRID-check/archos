"""The intake API client: the bodies are the contract's, the envelope is echoed, a refusal is text.

The contract is ``frontends/ui/tests/fixtures/project-intake.schema.json``,
exported from ``lib/project-intake/types.ts``. There is no Pydantic twin.
"""

from __future__ import annotations

import pytest

from aiq_agent.agents.intake import client
from tests.aiq_agent.agents.intake.conftest import HEADER
from tests.aiq_agent.agents.intake.conftest import JOB
from tests.aiq_agent.agents.intake.conftest import NEEDS_BODY
from tests.aiq_agent.agents.intake.conftest import SIGNATURE
from tests.aiq_agent.agents.intake.conftest import TOKEN
from tests.aiq_agent.agents.intake.conftest import validator

REQUEST = "InternalIntakeRequest"

VALUE = {
    "key": "geschosse_oberirdisch@bw1",
    "value": 3,
    "evidence": {"fileName": "Baubeschreibung.pdf", "page": 3, "quote": "drei oberirdische Geschoße"},
}


class TestTheWireContract:
    @pytest.mark.parametrize(
        "name",
        [REQUEST, "InternalIntakeNeedsResponse", "InternalIntakeRecordResponse", "InternalIntakeFinishResponse"],
    )
    def test_the_fixture_is_where_the_contract_lives(self, intake_schema, name):
        assert name in intake_schema["$defs"]

    @pytest.mark.parametrize(
        "body",
        [
            client.needs_request(JOB),
            client.record_request(JOB, [VALUE]),
            client.record_request(JOB, [{**VALUE, "value": ["holzbau", "massivbau"]}]),
            client.record_request(JOB, [{**VALUE, "evidence": {**VALUE["evidence"], "page": None}}]),
            client.finish_request(JOB, "Drei Dokumente gelesen.", ["Baubeschreibung.pdf"], "a" * 32),
            client.finish_request(JOB, "", [], None),
        ],
        ids=["needs", "record", "record-multi", "record-no-page", "finish", "finish-empty"],
    )
    def test_every_body_the_client_builds_is_one_the_route_accepts(self, intake_schema, body):
        errors = sorted(validator(intake_schema, REQUEST).iter_errors(body), key=str)
        assert not errors, [error.message for error in errors]

    def test_a_record_never_carries_more_values_than_the_route_takes(self, intake_schema):
        body = client.record_request(JOB, [VALUE] * 25)
        assert len(body["values"]) == client.MAX_RECORD_VALUES
        assert not list(validator(intake_schema, REQUEST).iter_errors(body))

    def test_a_finish_is_bounded_to_the_contract(self, intake_schema):
        body = client.finish_request(JOB, "x" * 5000, [f"Datei {n}.pdf" for n in range(600)], None)
        assert len(body["summary"]) == client.MAX_SUMMARY_CHARS
        assert len(body["documentsRead"]) == client.MAX_DOCUMENTS_READ
        assert not list(validator(intake_schema, REQUEST).iter_errors(body))

    def test_the_needs_answer_the_tests_use_is_the_contracts(self, intake_schema):
        """The double the suite answers with is a body the BFF could send."""
        errors = sorted(validator(intake_schema, "InternalIntakeNeedsResponse").iter_errors(NEEDS_BODY), key=str)
        assert not errors, [error.message for error in errors]


class TestEchoNeverSign:
    async def test_the_envelope_goes_out_unchanged_beside_the_service_token(self, signed_run, route):
        fake = route()
        reply = await client.call_intake("needs", client.needs_request(JOB))

        assert reply.ok and reply.body["mode"] == "active"
        (request,) = fake.requests
        assert request.full_url == "http://bff.test/api/internal/project-intake"
        assert request.get_header("X-grid-internal-token") == TOKEN
        assert request.get_header("X-grid-request-context") == HEADER
        assert request.get_header("X-grid-request-context-sig") == SIGNATURE

    async def test_a_run_without_an_envelope_sends_nothing_and_says_so(self, unsigned_run, route):
        fake = route()
        reply = await client.call_intake("needs", client.needs_request(JOB))

        assert not reply.ok and reply.reason == "no_envelope"
        assert "no signed identity" in reply.refusal
        assert fake.requests == []


class TestRefusalsAreText:
    async def test_a_stale_reading_is_named(self, signed_run, route):
        route(needs=409)
        reply = await client.call_intake("needs", client.needs_request(JOB))
        assert not reply.ok and reply.stale and reply.reason == "stale-reading"
        assert "finish_intake" in reply.refusal

    async def test_an_unreachable_route_never_raises(self, signed_run, route):
        route(needs=OSError("connection refused"))
        reply = await client.call_intake("needs", client.needs_request(JOB))
        assert not reply.ok and not reply.stale
        assert "not reachable" in reply.refusal
