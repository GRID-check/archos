---
name: ifc-spatial-reasoning
description: >
  Measure on the model with ifc_measure or ifc_query before any OIB figure is
  asserted.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: ifc_viewer,ifc_element,ifc_schedule,ifc_compliance,ifc_diff
---

# Measure on the model, do not guess from the plan

The tool descriptions say **what** `ifc_query` and `ifc_measure` can do, and
they say it at length: every operator, every measure, every relation. This file
holds only what they do not: **how many rounds you have**, **how a question
about many elements becomes one call**, and **how to notice that a number
measures something other than what was asked**. The error this package exists
to remove was never a wrong formula. It was a correctly measured number under a
wrong name.

## 1. The budget: the round is what is counted

After a fixed number of rounds this agent cuts off the tool phase and writes the
answer from what is there by then. A round is everything sent at once, and it
costs one, however many calls it holds:

- **Three calls side by side in one round cost one together.** Asking broadly is
  therefore the cheapest way to get a measurement: `survey`, `element_profile`
  and a `briefing` in the same round cost as much as `survey` alone.
- A call with zero hits costs the same as one that answers, and a round of
  nothing but rejected calls costs its one just the same.
- A round runs up to the configured round width; whatever is beyond that in the
  same round comes back with a note that it can be issued again in the next
  round.
- Loading this skill was a round.

An answer cut off before the measurement falls back on the values the file
declares, which are exactly the numbers whose unreliability is the reason for
measuring at all. That is how a real answer came to state a storey height of
3.00 m for rooms that measure 2.70 m.

If the budget does not reach the measurement, **say so in the answer**: which
measurement is missing and where the number comes from instead. Putting a
declared number in place of the measured one without comment is the most
expensive way to overspend the budget, because from outside it cannot be told
from a measurement.

The tool description says "briefing first". That holds while the selection is
open: then `briefing` goes in a round of its own beforehand and supplies the
storey and attribute names from which the measurement's arguments are built.
If the selection is already fixed, such as a type, part of a name or a whole
building, `briefing` rides along in the same round as the measurement and costs
nothing there; its names are the material with which a storey or attribute name
that hit nothing will hit in the next round.

## 2. A question in the plural is a question about many elements

"How high is the basement" names one room and means seventeen. `survey`
measures ONE measure on ALL elements of a selection (selected as in
`find_elements` through `storey`, `ifc_type`, `name_contains`, `kind`) and
returns per element the name, storey and its own answer, plus the range across
all of them.

On the model AC20-Institute-Var-2, a single call with `operation: "survey"`,
`measure: "clearHeight"`, `ifc_type: "IfcSpace"` and `storey: "Keller"` returns
seventeen rooms: sixteen at 2.700 m and "Flur Keller Treppe" at 0.250 m, range
2.450 m. Whoever measures one room instead and generalises reports 2.70 m,
correctly measured, and the room that matters does not appear in the answer.

**The range is the finding**, not an addition to it. The answer must say: how
many elements were measured and out of how many, the minimum, the maximum and
every outlier by name. "All 17 basement rooms 2.70 m" and "16 of them 2.70 m,
one 0.25 m" are different answers to the same question, and a single measured
room supports neither. Whatever returns `decidable: false` is named
individually and never counted as "like the rest".

If the set is already fixed (the doors from an escape route, the windows of a
facade), `operation: "measure"` takes the whole id list in `global_id` at once,
each element with its own answer and its own tolerance.

And if a single element has become interesting, such as the outlier a `survey`
named, then `operation: "element_profile"` takes ALL measures that apply to
that element in ONE call instead of guessing them one by one. Which apply
follows from the IFC type; the expensive ones (escape route, reachability,
turning circle, door swing) are added only with `kind: "expensive"`.

None of this replaces the single measurement: an element with a known measure
is measured by `measure`, and a plain list without a measure comes from
`find_elements`. And a pure area schedule across all rooms stands in the index
without any geometry: use `ifc_query` with `operation: "schedule"` for that.

## 3. Which of the two tools

`ifc_query` reads what the file **declares**: fast, across the whole model, and
empty where the export wrote nothing. `ifc_measure` measures on the
**geometry**, also where nothing is declared, and always with a tolerance.

| The question is | Tool |
|---|---|
| How many, which, what value is in the file | `ifc_query`: `types`, `elements`, `aggregate`, `properties` |
| Room schedule, area schedule, quantities by material | `ifc_query`: `schedule`, `takeoff` |
| How complete is the model, what has changed | `ifc_query`: `health`, `compare`, `compliance-diff` |
| One measure on ONE element or on a known id list | `ifc_measure`: `measure` |
| The same measure across a storey, a room group, a type | `ifc_measure`: `survey` |
| All measures that apply to ONE element | `ifc_measure`: `element_profile` |
| A measure that arises from TWO elements | `ifc_measure`: `distance`, `clearance`, `overhang` |
| What borders what, what sits in what, what lies above | `ifc_measure`: `relations` |
| A whole OIB 2 or OIB 6 question at once | `ifc_measure`: `fire`, `envelope`, each with `kind` |

