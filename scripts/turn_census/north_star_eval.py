"""The north-star set: the exemplars of ``docs/architecture/north-star-answers.md`` as rows a run checks.

``suite.py --set north-star`` runs ``tests/fixtures/north_star/north_star_questions.yaml``. Every row is a
row of the office-file set (``files_eval.py``) or of the visual set (``visual_eval.py``), asked in that
set's fixture project, so a run reuses their machinery whole: the row's ``set`` is its ``fixture``, which
is what ``suite.observe`` dispatches the checks on, and the suite runs the files rows behind the files
fixture BFF, then the visual rows behind the visual one.

What this module adds is what the exemplars need beyond those sets:

- ``scene``, ``capability`` and ``maps_to``: which part of the star a row serves, and which pf-/pv- rows
  it extends;
- ``needs`` also names an ability of the harness (``HARNESS``): a turn with a drawn box and a turn sent
  from the canvas (``turn_input.py``), a proposal the fixture BFF files (``fixture_bff.py``). A row whose
  needs the harness lacks (an upload, a second project) is "not applicable on this commit", as in the
  files set, so the baseline is honest about what was not asked;
- ``horizon``: a scene of the next horizon (noticing, learning the office). Its row is listed and never
  run; it holds the check the scene will be held to.
"""

from __future__ import annotations

import re
import statistics
from pathlib import Path
from typing import Any

import fixture_bff
import turn_input
from files_eval import NEEDS
from files_eval import available_needs
from files_eval import moves
from fixture_bff import ROOT
from render_fixture_drawings import load_spec
from visual_eval import _elements
from visual_eval import _row_cells
from visual_eval import looks_of
from visual_eval import parity_available
from visual_eval import resolve_gold
from workspace_eval import load_questions as load_rows

QUESTIONS = ROOT / "tests" / "fixtures" / "north_star" / "north_star_questions.yaml"
DOC = ROOT / "docs" / "architecture" / "north-star-answers.md"
#: The fixture projects a row may be asked in, in the order the suite runs them.
FIXTURES = ("files", "visual")
SCENES = frozenset({1, 2, 3, 4, 5, 6, 7, "restraint"})
#: The keys a row may hold beyond ``id``, ``question`` / ``turns`` and ``expect``.
ROW_KEYS = frozenset(
    {"id", "question", "turns", "expect", "scene", "capability", "fixture", "maps_to", "needs", "horizon"}
    | {"box", "gold", "region", "trigger", "focus_document"}
)
#: What a row may need from the harness, beyond a tool argument (``files_eval.NEEDS``): what the ability is.
#: ``harness_available`` says which of them the harness has; the others wait.
HARNESS: dict[str, str] = {
    "given_box": "a turn that carries a drawn box (`turn_input.py`; `visual_eval` refuses `box: given`)",
    "canvas": "a turn sent from the canvas with a document open (`turn_input.py`)",
    "proposals": "the fixture BFF filing a proposal (POST /api/internal/proposals, `fixture_bff.py`)",
    "trigger": "a turn an upload starts: `trigger: new_document` and the open document (`turn_input.py`)",
    "marks": "the fixture BFF recording the marks a turn proposes (`fixture_bff.py`, document-annotations)",
    "upload": "a turn an upload starts through the real upload path (not fixture-driven)",
    "second_project": "a second project of the same fixture office",
}
_EXEMPLAR = re.compile(r"^### (ns-[a-z0-9-]+)\s*$", re.MULTILINE)


# --- the rows --------------------------------------------------------------------


def _region_ok(value: Any) -> bool:
    try:
        x, y, w, h = (float(part) for part in value)
    except TypeError, ValueError:
        return False
    return 0 <= x and 0 <= y and w > 0 and h > 0 and x + w <= 1 and y + h <= 1


def _filled(row: dict[str, Any]) -> str:
    """The row's question; for an upload row, the instruction with its document named (``checkInstruction``)."""
    question = str(row["question"])
    if not row.get("trigger"):
        return question
    fields = turn_input.trigger_fields(row)
    return question.replace("${document.name}", fields["focus_file_name"]).replace(
        "${document.id}", fields["focus_document_id"]
    )


def _checked(row: dict[str, Any], elements: dict[tuple[str, int, str], list[float]]) -> dict[str, Any]:
    """One row, validated, with ``set`` its fixture and the gold resolved to boxes for a visual row."""
    rid = str(row.get("id"))
    if row.get("fixture") not in FIXTURES:
        raise ValueError(f"{rid}: fixture must be one of {', '.join(FIXTURES)}")
    if unknown := set(row) - ROW_KEYS:
        raise ValueError(f"{rid}: unknown keys {sorted(unknown)}")
    if unknown := set(row.get("needs") or []) - set(NEEDS) - set(HARNESS):
        raise ValueError(f"{rid}: unknown needs {sorted(unknown)}")
    if row["fixture"] == "files" and (row.get("gold") or row.get("box") or row.get("region")):
        raise ValueError(f"{rid}: gold, box and region are for a visual row")
    if row.get("box") == "given" and ("given_box" not in (row.get("needs") or []) or not _region_ok(row.get("region"))):
        raise ValueError(f"{rid}: box: given needs `needs: [given_box]` and a region inside the page")
    if row.get("trigger") and row["fixture"] != "files":
        raise ValueError(f"{rid}: trigger is for a files row")
    gold = resolve_gold(row, elements) if row["fixture"] == "visual" else []
    return {**row, "set": row["fixture"], "north_star": True, "gold": gold, "question": _filled(row)}


