"""Tests for the hand-written OIB applicability module."""

import pytest

from aiq_agent.common import applicability
from aiq_agent.common.applicability import OibVerdict
from aiq_agent.common.applicability import facts_from_project_context
from aiq_agent.common.applicability import render_project_block
from aiq_agent.common.applicability import resolve_oib_applicability
from aiq_agent.common.applicability import trigger_hints


def _by_code(facts: dict) -> dict[str, OibVerdict]:
    return {verdict.code: verdict for verdict in resolve_oib_applicability(facts)}


class TestResolveOibApplicability:
    def test_empty_facts_return_generic_six_all_required(self):
        verdicts = resolve_oib_applicability({})
        assert [v.code for v in verdicts] == ["OIB 1", "OIB 2", "OIB 3", "OIB 4", "OIB 5", "OIB 6"]
        assert all(v.verdict == "required" for v in verdicts)

    def test_oib_1_2_3_always_required(self):
        for code in ("OIB 1", "OIB 2", "OIB 3"):
            assert _by_code({"hauptnutzung": "wohnen"})[code].verdict == "required"

    def test_gk5_undefined_fluchtniveau_flags_2_3_check(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5"})
        assert verdicts["OIB 2.3"].verdict == "check"
        assert "22 m" in verdicts["OIB 2.3"].reason_de

    def test_fluchtniveau_over_22m_makes_2_3_required_hochhaus(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK5", "fluchtniveau": ">22m"})
        assert verdicts["OIB 2.3"].verdict == "required"
        assert "Hochhaus" in verdicts["OIB 2.3"].reason_de

    def test_low_rise_residential_omits_fire_substandards_and_oib5_required(self):
        verdicts = _by_code({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK2", "fluchtniveau": "<=7m"})
        assert "OIB 2.1" not in verdicts
        assert "OIB 2.2" not in verdicts
        assert "OIB 2.3" not in verdicts
        assert verdicts["OIB 5"].verdict == "required"

    def test_lager_makes_2_1_required_and_6_check(self):
        verdicts = _by_code({"hauptnutzung": "lager", "geschosse_unterirdisch": 2})
        assert verdicts["OIB 2.1"].verdict == "required"
        assert verdicts["OIB 2.2"].verdict == "check"  # basement -> garage check
        assert verdicts["OIB 6"].verdict == "check"

    def test_undefined_use_makes_2_1_check(self):
        verdicts = _by_code({"gebaeudeklasse": "GK3"})
        assert verdicts["OIB 2.1"].verdict == "check"

    def test_non_betriebsbau_use_omits_2_1(self):
        verdicts = _by_code({"hauptnutzung": "wohnen"})
        assert "OIB 2.1" not in verdicts

    def test_public_use_gets_stronger_oib4_reason(self):
        verdicts = _by_code({"hauptnutzung": "versammlung"})
        assert verdicts["OIB 4"].verdict == "required"
        assert "öffentlich" in verdicts["OIB 4"].reason_de

    def test_non_noise_sensitive_use_makes_oib5_likely(self):
        verdicts = _by_code({"hauptnutzung": "produzierend"})
        assert verdicts["OIB 5"].verdict == "likely"

    def test_verdict_carries_both_languages(self):
        verdicts = _by_code({"hauptnutzung": "lager"})
        assert verdicts["OIB 2.1"].reason_en == "Manufacturing/storage use is a Betriebsbau."


class TestTriggerHints:
    def test_no_hints_when_no_triggers(self):
        assert trigger_hints({"hauptnutzung": "wohnen"}) == []

    def test_boolean_true_triggers_hint(self):
        hints = trigger_hints({"denkmalschutz": True})
        assert len(hints) == 1
        assert "DMSG" in hints[0]

    def test_string_true_triggers_hint(self):
        assert trigger_hints({"stellplatz_relevant": "true"}) == [
            "Stellplatzverpflichtung: Wiener Garagengesetz (bzw. Landesrecht) prüfen."
        ]

    def test_false_does_not_trigger(self):
        assert trigger_hints({"kleingartengebiet": False, "betriebsanlage": "false"}) == []

    def test_all_four_triggers_in_definition_order(self):
        facts = {
            "stellplatz_relevant": True,
            "kleingartengebiet": True,
            "betriebsanlage": True,
            "denkmalschutz": True,
        }
        hints = trigger_hints(facts)
        assert len(hints) == 4
        assert hints[0].startswith("Kleingartengebiet")
        assert hints[1].startswith("Denkmalschutz")
        assert hints[2].startswith("Betriebsanlage")
        assert hints[3].startswith("Stellplatzverpflichtung")


class TestFactsFromProjectContext:
    def test_parses_confirmed_facts(self):
        text = (
            "PROJECT_CONTEXT v1\n"
            "confirmed:\n"
            "- bundesland=wien\n"
            "- hauptnutzung=wohnen\n"
            "- geschosse_unterirdisch=2\n"
            "goals:\n"
            "- build a house\n"
            "unknown:\n"
            "- fluchtniveau\n"
        )
        facts = facts_from_project_context(text)
        assert facts == {"bundesland": "wien", "hauptnutzung": "wohnen", "geschosse_unterirdisch": 2}

    def test_coerces_booleans(self):
        text = "PROJECT_CONTEXT v1\nconfirmed:\n- stellplatz_relevant=true\n- denkmalschutz=false\n"
        facts = facts_from_project_context(text)
        assert facts == {"stellplatz_relevant": True, "denkmalschutz": False}
        assert facts["stellplatz_relevant"] is True
        assert facts["denkmalschutz"] is False

    def test_ignores_non_confirmed_sections(self):
        text = "PROJECT_CONTEXT v1\ngoals:\n- hauptnutzung=wohnen\n"
        assert facts_from_project_context(text) == {}

    def test_handles_quoted_values(self):
        text = 'PROJECT_CONTEXT v1\nconfirmed:\n- standort_details="Am Hang, 1230 Wien"\n'
        assert facts_from_project_context(text) == {"standort_details": "Am Hang, 1230 Wien"}

    def test_empty_text(self):
        assert facts_from_project_context("") == {}

    def test_suggestions_and_contested_sections_add_no_facts(self):
        """The intake's suggestions ride the view (frontends/ui prompt-view.ts); only ``confirmed:`` is a fact.

        An ``assumptions:`` line now ends in ``[Vorschlag: Datei, S. n]`` or ``[abgeleitet]``, and a
        ``contested:`` section lists ``- key: value | alternativ: v2 (Datei, S. n)``. A file name may
        itself contain ``=``; none of it may leak into the facts.
        """
        confirmed_only = (
            "PROJECT_CONTEXT v1\n\n"
            "confirmed:\n"
            "- bauwerkstyp@bw1=gebaeude\n"
            "- bundesland=wien\n"
            "- geschosse_oberirdisch@bw1=3\n"
            "- nutzungen@bw1=wohnen\n"
        )
        text = (
            confirmed_only
            + "\n"
            + "goals:\n"
            + "- primary=check_oib_requirements\n\n"
            + "unknown:\n"
            + "- fluchtniveau_m@bw1\n\n"
            + "assumptions:\n"
            + "- bgf_oberirdisch@bw1=412 [Vorschlag: Raumbuch=2026.xlsx]\n"
            + "- fluchtniveau_m@bw1=9.5 [Vorschlag: Einreichplan Schnitt.pdf, S. 2]\n"
            + "- gebaeudeklasse@bw1=2 [abgeleitet]\n"
            + "- widmung=bauland\n\n"
            + "contested:\n"
            + "- fluchtniveau_m@bw1: 9.5 | alternativ: 11 (Brandschutzkonzept.pdf, S. 3)\n"
            + "- geschosse_oberirdisch@bw1: 3 | alternativ: 4 (Plan=final.pdf, S. 2) | alternativ: 5\n"
            + "- … und 3 weitere"
        )

        assert facts_from_project_context(text) == facts_from_project_context(confirmed_only)
        assert facts_from_project_context(text) == {
            "bauwerkstyp@bw1": "gebaeude",
            "bundesland": "wien",
            "geschosse_oberirdisch@bw1": 3,
            "nutzungen@bw1": "wohnen",
        }


class TestRenderProjectBlock:
    def test_none_when_facts_empty(self):
        assert render_project_block("") is None
        assert render_project_block("PROJECT_CONTEXT v1\ngoals:\n- x\n") is None

    def test_renders_section_with_verdicts_and_reasons(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=lager\n"
        block = render_project_block(context)
        assert block is not None
        assert "### Für dieses Projekt voraussichtlich einschlägig" in block
        assert "OIB 1 — verbindlich —" in block
        assert "OIB 2.1 — verbindlich —" in block
        assert "OIB 6 — zu prüfen —" in block

    def test_appends_trigger_hints(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n- denkmalschutz=true\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz:" in block

    def test_no_trigger_lines_when_no_triggers(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz" not in block
        assert "Kleingartengebiet" not in block


class TestFluchtniveauBand:
    @pytest.mark.parametrize(
        ("metres", "band"),
        [(7, "<=7m"), (7.5, "7-11m"), (11, "7-11m"), (11.5, "11-22m"), (22, "11-22m"), (22.5, ">22m")],
    )
    def test_band_from_bauwerk_metres(self, metres, band):
        assert applicability.fluchtniveau_band({"fluchtniveau_m@bw1": metres}) == band

    def test_highest_metres_across_bauwerke(self):
        assert applicability.fluchtniveau_band({"fluchtniveau_m@bw1": 5, "fluchtniveau_m@bw2": 23}) == ">22m"
        assert applicability.fluchtniveau_band({"fluchtniveau_m": 9, "fluchtniveau_m@bw2": 4}) == "7-11m"

    def test_stated_flat_band_wins(self):
        assert applicability.fluchtniveau_band({"fluchtniveau": "<=7m", "fluchtniveau_m@bw1": 30}) == "<=7m"

    def test_empty_stated_band_is_no_answer(self):
        assert applicability.fluchtniveau_band({"fluchtniveau": "", "fluchtniveau_m@bw1": 30}) == ">22m"

    def test_zone_copy_and_missing_metres_are_not_read(self):
        assert applicability.fluchtniveau_band({"fluchtniveau_m@bw1@wohnen": 30}) is None
        assert applicability.fluchtniveau_band({"hauptnutzung": "wohnen"}) is None

    def test_non_finite_metres_are_not_read(self):
        assert applicability.fluchtniveau_band({"fluchtniveau_m@bw1": "nan"}) is None


class TestWizardScopedFacts:
    def test_scoped_metres_above_22_flag_hochhaus(self):
        assert _by_code({"gebaeudeklasse": "GK5", "fluchtniveau_m@bw1": 22.5})["OIB 2.3"].verdict == "required"

    def test_exactly_22_metres_does_not_flag_2_3(self):
        assert "OIB 2.3" not in _by_code({"gebaeudeklasse": "GK5", "fluchtniveau_m@bw1": 22})

    def test_scoped_gebaeudeklasse_accepts_bare_number_and_gk_prefix(self):
        assert _by_code({"gebaeudeklasse@bw1": 5})["OIB 2.3"].verdict == "check"
        assert _by_code({"gebaeudeklasse@bw1": "5"})["OIB 2.3"].verdict == "check"
        assert _by_code({"gebaeudeklasse@bw1": "GK5"})["OIB 2.3"].verdict == "check"

    def test_bare_and_gk_prefixed_class_4_read_alike(self):
        bare = resolve_oib_applicability({"hauptnutzung": "wohnen", "gebaeudeklasse@bw1": "4"})
        prefixed = resolve_oib_applicability({"hauptnutzung": "wohnen", "gebaeudeklasse": "GK4"})
        assert bare == prefixed
        assert "OIB 2.3" not in _by_code({"gebaeudeklasse@bw1": "4"})

    def test_highest_gebaeudeklasse_across_bauwerke(self):
        verdicts = _by_code({"gebaeudeklasse@bw1": "4", "gebaeudeklasse@bw2": "GK5"})
        assert verdicts["OIB 2.3"].verdict == "check"

    def test_highest_basement_count_across_bauwerke(self):
        assert _by_code({"geschosse_unterirdisch@bw1": 0, "geschosse_unterirdisch@bw2": 2})["OIB 2.2"].verdict == (
            "check"
        )
        assert "OIB 2.2" not in _by_code({"geschosse_unterirdisch@bw1": 0, "geschosse_unterirdisch@bw2": 0})

    def test_one_verdict_use_shared_by_bauwerke_is_hauptnutzung(self):
        verdicts = _by_code({"nutzungen@bw1": ["wohnen"], "nutzungen@bw2": ["wohnen"]})
        assert "OIB 2.1" not in verdicts
        assert verdicts["OIB 5"].verdict == "required"

    def test_a_use_without_verdict_token_leaves_the_main_use_unknown(self):
        # `produktion` (D0) is not `produzierend`: an unknown use may be the Betriebsbau,
        # so a mixed building keeps its OIB 2.1 "check".
        assert _by_code({"nutzungen@bw1": ["wohnen", "produktion"]})["OIB 2.1"].verdict == "check"

    def test_produktion_alone_names_no_verdict_use(self):
        assert _by_code({"nutzungen@bw1": ["produktion"]})["OIB 2.1"].verdict == "check"

    def test_two_verdict_uses_leave_hauptnutzung_unknown(self):
        verdicts = _by_code({"nutzungen@bw1": ["wohnen"], "nutzungen@bw2": ["buero"]})
        assert verdicts["OIB 2.1"].verdict == "check"
        assert verdicts["OIB 5"].verdict == "likely"

    def test_stated_hauptnutzung_beats_nutzungen(self):
        assert _by_code({"hauptnutzung": "lager", "nutzungen@bw1": ["wohnen"]})["OIB 2.1"].verdict == "required"


class TestWizardPromptText:
    def test_prompt_view_lines_read_as_the_wizard_writes_them(self):
        text = (
            "PROJECT_CONTEXT v1\n"
            "confirmed:\n"
            "- gebaeudeklasse@bw1=4\n"
            "- gebaeudeklasse@bw2=GK5\n"
            "- fluchtniveau_m@bw1=22.5\n"
            "- geschosse_unterirdisch@bw1=0\n"
            "- geschosse_unterirdisch@bw2=2\n"
            "- nutzungen@bw1=wohnen,garage\n"
        )
        verdicts = _by_code(facts_from_project_context(text))
        assert verdicts["OIB 2.3"].verdict == "required"
        assert verdicts["OIB 2.2"].verdict == "check"
        assert verdicts["OIB 2.1"].verdict == "check"  # garage names no verdict use

    def test_comma_joined_nutzungen_with_two_verdict_uses_is_ambiguous(self):
        text = "PROJECT_CONTEXT v1\nconfirmed:\n- nutzungen@bw1=wohnen,buero\n"
        verdicts = _by_code(facts_from_project_context(text))
        assert verdicts["OIB 2.1"].verdict == "check"


class TestTwinParityFixtures:
    """Mirrors the table in frontends/ui/src/lib/oib/applicable-standards.test.ts. Keep the two identical."""

    @pytest.mark.parametrize(
        ("facts", "expected"),
        [
            ({"gebaeudeklasse@bw1": "5"}, {"OIB 2.3": "check"}),
            ({"gebaeudeklasse@bw1": "4", "gebaeudeklasse@bw2": "GK5"}, {"OIB 2.3": "check"}),
            ({"gebaeudeklasse": "GK5", "fluchtniveau_m@bw1": 22.5}, {"OIB 2.3": "required"}),
            ({"gebaeudeklasse": "GK5", "fluchtniveau_m@bw1": 22}, {"OIB 2.3": None}),
            (
                {"nutzungen@bw1": ["wohnen"], "geschosse_unterirdisch@bw1": 2},
                {"OIB 2.1": None, "OIB 2.2": "check", "OIB 5": "required"},
            ),
            ({"nutzungen@bw1": ["wohnen"], "nutzungen@bw2": ["buero"]}, {"OIB 2.1": "check", "OIB 5": "likely"}),
        ],
    )
    def test_verdicts_match_the_ts_table(self, facts, expected):
        verdicts = _by_code(facts)
        actual = {code: verdicts[code].verdict if code in verdicts else None for code in expected}
        assert actual == expected
