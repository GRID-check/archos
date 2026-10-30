#!/usr/bin/env python3
"""Sketch-edit eval (S4): can a model read a sketch's outline and write a valid `document-sketch-edit`?

Thirteen architect tasks (`sketch_edit_tasks.py`), each a starting sketch, a German instruction, a
programmatic check and a gold answer; the generic gates every answer meets (parses, ops valid under the
shipped rules, the result passes the repo's fence check, no dimension label, no new overlap, added arrows
land on their shapes). The system prompt is the live excalidraw-sketch skill, whose section „A filed
Skizze“ is what Piloti reads; the answer is the body of document-sketch-edit without `baseVersionId`.

  python3 -I run_sketch_edit_eval.py selftest            # gold passes, negatives fail; no model
  python3 -I run_sketch_edit_eval.py score answers --legacy   # the recorded blind answers (2026-10-29)
  python3 -I run_sketch_edit_eval.py run --model <id> [--model <id>] [--form outline] [--repeat 2]
  python3 -I run_sketch_edit_eval.py score results/<file>.jsonl
  python3 -I run_sketch_edit_eval.py render              # scenes/*.png and outlines/*.json, to look at

Runs a model only when an endpoint is configured: OPENROUTER_API_KEY (or LLM_API_KEY, with LLM_BASE_URL
for any OpenAI-compatible endpoint, default https://openrouter.ai/api/v1). `selftest` and `score` need
none; `test_sketch_edit_eval.py` runs them in the backend suite. Ship bar (docs/roadmap/sketches.md): the
product model at >= 11/13 on the outline alone, with no fence refusals.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from sketch_edit_gold import GOLD  # noqa: E402
from sketch_edit_gold import NEGATIVES  # noqa: E402
from sketch_edit_lib import GENERIC_GATES  # noqa: E402
from sketch_edit_lib import REPO  # noqa: E402
from sketch_edit_lib import OpError  # noqa: E402
from sketch_edit_lib import apply_ops  # noqa: E402
from sketch_edit_lib import generic_checks  # noqa: E402
from sketch_edit_lib import outline  # noqa: E402
from sketch_edit_lib import parse_response  # noqa: E402
from sketch_edit_lib import with_intents  # noqa: E402
from sketch_edit_render import render_png  # noqa: E402
from sketch_edit_tasks import TASKS  # noqa: E402

SKILL = REPO / "packages/agent/src/agent/skills/builtin/drawing/excalidraw-sketch/SKILL.md"

ANSWER_FORMAT = """

## This conversation

