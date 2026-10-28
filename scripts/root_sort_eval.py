#!/usr/bin/env python3
"""Root-sort eval: how often a "sure" placement is right, and where the sure cut belongs.

WHY THIS EXISTS
---------------
A person sorting a shelf's root asks the filing judgement (``POST /v1/filing-fit``,
``purpose: sort``) to place every loose document into a folder. Each placement carries
Jev's probability for its folder; the dialog reads it as "sure" at ``SURE_CONFIDENCE``
(``apps/workspace/bff/filing/root-sort-types.ts``) and as "unsure" below. That cut was
never measured. This script measures it on a labelled synthetic shelf: an Austrian
architecture office's project root (``tests/fixtures/root_sort/austrian_office_root.json``).

WHAT IT MEASURES
----------------
* Placement precision (proposed == label), coverage (placeable documents that got a
  proposal), the wrong-folder rate (placeable, proposed elsewhere) and the false
  placements (a document no folder fits, given one).
* For each cut: the precision of the "sure" placements, and how many correct placements
  the cut leaves "unsure". Unscored placements (no confidence) are never sure.
* Folder proposals (``POST /v1/folder-proposals``) over the documents labelled "": how many
  were grouped, and each group's purity by the theme a person would give it.

The sort runs in chunks of ``CHUNK`` documents, the production ``ROOT_SORT_CHUNK``
(half of ``MAX_JUDGED_DOCUMENTS`` in ``apps/workspace/bff/filing/types.ts``), and each
chunk's seconds are reported with the grouping's. No conventions are sent, so a placement
is always into an existing folder of the shelf.

USAGE
-----
    cd apps/backend && ../../.venv/bin/python -I ../../scripts/root_sort_eval.py
    ... --out /some/where.json        (default: tests/fixtures/root_sort/eval_<date>.json)

IT NEEDS A KEY, NOT A BACKEND
-----------------------------
``OPENROUTER_API_KEY`` (or ``DECISIONS_API_KEY``). The routes run in-process through
FastAPI's TestClient, so the only network call is the model's. A failed call stops the
run: a partial run is not a measurement, so no report is written.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from collections import Counter
from datetime import date
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = REPO_ROOT / "tests" / "fixtures" / "root_sort" / "austrian_office_root.json"
sys.path.insert(0, str(REPO_ROOT / "src"))
sys.path.insert(0, str(REPO_ROOT / "apps" / "backend" / "src"))

CHUNK = 30
REQUESTED_CUTS = (0.4, 0.5, 0.6, 0.7, 0.8)
SCAN_CUTS = tuple(round(0.30 + 0.05 * step, 2) for step in range(13))
TARGET_PRECISION = 0.95
SURE_CONFIDENCE_NOW = 0.6
MIN_SURE_FOR_RECOMMENDATION = 20
PROJECT_ID = "root-sort-eval"


class EvalUnreachable(RuntimeError):
    """The model did not answer; the run measured nothing."""


def load_fixture(path: Path = FIXTURE) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def check_fixture(fixture: dict[str, Any]) -> list[str]:
    """Structural problems in the fixture; an empty list means it is usable."""
    paths = {folder["path"] for folder in fixture["folders"]}
    problems = [f"unknown label {d['label']!r}" for d in fixture["documents"] if d["label"] and d["label"] not in paths]
    files = Counter(d["file"] for d in fixture["documents"])
    problems += [f"duplicate file {name!r}" for name, count in files.items() if count > 1]
    problems += [
        f"no-fit document {d['file']!r} without a theme"
        for d in fixture["documents"]
        if not d["label"] and not d.get("theme")
    ]
    return problems


def indexed_documents(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    """The fixture's documents with stable ids (r001, r002, …) and the labels kept apart from the input."""
    return [
        {
            "id": f"r{index:03d}",
            "file": doc["file"],
            "type": doc.get("type"),
            "summary": doc["summary"],
            "label": doc["label"],
            "ambiguous": bool(doc.get("ambiguous", False)),
            "theme": doc.get("theme"),
        }
        for index, doc in enumerate(fixture["documents"], start=1)
    ]


