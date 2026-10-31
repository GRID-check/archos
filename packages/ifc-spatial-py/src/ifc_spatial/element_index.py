"""One axis-aligned box per product: the broad phase every proximity question starts from.

The geometry pass already triangulates every product once (1.5–1.9 s on the
sample house). What the proximity operators need from it is small — a box, a
centroid, the storey and whether the body could be built at all — and small
enough to keep beside the model, to serialise into a shared cache, and to answer
``which elements are in this box`` without opening the IFC again.

## Frame

IFC world coordinates, Z up, metres: the iterator runs with
``use-world-coords`` and IfcOpenShell converts the file's length unit to metres
on the way out, so a millimetre export and a metre export index identically.
That is the same frame a BCF viewpoint is written in.

## Precision

Coordinates are rounded to :data:`COORDINATE_DECIMALS` (0.1 mm) when the index is
built, not when it is written. Rounding on write would make a round trip change
the numbers; rounding once makes ``from_dict(to_dict(index))`` equal to the
index it came from, bit for bit.

## Wire shape

Columnar JSON, versioned by :data:`INDEX_SCHEMA` and :data:`INDEX_VERSION`.
A reader refuses any other schema or version rather than guessing; a cached
index in an old shape is rebuilt, never reinterpreted.
"""

from __future__ import annotations

import json
import math
import weakref
from collections import Counter
from dataclasses import dataclass
from dataclasses import field
from functools import cached_property
from typing import Any

import numpy as np

from .model import SpatialModel

#: Names the wire format. Changes only if the format stops being this one.
INDEX_SCHEMA = "ifc-spatial/element-index"
#: Bumped on any change to the columns or their meaning.
INDEX_VERSION = 1
#: 0.1 mm. Well inside the 5 mm coordinate tolerance every operator works to.
COORDINATE_DECIMALS = 4
#: A deserialised index larger than this is refused: the biggest corpus model
#: has about 40 000 products, and an index is input from a cache or a caller.
MAX_INDEX_ELEMENTS = 250_000

STATUS_OK = "ok"
STATUS_NO_REPRESENTATION = "no-representation"
STATUS_EMPTY_MESH = "empty-mesh"
STATUS_SHAPE_FAILED = "shape-failed"
#: More than one product in the file carries this GlobalId. ``by_guid`` cannot
#: tell them apart, so neither gets a box: a box for "one of them" would frame
#: or clash the wrong element without anybody noticing.
STATUS_DUPLICATE = "duplicate-global-id"
STATUSES = (STATUS_OK, STATUS_NO_REPRESENTATION, STATUS_EMPTY_MESH, STATUS_SHAPE_FAILED, STATUS_DUPLICATE)
#: ``via`` of a row whose box is the union of its ``IfcRelAggregates`` parts.
VIA_PARTS = "parts"
#: How deep and how wide the parts fallback walks. A curtain wall is two levels
#: (wall → panels and mullions), a stair three; the bound keeps a malformed
#: self-aggregating file from walking forever.
MAX_PART_DEPTH = 6
MAX_PARTS = 5000


class IndexFormatError(ValueError):
    """A serialised index this version cannot read. The caller rebuilds it."""


