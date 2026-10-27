"""Platform lessons — the injected digest of user-reported failure patterns.

The product's own correction ratchet (docs/contributing/correction-ratchet.md
applied to the product itself: "human intervention is a failure signal"). The
BFF distills down-votes into anonymized, deduplicated lessons
(docs/architecture/platform-failure-learning.md); this module resolves the
bounded digest of ACTIVE lessons through the same token-guarded internal
channel as the retrieval settings (``GET /api/internal/platform-lessons/digest``),
TTL-cached and fail-open.

Platform-wide by design — no org layer and no per-request header: a lesson is
anonymized fleet knowledge, identical for every tenant. Fail-open by design: a
BFF outage must never take answering down, so every error path returns None
and the prompt simply renders no lessons block.

The turn also reports WHICH arm of the holdout it was in and which lessons it
carried (:class:`LessonsResolution`), so the experiment is analysable from the
trace alone: ``turn/context.py`` records ``lessons_arm`` and ``lesson_ids`` on
the trace metadata (docs/observability/langfuse.md), which Langfuse's PostHog
export carries onto every ``langfuse observation`` event.
"""

import hashlib
import logging
import os
import re
import threading
import time
from dataclasses import dataclass
from typing import Literal

logger = logging.getLogger(__name__)

# In-process cache TTLs, same rationale as retrieval_settings: a curation
# change reaches the fleet within a minute; failures are retried sooner so a
# BFF blip does not suppress the lessons for long.
_POSITIVE_TTL_SECONDS = 60.0
_NEGATIVE_TTL_SECONDS = 30.0
_REQUEST_TIMEOUT_SECONDS = 3.0

# Hard ceiling on what this module will inject, whatever the BFF sent. The BFF
# bounds the digest to 1600 chars (lib/platform-lessons/service.ts); this is
# the read-side seatbelt, not the budget.
_MAX_DIGEST_CHARS = 2400

_EXPECTED_HEADER = "PLATFORM_LESSONS"

# Lesson ids are uuids (platform_lessons.id). More than the BFF's active-lesson
# cap (20) is not a digest this module produced, and the ids ride a trace
# attribute, so they are bounded and shape-checked like the digest.
_LESSON_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_MAX_LESSON_IDS = 20

#: Which side of the lessons experiment a turn was on, as the trace records it.
#: ``treated``: the holdout is measuring and this conversation got the digest;
#: ``holdout``: it is measuring and this conversation is the control that got
#: none; ``off``: no experiment ran for this turn (``lessons.holdout_pct`` is 0,
#: there is no conversation to key on, or the setting could not be read). The
#: same three states the BFF stamps on a vote (``answer_feedback.lessons_holdout``:
#: true, false, NULL), so a vote and its trace carry the same label.
LessonsArm = Literal["treated", "holdout", "off"]


@dataclass(frozen=True)
class LessonsResolution:
    """What one turn's lessons lookup decided: the digest, the arm, the lessons in it."""

    #: The bounded digest to inject, or None (holdout, none active, or fail-open).
    digest: str | None
    arm: LessonsArm
    #: The ids of the lessons whose text is in ``digest`` (empty without one).
    lesson_ids: tuple[str, ...] = ()


class _CacheEntry:
    __slots__ = ("digest", "expires_at", "lesson_ids")

    def __init__(self, digest: str | None, ttl: float, lesson_ids: tuple[str, ...] = ()) -> None:
        self.digest = digest
        self.lesson_ids = lesson_ids
        self.expires_at = time.monotonic() + ttl


_cache: _CacheEntry | None = None
_cache_lock = threading.Lock()


def reset_platform_lessons_cache() -> None:
    """Test hook: clear the in-process resolution cache."""
    global _cache
    with _cache_lock:
        _cache = None


def sanitize_lessons_digest(value: object) -> str | None:
    """Reduce an untrusted payload to a bounded, well-formed digest or None."""
    if not isinstance(value, str):
        return None
    digest = value.strip()
    if not digest or not digest.startswith(_EXPECTED_HEADER):
        return None
    if len(digest) > _MAX_DIGEST_CHARS:
        digest = digest[:_MAX_DIGEST_CHARS]
    return digest


def sanitize_lesson_ids(value: object) -> tuple[str, ...]:
    """Reduce an untrusted payload to a bounded, de-duplicated tuple of uuid strings."""
    if not isinstance(value, list):
        return ()
    ids: list[str] = []
    for item in value:
        if not isinstance(item, str):
            continue
        candidate = item.strip().lower()
        if _LESSON_ID.fullmatch(candidate) and candidate not in ids:
            ids.append(candidate)
        if len(ids) >= _MAX_LESSON_IDS:
            break
    return tuple(ids)


