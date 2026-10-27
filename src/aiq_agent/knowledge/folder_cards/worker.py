"""The folder card builder's loop: claim, hash, skip or build, write, climb (ADR-0127).

Runs in the ingest-worker role (``aiq_api.jobs.ingest_worker``) beside the ingest
queue's claim loop, for the organizations with the ``folder-cards`` WorkOS flag. Each pass:

1. claims up to :data:`CLAIM_LIMIT` folders that went quiet (``queue.claim``:
   deepest first, never a folder while one below it is queued);
2. reads the collection's rows (``document_metadata``) and its stored cards (the BFF);
3. drops the card of a folder that is empty or too small to deserve one;
4. skips a folder whose input hash is the stored card's: nothing it reads changed;
5. over the organization's monthly token budget, marks the stored card ``stale``
   and builds nothing;
6. otherwise updates the card the way ``incremental.plan`` says: ``prune`` (only
   documents left: their key facts go, the abstract stays, no model call),
   ``incremental`` (one observed generation over the old card and the diff), or
   ``full`` (one generation over the whole folder: a new card, a new prompt version
   or description, a diff over half the children, or the tenth increment in a row).
   It validates, ``PUT``s, stores the manifest the next diff starts from, and marks
   the parent only when the abstract came out different: an identical abstract
   stops the climb.

Spend lands twice, by design: on the organization's usage ledger as ingest
activity (``track_llm_costs``, like every summary ingestion writes), and in
``folder_card_usage``, which is what the budget reads. A pass that built anything
writes ``folder-card-fresh`` (the share of claimed folders whose card is fresh
afterwards) on its first generation's trace.

Every card the BFF accepted is also a Qdrant point ``kind = folder`` in its folder's own
scope (``knowledge_layer.qdrant.folders``): written beside the ``PUT``, its status changed
beside a restamp, removed beside a delete. The point is derived; a failure to write it is
logged and never fails the card, and the nightly reconcile does not see it (a rebuild of
the card rewrites it).
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Iterable
from dataclasses import dataclass
from dataclasses import field
from typing import Any
from typing import Literal

from aiq_agent.knowledge.folder_cards import build
from aiq_agent.knowledge.folder_cards import client
from aiq_agent.knowledge.folder_cards import gate
from aiq_agent.knowledge.folder_cards import incremental
from aiq_agent.knowledge.folder_cards import queue
from aiq_agent.knowledge.folder_cards.inputs import PROMPT_VERSION
from aiq_agent.knowledge.folder_cards.inputs import FolderInputs
from aiq_agent.knowledge.folder_cards.inputs import folder_inputs
from aiq_agent.knowledge.folder_cards.inputs import input_hash

logger = logging.getLogger(__name__)

MONTHLY_TOKENS_ENV = "FOLDER_CARDS_MONTHLY_TOKENS"
#: About 400 folder builds of 5k tokens a month, a few dollars on a mid-tier summary model.
DEFAULT_MONTHLY_TOKENS = 2_000_000
CLAIM_LIMIT = 20
POLL_SECONDS = 60
RECONCILE_EVERY_SECONDS = 24 * 3600
SCORE_WRITER = "folder-card-worker"

Outcome = Literal["fresh", "unchanged", "stale", "failed", "skipped"]


@dataclass
class RunReport:
    outcomes: dict[str, int] = field(default_factory=dict)
    #: The first generation's trace, where the pass's score is written.
    trace_id: str | None = None

    def count(self, outcome: Outcome) -> None:
        self.outcomes[outcome] = self.outcomes.get(outcome, 0) + 1

    def fresh_share(self) -> float | None:
        """Fresh cards among the claimed folders that should have one; ``None`` when there were none."""
        fresh = self.outcomes.get("fresh", 0) + self.outcomes.get("unchanged", 0)
        due = fresh + self.outcomes.get("stale", 0) + self.outcomes.get("failed", 0)
        return fresh / due if due else None


@dataclass
class _Collection:
    organization_id: str
    rows: list[Any]
    #: Stored cards by folder path; updated as this pass writes, so a parent reads its child's new abstract.
    cards: dict[str, dict[str, Any]]
    #: Every living folder's description by path, whether it has a card or not.
    descriptions: dict[str, str] = field(default_factory=dict)
    #: Paths of the living folders whose documents live in this collection; ``None`` when the BFF did not say.
    owned: set[str] | None = None


def monthly_token_cap() -> int:
    try:
        return max(0, int(os.environ.get(MONTHLY_TOKENS_ENV, DEFAULT_MONTHLY_TOKENS)))
    except ValueError:
        return DEFAULT_MONTHLY_TOKENS


def summary_llm() -> Any | None:
    """The summary model the active ingestor resolved at registration (pinned to zero data retention)."""
    from aiq_agent.knowledge.factory import get_active_ingestor

    return getattr(get_active_ingestor(), "summary_llm", None)


def collection_rows(collection: str) -> list[Any]:
    """The collection's documents as ``browse.FileRow``: the rows ``list_files`` counts."""
    from knowledge_layer.browse import file_rows

    from aiq_agent.knowledge import get_available_documents

    return file_rows([{**doc.model_dump(), "collection": collection} for doc in get_available_documents(collection)])


