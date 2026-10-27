"""The confidence chip measures what the answer rests on (ADR-0139).

A grounded answer never reads low, an ungrounded one never high.

Rule 2 (ADR-0125) held the answer to its weakest load-bearing sentence, and the
normative detector that decides which sentences bear load is a wide net. The
answers stored in the dev workspace between 2026-10-22 and 2026-10-27
(``stored_answers_2026-10.json``) all read „low" but one: listings floored by a
next step, a profile overview with no record behind it, and three answers with
citations bound to the wrong document by registry position.

Rule 3: a claim is a load-bearing sentence, or a table under a lead-in as one;
``high`` only when every claim is backed, ``low`` when most are not or an
uncited verdict has no legal passage beside it, ``medium`` otherwise. Next
steps bear no load, only a verdict needs a passage, the confirmed project
profile is a record. The reviews of #1231 probed it; each probe is a test here.

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
from aiq_agent.agents.piloti.answer_pipeline import prose_without_references
from aiq_agent.agents.piloti.grounding import answer_mentions_normative_claim
from aiq_agent.agents.piloti.ledger import assemble_result
from aiq_agent.common import data_source_registry
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import resolve_unlisted_numbers
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import claim_supports
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import mark_load_bearing
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import unsupported_claims
from aiq_agent.common.grounding_block import begin_grounding_capture
from aiq_agent.common.grounding_block import end_grounding_capture
from aiq_agent.common.workspace_records import WorkspaceRecord
from aiq_agent.common.workspace_records import profile_record
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

    async def test_a_next_step_the_normative_net_catches_bears_no_load(self):
        """Rule 2 surfaced exactly this as „low", ``normative_claim_uncited``; round 3 of #1231: high, no warning."""
        registry = SourceRegistry()
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht "
            "vorgesehen [2]. Die Brandmeldeanlage deckt alle Geschoße ab [2]. Für die Einreichung sind 2 Pläne "
            "vorhanden [1]. Welche Brandabschnitte die Pläne zeigen, muss im Einzelnen geöffnet werden." + QUELLEN
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        next_step = final.claim_stamps[-1]
        assert next_step["load_bearing"] is False and next_step["verdict"] is False
        assert final.claims_ceiling == "high"
        assert state.answer_confidence == "high"


class TestAnUngroundedAnswerNeverReadsHigh:
    async def test_nothing_cited_reads_low(self):
        registry = SourceRegistry()
        prose = "Der Fluchtweg führt ins Freie. Die Sprinkleranlage ist mit 2 Pumpen ausgelegt."
        _, state = await _finalize(await _read_turn(prose, registry), registry)

        assert state.answer_confidence == "low"


class TestNumbersWithoutASourceList:
    """``[N]`` with no Quellen list (review of #1231, rounds 2 and 3)."""

    async def test_a_turn_numbers_its_passages_on_across_blocks(self):
        """Two read_file calls: „Result 1" and „Result 2", so [1] and [2] name one page each."""
        registry = SourceRegistry()
        messages = await _read_turn("x", registry)

        assert "--- Result 1 ---" in messages[2].content and "--- Result 2 ---" in messages[3].content

    async def test_numbers_resolve_to_this_turns_passages_never_to_registry_positions(self):
        """The registry holds an OIB page from an earlier turn first; [1] is page 1 of the file this turn read.

        Before round 2 the verifier read [1] as the registry's first entry (the OIB page); round 2 labelled
        both numbers, so a sentence copied word for word from page 1 read „low". Now each number names the
        passage the turn printed under it, and the reader gets the Quellen list the model left out.
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
        prose = (
            "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. "
            "Die Brandmeldeanlage deckt alle Geschoße ab [2]."
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert "oib-rl_2" not in final.content
        assert DROPPED_CITATION_MARKER not in final.content
        assert "Brandschutzkonzept.pdf, p.1" in final.content and "Brandschutzkonzept.pdf, p.2" in final.content
        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited", "cited"]
        assert state.answer_confidence == "high"

    def test_a_named_file_settles_a_number_the_blocks_collide_on(self):
        """Blocks numbered from 1 each (a replay): the sentence names the drawing it read."""
        numbered = {
            1: [
                SourceEntry(citation_key="oib-rl_2_ausgabe_mai_2023.pdf, p.4", chunk_text="Vorbemerkungen"),
                SourceEntry(citation_key="Wien-Lacknergasse-Schnitt-section.pdf, p.1", chunk_text="Schnitt A-A"),
            ]
        }
        text = "Die Datei Wien-Lacknergasse-Schnitt-section.pdf zeigt einen Gebäudeschnitt [1]."

        resolved = resolve_unlisted_numbers(text, numbered)

        assert [entry.citation_key for entry in resolved] == ["Wien-Lacknergasse-Schnitt-section.pdf, p.1"]

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


class TestAPointerThatDidNotHoldErasesNothing:
    """Review of #1231, round 3, item 2 and probe.py: a dropped marker zeroed the record behind the sentence."""

    LISTING = "\n".join(
        line.casefold()
        for line in (
            "Abgabepläne",
            "Wien-Lacknergasse-Grundrisse-floorplans.pdf  Grundrisse Tiefparterre, Obergeschoß, 1:100",
            "Wien-Lacknergasse-Ansichten-views.pdf  Westansicht, Ostansicht",
        )
    )

    def test_a_sentence_read_off_the_listing_stays_a_record_with_a_dropped_marker(self):
        record = WorkspaceRecord("list_files", "read", self.LISTING, items=tuple(self.LISTING.split("\n")))
        sentence = "Wien-Lacknergasse-Grundrisse-floorplans.pdf enthält Tiefparterre und Obergeschoß im Maßstab 1:100"
        for text, dropped in ((sentence + ".", False), (f"{sentence} {DROPPED_CITATION_MARKER}.", True)):
            stamps = _classes(text, ClaimEvidence(records=(record,)))

            assert [(stamp.provenance, stamp.dropped, support(stamp)) for stamp in stamps] == [("record", dropped, 1.0)]
            assert claims_ceiling(stamps) == "high"


