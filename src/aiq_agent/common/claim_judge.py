"""Whether each sentence of an answer says what its evidence says: one model call per answer (ADR-0139).

Four rounds of German word lists (verdict words, modals, next-step openers,
key-word overlap) moved errors from one direction to the other: a next step
read as a verdict floored a listing, a verdict read as a next step lifted an
answer, and a word overlap could not see „unzulässig" beside „zulässig". What
those lists approximated is one question a small model answers directly: does
the passage, the record or the measurement this sentence points at state what
the sentence states, and is the sentence a conclusion about the law, a fact,
the answer's own assessment, or a next step?

What the sentence points at stays deterministic (``claim_provenance``,
``citation_verification``, ``workspace_records``): the model only reads the
evidence it is handed, never its own knowledge, so it cannot find support the
turn did not retrieve. All sentences of an answer go in ONE structured-output
call on the organisation's smallest configured model, after the answer has
streamed, bounded by :data:`JUDGE_TIMEOUT_S`. Any failure returns ``None``:
the caller marks the stamps ``unavailable`` and the level falls back to
medium.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable
from collections.abc import Callable
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import ValidationError

logger = logging.getLogger(__name__)

Support = Literal["supported", "contradicted", "not_addressed"]
Kind = Literal["verdict", "fact", "assessment", "next_step"]

#: The judge runs before the turn's terminal frame, after the prose has
#: streamed: the reader waits for the chip, not for the answer. Under the
#: follow-ups model's own request timeout, so a slow provider is a recorded
#: fallback rather than a hung turn.
JUDGE_TIMEOUT_S = 12.0
#: The most sentences one call judges; the rest are ``unavailable``. A long
#: answer is a few dozen sentences.
MAX_ITEMS = 48
#: The most evidence characters one sentence is judged against.
MAX_EVIDENCE_CHARS = 2000
#: Room for one short object per item.
MAX_OUTPUT_TOKENS = 2048


@dataclass(frozen=True)
class Judgement:
    """What the judge found for one sentence."""

    support: Support
    kind: Kind


class _Item(BaseModel):
    index: int
    support: Support
    kind: Kind


class JudgeReply(BaseModel):
    """The structured output: one item per sentence, by index."""

    items: list[_Item]


#: Judges a list of ``(sentence, evidence)`` pairs; ``None`` when it could not.
JudgeFn = Callable[[Sequence[tuple[str, str]]], Awaitable[Sequence[Judgement | None] | None]]

SYSTEM_PROMPT = (
    "You check the sentences of an answer an architect's assistant wrote, one by one, against the evidence "
    "each sentence points at: a passage of a regulation or a document, a workspace record, or a measurement. "
    "The sentences and the evidence are usually German.\n\n"
    "For each item decide two things.\n"
    "support:\n"
    "- supported: the evidence states what the sentence states. A paraphrase is fine; the numbers, the "
    "polarity (allowed or not allowed, required or not required) and the scope must be the same.\n"
    "- contradicted: the evidence states the opposite, another value, or a narrower or wider scope.\n"
    "- not_addressed: the evidence is empty, or it does not say this.\n"
    "Judge only against the evidence given. Never use your own knowledge of the law or the project: a true "
    "sentence the evidence does not state is not_addressed.\n"
    "kind:\n"
    "- verdict: the sentence states what a law, regulation or standard requires, allows or forbids, or whether "
    "something complies with it, hedged or not.\n"
    "- fact: any other assertion about the project, its documents, the building, a value, or what a document "
    "contains.\n"
    "- assessment: the answer's own inference about the documents or the project, marked as such "
    "(probably, apparently, seems), concluding nothing about the law.\n"
    "- next_step: a next step, an open question, an offer, a request to the reader, or the answer's account of "
    "what it did or did not read.\n\n"
    'Reply with JSON only: {"items": [{"index": 0, "support": "supported", "kind": "fact"}, ...]}, one item per '
    "input item, every index once."
)


def build_messages(items: Sequence[tuple[str, str]]) -> list[Any]:
    """The system prompt and the items as JSON, each evidence text bounded."""
    from langchain_core.messages import HumanMessage
    from langchain_core.messages import SystemMessage

    payload = [
        {"index": index, "sentence": sentence, "evidence": evidence[:MAX_EVIDENCE_CHARS]}
        for index, (sentence, evidence) in enumerate(items)
    ]
    return [
        SystemMessage(content=SYSTEM_PROMPT),
        HumanMessage(content=json.dumps({"items": payload}, ensure_ascii=False)),
    ]


def parse_reply(text: str, count: int) -> list[Judgement | None] | None:
    """The judgements by input index; ``None`` when the reply is no such object at all."""
    from aiq_agent.common.json_utils import extract_json

    try:
        reply = JudgeReply.model_validate(extract_json(text))
    except (ValidationError, TypeError, ValueError):
        return None
    judged: list[Judgement | None] = [None] * count
    for item in reply.items:
        if 0 <= item.index < count:
            judged[item.index] = Judgement(item.support, item.kind)
    return judged


def llm_judge(llm: Any) -> JudgeFn:
    """A :data:`JudgeFn` on a LangChain chat model: one structured-output call, bounded, never raising."""

    async def judge(items: Sequence[tuple[str, str]]) -> Sequence[Judgement | None] | None:
        from aiq_agent.memory.reflection import structured_reply

        if not items:
            return []
        bounded = list(items[:MAX_ITEMS])
        try:
            model = llm.bind(max_tokens=MAX_OUTPUT_TOKENS)
            text = await asyncio.wait_for(
                structured_reply(model, build_messages(bounded), JudgeReply), timeout=JUDGE_TIMEOUT_S
            )
        except Exception as exc:  # noqa: BLE001 - every failure is the same answer: unjudged, medium
            logger.warning("Claim judge failed (%s); the confidence falls back to medium", exc)
            return None
        judged = parse_reply(text, len(bounded))
        if judged is None:
            logger.warning("Claim judge answered unparseably; the confidence falls back to medium")
            return None
        return judged + [None] * (len(items) - len(bounded))

    return judge
