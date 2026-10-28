"""What a finished research run's state says: its report, its sources, and the marks on its answer.

The runner is agent-agnostic, so every reader here is defensive: an agent may
return a state object, a dict or a string, and a field it never set, or set in
a shape that does not match, contributes nothing rather than a wrong claim.
``job_outcome.persist`` folds these into the job's persisted output and the
thread turn; the socket path lifts the same fields off a chat turn's state.
"""

from __future__ import annotations

from typing import Any

# The answer's self-assessment, lifted alongside the cutoff/degradation marks and
# spelled exactly as the socket path spells it (``persist_assistant_message``), so
# the BFF's existing decoder maps all three into the stored provenance with no
# frontend change. Deliberately NOT in _DEGRADED_EVENT_FIELDS above: a merely
# low-confidence answer is not a degraded run, and announcing one as the other
# would train operators to ignore the signal that means a run was cut off.
ANSWER_CONFIDENCE_FIELDS = (
    "answer_confidence",
    "answer_confidence_reason",
    "answer_confidence_capped_reason",
)


def mark_degraded(transparency: dict[str, Any], reason: str) -> None:
    """Add one degraded-reason token to an answer's transparency, in place.

    Appends rather than replaces: the agent's own reasons (no report file, no
    valid citation) are already there, in its order, and this is one more thing
    the reader should know, not a different claim about the run.
    """
    existing = transparency.get("degraded_reasons")
    reasons = [token for token in existing if isinstance(token, str)] if isinstance(existing, list) else []
    if reason not in reasons:
        reasons.append(reason)
    transparency["degraded_reasons"] = reasons


def extract_skills_activated(result: Any) -> list[str] | None:
    """The skill names a job run activated, or ``None``.

    The socket path lifts this off the agent state onto the terminal frame and
    persists it as message metadata; a job run had the same field on the same
    state and dropped it on the floor, so a thread written by a job showed no
    transparency where an interactive turn showed some. Read defensively (state
    object OR dict, list-of-str or nothing) because the runner is agent-agnostic
    by design — an agent whose state has no such field simply has none.
    """
    value = _state_field(result, "skills_activated")
    if not isinstance(value, list):
        return None
    names = [name for name in value if isinstance(name, str) and name]
    return names or None


def extract_verified_sources(result: Any) -> list[dict[str, Any]] | None:
    """The structured provenance of a finished run's answer, or ``None``.

    Each entry is one source the report CITED, as the agent's citation
    verification resolved it: the ``[N]`` label it wears in the prose, the
    document/file/page locator the reader opens a PDF with, the coarse ``kind``
    and the norm registry's binding note. The socket path lifts exactly this
    field off the state and posts it as ``sources``; the job path reduced the
    whole state to a report string, so a deep answer delivered as a job arrived
    with nothing but numbers scraped back out of its own Markdown — no
    open-at-page, no hover snippet, no authority badge — while the same answer
    streamed live arrived fully attributed.

    Read defensively (state object OR dict, entries type-checked one by one)
    because the runner is agent-agnostic by design: an agent whose state carries
    no such field contributes nothing here, and one that carries a malformed
    version contributes nothing rather than an unopenable chip.
    """
    value = _state_field(result, "verified_sources")
    if not isinstance(value, list):
        return None
    sources = [source for source in value if isinstance(source, dict) and source]
    return sources or None


