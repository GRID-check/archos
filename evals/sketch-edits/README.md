# Sketch-edit eval

Can a model read a filed Skizze's outline and write a `document-sketch-edit` that does what the
architect asked, and nothing that breaks the drawing? This harness answers that for one model call at a
time, outside the turn: the system prompt is the live `excalidraw-sketch` skill, the user message the
instruction and the outline, the answer the edit's body (`{ "ops": [...], "note": "..." }`).

## What it measures

| | Needs a model? | What it is worth |
|---|---|---|
| `selftest`: every gold answer passes, every negative is caught by the gate it targets | no | The checker discriminates. Runs in the backend suite (`test_sketch_edit_eval.py`). |
| `score answers --legacy`: the blind answers of 2026-10-29 (Claude Sonnet and Haiku as subjects, outline and outline + picture) under the shipped operation rules | no | A recorded proxy, not the product model: Sonnet 13/13 on the outline, 12/13 with the picture, Haiku 9/13. Held by the same test. |
| `run --model <id>`: the tasks against a model | **yes** | The ship bar of `docs/roadmap/sketches.md`: the product model at ≥ 11/13 on the outline alone, no fence refusals. |

A model runs only when an endpoint is configured: `OPENROUTER_API_KEY`, or `LLM_API_KEY` with
`LLM_BASE_URL` for any OpenAI-compatible endpoint. Without one, `run` exits saying so.

```bash
python3 -I evals/sketch-edits/run_sketch_edit_eval.py selftest
python3 -I evals/sketch-edits/run_sketch_edit_eval.py score evals/sketch-edits/answers --legacy
OPENROUTER_API_KEY=… python3 -I evals/sketch-edits/run_sketch_edit_eval.py run --model <id> --form outline --repeat 2
python3 -I evals/sketch-edits/run_sketch_edit_eval.py score evals/sketch-edits/results/run-*.jsonl
```

## The tasks and the gates

Thirteen tasks (`sketch_edit_tasks.py`): reorder by circulation, add an escape route, one frame per
storey, street and access, a list to bubbles, variant B beside A, mark revision changes, remove
duplicates, the dimension trap (the right answer is no ops and a note), insert between, recolour and
rename, a callout, rewire a connection. Each has its own check; every answer also passes the generic
gates: it parses, its ops are valid under the shipped rules (an intent on each), the result passes the
repo's fence check (`agent.common.sketch_fence`), no label reads like a measurement, nothing new or moved
overlaps, and added arrows land on their shapes.

## The mirror

`sketch_edit_lib.apply_ops` applies the operations in skeleton space, the way
`apps/workspace/bff/diagrams/sketch-edit.ts` applies them to a scene: removal takes bound arrows along,
`rebind`, `place`, `align`, `distribute` and `stack` resolve to positions, arrows bound to what moved are
routed again. It is a mirror, not the code. Change a rule there, change it here.

The answers recorded before ops carried an intent are scored with `--legacy`, which gives each op one.
The blind set's failures were arrows (re)bound wrongly and removals that left an arrow behind; the
cascade and `rebind` are the shipped answer to both.
