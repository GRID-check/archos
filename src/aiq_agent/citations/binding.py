"""A source's lane and binding status (law, OIB guideline, interpretation, office), carried to the client."""

from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from typing import Any

if TYPE_CHECKING:
    from aiq_agent.common.norm_registry import NormRank
    from aiq_agent.common.norm_registry import NormRegistry
from aiq_agent.citations.citation_keys import parse_citation_key
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.entries import normalize_url
from aiq_agent.citations.registry import SourceRegistry

logger = logging.getLogger(__name__)


# Austrian RIS (Rechtsinformationssystem) sources arrive via the generic URL
# parser, so they share ``source_type == "generic"`` with ordinary web hits.
# They stay cleanly identifiable through the RIS tool names (``ris_search_tool``
# / ``ris_fetch_tool``, and the ``ris_*`` names the prompts reference) and the
# official RIS host — either signal is enough to label them as the authoritative
# legal source rather than generic web.
_RIS_URL_HOST_RE = re.compile(r"^\s*https?://(?:[\w-]+\.)*ris\.bka\.gv\.at\b", re.IGNORECASE)


def _is_ris_source(entry: SourceEntry) -> bool:
    """Return true when a source originates from the Austrian RIS."""
    name = (entry.tool_name or "").lower()
    if name.startswith("ris_") or "ris_search" in name or "ris_fetch" in name:
        return True
    # The collection ``ris_lookup`` states (``ris/LrKons/Wien``), which a
    # registry hydrated without the tool name still carries.
    if (entry.collection or "").lower().startswith("ris/"):
        return True
    return bool(entry.url and _RIS_URL_HOST_RE.match(entry.url))


def source_lane(entry: SourceEntry, registry: NormRegistry | None = None) -> tuple[str, str]:
    """(stratum_key, German label) for the research fan-out UI's source grouping.

    Deterministic display tagging on top of ``source_origin_token``'s coarse
    origin: Baurecht lanes split by registry rank (RIS) or OIB filename class
    (knowledge base), Projektwissen/Büroablage by collection prefix, Web
    otherwise — see ``norm_registry.lane_for_hit``. The wire tokens
    (``[KB]``/``[RIS]``/``[Web]``) are unchanged; the fan-out UI reads this
    richer label from the structured source payloads instead.
    """
    from aiq_agent.common.norm_registry import lane_for_hit
    from aiq_agent.common.norm_registry import lane_for_knowledge_hit
    from aiq_agent.common.norm_registry import load_registry

    file_name = None
    if entry.citation_key:
        file_name, _ = parse_citation_key(entry.citation_key)
    # ``registry`` may be supplied by the caller (so a single ``load_registry()``
    # serves several helpers per entry); when absent, load it exactly as before —
    # only for RIS URLs, so non-RIS entries still skip the load entirely.
    if registry is None:
        registry = load_registry() if (entry.url and "ris.bka.gv.at" in entry.url) else None
    classify = lane_for_knowledge_hit if entry.source_type == "knowledge_layer" else lane_for_hit
    # The shelf the hit already carries (ADR-0047) is what decides whether the
    # default doc class means anything; without it the resolver has to guess
    # the shelf back from the collection name.
    return classify(
        doc_class=entry.doc_class,
        file_name=file_name,
        source_url=entry.url,
        collection=entry.collection,
        registry=registry,
        shelf=entry.shelf,
        authored_by=entry.authored_by,
    )


def binding_note_for_entry(entry: SourceEntry, registry: NormRegistry | None = None) -> str | None:
    """Prose bindingness note for a source, when the norm registry catalogues one.

    For a RIS source whose URL carries a catalogued ``document_number``, return
    the matching registry entry's ``binding_note`` (e.g. how the WBTV makes the
    OIB Richtlinien binding in Wien) — the highest-value "does this actually bind
    me?" fact for the citation popover. ``None`` when the source is not RIS or
    the matched entry carries no note. Fail-open: never raises.
    """
    if not (entry.url and "ris.bka.gv.at" in entry.url):
        return None
    try:
        from aiq_agent.common.norm_registry import load_registry

        # Reuse a caller-supplied registry when present; otherwise load it as
        # before. The load stays inside the fail-open guard.
        if registry is None:
            registry = load_registry()
        for norm in registry.entries:
            if norm.document_number and norm.document_number in entry.url and norm.binding_note:
                return norm.binding_note
    except Exception:  # registry unavailable/invalid — bindingness is best-effort
        return None
    return None


