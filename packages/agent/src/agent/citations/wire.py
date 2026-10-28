"""A ``SourceEntry`` as the JSON the client receives."""

from __future__ import annotations

import logging
from typing import Any

from agent.citations.binding import BindingClassification
from agent.citations.binding import binding_classification_for_entry
from agent.citations.binding import binding_note_for_entry
from agent.citations.binding import document_key
from agent.citations.binding import source_lane
from agent.citations.binding import source_origin_token
from agent.citations.citation_keys import entry_shelf
from agent.citations.citation_keys import parse_citation_key
from agent.citations.entries import SourceEntry
from agent.citations.entries import is_look_place
from agent.common.source_kinds import Shelf
from agent.common.source_kinds import kind_for_lane

logger = logging.getLogger(__name__)


def source_entry_to_wire(entry: SourceEntry, *, number: int | None = None) -> dict[str, Any]:
    """Serialize a :class:`SourceEntry` for the citation wire (SSE / WS).

    The frontend opens document previews from structured ``file_name`` /
    ``page`` / ``collection`` fields rather than inventing filenames from free
    text. ``content`` still carries a human-readable line (optional leading
    origin token + citation key or title) for legacy parsers and chip labels.

    ``number`` is the citation's ``[N]`` label in the verified answer — the one
    fact the frontend cannot recover on its own, because the ``[N]``→source
    binding lives in ``verify_citations``' ``valid_citations`` and nowhere else.
    Carrying it lets the UI render ONE provenance block (numbered, colored,
    clickable) instead of the LLM-written "## Sources" list AND a chip row that
    each hold half the truth. Omitted when unknown, so every existing caller and
    every persisted message keeps working unchanged.
    """
    origin_token = source_origin_token(entry)
    origin = origin_token.strip("[]").lower() if origin_token else None

    file_name: str | None = None
    page: int | None = None
    if entry.citation_key:
        parsed_name, page = parse_citation_key(entry.citation_key)
        # A cross-project key names its project after the file (ADR-0094):
        # „Plan.pdf (Wohnbau Graz), p.3". The file is called Plan.pdf.
        project_qualifier = f" ({entry.project_name})" if entry.project_name else None
        if project_qualifier and parsed_name.endswith(project_qualifier):
            parsed_name = parsed_name[: -len(project_qualifier)].rstrip()
        # Only surface filenames that look like documents (extension present).
        if parsed_name and "." in parsed_name.rsplit("/", 1)[-1]:
            file_name = parsed_name

    label = entry.citation_key or entry.title or entry.url or entry.tool_name or ""
    content = f"{origin_token} {label}".strip() if origin_token else label

    # Canonical source-kind: the coarse taxonomy every surface renders through
    # (chips, Herleitung fan-out, report). Derived from the rich lane
    # classification so the OIB corpus and RIS share the same ``building_law`` kind;
    # the fine lane travels alongside as a sub-label. See ``source_kinds``.
    # The norm registry is static within a turn; load it at most once here
    # (only for RIS entries, mirroring both helpers' guard) and hand the same
    # instance to source_lane and binding_note_for_entry so neither reloads it.
    from agent.common.norm_registry import load_registry
    from agent.common.norm_registry import resolve_federal_state

    # Load the registry once for anything that could resolve to a catalogued norm:
    # a RIS URL (source_lane/binding_note) OR a document identifier (the WIDENED
    # binding classification matches KB/upload filenames against aliases too). A
    # bare web URL still skips the load. The instance is shared across all three
    # helpers so none reloads it. Passing it to source_lane/binding_note_for_entry
    # is behaviour-neutral: both only read the registry on the RIS branch.
    registry = load_registry() if (entry.url and "ris.bka.gv.at" in entry.url) or entry.citation_key else None
    place = is_look_place(entry)
    lane_key, lane_label = source_lane(entry, registry)
    if place:
        # A place is the office's own document, never building law, whatever its
        # file is called (an uploaded „OIB-RL 2.pdf" is still a project document).
        office = entry_shelf(entry) == Shelf.OFFICE_SHELF
        lane_key, lane_label = ("office", "Büroablage") if office else ("project", "Projektwissen")
    kind = kind_for_lane(lane_key)

    # Binding classification (rank + coarse status) for the client. Bundesland is
    # resolved structured-first (signed request context, then prompt text) so a
    # Wien entry is never claimed for a Tirol project; the resolution is fail-open.
    try:
        federal_state = resolve_federal_state(None)
    except Exception:  # federal_state resolution must never break wire serialization
        federal_state = None
    classification = binding_classification_for_entry(entry, registry, federal_state)
    if place:
        classification = BindingClassification(rank=None, binding_status="unknown")

    payload: dict[str, Any] = {
        # The [N] marker this source carries in the answer prose (when known).
        "number": number,
        # Identity of the DOCUMENT this source is a passage of. A wire source is
        # a locus, not a document — four pages of one Richtlinie are four
        # sources — and every surface groups by document. Shipping the key the
        # registry itself groups on means the frontend folds on the backend's
        # identity instead of re-deriving one from the filename.
        "document_id": document_key(entry),
        "content": content,
        "title": entry.title or file_name,
        "citation_key": entry.citation_key,
        "collection": entry.collection,
        # The SHELF this passage came from, carried explicitly (ADR-0047) so the
        # frontend labels it instead of prefix-matching the collection id. Absent
        # when unknown — the renderer must leave such a source unattributed.
        "shelf": entry.shelf,
        "source_type": entry.source_type or None,
        "tool": entry.tool_name or None,
        "url": entry.url,
        "origin": origin,
        "kind": kind,
        "lane": lane_key,
        "lane_label": lane_label,
        # Bindingness fact for the popover ("does this bind me?") — only present
        # for RIS sources the norm registry catalogues with a binding_note.
        "binding_note": None if place else binding_note_for_entry(entry, registry),
        # Structured binding status alongside the prose ``binding_note``. ``rank``
        # is dropped by the None-filter below when the source matched no catalogued
        # norm; ``binding_status`` is ALWAYS emitted (``unknown`` included) — the
        # honest "we don't know" is a signal the UI needs, not an absence.
        "rank": classification.rank,
        "binding_status": classification.binding_status,
        "file_name": file_name,
        "page": page,
        # WHERE within the document, in the law's own numbering, and HOW NEARLY
        # it matched. Both are absent (dropped by the None-filter) when the
        # producer did not state them — a web source has neither.
        "clause": entry.clause,
        "score": entry.score,
        # THE PASSAGE ITSELF — the one thing a reader checking a citation is
        # actually after, and the one field this serializer used to drop.
        #
        # It was captured (``SourceEntry.chunk_text``), deduplicated and merged
        # across the chunks of a page, and then left behind here. The frontend
        # therefore had no passage for any knowledge-layer citation, and every
        # surface built to show one was inert against real traffic: the viewer's
        # text-layer highlight, the Fundstelle rail, the "Zitierte Stelle" box,
        # and "Zitat kopieren", which fell back to a bare bibliography line.
        # Nothing failed — a missing snippet is a supported outcome everywhere —
        # so the whole apparatus looked healthy and marked nothing.
        #
        # It is bounded here rather than at the reader: this travels on every
        # SSE frame and into ``messages.metadata``, and the client only needs
        # enough to locate a sentence in a document it already has.
        "snippet": _wire_snippet(entry.chunk_text or entry.read),
        # WHERE ON THE PAGE, for a passage read off a picture of it: boxes the
        # viewer draws over the page (issue #433). Absent for running text,
        # which the viewer finds by matching ``snippet`` instead.
        "regions": [region.to_wire() for region in entry.regions] or None,
        # The last page of a passage that crosses a page break, for a chip to show „S. 4–5“.
        "page_end": entry.page_end,
        # The OTHER project a cross-project lookup found this passage in
        # (ADR-0094): the chip names it, and the preview opens the document in
        # that project. Absent for every source of the chat's own scope.
        "project": _wire_project(entry),
    }
    return {key: value for key, value in payload.items() if value is not None}


