"""The two ingestion hooks that read Fassungen: a suggestion for a new name, a change line for a re-upload.

``adapter.py`` calls :func:`record_fassungen` once per file, after the summary
row is written:

* A file whose NAME is new in the collection may be a newer Fassung of another
  document under a different name. The summary model reads a few candidates and
  its answer is stored as a ``revision_suggestion`` on the new row. A SUGGESTION:
  nothing is linked, hidden or re-ranked until a person confirms it.
* A file uploaded under a name the collection already holds replaces its
  predecessor's chunks (ADR-0054). What changed against the previous upload is
  written as the row's ``change_summary``, with its own name as ``change_basis``.

WHAT REACHES THE MODEL, AND WHEN (ADR-0086). The upload screen runs BEFORE this:
a file whose content or name matched a rule is quarantined by the ingest job,
which ``continue``s before any summary exists. So the new file has passed, and no
held file has a row to be read here. The one hole is a quarantined RE-upload,
whose predecessor keeps its row (it carries what people set); a re-upload still
being read is the same. Those names are read from the ingest job store and left
out of the candidates, and when that store cannot be read nothing is suggested:
the names stay home rather than guess. What a candidate sends is its name,
Dokumentart, tags and one-line summary, which an earlier ingest already sent to
the same model.

The title block (Plankopf) read during ingestion outranks the name: two documents with the same
``document_number`` are Fassungen of one another whatever their file names share, and the Index
(else the date) printed on the sheet says which is newer. When the title blocks decide, the
suggestion is written with ``basis="title_block"`` and no model is called
(:func:`~aiq_agent.knowledge.document_revisions.settle_by_title_block`). :func:`revision_facts_from_documents`
picks the facts a document stores from its analysed pages.

A third path needs no model to decide: a person who dropped the file onto the upload dialog
and ticked „Als neue Fassung von X ablegen" has already said it (``fassung_of`` on the ingest
job, ADR-0098). Once the new file has been read, :func:`confirm_fassung` writes the link a
person's ``PUT /v1/collections/{c}/fassung`` writes (``superseded_by`` on X, the change summary
on the new file with X as its basis). X missing from the collection, or a link that would close
a loop, falls back to the ordinary paths above.

All of these are fail-open and bounded by the caller; none can fail an ingest.
"""

from __future__ import annotations

import json
import logging
from collections.abc import Callable
from collections.abc import Sequence
from typing import Any

from aiq_agent.knowledge.document_revisions import TITLE_BLOCK_CONFIDENCE
from aiq_agent.knowledge.document_revisions import RevisionDocument
from aiq_agent.knowledge.document_revisions import judge_revision
from aiq_agent.knowledge.document_revisions import summarize_change
from aiq_agent.knowledge.document_revisions import title_block_reason
from aiq_agent.knowledge.document_revisions import would_loop
from aiq_agent.knowledge.title_block import compare_revisions
from aiq_agent.knowledge.title_block import document_key
from aiq_agent.knowledge.title_block import identifies_document
from aiq_agent.knowledge.title_block import newest_first
from aiq_agent.knowledge.title_block import normalise_revision_facts
from aiq_agent.knowledge.title_block import same_document

from ..revision_series import find_revision_series
from ..revision_series import parse_revision_name
from ..revision_series import revision_label
from ..revision_series import series_key_of

logger = logging.getLogger(__name__)

#: How far back a quarantine verdict is looked for in the job store.
HELD_LOOKBACK_SECONDS = 30 * 24 * 3600


def revision_facts_from_documents(documents: Sequence[Any]) -> dict[str, Any] | None:
    """The title-block facts a document stores: those of the first drawing page that has a title block, or ``None``.

    ``documents`` are the analysed visuals' chunks (LlamaIndex ``Document``). Each
    carries ``page_label`` and ``drawing_data``, whose ``document.title_block`` is
    what the vision model read on that page. The first page, in page order, whose
    title block names the document or its state (a number, an Index or a date)
    wins; failing that, the first page with any title-block field. Pages are not
    merged: a number from one sheet and an Index from another are two sheets' facts.
    The record carries the ``page`` it was read on.
    """
    readings: list[tuple[int, dict[str, Any]]] = []
    for document in documents:
        metadata = getattr(document, "metadata", None) or {}
        raw = metadata.get("drawing_data")
        if not raw:
            continue
        try:
            title_block = (json.loads(raw).get("document") or {}).get("title_block")
            page = int(metadata.get("page_label"))
        except (AttributeError, TypeError, ValueError):
            continue
        facts = normalise_revision_facts({**title_block, "page": page}) if isinstance(title_block, dict) else None
        if facts:
            readings.append((page, facts))
    readings.sort(key=lambda reading: reading[0])
    identifying = next((facts for _, facts in readings if identifies_document(facts)), None)
    return identifying or (readings[0][1] if readings else None)


