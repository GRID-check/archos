# Working on a plan: one place, by what the office is trying to do

> Status: design, 2026-10-30. Supersedes the entry points of S6 in
> [`sketches.md`](sketches.md) („Auf Seite zeichnen“ as a separate editor);
> keeps its machinery. Evidence: the seven pilot protocols and the office
> profiles in Notion, read 2026-10-30 (feld72 ×4, BWM, GernerGernerPlus,
> Zechner&Zechner). Applies [VISION.md](../../VISION.md) principle 8.

## Why this document exists

By 2026-10-30 a PDF page had two shared canvases: the review (marks, threads,
live cursors, ask Piloti on a region) and a Skizze traced over the page (its own
editor, its own room, its own pins). Each slice was right on its own; together
they are two ways to do one thing, which is the second product principle 8
forbids. Before merging them we asked what the office is trying to get done,
because a merged canvas built for its own sake would only be a tidier version of
the same mistake.

## What the offices are trying to achieve (evidence)

What the pilots said, not what we would like them to want:

| The job | Evidence |
|---|---|
| **Reach a decision and keep it with its reason**, findable years later | feld72 30.09: „Wann und warum wurde X entschieden?“ across minutes, mail and plans, for claims. feld72 23.10: Festlegungen re-keyed into ArchiCAD by hand. GernerGernerPlus 19.10: the reasons between phase states are the valuable part; phone calls get lost. |
| **Close an issue with owner, deadline and proof** | Zechner 22.10: weekly GP-Besprechung, half the Fachplaner on Teams, issues „mit Zuständigkeit, Frist und Erledigungsnachweis“ in BIMcollab. feld72 30.10: BCF, 280 coordination issues with the IFC. |
| **Work on the right Planstand and see what changed** | feld72 09.10/23.10: only the newest Planstand counts, Index and date from the Plankopf, „nur als Vorschlag mit manueller Bestätigung“. GernerGernerPlus 19.10: overlay Fassungen; area losses found „rückwirkend“ are „politisch, vertraglich und juristisch heikel“. |
| **Have the answer during the meeting** | feld72 30.10: „in einer Besprechung in drei Minuten die richtige Normstelle in fünf Dokumenten finden statt danach“. |
| **No second place, no extra clicks** | BWM 13.10: „zwei Klicks zu viel“ and the tool is dead. GernerGernerPlus: no double entry. feld72 30.10: divergent input fields undermine trust. |
| **Plans and PDFs stay the medium**; don't become a BCF tool | feld72 30.10. |
| **The AI checks with sources; people interpret and decide**; no AI design | feld72 30.09/30.10, Zechner 22.10. |

What we found **no** evidence for: sketching, redlining on a tablet, site or
ÖBA markup, inviting Fachplaner or the Bauherr into the product. The Skizze line
of work (S0–S6) rests on an internal hypothesis, not on an office's request.
That does not make it wrong; it makes it the thing to validate before investing
further, and it decides which parts lead and which follow.

## The model: two intents, one canvas each

The clean line is not "document vs. canvas". It is **what the person is doing**:

