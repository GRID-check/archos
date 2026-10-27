"""The confidence chip measures what the answer rests on (ADR-0139).

Rule 2 (ADR-0125) held the answer to its weakest load-bearing sentence, and the
normative detector that decides which sentences bear load is a wide net. The
answers stored in the dev workspace between 2026-10-22 and 2026-10-27
(``stored_answers_2026-10.json``) all read „low" but one: listings floored by a
next step, a profile overview with no record behind it, and three answers with
citations bound to the wrong document by registry position.

Rule 3: a claim is a load-bearing sentence, or a table under a lead-in as one;
``high`` only when every claim is backed, ``low`` when most are not or an
uncited verdict has no legal passage beside it, ``medium`` otherwise.

Every heuristic fails safe (round 4 of #1231): where a word list or a matcher
is unsure, a claim drops to half, never climbs to whole. A citation counts
whole only when its passage holds the sentence, and nothing when the sentence
states a number the passage does not hold; a record, an action or a
measurement counts whole only for a sentence that states no law; a pointer
that did not hold caps its sentence at half. The reviews of #1231 probed it;
each probe is a test here.

These go through the real filesystem tool, the real source capture and
``finalize_answer``, so a part nobody calls would show.
"""

from __future__ import annotations

import json
import re
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
from aiq_agent.common import workspace_records
from aiq_agent.common.citation_verification import DROPPED_CITATION_MARKER
from aiq_agent.common.citation_verification import SourceEntry
from aiq_agent.common.citation_verification import SourceRegistry
from aiq_agent.common.citation_verification import resolve_unlisted_numbers
from aiq_agent.common.claim_provenance import ClaimEvidence
from aiq_agent.common.claim_provenance import ClaimStamp
from aiq_agent.common.claim_provenance import claim_supports
from aiq_agent.common.claim_provenance import claims_ceiling
from aiq_agent.common.claim_provenance import classify_claims
from aiq_agent.common.claim_provenance import is_next_step
from aiq_agent.common.claim_provenance import mark_load_bearing
from aiq_agent.common.claim_provenance import states_verdict
from aiq_agent.common.claim_provenance import support
from aiq_agent.common.claim_provenance import unsupported_claims
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


def _stored(answer_id: str) -> dict:
    return next(answer for answer in STORED_ANSWERS if answer["id"] == answer_id)


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
GROUNDED = (
    "Der Fluchtweg führt über das Treppenhaus T1 ins Freie [1]. Eine Sprinkleranlage ist nicht "
    "vorgesehen [2]. Die Brandmeldeanlage deckt alle Geschoße ab [2]."
)


def _checked(text: str, provenance: str, claim_type: str, **fields) -> ClaimStamp:
    """A stamp whose passage holds it, as ``classify_claims`` marks one."""
    return ClaimStamp(text, provenance, claim_type, checked=provenance in ("quoted", "cited"), **fields)


class TestAGroundedAnswerNeverReadsLow:
    async def test_every_claim_cited_from_files_it_read_reaches_the_models_level(self):
        registry = SourceRegistry()
        final, state = await _finalize(await _read_turn(GROUNDED + QUELLEN, registry), registry)

        assert [stamp["provenance"] for stamp in final.claim_stamps] == ["cited", "cited", "cited"]
        assert state.answer_confidence == "high"

    async def test_a_next_step_the_normative_net_catches_bears_no_load(self):
        """Rule 2 surfaced exactly this as „low", ``normative_claim_uncited``; now high, no warning."""
        registry = SourceRegistry()
        prose = GROUNDED + " Welche Brandabschnitte die Pläne zeigen, muss im Einzelnen geöffnet werden." + QUELLEN
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        next_step = final.claim_stamps[-1]
        assert next_step["load_bearing"] is False and next_step["verdict"] is False
        assert final.claims_ceiling == "high"
        assert state.answer_confidence == "high"


