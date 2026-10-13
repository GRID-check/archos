"""``document_annotations``: Piloti reads, proposes and answers Anmerkungen on the chat's document.

An Anmerkung is a mark a person sets at a place on a page of a document (a
point or a region), with what is to be done about it — a Hinweis, a Rückfrage
or a Mangel — and a thread of replies under it. This tool is Piloti's hand on
them, through ``POST /api/internal/document-annotations`` (``client.py``).

## One tool, three operations

``list`` reads them, ``propose`` sets findings, ``reply`` answers in a thread.
One tool with an ``operation``, not three: every bound tool's schema rides on
every model call of every chat turn (``propose_file_change`` is the precedent).

## Which document, and as whom

Only the CONVERSATION's subject, which the BFF resolves from the conversation
the signed envelope names. There is no document argument: a model cannot point
the tool at another document by typing an id. A chat that is not about a
document gets a sentence telling the reader where to ask instead. The acting
person is the one the envelope names (echo, never sign: ``tools/AGENTS.md``).

## A proposal is not a finding

Piloti's marks are born ``proposed`` (the CHECKs of migration 0135 hold it on
the BFF side): they appear on the document as Piloti's suggestions, and count
only once a person takes one over („übernehmen“) or dismisses it
(„verwerfen“). VISION.md principle 4, suggest then confirm. So the ``propose``
result leads with what has NOT happened, the way ``propose_file_change`` does:
a model told „gesetzt“ writes an answer claiming the defects are recorded.

A reply is the exception and lands at once, marked as Piloti's: it changes no
state, and the description asks for one only when the reader wants it.
"""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Annotated
from typing import Any
from typing import Literal

from pydantic import BaseModel
from pydantic import BeforeValidator
from pydantic import ValidationError

from aiq_agent import project_context
from aiq_agent.observability.langfuse_trace_attributes import add_trace_tag
from aiq_agent.observability.retrieval_trace import emit_step_span
from aiq_agent.turn.response import turn_answer_message_id
from nat.plugin_api import Builder
from nat.plugin_api import FunctionBaseConfig
from nat.plugin_api import FunctionInfo
from nat.plugin_api import register_function

from ..documents.filing import SignedEnvelope
from .client import AnnotationRequestError
from .client import post_annotations

logger = logging.getLogger(__name__)

#: The tool's basename, as the live line and the Herleitung chip name it.
DOCUMENT_ANNOTATIONS_TOOL = "document_annotations"

#: The turn's Langfuse tag: every turn that touched a document's Anmerkungen is one filter away.
FEATURE_TAG = "feature:annotations"

#: Mirrored from ``lib/annotations/types.ts``; the BFF validates against its own.
MAX_BODY = 2000
MAX_BASIS = 300
MAX_PROPOSALS_PER_CALL = 20

#: A region that pokes past the page edge by less than this is clamped onto it:
#: an estimate read off a rendered page lands a hair outside often enough.
_EDGE_SLACK = 0.02


def _normalized(value: object) -> object:
    return value.strip().lower() if isinstance(value, str) else value


Operation = Annotated[Literal["list", "propose", "reply"], BeforeValidator(_normalized)]
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


