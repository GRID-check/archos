"""The confidence chip measures what the answer rests on (ADR-0139): each claim judged against its evidence.

Rule 2 (ADR-0125) held the answer to its weakest load-bearing sentence, and the
stored answers of 2026-10 all read „low". Four rounds of German word lists then
moved the errors from one side to the other: a next step read as a verdict, a
verdict read as a next step, „zulässig" held by a passage that says
„unzulässig". Rule 3 keeps deterministic what does not guess (which passage, row
or measurement a sentence points at, the dropped marker, the anti-laundering
rule) and lets one small model judge, once per answer, whether each sentence's
evidence supports it and whether it is a verdict, a fact, an assessment or a
next step (``common/claim_judge.py``).

The model is faked here (``tests/aiq_agent/claim_judge_stub.py``): these tests
check what reaches it and what the level does with its answer. One test wires
the real call shape. Every probe of the five reviews of #1231 is a test.
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
from langchain_core.messages import AIMessage
from langchain_core.messages import HumanMessage

from aiq_agent.agents.piloti.agent import PilotiAgent
from aiq_agent.agents.piloti.agent import _capture_sources
from aiq_agent.agents.piloti.answer_pipeline import finalize_answer
from aiq_agent.agents.piloti.answer_pipeline import prose_without_references
from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.common import claim_judge
from aiq_agent.common import data_source_registry
from aiq_agent.common import workspace_records
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import resolve_unlisted_numbers
from aiq_agent.common.citation_verification import unlisted_candidates
from aiq_agent.common.claim_judge import Judgement
from aiq_agent.common.claim_judge import llm_judge
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import claim_supports
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import with_judgements
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.workspace_records import WorkspaceRecord
from aiq_agent.common.workspace_records import inventory_record
from aiq_agent.common.workspace_records import profile_record
from aiq_agent.knowledge.inventory import render_inventory_block
from aiq_agent.tools.documents.tools import filesystem_tools
from sources.knowledge_layer.src import stored_pages
from sources.knowledge_layer.src.browse import FileRow
from sources.knowledge_layer.src.estate import EstateBackend
from tests.aiq_agent.claim_judge_stub import failing_judge
from tests.aiq_agent.claim_judge_stub import stub_judge

REPO = Path(__file__).parents[4]
PATH = "/project/Gutachten/Brandschutzkonzept.pdf.md"
ROW = FileRow(file_name="Brandschutzkonzept.pdf", shelf="project", collection="proj_a", folder="Gutachten")
PAGES = {
    1: "Der Fluchtweg führt über das Treppenhaus T1 ins Freie.",
    2: "Eine Sprinkleranlage ist nicht vorgesehen. Die Brandmeldeanlage deckt alle Geschoße ab.",
}
ENVELOPE = '```answer_json\n{{"kind": "direct", "confidence": {{"level": "high"}}, "answer": "{prose}"}}\n```'
STORED = REPO / "tests" / "fixtures" / "claim_provenance" / "stored_answers_2026-10.json"
STORED_ANSWERS = json.loads(STORED.read_text())["answers"]
QUELLEN = "\\n\\n**Quellen:**\\n- [1] Brandschutzkonzept.pdf, p.1\\n- [2] Brandschutzkonzept.pdf, p.2"
GROUNDED = (
    "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht "
    "vorgesehen [2]. Die Brandmeldeanlage deckt alle Geschoße ab [2]."
)
PROFILE = (
    "PROJECT_CONTEXT v1\n\nconfirmed:\n- building_class=GK5\n- escape_level_m@bldg1=12\n"
    "- storeys_above_ground@bldg1=5\n- work_type=extension\n- zoning=residential\n"
    "- construction_method@bldg1=timber\n\nunknown:\n- sewer"
)


def _stored(answer_id: str) -> dict:
    return next(answer for answer in STORED_ANSWERS if answer["id"] == answer_id)


def _stamps(prose: str, evidence: ClaimEvidence) -> list[ClaimStamp]:
    return classify_claims(prose, evidence, normative=answer_mentions_normative_claim)


def _judged(prose: str, evidence: ClaimEvidence, *judgements: Judgement) -> list[ClaimStamp]:
    stamps = _stamps(prose, evidence)
    return with_judgements(stamps, list(judgements) or None)


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


async def _finalize(messages: list, registry: SourceRegistry, judge=None, **context):
    final = await finalize_answer(
        messages, registry=registry, tools=[], repair=None, turn_sources=[], judge=judge or stub_judge(), **context
    )
    return final, assemble_result({"messages": messages}, final, turn_sources=[], turn_measurements=[])


class TestTheJudgeSeesWhatTheAnswerPointsAt:
    async def test_every_claim_supported_by_the_pages_it_read_reaches_the_models_level(self):
        registry = SourceRegistry()
        calls: list = []
        final, state = await _finalize(
            await _read_turn(GROUNDED + QUELLEN, registry), registry, stub_judge(calls=calls)
        )

        assert [stamp["judged"] for stamp in final.claim_stamps] == ["supported"] * 3
        assert state.answer_confidence == "high"
        # ONE call for the whole answer, each sentence with the page it cites, under its citation key.
        [batch] = calls
        assert [sentence for sentence, _ in batch][0].startswith("Der Fluchtweg führt")
        assert "[Brandschutzkonzept.pdf, p.1]" in batch[0][1] and PAGES[1] in batch[0][1]
        assert PAGES[2].split(".")[0] in batch[1][1]

    async def test_a_next_step_bears_no_load_and_names_nothing(self):
        """Rule 2 surfaced exactly this as „low", ``normative_claim_uncited``."""
        registry = SourceRegistry()
        prose = GROUNDED + " Welche Brandabschnitte die Pläne zeigen, muss im Einzelnen geöffnet werden." + QUELLEN
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        next_step = final.claim_stamps[-1]
        assert next_step["load_bearing"] is False and next_step["verdict"] is False
        assert final.claims_ceiling == "high" and state.answer_confidence == "high"

    async def test_a_sentence_its_passage_does_not_address_keeps_the_answer_below_high(self):
        registry = SourceRegistry()
        prose = GROUNDED + " Für die Einreichung sind 2 Pläne vorhanden [1]." + QUELLEN
        judge = stub_judge({"2 Pläne": Judgement("not_addressed", "fact")})
        final, state = await _finalize(await _read_turn(prose, registry), registry, judge)

        assert final.claim_stamps[-1]["support"] == 0
        assert state.answer_confidence == "medium"

    async def test_nothing_cited_reads_low(self):
        registry = SourceRegistry()
        prose = "Der Fluchtweg führt ins Freie. Die Sprinkleranlage ist mit 2 Pumpen ausgelegt."
        _, state = await _finalize(await _read_turn(prose, registry), registry)

        assert state.answer_confidence == "low"