def _wire_project(entry: SourceEntry) -> dict[str, str] | None:
    """``{id, name, status[, federalStateNote]}`` of the other project an entry came from, or None.

    ``federalStateNote`` is the project's Bundesland line verbatim, warning included.
    It is omitted when the producer stated none (older messages, a replayed
    turn whose text carries no ``Bundesland:`` line), and the browser reads
    absence as null.
    """
    if not entry.project_id:
        return None
    project = {"id": entry.project_id, "name": entry.project_name or "", "status": entry.project_status or "active"}
    if entry.project_federal_state_note:
        project["federalStateNote"] = entry.project_federal_state_note
    return project


#: The wire keys a READ-BUT-UNCITED source keeps: identity (which document,
#: which page) and placement (which kind, which lane) — never prose.
#:
#: Dropped structurally rather than by convention: no ``snippet`` (the
#: retrieved passage), no ``content`` locator line, no ``score``/``clause``,
#: no ``[N]`` number, no binding claims. A reader checking "what else did it
#: read" gets document chips; anything that could restate evidence stays on
#: the cited channel.
_READ_SOURCE_WIRE_KEYS = frozenset(
    {
        "document_id",
        "citation_key",
        "file_name",
        "page",
        "collection",
        "shelf",
        "kind",
        "lane",
        "lane_label",
        "title",
        "url",
        # Which project a read-but-uncited passage of another project came
        # from: identity, like the collection (ADR-0094).
        "project",
    }
)


def read_source_to_wire(entry: SourceEntry) -> dict[str, Any]:
    """Serialize a :class:`SourceEntry` for the read-but-uncited wire (``read_sources``).

    The same derivation as :func:`source_entry_to_wire` — the same document
    identity the chips group on, the same kind/lane placement — minus every
    key that carries prose or a claim: no passage, no locator line, no score,
    no citation number, no binding classification. What travels names the
    document and where it sits, nothing more.
    """
    return {key: value for key, value in source_entry_to_wire(entry).items() if key in _READ_SOURCE_WIRE_KEYS}


#: How much of a retrieved passage travels to the client.
#:
#: A passage is located by matching it against the document's own text, and the
#: matchers anchor on the ends of the snippet — so what is needed is a faithful
#: excerpt, not the whole chunk. 1200 characters is longer than any sentence a
#: legal answer quotes and short enough that a turn citing a dozen passages does
#: not put a novel on the wire or into ``messages.metadata``.
_WIRE_SNIPPET_MAX_CHARS = 1200


def _wire_snippet(chunk_text: str | None) -> str | None:
    """The retrieved passage, bounded, or None when the producer carried none."""
    text = (chunk_text or "").strip()
    if not text:
        return None
    if len(text) <= _WIRE_SNIPPET_MAX_CHARS:
        return text
    # Cut on a word boundary: a snippet ending mid-word cannot anchor a match on
    # its own tail, which is one of the two ends the matchers rely on.
    clipped = text[:_WIRE_SNIPPET_MAX_CHARS]
    boundary = clipped.rfind(" ")
    return clipped[:boundary] if boundary > _WIRE_SNIPPET_MAX_CHARS // 2 else clipped