Which measures `measure` and `survey` know and what each means is stated in full
in the tool description. Repeating them here would trade room for judgement
against room for catalogue.

**Several models in the project:** set `model_name` to a piece of the file name.
Without it the tool answers with the list of models. Pass that answer on; do not
guess a model.

## 4. In order, the way a person reads a plan

Building → storey → room → element. Each step supplies the GlobalId for the
next; an invented GlobalId is rejected by name.

The procedure is the same for **every** OIB guideline, and only the measures
change:

1. **Which provision**: from the knowledge base, not from the model. It names
   the required measure and the limit.
2. **Which elements**: through `find_elements`, or directly through the
   selection of a `survey`, never guessed.
3. **Take the measure.**
4. **Report**: number, tolerance, origin, elements involved, and for several
   the range. Assessing against the limit is a separate, stated step.

Three chains as examples of this procedure, not as the procedure. For a
guideline not listed here, 1 to 4 apply just the same, and every chain gets
shorter as soon as a step runs over a set instead of over one element.

**"Is the room height sufficient?" (OIB 3)**: a `survey` with
`measure: "clearHeight"` over the rooms of the storey. One call, all rooms,
range included. The minimum height comes from the provision, not from the
model.

**"Does this window work with the roof for daylight?" (OIB 3)**: the longest
chain here, and it does not start at the model: `find_elements` with
`ifc_type: "IfcWindow"` → `relations` with `relation: "hostedIn"` for the wall →
`overhang` with the roof as `global_id` and this wall as `other_global_id` →
`light_incidence` on the window, with `angle_deg` and `swivel_deg` from the
**provision** (for OIB 3: 45 and 30). That means they must have been fetched
from the knowledge base beforehand, which itself costs a round. For area and
percentage, `lightEntryArea` returns both in one measure instead of two. This is
the chain where the budget gets tight first; if a selection misses, what is
missing belongs in the answer per section 1, instead of being guessed at the
end.

**"How long is the escape route, and how wide are the doors in it?" (OIB 2)**:
`measure: "egressPath"` on the room names rooms, doors and length in one call;
the doors from it go as an id list into a single `measure: "clearWidth"`. Before
any statement about *all* routes, `fire` with `kind: "doorGraph"` says how sound
the basis is at all. And the length must be accompanied by the note that it is a
polyline through midpoints and therefore a **lower bound**, not an escape-route
length in the sense of OIB 2. Without that sentence a route that is too long
looks unremarkable.

Do not try three operators to see which returns something: the four geometric
relations (`bounds`, `enclosedBy`, `opensTo`, `adjacentSpaces`) build a contact
plan on the first call that takes several seconds, after which it costs
nothing. Clarify the question first, then call one of them deliberately.

## 5. Pitfalls

Each point here has once put a wrong number into an answer. The first two are
the same trap in two shapes: the number is right, the name above it is wrong,
and the error points in the direction in which too little passes as enough.

**`clearWidth` returns the structural clear opening, not the finished passage
width.** What is measured is the clear opening in the shell, projected onto the
opening plane. The clear passage width of a door is measured between the
finished frame rebates and is 15 to 25 % smaller, which is the direction in
which an escape door that is too narrow looks wide enough. The operator's
`caveat` belongs in the answer, and the number is never called "lichte
Durchgangsbreite" there; which of the two measures is required is decided by the
provision. Without an opening that has geometry, the measured element body is
moreover an **upper bound** and useless as proof of a minimum width, and for a
non-rectangular opening the reported width is the largest, not the consistently
clear one.

**The storey height is about 30 cm above the clear room height**, the distance
between failing and passing. `storey_heights` and the heights in the briefing
are shell dimensions from top edge to top edge; a room-height proof knows only
`clearHeight`.

**`clearHeight` measures up to the lowest obstacle, not up to the room
ceiling.** It is measured with a 5×5 grid straight upward, furniture excluded,
everything else counts. A narrow beam between two grid points can be missed;
for a proof that belongs in the answer. If no grid point lies in the room body,
`decidable: false` comes back, and a finer grid cannot be requested. Then take
`extent` and state the number explicitly as the height of the modelled room
body, never as clear height.

**`sillAndHead` measures at the structural opening**, above the storey level and
not above project zero. A floor build-up reduces the actual parapet height by
its thickness; at the 1.00 m limit for fall protection that decides it.

**Area unit and length unit are independent.** A file can measure in
millimetres and declare areas in square metres. If `floorArea` reports a
CONTRADICTION between declared and measured area, report both numbers and choose
neither. And 0 m² on a wall is a measurement result, not a missing value.

**`azimuth` can be turned by 180°.** "Outside" is the normal that points away
from the middle of the floor plan; at a courtyard or in a re-entrant building
volume that is the wrong side.