# NormRank -> coarse binding status. The exact partition the spec fixes:
#   federal_law/state_law/ordinance -> binding            (statute / ordinance)
#   authority_info                  -> declared_binding
#     (the lane by which a Land declares OIB binding — e.g. the Wiener WBTV;
#      OIB-Richtlinien themselves are treated as this, see ``_oib_binding_status``)
#   external_standard               -> interpretive        (ÖNORM/Leitfaden: interpretive)
_STATUS_FOR_RANK: dict[str, str] = {
    "federal_law": "binding",
    "state_law": "binding",
    "ordinance": "binding",
    "authority_info": "declared_binding",
    "external_standard": "interpretive",
}


#: The German binding statuses an older pod wrote into the shared session cache
#: (and onto the wire) before the English names. Read-only: nothing writes these.
LEGACY_BINDING_STATUS: dict[str, str] = {
    "bindend": "binding",
    "verbindlich_erklaert": "declared_binding",
    "auslegend": "interpretive",
    "unbekannt": "unknown",
}


# Explicit "Dokumentart" (doc_class) keys for the OIB corpus, which is NOT in the
# registry (the knowledge base is its source of truth). The Richtlinie itself is
# the normative text a Bundesland declares binding; its Leitfäden, Erläuterungen,
# Begriffsbestimmungen, referenced-norm lists and change docs only interpret or
# accompany it and never found a new requirement.
_OIB_GUIDELINE_DOC_CLASSES = frozenset({"oib_guideline"})


_OIB_INTERPRETIVE_DOC_CLASSES = frozenset(
    {"oib_guide", "oib_explanatory_note", "oib_definitions", "oib_reference", "oib_amendment"}
)


@dataclass
class BindingClassification:
    """A source's structured binding status.

    ``rank`` is the :data:`NormRank` of the registry entry the source resolved
    to (``None`` when it matched none — an OIB corpus document, or an
    unrecognised file). ``binding_status`` is the coarse bindingness the UI
    badges: ``binding`` / ``declared_binding`` / ``interpretive`` /
    ``unknown``. The default is ``unknown`` with no rank — the honest
    "we don't know" that a source matching nothing MUST get, because a
    fabricated binding badge would be a false legal claim.
    """

    rank: NormRank | None = None
    binding_status: str = "unknown"


def _source_document_identifier(entry: SourceEntry) -> str | None:
    """The text to match a source against catalogued norms: its filename, else title.

    The RIS ``document_number`` is matched separately (against the URL); this is
    the WIDENED signal — a KB/upload source names its document by FILENAME
    (``oib-rl_2_ausgabe_mai_2023.pdf``), which an entry's ``short``/``alias``/
    ``title`` can be found within. The raw URL is deliberately NOT used here: a
    bare web URL's host/path text is noise that would produce spurious alias
    hits, and the only URL that carries a real norm identity (RIS) is already
    matched precisely by ``document_number``.
    """
    if entry.citation_key:
        filename, _page = parse_citation_key(entry.citation_key)
        if filename:
            return filename
    return entry.title or None


def _match_registry_entry(
    entry: SourceEntry,
    registry: NormRegistry | None,
    federal_state: str | None,
) -> Any:
    """The catalogued norm a source resolves to, or ``None``.

    Matching is WIDENED beyond the old RIS-only path because that path left every
    non-RIS source (KB docs, uploads) unclassifiable:

    1. RIS URL -> precise ``document_number`` substring (the pre-existing signal).
    2. Otherwise the source's filename/title against each entry's
       ``short``/``title``/``alias``/``topic`` (via :func:`match_entries`).

    Bundesland is respected via :func:`focus_entries`: a Wien entry is dropped
    for a Tirol project, so its rank is never claimed for the wrong jurisdiction
    (the classification then falls through to ``unknown`` rather than lying).
    """
    from aiq_agent.common.norm_registry import focus_entries
    from aiq_agent.common.norm_registry import load_registry
    from aiq_agent.common.norm_registry import match_entries

    # Only a source that could name a catalogued norm is worth a registry load:
    # a RIS URL, or a document identifier (citation_key/title). A bare web URL
    # never matches, so it never pays the load — mirroring ``binding_note_for_entry``.
    is_ris = bool(entry.url and "ris.bka.gv.at" in entry.url)
    identifier = _source_document_identifier(entry)
    if not (is_ris or identifier):
        return None
    if registry is None:
        registry = load_registry()
    if registry is None or not registry.entries:
        return None

    if is_ris:
        for norm in focus_entries(registry.entries, federal_state):
            if norm.document_number and norm.document_number in entry.url:  # type: ignore[operator]
                return norm
    if identifier:
        candidates = focus_entries(match_entries(registry, identifier), federal_state)
        if candidates:
            return candidates[0]
    return None