#: The confidence of a suggestion read from the file names alone (no model was asked).
NAME_SERIES_CONFIDENCE = 0.9


def _open_to_link(older: Any, newer: Any) -> bool:
    """Whether ``older`` may be suggested as replaced by ``newer``: neither is replaced or linked to the other."""
    return not older.superseded_by and not newer.superseded_by and older.file_name not in (newer.supersedes or ())


def _refused(newer: Any, older: Any) -> bool:
    """Whether a person already dismissed the suggestion that ``newer`` replaces ``older``."""
    stored = newer.revision_suggestion or {}
    return bool(stored.get("dismissed")) and stored.get("of") == older.file_name


def _facts_only(row: Any) -> RevisionDocument:
    return RevisionDocument(file_name=row.file_name, revision_facts=row.revision_facts)


def _title_block_pair(rows: Sequence[Any]) -> list[tuple[Any, Any, dict[str, Any]]]:
    """``(newer, older, suggestion)`` per document number whose sheets name a strictly later state."""
    groups: dict[str, list[Any]] = {}
    for row in rows:
        key = document_key((row.revision_facts or {}).get("document_number"))
        if key is not None:
            groups.setdefault(key, []).append(row)
    pairs = []
    for members in groups.values():
        if len(members) < 2:
            continue
        ordered = newest_first(members, lambda row: row.revision_facts, lambda row: row.added_at or "")
        head = ordered[0]
        older = next(
            (
                row
                for row in ordered[1:]
                if compare_revisions(head.revision_facts, row.revision_facts) == 1 and _open_to_link(row, head)
            ),
            None,
        )
        if older is None or _refused(head, older):
            continue
        reason = title_block_reason(
            _facts_only(head),
            _facts_only(older),
        )
        suggestion = {
            "of": older.file_name,
            "confidence": TITLE_BLOCK_CONFIDENCE,
            "reason": reason,
            "basis": "title_block",
        }
        pairs.append((head, older, suggestion))
    return pairs


def _sheets_disagree(newer: Any, older: Any) -> bool:
    """Whether the title blocks say ``newer`` (by its name) is NOT the later state of the same document."""
    if not same_document(newer.revision_facts, older.revision_facts):
        return False
    return compare_revisions(newer.revision_facts, older.revision_facts) in (-1, 0)


def _name_pairs(rows: Sequence[Any]) -> list[tuple[Any, Any, dict[str, Any]]]:
    """``(newer, older, suggestion)`` per file-name series: the current member over its newest unlinked older one."""
    pairs = []
    for series in find_revision_series(rows, filename=lambda row: row.file_name, created_at=lambda row: row.added_at):
        head = series.current
        older = next(
            (
                member
                for member in series.older
                if _open_to_link(member.item, head.item) and not _sheets_disagree(head.item, member.item)
            ),
            None,
        )
        if older is None or _refused(head.item, older.item):
            continue
        reason = f"Index/Datum im Dateinamen: {revision_label(head.revision)} nach {revision_label(older.revision)}"
        suggestion = {
            "of": older.item.file_name,
            "confidence": NAME_SERIES_CONFIDENCE,
            "reason": reason,
            "basis": "name",
        }
        pairs.append((head.item, older.item, suggestion))
    return pairs


def derive_suggestions(rows: Sequence[Any], held_names: Callable[[], set[str] | None]) -> dict[str, dict[str, Any]]:
    """Suggestions for documents ingested before the Fassung step existed, read from what the rows already say.

    ``rows`` are ONE collection's metadata rows (``AvailableDocument``). For each document that is the
    current member of a series, a ``{of, confidence, reason, basis}`` suggestion over the newest older
    member, keyed by the newer file name: the same ``document_number`` in the title blocks with a
    strictly later Index or date (``basis="title_block"``), else the revision grammar of the file names
    (``basis="name"``). Computed on read, stored nowhere; no model is called.

    Never for a pair a person dismissed, nor one where either file is already linked (replaced, or
    replacing the other), nor for a file whose own suggestion is stored and still open. Never naming a
    held or in-flight file (ADR-0086): ``held_names`` is read only once there is something to suggest,
    held files are then taken out BEFORE the pairs are chosen, and when it answers ``None`` (the job
    store could not be read) nothing is suggested.
    """
    if not _pairs(rows):
        return {}
    held = held_names()
    if held is None:
        return {}
    visible = [row for row in rows if row.file_name not in held]
    return {newer.file_name: suggestion for newer, _, suggestion in _pairs(visible)}


