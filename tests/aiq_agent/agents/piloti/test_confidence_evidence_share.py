"""The confidence chip measures what the answer rests on (ADR-0139).

A grounded answer never reads low, an ungrounded one never high.

Rule 2 (ADR-0125) held the answer to its weakest load-bearing sentence, and the
normative detector that decides which sentences bear load is a wide net. 8 of
9 answers stored in the dev workspace between 2026-10-22 and 2026-10-27 read
„low", most of them record- or passage-grounded, each floored by one sentence
the net caught (a next step, a fact about the corpus, a table row under a cited
lead-in). Three more carried citations bound to the wrong document: the answer
wrote ``[N]`` with no Quellen list, and the numbers were read as positions in
the conversation's cumulative registry.

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


async def _read_turn(prose: str, registry: SourceRegistry) -> list:
    """A turn that read both pages with ``read_file`` and answered ``prose``, captured as the agent captures it."""
    tools = {tool.name: tool for tool in filesystem_tools(None, _estate())}
    calls, results = [], []
    for page in PAGES:
        call_id = f"c{page}-{uuid4().hex[:4]}"
        runtime = SimpleNamespace(tool_call_id=call_id, state={}, context=None, store=None, config={})
        message = await tools["read_file"].coroutine(runtime=runtime, file_path=PATH, pages=str(page))
        _capture_sources("read_file", message.content, frozenset(tools), registry, message.artifact)
        calls.append({"id": call_id, "name": "read_file", "args": {"file_path": PATH, "pages": str(page)}})
        results.append(message)
    return [
        HumanMessage("Was steht im Brandschutzkonzept?"),
        AIMessage(content="", tool_calls=calls),
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
    """Real answers from the dev workspace, re-graded from their stored stamps."""

    @pytest.mark.parametrize("answer", json.loads(STORED.read_text())["answers"], ids=lambda answer: answer["id"])
    def test_the_level_follows_what_the_answer_rests_on(self, answer):
        stamps = mark_load_bearing([ClaimStamp(*stamp) for stamp in answer["stamps"]])

        assert answer["rule_2"] == "low"
        assert claims_ceiling(stamps) == answer["expected"], answer["judged"]

    def test_a_table_under_a_cited_lead_in_is_drawn_from_it(self):
        """„Überblick zur OIB-Richtlinie 2" (2026-10-23), its table cut to three rows.

        The rows carry no [N] of their own; the sentence that introduces them
        does. Under rule 2 every row was model knowledge and the answer read
        „low"; the rows are an Einschätzung drawn from the cited lead-in.
        """
        prose = (
            "Die OIB-Richtlinie 2 regelt Tragfähigkeit im Brandfall, Flucht- und Rettungswege und die "
            "Brandbekämpfung [1].\n\nDie Richtlinie gliedert sich wie folgt [1]:\n\n| Punkt | Inhalt |\n|---|---|\n"
            "| 2 | Allgemeine Anforderungen und Tragfähigkeit im Brandfall |\n| 5 | Flucht- und Rettungswege |\n"
            "| 12 | Bauführungen im Bestand |\n\nEingeschoßige Gebäude bis 15 m² Brutto-Grundfläche sind "
            "ausgenommen [1]. Danach darf für bestehende Bauwerksteile vom aktuellen Niveau abgewichen werden, "
            "solange das ursprüngliche Anforderungsniveau nicht verschlechtert wird [2]."
        )
        stamps = classify_claims(
            prose, ClaimEvidence(cited_numbers=frozenset({1, 2})), normative=answer_mentions_normative_claim
        )

        rows = [stamp for stamp in stamps if " · " in stamp.text]
        assert [stamp.provenance for stamp in rows] == ["reasoning"] * 3
        assert claims_ceiling(stamps) == "medium"


class TestTheLaunderingPathStaysShut:
    @staticmethod
    def _ceiling(*stamps: tuple[str, str, str]) -> str:
        return claims_ceiling(mark_load_bearing([ClaimStamp(*stamp) for stamp in stamps]))

    def test_records_never_lift_a_verdict_beside_them_to_high(self):
        assert (
            self._ceiling(
                ("Anna Berger hat 3 Freigaben.", "record", "value"),
                ("Davon sind 2 offen.", "record", "value"),
                ("Lageplan · freigegeben", "record", "value"),
                ("Einreichplan · offen · 12.10.2026", "record", "value"),
                ("Der Einreichplan muss nach § 5 bewilligt werden.", "model_knowledge", "normative"),
            )
            == "medium"
        )

    def test_a_measurement_and_its_uncited_verdict_read_low(self):
        assert (
            self._ceiling(
                ("Der Keller ist 2,70 m hoch.", "measured", "value"),
                ("Er erfüllt damit OIB 4 Punkt 2.1.", "model_knowledge", "normative"),
            )
            == "low"
        )