def _oib_binding_status(entry: SourceEntry) -> str | None:
    """Binding status for an OIB CORPUS document (not in the registry), or ``None``.

    The OIB corpus lives in the knowledge base, so it never matches a registry
    entry — yet its Richtlinien are exactly what a Land declares binding, and its
    Leitfäden/Erläuterungen are exactly the interpretive guidance the UI must
    distinguish. The document ROLE is read deterministically from the explicit
    ``Dokumentart`` (doc_class) first, then the corpus filename convention
    (:func:`oib_doc_class`) — the same non-guessed signals ``lane_for_hit`` uses.
    ``rank`` stays ``None`` (the OIB corpus carries no RIS rank); only the coarse
    role is asserted. ``None`` when the source is not an OIB corpus document.
    """
    from aiq_agent.common.norm_registry import oib_doc_class
    from aiq_agent.knowledge.document_classification import canonical_doc_class

    doc_class = canonical_doc_class(entry.doc_class) or entry.doc_class
    if doc_class in _OIB_GUIDELINE_DOC_CLASSES:
        return "declared_binding"
    if doc_class in _OIB_INTERPRETIVE_DOC_CLASSES:
        return "interpretive"
    if entry.citation_key:
        filename, _page = parse_citation_key(entry.citation_key)
        basename = filename.rsplit("/", 1)[-1] if filename else ""
        oib_class = oib_doc_class(basename) if basename else None
        if oib_class == "guideline":
            return "declared_binding"
        if oib_class is not None:
            return "interpretive"
    return None


def binding_classification_for_entry(
    entry: SourceEntry,
    registry: NormRegistry | None = None,
    federal_state: str | None = None,
) -> BindingClassification:
    """Resolve a source to a structured :class:`BindingClassification`.

    Order: a catalogued-norm match (RIS ``document_number`` or widened
    filename/title vs ``short``/``alias``/``title``) yields that entry's rank and
    the coarse status it maps to; an OIB corpus document (no registry entry)
    yields the status its Richtlinie/Leitfaden role implies with ``rank=None``;
    anything else is ``unknown``.

    Fail-open EXACTLY like :func:`binding_note_for_entry`: a missing/invalid
    registry (or any error) yields ``unknown``, never an exception — a binding
    classification must never take a turn down. ``unknown`` is also the honest
    default for a source that matched nothing: emitting a guessed "binding" would
    be a false legal claim, so the safe direction is always "we don't know".
    """
    try:
        norm = _match_registry_entry(entry, registry, federal_state)
        if norm is not None:
            return BindingClassification(
                rank=norm.rank,
                binding_status=_STATUS_FOR_RANK.get(norm.rank, "unknown"),
            )
        status = _oib_binding_status(entry)
        if status is not None:
            return BindingClassification(rank=None, binding_status=status)
    except Exception:  # registry unavailable/invalid — bindingness is best-effort
        return BindingClassification()
    return BindingClassification()