class TestNextStepsBearNoLoad:
    """Round 3, items 4 and 5 (probe.py): next steps are no claims; verdicts are, wherever the net is wrong."""

    @pytest.mark.parametrize(
        "sentence",
        [
            "Welche Maßstäbe und Stände sie tatsächlich tragen, muss im Einzelnen geöffnet werden.",
            "Ob diese Blätter zu diesem Projekt gehören, muss die Projektleitung klären, bevor sie in die "
            "Einreichung übernommen werden.",
            "Ob GK 5 hier richtig ist, muss mit der Gebäudeklasse-Ableitung geprüft werden.",
            "Ob die Ausgabe Mai 2023 in Wien tatsächlich verbindlich erklärt ist, muss vor einer Einreichung "
            "geprüft werden.",
            "Als Nächstes wäre der Flächenwidmungsplan auszuwerten.",
            "Eine kurze Nachricht mit der gewünschten Richtung genügt.",
            "Nicht gelesen habe ich in diesem Zug die Anforderungstexte der einzelnen Punkte.",
            "Ob ein zweiter Fluchtweg erforderlich ist, muss geprüft werden.",
        ],
    )
    def test_a_next_step_is_no_verdict_and_bears_no_load(self, sentence):
        stamps = _classes("Die Tür ist 0,90 m breit. " + sentence, ClaimEvidence(measured_values=("0,90 m",)))

        assert not stamps[1].is_verdict and stamps[1].is_next_step and not stamps[1].load_bearing
        assert claims_ceiling(stamps) == "high"

    @pytest.mark.parametrize(
        "sentence",
        [
            "Die Treppe ist damit zu schmal.",
            "Ein zweiter Fluchtweg ist nötig.",
            "Ein Brandschutzkonzept ist vorzulegen.",
            "Die Treppe hat eine Breite von 1,10 m, nach OIB-RL 4 sind 1,20 m nötig.",
            "Der Abstand muss nach § 5 eingehalten werden.",
            "Die Treppe erfüllt die Anforderung nicht.",
        ],
    )
    def test_a_measurement_beside_an_uncited_verdict_reads_low(self, sentence):
        """probe2.py: „1,10 m" measured, then a verdict with no passage."""
        stamps = _classes(
            "Die Treppe im Stiegenhaus T1 ist 1,10 m breit. " + sentence, ClaimEvidence(measured_values=("1,10",))
        )

        assert stamps[-1].is_verdict
        assert claims_ceiling(stamps) == "low"
        assert unsupported_claims(stamps) == [stamps[-1]]

    @pytest.mark.parametrize(
        "sentence",
        [
            "Die Höhen widersprechen sich zudem: Der Schnitt zeigt 10,10 m Dachoberkante, die Ostansicht 20,45 m.",
            "Die Gebäudeklasse 5 ist laut Projektdaten bestätigt.",
            "Fluchtniveau · 11–22 m, Rechenwert 12 m",
        ],
    )
    def test_a_fact_the_net_catches_is_no_verdict(self, sentence):
        assert not _classes(sentence, ClaimEvidence())[0].is_verdict


