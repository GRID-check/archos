"""A fixture BFF for the precedent eval: the internal routes a cross-project turn reads, served from a fixture office.

The answer suite runs the real agent with no BFF, so it cannot ask a single
question about another project (docs/roadmap/office-experience.md, step A).
This serves exactly the routes that question needs, from
``apps/workspace/tests/fixtures/precedent/``:

- ``POST /api/internal/turn-context``: the current project's PROJECT_CONTEXT
  and the reference catalog, both as the production renderers wrote them
  (``rendered.json``, from ``reference-brief.fixture.spec.ts``);
- ``POST /api/internal/cross-project/{search,projects,brief}``: answered from
  ``office.json`` (and the permit records of its Bescheide, ``permits.json``,
  written by ``render_fixture_permits.py`` with the production pen), in the
  routes' wire shape.

Every OTHER internal route gets its connection dropped without an answer. That
is exactly what a suite run sees today, with no BFF at all, so a run differs
from the norm suite only by what this file serves.

Search ranks as production does, by meaning: the deployment's own embedding
model (``knowledge_layer``'s ``make_embed_model``, the note-embeddings
route's), fused by reciprocal rank with a token channel (tokens weighted by how rare they are in the
office's passages, so no list of function words decides), each searched
project's nearest passages returned whatever their relevance, the decisions
and the permit records' requirements ranked the same way. No word list and no threshold production does not have:
on a question nothing answers, the agent is handed the nearest passages and
must judge, as it is in production. Without an embedding key the token
channel alone ranks, and the run's report says so.

Every request is appended to ``requests.jsonl`` beside the run, so a check can
read which lookups a turn made and with what arguments.

``--set workspace`` hands it a ``fixture_workspace.FixtureWorkspace`` instead:
then it serves Piloti's MCP door (``POST /api/mcp``) and a turn context with
the WORKSPACE block, logs what the door answered beside each call, and drops
every other route the same way.

Every set also files proposals: ``POST /api/internal/proposals`` (ADR-0105) records the proposal a tool
asks for and answers with its id, as the BFF's route does, so a row can assert that a write was PROPOSED
(:func:`proposals_filed`) and not made. Nothing is applied; the fixture has no one to accept it.
"""

from __future__ import annotations

import json
import math
import re
import threading
import unicodedata
import urllib.parse
import uuid
from collections import Counter
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES = ROOT / "apps" / "workspace" / "tests" / "fixtures" / "precedent"

#: The per-project page the BFF searched before ADR-0116 (8 projects). The BFF now ranks a page of
#: `CROSS_PROJECT_PAGE_PROJECTS` (40, `lib/cross-project/types.ts`) in one grouped query; kept at 8 so
#: census runs stay comparable with the earlier ones.
PAGE_PROJECTS = 8
#: The office as `office.json` describes it; the other scenarios are named under its `scenarios`.
DEFAULT_SCENARIO = "default"
#: As the former per-project search's cap, and `CROSS_PROJECT_MAX_DECISIONS` in `lib/cross-project/`.
MAX_PER_PROJECT = 30
MAX_DECISIONS = 6
#: As `CROSS_PROJECT_MAX_PERMITS` and `CROSS_PROJECT_MAX_PERMIT_REQUIREMENTS` in `lib/cross-project/types.ts`.
MAX_PERMITS = 8
MAX_PERMIT_REQUIREMENTS = 6
#: Reciprocal-rank constant, as `RRF_K` in `lib/knowledge/recall-scoring.ts`.
RRF_K = 60
_TOKEN = re.compile(r"[a-z0-9]+")

