"""The one PostHog client this process captures through (the PostHog switch, ADR-0098).

Every Python path that sends something to PostHog (LLM analytics events, runtime
scores as ``$ai_metric``, captured exceptions) goes through :func:`capture` or
:func:`capture_exception` here, so there is one place that decides whether
PostHog is on, which host it talks to and what it must never send.

Availability is capability, the same rule as ``langfuse_scores``: without
``POSTHOG_HOST`` and ``POSTHOG_PROJECT_TOKEN`` every call is a no-op. The
deployment injects both only where the PostHog switch is on, so a stack that has
not opted in sends nothing.

Two defaults are deliberate and not configurable from the call site:

* GeoIP lookup is off. The caller is a server in our cluster, so PostHog would
  geolocate the data centre, not the user, and the property would mislead.
* Exception autocapture is off. Grid catches and logs its exceptions rather
  than letting them reach ``sys.excepthook``, so autocapture would see almost
  nothing; the logging handler in ``posthog_exceptions`` captures them instead.
* Presigned URLs are scrubbed from every event's text (``_scrub_event``): an
  exception message can embed one, and a PostHog event is retained off-cluster.

Calls never raise and never block a turn: the SDK queues events on its own
consumer thread and :func:`shutdown` flushes it at process exit.
"""

from __future__ import annotations

import atexit
import logging
import os
from threading import Lock
from typing import TYPE_CHECKING
from typing import Any

from aiq_agent.common.log_redaction import scrub_presigned_urls

if TYPE_CHECKING:
    from posthog import Posthog

logger = logging.getLogger(__name__)

HOST_ENV = "POSTHOG_HOST"
PROJECT_TOKEN_ENV = "POSTHOG_PROJECT_TOKEN"  # pragma: allowlist secret

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
            )
            atexit.register(shutdown)
        _resolved = True
        return _client


def capture(
    event: str,
    *,
    distinct_id: str | None,
    properties: dict[str, Any] | None = None,
    groups: dict[str, str] | None = None,
) -> bool:
    """Queue one event; whether it was queued. Never raises.

    ``distinct_id`` ``None`` sends a personless event (``$process_person_profile``
    false): a job or a system step with no user behind it must not mint a person.
    """
    client = get_client()
    if client is None:
        return False
    props = dict(properties or {})
    if distinct_id is None:
        props["$process_person_profile"] = False
    try:
        client.capture(event, distinct_id=distinct_id, properties=props, groups=groups)
    except Exception:
        logger.debug("Could not queue PostHog event %s", event, exc_info=True)
        return False
    return True


def capture_exception(
    exception: BaseException,
    *,
    distinct_id: str | None = None,
    properties: dict[str, Any] | None = None,
) -> bool:
    """Queue one ``$exception`` event; whether it was queued. Never raises."""
    client = get_client()
    if client is None:
        return False
    props = dict(properties or {})
    if distinct_id is None:
        props["$process_person_profile"] = False
    try:
        client.capture_exception(exception, distinct_id=distinct_id, properties=props)
    except Exception:
        logger.debug("Could not queue PostHog exception", exc_info=True)
        return False
    return True


def shutdown() -> None:
    """Flush queued events and stop the consumer thread. Safe to call twice."""
    client = _client
    if client is None:
        return
    try:
        client.shutdown()
    except Exception:
        logger.debug("PostHog shutdown failed", exc_info=True)


def reset_for_tests() -> None:
    """Forget the cached client so a test can change the environment."""
    global _client, _resolved
    with _client_lock:
        _client = None
        _resolved = False
