from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.knowledge.document_classification import canonical_doc_class
from aiq_agent.knowledge.page_count import page_number

if TYPE_CHECKING:
    pass

from aiq_agent.knowledge import document_metadata_store as facade
from aiq_agent.knowledge.document_metadata_constants import _RETAINED_COLUMNS
from aiq_agent.knowledge.document_metadata_constants import REFUSAL_REASON
from aiq_agent.knowledge.document_metadata_constants import TABLE_NAME


class LinkOutcome(StrEnum):
    """What :meth:`DocumentMetadataStore.link_revision` did."""

    LINKED = "linked"
    #: ``newer`` already leads to ``older`` through replacements; nothing was written.
    LOOP = "loop"
    #: ``older`` has no metadata row in the collection; nothing was written.
    MISSING = "missing"


def _current_doc_class(value: str | None) -> str | None:
    """``value`` in the current vocabulary; a value outside it (a future class) as stored."""
    return canonical_doc_class(value) or value


def dismissed_revisions(suggestion: Any) -> list[str]:
    """The file names a person refused as the older Fassung of a document, oldest refusal first.

    Reads the stored record in both shapes: the current one carries ``dismissed_of``; a record
    written before that carries one ``of`` with ``dismissed: true``. Anything else refuses nothing.
    """
    if not isinstance(suggestion, dict):
        return []
    names = [name for name in suggestion.get("dismissed_of") or () if isinstance(name, str) and name.strip()]
    older = suggestion.get("of")
    if suggestion.get("dismissed") is True and isinstance(older, str) and older.strip() and older not in names:
        names.append(older)
    return list(dict.fromkeys(names))


def _link_lock_key(collection: str) -> int:
    """The signed 64-bit advisory-lock key that serialises link writes within one collection (Postgres).

    The ``grid-fassung-link:`` salt stays German on purpose. It is the key every running pod derives, so renaming
    it would let an old pod and a new pod take different locks for the same collection during a rollout and
    store a loop (A over B and B over A). It names no code identifier; it is a value that has to stay as it was.
    """
    digest = hashlib.sha256(f"grid-fassung-link:{collection}".encode()).digest()
    return int.from_bytes(digest[:8], "big", signed=True)


@dataclass(frozen=True, slots=True)
class _LinkRow:
    """What :meth:`DocumentMetadataStore.link_revision` reads of each row of the collection."""

    superseded_by: str | None
    change_basis: str | None
    revision_suggestion: str | None


def _set_columns(conn, collection: str, filename: str, **values: Any) -> None:
    """UPDATE the named Fassung columns of one row on the caller's connection."""
    from sqlalchemy import text

    unknown = set(values) - set(_RETAINED_COLUMNS)
    if unknown:
        raise ValueError(f"not a Fassung column: {sorted(unknown)}")
    assignments = ", ".join(f"{column} = :{column}" for column in values)
    conn.execute(
        # nosemgrep: python.sqlalchemy.security.audit.avoid-sqlalchemy-text.avoid-sqlalchemy-text
        text(f"UPDATE {TABLE_NAME} SET {assignments} WHERE collection = :collection AND filename = :filename"),
        {**values, "collection": collection, "filename": filename},
    )


def _refusal_record(refused: list[str]) -> dict[str, Any] | None:
    """The stored record when a person refused files and nothing is suggested: the latest refusal as its ``of``."""
    if not refused:
        return None
    return {
        "of": refused[-1],
        "confidence": 0.0,
        "reason": REFUSAL_REASON,
        "basis": "name",
        "dismissed": True,
        "dismissed_of": refused,
    }


def _merged_suggestion(stored: dict[str, Any] | None, new: dict[str, Any] | None) -> dict[str, Any] | None:
    """``new`` as it is stored over ``stored``: the refusals of both kept, and dismissed when it names one of them.

    ``new`` of ``None`` clears the open suggestion; what is left is the refusals, or nothing.
    """
    refused = list(dict.fromkeys(dismissed_revisions(stored) + dismissed_revisions(new)))
    if new is None:
        return _refusal_record(refused)
    return {**new, "dismissed": new["of"] in refused, "dismissed_of": refused}


def _with_refusal(stored: dict[str, Any] | None, older: str) -> dict[str, Any]:
    """``stored`` with ``older`` refused: the open suggestion dismissed when it names ``older``, else kept open."""
    refused = [name for name in dismissed_revisions(stored) if name != older] + [older]
    if stored is None or stored["of"] == older or stored["dismissed"]:
        return {**(stored or {}), **_refusal_record(refused), **_kept_reason(stored, older)}
    return {**stored, "dismissed_of": refused}


def _person_made_facts(
    filename: str,
    superseded_by: str | None,
    revision_suggestion: str | None,
    change_summary: str | None,
    change_basis: str | None,
) -> dict[str, str | None] | None:
    """What a reversible purge keeps of a row: the confirmed link, the refusals, a change line against a link.

    An open suggestion is Piloti's advice and is read again; a change line told against the
    document's own earlier upload (``change_basis`` is its own name) describes bytes the re-read
    replaces. ``None`` when nothing a person made is on the row.
    """
    refusals = _merged_suggestion(facade.DocumentMetadataStore._decode_suggestion(revision_suggestion), None)
    linked_change = bool(change_summary) and bool(change_basis) and change_basis != filename
    kept = {
        "superseded_by": superseded_by or None,
        "revision_suggestion": json.dumps(refusals) if refusals else None,
        "change_summary": change_summary if linked_change else None,
        "change_basis": change_basis if linked_change else None,
    }
    return kept if any(kept.values()) else None


def _encode_page_count(page_count: int | None) -> int | None:
    """``page_count`` as stored: a whole number of pages of at least one, otherwise ``None`` (no pages known)."""
    if isinstance(page_count, bool) or not isinstance(page_count, int) or page_count < 1:
        return None
    return page_count


def _decode_page_count(raw: Any) -> int | None:
    """The stored page count as an ``int``; ``None`` for a missing, zero or non-numeric value.

    The one parse of a page number (``page_count.page_number``), shared with the listing and the backfill.
    """
    return page_number(raw)


def _kept_reason(stored: dict[str, Any] | None, older: str) -> dict[str, Any]:
    """The suggestion's own reason, confidence and basis when the refusal is of the file it named."""
    if stored is None or stored["of"] != older:
        return {}
    return {key: stored[key] for key in ("confidence", "reason", "basis")}


# Every raw-SQL statement in this module interpolates ONLY trusted, code-defined
# SQL identifiers: the table/index name constants above, and column names drawn
# from a fixed allowlist (``_OPTIONAL_COLUMNS`` plus the literal
# ``"tags"``/``"doc_class"``/``"display_title"``/``"folder_path"``/``"provenance"``/
# ``"doc_class_suggestion"``/``"topics"``/``"capture"``/``"superseded_by"``/
# ``"revision_suggestion"``/``"revision_facts"`` passed by the typed accessors).
# SQL identifiers cannot be bound parameters, so they must live in the statement
# text. Every caller-supplied *value* (collection, filename, summary, tags,
# display_title, …) is always passed as a bound ``:param`` and never interpolated.
# The interpolation is therefore not attacker-reachable, which is why each
# ``sqlalchemy.text()`` call below carries a ``# nosemgrep: …avoid-sqlalchemy-text``
# marker for the taint-based SAST rule.


def _escape_like(value: str) -> str:
    """Escape SQL ``LIKE`` metacharacters so a path matches only itself.

    The TS twin is ``escapeLikePattern`` in ``folder-service.ts``; both exist so
    a folder called ``100 % Plans`` cannot prefix-match half the project.
    """
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
