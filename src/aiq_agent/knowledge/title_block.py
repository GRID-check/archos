"""What a drawing's title block (Plankopf) says about the document: number, Index, date, scale, title.

The vision model reads the title block once per drawing page, during ingestion
(``sources/knowledge_layer/src/llamaindex/visual_analysis.py``); the first page
that has one is stored per document as ``revision_facts``
(``document_metadata.revision_facts``) and read back by the collection listing,
the agent's ``list_files`` and the Fassung judge. This module is the one place
that knows what such a record looks like and how two of them compare, so the
store, the parser, the judge and the listing cannot disagree:

* :func:`normalise_revision_facts` — a record as it is stored and read: only the
  known keys, each a short string, the date ISO, ``None`` when nothing is left.
  A field is printed or it is absent; nothing here fills a gap.
* :func:`document_key` / :func:`same_document` — two documents with the same
  ``document_number`` are the same document's Fassungen, whatever their file
  names say.
* :func:`compare_revisions` / :func:`newest_first` — which of two is the later
  state: the higher Index, else the later date, else unknown. A title block
  beats the file name, because it is what the office printed on the sheet.

Pure: no I/O, no framework.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Callable
from collections.abc import Mapping
from collections.abc import Sequence
from datetime import date
from typing import Any
from typing import TypeVar

T = TypeVar("T")

#: The title-block fields the vision model is asked for, in the order they are shown.
TITLE_BLOCK_FIELDS = ("document_number", "revision", "revision_date", "scale", "title")

#: Longest value kept per field. A title block is a stamp, not a paragraph.
_MAX_LENGTHS = {"document_number": 60, "revision": 16, "revision_date": 10, "scale": 40, "title": 200}

#: A document key shorter than this, or without a digit, says too little to join two documents on.
_MIN_KEY_CHARS = 3

#: Answers a model gives for "nothing printed there" instead of null.
_EMPTY_WORDS = frozenset({"-", "–", "—", "n/a", "na", "null", "none", "unbekannt", "unknown", "keine", "k.a."})

_REVISION_PREFIX = re.compile(r"^(?:index|idx|ind|revision|rev|version|ver|stand)\b\.?[\s:_-]*", re.IGNORECASE)
_ISO = re.compile(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)")
_DOTTED = re.compile(r"(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{4}|\d{2})(?!\d)")
_LETTER = re.compile(r"[A-Za-z]")
_NUMBER = re.compile(r"\d{1,3}")


def _text(value: Any, limit: int) -> str | None:
    """A stripped, whitespace-collapsed, length-capped string; ``None`` for anything that is not a printed value."""
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    text = " ".join(str(value).split())
    if not text or text.casefold() in _EMPTY_WORDS:
        return None
    return text[:limit].rstrip()


def normalise_date(value: Any) -> str | None:
    """An ISO ``YYYY-MM-DD`` from what a sheet prints (``14.08.2026``, ``14.8.26``, ``2026-08-14``), else ``None``.

    A date that is not a real calendar day, or that is only part of one
    (``08/2026``), is not a date: ``None`` rather than a repaired guess.
    """
    text = _text(value, 40)
    if text is None:
        return None
    if match := _ISO.search(text):
        year, month, day = (int(part) for part in match.groups())
    elif match := _DOTTED.search(text):
        day, month, raw_year = match.groups()
        day, month = int(day), int(month)
        year = int(raw_year) + (2000 if len(raw_year) == 2 else 0)
    else:
        return None
    try:
        return date(year, month, day).isoformat()
    except ValueError:
        return None


def normalise_revision(value: Any) -> str | None:
    """The Index as printed (``C``, ``07``, ``A1``), without the word that introduced it (``Index C`` -> ``C``)."""
    text = _text(value, 40)
    if text is None:
        return None
    text = _REVISION_PREFIX.sub("", text).strip(" .:")
    if not text or text.casefold() in _EMPTY_WORDS:
        return None
    return text[: _MAX_LENGTHS["revision"]]


def normalise_revision_facts(raw: Any) -> dict[str, Any] | None:
    """A title-block record as it is stored: the known keys that hold a value, plus ``page``; ``None`` when none does.

    ``raw`` is a reply's ``title_block`` object or a stored record. Unknown keys
    are dropped, a wrong type is dropped, ``revision_date`` is ISO or absent.
    ``page`` (1-based) says which page of the document the title block was
    read on.
    """
    if not isinstance(raw, Mapping):
        return None
    facts: dict[str, Any] = {}
    for key in TITLE_BLOCK_FIELDS:
        if key == "revision":
            value = normalise_revision(raw.get(key))
        elif key == "revision_date":
            value = normalise_date(raw.get(key))
        else:
            value = _text(raw.get(key), _MAX_LENGTHS[key])
        if value:
            facts[key] = value
    if not facts:
        return None
    page = raw.get("page")
    if isinstance(page, int) and not isinstance(page, bool) and page >= 1:
        facts["page"] = page
    return facts


def identifies_document(facts: Mapping[str, Any] | None) -> bool:
    """Whether the record says WHICH document and state this is: a number, an Index or a date (not just a title)."""
    return bool(facts) and any(facts.get(key) for key in ("document_number", "revision", "revision_date"))


# ---------------------------------------------------------------------------
# Same document
# ---------------------------------------------------------------------------


def document_key(number: Any) -> str | None:
    """What two spellings of one number share: letters and digits, folded (``A-101`` = ``a 101`` = ``A101``).

    ``None`` for a number too short, or without a digit, to join documents on.
    """
    if not isinstance(number, str):
        return None
    folded = unicodedata.normalize("NFKC", number).casefold()
    key = re.sub(r"[^0-9a-zäöüß]", "", folded)
    return key if len(key) >= _MIN_KEY_CHARS and any(ch.isdigit() for ch in key) else None


def same_document(first: Mapping[str, Any] | None, second: Mapping[str, Any] | None) -> bool:
    """Whether two title-block records carry the same ``document_number``: the same document, other state or not."""
    if not first or not second:
        return False
    key = document_key(first.get("document_number"))
    return key is not None and key == document_key(second.get("document_number"))


# ---------------------------------------------------------------------------
# Which is later
# ---------------------------------------------------------------------------


def revision_rank(revision: Any) -> tuple[str, int] | None:
    """``("letter", 1..26)`` for ``A``..``Z``, ``("number", n)`` for ``0``..``999``; ``None`` for anything else."""
    if not isinstance(revision, str):
        return None
    text = revision.strip()
    if len(text) == 1 and _LETTER.fullmatch(text):
        return "letter", ord(text.upper()) - ord("A") + 1
    if _NUMBER.fullmatch(text):
        return "number", int(text)
    return None


def _sign(left: Any, right: Any) -> int:
    return (left > right) - (left < right)


def compare_revisions(first: Mapping[str, Any] | None, second: Mapping[str, Any] | None) -> int | None:
    """``1`` when ``first`` is the later state, ``-1`` when ``second`` is, ``0`` for the same one, ``None`` if unknown.

    The Index decides when both have one of the same kind (a letter against a
    letter), then the date. Unknown, never guessed, when one side lacks what the
    other has: an Index against a missing Index, a letter against a number.
    """
    first, second = first or {}, second or {}
    rank_a, rank_b = revision_rank(first.get("revision")), revision_rank(second.get("revision"))
    by_index = _sign(rank_a[1], rank_b[1]) if rank_a and rank_b and rank_a[0] == rank_b[0] else None
    if by_index:
        return by_index
    date_a, date_b = first.get("revision_date"), second.get("revision_date")
    by_date = _sign(date_a, date_b) if date_a and date_b else None
    if by_date:
        return by_date
    return 0 if by_index == 0 or by_date == 0 else None


def newest_first(
    items: Sequence[T],
    facts_of: Callable[[T], Mapping[str, Any] | None],
    tiebreak: Callable[[T], str],
) -> list[T]:
    """``items`` of ONE document, newest state first, by a tuple (a total order, so the head never depends on the sort).

    When every item has an Index of the same kind the Index leads, then the
    date; otherwise the date leads, then the Index. ``tiebreak`` (the upload
    date) settles what the title blocks leave equal.
    """
    ranks = [revision_rank((facts_of(item) or {}).get("revision")) for item in items]
    kinds = {rank[0] if rank else None for rank in ranks}
    index_leads = len(kinds) == 1 and None not in kinds

    def key(item: T) -> tuple[int, str, int, str]:
        facts = facts_of(item) or {}
        rank = revision_rank(facts.get("revision"))
        value = rank[1] if rank else 0
        return (value if index_leads else 0, str(facts.get("revision_date") or ""), value, tiebreak(item))

    return sorted(items, key=key, reverse=True)


# ---------------------------------------------------------------------------
# How it reads
# ---------------------------------------------------------------------------


def display_date(iso: str) -> str:
    """``2026-08-14`` -> ``14.08.2026``; anything else as it is."""
    match = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", iso or "")
    return f"{match.group(3)}.{match.group(2)}.{match.group(1)}" if match else iso


def title_block_label(facts: Mapping[str, Any] | None) -> str:
    """``Nr. A-101, Index C, Stand 14.08.2026`` for the parts the record has; empty when it has none of them."""
    if not facts:
        return ""
    parts = []
    if facts.get("document_number"):
        parts.append(f"Nr. {facts['document_number']}")
    if facts.get("revision"):
        parts.append(f"Index {facts['revision']}")
    if facts.get("revision_date"):
        parts.append(f"Stand {display_date(str(facts['revision_date']))}")
    return ", ".join(parts)
