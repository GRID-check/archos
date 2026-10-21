"""Control-marker detection for Piloti's answer contract.

Piloti's prompt makes the model end research answers with two
control markers:

- ``[ESCALATE_TO_DEEP]`` — the model judged its own answer insufficient and
  asks to escalate to deep research.
- ``[CONFIDENCE:low|medium|high]`` (optionally ``[CONFIDENCE:low | Grund…]``)
  — the model's self-assessment of how well the answer is grounded in its
  sources, with an optional one-clause justification the UI surfaces so the
  reader can see WHY the level was chosen.

These helpers live in the Piloti package (the layer that OWNS the
marker contract) so both Piloti (which now extracts + strips them
before emitting/returning content) and the chat orchestrator (which consumes the
resulting structured signals, with string-detection as a back-compat fallback)
can share one implementation without a circular import.
"""

from __future__ import annotations

import re
from typing import Any
from typing import Literal

ESCALATION_MARKER = "[ESCALATE_TO_DEEP]"
_ESCALATION_MARKER_RE = re.compile(re.escape(ESCALATION_MARKER))

# The model ends every research answer with a self-assessment marker of the
# form ``[CONFIDENCE:low|medium|high]``, optionally followed by ``| reason`` —
# a one-clause justification (in the answer's language) the UI shows so the
# reader understands WHY the level was chosen. The payload is bracketed and the
# level case-insensitive; the level token is validated against the enum below so
# a malformed value ("certain", empty, …) is stripped from the text but yields
# no signal. A reason is only meaningful with a valid level.
CONFIDENCE_MARKER_RE = re.compile(r"\[CONFIDENCE:\s*([^\]]*)\]", re.IGNORECASE)
_VALID_CONFIDENCE_VALUES = frozenset({"low", "medium", "high"})

# Hard bound on the surfaced justification: the prompt asks for one short
# clause, but a rambling model must not bloat the wire payload or the chip.
_CONFIDENCE_REASON_MAX_CHARS = 300

ConfidenceLevel = Literal["low", "medium", "high"]

# Control markers are only meaningful as answer *signals* when the model appends
# them at the very end of its reply (the prompt contract). A marker that appears
# earlier — e.g. quoted inside an explanation of the marker contract itself — is
# body text, not a signal, and must be left intact. We therefore only treat (and
# strip) marker occurrences that fall inside the TAIL REGION: the span covering
# the last N non-empty lines of the content.
_TAIL_REGION_LINES = 3


def _tail_region_start(content: str, lines: int = _TAIL_REGION_LINES) -> int:
    """Return the char offset where the tail region begins.

    The tail region is the contiguous span from the start of the earliest of the
    last ``lines`` non-empty lines through the end of ``content`` (any trailing
    or interspersed blank lines are included). A marker at or after this offset
    is a trailing signal; one before it is body text.
    """
    non_empty_seen = 0
    start = len(content)
    idx = len(content)
    for line in reversed(content.splitlines(keepends=True)):
        idx -= len(line)
        if not line.strip():
            continue
        non_empty_seen += 1
        start = idx
        if non_empty_seen == lines:
            break
    return start


def _strip_matches(content: str, matches: list[re.Match[str]]) -> str:
    """Remove the given (non-overlapping, ascending) match spans from content."""
    pieces: list[str] = []
    cursor = 0
    for match in matches:
        pieces.append(content[cursor : match.start()])
        cursor = match.end()
    pieces.append(content[cursor:])
    return "".join(pieces)


def detect_and_strip_escalation_marker(content: Any) -> tuple[Any, bool]:
    """Detect and remove Piloti's insufficiency marker from a message.

    If ``content`` is not a string it is returned unchanged with ``False``.
    Only occurrences of :data:`ESCALATION_MARKER` inside the TAIL REGION (the
    last :data:`_TAIL_REGION_LINES` non-empty lines) count as a signal and are
    stripped; a marker quoted earlier in the body is left intact and produces no
    signal. When a tail occurrence is removed the resulting trailing whitespace
    (including any dangling blank line the marker left behind) is collapsed, and
    ``(stripped, was_present)`` is returned.
    """
    if not isinstance(content, str):
        return content, False

    tail_start = _tail_region_start(content)
    matches = [m for m in _ESCALATION_MARKER_RE.finditer(content) if m.start() >= tail_start]
    if not matches:
        return content, False

    # Collapse trailing whitespace and any blank line left where the marker sat.
    stripped = _strip_matches(content, matches).rstrip()
    return stripped, True


