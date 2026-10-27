"""The cross-project lookups' client: ``POST /api/internal/cross-project/{search,projects,brief}``.

Nothing here decides access. The BFF reads the acting person out of the signed
request-context envelope this module forwards byte-for-byte, builds that
person's pinned session, decides which projects and folders are in reach,
records what it hands out on the conversation, and refuses a conversation that
is not its asker's alone (ADR-0054 §4, ADR-0055, ADR-0094). Echo, never sign:
see ``src/aiq_agent/tools/AGENTS.md``.

The request bodies are described once, in zod (``frontends/ui/src/lib/cross-project/types.ts``),
and exported as JSON Schema (``frontends/ui/tests/fixtures/cross-project.schema.json``);
``tests/aiq_agent/tools/cross_project/test_wire_contract.py`` validates the
bodies this tool builds against that file. There is no Pydantic twin.
"""

from __future__ import annotations

import logging
from typing import Any

from aiq_agent.common import bff_http
from aiq_agent.common.bff_http import SignedEnvelope

logger = logging.getLogger(__name__)

SEARCH_PATH = "/api/internal/cross-project/search"
PROJECTS_PATH = "/api/internal/cross-project/projects"
BRIEF_PATH = "/api/internal/cross-project/brief"

#: A search authorizes up to forty projects on the BFF, ranks their collections
#: in one grouped query and joins each project's hits to its rows. Generous, so
#: a slow page is an answer rather than a timeout the model retries.
REQUEST_TIMEOUT_SECONDS = 30


class CrossProjectLookupError(bff_http.BffError):
    """The route refused, or could not be reached. ``status`` and ``code`` say which."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message, status=status, code=code)


def post_lookup(path: str, payload: dict[str, Any], envelope: SignedEnvelope) -> dict[str, Any]:
    """POST one lookup and return the parsed body. Blocking; call through ``asyncio.to_thread``.

    Raises :class:`CrossProjectLookupError` for every refusal and transport failure, with
    the BFF's ``error`` sentence when it sent one: the refusals the reader must
    hear (a shared chat) are worded there, in German.
    """
    try:
        body = bff_http.post_json(path, payload, timeout=REQUEST_TIMEOUT_SECONDS, headers=envelope.headers())
    except bff_http.BffNotConfiguredError as exc:
        raise CrossProjectLookupError(str(exc)) from exc
    except bff_http.BffRefusedError as exc:
        raise CrossProjectLookupError(
            exc.error_text or f"the lookup was refused ({exc.status})", status=exc.status, code=exc.code
        ) from exc
    except bff_http.BffError as exc:
        logger.warning("Cross-project lookup %s failed", path, exc_info=True)
        raise CrossProjectLookupError("the lookup could not be reached") from exc
    if not isinstance(body, dict):
        raise CrossProjectLookupError("the lookup answered with something that is not an object")
    return body
