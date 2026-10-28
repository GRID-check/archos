"""The frozen records a storey judgement and a separating element are read into."""

from __future__ import annotations

from dataclasses import dataclass
from dataclasses import field
from typing import Any

# ════════════════════════════════════════════════════════════════════════════
# escape_level — the highest-value scalar in OIB 2, and the one most easily
# turned into a classification it must not become
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class StoreyJudgement:
    """One storey, its elevation, and whether it was counted — with the reason.

    Both halves travel. A caller that renders only the counted storeys has
    published a number nobody can correct: the whole point of reporting the
    Technikgeschoss that was dropped is that a reviewer who knows it is a
    Wohnung can say so, and the arithmetic is one subtraction away.
    """

    global_id: str
    name: str | None
    elevation: float | None
    counted: bool
    #: German, and specific: which signal decided it.
    why: str
    #: The spaces found on this storey, with the lexicon's own classification.
    spaces: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "elevation": self.elevation,
            "counted": self.counted,
            "why": self.why,
            "rooms": list(self.spaces),
        }


# ════════════════════════════════════════════════════════════════════════════
# separating_elements — the wall, the slab, and the door that is the weak point
# ════════════════════════════════════════════════════════════════════════════


@dataclass(frozen=True)
class SeparatingElement:
    """One element between two spaces, with what the file declares about it."""

    global_id: str
    name: str | None
    ifc_type: str
    #: ``separating`` — it lies between the two rooms; ``shared`` — it bounds
    #: both but does not separate them (a facade running past both).
    role: str
    #: German, naming the test that decided ``role``.
    why: str
    #: Exactly as declared, or ``None``. ``None`` is a finding about the export,
    #: and a property carrying an empty string is one of those — see
    #: :func:`_fire_rating`.
    fire_rating: str | None
    #: ``Pset_*Common.Compartmentation`` — the architect saying this element is
    #: meant to compartmentalise. Rarely present, decisive when it is.
    compartmentation: bool | None

    def to_dict(self) -> dict[str, Any]:
        return {
            "globalId": self.global_id,
            "name": self.name,
            "ifcType": self.ifc_type,
            "role": self.role,
            "why": self.why,
            "fireRating": self.fire_rating,
            "fireRatingDeklariert": self.fire_rating is not None,
            "compartmentation": self.compartmentation,
        }
