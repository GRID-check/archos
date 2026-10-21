---
status: accepted
date: 2026-10-21
decision-makers: Grid engineering
consulted: product owner; consultant reports on citations and the Herleitung (October 2026)
informed: everyone working on the answer pipeline
---

# Every sentence shows where it comes from: per-sentence provenance, confidence held to the weakest claim

## Context and Problem Statement

Piloti is growing from a building-law Q&A into the colleague that runs a
planning office's work, and since ADR-0121 it reads and proposes changes to the
whole workspace through one MCP server. The confidence an answer carries was
built for the first job. It was decided for the whole answer by floors
(`markers.surface_answer_confidence`): no verified citation meant "low", a
measurement capped at "medium", and only a cited passage reached "high".

For the second job that rule is wrong in a way the reader sees. „Anna Berger hat
drei offene Freigaben", read straight from the server, surfaced as "low" with
„Antwort nicht durch Quellen belegt", although a server record is stronger
evidence than any passage. Measured offline on thirteen answer shapes run
through the real pipeline (the record channel below, unchanged prose): rule 1
surfaces **6 of 6** workspace answers as "low"; the per-sentence rule surfaces
1 of 6, the one that also states the law without a source.

Four further defects sat in the same place:

- The verifier deleted an unresolvable `[N]` silently. The sentence stayed and
  read like every other unmarked sentence, so the signal was lost, not the claim.
- A single-source fallback attached the registry's one source when no citation
  survived. The registry is cumulative across the conversation, so that source
  could be two turns old and about another question: the one place the system
  invented an attribution.
- A lookup that found nothing replaced the whole answer with a canned refusal,
  whatever the answer said (`sources-empty` true on 9 of 32 scored turns in the
  last 30 days, PostHog export of the Langfuse scores, 2026-10-21).
- Nothing checked that a § or Punkt written beside `[N]` is in the passage the
  number resolves to, and a quote that dropped „k" from „keine" or „un" from
  „unzulässig" scored as verbatim (T2-CIT1, the sub-word half).

## Decision Drivers

* The architect signs the Einreichung, Piloti does not: a pointer, a quote and a
  legal value must stay strict.
* A record, an action or a measurement grounds facts about the office and the
  building, never a claim about the law. The laundering path ADR-0061,
  `measurement_sources.py` and `grounding.py` closed must stay closed.
* The field is strict on pointers and quotes and shows support per assertion; we
  found no verifiable vendor that deletes uncited prose (Harvey BigLaw Bench and
  LAB-AA, the Anthropic Citations API, CoCounsel Verify, Lexis+ Protégé).
* A stored turn must keep rendering under the rule it was computed with.

## Considered Options

* **Keep the floors**, and add a record exception to them.
* **Per-sentence provenance, confidence as the weakest load-bearing sentence**
  (this record).
