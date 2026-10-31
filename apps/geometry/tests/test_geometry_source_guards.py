"""Defence in depth around a signed source: whose key signed it, and what the fetch will reach.

The signature says the BFF authorized the bytes; these say that even so the service reaches only its
object store, directly, for the object that was authorized, and that a sources pair and a
request-context envelope can never stand in for each other.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import http.server
import json
import threading
import time
from collections.abc import Iterator

import pytest
from geometry_service import fetch
from geometry_service.fetch import SourceRefused
from geometry_service.fetch import fetch_source
from geometry_service.signed_sources import sources_key
from geometry_service.signed_sources import verified_sources

from agent.knowledge import ifc_spatial_client as spatial
from agent.project_context import RequestContext

SECRET = "guard-test-secret"  # pragma: allowlist secret
BODY = b"ISO-10303-21;\nEND-ISO-10303-21;\n"


class _Store(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802 - the stdlib's name
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data/")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("ETag", '"etag-1"')
        self.send_header("Content-Length", str(len(BODY)))
        self.end_headers()
        self.wfile.write(BODY)

    def log_message(self, *_args) -> None:
        pass


@pytest.fixture
def store(monkeypatch) -> Iterator[str]:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Store)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_address[1]}"
    monkeypatch.setenv(fetch.ENDPOINT_ENV, origin)
    yield origin
    server.shutdown()


class TestFetch:
    def test_the_object_store_s_object_is_fetched(self, store) -> None:
        assert fetch_source({"url": f"{store}/documents/m.ifc", "etag": "etag-1"}) == BODY

    @pytest.mark.parametrize(
        "url",
        [
            "http://169.254.169.254/latest/meta-data/",
            "http://127.0.0.1:1/other-port",
            "file:///etc/passwd",
            "ftp://x/y",
        ],
    )
    def test_another_host_port_or_scheme_is_refused_without_a_request(self, store, url) -> None:
        with pytest.raises(SourceRefused):
            fetch_source({"url": url, "etag": "etag-1"})

    def test_a_redirect_is_refused_not_followed(self, store) -> None:
        with pytest.raises(SourceRefused):
            fetch_source({"url": f"{store}/redirect", "etag": "etag-1"})

    def test_an_object_changed_since_it_was_authorized_is_refused(self, store) -> None:
        with pytest.raises(SourceRefused, match="changed"):
            fetch_source({"url": f"{store}/documents/m.ifc", "etag": "etag-0"})

    def test_a_model_over_the_admission_limit_is_refused(self, store, monkeypatch) -> None:
        monkeypatch.setattr(spatial, "MAX_MODEL_BYTES", 8)
        with pytest.raises(spatial.ModelTooLargeError):
            fetch_source({"url": f"{store}/documents/m.ifc", "etag": "etag-1"})
        with pytest.raises(spatial.ModelTooLargeError):
            fetch_source({"url": f"{store}/documents/m.ifc", "etag": "etag-1", "bytes": 10_000})

    def test_without_a_configured_store_nothing_is_fetched(self, monkeypatch) -> None:
        monkeypatch.delenv(fetch.ENDPOINT_ENV, raising=False)
        with pytest.raises(SourceRefused):
            fetch_source({"url": "http://seaweedfs:8333/documents/m.ifc"})


def _pair(payload: dict, key: bytes) -> tuple[str, str]:
    raw = json.dumps(payload).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("="), hmac.new(key, raw, hashlib.sha256).hexdigest()


class TestKeySeparation:
    @pytest.fixture(autouse=True)
    def _token(self, monkeypatch) -> None:
        monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)

    def _context(self, issued_at: int) -> RequestContext:
        return RequestContext(organization_id="org", user_id="user", issued_at=issued_at)

    def test_an_envelope_signature_does_not_verify_as_sources(self) -> None:
        now = int(time.time() * 1000)
        payload = {
            "kind": "model-sources",
            "organizationId": "org",
            "userId": "user",
            "issuedAt": now,
            "exp": now + 60_000,
            "modelId": "m",
            "op": "boxes",
            "sources": {"m": {"url": "http://store/m"}},
        }
        context = self._context(now)
        envelope_signed = _pair(payload, SECRET.encode())  # signed as an envelope is: with the token itself
        assert verified_sources(*envelope_signed, context, model_id="m", op="boxes") == {}
        properly_signed = _pair(payload, sources_key(SECRET))
        assert set(verified_sources(*properly_signed, context, model_id="m", op="boxes")) == {"m"}

    def test_a_sources_pair_does_not_verify_as_an_envelope(self) -> None:
        now = int(time.time() * 1000)
        payload = {"kind": "model-sources", "organizationId": "org", "userId": "user", "issuedAt": now}
        header, signature = _pair(payload, sources_key(SECRET))
        assert RequestContext.from_envelope(header, signature, SECRET) is None