_DESCRIPTION = (
    "Arbeitet mit den Anmerkungen auf dem Dokument, um das es in diesem Chat geht: Markierungen an "
    "einer Stelle einer Seite (Punkt oder Bereich), je ein Hinweis (`hint`), eine Rückfrage "
    "(`question`) oder ein Mangel (`defect`), mit einem Antwortverlauf. Wirkt nur in einem Chat zu "
    "einem Dokument und nur auf dieses. Nimm es, wenn die Nutzerin ein Dokument prüfen oder "
    "durchsehen lässt und die Befunde markiert haben will, wissen will, was Kolleginnen angemerkt "
    "haben, aus den Anmerkungen ein Protokoll oder eine Mängelliste machen will, oder um eine "
    "Antwort in einem Verlauf bittet.\n"
    "`operation`:\n"
    "- `list`: liest alle Anmerkungen mit Nummer, Seite, Art, Status, Text, Grundlage, "
    "Zuständigkeit, Frist und Antworten. Vor einem Protokoll, einer Antwort und vor `propose` zuerst "
    "lesen, damit nichts doppelt markiert wird.\n"
    "- `propose`: setzt `proposals` als VORSCHLÄGE von Piloti. Nichts davon gilt, bis eine Person "
    "den Vorschlag im Dokument übernimmt oder verwirft; sag nie, ein Mangel sei eingetragen. "
    "Vorher die Seite mit `view_knowledge_image` ansehen und die Stelle dort abschätzen. Je "
    "Vorschlag: `page` (ab 1); `shape` `region` (für Befunde bevorzugt: ein enger Rahmen um das "
    "Bauteil) oder `point`; `x`/`y` die linke obere Ecke, bei `region` dazu `w`/`h`, alles als "
    "Anteil der Seite, wie sie gerendert ist (0 bis 1, Ursprung oben links, keine Pixel, x+w und "
    "y+h höchstens 1); `kind`; `body` im Deutsch des Büros, konkret und kurz: was wo nicht passt "
    "und was zu tun ist (höchstens 2000 Zeichen); `basis` mit der Fundstelle, wenn der Befund auf "
    "einer Norm beruht (z. B. „OIB-RL 2, Pkt. 3.5.2“). Höchstens 20 pro Aufruf und kaum mehr als "
    "10 je Blatt, außer die Nutzerin will mehr: das Wichtigste zuerst, nicht jede Kleinigkeit. Die "
    "Datei heißt im Text Dokument oder Fassung, nie Plan.\n"
    "- `reply`: schreibt `body` als Antwort von Piloti in den Verlauf der Anmerkung `annotation` "
    "(ihre id oder Nummer aus `list`). Erscheint sofort für alle, die das Dokument öffnen: nur, "
    "wenn die Nutzerin darum bittet."
)

_NO_ENVELOPE = (
    "Fehler: Dieser Lauf hat keinen signierten Sitzungsnachweis, deshalb kann Piloti keine Anmerkungen "
    "lesen oder setzen. Nicht erneut versuchen."
)
_NO_DOCUMENT = (
    "Diese Unterhaltung gehört zu keinem Dokument, deshalb gibt es hier keine Anmerkungen. Sage der "
    "Nutzerin, sie soll das Dokument öffnen und Piloti von dort aus fragen. Nicht erneut versuchen."
)
_FORBIDDEN = (
    "Nicht möglich: Die Nutzerin darf an diesem Dokument nichts ändern, oder dieser Chat darf es nicht "
    "lesen. Sage es ihr so; nicht erneut versuchen."
)
_DOCUMENT_GONE = (
    "Das Dokument dieses Chats gibt es nicht mehr, oder es ist noch nicht freigegeben. Nicht erneut versuchen."
)
_ANNOTATION_GONE = (
    "Diese Anmerkung gibt es auf dem Dokument nicht (mehr). Lies mit `list` nach und nimm ihre id oder Nummer."
)
_CONFLICT = "Jemand hat die Anmerkungen gerade geändert. Lies sie mit `list` neu, bevor du weitermachst."
_UNREACHABLE = (
    "Fehler: Die Anmerkungen sind gerade nicht erreichbar. Sage der Nutzerin, dass es nicht geklappt hat; "
    "nicht in derselben Antwort erneut versuchen."
)

#: Every successful `propose` ends on this. It leads with the negative because that is what a model gets wrong.
_PROPOSED = (
    "Das sind VORSCHLÄGE: Es wurde NOCH NICHTS bestätigt. Sie stehen im Dokument als Vorschläge von Piloti, "
    "bis eine Person jeden einzeln übernimmt oder verwirft. Sage nicht, die Befunde seien eingetragen oder "
    "festgehalten; sag, dass du sie vorgeschlagen hast und wo sie sie im Dokument prüfen kann."
)

_UUID = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")


class DocumentAnnotationsConfig(FunctionBaseConfig, name="document_annotations"):
    """Configuration for the ``document_annotations`` tool."""


class _Refused(Exception):
    """A call that answers the model with a sentence instead of a result; ``code`` is what Langfuse records."""

    def __init__(self, message: str, code: str = "invalid_arguments") -> None:
        super().__init__(message)
        self.message = message
        self.code = code


# ---------------------------------------------------------------------------
# The call
# ---------------------------------------------------------------------------


def _envelope() -> SignedEnvelope:
    header, signature = project_context.get_request_envelope_from_context()
    if not header or not signature:
        raise _Refused(_NO_ENVELOPE, "no_envelope")
    return SignedEnvelope(header=header, signature=signature)


