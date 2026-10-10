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

## Review round, 10 Oct 2026

Two independent reviews of PR #979: one from the business and
requirements side, one technical. What they found, and where each item stands.

### Fixed in the PR

| Finding | Fix |
|---|---|
| A close racing a Steckbrief save of a later Beginn answered 500 (CHECK 23514), and a Beginn save racing a close could write into a closed project | The closing UPDATE also requires the Beginn not to lie after the Abschluss, and the period UPDATE skips a closed row; both races now lose cleanly (409, or the closed-project refusal) |
| A pause (or close) silently lost a dated one-shot: the scheduler's claim retires it before the skip | Moving back to active re-arms each dated one-shot that was skipped while parked and never ran (`rearmOneShotsSkippedWhileParked`) |
| Reopen and re-close turned a „nicht realisiert" project into „fertiggestellt" | The outcome is kept across a reopen as the next close's suggestion, like the Abschluss; the CHECK now only requires it while closed |
| The outcome was preselected | Chosen explicitly, unless an earlier close named one |
| The banner led with the click date, so a project finished in 2019 and closed today read „Abgeschlossen am 10. Oktober 2026" | It leads with „Abschluss ‹Monat›", then „In Piloti abgeschlossen am …" |
| The paid clean-out proposal was asked for on opening the dialog | Asked once the person moves past step one |
| „This month" was the UTC month | `currentMonth()`, in the office's time zone (Europe/Vienna), on both sides |
| A 409 from someone else's move left the page stale; every surface mounted dialogs it never opened; the banner was a live `alert` on every page | Refresh with a message on 409; dialogs mounted only while open; the banner is `role="status"` |
| Status coercion copied four times; the Abschluss bounds checked twice | `toProjectStatus`, `abschlussProblem` in `project-status.ts` |
| An outage asking for the banner's control was swallowed silently | Logged; the control hides, the page stays |
| Release note: tasks „wait" (they are skipped), nothing on the backfill or the hidden months | Corrected |
| Tests: no route test for the strict bodies, none for the rail rule or the filter | `status/route.spec.ts`, `resume-selection.spec.ts`, `status-filter.spec.ts` |

Not taken: replacing the banner's permission check with `access.role ===
'project-admin'`. The repo checks a permission, never a role name
(`frontends/ui/AGENTS.md`).

### Open for the product owner

1. **The outcome model.** „Nicht realisiert" mislabels a lost competition (the
   building usually is built, by the winner), and an office commissioned only
   for the Einreichplanung fits neither answer. Proposal: *Auftrag erfüllt /
   vorzeitig beendet / nicht beauftragt*, with the brief's `projektphase`
   confirmed as the last phase reached. And whether the outcome should reach
   the agent's reference line and the similar-projects ranking (today it is
   shown, not used).
2. **Ausmisten's defaults** (ADR-0092: everything starts selected). Older plan
   indices are liability evidence (§ 933 ABGB, § 1489 ABGB, § 132 BAO).
   Proposal: never preselect `older-version` or `same-content`, and make
   „Abschließen, ohne etwas zu entfernen" the primary button.
3. **Work after handover.** Gewährleistung claims and the Schlussrechnung are
   routine writes after the close; today they need a reopen, which takes the
   project from the office. Options: correct outcome and Abschluss in place;
   closed → paused; a writable folder in a closed project.
4. **Ruhend at all, and who may close.** The state was not asked for. And
   closing opens a project to the whole office on the project admin's say
   alone, with no confidentiality opt-out.
