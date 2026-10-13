"""Whether the model answering this turn can see an image.

``view_knowledge_image`` and the canvas's ``look`` answer with an image content
block. A model that takes text only cannot read one: OpenRouter refuses the
NEXT model call of the turn ("no endpoints found that support image input"), so
a single look would end the turn with an error instead of an answer. The admin
picker only requires image input of the ingestion VLM group
(``frontends/ui/src/lib/model-config/agent-groups.ts``); the chat group stays
open to text-only models on purpose, because an office that chose one should
still get answers. So the two tools ask here first and, for a model that cannot
see, answer with a sentence that says so.

Two halves:

* **Which model.** Piloti's tools node binds the turn's resolved chat model id
  around its tool calls (:func:`chat_model_scope`), because the tools run as
  children of that node and a value set beside the LLM call would die at the
  node boundary (``agents/piloti/AGENTS.md``).
* **What it accepts.** OpenRouter's public model catalog
  (``GET /api/v1/models``, ``architecture.input_modalities``), read at most
  once per :data:`_CATALOG_TTL_SECONDS` and cached by model id for the process.
  No tenant data is sent or kept: the request carries nothing, and the cache
  holds the catalog's modality flags.

Unknown is not "no". A model the catalog does not list (a BYOK endpoint, a
self-hosted model), an unreachable catalog, or no model bound at all answers
``None``, and the tools then behave as they did before this check: they send
the image. Only a catalog that says the model takes no images withholds one.
"""

from __future__ import annotations

import contextvars
import logging
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

logger = logging.getLogger(__name__)

#: OpenRouter's public catalog. A GET with no body and no credential: it sends no
#: tenant content, so it is not a model call and does not go through the seam.
CATALOG_URL = "https://openrouter.ai/api/v1/models"

#: The catalog changes when a provider adds a model, not per turn.
_CATALOG_TTL_SECONDS = 6 * 3600
#: A failed read is not retried on every image of every turn.
_FAILURE_TTL_SECONDS = 300
_TIMEOUT_SECONDS = 5.0

_lock = threading.Lock()
#: Model id (without a ``:variant`` suffix) -> takes image input. Process-lifetime,
#: keyed by model id, holds no tenant data (``src/aiq_agent/AGENTS.md``).
_catalog: dict[str, bool] = {}
_catalog_read_at = 0.0
_catalog_failed_at = 0.0

_turn_model: contextvars.ContextVar[str | None] = contextvars.ContextVar("grid_turn_chat_model", default=None)


def model_name_of(llm: Any) -> str | None:
    """The model id a LangChain chat model sends, or None when it names none as a string."""
    for attribute in ("model_name", "model"):
        value = getattr(llm, attribute, None)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


@contextmanager
def chat_model_scope(model_id: str | None) -> Iterator[None]:
    """Bind the turn's chat model for the tool calls run inside this block."""
    token = _turn_model.set(model_id)
    try:
        yield
    finally:
        _turn_model.reset(token)


def current_chat_model() -> str | None:
    """The chat model bound for the running tool call, or None outside Piloti's tools node."""
    return _turn_model.get()


def _modalities(entry: dict[str, Any]) -> list[str] | None:
    architecture = entry.get("architecture")
    value = architecture.get("input_modalities") if isinstance(architecture, dict) else None
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else None


def parse_catalog(body: object) -> dict[str, bool]:
    """``{model id: takes images}`` from a catalog response. Pure; entries without modalities are left out."""
    data = body.get("data") if isinstance(body, dict) else None
    parsed: dict[str, bool] = {}
    for entry in data if isinstance(data, list) else []:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        modalities = _modalities(entry)
        if modalities:
            parsed[entry["id"]] = "image" in modalities
    return parsed


def _fetch_catalog() -> dict[str, bool] | None:
    try:
        import httpx

        response = httpx.get(CATALOG_URL, timeout=_TIMEOUT_SECONDS)
        response.raise_for_status()
        return parse_catalog(response.json())
    except Exception:  # noqa: BLE001 - unknown is the fail-open answer
        logger.warning("The model catalog could not be read; image input is assumed", exc_info=True)
        return None


def _refreshed_catalog() -> dict[str, bool]:
    global _catalog, _catalog_read_at, _catalog_failed_at
    now = time.monotonic()
    with _lock:
        fresh = _catalog and now - _catalog_read_at < _CATALOG_TTL_SECONDS
        backing_off = now - _catalog_failed_at < _FAILURE_TTL_SECONDS
        if fresh or backing_off:
            return _catalog
        fetched = _fetch_catalog()
        if fetched is None:
            _catalog_failed_at = now
            return _catalog
        _catalog, _catalog_read_at = fetched, now
        return _catalog


def model_accepts_images(model_id: str | None) -> bool | None:
    """Whether ``model_id`` takes image input: True, False, or None when nobody can say. Blocking."""
    if not model_id:
        return None
    catalog = _refreshed_catalog()
    base = model_id.split(":", 1)[0]
    return catalog.get(model_id, catalog.get(base))


def turn_model_accepts_images() -> bool | None:
    """:func:`model_accepts_images` for the turn's bound chat model. Blocking; call off the event loop."""
    return model_accepts_images(current_chat_model())


def reset_catalog_cache() -> None:
    """Forget the catalog. Test-only."""
    global _catalog, _catalog_read_at, _catalog_failed_at
    with _lock:
        _catalog, _catalog_read_at, _catalog_failed_at = {}, 0.0, 0.0