class TestWhenTheJudgeCannotRun:
    """A timeout, an error or no model configured: medium, and the stamps say so."""

    @pytest.mark.parametrize("judge", [failing_judge, None])
    async def test_an_evidenced_answer_falls_back_to_medium_and_says_so_on_the_stamp(self, judge):
        registry = SourceRegistry()
        messages = await _read_turn(GROUNDED + QUELLEN, registry)
        final = await finalize_answer(messages, registry=registry, tools=[], repair=None, turn_sources=[], judge=judge)

        assert [stamp["judged"] for stamp in final.claim_stamps] == ["unavailable"] * 3
        assert [stamp["support"] for stamp in final.claim_stamps] == [0.5] * 3
        assert final.claims_ceiling == "medium"

    async def test_an_answer_with_no_evidence_still_reads_low(self):
        registry = SourceRegistry()
        messages = await _read_turn("Der Fluchtweg führt ins Freie.", registry)
        final = await finalize_answer(
            messages, registry=registry, tools=[], repair=None, turn_sources=[], judge=failing_judge
        )

        assert final.claims_ceiling == "low"


class TestTheRealCallShape:
    """``llm_judge`` on a chat model: one structured call, the evidence bounded, any failure ``None``."""

    class _Model:
        def __init__(self, reply: str = "", *, delay: float = 0.0):
            self.reply, self.delay, self.bound, self.messages = reply, delay, [], []

        def bind(self, **kwargs):
            self.bound.append(kwargs)
            return self

        async def ainvoke(self, messages):
            self.messages.append(messages)
            await asyncio.sleep(self.delay)
            return AIMessage(content=self.reply)

    async def test_one_structured_call_with_every_sentence_and_its_evidence(self):
        reply = json.dumps(
            {
                "items": [
                    {"index": 1, "support": "contradicted", "kind": "verdict"},
                    {"index": 0, "support": "supported", "kind": "fact"},
                ]
            }
        )
        model = self._Model(reply)
        found = await llm_judge(model)([("Die Tür ist 1 m breit.", "Tür 1,00 m"), ("Das ist zulässig.", "x" * 5000)])

        assert found == [Judgement("supported", "fact"), Judgement("contradicted", "verdict")]
        assert {"max_tokens": claim_judge.MAX_OUTPUT_TOKENS} in model.bound
        assert any("response_format" in kwargs for kwargs in model.bound)
        [[system, human]] = model.messages
        assert "Never use your own knowledge" in system.content
        payload = json.loads(human.content)["items"]
        assert payload[0] == {"index": 0, "sentence": "Die Tür ist 1 m breit.", "evidence": "Tür 1,00 m"}
        assert len(payload[1]["evidence"]) == claim_judge.MAX_EVIDENCE_CHARS

    async def test_an_unreadable_reply_or_a_timeout_is_none(self, monkeypatch):
        assert await llm_judge(self._Model("no json here"))([("a", "b")]) is None
        monkeypatch.setattr(claim_judge, "JUDGE_TIMEOUT_S", 0.01)
        assert await llm_judge(self._Model("{}", delay=1))([("a", "b")]) is None

    def test_the_agent_resolves_the_judge_on_the_follow_ups_group_and_none_without_a_model(self, monkeypatch):
        from aiq_agent.common.model_overrides import AgentGroup
        from aiq_agent.stages import runner

        resolved: list = []
        monkeypatch.setattr(
            runner, "resolve_group_llm", lambda base, group, *, label: resolved.append((base, group)) or base
        )
        base = self._Model()
        agent = PilotiAgent(llm_provider=MagicMock(), tools=[], claim_judge_llm=base)

        assert agent._claim_judge() is not None and resolved == [(base, AgentGroup.FOLLOW_UPS)]
        assert PilotiAgent(llm_provider=MagicMock(), tools=[])._claim_judge() is None


