---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner; UI research on how answer products show grounding (October 2026)
informed: everyone working on the answer pipeline
---

# Confidence is the share of claims evidence carries, and the chip leads with it

## Context and Problem Statement

ADR-0125 stamps every sentence of an answer with a provenance class and a claim
type, and held the answer's level to its **weakest** load-bearing sentence (rule
2). Which sentences bear load is decided by the normative detector
(`agents/piloti/grounding.answer_mentions_normative_claim`), a deliberately wide
net that was built as a brake on answers with no citation at all. Run per
sentence and aggregated by a minimum, the net's noise decides the level: one
caught sentence in twenty floors the answer.

Measured on the answers stored in the dev workspace between 2026-10-22 and
2026-10-27 (`conversation-message-list` with `include=metadata`; every answer
computed under rule 2): **8 of 9 surfaced as „low"**, the ninth „medium". Read
sentence by sentence, the floor was set by:

| Answer | Rests on | Floored by |
|---|---|---|
| „was liegt in den foldern" | `list_files`, six record sentences | „Welche Maßstäbe … muss im Einzelnen geöffnet werden." (a next step) |
| „bist du dir sicher" (listing) | `list_files`, four record sentences | „Dazu kommen die 39 Dateien des OIB-Korpus" (a fact about the corpus) |
| „Überblick zur OIB-Richtlinie 2" | five cited or quoted sentences | the table rows under „gliedert sich wie folgt [1]:", each uncited |
| „was weißt du zur oib 2" (Haus Josef) | five cited sentences | „Die Richtlinie ist in Punkte gegliedert." |
| „Grundriss mit vielen Türen" | `ifc_query`, a table cited | an uncited value sentence |
| „was weißt du über das project" | the confirmed project profile in the turn context | every sentence: the profile is no evidence channel |

Three of the nine also carried citations bound to the **wrong document**: the
model wrote `[1]`, `[2]` with no Quellen list, and `verify_citations` synthesised
the list from `registry.all_sources()`, the conversation's cumulative registry,
in registration order. Door counts read from an IFC model were cited to „Erläuterungen
zu OIB-RL 2.2, p.13"; „Punkt 12" to OIB-RL 2.1 p.4. Piloti's model never sees the
registry numbered (grounding blocks number results per call, the already-read
digest is unnumbered), so the positions named nothing. Those sentences counted
as `cited`.

So the number measured „does any sentence trip a lexical net without its own
`[N]`", which is nearly always yes, and in three answers it read misattributed
pointers as evidence.

## Decision Drivers

* A grounded answer must not read low, and an ungrounded one must not read high.
* The laundering rule stays: a record, a measurement, an action or a reading never
  grounds a claim about the law (ADR-0061, ADR-0125, `measurement_sources.py`).
* No product the UI research looked at (ChatGPT, Claude, Perplexity, the legal
  tools of ADR-0125) shows a self-rated confidence level; they show what the
  answer rests on.
* A stored turn keeps rendering under the rule it was computed with.

## Considered Options

* **Narrow the normative detector** so scaffolding sentences stop firing.
* **Weaker floors** under rule 2 (an uncited normative sentence caps at medium).
* **The evidence share** over the same stamps (this record).
* **Records for the project profile**, so the profile-based overview is grounded.

## Decision Outcome

Chosen option: the evidence share, because it changes what the number is OF
rather than which sentences the net catches: one noisy label moves the level
by its weight, not to the floor.

**Rule 3** (`common/claim_provenance.claims_ceiling`, `CONFIDENCE_RULE_VERSION = 3`):

* Each load-bearing sentence contributes its **support**: 1 for a ceiling of
  `high` (a quoted or cited passage, a record, an action or a measurement that
  is not normative), 0.5 for `medium` (a hedge, an observed reading, a record
  with an unmatched number) and for a `reasoning` sentence that is not
  normative (drawn from a cited sentence of its paragraph: a value it repeats, a
  table row under a cited lead-in), 0 for the rest. The per-sentence ceilings of
  ADR-0125 are unchanged; a record or a measurement still never grounds a
  normative sentence, which still contributes 0.
* The answer is **low** when at least half of its load-bearing sentences have
  support 0; **high** when the mean support is at least 0.8 and no load-bearing
  sentence is an uncited normative claim or a dropped pointer
  (`unsupported_claims`); **medium** otherwise. The surfaced level is still
  `min(self-report, this)`, under the hard quote gate.
* A table or a list that a sentence ending in „:" introduces belongs to that
  sentence's paragraph (`_units`), so its rows are `reasoning` when the lead-in is
  cited.