def _load(claim: queue.Claim) -> _Collection | None:
    from aiq_agent.knowledge.folder_cards import organization_hint

    organization_id = (
        claim.organization_id or queue.organization_of(claim.collection) or organization_hint(claim.collection)
    )
    if not organization_id:
        logger.warning("folder cards: no organization known for %s; its folders wait", claim.collection)
        return None
    queue.remember_collection(claim.collection, organization_id)
    cards, descriptions, owned = client.read_collection(organization_id, claim.collection)
    return _Collection(organization_id, collection_rows(claim.collection), cards, descriptions, owned)


# ---------------------------------------------------------------------------
# The card's Qdrant point (derived; never fails the card)
# ---------------------------------------------------------------------------


def _publish_point(collection: str, card: dict[str, Any]) -> None:
    """Embed ``card`` with the production embedder and write its point into ``collection``'s scope."""
    try:
        from knowledge_layer.qdrant import folders
        from knowledge_layer.qdrant.store import get_store

        from aiq_agent.knowledge.factory import get_active_retriever

        retriever = get_active_retriever()
        text = folders.embedding_text(card["folder_path"], card.get("abstract"), card.get("key_facts"))
        vector = retriever.embed_query(text)
        folders.upsert_folder_card(get_store(retriever.embedding_identity()), collection, card, vector)
    except Exception:  # noqa: BLE001 — the card is written; its point is derived
        logger.warning("folder cards: no Qdrant point for %s in %s", card.get("folder_path"), collection, exc_info=True)


def _restamp_point(collection: str, folder_path: str, status: str) -> None:
    try:
        from knowledge_layer.qdrant import folders
        from knowledge_layer.qdrant.store import get_store

        folders.set_folder_card_status(get_store(), collection, folder_path, status)
    except Exception:  # noqa: BLE001
        logger.warning("folder cards: could not restamp the point of %s in %s", folder_path, collection, exc_info=True)


def _drop_point(collection: str, folder_path: str) -> None:
    try:
        from knowledge_layer.qdrant import folders
        from knowledge_layer.qdrant.store import get_store

        folders.delete_folder_card(get_store(), collection, folder_path)
    except Exception:  # noqa: BLE001
        logger.warning("folder cards: could not delete the point of %s in %s", folder_path, collection, exc_info=True)


# ---------------------------------------------------------------------------
# Writes through the BFF
# ---------------------------------------------------------------------------


def _mark_parent(claim: queue.Claim, context: _Collection) -> None:
    parent = queue.parent_of(claim.folder_path)
    if parent:
        queue.mark(claim.collection, [parent], context.organization_id, with_ancestors=False)


def _restamp(claim: queue.Claim, context: _Collection, existing: dict[str, Any], status: str) -> None:
    """Keep a stored card's content and change only its status (``stale``, ``failed``)."""
    if existing.get("status") == status:
        return
    body = client.put_request(
        organization_id=context.organization_id,
        collection=claim.collection,
        folder_path=claim.folder_path,
        abstract=existing.get("abstract"),
        key_facts=existing.get("key_facts") or [],
        input_hash=existing["input_hash"],
        abstract_hash=existing.get("abstract_hash"),
        model=existing.get("model"),
        prompt_version=existing.get("prompt_version"),
        status=status,
    )
    if client.put_card(body):
        context.cards[claim.folder_path] = {**existing, "status": status}
        _restamp_point(claim.collection, claim.folder_path, status)


