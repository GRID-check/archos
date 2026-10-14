"""Where an upload belongs: Piloti's filing judgement, one bounded call per upload batch.

``POST /v1/filing-fit`` is the model half of the filing suggestion
(``docs/architecture/proposed-changes.md``, „Ablage"). The BFF
(``frontends/ui/src/lib/filing/``) has already decided everything a person's
access decides: which documents of the batch the uploader may see, which
folders are open to every reader (a restricted folder is never sent, ADR-0087),
and whether a document's screening passed (ADR-0086). This route reads nothing
of its own. It gets:

* the shelf's folders, each with its path, the description a person wrote and
  the Dokumentarten already filed there;
* the office's conventions: folder paths its other projects use, with their
  descriptions, or an Austrian default when the office has none;
* the batch's documents: file name, the folder it landed in, and, once
  ingestion has read it, its Dokumentart, tags and summary.

The model names, per document, a folder that clearly fits better, or nothing.
Silence is the default: a wrong suggestion costs trust, a missing one costs a
drag. What comes back is checked here and again in the BFF: a document or a
folder the input did not name is dropped, as is a move into the folder the
document already sits in.

**Two bases, one call each.** ``basis: name`` runs as soon as the batch's bytes
are in, while the person is still looking at the upload: the file name and the
folders' descriptions only, queued as ``interactive`` (ADR-0081). ``basis:
content`` runs when ingestion has read the batch, with the Dokumentart and the
summary, queued as ``bulk``. The Dokumentart was set by a person or read from
the content, and outweighs the file name (``doc_class`` beats every guess).

**Observable.** One ``filing-fit`` generation per call (ADR-0089), with the
batch, the project, the shelf and the basis as metadata, and its trace id in
the answer so a person's decision on the proposal is scored on it.

Fails soft: no credential, an upstream error or an answer that does not parse
returns no moves with ``error`` set, and nothing is proposed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import unicodedata
from typing import Any
from typing import Literal

import httpx
from fastapi import APIRouter
from fastapi import Header
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field

from aiq_agent.common import provider_limiter
from aiq_agent.common.openrouter import limited_async_http_client
from aiq_agent.observability.direct_trace import observed_generation

from ._llm_json import extract_json_object
from ._llm_json import message_content
from .generate_summary import _llm_settings

logger = logging.getLogger(__name__)

#: The generation's name in Langfuse (``docs/observability/langfuse.md``).
TRACE_NAME = "filing-fit"

#: Most documents one call judges: one upload batch's worth of decisions a
#: person can take in one look. The BFF sends the batch in slices of this size.
MAX_DOCUMENTS = 60
MAX_FOLDERS = 300
MAX_CONVENTIONS = 80
MAX_REASON = 300

_REQUEST_TIMEOUT_SECONDS = 45.0

SYSTEM_PROMPT = (
    "You help an architecture office keep its project files in order. The office keeps its documents "
    "in folders, and each folder may carry a description a person wrote: what belongs in it. You see "
    "the folders of one shelf, the folder conventions the office uses in its other projects, and a batch "
    "of documents that were just uploaded, each with the folder it landed in.\n"
    "For each document, decide whether ANOTHER folder clearly fits better than the one it is in. Judge "
    "from the folder descriptions first and the folder names second. A document's type, when given, was "
    "set by a person or read from its content: it outweighs anything the file name suggests. Its summary "
    "says what it is about.\n"
    "Silence is the default. Propose a move only when you are confident a person in the office would "
    "agree at a glance. A document that fits where it is, a folder that is only vaguely closer, a "
    "document you cannot place: propose nothing. A document at the shelf root (folder \"\") gets a "
    "proposal only when one folder clearly fits.\n"
    "Use only folder paths from FOLDERS or CONVENTIONS, spelled exactly as given. Prefer an existing "
    "folder; name a CONVENTIONS folder only when no existing folder fits and the office clearly files such "
    "documents there. Never invent a folder.\n"
    'Answer with JSON only: {"moves": [{"id": "<document id>", "folder": "<folder path>", '
    '"reason": "<one short sentence a person reads>"}]}. Use only ids from DOCUMENTS. An empty list is a '
    "good answer."
)


class FilingFolder(BaseModel):
    """A folder of the shelf, as every reader of it may see it."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(..., min_length=1, max_length=1024)
    description: str | None = Field(None, max_length=500)
    doc_types: list[str] = Field(default_factory=list, max_length=12, description="Dokumentarten filed here.")


