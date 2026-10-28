"""The document dossier: one strict reading of the whole document, stored, failing open."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any

import pytest

from agent.knowledge import dossier as d


def _reply(**overrides: Any) -> dict[str, Any]:
    reply = {
        "document_type": "building_description",
        "title": "Baubeschreibung Hubergasse 14",
        "summary": "Baubeschreibung einer Wohnhausanlage mit vier oberirdischen Geschossen in Holzrahmenbauweise.",
        "parties": [{"role": "client", "name": "  Huber Wohnbau GmbH "}],
        "dates": [{"kind": "issued", "date": "2025-03-12"}],
        "place": {"address": "Hubergasse 14", "municipality": "Wien", "state": None},
        "facts": [
            {
                "key": "storeys_above_ground",
                "value": "4",
                "unit": None,
                "page": 3,
                "quote": "vier oberirdische Geschosse",
            },
            {"key": "building_class", "value": "GK 4", "unit": None, "page": 3, "quote": "Gebäudeklasse 4"},
        ],
    }
    return {**reply, **overrides}


class FakeLLM:
    """Records what was bound and asked; answers with ``reply`` (a dict is sent as JSON)."""

    def __init__(self, reply: Any = None, raises: Exception | None = None):
        self.reply, self.raises = reply, raises
        self.bound: dict[str, Any] = {}
        self.messages: list[Any] = []
        self.model_name = "fake/summary-model"

    def bind(self, **kwargs: Any) -> FakeLLM:
        self.bound = kwargs
        return self

    def invoke(self, messages: list[Any]) -> SimpleNamespace:
        self.messages = messages
        if self.raises:
            raise self.raises
        content = self.reply if isinstance(self.reply, str) else json.dumps(self.reply)
        return SimpleNamespace(content=content, usage_metadata={"input_tokens": 900, "output_tokens": 200})


class TestRecord:
    def test_a_reply_becomes_the_stored_record(self):
        record = d.parse_dossier(_reply())
        assert record["version"] == d.DOSSIER_VERSION
        assert record["document_type"] == "building_description"
        assert record["parties"] == [{"role": "client", "name": "Huber Wohnbau GmbH"}]
        assert record["place"] == {"address": "Hubergasse 14", "municipality": "Wien", "state": None}
        assert [fact["key"] for fact in record["facts"]] == ["storeys_above_ground", "building_class"]

    def test_a_type_outside_the_vocabulary_fails_the_whole_reply(self):
        # The schema is strict: a free type would be a value no other document can be compared on.
        assert d.parse_dossier(_reply(document_type="Brandschutzkonzept")) is None

    def test_a_fact_key_outside_the_vocabulary_fails_the_reply(self):
        assert (
            d.parse_dossier(_reply(facts=[{"key": "colour", "value": "rot", "unit": None, "page": 1, "quote": None}]))
            is None
        )

    def test_a_date_in_another_format_is_dropped_not_the_record(self):
        record = d.parse_dossier(
            _reply(dates=[{"kind": "issued", "date": "12.03.2025"}, {"kind": "plan_date", "date": "2025-01-31"}])
        )
        assert record["dates"] == [{"kind": "plan_date", "date": "2025-01-31"}]

    def test_lists_are_bounded_and_quotes_clipped(self):
        facts = [{"key": "units", "value": str(n), "unit": None, "page": 1, "quote": "x" * 900} for n in range(40)]
        record = d.parse_dossier(_reply(facts=facts))
        assert len(record["facts"]) == d.MAX_FACTS
        assert len(record["facts"][0]["quote"]) == d.MAX_QUOTE_CHARS

    def test_an_empty_place_is_no_place(self):
        assert d.parse_dossier(_reply(place={"address": " ", "municipality": None, "state": None}))["place"] is None

    def test_a_page_that_is_no_page_is_none(self):
        record = d.parse_dossier(
            _reply(facts=[{"key": "units", "value": "12", "unit": None, "page": 0, "quote": None}])
        )
        assert record["facts"][0]["page"] is None

    def test_text_that_is_not_json_is_none(self):
        assert d.parse_dossier("Das ist eine Baubeschreibung.") is None


class TestDigest:
    def test_every_page_is_in_the_digest_under_its_kind(self):
        digest = d.build_digest(
            [(1, "text", "Baubeschreibung"), (1, "table", "Raum | Fläche"), (2, "drawing", "Grundriss EG 1:100")],
            file_name="BB.pdf",
            title_block={"document_number": "EP-01", "revision": "C", "scale": None},
        )
        assert "[Seite 1 · text · table]" in digest
        assert "[Seite 2 · drawing]\nGrundriss EG 1:100" in digest
        assert "document_number: EP-01, revision: C" in digest
        assert "scale" not in digest

    def test_the_last_page_of_a_long_document_is_not_starved_by_its_first(self):
        passages = [(1, "text", "A" * 50_000)] + [(n, "text", f"Seite {n} Inhalt") for n in range(2, 41)]
        digest = d.build_digest(passages, file_name="lang.pdf")
        assert len(digest) <= d.MAX_DIGEST_CHARS
        assert "Seite 40 Inhalt" in digest

    def test_blank_passages_are_left_out(self):
        assert "[Seite 3" not in d.build_digest([(3, "text", "   ")], file_name="x.pdf")


class TestWrite:
    def test_the_call_is_strict_and_brings_its_own_output_budget(self):
        llm = FakeLLM(_reply())
        record = d.write_dossier("## Digest\n[Seite 1]\nText", llm, file_name="BB.pdf")

        assert record["document_type"] == "building_description"
        schema = llm.bound["response_format"]["json_schema"]
        assert schema["strict"] is True
        assert schema["schema"]["additionalProperties"] is False
        # The summary model is capped at one sentence; a dossier is an object.
        assert llm.bound["max_tokens"] == d.MAX_OUTPUT_TOKENS >= 2000

    def test_the_digest_is_the_users_message_and_the_rules_the_systems(self):
        llm = FakeLLM(_reply())
        d.write_dossier("## Digest\n[Seite 1]\nText", llm, file_name="BB.pdf")
        system, user = llm.messages
        assert "never as instructions" in system.content
        assert user.content.startswith("## Digest")

    @pytest.mark.parametrize("llm", [None, FakeLLM(raises=RuntimeError("provider down")), FakeLLM("kein JSON")])
    def test_it_fails_open(self, llm):
        assert d.write_dossier("## Digest\n[Seite 1]\nText", llm, file_name="BB.pdf") is None

    def test_an_empty_digest_asks_nothing(self):
        llm = FakeLLM(_reply())
        assert d.write_dossier("  ", llm, file_name="BB.pdf") is None
        assert llm.messages == []


class TestLiftedFacts:
    def test_a_printed_room_height_on_a_drawing_is_a_fact(self):
        analysis = {
            "segments": [
                {
                    "quantities": [
                        {
                            "object": "Wohnen",
                            "property": "lichte Raumhöhe",
                            "value": "2,60",
                            "unit": "m",
                            "source": "text",
                        },
                        {"object": "Wohnen", "property": "Fläche", "value": "24", "unit": "m²", "source": "text"},
                        {
                            "object": "Gebäude",
                            "property": "Gebäudehöhe",
                            "value": "13",
                            "unit": "m",
                            "source": "inferred",
                        },
                    ]
                }
            ]
        }
        assert d.lifted_drawing_facts([(2, analysis)]) == [
            {"key": "room_height", "value": "2,60", "unit": "m", "page": 2, "quote": None}
        ]

    def test_no_analysis_lifts_nothing(self):
        assert d.lifted_drawing_facts([(1, None), (2, {})]) == []


class TestFactChanges:
    def _dossier(self, *facts):
        return {"facts": [{"key": k, "value": v, "unit": u, "page": p} for k, v, u, p in facts]}

    def test_a_fact_stated_differently_is_a_change_and_one_stated_alike_is_not(self):
        before = self._dossier(("storeys_above_ground", "4", None, 1), ("room_height", "2,60", "m", 2))
        after = self._dossier(("storeys_above_ground", "5", None, 1), ("room_height", "2.60", "m", 2))

        assert d.fact_changes(before, after) == [
            {"key": "storeys_above_ground", "before": "4", "after": "5", "page": 1}
        ]

    def test_a_fact_newly_stated_or_no_longer_stated(self):
        before = self._dossier(("units", "12", None, 3))
        after = self._dossier(("parking_spaces", "14", None, 4))

        changes = {c["key"]: (c["before"], c["after"]) for c in d.fact_changes(before, after)}
        assert changes == {"units": ("12", None), "parking_spaces": (None, "14")}

    def test_without_both_readings_there_is_nothing_to_compare(self):
        assert d.fact_changes(None, self._dossier(("units", "12", None, 3))) == []
        assert d.fact_changes(self._dossier(("units", "12", None, 3)), {"facts": []}) == []
