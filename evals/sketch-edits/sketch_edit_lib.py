"""Geometry, outline, render, op application and the generic checks for the sketch-edit eval.

Works on the element skeleton (the fence format), which is what Piloti writes and
what a filed scene is converted from. The outline mirrors
apps/workspace/bff/diagrams/sketch-outline.ts. `apply_ops` mirrors the shipped
operations of `document-sketch-edit` (`apps/workspace/bff/diagrams/sketch-edit.ts`)
in skeleton space: every op carries an `intent`; `remove` takes the arrows bound
to the element along and lets a frame's children go; `rebind`, `place`,
`align`, `distribute` and `stack`; arrows bound to a moved shape are routed
again. A mirror, not the code: a rule changed there is changed here too.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import math
import re
import sys as _sys
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
_spec = importlib.util.spec_from_file_location("sketch_fence", REPO / "packages/agent/src/agent/common/sketch_fence.py")
sketch_fence = importlib.util.module_from_spec(_spec)

_sys.modules["sketch_fence"] = sketch_fence
_spec.loader.exec_module(sketch_fence)  # stdlib-only module

SHAPES = {"rectangle", "ellipse", "diamond"}
CONNECTORS = {"arrow", "line"}
UPDATE_KEYS = {
    "x",
    "y",
    "width",
    "height",
    "strokeColor",
    "backgroundColor",
    "fillStyle",
    "strokeStyle",
    "label",
    "text",
    "customData",
}
MAX_OPS = 60
DIMENSION = sketch_fence._DIMENSION

# ---------------------------------------------------------------- geometry


def text_size(text: str, font: float = 20) -> tuple[float, float]:
    lines = text.split("\n")
    return max(len(line) for line in lines) * font * 0.55, len(lines) * font * 1.25


def bbox(el: dict[str, Any], scene: dict[str, dict] | None = None) -> tuple[float, float, float, float] | None:
    """x0, y0, x1, y1 of an element as Excalidraw would lay out the skeleton (estimated for unsized ones)."""
    t = el.get("type")
    if t in SHAPES:
        label = (el.get("label") or {}).get("text", "")
        tw, th = text_size(label) if label else (0, 0)
        w = el.get("width") or max(100.0, tw + 50)
        h = el.get("height") or max(60.0, th + 40)
        return el["x"], el["y"], el["x"] + w, el["y"] + h
    if t == "text":
        w, h = text_size(el.get("text", ""), el.get("fontSize", 20))
        return el["x"], el["y"], el["x"] + w, el["y"] + h
    if t in CONNECTORS:
        pts = el.get("points") or [[0, 0], [100, 0]]
        xs = [el["x"] + p[0] for p in pts]
        ys = [el["y"] + p[1] for p in pts]
        return min(xs), min(ys), max(xs), max(ys)
    if t == "frame" and scene is not None:
        boxes = [bbox(scene[c], scene) for c in el.get("children", []) if c in scene]
        boxes = [b for b in boxes if b]
        if not boxes:
            return None
        pad = 10
        return (
            min(b[0] for b in boxes) - pad,
            min(b[1] for b in boxes) - pad,
            max(b[2] for b in boxes) + pad,
            max(b[3] for b in boxes) + pad,
        )
    return None


def area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def intersection(a, b) -> float:
    return area((max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])))


def iou(a, b) -> float:
    i = intersection(a, b)
    u = area(a) + area(b) - i
    return i / u if u else 0.0


def overlap_ratio(a, b) -> float:
    """Intersection over the smaller box: catches a note dropped inside a big shape, which IoU hides."""
    m = min(area(a), area(b))
    return intersection(a, b) / m if m else 0.0


def centre(b) -> tuple[float, float]:
    return (b[0] + b[2]) / 2, (b[1] + b[3]) / 2


def dist_to_box(p, b) -> float:
    dx = max(b[0] - p[0], 0, p[0] - b[2])
    dy = max(b[1] - p[1], 0, p[1] - b[3])
    return math.hypot(dx, dy)


# ---------------------------------------------------------------- scene helpers


def by_id(elements: list[dict]) -> dict[str, dict]:
    return {e["id"]: e for e in elements if "id" in e}


def label_of(el: dict) -> str | None:
    if el.get("type") == "text":
        return el.get("text")
    if el.get("type") == "frame":
        return el.get("name")
    return (el.get("label") or {}).get("text")


def norm(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def find_by_label(elements: list[dict], text: str, types=SHAPES) -> list[dict]:
    return [e for e in elements if e.get("type") in types and norm(label_of(e)) == norm(text)]


def connections(elements: list[dict]) -> list[tuple[str | None, str | None, dict]]:
    return [
        ((e.get("start") or {}).get("id"), (e.get("end") or {}).get("id"), e)
        for e in elements
        if e.get("type") in CONNECTORS
    ]


def connected(elements, a_id, b_id) -> bool:
    return any({s, t} == {a_id, b_id} for s, t, _ in connections(elements))


# ---------------------------------------------------------------- outline (sketch-outline.ts + box)


def _box(b):
    return None if b is None else {"x": round(b[0]), "y": round(b[1]), "w": round(b[2] - b[0]), "h": round(b[3] - b[1])}


def outline(scene: dict) -> dict:
    els = scene["elements"]
    ids = by_id(els)
    labels = {e["id"]: label_of(e) for e in els if "id" in e}
    out = {"title": scene.get("title"), "texts": [], "shapes": [], "connections": [], "frames": []}
    for e in els:
        t = e["type"]
        if t == "text":
            out["texts"].append({"id": e.get("id"), "text": e["text"], "container": None, "box": _box(bbox(e))})
        elif t in SHAPES:
            out["shapes"].append({"id": e["id"], "type": t, "label": labels.get(e["id"]), "box": _box(bbox(e))})
            if (e.get("label") or {}).get("text"):
                out["texts"].append(
                    {"id": f"{e['id']}-label", "text": e["label"]["text"], "container": {"id": e["id"], "type": t}}
                )
        elif t in CONNECTORS:
            s, d = (e.get("start") or {}).get("id"), (e.get("end") or {}).get("id")
            out["connections"].append(
                {
                    "id": e["id"],
                    "type": t,
                    "from": {"id": s, "label": labels.get(s)} if s else None,
                    "to": {"id": d, "label": labels.get(d)} if d else None,
                    "label": (e.get("label") or {}).get("text"),
                    "dashed": e.get("strokeStyle") == "dashed" or None,
                }
            )
        elif t == "frame":
            out["frames"].append(
                {
                    "id": e["id"],
                    "name": e.get("name"),
                    "box": _box(bbox(e, ids)),
                    "children": [
                        {"id": c, "type": ids[c]["type"], "label": labels.get(c)} for c in e["children"] if c in ids
                    ],
                }
            )
    for s in out["shapes"]:
        el = ids[s["id"]]
        for k in ("backgroundColor", "strokeStyle"):
            if el.get(k):
                s[k] = el[k]
    return out


# ---------------------------------------------------------------- ops


class OpError(Exception):
    pass


MAX_INTENT = 200
DEFAULT_GAP = 40
SIDES = {"above", "below", "left", "right"}
EDGES = {"left", "center", "right", "top", "middle", "bottom"}
AXES = {"horizontal", "vertical"}


def _clip(b, toward, gap=4.0):
    """Where the segment from a box's centre toward `toward` leaves the box, `gap` outside it."""
    cx, cy = centre(b)
    dx, dy = toward[0] - cx, toward[1] - cy
    if not dx and not dy:
        return cx, cy
    hw, hh = (b[2] - b[0]) / 2 + gap, (b[3] - b[1]) / 2 + gap
    s = min(hw / abs(dx) if dx else 1e9, hh / abs(dy) if dy else 1e9, 1)
    return cx + dx * s, cy + dy * s