def _fetch_digest() -> tuple[str | None, tuple[str, ...]]:
    """One HTTP round-trip to the BFF's internal platform-lessons endpoint: the digest and its lesson ids."""
    token = os.environ.get("INTERNAL_API_TOKEN")
    if not token:
        # No internal-token trust channel — no lessons, and no error.
        return None, ()

    import httpx

    base_url = (os.environ.get("FRONTEND_INTERNAL_URL") or "http://frontend:3000").rstrip("/")
    response = httpx.get(
        f"{base_url}/api/internal/platform-lessons/digest",
        headers={"x-grid-internal-token": token},
        timeout=_REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    if not isinstance(payload, dict):
        return None, ()
    digest = sanitize_lessons_digest(payload.get("digest"))
    # The ids describe the digest; without one they describe nothing.
    return digest, sanitize_lesson_ids(payload.get("lessonIds")) if digest else ()


def is_in_holdout_slice(conversation_id: str, holdout_pct: int) -> bool:
    """Whether this conversation is in the lessons control group.

    The Python twin of ``isInHoldoutSlice`` in
    ``frontends/ui/src/lib/platform-lessons/holdout.ts``: sha256 of the
    conversation id, first four bytes, modulo 100. Both tiers must reach the
    same verdict from the same key with no shared state — this tier decides
    whether to INJECT, the BFF decides how to LABEL the resulting vote, and a
    disagreement would silently mislabel every measurement.

    Keyed on the conversation so a thread stays in one arm: a user must not get
    a lesson-shaped answer and a lesson-free one to the same follow-up.
    """
    if holdout_pct <= 0 or not conversation_id:
        return False
    if holdout_pct >= 100:
        return True
    digest = hashlib.sha256(conversation_id.encode("utf-8")).digest()
    return int.from_bytes(digest[:4], "big") % 100 < holdout_pct


def _holdout_arm(conversation_id: str | None) -> LessonsArm:
    """The arm this conversation is in. Fail-open: anything unreadable is ``off``, never a block.

    ``off`` for an unreadable setting still INJECTS (the caller treats the turn
    as treated), but it does not claim a place in the experiment, so the
    comparison excludes it instead of counting it as treated, as the BFF does
    for a vote with a NULL ``lessons_holdout``.
    """
    if not conversation_id:
        return "off"
    try:
        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        holdout_pct = get_retrieval_setting("lessons.holdout_pct", 0)
        if holdout_pct <= 0:
            return "off"
        return "holdout" if is_in_holdout_slice(conversation_id, holdout_pct) else "treated"
    except Exception:  # noqa: BLE001 - fail open: measurement never blocks answering
        logger.debug("Holdout resolution failed; treating this turn as treated", exc_info=True)
        return "off"


def resolve_platform_lessons(conversation_id: str | None = None) -> LessonsResolution:
    """The turn's lessons: digest to inject, holdout arm, and the ids of the lessons in the digest.

    A conversation in the holdout slice gets no digest at all — the control
    group, so the two down-vote rates can be compared (``lessons.holdout_pct``,
    default 0 = measurement off) — and costs no fetch.

    Never raises. Called once per turn (``turn/context.py``); the TTL cache keeps
    the per-turn cost at zero between refreshes. Blocking I/O — call it via
    ``asyncio.to_thread`` from async code, like ``fetch_memory_digest``.
    """
    arm = _holdout_arm(conversation_id)
    if arm == "holdout":
        return LessonsResolution(digest=None, arm=arm)
    global _cache
    now = time.monotonic()
    with _cache_lock:
        if _cache is not None and _cache.expires_at > now:
            return LessonsResolution(digest=_cache.digest, arm=arm, lesson_ids=_cache.lesson_ids)

    try:
        digest, lesson_ids = _fetch_digest()
        ttl = _POSITIVE_TTL_SECONDS if digest else _NEGATIVE_TTL_SECONDS
    except Exception as exc:  # noqa: BLE001 - fail open by design
        logger.warning("Platform-lessons resolution failed: %s", type(exc).__name__)
        digest, lesson_ids, ttl = None, (), _NEGATIVE_TTL_SECONDS

    with _cache_lock:
        _cache = _CacheEntry(digest, ttl, lesson_ids)
    return LessonsResolution(digest=digest, arm=arm, lesson_ids=lesson_ids)


def get_platform_lessons_digest(conversation_id: str | None = None) -> str | None:
    """The active-lessons digest, or None when there is none to inject.

    The digest half of :func:`resolve_platform_lessons`, for callers that only
    inject it. None for a conversation in the holdout slice.
    """
    return resolve_platform_lessons(conversation_id).digest


#: The framing that travels WITH the lessons, rendered once here rather than
#: copied into each agent's template.
#:
#: The wording is load-bearing and was the subject of an explicit review: a
#: lesson is a META process caution with zero factual authority, most turns it
#: does not apply, and everything else the agent has — retrieval, documents,
#: the project profile, the live conversation — outranks it. Two prompts
#: carrying two versions of that caveat is how one of them quietly becomes
#: "helpful background knowledge", which is exactly the failure the meta-only
#: rule exists to prevent.
_LESSONS_BLOCK_HEADER = (
    "### PLATFORM_LESSONS — process cautions from reported failures. Meta-level only.\n"
    "A `PLATFORM_LESSONS v1` block follows. Each line is a caution distilled from answers users "
    "reported as bad — anonymized, deduplicated, tagged `[category | Nx]` (N = how often reported).\n"
    "\n"
    "These are **meta-level process cautions, not knowledge, and most turns they simply do not "
    "apply**. A lesson may adjust HOW you work — what to double-check, when to retrieve deeper, "
    "when to ask — and never WHAT is true. They carry zero factual authority: never cite one, "
    "never treat one as evidence about any norm, document or project, and never let one override "
    "retrieval, uploaded documents, the project profile or the current conversation — every one of "
    "those outranks every lesson. Do not mention lessons in answers or go looking for ways to apply "
    "them; act on one only when its failure pattern exactly matches the turn in front of you, and "
    "otherwise ignore this block entirely.\n"
)


def render_lessons_block(digest: str | None) -> str | None:
    """The full prompt section for ``digest``, or None when there is nothing.

    Returning None rather than an empty string is what lets every template
    guard it with a plain truthiness test and render no heading at all.
    """
    if not digest or not digest.strip():
        return None
    return f"{_LESSONS_BLOCK_HEADER}\n{digest.strip()}\n"