def _pairs(rows: Sequence[Any]) -> list[tuple[Any, Any, dict[str, Any]]]:
    """Title-block pairs first, then name pairs for the documents the title blocks did not cover."""
    by_block = _title_block_pair(rows)
    covered = {newer.file_name for newer, _, _ in by_block}
    pairs = by_block + [pair for pair in _name_pairs(rows) if pair[0].file_name not in covered]
    # A stored suggestion that is still open already speaks for the file.
    return [pair for pair in pairs if not _has_open_suggestion(pair[0])]


def _has_open_suggestion(row: Any) -> bool:
    stored = row.revision_suggestion or {}
    return bool(stored) and not stored.get("dismissed")


def revision_document(
    file_name: str,
    *,
    summary: str | None,
    doc_class: str | None,
    tags: Sequence[str] | None,
    revision_facts: dict[str, Any] | None = None,
) -> RevisionDocument:
    """A file as the judge may read it: name, class, tags, summary, Fassung from its name and from its title block."""
    revision = parse_revision_name(file_name)
    return RevisionDocument(
        file_name=file_name,
        summary=summary or "",
        doc_class=doc_class,
        tags=tuple(tags or ()),
        revision=revision_label(revision) if revision is not None else None,
        series_key=series_key_of(file_name),
        revision_facts=revision_facts,
    )


def held_file_names(collection: str) -> set[str] | None:
    """Names of files in ``collection`` that are quarantined or still being read; ``None`` when unknown.

    The newest job that names a file decides: a quarantine that a release then
    indexed is no longer held. ``None`` means the job store could not be read,
    and the caller must then send no name to a model.
    """
    try:
        from aiq_agent.knowledge import ingest_status_store

        in_flight = ingest_status_store.in_flight_files([collection]).get(collection, [])
        jobs = ingest_status_store.collection_jobs(collection, HELD_LOOKBACK_SECONDS)
    except Exception:  # noqa: BLE001 — unknown holds nothing back, so nothing is sent
        logger.warning("Could not read the held files of %s; no Fassung suggestion", collection, exc_info=True)
        return None
    quarantined: dict[str, bool] = {}
    for job in jobs:
        for detail in job.file_details:
            quarantined[detail.file_name] = detail.screening == "quarantined"
    return set(in_flight) | {name for name, held in quarantined.items() if held}


def read_rows(collection: str) -> list[Any]:
    """The collection's metadata rows (``AvailableDocument``), or none when they cannot be read."""
    try:
        from aiq_agent.knowledge import get_available_documents

        return list(get_available_documents(collection))
    except Exception:  # noqa: BLE001 — without rows there is nothing to compare, not a failed ingest
        logger.warning("Could not read the metadata rows of %s for Fassungen", collection, exc_info=True)
        return []


def previous_summary(rows: Sequence[Any], stored_names: Sequence[str]) -> str | None:
    """The summary a re-uploaded file had before this upload, read BEFORE the new row overwrites it."""
    wanted = set(stored_names)
    for row in rows:
        if row.file_name in wanted and (row.summary or "").strip():
            return row.summary
    return None


def candidate_documents(file_name: str, rows: Sequence[Any], held: set[str]) -> list[RevisionDocument]:
    """The rows the new file may be a newer Fassung of.

    Not itself, not a row a person already replaced, not one the person already
    dismissed for this file, not one with nothing to say, and not a held name.
    """
    own = next((row for row in rows if row.file_name == file_name), None)
    dismissed_suggestion = (own.revision_suggestion or {}) if own is not None else {}
    refused = {dismissed_suggestion["of"]} if dismissed_suggestion.get("dismissed") else set()
    return [
        revision_document(
            row.file_name,
            summary=row.summary,
            doc_class=row.doc_class,
            tags=row.tags,
            revision_facts=row.revision_facts,
        )
        for row in rows
        if row.file_name != file_name
        and not row.superseded_by
        and (row.summary or "").strip()
        and row.file_name not in held
        and row.file_name not in refused
    ]


def suggest_revision(
    collection: str,
    file_name: str,
    *,
    rows: Sequence[Any],
    summary: str,
    doc_class: str | None,
    tags: Sequence[str] | None,
    llm: Any,
    revision_facts: dict[str, Any] | None = None,
) -> dict[str, Any] | None:
    """Ask whether a new file name is a newer Fassung of another, and store the suggestion. Returns it.

    ``revision_facts`` are the new file's own title-block facts (not yet on the ``rows`` read before
    it was registered); a candidate with the same ``document_number`` is decided without the model.
    """
    held = held_file_names(collection)
    if held is None:
        return None
    candidates = candidate_documents(file_name, rows, held)
    if not candidates:
        return None
    verdict = judge_revision(
        revision_document(file_name, summary=summary, doc_class=doc_class, tags=tags, revision_facts=revision_facts),
        candidates,
        llm,
    )
    if verdict is None:
        return None
    from aiq_agent.knowledge import set_document_revision_suggestion

    suggestion = verdict.as_suggestion()
    set_document_revision_suggestion(collection, file_name, suggestion)
    return suggestion


