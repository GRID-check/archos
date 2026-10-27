"""The confidence chip measures what the answer rests on (ADR-0139).

A grounded answer never reads low, an ungrounded one never high.

Rule 2 (ADR-0125) held the answer to its weakest load-bearing sentence, and the
normative detector that decides which sentences bear load is a wide net. The
nine answers stored in the dev workspace between 2026-10-22 and 2026-10-27
(``stored_answers_2026-10.json``) all read „low": the listings were floored by
one sentence the net caught (a next step, a fact about the corpus), and three
carried citations bound to the wrong document, because the answer wrote ``[N]``
with no Quellen list and the numbers were read as positions in the
conversation's cumulative registry.

Rule 3: ``high`` only when every load-bearing sentence is backed, ``low`` when
most are not or the legal conclusion has no passage, ``medium`` otherwise. The
review of #1231 probed it; each probe is a test here.

These go through the real filesystem tool, the real source capture and
``finalize_answer``, so a part nobody calls would show.
"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.agent import _capture_sources
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.common import data_source_registry
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import mark_load_bearing
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import unsupported_claims
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.tools.documents.tools import filesystem_tools
from sources.knowledge_layer.src import stored_pages
from sources.knowledge_layer.src.browse import FileRow
from sources.knowledge_layer.src.estate import EstateBackend

PATH = "/project/Gutachten/Brandschutzkonzept.pdf.md"
ROW = FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_a", folder="Gutachten")
PAGES = {
    1: "Der Fluchtweg führt über das Treppenhaus T1 ins Freie.",
    2: "Eine Sprinkleranlage ist nicht vorgesehen. Die Brandmeldeanlage deckt alle Geschoße ab.",
}
ENVELOPE = '```answer_json\n{{"kind": "direct", "confidence": {{"level": "high"}}, "answer": "{prose}"}}\n```'
STORED = Path(__file__).parents[3] / "fixtures" / "claim_provenance" / "stored_answers_2026-10.json"
STORED_ANSWERS = json.loads(STORED.read_text())["answers"]


def _classes(prose: str, evidence: ClaimEvidence) -> list[ClaimStamp]:
    return classify_claims(prose, evidence, normative=answer_mentions_normative_claim)


def _estate() -> EstateBackend:
    async def rows():
        return [ROW]

    async def none():
        return []

    async def pages(collection, file_name, *, wanted=None):
        items = [stored_pages.Page(number=n, text=t) for n, t in PAGES.items() if wanted is None or n in wanted]
        return stored_pages.PageText(pages=items, origin="stored", page_count=len(PAGES))

    return EstateBackend(SimpleNamespace(), rows_loader=rows, restricted_loader=none, page_reader=pages)


@pytest.fixture(autouse=True)
def _knowledge_source():
    """The data source the filesystem tools read through, as the boot config declares it."""
    data_source_registry.populate_from_config(
        [{"id": "knowledge_layer", "name": "Knowledge Base", "tools": ["knowledge_search", "read_passage"]}]
    )
    token = begin_grounding_capture()
    try:
        yield
    finally:
        end_grounding_capture(token)
        data_source_registry.reset_registry()


async def _read_turn(prose: str, registry: SourceRegistry, *, calls: tuple[str, ...] = ("1", "2")) -> list:
    """A turn that read the pages with ``read_file`` (one call per entry of ``calls``) and answered ``prose``."""
    tools = {tool.name: tool for tool in filesystem_tools(None, _estate())}
    requests, results = [], []
    for page in calls:
        call_id = f"c{page}-{uuid4().hex[:4]}"
        runtime = SimpleNamespace(tool_call_id=call_id, state={}, context=None, store=None, config={})
        message = await tools["read_file"].coroutine(runtime=runtime, file_path=PATH, pages=str(page))
        _capture_sources("read_file", message.content, frozenset(tools), registry, message.artifact)
        requests.append({"id": call_id, "name": "read_file", "args": {"file_path": PATH, "pages": str(page)}})
        results.append(message)
    return [
        HumanMessage("Was steht im Brandschutzkonzept?"),
        AIMessage(content="", tool_calls=requests),
        *results,
        AIMessage(ENVELOPE.format(prose=prose)),
    ]


async def _finalize(messages: list, registry: SourceRegistry):
    final = await finalize_answer(messages, registry=registry, tools=[], repair=None, turn_sources=[])
    return final, assemble_result({"messages": messages}, final, turn_sources=[], turn_measurements=[])


QUELLEN = "\\n\\n**Quellen:**\\n- [1] Brandschutzkonzept.pdf, p.1\\n- [2] Brandschutzkonzept.pdf, p.2"


class TestAGroundedAnswerNeverReadsLow:
    async def test_every_claim_cited_from_files_it_read_reaches_the_models_level(self):
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht "
            "vorgesehen [2]. Die Brandmeldeanlage deckt alle Geschoße ab [2]." + QUELLEN
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited", "cited", "cited"]
        assert state.answer_confidence == "high"

    async def test_one_next_step_the_normative_net_catches_does_not_floor_it(self):
        """Rule 2 surfaced exactly this as „low", ``normative_claim_uncited``."""
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht "
            "vorgesehen [2]. Die Brandmeldeanlage deckt alle Geschoße ab [2]. Für die Einreichung sind 2 Pläne "
            "vorhanden [1]. Welche Brandabschnitte die Pläne zeigen, muss im Einzelnen geöffnet werden." + QUELLEN
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert final.claims_ceiling == "medium"
        assert state.answer_confidence == "medium"
        assert state.answer_confidence_capped_reason == "normative_claim_uncited"


