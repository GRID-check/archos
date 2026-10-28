"""Pydantic models for Grid response cards.

## Every text field on every card is PLAIN TEXT

No card renderer parses markup. The frontend sets each string into JSX, where
React escapes it, so a field that arrives holding ``[OIB-Richtlinie ansehen](
https://www.oib.or.at/de/oib-richtlinien)`` puts those brackets on screen — next
to the card's own working source link, which is what a production ``legal_basis``
card did. The contract was never written down anywhere, which is why the model
could not be said to have broken it.

It is written down here, and :class:`CardModel` enforces it: the delimiters are
removed at validation time, on every emission path, so a card cannot display raw
markup. The enforcement deliberately does NOT live in the renderer. A card is the
part that gets screenshotted into an Einreichung; a renderer that quietly parses
markdown in a field nobody declared as markdown would hand the model a way to put
an arbitrary link, or emphasis the schema never sanctioned, into a legal
citation. Flattening on the way in removes the markup without ever granting that
power.
"""

import functools
import re
import unicodedata
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import AliasChoices
from pydantic import BaseModel
from pydantic import ConfigDict
from pydantic import Field
from pydantic import TypeAdapter
from pydantic import field_validator
from pydantic import model_validator

# The catalog imports this module only inside functions, so this is no cycle.
from aiq_agent.cards.catalog import CHAT_ONLY_CARD_TYPES
from aiq_agent.cards.catalog import INTERACTIVE_CARD_TYPES
from aiq_agent.cards.catalog import RETIRED_CARD_TYPES
from aiq_agent.cards.catalog import SYSTEM_CARD_TYPES
from aiq_agent.cards.catalog import retired_refusal

# The three inline constructs that are UNAMBIGUOUSLY markup: a link or image
# target, a doubled emphasis delimiter, and a code span. Each is meaningless as
# literal text in an Austrian legal citation, and each is something an LLM writes
# into a JSON string without noticing that the string is not prose.
#
# What is deliberately NOT here is the ambiguous half of markdown. Single `*`
# and `_` emphasis, a leading `- ` or `#`, and `<https://…>` autolinks all occur
# for their own reasons in the text these fields carry — footnote markers in an
# OIB table, a dash inside „§ 3 - Abs. 1“, a heading character in a Bescheid
# reference. `original_text` is documented as a LITERAL excerpt from the source,
# and mangling a verbatim legal quotation is a worse defect than an asterisk.
# Doubled delimiters have no such second reading, which is why the line is drawn
# there rather than at "everything CommonMark would call emphasis".
_MD_LINK = re.compile(r"!?\[([^\]\n]*)\]\(\s*<?([^)\s]*)>?(?:\s+\"[^\"\n]*\")?\s*\)")
_MD_STRONG = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.DOTALL)
_MD_CODE = re.compile(r"`+([^`\n]+)`+")


def _unwrap_link(match: re.Match[str]) -> str:
    """Render a markdown link as the text a reader would have seen, plus its target.

    The URL is KEPT, as literal text. Dropping it would be the one thing a
    sanitiser of a legal citation must not do — silently delete part of what the
    citation asserted — and keeping it as text is not a link: nothing downstream
    turns a bare URL in a card field into an anchor. So the reader loses the
    brackets and nothing else.
    """
    label = match.group(1).strip()
    target = match.group(2).strip()
    if not target or target == label:
        return label
    if not label:
        return target
    return f"{label} ({target})"


def flatten_card_markup(value: str) -> str:
    """Strip inline markdown delimiters from one card text value.

    Idempotent, and a no-op on text that carries no markup — which is almost all
    of it, so the common case costs three failed regex scans.
    """
    flattened = _MD_LINK.sub(_unwrap_link, value)
    flattened = _MD_STRONG.sub(lambda m: m.group(2), flattened)
    return _MD_CODE.sub(lambda m: m.group(1), flattened)


def _flatten_markup_deep(value: Any) -> Any:
    """Apply :func:`flatten_card_markup` to a string, or to the strings in a list.

    Recurses through lists because ``TypedTableCard.rows`` is ``list[list[str]]``
    — a table cell is as much on-screen text as a title is. Nested card models
    are left alone here: they are :class:`CardModel` subclasses and have already
    flattened their own fields by the time the parent validates. Anything else
    (numbers, enums, dicts) passes through untouched.
    """
    if isinstance(value, str):
        return flatten_card_markup(value)
    if isinstance(value, list):
        return [_flatten_markup_deep(item) for item in value]
    return value


class CardModel(BaseModel):
    """Base for every card and every building block inside one.

    Carries the plain-text guarantee described in the module docstring, in the
    one place that covers all of it: a wildcard field validator, inherited by
    every subclass, so a card type added next sprint is covered by BEING a card
    rather than by someone remembering to annotate its fields. There are 177
    free-text fields across 71 models here; an ``Annotated[str, …]`` per field
    would be 177 chances to forget one.

    It runs on EVERY emission path, because all of them go through
    ``grid_card_adapter`` or :func:`validate_cards` — the ``emit_card`` tool, the
    post-hoc batch generator, Piloti's DSML path, project memory
    and surfaced documents. Identifier-shaped fields (IFC GlobalIds, model file
    names, JSON-pointer paths) inherit it too and are unaffected: none of the
    three constructs can occur in one.
    """

    @field_validator("*", mode="after")
    @classmethod
    def _flatten_text_markup(cls, value: Any) -> Any:
        return _flatten_markup_deep(value)


# Canonical project-profile fact keys (mirrors the intake definition in
# frontends/ui/src/lib/project-profile/intake-definition.ts). Included in the
# emit_card guidance so the model patches known keys with valid values instead
# of inventing near-duplicates ("gebaeudeklasse" vs "building_class").
PROFILE_FACT_VOCABULARY = (
    "main_use: residential|office|lodging|assembly|healthcare|agriculture|manufacturing|storage|other; "
    "building_class: GK1|GK2|GK3|GK4|GK5; "
    "escape_level: <=7m|7-11m|11-22m|>22m; "
    "existing_or_new: existing|new_build|extension_and_conversion; "
    "land_designation: building_land|traffic_area|open_land|core|mixed; "
    "development_pattern: open|semi_detached|closed; "
    "safety_category: low|medium|high; "
    "existing_age: <10|10-30|30-50|>50; "
    "storeys_above_ground / storeys_below_ground / bed_count / unit_count: number; "
    "plot_boundary / building_line / protection_zone / deviating_development_plan: boolean; "
    "high_rise_details: free text"
)


#: A server proposal's id (``POST /api/internal/proposals``, ADR-0105).
PROPOSAL_ID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"

#: Fields of a model-composed card that only the server may fill. Stripped from
#: whatever the model writes (``cards/envelope.validate_model_card``) and hidden
#: from the shapes the model is taught (``cards/catalog._shape``): an id the model
#: made up would point a person's Accept at somebody else's proposal.
SERVER_FILLED_CARD_FIELDS = frozenset({"proposal_id"})


class ProjectProfilePatchOperation(CardModel):
    """A JSON Patch operation targeting a project profile section."""

    op: Literal["add", "replace", "remove"]
    path: str = Field(
        description=(
            'For a confirmed hard fact use "/facts/<key>" with op "add" (works for both new and changed '
            'values). For an uncertain inference use "/assumptions/<key>". Known fact keys and values: '
            + PROFILE_FACT_VOCABULARY
        )
    )
    value: Any = Field(
        default=None,
        description=(
            'The PLAIN value only (e.g. "GK4", 3, true) — never wrap it in an object; the app adds '
            "provenance metadata when the user accepts."
        ),
    )

    @field_validator("path")
    @classmethod
    def _validate_path(cls, v: str) -> str:
        allowed_prefixes = ("/facts", "/goals", "/unknowns", "/assumptions")
        if not v.startswith(allowed_prefixes):
            raise ValueError(f"Patch path must start with one of {allowed_prefixes}")
        segments = v.split("/")
        if ".." in segments:
            raise ValueError("Patch path must not contain '..' segments")
        return v


class ProjectProfilePatchPreviewItem(CardModel):
    """A before/after preview for a single patched field."""

    label: str
    before: str
    after: str


class ProjectProfilePatchCard(CardModel):
    """Propose an update to the project brief (hard project facts) — applied only if the user accepts."""

    type: Literal["project_profile_patch"] = "project_profile_patch"
    title: str = Field(description='Short action title, e.g. "Projektkontext aktualisieren: Fluchtniveau"')
    rationale: str = Field(
        description="One or two sentences: what was learned in this conversation and why it changes the brief"
    )
    patch: list[ProjectProfilePatchOperation]
    preview: list[ProjectProfilePatchPreviewItem] = Field(
        default_factory=list,
        description=(
            "Optional and not rendered or recorded. The card builds its before/after rows from the "
            "PATCH and the live profile (`buildPatchPreviewRows`), never from a model-supplied "
            "preview — what the user consents to has to be what is written. Kept as an "
            "optional field rather than removed so an older stored card still validates."
        ),
    )
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals), set where the answer's "
            "cards become final and never by the model. Absent: the browser applies the patch, as before "
            "proposals were server objects"
        ),
    )


class MemoryProposalCard(CardModel):
    """A proposal to save a finding to long-term memory, confirmed by the user.

    System-emitted by the `remember` tool when an org-scoped write needs human
    authorization. With `proposal_id` the note is a stored proposal (kind
    `memory`) the server files in the accepting person's session, org-wide or,
    if they choose, in the project; without one the browser writes it through the
    reader's own session."""

    type: Literal["memory_proposal"]
    title: str = Field(min_length=1, description="Short title for the memory proposal")
    content: str = Field(min_length=1, description="The finding to remember (shown to the user verbatim)")
    kind: Literal["decision", "constraint", "open_question", "derived_fact", "preference"]
    confidence: Literal["low", "medium", "high"] = Field(default="medium")
    supersedes: str | None = Field(
        default=None,
        max_length=500,
        description="The earlier note this one corrects, quoted verbatim; accepting the proposal retires it",
    )
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals). Absent: the browser "
            "writes the note through the reader's own session, as before proposals were server objects"
        ),
    )


class OperationProposalCard(CardModel):
    """A workspace operation the agent PROPOSES through the MCP surface and a person runs.

    System-emitted for a write operation Piloti called on the product's own MCP
    server (ADR-0122): the call changed nothing, it stored an ``operation``
    proposal (ADR-0105) and this card shows it. Accepting runs the operation
    as the ACCEPTING person through the operation's own route, so that route's
    authorization decides; dismissing runs nothing. ``proposal_id`` is
    required: a call that stored no proposal has no card, and says so in its
    own result text.
    """

    type: Literal["operation_proposal"] = "operation_proposal"
    title: str = Field(min_length=1, description="The one-line English description of what accepting would do")
    operation: str = Field(min_length=1, description="The catalog operation's name, e.g. 'folder-rename'")
    input: dict[str, Any] = Field(
        default_factory=dict,
        description="What the operation is called with: params, query and body, shown to the person",
    )
    proposal_id: str = Field(
        pattern=PROPOSAL_ID_PATTERN,
        description="The server proposal this card shows (kind 'operation'); the person accepts or dismisses it there",
    )


# ── Schematic cards: shared sub-structures ───────────────────────────────────
# These cards are programmatically-drawn technical schematics (SVG). The model
# emits PARAMETERS ONLY — never a rendered image and never a number it can't
# know. The frontend draws the diagram to scale from these parameters. Required
# limits come from the OIB corpus (with a NormReference); actual/geometry values
# come from the user's question or the project profile. If a value is unknown,
# leave it null and set status 'needs_input' — do not estimate.

DimStatus = Literal["pass", "fail", "warning", "needs_input"]

#: Where a number on a card came from — the three the spatial engine draws.
#:
#: These are `ifc_spatial.envelope.Answer.provenance` exactly, and the point of
#: keeping the same three words is that the card and the sentence beside it can
#: never disagree about who is making the claim. The German the renderer prints
#: for each is not decoration either:
#:
#:   declared → „laut Modell"   — the architect's own statement, quoted back
#:   computed → „gemessen"      — OUR measurement, and it carries a tolerance
#:   inferred → „vermutlich"    — a heuristic, offered for confirmation
#:
#: The difference between the first two is the difference between reporting the
#: file and reporting ourselves, and a reader has to be able to tell which one
#: they are being handed before they sign it.
Provenance = Literal["declared", "computed", "inferred"]


class NormReference(CardModel):
    """A verifiable pointer into a regulation (the atom of grounding).

    Every required value MUST carry one so the architect can verify it against
    the source. Never fabricate a reference.
    """

    document: str = Field(min_length=1, description="Regulation name, e.g. 'OIB-Richtlinie 2', 'ÖNORM B 1600'")
    section: str | None = Field(default=None, description="Clause/table, e.g. 'Pkt. 5.1.1', 'Tabelle 1b'")
    edition: str | None = Field(default=None, description="Edition/year, e.g. 'Ausgabe Mai 2023'")
    excerpt: str | None = Field(default=None, description="Literal quoted sentence grounding the value (<= ~200 chars)")


class DimensionCheck(CardModel):
    """One measured dimension drawn on a schematic and checked against a limit.

    `value` is the project's actual measurement (drawn to scale); `required` is
    the OIB limit. If `value` is unknown, leave it null and set status
    'needs_input'.

    ## Why a number here carries where it came from

    This block used to be `label / value / required / unit / comparator /
    status` and nothing else, and that made the card the least honest surface in
    the product. `ifc_measure` answers „gemessen: 2.47 m (±5 mm) — aus der
    Geometrie berechnet, nicht deklariert“, the assistant repeats that in the
    prose, and the card beside it drew **2.47 m ✓** — indistinguishable from a
    figure the architect had stated in their own file. The card is the part a
    reviewer screenshots into a submission, so the surface that dropped the
    qualifier was the surface most likely to be forwarded without it.

    Three fields close that, and all three are OPTIONAL: a card built from the
    Bestimmung alone (a limit with no model behind it) has nothing to put in
    them, and a null here means "not stated", never "declared".
    """

    label: str = Field(min_length=1, description="What is measured, e.g. 'lichte Durchgangsbreite'")
    value: float | None = Field(default=None, description="Actual measurement (drawn); null if unknown")
    required: float | None = Field(default=None, description="OIB limit for this dimension")
    unit: str = Field(default="cm", description="Unit for both value and required, e.g. 'cm', 'm', '%'")
    comparator: Literal["<=", ">="] | None = Field(default=None, description="How actual must relate to required")
    status: DimStatus = Field(description="Verdict for this dimension")
    provenance: Provenance | None = Field(
        default=None,
        description=(
            "Where `value` came from, copied from the ifc_measure answer's own provenance: 'declared' "
            "(the IFC file states it), 'computed' (we measured it off the geometry), 'inferred' (a "
            "heuristic, offered for confirmation). Leave null when the number did not come from the "
            "model at all — a figure the user typed, or one taken from the Bestimmung. NEVER guess it: "
            "labelling our own measurement 'declared' turns our tolerance into the architect's claim."
        ),
    )
    tolerance: float | None = Field(
        default=None,
        ge=0,
        description=(
            "The ± band on `value`, in the SAME unit — copied from the ifc_measure answer. Only "
            "meaningful with provenance 'computed': a declared figure is the file's statement and has "
            "no band of ours. A measured dimension without its band reads as exact, and the band is "
            "what decides whether 2.49 m clears a 2.50 m minimum."
        ),
    )
    missing: str | None = Field(
        default=None,
        description=(
            "With status 'needs_input': what the export does not provide and WHAT TO CHANGE IN THE CAD "
            "to make it answerable — copied verbatim from the ifc_measure answer's missing.remedy. This "
            "is the sentence the architect acts on, and a card that shows an empty slot instead of it "
            "turns a finding about the export into a blank the reader reads as a fact about the building."
        ),
    )


