"""Whether a tool result is a MEASUREMENT of the building: the signal a measured answer carries.

An IFC measurement has no passage to cite. It carries something else instead,
and arguably something stronger: a ``provenance`` (declared/computed/inferred),
an absolute ``tolerance``, a ``method`` string a reviewer can read back, and the
GlobalIds the value was derived from (``ifc_spatial.envelope.Answer``). It is
REPRODUCIBLE, which no quotation is. The tools node records that a turn
measured (``answer_measurement_grounded``) and the answer check reads the
measured values beside the passages (``common/claim_judge.py``, ADR-0139).

What used to follow here, a German net for statements about the law that kept a
measurement from grounding a legal verdict, went with the confidence rules it
served: the check is told that a measurement never backs a statement about what
a regulation requires, and reads the answer itself.

## The invariant this must not break

The measurement layer MEASURES; the Bestimmung JUDGES. No operator returns a
verdict, a threshold, „erfüllt" or a Gebäudeklasse. Nothing here may create a
route by which a measurement's evidence attaches itself to a judgment.
"""

from __future__ import annotations

from agent.common.tool_calls import tool_basename
from agent.tools.bim.measurement_evidence import result_carries_measurement

#: Tools whose results constitute a MEASUREMENT of the building.
#:
#: Only ``ifc_measure``. ``ifc_query`` is deliberately absent: it reads the
#: extracted index and its renderer carries no provenance contract, so a caller
#: cannot tell a published quantity from an inferred one by reading the result —
#: which is the whole basis on which measurement grounding is granted here.
#:
#: AUDITED — do not re-derive this from the tool's name. „Carries no provenance
#: contract" is right, but the tempting shorter reason („it returns no numbers")
#: is FALSE and would not survive contact with the renderer. ``ifc_query``
#: returns quantities routinely, several of them with an explicit unit:
#:
#:     op='schedule'  „EG: 86.4 m² (2 Räume)"     — unit from `schedule.units`
#:     op='takeoff'   „IfcWall / Beton: 412,8 m² (96 Bauteile, 3 ohne Wert)"
#:     op='element'   „Qto_WallBaseQuantities: NetSideArea=24,6, Width=0,30"
#:
#: What none of them carries is the thing this gate reads. Grep
#: ``knowledge/bim_query.py`` and ``knowledge/ifc_spatial_client.py`` — the
#: whole ``ifc_query`` path — and ``tolerance``, ``provenance`` and ``declared``
#: do not occur once; that vocabulary exists only on the ``ifc_measure`` side
#: (``bim/measure_register.py``). So a caller cannot tell 86.4 m² read off a
#: published Qto_* from 86.4 m² the exporter guessed, and there is no
#: ``measurement_evidence`` trailer to state the count either.
#:
#: The exclusion is consequently BELT AND BRACES rather than the only guard:
#: adding ``ifc_query`` here would change no behaviour at all, because
#: :func:`tool_result_is_measurement` also requires the trailer that only
#: ``measure_register._render`` emits. It is kept as a statement of intent.
#:
#: The cost is real but is not payable here: an answer built purely on a
#: Raumbuch or a Massenermittlung is a genuinely measured answer that gets no
#: measurement grounding and stays at "low" when uncited. Fixing that means
#: giving ``ifc_query`` a provenance contract of its own — a widening of the
#: grounding surface that deserves its own review, not a name added to a
#: frozenset.
#:
#: Matched on the tool's BASE name (``tool_calls.tool_basename``): NAT delivers
#: a function-group or MCP tool as ``group__ifc_measure``, and an exact compare
#: against the bare name silently switched measurement grounding off for every
#: deployment that uses grouping — reinstating the "low" floor this whole gate
#: exists to lift, by nothing but topology.
MEASUREMENT_TOOL_NAMES: frozenset[str] = frozenset({"ifc_measure"})

#: Every error path in ``ifc_measure`` — rejected arguments, an unreachable
#: model service, a missing engine, an oversized file — returns a string opening
#: with this token. None of them carries the evidence trailer either (they never
#: reach the renderer); this is the second, cheaper check.
_TOOL_ERROR_PREFIX = "error:"


def tool_result_is_measurement(tool_name: str, content: str) -> bool:
    """Whether one tool result is a MEASUREMENT of the building.

    True only for a result from a tool in :data:`MEASUREMENT_TOOL_NAMES` whose
    own evidence trailer reports at least one ``declared``/``computed`` value
    (:mod:`agent.tools.bim.measurement_evidence`). A refusal, an outage, an
    ``inferred`` guess, and a ``decidable: false`` finding about the export are
    all False — none of them is a number anyone can stand behind, and treating
    them as evidence is the failure this whole gate exists to prevent.

    It reads the renderer's stated COUNT rather than searching the result for
    „gemessen"/„deklariert", because the renderer uses those verbs in prose that
    explains why nothing could be measured — „gemessen: raumhoehe an 0 von 3
    Bauteilen", „…dessen Höhe gemessen werden könnte". Under the old vocabulary
    match every one of those refusals granted grounding.
    """
    if tool_basename(tool_name) not in MEASUREMENT_TOOL_NAMES:
        return False
    text = (content or "").strip()
    if not text or text[: len(_TOOL_ERROR_PREFIX)].lower() == _TOOL_ERROR_PREFIX:
        return False
    return result_carries_measurement(text)