- **Remarking on a plan someone else drew** (the Fassung of a Einreichplan, a
  Fachplaner's PDF, a model view). The plan is the record; you add a remark to
  it. → an **Anmerkung**. Its canvas is the plan itself.
- **Making a drawing of your own** (room bubbles for the Raumprogramm, a
  Lageskizze, a Verfahrensskizze, a drawing Piloti made for you). The drawing is
  the record. → a **Skizze**, a document. Its canvas is the Skizze editor.

One rule a person can say out loud: *drawing on a plan is a remark; drawing a
thing of your own is a Skizze.*

Consequences:

1. **A plan has one canvas: its review.** One room, one toolbar, one list of
   marks, one presence strip. Everything that happens on a page happens there.
2. **A remark can carry a drawing.** The review gets a pen: circle, arrow,
   cloud, freehand, a few words. The strokes belong to the Anmerkung (its body,
   like a Bluebeam markup), anchored to the page like its region. An Anmerkung
   is then: where (region/point/strokes) + what kind (Hinweis, Frage, Mangel) +
   who and until when + the thread. Drawing a cloud and typing „passt die
   Fluchttür?“ is one gesture, one mark, one inbox entry. No second editor.
3. **A remark that grows into an idea becomes a Skizze, explicitly.** „Als
   Skizze weiterführen“ on a mark copies its strokes into a new Skizze with the
   page as underlay (the S6 machinery: locked base, Fassung drift, access rule),
   and links the two both ways. This replaces the separate „Auf Seite zeichnen“
   button. The variant for the Bauherr meeting starts as a remark and becomes a
   Skizze when someone wants to keep working on it.
4. **A Skizze keeps its own canvas**, with Anmerkungen pinned to its elements
   (S3). That is the same Anmerkung, with an element anchor.
5. **The model view is the third surface** with the same Anmerkung (viewpoint
   anchor, BCF at the edge; [`model-collaboration.md`](model-collaboration.md)).

So: three surfaces (plan page, Skizze, model view), one remark (Anmerkung), one
drawing document (Skizze). Nothing has two homes.

## What each job gets from this

- **Decision with reason.** A mark can be closed as a **Festlegung**: the
  outcome sentence and its reason, the people present, the Fassung it was made
  on. Festlegungen of a Besprechung land in its Protokoll and in project memory,
  so „wann und warum“ is a search, not an archaeology. (New: a resolution kind
  on the existing mark lifecycle, not a new object.)
- **Issue with owner, deadline, proof.** Already the Anmerkung: Zuständige,
  Frist, inbox, status; proof = the Fassung in which it was resolved (carry-
  forward knows it). BCF 3.0 export makes it portable to BIMcollab/ArchiCAD.
- **Right Planstand, what changed.** The plan canvas shows which Fassung you are
  on and offers **Vergleichen** (old/new/overlaid, the S6 move dialog's overlay
  generalised to any two Fassungen of a plan). Marks carry forward (pins follow
  elements on a Skizze; on a PDF the existing manual carry stays, Piloti may
  propose it).
- **Answer in the meeting.** „Piloti fragen“ on a region (exists) and on a
  drawn mark: the question and the answer become the mark's thread, with
  sources. Nothing extra to file afterwards.
- **No second place.** One canvas per surface; the Skizze is reached from a
  mark, not beside it.

## Private and shared

Evidence (feld72 30.10) says people avoid the tool when they fear feeding the
project with half-baked material. So a mark is **a draft until posted**: strokes
and text are visible only to the author (and to Piloti, if asked) until „Posten“.
A posted mark is visible to everyone who can see the plan, as today. Live
cursors show presence, not drafts. A Skizze follows its folder like any
document.

## What changes against what is built

| Built (S0–S6) | Becomes |
|---|---|
| „Auf Seite zeichnen“ opens a second editor and room on the page | Removed. The review gets a pen; „Als Skizze weiterführen“ on a mark creates the traced Skizze |
| Traced Skizze has its own room on top of the PDF's | The plan's room is the only room on the page; the traced Skizze has its own room when opened as a Skizze |
| Two mark renderers (review layer, preview sheet) | One renderer, used by both |
| Region marks only on PDFs | Region, point **or drawn** marks; strokes stored with the mark |
| No way from a traced Skizze back to its plan | The underlay banner opens the plan at that page; the plan's mark links to its Skizze |
| Review presence and collaboration presence implemented twice | One presence component |

Kept unchanged: the Skizze document (Fassungen, Freigabe, live editing,
element pins, links, Piloti's edits with the person's yes, server rendering),
the underlay machinery and its access rules, the Anmerkung lifecycle.

## Slices

Each names the job it serves and what it replaces; each ships alone.

1. **One plan canvas** (no-second-place): remove „Auf Seite zeichnen“ as an
   editor entry; one mark renderer; one presence component; underlay banner ⇄
   plan links. Mostly deletion.
2. **Drawn marks** (issue, answer-in-meeting): a pen in the review (cloud,
   arrow, freehand, text), strokes stored on the Anmerkung as Excalidraw
   elements in page coordinates, drawn by the same server renderer for exports,
   BCF snapshots and the inbox thumbnail. Drafts private until posted. Piloti may
   propose a drawn mark (a cloud around the door it means).
   Technical question for the design pass: an Excalidraw instance clipped to the
   page while a mark is being drawn, static SVG for all others; measure on a 40-
   page PDF before choosing.
3. **„Als Skizze weiterführen“** (decision as an idea that keeps evolving):
   mark → traced Skizze, linked both ways.
4. **Festlegung** (decision with reason): resolve a mark as a decision; it goes
   into the Besprechung's Protokoll and project memory.
5. **Vergleichen** (right Planstand): overlay any two Fassungen of a plan page,
   with the marks of both.

## What we ask the offices before slice 2

The drawing part is a hypothesis. At the next Jour fixe (feld72, Zechner):

- In your last GP-Besprechung, how did you point at the problem in the plan:
  a screen share and a mouse, a PDF markup tool, a printout?
- When you circle something in a plan, is it a question to someone, a defect, a
  decision, or an idea? Who does it go to?
- Would you keep a drawing made in a meeting, or only what was decided?

Measure after each slice: marks per plan per week, share of drawn marks, time
from mark to resolution, „Als Skizze weiterführen“ per month, Festlegungen per
Besprechung (PostHog for the UI, Langfuse for Piloti's part).

## Open

- Calibration and measuring on a plan are announced to feld72 as „in Arbeit“
  but not in the repository; when they come, measuring belongs to the plan
  canvas, never to strokes.
- Whether Fachplaner and the Bauherr ever enter the product (guest access) is a
  separate decision; no office asked for it yet.
