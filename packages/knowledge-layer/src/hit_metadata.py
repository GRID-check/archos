"""What a hit's file is, read from the store at query time.

Its Dokumentart, display title and folder, and the agent's filters over them.
"""

import logging

logger = logging.getLogger(__name__)


def resolve_doc_classes(chunks) -> dict[tuple[str, str], str]:
    """Resolve the authoritative ``doc_class`` for each hit's document.

    The summary store is the source of truth for ``doc_class`` at retrieval time
    (see the Phase B design decision); chunk metadata is only a fallback for
    standalone deployments that ship no summary DB. This builds a
    ``(collection, file_name) -> stored doc_class`` map by looking each distinct
    document up once via the factory. Fail-open: any store error (or missing
    store) yields an empty/partial map and callers fall back to chunk metadata.
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_doc_classes
    except Exception:
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "doc_class", exc_info=True
        )
        return resolved

    # Group the distinct documents by collection so each collection needs a
    # single batched query (there are only 1-3 in scope: base + session +
    # project) instead of one round-trip per hit.
    by_collection: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        collection = (chunk.metadata or {}).get("collection")
        file_name = chunk.file_name
        if not collection or not file_name:
            continue
        key = (collection, file_name)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(collection, []).append(file_name)

    for collection, file_names in by_collection.items():
        # Fail open per collection: one collection's error yields an empty map
        # for it (callers fall back to chunk metadata), never a total failure.
        try:
            stored_map = get_document_doc_classes(collection, file_names)
        except Exception:
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "doc_class",
                exc_info=True,
            )
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def hit_doc_class(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """Authoritative ``doc_class`` for a single hit: stored value wins.

    Prefers the store-resolved value (:func:`resolve_doc_classes`) over the
    ``doc_class`` stamped into chunk metadata at ingestion time, falling back to
    the chunk metadata when the store has no value for the document.
    """
    metadata = chunk.metadata or {}
    collection = metadata.get("collection")
    if collection and chunk.file_name:
        stored = resolved.get((collection, chunk.file_name))
        if stored:
            return stored
    return metadata.get("doc_class")


def resolve_display_titles(chunks) -> dict[tuple[str, str], str]:
    """Resolve the stored ``display_title`` for each hit's document (batched).

    Mirrors :func:`resolve_doc_classes`: the document_metadata store is the
    source of truth for the user-facing name. Builds a ``(collection, file_name)
    -> stored display_title`` map with one batched query per in-scope collection.
    Fail-open: any store error yields an empty/partial map and callers fall back
    to the derived default (:func:`~aiq_agent.common.norm_registry.guess_display_title`).
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_display_titles
    except Exception:
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "display_title", exc_info=True
        )
        return resolved

    by_collection: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        collection = (chunk.metadata or {}).get("collection")
        file_name = chunk.file_name
        if not collection or not file_name:
            continue
        key = (collection, file_name)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(collection, []).append(file_name)

    for collection, file_names in by_collection.items():
        try:
            stored_map = get_document_display_titles(collection, file_names)
        except Exception:
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "display_title",
                exc_info=True,
            )
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def hit_display_title(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """User-facing document name for a single hit: stored override wins.

    Precedence: the admin-editable stored ``display_title`` (source of truth) →
    the deterministic default derived from the OIB filename convention
    (:func:`~aiq_agent.common.norm_registry.guess_display_title`) → ``None`` for a
    document with neither (e.g. a project upload), where the caller keeps the raw
    filename because that IS the user-meaningful name for their own files.
    """
    metadata = chunk.metadata or {}
    collection = metadata.get("collection")
    if collection and chunk.file_name:
        stored = resolved.get((collection, chunk.file_name))
        if stored:
            return stored
    if chunk.file_name:
        try:
            from aiq_agent.common.norm_registry import guess_display_title

            return guess_display_title(chunk.file_name)
        except Exception:
            return None
    return None


def resolve_folder_paths(chunks) -> dict[tuple[str, str], str]:
    """Resolve the stored ``folder_path`` for each hit's document (batched).

    Mirrors :func:`resolve_doc_classes` and :func:`resolve_display_titles`: the
    document_metadata store is the source of truth for where a document is
    FILED, and the folder is deliberately NOT baked into the chunk vectors
    (ADR-0049) — a folder rename moves the path, and a value baked into every
    chunk would have to be rewritten chunk by chunk or go stale. Reading it here,
    once per collection, is what makes a rename take effect with no re-ingest.
    Fail-open: any store error yields an empty/partial map, which reads as
    "filed at the root".
    """
    resolved: dict[tuple[str, str], str] = {}
    try:
        from aiq_agent.knowledge.factory import get_document_folder_paths
    except Exception:
        # Fail-open, but never silent: with the store unreachable every hit
        # falls back to its chunk metadata, and that fallback looks exactly
        # like a correct answer from the outside.
        logger.warning(
            "document metadata store unavailable; %s falls back to chunk metadata", "folder_path", exc_info=True
        )
        return resolved

    by_collection: dict[str, list[str]] = {}
    seen: set[tuple[str, str]] = set()
    for chunk in chunks:
        collection = (chunk.metadata or {}).get("collection")
        file_name = chunk.file_name
        if not collection or not file_name:
            continue
        key = (collection, file_name)
        if key in seen:
            continue
        seen.add(key)
        by_collection.setdefault(collection, []).append(file_name)

    for collection, file_names in by_collection.items():
        try:
            stored_map = get_document_folder_paths(collection, file_names)
        except Exception:
            logger.warning(
                "document metadata store read failed for collection %s; %s falls back to chunk metadata",
                collection,
                "folder_path",
                exc_info=True,
            )
            stored_map = {}
        for file_name, stored in stored_map.items():
            if stored:
                resolved[(collection, file_name)] = stored
    return resolved


def hit_folder_path(chunk, resolved: dict[tuple[str, str], str]) -> str | None:
    """Folder path for a single hit, or ``None`` when it sits at the root."""
    collection = (chunk.metadata or {}).get("collection")
    if collection and chunk.file_name:
        return resolved.get((collection, chunk.file_name))
    return None


def _folder_matches(stored: str | None, requested: str) -> bool:
    """True when a hit is filed in ``requested`` OR anywhere beneath it.

    The subtree is the point of a materialised path: asking for ``Brandschutz``
    must also return ``Brandschutz/Fluchtwege``, and must NOT return
    ``Brandschutzkonzepte`` — which is exactly what the ``/`` boundary below
    enforces. Comparison is case-insensitive because the agent retypes the
    folder name from the inventory, and slashes are trimmed so ``/Brandschutz/``
    and ``Brandschutz`` are the same request.
    """
    have = (stored or "").strip().strip("/").casefold()
    want = (requested or "").strip().strip("/").casefold()
    if not want:
        return True
    if not have:
        return False
    return have == want or have.startswith(f"{want}/")


def _file_name_matches(chunk_name: str | None, requested: str) -> bool:
    """True when a hit is the file the agent named.

    Exact (case-insensitive) first; then either name contains the other so
    ``Brandschutzplan.pdf`` matches ``Brandschutzplan_EG.pdf``. Display titles
    are ``title_contains``'s job — this is the indexed name.
    """
    have = (chunk_name or "").strip().casefold()
    want = (requested or "").strip().casefold()
    if not have or not want:
        return False
    return have == want or want in have or have in want


def apply_agent_filters(
    chunks,
    doc_class: str | None,
    title_contains: str | None,
    file_name: str | None = None,
    folder: str | None = None,
) -> list:
    """Narrow a merged candidate list by the agent-supplied filters.

    Filters run post-merge so they apply uniformly across every collection
    layer (base, session, project). ``doc_class`` uses the same store-authoritative
    resolution as the Dokumentart line (:func:`hit_doc_class`), so a platform-owner
    reclassification takes effect without re-ingest. ``title_contains`` matches the
    raw file name OR the resolved display title, case-insensitively. ``file_name``
    matches the indexed name only — the agent already has a name. ``folder``
    keeps only documents filed in that project folder OR anywhere under it
    (ADR-0049), resolved from the same store for the same reason: a folder
    rename applies immediately, with nothing re-ingested.
    """
    resolved_classes = resolve_doc_classes(chunks) if doc_class else {}
    resolved_titles = resolve_display_titles(chunks) if title_contains else {}
    requested_folder = (folder or "").strip().strip("/") or None
    resolved_folders = resolve_folder_paths(chunks) if requested_folder else {}
    needle = title_contains.casefold() if title_contains else None
    requested_name = (file_name or "").strip() or None
    kept = []
    for chunk in chunks:
        if doc_class and hit_doc_class(chunk, resolved_classes) != doc_class:
            continue
        if requested_name and not _file_name_matches(chunk.file_name, requested_name):
            continue
        if requested_folder and not _folder_matches(hit_folder_path(chunk, resolved_folders), requested_folder):
            continue
        if needle:
            haystacks = [chunk.file_name or ""]
            title = hit_display_title(chunk, resolved_titles)
            if title:
                haystacks.append(title)
            if not any(needle in hay.casefold() for hay in haystacks):
                continue
        kept.append(chunk)
    return kept
