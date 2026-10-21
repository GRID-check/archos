"""The office-file eval: questions about a project's own files, and which move answered them (ADR-0127).

``suite.py --set files`` runs ``tests/fixtures/files_eval/files_questions.yaml`` through the real
agent and the real ``list_files``, ``knowledge_search`` and ``read_passage``, in the fixture project
``fixture_files.py`` seeds. It is the workspace eval's shape (``workspace_eval.py``): rows with
``turns`` run in one conversation, the checks read the last turn, and a judge answers the meanings
(``judge.py``). What it adds is the question the set exists for: did the turn use the move that
fits (list to orient, search to find, read to read), and was the answer right.

Three arms (``--arm``) change what the agent may do, through ``--override`` pairs on the one config:

- ``search``: ranked search only. ``list_files`` and ``read_passage`` are unbound and
  ``knowledge_search`` accepts ``match=meaning`` alone.
- ``navigate``: no round-0 prefetch and no ranked search: ``knowledge_search`` accepts the literal
  modes only.
- ``both``: production's configuration.

The row's ``needs`` names an argument that exists only after its slice lands. A row whose argument
the tools do not have yet is "not applicable on this commit": it is not run, so the baseline is
taken without it and says so.
"""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

from fixture_bff import ROOT
from workspace_eval import Judge
from workspace_eval import run_conversation  # noqa: F401  (the rows run as the workspace set's do)
from workspace_eval import turns_of  # noqa: F401

QUESTIONS = ROOT / "tests" / "fixtures" / "files_eval" / "files_questions.yaml"
#: The meanings this set asks the judge (``judge.py``).
MEANING_CHECKS = ("none_found",)
#: The keys an ``expect`` block may hold: the suite's own (``suite.check``) and this set's.
CHECK_KEYS = frozenset({"tools", "max_research_calls", "mentions", "not_mentions", "at_least", "judge", "no_repeat"})
TOOL_KEYS = frozenset({"must", "any", "must_not"})
ARMS = ("search", "navigate", "both")

#: An argument a slice adds, and where the tools' own schema shows it: ``needs`` -> (tool, argument).
#: ``regex`` is a value of ``match``, which the schema cannot show; the tool's description says it.
NEEDS: dict[str, tuple[str, str]] = {
    "pages": ("read_passage", "pages"),
    "cursor": ("read_passage", "cursor"),
    "view": ("list_files", "view"),
    "group_by": ("knowledge_search", "group_by"),
    "context": ("knowledge_search", "context"),
    "regex": ("knowledge_search", 'match="regex"'),
}
TOOL_SCHEMA = ROOT / "frontends" / "ui" / "tests" / "fixtures" / "backend-tools.schema.json"


def load_questions(path: Path = QUESTIONS) -> list[dict]:
    """The set's rows, each with ``question`` set to its last turn (what the checks read)."""
    from workspace_eval import load_questions as load_rows

    return [{**row, "set": "files"} for row in load_rows(path)]


# --- what the commit can do ------------------------------------------------------


def available_needs(schema_path: Path = TOOL_SCHEMA) -> set[str]:
    """The ``needs`` values the tools of this commit support, read off the exported tool schema."""
    tools = {tool["name"]: tool for tool in json.loads(schema_path.read_text(encoding="utf-8"))["tools"]}
    found: set[str] = set()
    for need, (name, argument) in NEEDS.items():
        tool = tools.get(name) or {}
        properties = (tool.get("inputSchema") or {}).get("properties") or {}
        if argument in properties or argument in str(tool.get("description") or ""):
            found.add(need)
    return found


def applicable(row: dict, available: set[str]) -> bool:
    return set(row.get("needs") or []) <= available


def split_applicable(rows: list[dict], available: set[str] | None = None) -> tuple[list[dict], list[str]]:
    """The rows this commit can answer, and the ids of those that wait for an argument."""
    available = available_needs() if available is None else available
    return [r for r in rows if applicable(r, available)], [str(r["id"]) for r in rows if not applicable(r, available)]


# --- the arms --------------------------------------------------------------------


def arm_overrides(arm: str, tools: list[str]) -> list[list[str]]:
    """The ``--override`` pairs of an arm. ``tools`` is the agent's configured tool list (the config's own)."""
    if arm not in ARMS:
        raise ValueError(f"unknown arm {arm!r}; one of {', '.join(ARMS)}")
    if arm == "both":
        return []
    if arm == "search":
        kept = [name for name in tools if name not in ("list_files", "read_passage")]
        return [
            ["functions.shallow_research_agent.tools", ",".join(kept)],
            ["functions.knowledge_search.match_modes", "meaning"],
        ]
    return [
        ["functions.shallow_research_agent.prefetch", "false"],
        ["functions.knowledge_search.match_modes", "exact,regex"],
    ]


def configured_tools(config: Path | None = None) -> list[str]:
    """The research agent's tool list as the config names it."""
    import yaml

    config = config or ROOT / "configs" / "config_oib_openrouter.yml"
    loaded = yaml.safe_load(config.read_text(encoding="utf-8"))
    return [str(name) for name in loaded["functions"]["shallow_research_agent"]["tools"]]


# --- what the turn called --------------------------------------------------------


def recorded_calls(items: list[dict]) -> list[dict[str, Any]]:
    """``{name, arguments}`` for each function call in a model response's output items."""
    calls = []
    for item in items:
        if item.get("type") != "function_call":
            continue
        try:
            arguments = json.loads(item.get("arguments") or "{}")
        except ValueError:
            arguments = {}
        calls.append(
            {"name": str(item.get("name") or ""), "arguments": arguments if isinstance(arguments, dict) else {}}
        )
    return calls


