"""What of a chunk's metadata is embedded and shown to the model, and what stays stored only.

LlamaIndex renders a node's metadata into the text it embeds and charges it against
the chunk size. :func:`stamp_chunk_metadata` sets a file's documents up so only the
keys people ask by are rendered, and the header always fits the splitter.
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


#: Metadata keys that exist for filtering, citation or diagnostics and must never be
#: embedded or shown to the LLM.
#:
#: LlamaIndex prepends the whole metadata dict to a node's text before embedding
#: (``MetadataMode.EMBED``) unless a key is excluded, and nothing here set any
#: exclusions -- so every OIB chunk's vector was shifted by ``file_size: 1975942``, and
#: table/image/drawing chunks additionally carried row counts and pixel dimensions.
#: A byte count and a render's pixel width carry no retrieval signal; they are also
#: charged against the chunk's token budget, because ``SentenceSplitter`` subtracts the
#: metadata header from ``chunk_size`` before splitting.
#:
#: ``file_path`` is the sharpest one: ``SimpleDirectoryReader`` sets it to the ingest
#: temp file, so non-PDF uploads embedded a random ``/tmp/tmpk3n8w1qz.docx`` -- different
#: on every re-upload of the same document.
#:
#: ``drawing_type``/``drawing_scale`` are excluded because the VLM caption already states
#: both verbatim in the chunk body; embedding them again only doubles their weight.
#: ``file_name``, ``page_label``, ``content_type`` and ``doc_class`` stay: those are what
#: users actually ask by, and they are the closest thing this corpus has to a context
#: header.
EMBED_EXCLUDED_METADATA_KEYS = (
    "file_size",
    "file_path",
    "table_index",
    "rows",
    "cols",
    "image_index",
    "image_format",
    "image_width",
    "image_height",
    # Where the stored raster lives (image_store.py): an object key and an
    # ordinal, addressing for the view tool and not a word of what the image
    # shows.
    "image_key",
    "stored_image_index",
    "drawing_type",
    "drawing_scale",
    # A photo's camera facts (photo_facts.py): metadata to filter and show by,
    # not words of what the photo depicts.
    "captured_at",
    "camera",
    # The v2 structured payload: multi-KB JSON for the detail view / later
    # re-mapping, plus per-sheet segment bookkeeping. Embedding any of it
    # would double the segment text's weight (drawing_data restates the chunk
    # body as JSON) and burn the chunk's token budget on braces.
    "drawing_data",
    "segment_index",
    "segment_count",
    # Provenance (ADR-0054). Excluded from both renderings and STORED anyway:
    # exclusion governs what the splitter renders into the embedded text and
    # the LLM header, not what the vector store keeps, and retrieval reads
    # these off `Chunk.metadata` directly. A release date and a producer id
    # carry no retrieval signal, and embedding an approver's name would shift
    # every chunk of the document toward whoever signed it — the German line
    # the reader and the model see is built once, in the grounding block, from
    # the stored fields.
    "authored_by",
    "approved_by",
    "approved_at",
    "producer",
)


def provenance_from_config(config: dict) -> dict[str, str]:
    """The provenance keys a job config carries, or an empty dict.

    Read through ``agent.common.provenance`` rather than by picking four
    strings out of ``config``, so the ingest side and the retrieval side spell
    the keys once. Empty for every human document, which is what makes the
    stamping loop a no-op for them.
    """
    from agent.common.provenance import parse_agent_provenance
    from agent.common.provenance import provenance_metadata

    provenance = parse_agent_provenance(config)
    return provenance_metadata(provenance) if provenance else {}


def apply_metadata_exclusions(document: Any) -> None:
    """Exclude non-semantic metadata from a document's embed and LLM renderings.

    Extends rather than replaces any existing exclusions -- ``SimpleDirectoryReader``
    already populates ``excluded_embed_metadata_keys`` on the non-PDF path, and
    clobbering it would re-embed the reader's own bookkeeping.

    Both lists are set because the splitter budgets on whichever of the two renderings
    is longer, so excluding from only one would leave the token cost in place.
    """
    for attribute in ("excluded_embed_metadata_keys", "excluded_llm_metadata_keys"):
        existing = list(getattr(document, attribute, None) or [])
        merged = existing + [key for key in EMBED_EXCLUDED_METADATA_KEYS if key not in existing]
        try:
            setattr(document, attribute, merged)
        except AttributeError, ValueError:  # pragma: no cover - non-llama-index document
            logger.debug("Could not set %s on %r", attribute, type(document).__name__)


#: Keys rendered into the header whatever its length: what users ask by, short by
#: construction, and ``file_name`` is how a file's chunks are found and deleted.
_ALWAYS_RENDERED_METADATA_KEYS = frozenset({"file_name", "page_label", "content_type", "doc_class"})


def _rendered_metadata_tokens(document: Any) -> int:
    """Tokens of the longer of the document's two metadata renderings, as the splitter counts them."""
    from llama_index.core.schema import MetadataMode
    from llama_index.core.utils import get_tokenizer

    tokenizer = get_tokenizer()
    return max(len(tokenizer(document.get_metadata_str(mode=mode))) for mode in (MetadataMode.EMBED, MetadataMode.LLM))


