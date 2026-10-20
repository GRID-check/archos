"""OIB applicability: which OIB-Richtlinien apply to a project, from its facts.

Small, hand-written orientation logic (successor of the data-driven applicability
DSL, which was reduced away together with the parity codegen). Two consumers keep
in step by construction, not by generated parity fixtures:

* this module — the German prompt block, and
* ``frontends/ui/src/lib/oib/applicable-standards.ts`` — the Overview UI.

Both encode the same hand-written verdicts (OIB 1/2/3 near-universal, 4/5 always
with a stronger reason for public/noise-sensitive uses, the fire sub-Richtlinien
2.1/2.2/2.3 conditional, 6 conditional for unconditioned storage/agriculture).

What it reads. The intake wizard stores a building's facts under a suffix per
Bauwerk (``fluchtniveau_m@bw1``), so every read takes the flat key and each
``<key>@<bwN>`` copy. A use zone's copy (``<key>@bw1@wohnen``) is that zone's
detail and is skipped.

* ``hauptnutzung``: stated flat; else the one D0 use the Bauwerke share
  (``nutzungen``) that is also a verdict token. Two or more, or none: unknown.
* ``gebaeudeklasse``: ``4`` or ``GK4``; the highest class across the Bauwerke.
* ``fluchtniveau``: the band stated flat; else the band of the highest
  ``fluchtniveau_m`` (metres) across the Bauwerke.
* ``geschosse_unterirdisch``: the highest count across the Bauwerke.

The prompt view writes these as ``- key=value`` lines.
``facts_from_project_context`` reads ``4`` as an int, and a comma-joined
``nutzungen`` as one string; both are handled here.

The result is orientation, not legal advice.
"""

from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass
from typing import Any
from typing import Literal

Facts = dict[str, Any]
VerdictName = Literal["required", "likely", "check"]


@dataclass(frozen=True)
class OibVerdict:
    """One OIB-Richtlinie's project-specific applicability verdict."""

    code: str  # "OIB 1", "OIB 2.1", ...
    verdict: VerdictName
    reason_de: str
    reason_en: str


# Use tokens (intake vocabulary, see intake-definition.ts) grouped by verdict rule.
_BETRIEBSBAU_USES = frozenset({"produzierend", "lager"})
_BETRIEBSBAU_CHECK = frozenset({"landwirtschaft", "sonstiges"})
_PUBLIC_USES = frozenset({"beherbergung", "gesundheit", "versammlung", "buero"})
_NOISE_SENSITIVE = frozenset({"wohnen", "beherbergung", "gesundheit", "buero", "versammlung"})
_OIB6_EXEMPT = frozenset({"lager", "landwirtschaft"})
# Every hauptnutzung token the verdicts compare: the union of the groups above.
# The D0 catalogue shares only some of them (see the TS twin for the list).
_MAIN_USE_TOKENS = _BETRIEBSBAU_USES | _BETRIEBSBAU_CHECK | _PUBLIC_USES | _NOISE_SENSITIVE | _OIB6_EXEMPT
_GK_TOKEN = re.compile(r"(?:GK)?([1-5])")

_VERDICT_LABELS_DE: dict[str, str] = {
    "required": "verbindlich",
    "likely": "voraussichtlich anwendbar",
    "check": "zu prüfen",
}

# The four boolean intake triggers -> German one-liner shown when the fact is true.
_TRIGGER_HINTS: tuple[tuple[str, str], ...] = (
    (
        "kleingartengebiet",
        "Kleingartengebiet: Wiener Kleingartengesetz gilt als lex specialis — vor BauO/OIB prüfen.",
    ),
    (
        "denkmalschutz",
        "Denkmalschutz: DMSG-Bewilligung (Bundesdenkmalamt) zusätzlich zur Baubewilligung prüfen.",
    ),
    (
        "betriebsanlage",
        "Betriebsanlage: GewO §§ 74 ff Genehmigungsregime zusätzlich prüfen.",
    ),
    (
        "stellplatz_relevant",
        "Stellplatzverpflichtung: Wiener Garagengesetz (bzw. Landesrecht) prüfen.",
    ),
)


