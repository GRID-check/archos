"""The ``look`` card and the ``look`` step: where Piloti looked, shown twice (ADR-0128).

Every look that rendered leaves a Herleitung row at once
(``turn_status.emit_look_step``): the reader sees Piloti look while it looks.
The CARD waits for the answer, because it shows only the looks the answer
relies on, and that is known once the answer is final.

## Which looks become card items

A look is held on the turn's card registry (:meth:`CardRegistry.hold`) as it
happens; ``finalize_answer`` takes them before the card suppression and places
them after it (:func:`take_looks`, :func:`place_look_cards`). The rule, by
document:

1. A document the answer CITES (a cited source's file name) and Piloti looked
   at is relied on, and only those: a look the answer moved past stays a
   Herleitung row. A value read off a drawing is cited with the `[N]` of the
   look's place (``place.py``), so an answer that states one cites the document.
   An answer that cites none of the looked documents makes no card: the look is
   a Herleitung step only (ADR-0125, amendment of 2026-10-22).
2. Of a relied-on document only the items that ADD evidence are kept: a look
   whose reading is empty or reports nothing found makes no item, and a whole-
   page overview is dropped when the document also has a region crop (it is
   kept when the overviews are all there is).
3. A document Piloti pointed at or highlighted (``highlight``, ``point``) is
   always shown: the gesture was made for the answer. Its ``reference`` items
   are kept; its looks follow rules 1 and 2.

All items of a kept document go on its card, in the order they happened; a
card holds :data:`MAX_LOOK_ITEMS` and a further one opens the next.

## An address, never pixels

An item names the document (its id for a workspace document), the Fassung, the
page and the region, and the browser draws the thumbnail from the document's
own preview route. A refused look holds nothing and emits nothing.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from collections.abc import Iterable
from collections.abc import Sequence
from types import SimpleNamespace
from typing import Any
from uuid import uuid4

from aiq_agent.cards.models import MAX_LOOK_ITEMS
from aiq_agent.cards.models import grid_card_adapter
from aiq_agent.cards.registry import extend_or_add
from aiq_agent.cards.registry import get_card_registry
from aiq_agent.common.page_region_words import where_on_the_page
from aiq_agent.common.turn_status import emit_look_step

logger = logging.getLogger(__name__)

CARD_TYPE = "look"
#: The kind the entries are held under on the card registry.
HELD = "look"


def _key(name: str | None) -> str:
    return unicodedata.normalize("NFC", name or "").strip().casefold()


def _document_key(document: dict[str, Any]) -> str:
    """One card per document: by id when it has one, else by shelf and file name."""
    if document.get("id"):
        return f"id:{document['id']}"
    return f"{document.get('shelf', 'stored')}:{_key(document.get('name'))}"


def clamp_region(region: Any) -> list[float] | None:
    """``[x, y, w, h]`` on the page, clamped onto it and rounded; None for none or for a box with no area."""
    if region is None:
        return None
    try:
        x, y, w, h = (min(1.0, max(0.0, float(share))) for share in region)
    except (TypeError, ValueError):
        return None
    w, h = min(w, 1 - x), min(h, 1 - y)
    if w <= 0 or h <= 0:
        return None
    return [round(x, 4), round(y, 4), round(w, 4), round(h, 4)]


def _where(region: list[float] | None) -> str | None:
    if region is None:
        return None
    x, y, w, h = region
    return where_on_the_page(SimpleNamespace(x=x, y=y, w=w, h=h))


def _hold(document: dict[str, Any], item: dict[str, Any], read: str = "") -> int | None:
    """Hold one entry for the answer's cards; its number in the turn, None with no card channel.

    ``read`` is everything the look read (every ``Gelesen:`` line), held beside
    the item for the claim provenance: the item keeps one short reading for the
    card, and a value from a later line must still count as read.
    """
    registry = get_card_registry()
    if registry is None:
        return None
    entry: dict[str, Any] = {"document": document, "item": item}
    if read:
        entry["read"] = read
    return registry.hold(HELD, entry)


def looked_document(resolved: Any) -> dict[str, Any]:
    """The looked-at document as the `look` step and its row name it: file name, shelf, workspace id when known."""
    target = getattr(resolved, "target", None)
    document_id = getattr(target, "document_id", None) if target is not None else None
    base = target is None and not getattr(resolved, "collection", "")
    document: dict[str, Any] = {"name": resolved.file_name, "shelf": "base" if base else "stored"}
    if document_id:
        document["id"] = document_id
    return document


def note_look(
    resolved: Any,
    page: int,
    region: Any = None,
    image_index: int | None = None,
    question: str = "",
    reading: str = "",
    revision_id: str | None = None,
    read: str = "",
) -> None:
    """Record one look that rendered: hold its card item, emit its Herleitung row. Never raises.

    ``resolved`` is ``look``'s :class:`~aiq_agent.tools.look.resolve.Resolved`.
    ``revision_id`` is the Fassung when the caller knows it; absent, the reader
    is shown the document's current Fassung. ``read`` is the whole reading
    (every line), for the claim provenance; ``reading`` is the card's short one.
    """
    try:
        document = looked_document(resolved)
        box = clamp_region(region)
        frame = "image" if image_index is not None else "page"
        item: dict[str, Any] = {
            "origin": "look",
            "page": max(1, int(page or 1)),
            "frame": frame,
            "scope": "region" if box is not None else "overview",
        }
        optional = {
            "region": box,
            "image_index": image_index,
            "revision_id": revision_id,
            "question": (question or "").strip()[:200] or None,
            "reading": (reading or "").strip()[:300] or None,
            "where": _where(box) if frame == "page" else None,
        }
        item.update({key: value for key, value in optional.items() if value is not None})
        number = _hold(document, item, read=(read or "").strip())
        if not _may_show(resolved):
            return
        emit_look_step(
            number if number is not None else uuid4().hex[:8],
            document_name=document["name"],
            document_id=document.get("id"),
            revision_id=revision_id,
            shelf=document["shelf"],
            page=item["page"],
            region=box,
            image_index=image_index,
            where=item.get("where"),
            question=item.get("question"),
            reading=item.get("reading"),
        )
    except Exception:  # noqa: BLE001 - showing a look is never worth the look
        logger.warning("A look could not be recorded for the card and the Herleitung", exc_info=True)


def _may_show(resolved: Any) -> bool:
    """Whether the look's step may carry its document: the step is emitted before the round is admitted.

    A stored step is read by everyone the conversation is shared with later, so
    a page of a restricted folder this turn has not admitted
    (:func:`~aiq_agent.knowledge.restricted_use.may_name`) leaves no step at
    all: its name, id and reading are what the admission may still refuse
    (listing is not use, ADR-0088). The held card item stays, since a card is
    placed only for a document the answer cites, which the model read after
    admission.
    """
    from aiq_agent.knowledge.restricted_use import may_name

    return may_name(getattr(resolved, "collection", "") or None)


def note_reference(
    document: dict[str, str],
    page: int,
    *,
    region: Sequence[float] | None = None,
    point: Sequence[float] | None = None,
    label: str = "",
) -> None:
    """Record a box (``highlight``) or a pointer (``point``) Piloti showed the room, as a ``reference`` item."""
    try:
        box = clamp_region(region)
        item: dict[str, Any] = {"origin": "reference", "page": max(1, int(page or 1)), "frame": "page"}
        if box is not None:
            item.update(scope="region", region=box, where=_where(box))
        elif point is not None:
            item.update(scope="point", point=[round(min(1.0, max(0.0, float(v))), 4) for v in point][:2])
        else:
            return
        if text := (label or "").strip()[:80]:
            item["label"] = text
        looked: dict[str, Any] = {"name": document.get("name") or "", "shelf": "stored"}
        if document.get("id"):
            looked["id"] = document["id"]
        _hold(looked, item)
    except Exception:  # noqa: BLE001 - showing a gesture is never worth the gesture
        logger.warning("A canvas reference could not be recorded for the look card", exc_info=True)


def take_looks() -> list[dict[str, Any]]:
    """This turn's held looks and references, taken off the registry (before anything clears it)."""
    registry = get_card_registry()
    return registry.take_held(HELD) if registry is not None else []


