---
status: proposed
date: 2026-10-29
decision-makers: Grid engineering; the product owner set the direction on 2026-10-29
consulted: product owner
informed: everyone working in this repo
---

# A sketch is a document: an SVG that carries its Excalidraw scene

Builds on [ADR-0141](0141-a-person-reworks-piloti-drawing-as-an-excalidraw-sketch.md)
and [ADR-0146](0146-piloti-draws-sketches-in-excalidraws-own-format.md). The scene
and the slices: [`docs/roadmap/sketches.md`](../roadmap/sketches.md).

## Context and Problem Statement

Piloti draws a Skizze in the chat (ADR-0146) and a person can rework it once in
Excalidraw and file it (ADR-0141). Filing writes a new SVG and PDF pair, keyed by a
hash of the scene, with no `document_versions` row. After that the sketch is a dead
picture: it cannot be reopened (`DIAGRAM_RENDERERS.excalidraw` is `null`), it has no
Fassungen, no Anmerkungen and no live room, nothing reads its scene back
(`diagramSourceOf` has no production caller), and its elements cannot point at a
document, a model element or an Aufgabe. ADR-0141 named reopening as the next slice.

Before building it, the question is what a sketch *is* in the workspace. The answer
decides whether the features around it (Files, Fassungen, Freigabe, Anmerkungen, the
document room, sharing, the inbox, the agent door) work on a sketch as they are, or
each grow a sketch-shaped copy.

## Decision Drivers

* VISION.md principle 8: a feature draws on what the office already holds and makes
  the features it touches better. A sketch with its own list, store or comments is a
  second product.
* The Files preview, the PDF companion and an Einreichung need a picture of the
  sketch, and only the browser can render an Excalidraw scene (`svg.ts`: Excalidraw
  needs a DOM to lay out).
* The editor needs the scene, losslessly, to reopen what it saved.
* Industry standard first: excalidraw.com's own "embed scene" export is an SVG with
  the scene inside its `<metadata>`, which Excalidraw reads back (`loadFromBlob`).
* Correlated substrate debt is paid where it is tripped over (AGENTS.md), so an
  option that needs the shareable-resource register's leaks fixed carries that cost.

## Considered Options

1. **A new `sketch` shareable resource type**, with its own table, visibility,
   comments and channel.
2. **A document whose bytes are the scene only**, an `.excalidraw` JSON file
   (`application/vnd.excalidraw+json`).
3. **A document whose bytes are an SVG carrying its scene**, the `.excalidraw.svg`
   convention, as `fileDiagramDocuments` already writes.

## Decision Outcome

Chosen option 3, because it is the one option where every existing document feature
works on a sketch unchanged, and it is the format filing already writes.

A Skizze is a project document. Its bytes are an SVG; its Excalidraw scene sits in
the SVG's `<metadata>` (`withDiagramSource`, read by `diagramSourceOf`). It is
reopened and edited in place, and each save is a new Fassung of the same document,
with its PDF companion following. Being a document, it inherits:

* the Files pane, folders and restricted folders (ADR-0087), and sharing;
* Fassungen and their timeline, and Freigabe (ADR-0104). Revise from comment is the
  one exception: it writes Markdown, so a Skizze is revised in its editor
  (amendment below);
* Anmerkungen (`document_annotations`, page 1, a region normalised to the scene);
* the live document room `doc:<id>`: presence, cursors, Piloti in the roster
  (ADR-0110);
* the inbox, mentions, Zuständige and the download log;
* the agent door, through document operations plus a sketch read and write
  (`GET` and `PUT /api/documents/{id}/sketch`), as catalog operations (ADR-0122).

The sketch marking (`markingSketch`, „nicht maßstäblich“) stays in every Fassung's
bytes. A sketch still claims no dimension (ADR-0146).

### Consequences

* Good, because Files, Fassungen, Freigabe, Anmerkungen, the room and the agent door
  each gain a canvas without a second copy of themselves.
* Good, because the file is useful outside Piloti: any browser shows it.
* Neutral, because excalidraw.com does not open it as a scene yet. Our `<metadata>`
  holds plain scene JSON under an attribute of ours, where Excalidraw's export wraps
  a base64 payload in its own markers. Writing Excalidraw's encoding as well would
  close that; it is not part of this decision.