class SectionStorey(CardModel):
    """One storey in a building cross-section, drawn as a band to scale."""

    label: str = Field(min_length=1, description="Storey label, e.g. 'EG', '1.OG', 'KG'")
    height_m: float = Field(gt=0, description="Clear storey height in metres (drawn to scale)")
    below_grade: bool = Field(default=False, description="True for basements/underground storeys")


class SectionMarker(CardModel):
    """A horizontal reference line at a given height in the section."""

    label: str = Field(min_length=1, description="What the line marks, e.g. 'Fluchtniveau', 'GK4-Grenze'")
    height_m: float = Field(description="Height above ground datum in metres")
    kind: Literal["escape_level", "threshold", "reference"] = Field(default="reference", description="Styling role")


class SetbackSide(CardModel):
    """A required distance from the building footprint to one parcel edge."""

    side: Literal["front", "back", "left", "right"] = Field(description="Which edge")
    required_m: float = Field(description="Required setback in metres (OIB/Bauordnung)")
    actual_m: float | None = Field(default=None, description="Actual distance in metres; null if unknown")
    status: DimStatus = Field(description="Verdict for this side")


class EgressSegment(CardModel):
    """One straight run of an escape path, drawn end-to-end with the next."""

    label: str = Field(min_length=1, description="Segment label, e.g. 'Raum → Gang', 'Gang → Treppenhaus'")
    length_m: float = Field(gt=0, description="Run length in metres (drawn to scale)")
    turn: Literal["straight", "left", "right"] = Field(default="straight", description="Turn AFTER this run")


# ── Schematic cards ──────────────────────────────────────────────────────────


class BuildingSectionCard(CardModel):
    """A to-scale building cross-section (schematic) drawn from storey heights.

    Emit for height/Gebäudeklasse/Fluchtniveau questions where seeing the
    building against threshold lines helps (e.g. 'am I below the GK4 limit with
    a Fluchtniveau of 9.8 m?'). Draws stacked storeys, the ground line, and
    dashed marker lines (Fluchtniveau, GK/Hochhaus limits) with labels.
    """

    type: Literal["building_section"]
    title: str = Field(min_length=1, description="Title, e.g. 'Gebäudeschnitt – Höhenprüfung'")
    storeys: list[SectionStorey] = Field(description="Storeys bottom-to-top; basements flagged below_grade")
    markers: list[SectionMarker] | None = Field(default=None, description="Reference lines: Fluchtniveau, GK/Hochhaus")
    reference: NormReference = Field(description="Source of the threshold heights")
    note: str | None = Field(default=None, description="Optional clarification")


class StairDiagramCard(CardModel):
    """A staircase drawn to scale (schematic section) with step-geometry checks.

    Emit for stair questions (e.g. 'does a flight of 17 steps with 18 cm
    Steigung, 27 cm Auftritt and 100 cm width fit?'). Draws the step profile to
    scale and checks riser/going/width and the comfort rule (2×Steigung +
    Auftritt ≈ 59–65 cm) against OIB 4.
    """

    type: Literal["stair_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Treppenlauf – Steigungsverhältnis'")
    riser_count: int = Field(gt=0, description="Number of steps in the flight (drawn)")
    riser_height: DimensionCheck = Field(description="Steigung (rise) per step; typical limit <= 18 cm")
    tread_depth: DimensionCheck = Field(description="Auftritt (going) per step; typical limit >= 28 cm")
    width: DimensionCheck = Field(description="Usable flight width; limit depends on Gebäudeklasse")
    comfort_note: str | None = Field(default=None, description="Result of the 2×Steigung + Auftritt comfort check")
    reference: NormReference = Field(description="Source of the step-geometry limits")


class DimensionDiagramCard(CardModel):
    """A parametric accessibility/geometry schematic with dimension arrows.

    Emit for clearance questions (door width, ramp gradient, turning circle,
    corridor width, threshold, a barrier-free lift cabin). The renderer picks a
    prebuilt template for `shape` and draws each dimension arrow where it is
    measured, coloured by status — preventing the Stocklichte-vs-Durchgangslichte
    misread. `lift_cabin` took over the cabin half of the retired
    `elevator_requirement` card: Kabinenbreite, Kabinentiefe and lichte
    Türbreite, drawn on a cabin plan.
    """

    type: Literal["dimension_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Rampe – Neigung & Breite'")
    shape: Literal["door", "ramp", "corridor", "turning_circle", "threshold", "parking_space", "lift_cabin"] = Field(
        description=(
            "Which schematic template to draw; 'lift_cabin' takes Kabinenbreite, Kabinentiefe and lichte "
            "Türbreite (cm) as its dimensions"
        )
    )
    dimensions: list[DimensionCheck] = Field(description="The measured dimensions to annotate on the schematic")
    reference: NormReference = Field(description="Source of the dimension limits (e.g. OIB 4 / ÖNORM B 1600)")
    note: str | None = Field(default=None, description="Optional clarification")


class SetbackPlanCard(CardModel):
    """A top-down site plan (schematic): parcel, footprint, setbacks, coverage and GFZ.

    Emit for Abstandsflächen/Bauwich questions ('does the building keep the
    required Abstände?') and for Bebauungsdichte/Bebauungsgrad/GFZ questions.
    Draws the parcel, the required-setback envelope, and the building
    footprint, with a distance arrow per side coloured by status, and — where
    `coverage` or `density` is given — a readout of Bebauungsgrad (built area /
    parcel) and GFZ (BGF / parcel) against the Bebauungsplan's limits. The
    renderer computes the ratios from the areas; the model supplies areas and
    limits only. The readout took over the retired `density_check` card.
    """

    type: Literal["setback_plan"]
    title: str = Field(min_length=1, description="Title, e.g. 'Abstandsflächen – Lageplan'")
    parcel_width_m: float | None = Field(
        default=None,
        gt=0,
        description="Parcel width in metres (drawn to scale); required unless a pure density question",
    )
    parcel_depth_m: float | None = Field(
        default=None,
        gt=0,
        description="Parcel depth in metres (drawn to scale); required unless a pure density question",
    )
    building_width_m: float | None = Field(
        default=None, gt=0, description="Building footprint width in metres; required unless a pure density question"
    )
    building_depth_m: float | None = Field(
        default=None, gt=0, description="Building footprint depth in metres; required unless a pure density question"
    )
    sides: list[SetbackSide] = Field(description="Required/actual distance per parcel edge")
    parcel_area_m2: float | None = Field(
        default=None, gt=0, description="Parcel (Grundstück) area in m², where it is not the drawn rectangle"
    )
    footprint_area_m2: float | None = Field(
        default=None, gt=0, description="Built (bebaute) area in m², where it is not the drawn rectangle"
    )
    gross_floor_area_m2: float | None = Field(default=None, gt=0, description="Bruttogeschossfläche (BGF) in m²")
    coverage: DimensionCheck | None = Field(
        default=None, description="Bebauungsgrad (built/parcel) vs the limit; value null = renderer derives"
    )
    density: DimensionCheck | None = Field(
        default=None, description="GFZ (BGF/parcel) vs the limit; value null = renderer derives"
    )
    reference: NormReference = Field(description="Source of the setback requirements")

    @model_validator(mode="after")
    def _plan_or_areas(self) -> SetbackPlanCard:
        """The plan needs its four dimensions; a pure density question needs the parcel area instead.

        A Bebauungsgrad or GFZ question with no parcel geometry leaves ``sides``
        empty and gives ``parcel_area_m2``: the card draws the readout and no
        plan. Requiring the dimensions there would leave a model (or the
        repair model) only one way to pass, inventing a parcel the renderer
        then draws to scale (``_CARD_HONESTY``).
        """
        dimensions = (self.parcel_width_m, self.parcel_depth_m, self.building_width_m, self.building_depth_m)
        if all(value is not None for value in dimensions):
            return self
        if self.sides or self.parcel_area_m2 is None or (self.coverage is None and self.density is None):
            raise ValueError(
                "parcel_width_m, parcel_depth_m, building_width_m and building_depth_m are required to draw the "
                "plan; only a pure density question (no sides, parcel_area_m2 and coverage or density) may omit them"
            )
        return self

    @model_validator(mode="after")
    def _ratio_units(self) -> SetbackPlanCard:
        """A ratio's unit, when the model gave none: ``%`` for Bebauungsgrad, none for GFZ (never ``cm``)."""
        if self.coverage is not None and "unit" not in self.coverage.model_fields_set:
            self.coverage = self.coverage.model_copy(update={"unit": "%"})
        if self.density is not None and "unit" not in self.density.model_fields_set:
            self.density = self.density.model_copy(update={"unit": ""})
        return self


class EgressDiagramCard(CardModel):
    """A schematic escape-route (Fluchtweg) path with the total length checked.

    Emit for escape-route-length questions ('is a Fluchtweg of 12 m + 26 m
    permitted?'). Draws the path segment-by-segment from the worst-case point to
    the exit and checks the total against the OIB 2 limit (typically 40 m).
    """

    type: Literal["egress_diagram"]
    title: str = Field(min_length=1, description="Title, e.g. 'Fluchtweg – Gehweglänge'")
    segments: list[EgressSegment] = Field(description="Path runs from the worst-case point to the exit, in order")
    total_length: DimensionCheck = Field(description="Sum of segment lengths vs the OIB limit (e.g. <= 40 m)")
    start_label: str | None = Field(default="ungünstigster Punkt", description="Label for the path start")
    exit_label: str | None = Field(default="Treppenhaus", description="Label for the path end/exit")
    reference: NormReference = Field(description="Source of the escape-length limit (OIB 2)")


# ── Schematic cards (wave 2) ─────────────────────────────────────────────────


class Obstruction(CardModel):
    """An object blocking daylight (opposing building, own projection)."""

    distance_m: float = Field(gt=0, description="Horizontal distance from the window in metres")
    height_m: float = Field(description="Height of the obstruction above the window sill in metres")
    label: str = Field(min_length=1, description="What it is, e.g. 'Gegenüberliegendes Gebäude'")


class DaylightIncidenceCard(CardModel):
    """A daylight (Belichtung) schematic: the 45° free-light line vs obstructions.

    Emit for daylight/Belichtung questions (OIB 3). Draws a window section, the
    45° free-light-incidence line from the window's lower edge, any obstruction,
    and a glass-area-vs-floor-area check. The renderer does the 45° geometry —
    the model supplies distances/heights only.
    """

    type: Literal["daylight_incidence"]
    title: str = Field(min_length=1, description="Title, e.g. 'Belichtung – freier Lichteinfall'")
    room_floor_area_m2: float | None = Field(default=None, description="Aufenthaltsraum floor area in m²")
    glass_area: DimensionCheck = Field(description="Lichteintrittsfläche (m²) vs the ≥10% requirement")
    window_sill_height_m: float | None = Field(default=None, description="Sill (Parapet) height in metres")
    window_head_height_m: float | None = Field(default=None, description="Window head (Sturz) height in metres")
    obstruction: Obstruction | None = Field(default=None, description="Any object intruding into the 45° light cone")
    reference: NormReference = Field(description="Source of the daylight requirement (OIB 3)")
    note: str | None = Field(default=None, description="Optional clarification")


class GuardrailCheckCard(CardModel):
    """An Absturzsicherung (guardrail) elevation with the interacting limits.

    Emit for guardrail/railing questions (OIB 4). Draws the railing to scale and
    checks height (>=100 cm, >=110 cm where Absturzhöhe > 12 m), max opening
    (<=12 cm cube), bottom gap, and shades the no-climb zone.
    """

    type: Literal["guardrail_check"]
    title: str = Field(min_length=1, description="Title, e.g. 'Absturzsicherung Dachterrasse'")
    context: Literal["balcony", "loggia", "staircase", "window", "roof_terrace"] = Field(description="Railing location")
    fall_height: DimensionCheck = Field(description="Absturzhöhe (m) — decides which height limit applies")
    rail_height: DimensionCheck = Field(description="Geländerhöhe (cm) vs the required minimum")
    max_opening: DimensionCheck = Field(description="Largest opening (cm) vs the <=12 cm cube rule")
    bottom_gap: DimensionCheck | None = Field(default=None, description="Gap at the base (cm)")
    has_horizontal_elements_in_climb_zone: bool | None = Field(default=None, description="Climbable horizontals?")
    reference: NormReference = Field(description="Source of the guardrail limits (OIB 4)")
    note: str | None = Field(default=None, description="Optional clarification")


class StagingAreaPlan(CardModel):
    """The fire-brigade Aufstellfläche geometry."""

    width: DimensionCheck = Field(description="Aufstellfläche width (m)")
    length: DimensionCheck = Field(description="Aufstellfläche length (m)")
    distance_to_facade: DimensionCheck | None = Field(default=None, description="Distance to the facade (m)")


class FireAccessPlanCard(CardModel):
    """A fire-brigade access (Feuerwehrzufahrt) site plan schematic.

    Emit for fire-access questions (OIB 2 / TRVB). Top-down plan: access route
    from the road, the Aufstellfläche beside the facade, and the reach distance
    from the Aufstellfläche to the farthest necessary entrance (typically
    <=80 m). Numeric minimums vary by Land — always corpus-grounded per check.
    """

    type: Literal["fire_access_plan"]
    title: str = Field(min_length=1, description="Title, e.g. 'Feuerwehrzufahrt & Aufstellfläche'")
    parcel_width_m: float = Field(gt=0, description="Parcel width in metres")
    parcel_depth_m: float = Field(gt=0, description="Parcel depth in metres")
    building_width_m: float = Field(gt=0, description="Building footprint width in metres")
    building_depth_m: float = Field(gt=0, description="Building footprint depth in metres")
    route_width: DimensionCheck = Field(description="Zufahrt clear width (m) vs the minimum")
    gate_clearance_height: DimensionCheck | None = Field(default=None, description="Durchfahrt clear height (m)")
    staging_area: StagingAreaPlan = Field(description="The fire-brigade standing-area geometry")
    walk_distance_to_entrance: DimensionCheck = Field(description="Reach to farthest entrance (m), e.g. <=80")
    building_class: str | None = Field(default=None, description="The building's Gebäudeklasse (drives the limit)")
    reference: NormReference = Field(description="Source of the access requirements (OIB 2 / TRVB)")
    note: str | None = Field(default=None, description="Optional clarification")


