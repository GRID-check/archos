"""One ranked `knowledge_search` call, stage by stage.

Fan out over every collection in scope (with the HyDE probe beside it), fuse,
narrow, rerank beside the retrieval-loop judge, widen once when the judge asks,
cap to the answer budget, apply the relevance floor, put a family overview in
front, record the picking, and render the block the model reads.
"""

import asyncio
import logging
from typing import Any

from knowledge_layer import family_branch
from knowledge_layer import fusion
from knowledge_layer import hit_metadata
from knowledge_layer import hyde
from knowledge_layer import revisions
from knowledge_layer import search_results
from knowledge_layer import search_scope
from knowledge_layer import search_span

from .chunk_noise import noise_notice
from .document_groups import GROUP_OVERFETCH
from .document_groups import group_by_document
from .document_groups import render_document_groups

logger = logging.getLogger(__name__)

# Retrieval over-fetch factor applied when the caller narrows results with the
# agentic filters (doc_class / title_contains / file_name): post-merge
# filtering drops candidates, so each layer fetches 3x top_k to leave enough
# survivors. Only the filters that cannot run inside the search do
# (``qdrant.prefilter.post_filtered``).
AGENT_FILTER_OVERFETCH = 3


class RankedSearch:
    """The state of one ranked search: its scope, its budgets, and what each stage left out."""

    def __init__(self, engine: Any, outcome: Any, args: Any, targets: list, base_collection: str, budgets: tuple):
        from .qdrant import prefilter as qdrant_prefilter

        self.engine = engine
        self.outcome = outcome
        self.args = args
        self.targets = targets
        self.base_collection = base_collection
        self.top_k, self.max_per_document = budgets
        # Over-fetch when agentic filters will drop candidates post-merge. On
        # Qdrant, `doc_class`, `folder` and the superseded exclusion run INSIDE
        # the search (`qdrant/prefilter.py`), so only the filters left after it do.
        self.pushdown = qdrant_prefilter.plan(
            doc_class=args.doc_class,
            folder=args.folder,
            file_name=args.file_name,
            document_type=args.document_type,
            refers_to=args.refers_to,
        )
        self.candidate_k = self._candidate_k(
            qdrant_prefilter.post_filtered(title_contains=args.title_contains, file_name=args.file_name)
        )
        self.family_key = None
        self.family_task = None
        self.folder_task = None
        self.requery_skipped_reason: str | None = None
        self.requery_queries: list[str] = []
        self.requery_fired = False
        self.noise_left_out: frozenset[str] = frozenset()
        self.dropped_by_cap = 0
        self.dropped_by_floor = 0
        self.dropped_by_family = 0

    def _candidate_k(self, narrowed: bool) -> int:
        candidate_k = self.top_k * AGENT_FILTER_OVERFETCH if narrowed else self.top_k
        if self.engine.reranks:
            candidate_k = max(candidate_k, self.engine.config.rerank_candidates)
        if self.engine.drop_noise:
            # Debris leaves the pool before the trim to top_k; without headroom its slots stay empty.
            candidate_k = max(candidate_k, self.top_k * AGENT_FILTER_OVERFETCH)
        if self.args.grouping:
            candidate_k = max(candidate_k, self.top_k * GROUP_OVERFETCH)
        return candidate_k

    @property
    def query(self) -> str:
        return self.args.query

    @property
    def dropped_as_noise(self) -> int:
        return len(self.noise_left_out)

    @property
    def user_collections(self) -> list[str]:
        return [entry.collection for entry in self.targets if entry.collection != self.base_collection]

    async def answer(self) -> str:
        """The block for this search; a failure is a sentence the model can act on, never a raise."""
        await self._prepare()
        try:
            return await self._ranked()
        except Exception as e:
            from aiq_agent.common.tool_calls import FETCH_FAILED_MARKER

            logger.error(f"Knowledge search failed: {e}")
            self.outcome.failed = True
            # The marker is load-bearing, not decoration: the agent's
            # duplicate-fetch guard reads it to tell a failed call from a
            # fetched one, so the retry this sentence asks for is not
            # withheld as a repeat (`FETCH_FAILED_MARKER`).
            return (
                f"{FETCH_FAILED_MARKER} Knowledge search failed for query={self.query!r}. "
                "Retry once with the same query; if it fails again, say you "
                "could not search the knowledge base and do not invent a citation. "
                f"Technical detail: {e}"
            )
        finally:
            # An answer that returned before the family read was awaited leaves
            # a task holding a store fetch. Cancelling it here is what keeps the
            # concurrency free: nothing outlives the call it was started for.
            for task in (self.family_task, self.folder_task):
                if task is not None and not task.done():
                    task.cancel()

    async def _prepare(self) -> None:
        # Files a person replaced by a newer one stay out of the RANKING on the
        # user shelves, so a superseded Fassung cannot outrank its replacement on
        # similarity alone. Naming the file (`file_name=`) is the way back to it.
        # The base corpus is untouched: it replaces by its own hash registry.
        # Read with `file_name=` too, but then only to say the named file is an older Fassung.
        self.superseded = await revisions.superseded_files(self.user_collections)
        self.hidden_revisions = {} if self.args.file_name else self.superseded
        self.retrieval_query = _cross_lingual_query(self.query)
        logger.info(
            "Knowledge search: query='%s...' collections=%s",
            self.query[:100],
            [(entry.collection, entry.shelf) for entry in self.targets],
        )
        self._start_side_reads()
        # Per-turn requery budget: one firing per turn. Reset per turn id when
        # the NAT context states one (user message id), falling back to the
        # executing-round stamp (round zero opens a new turn); unstamped
        # callers (tests, standalone) get a slot rather than inheriting a
        # spent cap. Fail-open when neither is visible.
        self.span_round = search_span.current_span_round()
        try:
            from knowledge_layer.requery import reset_requery_slot_for_turn

            reset_requery_slot_for_turn(self.span_round)
        except Exception:
            logger.debug("Requery slot reset skipped", exc_info=True)

    def _start_side_reads(self) -> None:
        """The family overview and the folder routes, read BESIDE the ranked search."""
        from aiq_agent.common.norm_registry import family_query_number

        from .folder_channel import folder_routes

        args = self.args
        # A query that names a Richtlinie and nothing else asks about the whole
        # FAMILY, and OIB 2 is four documents. Ranked passages answer that with
        # whichever two scored best, and the model cannot ask for the parts it
        # does not know exist, so this reads every member's scope and
        # Gliederung BESIDE the search and renders both in one block.
        # `file_name=` and `folder=` are the caller narrowing to one document,
        # which is the opposite request.
        self.family_key = None if (args.file_name or args.folder or args.grouping) else family_query_number(self.query)
        if self.family_key:
            self.family_task = asyncio.create_task(family_branch.family_branch(self.targets, self.family_key))
        # A search can land on a folder: its card's point, beside the passages (ADR-0127). Not when a
        # file is named, which is the caller already past every folder.
        if not args.file_name:
            self.folder_task = asyncio.create_task(
                folder_routes(
                    self.engine.retriever,
                    self.user_collections,
                    self.retrieval_query,
                    folder=args.folder,
                    hint=self.query,
                )
            )

    async def _ranked(self) -> str:
        results, hyde_results = await self._first_retrieval()
        # Merge by cross-collection rank fusion (scores are NOT comparable across
        # collections). `results` is in `targets` order, which is the channel
        # order the fusion breaks exact ties by. The per-document diversity cap
        # is NOT applied here: this builds the CANDIDATE pool, and the cap
        # belongs on the ANSWER budget, after the reranker has had the whole
        # pool to judge (rag-system-audit-2026-08 F16), so it is applied below.
        # HyDE channels ride along EMPTY by default and appended after the
        # originals when the probe fired, so the baseline order is untouched.
        merged = self._fused([*results, *hyde_results])
        # OCR debris out of the RANKED pool only, before the reranker, the
        # judge and the cap see it, so its slots go to real passages. The
        # literal modes returned earlier and keep every passage.
        merged, self.noise_left_out = fusion.pool_without_noise(merged, enabled=self.engine.drop_noise)
        reranked, verdict = await asyncio.gather(self._reranked(merged.chunks), self._judged(merged.chunks))
        if verdict is not None and verdict.wants_requery:
            merged, reranked = await self._requery(verdict, results, merged, reranked)
        pool = list(merged.chunks)
        merged = merged.model_copy(update={"chunks": reranked})
        merged, groups_trailer = self._answer_budget(merged, pool)
        merged = self._relevance_floor(merged)
        # Coverage: the judge found the first pool insufficient, and the
        # decider now reads the pool the model will get, after the requery
        # round. A complete "no" is said in the block; the pool stays whole,
        # because a decision never withholds a passage (ADR-0064). Anything
        # short of a complete "no" claims nothing.
        coverage = await search_results.coverage_gap(
            self.query, merged, verdict, self.engine.config, widened=self.requery_fired
        )
        branch = await self.family_task if self.family_task is not None else family_branch.NO_FAMILY_BRANCH
        merged, overview = self._with_family(merged, branch)
        search_span.emit(self, merged, overview, coverage)
        return await self._rendered(merged, branch, overview, coverage, groups_trailer)

    async def _first_retrieval(self) -> tuple[list, list]:
        # Fan out across all layers concurrently; tolerate empty/missing layers.
        # The HyDE draft (when armed) is drafted BESIDE that fan-out, so a fast
        # draft costs no latency; a slow one reads as no draft (fail-open) and
        # the search below is exactly the baseline. return_exceptions=True also
        # covers the draft slot, so the probe can never break the search.
        config = self.engine.config
        gathered = await asyncio.gather(
            *(self._retrieve_collection(entry) for entry in self.targets),
            hyde.draft_hyde_text(
                self.engine.rerank_llm,
                self.query,
                enabled=config.hyde_enabled,
                timeout_seconds=config.hyde_timeout_seconds,
            ),
            return_exceptions=True,
        )
        *results, hyde_text = gathered
        if isinstance(hyde_text, Exception) or not hyde_text:
            return results, []
        # One extra RRF channel per collection, APPENDED after the original
        # query's channels so the question as asked keeps the tie-break seat
        # (same convention as the requery widening). The draft goes through the
        # SAME retrieve path and is discarded right after: it never reaches the
        # reranker (which judges the original query) or the formatted answer.
        # Any fan-out failure keeps the first pool.
        try:
            hyde_results = await asyncio.gather(
                *(self._retrieve_collection(entry, hyde_text) for entry in self.targets),
                return_exceptions=True,
            )
            logger.info("HyDE channel widened the pool with a %d-char draft for %r", len(hyde_text), self.query[:60])
            return results, hyde_results
        except Exception:  # noqa: BLE001 - the first ranking is always a valid answer
            logger.warning("HyDE fan-out failed; keeping the first pool", exc_info=True)
            return results, []

    async def _retrieve_collection(self, entry, search_query: str | None = None):
        from .qdrant import prefilter as qdrant_prefilter

        coll = entry.collection
        retriever = self.engine.retriever
        # File exclusions + caller filters apply to the base collection only;
        # session/project collections are user content and are never filtered.
        coll_filters = (
            search_scope.base_collection_filters(self.engine.config, self.args.filters)
            if coll == self.base_collection
            else None
        )
        coll_filters = self.pushdown.narrow(coll_filters, user_shelf=coll != self.base_collection)
        result = await retriever.retrieve(
            query=search_query or self.retrieval_query,
            collection_name=coll,
            top_k=self.candidate_k,
            filters=coll_filters,
        )
        if self.hidden_revisions.get(coll) and getattr(result, "chunks", None):
            result = result.model_copy(
                update={"chunks": qdrant_prefilter.without_files(result.chunks, self.hidden_revisions[coll])}
            )
        _tag_with_collection(result, entry)
        if coll != self.base_collection:
            result = await self._with_named_file(entry, result)
        return result

    async def _with_named_file(self, entry, result):
        """Named retrieve: the agent's `file_name=` (explicit) or the visible peek (`focus_file_name`).

        So similarity is not the only path to that file. Explicit name wins when both are set.
        """
        try:
            from aiq_agent.common.focus_file import get_focused_file_name

            focused = self.args.file_name or get_focused_file_name()
        except Exception:
            focused = self.args.file_name
        if not focused:
            return result
        try:
            named = await self.engine.retriever.retrieve(
                query=self.query,
                collection_name=entry.collection,
                top_k=self.candidate_k,
                filters={"file_name": {"$eq": focused}},
            )
            _tag_with_collection(named, entry)
            if getattr(named, "success", False) and named.chunks:
                result = result.model_copy(
                    update={"chunks": list(named.chunks) + list(getattr(result, "chunks", []) or [])}
                )
        except Exception:
            logger.debug("Named-file retrieve skipped for %s", entry.collection, exc_info=True)
        return result

    def _fused(self, channels: list):
        """Rank-fuse the channels, then narrow by the agent's filters.

        `file_name=` is a FILTER, not a preference: the agent named a file, so
        other hits would be a silent bait-and-switch.
        """
        merged = fusion.merge_results(
            channels, self.query, self.candidate_k, self.engine.retriever.backend_name, max_per_document=0
        )
        args = self.args
        if args.doc_class or args.title_contains or args.file_name or args.folder:
            narrowed = hit_metadata.apply_agent_filters(
                merged.chunks,
                doc_class=args.doc_class,
                title_contains=args.title_contains,
                file_name=args.file_name,
                folder=args.folder,
            )
            return merged.model_copy(update={"chunks": narrowed})
        return merged.model_copy(update={"chunks": merged.chunks})

    async def _reranked(self, chunks):
        """Cross-encoder first when configured, LLM judge as the fallback; any error keeps the fused order."""
        if not self.engine.reranks:
            return chunks
        from knowledge_layer.rerank import rerank_chunks

        # Never trim below what the caller is about to ask for. `top_k` is
        # admin-tunable at runtime (up to 50) while `rerank_candidates` is a
        # build-time YAML value, so raising Platform -> Retrieval top_k above
        # rerank_candidates used to cap every search at rerank_candidates with
        # no error.
        rerank_top_n = max(self.top_k, self.engine.config.rerank_candidates)
        return await rerank_chunks(
            self.engine.rerank_llm,
            self.query,
            chunks,
            top_n=rerank_top_n,
            cross_encoder=self.engine.cross_encoder,
        )

    async def _judged(self, chunks):
        """The retrieval loop's judge (rag-system-audit-2026-08 F13), read BESIDE the reranker.

        A pool that is sufficient, the common case, pays nothing for having
        been judged; only an insufficient verdict costs a second round. Never
        raises: the judge fails open to "sufficient". The judge is skipped when
        the first pool already answers, and the turn fires at most ONCE.
        """
        # A search pinned to one document is a precision lookup: paraphrasing
        # it across every collection in scope is the opposite of what was
        # asked, and every document it drags in lands in the Herleitung as "read".
        if self.engine.requery_llm is None or self.args.file_name:
            if self.args.file_name:
                self.requery_skipped_reason = "file_pinned"
            return None
        try:
            reason = await self._judge_skip_reason(chunks)
            if reason is not None:
                self.requery_skipped_reason = reason
                logger.info("Retrieval loop judge skipped (%s) for %r", reason, self.query[:60])
                return None
        except Exception:
            logger.debug("Requery gate failed open to the judge", exc_info=True)
        from knowledge_layer.requery import judge_sufficiency

        config = self.engine.config
        return await judge_sufficiency(
            self.engine.requery_llm,
            self.query,
            chunks,
            max_queries=config.requery_max_queries,
            decider=config.requery_decider,
            decision_threshold=config.decision_sufficiency_threshold,
        )

    async def _judge_skip_reason(self, chunks) -> str | None:
        from knowledge_layer.requery import requery_already_fired
        from knowledge_layer.requery import should_skip_judge

        if self.family_task is not None and (await self.family_task).overview is not None:
            # An overview question is answered by the overview. The judge's own
            # criterion counts a scope note and a Gliederung as NOT answering,
            # so on this shape it said "insufficient" by construction. Keyed on
            # the overview PRODUCED, not on the query's shape: a corpus without
            # the family, or an overview that failed open, keeps its requery.
            return "family"
        if requery_already_fired():
            return "already_fired"
        args = self.args
        skip, reason = should_skip_judge(
            self.query,
            chunks,
            file_name=args.file_name,
            doc_class=args.doc_class,
            title_contains=args.title_contains,
            folder=args.folder,
            embedding_model=getattr(self.engine.retriever, "embed_model_name", None),
        )
        return reason if skip else None

    async def _requery(self, verdict, results, merged, reranked):
        """The judge's alternative queries as new RRF channels, once per turn; a failure keeps the first pool."""
        try:
            from knowledge_layer.requery import claim_requery_slot

            if not claim_requery_slot():
                self.requery_skipped_reason = "already_fired"
                logger.info(
                    "Retrieval loop requery suppressed (already_fired): "
                    "one firing per turn already spent, keeping the first pool"
                )
                return merged, reranked
            from aiq_agent.common.retrieval_status import emit_retrieval_requery

            emit_retrieval_requery(query_count=len(verdict.queries))
            extra = await asyncio.gather(
                *(
                    self._retrieve_collection(entry, alternative)
                    for alternative in verdict.queries
                    for entry in self.targets
                ),
                return_exceptions=True,
            )
            # The original query's channels stay first: RRF breaks exact ties
            # by channel order, and the question as asked keeps the tie-break
            # seat over any rewording of it.
            widened = self._fused([*results, *extra])
            widened, widened_noise = fusion.pool_without_noise(widened, enabled=self.engine.drop_noise)
            reranked = await self._reranked(widened.chunks)
            # A passage left out of both pools counts once; one left out of the
            # first only still counts, though the fusion may not have carried it.
            self.noise_left_out = self.noise_left_out | widened_noise
            self.requery_queries = list(verdict.queries)
            self.requery_fired = True
            logger.info(
                "Retrieval loop widened the pool with %d alternative quer(y/ies) to %d candidate(s)",
                len(self.requery_queries),
                len(widened.chunks),
            )
            return widened, reranked
        except Exception:  # noqa: BLE001 - the first ranking is always a valid answer
            logger.warning("Retrieval loop fan-out failed; keeping the first pool", exc_info=True)
            return merged, reranked

    def _answer_budget(self, merged, pool) -> tuple[Any, str]:
        """Trim to top_k: the soft per-document diversity cap, or one entry per document when grouping.

        In whatever order survived reranking (or the fused order when no
        reranker is configured). With the cap disabled this is the plain trim.
        """
        pre_cap_count = len(merged.chunks)
        groups_trailer = ""
        if self.args.grouping:
            # One entry per document instead of the cap: the grouping IS the spread.
            every_group = group_by_document(merged.chunks, pool)
            groups = every_group[: self.top_k]
            capped = [group.best for group in groups]
            groups_trailer = render_document_groups(groups, sum(group.passages for group in every_group))
        else:
            capped = fusion.apply_diversity_cap(merged.chunks, self.top_k, self.max_per_document)
        self.dropped_by_cap = max(0, pre_cap_count - len(capped))
        return merged.model_copy(update={"chunks": capped}), groups_trailer

    def _relevance_floor(self, merged):
        """Drop chunks under ``knowledge.relevance_floor_pct``; off by default.

        A floor is a number on one embedding model's cosine distribution, and
        measured on this corpus top-1 similarity does NOT separate answerable
        from unanswerable questions (they overlap by 0.066 with
        multilingual-e5-small over the 52-entry golden set). Abstention wants a
        judge that reads the question against the text (`coverage_gap`), not a
        threshold on a distance; calibrate with the retrieval-eval harness first.
        """
        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        floor_pct = get_retrieval_setting("knowledge.relevance_floor_pct", 0)
        if floor_pct <= 0:
            return merged
        floor = floor_pct / 100.0
        kept = [chunk for chunk in merged.chunks if chunk.score >= floor]
        if len(kept) != len(merged.chunks):
            best = max((chunk.score for chunk in merged.chunks), default=0.0)
            logger.info(
                "Relevance floor %.2f dropped %d/%d chunks (best score %.2f)",
                floor,
                len(merged.chunks) - len(kept),
                len(merged.chunks),
                best,
            )
            self.dropped_by_floor = len(merged.chunks) - len(kept)
        return merged.model_copy(update={"chunks": kept})

    def _with_family(self, merged, branch):
        """The family's members in FRONT of the ranked passages, after the cap and the floor.

        They are addressed, not ranked, so neither budget decides whether a
        part of the Richtlinie is shown. A passage the search also found is one
        passage, not two.
        """
        overview = branch.overview
        if not merged.success:
            # A fan-out that FAILED is reported as a failure. Decorating it
            # with an overview would render a complete-looking block over a
            # corpus that answered nothing.
            overview = None
        if overview is None:
            return merged, None
        unaddressed = family_branch.without_chunks(merged.chunks, overview.chunks)
        ranked = unaddressed[: family_branch.FAMILY_RANKED_HITS]
        self.dropped_by_family = len(unaddressed) - len(ranked)
        return merged.model_copy(update={"chunks": [*overview.chunks, *ranked]}), overview

    def _notice(self, merged, branch) -> str:
        """The widening and what was left out, said to the model that asked for the search.

        Carried on the empty-result message too: a search that widened AND
        still found nothing is where the model most needs to know that its own
        formulation was already given a second chance.
        """
        from knowledge_layer.requery import requery_notice

        notice = (
            revisions.hidden_revisions_notice(self.hidden_revisions)
            + revisions.named_older_revision_notice(self.args.file_name, self.superseded)
            + requery_notice(self.requery_queries)
            + noise_notice(self.dropped_as_noise)
        )
        # The overview raised, and the passages below are what is left of the
        # family question. Said only where there ARE passages: an empty or
        # failed search already tells the model the stronger thing.
        if branch.failed and merged.chunks:
            notice += family_branch.FAMILY_OVERVIEW_FAILED_NOTICE.format(key=self.family_key)
        return notice

    async def _rendered(self, merged, branch, overview, coverage, groups_trailer: str) -> str:
        from aiq_agent.common.tool_calls import KNOWLEDGE_SEARCH_TOOL
        from aiq_agent.common.turn_status import lane_tool_scope

        notice = self._notice(merged, branch)
        folders_trailer = await self.folder_task if self.folder_task is not None else ""
        self.outcome.record_chunks(merged.chunks)
        degraded = not merged.success or bool(getattr(merged, "error_message", None))
        self.outcome.failed = not merged.chunks and degraded
        if not merged.chunks:
            # A failed or degraded merge is NOT a miss: both must reach
            # `format_results`, which renders the failure or warning, rather
            # than the retry hint, which would read as "nothing matched".
            if degraded:
                with lane_tool_scope(KNOWLEDGE_SEARCH_TOOL):
                    return notice + search_results.format_results(merged, self.query)
            args = self.args
            empty = search_results.empty_search_message(
                self.query,
                file_name=args.file_name,
                doc_class=args.doc_class,
                title_contains=args.title_contains,
                folder=args.folder,
            )
            return notice + empty + (f"\n\n{folders_trailer}" if folders_trailer else "")
        trailer = "\n\n".join(
            part for part in (overview.trailer if overview is not None else "", groups_trailer, folders_trailer) if part
        )
        # Off the event loop: `format_results` does batched store reads. The
        # lane-tool scope is entered HERE, outside the await: `asyncio.to_thread`
        # copies the context when the call is made, so a scope opened in the
        # worker thread would be a copy nobody reads back.
        with lane_tool_scope(KNOWLEDGE_SEARCH_TOOL):
            formatted = await asyncio.to_thread(
                search_results.format_results,
                merged,
                self.query,
                notice,
                trailer,
                overview.preamble if overview is not None else "",
                overview.opened_files if overview is not None else frozenset(),
                coverage_gap=coverage.reason() if coverage is not None else None,
            )
        logger.info(f"Knowledge search returned {len(merged.chunks)} chunks")
        logger.debug(f"Formatted result for LLM:\n{formatted[:500]}...")
        return formatted


def _cross_lingual_query(query: str) -> str:
    """The query the store matches: an English question gets the corpus's own German terms prepended.

    The corpus is German; an English question reaches it only weakly by
    embedding and not at all lexically (golden set: MRR 0.276 against 0.605
    for the same question in German, lifted to 0.502 by the bridge). A German
    query comes back untouched. ONLY the matching query is augmented: the
    reranker judges, and the grounding block reports, the question as asked.
    """
    from aiq_agent.common.query_expansion import augmented_query

    retrieval_query = augmented_query(query)
    if retrieval_query != query:
        logger.info("Query expanded for retrieval: %r -> %r", query[:60], retrieval_query[:80])
    return retrieval_query


def _tag_with_collection(result, entry) -> None:
    """Stamp each chunk with its collection and shelf, the last point both are known for free.

    The trace UI's lane labels and source_lane read the collection; nothing
    downstream may recover the shelf from the collection id (ADR-0047). An
    unstated shelf stays absent: absent means unknown, and unknown renders
    unattributed.
    """
    for chunk in getattr(result, "chunks", []) or []:
        chunk.metadata.setdefault("collection", entry.collection)
        if entry.shelf is not None:
            chunk.metadata.setdefault("shelf", str(entry.shelf))
