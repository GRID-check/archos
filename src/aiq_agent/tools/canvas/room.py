"""The room: who has the document open, and Piloti's own hand in it (``room``, ``point``, ``highlight``).

``room`` is what lets Piloti resolve „das hier“ and „diese Stelle“ the way a
colleague at the same table would: it reads who is looking at which page and
which part of it, which mark each has selected and which box each is drawing.
``point`` and ``highlight`` are the gesture back: a cursor and a labelled box
everyone in the document sees, gone when the turn ends (``presence.py``). The
frame is the canvas's everywhere: shares of the page as shown, origin top left.

The BFF side is the realtime layer's presence snapshot and publish, behind the
same internal route as the Anmerkungen. A gesture renews Piloti's presence, which
lapses about 25 s after the last one; ``leave`` takes it down at once. The room
lists the people in the document, never this conversation's own Piloti.
"""

from __future__ import annotations

import math
from typing import Any

from .calls import Refused

#: Mirrors the canvas: a pointer's label is a few words, a highlight's one line.
MAX_POINT_LABEL = 80
MAX_HIGHLIGHT_LABEL = 120
_EDGE_SLACK = 0.02

_KIND_LABELS = {"person": "Person", "piloti": "Piloti"}


def _share(value: object, name: str) -> float:
    try:
        number = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError) as exc:
        raise Refused(f"Fehler: `{name}` ist ein Anteil der Seite zwischen 0 und 1, keine Pixel.") from exc
    if not math.isfinite(number) or not 0 <= number <= 1:
        raise Refused(f"Fehler: `{name}` ist ein Anteil der Seite zwischen 0 und 1, keine Pixel.")
    return number


def _page(page: object) -> int:
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        raise Refused("Fehler: `page` zählt ab 1.")
    return page


def _label(label: str, limit: int, *, required: bool) -> str | None:
    text = " ".join(str(label or "").split())
    if required and not text:
        raise Refused("Fehler: `highlight` braucht `label`: ein paar Worte, was der Rahmen zeigt.")
    if len(text) > limit:
        raise Refused(f"Fehler: `label` hat höchstens {limit} Zeichen.")
    return text or None


def point_payload(page: object, x: object, y: object, label: str) -> dict[str, Any]:
    """The ``point`` body, checked here so the model can fix it before the BFF refuses."""
    payload: dict[str, Any] = {"op": "point", "page": _page(page), "x": _share(x, "x"), "y": _share(y, "y")}
    if (text := _label(label, MAX_POINT_LABEL, required=False)) is not None:
        payload["label"] = text
    return payload


def highlight_payload(page: object, x: object, y: object, w: object, h: object, label: str) -> dict[str, Any]:
    """The ``highlight`` body: a box on the page, clamped onto it when it pokes past an edge by a hair."""
    left, top, width, height = _share(x, "x"), _share(y, "y"), _share(w, "w"), _share(h, "h")
    if width <= 0 or height <= 0:
        raise Refused("Fehler: `highlight` braucht `w` und `h` größer als 0.")
    if left + width > 1 + _EDGE_SLACK or top + height > 1 + _EDGE_SLACK:
        raise Refused("Fehler: Der Rahmen reicht über die Seite hinaus (x+w und y+h höchstens 1).")
    return {
        "op": "highlight",
        "page": _page(page),
        "x": round(left, 4),
        "y": round(top, 4),
        "w": round(min(width, 1 - left), 4),
        "h": round(min(height, 1 - top), 4),
        "label": _label(label, MAX_HIGHLIGHT_LABEL, required=True),
    }


def _num(value: object) -> str:
    try:
        return f"{float(value):.2f}"  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return "?"


def _box_words(box: object) -> str | None:
    """A drawn box as „S. 2, x 0.30–0.40, y 0.50–0.60“, or None when there is none."""
    if not isinstance(box, dict):
        return None
    x, y, w, h = (box.get(key) for key in ("x", "y", "w", "h"))
    try:
        right, bottom = float(x) + float(w), float(y) + float(h)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return f"S. {box.get('page')}"
    return f"S. {box.get('page')}, x {_num(x)}–{_num(right)}, y {_num(y)}–{_num(bottom)}"


def _viewport_words(viewport: object) -> str | None:
    """Where a reader is looking: the page, and how far down it the view sits (``{page, y}``)."""
    if not isinstance(viewport, dict) or not isinstance(viewport.get("page"), int):
        return None
    try:
        down = round(float(viewport.get("y")) * 100)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return f"S. {viewport['page']}"
    return f"S. {viewport['page']}, etwa {down} % nach unten"


def _peer_line(peer: dict[str, Any]) -> str:
    who = " ".join(str(peer.get("name") or "Jemand").split())
    kind = _KIND_LABELS.get(str(peer.get("kind")), "Person")
    parts = [f"- {who} ({kind})"]
    if (viewport := _viewport_words(peer.get("viewport"))) is not None:
        parts.append(f"sieht {viewport}")
    elif isinstance(peer.get("page"), int):
        parts.append(f"auf S. {peer['page']}")
    if isinstance(peer.get("selectedMarkNumber"), int):
        parts.append(f"hat Anmerkung Nr. {peer['selectedMarkNumber']} ausgewählt")
    if (draft := _box_words(peer.get("draft"))) is not None:
        parts.append(f"zieht gerade einen Rahmen auf: {draft}")
    return parts[0] + (": " + "; ".join(parts[1:]) if len(parts) > 1 else "")


def render_room(body: dict[str, Any]) -> str:
    """Who is in the document and where, as German lines a model can resolve „hier“ against."""
    peers = [peer for peer in body.get("peers") or [] if isinstance(peer, dict)]
    marks = body.get("marks") if isinstance(body.get("marks"), dict) else {}
    named = f"„{body['documentName']}“" if body.get("documentName") else "dem Dokument"
    lines = [f"Gerade in {named}: {len(peers)} (Orte als Anteile der Seite, Ursprung oben links)."]
    lines.extend(_peer_line(peer) for peer in peers)
    if not peers:
        lines.append("Niemand hat es gerade geöffnet.")
    lines.append(
        f"Anmerkungen: {marks.get('open', 0)} offen, {marks.get('proposed', 0)} Vorschläge von Piloti, die noch "
        "niemand übernommen hat. Einzelheiten mit `marks`."
    )
    return "\n".join(lines)


def room_observation(body: dict[str, Any]) -> dict[str, Any]:
    """What the room held, as counts: never a name."""
    peers = [peer for peer in body.get("peers") or [] if isinstance(peer, dict)]
    return {
        "document": body.get("documentId"),
        "peers": len(peers),
        "drafts": sum(1 for peer in peers if isinstance(peer.get("draft"), dict)),
        "selected": sum(1 for peer in peers if isinstance(peer.get("selectedMarkNumber"), int)),
    }