class FilingConvention(BaseModel):
    """A folder the office uses elsewhere; proposing one creates it on the shelf."""

    model_config = ConfigDict(extra="forbid")

    path: str = Field(..., min_length=1, max_length=1024)
    description: str | None = Field(None, max_length=500)
    projects: int = Field(0, ge=0, description="How many of the office's projects use it; 0 for the default.")
    doc_types: list[str] = Field(default_factory=list, max_length=12)


class FilingDocument(BaseModel):
    """One document of the batch, as ingestion described it. No content."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=64)
    file: str = Field(..., min_length=1, max_length=512)
    folder: str = Field("", max_length=1024, description="Where it landed; empty for the shelf root.")
    type: str | None = Field(None, max_length=80, description="Its Dokumentart, a person's or ingestion's.")
    tags: list[str] = Field(default_factory=list, max_length=10)
    summary: str | None = Field(None, max_length=800)


class FilingTrace(BaseModel):
    """What the generation carries as trace metadata. Ids only."""

    model_config = ConfigDict(extra="forbid")

    batch_id: str = Field(..., min_length=1, max_length=64)
    project_id: str | None = Field(None, max_length=64)
    shelf: Literal["project", "archiv"] = "project"


class FilingFitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    basis: Literal["name", "content"]
    locale: str = Field("de", max_length=16)
    folders: list[FilingFolder] = Field(default_factory=list, max_length=MAX_FOLDERS)
    conventions: list[FilingConvention] = Field(default_factory=list, max_length=MAX_CONVENTIONS)
    documents: list[FilingDocument] = Field(..., max_length=MAX_DOCUMENTS)
    trace: FilingTrace


class FilingMove(BaseModel):
    id: str
    folder: str
    reason: str
    #: The folder is a convention the shelf does not have yet: applying creates it.
    new: bool = False
    #: The description a new folder is created with (the convention's).
    description: str | None = None


class FilingFitResponse(BaseModel):
    moves: list[FilingMove] = Field(default_factory=list)
    model: str | None = None
    error: str | None = None
    trace_id: str | None = None


def _path_key(path: str) -> str:
    """A folder path keyed as the BFF keys it: NFC, folded whitespace, case-folded, per segment."""
    segments = (" ".join(segment.split()) for segment in unicodedata.normalize("NFC", path).split("/"))
    return "/".join(segment.lower() for segment in segments if segment)


def _without_empty(fields: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value not in (None, "", [], 0)}


def build_user_content(request: FilingFitRequest) -> str:
    """The batch as the model reads it: three labelled sections of one JSON object per line."""
    language = "German" if request.locale.lower().startswith("de") else "English"
    lines = [f"Write each reason in {language}.", "", "FOLDERS"]
    lines += [json.dumps(_without_empty(folder.model_dump()), ensure_ascii=False) for folder in request.folders]
    lines += ["", "CONVENTIONS"]
    lines += [json.dumps(_without_empty(convention.model_dump()), ensure_ascii=False) for convention in request.conventions]
    lines += ["", "DOCUMENTS"]
    for document in request.documents:
        fields = _without_empty(document.model_dump())
        fields["folder"] = document.folder  # "" is the root, and the model is told so
        lines.append(json.dumps(fields, ensure_ascii=False))
    return "\n".join(lines)


def parse_moves(data: dict[str, Any], request: FilingFitRequest) -> list[FilingMove] | None:
    """The model's moves, checked against the input; ``None`` when the answer is not the shape asked for.

    Dropped: an id the input did not name, a second move for one document, a
    folder neither in FOLDERS nor in CONVENTIONS, a move into the folder the
    document already sits in, an empty reason. A folder is answered in the
    input's own spelling.
    """
    raw = data.get("moves")
    if not isinstance(raw, list):
        return None
    documents = {document.id: document for document in request.documents}
    existing = {_path_key(folder.path): folder.path for folder in request.folders}
    conventions = {_path_key(convention.path): convention for convention in request.conventions}
    found: list[FilingMove] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        document = documents.get(str(item.get("id", "")))
        key = _path_key(str(item.get("folder", "")))
        reason = " ".join(str(item.get("reason", "")).split())
        if document is None or document.id in seen or not key or not reason:
            continue
        if key == _path_key(document.folder):
            continue
        if key in existing:
            found.append(FilingMove(id=document.id, folder=existing[key], reason=reason[:MAX_REASON]))
        elif key in conventions:
            convention = conventions[key]
            found.append(
                FilingMove(
                    id=document.id,
                    folder=convention.path,
                    reason=reason[:MAX_REASON],
                    new=True,
                    description=convention.description,
                )
            )
        else:
            continue
        seen.add(document.id)
    return found


def add_filing_fit_routes(router: APIRouter) -> None:
    """Register the filing judgement endpoint."""

    @router.post(
        "/v1/filing-fit",
        response_model=FilingFitResponse,
        tags=["documents"],
        summary="Judge which folder an upload batch's documents belong in",
        description="Reads metadata the BFF sends; proposes nothing it cannot ground in the input. A person decides.",
    )
    async def filing_fit(
        request: FilingFitRequest,
        x_grid_organization_id: str | None = Header(default=None),
    ) -> FilingFitResponse:
        if not request.documents or not (request.folders or request.conventions):
            return FilingFitResponse()

        cred = await asyncio.to_thread(_llm_settings, x_grid_organization_id)
        if not cred.api_key:
            return FilingFitResponse(error="llm_not_configured")

        payload = cred.request_body(
            {
                "model": cred.model,
                "temperature": 0,
                "max_tokens": 2000,
                "response_format": {"type": "json_object"},
                "messages": [
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user", "content": build_user_content(request)},
                ],
            }
        )
        headers = {"Content-Type": "application/json", "Authorization": f"Bearer {cred.api_key}"}
        metadata = {
            "batch_id": request.trace.batch_id,
            "project_id": request.trace.project_id or "",
            "shelf": request.trace.shelf,
            "basis": request.basis,
            "documents": len(request.documents),
            "folders": len(request.folders),
            "conventions": len(request.conventions),
        }
        # The name basis runs while the person still looks at the upload.
        limiter = provider_limiter.INTERACTIVE if request.basis == "name" else provider_limiter.BULK
        trace_id: str | None = None
        try:
            async with (
                observed_generation(
                    TRACE_NAME, model=cred.model, messages=payload.get("messages"), metadata=metadata
                ) as generation,
                limited_async_http_client(cls=limiter, timeout=_REQUEST_TIMEOUT_SECONDS) as client,
            ):
                trace_id = generation.trace_id
                response = await client.post(f"{cred.base_url}/chat/completions", json=payload, headers=headers)
                response.raise_for_status()
                data = response.json()
                generation.finish(data)
            content, _finish = message_content(data)
            answer = extract_json_object(content)
        except httpx.HTTPError as exc:
            logger.warning("Filing judgement LLM call failed: %s", type(exc).__name__)
            return FilingFitResponse(error="llm_request_failed", trace_id=trace_id)
        except (KeyError, IndexError, TypeError, ValueError):
            logger.warning("Filing judgement LLM response had an unexpected shape")
            return FilingFitResponse(error="llm_response_malformed", model=cred.model, trace_id=trace_id)

        moves = parse_moves(answer, request)
        if moves is None:
            return FilingFitResponse(error="llm_response_malformed", model=cred.model, trace_id=trace_id)
        return FilingFitResponse(moves=moves, model=cred.model, trace_id=trace_id)
