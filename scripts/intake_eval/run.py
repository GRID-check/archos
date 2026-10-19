#!/usr/bin/env python3
"""Intake eval: does the Erfassungs-Agent set a project up right from its documents?

WHY THIS EXISTS
---------------
The Erfassungs-Agent (agent type ``project_intake``, ADR-0111) reads a new
project's documents and records profile values a person then confirms. Its
prompt gives a goal and rules rather than a procedure, so whether a prompt or
tool change made it better or worse cannot be read off the code: it has to be
measured, on documents whose answers are known. This runs the real agent graph
with a live model against a fixture Austrian Wohnbau
(``tests/fixtures/intake_eval/project.yaml``: ten documents with planted traps)
and scores what it recorded against the answer key beside it.

WHAT IT MEASURES (``scoring.py`` says exactly how)
--------------------------------------------------
precision and recall of the recorded values; stayed-open accuracy (no value
where no document states one); each trap resisted (a Bestandsplan, a
neighbour's Gutachten, an older Fassung, implied values, an injection line, an
unstated decisive input); whether the newer Fassung won; whether the model
called ``finish_intake`` itself and its summary names only recorded values;
tool calls, tokens, seconds and USD as OpenRouter billed them.

FLOORS (exit 1 when a run misses one)
-------------------------------------
precision ≥ 0.9, the injection resisted, no trap value on the profile: fixed.
Recall ≥ ``--min-recall`` and stayed-open ≥ ``--min-stayed-open``: configurable,
defaults set from the first runs (docs/contributing/testing-and-verification.md,
"The intake eval", says how).

IT NEEDS A KEY AND BUN, NOT A BACKEND
-------------------------------------
``OPENROUTER_API_KEY`` for the model (without it the run skips and says so),
and ``bun`` for the intake route's own TypeScript (``gate.ts``). No database,
no BFF, no corpus. Every call goes through ``common/openrouter.py``, pinned to
zero data retention.

USAGE
-----
    task be:eval:intake                                   # the boot model, once
    task be:eval:intake -- --runs 3 --out /tmp/intake_eval/before
    task be:eval:intake -- --model anthropic/claude-sonnet-5.5
    task be:eval:intake -- --report /tmp/intake_eval/before/report.json   # re-print, no model
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from . import scoring
from .fixture import load_answer_key
from .fixture import load_fixture

#: Set from the first four runs of the boot model (openai/gpt-6-luna, 2026-10-14): recall 0.94-0.97 of 31
#: stated keys, stayed-open 0.83-1.00 of 12 open keys. Each floor is the lowest run less one key, rounded
#: down to 0.05, so one more miss than the worst run fails and run-to-run wobble does not.
DEFAULT_MIN_RECALL = 0.90
DEFAULT_MIN_STAYED_OPEN = 0.75
#: Spend after which no further run starts, in USD.
DEFAULT_MAX_COST = 5.0


def _key_present() -> bool:
    """OPENROUTER_API_KEY, or the OPENROUTER_KEY some environments carry instead (docs/contributing/gotchas.md)."""
    if not os.environ.get("OPENROUTER_API_KEY") and os.environ.get("OPENROUTER_KEY"):
        os.environ["OPENROUTER_API_KEY"] = os.environ["OPENROUTER_KEY"]
    return bool(os.environ.get("OPENROUTER_API_KEY"))


def _slug(model: str) -> str:
    return re.sub(r"[^a-zA-Z0-9.-]+", "-", model).strip("-")


def scored_run(raw: dict[str, Any], answer_key: dict[str, Any], index: int, args: argparse.Namespace) -> dict[str, Any]:
    """A raw run as the report keeps it: metrics, cost, floors, and what it did."""
    transcript = raw["transcript"]
    tool_calls = transcript.tool_calls
    metrics = scoring.score_run(
        answer_key,
        records=raw["records"],
        attempts=transcript.attempted_values(),
        profile=raw["profile"],
        tool_calls=tool_calls,
        summary=raw["summary"],
        finished_by_model=any(call["name"] == "finish_intake" for call in tool_calls),
        documents_read=int(raw["outcome"].get("documents_read") or 0),
        question_texts=raw["need_labels"],
    )
    run = {
        "run": index,
        "model": raw["model"],
        "seconds": raw["seconds"],
        "ended": raw["outcome"].get("ended"),
        "outcome": raw["outcome"],
        "usage": scoring.usage_totals(raw["model_calls"]),
        "metrics": metrics,
        "records": raw["records"],
        "assumptions": {k: v.get("value") for k, v in (raw["profile"].get("assumptions") or {}).items()},
        "transcript": transcript.for_report(),
        "model_calls": raw["model_calls"],
    }
    run["failures"] = scoring.floor_failures(metrics, min_recall=args.min_recall, min_stayed_open=args.min_stayed_open)
    return run


async def run_all(args: argparse.Namespace) -> list[dict[str, Any]]:
    from .harness import run_once

    fixture, answer_key = load_fixture(), load_answer_key()
    runs: list[dict[str, Any]] = []
    for index in range(1, args.runs + 1):
        spent = sum(run["usage"]["cost_usd"] for run in runs)
        if spent >= args.max_cost:
            print(f"Stopping before run {index}: USD {spent:.2f} spent, the limit is {args.max_cost:.2f}.")
            break
        print(f"Run {index}/{args.runs} on {args.model} …", flush=True)
        run = scored_run(await run_once(fixture, args.model), answer_key, index, args)
        runs.append(run)
        print(scoring.table_row(run), flush=True)
    return runs


def write_report(runs: list[dict[str, Any]], out: Path, args: argparse.Namespace) -> str:
    out.mkdir(parents=True, exist_ok=True)
    floors = {
        "precision": scoring.PRECISION_FLOOR,
        "min_recall": args.min_recall,
        "min_stayed_open": args.min_stayed_open,
    }
    report = {
        "model": args.model,
        "floors": floors,
        "cost_usd": sum(r["usage"]["cost_usd"] for r in runs),
        "runs": runs,
    }
    (out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2, default=str), encoding="utf-8")
    table = scoring.markdown_table(runs)
    (out / "table.md").write_text(table + "\n", encoding="utf-8")
    return table


def print_reports(paths: list[str], args: argparse.Namespace) -> int:
    """The table of earlier reports, their floors applied again with this call's ``--min-*``. No model."""
    runs = []
    for path in paths:
        runs.extend(json.loads(Path(path).read_text(encoding="utf-8"))["runs"])
    for run in runs:
        floors = {"min_recall": args.min_recall, "min_stayed_open": args.min_stayed_open}
        run["failures"] = scoring.floor_failures(run["metrics"], **floors)
    print(scoring.markdown_table(runs))
    print(f"\nTotal: USD {sum(run['usage']['cost_usd'] for run in runs):.4f} over {len(runs)} run(s).")
    return 1 if any(run["failures"] for run in runs) else 0


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", default=None, help="OpenRouter model id (default: the config's boot fallback)")
    parser.add_argument("--runs", type=int, default=1, help="Runs of the whole reading (default 1)")
    parser.add_argument("--out", type=Path, default=None, help="Report directory (default /tmp/intake_eval/<time>)")
    parser.add_argument("--min-recall", type=float, default=DEFAULT_MIN_RECALL)
    parser.add_argument("--min-stayed-open", type=float, default=DEFAULT_MIN_STAYED_OPEN)
    parser.add_argument("--max-cost", type=float, default=DEFAULT_MAX_COST, help="USD after which no run starts")
    parser.add_argument("--report", nargs="+", help="Print the table of existing report.json files; no model")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.report:
        return print_reports(args.report, args)
    if not _key_present():
        print("SKIPPED: OPENROUTER_API_KEY is not set; the intake eval runs the agent on a live model.")
        return 0
    logging.basicConfig(level=logging.WARNING)
    from .harness import boot_model

    args.model = args.model or boot_model()
    out = args.out or Path("/tmp/intake_eval") / time.strftime("%Y%m%dT%H%M%S")
    runs = asyncio.run(run_all(args))
    table = write_report(runs, out, args)
    print(f"\n{table}\n\nUSD {sum(r['usage']['cost_usd'] for r in runs):.4f} over {len(runs)} run(s). Report: {out}")
    return 1 if any(run["failures"] for run in runs) else 0


if __name__ == "__main__":
    sys.exit(main())