class TestAnUngroundedAnswerNeverReadsHigh:
    async def test_nothing_cited_reads_low(self):
        registry = SourceRegistry()
        prose = "Der Fluchtweg führt ins Freie. Die Sprinkleranlage ist mit 2 Pumpen ausgelegt."
        _, state = await _finalize(await _read_turn(prose, registry), registry)

        assert state.answer_confidence == "low"

    async def test_numbers_without_a_source_list_are_not_read_as_registry_positions(self):
        """The answer cites [1] and [2] and writes no Quellen list.

        Before, the verifier synthesised the list from the conversation's
        registry in registration order, so [1] became whatever was registered
        first: here an OIB passage from an earlier turn, for a sentence about
        the project's own fire concept. Now the numbers are labelled, and the
        answer is no longer graded as cited.
        """
        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.4",
                source_type="knowledge_layer",
                tool_name="knowledge_search",
                chunk_text="Die Richtlinie gilt für Gebäude.",
            )
        )
        prose = "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Es gibt 2 Brandmeldezentralen [2]."
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert "oib-rl_2" not in final.content
        assert final.content.count(DROPPED_CITATION_MARKER) == 2
        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited_dropped", "cited_dropped"]
        assert state.answer_confidence == "low"


class TestStoredAnswers:
    """The nine answers stored in the dev workspace, 2026-10-22 to 2026-10-27, re-graded under rule 3."""

    @staticmethod
    def _stamps(answer: dict) -> list[ClaimStamp]:
        if "stamps" in answer:
            return mark_load_bearing([ClaimStamp(*stamp) for stamp in answer["stamps"]])
        evidence = ClaimEvidence(
            cited_numbers=frozenset(answer["cited"]),
            passages={int(number): text for number, text in answer["passages"].items()},
        )
        return classify_claims(answer["content"], evidence, normative=answer_mentions_normative_claim)

    def test_all_nine_are_here(self):
        assert len(STORED_ANSWERS) == 9

    @pytest.mark.parametrize("answer", STORED_ANSWERS, ids=lambda answer: answer["id"])
    def test_the_level_follows_what_the_answer_rests_on(self, answer):
        assert answer["rule_2"] == "low"
        assert claims_ceiling(self._stamps(answer)) == answer["expected"], answer["judged"]

    def test_a_table_under_a_cited_lead_in_counts_half_where_the_passage_holds_its_rows(self):
        """„Überblick zur OIB-Richtlinie 2" (2026-10-23), its table cut to three rows, beside a passage holding them."""
        prose = (
            "Die OIB-Richtlinie 2 regelt Tragfähigkeit im Brandfall, Flucht- und Rettungswege und die "
            "Brandbekämpfung [1].\n\nDie Richtlinie gliedert sich wie folgt [1]:\n\n| Punkt | Inhalt |\n|---|---|\n"
            "| 2 | Allgemeine Anforderungen und Tragfähigkeit im Brandfall |\n| 5 | Flucht- und Rettungswege |\n"
            "| 12 | Bauführungen im Bestand |\n\nEingeschoßige Gebäude bis 15 m² Brutto-Grundfläche sind "
            "ausgenommen [1]. Danach darf für bestehende Bauwerksteile vom aktuellen Niveau abgewichen werden, "
            "solange das ursprüngliche Anforderungsniveau nicht verschlechtert wird [2]."
        )
        outline = (
            "2 Allgemeine Anforderungen und Tragfähigkeit im Brandfall 3 Ausbreitung von Feuer und Rauch "
            "5 Flucht- und Rettungswege 12 Bauführungen im Bestand"
        )
        stamps = classify_claims(
            prose,
            ClaimEvidence(cited_numbers=frozenset({1, 2}), passages={1: outline}),
            normative=answer_mentions_normative_claim,
        )

        rows = [stamp for stamp in stamps if " · " in stamp.text]
        assert [stamp.provenance for stamp in rows] == ["reasoning"] * 3
        assert [support(stamp) for stamp in rows if stamp.claim_type != "normative"] == [0.5, 0.5]
        assert claims_ceiling(stamps) == "medium"