* `verify_citations` no longer reads `[N]` as a registry position when the answer
  has no source list and the caller has no writer-facing list: Piloti passes
  none, and every such number is labelled „[Beleg nicht verifiziert]"
  (`NO_SOURCE_LIST_REASON`). Deep research keeps its writer-facing list.

**The chip leads with the count** (`ConfidenceChip`, version 3): „12 von 14
Aussagen belegt", the load-bearing sentences and those with support 1, read off
the stamps' `support` (on the wire, computed once in the agent). It turns to the
warning tone only when a named cap fired (`answer_confidence_capped_reason`),
and then names it beside the count („· Rechtsaussage ohne Beleg"). The level and
the model's own assessment move to the tooltip. A turn stored under rule 2 keeps
its level label and its copy.

Re-graded under rule 3, the stored answers above: the two listings and the OIB
overview read „medium" (each with its uncited sentence named), the three with
misattributed pointers read „low" with the pointers labelled, the profile
overview stays „low" (below), and the two-claim answer whose second claim is an
uncited sentence about OIB-RL stays „low" (half of it has nothing behind it).

### Consequences

* Good, because one sentence the net catches no longer decides the answer: the
  record-grounded listing reads „medium" with „1 Rechtsaussage ohne Beleg"
  named, where it read „low".
* Good, because a pointer the system could not resolve is labelled where it
  stood instead of being bound to whatever was registered first.
* Good, because the chip says what the answer rests on, in the reader's units.
* Bad, because the laundering guard is now a weight, not a floor, beyond two
  claims: four record sentences beside one uncited legal sentence read „medium",
  not „low" (`TestTheLaunderingPathStaysShut`). The legal sentence itself still
  counts nothing, still blocks „high", and is named on the chip. A `ruling`
  still needs a citation (ADR-0125), so a verdict answer is not reached by this.
* Bad, because the share rewards length: an answer padded with cited
  descriptive sentences does not move it (only load-bearing ones count), but
  many cited values beside one uncited verdict do.
* Bad, because answers that write `[N]` without their Quellen list now show
  labels where they used to show (wrong) sources: three of nine in the sample.
  The prompt already asks for the list; the label is the truth about those
  pointers.
* Bad, because the project profile in the turn context is still no evidence
  channel, so an overview written from it reads „low". Not done here: making the
  confirmed profile a record (`workspace_records`) is a slice of its own.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_confidence_evidence_share.py`: through the
  real `read_file`, source capture and `finalize_answer`, a fully cited answer
  reads „high" and one with a caught next step „medium", never „low"; an uncited
  answer reads „low"; `[N]` without a list is labelled, not resolved to the
  registry; the stored answers above re-graded from
  `tests/fixtures/claim_provenance/stored_answers_2026-10.json`; the laundering
  cases. It fails on rule 2.
* `tests/aiq_agent/common/test_claim_provenance.py` and
  `conversation/test_measurement_confidence.py`: the ceilings, unchanged.
* `ConfidenceChip.spec.tsx` (the count, the named cap, the muted default, the
  fallback without support) and `message-claim-stamps.spec.ts`.
* Langfuse: `claims-evidence-share` in `SCORE_DEFINITIONS`, held to
  `docs/observability/langfuse.md` by `test_langfuse_scores.py`.

## Pros and Cons of the Options

### Narrow the normative detector

* Good, because a false fire is a false fire wherever it lands.
* Bad, because the detector's misses are the liability it exists for, and each
  stem in it was measured (`grounding.py`); the scaffolding sentences use the same
  words as verdicts („muss", „OIB"). Rejected on the premise that no lexical rule
  separates „muss geöffnet werden" from „muss bewilligt werden"; reopen if a
  per-sentence classifier with a measured false-fire rate under 5 % exists.

### Weaker floors under rule 2

* Good, because it is one line.
* Bad, because the minimum is still decided by the noisiest label: every answer
  with a caught sentence reads the same capped level, whatever the rest rests on.

### Records for the project profile

* Good, because the profile is person-confirmed, stronger than a passage for the
  project's own facts.
* Deferred, not rejected: it needs the profile on the record channel (the turn
  context is a prompt string today), and it fixes one answer shape of the nine.

## More Information

* Not measured here: `task be:eval:answer-suite` could not run in the building
  container (no corpus, no Qdrant). It is the first evidence to collect, before
  and after, on a machine with the corpus; `claims-evidence-share` in Langfuse is
  the live one.
* Reopen the thresholds (0.8, half unbacked) when `claims-evidence-share` over
  30 days of live turns shows them splitting answers a reviewer judges alike.
