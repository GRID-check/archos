"""Marks: read them, propose or set them, change or delete them, answer in a thread.

The tools are ``marks``, ``mark``, ``update``, ``delete`` and ``reply``.

An Anmerkung is a mark a person sets at a place on a page of a document (a
point or a region), with what is to be done about it (a Hinweis, a Rückfrage or
a Mangel) and a thread of replies under it.

## A proposal is not a finding

Piloti's marks are born ``proposed`` (the CHECKs of migration 0138 hold it on
the BFF side): they appear on the document as Piloti's suggestions, and count
only once a person takes one over („übernehmen“) or dismisses it
(„verwerfen“). VISION.md principle 4, suggest then confirm. So the ``mark``
result leads with what has NOT happened, the way ``propose_file_change`` does:
a model told „gesetzt“ writes an answer claiming the defects are recorded.

## What the person asked for is done in their name

„There should not be any difference between what Piloti does and what a human
does": when the person ASKS for a mark, a change or a deletion, Piloti does it
under that person's own rights, through the same service a person's PATCH
runs. A mark set on request is born open with the asker as ``accepted_by``
(``mark`` with ``open``); a change (``update``) posts the model's ``note`` as
Piloti's reply in the mark's thread, in the same request; a deletion is
allowed for exactly the marks the asker set. Findings Piloti makes on its own
initiative stay proposals; the tool descriptions say which is which.

A reply lands at once, marked as Piloti's: it changes no state. All of these
are read by everyone who opens the document, so all pass the restricted-folder
rule first (``policy.py``).
"""

from __future__ import annotations

import re
from datetime import date
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import BeforeValidator
from pydantic import ValidationError

from .calls import ANNOTATION_GONE
from .calls import Refused
from .cards import excerpt

#: Mirrored from ``lib/annotations/types.ts``; the BFF validates against its own.
MAX_BODY = 2000
MAX_BASIS = 300
MAX_PROPOSALS_PER_CALL = 20

#: A region that pokes past the page edge by less than this is clamped onto it:
#: an estimate read off a rendered page lands a hair outside often enough.
_EDGE_SLACK = 0.02


