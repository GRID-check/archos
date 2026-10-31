"""The request body of ``POST /v1/internal/bim/geometry``: one operation, typed, with its limits.

The twin of ``apps/workspace/bff/bim/geometry-wire.ts``, which validates the same body first; the
limits are equal on purpose; change both together. Coordinates
are IFC world, Z-up, metres.
"""

from __future__ import annotations

from typing import Annotated
from typing import Literal

from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import model_validator

MAX_BOX_IDS = 500
MAX_GROUPS = 300
MAX_GROUP_IDS = 200
MAX_RESULT_LIMIT = 500
MAX_RADIUS_M = 50.0
MAX_MARGIN_M = 50.0
MAX_GAP_M = 1.0
#: The engine's own bounds (``operators_clash``): a contact tolerance, and a clearance to check.
MAX_CONTACT_TOLERANCE_M = 0.1
MAX_CLEARANCE_M = 5.0
MAX_CLASH_SET = 2000
MAX_IFC_TYPES = 50
#: A building is never a thousand kilometres across; this bounds a coordinate, not a model.
MAX_COORDINATE_M = 1_000_000.0

GlobalId = Annotated[str, Field(pattern=r"^[0-9A-Za-z_$]{22}$")]
Coordinate = Annotated[float, Field(ge=-MAX_COORDINATE_M, le=MAX_COORDINATE_M)]
Point = Annotated[list[Coordinate], Field(min_length=3, max_length=3)]


class _Op(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class Box(_Op):
    min: Point
    max: Point

    @model_validator(mode="after")
    def _ordered(self) -> Box:
        if any(low > high for low, high in zip(self.min, self.max, strict=True)):
            raise ValueError("box min must not exceed max on any axis")
        return self


class BoxesOp(_Op):
    op: Literal["boxes"]
    global_ids: list[GlobalId] = Field(alias="globalIds", min_length=1, max_length=MAX_BOX_IDS)


class GroupBoxesOp(_Op):
    op: Literal["group-boxes"]
    groups: dict[Annotated[str, Field(min_length=1, max_length=200)], list[GlobalId]] = Field(
        min_length=1, max_length=MAX_GROUPS
    )

    @model_validator(mode="after")
    def _bounded(self) -> GroupBoxesOp:
        if any(not 1 <= len(ids) <= MAX_GROUP_IDS for ids in self.groups.values()):
            raise ValueError(f"each group holds 1 to {MAX_GROUP_IDS} GlobalIds")
        return self


class WithinOp(_Op):
    op: Literal["within"]
    box: Box | None = None
    around_global_id: GlobalId | None = Field(default=None, alias="aroundGlobalId")
    margin: float = Field(default=0.5, ge=0, le=MAX_MARGIN_M)
    ifc_types: list[Annotated[str, Field(min_length=1, max_length=64)]] | None = Field(
        default=None, alias="ifcTypes", max_length=MAX_IFC_TYPES
    )
    limit: int = Field(default=200, ge=1, le=MAX_RESULT_LIMIT)

    @model_validator(mode="after")
    def _one_region(self) -> WithinOp:
        if (self.box is None) == (self.around_global_id is None):
            raise ValueError("give exactly one of box or aroundGlobalId")
        return self


class NearOp(_Op):
    op: Literal["near"]
    point: Point | None = None
    global_id: GlobalId | None = Field(default=None, alias="globalId")
    radius: float = Field(gt=0, le=MAX_RADIUS_M)
    limit: int = Field(default=200, ge=1, le=MAX_RESULT_LIMIT)

    @model_validator(mode="after")
    def _one_centre(self) -> NearOp:
        if (self.point is None) == (self.global_id is None):
            raise ValueError("give exactly one of point or globalId")
        return self


class InRoomOp(_Op):
    op: Literal["in-room"]
    space_global_id: GlobalId = Field(alias="spaceGlobalId")


class NeighboursOp(_Op):
    op: Literal["neighbours"]
    global_id: GlobalId = Field(alias="globalId")
    gap: float = Field(default=0.05, ge=0, le=MAX_GAP_M)


class ClashOp(_Op):
    op: Literal["clash"]
    set_a: list[GlobalId] = Field(alias="setA", min_length=1, max_length=MAX_CLASH_SET)
    set_b: list[GlobalId] | None = Field(default=None, alias="setB", min_length=1, max_length=MAX_CLASH_SET)
    mode: Literal["intersect", "touch", "clearance"] = "intersect"
    #: None lets the engine choose (5 mm for intersect and touch); clearance needs it.
    tolerance: float | None = Field(default=None, ge=0, le=MAX_CLEARANCE_M)

    @model_validator(mode="after")
    def _tolerance_for_mode(self) -> ClashOp:
        if self.mode == "clearance" and self.tolerance is None:
            raise ValueError("mode clearance needs tolerance: the clearance to check, in metres")
        if self.mode != "clearance" and self.tolerance is not None and self.tolerance > MAX_CONTACT_TOLERANCE_M:
            raise ValueError(f"tolerance for {self.mode} is at most {MAX_CONTACT_TOLERANCE_M} m")
        return self


class DiffOp(_Op):
    op: Literal["diff"]
    base_model_id: Annotated[str, Field(pattern=r"^[0-9a-fA-F-]{36}$")] = Field(alias="baseModelId")
    global_ids: list[GlobalId] | None = Field(default=None, alias="globalIds", max_length=MAX_BOX_IDS)


class WarmOp(_Op):
    op: Literal["warm"]


GeometryOp = Annotated[
    BoxesOp | GroupBoxesOp | WithinOp | NearOp | InRoomOp | NeighboursOp | ClashOp | DiffOp | WarmOp,
    Field(discriminator="op"),
]


class GeometryRequest(_Op):
    """The body: which model, and one operation on it."""

    model_id: Annotated[str, Field(pattern=r"^[0-9a-fA-F-]{36}$")] = Field(alias="modelId")
    operation: GeometryOp
    #: A diff's base model's own project (null: the office shelf), stated by the BFF after it passed
    #: that model's read gate. Absent, the envelope's project is used for both models.
    base_project_id: str | None = Field(default=None, alias="baseProjectId", max_length=64)

    def base_scope(self, project_id: str | None) -> str | None:
        return self.base_project_id if "base_project_id" in self.model_fields_set else project_id