### Empty results are statements about the export

None of them is a statement about the building, and behind each waits a "...so
it does not exist" that would be wrong.

- **"0 hits"**: before a "does not exist", check the type spelling and the
  storey name. `ifc_type` is an exact class comparison **without** IFC
  inheritance: a search for IfcWall finds no IfcWallStandardCase. `storey` is
  compared literally; "EG" instead of "00 Erdgeschoss" hits nothing. `briefing`
  names both spellings.
- **`hostedIn` empty for a whole export**: some exports do not write the
  structural opening, and the wall carries the cut-out in its body. That does
  not mean the window sits in no wall; fetch the host wall through
  `relation: "bounds"` on the room or through `find_elements`.
- **`contains` empty on a room**: many exports assign elements to the storey
  instead of the room.
- **The relation list of `element` incomplete**: the four geometric relations
  never appear there, because checking them costs seconds. Their absence is not
  a finding; through `relations` they can be called normally.
- **`adjacentSpaces` does not mean "walkable"**: two rooms with a shared wall
  and no door are neighbours. For the connection use `opensTo` on the door.
- **Listed is not found**: `find_elements` shows at most `limit` hits and names
  the total next to them; the total belongs in the answer. `survey` measures at
  most 50 elements and says next to it how many there were in all, and for
  `balustrade`, `headroom`, `roomDepth` and `thresholdHeight` without an
  explicit `limit` only **12**, because these measures take noticeable time per
  element. Whoever expects forty doors and gets twelve rows has not measured
  what they believe: set `limit` explicitly.
- **`decidable: false` is a finding, not an error**: the question made sense,
  this file cannot answer it. `missing` names what is lacking and what remedies
  it; the remedy is the work instruction to the architect and often the most
  useful part. An answer that begins with "Error:", by contrast, carries no
  statement at all and is corrected rather than reported.

### Looking

What is drawn is always **a floor plan**; section and elevation do **not**
exist. An overhang is measured (`overhang`), not drawn, so offer no section and
announce none. And no measure is ever read off an image: that is guessed, even
if it happens to be right. A look at the plan belongs in the same round as the
measurement it goes with; it merits a round of its own when it is unclear which
element is meant, and not as an illustration of a number that is already fixed.

## 6. How the number gets into the answer

The rendered line already carries the right verb. Quoting it is safer than
rebuilding the sentence. These are the German phrasings the lines use:

- `declared` → „Das Modell **deklariert** …“: the file's statement.
- `computed` → „**Gemessen** … (± Toleranz)“: our number. The tolerance belongs
  with it; without it it is a different claim.
- `inferred` → „**Vermutlich** …“ with the reason from `because`, as a proposal
  for confirmation. `room_inventory` is always that: whether a room is an
  Aufenthaltsraum is a legal classification, not a geometric one.

A `caveat` usually says **how** the measurement was taken and what can go wrong
with it. It belongs in the answer, not in a footnote.

## 7. Geometry is not a verdict

The tools return measures. Whether a measure meets a requirement is decided by
the **provision** from the knowledge base. Angles and percentages are parameters
bound from the clause. That is why `light_incidence` without `angle_deg`
refuses to answer instead of assuming 45: supplying the angle would mean
applying the clause.

Concretely for daylight: a cut 45-degree prism enlarges the required light
entry area; it does not forbid the window. Whoever turns "prism cut" into "not
met" has not applied the provision but skipped it. The same holds for every
number from this package: no Gebäudeklasse, no "erfüllt", no limit that is not
cited from a clause.

A good answer to a measurement question states the number with unit and
tolerance, its origin, the elements involved, for several the range, and what
remains open together with what would settle it.

## 8. Making what was measured visible

A number from the model as a sentence shows nothing one could look at. The card
is the default, not an extra.

Every answer ends with a `Bezug:` line, exactly the GlobalIds from which the
number was formed.

- A set (walls of a storey, doors that break a width) → `ifc_viewer`. One
  highlight group per meaning (`fail` / `warning` / `info`). `storey` isolates a
  storey. In the group: `match` (the same filters as the query) for a set,
  `global_ids` only for the few elements the sentence names. Exactly one of the
  two.
- One element the whole answer revolves around → `ifc_element`.
- A room schedule → `ifc_schedule`.
- A compliance run → `ifc_compliance`, only ids from the `Regel <id>:` lines of
  this turn.
- A comparison of two versions → `ifc_diff`.
- Only to look at or open, and there are several models → `ifc_model_picker`.
  A heading, no file names to type out.

`model_file` is the file name the tool reported (`Modell: …`), never a UUID.

**Never invent** ids. Every GlobalId and every rule id comes from a line that
`ifc_query` or `ifc_measure` returned in THIS turn. An invented id marks the
wrong element and looks like a real one while doing so.

`status` follows the **provision**, not the measurement. As long as no limit has
been applied, it is `info`. A red `fail` is a finding, and a finding needs a
clause behind it.