* **Records as citable sources in the `SourceRegistry`**, cited with `[N]` like a
  passage (the Herleitung report's item 2).

## Decision Outcome

Chosen option: per-sentence provenance, because it is the only one that grounds
a workspace answer without letting that grounding reach a sentence about the law.

Each sentence of the final answer gets two labels (`common/claim_provenance.py`):

- a **provenance class**, the strongest that applies: `cited_dropped` (it carries
  the label the verifier left where a citation did not resolve), `quoted` (a
  verbatim-stamped quote line, or an inline quote of a cited passage the check
  passed), `cited`, `action` (it reports a proposal this turn filed), `record`
  (its names, numbers or states match a workspace record this turn read),
  `measured`, `reasoning` (no pointer, but a cited sentence in its paragraph),
  `model_knowledge`;
- a **claim type**: `normative` (the existing detector, per sentence), `value`
  (a number, a class, a Frist) or `descriptive`.

The confidence (rule 2, `markers.surface_claim_confidence`) is
`min(self-report, min over load-bearing sentences of ceiling(class, type))`,
under the hard quote gate. Load-bearing are the normative and value sentences,
or all sentences when there are none. The ceiling is `high` for quoted and cited
sentences of any type, and for record, action and measured sentences that are not
normative; `medium` for reasoning, for descriptive model knowledge, and for a
record sentence stating a number no record holds; `low` for any normative
sentence without a passage, any value sentence without evidence of its own, and
every `cited_dropped` sentence. The record and measurement value ceiling departs
from the consultant formula's "low for any value not quoted or cited" on
purpose: a record is the evidence for a count of approvals, and a measurement
for a height.

Records travel their own channel (`common/workspace_records.py`), read off this
turn's `workspace__call` results in the transcript, and never enter the
`SourceRegistry`.

Kept hard: a verbatim quote must match (marker, patch, stamp; now also its
polarity); a pointer must resolve to what it names (now also its locus); trailer
values need a source; `kind=ruling` needs a citation; a record or measurement
never grounds a normative sentence.

Changed alongside:

- **Strip and label.** An unresolvable `[N]`, or one whose § / Punkt the cited
  passage does not hold, is replaced by „[Beleg nicht verifiziert]" where it
  stood (`verify_citations(label_dropped=True, check_locus=True)`).
- **The single-source fallback is removed.**
- **A lookup that found nothing** ships the answer with every unsupported sentence
  labelled `model_knowledge` and a note under it
  (`TurnResult.lookup_found_nothing`). A `ruling` is still refused.
- **Quote polarity** (`common/quote_polarity.py`): a quote whose aligned passage
  stretch negates or restricts something else is not verbatim.
- **A work turn** (`kind: "work"`, ADR-0122) is judged by the same rule. It is
  not a legal answer: its sentences rest on what it read (`record`) and
  proposed (`action`), so it reaches the model's own level, and a sentence about
  the law inside it still needs a passage. The name a proposal was filed with
  („den Ordner Brandschutz") is the proposal's data and is left out before the
  claim type is decided, like the zu-infinitive; an input that is long or
  prescriptive stays in (`claim_provenance._proposal_names`).
- **A workspace read is a step of the Herleitung.** `workspace__call` records
  each read that answered as a lane hit (`shelf: "workspace"`, the operation as
  its name); the Herleitung words it for the reader („Aus dem Arbeitsbereich
  gelesen") with the operation beneath, never as a file. A proposal or a
  refusal is not recorded.
- **The wire** carries `claim_stamps` and `answer_confidence_version` (2).
  A turn stored without the version renders under rule 1, and deep research,
  which has no per-sentence stamps yet, keeps rule 1.

### Consequences

* Good, because a workspace answer read from records reaches the model's own
  level, and the reader sees why ("3 Aussagen belegt · 1 Rechtsaussage ohne Beleg").
* Good, because a measured, purely descriptive answer is no longer held at
  "medium" for want of a per-sentence split, while a verdict beside it still floors.
* Good, because no source the model did not cite is attached, and a dropped
  pointer is visible where it stood.
* Bad, because the normative detector now runs per sentence and fires on about 13 %
  of descriptive sentences (25 of 190 in the corpus measurement in
  `grounding.py`): such a sentence floors the answer as an uncited legal claim.
  Before, the same false fire floored the whole answer only when no citation
  survived anywhere.
* Bad, because record matching is lexical (two shared words or one number). A
  coincidental match can stamp a sentence `record`; it cannot ground the law.
* Bad, because the locus check can label a correct citation whose chunk does not
  carry the Punkt it belongs to. Fail-open only for entries with no text and no clause.
* Bad, because an unsourced answer is now shown. The note says so; a ruling is not.

### Confirmation

* `tests/aiq_agent/common/test_claim_provenance.py`: every class from its
  evidence, every ceiling, the load-bearing rule.
* `tests/aiq_agent/agents/piloti/test_claim_provenance_pipeline.py`: through
  `finalize_answer`, a record grounds a workspace answer, never a legal sentence,
  never enters the registry, last turn's read grounds nothing, the scores are written.
* `tests/aiq_agent/common/test_citation_strictness.py`: label, locus, polarity.
* `test_claim_provenance_pipeline.py` (work turns) and `test_claim_provenance.py`
  (proposal names); `tests/aiq_agent/tools/workspace/test_workspace_cards.py` and
  `SourceCard.workspace.spec.tsx` for the read in the Herleitung.
* `tests/aiq_agent/agents/piloti/conversation/test_measurement_confidence.py`
  `TestRuleTwoKeepsTheLaunderingPathShut`: a measurement grounds the number, not the verdict.
* `test_agent.py`: a ruling whose lookup found nothing is refused; nothing uncited is appended.
* Langfuse: `claims-by-class`, `claims-normative-uncited`, `citations-dropped-labelled`
  in `SCORE_DEFINITIONS`, held to `docs/observability/langfuse.md` by `test_langfuse_scores.py`.

## Pros and Cons of the Options

### Keep the floors, with a record exception

* Good, because it is a two-line change to `markers.py`.
* Bad, because a record exception at answer level is the laundering path again:
  one record read lifts a legal sentence beside it.

### Records as citable sources in the `SourceRegistry`

* Good, because the chip and `[N]` machinery already exist.
* Bad, because `[N]` resolving through the registry is what "high" and
  `EmptySourceRegistryError` mean. A record there grounds a verdict the way a
  measurement in it would (`tools/bim/measurement_sources.py` says why), and a
  turn that read the task list and retrieved nothing would stop reporting the
  failure. Deferred: a record chip that opens the object belongs to a later
  slice, on the record channel, not in the registry.

## More Information

* Inputs: the consultant reports on citations (Harvey and peers, current hard
  limits, the proposed model) and on the Herleitung (workspace reads as trace
  steps and records), October 2026.
* Supersedes the "keep" verdict on row 21 of the hobble register
  (`docs/architecture/hobble-register-2026-09.md`): verification now labels
  instead of only removing, and the confidence ceiling is per sentence.
* Reopen passage-id citations (repair option F) if `citations-dropped-labelled`
  exceeds about 5 % of cited sentences; reopen inline support checking if the
  offline judge shows misgrounded citations above about 5 %.
* Not measured here: the answer suite could not run in the building container
  (no corpus under `data/oib`, no Qdrant, no Docker), and no live workspace turn
  exists in the last 30 days of exported traces. Both are the first evidence to
  collect after merge.
