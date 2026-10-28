"""Tests for the hand-written OIB applicability module."""

import pytest

from aiq_agent.common import applicability
from aiq_agent.common.applicability import OibVerdict
from aiq_agent.common.applicability import facts_from_project_context
from aiq_agent.common.applicability import render_project_block
from aiq_agent.common.applicability import resolve_oib_applicability
from aiq_agent.common.applicability import trigger_hints
from aiq_agent.project_context import compose_project_context


def _by_code(facts: dict) -> dict[str, OibVerdict]:
    return {verdict.code: verdict for verdict in resolve_oib_applicability(facts)}


class TestResolveOibApplicability:
    def test_empty_facts_return_generic_six_all_required(self):
        verdicts = resolve_oib_applicability({})
        assert [v.code for v in verdicts] == ["OIB 1", "OIB 2", "OIB 3", "OIB 4", "OIB 5", "OIB 6"]
        assert all(v.verdict == "required" for v in verdicts)

    def test_oib_1_2_3_always_required(self):
        for code in ("OIB 1", "OIB 2", "OIB 3"):
            assert _by_code({"main_use": "residential"})[code].verdict == "required"

    def test_gk5_undefined_escape_level_flags_2_3_check(self):
        verdicts = _by_code({"main_use": "residential", "building_class": "GK5"})
        assert verdicts["OIB 2.3"].verdict == "check"
        assert "22 m" in verdicts["OIB 2.3"].reason_de

    def test_escape_level_over_22m_makes_2_3_required_high_rise(self):
        verdicts = _by_code({"main_use": "residential", "building_class": "GK5", "escape_level": ">22m"})
        assert verdicts["OIB 2.3"].verdict == "required"
        assert "Hochhaus" in verdicts["OIB 2.3"].reason_de

    def test_low_rise_residential_omits_fire_substandards_and_oib5_required(self):
        verdicts = _by_code({"main_use": "residential", "building_class": "GK2", "escape_level": "<=7m"})
        assert "OIB 2.1" not in verdicts
        assert "OIB 2.2" not in verdicts
        assert "OIB 2.3" not in verdicts
        assert verdicts["OIB 5"].verdict == "required"

    def test_lager_makes_2_1_required_and_6_check(self):
        verdicts = _by_code({"main_use": "storage", "storeys_below_ground": 2})
        assert verdicts["OIB 2.1"].verdict == "required"
        assert verdicts["OIB 2.2"].verdict == "check"  # basement -> garage check
        assert verdicts["OIB 6"].verdict == "check"

    def test_undefined_use_makes_2_1_check(self):
        verdicts = _by_code({"building_class": "GK3"})
        assert verdicts["OIB 2.1"].verdict == "check"

    def test_non_betriebsbau_use_omits_2_1(self):
        verdicts = _by_code({"main_use": "residential"})
        assert "OIB 2.1" not in verdicts

    def test_public_use_gets_stronger_oib4_reason(self):
        verdicts = _by_code({"main_use": "assembly"})
        assert verdicts["OIB 4"].verdict == "required"
        assert "öffentlich" in verdicts["OIB 4"].reason_de

    def test_non_noise_sensitive_use_makes_oib5_likely(self):
        verdicts = _by_code({"main_use": "manufacturing"})
        assert verdicts["OIB 5"].verdict == "likely"

    def test_verdict_carries_both_languages(self):
        verdicts = _by_code({"main_use": "storage"})
        assert verdicts["OIB 2.1"].reason_en == "Manufacturing/storage use is a Betriebsbau."


class TestTriggerHints:
    def test_no_hints_when_no_triggers(self):
        assert trigger_hints({"main_use": "residential"}) == []

    def test_boolean_true_triggers_hint(self):
        hints = trigger_hints({"heritage_protection": True})
        assert len(hints) == 1
        assert "DMSG" in hints[0]

    def test_string_true_triggers_hint(self):
        assert trigger_hints({"parking_relevant": "true"}) == [
            "Stellplatzverpflichtung (parking obligation): check the Wiener Garagengesetz (or state law)."
        ]

    def test_false_does_not_trigger(self):
        assert trigger_hints({"allotment_garden_area": False, "commercial_facility": "false"}) == []

    def test_all_four_triggers_in_definition_order(self):
        facts = {
            "parking_relevant": True,
            "allotment_garden_area": True,
            "commercial_facility": True,
            "heritage_protection": True,
        }
        hints = trigger_hints(facts)
        assert len(hints) == 4
        assert hints[0].startswith("Kleingartengebiet")
        assert hints[1].startswith("Denkmalschutz")
        assert hints[2].startswith("Betriebsanlage")
        assert hints[3].startswith("Stellplatzverpflichtung")


