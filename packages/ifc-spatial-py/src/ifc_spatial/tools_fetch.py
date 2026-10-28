"""Reading a model the caller names by URL or by bytes: the guarded redirect and the size bound."""

from __future__ import annotations

import base64
import binascii
import ipaddress
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from ifc_spatial.tools_constants import _UNREACHABLE_TEXT
from ifc_spatial.tools_constants import ALLOW_PRIVATE_URLS_ENV
from ifc_spatial.tools_constants import MAX_DOWNLOAD_BYTES
from ifc_spatial.tools_types import ToolError

# `env`, not `envelope`: `envelope.py` is the ANSWER CONTRACT (`Answer`,
# `computed`, `undecidable`) and `envelope_geometry.py` is the thermal envelope.
# Two unrelated meanings of one word, one of which is imported from below.


def _refuse_unroutable_destination(url: str) -> None:
    """Refuse a URL that resolves anywhere but the public internet.

    The scheme check this replaces stopped ``file://`` and stopped nothing else.
    ``http://169.254.169.254/latest/meta-data/`` passed it, and so did
    ``http://127.0.0.1:9200/``, ``http://10.0.0.5/`` and every other address
    reachable from wherever this process happens to sit. That is the whole of
    SSRF: the URL comes from an agent, the connection comes from the server, and
    the server's network position is the thing being borrowed.

    ``mcp_server``'s docstring gives the host authentication and tenancy. This
    is neither, and the host cannot add it: by the time a request leaves this
    process the destination is already decided.

    **What this does not close.** The name is resolved here and resolved again
    by the socket, so a DNS entry that answers with a public address once and a
    private one a moment later gets through (rebinding). Closing it means
    pinning the resolved IP through the connection, which for TLS means owning
    SNI and certificate verification by hand — a larger and more fragile piece
    of code than the hole it shuts, in a tool whose supported path is ``path``.
    Stated rather than hidden.
    """
    if os.environ.get(ALLOW_PRIVATE_URLS_ENV, "").strip().lower() in ("1", "true", "yes"):
        return

    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme.lower() not in ("http", "https"):
        raise ToolError("url muss mit http:// oder https:// beginnen")
    host = parsed.hostname
    if not host:
        raise ToolError("url nennt keinen Host")
    try:
        port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    except ValueError:
        raise ToolError("url nennt keinen gültigen Port") from None

    try:
        infos = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError:
        raise ToolError(_UNREACHABLE_TEXT) from None
    if not infos:
        raise ToolError(_UNREACHABLE_TEXT)

    for info in infos:
        address = ipaddress.ip_address(info[4][0])
        # ``::ffff:127.0.0.1`` is loopback wearing an IPv6 hat, and a check that
        # only reads the outer form lets it through.
        address = getattr(address, "ipv4_mapped", None) or address
        if not address.is_global or address.is_multicast:
            raise ToolError(
                "url zeigt auf eine Adresse außerhalb des öffentlichen Netzes (loopback, privat, "
                "link-local oder multicast). Diese Quelle wird nicht abgerufen — Datei lokal ablegen "
                "und path verwenden."
            )


class _GuardedRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Every hop is a new destination, and every hop is checked like the first.

    A public URL that answers ``302 Location: http://169.254.169.254/…`` is the
    standard way past a guard that only reads what the caller typed, and urllib
    follows redirects by default.
    """

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001, D102
        _refuse_unroutable_destination(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_opener = urllib.request.build_opener(_GuardedRedirectHandler)


def _read_source(args: dict[str, Any]) -> bytes:
    url = str(args.get("url") or "").strip()
    if url:
        _refuse_unroutable_destination(url)
        try:
            with _opener.open(url, timeout=60) as response:  # noqa: S310 — destination checked above
                data = response.read(MAX_DOWNLOAD_BYTES + 1)
        except ToolError:
            # A refused redirect hop. It is already the sentence the agent needs.
            raise
        except urllib.error.HTTPError as error:
            # The status IS safe to name: the guard has already established that
            # this host is on the public internet, so its status code says
            # nothing about our network position that the host does not tell
            # anyone who asks. It is also the one detail that makes an expired
            # presigned URL (403) diagnosable instead of mysterious.
            raise ToolError(f"Modell konnte nicht geladen werden: HTTP {error.code}") from None
        except Exception:  # noqa: BLE001
            raise ToolError(_UNREACHABLE_TEXT) from None
        if len(data) > MAX_DOWNLOAD_BYTES:
            raise ToolError(
                f"Modell ist größer als {MAX_DOWNLOAD_BYTES // (1024 * 1024)} MB — lokal ablegen und path verwenden"
            )
        return data
    encoded = str(args.get("base64") or "").strip()
    if encoded:
        try:
            return base64.b64decode(encoded, validate=True)
        except binascii.Error, ValueError:
            raise ToolError("base64 ist nicht dekodierbar") from None
    raise ToolError("Eine Quelle angeben: path, url oder base64")
