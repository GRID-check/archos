"""The arguments Piloti's chat binding retired, and the call that replaces each (ADR-0133 slice 6).

Its ``knowledge_search`` and ``list_files`` schemas forbid unknown arguments, so a call that still
passes one is rejected with the field named (``tool_errors.render_tool_error``) instead of running
with the argument dropped; this adds the replacement. An unbound name (``read_passage``) is answered
by the ``ToolNode`` itself, with the tools there are. The ``retired-call`` trace tag counts both
these and the hidden scope arguments still accepted (``chat_binding``): when it stops firing, they go.
"""

from __future__ import annotations

from collections.abc import Iterable

RETIRED_CALL_TAG = "retired-call"

RETIRED_ARGUMENTS = {
    "match": 'a literal search is `grep(pattern=…, mode="exact"|"regex", output_mode="content")`',
    "stemmed": "inflected forms are `grep(pattern=…, stemmed=true)`",
    "context": 'lines around a match are `grep(pattern=…, output_mode="content", context=…)`',
    "view": "a folder's tree is `ls(path=…, depth=2)`",
    "depth": "a folder's tree is `ls(path=…, depth=2)`",
}


def retired_hints(fields: Iterable[str]) -> list[str]:
    """The replacement for each retired argument among ``fields``, once each; tags the turn when there is one."""
    hints = list(dict.fromkeys(RETIRED_ARGUMENTS[field] for field in fields if field in RETIRED_ARGUMENTS))
    if hints:
        note_retired_call()
    return hints


def note_retired_call() -> None:
    """Tag the turn's trace: an old spelling is still in use."""
    from agent.observability.langfuse_trace_attributes import add_trace_tag

    add_trace_tag(RETIRED_CALL_TAG)