def build_job_output(
    report: str,
    *,
    cards: list[Any] | None,
    transparency: dict[str, Any],
    sources: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The dict a finished job persists as its ``output``.

    A named function rather than three inline lines because this dict IS the
    contract a client reads a finished job by, and inline it could not be
    checked without standing up a worker and a job store.

    ``report`` is always there. Everything else is present or absent, never
    present-and-empty: no ``cards: []`` on a run that produced none, and no
    ``research_truncated: false`` on a run that completed — the same contract
    that field keeps on the chat path, so a client can key off existence.

    ``sources`` is spelled the way the backend spells it everywhere else on the
    wire (the socket's ``TurnResult``, the message metadata), so
    the live Report panel and a rehydrated thread read one contract rather than
    two dialects of the same list.
    """
    output: dict[str, Any] = {"report": report}
    if cards:
        output["cards"] = cards
    if sources:
        output["sources"] = sources
    output.update(transparency)
    return output


def extract_answer_transparency(result: Any) -> dict[str, Any]:
    """The marks a finished run left on its own answer, as the fields it set.

    A deep run can SUCCEED and still owe the reader a caveat. It can be cut off
    by the wall clock or by the graph's step limit and have its answer salvaged
    from partial work (``research_truncated`` / ``truncation_reason``); it can
    ship in a known-weaker form — no report file was ever written, or citation
    verification found nothing provably grounded (``degraded_reasons``); and
    citations it did make can have been stripped before anyone saw them
    (``citations_removed``). It can also rate its own answer, in the level and
    the two reasons that make the level actionable (``answer_confidence``).
    The socket path lifts all of that off the agent state onto the terminal
    frame. The job path reduced the entire state to a report string, so every
    one of these markers died inside the research worker and the same answer looked
    *cleaner* delivered as a job than streamed live.

    Read defensively — state object OR dict, every field type-checked on its own
    — because the runner is agent-agnostic by design: an agent whose state
    carries none of this simply contributes nothing here, and one that carries a
    malformed version of it contributes nothing rather than a wrong claim.

    Returns only the fields actually present. Absence is the default and the
    caller copies this dict straight into the job's persisted output, so the
    presence of a key is itself the fact — ``research_truncated`` is written as
    ``true`` or not written at all, never as ``false``, which is the contract it
    already keeps on the chat path.
    """
    return {**_cutoff_marks(result), **_self_assessment(result), **_run_records(result)}


def _state_field(result: Any, name: str) -> Any:
    """A field off a finished run's state, whether the agent returned a state object or a dict."""
    value = getattr(result, name, None)
    if value is None and isinstance(result, dict):
        value = result.get(name)
    return value


def _cutoff_marks(result: Any) -> dict[str, Any]:
    """Whether the run was cut off and why, how it degraded, and the citations it lost."""
    transparency: dict[str, Any] = {}
    # Literal ``True`` only. A truthy stand-in (``1``, ``"yes"``) means the state
    # was written by something that does not share this contract, and telling a
    # reader their research was cut off when nothing recorded a cutoff is a worse
    # failure than telling them nothing.
    if _state_field(result, "research_truncated") is True:
        transparency["research_truncated"] = True

    reason = _state_field(result, "truncation_reason")
    if isinstance(reason, str) and reason.strip():
        # Read independently of the flag rather than nested under it: a state
        # that recorded WHY it stopped but lost the boolean still knows something
        # true, and the caller keys its event off either one being present.
        transparency["truncation_reason"] = reason

    degraded_reasons = _state_field(result, "degraded_reasons")
    if isinstance(degraded_reasons, list):
        tokens = [token for token in degraded_reasons if isinstance(token, str) and token]
        # An empty list is not a claim of "degraded in zero ways" — it is the
        # ordinary case, and it stays out of the output entirely.
        if tokens:
            transparency["degraded_reasons"] = tokens

    citations_removed = _state_field(result, "citations_removed")
    if isinstance(citations_removed, dict) and citations_removed:
        transparency["citations_removed"] = citations_removed
    return transparency


def _self_assessment(result: Any) -> dict[str, Any]:
    """The answer's confidence level and its two reasons, each present only when the run set it."""
    # The answer's own self-assessment, read here so it rides the SAME dict to
    # the same two surfaces instead of growing a second lift with its own bugs.
    # The three travel together on purpose: the chat path has always sent the
    # level with its reason, because "niedrig" alone tells a reader their answer
    # might be wrong and nothing about what to check, and a level whose reason
    # was dropped in transport is the exact complaint that pairing exists to
    # prevent. Deep may not record any of them yet — absent is the ordinary case
    # and writes nothing, so this lands before the field exists and stays correct
    # after it does.
    return {
        name: value
        for name in ANSWER_CONFIDENCE_FIELDS
        if isinstance(value := _state_field(result, name), str) and value.strip()
    }


def _run_records(result: Any) -> dict[str, Any]:
    """The run's own retrieval ledger and the skills its disclosure mutes."""
    transparency: dict[str, Any] = {}
    # Recorded on the deep state and, until this, dropped on the way to the
    # message: the run's own retrieval ledger and the skills the disclosure
    # mutes. Both ride the same dict as the rest, present or absent.
    ledger = _state_field(result, "retrieval_ledger")
    if isinstance(ledger, list) and ledger:
        transparency["retrieval_ledger"] = ledger
    hidden = _state_field(result, "skills_hidden")
    if isinstance(hidden, list):
        names = [name for name in hidden if isinstance(name, str) and name]
        if names:
            transparency["skills_hidden"] = names

    return transparency


def extract_result(result: Any) -> str:
    """Extract string result from various result formats."""
    # Direct string
    if isinstance(result, str):
        return result

    # State with messages
    if hasattr(result, "messages") and result.messages:
        last_msg = result.messages[-1]
        if hasattr(last_msg, "content"):
            return str(last_msg.content)

    # Dict with messages
    if isinstance(result, dict):
        if "messages" in result and result["messages"]:
            last_msg = result["messages"][-1]
            if hasattr(last_msg, "content"):
                return str(last_msg.content)
        if "report" in result:
            return str(result["report"])
        if "output" in result:
            return str(result["output"])

    return str(result) if result else ""