class TestTheConfirmedProjectProfileIsARecord:
    """Round 3, item 1: „was weißt du über das Projekt" read 0/5 low; the profile rows are what the person confirmed."""

    CONTEXT = (
        "PROJECT_CONTEXT v1\n\nconfirmed:\n- building_class=GK5\n- escape_level_m@bldg1=12\n"
        "- storeys_above_ground@bldg1=5\n- work_type=extension\n- zoning=residential\n\nunknown:\n- sewer"
    )

    def test_value_and_class_rows_read_off_the_profile_are_backed(self):
        record = profile_record(self.CONTEXT)
        prose = (
            "| Merkmal | Angabe laut Projektkontext |\n|---|---|\n| Gebäudeklasse | GK 5 (bestätigt) |\n"
            "| Fluchtniveau | Rechenwert 12 m |\n| Geschoße | 5 oberirdisch |\n| Widmung | Wohngebiet |"
        )
        stamps = _classes(prose, ClaimEvidence(records=(record,)))

        assert [(stamp.provenance, stamp.operation) for stamp in stamps] == [("record", "project-profile")] * 4
        assert claims_ceiling(stamps) == "high"

    def test_the_profile_never_grounds_a_verdict(self):
        """The anti-laundering rule: a confirmed GK 5 is a fact; „damit ist … zulässig" is the law's to say."""
        stamps = _classes(
            "Die Gebäudeklasse ist GK 5 (bestätigt). Damit ist eine Holzbauweise zulässig.",
            ClaimEvidence(records=(profile_record(self.CONTEXT),)),
        )

        assert stamps[0].provenance == "record" and support(stamps[0]) == 1.0
        assert stamps[1].is_verdict and support(stamps[1]) == 0.0
        assert claims_ceiling(stamps) == "low"

    def test_unknowns_and_notes_are_no_record(self):
        record = profile_record(self.CONTEXT + "\n\nPROJECT_MEMORY v1\n- Parkhaus im 16. Bezirk")

        assert record is not None and "sewer" not in record.haystack and "parkhaus" not in record.haystack
        assert profile_record("no profile here") is None

    async def test_the_pipeline_reads_the_turn_contexts_profile(self):
        registry = SourceRegistry()
        prose = "Die Gebäudeklasse ist GK 5, das Fluchtniveau liegt bei 12 m."
        messages = [HumanMessage("Welche GK?"), AIMessage(ENVELOPE.format(prose=prose))]
        final = await finalize_answer(
            messages, registry=registry, tools=[], repair=None, turn_sources=[], project_context=self.CONTEXT
        )

        assert [(stamp["provenance"], stamp.get("operation")) for stamp in final.claim_stamps] == [
            ("record", "project-profile")
        ]
        assert final.claims_ceiling == "high"


class TestATableUnderALeadInIsOneClaim:
    """Round 3, item 7: nine rows of a table of contents must not outvote five cited sentences."""

    def test_the_rows_and_their_lead_in_count_once_with_their_mean(self):
        rows = "".join(f"| {n} | Punkt {n} |\n" for n in range(3, 12))
        prose = (
            "Die Richtlinie gilt für Gebäude [1]. Sie regelt den Brandschutz [1]. Eingeschoßige Gebäude bis 15 m² "
            "sind ausgenommen [1]. Abweichungen sind nach Landesrecht möglich [1]. Punkt 12 regelt den Bestand [1].\n\n"
            "Die Richtlinie gliedert sich wie folgt [1]:\n\n| Punkt | Inhalt |\n|---|---|\n" + rows
        )
        stamps = _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: "Vorbemerkungen"}))

        grouped = [stamp for stamp in stamps if stamp.group is not None]
        assert len(grouped) == 10 and grouped[0].text.endswith(":")
        supports = claim_supports(stamps)
        assert len(supports) == len([s for s in stamps if s.load_bearing and s.group is None]) + 1
        assert 0 < supports[-1] < 1
        assert claims_ceiling(stamps) == "medium"