@dataclass(eq=False)
class ElementIndex:
    """Boxes and centroids for every ``IfcProduct``, in rows.

    ``mins``, ``maxs`` and ``centroids`` are ``(N, 3)`` float arrays; rows whose
    ``status`` is not ``ok`` hold NaN there. Everything else is a list of N.
    ``via`` is ``"parts"`` where the element has no body of its own and its box
    is the union of its aggregated parts (a curtain wall, a stair, a roof built
    from slabs), ``None`` otherwise.
    """

    schema_name: str
    global_ids: list[str]
    ifc_types: list[str]
    storeys: list[str | None]
    status: list[str]
    mins: np.ndarray
    maxs: np.ndarray
    centroids: np.ndarray
    via: list[str | None] = field(default_factory=list)
    source: str | None = None
    _rows: dict[str, int] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
        if not self.via:
            self.via = [None] * len(self.global_ids)
        self._rows = {gid: row for row, gid in enumerate(self.global_ids)}

    def __len__(self) -> int:
        return len(self.global_ids)

    def __eq__(self, other: object) -> bool:
        if not isinstance(other, ElementIndex):
            return NotImplemented
        return self.to_dict() == other.to_dict()

    __hash__ = None  # type: ignore[assignment]

    def row(self, global_id: str) -> int | None:
        return self._rows.get(global_id)

    @cached_property
    def ok(self) -> np.ndarray:
        """Boolean mask of the rows that carry a box."""
        return np.array([s == STATUS_OK for s in self.status], dtype=bool)

    def box(self, row: int) -> tuple[np.ndarray, np.ndarray]:
        return self.mins[row], self.maxs[row]

    def to_dict(self) -> dict[str, Any]:
        return {
            "schema": INDEX_SCHEMA,
            "version": INDEX_VERSION,
            "unit": "m",
            "frame": "ifc-world-z-up",
            "ifcSchema": self.schema_name,
            "source": self.source,
            "globalIds": list(self.global_ids),
            "ifcTypes": list(self.ifc_types),
            "storeys": list(self.storeys),
            "status": list(self.status),
            "via": list(self.via),
            "boxes": [_box_row(self.mins[i], self.maxs[i]) for i in range(len(self))],
            "centroids": [_point_row(self.centroids[i]) for i in range(len(self))],
        }

    def to_json(self) -> str:
        # `allow_nan=False`: NaN and Infinity are not JSON, and a reader in
        # another language would choke on them. Non-ok rows serialise as null.
        return json.dumps(self.to_dict(), separators=(",", ":"), allow_nan=False)

    @classmethod
    def from_json(cls, text: str) -> ElementIndex:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise IndexFormatError(f"element index is not JSON: {error.msg}") from None
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Any) -> ElementIndex:
        """Validate and read. Anything that would make a query lie is refused, not repaired."""
        _check_header(data)
        global_ids = _string_column(data, "globalIds", nullable=False)
        count = len(global_ids)
        if len(set(global_ids)) != count:
            raise IndexFormatError("element index globalIds must be unique")
        for column in ("ifcTypes", "storeys", "status", "via", "boxes", "centroids"):
            if not isinstance(data.get(column), list) or len(data[column]) != count:
                raise IndexFormatError(f"element index column {column} must have {count} rows")
        status = _string_column(data, "status", nullable=False)
        if any(s not in STATUSES for s in status):
            raise IndexFormatError(f"element index status must be one of {', '.join(STATUSES)}")
        via = _string_column(data, "via", nullable=True)
        if any(v not in (None, VIA_PARTS) for v in via):
            raise IndexFormatError(f"element index via must be null or {VIA_PARTS!r}")
        boxes = _float_rows(data["boxes"], 6, "boxes")
        centroids = _float_rows(data["centroids"], 3, "centroids")
        _check_rows(status, boxes, centroids)
        return cls(
            schema_name=str(data.get("ifcSchema") or "IFC4"),
            global_ids=global_ids,
            ifc_types=_string_column(data, "ifcTypes", nullable=False),
            storeys=_string_column(data, "storeys", nullable=True),
            status=status,
            mins=boxes[:, :3],
            maxs=boxes[:, 3:],
            centroids=centroids,
            via=via,
            source=None if data.get("source") is None else str(data["source"]),
        )


def _check_header(data: Any) -> None:
    if not isinstance(data, dict):
        raise IndexFormatError("element index must be a JSON object")
    if data.get("schema") != INDEX_SCHEMA or data.get("version") != INDEX_VERSION:
        raise IndexFormatError(
            f"element index must be schema {INDEX_SCHEMA!r} version {INDEX_VERSION}, "
            f"got {data.get('schema')!r} version {data.get('version')!r}"
        )
    ids = data.get("globalIds")
    if not isinstance(ids, list):
        raise IndexFormatError("element index has no globalIds column")
    if len(ids) > MAX_INDEX_ELEMENTS:
        raise IndexFormatError(f"element index has {len(ids)} rows, more than the {MAX_INDEX_ELEMENTS} allowed")


def _string_column(data: dict[str, Any], name: str, *, nullable: bool) -> list[Any]:
    values = data.get(name)
    if not isinstance(values, list):
        raise IndexFormatError(f"element index has no {name} column")
    for i, value in enumerate(values):
        if value is None and nullable:
            continue
        if not isinstance(value, str) or not value:
            raise IndexFormatError(f"element index {name}[{i}] must be a non-empty string")
    return list(values)


