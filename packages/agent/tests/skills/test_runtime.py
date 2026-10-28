"""Per-run SkillRuntime (ADR-0135): the catalog SkillsMiddleware renders, the
read that activates, the pinned shortcut, and the events activation emits.

A skill is activated when its body reached the model: a ``read_file`` of its
``SKILL.md`` through the run's backend, or a pinned body the answer envelope
names in ``skills_applied``. Listing it in the catalog activates nothing.
"""

from __future__ import annotations

import pytest

from agent.common.wire_v2 import SkillStep
from agent.skills.events import emit_skills_offered
from agent.skills.models import Skill
from agent.skills.runtime import SKILLS_PROMPT
from agent.skills.runtime import SkillRuntime

S1 = Skill(name="alpha", description="Erster Skill.", body="alpha body", origin="platform")
S2 = Skill(name="beta", description="Zweiter Skill.", body="beta body", origin="platform")
CARDS = Skill(
    name="gamma",
    description="Dritter Skill.",
    body="gamma body",
    metadata={"grid-cards": "stair_diagram,calculation"},
    origin="platform",
)
TITLED = Skill(
    name="titel",
    description="Skill mit Anzeigenamen.",
    body="titel body",
    metadata={"grid-title": "Brandschutznachweis"},
    origin="org",
)
TITLED_TWO = Skill(
    name="titel-zwei",
    description="Zweiter Skill mit Anzeigenamen.",
    body="titel-zwei body",
    metadata={"grid-title": "Fluchtwegprüfung"},
    origin="org",
)
# A hidden skill WITH a title: hidden demotes the live line even when a
# perfectly good title exists — the voice-skill case.
HIDDEN = Skill(
    name="piloti-voice",
    description="Hausstimme, auf jeder Antwort.",
    body="voice body",
    metadata={"grid-title": "Piloti-Stimme", "grid-hidden": "true"},
    origin="platform",
)


def _read(runtime: SkillRuntime, name: str, source: str = "office") -> str:
    """What ``read_file`` hands the model for ``name``: the backend's read, as the tool calls it."""
    result = runtime.mounted().read(f"/skills/{source}/{name}/SKILL.md", 0, 1000)
    assert result.error is None, result.error
    return result.file_data["content"]


def _runtime(*skills: Skill) -> SkillRuntime:
    return SkillRuntime.office(skills or (S1, S2))


class TestTheCatalog:
    def test_no_skills_yields_no_prompt(self) -> None:
        runtime = SkillRuntime.office(())
        assert runtime.prompt_block() is None
        assert runtime.catalog_block() is None
        assert runtime.sources == ()
        assert runtime.activated == ()

    def test_the_catalog_is_skillsmiddlewares_own_rendering(self) -> None:
        """Name, description and path per skill, under our heading, rendered by the middleware."""
        block = _runtime().catalog_block() or ""
        assert block.startswith(SKILLS_PROMPT.split("\n", 1)[0])
        assert "- **alpha**: Erster Skill." in block
        assert "Read `/skills/office/alpha/SKILL.md` for full instructions" in block
        assert "read_file" in block
        # Progressive disclosure: bodies NEVER leak into the catalog.
        assert "alpha body" not in block
        assert "beta body" not in block

    def test_a_stored_auto_invoke_off_no_longer_hides_a_skill(self) -> None:
        """The catalog is the model's inventory, not a list a person edits (ADR-0060)."""
        silent = Skill(
            name="submission-check",
            description="Was diesem Bauansuchen noch fehlt.",
            body="body",
            metadata={"grid-auto-invoke": "false"},
            origin="platform",
        )
        block = _runtime(S1, silent).catalog_block() or ""
        assert "- **submission-check**: Was diesem Bauansuchen noch fehlt." in block

    def test_preferred_cards_cost_nothing_in_the_catalog(self) -> None:
        assert "Preferred cards" not in (_runtime(S1, CARDS).prompt_block() or "")

    def test_a_later_source_wins_a_name_clash(self) -> None:
        """The middleware's own layering: the office's copy of a name shadows a collection's."""
        office_copy = Skill(name="alpha", description="Die Fassung des Büros.", body="office alpha")
        runtime = SkillRuntime({"synthesis": (S1,), "office": (office_copy,)})
        block = runtime.catalog_block() or ""
        assert "Die Fassung des Büros." in block
        assert "Erster Skill." not in block
        assert [s.description for s in runtime.skills] == ["Die Fassung des Büros."]