# ── The derivation, and the procedure ────────────────────────────────────────
# Two shapes an OIB answer takes constantly and that had no card, so they were
# written as prose: the arithmetic that produced a number, and the ordered
# procedure a project moves through.
#
# `calculation` is the one card where the MODEL MUST NOT SUPPLY THE ANSWER. It
# supplies operands, an operation and (optionally) the limit; the renderer
# evaluates every step, propagates the tolerance band, formats to Austrian
# convention and derives the verdict. This is the same invariant the fifteen
# schematics are built on — the renderer draws to scale and does the geometry
# itself, so a card cannot show a diagram that disagrees with its own numbers —
# and it matters more here, because a Rechenweg whose stated result disagrees
# with its own operands is the artefact that gets screenshotted into an
# Einreichung.
#
# There is deliberately NO expression string and no formula field. A general
# evaluator would let the model write arbitrary arithmetic that the renderer
# must then parse and trust; parsing it back is how the renderer ends up
# re-deriving the model's intent, and the first ambiguous parse (precedence,
# a unit inside the expression, a stray parenthesis) puts a wrong number on the
# card with full confidence. A closed set of five operations cannot be
# mis-parsed because there is nothing to parse.


CalculationOperation = Literal["sum", "product", "quotient", "percent_of", "percent_ratio"]
"""The five closed operation shapes a Rechenweg is allowed to take.

Each is ONE formula the renderer evaluates directly. They were chosen against
the arithmetic that actually appears in Austrian Baurecht answers, not against
what an expression grammar would cover:

    sum           Σ factorᵢ · valueᵢ   a Netto-Grundfläche from its rooms, a
                                       Gesamthöhe, a Restbreite (negative factor)
    product       Π valueᵢ             Stellplatzbedarf (14 WE × 1,0), an area
    quotient      v₁ ÷ v₂              GFZ (BGF ÷ Grundfläche), Brandlast je m²
    percent_of    v₁ · v₂ ÷ 100        Grünflächenanteil
    percent_ratio v₁ ÷ v₂ · 100        Bebauungsgrad, Rampenneigung — the result is a
                                       percentage and the renderer prints '%' for it

The four named rules (a U-value from its layers, the Schrittmaßregel, the
Gehweglänge, the Lichteintrittsfläche) are a :class:`FormulaCard`, not a
derivation: their bounds are the Richtlinie's, and the renderer owns them.

Anything more composite is expressed as SEVERAL steps, with a later step
referencing an earlier one's result (:attr:`CalculationOperand.step`).
"""


class CalculationOperand(CardModel):
    """One number entering a step of the derivation, with where it came from.

    Either a literal ``value`` or a reference to an earlier ``step`` — never
    both, because a stated value beside a reference is two answers to the same
    question and the renderer would have to pick one.

    Carries the same provenance vocabulary as :class:`DimensionCheck`, for the
    same reason: a derived number is only as honest as its inputs, and a
    Schrittmaß computed from a measurement of ours is our claim, not the
    architect's. The renderer propagates every band it is given into the result,
    so a tolerance dropped here is a tolerance dropped from the answer.
    """

    label: str = Field(
        description=(
            "What this number IS, e.g. 'Steigung', 'Bruttogeschossfläche', 'Grundfläche'. Empty ONLY for a "
            "bare constant that names itself, such as the 100 of a percentage — everything a reader "
            "has to look up needs its name under it"
        ),
    )
    value: float | None = Field(
        default=None,
        description=(
            "The number itself. Leave null when it is not known — the renderer then shows the step as "
            "undecidable instead of a result, which is the honest outcome. Must be null when `step` is set"
        ),
    )
    unit: str | None = Field(
        default=None,
        description="Unit of this operand, e.g. 'cm', 'm²', 'MJ'; omit for a bare count or a ratio",
    )
    factor: float | None = Field(
        default=None,
        description=(
            "Only on a 'sum': the RULE's own multiplier for this term, e.g. 2 for a "
            "two-sided Abstand. Negative subtracts the term. Omit for a plain +1 — never use it "
            "to smuggle a second measured quantity in, which is what a 'product' step is for"
        ),
    )
    step: int | None = Field(
        default=None,
        description=(
            "Instead of a value: the 1-based index of an EARLIER step whose result this operand is. "
            "Must point strictly backwards. With this set, leave value, unit, provenance and tolerance "
            "null — the renderer takes them from the step it names"
        ),
    )
    provenance: Provenance | None = Field(
        default=None,
        description=(
            "Where `value` came from, copied from the ifc_measure answer's own provenance: 'declared' "
            "(the IFC file states it), 'computed' (we measured it off the geometry), 'inferred' (a "
            "heuristic). Leave null for a figure the user typed or a limit read out of the Bestimmung. "
            "NEVER guess it"
        ),
    )
    tolerance: float | None = Field(
        default=None,
        ge=0,
        description=(
            "The ± band on `value`, in the SAME unit — copied from the ifc_measure answer, and only "
            "meaningful with provenance 'computed'. The renderer propagates it through every following "
            "step, so this is what decides whether the derived result is genuinely on one side of a limit"
        ),
    )
    source: str | None = Field(
        default=None,
        description=(
            "Optional half-line naming WHERE the figure is written down, e.g. 'Einreichplan, Schnitt A-A' "
            "or 'Bebauungsplan PD 8123'. Revealed when the reader expands the derivation's sources"
        ),
    )

    @model_validator(mode="after")
    def _reference_or_value(self) -> CalculationOperand:
        if self.step is not None:
            if self.step < 1:
                raise ValueError("`step` is a 1-based index of an earlier step")
            if any(x is not None for x in (self.value, self.unit, self.provenance, self.tolerance)):
                raise ValueError("an operand referencing a step carries no value, unit, provenance or tolerance")
        return self


class CalculationStep(CardModel):
    """One line of the Rechenweg: an operation over its operands.

    The step states no result. The renderer evaluates ``operation`` over
    ``operands`` and prints what it computed — which is the whole point of the
    card, so there is no field here for the model to disagree with it in.
    """

    label: str = Field(
        min_length=1, description="What this step computes, e.g. 'Netto-Grundfläche', 'Geschossflächenzahl'"
    )
    operation: CalculationOperation = Field(
        description=(
            "Which of the five shapes this step is: 'sum' (Σ factor × value), 'product' (Π value), "
            "'quotient' (first ÷ second), 'percent_of' (second, as a percentage, OF first), "
            "'percent_ratio' (first ÷ second × 100, a percentage)"
        )
    )
    operands: list[CalculationOperand] = Field(
        min_length=2,
        max_length=6,
        description=(
            "The numbers going in, in the order they are read. 'quotient', 'percent_of' and "
            "'percent_ratio' take EXACTLY two"
        ),
    )
    unit: str | None = Field(
        default=None,
        description=(
            "Unit of THIS step's result, e.g. 'cm', 'm²', 'W/(m²K)'; omit for a dimensionless ratio like "
            "a GFZ. Ignored on 'percent_ratio', whose result is always a percentage"
        ),
    )

    @model_validator(mode="after")
    def _operand_count_matches_operation(self) -> CalculationStep:
        if self.operation in ("quotient", "percent_of", "percent_ratio") and len(self.operands) != 2:
            raise ValueError(f"operation '{self.operation}' takes exactly two operands")
        if self.operation != "sum" and any(o.factor is not None for o in self.operands):
            raise ValueError("`factor` belongs to a 'sum' step; scale with a 'product' instead")
        return self


class CalculationLimit(CardModel):
    """The Bestimmung the derived result is held against.

    The comparator and the bound are the model's to supply — they are read out
    of the Richtlinie. The VERDICT is not: the renderer compares its own
    computed result against this and colours the card accordingly, so a card
    cannot show a green tick above arithmetic that fails.
    """

    comparator: Literal["<=", ">=", "between"] = Field(
        description="How the result must relate to the bound: at most, at least, or inside a range"
    )
    value: float = Field(description="The bound. With 'between', this is the LOWER bound")
    upper: float | None = Field(
        default=None,
        description="With 'between': the upper bound of the range. Otherwise omit",
    )
    label: str | None = Field(
        default=None,
        description="Optional name of the limit, e.g. 'Netto-Grundfläche'; omit when the reference says it",
    )
    reference: NormReference | None = Field(default=None, description="Where the bound is written. Never invent one")

    @model_validator(mode="after")
    def _range_needs_an_upper_bound(self) -> CalculationLimit:
        if self.comparator == "between":
            if self.upper is None:
                raise ValueError("a 'between' limit needs `upper`")
            if self.upper <= self.value:
                raise ValueError("`upper` must be greater than `value`")
        elif self.upper is not None:
            raise ValueError("`upper` is only meaningful with comparator 'between'")
        return self


class CalculationCard(CardModel):
    """Emit for the arithmetic behind a number — the Rechenweg a Ziviltechniker re-checks.

    Whenever the answer computes something (a GFZ, a Brandabschnitt's
    Netto-Grundfläche, a Brandlast, a required parking count), this card is the
    derivation laid out line by line instead of a sentence the reader has to
    re-derive to trust. The four named rules are NOT a calculation: a U-value
    from its layers, the Schrittmaßregel, an escape route's Gehweglänge and a
    Lichteintrittsfläche are a `formula`, which owns their bounds.

    YOU SUPPLY THE INPUTS, NEVER THE ANSWER. Give each operand its label, value
    and unit, name the operation, and give the limit if there is one. The card
    evaluates every step itself, carries the tolerance bands through, formats
    the numbers in Austrian convention and decides pass/fail. There is no field
    for a result, and that absence is the feature: a stated result that
    disagreed with its own operands would be the worst artefact this product can
    produce, because this is the part that gets screenshotted into a submission.

    Several steps chain by reference: a later operand can name an earlier step
    (`step: 1`) instead of carrying a value, so a two-stage derivation stays
    auditable rather than collapsing into one pre-computed figure.
    """

    type: Literal["calculation"]
    title: str = Field(min_length=1, description="What is being computed, e.g. 'Netto-Grundfläche Brandabschnitt BA 2'")
    steps: list[CalculationStep] = Field(
        min_length=1,
        max_length=4,
        description="The derivation in order, most cards one step. A later step may reference an earlier one's result",
    )
    limit: CalculationLimit | None = Field(
        default=None,
        description=(
            "The Bestimmung the LAST step's result is checked against. Omit when the answer only derives a figure"
        ),
    )
    reference: NormReference | None = Field(
        default=None, description="Where the RULE behind the derivation is written (the limit may carry its own)"
    )
    note: str | None = Field(default=None, description="Optional one-line caveat, e.g. what the figure does not cover")

    @model_validator(mode="after")
    def _references_point_backwards(self) -> CalculationCard:
        # A forward or self reference has no value to read, so the renderer
        # would have nothing to compute; rejecting it here means an
        # uncomputable card never reaches the client at all.
        for index, step in enumerate(self.steps, start=1):
            for operand in step.operands:
                if operand.step is not None and operand.step >= index:
                    raise ValueError(f"step {index} references step {operand.step}; a reference must point backwards")
        return self


# ── Formula card: a named rule whose inputs the reader may change ────────────
#
# `formula` is `calculation`'s sibling for the four rules an Austrian architect
# computes again and again, where the question after the answer is always "and
# what if?" (ADR-0143): the insulation that would meet the U-value, the riser
# that keeps the Schrittmaß, the shorter escape route, the larger window. The
# model names the rule from a CLOSED set, names the case the rule asks for (the
# stair type, the component, where the route is measured from) and fills the
# inputs from cited sources. The renderer owns everything else
# (`frontends/ui/src/features/grid-cards/lib/formulas.ts`): it compiles the rule
# to `calculation` steps, evaluates them with `calculation`'s own arithmetic,
# derives the bound from the Richtlinie's table for that case, and judges.
#
# Four things are deliberately not on the wire:
#
#   - a RESULT, for the reason `calculation` has none;
#   - a UNIT: each input's unit is fixed by its formula;
#   - an EXPRESSION: the rule is a name, its arithmetic a tested function;
#   - a LIMIT: the bound is the Richtlinie's, read from a typed table in the
#     renderer for the case the model named (OIB-RL 4 Tabelle 3 by stair type,
#     OIB-RL 6 Pkt. 4.4.1 by component, OIB-RL 2 Pkt. 5.1.1, OIB-RL 3 Pkt.
#     9.1.1 to 9.1.4). The model may choose the case; it never writes the number.
#
# No figure in free text either: a title or a label that carries a value goes
# stale the moment the reader changes the input it repeats.

FormulaStairType = Literal["main", "dwelling", "secondary"]
FormulaComponent = Literal["external_wall", "roof_or_ceiling_to_outside_air", "floor_over_outside_air"]
FormulaRouteStart = Literal["room", "dwelling_entrance"]
FormulaMeasure = Literal["new_build", "renovation", "major_renovation"]

# The card computes every figure and every verdict; a figure or a verdict
# written into text beside it disagrees with the card the moment an input
# moves, and is the line that gets copied into a submission. So the guard is
# FAIL-CLOSED, on text normalised with NFKC first (a superscript ² is a 2):
#
#   - a NAME (the title, a layer's or a leg's label) is built from an allowed
#     alphabet: letters, spaces, the punctuation – · / , ( ) . - →, and digits
#     only inside an allow-listed citation or identifier. A sign (≤, ✓, ☑, 👍,
#     🟢) is not in the alphabet, so it is refused as a class;
#   - a TEXT (the note, an input's `source`) may also name its documents (a
#     plan code, Index, Rev., Pos., Seite, Variante, a date, a year), but carries
#     no measurement, no comparison sign and no symbol;
#   - in both, a verdict in words is refused outright.
#
# One judgement, made on purpose: an identifier's number is not checked against
# the card's figures. „AW 20" (a component code), „Top 63" (a numbered dwelling)
# and „Büro 2.14" are as legitimate as „AW 01", „Top 7" and „Büro 0.12", and no
# rule on the text alone can tell a code from a figure written as one.

#: Citations: where a rule is written. Stripped before digits are counted.
_CITATION = re.compile(
    r"\b(?:Pkt\.?|Punkt|Tabelle|Zeile|Abschnitt|Anhang|Abs\.?|Ziffer|Z\.)\s*\d+(?:\.\d+)*(?:\s*[a-z]\))?"
    r"|§\s*\d+[a-z]?"
    r"|\bOIB-(?:Richtlinie|RL)\s*\d(?:\.\d)?\b"
    r"|\b(?:ÖNORM|OENORM|EN|ISO|DIN)(?:\s+(?:EN|ISO|[A-Z]))*\s+\d{2,5}(?:-\d{1,3})*(?::\d{4})?"
)

