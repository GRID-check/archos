"""The office-file eval: questions about a project's own files, and which move answered them (ADR-0127).

``suite.py --set files`` runs ``tests/fixtures/files_eval/files_questions.yaml`` through the real
agent and the real ``list_files``, ``knowledge_search`` and ``read_passage``, in the fixture project
``fixture_files.py`` seeds. It is the workspace eval's shape (``workspace_eval.py``): rows with
``turns`` run in one conversation, the checks read the last turn, and a judge answers the meanings
(``judge.py``). What it adds is the question the set exists for: did the turn use the move that
fits (list to orient, search to find, read to read), and was the answer right.

Three arms (``--arm``, ADR-0133's Confirmation) change what the agent may do, through ``--override``
pairs on the one config, by today's tool names and by the ones ADR-0133 brings (``ls``, ``glob``,
``grep``, ``read_file``):

- ``semantic``: ranked search only. Every listing, reading and literal tool is unbound and
  ``knowledge_search`` accepts ``match=meaning`` alone.
- ``grep``: no round-0 prefetch and no ranked search: ``knowledge_search`` accepts the literal
  modes only or, once ``grep`` is a tool of its own, is unbound.
- ``hybrid``: production's configuration.

``--arm all`` runs the three in turn. The names before ADR-0133 (``search``, ``navigate``, ``both``)
are read as these, so a results.json written with them still compares.

The same rows run before and after the rename: a call counts under its own name and under the
names it is an alias of, both ways (:func:`aliases`), and a path on the call or in the row's
expectation is read as the scope it addresses (:func:`path_scope`), so ``{knowledge_search: {match:
exact}}`` holds for ``grep("Fluchtweg")``, ``list_files`` for ``ls("/project/")`` and ``{grep: {path:
/project/Behörde/}}`` for ``knowledge_search(match="exact", folder="Behörde")``. A call under
``/drafts/`` is no file move.

The row's ``needs`` names an argument that exists only after its slice lands. A row whose argument
the tools do not have yet is "not applicable on this commit": it is not run, so the baseline is
taken without it and says so.
"""

from __future__ import annotations

import json
import re
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
CHECK_KEYS = frozenset(
    {"tools", "max_research_calls", "mentions", "not_mentions", "at_least", "judge", "no_repeat", "proposals", "marks"}
)
TOOL_KEYS = frozenset({"must", "any", "must_not"})
ARMS = ("semantic", "grep", "hybrid")
#: The arm names before ADR-0133, read as the arm each was.
LEGACY_ARMS = {"search": "semantic", "navigate": "grep", "both": "hybrid"}
#: The tools that list, read or match literally, by today's names and by ADR-0133's (§8).
LITERAL_TOOLS = frozenset({"list_files", "read_passage", "ls", "glob", "grep", "read_file"})

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


def arm_name(arm: str | None) -> str:
    """The arm as ADR-0133 names it: a name from before it is read as the arm it was, none as hybrid."""
    name = LEGACY_ARMS.get(str(arm or "hybrid"), str(arm or "hybrid"))
    if name not in ARMS:
        raise ValueError(f"unknown arm {arm!r}; one of {', '.join(ARMS)}")
    return name


def arms_of(arm: str) -> list[str]:
    """The arms ``--arm`` names: one, or all three for ``all``."""
    return list(ARMS) if arm == "all" else [arm_name(arm)]


_TOOLS_KEY = "functions.shallow_research_agent.tools"
_MODES_KEY = "functions.knowledge_search.match_modes"
_PREFETCH_KEY = "functions.shallow_research_agent.prefetch"
_FILESYSTEM_KEY = "functions.shallow_research_agent.filesystem"


def arm_overrides(arm: str, tools: list[str]) -> list[list[str]]:
    """The ``--override`` pairs of an arm. ``tools`` is the agent's configured tool list (the config's own).

    The arm restricts what is bound through the knobs the agent already reads: its tool list, the
    search's ``match_modes``, the round-0 ``prefetch`` and the estate its ``filesystem`` verbs read
    (``null`` in the semantic arm leaves them the drafts alone). Literal search is a mode of
    ``knowledge_search`` today; once ``grep`` is configured it is a tool, and the grep arm unbinds the
    ranked one instead of narrowing its modes.
    """
    arm = arm_name(arm)
    if arm == "hybrid":
        return []
    if arm == "semantic":
        pairs = [
            [_TOOLS_KEY, ",".join(name for name in tools if name not in LITERAL_TOOLS)],
            # The filesystem verbs over the estate (ADR-0133) are navigation too; the drafts stay.
            [_FILESYSTEM_KEY, "null"],
        ]
        return [*pairs, [_MODES_KEY, "meaning"]] if "knowledge_search" in tools else pairs
    if "grep" in tools:
        return [[_TOOLS_KEY, ",".join(name for name in tools if name != "knowledge_search")], [_PREFETCH_KEY, "false"]]
    return [[_PREFETCH_KEY, "false"], [_MODES_KEY, "exact,regex"]]


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