class TestACitationCountsWhatItsPassageHolds:
    """Round 4, the fake citations: a pointer bound to a passage is not yet a passage that says it."""

    def test_a_cited_sentence_whose_words_its_passage_does_not_hold_counts_half(self):
        """The number is on the passage, the claim is not: the matcher is unsure, so half, never whole."""
        stamps = _classes(
            "Die Fluchtweglänge beträgt 40 m [1].",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: "Die Attika ist 40 m vom Nachbarn entfernt."}),
        )

        assert [(stamp.provenance, stamp.checked, support(stamp)) for stamp in stamps] == [("cited", False, 0.5)]
        assert claims_ceiling(stamps) == "medium"

    async def test_a_number_its_passage_does_not_hold_counts_nothing(self):
        """„2 Pläne" cited to page 1, which holds no 2: a value from elsewhere, not from [1]."""
        registry = SourceRegistry()
        prose = GROUNDED + " Für die Einreichung sind 2 Pläne vorhanden [1]." + QUELLEN
        final, _ = await _finalize(await _read_turn(prose, registry), registry)

        assert final.claim_stamps[-1]["support"] == 0
        assert final.claims_ceiling == "medium"

    def test_the_file_a_sentence_names_is_no_content_it_must_find(self):
        """The Tectum poster's page text never prints its own file name; the sentence is still held."""
        passage = "Der Plan zeigt den Grundriss des 3. Obergeschosses im Maßstab 1:200."
        sentence = "Tectum-Projektplakate Kopie 2.pdf zeigt das 3. Obergeschoß im Maßstab 1:200 [1]."
        held = _classes(
            sentence,
            ClaimEvidence(
                cited_numbers=frozenset({1}),
                passages={1: passage},
                sources={1: "Tectum-Projektplakate Kopie 2.pdf, p.1"},
            ),
        )
        unnamed = _classes(sentence, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: passage}))

        assert [support(stamp) for stamp in held] == [1.0]
        assert [support(stamp) for stamp in unnamed] == [0.0]


class TestAnUngroundedAnswerNeverReadsHigh:
    async def test_nothing_cited_reads_low(self):
        registry = SourceRegistry()
        prose = "Der Fluchtweg führt ins Freie. Die Sprinkleranlage ist mit 2 Pumpen ausgelegt."
        _, state = await _finalize(await _read_turn(prose, registry), registry)

        assert state.answer_confidence == "low"