def route(el: dict, live: dict[str, dict]) -> None:
    """A connector drawn again between what it is bound to, edge to edge (`routeConnector`)."""
    pts = el.get("points") or [[0, 0], [100, 0]]
    first = (el["x"] + pts[0][0], el["y"] + pts[0][1])
    last = (el["x"] + pts[-1][0], el["y"] + pts[-1][1])
    a = live.get((el.get("start") or {}).get("id"))
    b = live.get((el.get("end") or {}).get("id"))
    if not a and not b:
        return
    p0 = _clip(bbox(a, live), centre(bbox(b, live)) if b else last) if a else first
    p1 = _clip(bbox(b, live), centre(bbox(a, live)) if a else p0) if b else last
    el["x"], el["y"] = p0
    el["points"] = [[0, 0], [p1[0] - p0[0], p1[1] - p0[1]]]


class _Edit:
    def __init__(self, scene: dict):
        self.els = copy.deepcopy(scene["elements"])
        self.base_ids = {e["id"] for e in self.els if "id" in e}
        self.touched = {"added": [], "updated": [], "removed": []}
        self.reroute: set[str] = set()

    def live(self) -> dict[str, dict]:
        return by_id(self.els)

    def get(self, id_) -> dict:
        el = self.live().get(id_)
        if el is None:
            raise OpError("unknown-id")
        return el

    def bound_to(self, id_) -> list[dict]:
        return [
            e
            for e in self.els
            if e.get("type") in CONNECTORS and id_ in ((e.get("start") or {}).get("id"), (e.get("end") or {}).get("id"))
        ]

    def touch(self, id_) -> None:
        if id_ not in self.touched["updated"] and id_ not in self.touched["added"]:
            self.touched["updated"].append(id_)

    def move(self, el: dict, dx: float, dy: float) -> None:
        if not dx and not dy:
            return
        el["x"] += dx
        el["y"] += dy
        self.touch(el["id"])
        self.reroute.update(c["id"] for c in self.bound_to(el["id"]) if "id" in c)

    def movable(self, id_) -> dict:
        el = self.get(id_)
        if el.get("type") not in SHAPES | {"text"}:
            raise OpError("not-movable")
        return el


