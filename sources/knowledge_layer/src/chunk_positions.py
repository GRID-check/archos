"""A chunk's own text: what a literal search counts once per place in the document.

A stored chunk is not a slice of the document. Two things in its ``text`` are there twice:

* **The breadcrumb.** A section chunk (``llamaindex/section_chunking.chunk_text``) opens with
  ``A › B › C`` and a blank line; a Punkt chunk (``clause_chunking.clause_documents``) with the
  Richtlinie's label and its ancestors' path; a table part with its caption, every part again.
  The section's heading lines are cut from the body and live only in that breadcrumb, so the
  heading is the document's text exactly once: in the first part of its own section. Matched as
  it stands, „Rettungsweg“ counts once per chunk of chapter „3 Rettungswege und Aufzug“.
* **The overlap.** The chunkers repeat the end of chunk n at the head of chunk n+1 (96 tokens
  in a section, 128 in a page split; across page breaks too in a section). A word there is in
  both chunks, so it counted twice and its lines showed twice.

:func:`own_texts` gives every matched chunk an :class:`OwnText`: the text the reader would see
at that place (the chunk's own heading line on its first part, then the body without the
breadcrumb) and the span of it that repeats its predecessor. A match lying wholly inside that
span is the predecessor's and is not counted here (:func:`own_matches`); a match that starts in
the repeated head and runs on into the chunk's own text belongs to this chunk, because the
predecessor does not hold all of it.

The predecessor is the chunk with ``chunk_ordinal - 1`` of the same file, collection and cut
(``chunking``), among the chunks the search returned. That is enough: a match wholly inside the
overlap is in the predecessor too, so the predecessor matched and was returned, unless the scan
stopped at its cap first (then the table already says "at least", and a pair split by the cap
may still count twice). A legacy point without ``chunk_ordinal`` (written before the field
existed) has no known neighbour; its predecessor is looked for among the returned ordinal-less
chunks of the same file and page whose tail its head repeats (the per-page splitter never
overlaps across a page; at most :data:`MAX_LEGACY_PAGE_CHUNKS` of them), and without one it
counts as it stands.

Pure: no store, no I/O. The citable passages are the chunks as stored; only counting and the
context lines read the own text.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

#: The separator both chunkers join a breadcrumb with (``section_chunking.BREADCRUMB_SEP``).
BREADCRUMB_SEP = " › "

#: The longest repeated head :func:`repeated_head` will cut, in characters. The chunkers overlap
#: neighbours by about 96 tokens; anything much longer is not an overlap but a coincidence.
MAX_OVERLAP_CHARS = 1_200

#: The shortest repeat worth cutting: a heading or a table header that a neighbouring chunk
#: happens to repeat is the chunk's own text, not overlap.
MIN_OVERLAP_WORDS = 8
MIN_OVERLAP_CHARS = 40

#: The most returned ordinal-less chunks of one page compared pairwise for their overlap.
MAX_LEGACY_PAGE_CHUNKS = 32

#: The marker a visual or uncaptioned-table chunk opens with: the pipeline's words, not the document's.
_MARKER = re.compile(r"\[(?:TABLE|DRAWING) from page \d+\](?: \(Teil \d+ von \d+\))?\n\n")
#: The part suffix a table caption carries from its second row group on.
_PART_SUFFIX = re.compile(r" \(Teil \d+ von \d+\)$")


@dataclass(frozen=True)
class OwnText:
    """The text a match is counted and shown on, and ``[repeat_start, repeat_end)``: the head its predecessor holds."""

    text: str
    repeat_start: int = 0
    repeat_end: int = 0

    def counts(self, start: int, end: int) -> bool:
        """Whether a match at ``[start, end)`` is this chunk's: non-empty, and not wholly inside the repeated head."""
        if end <= start:
            return False
        return not (self.repeat_start <= start and end <= self.repeat_end and self.repeat_end > self.repeat_start)


def words_with_offsets(text: str) -> list[tuple[str, int]]:
    return [(match.group(), match.start()) for match in re.finditer(r"\S+", text)]


