#!/usr/bin/env python3
"""Decision eval for reading a page image: Jev 1.14's image input as an ingest page reader.

WHY THIS EXISTS
---------------
Every drawing page an upload carries costs one generative vision call today
(``adapter._analyze_drawing_page_with_vlm``): about 25 s for a multi-view sheet,
56 s when the reply runs past its budget and is asked again, and it holds one of
the fleet's ``AIQ_VLM_FLEET_CONCURRENCY`` slots the whole time, so it is also what
every other office's upload waits behind. Jev 1.14 (TypeSafe, on OpenRouter's
Decisions endpoint) reads images: a ``choice`` says what a page is, a ``box`` says
where something is on it, in about half a second for about $0.0002 a page.

That is the shape of the page map the ingestion north star starts from
(``docs/roadmap/ingestion-north-star.md``, "One look at every page"): what each
page is, how many views it carries, where its title block and its plan sit, so
the expensive call reads a crop at native resolution instead of the whole sheet,
and a long drawing set is mapped whole instead of being cut at the render cap.
This script is the adoption gate ADR-0064 asks for before any of it is built.

IT IS NOT IN THE PATH
---------------------
Image input is behind TypeSafe's experimental header
(``TypeSafe-Danger-Zone-Images: true``), Box exists only on 1.14, and TypeSafe
does not recommend images for production yet. So the production client
(``aiq_agent.common.decisions``) does not send images, and this script posts to
the endpoint itself. Re-run it on a new Jev release; adopt a use when its floors
hold on the fixtures AND on a set of real sheets (``--sheets``).

WHAT IT MEASURES
----------------
The fixture drawings of the visual eval (``tests/fixtures/visual/drawings.json``,
rendered by ``scripts/turn_census/render_fixture_drawings.py``): every element's
box is where the ink was put, so the gold is exact.

- page kind: every page is a drawing.
- view: the main view is the one the sheet's file name says (Grundriss, Schnitt).
- title block and the drawing: a ``box`` each, scored by IoU and by coverage (the
  share of the gold box the answer holds; a crop that holds the whole title block
  is usable even when it is generous). The drawing's gold is the extent of its
  drawn rooms and doors, the ink; the spec's ``plan_area`` is a nominal frame with
  nothing drawn on it.

``--sheets DIR`` adds every ``*.png``/``*.jpg`` in a directory, ungraded: the
answers are printed for a person to check against the image.

THE FLOORS
----------
Every page a drawing, every view right, title-block coverage at least 0.9 and
IoU at least 0.6 on every page, coverage of the drawing's ink at least 0.8. Exit 0 when they
hold, 1 when they do not, 2 without a key.

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``GRID_DECISIONS_API_KEY``). Four requests, under a
tenth of a cent.

USAGE
-----
    python scripts/decision_eval_vision.py
    python scripts/decision_eval_vision.py --sheets /path/to/real/sheets

THE LAST RUN
------------
2026-10-27, ``typesafe/jev-1.14``, fixtures at 100 dpi scaled to 1568 px: page kind
4/4, view 4/4 (three floor plans, one section), title block IoU 0.88-0.92 and
coverage 1.0 on every page (confidence 0.67-0.76), the drawing's ink covered 1.0 on
every page (IoU 0.52-0.94: the box is generous around a floor plan), 0.5 s and
$0.00021 per page for the four questions. Five public-domain HABS sheets (Library of Congress, ungraded): drawing
5/5, multi-view 5/5 at 0.99, the title-block strip found on all five, the floor
plan placed within a few percent of the page on the sheets checked by eye;
$0.0001 per page at 1024 px.
"""

from __future__ import annotations

import argparse
import base64
import io
import os
import sys
import time
from pathlib import Path
from typing import Any

import httpx

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts" / "turn_census"))

from render_fixture_drawings import load_spec  # noqa: E402
from render_fixture_drawings import render_page  # noqa: E402

