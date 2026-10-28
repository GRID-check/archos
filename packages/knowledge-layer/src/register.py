"""Agent-runtime function for knowledge retrieval."""

import asyncio
import logging
import os
from collections.abc import Sequence
from typing import Any
from typing import Literal

from knowledge_layer.knowledge_search import KnowledgeSearch
from pydantic import Field
from pydantic import model_validator

from agent.common.tool_calls import CONCLUSION_ARG
from agent.common.tool_calls import CONCLUSION_DESCRIPTION
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

logger = logging.getLogger(__name__)

# Agent-facing contract. Distinct from ``surface_documents`` (show a file). A minimal contract:
# what it does, its inputs, what it returns and where it stops. How and when to use it is the
# agent's judgement, not this text's (writing-tools-for-agents).
#: How the search is scoped, the one paragraph a binding replaces (``chat_binding``). The query is
#: asked for in the documents' language: the corpus is German, and beside the multilingual dense
#: channel the lexical ones (German BM25, the exact-term phrases) match only the documents' words.
SCOPE_PARAGRAPH = (
    "Inputs: `query`, a search query in the documents' language (topic, jurisdiction, year), not the raw user "
    "message. Narrow with `file_name=` (an indexed name from the inventory or the user; never invent one), "
    "`folder=` (a path as the inventory prints it after 'Ordner:'; includes everything filed beneath it; never "
    "invent one), `doc_class=` (Dokumentart key, e.g. oib_guideline), `title_contains=`, and `shelf=` (project, "
    "office or base; omitted, every shelf is read), or with `path=` as a hit's `Path:` line names a place, a "
    "folder or one file. "
)


#: Said of ``conclusion`` where the schema cannot carry a field description.
CONCLUSION_LINE = f"\n`{CONCLUSION_ARG}=`: {CONCLUSION_DESCRIPTION}"


_KNOWLEDGE_SEARCH_DESCRIPTION = (
    "Searches the ingested knowledge base (the office's files and the OIB corpus) and returns quotable "
    "passages, each with a Citation key: the evidence tool. It does not put a file on screen "
    "(`surface_documents` does).\n"
    + SCOPE_PARAGRAPH
    + '`group_by="document"` (ranked search only) returns one entry per document: its best passage and how many '
    "passages of the ranked pool it held.\n"
    '`match="exact"` returns EVERY passage that contains the query literally, plus a table of the matching files '
    "with count and pages, and shows a term is written nowhere. Several spellings go in one query separated by "
    "'|'; case, ä/ae, ß/ss and a line break, space or hyphen between words are matched for you; a term of two "
    "or three characters matches as a whole word only. `stemmed=true` also finds inflected forms. Per shelf it "
    "states how many documents were searched and how many matched.\n"
    '`match="regex"` is the same search with a regex in Python syntax, case-insensitive, for a '
    "pattern (a Geschäftszahl `MA 37/\\d{6}`, a fire door `\\bT30-\\d+`); `|` is then regex alternation. "
    "It needs one literal whole word or number it must contain (`37`, `T30`), or a `folder=`, `file_name=` or "
    "`doc_class=` to read in; a pattern that backtracks is refused. `context=` (0 to 3) adds the lines around "
    "every hit. A search that stops at its limit says so, and its counts are then lower bounds.\n"
    "Returns: numbered passages with Source, Citation (cite this key verbatim), Dokumentart, Ordner, page and "
    "text. A query that names a Richtlinie and nothing else ('OIB 2') returns every part of it the corpus "
    "holds, each with its Geltungsbereich and Gliederung: every member is then open at the level a read of one "
    "document opens it, and what is left to open is a Punkt by number." + CONCLUSION_LINE
)


#: The paragraphs of :data:`_KNOWLEDGE_SEARCH_DESCRIPTION` that offer a literal mode, each dropped when
#: its mode is not configured.
_EXACT_PARAGRAPH = _KNOWLEDGE_SEARCH_DESCRIPTION[
    _KNOWLEDGE_SEARCH_DESCRIPTION.index('`match="exact"`') : _KNOWLEDGE_SEARCH_DESCRIPTION.index('`match="regex"`')
]