def _drop(claim: queue.Claim, context: _Collection, existing: dict[str, Any] | None) -> Outcome:
    """An empty or tiny folder: its listing is its card, so a stored card goes."""
    if existing is not None:
        client.delete_card(context.organization_id, claim.collection, claim.folder_path)
        _drop_point(claim.collection, claim.folder_path)
        queue.delete_manifest(claim.collection, claim.folder_path)
        context.cards.pop(claim.folder_path, None)
        _mark_parent(claim, context)
    return "skipped"


def _store(
    claim: queue.Claim,
    context: _Collection,
    existing: dict[str, Any] | None,
    digest: str,
    draft: build.FolderCardDraft,
    model: str,
    manifest: incremental.Manifest,
) -> bool:
    """``PUT`` the card; ``False`` when the BFF refused it (no folder of this collection lives at that path)."""
    body = client.put_request(
        organization_id=context.organization_id,
        collection=claim.collection,
        folder_path=claim.folder_path,
        abstract=draft.abstract,
        key_facts=[fact.wire() for fact in draft.key_facts],
        input_hash=digest,
        abstract_hash=draft.abstract_hash,
        model=model,
        prompt_version=PROMPT_VERSION,
        status="fresh",
    )
    if not client.put_card(body):
        logger.info("folder cards: %s in %s is no folder the BFF knows", claim.folder_path, claim.collection)
        return False
    queue.put_manifest(claim.collection, claim.folder_path, manifest.to_json())
    context.cards[claim.folder_path] = {**(existing or {}), **body}
    _publish_point(claim.collection, body)
    if (existing or {}).get("abstract_hash") != draft.abstract_hash:
        _mark_parent(claim, context)
    return True


# ---------------------------------------------------------------------------
# One folder
# ---------------------------------------------------------------------------


def _ledger(organization_id: str):
    """The usage ledger the call is booked to: the organization's, as ingest activity."""
    from aiq_agent.common.cost_tracking import USAGE_ACTIVITY_INGEST
    from aiq_agent.common.cost_tracking import BudgetSnapshot
    from aiq_agent.common.cost_tracking import track_llm_costs

    identity = {"organization_id": organization_id, "user_id": None, "project_id": None, "conversation_id": None}
    return track_llm_costs(identity=identity, budget=BudgetSnapshot(), activity=USAGE_ACTIVITY_INGEST)


def _decide(inputs: FolderInputs, existing: dict[str, Any] | None) -> tuple[Outcome | None, str]:
    """What the folder needs before any model call: ``(outcome, input hash)``; ``None`` means build. Pure."""
    if inputs.empty or inputs.tiny:
        return "skipped", ""
    digest = input_hash(inputs)
    if existing and existing.get("input_hash") == digest and existing.get("status") == "fresh":
        return "unchanged", digest
    return None, digest


def _stored_manifest(claim: queue.Claim) -> incremental.Manifest | None:
    stored = queue.get_manifest(claim.collection, claim.folder_path)
    try:
        return incremental.Manifest.from_json(stored) if stored else None
    except (ValueError, TypeError, AttributeError):  # unreadable: a full rebuild writes a new one
        return None


def _prune(
    claim: queue.Claim,
    context: _Collection,
    existing: dict[str, Any],
    inputs: FolderInputs,
    digest: str,
    update: incremental.Plan,
) -> bool:
    """Only documents left: drop the facts that cited them, keep the abstract. No model call."""
    facts = incremental.surviving_facts(existing.get("key_facts") or [], inputs.child_names)
    abstract = existing["abstract"]
    draft = build.FolderCardDraft(
        abstract,
        tuple(build.KeyFact(f["statement"], tuple(f["documents"]), f.get("pages")) for f in facts),
        existing.get("abstract_hash") or build.abstract_hash(abstract),
    )
    manifest = incremental.manifest_of(inputs, increments=update.increments)
    return _store(claim, context, existing, digest, draft, existing.get("model") or "", manifest)


#: A stem shorter than this ("A", "Nr 1") is too common a word to prove the abstract names the document.
_MIN_NAMED_STEM = 4


