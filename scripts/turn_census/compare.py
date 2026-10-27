"""What a set of answer-suite runs cost and got right, and how two sets differ: the before/after report.

``suite.py --compare <a> <b>`` reads two runs, each a ``results.json`` or the directory ``--arm all``
writes (one subdirectory per arm), and renders Markdown fit for a PR: per arm, accuracy, rounds, tool
calls, tokens and cost per answer and latency, then the change from ``a`` to ``b``, then the rows whose
outcome moved. ``--arm all`` writes the same table over its three arms (``arms.md``).

Pure: it reads the rows of ``results.json`` as dicts, so it needs no model, no corpus and no suite.

**Accuracy** is the share of finished runs whose ANSWER checks all held: what the reader got (a value
named, a claim left out, a judged meaning, a proposal filed). The process checks (which tool, how many
rounds, an envelope) are left out of it and counted in "all checks": an arm that unbinds a tool fails
that tool's check by construction, and an accuracy that counted it would only restate the arm. A run
with an error has no checks; it is counted under errors, not as a wrong answer.
"""

from __future__ import annotations

import json
import statistics
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

#: Check kinds (the key before its first colon) about how the turn worked, not what it answered.
PROCESS_CHECKS = frozenset({"must", "any", "must_not", "no_repeat", "rounds", "envelope", "looked_up", "no_lookup"})
#: The arm order a report lists them in; any other label sorts after.
ARM_ORDER = ("semantic", "grep", "hybrid")


@dataclass
class Measured:
    """One results.json: its label (the arm, or the set), its meta and its runs as stored."""

    label: str
    meta: dict[str, Any]
    runs: list[dict[str, Any]]
    path: Path


def check_kind(key: str) -> str:
    """``mentions:Index B`` → ``mentions``; ``rounds<=2`` → ``rounds``."""
    return "rounds" if key.startswith("rounds<=") else key.split(":", 1)[0]


def correct(run: dict[str, Any]) -> bool | None:
    """Whether every answer check of the run held; None when it has none (an error, or a process-only row)."""
    answer = [held for key, held in (run.get("checks") or {}).items() if check_kind(key) not in PROCESS_CHECKS]
    return all(answer) if answer and not run.get("error") else None


def _mean(values: list[float]) -> float | None:
    return sum(values) / len(values) if values else None


def totals(runs: Iterable[dict[str, Any]]) -> dict[str, Any]:
    """The numbers a report row shows, over the runs given. Per answer means a mean over finished runs."""
    runs = list(runs)
    ok = [run for run in runs if not run.get("error")]
    graded = [verdict for run in ok if (verdict := correct(run)) is not None]
    checked = [all(run["checks"].values()) for run in ok if run.get("checks")]
    costs = [float(run["cost_usd"]) for run in ok if run.get("cost_usd") is not None]
    return {
        "runs": len(runs),
        "errors": len(runs) - len(ok),
        "graded": len(graded),
        "accuracy": _mean([float(v) for v in graded]),
        "all_checks": _mean([float(v) for v in checked]),
        "rounds": _mean([float(run.get("research_calls") or 0) for run in ok]),
        "tool_calls": _mean([float(len(run.get("tool_calls") or [])) for run in ok]),
        "input_tokens": _mean([float(run.get("input_tokens") or 0) for run in ok]),
        "output_tokens": _mean([float(run.get("output_tokens") or 0) for run in ok]),
        "cost_usd": _mean(costs),
        "cost_missing": sum(int(run.get("cost_missing") or 0) for run in ok) + len(ok) - len(costs),
        "wall_s": statistics.median([float(run.get("wall_s") or 0) for run in ok]) if ok else None,
    }


# --- reading runs ------------------------------------------------------------------


def _label(meta: dict[str, Any], fallback: str) -> str:
    arm = meta.get("arm")
    if arm:
        from files_eval import arm_name

        try:
            return arm_name(arm)
        except ValueError:
            return str(arm)
    return str(meta.get("set") or fallback)


def _read(path: Path) -> Measured:
    data = json.loads(path.read_text(encoding="utf-8"))
    meta = data.get("meta") or {}
    return Measured(_label(meta, path.parent.name), meta, list(data.get("runs") or []), path)