def _float_rows(rows: list[Any], width: int, name: str) -> np.ndarray:
    """``None`` rows become NaN; anything that is not ``width`` finite numbers is refused.

    ``bool`` is refused although Python calls it a number: ``true`` in a box is
    a corrupted row, not the coordinate 1.0.
    """
    out = np.full((len(rows), width), np.nan)
    for i, row in enumerate(rows):
        if row is None:
            continue
        numbers = isinstance(row, list) and len(row) == width
        if not numbers or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in row):
            raise IndexFormatError(f"element index {name}[{i}] must be {width} numbers or null")
        out[i] = [float(v) for v in row]
        if not np.isfinite(out[i]).all():
            raise IndexFormatError(f"element index {name}[{i}] must be finite")
    return out


def _check_rows(status: list[str], boxes: np.ndarray, centroids: np.ndarray) -> None:
    """An ``ok`` row has a box with min <= max and a centroid; any other row has neither."""
    has_box = np.isfinite(boxes).all(axis=1)
    has_centroid = np.isfinite(centroids).all(axis=1)
    for i, state in enumerate(status):
        if state != STATUS_OK and (has_box[i] or has_centroid[i]):
            raise IndexFormatError(f"element index row {i} is {state} and must have no box or centroid")
        if state != STATUS_OK:
            continue
        if not (has_box[i] and has_centroid[i]):
            raise IndexFormatError(f"element index row {i} is ok and must have a box and a centroid")
        if (boxes[i, 3:] < boxes[i, :3]).any():
            raise IndexFormatError(f"element index boxes[{i}] has max below min")


def _box_row(low: np.ndarray, high: np.ndarray) -> list[float] | None:
    if not (np.isfinite(low).all() and np.isfinite(high).all()):
        return None
    return [float(v) for v in (*low, *high)]


def _point_row(point: np.ndarray) -> list[float] | None:
    if not np.isfinite(point).all():
        return None
    return [float(v) for v in point]


# ── building one ────────────────────────────────────────────────────────────


@dataclass
class _Row:
    global_id: str
    ifc_type: str
    storey: str | None
    status: str
    box: tuple[np.ndarray, np.ndarray] | None = None
    centroid: np.ndarray | None = None
    via: str | None = None


def build_index(model: SpatialModel, source: str | None = None) -> ElementIndex:
    """Run (or reuse) the geometry pass and keep one row per ``IfcProduct`` GlobalId.

    Elements the iterator could not shape are not re-shaped one by one here:
    that is the slow path the pass exists to avoid. They are recorded with the
    reason the model already knows, or ``shape-failed`` when the iterator simply
    produced nothing for a product that carries a representation. An element
    without a body of its own whose aggregated parts have bodies gets their
    union, marked ``via: parts``.
    """
    shaped = model.geometry_pass()
    products = [p for p in model.file.by_type("IfcProduct") if getattr(p, "GlobalId", None)]
    counts = Counter(p.GlobalId for p in products)
    rows: list[_Row] = []
    emitted: set[str] = set()
    for product in products:
        global_id = product.GlobalId
        if global_id in emitted:
            continue
        emitted.add(global_id)
        if counts[global_id] > 1:
            rows.append(_Row(global_id, product.is_a(), None, STATUS_DUPLICATE))
            continue
        rows.append(_row_of(model, product, shaped))
    return _assemble(model, rows, source)


def _row_of(model: SpatialModel, product: Any, shaped: dict[str, Any]) -> _Row:
    row = _Row(product.GlobalId, product.is_a(), _storey_gid(model, product), STATUS_OK)
    geo = shaped.get(product.GlobalId)
    if geo is not None:
        row.box, row.centroid = (geo.box[0], geo.box[1]), geo.centroid
        return row
    # Elements only: a storey or a site also aggregates (its spaces), and a
    # storey's box is not something any locating question asks for.
    parts = _parts_box(product, shaped) if product.is_a("IfcElement") else None
    if parts is not None:
        row.box, row.via = parts, VIA_PARTS
        row.centroid = (parts[0] + parts[1]) / 2.0
        return row
    row.status = _status_of(model, product)
    return row