#: Identifiers: names of places, components and variants, never quantities.
_IDENTIFIER = re.compile(
    # component codes of a Bauteilkatalog: Außenwand, Innenwand, Trennwand,
    # Decke, Dach, Fußboden, Flachdach, Brandabschnitt, Bauteil, Bodenplatte
    r"\b(?:AW|IW|TW|DE|DA|FB|FD|BA|BT|BP)[ -]?\d{1,2}[a-z]?\b"
    # storeys
    r"|\b\d{1,2}\.\s?(?:OG|UG|DG|KG|Obergescho(?:ß|ss)|Untergescho(?:ß|ss)|Dachgescho(?:ß|ss)|Stock)\b"
    # a numbered dwelling, a numbered or dotted room
    r"|\bTop\s+\d{1,3}[a-z]?\b"
    r"|\b(?:Büro|Raum|Zimmer)\s+\d{1,2}(?:\.\d{2})?\b"
    # a lettered or numbered building part or variant
    r"|\b(?:Haus|Stiege|Bauteil|Trakt|Achse|Variante)\s+(?:[A-Z]|\d{1,2})\b(?![.,]\d)"
    # a plot
    r"|\bGst\.?-?Nr\.?\s+\d{1,5}(?:/\d{1,4})?\b"
)

#: Where a text names its documents: a plan code after a plan, section or
#: elevation, an Index, a revision, a position of the structural analysis, a
#: page, a date, a year. Allowed in a `source` and a note, never in a name.
_NOT_A_DECIMAL = r"\b(?![.,]\d)"

_DOCUMENT_REFERENCE = re.compile(
    # a plan code after a NAMED plan word: a letter prefix (EP-01, A-101), or a
    # bare integer, hyphen groups allowed (04-123); never a decimal, so
    # „Lageplan 0.35" is a figure. The words are named, so „Durchschnitt" and
    # „Abschnitt" (a citation word) do not open a plan code.
    r"\b(?:Einreichplan|Bestandsplan|Lageplan|Polierplan|Werkplan|Grundriss|Schnitt|Detailschnitt|Ansicht|Plan)"
    r"(?:-?Nr\.?)?\s+(?:[A-Z]{1,4}-?\d{1,4}(?:[-_/][A-Z0-9]{1,4})*|\d{1,4}(?:-\d{1,4})*)"
    + _NOT_A_DECIMAL
    + r"|\bIndex\s+[A-Z0-9]{1,3}"
    + _NOT_A_DECIMAL
    + r"|\bRev\.?\s*\d{1,3}[a-z]?"
    + _NOT_A_DECIMAL
    # a position of the structural analysis: an integer or integer.integer, no leading 0
    + r"|\bPos\.?\s*[1-9]\d{0,3}(?:\.[1-9]\d{0,2})?"
    + _NOT_A_DECIMAL
    + r"|\bSeite\s+\d{1,4}"
    + _NOT_A_DECIMAL
    + r"|\b\d{1,2}\.\s?\d{1,2}\.\s?(?:\d{4}|\d{2})\b"
    r"|\b\d{1,2}/\d{4}\b"
    # a year, or a decade („Bestand 1960er")
    r"|\b(?:19|20)\d{2}(?:er)?" + _NOT_A_DECIMAL,
)

#: „OK" is a verdict, unless it is the Oberkante of a floor build-up.
_TOP_EDGE = re.compile(r"\bOK\s*(?:FFB|RFB|FBOK|Rohdecke|Fertigfu(?:ß|ss)boden)\b")

_WORD_START = r"(?<![A-Za-zÄÖÜäöüß])"
_WORD_END = r"(?![A-Za-zÄÖÜäöüß])"

#: A verdict in words, in any of the spellings a model writes.
_VERDICT = re.compile(
    _WORD_START + r"(?:nicht\s+)?(?:erf(?:ü|ue)llt|zul(?:ä|ae)ssig|unzul(?:ä|ae)ssig|eingehalten|(?:ü|ue)berschritten"
    r"|unterschritten|gen(?:ü|ue)gt|ausreichend|unzureichend|passt|in\s+Ordnung|i\.\s?O\.?|iO|NOK|okay|ok"
    r"|knapp|kritisch|grenzwertig|mangelhaft|M(?:a|ä|ae)ngel"
    r"|zu\s+(?:steil|flach|lang|kurz|schmal|hoch|niedrig)"
    r"|(?:regel|norm)?konform|bestanden|nachgewiesen|entspricht|verfehlt"
    r"|pass(?:ed|es)?|fail(?:ed|s)?|(?:non-)?compliant)"
    + _WORD_END
    + r"|\bh(?:ä|ae)lt\b[^.;]{0,60}?\bein\b"
    # a traffic-light colour as the verdict after an arrow or a dash („Stiege A – grün")
    + r"|[→\-–—]\s*(?:gr(?:ü|ue)n|rot|gelb)"
    + _WORD_END
    + r"|\b(?:unter|(?:ü|ue)ber|unterhalb|oberhalb|innerhalb|au(?:ß|ss)erhalb)\s+(?:dem\s+|des\s+|der\s+)?"
    r"(?:Grenzwert|H(?:ö|oe)chstwert|Mindestwert|Anforderung|Limit|Soll)"
    r"|\b(?:kleiner|gr(?:ö|oe)(?:ß|ss)er|besser|schlechter|weniger|mehr|h(?:ö|oe)her|niedriger)\s+als\s+"
    r"(?:gefordert|erlaubt|zul(?:ä|ae)ssig|vorgeschrieben|(?:der|die|das)\s+(?:Grenzwert|Anforderung|Soll))",
    re.I,
)

#: A number with a unit, as a symbol or a word. Checked before any allow-list is
#: stripped, so „Plan 17 Zentimeter" is not a plan code followed by a word.
_MEASURE = re.compile(
    r"\d[\d.,]*\s*(?:mm|cm|dm|m²|m2|m³|m3|m|%|°|W\b|kWh|Millimeter|Zentimeter|Meter|Quadratmeter|Prozent|Grad)"
    + _WORD_END,
    re.I,
)

#: A comparison in signs, which no text needs: a sign compares a figure.
_COMPARISON_SIGN = re.compile(r"[≤≥<>⩽⩾=≈~±≠]")

#: The alphabet of a name, once its citations and identifiers are stripped:
#: letters, spaces and – · / , ( ) . - →. Anything else, a digit or a sign, is refused.
_NAME_ALPHABET = re.compile(r"(?:[^\W\d_]|[\s–·/,().\-→])*")

_DIGIT = re.compile(r"\d")


def _is_symbol(char: str) -> bool:
    return unicodedata.category(char) in ("So", "Sm", "Sk")


def _figure_in(value: str, *, name: bool) -> str | None:
    """What makes ``value`` carry a figure or a verdict, or None. ``name``: a title or label, not a text."""
    text = _TOP_EDGE.sub(" ", unicodedata.normalize("NFKC", value))
    if _VERDICT.search(text):
        return "a verdict"
    if _MEASURE.search(text):
        return "a measurement"
    stripped = _IDENTIFIER.sub(" ", _CITATION.sub(" ", text))
    if name:
        if not _NAME_ALPHABET.fullmatch(stripped):
            return "a character a name does not hold (a number, a sign or a symbol)"
        return None
    if _COMPARISON_SIGN.search(text) or any(_is_symbol(char) for char in text if char not in "§°"):
        return "a sign or a symbol"
    if _DIGIT.search(_DOCUMENT_REFERENCE.sub(" ", stripped)):
        return "a number that is neither a citation, an identifier nor a document reference"
    return None


def _no_figure(value: str | None, field: str, *, name: bool = True) -> str | None:
    found = _figure_in(value, name=name) if value else None
    if found:
        raise ValueError(
            f"`{field}` carries {found}: '{value}'. The card computes every figure and every verdict, so a "
            f"{'name names the component, never a value' if name else 'text says where or why, never what'}; "
            "put figures in the inputs. A number is allowed only in a citation (Pkt. 9.1.4, Tabelle 3, "
            "Zeile 1), an identifier (AW 01, Top 7, Büro 2.14, 2. OG)"
            f"{'' if name else ' or a document reference (Plan EP-01, Index B, Rev. 3, Pos. 63, a date)'}"
        )
    return value


class FormulaInput(CardModel):
    """One input of a named formula: the value the source gives, and whether the reader may change it.

    The UNIT is the formula's, not this object's: it is stated in the field that
    holds this input (``riser``: cm), and the renderer prints it.
    """

    value: float | None = Field(
        default=None,
        description=(
            "The value as the SOURCE gives it, in the unit the field names. Null when it is not known: the "
            "card then says it cannot judge, and the reader may type an assumption of their own"
        ),
    )
    editable: bool = Field(
        default=True,
        description=(
            "Whether the reader may change it for a what-if. False only for a figure that is not a design "
            "choice in this question (an existing wall's thickness the question does not touch)"
        ),
    )
    min: float | None = Field(default=None, description="Lowest plausible value, in the field's unit; omit if none")
    max: float | None = Field(default=None, description="Highest plausible value, in the field's unit; omit if none")
    step: float | None = Field(
        default=None, gt=0, description="The increment the arrow keys move by, e.g. 0.5 for cm, 0.001 for λ"
    )
    provenance: Provenance | None = Field(
        default=None,
        description=(
            "Where `value` came from, copied from the ifc_measure answer: 'declared', 'computed', 'inferred'. "
            "Null for a figure the user stated or one read from a document or a norm"
        ),
    )
    source: str | None = Field(
        default=None,
        description=(
            "Half a line naming WHERE the value is written: 'Einreichplan, Schnitt A-A', 'Ihre Angabe', "
            "'Produktdatenblatt'. Shown beside the input, so the reader knows what they are changing"
        ),
    )
    reference: NormReference | None = Field(
        default=None,
        description="When the value is a norm's own figure (a tabulated λ): where it is written. Never invent one",
    )

    @field_validator("source")
    @classmethod
    def _source_says_where_not_what(cls, value: str | None) -> str | None:
        return _no_figure(value, "source", name=False)

    @model_validator(mode="after")
    def _range_is_consistent(self) -> FormulaInput:
        if self.min is not None and self.max is not None and self.min >= self.max:
            raise ValueError("`min` must be below `max`")
        if self.value is not None:
            if self.min is not None and self.value < self.min:
                raise ValueError("`value` lies below `min`")
            if self.max is not None and self.value > self.max:
                raise ValueError("`value` lies above `max`")
        return self


class UValueLayer(CardModel):
    """One homogeneous layer of a component, inside to outside."""

    label: str = Field(
        min_length=1, description="The layer's material, never its thickness: 'Mineralwolle', 'Stahlbeton'"
    )
    thickness: FormulaInput = Field(description="Thickness d in cm")
    conductivity: FormulaInput = Field(description="Thermal conductivity λ in W/(m·K), the design value")

    @field_validator("label")
    @classmethod
    def _label_names_the_material(cls, value: str) -> str:
        return _no_figure(value, "label") or value


class UValueFormula(CardModel):
    """U = 1 / (R_si + Σ d/λ + R_se), for an opaque component of homogeneous layers (ÖNORM EN ISO 6946).

    `component` picks the row of OIB-RL 6 Pkt. 4.4.1 the card holds the U-value
    against, and with it the heat-flow direction for the surface resistances:
    an external wall (row 1, horizontal), a ceiling or roof slope against
    outside air (row 18, upward; a slope steeper than 60° counts as a wall),
    a ceiling over outside air such as a passage (row 22, downward). Only
    components against outside air: elsewhere R_se is not the standard's 0,04.
    Air layers, inhomogeneous layers and the standard's corrections are out of
    scope.

    `measure` picks the requirement: a new build (Pkt. 4.4.1, the table), or a
    renovation by single measures or the renewal of a component (Pkt. 4.5),
    which without a Sanierungskonzept is the table value less 24 %. A major
    renovation (größere Renovierung) is held to the energy figures of Pkt. 4.3,
    not to a component's U-value, so the card computes U and does not judge it.
    Unknown: the card cannot judge, because the bound depends on it.
    """

    name: Literal["u_value"]
    component: FormulaComponent = Field(
        description=(
            "Which component: 'external_wall', 'roof_or_ceiling_to_outside_air' (a ceiling or roof slope, "
            "slopes over 60° are walls), 'floor_over_outside_air' (a ceiling over a passage or parking deck)"
        )
    )
    measure: FormulaMeasure | None = Field(
        default=None,
        description=(
            "'new_build' (Pkt. 4.4.1), 'renovation' (single measures or a renewed component, Pkt. 4.5) or "
            "'major_renovation' (a größere Renovierung, held to the energy figures of Pkt. 4.3, which this "
            "card does not judge). Read it from the project context (existing_or_new); null when it is not "
            "known, and the card then says it cannot judge"
        ),
    )
    layers: list[UValueLayer] = Field(min_length=1, max_length=8, description="The layers, inside to outside")


class StairStepRuleFormula(CardModel):
    """2 × Stufenhöhe + Stufenauftritt = 62 ± 3 cm, and Tabelle 3's row for the stair (OIB-RL 4 Pkt. 3.2.1)."""

    name: Literal["stair_step_rule"]
    stair_type: FormulaStairType = Field(
        description=(
            "The row of Tabelle 3: 'main' (Haupttreppe, not a Wohnungstreppe), 'dwelling' (Wohnungstreppe, "
            "inside one dwelling), 'secondary' (Nebentreppe)"
        )
    )
    riser: FormulaInput = Field(description="Stufenhöhe (Steigung) s in cm")
    going: FormulaInput = Field(description="Stufenauftritt a in cm")


class EscapeRouteSegment(CardModel):
    """One leg of the escape route, measured along the walking line."""

    label: str = Field(min_length=1, description="The leg, by its ends, never its length: 'Raum → Gang'")
    length: FormulaInput = Field(description="Length in m")

    @field_validator("label")
    @classmethod
    def _label_names_the_leg(cls, value: str) -> str:
        return _no_figure(value, "label") or value


class EscapeRouteLengthFormula(CardModel):
    """The Gehweglänge, its legs added up, against 40 m (OIB-RL 2 Pkt. 5.1.1 and 5.1.2)."""

    name: Literal["escape_route_length"]
    start: FormulaRouteStart = Field(
        description=(
            "Where the route starts: 'room', the most remote point of the room (Pkt. 5.1.1); "
            "'dwelling_entrance', the Wohnungseingangstüre, for a dwelling over at most two storeys whose "
            "route leads to a Treppenhaus or Außentreppe (Pkt. 5.1.2, cases b and c)"
        )
    )
    segments: list[EscapeRouteSegment] = Field(min_length=1, max_length=8, description="The legs in walking order")