def _op_add(ed: _Edit, op: dict) -> None:
    el = op.get("element")
    if not isinstance(el, dict) or not isinstance(el.get("id"), str) or not el["id"]:
        raise OpError("add-needs-id")
    if el["id"] in ed.live() or el["id"] in ed.base_ids:
        raise OpError("id-taken")
    ed.els.append(copy.deepcopy(el))
    ed.touched["added"].append(el["id"])
    if el.get("type") in CONNECTORS:
        ed.reroute.add(el["id"])


def _op_update(ed: _Edit, op: dict) -> None:
    target = ed.get(op.get("id"))
    changes = op.get("set")
    if not isinstance(changes, dict) or not changes:
        raise OpError("empty-update")
    bad = set(changes) - UPDATE_KEYS
    if bad:
        raise OpError("field-not-allowed:" + ",".join(sorted(bad)))
    if "x" in changes or "y" in changes:
        ed.move(target, changes.get("x", target["x"]) - target["x"], changes.get("y", target["y"]) - target["y"])
    for k, v in changes.items():
        if k in ("x", "y"):
            continue
        if k == "label" and isinstance(v, dict):
            target["label"] = {**(target.get("label") or {}), **v}
        else:
            target[k] = v
    if "width" in changes or "height" in changes:
        ed.reroute.update(c["id"] for c in ed.bound_to(target["id"]) if "id" in c)
    ed.touch(target["id"])


def _op_remove(ed: _Edit, op: dict) -> None:
    el = ed.get(op.get("id"))
    gone = {el["id"]} | {c["id"] for c in ed.bound_to(el["id"]) if "id" in c}
    ed.els = [e for e in ed.els if e.get("id") not in gone]
    for e in ed.els:  # a frame lets a removed child go, as Excalidraw does
        if e.get("type") == "frame":
            e["children"] = [c for c in e["children"] if c not in gone]
    for id_ in gone:
        if id_ in ed.touched["added"]:
            ed.touched["added"].remove(id_)
        elif id_ in ed.base_ids:
            ed.touched["removed"].append(id_)


def _op_rebind(ed: _Edit, op: dict) -> None:
    el = ed.get(op.get("id"))
    if el.get("type") not in CONNECTORS:
        raise OpError("not-a-connector")
    if op.get("start") is None and op.get("end") is None:
        raise OpError("empty-rebind")
    for end in ("start", "end"):
        if op.get(end) is not None:
            target = ed.get(op[end])
            if target.get("type") in CONNECTORS:
                raise OpError("not-movable")
            el[end] = {"id": target["id"]}
    ed.reroute.add(el["id"])
    ed.touch(el["id"])


