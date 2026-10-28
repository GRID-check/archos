"""A question asked in an Anmerkung's thread is answered in that thread.

A turn asked from a thread (a person writing @Piloti there, answering Piloti's
question, or delegating the mark to Piloti, ADR-0106) carries
``reply_in_thread`` and the mark's id in ``focus_region.annotation_id``
(:func:`aiq_agent.turn.payload.thread_reply_requested`). The prompt asks the
model to answer with ``canvas__reply``. Nothing guarantees that it does, and a
thread that asked Piloti and got nothing back reads as Piloti ignoring the
person, while the answer sits in a chat nobody opened.

So the turn keeps a record, :class:`ThreadReply`, and the chat socket posts the
turn's answer into the thread when the model did not (:func:`post_fallback_reply`).

**Per-turn state in the ContextVar pattern** (``src/aiq_agent/AGENTS.md``): the
chat socket builds one record per turn (:meth:`ThreadReply.requested_by`), binds
it before the workflow runs (:func:`bind_thread_reply`), and the canvas tools,
which run in copies of that context, mark the one object
(:func:`note_thread_post`). Nothing is module-level, so a turn never inherits
the last one's reply.

**Four conditions, all of them, or nothing is posted:**

- the turn ended ``answered`` (never stopped, refused, handed off or failed),
  with text left once citation and card markers are gone;
- nothing Piloti did this turn already spoke in that thread: a ``reply``, an
  ``update`` whose note went into it, or a ``delete`` that took the thread away;
- the conversation may write where everyone who opens the document reads
  (``tools/canvas/policy.shared_write_refusal``). That verdict reads the turn's
  restricted-use state, which lives in the workflow's own context and is gone
  by the time the socket sees the terminal, so it is read there, at the turn's
  end, by :func:`settle_thread_reply` (the canvas's end-of-turn hook,
  ``tools/canvas/presence.leave_canvas``, calls it). A record nobody settled is
  a refusal: this fails closed;
- the record names a mark by id.

**Echo, never sign.** The reply goes to the same route and op ``canvas__reply``
uses (``POST /api/internal/document-annotations``, op ``reply``), with the
turn's signed envelope forwarded unchanged and the answer's id as
``answerMessageId``, so the BFF acts as the person who asked, exactly as it
does for the tool (``src/aiq_agent/tools/AGENTS.md``).
"""

from __future__ import annotations

import asyncio
import contextvars
import logging
import re
from dataclasses import dataclass
from dataclasses import field
from typing import Any

from aiq_agent.common.bff_http import SignedEnvelope
from aiq_agent.common.wire_v2 import RunFinishedBody
from aiq_agent.common.wire_v2 import UserMessage
from aiq_agent.observability.langfuse_scores import emit_scores
from aiq_agent.observability.langfuse_scores import thread_reply_scores
from aiq_agent.observability.langfuse_trace_attributes import record_trace_metadata
from aiq_agent.tools.canvas.client import CanvasRequestError
from aiq_agent.tools.canvas.client import post_canvas
from aiq_agent.tools.canvas.marks import MAX_BODY
from aiq_agent.tools.canvas.policy import shared_write_refusal
from aiq_agent.tools.canvas.target import is_uuid
from aiq_agent.turn.payload import thread_reply_requested

logger = logging.getLogger(__name__)

#: The trace metadata key a thread turn carries (``docs/observability/langfuse.md``):
#: ``replied`` when the model answered in the thread itself, ``skipped`` when it
#: did not, ``skipped_withheld`` when it did not and the turn may not post there.
THREAD_REPLY_METADATA_KEY = "thread_reply"

#: The longest reply the BFF takes: ``MAX_ANNOTATION_BODY`` in
#: ``apps/workspace/bff/annotations/types.ts``, as ``canvas__reply`` enforces it.
MAX_REPLY_CHARS = MAX_BODY


@dataclass
class ThreadReply:
    """One turn's thread question: which mark, on which document, and what the turn did about it."""

    annotation_id: str
    #: The document the question was asked on (``focus_document_id``), or None for the conversation's subject.
    document_id: str | None = None
    #: Ids of the marks Piloti spoke in this turn (lower case): replied, noted a change, or deleted.
    posted: set[str] = field(default_factory=set)
    #: Whether the turn's own context said if a shared write may go out (:func:`settle_thread_reply`).
    settled: bool = False
    #: That context's refusal, when it said no.
    refusal: str | None = None

    @classmethod
    def requested_by(cls, message: UserMessage) -> ThreadReply | None:
        """The record for a turn that asks for its answer in a thread, or None for every other turn. Pure."""
        if not thread_reply_requested(message):
            return None
        region = message.focus_region
        assert region is not None and region.annotation_id  # thread_reply_requested says so
        return cls(annotation_id=region.annotation_id, document_id=message.focus_document_id or None)

    @property
    def answered(self) -> bool:
        """Whether Piloti already spoke in the asked mark's thread this turn."""
        return self.annotation_id.strip().lower() in self.posted


_thread_reply: contextvars.ContextVar[ThreadReply | None] = contextvars.ContextVar("grid_thread_reply", default=None)


