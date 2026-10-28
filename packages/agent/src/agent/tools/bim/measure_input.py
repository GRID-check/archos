"""The validated input the ifc_measure tool takes, and the checks that refuse a call before it reaches the engine."""

from typing import Any

from pydantic import BaseModel
from pydantic import Field
from pydantic import field_validator
from pydantic import model_validator

from agent.tools.bim.measure_vocab import _CASE_FOLDED
from agent.tools.bim.measure_vocab import _LEGACY_TOKENS
from agent.tools.bim.measure_vocab import DISTANCE_MODES
from agent.tools.bim.measure_vocab import ENVELOPE_ASPECTS
from agent.tools.bim.measure_vocab import FIRE_ASPECTS
from agent.tools.bim.measure_vocab import KINDS
from agent.tools.bim.measure_vocab import MAX_BATCH
from agent.tools.bim.measure_vocab import MEASURES
from agent.tools.bim.measure_vocab import OPERATIONS
from agent.tools.bim.measure_vocab import PROFILE_KINDS
from agent.tools.bim.measure_vocab import RELATIONS
from agent.tools.bim.measure_vocab import ROOM_KINDS
from agent.tools.bim.measure_vocab import VIEW_MODES
from agent.tools.bim.measure_vocab import _canonical
from agent.tools.bim.measure_vocab import _enum_lines
from agent.tools.bim.measure_vocab import _literal
from agent.tools.bim.measure_vocab import _record_misses