class TestTheDerivedCreditChecksContent:
    """Review of #1231, probe P3: a row under a cited lead-in counted half whatever it said."""

    def test_an_invented_table_under_a_cited_lead_in_reads_low(self):
        prose = (
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Fluchtweglänge | 40 m |\n"
            "| Türbreite | 0,80 m |\n| Raumhöhe | 2,10 m |\n| Geländerhöhe | 0,85 m |\n| Stufenhöhe | 19 cm |"
        )
        passage = "Die Fluchtweglänge darf 40 m nicht überschreiten."
        stamps = _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: passage}))

        rows = [stamp for stamp in stamps if " · " in stamp.text and stamp.claim_type == "value"]
        assert [support(stamp) for stamp in rows] == [0.0, 0.0, 0.0, 0.0]
        assert claims_ceiling(stamps) == "low"

    def test_a_row_the_passage_holds_counts_half(self):
        stamps = _classes(
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Raumhöhe | 2,50 m |",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: "Die lichte Raumhöhe muss 2,50 m betragen."}),
        )
        assert [support(stamp) for stamp in stamps] == [1.0, 0.5]

    def test_the_lead_in_ends_at_the_first_blank_line_after_its_block(self):
        """Probe P3b: a later list or table is a paragraph of its own, drawn from nothing."""
        prose = (
            "Die Richtlinie gliedert sich wie folgt [1]:\n\n- Punkt 2 Tragfähigkeit\n- Punkt 5 Fluchtwege\n\n"
            "| A | B |\n|---|---|\n| Fluchtweg | 40 m |\n\n- Die Stellplatzzahl beträgt 14.\n\n- Die GFZ ist 1,8."
        )
        stamps = _classes(prose, ClaimEvidence(cited_numbers=frozenset({1})))

        assert [stamp.provenance for stamp in stamps] == [
            "cited",
            "reasoning",
            "reasoning",
            "model_knowledge",
            "model_knowledge",
            "model_knowledge",
        ]
        assert claims_ceiling(stamps) == "low"

    def test_a_requirement_row_under_a_cited_lead_in_is_no_claim_the_law_backs(self):
        """Probe P6."""
        stamps = _classes(
            "Die Anforderungen sind [1]:\n\n- Die Fluchtweglänge darf 40 m nicht überschreiten.\n"
            "- Türen müssen 0,90 m breit sein.",
            ClaimEvidence(cited_numbers=frozenset({1})),
        )
        assert [support(stamp) for stamp in stamps] == [1.0, 0.0, 0.0]
        assert claims_ceiling(stamps) == "low"


class TestAHedgeIsNoSource:
    """Review of #1231, probes P1 and P5: „Nach meiner Einschätzung" made an uncited verdict read high."""

    def test_a_hedged_uncited_verdict_beside_measurements_reads_low(self):
        stamps = _classes(
            "Der Keller ist 2,70 m hoch. Die Tür ist 0,90 m breit. Die Treppe ist 1,20 m breit. "
            "Nach meiner Einschätzung ist damit die Anforderung der OIB-Richtlinie 4 an die Raumhöhe erfüllt und "
            "die Bewilligung zulässig.",
            ClaimEvidence(measured_values=("2,70 m", "0,90 m", "1,20 m")),
        )
        verdict = stamps[-1]
        assert verdict.hedged and verdict.claim_type == "normative" and support(verdict) == 0.0
        assert verdict in unsupported_claims(stamps)
        assert claims_ceiling(stamps) == "low"

    def test_only_hedged_legal_statements_read_low(self):
        stamps = _classes(
            "Nach meiner Einschätzung ist eine Brandschutzwand nach OIB-RL 2 erforderlich. "
            "Nach meiner Einschätzung muss die Fluchtweglänge 40 m nicht überschreiten.",
            ClaimEvidence(),
        )
        assert claims_ceiling(stamps) == "low"

    async def test_a_hedged_verdict_end_to_end_is_named_and_not_high(self):
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht vorgesehen [2]. "
            "Die Brandmeldeanlage deckt alle Geschoße ab [2]. "
            "Nach meiner Einschätzung ist damit keine Sprinkleranlage nach OIB-Richtlinie 2 erforderlich und das "
            "Projekt bewilligungsfähig." + QUELLEN
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert final.claim_stamps[-1]["support"] == 0
        assert final.claims_ceiling == "medium"
        assert state.answer_confidence == "medium"