class DaylightRatioFormula(CardModel):
    """Lichteintrittsfläche against the room's Bodenfläche (OIB-RL 3 Pkt. 9.1.1, 9.1.3, 9.1.4).

    The required share is 12 %, raised to 15 % by an overhang over 1,50 m, by
    2 % per started metre of overhang beyond 3,00 m, and by 1 % per started
    metre of room depth beyond 5,00 m; the renderer derives it from the inputs.
    The free light angle of 45° (Pkt. 9.1.2) is a precondition the card states
    and does not check.
    """

    name: Literal["daylight_ratio"]
    opening_area: FormulaInput = Field(
        description="Lichteintrittsfläche: the Architekturlichte of the room's windows and skylights, in m²"
    )
    floor_area: FormulaInput = Field(description="Bodenfläche of the room in m²")
    room_depth: FormulaInput = Field(description="Raumtiefe in m, measured from the façade with the openings")
    overhang_depth: FormulaInput = Field(
        description=(
            "Depth of an overhang of the same building that shades the openings (balcony, eaves, loggia), "
            "from the façade, in m. 0 when there is none"
        )
    )


FormulaSpec = Annotated[
    UValueFormula | StairStepRuleFormula | EscapeRouteLengthFormula | DaylightRatioFormula,
    Field(discriminator="name"),
]


class FormulaCard(CardModel):
    """Emit for a number worked out by one of four named rules, so the reader can ask "what if" on the card.

    The rules: a U-value from its layers (u_value), the Schrittmaßregel and the
    stair table (stair_step_rule), an escape route's Gehweglänge
    (escape_route_length), the Lichteintrittsfläche against the Bodenfläche
    (daylight_ratio). Anything else worked out is a `calculation`.

    YOU SUPPLY THE CASE AND THE INPUTS, NEVER A NUMBER OF YOUR OWN. Name the
    case the rule asks for (`stair_type`, `component`, `start`) and fill each
    input from the project's documents, the user's own figures or the norm,
    with `source` saying where it is written. An input you do not have stays
    null: the card says it cannot judge, and the reader can enter an
    assumption. The card computes, takes the bound from the Richtlinie's table
    for that case, judges, and recomputes when the reader changes an input.
    The title names the component („U-Wert Außenwand AW 01"), never a value.
    """

    type: Literal["formula"]
    title: str = Field(
        min_length=1,
        description="The component the rule is applied to, never a value: 'U-Wert Außenwand AW 01', 'Stiege Haus B'",
    )
    formula: FormulaSpec = Field(description="The rule, by `name`, with its case and its inputs")
    note: str | None = Field(
        default=None,
        description="Optional one-line caveat in words, never a figure or a result, e.g. what the rule leaves out",
    )

    @field_validator("title")
    @classmethod
    def _title_names_the_component(cls, value: str) -> str:
        return _no_figure(value, "title") or value

    @field_validator("note")
    @classmethod
    def _note_states_no_figure(cls, value: str | None) -> str | None:
        return _no_figure(value, "note", name=False)


_FORMULA_SLOTS: dict[str, tuple[str, ...]] = {
    "stair_step_rule": ("riser", "going"),
    "daylight_ratio": ("opening_area", "floor_area", "room_depth", "overhang_depth"),
}


def formula_inputs(card: dict[str, Any]) -> list[dict[str, Any]]:
    """Every input object of a validated formula card's dict, in reading order. Pure."""
    formula = card.get("formula") or {}
    name = formula.get("name")
    if name == "u_value":
        return [layer[key] for layer in formula.get("layers") or [] for key in ("thickness", "conductivity")]
    if name == "escape_route_length":
        return [segment["length"] for segment in formula.get("segments") or []]
    return [formula[slot] for slot in _FORMULA_SLOTS.get(str(name), ()) if isinstance(formula.get(slot), dict)]


#: Fields no computing card has: a model that writes one is stating what the
#: renderer computes. They are dropped by validation like any unknown field,
#: and counted (`card-validity`, outcome `stripped`) so the drop is seen.
_STATED_RESULT_KEYS = frozenset({"result", "results", "limits"})


_COMPUTING_CARDS = ("calculation", "formula")


def _stated(node: Any) -> int:
    if isinstance(node, dict):
        return sum((key in _STATED_RESULT_KEYS) + _stated(value) for key, value in node.items())
    if isinstance(node, list):
        return sum(_stated(item) for item in node)
    return 0


def stated_result_fields(payload: Any) -> int:
    """How many fields of a raw computing card state what the card computes. Pure.

    A ``calculation`` or ``formula`` payload, or a ``surface`` whose leaves
    include them (a leaf names its type as ``component``).
    """
    if not isinstance(payload, dict):
        return 0
    if payload.get("type") in _COMPUTING_CARDS:
        return _stated(payload)
    if payload.get("type") == "surface":
        leaves = [leaf for leaf in payload.get("components") or [] if isinstance(leaf, dict)]
        return sum(_stated(leaf) for leaf in leaves if leaf.get("component") in _COMPUTING_CARDS)
    return 0


# ── Document-surfacing card (system-emitted) ─────────────────────────────────
# Surfaced by the `surface_documents` tool from a REAL search over the
# project + Büroablage (the `workspace-search` operation for a browse, the
# vector corpora otherwise) — never fabricated by the model (it is a system
# card, so `emit_card` refuses it). Each entry names a real indexed file so the
# frontend can resolve it to the live document row (id, thumbnail, preview) and
# render the same rich file-explorer card the Files page uses.


class SurfacedDocument(CardModel):
    """One real document surfaced by a corpus search, with its match evidence."""

    file_name: str = Field(min_length=1, description="Exact indexed file name (resolves to the live document row)")
    summary: str | None = Field(default=None, description="One-line description of what the document is")
    snippet: str | None = Field(default=None, description="Best-matching passage — WHY this file surfaced")
    page: int | None = Field(default=None, description="1-based page the snippet came from, if known")
    score: float | None = Field(default=None, description="0..1 relevance score of the best chunk")
    source: Literal["project", "office"] | None = Field(
        default=None, description="Which corpus it came from: 'project' or 'office' (Büroablage)"
    )


class DocumentGridSearch(CardModel):
    """The ``workspace-search`` question a browse ran, so the reader can open the full result.

    Set by ``surface_documents`` only when the files came from that operation; the
    card then links to the search page with the same text and scope.
    """

    text: str = Field(min_length=1, max_length=500, description="The search text, as the operation was asked")
    scope: Literal["office", "project", "office_shelf"] = Field(
        description="Where it looked: this project, the office shelf, or both (the office)"
    )


class DocumentGridCard(CardModel):
    """Project/Büroablage files the user asked to see.

    System-emitted by ``surface_documents``. One file or a short browse
    choice — same card, the list length is the difference. Never a
    catalogue. Citations of exactly one project/Büro file peek without
    this card (``useCitationPeek``).
    """

    type: Literal["document_grid"] = "document_grid"
    title: str = Field(min_length=1, description="Short heading, e.g. 'Relevante Dokumente – Fluchtwege'")
    query: str | None = Field(default=None, description="The search phrase these documents matched")
    documents: list[SurfacedDocument] = Field(min_length=1, description="The surfaced files, best match first")
    search: DocumentGridSearch | None = Field(
        default=None,
        description="The workspace search these documents came from; the card offers to open the search page asking it",
    )


# ── Draft card (system-emitted) ──────────────────────────────────────────────
#: The editorial states of a document version, mirrored (not imported) from
#: ``DOCUMENT_VERSION_STATES`` in
#: ``frontends/ui/src/lib/documents/lifecycle-types.ts`` — the same
#: parse-independently rule the request-context headers follow, since the
#: contract crosses a language boundary and the JSON Schema at
#: ``frontends/ui/tests/fixtures/document-lifecycle.schema.json`` is what pins
#: the two together (``tests/aiq_agent/tools/documents/test_wire_contract.py``).
DocumentVersionState = Literal[
    "draft",
    "in_review",
    "changes_requested",
    "approved",
    "published",
    "superseded",
    "rejected",
]

# The one thing that says a chat turn WROTE something. Pushed by `write_file`
# and `edit_file` from the conversation's working directory
# (`tools/documents/draft_store.py`), never by the model: a draft the reader can
# open has to be a file that exists, and a fabricated one would name a path
# nothing wrote.


class DocumentDraftCard(CardModel):
    """A document the agent wrote into this conversation's working directory.

    System-emitted by the working directory's ``write_file`` / ``edit_file``, and
    again by ``file_draft`` once the draft has become a project document.

    **The card has two states, and the difference is three fields.** Unfiled, it
    reports a file that exists in this conversation and nowhere else: not filed,
    not indexed, not citable, not in the Files pane. Filed, it names a
    ``documents`` row — and then it can offer the two things a reader wants,
    opening it and sending it for review, both through the routes the Files pane
    itself uses.

    The three fields travel together or not at all: a card carrying a
    ``document_id`` and no ``version_state`` could not say whether the draft is
    still submittable, and one carrying a state with no ``version_id`` could not
    submit it. ``_require_filed_together`` is what refuses the half-filled shape,
    because the alternative is a card that renders a live-looking control over
    nothing.
    """

    type: Literal["document_draft"] = "document_draft"
    title: str = Field(min_length=1, description="The document's first heading, or its file name when it has none")
    path: str = Field(min_length=1, description="Path in the working directory, e.g. '/drafts/aktenvermerk.md'")
    bytes: int = Field(ge=0, description="Size of the draft as stored, in UTF-8 bytes")
    version: int = Field(ge=1, description="How often this path has been written or edited in this conversation")
    document_id: str | None = Field(
        default=None, description="The project document this draft was filed as; absent while it is unfiled"
    )
    version_id: str | None = Field(
        default=None, description="The open version of that document — what 'submit for review' acts on"
    )
    version_state: DocumentVersionState | None = Field(
        default=None, description="That version's editorial state, as the lifecycle API last reported it"
    )

    @model_validator(mode="after")
    def _require_filed_together(self) -> DocumentDraftCard:
        filed = (self.document_id, self.version_id, self.version_state)
        if any(filed) and not all(filed):
            raise ValueError(
                "document_id, version_id and version_state are the filed state and travel together: "
                "a card with some of them cannot say what it is offering"
            )
        return self


# ── Task created (system-emitted, informational) ─────────────────────────────
# Pushed by `create_task` (`tools/tasks/register.py`) and by nothing else. A
# delegated task is a ROW the BFF has already created by the time the card
# exists, so this card REPORTS rather than proposes: there is nothing to accept,
# and a control here would offer to do a second time what the tool just did.

#: The kinds a person may delegate. The one source: `create_task` reads it here,
#: and `scripts/generate_vocabularies.py` renders it to the UI's
#: `DELEGATABLE_TASK_KINDS` (`frontends/ui/src/shared/vocabularies.generated.ts`).
TaskKind = Literal["compliance_check", "submission_check", "document", "revision"]


class TaskCreatedCard(CardModel):
    """Work Piloti has taken on, as a row somebody can come back to.

    System-emitted by ``create_task``. What it exists to prevent is the answer
    „ich mache den Einreichcheck bis Freitag“ with nothing behind it: the card is
    proof there is a row, and the row is what carries the requester's permission,
    the deadline and — when a person judges the result — the decision that reaches
    the next attempt (ADR-0051).

    Informational, not interactive. The task is already queued when this renders,
    so there is no Accept: a control would either repeat the delegation or cancel
    it, and cancelling delegated work is a Files-and-tasks surface decision, not
    a chat one.

    ``conversation_id`` is the thread the run writes into, so the card can link a
    reader to the work rather than only announce it. Absent when the run's
    conversation could not be created, which is the same degraded shape a
    scheduled job has had since jobs got conversations at all.
    """

    type: Literal["task_created"] = "task_created"
    task_id: str = Field(min_length=1, description="The task row's id")
    kind: TaskKind = Field(description="What kind of work was delegated")
    title: str = Field(min_length=1, max_length=200, description="What the task is called in the inbox and the list")
    goal: str = Field(min_length=1, max_length=500, description="What was asked, in the requester's own words")
    due_at: str | None = Field(
        default=None, description="ISO instant the work is wanted by, or absent when none was named"
    )
    conversation_id: str | None = Field(
        default=None, description="The conversation the run writes into; absent when it could not be created"
    )


# ── File-operation proposal (system-emitted, interactive) ────────────────────
# ONE card type for four verbs, discriminated by `operation`, because the
# alternative is four cards that differ in one field and share every line of
# their chrome, their decision lifecycle and their i18n. The one write-side
# workspace tool (`tools/files/`) emits this card and NEVER performs the
# operation: the Python tier holds no path into `app` (ADR-0003), so
# accepting it is what executes. With `proposal_id` the server applies the
# stored proposal in the accepting person's session (ADR-0105); without one the
# browser runs it through the routes the Files pane uses, in the reader's own
# session. Either way under `requireProjectAccess`.
#
# The batch is why `operations` is a list, capped, every entry sharing the
# card's `operation` kind: „Räum die Einreichunterlagen zusammen" is four
# moves. A stored proposal cannot grow, so a card carries the one operation of
# the call that created it and the list is the contract's shape, not a batch
# (`tools/files/cards.py` says why).

#: How many operations one card may carry. A tidying turn proposes a handful;
#: past that the card stops being a decision the reader can actually read
#: before answering, and „alles verschieben" is not a proposal, it is a job.
MAX_FILE_OPERATIONS = 8

#: The four operations, each an `operation` value of the one tool that emits
#: them, `propose_file_change` (four tools, one per kind, until they merged).
#:
#: A fifth, `set_doc_class`, was here and is gone. A project document has no
#: doc_class route for an Accept to run, so the card drew the proposal and no
#: control — a decision the reader could read and could not take. It comes back
#: with the route, not before it.
FileOperationKind = Literal["move", "rename", "create_folder", "assign"]


class FileOperationItem(CardModel):
    """One proposed change, in the vocabulary of the operation that owns it.

    Deliberately flat with per-operation fields rather than a nested union: the
    card is built by the tool, validated once here, and rendered by one
    component that switches on the CARD's `operation` — a shape the frontend's
    generated Zod can narrow without a second discriminator inside every row.
    :meth:`FileOperationProposalCard._require_operation_fields` is what keeps a
    row from carrying another operation's fields.

    ``document`` is a FILE NAME and never an id. The agent's inventory
    (``knowledge/inventory.py``) knows files by ``(collection, file_name)`` and
    has no document ids in it at all, so a card carrying an id would be
    carrying something the tool invented. The reader's session resolves the
    name against their own document list when they accept.
    """

    document: str | None = Field(
        default=None,
        description="File name exactly as the inventory lists it (move, rename, assign)",
    )
    source: Literal["project", "office"] | None = Field(
        default=None,
        description="Which shelf the document sits on, so the name resolves in the right corpus",
    )
    current: str | None = Field(
        default=None,
        description="What this is TODAY (current folder or name) — for the before/after line",
    )
    target_folder: str | None = Field(
        default=None,
        description="move: the destination folder PATH, e.g. 'Einreichung/Akten'. Empty string is the project root",
    )
    new_display_name: str | None = Field(default=None, description="rename: the new display name")
    folder_name: str | None = Field(default=None, description="create_folder: the new folder's own name (one segment)")
    parent_folder: str | None = Field(
        default=None,
        description="create_folder: the parent folder PATH, or an empty string for the project root",
    )
    member: str | None = Field(
        default=None,
        description="assign: the person as the user named them; the reader's session resolves it against the project",
    )
    reason: str | None = Field(
        default=None,
        max_length=300,
        description="Why this change, one short sentence the reader sees under the row",
    )


