---
status: proposed
date: 2026-10-27
decision-makers: Grid engineering
consulted: product owner
informed: everyone working in this repo
---

# A computing card takes reader inputs, and never a stated result

Amends [ADR-0065](0065-a2ui-renders-every-card.md) (data binding) and adds to
[ADR-0069](0069-the-answer-is-markdown-and-a-card-must-earn-its-place.md) (its
research paragraph, and category 3 of the cards that earn their place).

## Context and Problem Statement

An architect's question after an answer is almost always "and what if?": what if
the insulation is 16 cm instead of 20, the riser 18 instead of 17, the corridor
door moves four metres. Today the card that computes (`calculation`) answers the
first question and the reader asks the second in a new turn, which costs a model
call, a minute, and a fresh chance for the model to state a number.

ADR-0065 declined A2UI's data binding outright, with a reason that still holds
for most of a card: "a card is a statement about retrieved sources, not live
state". It does not hold for an operand. An operand is a value the reader
already owns (the wall build-up is theirs to choose), and moving it changes
nothing the source said.

The field moved the same way in the last month. ChatGPT's GPT-6 "Intelligent UI"
(2026-10-07) draws answers from "a library of native, streamable components",
and its recurring examples are formulas with inputs the reader moves (a recipe
that scales, a calculator). Vercel's json-render binds a prop to state with
`{"$bindState": "/path"}` and reads it with `{"$state": "/path"}`. A2UI, which
already draws every card (ADR-0065), has had the standard shape since v0.9: a
surface's data model, JSON-pointer paths, `DataContext.set` and subscriptions.

The product's north star for a computed answer: **every number on the page is
computed, cited, or the reader's own input.**

## Considered Options

1. **Keep cards unbound; ask again.** Every what-if is a turn.
2. **Bind everything.** Adopt A2UI data binding for every field, the model
   writing `{path}` bindings.
3. **Bind only reader inputs on computing cards.** Cited statements and limits
   stay literal and immutable; an operand the card declares editable is bound
   to a path the renderer derives, and the result is recomputed in the browser
   from a closed set of formulas.
4. **Let the model write the formula.** An expression string or code the
   browser evaluates (the "calculator in seconds" of the consumer products).

## Decision Outcome

Chosen: **option 3**.

- **An operand may be a reader input.** A computing card declares, per input,
  the source's value, whether the reader may change it, its bounds and step,
  and where the value is written (`source`, or a norm `reference`). The unit is
  the formula's, not the wire's.
- **Statements stay unbound.** A limit is a cited statement: comparator, bound
  and a `NormReference` with its Punkt, which the schema requires. The reader
  cannot change it, and a limit nobody can cite stays off the card; then the
  card computes and judges nothing.
- **The model never states a computed result.** There is no result field on
  the wire, as on `calculation` since its first version.
- **The formula is a name from a closed, tested set.** `formula.name` is one of
  `u_value` (ÖNORM EN ISO 6946), `stair_step_rule` (OIB-RL 4 Pkt. 3.2.1),
  `escape_route_length` (OIB-RL 2 Pkt. 5.1.1), `daylight_ratio` (OIB-RL 3 Pkt.
  9.1.1). Each is a pure function in `features/grid-cards/lib/formulas.ts`,
  tested against hand-computed cases in `shared/cards/formula-cases.json`,
  which the backend also validates. A rule whose arithmetic cannot be cited
  exactly is not added: the lichte Raumhöhe was drafted and withdrawn, because
  the definition it rests on is in the OIB Begriffsbestimmungen and that text is
  not in the corpus.
- **Recomputing is in the browser, pure and deterministic.** No model call, no
  request. The verdict rule is `calculation`'s (`verdictFor`), so both cards
  judge a bound the same way, including how far a result is printed so the
  number and the verdict cannot disagree.
- **The binding is A2UI's standard shape, and version-agnostic.** A changed
  input is written with `DataContext.set` to `/inputs/<leaf id>` of the card's
  surface and read by subscription (`features/a2ui/reader-inputs.ts`). The path
  is derived, never authored: the model writes literals and cannot bind a
  statement. Only `DataContext.set` and `DataModel.get`/`subscribe` are used,
  stable since A2UI v0.9 and unchanged in 0.11, so the A2UI 0.14 upgrade does
  not touch it. A card drawn without A2UI (the fallback) gets a local store with
  the same interface.
- **A reader's value is marked as theirs.** Beside a changed input: „Ihre
  Annahme" and the source's value; under the Rechenweg: „Gerechnet mit Ihren
  Annahmen"; one „Zurücksetzen" restores every source value.
- **A changed input writes nowhere.** Not to the message (`cardInteractions`),
  not to a backend, not to an export (an exported card prints the source's
  values), and it is gone on reload. The card is `presentational` (ADR-0030).
  The one way a what-if may ever leave the browser is the reader saving it
  explicitly as a proposal on a shared object (ADR-0105). That is not built
  here; until it is, nothing is saved.

Option 1 leaves the architect's real question to a turn. Option 2 hands the
model a way to bind a cited statement to state, the exact thing ADR-0065 ruled
out, and asks it to write paths it gains nothing from. Option 4 puts arithmetic
nobody checked next to a legal citation; a planning office needs a few correct
calculators tied to the law, and a new one is a catalog addition with a test.
Each rejection rests on a premise that can turn false: option 2 on the model
gaining nothing from authoring a path (true while no card shares an input
across leaves by the model's choice), option 4 on there being no way to verify
a model-written formula before it is drawn beside a citation.

**`formula` is a new card type, and it earns its place** under ADR-0069's
category 3 (arithmetic the renderer computes). The Apps SDK test: replacing it
with text loses the what-if, which is the card's whole point, and the verdict
the card computes. `calculation` keeps every other derivation.

### Consequences

- Good: the what-if costs no turn, no token and no model call; it is precise by
  construction, and the cited limit stays pinned to its Punkt.
- Good: provenance per input is now on the wire and measured
  (`formula-input-provenance` in Langfuse, one score per formula card).
- Good: two variants of one wall in tabs each keep their own what-if, because
  the surface's data model holds it.
- Bad: a formula is ours to keep. Each needs its citation, its hand-computed
  cases and its dictionary words, and the formulas exist only in TypeScript, so
  the backend can validate a card but not compute it.
- Bad: ÖNORM EN ISO 6946 is a paid standard outside the corpus. Its
  conventional surface resistances (R_si 0,13 / 0,10 / 0,17, R_se 0,04 m²K/W)
  agree across published sources, and the table is cited as Tabelle 7 of the
  2017 edition; a reviewer with the standard confirms both.
- Neutral: `calculation` operands could gain the same inputs, and the
  schematics (`stair_diagram`, `guardrail_check`) after them. That is the next
  slice, not this one.

### Confirmation

- `frontends/ui/src/features/grid-cards/lib/formulas.spec.ts`: every case in
  `shared/cards/formula-cases.json` recomputes to its hand-computed value and
  verdicts, what-if cases included; the checkable quantities are one list.
- `FormulaCard.spec.tsx`: an input change recomputes and is marked as the
  reader's; „Zurücksetzen" restores the source; an unknown input cannot be
  judged; nothing is fetched or sent; through the real A2UI renderer a
  variant's what-if survives a tab switch (it fails with the binding removed).
- `tests/aiq_agent/cards/test_formula_card.py`: every fixture card validates; a
  limit without its Punkt, a limit on another formula's quantity and a stated
  result are refused or dropped; the provenance score counts what it says.
- `task be:eval:answer-suite` before and after, on a machine with the corpus,
  because the card contract the model reads gained a trigger row.
