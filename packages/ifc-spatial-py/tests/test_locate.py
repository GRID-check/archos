"""The locating operators: element index, boxes, regions, rooms, neighbours, clashes and diffs.

Measured on the sample house, whose facts these tests lean on:

- the north wall ``3cUkl32yn9qRSPvBJVyWw5`` hosts three windows, among them
  ``3cUkl32yn9qRSPvBJVyWcE`` (``IfcRelFillsElement`` through an opening);
- the living room ``…0U`` and the bedroom ``…0J`` are separated by one 95 mm
  partition, which is what ``clearance.clear_width`` measures between them;
- the living room declares twelve pieces of furniture by containment.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import ifcopenshell
import numpy as np
import pytest
from ifc_spatial.element_index import INDEX_SCHEMA
from ifc_spatial.element_index import INDEX_VERSION
from ifc_spatial.element_index import ElementIndex
from ifc_spatial.element_index import IndexFormatError
from ifc_spatial.element_index import build_index
from ifc_spatial.element_index import element_index
from ifc_spatial.model import SpatialModel
from ifc_spatial.operators_clash import clash
from ifc_spatial.operators_clash import neighbours
from ifc_spatial.operators_diff import box_diff
from ifc_spatial.operators_measures import extent
from ifc_spatial.operators_proximity import element_boxes
from ifc_spatial.operators_proximity import elements_in_room
from ifc_spatial.operators_proximity import elements_near
from ifc_spatial.operators_proximity import elements_within
from ifc_spatial.operators_proximity import group_boxes
from ifc_spatial.tools import call
from ifc_spatial.tools import create_tools

FIXTURES = Path(__file__).resolve().parents[2] / "ifc-spatial" / "test" / "fixtures"
HOUSE = FIXTURES / "Ifc4_SampleHouse.ifc"
BASEMENT = FIXTURES / "basement-brep-room.ifc"
NO_BODIES = FIXTURES / "house-with-rooms.ifc"

NORTH_WALL = "3cUkl32yn9qRSPvBJVyWw5"
WINDOW = "3cUkl32yn9qRSPvBJVyWcE"
LIVING = "3w0zWKm7n8SB1qbfwUzt0U"
BEDROOM = "3w0zWKm7n8SB1qbfwUzt0J"
BASEMENT_SLAB = "3QoJ6BxnbEJAsAxl5gQcR_"
BASEMENT_ROOM = "0dXE$xLxz8MwbtYoTqJPiO"


@pytest.fixture(scope="module")
def house() -> SpatialModel:
    return SpatialModel(str(HOUSE))


@pytest.fixture(scope="module")
def index(house: SpatialModel) -> ElementIndex:
    return element_index(house)


def _declared_contents(model: SpatialModel, space: str) -> set[str]:
    return {e.GlobalId for rel in model.file.by_guid(space).ContainsElements for e in rel.RelatedElements}


# ── the index ───────────────────────────────────────────────────────────────


def test_a_walls_index_box_is_its_extent(house: SpatialModel, index: ElementIndex) -> None:
    measured = extent(house, NORTH_WALL).value["box"]
    row = index.row(NORTH_WALL)
    assert index.status[row] == "ok"
    assert index.mins[row] == pytest.approx(measured["min"], abs=1e-4)
    assert index.maxs[row] == pytest.approx(measured["max"], abs=1e-4)
    assert index.storeys[row] == house.storey_of(house.file.by_guid(NORTH_WALL)).GlobalId


def test_the_index_round_trips_through_json_exactly(index: ElementIndex) -> None:
    text = index.to_json()
    again = ElementIndex.from_json(text)
    assert again == index
    assert again.to_json() == text
    data = json.loads(text)
    assert (data["schema"], data["version"], data["unit"]) == (INDEX_SCHEMA, INDEX_VERSION, "m")
    # The size budget the cache was designed around: about 100 bytes per element.
    assert len(text) / len(index) < 200


def test_an_index_in_another_version_is_refused_not_reinterpreted(index: ElementIndex) -> None:
    data = index.to_dict()
    data["version"] = INDEX_VERSION + 1
    with pytest.raises(IndexFormatError, match="version"):
        ElementIndex.from_dict(data)
    data = index.to_dict()
    data["boxes"][0] = [1, 2, 3]
    with pytest.raises(IndexFormatError, match="boxes"):
        ElementIndex.from_dict(data)


def test_products_without_a_body_are_rows_with_a_reason(index: ElementIndex) -> None:
    storey = index.ifc_types.index("IfcBuildingStorey")
    assert index.status[storey] == "no-representation"
    assert not np.isfinite(index.mins[storey]).any()


# ── boxes ───────────────────────────────────────────────────────────────────


def test_unknown_and_bodiless_ids_come_back_missing_with_the_reason(index: ElementIndex) -> None:
    storey = index.global_ids[index.ifc_types.index("IfcBuildingStorey")]
    answer = element_boxes(index, [NORTH_WALL, "0000000000000000000000", storey])
    assert answer.provenance == "computed" and answer.decidable
    assert [b["globalId"] for b in answer.value["boxes"]] == [NORTH_WALL]
    assert answer.value["missing"] == [
        {"globalId": "0000000000000000000000", "reason": "unknown-global-id"},
        {"globalId": storey, "reason": "no-representation"},
    ]
    assert answer.from_ == [NORTH_WALL]


def test_a_model_without_bodies_answers_every_id_missing() -> None:
    model = SpatialModel(str(NO_BODIES))
    answer = element_boxes(element_index(model), ["2Haus0Raeume00Wall0001"])
    assert answer.value["boxes"] == [] and answer.value["union"] is None
    assert answer.value["missing"] == [{"globalId": "2Haus0Raeume00Wall0001", "reason": "no-representation"}]
    assert answer.caveat


def test_group_boxes_is_the_union_of_its_members(index: ElementIndex) -> None:
    answer = group_boxes(index, {"rooms": [LIVING, BEDROOM], "wall": [NORTH_WALL], "none": ["nope"]})
    groups = answer.value["groups"]
    living, bedroom = index.row(LIVING), index.row(BEDROOM)
    assert groups["rooms"]["union"]["min"] == pytest.approx(np.minimum(index.mins[living], index.mins[bedroom]))
    assert groups["rooms"]["union"]["max"] == pytest.approx(np.maximum(index.maxs[living], index.maxs[bedroom]))
    assert groups["rooms"]["count"] == 2
    assert groups["wall"]["union"]["min"] == pytest.approx(index.mins[index.row(NORTH_WALL)])
    assert groups["none"] == {
        "union": None,
        "count": 0,
        "missing": [{"globalId": "nope", "reason": "unknown-global-id"}],
    }


# ── regions and rooms ───────────────────────────────────────────────────────


def test_elements_within_a_rooms_box_are_that_rooms_contents(house: SpatialModel, index: ElementIndex) -> None:
    row = index.row(LIVING)
    answer = elements_within(index, (index.mins[row], index.maxs[row]), ifc_types=["IfcFurnishingElement"])
    found = {e["globalId"] for e in answer.value["elements"]}
    assert found == _declared_contents(house, LIVING)
    assert answer.value["truncated"] is False
    # Walls bound the room; they are not inside its box.
    everything = elements_within(index, (index.mins[row], index.maxs[row]))
    assert NORTH_WALL not in {e["globalId"] for e in everything.value["elements"]}


def test_elements_in_room_tags_each_route(house: SpatialModel) -> None:
    answer = elements_in_room(house, LIVING)
    tags = {e["globalId"]: e["provenance"] for e in answer.value["elements"]}
    declared = _declared_contents(house, LIVING)
    assert all(tags[gid] == "both" for gid in declared)
    assert answer.provenance == "computed" and answer.value["geometryUsed"]
    assert BEDROOM not in tags and LIVING not in tags


def test_elements_near_a_point_and_exact_near_an_element(house: SpatialModel, index: ElementIndex) -> None:
    centroid = index.centroids[index.row(WINDOW)]
    near_point = elements_near(index, point=centroid, radius=0.01)
    assert WINDOW in [e["globalId"] for e in near_point.value["elements"]]
    exact = elements_near(index, global_id=WINDOW, radius=0.05, model=house)
    distances = {e["globalId"]: e["distance"] for e in exact.value["elements"]}
    assert distances[NORTH_WALL] == pytest.approx(0.0, abs=1e-3)
    assert exact.value["mode"] == "exact"


# ── pairs ───────────────────────────────────────────────────────────────────


def test_a_windows_neighbours_include_its_host_wall(house: SpatialModel) -> None:
    answer = neighbours(house, WINDOW)
    found = {n["globalId"]: n for n in answer.value["neighbours"]}
    assert found[NORTH_WALL]["kind"] == "touching"
    assert all(n["ifcType"] != "IfcOpeningElement" for n in found.values())
    assert answer.provenance == "computed"


def test_two_rooms_clash_at_the_partition_distance_and_do_not_intersect(house: SpatialModel) -> None:
    near = clash(house, [LIVING], [BEDROOM], mode="clearance", tolerance=0.2)
    assert len(near.value["pairs"]) == 1
    pair = near.value["pairs"][0]
    assert pair["kind"] == "clearance"
    assert pair["distance"] == pytest.approx(0.095, abs=0.002)
    assert clash(house, [LIVING], [BEDROOM], mode="intersect").value["pairs"] == []
    assert clash(house, [LIVING], [BEDROOM], mode="touch").value["pairs"] == []


def test_a_window_in_its_wall_is_hosting_not_a_clash(house: SpatialModel) -> None:
    answer = clash(house, [NORTH_WALL, WINDOW], mode="intersect")
    assert answer.value["pairs"] == []
    assert answer.value["skippedHosted"] == 1
    assert answer.value["truncated"] is False and answer.caveat is None


def test_a_room_against_its_own_furniture_intersects(house: SpatialModel) -> None:
    sofa = sorted(_declared_contents(house, LIVING))[0]
    answer = clash(house, [LIVING], [sofa], mode="intersect")
    assert [p["kind"] for p in answer.value["pairs"]] == ["intersect"]


# ── revisions ───────────────────────────────────────────────────────────────


def _moved_copy(tmp_path: Path, global_id: str, offset_mm: float) -> Path:
    """The basement fixture with one element shifted along X — a new point, so nothing shared moves."""
    target = tmp_path / "moved.ifc"
    shutil.copy(BASEMENT, target)
    model = ifcopenshell.open(str(target))
    placement = model.by_guid(global_id).ObjectPlacement.RelativePlacement
    x, y, z = placement.Location.Coordinates
    placement.Location = model.createIfcCartesianPoint((x + offset_mm * _per_mm(model), y, z))
    model.write(str(target))
    return target


def _per_mm(model: ifcopenshell.file) -> float:
    import ifcopenshell.util.unit as uu

    return 0.001 / uu.calculate_unit_scale(model)


def test_box_diff_reports_the_moved_element_and_nothing_else(tmp_path: Path) -> None:
    base = build_index(SpatialModel(str(BASEMENT)))
    current = build_index(SpatialModel(str(_moved_copy(tmp_path, BASEMENT_SLAB, 250.0))))
    whole = box_diff(base, current)
    assert [(e["globalId"], e["status"]) for e in whole.value["elements"]] == [(BASEMENT_SLAB, "moved")]
    assert whole.value["elements"][0]["centroidDelta"] == pytest.approx([0.25, 0.0, 0.0], abs=1e-3)
    assert whole.value["counts"]["unchanged"] == 1
    listed = box_diff(base, current, [BASEMENT_SLAB, BASEMENT_ROOM, "gone"])
    assert [e["status"] for e in listed.value["elements"]] == ["moved", "unchanged", "no-geometry"]
    assert listed.provenance == "computed"


def test_box_diff_through_the_tool_takes_a_stored_index(tmp_path: Path) -> None:
    tools = create_tools()
    base = call(tools, "open_model", {"path": str(BASEMENT)})["model"]
    moved = call(tools, "open_model", {"path": str(_moved_copy(tmp_path, BASEMENT_SLAB, 100.0))})["model"]
    stored = element_index(SpatialModel(str(BASEMENT))).to_dict()
    by_model = call(tools, "box_diff", {"model": moved, "baseModel": base})
    by_index = call(tools, "box_diff", {"model": moved, "baseIndex": stored})
    assert by_model["value"] == by_index["value"]
    assert by_model["value"]["counts"]["moved"] == 1


# ── the tool surface ────────────────────────────────────────────────────────


def test_every_locate_tool_answers_through_call_with_provenance() -> None:
    tools = create_tools()
    handle = call(tools, "open_model", {"path": str(BASEMENT)})["model"]
    calls = {
        "element_boxes": {"globalIds": [BASEMENT_SLAB]},
        "group_boxes": {"groups": {"a": [BASEMENT_SLAB, BASEMENT_ROOM]}},
        "elements_within": {"box": {"min": [-100, -100, -100], "max": [100, 100, 100]}},
        "elements_near": {"globalId": BASEMENT_ROOM, "radius": 1},
        "elements_in_room": {"spaceGlobalId": BASEMENT_ROOM},
        "neighbours": {"globalId": BASEMENT_ROOM},
        "clash": {"setA": [BASEMENT_SLAB, BASEMENT_ROOM], "mode": "touch"},
    }
    for name, args in calls.items():
        result = call(tools, name, {"model": handle, **args})
        assert result["provenance"] in ("declared", "computed", "inferred"), name
        assert result["method"] and isinstance(result["from"], list), name
        json.dumps(result)
