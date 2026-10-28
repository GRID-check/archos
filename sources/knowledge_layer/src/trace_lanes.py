"""The lanes a knowledge search shows in the Herleitung: one per shelf and source it read."""

import logging
from contextlib import nullcontext

from knowledge_layer.grounding_hits import grounding_hit
from knowledge_layer.hit_metadata import resolve_display_titles
from knowledge_layer.hit_metadata import resolve_doc_classes

from aiq_agent.common.wire_v2 import TraceLane
from aiq_agent.common.wire_v2 import TraceLaneSource

logger = logging.getLogger(__name__)


def _trace_lanes_for_chunks(
    chunks,
    resolved: dict[tuple[str, str], str] | None = None,
    resolved_titles: dict[tuple[str, str], str] | None = None,
) -> tuple[TraceLane, ...]:
    """The lane fan-out of raw chunks, for a producer that has no records yet (RIS).

    It turns the chunks into the same
    :class:`~aiq_agent.common.grounding_block.GroundingHit` records the header
    lines are rendered from and hands them to :func:`trace_lanes_for_hits`, so
    a hit's shelf, Dokumentart and title are derived once (ADR-0061).
    ``resolved`` and ``resolved_titles`` are the store-authoritative doc_class
    and display-title maps; when omitted they are computed here.
    """
    if resolved is None:
        resolved = resolve_doc_classes(chunks)
    if resolved_titles is None:
        resolved_titles = resolve_display_titles(chunks)
    hits = [
        grounding_hit(
            chunk,
            resolved=resolved,
            resolved_titles=resolved_titles,
            # Neither reaches the fan-out: it names documents by raw
            # filename, so no citation key is built and no folder is read.
            resolved_folders={},
            ambiguous=set(),
        )
        for chunk in chunks
    ]
    return trace_lanes_for_hits(hits)


def trace_lanes_for_hits(hits, opened_files: frozenset[str] = frozenset()) -> tuple[TraceLane, ...]:
    """The lane fan-out of a result set, as typed lanes (the chat wire's ``sources`` step).

    Each lane carries BOTH classifications the reader needs: the fine ``key``
    /``label`` from ``lane_for_hit`` (the authority sub-tier: OIB-Richtlinie
    vs. Rechtsquelle (RIS) vs. …) and the coarse ``kind`` from
    :func:`~aiq_agent.common.source_kinds.kind_for_lane`, the same taxonomy
    ``source_entry_to_wire`` puts on every citation (ADR-0026), so the fan-out
    and the "Belegt durch" chips cannot drift apart.

    A source the publish path marked as agent-authored lands in its own lane,
    ``buero_piloti``, decided by the provenance BEFORE the shelf, so a
    published Piloti document filed on the project shelf keeps its author.

    ``opened_files`` names the documents this result set OPENED rather than
    ranked (the members of a family overview); their hits are stamped as
    locator reads on the turn's ledger.
    """
    from aiq_agent.common.norm_registry import lane_for_knowledge_hit
    from aiq_agent.common.source_kinds import kind_for_lane

    lanes: dict[str, tuple[str, list]] = {}
    for hit in hits:
        key, label = lane_for_knowledge_hit(
            doc_class=hit.doc_class,
            file_name=hit.file_name,
            collection=hit.collection,
            shelf=hit.shelf,
            authored_by=hit.authored_by,
        )
        lanes.setdefault(key, (label, []))[1].append(hit)
    return tuple(
        TraceLane(
            key=key,
            label=label,
            kind=kind_for_lane(key),
            hit_count=len(members),
            sources=_lane_sources(members, opened_files),
        )
        for key, (label, members) in lanes.items()
    )


def _lane_detail(hit) -> str | None:
    """Where in the document this hit sits, as the Herleitung names it.

    The Punkt leads when the hit states one: a normative document is read by
    its numbering, and "Pkt. 3.5.2" is the locus the reader can act on, where
    "p.12" is where the printer happened to break the page. The page follows on
    the same line because the frontend takes the preview's page out of this
    string (``features/chat/lib/citations/build.ts``), and an entry that lost
    it would open the document at page 1. The two are separated by a SPACE:
    the Herleitung card joins several loci of one document with ", ", and a
    comma inside one locus would read as two.
    """
    page = f"p.{hit.page}" if hit.page is not None else ""
    if not hit.clause:
        return page or None
    return f"Pkt. {hit.clause} {page}".strip()


def _lane_sources(hits, opened_files: frozenset[str]) -> list[TraceLaneSource]:
    """One lane's documents, each ``(name, locus)`` once, in hit order."""
    sources: list[TraceLaneSource] = []
    seen: set[tuple[str, str]] = set()
    for hit in hits:
        detail = _lane_detail(hit)
        if not hit.file_name or (hit.file_name, detail or "") in seen:
            continue
        seen.add((hit.file_name, detail or ""))
        sources.append(_lane_source(hit, detail, opened=hit.file_name in opened_files))
    return sources


def _lane_source(hit, detail: str | None, *, opened: bool) -> TraceLaneSource:
    """One document of a lane, stamped with its retrieval round and noted on the turn's ledger.

    ``title`` is omitted when it would merely repeat the filename. The
    provenance travels as KEYS, not the German sentence, so a reader builds
    "freigegeben von …" in its own locale.

    A hit from a document in ``opened_files`` is stamped as a locator read,
    whatever tool rendered it: the family branch fetches each member the way
    ``read_passage(document=…)`` does, so the ledger must credit those
    documents as opened, or a later read of one of them is not a repeat. The
    producing tool is read off its scope, never passed (``record_lane_hit``).
    """
    from aiq_agent.common.provenance import provenance_metadata
    from aiq_agent.common.turn_status import READ_PASSAGE_TOOL
    from aiq_agent.common.turn_status import current_retrieval_round
    from aiq_agent.common.turn_status import lane_tool_scope
    from aiq_agent.common.turn_status import record_lane_hit

    source = TraceLaneSource(
        name=hit.file_name,
        title=hit.display_title if hit.display_title and hit.display_title != hit.file_name else None,
        detail=detail,
        shelf=str(hit.shelf) if hit.shelf is not None else None,
        round=current_retrieval_round(),
        provenance=provenance_metadata(hit.provenance) if hit.provenance is not None else None,
    )
    with lane_tool_scope(READ_PASSAGE_TOOL) if opened else nullcontext():
        record_lane_hit(source.name, title=source.title, detail=source.detail, shelf=source.shelf)
    return source
