"""How Piloti's chat binds the knowledge layer's two shared tools (ADR-0133 slice 6).

``knowledge_search`` and ``list_files`` are one NAT function each, bound by three
agents: Piloti's chat, deep research and project intake. Deep research and intake
keep the full contracts (the literal ``match`` modes, the listing). Piloti reads the
estate through ``ls``, ``glob``, ``grep`` and ``read_file``, so on its binding

* ``knowledge_search`` is ranked search only: no ``match``, ``stemmed``,
  ``context`` or ``filters``, and ``path`` in place of ``folder``, ``shelf`` and
  ``file_name``, which stay accepted, hidden, for one release (a conversation
  that held a search by them invites the model to repeat it);
* ``list_files`` is the Fassungen of one document: ``revisions_of`` and
  ``compare_to``, nothing else, because a revisions surface has no standard name
  (inventing one would be the translation AGENTS.md warns about).

The variant is chosen at bind time (:func:`chat_tools`), never in the shared
description, so the other two agents are told only about what they have. A call
in Piloti to an argument this binding no longer offers is answered by the
retired-call guard (``aiq_agent.common.retired_calls``) before the tool runs.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import Field
from pydantic.json_schema import SkipJsonSchema

#: The NAT function names this module rebinds.
KNOWLEDGE_SEARCH = "knowledge_search"
LIST_FILES = "list_files"

#: Said of ``conclusion`` on every evidence verb; the one field description the model sees.
CONCLUSION_DESCRIPTION = "Optional: one line on what you are looking for, shown to the person. No effect on the result."


def chat_knowledge_search_description(top_k: int, max_per_document: int) -> str:
    """``knowledge_search`` as Piloti's chat sees it: ranked search, with the result budget it plans around."""
    per_document = f", at most {max_per_document} from one document" if max_per_document > 0 else ""
    return (
        f"Searches documents by meaning and returns the best-ranked passages, each citable: up to {top_k} by "
        f"default{per_document}. For a topic, a question or a requirement worded differently from the documents. "
        "Ranked passages are a sample, not every mention: for exact wording, every occurrence, or to show a term "
        "stands nowhere, use grep. `query` is a search query in the documents' language (topic, Land, year), not the "
        "person's message. `path` limits it to a mount, folder or document (`/law/oib/`, `/project/Gutachten/`); "
        "without it every mount is searched. `doc_class` (a Dokumentart key, `oib_guideline`), `title_contains`, "
        "`document_type` (a kind Piloti recognised, `fire_safety_concept`) and `refers_to` (a norm, law or plan "
        'number the document cites) narrow further. `group_by="document"` returns one entry per document with its '
        "best passage and how many ranked passages it held. A query naming only a Richtlinie (`OIB 2`) returns "
        "each of its parts with Geltungsbereich and Gliederung."
    )


class ChatKnowledgeSearchInput(BaseModel):
    """``knowledge_search``'s arguments on Piloti's chat binding: bare, the description says what each means."""

    query: str
    path: str | None = None
    doc_class: str | None = None
    title_contains: str | None = None
    document_type: str | None = None
    refers_to: str | None = None
    group_by: Literal["document"] | None = None
    conclusion: str = Field(default="", description=CONCLUSION_DESCRIPTION)
    # Accepted for one release and never offered: they compile to the same scope `path` names.
    folder: SkipJsonSchema[str | None] = None
    shelf: SkipJsonSchema[str | None] = None
    file_name: SkipJsonSchema[str | None] = None


CHAT_LIST_FILES_DESCRIPTION = (
    "The Fassungen of one document. `revisions_of` (a file name) returns its chain of Fassungen, newest first, "
    "each with Index or Datum, upload date and what changed against the one before. With `compare_to` (another "
    'Fassung\'s file name, or "previous") it returns what changed page by page, in the printed text and in the '
    "reading of the drawings. To list folders and files, use ls or glob."
)


class ChatListFilesInput(BaseModel):
    """``list_files``'s arguments on Piloti's chat binding: the Fassungen of one document."""

    revisions_of: str
    compare_to: str | None = None


def chat_tools(tools: Sequence[Any], *, top_k: int, max_per_document: int) -> list[Any]:
    """``tools`` with ``knowledge_search`` and ``list_files`` rebound to Piloti's chat contracts.

    Only the description and the schema change: the NAT function underneath is the
    one deep research and intake call, so what a call returns is the same.
    ``top_k`` and ``max_per_document`` are the search's configured budget, the
    numbers the description states.
    """
    rebound = {
        KNOWLEDGE_SEARCH: {
            "description": chat_knowledge_search_description(top_k, max_per_document),
            "args_schema": ChatKnowledgeSearchInput,
        },
        LIST_FILES: {"description": CHAT_LIST_FILES_DESCRIPTION, "args_schema": ChatListFilesInput},
    }
    return [
        tool.model_copy(update=rebound[name]) if (name := getattr(tool, "name", None)) in rebound else tool
        for tool in tools
    ]