class TestNumbersWithoutASourceList:
    """``[N]`` with no Quellen list (review of #1231, rounds 2 to 4): resolved by content, the number breaks ties."""

    async def test_each_block_numbers_from_one_so_the_numbers_collide(self):
        """Two read_file calls each print „Result 1": a bare [1] names neither by its number alone."""
        registry = SourceRegistry()
        messages = await _read_turn("x", registry)

        assert "--- Result 1 ---" in messages[2].content and "--- Result 1 ---" in messages[3].content

    async def test_numbers_resolve_to_this_turns_passages_never_to_registry_positions(self):
        """The registry holds an OIB page from an earlier turn first; [1] is page 1 of the file this turn read.

        Before round 2 the verifier read [1] as the registry's first entry (the OIB page). Now each number
        names the passage of the turn that holds its sentence, and the reader gets the Quellen list the
        model left out.
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
            # One number for two files: no one passage holds both sentences (case 4).
            ("Wien-Lacknergasse-Schnitt-section.pdf zeigt 10,10 m [1]. Bescheid_MA37.pdf nennt 1,20 m [1].", "split"),
        ],
    )
    def test_a_number_no_passage_holds_is_labelled(self, text, numbered):
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
    def test_haus_josef_resolves_clause_12_to_page_23_under_either_numbering(self, on_across_blocks):
        """Round 3 numbered on across blocks and lost [2]; the turn's real numbering collides. Content settles both."""
        answer = _stored("oib2-haus-josef-2026-10-22")
        resolved = resolve_unlisted_numbers(
            answer["content"], self._numbered(answer["turn"], on_across_blocks=on_across_blocks)
        )

        assert resolved[1] is not None and resolved[1].citation_key == "oib-rl_2_ausgabe_mai_2023.pdf, p.23"
        assert "12 Bauführungen im Bestand" in (resolved[1].chunk_text or "")
        assert resolved[0] is None

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
    """Round 3 item 2, round 4 item 3: a dropped marker zeroes nothing behind the sentence, and lifts nothing."""

    LISTING = "\n".join(
        line.casefold()
        for line in (
            "Abgabepläne",
            "Wien-Lacknergasse-Grundrisse-floorplans.pdf  Grundrisse Tiefparterre, Obergeschoß, 1:100",
            "Wien-Lacknergasse-Ansichten-views.pdf  Westansicht, Ostansicht",
        )
    )

    def test_a_sentence_read_off_the_listing_keeps_its_record_and_reads_half_with_a_dropped_marker(self):
        record = WorkspaceRecord("list_files", "read", self.LISTING, items=tuple(self.LISTING.split("\n")))
        sentence = "Wien-Lacknergasse-Grundrisse-floorplans.pdf enthält Tiefparterre und Obergeschoß im Maßstab 1:100"
        for text, dropped, level in (
            (sentence + ".", False, "high"),
            (f"{sentence} {DROPPED_CITATION_MARKER}.", True, "medium"),
        ):
            stamps = _classes(text, ClaimEvidence(records=(record,)))

            assert [(stamp.provenance, stamp.dropped) for stamp in stamps] == [("record", dropped)]
            assert support(stamps[0]) == (0.5 if dropped else 1.0)
            assert claims_ceiling(stamps) == level


class TestNextStepsBearNoLoad:
    """Round 3, items 4 and 5; round 4, item 2: next steps are no claims, and a verdict is never one."""

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
            "Wo das Fluchtniveau über 11 m liegt, ist ein Brandschutzkonzept erforderlich.",
            "Wie die OIB-RL 2 festlegt, ist für GK 5 eine Brandwand erforderlich.",
            "Wenn Sie so bauen, ist die Treppe mit 1,10 m zu schmal.",
            "Wer im Bestand umbaut, muss Punkt 12 der OIB-RL 2 einhalten.",
            "Die Brandschutztüren müssen jährlich geprüft werden.",
            "Der Feuerwiderstand muss durch ein Prüfzeugnis bestätigt werden.",
            "Ob mit oder ohne Sprinkleranlage, ist eine Brandwand erforderlich.",
            "Welche Nutzung auch geplant ist, muss die Brandwand REI 90 aufweisen.",
        ],
    )
    def test_a_verdict_behind_a_next_step_opener_never_reads_high(self, sentence):
        """r3probe.py (d): the round-3 openers let each of these lift an answer to high."""
        stamps = _classes(
            "Das Fluchtniveau liegt bei 12 m. " + sentence,
            ClaimEvidence(records=(profile_record(TestTheConfirmedProjectProfileIsARecord.CONTEXT),)),
        )

        assert not is_next_step(sentence) and stamps[-1].is_verdict and stamps[-1].load_bearing
        assert claims_ceiling(stamps) == "low"

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


