"""The geometry service: its route's credentials and refusals, the element index cache and the builds.

The engine is faked at its one adapter (``geometry_service.engine``), the model source at
``agent.knowledge.ifc_spatial_client`` (open), the BFF's signed sources are built here, and the shared cache runs on its
per-process fallback. ``test_engine_contract.py`` runs the real engine through the same adapter.
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
from geometry_service import builds
from geometry_service import engine
from geometry_service import index_cache
from geometry_service import operations
from geometry_service.app import GEOMETRY_PATH
from geometry_service.app import create_app
from geometry_service.engine import EngineRefusal
from geometry_service.errors import GeometryWarming
from geometry_service.signed_sources import SOURCES_HEADER
from geometry_service.signed_sources import SOURCES_SIG_HEADER
from geometry_service.signed_sources import sources_key

from agent.common import cache
from agent.common.envelope_auth import ENVELOPE_HEADER
from agent.common.envelope_auth import ENVELOPE_SIG_HEADER
from agent.knowledge import ifc_spatial_client as spatial
from agent.knowledge.bim_query import BimQueryUnavailableError

SECRET = "geometry-test-secret"  # pragma: allowlist secret
MODEL = "11111111-1111-4111-8111-111111111111"
BASE = "22222222-2222-4222-8222-222222222222"
GID = "2O2Fr$t4X7Zf8NOew3FLOH"
OTHER = "1hOSvn6df7F8_7GcBWlRGQ"
TRACE = "c" * 32


def _answer(value: dict[str, Any]) -> dict[str, Any]:
    return {"value": value, "unit": "m", "provenance": "computed", "from": [], "method": "fake", "decidable": True}


class FakeEngine(engine.GeometryEngine):
    def __init__(self) -> None:
        self.builds = 0
        self.reads = 0
        self.calls: list[tuple[str, Any]] = []

    def available(self) -> bool:
        return True

    def build_index(self, model: Any) -> Any:
        self.builds += 1
        return {"boxes": {GID: [[0, 0, 0], [1, 2, 3]], OTHER: [[5, 5, 0], [6, 6, 1]]}}

    def index_to_json(self, index: Any) -> str:
        return json.dumps({"schema": 1, "boxes": index["boxes"]})

    def index_from_json(self, data: Any) -> Any:
        self.reads += 1
        parsed = json.loads(data)
        if parsed.get("schema") != 1:
            raise ValueError("element index has an unknown schema")  # the engine's IndexFormatError is one
        return {"boxes": parsed["boxes"]}

    def element_boxes(self, index, ids):
        boxes = [
            {"globalId": g, "min": index["boxes"][g][0], "max": index["boxes"][g][1]}
            for g in ids
            if g in index["boxes"]
        ]
        return _answer({"boxes": boxes, "missing": [g for g in ids if g not in index["boxes"]]})

    def elements_within(self, index, box, ifc_types, limit):
        return _answer({"box": box, "elements": [], "truncated": False})

    def elements_near(self, index, *, point, global_id, radius, limit):
        if global_id == "0" * 22:
            raise EngineRefusal(f"{global_id} has no box in this model (unknown-global-id)")
        return _answer({"elements": [{"globalId": OTHER}], "truncated": True})

    def neighbours(self, model, gid, gap, budget=None):
        self.calls.append(("neighbours", budget))
        return _answer({"neighbours": [{"globalId": OTHER, "distance": 0.0}], "model": model})

    def clash(self, model, set_a, set_b, mode, tolerance, budget=None):
        self.calls.append(("clash", tolerance))
        return _answer({"pairs": [], "truncated": False})

    def box_diff(self, base_index, index, ids):
        return _answer({"elements": [{"globalId": GID, "status": "unchanged"}]})


class Source:
    """The model download, counted; ``body`` is a source as the BFF signs it."""

    def __init__(self) -> None:
        self.etag = "etag-1"
        self.downloads = 0
        self.resident: set[str] = set()
        self.gate = threading.Event()
        self.gate.set()
        self.fail: Exception | None = None

    def signed(self, model_id: str) -> dict:
        return {
            "url": f"http://store.internal/{model_id}",
            "etag": f"{model_id}:{self.etag}",
            "bytes": 10,
            "updatedAt": "t",
        }

    def body(self, model_id: str) -> dict:
        return {
            "resolved": True,
            "model": {"modelId": model_id, "updatedAt": "t"},
            "source": {"etag": f"{model_id}:{self.etag}"},
        }

    def open_model(self, source, fetch=None):
        identity = spatial.source_identity(source)
        if identity not in self.resident:
            self.gate.wait(10)
            self.downloads += 1
            if self.fail is not None:
                raise self.fail
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
    index_cache.memo_clear()
    source = Source()
    monkeypatch.setattr(spatial, "resolve_model_source", lambda **_: pytest.fail("the service resolved a model itself"))
    monkeypatch.setattr(spatial, "open_model", source.open_model)
    monkeypatch.setattr(spatial, "resident_model", source.resident_model)
    scored: list[tuple[str | None, int]] = []
    monkeypatch.setattr(builds, "score_cold", lambda trace_id, ms: scored.append((trace_id, ms)))
    adapter = FakeEngine()
    previous = engine.set_for_tests(adapter)
    yield source, adapter, scored
    source.gate.set()
    for future in list(builds._INFLIGHT.values()):
        try:
            future.result(timeout=10)
        except Exception:  # noqa: BLE001, S110 - a test's deliberate failure
            pass
    engine.set_for_tests(previous)


def _envelope(payload: dict) -> dict[str, str]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return {
        ENVELOPE_HEADER: header,
        ENVELOPE_SIG_HEADER: hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }


def _signed(payload: dict, secret: str = SECRET) -> dict[str, str]:
    """A sources pair as the BFF signs it: the derived key over the raw JSON."""
    raw = json.dumps(payload)
    return {
        SOURCES_HEADER: base64.urlsafe_b64encode(raw.encode()).decode().rstrip("="),
        SOURCES_SIG_HEADER: hmac.new(sources_key(secret), raw.encode(), hashlib.sha256).hexdigest(),
    }


def _sources(models: tuple[str, ...]) -> dict:
    return {
        m: {"url": f"http://store.internal/{m}", "etag": f"{m}:etag-1", "bytes": 10, "updatedAt": "t"} for m in models
    }


def _headers(
    body: dict | None = None, models: tuple[str, ...] = (MODEL, BASE), bound: dict | None = None, **override: Any
) -> dict[str, str]:
    """The envelope and the sources for ``body``; ``bound`` overrides any field of the signed sources."""
    body = body or _boxes()
    payload = {"organizationId": "org", "userId": "user", "projectId": "project", "issuedAt": int(time.time() * 1000)}
    payload = {**payload, **override}
    signed = {
        "kind": "model-sources",
        "organizationId": payload.get("organizationId"),
        "userId": payload.get("userId"),
        "issuedAt": payload["issuedAt"],
        "exp": payload["issuedAt"] + 60_000,
        "modelId": body["modelId"],
        "op": body["operation"]["op"],
        "sources": _sources(models),
        **(bound or {}),
    }
    return {"x-internal-token": SECRET, "x-trace-id": TRACE, **_envelope(payload), **_signed(signed)}


def _post(body: dict, headers: dict[str, str] | None = None):
    return TestClient(create_app()).post(
        GEOMETRY_PATH, json=body, headers=_headers(body) if headers is None else headers
    )


def _boxes() -> dict:
    return {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}


def _wait_for(condition, seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.02)


class TestCredentials:
    def test_without_an_envelope_it_is_403_and_nothing_is_fetched(self, fake):
        source, _, _ = fake
        response = _post(_boxes(), {"x-internal-token": SECRET})
        assert response.status_code == 403
        assert response.json()["detail"]["error"] == "context_envelope_required"
        assert source.downloads == 0

    def test_without_the_token_it_is_403(self, fake):
        headers = _headers()
        del headers["x-internal-token"]
        assert _post(_boxes(), headers).status_code == 403

    def test_an_envelope_without_a_user_is_403(self, fake):
        assert _post(_boxes(), _headers(userId=None)).status_code == 403

    @pytest.mark.parametrize(
        "headers",
        [
            lambda: {k: v for k, v in _headers().items() if k != SOURCES_HEADER},
            lambda: {**_headers(), SOURCES_SIG_HEADER: "0" * 64},
            lambda: _headers(bound={"userId": "someone-else"}),
            lambda: _headers(bound={"issuedAt": 1}),
            lambda: _headers(models=(BASE,)),
            lambda: _headers(bound={"exp": int(time.time() * 1000) - 60_000}),
            lambda: _headers(bound={"op": "clash"}),
            lambda: _headers(bound={"modelId": BASE}),
            lambda: _headers(bound={"kind": None}),
        ],
        ids=[
            "no-sources",
            "forged",
            "another-user",
            "another-request",
            "not-this-model",
            "expired",
            "another-op",
            "another-model",
            "no-kind",
        ],
    )
    def test_only_a_source_the_bff_signed_for_this_request_and_model_is_fetched(self, fake, headers):
        source, _, _ = fake
        response = _post(_boxes(), headers())
        assert (response.status_code, response.json()["code"]) == (403, "source_not_signed")
        assert source.downloads == 0

    def test_the_signed_source_is_what_is_fetched_and_nothing_is_resolved(self, fake, monkeypatch):
        seen: list[dict] = []
        source, _, _ = fake
        original = source.open_model
        monkeypatch.setattr(spatial, "open_model", lambda body, fetch=None: seen.append(body) or original(body))
        assert _post(_boxes()).status_code == 200
        assert seen[0]["source"]["url"] == f"http://store.internal/{MODEL}"
        assert seen[0]["source"]["etag"] == f"{MODEL}:etag-1"

    def test_the_probes(self, fake):
        client = TestClient(create_app())
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").status_code == 200


class TestOperations:
    def test_a_cold_model_answers_cold_then_from_tier_b(self, fake):
        source, adapter, _ = fake
        first = _post(_boxes())
        assert first.status_code == 200, first.text
        assert first.json()["meta"]["cacheTier"] == "cold"
        assert first.json()["result"]["value"]["boxes"][0]["max"] == [1, 2, 3]
        second = _post(_boxes())
        assert second.json()["meta"] | {"ms": 0} == {"cacheTier": "B", "elements": 1, "truncated": False, "ms": 0}
        assert (source.downloads, adapter.builds) == (1, 1)

    def test_a_tier_b_hit_downloads_nothing_and_the_memo_spares_the_second_read(self, fake):
        source, adapter, _ = fake
        key = index_cache.index_key(MODEL, source.body(MODEL))
        cache.set_json(key, json.dumps({"schema": 1, "boxes": {GID: [[0, 0, 0], [1, 1, 1]]}}), 60)
        assert _post(_boxes()).json()["meta"]["cacheTier"] == "B"
        assert _post(_boxes()).json()["meta"]["cacheTier"] == "B"
        assert (source.downloads, adapter.builds, adapter.reads) == (0, 0, 1)

    def test_a_poisoned_tier_b_entry_is_deleted_and_rebuilt(self, fake):
        source, adapter, _ = fake
        key = index_cache.index_key(MODEL, source.body(MODEL))
        cache.set_json(key, json.dumps({"schema": 99}), 60)
        response = _post(_boxes())
        assert response.status_code == 200, response.text
        assert response.json()["meta"]["cacheTier"] == "cold"
        assert adapter.builds == 1
        assert json.loads(cache.get_json(key))["schema"] == 1

    def test_past_the_wait_it_is_409_warming_the_build_carries_on_and_is_scored(self, fake, monkeypatch):
        source, adapter, scored = fake
        monkeypatch.setattr(operations, "WAIT_SECONDS", 0.2)
        source.gate.clear()
        response = _post(_boxes())
        assert response.status_code == 409
        assert response.json() | {"error": ""} == {"code": "geometry_warming", "error": "", "retryAfter": 10}
        assert response.headers["retry-after"] == "10"
        source.gate.set()
        _wait_for(lambda: scored)
        assert scored and scored[0][0] == TRACE
        assert _post(_boxes()).json()["meta"]["cacheTier"] == "B"

    def test_warm_returns_at_once_and_builds_in_the_background(self, fake):
        source, _, _ = fake
        source.gate.clear()
        assert _post({"modelId": MODEL, "operation": {"op": "warm"}}).json()["result"]["value"] == {"status": "warming"}
        source.gate.set()

    def test_within_around_an_element_searches_its_box_grown_by_the_margin(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": GID, "margin": 1}})
        assert response.json()["result"]["value"]["box"] == {"min": [-1, -1, -1], "max": [2, 3, 4]}

    def test_around_an_element_without_a_box_is_400(self, fake):
        assert _post({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": "0" * 22}}).status_code == 400

    def test_the_engine_s_refusal_is_400_with_its_message(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "near", "globalId": "0" * 22, "radius": 2}})
        assert response.status_code == 400
        assert "unknown-global-id" in response.json()["error"]

    def test_truncation_is_read_from_the_answer_s_value(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "near", "globalId": GID, "radius": 2}})
        assert response.json()["meta"]["truncated"] is True

    def test_a_box_and_an_element_at_once_is_refused(self, fake):
        box = {"min": [0, 0, 0], "max": [1, 1, 1]}
        assert (
            _post({"modelId": MODEL, "operation": {"op": "within", "box": box, "aroundGlobalId": GID}}).status_code
            == 422
        )

    @pytest.mark.parametrize(
        ("operation", "status"),
        [
            ({"op": "clash", "setA": [GID], "mode": "clearance"}, 422),
            ({"op": "clash", "setA": [GID], "mode": "touch", "tolerance": 0.2}, 422),
            ({"op": "clash", "setA": [GID], "mode": "clearance", "tolerance": 4.0}, 200),
            ({"op": "clash", "setA": [GID]}, 200),
        ],
    )
    def test_the_clash_tolerance_is_bounded_per_mode_as_the_engine_bounds_it(self, fake, operation, status):
        assert _post({"modelId": MODEL, "operation": operation}).status_code == status

    def test_no_tolerance_is_sent_as_none(self, fake):
        _post({"modelId": MODEL, "operation": {"op": "clash", "setA": [GID]}})
        assert fake[1].calls == [("clash", None)]

    def test_neighbours_reads_the_resident_model_within_the_request_budget(self, fake):
        response = _post({"modelId": MODEL, "operation": {"op": "neighbours", "globalId": GID}})
        assert response.status_code == 200, response.text
        assert response.json()["result"]["value"]["model"].startswith("model:")
        (_, budget), *_ = fake[1].calls
        assert 0 < budget <= operations.REQUEST_BUDGET_SECONDS

    def test_diff_reads_the_base_model_from_its_own_signed_source(self, fake):
        source, adapter, _ = fake
        response = _post({"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}})
        assert response.json()["result"]["value"]["elements"][0]["status"] == "unchanged"
        assert (adapter.builds, source.downloads) == (2, 2)
        unsigned = _post(
            {"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}},
            _headers({"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}}, models=(MODEL,)),
        )
        assert unsigned.status_code == 403

    def test_no_operation_starts_without_budget_left(self, fake, monkeypatch):
        monkeypatch.setattr(operations, "REQUEST_BUDGET_SECONDS", 0.5)
        response = _post({"modelId": MODEL, "operation": {"op": "neighbours", "globalId": GID}})
        assert response.status_code in (409, 504)
        assert fake[1].calls == []


class TestBuilds:
    def test_the_key_changes_with_the_etag(self, fake):
        source, _, _ = fake
        first = index_cache.index_key(MODEL, source.body(MODEL))
        source.etag = "etag-2"
        second = index_cache.index_key(MODEL, source.body(MODEL))
        assert first != second
        assert first.startswith(f"ifc:index:v1:{MODEL}:")

    def test_concurrent_callers_share_one_build(self, fake):
        source, adapter, _ = fake
        body = source.body(MODEL)
        key = index_cache.index_key(MODEL, body)
        source.gate.clear()
        results: list[Any] = []
        threads = [
            threading.Thread(target=lambda: results.append(builds.load_index(key, body, time.monotonic() + 5)))
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
        source, adapter, _ = fake
        body = source.body(MODEL)
        key = index_cache.index_key(MODEL, body)
        assert cache.set_if_absent(f"{key}:lock", json.dumps("another-replica"), 60)
        with pytest.raises(GeometryWarming):
            builds.load_index(key, body, time.monotonic() + 0.3)
        assert adapter.builds == 0

    def test_a_lapsed_lock_is_taken_over(self, fake):
        source, adapter, _ = fake
        body = source.body(MODEL)
        key = index_cache.index_key(MODEL, body)
        assert cache.set_if_absent(f"{key}:lock", json.dumps("dead-replica"), 0.2)
        index, tier = builds.load_index(key, body, time.monotonic() + 3)
        assert (tier, adapter.builds) == ("cold", 1)

    def test_the_heartbeat_keeps_the_lock_through_a_build_longer_than_its_ttl(self, fake, monkeypatch):
        source, _, _ = fake
        monkeypatch.setattr(builds, "BUILD_LOCK_SECONDS", 0.3)
        monkeypatch.setattr(builds, "HEARTBEAT_SECONDS", 0.05)
        body = source.body(MODEL)
        key = index_cache.index_key(MODEL, body)
        source.gate.clear()
        builds.warm(MODEL, body)
        time.sleep(0.8)  # past the TTL, the build still running
        assert cache.set_if_absent(f"{key}:lock", json.dumps("intruder"), 1) is False
        source.gate.set()
        _wait_for(lambda: cache.get_json(key) is not None)
        _wait_for(lambda: cache.get_json(f"{key}:lock") is None)
        assert cache.get_json(f"{key}:lock") is None

    def test_a_failed_build_is_remembered_with_its_reason(self, fake):
        source, _, _ = fake
        source.fail = BimQueryUnavailableError("the model file could not be downloaded")
        first = _post(_boxes())
        assert first.status_code == 502
        second = _post(_boxes())
        assert second.json() | {"error": ""} == {"code": "build_failed", "error": ""}
        assert "could not be downloaded" in second.json()["error"]
        assert source.downloads == 1

    def test_a_full_queue_says_busy(self, fake, monkeypatch):
        source, _, _ = fake
        monkeypatch.setattr(builds, "MAX_QUEUED_BUILDS", 1)
        source.gate.clear()
        builds.warm(MODEL, source.body(MODEL))
        response = _post({"modelId": BASE, "operation": {"op": "warm"}})
        assert (response.status_code, response.json()["code"]) == (503, "geometry_busy")
        source.gate.set()