#: A profile whose LAST section is ``confirmed:``, and the memory the turn context
#: composes after it (``compose_project_context``): lines holding ``=`` that are
#: no confirmed fact of the project.
PROFILE_ENDING_CONFIRMED = "PROJECT_CONTEXT v1\n\nconfirmed:\n- floors_above=5\n- use=residential"
MEMORY_WITH_EQUALS = (
    "PROJECT_MEMORY v1\n"
    "- [constraint, high, unverified] Brandabschnitt: Fläche=1200 m² laut Konzept\n\n"
    "PROPOSAL_DECISIONS v1\n"
    "- accepted: building_class=5\n"
    "- denkmalschutz=true"
)


class TestFactsFromProjectContext:
    def test_memory_after_a_profile_ending_in_confirmed_adds_no_facts(self):
        """The turn decision's ``project_facts`` and the prompt's project block both parse this composition.

        The section used to end only at a ``...:`` header, so every memory line
        holding ``=`` after a profile whose last section is ``confirmed:`` came
        out as a confirmed fact.
        """
        composed = compose_project_context(PROFILE_ENDING_CONFIRMED, MEMORY_WITH_EQUALS)
        assert facts_from_project_context(PROFILE_ENDING_CONFIRMED) == {"floors_above": 5, "use": "residential"}
        assert facts_from_project_context(composed) == {"floors_above": 5, "use": "residential"}

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
        assert facts == {"federal_state": "vienna", "main_use": "residential", "storeys_below_ground": 2}

    def test_coerces_booleans(self):
        text = "PROJECT_CONTEXT v1\nconfirmed:\n- stellplatz_relevant=true\n- denkmalschutz=false\n"
        facts = facts_from_project_context(text)
        assert facts == {"parking_relevant": True, "heritage_protection": False}
        assert facts["parking_relevant"] is True
        assert facts["heritage_protection"] is False

    def test_ignores_non_confirmed_sections(self):
        text = "PROJECT_CONTEXT v1\ngoals:\n- hauptnutzung=wohnen\n"
        assert facts_from_project_context(text) == {}

    def test_handles_quoted_values(self):
        text = 'PROJECT_CONTEXT v1\nconfirmed:\n- standort_details="Am Hang, 1230 Wien"\n'
        assert facts_from_project_context(text) == {"site_details": "Am Hang, 1230 Wien"}

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
            "- building_type@bldg1=gebaeude\n"
            "- bundesland=wien\n"
            "- storeys_above_ground@bldg1=3\n"
            "- uses@bldg1=wohnen\n"
        )
        text = (
            confirmed_only
            + "\n"
            + "goals:\n"
            + "- primary=check_oib_requirements\n\n"
            + "unknown:\n"
            + "- escape_level_m@bldg1\n\n"
            + "assumptions:\n"
            + "- gfa_above_ground@bldg1=412 [Vorschlag: Raumbuch=2026.xlsx]\n"
            + "- escape_level_m@bldg1=9.5 [Vorschlag: Einreichplan Schnitt.pdf, S. 2]\n"
            + "- building_class@bldg1=2 [abgeleitet]\n"
            + "- widmung=bauland\n\n"
            + "contested:\n"
            + "- escape_level_m@bldg1: 9.5 | alternativ: 11 (Brandschutzkonzept.pdf, S. 3)\n"
            + "- storeys_above_ground@bldg1: 3 | alternativ: 4 (Plan=final.pdf, S. 2) | alternativ: 5\n"
            + "- … und 3 weitere"
        )

        assert facts_from_project_context(text) == facts_from_project_context(confirmed_only)
        assert facts_from_project_context(text) == {
            "building_type@bldg1": "building",
            "federal_state": "vienna",
            "storeys_above_ground@bldg1": 3,
            "uses@bldg1": "residential",
        }


