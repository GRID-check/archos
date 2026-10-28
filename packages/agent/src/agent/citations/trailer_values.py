"""Trailer-value grounding: a copyable value (a number, a class, a deadline) needs a Fundstelle this turn."""

from __future__ import annotations

import logging
import re
from collections.abc import Sequence
from typing import Any

from agent.citations.citation_keys import parse_citation_key
from agent.citations.entries import SourceEntry

logger = logging.getLogger(__name__)


#: A measurement with its unit: ``100 cm``, ``1,10 m``, ``55 dB``, ``6 %``.
#: The unit is what separates a copyable value from a locator — a bare number
#: is a table, a Punkt or a paragraph, never something a reader builds from.
_VALUE_ZAHL_RE = re.compile(
    r"\b\d+(?:[.,]\d+)?\s*(?:m²|m³|cm\b|mm\b|km\b|m\b|dB\b|%|°C\b|kWh\b|Stpl\.?\b|Stück\b|kg\b|\bh\b|min\b)",
    re.IGNORECASE,
)


#: A fire-resistance or building class: ``REI 60``, ``EI 30``, ``R 90``,
#: ``F 90``, ``GK 4``, ``Gebäudeklasse 4``. The digit floor (2–3 for
#: resistances) keeps ``R 2``-shaped fragments from firing.
_VALUE_KLASSE_RE = re.compile(
    r"\b(?:REI|EI?|R|F)\s*-?\s*\d{2,3}\b|\bGK\s*\d\b|\b\w*klasse\s+\d\b",
    re.IGNORECASE,
)


#: A deadline span: ``4 Jahre``, ``sechs Wochen``, ``binnen``, ``unverzüglich``.
#: Word-numbers are closed (ein–zwölf) because an open ``\w+`` before a time
#: noun matches ``nächste Woche`` — a pointer, not a span.
_VALUE_DEADLINE_RE = re.compile(
    r"\b\d+\s*(?:Tag|Woche|Monat|Jahr|Stunde|Minute|Sekunde)\w*\b"
    r"|\b(?:ein(?:e|er|em|en|es)?|zwei|drei|vier|fünf|sechs|sieben|acht|neun|zehn|elf|zwölf)"
    r"\s+(?:Tag|Woche|Monat|Jahr|Stunde|Minute|Sekunde)\w*\b"
    r"|\bbinnen\b|\bunverzüglich\b",
    re.IGNORECASE,
)


#: A Fundstelle shorter than this, once normalised, is not a document name a
#: substring test can judge — mirrors the verdict gate's own floor.
_VALUE_MIN_MATCHABLE_NAME_CHARS = 4


def _copyable_value_present(text: str) -> bool:
    """Whether ``text`` states a Zahl, Klasse or Frist a reader would copy."""
    if not text:
        return False
    return bool(_VALUE_ZAHL_RE.search(text) or _VALUE_KLASSE_RE.search(text) or _VALUE_DEADLINE_RE.search(text))


def _turn_source_names(turn_sources: Sequence[SourceEntry]) -> frozenset[str]:
    """Normalised names of the documents this turn retrieved.

    Both identities a trailer Fundstelle could name — the indexed basename and
    the display title — reduced through ``normalize_document_name``, exactly
    like :func:`agent_authored_document_names`. Short names are dropped at the
    match, not here.
    """
    from agent.common.provenance import normalize_document_name

    names: set[str] = set()
    for entry in turn_sources or ():
        file_name, _page = parse_citation_key(entry.citation_key or "")
        base_name = file_name.rsplit("/", 1)[-1]
        names.update(normalize_document_name(value) for value in (base_name, entry.title))
    names.discard("")
    return frozenset(names)


def _names_turn_source(signal: str, names: frozenset[str]) -> bool:
    """Whether a Fundstelle signal names a document this turn retrieved."""
    from agent.common.provenance import normalize_document_name

    named = normalize_document_name(signal)
    if len(named) < _VALUE_MIN_MATCHABLE_NAME_CHARS:
        return False
    return any(name in named or named in name for name in names if len(name) >= _VALUE_MIN_MATCHABLE_NAME_CHARS)


def drop_ungrounded_trailer_values(
    meta: dict[str, Any] | None,
    turn_sources: Sequence[SourceEntry],
) -> dict[str, Any] | None:
    """Drop trailer VALUES no retrieved source stands behind; the prose survives.

    Operates on the GATED ``answer_meta`` wire dict (``gate_answer_meta`` has
    already run): a verdict whose value carries a Zahl/Klasse/Frist but whose
    ``reference`` names no turn source is dropped; a takeaway item whose text
    carries one is dropped unless its ``detail`` names one; a ``detail`` (on a
    takeaway item or the callout) that carries one itself but names none is
    dropped while its claim stays. Fields without a value are never touched,
    and with no turn sources the gate abstains. Returns ``None`` when no
    anatomy survives — the same empty-means-absent contract ``gate_answer_meta``
    keeps.
    """
    if not meta:
        return None
    sources = list(turn_sources or [])
    if not sources:
        return meta
    names = _turn_source_names(sources)
    pruned = dict(meta)

    verdict = pruned.get("verdict")
    if isinstance(verdict, dict):
        reference = verdict.get("reference")
        document = reference.get("document") if isinstance(reference, dict) else None
        if _copyable_value_present(str(verdict.get("value") or "")) and not (
            isinstance(document, str) and _names_turn_source(document, names)
        ):
            pruned.pop("verdict", None)

    takeaways = pruned.get("takeaways")
    if isinstance(takeaways, list):
        kept: list[dict[str, Any]] = []
        for item in takeaways:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "")
            detail = item.get("detail")
            if _copyable_value_present(text) and not (isinstance(detail, str) and _names_turn_source(detail, names)):
                continue
            if (
                isinstance(detail, str)
                and detail.strip()
                and _copyable_value_present(detail)
                and not _names_turn_source(detail, names)
            ):
                item = {key: value for key, value in item.items() if key != "detail"}
            kept.append(item)
        if kept:
            pruned["takeaways"] = kept
        else:
            pruned.pop("takeaways", None)

    callout = pruned.get("callout")
    if isinstance(callout, dict):
        detail = callout.get("detail")
        if (
            isinstance(detail, str)
            and detail.strip()
            and _copyable_value_present(detail)
            and not _names_turn_source(detail, names)
        ):
            pruned["callout"] = {key: value for key, value in callout.items() if key != "detail"}

    if not any(key != "v" for key in pruned):
        return None
    return pruned
