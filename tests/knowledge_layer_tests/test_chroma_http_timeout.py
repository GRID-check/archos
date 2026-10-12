"""The shared-Chroma client is bounded, and an unreachable Chroma is never "missing".

Both halves come from one night (2026-10-11/12) on which five nodes died:

- chromadb's HTTP client is built with ``httpx.Client(timeout=None)``. Requests
  on connections to Chroma pods whose node had died (no FIN, no RST) never
  returned, and the API's thread pool filled with them until a restart. The
  adapter now gives the session a timeout.
- ``get_collection`` answered None for EVERY failure, the same as "does not
  exist". During a Chroma outage the OIB sync read that as a wiped index and
  re-queued the whole base corpus. ``tests/test_oib_sync.py`` already covered the
  sync with a fake ingestor that RAISED; the real adapter did not, so the seam
  between them is what these tests pin.
"""

from __future__ import annotations

import inspect
import threading

import httpx
import pytest
from knowledge_layer.llamaindex import adapter as adapter_mod
from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

# ---------------------------------------------------------------- timeouts


class _FakeServer:
    def __init__(self) -> None:
        self._session = httpx.Client()


class _FakeHttpClient:
    def __init__(self, **kwargs) -> None:
        self.kwargs = kwargs
        self._server = _FakeServer()


@pytest.fixture
def fake_http_client(monkeypatch):
    import chromadb

    built: list[_FakeHttpClient] = []

    def http_client(**kwargs):
        client = _FakeHttpClient(**kwargs)
        built.append(client)
        return client

    monkeypatch.setattr(chromadb, "HttpClient", http_client)
    monkeypatch.setenv("AIQ_CHROMA_URL", "http://chroma:8000")
    return built


def test_the_shared_chroma_client_has_a_request_timeout(fake_http_client, tmp_path):
    client = adapter_mod._make_chroma_client(str(tmp_path))

    timeout = client._server._session.timeout
    assert timeout.read == adapter_mod._CHROMA_HTTP_TIMEOUT_SECONDS
    assert timeout.connect == adapter_mod._CHROMA_CONNECT_TIMEOUT_SECONDS


def test_the_request_timeout_is_configurable(fake_http_client, tmp_path, monkeypatch):
    monkeypatch.setenv("AIQ_CHROMA_HTTP_TIMEOUT_SECONDS", "30")

    timeout = adapter_mod._make_chroma_client(str(tmp_path))._server._session.timeout

    assert timeout.read == 30.0


def test_a_garbage_timeout_falls_back_instead_of_breaking_the_client(fake_http_client, tmp_path, monkeypatch):
    monkeypatch.setenv("AIQ_CHROMA_HTTP_TIMEOUT_SECONDS", "soon")

    timeout = adapter_mod._make_chroma_client(str(tmp_path))._server._session.timeout

    assert timeout.read == adapter_mod._CHROMA_HTTP_TIMEOUT_SECONDS


def test_chromadb_still_keeps_its_http_session_where_the_adapter_reaches_for_it():
    # The timeout is set on a private attribute because chromadb offers no setting
    # for it. If an upgrade renames ``_session``, this fails instead of the bound
    # silently disappearing.
    from chromadb.api.fastapi import FastAPI

    assert "self._session = httpx.Client(" in inspect.getsource(FastAPI.__init__)


# ------------------------------------------------- unreachable is not missing


class _Client:
    def __init__(self, error: BaseException) -> None:
        self._error = error

    def get_collection(self, name):  # noqa: ARG002 - signature parity
        raise self._error


def _ingestor(error: BaseException) -> LlamaIndexIngestor:
    ing = object.__new__(LlamaIndexIngestor)
    ing._lock = threading.RLock()
    ing._get_chroma_client = lambda: _Client(error)  # type: ignore[method-assign]
    return ing


def test_a_collection_chroma_says_does_not_exist_is_none():
    from chromadb.errors import NotFoundError

    ingestor = _ingestor(NotFoundError("Collection [oib_knowledge] does not exist"))

    assert ingestor.get_collection("oib_knowledge") is None


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError("[Errno 113] No route to host"),
        httpx.ReadTimeout("timed out"),
        ValueError("Could not connect to a Chroma server. Are you sure it is running?"),
    ],
)
def test_an_unreachable_chroma_raises_instead_of_reading_as_missing(error):
    with pytest.raises(type(error)):
        _ingestor(error).get_collection("oib_knowledge")


def test_a_client_that_cannot_be_built_raises_too():
    ing = object.__new__(LlamaIndexIngestor)
    ing._lock = threading.RLock()

    def unreachable():
        raise ValueError("Could not connect to a Chroma server. Are you sure it is running?")

    ing._get_chroma_client = unreachable  # type: ignore[method-assign]

    with pytest.raises(ValueError, match="Could not connect"):
        ing.get_collection("oib_knowledge")
