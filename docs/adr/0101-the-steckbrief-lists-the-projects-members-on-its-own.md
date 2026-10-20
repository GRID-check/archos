---
status: accepted
date: 2026-10-11
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The Steckbrief lists the project's members on its own

## Context and Problem Statement

ADR-0091 gave the Steckbrief its own people table, which was right: people stay
out of the profile and so out of the agent's prompt. But it made that table the
only list. Someone with a Piloti account had to be typed in again and linked to
their account by hand, next to the Members tile that already named them. The
Beginn started empty although the project knows when it was created, and
nothing ever asked for the record to be completed. The Steckbrief is read later,
on a closed project, for reference sheets and "who worked on this", so a record
nobody keeps up while the project runs is empty exactly when it is needed. The
product owner called the feature broken on 11 Oct 2026 and chose this direction.

## Decision Drivers

* A running project should not be asked to keep a record by hand.
* People stay out of the prompt, and a person's row stays deletable (ADR-0091).
* WorkOS is the one source for who holds a role on a project (ADR-0038); the app keeps no user table (ADR-0007).

## Considered Options

* **List the members from WorkOS at read time; keep a row only for what a person adds, and for a member who left** (chosen).
* Copy every member into `project_people` when they are added, and backfill the existing projects.
* Keep one hand-kept list and only redesign the screen.

## Decision Outcome

Chosen option: read-time members, because it needs no backfill and cannot drift
from the roster: whoever holds a role on the project now is on the Steckbrief.

* **Members** are the role assignments on the project's own WorkOS resource
  (`listRoleAssignmentsForResource`), named from the organization directory, each
  from the month their earliest assignment was made (`lib/projects/project-team.ts`).
  An organization admin who reaches every project through
  `org:projects:administer` is not on it. A row with that member's `user_id` only
  adds their Funktion, Firma and months; describing a member twice updates that one row.
* **A member who leaves** is kept as a former member: when their last role on
  the project is removed, the members service has the Steckbrief write their
  row with the month they joined and this month as the end, or end the row they
  have (`recordMemberLeft`). Putting them back clears that end. Both are
  best-effort, so a failure never undoes an access change, and neither writes in
  a closed project.
* **Everyone else**, an external planner, the client, staff from before Piloti,
  is added by hand as before. The account dropdown is gone: an account is only
  ever a member's.
* **The Beginn** is the month the project was created until someone sets it,
  the same start the reference ranking already used (`projectPeriodOf`); not
  when that would lie after the Abschluss, as for a finished project brought in
  later. Nothing is written until someone saves.
* **Closing asks**: the close dialog's „Was bleibt" step shows the Steckbrief
  („Wer war dabei"), editable while the project can still be written.

### Consequences

* Good, because nobody types in a colleague, and the record is complete by default for everyone with an account.
* Good, because a former employee no longer disappears from the record when their access is removed.
* Bad, because the overview now asks WorkOS for the roster on every load; when it cannot, the Steckbrief shows only its rows and says so (`rosterKnown`), and calls nobody former.
* Bad, because a member removed before this change left no row, so they are not on older Steckbriefe; they can be added by hand.
* Bad, because a role change re-creates the WorkOS assignment, so a member whose role changed and who has no row reads as joining in the month of the change.

### Confirmation

`project-record-service.spec.ts` (merge, former only with a known roster, the
Beginn default and its limit, a member described twice, leaving and coming
back, nothing in a closed project), `members-service.spec.ts` (which removals
keep a former member), `project-record.spec.tsx` and
`closing-project-record.spec.tsx`. `people-stay-out-of-the-prompt.spec.ts` still
holds: nothing in the agent's context reads the roster or the table.

## More Information

* [ADR-0091](0091-the-steckbrief-keeps-people-apart-from-the-profile.md): the table, erasure, and people out of the prompt, all unchanged.
* [ADR-0098](0098-the-project-lifecycle-is-a-small-state-machine.md): the Abschluss is the closing's.
* User guide: [`user-guides/projects.md`](../user-guides/projects.md#the-steckbrief).
