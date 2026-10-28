"""``knowledge_search`` and ``list_files`` as a binding that reads the estate by path sees them (ADR-0133 slice 6).

The same agent-runtime functions, rebound: ranked search scoped by ``path`` (the literal modes are ``grep``),
and the listing without its tree view (that is ``ls(depth=…)``). The descriptions are the shared
ones with one paragraph replaced; the schemas are the functions' own minus the fields that left,
and forbid unknown arguments, so a retired one is an error naming it (``common.retired_calls``).
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from pydantic import ConfigDict
from pydantic import Field
from pydantic import create_model
from pydantic import model_validator
from pydantic.json_schema import SkipJsonSchema

from agent.common.tool_calls import CONCLUSION_DESCRIPTION

from .browse import _LIST_FILES_DESCRIPTION
from .browse import TREE_PARAGRAPH
from .register import knowledge_search_description
from .register import result_budget

#: The scope paragraph of the shared description, for this binding.
CHAT_SCOPE = (
    "Inputs: `query`, a search query in the documents' language (topic, Land, year), not the person's message. "
    "`path=` limits it to a mount, folder or document (`/law/oib/`, `/project/Gutachten/`); without it every "
    "mount is searched. `doc_class=` (a Dokumentart key, `oib_guideline`), `title_contains=`, `document_type=` (a "
    "kind Piloti recognised, `fire_safety_concept`) and `refers_to=` (a norm, law or plan number the document "
    "cites) narrow further. Ranked passages are a sample, not every mention: for exact wording, every "
    "occurrence, or to show a term stands nowhere, use `grep`. "
)
#: Accepted, never offered, until the ``retired-call`` tag stops counting them: `path` names the same scope.
HIDDEN = ("folder", "shelf", "file_name")
DROPPED = {"knowledge_search": ("match", "stemmed", "context", "filters"), "list_files": ("view", "depth")}


def _note_hidden(model: Any) -> Any:
    if any(getattr(model, name, None) for name in HIDDEN):
        from agent.common.retired_calls import note_retired_call

        note_retired_call()
    return model


def _schema(schema: Any, drop: Sequence[str], hidden: Sequence[str]) -> Any:
    fields: dict[str, Any] = {}
    for name, info in schema.model_fields.items():
        if name in drop:
            continue
        annotation = SkipJsonSchema[info.annotation] if name in hidden else info.annotation  # ty: ignore
        described = Field(default=info.default, description=CONCLUSION_DESCRIPTION) if name == "conclusion" else info
        fields[name] = (annotation, described)
    validators = {"_note_hidden": model_validator(mode="after")(_note_hidden)} if hidden else {}
    return create_model(
        f"Chat{schema.__name__}", __config__=ConfigDict(extra="forbid"), __validators__=validators, **fields
    )


def chat_tools(tools: Sequence[Any], *, top_k: int, max_per_document: int) -> list[Any]:
    """``tools`` with ``knowledge_search`` and ``list_files`` rebound; everything else untouched."""
    descriptions = {
        "knowledge_search": f"{knowledge_search_description(('meaning',), scope=CHAT_SCOPE)} "
        f"{result_budget(top_k, max_per_document)}",
        "list_files": _LIST_FILES_DESCRIPTION.replace(TREE_PARAGRAPH, ""),
    }
    return [
        tool.model_copy(
            update={
                "description": descriptions[tool.name],
                "args_schema": _schema(
                    tool.args_schema, DROPPED[tool.name], HIDDEN if tool.name == "knowledge_search" else ()
                ),
            }
        )
        if getattr(tool, "name", None) in DROPPED
        else tool
        for tool in tools
    ]
