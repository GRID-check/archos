"""The one way this service reads a model's bytes: from its object store, as signed, and no further.

Defence in depth beside the signature (``signed_sources.py``): even a correctly signed source is
fetched only when

* its URL's scheme, host and port are the configured internal object store's
  (``SEAWEED_ENDPOINT``, the endpoint the BFF presigns against), so a signed URL can never make
  this pod reach anything else in the cluster;
* the store answers it directly: the opener has no redirect handler, so a 3xx is a refusal;
* it arrives within :data:`DOWNLOAD_TIMEOUT_SECONDS` and :data:`ifc_spatial_client.MAX_MODEL_BYTES`;
* the object's ETag is the one the BFF signed, when it signed one, so bytes replaced between the
  BFF's HEAD and this GET fail instead of being cached under the old key.
"""

from __future__ import annotations

import gzip
import os
import urllib.parse
import urllib.request
from typing import Any

from agent.knowledge import ifc_spatial_client as spatial
from agent.knowledge.bim_query import BimQueryUnavailableError

DOWNLOAD_TIMEOUT_SECONDS = 120
ENDPOINT_ENV = "SEAWEED_ENDPOINT"


class SourceRefused(BimQueryUnavailableError):
    """A signed source this service will not fetch: another host, a redirect, a changed object."""


def _origin(url: str) -> tuple[str, str, int] | None:
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return None
    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError:
        return None
    return parsed.scheme, parsed.hostname.lower(), port


def allowed_origin() -> tuple[str, str, int] | None:
    """The object store's origin from ``SEAWEED_ENDPOINT``; None when it is not configured."""
    configured = os.environ.get(ENDPOINT_ENV, "").strip()
    return _origin(configured) if configured else None


def _no_redirect_opener() -> urllib.request.OpenerDirector:
    """HTTP(S) only and no redirect handler: a 3xx surfaces as an error, never as a second request."""
    opener = urllib.request.OpenerDirector()
    for handler in (
        urllib.request.HTTPHandler,
        urllib.request.HTTPSHandler,
        urllib.request.HTTPDefaultErrorHandler,
        urllib.request.HTTPErrorProcessor,
        urllib.request.UnknownHandler,
    ):
        opener.add_handler(handler())
    return opener


_OPENER = _no_redirect_opener()


def fetch_source(source: dict[str, Any]) -> bytes:
    """The object's bytes, or :class:`SourceRefused` / ``ModelTooLargeError`` saying which bound held."""
    url = source.get("url")
    expected = allowed_origin()
    if not isinstance(url, str) or expected is None or _origin(url) != expected:
        raise SourceRefused("the model source is not on this service's object store")
    limit = spatial.MAX_MODEL_BYTES
    declared = source.get("bytes")
    if isinstance(declared, (int, float)) and declared > limit:
        raise spatial.ModelTooLargeError(int(declared), limit)
    try:
        with _OPENER.open(url, timeout=DOWNLOAD_TIMEOUT_SECONDS) as response:
            etag = (response.headers.get("ETag") or "").strip('"')
            data = response.read(limit + 1)
            encoding = (response.headers.get("Content-Encoding") or "").lower()
    except Exception as exc:  # noqa: BLE001 - a 3xx, a 4xx, a timeout: all mean "not these bytes"
        raise SourceRefused(f"the model source could not be fetched ({type(exc).__name__})") from None
    signed = source.get("etag")
    if signed and etag != signed:
        raise SourceRefused("the model file changed after it was authorized; ask again")
    if len(data) > limit:
        raise spatial.ModelTooLargeError(len(data), limit)
    return gzip.decompress(data) if "gzip" in encoding else data
