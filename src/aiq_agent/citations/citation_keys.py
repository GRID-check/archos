"""Reading a citation key the model wrote: file name, shelf qualifier, page, or an estate path."""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass

from aiq_agent.citations.entries import SourceEntry
from aiq_agent.common.source_kinds import READABLE_QUALIFIERS
from aiq_agent.common.source_kinds import Shelf
from aiq_agent.common.source_kinds import legacy_shelf_for_collection_name
from aiq_agent.common.source_kinds import parse_shelf
from aiq_agent.common.source_kinds import shelf_for_qualifier

logger = logging.getLogger(__name__)


# The page token must be a separate word (preceded by a comma or whitespace
# and followed by a delimiter or end), so filenames containing "p" + digits
# (e.g. "Top2.pdf", "wp2023.pdf") are not truncated into bogus page refs.
PAGE_RE = re.compile(r"[,\s]\s*(?:p\.?|page)\s*(\d+)(?=\s*(?:[,)\]]|$))", re.IGNORECASE)


# Optional shelf qualifier a citation key carries when one filename was retrieved
# from more than one shelf in the same turn: `Plan.pdf (Projektwissen), p.3`.
# Only the known qualifiers match, so a parenthetical that is part of a real
# filename ("Bescheid (Kopie).pdf") is never mistaken for one. The alternation is
# built from the LEGACY table and the retired names too („Büroarchiv"), because
# those strings are persisted inside citation keys in existing messages and must
# keep parsing (ADR-0047: German is rendering, and a versioned reader keeps
# reading what was already written).
_SCOPE_QUALIFIER_ALTERNATION = "|".join(re.escape(label) for label in READABLE_QUALIFIERS)


#: The qualifier at the END of a key's filename part (parsing a whole key).
_SCOPE_QUALIFIER_RE = re.compile(rf"\s*\(({_SCOPE_QUALIFIER_ALTERNATION})\)\s*$", re.IGNORECASE)


#: The qualifier at the START of the text FOLLOWING a filename (scanning a line).
SCOPE_QUALIFIER_TOKEN_RE = re.compile(rf"\s*\(({_SCOPE_QUALIFIER_ALTERNATION})\)", re.IGNORECASE)


def parse_citation_ref(key: str) -> tuple[str, Shelf | None, int | None]:
    """Extract (filename, shelf, page_number) from a citation key.

    Handles: "report.pdf, p.15", "report.pdf, page 15", "report.pdf",
    "report.pdf, p.15, Table 1", "Plan.pdf (Projektwissen), p.3"

    ``shelf`` is the :class:`Shelf` the key's qualifier NAMES, or None when the
    key is unqualified — which is the common case, because a filename is only
    qualified when the same name was retrieved from two different shelves in one
    turn. Reading a qualifier is not shelf INFERENCE: the qualifier was written
    from a stated shelf, and legacy keys are the one place the label is all
    that was persisted.
    """
    page_match = PAGE_RE.search(key)
    page = int(page_match.group(1)) if page_match else None
    # Filename is everything before the page reference (or the whole key)
    if page_match:
        filename = key[: page_match.start()].rstrip(", ").strip()
    else:
        filename = key.strip()
    shelf = None
    qualifier_match = _SCOPE_QUALIFIER_RE.search(filename)
    if qualifier_match:
        shelf = shelf_for_qualifier(qualifier_match.group(1))
        filename = filename[: qualifier_match.start()].rstrip(", ").strip()
    from_path = citation_key_of_path(filename)
    if from_path is not None:
        filename, path_shelf = from_path[0][0], from_path[1]
        shelf = shelf or path_shelf
    return filename, shelf, page


def key_file_names(key: str, filename: str) -> list[str]:
    """The file names a citation key may mean: its parsed ``filename``, or each one a path-shaped key stands for."""
    from_path = citation_key_of_path(path_in_citation(key) or "")
    return from_path[0] if from_path is not None else [filename]


#: Where an estate path starts inside a citation key or a source line.
_ESTATE_PATH_START_RE = re.compile(r"/(?:project|office|chat|law/oib)/")


