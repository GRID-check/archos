"""The agent's one client of the BFF's internal routes (``/api/internal/*``, ``/api/mcp``).

Every call this tier makes to the BFF goes out through :func:`send` (or the
:func:`get_json` / :func:`post_json` / :func:`request_json` wrappers), which own
the four things each caller used to copy:

* **Where.** :func:`internal_base_url`: ``FRONTEND_INTERNAL_URL``, else
  ``FRONTEND_URL``, else ``http://frontend:3000``. Every deployment sets the
  first (compose and Pulumi); the second is a local-dev convenience older
  clients honoured, kept so nobody's ``.env`` stops working.
* **The service credential.** ``INTERNAL_API_TOKEN`` in
  :data:`INTERNAL_TOKEN_HEADER`. No token, no request: the call raises
  :class:`BffNotConfiguredError` before anything leaves the process, because an
  empty token is refused by the BFF anyway and a request without one only
  turns a configuration fault into a misleading 401.
* **No redirects, no proxies, HTTP only.** A 3xx from an internal route means
  an auth middleware intercepted the call (AuthKit sending it to a sign-in
  page); following it would drop the body, the envelope and the token, or
  hand the token to wherever ``Location`` points. The refusal names the status
  and never the destination. The opener is built from a bare
  ``OpenerDirector``, so it carries no ``FileHandler`` (a misconfigured base
  URL cannot read ``file:///``) and no ``ProxyHandler`` (the token never
  travels through an egress proxy an environment variable configured; the BFF
  is always in-cluster or loopback).
* **Errors.** Every failure is a :class:`BffError`. Each domain client
  subclasses it with its own name (``FilingError``, ``TurnContextError``, …),
  so a caller's ``except`` keeps working and a caller that only needs "the BFF
  did not answer" can catch the base.

The signed request-context envelope is echoed, never signed
(``packages/agent/src/aiq_agent/tools/AGENTS.md``): :class:`SignedEnvelope` carries the two
strings the BFF minted and :meth:`SignedEnvelope.headers` forwards them
byte-for-byte.

Tests fake the transport at ONE place: ``bff_http._opener`` (the attribute or
its ``open``). :func:`send` reads the module global at call time, so either
patch reaches every client. ``packages/agent/tests/common/test_bff_http_ratchet.py``
keeps a second redirect guard, base-URL read or token header from appearing
anywhere else.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

#: In-cluster base URL of the BFF. Set by every deployment.
INTERNAL_URL_ENV = "FRONTEND_INTERNAL_URL"
#: Second choice, for a local setup that names only the public URL.
FALLBACK_URL_ENV = "FRONTEND_URL"
#: The compose and Kubernetes service name, when neither is set.
DEFAULT_BASE_URL = "http://frontend:3000"

#: The shared service secret (the BFF signs request-context envelopes with it too).
INTERNAL_TOKEN_ENV = "INTERNAL_API_TOKEN"
INTERNAL_TOKEN_HEADER = "X-Internal-Token"
REQUEST_CONTEXT_HEADER = "X-Request-Context"
REQUEST_CONTEXT_SIGNATURE_HEADER = "X-Request-Context-Sig"


def internal_base_url() -> str:
    """The BFF's base URL, without a trailing slash."""
    url = os.environ.get(INTERNAL_URL_ENV) or os.environ.get(FALLBACK_URL_ENV) or DEFAULT_BASE_URL
    return url.rstrip("/")


def internal_token() -> str | None:
    """The service token, or ``None`` when it is unset or empty."""
    return os.environ.get(INTERNAL_TOKEN_ENV) or None