def folders_payload(fixture: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"path": folder["path"], "description": folder.get("description"), "doc_types": folder.get("doc_types", [])}
        for folder in fixture["folders"]
    ]


def build_client() -> Any:
    """The live routes on an in-process app: the same handlers the BFF reaches over HTTP."""
    from fastapi import APIRouter
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from aiq_api.routes.filing_fit import add_filing_fit_routes
    from aiq_api.routes.folder_proposals import add_folder_proposals_routes

    router = APIRouter()
    add_filing_fit_routes(router)
    add_folder_proposals_routes(router)
    app = FastAPI()
    app.include_router(router)
    return TestClient(app)


def _trace(batch_id: str) -> dict[str, str]:
    return {"batch_id": batch_id, "project_id": PROJECT_ID, "shelf": "project"}


def _sort_rows(chunk: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """What ingestion sends a root document: its name, Dokumentart and summary. Never its label."""
    return [
        {"id": doc["id"], "file": doc["file"], "folder": "", "type": doc["type"], "summary": doc["summary"]}
        for doc in chunk
    ]


def judge_chunk(client: Any, folders: list[dict[str, Any]], chunk: list[dict[str, Any]], index: int) -> dict[str, Any]:
    """One filing judgement with the sort purpose; returns the whole answer."""
    body = {
        "basis": "content",
        "purpose": "sort",
        "folders": folders,
        "documents": _sort_rows(chunk),
        "trace": _trace(f"root-sort-eval-{index}"),
    }
    response = client.post("/v1/filing-fit", json=body)
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise EvalUnreachable(f"chunk {index}: {data['error']}")
    return data


def judge_all(
    client: Any, folders: list[dict[str, Any]], documents: list[dict[str, Any]]
) -> tuple[dict[str, Any], str | None, list[float]]:
    """Every document's proposed move (id → move), the model that answered, and each chunk's seconds."""
    moves: dict[str, Any] = {}
    model: str | None = None
    seconds: list[float] = []
    for index, start in enumerate(range(0, len(documents), CHUNK)):
        started = time.perf_counter()
        data = judge_chunk(client, folders, documents[start : start + CHUNK], index)
        seconds.append(round(time.perf_counter() - started, 1))
        model = model or data.get("model")
        moves.update({move["id"]: move for move in data["moves"]})
    return moves, model, seconds


def score_records(documents: list[dict[str, Any]], moves: dict[str, Any]) -> list[dict[str, Any]]:
    """One row per document: what was proposed, the confidence, and the label it is checked against."""
    rows = []
    for doc in documents:
        move = moves.get(doc["id"])
        rows.append(
            {
                "id": doc["id"],
                "file": doc["file"],
                "label": doc["label"],
                "ambiguous": doc["ambiguous"],
                "proposed": move["folder"] if move else None,
                "confidence": move.get("confidence") if move else None,
                "reason": move.get("reason") if move else None,
            }
        )
    return rows


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 3) if denominator else None


def placement_metrics(rows: list[dict[str, Any]]) -> dict[str, Any]:
    placeable = [row for row in rows if row["label"]]
    proposed = [row for row in rows if row["proposed"] is not None]
    correct = [row for row in proposed if row["proposed"] == row["label"]]
    covered = [row for row in placeable if row["proposed"] is not None]
    wrong_folder = [row for row in covered if row["proposed"] != row["label"]]
    false_placement = [row for row in proposed if not row["label"]]
    return {
        "documents": len(rows),
        "placeable": len(placeable),
        "no_fit": len(rows) - len(placeable),
        "proposals": len(proposed),
        "correct": len(correct),
        "scored": sum(1 for row in proposed if row["confidence"] is not None),
        "placement_precision": _ratio(len(correct), len(proposed)),
        "coverage": _ratio(len(covered), len(placeable)),
        "wrong_folder": len(wrong_folder),
        "wrong_folder_rate": _ratio(len(wrong_folder), len(covered)),
        "false_placement": len(false_placement),
        "false_placement_rate": _ratio(len(false_placement), len(rows) - len(placeable)),
    }