class FileOperationProposalCard(CardModel):
    """A workspace change the agent PROPOSES and a person applies.

    System-emitted by ``propose_file_change`` (``src/aiq_agent/tools/files/``).
    Every operation is a write, none of them writes: the tool's own result text
    says plainly that nothing has changed yet. With ``proposal_id`` the card
    shows a proposal stored on the server (ADR-0105), which the server applies
    in the accepting person's session; it then carries the one operation of
    the call that created it. Without one (an older BFF, a run with no
    envelope, a refusal) the proposal was not stored: the UI draws the card
    read-only, saying so, and the browser executes nothing.
    """

    type: Literal["file_operation_proposal"] = "file_operation_proposal"
    title: str = Field(min_length=1, description="Short action title, e.g. 'Vier Dateien in „Einreichung“ verschieben'")
    operation: FileOperationKind = Field(description="Which verb every entry in `operations` is")
    operations: list[FileOperationItem] = Field(
        min_length=1,
        max_length=MAX_FILE_OPERATIONS,
        description="The proposed changes, in the order they will be applied",
    )
    note: str | None = Field(default=None, description="One line of context under the list, when it adds something")
    proposal_id: str | None = Field(
        default=None,
        pattern=PROPOSAL_ID_PATTERN,
        description=(
            "The server proposal this card shows (POST /api/internal/proposals). Absent: the proposal was not "
            "stored, and the card is a read-only notice that nothing was proposed"
        ),
    )

    @model_validator(mode="after")
    def _require_operation_fields(self) -> FileOperationProposalCard:
        """Every entry must carry what its verb needs, and nothing it does not.

        The card is built in Python, so this is not a guard against a model —
        it is the guard against a TOOL that grows a fifth caller and forgets a
        field. A row missing its target renders as a proposal to do nothing,
        which the reader would accept.
        """
        required: dict[str, tuple[str, ...]] = {
            "move": ("document", "target_folder"),
            "rename": ("document", "new_display_name"),
            "create_folder": ("folder_name",),
            "assign": ("document", "member"),
        }[self.operation]
        for index, item in enumerate(self.operations):
            missing = [name for name in required if getattr(item, name) is None]
            if missing:
                raise ValueError(f"operation {index} ({self.operation}) is missing {', '.join(missing)}")
        return self


# ── Canvas activity (system-emitted) ───────────────────────────────────────
# What Piloti did on a document in this turn: the marks it proposed or set at
# the person's request, the marks it changed or deleted for them, and the
# threads it answered (`tools/canvas/`). The chat says it in prose; the card is
# the proof, built from what the BFF returned (the mark's id and number), so a
# reader can open the document at exactly that mark. One card per document per
# turn, extended by every further call (`tools/canvas/cards.py`), the way the
# file-operation card is. Interactive (`INTERACTIVE_CARD_TYPES`): a proposed mark
# is taken over or dismissed on this card or on the document, whichever the
# person reaches first. Both go through the same annotations API, which changes a
# mark's status by compare-and-swap, so the second of the two sees a 409 and
# shows the state the first one left. Its decisions are stored per mark. A
# change Piloti made carries what each field was before and after, so the
# person can undo it from the card through the same API, guarded by the status
# Piloti left (a colleague's later move is a 409, never undone).

#: How many entries one card carries: the `mark` tool proposes at most 20 per call.
MAX_CANVAS_ACTIVITY_ITEMS = 20


class CanvasDocument(CardModel):
    """The document the activity happened on, by the BFF's id and its file name."""

    id: str = Field(
        pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        description="The document's id, as the BFF returned it",
    )
    name: str = Field(min_length=1, description="The file name, as the BFF returned it")


class _CanvasSetMark(CardModel):
    """A mark Piloti set on a page: where, what kind, what it says."""

    annotation_id: str = Field(min_length=1, description="The mark's id")
    number: int = Field(ge=1, description="The mark's number on the document")
    page: int = Field(ge=1, description="The page, from 1")
    shape: Literal["point", "region"]
    x: float = Field(ge=0, le=1, description="Left edge (or the point), as a share of the page's width")
    y: float = Field(ge=0, le=1, description="Top edge (or the point), as a share of the page's height")
    w: float | None = Field(default=None, gt=0, le=1, description="Width share, for a region")
    h: float | None = Field(default=None, gt=0, le=1, description="Height share, for a region")
    kind: Literal["hint", "question", "defect"]
    body: str = Field(min_length=1, max_length=2000, description="What the mark says")


class CanvasProposedItem(_CanvasSetMark):
    """A mark Piloti proposed: a person takes it over or dismisses it on the document."""

    action: Literal["proposed"] = "proposed"


class CanvasCreatedItem(_CanvasSetMark):
    """A mark Piloti set because the person asked for it: open at once, in the person's name."""

    action: Literal["created"] = "created"


class CanvasFieldChange(CardModel):
    """One field a change moved. An absent ``before``/``after`` is an empty field (no assignee, no date)."""

    field: Literal["status", "assignee", "due_on", "kind", "body"]
    before: str | None = Field(default=None, max_length=2000, description="The value before; absent when empty")
    after: str | None = Field(default=None, max_length=2000, description="The value after; absent when empty")
    before_label: str | None = Field(default=None, max_length=200, description="The assignee's name before")
    after_label: str | None = Field(default=None, max_length=200, description="The assignee's name after")


class CanvasChangedItem(CardModel):
    """A mark Piloti changed because the person asked: what moved, the note it left, and the status it left."""

    action: Literal["changed"] = "changed"
    annotation_id: str = Field(min_length=1, description="The mark's id")
    number: int = Field(ge=1, description="The mark's number on the document")
    status: Literal["proposed", "open", "resolved", "dismissed"] = Field(
        description="The mark's status after the change: what an undo expects to find"
    )
    changes: list[CanvasFieldChange] = Field(min_length=1, max_length=5)
    note: str = Field(min_length=1, max_length=300, description="The start of Piloti's note in the thread")


class CanvasDeletedItem(CardModel):
    """A mark Piloti deleted because the person who set it asked. Gone with its thread; no undo."""

    action: Literal["deleted"] = "deleted"
    number: int = Field(ge=1, description="The deleted mark's number")
    body: str = Field(min_length=1, max_length=2000, description="What the mark said")


class CanvasRepliedItem(CardModel):
    """An answer Piloti wrote in a mark's thread."""

    action: Literal["replied"] = "replied"
    annotation_id: str = Field(min_length=1, description="The mark whose thread was answered")
    number: int = Field(ge=1, description="The mark's number on the document")
    excerpt: str = Field(min_length=1, max_length=300, description="The start of the reply")


CanvasActivityItem = Annotated[
    CanvasProposedItem | CanvasCreatedItem | CanvasChangedItem | CanvasDeletedItem | CanvasRepliedItem,
    Field(discriminator="action"),
]


class CanvasActivityCard(CardModel):
    """What Piloti did on one document in this turn: marks proposed or set, changed, deleted, threads answered.

    A proposed mark is taken over or dismissed from here as well as on the
    document, and a change is undone from here, through the same annotations API.

    System-emitted by the canvas tools (``src/aiq_agent/tools/canvas/``) after
    the BFF confirmed each write; the model cannot emit it (``SYSTEM_CARD_TYPES``).
    """

    type: Literal["canvas_activity"] = "canvas_activity"
    document: CanvasDocument
    items: list[CanvasActivityItem] = Field(
        min_length=1,
        max_length=MAX_CANVAS_ACTIVITY_ITEMS,
        description="What happened, in the order it happened",
    )


# ---------------------------------------------------------------------------
# Look card (ADR-0128)
# ---------------------------------------------------------------------------
# Where Piloti looked: one card per document per turn, an item per look the
# answer relies on, and a `reference` item per box or pointer Piloti showed the
# room (`highlight`, `point`). Built by `tools/look/cards.py` once the answer is
# final; the model cannot emit it (`SYSTEM_CARD_TYPES`).
#
# An item is an ADDRESS, never pixels: the document, its Fassung, the page, the
# region. The browser draws the thumbnail from the document's own preview route,
# so who may see the crop is decided exactly as for the document. A string that
# starts `data:` is refused anywhere on the card, so no field can smuggle an
# image in.

#: How many items one card carries: the turn's look budget is 6, plus the
#: gestures that point at the same document.
MAX_LOOK_ITEMS = 12

_UUID_PATTERN = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
#: A text that is not a `data:` URL, as a pattern, so the generated JSON Schema
#: and Zod schema refuse one too (a lookahead: these models use Python's `re`).
_NOT_A_DATA_URL = r"^(?!\s*[dD][aA][tT][aA]:)"
#: A share of the page or image: 0 to 1.
_Share = Annotated[float, Field(ge=0, le=1)]


def _refuse_data_urls(value: Any, path: str = "card") -> None:
    """Raise on any string under ``value`` that starts ``data:``: a card stores an address, never bytes."""
    if isinstance(value, str):
        if value.lstrip()[:5].lower() == "data:":
            raise ValueError(f"{path}: a look card holds an address, never image bytes (a `data:` URL)")
    elif isinstance(value, dict):
        for key, item in value.items():
            _refuse_data_urls(item, f"{path}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            _refuse_data_urls(item, f"{path}[{index}]")


class LookDocument(CardModel):
    """The document looked at: its id when it is a workspace document, its file name, its shelf."""

    model_config = ConfigDict(regex_engine="python-re")

    id: str | None = Field(
        default=None,
        pattern=_UUID_PATTERN,
        description="The workspace document's id; absent for a base-corpus document or when it was not resolved",
    )
    name: str = Field(min_length=1, max_length=300, pattern=_NOT_A_DATA_URL, description="The file name")
    shelf: Literal["stored", "base"] = Field(
        default="stored",
        description="`stored`: a document of the office or the project; `base`: the platform corpus (Basiswissen)",
    )


class LookItem(CardModel):
    """One place on the document: a look Piloti took, or a box or pointer it showed the room (`reference`)."""

    model_config = ConfigDict(regex_engine="python-re")

    origin: Literal["look", "reference"] = Field(
        default="look", description="`look`: Piloti looked here; `reference`: Piloti pointed the room here"
    )
    page: int = Field(ge=1, description="The page, from 1")
    frame: Literal["page", "image"] = Field(
        default="page", description="`page`: the region is on the page as shown; `image`: on the embedded image"
    )
    scope: Literal["overview", "region", "point"] = Field(
        description="`overview`: the whole page or image; `region`: a box on it; `point`: a pointer"
    )
    region: list[_Share] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="[x, y, w, h] as shares of the frame, origin top left; x + w and y + h at most 1",
    )
    point: list[_Share] | None = Field(
        default=None, min_length=2, max_length=2, description="[x, y] of a pointer, as shares of the page"
    )
    image_index: int | None = Field(default=None, ge=0, description="The embedded image, for frame `image`")
    revision_id: str | None = Field(
        default=None,
        min_length=1,
        max_length=128,
        pattern=r"^[A-Za-z0-9_.-]+$",
        description="The Fassung looked at; absent means the document's current Fassung",
    )
    question: str | None = Field(
        default=None, max_length=200, pattern=_NOT_A_DATA_URL, description="What Piloti looked for"
    )
    reading: str | None = Field(
        default=None, max_length=300, pattern=_NOT_A_DATA_URL, description="The first thing read there"
    )
    label: str | None = Field(
        default=None, max_length=80, pattern=_NOT_A_DATA_URL, description="A reference's label, as the room saw it"
    )
    where: str | None = Field(
        default=None, max_length=60, pattern=_NOT_A_DATA_URL, description="The region in words, e.g. „oben rechts“"
    )

    @model_validator(mode="after")
    def _a_place(self) -> LookItem:
        if self.region is not None:
            x, y, w, h = self.region
            if w <= 0 or h <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
                raise ValueError("the region reaches past the frame or has no area: x + w and y + h are at most 1")
        if self.scope == "region" and self.region is None:
            raise ValueError("a `region` item names its region")
        if self.scope == "point" and self.point is None:
            raise ValueError("a `point` item names its point")
        if self.frame == "image" and self.image_index is None:
            raise ValueError("an `image` frame names its `image_index`")
        return self


class LookCard(CardModel):
    """Where Piloti looked on one document in this turn, and what it showed the room there.

    System-emitted (``tools/look/cards.py``) once the answer is final, from the
    looks the answer relies on; the model cannot emit it (``SYSTEM_CARD_TYPES``).
    """

    type: Literal["look"] = "look"
    document: LookDocument
    items: list[LookItem] = Field(
        min_length=1, max_length=MAX_LOOK_ITEMS, description="The places, in the order Piloti reached them"
    )

    @model_validator(mode="before")
    @classmethod
    def _no_bytes(cls, data: Any) -> Any:
        _refuse_data_urls(data)
        return data


# ---------------------------------------------------------------------------
# Revision compare card (ADR-0128, slice V10)
# ---------------------------------------------------------------------------
# Two Fassungen of a document side by side with what changed boxed on each.
# Built by `tools/workspace/cards.py` from the result of the
# `document-revision-compare` operation; the model cannot emit it
# (`SYSTEM_CARD_TYPES`). Like the look card it is an ADDRESS (the two documents'
# ids, the page, the boxes), never pixels: the browser draws each thumbnail from
# the document's own routes, so only a reader who may open both sees the pages.

#: Changes one card carries: the comparison returns at most this many boxes.
MAX_REVISION_CHANGES = 12
#: Sentences one card carries: the comparison returns at most this many.
MAX_REVISION_SUMMARY = 8


class RevisionCompareChange(CardModel):
    """One change, boxed on the page (the same frame on both Fassungen)."""

    model_config = ConfigDict(regex_engine="python-re")

    region: list[_Share] = Field(
        min_length=4,
        max_length=4,
        description="[x, y, w, h] as shares of the page, origin top left; x + w and y + h at most 1",
    )
    label: str = Field(min_length=1, max_length=200, pattern=_NOT_A_DATA_URL, description="What changed there")

    @model_validator(mode="after")
    def _a_box(self) -> RevisionCompareChange:
        x, y, w, h = self.region
        if w <= 0 or h <= 0 or x + w > 1 + 1e-6 or y + h > 1 + 1e-6:
            raise ValueError("the region reaches past the page or has no area: x + w and y + h are at most 1")
        return self


