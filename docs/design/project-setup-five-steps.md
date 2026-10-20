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
| 2 | Ablage (`filing`) | Upload the project folder from the office server. The agent proposes the folder and shows it **as a tree, confirmed per folder, not per file**. **Accept or change the blacklist for the project.** **Accept or change role permissions** | Choose the folder, see it as a tree, switch whole folders in or out (curated start), see what the blacklist would hold back and change it for this project, see who may open which folder | Upload, folder plan (`FolderUploadDialog`), screening (ADR-0086), folder access (ADR-0088, ADR-0097) and filing suggestions exist. Built: the tree before the upload (`components/filing/folder-tree.ts`), switched per folder with backups, temp and old states proposed out (`default-exclusions.ts`); what the list holds back, and the project's own name terms (migration 0154, ADR-0086 amendment of 2026-10-20); the top folders with who opens them, restrictable before their files arrive. Preview: `/dev/project-setup-filing` |
| 3 | Erfassung (`reading`) | Background. Live progress: „Standort ermittelt", „23 Dokumente gelesen", „41 Werte gefunden, 6 Widersprüche, 9 Lücken". The person may leave the screen and is notified. The chat is already usable | Nothing required: watch, leave, open the chat | Reading, counts and the inbox item `piloti.intake_ready` exist. A progress made of named milestones, „Sie können gehen", and the chat link are new |
| 4 | Rückfragen (`questions`) | All Rückfragen and **document requests** on one screen, done in one pass. Upload right at the entry. Starts after the reading. Only gaps that change the legal classification. Closed projects: few questions | Answer each decisive question, mark it unknown, or hand in the document that answers it. Hand in the location documents the register asks for (Grundbuchauszug, Flächenwidmungs-/Bebauungsplan …) with the reason | Decisive questions and hand-in exist. **Location logic** (from Bundesland, Gemeinde and Vorhaben: which determinants apply and which documents to ask for) and **document requests** are new. The one-at-a-time interview of the remaining needs stays, but optional and folded (the ticket asks only for what changes the classification) |
| 5 | Steckbrief (`profile`) | Values grouped by topic, each with source, confidence and **Planausschnitt**. Order: contradictions first, decisive values one by one, the rest in one confirmation. Then the derivations (GK, Hochhaus, …) to confirm, and the rule set's Ampel | Resolve contradictions, confirm decisive values, take the rest at once, confirm the Gebäudeklasse, see which Richtlinien apply, finish | Review, bulk confirm, derivations and the finish summary exist. Confidence, the plan excerpt and the applicability panel (the shipped answer to „which rules apply", see `applicable-standards.ts`) on this step are new |

## Rules for every step

- One organism per step in `frontends/ui/src/features/project-intake/components/steps/`,
  taking `SetupStepProps` from `steps/types.ts`. A step renders its own way on
  (`onNext`) and never reads another step's state.
- Copy goes in the step's own i18n namespace (`intakeProjectStep`,
  `intakeFilingStep`, `intakeReadingStep`, `intakeQuestionsStep`,
  `intakeProfileStep`, and `intakeShell` for the frame), in `en` AND `de`.
  The namespaces exist and are empty. German is the product language, so
  write it first and make it good. English is the twin.
- Compose atoms (`components/ui`, shadcn-based). Reach for what is there
  (`Stepper`, `ChoiceCard`, `Item`, `InspectorSection`, `RaisedCard`, `Tree`
  if any, `Popover` + `Command` for pickers) before writing a `div`.
- A server change follows `frontends/ui/AGENTS.md`: a route is a thin adapter,
  the service owns logic and authorization, the repository owns SQL, and a new
  table gets `grid_secure_table`. Each model call or check is observable in
  Langfuse.
- Each step ships with specs, and with a state in the `/dev/project-setup`
  preview (`?step=<id>&state=<fixture>`). Fixtures live in
  `src/app/dev/_fixtures/project-intake.ts`.
- Never call a file a plan (`CONTEXT.md`, „Fassung").

## Not in scope

- A self-hosted geocoder is a deployment decision: the address is client data.
  [ADR-0118](../adr/0118-addresses-are-geocoded-by-a-self-hosted-photon.md)
  proposes Photon in the cluster on the Austria index; the Pulumi program has
  it, off by default (`geocoderEnabled`). Until a stack switches it on, the
  address is the typed line and the Bundesland is the reading's to find.
- Editions of the law per Stichtag, a German catalogue, Standortdienste (BEV,
  Landes-GIS): unchanged from the ticket's deferrals.
