"""Every look the reader can see (ADR-0128): a Herleitung step at once, a card item once the answer is final.

``look`` runs for real against a one-page PDF (the fakes of ``test_register.py``);
the step is read off the turn's stream, the card off the bound card registry.
Which looks the answer keeps is the rule in ``tools/look/cards.py``: the cited
looked-at documents only (a look the answer moved past, or cites nothing of, is a
Herleitung step), of them the items that read something and the region crops
(an overview only when it is all there is), and every box or pointer Piloti
showed the room.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest
from agent_testing.canvas import DOCUMENT
from agent_testing.canvas import answering
from agent_testing.look import room  # noqa: F401 - autouse: the canvas route answers
from agent_testing.look import stored  # noqa: F401 - fixture, used by `pytestmark`

from aiq_agent.common import image_view_budget
from aiq_agent.common import turn_status
from aiq_agent.common.focus_file import set_turn_intent
from aiq_agent.common.wire_v2 import LookStep
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.tools.canvas.register import run_highlight
from aiq_agent.tools.canvas.register import run_point
from aiq_agent.tools.look.cards import place_look_cards
from aiq_agent.tools.look.cards import relied_on
from aiq_agent.tools.look.cards import take_looks
from aiq_agent.tools.look.register import run_look

OG = "22222222-0000-4000-8000-000000000002"

#: Every look here renders a real one-page PDF the faked store hands back.
pytestmark = pytest.mark.usefixtures("stored")


@pytest.fixture
def steps(monkeypatch) -> list[LookStep]:
    """The look steps the turn emitted, in order."""
    seen: list[LookStep] = []

    def capture(body) -> None:
        if isinstance(body, StepFinishedBody) and isinstance(body.step, LookStep):
            seen.append(body.step)

    monkeypatch.setattr(turn_status, "emit", capture)
    return seen


@pytest.fixture(autouse=True)
def budget():
    token = image_view_budget.begin_image_view_budget()
    yield
    image_view_budget.end_image_view_budget(token)


@dataclass
class _Cited:
    entry: object
    number: int = 1


def _cited(*file_names: str) -> list:
    from aiq_agent.common.citation_verification import SourceEntry

    return [_Cited(SourceEntry(citation_key=f"{name}, p.1", source_type="knowledge_layer")) for name in file_names]


def _read(held: list[dict], text: str = "Gangbreite 1,10 m") -> list[dict]:
    """The held looks as if the second reader had read ``text`` at each."""
    for entry in held:
        if entry["item"]["origin"] == "look":
            entry["item"]["reading"] = text
    return held


def _looks(registry) -> list[dict]:
    return [card for card in registry.snapshot() if card["type"] == "look"]


class TestALookIsSeen:
    async def test_two_looks_at_one_document_are_two_steps_and_one_card_of_two_items(self, registry, steps) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look(page=1)
        await run_look(page=1, region=[0.7, 0.05, 0.25, 0.2])

        assert [step.id for step in steps] == ["look:1", "look:2"]
        assert steps[1].model_dump(exclude_none=True) | {} == {
            "id": "look:2",
            "kind": "look",
            "scope": "chat",
            "document_name": "Grundriss_EG.pdf",
            "document_id": DOCUMENT,
            "shelf": "stored",
            "page": 1,
            "region": [0.7, 0.05, 0.25, 0.2],
            "where": "oben rechts",
        }
        assert _looks(registry) == []  # the card waits for the answer

        # The overview is dropped: the document has a region crop that reads.
        assert place_look_cards(_read(take_looks()), _cited("Grundriss_EG.pdf")) == 1
        [card] = _looks(registry)
        assert card["document"] == {"id": DOCUMENT, "name": "Grundriss_EG.pdf", "shelf": "stored"}
        assert [item["scope"] for item in card["items"]] == ["region"]
        assert card["items"][0]["where"] == "oben rechts"

    async def test_a_look_records_the_revision_it_read(self, registry, steps, monkeypatch) -> None:
        """The card and the step name the version whose bytes were rendered, so a newer Fassung never redraws them."""
        import knowledge_layer.view_image as view

        async def locate(collection, file_name, organization_id=None, image_index=None):
            return view.StorageLocation("key", None, "version-7") if collection == "proj_1" else None

        monkeypatch.setattr(view, "_resolve_storage_location", locate)
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look(page=1, region=[0.1, 0.1, 0.3, 0.2])

        assert [step.revision_id for step in steps] == ["version-7"]
        place_look_cards(_read(take_looks()), _cited("Grundriss_EG.pdf"))
        [card] = _looks(registry)
        assert [item.get("revision_id") for item in card["items"]] == ["version-7"]

    async def test_a_refused_look_leaves_neither_step_nor_card(self, registry, steps) -> None:
        result = await run_look("Grundriss", page=1)  # two files: a question, not a look

        assert isinstance(result, str)
        assert steps == [] and take_looks() == []

    async def test_with_no_card_channel_the_step_is_still_emitted(self, steps) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

        await run_look(page=1)

        assert len(steps) == 1 and steps[0].id.startswith("look:")


class TestAGestureIsSeen:
    async def test_a_highlight_adds_a_reference_item_to_the_documents_card(self, registry, monkeypatch, calls) -> None:
        set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)
        await run_look(page=1)
        answering(monkeypatch, calls, {"ok": True, "documentId": DOCUMENT, "documentName": "Grundriss_EG.pdf"})

        await run_highlight(1, 0.9, 0.2, 0.11, 0.1, "Hier: Fluchtweg 1,10 m")
        await run_point(1, 0.3, 0.6)

        place_look_cards(_read(take_looks()), _cited("Grundriss_EG.pdf"))
        [card] = _looks(registry)
        assert [item["origin"] for item in card["items"]] == ["look", "reference", "reference"]
        highlight, point = card["items"][1:]
        assert highlight["label"] == "Hier: Fluchtweg 1,10 m" and highlight["region"] == [0.9, 0.2, 0.1, 0.1]
        assert point["scope"] == "point" and point["point"] == [0.3, 0.6]

    async def test_a_refused_highlight_adds_nothing(self, registry, monkeypatch, calls) -> None:
        answering(monkeypatch, calls, RuntimeError("no route"))

        with pytest.raises(RuntimeError):
            await run_highlight(1, 0.1, 0.1, 0.2, 0.2, "Hier")

        assert take_looks() == []


def _held(
    name: str,
    origin: str = "look",
    document_id: str | None = None,
    scope: str | None = None,
    reading: str | None = None,
) -> dict:
    document = {"name": name, "shelf": "stored", **({"id": document_id} if document_id else {})}
    scope = scope or ("overview" if origin == "look" else "point")
    item = {"origin": origin, "page": 1, "frame": "page", "scope": scope}
    if origin != "look":
        item["point"] = [0.5, 0.5]
    elif scope == "region":
        item["region"] = [0.1, 0.1, 0.3, 0.2]
    if origin == "look" and reading is not None:
        item["reading"] = reading
    return {"document": document, "item": item}


def _crop(name: str, document_id: str | None = None, reading: str = "Gangbreite 1,10 m") -> dict:
    return _held(name, document_id=document_id, scope="region", reading=reading)


class TestWhichLooksTheAnswerKeeps:
    def test_only_the_cited_documents_when_the_answer_cites_one_it_looked_at(self) -> None:
        held = [_crop("Grundriss_EG.pdf"), _crop("Schnitt A-A.pdf"), _crop("Grundriss_EG.pdf")]

        kept = relied_on(held, {"grundriss_eg.pdf"})

        assert [entry["document"]["name"] for entry in kept] == ["Grundriss_EG.pdf", "Grundriss_EG.pdf"]

    def test_no_card_when_the_answer_cites_none_of_the_documents_it_looked_at(self) -> None:
        """The look stays a Herleitung step: an answer that does not cite the drawing does not rest on it."""
        held = [_crop("Grundriss_EG.pdf"), _crop("Schnitt A-A.pdf")]

        assert relied_on(held, {"oib-rl4.pdf"}) == []
        assert relied_on(held, set()) == []

    def test_a_look_that_read_nothing_makes_no_item(self) -> None:
        for reading in (None, "", "Nothing legible in this crop.", "Keine Türen erkennbar."):
            held = [_held("Grundriss_EG.pdf", scope="region", reading=reading)]

            assert relied_on(held, {"grundriss_eg.pdf"}) == [], reading

    def test_an_overview_is_dropped_when_the_document_has_a_region_crop(self) -> None:
        overview = _held("Grundriss_EG.pdf", reading="Grundriss EG, Massstab 1:100")
        crop = _crop("Grundriss_EG.pdf")

        assert relied_on([overview, crop], {"grundriss_eg.pdf"}) == [crop]

    def test_an_overview_is_kept_when_it_is_all_the_document_has(self) -> None:
        overview = _held("Grundriss_EG.pdf", reading="Grundriss EG, Massstab 1:100")

        assert relied_on([overview], {"grundriss_eg.pdf"}) == [overview]

    def test_a_gesture_is_always_kept(self) -> None:
        held = [_crop("Grundriss_EG.pdf"), _crop("Schnitt A-A.pdf"), _held("Lageplan.pdf", origin="reference")]

        kept = relied_on(held, {"grundriss_eg.pdf"})

        assert [entry["document"]["name"] for entry in kept] == ["Grundriss_EG.pdf", "Lageplan.pdf"]

    def test_the_rule_reads_the_answers_cited_file_names(self, registry) -> None:
        held = [_crop("Grundriss_EG.pdf", document_id=DOCUMENT), _crop("Grundriss_OG.pdf", document_id=OG)]

        place_look_cards(held, _cited("Grundriss_OG.pdf", "OIB-RL4.pdf"))

        assert [card["document"]["name"] for card in _looks(registry)] == ["Grundriss_OG.pdf"]

    def test_a_full_card_opens_the_next_and_no_card_moves(self, registry) -> None:
        registry.add({"type": "calculation", "title": "x"})
        held = [_crop("Grundriss_EG.pdf", document_id=DOCUMENT)] * 13

        assert place_look_cards(held, _cited("Grundriss_EG.pdf")) == 13

        cards = registry.snapshot()
        assert cards[0]["type"] == "calculation"
        assert [len(card["items"]) for card in cards[1:]] == [12, 1]


async def test_a_reading_rides_on_the_card_item(monkeypatch):
    """With a question, the reading the vision model gave is kept for the card, not only sent to the chat model."""
    from aiq_agent.tools.look import register as look_register
    from aiq_agent.tools.look.reading import Reading
    from aiq_agent.tools.look.reading import ReadingLine

    async def fake_read(_jpeg, _question, region=False):
        return Reading(lines=(ReadingLine(text="Gangbreite 1,10 m", kind="dimension", confidence="high"),))

    monkeypatch.setattr("aiq_agent.tools.look.reading.read_region", fake_read)

    class _View:
        text = "Page 1"
        jpeg = b"x"

        def blocks(self):
            return [{"type": "text", "text": self.text}]

        def with_text(self, text):
            view = _View()
            view.text = text
            return view

    blocks, reading, _ = await look_register._blocks_for(_View(), "Wie breit ist der Gang?", True, [0, 0, 1, 1])
    assert reading == "Gangbreite 1,10 m"
    assert "Gangbreite 1,10 m" in blocks[0]["text"]
    _, none, nothing = await look_register._blocks_for(_View(), "", True, None)
    assert none == "" and nothing == ""


async def test_every_line_a_look_read_counts_for_the_provenance_not_only_the_cards_one(registry, monkeypatch):
    """The card keeps the summary; a value on a later ``Gelesen:`` line must still be ``observed``."""
    from aiq_agent.tools.look.cards import relied_readings
    from aiq_agent.tools.look.reading import Reading
    from aiq_agent.tools.look.reading import ReadingLine

    async def fake_read(_jpeg, _question, region=False):
        return Reading(
            lines=(
                ReadingLine(text="Raum 1.04", kind="label", confidence="high"),
                ReadingLine(text="Raumhöhe 2,70 m", kind="dimension", confidence="high"),
            ),
            summary="Ein Raum mit Höhenkote.",
        )

    monkeypatch.setattr("aiq_agent.tools.look.reading.read_region", fake_read)
    set_turn_intent(file_name="Grundriss_EG.pdf", document_id=DOCUMENT)

    await run_look(page=1, region=[0.1, 0.1, 0.3, 0.2], question="Wie hoch ist der Raum?")

    held = take_looks()
    # The line carrying the measured value comes before the one-sentence summary.
    assert held[0]["item"]["reading"] == "Raum 1.04; Raumhöhe 2,70 m"
    [read] = relied_readings(held)
    assert "Raumhöhe 2,70 m" in read