def _cited_names(cited: Iterable[Any]) -> set[str]:
    """The file names (basename, case-folded) of the answer's cited sources."""
    from aiq_agent.common.citation_verification import source_entry_to_wire

    names: set[str] = set()
    for source in cited:
        entry = getattr(source, "entry", source)
        try:
            file_name = source_entry_to_wire(entry).get("file_name")
        except Exception:  # noqa: BLE001 - an unreadable source names no document
            continue
        if file_name:
            names.add(_key(str(file_name).rsplit("/", 1)[-1]))
    return names


#: A reading that says it found nothing: absence is reported in the prose, not shown as evidence.
_NOTHING_FOUND_RE = re.compile(
    r"\b(?:nothing|none|not\s+(?:visible|legible|readable|shown|present|found|recognisable|recognizable)"
    r"|no\s+\w+(?:\s+\w+)?\s+(?:visible|found|shown|present|legible))\b"
    r"|\bnichts\b|\bnicht\s+(?:erkennbar|sichtbar|lesbar|vorhanden|zu\s+sehen|zu\s+erkennen|gefunden)\b"
    r"|\bkein\w*\s+(?:\w+\s+){0,2}(?:erkennbar|sichtbar|lesbar|vorhanden|gefunden)\b",
    re.IGNORECASE,
)