class TestRenderProjectBlock:
    def test_memory_after_a_profile_ending_in_confirmed_changes_nothing_in_the_block(self):
        composed = compose_project_context(PROFILE_ENDING_CONFIRMED, MEMORY_WITH_EQUALS)
        block = render_project_block(composed)
        assert block == render_project_block(PROFILE_ENDING_CONFIRMED)
        # The decisions block's bare `denkmalschutz=true` once raised the heritage hint.
        assert "Denkmalschutz" not in (block or "")

    def test_none_when_facts_empty(self):
        assert render_project_block("") is None
        assert render_project_block("PROJECT_CONTEXT v1\ngoals:\n- x\n") is None

    def test_renders_section_with_verdicts_and_reasons(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=lager\n"
        block = render_project_block(context)
        assert block is not None
        assert "### Likely relevant for this project" in block
        assert "OIB 1 — required —" in block
        assert "OIB 2.1 — required —" in block
        assert "OIB 6 — to be checked —" in block

    def test_appends_trigger_hints(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n- denkmalschutz=true\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz (heritage protection):" in block

    def test_no_trigger_lines_when_no_triggers(self):
        context = "PROJECT_CONTEXT v1\nconfirmed:\n- hauptnutzung=wohnen\n"
        block = render_project_block(context)
        assert block is not None
        assert "Denkmalschutz" not in block
        assert "Kleingartengebiet" not in block


class TestEscapeLevelBand:
    @pytest.mark.parametrize(
        ("metres", "band"),
        [(7, "<=7m"), (7.5, "7-11m"), (11, "7-11m"), (11.5, "11-22m"), (22, "11-22m"), (22.5, ">22m")],
    )
    def test_band_from_building_metres(self, metres, band):
        assert applicability.escape_level_band({"escape_level_m@bldg1": metres}) == band

    def test_highest_metres_across_buildings(self):
        assert applicability.escape_level_band({"escape_level_m@bldg1": 5, "escape_level_m@bldg2": 23}) == ">22m"
        assert applicability.escape_level_band({"escape_level_m": 9, "escape_level_m@bldg2": 4}) == "7-11m"

    def test_stated_flat_band_wins(self):
        assert applicability.escape_level_band({"escape_level": "<=7m", "escape_level_m@bldg1": 30}) == "<=7m"

    def test_empty_stated_band_is_no_answer(self):
        assert applicability.escape_level_band({"escape_level": "", "escape_level_m@bldg1": 30}) == ">22m"

    def test_zone_copy_and_missing_metres_are_not_read(self):
        assert applicability.escape_level_band({"escape_level_m@bldg1@residential": 30}) is None
        assert applicability.escape_level_band({"main_use": "residential"}) is None

    def test_non_finite_metres_are_not_read(self):
        assert applicability.escape_level_band({"escape_level_m@bldg1": "nan"}) is None


class TestWizardScopedFacts:
    def test_scoped_metres_above_22_flag_high_rise(self):
        assert _by_code({"building_class": "GK5", "escape_level_m@bldg1": 22.5})["OIB 2.3"].verdict == "required"

    def test_exactly_22_metres_does_not_flag_2_3(self):
        assert "OIB 2.3" not in _by_code({"building_class": "GK5", "escape_level_m@bldg1": 22})

    def test_scoped_building_class_accepts_bare_number_and_gk_prefix(self):
        assert _by_code({"building_class@bldg1": 5})["OIB 2.3"].verdict == "check"
        assert _by_code({"building_class@bldg1": "5"})["OIB 2.3"].verdict == "check"
        assert _by_code({"building_class@bldg1": "GK5"})["OIB 2.3"].verdict == "check"

    def test_bare_and_gk_prefixed_class_4_read_alike(self):
        bare = resolve_oib_applicability({"main_use": "residential", "building_class@bldg1": "4"})
        prefixed = resolve_oib_applicability({"main_use": "residential", "building_class": "GK4"})
        assert bare == prefixed
        assert "OIB 2.3" not in _by_code({"building_class@bldg1": "4"})

    def test_highest_building_class_across_buildings(self):
        verdicts = _by_code({"building_class@bldg1": "4", "building_class@bldg2": "GK5"})
        assert verdicts["OIB 2.3"].verdict == "check"

    def test_highest_basement_count_across_buildings(self):
        assert _by_code({"storeys_below_ground@bldg1": 0, "storeys_below_ground@bldg2": 2})["OIB 2.2"].verdict == (
            "check"
        )
        assert "OIB 2.2" not in _by_code({"storeys_below_ground@bldg1": 0, "storeys_below_ground@bldg2": 0})

    def test_one_verdict_use_shared_by_buildings_is_main_use(self):
        verdicts = _by_code({"uses@bldg1": ["residential"], "uses@bldg2": ["residential"]})
        assert "OIB 2.1" not in verdicts
        assert verdicts["OIB 5"].verdict == "required"

    def test_a_use_without_verdict_token_leaves_the_main_use_unknown(self):
        # `produktion` (D0) is not `produzierend`: an unknown use may be the Betriebsbau,
        # so a mixed building keeps its OIB 2.1 "check".
        assert _by_code({"uses@bldg1": ["residential", "production"]})["OIB 2.1"].verdict == "check"

    def test_produktion_alone_names_no_verdict_use(self):
        assert _by_code({"uses@bldg1": ["production"]})["OIB 2.1"].verdict == "check"

    def test_two_verdict_uses_leave_main_use_unknown(self):
        verdicts = _by_code({"uses@bldg1": ["residential"], "uses@bldg2": ["office"]})
        assert verdicts["OIB 2.1"].verdict == "check"
        assert verdicts["OIB 5"].verdict == "likely"

    def test_stated_main_use_beats_uses(self):
        assert _by_code({"main_use": "storage", "uses@bldg1": ["residential"]})["OIB 2.1"].verdict == "required"


class TestWizardPromptText:
    def test_prompt_view_lines_read_as_the_wizard_writes_them(self):
        text = (
            "PROJECT_CONTEXT v1\n"
            "confirmed:\n"
            "- building_class@bldg1=4\n"
            "- building_class@bldg2=GK5\n"
            "- escape_level_m@bldg1=22.5\n"
            "- storeys_below_ground@bldg1=0\n"
            "- storeys_below_ground@bldg2=2\n"
            "- uses@bldg1=wohnen,garage\n"
        )
        verdicts = _by_code(facts_from_project_context(text))
        assert verdicts["OIB 2.3"].verdict == "required"
        assert verdicts["OIB 2.2"].verdict == "check"
        assert verdicts["OIB 2.1"].verdict == "check"  # garage names no verdict use

    def test_comma_joined_uses_with_two_verdict_uses_is_ambiguous(self):
        text = "PROJECT_CONTEXT v1\nconfirmed:\n- uses@bldg1=wohnen,buero\n"
        verdicts = _by_code(facts_from_project_context(text))
        assert verdicts["OIB 2.1"].verdict == "check"


class TestTwinParityFixtures:
    """Mirrors the table in frontends/ui/src/lib/oib/applicable-standards.test.ts. Keep the two identical."""

    @pytest.mark.parametrize(
        ("facts", "expected"),
        [
            ({"building_class@bldg1": "5"}, {"OIB 2.3": "check"}),
            ({"building_class@bldg1": "4", "building_class@bldg2": "GK5"}, {"OIB 2.3": "check"}),
            ({"building_class": "GK5", "escape_level_m@bldg1": 22.5}, {"OIB 2.3": "required"}),
            ({"building_class": "GK5", "escape_level_m@bldg1": 22}, {"OIB 2.3": None}),
            (
                {"uses@bldg1": ["residential"], "storeys_below_ground@bldg1": 2},
                {"OIB 2.1": None, "OIB 2.2": "check", "OIB 5": "required"},
            ),
            ({"uses@bldg1": ["residential"], "uses@bldg2": ["office"]}, {"OIB 2.1": "check", "OIB 5": "likely"}),
        ],
    )
    def test_verdicts_match_the_ts_table(self, facts, expected):
        verdicts = _by_code(facts)
        actual = {code: verdicts[code].verdict if code in verdicts else None for code in expected}
        assert actual == expected
