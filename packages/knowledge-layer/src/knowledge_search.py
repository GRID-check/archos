"""The `knowledge_search` tool: one call from its arguments to the block the model reads.

`KnowledgeSearch` is bound once at startup to the retriever and the models.
Each call checks its arguments, resolves the collections it may read, answers a
literal search directly and hands a ranked one to `ranked_search.RankedSearch`.
"""

import logging
from dataclasses import dataclass
from typing import Any

from knowledge_layer import search_scope
from knowledge_layer.ranked_search import RankedSearch

from aiq_agent.common.action_outcome import ActionOutcome
from aiq_agent.common.action_rows import ActionRow
from nat.plugin_api import Context

from .chunk_noise import noise_filter_enabled
from .document_groups import GROUP_BY_DOCUMENT

logger = logging.getLogger(__name__)

#: The answer to a call without a query.
EMPTY_QUERY_REFUSAL = (
    "Provide a `query` that names the fact or passage you need "
    "(e.g. 'OIB-RL 2 Fluchtweglänge GK 4'). "
    "If you already have an indexed file name from the inventory, "
    "also pass `file_name=`."
)

#: The two literal modes: same scope, same narrowing, no ranking at all.
LITERAL_MODES = frozenset({"exact", "regex"})


@dataclass(frozen=True, slots=True)
class SearchArgs:
    """A call's arguments, trimmed and checked."""

    query: str
    filters: dict | None
    doc_class: str | None
    title_contains: str | None
    file_name: str | None
    folder: str | None
    mode: str
    context: int | str | None
    grouping: str | None
    stemmed: bool
    shelf: str | None
    document_type: str | None
    refers_to: str | None


def parse_args(
    *,
    query: str,
    filters: dict | None,
    doc_class: str | None,
    title_contains: str | None,
    file_name: str | None,
    folder: str | None,
    match: str,
    context: int | str | None,
    group_by: str | None,
    stemmed: bool,
    shelf: str | None,
    document_type: str | None,
    refers_to: str | None,
) -> SearchArgs | str:
    """The call's arguments trimmed, or the sentence that refuses them."""
    query = (query or "").strip()
    if not query:
        return EMPTY_QUERY_REFUSAL
    if doc_class is not None:
        from aiq_agent.knowledge.document_classification import DOCUMENT_CLASSES
        from aiq_agent.knowledge.document_classification import canonical_doc_class

        # A conversation holding a search by the German key invites the model to repeat it.
        current_doc_class = canonical_doc_class(doc_class)
        if current_doc_class is None:
            valid = ", ".join(DOCUMENT_CLASSES)
            return (
                f"Invalid doc_class {doc_class!r}. Valid values: {valid}. Omit `doc_class` to search every Dokumentart."
            )
        doc_class = current_doc_class
    document_type = (document_type or "").strip().casefold().replace(" ", "_") or None
    if document_type is not None:
        from aiq_agent.knowledge.dossier import DOCUMENT_TYPES

        if document_type not in DOCUMENT_TYPES:
            return (
                f"Invalid document_type {document_type!r}. Valid values: {', '.join(DOCUMENT_TYPES)}. "
                "Omit `document_type` to search every kind of document."
            )
    return SearchArgs(
        query=query,
        filters=filters,
        doc_class=doc_class,
        title_contains=(title_contains or "").strip() or None,
        file_name=(file_name or "").strip() or None,
        folder=(folder or "").strip().strip("/") or None,
        mode=(match or "meaning").strip().lower(),
        context=context,
        grouping=(group_by or "").strip().lower() or None,
        stemmed=stemmed,
        shelf=shelf,
        document_type=document_type,
        refers_to=refers_to,
    )


def mode_refusal(args: SearchArgs, match_modes) -> str | None:
    """The sentence refusing a mode, a grouping or `stemmed` this call cannot use, or ``None``."""
    if args.mode in {"meaning", *LITERAL_MODES} and args.mode not in match_modes:
        return f"`match={args.mode}` is not available in this configuration."
    if args.grouping not in (None, GROUP_BY_DOCUMENT):
        return f'`group_by` takes "{GROUP_BY_DOCUMENT}" or nothing.'
    if args.grouping and args.mode != "meaning":
        return (
            '`group_by="document"` groups a ranked search. The exact and regex modes already end with '
            "every matching file and its count."
        )
    if args.stemmed and args.mode != "exact":
        return '`stemmed` finds inflected forms in a literal search: pass it with `match="exact"`.'
    return None


