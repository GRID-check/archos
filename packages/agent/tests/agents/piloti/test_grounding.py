"""Tests for the second kind of grounding: whether a tool result is a measurement.

:func:`tool_result_is_measurement` must not call a refusal, an outage, a
heuristic or an undecidable finding "evidence" — those are the ways a guess
gets stamped.

Nothing here writes a tool result by hand. Every fixture is either a real
:class:`ifc_spatial.envelope.Answer` put through ``measure_register._render``,
or — for the refusals that matter most — the engine's own output over the
repository's IFC fixtures. Hand-written prose is how the previous version of
this suite stayed green while every refusal in production granted grounding:
its undecidable fixture said „Räume exportieren", and the real remedies say
„…dessen Höhe gemessen werden könnte".
"""

import functools
from pathlib import Path
from unittest.mock import AsyncMock
from unittest.mock import MagicMock

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage
from langchain_core.tools import tool

from agent.agents.piloti.agent import ChatAgent
from agent.agents.piloti.answer_pipeline import prose_without_references
from agent.agents.piloti.grounding import MEASUREMENT_TOOL_NAMES
from agent.agents.piloti.grounding import tool_result_is_measurement
from agent.agents.piloti.models import ResearchAgentState
from agent.common import LLMProvider
from agent.common.data_source_registry import reset_registry
from agent.tools.bim.measure_register import _render

FIXTURES = Path(__file__).resolve().parents[5] / "packages" / "ifc-spatial" / "test" / "fixtures"
#: Geometry everywhere — the fixture that actually measures.
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
#: Two named rooms and four walls, and not one body the geometry kernel accepts.
#: Every measurement over it comes back ``decidable: false``.
NO_GEOMETRY = FIXTURES / "house-with-rooms.ifc"
#: No IfcBuildingStorey at all — the export `fire kind=escape_level` refuses on.
NO_STOREYS = FIXTURES / "road-ifc4x3.ifc"


@pytest.fixture(scope="module")
def run():
    """One ``ifc_measure`` result, straight out of the engine and the renderer.

    One parse per fixture file for the whole module, exactly as a conversation
    would do it.
    """
    engine = pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
    tools = engine.create_tools()
    handles: dict[Path, str] = {}

    def call(path: Path, operation: str, **args) -> str:
        if path not in handles:
            handles[path] = engine.call(tools, "open_model", {"path": str(path)})["model"]
        payload = engine.call(tools, operation, {"model": handles[path], **args})
        return _render(operation, payload, source={}, handle="")

    return call


def _answer(**kwargs) -> dict:
    """One real :class:`Answer` as the engine would hand it over.

    Guarded, because CI's backend job does not install ``ifc-spatial-py``: the
    engine lives in a separate package with its own heavy geometry stack. The
    ``run`` fixture guards the tests that drive the engine, but the fixtures
    built HERE are real ``Answer`` envelopes and import it too — so without this
    the module raised ImportError during collection and took twelve tests down
    with it, including ones that never touch geometry. Skipping is right rather
    than faking an ``Answer``: the whole point of this suite is that the
    detector reads what the renderer actually writes, and a hand-built
    stand-in is how the previous version stayed green over a live defect.
    """
    envelope = pytest.importorskip("ifc_spatial.envelope", reason="the spatial engine is not installed")

    kwargs.setdefault("from_", ["3cUkl32yn9qRSPvBJVyWcE"])
    kwargs.setdefault("method", "clearHeight(space)")
    return envelope.Answer(**kwargs).to_dict()


