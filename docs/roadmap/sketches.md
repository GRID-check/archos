# Sketches: a Skizze is a document

Status: proposed, 2026-10-29. Decision: [ADR-0148](../adr/0148-a-sketch-is-a-document.md).
How diagrams and sketches work today: [`docs/architecture/diagrams.md`](../architecture/diagrams.md),
[ADR-0141](../adr/0141-a-person-reworks-piloti-drawing-as-an-excalidraw-sketch.md),
[ADR-0146](../adr/0146-piloti-draws-sketches-in-excalidraws-own-format.md).

Piloti is the workspace a planning office runs its projects in. A Skizze is how an
architect thinks on paper before there is a drawing: rooms as bubbles, a site with
its access, the idea of a section. This doc is the scene we aim at and the slices
that get there. It applies [VISION.md principle 8](../../VISION.md#principles): a
sketch earns its place by making the features it touches better, not by bringing
its own.

## What is wrong today

Sketches are an island. Piloti writes an `excalidraw` fence, the chat draws it, a
person may edit it once in a modal and file it. Everything after that is a dead end:

- **A filed sketch cannot be reopened.** `DIAGRAM_RENDERERS.excalidraw` is `null`
  (`apps/workspace/ui/features/diagrams/render-diagram.ts`), and the dialog turns
  read-only once filed (`sketch-dialog.tsx`, `readOnly={filed}`).
- **It has no Fassungen.** Filing writes a new pair of `documents` rows (SVG and PDF)
  keyed by a hash of the scene (`diagramRunId`), with no `document_versions` row. A
  second edit is a second, unrelated document.
- **Nothing reads it back.** The scene is stored inside the SVG's `<metadata>`
  (`withDiagramSource` in `apps/workspace/bff/diagrams/svg.ts`), and
  `diagramSourceOf` can read it, but its only callers are tests. Piloti, search and
  an outside agent see an image. No ingestion path handles `image/svg+xml`.
- **No Anmerkungen, no room.** The document room (`doc:<id>`: presence, cursors,
  Piloti in the roster) and `document_annotations` exist for every document. The
  sketch editor joins neither.
- **Its elements point at nothing.** The fence allow-list drops `link` and
  `customData` (`bff/diagrams/sketch-fence.ts`, `common/sketch_fence.py`), so a
  bubble cannot name a Raum in the model, a page or an Aufgabe.
- **A leak.** `aiEnabled` is not set on the canvas, and Excalidraw 0.18.1 defaults it
  to true. Its "Text to diagram" and "Mermaid to Excalidraw" commands call
  `oss-ai.excalidraw.com`, which ADR-0074 and ADR-0141 ("no traffic leaves the
  origin") rule out. Found in the bundle, not exercised in a browser.

Documents, collaboration, review, tasks, BIM and the agent door do not know a sketch
exists. Every one of them would have to grow a second copy of itself to learn.

## The move: a sketch is a document

A Skizze is a project document whose bytes are an SVG with its Excalidraw scene
embedded in its `<metadata>`: the `.excalidraw.svg` convention excalidraw.com's
"embed scene" export uses, and already what `fileDiagramDocuments` writes (our
encoding inside `<metadata>` differs from Excalidraw's, so excalidraw.com does not
open our file as a scene yet). The picture is what Files, the PDF export and an
Einreichung show; the scene is what the editor reopens.

Being a document, a Skizze inherits what documents already have: the Files pane,
folders and restricted folders, sharing, Fassungen, Freigabe and revise from
comment, Anmerkungen, the live document room, the inbox, mentions, Zuständige,
the download log, and the agent door. Each of those gets a canvas; none needs a
second copy. ADR-0148 records why this beats a `sketch` resource type of its own.

## The scene

1. Piloti sketches a Raumprogramm in the chat. „Im Projekt ablegen“ puts a Skizze in
   Files.
2. Anna opens it from Files and gets the full canvas. Max has the same document
   open: his cursor and selection show live, and edits merge element by element.
   Piloti's avatar is in the participant strip.
3. Anna selects two bubbles and sets an Anmerkung on them, @Max, Frist Friday. It is
   the same Anmerkung as on a PDF: inbox, Zuständige, erledigt.
4. Anna selects the bubbles: „Piloti, ordne die nach Erschließung“. Piloti proposes
   the change as an overlay. Anna accepts, and a new Fassung names both authors.
5. Elements link into the workspace: a bubble to a Raum in the IFC model (opens the
   3D view at that element), an arrow to a document page, a marker to an Aufgabe
   whose status colours it.
6. She sketches over anything: a PDF page of an Einreichplan, a BIM section, a
   schematic card becomes a locked base, and the markup is a Skizze that names the
   Fassung it sits on.
7. Search finds „Lift“ inside a sketch. Piloti answers „was haben wir im
   Raumprogramm festgelegt?“ from the scene's structure. Claude or Cursor read it
   and propose edits through the MCP door.
8. Freigabe releases it, and its PDF goes into the Einreichung marked
   „nicht maßstäblich“. A released Skizze is office knowledge, and the office keeps
   a library of its own symbols.

A sketch claims no dimension at every step (ADR-0146). A number that enters a sketch
comes from a measurement with its provenance, never from the hand or the model.

## Slices

Each slice ships alone and names the part of the scene it serves and the existing
features it makes better.

| # | Slice | Serves | Makes better | Measured by |
|---|---|---|---|---|
| S0 | **Close the leak.** `aiEnabled={false}`, the text-to-diagram and mermaid commands gone from the palette, a test that holds it | trust | the editor ADR-0141 shipped | a spec on the canvas props; no request to `oss-ai.excalidraw.com` in a browser run |
| S1 | **Reopen and save as a Fassung.** A filed Skizze opens in the editor from Files; save writes a new Fassung of the same document and its PDF. Headless first: `GET /api/documents/{id}/sketch` (scene plus a structured read: texts, shapes, connections, frames) and `PUT` (new Fassung from scene and SVG), each a catalog operation with its exposure | 2, 7, 8 | Files, Fassungen and their timeline, Freigabe, the agent door | share of filed sketches reopened; `diagram-filed: edited` per document, not per pair |
| S2 | **Live room.** The editor joins `doc:<id>`; Excalidraw's collaborators come from the existing presence (cursor, selection, name, colour); element deltas go over the room and merge with `reconcileElements`. The Fassung stays the truth | 2 | the document room, the participant strip, Piloti's presence | two-tab convergence test; edits lost on a dropped message (expected 0 after save) |
| S3 | **Anmerkungen on elements.** Reuse `document_annotations`: page 1, the region is the element's bounds normalised to the scene, the element id carried; pins drawn over the canvas; threads, mentions and inbox unchanged | 3 | Anmerkungen, the inbox, Zuständige and Frist reminders | Anmerkungen per Skizze; a pin still on its element after a move. Built: migration 0192, a save carries the marks on in its transaction ([„A mark on a Skizze“](../architecture/document-annotations.md#a-mark-on-a-skizze)) |
| S4 | **Piloti reads and proposes.** Piloti reads a Skizze through the S1 read; an edit is a proposed change the person applies, which writes a Fassung | 4, 7 | proposed changes, Piloti's answers about the project | proposals accepted against dismissed; answer-suite cases on a sketch |
| S5 | **Links into the workspace.** `customData` with `documentId`, `page`, `ifcGlobalId`, `taskId` kept through the fence, the editor and the file; `onLinkOpen` routes inside the app | 5 | the BIM viewer's model links, the document viewer, Aufgaben | links opened per week; links still resolving after a model revision |
| S6 | **Underlays.** A PDF page or a BIM view as a locked image base, which needs `<image>` in the SVG validator with a same-origin document href only | 6 | the PDF viewer, the BIM viewer, schematic cards, the Einreichung | sketches with a base; validator refuses every other href |

Search over the scene's texts (scene step 7) and the office's symbol library (step 8)
have no slice yet. Both wait for S1's structured read.

## Open questions

- **Fassung model.** ADR-0104's `current_version_id` has not landed, and
  `replaceVersionContent` takes Markdown only. S1 either adds a binary content path
  beside it or writes Fassungen through the upload path. Decide in S1, against
  ADR-0104.
- **Who renders.** The server cannot render a scene to SVG; only the browser can.
  An outside agent's `PUT` therefore sends both, and the server cannot check they
  match. Is that acceptable, or does S4 need a headless renderer?
- **Freigabe for a generated file.** Filed sketches are `stored` and authored by the
  agent. Does a person's edit make the next Fassung theirs, and does a Skizze go
  through Freigabe before it can join an Einreichung?
- **The room under load.** The realtime hub is lossy by design and sheds motion on
  429. S2 keeps the Fassung as the truth and treats deltas as hints (ADR-0110,
  amendment of 2026-10-29), with saves explicit, one Fassung each. Whether an
  autosave into an open draft Fassung is worth it (S2b) waits for how often people
  lose work by closing unsaved.
- **Image paste.** With `tools.image` off, a pasted image may still create an
  `<image>` that the validator refuses with a 400. Check before S1 ships.
