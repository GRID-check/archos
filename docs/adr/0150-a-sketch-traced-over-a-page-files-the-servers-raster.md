---
status: proposed
date: 2026-10-30
decision-makers: Grid engineering
consulted: the S6 spike (r3), the AEC markup research (r2), the feld72 Jour fixe of 2026-10-30
informed: everyone working in this repo
---

# A Skizze traced over a PDF page files the server's own raster, in one slot the server writes

Amends [ADR-0148](0148-a-sketch-is-a-document.md) (a Skizze holds no image) and the
trust section of [`diagrams.md`](../architecture/diagrams.md). The slice:
[`docs/roadmap/sketches.md`](../roadmap/sketches.md), S6.

## Context and Problem Statement

An architect's day-to-day communication stays on plans and PDFs (feld72, 2026-10-30):
the markup is a cloud and an arrow on page 12 of the Einreichplan, not a fresh
drawing. Research r2 ranked tracing over a page the most useful sketch slice. So a
Skizze needs the page under its strokes: in the editor, in its filed SVG, in its PDF.

Three things stood against it. The SVG validator refuses every `<image>`, `<use>`,
`<symbol>` and `data:` reference, because a filed SVG is served back to browsers.
@react-pdf fetches any image `src` that is not data or a Buffer, which on the server is
SSRF (spike r3). And a page in a Skizze's file is visible to whoever may open the
Skizze, who may be someone the base document is kept from.

## Decision Drivers

* The validator's refusals stay true for every client-sent byte: no picture a client
  sends is ever parsed as a picture.
* The filed SVG and PDF are self-contained: the Files preview is a cross-origin `<img>`,
  downloads and an Einreichung have no session, so a reference would show a hole.
* Markup stays bound to the Fassung it was drawn on; moving it is a person's step
  (r2: Bluebeam's and PlanRadar's lesson).
* A sketch claims no dimension (ADR-0146). No measuring on an underlay: Bluebeam itself
  measures only on a calibrated page, and calibration is the PDF viewer's, not the sketch's.

## Considered Options

1. **Teach the validator an image rule**: `<image>` with a `data:image/png|jpeg` href,
   magic bytes checked, and flatten Excalidraw's `<symbol>`/`<use>` into it, or allow the
   minimal `<use href="#…">`.
2. **A reference in the stored SVG** (`doc:<id>#v=…&p=…`), resolved when shown.
3. **The server writes the page into one fixed slot after the validator**, and every
   reader lifts exactly that slot out before validating the rest.

## Decision Outcome

Chosen option 3.

* **The scene holds a reference.** One locked `image` element per Skizze, at the bottom
  of the z-order, `customData.underlay = { documentId, versionId, page, dpi }`, `fileId`
  derived from the tuple, no `files` (`bff/diagrams/sketch-underlay.ts`). The stored scene,
  the live wire and Piloti's edit admit it through that one file; any other image, an
  unlocked, cropped, turned or flipped one, or a second one is refused. The fence a model
  writes has no `image` type, so Piloti cannot start an underlay in this slice; a person
  starts one from a PDF page („Auf Seite zeichnen“), an outside agent through
  `document-sketch-from-page`.
* **The raster is the server's.** `GET …/versions/{v}/pages/{n}/raster` draws the page in
  the backend (pypdfium, a 16-colour palette PNG, long side ≤ 4096 px), cached per
  (Fassung, page, dpi) beside the Fassung and swept with it; access is reading that
  document (restricted folders, the hold, the download log). The editor loads it with
  `addFiles`.
* **The slot.** The worker draws the underlay over a one-pixel stand-in so Excalidraw
  places it, then takes the stand-in out; the vector picture passes the validator
  unchanged; the save writes `<image data-underlay="" x y width height
  preserveAspectRatio="none" href="data:image/png;base64,…"/>` as the root's first child
  (`sketch-underlay-svg.ts`). Readers (Freigabe's PDF redraw) lift that exact form out
  first. An `<image>` anywhere else is still `unsupported-element`. The PDF gets the PNG
  as a Buffer through `<Image src>`, never a URL.
* **Its own budget.** The vector picture keeps `MAX_DIAGRAM_SVG_BYTES` (1 MiB); the slot
  adds at most 4 MiB of PNG. Measured on an A3 sheet at 150 dpi: a 328 KB PNG, a 475 KB
  filed SVG for a 41-element sketch, a 346 KB PDF drawn in 141 ms; the render itself
  12 ms.

Option 1 rejected because its trust surface is the validator's: every rule it learns is a
spelling a client may try, and the PNG would still be the client's unless the server
compared it to its own, at which point the server may as well write it. Option 2 rejected
because the files leave the product (the Files preview is cross-origin, an Einreichung has
no session) and react-pdf would need a resolver before it, one more place a URL can reach
a fetch.

### Consequences

* Good, because no validator rule changed: client bytes are refused exactly as before.
* Good, because the filed SVG and PDF show the page anywhere, without a session.
* Good, because the page is bound to its Fassung: „liegt auf Fassung 3, aktuell 4“ and an
  explicit „Auf neue Fassung übertragen“, matched by page label, else by number, saved as
  the Skizze's next Fassung; pins and links stay on their elements.
* **The access rule: refuse, never file blank.** A Skizze never shows its underlay to a
  reader who cannot open the base. Live, the raster route reads with the reader's rights:
  a reader without the base sees the strokes on a blank sheet. Filed, the Skizze lies in
  the base's project, and when the base's folder is one some member may not read, in that
  same folder; a save or a move that would break it is refused by name (`underlay_wider`,
  `underlay_other_project`, `underlay_unavailable`). We refuse rather than file without
  the page, because a Skizze drawn on a page means that page: a blank filed picture
  would say something else. A Skizze started on a restricted page is filed without the
  page and moved beside it; its first save there files the page.
* Bad, because a base document moved into a narrower folder after a Skizze was filed
  leaves the earlier Fassungen' pictures where they were; the next save is refused until
  the Skizze follows. Nothing finds the Skizzen drawn on a document yet (open).
* Bad, because a Skizze a person starts on a page is filed through the generated-document
  seam and carries its machine marking (`AIGenerated=true`), though no model drew it. A
  person-authored sketch producer is open.
* Neutral, because the edit receipt (S4) draws the change without the page.
* The doctrine holds: every export says „nicht maßstäblich“; there is no measuring tool on
  an underlay. If the base page is calibrated in the PDF viewer, the link to offer is
  „measure on the base document“, never on the sketch (open).

### Confirmation

`bff/diagrams/sketch-underlay.spec.ts` refuses a crafted scene with an external image, an
SVG image or a non-underlay image at every door (stored scene, live wire, fence, edit, SVG
validator, slot reader); `sketch-underlay-render.spec.ts` files a page through the real
worker and PDF renderer; `sketch-underlay-access.spec.ts` holds the access rule;
`documents/page-raster.spec.ts` the raster's access, cache and checks.

## More Information

Revisit if the PDF viewer's calibration lands (offer „measure on the base document“), when
a BIM view becomes an underlay (its PNG is a capture, stored once, with the BCF viewpoint:
`model-collaboration.md` F5), or if a second image kind ever needs the validator.
