"""What a geometry call can end in besides an answer, and the answer's own shape."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from typing import Literal

#: The ``retryAfter`` a warming answer carries.
RETRY_AFTER_SECONDS = 10

CacheTier = Literal["A", "B", "cold"]


class GeometryWarming(Exception):
    """The model's index or parse is being built; ask again after ``retry_after`` seconds."""

    def __init__(self, retry_after: int = RETRY_AFTER_SECONDS) -> None:
        super().__init__("geometry_warming")
        self.retry_after = retry_after


class GeometryBusy(Exception):
    """This pod already has as many builds queued as it takes; ask again later."""

    def __init__(self, retry_after: int = RETRY_AFTER_SECONDS * 3) -> None:
        super().__init__("geometry_busy")
        self.retry_after = retry_after


class GeometryBuildFailed(Exception):
    """The model's last build failed within the negative-cache window; ``kind`` says how."""

    def __init__(self, kind: str, message: str) -> None:
        super().__init__(message)
        self.kind = kind


class GeometryTimeout(Exception):
    """The request's budget ran out before the operation could start."""


class GeometryModelUnresolved(Exception):
    """The BFF answered ``resolved: false``: no such model here, or it is not ready yet."""

    def __init__(self, reason: str, message: str) -> None:
        super().__init__(message)
        self.reason = reason


class GeometryRequestError(ValueError):
    """The request cannot be answered as asked (the engine's refusal, or an element with no box)."""


@dataclass(frozen=True)
class GeometryOutcome:
    """One answered operation, with the shape facts the trace and the BFF's span record."""

    op: str
    result: dict[str, Any]
    cache_tier: CacheTier
    ms: int
    elements: int
    truncated: bool