#: The file tools by today's names: a call by a coming name is read as one of these (:func:`today`).
TODAY_TOOLS = ("list_files", "knowledge_search", "read_passage")


def _is_draft(path: Any) -> bool:
    text = str(path or "").strip().lstrip("/")
    return text.startswith(("drafts", "entwuerfe"))


def path_scope(path: Any) -> dict[str, str]:
    """What an ADR-0133 path addresses, in today's scope arguments: ``shelf``, ``folder``, ``file_name``.

    ``/project/Gutachten/Brandschutz/Brandschutzkonzept.pdf.md`` is the file ``Brandschutzkonzept.pdf``
    in ``Gutachten/Brandschutz`` on the ``project`` shelf; ``/project/Behörde/`` is a folder. A last
    segment with a dot is a file, and the ``.md`` a document's text carries is dropped from its name.
    ``/law/`` is rooted one level deeper (``/law/oib/``), so its folders start below the corpus.
    """
    text = str(path or "")
    parts = [part for part in text.split("/") if part]
    if not parts:
        return {}
    scope, folders = {"shelf": parts[0]}, parts[2:] if parts[0] == "law" else parts[1:]
    if folders and "." in folders[-1] and not text.endswith("/"):
        name = folders.pop()
        scope["file_name"] = name[: -len(".md")] if name.endswith(".md") and name.count(".") > 1 else name
    if folders:
        scope["folder"] = "/".join(folders)
    return scope


def _scoped(value: Any) -> dict[str, Any]:
    """:func:`path_scope` of a path, or of each option of an expectation's list (a list per argument)."""
    if not isinstance(value, list):
        return path_scope(value)
    scopes = [path_scope(option) for option in value]
    return {key: [scope[key] for scope in scopes if key in scope] for key in {k for s in scopes for k in s}}


def scope_arguments(arguments: dict[str, Any], *, defaults: bool = True) -> dict[str, Any]:
    """``arguments`` with each ``path`` and ``file_path`` also read as the ``shelf``, ``folder`` and ``file_name``.

    ``defaults`` is False for an expectation: an argument it leaves out matches any value, and a path's
    mount (its ``shelf``) is not asked of the call, because today's calls seldom name their shelf.
    """
    out = {key: value for key, value in arguments.items() if defaults or key not in ("path", "file_path")}
    for key in ("path", "file_path"):
        if key not in arguments:
            continue
        for scoped_key, scoped_value in _scoped(arguments[key]).items():
            if defaults or scoped_key != "shelf":
                out.setdefault(scoped_key, scoped_value)
    return out


def _present(arguments: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in arguments.items() if value is not None}


def aliases(call: dict[str, Any]) -> list[dict[str, Any]]:
    """The calls one call also counts as for the release the old names live (ADR-0133 §8).

    An estate ``read_file`` is a ``read_passage`` of the same document and pages, ``ls`` and ``glob`` are a
    ``list_files``, ``grep`` is a literal ``knowledge_search`` (``match=exact`` when it names no mode); and
    back, so a row written for either name holds for both and the before and after runs compare. A path
    carries its ``folder`` and ``file_name`` across (:func:`path_scope`). A call under ``/drafts/`` is no
    file move.
    """
    name, args = _basename(call["name"]), call.get("arguments") or {}
    if name == "read_file" and not _is_draft(args.get("file_path")):
        scope = path_scope(args.get("file_path"))
        leaf = str(args.get("file_path") or "").rstrip("/").rsplit("/", 1)[-1]
        mapped = {
            "document": scope.get("file_name") or leaf or None,
            "folder": scope.get("folder") if "file_name" in scope else None,
            "pages": args.get("pages"),
            "clause": args.get("clause"),
        }
        return [{"name": "read_passage", "arguments": _present(mapped)}]
    if name in ("ls", "glob") and not _is_draft(args.get("path")):
        listed = {"folder": path_scope(args.get("path")).get("folder")}
        if name == "ls" and int(args.get("depth") or 1) > 1:
            listed["view"] = "tree"
        return [{"name": "list_files", "arguments": _present(listed)}]
    if name == "grep" and not _is_draft(args.get("path")):
        scope = path_scope(args.get("path"))
        searched = {
            "query": args.get("pattern"),
            "match": args.get("mode") or "exact",
            "context": args.get("context"),
            "folder": scope.get("folder"),
            "file_name": scope.get("file_name"),
        }
        return [{"name": "knowledge_search", "arguments": _present(searched)}]
    if name == "read_passage":
        return [{"name": "read_file", "arguments": {"pages": args.get("pages"), "clause": args.get("clause")}}]
    if name == "list_files":
        return [{"name": "ls", "arguments": {}}, {"name": "glob", "arguments": {}}]
    match = str(args.get("match") or "").strip().lower()
    if name == "knowledge_search" and match in ("exact", "regex"):
        found = {"pattern": args.get("query"), "mode": match, **{k: args.get(k) for k in ("folder", "file_name")}}
        return [{"name": "grep", "arguments": _present(found)}]
    return []


