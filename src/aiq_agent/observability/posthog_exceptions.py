"""Caught-and-logged exceptions to PostHog error tracking (ADR-0100).

## Why a logging handler

Grid catches its exceptions and logs them (``logger.exception`` in the job
worker, the job runner, the stage runner, the chat socket). They never reach
``sys.excepthook``, which is all the SDK's own autocapture sees, so PostHog
would hear about almost nothing. The one place every one of those calls passes
through is the logging system, so a handler on the root logger reports the lot
and no call site has to remember: the same reasoning that put presigned-URL
scrubbing on the handlers (``common.log_redaction``) rather than at call sites.
posthog-python ships integrations for Django, Flask, Celery and ASGI, none for
``logging``, so this handler is the one piece that stays ours; the budget,
the client and the release link are the SDK's.

This replaces the path ERROR log, OTLP collector, err2issue, GitHub issue
(ADR-0031). That path stays until the PostHog destination has proven itself;
both see the same record.

## What counts

An ``ERROR`` or above record that carries ``exc_info``. An ERROR with no
exception is a message, not an exception, and PostHog groups by stack.

## What is sent

The exception itself (type, message, stack: the SDK builds the ``$exception``
event), and beside it the logger name, the formatted log message, the log call
site, and, when the error happened inside a traced run, the trace id as
``$ai_trace_id`` and ``langfuse_trace_id``. Langfuse exports that trace to
PostHog as ``langfuse observation`` events, so an issue in Error tracking links
to the trace that produced it
(https://posthog.com/docs/ai-observability/link-error-tracking). The
environment and the service are the client's super properties, on every event,
and the release is the SDK's ``$release_id``, read from ``POSTHOG_RELEASE_ID``,
which the deploy sets to the PostHog release it resolved for the backend image.

The event is personless: the log record names no user, and looking one up on an
error path would be a second thing that can fail. Tenant text never travels:
the message is scrubbed of presigned URLs, and the SDK client scrubs the
exception text again (``posthog_client._scrub_event``) because
``str(httpx.HTTPStatusError)`` embeds the request URL.

## Guards

* **Recursion.** The SDK logs its own failures on the ``posthog`` logger at
  ERROR with ``exc_info``; reporting those would report the reporter. Records
  from ``posthog*`` and from ``aiq_agent.observability.posthog*`` are skipped.
* **Volume.** PostHog's free tier is 100K exceptions a month and a hot loop
  (a retry that fails every 50 ms) is the way to spend it in an afternoon. Each
  fingerprint (exception type, logger, innermost frame) has a small token
  bucket, and one process-wide bucket caps the total. Over budget, the record
  is dropped silently from PostHog's side; it is still logged everywhere else,
  so nothing is lost, only not counted again. The buckets are the SDK's own
  ``BucketedRateLimiter``, the one posthog-js and posthog-node use; the
  arithmetic is next to the constants. Its buckets are never evicted, which is
  fine here because the keys are code sites, not data: a process has as many
  as it has places that log an exception.
* **Never raises.** A handler that raises inside ``logger.exception`` would
  turn a logged error into a second one in the caller's ``except`` block.

Off by default: :func:`install` does nothing while PostHog is not configured.
"""

from __future__ import annotations

import logging
import os
import time
from collections.abc import Callable
from types import TracebackType

from aiq_agent.common.log_redaction import scrub_presigned_urls
from aiq_agent.observability import posthog_client

#: Per fingerprint: a burst of 3, then one more every 5 minutes. A hot loop on
#: one site therefore costs at most 3 + 288/day = ~9K a month, so ten distinct
#: sites failing around the clock still sit under the free tier.
FINGERPRINT_BURST = 3
FINGERPRINT_REFILL_SECONDS = 300.0
#: Across the process: a burst of 20, then one a minute (43K a month at the
#: very worst, one replica). It is the backstop for many different fingerprints
#: failing at once, which the per-fingerprint buckets cannot see.
GLOBAL_BURST = 20
GLOBAL_REFILL_SECONDS = 60.0
_GLOBAL_KEY = "process"

