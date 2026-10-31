"""The geometry service's test doubles and the BFF's side of a call, shared by its test modules.

The engine faked at its one adapter, the model download faked at ``ifc_spatial_client``, and the
headers the BFF sends (internal token, envelope, handed-over sources) built as the BFF builds them.
A helper a test needs from another file lives here, imported by name (``packages/AGENTS.md``).
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
from geometry_service.app import MCP_PATH
from geometry_service.app import create_app
from geometry_service.engine import EngineRefusal
from geometry_service.signed_sources import SOURCES_HEADER
from geometry_service.signed_sources import SOURCES_SIG_HEADER
from geometry_service.signed_sources import sources_key

from agent.common import cache
from agent.common.envelope_auth import ENVELOPE_HEADER
from agent.common.envelope_auth import ENVELOPE_SIG_HEADER
from agent.knowledge import ifc_spatial_client as spatial

SECRET = "geometry-test-secret"  # pragma: allowlist secret
MODEL = "11111111-1111-4111-8111-111111111111"
BASE = "22222222-2222-4222-8222-222222222222"
GID = "2O2Fr$t4X7Zf8NOew3FLOH"
OTHER = "1hOSvn6df7F8_7GcBWlRGQ"
TRACE = "c" * 32


def answer_value(value: dict[str, Any]) -> dict[str, Any]:
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
        return answer_value({"boxes": boxes, "missing": [g for g in ids if g not in index["boxes"]]})

    def elements_within(self, index, box, ifc_types, limit):
        return answer_value({"box": box, "elements": [], "truncated": False})

    def elements_near(self, index, *, point, global_id, radius, limit):
        if global_id == "0" * 22:
            raise EngineRefusal(f"{global_id} has no box in this model (unknown-global-id)")
        return answer_value({"elements": [{"globalId": OTHER}], "truncated": True})

    def neighbours(self, model, gid, gap, budget=None):
        self.calls.append(("neighbours", budget))
        return answer_value({"neighbours": [{"globalId": OTHER, "distance": 0.0}], "model": model})

    def clash(self, model, set_a, set_b, mode, tolerance, budget=None):
        self.calls.append(("clash", tolerance))
        return answer_value({"pairs": [], "truncated": False})

    def box_diff(self, base_index, index, ids):
        return answer_value({"elements": [{"globalId": GID, "status": "unchanged"}]})


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


def install_fakes(monkeypatch):
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


def envelope(payload: dict) -> dict[str, str]:
    raw = json.dumps(payload)
    header = base64.urlsafe_b64encode(raw.encode()).decode().rstrip("=")
    return {
        ENVELOPE_HEADER: header,
        ENVELOPE_SIG_HEADER: hmac.new(SECRET.encode(), raw.encode(), hashlib.sha256).hexdigest(),
    }


def signedsources_for(payload: dict, secret: str = SECRET) -> dict[str, str]:
    """A sources pair as the BFF signs it: the derived key over the raw JSON."""
    raw = json.dumps(payload)
    return {
        SOURCES_HEADER: base64.urlsafe_b64encode(raw.encode()).decode().rstrip("="),
        SOURCES_SIG_HEADER: hmac.new(sources_key(secret), raw.encode(), hashlib.sha256).hexdigest(),
    }


def sources_for(models: tuple[str, ...]) -> dict:
    return {
        m: {"url": f"http://store.internal/{m}", "etag": f"{m}:etag-1", "bytes": 10, "updatedAt": "t"} for m in models
    }


def headers_for(
    body: dict | None = None, models: tuple[str, ...] = (MODEL, BASE), bound: dict | None = None, **override: Any
) -> dict[str, str]:
    """The envelope and the sources for ``body``; ``bound`` overrides any field of the signed sources."""
    body = body or boxes_call()
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
        "sources": sources_for(models),
        **(bound or {}),
    }
    return {"x-internal-token": SECRET, "x-trace-id": TRACE, **envelope(payload), **signedsources_for(signed)}


class Answer:
    """One tools/call answered: its status (200, or the refusal's), and its structured content as JSON."""

    def __init__(self, status_code: int, payload: dict) -> None:
        self.status_code, self._payload = status_code, payload
        self.text = json.dumps(payload)

    def json(self) -> dict:
        return self._payload


def call_tool(body: dict, headers: dict[str, str] | None = None) -> Answer:
    """``tools/call`` of the tool named by ``body``'s op, over the service's MCP endpoint."""
    arguments = {"modelId": body["modelId"], **{k: v for k, v in body["operation"].items() if k != "op"}}
    params = {"name": body["operation"]["op"], "arguments": arguments}
    call = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": params}
    sent = {"accept": "application/json, text/event-stream", **(headers_for(body) if headers is None else headers)}
    with TestClient(create_app()) as client:
        response = client.post(f"{MCP_PATH}/", json=call, headers=sent)
    if response.status_code != 200:  # refused before MCP: the internal token
        return Answer(response.status_code, response.json())
    result = response.json()["result"]
    structured = result.get("structuredContent") or {}
    return Answer(structured.get("status", 400) if result.get("isError") else 200, structured)


def boxes_call() -> dict:
    return {"modelId": MODEL, "operation": {"op": "boxes", "globalIds": [GID]}}


def wait_for(condition, seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition() and time.monotonic() < deadline:
        time.sleep(0.02)