class TestMeasurementDetectionAgainstTheRealRenderer:
    """Drift guard: the detector reads what ``ifc_measure`` actually returns.

    The result states its own evidence count (``measurement_evidence``), and
    nothing but this test couples the renderer that writes that line to the gate
    that reads it. So the fixtures are built by ``_render`` from real
    ``Answer`` envelopes — a changed trailer turns this red instead of silently
    switching every measured answer back to "low".
    """

    def test_computed_answer_is_measurement_grounding(self):
        result = _render(
            "measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
        )
        assert "gemessen" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_declared_answer_is_measurement_grounding(self):
        result = _render(
            "measure", _answer(value=15.4, unit="m²", tolerance=None, provenance="declared", decidable=True)
        )
        assert "deklariert" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_inferred_answer_is_not_grounding(self):
        """„vermutlich" is a heuristic — the renderer itself calls it no Feststellung."""
        result = _render(
            "measure",
            _answer(value=0.9, unit="m", tolerance=None, provenance="inferred", confidence=0.6, decidable=True),
        )
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_undecidable_finding_is_not_grounding(self):
        """A ``decidable: false`` result is a fact about the EXPORT, carrying no number."""
        envelope = pytest.importorskip("ifc_spatial.envelope", reason="the spatial engine is not installed")
        MissingFact = envelope.MissingFact

        result = _render(
            "measure",
            _answer(
                value=None,
                unit=None,
                tolerance=None,
                provenance="computed",
                decidable=False,
                missing=MissingFact(
                    what="keine IfcSpace-Elemente",
                    remedy="Räume im CAD anlegen — ohne sie gibt es keine Raumhöhe, die gemessen werden könnte.",
                ),
            ),
        )
        # The remedy uses the very verb the old detector searched for.
        assert "gemessen" in result
        assert tool_result_is_measurement("ifc_measure", result) is False


class TestMeasurementDetectionAgainstTheRealEngine:
    """The refusals that shipped as evidence, reproduced from the real engine.

    Three of ``ifc_measure``'s renderers write „gemessen"/„deklariert" into
    prose that explains why NOTHING could be measured: a survey's head renders
    „gemessen: clearHeight an 0 von 4 Bauteilen", an element profile's head
    renders „gemessen an Wand X" whatever its aspects say, and `fire`'s
    Fluchtniveau remedy ends „…dessen Höhe gemessen werden könnte". Under the
    old vocabulary match all three granted measurement grounding, so a model
    that invented a number on top of a refusal surfaced at "medium".

    No payload here is written by hand — the engine runs over the repository's
    own fixtures, so the German is whatever the product actually emits.
    """

    def test_a_survey_that_measured_something_is_grounding(self, run):
        result = run(HOUSE, "survey", measure="clearHeight", roomKind="alle")
        assert "an 4 von 4 Bauteilen" in result
        assert tool_result_is_measurement("ifc_measure", result) is True

    def test_a_survey_that_measured_nothing_is_not_grounding(self, run):
        """0 of 2 — and the head still opens with „gemessen:"."""
        result = run(NO_GEOMETRY, "survey", measure="clearHeight", roomKind="alle")
        assert result.startswith("gemessen: clearHeight an 0 von 2 Bauteilen")
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_an_all_undecidable_element_profile_is_not_grounding(self, run):
        result = run(NO_GEOMETRY, "element_profile", globalId="2Haus0Raeume00Wall0001")
        assert result.startswith("gemessen an Aussenwand Sued")
        assert "NICHT ENTSCHEIDBAR" in result
        assert tool_result_is_measurement("ifc_measure", result) is False

    def test_an_undecidable_escape_level_is_not_grounding(self, run):
        """The report that started this: a refusal whose REMEDY says „gemessen"."""
        result = run(NO_STOREYS, "fire", kind="escape_level")
        assert result.startswith("NICHT ENTSCHEIDBAR")
        assert "gemessen werden könnte" in result
        assert tool_result_is_measurement("ifc_measure", result) is False


class TestMeasurementDetectionRejectsFailures:
    """Every ``ifc_measure`` failure path stays un-grounded."""

    @staticmethod
    def _error_texts():
        from agent.tools.bim.measure_register import ENGINE_UNAVAILABLE_TEXT
        from agent.tools.bim.measure_register import UNAVAILABLE_TEXT
        from agent.tools.bim.measure_register import _rejected_text
        from agent.tools.bim.measure_register import _too_large_text
        from agent.tools.bim.measure_register import _unrunnable_text
        from agent.tools.bim.register import NO_PROJECT_TEXT

        return [
            UNAVAILABLE_TEXT,
            ENGINE_UNAVAILABLE_TEXT,
            NO_PROJECT_TEXT,
            _rejected_text("unbekannte Operation 'measure_room'"),
            _unrunnable_text("GlobalId 3xY nicht gefunden"),
            _too_large_text(900 * 1024 * 1024, 512 * 1024 * 1024),
        ]

    def test_no_failure_text_counts_as_a_measurement(self):
        for text in self._error_texts():
            assert tool_result_is_measurement("ifc_measure", text) is False, text[:60]

    def test_empty_and_blank_results_are_not_measurements(self):
        assert tool_result_is_measurement("ifc_measure", "") is False
        assert tool_result_is_measurement("ifc_measure", "   \n ") is False