class TestActivation:
    def test_only_a_read_body_counts_as_activated(self) -> None:
        runtime = _runtime()
        runtime.prompt_block()
        assert runtime.activated == ()
        assert "beta body" in _read(runtime, "beta")
        assert runtime.activated == ("beta",)

    def test_loading_the_catalog_activates_nothing(self) -> None:
        """The middleware downloads every SKILL.md to list it; that is not a delivery."""
        runtime = _runtime()
        runtime.mounted().download_files(["/skills/office/alpha/SKILL.md", "/skills/office/beta/SKILL.md"])
        runtime.catalog_block()
        assert runtime.activated == ()

    def test_what_was_read_is_reported_in_read_order_once(self) -> None:
        runtime = _runtime()
        _read(runtime, "alpha")
        _read(runtime, "beta")
        _read(runtime, "alpha")
        assert runtime.activated == ("alpha", "beta")

    def test_a_failed_read_activates_nothing(self) -> None:
        runtime = _runtime()
        assert runtime.mounted().read("/skills/office/nope/SKILL.md").error
        assert runtime.mounted().read("/skills/office/alpha/SKILL.md", offset=5000).error
        assert runtime.activated == ()

    def test_two_runtimes_share_no_activation_state(self) -> None:
        first, second = _runtime(), _runtime()
        _read(first, "alpha")
        assert first.activated == ("alpha",)
        assert second.activated == ()

    def test_the_runtime_offers_and_cannot_require(self) -> None:
        """No constructor argument or property can put a skill in front of the model as an order."""
        runtime = _runtime()
        for gone in ("forced", "forced_block", "force_names", "inline_also", "build_tools"):
            assert not hasattr(runtime, gone), gone
        with pytest.raises(TypeError):
            SkillRuntime({"office": (S1,)}, force_names=["alpha"])  # type: ignore[call-arg]


class TestPreferredCards:
    def test_they_are_appended_when_the_body_is_read(self) -> None:
        body = _read(_runtime(S1, CARDS), "gamma")
        assert "gamma body" in body
        assert "## Preferred cards" in body
        assert "`stair_diagram`, `calculation`" in body
        assert "not a requirement" in body

    def test_a_skill_without_them_reads_as_its_document(self) -> None:
        body = _read(_runtime(S1, CARDS), "alpha")
        assert body.startswith("---\nname: alpha\n")
        assert "Preferred cards" not in body

    def test_unknown_and_system_card_types_never_reach_the_model(self) -> None:
        skill = Skill(
            name="delta",
            description="Vierter Skill.",
            body="delta body",
            metadata={"grid-cards": "calculation,memory_proposal,ganz_erfunden,legal_basis"},
        )
        body = _read(_runtime(skill), "delta").split("## Preferred cards", 1)[1]
        assert "`calculation`" in body
        assert "`legal_basis`" not in body
        assert "`memory_proposal`" not in body
        assert "ganz_erfunden" not in body