MODEL = "typesafe/jev-1.14"
URL = "https://openrouter.ai/api/alpha/decisions"
#: TypeSafe gates image input behind this header while it is experimental.
IMAGE_HEADER = {"TypeSafe-Danger-Zone-Images": "true"}
#: Jev's image bounds: each side 280-1568 px; a larger image is refused, not resized.
MAX_SIDE = 1568
RENDER_DPI = 100

PAGE_KIND = {
    "drawing": "A technical drawing: floor plan, section, elevation, site plan or detail",
    "text": "A page of running text: a letter, a specification, a report",
    "table": "A page that is mostly a table or schedule",
    "photo": "A photograph of a building or site",
    "form": "A filled-in form",
}
VIEWS = {
    "floor_plan": "Floor plan (Grundriss)",
    "section": "Section (Schnitt)",
    "elevation": "Elevation (Ansicht)",
    "site_plan": "Site plan (Lageplan)",
    "detail": "Detail",
    "none": "No drawing",
}
QUESTIONS: dict[str, dict[str, Any]] = {
    "page_kind": {
        "type": "choice",
        "instructions": "What kind of page of an architect's project document is this image?",
        "criteria": PAGE_KIND,
    },
    "view": {
        "type": "choice",
        "instructions": "Which kind of architectural view is the main drawing on this sheet?",
        "criteria": VIEWS,
    },
    "title_block": {
        "type": "box",
        "instructions": (
            "The title block (Plankopf): the framed area with the project name, drawing number, scale, "
            "index or revision and date. Often a box or strip along the right or bottom edge."
        ),
    },
    "plan_area": {
        "type": "box",
        "instructions": "The main drawing itself (the plan or section), without the title block and the legend.",
    },
}

#: The view each fixture file shows, by the word its file name carries.
FIXTURE_VIEW = {"Grundrisse": "floor_plan", "Schnitt": "section"}

FLOOR_TITLE_COVERAGE = 0.9
FLOOR_TITLE_IOU = 0.6
FLOOR_PLAN_COVERAGE = 0.8
#: The element kinds that are the drawing's own ink on a fixture page.
DRAWING_INK = ("room", "door")


def _image_url(image: Any) -> str:
    image = image.convert("L")
    image.thumbnail((MAX_SIDE, MAX_SIDE))
    buffer = io.BytesIO()
    image.save(buffer, "PNG")
    return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode()


def ask(image: Any, key: str) -> tuple[dict[str, Any], float, float | None]:
    """Every question over one page image: the answers, the seconds, the cost in USD."""
    body = {"model": MODEL, "state": [{"type": "image_url", "image_url": {"url": _image_url(image)}}]}
    body["questions"] = QUESTIONS
    started = time.monotonic()
    response = httpx.post(URL, json=body, timeout=60, headers={"Authorization": f"Bearer {key}", **IMAGE_HEADER})
    elapsed = time.monotonic() - started
    response.raise_for_status()
    payload = response.json()
    return payload["answers"], elapsed, (payload.get("usage") or {}).get("cost")


def as_edges(box: list[float]) -> tuple[float, float, float, float]:
    """A spec box ``[x, y, w, h]`` (shares, origin top left) as ``(left, top, right, bottom)``."""
    x, y, w, h = box
    return x, y, x + w, y + h


def answer_edges(answer: dict[str, Any]) -> tuple[float, float, float, float]:
    box = answer["box"]
    return box["left"], box["top"], box["right"], box["bottom"]


def overlap(a: tuple[float, ...], b: tuple[float, ...]) -> float:
    width = min(a[2], b[2]) - max(a[0], b[0])
    height = min(a[3], b[3]) - max(a[1], b[1])
    return max(0.0, width) * max(0.0, height)


def area(edges: tuple[float, ...]) -> float:
    return max(0.0, edges[2] - edges[0]) * max(0.0, edges[3] - edges[1])


def iou(answer: tuple[float, ...], gold: tuple[float, ...]) -> float:
    shared = overlap(answer, gold)
    union = area(answer) + area(gold) - shared
    return shared / union if union else 0.0


