"""``look``: a page of a document, a region of it, or an embedded image, as an image the model sees.

One tool for one act in every context (ADR-0128): the chat, the review canvas,
``piloti-ask`` and deep research bind it, and the external door serves it as
``document-look``. It replaced two tools that were the same function under two
names and two argument shapes, the canvas group's ``canvas__look`` and the
knowledge layer's ``view_knowledge_image``.

What ``look`` decides is WHICH file, and from which collection
(``resolve.py``); the model never passes a collection. The render, the scope
check, the per-turn budget, the vision gate and the restricted-folder report are
the renderer's (``knowledge_layer.view_image.view_image``), unchanged. When the
document is a workspace document, everyone who has it open sees the box glow
while Piloti reads (``canvas/presence.show_reading``), whether the question came
from the canvas or the chat; only a chat turn glows, because only its harness
takes the glow down again.

With a ``question`` the crop is also read by the office's vision model
(``reading.py``) and the readings come back as short ``Gelesen:`` lines, labelled
as a reading of the drawing and never a measurement. A chat model that takes no
images gets those lines alone instead of "I cannot see".

Its own entry point (``aiq_look`` in the root ``pyproject.toml``): a deployment
without the canvas group keeps ``look``, and the reverse.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from pydantic import Field

from aiq_agent.common.image_view_budget import MAX_IMAGE_VIEWS_PER_TURN
from aiq_agent.common.image_view_budget import MAX_OVERVIEW_VIEWS_PER_TURN
from aiq_agent.common.turn_status import ActionRow
from aiq_agent.observability.retrieval_trace import emit_step_span
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from ..canvas.calls import Refused
from ..canvas.presence import current_canvas_presence
from ..canvas.presence import show_reading
from .cards import looked_document
from .cards import note_look
from .place import PlaceFacts
from .place import place_facts
from .place import render_place
from .resolve import Resolved
from .resolve import resolve_document

logger = logging.getLogger(__name__)

#: The name the model calls, and the name every refusal carries.
TOOL = "look"


def _default_max_dim() -> int:
    from knowledge_layer.view_image import default_max_dim

    return default_max_dim()


DESCRIPTION = (
    "Shows you a page of a document as an image; with `region=[x, y, w, h]` only that box, sharper. "
    "`document`: the file name from the inventory or from a hit's `Citation:` line, or a document id; empty means "
    "the document open on the canvas, then this chat's document. `page` starts at 1. `region` is shares of the "
    "page as shown: 0 to 1, origin top left, never pixels. `image_index` shows the embedded image a hit's "
    "`Image:` line names, at its own resolution; a hit's `Region:` line gives the numbers for the place it sits. "
    "Where something lies on a sheet is read off the image, not off the text. "
    "`question` (optional): a second reader, the office's vision model, answers it from the same crop as short "
    "lines starting `Gelesen:`, a reading of the drawing and never a measurement; a reading does not cost a "
    "look. A look's result carries its `[N]` to cite. A look that finds nothing is reported as absence in the "
    f"prose, not shown as a card. At most {MAX_IMAGE_VIEWS_PER_TURN} looks per turn, at most "
    f"{MAX_OVERVIEW_VIEWS_PER_TURN} of them whole pages; every result says how many are left. Fails open with a "
    "sentence saying why."
)


class LookToolConfig(FunctionBaseConfig, name="look"):
    """Configuration for ``look``."""

    max_dim: int = Field(
        default_factory=_default_max_dim,
        description="Long edge (px) of what `look` renders; higher is sharper, larger payloads.",
    )
    timeout: float = Field(default=30.0, description="Render timeout of `look`, in seconds.")


def _may_glow(resolved: Resolved) -> bool:
    """Whether the room sees this look: a workspace document, on a turn whose harness takes the glow down.

    Only a chat turn binds the canvas presence record and sends ``leave`` once
    its answer is out (``canvas/presence.leave_canvas``). A look from the agent
    door or a background run has no such end, so a glow it sent would stay.
    """
    return resolved.target is not None and resolved.signed is not None and current_canvas_presence() is not None


def _observe(
    document: str, page: int, region: Any, image_index: Any, result: Any, resolved: Any, *, asked: bool = False
) -> None:
    """One ``look`` observation: what was asked and whether an image came back. Never the bytes."""
    emit_step_span(
        TOOL,
        {
            "page": page,
            "region": region is not None,
            "image_index": image_index is not None,
            "named": bool((document or "").strip()),
            "question": asked,
        },
        {
            "viewed": isinstance(result, list),
            "workspace": isinstance(resolved, Resolved) and resolved.target is not None,
        },
    )


async def _blocks_for(
    view: Any, question: str, sees: bool | None, region: Any, place: PlaceFacts | None = None
) -> tuple[list[dict], str, str]:
    """What the model gets for a rendered look, the reading the card keeps, and everything read.

    The blocks are the region text, the readings it asked for, and the image if
    it sees. A model that takes no images is never sent one (the next model call
    of the turn would be refused): it gets the readings alone, answering
    :data:`DEFAULT_QUESTION` when it asked nothing. The second value is the
    reading for the card item: the line(s) carrying the measured value before
    the one-sentence summary (:func:`~.reading.card_reading`); empty without one.
    The third is every reading line and the summary, for the claim provenance.

    With a ``place`` (a project or office document) and a usable reading, the
    text block is a grounding block whose one hit holds the reading, so the
    model can cite the look with ``[N]`` (``place.py``).
    """
    from .reading import DEFAULT_QUESTION
    from .reading import card_reading
    from .reading import read_region
    from .reading import render_readings
    from .reading import render_readings_parts

    blind = sees is False
    question = question.strip() or (DEFAULT_QUESTION if blind else "")
    if not question:
        return view.blocks(), "", ""
    reading = await read_region(view.jpeg, question, region=region is not None)
    if place is not None and reading.usable:
        head, rows = render_readings_parts(reading, blind=blind)
        text = render_place(place, f"{view.text}\n\n{head}", rows)
    else:
        text = f"{view.text}\n\n{render_readings(reading, blind=blind)}"
    blocks = view.with_text(text).blocks()
    kept = card_reading(reading)
    read = "\n".join([*(line.text for line in reading.lines), reading.summary]).strip() if reading.usable else ""
    return (blocks[:1] if blind else blocks), kept, read


async def run_look(
    document: str = "",
    page: int = 1,
    region: list[float] | None = None,
    image_index: int | None = None,
    question: str = "",
    *,
    limits: Any = None,
) -> list[dict] | str:
    """Look at a page of ``document``, at the box ``region`` on it, or at its embedded image ``image_index``.

    With ``question`` the crop is also read by the office's vision model and the
    readings come back with it. One look either way: the budget counts the render.
    The call is one Herleitung row (ADR-0132), beside the ``look`` step that
    carries the crop.
    """
    row = ActionRow("look", target=(document or "").strip(), pages=str(page))
    try:
        result, resolved = await _run_look(document, page, region, image_index, question, limits=limits)
    except BaseException:
        row.finish("error")
        raise
    row.finish("ok" if isinstance(result, list) else "error", **_row_document(resolved))
    return result


def _row_document(resolved: Resolved | str | None) -> dict[str, str]:
    """The document a look's row names: the file and its workspace id, once the model may be told them.

    The row settles before the round's results are admitted, so a file only an
    unadmitted restricted folder holds keeps the name the model asked for
    (listing is not use, ADR-0088). The name is the one the ``look`` step
    carries, so the row finds its crop.
    """
    from aiq_agent.knowledge.restricted_use import may_name

    if not isinstance(resolved, Resolved) or not may_name(resolved.collection):
        return {}
    document = looked_document(resolved)
    return {"target": document["name"], **({"document_id": document["id"]} if document.get("id") else {})}


async def _run_look(
    document: str,
    page: int,
    region: list[float] | None,
    image_index: int | None,
    question: str,
    *,
    limits: Any,
) -> tuple[list[dict] | str, Resolved | str | None]:
    """:func:`run_look`'s work: the result, and the document it resolved (or the refusal, or nothing)."""
    from knowledge_layer.view_image import View
    from knowledge_layer.view_image import render_view
    from knowledge_layer.view_image import turn_sees

    resolved: Resolved | str | None = None
    try:
        resolved = await resolve_document(document)
        if isinstance(resolved, str):
            result: list[dict] | str = resolved
        else:
            render = render_view(
                resolved.file_name, page, resolved.collection, image_index, region, limits=limits, tool=TOOL
            )
            if _may_glow(resolved):
                # Telling the room and reading are independent: the glow costs the look no round trip.
                _, rendered = await asyncio.gather(
                    show_reading(resolved.target.body(), resolved.target.document_id, resolved.signed, page, region),
                    render,
                )
            else:
                rendered = await render
            if isinstance(rendered, View):
                place = place_facts(resolved, page, rendered.region, image_index)
                result, reading, read = await _blocks_for(rendered, question or "", await turn_sees(), region, place)
                # The Herleitung row now, the card item once the answer is final (`cards.py`).
                note_look(
                    resolved,
                    page,
                    rendered.region,
                    image_index,
                    question,
                    reading=reading,
                    read=read,
                    # The Fassung read, so the card keeps showing these bytes after a newer one lands.
                    revision_id=rendered.version_id,
                )
            else:
                result = rendered
    except Refused as refused:
        result = refused.message
    _observe(document, page, region, image_index, result, resolved, asked=bool((question or "").strip()))
    return result, resolved


@register_function(config_type=LookToolConfig)
async def look(config: LookToolConfig, _builder: Builder):
    """NAT function: ``look``, bound to the chat agent and deep research."""
    from knowledge_layer.view_image import ViewLimits

    limits = ViewLimits(max_dim=config.max_dim, timeout=config.timeout)

    async def _look(
        document: str = "",
        page: int = 1,
        region: list[float] | None = None,
        image_index: int | None = None,
        question: str = "",
    ) -> list[dict] | str:
        return await run_look(document, page, region, image_index, question, limits=limits)

    yield FunctionInfo.from_fn(_look, description=DESCRIPTION)
