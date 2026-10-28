"""The family branch: a query that names a Richtlinie reads every member of its family beside the ranked search."""

import logging
from dataclasses import dataclass
from typing import Any

logger = logging.getLogger(__name__)


#: The one line the model reads when the overview raised. Without it a family
#: question answered by ranked passages is indistinguishable from an ordinary
#: two-document search, in the result and in the Herleitung built from it. It
#: names the way back rather than an instruction: the parts are still readable,
#: one call each.
FAMILY_OVERVIEW_FAILED_NOTICE = (
    "Note: the overview of the parts of OIB-Richtlinie {key} could not be built; only the ranked results "
    "follow, and each part opens on its own by its file name.\n\n"
)


@dataclass(frozen=True, slots=True)
class _FamilyBranch:
    """What the family branch produced: an overview, or the fact that it broke.

    "This query names no family the corpus holds" and "the overview raised"
    both used to arrive as ``None``, so the tool result could not say which had
    happened, and neither could a trace of it.
    """

    overview: Any = None
    failed: bool = False


#: No family branch ran: an ordinary search, with nothing to say about one.
NO_FAMILY_BRANCH = _FamilyBranch()


#: Ranked passages kept BESIDE a family overview. The overview already opens
#: every part at its Geltungsbereich and lists its Gliederung; the ranked
#: search around it is context, not the answer. Measured on „Was weißt du über
#: die OIB 2?" (2026-09-23, live): with the full sixteen, the block was 25.5k
#: characters (~7.4k tokens), half of it Leitfaden and Erläuterungen excerpts
#: that an overview answer never cites, re-sent on every later call of the turn.
FAMILY_RANKED_HITS = 4


async def family_branch(entries, family_key: str) -> _FamilyBranch:
    """The family branch, fail-open: a broken overview keeps the ordinary search.

    Imported here rather than at module scope because ``read_passage`` imports
    this module back; both directions are function-scoped, so neither package
    can be half-initialised by the other.
    """
    from .read_passage import FamilyUnreadable
    from .read_passage import family_overview

    try:
        return _FamilyBranch(overview=await family_overview(entries, family_key))
    except FamilyUnreadable as exc:
        logger.warning("Family overview skipped for Richtlinie %s: %s", family_key, exc)
        return _FamilyBranch(failed=True)
    except Exception:  # noqa: BLE001 — the ranked passages are always a valid answer
        logger.warning("Family overview skipped for Richtlinie %s", family_key, exc_info=True)
        return _FamilyBranch(failed=True)


def without_chunks(chunks, exclude) -> list:
    """``chunks`` minus every chunk ``exclude`` already carries, by chunk id.

    A scope passage the search ALSO ranked is one passage, and rendering it
    twice would spend a result slot on a repeat and offer the model two
    citation keys for one text.
    """
    taken = {getattr(chunk, "chunk_id", None) for chunk in exclude}
    taken.discard(None)
    return [chunk for chunk in chunks if getattr(chunk, "chunk_id", None) not in taken]