def cut_metrics(rows: list[dict[str, Any]], cut: float) -> dict[str, Any]:
    """What a "sure" cut at ``cut`` would show: its precision and the correct placements it leaves unsure."""
    proposed = [row for row in rows if row["proposed"] is not None]
    correct = [row for row in proposed if row["proposed"] == row["label"]]
    sure = [row for row in proposed if row["confidence"] is not None and row["confidence"] >= cut]
    sure_correct = [row for row in sure if row["proposed"] == row["label"]]
    return {
        "cut": cut,
        "sure": len(sure),
        "sure_correct": len(sure_correct),
        "sure_precision": _ratio(len(sure_correct), len(sure)),
        "correct_left_unsure": len(correct) - len(sure_correct),
        "correct_left_unsure_share": _ratio(len(correct) - len(sure_correct), len(correct)),
        "unsure": len(proposed) - len(sure),
    }


def recommend(cuts: list[dict[str, Any]]) -> dict[str, Any]:
    """The lowest scanned cut whose sure precision reaches the target, with enough sure placements to trust it."""
    for metrics in sorted(cuts, key=lambda item: item["cut"]):
        if metrics["sure"] >= MIN_SURE_FOR_RECOMMENDATION and (metrics["sure_precision"] or 0) >= TARGET_PRECISION:
            return {"cut": metrics["cut"], "metrics": metrics, "found": True}
    return {"cut": None, "metrics": None, "found": False}


