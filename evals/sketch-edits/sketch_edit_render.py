"""A static picture of a skeleton scene, Excalidraw-like enough for a model's eye (the eval's "outline+png" form)."""

from __future__ import annotations

import math
from pathlib import Path

from sketch_edit_lib import CONNECTORS
from sketch_edit_lib import SHAPES
from sketch_edit_lib import bbox
from sketch_edit_lib import by_id
from sketch_edit_lib import centre
from sketch_edit_lib import label_of

INK = "#1e1e1e"
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"


class _Canvas:
    def __init__(self, scene: dict, scale: float):
        from PIL import Image
        from PIL import ImageDraw

        self.els = scene["elements"]
        self.ids = by_id(self.els)
        boxes = [b for b in (bbox(e, self.ids) for e in self.els) if b]
        self.x0, self.y0 = min(b[0] for b in boxes) - 40, min(b[1] for b in boxes) - 40
        x1, y1 = max(b[2] for b in boxes) + 40, max(b[3] for b in boxes) + 40
        self.scale = scale
        self.img = Image.new("RGB", (int((x1 - self.x0) * scale), int((y1 - self.y0) * scale)), "white")
        self.d = ImageDraw.Draw(self.img)

    def p(self, x, y):
        return ((x - self.x0) * self.scale, (y - self.y0) * self.scale)

    def font(self, size):
        from PIL import ImageFont

        return ImageFont.truetype(FONT, int(size * self.scale * 0.8))

    def segment(self, a, b, dashed: bool, dash: float = 8) -> None:
        if not dashed:
            self.d.line([a, b], fill=INK, width=2)
            return
        n = max(1, int(math.dist(a, b) // dash))
        for k in range(0, n, 2):
            s, t = k / n, min(1, (k + 1) / n)
            ends = [(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f) for f in (s, t)]
            self.d.line(ends, fill=INK, width=2)

    def poly(self, points, dashed: bool) -> None:
        for a, b in zip(points, points[1:]):
            self.segment(a, b, dashed)

    def frame(self, e: dict) -> None:
        b = bbox(e, self.ids)
        if b:
            corners = [(b[0], b[1]), (b[2], b[1]), (b[2], b[3]), (b[0], b[3]), (b[0], b[1])]
            self.poly([self.p(*c) for c in corners], True)
            self.d.text(self.p(b[0], b[1] - 22), e.get("name") or "", fill="#555", font=self.font(16))

    def shape(self, e: dict) -> None:
        b = bbox(e, self.ids)
        fill = e.get("backgroundColor") if e.get("backgroundColor") not in (None, "transparent") else None
        rect = [self.p(b[0], b[1]), self.p(b[2], b[3])]
        if e["type"] == "rectangle":
            self.d.rectangle(rect, outline=INK, fill=fill, width=2)
        elif e["type"] == "ellipse":
            self.d.ellipse(rect, outline=INK, fill=fill, width=2)
        else:
            cx, cy = centre(b)
            diamond = [self.p(cx, b[1]), self.p(b[2], cy), self.p(cx, b[3]), self.p(b[0], cy)]
            self.d.polygon(diamond, outline=INK, fill=fill)
        if e.get("strokeStyle") == "dashed":
            self.d.rectangle([self.p(b[0] - 4, b[1] - 4), self.p(b[2] + 4, b[3] + 4)], outline="#c92a2a", width=1)
        if label_of(e):
            at = self.p(*centre(b))
            self.d.multiline_text(at, label_of(e), fill=INK, font=self.font(20), anchor="mm", align="center")

    def connector(self, e: dict) -> None:
        pts = [self.p(e["x"] + q[0], e["y"] + q[1]) for q in (e.get("points") or [[0, 0], [100, 0]])]
        self.poly(pts, e.get("strokeStyle") == "dashed")
        if e["type"] == "arrow" and e.get("endArrowhead", "arrow") is not None and len(pts) >= 2:
            (ax, ay), (bx, by) = pts[-2], pts[-1]
            ang = math.atan2(by - ay, bx - ax)
            for s in (-0.45, 0.45):
                self.d.line([(bx, by), (bx - 14 * math.cos(ang + s), by - 14 * math.sin(ang + s))], fill=INK, width=2)
        if (e.get("label") or {}).get("text"):
            mid = len(pts) // 2 - 1
            mx, my = pts[mid] if len(pts) > 2 else ((pts[0][0] + pts[-1][0]) / 2, (pts[0][1] + pts[-1][1]) / 2)
            self.d.text((mx, my - 12), e["label"]["text"], fill=INK, font=self.font(16), anchor="mm")


def render_png(scene: dict, path: Path, scale: float = 1.0) -> None:
    canvas = _Canvas(scene, scale)
    for e in canvas.els:
        if e["type"] == "frame":
            canvas.frame(e)
    for e in canvas.els:
        if e["type"] in SHAPES:
            canvas.shape(e)
        elif e["type"] == "text":
            at, size = canvas.p(e["x"], e["y"]), e.get("fontSize", 20)
            canvas.d.multiline_text(at, e["text"], fill=INK, font=canvas.font(size))
        elif e["type"] in CONNECTORS:
            canvas.connector(e)
    canvas.img.save(path)