MESSAGE_MAX = 500
#: Loggers that must never be reported: the SDK's own, and this package's
#: PostHog modules (they log at DEBUG, but the rule should not depend on that).
_SKIPPED_LOGGER_PREFIXES = ("posthog", "aiq_agent.observability.posthog")


def _innermost_frame(traceback: TracebackType | None) -> str:
    """``file:function:line`` of where the exception was raised, or ``""``."""
    frame = None
    while traceback is not None:
        frame = traceback
        traceback = traceback.tb_next
    if frame is None:
        return ""
    code = frame.tb_frame.f_code
    return f"{os.path.basename(code.co_filename)}:{code.co_name}:{frame.tb_lineno}"


def fingerprint(record: logging.LogRecord) -> str:
    """What makes two records the same incident: exception type, logger, innermost frame."""
    exc_type, _, traceback = record.exc_info or (None, None, None)
    type_name = f"{exc_type.__module__}.{exc_type.__qualname__}" if exc_type else ""
    return f"{type_name}|{record.name}|{_innermost_frame(traceback)}"


def _message(record: logging.LogRecord) -> str:
    try:
        text = record.getMessage()
    except Exception:  # noqa: BLE001 - a malformed format string must not lose the exception
        text = str(record.msg)
    return scrub_presigned_urls(text)[:MESSAGE_MAX]


def _current_trace_id() -> str | None:
    """The Langfuse trace id of the run this thread is in, or None outside one."""
    try:
        from aiq_agent.observability.turn_trace import current_trace_id_hex

        return current_trace_id_hex()
    except Exception:  # noqa: BLE001 - no NAT context is not an error
        return None


def event_properties(record: logging.LogRecord) -> dict[str, str]:
    """The properties beside the exception. Absent values are omitted."""
    properties = {
        "source": "python-logging",
        "logger": record.name,
        "log_level": record.levelname,
        "log_message": _message(record),
        "log_origin": f"{record.pathname}:{record.lineno}",
    }
    # Environment and service are the client's super properties, and the
    # release is the SDK's ``$release_id``: neither is repeated here.
    trace_id = _current_trace_id()
    if trace_id:
        properties["$ai_trace_id"] = trace_id
        properties["langfuse_trace_id"] = trace_id
    return properties


class PosthogExceptionHandler(logging.Handler):
    """Reports ERROR records that carry an exception to PostHog, within a budget."""

    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        super().__init__(level=logging.ERROR)
        self._per_fingerprint = posthog_client.rate_limiter(FINGERPRINT_BURST, FINGERPRINT_REFILL_SECONDS, clock)
        self._process = posthog_client.rate_limiter(GLOBAL_BURST, GLOBAL_REFILL_SECONDS, clock)

    def _admit(self, key: str) -> bool:
        """Spend one token from the fingerprint's bucket, then the process's."""
        if self._per_fingerprint.consume_rate_limit(key):
            return False
        return not self._process.consume_rate_limit(_GLOBAL_KEY)

    def emit(self, record: logging.LogRecord) -> None:
        if not record.exc_info or record.exc_info[1] is None:
            return
        if record.name.startswith(_SKIPPED_LOGGER_PREFIXES):
            return
        if not self._admit(fingerprint(record)):
            return
        try:
            posthog_client.capture_exception(record.exc_info[1], properties=event_properties(record))
        except Exception:  # noqa: BLE001 - see "Never raises" in the module header
            return


def install(logger: logging.Logger | None = None) -> PosthogExceptionHandler | None:
    """Attach the handler to ``logger`` (root by default); None while PostHog is off.

    Idempotent: a second call finds the handler the first left and returns it,
    which is what lets the NAT logging method and the API plugin both call it.
    """
    if not posthog_client.posthog_enabled():
        return None
    target = logger if logger is not None else logging.getLogger()
    for handler in target.handlers:
        if isinstance(handler, PosthogExceptionHandler):
            return handler
    handler = PosthogExceptionHandler()
    target.addHandler(handler)
    return handler