def run_grouping(client: Any, folders: list[dict[str, Any]], leftovers: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Folder proposals for the documents no folder fits; returns the proposals as the route answered them."""
    body = {
        "locale": "de",
        "folders": folders,
        "documents": [
            {"id": doc["id"], "file": doc["file"], "type": doc["type"], "tags": [], "summary": doc["summary"]}
            for doc in leftovers
        ],
        "trace": _trace("root-sort-eval-groups"),
    }
    response = client.post("/v1/folder-proposals", json=body)
    response.raise_for_status()
    data = response.json()
    if data.get("error"):
        raise EvalUnreachable(f"folder proposals: {data['error']}")
    return data["proposals"]


def group_report(proposals: list[dict[str, Any]], leftovers: list[dict[str, Any]]) -> dict[str, Any]:
    """Each proposed group with its files, the themes it mixes, and its purity (share in the dominant theme)."""
    theme_of = {doc["id"]: doc["theme"] for doc in leftovers}
    file_of = {doc["id"]: doc["file"] for doc in leftovers}
    groups = []
    for proposal in proposals:
        themes = Counter(theme_of[doc_id] for doc_id in proposal["ids"] if doc_id in theme_of)
        dominant = themes.most_common(1)[0][1] if themes else 0
        groups.append(
            {
                "path": proposal["path"],
                "description": proposal.get("description"),
                "documents": len(proposal["ids"]),
                "files": [file_of[doc_id] for doc_id in proposal["ids"] if doc_id in file_of],
                "themes": dict(themes),
                "purity": _ratio(dominant, len(proposal["ids"])),
                "confidences": proposal.get("confidences", {}),
            }
        )
    grouped = {doc_id for proposal in proposals for doc_id in proposal["ids"] if doc_id in theme_of}
    return {
        "leftover": len(leftovers),
        "grouped": len(grouped),
        "grouped_share": _ratio(len(grouped), len(leftovers)),
        "groups": groups,
    }


def run_eval(fixture: dict[str, Any]) -> dict[str, Any]:
    client = build_client()
    folders = folders_payload(fixture)
    documents = indexed_documents(fixture)
    moves, model, chunk_seconds = judge_all(client, folders, documents)
    rows = score_records(documents, moves)
    leftovers = [doc for doc in documents if not doc["label"]]
    started = time.perf_counter()
    proposals = run_grouping(client, folders, leftovers)
    grouping_seconds = round(time.perf_counter() - started, 1)
    cuts = [cut_metrics(rows, cut) for cut in sorted(set(REQUESTED_CUTS) | set(SCAN_CUTS))]
    return {
        "date": date.today().isoformat(),
        "model": model,
        "chunk": CHUNK,
        "sure_confidence_now": SURE_CONFIDENCE_NOW,
        "target_precision": TARGET_PRECISION,
        "placement": placement_metrics(rows),
        "cuts": cuts,
        "recommendation": recommend(cuts),
        "grouping": group_report(proposals, leftovers),
        "seconds": {"chunks": chunk_seconds, "grouping": grouping_seconds},
        "documents": rows,
    }


def _cut_line(metrics: dict[str, Any]) -> str:
    marker = " (now)" if metrics["cut"] == SURE_CONFIDENCE_NOW else ""
    return (
        f"| {metrics['cut']}{marker} | {metrics['sure']} | {metrics['sure_precision']} "
        f"| {metrics['correct_left_unsure']} ({metrics['correct_left_unsure_share']}) |"
    )


def _recommendation_line(report: dict[str, Any]) -> str:
    recommended = report["recommendation"]
    if not recommended["found"]:
        return (
            f"No scanned cut reaches sure precision {TARGET_PRECISION} "
            f"with {MIN_SURE_FOR_RECOMMENDATION}+ sure placements."
        )
    metrics = recommended["metrics"]
    return (
        f"Recommended cut: {recommended['cut']} (sure precision {metrics['sure_precision']} over "
        f"{metrics['sure']} sure placements, {metrics['correct_left_unsure']} correct left unsure)."
    )


def _group_lines(grouping: dict[str, Any]) -> list[str]:
    lines = [f"Grouped {grouping['grouped']} of {grouping['leftover']} leftovers ({grouping['grouped_share']})."]
    for group in grouping["groups"]:
        lines.append(
            f"- {group['path']} ({group['documents']} docs, purity {group['purity']}, themes {group['themes']})"
        )
        lines += [f"    {name}" for name in group["files"]]
    return lines


def markdown_summary(report: dict[str, Any]) -> str:
    placement = report["placement"]
    lines = [
        f"# Root sort eval, {report['date']} ({report['model']}, chunks of {report['chunk']})",
        "",
        f"Documents {placement['documents']}: placeable {placement['placeable']}, no fit {placement['no_fit']}. "
        f"Proposals {placement['proposals']} ({placement['scored']} scored), correct {placement['correct']}.",
        "",
        "| metric | value |",
        "|---|---|",
        f"| placement precision | {placement['placement_precision']} |",
        f"| coverage (placeable with a proposal) | {placement['coverage']} |",
        "| wrong-folder rate (placeable, proposed elsewhere) "
        f"| {placement['wrong_folder_rate']} ({placement['wrong_folder']}) |",
        "| false placements (no-fit document given a folder) "
        f"| {placement['false_placement']} ({placement['false_placement_rate']}) |",
        "",
        "| cut | sure | sure precision | correct left unsure |",
        "|---|---|---|---|",
    ]
    lines += [_cut_line(item) for item in report["cuts"] if item["cut"] in REQUESTED_CUTS]
    lines += [
        "",
        _recommendation_line(report),
        "",
        f"Seconds per chunk of {report['chunk']}: {report['seconds']['chunks']}; "
        f"grouping: {report['seconds']['grouping']}.",
        "",
        "## Grouping of the no-fit documents",
        *_group_lines(report["grouping"]),
    ]
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=FIXTURE.parent / f"eval_{date.today().isoformat()}.json")
    args = parser.parse_args(argv)
    if not (os.environ.get("OPENROUTER_API_KEY") or os.environ.get("DECISIONS_API_KEY")):
        print("root_sort_eval: set OPENROUTER_API_KEY (or DECISIONS_API_KEY); nothing to measure.")
        return 2
    fixture = load_fixture()
    problems = check_fixture(fixture)
    if problems:
        print("root_sort_eval: fixture problems:\n  " + "\n  ".join(problems))
        return 2
    try:
        report = run_eval(fixture)
    except EvalUnreachable as exc:
        print(f"root_sort_eval: the model did not answer ({exc}). Nothing measured; no report written.")
        return 1
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(markdown_summary(report))
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
