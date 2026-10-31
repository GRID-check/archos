"""The geometry service: its route's credentials and refusals, and the element index cache.

The engine is faked at its one adapter (``geometry_service.engine``), the model source at
``agent.knowledge.ifc_spatial_client`` (resolve and open), and the shared cache runs on its
per-process fallback. What is asserted is this service's own behaviour: who may call, which tier
answers, when a build happens and how often.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from geometry_service import engine
from geometry_service import index_cache
from geometry_service.app import GEOMETRY_PATH
from geometry_service.app import create_app

from agent.common import cache
from agent.common.envelope_auth import ENVELOPE_HEADER as REQUEST_CONTEXT_ENVELOPE_HEADER
from agent.common.envelope_auth import ENVELOPE_SIG_HEADER as REQUEST_CONTEXT_ENVELOPE_SIG_HEADER
from agent.knowledge import ifc_spatial_client as spatial

SECRET = "geometry-test-secret"  # pragma: allowlist secret
MODEL = "11111111-1111-4111-8111-111111111111"
BASE = "22222222-2222-4222-8222-222222222222"
GID = "2O2Fr$t4X7Zf8NOew3FLOH"
OTHER = "1hOSvn6df7F8_7GcBWlRGQ"


class FakeEngine(engine.GeometryEngine):
    def __init__(self) -> None:
        self.builds = 0

    def available(self) -> bool:
        return True

    def build_index(self, model: Any) -> Any:
        self.builds += 1
        return {"model": model, "boxes": {GID: [[0, 0, 0], [1, 2, 3]], OTHER: [[5, 5, 0], [6, 6, 1]]}}

    def index_to_json(self, index: Any) -> Any:
        return {"schema": 1, "boxes": index["boxes"]}

    def index_from_json(self, data: Any) -> Any:
        return {"model": None, "boxes": data["boxes"]}

    def element_boxes(self, index, ids):
        found = [
            {"globalId": g, "min": index["boxes"][g][0], "max": index["boxes"][g][1]}
            for g in ids
            if g in index["boxes"]
        ]
        return {
            "boxes": found,
            "missing": [{"globalId": g, "reason": "unknown"} for g in ids if g not in index["boxes"]],
        }

    def elements_within(self, index, box, ifc_types, limit):
        return {"box": box, "elements": [], "truncated": False}

    def neighbours(self, model, index, gid, gap):
        return {"neighbours": [{"globalId": OTHER, "distance": 0.0}], "model": model}

    def box_diff(self, base_index, index, ids):
        return {"changes": [{"globalId": GID, "kind": "unchanged"}]}


class Source:
    """The BFF's source route and the model download, counted."""

    def __init__(self) -> None:
        self.etag = "etag-1"
        self.downloads = 0
        self.resident: set[str] = set()
        self.gate = threading.Event()
        self.gate.set()

    def resolve(self, *, organization_id, project_id, model_id=None, model_name=None):
        return {
            "resolved": True,
            "model": {"modelId": model_id, "updatedAt": "t"},
            "source": {"etag": f"{model_id}:{self.etag}"},
        }

    def open_model(self, source):
        identity = spatial.source_identity(source)
        if identity not in self.resident:
            self.gate.wait(10)
            self.downloads += 1
            self.resident.add(identity)
        return identity

    def resident_model(self, source):
        identity = spatial.source_identity(source)
        return f"model:{identity}" if identity in self.resident else None


@pytest.fixture
def fake(monkeypatch):
    monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setattr(cache, "_get_client", lambda: None)
    cache.reset_local_store()
    source = Source()
    monkeypatch.setattr(spatial, "resolve_model_source", source.resolve)
    monkeypatch.setattr(spatial, "open_model", source.open_model)
    monkeypatch.setattr(spatial, "resident_model", source.resident_model)
    adapter = FakeEngine()
    previous = engine.set_for_tests(adapter)
    yield source, adapter
    source.gate.set()
    engine.set_for_tests(previous)


def _envelope(payload: dict) -> dict[str, str]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return {
        REQUEST_CONTEXT_ENVELOPE_HEADER: header,
        REQUEST_CONTEXT_ENVELOPE_SIG_HEADER: hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }


def _headers(**override: Any) -> dict[str, str]:
    payload = {"organizationId": "org", "userId": "user", "projectId": "project", "issuedAt": int(time.time() * 1000)}
    return {"x-internal-token": SECRET, **_envelope({**payload, **override})}


def _post(body: dict, headers: dict[str, str] | None = None):
    return TestClient(create_app()).post(GEOMETRY_PATH, json=body, headers=_headers() if headers is None else headers)