def _parse_confidence_payload(payload: str) -> tuple[ConfidenceLevel | None, str | None]:
    """Split a marker payload into its level and optional reason.

    The payload is everything between ``[CONFIDENCE:`` and ``]``: a level token,
    optionally followed by ``|`` and a one-clause justification
    (``"high | Direkt durch OIB-RL 2 belegt"``). The level is the text before
    the FIRST ``|`` (stripped, lowercased, enum-validated); the reason is the
    remainder, trimmed and capped at :data:`_CONFIDENCE_REASON_MAX_CHARS`. A
    payload without ``|`` yields no reason; a payload whose level token is not
    one of the three valid values yields ``(None, None)`` — an unknown level
    never invents a signal, and a reason without a valid level is meaningless.
    """
    level_token, _, raw_reason = payload.partition("|")
    candidate = level_token.strip().lower()
    if candidate not in _VALID_CONFIDENCE_VALUES:
        return None, None
    reason = raw_reason.strip()[:_CONFIDENCE_REASON_MAX_CHARS] or None
    return candidate, reason  # type: ignore[return-value]


def detect_and_strip_confidence_marker(content: Any) -> tuple[Any, ConfidenceLevel | None, str | None]:
    """Detect and remove the model's self-assessed confidence marker.

    Mirrors :func:`detect_and_strip_escalation_marker`: fail-open and
    tail-anchored. If ``content`` is not a string it is returned unchanged with
    ``(content, None, None)``. Only ``[CONFIDENCE:...]`` markers inside the TAIL
    REGION (the last :data:`_TAIL_REGION_LINES` non-empty lines, matched
    case-insensitively) are treated as signals and stripped so the user never
    sees them; a marker quoted earlier in the body is left intact and yields no
    signal. The parsed signal is returned as ``(stripped, level, reason)``:

    - ``level`` is the well-formed value ("low"/"medium"/"high") — the last
      valid one within the tail when several appear (the answer's final marker
      wins); ``reason`` is that marker's optional ``| …`` justification.
    - No tail marker, or a tail marker whose level is not one of the three,
      yields ``(stripped, None, None)`` (no signal). Malformed tail markers are
      still stripped.

    Order-insensitive with respect to the escalation marker: each marker is
    detected and removed independently, so both may co-occur in any order.
    """
    if not isinstance(content, str):
        return content, None, None

    tail_start = _tail_region_start(content)
    matches = [m for m in CONFIDENCE_MARKER_RE.finditer(content) if m.start() >= tail_start]
    if not matches:
        return content, None, None

    level: ConfidenceLevel | None = None
    reason: str | None = None
    for match in matches:
        candidate, candidate_reason = _parse_confidence_payload(match.group(1))
        if candidate is not None:
            level = candidate
            reason = candidate_reason

    stripped = _strip_matches(content, matches).rstrip()
    return stripped, level, reason


# ---------------------------------------------------------------------------
# Overconfidence guard
# ---------------------------------------------------------------------------
#
# Pure functions over a parsed ``[CONFIDENCE:…]`` level: the deterministic cap
# the platform applies to the model's self-assessment. They live here, beside
# the marker contract they interpret.
#
# Two rules, and a turn says which it was computed under
# (``claim_provenance.CONFIDENCE_RULE_VERSION`` on the wire):
#
# - **Rule 2, chat** (:func:`surface_claim_confidence`, ADR-0124): the level is
#   the self-report, held under the weakest load-bearing SENTENCE's ceiling
#   (``common/claim_provenance.py``). A record, an action or a measurement
#   grounds the sentences it states; a normative sentence still needs a
#   passage, so no evidence of the second kind can launder a claim about the
#   law.
# - **Rule 1, deep research** (:func:`surface_answer_confidence`): the
#   answer-level floors. A research report has no per-sentence stamps yet,
#   and every chat turn stored before rule 2 was computed under it.


#: Why a self-report was downgraded.
#:
#: - ``ungrounded``             nothing behind the weakest sentence: no verified
#:   citation and no record or measurement (rule 1: for the whole answer).
#: - ``quote_unverified``       a quoted span matched no retrieved passage.
#: - ``normative_claim_uncited`` a claim about the law with no passage behind it.
#:   Rule 1: a measured answer that also talks about the law; rule 2: any
#:   load-bearing normative sentence that is not quoted or cited.
#: - ``measurement_only``       rule 1 only: measurement-grounded and purely
#:   descriptive, so "high" was reduced to "medium".
#: - ``citation_fallback``      no longer produced: the single-source fallback is
#:   gone (ADR-0124). Kept because stored turns carry it.
CappedReason = Literal[
    "ungrounded",
    "quote_unverified",
    "normative_claim_uncited",
    "measurement_only",
    "citation_fallback",
]

#: The ceiling measurement grounding can reach under rule 1. Never "high":
#: without per-sentence stamps a measurement is grounding for the answer's
#: NUMBERS, not for every sentence around them.
MEASUREMENT_CONFIDENCE_CEILING: ConfidenceLevel = "medium"

_CONFIDENCE_ORDER: tuple[ConfidenceLevel, ...] = ("low", "medium", "high")


def _at_most(level: ConfidenceLevel, ceiling: ConfidenceLevel) -> ConfidenceLevel:
    """``level`` clamped down to ``ceiling`` — never raises a self-report."""
    return level if _CONFIDENCE_ORDER.index(level) <= _CONFIDENCE_ORDER.index(ceiling) else ceiling