NEGATIONS = [
    ("Wendeltreppen sind zulässig [1].", "Unzulässig sind Wendeltreppen."),
    ("Eine Brandwand ist nicht erforderlich [1].", "Zwischen den Brandabschnitten ist eine Brandwand erforderlich."),
    ("Die Richtlinie gilt nicht für Gebäude [1].", "Diese Richtlinie gilt für Gebäude."),
    ("Brandschutz ist hier nicht nötig [1].", "Für Gebäude der Gebäudeklasse 5 ist ein Brandschutzkonzept nötig."),
    ("Sonstige Bauwerke sind ausgenommen [1].", "Für sonstige Bauwerke sind die Bestimmungen sinngemäß anzuwenden."),
]


class TestNegationIsTheJudgesToSee:
    """Review of round 4 (r4ph.py): each read HIGH, cited and „checked", against a passage saying the opposite."""

    @pytest.mark.parametrize(("sentence", "passage"), NEGATIONS)
    def test_a_verdict_its_passage_contradicts_reads_low(self, sentence, passage):
        stamps = _judged(
            f"Die Treppe ist 1,20 m breit [1]. {sentence}",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: f"Die Treppe ist 1,20 m breit. {passage}"}),
            Judgement("supported", "fact"),
            Judgement("contradicted", "verdict"),
        )

        assert passage in stamps[1].evidence
        assert claims_ceiling(stamps) == "low"


