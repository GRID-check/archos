"""The service's engine adapter against the real engine, on the sample house: the names, the
argument shapes and the answer shapes ``engine.py`` assumes are the ones ``ifc_spatial`` has.

No fake here. Every operation the route offers runs through ``operations`` and the adapter on
``Ifc4_SampleHouse.ifc``; only the model source is local (the file instead of the BFF's presigned
URL) and the shared cache runs on its per-process fallback. Skipped where the engine is not
installed (the backend suite's venv); ``task pkg:test:geometry-contract`` runs it with the engine's.

Facts of the house this leans on (``packages/ifc-spatial-py/tests/test_locate.py``): the north wall
hosts a window, the living room declares its furniture by containment, and the living room and the
bedroom share one partition.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("ifc_spatial.element_index")

from geometry_service import engine  # noqa: E402
from geometry_service.engine import EngineRefusal  # noqa: E402
from ifc_spatial.model import SpatialModel  # noqa: E402

HOUSE = Path(__file__).resolve().parents[3] / "packages" / "ifc-spatial" / "test" / "fixtures" / "Ifc4_SampleHouse.ifc"
NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"


@pytest.fixture(scope="module")
def adapter() -> engine.GeometryEngine:
    return engine.GeometryEngine()


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(HOUSE))


@pytest.fixture(scope="module")
def index(adapter: engine.GeometryEngine, house: SpatialModel):
    return adapter.build_index(house)


def _value(answer: dict) -> dict:
    assert answer["provenance"] in ("computed", "declared", "inferred")
    assert answer["unit"] == "m"
    return answer["value"]


def test_the_index_round_trips_through_its_wire_form(adapter, index) -> None:
    text = adapter.index_to_json(index)
    assert isinstance(text, str)
    assert adapter.index_from_json(text) == index
    with pytest.raises(ValueError):
        adapter.index_from_json('{"schema": "something-else"}')


def test_boxes_and_group_boxes(adapter, index) -> None:
    value = _value(adapter.element_boxes(index, [NORTH_WALL, "0" * 22]))
    (box,) = value["boxes"]
    assert box["globalId"] == NORTH_WALL and len(box["min"]) == len(box["max"]) == 3
    assert value["missing"][0]["globalId"] == "0" * 22
    groups = _value(adapter.group_boxes(index, {"wall": [NORTH_WALL], "pair": [NORTH_WALL, WINDOW]}))
    assert set(groups["groups"]) == {"wall", "pair"}
    assert groups["groups"]["pair"]["count"] == 2 and len(groups["groups"]["pair"]["union"]["min"]) == 3


def test_within_a_box_grown_around_an_element_finds_its_window(adapter, index) -> None:
    wall = _value(adapter.element_boxes(index, [NORTH_WALL]))["boxes"][0]
    box = {"min": [v - 0.1 for v in wall["min"]], "max": [v + 0.1 for v in wall["max"]]}
    value = _value(adapter.elements_within(index, box, None, 500))
    assert WINDOW in {e["globalId"] for e in value["elements"]}
    assert value["truncated"] is False


def test_near_an_element_and_near_a_point(adapter, index) -> None:
    near = _value(adapter.elements_near(index, point=None, global_id=NORTH_WALL, radius=0.5, limit=50))
    assert WINDOW in {e["globalId"] for e in near["elements"]}
    wall = _value(adapter.element_boxes(index, [NORTH_WALL]))["boxes"][0]
    at = _value(adapter.elements_near(index, point=wall["centroid"], global_id=None, radius=0.1, limit=50))
    assert NORTH_WALL in {e["globalId"] for e in at["elements"]}


def test_in_room_neighbours_and_clash_read_the_model(adapter, house) -> None:
    room = _value(adapter.elements_in_room(house, LIVING, budget=15))
    assert room["elements"]
    touching = _value(adapter.neighbours(house, NORTH_WALL, 0.05, budget=15))
    assert WINDOW in {e["globalId"] for e in touching["neighbours"]}
    pairs = _value(adapter.clash(house, [NORTH_WALL], None, "intersect", None, budget=15))
    assert "pairs" in pairs and "truncated" in pairs
    clearance = _value(adapter.clash(house, [LIVING], [BEDROOM], "clearance", 0.2, budget=15))
    assert "pairs" in clearance


def test_the_request_budget_reaches_the_engine_and_a_spent_one_says_so(adapter, house) -> None:
    pairs = adapter.clash(house, [LIVING], [BEDROOM], "clearance", 0.2, budget=0)
    assert pairs["value"]["truncated"] is True and "0 s" in pairs["caveat"]
    assert adapter.clash(house, [LIVING], [BEDROOM], "clearance", 0.2, budget=15)["value"]["truncated"] is False


def test_a_diff_of_a_model_with_itself_is_unchanged(adapter, index) -> None:
    value = _value(adapter.box_diff(index, index, [NORTH_WALL, WINDOW]))
    assert {e["status"] for e in value["elements"]} == {"unchanged"}


@pytest.mark.parametrize(
    "call",
    [
        lambda a, i, h: a.elements_near(i, point=None, global_id="0" * 22, radius=1, limit=10),
        lambda a, i, h: a.elements_near(i, point=None, global_id=NORTH_WALL, radius=500, limit=10),
        lambda a, i, h: a.clash(h, [NORTH_WALL], None, "clearance", None),
        lambda a, i, h: a.clash(h, [NORTH_WALL], None, "touch", 0.5),
        lambda a, i, h: a.elements_in_room(h, NORTH_WALL),
        lambda a, i, h: a.neighbours(h, "0" * 22, 0.05),
    ],
    ids=["unknown-id", "radius", "clearance-without", "touch-tolerance", "not-a-space", "unknown-neighbour"],
)
def test_the_engine_s_refusals_reach_the_caller_as_engine_refusals(adapter, index, house, call) -> None:
    with pytest.raises(EngineRefusal) as refused:
        call(adapter, index, house)
    assert str(refused.value)


def test_every_tool_runs_through_the_service_s_mcp_endpoint_on_the_real_engine(monkeypatch, house) -> None:
    """The whole path (MCP tools/call -> operations -> builds -> adapter -> engine) for each tool.

    The source is handed over as the BFF hands it (signed headers); only the download is local.
    Needs the agent package's full environment beside the engine (the root venv with
    ``packages/ifc-spatial-py`` installed, as the service image has); skipped in the engine's own.
    """
    pytest.importorskip("agent.knowledge.ifc_spatial_client")
    from geometry_service import index_cache
    from geometry_testing.service import SECRET
    from geometry_testing.service import call_tool
    from geometry_testing.service import headers_for

    from agent.common import cache
    from agent.knowledge import ifc_spatial_client as spatial

    monkeypatch.setenv("INTERNAL_API_TOKEN", SECRET)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setattr(cache, "_get_client", lambda: None)
    cache.reset_local_store()
    index_cache.memo_clear()
    monkeypatch.setattr(spatial, "open_model", lambda source, fetch=None: "house")
    monkeypatch.setattr(spatial, "resident_model", lambda source: house)
    model_id = "11111111-1111-4111-8111-111111111111"
    for operation in [
        {"op": "boxes", "globalIds": [NORTH_WALL]},
        {"op": "group-boxes", "groups": {"wall": [NORTH_WALL]}},
        {"op": "within", "aroundGlobalId": NORTH_WALL, "margin": 0.1},
        {"op": "near", "globalId": NORTH_WALL, "radius": 0.5},
        {"op": "in-room", "spaceGlobalId": LIVING},
        {"op": "neighbours", "globalId": NORTH_WALL},
        {"op": "clash", "setA": [NORTH_WALL]},
        {"op": "diff", "baseModelId": model_id, "globalIds": [NORTH_WALL]},
        {"op": "warm"},
    ]:
        body = {"modelId": model_id, "operation": operation}
        answer = call_tool(body, headers_for(body, models=(model_id,)))
        assert answer.status_code == 200, answer.text
        assert answer.json()["op"] == operation["op"]
        assert isinstance(answer.json()["result"]["value"], dict), operation
    assert answer.json()["result"]["value"] == {"status": "ready"}