def reports_nothing(reading: str | None) -> bool:
    """Whether a card item's reading is empty or says the crop held nothing to read."""
    return not (reading or "").strip() or _NOTHING_FOUND_RE.search(reading or "") is not None


def _evidence(entry: dict[str, Any]) -> bool:
    return entry["item"]["origin"] == "look" and not reports_nothing(entry["item"].get("reading"))


def relied_on(held: Sequence[dict[str, Any]], cited_names: set[str]) -> list[dict[str, Any]]:
    """The held entries the answer relies on, in order (the module docstring's rules). Pure."""
    looked = {
        _document_key(e["document"]): e["document"] for e in held if e["item"]["origin"] == "look" and _evidence(e)
    }
    relied = {key for key, document in looked.items() if _key(document.get("name")) in cited_names}
    crops = {_document_key(e["document"]) for e in held if _evidence(e) and e["item"].get("scope") == "region"}
    return [
        entry
        for entry in held
        if entry["item"]["origin"] == "reference"
        or (
            _evidence(entry)
            and _document_key(entry["document"]) in relied
            and (entry["item"].get("scope") == "region" or _document_key(entry["document"]) not in crops)
        )
    ]


def relied_readings(held: Sequence[dict[str, Any]], cited: Iterable[Any] = ()) -> list[str]:
    """What the answer's looks read off the drawings, one text per look. Pure; never raises.

    The answer check reads them beside the passages (ADR-0139), and the
    ``looked-before-measurement`` score asks whether the answer repeats one.
    Unlike the cards, this does not need
    the answer to cite the look: a value stated without a ``[N]`` is still read
    off the drawing. Of the looked documents the ones the answer cites, else
    all, and every look counts, overview or crop.
    """
    try:
        looks = [e for e in held if e["item"]["origin"] == "look"]
        names = _cited_names(cited)
        mine = [e for e in looks if _key(e["document"].get("name")) in names] or looks
    except Exception:  # noqa: BLE001 - provenance is never worth the answer
        logger.warning("Could not decide which readings the answer relies on", exc_info=True)
        return []
    return [str(e.get("read") or e["item"]["reading"]) for e in mine if e.get("read") or e["item"].get("reading")]


def place_look_cards(held: Sequence[dict[str, Any]], cited: Iterable[Any] = ()) -> int:
    """Put the entries the answer relies on onto ``look`` cards; how many items landed. Never raises."""
    registry = get_card_registry()
    if registry is None or not held:
        return 0
    try:
        kept = relied_on(held, _cited_names(cited))
    except Exception:  # noqa: BLE001 - cards are an enhancement, never the answer
        logger.warning("Could not decide which looks the answer relies on", exc_info=True)
        return 0
    landed = 0
    for entry in kept:
        document, key = entry["document"], _document_key(entry["document"])

        def owns(card: dict[str, Any], key: str = key) -> bool:
            return card.get("type") == CARD_TYPE and _document_key(card.get("document") or {}) == key

        def build(items: list[dict[str, Any]], document: dict[str, Any] = document) -> dict[str, Any]:
            card = {"type": CARD_TYPE, "document": document, "items": items}
            return grid_card_adapter.validate_python(card).model_dump(exclude_none=True)

        if extend_or_add(registry, entry["item"], owns=owns, build=build, max_items=MAX_LOOK_ITEMS) is not None:
            landed += 1
    return landed


def drawing_value_status(
    held: Sequence[dict[str, Any]], content: str, cited: Iterable[Any], readings: Sequence[str] = ()
) -> tuple[bool, bool]:
    """(the answer states a value read off a drawing, a region look at that drawing came first). Pure; never raises.

    A drawing value is a reading the answer repeats, or a citation of a source
    holding a reading or a drawing region. The look comes first by
    construction (``held`` is what the turn looked at before the answer); the
    question is whether it was a REGION look at the cited document, not only an
    overview or nothing (ADR-0128, the ``looked-before-measurement`` score).
    """
    try:
        from aiq_agent.common.citation_verification import source_entry_to_wire

        drawn = [
            source.entry
            for source in cited
            if getattr(source, "number", None) is not None and (source.entry.read or source.entry.regions)
        ]
        files = [source_entry_to_wire(entry).get("file_name") for entry in drawn]
        names = {_key(str(name).rsplit("/", 1)[-1]) for name in files if name}
        text = content.casefold()
        stated = bool(drawn) or any(reading and reading.casefold() in text for reading in readings)
        if not stated:
            return False, False
        crops = [e for e in held if e["item"]["origin"] == "look" and e["item"].get("scope") == "region"]
        return True, any(not names or _key(e["document"].get("name")) in names for e in crops)
    except Exception:  # noqa: BLE001 - a score is never worth the answer
        logger.warning("Could not decide whether a drawing value was looked at", exc_info=True)
        return False, False