def load(path: Path) -> list[Measured]:
    """The runs at ``path``: a results.json, a directory holding one, or an ``--arm all`` directory of arms."""
    if path.is_file():
        return [_read(path)]
    if (path / "results.json").is_file():
        return [_read(path / "results.json")]
    found = [_read(child / "results.json") for child in sorted(path.iterdir()) if (child / "results.json").is_file()]
    if not found:
        raise FileNotFoundError(f"no results.json at {path} or in a directory under it")
    return sorted(found, key=lambda m: (ARM_ORDER.index(m.label) if m.label in ARM_ORDER else len(ARM_ORDER), m.label))


def pairs(before: list[Measured], after: list[Measured]) -> list[tuple[Measured, Measured]]:
    """Which run of ``after`` compares with which of ``before``: one with one, else arm with arm."""
    if len(before) == 1 and len(after) == 1:
        return [(before[0], after[0])]
    by_label = {m.label: m for m in before}
    return [(by_label[m.label], m) for m in after if m.label in by_label]


# --- rendering ---------------------------------------------------------------------

HEADER = (
    "| Run | Runs | Errors | Accuracy | All checks | Rounds | Tool calls | Input tok/answer "
    "| Output tok/answer | Cost/answer | Wall s (median) |"
)
RULE = "|---|---|---|---|---|---|---|---|---|---|---|"


def _share(value: float | None, graded: int | None = None) -> str:
    if value is None:
        return "–"
    return f"{value:.0%}" + (f" (n={graded})" if graded is not None else "")


def _num(value: float | None, digits: int = 1) -> str:
    return "–" if value is None else f"{value:,.{digits}f}"


def _cost(value: float | None) -> str:
    return "–" if value is None else f"${value:.4f}"


def line(label: str, t: dict[str, Any]) -> str:
    """One table row of :data:`HEADER`."""
    cost = _cost(t["cost_usd"]) + (f" ({t['cost_missing']} calls uncosted)" if t["cost_missing"] else "")
    return (
        f"| {label} | {t['runs']} | {t['errors']} | {_share(t['accuracy'], t['graded'])} | {_share(t['all_checks'])} "
        f"| {_num(t['rounds'], 2)} | {_num(t['tool_calls'], 1)} | {_num(t['input_tokens'], 0)} "
        f"| {_num(t['output_tokens'], 0)} | {cost} | {_num(t['wall_s'], 1)} |"
    )


def _diff(now: float | None, then: float | None, fmt: str) -> str:
    if now is None or then is None:
        return "–"
    return fmt.format(now - then)


def delta(before: dict[str, Any], after: dict[str, Any]) -> dict[str, float | None]:
    """``after`` minus ``before`` for the numbers a comparison is about (accuracy in points of share)."""
    keys = ("accuracy", "all_checks", "rounds", "tool_calls", "input_tokens", "output_tokens", "cost_usd", "wall_s")
    return {key: None if after[key] is None or before[key] is None else after[key] - before[key] for key in keys}


def delta_line(label: str, before: dict[str, Any], after: dict[str, Any]) -> str:
    """The change from ``before`` to ``after`` as a row of :data:`HEADER`: accuracy in percentage points."""
    d = delta(before, after)

    def points(value: float | None) -> str:
        return "–" if value is None else f"{value * 100:+.0f} pp"

    def signed(value: float | None, digits: int) -> str:
        return "–" if value is None else f"{value:+,.{digits}f}"

    cost = "–" if d["cost_usd"] is None else f"{d['cost_usd']:+.4f} $"
    return (
        f"| **Δ {label}** | {after['runs'] - before['runs']:+d} | {after['errors'] - before['errors']:+d} "
        f"| {points(d['accuracy'])} | {points(d['all_checks'])} | {signed(d['rounds'], 2)} "
        f"| {signed(d['tool_calls'], 1)} | {signed(d['input_tokens'], 0)} | {signed(d['output_tokens'], 0)} "
        f"| {cost} | {signed(d['wall_s'], 1)} |"
    )


