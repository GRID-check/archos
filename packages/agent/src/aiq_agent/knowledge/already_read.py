"""Conversation-scoped "already read" digest: what THIS conversation opened.

Cross-turn amnesia looked like this: turn 1 opened ``oib-rl_2_ausgabe_mai_2023.pdf``
at Pkt. 3.5.2, turn 2 asked a follow-up naming the same document, and the model
paid a full ``knowledge_search`` — competing by similarity with every
neighbouring requirement — for a passage it could already address with the
``read_passage`` locator. The inventory cannot fix that: it proves a file
EXISTS, not that it was read.

This module is the missing half: one line per document this conversation
already opened — ``"<file> | <collection> | Seiten <p> | Punkte <n> | Turn <k>"``
— merged at turn end from :func:`get_turn_captures`, persisted on
``ConversationState`` for the life of the conversation, and rendered right
after the document inventory as ``## Bereits gelesen (diese Unterhaltung)``.

Deliberate non-goals, each a sentence so the next reader does not re-litigate:

- NOT project memory: the digest rides the conversation checkpoint (same
  lifetime as ``messages``), never the memory store, so no other conversation
  ever sees it. Single conversation scope only.
- NOT lessons: nothing is anonymized or distilled across conversations here.
- No key versioning: a stale entry (a newer edition filed since) is not
  detected up front — ``read_passage`` answers it with no-passage/unknown and
  the turn falls back to ``knowledge_search`` (miss-then-search).
- Index, not evidence: a line proves the document was OPENED, not that its
  wording is in front of the model now. Quoting or citing re-opens the passage
  with ``read_passage`` under the exact digest name; the digest line itself is
  never cited.
"""

from __future__ import annotations

import logging
from collections import OrderedDict
from collections.abc import Sequence
from dataclasses import dataclass
from dataclasses import field
from typing import Any

logger = logging.getLogger(__name__)

#: Heading of the rendered block, the anchor the prompt rule names.
DIGEST_HEADING = "## Bereits gelesen (diese Unterhaltung)"

#: How many documents the digest keeps. Past this the oldest entries drop out,
#: most-recent-first retention, so the digest is the recent working set.
MAX_DIGEST_DOCS = 20

#: Approximate token budget for the whole digest (the entry lines only, not the
#: explanation around them). Tokens are estimated as characters // 4; past this the oldest
#: entries drop out exactly like past the document cap.
MAX_DIGEST_TOKENS = 800

#: The longest page run a digest line may hold as a range; a longer one is a hand-edited line, not a read.
MAX_DIGEST_PAGE_RUN = 500


@dataclass
class DigestEntry:
    """One digested document: identity plus the loci this conversation opened."""

    file_name: str
    collection: str
    pages: set[int] = field(default_factory=set)
    clauses: set[str] = field(default_factory=set)
    turn: int = 1


