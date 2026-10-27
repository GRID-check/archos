"""The answer's Quellen section and its inline ``[n]`` citations.

The patterns that find them, and which registered source a reference line names.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterator

from aiq_agent.citations.citation_keys import PAGE_RE
from aiq_agent.citations.citation_keys import SCOPE_QUALIFIER_TOKEN_RE
from aiq_agent.citations.citation_keys import TITLE_PAGE_RE
from aiq_agent.citations.citation_keys import parse_citation_key
from aiq_agent.citations.entries import SourceEntry
from aiq_agent.citations.markdown_code import code_spans
from aiq_agent.citations.markdown_code import inside
from aiq_agent.citations.registry import SourceRegistry
from aiq_agent.common.source_kinds import shelf_for_qualifier
from aiq_agent.common.source_kinds import shelf_qualifier

logger = logging.getLogger(__name__)


# German labels are first-class: reports written in German use "Quellen" &c.,
# and failing to recognize them appended a duplicate English "## Sources"
# section while mangling the original block.
_GERMAN_REFERENCE_HEADING_LABEL_PATTERN = r"(?:Quellen(?:verzeichnis|angaben)?|Literatur(?:verzeichnis)?|Referenzen)"


_REFERENCE_HEADING_LABEL_PATTERN = (
    r"(?:Sources|References|Reference[^\S\n]+List|" + _GERMAN_REFERENCE_HEADING_LABEL_PATTERN + r")"
)


GERMAN_REFERENCE_HEADING_LABEL_RE = re.compile(
    rf"{_GERMAN_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?[^\S\n]*\**[^\S\n]*$", re.IGNORECASE
)


_REFERENCE_HEADING_PATTERN = (
    r"^[^\S\n]*(?:"
    rf"#{{1,3}}[^\S\n]+{_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?"
    rf"|\*\*{_REFERENCE_HEADING_LABEL_PATTERN}:?\*\*"
    rf"|{_REFERENCE_HEADING_LABEL_PATTERN}[^\S\n]*:?"
    r")[^\S\n]*$"
)


_REFERENCE_ENTRY_START_PATTERN = r"(?:[-*][^\S\n]*)?(?:\[\d+\]|\[\^\d+\]:?|\d+[.)])[^\S\n]+"


REFERENCE_SECTION_RE = re.compile(
    rf"{_REFERENCE_HEADING_PATTERN}(?=\n[^\S\n]*(?:\n[^\S\n]*)*{_REFERENCE_ENTRY_START_PATTERN})",
    re.MULTILINE | re.IGNORECASE,
)


REFERENCE_HEADING_LINE_RE = re.compile(_REFERENCE_HEADING_PATTERN, re.IGNORECASE)


CITATION_LINE_RE = re.compile(r"^\s*[-*]?\s*\[(\d+)\]\s*(.+)$", re.MULTILINE)


ORDERED_REFERENCE_LINE_RE = re.compile(r"^(\s*)(\d+)[.)]\s+(.+)$", re.MULTILINE)


COLLAPSED_SOURCE_BOUNDARY_RE = re.compile(r"\s+(?=\[(\d+)\]\s+)")


INLINE_CITATION_RE = re.compile(r"\[(\d+)\]")


#: A marker naming several sources at once: ``[2–5]``, ``[2, 3]``, ``[1-3, 7]``.
#: Not the label of a Markdown link (``[1-3](url)``): expanded, that link would
#: lose its label to three markers. The same guard as ``surface_citations._CITATION``.
#: Each part is a source number as the model writes one: no leading zero, so
#: ``[1,000]`` and ``[0, 1]`` stay as written. A German decimal ``[1,5]`` still
#: reads as two citations: the model writes ``[1,2]`` for two sources too, and
#: no character tells them apart. The verifier removes whichever of the two
#: names no source line.
_GROUPED_CITATION_RE = re.compile(r"(?<!\[)\[([1-9]\d{0,2}(?:\s*[,–-]\s*[1-9]\d{0,2})+)\](?![\](])")


#: The widest range read as citations; wider is a bracketed figure (``[1990–2020]``
#: fails the digit bound anyway) or a slip, and stays as written.
_MAX_CITATION_RANGE = 20


def expand_grouped_citations(text: str, *, unterminated_fence_is_code: bool = False) -> str:
    """``[2–5]`` → ``[2][3][4][5]`` and ``[2, 3]`` → ``[2][3]``.

    The model is told to write one marker per source and sometimes writes a
    range. Every reader downstream knows ``[N]`` only: the verifier checked
    none of a range's sources and removed none of them, and the chat showed
    ``[2–5]`` as literal text beside its neighbours' pills (answer suite,
    2026-09-24). Expanded first, each source is verified and linked alone.

    Code is left as written: ``grid[1, 2]`` is an index, not two citations.
    A reader of a text still being written passes
    ``unterminated_fence_is_code=True`` (see :func:`code_spans`).
    """
    code = code_spans(text, unterminated_fence_is_code=unterminated_fence_is_code)

    def expand(match: re.Match) -> str:
        if inside(match.start(), code):
            return match.group(0)
        numbers: list[int] = []
        for part in re.split(r"\s*,\s*", match.group(1)):
            bounds = [int(bound) for bound in re.split(r"\s*[–-]\s*", part)]
            if len(bounds) == 1:
                numbers.append(bounds[0])
                continue
            low, high = bounds[0], bounds[-1]
            if len(bounds) != 2 or not 0 < low < high or high - low > _MAX_CITATION_RANGE:
                return match.group(0)
            numbers.extend(range(low, high + 1))
        # ``[1–3, 2]`` names source 2 once.
        return "".join(f"[{number}]" for number in dict.fromkeys(numbers))

    return _GROUPED_CITATION_RE.sub(expand, text)


FOOTNOTE_REFERENCE_LINE_RE = re.compile(r"^\s*\[\^(\d+)\]:?\s*", re.MULTILINE)


FOOTNOTE_INLINE_CITATION_RE = re.compile(r"\[\^(\d+)\]")


SOURCE_LOCATION_CITATION_RE = re.compile(r"\[(\d+)\s*†[^\]]+\]")


URL_IN_LINE_RE = re.compile(r"https?://\S+")


# Knowledge-layer citation pattern: "filename.ext" optionally followed by ", p.N" or ", page N"
KL_CITATION_PATTERN_RE = re.compile(r"^(.+\.\w{2,5})(?:,\s*(?:p\.?|page)\s*\d+)?$", re.IGNORECASE)


# Characters that may appear INSIDE a filename token. Used to require that a
# registry filename found in a reference line stands on its own rather than
# being the tail of a longer name — without this, a registry holding `plan.pdf`
# claims a citation to `bestandsplan.pdf` and the chip opens the wrong document.
_FILENAME_INNER_CHARS = "_-."


def _filename_token_ends(haystack_lower: str, needle_lower: str) -> Iterator[int]:
    """Every index just past ``needle_lower`` where it occurs as a standalone token.

    Yields nothing when the filename only occurs as part of a longer one. Each
    occurrence is yielded because one source section can name the SAME filename
    on two different shelves (`Plan.pdf (Büroablage)` and `Plan.pdf
    (Projektwissen)`), and those are two citations, not one.
    """
    index = haystack_lower.find(needle_lower)
    while index != -1:
        end = index + len(needle_lower)
        before_ok = index == 0 or not (
            haystack_lower[index - 1].isalnum() or haystack_lower[index - 1] in _FILENAME_INNER_CHARS
        )
        # A trailing "." is allowed (sentence punctuation); a trailing word
        # character would mean we matched a prefix of a longer filename.
        after_ok = end >= len(haystack_lower) or not (haystack_lower[end].isalnum() or haystack_lower[end] in "_-")
        if before_ok and after_ok:
            yield end
        index = haystack_lower.find(needle_lower, index + 1)


def _filename_occurs_as_token(haystack_lower: str, needle_lower: str) -> int | None:
    """Index just past ``needle_lower`` when it occurs as a standalone token.

    Returns ``None`` when the filename only occurs as part of a longer one.
    """
    return next(_filename_token_ends(haystack_lower, needle_lower), None)


def document_identity(entry: SourceEntry) -> tuple[str | None, str]:
    """The `(collection, filename)` a document is unique under, page aside.

    Same identity :meth:`SourceRegistry._identity` dedups on, minus the page:
    two pages of one document are one cited document.
    """
    collection, filename, _page = SourceRegistry._identity(entry)
    return collection, filename


def _match_registry_filename(ref_text: str, registry: SourceRegistry) -> str | None:
    """Resolve a reference line to a registered document key, page included.

    Scans the line for any filename the registry actually holds and rebuilds a
    canonical ``filename, p.N`` key from it: the registry's spelling of the
    filename (so it always matches), the scope qualifier the line states (so two
    same-named documents on different shelves stay apart), plus the page THE LINE
    states (so a document retrieved at several pages resolves to the one the
    answer is citing).

    The longest match wins, so `bestandsplan.pdf` is never resolved to a
    registered `plan.pdf`. ``None`` when the line names no registered document.

    This runs on the RAW line, before any title/parenthetical trimming, because
    those trims are exactly what used to lose the locator: a line written as
    ``OIB-Richtlinie 2 (oib-rl_2.pdf, p.12)`` had its whole locator removed as
    if it were an "(Internal)" annotation, and ``Titel - oib-rl_2.pdf, p.12``
    had the title swallowed into the filename — both dropping a citation to a
    document that was genuinely retrieved.
    """
    lowered = ref_text.lower()
    best_name: str | None = None
    best_end = 0
    for entry in registry._citation_keys:
        entry_file, _ = parse_citation_key(entry.citation_key or "")
        if not entry_file:
            continue
        end = _filename_occurs_as_token(lowered, entry_file.lower())
        if end is None:
            continue
        if best_name is None or len(entry_file) > len(best_name):
            best_name, best_end = entry_file, end
    if best_name is None:
        return None

    tail = ref_text[best_end:]
    # A shelf qualifier stated right after the filename is part of the document's
    # IDENTITY, not an annotation to trim: it is the only thing separating two
    # same-named documents on different shelves. Canonicalize its spelling so the
    # rebuilt key matches the registry regardless of how the line cased it.
    qualifier = ""
    qualifier_match = SCOPE_QUALIFIER_TOKEN_RE.match(tail)
    if qualifier_match:
        label = shelf_qualifier(shelf_for_qualifier(qualifier_match.group(1)))
        if label:
            qualifier = f" ({label})"
            tail = tail[qualifier_match.end() :]
    # The page stated after the filename (and its qualifier), when there is one.
    page_match = PAGE_RE.search(tail)
    name = f"{best_name}{qualifier}"
    return f"{name}, p.{page_match.group(1)}" if page_match else name


#: The shortest title HEAD (the title before its edition, ``OIB-Richtlinie 2``
#: out of ``OIB-Richtlinie 2, Ausgabe Mai 2023``) a line may resolve by. A full
#: title is specific whatever its length; a head is a prefix, and a four-letter
#: one ("Plan") would claim every line that mentions the word.
_MIN_TITLE_HEAD_CHARS = 10


def _title_occurs_as_token(haystack_lower: str, title_lower: str) -> int | None:
    """Index just past ``title_lower`` when it occurs as a whole name in the line.

    Whole, not substring: the character before must not continue a word, and
    the character after must END the name. A dot is not an end — ``OIB-Richtlinie 2``
    inside ``OIB-Richtlinie 2.1`` is a different document, and ``.`` followed
    by a digit is exactly how the two differ.
    """
    start = 0
    while True:
        at = haystack_lower.find(title_lower, start)
        if at == -1:
            return None
        end = at + len(title_lower)
        before_ok = at == 0 or not haystack_lower[at - 1].isalnum()
        after = haystack_lower[end : end + 1]
        after_ok = after == "" or after in ",;:)]" or after.isspace()
        if before_ok and after_ok:
            return end
        start = at + 1


def _registry_titles(entry: SourceEntry) -> list[str]:
    """The names a retrieved document answers to besides its file name.

    The stored title (what the tool's own ``Source:`` line printed, and so
    what an answer copies), and its head before the edition when that head is
    long enough to be a name. Empty for a source with no title.
    """
    title = (entry.title or "").strip()
    if not title:
        return []
    names = [title]
    head = title.split(",", 1)[0].strip()
    if head != title and len(head) >= _MIN_TITLE_HEAD_CHARS:
        names.append(head)
    return names


def _match_registry_title(ref_text: str, registry: SourceRegistry) -> str | None:
    """Resolve a reference line that names a retrieved document by its TITLE.

    The knowledge tools print two names for every hit — ``Source:`` carries the
    display title, ``Citation:`` the file name — and the prompt asks for the
    second while a German answer, naturally, copies the first
    („OIB-Richtlinie 2, Ausgabe Mai 2023, S. 12"). The registry holds both
    (:attr:`SourceEntry.title`), so a title-cited line is a citation to a
    document this turn really retrieved, and removing it cost the answer its
    source AND a repair pass (two searches and a rewrite) to put back what was
    never missing.

    Same shape as :func:`_match_registry_filename`: the longest matching name
    wins, and the key is rebuilt from the registry's own file name plus the
    page the line states. A title head shared by two DIFFERENT files (two
    editions of one Richtlinie) resolves nothing: naming the edition is what
    tells them apart, and guessing would cite the wrong one.
    """
    lowered = ref_text.lower()
    matches: dict[str, set[str]] = {}
    ends: dict[str, int] = {}
    for entry in registry._citation_keys:
        entry_file, _ = parse_citation_key(entry.citation_key or "")
        if not entry_file:
            continue
        for name in _registry_titles(entry):
            end = _title_occurs_as_token(lowered, name.lower())
            if end is None:
                continue
            matches.setdefault(name.lower(), set()).add(entry_file)
            ends[name.lower()] = end
    unambiguous = [(name, files) for name, files in matches.items() if len(files) == 1]
    if not unambiguous:
        return None
    name, files = max(unambiguous, key=lambda item: len(item[0]))
    entry_file = next(iter(files))
    page_match = TITLE_PAGE_RE.search(ref_text[ends[name] :])
    return f"{entry_file}, p.{page_match.group(1)}" if page_match else entry_file


_TITLE_PREFIX_SEPARATOR_RE = re.compile(r"\s+[-\u2013\u2014]\s+|:\s+")


def _title_prefix_tails(text: str) -> list[str]:
    """Every tail of ``text`` after a ``Title - `` / ``Title – `` / ``Title: `` separator.

    Shortest tail first (the segment after the LAST separator), because a
    reference line that decorates its filename with a title puts the title in
    front, and the filename is what is left at the end.
    """
    tails: list[str] = []
    for match in _TITLE_PREFIX_SEPARATOR_RE.finditer(text):
        tail = text[match.end() :].strip()
        if tail:
            tails.append(tail)
    return sorted(set(tails), key=len)


def is_digest_shaped_line(ref_text: str) -> bool:
    """Whether a source line is an already-read DIGEST line, not a citation.

    The digest (``knowledge.already_read``) is an index, not evidence: one line
    per opened document — ``"<file> | <collection> | Seiten <p> | Punkte <n> |
    Turn <k>"`` — and its own prompt block says the line itself is never cited;
    quoting or citing re-opens the passage with ``read_passage`` first. A source
    line in that shape cites the INDEX, so verification rejects it even when the
    filename names a genuinely retrieved document (the registry scan below would
    otherwise accept it on the filename alone).

    Structural, not imported: ``already_read.parse_digest_line`` is the same
    test, but that module imports ``parse_citation_key`` from HERE, so sharing
    it would be a cycle. The last three pipe segments are the digest's own
    markers; a real citation key never carries them.
    """
    parts = [part.strip() for part in ref_text.split("|")]
    if len(parts) < 5:
        return False
    lowered = [part.lower() for part in parts[-3:]]
    return lowered[0].startswith("seiten ") and lowered[1].startswith("punkte ") and lowered[2].startswith("turn ")


#: What may stand before a source line's leading link: the list bullet, its
#: ``[N]`` and an origin token. A link there is followed by its separator.
_LEADING_LINK_PREFIX = r"^(\s*(?:[-*]\s*)?(?:\[\d+\]\s*)?(?:\[(?:KB|RIS|Web)\]\s*)?)"


#: A label that only introduces the link (``Source: <url>``, ``Quelle: url``):
#: without the link it names nothing, so it goes with it.
_LINK_LABEL = r"(?:(?:Source|Quelle|Fundstelle|Link)(?:[ \t]+URL)?|URL)[ \t]*:[ \t]*"


#: What stands between a title and its link, on either side.
_LINK_SEPARATOR = r"[-–—:,|]"


def drop_url(text: str, url: str) -> str:
    """``text`` without ``url``, and without the separator or label that goes with it.

    ``[Title](url)`` keeps its title, ``<url>``, ``(url)`` and ``[url]`` go whole, a bare
    ``Title - url`` or ``Title | url`` loses the separator with the link,
    ``Title – Source: url`` and ``Title (Source: url)`` the label too, a
    leading ``url - Title`` the separator after it, and ``Title (url, 2024)``
    the link and its comma, keeping ``(2024)``.
    """
    escaped = re.escape(url)
    text = re.sub(rf"\[([^\]]*)\]\({escaped}\)", r"\1", text)
    text, leading = re.subn(
        rf"{_LEADING_LINK_PREFIX}[<(\[]?{escaped}[>)\]]?\s*(?:{_LINK_SEPARATOR}\s*)?", r"\1", text, flags=re.IGNORECASE
    )
    if leading:
        return text.rstrip()
    # A link sharing its parentheses with something else, ``(url, 2024)`` or
    # ``(2024, url)``, takes its comma and leaves the parentheses to the rest.
    labelled = rf"(?:{_LINK_LABEL})?<?{escaped}>?"
    text, shared = re.subn(rf"\(\s*{labelled}\s*,\s*", "(", text, flags=re.IGNORECASE)
    if not shared:
        text, shared = re.subn(rf"\s*,\s*{labelled}\s*\)", ")", text, flags=re.IGNORECASE)
    if not shared:
        link = rf"(?:\(\s*{labelled}\s*\)|(?:{_LINK_LABEL})?[<(\[]?{escaped}[>)\]]?)"
        text = re.sub(rf"\s*(?:{_LINK_SEPARATOR}\s*)?{link}", "", text, flags=re.IGNORECASE)
    return text.rstrip()


def is_knowledge_citation(ref_text: str, registry: SourceRegistry | None = None) -> tuple[bool, str | None]:
    """Check if reference text looks like a knowledge-layer citation.

    Matching strategy:
    1. If a registry is provided, resolve the line against the documents that
       were actually retrieved (:func:`_match_registry_filename`). This is both
       the most reliable signal and the most forgiving of LLM formatting, so it
       runs first.
    2. Otherwise fall back to the shape test (``filename.ext, p.N``) after
       trimming a trailing parenthetical and markdown emphasis.

    Returns (is_kl, citation_key_or_none).
    """
    # Strip markdown bold/italic markers only (*, **) — preserve underscores in
    # filenames. Done before the registry scan so `**file.pdf**` still matches.
    unemphasized = re.sub(r"\*+", "", ref_text).strip()

    if registry is not None:
        matched = _match_registry_filename(unemphasized, registry) or _match_registry_title(unemphasized, registry)
        if matched:
            return True, matched

    # Strip trailing "(Internal)" or similar parenthetical
    cleaned = re.sub(r"\s*\(.*?\)\s*$", "", unemphasized).strip()
    # Remove a leading "Title - ", "Title – " or "Title: " prefix by taking the
    # last segment if it contains a filename pattern. The TAIL segments come
    # first: the whole line also matches the shape test (`.+\.ext, p.N` is
    # satisfied by "OIB-Richtlinie 2 – file.pdf, p.1" as one long filename), and
    # a key that carries the title in front of the filename meets no document
    # anywhere downstream. The en and em dash are what the model actually
    # writes between a display title and a filename.
    for segment in [*_title_prefix_tails(cleaned), cleaned]:
        if KL_CITATION_PATTERN_RE.match(segment):
            return True, segment

    return False, None