class IfcMeasureInput(BaseModel):
    """The arguments of one ``ifc_measure`` call, as the model sees them."""

    operation: _literal(OPERATIONS) = Field(
        description=(
            "WHICH question to ask. The only required argument — every other field is scoped by this "
            "one. On a model you have not looked at yet, 'briefing'."
        )
    )
    global_id: str | list[str] = Field(
        default="",
        description=(
            "The element's IFC GlobalId, from 'find_elements', from 'element', or from an ifc_query "
            "result in THIS turn — an invented id is refused by name, not guessed at. Usually ONE id. "
            "A list (or one comma-separated string) where the question is about a set: 'measure' over "
            f"an already-known selection (at most {MAX_BATCH}, each element keeping its own answer, "
            "tolerance and refusal), 'view' to mark several at once, 'fire' with kind='compartmentArea' "
            "for the rooms of the compartment — and exactly two rooms for kind='separatingElements'. "
            "'envelope' takes none: an envelope is not a property of an element. The selecting "
            "operations ('find_elements', 'survey', 'draw') and the whole-model ones need none either."
        ),
    )
    other_global_id: str | list[str] = Field(
        default="",
        description=(
            "The SECOND element, and it means a different thing per operation. 'distance' and "
            "'clearance': the element to measure against. 'overhang': the element whose outer face is "
            "the REFERENCE plane, while global_id is the projecting one (get it from "
            "relations/hostedIn on the window). 'light_incidence': the elements EXCLUDED from the test "
            "— a list, or several ids separated by commas. Unused by every other operation."
        ),
    )
    relation: _literal(RELATIONS) | None = Field(
        default=None,
        description=(
            "'relations' only — which topological question to ask about global_id:\n"
            f"{_enum_lines(RELATIONS)}\n"
            "The ones marked [geometry] cost seconds on a cold model — see COST."
        ),
    )
    measure: _literal(MEASURES) | None = Field(
        default=None,
        description=(
            f"'measure' (one element) and 'survey' (a whole selection) — WHICH quantity:\n{_enum_lines(MEASURES)}"
        ),
    )
    mode: _literal(DISTANCE_MODES, VIEW_MODES) | None = Field(
        default=None,
        description=(
            "Two vocabularies on one field, scoped by operation.\n"
            "  'distance' (default 'min'):\n"
            f"{_enum_lines(DISTANCE_MODES, indent='    ')}\n"
            "  NONE of those four is a clear dimension. For a lichte Breite use measure='clearWidth' on "
            "the opening, for a lichte Höhe measure='clearHeight' on the room, and for the smallest "
            "surface-to-surface gap between two elements operation='clearance'.\n"
            "  'view' (default 'highlight'):\n"
            f"{_enum_lines(VIEW_MODES, indent='    ')}\n"
            "Unused by every other operation."
        ),
    )
    ifc_type: str = Field(
        default="",
        description=(
            "'find_elements', 'survey' and 'draw' — the IFC CLASS, e.g. IfcSpace, IfcWindow, IfcDoor. "
            "The spatial role goes in 'kind' instead."
        ),
    )
    name_contains: str = Field(
        default="",
        description=(
            "'find_elements' and 'survey' — a substring of the element's name. Take it from the "
            "briefing or from an earlier result; an invented fragment matches nothing."
        ),
    )
    storey: str = Field(
        default="",
        description=(
            "'find_elements', 'survey', 'draw' and 'view' — the storey name EXACTLY as the briefing "
            "spells it. A storey name you invented matches nothing, and an empty result reads like "
            "'the building has none'."
        ),
    )
    kind: _literal(KINDS, FIRE_ASPECTS, ENVELOPE_ASPECTS, PROFILE_KINDS) | None = Field(
        default=None,
        description=(
            "Three vocabularies on one field, scoped by operation.\n"
            "  'find_elements' and 'survey' — the spatial ROLE, not the IFC type (a room is 'space'): "
            f"{', '.join(KINDS)}.\n"
            "  'fire' — which OIB 2 (Brandschutz) geometry, default 'escape_level':\n"
            f"{_enum_lines(FIRE_ASPECTS, indent='    ')}\n"
            "  'envelope' — which OIB 6 (Wärmeschutz) geometry of the WHOLE building, default "
            "'thermalEnvelope':\n"
            f"{_enum_lines(ENVELOPE_ASPECTS, indent='    ')}\n"
            "  'element_profile' — 'expensive' to include escape route, reachability, turning circle "
            "and door approach, which are left out otherwise.\n"
            "Unused by every other operation."
        ),
    )
    room_kind: _literal(ROOM_KINDS) | None = Field(
        default=None,
        description=(
            "'room_inventory' only — which SUSPECTED use to group the rooms by. Inferred from their "
            "names: a proposal for a human to confirm, never a finding."
        ),
    )
    model_name: str = Field(
        default="",
        description=(
            "A substring of the file name, to pick one model when the project has several. Leave it "
            "empty when there is only one."
        ),
    )
    limit: int = Field(
        default=0,
        description=(
            "How many rows: 'find_elements' up to 500, 'survey' up to 50 — every row there is a real "
            "geometric measurement and not an index lookup. 0 leaves the server's default."
        ),
    )
    # `None`, not `0.0`: „not given" must stay distinguishable from „zero
    # degrees". The bounds are the tool's own, so the schema refuses what the
    # engine would.
    angle_deg: float | None = Field(
        default=None,
        gt=0.0,
        lt=90.0,
        description=(
            "'light_incidence' only — the Lichteinfallswinkel in degrees, strictly between 0 and 90. "
            "It is a fact about the BESTIMMUNG and not about the model (OIB 3: 45, with swivel_deg 30). "
            "This tool refuses without it rather than defaulting, because supplying it would be "
            "applying the clause."
        ),
    )
    swivel_deg: float | None = Field(
        default=None,
        ge=0.0,
        lt=90.0,
        description=(
            "'light_incidence' only — the lateral Verschwenkung in degrees, from 0 to under 90. From "
            "the Bestimmung as well (OIB 3: 30)."
        ),
    )
    when: str = Field(
        default="",
        description=(
            "'sun_position' only — an ISO 8601 instant WITH a time zone, e.g. "
            "'2026-06-21T12:00:00+02:00' (Austrian summer time) or '2026-06-21T10:00:00Z'. A timestamp "
            "without a zone is refused rather than read as UTC: Austria runs UTC+1 and UTC+2, so "
            "reading 12:00 as UTC moves the sun 30° east of where it stood."
        ),
    )

    @model_validator(mode="before")
    @classmethod
    def _fold_case(cls, data: Any) -> Any:
        """Case-fold what the tool has always case-folded, and keep the ledger.

        A ``Literal`` is case-sensitive; ``kind='Compactness'`` has always been
        answered, so the canonical spelling is substituted before the enum
        runs. Whatever is still unknown afterwards is left for the ``Literal``
        to refuse — after :func:`record_gap` has written down what was wanted,
        because the refusal never reaches the tool body and the backlog would
        otherwise go quiet exactly as refusals got cheaper.
        """
        if not isinstance(data, dict):
            return data
        data = dict(data)
        for name, vocabulary in _CASE_FOLDED.items():
            asked = data.get(name)
            if isinstance(asked, str) and asked.strip():
                legacy = _LEGACY_TOKENS.get(name, {}).get(asked.strip().lower())
                data[name] = legacy or _canonical(asked, vocabulary)
        _record_misses(data)
        return data

    @field_validator("ifc_type", "name_contains", "storey", "model_name", "when", mode="after")
    @classmethod
    def _stripped(cls, value: str) -> str:
        return value.strip()

    @field_validator("global_id", "other_global_id", mode="after")
    @classmethod
    def _ids_on_one_line(cls, value: str | list[str]) -> str:
        """A real array where the wire can carry one, a comma string underneath.

        The engine's `highlight`, `only` and `exclude` have always been arrays,
        and this field was narrower than they were: a caller who had a list had
        to know to join it. `list[str]` is expressible in the wire schema — it
        is an ordinary `type: array` and needs no `anyOf` gymnastics — so it is
        offered, and the comma-separated string every existing caller and the
        whole description already use is normalised onto it rather than
        deprecated. Both reach the call builders as the one shape they parse.
        """
        parts = value if isinstance(value, list) else str(value).split(",")
        return ",".join(str(part).strip() for part in parts if str(part).strip())

    @model_validator(mode="after")
    def _a_batch_fits_in_one_call(self) -> IfcMeasureInput:
        """The engine's own ceiling, applied before the model is downloaded.

        `measure` over more than :data:`MAX_BATCH` ids is refused by the engine
        — but only after the file has been resolved, fetched and tessellated,
        which is seconds and one of five turns spent to be told to count. Every
        other operation that takes a list has no such ceiling, so none is
        invented for them here.
        """
        if self.operation == "measure":
            count = len([part for part in str(self.global_id).split(",") if part])
            if count > MAX_BATCH:
                raise ValueError(
                    f"operation='measure' takes at most {MAX_BATCH} GlobalIds in one call — "
                    f"{count} were given. Measure in several calls, or narrow the selection with "
                    "operation='survey', which selects and measures in one."
                )
        return self