class TestNumbersWithoutASourceList:
    """``[N]`` with no Quellen list: resolved by content; the judge reads every passage an occurrence may name."""

    async def test_each_block_numbers_from_one_so_the_numbers_collide(self):
        registry = SourceRegistry()
        messages = await _read_turn("x", registry)

        assert "--- Result 1 ---" in messages[2].content and "--- Result 1 ---" in messages[3].content

    async def test_numbers_resolve_to_this_turns_passages_never_to_registry_positions(self):
        """The registry holds an OIB page from an earlier turn first; [1] is page 1 of the file this turn read."""
        registry = SourceRegistry()
        registry.add(
            SourceEntry(
                citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.4",
                source_type="knowledge_layer",
                tool_name="knowledge_search",
                chunk_text="Die Richtlinie gilt für Gebäude.",
            )
        )
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. "
            "Die Brandmeldeanlage deckt alle Geschoße ab [2]."
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert "oib-rl_2" not in final.content and DROPPED_CITATION_MARKER not in final.content
        assert "Brandschutzkonzept.pdf, p.1" in final.content and "Brandschutzkonzept.pdf, p.2" in final.content
        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited", "cited"]
        assert state.answer_confidence == "high"

    def test_content_settles_a_collision_and_nothing_settles_a_guess(self):
        numbered = {
            1: [
                SourceEntry(citation_key="a.pdf, p.1", chunk_text="Die Richtlinie gilt für Gebäude sinngemäß."),
                SourceEntry(citation_key="b.pdf, p.9", chunk_text="Tabelle 2b Treppenhäuser Gebäudeklasse 5."),
            ]
        }

        assert (
            resolve_unlisted_numbers("Sie gilt für Gebäude, sinngemäß [1].", numbered)[0].citation_key == "a.pdf, p.1"
        )
        assert resolve_unlisted_numbers("Das Dach ist begrünt [1].", numbered) == []

    def test_the_number_breaks_a_tie_between_passages_that_both_hold_the_sentence(self):
        numbered = {
            1: [SourceEntry(citation_key="a.pdf, p.1", chunk_text="Die Richtlinie gilt für Gebäude sinngemäß.")],
            2: [SourceEntry(citation_key="b.pdf, p.3", chunk_text="Die Richtlinie gilt für Gebäude sinngemäß.")],
        }

        resolved = resolve_unlisted_numbers("Sie gilt für Gebäude, sinngemäß [2].", numbered)

        assert [entry.citation_key if entry else None for entry in resolved] == [None, "b.pdf, p.3"]

    PERMIT = SourceEntry(
        citation_key="Bescheid_MA37.pdf, p.2",
        chunk_text="Die Baubewilligung wird unter Auflagen erteilt. Auflage 3: Fluchtweg 1,20 m.",
    )
    SECTION = SourceEntry(
        citation_key="Wien-Lacknergasse-Schnitt-section.pdf, p.1",
        chunk_text="Gebäudeschnitt Keller EG 1.OG DG Dachoberkante 10,10 m",
    )
    STAIRS = SourceEntry(
        citation_key="oib-rl_4_ausgabe_mai_2023.pdf, p.7",
        chunk_text="Die Breite von Treppen muss mindestens 1,20 m betragen.",
    )

    @pytest.mark.parametrize(
        ("text", "numbered"),
        [
            # A named file does not override what the passages say (r3c.py, case 1).
            ("Wien-Lacknergasse-Schnitt-section.pdf widerspricht der Auflage 3 des Bescheids [1].", "split"),
            # A number binds to no passage that does not hold its value (case 2).
            ("Die Treppe muss mindestens 1,50 m breit sein [2].", "split"),
            # A collision is not settled by a near miss (case 3).
            ("Die Breite von Treppen beträgt hier 0,90 m, das ist ausreichend [1].", "collided"),
        ],
    )
    def test_a_number_no_passage_carries_is_labelled(self, text, numbered):
        blocks = {
            "split": {1: [self.PERMIT], 2: [self.SECTION]},
            "collided": {1: [self.PERMIT, self.STAIRS]},
        }[numbered]

        assert resolve_unlisted_numbers(text, blocks) == []

    @staticmethod
    def _numbered(rows: list[dict], *, on_across_blocks: bool) -> dict[int, list[SourceEntry]]:
        numbered: dict[int, list[SourceEntry]] = {}
        for position, row in enumerate(rows, 1):
            number = position if on_across_blocks else row["number"]
            numbered.setdefault(number, []).append(
                SourceEntry(citation_key=row["citation_key"], chunk_text=row["text"] or None)
            )
        return numbered

    @pytest.mark.parametrize("on_across_blocks", [False, True])
    def test_haus_josef_resolves_both_numbers_under_either_numbering(self, on_across_blocks):
        answer = _stored("oib2-haus-josef-2026-10-22")
        resolved = resolve_unlisted_numbers(
            answer["content"], self._numbered(answer["turn"], on_across_blocks=on_across_blocks)
        )

        assert [entry.citation_key for entry in resolved] == [
            "oib-rl_2_ausgabe_mai_2023.pdf, p.4",
            "oib-rl_2_ausgabe_mai_2023.pdf, p.23",
        ]
        assert "12 Bauführungen im Bestand" in (resolved[1].chunk_text or "")

    def test_each_occurrence_is_judged_against_every_passage_its_number_may_name(self):
        """Review of round 4: the table rows citing [1] voided „Sie gilt für Gebäude … [1]", word for word page 4."""
        answer = _stored("oib2-haus-josef-2026-10-22")
        candidates = unlisted_candidates(answer["content"], self._numbered(answer["turn"], on_across_blocks=False))

        texts = " ".join(entry.chunk_text or "" for entry in candidates[1])
        assert "Diese Richtlinie gilt für Gebäude" in texts and "12 Bauführungen im Bestand" in texts
        # A passage printed under another number is a candidate when it carries the sentence: [4] of the plans.
        plans = _stored("plans-2026-10-23")
        named = unlisted_candidates(plans["content"], self._numbered(plans["turn"], on_across_blocks=False))
        assert "Tectum-Projektplakate Kopie 2.pdf, p.1" in [entry.citation_key for entry in named[4]]

    def test_the_plans_turn_resolves_by_content_across_its_two_searches(self):
        """Searches numbered 1..8 and 1..4: [4] is the Tectum poster, printed under 3, because only it holds it."""
        answer = _stored("plans-2026-10-23")
        resolved = resolve_unlisted_numbers(answer["content"], self._numbered(answer["turn"], on_across_blocks=False))

        assert [entry.citation_key if entry else None for entry in resolved] == [
            "Wien-Lacknergasse-Schnitt-section.pdf, p.1",
            None,
            None,
            "Tectum-Projektplakate Kopie 2.pdf, p.1",
        ]