You get the person's instruction and the sketch's outline, as document-sketch-get answers it. Answer with
JSON only, the body of document-sketch-edit without `baseVersionId`: {"ops": [...], "note": "<one sentence
for the person>"}.
"""


def system_prompt() -> str:
    skill = SKILL.read_text(encoding="utf-8").split("---", 2)[-1]
    return skill + ANSWER_FORMAT


def user_content(task: dict, form: str) -> list | str:
    text = f"Anweisung: {task['instruction']}\n\nSkizze „{task['scene']['title']}“, Outline:\n" + json.dumps(
        outline(task["scene"]), ensure_ascii=False
    )
    if form == "outline":
        return text
    png = HERE / "scenes" / f"{task['id']}.png"
    if not png.exists():
        render_png(task["scene"], png)
    data = base64.b64encode(png.read_bytes()).decode()
    return [
        {"type": "text", "text": text + "\n\nDas Bild zeigt die Skizze, wie sie gezeichnet ist."},
        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{data}"}},
    ]


# ---------------------------------------------------------------- scoring


def score(task: dict, response_text: str, legacy: bool = False) -> dict:
    """`legacy`: an answer from before ops carried an intent, given one (`with_intents`) and scored as shipped."""
    out: dict = {"task": task["id"]}
    try:
        resp = parse_response(response_text)
        if legacy:
            resp = with_intents(resp)
    except Exception as exc:  # noqa: BLE001
        return {**out, "parsed": False, "error": f"parse: {exc}", "pass": False}
    out["parsed"] = True
    out["n_ops"] = len(resp.get("ops") or [])
    try:
        after, touched = apply_ops(task["scene"], resp["ops"])
    except OpError as exc:
        return {**out, "ops_valid": False, "error": f"op: {exc}", "pass": False}
    out["ops_valid"] = True
    g = generic_checks(task["scene"], after, touched)
    t = task["check"](task["scene"], after, touched, resp)
    out["generic"] = g
    out["task_checks"] = t
    out["generic_pass"] = all(g[k] for k in GENERIC_GATES)
    out["task_pass"] = all(t.values())
    out["pass"] = out["generic_pass"] and out["task_pass"]
    out["note"] = resp.get("note")
    return out


def selftest() -> int:
    bad = 0
    tasks = {t["id"]: t for t in TASKS}
    for t in TASKS:
        r = score(t, json.dumps(GOLD[t["id"]], ensure_ascii=False))
        ok = r["pass"]
        bad += not ok
        print(
            f"gold {t['id']:24} {'PASS' if ok else 'FAIL'}",
            ""
            if ok
            else json.dumps(
                {k: r.get(k) for k in ("error", "task_checks")}
                | {
                    "generic": {
                        k: r["generic"][k]
                        for k in r.get("generic", {})
                        if k in GENERIC_GATES or k in ("overlaps", "arrow_misses", "fence_refusal")
                    }
                }
                if r.get("generic")
                else r,
                ensure_ascii=False,
            ),
        )
    for tid, resp, gate in NEGATIVES:
        r = score(tasks[tid], json.dumps(resp, ensure_ascii=False))
        caught = not r["pass"] and (
            (gate == "ops_valid" and r.get("ops_valid") is False)
            or (gate in GENERIC_GATES and r.get("generic", {}).get(gate) is False)
            or (r.get("task_checks", {}).get(gate) is False)
        )
        bad += not caught
        print(f"neg  {tid:24} expect {gate:20} {'CAUGHT' if caught else 'MISSED'}")
    print("selftest", "ok" if not bad else f"{bad} problems")
    return 1 if bad else 0


def render_all() -> None:
    (HERE / "scenes").mkdir(exist_ok=True)
    (HERE / "outlines").mkdir(exist_ok=True)
    for t in TASKS:
        render_png(t["scene"], HERE / "scenes" / f"{t['id']}.png")
        (HERE / "outlines" / f"{t['id']}.json").write_text(
            json.dumps(outline(t["scene"]), ensure_ascii=False, indent=1)
        )
        # and the gold result, to eyeball
        after, _ = apply_ops(t["scene"], GOLD[t["id"]]["ops"])
        render_png(after, HERE / "scenes" / f"{t['id']}.gold.png")
    print("rendered", len(TASKS))


def export_blind(out: Path) -> None:
    """Only what a subject sees: the system prompt, and per task the instruction, outline and picture."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "system.md").write_text(system_prompt(), encoding="utf-8")
    for i, t in enumerate(TASKS, 1):
        d = out / f"t{i:02d}"
        d.mkdir(exist_ok=True)
        text = user_content(t, "outline")
        instr, _, rest = text.partition("\n\n")
        (d / "instruction.txt").write_text(instr.removeprefix("Anweisung: ") + "\n", encoding="utf-8")
        (d / "outline.json").write_text(
            json.dumps({"title": t["scene"]["title"], **outline(t["scene"])}, ensure_ascii=False, indent=1),
            encoding="utf-8",
        )
        render_png(t["scene"], d / "scene.png")
    for form in ("outline", "outline+png"):
        (out / "answers" / form).mkdir(parents=True, exist_ok=True)
    print("blind set:", out)


# ---------------------------------------------------------------- model calls


def call(model: str, messages: list, effort: str | None, timeout: int = 180) -> tuple[str, dict, float]:
    key = os.environ.get("OPENROUTER_API_KEY") or os.environ.get("LLM_API_KEY")
    if not key:
        raise SystemExit("no OPENROUTER_API_KEY / LLM_API_KEY in the environment")
    base = os.environ.get("LLM_BASE_URL", "https://openrouter.ai/api/v1")
    body = {"model": model, "messages": messages, "max_tokens": 6000, "temperature": 0}
    if effort:
        body["reasoning"] = {"effort": effort}
    req = urllib.request.Request(
        f"{base}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t0 = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as exc:
        return "", {"http_error": exc.code, "body": exc.read().decode()[:400]}, time.monotonic() - t0
    dt = time.monotonic() - t0
    text = data["choices"][0]["message"].get("content") or ""
    return text, data.get("usage", {}), dt


def run(models: list[str], forms: list[str], repeat: int, effort: str | None, only: list[str] | None) -> Path:
    (HERE / "results").mkdir(exist_ok=True)
    out = HERE / "results" / f"run-{time.strftime('%Y%m%d-%H%M%S')}.jsonl"
    sysmsg = {"role": "system", "content": system_prompt()}
    with out.open("w") as f:
        for model in models:
            for form in forms:
                for t in TASKS:
                    if only and t["id"] not in only:
                        continue
                    for rep in range(repeat):
                        text, usage, dt = call(
                            model, [sysmsg, {"role": "user", "content": user_content(t, form)}], effort
                        )
                        r = score(t, text) if text else {"task": t["id"], "pass": False, "error": usage}
                        rec = {
                            "model": model,
                            "form": form,
                            "rep": rep,
                            "latency_s": round(dt, 2),
                            "usage": usage,
                            "response": text,
                            **r,
                        }
                        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
                        f.flush()
                        print(
                            f"{model:32} {form:12} {t['id']:24} {'PASS' if r['pass'] else 'fail'} {dt:5.1f}s "
                            f"{usage.get('prompt_tokens', '?')}/{usage.get('completion_tokens', '?')} "
                            f"{r.get('error', '')}"
                        )
    summarise(out)
    return out


def answers_dir(path: Path, legacy: bool = False) -> list[dict]:
    """Records from per-task answer files: <dir>/[<subject>/]<form>/tNN.json, tNN = task order from 01."""
    recs = []
    for f in sorted(path.rglob("t[0-9][0-9].json")):
        n = int(f.stem[1:]) - 1
        if not 0 <= n < len(TASKS):
            continue
        form = f.parent.name
        subject = f.parent.parent.name if f.parent.parent != path else path.name
        text = f.read_text(encoding="utf-8")
        recs.append(
            {
                "model": subject,
                "form": form,
                "rep": 0,
                "latency_s": 0.0,
                "usage": {},
                "response": text,
                **score(TASKS[n], text, legacy),
            }
        )
    return recs


def _records(path: Path, legacy: bool) -> list[dict]:
    recs = answers_dir(path, legacy) if path.is_dir() else [json.loads(line) for line in path.open()]
    if not recs:
        raise SystemExit(f"no answers under {path}")
    tasks = {t["id"]: t for t in TASKS}
    for r in recs:
        if "generic" not in r and r.get("response"):
            r.update(score(tasks[r["task"]], r["response"], legacy))
    return recs


def _print_table(groups: dict) -> None:
    print(f"\n{'model':32} {'form':12} pass  parse ops   fence nodim noovl arrow task  p50s  in_tok out_tok")
    for (m, fm), rs in groups.items():
        n = len(rs)

        def rate(fn, rs=rs, n=n):
            return f"{sum(1 for r in rs if fn(r)) / n:4.0%}"

        lat = sorted(r["latency_s"] for r in rs)
        pin = sum(r.get("usage", {}).get("prompt_tokens", 0) for r in rs) / n
        pout = sum(r.get("usage", {}).get("completion_tokens", 0) for r in rs) / n
        print(
            f"{m:32} {fm:12} {rate(lambda r: r['pass'])} {rate(lambda r: r.get('parsed'))} "
            f"{rate(lambda r: r.get('ops_valid'))} "
            + " ".join(rate(lambda r, k=k: r.get("generic", {}).get(k)) for k in GENERIC_GATES)
            + f" {rate(lambda r: r.get('task_pass'))} {lat[n // 2]:5.1f} {pin:7.0f} {pout:7.0f}"
        )


def _print_tasks(recs: list[dict]) -> None:
    print("\nper task (pass/answers per form):")
    forms = sorted({r["form"] for r in recs})
    print(f"  {'task':26}" + "".join(f"{fm:>14}" for fm in forms))
    for i, t in enumerate(TASKS, 1):
        cells = []
        for fm in forms:
            rs = [r for r in recs if r["task"] == t["id"] and r["form"] == fm]
            cells.append(f"{sum(r['pass'] for r in rs)}/{len(rs)}" if rs else "-")
        print(f"  t{i:02d} {t['id']:22}" + "".join(f"{c:>14}" for c in cells))


def _why(r: dict) -> list[str]:
    why = [str(r["error"])[:80]] if r.get("error") else []
    why += [k for k, v in (r.get("task_checks") or {}).items() if not v]
    g = r.get("generic") or {}
    why += [
        f"{k}{'(' + str(g.get('fence_refusal')) + ')' if k == 'fence_valid' else ''}"
        for k in GENERIC_GATES
        if g.get(k) is False
    ]
    if g.get("overlaps"):
        why.append(f"overlaps={g['overlaps'][:3]}")
    if g.get("arrow_misses"):
        why.append(f"arrow_misses={g['arrow_misses'][:3]}")
    return why


def summarise(path: Path, legacy: bool = False) -> dict[str, tuple[int, int]]:
    """Print the report; answer passes and answers per `subject/form`."""
    recs = _records(path, legacy)
    groups: dict = defaultdict(list)
    for r in recs:
        groups[(r["model"], r["form"])].append(r)
    _print_table(groups)
    _print_tasks(recs)
    print("\nwhy each failing answer failed:")
    for r in recs:
        if not r["pass"]:
            print(f"  {r['model']:16} {r['form']:12} {r['task']:24} {'; '.join(_why(r))}")
    return {f"{m}/{fm}": (sum(1 for r in rs if r["pass"]), len(rs)) for (m, fm), rs in groups.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("selftest")
    sub.add_parser("render")
    sub.add_parser("prompt")
    b = sub.add_parser("blind")
    b.add_argument("out")
    r = sub.add_parser("run")
    r.add_argument("--model", action="append", required=True)
    r.add_argument("--form", action="append", choices=["outline", "outline+png"])
    r.add_argument("--repeat", type=int, default=1)
    r.add_argument("--effort", default="medium")
    r.add_argument("--only", action="append")
    s = sub.add_parser("score")
    s.add_argument("path")
    s.add_argument("--legacy", action="store_true", help="answers without intents (the 2026-10-29 blind set)")
    a = ap.parse_args()
    if a.cmd == "selftest":
        return selftest()
    if a.cmd == "render":
        render_all()
    elif a.cmd == "prompt":
        print(system_prompt())
        print("----- user (task 1, outline) -----")
        print(user_content(TASKS[0], "outline"))
    elif a.cmd == "run":
        run(a.model, a.form or ["outline", "outline+png"], a.repeat, a.effort if a.effort != "none" else None, a.only)
    elif a.cmd == "blind":
        export_blind(Path(a.out))
    elif a.cmd == "score":
        summarise(Path(a.path), a.legacy)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