def _fit_rendered_metadata(document: Any, limit: int) -> list[str]:
    """Stop rendering the longest free-text keys until the metadata header fits ``limit`` tokens.

    ``SentenceSplitter`` prepends the rendered metadata to every chunk and raises when it
    alone exceeds the chunk size, which fails the whole file, not the one chunk. Keys
    such as ``clause_title``/``clause_path`` carry text read out of the document, so their
    length is the document's to choose. The value stays stored for display and
    filtering; it only leaves the embedded header, and the chunk body already starts
    with the same breadcrumb. Returns the keys dropped, for the caller to log.

    The header can stay over ``limit`` when only ``_ALWAYS_RENDERED_METADATA_KEYS``
    remain; the caller measures and reports that (``stamp_chunk_metadata``).
    """
    if limit <= 0:
        raise ValueError(f"Metadata token budget must be positive, got {limit}")
    dropped: list[str] = []
    while _rendered_metadata_tokens(document) > limit:
        rendered = [
            key
            for key in document.metadata
            if key not in _ALWAYS_RENDERED_METADATA_KEYS
            and (key not in document.excluded_embed_metadata_keys or key not in document.excluded_llm_metadata_keys)
        ]
        if not rendered:
            break
        key = max(rendered, key=lambda name: len(str(document.metadata[name])))
        for attribute in ("excluded_embed_metadata_keys", "excluded_llm_metadata_keys"):
            excluded = getattr(document, attribute)
            if key not in excluded:
                excluded.append(key)
        dropped.append(key)
    return dropped


def stamp_chunk_metadata(
    documents: list[Any], *, doc_class: Any, provenance: dict[str, Any], chunk_size: int, file_name: str
) -> None:
    """Stamp ``doc_class`` and provenance on a file's documents and fit each header to half of ``chunk_size``.

    ``chunk_size`` is the one this job's splitter runs with (the job config's, which
    ``_ingest_job`` also sets on ``Settings``), not the ingestor's default: budgeted
    against a larger default, a header passes here and still fails the file in the
    splitter. Logs once per file, not once per page: the keys left out of the header,
    and a header still over budget with only the always-rendered keys left.
    """
    limit = chunk_size // 2
    unrendered: set[str] = set()
    longest = 0
    for doc in documents:
        doc.metadata["doc_class"] = doc_class
        doc.metadata.update(provenance)
        apply_metadata_exclusions(doc)
        unrendered.update(_fit_rendered_metadata(doc, limit))
        longest = max(longest, _rendered_metadata_tokens(doc))
    if unrendered:
        logger.warning(
            "Metadata too long to embed in %s; left out of the header: %s", file_name, ", ".join(sorted(unrendered))
        )
    if longest > limit:
        # "tokens" here are tokenizer counts; the line logs a file name and integers only.
        # nosemgrep: python.lang.security.audit.logging.logger-credential-leak.python-logger-credential-disclosure
        logger.warning(
            "Metadata header of %s stays at %d tokens with only %s rendered, over its %d-token budget "
            "(chunk size %d); past the chunk size the splitter fails the file",
            file_name,
            longest,
            ", ".join(sorted(_ALWAYS_RENDERED_METADATA_KEYS)),
            limit,
            chunk_size,
        )
