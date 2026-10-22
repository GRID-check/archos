---
name: hygiene
description: >
  Whether this room is an Aufenthaltsraum, and what OIB 3 then requires.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: daylight_incidence
---

# Classify the room first, then fetch the requirement

OIB 3 hangs on whether something is an Aufenthaltsraum. That is a legal
classification, not a room stamp and not a name on the plan. The dimensions
come after.

## 1. What is this room?

Fetch the provision that defines Aufenthaltsraum. Apply it to the use and to
the details in the question or in the project documents. Unclear → one
question, not a silent yes.

**Done** once the classification has a citation or stands as open.

## 2. Then the requirement, then the dimension

Room height, daylight, ventilation, window area: the limit is in the clause.
The dimension comes from the question, the plan or the documents. Never the
other way round, or you check the wrong thing cleanly.

The provision supplies the limit. A figure without a source is only claimed.

## 3. Showing it

Daylight with light prism and glazing share → `daylight_incidence`.
Several requirements side by side → as a check table with a status column.
The passage whose wording the answer hangs on → as a quote line `> „…“ [N]`.

## What goes wrong

A cut light prism is not a ban on the window. It changes the required area.
Whoever turns "cut" into "not met" has skipped the provision.

The storey height is not the clear room height. The source of the figure
belongs in the sentence.

Existing buildings, extensions and major renovations often bring different
requirements than new builds. Read `existing_or_new` from the project context
before citing a new-build clause.

## Done

The classification stands, the clause is cited, the dimension has a source. Or
exactly the fact that carries the classification is missing.
