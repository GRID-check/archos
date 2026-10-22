"""The open-archive cache: a held archive is never closed under its reader; a hit is only the URL's own object."""

from __future__ import annotations

import threading

import pytest

from aiq_api.mail_archive import archives


class FakeArchive:
    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.closed = False

    def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def fake_open(monkeypatch):
    opened: list[FakeArchive] = []

    def open_archive(_file):
        archive = FakeArchive()
        opened.append(archive)
        return archive

    monkeypatch.setattr(archives, "open_archive", open_archive)
    monkeypatch.setattr(archives, "_ensure_janitor", lambda: None)
    archives.reset_open_archives()
    yield opened
    archives.reset_open_archives()


STORE = "http://seaweedfs:8333/grid-documents"


def url(name: str, signature: str = "sig") -> str:
    return f"{STORE}/org/{name}.pst?X-Amz-Signature={signature}"


def test_an_archive_is_reused_by_its_object_across_presigns(fake_open):
    with archives.use_archive(url("o1/a", "first"), 10) as first:
        pass
    with archives.use_archive(url("o1/a", "second"), 10) as second:
        assert second is first
    assert len(fake_open) == 1


def test_another_object_is_never_served_from_the_cache(fake_open):
    """A URL to one object never reads an archive opened for another, whatever key the caller sends."""
    with archives.use_archive(url("o1/a"), 10) as first:
        pass
    with archives.use_archive(url("o2/b"), 10) as second:
        assert second is not first
    assert len(fake_open) == 2


def test_eviction_passes_over_an_archive_in_use_and_its_last_holder_closes_it(fake_open):
    with archives.use_archive(url("held"), 10) as held:
        for name in ("a", "b", "c"):
            with archives.use_archive(url(name), 10):
                pass
        assert held.closed is False
    # Past capacity and released: the next eviction may now take it.
    with archives.use_archive(url("d"), 10):
        pass
    assert sum(1 for archive in fake_open if not archive.closed) <= archives.MAX_OPEN


def test_idle_archives_are_closed_after_the_idle_window(fake_open, monkeypatch):
    with archives.use_archive(url("k"), 10) as archive:
        pass
    archives._close_idle(archives.time.monotonic() + archives.IDLE_SECONDS + 1)
    assert archive.closed is True


def test_a_caller_naming_another_offices_key_gets_its_own_object_through_the_route(fake_open, monkeypatch):
    """C2's finding: the cache was keyed by the caller's ``key``, so a token holder could send another
    office's storage key with a presigned URL to any object of its own and be served that office's
    open archive. Through the route, the second request must open its own object."""
    from fastapi import APIRouter
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from aiq_api.mail_archive.reader import MessagePage
    from aiq_api.routes import mail_archive as route

    monkeypatch.setenv("GRID_INTERNAL_API_TOKEN", "token")
    monkeypatch.setenv("SEAWEED_ENDPOINT", "http://seaweedfs:8333")
    monkeypatch.setattr(FakeArchive, "page", lambda self, start, limit: MessagePage((), None, 0), raising=False)
    router = APIRouter()
    route.add_mail_archive_routes(router)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    victim_key = "org/o1/mail-import/i1/archive.pst"

    for name in ("o1/mail-import/i1/archive", "o2/mail-import/i9/mine"):
        response = client.post(
            "/v1/mail-archive/messages",
            json={"archive": {"key": victim_key, "url": url(name), "size": 10}, "start": 0},
            headers={"x-grid-internal-token": "token"},
        )
        assert response.status_code == 200

    assert len(fake_open) == 2