def _basename(name: str) -> str:
    return name.rsplit("__", 1)[-1]


def _matches(wanted: Any, actual: Any) -> bool:
    options = wanted if isinstance(wanted, list) else [wanted]
    return actual is not None and any(
        str(option) == "*" or str(actual).strip().casefold() == str(option).strip().casefold() for option in options
    )


def called(item: Any, calls: list[dict[str, Any]]) -> bool:
    """Whether the turn made a call ``item`` names: a tool name, or ``{tool: {argument: value | [values]}}``."""
    tool, wanted = next(iter(item.items())) if isinstance(item, dict) else (str(item), {})
    return any(
        _basename(call["name"]) == tool and all(_matches(v, call["arguments"].get(k)) for k, v in wanted.items())
        for call in calls
    )


def files_checks(
    expect: dict[str, Any],
    calls: list[dict[str, Any]],
    answer: str,
    question: str,
    judge: Judge | None,
    signals: list[str],
    research_calls: int,
) -> dict[str, bool]:
    """This set's checks for one run; ``mentions`` and ``not_mentions`` are the suite's own."""
    checks: dict[str, bool] = {}
    tools = expect.get("tools") or {}
    for item in tools.get("must") or []:
        checks[f"must:{_label(item)}"] = called(item, calls)
    if tools.get("any"):
        checks["any:" + "|".join(_label(i) for i in tools["any"])] = any(called(i, calls) for i in tools["any"])
    for item in tools.get("must_not") or []:
        checks[f"must_not:{_label(item)}"] = not called(item, calls)
    for name in expect.get("no_repeat") or []:
        checks[f"no_repeat:{name}"] = sum(_basename(c["name"]) == name for c in calls) <= 1
    if expect.get("max_research_calls"):
        checks[f"rounds<={expect['max_research_calls']}"] = research_calls <= int(expect["max_research_calls"])
    if expect.get("at_least"):
        wanted = expect["at_least"]
        folded = answer.casefold()
        checks[f"at_least:{wanted['n']}"] = sum(str(w).casefold() in folded for w in wanted["of"]) >= int(wanted["n"])
    for kind in expect.get("judge") or []:
        verdict = judge(kind, question, answer) if judge is not None and answer.strip() else None
        checks[f"judge:{kind}"] = bool(verdict)
        if verdict is None and answer.strip():
            signals.append(f"judge_unavailable:{kind}")
    return checks


def _label(item: Any) -> str:
    if not isinstance(item, dict):
        return str(item)
    tool, args = next(iter(item.items()))
    return tool + "(" + ",".join(f"{k}={v}" for k, v in args.items()) + ")"


# --- the report ------------------------------------------------------------------


def moves(run_calls: list[dict[str, Any]]) -> str:
    """Which moves a run made: ``list``, ``search``, ``read``, joined; ``none`` when it called no file tool."""
    names = {_basename(call["name"]) for call in run_calls}
    found = [
        word
        for tool, word in (("list_files", "list"), ("knowledge_search", "search"), ("read_passage", "read"))
        if tool in names
    ]
    return "+".join(found) or "none"


def report_lines(runs: list[Any], meta: dict[str, Any] | None = None) -> list[str]:
    """The set's own totals, per row and over all: pass rate, rounds, tokens, seconds and the budget signals."""
    meta = meta or {}
    ok = [run for run in runs if not run.error]
    head = [f"## Office files (arm: {meta.get('arm') or 'both'})", ""]
    if not ok:
        return [*head, "No run finished."]
    held = [all(run.checks.values()) for run in ok if run.checks]
    median = statistics.median
    signal_counts = {
        key: sum(1 for run in ok if any(s.startswith(key) for s in run.signals))
        for key in ("budget", "repeat", "width")
    }
    lines = [
        *head,
        f"- runs where every check held: {sum(held)}/{len(held)} ({sum(held) / max(1, len(held)):.0%})",
        f"- rounds (research calls to the answer), median: {median([r.research_calls for r in ok]):g}, "
        f"mean {sum(r.research_calls for r in ok) / len(ok):.2f}",
        f"- input tokens per run, median: {median([r.input_tokens for r in ok]):g}; output "
        f"{median([r.output_tokens for r in ok]):g}; reasoning {median([r.reasoning_tokens for r in ok]):g}",
        f"- wall seconds per run, median: {median([r.wall_s for r in ok]):g}",
        f"- runs that hit status:budget {signal_counts['budget']}, status:repeat {signal_counts['repeat']}, "
        f"status:width {signal_counts['width']}",
        "",
        "| row | passed | rounds | moves | seconds |",
        "|---|---|---|---|---|",
    ]
    for question_id in dict.fromkeys(run.question_id for run in ok):
        rows = [run for run in ok if run.question_id == question_id]
        passed = sum(all(r.checks.values()) for r in rows if r.checks)
        lines.append(
            f"| {question_id} | {passed}/{len(rows)} | {median([r.research_calls for r in rows]):g} | "
            f"{' / '.join(sorted({moves(r.tool_args) for r in rows}))} | {median([r.wall_s for r in rows]):g} |"
        )
    if meta.get("not_applicable"):
        lines += [
            "",
            f"Not applicable on this commit (no such tool argument yet): {', '.join(meta['not_applicable'])}.",
        ]
    return [*lines, ""]
