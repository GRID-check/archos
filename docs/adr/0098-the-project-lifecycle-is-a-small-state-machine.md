---
status: accepted
date: 2026-10-27
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The project lifecycle is a small state machine, and the Abschluss belongs to the closing

## Context and Problem Statement

ADR-0090 gave a project two states, `active` and `closed`, and ADR-0091 gave its
Steckbrief a period, Beginn and Abschluss, as two free month fields. The product
owner's verdict on the result, 10 Oct 2026: the lifecycle "is not clear at all",
closing a project reads as "you give a time frame", and the whole experience
around closing "needs a major audit and fixing". The audit
([`audit/project-lifecycle-2026-10.md`](../audit/project-lifecycle-2026-10.md))
found the causes in the code, not in the copy:

* **Two notions of "finished" that never met.** The Steckbrief offered an
  „Abschluss" month input on every running project. A project could carry an
  Abschluss in 2024 and still be active; a period search (`projectPeriodOf`)
  then treated it as ended. Closing silently filled the month only when it was
  empty, and a reopen left it standing.
* **One bit carrying four jobs.** `closed` meant the work is over, the record is
  frozen, the office may read it, and it leaves the list. An office that only
  wanted a quiet list had to freeze a project and open it to everyone.
* **No outcome.** A competition entry that was not won and a building handed
  over closed the same way, and became the same kind of reference.
* **The moves were hard to find and hard to read.** Closing lived in a card at
  the foot of the Overview, opened one long modal holding a warning, the
  debrief and the clear-out at once, and was reachable from nowhere else.

Why close at all? Because closing is what turns a finished project into the
office's reference (ADR-0090, ADR-0096): readable by everyone, searchable,
offered as a similar project, with a record that no longer drifts. That needs a
deliberate act and a date. Decluttering does not, and neither does waiting for a
Baubescheid; those were the jobs that did not belong to it.

## Decision Drivers

* A project's state is a state, chosen, never derived from a date someone typed.
* Access changes only on a deliberate, audited close, never as a side effect of tidying.
* Every guarantee of ADR-0090 holds unchanged: the closed read-only seam, the folder rule, the database guard.
* Few states. Each one must answer a question a planning office actually asks.

## Considered Options

* **Three states, active ⇄ paused → closed → active, with the outcome and the Abschluss named by the close** (chosen).
* Keep active/closed and only rewrite the UI.
* Derive the state from the period: a project whose Abschluss lies in the past is finished.
* A richer machine following the Leistungsphasen (Akquise, Planung, Ausführung, Gewährleistung, Archiv).

## Decision Outcome

Chosen option: three states, because it separates the two things offices
actually do with a project they are not working on today, park it or finish it,
and keeps the one that changes access as the only deliberate, audited one.

**The machine** (`PROJECT_TRANSITIONS`, `lib/projects/project-status.ts`):

```
active ⇄ paused        pause / resume
active | paused → closed   close (outcome + Abschluss)
closed → active        reopen
```

Every other move is a 409 `invalid-transition`, and so is a move that lost a
race: the repository's UPDATE matches the state the service read, so two clicks
write one event. Each move is audited under its own name: `project.paused`,
`project.resumed`, `project.closed` (with `outcome` and `endedOn`),
`project.reopened`, each with the state it left.

**Paused** (`Ruhend`) changes no access and freezes nothing: the project stays
writable and visible to its members only. It leaves the list's „Aktiv" view and
the „Weitermachen" rail, and its schedules record a skipped run
(`runsOnSchedule`), as a closed project's do. A recurring schedule takes its
next turn after a resume; a dated one-shot, which the scheduler's claim retires
before it fires, is re-armed by the move back to active
(`rearmOneShotsSkippedWhileParked`), so a pause or close never loses it. Pausing
asks nothing, and its toast offers the undo. `paused_at` is set exactly when
paused (CHECK).

**Closed** is ADR-0090, unchanged in what it allows: read-only before the admin
bypass, open to the office for reading and chat, no restricted folder opened,
the 0116 insert guard. It now also says how it ended, `closed_outcome`
`completed` (fertiggestellt) or `cancelled` (nicht realisiert); both stay
references, and the chip and banner say which. The outcome is chosen, never
preselected, unless an earlier close of the project named one, which a reopen
keeps as the next close's suggestion, as it keeps the Abschluss.

**The Abschluss is the closing's.** `ended_on` is no longer a field of the
Steckbrief: the Steckbrief edits the Beginn only (`PUT …/project-record` refuses an
`endedOn`), and a running project shows „laufend" where the Abschluss would be.
Closing names the month, defaulting to this one, not after it and not before the
Beginn (400 `abschluss-in-future` / `abschluss-before-beginn`); when the Beginn
lies ahead (a competition lost before the commission would have started), its
month is the one that fits (`closingBounds`). A closed project
always has one (CHECK). A reopen keeps the stored month as the next close's
suggestion; no surface and no period search reads it while the project runs
(`closingOf`). This amends ADR-0091's "closing pre-fills Abschluss".