def load_questions(path: Path = QUESTIONS, spec: dict[str, Any] | None = None) -> list[dict]:
    """The set's rows: ``question`` the last turn, ``set`` the fixture, ``gold`` resolved to boxes."""
    elements = _elements(spec or load_spec())
    return [_checked(row, elements) for row in load_rows(path)]


def harness_available() -> set[str]:
    """The harness abilities this commit has: what the fixture BFF files and what a turn can carry."""
    return (set(fixture_bff.ABILITIES) | set(turn_input.ABILITIES)) & set(HARNESS)


def available() -> set[str]:
    """Everything a row may need that this commit offers: tool arguments and harness abilities."""
    return available_needs() | harness_available()


def split(rows: list[dict], offered: set[str] | None = None) -> tuple[list[dict], list[str], list[str]]:
    """The rows to run, the ids not applicable on this commit (with what they need), and the horizon ids."""
    offered = available() if offered is None else offered
    runnable, waiting, horizon = [], [], []
    for row in rows:
        missing = sorted(set(row.get("needs") or []) - offered)
        if row.get("horizon"):
            horizon.append(str(row["id"]))
        elif missing:
            waiting.append(f"{row['id']} ({', '.join(missing)})")
        else:
            runnable.append(row)
    return runnable, waiting, horizon


def by_fixture(rows: list[dict]) -> dict[str, list[dict]]:
    """The rows grouped by fixture project, in the order the suite starts their BFFs; empty groups left out."""
    return {name: group for name in FIXTURES if (group := [row for row in rows if row["fixture"] == name])}


# --- the document ----------------------------------------------------------------


def doc_exemplars(path: Path = DOC) -> dict[str, bool]:
    """Each exemplar id of the document, and whether its section marks it as horizon."""
    text = path.read_text(encoding="utf-8")
    found = {}
    heads = list(_EXEMPLAR.finditer(text))
    for index, head in enumerate(heads):
        end = heads[index + 1].start() if index + 1 < len(heads) else len(text)
        found[head.group(1)] = "**Horizon.**" in text[head.end() : end]
    return found


# --- the report ------------------------------------------------------------------


def report_lines(runs: list[Any], meta: dict[str, Any] | None = None) -> list[str]:
    """Per row: did it hold, in how many rounds, with which moves, how many looks and where."""
    meta = meta or {}
    ok = [run for run in runs if not run.error]
    head = ["## North star (docs/architecture/north-star-answers.md)", ""]
    tail = []
    if meta.get("not_applicable"):
        tail += ["", f"Not applicable on this commit: {', '.join(meta['not_applicable'])}."]
    if meta.get("horizon"):
        tail += ["", f"Horizon, not run: {', '.join(meta['horizon'])}."]
    if not ok:
        return [*head, "No run finished.", *tail, ""]
    rows = {row["id"]: row for row in load_questions()}
    parity = parity_available()
    held = [all(run.checks.values()) for run in ok if run.checks]
    lines = [
        *head,
        f"- runs where every check held: {sum(held)}/{len(held)} ({sum(held) / max(1, len(held)):.0%})",
        "",
        "| row | scene | fixture | passed | rounds | moves | looks | IoU | covered | card | seconds |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    median = statistics.median
    for question_id in dict.fromkeys(run.question_id for run in ok):
        mine = [run for run in ok if run.question_id == question_id]
        row = rows.get(question_id, {})
        passed = sum(all(r.checks.values()) for r in mine if r.checks)
        scene = ",".join(str(s) for s in row.get("scene") or [])
        if row.get("fixture") == "visual":
            looks, best, covered, card = _row_cells(mine, row.get("gold") or [], parity)
        else:
            looks = f"{median([len(looks_of(r.tool_args)) for r in mine]):g}"
            best, covered, card = "-", "-", "-"
        made = " / ".join(sorted({moves(r.tool_args) for r in mine}))
        lines.append(
            f"| {question_id} | {scene} | {row.get('fixture', '')} | {passed}/{len(mine)} | "
            f"{median([r.research_calls for r in mine]):g} | {made} | "
            f"{looks} | {best} | {covered} | {card} | {median([r.wall_s for r in mine]):g} |"
        )
    return [*lines, *tail, ""]
