"""The embedding client and the identity its vectors are written under.

Every embedding client in the process is built by :func:`make_embed_model`, and a
collection records which one wrote it (:func:`embed_fingerprint_metadata`), so a
model swap fails loudly instead of retrieving from a foreign vector space.
"""

import hashlib
import json
from typing import Any

from aiq_agent.common.cost_tracking import USAGE_ROLE_EMBEDDING
from aiq_agent.common.cost_tracking import meter_openai_client

from .env import env_float
from .env import env_int

# @environment_variable GRID_EMBED_BATCH_SIZE
# @category Knowledge Layer
# @type int
# @default 64
# @required false
# Texts per embedding API request. The llama-index default (10) serialises far
# too many round-trips on large documents — a 500-chunk PDF costs ~50
# sequential HTTP calls. Every OpenAI-compatible embeddings endpoint accepts
# far more per call (OpenAI 2048, NVIDIA NIM 259); 64 is conservative.
EMBED_BATCH_SIZE = max(1, env_int("GRID_EMBED_BATCH_SIZE", 64))


# @environment_variable GRID_EMBED_TIMEOUT_SECONDS
# @category Knowledge Layer
# @type float
# @default 60
# @required false
# Per-request timeout on the embeddings client. The client's own defaults are
# 120s with five retries, so a hung embeddings endpoint could hold the query
# embedding, and with it the whole chat turn, for ten minutes; retrieval fails
# open everywhere else, and this is what lets it fail open here. Two retries
# stay for the transient 5xx a batch of EMBED_BATCH_SIZE texts occasionally
# meets; 60s covers such a batch with room.
EMBED_TIMEOUT_SECONDS = max(1.0, env_float("GRID_EMBED_TIMEOUT_SECONDS", 60.0))


EMBED_MAX_RETRIES = 2


# @environment_variable GRID_QUERY_EMBED_TIMEOUT_SECONDS
# @category Knowledge Layer
# @type float
# @default 3
# @required false
# Per-request timeout for the QUERY embeddings a chat turn waits on, as opposed
# to the ingestion batches above. A query is one short text: 0.66 s at the
# median across 276 live calls (September 2026 census), but 8.5 s at p99 and
# 11.8 s at worst, and a turn makes 5-15 of them before the model starts, so a
# single tail request held a whole turn for 11 s. At 3 s the client gives up on
# that one and retries (EMBED_MAX_RETRIES), which a fresh request answers in
# well under a second: the worst turn pays ~4 s instead of 11.
QUERY_EMBED_TIMEOUT_SECONDS = max(0.5, env_float("GRID_QUERY_EMBED_TIMEOUT_SECONDS", 3.0))


#: Collection-metadata keys recording which embedding produced a collection's vectors
#: (``qdrant.schema.EMBED_IDENTITY_KEYS``): stamped when a Qdrant collection is
#: created, compared before every write and every read of it.
EMBED_FINGERPRINT_KEY = "aiq:embed_fingerprint"


EMBED_MODEL_KEY = "aiq:embed_model"


def embed_fingerprint(model: str, base_url: str) -> str:
    """Stable digest of the embedding identity a collection's vectors were written with.

    A same-dimension model swap, or a repointed base URL, produces no error at
    all, only silently wrong retrieval at a score distribution that looks
    normal; this digest is what makes it fail loudly
    (``qdrant.schema.identity_mismatch``). ``base_url`` is part of the
    identity, not decoration: the same model name served by
    a different provider is a different vector space. The model default
    (``openai/text-embedding-3-large`` on OpenRouter) once differed from the code default
    (``nvidia/llama-nemotron-embed-vl-1b-v2`` on NVIDIA), so a deployment path that missed
    the env var wrote foreign vectors into a shared collection; a repointed base URL can
    still do the same.
    """
    payload = json.dumps({"model": model, "base_url": (base_url or "").rstrip("/")}, sort_keys=True)
    return hashlib.sha256(payload.encode()).hexdigest()[:16]


def embed_fingerprint_metadata(model: str, base_url: str) -> dict[str, str]:
    """Collection metadata recording the embedding identity, human-readable digest first."""
    return {EMBED_FINGERPRINT_KEY: embed_fingerprint(model, base_url), EMBED_MODEL_KEY: model}


def resolve_embed_api_key(base_url: str, model: str) -> str:
    """Resolve the embeddings API key through the shared credential resolver.

    Chain: explicit ``GRID_EMBED_API_KEY`` → provider inference from
    ``base_url`` (``OPENROUTER_API_KEY`` for the default OpenRouter host).
    Inference only selects the KEY for the configured embeddings endpoint; it
    NEVER changes ``base_url`` (embeddings need an embeddings-capable endpoint,
    so the caller keeps its configured base).

    BYOK is intentionally NOT wired here, but no longer for want of an org id:
    ``/v1/ingest`` forwards ``x-grid-organization-id`` into the ingest thread's
    job config, which is what lets :func:`resolve_vlm_credential` reach BYOK on
    the same pipeline. The blocker is the endpoint — a BYOK credential names a
    chat-completions base URL, and embeddings need an embeddings-capable one, so
    there is nothing to point this at yet. Known follow-up — see docs.
    """
    from aiq_agent.common.credential_resolution import resolve_llm_credential

    return resolve_llm_credential(
        primary_env="GRID_EMBED_API_KEY",
        default_base_url=base_url,
        default_model=model,
        organization_id=None,
    ).api_key


def make_embed_model(*, base_url: str, model: str, api_key: str, **kwargs: Any):
    """The embedding client. Every one in the process is built here.

    Its HTTP clients pin every OpenRouter request to zero-data-retention
    endpoints (``openrouter.PLATFORM_FIXED``): the embedding model is the
    platform's, not an organization's choice, and document chunks and queries
    of every tenant pass through it. ``NVIDIAEmbedding`` hard-codes its own
    ``extra_body``, so the pin rides on the transport instead.
    """
    from llama_index.embeddings.nvidia import NVIDIAEmbedding

    from aiq_agent.common.openrouter import pinned_async_http_client
    from aiq_agent.common.openrouter import pinned_http_client

    embed_model = NVIDIAEmbedding(
        base_url=base_url,
        model=model,
        api_key=api_key,
        http_client=pinned_http_client(),
        async_http_client=pinned_async_http_client(),
        **kwargs,
    )
    # Metered: llama-index calls the OpenAI SDK itself, so no callback sees an
    # embedding; its usage lands in whatever tracker is active (ingest job or turn).
    meter_openai_client(getattr(embed_model, "_client", None), role=USAGE_ROLE_EMBEDDING)
    return embed_model