**A past project may be created closed** (added 2026-10-13). An office adding a
finished project as a reference creates it with `closing` (`POST
/api/projects`, the projects page's form): outcome, Beginn and Abschluss. The
Abschluss is checked against the same `closingBounds` before anything is
written (400 `abschluss-in-future` / `abschluss-before-beginn`), the Beginn is
inserted with the row, and once the creator holds `project-admin` the row
makes the ordinary `active → closed` move through `setProjectStatusInOrg`, so
the same CHECKs hold it (`projects_closed_outcome_check`, ended_on on the first
of a month and not before started_on). The move is the repository write, not
`setProjectStatus`, whose FGA check may not see a grant made a moment earlier;
a close that fails removes the row like a failed WorkOS step. It is audited as
`project.created` then `project.closed` (`from: active`). It skips the
debrief and the clear-out: a project created this second has no memory and no
files for either to look at.

**The moves are where the reader is.** One hook (`useProjectLifecycle`) serves
the status card on the Overview, which draws the three states with the current
one marked; the Overview's „…" menu; and the banner every page of a paused or
closed project opens with, which offers the one way out to whoever holds
`project:manage`. Closing is three steps: how it ended and when, with what
changes said once; what the office keeps (the ADR-0096 debrief); and the
clear-out (ADR-0092). The projects list filters Aktiv / Ruhend / Abgeschlossen /
Alle and marks only what is not active; the project switcher leaves closed
projects out unless one is open.

### Consequences

* Good, because a date can no longer stand in for a state, and the Steckbrief's period means one thing.
* Good, because tidying the list no longer opens a project to the office.
* Good, because a lost competition is told apart from a handed-over building wherever the project is named.
* Good, because nothing in the authorization seam changed: `paused` is not `closed`, so every ADR-0090 rule applies as before.
* Bad, because an Abschluss someone typed into a running project before this change stays stored but unread until that project is closed, where it is offered as the suggestion.
* Bad, because a closed project's Abschluss cannot be corrected without reopening and closing it again.
* Neutral: the agent's `Projekt:` line reads `ruhend` for a paused project; nothing else on the Python side reads the status beyond `closed`.
* Bad, because the outcome is shown, not yet used: neither the similar-projects ranking nor the agent's reference line reads it, so a competition entry that was never built is cited like any closed project.
* Bad, because work after handover (a Gewährleistung claim, a Schlussrechnung) needs a reopen, which takes the project from the office until it is closed again.
* Bad, because closing opens the project to the whole office on the project admin's decision alone; there is no confidentiality opt-out.
* Bad, because every project closed before 0129 is backfilled as `completed`; one that was never built has to be reopened and closed again.
* Bad, because a project created closed is read-only from its first second: its documents, brief and people are added by reopening it, filling it in and closing it again. Creating it active and closing it afterwards remains the path when the material is at hand.

The last four are open product questions put to the product owner with this ADR (`audit/project-lifecycle-2026-10.md`, review round).

### Confirmation

* `projects_status_check`, `projects_paused_state_check` and `projects_closed_outcome_check` (migration 0129): a paused row without its date, a closed row without its outcome or its Abschluss, and an unknown state are refused by the database. `scripts/rls-test-db.sh` exercises them, the backfill and the down migration.
* `project-status.spec.ts` pins the exact set of moves; `service.status.spec.ts` the conflicts, the Abschluss bounds and the audit names; `project-status.integration.spec.ts` the moves on real Postgres, and that pausing leaves access untouched.
* `schemas.spec.ts` fails if a move's audit action is emitted without a registered schema, or registered and never emitted.
* `project-record-service.spec.ts` refuses an `endedOn` on the period route and shows none on a running project.
* `service.create-closed.spec.ts` pins creating a project closed: the bounds refused before any insert, the close after the grant, both audit events, and the rollback when the close write fails.

## Pros and Cons of the Options

### Keep active/closed, rewrite the UI

* Good, because no migration.
* Bad, because the Abschluss stays a free field on a running project, the cause of the confusion.
* Bad, because decluttering still costs a freeze and an access change.

### Derive the state from the period

* Good, because nothing to click.
* Bad, because access would widen to the whole office the day a typed date passes: the opposite of the first driver.

### Follow the Leistungsphasen

* Good, because it mirrors how an office talks about a commission.
* Bad, because the phase is a fact about the building process and already lives in the brief (`projektphase`, intake A4); a second copy as a status would drift from it.
* Bad, because none of the extra states changes what anyone may do, so each would be a label posing as a state.

## More Information

* The audit and what was deferred: [`audit/project-lifecycle-2026-10.md`](../audit/project-lifecycle-2026-10.md).
* Closed is read-only and open to the office: [ADR-0090](0090-a-closed-project-is-read-only-and-open-to-the-office.md). The Steckbrief: [ADR-0091](0091-the-steckbrief-keeps-people-apart-from-the-profile.md). Ausmisten: [ADR-0092](0092-ausmisten-proposes-from-metadata-and-bins-through-a-subfolder.md).
* User guide: [`user-guides/projects.md`](../user-guides/projects.md#a-projects-lifecycle).
