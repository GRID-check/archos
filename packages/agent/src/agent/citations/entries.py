"""What a cited source is (``SourceEntry``) and what a verification run reports (``CitationVerificationResult``)."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from html import unescape
from urllib.parse import parse_qs
from urllib.parse import unquote
from urllib.parse import urlparse
from urllib.parse import urlunparse

from agent.common.grounding_block import SourceRegion

logger = logging.getLogger(__name__)


@dataclass
class SourceEntry:
    """A single source captured from a tool call result."""

    url: str | None = None
    title: str | None = None
    citation_key: str | None = None
    source_type: str = ""
    tool_name: str = ""
    # Retrieval collection the hit came from (oib_knowledge, s_*, proj_*, archiv_* or office_shelf_*),
    # parsed from the knowledge-layer tool output's `Collection:` field. None for
    # URL/web sources and for output produced before the field was threaded.
    collection: str | None = None
    # The SHELF the hit came from (`office_shelf`/`project`/`session`/`base`), stated
    # by the knowledge layer's ``Shelf:`` field (ADR-0047). None when the
    # producer did not state one — unknown, and never re-derived from the
    # collection id here.
    shelf: str | None = None
    # Explicit per-document classification ("Dokumentart" / doc_class), parsed
    # from the knowledge-layer tool output's `Dokumentart:` field. When present
    # it is the FIRST-priority signal for lane/kind placement, overriding the
    # filename/collection heuristics. None for sources without an explicit class.
    doc_class: str | None = None
    # WHO WROTE THE DOCUMENT this passage came from — ``"agent"`` for a
    # published Piloti document, None for everything a human wrote. Parsed from
    # the knowledge-layer tool output's ``Herkunft:`` line
    # (``common/provenance.py``). It is its own axis, never a doc_class and
    # never a shelf: it decides the lane before either of those is consulted,
    # and it is what ``answer_envelope._gate_verdict`` reads to refuse a
    # normative verdict resting on an office document Piloti wrote itself.
    authored_by: str | None = None
    # Retrieved passage body for knowledge-layer hits (the chunk content the KB
    # tool returned, truncated at 1500 chars per chunk). Used by
    # ``verify_quoted_spans`` to check that a QUOTED sentence in the answer
    # actually appears (fuzzily) in the evidence, catching the DeepSeek "cites a
    # real section but fabricates the quote" bug. When several chunks dedup onto
    # the same (filename, page) key their bodies are joined (see ``add``). None
    # for URL/web sources and for output produced before this field was threaded.
    chunk_text: str | None = None
    # The Punkt this passage belongs to ("3.5.2"), as the chunker established
    # it and the knowledge layer's ``Punkt:`` line states it. This is the
    # citation form Austrian building law uses; None for page-fallback chunks
    # and every document without a numbered outline. When several chunks
    # dedup onto one page entry the first stated Punkt survives (see ``add``).
    clause: str | None = None
    # The retrieval score the knowledge layer printed for this passage, a true
    # cosine similarity. Carried so a reader can ask not only WHERE a passage
    # is but how nearly it matched; the best score of a page's chunks survives
    # dedup. None for URL/web sources.
    score: float | None = None
    # BINDING CLASSIFICATION carried to the client (see
    # ``binding_classification_for_entry``). Both default to the honest-unknown
    # value on purpose: a source that matched no catalogued norm must NEVER claim
    # to bind — a fabricated "binding" badge would be a false legal claim, so the
    # safe default is "we don't know". ``rank`` is the :data:`NormRank` of the
    # registry entry the source resolved to, or None when it matched none (an OIB
    # corpus document, or any unrecognised file — those carry no RIS rank).
    # ``binding_status`` is the coarse bindingness the UI badges: ``binding`` /
    # ``declared_binding`` / ``interpretive`` / ``unknown``. These are optional
    # carriers; the wire recomputes the classification fresh (it needs the
    # registry + Bundesland the raw entry lacks) and they round-trip through the
    # session-registry cache like the other fields.
    rank: str | None = None
    binding_status: str = "unknown"
    # WHERE ON THE PAGE the passage sits, as boxes the viewer draws (issue #433).
    # Stated by the producer for a passage read off a picture of the page (a
    # plan's Grundriss, a photo), never for running text, which the viewer
    # locates by matching ``chunk_text`` instead. Several chunks of one page
    # merge their boxes on dedup, so a page cited for two depictions marks both.
    regions: list[SourceRegion] = field(default_factory=list)
    # Last page of a passage that runs over a page break (``GroundingHit.page_end``); None when it
    # ends on its citation key's page. The key itself keeps the start page: it is the identity.
    page_end: int | None = None
    # WHAT A ``look`` READ at this place (its ``Gelesen:`` lines), when a look
    # registered it (ADR-0125, amendment of 2026-10-22). A perception of a
    # drawing, not a retrieved passage: it is never ``chunk_text``, so no quote
    # is checked against it and it grounds no claim about the law. An entry with
    # a ``read`` and no ``chunk_text`` is a PLACE; ``regions`` non-empty says the
    # look was a region crop and not an overview.
    read: str | None = None
    # The OTHER project a cross-project lookup found this passage in (ADR-0094),
    # as the knowledge layer's ``Projekt:`` line states it. None for every
    # source of the turn's own scope. The chip names it, and the preview opens
    # the document in that project rather than in the chat's own.
    project_id: str | None = None
    project_name: str | None = None
    project_status: str | None = None
    # The Bundesland line of that project's hit, as the producer states it
    # (``SourceProject.federal_state_note``): the label, plus the warning when the
    # project is in another Land than the chat's. Carried to the precedent
    # chip's meta line; None when the producer stated none.
    project_federal_state_note: str | None = None


@dataclass
class CitationVerificationResult:
    """Result of running verify_citations()."""

    verified_report: str
    removed_citations: list[dict] = field(default_factory=list)
    valid_citations: list[dict] = field(default_factory=list)


#: The reason a duplicate source line is dropped under. Its inline ``[N]`` is
#: REWRITTEN to the line it duplicates, so the prose still cites the source:
#: nothing the answer claimed was lost, which makes it a merge, not a defect.
DUPLICATE_REASON_PREFIX = "duplicate_of_citation_"


def lost_citations(removed_citations: Sequence[dict]) -> list[dict]:
    """The removals that cost the answer a citation: every one except a merged duplicate.

    Two Punkte read from one page are one registry entry, so an answer that
    lists "file.pdf, p.4" twice gets the second merged into the first. Counted
    as a failure, that merge bought a full repair rewrite (16 s, measured in
    the September 2026 census) and a "Belege entfernt" note for a citation the
    reader still has. Telemetry keeps the full list; the reader's note reads
    this one (``ledger.citations_removed_summary`` on chat, ``finalize`` in
    deep research).
    """
    return [
        entry
        for entry in removed_citations
        if not (isinstance(entry, dict) and str(entry.get("reason") or "").startswith(DUPLICATE_REASON_PREFIX))
    ]


def merged_citations(removed_citations: Sequence[dict]) -> dict[int, int]:
    """Each merged duplicate's number and the number it was rewritten to, before renumbering.

    The removals :func:`lost_citations` leaves out: ``verify_citations``
    rewrote the prose's ``[N]`` of each to the line it duplicates. Anything
    else that carries the answer's numbers (a surface's ``Text``) takes the
    same rewrite before sanitize's renumbering, or loses the citation.
    """
    merged: dict[int, int] = {}
    for entry in removed_citations:
        reason = str(entry.get("reason") or "") if isinstance(entry, dict) else ""
        canonical = reason.removeprefix(DUPLICATE_REASON_PREFIX)
        if reason.startswith(DUPLICATE_REASON_PREFIX) and canonical.isdigit() and isinstance(entry.get("number"), int):
            merged[entry["number"]] = int(canonical)
    return merged


class EmptySourceRegistryError(Exception):
    """Raised when no sources were captured during research."""

    def __init__(
        self,
        agent_type: str = "research",
        unavailable_tools: list[str] | None = None,
        available_count: int = 0,
    ) -> None:
        self.agent_type = agent_type
        self.unavailable_tools = unavailable_tools or []
        self.available_count = available_count
        super().__init__(
            f"Research failed: no sources were captured during {agent_type}. "
            "All tool calls may have failed or returned no results. "
            "Please try again."
        )


_TRACKING_PARAMS = frozenset(
    {
        "utm_source",
        "utm_medium",
        "utm_campaign",
        "utm_term",
        "utm_content",
        "ref",
        "source",
    }
)


def normalize_url(url: str) -> str:
    """Normalize a URL for comparison.

    Lowercases scheme/host, strips trailing slash, removes fragments
    and common tracking parameters.
    """
    url = unescape(url).strip()
    parsed = urlparse(url)
    scheme = parsed.scheme.lower()
    netloc = parsed.netloc.lower()
    path = unquote(parsed.path).rstrip("/") or "/"
    # Remove tracking params
    qs = parse_qs(parsed.query, keep_blank_values=True)
    filtered_qs = {k: v for k, v in qs.items() if k.lower() not in _TRACKING_PARAMS}
    query_str = "&".join(f"{k}={v[0]}" for k, v in sorted(filtered_qs.items()) if v)
    return urlunparse((scheme, netloc, path, "", query_str, ""))


# Inline marker appended immediately after a quoted span that could not be
# verified against any retrieved passage. Fail-open: the sentence is NEVER
# stripped or altered; only this marker is inserted after the closing quote.
UNVERIFIED_QUOTE_MARKER = "[nicht wörtlich in der Quelle belegt]"


#: What stands where the answer cited something that did not resolve
#: (``verify_citations(label_dropped=True)``): no retrieved source behind the
#: number, or a § / Punkt beside it the cited passage does not hold. The claim
#: stays, as it always did; what changed is that it no longer reads like every
#: other unmarked sentence, and the answer check reads the label too
#: (``common/claim_judge.py``). Reader-facing German, like the quote marker.
DROPPED_CITATION_MARKER = "[Beleg nicht verifiziert]"


#: Why a cited occurrence lost its number although its source line resolved.
LOCUS_MISMATCH_REASON = "locus_not_in_source"


#: Why a cited number had nothing to resolve against at all.
NO_SOURCE_REASON = "no_source_retrieved"


#: The tool whose result registers PLACES, not passages (``tools/look``).
LOOK_TOOL = "look"


def is_look_tool(tool_name: str) -> bool:
    """Whether ``tool_name`` is ``look`` (bare, or as a member of a function group)."""
    name = (tool_name or "").lower()
    return name == LOOK_TOOL or name.endswith(f"__{LOOK_TOOL}")


def is_look_place(entry: SourceEntry) -> bool:
    """Whether the entry is a place a look read and no retrieved passage.

    Such a source is evidence of what Piloti read off a drawing. It is never
    ``citation_grounded`` and never grounds a claim about the law (ADR-0125,
    amendment of 2026-10-22).
    """
    return bool(entry.read) and not entry.chunk_text