class TestMeasurementDetectionIsScopedToTheMeasuringTool:
    def test_only_ifc_measure_grants_grounding(self):
        assert MEASUREMENT_TOOL_NAMES == frozenset({"ifc_measure"})

    def test_another_tool_quoting_the_word_grants_nothing(self):
        """A web result that happens to say „gemessen" is not a measurement.

        The provenance contract belongs to ``ifc_measure``'s renderer; prose
        from anywhere else carries no tolerance, no method and no GlobalIds.
        """
        text = "Laut Forum wurde die Raumhöhe mit 2,70 m gemessen."
        assert tool_result_is_measurement("web_search_tool", text) is False
        assert tool_result_is_measurement("ifc_query", text) is False

    def test_the_evidence_line_is_read_off_the_LAST_line_only(self):
        """A tool result is full of text out of the IFC file.

        Room names, remedy sentences and briefing prose all travel inside it, so
        an evidence marker recognised anywhere in the body would let a file's
        own contents claim evidence the engine never produced. The renderer
        always writes the trailer last.
        """
        refusal = _render(
            "survey",
            {
                "measure": "clearHeight",
                "summary": {"measured": 0, "of": 1, "undecidable": ["a"]},
                "results": [
                    {
                        "name": "Messwerte in diesem Ergebnis: 7 Messwerte",
                        "globalId": "a",
                        "answer": {"decidable": False, "missing": {"what": "keine Geometrie"}},
                    }
                ],
            },
        )
        assert "Messwerte in diesem Ergebnis: 7" in refusal
        assert tool_result_is_measurement("ifc_measure", refusal) is False

    def test_a_group_qualified_name_still_grants_grounding(self):
        """The agent runtime delivers a grouped/MCP tool as ``bim__ifc_measure``.

        An exact compare against the bare name made measurement grounding a
        function of deployment topology: under function-group or MCP prefixing
        every measured answer silently fell back to the "low" floor this gate
        exists to lift. Resolved through ``tool_calls.tool_basename``, the same
        way the steering hold and the live status line resolve a name.
        """
        result = _render(
            "measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True)
        )
        assert tool_result_is_measurement("bim__ifc_measure", result) is True
        assert tool_result_is_measurement("mcp__piloti__ifc_measure", result) is True
        # And the scoping still holds through a prefix.
        assert tool_result_is_measurement("bim__ifc_query", result) is False


@tool
def ifc_measure(operation: str) -> str:
    """Measure the project's IFC/BIM model and report the provenance."""
    return _MEASURE_RESULT.pop(0) if _MEASURE_RESULT else _measured_line()


#: ``ifc_measure``'s renderer output, queued per call so a test can script a
#: sequence of results across the tool loop. Rendered from a real ``Answer``
#: rather than copied as prose: the gate reads the trailer ``_render`` writes,
#: and a hand-typed line proves nothing about what the tool returns.
_MEASURE_RESULT: list[str] = []


@functools.lru_cache(maxsize=1)
def _measured_line() -> str:
    """Built on FIRST USE, not at import.

    `_answer` imports `ifc_spatial.envelope`. Computed at module scope, a
    missing spatial engine turns collection of this file into an ImportError,
    so the `pytest.importorskip` guards inside the tests never get to run and
    the whole module errors instead of skipping — which is the opposite of what
    those guards are for.
    """
    return _render("measure", _answer(value=2.7, unit="m", tolerance=0.005, provenance="computed", decidable=True))


_REFUSED_LINE = (
    "Error: the request was rejected — unbekannte Operation 'measure_room'. This is a problem with "
    "the arguments, not with the model."
)


