# Project lifecycle audit, 10 Oct 2026

The product owner's brief: the project lifecycle "is not clear at all"; closing
reads as "you give a time frame"; think through what a closed project means and
why a project would need to be done at all; audit and fix the whole experience
around it. Every finding below was read off the code on `develop` at `3d326963`
and, for the UI, off the `/dev` previews in a browser. The decision that came out
of it is [ADR-0098](../adr/0098-the-project-lifecycle-is-a-small-state-machine.md).

## What a project's life looks like in an office

A planning office's project is commissioned, worked through its phases, often
parked for months (waiting for a Baubescheid, a client's financing, a tender),
and ends one of two ways: handed over, or not realized (a competition not won,
a commission withdrawn). After either, it is reference: the next similar
project wants its decisions, its authority's demands, its people. Years later a
defect claim may bring it back for a while.

So the office needs to say two different things about a project it is not
working on today: *it is waiting* and *it is over*. Only the second changes
anything about access or integrity. That is the answer to "why would it need to
be done": being done is what makes a project the office's reference
(readable by all, frozen, offered as a similar project). Nothing else needs it.

## Findings

| # | Finding | Where | Severity |
|---|---|---|---|
| L1 | The Steckbrief offered „Abschluss" as a free month field on every running project. A project could be active with an Abschluss in the past, which is what "closing is a time frame" described. | `project-steckbrief.tsx` period form; `steckbrief-types.ts` `projectPeriodSchema` | High |
| L2 | The period search treated such a project as ended: `projectPeriodOf` read `ended_on` whatever the status, so the agent's `project_lookup` with a period filter answered from a typed date. | `lib/cross-project/service.ts` | Medium |
| L3 | Closing filled the Abschluss silently, and only when empty; the dialog mentioned it in the last sentence of a paragraph. A reopen left the month standing, still shown. | `repository.ts` `setProjectStatusInOrg`; `lifecycle.closeDialog.description` | Medium |
| L4 | One state carried four jobs: the work is over, the record is frozen, the office may read it, it leaves the list. Tidying the list meant freezing the project and opening it to the whole office. | ADR-0090 model | High |
| L5 | No outcome: a lost competition and a handed-over building closed alike and became the same kind of reference. | `projects` table | Medium |
| L6 | Closing was reachable from one card at the foot of the Overview only; not from the hero's „…" menu, the banner, the list or the switcher. | `project-overview.tsx`, `project-lifecycle-card.tsx` | Medium |
| L7 | The close dialog was one long modal: a warning paragraph, the debrief (fingerprint, decisions, lesson) and the clear-out, with the decisive button at the very bottom. | `close-project-dialog.tsx` | Medium |
| L8 | The banner of a closed project told the reader it was read-only but offered no way out, even to the person who could reopen it; the upload error sent them to „Einstellungen", a page that is called „Übersicht". | `closed-project-banner.tsx`; `files.errors.projectClosed` | Low |
| L9 | Every project card carried an „Aktiv" chip: the normal case announced, the exception (closed) the same size. | `project-card.tsx` | Low |
| L10 | Under the „Alle" filter, closed projects could fill the „Weitermachen" rail. | `resume-selection.ts` | Low |
| L11 | The sidebar switcher listed every closed project of the office, unmarked, because every member reads them. | `lib/shell/chrome.ts`, `project-switcher.tsx` | Medium |
| L12 | The status vocabulary differed: chips said „Aktiv", the chat's precedent line „laufend"; „Abgeschlossen" is also the word for a finished research run and job. | i18n | Low, noted |
| L13 | Migration headers named the wrong numbers (0116 said 0114 and 0115, 0117 said 0115 and 0116). | `drizzle/0116_*`, `0117_*` | Trivial |

## What changed (ADR-0098)

* **A small state machine**: active ⇄ paused → closed → active. Paused changes
  no access, stops schedules, leaves the „Aktiv" view. Closed is ADR-0090
  unchanged. Every other move is refused. (L4)
* **The close names how and when**: outcome (fertiggestellt / nicht realisiert)
  and the Abschluss month, bounded by this month and the Beginn. The database
  refuses a closed project without either. (L3, L5)
* **The Steckbrief edits the Beginn only**; a running project shows „laufend".
  `abschlussOf` is the one reader, so neither a surface nor a period search sees
  a running project's stored month. (L1, L2)
* **The moves are where the reader is**: the status card draws the three
  states; the Overview's „…" menu, the card and the banner share one hook; the
  banner offers „Fortsetzen" or „Wieder öffnen" to whoever may. (L6, L8)
* **Closing is three steps**: Abschluss, Was bleibt, Ausmisten. (L7)
* **The list and switcher**: a filter segment per state that has projects; a
  chip only on what is not active; the rail for active projects only; the
  switcher without closed projects unless one is open. (L9, L10, L11)
* Migration headers corrected. (L13)

## Deferred, and why

* **L12, one vocabulary.** „laufend" on the precedent line is the agent's
  reading of the status and reads naturally there; renaming it touches the
  answer contract. Left as is.
* **A nudge for idle projects** ("no activity for five months: pause or
  close?"). Useful, but a derived suggestion needs a definition of activity the
  product owner should set. Not built.
* **The brief's `projektphase` fact** (intake A4) has the values „Fertigstellung
  & Übergabe" and „Bestand & Betrieb", which overlap with closing. They describe
  the building, the status describes the workspace; ADR-0098 keeps them apart.
  Offering to close when the phase reaches handover is a candidate follow-up.
* **Correcting a closed project's Abschluss** needs a reopen and a close. Rare,
  and allowing a write into a closed project would be a second exception to
  ADR-0090.