def names_removed(abstract: str, removed: Iterable[str]) -> bool:
    """Whether ``abstract`` mentions a removed document by file name or by name without extension. Pure."""
    text = abstract.casefold()
    for name in removed:
        stem = name.rsplit(".", 1)[0] if "." in name else name
        if name.casefold() in text or (len(stem) >= _MIN_NAMED_STEM and stem.casefold() in text):
            return True
    return False


async def _write(
    inputs: FolderInputs, existing: dict[str, Any] | None, update: incremental.Plan, llm: Any
) -> build.Generation:
    """The model call the plan asks for: the whole folder, or the old card and the diff."""
    counts = update.diff.counts()
    if update.mode != "incremental" or existing is None:
        return await build.generate(inputs, llm, mode="full", diff_counts=counts)
    kept = incremental.surviving_facts(existing.get("key_facts") or [], inputs.child_names)
    prompt = build.incremental_prompt(inputs, update.diff, existing["abstract"], kept)
    return await build.generate(inputs, llm, prompt=prompt, mode="incremental", diff_counts=counts)


async def _build(claim: queue.Claim, context: _Collection, llm: Any, report: RunReport) -> Outcome:
    if context.owned is not None and claim.folder_path not in context.owned:
        # Marked here, but its documents live in another collection (a restricted child marks its open ancestors).
        return "skipped"
    inputs = folder_inputs(claim.collection, claim.folder_path, context.rows, context.cards, context.descriptions)
    existing = context.cards.get(inputs.folder_path)
    outcome, digest = _decide(inputs, existing)
    if outcome == "skipped":
        return await asyncio.to_thread(_drop, claim, context, existing)
    if outcome is not None:
        return outcome
    update = incremental.plan(existing, await asyncio.to_thread(_stored_manifest, claim), inputs)
    if update.mode == "prune" and existing is not None and names_removed(existing["abstract"], update.diff.removed):
        # The abstract speaks of a document that is gone: the model rewrites it from the diff.
        update = incremental.Plan("incremental", update.diff, increments=update.increments + 1, reason="named removal")
    if update.mode == "prune" and existing is not None:
        stored = await asyncio.to_thread(_prune, claim, context, existing, inputs, digest, update)
        return "fresh" if stored else "skipped"
    if await asyncio.to_thread(queue.tokens_used, context.organization_id) >= monthly_token_cap():
        logger.info("folder cards: %s is over its monthly budget", context.organization_id)
        if existing is not None:
            await asyncio.to_thread(_restamp, claim, context, existing, "stale")
        return "stale"
    with _ledger(context.organization_id):
        try:
            generation = await _write(inputs, existing, update, llm)
        except build.GenerationRejected as rejected:
            await asyncio.to_thread(queue.add_tokens, context.organization_id, rejected.tokens)
            raise
    report.trace_id = report.trace_id or generation.trace_id
    await asyncio.to_thread(queue.add_tokens, context.organization_id, generation.tokens)
    draft = build.validate(generation.reply, inputs)
    manifest = incremental.manifest_of(inputs, increments=update.increments)
    stored = await asyncio.to_thread(_store, claim, context, existing, digest, draft, generation.model, manifest)
    return "fresh" if stored else "skipped"


def _give_up(claim: queue.Claim, context: _Collection | None) -> None:
    existing = context.cards.get(claim.folder_path) if context else None
    if context is not None and existing is not None:
        _restamp(claim, context, existing, "failed")


def _flag_off(claim: queue.Claim) -> bool:
    """Whether the claimed folder's organization lacks the ``folder-cards`` flag. Raises when the BFF cannot be asked.

    An organization nobody can name yet is not off: ``_load`` keeps the claim for a retry.
    """
    from aiq_agent.knowledge.folder_cards import gate
    from aiq_agent.knowledge.folder_cards import organization_hint

    organization_id = (
        claim.organization_id or queue.organization_of(claim.collection) or organization_hint(claim.collection)
    )
    return organization_id is not None and not gate.check(organization_id)