class TestAPointerThatDidNotHoldCapsAtHalf:
    LISTING = "\n".join(
        line.casefold()
        for line in (
            "Abgabepläne",
            "Wien-Lacknergasse-Grundrisse-floorplans.pdf  Grundrisse Tiefparterre, Obergeschoß, 1:100",
            "Wien-Lacknergasse-Ansichten-views.pdf  Westansicht, Ostansicht",
        )
    )

    def test_a_sentence_read_off_the_listing_keeps_its_record_and_counts_half_with_a_dropped_marker(self):
        record = WorkspaceRecord("list_files", "read", self.LISTING, items=tuple(self.LISTING.split("\n")))
        sentence = "Wien-Lacknergasse-Grundrisse-floorplans.pdf enthält Tiefparterre und Obergeschoß im Maßstab 1:100"
        for text, dropped, level in (
            (sentence + ".", False, "high"),
            (f"{sentence} {DROPPED_CITATION_MARKER}.", True, "medium"),
        ):
            stamps = _judged(text, ClaimEvidence(records=(record,)), Judgement("supported", "fact"))

            assert [(stamp.provenance, stamp.dropped) for stamp in stamps] == [("record", dropped)]
            assert claims_ceiling(stamps) == level


class TestTheConfirmedProjectProfileIsARecord:
    def test_rows_read_off_the_profile_are_held_to_their_row(self):
        stamps = _judged(
            "| Merkmal | Angabe |\n|---|---|\n| Geschoße | 5 oberirdisch |\n| Gebäudeklasse | GK 5 (bestätigt) |",
            ClaimEvidence(records=(profile_record(PROFILE),)),
            Judgement("supported", "fact"),
            Judgement("supported", "fact"),
        )

        assert [(stamp.provenance, stamp.operation) for stamp in stamps] == [("record", "project-profile")] * 2
        assert "storeys_above_ground" in stamps[0].evidence and "building_class" not in stamps[0].evidence
        assert claims_ceiling(stamps) == "high"

    def test_the_profile_never_grounds_a_verdict(self):
        stamps = _judged(
            "Die Gebäudeklasse ist GK 5 (bestätigt). Damit ist eine Holzbauweise zulässig.",
            ClaimEvidence(records=(profile_record(PROFILE),)),
            Judgement("supported", "fact"),
            Judgement("supported", "verdict"),
        )

        assert [support(stamp) for stamp in stamps] == [1.0, 0.0]

    @pytest.mark.parametrize(
        "sentence",
        [
            "Im Projekt gibt es 3 Stiegenhäuser.",
            "Das Gebäude hat 12 Wohnungen.",
            "Für das Projekt sind 5 Brandabschnitte vorgesehen.",
            "Bei GK 5 ist das Fluchtniveau auf 22 m begrenzt.",
        ],
    )
    def test_a_number_the_profile_holds_in_another_row_never_reads_high(self, sentence):
        """r3probe.py: a number counts only inside the row that also holds one of the sentence's words."""
        stamps = _judged(sentence, ClaimEvidence(records=(profile_record(PROFILE),)), Judgement("supported", "fact"))

        assert claims_ceiling(stamps) != "high"

    def test_unknowns_notes_and_contested_facts_are_no_record(self):
        record = profile_record(PROFILE + "\n\nPROJECT_MEMORY v1\n- Parkhaus im 16. Bezirk")
        assert record is not None and "sewer" not in record.haystack and "parkhaus" not in record.haystack
        assert profile_record("no profile here") is None

        contested = PROFILE + "\n\ncontested:\n- storeys_above_ground@bldg1: 5 | alternativ: 6 (Einreichplan.pdf)"
        [stamp] = _stamps(
            "Das Gebäude hat 5 oberirdische Geschoße.", ClaimEvidence(records=(profile_record(contested),))
        )
        assert stamp.provenance != "record" and stamp.evidence == ""

    async def test_the_pipeline_reads_the_turn_contexts_profile(self):
        messages = [
            HumanMessage("Wie viele Geschoße?"),
            AIMessage(ENVELOPE.format(prose="Das Gebäude hat 5 oberirdische Geschoße.")),
        ]
        final, _ = await _finalize(messages, SourceRegistry(), project_context=PROFILE)

        assert [(stamp["provenance"], stamp.get("operation")) for stamp in final.claim_stamps] == [
            ("record", "project-profile")
        ]
        assert final.claims_ceiling == "high"

    def test_every_spoken_profile_word_names_a_token_the_intake_writes(self):
        """Drift: the German comes from ``profile_names`` (held to legacy-names.json), the rest names a live token."""
        profile_dir = REPO / "frontends" / "ui" / "src" / "lib" / "project-profile"
        sources = "".join(
            path.read_text(encoding="utf-8")
            for path in sorted(profile_dir.glob("*.ts"))
            if ".spec." not in path.name and ".test." not in path.name
        ) + (profile_dir / "legacy-names.json").read_text(encoding="utf-8")
        # Booleans are printed by the prompt view as JSON values, not tokens.
        tokens = [token for token in workspace_records._PROFILE_SPOKEN if token not in ("true", "false")]

        assert [token for token in tokens if not re.search(rf"['\"/]{token}['\"/@]", sources)] == []


