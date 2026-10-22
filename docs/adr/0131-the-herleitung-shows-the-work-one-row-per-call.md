---
status: proposed
date: 2026-10-22
decision-makers: Grid engineering
consulted: product owner; three research reports (Herleitung map, retrieval flow, agent-trace patterns), October 2026
informed: everyone working on the agent's tools, the wire, the Herleitung and the answer pipeline
---

# The Herleitung shows the work: one row per call, grouped by round, with what it found

## Context and Problem Statement

The product owner, after using the filesystem-first tools of ADR-0127: „Die
Herleitung ist ein bisschen glanzlos, RAG plus Dateisuche fühlt sich sehr
sequenziell an, und Dateisuche und Ordner öffnen sind gar nicht schön
dargestellt.“ Measured in the code on 2026-10-22:

- **A folder listing has no payload.** `list_files` emits a `tool` step and a
  `retrieval` step and nothing else (`browse.py` records no lane hit and no
  `sources` step). The folder, the view and the counts live only in the tool's
  text. In the graph the round has no documents, and `roundKind`
  (`ReasoningFlow.tsx`) can label a listing that worked „Kein Treffer“.
- **A literal search looks like a ranked one.** `knowledge_search(match="exact")`
  renders exactly like a meaning search; the mode survives only as a technical
  record for an eval score. Match counts and the „N Dokumente durchsucht, M mit
  Treffer“ denominators are not on the wire.
- **Calls are collapsed twice.** `emit_retrieval` folds a round into one row,
  and the UI dedupes the round's tools into chips without counts. Three
  parallel reads are one „Lesen“ chip. Parallel work is invisible, and that is
  most of why the turn *feels* sequential.
- **No time per step, no errors.** `turn-fold.ts` keeps a step's first
  timestamp and drops its finish. A `tool` step with `status: error` is stored
  and never drawn.
- **The query is hidden on purpose** (PF-12, `retrieval-rounds.ts`): the graph
  shows the model's sentence, never the query. For a ranked search over the law
  that holds. For a file search it hides the one thing a reader needs to judge
  it: what was looked for, and where.

The turn is also really sequential, in a narrower way than it feels
(`docs/architecture/turn-latency-measured-2026-09.md`): calls inside a round
already run concurrently (`ToolNode` gathers them, `parallel_tool_calls=True`),
but the model usually issues one query per round, and each round costs a
reasoning call of about 5.7 s. The search description says „Prefer one precise
call over a broad dump“, and round 0 prefetches the meaning search only.

## Decision Drivers

- A reader judges evidence by what was looked for and where, not by which tool ran.
- Parallel work that is invisible reads as sequential.
- Nothing raw on the wire (ADR-0068); typed, bounded values only.
- Measured, not guessed: the answer suite before and after.

## The north star

A planner asks „Welche Brandabschnitte sind im Einreichplan eingetragen, und
passt das zur OIB 2?“ and watches Piloti work like a colleague with two hands:

> **Runde 1 · 3 gleichzeitig · 2,4 s**
> ⌕ Sucht im Projekt „Brandabschnitt“, wörtlich · 14 Treffer in 3 Dateien
> ▤ Öffnet 03 Einreichung / Pläne · 12 Dateien, 2 Ordner
> § Sucht in der OIB 2 „Brandabschnitte Fläche“ · 6 Treffer
>
> **Runde 2 · 2 gleichzeitig · 1,8 s**
> ▭ Liest Einreichplan EG.pdf, S. 2–3
> ◉ Sieht sich Einreichplan EG.pdf an, S. 2, oben rechts  [Ausschnitt]

Every row is evidence: a file opens at its page, a folder opens in the Files
pane, a look shows its crop. Rows that ran together sit together, each with
its own bar on a shared time axis, so the reader *sees* the concurrency. While
it runs, a row appears the moment its call starts and settles when it ends. A
call that failed says so. Finished, the panel folds to one line with counts and
time, and the sources stay the hero of the answer (the 2026-07 source-hero
contract).

And the work itself is as parallel as the drawing suggests: round 0 runs the
meaning search beside a literal search for what the question quotes; the model
is told to put independent searches in one round, and does.

## Considered Options

1. A new typed `action` step, emitted by each tool at start and end.
2. Typed arguments and outcomes on the existing `tool` step, filled by the callback from the call's input.
3. Parse the tool's text in the frontend.

## Decision Outcome

Chosen: option 1. Option 2 cannot see a tool's outcome without scraping its
text (the callback has the input, not typed results), and the `tool` step's
contract is the chips. Option 3 breaks ADR-0068 and every rename of a phrase.

1. **A new step kind, `action`: one row per call, typed, never raw.** It carries
   the call's verb (`search`, `list`, `read`, `look`, `lookup`, `law`, `web`,
   `model`, `workspace`), its round, its status (`running`, `ok`, `empty`,
   `error`), a typed summary (query, match mode, target folder/document/
   operation, pages, shelf) and its outcome counts (hits, documents, files,
   folders), with `elapsed_ms`. A tool emits it itself, at start and at end,
   under one id, from the values it already holds, never parsed from its own
   text. ADR-0068's rule that nothing raw rides a step stands: these are the
   tool's own typed values, bounded and clipped like a `look` step's.
2. **The `tool` step stays** for the chips and for tools that have no action
   row yet; a tool without an action row loses nothing it shows today.
3. **The Herleitung gains a work list under the source graph**: rounds as
   groups („Runde n · k gleichzeitig · t s“), each call a row with its verb
   icon, its words and a bar on the round's time axis, clickable to its
   document, page or folder. The look rows of ADR-0128 become the `look` verb's
   rendering in it.
4. **PF-12 is narrowed, not dropped.** The graph still shows the model's
   sentence, not the query. The work list shows a query for a file search, a
   literal search and a web search, because there the query *is* the evidence.
5. **Fan out on purpose.** The search description asks for independent queries
   in one round instead of „one precise call“, and round 0 adds a literal
   search beside the meaning search when the question quotes a term
   (Anführungszeichen, a document number, a plan code). Measured with
   `task be:eval:answer-suite` before and after (rounds per turn, seconds,
   score).

### Slices, each naming the part of the star it serves

| Slice | Serves |
|---|---|
| `ActionStep` on the wire, the helper in `turn_status`, schema and Zod regenerated | every row exists, typed, with time |
| `knowledge_search`, `read_passage`, `list_files` emit action rows | file search and folder opening are drawn |
| `project_lookup`, web, RIS, `workspace__call`, IFC emit action rows | the rest of the work is drawn |
| The work list in the Herleitung, live and settled, with time bars and click-through | parallel is visible; every row is evidence |
| A list-only round is never „Kein Treffer“; an error is drawn | the trace tells the truth |
| Description fan-out and literal prefetch in round 0 | the work is as parallel as it looks |

### Consequences

- One more step kind on the wire: `wire_v2.py`, the generated schema and Zod
  module, fixtures, and both dictionaries for the new copy.
- A reader sees queries for file and web searches. They are the model's words
  about the turn's own scope, already shown on the live line today; nothing
  outside the turn's audience reaches the row.
- Deep research (`scope: deep`) emits no action rows in this slice; it keeps its
  own report.

### Confirmation

`tests/aiq_agent/common/test_wire_v2.py` and `wire-v2.spec.ts` validate the new
kind against the recorded turns; the producer tests assert one start and one
end per call with the same id; the work list has a `/dev/derivation` variant
with a captured screenshot; the answer suite's report is in the PR.