def by_row(runs: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """:func:`totals` per question, in the order the rows first ran."""
    grouped: dict[str, list[dict[str, Any]]] = {}
    for run in runs:
        grouped.setdefault(str(run.get("question_id")), []).append(run)
    return {row: totals(group) for row, group in grouped.items()}


def _cell(t: dict[str, Any] | None) -> str:
    if t is None:
        return "–"
    graded = round((t["accuracy"] or 0) * t["graded"]) if t["accuracy"] is not None else None
    verdict = f"{graded}/{t['graded']}" if graded is not None else "n/a"
    return f"{verdict} · {_num(t['rounds'], 1)} r · {_num(t['input_tokens'], 0)} tok"


def row_matrix(measured: list[Measured]) -> list[str]:
    """Per row and run: answers correct of graded, mean rounds, mean input tokens."""
    rows = [by_row(m.runs) for m in measured]
    ids = list(dict.fromkeys(row for table in rows for row in table))
    head = "| Row | " + " | ".join(m.label for m in measured) + " |"
    return [
        head,
        "|---|" + "---|" * len(measured),
        *(f"| {row} | " + " | ".join(_cell(table.get(row)) for table in rows) + " |" for row in ids),
    ]


def changed_rows(before: Measured, after: Measured) -> list[str]:
    """The rows whose accuracy moved, or whose mean rounds moved by a half or more."""
    then, now = by_row(before.runs), by_row(after.runs)
    lines = []
    for row, t in now.items():
        prior = then.get(row)
        if prior is None:
            lines.append(f"- `{row}` is new: {_cell(t)}")
            continue
        moved_accuracy = (t["accuracy"] or 0) != (prior["accuracy"] or 0) or (t["graded"] > 0) != (prior["graded"] > 0)
        moved_rounds = abs((t["rounds"] or 0) - (prior["rounds"] or 0)) >= 0.5
        if moved_accuracy or moved_rounds:
            lines.append(f"- `{row}`: {_cell(prior)} → {_cell(t)}")
    lines += [f"- `{row}` is gone" for row in then if row not in now]
    return lines or ["None."]


def _source(m: Measured) -> str:
    meta = m.meta
    return (
        f"`{m.path}`: commit `{meta.get('commit', '?')}`, {meta.get('started', '?')}, "
        f"{meta.get('runs_per_question', '?')} run(s) per row"
    )


def arms_report(measured: list[Measured]) -> str:
    """One run's arms side by side: the totals table and the per-row matrix."""
    lines = [
        "# Answer suite by arm",
        "",
        *(f"- {m.label}: {_source(m)}" for m in measured),
        "",
        HEADER,
        RULE,
        *(line(m.label, totals(m.runs)) for m in measured),
        "",
        "## Per row",
        "",
        "Answers correct of graded runs · mean rounds · mean input tokens.",
        "",
        *row_matrix(measured),
        "",
        LEGEND,
    ]
    return "\n".join(lines) + "\n"


def compare_report(before: list[Measured], after: list[Measured]) -> str:
    """Two runs, arm by arm: each side's totals, the change, and the rows whose outcome moved."""
    matched = pairs(before, after)
    if not matched:
        raise ValueError(f"the two runs share no arm: {[m.label for m in before]} vs {[m.label for m in after]}")
    lines = [
        "# Answer suite: before and after",
        "",
        *(f"- before, {m.label}: {_source(m)}" for m in before),
        *(f"- after, {m.label}: {_source(m)}" for m in after),
        "",
        HEADER,
        RULE,
    ]
    for then, now in matched:
        t_then, t_now = totals(then.runs), totals(now.runs)
        label = then.label if then.label == now.label else f"{then.label} → {now.label}"
        lines += [line(f"{label} before", t_then), line(f"{label} after", t_now), delta_line(label, t_then, t_now)]
    for then, now in matched:
        lines += ["", f"## Rows that moved: {now.label}", "", *changed_rows(then, now)]
    lines += ["", LEGEND]
    return "\n".join(lines) + "\n"


LEGEND = (
    "Accuracy: finished runs whose answer checks all held (n = runs with an answer check); the tool and "
    "round checks are in *All checks*. Rounds: model calls up to the answer. Tokens: the research calls'. "
    "Cost: every billed call of the turn, from the provider's `usage.cost`. Means per finished run, wall "
    "seconds the median. A difference of a run or two in a row is noise at three runs per row."
)
