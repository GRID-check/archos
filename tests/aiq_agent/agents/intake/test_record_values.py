"""``record_values``: checked here before anything is sent, decided by the BFF after.

Three checks run in the process: the quote stands in what this run read of
that file (NFC, whitespace and case folded), a select token is one of the
question's options, and the decision model does not read the quote as stating
something else (ADR-0096's check, ADR-0064 use 12). Only what passes is sent.
"""

from __future__ import annotations

import pytest

from aiq_agent.agents.intake.tools import IntakeSession
from aiq_agent.agents.intake.tools import RecordedValue
from aiq_agent.agents.intake.tools import record_values
from tests.aiq_agent.agents.intake.conftest import JOB
from tests.aiq_agent.agents.intake.conftest import NEEDS_BODY
from tests.aiq_agent.agents.intake.conftest import recorded_all
from tests.aiq_agent.agents.intake.conftest import validator


@pytest.fixture
def session() -> IntakeSession:
    session = IntakeSession(job_id=JOB, organization_id="org-1")
    session.remember_needs(NEEDS_BODY)
    return session


@pytest.fixture
def pages_read(read_log):
    read_log.log("Baubeschreibung.pdf", 2, "Tragwerk: Das Gebäude wird in\nHolzbauweise   errichtet.")
    read_log.log("Baubeschreibung.pdf", 3, "Das Gebäude hat drei oberirdische Geschoße und ein Kellergeschoß.")
    return read_log


def _value(key: str, value, quote: str, *, file_name: str = "Baubeschreibung.pdf", page: int | None = 3):
    return RecordedValue(key=key, value=value, file_name=file_name, page=page, quote=quote)


class TestTheQuoteMustHaveBeenRead:
    async def test_a_quote_nobody_read_is_refused_before_any_request(self, signed_run, route, session, pages_read):
        fake = route(record=recorded_all())
        text = await record_values(session, [_value("geschosse_oberirdisch@bw1", 4, "vier oberirdische Geschoße")])

        assert "read_document" in text and "exact words" in text
        assert fake.bodies("record") == []
        assert session.refusals == {"local:quote-not-read": 1}

    async def test_a_file_nobody_opened_is_refused_with_the_way_to_read_it(
        self, signed_run, route, session, pages_read
    ):
        fake = route(record=recorded_all())
        text = await record_values(
            session, [_value("bundesland", "wien", "Bundesland: Wien", file_name="Einreichplan.pdf", page=1)]
        )

        assert "have not read „Einreichplan.pdf“" in text and "read_document" in text
        assert fake.bodies("record") == []

    async def test_a_quote_read_is_accepted_whatever_its_whitespace_case_and_unicode_form(
        self, signed_run, route, session, pages_read, intake_schema
    ):
        fake = route(record=recorded_all())
        quote = "das GEBÄUDE hat drei   oberirdische\nGeschoße".replace("Ä", "Ä")
        text = await record_values(session, [_value("geschosse_oberirdisch@bw1", "3", quote, page=None)])

        (body,) = fake.bodies("record")
        (sent,) = body["values"]
        assert sent["value"] == 3, "a number the model wrote as text goes out as a number"
        assert sent["evidence"] == {"fileName": "Baubeschreibung.pdf", "page": 3, "quote": " ".join(quote.split())}
        assert not list(validator(intake_schema, "InternalIntakeRequest").iter_errors(body))
        assert "geschosse_oberirdisch@bw1 = 3: suggested" in text

    async def test_the_quote_is_clipped_to_what_a_person_reads(self, signed_run, route, session, read_log):
        long_text = "Holzbau " * 80
        read_log.log("Baubeschreibung.pdf", 2, long_text)
        fake = route(record=recorded_all())
        await record_values(session, [_value("bauweise", ["holzbau"], long_text, page=2)])
        (sent,) = fake.bodies("record")[0]["values"]
        assert len(sent["evidence"]["quote"]) <= 300