#: The route a tool files a proposal at, and the harness ability it gives a row (``north_star_eval.HARNESS``).
PROPOSALS_PATH = "/api/internal/proposals"
ANNOTATIONS_PATH = "/api/internal/document-annotations"
#: ``proposals``: a write filed as a proposal. ``marks``: the canvas ``mark`` tool's proposals, recorded
#: (:func:`marks_proposed`).
ABILITIES = frozenset({"proposals", "marks"})
#: The kinds the route accepts (``lib/proposals/types.ts``), and the routes by which an agent could write instead.
PROPOSAL_KINDS = frozenset({"file_operation", "memory", "project_profile"})
WRITE_PATHS = ("/api/internal/document-versions", "/api/internal/document-annotations", "/api/internal/tasks")

#: Texts to vectors, in order; None when the embedder could not answer.
Embed = Callable[[list[str]], "list[list[float]] | None"]


def production_embedder() -> Embed | None:
    """The deployment's embedding model, built as the note-embeddings route builds it; None without a key."""
    try:
        from knowledge_layer.llamaindex.embedding import make_embed_model
        from knowledge_layer.llamaindex.embedding import resolve_embed_api_key
        from knowledge_layer.llamaindex.retriever import LlamaIndexRetriever
    except ImportError:
        return None
    model = LlamaIndexRetriever.DEFAULT_EMBED_MODEL
    base_url = LlamaIndexRetriever.DEFAULT_EMBED_BASE_URL
    api_key = resolve_embed_api_key(base_url, model)
    if not api_key:
        return None
    embedder = make_embed_model(base_url=base_url, model=model, api_key=api_key)

    def embed(texts: list[str]) -> list[list[float]] | None:
        try:
            return [list(vector) for vector in embedder.get_text_embedding_batch(texts)]
        except Exception:  # noqa: BLE001 - an embedder that fails leaves the token channel, as production's does
            return None

    return embed


def _fold(text: str) -> str:
    """Lower-case, umlauts and ß spelled out, accents dropped: „Mödling" and „Moedling" are one word."""
    text = text.casefold().replace("ä", "ae").replace("ö", "oe").replace("ü", "ue").replace("ß", "ss")
    return "".join(c for c in unicodedata.normalize("NFKD", text) if not unicodedata.combining(c))


def _tokens(text: str) -> set[str]:
    """Every token, no language's stop words or stems: the channel that keeps „REI 90" and „OIB-RL 2" findable."""
    return set(_TOKEN.findall(_fold(text)))


def _idf_weights(documents: list[set[str]]) -> dict[str, float]:
    """How rare each token is among the documents: BM25's inverse document frequency, always positive.

    Computed from the office's own passages, so „wie", „der" and „bei" weigh
    little and „Fluchttreppe" much without a list of words that decides which
    is which. Production's lexical channel prices words the same way
    (Qdrant's server-side BM25, IDF per scope). Raw overlap let a passage that shared three function words with
    the question outrank the one that held its only content word.
    """
    counts = Counter(token for tokens in documents for token in tokens)
    return {token: math.log(1 + (len(documents) - n + 0.5) / (n + 0.5)) for token, n in counts.items()}


def _overlap(a: set[str], b: set[str], weights: dict[str, float]) -> float:
    """Jaccard overlap of two token sets, each token weighted by its rarity (a token no passage holds weighs most)."""
    if not a or not b:
        return 0.0
    unseen = max(weights.values(), default=1.0)

    def weight(tokens: set[str]) -> float:
        return sum(weights.get(token, unseen) for token in tokens)

    return weight(a & b) / weight(a | b)


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b, strict=False))
    norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
    return dot / norm if norm else 0.0


def _fuse(dense: list[float | None], lexical: list[float]) -> list[float | None]:
    """Reciprocal-rank fusion of the two channels, as `fuseHybridRelevance`: rank-only, an absent entry unranked."""
    fused = [0.0] * len(lexical)
    for channel in (dense, [value if value > 0 else None for value in lexical]):
        ranked = sorted((score, index) for index, score in enumerate(channel) if score is not None)
        for rank, (_score, index) in enumerate(reversed(ranked)):
            fused[index] += 1 / (RRF_K + rank + 1)
    return [value if value > 0 else None for value in fused]


