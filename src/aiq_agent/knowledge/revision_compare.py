"""What changed between two Fassungen of one page, read off the pictures (CONTEXT.md, „Fassung").

``document_revisions`` tells what changed from two *descriptions*; this module
is the other half, for the compare view: both page images go to a vision model
in one call and come back as boxes on the NEWER page plus a few German
sentences. Everything here is pure (prompt, parsing, cache identity) so the
route that posts the images stays thin and the parsing is tested without a model.

**A box is a claim, so a malformed one is dropped, never repaired into
something plausible.** The model is asked for ``x, y, w, h`` as fractions of
the page (``0, 0`` is the top left). Each of the four must lie in ``0..1``
(:data:`EDGE_TOLERANCE` of overshoot is rounding, clamped); a box that sits
outside the page is a hallucination or a percentage written as a count, and
clamping ``w = 40`` to the page edge would draw a large box the model never
meant. What survives is at most :data:`MAX_REGIONS` boxes, and a box that
runs over the page edge is trimmed to it.

**"Nothing changed" is an answer.** When no box and no sentence survives, the
summary is :data:`NO_CHANGE_TEXT`, so the person is told there is no visible
change instead of being shown an empty panel that could mean "the call
failed". A reply that is not the requested JSON at all is ``None`` (a failure),
which the caller never caches.
"""

from __future__ import annotations

import hashlib
import math
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from aiq_agent.common.image_redaction import redact_inline_images

#: Bumped whenever the prompt or the reply handling changes. Part of the cache
#: identity, so a new prompt is never answered from the old one's results.
PROMPT_VERSION = 1

#: Boxes kept per page. The compare view overlays them; past a dozen it is noise.
MAX_REGIONS = 12
#: Sentences kept in the summary.
MAX_SUMMARY_LINES = 8
#: A label is a few words on a box, a summary line one sentence.
MAX_LABEL_CHARS = 80
MAX_SUMMARY_LINE_CHARS = 240
#: A side below this fraction of the page is a dot, not a change worth boxing.
MIN_SIDE = 0.004
#: Overshoot of ``0..1`` read as rounding and clamped; more is a malformed box.
EDGE_TOLERANCE = 0.02

#: The answer when the model sees no difference. Also what the prompt asks for.
NO_CHANGE_TEXT = "keine sichtbare Änderung"

#: How long a result lives in the shared cache: as long as the VLM cache's.
CACHE_TTL_SECONDS = 30 * 86400

#: A completion has room for twelve boxes and their sentences.
MAX_COMPLETION_TOKENS = 1500

COMPARE_PROMPT = "\n".join(
    (
        "Du vergleichst zwei Fassungen derselben Seite einer Bauzeichnung. "
        "Das ERSTE Bild ist die ÄLTERE Fassung, das ZWEITE Bild die NEUERE Fassung.",
        "",
        "Liste die konkreten sichtbaren Änderungen von der älteren zur neueren Fassung: verschobene, "
        "hinzugekommene oder entfernte Wände, Öffnungen (Türen, Fenster), Maße und Koten, Beschriftungen "
        "und Raumnamen, im Schriftfeld Index, Datum und Plannummer.",
        "",
        "Regeln:",
        "- Nenne nur, was du in den beiden Bildern tatsächlich siehst. Erfinde nichts. "
        "Im Zweifel lässt du die Änderung weg.",
        "- Unterschiede der Abbildung sind keine Änderungen: Scanqualität, Rauschen, Helligkeit, "
        "ein anderer Bildausschnitt, ein leicht verschobenes Blatt.",
        f"- Höchstens {MAX_REGIONS} Änderungen. Zusammengehörige Änderungen fasst du zu einer zusammen.",
        "- Jede Änderung hat einen Rahmen auf der NEUEREN Seite (ein entferntes Element: dort, wo es früher "
        "war). x und y sind die obere linke Ecke, w und h Breite und Höhe, jeweils als Bruchteil der "
        "Seitenbreite bzw. Seitenhöhe zwischen 0 und 1; 0,0 ist oben links.",
        '- label: höchstens sechs Wörter, Deutsch, z. B. "Wand nach Norden verschoben".',
        "- summary: ein kurzer deutscher Satz je Änderung, in Worten, mit Maßen und Werten, wenn du sie lesen kannst.",
        f'- Siehst du keine Änderung: "changes" ist [] und "summary" ist ["{NO_CHANGE_TEXT}"].',
        "",
        "Antworte ausschließlich mit einem JSON-Objekt, ohne Erklärung davor oder danach:",
        '{"changes": [{"label": "...", "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0}], "summary": ["..."]}',
    )
)


@dataclass(frozen=True)
class CompareRegion:
    """One change, boxed on the newer page in page-relative ``0..1`` coordinates."""

    page: int
    x: float
    y: float
    w: float
    h: float
    label: str

    def as_dict(self) -> dict[str, Any]:
        return {"page": self.page, "x": self.x, "y": self.y, "w": self.w, "h": self.h, "label": self.label}