def repeated_head(previous: str, text: str) -> int:
    """How many characters of ``text`` repeat the end of ``previous``; 0 when they do not, or would be all of it.

    Only a repeat that ends within :data:`MAX_OVERLAP_CHARS` of ``text`` counts, so only the words
    that start there are candidates, and only a count whose first word is ``text``'s first word is
    compared: linear in practice, where trying every count was quadratic in the chunk's words.
    """
    after = words_with_offsets(text[: MAX_OVERLAP_CHARS + 1])
    if len(after) <= MIN_OVERLAP_WORDS:
        return 0
    tail = previous[-(MAX_OVERLAP_CHARS * 2) :]
    before = [word for word, _ in words_with_offsets(tail)]
    if len(tail) < len(previous):
        before = before[1:]  # the slice may have cut its first word in two
    words = [word for word, _ in after]
    longest = min(len(before), len(after) - 1)
    for count in range(longest, MIN_OVERLAP_WORDS - 1, -1):
        if before[-count] != words[0] or before[-count:] != words[:count]:
            continue
        end = after[count][1]
        return end if MIN_OVERLAP_CHARS <= end <= MAX_OVERLAP_CHARS else 0
    return 0


def _metadata(chunk: Any) -> dict[str, Any]:
    return getattr(chunk, "metadata", None) or {}


def _int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    try:
        return int(str(value))
    except TypeError, ValueError:
        return None


def _first_part(metadata: dict[str, Any], key: str) -> bool:
    part = _int(metadata.get(key))
    return part is None or part == 1


def _section_prefix(text: str, metadata: dict[str, Any]) -> tuple[int, str]:
    """A section chunk: ``breadcrumb\\n\\nbody``; the heading is the breadcrumb's last label, on part 1 only."""
    path = str(metadata.get("clause_path") or "")
    if not path or not (text == path or text.startswith(f"{path}\n\n")):
        return 0, ""
    heading = path.rsplit(BREADCRUMB_SEP, 1)[-1] if _first_part(metadata, "section_part") else ""
    return min(len(text), len(path) + 2), heading


def _clause_prefix(text: str, metadata: dict[str, Any]) -> tuple[int, str]:
    """A Punkt chunk: ``label[\\nancestors]\\n\\nPunkt``; the Punkt's own line is in its body, so no heading."""
    path = str(metadata.get("clause_path") or "")
    clause_id = str(metadata.get("clause_id") or "")
    head, separator, rest = text.partition("\n\n")
    if not separator or not clause_id or not rest.lstrip().startswith(clause_id):
        return 0, ""
    lines = head.split("\n")
    ancestors = path.rsplit(BREADCRUMB_SEP, 1)[0] if BREADCRUMB_SEP in path else None
    if lines != lines[:1] + ([ancestors] if ancestors else []):
        return 0, ""
    return len(head) + 2, ""


def _table_prefix(text: str, metadata: dict[str, Any]) -> tuple[int, str]:
    """A captioned table part: ``[label\\n]caption[ (Teil i von n)]\\n\\nrows``; the caption counts on part 1 only."""
    caption = str(metadata.get("clause_path") or "")
    head, separator, _rest = text.partition("\n\n")
    if not separator or not caption:
        return 0, ""
    lines = head.split("\n")
    if len(lines) > 2 or _PART_SUFFIX.sub("", lines[-1]) != caption:
        return 0, ""
    return len(head) + 2, caption if _first_part(metadata, "table_part") else ""


def split_prefix(chunk: Any) -> tuple[int, str]:
    """``(where the body starts, the heading this chunk holds once)``: the pipeline's prefix, the document's heading.

    The prefix is cut only where it reads exactly as the chunker wrote it (its ``clause_path``
    restated, a marker): a chunk the splitter cut again, or one written by another path, keeps its
    whole text. The heading is ``""`` where the chunk restates none of its own.
    """
    text = getattr(chunk, "content", "") or ""
    metadata = _metadata(chunk)
    chunking = metadata.get("chunking")
    if chunking == "section":
        return _section_prefix(text, metadata)
    if chunking == "clause":
        return _clause_prefix(text, metadata)
    if chunking == "table":
        return _table_prefix(text, metadata)
    marker = _MARKER.match(text)
    return (marker.end(), "") if marker else (0, "")


