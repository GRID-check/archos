"""A look at a project or office document registers a citable PLACE (ADR-0125, amendment of 2026-10-22).

A value Piloti reads off a drawing has no passage to cite. Before this module a
``[N]`` on such a sentence either laundered through an unrelated caption chunk
of the same page (classed ``cited``, able to reach "high"), was dropped
(``cited_dropped``, "low"), or was absent (``observed``, "medium"). Now the
look's result carries a grounding block with ONE hit: the file, the page, the
region box and the reading lines as the passage. The same grammar every
evidence tool answers in, so:

* a live turn reads the record by the hash of the text (``render_grounding_block``
  files it), a replayed turn reads the text (``register_source_parser`` in
  ``common/citation_verification.py``), and both produce the same source entry;
* the source chip and the citation peek draw the ``Region:`` as the place they
  already draw for a cited sheet (``regions`` on the wire).

The entry is the document's OWN kind (project, office) and never building law.
It holds the reading in ``SourceEntry.read``, not in ``chunk_text``: it is a
perception, so no quote is checked against it, and the answer check reads it as
a reading off a drawing, not a passage. It is not ``citation_grounded`` either
(``agents/piloti/answer_pipeline._ground``): a place never grounds a claim about
the law, the laundering path ``common/source_kinds.py`` describes for a
measurement. A look at the base corpus (Basiswissen, the law) registers nothing.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from aiq_agent.common.grounding_block import GroundingBlock
from aiq_agent.common.grounding_block import GroundingHit
from aiq_agent.common.grounding_block import SourceRegion
from aiq_agent.common.grounding_block import render_grounding_block
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name

TOOL = "look"


@dataclass(frozen=True)
class PlaceFacts:
    """Where a look read: enough to build the hit."""

    file_name: str
    collection: str
    shelf: Shelf
    page: int
    #: ``(x0, y0, x1, y1)`` shares of the page for a region crop of a page; None for an overview or an embedded image.
    box: tuple[float, float, float, float] | None = None


def place_facts(resolved: Any, page: int, region: Any, image_index: int | None) -> PlaceFacts | None:
    """The place a look at ``resolved`` registers; None for the base corpus or a collection of no known shelf.

    ``region`` is the rendered ``(x, y, w, h)`` or None. An embedded image's box
    is relative to the raster, whose place on the page is not stored, so it
    gets none (``SourceRegion``'s own rule): that look is not a region crop.
    """
    from .cards import clamp_region

    collection = (getattr(resolved, "collection", "") or "").strip()
    if not collection:
        return None
    shelf = legacy_shelf_for_collection_name(collection)
    if shelf is None or shelf == Shelf.BASE:
        return None
    box = clamp_region(region) if image_index is None else None
    corners = (box[0], box[1], round(box[0] + box[2], 4), round(box[1] + box[3], 4)) if box is not None else None
    return PlaceFacts(resolved.file_name, collection, shelf, max(1, int(page or 1)), corners)


def citation_key(facts: PlaceFacts) -> str:
    return f"{facts.file_name}, p.{facts.page}"


def render_place(facts: PlaceFacts, preamble: str, reading_rows: str) -> str:
    """The look's text block as a grounding block: ``preamble`` for the model, one hit holding the reading.

    The whole text IS the rendering, so a live turn finds the record under its
    hash. The result of ``look`` is this text plus the image block.
    """
    hit = GroundingHit(
        citation_key=citation_key(facts),
        file_name=facts.file_name,
        page=facts.page,
        shelf=facts.shelf,
        collection=facts.collection,
        doc_class=None,
        display_title=facts.file_name,
        folder_path=None,
        clause=None,
        score=1.0,
        content_type="drawing",
        provenance=None,
        stored_image_index=None,
        status_note=None,
        body=reading_rows,
        regions=(SourceRegion(box=facts.box),) if facts.box is not None else (),
    )
    block = GroundingBlock(preamble=preamble, degraded_banner="", hits=(hit,), lanes=(), tool=TOOL)
    return render_grounding_block(block)
