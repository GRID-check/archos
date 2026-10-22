"""The intake eval's fixture project, and the shared reading tools answering from it.

The project is ``tests/fixtures/intake_eval/project.yaml``: documents as the
reading tools return them, page by page. The Erfassungs-Agent reads it through
the same four tools it binds in production:

* ``read_document`` is the agent's own tool, run unchanged: only where its
  pages come from is replaced (``reading.project_documents`` and
  ``reading.fetch_document_pages``, the seams the agent's own suite fakes in
  ``tests/aiq_agent/agents/intake/conftest.py``).
* ``list_files``, ``knowledge_search`` and ``read_passage`` are the shared NAT
  tools, which need a vector store and a database. They are rebuilt here with
  the production descriptions (imported, so they cannot drift) and the
  production renderers: ``list_files`` through the knowledge layer's own
  ``select_files`` and ``render_listing``, the two passage tools through
  ``render_grounding_block``, so the read log files their passages exactly as
  it does on a live run. What differs is the ranking: a token ranking (BM25)
  over the fixture's paragraphs stands in for the embedding search and the
  reranker, and ``match="exact"`` is a folded substring match.
"""

from __future__ import annotations

import difflib
import math
import re
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from langchain_core.tools import StructuredTool

REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURE_DIR = REPO_ROOT / "tests" / "fixtures" / "intake_eval"

#: As the deployment's ``knowledge_search`` config: 16 passages, at most 5 from one document.
TOP_K = 16
MAX_PER_DOCUMENT = 5
#: Passages one exact search returns (``browse.MAX_MATCH_PASSAGES``).
MAX_EXACT_PASSAGES = 8

_FOLD = str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"})
_WORD = re.compile(r"\w+")


@dataclass(frozen=True)
class FixtureFile:
    name: str
    folder: str
    added_at: str | None
    revision_facts: dict[str, Any] | None
    pages: tuple[str, ...]


@dataclass(frozen=True)
class Fixture:
    collection: str
    description: str
    instruction: str
    files: tuple[FixtureFile, ...]

    def file(self, name: str) -> FixtureFile | None:
        wanted = (name or "").strip().casefold()
        return next((f for f in self.files if f.name.casefold() == wanted), None)

    @property
    def names(self) -> list[str]:
        return [f.name for f in self.files]


def load_fixture(path: Path = FIXTURE_DIR / "project.yaml") -> Fixture:
    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    files = tuple(
        FixtureFile(
            name=item["name"],
            folder=item.get("folder") or "",
            added_at=item.get("added_at"),
            revision_facts=item.get("revision_facts"),
            pages=tuple(page.strip() for page in item["pages"]),
        )
        for item in raw["files"]
    )
    project = raw["project"]
    return Fixture(project["collection"], project["description"], " ".join(project["instruction"].split()), files)


def load_answer_key(path: Path = FIXTURE_DIR / "answer_key.yaml") -> dict[str, Any]:
    return yaml.safe_load(path.read_text(encoding="utf-8"))


# ── read_document's seams ────────────────────────────────────────────────────


def available_document(fixture: Fixture, file: FixtureFile) -> Any:
    from aiq_agent.knowledge.schema import AvailableDocument

    return AvailableDocument(
        file_name=file.name,
        collection=fixture.collection,
        shelf="project",
        folder_path=file.folder or None,
        added_at=file.added_at,
        revision_facts=file.revision_facts,
    )


def project_documents_for(fixture: Fixture):
    """``reading.project_documents``, answered from the fixture."""
    from aiq_agent.agents.intake.reading import ProjectDocument

    async def project_documents() -> list[Any]:
        return [ProjectDocument(fixture.collection, available_document(fixture, f)) for f in fixture.files]

    return project_documents


def page_fetcher_for(fixture: Fixture):
    """``reading.fetch_document_pages``, answered from the fixture: one indexed chunk per page."""

    def fetch_document_pages(collection: str, file_name: str) -> list[tuple[Any, str]] | None:
        file = fixture.file(file_name)
        if collection != fixture.collection or file is None:
            return None
        return [(str(number), text) for number, text in enumerate(file.pages, 1)]

    return fetch_document_pages


# ── The passages, and a token ranking over them ──────────────────────────────


@dataclass(frozen=True)
class Passage:
    file: FixtureFile
    page: int
    text: str


def fold_words(text: str) -> list[str]:
    return _WORD.findall(text.casefold().translate(_FOLD))