def ranked_refusal(args: SearchArgs) -> str | None:
    """The sentence refusing an unknown mode or a `context` on a ranked search, or ``None``."""
    if args.mode != "meaning":
        return (
            '`match` must be "meaning" (ranked by what a passage says), "exact" (every literal occurrence) '
            'or "regex" (every match of a pattern).'
        )
    if args.context not in (None, ""):
        return (
            '`context` shows lines around a hit, and only `match="exact"` or `match="regex"` '
            "has hits to show them around."
        )
    return None


class KnowledgeSearch:
    """The search behind `knowledge_search`, bound to its retriever and its models once at startup."""

    def __init__(
        self,
        config: Any,
        retriever: Any,
        *,
        rerank_llm: Any = None,
        requery_llm: Any = None,
        cross_encoder: Any = None,
    ) -> None:
        self.config = config
        self.retriever = retriever
        self.rerank_llm = rerank_llm
        self.requery_llm = requery_llm
        self.cross_encoder = cross_encoder
        self.top_k = config.top_k
        self.max_per_document = config.max_chunks_per_document
        self.drop_noise = noise_filter_enabled(config.drop_ocr_noise)

    @property
    def reranks(self) -> bool:
        return self.rerank_llm is not None or self.cross_encoder is not None

    async def search(self, query: str, *, path: str | None = None, **arguments: Any) -> str:
        """One call, recorded as a row in the Herleitung (ADR-0132); the arguments are the tool's own."""
        if path is not None and str(path).strip():
            try:
                arguments["shelf"], arguments["folder"], arguments["file_name"] = path_scope(
                    str(path), arguments["shelf"], arguments["folder"], arguments["file_name"]
                )
            except ValueError as refusal:
                # Refused before it searched, and still a call the reader sees: an error row that names no folder.
                ActionRow("search", **search_row_fields(query, arguments["match"], None, None, None)).finish("error")
                return str(refusal)
        outcome = ActionOutcome()
        row = ActionRow(
            "search",
            **search_row_fields(
                query, arguments["match"], arguments["folder"], arguments["file_name"], arguments["shelf"]
            ),
        )
        try:
            result = await self._answer(outcome, query=query, **arguments)
        except BaseException:
            row.finish("error")
            raise
        # A call that returned without searching (a refusal, a bad argument) counted nothing: an error row.
        outcome.settle(row, default="error")
        return result

    async def _answer(self, outcome: ActionOutcome, **arguments: Any) -> str:
        # `conclusion` never reaches here. It is a checkpoint channel, not a
        # retrieval parameter: the agent node reads it off the tool CALL before
        # this runs, and a sentence that changed the result would make the
        # Herleitung a cause instead of a record of one.
        args = parse_args(**arguments)
        if isinstance(args, str):
            return args
        # Platform-tunable counts (Platform → Retrieval), resolved per call so
        # an admin save takes effect without a redeploy; fail-open to the YAML
        # build-time values.
        from aiq_agent.common.retrieval_settings import get_retrieval_setting

        from .browse import entries_on_shelf

        budgets = (
            get_retrieval_setting("knowledge.top_k", self.top_k),
            get_retrieval_setting("knowledge.max_chunks_per_document", self.max_per_document),
        )
        base_collection = search_scope.resolve_base_collection(self.config)
        targets, refusal = entries_on_shelf(self._collections(base_collection), args.shelf)
        refusal = refusal or mode_refusal(args, self.config.match_modes)
        if refusal:
            return refusal
        if args.mode in LITERAL_MODES:
            return await self._literal(outcome, args, targets)
        refusal = ranked_refusal(args)
        if refusal:
            return refusal
        if args.folder:
            targets = await self._in_folder(args.folder, targets)
            if not targets:
                return (
                    f"No file in scope is filed in the folder {args.folder!r}. "
                    "`list_files` shows the folders that exist and what is in them."
                )
        return await RankedSearch(self, outcome, args, targets, base_collection, budgets).answer()

    def _collections(self, base_collection: str) -> list:
        """The authorized set first, then without the shelves this turn did not ask for.

        Resolve stays a ceiling; restriction is one call site. The session
        collection holds this conversation's UI uploads.
        """
        try:
            ctx = Context.get()
            session_collection = ctx.conversation_id if ctx else None
        except Exception:
            session_collection = None
        return search_scope.restrict_scope_to_turn(
            search_scope.resolve_scoped_collections(self.config, session_collection, base_collection)
        )

    async def _literal(self, outcome: ActionOutcome, args: SearchArgs, targets: list) -> str:
        from aiq_agent.common.action_rows import emit_literal_search

        from .browse import exact_search

        # A literal search is a navigate move (ADR-0127); the tool step cannot say so, this record does.
        emit_literal_search(args.mode)
        return await exact_search(
            targets,
            args.query,
            search_config=self.config,
            retriever=self.retriever,
            file_name=args.file_name,
            folder=args.folder,
            doc_class=args.doc_class,
            title_contains=args.title_contains,
            filters=args.filters,
            regex_mode=args.mode == "regex",
            context=args.context,
            stemmed=bool(args.stemmed),
            shelf=None,  # already applied to ``targets``
            outcome=outcome,
        )

    async def _in_folder(self, folder: str, targets: list) -> list:
        """The collections that file something in ``folder`` (or under it); narrowed BEFORE ranking.

        It used to be a post-filter over the top `3 × top_k` of the whole
        shelf, so a folder whose passages ranked below that pool came back
        empty while holding exactly what was asked. The post-filter in
        `apply_agent_filters` stays as the backstop.
        """
        from .browse import _files_by_collection

        folder_files = (
            await _files_by_collection(self.config, file_name=None, folder=folder, doc_class=None, title_contains=None)
            or {}
        )
        return [entry for entry in targets if folder_files.get(entry.collection)]


