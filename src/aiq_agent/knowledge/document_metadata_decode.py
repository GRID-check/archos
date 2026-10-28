from __future__ import annotations

from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.knowledge.title_block import normalise_revision_facts

if TYPE_CHECKING:
    pass

from aiq_agent.knowledge.document_metadata_constants import SUGGESTION_BASES
from aiq_agent.knowledge.document_metadata_helpers import dismissed_revisions


def _decode_tags(raw: Any) -> list[str] | None:
    """Decode the JSON-encoded tags column back into a list (fail-open)."""
    if not raw:
        return None
    import json

    try:
        decoded = json.loads(raw)
    except TypeError, ValueError:
        return None
    if isinstance(decoded, list):
        tags = [t for t in decoded if isinstance(t, str)]
        return tags or None
    return None


def _decode_json(raw: Any, kind: type) -> Any:
    """A JSON column of the ingest's reading, when it decodes to ``kind`` and is not empty; else ``None``."""
    import json

    if not raw:
        return None
    try:
        decoded = json.loads(raw)
    except TypeError, ValueError:
        return None
    return decoded if isinstance(decoded, kind) and decoded else None


def _decode_object(cls, raw: Any) -> dict[str, Any] | None:
    """Decode the JSON ``capture`` column: only the known keys, each of its type (fail-open).

    A key outside :attr:`_CAPTURE_TYPES`, or one of the wrong type, is dropped
    rather than failing the row: the column is a record of what a camera
    wrote, and a malformed key is a fact we cannot use, not a reason to lose
    the document. ``bool`` is excluded from the numeric keys (it is an ``int``
    in Python, and a flag is not a coordinate).
    """
    if not raw:
        return None
    import json

    try:
        decoded = json.loads(raw)
    except TypeError, ValueError:
        return None
    if not isinstance(decoded, dict):
        return None
    kept: dict[str, Any] = {}
    for key, expected in cls._CAPTURE_TYPES.items():
        value = decoded.get(key)
        if value is None or isinstance(value, bool) or not isinstance(value, expected):
            continue
        if key == "captured_at" and not value.strip():
            continue
        kept[key] = value
    return kept or None


def _decode_revision_facts(raw: Any) -> dict[str, Any] | None:
    """Decode the JSON ``revision_facts`` column through the one normaliser (fail-open to ``None``)."""
    if not raw:
        return None
    import json

    try:
        return normalise_revision_facts(json.loads(raw))
    except TypeError, ValueError:
        return None


def _normalise_suggestion(value: Any) -> dict[str, Any] | None:
    """A revision suggestion as it is stored and read: exactly its six keys, each valid, or ``None``.

    ``of`` is the older file name, ``confidence`` a number in 0..1 (a flag is
    not one, and NaN is not one), ``reason`` a non-empty text, ``basis`` one
    of :data:`SUGGESTION_BASES`. ``dismissed_of`` lists every file a person
    refused as the older Fassung (:func:`dismissed_revisions`, which also reads
    the older record with one dismissed ``of``), and ``dismissed`` says whether
    ``of`` is among them. A suggestion missing any of the first four is no suggestion.
    """
    if not isinstance(value, dict):
        return None
    older, confidence = value.get("of"), value.get("confidence")
    reason, basis = value.get("reason"), value.get("basis")
    if not isinstance(older, str) or not older.strip():
        return None
    if isinstance(confidence, bool) or not isinstance(confidence, int | float) or not 0.0 <= confidence <= 1.0:
        return None
    if not isinstance(reason, str) or not reason.strip() or basis not in SUGGESTION_BASES:
        return None
    refused = dismissed_revisions(value)
    return {
        "of": older,
        "confidence": float(confidence),
        "reason": reason.strip(),
        "basis": basis,
        "dismissed": older in refused,
        "dismissed_of": refused,
    }


def _decode_suggestion(cls, raw: Any) -> dict[str, Any] | None:
    """Decode the JSON ``revision_suggestion`` column (fail-open to ``None``)."""
    if not raw:
        return None
    import json

    try:
        return cls._normalise_suggestion(json.loads(raw))
    except TypeError, ValueError:
        return None
