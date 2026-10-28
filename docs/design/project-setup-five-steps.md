# Project setup in five steps

Status: building. Ticket: Notion „Agentische Projekterfassung statt Wizard" (ID 26).
Builds on [agentic-project-intake.md](agentic-project-intake.md) and ADR-0111.
That document says how Piloti reads a project. This one says what a person goes
through, step by step, and why each step looks the way it does.

## Why it is being rebuilt

Three pilot onboardings (feld72 30.09., BWM 13.10., GernerGernerPlus 19.10.2026)
and the internal sync of 19.10. said the same things.

- **There were three tools for one profile.** The create dialog asked „Piloti
  richtet ein" or „Selbst ausfüllen". The setup page was one 3 000 px page with
  seven sections. The wizard had nine modules. The overview linked both. On
  19.10. the team fell back to „Fill it myself" during a live onboarding.
- **It did not ask what was open.** „Es gibt keinen Interview-Fallback, offene
  Punkte werden nicht abgefragt." The location logic was missing too:
  „Agent ermittelt zur Adresse die baurechtlichen Rahmenbedingungen und was
  dafür abgefragt werden muss."
- **The offices want a curated start.** Their folders hold many backups and
  working folders, so they want to choose what goes in. Every pilot asked for
  „eine überschaubare, aber reichliche Datenmenge statt Komplett-Upload".
  Sensitive data (Rechnungen, Honorare, Personal) is their first trust
  question.
- **„Einfachheit schlägt Funktionsumfang"** (BWM). „Zwei Klicks zu viel und
  das Tool wird nicht mehr genutzt."