def estimate_tokens(text: str) -> int:
    """Rough token count for budget enforcement: characters // 4, at least 1."""
    return max(1, len(text) // 4)


def _clause_sort_key(raw: str) -> tuple:
    """Numeric Punkt ordering (``3.5.2`` before ``3.12``), then lexicographic."""
    try:
        numbered = tuple(int(part) for part in raw.split(".")) if raw else ()
    except ValueError:
        numbered = ()
    return (numbered, raw)


def _page_runs(pages: Sequence[int]) -> str:
    """Sorted ``pages`` with runs of three or more as ranges: ``1, 2, 4-6, 9``.

    A ranged read (``read_passage(pages="4-6")``) opens a run of pages, and the digest names it the
    way ``read_passage`` accepts it back, rather than one number per page.
    """
    parts: list[str] = []
    ordered = sorted(pages)
    index = 0
    while index < len(ordered):
        end = index
        while end + 1 < len(ordered) and ordered[end + 1] == ordered[end] + 1:
            end += 1
        if end - index >= 2:
            parts.append(f"{ordered[index]}-{ordered[end]}")
        else:
            parts.extend(str(page) for page in ordered[index : end + 1])
        index = end + 1
    return ", ".join(parts)


def _parse_page_token(token: str) -> set[int]:
    """One digest page token (``7`` or ``4-6``) as pages; raises ``ValueError`` when it is neither."""
    first, dash, last = token.strip().partition("-")
    start, end = int(first), int(last) if dash else int(first)
    if end < start or end - start > MAX_DIGEST_PAGE_RUN:
        raise ValueError(token)
    return set(range(start, end + 1))


def format_digest_line(
    file_name: str, collection: str, pages: set[int] | Sequence[int], clauses: set[str] | Sequence[str], turn: int
) -> str:
    """One digest line: ``"<file> | <collection> | Seiten <p> | Punkte <n> | Turn <k>"``."""
    ordered_pages = sorted({int(page) for page in pages})
    ordered_clauses = sorted({str(clause) for clause in clauses if str(clause).strip()}, key=_clause_sort_key)
    pages_bit = _page_runs(ordered_pages) if ordered_pages else "-"
    clauses_bit = ", ".join(ordered_clauses) if ordered_clauses else "-"
    return f"{file_name} | {collection} | Seiten {pages_bit} | Punkte {clauses_bit} | Turn {max(1, int(turn))}"


def parse_digest_line(line: str) -> DigestEntry | None:
    """Parse a digest line back into an entry; ``None`` when malformed.

    Fail-open on purpose: the digest is re-parsed every turn to merge the new
    captures, and one hand-edited or version-skewed line must not lose the rest.
    """
    parts = [part.strip() for part in str(line or "").split(" | ")]
    if len(parts) != 5:
        return None
    file_name, collection, pages_part, clauses_part, turn_bit = parts
    if (
        not file_name
        or not collection
        or not pages_part.startswith("Seiten ")
        or not clauses_part.startswith("Punkte ")
    ):
        return None
    if not turn_bit.startswith("Turn "):
        return None
    try:
        turn = max(1, int(turn_bit[len("Turn ") :].strip()))
    except ValueError:
        return None
    pages: set[int] = set()
    raw_pages = pages_part[len("Seiten ") :].strip()
    if raw_pages and raw_pages != "-":
        for token in raw_pages.split(","):
            try:
                pages |= _parse_page_token(token)
            except ValueError:
                return None
    clauses: set[str] = set()
    raw_clauses = clauses_part[len("Punkte ") :].strip()
    if raw_clauses and raw_clauses != "-":
        clauses = {token.strip() for token in raw_clauses.split(",") if token.strip()}
        if not clauses:
            return None
    return DigestEntry(file_name=file_name, collection=collection, pages=pages, clauses=clauses, turn=turn)


def _capture_identity(entry: Any) -> tuple[str, str, str, str] | None:
    """The ``(key, file, collection, display)`` of a capture, or ``None`` to skip it.

    Only knowledge documents digest: an entry needs a citation key whose
    filename looks like a file (an extension in the basename, the same test the
    citation wire uses), so bare tool-result sources and URL-only hits never
    become digest lines. The key is ``(collection, filename)`` case-folded — the
    registry's own document identity — while the display keeps first-seen
    spelling, which is what ``read_passage`` resolves verbatim.
    """
    from aiq_agent.citations.citation_keys import parse_citation_key

    citation_key = getattr(entry, "citation_key", None) or ""
    if not citation_key:
        return None
    file_name, _page = parse_citation_key(citation_key)
    file_name = (file_name or "").strip()
    if not file_name or "." not in file_name.rsplit("/", 1)[-1]:
        return None
    collection = str(getattr(entry, "collection", None) or "").strip() or "-"
    return (f"{collection.casefold()}\x1f{file_name.casefold()}", file_name, collection, citation_key)


def _capture_page(entry: Any) -> int | None:
    from aiq_agent.citations.citation_keys import parse_citation_key

    _file_name, page = parse_citation_key(getattr(entry, "citation_key", None) or "")
    return page


def _capture_clause(entry: Any) -> str | None:
    clause = str(getattr(entry, "clause", None) or "").strip()
    return clause or None


def merge_digest(previous: Sequence[str] | None, captures: Sequence[Any], turn: int) -> list[str] | None:
    """Merge this turn's captures into the previous digest lines.

    Dedupe is per ``(collection, filename)`` with page/Punkt sets unioned and
    ``Turn`` set to the current turn; an updated document moves to the end
    (most-recent-first retention is by POSITION, never by the Turn number,
    which is display only and may run low again after history trimming).
    Over either cap — 20 documents or ~800 tokens — the oldest entries drop
    out. ``None`` when nothing digestible remains, so the field stays absent
    rather than empty.
    """
    current = max(1, int(turn))
    merged: OrderedDict[str, DigestEntry] = OrderedDict()
    for line in previous or ():
        parsed = parse_digest_line(line)
        if parsed is None:
            continue
        key = f"{parsed.collection.casefold()}\x1f{parsed.file_name.casefold()}"
        known = merged.get(key)
        if known is None:
            merged[key] = parsed
        else:
            known.pages |= parsed.pages
            known.clauses |= parsed.clauses
            known.turn = max(known.turn, parsed.turn)
    for entry in captures or ():
        identity = _capture_identity(entry)
        if identity is None:
            continue
        key, file_name, collection, _citation_key = identity
        page = _capture_page(entry)
        clause = _capture_clause(entry)
        known = merged.get(key)
        if known is None:
            merged[key] = DigestEntry(
                file_name=file_name,
                collection=collection,
                pages={page} if page is not None else set(),
                clauses={clause} if clause else set(),
                turn=current,
            )
        else:
            if page is not None:
                known.pages.add(page)
            if clause:
                known.clauses.add(clause)
            known.turn = current
            merged.move_to_end(key)
    lines = [
        format_digest_line(item.file_name, item.collection, item.pages, item.clauses, item.turn)
        for item in merged.values()
    ]
    while len(lines) > MAX_DIGEST_DOCS:
        lines.pop(0)
    while len(lines) > 1 and sum(estimate_tokens(line) for line in lines) > MAX_DIGEST_TOKENS:
        lines.pop(0)
    return lines or None


def render_already_read_block(digest: Sequence[str] | None) -> str:
    """The prompt block for a digest, or ``""`` when there is nothing digested.

    Carries the index-not-evidence rule and the bound in the text the model
    reads, the same obligation the inventory block holds: bounded, and saying
    so where the cost is paid.
    """
    lines = [line.strip() for line in (digest or []) if line and line.strip()]
    if not lines:
        return ""
    return "\n".join(
        [
            DIGEST_HEADING,
            "Documents already opened in THIS conversation — an index, NOT evidence: "
            "a line proves that the document was opened, not that its wording is available now "
            "(the passages of the PREVIOUS turn are still in the transcript; older ones are not). "
            "Cite or quote verbatim only after opening it again by the exact name from the line; "
            "the digest line itself is never cited.",
            f"Limited to at most {MAX_DIGEST_DOCS} documents / about {MAX_DIGEST_TOKENS} tokens — "
            "older entries drop out; what is missing here is therefore not ruled out, but is to be "
            "searched with `knowledge_search`. Entries can be outdated (a newer Fassung was filed): "
            "if the read finds no such document or passage, resolve again with `knowledge_search`.",
            *[f"- {line}" for line in lines],
        ]
    )
