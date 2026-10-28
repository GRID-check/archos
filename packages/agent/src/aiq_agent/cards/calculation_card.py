"""The calculation card: a derivation the reader can follow step by step, and the procedure behind it."""

from typing import Literal

from pydantic import Field
from pydantic import model_validator

from aiq_agent.cards.card_model import CardModel
from aiq_agent.cards.schematic_cards import NormReference
from aiq_agent.cards.schematic_cards import Provenance

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
