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
from aiq_agent.agents.intake.tools import withdraw_values
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

        assert "does not stand in what you read" in text
        assert "Closest passage you read on page 3: „Gebäude hat drei oberirdische Geschoße“" in text
        assert fake.bodies("record") == []
        assert session.refusals == {"local:quote-not-read": 1}

    async def test_a_quote_nothing_read_comes_close_to_says_to_read_the_page(
        self, signed_run, route, session, pages_read
    ):
        route(record=recorded_all())
        text = await record_values(session, [_value("bundesland", "wien", "Bundesland Wien laut Grundbuch", page=1)])
        assert "Closest passage" not in text and "read_document" in text and "exact words" in text

    async def test_the_closest_passage_offered_is_itself_a_quote_that_passes(
        self, signed_run, route, session, pages_read
    ):
        route(record=recorded_all())
        refused = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, "drei oberirdischen Geschosse")])
        offered = refused.split("„")[-1].split("“")[0]
        accepted = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, offered)])
        assert "suggested" in accepted

    async def test_the_citation_a_reading_tool_printed_names_the_file_and_page(
        self, signed_run, route, session, pages_read
    ):
        fake = route(record=recorded_all())
        for citation in (
            "Baubeschreibung.pdf, p.3",
            "Baubeschreibung.pdf, S. 3",
            "Baubeschreibung.pdf (Projektwissen), Seite 3",
        ):
            item = RecordedValue(
                key="geschosse_oberirdisch@bw1", value=3, citation=citation, quote="drei oberirdische Geschoße"
            )
            text = await record_values(session, [item])
            assert "suggested" in text, citation
        assert [body["values"][0]["evidence"] for body in fake.bodies("record")] == [
            {"fileName": "Baubeschreibung.pdf", "page": 3, "quote": "drei oberirdische Geschoße"}
        ] * 3

    async def test_a_value_that_names_no_file_is_not_sent(self, signed_run, route, session, pages_read):
        fake = route(record=recorded_all())
        item = RecordedValue(key="geschosse_oberirdisch@bw1", value=3, quote="drei oberirdische Geschoße")
        text = await record_values(session, [item])
        assert "citation or file_name" in text and fake.bodies("record") == []

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

    async def test_a_key_no_question_writes_is_refused_with_the_closest_keys_it_knows(
        self, signed_run, route, session, pages_read
    ):
        route(
            record=lambda body: {
                "results": [{"key": v["key"], "outcome": "refused", "reason": "unknown-key"} for v in body["values"]]
            }
        )
        text = await record_values(session, [_value("geschosse_oberirdish@bw1", 3, "drei oberirdische Geschoße")])
        assert "no question of the intake writes this key" in text
        assert "closest keys intake_needs listed: geschosse_oberirdisch@bw1" in text
        assert session.refusals["refused:unknown-key"] == 1

    async def test_a_recorded_building_class_is_refused_as_derived(self, signed_run, route, session, pages_read):
        route(
            record=lambda body: {
                "results": [{"key": "gebaeudeklasse@bw1", "outcome": "refused", "reason": "unknown-key"}]
            }
        )
        text = await record_values(session, [_value("gebaeudeklasse@bw1", 1, "drei oberirdische Geschoße")])
        assert "the Gebäudeklasse is derived from the inputs you record" in text
        assert "closest keys" not in text

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


class TestWhatARecordOpened:
    async def test_the_answer_names_the_needs_the_values_opened_decisive_marked(
        self, signed_run, route, session, pages_read, intake_schema
    ):
        answer = {
            "results": [{"key": "bauwerkstyp@bw1", "outcome": "suggested"}],
            "opened": [
                {"key": "fluchtniveau_m@bw1", "decisive": True},
                {"key": "gebaeudestellung@bw1", "decisive": False},
            ],
        }
        assert not list(validator(intake_schema, "InternalIntakeRecordResponse").iter_errors(answer))
        route(record=answer)
        text = await record_values(session, [_value("bauwerkstyp@bw1", "gebaeude", "Das Gebäude hat drei")])
        assert text.splitlines()[-1].startswith("opened: fluchtniveau_m@bw1 [decisive], gebaeudestellung@bw1 (")

    async def test_nothing_opened_adds_no_line(self, signed_run, route, session, pages_read):
        route(record=lambda body: {**recorded_all()(body), "opened": []})
        text = await record_values(session, [_value("geschosse_oberirdisch@bw1", 3, "drei oberirdische Geschoße")])
        assert "opened" not in text


