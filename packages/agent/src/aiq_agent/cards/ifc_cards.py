"""The IFC cards: the viewer, schedules, compliance, an element, a diff and the model picker."""

from typing import Literal

from pydantic import AliasChoices
from pydantic import ConfigDict
from pydantic import Field
from pydantic import model_validator

from aiq_agent.cards.card_model import CardModel


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