class RevisionCompareCard(CardModel):
    """The same page of an older and a newer Fassung, side by side, with the changes boxed on each.

    System-emitted (``tools/workspace/cards.py``) from a ``document-revision-compare``
    result; the model cannot emit it (``SYSTEM_CARD_TYPES``). The boxes were found
    on the newer page and are drawn at the same place on the older one.
    """

    model_config = ConfigDict(regex_engine="python-re")

    type: Literal["revision_compare"] = "revision_compare"
    older_id: str = Field(pattern=_UUID_PATTERN, description="The older Fassung's workspace document id")
    newer_id: str = Field(pattern=_UUID_PATTERN, description="The newer Fassung's workspace document id")
    older_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        pattern=_NOT_A_DATA_URL,
        description="The older Fassung's file name, when the comparison named it; the side's label",
    )
    newer_name: str | None = Field(
        default=None,
        min_length=1,
        max_length=255,
        pattern=_NOT_A_DATA_URL,
        description="The newer Fassung's file name, when the comparison named it; the side's label",
    )
    page: int = Field(ge=1, description="The page compared, from 1; the same page of both Fassungen")
    changes: list[RevisionCompareChange] = Field(
        default_factory=list, max_length=MAX_REVISION_CHANGES, description="The boxed changes; empty when none"
    )
    summary: list[Annotated[str, Field(min_length=1, max_length=400, pattern=_NOT_A_DATA_URL)]] = Field(
        min_length=1, max_length=MAX_REVISION_SUMMARY, description="What changed, in short sentences"
    )

    @model_validator(mode="before")
    @classmethod
    def _no_bytes(cls, data: Any) -> Any:
        _refuse_data_urls(data)
        return data


# ---------------------------------------------------------------------------
# IFC/BIM viewer card
# ---------------------------------------------------------------------------
# The one card that renders the architect's ACTUAL building rather than a
# schematic of it. Everything else in this catalog is drawn from numbers the
# model supplies; this one points at geometry that already exists, so the model
# supplies only WHICH elements to look at and why.
#
# The model never invents an element: `global_ids` must be IFC GlobalIds that
# came back from the `ifc_query` tool in the same turn. An id that does not
# exist in the model simply does not highlight — the viewer shows the building
# and says how many highlights it could not resolve, rather than pretending.


class IfcPropertyMatch(CardModel):
    """One property predicate, in ifc_query's own filter grammar."""

    name: str = Field(min_length=1, description="Property name, e.g. 'IsExternal' or 'FireRating'")
    set: str | None = Field(
        default=None,
        description="Property-set name, e.g. 'Pset_WallCommon'. Omit to search every set.",
    )
    operator: Literal["eq", "neq", "contains", "gt", "gte", "lt", "lte", "exists", "missing"] = Field(
        default="eq", description="Comparison. 'exists'/'missing' take no value."
    )
    value: str | float | bool | None = Field(default=None, description="Value to compare against")
    source: Literal["property", "quantity"] = Field(
        default="property", description="Which store to search: 'property' (default) or 'quantity'"
    )


class IfcElementMatch(CardModel):
    """The SET of elements to highlight, as a filter rather than a list of ids.

    Exactly the ``filters`` object passed to ``ifc_query`` — the browser re-runs
    it against the model, so the highlight covers every matching element and
    nothing has to survive the model's context window.

    ``ifc_query`` spells its filter keys in camelCase (``ifcTypes``,
    ``nameContains``) and this card is authored in snake_case like every other
    card field. The agent is told to reuse the filter it already wrote, so BOTH
    spellings are accepted and normalise to the snake_case field: without the
    aliases a copied filter validated cleanly with every key silently dropped,
    leaving an empty match, and a highlight group that selects nothing.
    """

    model_config = ConfigDict(populate_by_name=True)

    ifc_types: list[str] | None = Field(
        default=None,
        validation_alias=AliasChoices("ifc_types", "ifcTypes"),
        description="Canonical IFC types, e.g. ['IfcWall']",
    )
    storeys: list[str] | None = Field(default=None, description="Storey names, e.g. ['Erdgeschoss']")
    name_contains: str | None = Field(
        default=None,
        validation_alias=AliasChoices("name_contains", "nameContains"),
        description="Case-insensitive substring of the element name",
    )
    material: str | None = Field(default=None, description="Case-insensitive substring of a material name")
    classification: str | None = Field(
        default=None, description="Case-insensitive substring of a classification code or label"
    )
    properties: list[IfcPropertyMatch] | None = Field(default=None, description="Property predicates, all required")

    def is_empty(self) -> bool:
        """True when no criterion was given at all.

        An empty filter means "every element in the building", which would
        light up the whole model under a label like *nicht erfüllt*. The
        frontend refuses it, so without this check the card validated, the
        group reached the browser, and it was dropped there — the legend lost
        an entry with no signal to anyone.
        """
        return not any(
            (self.ifc_types, self.storeys, self.name_contains, self.material, self.classification, self.properties)
        )


class IfcHighlight(CardModel):
    """One set of model elements to call out, with a verdict.

    EXACTLY ONE of ``match`` or ``global_ids`` — never both, never neither.
    (Stated here because the rendered card catalogue lists a model's fields
    from ``model_fields`` and never sees a ``model_validator``: both selectors
    therefore appear as plain optionals, and the worked example — one group of
    each kind — reads as permission to supply both. A highlight that does is
    dropped, taking its whole card with it.)

    Prefer ``match`` whenever the
    answer is about a set rather than about elements you named. An id list has
    to travel through the model's context, so "the 420 external walls" arrived
    as whatever fitted and the card highlighted a fraction of the answer while
    the legend claimed all of it. A filter is re-run in the browser: the whole
    set lights up, and it costs the model a filter it has already written.
    """

    global_ids: list[str] | None = Field(
        default=None,
        min_length=1,
        description=(
            "IFC GlobalIds returned by ifc_query OR by ifc_measure. NEVER invent these — an id you did "
            "not see is a wrong answer. Use for a handful of elements the answer names; use 'match' for "
            "a set. When the answer came from a MEASUREMENT, the ids to highlight are the ones the "
            "measurement itself names: every ifc_measure answer ends with a 'Bezug:' line listing exactly "
            "the elements the number was derived from, and highlighting those shows the user the thing "
            "that was measured rather than a description of it."
        ),
    )
    match: IfcElementMatch | None = Field(
        default=None,
        description=(
            "The ifc_query filter that selects this set. Preferred over global_ids for anything "
            "larger than a few elements — reuse the exact filters you queried with."
        ),
    )
    label: str = Field(min_length=1, description="What is being shown, e.g. 'Fluchtweg > 40 m'")
    status: Literal["pass", "fail", "warning", "info"] = Field(
        default="info", description="Verdict colour: pass=green, fail=red, warning=amber, info=neutral"
    )

    @model_validator(mode="after")
    def exactly_one_selector(self) -> IfcHighlight:
        """A group with neither selects nothing; with both, the two disagree.

        Both is the dangerous one: the renderer would have to pick, and either
        choice silently discards half of what the model asked for.
        """
        if (self.global_ids is None) == (self.match is None):
            raise ValueError("give exactly one of 'global_ids' or 'match'")
        if self.match is not None and self.match.is_empty():
            raise ValueError("'match' needs at least one criterion — an empty filter selects the whole building")
        return self