* Good, because nothing new is stored: filed sketches already have this shape, so
  reopening works on every sketch filed since ADR-0141.
* Bad, because the picture and the scene can disagree. The server cannot render the
  scene, so it cannot check that a caller's SVG matches it. The editor writes both
  together; an outside agent's write is a proposed change a person sees before it
  lands.
* Bad, because a Fassung of a sketch needs a binary content path:
  `replaceVersionContent` takes Markdown only, and ADR-0104's `current_version_id`
  has not landed.
* Bad, because an Anmerkung anchored to an element is a page-1 region on the
  scene's bounds. When the element moves, the pin must follow its id, which
  `document_annotations` does not carry today.
* Neutral, because the scene's 512 KiB cap (`DIAGRAM_SOURCE_FACTS.excalidraw`) and
  the SVG validator's allow-list now bound a document type, not only a filing.

#### Amendment, 2026-10-29: sketches and the collaboration tools are one product

An audit of the sketch against every collaboration feature found it publishing
around them. Decided, and built:

* **One path makes a Fassung current.** Upload, Freigabe and the sketch save all
  carry the pinned marks in the publishing transaction and tell the room after it
  (`docs/architecture/revisions.md`, „One path makes a Fassung current“). A
  Freigabe that published an older draft over later saves had stranded the pins.
* **A save respects an open round.** With a draft open, the editor edits the draft
  and a save writes into it; with a version in review, a save is refused
  (`review_open`) and the canvas stays live. A save over a Fassung released through
  Freigabe sends the revision notice; work in progress stays silent.
* **The PDF is the rendition.** It moves with the Skizze, is drawn only for the
  current Fassung, never into a folder wider than the Skizze's, and takes no marks
  of its own.
* **Text paths ask first.** Revise from comment, the revision task and the text
  compare refuse a Skizze (415 `not_revisable_as_text`); the compare reads its
  outline instead. This corrects the „revise from comment“ promised above.
* **One room per tab.** The editor joins through the preview's room; Piloti's
  snapshot lists a person once.

The open remainder is in `docs/roadmap/sketches.md`, „Coherence: what is still
open“.

### Confirmation

Nothing enforces this yet; review is the only gate. The first slice (reopen and
save as a Fassung) adds the gate: a route spec that a `PUT` writes a new
`document_versions` row of the same document and never a new `documents` row.

## Pros and Cons of the Options

### 1. A new `sketch` shareable resource type

* Good, because a sketch could have its own fields (an element-anchored comment, a
  scene column) without bending documents.
* Bad, because the shareable-resource register
  ([`adding-a-shareable-resource-type.md`](../architecture/adding-a-shareable-resource-type.md),
  §4) prices a second project-contained type at 3–5 days of per-type work plus about
  9 days of forced refactoring of the substrate's leaks (§3: visibility, mentions
  typed to conversations, titles, cleanup, live events). That holds while §3 is
  unfixed.
* Bad, because it duplicates what documents already are: a list, versions,
  approval, comments, a room. Each would be built again or bridged, which is the
  second product principle 8 rules out.

### 2. A scene-only `.excalidraw` JSON document

* Good, because the scene is the whole truth and there is nothing to keep in step.
* Bad, because the Files preview, the PDF export and an Einreichung need a picture,
  and the server cannot render one: Excalidraw lays out only with a DOM, and the BFF
  has no headless browser. That premise turns false if we add server-side rendering;
  revisit then.
* Bad, because a JSON file is unreadable to anyone who downloads it without
  Excalidraw.

### 3. An SVG carrying its scene

* Good, because the picture and the scene travel together in one file a browser
  shows and our editor reopens.
* Good, because filing already writes it, and the SVG validator already guards it.
* Bad, because the two halves can drift (see Consequences).

## More Information

Revisit if the server gains a renderer for Excalidraw scenes (option 2 becomes
cheap), or if the shareable-resource register's §3 leaks are fixed for another
reason and a sketch needs something documents cannot hold.