class TestTheInventoryIsARecordLineByLine:
    @staticmethod
    def _inventory() -> str:
        documents = [{"file_name": f"oib-{n}.pdf", "shelf": "base"} for n in range(39)]
        documents += [
            {"file_name": name, "shelf": "project"}
            for name in (
                "Wien-Lacknergasse-Grundrisse-floorplans.pdf",
                "Wien-Lacknergasse-Ansichten-views.pdf",
                "Wien-Lacknergasse-Schnitt-section.pdf",
                "Tectum-Projektplakate Kopie 2.pdf",
                "pd8280-2.pdf",
            )
        ]
        return render_inventory_block(documents)

    def test_a_count_read_off_a_shelf_line_is_a_record_and_a_wrong_one_is_not(self):
        record = inventory_record(self._inventory())
        right = _stamps("Im Basiswissen liegen 39 Dateien.", ClaimEvidence(records=(record,)))
        wrong = _stamps("Im Basiswissen liegen 40 Dateien.", ClaimEvidence(records=(record,)))

        assert [(stamp.provenance, stamp.operation) for stamp in right] == [("record", "inventory")]
        assert "39 files" in right[0].evidence
        assert wrong[0].provenance == "model_knowledge" and wrong[0].evidence == ""

    @pytest.mark.parametrize(
        "sentence",
        [
            "Die Grundrisse und Ansichten zeigen einen Massivbau aus Ziegel.",
            "Die Ansichten und der Schnitt belegen eine Gebäudehöhe von 2 Geschoßen.",
        ],
    )
    def test_two_file_names_on_two_lines_ground_no_claim_about_what_the_documents_contain(self, sentence):
        """r4inv.py: one item per shelf let these read HIGH; a line holds one file name."""
        stamps = _judged(
            sentence, ClaimEvidence(records=(inventory_record(self._inventory()),)), Judgement("supported", "fact")
        )

        assert stamps[0].provenance == "model_knowledge" and claims_ceiling(stamps) == "low"

    async def test_the_pipeline_reads_the_turn_contexts_inventory(self):
        messages = [
            HumanMessage("Wie viele Dateien hat das Basiswissen?"),
            AIMessage(ENVELOPE.format(prose="Dazu kommen die 39 Dateien des OIB-Korpus im Basiswissen.")),
        ]
        final, _ = await _finalize(messages, SourceRegistry(), inventory=self._inventory())

        assert [(stamp["provenance"], stamp.get("operation")) for stamp in final.claim_stamps] == [
            ("record", "inventory")
        ]
        assert final.claims_ceiling == "high"


