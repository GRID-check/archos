"""Superseded Fassungen: files a person replaced stay out of the ranking, and the result says so."""

import asyncio
import logging
from collections.abc import Sequence

logger = logging.getLogger(__name__)


#: Replaced files one notice names before it counts the rest.
_HIDDEN_REVISIONS_NAMED = 5


async def superseded_files(collections: Sequence[str]) -> dict[str, dict[str, str]]:
    """Per collection, the files a PERSON replaced by a newer one, each with the file that replaced it, read now.

    Resolved at query time, the way a folder is: whether a file is replaced is
    not on its chunks, and a link made or lifted a minute ago must apply to the
    next search. Fail-open: a collection that cannot be read hides nothing.
    """
    from aiq_agent.knowledge import get_superseded_files

    answers = await asyncio.gather(
        *(asyncio.to_thread(get_superseded_files, collection) for collection in collections),
        return_exceptions=True,
    )
    return {
        collection: dict(sorted(answer.items()))
        for collection, answer in zip(collections, answers, strict=True)
        if isinstance(answer, dict) and answer
    }


def named_older_revision_notice(file_name: str | None, superseded: dict[str, dict[str, str]]) -> str:
    """The line that tells the model the file it named (``file_name=…``) is an older Fassung, and which is current.

    Naming the file is how an older Fassung is read on purpose, so its passages are not withheld;
    the line keeps the answer from presenting them as the document's current state. Follows the
    links to the end of the chain, and names nothing in a restricted collection nobody admitted.
    The same words as ``read_passage``'s notice (:func:`older_revision_line`).
    """
    if not file_name:
        return ""
    from aiq_agent.knowledge.restricted_use import may_name

    from .read_passage import older_revision_line

    lines = []
    for collection, links in superseded.items():
        if file_name not in links or not may_name(collection):
            continue
        seen, current = {file_name}, links[file_name]
        while current in links and current not in seen:
            seen.add(current)
            current = links[current]
        lines.append(older_revision_line(file_name, current))
    return "".join(sorted(set(lines)))


def hidden_revisions_notice(superseded: dict[str, dict[str, str]]) -> str:
    """The one line that tells the model older Fassungen were left out of the ranking, and how to read one."""
    names = sorted({name for hidden in superseded.values() for name in hidden})
    if not names:
        return ""
    shown = ", ".join(names[:_HIDDEN_REVISIONS_NAMED])
    rest = len(names) - _HIDDEN_REVISIONS_NAMED
    tail = f" and {rest} more" if rest > 0 else ""
    return f"Older Fassungen left out: {shown}{tail}; each is readable when it is named.\n\n"