- **Bugs met live:** the address field turned into a Bundesland select (fixed);
  a dropped folder was filed in another project (fixed); the language jumped
  to English; the overview was unreachable after creating (fixed in #1101).

## The ticket's flow, and how it maps

The ticket promises five steps, three of them with the person, with the chat
usable from the first minute. The setup page (`/app/projects/[id]/setup`) is a
stepper with these five steps. The create dialog is step 1's entry and stays
under a minute. Every step stays reachable, and nothing in one blocks the next.

| # | Step (`SetupStepId`) | Ticket | What the person does | What exists, what is built |
|---|---|---|---|---|
| 1 | Projekt (`project`) | Name, Status (+ Zeitraum), Adresse via Geocoder (Land, Bundesland, Gemeinde derived), Projektbeteiligte with roles, also external people with a Funktion, Beschreibung | Name, status, address and a line in the **dialog** (built). On the page: check what the dialog took, and add the **Beteiligte**: members with their project role, external people with their Funktion | Dialog built. Beteiligte: the Steckbrief keeps people apart from the profile (ADR-0091, ADR-0101). Reuse that record, do not invent a second one |
| 2 | Ablage (`filing`) | Upload the project folder from the office server. The agent proposes the folder and shows it **as a tree, confirmed per folder, not per file**. **Accept or change the blacklist for the project.** **Accept or change role permissions** | Choose the folder, see it as a tree, switch whole folders in or out (curated start), see what stays on the server and who sees which folder, upload | Built: the tree card (`components/filing/folder-choice-tree.tsx`, `folder-tree.ts`, backups, temp and old states proposed out by `default-exclusions.ts`) beside one summary card: what Piloti reads, what the screening list holds back (the project's own terms in a sheet; migration 0158, ADR-0086 amendment of 2026-10-20), and folder access in a sheet. Footer: „N Dateien hochladen“, aside „Ohne Unterlagen weiter“. A drop on this step goes through the tree, never straight to the upload. Preview: `/dev/project-setup-filing` |
| 3 | Erfassung (`reading`) | Background. Live progress: „Standort ermittelt", „23 Dokumente gelesen", „41 Werte gefunden, 6 Widersprüche, 9 Lücken". The person may leave the screen and is notified. The chat is already usable | Nothing required: watch, leave, open the chat | Built: the documents as a bar („9 von 23 gelesen", no time estimate: nothing the reading reports supports one), one milestone card (Standort, Werte, Widersprüche, Lücken), the values found with their page, the band „Sie müssen nicht warten" with the chat. Reading what is unread and adding documents are quiet links here. A failed reading is said here with „Erneut lesen" as the footer's action; the frame's alert says it on the other steps |
| 4 | Rückfragen (`questions`) | All Rückfragen and **document requests** on one screen, done in one pass. Upload right at the entry. Starts after the reading. Only gaps that change the legal classification. Closed projects: few questions | One question at a time: answer, „Weiß ich nicht", or hand in the document that answers it | Built: the round (`lib/question-round.ts`) listed on the left in three groups, what is missing, the location documents the register asks for, and the **contradictions**, which are settled here and counted in this step's note. The current question in one card with the wizard's own control and a hand-in row. On a phone the list goes and the answer is the footer's action. The optional interview of other open needs is folded behind „Weitere Angaben" |
| 5 | Steckbrief (`profile`) | Values grouped by topic, each with source, confidence and **Planausschnitt**. Order: contradictions first, decisive values one by one, the rest in one confirmation. Then the derivations (GK, Hochhaus, …) to confirm, and the rule set's Ampel | Confirm the Gebäudeklasse (its working folds under „Wie gerechnet?"), see which Richtlinien apply (chips, the reason in words on a peek), check what Piloti found in one table (the most decisive rows up front, the rest folded by topic, each source peeking its page excerpt), take values one by one or all open at once, finish. Contradictions are decided in the Rückfragen; a quiet line points there while one is open | Built to the approved mockup: `steps/profile-step.tsx` over `profile/class-card.tsx`, `profile/rules-card.tsx`, `profile/findings-card.tsx`, `profile/source-peek.tsx`. Finishing an ongoing project goes at once (what is not confirmed stays a suggestion); finishing a past one asks first, since it closes the project |

## Rules for every step

- One organism per step in `apps/workspace/ui/features/project-intake/components/steps/`,
  taking `SetupStepProps` from `steps/types.ts`. A step never reads another
  step's state.
- **One screen, one primary action, always in the same place.** The frame
  (`setup-frame.tsx`) owns a slim bar on top (Einrichtung and the project, the
  five steps inline, „Später fortsetzen"; on a phone: back, „Schritt N von 5"
  with a menu of the steps, and the step's own progress) and one footer
  (the step count on the left, the primary action on the right; full width
  under a thumb). A step names its action, a quiet second way on, a note and
  its progress with `<StepFooter>`; a step that names none gets „Weiter zu
  <next step>". Nothing else in a step looks like a primary button. Details
  are folded behind a link, never stacked. The approved mockups are the spec.
- Copy goes in the step's own i18n namespace (`intakeProjectStep`,
  `intakeFilingStep`, `intakeReadingStep`, `intakeQuestionsStep`,
  `intakeProfileStep`, and `intakeShell` for the frame), in `en` AND `de`.
  The namespaces exist and are empty. German is the product language, so
  write it first and make it good. English is the twin.
- Compose atoms (`components/ui`, shadcn-based). Reach for what is there
  (`ChoiceCard`, `Item`, `InspectorSection`, `RaisedCard`, `Tree`
  if any, `Popover` + `Command` for pickers) before writing a `div`.
- A server change follows `apps/workspace/AGENTS.md`: a route is a thin adapter,
  the service owns logic and authorization, the repository owns SQL, and a new
  table gets `secure_table`. Each model call or check is observable in
  Langfuse.
- Each step ships with specs, and with a state in the `/dev/project-setup`
  preview (`?step=<id>&state=<fixture>`). Fixtures live in
  `src/app/dev/_fixtures/project-intake.ts`.
- Never call a file a plan (`CONTEXT.md`, „Fassung").

## Not in scope

- A self-hosted geocoder is a deployment decision: the address is client data.
  [ADR-0120](../adr/0120-addresses-are-geocoded-by-a-self-hosted-photon.md)
  proposes Photon in the cluster on the Austria index; the Pulumi program has
  it, off by default (`geocoderEnabled`). Until a stack switches it on, the
  address is the typed line and the Bundesland is the reading's to find.
- Editions of the law per Stichtag, a German catalogue, Standortdienste (BEV,
  Landes-GIS): unchanged from the ticket's deferrals.