def _parts_box(product: Any, shaped: dict[str, Any]) -> tuple[np.ndarray, np.ndarray] | None:
    """Union of the shaped boxes of everything aggregated under ``product``, bounded."""
    lows: list[np.ndarray] = []
    highs: list[np.ndarray] = []
    frontier, seen = [product], {product.id()}
    for _ in range(MAX_PART_DEPTH):
        children = [c for p in frontier for rel in (p.IsDecomposedBy or []) for c in rel.RelatedObjects]
        frontier = [c for c in children if c.id() not in seen][:MAX_PARTS]
        seen.update(c.id() for c in frontier)
        boxes = [shaped[c.GlobalId].box for c in frontier if getattr(c, "GlobalId", None) in shaped]
        lows.extend(b[0] for b in boxes)
        highs.extend(b[1] for b in boxes)
        if not frontier or len(seen) > MAX_PARTS:
            break
    if not lows:
        return None
    return np.min(lows, axis=0), np.max(highs, axis=0)


def _assemble(model: SpatialModel, rows: list[_Row], source: str | None) -> ElementIndex:
    count = len(rows)
    mins, maxs, centroids = (np.full((count, 3), np.nan) for _ in range(3))
    for i, row in enumerate(rows):
        if row.box is None or row.centroid is None:
            continue
        mins[i] = np.round(row.box[0], COORDINATE_DECIMALS)
        maxs[i] = np.round(row.box[1], COORDINATE_DECIMALS)
        centroids[i] = np.round(row.centroid, COORDINATE_DECIMALS)
    return ElementIndex(
        schema_name=str(model.file.schema),
        global_ids=[r.global_id for r in rows],
        ifc_types=[r.ifc_type for r in rows],
        storeys=[r.storey for r in rows],
        status=[r.status for r in rows],
        mins=mins,
        maxs=maxs,
        centroids=centroids,
        via=[r.via for r in rows],
        source=source,
    )


def _status_of(model: SpatialModel, product: Any) -> str:
    if not getattr(product, "Representation", None):
        return STATUS_NO_REPRESENTATION
    reason = model.geometry_failure(product.GlobalId) or ""
    if reason == STATUS_EMPTY_MESH or product.GlobalId in model._geometry:  # noqa: SLF001 — the pass's own record
        return STATUS_EMPTY_MESH
    return STATUS_SHAPE_FAILED


def _storey_gid(model: SpatialModel, product: Any) -> str | None:
    storey = model.storey_of(product)
    return None if storey is None else storey.GlobalId


_INDEXES: weakref.WeakKeyDictionary[SpatialModel, ElementIndex] = weakref.WeakKeyDictionary()


def element_index(model: SpatialModel) -> ElementIndex:
    """The index for this model, built once per open model and kept beside it."""
    index = _INDEXES.get(model)
    if index is None:
        index = build_index(model)
        _INDEXES[model] = index
    return index


def finite_box(values: Any, name: str) -> tuple[np.ndarray, np.ndarray]:
    """A caller's ``{min, max}`` box as two arrays, or ``ValueError`` naming the defect."""
    if not isinstance(values, dict):
        raise ValueError(f"{name} must be an object with min and max, each [x, y, z] in metres")
    low = finite_point(values.get("min"), f"{name}.min")
    high = finite_point(values.get("max"), f"{name}.max")
    if (high < low).any():
        raise ValueError(f"{name}.max must not be below {name}.min on any axis")
    return low, high


def finite_point(values: Any, name: str) -> np.ndarray:
    if not isinstance(values, (list, tuple)) or len(values) != 3:
        raise ValueError(f"{name} must be [x, y, z] in metres")
    if any(isinstance(v, bool) or not isinstance(v, (int, float, str)) for v in values):
        raise ValueError(f"{name} must be three numbers")
    try:
        point = np.array([float(v) for v in values])
    except TypeError, ValueError:
        raise ValueError(f"{name} must be three numbers") from None
    if not all(math.isfinite(v) for v in point):
        raise ValueError(f"{name} must be finite")
    return point


__all__ = [
    "INDEX_SCHEMA",
    "INDEX_VERSION",
    "STATUS_DUPLICATE",
    "VIA_PARTS",
    "ElementIndex",
    "IndexFormatError",
    "build_index",
    "element_index",
    "finite_box",
    "finite_point",
]
