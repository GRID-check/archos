---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner; UI research on how answer products show grounding (October 2026); four independent reviews of PR #1231
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

The first rounds of this record (a mean share with thresholds, then a count
with a word-list verdict cap, then word lists that told next steps and the
profile apart) moved the number without making it safe: the third let two
uncited legal statements read high, one behind a next-step opener („Wo das
Fluchtniveau über 11 m liegt, ist ein Brandschutzkonzept erforderlich"), one
grounded by a profile row that happened to hold its number.

## Decision Drivers

* High means every load-bearing claim rests on evidence whose content was
  checked. Every heuristic fails safe: where a word list or a matcher is unsure,
  a claim drops to half, it never climbs to whole. A grounded answer should not
  read low, but that is the weaker promise and yields to the first.
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
  Narrow on purpose, because a verdict read as a next step would lift the
  answer: never when the main clause holds a verdict word, and after „ob" or
  „welche" a modal only beside a verb of checking („muss geprüft werden", not
  „muss REI 90 aufweisen").
* A **verdict** (`states_verdict`) is a normative sentence that concludes
  something about the law, read wide, because a false hit only asks for a
  passage: a verdict word („erfüllt", „nötig", „gefordert", „Pflicht",
  „maßgeblich", „zu schmal."), a requirement's modal („muss eingebaut werden",
  „darf nicht", „es braucht", „ist vorzulegen"), or „gilt"/„genügt" beside a
  named instrument. Only a passage grounds a verdict.
* Any other normative sentence the net catches („Die Höhen widersprechen
  sich", „Gebäudeklasse · GK 5 (bestätigt)") may be a verdict the lists miss,
  so a record, an action, a measurement or a reading backs it half, never
  whole; only a passage that holds it backs it whole.
* A **citation counts whole only when its passage holds the sentence**
  (`passage_holds`: every number the sentence states and at least half its key
  words, the file it names left out), half when the words are missing, and
  nothing when the passage has text and lacks a number the sentence states
  (`misnumbered`: „R 60" cited to a page that holds only the table's caption).
* A pointer that did not hold (`[Beleg nicht verifiziert]`, or a number nothing
  resolves) is a **flag** (`dropped`), not a class: the sentence is classed by
  what else stands behind it, so a file name read off this turn's listing stays
  a record, and it counts half at most. The chip names the flag.
* The rows of a table or a list under a lead-in, with that lead-in, are **one
  claim** (`group`, `claim_supports`) with the mean of its rows' supports; the
  lead-in is not a row, so a cited lead-in lifts no invented row. A row stating
  a number counts half only when the passage its lead-in cites holds it.

**Rule 3** (`claims_ceiling`), over the claims:

* **high** when every claim has support 1.
* **low** when a strict majority have support below 0.5, or when an uncited
  verdict stands and no normative sentence of the answer is held by its
  passage: a measurement of 1,10 m beside „Die Treppe ist damit zu schmal."
  reads low.
* **medium** otherwise. The surfaced level is still `min(self-report, this)`,
  under the hard quote gate.

**The confirmed project profile is a record** (`workspace_records.profile_record`):
the `confirmed:` rows of the turn context's `PROJECT_CONTEXT v1`, the same text
the prompt renders, one item per row, each token followed by its German: the
name the profile stored before migration 0159 (`profile_names`, held to
`legacy-names.json`), plus a short table of spoken forms
(`_PROFILE_SPOKEN`) whose tokens a test holds to the intake's sources. A number
counts only in the row that also holds one of the sentence's words, so „3
Stiegenhäuser" is no reading of a profile that holds a 3 somewhere. A
restated value row („Geschoße · 5 oberirdisch") is backed; a row the net
reads normative („Gebäudeklasse · GK 5 (bestätigt)") half; a verdict drawn
from either („Damit ist eine Holzbauweise zulässig") needs a passage. Notes
(`PROJECT_MEMORY`), unknowns, assumptions and contested facts (the
`contested:` section, a fact with alternatives) are no record. **The turn
context's document inventory** is a record the same way, one item per shelf
(`inventory_record`): „Im Basiswissen liegen 39 Dateien" is read off it.

**`[N]` with no source list** resolves against this turn's passages, never the
registry, and by content (`citation_verification.resolve_unlisted_numbers`):
`[N]` names the passage of the turn that holds every sentence carrying it
(`passage_holds`). Each block numbers its results from 1, so the model's
numbers collide and follow neither the blocks nor the registry; the printed
number only breaks a tie between passages that both hold the sentences. A
number no passage holds, or two hold equally, is labelled. The list that
resolves is appended as the answer's sources.

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

Re-graded (the fixture's `expected`; rule 2 in brackets; „backed" is support 1):

| Answer | Rule 3 | Backed claims |
|---|---|---|
| „was liegt in den foldern" (low) | high | 6 of 6, the next step bears no load |
| „bist du dir sicher" listing (low) | medium | 4 of 5: „39 Dateien des OIB-Korpus" names OIB, so even off the inventory record it counts half |
| door count, follow-up (low) | medium | 0 of 2: the IFC citation has no passage text to check, half; the sentence about the earlier sources has nothing |
| project overview (low) | medium | 5 of 13 whole, 6 half: the normative-looking rows count half off the record |
| OIB-RL 2 overview, 10-27 (low) | medium | 4 of 10; the outline list is one claim, partly on page 4 |
| OIB-RL 2 overview, 10-23 (low) | medium | 3 of 8; the Gliederung table is one claim, mostly not on page 4 |
| plans, 10-23 (low) | medium | 1 of 6: [1] and [4] resolve by content across two searches numbered 1..8 and 1..4, three numbers are labelled (the listing record is not stored: a lower bound) |
| OIB-RL 2 overview, 10-22 (low) | low | 3 of 10, 6 with nothing: Punkt 0 is cited for numbers it does not hold |
| Haus Josef, 10-22 (low) | low | 1 of 7; [2] resolves to Punkt 12 p.23, [1] no passage holds, so it is labelled |
| views with doors, 10-22 (medium) | medium | 0 of 2 whole: door counts read off a drawing, no passage to check |
| knowledge base off, 10-22 (no level) | low | 0 of 5, an honest refusal with nothing behind it |
| GK 4, 09-28 (not stamped) | medium | 2 of 8: the values cited to pages that do not hold them count nothing |

### Consequences

* Good, because a listing reads high and names nothing, and a profile overview
  rests on what the person confirmed.
* Good, because every heuristic now errs low: a word list that misses a verdict
  leaves its sentence at half off a record, a next step that is really a
  verdict cannot hide behind its opener, a citation counts whole only when its
  passage holds it.
* Good, because a pointer that did not hold no longer erases the record or the
  measurement behind its sentence, and collided numbers resolve by what the
  passages say.
* Good, because the chip's count and the level agree, and the chip names an
  uncited verdict even when the self-report was already as low as the evidence
  allows.
* Good, because a hedge („Nach meiner Einschätzung …") lifts no uncited verdict.
* Bad, because fail safe costs grounded answers a level. A record of a
  sentence the net reads normative counts half, so a profile overview and the
  listing's OIB-corpus sentence read medium, never high. A drawing description
  the page text paraphrases counts half. Two stored OIB overviews read low
  because they cite Punkt 0 for an outline it does not hold.
* Bad, because `states_verdict` and `is_next_step` are still word lists. A
  verdict phrased without their stems stays at half off a record; the „low" cap
  misses it, „high" does not.
* Bad, because `passage_holds` is lexical: half the key words of a short
  sentence is one word, so „Das Treppenhaus T1 ist aus Holz [1]" is held by a
  page that names T1. Numbers are exact, words are not.
* Bad, because one Einschätzung keeps an otherwise backed answer at „medium":
  „high" means every claim.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_confidence_evidence_share.py`: through the
  real `read_file`, source capture and `finalize_answer`; the stored answers
  re-graded; every probe of the four reviews of #1231 (next-step openers
  hiding verdicts, verdicts the lists miss or overreach on, a profile number
  in another row, contested facts, a dropped marker, fake citations, a table
  as one claim, collided numbers, the laundering cases). Each guard was
  mutated in turn and a test fails without it.
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
* Reopen the word lists (`states_verdict`, `is_next_step`, `_PROFILE_SPOKEN`) when
  30 days of live turns show answers a reviewer judges alike split by them.