class TestTheVocabulary:
    async def test_a_token_outside_the_options_is_refused_with_the_tokens(self, signed_run, route, session, pages_read):
        fake = route(record=recorded_all())
        text = await record_values(session, [_value("bauweise", ["holzbauweise"], "in Holzbauweise errichtet", page=2)])

        assert "holzbauweise is not an option" in text and "holzbau, massivbau" in text
        assert fake.bodies("record") == []


class TestTheQuoteMustStateTheValue:
    async def test_a_select_value_its_quote_contradicts_is_dropped(
        self, signed_run, route, session, pages_read, decider
    ):
        """ADR-0096: Holzbau quoted as Massivbau scores p(stated) 0.04 and is not suggested."""
        seen = decider({"Massivbau": 0.04})
        fake = route(record=recorded_all())
        text = await record_values(
            session,
            [
                _value("bauweise", ["massivbau"], "in Holzbauweise errichtet", page=2),
                _value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße"),
            ],
        )

        assert [state["fact"] for state in seen] == ["Bauweise"], "the question's own label names the fact"
        (body,) = fake.bodies("record")
        assert [value["key"] for value in body["values"]] == ["geschosse_oberirdisch@bw1"]
        assert "bauweise: not sent: read as not stating this value" in text
        assert session.refusals["local:not-stated"] == 1

    async def test_a_multi_select_keeps_the_tokens_its_quote_states(
        self, signed_run, route, session, pages_read, decider
    ):
        decider({"Holzbau": 0.92, "Massivbau": 0.05})
        fake = route(record=recorded_all())
        await record_values(
            session, [_value("bauweise", ["holzbau", "massivbau"], "in Holzbauweise errichtet", page=2)]
        )

        (sent,) = fake.bodies("record")[0]["values"]
        assert sent["value"] == ["holzbau"]

    async def test_a_decision_model_that_is_down_leaves_the_value_as_it_was(
        self, signed_run, route, session, pages_read, monkeypatch
    ):
        def broken(*args, **kwargs):
            raise RuntimeError("decider down")

        monkeypatch.setattr("aiq_agent.common.decisions.decide_many_blocking", broken)
        fake = route(record=recorded_all())
        await record_values(session, [_value("bauweise", ["holzbau"], "in Holzbauweise errichtet", page=2)])
        (sent,) = fake.bodies("record")[0]["values"]
        assert sent["value"] == ["holzbau"]


class TestTheBffDecides:
    async def test_each_outcome_is_reported_per_key(self, signed_run, route, session, pages_read, decider):
        decider({})
        outcomes = iter(
            [{"outcome": "contradiction"}, {"outcome": "refused", "reason": "dismissed"}, {"outcome": "corroborated"}]
        )
        route(record=lambda body: {"results": [{"key": v["key"], **next(outcomes)} for v in body["values"]]})
        text = await record_values(
            session,
            [
                _value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße"),
                _value("bauweise", ["holzbau"], "in Holzbauweise errichtet", page=2),
                _value("bundesland", "wien", "1010 Wien", page=1, file_name="Baubeschreibung.pdf"),
            ],
        )

        lines = text.splitlines()
        assert "contradiction" in lines[0]
        assert "dismissed this value before" in lines[1]
        # The third quote was never read (page 1 is not in the log): refused here, never sent.
        assert "not sent" in lines[2]
        assert session.outcomes == {"contradiction": 1}
        assert session.refusals["refused:dismissed"] == 1

    async def test_a_stale_reading_stops_every_later_record(self, signed_run, route, session, pages_read):
        fake = route(record=409)
        first = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße")])
        second = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße")])

        assert "stale-reading" in first
        assert session.stale and "no longer the project's current one" in second
        assert len(fake.bodies("record")) == 1

    async def test_without_an_envelope_nothing_is_recorded(self, unsigned_run, route, session, pages_read):
        fake = route(record=recorded_all())
        text = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße")])
        assert "no signed identity" in text
        assert fake.requests == []