#: An estate path up to its leaf's extensions (``Plan.pdf.md``, ``Notiz.v2.md``), where a delimiter follows.
_ESTATE_PATH_LEAF_RE = re.compile(
    r"[^\n]*?(?:\.(?:pdf|md|txt|csv|docx?|xlsx?|pptx?|ifc|dwg|dxf|png|jpe?g|tiff?|eml|msg|html?))+(?=[\s,;)\]]|$)",
    re.IGNORECASE,
)


def path_in_citation(text: str) -> str | None:
    """The estate path ``text`` cites, exactly: from its mount to the leaf's extension.

    A file name may hold commas (``Bescheid, Stand 2024.pdf``), so the path ends at its extension,
    and text after it (a page, a dash, a closing parenthesis) stays. A leaf without a known extension
    ends where the locus (``p.3``, ``S. 3``) or the shelf qualifier begins, never at the first comma.
    """
    start = _ESTATE_PATH_START_RE.search(text)
    if start is None:
        return None
    rest = text[start.start() :].split("\n", 1)[0]
    if leaf := _ESTATE_PATH_LEAF_RE.match(rest):
        return leaf.group(0)
    page = TITLE_PAGE_RE.search(rest)
    span = (rest[: page.start()] if page else rest).rstrip().rstrip(",").rstrip()
    qualifier = _SCOPE_QUALIFIER_RE.search(span)
    return (span[: qualifier.start()] if qualifier else span).rstrip() or None


def citation_key_of_path(text: str) -> tuple[list[str], Shelf | None] | None:
    """``(file names, shelf)`` a path-shaped citation names; ``None`` when ``text`` is no estate path.

    The model reads paths since ADR-0133 (a hit's ``Path:``, a ``read_file`` header), so a citation
    written as ``/project/Gutachten/Brandschutzkonzept.pdf.md, p.3`` is likely. The file names it may
    mean are the leaf's candidates, as the estate resolves them (``estate_paths.file_name_candidates``:
    ``x.pdf.md`` is ``x.pdf`` or itself, ``Plan.md`` itself or ``Plan``); the registry matches any. The
    mount states the shelf, the way a qualifier does. Verification would otherwise drop the citation and
    the answer lose its source without a word; this is that correction held by code, not prompt prose.
    """
    from aiq_agent.common.estate_paths import MOUNT_SHELVES
    from aiq_agent.common.estate_paths import file_name_candidates
    from aiq_agent.common.estate_paths import mount_of_path

    candidate = text.strip()
    if not candidate.startswith("/"):
        return None
    mount = mount_of_path(candidate)
    if mount not in MOUNT_SHELVES:
        return None
    leaf = candidate.rstrip("/").rsplit("/", 1)[-1]
    if not leaf or candidate.endswith("/"):
        return None
    return file_name_candidates(leaf), parse_shelf(MOUNT_SHELVES[mount])


def entry_shelf(entry: SourceEntry) -> Shelf | None:
    """The shelf a registry entry sits on; ``None`` when unknown.

    Prefers the STATED shelf. The collection-name fallback exists only for
    entries captured before the knowledge layer emitted ``Shelf:`` (an older
    deploy's tool output replayed into this registry) and goes away with
    :func:`legacy_shelf_for_collection_name`.
    """
    return parse_shelf(entry.shelf) or legacy_shelf_for_collection_name(entry.collection)


def parse_citation_key(key: str) -> tuple[str, int | None]:
    """(filename, page) from a citation key — :func:`parse_citation_ref` without the shelf.

    Kept as the narrow form for the many call sites that only ever needed the
    document's name and page (wire serialization, chunk merging, display).
    """
    filename, _scope, page = parse_citation_ref(key)
    return filename, page


@dataclass
class ParsedURL:
    """Pre-parsed URL components cached at registration time."""

    host: str
    path: str
    path_segments: list[str]
    query: dict[str, list[str]]
    entry: SourceEntry


#: A page stated after a display TITLE, the way a German answer writes it
#: (``S. 12``) as well as the key's own ``p.12``. Read on the title branch
#: only: ``PAGE_RE`` is part of the citation-key grammar every key parser
#: shares, and teaching it German would move every key's bytes.
TITLE_PAGE_RE = re.compile(r"[,\s]\s*(?:S\.|p\.?|page)\s*(\d+)(?=\s*(?:[,)\]]|$))", re.IGNORECASE)