def bind_thread_reply(record: ThreadReply | None) -> contextvars.Token:
    """Bind ``record`` (None included, so a turn never runs on the last one's) for the workflow about to run."""
    return _thread_reply.set(record)


def reset_thread_reply(token: contextvars.Token) -> None:
    _thread_reply.reset(token)


def current_thread_reply() -> ThreadReply | None:
    return _thread_reply.get()


def note_thread_post(annotation_id: str | None) -> None:
    """A canvas tool spoke in (or removed) the thread of ``annotation_id``. Nothing outside a thread turn."""
    record = _thread_reply.get()
    if record is not None and annotation_id:
        record.posted.add(annotation_id.strip().lower())


def settle_thread_reply() -> None:
    """Record, in the turn's own context, whether the answer may go where everyone reads. Never raises.

    Called at the end of the turn's workflow, where the restricted-use state the
    policy reads is still bound, and inside its trace: whether the model
    answered in the thread itself goes on the trace (:data:`THREAD_REPLY_METADATA_KEY`)
    and as the ``thread-answered-in-place`` score (``replied`` true, ``skipped``
    false, ``skipped_withheld`` none: that turn could not have posted),
    because a fallback that hides how often the prompt is ignored would remove
    the signal pointing at the cause. A failure to read the verdict is a refusal.
    """
    record = _thread_reply.get()
    if record is None:
        return
    try:
        record.refusal = shared_write_refusal()
    except Exception:  # noqa: BLE001 - a verdict that cannot be read is a no
        logger.warning("The thread reply's shared-write verdict could not be read", exc_info=True)
        record.refusal = "unreadable"
    record.settled = True
    verdict = "replied" if record.answered else "skipped" if record.refusal is None else "skipped_withheld"
    record_trace_metadata(**{THREAD_REPLY_METADATA_KEY: verdict})
    emit_scores(thread_reply_scores(verdict), writer="thread-reply")


_CARD_REF = re.compile(r"\[\[(?:card:\d+|callout)\]\]")
_CITATION = re.compile(r"[ \t]*\[\^?\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]")
_SPACE_BEFORE_PUNCTUATION = re.compile(r"[ \t]+([.,;:!?])")
_BLANK_LINES = re.compile(r"\n{3,}")


def thread_text(text: str) -> str:
    """The answer as a thread reply: no citation or card markers, at most :data:`MAX_REPLY_CHARS`. Pure.

    A thread is read without the chat's source list, so ``[1]`` would point at
    nothing; the reply tool's description asks the model for the same.
    """
    cleaned = _CITATION.sub("", _CARD_REF.sub("", text or ""))
    cleaned = _SPACE_BEFORE_PUNCTUATION.sub(r"\1", cleaned)
    lines = [line.rstrip() for line in cleaned.replace("\r\n", "\n").split("\n")]
    cleaned = _BLANK_LINES.sub("\n\n", "\n".join(lines)).strip()
    if len(cleaned) <= MAX_REPLY_CHARS:
        return cleaned
    return cleaned[: MAX_REPLY_CHARS - 1].rstrip() + "…"


def fallback_reply_request(
    record: ThreadReply | None, finished: RunFinishedBody, *, answer_message_id: str
) -> dict[str, Any] | None:
    """The ``reply`` body the thread is owed, or None when nothing is to be posted. Pure."""
    if record is None or finished.outcome != "answered" or record.answered:
        return None
    if not record.settled or record.refusal is not None:
        return None
    if not is_uuid(record.annotation_id):
        return None
    body = thread_text(finished.result.text)
    if not body:
        return None
    request: dict[str, Any] = {
        "op": "reply",
        "annotationId": record.annotation_id.strip(),
        "body": body,
        "answerMessageId": answer_message_id,
    }
    if record.document_id and is_uuid(record.document_id):
        request["documentId"] = record.document_id.strip()
    return request


async def post_fallback_reply(
    record: ThreadReply | None,
    finished: RunFinishedBody,
    *,
    answer_message_id: str,
    envelope: SignedEnvelope | None,
) -> bool:
    """Post the turn's answer into the asked thread when the model did not. Whether it went out. Never raises."""
    request = fallback_reply_request(record, finished, answer_message_id=answer_message_id)
    if request is None:
        if record is not None and finished.outcome == "answered" and not record.answered:
            logger.info(
                "Thread question on %s left unanswered in the thread (settled=%s, refused=%s)",
                record.annotation_id,
                record.settled,
                record.refusal is not None,
            )
        return False
    if envelope is None:
        logger.warning("Cannot answer the thread of %s: the turn has no signed envelope", request["annotationId"])
        return False
    try:
        await asyncio.to_thread(post_canvas, request, envelope)
    except CanvasRequestError as exc:
        logger.warning("Answering the thread of %s failed (%s): %s", request["annotationId"], exc.status, exc)
        return False
    except Exception:  # noqa: BLE001 - the answer is out and persisted; the thread is best effort
        logger.warning("Answering the thread of %s failed", request["annotationId"], exc_info=True)
        return False
    logger.info("Posted the turn's answer into the thread of %s: the model had not", request["annotationId"])
    return True
