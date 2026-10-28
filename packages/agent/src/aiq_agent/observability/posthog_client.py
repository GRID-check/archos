"""The one PostHog client this process captures through (the PostHog switch, ADR-0100).

Every Python path that sends something to PostHog goes through :func:`capture`
or :func:`capture_exception` here, so there is one place that decides whether
PostHog is on, which host it talks to and what it must never send. LLM traces
and scores are not among them: they reach PostHog through Langfuse's export.

Availability is capability, the same rule as ``langfuse_scores``: without
``POSTHOG_HOST`` and ``POSTHOG_PROJECT_TOKEN`` every call is a no-op. The
deployment injects both only where the PostHog switch is on, so a stack that has
not opted in sends nothing.

What we leave to the SDK, because it already does it: ``capture`` and
``capture_exception`` never raise (both are ``no_throw``); an event without a
``distinct_id`` is personless (``$process_person_profile`` false); queued events
are flushed at exit by the SDK's own ``atexit`` hook. None of that is written
here. What is ours:

* GeoIP lookup is off. The caller is a server in our cluster, so PostHog would
  geolocate the data centre, not the user, and the property would mislead.
* Exception autocapture is off. Grid catches and logs its exceptions rather
  than letting them reach ``sys.excepthook``, so autocapture would see almost
  nothing; the logging handler in ``posthog_exceptions`` captures them instead.
* Presigned URLs are scrubbed from every event's text (``_scrub_event``): an
  exception message can embed one, and a PostHog event is retained off-cluster.
* Every event carries the deployment's ``environment`` and the emitting
  ``service`` as super properties, the same values the Langfuse traces carry.
* Frames under ``aiq_agent`` and ``aiq_api`` are in-app, so error tracking
  groups an issue by our frame rather than by the library frame that raised.

The exit flush is the SDK's: a bounded best-effort attempt of about a second,
so a pod killed mid-batch can lose its last few seconds of events. That is the
SDK's trade, so a PostHog outage never holds a pod's shutdown, and it is ours.
"""

from __future__ import annotations

import os
import time
from collections.abc import Callable
from threading import Lock
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.log_redaction import scrub_presigned_urls
from aiq_agent.observability import trace_context

if TYPE_CHECKING:
    from posthog import Posthog
    from posthog.bucketed_rate_limiter import BucketedRateLimiter

HOST_ENV = "POSTHOG_HOST"
PROJECT_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN"  # pragma: allowlist secret
#: Packages whose frames error tracking treats as ours.
IN_APP_MODULES = ["aiq_agent", "aiq_api"]

_client: Posthog | None = None
_client_lock = Lock()
_resolved = False


def _scrub_event(event: dict[str, Any]) -> dict[str, Any]:
    """The SDK's ``before_send``: no presigned URL leaves in an event's text.

    A presigned URL is a live credential (``common.log_redaction``), and
    ``str(httpx.HTTPStatusError)`` embeds one in the exception message the SDK
    reads straight off the exception object, which no logging filter ever sees.
    Applied to every event's string properties and to each ``$exception_list``
    entry's ``value``.
    """
    properties = event.get("properties")
    if not isinstance(properties, dict):
        return event
    for key, value in properties.items():
        if isinstance(value, str):
            properties[key] = scrub_presigned_urls(value)
    exceptions = properties.get("$exception_list")
    for item in exceptions if isinstance(exceptions, list) else []:
        if isinstance(item, dict) and isinstance(item.get("value"), str):
            item["value"] = scrub_presigned_urls(item["value"])
    return event


def super_properties() -> dict[str, str]:
    """What every event of this process carries. Absent values are omitted.

    ``environment`` is ``APP_ENV`` exactly as Langfuse files the traces
    (``trace_context``), and ``service`` is ``OTEL_SERVICE_NAME``, which tells
    the chat tier from the workers.
    """
    values = {
        "environment": trace_context.langfuse_environment(),
        "service": os.environ.get("OTEL_SERVICE_NAME", "").strip() or None,
    }
    return {key: value for key, value in values.items() if value}


def _settings() -> tuple[str, str] | None:
    host = os.environ.get(HOST_ENV, "").strip().rstrip("/")
    token = os.environ.get(PROJECT_TOKEN_ENV, "").strip()
    if not (host and token):
        return None
    return host, token


def posthog_enabled() -> bool:
    """Whether this process sends anything to PostHog: both settings reached it."""
    return _settings() is not None


def get_client() -> Posthog | None:
    """The process-wide client, built on first use; ``None`` while PostHog is off."""
    global _client, _resolved
    if _resolved:
        return _client
    with _client_lock:
        if _resolved:
            return _client
        settings = _settings()
        if settings is not None:
            from posthog import Posthog

            host, token = settings
            _client = Posthog(
                token,
                host=host,
                disable_geoip=True,
                enable_exception_autocapture=False,
                before_send=_scrub_event,
                super_properties=super_properties(),
                in_app_modules=IN_APP_MODULES,
            )
        _resolved = True
        return _client


def capture(
    event: str,
    *,
    distinct_id: str | None,
    properties: dict[str, Any] | None = None,
) -> bool:
    """Queue one event; whether the SDK admitted it. Never raises.

    ``distinct_id`` ``None`` is a personless event: a job or a system step with
    no user behind it must not mint a person. Tenancy travels as the
    ``organization_id`` property, not as a PostHog group: group analytics is a
    paid add-on, and ADR-0100 keeps to the free tier.
    """
    client = get_client()
    if client is None:
        return False
    return client.capture(event, distinct_id=distinct_id, properties=properties) is not None


def capture_exception(
    exception: BaseException,
    *,
    distinct_id: str | None = None,
    properties: dict[str, Any] | None = None,
) -> bool:
    """Queue one ``$exception`` event; whether the SDK admitted it. Never raises."""
    client = get_client()
    if client is None:
        return False
    return client.capture_exception(exception, distinct_id=distinct_id, properties=properties) is not None


def rate_limiter(burst: int, refill_seconds: float, clock: Callable[[], float] = time.monotonic) -> BucketedRateLimiter:
    """The SDK's keyed token bucket: ``burst`` events per key, then one per ``refill_seconds``.

    The same algorithm posthog-js and posthog-node use, so a budget reads the
    same in every runtime. Its arithmetic is not the obvious one: the call that
    empties a bucket is itself limited, and a refill of a single token admits
    nothing. So the bucket holds ``burst + 1`` and two tokens come back per
    interval, which admits exactly ``burst`` and then one per interval while
    the key keeps firing. Here rather than at the caller because it imports
    the SDK, which only this module does.
    """
    from posthog.bucketed_rate_limiter import BucketedRateLimiter

    return BucketedRateLimiter(burst + 1, 2, refill_seconds, clock=clock)


def reset_for_tests() -> None:
    """Forget the cached client so a test can change the environment."""
    global _client, _resolved
    with _client_lock:
        _client = None
        _resolved = False