class TestStoredAnswers:
    """Answers stored in the dev workspace, 2026-10-22 to 2026-10-27, re-graded under rule 3 (round 3 of #1231)."""

    @staticmethod
    def _stamps(answer: dict) -> list[ClaimStamp]:
        if "stamps" in answer:
            return mark_load_bearing([ClaimStamp(*stamp) for stamp in answer["stamps"]])
        cited = set(answer.get("cited", []))
        passages = {int(number): text for number, text in answer.get("passages", {}).items()}
        if "turn" in answer:
            numbered: dict[int, list[SourceEntry]] = {}
            for row in answer["turn"]:
                numbered.setdefault(row["number"], []).append(
                    SourceEntry(citation_key=row["citation_key"], chunk_text=row["text"] or None)
                )
            resolved = resolve_unlisted_numbers(answer["content"], numbered)
            cited = {index + 1 for index, entry in enumerate(resolved) if entry is not None}
            passages = {index + 1: entry.chunk_text or "" for index, entry in enumerate(resolved) if entry is not None}
        record = profile_record(answer.get("project_context"))
        evidence = ClaimEvidence(cited_numbers=frozenset(cited), passages=passages, records=(record,) if record else ())
        return classify_claims(
            prose_without_references(answer["content"]), evidence, normative=answer_mentions_normative_claim
        )

    def test_the_answers_rule_2_did_not_rate_low_are_here_too(self):
        assert any(answer["rule_2"] != "low" for answer in STORED_ANSWERS)

    @pytest.mark.parametrize("answer", STORED_ANSWERS, ids=lambda answer: answer["id"])
    def test_the_level_follows_what_the_answer_rests_on(self, answer):
        assert claims_ceiling(self._stamps(answer)) == answer["expected"], answer["judged"]

    def test_no_listing_or_profile_answer_names_an_uncited_verdict(self):
        """The complaint of the re-review: a pure listing showed „Rechtsaussage ohne Beleg" for a next step."""
        for answer in STORED_ANSWERS:
            if answer["id"] in ("folder-listing", "listing-complete", "project-overview-from-profile"):
                assert not [stamp for stamp in self._stamps(answer) if stamp.is_verdict], answer["id"]


class TestTheDerivedCreditChecksContent:
    """Review of #1231, round 2, probe P3: a row under a cited lead-in counted half whatever it said."""

    def test_an_invented_table_under_a_cited_lead_in_counts_nothing(self):
        prose = (
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Fluchtweglänge | 40 m |\n"
            "| Türbreite | 0,80 m |\n| Raumhöhe | 2,10 m |\n| Geländerhöhe | 0,85 m |\n| Stufenhöhe | 19 cm |"
        )
        passage = "Die Fluchtweglänge darf 40 m nicht überschreiten."
        stamps = _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: passage}))

        rows = [stamp for stamp in stamps if " · " in stamp.text and stamp.claim_type == "value"]
        assert [support(stamp) for stamp in rows] == [0.0, 0.0, 0.0, 0.0]
        assert claims_ceiling(stamps) == "medium"
        assert claim_supports(stamps)[0] < 0.5

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


class TestAHedgeIsNoSource:
    """Review of #1231, round 2, probes P1 and P5: „Nach meiner Einschätzung" made an uncited verdict read high."""

    def test_a_hedged_uncited_verdict_beside_measurements_reads_low(self):
        stamps = _classes(
            "Der Keller ist 2,70 m hoch. Die Tür ist 0,90 m breit. Die Treppe ist 1,20 m breit. "
            "Nach meiner Einschätzung ist damit die Anforderung der OIB-Richtlinie 4 an die Raumhöhe erfüllt und "
            "die Bewilligung zulässig.",
            ClaimEvidence(measured_values=("2,70 m", "0,90 m", "1,20 m")),
        )
        verdict = stamps[-1]
        assert verdict.hedged and verdict.is_verdict and support(verdict) == 0.0
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

        assert final.claim_stamps[-1]["support"] == 0 and final.claim_stamps[-1]["verdict"] is True
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

    def test_a_record_never_grounds_a_verdict_it_states(self):
        assert self._ceiling(("Der Abstand ist damit nach § 5 eingehalten.", "record", "normative")) == "low"

    def test_a_measurement_and_its_uncited_verdict_read_low(self):
        assert (
            self._ceiling(
                ("Der Keller ist 2,70 m hoch.", "measured", "value"),
                ("Er erfüllt damit OIB 4 Punkt 2.1.", "model_knowledge", "normative"),
            )
            == "low"
        )

    def test_four_measurements_and_an_uncited_verdict_read_low(self):
        """Probe P2."""
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
    """Review of #1231, rounds 2 and 3: one cited claim and one next step the net catches."""

    def test_one_cited_claim_and_one_next_step_read_high(self):
        stamps = _classes(
            "Die Brandmeldeanlage deckt alle 4 Geschoße ab [1]. Welche Brandabschnitte die Pläne zeigen, muss im "
            "Einzelnen geöffnet werden.",
            ClaimEvidence(cited_numbers=frozenset({1})),
        )
        assert [stamp.load_bearing for stamp in stamps] == [True, False]
        assert claims_ceiling(stamps) == "high"
