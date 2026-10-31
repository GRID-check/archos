"""The geometry service: its credentials and refusals, the element index cache and the builds.

Every call goes through the service's MCP endpoint (``tools/call``), with the engine faked at its
one adapter and the model download faked at ``ifc_spatial_client`` (``geometry_testing.service``).
``test_engine_contract.py`` runs the real engine through the same adapter.
"""

from __future__ import annotations

import json
import threading
import time
from typing import Any

import pytest
from fastapi.testclient import TestClient
from geometry_service import builds
from geometry_service import index_cache
from geometry_service import operations
from geometry_service.app import create_app
from geometry_service.errors import GeometryWarming
from geometry_service.signed_sources import SOURCES_HEADER
from geometry_service.signed_sources import SOURCES_SIG_HEADER
from geometry_testing.service import BASE
from geometry_testing.service import GID
from geometry_testing.service import MODEL
from geometry_testing.service import SECRET
from geometry_testing.service import TRACE
from geometry_testing.service import boxes_call
from geometry_testing.service import call_tool
from geometry_testing.service import headers_for
from geometry_testing.service import install_fakes
from geometry_testing.service import wait_for

from agent.common import cache
from agent.knowledge import ifc_spatial_client as spatial
from agent.knowledge.bim_query import BimQueryUnavailableError


@pytest.fixture
def fake(monkeypatch):
    yield from install_fakes(monkeypatch)


