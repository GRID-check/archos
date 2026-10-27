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
3. **The calls become nodes in the Herleitung graph.** The node-based
   Herleitung (`ReasoningFlow`, the source hero and its spine) stays the
   surface. A round fans out into one action node per call, side by side, so
   parallel calls sit in parallel; each node carries its verb, its words, its
   counts and its time, and connects to the source cards it found. A listing
   is a folder node with its breadcrumb, a look a node with its crop, a read a
   node with document and pages. Clicking a node opens its document, page or
   folder.
4. **PF-12 is narrowed, not dropped.** A round node still shows the model's
   sentence, not the query. An action node shows a query for a file search, a
   literal search and a web search, because there the query *is* the evidence.
5. **Fan out on purpose.** The search description asks for independent queries
   in one round instead of „one precise call“, and round 0 adds a literal
   search beside the meaning search when the question quotes a term
   (Anführungszeichen, a document number, a plan code). Measured with
   `task be:eval:answer-suite` before and after (rounds per turn, seconds,
   score).

### Slices, each naming the part of the star it serves

| Slice | Serves | Status |
|---|---|---|
| `ActionStep` on the wire, the helper in `turn_status`, schema and Zod regenerated | every row exists, typed | shipped |
| `knowledge_search`, `read_passage`, `list_files` emit action rows | file search and folder opening are drawn | shipped |
| `project_lookup`, web, RIS, `workspace__call`, IFC emit action rows | the rest of the work is drawn | shipped |
| Calls as rows inside the step's node, live and settled; `call_id` links a row to its source cards both ways | every row is evidence, and checkable | shipped (rows, not separate nodes: see the amendment) |
| A list-only round is never „Kein Treffer“; an error is drawn | the trace tells the truth | shipped |
| Description fan-out and literal prefetch in round 0 | the work is as parallel as it looks | shipped; the prefetch is marked (`RetrievalStep.prefetch`) and draws no row |
| „Grundlagen · Entwurf“ replaces the findings card; uncited sources fold into one card; one warning in the header | the reader sees what the answer stands on | shipped |
| The filesystem verbs (`ls`, `glob`, `grep`, `read_file`, ADR-0133) name a place, say when a search was incomplete, and link only when they returned a card | file search and folder opening read the way an architect speaks | shipped (see the amendment of 2026-10-27) |

### Amendment, 2026-10-22: the value test

The approved mockup (owner: „natural evolution of our current Herleitung, not a
rebuild“) kept every decision above but dropped what no architect checks an
answer by, and added what lets them check and reuse it:

- **Gone:** times per call, per round and in total, „3 gleichzeitig“, the shared
  time axis (Langfuse keeps the seconds); „von 41“ and hit counts on cards (the
  place proves, the number does not); the tool chips beside rows; the
  attached-files footer (a file the turn read is a source card).
- **Rows, not nodes:** a call is a row inside its step's node, the step still a
  node of the spine with its split/merge fan. Tapping a row keeps its cards
  bright and sets the rest back; tapping a card lights up its rows, joined by
  `call_id` (stored as `callId` on the `action` and `sources` steps). A row stored
  before `call_id` links nothing.
- **The prefetch draws no row.** Round 0 run by the decision is marked on the
  wire (`RetrievalStep.prefetch`), because the round index cannot tell it from
  the model's own first search; its sources join the first fan.
- **Status is a shape and a word**, colour only for the source kind; a search
  that found nothing says where it looked; a look row shows its crop, „abgelesen,
  nicht gemessen“.
- **The last card is „Grundlagen · Entwurf“**: the cited law with its edition,
  the cited project and office sources with their place, and „Offen“ from every
  call that failed or found nothing. Never „nachgewiesen“. An „Annahme“ line and
  „Klären mit“ wait for data the answer does not carry yet; a project document's
  Fassung or plan index is not on the wire either.
- **Edge cases:** a turn without research is one line; a turn of one call is
  that call; three or more calls of a kind fold to „×N“; a step of more than
  five rows shows the worst three and „+N weitere“.

### Amendment, 2026-10-27: the filesystem verbs

ADR-0133 moved Piloti's reading of the office's documents to `ls`, `glob`,
`grep` and `read_file`, and slice 6 retired `read_passage`, `list_files` and the
literal `knowledge_search` from the chat, so every file call of a turn is now
one of these rows. An audit of every outcome (2026-10-27, the `/dev/derivation`
variants `fs` and `fs-edges`) found that their rows showed the raw path
(„Öffnet project › 03 Einreichung“, „Sucht wörtlich in : „Fluchtweg““,
„Liest /project/…/README.md“), and that a `grep` which could not search
everything looked complete with hits and failed without them. Decided:

