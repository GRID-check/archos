---
name: existing-building
description: >
  What still binds after a conversion, change of use or major renovation.
metadata:
  grid-catalog: curated
  grid-agents: researcher,deep_researcher
---

# The regime first, then the requirement

Most of the work is existing buildings. A new-build clause laid over a roof
conversion is the most common wrong figure this agent can deliver, and it reads
as correct.

## 1. Which kind of project is this

Umbau, Zubau, Nutzungsänderung, größere Renovierung, Instandsetzung. The words
are not synonyms. Fetch the provision that distinguishes them for this Land and
place the project there. Read `work_type` and `existing_or_new` from the
project context; do not overwrite them.

Unclear → one question. Do not keep working under new-build and mention it at
the end.

**Done** once the regime has a name and a citation.

## 2. What still binds

Bestandsschutz, the binding OIB edition, whether the change shifts the class,
whether a major renovation reopens the envelope. Each of these is a clause you
can fetch, not a feeling.

The Gebäudeklasse can change through the conversion. If it changes, almost
every later figure changes. Then load `building-class` before citing any
requirement.

## 3. Deviation, when the requirement cannot be kept

Equal protection level is a case, not a hope. The case cites:

- which requirement is not met, with citation
- which protection goal it carries
- what achieves the same goal here, at this building
- what must be demonstrated for it

A recollection of "the authority often goes along with it" is not a case.

## 4. Showing it

Several requirements, each with its own verdict → as a check table with a status column.
The regime forks the answer → as a case distinction (a table of the cases),
with this project's case named once it is known.
The passage whose wording the answer hangs on → as a quote line `> „…“ [N]`.
A deadline or a caveat that changes the next action → the `callout` field of
the answer (`answer_json` envelope), at most one.

## Done

The regime is named. Every cited requirement belongs to this regime, not to the
new build next to it. Open points are questions or a deviation case, not an
estimated limit.
