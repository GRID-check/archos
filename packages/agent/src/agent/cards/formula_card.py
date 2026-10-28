"""The formula card: a named rule whose inputs the reader may change.

And the checks that keep a figure out of a name.
"""

import re
import unicodedata
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import Field
from pydantic import field_validator
from pydantic import model_validator

from agent.cards.card_model import CardModel
from agent.cards.schematic_cards import NormReference
from agent.cards.schematic_cards import Provenance

FormulaStairType = Literal["main", "dwelling", "secondary"]


FormulaComponent = Literal["external_wall", "roof_or_ceiling_to_outside_air", "floor_over_outside_air"]


FormulaRouteStart = Literal["room", "dwelling_entrance"]


FormulaMeasure = Literal["new_build", "renovation", "major_renovation"]


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
