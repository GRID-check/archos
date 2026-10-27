---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner; UI research on how answer products show grounding (October 2026); an independent review of PR #1231
informed: everyone working on the answer pipeline
---

# Confidence counts the claims evidence carries, and the chip leads with it

## Context and Problem Statement

ADR-0125 stamps every sentence of an answer with a provenance class and a claim
type, and held the answer's level to its **weakest** load-bearing sentence (rule
2). Which sentences bear load is decided by the normative detector
(`agents/piloti/grounding.answer_mentions_normative_claim`), a deliberately wide
net built as a brake on answers with no citation at all. Run per sentence and
aggregated by a minimum, the net's noise decides the level: one caught sentence
in twenty floors the answer.

The nine answers stored in the dev workspace between 2026-10-22 and 2026-10-27
(`conversation-message-list` with `include=metadata,citations`; each computed
under rule 2) all surfaced as „low". They are the fixture
`tests/fixtures/claim_provenance/stored_answers_2026-10.json`. Read sentence by
sentence:

| Answer | Rests on | What rule 2 floored it on |
|---|---|---|
| „was liegt in den foldern" | `list_files`, six record sentences | „Welche Maßstäbe … muss im Einzelnen geöffnet werden." (a next step) |
| „bist du dir sicher" (listing) | `list_files`, four record sentences | „Dazu kommen die 39 Dateien des OIB-Korpus" (a fact about the corpus) |
| „achso ne ich meinte wirklich eher ein pdf" (doors) | one pointer, to the wrong document | everything |
| „was weißt du über das project" | the confirmed project profile in the turn context | every sentence: the profile is no evidence channel |
| „Was weißt du über die OIB-Richtlinie 2?" (10-27) | a cited table of the four parts, two Erläuterungen passages | a list under „im Überblick [1]:" and two next steps |
| „was weißt du über die oib 2" (10-23) | five cited or quoted sentences | the Gliederung table under „gliedert sich wie folgt [1]:" |
| Grundrisse, Schnitte, Ansichten (10-23) | pointers to the wrong documents | everything |
| „was weißt du zu roib 2" (10-22) | eight cited sentences | one uncited verdict, one dropped citation |
| „was weißt du zur oib 2" (Haus Josef, 10-22) | pointers to the wrong documents | „Die Richtlinie ist in Punkte gegliedert." |

Three of the nine carried citations bound to the **wrong document**: the model
wrote `[1]`, `[2]` with no Quellen list, and `verify_citations` synthesised the
list from `registry.all_sources()`, the conversation's cumulative registry, in
registration order. Door counts read from an IFC model were cited to an OIB
explanatory note; drawings to OIB p.4; „Punkt 12" to OIB-RL 2.1 p.4. Piloti's
model never sees the registry numbered, so the positions named nothing, and
those sentences counted as `cited`.

So the number measured „does any sentence trip a lexical net without its own
`[N]`", which is nearly always yes, and in three answers it read misattributed
pointers as evidence.

## Decision Drivers

* A grounded answer must not read low, and an ungrounded one must not read high.
* The laundering rule stays: a record, a measurement, an action or a reading never
  grounds a claim about the law (ADR-0061, ADR-0125, `measurement_sources.py`).
  Neither does a hedge.
* No product the UI research looked at (ChatGPT, Claude, Perplexity, the legal
  tools of ADR-0125) shows a self-rated confidence level; they show what the
  answer rests on. The chip and the level must say the same thing.