class TestATableUnderALeadInIsOneClaim:
    def test_an_invented_table_under_a_cited_lead_in_reads_low(self):
        prose = (
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Fluchtweglänge | 40 m |\n"
            "| Türbreite | 0,80 m |\n| Raumhöhe | 2,10 m |"
        )
        passage = "Grenzwerte: Die Fluchtweglänge darf 40 m nicht überschreiten."
        unaddressed = Judgement("not_addressed", "verdict")
        stamps = _judged(
            prose,
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: passage}),
            Judgement("supported", "fact"),
            Judgement("supported", "verdict"),
            unaddressed,
            unaddressed,
        )

        grouped = [stamp for stamp in stamps if stamp.group is not None]
        assert len(grouped) == 4 and grouped[0].lead_in
        # The lead-in is not a row: one of three rows backed, whatever the lead-in's own finding.
        assert claim_supports(stamps) == [pytest.approx(1 / 3)]
        assert claims_ceiling(stamps) == "medium"
        none = with_judgements(stamps, [Judgement("supported", "fact")] + [unaddressed] * 3)
        assert claims_ceiling(none) == "low"


def _fixture_stamps(answer: dict) -> list[ClaimStamp]:
    """An entry's stamps, judged as its ``judgements`` say (unlisted: supported with evidence, a fact)."""
    if "stamps" in answer:
        stamps = [
            ClaimStamp(
                text, provenance, ctype, evidence="" if provenance == "model_knowledge" else f"(stored {provenance})"
            )
            for text, provenance, ctype in answer["stamps"]
        ]
    else:
        cited = set(answer.get("cited", []))
        passages = {int(number): text for number, text in answer.get("passages", {}).items()}
        if "turn" in answer:
            numbered: dict[int, list[SourceEntry]] = {}
            for row in answer["turn"]:
                numbered.setdefault(row["number"], []).append(
                    SourceEntry(citation_key=row["citation_key"], chunk_text=row["text"] or None)
                )
            resolved = [(n, e) for n, e in enumerate(resolve_unlisted_numbers(answer["content"], numbered), 1) if e]
            candidates = unlisted_candidates(answer["content"], numbered)
            cited = {number for number, _ in resolved}
            passages = {
                number: "\n\n".join(
                    f"[{entry.citation_key}]\n{entry.chunk_text}"
                    for entry in [chosen, *(c for c in candidates.get(number, []) if c != chosen)]
                    if entry.chunk_text
                )
                for number, chosen in resolved
            }
        record = profile_record(answer.get("project_context"))
        evidence = ClaimEvidence(cited_numbers=frozenset(cited), passages=passages, records=(record,) if record else ())
        stamps = _stamps(prose_without_references(answer["content"]), evidence)
    labels = answer.get("judgements", [])
    judgements = []
    for stamp in stamps:
        label = next((label for label in labels if label[0] in stamp.text), None)
        if label is not None:
            judgements.append(Judgement(label[1], label[2]))
        else:
            judgements.append(Judgement("supported" if stamp.evidence else "not_addressed", "fact"))
    return with_judgements(stamps, judgements)


