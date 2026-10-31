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
STATUSES = (STATUS_OK, STATUS_NO_REPRESENTATION, STATUS_EMPTY_MESH, STATUS_SHAPE_FAILED)


class IndexFormatError(ValueError):
    """A serialised index this version cannot read. The caller rebuilds it."""


@dataclass(eq=False)
class ElementIndex:
    """Boxes and centroids for every ``IfcProduct``, in rows.

    ``mins``, ``maxs`` and ``centroids`` are ``(N, 3)`` float arrays; rows whose
    ``status`` is not ``ok`` hold NaN there. Everything else is a list of N.
    """

    schema_name: str
    global_ids: list[str]
    ifc_types: list[str]
    storeys: list[str | None]
    status: list[str]
    mins: np.ndarray
    maxs: np.ndarray
    centroids: np.ndarray
    source: str | None = None
    _rows: dict[str, int] = field(default_factory=dict, repr=False)

    def __post_init__(self) -> None:
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
            "boxes": [_box_row(self.mins[i], self.maxs[i]) for i in range(len(self))],
            "centroids": [_point_row(self.centroids[i]) for i in range(len(self))],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"))

    @classmethod
    def from_json(cls, text: str) -> ElementIndex:
        try:
            data = json.loads(text)
        except json.JSONDecodeError as error:
            raise IndexFormatError(f"element index is not JSON: {error.msg}") from None
        return cls.from_dict(data)

    @classmethod
    def from_dict(cls, data: Any) -> ElementIndex:
        _check_header(data)
        count = len(data["globalIds"])
        columns = ("ifcTypes", "storeys", "status", "boxes", "centroids")
        if any(not isinstance(data.get(c), list) or len(data[c]) != count for c in columns):
            raise IndexFormatError(f"element index columns must all have {count} rows")
        boxes = _float_rows(data["boxes"], 6, "boxes")
        centroids = _float_rows(data["centroids"], 3, "centroids")
        status = [str(s) for s in data["status"]]
        if any(s not in STATUSES for s in status):
            raise IndexFormatError(f"element index status must be one of {', '.join(STATUSES)}")
        return cls(
            schema_name=str(data.get("ifcSchema") or "IFC4"),
            global_ids=[str(g) for g in data["globalIds"]],
            ifc_types=[str(t) for t in data["ifcTypes"]],
            storeys=[None if s is None else str(s) for s in data["storeys"]],
            status=status,
            mins=boxes[:, :3],
            maxs=boxes[:, 3:],
            centroids=centroids,
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


def _float_rows(rows: list[Any], width: int, name: str) -> np.ndarray:
    """``None`` rows become NaN; anything that is not ``width`` numbers is refused."""
    out = np.full((len(rows), width), np.nan)
    for i, row in enumerate(rows):
        if row is None:
            continue
        if not isinstance(row, list) or len(row) != width:
            raise IndexFormatError(f"element index {name}[{i}] must be {width} numbers or null")
        try:
            out[i] = [float(v) for v in row]
        except TypeError, ValueError:
            raise IndexFormatError(f"element index {name}[{i}] must be {width} numbers or null") from None
    return out


def _box_row(low: np.ndarray, high: np.ndarray) -> list[float] | None:
    if not np.isfinite(low).all():
        return None
    return [float(v) for v in (*low, *high)]


def _point_row(point: np.ndarray) -> list[float] | None:
    if not np.isfinite(point).all():
        return None
    return [float(v) for v in point]


# ── building one ────────────────────────────────────────────────────────────


def build_index(model: SpatialModel, source: str | None = None) -> ElementIndex:
    """Run (or reuse) the geometry pass and keep one row per ``IfcProduct``.

    Elements the iterator could not shape are not re-shaped one by one here:
    that is the slow path the pass exists to avoid. They are recorded with the
    reason the model already knows, or ``shape-failed`` when the iterator simply
    produced nothing for a product that carries a representation.
    """
    shaped = model.geometry_pass()
    products = [p for p in model.file.by_type("IfcProduct") if getattr(p, "GlobalId", None)]
    count = len(products)
    mins = np.full((count, 3), np.nan)
    maxs = np.full((count, 3), np.nan)
    centroids = np.full((count, 3), np.nan)
    status: list[str] = []
    for row, product in enumerate(products):
        geo = shaped.get(product.GlobalId)
        status.append(_status_of(model, product, geo is not None))
        if geo is None:
            continue
        mins[row] = np.round(geo.box[0], COORDINATE_DECIMALS)
        maxs[row] = np.round(geo.box[1], COORDINATE_DECIMALS)
        centroids[row] = np.round(geo.centroid, COORDINATE_DECIMALS)
    return ElementIndex(
        schema_name=str(model.file.schema),
        global_ids=[p.GlobalId for p in products],
        ifc_types=[p.is_a() for p in products],
        storeys=[_storey_gid(model, p) for p in products],
        status=status,
        mins=mins,
        maxs=maxs,
        centroids=centroids,
        source=source,
    )


def _status_of(model: SpatialModel, product: Any, shaped: bool) -> str:
    if shaped:
        return STATUS_OK
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
    "ElementIndex",
    "IndexFormatError",
    "build_index",
    "element_index",
    "finite_box",
    "finite_point",
]
