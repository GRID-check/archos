"""The family overview: every Fassung-free member of a Richtlinie family, read in turn, and the trailer that says
which members the corpus lacks or could not read.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from .read_passage_fetch import _fetch_query
from .read_passage_models import PassageTarget
from .read_passage_outline import _MAX_OUTLINE_LINES
from .read_passage_outline import _OUTLINE_INSTRUCTION
from .read_passage_outline import OutlineEntry
from .read_passage_outline import _outline_lines
from .read_passage_outline import _scope_chunks
from .read_passage_outline import outline_for
from .read_passage_targets import _documents_in

# Logs under the name read_passage always had, so a filter on that name still catches these records.
logger = logging.getLogger("knowledge_layer.read_passage")

#: How many scope passages ONE member contributes. The scope of a Richtlinie is
#: its Punkt 0, which arrives as one chunk in the corpus and as a handful when
#: ``SentenceSplitter`` cut it; two is the opening of the longest of them.
_MAX_FAMILY_SCOPE_CHUNKS = 2


@dataclass(frozen=True)
class FamilyMember:
    """One part of a Richtlinie, read: its scope passage and its Gliederung."""

    number: str
    title: str
    chunks: tuple[Any, ...]
    entries: tuple[OutlineEntry, ...]
    #: Read by filter alone, with no embedding (``BaseRetriever.fetch``).
    structural: bool = False


@dataclass(frozen=True)
class FamilyOverview:
    """Every part of one Richtlinie the corpus holds, ready to be rendered.

    ``chunks`` are the scope passages in member order, which the search puts
    ahead of its own hits so a citation resolves to each part; ``trailer`` is
    the one block of Gliederungen that follows the fan-out (ADR-0061: a
    decoration travels inside the block or the reader loses the records).
    """

    label: str
    members: tuple[FamilyMember, ...]
    chunks: tuple[Any, ...]
    trailer: str
    #: Every member was read by filter alone, with no embedding.
    structural: bool = False

    @property
    def opened_files(self) -> frozenset[str]:
        """The documents this overview OPENED: every member's file, read as ``read_passage`` reads it."""
        return frozenset(chunk.file_name for chunk in self.chunks if getattr(chunk, "file_name", None))

    @property
    def preamble(self) -> str:
        """What the family IS, above the results: the parts, where they are, and that they are open."""
        numbers = ", ".join(member.number for member in self.members)
        count = f"{len(self.members)} part" if len(self.members) == 1 else f"{len(self.members)} parts"
        span = "Result 1 is" if len(self.chunks) == 1 else f"Results 1 to {len(self.chunks)} are"
        return (
            f"{self.label}: {count} in the corpus ({numbers}).\n"
            f"{span} the Geltungsbereich of these parts, their Gliederungen are below; "
            "the results for the query follow.\n"
            "These parts are therefore open at the level a read of one document opens it at; "
            "deeper goes only a single Punkt from a Gliederung, as described below."
        )


class FamilyUnreadable(RuntimeError):
    """The corpus lists the family, and not one of its parts could be read.

    Distinct from ``None``, which is "no such family here": a listed family
    that yields nothing is an overview that was attempted and lost, and the
    search that asked for it has to say so rather than look like an ordinary
    two-document search.
    """