def document_key(entry: SourceEntry) -> str:
    """Stable identity of the DOCUMENT an entry belongs to.

    A captured source is a *locus* — a passage at one page of one document —
    and the registry has always keyed it on ``(collection, filename, page)``.
    This function drops the page, leaving the identity of the document itself,
    which is what every consumer actually groups by: the chip row shows one chip
    per document, the Herleitung one card per document, and the bibliography one
    row per locus WITHIN a document.

    Stamping it on the wire (``document_id``) means the frontend no longer has
    to re-derive the grouping from filename heuristics. Precedence mirrors the
    registry's own ``_identity``:

      1. ``(collection, filename)`` — the primary key of ``document_metadata``
         and the only pair that is unique. One search fans out across the base
         corpus, the session collection and the project collections at once, so
         two different ``Plan.pdf`` can arrive in one result set.
      2. ``filename`` alone, when the collection is unknown.
      3. the normalized URL, for web/RIS sources.
      4. the title, so a source is never identity-less.
      5. a content digest, when the entry has no human label at all. Falling
         back to a bare ``label:`` made every anonymous entry share one key —
         and because the frontend PREFERS a supplied ``document_id`` over its
         own derivation, distinct sources would have been folded into a single
         document downstream. The digest is deterministic (no clock, no
         randomness), so the same entry keys the same way across processes and
         across a registry rehydrated from cache.
    """
    filename = ""
    if entry.citation_key:
        filename, _page = parse_citation_key(entry.citation_key)
    filename = filename.strip().lower()
    if filename:
        collection = (entry.collection or "").strip().lower()
        return f"doc:{collection}:{filename}" if collection else f"doc:{filename}"
    if entry.url:
        return f"url:{normalize_url(entry.url)}"
    label = (entry.title or entry.tool_name or "").strip().lower()[:120]
    if label:
        return f"label:{label}"
    fingerprint = hashlib.sha256(
        "\x1f".join(
            (entry.source_type or "", entry.tool_name or "", entry.collection or "", entry.chunk_text or "")
        ).encode("utf-8")
    ).hexdigest()[:16]
    return f"anon:{fingerprint}"


def source_label(entry: SourceEntry) -> str | None:
    """Stable identity of a captured source for the citation-health ledger.

    The document key or URL — an identifier, never the retrieved passage — so
    the platform export can name WHICH source was in play without carrying any
    answer or corpus prose across tenants. ``None`` when the entry has neither
    (a bare tool-result source, which identifies nothing citable).
    """
    return entry.citation_key or entry.url or None


def source_origin_token(entry: SourceEntry) -> str:
    """Return a stable leading origin token for a source line.

    Deterministic backend output (never LLM-generated): ``[KB]`` for the
    trusted OIB knowledge base, ``[RIS]`` for the official Austrian legal
    information system, ``[Web]`` for URL-bearing web sources. Returns an empty
    string when the origin is not cleanly identifiable, so callers emit no token
    and the frontend falls open to plain, unlabeled text.
    """
    # RIS first: a ``ris_lookup`` passage is a grounding-block hit, so it is a
    # ``knowledge_layer`` entry too, and checked second it went out as ``[KB]``
    # on every Bauordnung answer the suite read.
    if _is_ris_source(entry):
        return "[RIS]"
    if entry.source_type == "knowledge_layer":
        return "[KB]"
    if entry.url:
        return "[Web]"
    return ""


def agent_authored_document_names(registry: SourceRegistry | None) -> frozenset[str]:
    """Normalised names of the AGENT-AUTHORED documents this turn captured.

    The input to the verdict gate (``answer_envelope._gate_verdict``), which
    has a model-written ``reference.document`` and no registry of its own. Both
    identities a model could name a document by are included — the indexed
    filename and the display title — each reduced through
    :func:`~aiq_agent.common.provenance.normalize_document_name` so
    ``"**Brandschutzkonzept Haus B.md**"`` and ``"Brandschutzkonzept Haus-B"``
    are the same name.

    Empty when the turn captured no such document, which is the overwhelmingly
    common case and the one that must cost nothing: an empty set makes the gate
    a no-op.
    """
    from aiq_agent.common.provenance import is_agent_author
    from aiq_agent.common.provenance import normalize_document_name

    names: set[str] = set()
    for entry in registry.all_sources() if registry else ():
        if not is_agent_author(entry.authored_by):
            continue
        file_name, _ = parse_citation_key(entry.citation_key or "")
        # The basename only: a published Piloti document is indexed under a
        # namespaced path (``piloti/<item id>/<slug>.md``) that no model would
        # ever write, while the slug is the name it WOULD write.
        base_name = file_name.rsplit("/", 1)[-1]
        names.update(normalize_document_name(value) for value in (base_name, entry.title))
    names.discard("")
    return frozenset(names)