async def _settle(claim: queue.Claim, loaded: dict[str, _Collection | None], llm: Any, report: RunReport) -> Outcome:
    """Build one claimed folder and settle its queue row. Never raises."""
    try:
        if await asyncio.to_thread(_flag_off, claim):
            # Switched off for the organization: nothing is built, and the row goes. Switching it on
            # again is found by the nightly reconcile, which marks what lacks a card.
            await asyncio.to_thread(queue.finish, claim)
            return "skipped"
        if claim.collection not in loaded:
            loaded[claim.collection] = await asyncio.to_thread(_load, claim)
        context = loaded[claim.collection]
        if context is None:
            # Kept for a few retries: a later mark from an ingest may name the organization.
            await asyncio.to_thread(queue.fail, claim)
            return "skipped"
        outcome = await _build(claim, context, llm, report)
    except Exception:  # noqa: BLE001 — one folder never stops the pass
        logger.warning("folder cards: %s in %s failed", claim.folder_path, claim.collection, exc_info=True)
        try:
            if await asyncio.to_thread(queue.fail, claim):
                await asyncio.to_thread(_give_up, claim, loaded.get(claim.collection))
        except Exception:  # noqa: BLE001
            logger.warning("folder cards: could not settle a failed claim", exc_info=True)
        return "failed"
    await asyncio.to_thread(queue.finish, claim)
    return outcome


def _emit_freshness(report: RunReport) -> None:
    share = report.fresh_share()
    if share is None or not report.trace_id:
        return
    from aiq_agent.observability.langfuse_scores import RuntimeScore
    from aiq_agent.observability.langfuse_scores import emit_scores

    comment = ", ".join(f"{name} {count}" for name, count in sorted(report.outcomes.items()))
    emit_scores(
        [RuntimeScore("folder-card-fresh", share, comment=comment)], writer=SCORE_WRITER, trace_id=report.trace_id
    )


async def run_once(limit: int = CLAIM_LIMIT, *, llm: Any | None = None) -> RunReport:
    """One pass over the folders that are due. Never raises for one folder."""
    report = RunReport()
    llm = llm if llm is not None else summary_llm()
    if llm is None:
        logger.info("folder cards: no summary model is configured; nothing is built")
        return report
    loaded: dict[str, _Collection | None] = {}
    for claim in await asyncio.to_thread(queue.claim, limit):
        report.count(await _settle(claim, loaded, llm, report))
    if report.outcomes:
        logger.info("folder cards: %s", report.outcomes)
    _emit_freshness(report)
    return report


# ---------------------------------------------------------------------------
# The nightly reconcile and the loop
# ---------------------------------------------------------------------------


def _folders(rows: list[Any]) -> set[str]:
    return {path for row in rows for path in queue.ancestors(row.folder)}


def reconcile_collection(collection: str, organization_id: str) -> int:
    """Mark every folder whose stored card no longer matches its inputs, or that lacks one it deserves."""
    rows = collection_rows(collection)
    cards, descriptions, owned = client.read_collection(organization_id, collection)
    due: list[str] = []
    for path in sorted(_folders(rows) | set(cards)):
        if owned is not None and path not in owned:
            continue
        existing = cards.get(path)
        outcome, _digest = _decide(folder_inputs(collection, path, rows, cards, descriptions), existing)
        if outcome == "skipped":
            if existing is not None:
                due.append(path)
        elif outcome is None:
            due.append(path)
    queue.mark(collection, due, organization_id, with_ancestors=False)
    queue.set_reconciled(collection)
    return len(due)


async def reconcile() -> int:
    """Recompute the input hash of every known collection's folders; how many were marked."""
    marked = 0
    for collection, organization_id in await asyncio.to_thread(
        queue.collections_due_for_reconcile, RECONCILE_EVERY_SECONDS
    ):
        try:
            if not await asyncio.to_thread(gate.check, organization_id):
                continue
            marked += await asyncio.to_thread(reconcile_collection, collection, organization_id)
        except Exception:  # noqa: BLE001 — the next night tries again
            logger.warning("folder cards: could not reconcile %s", collection, exc_info=True)
    return marked


async def loop(stop: asyncio.Event) -> None:
    """Build until ``stop``: a pass every :data:`POLL_SECONDS`, a reconcile once a day."""
    last_reconcile = float("-inf")
    while not stop.is_set():
        try:
            await run_once()
            if time.monotonic() - last_reconcile >= RECONCILE_EVERY_SECONDS:
                last_reconcile = time.monotonic()
                await reconcile()
        except Exception:  # noqa: BLE001 — the loop outlives a bad pass
            logger.warning("folder cards: a pass failed", exc_info=True)
        try:
            await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
        except TimeoutError:
            pass