def _normalized(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


Kind = Annotated[Literal["hint", "question", "defect"], BeforeValidator(_normalized)]
Shape = Annotated[Literal["point", "region"], BeforeValidator(_normalized)]


class AnnotationProposal(BaseModel):
    """One finding: where on which page, what kind, what is wrong, what it rests on."""

    # No per-field descriptions: the tool description explains each once, and
    # this schema rides on every model call of every chat turn.

    page: int
    shape: Shape = "region"
    x: float
    y: float
    w: float | None = None
    h: float | None = None
    kind: Kind
    body: str
    basis: str | None = None


#: Every successful `propose` ends on this. It leads with the negative because that is what a model gets wrong.
_PROPOSED = (
    "Das sind VORSCHLÄGE: Es wurde NOCH NICHTS bestätigt. Sie stehen im Dokument als Vorschläge von Piloti, "
    "bis eine Person jeden einzeln übernimmt oder verwirft. Sage nicht, die Befunde seien eingetragen oder "
    "festgehalten; sag, dass du sie vorgeschlagen hast und wo sie sie im Dokument prüfen kann."
)

# ---------------------------------------------------------------------------
# list
# ---------------------------------------------------------------------------

_KIND_LABELS = {"hint": "Hinweis", "question": "Rückfrage", "defect": "Mangel"}
_STATUS_LABELS = {
    "proposed": "Vorschlag, noch nicht übernommen",
    "open": "offen",
    "resolved": "erledigt",
    "dismissed": "verworfen",
}
_LIVE = ("proposed", "open")

#: A list carries up to 500 marks of up to 2000 characters each: bounded here, and said so.
MAX_LISTED = 100
MAX_LISTED_BODY = 1000
MAX_LISTED_REPLIES = 10
MAX_LISTED_REPLY = 400


def _text(value: object) -> str:
    return " ".join(str(value).split()) if value is not None else ""


def _clipped(value: object, limit: int) -> str:
    text = _text(value)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _share(value: object) -> str:
    try:
        return f"{float(value):.2f}"
    except (TypeError, ValueError):
        return "?"


def _place(item: dict[str, Any]) -> str:
    box = item.get("box") if isinstance(item.get("box"), list) and len(item["box"]) == 4 else [None] * 4
    if item.get("shape") == "point":
        return f"Punkt x {_share(box[0])}, y {_share(box[1])}"
    return f"Bereich x {_share(box[0])}–{_share(box[2])}, y {_share(box[1])}–{_share(box[3])}"


def _author(item: dict[str, Any]) -> str:
    name = _text(item.get("createdByName")) or "einer Person"
    if item.get("authorKind") == "piloti":
        return f"Piloti, für {name}" if item.get("createdByName") else "Piloti"
    return name


def _reply_lines(replies: list[Any]) -> list[str]:
    usable = [reply for reply in replies if isinstance(reply, dict)]
    if not usable:
        return []
    shown = usable[-MAX_LISTED_REPLIES:]
    lines = [f"  Antworten ({len(usable)}{', die letzten ' + str(len(shown)) if len(shown) < len(usable) else ''}):"]
    for reply in shown:
        who = "Piloti" if reply.get("authorKind") == "piloti" else _text(reply.get("createdByName")) or "Person"
        lines.append(f"    - {who}: {_clipped(reply.get('body'), MAX_LISTED_REPLY)}")
    return lines


def _annotation_lines(item: dict[str, Any]) -> list[str]:
    kind = _KIND_LABELS.get(str(item.get("kind")), _text(item.get("kind")))
    status = _STATUS_LABELS.get(str(item.get("status")), _text(item.get("status")))
    head = f"Nr. {item.get('number')} · S. {item.get('page')} · {kind} · {status} · von {_author(item)}"
    lines = [head, f"  {_clipped(item.get('body'), MAX_LISTED_BODY)}"]
    if basis := _text(item.get("basis")):
        lines.append(f"  Grundlage: {basis}")
    if assignee := _text(item.get("assigneeName")):
        lines.append(f"  Zuständig: {assignee}" + (f", fällig {_text(item.get('dueOn'))}" if item.get("dueOn") else ""))
    elif item.get("dueOn"):
        lines.append(f"  Fällig: {_text(item.get('dueOn'))}")
    lines.extend(_reply_lines(item.get("replies") or []))
    where = _place(item) + ("" if item.get("onCurrentFassung", True) else "; auf einer früheren Fassung gesetzt")
    lines.append(f"  {where} · id {item.get('id')}")
    return lines


def _sort_key(item: dict[str, Any]) -> tuple[int, int, int]:
    """Live ones first, then by page and number: the order a review walks them in (``compareAnnotations``)."""
    live = 0 if item.get("status") in _LIVE else 1
    page = item.get("page") if isinstance(item.get("page"), int) else 0
    number = item.get("number") if isinstance(item.get("number"), int) else 0
    return live, page, number


def _annotations(body: dict[str, Any]) -> list[dict[str, Any]]:
    raw = body.get("annotations") if isinstance(body.get("annotations"), list) else []
    return sorted((item for item in raw if isinstance(item, dict)), key=_sort_key)


def render_list(body: dict[str, Any]) -> str:
    """The marks as compact German text a model can cite by number and answer by id."""
    items = _annotations(body)
    named = f"„{body['documentName']}“" if body.get("documentName") else "diesem Dokument"
    if not items:
        return f"Auf {named} gibt es noch keine Anmerkungen."
    live = sum(1 for item in items if item.get("status") in _LIVE)
    proposed = sum(1 for item in items if item.get("status") == "proposed")
    lines = [
        f"Anmerkungen auf {named}: {len(items)}, davon {live} offen oder vorgeschlagen"
        f" ({proposed} Vorschläge von Piloti, die noch niemand übernommen hat). Orte als Anteile der Seite, "
        "Ursprung oben links."
    ]
    for item in items[:MAX_LISTED]:
        lines.extend(_annotation_lines(item))
    if len(items) > MAX_LISTED:
        lines.append(f"[{len(items) - MAX_LISTED} weitere, erledigte oder verworfene, nicht aufgeführt.]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# propose
# ---------------------------------------------------------------------------


def _region_size(proposal: AnnotationProposal, index: int) -> tuple[float, float]:
    """A region's width and height, clamped onto the page when it pokes past an edge by a hair."""
    w, h = proposal.w or 0.0, proposal.h or 0.0
    if w <= 0 or h <= 0:
        raise Refused(f"Fehler: Vorschlag {index}: ein Bereich braucht `w` und `h` größer als 0.")
    if proposal.x + w > 1 + _EDGE_SLACK or proposal.y + h > 1 + _EDGE_SLACK:
        raise Refused(f"Fehler: Vorschlag {index}: der Bereich reicht über die Seite hinaus (x+w und y+h höchstens 1).")
    return min(w, 1 - proposal.x), min(h, 1 - proposal.y)


def _proposal_payload(proposal: AnnotationProposal, index: int) -> dict[str, Any]:
    """One ``AnnotationProposal`` body, or a refusal naming what is wrong with it."""
    if proposal.page < 1:
        raise Refused(f"Fehler: Vorschlag {index}: `page` zählt ab 1.")
    if not (0 <= proposal.x <= 1 and 0 <= proposal.y <= 1):
        raise Refused(f"Fehler: Vorschlag {index}: `x` und `y` sind Anteile der Seite zwischen 0 und 1, keine Pixel.")
    body = _text(proposal.body)
    if not body or len(body) > MAX_BODY:
        raise Refused(f"Fehler: Vorschlag {index}: `body` muss 1 bis {MAX_BODY} Zeichen haben.")
    payload: dict[str, Any] = {
        "page": proposal.page,
        "shape": proposal.shape,
        "x": round(proposal.x, 4),
        "y": round(proposal.y, 4),
        "kind": proposal.kind,
        "body": body,
    }
    if proposal.shape == "region":
        w, h = _region_size(proposal, index)
        payload["w"], payload["h"] = round(w, 4), round(h, 4)
    if basis := _text(proposal.basis):
        payload["basis"] = basis[:MAX_BASIS]
    return payload


def _coerced(proposals: list[Any]) -> list[AnnotationProposal]:
    try:
        return [
            item if isinstance(item, AnnotationProposal) else AnnotationProposal.model_validate(item)
            for item in proposals
        ]
    except ValidationError as exc:
        raise Refused(f"Fehler: Ein Vorschlag ist unvollständig oder ungültig ({exc.error_count()} Fehler).") from exc


def propose_payload(proposals: list[Any]) -> dict[str, Any]:
    """The ``propose`` body, every proposal checked here so the model can fix it before the BFF refuses."""
    if not proposals:
        raise Refused("Fehler: `mark` braucht mindestens einen Eintrag in `proposals`.")
    if len(proposals) > MAX_PROPOSALS_PER_CALL:
        raise Refused(
            f"Fehler: Höchstens {MAX_PROPOSALS_PER_CALL} Vorschläge pro Aufruf. Wähle die wichtigsten oder teile auf."
        )
    items = _coerced(proposals)
    return {"op": "propose", "proposals": [_proposal_payload(item, index) for index, item in enumerate(items, 1)]}


def _proposed(body: dict[str, Any]) -> list[dict[str, Any]]:
    return [item for item in body.get("proposed") or [] if isinstance(item, dict)]


def _set_marks(body: dict[str, Any], key: str) -> list[dict[str, Any]]:
    return [item for item in body.get(key) or [] if isinstance(item, dict)]


def _on(body: dict[str, Any]) -> str:
    return f" auf „{body['documentName']}“" if body.get("documentName") else " auf dem Dokument"


def render_proposed(body: dict[str, Any]) -> str:
    proposed = _proposed(body)
    where = ", ".join(f"Nr. {item.get('number')} auf S. {item.get('page')}" for item in proposed)
    return f"Vorgeschlagen: {len(proposed)} Anmerkung(en){_on(body)} ({where}). {_PROPOSED}"


def create_payload(proposals: list[Any]) -> dict[str, Any]:
    """The ``create`` body: the same marks as a proposal, born open in the asker's name."""
    return {"op": "create", "marks": propose_payload(proposals)["proposals"]}


def render_created(body: dict[str, Any]) -> str:
    created = _set_marks(body, "created")
    where = ", ".join(f"Nr. {item.get('number')} auf S. {item.get('page')}" for item in created)
    return (
        f"Gesetzt: {len(created)} Anmerkung(en){_on(body)} ({where}), offen, im Namen der Person, die dich "
        "darum gebeten hat."
    )


def _box(item: dict[str, Any]) -> dict[str, Any]:
    """A proposed mark's place, as the activity card carries it: a point has no size."""
    if item.get("shape") == "point":
        return {"shape": "point", "x": item.get("x"), "y": item.get("y")}
    return {"shape": "region", "x": item.get("x"), "y": item.get("y"), "w": item.get("w"), "h": item.get("h")}


def proposed_items(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The activity card's entries for a ``propose`` answer, built from what the BFF returned."""
    return _set_items(_proposed(body), "proposed")


def created_items(body: dict[str, Any]) -> list[dict[str, Any]]:
    """The activity card's entries for a ``create`` answer: marks set at the person's request."""
    return _set_items(_set_marks(body, "created"), "created")


def _set_items(marks: list[dict[str, Any]], action: str) -> list[dict[str, Any]]:
    return [
        {
            "action": action,
            "annotation_id": item.get("id"),
            "number": item.get("number"),
            "page": item.get("page"),
            **_box(item),
            "kind": item.get("kind"),
            "body": item.get("body"),
        }
        for item in marks
    ]


def replied_item(body: dict[str, Any], text: str) -> dict[str, Any]:
    """The activity card's entry for a ``reply`` answer."""
    return {
        "action": "replied",
        "annotation_id": body.get("annotationId"),
        "number": body.get("number"),
        "excerpt": excerpt(text),
    }


# ---------------------------------------------------------------------------
# reply
# ---------------------------------------------------------------------------


def annotation_number(annotation: str) -> int | None:
    """The mark's number in ``annotation`` („Nr. 4“, „#4“, „4“), or None when it is not one."""
    ref = (annotation or "").strip().removeprefix("Nr.").strip().lstrip("#")
    return int(ref) if ref.isdigit() else None


def annotation_by_number(body: dict[str, Any], number: int) -> str:
    """The id of mark ``number`` in a ``list`` answer; a refusal when the document has none."""
    return annotation_entry(body, number)["id"]


def annotation_entry(body: dict[str, Any], number: int) -> dict[str, Any]:
    """Mark ``number`` as a ``list`` answer carries it (id and status); a refusal when the document has none."""
    match = next((item for item in _annotations(body) if item.get("number") == number), None)
    if match is None or not isinstance(match.get("id"), str):
        raise Refused(ANNOTATION_GONE, "not_found")
    return match


def reply_body(body: str) -> str:
    text = (body or "").strip()
    if not text or len(text) > MAX_BODY:
        raise Refused(f"Fehler: `reply` braucht `body` mit 1 bis {MAX_BODY} Zeichen.")
    return text


def render_replied(body: dict[str, Any]) -> str:
    return (
        f"Deine Antwort steht jetzt im Verlauf von Anmerkung Nr. {body.get('number')}, als Antwort von Piloti "
        f"gekennzeichnet ({body.get('replies')} Antwort(en) im Verlauf)."
    )


# ---------------------------------------------------------------------------
# update, delete: what the person asked for, in their name
# ---------------------------------------------------------------------------

_STATUSES = {
    "open": "open",
    "offen": "open",
    "übernehmen": "open",
    "resolved": "resolved",
    "erledigt": "resolved",
    "dismissed": "dismissed",
    "verworfen": "dismissed",
    "verwerfen": "dismissed",
}
_KINDS = {
    "hint": "hint",
    "hinweis": "hint",
    "question": "question",
    "rückfrage": "question",
    "defect": "defect",
    "mangel": "defect",
}
#: The value that empties `assignee` or `due_on`.
CLEAR = "-"
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _choice(value: str, allowed: dict[str, str], name: str) -> str:
    key = (value or "").strip().lower()
    if key not in allowed:
        raise Refused(f"Fehler: `{name}` ist eines von {', '.join(sorted(set(allowed.values())))}.")
    return allowed[key]


def _due_on(value: str) -> str | None:
    day = value.strip()
    if day == CLEAR:
        return None
    if _DAY.match(day):
        try:
            date.fromisoformat(day)
            return day
        except ValueError:
            pass
    raise Refused(f"Fehler: `due_on` ist ein Tag als JJJJ-MM-TT, oder `{CLEAR}` zum Entfernen.")


def update_payload(*, status: str, assignee: str, due_on: str, kind: str, body: str, note: str) -> dict[str, Any]:
    """The change fields of an ``update`` body, each checked here so the model can fix it before the BFF refuses."""
    text = (note or "").strip()
    if not text or len(text) > MAX_BODY:
        raise Refused(f"Fehler: `update` braucht `note` (1 bis {MAX_BODY} Zeichen): was du getan hast und warum.")
    payload: dict[str, Any] = {}
    if status.strip():
        payload["status"] = _choice(status, _STATUSES, "status")
    if assignee.strip():
        payload["assignee"] = None if assignee.strip() == CLEAR else assignee.strip()
    if due_on.strip():
        payload["dueOn"] = _due_on(due_on)
    if kind.strip():
        payload["kind"] = _choice(kind, _KINDS, "kind")
    if body.strip():
        payload["body"] = _text(body)[:MAX_BODY]
    if not payload:
        raise Refused(
            "Fehler: `update` braucht mindestens eine Änderung: `status`, `assignee`, `due_on`, `kind` oder `body`."
        )
    return {**payload, "note": text}


#: The wire's fields as the card names them, and the one that carries a name beside its value.
_CHANGE_FIELDS = (
    ("status", "status", None),
    ("assigneeUserId", "assignee", "assigneeName"),
    ("dueOn", "due_on", None),
    ("kind", "kind", None),
    ("body", "body", None),
)


def _field_changes(before: dict[str, Any], after: dict[str, Any]) -> list[dict[str, Any]]:
    changes: list[dict[str, Any]] = []
    for key, field, label in _CHANGE_FIELDS:
        if key not in before and key not in after:
            continue
        change: dict[str, Any] = {"field": field}
        for side, values in (("before", before), ("after", after)):
            if values.get(key) is not None:
                change[side] = str(values[key])
            if label and values.get(label):
                change[f"{side}_label"] = str(values[label])
        changes.append(change)
    return changes


def changed_item(body: dict[str, Any], note: str) -> dict[str, Any]:
    """The activity card's entry for an ``update`` answer: what moved, the note, and the status left behind."""
    before = body.get("before") if isinstance(body.get("before"), dict) else {}
    after = body.get("after") if isinstance(body.get("after"), dict) else {}
    return {
        "action": "changed",
        "annotation_id": body.get("annotationId"),
        "number": body.get("number"),
        "status": body.get("status"),
        "changes": _field_changes(before, after),
        "note": excerpt(note),
    }


def _shown(field: str, value: Any, label: Any) -> str:
    if value is None:
        return "–"
    if field == "status":
        return _STATUS_LABELS.get(str(value), str(value))
    if field == "kind":
        return _KIND_LABELS.get(str(value), str(value))
    if field == "body":
        return f"„{_clipped(value, 80)}“"
    return _text(label or value)


_FIELD_NAMES = {"status": "Status", "assignee": "Zuständig", "due_on": "Frist", "kind": "Art", "body": "Text"}


def render_updated(body: dict[str, Any]) -> str:
    number = body.get("number")
    if not body.get("noted"):
        return f"Nichts geändert: Anmerkung Nr. {number} stand schon so. Es wurde keine Notiz gepostet."
    moved = "; ".join(
        f"{_FIELD_NAMES[change['field']]} {_shown(change['field'], change.get('before'), change.get('before_label'))}"
        f" → {_shown(change['field'], change.get('after'), change.get('after_label'))}"
        for change in _field_changes(body.get("before") or {}, body.get("after") or {})
    )
    return (
        f"Geändert im Namen der Person: Anmerkung Nr. {number}{_on(body)} ({moved}). Deine `note` steht als Antwort "
        "von Piloti im Verlauf. Nenne in deiner Antwort die Nummer und was du geändert hast."
    )


def deleted_item(body: dict[str, Any]) -> dict[str, Any]:
    """The activity card's entry for a ``delete`` answer."""
    return {"action": "deleted", "number": body.get("number"), "body": _clipped(body.get("body"), MAX_BODY)}


def render_deleted(body: dict[str, Any]) -> str:
    return (
        f"Gelöscht: Anmerkung Nr. {body.get('number')}{_on(body)} („{_clipped(body.get('body'), 120)}“) mit ihrem "
        "Verlauf. Das lässt sich nicht rückgängig machen."
    )


# ---------------------------------------------------------------------------
# Langfuse
# ---------------------------------------------------------------------------


def marks_observation(operation: str, body: dict[str, Any]) -> dict[str, Any]:
    """What one call did, as Langfuse should see it: counts and numbers, never the text of a mark."""
    if operation == "list":
        items = _annotations(body)
        by_kind: dict[str, int] = {}
        for item in items:
            by_kind[str(item.get("kind"))] = by_kind.get(str(item.get("kind")), 0) + 1
        live = sum(1 for item in items if item.get("status") in _LIVE)
        return {"document": body.get("documentId"), "annotations": len(items), "live": live, "by_kind": by_kind}
    if operation in ("propose", "create"):
        key = "proposed" if operation == "propose" else "created"
        marks = _set_marks(body, key)
        return {
            "document": body.get("documentId"),
            key: len(marks),
            "pages": sorted({item.get("page") for item in marks if isinstance(item.get("page"), int)}),
        }
    if operation == "update":
        after = body.get("after") if isinstance(body.get("after"), dict) else {}
        return {
            "document": body.get("documentId"),
            "number": body.get("number"),
            "fields": sorted(after),
            "status": body.get("status"),
            "noted": bool(body.get("noted")),
        }
    if operation == "delete":
        return {"document": body.get("documentId"), "number": body.get("number"), "deleted": True}
    return {"document": body.get("documentId"), "number": body.get("number"), "replies": body.get("replies")}
