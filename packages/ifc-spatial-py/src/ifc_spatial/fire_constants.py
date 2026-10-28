"""Terms, slack and caveats the fire operators share, each named once."""

from __future__ import annotations

# ── vocabulary ──────────────────────────────────────────────────────────────
#
# Normalised the way `briefing.normalise` normalises room names — lower case,
# umlauts transliterated — because a storey called `Dachgeschoß` and one called
# `Dachgeschoss` are the same storey and an exporter picks the spelling.

#: STOREY names that are evidence AGAINST occupancy. Each entry is a substring
#: match on the normalised name.
#:
#: **This is a tie-breaker, not a veto.** It is consulted only after the room
#: lexicon has been asked and returned nothing — see :func:`_judge_one_storey`.
#: Tested ahead of the rooms it struck out the 107 m² Galerie in the
#: „Dachgeschoss" of ``AC20-FZK-Haus.ifc`` and reported a Fluchtniveau of
#: **1.000 m** instead of **3.700 m**.
#:
#: Never used to remove a room the lexicon has PLACED. Run that way these terms
#: struck „Dachzimmer" and „Attikazimmer" out of the habitable list and dropped
#: the storey holding them, reporting a Fluchtniveau of 0.000 m for a house
#: whose upper floor sits at 3.500 m. What a room is used for is the room
#: lexicon's question, and :func:`~ifc_spatial.briefing.classify_rooms` answers
#: it; these terms only corroborate a storey name over the room names it could
#: not answer for.
#:
#: ``dach`` is in the list and ``dachgeschoss`` is not a separate entry: the
#: substring covers both, and a *Dachgeschoss* that is genuinely occupied is
#: exactly the case a reviewer is expected to correct — which is why every
#: storey travels back with its reason instead of only the surviving one.
NOT_OCCUPIED_TERMS: tuple[str, ...] = (
    "dach",
    "attika",
    "technik",
    "haustechnik",
    "maschinenraum",
    "aufzugsmaschin",
    "lueftungszentrale",
    "roof",
    "plant",
    "attic",
    "mechanical",
)

#: Names that mark an ``IfcAnnotation`` (or an ``IfcSite``'s own name) as the
#: site boundary. German first, because the files this reads are Austrian.
BOUNDARY_TERMS: tuple[str, ...] = (
    "grundstuecksgrenze",
    "grundstueckgrenze",
    "grundgrenze",
    "bauplatzgrenze",
    "baugrundstueck",
    "parzelle",
    "vermessung",
    "site boundary",
    "property line",
    "plot boundary",
    "lot line",
)

#: How far a separating element may overrun the gap between two space bodies,
#: in metres, and still count as lying between them.
#:
#: Not a guess: in ``Ifc4_SampleHouse.ifc`` the living room and the bedroom are
#: separated by a 95 mm partition whose body fills the gap exactly, while the
#: door in it (``…VyWax``) stands **63 mm proud on each side** — its lining and
#: leaf are wider than the wall core. A slack below 0.063 m drops the door out
#: of the answer, and the door is the weak point of a fire wall: it is the one
#: element that must not go missing.
SEPARATION_SLACK = 0.15

#: Below this, two space footprints that overlap in plan are overlapping by
#: tessellation noise rather than by being modelled twice, in m².
MIN_OVERLAP_AREA = 0.01

#: Where the "does this file declare any FireRating at all, and how many of them
#: are blank" scan is memoised. On the model, for the reason
#: :mod:`~ifc_spatial.circulation` gives for its own memo — see
#: :func:`_fire_rating_scan`.
_FIRE_RATING_MEMO = "_ifc_spatial_fire_declares_rating"

_NO_BUILDING_CLASS = (
    "Diese Zahl ist eine HÖHE in Metern, keine Einstufung. Welche Gebäudeklasse sich daraus ergibt, "
    "bestimmt die OIB-Richtlinie 2 zusammen mit dem jeweiligen Landesrecht und hängt außerdem von der "
    "Anzahl der Geschoße, der Brutto-Grundfläche und der Nutzung ab — nichts davon ist eine geometrische "
    "Eigenschaft dieser Datei. Diese Bibliothek nennt deshalb keine Gebäudeklasse."
)

_GROUND_CAVEAT = (
    "Maßgeblich ist nach OIB das TIEFER gelegene anschließende Gelände. Ein Gelände ist in einem "
    "Architekturexport fast nie modelliert; welcher Bezug hier tatsächlich verwendet wurde, steht in "
    "„groundReference“ und muss gegen den Einreichplan geprüft werden. Fällt das Gelände zur Traufe hin ab, "
    "ist das wirkliche Fluchtniveau GRÖSSER als die hier gemeldete Zahl."
)