class TestHighMeansEveryClaimIsBacked:
    def test_one_einschaetzung_beside_cited_claims_keeps_it_below_high(self):
        stamps = mark_load_bearing(
            [
                ClaimStamp("Die Raumhöhe muss 2,50 m betragen [1].", "cited", "normative"),
                ClaimStamp("Die Frist beträgt 14 Tage [1].", "cited", "value"),
                ClaimStamp("Das sind also 2,50 m im Lichten.", "reasoning", "value", value_supported=True),
            ]
        )
        assert [support(stamp) for stamp in stamps] == [1.0, 1.0, 0.5]
        assert claims_ceiling(stamps) == "medium"
        assert claims_ceiling(stamps[:2]) == "high"


class TestTheLaunderingPathStaysShut:
    @staticmethod
    def _ceiling(*stamps: tuple[str, str, str]) -> str:
        return claims_ceiling(mark_load_bearing([ClaimStamp(*stamp) for stamp in stamps]))

    def test_records_never_lift_a_verdict_beside_them(self):
        """Four records and a legal conclusion with no passage: the conclusion is the answer, and it has nothing."""
        assert (
            self._ceiling(
                ("Anna Berger hat 3 Freigaben.", "record", "value"),
                ("Davon sind 2 offen.", "record", "value"),
                ("Lageplan · freigegeben", "record", "value"),
                ("Einreichplan · offen · 12.10.2026", "record", "value"),
                ("Der Einreichplan muss nach § 5 bewilligt werden.", "model_knowledge", "normative"),
            )
            == "low"
        )

    def test_a_measurement_and_its_uncited_verdict_read_low(self):
        assert (
            self._ceiling(
                ("Der Keller ist 2,70 m hoch.", "measured", "value"),
                ("Er erfüllt damit OIB 4 Punkt 2.1.", "model_knowledge", "normative"),
            )
            == "low"
        )

    def test_four_measurements_and_an_uncited_verdict_read_low(self):
        """Probe P2: the weight case the first version of ADR-0139 admitted as „medium"."""
        assert (
            self._ceiling(
                ("Der Keller ist 2,70 m hoch.", "measured", "value"),
                ("Der Gang ist 38,5 m lang.", "measured", "value"),
                ("Die Tür ist 0,90 m breit.", "measured", "value"),
                ("Die Treppe ist 1,20 m breit.", "measured", "value"),
                (
                    "Damit erfüllt das Gebäude die OIB-Richtlinie 4 und ist bewilligungsfähig.",
                    "model_knowledge",
                    "normative",
                ),
            )
            == "low"
        )

    def test_a_cited_fact_and_an_uncited_verdict_read_low(self):
        assert (
            self._ceiling(
                ("Die Brandmeldeanlage deckt alle 4 Geschoße ab [1].", "cited", "value"),
                ("Damit ist keine Sprinkleranlage erforderlich.", "model_knowledge", "normative"),
            )
            == "low"
        )

    def test_an_uncited_verdict_beside_a_cited_rule_reads_medium_and_is_named(self):
        stamps = mark_load_bearing(
            [
                ClaimStamp("Die Fluchtweglänge darf 40 m nicht überschreiten [1].", "cited", "normative"),
                ClaimStamp("Der Gang ist mit 38 m damit eingehalten.", "model_knowledge", "normative"),
            ]
        )
        assert claims_ceiling(stamps) == "medium"
        assert unsupported_claims(stamps) == [stamps[1]]


class TestAShortGroundedAnswer:
    """Review of #1231, item 7 and probe P4: one cited claim and one next step the net catches."""

    def test_one_cited_claim_and_one_next_step_read_medium(self):
        stamps = _classes(
            "Die Brandmeldeanlage deckt alle 4 Geschoße ab [1]. Welche Brandabschnitte die Pläne zeigen, muss im "
            "Einzelnen geöffnet werden.",
            ClaimEvidence(cited_numbers=frozenset({1})),
        )
        assert [support(stamp) for stamp in stamps] == [1.0, 0.0]
        assert claims_ceiling(stamps) == "medium"


class TestNumbersWithoutASourceList:
    """Review of #1231, item 4: a single-block turn without a Quellen list is not labelled wholesale."""

    async def test_one_block_resolves_by_its_own_numbering(self):
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. "
            "Die Brandmeldeanlage deckt alle Geschoße ab [2]."
        )
        final, state = await _finalize(await _read_turn(prose, registry, calls=("1-2",)), registry)

        assert DROPPED_CITATION_MARKER not in final.content
        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited", "cited"]
        assert state.answer_confidence == "high"

    async def test_two_blocks_leave_the_numbers_naming_nothing(self):
        """Each read_file call returns its own „Result 1": which one [1] means, nothing says."""
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. "
            "Die Brandmeldeanlage deckt alle Geschoße ab [2]."
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert final.content.count(DROPPED_CITATION_MARKER) == 2
        assert state.answer_confidence == "low"