class TestTheVerdictWordListsFailSafe:
    """Round 4, item 5: a miss lets a verdict count off a record; a false hit only asks for a passage."""

    @pytest.mark.parametrize(
        "sentence",
        [
            "Für GK 5 ist REI 90 gefordert.",
            "Ein Aufzug muss eingebaut werden.",
            "Das Dachgeschoß darf nicht ausgebaut werden.",
            "Hier ist ein Brandschutzkonzept Pflicht.",
            "Es braucht einen zweiten Fluchtweg.",
            "Die Garage muss eine Sprinkleranlage haben.",
            "Die OIB-Richtlinie 2.3 ist für dieses Projekt maßgeblich, weil das Fluchtniveau 12 m beträgt.",
        ],
    )
    def test_a_requirement_is_a_verdict(self, sentence):
        assert states_verdict(sentence)

    @pytest.mark.parametrize(
        "sentence",
        [
            "Die Stiege ist zu breit geplant, das ist kein Problem.",
            "Das Dokument ist zu klein gedruckt.",
            "Dieser Wert gilt für 2023.",
        ],
    )
    def test_a_description_is_no_verdict(self, sentence):
        assert not states_verdict(sentence)

    def test_a_normative_sentence_the_lists_miss_counts_half_off_a_record(self):
        """No verdict word, but the net reads it normative: a record backs it half, never whole."""
        stamps = _classes(
            "Die Gebäudeklasse ist GK 5.",
            ClaimEvidence(records=(profile_record(TestTheConfirmedProjectProfileIsARecord.CONTEXT),)),
        )

        assert [(stamp.provenance, stamp.claim_type, stamp.is_verdict) for stamp in stamps] == [
            ("record", "normative", False)
        ]
        assert support(stamps[0]) == 0.5
        assert claims_ceiling(stamps) == "medium"


class TestTheConfirmedProjectProfileIsARecord:
    """Round 3, item 1: „was weißt du über das Projekt" read 0/5 low; the profile rows are what the person confirmed."""

    CONTEXT = (
        "PROJECT_CONTEXT v1\n\nconfirmed:\n- building_class=GK5\n- escape_level_m@bldg1=12\n"
        "- storeys_above_ground@bldg1=5\n- work_type=extension\n- zoning=residential\n"
        "- construction_method@bldg1=timber\n\nunknown:\n- sewer"
    )

    def test_value_rows_read_off_the_profile_are_backed_and_normative_rows_count_half(self):
        record = profile_record(self.CONTEXT)
        values = (
            "| Merkmal | Angabe laut Projektkontext |\n|---|---|\n| Geschoße | 5 oberirdisch |\n| Bauweise | Holz |"
        )
        normative = "| Merkmal | Angabe laut Projektkontext |\n|---|---|\n| Gebäudeklasse | GK 5 (bestätigt) |"

        value_stamps = _classes(values, ClaimEvidence(records=(record,)))
        normative_stamps = _classes(normative, ClaimEvidence(records=(record,)))

        assert [(stamp.provenance, stamp.operation, support(stamp)) for stamp in value_stamps] == [
            ("record", "project-profile", 1.0)
        ] * 2
        assert claims_ceiling(value_stamps) == "high"
        assert [(stamp.provenance, support(stamp)) for stamp in normative_stamps] == [("record", 0.5)]
        assert claims_ceiling(normative_stamps) == "medium"

    def test_the_profile_never_grounds_a_verdict(self):
        """The anti-laundering rule: a confirmed GK 5 is a fact; „damit ist … zulässig" is the law's to say."""
        stamps = _classes(
            "Die Gebäudeklasse ist GK 5 (bestätigt). Damit ist eine Holzbauweise zulässig.",
            ClaimEvidence(records=(profile_record(self.CONTEXT),)),
        )

        assert stamps[0].provenance == "record" and support(stamps[0]) == 0.5
        assert stamps[1].is_verdict and support(stamps[1]) == 0.0
        assert claims_ceiling(stamps) == "low"

    @pytest.mark.parametrize(
        "sentence",
        [
            "Im Projekt gibt es 3 Stiegenhäuser.",
            "Das Gebäude hat 12 Wohnungen.",
            "Für das Projekt sind 5 Brandabschnitte vorgesehen.",
            "Bei GK 5 ist das Fluchtniveau auf 22 m begrenzt.",
            "Die OIB-Richtlinie 2.3 ist für dieses Projekt maßgeblich, weil das Fluchtniveau 12 m beträgt.",
            "Der Zubau hat 5 Geschoße [Beleg nicht verifiziert].",
        ],
    )
    def test_a_number_the_profile_holds_elsewhere_never_reads_high(self, sentence):
        """r3probe.py (e): a number counts only in the row that also holds one of the sentence's words."""
        stamps = _classes(sentence, ClaimEvidence(records=(profile_record(self.CONTEXT),)))

        assert claims_ceiling(stamps) != "high"

    def test_unknowns_and_notes_are_no_record(self):
        record = profile_record(self.CONTEXT + "\n\nPROJECT_MEMORY v1\n- Parkhaus im 16. Bezirk")

        assert record is not None and "sewer" not in record.haystack and "parkhaus" not in record.haystack
        assert profile_record("no profile here") is None

    def test_a_contested_fact_grounds_nothing(self):
        """It has alternatives: the person has not settled it, so it is no confirmed row."""
        context = self.CONTEXT + "\n\ncontested:\n- storeys_above_ground@bldg1: 5 | alternativ: 6 (Einreichplan.pdf)"
        stamps = _classes("Das Gebäude hat 5 oberirdische Geschoße.", ClaimEvidence(records=(profile_record(context),)))

        assert stamps[0].provenance != "record"
        assert claims_ceiling(stamps) == "low"

    async def test_the_pipeline_reads_the_turn_contexts_profile(self):
        registry = SourceRegistry()
        prose = "Das Gebäude hat 5 oberirdische Geschoße."
        messages = [HumanMessage("Wie viele Geschoße?"), AIMessage(ENVELOPE.format(prose=prose))]
        final = await finalize_answer(
            messages, registry=registry, tools=[], repair=None, turn_sources=[], project_context=self.CONTEXT
        )

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