def _seen(calls: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Every call as made (its path read as a scope) and as each name it is an alias of."""
    made = [{"name": call["name"], "arguments": scope_arguments(call.get("arguments") or {})} for call in calls]
    return [*made, *(alias for call in calls for alias in aliases(call))]


def today(call: dict[str, Any]) -> dict[str, Any] | None:
    """The call by today's file-tool name (``TODAY_TOOLS``) it is or stands for; None for another tool or a draft."""
    for candidate in _seen([call]):
        if _basename(candidate["name"]) in TODAY_TOOLS:
            return {**candidate, "name": _basename(candidate["name"])}
    return None


def _today_name(call: dict[str, Any]) -> str:
    """The name a call counts under for ``no_repeat``: today's file tool it stands for, else its own."""
    made = today(call)
    return made["name"] if made is not None else _basename(str(call.get("name") or ""))


def called(item: Any, calls: list[dict[str, Any]]) -> bool:
    """Whether the turn made a call ``item`` names: a tool name, or ``{tool: {argument: value | [values]}}``.

    A call counts under its own name and under the names it is an alias of (:func:`aliases`), and a path on
    either side is read as the scope it addresses (:func:`scope_arguments`), so ``{grep: {path:
    /project/Behörde/}}`` holds for ``knowledge_search(match="exact", folder="Behörde")``.
    """
    tool, wanted = next(iter(item.items())) if isinstance(item, dict) else (str(item), {})
    want = scope_arguments(wanted, defaults=False)
    return any(
        tool in (call["name"], _basename(call["name"]))
        and all(_matches(v, call["arguments"].get(k)) for k, v in want.items())
        for call in _seen(calls)
    )


def proposed(item: dict[str, Any], filed: list[dict[str, Any]]) -> bool:
    """Whether a proposal the fixture BFF stored is the one ``item`` names.

    ``item`` holds ``kind`` (default ``file_operation``), ``operation``, and any fields of one entry of the
    proposal's ``operations`` (``document``, ``target_folder``, ...), each a value or a list of values.
    """
    wanted = {key: value for key, value in item.items() if key not in ("kind", "operation")}
    for proposal in filed:
        payload = proposal.get("payload") or {}
        if proposal.get("kind") != item.get("kind", "file_operation"):
            continue
        if "operation" in item and not _matches(item["operation"], payload.get("operation")):
            continue
        entries = payload.get("operations") or [{}]
        if any(all(_matches(v, entry.get(k)) for k, v in wanted.items()) for entry in entries):
            return True
    return False


def _states(mark: dict[str, Any], options: list[str]) -> bool:
    """Whether a proposed mark's body or basis holds one of ``options`` as a whole word or number."""
    text = f"{mark.get('body') or ''} {mark.get('basis') or ''}"
    return any(re.search(rf"(?<![\w,.]){re.escape(str(option))}(?![\w]|[,.]\d)", text) for option in options)


def marked(item: dict[str, Any] | str, marks: list[dict[str, Any]]) -> bool:
    """Whether the proposed marks meet ``expect.marks``.

    ``none`` (the string): no mark at all. A dict: ``mentions`` is a list of option lists, and ONE mark must
    state something of every list (a finding names both values, so a mark naming one does not hold it).
    """
    if item == "none":
        return not marks
    wanted = [o if isinstance(o, list) else [o] for o in item.get("mentions") or []]
    return any(all(_states(mark, options) for options in wanted) for mark in marks) if marks else False


def _marks_label(item: dict[str, Any] | str) -> str:
    if item == "none":
        return "marked:none"
    lists = [o if isinstance(o, list) else [o] for o in item.get("mentions") or []]
    return "marked:" + "&".join("|".join(map(str, options)) for options in lists)


def _proposal_label(item: dict[str, Any]) -> str:
    return ",".join(f"{key}={value}" for key, value in item.items())


def files_checks(
    expect: dict[str, Any],
    calls: list[dict[str, Any]],
    answer: str,
    question: str,
    judge: Judge | None,
    signals: list[str],
    research_calls: int,
    filed: list[dict[str, Any]] | None = None,
    writes: list[str] | None = None,
    marks: list[dict[str, Any]] | None = None,
) -> dict[str, bool]:
    """This set's checks for one run; ``mentions`` and ``not_mentions`` are the suite's own.

    ``filed`` and ``writes`` are what the fixture BFF saw (``fixture_bff.proposals_filed`` and
    ``writes_attempted``): ``expect.proposals`` asks that each named proposal was filed and, with them,
    that no direct write route was called, because a proposal that was also written is not a proposal.
    ``marks`` is what the turn proposed on a document (``fixture_bff.marks_proposed``): ``expect.marks`` is
    ``none`` (the turn proposed nothing) or ``{mentions: [[...], [...]]}`` (one mark states every list).
    """
    checks: dict[str, bool] = {}
    if (wanted_marks := expect.get("marks")) is not None:
        checks[_marks_label(wanted_marks)] = marked(wanted_marks, marks or [])
    for item in expect.get("proposals") or []:
        checks[f"proposed:{_proposal_label(item)}"] = proposed(item, filed or [])
    if expect.get("proposals"):
        checks["no_direct_write"] = not writes
    tools = expect.get("tools") or {}
    for item in tools.get("must") or []:
        checks[f"must:{_label(item)}"] = called(item, calls)
    if tools.get("any"):
        checks["any:" + "|".join(_label(i) for i in tools["any"])] = any(called(i, calls) for i in tools["any"])
    for item in tools.get("must_not") or []:
        checks[f"must_not:{_label(item)}"] = not called(item, calls)
    for name in expect.get("no_repeat") or []:
        tool = _today_name({"name": name})
        checks[f"no_repeat:{name}"] = sum(_today_name(call) == tool for call in calls) <= 1
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


def move(call: dict[str, Any]) -> str | None:
    """The move one call made: ``list``, ``search`` (meaning), ``grep`` (literal) or ``read``; None for another tool."""
    made = today(call)
    if made is None:
        return None
    if made["name"] == "knowledge_search":
        literal = str(made["arguments"].get("match") or "meaning").casefold() in ("exact", "regex")
        return "grep" if literal else "search"
    return {"list_files": "list", "read_passage": "read"}.get(made["name"])


def moves(run_calls: list[dict[str, Any]]) -> str:
    """Which moves a run made, in the order list, search, grep, read; ``none`` when it made none of them."""
    made = {move(call) for call in run_calls}
    return "+".join(word for word in ("list", "search", "grep", "read") if word in made) or "none"


def report_lines(runs: list[Any], meta: dict[str, Any] | None = None) -> list[str]:
    """The set's own totals, per row and over all: pass rate, rounds, tokens, seconds and the budget signals."""
    meta = meta or {}
    ok = [run for run in runs if not run.error]
    head = [f"## Office files (arm: {arm_name(meta.get('arm'))})", ""]
    if not ok:
        return [*head, "No run finished."]
    from dataclasses import asdict

    from compare import HEADER
    from compare import RULE
    from compare import by_row
    from compare import correct
    from compare import line
    from compare import totals

    stored = [asdict(run) for run in runs]
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
        f"- reasoning tokens per run, median: {median([r.reasoning_tokens for r in ok]):g}",
        f"- runs that hit status:budget {signal_counts['budget']}, status:repeat {signal_counts['repeat']}, "
        f"status:width {signal_counts['width']}",
        "",
        HEADER,
        RULE,
        line(arm_name(meta.get("arm")), totals(stored)),
        "",
        "| row | passed | correct | rounds | tool calls | input tok | output tok | cost | seconds | moves |",
        "|---|---|---|---|---|---|---|---|---|---|",
    ]
    per_row = by_row(stored)
    for question_id in dict.fromkeys(run.question_id for run in ok):
        rows = [run for run in ok if run.question_id == question_id]
        passed = sum(all(r.checks.values()) for r in rows if r.checks)
        graded = [verdict for r in rows if (verdict := correct(asdict(r))) is not None]
        t = per_row[question_id]
        cost = "–" if t["cost_usd"] is None else f"${t['cost_usd']:.4f}"
        lines.append(
            f"| {question_id} | {passed}/{len(rows)} | {f'{sum(graded)}/{len(graded)}' if graded else 'n/a'} "
            f"| {median([r.research_calls for r in rows]):g} | {t['tool_calls']:.1f} | {t['input_tokens']:,.0f} "
            f"| {t['output_tokens']:,.0f} | {cost} | {median([r.wall_s for r in rows]):g} "
            f"| {' / '.join(sorted({moves(r.tool_args) for r in rows}))} |"
        )
    if meta.get("not_applicable"):
        lines += [
            "",
            f"Not applicable on this commit (no such tool argument yet): {', '.join(meta['not_applicable'])}.",
        ]
    return [*lines, ""]