- **A row names a place, never a path.** `ActionStep` gains `mount`
  (`project | office | chat | law | estate`, the vocabulary of `ToolStep.mount`;
  `estate` is every place the person may see) and `target` is then the folder
  inside it (`estate_paths.action_place`). The words are the frontend's:
  „Listet 03 Einreichung“, „Durchsucht alle Ablagen wörtlich nach „…““, „Sucht
  Dateien „*.pdf“ im Projekt“ (a `glob` is a `list` row with its pattern as
  `query`), a folder outside the project under its place („Büroablage ›
  Vorlagen“). A path that names no place keeps the model's words. A row stored
  before `mount` is read back the same way (`legacyPlace`).
- **An incomplete search says so.** `ActionStep.incomplete` is set by a `grep`
  with any gap (a place that did not answer, the regex deadline, the passage
  cap). Its count is a floor („3 Treffer in 1 Dokument, unvollständig“); with no
  hit it is `empty`, not `error`, because most of the scope was searched, and
  „Offen“ says „… nicht alles durchsuchen konnte“. It has its own shape (a dashed
  ring), its own second line, and never folds into a sum. Only a `grep` that
  searched nothing at all is `error`.
- **A miss is „nicht gefunden“, not a failure.** A folder or document that does
  not resolve is `empty` with the name the model asked for; a restricted one
  gives the byte-identical row, so the row confirms nothing (ADR-0088). This
  replaces „a read that falls through to unknown document is an error row“
  below for the estate's `read_file`; `read_passage` keeps its old rule while it
  lives.
- **Counts are what is there.** A listing counts the folder's files, not the 40
  (`ls`) or 100 (`glob`) its text had room for; `ls /` counts places and
  documents („3 Ablagen, 62 Dateien“); a zero beside a count is dropped. A read
  says the pages it served (a read without `pages` opens page 1 and says so), and
  a folder card (`README.md`) is a `list` row of its folder with the card's
  counts. A search without a hit says how much it searched („kein Treffer in 41
  Dokumenten“), and every hit count reads „14 Treffer in 3 Dokumenten“.
- **A row links only when its call returned a card.** A listing, a name search
  and a `files_with_matches` grep are indexes: their rows are no buttons, where
  a tap used to set every card back and light nothing.
- **Drafts and skills draw no row**, as agent-filesystem §6 says; a skill read
  no longer wears the „Entwurf“ chip, and a draft `grep`/`glob` does.
- The listing verb is „Listet“ (it was „Öffnet“), its step kind „Auflisten“.

### Consequences

- One more step kind on the wire: `wire_v2.py`, the generated schema and Zod
  module, fixtures, and both dictionaries for the new copy.
- A reader sees queries for file and web searches. They are the model's words
  about the turn's own scope, already shown on the live line today; nothing
  outside the turn's audience reaches the row.
- Deep research (`scope: deep`) emits no action rows in this slice; it keeps its
  own report.
- A row settles inside the tool, before the round's results are admitted
  (`admit_tool_results`), so it names and counts only what the model may be told
  (`may_name`, ADR-0088). A read or look of a file only an unadmitted restricted
  folder holds keeps the name the model asked for, with no resolved file name,
  no document id and no count; a search that found only such hits is `ok`
  without counts; a read that falls through to „unknown document“ is an error
  row. `ActionOutcome.record` is the one place that decides it. The `sources`
  and `look` steps of the same calls follow the same rule: a lane omits such a
  document and its hits (`render_grounding_block`), and a look at one leaves no
  step (`note_look`).
- `look` has its row (verb `look`, the document, `pages` = the page, the
  workspace `document_id` when the document is one); the row and the `look`
  step name the document the same way, so the row finds its crop. A read row
  carries no `document_id`: the inventory row a read resolves against
  (`AvailableDocument`) has no workspace document id, and the row names the
  file only.
- Not yet rows: `workspace__search` and `workspace__describe` (the door's
  reads, beside `workspace__call`, which has one), the `canvas` group, and
  `file_draft`. They keep their `tool` step and chips. By design no rows: the
  filesystem verbs on `/drafts/` and `/skills/`, a repeat the fetch guard
  withholds, a call past the round's width cap (it runs next round, with its
  row) and a call to a switched-off source; none of them ran.
- Still open for the filesystem rows: a listing row opens nothing (the Files
  pane has no deep link a row could name yet), and a `grep` row does not say
  which places a gap was in, only that there was one (the model's text does).

### Confirmation

`tests/aiq_agent/common/test_wire_v2.py` and `wire-v2.spec.ts` validate the new
kind against the recorded turns; the producer tests assert one start and one
end per call with the same id; the graph has a `/dev/derivation` variant with the action nodes
with a captured screenshot; the answer suite's report is in the PR.