class TestTheInventoryIsARecord:
    """Round 4, item 6: „39 Dateien des OIB-Korpus" was read off the turn context's inventory block."""

    @staticmethod
    def _inventory() -> str:
        documents = [{"file_name": f"oib-{n}.pdf", "shelf": "base"} for n in range(39)]
        documents += [{"file_name": "Grundriss.pdf", "shelf": "project"}]
        return render_inventory_block(documents)

    def test_a_count_read_off_a_shelf_is_a_record_and_a_wrong_one_is_not(self):
        record = inventory_record(self._inventory())
        assert record is not None

        right = _classes("Im Basiswissen liegen 39 Dateien.", ClaimEvidence(records=(record,)))
        wrong = _classes("Im Basiswissen liegen 40 Dateien.", ClaimEvidence(records=(record,)))

        assert [(stamp.provenance, stamp.operation, support(stamp)) for stamp in right] == [
            ("record", "inventory", 1.0)
        ]
        assert [support(stamp) for stamp in wrong] == [0.0]

    def test_the_stored_sentence_is_a_record_and_counts_half_as_the_net_reads_it_normative(self):
        """It names the OIB corpus, so the net reads it normative; a record backs such a sentence half (fail safe)."""
        stamps = _classes(
            "Dazu kommen die 39 Dateien des OIB-Korpus im Basiswissen.",
            ClaimEvidence(records=(inventory_record(self._inventory()),)),
        )

        assert [(stamp.provenance, stamp.claim_type, support(stamp)) for stamp in stamps] == [
            ("record", "normative", 0.5)
        ]

    async def test_the_pipeline_reads_the_turn_contexts_inventory(self):
        registry = SourceRegistry()
        messages = [
            HumanMessage("Wie viele Dateien hat das Basiswissen?"),
            AIMessage(ENVELOPE.format(prose="Im Basiswissen liegen 39 Dateien.")),
        ]
        final = await finalize_answer(
            messages, registry=registry, tools=[], repair=None, turn_sources=[], inventory=self._inventory()
        )

        assert [(stamp["provenance"], stamp.get("operation")) for stamp in final.claim_stamps] == [
            ("record", "inventory")
        ]
        assert final.claims_ceiling == "high"