class IfcViewerCard(CardModel):
    """The project's IFC model, rendered in 3D, with findings highlighted on it.

    Use when the answer is ABOUT specific parts of the building and seeing them
    beats reading their names — a compliance finding on particular walls, the
    rooms that fall below a required area, the escape route being discussed.
    Do NOT use it as a decorative "here is your building": an unhighlighted
    viewer says nothing a sentence does not.
    """

    type: Literal["ifc_viewer"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Brandabschnitte – EG'")
    model_file: str | None = Field(
        default=None,
        description=(
            "File name of the model, exactly as ifc_query reported it (e.g. 'haus-a.ifc'). "
            "Leave empty when the project has only one model."
        ),
    )
    highlights: list[IfcHighlight] | None = Field(
        default=None, description="Element groups to colour in the viewer, each with a verdict"
    )
    storey: str | None = Field(default=None, description="Storey name to isolate on open, e.g. 'Erdgeschoss'")
    note: str | None = Field(default=None, description="Optional one-line clarification under the viewer")


class IfcScheduleCard(CardModel):
    """The project's Raumbuch (room schedule) straight from the model.

    The card names WHICH table to show; the frontend fetches the numbers from
    the model itself. The model therefore cannot get an area wrong, because it
    never supplies one — the same reason the viewer card carries GlobalIds and
    not geometry.

    Use when the user asks for room areas, a Flächenaufstellung, or "what rooms
    are on the second floor".
    """

    type: Literal["ifc_schedule"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Flächenaufstellung'")
    model_file: str | None = Field(
        default=None,
        description="File name of the model as ifc_query reported it. Empty when the project has one model.",
    )
    storey: str | None = Field(
        default=None, description="Limit the table to one storey, e.g. 'Erdgeschoss'. Empty shows all."
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


class IfcComplianceCard(CardModel):
    """The Prüfbuch: OIB requirements with their verdict against this model.

    Carries only WHICH requirements to show; the frontend runs the catalogue and
    renders the counts, the thresholds and the failing elements itself. The
    model therefore cannot state that a building complies, because it never
    supplies a verdict — the same reason the schedule card carries no areas.

    Use when the user asks whether the model meets a requirement, what is still
    open, or what they have to add to the model. Prefer it over prose whenever
    the answer is a list of requirements: the card stays correct after the model
    changes, and a sentence does not.

    NEVER present this as proof of compliance (a Nachweis). The catalogue reads only published
    property values, it reads no geometry, and escape-route lengths, guardrail
    heights and fire-compartment sizes are not in it at all.
    """

    type: Literal["ifc_compliance"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Anforderungen Brandschutz'")
    model_file: str | None = Field(
        default=None,
        description="File name of the model as ifc_query reported it. Empty when the project has one model.",
    )
    rule_ids: list[str] = Field(
        default_factory=list,
        max_length=20,
        description=(
            "Rule ids from ifc_query operation='compliance' (e.g. 'oib2-fire-resistance-load-bearing') "
            "to narrow the card to the requirements this answer is about. Empty shows all. "
            "Use ONLY ids the tool reported; the card says so when one does not resolve."
        ),
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


class IfcElementCard(CardModel):
    """One element of the model, in full, with a link into the 3D view.

    Use when the answer is ABOUT a specific element the user will want to look
    at — the wall that fails a requirement, the door being discussed. The card
    carries only the GlobalId; every property shown is read live from the model.
    """

    type: Literal["ifc_element"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Aussenwand Nord'")
    global_id: str = Field(
        min_length=1,
        description=(
            "IFC GlobalId returned by ifc_query. NEVER invent one — an id you did not see resolves to nothing."
        ),
    )
    model_file: str | None = Field(default=None, description="Model file name; empty when there is one model.")
    note: str | None = Field(default=None, description="Why this element matters to the answer")


class IfcDiffCard(CardModel):
    """What changed between two revisions of the model.

    Names the two files; the frontend computes the comparison by IFC GlobalId.
    Use for "what changed since the last submission" — the question a pair of
    plan PDFs cannot answer.
    """

    type: Literal["ifc_diff"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Änderungen seit Einreichung'")
    base_model_file: str = Field(min_length=1, description="The OLDER revision's file name")
    model_file: str | None = Field(
        default=None, description="The NEWER revision's file name. Empty uses the project's current model."
    )
    note: str | None = Field(default=None, description="Optional one-line clarification")


class IfcModelPickerCard(CardModel):
    """A clickable list of the project's IFC models — pick one to open in the viewer.

    Emit for "zeig mir das Modell" / "welches Modell" when the user wants to SEE
    or OPEN the building and the project may hold several models. The old answer
    to that was a prose bullet list of file names the user had to read and retype;
    this card renders each model as a tile that opens the BIM viewer on click,
    client-side, with no second turn.

    It carries only WHICH view to offer — never a list of file names. The renderer
    reads the project's actual models from the live model list (the same source
    the viewer resolves against), so the model here cannot name a file that does
    not exist: there is nothing to invent. An empty project renders nothing and
    the written answer stands on its own, which is the fail-open the prose gave.
    """

    type: Literal["ifc_model_picker"]
    title: str = Field(min_length=1, description="Short heading, e.g. 'Welches Modell möchten Sie öffnen?'")
    note: str | None = Field(default=None, description="Optional one-line clarification under the tiles")


# ── A composed surface (A2UI) ────────────────────────────────────────────────
# ADR-0065. A card is drawn through A2UI; this is the one card whose payload
# IS an A2UI component list, so an answer can put cards in relation.

#: The layout components a surface may use, named and shaped as in A2UI's
#: basic catalog (v0.9): Row and Column take `children`, Tabs takes `tabs`.
SURFACE_LAYOUTS: frozenset[str] = frozenset({"Row", "Column", "Tabs"})
#: Retired types whose replacement is an envelope field or nothing, not Markdown a leaf could hold.
_ENVELOPE_FIELD_TYPES: frozenset[str] = frozenset(
    {"summary", "verdict_header", "key_takeaways", "callout", "follow_ups"}
)


@functools.cache
def _basic_catalog() -> Any:
    """A2UI's v0.9 basic catalog, whose `Row`, `Column` and `Tabs` the layouts are.

    `a2ui-core` finds a component's child ids from its catalog's schema (a
    `ChildList` or `ComponentId` reference), so the structure is read through
    the catalog the layouts take their names and shapes from. Built once: it
    is the catalog's document, not per-turn state.
    """
    from a2ui.core.basic_catalog import BasicCatalog

    return BasicCatalog("0.9")


#: Card types that may not be a leaf. System cards are pushed by tools, and an
#: interactive card's decision is
#: keyed by its position in the message (`card-decision.ts`), which a card
#: inside a surface does not have. A surface inside a surface is a Column.
#: Derived from the catalog's sets, so a new member of any of them is excluded
#: here without a second edit; the frontend's copy is held to this one by
#: `tests/aiq_agent/cards/test_surface_excluded_parity.py`.
SURFACE_EXCLUDED_LEAVES: frozenset[str] = SYSTEM_CARD_TYPES | INTERACTIVE_CARD_TYPES | frozenset({"surface"})

#: The one leaf that is not a card: a run of the answer's own Markdown, named
#: and shaped as A2UI's basic catalog names its `Text`. It is what lets a tab
#: hold what the answer writes in prose (a table, a list, a ```mermaid fence),
#: because the Markdown-first doctrine keeps exactly that content OUT of cards.
SURFACE_TEXT = "Text"
SURFACE_TEXT_MAX = 4000

#: A placement marker of the prose (`[[card:N]]`, `[[callout]]`). The prose
#: resolves them; a `Text` leaf is drawn as Markdown and would show them as typed.
_PROSE_MARKER = re.compile(r"\[\[\s*[a-z_]+(?:\s*:\s*\d+)?\s*\]\]", re.IGNORECASE)

SURFACE_MAX_LEAVES = 6
SURFACE_MAX_CHILDREN = 4
SURFACE_MAX_TABS = 6


#: The values the frontend's `RowApi` takes for a Row's or Column's `justify`
#: and `align` (`frontends/ui/src/features/a2ui/catalog.tsx`). Any other value
#: fails the renderer's preflight and the whole surface degrades, so it is
#: refused here, where the repair can still fix it.
SURFACE_JUSTIFY = frozenset({"start", "center", "end", "spaceBetween", "spaceAround", "spaceEvenly", "stretch"})
SURFACE_ALIGN = frozenset({"start", "center", "end", "stretch"})


def _check_row(component: dict[str, Any]) -> dict[str, Any]:
    """A `Row` or `Column`: static child ids, 2 to the cap, `justify`/`align` the renderer takes."""
    name, component_id = component["component"], component["id"]
    for prop, allowed in (("justify", SURFACE_JUSTIFY), ("align", SURFACE_ALIGN)):
        if prop in component and (not isinstance(component[prop], str) or component[prop] not in allowed):
            raise ValueError(f"'{component_id}' ({name}): `{prop}` is one of {sorted(allowed)}.")
    children = component.get("children")
    if not isinstance(children, list) or not all(isinstance(child, str) for child in children):
        raise ValueError(f"'{component_id}' ({name}): `children` must be a list of component ids.")
    if not 2 <= len(children) <= SURFACE_MAX_CHILDREN:
        raise ValueError(
            f"'{component_id}' ({name}): {len(children)} children; a {name} holds 2 to "
            f"{SURFACE_MAX_CHILDREN}. One child is that child, and more do not fit a column."
        )
    extra = set(component) - {"id", "component", "children", "justify", "align"}
    if extra:
        raise ValueError(f"'{component_id}' ({name}) does not take {sorted(extra)}.")
    return component


def _checked_tab(component_id: str, tab: Any) -> dict[str, str]:
    """One `{title, child}` entry, its title flattened BEFORE the emptiness check.

    Flattened first because `[]()` or a code span of spaces is markup around
    nothing: checked raw it passes, and the reader gets a blank tab.
    """
    if not isinstance(tab, dict) or set(tab) != {"title", "child"}:
        raise ValueError(f"'{component_id}' (Tabs): every tab is exactly {{title, child}}.")
    title = flatten_card_markup(tab["title"]).strip() if isinstance(tab["title"], str) else ""
    if not title or not isinstance(tab["child"], str):
        raise ValueError(f"'{component_id}' (Tabs): a tab's `title` is text and its `child` an id.")
    return {"title": title, "child": tab["child"]}


def _check_tabs(component: dict[str, Any]) -> dict[str, Any]:
    """A `Tabs`: 2 to the cap, each `{title, child}`, returned with plain-text titles.

    A tab title is on-screen text and gets the plain-text guarantee every other
    card string gets (`flatten_card_markup`), which the model-level flattening
    does not reach inside the component dicts.
    """
    component_id = component["id"]
    tabs = component.get("tabs")
    if not isinstance(tabs, list) or not 2 <= len(tabs) <= SURFACE_MAX_TABS:
        raise ValueError(f"'{component_id}' (Tabs): `tabs` must list 2 to {SURFACE_MAX_TABS} tabs.")
    checked = [_checked_tab(component_id, tab) for tab in tabs]
    extra = set(component) - {"id", "component", "tabs"}
    if extra:
        raise ValueError(f"'{component_id}' (Tabs) does not take {sorted(extra)}.")
    return {**component, "tabs": checked}


def _check_layout(component: dict[str, Any]) -> dict[str, Any]:
    """A layout component's own props, returned normalised (see :func:`_check_tabs`)."""
    if component["component"] == "Tabs":
        return _check_tabs(component)
    return _check_row(component)


def _checked_text(component: dict[str, Any]) -> dict[str, Any]:
    """A `Text` leaf: exactly `{id, component, text}`, the text non-empty Markdown."""
    component_id = component["id"]
    extra = set(component) - {"id", "component", "text"}
    if extra:
        raise ValueError(f"'{component_id}' (Text) takes only `text`, not {sorted(extra)}.")
    text = component.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError(f"'{component_id}' (Text): `text` is the Markdown to show, and it is empty.")
    if len(text) > SURFACE_TEXT_MAX:
        raise ValueError(
            f"'{component_id}' (Text): {len(text)} characters; a tab holds at most {SURFACE_TEXT_MAX}. "
            "Say the rest in the answer."
        )
    if marker := _PROSE_MARKER.search(text):
        raise ValueError(
            f"'{component_id}' (Text): `{marker.group(0)}` is a marker of the answer's prose and is shown "
            "literally here. Reference cards from the prose, not inside a tab."
        )
    return {"id": component_id, "component": SURFACE_TEXT, "text": text.strip()}


def _checked_leaf(component: dict[str, Any]) -> dict[str, Any]:
    """A card component, validated as the card it is; returned normalised, id and name kept."""
    name, component_id = component["component"], component["id"]
    if name == SURFACE_TEXT:
        return _checked_text(component)
    if name in RETIRED_CARD_TYPES:
        # An envelope field (summary, verdict, …) is no leaf's content: the refusal alone says where it goes.
        leaf = "" if name in _ENVELOPE_FIELD_TYPES else " Use a `Text` leaf holding that Markdown."
        raise ValueError(f"'{component_id}': {retired_refusal(name)}{leaf}")
    if name in SURFACE_EXCLUDED_LEAVES:
        raise ValueError(f"'{component_id}': a '{name}' cannot sit inside a surface.")
    props = {key: value for key, value in component.items() if key not in ("id", "component")}
    try:
        card = grid_card_adapter.validate_python({**props, "type": name})
    except Exception as exc:  # the adapter's own clauses, prefixed with where they happened
        from aiq_agent.common.tool_errors import render_error_detail

        raise ValueError(f"'{component_id}' ({name}): {render_error_detail(exc)}") from exc
    normalised = card.model_dump(exclude_none=True)
    normalised.pop("type")
    return {"id": component_id, "component": name, **normalised}


def _structural_models(components: list[dict[str, Any]]) -> dict[str, Any]:
    """The components as `a2ui-core` models, keyed by id, for its integrity and topology checks.

    A leaf is passed without its props: it holds no child, and `a2ui-core`
    falls back to guessing references from the props of a component its
    catalog does not know, which would read a card field whose value happens
    to equal a component id as a reference.
    """
    from a2ui.core.state.component_model import ComponentModel

    catalog = _basic_catalog()
    models: dict[str, Any] = {}
    for component in components:
        name = component["component"]
        props = {key: value for key, value in component.items() if key not in ("id", "component")}
        models[component["id"]] = ComponentModel(
            component["id"], name, catalog, props if name in SURFACE_LAYOUTS else {}
        )
    return models


def _references(component: dict[str, Any]) -> list[str]:
    """The ids a layout component holds, children and tab children alike; [] for a leaf."""
    if component["component"] not in SURFACE_LAYOUTS:
        return []
    return list(component.get("children") or []) + [tab["child"] for tab in component.get("tabs") or []]


def _check_single_parent(components: list[dict[str, Any]]) -> None:
    """Every component is referenced at most once: the surface is a tree.

    `a2ui-core` accepts a child listed twice, or held by two parents (two tabs
    on one leaf, a leaf in a tab and in a Row), and the renderer would then
    draw the one component in two places.
    """
    seen: set[str] = set()
    for child in (child for component in components for child in _references(component)):
        if child in seen:
            raise ValueError(
                f"'{child}' is referenced more than once; a surface is a tree, and each component "
                "sits in one place. Give the second place a component of its own."
            )
        seen.add(child)


class SurfaceCard(CardModel):
    """Several cards composed into one A2UI surface: variants as tabs, related cards side by side.

    `components` is an A2UI v0.9 component list (a2ui.org): flat, each entry
    `{"id", "component", …props}`, children referenced by id, exactly one
    `"id": "root"`. Containers are `Row` and `Column` (`children`: ids) and
    `Tabs` (`tabs`: `[{title, child}]`); `Text` (`text`: Markdown) holds what
    the answer would write in prose, a table or a list; every other component
    is a card, named by its type, with that card's own fields as props. Validated twice: the
    structure by `a2ui-core` (unique ids, a root, no dangling reference, no
    cycle, no orphan), each card by its own model.
    """

    type: Literal["surface"]
    title: str | None = Field(
        default=None,
        description="Optional heading over the whole surface, e.g. 'Zwei Varianten des zweiten Fluchtwegs'",
    )
    components: list[dict[str, Any]] = Field(
        min_length=3,
        description=(
            "The A2UI component list: one container with id 'root' (Row, Column or Tabs) and what "
            'it holds: cards, each `{"id", "component": <card type>, …that card\'s fields}`, and '
            '`{"id", "component": "Text", "text": <Markdown>}` for a table, a list or prose.'
        ),
    )

    @model_validator(mode="after")
    def _is_a_valid_a2ui_surface(self) -> SurfaceCard:
        from a2ui.core.state.validation_helpers import analyze_topology
        from a2ui.core.state.validation_helpers import validate_component_integrity

        for index, component in enumerate(self.components):
            if not isinstance(component.get("id"), str) or not isinstance(component.get("component"), str):
                raise ValueError(f"components.{index} needs a string `id` and a string `component`.")
        # Before the root lookup: a second component called "root" would
        # otherwise stand in for the first, and the refusal would name the
        # wrong fault.
        ids = [component["id"] for component in self.components]
        if duplicates := sorted({component_id for component_id in ids if ids.count(component_id) > 1}):
            raise ValueError(
                f"Duplicate component ID: {', '.join(duplicates)}. Ids are unique within a surface; "
                "give each component its own."
            )
        by_id = {component["id"]: component for component in self.components}
        root = by_id.get("root")
        if root is None or root["component"] not in SURFACE_LAYOUTS:
            raise ValueError(
                "The component with id 'root' must be a Row, Column or Tabs; a surface of one card "
                "is that card, emitted on its own."
            )

        checked: list[dict[str, Any]] = []
        for component in self.components:
            if component["component"] in SURFACE_LAYOUTS:
                checked.append(_check_layout(component))
            else:
                checked.append(_checked_leaf(component))
        # The structure is judged first: a cycle is a cycle, whatever the count.
        structural = _structural_models(checked)
        try:
            validate_component_integrity(structural)
            analyze_topology(structural)
        except Exception as exc:
            raise ValueError(f"The component list is not a valid A2UI surface: {exc}") from exc
        _check_single_parent(checked)
        leaves = sum(1 for component in checked if component["component"] not in SURFACE_LAYOUTS)
        if not 2 <= leaves <= SURFACE_MAX_LEAVES:
            raise ValueError(
                f"A surface holds 2 to {SURFACE_MAX_LEAVES} cards or Text blocks; this one holds {leaves}."
            )
        self.components = checked
        return self


GridCard = (
    ProjectProfilePatchCard
    | CalculationCard
    | FormulaCard
    | BuildingSectionCard
    | StairDiagramCard
    | DimensionDiagramCard
    | SetbackPlanCard
    | EgressDiagramCard
    | DaylightIncidenceCard
    | GuardrailCheckCard
    | FireAccessPlanCard
    | MemoryProposalCard
    | OperationProposalCard
    | DocumentGridCard
    | DocumentDraftCard
    | TaskCreatedCard
    | FileOperationProposalCard
    | CanvasActivityCard
    | LookCard
    | RevisionCompareCard
    | IfcViewerCard
    | IfcComplianceCard
    | IfcScheduleCard
    | IfcElementCard
    | IfcDiffCard
    | IfcModelPickerCard
    | SurfaceCard
)

# Discriminated-union adapter — the canonical validator for a raw card dict.
grid_card_adapter = TypeAdapter(Annotated[GridCard, Field(discriminator="type")])

__all__ = [
    "CalculationCard",
    "CalculationLimit",
    "CalculationOperand",
    "CalculationStep",
    "CanvasActivityCard",
    "CardModel",
    "FormulaCard",
    "FormulaInput",
    "DocumentDraftCard",
    "DocumentGridCard",
    "GridCard",
    "IfcHighlight",
    "IfcViewerCard",
    "IfcComplianceCard",
    "IfcScheduleCard",
    "IfcElementCard",
    "IfcDiffCard",
    "IfcModelPickerCard",
    "LookCard",
    "LookDocument",
    "LookItem",
    "RevisionCompareCard",
    "RevisionCompareChange",
    "MemoryProposalCard",
    "OperationProposalCard",
    "SurfacedDocument",
    "ProjectProfilePatchCard",
    "ProjectProfilePatchOperation",
    "ProjectProfilePatchPreviewItem",
    "TaskCreatedCard",
    "flatten_card_markup",
    "formula_inputs",
    "stated_result_fields",
    "grid_card_adapter",
    "validate_cards",
]


def validate_cards(raw: list[dict]) -> list[dict]:
    """Validate a list of model-produced card dicts and return the validated dicts.

    Per-card: one malformed card is logged and skipped instead of discarding
    the whole batch (LLM output regularly contains one bad item among good
    ones, and cards are a progressive enhancement — never fail the answer).

    System cards (``SYSTEM_CARD_TYPES``) are dropped here too: this is the
    post-hoc / batch generation path fed by *model* output, and a system card
    must only ever come from its owning tool on a sanctioned path (e.g.
    ``document_grid`` from ``surface_documents``, ``memory_proposal`` from
    ``remember``). The model is never told these types exist, so any occurrence
    here is a fabrication — enforce the same invariant ``emit_card`` and the
    DSML salvage already enforce, closing the last emission path.

    A retired type (``RETIRED_CARD_TYPES``) is no union member at all and
    fails validation like any unknown name: the report's own Markdown carries
    its content. Chat-only types (``CHAT_ONLY_CARD_TYPES``) likewise: a surface's
    ``Text`` ``[N]`` are recited on the chat pipeline only.
    """
    import logging

    logger = logging.getLogger(__name__)
    validated: list[dict] = []
    withheld = SYSTEM_CARD_TYPES | CHAT_ONLY_CARD_TYPES
    for item in raw:
        if isinstance(item, dict) and item.get("type") in withheld:
            logger.warning("Dropping model-fabricated system/chat-only card (type=%s)", item.get("type"))
            continue
        try:
            validated.append(grid_card_adapter.validate_python(item).model_dump(exclude_none=True))
        except Exception as exc:
            logger.warning(
                "Dropping invalid card (type=%s): %s",
                item.get("type") if isinstance(item, dict) else type(item).__name__,
                exc,
            )
    return validated
