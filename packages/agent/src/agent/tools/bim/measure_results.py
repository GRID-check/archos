"""Turns an answer into measurement sources that carry GlobalIds and tolerances, for the citation channel."""

from collections.abc import Sequence
from typing import Any

from agent.tools.bim.measure_bodies import _is_batch
from agent.tools.bim.measure_bodies import _is_profile
from agent.tools.bim.measure_bodies import _model_identity
from agent.tools.bim.measure_format import _tolerance_text
from agent.tools.bim.measure_render import _provenance_line
from agent.tools.bim.measure_render import _value_with_unit
from agent.tools.bim.measure_vocab import NON_MEASURING_OPERATIONS
from agent.tools.bim.measurement_evidence import EVIDENCE_PROVENANCES
from agent.tools.bim.measurement_sources import MeasuredElement
from agent.tools.bim.measurement_sources import MeasurementSource

# ── evidence: what the result says about itself ──────────────────────────────


def _is_evidence(answer: Any) -> bool:
    """Whether one envelope answer is EVIDENCE: decidable, declared or computed, and a QUANTITY.

    A provenance alone is not enough — `relations` answers with a decidable
    list of GlobalIds `provenance: declared`, and nothing in it was measured.
    A unit or a tolerance is what makes a value a quantity; not both, since
    `envelope` reports m² without a tolerance and `storey_heights` a list
    with a unit.
    """
    if not isinstance(answer, dict) or answer.get("error"):
        return False
    if not answer.get("decidable"):
        return False
    if answer.get("provenance") not in EVIDENCE_PROVENANCES:
        return False
    return answer.get("unit") is not None or answer.get("tolerance") is not None


def _measured_count(payload: Any) -> int:
    """How many QUANTITIES in one payload carry a ``declared``/``computed`` provenance.

    The number the result states about itself (:mod:`.measurement_evidence`),
    read off the envelope's own fields and never off the German around them.
    """
    if _is_profile(payload):
        return sum(_is_evidence(answer) for answer in (payload.get("measures") or {}).values())
    if _is_batch(payload):
        return sum(_is_evidence((entry or {}).get("answer")) for entry in (payload.get("results") or []))
    if isinstance(payload, dict) and "decidable" in payload:
        return int(_is_evidence(payload))
    return 0


def _measured_elements(answer: dict[str, Any], names: dict[str, MeasuredElement]) -> tuple[MeasuredElement, ...]:
    """The elements a value was derived from, in the operator's order; an id the payload cannot name still travels."""
    ids = answer.get("from")
    if not isinstance(ids, list):
        return ()
    return tuple(
        names.get(str(global_id), MeasuredElement(global_id=str(global_id)))
        for global_id in ids
        if isinstance(global_id, (str, int))
    )


def _measurement_source(
    answer: dict[str, Any],
    *,
    headline: str,
    names: dict[str, MeasuredElement],
    model: str | None,
) -> MeasurementSource:
    """One evidence-bearing envelope answer as a Herleitung source."""
    tolerance = answer.get("tolerance")
    unit = answer.get("unit")
    tolerance_text = f"±{_tolerance_text(tolerance)}{' ' + unit if unit else ''}" if tolerance is not None else None
    return MeasurementSource(
        headline=headline,
        statement=_provenance_line(answer),
        provenance=str(answer.get("provenance") or ""),
        value_text=_value_with_unit(answer),
        tolerance_text=tolerance_text,
        method=str(answer.get("method") or ""),
        elements=_measured_elements(answer, names),
        model=model,
        caveat=str(answer["caveat"]) if answer.get("caveat") else None,
    )


def _element_index(entries: Sequence[dict[str, Any]]) -> dict[str, MeasuredElement]:
    """GlobalId → the element as the payload names it."""
    index: dict[str, MeasuredElement] = {}
    for entry in entries:
        global_id = (entry or {}).get("globalId")
        if not global_id:
            continue
        index[str(global_id)] = MeasuredElement(
            global_id=str(global_id),
            name=(entry.get("name") or None),
            ifc_type=(entry.get("ifcType") or None),
        )
    return index


def _profile_sources(payload: dict[str, Any], model: str | None) -> list[MeasurementSource]:
    element = payload.get("element") or {}
    names = _element_index([element])
    label = element.get("name") or element.get("globalId") or ""
    return [
        _measurement_source(
            answer, headline=f"{measure} · {label}" if label else str(measure), names=names, model=model
        )
        for measure, answer in (payload.get("measures") or {}).items()
        if _is_evidence(answer)
    ]


def _batch_sources(payload: dict[str, Any], measure: str, model: str | None) -> list[MeasurementSource]:
    out: list[MeasurementSource] = []
    for entry in payload.get("results") or []:
        answer = (entry or {}).get("answer")
        if not _is_evidence(answer):
            continue
        label = entry.get("name") or entry.get("globalId") or ""
        headline = f"{measure} · {label}" if label else measure
        out.append(_measurement_source(answer, headline=headline, names=_element_index([entry]), model=model))
    return out


def _measurement_sources(
    operation: str,
    payload: Any,
    *,
    source: dict[str, Any] | None,
    detail: str,
) -> list[MeasurementSource]:
    """The measurements in one payload, as sources for the Herleitung.

    Walks exactly the shapes :func:`_measured_count` walks and admits exactly
    what :func:`_is_evidence` admits, so the cards under an answer and the
    „Messwerte in diesem Ergebnis" trailer are the same statement twice.
    Headlines are the register's own vocabulary, qualified by the element the
    payload names; a single `Answer` names none, so its headline is what the
    CALL asked for.
    """
    if operation in NON_MEASURING_OPERATIONS or not isinstance(payload, dict):
        return []
    model = _model_identity(source)
    if _is_profile(payload):
        return _profile_sources(payload, model)
    if _is_batch(payload):
        return _batch_sources(payload, str(payload.get("measure") or detail or operation), model)
    if "decidable" in payload and _is_evidence(payload):
        return [_measurement_source(payload, headline=str(detail or operation), names={}, model=model)]
    return []