class TestCredentials:
    def test_without_an_envelope_it_is_403_and_nothing_is_fetched(self, fake):
        source, _, _ = fake
        response = call_tool(boxes_call(), {"x-internal-token": SECRET})
        assert response.status_code == 403
        assert response.json()["code"] == "context_envelope_required"
        assert source.downloads == 0

    def test_without_the_token_it_is_403(self, fake):
        headers = headers_for()
        del headers["x-internal-token"]
        assert call_tool(boxes_call(), headers).status_code == 403

    def test_an_envelope_without_a_user_is_403(self, fake):
        assert call_tool(boxes_call(), headers_for(userId=None)).status_code == 403

    @pytest.mark.parametrize(
        "headers",
        [
            lambda: {k: v for k, v in headers_for().items() if k != SOURCES_HEADER},
            lambda: {**headers_for(), SOURCES_SIG_HEADER: "0" * 64},
            lambda: headers_for(bound={"userId": "someone-else"}),
            lambda: headers_for(bound={"issuedAt": 1}),
            lambda: headers_for(models=(BASE,)),
            lambda: headers_for(bound={"exp": int(time.time() * 1000) - 60_000}),
            lambda: headers_for(bound={"op": "clash"}),
            lambda: headers_for(bound={"modelId": BASE}),
            lambda: headers_for(bound={"kind": None}),
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
        response = call_tool(boxes_call(), headers())
        assert (response.status_code, response.json()["code"]) == (403, "source_not_signed")
        assert source.downloads == 0

    def test_the_signed_source_is_what_is_fetched_and_nothing_is_resolved(self, fake, monkeypatch):
        seen: list[dict] = []
        source, _, _ = fake
        original = source.open_model
        monkeypatch.setattr(spatial, "open_model", lambda body, fetch=None: seen.append(body) or original(body))
        assert call_tool(boxes_call()).status_code == 200
        assert seen[0]["source"]["url"] == f"http://store.internal/{MODEL}"
        assert seen[0]["source"]["etag"] == f"{MODEL}:etag-1"

    def test_the_probes(self, fake):
        client = TestClient(create_app())
        assert client.get("/healthz").json() == {"status": "ok"}
        assert client.get("/readyz").status_code == 200


class TestOperations:
    def test_a_cold_model_answers_cold_then_from_tier_b(self, fake):
        source, adapter, _ = fake
        first = call_tool(boxes_call())
        assert first.status_code == 200, first.text
        assert first.json()["meta"]["cacheTier"] == "cold"
        assert first.json()["result"]["value"]["boxes"][0]["max"] == [1, 2, 3]
        second = call_tool(boxes_call())
        assert second.json()["meta"] | {"ms": 0} == {"cacheTier": "B", "elements": 1, "truncated": False, "ms": 0}
        assert (source.downloads, adapter.builds) == (1, 1)

    def test_a_tier_b_hit_downloads_nothing_and_the_memo_spares_the_second_read(self, fake):
        source, adapter, _ = fake
        key = index_cache.index_key(MODEL, source.body(MODEL))
        cache.set_json(key, json.dumps({"schema": 1, "boxes": {GID: [[0, 0, 0], [1, 1, 1]]}}), 60)
        assert call_tool(boxes_call()).json()["meta"]["cacheTier"] == "B"
        assert call_tool(boxes_call()).json()["meta"]["cacheTier"] == "B"
        assert (source.downloads, adapter.builds, adapter.reads) == (0, 0, 1)

    def test_a_poisoned_tier_b_entry_is_deleted_and_rebuilt(self, fake):
        source, adapter, _ = fake
        key = index_cache.index_key(MODEL, source.body(MODEL))
        cache.set_json(key, json.dumps({"schema": 99}), 60)
        response = call_tool(boxes_call())
        assert response.status_code == 200, response.text
        assert response.json()["meta"]["cacheTier"] == "cold"
        assert adapter.builds == 1
        assert json.loads(cache.get_json(key))["schema"] == 1

    def test_past_the_wait_it_is_409_warming_the_build_carries_on_and_is_scored(self, fake, monkeypatch):
        source, adapter, scored = fake
        monkeypatch.setattr(operations, "WAIT_SECONDS", 0.2)
        source.gate.clear()
        response = call_tool(boxes_call())
        assert response.status_code == 409
        assert response.json() | {"error": ""} == {
            "status": 409,
            "code": "geometry_warming",
            "error": "",
            "retryAfter": 10,
        }
        source.gate.set()
        wait_for(lambda: scored)
        assert scored and scored[0][0] == TRACE
        assert call_tool(boxes_call()).json()["meta"]["cacheTier"] == "B"

    def test_warm_returns_at_once_and_builds_in_the_background(self, fake):
        source, _, _ = fake
        source.gate.clear()
        assert call_tool({"modelId": MODEL, "operation": {"op": "warm"}}).json()["result"]["value"] == {
            "status": "warming"
        }
        source.gate.set()

    def test_within_around_an_element_searches_its_box_grown_by_the_margin(self, fake):
        response = call_tool({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": GID, "margin": 1}})
        assert response.json()["result"]["value"]["box"] == {"min": [-1, -1, -1], "max": [2, 3, 4]}

    def test_around_an_element_without_a_box_is_400(self, fake):
        assert (
            call_tool({"modelId": MODEL, "operation": {"op": "within", "aroundGlobalId": "0" * 22}}).status_code == 400
        )

    def test_the_engine_s_refusal_is_400_with_its_message(self, fake):
        response = call_tool({"modelId": MODEL, "operation": {"op": "near", "globalId": "0" * 22, "radius": 2}})
        assert response.status_code == 400
        assert "unknown-global-id" in response.json()["error"]

    def test_truncation_is_read_from_the_answer_s_value(self, fake):
        response = call_tool({"modelId": MODEL, "operation": {"op": "near", "globalId": GID, "radius": 2}})
        assert response.json()["meta"]["truncated"] is True

    def test_a_box_and_an_element_at_once_is_refused(self, fake):
        box = {"min": [0, 0, 0], "max": [1, 1, 1]}
        assert (
            call_tool({"modelId": MODEL, "operation": {"op": "within", "box": box, "aroundGlobalId": GID}}).status_code
            == 400
        )

    @pytest.mark.parametrize(
        ("operation", "status"),
        [
            ({"op": "clash", "setA": [GID], "mode": "clearance"}, 400),
            ({"op": "clash", "setA": [GID], "mode": "touch", "tolerance": 0.2}, 400),
            ({"op": "clash", "setA": [GID], "mode": "clearance", "tolerance": 4.0}, 200),
            ({"op": "clash", "setA": [GID]}, 200),
        ],
    )
    def test_the_clash_tolerance_is_bounded_per_mode_as_the_engine_bounds_it(self, fake, operation, status):
        assert call_tool({"modelId": MODEL, "operation": operation}).status_code == status

    def test_no_tolerance_is_sent_as_none(self, fake):
        call_tool({"modelId": MODEL, "operation": {"op": "clash", "setA": [GID]}})
        assert fake[1].calls == [("clash", None)]

    def test_neighbours_reads_the_resident_model_within_the_request_budget(self, fake):
        response = call_tool({"modelId": MODEL, "operation": {"op": "neighbours", "globalId": GID}})
        assert response.status_code == 200, response.text
        assert response.json()["result"]["value"]["model"].startswith("model:")
        (_, budget), *_ = fake[1].calls
        assert 0 < budget <= operations.REQUEST_BUDGET_SECONDS

    def test_diff_reads_the_base_model_from_its_own_signed_source(self, fake):
        source, adapter, _ = fake
        response = call_tool({"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}})
        assert response.json()["result"]["value"]["elements"][0]["status"] == "unchanged"
        assert (adapter.builds, source.downloads) == (2, 2)
        unsigned = call_tool(
            {"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}},
            headers_for({"modelId": MODEL, "operation": {"op": "diff", "baseModelId": BASE}}, models=(MODEL,)),
        )
        assert unsigned.status_code == 403

    def test_no_operation_starts_without_budget_left(self, fake, monkeypatch):
        monkeypatch.setattr(operations, "REQUEST_BUDGET_SECONDS", 0.5)
        response = call_tool({"modelId": MODEL, "operation": {"op": "neighbours", "globalId": GID}})
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
        wait_for(lambda: cache.get_json(key) is not None)
        wait_for(lambda: cache.get_json(f"{key}:lock") is None)
        assert cache.get_json(f"{key}:lock") is None

    def test_a_failed_build_is_remembered_with_its_reason(self, fake):
        source, _, _ = fake
        source.fail = BimQueryUnavailableError("the model file could not be downloaded")
        first = call_tool(boxes_call())
        assert first.status_code == 502
        second = call_tool(boxes_call())
        assert second.json() | {"error": ""} == {"status": 502, "code": "build_failed", "error": ""}
        assert "could not be downloaded" in second.json()["error"]
        assert source.downloads == 1

    def test_a_full_queue_says_busy(self, fake, monkeypatch):
        source, _, _ = fake
        monkeypatch.setattr(builds, "MAX_QUEUED_BUILDS", 1)
        source.gate.clear()
        builds.warm(MODEL, source.body(MODEL))
        response = call_tool({"modelId": BASE, "operation": {"op": "warm"}})
        assert (response.status_code, response.json()["code"]) == (503, "geometry_busy")
        source.gate.set()