def _as_number(value: Any) -> float | None:
    """A finite number, else None. Booleans are never numbers; strings are read as the prompt view writes them."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    return number if math.isfinite(number) else None


def _fact_str(facts: Facts, key: str) -> str | None:
    """A non-empty string fact, else None (mirrors the UI's ``factString``)."""
    value = facts.get(key)
    return value if isinstance(value, str) and value != "" else None


def _scoped_values(facts: Facts, base: str) -> list[Any]:
    """Every value stored under ``base``: the flat key and each ``<base>@<bwN>`` copy.

    A use zone's copy (``<base>@bw1@wohnen``) is that zone's detail, not the building's, and is skipped.
    """
    values: list[Any] = []
    for key, value in facts.items():
        key_base, _, rest = key.partition("@")
        if key_base == base and "@" not in rest:
            values.append(value)
    return values


def _max_number(facts: Facts, base: str) -> float | None:
    """The largest numeric value stored under ``base`` (flat or scoped), else None."""
    numbers = [n for n in map(_as_number, _scoped_values(facts, base)) if n is not None]
    return max(numbers) if numbers else None


def escape_level_band(facts: Facts) -> str | None:
    """The Fluchtniveau band the rules read: the stated ``fluchtniveau``, else the highest ``fluchtniveau_m``.

    Each band takes its upper bound inclusively: exactly 7 m is ``<=7m``, 11 m is ``7-11m``, 22 m is ``11-22m``.
    """
    stated = _fact_str(facts, "fluchtniveau")
    if stated is not None:
        return stated
    metres = _max_number(facts, "fluchtniveau_m")
    if metres is None:
        return None
    if metres <= 7:
        return "<=7m"
    if metres <= 11:
        return "7-11m"
    if metres <= 22:
        return "11-22m"
    return ">22m"


def _use_tokens(facts: Facts) -> set[str]:
    """Every D0 token the Bauwerke name. A list is taken as is; the prompt view's comma-joined text is split."""
    tokens: set[str] = set()
    for value in _scoped_values(facts, "nutzungen"):
        if isinstance(value, list):
            items = value
        elif isinstance(value, str):
            items = value.split(",")
        else:
            continue
        tokens.update(str(item).strip() for item in items)
    tokens.discard("")
    return tokens


def _main_use(facts: Facts) -> str | None:
    """The stated ``hauptnutzung``, else the ``nutzungen`` when they name exactly one use and it is a verdict token."""
    stated = _fact_str(facts, "hauptnutzung")
    if stated is not None:
        return stated
    # Every use must name a verdict token: a use outside the vocabulary (``produktion``)
    # is unknown, and an unknown use may be the Betriebsbau.
    uses = _use_tokens(facts)
    if len(uses) == 1 and uses <= _MAIN_USE_TOKENS:
        return next(iter(uses))
    return None


def _building_class_of(value: Any) -> int | None:
    """``4`` or ``GK4`` (either case) as its class number, else None."""
    if isinstance(value, str):
        match = _GK_TOKEN.fullmatch(value.strip().upper())
        return int(match.group(1)) if match else None
    number = _as_number(value)
    if number is None or number not in (1, 2, 3, 4, 5):
        return None
    return int(number)


def _building_class(facts: Facts) -> str | None:
    """The Gebäudeklasse across the Bauwerke: the highest class named, as ``GK<n>``."""
    classes = [c for c in map(_building_class_of, _scoped_values(facts, "gebaeudeklasse")) if c is not None]
    return f"GK{max(classes)}" if classes else None


def _is_true(value: Any) -> bool:
    """True for a real boolean True or the string 'true' (prompt-text view)."""
    return value is True or (isinstance(value, str) and value.strip().lower() == "true")


def _generic_six() -> list[OibVerdict]:
    """The six near-universal Richtlinien, all ``required`` — used when the brief is empty."""
    return [
        OibVerdict(
            "OIB 1",
            "required",
            "Standsicherheit gilt für jedes Bauwerk.",
            "Structural safety applies to every building.",
        ),
        OibVerdict(
            "OIB 2",
            "required",
            "Allgemeine Brandschutzanforderungen gelten für jedes Gebäude.",
            "General fire-safety requirements apply to every building.",
        ),
        OibVerdict(
            "OIB 3",
            "required",
            "Hygiene, Tageslicht, Lüftung und Umweltschutz gelten für jedes Gebäude.",
            "Hygiene, daylight, ventilation and environmental requirements apply to every building.",
        ),
        OibVerdict(
            "OIB 4",
            "required",
            "Nutzungssicherheit und Barrierefreiheit gelten.",
            "Safety in use and barrier-free access apply.",
        ),
        OibVerdict(
            "OIB 5",
            "required",
            "Schallschutz gilt üblicherweise für bewohnte Gebäude.",
            "Sound protection typically applies to occupied buildings.",
        ),
        OibVerdict(
            "OIB 6",
            "required",
            "Anforderungen an Energieeinsparung und Wärmeschutz gelten.",
            "Energy and thermal-performance requirements apply.",
        ),
    ]


def resolve_oib_applicability(facts: Facts) -> list[OibVerdict]:
    """Per-Richtlinie verdicts for a project's facts (hand-written port of the old UI logic).

    Clearly-inapplicable Richtlinien are omitted. With no facts we can only speak
    generically, so the six near-universal Richtlinien are returned as ``required``.
    """
    if not facts:
        return _generic_six()

    main_use = _main_use(facts)
    building_class = _building_class(facts)
    escape_level = escape_level_band(facts)
    storeys_below_ground = _max_number(facts, "geschosse_unterirdisch")

    verdicts: list[OibVerdict] = []

    # OIB 1 — always.
    verdicts.append(
        OibVerdict(
            "OIB 1",
            "required",
            "Standsicherheit gilt für jedes Bauwerk.",
            "Structural safety applies to every building.",
        )
    )

    # OIB 2 — always.
    verdicts.append(
        OibVerdict(
            "OIB 2",
            "required",
            "Allgemeine Brandschutzanforderungen gelten für jedes Gebäude.",
            "General fire-safety requirements apply to every building.",
        )
    )

    # OIB 2.1 — Betriebsbauten (industrial & commercial).
    if main_use in _BETRIEBSBAU_USES:
        verdicts.append(
            OibVerdict(
                "OIB 2.1",
                "required",
                "Produktions-/Lagernutzung ist ein Betriebsbau.",
                "Manufacturing/storage use is a Betriebsbau.",
            )
        )
    elif main_use in _BETRIEBSBAU_CHECK or main_use is None:
        verdicts.append(
            OibVerdict(
                "OIB 2.1",
                "check",
                "Anwendbar, wenn das Gebäude als Betriebsbau gilt.",
                "Applies if the building qualifies as a Betriebsbau.",
            )
        )
    # else: omit (clearly not a Betriebsbau).

    # OIB 2.2 — garages & covered parking.
    if storeys_below_ground is not None and storeys_below_ground >= 1:
        verdicts.append(
            OibVerdict(
                "OIB 2.2",
                "check",
                "Anwendbar, wenn das Projekt eine Garage oder überdachte Stellplätze umfasst.",
                "Applies if the project includes a garage or covered parking.",
            )
        )
    # else: omit.

    # OIB 2.3 — high-rise (Hochhaus).
    if escape_level == ">22m":
        verdicts.append(
            OibVerdict(
                "OIB 2.3",
                "required",
                "Oberstes Fluchtniveau über 22 m — das Gebäude ist ein Hochhaus.",
                "Top escape level over 22 m — the building is a Hochhaus.",
            )
        )
    elif building_class == "GK5" and escape_level is None:
        verdicts.append(
            OibVerdict(
                "OIB 2.3",
                "check",
                "GK5-Gebäude — prüfen, ob das oberste Fluchtniveau 22 m übersteigt.",
                "GK5 building — confirm whether the top escape level exceeds 22 m.",
            )
        )
    # else: omit.

    # OIB 3 — always.
    verdicts.append(
        OibVerdict(
            "OIB 3",
            "required",
            "Hygiene, Tageslicht, Lüftung und Umweltschutz gelten für jedes Gebäude.",
            "Hygiene, daylight, ventilation and environmental requirements apply to every building.",
        )
    )

    # OIB 4 — always; stronger for publicly used buildings.
    if main_use in _PUBLIC_USES:
        verdicts.append(
            OibVerdict(
                "OIB 4",
                "required",
                "Nutzungssicherheit und Barrierefreiheit — Barrierefreiheitspflichten sind bei "
                "öffentlich genutzten Gebäuden umfangreich.",
                "Safety in use and barrier-free access — accessibility duties are extensive for "
                "publicly used buildings.",
            )
        )
    else:
        verdicts.append(
            OibVerdict(
                "OIB 4",
                "required",
                "Nutzungssicherheit und Barrierefreiheit gelten.",
                "Safety in use and barrier-free access apply.",
            )
        )

    # OIB 5 — sound protection; required for occupied/noise-sensitive uses, else likely.
    if main_use in _NOISE_SENSITIVE:
        verdicts.append(
            OibVerdict(
                "OIB 5",
                "required",
                "Schallschutz ist bei bewohnten/lärmempfindlichen Nutzungen erforderlich.",
                "Sound protection is required for occupied/noise-sensitive uses.",
            )
        )
    else:
        verdicts.append(
            OibVerdict("OIB 5", "likely", "Schallschutz gilt üblicherweise.", "Sound protection typically applies.")
        )

    # OIB 6 — energy & thermal performance; storage/agricultural may be partly exempt.
    if main_use in _OIB6_EXEMPT:
        verdicts.append(
            OibVerdict(
                "OIB 6",
                "check",
                "Unkonditionierte Lager-/landwirtschaftliche Gebäude können teilweise von OIB 6 ausgenommen sein.",
                "Unconditioned storage/agricultural buildings may be partly exempt from OIB 6.",
            )
        )
    else:
        verdicts.append(
            OibVerdict(
                "OIB 6",
                "required",
                "Anforderungen an Energieeinsparung und Wärmeschutz gelten.",
                "Energy and thermal-performance requirements apply.",
            )
        )

    return verdicts


def trigger_hints(facts: Facts) -> list[str]:
    """German one-liners for the four boolean intake triggers that are set true."""
    return [hint for key, hint in _TRIGGER_HINTS if _is_true(facts.get(key))]


def facts_from_project_context(text: str) -> Facts:
    """Parse ``- key=value`` lines from the ``confirmed:`` section of PROJECT_CONTEXT.

    Numbers are coerced to int/float; ``true``/``false`` to bool (the four intake
    triggers arrive as strings in the prompt-text view); quoted strings are unquoted.
    """
    facts: Facts = {}
    in_confirmed = False
    for raw_line in text.splitlines():
        line = raw_line.rstrip()
        if line.strip() == "confirmed:":
            in_confirmed = True
            continue
        if in_confirmed and line and not line.startswith((" ", "-")) and line.rstrip().endswith(":"):
            break
        if not in_confirmed:
            continue
        stripped = line.strip()
        if not stripped.startswith("-") or "=" not in stripped:
            continue
        key, _, value = stripped[1:].partition("=")
        key = key.strip()
        value = value.strip()
        if value.startswith('"'):
            try:
                value = json.loads(value)
            except ValueError:
                pass
        elif value.lower() in ("true", "false"):
            value = value.lower() == "true"
        else:
            num = _as_number(value)
            if num is not None:
                value = int(num) if num == int(num) else num
        facts[key] = value
    return facts


def render_project_block(project_context: str) -> str | None:
    """German prompt section for the parsed project facts, or None when empty.

    Called lazily by ``norm_registry.render_block_for_prompt``. Lists each OIB
    verdict (``code — verdict — reason_de``) followed by any trigger hints.
    """
    facts = facts_from_project_context(project_context)
    if not facts:
        return None
    lines = ["### Für dieses Projekt voraussichtlich einschlägig", ""]
    for verdict in resolve_oib_applicability(facts):
        label = _VERDICT_LABELS_DE.get(verdict.verdict, verdict.verdict)
        lines.append(f"- {verdict.code} — {label} — {verdict.reason_de}")
    hints = trigger_hints(facts)
    if hints:
        lines.append("")
        lines.extend(f"- {hint}" for hint in hints)
    return "\n".join(lines)