* A tab opened before a deploy keeps reading the turns the new server finishes
  (`docs/design/chat-wire-v2.md`, „Compatibility").
* A stored turn keeps rendering under the rule it was computed with.

## Considered Options

* **Narrow the normative detector** so scaffolding sentences stop firing.
* **Weaker floors** under rule 2 (an uncited normative sentence caps at medium).
* **A mean evidence share with thresholds** (high at a mean of 0.8): the first
  version of this record.
* **Count the backed claims** (this record).
* **Records for the project profile**, so the profile-based overview is grounded.

## Decision Outcome

Chosen option: count the backed claims, because it changes what the number is
OF rather than which sentences the net catches, and the chip's count and the
level then say the same thing: „14 von 14 belegt" is high, and nothing less is.

**Rule 3** (`common/claim_provenance.claims_ceiling`):

* Each load-bearing sentence has a **support** (`support`): 1 for a ceiling of
  `high` (a quoted or cited passage; a record, an action or a measurement that
  is not normative), 0.5 for `medium` (a non-normative hedge, an observed
  reading, a record with an unmatched number) and for a `reasoning` sentence that
  is not normative and is drawn from the passage its paragraph cites, 0 for the
  rest. A normative sentence without a passage is 0 whatever it rests on, hedged
  or not: a hedge is no source.
* **high** when every load-bearing sentence has support 1.
* **low** when a strict majority of them have support 0, or when the answer
  states a legal conclusion (`states_verdict`: met, needed, allowed, or a
  requirement's modal beside a value or a named instrument) and none of its
  normative sentences has a passage. A measurement or a record beside an uncited
  verdict does not lift it, however many there are.
* **medium** otherwise. The surfaced level is still `min(self-report, this)`,
  under the hard quote gate.
* A `reasoning` sentence that states a number counts half only when the passage
  text its paragraph's citations resolved to (`ClaimEvidence.passages`) holds
  every number it states and half its key words; one stating no number counts
  half as before. A table or a list that a sentence ending in „:" introduces
  belongs to that sentence's paragraph across the blank line before it, and the
  lead-in ends at the first blank line after its block.
* An `[N]` with no source list resolves to the N-th passage of this turn's
  numbered grounding block when the turn read exactly one; with none or several
  it is labelled „[Beleg nicht verifiziert]" (`turn_numbering`,
  `NO_SOURCE_LIST_REASON`). Never by registry position. Deep research keeps its
  writer-facing list.
* The mean support is still computed, as the Langfuse score
  `claims-evidence-share`: the trend a calibration reads, not a threshold.

**On the wire** the turn keeps `answer_confidence_version: 2`; the stamps'
`support` says rule 3. An open tab's bundle reads the field as `1 | 2`, and a 3
would make it drop the `RUN_FINISHED` and reload. An unknown key on a stamp is
stripped, so `support` is safe. `test_wire_v2_open_tabs.py` checks a rule-3
frame against the schema as it stood before this record.

**The chip leads with the count** (`ConfidenceChip`): „12 von 14 Aussagen
belegt", the load-bearing sentences and those with support 1. It warns when the
stamps call for it, whatever the model said of itself: an uncited statement about
the law („· Rechtsaussage ohne Beleg"), else a citation that did not hold
(„· Beleg nicht verifiziert"), else a named cap on the self-report. The level and
the model's own assessment move to the tooltip. A turn stored under rule 2 keeps
its level label and its copy.

Re-graded under rule 3 (the fixture's `expected`): the two listings, the 10-27
overview and the 10-22 overview read „medium", each with its uncited sentence
named; the three with misattributed pointers, the profile overview and the 10-23
overview read „low". The 10-23 overview is „low" because the Gliederung table its
lead-in cites is not on the cited page (p.4 holds the Vorbemerkungen): rule 2 was
right there, for the wrong reason.

### Consequences

* Good, because one sentence the net catches no longer decides the answer: the
  record-grounded listing reads „6 von 7 Aussagen belegt · Rechtsaussage ohne
  Beleg", medium, where it read „low".
* Good, because a pointer the system could not resolve is labelled where it
  stood instead of being bound to whatever was registered first.
* Good, because the chip's count and the level agree, and the chip names an
  uncited verdict even when the model's self-report was already as low as the
  evidence allows.
* Good, because a hedge („Nach meiner Einschätzung …") no longer lifts an uncited
  verdict: in the first version of this record such an answer read „high".
* Bad, because `states_verdict` is a word list. A legal conclusion phrased
  without one of its stems or a modal beside a value reads as a next step, and
  the answer can reach „medium" beside enough backed sentences; the sentence
  still counts 0, blocks „high" and is named on the chip. A `ruling` still needs
  a citation (ADR-0125).
* Bad, because an honest absence the normative net catches („der Abstand ist in
  keinem Dokument nachgewiesen", in an answer about the law) now counts 0 and is
  named „Rechtsaussage ohne Beleg", where ADR-0125's amendment let it count half.
* Bad, because the content check reads the passage text the turn held, and a
  row the passage holds in other words (a paraphrase, a number written out)
  counts nothing.
* Bad, because one Einschätzung keeps an otherwise cited answer at „medium":
  „high" now means every claim, not most.
* Bad, because answers that write `[N]` without their Quellen list over more
  than one block show labels where they used to show (wrong) sources: three of
  nine in the fixture. The prompt already asks for the list; the label is the
  truth about those pointers.
* Bad, because the project profile in the turn context is still no evidence
  channel, so an overview written from it reads „low". Making the confirmed
  profile a record (`workspace_records`) is a slice of its own.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_confidence_evidence_share.py`: through the
  real `read_file`, source capture and `finalize_answer`, a fully cited answer
  reads „high" and one with a caught next step „medium"; an uncited answer reads
  „low"; `[N]` without a list resolves in a one-block turn and is labelled in a
  two-block one; the nine stored answers re-graded; each probe of the review of
  #1231 (a hedged verdict, an invented table under a cited lead-in, a lead-in
  leaking past its block, a short grounded answer, the laundering cases).
* `tests/aiq_agent/common/test_wire_v2_open_tabs.py`: a rule-3 `RUN_FINISHED`
  parses under the previous schema, and a version 3 would not.
* `tests/aiq_agent/common/test_claim_provenance.py`,
  `test_claim_provenance_pipeline.py` and
  `conversation/test_measurement_confidence.py`: the ceilings.
* `ConfidenceChip.spec.tsx` (the count, the warning read off the stamps, the
  muted default, the fallback without support) and `message-claim-stamps.spec.ts`.
* Langfuse: `claims-evidence-share` in `SCORE_DEFINITIONS`, held to
  `docs/observability/langfuse.md` by `test_langfuse_scores.py`. Its score
  config reaches Langfuse through `task langfuse:provision -- --apply`, which
  needs the owner's go-ahead.

## Pros and Cons of the Options

### Narrow the normative detector

* Good, because a false fire is a false fire wherever it lands.
* Bad, because the detector's misses are the liability it exists for, and each
  stem in it was measured (`grounding.py`); the scaffolding sentences use the same
  words as verdicts („muss", „OIB"). Rejected on the premise that no lexical rule
  separates „muss geöffnet werden" from „muss bewilligt werden" well enough to
  decide which sentences bear load; `states_verdict` only decides which uncited
  sentence floors an answer, where a miss costs a level, not a brake. Reopen if a
  per-sentence classifier with a measured false-fire rate under 5 % exists.

### Weaker floors under rule 2

* Good, because it is one line.
* Bad, because the minimum is still decided by the noisiest label: every answer
  with a caught sentence reads the same capped level, whatever the rest rests on.

### A mean evidence share with thresholds

* Good, because one noisy label moves the level by its weight.
* Bad, because the review of #1231 found it porous on the premise of three
  measured probes: a hedged uncited verdict beside cited sentences read „high"
  (hedges counted half and were exempt from the uncited-law list), an invented
  table under a cited lead-in earned half per row, and four measurements
  outweighed an uncited verdict to „medium". The 0.8 also made the chip's
  „12 von 14" and the level disagree. Rejected.

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
* Reopen the strict-majority cut and `states_verdict` when 30 days of live
  turns show answers a reviewer judges alike split by them.