def _family_trailer(members: Sequence[FamilyMember]) -> str:
    """One ``## Gliederung`` section per member, and the instruction once.

    The instruction says what a Gliederung is and is not, and that holds for
    all of them, so it is stated once at the end rather than after each.

    The single-document line budget is SPLIT across the members: four of them
    at 80 lines each is 4 to 6k tokens of index framing far less evidence.
    With the depth-2 headings already dropped (:func:`_read_member`), a member
    of a four-part family prints its 20 top-level Punkte.
    """
    budget = max(1, _MAX_OUTLINE_LINES // max(1, len(members)))
    lines: list[str] = []
    for member in members:
        lines += [f"## Gliederung {member.title}", *_outline_lines(member.entries, budget), ""]
    return "\n".join([*lines, _OUTLINE_INSTRUCTION, ""])


def _member_title(file_name: str) -> str:
    """What a member is called in its Gliederung heading.

    The derived OIB title, which is what a citation chip prints and what
    :func:`_matches` accepts back as ``document=``, so the heading doubles as
    the argument for opening one of its Punkte.
    """
    from agent.common.norm_registry import guess_display_title

    try:
        return guess_display_title(file_name) or file_name
    except Exception:  # noqa: BLE001 — a missing title helper must not hide the file
        return file_name


async def _corpus_families(base: Any) -> list[Any]:
    """The Richtlinien-Familien the BASE shelf holds, from whichever source knows.

    Three sources, cheapest first. The turn's own family list is derived from
    the base shelf before the inventory cap can drop a member, so it is the one
    that is always complete. The inventory rows answer a turn that bound no
    list, and the collection's registered documents answer a run with no turn
    around it at all.
    """
    from agent.common.norm_registry import oib_families
    from agent.common.source_kinds import Shelf

    try:
        from agent.knowledge.inventory import get_norm_families
        from agent.knowledge.inventory import get_turn_documents

        families = list(get_norm_families())
        if families:
            return families
        rows = [
            str(getattr(row, "file_name", "") or "")
            for row in get_turn_documents()
            if str(getattr(row, "shelf", "") or "") == str(Shelf.BASE)
        ]
        if rows:
            return oib_families(rows)
    except Exception:  # noqa: BLE001 — no turn bound is a valid standalone run
        logger.debug("No turn inventory for the family lookup", exc_info=True)
    documents = await _documents_in(base.collection)
    return oib_families(str(getattr(document, "file_name", "") or "") for document in documents)


async def _read_member(target: PassageTarget, number: str) -> FamilyMember | None:
    """One member, read as an outline. ``None`` when the store holds none of it.

    That miss is how a family stays honest about the corpus: a member the
    deployment does not carry contributes no passage, no Gliederung and no
    line in the preamble.
    """
    outline = await outline_for([target], _fetch_query(target.file_name, None, None))
    if not outline.chunks:
        if outline.failures:
            logger.warning("Family member %s could not be read", target.file_name, exc_info=outline.failures[0])
        return None
    return FamilyMember(
        number=number,
        title=_member_title(target.file_name),
        chunks=tuple(_scope_chunks(outline.chunks)[:_MAX_FAMILY_SCOPE_CHUNKS]),
        entries=tuple(entry for entry in outline.entries if entry.depth == 1),
        structural=outline.structural,
    )


async def family_overview(entries: Sequence[Any], family_key: str) -> FamilyOverview | None:
    """Every part of Richtlinie ``family_key`` the corpus holds, in one object.

    ``entries`` is the turn's collection scope; the corpus is the base shelf,
    so a turn that may not read it gets ``None`` rather than an overview of
    somebody's own copy of a Richtlinie. ``None`` also when the corpus holds no
    such family. A family it does hold, of which no member could be read,
    raises :class:`FamilyUnreadable`.
    """
    from agent.common.source_kinds import Shelf

    base = next((entry for entry in entries if getattr(entry, "shelf", None) is Shelf.BASE), None)
    if base is None:
        return None
    family = next((item for item in await _corpus_families(base) if item.key == family_key), None)
    if family is None:
        return None
    read = await asyncio.gather(
        *(
            _read_member(PassageTarget(base.collection, file_name, str(base.shelf)), number)
            for number, file_name in zip(family.members, family.files, strict=True)
        ),
        return_exceptions=True,
    )
    for failure in (item for item in read if isinstance(item, BaseException)):
        logger.warning("Family member skipped", exc_info=failure)
    members = tuple(item for item in read if isinstance(item, FamilyMember))
    if not members:
        raise FamilyUnreadable(f"no part of {family.label} could be read")
    chunks = tuple(chunk for member in members for chunk in member.chunks)
    logger.info("Family overview: %s read %d member(s)", family.label, len(members))
    return FamilyOverview(
        label=family.label,
        members=members,
        chunks=chunks,
        trailer=_family_trailer(members),
        structural=all(member.structural for member in members),
    )