def path_scope(
    path: str, shelf: str | None, folder: str | None, file_name: str | None
) -> tuple[str | None, str | None, str | None]:
    """``knowledge_search(path=…)`` as the shelf, folder and file it compiles to (ADR-0133); explicit ones win.

    The scope ``grep`` reads for the same path: the mount is the shelf, the folder part the folder, a leaf
    the file (``Plan.pdf.md`` is ``Plan.pdf``). Raises ``ValueError`` with the refusal for a path that is
    not canonical or names no place.
    """
    from aiq_agent.common.estate_paths import MOUNT_SHELVES
    from aiq_agent.common.estate_paths import PathRefused
    from aiq_agent.common.estate_paths import file_name_candidates
    from aiq_agent.common.estate_paths import parse_estate_path

    try:
        parsed = parse_estate_path(path)
    except PathRefused as refusal:
        raise ValueError(str(refusal)) from refusal
    if parsed.path == "/":
        return shelf, folder, file_name
    if parsed.mount is None or parsed.mount == "drafts":
        raise ValueError(
            f'"{path}" is no place knowledge_search reads: /project/, /office/, /chat/, /law/oib/ or a folder in one.'
        )
    shelf_value = {"office_shelf": "office"}.get(MOUNT_SHELVES[parsed.mount], MOUNT_SHELVES[parsed.mount])
    leaf_file = file_name_candidates(parsed.leaf)[0] if parsed.leaf else None
    return shelf or shelf_value, folder or (parsed.folder or None), file_name or leaf_file


def search_row_fields(
    query: str, match: str | None, folder: str | None, file_name: str | None, shelf: str | None
) -> dict[str, str | None]:
    """The Herleitung row of a search call, from its own arguments: what, how, where (ADR-0132)."""
    mode = (match or "meaning").strip().lower()
    return {
        "query": (query or "").strip(),
        "mode": mode if mode in {"meaning", "exact", "regex"} else None,
        "target": (folder or "").strip().strip("/") or (file_name or "").strip() or None,
        "shelf": (shelf or "").strip().lower() or None,
    }