def passages_of(fixture: Fixture) -> list[Passage]:
    """Each page's paragraphs, the size of passage a search returns."""
    found = []
    for file in fixture.files:
        for number, page in enumerate(file.pages, 1):
            found.extend(Passage(file, number, part.strip()) for part in re.split(r"\n\s*\n", page) if part.strip())
    return found


class PassageIndex:
    """BM25 over the fixture's passages: the stand-in for the embedding search and its reranker."""

    def __init__(self, passages: list[Passage]) -> None:
        self.passages = passages
        self.words = [Counter(fold_words(p.text)) for p in passages]
        self.lengths = [sum(words.values()) for words in self.words]
        self.mean_length = sum(self.lengths) / max(1, len(self.lengths))
        documents = Counter(word for words in self.words for word in words)
        total = len(passages)
        self.idf = {word: math.log(1 + (total - n + 0.5) / (n + 0.5)) for word, n in documents.items()}

    def _score(self, index: int, query: list[str]) -> float:
        words, length = self.words[index], self.lengths[index]
        score = 0.0
        for word in query:
            tf = words.get(word, 0)
            if tf:
                score += self.idf[word] * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * length / self.mean_length))
        return score

    def search(self, query: str, allowed: set[str] | None = None) -> list[tuple[Passage, float]]:
        terms = fold_words(query)
        scored = [
            (passage, self._score(index, terms))
            for index, passage in enumerate(self.passages)
            if allowed is None or passage.file.name in allowed
        ]
        ranked = sorted((item for item in scored if item[1] > 0), key=lambda item: -item[1])
        best = ranked[0][1] if ranked else 1.0
        per_file: Counter = Counter()
        kept = []
        for passage, score in ranked:
            if per_file[passage.file.name] >= MAX_PER_DOCUMENT:
                continue
            per_file[passage.file.name] += 1
            kept.append((passage, round(score / best, 3)))
        return kept[:TOP_K]

    def exact(self, query: str, allowed: set[str] | None = None) -> list[tuple[Passage, float]]:
        phrases = [" ".join(fold_words(part)) for part in query.split("|") if fold_words(part)]
        hits = [
            (passage, 1.0)
            for passage in self.passages
            if (allowed is None or passage.file.name in allowed)
            and any(phrase in " ".join(fold_words(passage.text)) for phrase in phrases)
        ]
        return hits[:MAX_EXACT_PASSAGES]


# ── Rendering, as the knowledge layer renders ────────────────────────────────


def render_passages(fixture: Fixture, hits: list[tuple[Passage, float]], tool: str, trailer: str = "") -> str:
    """Hits as ``knowledge_search`` renders them (``_format_results``), filed for the read log."""
    from aiq_agent.common.grounding_block import GroundingBlock
    from aiq_agent.common.grounding_block import GroundingHit
    from aiq_agent.common.grounding_block import render_grounding_block
    from aiq_agent.common.source_kinds import Shelf

    records = tuple(
        GroundingHit(
            citation_key=f"{passage.file.name}, p.{passage.page}",
            file_name=passage.file.name,
            page=passage.page,
            shelf=Shelf.PROJECT,
            collection=fixture.collection,
            doc_class=None,
            display_title=passage.file.name,
            folder_path=passage.file.folder or None,
            clause=None,
            score=score,
            content_type="text",
            provenance=None,
            stored_image_index=None,
            status_note=None,
            body=passage.text,
        )
        for passage, score in hits
    )
    preamble = f"Found {len(records)} relevant document(s):"
    block = GroundingBlock(preamble=preamble, degraded_banner="", hits=records, lanes=(), tool=tool, trailer=trailer)
    return render_grounding_block(block)


def _allowed(fixture: Fixture, file_name: str | None, folder: str | None, title: str | None) -> set[str] | None:
    names = set(fixture.names)
    if file_name:
        names &= {f.name for f in fixture.files if f.name.casefold() == file_name.strip().casefold()}
    if folder:
        wanted = folder.strip().strip("/").casefold()
        names &= {
            f.name
            for f in fixture.files
            if f.folder.casefold() == wanted or f.folder.casefold().startswith(f"{wanted}/")
        }
    if title:
        names &= {f.name for f in fixture.files if title.strip().casefold() in f.name.casefold()}
    return None if names == set(fixture.names) else names


# ── The three shared tools ───────────────────────────────────────────────────


