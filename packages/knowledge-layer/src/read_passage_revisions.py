"""The older-Fassung notice: which revision of a document a read is on, and the one-line note when it is an older
one.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from .read_passage_models import PassageTarget


def _current_revision(document: Any, documents: Sequence[Any]) -> str | None:
    """The file that now stands for ``document`` once a person confirmed it replaced, else ``None``.

    Follows ``superseded_by`` to the end of the chain (B was replaced by C, C by D: D), inside the
    document's own collection and only through rows that still exist. A loop, which the store
    refuses, stops where it closes.
    """
    by_name = {str(getattr(doc, "file_name", "")): doc for doc in documents}
    seen = {str(getattr(document, "file_name", ""))}
    current: str | None = None
    next_name = getattr(document, "superseded_by", None)
    while next_name and next_name in by_name and next_name not in seen:
        current = next_name
        seen.add(next_name)
        next_name = getattr(by_name[next_name], "superseded_by", None)
    return current


def _older_revision_notice(targets: Sequence[PassageTarget]) -> str:
    """The one line that tells the model the document it opened is an older Fassung, and which one is current.

    Rides the grounding block's notice slot, like „Ältere Fassungen ausgeblendet“ in the search, so
    the block's hash still matches the bytes the model reads. A read of an older Fassung is allowed:
    it is what „Index B“ and „die alte Fassung“ ask for. The line only keeps the answer from presenting it
    as the document's current state. A file in a restricted collection nobody admitted is never named.
    """
    from agent.knowledge.restricted_use import may_name

    older = {(target.file_name, target.current) for target in targets if target.current and may_name(target.collection)}
    if not older:
        return ""
    return "".join(older_revision_line(name, current) for name, current in sorted(older))


def older_revision_line(name: str, current: str) -> str:
    """The notice line for one older Fassung a tool hands the model: which file replaced it, and what to say."""
    return (
        f"Older Fassung: {name} is replaced by {current} (confirmed); {current} is current. "
        "Say in the answer that you are reading the older Fassung.\n\n"
    )
