---
status: proposed
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# Piloti works the office through its door: workspace state in every turn, a work report, and an eval that measures it

## Context and Problem Statement

ADR-0121 gave Piloti everything a person can do, through four meta-tools on
its own MCP server (`workspace__search`, `__describe`, `__call`,
`__report_missing`). Nothing around those tools changed. The prompt never named
them, the output contract knew only answers to questions (`direct`,
`walkthrough`, `ruling`, `handoff`), a write's proposal vanished from the next
turn unless a person had already decided it (`PROPOSAL_DECISIONS` shows applied
and dismissed rows only), and German requests met an English catalog through a
search that split words at their umlauts.

Measured on 21 October 2026 with the workspace set introduced here (15 rows,
2 runs each, the production search, the boot model `gpt-6-luna` at medium
effort): **6 of 30 runs** did everything the row asked; of 14 expected writes
**none** was proposed through the workspace (3 went through the native file
tool, which the set accepts for this project's files); **32 of 86** searches
found nothing; a run took a median of **5.5 rounds**, **195k input tokens** and
**30 s**. Typical turn: four German searches
for „Projektmitglieder anzeigen", then `report-missing-capability`, then
„diese Funktion ist nicht verfügbar". The same German queries through the
server's own ranking (`workspace-eval.fixture.spec.ts`) return the intended
operation first for **0 of 15**; folded and mapped to the catalog's words,
**15 of 15** return a fitting one.

The person asking expects Piloti to do the office's work in the office's
language, propose what changes, and say what waits for them. The question was
how much of that to build now, and where each part lives.

## Decision Drivers

* The person's expectation: a German request becomes the right proposal in a
  few rounds, and the next turn knows what is pending.
* One source of truth per fact: proposals live in `proposed_changes`; a second
  ledger would drift from it.
* Measured, not argued: every change here is judged on the workspace set.
* ADR-0060(a): the static prompt states facts, not call sequences.

## Considered Options

* Prompt only: teach the four tools and English queries, change nothing else.
* Prompt, a WORKSPACE turn-context block read from the server's records, a
  `work` answer kind, the search fix as a module the server adopts, and an
  eval (chosen).
* All of the above plus a durable work ledger table, a daily brief, a
  `workspace` task kind and new memory kinds, now.

## Decision Outcome

Chosen option: the second, because it closes what the measurement shows is
broken with no new table and no new service, and leaves the larger items to be
judged against a baseline that now exists.

1. **WORKSPACE v1** (`lib/turn-context/workspace-block.ts`) rides every turn's
   context: the asker's organization and project role, the project's name and
   id, whether the conversation is solo or shared, inbox items waiting, runs in
   flight, and this conversation's proposals with every status, `proposed` and
   `failed` included, with why a write failed or what it created. That list is
   the memory of work in progress across turns, read from the record that
   already exists. It renders only when the workspace tools are bound.
2. **`kind: "work"`** joins the envelope, with a `work` field (`done`,
   `proposed` with proposal ids, `blocked` with who is needed, `next`), gated to
   work turns and bounded, rendered after the prose as „Arbeitsstand". A
   workspace record is named, never cited. A `proposed` line whose `ref` is
   not the id of a proposal this turn's writes filed is dropped before the
   person sees it (`answer_envelope.drop_unfiled_proposals`): it would send
   them to decide something that does not exist.
3. **The prompt** leads with the colleague who works in the workspace and gains
   a `<workspace>` section of facts: English queries in the catalog's words, one
   round to find and describe, the next to call, ids from the block, proposals
   never claimed done, which door holds files and memory.
4. **German search** is fixed at its cause in `lib/text/operation-search.ts`:
   both sides folded (`latinize`), each query word read as a group with the
   catalog words the office's term means (`operation-search-vocabulary.json`),
   compounds split, one-letter words dropped. `discovery.ts` ranks with it.
5. **The workspace set** of the answer suite measures all of this, with a door
   served from the catalog production shows and checks on what was filed.
6. **Langfuse**: `answer_kind`, `work_*` counts, the tag `kind:work`, and the
   `work-report-matches` and `work-proposals-unfiled` scores.

### Consequences

* Good, because a follow-up turn sees what it proposed and whether that was
  accepted, without a new table.
* Good, because a work turn reports in a fixed shape the person scans and the
  score checks against what was filed.
* Bad, because the block adds about 250 tokens to every turn that binds the
  workspace tools, and five reads to the turn-context route (each fails open).
* Bad, because the vocabulary is a list someone keeps: a German word it lacks
  still meets only the English words it happens to share. The prompt's English
  queries carry that case.
* Bad, because the proposal list is the newest eight of one conversation: work
  that spans conversations or runs is not in it (the ledger below).

### Confirmation

* `route.spec.ts` (turn context) and `workspace-block.spec.ts` pin the block;
  `workspace-block.fixture.spec.ts` keeps the eval's copy equal to the renderer's.
* `test_answer_envelope_work.py` and `message-answer-meta.spec.ts` read the
  same `work_payload.json`; a renamed field fails one of them.
* `test_workspace_block_prompt.py` and `test_product_framing.py` hold the
  prompt's workspace facts and the role's order.
* `test_workspace_eval.py` holds the eval's search mirror to the TypeScript.
* The workspace set itself, before and after any change to the above.

## More Information

**Measured after: not yet.** The after run on 21 October 2026 failed on every
turn with OpenRouter 402 (the account's credits were spent: 280.05 of 280), so
no after number exists. One smoke run of `ws-two-writes-de` on the changed code
before that showed the shape change (every query English, every search found
operations, the WORKSPACE block in the request) and also the next defect it
fixed in the prompt: a wrong `domain` hid `project-folder-create`, and a call
went out with an empty `input`. Before this record is accepted, run
`task be:eval:answer-suite -- --set workspace --baseline <before>/results.json`
and write the numbers here. The fixture door ranks as the server does, so there
is one ranking to measure (the `--ranking` switch went when `discovery.ts`
adopted the folded scorer).

**The set after the fix waves.** Project roles, sharing and folder access became
`access` operations (ADR-0121), which in-product Piloti neither sees nor
proposes. The rows that asked Piloti to add a project member now expect no write
(`ws-member-add-de`), the two-write row pairs a folder with a rename, the
pending follow-up asks about a folder, and the ambiguity row asks which folder.
The before numbers above were taken on the old rows, so compare the after run
row by row, not by total.

**Deferred, each with what it needs:**

* **`workspace__call` in the steering write set** (`common/steering.WRITE_TOOL_BASENAMES`)
  and `call`/`search` in `turn_status._ACTION_KEYS`, so a steer holds a write
  and the reader sees the step. Small, but it touches the round accounting the
  Piloti AGENTS.md guards with graph tests; its own change.
* **A durable work ledger** (plans, commitments, run outcomes across
  conversations): a BFF table served through turn context. Wait until the set
  has multi-conversation rows that fail for want of it; today's follow-ups pass
  or fail on the block above.
* **A daily brief** as an ADR-0106 wake kind (`daily_brief`), off by default,
  budget-capped. Needs the ledger to say anything the inbox does not.
* **A `workspace` task kind** whose run binds the workspace group (ADR-0108
  runs already carry the envelope). Needs a round budget sized for operations
  first: today's seven research rounds end a ten-write run half done.
* **An operations round budget** and a forced-synthesis anchor that reports
  „these steps done, these remain" instead of „research budget exhausted".
  Measure on the set's two-write and follow-up rows before raising anything.
* **Memory kinds `responsibility`, `commitment`, `routine`** and a reflection
  that learns them from workspace reads. A migration and a vocabulary change in
  `memory-vocabulary.ts`; worth it once the set has rows that need a person's
  role remembered.
* **A `record` grounding kind** with a `medium` ceiling, so an operations answer
  can carry provenance without the citation machinery. The work report covers
  the reporting half today.

Revisit when the workspace set's every-check-held share stops rising with prompt
changes: what remains then is structural (budget, ledger, server search).