class TestRoute:
    def test_without_an_envelope_it_is_403_and_nothing_is_resolved(self, fake):
        source, _ = fake
        response = _post(
            {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}, {"x-internal-token": SECRET}
        )
        assert response.status_code == 403
        assert response.json()["detail"]["error"] == "context_envelope_required"
        assert source.downloads == 0

    def test_without_the_token_it_is_403(self, fake):
        response = _post(
            {"modelId": MODEL, "operation": {"op": "warm"}},
            _envelope({"organizationId": "o", "userId": "u", "issuedAt": int(time.time() * 1000)}),
        )
        assert response.status_code == 403

    def test_an_envelope_without_a_user_is_403(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "warm"}}, _headers(userId=None))
        assert response.status_code == 403

    def test_a_cold_model_answers_cold_then_from_tier_b(self, fake):
        source, adapter = fake
        body = {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}
        first = _post(body)
        assert first.status_code == 200, first.text
        assert first.json()["meta"]["cacheTier"] == "cold"
        assert first.json()["result"]["boxes"][0]["max"] == [1, 2, 3]
        second = _post(body)
        assert second.json()["meta"] | {"ms": 0} == {"cacheTier": "B", "elements": 1, "truncated": False, "ms": 0}
        assert (source.downloads, adapter.builds) == (1, 1)

    def test_a_tier_b_hit_downloads_nothing(self, fake):
        source, adapter = fake
        key = index_cache.index_key(MODEL, source.resolve(organization_id="org", project_id=None, model_id=MODEL))
        cache.set_json(key, {"schema": 1, "boxes": {GID: [[0, 0, 0], [1, 1, 1]]}}, 60)
        response = _post({"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}})
        assert response.json()["meta"]["cacheTier"] == "B"
        assert (source.downloads, adapter.builds) == (0, 0)

    def test_past_the_wait_it_is_409_warming_and_the_build_carries_on(self, fake, monkeypatch):
        source, adapter = fake
        monkeypatch.setattr(index_cache, "WAIT_SECONDS", 0.2)
        source.gate.clear()
        response = _post({"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}})
        assert response.status_code == 409
        assert response.json()["code"] == "geometry_warming"
        assert response.json()["retryAfter"] == index_cache.RETRY_AFTER_SECONDS
        assert response.headers["retry-after"] == str(index_cache.RETRY_AFTER_SECONDS)
        source.gate.set()
        deadline = time.monotonic() + 5
        while adapter.builds == 0 and time.monotonic() < deadline:
            time.sleep(0.02)
        time.sleep(0.05)
        assert (
            _post({"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}).json()["meta"]["cacheTier"]
            == "B"
        )

    def test_warm_returns_at_once_and_builds_in_the_background(self, fake):
        source, adapter = fake
        source.gate.clear()
        response = _post({"modelId": MODEL, "operation": {"op": "warm"}})
        assert response.json()["result"] == {"status": "warming"}
        source.gate.set()

    def test_within_around_an_element_searches_its_box_grown_by_the_margin(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": GID, "margin": 1}})
        assert response.json()["result"]["box"] == {"min": [-1, -1, -1], "max": [2, 3, 4]}

    def test_around_an_element_without_a_box_is_400(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": "0" * 22}})
        assert response.status_code == 400

    def test_a_box_and_an_element_at_once_is_refused(self, fake):
        box = {"min": [0, 0, 0], "max": [1, 1, 1]}
        response = _post({"modelId": MODEL, "operation": {"op": "within", "box": box, "aroundGlobalId": GID}})
        assert response.status_code == 422

    def test_neighbours_reads_the_resident_model(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "neighbours", "globalId": GID}})
        assert response.status_code == 200, response.text
        assert response.json()["result"]["model"].startswith("model:")

    def test_diff_resolves_the_base_model_too(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}})
        assert response.json()["result"]["changes"][0]["kind"] == "unchanged"
        assert fake[1].builds == 2

    def test_an_unresolved_model_is_404_and_one_still_being_read_is_409(self, fake, monkeypatch):
        answers = iter([{"resolved": False, "reason": "not_found"}, {"resolved": False, "reason": "not_ready"}])
        monkeypatch.setattr(spatial, "resolve_model_source", lambda **_: next(answers))
        assert _post({"modelId": MODEL, "operation": {"op": "warm"}}).status_code == 404
        assert _post({"modelId": MODEL, "operation": {"op": "warm"}}).json()["code"] == "model_not_ready"

    def test_the_probes(self, fake):
        client = TestClient(create_app())
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").status_code == 200


class TestIndexCache:
    def test_the_key_changes_with_the_etag(self, fake):
        source, _ = fake
        first = index_cache.index_key(MODEL, source.resolve(organization_id="o", project_id=None, model_id=MODEL))
        source.etag = "etag-2"
        second = index_cache.index_key(MODEL, source.resolve(organization_id="o", project_id=None, model_id=MODEL))
        assert first != second
        assert first.startswith(f"ifc:index:v1:{MODEL}:")

    def test_concurrent_callers_share_one_build(self, fake):
        source, adapter = fake
        body = source.resolve(organization_id="o", project_id=None, model_id=MODEL)
        key = index_cache.index_key(MODEL, body)
        source.gate.clear()
        results: list[Any] = []
        threads = [
            threading.Thread(target=lambda: results.append(index_cache.load_index(key, body, time.monotonic() + 5)))
            for _ in range(4)
        ]
        for thread in threads:
            thread.start()
        time.sleep(0.1)
        source.gate.set()
        for thread in threads:
            thread.join(5)
        assert len(results) == 4
        assert (adapter.builds, source.downloads) == (1, 1)

    def test_a_lock_held_elsewhere_means_wait_not_build(self, fake):
        source, adapter = fake
        body = source.resolve(organization_id="o", project_id=None, model_id=MODEL)
        key = index_cache.index_key(MODEL, body)
        assert cache.set_if_absent(f"{key}:lock", "another-replica", 60)
        with pytest.raises(index_cache.GeometryWarming):
            index_cache.load_index(key, body, time.monotonic() + 0.3)
        assert adapter.builds == 0

    def test_the_build_releases_its_lock(self, fake):
        source, _ = fake
        body = source.resolve(organization_id="o", project_id=None, model_id=MODEL)
        key = index_cache.index_key(MODEL, body)
        index_cache.load_index(key, body, time.monotonic() + 5)
        assert cache.set_if_absent(f"{key}:lock", "next", 1)
