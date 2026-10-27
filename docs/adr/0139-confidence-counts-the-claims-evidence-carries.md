---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner; UI research on how answer products show grounding (October 2026); three independent reviews of PR #1231
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

The answers stored in the dev workspace between 2026-10-22 and 2026-10-27
(`conversation-message-list` with `include=metadata,citations`, `passage-read`
for the page text) are the fixture
`tests/fixtures/claim_provenance/stored_answers_2026-10.json`. All but one read
„low" under rule 2, and four of those five kinds were good answers grounded in
what the turn read:

* **Listings.** `list_files` answers, every row a record, floored by a next
  step the net catches („Welche Maßstäbe … muss im Einzelnen geöffnet werden.").
* **The project overview.** Written from the confirmed project profile in the
  turn context, which was no evidence channel, so 0 of 5 counted.
* **Registry citations.** Three answers wrote `[1]`, `[2]` with no Quellen list,
  and `verify_citations` read them as positions in the conversation's cumulative
  registry: drawings cited to OIB p.4, „Punkt 12" to OIB-RL 2.1 p.4. Piloti's
  model never sees that numbering.
* **OIB overviews.** Cited and quoted, floored by the rows of a table of
  contents under a cited lead-in.

The first two rounds of this record (a mean share with thresholds, then a count
with a word-list verdict cap) moved the number without fixing those four: the
second still read a listing „Rechtsaussage ohne Beleg" for its next step, the
profile overview „0 von 5", a dropped marker zeroed a sentence its record backed,
and a multi-block turn's numbers were labelled wholesale.

## Decision Drivers

* A grounded answer must not read low, and an ungrounded one must not read high.
* The laundering rule stays: a record, a measurement, an action or a reading never
  grounds a verdict on the law (ADR-0061, ADR-0125, `measurement_sources.py`).
  Neither does a hedge.
* A next step asserts nothing the answer could be wrong about; it is no claim.
* No product the UI research looked at (ChatGPT, Claude, Perplexity, the legal
  tools of ADR-0125) shows a self-rated confidence level; they show what the
  answer rests on. The chip and the level must say the same thing.
* A tab opened before a deploy keeps reading the turns the new server finishes
  (`docs/design/chat-wire-v2.md`, „Compatibility").
* A stored turn keeps rendering under the rule it was computed with.

## Considered Options

* **Narrow the normative detector** so scaffolding sentences stop firing.
* **Weaker floors** under rule 2 (an uncited normative sentence caps at medium).
* **A mean evidence share with thresholds** (high at a mean of 0.8).
* **Count the backed claims, with verdicts, next steps and the profile told apart** (this record).

## Decision Outcome

Chosen option: count the backed claims, because it changes what the number is
OF rather than which sentences the net catches, and the chip's count and the
level say the same thing: „14 von 14 belegt" is high, and nothing less is.

**What a sentence is** (`common/claim_provenance.py`):

* A **next step**, a question left open, an offer or the answer's account of
  its own reading (`is_next_step`: „Ob … muss … geprüft werden", „Als Nächstes
  …", „Eine kurze Nachricht genügt", „Nicht gelesen habe ich …") bears no load.
* A **verdict** (`states_verdict`) is a normative sentence that concludes
  something about the law: a verdict word („erfüllt", „nötig", „zu schmal",
  „vorzulegen", „einschlägig", „genügt"), or a requirement's modal beside a value
  or a named instrument („muss mindestens 1,20 m breit sein", „muss nach § 5
  bewilligt werden", „gilt § 5"). Only a passage grounds a verdict.
* Any other normative sentence the net catches („Die Höhen widersprechen
  sich", „Gebäudeklasse · GK 5 (bestätigt)") concludes nothing and is held like
  a value, to the evidence it restates: a passage, a record, an action or a
  measurement.
* A pointer that did not hold (`[Beleg nicht verifiziert]`, or a number nothing
  resolves) is a **flag** (`dropped`), not a class: the sentence is classed by
  what else stands behind it, so a file name read off this turn's listing stays a
  record. The chip names the flag.
* The rows of a table or a list under a lead-in, with that lead-in, are **one
  claim** (`group`, `claim_supports`) with the mean of their supports. A row
  stating a number counts half only when the passage its lead-in cites holds the
  number and half its key words.

**Rule 3** (`claims_ceiling`), over the claims:

* **high** when every claim has support 1.
* **low** when a strict majority have support 0, or when an uncited verdict
  stands and none of the answer's normative sentences has a passage: a
  measurement of 1,10 m beside „Die Treppe ist damit zu schmal." reads low.
* **medium** otherwise. The surfaced level is still `min(self-report, this)`,
  under the hard quote gate.

**The confirmed project profile is a record** (`workspace_records.profile_record`):
the `confirmed:` rows of the turn context's `PROJECT_CONTEXT v1`, the same text
the prompt renders, one item per row, each token followed by the German the
answer writes it in (`_PROFILE_WORDS`). A confirmed building class or
Fluchtniveau restated („Gebäudeklasse · GK 5 (bestätigt)") is a value the person
confirmed in the intake, so the record grounds it; a verdict drawn from it
(„Damit ist eine Holzbauweise zulässig") still needs a passage. Notes
(`PROJECT_MEMORY`), unknowns and assumptions are no record.

**`[N]` with no source list** resolves against this turn's passages, never the
registry: a turn numbers its passages on across its blocks
(`grounding_block._reserve_result_numbers`), so „Result 3" names one passage;
a sentence that names a file the turn read settles its number to that file; a
number two blocks printed (a replay, a block from before this change) is
settled by the passage whose text the sentence reads like
(`citation_verification.resolve_unlisted_numbers`). Only a number nothing
settles is labelled. The list that resolves is appended as the answer's
sources, so the reader always gets the Quellen list the prompt asks for.

**On the wire** the turn keeps `answer_confidence_version: 2`; the stamps'
`support` says rule 3, and `verdict`, `dropped` and `group` ride beside it. An
open tab's bundle reads the version as `1 | 2` and would drop a `RUN_FINISHED`
carrying 3; an unknown key on a stamp it strips. `test_wire_v2_open_tabs.py`
checks a rule-3 frame against the previous schema.

**The chip leads with the count** (`ConfidenceChip`): „12 von 14 Aussagen
belegt", the claims and those backed whole. It warns on an uncited verdict
(„· Rechtsaussage ohne Beleg"), else a pointer that did not hold („· Beleg
nicht verifiziert"), else a named cap on the self-report, whatever the model
said of itself. A next step is never named. The level and the model's own
assessment move to the tooltip. A turn stored under rule 2 keeps its level
label and its copy.

Re-graded (the fixture's `expected`; rule 2 in brackets):

| Answer | Rule 3 | Backed claims |
|---|---|---|
| „was liegt in den foldern" (low) | high | 6 of 6, the next step bears no load |
| „bist du dir sicher" listing (low) | medium | 4 of 5: „39 Dateien des OIB-Korpus" is in no record the stamps held |
| door count, follow-up (low) | medium | 1 of 2: the IFC summary is cited; the sentence about the earlier sources has nothing |
| project overview (low) | medium | 10 of 13 off the profile; a restated memory note has nothing, two hedges count half |
| OIB-RL 2 overview, 10-27 (low) | medium | 7 of 10; the outline list is one claim, partly on page 4 |
| OIB-RL 2 overview, 10-23 (low) | medium | 3 of 7; the Gliederung table is one claim, mostly not on page 4 |
| plans, 10-23 (low) | medium | 5 of 6, each drawing resolved by the file it names (the listing record is not stored: a lower bound) |
| OIB-RL 2 overview, 10-22 (low) | medium | 7 of 9; one uncited verdict named |
| Haus Josef, 10-22 (low) | medium | 2 of 7; [2] settled by content to Punkt 12 p.23, not OIB-RL 2.1 p.4 |
| views with doors, 10-22 (medium) | high | 2 of 2, a regression guard |

### Consequences

* Good, because a listing reads high and names nothing, and a profile overview
  rests on what the person confirmed.
* Good, because a pointer that did not hold no longer erases the record or the
  measurement behind its sentence, and a multi-block turn's numbers resolve.
* Good, because the chip's count and the level agree, and the chip names an
  uncited verdict even when the self-report was already as low as the evidence
  allows.
* Good, because a hedge („Nach meiner Einschätzung …") lifts no uncited verdict.
* Bad, because `states_verdict` and `is_next_step` are word lists. A verdict
  phrased without their stems reads as a non-verdict: it still needs evidence of
  its own to count, but a record beside it would ground it, and the „low" cap
  misses it. A next step phrased as a rule („Die Fassade ist zu prüfen" reads as
  a next step, „Die Fassade ist zu dämmen" does not) is the mirror risk.
* Bad, because `_PROFILE_WORDS` mirrors the intake's labels by hand: a token
  missing from it matches on numbers and its own spelling only.
* Bad, because the content fallback for `[N]` is lexical: a number whose
  sentence names a file the turn read is bound to that file, even when the
  model meant another passage beside it.
* Bad, because one Einschätzung keeps an otherwise backed answer at „medium":
  „high" means every claim.
* Bad, because the project profile only reaches a turn as the context text, so
  a row phrased in German the vocabulary lacks counts nothing.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_confidence_evidence_share.py`: through the
  real `read_file`, source capture and `finalize_answer`; the stored answers
  re-graded; every probe of the reviews of #1231 (next steps, verdicts the net
  misses or overreaches on, a dropped marker beside a record, the profile, a
  table as one claim, numbering across blocks, the laundering cases).
* `tests/aiq_agent/common/test_wire_v2_open_tabs.py`: a rule-3 `RUN_FINISHED`
  parses under the previous schema, and a version 3 would not.
* `tests/aiq_agent/common/test_claim_provenance.py`, `test_claim_provenance_looks.py`,
  `test_claim_provenance_pipeline.py` and
  `conversation/test_measurement_confidence.py`: the ceilings.
* `ConfidenceChip.spec.tsx` and `message-claim-stamps.spec.ts`: the count over
  claims, the warning on an uncited verdict only, the dropped flag.
* Langfuse: `claims-evidence-share` in `SCORE_DEFINITIONS`, held to
  `docs/observability/langfuse.md` by `test_langfuse_scores.py`. Its score
  config reaches Langfuse through `task langfuse:provision -- --apply`, which
  needs the owner's go-ahead.

## Pros and Cons of the Options

### Narrow the normative detector

* Good, because a false fire is a false fire wherever it lands.
* Bad, because the detector's misses are the liability it exists for, and each
  stem in it was measured (`grounding.py`). Rejected on the premise that its job
  is the brake on uncited answers; the finer question, whether a sentence
  concludes something, is `states_verdict`'s, where a miss costs a level, not a
  brake. Reopen if a per-sentence classifier with a measured false-fire rate
  under 5 % exists.

### Weaker floors under rule 2

* Good, because it is one line.
* Bad, because the minimum is still decided by the noisiest label.

### A mean evidence share with thresholds

* Good, because one noisy label moves the level by its weight.
* Bad, because the review of #1231 found it porous on three measured probes: a
  hedged uncited verdict read „high", an invented table under a cited lead-in
  earned half per row, four measurements outweighed an uncited verdict. The 0.8
  also made the chip's count and the level disagree. Rejected.

## More Information

* Not measured here: `task be:eval:answer-suite` could not run in the building
  container (no corpus, no Qdrant). It is the first evidence to collect, before
  and after, on a machine with the corpus; it is an owner step.
* Reopen the word lists (`states_verdict`, `is_next_step`, `_PROFILE_WORDS`) when
  30 days of live turns show answers a reviewer judges alike split by them.
