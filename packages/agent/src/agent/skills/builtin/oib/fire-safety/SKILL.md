---
name: fire-safety
description: >
  Fire compartment, escape route and fire resistance, once the GK is settled.
metadata:
  grid-agents: researcher,deep_researcher
  grid-cards: egress_diagram,fire_access_plan,calculation
---

# Answering a fire-safety question

## Building class first

Nearly every requirement in OIB Richtlinie 2 hangs on the Gebäudeklasse. If it
is missing and changes the answer, load `building-class` before any figure is
given. A fire-resistance class without the building class it follows from is a
figure with no claim behind it.

The edition binds too. Fetch it and name it as soon as it moves the value.

## Keep the requirement and the Nachweis apart

The guideline says what must be met. Whether it *is* met in this building is a
finding about this project. Say which of the two you delivered. A rough check
against the plan is not a fire-safety concept. The difference disappears as
soon as the card travels on without the sentence. So put it in the sentence.

## The second escape route is two questions

Whether one is required follows from class and use. Whether it counts follows
from where it leads. Answer both, or say which one is open.

## Which picture

A storey divided into fire compartments, areas against the limit → as a check
table, one row per compartment; a calculated area → `calculation`.
An escape route made of segments whose sum is checked → `egress_diagram`. The
segments individually, never only the sum: the question is almost always
*which* segment is too long.
Access road, drive-through, aerial-ladder area → `fire_access_plan`.
Several requirements, each with its own verdict → as a check table with a status column.
The passage whose wording the answer hangs on → as a quote line `> „…“ [N]`.

## Done

Every verdict has a citation and says whether it is the requirement or the
Nachweis. If the class is missing, that is the open fact, not an estimated
resistance class.
