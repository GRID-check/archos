"""The seconds before a turn's first model call, one observation per phase.

A chat turn's trace showed the workflow root, then nothing for one to three
seconds, then the LangGraph run: the setup I/O, the checkpoint read and the
first-call work in the graph's first node had a row in the profiler waterfall
(``common.profiler``) and none in Langfuse, where the turn is analysed
(ADR-0089). A regression there was invisible until somebody felt it.

:func:`observed_phase` times a block and, when it ends, pushes one balanced
``FUNCTION`` step pair with the block's real start and end
(``retrieval_trace.emit_step_span``), so the phase is a ``CHAIN`` observation
under whatever step was open when it began, with its true latency. Emitting
both events at the end, not at the start, keeps the open-span stack untouched
while the block runs, so gathered branches running in parallel cannot nest
under each other.

The names are the profiler's (``setup.project_context``, ``setup.inventory``
...): one phase, one name, in both places. Input and output carry no turn
content, only the ``outcome`` (``ok``, ``error``, ``cancelled``) and what the
caller adds through the yielded dict (counts, flags). Never raises.
"""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import Iterator
from typing import Any

from aiq_agent.observability.retrieval_trace import emit_step_span


def now() -> float:
    """NAT's clock, the one its own steps are stamped with; wall time when NAT is absent."""
    try:
        from nat.utils.providers import current_time

        return current_time()
    except Exception:  # noqa: BLE001 - telemetry must never take a turn down
        import time

        return time.time()


@contextlib.contextmanager
def observed_phase(name: str, **facts: Any) -> Iterator[dict[str, Any]]:
    """Time the block as the observation ``name``; the yielded dict becomes its output.

    ``facts`` (scalars, never content) are the observation's input. A block
    that raises is recorded with ``outcome: error`` and the exception's type,
    and the exception goes on; a cancelled one with ``outcome: cancelled``.
    """
    started = now()
    outcome: dict[str, Any] = {}
    status = "ok"
    try:
        yield outcome
    except (asyncio.CancelledError, GeneratorExit):
        status = "cancelled"
        raise
    except BaseException as exc:
        status = "error"
        outcome["error"] = type(exc).__name__
        raise
    finally:
        ended = now()
        outcome = {"outcome": status, **outcome, "ms": round(1000 * (ended - started), 1)}
        emit_step_span(name, dict(facts), outcome, started_at=started, ended_at=ended)