def record_change(
    collection: str,
    file_name: str,
    *,
    previous: str | None,
    summary: str,
    llm: Any,
) -> str | None:
    """Store what changed against the previous upload of the same name; clear a stale line when none can be told.

    ``change_basis`` is the file's own name: the comparison is with its previous
    upload, which the UI labels „vorige Fassung". The old line described an
    older upload and is replaced either way.
    """
    from aiq_agent.knowledge import set_document_change_summary

    change = None
    if previous:
        change = summarize_change(
            RevisionDocument(file_name=file_name, summary=previous),
            RevisionDocument(file_name=file_name, summary=summary),
            llm,
        )
    set_document_change_summary(collection, file_name, change, file_name if change else None)
    return change


def carried_links(preserved: dict[str, str]) -> tuple[str | None, dict[str, Any] | None]:
    """The person-set link and the suggestion a replaced version's row carried, decoded.

    ``preserved`` is :class:`_PreviousVersion.preserved`: JSON text for the
    suggestion, a plain name for the link. An unreadable suggestion is dropped.
    """
    link = preserved.get("superseded_by") or None
    raw = preserved.get("revision_suggestion")
    try:
        suggestion = json.loads(raw) if raw else None
    except ValueError:
        suggestion = None
    return link, suggestion if isinstance(suggestion, dict) else None


def confirm_fassung(
    collection: str,
    file_name: str,
    older: str,
    *,
    summary: str,
    doc_class: str | None,
    tags: Sequence[str] | None,
    llm: Any,
) -> bool:
    """Write the link a person chose at upload: ``file_name`` replaces ``older``. ``False`` when it cannot be made.

    The same writes as ``PUT /v1/collections/{c}/fassung`` with ``linked=true``: ``superseded_by``
    on ``older``, a suggestion on the new file that pointed at ``older`` cleared, and what changed
    told by the summary model onto the new file with ``older`` as its basis. A failed or absent
    model leaves the link in place and the change line empty. Nothing is written when ``older``
    has no row in the collection (it was deleted meanwhile) or the link would close a loop.
    """
    if older == file_name:
        return False
    documents = {row.file_name: row for row in read_rows(collection)}
    older_row = documents.get(older)
    if older_row is None:
        logger.warning("Fassung chosen at upload: %s is not in %s; ordinary suggestion instead", older, collection)
        return False
    if would_loop(documents, newer=file_name, older=older):
        logger.warning("Fassung chosen at upload: %s already leads to %s; link refused", file_name, older)
        return False
    from aiq_agent.knowledge import set_document_change_summary
    from aiq_agent.knowledge import set_document_revision_suggestion
    from aiq_agent.knowledge import set_document_superseded_by

    if not set_document_superseded_by(collection, older, file_name):
        logger.warning("Fassung chosen at upload: %s has no metadata row in %s", older, collection)
        return False
    own = documents.get(file_name)
    if own is not None and (own.revision_suggestion or {}).get("of") == older:
        set_document_revision_suggestion(collection, file_name, None)
    change = summarize_change(
        RevisionDocument(
            file_name=older,
            summary=older_row.summary or "",
            doc_class=older_row.doc_class,
            tags=tuple(older_row.tags or ()),
        ),
        RevisionDocument(file_name=file_name, summary=summary, doc_class=doc_class, tags=tuple(tags or ())),
        llm,
    )
    if change:
        set_document_change_summary(collection, file_name, change, older)
    return True


def record_fassungen(
    collection: str,
    file_name: str,
    *,
    replaced: bool,
    rows: Sequence[Any],
    previous: str | None,
    summary: str,
    doc_class: str | None,
    tags: Sequence[str] | None,
    llm: Any,
    confirmed_older: str | None = None,
    revision_facts: dict[str, Any] | None = None,
) -> None:
    """The per-file entry point ``adapter.py`` bounds with a timeout: a link, a change line, or a suggestion.

    ``replaced``: the name was already in the collection. ``rows`` and
    ``previous`` were read before the new summary overwrote the old.
    ``confirmed_older``: the file name a person said this file replaces, at
    upload; when the link cannot be made, the ordinary paths run as if it had
    not been said. ``revision_facts``: the title block this file was just read with.
    """
    if confirmed_older and confirm_fassung(
        collection, file_name, confirmed_older, summary=summary, doc_class=doc_class, tags=tags, llm=llm
    ):
        return
    if replaced:
        record_change(collection, file_name, previous=previous, summary=summary, llm=llm)
        return
    suggest_revision(
        collection,
        file_name,
        rows=rows,
        summary=summary,
        doc_class=doc_class,
        tags=tags,
        llm=llm,
        revision_facts=revision_facts,
    )
