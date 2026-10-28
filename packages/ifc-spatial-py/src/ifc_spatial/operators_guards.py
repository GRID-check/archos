"""Refusals the operators share: a wrong kind, a missing relation, no geometry. Each one answers in the same words."""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any
from typing import NoReturn

from ifc_spatial.operators_constants import _RELATIONS

from .envelope import Answer
from .envelope import MissingFact
from .envelope import undecidable
from .model import ElementGeometry
from .model import SpatialModel
from .model import WrongKindError

# ── guards ──────────────────────────────────────────────────────────────────


def _require(model: SpatialModel, global_id: str, method: str) -> Any:
    return model.by_id(global_id, method)


def _wrong_kind(
    subject: Any,
    method: str,
    operator: str,
    expected: str,
    suggestion: str,
) -> NoReturn:
    """The operator was aimed at the wrong kind of element — raise, never answer.

    ## Why this is an exception and not an undecidable

    It used to return ``undecidable``, and its own docstring said „nothing is in
    fact missing from the file" while the answer it produced said the opposite.
    ``decidable: false`` has exactly one meaning in this package — the question
    is well-formed and THIS EXPORT cannot answer it — and it travels with a
    ``missing.remedy`` addressed to an architect: set the property, switch the
    export option on, re-export with geometry. The skill then instructs the agent
    that ``what`` and ``remedy`` „gehören beide in die Antwort".

    Asking ``floorArea`` of a wall is not a fact about the file. Nobody can
    re-export their way out of it, and sending them to their CAD because WE
    pointed an operator at the wrong element inverts the whole contract. The
    review's sweep measured the cost: 316 of 1 850 ``measure``/``relations``
    calls came back as an export defect that did not exist.

    An unknown GlobalId already raises (:class:`UnknownElementError`) for the
    same reason — the caller could not look, so there is nothing to report about
    the building. A wrong kind is the same class of mistake one step further in:
    the caller looked at something real and asked it the wrong question. So it
    raises :class:`WrongKindError`, ``tools.call`` turns that into a
    ``ToolError`` („a problem with the arguments"), and ``suggestion`` names the
    operator that WOULD answer it so the refusal still points somewhere.

    Callers that legitimately PROBE — ``tools.element`` builds its relation menu
    by asking every relation whether it applies — catch it and move on. That is
    the one place the distinction is a question rather than a mistake.
    """
    raise WrongKindError(
        subject.GlobalId,
        subject.is_a(),
        method,
        operator,
        expected,
        suggestion,
    )


def _no_geometry(model: SpatialModel, subject: Any, method: str, from_: list[str] | None = None) -> Answer[Any]:
    """The element has no usable body in this file — a finding, never an exception.

    Two different findings, and the corpus showed that saying the wrong one sends
    the architect to fix the wrong thing:

    - **no representation** — normal for whole classes of entity, and a real
      export defect for a wall;
    - **the kernel could not build it** — the element carries a full ``Body`` and
      OCCT rejects it. 94 of the 100 rooms in the corpus's ArchiCAD 18 export are
      in exactly this state. Re-exporting "with geometry" changes nothing there;
      the room boundary itself is what the kernel will not accept.

    ## Why ``what`` is a bare noun phrase and never starts with „keine"

    The renderer builds the sentence „dieser Export liefert {what} **nicht**".
    ``what`` used to read „keine geometrische Repräsentation für IfcWall
    „Aussenwand“ in dieser Datei", which produced

        NICHT ENTSCHEIDBAR: dieser Export liefert keine geometrische
        Repräsentation für IfcWall „Aussenwand“ in dieser Datei nicht.

    — a double negation that asserts the file DOES carry the body, in the one
    line whose entire job is to say it does not. So ``what`` names the thing that
    is absent, positively and without an article, and lets the template supply
    the only „nicht" in the sentence:

        NICHT ENTSCHEIDBAR: dieser Export liefert Körpergeometrie für IfcWall
        „Aussenwand“ nicht.
    """
    name = model.label(subject) or subject.GlobalId
    reason = model.geometry_failure(subject.GlobalId) or ""

    if reason.startswith("shape-failed") or reason == "empty-mesh":
        detail = reason.split(": ", 1)[1] if ": " in reason else reason
        what = f"auswertbare Körpergeometrie für {subject.is_a()} „{name}“ (der Geometriekern lehnt die Form ab)"
        remedy = (
            "Dieses Bauteil trägt eine Body-Repräsentation, aber der Geometriekern kann daraus keinen "
            f"Körper bauen ({detail[:160]}). Ein erneuter Export „mit Geometrie“ ändert daran nichts — die "
            "Form selbst wird abgelehnt. Typische Ursachen: eine sich selbst schneidende Umrandung, ein "
            "Profil mit Nullfläche, eine nicht geschlossene Schale. Im CAD das Bauteil bzw. den Raum neu "
            "aufziehen und den Export prüfen."
        )
    else:
        what = f"Körpergeometrie für {subject.is_a()} „{name}“"
        remedy = (
            "Dieses Bauteil trägt in dieser Datei keinen Körper (kein auswertbares IfcProductDefinitionShape). "
            "Manche Einträge haben von Haus aus keinen — IfcDoorLiningProperties, IfcWindowLiningProperties, "
            "die Hülle einer Vorhangfassade, deren Paneele die Geometrie tragen. Sonst: das Modell mit "
            "Körpergeometrie neu exportieren (Body-Repräsentation, kein reiner Bounding-Box-Export)."
        )

    return undecidable(
        from_=from_ or [subject.GlobalId],
        method=method,
        provenance="computed",
        missing=MissingFact(what=what, remedy=remedy, elements=[subject.GlobalId]),
    )


def _relation_missing(model: SpatialModel, kinds: Sequence[str]) -> MissingFact:
    ifc = " + ".join(dict.fromkeys(_RELATIONS[k][0] for k in kinds))
    remedy = "; ".join(dict.fromkeys(_RELATIONS[k][1] for k in kinds))
    return MissingFact(what=ifc, remedy=remedy)


def _has(model: SpatialModel, ifc_type: str) -> bool:
    try:
        return len(model.file.by_type(ifc_type)) > 0
    except RuntimeError:
        return False


def _geometry_or_answer(
    model: SpatialModel, subject: Any, method: str, from_: list[str] | None = None
) -> tuple[ElementGeometry | None, Answer[Any] | None]:
    geo = model.geometry(subject.GlobalId)
    if geo is None:
        return None, _no_geometry(model, subject, method, from_)
    return geo, None