_REGEX_PARAGRAPH = _KNOWLEDGE_SEARCH_DESCRIPTION[
    _KNOWLEDGE_SEARCH_DESCRIPTION.index('`match="regex"`') : _KNOWLEDGE_SEARCH_DESCRIPTION.index("Returns: numbered")
]


def knowledge_search_description(match_modes: Sequence[str], scope: str | None = None) -> str:
    """The description, offering only the ``match`` modes this configuration accepts.

    ``match_modes`` is an eval knob (``KnowledgeRetrievalConfig.match_modes``). A description that
    offered a mode the search then refuses would cost each arm a call to learn so, and bias the
    comparison the knob exists for. ``scope`` replaces :data:`SCOPE_PARAGRAPH` (and the
    ``conclusion`` line, which such a binding's schema describes) for a binding scoped another way.
    """
    modes = set(match_modes)
    text = _KNOWLEDGE_SEARCH_DESCRIPTION
    if scope is not None:
        text = text.replace(SCOPE_PARAGRAPH, scope).replace(CONCLUSION_LINE, "")
    if "exact" not in modes:
        text = text.replace(_EXACT_PARAGRAPH, "")
    if "regex" not in modes:
        text = text.replace(_REGEX_PARAGRAPH, "")
    return text


def result_budget(top_k: int, max_per_document: int) -> str:
    """The sentence that states how many passages a search returns, from its configuration."""
    if max_per_document > 0:
        diversity = (
            f"spread across multiple distinct documents (at most {max_per_document} per document "
            "where possible), so cross-cutting questions see every relevant Richtlinie."
        )
    else:
        diversity = "ranked purely by relevance, with no per-document diversity cap."
    return (
        f"Returns up to {top_k} excerpts by default (platform-configurable up to 50; the result header counts "
        f"them), {diversity}"
    )


# The knowledge layer has one backend (ADR-0072). The name still keys the
# adapter registry, where tests register fakes beside it.
BACKEND = "llamaindex"