def _with_answer(payload: dict[str, Any]) -> dict[str, Any]:
    """The body, naming the answer this turn writes (ADR-0093), as ``project_lookup`` does.

    The BFF admits the subject against the conversation's audience and marks
    this answer when the subject sits in a restricted folder.
    """
    conversation_id = project_context.get_conversation_id_from_context()
    if not conversation_id:
        return payload
    return {**payload, "answerMessageId": turn_answer_message_id(conversation_id)}


def _refusal_for(exc: AnnotationRequestError, operation: str) -> _Refused:
    """A BFF refusal as the sentence the model relays."""
    if exc.reason == "no-document-subject":
        return _Refused(_NO_DOCUMENT, "no_document_subject")
    if exc.status == 403:
        return _Refused(_FORBIDDEN, "forbidden")
    if exc.status == 404:
        return _Refused(_ANNOTATION_GONE if operation == "reply" else _DOCUMENT_GONE, "not_found")
    if exc.status == 409:
        return _Refused(_CONFLICT, "conflict")
    if exc.status in (400, 422):
        return _Refused(f"Fehler: Die Anfrage wurde abgelehnt ({exc}). Korrigiere die Argumente.", "invalid")
    return _Refused(_UNREACHABLE, "unreachable")


async def _call(payload: dict[str, Any]) -> dict[str, Any]:
    """One request, off the event loop, with every refusal worded for the model."""
    envelope = _envelope()
    try:
        return await asyncio.to_thread(post_annotations, _with_answer(payload), envelope)
    except AnnotationRequestError as exc:
        raise _refusal_for(exc, str(payload.get("op"))) from exc


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
    if not items:
        return "Auf diesem Dokument gibt es noch keine Anmerkungen."
    live = sum(1 for item in items if item.get("status") in _LIVE)
    proposed = sum(1 for item in items if item.get("status") == "proposed")
    lines = [
        f"Anmerkungen auf diesem Dokument: {len(items)}, davon {live} offen oder vorgeschlagen"
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
        raise _Refused(f"Fehler: Vorschlag {index}: ein Bereich braucht `w` und `h` größer als 0.")
    if proposal.x + w > 1 + _EDGE_SLACK or proposal.y + h > 1 + _EDGE_SLACK:
        raise _Refused(
            f"Fehler: Vorschlag {index}: der Bereich reicht über die Seite hinaus (x+w und y+h höchstens 1)."
        )
    return min(w, 1 - proposal.x), min(h, 1 - proposal.y)


def _proposal_payload(proposal: AnnotationProposal, index: int) -> dict[str, Any]:
    """One ``AnnotationProposal`` body, or a refusal naming what is wrong with it."""
    if proposal.page < 1:
        raise _Refused(f"Fehler: Vorschlag {index}: `page` zählt ab 1.")
    if not (0 <= proposal.x <= 1 and 0 <= proposal.y <= 1):
        raise _Refused(f"Fehler: Vorschlag {index}: `x` und `y` sind Anteile der Seite zwischen 0 und 1, keine Pixel.")
    body = _text(proposal.body)
    if not body or len(body) > MAX_BODY:
        raise _Refused(f"Fehler: Vorschlag {index}: `body` muss 1 bis {MAX_BODY} Zeichen haben.")
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
        raise _Refused(f"Fehler: Ein Vorschlag ist unvollständig oder ungültig ({exc.error_count()} Fehler).") from exc


def propose_payload(proposals: list[Any]) -> dict[str, Any]:
    """The ``propose`` body, every proposal checked here so the model can fix it before the BFF refuses."""
    if not proposals:
        raise _Refused("Fehler: `propose` braucht mindestens einen Eintrag in `proposals`.")
    if len(proposals) > MAX_PROPOSALS_PER_CALL:
        raise _Refused(
            f"Fehler: Höchstens {MAX_PROPOSALS_PER_CALL} Vorschläge pro Aufruf. Wähle die wichtigsten oder teile auf."
        )
    items = _coerced(proposals)
    return {"op": "propose", "proposals": [_proposal_payload(item, index) for index, item in enumerate(items, 1)]}


def render_proposed(body: dict[str, Any]) -> str:
    proposed = [item for item in body.get("proposed") or [] if isinstance(item, dict)]
    where = ", ".join(f"Nr. {item.get('number')} auf S. {item.get('page')}" for item in proposed)
    return f"Vorgeschlagen: {len(proposed)} Anmerkung(en) auf dem Dokument ({where}). {_PROPOSED}"


# ---------------------------------------------------------------------------
# reply
# ---------------------------------------------------------------------------


async def _annotation_id(annotation: str) -> str:
    """The id to answer under: as given, or looked up by its number on the document."""
    ref = annotation.strip().removeprefix("Nr.").strip().lstrip("#")
    if _UUID.match(ref):
        return ref
    if not ref.isdigit():
        raise _Refused("Fehler: `reply` braucht `annotation`: die id oder die Nummer aus `list`.")
    listed = _annotations(await _call({"op": "list"}))
    match = next((item for item in listed if item.get("number") == int(ref)), None)
    if match is None or not isinstance(match.get("id"), str):
        raise _Refused(_ANNOTATION_GONE, "not_found")
    return match["id"]


def _reply_body(body: str) -> str:
    text = (body or "").strip()
    if not text or len(text) > MAX_BODY:
        raise _Refused(f"Fehler: `reply` braucht `body` mit 1 bis {MAX_BODY} Zeichen.")
    return text


def render_replied(body: dict[str, Any]) -> str:
    return (
        f"Deine Antwort steht jetzt im Verlauf von Anmerkung Nr. {body.get('number')}, als Antwort von Piloti "
        f"gekennzeichnet ({body.get('replies')} Antwort(en) im Verlauf)."
    )


# ---------------------------------------------------------------------------
# Langfuse
# ---------------------------------------------------------------------------


def annotations_observation(operation: str, body: dict[str, Any]) -> dict[str, Any]:
    """What one call did, as Langfuse should see it: counts and numbers, never the text of a mark."""
    if operation == "list":
        items = _annotations(body)
        by_kind: dict[str, int] = {}
        for item in items:
            by_kind[str(item.get("kind"))] = by_kind.get(str(item.get("kind")), 0) + 1
        live = sum(1 for item in items if item.get("status") in _LIVE)
        return {"document": body.get("documentId"), "annotations": len(items), "live": live, "by_kind": by_kind}
    if operation == "propose":
        proposed = [item for item in body.get("proposed") or [] if isinstance(item, dict)]
        return {
            "document": body.get("documentId"),
            "proposed": len(proposed),
            "pages": sorted({item.get("page") for item in proposed if isinstance(item.get("page"), int)}),
        }
    return {"document": body.get("documentId"), "number": body.get("number"), "replies": body.get("replies")}


def _observe(operation: str, request: dict[str, Any], outcome: dict[str, Any]) -> None:
    """One ``annotate.<operation>`` observation and the turn's ``feature:annotations`` tag. Never raises."""
    add_trace_tag(FEATURE_TAG)
    emit_step_span(f"annotate.{operation}", request, outcome)


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------


async def _run(operation: str, proposals: list[Any], annotation: str, body: str) -> str:
    if operation == "list":
        result = await _call({"op": "list"})
        _observe(operation, {"operation": operation}, annotations_observation(operation, result))
        return render_list(result)
    if operation == "propose":
        payload = propose_payload(proposals)
        result = await _call(payload)
        request = {"operation": operation, "proposals": len(payload["proposals"])}
        _observe(operation, request, annotations_observation(operation, result))
        return render_proposed(result)
    if operation == "reply":
        text = _reply_body(body)
        result = await _call({"op": "reply", "annotationId": await _annotation_id(annotation), "body": text})
        _observe(operation, {"operation": operation}, annotations_observation(operation, result))
        return render_replied(result)
    raise _Refused("Fehler: `operation` muss `list`, `propose` oder `reply` sein.")


async def run_document_annotations(
    operation: Operation,
    proposals: list[AnnotationProposal] | None = None,
    annotation: str = "",
    body: str = "",
) -> str:
    """Read, propose or answer Anmerkungen on this chat's document. Module-level so it runs without NAT.

    Args:
        operation: list | propose | reply.
        proposals: The findings to propose (propose).
        annotation: The Anmerkung's id or number from `list` (reply).
        body: The reply text, in German (reply).
    """
    op = str(_normalized(operation))
    try:
        return await _run(op, list(proposals or []), annotation or "", body or "")
    except _Refused as refused:
        _observe(op, {"operation": op}, {"refused": refused.code})
        return refused.message


@register_function(config_type=DocumentAnnotationsConfig)
async def document_annotations(tool_config: DocumentAnnotationsConfig, builder: Builder):
    yield FunctionInfo.from_fn(run_document_annotations, description=_DESCRIPTION)