class TestPinned:
    """The turn-start decision's pick rides the prompt (ADR-0063, ADR-0064), still an offer."""

    def test_a_pinned_body_rides_in_the_middlewares_skill_shape(self) -> None:
        runtime = _runtime(S1, CARDS)
        assert runtime.pin("gamma")
        block = runtime.prompt_block() or ""
        assert '<skill name="gamma" path="/skills/office/gamma/SKILL.md">\ngamma body' in block
        assert "skills_applied" in block
        # Names only in the prompt; the full shapes travel with a read.
        assert "Preferred cards: `stair_diagram`, `calculation`" in block
        assert "## Preferred cards" not in block
        # The catalog still lists it, so a read is never refused.
        assert "- **gamma**" in block

    def test_an_unknown_name_pins_nothing(self) -> None:
        runtime = _runtime()
        assert not runtime.pin("nope")
        assert runtime.pinned_block() is None

    def test_a_pinned_body_is_not_activated_by_being_there(self) -> None:
        runtime = _runtime()
        runtime.pin("alpha")
        runtime.prompt_block()
        assert runtime.activated == ()

    def test_the_envelope_naming_it_activates_it_once(self) -> None:
        runtime = _runtime()
        runtime.pin("alpha")
        assert runtime.record_applied(["`alpha`", "alpha"]) == ("alpha",)
        assert runtime.activated == ("alpha",)

    def test_a_name_whose_body_was_not_pinned_activates_nothing(self) -> None:
        runtime = _runtime()
        runtime.pin("alpha")
        assert runtime.record_applied(["beta", "erfunden"]) == ()
        assert runtime.activated == ()

    def test_a_pinned_skill_that_was_also_read_counts_once(self) -> None:
        runtime = _runtime()
        runtime.pin("alpha")
        _read(runtime, "alpha")
        assert runtime.record_applied(["alpha"]) == ()
        assert runtime.activated == ("alpha",)

    def test_the_old_name_of_a_renamed_builtin_pins_the_new_one(self) -> None:
        """A schedule's stored prompt says `/einreichcheck` (migration 0169)."""
        renamed = Skill(name="submission-check", description="Was noch fehlt.", body="renamed body")
        runtime = _runtime(renamed)
        assert runtime.pin("einreichcheck")
        assert runtime.record_applied(["einreichcheck"]) == ("submission-check",)


class TestActivationEvents:
    """What leaves the process while the skills are in play: typed ``skill`` steps."""

    def test_each_activation_emits_exactly_one_step_for_its_skill(self, emitted) -> None:
        runtime = _runtime(S1, S2, TITLED)
        _read(runtime, "titel")
        _read(runtime, "titel")
        _read(runtime, "beta")
        assert emitted.steps == [
            SkillStep(id="skill:titel", phase="activated", skill="titel", title="Brandschutznachweis"),
            SkillStep(id="skill:beta", phase="activated", skill="beta", channel="technical"),
        ]
        assert runtime.activated == ("titel", "beta")

    def test_a_titled_skill_is_live_and_carries_only_its_title(self, emitted) -> None:
        runtime = _runtime(TITLED, TITLED_TWO)
        _read(runtime, "titel")
        _read(runtime, "titel-zwei")
        assert [(step.channel, step.title) for step in emitted.steps] == [
            ("live", "Brandschutznachweis"),
            ("live", "Fluchtwegprüfung"),
        ]

    def test_a_skill_without_a_title_gets_no_live_line(self, emitted) -> None:
        _read(_runtime(S1), "alpha")
        assert emitted.steps == [SkillStep(id="skill:alpha", phase="activated", skill="alpha", channel="technical")]

    def test_a_hidden_skill_is_recorded_but_kept_off_the_live_line(self, emitted) -> None:
        runtime = _runtime(HIDDEN)
        _read(runtime, "piloti-voice")
        assert emitted.steps == [
            SkillStep(
                id="skill:piloti-voice",
                phase="activated",
                skill="piloti-voice",
                title="Piloti-Stimme",
                hidden=True,
                channel="technical",
            )
        ]
        assert runtime.hidden_activated == ("piloti-voice",)

    def test_an_applied_pinned_skill_announces_when_the_envelope_names_it(self, emitted) -> None:
        runtime = _runtime(TITLED)
        runtime.pin("titel")
        assert emitted.steps == []
        runtime.record_applied(["titel"])
        assert [step.id for step in emitted.steps] == ["skill:titel"]

    def test_offered_reports_the_catalog_but_never_as_activity(self, emitted) -> None:
        emit_skills_offered(_runtime(S1, S2))
        assert emitted.steps == [SkillStep(id="skill_selection", phase="offered", count=2, channel="technical")]

    def test_a_turn_with_no_skills_says_nothing(self, emitted) -> None:
        emit_skills_offered(SkillRuntime.office(()))
        assert emitted == []


def test_a_standard_marker_on_the_payload_is_ignored() -> None:
    """The wire may still carry it; nothing in the backend may act on it."""
    from agent.skills.resolver import _build_org_skills

    (skill,) = _build_org_skills(
        [{"name": "haus-stil", "description": "Fleet standard equipment.", "body": "b", "standard": True}]
    )
    assert not hasattr(skill, "standard")


def test_an_ordinary_activated_skill_is_not_hidden() -> None:
    runtime = _runtime(S1)
    _read(runtime, "alpha")
    assert runtime.hidden_activated == ()