class TestMeasurementSignalReachesTheState:
    """``answer_measurement_grounded``.

    The signal is written by the tools node (the only place that sees raw tool
    results) and echoed by ``run()`` alongside ``answer_citation_grounded``, so
    both kinds of grounding reach the chat node by one path. ``ifc_measure`` is
    deliberately not a data source — it produces no citable passage — which is
    exactly why the citation gate could never see it.
    """

    @pytest.fixture(autouse=True)
    def _reset_data_source_registry(self):
        reset_registry()
        _MEASURE_RESULT.clear()
        yield
        reset_registry()
        _MEASURE_RESULT.clear()

    @pytest.fixture
    def mock_llm(self):
        llm = MagicMock()
        llm.ainvoke = AsyncMock()
        llm.bind_tools = MagicMock(return_value=llm)
        llm.bind = MagicMock(return_value=llm)
        return llm

    @pytest.fixture
    def mock_llm_provider(self, mock_llm):
        provider = MagicMock(spec=LLMProvider)
        provider.get = MagicMock(return_value=mock_llm)
        return provider

    @staticmethod
    def _call(*ids: str):
        """One assistant turn asking for ``len(ids)`` measurements (default one)."""
        return AIMessage(
            content="",
            tool_calls=[
                {"name": "ifc_measure", "args": {"operation": "measure"}, "id": idx} for idx in (ids or ("1",))
            ],
        )

    async def _run(self, mock_llm_provider, mock_llm, responses, question="Wie hoch ist der Keller?"):
        mock_llm.ainvoke = AsyncMock(side_effect=responses)
        agent = ChatAgent(llm_provider=mock_llm_provider, tools=[ifc_measure])
        return await agent.run(ResearchAgentState(messages=[HumanMessage(content=question)]))

    @pytest.mark.asyncio
    async def test_a_successful_measurement_grounds_the_turn(self, mock_llm_provider, mock_llm):
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call(), AIMessage(content="Der Keller ist 2,70 m hoch (gemessen ±5 mm).")],
        )
        assert result.answer_measurement_grounded is True
        # And the citation gate still says what it always said: nothing to cite.
        assert result.answer_citation_grounded is False

    @pytest.mark.asyncio
    async def test_a_refused_measurement_grounds_nothing(self, mock_llm_provider, mock_llm):
        _MEASURE_RESULT.append(_REFUSED_LINE)
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call(), AIMessage(content="Das Modell konnte nicht gemessen werden.")],
        )
        assert result.answer_measurement_grounded is False

    @pytest.mark.asyncio
    async def test_a_refusal_beside_a_measurement_does_not_un_measure_it(self, mock_llm_provider, mock_llm):
        """Both results land in ONE tools-node call, the refusal LAST.

        The agent batches calls, so a single node invocation routinely carries a
        good measurement and a rejected one together. Reading the signal off the
        last result — rather than OR-ing across the batch — silently drops the
        measurement the answer is actually built on, and the turn falls back to
        "low" for evidence it does hold.
        """
        _MEASURE_RESULT.extend([_measured_line(), _REFUSED_LINE])
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call("1", "2"), AIMessage(content="Der Keller ist 2,70 m hoch.")],
        )
        assert result.answer_measurement_grounded is True

    @pytest.mark.asyncio
    async def test_grounding_survives_a_later_barren_iteration(self, mock_llm_provider, mock_llm):
        """And across iterations: a second, fruitless call does not erase the first."""
        _MEASURE_RESULT.extend([_measured_line(), _REFUSED_LINE])
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [self._call("1"), self._call("2"), AIMessage(content="Der Keller ist 2,70 m hoch.")],
        )
        assert result.answer_measurement_grounded is True

    @pytest.mark.asyncio
    async def test_a_turn_that_measured_nothing_carries_no_grounding(self, mock_llm_provider, mock_llm):
        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [AIMessage(content="Die Antwort steht in OIB 4.")],
        )
        assert result.answer_measurement_grounded is False

    @pytest.mark.asyncio
    async def test_a_refused_measurement_plus_an_invented_number_grounds_nothing(self, mock_llm_provider, mock_llm):
        """The report this fix came from, through the whole agent.

        `fire kind=escape_level` on an export without storeys refuses, and the
        remedy sentence ends „…dessen Höhe gemessen werden könnte". The model
        then writes a number that is in no file anywhere. Nothing was measured,
        so nothing may be measurement-grounded — otherwise the invention rides
        out at "medium".
        """
        engine = pytest.importorskip("ifc_spatial.tools", reason="the spatial engine is not installed")
        tools = engine.create_tools()
        handle = engine.call(tools, "open_model", {"path": str(NO_STOREYS)})["model"]
        refusal = _render("fire", engine.call(tools, "fire", {"model": handle, "kind": "escape_level"}))
        _MEASURE_RESULT.append(refusal)

        result = await self._run(
            mock_llm_provider,
            mock_llm,
            [
                self._call(),
                AIMessage(content="Das Fußbodenniveau des obersten Geschoßes liegt bei rund 9,5 m.\n[CONFIDENCE:high]"),
            ],
        )
        assert result.answer_measurement_grounded is False