def _op_place(ed: _Edit, op: dict) -> None:
    el, ref = ed.movable(op.get("id")), ed.get(op.get("referenceId"))
    if op.get("side") not in SIDES or el is ref:
        raise OpError("bad-place")
    b, r = bbox(el, ed.live()), bbox(ref, ed.live())
    w, h, off, align = b[2] - b[0], b[3] - b[1], op.get("offset", DEFAULT_GAP), op.get("align", "center")

    def along(start, length, size):
        return start if align == "start" else start + length - size if align == "end" else start + length / 2 - size / 2

    side = op["side"]
    x = {"left": r[0] - off - w, "right": r[2] + off}.get(side, along(r[0], r[2] - r[0], w))
    y = {"above": r[1] - off - h, "below": r[3] + off}.get(side, along(r[1], r[3] - r[1], h))
    ed.move(el, x - b[0], y - b[1])


def _op_align(ed: _Edit, op: dict) -> None:
    els = [ed.movable(i) for i in dict.fromkeys(op.get("ids") or [])]
    if len(els) < 2 or op.get("edge") not in EDGES:
        raise OpError("bad-align")
    bs = [bbox(e, ed.live()) for e in els]
    left, top = min(b[0] for b in bs), min(b[1] for b in bs)
    right, bottom = max(b[2] for b in bs), max(b[3] for b in bs)
    for e, b in zip(els, bs):
        w, h = b[2] - b[0], b[3] - b[1]
        x = {"left": left, "right": right - w, "center": (left + right) / 2 - w / 2}.get(op["edge"], b[0])
        y = {"top": top, "bottom": bottom - h, "middle": (top + bottom) / 2 - h / 2}.get(op["edge"], b[1])
        ed.move(e, x - b[0], y - b[1])


def _span(b, horizontal):
    return (b[0], b[2] - b[0]) if horizontal else (b[1], b[3] - b[1])


def _op_distribute(ed: _Edit, op: dict) -> None:
    if op.get("axis") not in AXES:
        raise OpError("bad-axis")
    hz = op["axis"] == "horizontal"
    items = sorted(
        ((e, bbox(e, ed.live())) for e in (ed.movable(i) for i in dict.fromkeys(op.get("ids") or []))),
        key=lambda eb: _span(eb[1], hz)[0] + _span(eb[1], hz)[1] / 2,
    )
    if len(items) < 3:
        raise OpError("bad-distribute")
    first, (ls, lsz) = _span(items[0][1], hz)[0], _span(items[-1][1], hz)
    gap = (ls + lsz - first - sum(_span(b, hz)[1] for _, b in items)) / (len(items) - 1)
    cursor = first
    for e, b in items:
        start, size = _span(b, hz)
        ed.move(e, cursor - start if hz else 0, 0 if hz else cursor - start)
        cursor += size + gap


def _op_stack(ed: _Edit, op: dict) -> None:
    if op.get("axis") not in AXES:
        raise OpError("bad-axis")
    hz, gap = op["axis"] == "horizontal", op.get("gap", DEFAULT_GAP)
    els = [ed.movable(i) for i in dict.fromkeys(op.get("ids") or [])]
    if len(els) < 2:
        raise OpError("bad-stack")
    start, size = _span(bbox(els[0], ed.live()), hz)
    cursor = start + size + gap
    for e in els[1:]:
        at, length = _span(bbox(e, ed.live()), hz)
        ed.move(e, cursor - at if hz else 0, 0 if hz else cursor - at)
        cursor += length + gap


OPS = {
    "add": _op_add,
    "update": _op_update,
    "remove": _op_remove,
    "rebind": _op_rebind,
    "place": _op_place,
    "align": _op_align,
    "distribute": _op_distribute,
    "stack": _op_stack,
}


def apply_ops(scene: dict, ops: list[dict]) -> tuple[dict, dict]:
    """The scene after the ops, and what they touched. Raises OpError for an op the shipped rules refuse."""
    if not isinstance(ops, list) or len(ops) > MAX_OPS:
        raise OpError("ops-count")
    ed = _Edit(scene)
    for op in ops:
        if not isinstance(op, dict):
            raise OpError("op-not-object")
        intent = op.get("intent")
        if not isinstance(intent, str) or not intent.strip() or len(intent) > MAX_INTENT:
            raise OpError("bad-intent")
        if op.get("op") not in OPS:
            raise OpError("unknown-op")
        OPS[op["op"]](ed, op)
    live = ed.live()
    for id_ in ed.reroute:
        if id_ in live:
            route(live[id_], live)
    return {"title": scene.get("title"), "elements": ed.els}, ed.touched