class BffError(RuntimeError):
    """A call to the BFF failed. ``status`` is the HTTP status when there was one, ``code`` the BFF's error code."""

    def __init__(self, message: str, *, status: int | None = None, code: str | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


class BffNotConfiguredError(BffError):
    """No service token: nothing was sent."""


class BffUnreachableError(BffError):
    """The request did not complete: connection, DNS, timeout, or a body that could not be read."""


class BffMalformedResponseError(BffError):
    """The BFF answered 2xx with a body that is not JSON."""


class BffRefusedError(BffError):
    """The BFF answered with a non-2xx status (a 3xx included). ``body`` is its JSON error envelope, or ``{}``."""

    def __init__(self, message: str, *, status: int, body: dict[str, Any]) -> None:
        code = body.get("code")
        super().__init__(message, status=status, code=code if isinstance(code, str) else None)
        self.status: int = status
        self.body = body

    @property
    def error_text(self) -> str | None:
        """The envelope's ``error`` sentence (``{error, code, details}``, ``lib/api/handler.ts``), when non-blank."""
        error = self.body.get("error")
        return error if isinstance(error, str) and error.strip() else None


@dataclass(frozen=True)
class SignedEnvelope:
    """The turn's request-context envelope as the BFF minted it. Both halves, or this is not one."""

    header: str
    signature: str

    def headers(self) -> dict[str, str]:
        """The two headers that say who this is, forwarded exactly as they arrived."""
        return {REQUEST_CONTEXT_HEADER: self.header, REQUEST_CONTEXT_SIGNATURE_HEADER: self.signature}


@dataclass(frozen=True)
class BffResponse:
    """A 2xx answer: its status, content type and raw body."""

    status: int
    content_type: str
    body: bytes
    #: The raw ``Server-Timing`` header, empty when the route sends none.
    server_timing: str = ""

    def json(self) -> Any:
        """The body parsed as JSON. An empty body is not JSON either: raises :class:`BffMalformedResponseError`."""
        try:
            return json.loads(self.body.decode("utf-8"))
        except (ValueError, UnicodeDecodeError) as exc:
            raise BffMalformedResponseError(
                "the BFF answered with a body that is not JSON", status=self.status
            ) from exc


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    """Raise on every redirect, naming the status and never the destination."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, ARG002
        raise urllib.error.HTTPError(req.full_url, code, "unexpected redirect from an internal route", headers, fp)


def _build_opener() -> urllib.request.OpenerDirector:
    """HTTP(S) only, redirects refused, no proxies. A bare director: ``build_opener`` would add the defaults back."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.HTTPHandler,
        urllib.request.HTTPSHandler,
        _RefuseRedirects,
        urllib.request.HTTPDefaultErrorHandler,
        urllib.request.HTTPErrorProcessor,
        urllib.request.UnknownHandler,
    ):
        opener.add_handler(handler())
    return opener


_opener = _build_opener()


def _error_envelope(exc: urllib.error.HTTPError) -> dict[str, Any]:
    try:
        raw = exc.read()
        payload = json.loads(raw.decode("utf-8", errors="replace")) if raw else None
    except Exception:  # noqa: BLE001 - the body may be empty, consumed, unreadable or not JSON
        return {}
    return payload if isinstance(payload, dict) else {}


def send(
    method: str,
    path: str,
    *,
    timeout: float,
    body: Any = None,
    query: Mapping[str, str] | None = None,
    headers: Mapping[str, str] | None = None,
) -> BffResponse:
    """One request to ``path`` on the BFF, with the service token. Blocking: call it off the event loop.

    ``body`` is sent as JSON when it is not ``None``. ``headers`` are added to
    (and may not replace) the token. Raises :class:`BffNotConfiguredError`,
    :class:`BffRefusedError` or :class:`BffUnreachableError`.
    """
    token = internal_token()
    if not token:
        raise BffNotConfiguredError(f"{INTERNAL_TOKEN_ENV} is not configured")
    url = f"{internal_base_url()}{path}"
    if query:
        url = f"{url}?{urllib.parse.urlencode(query)}"
    sent: dict[str, str] = {"Content-Type": "application/json"} if body is not None else {}
    sent.update(headers or {})
    sent[INTERNAL_TOKEN_HEADER] = token
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(url, data=data, headers=sent, method=method)
    try:
        with _opener.open(request, timeout=timeout) as response:
            raw = response.read()
            status = getattr(response, "status", None)
            response_headers = getattr(response, "headers", None)
            content_type = response_headers.get("Content-Type", "") if response_headers is not None else ""
            server_timing = response_headers.get("Server-Timing", "") if response_headers is not None else ""
    except urllib.error.HTTPError as exc:
        raise BffRefusedError(
            f"{path} refused the call ({exc.code})", status=exc.code, body=_error_envelope(exc)
        ) from exc
    except Exception as exc:  # noqa: BLE001 - urllib raises a wide family; every one means "no answer"
        raise BffUnreachableError(f"{path} could not be reached ({type(exc).__name__})") from exc
    status = status if isinstance(status, int) else 200
    if not 200 <= status < 300:
        raise BffRefusedError(f"{path} refused the call ({status})", status=status, body={})
    return BffResponse(
        status=status,
        content_type=content_type if isinstance(content_type, str) else "",
        body=raw if isinstance(raw, bytes) else b"",
        server_timing=server_timing if isinstance(server_timing, str) else "",
    )


def request_json(
    method: str,
    path: str,
    *,
    timeout: float,
    body: Any = None,
    query: Mapping[str, str] | None = None,
    headers: Mapping[str, str] | None = None,
) -> Any:
    """:func:`send`, and the answer parsed as JSON."""
    return send(method, path, timeout=timeout, body=body, query=query, headers=headers).json()


def get_json(
    path: str, *, timeout: float, query: Mapping[str, str] | None = None, headers: Mapping[str, str] | None = None
) -> Any:
    """``GET`` ``path`` and parse the answer. See :func:`send`."""
    return request_json("GET", path, timeout=timeout, query=query, headers=headers)


def post_json(path: str, body: Any, *, timeout: float, headers: Mapping[str, str] | None = None) -> Any:
    """``POST`` ``body`` as JSON to ``path`` and parse the answer. See :func:`send`."""
    return request_json("POST", path, timeout=timeout, body=body, headers=headers)