@dataclass(frozen=True)
class CompareResult:
    """What a comparison of one page pair says: the boxes and the words."""

    regions: tuple[CompareRegion, ...]
    summary: tuple[str, ...]

    def as_dict(self) -> dict[str, Any]:
        return {"regions": [region.as_dict() for region in self.regions], "summary": list(self.summary)}

    @classmethod
    def from_dict(cls, data: Any) -> CompareResult | None:
        """A result read back from the cache, or ``None`` when the entry is not one (a stale shape)."""
        if not isinstance(data, Mapping):
            return None
        raw_regions, raw_summary = data.get("regions"), data.get("summary")
        if not isinstance(raw_regions, list) or not isinstance(raw_summary, list):
            return None
        try:
            regions = tuple(CompareRegion(**item) for item in raw_regions)
        except TypeError:
            return None
        if not all(isinstance(line, str) for line in raw_summary):
            return None
        return cls(regions, tuple(raw_summary))


def build_messages(older_data_url: str, newer_data_url: str) -> list[dict[str, Any]]:
    """The one user message: the instruction, then the older page, then the newer page."""
    return [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": COMPARE_PROMPT},
                {"type": "text", "text": "Ältere Fassung:"},
                {"type": "image_url", "image_url": {"url": older_data_url}},
                {"type": "text", "text": "Neuere Fassung:"},
                {"type": "image_url", "image_url": {"url": newer_data_url}},
            ],
        }
    ]


def traceable(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """``messages`` with every inline image replaced by its size and hash, for the Langfuse input.

    A page image is megabytes of base64: a trace holds the prompt and what was
    sent (how many images, how large), never the pixels of a customer's drawing.
    """
    return redact_inline_images(messages)


def cache_key(model: str, collection: str, page: int, older_jpeg: bytes, newer_jpeg: bytes) -> str:
    """The cache identity of one comparison: what was compared, on which page, by which model and prompt.

    The two pictures are part of it as content hashes, not file names: a name
    re-uploaded with other bytes is another comparison, and the same two
    pictures asked again cost no model call. The collection keeps one
    organization's results out of another's reach.
    """
    older, newer = (hashlib.sha256(jpeg).hexdigest() for jpeg in (older_jpeg, newer_jpeg))
    return f"revision-compare:v{PROMPT_VERSION}:{model}:{collection}:p{page}:{older}:{newer}"


def _number(value: Any) -> float | None:
    """A finite float, or ``None``. A ``bool`` is not a coordinate."""
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    return float(value) if math.isfinite(value) else None


def _in_page(value: float) -> bool:
    return -EDGE_TOLERANCE <= value <= 1 + EDGE_TOLERANCE


def _box(item: Mapping[str, Any]) -> tuple[float, float, float, float] | None:
    """``(x, y, w, h)`` of a change, or ``None`` when it is malformed or off the page.

    The four may also arrive as ``"box": [x, y, w, h]``.
    """
    raw = item.get("box")
    if isinstance(raw, list) and len(raw) == 4:
        values = [_number(value) for value in raw]
    else:
        values = [_number(item.get(key)) for key in ("x", "y", "w", "h")]
    if any(value is None for value in values) or not all(_in_page(value) for value in values if value is not None):
        return None
    x, y, w, h = (min(max(value, 0.0), 1.0) for value in values if value is not None)
    w, h = min(w, 1.0 - x), min(h, 1.0 - y)
    if w < MIN_SIDE or h < MIN_SIDE:
        return None
    return round(x, 4), round(y, 4), round(w, 4), round(h, 4)


def _text(value: Any, limit: int) -> str:
    return " ".join(value.split())[:limit].rstrip() if isinstance(value, str) else ""


def _regions(raw: Any, page: int) -> tuple[CompareRegion, ...]:
    if not isinstance(raw, list):
        return ()
    regions: list[CompareRegion] = []
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        label, box = _text(item.get("label"), MAX_LABEL_CHARS), _box(item)
        if not label or box is None:
            continue
        regions.append(CompareRegion(page, *box, label))
        if len(regions) == MAX_REGIONS:
            break
    return tuple(regions)


def _summary(raw: Any) -> tuple[str, ...]:
    if not isinstance(raw, list):
        return ()
    lines = (_text(line, MAX_SUMMARY_LINE_CHARS) for line in raw)
    return tuple(line for line in lines if line)[:MAX_SUMMARY_LINES]


def _says_no_change(lines: tuple[str, ...]) -> bool:
    return all(NO_CHANGE_TEXT.casefold() in line.casefold() for line in lines)


def parse_compare(data: Mapping[str, Any], page: int) -> CompareResult:
    """The boxes and sentences of a model's reply (already a JSON object), defensively.

    A change without a label, or whose box is malformed or off the page, is
    dropped; at most :data:`MAX_REGIONS` boxes are kept. A model that claims no
    change but still boxed one is believed on the boxes: the summary then
    names them instead of denying them.
    """
    regions = _regions(data.get("changes"), page)
    summary = _summary(data.get("summary"))
    if regions and (not summary or _says_no_change(summary)):
        summary = tuple(region.label for region in regions)
    if not summary and not regions:
        summary = (NO_CHANGE_TEXT,)
    return CompareResult(regions, summary)
