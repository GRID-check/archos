"""Read the service headers under their names without the product's, beside the old ones.

The headers the BFF sends lose the product's name (`x-grid-budget` becomes
`x-budget`; docs/contributing/code-conventions.md#no-brand-names). The BFF and
this tier roll out side by side, and jobs queued before a deploy keep the
names they were stored with, so the move is expand, switch, contract:

- expand (#1333): this middleware copies a header that arrives under its new
  name onto its old one, so every reader here, still reading the old name, sees it;
- switch (the release after): the senders send the new names;
- contract (the release after that): the readers read the new names and this
  goes. The list of readers is in ``frontends/ui/src/lib/http/legacy-header-names.ts``.

A header already present under its old name is left as it is. Only the names
in ``SERVICE_HEADERS`` are copied: ``x-`` alone is every proxy's prefix. The
BFF's WebSocket proxy strips the same list from what a browser sends
(``apps/workspace/bff/proxy/ws-upgrade-headers.js``), and
``tests/test_legacy_headers.py`` holds the two lists equal.
"""

from __future__ import annotations

from starlette.types import ASGIApp
from starlette.types import Receive
from starlette.types import Scope
from starlette.types import Send

#: The service headers' new names, lower-case, as they arrive.
SERVICE_HEADERS: frozenset[bytes] = frozenset(
    name.encode("ascii")
    for name in (
        "x-answer-message-id",
        "x-budget",
        "x-collection-scope",
        "x-context-transport",
        "x-disabled-sources",
        "x-feature-memory-reflection",
        "x-internal-token",
        "x-locale",
        "x-model-overrides",
        "x-org-instructions",
        "x-organization-id",
        "x-project-context",
        "x-project-id",
        "x-project-memory",
        "x-request-context",
        "x-request-context-sig",
        "x-user-id",
    )
)


def legacy_name(name: bytes) -> bytes:
    """The old name of a service header: ``x-budget`` → ``x-grid-budget``."""
    return b"x-grid-" + name.removeprefix(b"x-")


def with_legacy_names(headers: list[tuple[bytes, bytes]]) -> list[tuple[bytes, bytes]]:
    """``headers`` plus an old-name copy of each service header that arrived only under its new name."""
    present = {name for name, _ in headers}
    added = [
        (legacy_name(name), value)
        for name, value in headers
        if name in SERVICE_HEADERS and legacy_name(name) not in present
    ]
    return headers + added if added else headers


class LegacyHeaderNamesMiddleware:
    """Pure ASGI, so it serves the chat WebSocket as well as HTTP."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] in ("http", "websocket"):
            scope = {**scope, "headers": with_legacy_names(list(scope.get("headers", [])))}
        await self.app(scope, receive, send)