class TestStoredAnswers:
    """Answers stored in the dev workspace, re-graded under rule 3 with the judge's findings."""

    @pytest.mark.parametrize("answer", STORED_ANSWERS, ids=lambda answer: answer["id"])
    def test_the_level_follows_what_the_answer_rests_on(self, answer):
        assert claims_ceiling(_fixture_stamps(answer)) == answer["expected"], answer["judged"]

    def test_every_label_names_a_sentence_of_its_answer(self):
        for answer in STORED_ANSWERS:
            texts = [stamp.text for stamp in _fixture_stamps(answer)]
            for label in answer.get("judgements", []):
                assert any(label[0] in text for text in texts), (answer["id"], label[0])

    def test_the_four_kinds_of_good_answer_and_the_refusal_read_as_they_should(self):
        """The complaint: listings, the profile overview, collided numbers; and an answer that claims nothing."""
        levels = {answer["id"]: claims_ceiling(_fixture_stamps(answer)) for answer in STORED_ANSWERS}
        assert levels["folder-listing"] == "high"
        assert levels["oib2-overview-2026-10-22"] == "medium" and levels["oib2-haus-josef-2026-10-22"] == "medium"
        assert levels["refusal-knowledge-off-2026-10-22"] == "low"
        assert "low" not in {levels[key] for key in levels if key != "refusal-knowledge-off-2026-10-22"}