def surface_answer_confidence(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
    *,
    measurement_grounded: bool = False,
    normative_claim_uncited: bool = False,
) -> ConfidenceLevel | None:
    """Rule 1: the answer-level floors, for an answer with no per-sentence stamps (deep research).

    Returns ``None`` when there is no self-assessment to surface. Citation
    grounding is the only route to "high": an answer grounded in a verified
    citation with every quoted span verified surfaces the model's own level.
    Measurement grounding lifts an answer off "low" to at most
    :data:`MEASUREMENT_CONFIDENCE_CEILING`, and only when the answer makes no
    uncited normative claim. An unverified quote caps to "medium" under a
    citation and to "low" without one, BEFORE measurement grounding is
    consulted: a measured number must never rescue a fabricated quotation.
    """
    if self_reported is None:
        return None
    if citation_grounded and quotes_verified:
        return self_reported
    if not quotes_verified:
        if citation_grounded:
            return _at_most(self_reported, MEASUREMENT_CONFIDENCE_CEILING)
        return "low"
    if measurement_grounded and not normative_claim_uncited:
        return _at_most(self_reported, MEASUREMENT_CONFIDENCE_CEILING)
    return "low"


def answer_confidence_capped_reason(
    self_reported: ConfidenceLevel | None,
    citation_grounded: bool,
    quotes_verified: bool = True,
    *,
    measurement_grounded: bool = False,
    normative_claim_uncited: bool = False,
) -> CappedReason | None:
    """Why rule 1 capped the surfaced confidence, or ``None`` when no cap applied.

    Derived from :func:`surface_answer_confidence`, so the reason can never
    disagree with the level it explains. Precedence: ``quote_unverified``
    whenever the answer had some grounding but a quote failed; then the mixed
    case ``normative_claim_uncited``; then ``measurement_only``; else
    ``ungrounded``.
    """
    if self_reported is None or self_reported == "low":
        return None
    surfaced = surface_answer_confidence(
        self_reported,
        citation_grounded,
        quotes_verified,
        measurement_grounded=measurement_grounded,
        normative_claim_uncited=normative_claim_uncited,
    )
    if surfaced == self_reported:
        return None
    if not quotes_verified and (citation_grounded or measurement_grounded):
        return "quote_unverified"
    if not citation_grounded:
        if measurement_grounded and normative_claim_uncited:
            return "normative_claim_uncited"
        if measurement_grounded:
            return "measurement_only"
        return "ungrounded"
    return "quote_unverified"


def _quote_cap(quotes_verified: bool, citation_grounded: bool) -> ConfidenceLevel:
    """The hard quote gate both rules share: a quote no passage holds caps to medium under a citation, else low."""
    if quotes_verified:
        return "high"
    return MEASUREMENT_CONFIDENCE_CEILING if citation_grounded else "low"


def surface_claim_confidence(
    self_reported: ConfidenceLevel | None,
    claims_ceiling: ConfidenceLevel | None,
    *,
    quotes_verified: bool = True,
    citation_grounded: bool = False,
) -> ConfidenceLevel | None:
    """Rule 2: ``min(self-report, weakest load-bearing sentence's ceiling)``, under the hard quote gate.

    ``claims_ceiling`` is ``claim_provenance.claims_ceiling`` of the final
    answer; ``None`` (an answer with no sentence) leaves the self-report to the
    quote gate alone. The self-report is never raised.
    """
    if self_reported is None:
        return None
    level = _at_most(self_reported, _quote_cap(quotes_verified, citation_grounded))
    return _at_most(level, claims_ceiling) if claims_ceiling is not None else level


def claim_confidence_capped_reason(
    self_reported: ConfidenceLevel | None,
    claims_ceiling: ConfidenceLevel | None,
    weakest: tuple[str, str] | None,
    *,
    quotes_verified: bool = True,
    citation_grounded: bool = False,
) -> CappedReason | None:
    """Why rule 2 lowered the self-report, or ``None`` when it did not.

    ``weakest`` is ``(provenance class, claim type)`` of the sentence that set
    the ceiling. A failed quote is named first when it alone explains the
    level; otherwise a normative sentence without a passage is
    ``normative_claim_uncited`` and anything else without evidence is
    ``ungrounded``.
    """
    surfaced = surface_claim_confidence(
        self_reported, claims_ceiling, quotes_verified=quotes_verified, citation_grounded=citation_grounded
    )
    if self_reported is None or surfaced == self_reported:
        return None
    quote_level = _at_most(self_reported, _quote_cap(quotes_verified, citation_grounded))
    if quote_level == surfaced and quote_level != self_reported:
        return "quote_unverified"
    if weakest is not None and weakest[1] == "normative":
        return "normative_claim_uncited"
    return "ungrounded"