def with_intents(response: dict) -> dict:
    """An answer written before ops carried an intent (the blind set of 2026-10-29), given one per op."""
    ops = [
        op if not isinstance(op, dict) or op.get("intent") else {**op, "intent": f"({op.get('op')})"}
        for op in response.get("ops") or []
    ]
    return {**response, "ops": ops}


# ---------------------------------------------------------------- generic checks


def parse_response(text: str) -> dict:
    """The model's JSON: bare, or in a ```json fence."""
    m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", text, re.S)
    body = m.group(1) if m else text[text.find("{") : text.rfind("}") + 1]
    data = json.loads(body)
    if not isinstance(data, dict) or "ops" not in data:
        raise ValueError("no ops key")
    return data


def generic_checks(base: dict, after: dict, touched: dict) -> dict[str, Any]:
    """Rules every edit keeps: fence-valid, no dimension label, no new overlap, added arrows land on their shapes."""
    res: dict[str, Any] = {}
    verdict = sketch_fence.check_sketch(json.dumps(after, ensure_ascii=False))
    res["fence_valid"] = verdict.drawn
    res["fence_refusal"] = verdict.refusal
    ids = by_id(after["elements"])
    changed = set(touched["added"]) | set(touched["updated"])
    dims = [label_of(ids[i]) for i in changed if i in ids and label_of(ids[i]) and DIMENSION.search(label_of(ids[i]))]
    res["no_dimension_labels"] = not dims
    res["dimension_labels"] = dims
    # overlaps: a new or moved box against every other box (frames, connectors excluded)
    boxed = {i: bbox(e) for i, e in ids.items() if e["type"] in SHAPES | {"text"}}
    worst, pairs = 0.0, []
    for i in changed:
        if i not in boxed:
            continue
        for j, b in boxed.items():
            if j == i or (j in changed and j < i):
                continue
            r = overlap_ratio(boxed[i], b)
            worst = max(worst, r)
            if r > 0.05:
                pairs.append([i, j, round(r, 2), round(iou(boxed[i], b), 2)])
    # new frames must not overlap each other or old frames
    frames = {i: bbox(e, ids) for i, e in ids.items() if e["type"] == "frame"}
    for i in changed:
        if i in frames and frames[i]:
            for j, b in frames.items():
                if j != i and b and overlap_ratio(frames[i], b) > 0.02 and not (j in changed and j < i):
                    pairs.append([i, j, round(overlap_ratio(frames[i], b), 2), "frame"])
    res["no_new_overlaps"] = not pairs
    res["overlaps"] = pairs
    res["worst_overlap"] = round(worst, 3)
    # added connectors: bound ends land on their shape (within 40 px)
    bad_arrows = []
    for i in touched["added"]:
        e = ids.get(i)
        if not e or e["type"] not in CONNECTORS:
            continue
        pts = e.get("points") or [[0, 0], [100, 0]]
        p0 = (e["x"] + pts[0][0], e["y"] + pts[0][1])
        p1 = (e["x"] + pts[-1][0], e["y"] + pts[-1][1])
        for end, p in (("start", p0), ("end", p1)):
            ref = (e.get(end) or {}).get("id")
            if ref and ref in ids and bbox(ids[ref], ids) and dist_to_box(p, bbox(ids[ref], ids)) > 40:
                bad_arrows.append([i, end, ref, round(dist_to_box(p, bbox(ids[ref], ids)))])
    res["arrows_land"] = not bad_arrows
    res["arrow_misses"] = bad_arrows
    allb = [bbox(e, ids) for e in ids.values()]
    allb = [b for b in allb if b]
    res["scene_extent"] = [
        round(max(b[2] for b in allb) - min(b[0] for b in allb)),
        round(max(b[3] for b in allb) - min(b[1] for b in allb)),
    ]
    return res


GENERIC_GATES = ("fence_valid", "no_dimension_labels", "no_new_overlaps", "arrows_land")