class TestTheBibliographyStripIsNotAnEscapeHatch:
    """S2. What `prose_without_references` is allowed to throw away.

    The brake reads the answer's PROSE, so a reference list is removed first —
    „- [1] Wiener Bauordnung — https://ris…" is a pointer, not a claim, and the
    single-source fallback appends one to every answer it grounds.

    Cutting at the LAST heading match assumed the heading was the last thing in
    the answer. It is a rule about position, and the model controls position:
    write „**Quellen:**", then keep writing, and every sentence after it left
    the text before the brake saw it.
    """

    def test_prose_after_a_reference_heading_is_not_a_reference(self):
        content = (
            "Die Höhe beträgt 2,20 m.\n\n"
            "**Quellen:**\n"
            "- [1] OIB-Richtlinie 4 - https://example.invalid/oib4\n\n"
            "Die Ausführung erfüllt die Anforderung nicht und ist unzulässig."
        )
        kept = prose_without_references(content)
        assert "unzulässig" in kept

    def test_a_heading_inside_a_fenced_block_is_not_a_reference_list(self):
        content = "Beispiel:\n\n```md\n## Sources\n- [1] foo\n```\n\nDer Raum ist damit unzulässig."
        kept = prose_without_references(content)
        assert "unzulässig" in kept
        assert "Raum" in kept

    @pytest.mark.parametrize(
        "content",
        [
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n- [1] Wiener Bauordnung - https://example.invalid/bo",
            "Die Höhe beträgt 2,20 m.\n\n### Sources\n- [1] OIB 4 - https://example.invalid/oib4\n",
            "Die Höhe beträgt 2,20 m.\n\n**References:**\n1. https://example.invalid/x\n",
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n[1] Wiener Bauordnung\n",
        ],
    )
    def test_a_genuinely_trailing_list_is_still_removed(self, content):
        """The regression this strip exists to prevent, still prevented.

        Leaving the bibliography in made every fallback-grounded answer read as
        normative and floored purely descriptive measured answers to "low".
        """
        kept = prose_without_references(content)
        assert kept.strip() == "Die Höhe beträgt 2,20 m."

    @pytest.mark.parametrize(
        "content",
        [
            # A bullet under „**Quellen:**" that points at nothing.
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n"
            "- [1] Wiener Bauordnung — https://example.invalid/bo\n"
            "- Damit ist der Raum unzulässig und darf nicht als Aufenthaltsraum genutzt werden.",
            # A numbered entry that is a sentence, not a source.
            "Die Höhe beträgt 2,20 m.\n\n## Quellen\n"
            "1. OIB-Richtlinie 3, https://example.invalid/oib3\n"
            "2. Der Raum erfüllt die Anforderung nicht.",
            # A nested item under a real entry.
            "Die Höhe beträgt 2,20 m.\n\n**Quellen:**\n"
            "- [1] Wiener Bauordnung — https://example.invalid/bo\n"
            "  - Der Raum ist unzulässig.",
        ],
    )
    def test_list_punctuation_alone_does_not_make_a_line_a_reference(self, content):
        """S1. „- " is available to any sentence the model writes.

        Accepting any bullet, any numbered entry and any indented line as a
        bibliography entry reopened the door this class exists to close: the
        model writes „**Quellen:**", then writes its verdict as a list item, and
        the verdict left the text before the brake ever read it. A reference has
        to point at something — a URL or a „[n]" marker.
        """
        kept = prose_without_references(content)
        assert "Raum" in kept

    def test_an_answer_without_a_reference_list_is_untouched(self):
        content = "Die lichte Raumhöhe beträgt 2,70 m (gemessen ±5 mm)."
        assert prose_without_references(content) == content

    def test_non_string_input_is_empty(self):
        assert prose_without_references(None) == ""  # type: ignore[arg-type]
