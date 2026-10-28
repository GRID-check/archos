"""The messages for a read that names no document, names one the corpus lacks, or finds no passage: the did-you-
mean names and the wording of each.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

from agent.common.action_outcome import ActionOutcome

from .read_passage_models import PassageTarget
from .read_passage_models import ReadPassageInput
from .read_passage_ranges import _locus_label
from .read_passage_targets import _document_names

#: How many verbatim guesses an unknown-document refusal may name.
_MAX_DID_YOU_MEAN = 3

#: Minimum similarity (difflib ratio over case-folded names) for a guess to be
#: named. Below this the closest inventory title is noise rather than help,
#: and the refusal stands on the two recovery ways alone. 0.6 is the stdlib
#: ``get_close_matches`` default: 0.4 let cross-document titles with a shared
#: suffix ("Plan.pdf" vs "Brandschutzkonzept.pdf" at 0.40) spend a guess the
#: caller cannot use.
_DID_YOU_MEAN_CUTOFF = 0.6

#: Every refusal that a name is not readable says this, because the agent read
#: "not readable" as "not there": a file whose read failed is in the project and
#: in none of the lists a read builds (feld72, Jour fixe 2026-10-09).
_NOT_READABLE_IS_NOT_ABSENT = (
    "Not readable here is not the same as not in the project: a file whose read failed is listed under "
    "`documents_unreadable:` in the project context — say it could not be read, never that it is missing."
)


def _suggestion_names(wanted: str, documents: list[Any], *, limit: int = _MAX_DID_YOU_MEAN) -> list[str]:
    """Up to ``limit`` legal inventory names closest to ``wanted``, most similar first.

    One suggestion per document — the closest of its legal names
    (:func:`_document_names`), so a mistyped display title still finds its file
    without one document spending two of the three guesses. Each suggestion is
    returned in its ORIGINAL spelling, which passes :func:`_matches` verbatim:
    a guess the caller cannot pass back exactly is a second way to be refused.
    Scope-restricted by construction: only the documents the caller passes in
    (this turn's readable inventory) are ranked, so a same-named file on an
    unreadable shelf is never suggested.
    """
    import difflib

    folded = (wanted or "").strip().casefold()
    if not folded:
        return []
    scored: list[tuple[float, str]] = []
    for document in documents or ():
        best_name = ""
        best_ratio = 0.0
        for name in _document_names(document):
            candidate = name.strip()
            if not candidate:
                continue
            ratio = difflib.SequenceMatcher(None, folded, candidate.casefold()).ratio()
            if ratio > best_ratio:
                best_name, best_ratio = candidate, ratio
        if best_name and best_ratio >= _DID_YOU_MEAN_CUTOFF:
            scored.append((best_ratio, best_name))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [name for _ratio, name in scored[:limit]]


def _unknown_document_message(document: str, known: int, suggestions: Sequence[str] | None = None) -> str:
    """Refuse a name nothing in scope carries, and say how to recover it.

    Never a dead end: with no readable documents the refusal points at the
    inventory (which is empty) and the topic search; with readable documents
    it names how to take a name from a hit or the inventory. When more
    candidates clear the bar than fit, the refusal shows the first three and
    names how many more exist, so the model refines the name instead of
    retyping the same near-miss.
    """
    names = [name for name in (suggestions or []) if str(name).strip()]
    shown = names[:_MAX_DID_YOU_MEAN]
    remaining = len(names) - len(shown)
    if known <= 0:
        base = (
            f"No document in scope is named {document!r}. No documents are readable this turn — "
            "the inventory is empty. Check the knowledge-base inventory (`surface_documents`) for "
            "what is filed, or call `knowledge_search` with the topic when you do not yet know "
            "which document holds it. Do not invent a citation. " + _NOT_READABLE_IS_NOT_ABSENT
        )
    else:
        base = (
            f"No document in scope is named {document!r}. This tool never guesses a name: it opens "
            "the document you name or nothing.\n"
            f"{known} document(s) are readable this turn. Take the name from a hit's `Source:` or "
            "`Citation:` line, or from the knowledge-base inventory, and call again — or call "
            "`knowledge_search` with the topic when you do not yet know which document holds it. "
            "Do not invent a citation. " + _NOT_READABLE_IS_NOT_ABSENT
        )
    if not shown:
        return base
    guesses = "\n".join(f"- {name}" for name in shown)
    message = (
        base + "\nDid you mean (guesses — pass one back verbatim as `document=` if it is the file "
        "you want, do not modify it):\n" + guesses
    )
    if remaining > 0:
        message += f"\n(+{remaining} more candidate(s) not shown — refine the name to narrow it down.)"
    return message


def _no_passage_message(
    document: str, clause: str | None, page: int | None, pages: tuple[int, int] | None = None
) -> str:
    """A resolved document that carries no such Punkt or page."""
    asked = _locus_label(document, clause, page, pages)
    hint = (
        "The Punkt must be the number alone as the hit's `Punkt:` line prints it ('3.5.2'), and "
        "a parent heading is not a chunk of its own — read the child Punkt instead. "
        if clause
        else ""
    )
    return (
        f"{document} carries no passage at {asked}. "
        + hint
        + "Search the topic with `knowledge_search` rather than citing a Punkt you could not open."
    )


def _empty_document_message(document: str) -> str:
    """A resolved document the store returned nothing at all for."""
    return (
        f"{document} is registered but no passage of it could be read — the store holds no "
        "chunk of this document. Search the topic with `knowledge_search` rather than citing a "
        "document you could not open."
    )


def _store_silent_message(query: str) -> str:
    """Every fetch for this locus raised. Not an empty document; an unanswered store."""
    from agent.common.tool_calls import FETCH_FAILED_MARKER

    # Marked so the agent's duplicate-fetch guard can tell this apart from a
    # passage that was actually read: without the marker the retry this
    # sentence asks for comes back "you already fetched that".
    return (
        f"{FETCH_FAILED_MARKER} Could not read {query}: the knowledge store did not answer. "
        "Retry once; if it fails again, say so and do not invent a citation."
    )


def _nameable(targets: Sequence[PassageTarget]) -> PassageTarget | None:
    """The first target whose document may be named to the model this turn (:func:`may_name`), or ``None``."""
    from agent.knowledge.restricted_use import may_name

    return next((target for target in targets if may_name(target.collection)), None)


def _note_target(outcome: ActionOutcome, targets: Sequence[PassageTarget]) -> None:
    """Put the resolved file name on the read's row, only where the model may be told it (ADR-0088).

    The row settles before the round's results are admitted. A file only an
    unadmitted restricted folder holds keeps the name the model asked for.
    """
    target = _nameable(targets)
    outcome.target = target.file_name if target is not None else None


def _read_row_fields(arguments: ReadPassageInput) -> dict[str, str | None]:
    """The Herleitung row of a read, from its own arguments: which document, which Punkt or pages (ADR-0132)."""
    clause = str(arguments.clause if arguments.clause is not None else "").strip().strip(".")
    page = str(arguments.page if arguments.page is not None else "").strip()
    pages = str(arguments.pages if arguments.pages is not None else "").strip()
    return {
        "target": (arguments.document or "").strip(),
        "pages": f"Pkt. {clause}" if clause else (pages or page or None),
    }


def _count(outcome: ActionOutcome, hits: int, targets: Sequence[PassageTarget]) -> None:
    """The passages a read returned, counted on its row unless the document may not be named yet."""
    outcome.record(hits, collections=[target.collection for target in targets])