class TestWithdrawingOwnSuggestions:
    async def test_each_key_says_what_became_of_it_and_is_counted(self, signed_run, route, session, intake_schema):
        answer = {
            "results": [
                {"key": "projektphase", "outcome": "withdrawn"},
                {"key": "bundesland", "outcome": "refused", "reason": "not-this-reading"},
                {"key": "bauweise", "outcome": "refused", "reason": "confirmed"},
            ]
        }
        assert not list(validator(intake_schema, "InternalIntakeWithdrawResponse").iter_errors(answer))
        fake = route(withdraw=answer)

        text = await withdraw_values(session, ["projektphase", "bundesland", "bauweise", "projektphase"])

        (body,) = fake.bodies("withdraw")
        assert body == {"op": "withdraw", "jobId": JOB, "keys": ["projektphase", "bundesland", "bauweise"]}
        assert not list(validator(intake_schema, "InternalIntakeRequest").iter_errors(body))
        lines = text.splitlines()
        assert "withdrawn" in lines[0] and "a later reading may record it again" in lines[0]
        assert "not a suggestion of this reading" in lines[1]
        assert "a person confirmed this value" in lines[2]
        assert session.outcomes["withdrawn"] == 1
        assert session.refusals["withdraw:not-this-reading"] == 1

    async def test_a_stale_reading_withdraws_nothing(self, signed_run, route, session):
        fake = route(withdraw=409)
        first = await withdraw_values(session, ["projektphase"])
        second = await withdraw_values(session, ["projektphase"])
        assert "stale-reading" in first and "no longer the project's current one" in second
        assert len(fake.bodies("withdraw")) == 1

    async def test_no_key_sends_nothing(self, signed_run, route, session):
        fake = route()
        assert await withdraw_values(session, ["", "  "]) == "Nothing to withdraw."
        assert fake.requests == []


class TestTheNeedsAnswer:
    def test_a_confirmed_input_is_shown_as_confirmed_after_the_open_ones(self):
        from aiq_agent.agents.intake.tools import render_needs

        confirmed = {**NEEDS_BODY["needs"][0], "key": "bauwerkstyp@bw1", "decisive": False, "state": "confirmed"}
        text = render_needs({**NEEDS_BODY, "needs": [confirmed, *NEEDS_BODY["needs"]]})
        assert "(2 open, 1 suggested so far, 1 confirmed by a person)" in text
        lines = [line for line in text.splitlines() if line.startswith("- ") and "—" in line]
        assert lines[-1].startswith("- bauwerkstyp@bw1") and lines[-1].endswith(
            "· confirmed · found in: Einreichplan, Schnitte"
        )

    def test_a_bounded_answer_names_the_call_that_shows_the_rest(self):
        from aiq_agent.agents.intake.tools import MAX_RENDERED_NEEDS
        from aiq_agent.agents.intake.tools import render_needs

        many = [
            {**NEEDS_BODY["needs"][1], "key": f"k{index}", "decisive": False} for index in range(MAX_RENDERED_NEEDS + 5)
        ]
        first = render_needs({**NEEDS_BODY, "needs": many})
        assert f"intake_needs(start={MAX_RENDERED_NEEDS}) lists them" in first
        rest = render_needs({**NEEDS_BODY, "needs": many}, start=MAX_RENDERED_NEEDS)
        assert f"[Needs {MAX_RENDERED_NEEDS + 1}–{MAX_RENDERED_NEEDS + 5} of {MAX_RENDERED_NEEDS + 5}.]" in rest
        assert "more needs not listed" not in rest


class TestTheDescriptionsCarryTheRules:
    """The prompt prescribes no procedure, so each tool's description says how it is used (ADR-0060)."""

    def test_record_values_says_how_a_value_is_written_and_what_each_outcome_means(self):
        from aiq_agent.agents.intake.tools import RECORD_VALUES_DESCRIPTION

        for phrase in (
            "option token exactly",
            "plain number in the question's unit",
            "true or false",
            "the document's own words",
            "never paraphrased",
            "Zielzustand",
            "Example:",
            "suggested (",
            "corroborated (",
            "contradiction (",
            "refused, with the reason",
        ):
            assert phrase in RECORD_VALUES_DESCRIPTION, phrase

    def test_record_values_says_what_does_not_count_as_stated_and_why(self):
        from aiq_agent.agents.intake.tools import RECORD_VALUES_DESCRIPTION

        for phrase in ("undecided, under review or one of several options", "Planart", "names the drawing"):
            assert phrase in RECORD_VALUES_DESCRIPTION, phrase
        # The route refuses the class: the description says never, and why.
        assert "Never record the Gebäudeklasse, even where a document states one" in RECORD_VALUES_DESCRIPTION
        assert "unless a document states the class" not in RECORD_VALUES_DESCRIPTION

    def test_withdraw_values_says_whose_values_go_and_that_none_is_refused_later(self):
        from aiq_agent.agents.intake.tools import WITHDRAW_VALUES_DESCRIPTION

        for phrase in ("recorded in this run", "derived Gebäudeklasse", "not refused", "a later reading may record"):
            assert phrase in WITHDRAW_VALUES_DESCRIPTION, phrase

    def test_intake_needs_says_what_each_state_means(self):
        from aiq_agent.agents.intake.tools import INTAKE_NEEDS_DESCRIPTION

        for phrase in ("`open`", "`suggested`", "`confirmed`", "contradiction a person decides", "`start`"):
            assert phrase in INTAKE_NEEDS_DESCRIPTION, phrase

    def test_finish_intake_says_the_summary_is_grounded(self):
        from aiq_agent.agents.intake.tools import FINISH_INTAKE_DESCRIPTION

        assert "rests on something a tool returned in this run" in FINISH_INTAKE_DESCRIPTION