def coverage(answer: tuple[float, ...], gold: tuple[float, ...]) -> float:
    return overlap(answer, gold) / area(gold) if area(gold) else 0.0


def gold_box(page: dict[str, Any], *kinds: str) -> tuple[float, float, float, float] | None:
    """The extent of every element of ``kinds`` on the page, as ``(left, top, right, bottom)``."""
    boxes = [as_edges(element["box"]) for element in page["elements"] if element.get("kind") in kinds]
    if not boxes:
        return None
    return min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)


def expected_view(file_name: str) -> str | None:
    return next((view for word, view in FIXTURE_VIEW.items() if word in file_name), None)


def grade_page(answers: dict[str, Any], page: dict[str, Any], file_name: str) -> list[str]:
    """What this page's answers miss of the floors; empty when they hold. Prints the numbers."""
    misses = []
    kind = answers["page_kind"]["choice"]
    view = answers["view"]["choice"]
    if kind != "drawing":
        misses.append(f"page kind {kind}")
    if view != expected_view(file_name):
        misses.append(f"view {view}")
    # The drawing's gold is its ink: the rooms and doors drawn. The spec's ``plan_area``
    # is a nominal frame nothing is drawn on, and a box around ink is tighter than it.
    title, plan = gold_box(page, "title_block"), gold_box(page, *DRAWING_INK)
    title_answer, plan_answer = answer_edges(answers["title_block"]), answer_edges(answers["plan_area"])
    print(
        f"    kind={kind} view={view}"
        f" title iou={iou(title_answer, title):.2f} cover={coverage(title_answer, title):.2f}"
        f" conf={answers['title_block'].get('confidence', 0):.2f}"
        f" plan iou={iou(plan_answer, plan):.2f} cover={coverage(plan_answer, plan):.2f}"
    )
    if coverage(title_answer, title) < FLOOR_TITLE_COVERAGE or iou(title_answer, title) < FLOOR_TITLE_IOU:
        misses.append("title block")
    if coverage(plan_answer, plan) < FLOOR_PLAN_COVERAGE:
        misses.append("plan area")
    return misses


def eval_fixtures(key: str) -> bool:
    spec = load_spec()
    misses: list[str] = []
    for drawing in spec["drawings"]:
        for page in drawing["pages"]:
            answers, seconds, cost = ask(render_page(spec, drawing, page, dpi=RENDER_DPI), key)
            print(f"{drawing['file_name']} p.{page['number']}: {seconds:.2f} s, ${cost}")
            where = f"{drawing['file_name']} p.{page['number']}"
            misses += [f"{where}: {miss}" for miss in grade_page(answers, page, drawing["file_name"])]
    for miss in misses:
        print("MISS", miss)
    return not misses


def show_sheets(directory: Path, key: str) -> None:
    from PIL import Image

    for path in sorted([*directory.glob("*.png"), *directory.glob("*.jpg")]):
        answers, seconds, cost = ask(Image.open(path), key)
        title, plan = answers["title_block"]["box"], answers["plan_area"]["box"]
        print(f"{path.name}: {seconds:.2f} s, ${cost}")
        print(f"    kind={answers['page_kind']['choice']} view={answers['view']['choice']}")
        print(f"    title block {title}  plan {plan}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--sheets", type=Path, help="a directory of real sheet images, answered ungraded")
    args = parser.parse_args()
    key = os.environ.get("GRID_DECISIONS_API_KEY") or os.environ.get("OPENROUTER_API_KEY")
    if not key:
        print("No OPENROUTER_API_KEY / GRID_DECISIONS_API_KEY: nothing to ask.")
        return 2
    held = eval_fixtures(key)
    if args.sheets:
        show_sheets(args.sheets, key)
    print("floors hold" if held else "floors MISSED")
    return 0 if held else 1


if __name__ == "__main__":
    sys.exit(main())