def body(chunk: Any) -> str:
    """The chunk's text after its breadcrumb or marker."""
    start, _heading = split_prefix(chunk)
    return (getattr(chunk, "content", "") or "")[start:]


def _is_text(chunk: Any) -> bool:
    kind = getattr(chunk, "content_type", None)
    return getattr(kind, "value", kind) in (None, "text")


def _key(chunk: Any) -> tuple[str, str, str]:
    metadata = _metadata(chunk)
    return (
        str(metadata.get("collection") or ""),
        str(getattr(chunk, "file_name", "") or ""),
        str(metadata.get("chunking")),
    )


def _ordinal(chunk: Any) -> int | None:
    return _int(_metadata(chunk).get("chunk_ordinal"))


def _predecessors(chunks: Sequence[Any]) -> dict[int, Any]:
    """Per chunk (by index), the returned chunk it overlaps: ``chunk_ordinal - 1``, else the legacy fallback."""
    by_ordinal: dict[tuple[tuple[str, str, str], int], Any] = {}
    legacy: dict[tuple[tuple[str, str, str], Any], list[Any]] = {}
    for chunk in chunks:
        if not _is_text(chunk):
            continue
        ordinal = _ordinal(chunk)
        if ordinal is not None:
            by_ordinal[(_key(chunk), ordinal)] = chunk
        else:
            legacy.setdefault((_key(chunk), getattr(chunk, "page_number", None)), []).append(chunk)
    found: dict[int, Any] = {}
    for index, chunk in enumerate(chunks):
        if not _is_text(chunk):
            continue
        ordinal = _ordinal(chunk)
        if ordinal is not None:
            previous = by_ordinal.get((_key(chunk), ordinal - 1))
        else:
            previous = _legacy_predecessor(chunk, legacy.get((_key(chunk), getattr(chunk, "page_number", None)), []))
        if previous is not None:
            found[index] = previous
    return found


def _legacy_predecessor(chunk: Any, page: Sequence[Any]) -> Any:
    """Among the ordinal-less chunks of one page, the one whose tail ``chunk``'s head repeats longest.

    Pairwise, so only on a page of at most :data:`MAX_LEGACY_PAGE_CHUNKS` returned chunks (a file
    without pages, a text file, is one "page" of all its chunks): past it the chunk counts as stored.
    """
    if len(page) > MAX_LEGACY_PAGE_CHUNKS:
        return None
    mine = body(chunk)
    best, longest = None, 0
    for other in page:
        if other is chunk:
            continue
        cut = repeated_head(body(other), mine)
        if cut > longest:
            best, longest = other, cut
    return best


def own_text(chunk: Any, previous: Any = None) -> OwnText:
    """``chunk``'s own text: its heading line once (first part), its body, and the head ``previous`` holds."""
    start, heading = split_prefix(chunk)
    text = (getattr(chunk, "content", "") or "")[start:]
    lead = f"{heading}\n" if heading else ""
    cut = repeated_head(body(previous), text) if previous is not None else 0
    return OwnText(f"{lead}{text}", len(lead), len(lead) + cut)


def own_texts(chunks: Sequence[Any]) -> list[OwnText]:
    """:func:`own_text` of each chunk, in order, its predecessor found among ``chunks``."""
    previous = _predecessors(chunks)
    return [own_text(chunk, previous.get(index)) for index, chunk in enumerate(chunks)]


def own_matches(own: OwnText, pattern: Any, timeout: float | None = None) -> Iterator[Any]:
    """The matches of ``pattern`` that are this chunk's: non-empty and not wholly in the repeated head.

    ``timeout`` is the ``regex`` module's (a person's pattern); ``re`` patterns take none.
    """
    found = pattern.finditer(own.text) if timeout is None else pattern.finditer(own.text, timeout=timeout)
    return (match for match in found if own.counts(match.start(), match.end()))
