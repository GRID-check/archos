# Working on a Fassung together: what the office is trying to get done

> Status: design, 2026-10-30, revised after a critical review the same day.
> Evidence: the seven pilot protocols and the office profiles in Notion, read
> 2026-10-30 (feld72 ×4, BWM, GernerGernerPlus, Zechner&Zechner). Applies
> [VISION.md](../../VISION.md) principle 8. Reorders the remaining sketch work
> in [`sketches.md`](sketches.md) and sits beside
> [`model-collaboration.md`](model-collaboration.md).

## Why this document exists

By 2026-10-30 one page of a PDF had two shared canvases: the review (Anmerkungen,
threads, live cursors, „Piloti fragen“ on a region) and a Skizze traced over the
page (its own editor, its own room, its own pins). Each slice was right alone;
together they are two ways to do one thing. Before merging them we asked what
the office is trying to get done, because a tidier canvas built for its own sake
would repeat the mistake.

## What the offices are trying to achieve (evidence)

| The job | Evidence |
|---|---|
| **A decision, with its reason, findable years later** | feld72 30.09: „Wann und warum wurde X entschieden?“ across minutes, mail and drawings, for claims. feld72 23.10: Festlegungen re-keyed into ArchiCAD by hand. GernerGernerPlus 19.10: the reasons between phase states are the valuable part; phone calls get lost. |
| **An issue closed with owner, deadline and proof** | Zechner 22.10: weekly GP-Besprechung, half the Fachplaner on Teams, issues „mit Zuständigkeit, Frist und Erledigungsnachweis“ in BIMcollab. feld72 30.10: BCF, 280 coordination issues with the IFC. |
| **The right Planstand, and what changed** | feld72 09.10/23.10: only the newest Planstand counts, Index and date from the Plankopf, „nur als Vorschlag mit manueller Bestätigung“. GernerGernerPlus 19.10: area losses found „rückwirkend“ are „politisch, vertraglich und juristisch heikel“. |
| **The answer during the meeting** | feld72 30.10: „in einer Besprechung in drei Minuten die richtige Normstelle in fünf Dokumenten finden statt danach“. |
| **No second place, no extra clicks** | BWM 13.10: „zwei Klicks zu viel“. GernerGernerPlus: no double entry. feld72 30.10: divergent input fields undermine trust. |
| **PDFs stay the medium; not a BCF tool** | feld72 30.10. |
| **The AI checks with sources, people decide; no AI design** | feld72 30.09/30.10, Zechner 22.10. |

**No evidence** for: sketching, redlining, tablet markup, site or ÖBA markup,
inviting Fachplaner or the Bauherr into the product. The Skizze work (S0–S6)
rests on an internal hypothesis. It stays, but it follows; it does not lead.

## The unit is the Besprechung, not the canvas

Every strong job above happens in, or because of, a meeting about a Fassung:
the GP-Besprechung, the Jour fixe, the internal review. CONTEXT.md already says
so: an Anmerkung's number is „what a Jour fixe and a Protokoll name“. So the
design starts from the meeting:

- **Before:** the open Anmerkungen across the project's Fassungen are the
  agenda (Offene Punkte), each with its number, Zuständige and Frist.
- **During:** the team looks at a Fassung together (one canvas, live), points,
  marks, asks Piloti about a region and gets the Normstelle with its source in
  the meeting, and agrees.
- **After:** Piloti drafts the **Protokoll**: what was decided and why, which
  marks were closed by it, who does what by when. A person releases it
  (Freigabe), as with every document Piloti writes. The decision lives in the
  Protokoll; the marks it settled close as *erledigt* with a link to it
  („erledigt laut Protokoll 7, Punkt 3“). One decision can settle three marks, a
  phone call and an e-mail: a decision is not a property of one mark.
- **Later:** „wann und warum“ is a search over released Protokolle and their
  linked marks; BCF carries decisions back to ArchiCAD/BIMcollab.

## One canvas per surface, decided by lifecycle

The rule, by what happens to the thing, not by who drew the base:

- **A mark asks or tells someone something, and gets closed.** That is an
  Anmerkung, on whatever surface it sits: a region of a Fassung's page, an
  element of a Skizze, a viewpoint of a model. Kinds as the code names them.
- **A Skizze is kept and revised.** A drawing of the office's own (room
  bubbles, Lageskizze, a variant someone wants to keep working on, a drawing
  Piloti made): a document with Fassungen and Freigabe.

Consequences:

1. **A page has one canvas: its review.** One room, one toolbar, one list of
   marks, one presence component, one mark renderer. The traced Skizze no
   longer opens a second editor and room on top of the same page.
2. **A traced Skizze is still possible**, but it is a Skizze (kept, revised),
   reached from the review („Skizze auf dieser Seite beginnen“ in the review's
   menu, not a button beside it), and it links back to its page. Its underlay
   machinery (locked base, Fassung drift, access rule) is unchanged.