class TestATableUnderALeadInIsOneClaim:
    """Round 3, item 7: nine rows of a table of contents must not outvote five cited sentences."""

    PASSAGE = (
        "Die Richtlinie gilt für Gebäude und regelt den Brandschutz. Eingeschoßige Gebäude bis 15 m² sind "
        "ausgenommen. Abweichungen sind nach Landesrecht möglich. Punkt 12 regelt den Bestand. Die Richtlinie "
        "gliedert sich wie folgt: Punkt 3, Punkt 4, Punkt 5, Punkt 6."
    )

    def test_the_rows_and_their_lead_in_count_once_with_the_mean_of_the_rows(self):
        rows = "".join(f"| {n} | Punkt {n} |\n" for n in range(3, 12))
        prose = (
            "Die Richtlinie gilt für Gebäude [1]. Sie regelt den Brandschutz [1]. Eingeschoßige Gebäude bis 15 m² "
            "sind ausgenommen [1]. Abweichungen sind nach Landesrecht möglich [1]. Punkt 12 regelt den Bestand [1].\n\n"
            "Die Richtlinie gliedert sich wie folgt [1]:\n\n| Punkt | Inhalt |\n|---|---|\n" + rows
        )
        stamps = _classes(prose, ClaimEvidence(cited_numbers=frozenset({1}), passages={1: self.PASSAGE}))

        grouped = [stamp for stamp in stamps if stamp.group is not None]
        assert len(grouped) == 10 and grouped[0].text.endswith(":") and grouped[0].lead_in
        supports = claim_supports(stamps)
        assert len(supports) == len([s for s in stamps if s.load_bearing and s.group is None]) + 1
        # Rows 3 to 6 are on the passage, 7 to 11 are not: the lead-in does not lift them.
        assert 0 < supports[-1] < 0.5
        assert claims_ceiling(stamps) == "medium"


class TestStoredAnswers:
    """Answers stored in the dev workspace, re-graded under rule 3 (round 4 of #1231)."""

    @staticmethod
    def _stamps(answer: dict) -> list[ClaimStamp]:
        if "stamps" in answer:
            return mark_load_bearing([ClaimStamp(*stamp) for stamp in answer["stamps"]])
        cited = set(answer.get("cited", []))
        passages = {int(number): text for number, text in answer.get("passages", {}).items()}
        sources = {int(number): key for number, key in answer.get("sources", {}).items()}
        if "turn" in answer:
            numbered: dict[int, list[SourceEntry]] = {}
            for row in answer["turn"]:
                numbered.setdefault(row["number"], []).append(
                    SourceEntry(citation_key=row["citation_key"], chunk_text=row["text"] or None)
                )
            resolved = list(enumerate(resolve_unlisted_numbers(answer["content"], numbered), 1))
            cited = {number for number, entry in resolved if entry is not None}
            passages = {number: entry.chunk_text or "" for number, entry in resolved if entry is not None}
            sources = {number: entry.citation_key for number, entry in resolved if entry is not None}
        record = profile_record(answer.get("project_context"))
        evidence = ClaimEvidence(
            cited_numbers=frozenset(cited), passages=passages, sources=sources, records=(record,) if record else ()
        )
        return classify_claims(
            prose_without_references(answer["content"]), evidence, normative=answer_mentions_normative_claim
        )

    def test_the_answers_rule_2_did_not_rate_low_are_here_too(self):
        assert any(answer["rule_2"] != "low" for answer in STORED_ANSWERS)

    def test_an_answer_that_deserves_low_is_here_too(self):
        assert any(answer["expected"] == "low" and "stamps" not in answer for answer in STORED_ANSWERS)

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
        assert claim_supports(stamps)[0] < 0.5
        assert claims_ceiling(stamps) == "low"

    def test_a_cited_lead_in_does_not_lift_an_invented_row(self):
        """The group is scored over its rows: the lead-in the passage holds is not one of them."""
        stamps = _classes(
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Türbreite | 0,80 m |",
            ClaimEvidence(
                cited_numbers=frozenset({1}),
                passages={1: "Grenzwerte: Die Fluchtweglänge darf 40 m nicht überschreiten."},
            ),
        )

        assert [support(stamp) for stamp in stamps] == [1.0, 0.0]
        assert claim_supports(stamps) == [0.0]

    def test_a_row_the_passage_holds_counts_half(self):
        stamps = _classes(
            "Die Grenzwerte lauten [1]:\n\n| Bauteil | Wert |\n|---|---|\n| Raumhöhe | 2,50 m |",
            ClaimEvidence(
                cited_numbers=frozenset({1}), passages={1: "Grenzwerte: Die lichte Raumhöhe muss 2,50 m betragen."}
            ),
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
            GROUNDED + " Nach meiner Einschätzung ist damit keine Sprinkleranlage nach OIB-Richtlinie 2 erforderlich "
            "und das Projekt bewilligungsfähig." + QUELLEN
        )
        final, state = await _finalize(await _read_turn(prose, registry), registry)

        assert final.claim_stamps[-1]["support"] == 0 and final.claim_stamps[-1]["verdict"] is True
        assert final.claims_ceiling == "medium"
        assert state.answer_confidence == "medium"