class KnowledgeRetrievalConfig(FunctionBaseConfig, name="knowledge_retrieval"):
    """Configuration for knowledge retrieval function."""

    collection_name: str = Field(default="default", description="Name of the collection/index to search")
    use_fixed_collection: bool = Field(
        default=False,
        description=(
            "When true, always search the configured collection_name and ignore the per-session "
            "conversation_id collection. Use for fixed, persistent corpora."
        ),
    )
    include_base_collection: bool = Field(
        default=False,
        description=(
            "Always include the configured base collection_name in the search set (e.g. the fixed OIB corpus)."
        ),
    )
    include_session_collection: bool = Field(
        default=True,
        description=(
            "Also search the per-session collection (Context.conversation_id) when available, "
            "so per-conversation uploads are searched."
        ),
    )
    project_collections: list[str] = Field(
        default_factory=list,
        description=(
            "Additional named persistent collections (e.g. project-scoped corpora) to always include in the search set."
        ),
    )
    top_k: int = Field(default=5, description="Number of results to return")
    max_chunks_per_document: int = Field(
        default=2,
        ge=0,
        description=(
            "Diversity cap: at most this many chunks from a single document are included before "
            "other documents get a slot; any remaining slots up to top_k are then filled with the "
            "highest-scoring chunks regardless of source. Prevents one high-scoring PDF from "
            "crowding out other documents on cross-cutting questions. 0 disables the cap."
        ),
    )
    exclude_file_names: list[str] = Field(
        default_factory=list,
        description=(
            "File names whose chunks are excluded from results of the base collection "
            "(e.g. OIB Änderungsdokumente and superseded editions). Applied as a "
            "metadata filter (file_name NOT IN ...) on the base collection only; "
            "session and project collections are never filtered."
        ),
    )
    # Summarization options (applies to all backends)
    generate_summary: bool = Field(
        default=False, description="Generate one-sentence summary for each ingested document"
    )
    summary_model: str | None = Field(
        default=None,
        description="Required when generate_summary=true: LLM reference from llms: section",
    )
    summary_db: str = Field(
        default="sqlite+aiosqlite:///./summaries.db",
        description="Database URL for document summaries (SQLite or PostgreSQL)",
    )
    match_modes: list[str] = Field(
        default_factory=lambda: ["meaning", "exact", "regex"],
        description=(
            "EVAL KNOB, not a product setting: the `match=` modes the search accepts on the bindings that "
            "offer `match` (deep research, intake). The answer suite's `semantic` arm keeps only `meaning`; "
            "Piloti's chat binds ranked search only since ADR-0133 slice 6, so its `grep` arm unbinds the "
            "search instead of narrowing it. A comma-separated string is read as a list, which is how "
            "`nat run --override` hands one over. Production keeps the default: every mode."
        ),
    )
    hybrid_search: bool | None = Field(
        default=None,
        description=(
            "Enable the lexical channels beside the dense one (German BM25 and the exact-term "
            "phrase channels, fused in Qdrant by reciprocal rank fusion). "
            "None = environment default HYBRID_RETRIEVAL (on)."
        ),
    )
    rerank_llm: str | None = Field(
        default=None,
        description=(
            "Optional LLM reference from llms: section used to re-rank retrieved chunks "
            "against the query (LLM-judge reranking; fail-open to the original order)."
        ),
    )
    reranker_provider: str | None = Field(
        default=None,
        description=(
            "Cross-encoder reranking provider (none|openrouter|jev). `jev` scores one decision-model "
            "noul per candidate (ADR-0064), an option to evaluate beside the cross-encoder. "
            "None falls back to the RERANKER_PROVIDER environment default, which is "
            "'none'. When one resolves it becomes the primary reranker and rerank_llm "
            "becomes the fallback; a missing key or any provider error degrades to the judge."
        ),
    )
    reranker_model: str | None = Field(
        default=None,
        description=(
            "Cross-encoder model id (default qwen/qwen3-reranker-8b: multilingual, which a German corpus "
            "needs, and with a zero-data-retention endpoint, which every rerank is pinned to)."
        ),
    )
    rerank_candidates: int = Field(
        default=15,
        ge=1,
        description=(
            "How many candidate chunks to over-fetch and re-rank when rerank_llm is set. "
            "Reranking converts recall into precision, so this should exceed top_k by "
            "several times, not by a margin. Must be >= 1: zero used to be accepted and "
            "trimmed every search to nothing."
        ),
    )
    requery_llm: str | None = Field(
        default=None,
        description=(
            "Optional LLM reference from llms: section that judges whether the fused "
            "candidate pool can answer the query and, when it cannot, proposes alternative "
            "formulations that are retrieved and fused into the same pool before reranking "
            "(the retrieval loop). Runs beside the reranker, so a sufficient pool costs no "
            "extra latency. Unset = one-shot retrieval. Fail-open: any judge error keeps "
            "the first pool."
        ),
    )
    requery_max_queries: int = Field(
        default=2,
        ge=1,
        le=4,
        description=(
            "Ceiling on alternative queries the judge may propose per search when "
            "requery_llm is set. Each is one retrieval per in-scope collection."
        ),
    )
    requery_decider: str = Field(
        default="llm",
        description=(
            "Who answers the judge's yes/no (llm|jev). `jev` asks the decision model one noul per "
            "passage of the head first (ADR-0064, ~300 ms, a fraction of a cent): a head it finds "
            "sufficient costs no judge call, and only an insufficient head runs requery_llm, for the "
            "phrasings. A decision that cannot run (no key, a BYOK key on another host, breaker open) falls "
            "back to the judge."
        ),
    )
    decision_sufficiency_threshold: float = Field(
        default=0.55,
        ge=0.0,
        le=1.0,
        description=(
            "With requery_decider=jev: the head is sufficient when any passage's p(answers the question) "
            "reaches this. Lower = fewer requeries; the decision eval sweeps it."
        ),
    )
    hyde_enabled: bool = Field(
        default=False,
        description=(
            "HyDE-as-channel experiment (backlog item 14), default OFF. When true, a "
            "query with no exact identifier shape drafts a hypothetical norm-register "
            "passage that is retrieved and fused as one extra RRF channel beside the "
            "original query (which always stays in the mix and is what the reranker "
            "judges). The draft reuses the resolved rerank_llm handle — greedy, "
            "reasoning-free, already paid for — so enabling this adds no model "
            "plumbing and re-points no model. Draft failure/slowness degrades to the "
            "baseline silently. Ship as default behaviour only if the golden harness "
            "shows an overview lift with no exact-id/paraphrase regression."
        ),
    )
    drop_ocr_noise: bool | None = Field(
        default=None,
        description=(
            "Leave text passages that are OCR debris (a scanned drawing's text layer: rotated labels one "
            "glyph group per line, spaced capitals one letter per token; `chunk_noise`) out of the ranked "
            "pool, before the reranker and the per-document cap, so their slots go to real passages. "
            'Never touches `match="exact"`/`"regex"`. None = environment default DROP_OCR_NOISE '
            "(off). Switch it on only after the answer suite has measured it."
        ),
    )
    hyde_timeout_seconds: float = Field(
        default=8.0,
        ge=1.0,
        le=30.0,
        description=(
            "Upper bound on the HyDE draft call. It runs beside the first retrieval "
            "fan-out, so a fast draft costs no latency; past this it reads as no "
            "draft and the search is the baseline."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def read_match_modes(cls, data):
        """``match_modes`` given as a comma-separated string (a ``nat run --override``) is a list."""
        if isinstance(data, dict) and isinstance(data.get("match_modes"), str):
            data = {**data, "match_modes": [mode.strip() for mode in data["match_modes"].split(",") if mode.strip()]}
        return data

    @model_validator(mode="after")
    def keep_ranked_search(self):
        """A search without ``meaning`` is refused: literal-only is ``grep``'s, on a binding that reads the estate."""
        if "meaning" not in self.match_modes:
            raise ValueError("match_modes must keep `meaning`; a literal-only arm unbinds the search for `grep`.")
        return self

    @model_validator(mode="after")
    def validate_summary_config(self):
        """``generate_summary`` needs a ``summary_model`` to summarise with."""
        if self.generate_summary and not self.summary_model:
            raise ValueError(
                "generate_summary=true requires summary_model to be set. "
                "Configure summary_model to reference an LLM from the llms: section."
            )
        return self


def _setup_backend(config: KnowledgeRetrievalConfig, summary_llm_obj=None) -> tuple[str, dict]:
    """
    Import the llamaindex adapter and build its configuration.

    Importing the adapter module triggers the @register_retriever/@register_ingestor
    decorators, which register the adapter classes with the factory.

    Args:
        config: Knowledge retrieval configuration
        summary_llm_obj: Optional resolved LLM object for summarization

    Returns:
        Tuple of (backend_name, backend_config_dict)
    """
    import knowledge_layer.llamaindex.adapter  # noqa: F401

    backend_config: dict = {
        "generate_summary": config.generate_summary,
        "summary_llm": summary_llm_obj,
    }
    if config.hybrid_search is not None:
        backend_config["hybrid_search"] = config.hybrid_search

    os.environ["KNOWLEDGE_RETRIEVER_BACKEND"] = BACKEND
    os.environ["KNOWLEDGE_INGESTOR_BACKEND"] = BACKEND

    return BACKEND, backend_config


#: Modules the search imports inside its body, on first use. Importing them at
#: build time takes their cost (``folder_channel`` alone was 136 ms, measured
#: 2026-10-27) off the first turn. ``_warm_search_path_sync`` imports each by a
#: literal statement; the test holds the two lists together.
_SEARCH_PATH_MODULES = (
    "knowledge_layer.browse",
    "knowledge_layer.folder_channel",
    "knowledge_layer.read_passage",
    "knowledge_layer.requery",
    "agent.observability.retrieval_trace",
)


def _warm_search_path_sync(retriever: Any) -> None:
    warm = getattr(retriever, "warm_components", None)
    if callable(warm):
        warm()
    import knowledge_layer.browse  # noqa: F401 - warm-up import
    import knowledge_layer.folder_channel  # noqa: F401 - warm-up import
    import knowledge_layer.read_passage  # noqa: F401 - warm-up import
    import knowledge_layer.requery  # noqa: F401 - warm-up import

    import agent.observability.retrieval_trace  # noqa: F401 - warm-up import


async def _warm_search_path(retriever: Any) -> None:
    """Initialise the retriever and import the search path now, off the loop; never raises.

    What the first search of a process otherwise paid before its first
    embedding call: the retrieval stack's imports and the embedding client
    (``LlamaIndexRetriever.warm_components``), and the modules the search body
    imports on first use. It reads no network, so a store that is down costs
    nothing here and fails the search where it always did. A failure is logged
    and the first search initialises as before.
    """
    import time

    started = time.perf_counter()
    try:
        await asyncio.to_thread(_warm_search_path_sync, retriever)
    except Exception:  # noqa: BLE001 - a warm-up is worth less than the boot
        logger.warning("Knowledge search warm-up failed; the first search initialises instead", exc_info=True)
        return
    logger.info("Knowledge search warmed at build in %.0f ms", 1000 * (time.perf_counter() - started))


def _get_retriever(config: KnowledgeRetrievalConfig):
    """Get the retriever singleton from the factory."""
    from agent.knowledge.factory import get_retriever

    backend, backend_config = _setup_backend(config)
    retriever = get_retriever(backend, backend_config)
    logger.info("Initialized %s retriever", backend)
    return retriever


def _initialize_ingestor(config: KnowledgeRetrievalConfig, summary_llm_obj=None):
    """
    Initialize and activate the ingestor for the Knowledge API.

    Called during function registration to:
    1. Create the ingestor singleton via the factory
    2. Set it as the active ingestor for API routes to use

    Args:
        config: Knowledge retrieval configuration
        summary_llm_obj: Optional resolved LLM object for summarization
    """
    from agent.knowledge.factory import get_ingestor
    from agent.knowledge.factory import set_active_ingestor

    backend, backend_config = _setup_backend(config, summary_llm_obj)
    ingestor = get_ingestor(backend, backend_config)
    set_active_ingestor(ingestor)
    logger.info("Activated %s ingestor for Knowledge API", backend)
    return ingestor


async def _platform_llm(builder: Builder, ref):
    """A model no organization can choose, pinned to zero-data-retention endpoints.

    The summary, judge and requery models have no agent group: no organization
    can choose them, and every tenant's documents and questions pass through
    them. So they are pinned here, once, for every request
    (``openrouter.PLATFORM_FIXED``); a model that cannot carry the pin fails
    here rather than send unpinned.
    """
    from agent.common import get_langchain_llm
    from agent.common.openrouter import PLATFORM_FIXED
    from agent.common.openrouter import pin_chat_model

    return pin_chat_model(await get_langchain_llm(builder, ref), PLATFORM_FIXED)


async def _judge_models(config: KnowledgeRetrievalConfig, builder: Builder) -> tuple[Any, Any]:
    """The LLM-judge reranker and the retrieval loop's judge; each fails open to ``None``."""
    # Fail-open: search still works when unset or unresolvable, and
    # rerank_chunks degrades to the original order.
    rerank_llm_obj = None
    if config.rerank_llm:
        try:
            rerank_llm_obj = await _platform_llm(builder, config.rerank_llm)
            logger.info("Resolved rerank model: %s", config.rerank_llm)
        except Exception as e:
            logger.warning(f"Could not resolve rerank_llm '{config.rerank_llm}', reranking disabled: {e}")
    # Shares the reranker's handle when the config names the same model, which
    # is the reference setup.
    requery_llm_obj = None
    if config.requery_llm:
        if config.requery_llm == config.rerank_llm and rerank_llm_obj is not None:
            requery_llm_obj = rerank_llm_obj
        else:
            try:
                requery_llm_obj = await _platform_llm(builder, config.requery_llm)
                logger.info("Resolved requery model: %s", config.requery_llm)
            except Exception as e:
                logger.warning(f"Could not resolve requery_llm '{config.requery_llm}', retrieval loop disabled: {e}")
    return rerank_llm_obj, requery_llm_obj


def _cross_encoder(config: KnowledgeRetrievalConfig):
    """The cross-encoder reranker when configured, primary over the LLM judge; ``None`` otherwise, never a raise.

    Built once at startup with no organization in scope, which is why the KEY
    is not decided here: the handle resolves its credential per search from the
    turn's organization, so a BYOK org's reranks go out on its own key
    (``cross_encoder.CrossEncoderReranker._credential_for_search``). The
    platform key still has to resolve at startup, because a handle that could
    never authenticate anything is one this returns None for.
    """
    try:
        from knowledge_layer.cross_encoder import resolve_cross_encoder

        return resolve_cross_encoder(config.reranker_provider, model=config.reranker_model)
    except Exception as e:
        logger.warning(f"Cross-encoder reranker unavailable ({type(e).__name__}: {e}); using the LLM judge")
        return None


async def _bound_retriever(config: KnowledgeRetrievalConfig, summary_llm_obj) -> Any:
    """The stores configured, the search retriever built and warmed, and the ingestor initialized."""
    from agent.knowledge.factory import configure_summary_db
    from agent.knowledge.factory import set_search_retriever
    from agent.knowledge.norm_store import configure_norm_store

    configure_summary_db(config.summary_db)
    # The admin-managed norm registry store shares the summary DB URL (one
    # knowledge database, no extra env var — see norm_store module docstring).
    # It seeds itself from the YAML registry and registers as norm_registry's
    # runtime source; fail-open, so a store error just keeps the YAML seed.
    configure_norm_store(config.summary_db)
    retriever = _get_retriever(config)
    # The turn-start warm-up (Piloti) embeds the question in THIS retriever's
    # cache while the turn decision runs, so the prefetch search skips the
    # round trip. See ``warm_search_query``.
    set_search_retriever(retriever)
    # The search path's lazy initialisation, at boot instead of inside the
    # first turn's prefetch (`_warm_search_path`).
    await _warm_search_path(retriever)
    _initialize_ingestor(config, summary_llm_obj)
    return retriever


@register_function(config_type=KnowledgeRetrievalConfig)
async def knowledge_retrieval(config: KnowledgeRetrievalConfig, _builder: Builder):
    """
    Knowledge retrieval function for searching ingested documents.

    This function provides semantic search over documents that have been
    previously ingested into the knowledge layer (the llamaindex backend) and
    returns formatted results suitable for LLM consumption.

    The retriever and ingestor are initialized once when the function is
    created and reused for all subsequent queries. The ingestor singleton
    is also made available to the Knowledge API routes via the factory.
    """
    summary_llm_obj = None
    if config.summary_model and config.generate_summary:
        summary_llm_obj = await _platform_llm(_builder, config.summary_model)
        logger.info("Resolved summary model: %s", config.summary_model)
    rerank_llm_obj, requery_llm_obj = await _judge_models(config, _builder)
    # HyDE-as-channel (backlog item 14, experiment, default off): the draft
    # reuses the resolved rerank handle, so without that handle the channel is
    # silently off, however the flag is set.
    hyde_armed = bool(config.hyde_enabled and rerank_llm_obj is not None)
    logger.info("HyDE channel: %s", "armed (draft via rerank_llm)" if hyde_armed else "disabled")
    retriever = await _bound_retriever(config, summary_llm_obj)
    engine = KnowledgeSearch(
        config,
        retriever,
        rerank_llm=rerank_llm_obj,
        requery_llm=requery_llm_obj,
        cross_encoder=_cross_encoder(config),
    )
    top_k = config.top_k
    max_per_document = config.max_chunks_per_document
    logger.info(
        "Knowledge retrieval initialized: backend=%s, collection=%s, top_k=%d", BACKEND, config.collection_name, top_k
    )

    async def search(
        query: str,
        filters: dict | None = None,
        doc_class: str | None = None,
        title_contains: str | None = None,
        file_name: str | None = None,
        folder: str | None = None,
        match: str = "meaning",
        context: int | str | None = None,
        group_by: Literal["document"] | None = None,
        stemmed: bool = False,
        shelf: str | None = None,
        document_type: str | None = None,
        refers_to: str | None = None,
        conclusion: str = "",
        path: str | None = None,
    ) -> str:
        """Read and cite passages from the ingested knowledge base.

        Args:
            query (str): The fact or passage you need, rewritten as a search
                query (topic + jurisdiction + implied year). Not the raw user
                message.
            conclusion (str): Optional. One line on what you are looking for;
                no effect on the call.
            file_name (str | None): Indexed file name to read (from the
                inventory or the user). Never invent a name. Base-corpus
                files are not listed in the inventory — filter those with
                `doc_class` instead.
            doc_class (str | None): Dokumentart key (e.g. "oib_guideline",
                "law"). Store-authoritative; reclassifications apply
                without re-ingest.
            title_contains (str | None): Case-insensitive substring of the
                file name OR display title.
            folder (str | None): Project folder path to read within, exactly as
                the inventory prints it after "Ordner:" (e.g.
                "Brandschutz/Fluchtwege"). Includes everything filed beneath it,
                so "Brandschutz" also reads "Brandschutz/Fluchtwege". Never
                invent a folder.
            filters (dict | None): Rare. Metadata filter on the base
                collection only (e.g. {"content_type": "text"}). Session and
                project collections are never filtered.
            match (str): "meaning" (default) ranks passages by what they say.
                "exact" returns EVERY passage whose text contains the query
                literally (case, ä/ae, ß/ss spellings and line breaks or
                hyphens between words matched; a term of up to three
                characters as a whole word; several spellings separated by
                "|"), with a per-file count of all matches — for a name, a
                number, a code or a wording. "regex" is the same search for a
                pattern in Python syntax (case-insensitive; "|" is regex
                alternation): it needs one literal word it must contain, or
                `folder`, `file_name` or `doc_class` to read in.
            context (int | None): Exact and regex only: 0 to 3 lines shown
                around every hit, as an index under the passages (0: the hit
                lines alone, for every hit and not only the eight passages).
            group_by (str | None): "document" returns one entry per document
                (its best passage, and how many passages of the ranked pool it
                held) for "which documents deal with X". Ranked search only.
            shelf (str | None): "project", "office" or "base": read that shelf only.
                Omitted: every shelf this question may read, the Basiswissen
                corpus (building law) included. For "is X in OUR documents" pass
                "project" or "office" (or both in turn); an exact or regex answer
                also counts matches and documents per shelf.
            document_type (str | None): Only documents Piloti read to be this kind,
                the "Type:" `list_files` prints with underscores (e.g.
                "fire_safety_concept", "building_description", "permit",
                "submission_drawing"). Project and office documents only.
            refers_to (str | None): Only documents that refer to this: a norm
                ("ÖNORM B 1600"), a law ("§ 33 BayBO"), a plan number ("EP-05") or a
                kind of document, named the way the documents write it. For "which
                documents cite this standard", "what points to plan EP-05", "who
                relies on the fire safety concept". `list_files` prints each
                document's "Refers to:".
            stemmed (bool): Exact only: also find each word's inflected forms
                (German stemming: "Fluchtwegbreite" finds "Fluchtwegbreiten" and
                the reverse). Off by default: the exact search is literal.
            path (str | None): Where to search, as the filesystem tools name it: a place
                ("/project/", "/office/", "/chat/", "/law/oib/"), a folder in one
                ("/project/Gutachten/"), or one file (a hit's `Path:`). Advised, never
                automatic: omitted, every place this question may read is searched.
                It sets `shelf`, `folder` and `file_name`; an explicit one of those wins.

        Returns:
            str: Numbered excerpts with a Citation key to copy verbatim, each with the `Path:` read_file opens.
        """
        return await engine.search(
            query,
            filters=filters,
            doc_class=doc_class,
            title_contains=title_contains,
            file_name=file_name,
            folder=folder,
            match=match,
            context=context,
            group_by=group_by,
            stemmed=stemmed,
            shelf=shelf,
            document_type=document_type,
            refers_to=refers_to,
            path=path,
        )

    try:
        yield FunctionInfo.from_fn(
            search,
            description=f"{knowledge_search_description(config.match_modes)} {result_budget(top_k, max_per_document)}",
        )
    finally:
        from agent.knowledge.factory import clear_search_retriever

        clear_search_retriever(retriever)
