---
status: accepted
date: 2026-10-27
decision-makers: Grid engineering; the product owner approved the claim judge
consulted: product owner; UI research on how answer products show grounding (October 2026); five independent reviews of PR #1231
informed: everyone working on the answer pipeline
---

# Confidence counts the claims evidence carries, checked by a small model

## Context and Problem Statement

ADR-0125 stamps every sentence of an answer with a provenance class and a claim
type, and held the answer's level to its **weakest** load-bearing sentence (rule
2). Which sentences bear load was decided by the normative detector
(`agents/piloti/grounding.answer_mentions_normative_claim`), a deliberately wide
net built as a brake on answers with no citation at all. Aggregated by a
minimum, the net's noise decided the level.

The answers stored in the dev workspace between 2026-10-22 and 2026-10-27 are
the fixture `tests/fixtures/claim_provenance/stored_answers_2026-10.json`. All
but one read „low" under rule 2, and most were good answers grounded in what
the turn read:

* **Listings.** `list_files` answers, every row a record, floored by a next
  step the net catches („Welche Maßstäbe … muss im Einzelnen geöffnet werden.").
* **The project overview.** Written from the confirmed project profile in the
  turn context, which was no evidence channel.
* **Registry citations.** Answers that wrote `[1]`, `[2]` with no Quellen list
  had the numbers read as positions in the conversation's cumulative registry:
  drawings cited to OIB p.4, „Punkt 12" to OIB-RL 2.1 p.4.
* **OIB overviews.** Cited and quoted, floored by the rows of a table of
  contents under a cited lead-in.

**Four rounds of this record tried to tell the sentences apart with German
word lists, and each round moved the errors to the other side.** Round 1 used
a mean share with thresholds: a hedged uncited verdict read high. Round 2 added
a verdict word list: a listing still read „Rechtsaussage ohne Beleg" for its
next step. Round 3 added next-step openers: „Wo das Fluchtniveau über 11 m
liegt, ist ein Brandschutzkonzept erforderlich" hid a verdict behind one and
read high. Round 4 checked citations by key-word overlap and made every list
fail safe: „Wendeltreppen sind zulässig [1]" read high against a passage that
says „Unzulässig sind Wendeltreppen", and two grounded answers read low again.
A list of stems cannot see negation, scope or paraphrase. Those are what the
question turns on.

## Decision Drivers

* High means every load-bearing claim is supported by the evidence it points at.
  Low means the answer supports nothing, or contradicts its own source on the
  law. A grounded answer does not read low.
* The laundering rule stays: a record, a measurement, an action or a reading
  never grounds a verdict on the law (ADR-0061, ADR-0125,
  `measurement_sources.py`).
* What a sentence points at is decided deterministically, never by a model: the
  model must not find support the turn did not retrieve.
* The prose streams first; the check must not delay it, and must have a bounded
  fallback when it fails.
* No product the UI research looked at shows a self-rated confidence level; they
  show what the answer rests on. The chip and the level say the same thing.
* A tab opened before a deploy keeps reading the turns the new server finishes
  (`docs/design/chat-wire-v2.md`, „Compatibility"); a stored turn keeps
  rendering under the rule it was computed with.

## Considered Options

* **Narrow the normative detector** so scaffolding sentences stop firing.
* **Deterministic word lists**: verdict words, modals, next-step openers and
  key-word overlap (rounds 2 to 4 of this record).
* **One small-model entailment judgement per answer**, on deterministic
  evidence (this record).

## Decision Outcome

Chosen option: the claim judge, because whether a passage supports, contradicts
or does not address a sentence is an entailment question. Polarity, scope and
paraphrase are exactly what a model reads and a stem list cannot. Four rounds of
lists measured that.

**Deterministic, and nothing a model touches** (`common/claim_provenance.py`):

* The **provenance class** of each sentence, as ADR-0125 defines it, and the
  **evidence** it is held to (`ClaimStamp.evidence`):
  * the passage text its `[N]` resolved to, under its citation key;
  * the ONE record item it matched (a listing line, a profile row, an
    inventory line, where a number counts only inside the same item as one of
    the sentence's words);
  * the measured values;
  * a look's reading.
  * A `reasoning` sentence is held to the passages its paragraph cites. A
    `model_knowledge` sentence has no evidence and counts nothing.
* **`[N]` with no source list** (`citation_verification.resolve_unlisted_numbers`):
  * The Quellen list names, per number, the passage of this turn that carries
    most of the sentences citing it (their numbers and half their key words).
    The printed „Result N" breaks a tie. A number no passage carries is
    labelled, never read as a registry position.
  * Each occurrence is judged against every passage its number may name
    (`unlisted_candidates`): the passages printed under N, and those that
    carry one of its sentences.
* The **dropped marker**: a pointer that did not hold is a flag, and its
  sentence counts half at most.
* **Records**: the confirmed rows of the turn context's `PROJECT_CONTEXT v1`
  (`workspace_records.profile_record`; notes, unknowns, assumptions and
  contested facts are no record). The inventory is a record too, one item per
  line (`inventory_record`): two file names on two lines ground no claim about
  what the documents contain.
* The **anti-laundering rule**: a verdict counts nothing unless its evidence is
  a passage (`support`).
* **Caps**: a reading that is not an exact region crop, a passage beside such a
  place, and a record sentence stating a number no record holds count half at
  most.

**Judged, once per answer** (`common/claim_judge.py`):

* One structured-output call receives every sentence with its evidence. For
  each one it returns `support` (`supported`, `contradicted` or
  `not_addressed`) and `kind` (`verdict`, `fact`, `assessment` or
  `next_step`).
* The judge reads only the evidence it is given, never its own knowledge.
* A verdict and a fact bear load. An assessment (the answer's own inference,
  marked as such) and a next step (including the answer's account of what it
  did or did not read) bear none. The fourth kind exists because a listing's
  „vermutlich falsch abgelegt" is neither a claim of fact nor a step, and it
  must not keep a listing below high.
* **The model** is the organisation's follow-ups model (`claim_judge_llm:
  follow_ups_llm`). It is the smallest role an organisation configures: one
  short structured call, reasoning off. It is resolved per turn with that
  group's override and BYOK (`stages.runner.resolve_group_llm`), like the
  `remember` tool's judge. No model id is written in code.
* **When it runs**: in `finalize_answer`, after the prose has streamed and
  before the terminal frame, bounded by `JUDGE_TIMEOUT_S` (12 s).
* **On failure**: a timeout, an error, an unreadable reply or no model
  configured marks every evidenced stamp `judged: unavailable`. Those count
  half, so the answer reads medium; one with no evidence at all still reads
  low.
* **Observability**: the call is a NAT LangChain call inside the turn, so a
  generation of its trace. `claims-unjudged` and `claims-evidence-share` are
  scores in `SCORE_DEFINITIONS`.

**Rule 3** (`claims_ceiling`), over the claims (a load-bearing sentence, or a
table under a lead-in as one, scored by the mean of its rows; the lead-in is
not a row):

* **high** when every claim is supported;
* **low** when a verdict is contradicted by its evidence, or no claim has any
  support;
* **medium** otherwise. The surfaced level is still `min(self-report, this)`,
  under the hard quote gate.

**On the wire** the turn keeps `answer_confidence_version: 2`. The stamps carry
`support` (which tells rule 3 apart), `verdict` (the judge's kind), `judged`,
`dropped` and `group`, all optional, all stripped by an older bundle.
`test_wire_v2_open_tabs.py` checks such a frame against the schema as it stood
before.

**The chip leads with the count** (`ConfidenceChip`):

* „7 von 9 Aussagen belegt · 1 teilweise": the claims, those supported whole,
  and those backed in part. A partly backed claim is never shown as unbacked.
* „· Belegprüfung nicht verfügbar" when the judge could not run.
* Warnings, first match only: a verdict its source contradicts („widerspricht
  der Quelle"), then an uncited verdict, then a pointer that did not hold.

Re-graded (the fixture's `expected`; rule 2 in brackets; the judge's findings
are the fixture's `judgements`, assigned by reading each sentence against its
evidence):

| Answer | Rule 3 | Claims supported |
|---|---|---|
| „was liegt in den foldern" (low) | high | 7 of 7; the reading account, two assessments and the next steps bear no load |
| „bist du dir sicher" listing (low) | medium | 6 of 7; „Ja, die Liste ist vollständig" has no evidence the classifier can attach |
| door count, follow-up (low) | medium | 1 of 4 |
| project overview (low) | medium | 11 of 19 off the profile; a memory note and the index readings have nothing behind them |
| OIB-RL 2 overview, 10-27 (low) | medium | 8 of 12, one partly |
| OIB-RL 2 overview, 10-23 (low) | medium | 4 of 9, one partly |
| plans, 10-23 (low) | medium | 2 of 8; [1] and [4] resolved across two searches numbered 1..8 and 1..4 |
| OIB-RL 2 overview, 10-22 (low) | medium | 4 of 9 |
| Haus Josef, 10-22 (low) | medium | 6 of 9, one partly; [1] judged per occurrence, [2] Punkt 12 p.23, the profile read |
| views with doors, 10-22 (medium) | medium | 2 of 6 |
| knowledge base off, 10-22 (no level) | low | no claim: every sentence is an account or a plan |
| GK 4, 09-28 (not stamped) | medium | 2 of 7; values cited to pages that do not hold them |

### Consequences

* Good, because negation, scope and paraphrase are read, not guessed. „Zulässig"
  against „unzulässig" is a contradicted verdict, and the answer reads low.
* Good, because no grounded answer of the fixture reads low, a listing reads
  high, and a profile overview rests on what the person confirmed.
* Good, because the chip's count is honest: two cited, supported claims read
  „2 von 2", never „0 von 2".
* Good, because the lexicon is gone: `states_verdict`, `is_next_step`, the
  modal and next-step patterns, the hedge list, the action-clause rewriting,
  the key-word support check and the drawn-value credit. Production code is
  smaller than round 4.
* Bad, because a model decides support, and a model can be wrong. It reads only
  the evidence the deterministic part hands it, so it can miss support but not
  invent a source. A verdict needs a passage whatever it says.
* Bad, because the check costs one small-model call per answer and up to
  `JUDGE_TIMEOUT_S` before the terminal frame. The prose has streamed by then,
  so the reader waits for the chip, not for the answer.
* Bad, because the fixture's judgements are assigned by a person reading the
  evidence, not produced by the deployed model. The tests check the plumbing
  and the aggregation, not the model's accuracy.
* Bad, because the claim type on the wire (`normative`, `value`,
  `descriptive`) is still the normative net's label. The level no longer reads
  it, and the chip reads `verdict` first.

### Confirmation

* `tests/aiq_agent/agents/piloti/test_confidence_evidence_share.py`:
  * through the real `read_file`, source capture and `finalize_answer`, with
    the judge faked (`tests/aiq_agent/claim_judge_stub.py`);
  * what reaches the judge, one call per answer, and the fallback when it fails;
  * the real call shape on a fake chat model;
  * every probe of the five reviews of #1231 (negation, next steps, profile
    numbers in another row, contested facts, the inventory per line, collided
    numbers, a table as one claim, the laundering cases);
  * the stored answers re-graded.
* `tests/aiq_agent/common/test_claim_provenance.py` and
  `test_claim_provenance_looks.py`: the classes, the evidence each sentence is
  held to, and the level.
* `tests/aiq_agent/common/test_wire_v2_open_tabs.py`: a rule-3 `RUN_FINISHED`
  with every new stamp field parses under the previous schema.
* `ConfidenceChip.spec.tsx` and `message-claim-stamps.spec.ts`: the count with
  its partly backed claims, the unchecked note, and the warnings.
* Langfuse: `claims-evidence-share`, `claims-unjudged` and
  `claims-normative-uncited` in `SCORE_DEFINITIONS`, held to
  `docs/observability/langfuse.md` by `test_langfuse_scores.py`. Their score
  configs reach Langfuse through `task langfuse:provision -- --apply`, which
  needs the owner's go-ahead.

## Pros and Cons of the Options

### Narrow the normative detector

* Good, because a false fire is a false fire wherever it lands.
* Bad, because the detector's misses are the liability it exists for. Rejected
  on the premise that its job is the brake on uncited answers; the finer
  question belongs to the judge.

### Deterministic word lists

* Good, because they are free, fast and reproducible.
* Bad, because four rounds measured them failing in both directions on the
  same stored answers and the reviews' probes. Rejected on that measurement:
  the probes are tests now, and a list that passes all of them would be
  reconsidered.

## More Information

* The answer suite (`task be:eval:answer-suite`) was waived by the owner for
  this change.
* Reopen the judge's prompt, or its model role, when 30 days of live turns show
  `claims-unjudged` above 5 % of answers, or reviewers disagree with its
  findings on a sample of stored turns.
