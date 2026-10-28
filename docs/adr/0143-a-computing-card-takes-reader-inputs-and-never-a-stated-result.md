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
computed, cited, or the reader's own input.** A bound the model typed is none of
the three, and neither is a figure in a title that the reader's change has made
stale.

## Considered Options

1. **Keep cards unbound; ask again.** Every what-if is a turn.
2. **Bind everything.** Adopt A2UI data binding for every field, the model
   writing `{path}` bindings.
3. **Bind only reader inputs on computing cards, and let the renderer own the
   rules.** An operand the card declares editable is bound to a path the
   renderer derives; the rule and its bounds are the renderer's, from a closed
   set transcribed from the Richtlinien.
4. **Let the model write the formula.** An expression string or code the
   browser evaluates (the "calculator in seconds" of the consumer products).

## Decision Outcome

Chosen: **option 3**.

- **An operand may be a reader input.** A computing card declares, per input,
  the source's value, whether the reader may change it, its bounds and step,
  and where the value is written (`source`, or a norm `reference`). The unit is
  the formula's, not the wire's.
- **The model names the case, never a number.** The bounds are not on the
  wire. The renderer reads them from typed tables in
  `features/cards/lib/formulas.ts`, transcribed from the Mai 2023
  Richtlinien, for the case the model names. A model that writes a result or a
  `limits` list has it dropped by validation and counted (`card-validity`,
  outcome `stripped`), in a `surface` leaf as on a lone card. The guard on
  free text is fail-closed, on NFKC-normalised text. A name (the title, a
  layer's or a leg's label) is built from an alphabet: letters, spaces,
  – · / , ( ) . - →, and digits only inside an allow-listed citation (Pkt.
  9.1.4, Tabelle 3, Zeile 1, OIB-RL 2.3, ÖNORM B 8110-7) or identifier (a
  component code such as AW 01, a storey, a Top, a room number, a variant, a
  plot number), so a sign or a symbol (≤, ✓, ☑, 👍) is refused as a class. A
  text (the note, an input's `source`) may also name its documents (a plan
  code, Index, Rev., Pos., Seite, a date, a year), but no measurement, no
  comparison sign and no symbol. A verdict in words (erfüllt, erfuellt,
  konform, i. O., bestanden, passt, „kleiner als gefordert", „unter dem
  Grenzwert") is refused in both. A deny-list of figure shapes leaked; an
  allow-list cannot leak a shape nobody listed. The residual risk is accepted
  and stated: a figure spelled out in letters („siebzehn Zentimeter"), letters
  spaced to hide a word („e r f ü l l t") or a look-alike character NFKC does
  not fold passes the guard, and is left to review and to the card itself,
  which prints the computed figure beside any text. One judgement is made on
  purpose: an identifier's number is not checked against the card's figures, so
  „AW 20" and „Top 63" pass like „AW 01" and „Top 7", because no rule on the
  text alone tells a code from a figure written as one.

  | `formula.name` | Case the model names | Bound the renderer derives |
  |---|---|---|
  | `stair_step_rule` | `stair_type`: `main`, `dwelling`, `secondary` | 2s + a = 62 ± 3 cm, and Tabelle 3's row: 18/27, 20/24, 21/21 cm (OIB-RL 4 Pkt. 3.2.1) |
  | `u_value` | `component`: `external_wall`, `roof_or_ceiling_to_outside_air`, `floor_over_outside_air`; `measure`: `new_build`, `renovation`, `major_renovation`, or unknown | OIB-RL 6 Pkt. 4.4.1 rows 1, 18, 22: 0,35, 0,20, 0,20 W/(m²K) at a Neubau; at a renovation by single measures without a Sanierungskonzept, Pkt. 4.5 b): 0,76 × the row (0,266, 0,152, 0,152), the row labelled „ohne Sanierungskonzept". A größere Renovierung is held to the energy figures of Pkt. 4.3, not to a component's U-value: computed, not judged. Unknown measure: no verdict. The heat flow follows the row |
  | `escape_route_length` | `start`: `room`, `dwelling_entrance` | 40 m, from the most remote point of the room (OIB-RL 2 Pkt. 5.1.1), or from the Wohnungseingangstüre (5.1.2). Only OIB-RL 2: the card says so, since 2.1, 2.2 and 2.3 have their own provisions |
  | `daylight_ratio` | (none) | 12 % of the Bodenfläche (OIB-RL 3 Pkt. 9.1.1); 15 % with an overhang over 1,50 m, plus 2 % per started metre over 3,00 m (9.1.3); plus 1 % per started metre of depth over 5,00 m (9.1.4). Unknown depth or overhang: no verdict. The Aufenthaltsraum scope (9.1.1, 9.1.6), the 45° light angle turned sideways by at most 30° (9.1.2) and the double requirement behind a Wintergarten or a verglaste Loggia (9.1.5) are stated, not checked |

- **One arithmetic, one verdict rule.** Each rule compiles to
  `CalculationStepData`, the steps a `calculation` carries, so it is evaluated
  by `calculate.ts`'s `evaluate`, judged by `verdictFor` and drawn by the one
  derivation renderer (`components/Derivation.tsx`). A fix there is a fix for
  both cards. `verdictFor` treats a value within a billionth of a bound's
  magnitude as on it, so 12,3 + 20,6 + 7,1 m passes „≤ 40 m"; and a result
  printed past the house two decimals keeps its digits fixed, so the printed
  number never disagrees with the verdict.
- **The rule set is closed and cited.** A rule is added only where its
  arithmetic and its bound can be cited exactly. The lichte Raumhöhe was
  drafted and withdrawn: its subtraction is defined in the OIB
  Begriffsbestimmungen, not in a Punkt the card could name. Only opaque
  components against outside air are U-value cases, because only there is
  R_se the standard's 0,04.
- **Recomputing is in the browser, pure and deterministic.** No model call, no
  request. A typed value is taken when the reader pauses, leaves the field or
  presses Enter, never mid-number; the arrow keys take effect at once.
- **The binding is A2UI's standard shape, and version-agnostic.** A changed
  input is written with `DataContext.set` to `/inputs/<leaf id>` of the card's
  surface and read by subscription (`features/a2ui/reader-inputs.ts`). The path
  is derived, never authored: the model writes literals and cannot bind a
  statement. The store is handed to the card by the catalog's card component
  (`features/a2ui/react-catalog.tsx`). Only `DataContext.set` and
  `DataModel.get`/`subscribe` are used: written against A2UI 0.11, built and
  tested on 0.14 (`@a2ui/react` and `@a2ui/web_core` 0.14.0), with the same
  calls in both. A card drawn without A2UI (the fallback) gets a local store
  with the same interface.
- **A reader's value is marked as theirs.** „Ihre Annahme" beside the changed
  field with the source's value, beside every verdict resting on it, and „mit
  Ihren Annahmen" beside the header's verdict; one „Zurücksetzen" restores every
  source value.
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
the card computes. `calculation` keeps every other derivation; its docstring,
trigger row and worked example no longer use the four named rules (its example
is a Brandabschnitt's Netto-Grundfläche against OIB-RL 2 Pkt. 3.1.1). The
envelope teaches the `formula` shape up front (`ENVELOPE_SHAPE_TYPES`), because
a model guessing it from the index line writes the `limits` list the card no
longer takes.

### Consequences

- Good: the what-if costs no turn, no token and no model call; it is precise by
  construction, and every bound names its Punkt and row.
- Good: a model cannot assume the wrong row: a Wohnungstreppe is held to 20/24,
  not to a Haupttreppe's 18/27, because the row follows the case.
- Good: provenance per input is on the wire and measured
  (`formula-input-provenance` in Langfuse, one score per formula card), and so
  is a stated result (`card-validity`, `stripped`).
- Good: two variants of one wall in tabs each keep their own what-if, because
  the surface's data model holds it.
- Bad: a rule and its tables are ours to keep. Each needs its citation, its
  hand-computed cases and its dictionary words, and the next Ausgabe of the
  Richtlinien (2027 is in draft) means re-reading every row.
- Bad: the rules exist only in TypeScript, so the backend can validate a card
  but not compute it.
- Bad: ÖNORM EN ISO 6946 is a paid standard outside the corpus. Its
  conventional surface resistances (R_si 0,13 / 0,10 / 0,17, R_se 0,04 m²K/W)
  agree across published sources. The card cites the standard by its edition
  (EN ISO 6946:2017) and no clause: the clause the review named (6.8, Annex C)
  is not verified here, and a section presented as fact must be. The owner
  confirms the values and adds the clause against a licensed copy.
- Neutral: `calculation` operands could gain the same inputs, and the
  schematics (`stair_diagram`, `guardrail_check`) after them. That is the next
  slice, not this one.

### Confirmation

- `frontends/ui/src/features/cards/lib/formulas.spec.ts`: every case in
  `formula-cases.json` (beside it) compiles, evaluates and is judged to its
  hand-computed values and verdicts, what-if and boundary cases included; the
  transcribed tables are pinned.
- `calculate.spec.ts`: a sum and a ratio on the bound up to floating point
  pass, a value a real margin past it fails and prints far enough to show it,
  a division by zero carries through the steps built on it.
- `FormulaCard.spec.tsx`: a change recomputes once the field settles, never
  mid-number; it is marked as the reader's beside the field, the verdicts and
  the header; „Zurücksetzen" restores and stays mounted; the stair type picks
  the row; a refused entry is said as refused; nothing is fetched or sent;
  through the real A2UI renderer a variant's what-if survives a tab switch (it
  fails with the binding removed).
- `tests/aiq_agent/cards/test_formula_card.py`: every fixture card validates; a
  result and a `limits` list are dropped and counted; a figure in a title, a
  label or a note is refused, an identifier is not; the case is required.
- `task be:eval:answer-suite` before and after, on a machine with the corpus,
  because the card contract the model reads changed.