class TestHighMeansEveryClaimIsBacked:
    def test_one_einschaetzung_beside_cited_claims_keeps_it_below_high(self):
        stamps = mark_load_bearing(
            [
                _checked("Die Raumhöhe muss 2,50 m betragen [1].", "cited", "normative"),
                _checked("Die Frist beträgt 14 Tage [1].", "cited", "value"),
                ClaimStamp("Das sind also 2,50 m im Lichten.", "reasoning", "value", value_supported=True),
            ]
        )
        assert [support(stamp) for stamp in stamps] == [1.0, 1.0, 0.5]
        assert claims_ceiling(stamps) == "medium"
        assert claims_ceiling(stamps[:2]) == "high"

    def test_a_citation_its_passage_was_not_checked_against_counts_half(self):
        assert support(ClaimStamp("Die Frist beträgt 14 Tage [1].", "cited", "value")) == 0.5


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

    def test_an_uncited_verdict_beside_a_checked_rule_reads_medium_and_is_named(self):
        stamps = mark_load_bearing(
            [
                _checked("Die Fluchtweglänge darf 40 m nicht überschreiten [1].", "cited", "normative"),
                ClaimStamp("Der Gang ist mit 38 m damit eingehalten.", "model_knowledge", "normative"),
            ]
        )
        assert claims_ceiling(stamps) == "medium"
        assert unsupported_claims(stamps) == [stamps[1]]

    def test_an_unchecked_rule_beside_an_uncited_verdict_reads_low(self):
        """A citation its passage does not hold is no legal passage beside the verdict."""
        stamps = mark_load_bearing(
            [
                ClaimStamp("Die Fluchtweglänge darf 40 m nicht überschreiten [1].", "cited", "normative"),
                ClaimStamp("Der Gang ist mit 38 m damit eingehalten.", "model_knowledge", "normative"),
            ]
        )
        assert claims_ceiling(stamps) == "low"


class TestAShortGroundedAnswer:
    """Review of #1231, rounds 2 and 3: one cited claim and one next step the net catches."""

    def test_one_cited_claim_and_one_next_step_read_high(self):
        stamps = _classes(
            "Die Brandmeldeanlage deckt alle 4 Geschoße ab [1]. Welche Brandabschnitte die Pläne zeigen, muss im "
            "Einzelnen geöffnet werden.",
            ClaimEvidence(cited_numbers=frozenset({1}), passages={1: "Die Brandmeldeanlage deckt alle 4 Geschoße ab."}),
        )
        assert [stamp.load_bearing for stamp in stamps] == [True, False]
        assert claims_ceiling(stamps) == "high"