def _document_text(document: dict[str, Any]) -> str:
    return " ".join(str(document.get(key) or "") for key in ("title", "filename", "text"))


class FixtureOffice:
    """The fixture office and what the production renderers made of it."""

    def __init__(
        self, directory: Path = FIXTURES, scenario: str = DEFAULT_SCENARIO, embed: Embed | None = None
    ) -> None:
        self.embed = embed
        self._vectors: dict[str, list[float]] = {}
        self.office = json.loads((directory / "office.json").read_text(encoding="utf-8"))
        self._rendered = json.loads((directory / "rendered.json").read_text(encoding="utf-8"))["scenarios"]
        self.scenario = scenario
        if scenario not in self._rendered:
            raise KeyError(f"No scenario {scenario!r} in rendered.json: {sorted(self._rendered)}")
        spec = (self.office.get("scenarios") or {}).get(scenario) or {}
        self.current = spec.get("current") or self.office["current"]
        kept = spec.get("projects")
        every = self.office["projects"]
        office_projects = every if kept is None else [project for project in every if project["id"] in set(kept)]
        self.projects = {project["id"]: project for project in office_projects}
        self.rendered = self._rendered[scenario]
        self._weights = _idf_weights(
            [_tokens(_document_text(document)) for p in office_projects for document in p.get("documents") or []]
        )
        permits = directory / "permits.json"
        self.permits: dict[str, dict[str, Any]] = (
            json.loads(permits.read_text(encoding="utf-8"))["records"] if permits.exists() else {}
        )

    def project_names(self) -> list[str]:
        """The names of every project this office holds, the chat's own included: what a source may name."""
        return [self.current["name"], *(project["name"] for project in self.projects.values())]

    def turn_context(self) -> dict[str, Any]:
        return {
            "data": {
                "projectContext": self.rendered["projectContext"],
                "projectMemory": None,
                "orgInstructions": None,
                "drewOnOtherProjects": False,
                "referenceProjects": self.rendered["referenceProjects"],
            }
        }

    def _ref(self, project: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": project["id"],
            "name": project["name"],
            "status": project["status"],
            "federal_state": (project.get("facts") or {}).get("federal_state"),
        }

    def _listed(self, project: dict[str, Any]) -> dict[str, Any]:
        return {
            **self._ref(project),
            "collection": project["collection"],
            "address": project.get("facts", {}).get("site_address"),
            "period": {"start": project.get("startedOn") or "2013-01-01", "end": project.get("endedOn")},
            # The BFF's oibEdition: a confirmed fact, else no edition (the fixture holds no agent suggestion).
            "oibEdition": (
                {"value": str(project["facts"]["oib_edition"]), "confirmed": True}
                if (project.get("facts") or {}).get("oib_edition")
                else None
            ),
            "current": project["id"] == self.current["id"],
        }

    def _in_scope(self, body: dict[str, Any]) -> list[dict[str, Any]]:
        scope = body.get("scope") or "similar"
        if scope == "named":
            named = set(body.get("projectIds") or [])
            return [self.projects[pid] for pid in self.rendered["similarOrder"] if pid in named]
        ordered = [self.projects[pid] for pid in self.rendered["similarOrder"]]
        if scope == "closed":
            return [project for project in ordered if project["status"] == "closed"]
        return ordered

    def _dense(self, query: str, texts: list[str]) -> list[float | None]:
        """Each text's cosine to the query by the embedder, texts embedded once; all None without one."""
        if self.embed is None:
            return [None] * len(texts)
        missing = [text for text in dict.fromkeys([query, *texts]) if text not in self._vectors]
        if missing:
            vectors = self.embed(missing)
            if not vectors or len(vectors) != len(missing):
                return [None] * len(texts)
            self._vectors.update(zip(missing, vectors, strict=True))
        asked = self._vectors[query]
        return [_cosine(asked, self._vectors[text]) for text in texts]

    def _rank(self, query: str, texts: list[str]) -> list[tuple[int, float, float | None]]:
        """(index, display score, fused relevance) per text, best first: as production ranks."""
        dense = self._dense(query, texts)
        asked = _tokens(query)
        lexical = [_overlap(asked, _tokens(text), self._weights) for text in texts]
        fused = _fuse(dense, lexical)
        scored = [
            (index, dense[index] if dense[index] is not None else lexical[index], fused[index])
            for index in range(len(texts))
        ]
        return sorted(scored, key=lambda entry: (entry[2] is not None, entry[2] or 0.0, entry[1]), reverse=True)

    def search(self, body: dict[str, Any]) -> dict[str, Any]:
        """Each searched project's nearest passages, as `searchProjectDocuments` returns them: no relevance floor."""
        scope = self._in_scope(body)
        offset = int(body.get("offset") or 0)
        page = scope[offset : offset + PAGE_PROJECTS]
        query = str(body.get("query") or "")
        limit = int(body.get("limit") or 10)
        types, disciplines = set(body.get("documentTypes") or []), set(body.get("disciplines") or [])
        per_project = min(limit * 3 if types or disciplines else limit, MAX_PER_PROJECT)
        hits = []
        for project in page:
            documents = project.get("documents") or []
            nearest = self._rank(query, [_document_text(document) for document in documents])[:per_project]
            for index, score, _relevance in nearest:
                document = documents[index]
                tags = set(document.get("tags") or [])
                if (types and not types & tags) or (disciplines and not disciplines & tags):
                    continue
                hits.append(
                    {
                        "project": self._ref(project),
                        "documentId": document["documentId"],
                        "filename": document["filename"],
                        "title": document.get("title"),
                        "collection": project["collection"],
                        "page": document.get("page"),
                        "snippet": document["text"],
                        "score": round(score, 3),
                        "tags": sorted(tags),
                        "uploadedAt": "2026-01-15T08:00:00.000Z",
                    }
                )
        hits.sort(key=lambda hit: hit["score"], reverse=True)
        following = offset + len(page)
        return {
            "decisions": self._decisions(page, query),
            "permits": self._permits(page, query),
            "hits": hits[:limit],
            "projectsInScope": len(scope),
            "projectsSearched": len(page),
            "nextOffset": following if following < len(scope) else None,
        }

    def _decisions(self, page: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
        """The page's recorded decisions most relevant to the question, ranked as `searchProjectDecisions` ranks."""
        candidates = [(project, decision) for project in page for decision in project.get("decisions") or []]
        ranked = self._rank(query, [decision["content"] for _project, decision in candidates])
        return [
            {
                "project": self._ref(candidates[index][0]),
                "collection": candidates[index][0]["collection"],
                **candidates[index][1],
                # The fixture's decisions are person-written; none was read from documents.
                "origin": "person" if candidates[index][1]["confirmed"] else "agent",
                "evidence": [],
            }
            for index, _score, relevance in ranked
            if relevance is not None
        ][:MAX_DECISIONS]

    def _permits(self, page: list[dict[str, Any]], query: str) -> list[dict[str, Any]]:
        """The page's permit records whose requirements match best, ranked as `searchPermitRequirements` ranks them.

        Requirements are ranked, over the text production ranks (the requirement,
        its evidence, the record's authority and Gemeinde); a record ranks by its
        best requirement and carries only the requirements that matched.
        """
        candidates = [
            (project, document, record, requirement)
            for project in page
            for document in project.get("documents") or []
            if (record := self.permits.get(document["documentId"]))
            for requirement in record["requirements"]
        ]
        texts = [
            " ".join(
                part
                for part in (
                    requirement["content"],
                    requirement["evidence"],
                    record["authority"],
                    record["municipality"],
                )
                if part
            )
            for _project, _document, record, requirement in candidates
        ]
        grouped: dict[str, list[int]] = {}
        for index, _score, relevance in self._rank(query, texts):
            if relevance is not None:
                grouped.setdefault(candidates[index][1]["documentId"], []).append(index)
        permits = []
        for indexes in list(grouped.values())[:MAX_PERMITS]:
            project, document, record, _requirement = candidates[indexes[0]]
            permits.append(
                {
                    "project": self._ref(project),
                    "collection": project["collection"],
                    "fileName": document["filename"],
                    "kind": record["kind"],
                    "authority": record["authority"],
                    "municipality": record["municipality"],
                    "issuedOn": record["issuedOn"],
                    "reference": record["reference"],
                    "requirements": [candidates[index][3] for index in indexes[:MAX_PERMIT_REQUIREMENTS]],
                    "restricted": False,
                }
            )
        return permits

    def projects_listing(self, body: dict[str, Any]) -> dict[str, Any]:
        needle = _fold(str(body.get("query") or ""))

        def found(project: dict[str, Any]) -> bool:
            address = project.get("facts", {}).get("site_address", "")
            if body.get("status") and project["status"] != body["status"]:
                return False
            return not needle or needle in _fold(f"{project['name']} {address}")

        matching = [project for project in [self.current, *self.projects.values()] if found(project)]
        listed = matching[: int(body.get("limit") or 10)]
        return {"projects": [self._listed(project) for project in listed], "total": len(matching)}

    def brief(self, body: dict[str, Any]) -> dict[str, Any] | None:
        project = self.projects.get(str(body.get("projectId") or ""))
        if project is None:
            return None
        return {
            "project": self._listed(project),
            "summary": project.get("summary"),
            "facts": self.rendered["briefs"].get(project["id"], ""),
        }


def _conversation_of(envelope: str | None) -> str | None:
    """The conversation a request's envelope names: which run asked, for the checks. Not verified: only read."""
    import base64

    if not envelope:
        return None
    try:
        payload = json.loads(base64.urlsafe_b64decode(envelope + "=" * (-len(envelope) % 4)).decode("utf-8"))
    except ValueError:
        return None
    conversation = payload.get("conversationId") if isinstance(payload, dict) else None
    return conversation if isinstance(conversation, str) else None


def lookups_served(log_path: Path, conversation_id: str) -> list[str]:
    """The cross-project lookups this fixture answered for one conversation, in order: `search`, `projects`, `brief`.

    What a turn READ, whoever asked for it: the model's own call, or the
    turn decision's round-0 prefetch, which no model call shows.
    """
    if not log_path.exists():
        return []
    served = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        path = str(entry.get("path") or "")
        if entry.get("served") and entry.get("conversation") == conversation_id and "/cross-project/" in path:
            served.append(path.rsplit("/", 1)[-1])
    return served


def proposals_filed(log_path: Path, conversation_id: str) -> list[dict[str, Any]]:
    """The proposals this fixture stored for one conversation, in order: ``{id, kind, payload, ...}`` each."""
    return [
        entry["proposal"]
        for entry in _served(log_path, conversation_id)
        if entry.get("path") == PROPOSALS_PATH and isinstance(entry.get("proposal"), dict)
    ]


def writes_attempted(log_path: Path, conversation_id: str) -> list[str]:
    """The paths of the direct write routes this conversation's turn called, served or not (a proposal is not one)."""
    return [
        str(e["path"])
        for e in _served(log_path, conversation_id, only_served=False)
        if _is_write(str(e["path"])) and (e.get("body") or {}).get("op") != "propose"
    ]


def _is_write(path: str) -> bool:
    return any(path == route or path.startswith(route + "/") for route in WRITE_PATHS)


def marks_proposed(log_path: Path, conversation_id: str) -> list[dict[str, Any]]:
    """The marks a conversation's turn proposed on a document (canvas ``propose``), in order.

    A proposal is a suggestion the person takes over, not a write: it is read here and is not in
    :func:`writes_attempted`.
    """
    return [
        mark
        for entry in _served(log_path, conversation_id)
        if entry.get("path") == ANNOTATIONS_PATH and (entry.get("body") or {}).get("op") == "propose"
        for mark in (entry.get("body") or {}).get("proposals") or []
        if isinstance(mark, dict)
    ]


def _served(log_path: Path, conversation_id: str, *, only_served: bool = True) -> list[dict[str, Any]]:
    if not log_path.exists():
        return []
    found = []
    for line in log_path.read_text(encoding="utf-8").splitlines():
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if entry.get("conversation") == conversation_id and (entry.get("served") or not only_served):
            found.append(entry)
    return found


class FixtureBFF:
    """The fixture office behind a local HTTP server, on a free port, until :meth:`stop`."""

    def __init__(
        self,
        token: str,
        log_path: Path,
        office: FixtureOffice | None = None,
        embed: Embed | None = None,
        workspace: Any = None,
    ) -> None:
        self.embed = embed
        #: ``fixture_workspace.FixtureWorkspace`` for ``--set workspace``: then this serves Piloti's MCP door
        #: and a turn context with its WORKSPACE block, in place of the precedent office's routes.
        self.workspace = workspace
        self.office = office or FixtureOffice(embed=embed)
        self._offices = {self.office.scenario: self.office}
        self._scenario_of: dict[str, str] = {}
        #: The proposals filed so far, by id: the route is idempotent on (answer, card), as the BFF's is.
        self._proposals: dict[str, dict[str, Any]] = {}
        self.token = token
        self.log_path = log_path
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), self._handler())
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def start(self) -> FixtureBFF:
        self._thread.start()
        return self

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    def _log(self, entry: dict[str, Any]) -> None:
        with self._lock, self.log_path.open("a", encoding="utf-8") as sink:
            sink.write(json.dumps(entry, ensure_ascii=False) + "\n")

    def assign(self, conversation_id: str, scenario: str) -> FixtureOffice:
        """Answer this conversation from a scenario's office: which project the chat sits in, which exist."""
        with self._lock:
            if scenario not in self._offices:
                self._offices[scenario] = FixtureOffice(scenario=scenario, embed=self.embed)
            self._scenario_of[conversation_id] = scenario
            return self._offices[scenario]

    def office_for(self, conversation_id: str | None) -> FixtureOffice:
        with self._lock:
            scenario = self._scenario_of.get(conversation_id or "")
            return self._offices.get(scenario or "", self.office)

    def proposal(self, body: dict[str, Any], conversation: str | None) -> tuple[int, dict[str, Any]]:
        """``POST /api/internal/proposals``, op ``create``: store the proposal, answer ``{id, status}``.

        The same card of the same answer returns the first proposal, and nothing is applied: the status
        stays ``proposed``. A body the route would refuse (an op other than ``create``, an unknown kind, no
        payload) is a 422, so a tool that builds a wrong one fails here as it would against the BFF.
        """
        payload = body.get("payload")
        if body.get("op") != "create" or body.get("kind") not in PROPOSAL_KINDS or not isinstance(payload, dict):
            return 422, {"error": "Invalid proposal request"}
        key = f"{conversation}/{body.get('answerMessageId')}/{body.get('originCardIndex')}"
        idempotent = body.get("answerMessageId") is not None and body.get("originCardIndex") is not None
        with self._lock:
            made = self._proposals.get(key) if idempotent else None
            if made is None:
                identity = key if idempotent else f"{key}/{len(self._proposals)}"
                made = {
                    "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"fixture-proposal/{identity}")),
                    "status": "proposed",
                    "kind": body["kind"],
                    "payload": payload,
                    "originCardIndex": body.get("originCardIndex"),
                }
                self._proposals[key] = made
        return 200, {"id": made["id"], "status": made["status"]}

    def annotations(self, body: dict[str, Any]) -> tuple[int, dict[str, Any]] | None:
        """``POST /api/internal/document-annotations``: a ``list`` finds no marks, a ``propose`` is numbered back.

        Only these two ops are served (the rest of the canvas, presence included, is dropped as before), and
        nothing is stored on a document: the proposals are read from the request log (:func:`marks_proposed`).
        """
        if body.get("op") == "list":
            return 200, {"annotations": []}
        proposals = body.get("proposals")
        if body.get("op") != "propose" or not isinstance(proposals, list) or not proposals:
            return None
        proposed = [
            {
                "id": str(uuid.uuid5(uuid.NAMESPACE_URL, f"fixture-mark/{number}/{json.dumps(item, sort_keys=True)}")),
                "number": number,
                **item,
            }
            for number, item in enumerate(proposals, 1)
            if isinstance(item, dict)
        ]
        return 200, {"proposed": proposed}

    def _answer(
        self, path: str, body: dict[str, Any], office: FixtureOffice, conversation: str | None = None
    ) -> tuple[int, dict[str, Any]] | None:
        if path == PROPOSALS_PATH:
            return self.proposal(body, conversation)
        if path == ANNOTATIONS_PATH:
            return self.annotations(body)
        if self.workspace is not None:
            if path == "/api/mcp":
                return 200, self.workspace.handle(body, conversation)
            if path == "/api/internal/turn-context":
                return 200, self.workspace.turn_context(conversation)
            # `--set visual`: where `look` finds a file's storage key.
            document_file = getattr(self.workspace, "document_file", None)
            if path == "/api/internal/document-file" and document_file is not None:
                return document_file(body)
            return None
        if path == "/api/internal/turn-context":
            return 200, office.turn_context()
        if path == "/api/internal/cross-project/search":
            return 200, office.search(body)
        if path == "/api/internal/cross-project/projects":
            return 200, office.projects_listing(body)
        if path == "/api/internal/cross-project/brief":
            found = office.brief(body)
            return (200, found) if found is not None else (404, {"error": "Not found"})
        return None

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        bff = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:  # the run's log stays the agent's
                return

            def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
                length = int(self.headers.get("Content-Length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except ValueError:
                    body = {}
                path, _, query = self.path.partition("?")
                if query and not body:
                    body = {key: values[0] for key, values in urllib.parse.parse_qs(query).items()}
                # `--set visual`: the object store the run reads sheets from, path-style S3, no signature checked.
                objects = getattr(bff.workspace, "object_bytes", None)
                blob = objects(path) if objects is not None and self.command == "GET" else None
                if blob is not None:
                    self.send_response(200)
                    self.send_header("Content-Type", "application/pdf")
                    self.send_header("Content-Length", str(len(blob)))
                    self.end_headers()
                    self.wfile.write(blob)
                    return
                conversation = _conversation_of(self.headers.get("X-Request-Context"))
                trusted = self.headers.get("X-Internal-Token") == bff.token
                answer = bff._answer(path, body, bff.office_for(conversation), conversation) if trusted else None
                entry = {"path": path, "body": body, "served": answer is not None, "conversation": conversation}
                if answer is not None and path == "/api/mcp":
                    # What the door answered, so a check reads the proposals and refusals a turn met.
                    entry["result"] = answer[1].get("result")
                if answer is not None and path == PROPOSALS_PATH and answer[0] == 200:
                    # What was filed, so a check reads the proposal and not only that one was asked for.
                    entry["proposal"] = {**answer[1], "kind": body["kind"], "payload": body["payload"]}
                bff._log(entry)
                if answer is None:
                    # As unreachable as today's suite's BFF: no status line at all.
                    self.close_connection = True
                    return
                status, payload = answer
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST  # noqa: N815 - a GET to an unserved route is dropped like a POST

        return Handler