3. **Drawing inside a mark** (a cloud or an arrow as the mark's shape) is a
   possible later step, only if the offices say they point at problems that way
   (questions below). If it comes, start with cloud and arrow as mark shapes,
   not freehand Excalidraw on the page.
4. No private drafts on the canvas: in a live meeting a mark nobody sees is
   useless, and a mark is already a draft until it is set. The evidence about
   „feeding the project“ was about chat and memory; the rule that follows from
   it here is narrower: Piloti does not learn from a mark that was *verworfen*.

The model view is the third surface with the same Anmerkung (viewpoint anchor,
BCF at the edge; [`model-collaboration.md`](model-collaboration.md)).

## What already exists and only needs joining

- **„Fassungen vergleichen“** (`revision-compare/`: Nebeneinander, Überlagert,
  Wischen; `POST /api/documents/{id}/revision-compare` has Piloti mark the
  changes, [`file-upload-and-explorer.md`](../ux/file-upload-and-explorer.md)).
  Missing: reaching it from the review, and the marks of both Fassungen in it.
- **The Protokoll** as a document Piloti drafts and a person releases (VISION:
  „Piloti drafts Aktenvermerke, Protokolle“), and the project-level Protokoll
  export. Missing: the link between a Protokoll's items and the marks they
  settle.
- **„Piloti fragen“ on a region** in the review. Missing: a measured answer
  time and search across the project's documents and norms from that region.
- **Carry-forward** of open marks to a new Fassung.

## Slices, in the order the evidence supports

1. **One canvas** (no second place). Remove „Auf Seite zeichnen“ as a separate
   editor entry and room on the page; one mark renderer; one presence
   component; the traced Skizze reached from the review and linking back.
   Mostly deletion. Measure: nothing to measure but fewer code paths.
   *Built 2026-10-31:* the PDF toolbar's „Auf Seite zeichnen“ and its second
   editor mount are gone; „Skizze auf dieser Seite beginnen“ is in the review's
   page menu and opens the Skizze as its own document with its review (pins
   from the first open); its banner's „Zur Seite N der Fassung“ opens the
   base's review at that page; the preview draws a PDF page's and a Skizze's
   marks by one path; `Presence` is one component on the kit's `AvatarStack`.
   Open: „Skizzen auf dieser Seite“ in the base's review needs a read of a
   base's Skizzen by page, which `sketch_underlay_bases` cannot answer (no
   page); and the Skizze still has its own room, rightly, as its own document.
2. **The Besprechung** (decision with reason; owner, deadline, proof). Offene
   Punkte across documents as an agenda; after the meeting Piloti drafts the
   Protokoll from the marks touched, the threads and what was said in the
   review room; a person edits and releases; marks settled by it close with the
   link. Add *Besprechung* and *Festlegung* (a Protokoll item that decides) to
   CONTEXT.md in that change. Measure: share of closed marks that point to a
   Protokoll; time from mark to *erledigt*; „wann und warum“ found by search.
3. **Planstand** (the right Fassung, what changed). Index and date read from
   the Plankopf as a suggestion a person confirms; „neuer Stand liegt vor“ in
   the review when a newer Fassung exists; „Vergleichen“ from the review into
   the existing dialog, with both Fassungen' marks. Measure: marks set on a
   superseded Fassung (should fall).
4. **BCF 3.0 round trip** (issues to and from BIMcollab/ArchiCAD; decisions
   back to the model). F3/F6 in [`model-collaboration.md`](model-collaboration.md).
5. **Drawn marks**, only if the questions below come back yes: cloud and arrow
   as mark shapes.

The 3-minute answer runs across all of these: give „Piloti fragen“ on a region
an answer-time target (p50 under 20 s, p90 under 60 s, measured in Langfuse)
and project-wide search with citations.

## The boundary: people outside the office

Fachplaner, Bauherr and Behörde do not have accounts and no office asked for
that. They reach the project through what leaves it: the released Protokoll,
BCF files, PDFs with the Anmerkungen printed, e-mail. Guest access is a separate
decision, not part of this design.

## What we ask the offices before slice 5

At the next Jour fixe (feld72, Zechner):

- In your last GP-Besprechung, how did you point at a problem in a drawing:
  screen share and a mouse, a PDF markup tool, a printout?
- When you circle something, is it a question to someone, a defect, a decision
  or an idea? Who does it go to?
- Who writes the Protokoll today, how long does it take, and where do you look
  for a decision a year later?

## What this means for the Skizze work

Built and kept: the Skizze as a document (Fassungen, Freigabe, live editing,
element pins, links, Piloti's edits with the person's yes, server rendering),
the underlay machinery. Changed: the traced Skizze's entry point (slice 1).
Paused until evidence: further Skizze features. The Skizze earns its place where
Piloti draws something an office keeps (a Raumprogramm, a Verfahren) and as the
surface for an idea that outlives one meeting; measure that before building more.

## Open

- Calibration and measuring on a page were announced to feld72 as „in Arbeit“
  but do not exist in the repository; when they come, they belong to the review
  canvas, never to strokes.