def knowledge_search_tool(fixture: Fixture, index: PassageIndex) -> StructuredTool:
    from knowledge_layer.register import _KNOWLEDGE_SEARCH_DESCRIPTION

    async def knowledge_search(
        query: str,
        filters: dict | None = None,
        doc_class: str | None = None,
        title_contains: str | None = None,
        file_name: str | None = None,
        folder: str | None = None,
        match: str = "meaning",
        conclusion: str = "",
    ) -> str:
        allowed = _allowed(fixture, file_name, folder, title_contains)
        if doc_class:  # no fixture document carries a Dokumentart
            allowed = set()
        hits = index.exact(query, allowed) if match == "exact" else index.search(query, allowed)
        if not hits:
            return f"No relevant documents found for query: '{query}'"
        return render_passages(fixture, hits, "knowledge_search")

    description = f"{_KNOWLEDGE_SEARCH_DESCRIPTION} Returns up to {TOP_K} excerpts (platform-configurable)."
    return StructuredTool.from_function(coroutine=knowledge_search, name="knowledge_search", description=description)


def read_passage_tool(fixture: Fixture, index: PassageIndex) -> StructuredTool:
    from knowledge_layer.read_passage import _READ_PASSAGE_DESCRIPTION

    async def read_passage(
        document: str, clause: str | int | None = None, page: int | str | None = None, conclusion: str = ""
    ) -> str:
        file = fixture.file(document)
        if file is None:
            close = difflib.get_close_matches(document, fixture.names, n=3, cutoff=0.5)
            guesses = f" Vermutlich gemeint: {', '.join(close)}." if close else ""
            return f"Kein Dokument „{document}“ in diesem Umfang.{guesses}"
        if clause not in (None, ""):
            return f"„{file.name}“ hat keinen Punkt „{clause}“; lies es mit `page=`."
        wanted = int(page) if str(page or "").strip().isdigit() else 1
        hits = [(p, 1.0) for p in index.passages if p.file is file and p.page == wanted]
        if not hits:
            return f"„{file.name}“ hat keine Seite {wanted}; es hat {len(file.pages)} Seite(n)."
        trailer = (
            "" if page else f"Dieses Dokument hat keine Gliederung nach Punkten; es hat {len(file.pages)} Seite(n)."
        )
        return render_passages(fixture, hits, "read_passage", trailer)

    return StructuredTool.from_function(
        coroutine=read_passage, name="read_passage", description=_READ_PASSAGE_DESCRIPTION
    )


def list_files_tool(fixture: Fixture) -> StructuredTool:
    from knowledge_layer.browse import _LIST_FILES_DESCRIPTION
    from knowledge_layer.browse import file_rows

    rows = file_rows(available_document(fixture, f).model_dump() for f in fixture.files)

    async def list_files(
        folder: str | None = None,
        name_contains: str | None = None,
        doc_class: str | None = None,
        added_since: str | None = None,
        shelf: str | None = None,
        sort: str | None = None,
        offset: int | None = None,
        limit: int | None = None,
        topic: str | None = None,
        revisions_of: str | None = None,
        compare_to: str | None = None,
        view: str | None = None,
        depth: int | None = None,
    ) -> str:
        from knowledge_layer.browse import DEFAULT_TREE_DEPTH
        from knowledge_layer.browse import folder_cards
        from knowledge_layer.browse import render_listing
        from knowledge_layer.browse import render_revisions
        from knowledge_layer.browse import render_tree
        from knowledge_layer.browse import select_files

        if revisions_of:
            return render_revisions(rows, revisions_of, default_shelves=("project",))
        listing = select_files(
            rows,
            default_shelves=("project",),
            folder=folder,
            name_contains=name_contains,
            doc_class=doc_class,
            added_since=added_since,
            topic=topic,
            sort=sort or "folder",
            offset=int(offset or 0),
            limit=len(rows) + 1 if view == "tree" else int(limit or 40),
        )
        if view == "tree":
            cards = folder_cards(
                listing.rows, root=listing.folder, depth=int(depth or DEFAULT_TREE_DEPTH), series_rows=rows
            )
            return render_tree(cards, total_rows=listing.total, notes=listing.notes)
        return render_listing(listing)

    return StructuredTool.from_function(coroutine=list_files, name="list_files", description=_LIST_FILES_DESCRIPTION)


def shared_tools(fixture: Fixture) -> list[StructuredTool]:
    """The tools ``configs/config_oib_openrouter.yml`` binds to the intake, answering from the fixture."""
    index = PassageIndex(passages_of(fixture))
    return [list_files_tool(fixture), knowledge_search_tool(fixture, index), read_passage_tool(fixture, index)]
